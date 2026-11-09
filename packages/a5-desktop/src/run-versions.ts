import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { displayRelease } from '@a5/glasses/display-release.ts';

/** 仓库根目录（packages/a5-desktop/src → 上三级）。 */
export const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

/** 复现一次采集所需的版本坐标：实验提交、基座 tag/提交、APK SHA-256；app_version 与已安装 APK 指纹在建会话时由设备补齐。 */
export interface RunVersions {
  experiment_commit: string | null;
  /** 工作区有未提交改动时为 true；无法判断（无 git）为 null。 */
  experiment_dirty: boolean | null;
  display_base_tag: string;
  display_base_commit_pinned: string;
  display_base_commit: string | null;
  display_base_version: string | null;
  display_apk_sha256_pinned: string;
  expected_app_version: string;
}

function git(dir: string, args: string[]) {
  try { return execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', timeout: 3000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }).trim(); }
  catch { return null; }
}
/** 没有 git 可执行文件时直接读 .git（支持 worktree/submodule 的 gitdir 文件与 packed-refs）。 */
export function readHead(dir: string): string | null {
  try {
    let gitDir = join(dir, '.git');
    if (!existsSync(gitDir)) return null;
    if (statSync(gitDir).isFile()) gitDir = resolve(dir, readFileSync(gitDir, 'utf8').replace(/^gitdir:\s*/, '').trim());
    const head = readFileSync(join(gitDir, 'HEAD'), 'utf8').trim();
    if (/^[0-9a-f]{40}$/.test(head)) return head;
    const ref = /^ref:\s*(\S+)$/.exec(head)?.[1]; if (!ref) return null;
    const common = existsSync(join(gitDir, 'commondir')) ? resolve(gitDir, readFileSync(join(gitDir, 'commondir'), 'utf8').trim()) : gitDir;
    for (const base of [gitDir, common]) { const file = join(base, ref); if (existsSync(file)) return readFileSync(file, 'utf8').trim(); }
    for (const base of [gitDir, common]) {
      const packed = join(base, 'packed-refs'); if (!existsSync(packed)) continue;
      const line = readFileSync(packed, 'utf8').split(/\r?\n/).find(l => l.endsWith(` ${ref}`)); if (line) return line.split(' ')[0]!;
    }
  } catch {}
  return null;
}

export function collectRunVersions(root = repositoryRoot): RunVersions {
  const vendor = join(root, 'vendor', 'glasses-display');
  const status = git(root, ['status', '--porcelain', '--untracked-files=no']);
  let baseVersion: string | null = null;
  try { baseVersion = JSON.parse(readFileSync(join(vendor, 'host', 'package.json'), 'utf8')).version ?? null; } catch {}
  return {
    experiment_commit: git(root, ['rev-parse', 'HEAD']) ?? readHead(root),
    experiment_dirty: status === null ? null : status.length > 0,
    display_base_tag: displayRelease.tag,
    display_base_commit_pinned: displayRelease.commit,
    display_base_commit: git(vendor, ['rev-parse', 'HEAD']) ?? readHead(vendor),
    display_base_version: baseVersion,
    display_apk_sha256_pinned: displayRelease.sha256,
    expected_app_version: displayRelease.version,
  };
}
