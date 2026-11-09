import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { collectRunVersions, readHead } from '@a5/desktop/run-versions.ts';
import { displayRelease } from '@a5/glasses/display-release.ts';

test('运行版本坐标包含实验提交、基座 tag/提交与固定 APK SHA', () => {
  const v = collectRunVersions();
  assert.equal(v.display_base_tag, displayRelease.tag); assert.equal(v.display_apk_sha256_pinned, displayRelease.sha256);
  assert.equal(v.expected_app_version, displayRelease.version); assert.equal(v.display_base_version, displayRelease.version);
  if (v.experiment_commit) assert.match(v.experiment_commit, /^[0-9a-f]{40}$/);
  if (v.display_base_commit) assert.equal(v.display_base_commit, displayRelease.commit);
});

test('没有 git 可执行文件时也能从 .git 读出提交（分支、packed-refs、gitdir 文件、分离 HEAD）', async () => {
  const root = await mkdtemp(join(tmpdir(), 'a5-head-'));
  try {
    const sha = 'a'.repeat(40), other = 'b'.repeat(40);
    await mkdir(join(root, 'repo/.git/refs/heads'), { recursive: true });
    await writeFile(join(root, 'repo/.git/HEAD'), 'ref: refs/heads/main\n'); await writeFile(join(root, 'repo/.git/refs/heads/main'), sha + '\n');
    assert.equal(readHead(join(root, 'repo')), sha);
    await writeFile(join(root, 'repo/.git/HEAD'), 'ref: refs/heads/packed\n'); await writeFile(join(root, 'repo/.git/packed-refs'), `# pack-refs\n${other} refs/heads/packed\n`);
    assert.equal(readHead(join(root, 'repo')), other);
    await mkdir(join(root, 'modules/sub'), { recursive: true }); await mkdir(join(root, 'sub'));
    await writeFile(join(root, 'modules/sub/HEAD'), sha + '\n'); await writeFile(join(root, 'sub/.git'), 'gitdir: ../modules/sub\n');
    assert.equal(readHead(join(root, 'sub')), sha);
    assert.equal(readHead(join(root, 'none')), null);
  } finally { await rm(root, { recursive: true, force: true }); }
});
