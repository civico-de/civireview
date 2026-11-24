import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  AbConfigSchema,
  BrowserConfigSchema,
  ChecksConfigSchema,
  ReviewSettingsSchema,
} from '../src/config/schema.ts';
import type { ExecFn } from '../src/evidence/civikitchen-ab.ts';
import {
  resolveExtensionTargets,
  runStandaloneBrowserAb,
  runStaticAndLifecycleChecks,
  UPGRADE_PARITY_SCRIPT,
} from '../src/evidence/ab/static-browser.ts';
import { computeSurfaceDiff } from '../src/evidence/ab/surface-diff.ts';
import { newTaintFindings, parseTaintFindings } from '../src/evidence/ab/parsers.ts';
import { parseUnifiedDiff } from '../src/evidence/diff-filter.ts';
import { detectBundledExtensions, reviewProfile } from '../src/evidence/repo-detect.ts';
import type { RepoInfo, StaticDeltaFinding } from '../src/evidence/types.ts';

const tempDirs: string[] = [];
afterEach(() => {
  while (tempDirs.length > 0) rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

/** A civicrm-core checkout pair with the bundled extension `ext/widgets` at base and head. */
function coreWorktrees(opts: { extensionAtBase?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'civireview-gates-'));
  tempDirs.push(root);
  const a = join(root, 'A');
  const b = join(root, 'B');
  for (const [dir, has] of [
    [a, opts.extensionAtBase ?? true],
    [b, true],
  ] as const) {
    mkdirSync(join(dir, 'ext/widgets'), { recursive: true });
    if (has)
      writeFileSync(join(dir, 'ext/widgets/info.xml'), '<extension key="widgets" type="module"/>');
  }
  return { a, b };
}

const coreInfo = (root: string): RepoInfo => ({
  kind: 'civicrm-core',
  root,
  bundledExtensions: ['ext/widgets'],
  recommendedImage: 'standalone-master',
});

const upgraderDiff = () =>
  parseUnifiedDiff(`diff --git a/ext/widgets/CRM/Widgets/Upgrader.php b/ext/widgets/CRM/Widgets/Upgrader.php
--- a/ext/widgets/CRM/Widgets/Upgrader.php
+++ b/ext/widgets/CRM/Widgets/Upgrader.php
@@ -1,2 +1,3 @@
 <?php
+// upgrade_1001
`);

const LIFECYCLE_PASSED = '### Lifecycle gate (`widgets`)\n\nResult: passed';
const fileMount = (side: string) => [
  '--mount',
  `${side}/ext/widgets/CRM/Widgets/Upgrader.php:/var/www/html/core/ext/widgets/CRM/Widgets/Upgrader.php:ro`,
  '--mount',
  `${side}/CRM/Core/Thing.php:/var/www/html/core/CRM/Core/Thing.php:ro`,
];

async function runGates(
  wt: { a: string; b: string },
  respond: (gate: 'taint' | 'lifecycle' | 'parity', args: string[]) => ReturnType<ExecFn>,
  over: { repoInfo?: RepoInfo; exclude?: string[]; mountsB?: string[]; diff?: string } = {},
) {
  const calls: Array<{ gate: string; args: string[] }> = [];
  const cleanups: string[][] = [];
  const execFn: ExecFn = async (args) => {
    if (args[0] === 'docker') {
      cleanups.push(args);
      return { exitCode: 0, stdout: '', stderr: '' };
    }
    const gate = args.includes(UPGRADE_PARITY_SCRIPT)
      ? 'parity'
      : args.includes('lifecycle')
        ? 'lifecycle'
        : 'taint';
    calls.push({ gate, args });
    return respond(gate, args);
  };
  const toolsRun: string[] = [];
  const staticFindings: StaticDeltaFinding[] = [];
  const notVerified: string[] = [];
  await runStaticAndLifecycleChecks({
    execFn,
    ckCommand: ['ck'],
    workDir: '/work/run-abc123',
    repoInfo: over.repoInfo ?? coreInfo(wt.b),
    diffFiles: over.diff ? parseUnifiedDiff(over.diff) : upgraderDiff(),
    imageA: 'standalone-master',
    imageB: 'standalone-master',
    worktreeA: wt.a,
    worktreeB: wt.b,
    mountsAOnly: fileMount(wt.a),
    mountsBOnly: over.mountsB ?? fileMount(wt.b),
    effectiveCfg: {
      ab: AbConfigSchema.parse({}),
      checks: ChecksConfigSchema.parse({}),
      review: ReviewSettingsSchema.parse({ exclude: over.exclude ?? [] }),
    },
    toolsRun,
    staticFindings,
    notVerified,
  });
  return { calls, cleanups, toolsRun, staticFindings, notVerified };
}

const ok = async () => ({ exitCode: 0, stdout: '', stderr: '' });
const PARITY_IDENTICAL = { exitCode: 0, stdout: 'upgrade-parity: schemas identical\n', stderr: '' };

describe('review profile', () => {
  test('a core PR touching a bundled extension is core-extension', () => {
    expect(reviewProfile({ kind: 'civicrm-core', root: '/r', recommendedImage: 'x' })).toBe('core');
    expect(reviewProfile(coreInfo('/r'))).toBe('core-extension');
    expect(reviewProfile({ kind: 'civicrm-extension', root: '/r', recommendedImage: 'x' })).toBe(
      'extension',
    );
    expect(reviewProfile({ kind: 'generic', root: '/r', recommendedImage: 'x' })).toBe('generic');
  });

  test('detects the nearest info.xml under ext/, nested extensions and ones the diff adds', () => {
    const root = mkdtempSync(join(tmpdir(), 'civireview-detect-'));
    tempDirs.push(root);
    for (const dir of ['ext/widgets', 'ext/afform/core']) {
      mkdirSync(join(root, dir), { recursive: true });
      writeFileSync(join(root, dir, 'info.xml'), '<extension/>');
    }
    expect(
      detectBundledExtensions(root, [
        'ext/widgets/ang/a.html',
        'ext/afform/core/Civi/Afform/X.php',
        'ext/afform/docs/readme.md',
        'ext/newthing/info.xml',
        'ext/newthing/newthing.php',
        'CRM/Core/Thing.php',
        'ext/README.md',
      ]),
    ).toEqual(['ext/afform/core', 'ext/newthing', 'ext/widgets']);
  });
});

describe('extension gates on a bundled core extension', () => {
  test('run from the extension root and report a healthy extension without findings', async () => {
    const wt = coreWorktrees();
    const res = await runGates(wt, async (gate) =>
      gate === 'lifecycle'
        ? { exitCode: 0, stdout: LIFECYCLE_PASSED, stderr: '' }
        : gate === 'parity'
          ? PARITY_IDENTICAL
          : ok(),
    );

    expect(resolveExtensionTargets(coreInfo(wt.b), wt.a, wt.b)).toEqual([
      {
        key: 'widgets',
        containerDir: '/var/www/html/core/ext/widgets',
        hostA: join(wt.a, 'ext/widgets'),
        hostB: join(wt.b, 'ext/widgets'),
        repoPrefix: 'ext/widgets/',
      },
    ]);
    expect(res.toolsRun).toEqual(['cktaint', 'cklifecycle', 'ckschemaparity']);
    expect(res.staticFindings).toEqual([]);
    expect(res.notVerified).toEqual([]);

    const lifecycle = res.calls.find((c) => c.gate === 'lifecycle')!.args;
    expect(lifecycle.slice(-4)).toEqual([
      '/var/www/html/core/ext/widgets',
      'widgets',
      'ck',
      'lifecycle',
    ]);

    // Parity swaps the extension directory, so file mounts inside it are left out; others stay.
    const parity = res.calls.find((c) => c.gate === 'parity')!.args.join(' ');
    expect(parity).not.toContain('/var/www/html/core/ext/widgets/CRM/Widgets/Upgrader.php');
    expect(parity).toContain('/var/www/html/core/CRM/Core/Thing.php:ro');
    expect(parity).toContain(`${join(wt.a, 'ext/widgets')}:/opt/cr-a:ro`);
    expect(parity).toContain(`${join(wt.b, 'ext/widgets')}:/opt/cr-b:ro`);
  });

  test('a gate that never reached its check is not verified, never a finding', async () => {
    const res = await runGates(coreWorktrees(), async (gate) => {
      if (gate === 'lifecycle') {
        return {
          exitCode: 2,
          stdout: '',
          stderr: 'cklifecycle: no info.xml here - run from the extension root.',
        };
      }
      if (gate === 'parity') {
        return { exitCode: 3, stdout: '', stderr: 'upgrade-parity: step failed: uninstall\nboom' };
      }
      return { exitCode: 124, stdout: '', stderr: '', timedOut: true };
    });

    expect(res.staticFindings).toEqual([]);
    expect(res.toolsRun).toEqual([]);
    // A cut-off run leaves its stack behind, which would block every later run of that name.
    expect(res.cleanups).toEqual([
      ['docker', 'compose', '-p', 'civireview-run-abc123-taint-a', 'down', '-v'],
      ['docker', 'compose', '-p', 'civireview-run-abc123-taint-b', 'down', '-v'],
    ]);
    expect(res.calls[0]!.args.slice(0, 5)).toEqual([
      'ck',
      'run',
      'standalone-master',
      '--name',
      'civireview-run-abc123-taint-a',
    ]);
    expect(res.notVerified).toEqual([
      'ck taint timed out for widgets; static taint delta skipped.',
      'ck lifecycle did not run for widgets; lifecycle not verified.',
      'upgrade path of widgets not verified: step "uninstall" failed',
    ]);
  });

  test('a failed lifecycle is an error, a schema difference a warning with the diff', async () => {
    const res = await runGates(coreWorktrees(), async (gate) => {
      if (gate === 'lifecycle') {
        return {
          exitCode: 1,
          stdout: '### Lifecycle gate (`widgets`)\n\nResult: **FAILED**',
          stderr: '',
        };
      }
      if (gate === 'parity') {
        return {
          exitCode: 1,
          stdout:
            ' Container x Started\n--- fresh install of HEAD\n+++ last release upgraded to HEAD\n-  `a` int\n+  `b` int\n\nckschemadiff: the two schemas differ.',
          stderr: '',
        };
      }
      return ok();
    });

    expect(res.staticFindings.map((f) => [f.tool, f.severity])).toEqual([
      ['cklifecycle', 'error'],
      ['ckschemaparity', 'warning'],
    ]);
    expect(res.staticFindings[1]!.message).toContain('--- fresh install of HEAD');
    expect(res.staticFindings[1]!.message).not.toContain('Container x');
  });

  test('names parity as skipped for an extension the PR adds, and a disabled lifecycle check', async () => {
    const added = await runGates(coreWorktrees({ extensionAtBase: false }), async (gate) =>
      gate === 'lifecycle' ? { exitCode: 0, stdout: LIFECYCLE_PASSED, stderr: '' } : ok(),
    );
    expect(added.calls.map((c) => c.gate)).toEqual(['taint', 'taint', 'lifecycle']);
    expect(added.notVerified).toEqual([
      'Upgrade parity skipped for widgets: the PR adds the extension, there is no base version to upgrade from.',
    ]);

    const disabled = await runGates(coreWorktrees(), ok, { exclude: ['lifecycle'] });
    expect(disabled.calls.map((c) => c.gate)).toEqual(['taint', 'taint']);
    expect(disabled.notVerified).toEqual([
      'install, uninstall and upgrade path of widgets not verified (lifecycle check disabled)',
    ]);
  });

  test('a plain core PR runs no extension gate', async () => {
    const wt = coreWorktrees();
    const res = await runGates(wt, ok, {
      repoInfo: { kind: 'civicrm-core', root: wt.b, recommendedImage: 'standalone-master' },
    });
    expect(res.calls).toEqual([]);
  });
});

const CLEAN_BROWSER_DIFF = {
  new_console_errors: [],
  new_page_errors: [],
  new_network_failures: [],
  new_a11y_violations: [],
  render_regressions: [],
  screenshots: [],
  risk_flags: [],
};

const taintLine = (level: string) =>
  `${level}: TaintedHtml - CRM/X/Page.php:5:1 - Detected tainted HTML (see https://psalm.dev/245)\n`;

const taintAt = (level: string, line: number) => taintLine(level).replace(':5:1', `:${line}:1`);

const ENABLED_ON_BOTH = { A: { status: 0 }, B: { status: 0 }, mode: 'exit-status' };

async function probeBrowser(wt: { a: string; b: string }, report?: Record<string, unknown> | null) {
  const diffFiles =
    parseUnifiedDiff(`diff --git a/ext/widgets/ang/widgetEditor.aff.html b/ext/widgets/ang/widgetEditor.aff.html
--- a/ext/widgets/ang/widgetEditor.aff.html
+++ b/ext/widgets/ang/widgetEditor.aff.html
@@ -1,2 +1,3 @@
 <div>
+<select id="mode"></select>
 </div>
`);
  const repoInfo = coreInfo(wt.b);
  const calls: string[][] = [];
  const execFn: ExecFn = async (args) => {
    calls.push(args);
    // `null` stands for a run that left no report behind.
    if (report !== null) {
      writeFileSync(args[args.indexOf('--json') + 1]!, JSON.stringify(report ?? ENABLED_ON_BOTH));
    }
    writeFileSync(
      join(args[args.indexOf('--out') + 1]!, 'browser-diff.json'),
      JSON.stringify(CLEAN_BROWSER_DIFF),
    );
    return { exitCode: 0, stdout: '', stderr: '' };
  };
  const res = await runStandaloneBrowserAb({
    execFn,
    ckCommand: ['ck'],
    workDir: wt.b,
    outRoot: join(wt.b, 'out'),
    repoInfo,
    worktreeA: wt.a,
    worktreeB: wt.b,
    diffFiles,
    imageA: 'standalone-master',
    imageB: 'standalone-master',
    abMounts: [],
    browserConfig: BrowserConfigSchema.parse({}),
    effectiveCfg: {
      ab: AbConfigSchema.parse({}),
      checks: ChecksConfigSchema.parse({}),
      review: ReviewSettingsSchema.parse({}),
    },
    wantSurface: false,
    interactiveBrowser: false,
    liveProve: false,
    keepLive: false,
    surfaceDiff: computeSurfaceDiff(diffFiles, repoInfo),
    notVerified: [],
  });
  return { call: calls[0]!, browserDiff: res.browserDiff! };
}

describe('browser probe of a bundled core extension', () => {
  test('enables the extension on both sides and loads its own routes', async () => {
    const wt = coreWorktrees();
    mkdirSync(join(wt.b, 'ext/widgets/ang'), { recursive: true });
    writeFileSync(
      join(wt.b, 'ext/widgets/ang/widgetAdmin.aff.php'),
      "<?php return ['server_route' => 'civicrm/admin/widgets'];",
    );
    const { call, browserDiff } = await probeBrowser(wt);

    expect(call.slice(call.indexOf('--') + 1)).toEqual(['cv', 'ext:enable', 'widgets']);
    expect(call.slice(call.indexOf('--page'), call.indexOf('--page') + 2)).toEqual([
      '--page',
      'civicrm/admin/widgets',
    ]);
    expect(browserDiff.probedRoutes).toEqual(['civicrm/admin/widgets']);
    expect(browserDiff.smokeOnly).toBeUndefined();
  });

  test('a probe whose extension could not be enabled is an error, not a clean result', async () => {
    const { browserDiff } = await probeBrowser(coreWorktrees(), {
      A: { status: 1 },
      B: { status: 0 },
      mode: 'exit-status',
    });
    expect(browserDiff.error).toBe('could not enable widgets (exit 1 on base, 0 on head)');
  });

  test('a probe without a report cannot show the extension was enabled', async () => {
    const { browserDiff } = await probeBrowser(coreWorktrees(), null);
    expect(browserDiff.error).toBe(
      'could not enable widgets (exit unknown on base, unknown on head)',
    );
  });

  test('marks a probe as smoke-only when the extension defines no route', async () => {
    const { browserDiff } = await probeBrowser(coreWorktrees());
    expect(browserDiff.probedRoutes).toEqual(['civicrm/dashboard?reset=1']);
    expect(browserDiff.smokeOnly).toBe(true);
  });
});

const schemaAndUpgradeDiff = (prefix: string) =>
  parseUnifiedDiff(
    ['schema/Thing.entityType.php', 'CRM/Thing/Upgrader.php']
      .map(
        (f) => `diff --git a/${prefix}${f} b/${prefix}${f}
--- a/${prefix}${f}
+++ b/${prefix}${f}
@@ -1,2 +1,3 @@
 <?php
+// change
`,
      )
      .join(''),
  );

describe('core not-verified notes', () => {
  test('keep the notes for a change under ext/ that belongs to no detected extension', () => {
    const undetected = computeSurfaceDiff(schemaAndUpgradeDiff('ext/widgets/'), {
      kind: 'civicrm-core',
      root: '/r',
      recommendedImage: 'standalone-master',
    });
    expect(undetected.unverifiedSurfaces).toEqual([
      'schema change (xml/schema) not rebuilt by container mount',
      'upgrade path (CRM/Upgrade/*) not verified locally',
    ]);
  });

  test('name the core schema and upgrade paths only for changes outside ext/', () => {
    const bundled = computeSurfaceDiff(schemaAndUpgradeDiff('ext/widgets/'), coreInfo('/r'));
    expect(bundled.changes.map((c) => c.kind).toSorted()).toEqual(['schema', 'upgrade']);
    expect(bundled.unverifiedSurfaces).toEqual([]);

    const core = computeSurfaceDiff(
      parseUnifiedDiff(`diff --git a/CRM/Upgrade/Incremental/php/SixTwentyTwo.php b/CRM/Upgrade/Incremental/php/SixTwentyTwo.php
--- a/CRM/Upgrade/Incremental/php/SixTwentyTwo.php
+++ b/CRM/Upgrade/Incremental/php/SixTwentyTwo.php
@@ -1,2 +1,3 @@
 <?php
+// change
`),
      { kind: 'civicrm-core', root: '/r', recommendedImage: 'standalone-master' },
    );
    expect(core.unverifiedSurfaces).toEqual(['upgrade path (CRM/Upgrade/*) not verified locally']);
  });
});

// Output of `cktaint` on CiviKitchen standalone-master, colour and hyperlink escapes included.
const ESC = '\u001B';
const TAINT_CLEAN = `== cktaint: taint analysis (SQL/shell/include/unserialize/SSRF block; INFO classes are advisory) ==
cktaint: config /opt/civikitchen/toolbelt/psalm/psalm-taint.xml.dist
------------------------------
${ESC}[42;30;2m       No errors found!       ${ESC}[0m
------------------------------

Checks took 1.31 seconds and used 63.834MB of memory
Psalm was able to infer types for 69.1087% of the codebase
`;
const taintIssue = (line: number) =>
  `${ESC}[0;31mERROR${ESC}[0m: TaintedSql - ${ESC}]8;;file:///var/www/html/ext/x/CRM/X/Page.php#L${line}${ESC}\\CRM/X/${ESC}[1;31mPage.php:${line}:32${ESC}[0m${ESC}]8;;${ESC}\\ - Detected tainted SQL (see https://psalm.dev/244)
  $_GET['id'] - ${ESC}]8;;file:///var/www/html/ext/x/CRM/X/Page.php#L4${ESC}\\CRM/X/${ESC}[1;31mPage.php:4:11${ESC}[0m${ESC}]8;;${ESC}\\
    $id = ${ESC}[30;47m$_GET${ESC}[0m['id'];

------------------------------
${ESC}[0;31m1 errors${ESC}[0m found
------------------------------

Checks took 0.98 seconds and used 47.337MB of memory
Psalm was able to infer types for 100% of the codebase

cktaint: ERROR-level findings above fail the build.
`;

describe('taint delta', () => {
  test('a clean run has no finding, whatever its timing and coverage lines say', () => {
    expect(parseTaintFindings(TAINT_CLEAN)).toEqual([]);
    expect(
      parseTaintFindings(TAINT_CLEAN.replace('1.31 seconds', '2.07 seconds').replace('69.1', '70')),
    ).toEqual([]);
  });

  test('reads one finding per issue line and skips its trace', () => {
    expect(parseTaintFindings(taintIssue(5))).toEqual([
      {
        key: 'TaintedSql:CRM/X/Page.php:Detected tainted SQL (see https://psalm.dev/244)',
        path: 'CRM/X/Page.php',
        line: 5,
        message: 'TaintedSql: Detected tainted SQL (see https://psalm.dev/244)',
        severity: 'error',
      },
    ]);
  });

  test('an issue the PR only moved is not new, a second one of the same kind is', () => {
    const base = parseTaintFindings(taintIssue(5));
    expect(newTaintFindings(base, parseTaintFindings(taintIssue(9)))).toEqual([]);
    const twice = parseTaintFindings(taintIssue(9) + taintIssue(20));
    expect(newTaintFindings(base, twice).map((f) => f.line)).toEqual([20]);
    // The occurrence still on its base line is the old one, wherever the new one sits.
    const before = parseTaintFindings(taintIssue(3) + taintIssue(5));
    expect(newTaintFindings(base, before).map((f) => f.line)).toEqual([3]);
  });

  test('timing lines of two clean runs produce no finding in the gate', async () => {
    const res = await runGates(coreWorktrees(), async (gate, args) => {
      if (gate === 'lifecycle') return { exitCode: 0, stdout: LIFECYCLE_PASSED, stderr: '' };
      if (gate === 'parity') return ok();
      const slower = args.some((a) => a.includes('/B/'));
      return {
        exitCode: 0,
        stdout: slower ? TAINT_CLEAN.replace('1.31', '1.33') : TAINT_CLEAN,
        stderr: '',
      };
    });
    expect(res.staticFindings).toEqual([]);
    expect(res.toolsRun).toContain('cktaint');
  });

  test('a new error-level issue on the head is a finding with its repository path', async () => {
    const res = await runGates(coreWorktrees(), async (gate, args) => {
      if (gate !== 'taint') return ok();
      return args.some((a) => a.includes('/B/'))
        ? { exitCode: 2, stdout: taintIssue(5), stderr: '' }
        : { exitCode: 0, stdout: TAINT_CLEAN, stderr: '' };
    });
    expect(res.staticFindings.filter((f) => f.tool === 'cktaint')).toEqual([
      {
        tool: 'cktaint',
        severity: 'error',
        path: 'ext/widgets/CRM/X/Page.php',
        line: 5,
        message: 'TaintedSql: Detected tainted SQL (see https://psalm.dev/244)',
        isNewOnHead: true,
      },
    ]);
  });

  test('a failed base run invalidates the delta instead of making every head issue new', async () => {
    const res = await runGates(coreWorktrees(), async (gate, args) => {
      if (gate !== 'taint') return ok();
      return args.some((a) => a.includes('/B/'))
        ? { exitCode: 2, stdout: taintIssue(5), stderr: '' }
        : { exitCode: 2, stdout: '', stderr: 'cktaint: config not found: psalm.xml' };
    });
    expect(res.staticFindings.filter((f) => f.tool === 'cktaint')).toEqual([]);
    expect(res.notVerified).toContain(
      'ck taint failed for widgets (exit 2); static taint delta skipped.',
    );
  });

  test('parity under a directory mount over ext/ is skipped and named', async () => {
    const wt = coreWorktrees();
    const res = await runGates(wt, ok, {
      mountsB: ['--mount', `${wt.b}/ext:/var/www/html/core/ext:ro`],
    });
    expect(res.calls.map((c) => c.gate)).not.toContain('parity');
    expect(res.notVerified).toContain(
      'Upgrade parity skipped for widgets: the PR is mounted as whole directories, so the extension cannot be replaced in the instance.',
    );
  });

  test('parity that exits 0 without reaching its comparison is not verified', async () => {
    const res = await runGates(coreWorktrees(), ok);
    expect(res.toolsRun).not.toContain('ckschemaparity');
    expect(res.notVerified).toContain(
      'upgrade path of widgets not verified: the parity run exited with 0',
    );
  });

  test('an issue that drops from blocking to advisory is not a new finding', () => {
    expect(
      newTaintFindings(
        parseTaintFindings(taintLine('ERROR')),
        parseTaintFindings(taintLine('INFO')),
      ),
    ).toEqual([]);
  });

  test('a PR that changes only tests of the extension runs no gate and leaves no note', async () => {
    const diff = `diff --git a/ext/widgets/tests/phpunit/WidgetTest.php b/ext/widgets/tests/phpunit/WidgetTest.php
--- a/ext/widgets/tests/phpunit/WidgetTest.php
+++ b/ext/widgets/tests/phpunit/WidgetTest.php
@@ -1,2 +1,3 @@
 <?php
+// one more case
 class WidgetTest {}
`;
    const res = await runGates(coreWorktrees(), ok, { diff, mountsB: [] });
    expect(res.calls).toEqual([]);
    expect(res.notVerified).toEqual([]);
  });

  test('an unchanged blocking issue that moved is not new when the base also has an advisory one', () => {
    const base = parseTaintFindings(taintAt('INFO', 3) + taintAt('ERROR', 9));
    const head = parseTaintFindings(taintAt('INFO', 3) + taintAt('ERROR', 12));
    expect(newTaintFindings(base, head)).toEqual([]);
  });

  test('an advisory issue that becomes blocking is a new finding', () => {
    const found = newTaintFindings(
      parseTaintFindings(taintLine('INFO')),
      parseTaintFindings(taintLine('ERROR')),
    );
    expect(found.map((f) => f.severity)).toEqual(['error']);
  });

  test('reads an issue in a path with spaces and issues written to stderr', async () => {
    const issue =
      'ERROR: TaintedSql - CRM/My Module/Page.php:5:1 - Detected tainted SQL (see https://psalm.dev/244)\n';
    expect(parseTaintFindings(issue).map((f) => f.path)).toEqual(['CRM/My Module/Page.php']);
    const res = await runGates(coreWorktrees(), async (gate, args) =>
      gate === 'taint' && args.some((a) => a.includes('/B/'))
        ? { exitCode: 2, stdout: 'Scanning files...\n', stderr: issue }
        : ok(),
    );
    expect(res.staticFindings.filter((f) => f.tool === 'cktaint')).toHaveLength(1);
  });

  test('a detected extension without a usable info.xml in the head is named as not checked', async () => {
    const wt = coreWorktrees();
    const res = await runGates(wt, ok, {
      repoInfo: { ...coreInfo(wt.b), bundledExtensions: ['ext/gone'] },
    });
    expect(res.calls).toEqual([]);
    expect(res.notVerified).toEqual([
      'ext/gone not checked: no info.xml with a valid key in the PR head',
    ]);
  });

  test('parity under a mount whose host path contains a colon still finds the parent mount', async () => {
    const wt = coreWorktrees();
    const res = await runGates(wt, ok, {
      mountsB: ['--mount', `/tmp/a:b/ext:/var/www/html/core/ext:ro`],
    });
    expect(res.calls.map((c) => c.gate)).not.toContain('parity');
  });

  test('bundled extensions beyond the limit are named as not checked', async () => {
    const wt = coreWorktrees();
    const res = await runGates(wt, ok, {
      repoInfo: { ...coreInfo(wt.b), bundledExtensions: ['ext/widgets', 'ext/b', 'ext/c'] },
    });
    expect(res.notVerified).toContain(
      'ext/c not checked: the extension gates run for the first 2 bundled extensions of a PR',
    );
  });

  test('a taint run that fails without an issue is not verified', async () => {
    const res = await runGates(coreWorktrees(), async (gate, args) => {
      if (gate !== 'taint') return ok();
      return args.some((a) => a.includes('/B/'))
        ? { exitCode: 2, stdout: '', stderr: 'cktaint: config not found: psalm.xml' }
        : ok();
    });
    expect(res.staticFindings.filter((f) => f.tool === 'cktaint')).toEqual([]);
    expect(res.toolsRun).not.toContain('cktaint');
    expect(res.notVerified).toContain(
      'ck taint failed for widgets (exit 2); static taint delta skipped.',
    );
  });
});
