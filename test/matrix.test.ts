import { describe, expect, test } from 'bun:test';
import {
  buildShortSummary,
  buildVerificationMatrix,
  computeConfidenceScore,
  mergeStandards,
  reconcileMatrixForTriage,
} from '../src/engine/matrix.ts';
import type {
  TriageOutput,
  VerificationMatrixEntry,
  VerifiedFinding,
} from '../src/engine/schemas.ts';
import type { EvidenceBundle } from '../src/evidence/types.ts';
import { makeBundle } from './helpers/bundle.ts';

type AbCheck = EvidenceBundle['abReport']['checks'][number];

function bundleWithChecks(checks: Array<Partial<AbCheck>>, over: Partial<EvidenceBundle> = {}) {
  const base = makeBundle();
  const template = base.abReport.checks[0]!;
  return makeBundle({
    abReport: {
      ...base.abReport,
      checks: checks.map((c) => ({ ...template, ...c })),
    },
    ...over,
  });
}

const entry = (
  check: string,
  status: VerificationMatrixEntry['status'],
  detail = '',
): VerificationMatrixEntry => ({
  check,
  status,
  detail,
});

const finding = (
  id: string,
  verdict: VerifiedFinding['verdict'],
  severity: VerifiedFinding['severity'],
): VerifiedFinding => ({
  id,
  lens: 'correctness',
  title: `Finding ${id}`,
  severity,
  reassessedSeverity: severity,
  verdict,
  confidence: 90,
  verificationEvidence: 'checked',
  path: 'a.php',
  startLine: 1,
  endLine: 1,
  side: 'RIGHT',
  issue: 'issue',
  failureScenario: 'scenario',
  evidence: 'evidence',
  suggestedFix: 'fix',
  mcpCitations: [],
});

const rowOf = (bundle: EvidenceBundle, check: string) =>
  buildVerificationMatrix(bundle).verificationMatrix.find((m) => m.check === check);

const ci = (overallState: EvidenceBundle['ciStatus']['overallState'], extra = {}) =>
  makeBundle({
    ciStatus: {
      overallState,
      checks: [{ name: 'lint', state: 'success' }],
      jenkinsFailedTests: [],
      summary: 'summary',
      ...extra,
    },
  });

const withLive = (live: object) => {
  const base = makeBundle();
  return makeBundle({
    abReport: {
      ...base.abReport,
      surfaceDiff: { ...base.abReport.surfaceDiff, liveSurfaceDiff: live as never },
    },
  });
};

const staticFinding = (severity: string) => ({ severity }) as never;

const browser = (over: object) => {
  const base = makeBundle();
  return makeBundle({
    abReport: {
      ...base.abReport,
      browserDiff: {
        probedRoutes: ['civicrm/dashboard'],
        probedAnonymousRoutes: [],
        screenshots: [],
        new_console_errors: [],
        new_page_errors: [],
        new_network_failures: [],
        new_a11y_violations: [],
        render_regressions: [],
        ...over,
      } as never,
    },
  });
};

const triage = (over: Partial<TriageOutput>): TriageOutput => ({
  prKind: 'core-bugfix',
  riskLevel: 'low',
  activeLenses: ['correctness'],
  summaryBullets: [],
  recommendedAbTests: [],
  ...over,
});

describe('buildVerificationMatrix: CI row', () => {
  test('maps overall state to PASS / FAIL / WARN / NOT_VERIFIED', () => {
    expect(rowOf(ci('success'), 'CI / Jenkins')?.status).toBe('PASS');
    expect(rowOf(ci('failure'), 'CI / Jenkins')?.status).toBe('FAIL');
    expect(rowOf(ci('pending'), 'CI / Jenkins')?.status).toBe('WARN');
    expect(rowOf(ci('unknown'), 'CI / Jenkins')?.status).toBe('NOT_VERIFIED');
    expect(rowOf(ci('success', { checks: [] }), 'CI / Jenkins')?.status).toBe('NOT_VERIFIED');
  });

  test('lists at most five failed Jenkins tests', () => {
    const tests = Array.from({ length: 8 }, (_, i) => `T${i + 1}`);
    const detail = rowOf(ci('failure', { jenkinsFailedTests: tests }), 'CI / Jenkins')!.detail;
    expect(detail).toContain('failed tests: T1, T2, T3, T4, T5');
    expect(detail).not.toContain('T6');
  });
});

describe('buildVerificationMatrix: A/B rows', () => {
  test('a regression or FAIL status fails the proof of fix, labelled by repo kind', () => {
    const core = bundleWithChecks([
      { status: 'FAIL', regressions: ['FooTest::testBar'], fixed: [] },
    ]);
    expect(rowOf(core, 'A/B Proof-of-Fix')?.status).toBe('FAIL');

    const ext = bundleWithChecks([{ status: 'FAIL', fixed: [] }], {
      repoInfo: { ...core.repoInfo, kind: 'civicrm-extension' },
    });
    expect(rowOf(ext, 'CiviKitchen A/B Proof-of-Fix')?.status).toBe('FAIL');
  });

  test('exit-status mode passes when base fails and the PR passes', () => {
    const b = bundleWithChecks([
      { mode: 'exit-status', exitCodeA: 1, exitCodeB: 0, status: 'PASS', fixed: [], summary: 's' },
    ]);
    expect(rowOf(b, 'A/B Proof-of-Fix')).toMatchObject({
      status: 'PASS',
      detail: expect.stringContaining('failed on base (exit 1), passed on PR (exit 0)'),
    });
  });

  test('tests failing on both sides only warn, an internal runner error is not verified', () => {
    const both = bundleWithChecks([{ status: 'PASS', fixed: [], bothFail: ['X::y'] }]);
    expect(rowOf(both, 'A/B Proof-of-Fix')?.status).toBe('WARN');

    const err = bundleWithChecks([{ status: 'ERROR', fixed: [] }]);
    expect(rowOf(err, 'A/B Proof-of-Fix')).toMatchObject({
      status: 'NOT_VERIFIED',
      detail: expect.stringContaining('not a PR failure'),
    });
  });

  test('a skipped proof is shown for extensions but omitted for core', () => {
    const core = bundleWithChecks([{ status: 'SKIPPED', fixed: [] }]);
    expect(rowOf(core, 'A/B Proof-of-Fix')).toBeUndefined();

    const ext = bundleWithChecks([{ status: 'SKIPPED', fixed: [] }], {
      repoInfo: { ...core.repoInfo, kind: 'civicrm-extension' },
    });
    expect(rowOf(ext, 'CiviKitchen A/B Proof-of-Fix')?.status).toBe('SKIPPED');
  });

  test('without any check the row reflects whether A/B ran at all', () => {
    const base = makeBundle();
    const notRun = makeBundle({ abReport: { ...base.abReport, executed: false, checks: [] } });
    expect(rowOf(notRun, 'A/B Proof-of-Fix')).toMatchObject({
      status: 'NOT_VERIFIED',
      detail: 'A/B test run did not execute.',
    });
    expect(rowOf(notRun, 'Base-Test Regression')?.status).toBe('NOT_VERIFIED');

    const noTarget = makeBundle({
      abReport: { ...base.abReport, executed: true, checks: [] },
      repoInfo: { ...base.repoInfo, kind: 'civicrm-extension' },
    });
    expect(rowOf(noTarget, 'CiviKitchen A/B Proof-of-Fix')).toMatchObject({
      status: 'SKIPPED',
      detail: 'No PR test file triggered proof-of-fix run.',
    });
  });

  test('base-test regression: failures list the tests, PASS and ERROR are mapped', () => {
    const fail = bundleWithChecks([
      { name: 'base-test-regression', status: 'FAIL', regressions: ['A::a', 'B::b'], fixed: [] },
    ]);
    expect(rowOf(fail, 'Base-Test Regression')).toMatchObject({
      status: 'FAIL',
      detail: expect.stringContaining('A::a, B::b'),
    });
    expect(
      rowOf(
        bundleWithChecks([{ name: 'floor-vs-beta-matrix', status: 'PASS', fixed: [] }]),
        'Base-Test Regression',
      )?.status,
    ).toBe('PASS');
    expect(
      rowOf(
        bundleWithChecks([{ name: 'base-test-regression', status: 'ERROR', fixed: [] }]),
        'Base-Test Regression',
      )?.status,
    ).toBe('NOT_VERIFIED');
  });
});

describe('buildVerificationMatrix: surface, static, browser and demo rows', () => {
  const base = makeBundle();

  test('live surface diff: capture error and risk flags warn, a clean capture passes', () => {
    expect(rowOf(withLive({ error: 'boom', risk_flags: [] }), 'Live Surface Diff')).toMatchObject({
      status: 'WARN',
      detail: 'Live capture failed: boom',
    });
    expect(
      rowOf(
        withLive({ risk_flags: [{ code: 'perm-removed', target: 'Foo.get' }] }),
        'Live Surface Diff',
      )?.detail,
    ).toContain('perm-removed(Foo.get)');
    expect(rowOf(withLive({ risk_flags: [] }), 'Live Surface Diff')?.status).toBe('PASS');
  });

  test('static delta: errors fail, other findings warn, not executed is omitted on core', () => {
    const staticWith = (over: object) =>
      makeBundle({ staticDelta: { ...base.staticDelta, ...over } });
    expect(
      rowOf(staticWith({ findings: [staticFinding('error')] }), 'Static / Taint Delta')?.status,
    ).toBe('FAIL');
    expect(
      rowOf(staticWith({ findings: [staticFinding('warning')] }), 'Static / Taint Delta')?.status,
    ).toBe('WARN');
    expect(rowOf(staticWith({ executed: false }), 'Static / Taint Delta')).toBeUndefined();
    expect(
      rowOf(
        makeBundle({
          staticDelta: { ...base.staticDelta, executed: false },
          repoInfo: { ...base.repoInfo, kind: 'civicrm-extension' },
        }),
        'Static / Taint Delta',
      )?.status,
    ).toBe('NOT_VERIFIED');
  });

  test('browser A/B: runtime regressions fail, accessibility alone warns, no regressions pass', () => {
    const label = 'Browser A/B (Standalone)';
    expect(rowOf(browser({ new_console_errors: ['x'] }), label)?.status).toBe('FAIL');
    expect(rowOf(browser({ new_a11y_violations: ['x'] }), label)?.status).toBe('WARN');
    expect(rowOf(browser({}), label)?.status).toBe('PASS');
    expect(rowOf(browser({ error: 'no browser' }), label)).toMatchObject({
      status: 'NOT_VERIFIED',
      detail: 'Standalone browser A/B failed: no browser',
    });
  });

  test('demo row appears only when a demo ran, and fails on console errors', () => {
    expect(rowOf(base, 'Demo')).toBeUndefined();
    const demo = (errors: string[]) =>
      makeBundle({
        abReport: { ...base.abReport, demoArtifactsDir: '/out/demo', demoConsoleErrors: errors },
      });
    expect(rowOf(demo([]), 'Demo')?.status).toBe('PASS');
    expect(rowOf(demo(['TypeError']), 'Demo')?.status).toBe('FAIL');
  });

  test('not-verified list merges bundle entries with unverified surfaces without duplicates', () => {
    const b = makeBundle({
      notVerified: ['a', 'b'],
      abReport: {
        ...base.abReport,
        surfaceDiff: { ...base.abReport.surfaceDiff, unverifiedSurfaces: ['b', 'c'] },
      },
    });
    expect(buildVerificationMatrix(b).notVerified).toEqual(['a', 'b', 'c']);
  });
});

describe('reconcileMatrixForTriage', () => {
  test('a flaky-assessed Jenkins failure is downgraded to WARN with the reason', () => {
    const [row] = reconcileMatrixForTriage(
      [entry('CI / Jenkins', 'FAIL', 'red')],
      triage({ ciFailureAssessment: 'likely-flaky', ciFailureReason: ' unrelated timing test ' }),
    );
    expect(row).toMatchObject({
      status: 'WARN',
      detail: 'red — likely unrelated flake: unrelated timing test',
    });
  });

  test('a failure assessed as related stays FAIL', () => {
    const [row] = reconcileMatrixForTriage(
      [entry('CI / Jenkins', 'FAIL', 'red')],
      triage({ ciFailureAssessment: 'related' }),
    );
    expect(row?.status).toBe('FAIL');
  });

  test('on a refactor PR, tests passing on both sides prove preserved behaviour', () => {
    const rows = [
      entry(
        'A/B Proof-of-Fix',
        'WARN',
        '3 tests passed on both (no fail-to-pass transition observed)',
      ),
      entry('CiviKitchen A/B Proof-of-Fix', 'WARN', 'x passed on both, tautological'),
    ];
    const [plain, tautological] = reconcileMatrixForTriage(
      rows,
      triage({ prKind: 'core-ref-nfc' }),
    );
    expect(plain).toMatchObject({
      status: 'PASS',
      detail: '3 tests passed on both (NFC/refactor: behavior preserved)',
    });
    expect(tautological?.status).toBe('WARN');

    const [bugfix] = reconcileMatrixForTriage(rows.slice(0, 1), triage({ prKind: 'core-bugfix' }));
    expect(bugfix?.status).toBe('WARN');
  });
});

describe('mergeStandards', () => {
  test('keeps the strictest verdict per canonical code and drops unknown codes', () => {
    const merged = mergeStandards([
      [
        { code: 'R-Test', status: 'PASS', note: 'a' },
        { code: 'made-up', status: 'ISSUE', note: 'x' },
      ],
      undefined,
      [
        { code: 'r-test', status: 'ISSUE', note: 'b' },
        { code: 'r-doc', status: 'N/A', note: 'c' },
      ],
    ]);
    expect(merged).toEqual([
      { code: 'r-test', status: 'ISSUE', note: 'b' },
      { code: 'r-doc', status: 'N/A', note: 'c' },
    ]);
    expect(
      mergeStandards([undefined, [{ code: 'nope', status: 'PASS', note: '' }]]),
    ).toBeUndefined();
  });
});

describe('computeConfidenceScore rationale', () => {
  test('names the cap that decides the score even when many weaker reasons exist', () => {
    const result = computeConfidenceScore({
      verdict: 'NEEDS_CHANGES',
      findings: [
        finding('m', 'CONFIRMED', 'medium'),
        finding('q', 'NEEDS_QUESTION', 'high'),
        finding('l', 'CONFIRMED', 'low'),
      ],
      verificationMatrix: [entry('CI / Jenkins', 'FAIL', 'red')],
    });

    expect(result.score).toBe(2);
    expect(result.rationale.split(';')[0]).toContain('CI / Jenkins failed');
  });

  test('lists the strictest reasons first and at most three', () => {
    const result = computeConfidenceScore({
      verdict: 'NEEDS_CHANGES',
      findings: [finding('c', 'PROVEN', 'critical'), finding('l', 'CONFIRMED', 'low')],
      verificationMatrix: [entry('CI / Jenkins', 'FAIL'), entry('Static / Taint Delta', 'FAIL')],
    });

    expect(result.score).toBe(1);
    expect(result.rationale).toBe(
      '1 confirmed critical finding(s); CI / Jenkins failed; Static / Taint delta introduced new errors.',
    );
  });

  test('a clean review scores 5 and names the passed checks', () => {
    const result = computeConfidenceScore({
      verdict: 'READY',
      findings: [],
      verificationMatrix: [entry('CI / Jenkins', 'PASS'), entry('Live Surface Diff', 'PASS')],
    });
    expect(result).toEqual({
      score: 5,
      rationale: 'No verified issues; passed CI / Jenkins, Live Surface Diff.',
    });
  });
});

describe('buildShortSummary', () => {
  test('combines triage summary, the A/B proof and the top finding', () => {
    const summary = buildShortSummary({
      triageSummary: 'Fixes the lookup',
      findings: [finding('a', 'CONFIRMED', 'high'), finding('b', 'CONFIRMED', 'low')],
      verificationMatrix: [
        entry('A/B Proof-of-Fix', 'PASS', '2 test(s) failed on base, passed on PR'),
      ],
      scoreRationale: 'ignored',
    });
    expect(summary).toBe(
      'Fixes the lookup. A/B testing proved 2 test(s) failed on base, passed on PR. 2 verified finding(s) — top: [HIGH] Finding a (+1 more).',
    );
  });

  test('falls back to the PR title, then to the score rationale', () => {
    expect(
      buildShortSummary({
        prTitle: 'Fix thing.',
        findings: [],
        verificationMatrix: [],
        scoreRationale: 'r',
      }),
    ).toBe('Changes: Fix thing.');
    expect(
      buildShortSummary({ findings: [], verificationMatrix: [], scoreRationale: 'Nothing found.' }),
    ).toBe('Nothing found.');
  });
});

const highFinding = (verdict: string) =>
  ({ verdict, reassessedSeverity: 'high', confidence: 90 }) as never as VerifiedFinding;

describe('browser smoke probe and score basis', () => {
  test('a clean dashboard-only probe is not verified, a clean probe of a real route passes', () => {
    const smoke = rowOf(browser({ smokeOnly: true }), 'Browser A/B (Standalone)')!;
    expect(smoke.status).toBe('NOT_VERIFIED');
    expect(smoke.detail).toContain('--page <route>');
    expect(rowOf(browser({}), 'Browser A/B (Standalone)')?.status).toBe('PASS');
  });

  test('a regression on the dashboard still fails a smoke-only probe', () => {
    expect(
      rowOf(browser({ smokeOnly: true, new_page_errors: ['boom'] }), 'Browser A/B (Standalone)')
        ?.status,
    ).toBe('FAIL');
  });

  test('the rationale says whether the deciding finding was reproduced or only read', () => {
    const read = computeConfidenceScore({
      verdict: 'NEEDS_CHANGES',
      findings: [highFinding('CONFIRMED')],
      verificationMatrix: [],
    });
    expect(read.score).toBe(2);
    expect(read.rationale).toContain('from reading the code, not reproduced in a run');
    const proven = computeConfidenceScore({
      verdict: 'NEEDS_CHANGES',
      findings: [highFinding('PROVEN')],
      verificationMatrix: [],
    });
    expect(proven.score).toBe(2);
    expect(proven.rationale).not.toContain('from reading the code');
  });
});
