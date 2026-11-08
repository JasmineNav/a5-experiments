import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createServer as createHttpServer } from 'node:http';
import { createServer as createNetServer, connect } from 'node:net';
import { mkdtemp, mkdir, writeFile, readFile, rm, stat, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { test } from 'node:test';
import { discoverExperiments, getStatus, startExperiment, stopExperiment, readLogs, adminUrl, repositoryRoot } from '../experiment-manager.mjs';
import { localDeviceControl, runDeviceControl } from '../local-device-launch.mjs';

const execute = promisify(execFile);
test('首次无配置也进入真机 Web 整备；缺脚本或启动失败不能回退 Mock', async () => {
  const root = await mkdtemp(join(tmpdir(), 'a5 真机入口 '));
  try {
    const item = { name: 'f5-sh-pilot' }, options = { root, platform: 'win32' };
    await assert.rejects(localDeviceControl(item, options), /未启动 Mock/);
    await mkdir(join(root, '.a5-local'));
    await writeFile(join(root, '.a5-local/device.json'), '{}');
    await assert.rejects(localDeviceControl(item, options), /未启动 Mock/);
    await mkdir(join(root, 'scripts'));
    const entry = join(root, 'scripts/glasses-control.mjs');
    await writeFile(entry, `import {writeFile} from 'node:fs/promises'; await writeFile(new URL('../.a5-local/args.json',import.meta.url),JSON.stringify(process.argv.slice(2)));`);
    assert.equal(await localDeviceControl(item, options), entry);
    assert.equal(await localDeviceControl({ name: 'f5-sl-pilot' }, options), entry, 'SL与SH共用同一副眼镜的设备启动链路');
    assert.equal(await localDeviceControl({ name: 'f5-mh-other' }, options), null);
    await runDeviceControl(entry, 'start', 5188);
    assert.deepEqual(JSON.parse(await readFile(join(root, '.a5-local/args.json'), 'utf8')), ['start', '--no-open', '--port', '5188']);
    await runDeviceControl(entry, 'status', undefined, 'f5-sl-pilot');
    assert.deepEqual(JSON.parse(await readFile(join(root, '.a5-local/args.json'), 'utf8')), ['status', '--no-open', '--experiment', 'f5-sl-pilot']);
    await writeFile(entry, 'process.exit(5);');
    await assert.rejects(runDeviceControl(entry, 'start'), /不会回退为 Mock/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
async function freePort() {
  const server = createNetServer(); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port; await new Promise(resolve => server.close(resolve)); return port;
}
async function fixture(entry = undefined, name = 'f5-sh-pilot') {
  const root = await mkdtemp(join(tmpdir(), 'a5 启动器测试 ')); const path = join(root, name), port = await freePort();
  await mkdir(join(path, 'runtime'), { recursive: true }); await writeFile(join(path, 'runtime/admin-key'), 'local-test-only');
  await writeFile(join(path, 'package.json'), JSON.stringify({ name, type: 'module', scripts: { start: 'node server.mjs' }, a5: { launcher: { entry: 'server.mjs', port, health_path: '/api/health', admin_path: '/admin', admin_key_file: 'runtime/admin-key' } } }));
  await writeFile(join(path, 'server.mjs'), entry ?? `
import {createServer} from 'node:http';
import {writeFile} from 'node:fs/promises';
import {join} from 'node:path';
let closing=false;
const server=createServer((request,response)=>{response.setHeader('Content-Type','application/json');response.end(JSON.stringify({ok:true,experiment_id:'${name}'}));});
const shutdown=()=>{if(closing)return;closing=true;server.close(async()=>{await writeFile(join(process.env.A5_RUNTIME_DIR,'closed'),'正常关闭');if(process.connected)process.disconnect();});};
process.on('message',m=>{if(m?.type==='a5:shutdown')shutdown();});
process.on('disconnect',shutdown);process.on('SIGTERM',shutdown);
server.listen(Number(process.env.PORT),'127.0.0.1',()=>console.log('测试服务已就绪，中文与空格路径有效'));
`);
  // stop 回执到达后，管理进程仍可能正在退出；Windows 会短暂锁住其工作目录。
  return { root, name, path, port, close: async () => { await stopExperiment(name, root).catch(() => {}); await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }); } };
}

test('动态发现实验，未配置的实验保留提示，无关目录忽略', async () => {
  const f = await fixture();
  try {
    await mkdir(join(f.root, 'f5-ml-pilot')); await mkdir(join(f.root, 'unrelated'));
    const entries = await discoverExperiments(f.root);
    assert.deepEqual(entries.map(e => e.name), ['f5-ml-pilot', 'f5-sh-pilot']);
    assert.ok(entries[0].problem); assert.equal(entries[1].launcher.port, f.port);
  } finally { await f.close(); }
});

test('后台启动、重复启动、跨启动器状态、日志、后台入口和正常停止', async () => {
  const f = await fixture();
  try {
    assert.equal((await getStatus(f.name, f.root)).status, 'stopped');
    const started = await startExperiment(f.name, undefined, f.root); assert.equal(started.status, 'running');
    assert.equal((await startExperiment(f.name, undefined, f.root)).server_pid, started.server_pid);
    const script = `import {getStatus} from ${JSON.stringify(pathToFileURL(join(repositoryRoot, 'scripts/experiment-manager.mjs')).href)}; console.log(JSON.stringify(await getStatus('f5-sh-pilot',process.argv[1])));`;
    const second = await execute(process.execPath, ['--input-type=module', '-e', script, f.root]);
    assert.equal(JSON.parse(second.stdout).server_pid, started.server_pid);
    assert.ok((await readLogs(f.name, f.root)).includes('中文与空格路径有效'));
    assert.equal(await adminUrl(f.name, f.root), `http://127.0.0.1:${f.port}/admin#key=local-test-only`);
    const state = JSON.parse(await readFile(join(f.root, '.launcher', f.name, 'state.json'), 'utf8'));
    const denied = await new Promise((resolveReply, reject) => {
      const socket = connect(state.control_port, '127.0.0.1'); let data = '';
      socket.on('connect', () => socket.write(JSON.stringify({ token: 'wrong', action: 'stop' }) + '\n'));
      socket.on('data', chunk => { data += chunk; }); socket.on('error', reject); socket.on('end', () => resolveReply(JSON.parse(data)));
    });
    assert.ok(denied.error.includes('凭据无效')); assert.equal((await getStatus(f.name, f.root)).status, 'running');
    assert.equal((await stopExperiment(f.name, f.root)).status, 'stopped');
    assert.equal(await readFile(join(f.path, 'runtime/closed'), 'utf8'), '正常关闭');
    assert.equal((await getStatus(f.name, f.root)).status, 'stopped');
    assert.equal((await stopExperiment(f.name, f.root)).status, 'stopped');
    assert.equal((await startExperiment(f.name, undefined, f.root)).status, 'running');
  } finally { await f.close(); }
});

test('端口冲突不结束其他服务，启动失败保留日志', async () => {
  const f = await fixture(); const server = createHttpServer((_request, response) => response.end('{}'));
  await new Promise(resolve => server.listen(f.port, '127.0.0.1', resolve));
  try {
    await assert.rejects(startExperiment(f.name, undefined, f.root), /端口.*已被占用/);
    assert.equal(server.listening, true);
    await new Promise(resolve => server.close(resolve));
    await writeFile(join(f.path, 'server.mjs'), "console.error('模拟启动失败');process.exit(42);");
    await assert.rejects(startExperiment(f.name, undefined, f.root), /启动失败/);
    assert.equal((await getStatus(f.name, f.root)).status, 'failed');
    assert.ok((await readLogs(f.name, f.root)).includes('模拟启动失败'));
  } finally { if (server.listening) await new Promise(resolve => server.close(resolve)); await f.close(); }
});

test('识别其他终端启动的服务，停止指令不误停', async () => {
  const f = await fixture(); const server = createHttpServer((_request, response) => { response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify({ ok: true, experiment_id: f.name })); });
  await new Promise(resolve => server.listen(f.port, '127.0.0.1', resolve));
  try {
    assert.equal((await getStatus(f.name, f.root)).status, 'unmanaged');
    await assert.rejects(stopExperiment(f.name, f.root), /原终端停止/); assert.equal(server.listening, true);
  } finally { await new Promise(resolve => server.close(resolve)); await f.close(); }
});

test('异常关闭遗留的启动锁过期后可恢复', async () => {
  const f = await fixture(); const lock = join(f.root, '.launcher', f.name, 'start.lock');
  try {
    await mkdir(lock, { recursive: true });
    await assert.rejects(startExperiment(f.name, undefined, f.root), /正在启动/);
    const past = new Date(Date.now() - 60000); await utimes(lock, past, past);
    assert.equal((await startExperiment(f.name, undefined, f.root)).status, 'running');
  } finally { await f.close(); }
});

test('SH实际服务使用IPC正常关闭SQLite，不写入正式运行数据', async () => {
  const actual = pathToFileURL(join(repositoryRoot, 'f5-sh-pilot/src/server.ts')).href;
  const f = await fixture(`import ${JSON.stringify(actual)};`);
  try {
    assert.equal((await startExperiment(f.name, undefined, f.root)).status, 'running');
    assert.equal((await fetch(`http://127.0.0.1:${f.port}/api/health`)).status, 200);
    assert.equal((await stopExperiment(f.name, f.root)).status, 'stopped');
    const { DatabaseSync } = await import('node:sqlite'); const db = new DatabaseSync(join(f.path, 'runtime/experiment.sqlite'));
    try { assert.equal(db.prepare('SELECT count(*) AS count FROM sessions').get().count, 0); assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok'); } finally { db.close(); }
  } finally { await f.close(); }
});

test('SL实际服务使用IPC正常关闭SQLite，不写入正式运行数据', async () => {
  const actual = pathToFileURL(join(repositoryRoot, 'f5-sl-pilot/src/server.ts')).href;
  const f = await fixture(`import ${JSON.stringify(actual)};`, 'f5-sl-pilot');
  try {
    assert.equal((await startExperiment(f.name, undefined, f.root)).status, 'running');
    assert.equal((await fetch(`http://127.0.0.1:${f.port}/api/health`)).status, 200);
    assert.equal((await stopExperiment(f.name, f.root)).status, 'stopped');
    const { DatabaseSync } = await import('node:sqlite'); const db = new DatabaseSync(join(f.path, 'runtime/experiment.sqlite'));
    try { assert.equal(db.prepare('SELECT count(*) AS count FROM sessions').get().count, 0); assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok'); } finally { db.close(); }
  } finally { await f.close(); }
});

test('双入口格式正确，交互菜单能选择实验并返回退出', async () => {
  if (process.platform !== 'win32') assert.ok((await stat(join(repositoryRoot, 'a5-experiments.command'))).mode & 0o100);
  const bat = await readFile(join(repositoryRoot, 'a5-experiments.bat'), 'utf8'); assert.ok(bat.includes('\r\n')); assert.ok(bat.includes('chcp 65001')); assert.ok(bat.includes('%~dp0'));
  const result = await new Promise((resolveExit, reject) => {
    import('node:child_process').then(({ spawn }) => {
      const child = spawn(process.execPath, [join(repositoryRoot, 'scripts/experiment-launcher.mjs')], { cwd: repositoryRoot, stdio: ['pipe', 'pipe', 'pipe'] }); let stdout = '', stderr = '';
      child.stdout.on('data', chunk => { stdout += chunk; }); child.stderr.on('data', chunk => { stderr += chunk; }); child.on('error', reject);
      child.on('exit', code => resolveExit({ code, stdout, stderr }));
      discoverExperiments().then(entries => child.stdin.end(`${entries.findIndex(e => e.name === 'f5-sh-pilot') + 1}\nhelp\n0\nq\n`), reject);
    }, reject);
  });
  assert.equal(result.code, 0, result.stderr); assert.ok(result.stdout.includes('已选择：f5-sh-pilot')); assert.ok(result.stdout.includes('2/stop 停止')); assert.ok(result.stdout.includes('启动器已退出'));
});
