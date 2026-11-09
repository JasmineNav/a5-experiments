import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { discoverExperiments, getStatus, startExperiment, stopExperiment, readLogs, adminUrl, repositoryRoot } from './experiment-manager.mjs';
import { localDeviceControl, runDeviceControl } from './local-device-launch.mjs';

if (Number(process.versions.node.split('.')[0]) < 24) {
  console.error('请使用 Node.js 24 或更高版本。'); process.exit(1);
}
const states = { running: '运行中', starting: '启动中', stopping: '停止中', stopped: '已停止', failed: '启动失败或已退出', unmanaged: '其他终端启动' };
const printStatus = result => {
  console.log(`状态：${states[result.status] ?? result.status}`);
  if (result.port) console.log(`端口：${result.port}`);
  if (result.base_url) console.log(`地址：${result.base_url}`);
  for (const url of result.lan_urls ?? []) console.log(`其他设备：${url}`);
  if (result.message) console.log(result.message);
};
async function runNpm(item, script) {
  const args = script === 'install' ? ['ci'] : ['run', script];
  const cwd = script === 'install' ? repositoryRoot : item.path;
  await new Promise((resolveRun, reject) => {
    const child = process.platform === 'win32'
      ? spawn(process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', `npm.cmd ${args.join(' ')}`], { cwd, stdio: 'inherit' })
      : spawn('npm', args, { cwd, stdio: 'inherit' });
    child.once('error', reject); child.once('exit', code => code === 0 ? resolveRun() : reject(new Error(`命令退出码：${code}`)));
  });
}
async function openUrl(url) {
  const command = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'rundll32.exe' : 'xdg-open';
  const args = process.platform === 'win32' ? ['url.dll,FileProtocolHandler', url] : [url];
  await new Promise((resolveOpen, reject) => { const child = spawn(command, args, { stdio: 'ignore', windowsHide: true }); child.once('error', reject); child.once('exit', code => code === 0 ? resolveOpen() : reject(new Error('浏览器未能打开，请复制上方地址访问。'))); });
}
async function perform(item, line) {
  const [raw, portText, extra] = line.trim().split(/\s+/);
  const aliases = { '1': 'start', '启动': 'start', '2': 'stop', '停止': 'stop', '3': 'restart', '重启': 'restart', '4': 'status', '状态': 'status', '5': 'open', '打开': 'open', '6': 'logs', 'log': 'logs', '日志': 'logs', '7': 'check', '检查': 'check', '8': 'doctor', '自检': 'doctor', '9': 'mock', '模拟': 'mock', 'i': 'install', '安装依赖': 'install' };
  const action = aliases[raw] ?? raw?.toLowerCase();
  if (extra || (portText && !['start', 'restart'].includes(action))) throw new Error('指令格式无效；只有start/restart可附加端口，例如start 5174。');
  const port = portText === undefined ? undefined : Number(portText);
  if (portText !== undefined && (!Number.isInteger(port) || port < 1 || port > 65535)) throw new Error('端口必须是1—65535的整数。');
  const deviceEntry = ['start', 'restart', 'status', 'mock'].includes(action) ? await localDeviceControl(item) : null;
  if (action === 'start') { if (deviceEntry) await runDeviceControl(deviceEntry, 'start', port, item.name); else printStatus(await startExperiment(item.name, port)); if (process.stdin.isTTY) await openUrl(await adminUrl(item.name)); }
  else if (action === 'stop') printStatus(await stopExperiment(item.name));
  else if (action === 'restart') { const previous = await getStatus(item.name); await stopExperiment(item.name); if (deviceEntry) await runDeviceControl(deviceEntry, 'start', port ?? previous.port ?? undefined, item.name); else printStatus(await startExperiment(item.name, port ?? previous.port ?? undefined)); }
  else if (action === 'status') { if (deviceEntry) await runDeviceControl(deviceEntry, 'status', undefined, item.name); else printStatus(await getStatus(item.name)); }
  else if (action === 'mock') { if (!deviceEntry) throw new Error('当前未配置独立 Mock 入口。'); await runDeviceControl(deviceEntry, 'mock', undefined, item.name); if (process.stdin.isTTY) await openUrl(await adminUrl(item.name)); }
  else if (action === 'logs') console.log(await readLogs(item.name));
  else if (action === 'open') { const url = await adminUrl(item.name); console.log(`后台：${url}`); await openUrl(url); }
  else if (['check', 'doctor', 'install'].includes(action)) { if (action !== 'install' && !item.scripts?.[action]) throw new Error(`本实验未配置${action}命令。`); await runNpm(item, action); }
  else throw new Error('未知指令；输入help查看菜单。');
}
const menu = () => console.log('\n1/start 启动    2/stop 停止    3/restart 重启    4/status 状态\n5/open 打开后台    6/logs 日志    7/check 检查    8/doctor 自检\n9/mock 明确选择模拟预演（本机设备配置）\ni/install 安装仓库依赖    0/back 返回实验列表    q/quit 退出启动器\nWindows/macOS 启动/重启使用真机模式（USB 或无线），连接失败不会转为 Mock。\n可指定端口：start 5174。退出启动器后服务继续运行，需要停止请使用stop。');

if (process.argv.includes('--action')) {
  const args = process.argv.slice(2); const argument = flag => args[args.indexOf(flag) + 1];
  const item = (await discoverExperiments()).find(e => e.name === argument('--experiment'));
  if (!item) { console.error('请通过--experiment指定实验目录名。'); process.exitCode = 1; }
  else { try { await perform(item, `${argument('--action')}${args.includes('--port') ? ` ${argument('--port')}` : ''}`); } catch (error) { console.error(error.message); process.exitCode = 1; } }
} else {
  const terminal = createInterface({ input: process.stdin, output: process.stdout, terminal: Boolean(process.stdin.isTTY) });
  const lines = terminal[Symbol.asyncIterator]();
  const ask = async prompt => { process.stdout.write(prompt); const line = await lines.next(); return line.done ? null : line.value.trim(); };
  terminal.on('SIGINT', () => terminal.close());
  console.log('A5 实验启动器\n先用数字选择实验，再输入数字或指令。');
  try {
    let quitting = false;
    while (!quitting) {
      const experiments = await discoverExperiments(); console.log('\n实验列表：');
      const statuses = await Promise.all(experiments.map(e => getStatus(e.name).catch(() => ({ status: 'failed' }))));
      experiments.forEach((item, i) => console.log(`${i + 1}. ${item.name}  [${states[statuses[i].status]}]${item.problem ? ` — ${item.problem}` : ''}`));
      if (!experiments.length) console.log('尚未找到f5-场景-版本实验目录。');
      const selection = await ask('输入实验编号，r刷新，q退出：');
      if (selection === null || ['q', 'quit', '0', '退出'].includes(selection.toLowerCase())) break;
      if (selection.toLowerCase() === 'r') continue;
      const index = /^\d+$/.test(selection) ? Number(selection) - 1 : -1;
      const item = experiments[index]; if (!item) { console.log('请输入列表中的实验编号。'); continue; }
      console.log(`\n已选择：${item.name}`); menu();
      while (true) {
        const line = await ask(`${item.name}> `);
        if (line === null || ['q', 'quit', 'exit', '退出'].includes(line.toLowerCase())) { quitting = true; break; }
        if (['0', 'back', '返回'].includes(line.toLowerCase())) break;
        if (['help', 'h', '?', '帮助'].includes(line.toLowerCase()) || !line) { menu(); continue; }
        try { await perform(item, line); } catch (error) { console.error(`操作失败：${error.message}`); }
      }
    }
  } finally { terminal.close(); console.log('\n启动器已退出。已启动服务继续在后台运行，可重新打开启动器查看或停止。'); }
}
