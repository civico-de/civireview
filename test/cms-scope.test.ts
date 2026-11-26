import { describe, expect, test } from 'bun:test';
import { BrowserConfigSchema } from '../src/config/schema.ts';
import { computeFinalVerdict, unverifiedRuntimeChecks } from '../src/engine/findings.ts';
import { buildVerificationMatrix, computeConfidenceScore } from '../src/engine/matrix.ts';
import { cmsDemoProject, parseCmsDemoOutcome, runCmsDemos } from '../src/evidence/ab/cms-demo.ts';
import { discoverStandaloneRoutes } from '../src/evidence/browser-routes.ts';
import { cmsOfPath, cmsScope } from '../src/evidence/cms-scope.ts';
import { parseUnifiedDiff } from '../src/evidence/diff-filter.ts';
import type { CmsDemoResult, EvidenceBundle } from '../src/evidence/types.ts';
import { formatReviewMarkdown } from '../src/github/formatter.ts';
import { makeBundle } from './helpers/bundle.ts';
import { makeSampleBundle, makeSampleReview } from './helpers/review-fixtures.ts';

const patchOf = (paths: string[]) =>
  parseUnifiedDiff(
    paths
      .map(
        (p) => `diff --git a/${p} b/${p}
--- a/${p}
+++ b/${p}
@@ -1,2 +1,2 @@
 <?php
-$a = 1;
+$a = 2;
`,
      )
      .join(''),
  );

const JOOMLA_ONLY = [
  'CRM/Core/Permission/Joomla.php',
  'CRM/Utils/Hook/Joomla.php',
  'CRM/Utils/System/Joomla.php',
  'ext/authx/Civi/Authx/Joomla.php',
  'setup/plugins/installFiles/InstallJoomlaSettingsFile.civi-setup.php',
];

const browserPass = {
  probedRoutes: ['civicrm/admin/setting/misc'],
  probedAnonymousRoutes: [],
  screenshots: [],
  new_console_errors: [],
  new_page_errors: [],
  new_network_failures: [],
  new_a11y_violations: [],
  render_regressions: [],
  risk_flags: [],
};

function bundleOf(paths: string[], cmsDemos: CmsDemoResult[] = []): EvidenceBundle {
  const base = makeBundle();
  return makeBundle({
    diffFiles: patchOf(paths),
    abReport: { ...base.abReport, browserDiff: browserPass, cmsDemos },
  });
}

function judge(bundle: EvidenceBundle) {
  const { verificationMatrix, notVerified } = buildVerificationMatrix(bundle);
  const verdict = computeFinalVerdict([], verificationMatrix, 'core-bugfix');
  const score = computeConfidenceScore({
    verdict,
    findings: [],
    verificationMatrix,
    prKind: 'core-bugfix',
  });
  const row = (check: string) => verificationMatrix.find((m) => m.check === check);
  return { verdict, score, notVerified, row };
}

const demo = (status: CmsDemoResult['status']): CmsDemoResult => ({
  cms: 'joomla',
  status,
  detail: `Joomla: ${status}`,
  routes: ['civicrm/dashboard?reset=1'],
  newScriptErrors: [],
});

describe('cmsOfPath', () => {
  test('names the CMS integration of a path', () => {
    expect(cmsOfPath('CRM/Utils/System/Joomla.php')[0]?.cms).toBe('joomla');
    expect(cmsOfPath('css/wordpress.css')[0]?.cms).toBe('wordpress');
    expect(cmsOfPath('CRM/Utils/System/Drupal8.php')[0]?.cms).toBe('drupal10');
    expect(cmsOfPath('CRM/Utils/System/Backdrop.php')[0]?.cms).toBe('backdrop');
    expect(cmsOfPath('CRM/Utils/System/Drupal.php')).toEqual([{ label: 'Drupal 7' }]);
    // Drupal 7 and Backdrop extend the base class.
    expect(cmsOfPath('CRM/Utils/System/DrupalBase.php').map((h) => h.label)).toEqual([
      'Drupal',
      'Drupal 7',
      'Backdrop',
    ]);
  });

  test('shared and Standalone code belongs to no other CMS', () => {
    for (const path of [
      'CRM/Utils/System.php',
      'CRM/Utils/System/Base.php',
      'CRM/Utils/System/Standalone.php',
      'CRM/Contact/BAO/Contact.php',
      'ext/standaloneusers/Civi/Standalone/Security.php',
    ]) {
      expect(cmsOfPath(path)).toEqual([]);
    }
  });

  test('tests and docs do not make a change CMS-specific', () => {
    const scope = cmsScope(
      patchOf(['CRM/Contact/BAO/Contact.php', 'tests/phpunit/CRM/Core/Permission/JoomlaTest.php']),
    );
    expect(scope.labels).toEqual([]);
    expect(scope.onlyCms).toBe(false);
  });
});

describe('CMS-specific changes in the matrix and the score', () => {
  test('a change to shared code gets no CMS row and can be Ready 5/5', () => {
    const { verdict, score, row, notVerified } = judge(bundleOf(['CRM/Contact/BAO/Contact.php']));
    expect(row('CMS Browser A/B')).toBeUndefined();
    expect(row('Browser A/B (Standalone)')?.status).toBe('PASS');
    expect(notVerified).toEqual([]);
    expect(verdict).toBe('READY');
    expect(score.score).toBe(5);
  });

  test('a Joomla-only change that never ran on Joomla is not Ready', () => {
    const { verdict, score, row, notVerified } = judge(bundleOf(JOOMLA_ONLY));
    expect(row('CMS Browser A/B')).toMatchObject({
      status: 'NOT_VERIFIED',
      coversWholeChange: true,
    });
    // The Standalone page load cannot count for code Standalone never runs.
    expect(row('Browser A/B (Standalone)')?.status).toBe('SKIPPED');
    expect(notVerified.join(' ')).toContain('Joomla code did not run');
    expect(verdict).toBe('QUESTIONS_ONLY');
    expect(score.score).toBe(3);
    expect(score.rationale).toContain('CMS Browser A/B gave no result');
  });

  test('a run that gave no result leaves the Joomla-only change unverified', () => {
    const { verdict, score } = judge(bundleOf(JOOMLA_ONLY, [demo('NOT_VERIFIED')]));
    expect(verdict).toBe('QUESTIONS_ONLY');
    expect(score.score).toBe(3);
  });

  test('a clean run on Joomla makes the Joomla-only change Ready, capped at 4', () => {
    const { verdict, score, row, notVerified } = judge(bundleOf(JOOMLA_ONLY, [demo('PASS')]));
    expect(row('CMS Browser A/B')?.status).toBe('PASS');
    expect(notVerified).toEqual([]);
    expect(verdict).toBe('READY');
    // Page loads do not reach every changed path (installer, user sync).
    expect(score.score).toBe(4);
    expect(score.rationale).toContain('login and page loads only');
  });

  test('a CMS named by the configuration does not cap a change to shared code', () => {
    const { verdict, score } = judge(bundleOf(['CRM/Contact/BAO/Contact.php'], [demo('PASS')]));
    expect(verdict).toBe('READY');
    expect(score.score).toBe(5);
  });

  test('a failure on Joomla needs changes', () => {
    const { verdict, score } = judge(bundleOf(JOOMLA_ONLY, [demo('FAIL')]));
    expect(verdict).toBe('NEEDS_CHANGES');
    expect(score.score).toBe(2);
  });

  test('a mixed change without a Joomla run stays Ready, capped at 4', () => {
    const { verdict, score, row } = judge(
      bundleOf(['CRM/Contact/BAO/Contact.php', 'CRM/Utils/System/Joomla.php']),
    );
    expect(row('CMS Browser A/B')?.coversWholeChange).toBeUndefined();
    expect(row('Browser A/B (Standalone)')?.status).toBe('PASS');
    expect(verdict).toBe('READY');
    expect(score.score).toBe(4);
    expect(score.rationale).toContain('CMS-specific code did not run');
  });

  test('an extension repository gets no CMS row: nothing could record it', () => {
    const bundle = bundleOf(['src/WordPress.php']);
    const { row, verdict } = judge({
      ...bundle,
      repoInfo: { ...bundle.repoInfo, kind: 'civicrm-extension' },
    });
    expect(row('CMS Browser A/B')).toBeUndefined();
    expect(verdict).toBe('READY');
  });

  test('a CMS the configuration adds does not unverify a change whose own CMS ran', () => {
    const extra: CmsDemoResult = { ...demo('NOT_VERIFIED'), cms: 'wordpress' };
    const { verdict, row, notVerified } = judge(bundleOf(JOOMLA_ONLY, [demo('PASS'), extra]));
    expect(row('CMS Browser A/B')?.status).toBe('PASS');
    expect(row('CMS Browser A/B')?.detail).toContain('Joomla: NOT_VERIFIED');
    expect(notVerified).toEqual([]);
    expect(verdict).toBe('READY');
  });

  test('a configured CMS that gave no result does not cap a change to shared code', () => {
    const { verdict, score, row } = judge(
      bundleOf(['CRM/Contact/BAO/Contact.php'], [demo('NOT_VERIFIED')]),
    );
    expect(row('CMS Browser A/B')?.status).toBe('NOT_VERIFIED');
    expect(verdict).toBe('READY');
    expect(score.score).toBe(5);
  });

  test('a clean CMS run does not stand in for shared code that ran nowhere', () => {
    const mixed = ['CRM/Utils/System/Joomla.php', 'CRM/Contact/BAO/Contact.php'];
    const unverified = [
      { check: 'A/B Proof-of-Fix', status: 'NOT_VERIFIED' as const, detail: 'no result' },
      { check: 'CMS Browser A/B', status: 'PASS' as const, detail: 'Joomla: ok' },
    ];
    expect(mixed.map((p) => cmsOfPath(p).length)).toEqual([1, 0]);
    expect(unverifiedRuntimeChecks(unverified)).toEqual(['A/B Proof-of-Fix']);
  });

  test('Drupal 7 code has no image and stays unverified beside a Joomla run', () => {
    const { row } = judge(
      bundleOf(['CRM/Utils/System/Drupal.php', 'CRM/Utils/System/Joomla.php'], [demo('PASS')]),
    );
    expect(row('CMS Browser A/B')?.status).toBe('NOT_VERIFIED');
    expect(row('CMS Browser A/B')?.detail).toContain('Drupal 7 code did not run');
  });
});

describe('parseCmsDemoOutcome', () => {
  const routes = ['civicrm/dashboard?reset=1'];
  const recorded = 'ck demo: recording Joomla before\nck demo: recording Joomla after\n';

  test('a clean recording passes', () => {
    expect(
      parseCmsDemoOutcome('joomla', routes, { exitCode: 0, stdout: recorded, stderr: '' }),
    ).toMatchObject({ status: 'PASS', newScriptErrors: [] });
  });

  test('a script error only the change logs fails; one the base logs too does not', () => {
    const stdout =
      'ck demo: recording Joomla before\nck demo: Joomla before: 1 script errors\n  old\n' +
      'ck demo: recording Joomla after\nck demo: Joomla after: 2 script errors\n  old\n  new\n';
    expect(
      parseCmsDemoOutcome('joomla', routes, { exitCode: 0, stdout, stderr: '' }),
    ).toMatchObject({
      status: 'FAIL',
      newScriptErrors: ['new'],
      detail: expect.stringContaining('route(s): new'),
    });
  });

  test('a page that breaks once the change is applied fails', () => {
    const res = {
      exitCode: 1,
      stdout: recorded,
      stderr: 'ck: civicrm/dashboard?reset=1 shows no CiviCRM page on joomla (http://x)\n',
    };
    const out = parseCmsDemoOutcome('joomla', routes, res);
    expect(out.status).toBe('FAIL');
    expect(out.detail).toContain('shows no CiviCRM page');
  });

  test('a change that does not apply to the image proves nothing', () => {
    const res = {
      exitCode: 2,
      stdout: 'ck demo: starting Joomla at http://localhost:8300\n',
      stderr:
        'ck: the change does not apply to Joomla 6.20.2 (/home/buildkit/site):\nHunk #2 FAILED at 75.\n\nNothing was recorded.\n',
    };
    const out = parseCmsDemoOutcome('joomla', routes, res);
    expect(out.status).toBe('NOT_VERIFIED');
    expect(out.detail).toContain('the change does not apply to Joomla 6.20.2');
  });

  test('a second recording that breaks for another reason proves nothing', () => {
    const res = {
      exitCode: 1,
      stdout: recorded,
      stderr: 'ck: recording joomla-after failed (exit 125)\n',
    };
    expect(parseCmsDemoOutcome('joomla', routes, res).status).toBe('NOT_VERIFIED');
  });

  test('a failure while recording the base proves nothing', () => {
    const res = { exitCode: 1, stdout: 'ck demo: recording Joomla before\n', stderr: 'ck: boom\n' };
    expect(parseCmsDemoOutcome('joomla', routes, res).status).toBe('NOT_VERIFIED');
  });
});

const discover = (patch: string, prBody?: string) =>
  discoverStandaloneRoutes({
    diffFiles: parseUnifiedDiff(patch),
    prBody,
    config: { browser: BrowserConfigSchema.parse({}) },
  });

describe('runCmsDemos', () => {
  test('names the project as ck demo does', () => {
    expect(cmsDemoProject('/w/run-Ab3x/cr-run-Ab3x.patch', 'joomla')).toBe(
      'ck-demo-cr-run-ab3x-joomla',
    );
  });

  test('removes the stack of a run that broke, and of no run that finished', async () => {
    const calls: string[][] = [];
    const run = (exitCode: number) =>
      runCmsDemos({
        execFn: async (args) => {
          calls.push(args);
          return { exitCode, stdout: '', stderr: '', timedOut: exitCode !== 0 };
        },
        ckCommand: ['ck'],
        patchFile: '/w/run-Ab3x/cr-run-Ab3x.patch',
        outRoot: `${process.env.TMPDIR ?? '/tmp'}/civireview-cms-test`,
        cms: ['joomla'],
        routes: ['civicrm/dashboard?reset=1'],
      });
    await run(0);
    expect(calls.map((c) => c[0])).toEqual(['ck']);
    calls.length = 0;
    const [result] = await run(124);
    expect(calls.map((c) => c.slice(0, 5).join(' '))).toEqual([
      'ck demo /w/run-Ab3x/cr-run-Ab3x.patch --cms joomla',
      'docker compose -p ck-demo-cr-run-ab3x-joomla down',
    ]);
    expect(result?.status).toBe('NOT_VERIFIED');
    // The teardown failed here too (the stub answers 124 to every command).
    expect(result?.detail).toContain('ck-demo-cr-run-ab3x-joomla could not be removed (exit 124)');
  });
});

describe('route mentions', () => {
  const head = `diff --git a/CRM/Utils/System/Joomla.php b/CRM/Utils/System/Joomla.php
--- a/CRM/Utils/System/Joomla.php
+++ b/CRM/Utils/System/Joomla.php
@@ -1,3 +1,3 @@
`;

  const context = `${head}     if (!str_contains($path, 'civicrm/payment/ipn')) {\n-$a = 1;\n+$a = 2;\n`;

  test('a route on an unchanged line is loaded but does not count for the change', () => {
    expect(discover(context)).toMatchObject({
      pages: ['civicrm/payment/ipn'],
      contextOnly: true,
    });
  });

  test('a route on an added line counts', () => {
    expect(
      discover(`${head} <?php\n-$a = 1;\n+$url = 'civicrm/admin/setting/misc';\n`),
    ).toMatchObject({ pages: ['civicrm/admin/setting/misc'], contextOnly: false });
  });

  test('a route another file adds counts, also when it was first seen as context', () => {
    const second = `diff --git a/CRM/Foo.php b/CRM/Foo.php
--- a/CRM/Foo.php
+++ b/CRM/Foo.php
@@ -1,2 +1,2 @@
 <?php
-$a = 1;
+$url = 'civicrm/payment/ipn';
`;
    expect(discover(context + second).contextOnly).toBe(false);
  });

  test('a route an extension declares for its changed UI counts', () => {
    const tpl = `diff --git a/ext/foo/templates/Foo.tpl b/ext/foo/templates/Foo.tpl
--- a/ext/foo/templates/Foo.tpl
+++ b/ext/foo/templates/Foo.tpl
@@ -1,2 +1,2 @@
 <a href="{crmURL p='civicrm/foo/list'}">
-<b>a</b>
+<b>b</b>
`;
    const diffFiles = parseUnifiedDiff(tpl);
    const found = (
      extensionRouteSources?: Parameters<
        typeof discoverStandaloneRoutes
      >[0]['extensionRouteSources'],
    ) =>
      discoverStandaloneRoutes({
        diffFiles,
        extensionRouteSources,
        config: { browser: BrowserConfigSchema.parse({}) },
      }).contextOnly;
    expect(found()).toBe(true);
    expect(
      found([
        {
          repoPrefix: 'ext/foo/',
          files: [{ path: 'ext/foo/xml/Menu/foo.xml', content: '<path>civicrm/foo/list</path>' }],
        },
      ]),
    ).toBe(false);
  });

  test('a route the PR description names counts, also when the diff has it as context', () => {
    expect(discover(context, 'Test on civicrm/payment/ipn').contextOnly).toBe(false);
  });
});

describe('review text', () => {
  test('a merge condition from the PR description leads the action items', () => {
    const review = {
      ...makeSampleReview(),
      findings: [],
      mergeConditions: ['Do not merge before CiviCRM 6.23 (Feb 2027): removes Joomla 3 support.'],
    };
    const body = formatReviewMarkdown(review, makeSampleBundle()).summaryBody;
    expect(body).toContain(
      '- [ ] **Merge condition** (from the PR description): Do not merge before CiviCRM 6.23',
    );
    expect(body).not.toContain('No findings above the confidence gate.');
  });

  test('a review without conditions lists none and names what it leaves out', () => {
    const body = formatReviewMarkdown(
      { ...makeSampleReview(), findings: [] },
      makeSampleBundle(),
    ).summaryBody;
    expect(body).not.toContain('Merge condition');
    expect(body).toContain('**Outside this review:** any CMS other than Standalone;');
  });

  test('a review whose checks gave no result does not claim Standalone', () => {
    const review = makeSampleReview();
    const body = formatReviewMarkdown(
      {
        ...review,
        findings: [],
        verificationMatrix: review.verificationMatrix.map((row) => ({
          ...row,
          status: 'NOT_VERIFIED' as const,
        })),
      },
      makeSampleBundle(),
    ).summaryBody;
    expect(body).toContain('**Outside this review:** behaviour on a running site;');
  });
});
