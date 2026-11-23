import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  isCheckEnabled,
  isLensEnabled,
  type EffortLevel,
  type ModelSpec,
  type ResolvedCiviReviewConfig,
} from '../config/schema.ts';
import type { EvidenceBundle } from '../evidence/types.ts';
import { resolveMcpScope } from '../mcp/scope.ts';
import { buildSharedEvidencePrefix } from '../prompts/shared.ts';
import { buildCorrectnessPrompt } from '../prompts/specialist-correctness.ts';
import { buildSecurityPrompt } from '../prompts/specialist-security.ts';
import { buildTestsPrompt } from '../prompts/specialist-tests.ts';
import { buildUiPrompt } from '../prompts/specialist-ui.ts';
import { buildThreadReplyPrompt, type ThreadReplyInput } from '../prompts/thread-reply.ts';
import { buildTriagePrompt, type StagePromptPair } from '../prompts/triage.ts';
import { buildVerifierPrompt } from '../prompts/verifier.ts';
import { createLiveProbeTool } from '../runners/live-prove.ts';
import { estimateStageCostUsd, roundUsd } from '../runners/pricing.ts';
import {
  createRunnerRegistry,
  runStage,
  type RunnerRegistry,
} from '../runners/registry.ts';
import type {
  ExtraMcpServerConfig,
  StageImageInput,
  StageUsage,
} from '../runners/types.ts';
import { mapFindingsToDiff } from './line-mapper.ts';
import {
  FinalReviewSchema,
  SpecialistOutputSchema,
  ThreadReplyOutputSchema,
  TriageOutputSchema,
  VerifierOutputSchema,
  type BlastRadiusItem,
  type CandidateFinding,
  type ConfidenceScore,
  type FinalReview,
  type FinalVerdict,
  type FindingVerdict,
  type PrKind,
  type Severity,
  type SpecialistLens,
  type StandardVerdict,
  type ThreadReplyOutput,
  type TokenUsageTotals,
  type TriageOutput,
  type VerificationMatrixEntry,
  type VerifiedFinding,
} from './schemas.ts';

export interface PipelineLogger {
  info?(msg: string): void;
  warn?(msg: string): void;
  debug?(msg: string): void;
}

export interface RunReviewPipelineOptions {
  bundle: EvidenceBundle;
  filteredPatch: string;
  config: ResolvedCiviReviewConfig;
  cwd: string;
  registry?: RunnerRegistry;
  logger?: PipelineLogger;
  liveUrls?: { A?: string; B?: string };
  composeFiles?: { A?: string; B?: string };
}

export interface RunThreadReplyOptions {
  bundle: EvidenceBundle;
  filteredPatch: string;
  threadContext: ThreadReplyInput;
  config: ResolvedCiviReviewConfig;
  cwd: string;
  registry?: RunnerRegistry;
}

const SEVERITY_RANK: Record<Severity, number> = {
  critical: 4,
  high: 3,
  medium: 2,
  low: 1,
};

const EVIDENCE_RANK: Record<FindingVerdict, number> = {
  PROVEN: 3,
  CONFIRMED: 2,
  NEEDS_QUESTION: 1,
  REJECTED: 0,
};

function compareVerifiedFindings(a: VerifiedFinding, b: VerifiedFinding): number {
  const sevDiff =
    SEVERITY_RANK[b.reassessedSeverity] - SEVERITY_RANK[a.reassessedSeverity];
  if (sevDiff !== 0) return sevDiff;

  const evDiff = EVIDENCE_RANK[b.verdict] - EVIDENCE_RANK[a.verdict];
  if (evDiff !== 0) return evDiff;

  const confDiff = b.confidence - a.confidence;
  if (confDiff !== 0) return confDiff;

  const pathDiff = a.path.localeCompare(b.path);
  if (pathDiff !== 0) return pathDiff;

  return a.startLine - b.startLine;
}

function normalizePath(p: string): string {
  return p.replaceAll('\\', '/').replace(/^\.\//, '');
}

function rangesOverlap(
  aStart: number,
  aEnd: number,
  bStart: number,
  bEnd: number,
): boolean {
  const aLo = Math.min(aStart, aEnd);
  const aHi = Math.max(aStart, aEnd);
  const bLo = Math.min(bStart, bEnd);
  const bHi = Math.max(bStart, bEnd);
  return aLo <= bHi && bLo <= aHi;
}

function accumulateUsage(
  totals: TokenUsageTotals,
  stage: string,
  model: ModelSpec,
  usage: StageUsage | undefined,
): boolean {
  if (!usage) return false;
  totals.inputTokens += usage.inputTokens;
  totals.outputTokens += usage.outputTokens;
  totals.totalTokens += usage.totalTokens;
  if (usage.cachedInputTokens !== undefined) {
    totals.cachedInputTokens =
      (totals.cachedInputTokens ?? 0) + usage.cachedInputTokens;
  }
  if (usage.cacheWriteInputTokens !== undefined) {
    totals.cacheWriteInputTokens =
      (totals.cacheWriteInputTokens ?? 0) + usage.cacheWriteInputTokens;
  }
  const stageCost = estimateStageCostUsd(model, usage);
  if (stageCost !== undefined) {
    totals.estimatedUsd = roundUsd((totals.estimatedUsd ?? 0) + stageCost);
  }
  if (!totals.byStage) {
    totals.byStage = [];
  }
  totals.byStage.push({
    stage,
    model,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    ...(usage.cachedInputTokens !== undefined
      ? { cachedInputTokens: usage.cachedInputTokens }
      : {}),
    ...(usage.cacheWriteInputTokens !== undefined
      ? { cacheWriteInputTokens: usage.cacheWriteInputTokens }
      : {}),
    totalTokens: usage.totalTokens,
    ...(stageCost !== undefined ? { estimatedUsd: stageCost } : {}),
  });
  return true;
}

function buildSpecialistPrompt(
  lens: SpecialistLens,
  bundle: EvidenceBundle,
  triage: TriageOutput,
): StagePromptPair {
  switch (lens) {
    case 'correctness':
      return buildCorrectnessPrompt(bundle, triage);
    case 'security':
      return buildSecurityPrompt(bundle, triage);
    case 'tests':
      return buildTestsPrompt(bundle, triage);
    case 'ui':
      return buildUiPrompt(bundle, triage);
  }
}

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

function mergeStandards(
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

function adoptReconciledStandards(
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

function isStandardBackedByMatrixFail(
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
        failedChecks.has('Browser A/B (Standalone)') ||
        failedChecks.has('Demo')
      );
    case 'r-test':
      return (
        failedChecks.has('CI / Jenkins') ||
        failedChecks.has('Base-Test Regression')
      );
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
        failedChecks.has('Static / Taint Delta') ||
        failedChecks.has('Browser A/B (Standalone)')
      );
    default:
      return false;
  }
}

function reconcileStandardsDeterministically(params: {
  standards: StandardVerdict[] | undefined;
  verdict: FinalVerdict;
  survivingFindings: VerifiedFinding[];
  verificationMatrix: VerificationMatrixEntry[];
  bundle: EvidenceBundle;
}): StandardVerdict[] | undefined {
  const { standards, verdict, survivingFindings, verificationMatrix, bundle } =
    params;
  if (!standards || standards.length === 0) return undefined;

  const byCode = new Map<string, StandardVerdict>();
  for (const item of standards) {
    const code = item.code.trim().toLowerCase();
    if (CANONICAL_STANDARD_CODES.has(code)) {
      byCode.set(code, { ...item, code });
    }
  }
  if (byCode.size === 0) return undefined;

  const proofCheck = bundle.abReport.checks.find(
    (c) => c.name === 'proof-of-fix',
  );
  const tautological = proofCheck?.tautologicalTests ?? [];
  if (tautological.length > 0 && (proofCheck?.fixed.length ?? 0) === 0) {
    const names = tautological
      .map((t) => `${t.method} (${t.file}:${t.line})`)
      .join(', ');
    byCode.set('r-maint', {
      code: 'r-maint',
      status: 'ISSUE',
      note: `${tautological.length} added test method(s) PASSED on unfixed base A (tautological: ${names}).`,
    });
    const existingRun = byCode.get('r-run');
    if (existingRun) {
      byCode.set('r-run', {
        code: 'r-run',
        status: 'ISSUE',
        note: `CiviKitchen A/B ran, but added test(s) passed on unfixed base A without proving fix (${names}).`,
      });
    }
  }

  if (verdict === 'READY' && survivingFindings.length === 0) {
    for (const [code, item] of byCode.entries()) {
      if (
        item.status === 'ISSUE' &&
        !isStandardBackedByMatrixFail(code, verificationMatrix)
      ) {
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

function mergeBlastRadius(
  lists: Array<BlastRadiusItem[] | undefined>,
): BlastRadiusItem[] {
  const seen = new Set<string>();
  const merged: BlastRadiusItem[] = [];
  for (const list of lists) {
    if (!list) continue;
    for (const item of list) {
      const key = `${item.repo}|${item.path}|${item.symbol}`;
      if (!seen.has(key)) {
        seen.add(key);
        merged.push(item);
      }
    }
  }
  return merged;
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
  const proofCheckLabel = isCore
    ? 'A/B Proof-of-Fix'
    : 'CiviKitchen A/B Proof-of-Fix';

  // 2. A/B Proof-of-Fix
  const proofCheck = bundle.abReport.checks.find(
    (c) => c.name === 'proof-of-fix',
  );
  if (proofCheck) {
    const pairPrefix =
      proofCheck.imageA !== proofCheck.imageB
        ? `${proofCheck.imageA} vs ${proofCheck.imageB}: `
        : '';
    const tautological = proofCheck.tautologicalTests ?? [];
    if (proofCheck.regressions.length > 0 || proofCheck.status === 'FAIL') {
      matrix.push({
        check: proofCheckLabel,
        status: 'FAIL',
        detail: `${pairPrefix}${proofCheck.summary}`,
      });
    } else if (proofCheck.fixed.length > 0 && proofCheck.status === 'PASS') {
      const guardSuffix =
        tautological.length > 0
          ? isCore
            ? ` (+${tautological.length} regression-guard test(s) passed on both base & PR: ${tautological.map((t) => t.method).join(', ')})`
            : ` (+${tautological.length} regression-guard test(s) passed on both A & B: ${tautological.map((t) => t.method).join(', ')})`
          : '';
      matrix.push({
        check: proofCheckLabel,
        status: 'PASS',
        detail: isCore
          ? `${pairPrefix}${proofCheck.fixed.length} test(s) failed on base, passed on PR${guardSuffix}`
          : `${pairPrefix}${proofCheck.fixed.length} test(s) red on A, green on B${guardSuffix}`,
      });
    } else if (tautological.length > 0) {
      const names = tautological
        .map((t) => `${t.method} (${t.file}:${t.line})`)
        .join(', ');
      matrix.push({
        check: proofCheckLabel,
        status: 'WARN',
        detail: `${pairPrefix}${tautological.length} added test method(s) passed on unfixed base (tautological: ${names})`,
      });
    } else if (
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
    } else {
      matrix.push({
        check: proofCheckLabel,
        status: proofCheck.status === 'PASS' ? 'WARN' : 'FAIL',
        detail: `${pairPrefix}${proofCheck.summary} (no fail-to-pass transition observed)`,
      });
    }
  } else if (!bundle.abReport.executed || !isCore) {
    matrix.push({
      check: proofCheckLabel,
      status: bundle.abReport.executed ? 'SKIPPED' : 'NOT_VERIFIED',
      detail: bundle.abReport.executed
        ? 'No PR test file triggered proof-of-fix run.'
        : isCore
          ? 'A/B test run did not execute.'
          : 'CiviKitchen A/B did not run.',
    });
  }

  // 3. Base-Test Regression
  const baseCheck = bundle.abReport.checks.find(
    (c) => c.name === 'base-test-regression' || c.name === 'floor-vs-beta-matrix',
  );
  if (baseCheck) {
    const pairPrefix =
      baseCheck.imageA !== baseCheck.imageB
        ? `${baseCheck.imageA} vs ${baseCheck.imageB}: `
        : '';
    if (baseCheck.regressions.length > 0 || baseCheck.status === 'FAIL') {
      matrix.push({
        check: 'Base-Test Regression',
        status: 'FAIL',
        detail: `${pairPrefix}${baseCheck.regressions.slice(0, 5).join(', ') || baseCheck.summary}`,
      });
    } else if (baseCheck.status === 'PASS') {
      matrix.push({
        check: 'Base-Test Regression',
        status: 'PASS',
        detail: `${pairPrefix}${baseCheck.summary}`,
      });
    } else {
      matrix.push({
        check: 'Base-Test Regression',
        status: 'WARN',
        detail: `${pairPrefix}${baseCheck.summary}`,
      });
    }
  } else if (!bundle.abReport.executed || !isCore) {
    matrix.push({
      check: 'Base-Test Regression',
      status: bundle.abReport.executed ? 'SKIPPED' : 'NOT_VERIFIED',
      detail: bundle.abReport.executed
        ? 'No matching base regression test target.'
        : 'Base-test regression A/B did not run.',
    });
  }

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
        detail: `${liveSurf.risk_flags.length} risk flag(s): ${liveSurf.risk_flags.map((f) => `${f.code}(${f.target})`).slice(0, 4).join(', ')}`,
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
    matrix.push({
      check: 'Live Surface Diff',
      status: staticChanges.length > 0 ? 'WARN' : 'PASS',
      detail: bundle.abReport.surfaceDiff.summary,
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
          status:
            consoleErrs + pageErrs + netFails + renderReg > 0 ? 'FAIL' : 'WARN',
          detail: `Probed ${routesCount} route(s): ${consoleErrs} console, ${pageErrs} page, ${netFails} network, ${a11yViol} a11y, ${renderReg} render regression(s).`,
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
    matrix.push({
      check: 'Browser A/B (Standalone)',
      status: 'NOT_VERIFIED',
      detail: 'Standalone browser A/B did not run.',
    });
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

  const notVerified = Array.from(
    new Set([
      ...bundle.notVerified,
      ...bundle.abReport.surfaceDiff.unverifiedSurfaces,
    ]),
  );

  return { verificationMatrix: matrix, notVerified };
}

function deduplicateVerifiedFindings(
  findings: VerifiedFinding[],
): VerifiedFinding[] {
  const sorted = [...findings].sort(compareVerifiedFindings);
  const kept: VerifiedFinding[] = [];

  for (const candidate of sorted) {
    const normPath = normalizePath(candidate.path);
    const duplicate = kept.some(
      (existing) =>
        normalizePath(existing.path) === normPath &&
        existing.side === candidate.side &&
        rangesOverlap(
          existing.startLine,
          existing.endLine,
          candidate.startLine,
          candidate.endLine,
        ),
    );
    if (!duplicate) {
      kept.push(candidate);
    }
  }

  return kept;
}

function inferImageMediaType(
  filePath: string,
): StageImageInput['mediaType'] {
  const lower = filePath.toLowerCase();
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg';
  if (lower.endsWith('.webp')) return 'image/webp';
  return 'image/png';
}

function collectBrowserScreenshots(bundle: EvidenceBundle): StageImageInput[] {
  const shots = bundle.abReport.browserDiff?.screenshots ?? [];
  const images: StageImageInput[] = [];
  for (const s of shots) {
    if (s.before && existsSync(s.before)) {
      images.push({
        label: `${s.route} (${s.mode}) BEFORE (base A)`,
        path: s.before,
        mediaType: inferImageMediaType(s.before),
      });
    }
    if (s.after && existsSync(s.after)) {
      images.push({
        label: `${s.route} (${s.mode}) AFTER (head B)`,
        path: s.after,
        mediaType: inferImageMediaType(s.after),
      });
    }
  }
  return images;
}

function hasBrowserSignal(bundle: EvidenceBundle): boolean {
  const bd = bundle.abReport.browserDiff;
  if (!bd) return false;
  return (
    bd.screenshots.length > 0 ||
    bd.new_console_errors.length > 0 ||
    bd.new_page_errors.length > 0 ||
    bd.new_network_failures.length > 0 ||
    bd.new_a11y_violations.length > 0 ||
    bd.render_regressions.length > 0
  );
}

function resolvePlaywrightMcpServer(
  config: ResolvedCiviReviewConfig,
): ExtraMcpServerConfig {
  const raw =
    config.browser.playwrightMcpCommand ?? 'npx -y @playwright/mcp@latest';
  const parts = raw.trim().split(/\s+/).filter(Boolean);
  return {
    name: 'playwright',
    command: parts[0] ?? 'npx',
    args: parts.slice(1),
  };
}

interface HeadWorktreeHandle {
  effectiveCwd: string;
  atHeadSha: boolean;
  cleanup: () => Promise<void>;
}

/**
 * Ensures Stage 0/1/2 file tools (`Read`/`Grep`/`Glob`) inspect the exact PR
 * `headSha` even when the local checkout is on a different branch.
 */
async function materializeHeadWorktree(
  cwd: string,
  headSha: string,
): Promise<HeadWorktreeHandle> {
  const noop: HeadWorktreeHandle = {
    effectiveCwd: cwd,
    atHeadSha: false,
    cleanup: async () => {},
  };
  if (!headSha || !/^[0-9a-f]{7,40}$/i.test(headSha) || !existsSync(cwd)) {
    return noop;
  }

  const runGit = async (args: string[]): Promise<{ code: number; out: string }> => {
    try {
      const proc = Bun.spawn(['git', '-C', cwd, ...args], {
        stdout: 'pipe',
        stderr: 'pipe',
      });
      const [out, code] = await Promise.all([
        new Response(proc.stdout).text(),
        proc.exited,
      ]);
      return { code, out: out.trim() };
    } catch {
      return { code: 1, out: '' };
    }
  };

  const headRes = await runGit(['rev-parse', 'HEAD']);
  if (headRes.code !== 0) {
    return noop;
  }
  if (
    headRes.out.toLowerCase() === headSha.toLowerCase() ||
    headRes.out.toLowerCase().startsWith(headSha.toLowerCase())
  ) {
    return { effectiveCwd: cwd, atHeadSha: true, cleanup: async () => {} };
  }

  const existsRes = await runGit(['cat-file', '-e', `${headSha}^{commit}`]);
  if (existsRes.code !== 0) {
    return noop;
  }

  const wtDir = mkdtempSync(join(tmpdir(), 'civireview-head-'));
  const addRes = await runGit(['worktree', 'add', '--detach', wtDir, headSha]);
  if (addRes.code !== 0) {
    rmSync(wtDir, { recursive: true, force: true });
    return noop;
  }

  return {
    effectiveCwd: wtDir,
    atHeadSha: true,
    cleanup: async () => {
      await runGit(['worktree', 'remove', '--force', wtDir]);
      rmSync(wtDir, { recursive: true, force: true });
    },
  };
}

function computeFinalVerdict(findings: VerifiedFinding[]): FinalVerdict {
  if (findings.length === 0) {
    return 'READY';
  }
  const needsChanges = findings.some(
    (f) =>
      (f.reassessedSeverity === 'critical' || f.reassessedSeverity === 'high') &&
      (f.verdict === 'PROVEN' || f.verdict === 'CONFIRMED'),
  );
  return needsChanges ? 'NEEDS_CHANGES' : 'QUESTIONS_ONLY';
}

export interface ConfidenceScoreResult {
  score: ConfidenceScore;
  rationale: string;
}

/**
 * Computes a Greptile-style 1–5 merge-confidence score grounded deterministically
 * in verified findings and the empirical verification matrix.
 *
 * - 5/5: Safe to merge — no verified issues; empirical checks passed.
 * - 4/5: Minor follow-up — low-severity / question-only findings or minor verification gap/warning.
 * - 3/5: Moderate risk — confirmed medium defect, base-test regression, or unproven/errored A/B proof.
 * - 2/5: High risk — confirmed high-severity defect or empirical CI/taint/browser/proof regression.
 * - 1/5: Critical blocker — confirmed critical defect or multiple confirmed high-severity defects.
 */
export function computeConfidenceScore(params: {
  verdict: FinalVerdict;
  findings: VerifiedFinding[];
  verificationMatrix: VerificationMatrixEntry[];
  prKind?: PrKind;
}): ConfidenceScoreResult {
  const { findings, verificationMatrix, prKind } = params;

  let score: ConfidenceScore = 5;
  const reasons: string[] = [];

  const capAt = (limit: ConfidenceScore, reason: string) => {
    reasons.push(reason);
    if (limit < score) {
      score = limit;
    }
  };

  const isConfirmed = (f: VerifiedFinding): boolean =>
    f.verdict === 'PROVEN' || f.verdict === 'CONFIRMED';

  const confirmedCritical = findings.filter(
    (f) => isConfirmed(f) && f.reassessedSeverity === 'critical',
  );
  const confirmedHigh = findings.filter(
    (f) => isConfirmed(f) && f.reassessedSeverity === 'high',
  );
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
      `${confirmedCritical.length} confirmed critical finding(s)`,
    );
  }
  if (confirmedHigh.length >= 2) {
    capAt(1, `${confirmedHigh.length} confirmed high-severity findings`);
  } else if (confirmedHigh.length === 1) {
    capAt(2, '1 confirmed high-severity finding');
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
  const proof =
    byCheck.get('A/B Proof-of-Fix') ?? byCheck.get('CiviKitchen A/B Proof-of-Fix');
  const baseReg = byCheck.get('Base-Test Regression');
  const surface = byCheck.get('Live Surface Diff');
  const staticDelta = byCheck.get('Static / Taint Delta');
  const browser = byCheck.get('Browser A/B (Standalone)');
  const demo = byCheck.get('Demo');

  if (ci?.status === 'FAIL') {
    capAt(2, 'CI / Jenkins failed');
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

  if (proof?.status === 'FAIL') {
    if (/regression/i.test(proof.detail)) {
      capAt(2, 'A/B Proof-of-Fix found test regressions');
    } else {
      capAt(3, 'A/B Proof-of-Fix failed to execute cleanly');
    }
  } else if (proof?.status === 'WARN') {
    if (/tautological/i.test(proof.detail)) {
      capAt(3, 'added PR test(s) passed on unfixed base without proving fix');
    } else {
      capAt(4, 'A/B Proof-of-Fix did not observe a fail-to-pass transition');
    }
  }

  if (baseReg?.status === 'FAIL') {
    capAt(3, 'Base-Test Regression failed on head');
  } else if (baseReg?.status === 'WARN') {
    capAt(4, 'Base-Test Regression completed with warnings');
  }

  if (surface?.status === 'WARN') {
    capAt(4, 'Live Surface Diff flagged permission/route changes');
  }
  if (browser?.status === 'WARN') {
    capAt(4, 'Standalone Browser A/B flagged new accessibility violations');
  }

  const isLowRiskKind = prKind === 'docs-only' || prKind === 'core-ref-nfc';
  if (
    !isLowRiskKind &&
    proof?.status === 'NOT_VERIFIED' &&
    baseReg?.status === 'NOT_VERIFIED'
  ) {
    capAt(4, 'A/B verification did not run');
  }

  if (reasons.length === 0) {
    const passedChecks = verificationMatrix
      .filter((m) => m.status === 'PASS')
      .map((m) => m.check);
    const summary =
      passedChecks.length > 0
        ? `No verified issues; passed ${passedChecks.slice(0, 3).join(', ')}.`
        : 'No verified issues found.';
    return { score: 5, rationale: summary };
  }

  const dedupedReasons = Array.from(new Set(reasons)).slice(0, 3);
  const first = dedupedReasons[0]!;
  const formattedFirst = first.charAt(0).toUpperCase() + first.slice(1);
  const rest = dedupedReasons.slice(1);
  return {
    score,
    rationale: `${[formattedFirst, ...rest].join('; ')}.`,
  };
}

/**
 * Produces a concise 2–3 sentence TL;DR summary visible at the top of every PR review
 * so reviewers can grasp what changed, what empirical checks proved, and what needs
 * attention without expanding the full walkthrough.
 */
export function buildShortSummary(params: {
  prTitle?: string;
  triageSummary?: string;
  findings: VerifiedFinding[];
  verificationMatrix: VerificationMatrixEntry[];
  scoreRationale: string;
}): string {
  const { prTitle, triageSummary, findings, verificationMatrix, scoreRationale } =
    params;

  const parts: string[] = [];

  const whatChanged = (triageSummary ?? '').trim();
  if (whatChanged) {
    parts.push(/[.!?]$/.test(whatChanged) ? whatChanged : `${whatChanged}.`);
  } else if (prTitle && prTitle.trim()) {
    const cleanTitle = prTitle.trim().replace(/\.$/, '');
    parts.push(`Changes: ${cleanTitle}.`);
  }

  const proof = verificationMatrix.find(
    (m) =>
      m.check === 'A/B Proof-of-Fix' ||
      m.check === 'CiviKitchen A/B Proof-of-Fix',
  );
  if (proof?.status === 'PASS') {
    const match = proof.detail.match(
      /(\d+\s+test\(s\)\s+(?:failed on base,\s+passed on PR|red on A,\s+green on B))/i,
    );
    if (match?.[1]) {
      parts.push(`A/B testing proved ${match[1]}.`);
    }
  }

  if (findings.length === 0) {
    if (parts.length === 0) {
      parts.push(scoreRationale);
    }
  } else {
    const top = findings[0]!;
    const more =
      findings.length > 1 ? ` (+${findings.length - 1} more)` : '';
    parts.push(
      `${findings.length} verified finding(s) — top: [${top.reassessedSeverity.toUpperCase()}] ${top.title}${more}.`,
    );
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
 *    - `specialist`: `high` on security-sensitive PRs, large diffs (>250 lines / >6 non-test files),
 *      security lens with live surface risk flags, or failing empirical A/B checks; otherwise `medium`
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
  const { stage, config, lens, bundle, triage, candidates, verificationMatrix } =
    params;

  const perStage = config.review.stageEffort;
  if (stage === 'triage' && perStage?.triage) return perStage.triage;
  if (stage === 'specialist' && perStage?.specialists) return perStage.specialists;
  if (stage === 'verifier' && perStage?.verifier) return perStage.verifier;
  if (stage === 'threadReply' && perStage?.threadReply) return perStage.threadReply;

  if (config.review.effort !== 'auto') {
    return config.review.effort;
  }

  if (stage === 'triage') {
    return 'low';
  }
  if (stage === 'threadReply') {
    return 'medium';
  }

  const hasEmpiricalFail = Boolean(
    verificationMatrix?.some((m) => m.status === 'FAIL'),
  );
  const isSecurityPr = triage?.prKind === 'security-sensitive';
  const isHighRiskPr = isSecurityPr || triage?.riskLevel === 'high';

  if (stage === 'specialist') {
    // Keep parallel Stage 1 specialists at `medium` effort in `auto` mode so 4
    // parallel lenses don't each burn 10-15k thinking tokens; reserve `high`
    // effort for the single Stage 2 Opus Verifier when high-severity candidates exist.
    return 'medium';
  }

  // Stage 2: Verifier
  const candidateList = candidates ?? [];
  const hasHighOrCritical = candidateList.some(
    (c) => c.severity === 'critical' || c.severity === 'high',
  );
  if (
    isHighRiskPr ||
    hasEmpiricalFail ||
    hasHighOrCritical ||
    candidateList.length >= 4
  ) {
    return 'high';
  }
  return 'medium';
}

/**
 * Executes the full multi-stage Layer 2 review pipeline:
 * Stage 0 (Triage) -> Stage 1 (Parallel Specialist Lenses) ->
 * Stage 2 (Sceptical Adversarial Verifier) -> Stage 3 (Gate, Dedup, Rank).
 */
export async function runReviewPipeline(
  options: RunReviewPipelineOptions,
): Promise<FinalReview> {
  const { bundle, filteredPatch, config, cwd, logger } = options;
  const registry = options.registry ?? createRunnerRegistry();

  const mcpScope = resolveMcpScope({
    isPrivateRepo: bundle.pr.isPrivateRepo,
    config,
  });

  const headWorktree = await materializeHeadWorktree(cwd, bundle.pr.headSha);
  const effectiveCwd = headWorktree.effectiveCwd;
  const sharedPrefix = buildSharedEvidencePrefix(
    bundle,
    filteredPatch,
    headWorktree.atHeadSha,
  );

  try {
    return await executeReviewPipeline({
      ...options,
      cwd: effectiveCwd,
      registry,
      mcpScope,
      sharedPrefix,
    });
  } finally {
    await headWorktree.cleanup();
  }
}

async function executeReviewPipeline(
  options: RunReviewPipelineOptions & {
    registry: RunnerRegistry;
    mcpScope: ReturnType<typeof resolveMcpScope>;
    sharedPrefix: string;
  },
): Promise<FinalReview> {
  const { bundle, config, cwd, logger, registry, mcpScope, sharedPrefix } = options;

  const modelsUsed: Record<string, ModelSpec> = {};
  const tokenTotals: TokenUsageTotals = {
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
  };
  let hasUsage = false;

  const { verificationMatrix, notVerified } = buildVerificationMatrix(bundle);

  // Stage 0: Triage
  const triageEffort = resolveStageEffort({
    stage: 'triage',
    config,
    bundle,
    verificationMatrix,
  });
  logger?.info?.(
    `Stage 0 (Triage) using ${config.models.triage} [effort=${triageEffort}]`,
  );
  const triagePrompt = buildTriagePrompt(bundle);
  const triageResult = await runStage(
    {
      stage: 'triage',
      model: config.models.triage,
      cwd,
      systemPrompt: triagePrompt.systemPrompt,
      sharedPrefix,
      userPrompt: triagePrompt.userPrompt,
      schema: TriageOutputSchema,
      schemaName: 'TriageOutput',
      mcpScope,
      effort: triageEffort,
      maxSteps: Math.min(config.review.maxSteps, 3),
    },
    registry,
  );
  modelsUsed.triage = triageResult.model;
  if (accumulateUsage(tokenTotals, 'triage', triageResult.model, triageResult.usage)) {
    hasUsage = true;
  }

  const triage = triageResult.output;
  const browserSignal = hasBrowserSignal(bundle);
  const candidateLenses = Array.from(
    new Set([
      ...triage.activeLenses,
      ...(browserSignal ? (['ui'] as const) : []),
    ]),
  );
  const activeLenses = candidateLenses.filter((lens) =>
    isLensEnabled(config, lens),
  );

  if ((triage.skipReason && !browserSignal) || activeLenses.length === 0) {
    logger?.info?.(
      `Triage skipped specialists: ${triage.skipReason ?? 'no active lenses'}`,
    );
    const skipScore = computeConfidenceScore({
      verdict: 'READY',
      findings: [],
      verificationMatrix,
      prKind: triage.prKind,
    });
    const skipShortSummary = buildShortSummary({
      prTitle: bundle.pr.title,
      triageSummary: triage.shortSummary,
      findings: [],
      verificationMatrix,
      scoreRationale: skipScore.rationale,
    });
    return FinalReviewSchema.parse({
      schemaVersion: '1',
      repo: bundle.pr.repo,
      prNumber: bundle.pr.prNumber,
      baseSha: bundle.pr.baseSha,
      headSha: bundle.pr.headSha,
      prKind: triage.prKind,
      verdict: 'READY',
      score: skipScore.score,
      scoreRationale: skipScore.rationale,
      shortSummary: skipShortSummary,
      walkthrough:
        triage.summaryBullets.length > 0
          ? triage.summaryBullets
          : triage.skipReason
            ? [triage.skipReason]
            : ['No specialist lenses required for this change.'],
      verificationMatrix,
      notVerified,
      blastRadius: [],
      findings: [],
      droppedCount: 0,
      modelsUsed,
      tokenUsage: hasUsage ? tokenTotals : undefined,
      generatedAt: new Date().toISOString(),
    });
  }

  const browserImages = config.browser.sendScreenshotsToLlm
    ? collectBrowserScreenshots(bundle)
    : [];
  const effectiveUrlA =
    options.liveUrls?.A ?? bundle.abReport.browserDiff?.urls?.A;
  const effectiveUrlB =
    options.liveUrls?.B ?? bundle.abReport.browserDiff?.urls?.B;
  const interactiveBrowser =
    isCheckEnabled(config, 'interactive-browser') &&
    Boolean(effectiveUrlA || effectiveUrlB);
  const extraMcpServers = interactiveBrowser
    ? [resolvePlaywrightMcpServer(config)]
    : undefined;
  const liveUrlsNote = interactiveBrowser
    ? `\nLive Standalone A/B URLs available for Playwright inspection: A=${effectiveUrlA ?? 'N/A'}, B=${effectiveUrlB ?? 'N/A'}`
    : '';

  // Stage 1: Parallel Specialist Lenses
  const lensEfforts = activeLenses.map((lens) => ({
    lens,
    effort: resolveStageEffort({
      stage: 'specialist',
      config,
      lens,
      bundle,
      triage,
      verificationMatrix,
    }),
  }));
  logger?.info?.(
    `Stage 1 (Specialists): ${lensEfforts.map((l) => `${l.lens}[effort=${l.effort}]`).join(', ')}`,
  );
  const specialistResults = await Promise.all(
    lensEfforts.map(async ({ lens, effort }) => {
      const model = config.models.specialists[lens];
      const prompt = buildSpecialistPrompt(lens, bundle, triage);
      const isUi = lens === 'ui';
      const res = await runStage(
        {
          stage: `specialist:${lens}`,
          model,
          cwd,
          systemPrompt: prompt.systemPrompt,
          sharedPrefix,
          userPrompt: isUi && liveUrlsNote ? `${prompt.userPrompt}${liveUrlsNote}` : prompt.userPrompt,
          schema: SpecialistOutputSchema,
          schemaName: `SpecialistOutput_${lens}`,
          mcpScope,
          effort,
          ...(isUi && browserImages.length > 0 ? { images: browserImages } : {}),
          ...(isUi && extraMcpServers ? { extraMcpServers } : {}),
          maxSteps: config.review.maxSteps,
        },
        registry,
      );
      return { lens, res };
    }),
  );

  const candidates: CandidateFinding[] = [];
  const standardsLists: Array<StandardVerdict[] | undefined> = [];
  const blastRadiusLists: Array<BlastRadiusItem[] | undefined> = [];

  for (const { lens, res } of specialistResults) {
    modelsUsed[`specialist:${lens}`] = res.model;
    if (accumulateUsage(tokenTotals, `specialist:${lens}`, res.model, res.usage)) {
      hasUsage = true;
    }
    candidates.push(...res.output.findings);
    standardsLists.push(res.output.standards);
    blastRadiusLists.push(res.output.blastRadius);
  }

  let standards = mergeStandards(standardsLists);
  const blastRadius = mergeBlastRadius(blastRadiusLists);

  // Stage 2: Sceptical Adversarial Verifier
  let rawVerified: VerifiedFinding[] = [];
  if (candidates.length > 0) {
    const verifierEffort = resolveStageEffort({
      stage: 'verifier',
      config,
      bundle,
      triage,
      candidates,
      verificationMatrix,
    });
    logger?.info?.(
      `Stage 2 (Verifier) auditing ${candidates.length} candidate(s) using ${config.models.verifier} [effort=${verifierEffort}]`,
    );
    const verifierPrompt = buildVerifierPrompt(bundle, candidates, standards);
    const liveProveEnabled =
      isCheckEnabled(config, 'live-prove') &&
      Boolean(
        effectiveUrlA ||
          effectiveUrlB ||
          options.composeFiles?.A ||
          options.composeFiles?.B,
      );
    const extraTools = liveProveEnabled
      ? createLiveProbeTool({
          urlA: effectiveUrlA,
          urlB: effectiveUrlB,
          composeFileA: options.composeFiles?.A,
          composeFileB: options.composeFiles?.B,
        })
      : undefined;

    const verifierResult = await runStage(
      {
        stage: 'verifier',
        model: config.models.verifier,
        cwd,
        systemPrompt: verifierPrompt.systemPrompt,
        sharedPrefix,
        userPrompt: liveUrlsNote
          ? `${verifierPrompt.userPrompt}${liveUrlsNote}`
          : verifierPrompt.userPrompt,
        schema: VerifierOutputSchema,
        schemaName: 'VerifierOutput',
        mcpScope,
        effort: verifierEffort,
        ...(browserImages.length > 0 ? { images: browserImages } : {}),
        ...(extraTools ? { extraTools } : {}),
        ...(extraMcpServers ? { extraMcpServers } : {}),
        maxSteps: config.review.maxSteps,
      },
      registry,
    );
    modelsUsed.verifier = verifierResult.model;
    if (accumulateUsage(tokenTotals, 'verifier', verifierResult.model, verifierResult.usage)) {
      hasUsage = true;
    }
    rawVerified = verifierResult.output.verifiedFindings;
    standards = adoptReconciledStandards(
      standards,
      verifierResult.output.reconciledStandards,
    );
  } else {
    logger?.info?.('Stage 2 (Verifier) skipped: 0 candidate findings.');
  }

  // Stage 3: Confidence Gate, Dedup, Ranking & Inline Cap
  const gated = rawVerified.filter(
    (f) =>
      f.verdict !== 'REJECTED' &&
      f.confidence >= config.review.confidenceThreshold,
  );
  const deduped = deduplicateVerifiedFindings(gated);
  const sorted = [...deduped].sort(compareVerifiedFindings);

  // Cap inline-mapped findings at config.review.maxInlineComments while preserving out-of-diff findings
  const mapped = mapFindingsToDiff(sorted, bundle.diffFiles);
  const maxInline = config.review.maxInlineComments;
  const keptInlineIds = new Set(
    mapped.inlineFindings.slice(0, maxInline).map((m) => m.finding.id),
  );
  const summaryIds = new Set(mapped.summaryOnlyFindings.map((f) => f.id));

  const survivingFindings = sorted.filter(
    (f) => keptInlineIds.has(f.id) || summaryIds.has(f.id),
  );

  const droppedCount = Math.max(0, rawVerified.length - survivingFindings.length);
  const verdict = computeFinalVerdict(survivingFindings);
  const { score, rationale: scoreRationale } = computeConfidenceScore({
    verdict,
    findings: survivingFindings,
    verificationMatrix,
    prKind: triage.prKind,
  });
  const shortSummary = buildShortSummary({
    prTitle: bundle.pr.title,
    triageSummary: triage.shortSummary,
    findings: survivingFindings,
    verificationMatrix,
    scoreRationale,
  });
  standards = reconcileStandardsDeterministically({
    standards,
    verdict,
    survivingFindings,
    verificationMatrix,
    bundle,
  });

  return FinalReviewSchema.parse({
    schemaVersion: '1',
    repo: bundle.pr.repo,
    prNumber: bundle.pr.prNumber,
    baseSha: bundle.pr.baseSha,
    headSha: bundle.pr.headSha,
    prKind: triage.prKind,
    verdict,
    score,
    scoreRationale,
    shortSummary,
    walkthrough: triage.summaryBullets,
    verificationMatrix,
    notVerified,
    standards,
    blastRadius,
    findings: survivingFindings,
    droppedCount,
    modelsUsed,
    tokenUsage: hasUsage ? tokenTotals : undefined,
    generatedAt: new Date().toISOString(),
  });
}

/**
 * Generates an interactive follow-up reply for an inline `@civireview` thread comment.
 */
export async function runThreadReply(
  options: RunThreadReplyOptions,
): Promise<ThreadReplyOutput> {
  const { bundle, filteredPatch, threadContext, config, cwd } = options;
  const registry = options.registry ?? createRunnerRegistry();

  const mcpScope = resolveMcpScope({
    isPrivateRepo: bundle.pr.isPrivateRepo,
    config,
  });
  const sharedPrefix = buildSharedEvidencePrefix(bundle, filteredPatch);
  const prompt = buildThreadReplyPrompt(threadContext);

  const replyEffort = resolveStageEffort({
    stage: 'threadReply',
    config,
    bundle,
  });

  const res = await runStage(
    {
      stage: 'thread-reply',
      model: config.models.threadReply,
      cwd,
      systemPrompt: prompt.systemPrompt,
      sharedPrefix,
      userPrompt: prompt.userPrompt,
      schema: ThreadReplyOutputSchema,
      schemaName: 'ThreadReplyOutput',
      mcpScope,
      effort: replyEffort,
      maxSteps: config.review.maxSteps,
    },
    registry,
  );

  return res.output;
}
