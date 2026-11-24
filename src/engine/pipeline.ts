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
import { estimateStageCostUsd, formatUsd, roundUsd } from '../runners/pricing.ts';
import { createRunnerRegistry, runStage, type RunnerRegistry } from '../runners/registry.ts';
import type { ExtraMcpServerConfig, StageImageInput, StageUsage } from '../runners/types.ts';
import {
  compareVerifiedFindings,
  computeFinalVerdict,
  deduplicateVerifiedFindings,
  filterGroundedRelatedItems,
  mergeBlastRadius,
} from './findings.ts';
import {
  adoptReconciledStandards,
  applyThreadResolutionsToMatrix,
  buildShortSummary,
  buildVerificationMatrix,
  CANONICAL_STANDARD_CODES,
  computeConfidenceScore,
  mergeStandards,
  reconcileMatrixForTriage,
  reconcileStandardsDeterministically,
  resolveStageEffort,
  type ConfidenceScoreResult,
} from './matrix.ts';
import {
  FinalReviewSchema,
  SpecialistOutputSchema,
  ThreadReplyOutputSchema,
  TriageOutputSchema,
  VerifierOutputSchema,
  type BlastRadiusItem,
  type CandidateFinding,
  type FinalReview,
  type FollowUpLead,
  type SpecialistLens,
  type StandardVerdict,
  type ThreadReplyOutput,
  type ThreadResolution,
  type TokenUsageTotals,
  type TriageOutput,
  type VerifiedFinding,
} from './schemas.ts';
import { assertBudgetEnforceable, assertWithinBudget } from './budget.ts';
import {
  acceptedSkipReason,
  collectVerdicts,
  hasRunEvidence,
  withoutUnprovenProof,
  withUniqueIds,
} from './verdicts.ts';

export {
  buildShortSummary,
  buildVerificationMatrix,
  CANONICAL_STANDARD_CODES,
  computeConfidenceScore,
  computeFinalVerdict,
  resolveStageEffort,
  type ConfidenceScoreResult,
};

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
  /** Filled stage by stage, so a caller can read the cost of a review that threw. */
  usage?: TokenUsageTotals;
}

export interface RunThreadReplyOptions {
  bundle: EvidenceBundle;
  filteredPatch: string;
  threadContext: ThreadReplyInput;
  /** Receives the cost of the reply. */
  usage?: TokenUsageTotals;
  config: ResolvedCiviReviewConfig;
  cwd: string;
  registry?: RunnerRegistry;
}

function formatStageTelemetry(params: {
  stage: string;
  model: ModelSpec;
  effort?: string;
  maxSteps?: number;
  durationMs: number;
  usage?: StageUsage;
  stageCost?: number;
}): string {
  const { stage, model, effort, maxSteps, durationMs, usage, stageCost } = params;
  const durStr = `${(durationMs / 1000).toFixed(1)}s`;
  const effortStr = effort ? ` effort=${effort}` : '';
  if (!usage) {
    return `[stage] ${stage} model=${model}${effortStr} dur=${durStr} usage=n/a`;
  }
  const stepsStr =
    usage.steps !== undefined
      ? ` steps=${usage.steps}${maxSteps !== undefined ? `/${maxSteps}` : ''}${usage.toolCalls !== undefined ? ` tools=${usage.toolCalls}` : ''}`
      : '';
  const cacheWrite = usage.cacheWriteInputTokens ?? 0;
  const cacheRead = usage.cachedInputTokens ?? 0;
  const totalIn = usage.inputTokens + cacheWrite + cacheRead;
  const hitPct = totalIn > 0 ? Math.round((cacheRead / totalIn) * 100) : 0;
  const costStr = stageCost !== undefined ? ` cost=${formatUsd(stageCost)}` : '';
  return (
    `[stage] ${stage} model=${model}${effortStr}${stepsStr} dur=${durStr}` +
    ` in=${usage.inputTokens.toLocaleString('en-US')}` +
    ` cache_write=${cacheWrite.toLocaleString('en-US')}` +
    ` cache_read=${cacheRead.toLocaleString('en-US')} (${hitPct}% hit)` +
    ` out=${usage.outputTokens.toLocaleString('en-US')}${costStr}`
  );
}

function formatTotalTelemetry(totals: TokenUsageTotals, totalDurationMs: number): string {
  const cacheWrite = totals.cacheWriteInputTokens ?? 0;
  const cacheRead = totals.cachedInputTokens ?? 0;
  const totalIn = totals.inputTokens + cacheWrite + cacheRead;
  const hitPct = totalIn > 0 ? Math.round((cacheRead / totalIn) * 100) : 0;
  const stages = totals.byStage?.length ?? 0;
  const costStr =
    totals.estimatedUsd !== undefined ? ` cost=${formatUsd(totals.estimatedUsd)}` : '';
  return (
    `[telemetry] total stages=${stages} dur=${(totalDurationMs / 1000).toFixed(1)}s` +
    ` in=${totals.inputTokens.toLocaleString('en-US')}` +
    ` cache_write=${cacheWrite.toLocaleString('en-US')}` +
    ` cache_read=${cacheRead.toLocaleString('en-US')} (${hitPct}% hit)` +
    ` out=${totals.outputTokens.toLocaleString('en-US')}${costStr}`
  );
}

function accumulateUsage(
  totals: TokenUsageTotals,
  stage: string,
  model: ModelSpec,
  usage: StageUsage | undefined,
): { recorded: boolean; stageCost?: number } {
  if (!usage) return { recorded: false };
  totals.inputTokens += usage.inputTokens;
  totals.outputTokens += usage.outputTokens;
  totals.totalTokens += usage.totalTokens;
  if (usage.cachedInputTokens !== undefined) {
    totals.cachedInputTokens = (totals.cachedInputTokens ?? 0) + usage.cachedInputTokens;
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
    ...(usage.steps !== undefined ? { steps: usage.steps } : {}),
    ...(usage.toolCalls !== undefined ? { toolCalls: usage.toolCalls } : {}),
  });
  return { recorded: true, stageCost };
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

function inferImageMediaType(filePath: string): StageImageInput['mediaType'] {
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

function resolvePlaywrightMcpServer(config: ResolvedCiviReviewConfig): ExtraMcpServerConfig {
  const raw = config.browser.playwrightMcpCommand ?? 'npx -y @playwright/mcp@latest';
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
export async function materializeHeadWorktree(
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
      const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
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
    // Uncommitted edits in the checkout would be read as if they were part of the PR head,
    // so a dirty tree is reviewed from a clean worktree of the same commit instead.
    const statusRes = await runGit(['status', '--porcelain', '--untracked-files=no']);
    if (statusRes.code === 0 && statusRes.out === '') {
      return { effectiveCwd: cwd, atHeadSha: true, cleanup: async () => {} };
    }
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

/**
 * Executes the full multi-stage Layer 2 review pipeline:
 * Stage 0 (Triage) -> Stage 1 (Parallel Specialist Lenses) ->
 * Stage 2 (Sceptical Adversarial Verifier) -> Stage 3 (Gate, Dedup, Rank).
 */
export async function runReviewPipeline(options: RunReviewPipelineOptions): Promise<FinalReview> {
  const { bundle, filteredPatch, config, cwd } = options;
  const registry = options.registry ?? createRunnerRegistry();
  assertBudgetEnforceable(config);

  const mcpScope = resolveMcpScope({
    isPrivateRepo: bundle.pr.isPrivateRepo,
    config,
  });

  const headWorktree = await materializeHeadWorktree(cwd, bundle.pr.headSha);
  const effectiveCwd = headWorktree.effectiveCwd;
  const sharedPrefix = buildSharedEvidencePrefix(bundle, filteredPatch, headWorktree.atHeadSha);

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

  const pipelineStart = Date.now();
  const modelsUsed: Record<string, ModelSpec> = {};
  const tokenTotals: TokenUsageTotals = options.usage ?? {
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
  };
  let hasUsage = false;

  const { verificationMatrix: initialMatrix, notVerified } = buildVerificationMatrix(bundle);
  let verificationMatrix = initialMatrix;

  // Stage 0: Triage
  const triageEffort = resolveStageEffort({
    stage: 'triage',
    config,
    bundle,
    verificationMatrix,
  });
  const triageMaxSteps = Math.min(config.review.maxSteps, config.review.triageMaxSteps ?? 10);
  const maxOutputTokens = config.review.maxOutputTokens;
  logger?.info?.(`Stage 0 (Triage) using ${config.models.triage} [effort=${triageEffort}]`);
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
      maxSteps: triageMaxSteps,
      maxOutputTokens,
      timeoutMs: config.review.stageTimeoutMs,
    },
    registry,
  );
  modelsUsed.triage = triageResult.model;
  const triageAcc = accumulateUsage(tokenTotals, 'triage', triageResult.model, triageResult.usage);
  if (triageAcc.recorded) {
    hasUsage = true;
  }
  logger?.info?.(
    formatStageTelemetry({
      stage: 'triage',
      model: triageResult.model,
      effort: triageEffort,
      maxSteps: triageMaxSteps,
      durationMs: triageResult.durationMs,
      usage: triageResult.usage,
      stageCost: triageAcc.stageCost,
    }),
  );

  const triage = triageResult.output;
  verificationMatrix = reconcileMatrixForTriage(verificationMatrix, triage);
  const relatedItems = filterGroundedRelatedItems(triage.relatedItems, bundle);
  const browserSignal = hasBrowserSignal(bundle);
  const candidateLenses = Array.from(
    new Set([...triage.activeLenses, ...(browserSignal ? (['ui'] as const) : [])]),
  );
  const activeLenses = candidateLenses.filter((lens) => isLensEnabled(config, lens));

  const skipReason = acceptedSkipReason(triage, bundle, (m) => logger?.warn?.(m));
  if (!skipReason && candidateLenses.length === 0) {
    throw new Error(
      'Triage returned no active lenses and no skipReason; refusing to report an unreviewed PR as ready.',
    );
  }

  if ((skipReason && !browserSignal) || activeLenses.length === 0) {
    const skippedReason =
      skipReason ?? 'All specialist lenses selected by triage are disabled by config.';
    if (!skipReason) notVerified.push(`The code was not reviewed: ${skippedReason}`);
    logger?.info?.(`Triage skipped specialists: ${skippedReason}`);
    const skipVerdict = computeFinalVerdict([], verificationMatrix);
    const skipScore = computeConfidenceScore({
      verdict: skipVerdict,
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
    if (hasUsage) {
      logger?.info?.(formatTotalTelemetry(tokenTotals, Date.now() - pipelineStart));
    }

    return FinalReviewSchema.parse({
      schemaVersion: '1',
      repo: bundle.pr.repo,
      prNumber: bundle.pr.prNumber,
      baseSha: bundle.pr.baseSha,
      headSha: bundle.pr.headSha,
      prKind: triage.prKind,
      verdict: skipVerdict,
      score: skipScore.score,
      scoreRationale: skipScore.rationale,
      shortSummary: skipShortSummary,
      // A reason the PR was not reviewed must be visible; triage's own skip reason is
      // already implied by its summary.
      walkthrough:
        triage.summaryBullets.length > 0
          ? [...triage.summaryBullets, ...(skipReason ? [] : [skippedReason])]
          : [skippedReason],
      verificationMatrix,
      notVerified,
      blastRadius: [],
      ...(relatedItems.length > 0 ? { relatedItems } : {}),
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
  const effectiveUrlA = options.liveUrls?.A ?? bundle.abReport.browserDiff?.urls?.A;
  const effectiveUrlB = options.liveUrls?.B ?? bundle.abReport.browserDiff?.urls?.B;
  const interactiveBrowser =
    isCheckEnabled(config, 'interactive-browser') && Boolean(effectiveUrlA || effectiveUrlB);
  const extraMcpServers = interactiveBrowser ? [resolvePlaywrightMcpServer(config)] : undefined;
  const liveUrlsNote = interactiveBrowser
    ? `\nLive Standalone A/B URLs available for Playwright inspection: A=${effectiveUrlA ?? 'N/A'}, B=${effectiveUrlB ?? 'N/A'}`
    : '';

  // Stage 1: Sequential Specialist Lenses
  // Run sequentially so specialist #1 writes the sharedPrefix+tools KV cache once
  // and specialists #2..N reuse it via warm cache-read hits instead of racing cold writes.
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
    `Stage 1 (Specialists, sequential): ${lensEfforts.map((l) => `${l.lens}[effort=${l.effort}]`).join(', ')}`,
  );

  const candidates: CandidateFinding[] = [];
  const candidateIds = new Set<string>();
  const standardsLists: Array<StandardVerdict[] | undefined> = [];
  const blastRadiusLists: Array<BlastRadiusItem[] | undefined> = [];

  for (const { lens, effort } of lensEfforts) {
    const model = config.models.specialists[lens];
    const prompt = buildSpecialistPrompt(lens, bundle, triage);
    const isUi = lens === 'ui';
    const stageName = `specialist:${lens}`;
    assertWithinBudget(tokenTotals.estimatedUsd, config.review.maxBudgetUsd, stageName);
    const res = await runStage(
      {
        stage: stageName,
        model,
        cwd,
        systemPrompt: prompt.systemPrompt,
        sharedPrefix,
        userPrompt:
          isUi && liveUrlsNote ? `${prompt.userPrompt}${liveUrlsNote}` : prompt.userPrompt,
        schema: SpecialistOutputSchema,
        schemaName: `SpecialistOutput_${lens}`,
        mcpScope,
        effort,
        ...(isUi && browserImages.length > 0 ? { images: browserImages } : {}),
        ...(isUi && extraMcpServers ? { extraMcpServers } : {}),
        maxSteps: config.review.maxSteps,
        maxOutputTokens,
        timeoutMs: config.review.stageTimeoutMs,
      },
      registry,
    );
    modelsUsed[stageName] = res.model;
    const specAcc = accumulateUsage(tokenTotals, stageName, res.model, res.usage);
    if (specAcc.recorded) {
      hasUsage = true;
    }
    logger?.info?.(
      formatStageTelemetry({
        stage: stageName,
        model: res.model,
        effort,
        maxSteps: config.review.maxSteps,
        durationMs: res.durationMs,
        usage: res.usage,
        stageCost: specAcc.stageCost,
      }),
    );
    candidates.push(...withUniqueIds(res.output.findings, candidateIds));
    standardsLists.push(res.output.standards);
    blastRadiusLists.push(res.output.blastRadius);
  }

  let standards = mergeStandards(standardsLists);
  let walkthrough = triage.summaryBullets;
  // Stage 2: Sceptical Adversarial Verifier (+ bounded follow-up investigation loop)
  // In `deep` mode, always run Verifier even when Stage 1 returned 0 candidates so Opus
  // audits the PR, reconciles early Stage 0 walkthrough guesses, and can emit followUpLeads.
  const maxFollowUpRounds = config.review.maxFollowUpRounds;
  let rawVerified: VerifiedFinding[] = [];
  let blastRadius = mergeBlastRadius(blastRadiusLists);
  let threadResolutions: ThreadResolution[] | undefined;
  const shouldRunVerifier = candidates.length > 0 || (config.review.depth ?? 'deep') === 'deep';
  if (shouldRunVerifier) {
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
    const verifierPrompt = buildVerifierPrompt(bundle, candidates, standards, {
      allowFollowUpLeads: maxFollowUpRounds > 0,
      triageBullets: walkthrough,
      blastRadius,
      confidenceThreshold: config.review.confidenceThreshold,
    });
    const liveProveEnabled =
      isCheckEnabled(config, 'live-prove') &&
      Boolean(effectiveUrlA || effectiveUrlB || options.composeFiles?.A || options.composeFiles?.B);
    const extraTools = liveProveEnabled
      ? createLiveProbeTool({
          urlA: effectiveUrlA,
          urlB: effectiveUrlB,
          composeFileA: options.composeFiles?.A,
          composeFileB: options.composeFiles?.B,
        })
      : undefined;

    const runVerifier = async (
      stage: string,
      schemaName: string,
      prompt: StagePromptPair,
      effort: EffortLevel,
    ) => {
      assertWithinBudget(tokenTotals.estimatedUsd, config.review.maxBudgetUsd, stage);
      const res = await runStage(
        {
          stage,
          model: config.models.verifier,
          cwd,
          systemPrompt: prompt.systemPrompt,
          sharedPrefix,
          userPrompt: liveUrlsNote ? `${prompt.userPrompt}${liveUrlsNote}` : prompt.userPrompt,
          schema: VerifierOutputSchema,
          schemaName,
          mcpScope,
          effort,
          ...(browserImages.length > 0 ? { images: browserImages } : {}),
          ...(extraTools ? { extraTools } : {}),
          ...(extraMcpServers ? { extraMcpServers } : {}),
          maxSteps: config.review.maxSteps,
          maxOutputTokens,
          timeoutMs: config.review.stageTimeoutMs,
        },
        registry,
      );
      modelsUsed[stage] = res.model;
      const acc = accumulateUsage(tokenTotals, stage, res.model, res.usage);
      if (acc.recorded) hasUsage = true;
      logger?.info?.(
        formatStageTelemetry({
          stage,
          model: res.model,
          effort,
          maxSteps: config.review.maxSteps,
          durationMs: res.durationMs,
          usage: res.usage,
          stageCost: acc.stageCost,
        }),
      );
      return res.output;
    };
    const verdictsFor = (
      batch: CandidateFinding[],
      first: VerifiedFinding[],
      effort: EffortLevel,
      stagePrefix: string,
    ) =>
      collectVerdicts({
        batch,
        first,
        stagePrefix,
        warn: (m) => logger?.warn?.(m),
        ask: async (missing, stage) => {
          const prompt = buildVerifierPrompt(bundle, missing, standards, {
            allowFollowUpLeads: false,
            confidenceThreshold: config.review.confidenceThreshold,
          });
          const out = await runVerifier(stage, 'VerifierOutput', prompt, effort);
          standards = adoptReconciledStandards(standards, out.reconciledStandards);
          return out.verifiedFindings;
        },
      });

    const verifierOutput = await runVerifier(
      'verifier',
      'VerifierOutput',
      verifierPrompt,
      verifierEffort,
    );
    standards = adoptReconciledStandards(standards, verifierOutput.reconciledStandards);
    rawVerified = await verdictsFor(
      candidates,
      verifierOutput.verifiedFindings,
      verifierEffort,
      'verifier',
    );
    if (verifierOutput.reconciledWalkthrough && verifierOutput.reconciledWalkthrough.length > 0) {
      walkthrough = verifierOutput.reconciledWalkthrough;
    }
    if (verifierOutput.reconciledBlastRadius) {
      blastRadius = mergeBlastRadius([verifierOutput.reconciledBlastRadius]);
    }
    if (verifierOutput.threadResolutions && verifierOutput.threadResolutions.length > 0) {
      threadResolutions = verifierOutput.threadResolutions;
    }

    // Bounded Verifier -> Follow-up Specialist -> Verifier loop (at most maxFollowUpRounds)
    let pendingLeads: FollowUpLead[] = verifierOutput.followUpLeads ?? [];
    for (let round = 1; round <= maxFollowUpRounds && pendingLeads.length > 0; round++) {
      const enabledLeads = pendingLeads
        .filter((lead) => isLensEnabled(config, lead.lens))
        .slice(0, 2);
      if (enabledLeads.length === 0) break;

      logger?.info?.(
        `Follow-up round ${round}/${maxFollowUpRounds}: investigating ${enabledLeads.length} lead(s) (${enabledLeads.map((l) => l.lens).join(', ')})`,
      );

      const followUpCandidates: CandidateFinding[] = [];
      for (const lead of enabledLeads) {
        const model = config.models.specialists[lead.lens];
        const effort = resolveStageEffort({
          stage: 'specialist',
          config,
          lens: lead.lens,
          bundle,
          triage,
          verificationMatrix,
        });
        const basePrompt = buildSpecialistPrompt(lead.lens, bundle, triage);
        const targetPathsNote =
          lead.targetPaths.length > 0
            ? `\nTarget paths to inspect: ${lead.targetPaths.join(', ')}`
            : '';
        const followUpDirective =
          `\n\nFOLLOW-UP INVESTIGATION (Round ${round}/${maxFollowUpRounds}, requested by Verifier):` +
          `\nQuestion: ${lead.question}` +
          `\nReason: ${lead.reason}${targetPathsNote}` +
          `\nFocus ONLY on this specific lead. Do not repeat previously checked findings unless you have new evidence.`;
        const isUi = lead.lens === 'ui';
        const stageName = `specialist:${lead.lens}:followup-${round}`;
        assertWithinBudget(tokenTotals.estimatedUsd, config.review.maxBudgetUsd, stageName);
        const res = await runStage(
          {
            stage: stageName,
            model,
            cwd,
            systemPrompt: basePrompt.systemPrompt,
            sharedPrefix,
            userPrompt: `${basePrompt.userPrompt}${isUi && liveUrlsNote ? liveUrlsNote : ''}${followUpDirective}`,
            schema: SpecialistOutputSchema,
            schemaName: `SpecialistOutput_${lead.lens}_followup_${round}`,
            mcpScope,
            effort,
            ...(isUi && browserImages.length > 0 ? { images: browserImages } : {}),
            ...(isUi && extraMcpServers ? { extraMcpServers } : {}),
            maxSteps: config.review.maxSteps,
            maxOutputTokens,
            timeoutMs: config.review.stageTimeoutMs,
          },
          registry,
        );
        modelsUsed[stageName] = res.model;
        const acc = accumulateUsage(tokenTotals, stageName, res.model, res.usage);
        if (acc.recorded) hasUsage = true;
        logger?.info?.(
          formatStageTelemetry({
            stage: stageName,
            model: res.model,
            effort,
            maxSteps: config.review.maxSteps,
            durationMs: res.durationMs,
            usage: res.usage,
            stageCost: acc.stageCost,
          }),
        );
        followUpCandidates.push(...withUniqueIds(res.output.findings, candidateIds));
        if (res.output.blastRadius && res.output.blastRadius.length > 0) {
          blastRadiusLists.push(res.output.blastRadius);
          blastRadius = mergeBlastRadius(blastRadiusLists);
        }
      }

      if (followUpCandidates.length === 0) {
        logger?.info?.(
          `Follow-up round ${round}/${maxFollowUpRounds}: 0 new candidates; stopping loop.`,
        );
        break;
      }

      const fuVerifierEffort = resolveStageEffort({
        stage: 'verifier',
        config,
        bundle,
        triage,
        candidates: followUpCandidates,
        verificationMatrix,
      });
      const fuStageName = `verifier:followup-${round}`;
      const fuVerifierPrompt = buildVerifierPrompt(bundle, followUpCandidates, standards, {
        allowFollowUpLeads: round < maxFollowUpRounds,
        triageBullets: walkthrough,
        blastRadius,
        confidenceThreshold: config.review.confidenceThreshold,
      });
      const fuOutput = await runVerifier(
        fuStageName,
        `VerifierOutput_followup_${round}`,
        fuVerifierPrompt,
        fuVerifierEffort,
      );
      standards = adoptReconciledStandards(standards, fuOutput.reconciledStandards);
      rawVerified.push(
        ...(await verdictsFor(
          followUpCandidates,
          fuOutput.verifiedFindings,
          fuVerifierEffort,
          fuStageName,
        )),
      );
      if (fuOutput.reconciledWalkthrough && fuOutput.reconciledWalkthrough.length > 0) {
        walkthrough = fuOutput.reconciledWalkthrough;
      }
      if (fuOutput.reconciledBlastRadius) {
        blastRadius = mergeBlastRadius([fuOutput.reconciledBlastRadius]);
      }
      if (fuOutput.threadResolutions && fuOutput.threadResolutions.length > 0) {
        threadResolutions = fuOutput.threadResolutions;
      }
      pendingLeads = round < maxFollowUpRounds ? (fuOutput.followUpLeads ?? []) : [];
    }
  } else {
    logger?.info?.('Stage 2 (Verifier) skipped: 0 candidate findings.');
  }

  // Stage 3: Confidence Gate, Dedup, Ranking & Inline Cap
  rawVerified = withoutUnprovenProof(rawVerified, hasRunEvidence(bundle), (m) => logger?.warn?.(m));
  for (const f of rawVerified) {
    logger?.info?.(
      `[finding] ${f.id} lens=${f.lens} ${f.verdict} confidence=${f.confidence} severity=${f.reassessedSeverity} "${f.title}" — ${f.verificationEvidence.slice(0, 300)}`,
    );
  }
  const rejectedFindings = rawVerified
    .filter(
      (f) =>
        f.verdict === 'REJECTED' || f.confidence < Math.min(50, config.review.confidenceThreshold),
    )
    .toSorted(compareVerifiedFindings);
  const gated = rawVerified.filter(
    (f) => f.verdict !== 'REJECTED' && f.confidence >= config.review.confidenceThreshold,
  );
  const uncertainCandidates = rawVerified.filter(
    (f) =>
      f.verdict !== 'REJECTED' &&
      f.confidence >= 50 &&
      f.confidence < config.review.confidenceThreshold,
  );
  const uncertainFindings = deduplicateVerifiedFindings(uncertainCandidates)
    .toSorted(compareVerifiedFindings)
    .slice(0, 5);
  const deduped = deduplicateVerifiedFindings(gated);
  const sorted = deduped.toSorted(compareVerifiedFindings);

  // The formatter caps inline comments and moves the overflow into the summary.
  const survivingFindings = sorted;

  const droppedCount = Math.max(0, rawVerified.length - survivingFindings.length);
  if (rawVerified.length > 0) {
    const counts = { PROVEN: 0, CONFIRMED: 0, NEEDS_QUESTION: 0, REJECTED: 0 };
    for (const f of rawVerified) {
      counts[f.verdict]++;
    }
    logger?.info?.(
      `[stage] verifier verdicts: total=${rawVerified.length} PROVEN=${counts.PROVEN} CONFIRMED=${counts.CONFIRMED} NEEDS_QUESTION=${counts.NEEDS_QUESTION} REJECTED=${counts.REJECTED} surviving=${survivingFindings.length} dropped=${droppedCount} (threshold=${config.review.confidenceThreshold})`,
    );
  }
  verificationMatrix = applyThreadResolutionsToMatrix(
    verificationMatrix,
    threadResolutions,
    config.review.mentionUsers,
  );
  const verdict = computeFinalVerdict(survivingFindings, verificationMatrix);
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

  if (hasUsage) {
    logger?.info?.(formatTotalTelemetry(tokenTotals, Date.now() - pipelineStart));
  }

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
    walkthrough,
    verificationMatrix,
    notVerified,
    standards,
    blastRadius,
    ...(relatedItems.length > 0 ? { relatedItems } : {}),
    ...(threadResolutions && threadResolutions.length > 0 ? { threadResolutions } : {}),
    findings: survivingFindings,
    ...(uncertainFindings.length > 0 ? { uncertainFindings } : {}),
    ...(rejectedFindings.length > 0 ? { rejectedFindings } : {}),
    droppedCount,
    modelsUsed,
    tokenUsage: hasUsage ? tokenTotals : undefined,
    generatedAt: new Date().toISOString(),
  });
}

/**
 * Generates an interactive follow-up reply for an inline `@civireview` thread comment.
 */
export async function runThreadReply(options: RunThreadReplyOptions): Promise<ThreadReplyOutput> {
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
  if (options.usage) accumulateUsage(options.usage, 'thread-reply', res.model, res.usage);

  return res.output;
}
