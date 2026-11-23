import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRepoTools, resolveSafeRepoPath } from '../src/runners/repo-tools.ts';

const tempDirs: string[] = [];

function makeRepoDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'civireview-tools-test-'));
  tempDirs.push(dir);
  mkdirSync(join(dir, '.git'));
  writeFileSync(
    join(dir, '.git', 'config'),
    '[remote "origin"]\n\turl = https://x-access-token:SECRET@github.com/o/r.git\n',
  );
  mkdirSync(join(dir, '.github'));
  writeFileSync(join(dir, '.github', 'ci.yml'), 'name: ci\n');
  writeFileSync(join(dir, 'a.php'), '<?php\necho "hello";\n');
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

// The tools only use their parsed input; the AI SDK call options are irrelevant here.
type Exec = (input: unknown, options: unknown) => Promise<string>;
function exec(dir: string, name: string): (input: unknown) => Promise<string> {
  const tools = createRepoTools(dir) as unknown as Record<string, { execute: Exec }>;
  return (input) => tools[name]!.execute(input, {});
}

describe('repo tools sandbox', () => {
  test('blocks reading git internals, directly and through symlinks', async () => {
    const dir = makeRepoDir();
    symlinkSync('.git', join(dir, 'gitlink'));
    const read = exec(dir, 'read_file');

    await expect(read({ path: '.git/config' })).rejects.toThrow(/git internals/);
    await expect(read({ path: 'gitlink/config' })).rejects.toThrow(/git internals/);
    expect(() => resolveSafeRepoPath(dir, 'sub/.GIT/config')).toThrow(/git internals/);
  });

  test('still reads regular files and dot-directories such as .github', async () => {
    const dir = makeRepoDir();
    expect(await exec(dir, 'read_file')({ path: 'a.php' })).toContain('2: echo "hello";');
    expect(await exec(dir, 'read_file')({ path: '.github/ci.yml' })).toContain('name: ci');
  });

  test('grep_repo reports an invalid pattern instead of returning nothing', async () => {
    const dir = makeRepoDir();
    const grep = exec(dir, 'grep_repo');

    await expect(grep({ pattern: '(' })).rejects.toThrow(/rg failed|Invalid regular expression/);
    expect(await grep({ pattern: 'hello' })).toContain('a.php:2:');
    expect(await grep({ pattern: 'x-access-token' })).toBe('No matches found.');
  });
});

function gitIn(dir: string, ...args: string[]): void {
  const res = Bun.spawnSync(
    ['git', '-c', 'user.name=Test', '-c', 'user.email=test@example.org', ...args],
    { cwd: dir },
  );
  if (res.exitCode !== 0) throw new Error(`git ${args.join(' ')}: ${res.stderr.toString()}`);
}

function makeGitRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'civireview-tools-git-'));
  tempDirs.push(dir);
  gitIn(dir, 'init', '-q', '-b', 'main');
  writeFileSync(join(dir, 'a.php'), 'one\n');
  gitIn(dir, 'add', '.');
  gitIn(dir, 'commit', '-q', '-m', 'first');
  writeFileSync(join(dir, 'a.php'), 'two\n');
  gitIn(dir, 'commit', '-q', '-am', 'second');
  return dir;
}

describe('repo tools: git and listing', () => {
  test('git_show returns the file at an older revision', async () => {
    const dir = makeGitRepo();
    expect(await exec(dir, 'git_show')({ rev: 'HEAD~1', path: 'a.php' })).toBe('one\n');
    expect(await exec(dir, 'git_show')({ rev: 'HEAD', path: 'a.php' })).toBe('two\n');
  });

  test('git_show rejects option-like revisions and paths outside the repository', async () => {
    const dir = makeGitRepo();
    const show = exec(dir, 'git_show');

    await expect(show({ rev: '--output=/tmp/x', path: 'a.php' })).rejects.toThrow(
      /Unsafe git revision/,
    );
    await expect(show({ rev: 'HEAD', path: '../etc/passwd' })).rejects.toThrow();
    await expect(show({ rev: 'HEAD', path: '.git/config' })).rejects.toThrow(/git internals/);
  });

  test('git_show reports an unknown revision as text the model can act on', async () => {
    const dir = makeGitRepo();
    expect(await exec(dir, 'git_show')({ rev: 'nope', path: 'a.php' })).toMatch(
      /^git error \(\d+\)/,
    );
  });

  test('git_log lists recent commits, optionally for one path, and honours the limit', async () => {
    const dir = makeGitRepo();
    const log = exec(dir, 'git_log');

    const all = (await log({})).trim().split('\n');
    expect(all).toHaveLength(2);
    expect(all[0]).toContain('second');
    expect((await log({ limit: 1 })).trim().split('\n')).toHaveLength(1);
    expect(await log({ path: 'a.php' })).toContain('first');
    await expect(log({ path: '../outside' })).rejects.toThrow();
  });

  test('list_files skips .git, node_modules and vendor, and respects the limit', async () => {
    const dir = makeRepoDir();
    for (const skipped of ['node_modules', 'vendor']) {
      mkdirSync(join(dir, skipped));
      writeFileSync(join(dir, skipped, 'x.js'), 'x');
    }
    mkdirSync(join(dir, 'src'));
    writeFileSync(join(dir, 'src', 'b.php'), 'b');
    const list = exec(dir, 'list_files');

    const files = (await list({})).split('\n').toSorted();
    expect(files).toEqual(['.github/ci.yml', 'a.php', 'src/b.php']);
    expect((await list({ limit: 1 })).split('\n')).toHaveLength(1);
    expect(await list({ subpath: 'src' })).toBe('src/b.php');
    expect(await list({ subpath: 'src/nonexistent' })).toBe('(no files)');
  });
});
