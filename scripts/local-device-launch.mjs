import { access } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { repositoryRoot } from './experiment-manager.mjs';

/** 真机启动链路支持的桌面平台：Windows 与 macOS（Linux 实验室机同样可用）。 */
export const devicePlatforms = Object.freeze(['win32', 'darwin', 'linux']);
// 静态实验先开真机后台与 Web 整备；首次没有设备配置也不能静默进入 Mock。
export async function localDeviceControl(item, { root = repositoryRoot, platform = process.platform } = {}) {
  if (!devicePlatforms.includes(platform) || !/^f5-(sh|sl)-/.test(item.name)) return null;
  const entry = join(root, 'scripts', 'glasses-control.mjs');
  try { await access(entry); } catch { throw new Error('缺少 scripts/glasses-control.mjs；未启动 Mock，请恢复真机启动脚本。'); }
  return entry;
}

export async function runDeviceControl(entry, action, port, experiment) {
  const args = [entry, action, '--no-open'];
  if (port !== undefined) args.push('--port', String(port));
  if (experiment !== undefined) args.push('--experiment', experiment);
  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { stdio: 'inherit', windowsHide: true });
    child.once('error', reject);
    child.once('exit', code => code === 0 ? resolve() : reject(new Error('设备启动操作未完成，请查看上方诊断；不会回退为 Mock。')));
  });
}
