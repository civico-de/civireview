import { afterEach, describe, expect, test } from 'bun:test';
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AbConfigSchema, ChecksConfigSchema } from '../src/config/schema.ts';
import {
  buildCoreMountPlan,
  devOnlyExtensionRoots,
  isE2eMinkTestPath,
} from '../src/evidence/ab/test-targets.ts';
import { runCiviKitchenAb, type ExecFn } from '../src/evidence/civikitchen-ab.ts';
import { parseUnifiedDiff } from '../src/evidence/diff-filter.ts';
import type { DiffFile, RepoInfo } from '../src/evidence/types.ts';

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'civireview-ab-e2e-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

const coreSpec = (wt: string, p: string) => `${join(wt, p)}:/var/www/html/core/${p}:ro`;

const addedFile = (path: string) => [
  `diff --git a/${path} b/${path}`,
  'new file mode 100644',
  '--- /dev/null',
  `+++ b/${path}`,
  '@@ -0,0 +1 @@',
  '+x',
];

describe('E2E/Mink tests in the core proof-of-fix', () => {
  test('isE2eMinkTestPath identifies core and extension E2E Mink tests', () => {
    expect(isE2eMinkTestPath('tests/phpunit/E2E/Core/LoginTest.php')).toBe(true);
    expect(isE2eMinkTestPath('tests/phpunit/e2e/Core/LoginTest.php')).toBe(true);
    expect(isE2eMinkTestPath('ext/myext/tests/phpunit/E2E/WidgetTest.php')).toBe(true);
    expect(isE2eMinkTestPath('tests/phpunit/CRM/Contact/ContactTest.php')).toBe(false);
    expect(isE2eMinkTestPath('ext/afform/core/tests/phpunit/AfformSubmitUsageTest.php')).toBe(
      false,
    );
  });

  test('runs an E2E-only PR test in proof-of-fix with a browser', async () => {
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

    const proofArgs = abCalls[0]!;
    expect(proofArgs).toContain('--browser');
    const cmd = proofArgs.slice(proofArgs.indexOf('--') + 1);
    expect(cmd.slice(0, 2)).toEqual(['ckcoretest', '--e2e']);
    expect(cmd.at(-1)).toBe('tests/phpunit/E2E/Core/PageTest.php');
    expect(outcome.abReport.notVerified.some((m) => m.includes('E2E/Mink test file(s)'))).toBe(
      false,
    );
  });

  test('with browser checks off, an E2E-only PR runs no proof and names the browser test', async () => {
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
      checksConfig: ChecksConfigSchema.parse({ browser: false }),
      execFn,
      worktreeBaseDir: join(repoDir, '.worktrees'),
    });

    expect(abCalls.some((a) => a.includes('--browser'))).toBe(false);
    expect(outcome.abReport.checks.some((c) => c.name === 'proof-of-fix')).toBe(false);
    expect(
      outcome.abReport.notVerified.some(
        (m) => m.startsWith('Browser checks are off') && m.includes('PageTest.php'),
      ),
    ).toBe(true);
  });

  test('with browser checks off, browser tests leave the target limit to headless ones', async () => {
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
diff --git a/tests/phpunit/E2E/Core/Page1Test.php b/tests/phpunit/E2E/Core/Page1Test.php
--- a/tests/phpunit/E2E/Core/Page1Test.php
+++ b/tests/phpunit/E2E/Core/Page1Test.php
@@ -1,2 +1,3 @@
 <?php
+  public function testPage1(): void {}
diff --git a/tests/phpunit/E2E/Core/Page2Test.php b/tests/phpunit/E2E/Core/Page2Test.php
--- a/tests/phpunit/E2E/Core/Page2Test.php
+++ b/tests/phpunit/E2E/Core/Page2Test.php
@@ -1,2 +1,3 @@
 <?php
+  public function testPage2(): void {}
diff --git a/tests/phpunit/E2E/Core/Page3Test.php b/tests/phpunit/E2E/Core/Page3Test.php
--- a/tests/phpunit/E2E/Core/Page3Test.php
+++ b/tests/phpunit/E2E/Core/Page3Test.php
@@ -1,2 +1,3 @@
 <?php
+  public function testPage3(): void {}
diff --git a/tests/phpunit/E2E/Core/Page4Test.php b/tests/phpunit/E2E/Core/Page4Test.php
--- a/tests/phpunit/E2E/Core/Page4Test.php
+++ b/tests/phpunit/E2E/Core/Page4Test.php
@@ -1,2 +1,3 @@
 <?php
+  public function testPage4(): void {}
diff --git a/tests/phpunit/CRM/Core/PageUnitTest.php b/tests/phpunit/CRM/Core/PageUnitTest.php
--- a/tests/phpunit/CRM/Core/PageUnitTest.php
+++ b/tests/phpunit/CRM/Core/PageUnitTest.php
@@ -1,2 +1,3 @@
 <?php
+  public function testUnit(): void {}
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
        mkdirSync(join(target, 'tests/phpunit/CRM/Core'), { recursive: true });
        for (const k of [1, 2, 3, 4]) {
          writeFileSync(join(target, `tests/phpunit/E2E/Core/Page${k}Test.php`), '<?php\n');
        }
        writeFileSync(join(target, 'tests/phpunit/CRM/Core/PageUnitTest.php'), '<?php\n');
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
      checksConfig: ChecksConfigSchema.parse({ browser: false }),
      execFn,
      worktreeBaseDir: join(repoDir, '.worktrees'),
    });

    expect(abCalls.some((a) => a.includes('--browser'))).toBe(false);
    const proof = abCalls.find((a) => a.some((x) => x.includes('proof-of-fix')))!;
    expect(proof.at(-1)).toBe('tests/phpunit/CRM/Core/PageUnitTest.php');
    expect(
      outcome.abReport.notVerified.some(
        (m) => m.startsWith('Browser checks are off') && m.includes('Page4Test.php'),
      ),
    ).toBe(true);
  });

  test('runs unit and E2E tests of one PR in a single proof-of-fix', async () => {
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
    expect(proofArgs).toContain('--browser');
    const script = proofArgs.at(-1)!;
    expect(script).not.toContain('_ck_run ckcoretest --e2e');
    expect(script).toContain(
      "ckcoretest --e2e --log-junit /tmp/ck-ab-part-0.xml '--filter' '/(^|::)(testForm)(\\s|$)/' 'tests/phpunit/E2E/Core/ContactFormTest.php'",
    );
    expect(script).toContain(
      "_ck_run ckcoretest --log-junit /tmp/ck-ab-part-1.xml '--filter' '/(^|::)(testUnitFix)(\\s|$)/' 'tests/phpunit/CRM/Contact/BAO/ContactTest.php'",
    );
    const proofCheck = outcome.abReport.checks.find((c) => c.name === 'proof-of-fix');
    expect(proofCheck?.fixed).toEqual(['ContactTest::testUnitFix']);
  });

  test('without ck ab --browser runs the unit tests alone and names the browser tests', async () => {
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
        if (args.includes('--browser')) {
          return { exitCode: 2, stdout: '', stderr: 'ck ab: unknown option --browser' };
        }
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

    const proofRuns = abCalls.filter(
      (a) => a.includes('--name') && a.some((x) => x.includes('proof-of-fix')),
    );
    expect(proofRuns.at(-1)).not.toContain('--browser');
    expect(proofRuns.at(-1)!.at(-1)).toBe('tests/phpunit/CRM/Contact/BAO/ContactTest.php');
    expect(
      outcome.abReport.notVerified.some(
        (m) => m.includes('no `ck ab --browser`') && m.includes('ContactFormTest.php'),
      ),
    ).toBe(true);
    const proofChecks = outcome.abReport.checks.filter((c) => c.name === 'proof-of-fix');
    expect(proofChecks).toHaveLength(1);
    expect(proofChecks[0]?.fixed).toEqual(['ContactTest::testUnitFix']);
  });
});

const DEV_ONLY_INFO =
  '<extension key="org.example.mock"><description>(DEVELOPMENT ONLY) Example forms</description></extension>';

/** afform core plus its development-only mock extension; the PR adds a mock form and its browser test. */
function makeMockWorktrees(): { wtA: string; wtB: string } {
  const root = makeTempDir();
  const wtA = join(root, 'A');
  const wtB = join(root, 'B');
  for (const wt of [wtA, wtB]) {
    mkdirSync(join(wt, 'ext/afform/core/ang'), { recursive: true });
    mkdirSync(join(wt, 'ext/afform/mock/ang'), { recursive: true });
    writeFileSync(
      join(wt, 'ext/afform/core/info.xml'),
      '<extension><description>Forms</description></extension>',
    );
    writeFileSync(join(wt, 'ext/afform/core/ang/afJoin.js'), '// join\n');
    writeFileSync(join(wt, 'ext/afform/mock/info.xml'), DEV_ONLY_INFO);
    writeFileSync(join(wt, 'composer.json'), '{}');
    writeFileSync(join(wt, 'ext/afform/mock/ang/mockOld.aff.html'), '<af-form />\n');
  }
  writeFileSync(join(wtA, 'ext/afform/core/Old.php'), '<?php\n');
  mkdirSync(join(wtB, 'ext/afform/mock/tests/phpunit/E2E'), { recursive: true });
  writeFileSync(join(wtB, 'ext/afform/mock/ang/mockJoin.aff.html'), '<af-form />\n');
  writeFileSync(join(wtB, 'ext/afform/mock/tests/phpunit/E2E/MockJoinTest.php'), '<?php\n');
  return { wtA, wtB };
}

function mockPrDiff(withDeletion: boolean): DiffFile[] {
  return parseUnifiedDiff(
    [
      'diff --git a/ext/afform/core/ang/afJoin.js b/ext/afform/core/ang/afJoin.js',
      '--- a/ext/afform/core/ang/afJoin.js',
      '+++ b/ext/afform/core/ang/afJoin.js',
      '@@ -1 +1 @@',
      '-// join',
      '+// fixed join',
      ...addedFile('ext/afform/mock/ang/mockJoin.aff.html'),
      ...addedFile('ext/afform/mock/tests/phpunit/E2E/MockJoinTest.php'),
      ...(withDeletion
        ? [
            'diff --git a/ext/afform/core/Old.php b/ext/afform/core/Old.php',
            'deleted file mode 100644',
            '--- a/ext/afform/core/Old.php',
            '+++ /dev/null',
            '@@ -1 +0,0 @@',
            '-<?php',
          ]
        : []),
    ].join('\n'),
  );
}

describe('development-only extension fixtures', () => {
  const MOCK = 'ext/afform/mock';
  const fixRoot = (wt: string, root: string) => `${join(wt, root)}:/var/www/html/core/${root}:ro`;
  const flagOf = (mounts: string[], spec: string) => mounts[mounts.indexOf(spec) - 1];
  const prodChange = [
    'diff --git a/ext/afform/core/ang/afJoin.js b/ext/afform/core/ang/afJoin.js',
    '--- a/ext/afform/core/ang/afJoin.js',
    '+++ b/ext/afform/core/ang/afJoin.js',
    '@@ -1 +1 @@',
    '-// join',
    '+// fixed join',
  ];
  const deleted = (path: string, line: string) => [
    `diff --git a/${path} b/${path}`,
    'deleted file mode 100644',
    `--- a/${path}`,
    '+++ /dev/null',
    '@@ -1 +0,0 @@',
    `-${line}`,
  ];

  test('devOnlyExtensionRoots finds the root of the extension the nearest info.xml declares', () => {
    const { wtA, wtB } = makeMockWorktrees();
    const rootOf = devOnlyExtensionRoots(wtA, wtB);
    expect(rootOf('ext/afform/mock/ang/mockJoin.aff.html')).toBe(MOCK);
    expect(rootOf('ext/afform/core/ang/afJoin.js')).toBeNull();
    expect(rootOf('ext/unknown/x.php')).toBeNull();
    expect(rootOf('CRM/Core/Page.php')).toBeNull();
  });

  test('file mounts give both sides the PR fixture and browser test, A keeps its own core file', () => {
    const { wtA, wtB } = makeMockWorktrees();
    const plan = buildCoreMountPlan(mockPrDiff(false), ['ext/afform'], wtA, wtB);
    expect(plan.useFileMounts).toBe(true);
    for (const p of [
      'ext/afform/mock/ang/mockJoin.aff.html',
      'ext/afform/mock/tests/phpunit/E2E/MockJoinTest.php',
    ]) {
      expect(flagOf(plan.proofTestMounts, coreSpec(wtB, p))).toBe('--mount');
      expect(plan.abMounts.some((m) => m.includes(p))).toBe(false);
    }
    expect(plan.abMounts).toContain(coreSpec(wtA, 'ext/afform/core/ang/afJoin.js'));
    expect(plan.unmatchedTestFiles).toEqual([]);
  });

  test('inside a directory A mounts from the base, B lays its extension over A once', () => {
    const { wtA, wtB } = makeMockWorktrees();
    const plan = buildCoreMountPlan(mockPrDiff(true), ['ext/afform'], wtA, wtB);
    expect(plan.useFileMounts).toBe(false);
    expect(plan.unmatchedTestFiles).toEqual([]);
    expect(flagOf(plan.proofTestMounts, fixRoot(wtB, MOCK))).toBe('--mount-a');
    expect(plan.proofTestMounts.filter((m) => m === fixRoot(wtB, MOCK))).toHaveLength(1);
    expect(plan.baseTestMounts).not.toContain(fixRoot(wtB, MOCK));
  });

  test('a fixture the PR deletes inside a directory A mounts from the base goes with the overlay', () => {
    const { wtA, wtB } = makeMockWorktrees();
    const p = 'ext/afform/mock/ang/mockOld.aff.html';
    rmSync(join(wtB, p));
    const diff = parseUnifiedDiff([...prodChange, ...deleted(p, '<af-form />')].join('\n'));
    const plan = buildCoreMountPlan(diff, ['ext/afform'], wtA, wtB);
    expect(plan.unmatchedTestFiles).toEqual([]);
    expect(flagOf(plan.proofTestMounts, fixRoot(wtB, MOCK))).toBe('--mount-a');
  });

  test('a regular extension lays its tests directory over A', () => {
    const { wtA, wtB } = makeMockWorktrees();
    const t = 'ext/afform/core/tests/phpunit/E2E/JoinTest.php';
    for (const wt of [wtA, wtB]) mkdirSync(join(wt, 'ext/afform/core/tests'), { recursive: true });
    mkdirSync(join(wtB, 'ext/afform/core/tests/phpunit/E2E'), { recursive: true });
    writeFileSync(join(wtB, t), '<?php\n');
    const diff = parseUnifiedDiff(
      [...prodChange, ...addedFile(t), ...deleted('ext/afform/core/Old.php', '<?php')].join('\n'),
    );
    const plan = buildCoreMountPlan(diff, ['ext/afform'], wtA, wtB);
    expect(plan.unmatchedTestFiles).toEqual([]);
    expect(flagOf(plan.proofTestMounts, fixRoot(wtB, 'ext/afform/core/tests'))).toBe('--mount-a');
  });

  test('a test whose overlay root A lacks is unmatched', () => {
    const { wtA, wtB } = makeMockWorktrees();
    rmSync(join(wtA, MOCK), { recursive: true });
    const plan = buildCoreMountPlan(mockPrDiff(true), ['ext/afform'], wtA, wtB);
    expect(plan.unmatchedTestFiles).toEqual([
      'ext/afform/mock/ang/mockJoin.aff.html',
      'ext/afform/mock/tests/phpunit/E2E/MockJoinTest.php',
    ]);
  });

  test('fixtures inside a directory both sides mount from the base for drift are overlaid on both', () => {
    const { wtA, wtB } = makeMockWorktrees();
    for (const wt of [wtA, wtB]) {
      mkdirSync(join(wt, 'CRM'), { recursive: true });
      writeFileSync(join(wt, 'CRM/Foo.php'), '<?php\n');
    }
    writeFileSync(join(wtA, 'CRM/Old.php'), '<?php\n');
    const diff = parseUnifiedDiff(
      [
        'diff --git a/CRM/Foo.php b/CRM/Foo.php',
        '--- a/CRM/Foo.php',
        '+++ b/CRM/Foo.php',
        '@@ -1 +1,2 @@',
        ' <?php',
        '+// fix',
        ...deleted('CRM/Old.php', '<?php'),
        ...addedFile('ext/afform/mock/ang/mockJoin.aff.html'),
      ].join('\n'),
    );
    const plan = buildCoreMountPlan(diff, ['CRM'], wtA, wtB, ['ext/afform/core/ang/afJoin.js']);
    expect(plan.useFileMounts).toBe(false);
    expect(plan.abMounts).toContain(fixRoot(wtA, 'ext/afform'));
    expect(plan.unmatchedTestFiles).toEqual([]);
    expect(flagOf(plan.proofTestMounts, fixRoot(wtB, MOCK))).toBe('--mount');
  });

  test('a file the PR deletes outside every mounted directory brings its overlay root from each side', () => {
    const { wtA, wtB } = makeMockWorktrees();
    for (const wt of [wtA, wtB]) {
      mkdirSync(join(wt, 'CRM'), { recursive: true });
      writeFileSync(join(wt, 'CRM/Foo.php'), '<?php\n');
    }
    writeFileSync(join(wtA, 'CRM/Old.php'), '<?php\n');
    const p = 'ext/afform/mock/ang/mockOld.aff.html';
    rmSync(join(wtB, p));
    const support = 'ext/afform/core/tests/phpunit/fixtures/join.json';
    mkdirSync(join(wtA, 'ext/afform/core/tests/phpunit/fixtures'), { recursive: true });
    mkdirSync(join(wtB, 'ext/afform/core/tests/phpunit'), { recursive: true });
    writeFileSync(join(wtA, support), '{}');
    const diff = parseUnifiedDiff(
      [
        'diff --git a/CRM/Foo.php b/CRM/Foo.php',
        '--- a/CRM/Foo.php',
        '+++ b/CRM/Foo.php',
        '@@ -1 +1,2 @@',
        ' <?php',
        '+// fix',
        ...deleted('CRM/Old.php', '<?php'),
        ...deleted(p, '<af-form />'),
        ...deleted(support, '{}'),
      ].join('\n'),
    );
    const plan = buildCoreMountPlan(diff, ['CRM'], wtA, wtB);
    expect(plan.useFileMounts).toBe(false);
    expect(plan.unmatchedTestFiles).toEqual([]);
    for (const root of [MOCK, 'ext/afform/core/tests']) {
      expect(flagOf(plan.proofTestMounts, fixRoot(wtB, root))).toBe('--mount');
      expect(flagOf(plan.baseTestMounts, fixRoot(wtA, root))).toBe('--mount');
    }
  });

  test('a new test of a regular extension outside every mounted directory is mounted on its own', () => {
    const { wtA, wtB } = makeMockWorktrees();
    for (const wt of [wtA, wtB]) {
      mkdirSync(join(wt, 'CRM'), { recursive: true });
      writeFileSync(join(wt, 'CRM/Foo.php'), '<?php\n');
    }
    writeFileSync(join(wtA, 'CRM/Old.php'), '<?php\n');
    const t = 'ext/afform/core/tests/phpunit/E2E/JoinTest.php';
    mkdirSync(join(wtB, 'ext/afform/core/tests/phpunit/E2E'), { recursive: true });
    writeFileSync(join(wtB, t), '<?php\n');
    const diff = parseUnifiedDiff(
      [
        'diff --git a/CRM/Foo.php b/CRM/Foo.php',
        '--- a/CRM/Foo.php',
        '+++ b/CRM/Foo.php',
        '@@ -1 +1,2 @@',
        ' <?php',
        '+// fix',
        ...deleted('CRM/Old.php', '<?php'),
        ...addedFile(t),
      ].join('\n'),
    );
    const plan = buildCoreMountPlan(diff, ['CRM'], wtA, wtB);
    expect(plan.useFileMounts).toBe(false);
    expect(plan.unmatchedTestFiles).toEqual([]);
    expect(flagOf(plan.proofTestMounts, coreSpec(wtB, t))).toBe('--mount');
  });

  test('a fixture the PR deletes from an extension mounted file by file is unmatched', () => {
    const { wtA, wtB } = makeMockWorktrees();
    writeFileSync(join(wtA, 'ext/afform/composer.compile.json'), '{}');
    const p = 'ext/afform/mock/ang/mockOld.aff.html';
    rmSync(join(wtB, p));
    const diff = parseUnifiedDiff([...prodChange, ...deleted(p, '<af-form />')].join('\n'));
    const plan = buildCoreMountPlan(diff, ['ext/afform'], wtA, wtB);
    expect(plan.unmatchedTestFiles).toEqual([p]);
  });
});

describe('proof of fix with unmatched test files', () => {
  test('is not run, and the reason is named', async () => {
    const repoDir = makeTempDir();
    const { wtA, wtB } = makeMockWorktrees();
    rmSync(join(wtA, 'ext/afform/mock'), { recursive: true });
    const repoInfo: RepoInfo = {
      kind: 'civicrm-core',
      root: repoDir,
      recommendedImage: 'standalone-master',
    };
    const abCalls: string[][] = [];
    const execFn: ExecFn = async (args) => {
      if (args[0] === 'git' && args[3] === 'worktree' && args[4] === 'add') {
        cpSync(args.includes('bbbbbbb') ? wtB : wtA, args[6]!, { recursive: true });
        mkdirSync(join(args[6]!, 'tests'), { recursive: true });
      }
      if (args[0] === 'ck' && args[1] === 'ab') abCalls.push(args);
      return { exitCode: 0, stdout: 'ok', stderr: '' };
    };

    const outcome = await runCiviKitchenAb({
      repoRoot: repoDir,
      repoInfo,
      baseSha: 'aaaaaaa',
      headSha: 'bbbbbbb',
      diffFiles: mockPrDiff(true),
      abConfig: AbConfigSchema.parse({ enabled: true, ckCommand: 'ck' }),
      execFn,
      worktreeBaseDir: join(repoDir, '.worktrees'),
    });

    expect(abCalls.some((a) => a.some((x) => x.includes('proof-of-fix')))).toBe(false);
    expect(outcome.abReport.checks.some((c) => c.name === 'proof-of-fix')).toBe(false);
    expect(
      outcome.abReport.notVerified.some(
        (m) => m.startsWith('Proof of fix not run') && m.includes('MockJoinTest.php'),
      ),
    ).toBe(true);
  });
});

describe('fixtures are not production changes', () => {
  test('a new test of a fixture-only PR that passes on both sides is not tautological', async () => {
    const repoDir = makeTempDir();
    const { wtA, wtB } = makeMockWorktrees();
    const t = 'ext/afform/mock/tests/phpunit/api/v4/Afform/MockJoinUsageTest.php';
    for (const wt of [wtA, wtB]) {
      mkdirSync(join(wt, 'ext/afform/mock/tests/phpunit/api/v4/Afform'), { recursive: true });
      writeFileSync(join(wt, t), '<?php\n');
    }
    const diffFiles = parseUnifiedDiff(
      [
        ...addedFile('ext/afform/mock/ang/mockJoin.aff.html'),
        `diff --git a/${t} b/${t}`,
        `--- a/${t}`,
        `+++ b/${t}`,
        '@@ -1,1 +1,4 @@',
        ' <?php',
        '+  public function testJoinLoads(): void {',
        '+    $this->assertTrue(true);',
        '+  }',
      ].join('\n'),
    );
    const execFn: ExecFn = async (args) => {
      if (args[0] === 'git' && args[3] === 'worktree' && args[4] === 'add') {
        cpSync(args.includes('bbbbbbb') ? wtB : wtA, args[6]!, { recursive: true });
      }
      if (args[0] === 'ck' && args[1] === 'ab') {
        writeFileSync(
          args[args.indexOf('--json') + 1]!,
          JSON.stringify({
            A: { image: 'standalone-master', core: 'master', status: 0, junit: 'a.xml' },
            B: { image: 'standalone-master', core: 'master', status: 0, junit: 'b.xml' },
            mode: 'junit',
            groups: {
              regression: [],
              fixed: [],
              both: [],
              gone: [],
              only_on_b: [],
              passed_both: ['MockJoinUsageTest::testJoinLoads'],
            },
            exit_code: 0,
          }),
        );
      }
      return { exitCode: 0, stdout: 'ok', stderr: '' };
    };

    const outcome = await runCiviKitchenAb({
      repoRoot: repoDir,
      repoInfo: { kind: 'civicrm-core', root: repoDir, recommendedImage: 'standalone-master' },
      baseSha: 'aaaaaaa',
      headSha: 'bbbbbbb',
      diffFiles,
      abConfig: AbConfigSchema.parse({ enabled: true, ckCommand: 'ck' }),
      execFn,
      worktreeBaseDir: join(repoDir, '.worktrees'),
    });

    const proof = outcome.abReport.checks.find((c) => c.name === 'proof-of-fix');
    expect(proof).toBeDefined();
    expect(proof!.tautologicalTests ?? []).toEqual([]);
  });
});
