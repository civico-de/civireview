import { afterEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { materializeHeadWorktree } from '../src/engine/pipeline.ts';

const tempDirs: string[] = [];

function git(dir: string, ...args: string[]): string {
  return execFileSync(
    'git',
    ['-C', dir, '-c', 'user.name=test', '-c', 'user.email=test@example.org', ...args],
    { encoding: 'utf8' },
  ).trim();
}

function makeRepo(): { dir: string; first: string; second: string } {
  const dir = mkdtempSync(join(tmpdir(), 'civireview-wt-test-'));
  tempDirs.push(dir);
  git(dir, 'init', '-q', '-b', 'main');
  writeFileSync(join(dir, 'a.txt'), 'first\n');
  git(dir, 'add', '.');
  git(dir, 'commit', '-q', '-m', 'first');
  const first = git(dir, 'rev-parse', 'HEAD');
  writeFileSync(join(dir, 'a.txt'), 'second\n');
  git(dir, 'commit', '-q', '-am', 'second');
  return { dir, first, second: git(dir, 'rev-parse', 'HEAD') };
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

describe('materializeHeadWorktree', () => {
  test('uses the checkout itself when it is clean and already at the head commit', async () => {
    const { dir, second } = makeRepo();
    const handle = await materializeHeadWorktree(dir, second);

    expect(handle.effectiveCwd).toBe(dir);
    expect(handle.atHeadSha).toBe(true);
  });

  test('reviews a dirty checkout from a clean worktree of the head commit', async () => {
    const { dir, second } = makeRepo();
    writeFileSync(join(dir, 'a.txt'), 'uncommitted edit\n');

    const handle = await materializeHeadWorktree(dir, second);
    try {
      expect(handle.effectiveCwd).not.toBe(dir);
      expect(handle.atHeadSha).toBe(true);
      expect(readFileSync(join(handle.effectiveCwd, 'a.txt'), 'utf8')).toBe('second\n');
    } finally {
      await handle.cleanup();
    }
    expect(existsSync(handle.effectiveCwd)).toBe(false);
    expect(readFileSync(join(dir, 'a.txt'), 'utf8')).toBe('uncommitted edit\n');
  });

  test('checks out another commit into a temporary worktree and removes it afterwards', async () => {
    const { dir, first } = makeRepo();

    const handle = await materializeHeadWorktree(dir, first);
    expect(handle.atHeadSha).toBe(true);
    expect(readFileSync(join(handle.effectiveCwd, 'a.txt'), 'utf8')).toBe('first\n');

    await handle.cleanup();
    expect(existsSync(handle.effectiveCwd)).toBe(false);
    expect(git(dir, 'worktree', 'list')).not.toContain(handle.effectiveCwd);
  });

  test('falls back to the checkout, flagged as not at head, for an unknown commit or bad sha', async () => {
    const { dir } = makeRepo();

    for (const sha of ['f'.repeat(40), 'not-a-sha', '']) {
      const handle = await materializeHeadWorktree(dir, sha);
      expect(handle.effectiveCwd).toBe(dir);
      expect(handle.atHeadSha).toBe(false);
    }
  });
});
