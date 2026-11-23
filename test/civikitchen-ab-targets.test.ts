import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AbConfigSchema } from '../src/config/schema.ts';
import { formatAbDiagnosticTail } from '../src/evidence/ab/parsers.ts';
import {
  buildMultiTargetTestCommand,
  deriveRegressionTargets,
  isE2eMinkTestPath,
} from '../src/evidence/ab/test-targets.ts';
import { runCiviKitchenAb, type ExecFn } from '../src/evidence/civikitchen-ab.ts';
import { parseUnifiedDiff } from '../src/evidence/diff-filter.ts';
import type { RepoInfo } from '../src/evidence/types.ts';

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

describe('E2E/Mink test exclusion from headless PHPUnit proof-of-fix', () => {
  test('isE2eMinkTestPath identifies core and extension E2E Mink tests', () => {
    expect(isE2eMinkTestPath('tests/phpunit/E2E/Core/LoginTest.php')).toBe(true);
    expect(isE2eMinkTestPath('tests/phpunit/e2e/Core/LoginTest.php')).toBe(true);
    expect(isE2eMinkTestPath('ext/myext/tests/phpunit/E2E/WidgetTest.php')).toBe(true);
    expect(isE2eMinkTestPath('tests/phpunit/CRM/Contact/ContactTest.php')).toBe(false);
    expect(isE2eMinkTestPath('ext/afform/core/tests/phpunit/AfformSubmitUsageTest.php')).toBe(
      false,
    );
  });

  test('skips E2E/Mink-only PR test from proof-of-fix and records notVerified reason', async () => {
    const repoDir = makeTempDir();
    const repoInfo: RepoInfo = {
      kind: 'civicrm-core',
      root: repoDir,
      recommendedImage: 'standalone-master',
    };
    const diffFiles = parseUnifiedDiff(`diff --git a/CRM/Core/Page.php b/CRM/Core/Page.php
--- a/CRM/Core/Page.php
+++ b/CRM/Core/Page.php
@@ -1,2 +1,3 @@
 <?php
+// fix
diff --git a/tests/phpunit/E2E/Core/PageTest.php b/tests/phpunit/E2E/Core/PageTest.php
--- a/tests/phpunit/E2E/Core/PageTest.php
+++ b/tests/phpunit/E2E/Core/PageTest.php
@@ -1,2 +1,5 @@
 <?php
+  public function testPageRender(): void {
+    $this->assertTrue(true);
+  }
`);

    const abCalls: string[][] = [];
    const execFn: ExecFn = async (args) => {
      if (args[0] === 'docker' && args[1] === 'info') {
        return { exitCode: 0, stdout: 'ok', stderr: '' };
      }
      if (args[0] === 'git' && args[3] === 'worktree' && args[4] === 'add') {
        const target = args[6]!;
        mkdirSync(join(target, 'CRM/Core'), { recursive: true });
        mkdirSync(join(target, 'tests/phpunit/E2E/Core'), { recursive: true });
        writeFileSync(join(target, 'CRM/Core/Page.php'), '<?php\n');
        writeFileSync(join(target, 'tests/phpunit/E2E/Core/PageTest.php'), '<?php\n');
        return { exitCode: 0, stdout: '', stderr: '' };
      }
      if (args[0] === 'ck' && args[1] === 'ab') {
        abCalls.push(args);
        return { exitCode: 0, stdout: '', stderr: '' };
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
      execFn,
      worktreeBaseDir: join(repoDir, '.worktrees'),
    });

    expect(outcome.abReport.checks.find((c) => c.name === 'proof-of-fix')).toBeUndefined();
    expect(abCalls.some((a) => a.some((x) => x.includes('tests/phpunit/E2E/')))).toBe(false);
    expect(outcome.abReport.notVerified.some((m) => m.includes('E2E/Mink test file(s)'))).toBe(
      true,
    );
  });

  test('runs unit test in proof-of-fix while excluding E2E/Mink test from same PR', async () => {
    const repoDir = makeTempDir();
    const repoInfo: RepoInfo = {
      kind: 'civicrm-core',
      root: repoDir,
      recommendedImage: 'standalone-master',
    };
    const diffFiles =
      parseUnifiedDiff(`diff --git a/CRM/Contact/BAO/Contact.php b/CRM/Contact/BAO/Contact.php
--- a/CRM/Contact/BAO/Contact.php
+++ b/CRM/Contact/BAO/Contact.php
@@ -1,2 +1,3 @@
 <?php
+// fix
diff --git a/tests/phpunit/E2E/Core/ContactFormTest.php b/tests/phpunit/E2E/Core/ContactFormTest.php
--- a/tests/phpunit/E2E/Core/ContactFormTest.php
+++ b/tests/phpunit/E2E/Core/ContactFormTest.php
@@ -1,2 +1,5 @@
 <?php
+  public function testForm(): void {}
diff --git a/tests/phpunit/CRM/Contact/BAO/ContactTest.php b/tests/phpunit/CRM/Contact/BAO/ContactTest.php
--- a/tests/phpunit/CRM/Contact/BAO/ContactTest.php
+++ b/tests/phpunit/CRM/Contact/BAO/ContactTest.php
@@ -1,2 +1,5 @@
 <?php
+  public function testUnitFix(): void {}
`);

    const abCalls: string[][] = [];
    const execFn: ExecFn = async (args) => {
      if (args[0] === 'docker' && args[1] === 'info') {
        return { exitCode: 0, stdout: 'ok', stderr: '' };
      }
      if (args[0] === 'git' && args[3] === 'worktree' && args[4] === 'add') {
        const target = args[6]!;
        mkdirSync(join(target, 'CRM/Contact/BAO'), { recursive: true });
        mkdirSync(join(target, 'tests/phpunit/E2E/Core'), { recursive: true });
        mkdirSync(join(target, 'tests/phpunit/CRM/Contact/BAO'), {
          recursive: true,
        });
        writeFileSync(join(target, 'CRM/Contact/BAO/Contact.php'), '<?php\n');
        writeFileSync(join(target, 'tests/phpunit/E2E/Core/ContactFormTest.php'), '<?php\n');
        writeFileSync(join(target, 'tests/phpunit/CRM/Contact/BAO/ContactTest.php'), '<?php\n');
        return { exitCode: 0, stdout: '', stderr: '' };
      }
      if (args[0] === 'ck' && args[1] === 'ab') {
        abCalls.push(args);
        const jsonIdx = args.indexOf('--json');
        writeFileSync(
          args[jsonIdx + 1]!,
          JSON.stringify({
            A: { image: 'standalone-master', core: 'master', status: 1, junit: 'a.xml' },
            B: { image: 'standalone-master', core: 'master', status: 0, junit: 'b.xml' },
            mode: 'junit',
            groups: {
              regression: [],
              fixed: ['ContactTest::testUnitFix'],
              both: [],
              gone: [],
              only_on_b: [],
              passed_both: [],
            },
            exit_code: 0,
          }),
        );
        return { exitCode: 0, stdout: '', stderr: '' };
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
      execFn,
      worktreeBaseDir: join(repoDir, '.worktrees'),
    });

    const proofArgs = abCalls[0]!;
    expect(proofArgs).toContain('tests/phpunit/CRM/Contact/BAO/ContactTest.php');
    expect(proofArgs.some((a) => a.includes('ContactFormTest.php'))).toBe(false);
    const proofCheck = outcome.abReport.checks.find((c) => c.name === 'proof-of-fix');
    expect(proofCheck?.fixed).toEqual(['ContactTest::testUnitFix']);
  });
});

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
      execFn,
      worktreeBaseDir: join(repoDir, '.worktrees'),
    });

    expect(ckAbAttempts).toBe(2);
    const proof = outcome.abReport.checks.find((c) => c.name === 'proof-of-fix');
    expect(proof?.status).toBe('PASS');
    expect(proof?.fixed).toEqual(['CRM_Queue_SqlTest::testClaim']);
    expect(proof?.summary).toContain('1 test(s) red on A, green on B');
  });
});
