import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';

/** 按平台列出 ADB 候选：仓库内 platform-tools、设备配置、环境变量、各平台常见 SDK 目录；PATH 由调用方追加。 */
export function adbCandidates(config, { local, platform = process.platform, env = process.env, home = homedir() } = {}) {
  const win = platform === 'win32', adbName = win ? 'adb.exe' : 'adb';
  const list = [local && join(local, 'android', 'platform-tools', adbName), config.adbPath, env.A5_ADB_PATH,
    env.ANDROID_HOME && join(env.ANDROID_HOME, 'platform-tools', adbName), env.ANDROID_SDK_ROOT && join(env.ANDROID_SDK_ROOT, 'platform-tools', adbName)];
  if (win) list.push(env.LOCALAPPDATA && join(env.LOCALAPPDATA, 'A5', 'android', 'platform-tools', adbName), env.LOCALAPPDATA && join(env.LOCALAPPDATA, 'Android', 'Sdk', 'platform-tools', adbName));
  else if (platform === 'darwin') list.push(join(home, 'Library', 'Android', 'sdk', 'platform-tools', 'adb'), '/opt/homebrew/bin/adb', '/usr/local/bin/adb');
  else list.push(join(home, 'Android', 'Sdk', 'platform-tools', 'adb'), '/usr/bin/adb', '/usr/local/bin/adb');
  return list.filter(Boolean);
}

/** 比较点分版本号（2.2.4 与 2.2.10 按数字比较）；非数字段按 0。 */
export function compareVersions(a, b) {
  const parse = v => String(v).split(/[.-]/).map(n => Number.parseInt(n, 10) || 0);
  const pa = parse(a), pb = parse(b);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) { const d = (pa[i] ?? 0) - (pb[i] ?? 0); if (d) return Math.sign(d); }
  return 0;
}

/** device.json 的 apkPath：绝对路径原样，相对路径按仓库根目录解析；未配置返回 undefined。 */
export function configuredApkPath(config, root) {
  if (typeof config.apkPath !== 'string' || !config.apkPath.trim()) return undefined;
  return isAbsolute(config.apkPath) ? config.apkPath : resolve(root, config.apkPath);
}
