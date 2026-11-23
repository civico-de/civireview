import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config/loader.ts';
import { collectEvidence } from '../src/evidence/collector.ts';
import { EvidenceBundleSchema } from '../src/evidence/types.ts';

let repo = '';
let out = '';

function git(...args: string[]): string {
  const res = Bun.spawnSync(
    ['git', '-c', 'user.name=Test', '-c', 'user.email=test@example.org', ...args],
    { cwd: repo },
  );
  if (res.exitCode !== 0) throw new Error(`git ${args.join(' ')}: ${res.stderr.toString()}`);
  return res.stdout.toString().trim();
}

function write(path: string, content: string): void {
  const full = join(repo, path);
  mkdirSync(join(full, '..'), { recursive: true });
  writeFileSync(full, content);
}

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'civireview-collect-'));
  out = join(repo, '..', `${repo.split('/').pop()}-out`);
  git('init', '-q', '-b', 'master');
  write('CRM/Foo.php', '<?php\nfunction foo() {\n  return 1;\n}\n');
  write('package-lock.json', '{}\n');
  git('add', '.');
  git('commit', '-q', '-m', 'base');
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
  rmSync(out, { recursive: true, force: true });
});

const noAbConfig = (extra: Parameters<typeof loadConfig>[1] = {}) =>
  loadConfig(repo, { ab: { enabled: false }, ...extra });

describe('collectEvidence in local git mode', () => {
  test('builds a valid bundle from the commit range and writes evidence.json and diff.patch', async () => {
    write('CRM/Foo.php', '<?php\nfunction foo() {\n  return 2;\n}\n');
    write('package-lock.json', '{"changed":true}\n');
    git('commit', '-q', '-am', 'return two');

    const { bundle, filteredPatch, cleanup } = await collectEvidence({
      repoRoot: repo,
      config: noAbConfig(),
      outputDir: out,
    });
    await cleanup();

    expect(bundle.pr).toMatchObject({
      repo: 'local/repo',
      prNumber: 0,
      title: 'return two',
      author: 'local',
      baseBranch: 'master',
    });
    expect(bundle.pr.baseSha).toBe(git('rev-parse', 'HEAD~1'));
    expect(bundle.pr.headSha).toBe(git('rev-parse', 'HEAD'));
    expect(bundle.diffFiles.map((f) => f.path)).toEqual(['CRM/Foo.php']);
    expect(bundle.droppedNoiseFiles).toContain('package-lock.json');
    expect(bundle.ciStatus.overallState).toBe('unknown');
    expect(bundle.notVerified.join(' ')).toContain('disabled by config');
    expect(filteredPatch).toContain('+  return 2;');

    const saved = EvidenceBundleSchema.parse(
      JSON.parse(readFileSync(join(out, 'evidence.json'), 'utf8')),
    );
    expect(saved.pr.headSha).toBe(bundle.pr.headSha);
    expect(readFileSync(join(out, 'diff.patch'), 'utf8')).toBe(filteredPatch);
  });

  test('honours explicit base and head SHAs instead of HEAD~1..HEAD', async () => {
    const base = git('rev-parse', 'HEAD');
    write('CRM/Foo.php', '<?php\nfunction foo() {\n  return 2;\n}\n');
    git('commit', '-q', '-am', 'two');
    write('CRM/Foo.php', '<?php\nfunction foo() {\n  return 3;\n}\n');
    git('commit', '-q', '-am', 'three');

    const { bundle, filteredPatch, cleanup } = await collectEvidence({
      repoRoot: repo,
      config: noAbConfig(),
      baseSha: base,
      headSha: git('rev-parse', 'HEAD'),
      baseBranch: 'release',
      isPrivateRepo: false,
    });
    await cleanup();

    expect(bundle.pr).toMatchObject({ baseSha: base, baseBranch: 'release', isPrivateRepo: false });
    expect(filteredPatch).toContain('-  return 1;');
    expect(filteredPatch).toContain('+  return 3;');
    expect(existsSync(out)).toBe(false);
  });

  test('flags a diff that exceeds maxDiffBytes as truncated and not fully verified', async () => {
    write('CRM/Foo.php', `<?php\n${'$x = 1;\n'.repeat(500)}`);
    git('commit', '-q', '-am', 'big');

    const config = noAbConfig({ review: { maxDiffBytes: 400 } });
    const { bundle, cleanup } = await collectEvidence({ repoRoot: repo, config });
    await cleanup();

    expect(bundle.diffTruncated).toBe(true);
    expect(bundle.notVerified).toContain('Diff truncated at 400 bytes.');
  });

  test('fails with the git error when the range cannot be resolved', async () => {
    await expect(collectEvidence({ repoRoot: repo, config: noAbConfig() })).rejects.toThrow(
      /git rev-parse HEAD~1 failed/,
    );
  });
});
