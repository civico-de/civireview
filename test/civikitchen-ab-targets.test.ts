import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AbConfigSchema, ChecksConfigSchema } from '../src/config/schema.ts';
import { formatAbDiagnosticTail } from '../src/evidence/ab/parsers.ts';
import {
  buildCoreMountPlan,
  buildMultiTargetTestCommand,
  deriveRegressionTargets,
} from '../src/evidence/ab/test-targets.ts';
import { runCiviKitchenAb, type ExecFn } from '../src/evidence/civikitchen-ab.ts';
import {
  collectBaseDriftSinceImage,
  resolveAvailableCivikitchenImage,
} from '../src/evidence/ab/image-drift.ts';
import { mergeBlastRadius } from '../src/engine/findings.ts';
import { parseUnifiedDiff } from '../src/evidence/diff-filter.ts';
import type { DiffFile, RepoInfo } from '../src/evidence/types.ts';

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'civireview-ab-targets-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

function modifiedSqlDiff(): DiffFile[] {
  return parseUnifiedDiff(
    [
      'diff --git a/CRM/Queue/Sql.php b/CRM/Queue/Sql.php',
      '--- a/CRM/Queue/Sql.php',
      '+++ b/CRM/Queue/Sql.php',
      '@@ -1 +1 @@',
      '-old',
      '+new',
    ].join('\n'),
  );
}

function makeCoreWorktrees(): { wtA: string; wtB: string } {
  const root = makeTempDir();
  const wtA = join(root, 'A');
  const wtB = join(root, 'B');
  for (const wt of [wtA, wtB]) {
    mkdirSync(join(wt, 'CRM/Queue'), { recursive: true });
    mkdirSync(join(wt, 'CRM/Core'), { recursive: true });
    mkdirSync(join(wt, 'Civi'), { recursive: true });
    mkdirSync(join(wt, 'api/v3'), { recursive: true });
    mkdirSync(join(wt, 'ext/afform'), { recursive: true });
    mkdirSync(join(wt, 'tests/phpunit'), { recursive: true });
    writeFileSync(join(wt, 'CRM/Queue/Sql.php'), '<?php\n');
    writeFileSync(join(wt, 'CRM/Core/RecentHelper.php'), '<?php\n');
    writeFileSync(join(wt, 'api/v3/Recent.php'), '<?php\n');
    writeFileSync(join(wt, 'ext/afform/Recent.php'), '<?php\n');
    writeFileSync(join(wt, 'tests/phpunit/Helper.php'), '<?php\n');
    mkdirSync(join(wt, 'ext/greenwich'), { recursive: true });
    writeFileSync(
      join(wt, 'composer.json'),
      JSON.stringify({
        extra: { downloads: { bootstrap3: { path: 'ext/greenwich/extern/bootstrap3' } } },
      }),
    );
  }
  return { wtA, wtB };
}

const onlyLatestPublished: ExecFn = async (args) =>
  args[0] === 'docker' && args[1] === 'manifest' && (args[3] ?? '').endsWith(':standalone-latest')
    ? { exitCode: 0, stdout: '{}', stderr: '' }
    : { exitCode: 1, stdout: '', stderr: 'No such image' };

const alwaysFails: ExecFn = async () => ({ exitCode: 1, stdout: '', stderr: 'no such file' });

async function runDriftReview(vendorSync: boolean) {
  const repoDir = mkdtempSync(join(tmpdir(), 'civireview-drift-'));
  const imageSha = 'd'.repeat(40);
  const ckCalls: string[][] = [];
  const execFn: ExecFn = async (args) => {
    if (args[0] === 'docker' && args[1] === 'run') {
      return {
        exitCode: 0,
        stdout: `git . ${imageSha}\n${vendorSync ? 'vendor-sync\n' : ''}`,
        stderr: '',
      };
    }
    if (args[0] === 'git' && args[3] === 'worktree' && args[4] === 'add') {
      const target = args[6]!;
      mkdirSync(join(target, 'CRM/Queue'), { recursive: true });
      mkdirSync(join(target, 'Civi'), { recursive: true });
      writeFileSync(join(target, 'CRM/Queue/Sql.php'), '<?php\n');
      writeFileSync(join(target, 'Civi/Recent.php'), '<?php\n');
      writeFileSync(join(target, 'composer.lock'), '{}\n');
      mkdirSync(join(target, 'tests/phpunit/CRM/Queue'), { recursive: true });
      writeFileSync(join(target, 'tests/phpunit/CRM/Queue/SqlTest.php'), '<?php\n');
      return { exitCode: 0, stdout: '', stderr: '' };
    }
    if (args[0] === 'git' && args.includes('diff') && args.includes(imageSha)) {
      return { exitCode: 0, stdout: 'Civi/Recent.php\ncomposer.lock\n', stderr: '' };
    }
    if (args[0] === 'ck') ckCalls.push(args);
    return { exitCode: 0, stdout: '', stderr: '' };
  };

  const outcome = await runCiviKitchenAb({
    repoRoot: repoDir,
    repoInfo: { kind: 'civicrm-core', root: repoDir, recommendedImage: 'standalone-master' },
    baseSha: 'aaaaaaa',
    headSha: 'bbbbbbb',
    diffFiles: parseUnifiedDiff(
      [
        'diff --git a/CRM/Queue/Sql.php b/CRM/Queue/Sql.php',
        '--- a/CRM/Queue/Sql.php',
        '+++ b/CRM/Queue/Sql.php',
        '@@ -1 +1,2 @@',
        ' <?php',
        '+// fix',
        'diff --git a/tests/phpunit/CRM/Queue/SqlTest.php b/tests/phpunit/CRM/Queue/SqlTest.php',
        '--- a/tests/phpunit/CRM/Queue/SqlTest.php',
        '+++ b/tests/phpunit/CRM/Queue/SqlTest.php',
        '@@ -1 +1,2 @@',
        ' <?php',
        '+  public function testClaim(): void {}',
      ].join('\n'),
    ),
    abConfig: AbConfigSchema.parse({ enabled: true, ckCommand: 'ck' }),
    checksConfig: ChecksConfigSchema.parse({ liveProve: false }),
    execFn,
    worktreeBaseDir: join(repoDir, '.worktrees'),
  });
  rmSync(repoDir, { recursive: true, force: true });
  return { outcome, abRun: ckCalls.find((a) => a[1] === 'ab'), imageSha };
}

describe('deriveRegressionTargets excludes PR-modified test files', () => {
  test('excludes PR-modified core extension test and runs unmodified sibling test instead', () => {
    const wtA = makeTempDir();
    mkdirSync(join(wtA, 'ext/afform/core/tests/phpunit'), { recursive: true });
    writeFileSync(join(wtA, 'ext/afform/core/tests/phpunit/AfformSubmitUsageTest.php'), '<?php\n');
    writeFileSync(join(wtA, 'ext/afform/core/tests/phpunit/AfformOtherTest.php'), '<?php\n');

    const diffFiles =
      parseUnifiedDiff(`diff --git a/ext/afform/core/Civi/Afform/Afform.php b/ext/afform/core/Civi/Afform/Afform.php
--- a/ext/afform/core/Civi/Afform/Afform.php
+++ b/ext/afform/core/Civi/Afform/Afform.php
@@ -1,2 +1,3 @@
 <?php
+// fix
diff --git a/ext/afform/core/tests/phpunit/AfformSubmitUsageTest.php b/ext/afform/core/tests/phpunit/AfformSubmitUsageTest.php
--- a/ext/afform/core/tests/phpunit/AfformSubmitUsageTest.php
+++ b/ext/afform/core/tests/phpunit/AfformSubmitUsageTest.php
@@ -1,2 +1,3 @@
 <?php
+// updated assertion
`);

    const targets = deriveRegressionTargets(diffFiles, wtA);
    expect(targets).toEqual(['ext/afform/core/tests/phpunit/AfformOtherTest.php']);
    expect(targets).not.toContain('ext/afform/core/tests/phpunit/AfformSubmitUsageTest.php');
  });

  test('returns empty targets when PR-modified test is the only test in directory', () => {
    const wtA = makeTempDir();
    mkdirSync(join(wtA, 'ext/afform/core/tests/phpunit'), { recursive: true });
    writeFileSync(join(wtA, 'ext/afform/core/tests/phpunit/AfformSubmitUsageTest.php'), '<?php\n');

    const diffFiles =
      parseUnifiedDiff(`diff --git a/ext/afform/core/Civi/Afform/Afform.php b/ext/afform/core/Civi/Afform/Afform.php
--- a/ext/afform/core/Civi/Afform/Afform.php
+++ b/ext/afform/core/Civi/Afform/Afform.php
@@ -1,2 +1,3 @@
 <?php
+// fix
diff --git a/ext/afform/core/tests/phpunit/AfformSubmitUsageTest.php b/ext/afform/core/tests/phpunit/AfformSubmitUsageTest.php
--- a/ext/afform/core/tests/phpunit/AfformSubmitUsageTest.php
+++ b/ext/afform/core/tests/phpunit/AfformSubmitUsageTest.php
@@ -1,2 +1,3 @@
 <?php
+// updated assertion
`);

    expect(deriveRegressionTargets(diffFiles, wtA)).toEqual([]);
  });

  test('excludes PR-modified exact mirror core test and runs unmodified sibling test', () => {
    const wtA = makeTempDir();
    mkdirSync(join(wtA, 'tests/phpunit/CRM/Contact/BAO'), { recursive: true });
    writeFileSync(join(wtA, 'tests/phpunit/CRM/Contact/BAO/QueryTest.php'), '<?php\n');
    writeFileSync(join(wtA, 'tests/phpunit/CRM/Contact/BAO/ContactTest.php'), '<?php\n');

    const diffFiles =
      parseUnifiedDiff(`diff --git a/CRM/Contact/BAO/Query.php b/CRM/Contact/BAO/Query.php
--- a/CRM/Contact/BAO/Query.php
+++ b/CRM/Contact/BAO/Query.php
@@ -1,2 +1,3 @@
 <?php
+// fix
diff --git a/tests/phpunit/CRM/Contact/BAO/QueryTest.php b/tests/phpunit/CRM/Contact/BAO/QueryTest.php
--- a/tests/phpunit/CRM/Contact/BAO/QueryTest.php
+++ b/tests/phpunit/CRM/Contact/BAO/QueryTest.php
@@ -1,2 +1,3 @@
 <?php
+// updated assertion
`);

    const targets = deriveRegressionTargets(diffFiles, wtA);
    expect(targets).toEqual(['tests/phpunit/CRM/Contact/BAO/ContactTest.php']);
  });

  test('wraps multi-target tests with 120s per-target timeout, formats diagnostic tail, and retries transient runner failures', async () => {
    const multi = buildMultiTargetTestCommand('ckcoretest', [
      { path: 'tests/phpunit/CRM/Queue/Queue/SqlParallelTest.php' },
      { path: 'tests/phpunit/CRM/Queue/Queue/SqlTest.php' },
    ]);
    expect(multi[2]).toContain('timeout -k 10 120');
    expect(multi[2]).toContain('_ck_run ckcoretest');

    const tail = formatAbDiagnosticTail(
      'PHPUnit 9.6.0\nFatal error: Unserialization of Closure is not allowed',
      'Network civireview-run-a_default Creating\nContainer civireview-run-a-1 Starting\nError response from daemon: network error',
    );
    expect(tail).not.toContain('Network civireview-run-a_default Creating');
    expect(tail).toContain('Error response from daemon: network error');
    expect(tail).toContain('Fatal error: Unserialization of Closure is not allowed');

    const repoDir = makeTempDir();
    const repoInfo: RepoInfo = {
      kind: 'civicrm-core',
      root: repoDir,
      recommendedImage: 'standalone-master',
    };
    const diffFiles = parseUnifiedDiff(`diff --git a/CRM/Queue/Sql.php b/CRM/Queue/Sql.php
--- a/CRM/Queue/Sql.php
+++ b/CRM/Queue/Sql.php
@@ -1,2 +1,3 @@
 <?php
+// fix
diff --git a/tests/phpunit/CRM/Queue/SqlTest.php b/tests/phpunit/CRM/Queue/SqlTest.php
--- a/tests/phpunit/CRM/Queue/SqlTest.php
+++ b/tests/phpunit/CRM/Queue/SqlTest.php
@@ -1,2 +1,5 @@
 <?php
+  public function testClaim(): void {}
`);

    let ckAbAttempts = 0;
    const execFn: ExecFn = async (args) => {
      if (args[0] === 'docker' && args[1] === 'info') {
        return { exitCode: 0, stdout: 'ok', stderr: '' };
      }
      if (args[0] === 'git' && args[3] === 'worktree' && args[4] === 'add') {
        const target = args[6]!;
        mkdirSync(join(target, 'CRM/Queue'), { recursive: true });
        mkdirSync(join(target, 'tests/phpunit/CRM/Queue'), { recursive: true });
        writeFileSync(join(target, 'CRM/Queue/Sql.php'), '<?php\n');
        writeFileSync(join(target, 'tests/phpunit/CRM/Queue/SqlTest.php'), '<?php\n');
        return { exitCode: 0, stdout: '', stderr: '' };
      }
      if (args[0] === 'ck' && args[1] === 'ab') {
        ckAbAttempts += 1;
        if (ckAbAttempts === 1) {
          return {
            exitCode: 1,
            stdout: '',
            stderr: 'Network civireview_default Creating\nError: transient docker socket reset',
            durationMs: 2500,
          };
        }
        const jsonIdx = args.indexOf('--json');
        writeFileSync(
          args[jsonIdx + 1]!,
          JSON.stringify({
            A: { image: 'standalone-master', core: 'master', status: 124, junit: '' },
            B: { image: 'standalone-master', core: 'master', status: 0, junit: 'b.xml' },
            mode: 'junit',
            groups: {
              regression: [],
              fixed: [],
              both: [],
              gone: [],
              only_on_b: ['CRM_Queue_SqlTest::testClaim'],
              passed_both: [],
            },
            exit_code: 0,
          }),
        );
        return { exitCode: 0, stdout: 'ok', stderr: '' };
      }
      return { exitCode: 0, stdout: '', stderr: '' };
    };

    const outcome = await runCiviKitchenAb({
      repoRoot: repoDir,
      repoInfo,
      baseSha: 'aaaaaaa',
      headSha: 'bbbbbbb',
      diffFiles,
      abConfig: AbConfigSchema.parse({ enabled: true, ckCommand: 'ck' }),
      // No kept stacks: the count covers the proof-of-fix retry only.
      checksConfig: ChecksConfigSchema.parse({ liveProve: false }),
      execFn,
      worktreeBaseDir: join(repoDir, '.worktrees'),
    });

    expect(ckAbAttempts).toBe(2);
    const proof = outcome.abReport.checks.find((c) => c.name === 'proof-of-fix');
    expect(proof?.status).toBe('PASS');
    expect(proof?.fixed).toEqual(['CRM_Queue_SqlTest::testClaim']);
    expect(proof?.summary).toContain('1 test(s) red on A, green on B');
  });

  test('resolveAvailableCivikitchenImage gives a core PR no substitute for its branch image', async () => {
    const probed: string[] = [];
    const execFn: ExecFn = async (args) => {
      probed.push(args.join(' '));
      if (
        args[0] === 'docker' &&
        args[1] === 'manifest' &&
        (args[3] ?? '').endsWith(':standalone-beta')
      ) {
        return { exitCode: 0, stdout: '{}', stderr: '' };
      }
      return { exitCode: 1, stdout: '', stderr: 'No such image' };
    };

    const res = await resolveAvailableCivikitchenImage('standalone-6.21', 'civicrm-core', execFn);
    expect(res).toEqual({ tag: 'standalone-6.21', found: false });
    expect(probed.some((cmd) => cmd.includes(':standalone-beta'))).toBe(false);
  });

  test('resolveAvailableCivikitchenImage names the substitute an extension runs on', async () => {
    const res = await resolveAvailableCivikitchenImage(
      'standalone-6.10',
      'civicrm-extension',
      onlyLatestPublished,
    );
    expect(res).toEqual({ tag: 'standalone-latest', found: true, fallbackFrom: 'standalone-6.10' });
  });

  test('mergeBlastRadius deduplicates per normalized (repo, path) keeping richer impact', () => {
    const merged = mergeBlastRadius([
      [
        {
          repo: 'civicrm-core',
          path: 'CRM/Core/I18n.php',
          symbol: 'CRM_Core_I18n::crm_translate',
          impact: 'Short impact.',
        },
      ],
      [
        {
          repo: 'civicrm-core',
          path: './CRM/Core/I18n.php',
          symbol: 'crm_translate / crm_translate_raw',
          impact: 'Much richer impact description covering raw callers.',
        },
      ],
    ]);
    expect(merged).toHaveLength(1);
    expect(merged[0]?.impact).toContain('Much richer impact');
  });

  test('collectBaseDriftSinceImage diffs the commit a git-built image names against the base', async () => {
    const sha = 'a'.repeat(40);
    const calls: string[][] = [];
    const execFn: ExecFn = async (args) => {
      calls.push(args);
      if (args[0] === 'docker' && args[1] === 'run') {
        return {
          exitCode: 0,
          stdout: `git . ${sha}\ngit packages ${'b'.repeat(40)}\nvendor-sync\n`,
          stderr: '',
        };
      }
      if (args.includes('cat-file')) return { exitCode: 0, stdout: '', stderr: '' };
      if (args.includes('diff')) {
        return { exitCode: 0, stdout: 'CRM/Core/RecentHelper.php\ncomposer.lock\n', stderr: '' };
      }
      return { exitCode: 1, stdout: '', stderr: '' };
    };

    const drift = await collectBaseDriftSinceImage({
      repoRoot: '/tmp/fake-repo',
      baseSha: 'c0ffee',
      imageTag: 'standalone-master',
      execFn,
    });
    expect(drift).toEqual({
      imageCoreRef: sha,
      files: ['CRM/Core/RecentHelper.php', 'composer.lock'],
      vendorSync: true,
    });
    expect(calls.find((a) => a.includes('diff'))).toEqual([
      'git',
      '-C',
      '/tmp/fake-repo',
      'diff',
      '--no-renames',
      '--name-only',
      sha,
      'c0ffee',
    ]);
    expect(calls.some((a) => a.includes('fetch'))).toBe(false);
  });

  test('collectBaseDriftSinceImage fetches the release tag a tarball image was built from', async () => {
    const calls: string[][] = [];
    const execFn: ExecFn = async (args) => {
      calls.push(args);
      if (args[0] === 'docker') {
        return {
          exitCode: 0,
          stdout: 'tarball https://download.civicrm.org/civicrm-6.20.1-standalone.tar.gz\n',
          stderr: '',
        };
      }
      if (args.includes('cat-file')) return { exitCode: 128, stdout: '', stderr: 'missing' };
      if (args.includes('fetch')) return { exitCode: 0, stdout: '', stderr: '' };
      if (args.includes('diff')) return { exitCode: 0, stdout: 'CRM/Utils/Foo.php\n', stderr: '' };
      return { exitCode: 1, stdout: '', stderr: '' };
    };

    const drift = await collectBaseDriftSinceImage({
      repoRoot: '/r',
      baseSha: 'base',
      imageTag: 'standalone-6.20',
      execFn,
    });
    expect(drift).toEqual({
      imageCoreRef: '6.20.1',
      files: ['CRM/Utils/Foo.php'],
      vendorSync: false,
    });
    expect(calls.find((a) => a.includes('fetch'))).toEqual([
      'git',
      '-C',
      '/r',
      'fetch',
      '--no-tags',
      'origin',
      'refs/tags/6.20.1:refs/tags/6.20.1',
    ]);
  });

  test('collectBaseDriftSinceImage leaves files undefined when the image names no core', async () => {
    const drift = await collectBaseDriftSinceImage({
      repoRoot: '/r',
      baseSha: 'base',
      imageTag: 'standalone-master',
      execFn: alwaysFails,
    });
    expect(drift.files).toBeUndefined();
  });

  test('buildCoreMountPlan mounts drifted base directories whole and test files singly', () => {
    const { wtA, wtB } = makeCoreWorktrees();
    const drift = [
      'CRM/Core/RecentHelper.php',
      'CRM/Core/DAO/Removed.php',
      'ext/afform/Recent.php',
      'tests/phpunit/Helper.php',
      'composer.lock',
    ];

    const plan = buildCoreMountPlan(modifiedSqlDiff(), ['CRM'], wtA, wtB, drift);
    expect(plan.useFileMounts).toBe(true);
    const shared = (spec: string) => {
      const i = plan.abMounts.indexOf(spec);
      return (
        i > 0 &&
        plan.abMounts[i - 1] === '--mount' &&
        plan.mountsAOnly.includes(spec) &&
        plan.mountsBOnly.includes(spec)
      );
    };
    expect(shared(`${join(wtA, 'CRM')}:/var/www/html/core/CRM:ro`)).toBe(true);
    expect(shared(`${join(wtA, 'ext/afform')}:/var/www/html/core/ext/afform:ro`)).toBe(true);
    expect(
      shared(
        `${join(wtA, 'tests/phpunit/Helper.php')}:/var/www/html/core/tests/phpunit/Helper.php:ro`,
      ),
    ).toBe(true);
    expect(plan.abMounts).toContain(
      `${join(wtB, 'CRM/Queue/Sql.php')}:/var/www/html/core/CRM/Queue/Sql.php:ro`,
    );
    expect(plan.abMounts.some((m) => m.includes('composer.lock'))).toBe(false);
    expect(plan.abMounts.filter((m) => m.endsWith('/core/CRM:ro'))).toHaveLength(1);
  });

  test('buildCoreMountPlan mounts whole directories when the PR adds a file under a drifted one', () => {
    const { wtA, wtB } = makeCoreWorktrees();
    writeFileSync(join(wtB, 'CRM/Queue/New.php'), '<?php\n');
    const diffFiles = parseUnifiedDiff(
      [
        'diff --git a/CRM/Queue/New.php b/CRM/Queue/New.php',
        'new file mode 100644',
        '--- /dev/null',
        '+++ b/CRM/Queue/New.php',
        '@@ -0,0 +1 @@',
        '+<?php',
      ].join('\n'),
    );

    const plan = buildCoreMountPlan(diffFiles, ['CRM'], wtA, wtB, [
      'CRM/Core/RecentHelper.php',
      'api/v3/Recent.php',
      'tests/phpunit/Helper.php',
    ]);
    expect(plan.useFileMounts).toBe(false);
    expect(plan.abMounts).toContain(`${join(wtA, 'CRM')}:/var/www/html/core/CRM:ro`);
    expect(plan.abMounts).toContain(`${join(wtB, 'CRM')}:/var/www/html/core/CRM:ro`);
    expect(plan.abMounts).toContain(`${join(wtA, 'api')}:/var/www/html/core/api:ro`);
    expect(plan.abMounts.some((m) => m.includes('tests/phpunit/Helper.php'))).toBe(false);
    expect(plan.abMounts.filter((m) => m.startsWith(`${join(wtA, 'CRM')}:`))).toHaveLength(1);
  });

  test('buildCoreMountPlan mounts a drifted extension whole unless it holds build output', () => {
    const { wtA, wtB } = makeCoreWorktrees();
    writeFileSync(join(wtA, 'ext/greenwich/greenwich.php'), '<?php\n');
    const plan = buildCoreMountPlan(modifiedSqlDiff(), ['CRM'], wtA, wtB, [
      'ext/afform/Removed.php',
      'ext/greenwich/greenwich.php',
      'ext/greenwich/Removed.php',
    ]);
    expect(plan.abMounts).toContain(`${join(wtA, 'ext/afform')}:/var/www/html/core/ext/afform:ro`);
    expect(plan.abMounts).toContain(
      `${join(wtA, 'ext/greenwich/greenwich.php')}:/var/www/html/core/ext/greenwich/greenwich.php:ro`,
    );
    expect(plan.abMounts.some((m) => m.endsWith(':/var/www/html/core/ext/greenwich:ro'))).toBe(
      false,
    );
    expect(plan.staleImageFiles).toEqual(['ext/greenwich/Removed.php']);
  });

  test('buildCoreMountPlan mounts every directory the PR changes once it falls back to directories', () => {
    const { wtA, wtB } = makeCoreWorktrees();
    mkdirSync(join(wtA, 'sql'), { recursive: true });
    mkdirSync(join(wtB, 'sql'), { recursive: true });
    writeFileSync(join(wtB, 'sql/new.sql'), '-- new\n');
    const diffFiles = parseUnifiedDiff(
      [
        'diff --git a/sql/new.sql b/sql/new.sql',
        'new file mode 100644',
        '--- /dev/null',
        '+++ b/sql/new.sql',
        '@@ -0,0 +1 @@',
        '+-- new',
      ].join('\n'),
    );
    const plan = buildCoreMountPlan(diffFiles, [], wtA, wtB, ['sql/civicrm_data.tpl']);
    expect(plan.useFileMounts).toBe(false);
    expect(plan.abMounts).toContain(`${join(wtB, 'sql')}:/var/www/html/core/sql:ro`);
    expect(plan.abMounts).toContain(`${join(wtA, 'sql')}:/var/www/html/core/sql:ro`);
    expect(plan.abMounts.filter((m) => m.endsWith('/core/sql:ro'))).toHaveLength(2);
  });

  test('buildCoreMountPlan keeps build-output extensions in directory mode', () => {
    const { wtA, wtB } = makeCoreWorktrees();
    writeFileSync(join(wtA, 'ext/greenwich/greenwich.php'), '<?php\n');
    writeFileSync(join(wtB, 'ext/greenwich/greenwich.php'), '<?php // fix\n');
    writeFileSync(join(wtA, 'ext/greenwich/Old.php'), '<?php\n');
    writeFileSync(join(wtA, 'ext/greenwich/Before.php'), '<?php\n');
    writeFileSync(join(wtB, 'ext/greenwich/After.php'), '<?php\n');
    const extTest = 'ext/greenwich/tests/phpunit/GreenwichTest.php';
    for (const wt of [wtA, wtB]) {
      mkdirSync(join(wt, 'ext/greenwich/tests/phpunit'), { recursive: true });
      writeFileSync(join(wt, extTest), '<?php\n');
    }
    const diffFiles = parseUnifiedDiff(
      [
        'diff --git a/ext/greenwich/greenwich.php b/ext/greenwich/greenwich.php',
        '--- a/ext/greenwich/greenwich.php',
        '+++ b/ext/greenwich/greenwich.php',
        '@@ -1 +1 @@',
        '-<?php',
        '+<?php // fix',
        'diff --git a/ext/greenwich/Old.php b/ext/greenwich/Old.php',
        'deleted file mode 100644',
        '--- a/ext/greenwich/Old.php',
        '+++ /dev/null',
        '@@ -1 +0,0 @@',
        '-<?php',
        'diff --git a/ext/greenwich/Before.php b/ext/greenwich/After.php',
        'similarity index 100%',
        'rename from ext/greenwich/Before.php',
        'rename to ext/greenwich/After.php',
        `diff --git a/${extTest} b/${extTest}`,
        `--- a/${extTest}`,
        `+++ b/${extTest}`,
        '@@ -1 +1,2 @@',
        ' <?php',
        '+  public function testFix(): void {}',
      ].join('\n'),
    );
    const plan = buildCoreMountPlan(diffFiles, ['ext/greenwich'], wtA, wtB, [
      'ext/greenwich/greenwich.php',
      'ext/greenwich/Before.php',
    ]);
    expect(plan.useFileMounts).toBe(false);
    expect(plan.abMounts.some((a) => a.endsWith(':/var/www/html/core/ext/greenwich:ro'))).toBe(
      false,
    );
    const at = (spec: string) => plan.abMounts[plan.abMounts.indexOf(spec) - 1];
    const file = 'ext/greenwich/greenwich.php';
    expect(at(`${join(wtA, file)}:/var/www/html/core/${file}:ro`)).toBe('--mount-a');
    expect(at(`${join(wtB, file)}:/var/www/html/core/${file}:ro`)).toBe('--mount-b');
    expect(plan.abMounts.filter((a) => a.includes(file))).toHaveLength(2);
    expect(plan.prDeletedImageFiles).toEqual(['ext/greenwich/Old.php', 'ext/greenwich/Before.php']);
    const before = 'ext/greenwich/Before.php';
    const after = 'ext/greenwich/After.php';
    expect(at(`${join(wtA, before)}:/var/www/html/core/${before}:ro`)).toBe('--mount-a');
    expect(plan.abMounts.filter((a) => a.endsWith(`/core/${before}:ro`))).toHaveLength(1);
    expect(at(`${join(wtB, after)}:/var/www/html/core/${after}:ro`)).toBe('--mount-b');
    expect(plan.proofTestMounts).toContain(
      `${join(wtB, extTest)}:/var/www/html/core/${extTest}:ro`,
    );
    expect(plan.baseTestMounts).toContain(`${join(wtA, extTest)}:/var/www/html/core/${extTest}:ro`);
  });

  test('buildCoreMountPlan keeps a test-only PR in directory mode side-specific', () => {
    const { wtA, wtB } = makeCoreWorktrees();
    const extTest = 'ext/greenwich/tests/phpunit/GreenwichTest.php';
    for (const wt of [wtA, wtB]) {
      mkdirSync(join(wt, 'ext/greenwich/tests/phpunit'), { recursive: true });
      writeFileSync(join(wt, extTest), '<?php\n');
    }
    writeFileSync(join(wtA, 'ext/greenwich/tests/phpunit/OldTest.php'), '<?php\n');
    const diffFiles = parseUnifiedDiff(
      [
        `diff --git a/${extTest} b/${extTest}`,
        `--- a/${extTest}`,
        `+++ b/${extTest}`,
        '@@ -1 +1,2 @@',
        ' <?php',
        '+  public function testFix(): void {}',
        'diff --git a/ext/greenwich/tests/phpunit/OldTest.php b/ext/greenwich/tests/phpunit/OldTest.php',
        'deleted file mode 100644',
        '--- a/ext/greenwich/tests/phpunit/OldTest.php',
        '+++ /dev/null',
        '@@ -1 +0,0 @@',
        '-<?php',
      ].join('\n'),
    );
    const plan = buildCoreMountPlan(diffFiles, ['ext/greenwich'], wtA, wtB, []);
    expect(plan.useFileMounts).toBe(false);
    const specA = `${join(wtA, extTest)}:/var/www/html/core/${extTest}:ro`;
    const specB = `${join(wtB, extTest)}:/var/www/html/core/${extTest}:ro`;
    for (const mounts of [plan.proofTestMounts, plan.baseTestMounts]) {
      expect(mounts[mounts.indexOf(specA) - 1]).toBe('--mount-a');
      expect(mounts[mounts.indexOf(specB) - 1]).toBe('--mount-b');
      expect(mounts[mounts.indexOf(`${join(wtA, 'tests')}:/var/www/html/core/tests:ro`) - 1]).toBe(
        '--mount-a',
      );
    }
  });

  test('buildCoreMountPlan runs the PR test on both sides of a composer change', () => {
    const { wtA, wtB } = makeCoreWorktrees();
    const testPath = 'tests/phpunit/CRM/Utils/FooTest.php';
    for (const wt of [wtA, wtB]) {
      writeFileSync(join(wt, 'composer.lock'), '{}\n');
      mkdirSync(join(wt, 'tests/phpunit/CRM/Utils'), { recursive: true });
      writeFileSync(join(wt, testPath), '<?php\n');
    }
    const diffFiles = parseUnifiedDiff(
      [
        'diff --git a/composer.lock b/composer.lock',
        '--- a/composer.lock',
        '+++ b/composer.lock',
        '@@ -1 +1 @@',
        '-{}',
        '+{ }',
        `diff --git a/${testPath} b/${testPath}`,
        `--- a/${testPath}`,
        `+++ b/${testPath}`,
        '@@ -1 +1,2 @@',
        ' <?php',
        '+  public function testFoo(): void {}',
      ].join('\n'),
    );
    const plan = buildCoreMountPlan(diffFiles, [], wtA, wtB, []);
    expect(plan.proofTestMounts).toEqual([
      '--mount',
      `${join(wtB, testPath)}:/var/www/html/core/${testPath}:ro`,
    ]);
  });

  test('buildCoreMountPlan gives each side its composer files when the PR changes them', () => {
    const { wtA, wtB } = makeCoreWorktrees();
    for (const wt of [wtA, wtB]) mkdirSync(join(wt, 'tools/scripts/composer'), { recursive: true });
    writeFileSync(join(wtB, 'composer.lock'), '{}\n');
    writeFileSync(join(wtA, 'composer.lock'), '{}\n');
    const diffFiles = parseUnifiedDiff(
      [
        'diff --git a/composer.lock b/composer.lock',
        '--- a/composer.lock',
        '+++ b/composer.lock',
        '@@ -1 +1 @@',
        '-{}',
        '+{ }',
      ].join('\n'),
    );
    const plan = buildCoreMountPlan(diffFiles, [], wtA, wtB, ['composer.lock']);
    const at = (spec: string) => plan.abMounts[plan.abMounts.indexOf(spec) - 1];
    expect(at(`${join(wtA, 'composer.lock')}:/var/www/html/core/composer.lock:ro`)).toBe(
      '--mount-a',
    );
    expect(at(`${join(wtB, 'composer.lock')}:/var/www/html/core/composer.lock:ro`)).toBe(
      '--mount-b',
    );
    expect(at(`${join(wtA, 'composer.json')}:/var/www/html/core/composer.json:ro`)).toBe(
      '--mount-a',
    );
    const scripts = 'tools/scripts/composer';
    expect(at(`${join(wtA, scripts)}:/var/www/html/core/${scripts}:ro`)).toBe('--mount-a');
    expect(at(`${join(wtB, scripts)}:/var/www/html/core/${scripts}:ro`)).toBe('--mount-b');
  });

  test('buildCoreMountPlan names a PR-added extension file the image already has', () => {
    const { wtA, wtB } = makeCoreWorktrees();
    const added = 'ext/greenwich/New.php';
    writeFileSync(join(wtB, added), '<?php\n');
    const diffFiles = parseUnifiedDiff(
      [
        `diff --git a/${added} b/${added}`,
        'new file mode 100644',
        '--- /dev/null',
        `+++ b/${added}`,
        '@@ -0,0 +1 @@',
        '+<?php',
      ].join('\n'),
    );
    const plan = buildCoreMountPlan(diffFiles, ['ext/greenwich'], wtA, wtB, [added]);
    expect(plan.staleImageFiles).toEqual([added]);
  });

  test('buildCoreMountPlan keeps per-file mounts when the base matches the image', () => {
    const { wtA, wtB } = makeCoreWorktrees();
    const plan = buildCoreMountPlan(modifiedSqlDiff(), ['CRM'], wtA, wtB, []);
    expect(plan.useFileMounts).toBe(true);
    expect(plan.abMounts).toEqual([
      '--mount-a',
      `${join(wtA, 'CRM/Queue/Sql.php')}:/var/www/html/core/CRM/Queue/Sql.php:ro`,
      '--mount-b',
      `${join(wtB, 'CRM/Queue/Sql.php')}:/var/www/html/core/CRM/Queue/Sql.php:ro`,
    ]);
  });

  test('runCiviKitchenAb skips A/B and says so when the core branch image is not published', async () => {
    const repoDir = makeTempDir();
    const calls: string[][] = [];
    const execFn: ExecFn = async (args) => {
      calls.push(args);
      if (args[0] === 'docker' && args[1] === 'info')
        return { exitCode: 0, stdout: 'ok', stderr: '' };
      if (args[0] === 'docker') return { exitCode: 1, stdout: '', stderr: 'manifest unknown' };
      return { exitCode: 0, stdout: '', stderr: '' };
    };

    const outcome = await runCiviKitchenAb({
      repoRoot: repoDir,
      repoInfo: { kind: 'civicrm-core', root: repoDir, recommendedImage: 'standalone-6.21' },
      baseSha: 'aaaaaaa',
      headSha: 'bbbbbbb',
      diffFiles: modifiedSqlDiff(),
      abConfig: AbConfigSchema.parse({ enabled: true, ckCommand: 'ck' }),
      execFn,
      worktreeBaseDir: join(repoDir, '.worktrees'),
    });

    expect(outcome.abReport.executed).toBe(false);
    expect(outcome.abReport.imageA).toBe('standalone-6.21');
    expect(outcome.abReport.notVerified).toContain(
      'CiviKitchen image ghcr.io/civico-de/civikitchen:standalone-6.21 is not published; live A/B checks skipped.',
    );
    expect(calls.some((a) => a[0] === 'ck')).toBe(false);
  });

  test('runCiviKitchenAb mounts the base drift and the base composer files', async () => {
    const { outcome, abRun, imageSha } = await runDriftReview(true);
    const civiMount = abRun?.find((a) => a.endsWith(':/var/www/html/core/Civi:ro'));
    expect(civiMount).toContain('/A/Civi:');
    expect(abRun?.[abRun.indexOf(civiMount!) - 1]).toBe('--mount');
    const lockMount = abRun?.find((a) => a.endsWith(':/var/www/html/core/composer.lock:ro'));
    expect(lockMount).toContain('/A/composer.lock:');
    expect(abRun?.[abRun.indexOf(lockMount!) - 1]).toBe('--mount');
    expect(outcome.abReport.notVerified.some((n) => n.includes('Composer'))).toBe(false);
    expect(imageSha).toHaveLength(40);
  });

  test('runCiviKitchenAb names composer drift an image cannot sync', async () => {
    const { outcome } = await runDriftReview(false);
    expect(outcome.abReport.notVerified).toContain(
      "Composer dependencies differ from standalone-master's, which does not sync vendor/ at boot; vendor/ is the image's.",
    );
  });
});
