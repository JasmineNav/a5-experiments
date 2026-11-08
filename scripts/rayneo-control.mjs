import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const execute = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const local = join(root, '.a5-local');
const source = root;
// 眼镜与设备配置由 SH、SL 等静态桌面分项共用；默认 SH，启动器通过 --experiment 指定分项。
const experimentIndex = process.argv.indexOf('--experiment');
const name = experimentIndex === -1 ? 'f5-sh-pilot' : process.argv[experimentIndex + 1];
if (!/^f5-(sh|sl)-[a-z0-9-]+$/.test(name ?? '')) throw new Error('--experiment 必须是 f5-sh-* 或 f5-sl-* 实验目录名。');
const pkg = 'link.ironip.glasses.display';
const expectedVersion='2.2.0';
const expectedSha='ee4f46b806581c1be471eaa81d1a37447d6dace961a883c4d8f0673f14a6895d';
const configPath = join(local, 'device.json');
const action = process.argv[2] ?? 'start';
const noOpen = process.argv.includes('--no-open');
const portIndex = process.argv.indexOf('--port');
const requestedPort = portIndex === -1 ? undefined : Number(process.argv[portIndex + 1]);
if (requestedPort !== undefined && (!Number.isInteger(requestedPort) || requestedPort < 1 || requestedPort > 65535)) throw new Error('端口必须是 1—65535 的整数。');

async function readConfig() {
  try { return JSON.parse(await readFile(configPath, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return {}; throw error; }
}
async function runAdb(adb, args) {
  try { return (await execute(adb, args, { cwd: root, windowsHide: true, timeout: 30000, maxBuffer: 2 * 1024 * 1024 })).stdout; }
  catch (error) {
    if (error.code === 'ENOENT') throw new Error(`无法执行 ADB：${adb}。请确认该文件仍存在。`);
    throw new Error('ADB 操作失败，请确认 USB 数据线、设备调试授权及眼镜显示程序。');
  }
}
async function resolveAdb(config) {
  const candidates = [join(local, 'android', 'platform-tools', 'adb.exe'), config.adbPath, process.env.A5_ADB_PATH,
    process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, 'A5', 'android', 'platform-tools', 'adb.exe')];
  try {
    const found = await execute('where.exe', ['adb.exe'], { cwd: root, windowsHide: true, timeout: 5000 });
    candidates.push(...found.stdout.split(/\r?\n/));
  } catch {}
  for (const candidate of new Set(candidates.filter(Boolean).map(value => value.trim().replace(/^"|"$/g, '')))) {
    try {
      await execute(candidate, ['version'], { cwd: root, windowsHide: true, timeout: 5000 });
      process.env.A5_ADB_PATH = candidate;
      process.env.PATH = `${dirname(candidate)};${process.env.PATH ?? ''}`;
      return candidate;
    } catch {}
  }
  throw new Error('未找到可执行的 ADB。已检查设备配置、用户安装目录及 PATH，请确认 platform-tools 中的 adb.exe 可运行。');
}
async function device() {
  const config = await readConfig();
  const adb = await resolveAdb(config);
  const output = await runAdb(adb, ['devices']);
  const devices = output.split(/\r?\n/).map(line => line.trim().split(/\s+/)).filter(parts => parts.length >= 2 && !parts[0].startsWith('*') && parts[0] !== 'List');

  const connected = devices.filter(parts => parts[1] === 'device');
  let serial = config.serial;
  if(!serial&&connected.length===1)serial=connected[0][0];
  if(!serial||!connected.some(parts=>parts[0]===serial))return {adb,serial:serial??'',connected:false};
  if(!/^[A-Za-z0-9_.:-]{1,128}$/.test(serial))throw new Error('设备路由格式无效。');
  const packageName=pkg;
  await mkdir(local, { recursive: true });
  await writeFile(configPath, JSON.stringify({ ...config, adbPath: adb, serial }, null, 2) + '\n', { mode: 0o600 });
  const localScrcpy = join(local, 'scrcpy', 'scrcpy.exe');
  let scrcpyPath = config.scrcpyPath;
  try { await execute(localScrcpy, ['--version'], { cwd: root, windowsHide: true, timeout: 5000 }); scrcpyPath = localScrcpy; } catch {}
  return { connected:true,adb, serial, port: requestedPort ?? (name === 'f5-sh-pilot' ? config.port ?? 5173 : undefined), packageName, scrcpyPath,
    activityName: `${packageName}/link.ironip.glasses.display.MainActivity`,
    apkPath: config.packageName===pkg&&config.apkPath?config.apkPath:join(local,'artifacts','glasses-display-2.2.0-debug.apk'),
    apkSha256:config.packageName===pkg&&config.apkSha256?config.apkSha256:expectedSha };
}
async function health(port) {
  const response = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(2000) });
  if (!response.ok) throw new Error('电脑端健康检查未通过。');
  return response.json();
}
function describe(value) {
  const adapter = value.adapter;
  console.log(`运行模式：${value.mock_only ? 'Mock 预演' : '共享显示端真机'}`);
  if (value.mock_only) {
    console.log('真机连接：未使用（Mock 预演不检测或驱动眼镜）');
    console.log(`显示状态：${adapter.busy ? '正在模拟展示' : '模拟预演就绪'}`);
    return;
  }
  console.log(`眼镜连接：${adapter.connected ? '已连接' : '未连接'}`);
  console.log(`显示状态：${adapter.busy ? '正在展示' : adapter.ready ? '显示端就绪' : '未就绪'}`);
  if (adapter.error) console.log(`设备诊断：${String(adapter.error).replaceAll(/adb:[A-Za-z0-9_.:-]+/g, 'adb:[本机设备]')}`);
}
async function open(manager) {
  const url = await manager.adminUrl(name);
  await new Promise((done, reject) => {
    const child = spawn('rundll32.exe', ['url.dll,FileProtocolHandler', url], { windowsHide: true, stdio: 'ignore' });
    child.once('error', reject); child.once('exit', code => code === 0 ? done() : reject(new Error('浏览器未能打开，请在总 BAT 中选择 5 打开后台。')));
  });
  console.log('已在浏览器打开管理后台。');
}

try {
  if (Number(process.versions.node.split('.')[0]) < 24) throw new Error('请使用 Node.js 24 或更高版本。');
  const manager = await import(pathToFileURL(join(source, 'scripts', 'experiment-manager.mjs')).href);
  if (action === 'stop') {
    await manager.stopExperiment(name);
    console.log('电脑端已正常停止，实验数据已保留。');
  } else if (action === 'open') {
    await open(manager);
  } else if (action === 'status') {
    const status = await manager.getStatus(name);
    console.log(`电脑端：${status.status === 'running' ? '运行中' : status.status === 'stopped' ? '已停止' : status.status}`);
    if (['running', 'unmanaged'].includes(status.status)) {
      console.log(`地址：http://127.0.0.1:${status.port}/admin`);
      describe(await health(status.port));
    }
  } else if (action === 'mock') {
    const current = await manager.getStatus(name);
    if (current.status === 'unmanaged') throw new Error('发现其他终端启动的服务。请先在原终端正常停止，再使用 Mock 入口。');
    if (current.status === 'running') {
      const value = await health(current.port);
      if (!value.mock_only) throw new Error('当前运行的是真机模式。请先在总 BAT 中选择 3 正常停止，再启动 Mock 预演。');
      console.log(`Mock 预演已在运行：http://127.0.0.1:${current.port}/admin`);
    } else {
      process.env.A5_GLASSES_MODE = 'mock';
      for (const key of ['A5_GLASSES_SERIAL','A5_GLASSES_PACKAGE','A5_DEVICE_IDENTITY','A5_RAYNEO_SERIAL', 'A5_ADB_PATH', 'A5_RAYNEO_PACKAGE', 'A5_SCRCPY_PATH', 'A5_RAYNEO_HOST_MODE']) delete process.env[key];
      const started = await manager.startExperiment(name, requestedPort ?? (name === 'f5-sh-pilot' ? (await readConfig()).port ?? 5173 : undefined));
      console.log(`Mock 预演已启动：http://127.0.0.1:${started.port}/admin`);
    }
    const status = await manager.getStatus(name);
    describe(await health(status.port));
    if (!noOpen) await open(manager);
  } else if (action === 'start') {
    let current=await manager.getStatus(name);
    if(current.status==='unmanaged')throw new Error('请先正常停止原终端的服务。');
    const config=await readConfig();
    if(current.status==='running'&&(await health(current.port)).mock_only)throw new Error('当前为 Mock，请先正常停止再启动真机；不静默切换。');
    if(current.status!=='running'){
      process.env.A5_GLASSES_MODE='device';process.env.A5_GLASSES_SERIAL=config.serial??'';process.env.A5_GLASSES_PACKAGE=pkg;
      if(config.adbPath)process.env.A5_ADB_PATH=config.adbPath;
      if(config.scrcpyPath)process.env.A5_SCRCPY_PATH=config.scrcpyPath;
      const started=await manager.startExperiment(name,requestedPort??(name==='f5-sh-pilot'?config.port??5173:undefined));
      console.log(`电脑端已启动：http://127.0.0.1:${started.port}/admin`);
    }
    // 先开后台，再处理硬件整备；没有 USB/ADB 也不阻止进入 Web。
    if(!noOpen)await open(manager);
    const status=await manager.getStatus(name);
    describe(await health(status.port));
    try{
      const target=await device();
      if(target.connected){
        const installed=await runAdb(target.adb,['-s',target.serial,'shell','dumpsys','package',pkg]);
        const version=/versionName=(\S+)/.exec(installed)?.[1];
        if(version!==expectedVersion){
          const sha=createHash('sha256').update(await readFile(target.apkPath)).digest('hex');
          if(sha!==target.apkSha256)throw new Error('共享显示端 APK SHA-256 不符，未安装。');
          const value=await health(status.port);
          if(value.adapter.busy)throw new Error('眼镜仍有展示，暂不更新 APK。');
          const result=await runAdb(target.adb,['-s',target.serial,'install','-r',target.apkPath]);
          if(!result.includes('Success'))throw new Error('APK 安装失败；不要卸载或清除账本数据。');
          const after=await runAdb(target.adb,['-s',target.serial,'shell','dumpsys','package',pkg]);
          if(!after.includes(`versionName=${expectedVersion}`))throw new Error('安装后版本核对失败。');
          console.log(`共享显示端 ${expectedVersion} 已安装。`);
        }
      }
    }catch(error){console.log(`硬件整备待处理：${error.message}；请在 Web 运行设备自检。`);}
    console.log('在 Web 按「选设备 → 连通道 → 打开显示端 → 试发验证」整备，可用 USB 或无线；路由由后端记忆。');
  } else throw new Error('未知操作。支持 start、mock、stop、open、status。');
} catch (error) {
  console.error(`操作未完成：${error.message}`);
  process.exitCode = 1;
}
