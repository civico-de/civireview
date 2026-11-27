import type { EffortLevel, ResolvedCiviReviewConfig } from '../config/schema.ts';
import type { EvidenceBundle } from '../evidence/types.ts';
import type {
  CandidateFinding,
  ConfidenceScore,
  FinalVerdict,
  PrKind,
  StandardVerdict,
  ThreadResolution,
  TriageOutput,
  VerificationMatrixEntry,
  VerifiedFinding,
} from './schemas.ts';
import { cmsScope } from '../evidence/cms-scope.ts';
import { CMS_CHECK, isConfirmedFinding, unverifiedRuntimeChecks } from './findings.ts';

export const CANONICAL_STANDARD_CODES = new Set<string>([
  'r-explain',
  'r-user',
  'r-doc',
  'r-run',
  'r-tech',
  'r-code',
  'r-maint',
  'r-test',
  'rg-pkg',
  'rg-perm',
  'rg-sec',
  'rg-setting',
  'rg-upgrades',
  'rg-hook',
]);

export function mergeStandards(
  lists: Array<StandardVerdict[] | undefined>,
): StandardVerdict[] | undefined {
  const byCode = new Map<string, StandardVerdict>();
  const rank: Record<StandardVerdict['status'], number> = {
    ISSUE: 3,
    PASS: 2,
    'N/A': 1,
  };

  for (const list of lists) {
    if (!list) continue;
    for (const item of list) {
      const code = item.code.trim().toLowerCase();
      if (!CANONICAL_STANDARD_CODES.has(code)) continue;
      const normalized: StandardVerdict = { ...item, code };
      const existing = byCode.get(code);
      if (!existing || rank[normalized.status] > rank[existing.status]) {
        byCode.set(code, normalized);
      }
    }
  }

  return byCode.size > 0 ? Array.from(byCode.values()) : undefined;
}

export function adoptReconciledStandards(
  base: StandardVerdict[] | undefined,
  reconciled: StandardVerdict[] | undefined,
): StandardVerdict[] | undefined {
  if (!reconciled || reconciled.length === 0) return base;
  const byCode = new Map<string, StandardVerdict>();

  for (const item of base ?? []) {
    const code = item.code.trim().toLowerCase();
    if (CANONICAL_STANDARD_CODES.has(code)) {
      byCode.set(code, { ...item, code });
    }
  }
  for (const item of reconciled) {
    const code = item.code.trim().toLowerCase();
    if (CANONICAL_STANDARD_CODES.has(code)) {
      byCode.set(code, { ...item, code });
    }
  }

  return byCode.size > 0 ? Array.from(byCode.values()) : undefined;
}

export function isStandardBackedByMatrixFail(
  code: string,
  verificationMatrix: VerificationMatrixEntry[],
): boolean {
  const failedChecks = new Set(
    verificationMatrix.filter((m) => m.status === 'FAIL').map((m) => m.check),
  );
  if (failedChecks.size === 0) return false;
  switch (code) {
    case 'r-run':
      return (
        failedChecks.has('CI / Jenkins') ||
        failedChecks.has('A/B Proof-of-Fix') ||
        failedChecks.has('CiviKitchen A/B Proof-of-Fix') ||
        failedChecks.has('Base-Test Regression') ||
        failedChecks.has('Version Matrix') ||
        failedChecks.has('Browser A/B (Standalone)') ||
        failedChecks.has('Demo')
      );
    case 'r-test':
      return failedChecks.has('CI / Jenkins') || failedChecks.has('Base-Test Regression');
    case 'r-maint':
      return (
        failedChecks.has('A/B Proof-of-Fix') ||
        failedChecks.has('CiviKitchen A/B Proof-of-Fix') ||
        failedChecks.has('Base-Test Regression')
      );
    case 'rg-sec':
      return failedChecks.has('Static / Taint Delta');
    case 'r-code':
      return (
        failedChecks.has('Static / Taint Delta') || failedChecks.has('Browser A/B (Standalone)')
      );
    default:
      return false;
  }
}

export function reconcileStandardsDeterministically(params: {
  standards: StandardVerdict[] | undefined;
  verdict: FinalVerdict;
  survivingFindings: VerifiedFinding[];
  verificationMatrix: VerificationMatrixEntry[];
}): StandardVerdict[] | undefined {
  const { standards, verdict, survivingFindings, verificationMatrix } = params;
  if (!standards || standards.length === 0) return undefined;

  const byCode = new Map<string, StandardVerdict>();
  for (const item of standards) {
    const code = item.code.trim().toLowerCase();
    if (CANONICAL_STANDARD_CODES.has(code)) {
      byCode.set(code, { ...item, code });
    }
  }
  if (byCode.size === 0) return undefined;

  // Runs before the measured issues below are set, which no missing finding can clear.
  if (verdict === 'NO_ISSUES_FOUND' && survivingFindings.length === 0) {
    for (const [code, item] of byCode.entries()) {
      if (item.status === 'ISSUE' && !isStandardBackedByMatrixFail(code, verificationMatrix)) {
        byCode.set(code, {
          ...item,
          status: 'PASS',
          note: `${item.note} (Reconciled: no surviving verified findings.)`,
        });
      }
    }
  }

  return Array.from(byCode.values());
}

type AbCheck = EvidenceBundle['abReport']['checks'][number];

const NO_FAIL_TO_PASS = ' (no fail-to-pass transition observed)';

/** Row of a check that runs the same tests on two sides and looks for pass-to-fail. */
function regressionRow(
  label: string,
  check: AbCheck,
  hideSkipped: boolean,
  mergePrefix = '',
): VerificationMatrixEntry | undefined {
  const pairPrefix =
    mergePrefix + (check.imageA !== check.imageB ? `${check.imageA} vs ${check.imageB}: ` : '');
  if (check.regressions.length > 0 || check.status === 'FAIL') {
    return {
      check: label,
      status: 'FAIL',
      detail: `${pairPrefix}${check.regressions.slice(0, 5).join(', ') || check.summary}`,
    };
  }
  if (check.status === 'ERROR') {
    return {
      check: label,
      status: 'NOT_VERIFIED',
      detail: `${pairPrefix}The test run gave no usable result (not a PR failure): ${check.summary}`,
    };
  }
  if (check.status === 'SKIPPED' && hideSkipped) return undefined;
  return { check: label, status: check.status, detail: `${pairPrefix}${check.summary}` };
}

/**
 * Deterministically builds the Empirical Verification Matrix from Layer 1 evidence.
 */
export function buildVerificationMatrix(bundle: EvidenceBundle): {
  verificationMatrix: VerificationMatrixEntry[];
  notVerified: string[];
} {
  const matrix: VerificationMatrixEntry[] = [];

  // 1. CI / Jenkins
  const ci = bundle.ciStatus;
  if (ci.checks.length === 0) {
    matrix.push({
      check: 'CI / Jenkins',
      status: 'NOT_VERIFIED',
      detail: ci.summary,
    });
  } else if (ci.overallState === 'success') {
    matrix.push({
      check: 'CI / Jenkins',
      status: 'PASS',
      detail: ci.summary,
    });
  } else if (ci.overallState === 'failure') {
    const failedList =
      ci.jenkinsFailedTests.length > 0
        ? ` — failed tests: ${ci.jenkinsFailedTests.slice(0, 5).join(', ')}`
        : '';
    matrix.push({
      check: 'CI / Jenkins',
      status: 'FAIL',
      detail: `${ci.summary}${failedList}`,
    });
  } else if (ci.overallState === 'pending') {
    matrix.push({
      check: 'CI / Jenkins',
      status: 'WARN',
      detail: ci.summary,
    });
  } else {
    matrix.push({
      check: 'CI / Jenkins',
      status: 'NOT_VERIFIED',
      detail: ci.summary,
    });
  }

  const isCore = bundle.repoInfo.kind === 'civicrm-core';
  // CiviKitchen A/B never applies to a generic repository, whether or not it could start.
  const notRun = (check: string, detail: string): VerificationMatrixEntry =>
    bundle.repoInfo.kind === 'generic'
      ? {
          check,
          status: 'SKIPPED',
          detail: 'CiviKitchen A/B does not apply to a generic repository.',
        }
      : { check, status: 'NOT_VERIFIED', detail };
  const proofCheckLabel = isCore ? 'A/B Proof-of-Fix' : 'CiviKitchen A/B Proof-of-Fix';

  const merge = bundle.abReport.testedMerge;
  const mergePrefix = merge ? `PR merged into ${merge.base.slice(0, 10)}: ` : '';

  // 2. A/B Proof-of-Fix
  const proofCheck = bundle.abReport.checks.find((c) => c.name === 'proof-of-fix');
  if (proofCheck) {
    const pairPrefix =
      mergePrefix +
      (proofCheck.imageA !== proofCheck.imageB
        ? `${proofCheck.imageA} vs ${proofCheck.imageB}: `
        : '');
    const basePassing = proofCheck.basePassingTests ?? [];
    if (proofCheck.regressions.length > 0 || proofCheck.status === 'FAIL') {
      matrix.push({
        check: proofCheckLabel,
        status: 'FAIL',
        detail: `${pairPrefix}${proofCheck.summary}`,
      });
    } else if (proofCheck.fixed.length > 0 && proofCheck.status === 'PASS') {
      const guardSuffix =
        basePassing.length > 0
          ? isCore
            ? ` (+${basePassing.length} regression-guard test(s) passed on both base & PR: ${basePassing.map((t) => t.method).join(', ')})`
            : ` (+${basePassing.length} regression-guard test(s) passed on both A & B: ${basePassing.map((t) => t.method).join(', ')})`
          : '';
      matrix.push({
        check: proofCheckLabel,
        status: 'PASS',
        detail: isCore
          ? `${pairPrefix}${proofCheck.fixed.length} test(s) failed on base, passed on PR${guardSuffix}`
          : `${pairPrefix}${proofCheck.fixed.length} test(s) red on A, green on B${guardSuffix}`,
      });
    } else if (
      basePassing.length > 0 &&
      proofCheck.status === 'PASS' &&
      proofCheck.bothFail.length === 0
    ) {
      const names = basePassing.map((t) => `${t.method} (${t.file}:${t.line})`).join(', ');
      matrix.push({
        check: proofCheckLabel,
        status: 'WARN',
        detail: `${pairPrefix}${basePassing.length} added test method(s) pass on base and PR: ${names}${NO_FAIL_TO_PASS}`,
        noFailToPass: true,
      });
    } else if (
      proofCheck.status === 'PASS' &&
      proofCheck.mode === 'exit-status' &&
      proofCheck.exitCodeA !== undefined &&
      proofCheck.exitCodeA !== 0 &&
      proofCheck.exitCodeB === 0
    ) {
      matrix.push({
        check: proofCheckLabel,
        status: 'PASS',
        detail: `${pairPrefix}failed on base (exit ${proofCheck.exitCodeA}), passed on PR (exit 0)`,
      });
    } else if (proofCheck.bothFail.length > 0) {
      matrix.push({
        check: proofCheckLabel,
        status: 'WARN',
        detail: `${pairPrefix}${proofCheck.bothFail.length} test(s) fail on both base and PR`,
      });
    } else if (proofCheck.status === 'SKIPPED') {
      if (!isCore) {
        matrix.push({
          check: proofCheckLabel,
          status: 'SKIPPED',
          detail: `${pairPrefix}${proofCheck.summary}`,
        });
      }
    } else if (proofCheck.status === 'ERROR') {
      matrix.push({
        check: proofCheckLabel,
        status: 'NOT_VERIFIED',
        detail: `${pairPrefix}The test run gave no usable result (not a PR failure): ${proofCheck.summary}`,
      });
    } else {
      // Only tests seen passing on both sides can stand for a change that keeps behaviour.
      const passedOnBoth =
        proofCheck.status === 'PASS' &&
        (proofCheck.passedBoth.length > 0 ||
          (proofCheck.mode === 'exit-status' &&
            proofCheck.exitCodeA === 0 &&
            proofCheck.exitCodeB === 0));
      matrix.push({
        check: proofCheckLabel,
        status: proofCheck.status === 'PASS' ? 'WARN' : 'FAIL',
        detail: `${pairPrefix}${proofCheck.summary}${NO_FAIL_TO_PASS}`,
        ...(passedOnBoth ? { noFailToPass: true } : {}),
      });
    }
  } else if (bundle.abReport.testsOff) {
    matrix.push(notRun(proofCheckLabel, 'A/B tests switched off by the configuration.'));
  } else if (bundle.abReport.executed && !isCore) {
    matrix.push({
      check: proofCheckLabel,
      status: 'SKIPPED',
      detail: 'No PR test file triggered proof-of-fix run.',
    });
  } else if (!bundle.abReport.executed) {
    matrix.push(
      notRun(
        proofCheckLabel,
        isCore ? 'A/B test run did not execute.' : 'CiviKitchen A/B did not run.',
      ),
    );
  }

  // 3. Base-Test Regression, and the version matrix of an extension
  const baseCheck = bundle.abReport.checks.find((c) => c.name === 'base-test-regression');
  if (baseCheck) {
    const row = regressionRow('Base-Test Regression', baseCheck, isCore, mergePrefix);
    if (row) matrix.push(row);
  } else if (bundle.abReport.testsOff) {
    matrix.push(notRun('Base-Test Regression', 'A/B tests switched off by the configuration.'));
  } else if (bundle.abReport.executed && !isCore) {
    matrix.push({
      check: 'Base-Test Regression',
      status: 'SKIPPED',
      detail: 'No matching base regression test target.',
    });
  } else if (!bundle.abReport.executed) {
    matrix.push(notRun('Base-Test Regression', 'Base-test regression A/B did not run.'));
  }
  const versionCheck = bundle.abReport.checks.find((c) => c.name === 'floor-vs-beta-matrix');
  const versionRow = versionCheck && regressionRow('Version Matrix', versionCheck, false);
  if (versionRow) matrix.push(versionRow);

  // 4. Live Surface Diff
  const liveSurf = bundle.abReport.surfaceDiff.liveSurfaceDiff;
  if (liveSurf) {
    if (liveSurf.error) {
      matrix.push({
        check: 'Live Surface Diff',
        status: 'WARN',
        detail: `Live capture failed: ${liveSurf.error}`,
      });
    } else if (liveSurf.risk_flags.length > 0) {
      matrix.push({
        check: 'Live Surface Diff',
        status: 'WARN',
        detail: `${liveSurf.risk_flags.length} risk flag(s): ${liveSurf.risk_flags
          .map((f) => `${f.code}(${f.target})`)
          .slice(0, 4)
          .join(', ')}`,
      });
    } else {
      matrix.push({
        check: 'Live Surface Diff',
        status: 'PASS',
        detail: 'Live APIv4/APIv3/routes/Afform surface diff captured with 0 risk flags.',
      });
    }
  } else {
    const staticChanges = bundle.abReport.surfaceDiff.changes;
    // Without a live capture the row rests on the diff alone and cannot pass.
    matrix.push({
      check: 'Live Surface Diff',
      status: staticChanges.length > 0 ? 'WARN' : 'NOT_VERIFIED',
      detail: `Live surface not captured; from the diff: ${bundle.abReport.surfaceDiff.summary}`,
    });
  }

  // 5. Static / Taint Delta (extension-only CiviKitchen gate; omit on civicrm-core when not executed)
  const st = bundle.staticDelta;
  if (!st.executed) {
    if (!isCore) {
      matrix.push({
        check: 'Static / Taint Delta',
        status: 'NOT_VERIFIED',
        detail: st.summary,
      });
    }
  } else if (st.findings.some((f) => f.severity === 'error')) {
    matrix.push({
      check: 'Static / Taint Delta',
      status: 'FAIL',
      detail: st.summary,
    });
  } else if (st.findings.length > 0) {
    matrix.push({
      check: 'Static / Taint Delta',
      status: 'WARN',
      detail: st.summary,
    });
  } else {
    matrix.push({
      check: 'Static / Taint Delta',
      status: 'PASS',
      detail: st.summary,
    });
  }

  // 6. Browser A/B (Standalone) — omit when skipped with no probed routes
  const bd = bundle.abReport.browserDiff;
  if (bd) {
    const routesCount = new Set([
      ...bd.probedRoutes,
      ...bd.probedAnonymousRoutes,
      ...bd.screenshots.map((s) => s.route),
    ]).size;
    if (bd.error) {
      matrix.push({
        check: 'Browser A/B (Standalone)',
        status: 'NOT_VERIFIED',
        detail: `Standalone browser A/B failed: ${bd.error}`,
      });
    } else {
      const consoleErrs = bd.new_console_errors.length;
      const pageErrs = bd.new_page_errors.length;
      const netFails = bd.new_network_failures.length;
      const a11yViol = bd.new_a11y_violations.length;
      const renderReg = bd.render_regressions.length;
      const totalReg = consoleErrs + pageErrs + netFails + a11yViol + renderReg;

      if (totalReg > 0) {
        matrix.push({
          check: 'Browser A/B (Standalone)',
          status: consoleErrs + pageErrs + netFails + renderReg > 0 ? 'FAIL' : 'WARN',
          detail: `Probed ${routesCount} route(s): ${consoleErrs} console, ${pageErrs} page, ${netFails} network, ${a11yViol} a11y, ${renderReg} render regression(s).`,
        });
      } else if ((typeof bd.counts?.routes === 'number' ? bd.counts.routes : routesCount) === 0) {
        matrix.push({
          check: 'Browser A/B (Standalone)',
          status: 'NOT_VERIFIED',
          detail: 'The browser run compared no route.',
        });
      } else if (bd.smokeOnly) {
        matrix.push({
          check: 'Browser A/B (Standalone)',
          status: 'NOT_VERIFIED',
          detail:
            'Only the dashboard or a route named on an unchanged line was probed as a smoke test (0 regressions); no route of the change was found. Name one with `--page <route>`.',
        });
      } else {
        matrix.push({
          check: 'Browser A/B (Standalone)',
          status: 'PASS',
          detail: `Probed ${routesCount} route(s), ${bd.screenshots.length} screenshot pair(s); 0 new console/page/network/a11y/render regressions.`,
        });
      }
    }
  } else if (!bundle.abReport.executed && !isCore) {
    matrix.push(notRun('Browser A/B (Standalone)', 'Standalone browser A/B did not run.'));
  }

  // 7. Demo (only show when interactive demo actually ran)
  if (bundle.abReport.demoArtifactsDir) {
    matrix.push({
      check: 'Demo',
      status: bundle.abReport.demoConsoleErrors.length > 0 ? 'FAIL' : 'PASS',
      detail:
        bundle.abReport.demoConsoleErrors.length > 0
          ? `${bundle.abReport.demoConsoleErrors.length} console/runtime error(s) in ${bundle.abReport.demoArtifactsDir}`
          : `Demo artifacts captured cleanly in ${bundle.abReport.demoArtifactsDir}`,
    });
  }

  // 8. CMS integrations: their code runs on no Standalone stack.
  // Only core PRs can be recorded on a CMS; elsewhere the row could never get a result.
  const scope = cmsScope(isCore ? bundle.diffFiles : []);
  const demos = bundle.abReport.cmsDemos;
  const cmsNotes: string[] = [];
  if (scope.labels.length > 0 || demos.length > 0) {
    const ran = new Set(demos.filter((d) => d.status !== 'NOT_VERIFIED').map((d) => d.cms));
    const unrun = scope.hits.filter((h) => !h.cms || !ran.has(h.cms)).map((h) => h.label);
    if (unrun.length > 0) {
      cmsNotes.push(
        `${unrun.join(', ')} code did not run (${scope.files.slice(0, 5).join(', ')}): the other checks ran on Standalone.`,
      );
    }
    matrix.push({
      check: CMS_CHECK,
      // A CMS the configuration adds decides nothing when the changed integrations ran.
      status: demos.some((d) => d.status === 'FAIL')
        ? 'FAIL'
        : unrun.length > 0 || (scope.labels.length === 0 && !demos.some((d) => d.status === 'PASS'))
          ? 'NOT_VERIFIED'
          : 'PASS',
      detail: [...demos.map((d) => d.detail), ...cmsNotes].join(' '),
      ...(scope.onlyCms ? { coversWholeChange: true } : {}),
      ...(scope.labels.length > 0 ? { cmsCodeChanged: true } : {}),
    });
  }
  // A Standalone page load says nothing about a change to another CMS's integration alone.
  const rows = scope.onlyCms
    ? matrix.map((row) =>
        row.check === 'Browser A/B (Standalone)' && row.status === 'PASS'
          ? {
              ...row,
              status: 'SKIPPED' as const,
              detail: `Does not apply: the changed code is ${scope.labels.join(', ')} only and does not run on Standalone.`,
            }
          : row,
      )
    : matrix;

  const notVerified = Array.from(
    new Set([
      ...bundle.notVerified,
      ...bundle.abReport.surfaceDiff.unverifiedSurfaces,
      ...cmsNotes,
    ]),
  );

  return { verificationMatrix: rows, notVerified };
}

/**
 * Refines deterministic matrix entries using Stage 0 Triage context:
 * - Only a bugfix has to show a test that fails without the change. For every other
 *   intent, tests passing on both base & PR are what the PR should show (`PASS`).
 * - When Jenkins failed with concrete failed test details that Triage assessed as
 *   `likely-flaky` (unrelated to the PR), downgrades `CI / Jenkins` from `FAIL`
 *   to `WARN` so a flaky CI job does not falsely force `ISSUES_FOUND`.
 */
export function reconcileMatrixForTriage(
  matrix: VerificationMatrixEntry[],
  triage: TriageOutput,
): VerificationMatrixEntry[] {
  return matrix.map((row) => {
    if (row.noFailToPass && row.status === 'WARN' && triage.intent !== 'bugfix') {
      return { ...row, status: 'PASS', detail: row.detail.replace(NO_FAIL_TO_PASS, '') };
    }
    if (
      row.check === 'CI / Jenkins' &&
      row.status === 'FAIL' &&
      triage.ciFailureAssessment === 'likely-flaky'
    ) {
      const reason = triage.ciFailureReason?.trim()
        ? ` — likely unrelated flake: ${triage.ciFailureReason.trim()}`
        : ' — likely unrelated flake';
      return {
        ...row,
        status: 'WARN',
        detail: `${row.detail}${reason}`,
      };
    }
    return row;
  });
}

/**
 * Appends a `Reviewer Thread` row to the Empirical Verification Matrix when
 * prior human reviewer questions or change requests exist on the PR.
 */
export function applyThreadResolutionsToMatrix(
  matrix: VerificationMatrixEntry[],
  threadResolutions: ThreadResolution[] | undefined,
  mentionUsers = false,
): VerificationMatrixEntry[] {
  if (!threadResolutions || threadResolutions.length === 0) return matrix;
  const openItems = threadResolutions.filter((t) => t.status === 'open');
  const resolvedCount = threadResolutions.length - openItems.length;
  const formatHandle = (author: string) => {
    const clean = author.replace(/^@/, '');
    return mentionUsers ? `@${clean}` : `\`${clean}\``;
  };
  const row: VerificationMatrixEntry =
    openItems.length > 0
      ? {
          check: 'Reviewer Thread',
          status: 'WARN',
          detail: `${openItems.length} open question/request(s) (${Array.from(
            new Set(openItems.map((t) => formatHandle(t.author))),
          ).join(', ')})${resolvedCount > 0 ? ` · ${resolvedCount} addressed/answered` : ''}`,
        }
      : {
          check: 'Reviewer Thread',
          status: 'PASS',
          detail: `All ${threadResolutions.length} reviewer question/request(s) addressed or answered.`,
        };
  return [...matrix.filter((m) => m.check !== 'Reviewer Thread'), row];
}

export interface ConfidenceScoreResult {
  score: ConfidenceScore;
  rationale: string;
}

/** Says whether a score-deciding finding was reproduced in a run or only read in the code. */
function basis(fs: VerifiedFinding[]): string {
  return fs.some((f) => f.verdict === 'PROVEN')
    ? ''
    : ' (from reading the code, not reproduced in a run)';
}

/**
 * Computes the 1–5 score of a review from its verified findings and the
 * verification matrix. It rates what was checked, not whether to merge.
 *
 * - 5/5: No verified issues; empirical checks passed.
 * - 4/5: Minor follow-up — low-severity / question-only findings or minor verification gap/warning.
 * - 3/5: Moderate risk — confirmed medium defect, base-test regression, or unproven/errored A/B proof.
 * - 2/5: High risk — confirmed high-severity defect or empirical CI/taint/browser/proof regression.
 * - 1/5: Critical blocker — confirmed critical defect or multiple confirmed high-severity defects.
 */
/** True when the row stands for tests that ran, whatever their outcome. */
function ranTests(row?: VerificationMatrixEntry): boolean {
  return row?.status === 'PASS' || row?.status === 'WARN' || row?.status === 'FAIL';
}

export function computeConfidenceScore(params: {
  verdict: FinalVerdict;
  findings: VerifiedFinding[];
  verificationMatrix: VerificationMatrixEntry[];
  prKind?: PrKind;
}): ConfidenceScoreResult {
  const { findings, verificationMatrix, prKind } = params;

  let score: ConfidenceScore = 5;
  const reasons: Array<{ limit: ConfidenceScore; text: string }> = [];

  const capAt = (limit: ConfidenceScore, reason: string) => {
    reasons.push({ limit, text: reason });
    if (limit < score) {
      score = limit;
    }
  };

  const isConfirmed = isConfirmedFinding;

  const confirmedCritical = findings.filter(
    (f) => isConfirmed(f) && f.reassessedSeverity === 'critical',
  );
  const confirmedHigh = findings.filter((f) => isConfirmed(f) && f.reassessedSeverity === 'high');
  const confirmedMedium = findings.filter(
    (f) => isConfirmed(f) && f.reassessedSeverity === 'medium',
  );
  const questionHigh = findings.filter(
    (f) => f.verdict === 'NEEDS_QUESTION' && f.reassessedSeverity === 'high',
  );
  const questionCritical = findings.filter(
    (f) => f.verdict === 'NEEDS_QUESTION' && f.reassessedSeverity === 'critical',
  );
  const otherFindings = findings.filter(
    (f) =>
      !confirmedCritical.includes(f) &&
      !confirmedHigh.includes(f) &&
      !confirmedMedium.includes(f) &&
      !questionHigh.includes(f) &&
      !questionCritical.includes(f),
  );

  // 1. Verified findings caps
  if (confirmedCritical.length > 0) {
    capAt(
      1,
      `${confirmedCritical.length} confirmed critical finding(s)${basis(confirmedCritical)}`,
    );
  }
  if (confirmedHigh.length >= 2) {
    capAt(1, `${confirmedHigh.length} confirmed high-severity findings${basis(confirmedHigh)}`);
  } else if (confirmedHigh.length === 1) {
    capAt(2, `1 confirmed high-severity finding${basis(confirmedHigh)}`);
  }
  if (questionCritical.length > 0) {
    capAt(2, `${questionCritical.length} critical question(s) requiring confirmation`);
  }
  if (confirmedMedium.length > 0) {
    capAt(3, `${confirmedMedium.length} confirmed medium finding(s)`);
  }
  if (questionHigh.length > 0) {
    capAt(3, `${questionHigh.length} high-severity question(s) requiring confirmation`);
  }
  if (otherFindings.length > 0) {
    capAt(4, `${otherFindings.length} low-severity or question-only finding(s)`);
  }

  // 2. Empirical verification matrix caps
  const byCheck = new Map(verificationMatrix.map((m) => [m.check, m]));
  const ci = byCheck.get('CI / Jenkins');
  const proof = byCheck.get('A/B Proof-of-Fix') ?? byCheck.get('CiviKitchen A/B Proof-of-Fix');
  const baseReg = byCheck.get('Base-Test Regression');
  const surface = byCheck.get('Live Surface Diff');
  const staticDelta = byCheck.get('Static / Taint Delta');
  const browser = byCheck.get('Browser A/B (Standalone)');
  const demo = byCheck.get('Demo');

  if (ci?.status === 'FAIL') {
    capAt(2, 'CI / Jenkins failed');
  } else if (ci?.status === 'WARN' && /flake/i.test(ci.detail)) {
    capAt(4, 'CI / Jenkins failed (likely unrelated flake)');
  }
  if (staticDelta?.status === 'FAIL') {
    capAt(2, 'Static / Taint delta introduced new errors');
  }
  if (browser?.status === 'FAIL') {
    capAt(2, 'Standalone Browser A/B detected runtime/render regressions');
  }
  if (demo?.status === 'FAIL') {
    capAt(2, 'Interactive demo reported runtime errors');
  }
  const cms = byCheck.get(CMS_CHECK);
  if (cms?.status === 'FAIL') {
    capAt(2, 'the change fails on a CMS other than Standalone');
  }

  if (proof?.status === 'FAIL') {
    if (/regression/i.test(proof.detail)) {
      capAt(2, 'A/B Proof-of-Fix found test regressions');
    } else {
      capAt(3, 'A/B Proof-of-Fix failed to execute cleanly');
    }
  } else if (proof?.status === 'WARN') {
    capAt(4, 'A/B Proof-of-Fix did not observe a fail-to-pass transition');
  }

  if (baseReg?.status === 'FAIL') {
    capAt(3, 'Base-Test Regression failed on head');
  } else if (baseReg?.status === 'WARN') {
    capAt(4, 'Base-Test Regression completed with warnings');
  }
  if (byCheck.get('Version Matrix')?.status === 'FAIL') {
    capAt(3, 'tests fail on the newer CiviCRM version');
  }

  if (surface?.status === 'WARN') {
    capAt(4, 'Live Surface Diff flagged permission/route changes');
  }
  if (browser?.status === 'WARN') {
    capAt(4, 'Standalone Browser A/B flagged new accessibility violations');
  }
  const reviewerThread = byCheck.get('Reviewer Thread');
  if (reviewerThread?.status === 'WARN') {
    capAt(4, `unaddressed reviewer feedback (${reviewerThread.detail})`);
  }

  const isLowRiskKind = prKind === 'docs-only' || prKind === 'core-ref-nfc';
  const unverified = unverifiedRuntimeChecks(verificationMatrix, prKind);
  if (unverified.length > 0) {
    capAt(3, `not verified at runtime (${unverified.join(', ')} gave no result)`);
  } else if (cms?.status === 'NOT_VERIFIED' && cms.cmsCodeChanged) {
    capAt(4, 'CMS-specific code did not run on its CMS');
  } else if (cms?.status === 'PASS' && cms.cmsCodeChanged) {
    capAt(4, 'CMS-specific code ran as a login and page loads only');
  } else if (!isLowRiskKind && !ranTests(proof) && !ranTests(baseReg)) {
    capAt(4, 'no A/B test ran');
  }

  if (reasons.length === 0) {
    const passedChecks = verificationMatrix.filter((m) => m.status === 'PASS').map((m) => m.check);
    const summary =
      passedChecks.length > 0
        ? `No verified issues; passed ${passedChecks.slice(0, 3).join(', ')}.`
        : 'No verified issues found.';
    return { score: 5, rationale: summary };
  }

  // Strictest caps first so the rationale names what actually decides the score.
  const dedupedReasons = Array.from(
    new Set(reasons.toSorted((a, b) => a.limit - b.limit).map((r) => r.text)),
  ).slice(0, 3);
  const first = dedupedReasons[0]!;
  const formattedFirst = first.charAt(0).toUpperCase() + first.slice(1);
  const rest = dedupedReasons.slice(1);
  return {
    score,
    rationale: `${[formattedFirst, ...rest].join('; ')}.`,
  };
}

/**
 * The one or two sentences at the top of a review: what the PR changes and what the
 * A/B run proved. The findings follow as action items.
 */
export function buildShortSummary(params: {
  prTitle?: string;
  triageSummary?: string;
  verificationMatrix: VerificationMatrixEntry[];
  scoreRationale: string;
}): string {
  const { prTitle, triageSummary, verificationMatrix, scoreRationale } = params;

  const parts: string[] = [];

  const whatChanged = (triageSummary ?? '').trim();
  if (whatChanged) {
    parts.push(/[.!?]$/.test(whatChanged) ? whatChanged : `${whatChanged}.`);
  } else if (prTitle && prTitle.trim()) {
    const cleanTitle = prTitle.trim().replace(/\.$/, '');
    parts.push(`Changes: ${cleanTitle}.`);
  }

  const proof = verificationMatrix.find(
    (m) => m.check === 'A/B Proof-of-Fix' || m.check === 'CiviKitchen A/B Proof-of-Fix',
  );
  if (proof?.status === 'PASS') {
    const match = proof.detail.match(
      /(\d+\s+test\(s\)\s+(?:failed on base,\s+passed on PR|red on A,\s+green on B))/i,
    );
    if (match?.[1]) {
      parts.push(`A/B testing proved ${match[1]}.`);
    }
  }

  if (parts.length === 0) {
    parts.push(scoreRationale);
  }

  return parts.join(' ').trim();
}

/**
 * Resolves the reasoning effort level for a pipeline stage.
 *
 * Precedence:
 * 1. Explicit per-stage override (`config.review.stageEffort.<stage>`)
 * 2. Explicit global effort override (`config.review.effort !== 'auto'`)
 * 3. Dynamic `auto` policy tuned for CiviCRM PR reviews:
 *    - `triage`: `low` (pure routing/classification/summary)
 *    - `threadReply`: `medium` (concise inline Q&A)
 *    - `specialist`: `medium` in `auto` mode to avoid 4x parallel token burn
 *    - `verifier`: `high` when verifying high/critical candidates, >=4 candidates, security-sensitive PRs,
 *      or failing empirical checks; otherwise `medium`
 */
export function resolveStageEffort(params: {
  stage: 'triage' | 'specialist' | 'verifier' | 'threadReply';
  config: Pick<ResolvedCiviReviewConfig, 'review'>;
  lens?: 'correctness' | 'security' | 'tests' | 'ui';
  bundle?: EvidenceBundle;
  triage?: TriageOutput;
  candidates?: CandidateFinding[];
  verificationMatrix?: VerificationMatrixEntry[];
}): EffortLevel {
  const { stage, config, triage, candidates, verificationMatrix } = params;

  const perStage = config.review.stageEffort;
  if (stage === 'triage' && perStage?.triage) return perStage.triage;
  if (stage === 'specialist' && perStage?.specialists) {
    return perStage.specialists;
  }
  if (stage === 'verifier' && perStage?.verifier) return perStage.verifier;
  if (stage === 'threadReply' && perStage?.threadReply) {
    return perStage.threadReply;
  }

  if (config.review.effort !== 'auto') {
    return config.review.effort;
  }

  const depth = config.review.depth ?? 'deep';

  if (stage === 'triage') {
    return depth === 'deep' ? 'high' : 'low';
  }
  if (stage === 'threadReply') {
    return 'medium';
  }

  const hasEmpiricalFail = Boolean(verificationMatrix?.some((m) => m.status === 'FAIL'));
  const isSecurityPr = triage?.prKind === 'security-sensitive';
  const isHighRiskPr = isSecurityPr || triage?.riskLevel === 'high';

  if (stage === 'specialist') {
    if (depth === 'fast') {
      return 'low';
    }
    if (depth === 'deep') {
      return 'high';
    }
    return 'medium';
  }

  // Stage 2: Verifier
  if (depth === 'deep') {
    return 'high';
  }
  if (depth === 'fast') {
    return 'medium';
  }
  const candidateList = candidates ?? [];
  const hasHighOrCritical = candidateList.some(
    (c) => c.severity === 'critical' || c.severity === 'high',
  );
  if (isHighRiskPr || hasEmpiricalFail || hasHighOrCritical || candidateList.length >= 4) {
    return 'high';
  }
  return 'medium';
}
