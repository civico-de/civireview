import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  AbConfigSchema,
  BrowserConfigSchema,
  ChecksConfigSchema,
  ReviewSettingsSchema,
} from '../src/config/schema.ts';
import {
  buildMultiTargetTestCommand,
  parseCkAbJsonReport,
  runCiviKitchenAb,
  type ExecFn,
} from '../src/evidence/civikitchen-ab.ts';
import { parseUnifiedDiff } from '../src/evidence/diff-filter.ts';
import type { EvidenceBundle, RepoInfo } from '../src/evidence/types.ts';
import { buildSharedEvidencePrefix } from '../src/prompts/shared.ts';

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'civireview-ckab-test-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

describe('civikitchen-ab Phase 1 JSON & surface support', () => {
  test('parseCkAbJsonReport parses structured groups, counts, and surface_diff', () => {
    const raw = JSON.stringify({
      A: { image: 'standalone', core: '6.16.0', status: 1, junit: '/tmp/a.xml' },
      B: { image: 'standalone', core: '6.16.0', status: 0, junit: '/tmp/b.xml' },
      mode: 'junit',
      groups: {
        regression: [],
        fixed: ['CRM_Contact_Test::testFix'],
        both: [],
        gone: [],
        only_on_b: ['CRM_Contact_Test::testNew'],
        passed_both: ['CRM_Contact_Test::testExisting'],
      },
      counts: { a: 10, b: 11, regression: 0, fixed: 1, both: 0, gone: 0, only_on_b: 1 },
      exit_code: 0,
      surface_diff: {
        api4: { added: [{ name: 'Contact.getFoo' }], removed: [], changed: [] },
        api3: { added: [], removed: [], changed: [] },
        routes: { added: [], removed: [], changed: [] },
        afform: { added: [], removed: [], changed: [] },
        risk_flags: [
          {
            code: 'UNAUTH_API4',
            severity: 'high',
            category: 'api4',
            target: 'Contact.getFoo',
            reason: 'checkPermissions=false exposed',
          },
        ],
        counts: { risk_flags: 1 },
      },
    });

    const parsed = parseCkAbJsonReport(raw);
    expect(parsed.mode).toBe('junit');
    expect(parsed.exitCodeA).toBe(1);
    expect(parsed.exitCodeB).toBe(0);
    expect(parsed.fixed).toEqual(['CRM_Contact_Test::testFix']);
    expect(parsed.onlyOnB).toEqual(['CRM_Contact_Test::testNew']);
    expect(parsed.passedBoth).toEqual(['CRM_Contact_Test::testExisting']);
    expect(parsed.surfaceDiff?.risk_flags).toHaveLength(1);
  });

  test('runCiviKitchenAb passes --json and --surface and reads ab-report.json', async () => {
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
diff --git a/tests/phpunit/CRM/Contact/ContactTest.php b/tests/phpunit/CRM/Contact/ContactTest.php
--- a/tests/phpunit/CRM/Contact/ContactTest.php
+++ b/tests/phpunit/CRM/Contact/ContactTest.php
@@ -1,2 +1,3 @@
 <?php
+// test
`);

    const invocations: string[][] = [];
    const execFn: ExecFn = async (args) => {
      invocations.push(args);
      if (args[0] === 'docker' && args[1] === 'info') {
        return { exitCode: 0, stdout: 'ok', stderr: '' };
      }
      if (args[0] === 'git' && args[3] === 'worktree' && args[4] === 'add') {
        const target = args[6]!;
        mkdirSync(join(target, 'CRM'), { recursive: true });
        mkdirSync(join(target, 'tests/phpunit/CRM/Contact'), { recursive: true });
        writeFileSync(join(target, 'tests/phpunit/CRM/Contact/ContactTest.php'), '<?php\n');
        return { exitCode: 0, stdout: '', stderr: '' };
      }
      if (args[0] === 'ck' && args[1] === 'ab') {
        const jsonIdx = args.indexOf('--json');
        expect(jsonIdx).toBeGreaterThan(-1);
        expect(args).toContain('--surface');
        const jsonPath = args[jsonIdx + 1]!;
        writeFileSync(
          jsonPath,
          JSON.stringify({
            A: { image: 'standalone-master', core: 'master', status: 1, junit: 'a.xml' },
            B: { image: 'standalone-master', core: 'master', status: 0, junit: 'b.xml' },
            mode: 'junit',
            groups: {
              regression: [],
              fixed: ['ContactTest::testFix'],
              both: [],
              gone: [],
              only_on_b: [],
            },
            counts: { a: 1, b: 1, regression: 0, fixed: 1, both: 0, gone: 0, only_on_b: 0 },
            exit_code: 0,
            surface_diff: {
              api4: { added: [], removed: [], changed: [] },
              api3: { added: [], removed: [], changed: [] },
              routes: { added: [], removed: [], changed: [] },
              afform: { added: [], removed: [], changed: [] },
              risk_flags: [
                {
                  code: 'ROUTE_PUBLIC',
                  severity: 'medium',
                  category: 'routes',
                  target: 'civicrm/foo',
                  reason: 'access_arguments changed',
                },
              ],
              counts: { risk_flags: 1 },
            },
          }),
          'utf8',
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

    expect(outcome.abReport.executed).toBe(true);
    expect(outcome.abReport.checks[0]?.fixed).toEqual(['ContactTest::testFix']);
    expect(outcome.abReport.surfaceDiff.liveSurfaceDiff?.risk_flags).toHaveLength(1);
    expect(outcome.abReport.surfaceDiff.changes.some((c) => c.path === 'civicrm/foo')).toBe(true);
  });

  test('falls back cleanly to stdout parsing when older ck ab rejects --json/--surface', async () => {
    const repoDir = makeTempDir();
    const repoInfo: RepoInfo = {
      kind: 'civicrm-core',
      root: repoDir,
      recommendedImage: 'standalone-master',
    };
    const diffFiles =
      parseUnifiedDiff(`diff --git a/tests/phpunit/CRM/Contact/ContactTest.php b/tests/phpunit/CRM/Contact/ContactTest.php
--- a/tests/phpunit/CRM/Contact/ContactTest.php
+++ b/tests/phpunit/CRM/Contact/ContactTest.php
@@ -1,2 +1,3 @@
 <?php
+// test
`);

    let abCalls = 0;
    const execFn: ExecFn = async (args) => {
      if (args[0] === 'docker' && args[1] === 'info') {
        return { exitCode: 0, stdout: 'ok', stderr: '' };
      }
      if (args[0] === 'git' && args[3] === 'worktree' && args[4] === 'add') {
        const target = args[6]!;
        mkdirSync(join(target, 'tests/phpunit/CRM/Contact'), { recursive: true });
        return { exitCode: 0, stdout: '', stderr: '' };
      }
      if (args[0] === 'ck' && args[1] === 'ab') {
        abCalls++;
        if (args.includes('--json')) {
          return { exitCode: 2, stdout: '', stderr: 'unknown option: --json' };
        }
        return {
          exitCode: 0,
          stdout: [
            'ck ab: A standalone-master (6.16): exit 1',
            'ck ab: B standalone-master (6.16): exit 0',
            'ck ab: fail on A, pass on B: 1',
            '  ContactTest::testLegacyFallback',
          ].join('\n'),
          stderr: '',
        };
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

    expect(abCalls).toBe(2);
    expect(outcome.abReport.checks[0]?.fixed).toEqual(['ContactTest::testLegacyFallback']);
  });

  test('extension proof-of-fix mounts B test file into A, computes ck taint A-vs-B delta, and runs Standalone browser A/B + screenshot copy', async () => {
    const repoDir = makeTempDir();
    const outDir = join(repoDir, 'evidence-out');
    const repoInfo: RepoInfo = {
      kind: 'civicrm-extension',
      root: repoDir,
      extensionKey: 'org.example.myext',
      extensionName: 'myext',
      recommendedImage: 'standalone',
    };

    const diffFiles =
      parseUnifiedDiff(`diff --git a/tests/phpunit/CRM/MyExt/FixTest.php b/tests/phpunit/CRM/MyExt/FixTest.php
new file mode 100644
--- /dev/null
+++ b/tests/phpunit/CRM/MyExt/FixTest.php
@@ -0,0 +1,5 @@
+<?php
+class FixTest {}
diff --git a/ang/afsearchMyExt.aff.json b/ang/afsearchMyExt.aff.json
new file mode 100644
--- /dev/null
+++ b/ang/afsearchMyExt.aff.json
@@ -0,0 +1,4 @@
+{
+  "server_route": "civicrm/myext/public-view",
+  "is_public": true
+}
diff --git a/CRM/MyExt/Upgrader.php b/CRM/MyExt/Upgrader.php
--- a/CRM/MyExt/Upgrader.php
+++ b/CRM/MyExt/Upgrader.php
@@ -1,2 +1,3 @@
 <?php
+// upgrade
`);

    const invocations: string[][] = [];
    let worktreeAPath = '';
    let worktreeBPath = '';

    const execFn: ExecFn = async (args) => {
      invocations.push(args);
      if (args[0] === 'docker' && args[1] === 'info') {
        return { exitCode: 0, stdout: 'ok', stderr: '' };
      }
      if (args[0] === 'git' && args[3] === 'worktree' && args[4] === 'add') {
        const target = args[6]!;
        const ref = args[7]!;
        mkdirSync(join(target, 'CRM/MyExt'), { recursive: true });
        if (ref === 'aaaaaaa') {
          worktreeAPath = target;
        } else {
          worktreeBPath = target;
          mkdirSync(join(target, 'tests/phpunit/CRM/MyExt'), { recursive: true });
          writeFileSync(
            join(target, 'tests/phpunit/CRM/MyExt/FixTest.php'),
            '<?php\nclass FixTest {}\n',
          );
        }
        return { exitCode: 0, stdout: '', stderr: '' };
      }
      if (args[0] === 'ck' && args[1] === 'ab') {
        const outIdx = args.indexOf('--out');
        const subOut = args[outIdx + 1]!;
        const jsonIdx = args.indexOf('--json');
        const jsonPath = args[jsonIdx + 1]!;

        if (args.includes('--page')) {
          const shotsDir = join(subOut, 'shots');
          mkdirSync(shotsDir, { recursive: true });
          const beforePng = join(shotsDir, 'before.png');
          const afterPng = join(shotsDir, 'after.png');
          writeFileSync(beforePng, Buffer.from('PNG_BEFORE'));
          writeFileSync(afterPng, Buffer.from('PNG_AFTER'));

          writeFileSync(
            join(subOut, 'browser-diff.json'),
            JSON.stringify({
              new_console_errors: ['TypeError: undefined is not a function'],
              new_page_errors: [],
              new_network_failures: [],
              new_a11y_violations: [],
              render_regressions: [],
              screenshots: [
                {
                  route: 'civicrm/myext/public-view',
                  mode: 'anonymous',
                  before: 'shots/before.png',
                  after: 'shots/after.png',
                },
              ],
              risk_flags: [],
              urls: {
                A: 'http://127.0.0.1:41001',
                B: 'http://127.0.0.1:41002',
              },
            }),
          );
          return {
            exitCode: 0,
            stdout: 'A_URL=http://127.0.0.1:41001\nB_URL=http://127.0.0.1:41002\n',
            stderr: '',
          };
        }

        writeFileSync(
          jsonPath,
          JSON.stringify({
            A: { image: 'standalone', core: '6.16', status: 1, junit: 'a.xml' },
            B: { image: 'standalone', core: '6.16', status: 0, junit: 'b.xml' },
            mode: 'junit',
            groups: {
              regression: [],
              fixed: ['FixTest::testBug'],
              both: [],
              gone: [],
              only_on_b: [],
            },
            exit_code: 0,
          }),
        );
        return { exitCode: 0, stdout: '', stderr: '' };
      }
      if (args[0] === 'ck' && args[1] === 'run' && args.includes('taint')) {
        const mountVal = args[args.indexOf('--mount') + 1] ?? '';
        if (mountVal.startsWith(worktreeAPath)) {
          return {
            exitCode: 1,
            stdout: 'CRM/MyExt/Old.php:10: Pre-existing taint warning\n',
            stderr: '',
          };
        }
        return {
          exitCode: 1,
          stdout:
            'CRM/MyExt/Old.php:10: Pre-existing taint warning\n' +
            'CRM/MyExt/New.php:25: New SQL injection taint on head\n',
          stderr: '',
        };
      }
      if (args[0] === 'ck' && args[1] === 'run' && args.includes('lifecycle')) {
        return { exitCode: 0, stdout: 'ok', stderr: '' };
      }
      if (args[0] === 'ck' && args[1] === 'run' && args.includes('schema')) {
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
      abConfig: AbConfigSchema.parse({ enabled: true, ckCommand: 'ck', liveProve: true }),
      checksConfig: ChecksConfigSchema.parse({ a11y: false, liveProve: true }),
      browserConfig: BrowserConfigSchema.parse({}),
      reviewConfig: ReviewSettingsSchema.parse({}),
      outputDir: outDir,
      execFn,
      worktreeBaseDir: join(repoDir, '.worktrees'),
    });

    try {
      // Proof-of-fix mounted B's test file into Stack A
      const proofCall = invocations.find(
        (a) => a[0] === 'ck' && a[1] === 'ab' && a.some((x) => x.includes('FixTest.php')),
      );
      expect(proofCall).toBeDefined();
      expect(proofCall!.join(' ')).toContain(
        `--mount-a ${join(worktreeBPath, 'tests/phpunit/CRM/MyExt/FixTest.php')}:/var/www/html/ext/myext/tests/phpunit/CRM/MyExt/FixTest.php:ro`,
      );

      // ck taint ran via ck run on both A and B and reported ONLY the new finding on B
      const taintCalls = invocations.filter(
        (a) => a[0] === 'ck' && a[1] === 'run' && a.includes('taint'),
      );
      expect(taintCalls).toHaveLength(2);
      expect(outcome.staticDelta.toolsRun).toEqual(['cktaint', 'cklifecycle', 'ckschema']);
      expect(outcome.staticDelta.findings).toHaveLength(1);
      expect(outcome.staticDelta.findings[0]!.path).toBe('CRM/MyExt/New.php');
      expect(outcome.staticDelta.findings[0]!.isNewOnHead).toBe(true);

      // Browser A/B args & copied screenshots
      const browserCall = invocations.find(
        (a) => a[0] === 'ck' && a[1] === 'ab' && a.includes('--page'),
      );
      expect(browserCall).toBeDefined();
      expect(browserCall).toContain('--page');
      expect(browserCall).toContain('civicrm/myext/public-view');
      expect(browserCall).toContain('--anon-page');
      expect(browserCall).toContain('--no-a11y');
      expect(browserCall).toContain('--expose');
      expect(browserCall).toContain('--keep');

      const bd = outcome.abReport.browserDiff!;
      expect(bd.new_console_errors).toEqual(['TypeError: undefined is not a function']);
      expect(bd.screenshots).toHaveLength(1);
      expect(bd.screenshots[0]!.before).toContain(join(outDir, 'screenshots'));
      expect(existsSync(bd.screenshots[0]!.before!)).toBe(true);
      expect(existsSync(bd.screenshots[0]!.after!)).toBe(true);
      expect(outcome.urls).toEqual({
        A: 'http://127.0.0.1:41001',
        B: 'http://127.0.0.1:41002',
      });
    } finally {
      await outcome.cleanup();
    }
  });

  test('passes --name and --filter on modified test file, detects tautologicalTests from passed_both, and formats shared evidence prefix', async () => {
    const repoDir = makeTempDir();
    const repoInfo: RepoInfo = {
      kind: 'civicrm-core',
      root: repoDir,
      recommendedImage: 'standalone-master',
    };
    const diffText = `diff --git a/CRM/Contact/BAO/Query.php b/CRM/Contact/BAO/Query.php
--- a/CRM/Contact/BAO/Query.php
+++ b/CRM/Contact/BAO/Query.php
@@ -10,2 +10,3 @@ class CRM_Contact_BAO_Query {
+// production fix
diff --git a/tests/phpunit/CRM/Contact/BAO/QueryTest.php b/tests/phpunit/CRM/Contact/BAO/QueryTest.php
--- a/tests/phpunit/CRM/Contact/BAO/QueryTest.php
+++ b/tests/phpunit/CRM/Contact/BAO/QueryTest.php
@@ -100,2 +100,8 @@ class CRM_Contact_BAO_QueryTest {
+  public function testOrderByAlwaysIncludesContactId(): void {
+    $this->assertTrue(true);
+  }
+  public function testActuallyFixesBug(): void {
+    $this->assertTrue(true);
+  }
`;
    const diffFiles = parseUnifiedDiff(diffText);

    let proofCallArgs: string[] = [];
    const execFn: ExecFn = async (args) => {
      if (args[0] === 'docker' && args[1] === 'info') {
        return { exitCode: 0, stdout: 'ok', stderr: '' };
      }
      if (args[0] === 'git' && args[3] === 'worktree' && args[4] === 'add') {
        const target = args[6]!;
        mkdirSync(join(target, 'CRM'), { recursive: true });
        mkdirSync(join(target, 'tests/phpunit/CRM/Contact/BAO'), {
          recursive: true,
        });
        writeFileSync(join(target, 'tests/phpunit/CRM/Contact/BAO/QueryTest.php'), '<?php\n');
        return { exitCode: 0, stdout: '', stderr: '' };
      }
      if (args[0] === 'ck' && args[1] === 'ab') {
        const outDirArg = args[args.indexOf('--out') + 1] ?? '';
        if (outDirArg.endsWith('/proof-of-fix')) {
          proofCallArgs = args;
        }
        const jsonIdx = args.indexOf('--json');
        const jsonPath = args[jsonIdx + 1]!;
        writeFileSync(
          jsonPath,
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
              passed_both: [
                'CRM_Contact_BAO_QueryTest::testOrderByAlwaysIncludesContactId with data set #0',
                'CRM_Contact_BAO_QueryTest::testOrderByAlwaysIncludesContactId with data set #1',
              ],
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

    const nameIdx = proofCallArgs.indexOf('--name');
    expect(nameIdx).toBeGreaterThan(-1);
    expect(proofCallArgs[nameIdx + 1]).toMatch(/^civireview-[a-z0-9-]+-proof-of-fix$/);

    const filterIdx = proofCallArgs.indexOf('--filter');
    expect(filterIdx).toBeGreaterThan(-1);
    expect(proofCallArgs[filterIdx + 1]).toBe(
      '/(^|::)(testOrderByAlwaysIncludesContactId|testActuallyFixesBug)(\\s|$)/',
    );

    const proofCheck = outcome.abReport.checks.find((c) => c.name === 'proof-of-fix');
    expect(proofCheck).toBeDefined();
    expect(proofCheck!.tautologicalTests).toEqual([
      {
        file: 'tests/phpunit/CRM/Contact/BAO/QueryTest.php',
        method: 'testOrderByAlwaysIncludesContactId',
        line: 100,
        testCaseName:
          'CRM_Contact_BAO_QueryTest::testOrderByAlwaysIncludesContactId with data set #0',
      },
    ]);
    expect(proofCheck!.summary).toBe(
      '1 added test method(s) PASSED on unfixed base A (tautological: testOrderByAlwaysIncludesContactId)',
    );

    const bundle: EvidenceBundle = {
      schemaVersion: '1',
      collectedAt: '2026-11-22T12:00:00Z',
      repoInfo,
      pr: {
        repo: 'civicrm/civicrm-core',
        isPrivateRepo: false,
        prNumber: 1,
        title: 'Test',
        body: 'Test',
        author: 'alice',
        baseBranch: 'master',
        headBranch: 'fix',
        baseSha: 'aaaaaaa',
        headSha: 'bbbbbbb',
        labels: [],
        draft: false,
      },
      comments: [],
      linkedIssues: [],
      diffFiles,
      droppedNoiseFiles: [],
      diffTruncated: false,
      abReport: outcome.abReport,
      staticDelta: outcome.staticDelta,
      ciStatus: {
        overallState: 'success',
        checks: [],
        jenkinsFailedTests: [],
        summary: 'ok',
      },
      notVerified: [],
    };
    const sharedPrefix = buildSharedEvidencePrefix(bundle, diffText);
    expect(sharedPrefix).toContain(
      'tests/phpunit/CRM/Contact/BAO/QueryTest.php:100 testOrderByAlwaysIncludesContactId',
    );
  });

  test('falls back gracefully when older ck ab rejects --name', async () => {
    const repoDir = makeTempDir();
    const repoInfo: RepoInfo = {
      kind: 'civicrm-extension',
      root: repoDir,
      extensionName: 'myext',
      recommendedImage: 'standalone',
    };
    const diffFiles = parseUnifiedDiff(`diff --git a/CRM/MyExt/Foo.php b/CRM/MyExt/Foo.php
--- a/CRM/MyExt/Foo.php
+++ b/CRM/MyExt/Foo.php
@@ -1,2 +1,3 @@
 <?php
+// fix
diff --git a/tests/phpunit/CRM/MyExt/FooTest.php b/tests/phpunit/CRM/MyExt/FooTest.php
--- a/tests/phpunit/CRM/MyExt/FooTest.php
+++ b/tests/phpunit/CRM/MyExt/FooTest.php
@@ -10,2 +10,5 @@ class FooTest {
+  public function testNewCase(): void {
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
        mkdirSync(join(target, 'tests/phpunit/CRM/MyExt'), { recursive: true });
        writeFileSync(join(target, 'tests/phpunit/CRM/MyExt/FooTest.php'), '<?php\n');
        return { exitCode: 0, stdout: '', stderr: '' };
      }
      if (args[0] === 'ck' && args[1] === 'ab') {
        abCalls.push(args);
        if (args.includes('--name')) {
          return { exitCode: 2, stdout: '', stderr: 'unknown option: --name' };
        }
        const jsonIdx = args.indexOf('--json');
        const jsonPath = args[jsonIdx + 1]!;
        writeFileSync(
          jsonPath,
          JSON.stringify({
            A: { image: 'standalone', core: '6.16', status: 1, junit: 'a.xml' },
            B: { image: 'standalone', core: '6.16', status: 0, junit: 'b.xml' },
            mode: 'junit',
            groups: {
              regression: [],
              fixed: ['FooTest::testNewCase'],
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
      checksConfig: ChecksConfigSchema.parse({ matrix: false }),
      execFn,
      worktreeBaseDir: join(repoDir, '.worktrees'),
    });

    const proofCalls = abCalls.filter((a) => a.some((x) => x.includes('FooTest.php')));
    expect(proofCalls).toHaveLength(2);
    expect(proofCalls[0]).toContain('--name');
    expect(proofCalls[1]).not.toContain('--name');
    expect(proofCalls[1]).toContain('--json');
    expect(proofCalls[1]).toContain('--filter');
    expect(proofCalls[1]).toContain('/(^|::)(testNewCase)(\\s|$)/');

    const proofCheck = outcome.abReport.checks.find((c) => c.name === 'proof-of-fix');
    expect(proofCheck?.fixed).toEqual(['FooTest::testNewCase']);
    expect(proofCheck?.tautologicalTests).toEqual([]);
  });

  test('buildMultiTargetTestCommand uses direct argv for 1 file and merges JUnit XML for multiple files', () => {
    const single = buildMultiTargetTestCommand('ckcoretest', [
      { path: 'tests/phpunit/CRM/FooTest.php', filterArgs: ['--filter', '/(^|::)(testA)(\\s|$)/'] },
    ]);
    expect(single).toEqual([
      'ckcoretest',
      '--log-junit',
      '/tmp/ck-ab.xml',
      '--filter',
      '/(^|::)(testA)(\\s|$)/',
      'tests/phpunit/CRM/FooTest.php',
    ]);

    const multi = buildMultiTargetTestCommand('ckcoretest', [
      {
        path: 'ext/afform/mock/tests/phpunit/A.php',
        filterArgs: ['--filter', '/(^|::)(testA)(\\s|$)/'],
      },
      { path: 'ext/civi_contribute/tests/phpunit/B.php', filterArgs: [] },
    ]);
    expect(multi[0]).toBe('sh');
    expect(multi[1]).toBe('-c');
    expect(multi[2]).toContain('/tmp/ck-ab-part-0.xml');
    expect(multi[2]).toContain('/tmp/ck-ab-part-1.xml');
    expect(multi[2]).toContain('ext/afform/mock/tests/phpunit/A.php');
    expect(multi[2]).toContain('ext/civi_contribute/tests/phpunit/B.php');
    expect(multi[2]).toContain('DOMDocument');
    expect(multi[2]).toContain('/tmp/ck-ab.xml');
  });

  test('uses per-file mounts for core PRs and marks 0-pass bootstrap crashes as ERROR', async () => {
    const repoDir = makeTempDir();
    const repoInfo: RepoInfo = {
      kind: 'civicrm-core',
      root: repoDir,
      recommendedImage: 'standalone-master',
    };
    const diffFiles =
      parseUnifiedDiff(`diff --git a/CRM/Contact/BAO/Query.php b/CRM/Contact/BAO/Query.php
--- a/CRM/Contact/BAO/Query.php
+++ b/CRM/Contact/BAO/Query.php
@@ -1,2 +1,2 @@
-<?php // old
+<?php // new
diff --git a/tests/phpunit/CRM/Contact/BAO/QueryTest.php b/tests/phpunit/CRM/Contact/BAO/QueryTest.php
--- a/tests/phpunit/CRM/Contact/BAO/QueryTest.php
+++ b/tests/phpunit/CRM/Contact/BAO/QueryTest.php
@@ -1,2 +1,5 @@
 <?php
+  public function testOrderBy(): void {
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
        mkdirSync(join(target, 'CRM/Contact/BAO'), { recursive: true });
        mkdirSync(join(target, 'tests/phpunit/CRM/Contact/BAO'), { recursive: true });
        writeFileSync(join(target, 'CRM/Contact/BAO/Query.php'), '<?php\n');
        writeFileSync(join(target, 'tests/phpunit/CRM/Contact/BAO/QueryTest.php'), '<?php\n');
        return { exitCode: 0, stdout: '', stderr: '' };
      }
      if (args[0] === 'ck' && args[1] === 'ab') {
        abCalls.push(args);
        const jsonIdx = args.indexOf('--json');
        writeFileSync(
          args[jsonIdx + 1]!,
          JSON.stringify({
            A: { image: 'standalone-master', core: 'master', status: 2, junit: 'a.xml' },
            B: { image: 'standalone-master', core: 'master', status: 2, junit: 'b.xml' },
            mode: 'junit',
            groups: {
              regression: [],
              fixed: [],
              both: ['QueryTest::testFirst'],
              gone: [],
              only_on_b: [],
              passed_both: [],
            },
            counts: {
              a: 40,
              b: 40,
              regression: 0,
              fixed: 0,
              both: 1,
              gone: 0,
              only_on_b: 0,
              passed_both: 0,
            },
            exit_code: 0,
          }),
        );
        return { exitCode: 0, stdout: 'ck ab done', stderr: 'Error: bootstrap crash' };
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
    expect(
      proofArgs.some((a) => a.endsWith(':/var/www/html/core/CRM/Contact/BAO/Query.php:ro')),
    ).toBe(true);
    expect(proofArgs.some((a) => a.endsWith(':/var/www/html/core/CRM:ro'))).toBe(false);
    expect(
      proofArgs.some((a) =>
        a.endsWith(':/var/www/html/core/tests/phpunit/CRM/Contact/BAO/QueryTest.php:ro'),
      ),
    ).toBe(true);

    const proofCheck = outcome.abReport.checks.find((c) => c.name === 'proof-of-fix');
    expect(proofCheck?.status).toBe('ERROR');
    expect(proofCheck?.summary).toContain('0 tests passed on A or B');
    expect(proofCheck?.outputSnippet).toContain('Error: bootstrap crash');
  });

  test('filters modified test file to enclosing test method when no new test method was added', async () => {
    const repoDir = makeTempDir();
    const repoInfo: RepoInfo = {
      kind: 'civicrm-core',
      root: repoDir,
      recommendedImage: 'standalone-master',
    };
    const diffFiles = parseUnifiedDiff(`diff --git a/CRM/Report/Form.php b/CRM/Report/Form.php
--- a/CRM/Report/Form.php
+++ b/CRM/Report/Form.php
@@ -1,2 +1,2 @@
-<?php // old
+<?php // new
diff --git a/tests/phpunit/api/v3/ReportTemplateTest.php b/tests/phpunit/api/v3/ReportTemplateTest.php
--- a/tests/phpunit/api/v3/ReportTemplateTest.php
+++ b/tests/phpunit/api/v3/ReportTemplateTest.php
@@ -4,3 +4,3 @@ class api_v3_ReportTemplateTest {
   public function testLybuntReportWithFYData(): void {
-    $sql = 'SELECT SQL_CALC_FOUND_ROWS id';
+    $sql = 'SELECT id';
   }
`);

    const abCalls: string[][] = [];
    const execFn: ExecFn = async (args) => {
      if (args[0] === 'docker' && args[1] === 'info') {
        return { exitCode: 0, stdout: 'ok', stderr: '' };
      }
      if (args[0] === 'git' && args[3] === 'worktree' && args[4] === 'add') {
        const target = args[6]!;
        mkdirSync(join(target, 'CRM/Report'), { recursive: true });
        mkdirSync(join(target, 'tests/phpunit/api/v3'), { recursive: true });
        writeFileSync(join(target, 'CRM/Report/Form.php'), '<?php\n');
        writeFileSync(
          join(target, 'tests/phpunit/api/v3/ReportTemplateTest.php'),
          [
            '<?php',
            'class api_v3_ReportTemplateTest {',
            '  public function testOther(): void {}',
            '  public function testLybuntReportWithFYData(): void {',
            "    $sql = 'SELECT id';",
            '  }',
            '}',
          ].join('\n'),
        );
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
              fixed: ['api_v3_ReportTemplateTest::testLybuntReportWithFYData'],
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

    await runCiviKitchenAb({
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
    const filterIdx = proofArgs.indexOf('--filter');
    expect(filterIdx).toBeGreaterThan(-1);
    expect(proofArgs[filterIdx + 1]).toBe('/(^|::)(testLybuntReportWithFYData)(\\s|$)/');
  });
});
