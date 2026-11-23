import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  isCheckEnabled,
  isLensEnabled,
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
import { createRunnerRegistry, runStage, type RunnerRegistry } from '../runners/registry.ts';
import type { ExtraMcpServerConfig, StageImageInput, StageUsage } from '../runners/types.ts';
import {
  compareVerifiedFindings,
  computeFinalVerdict,
  deduplicateVerifiedFindings,
  mergeBlastRadius,
} from './findings.ts';
import { mapFindingsToDiff } from './line-mapper.ts';
import {
  adoptReconciledStandards,
  buildShortSummary,
  buildVerificationMatrix,
  CANONICAL_STANDARD_CODES,
  computeConfidenceScore,
  mergeStandards,
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
  type SpecialistLens,
  type StandardVerdict,
  type ThreadReplyOutput,
  type TokenUsageTotals,
  type TriageOutput,
  type VerifiedFinding,
} from './schemas.ts';

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
}

export interface RunThreadReplyOptions {
  bundle: EvidenceBundle;
  filteredPatch: string;
  threadContext: ThreadReplyInput;
  config: ResolvedCiviReviewConfig;
  cwd: string;
  registry?: RunnerRegistry;
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
async function materializeHeadWorktree(cwd: string, headSha: string): Promise<HeadWorktreeHandle> {
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

/**
 * Executes the full multi-stage Layer 2 review pipeline:
 * Stage 0 (Triage) -> Stage 1 (Parallel Specialist Lenses) ->
 * Stage 2 (Sceptical Adversarial Verifier) -> Stage 3 (Gate, Dedup, Rank).
 */
export async function runReviewPipeline(options: RunReviewPipelineOptions): Promise<FinalReview> {
  const { bundle, filteredPatch, config, cwd } = options;
  const registry = options.registry ?? createRunnerRegistry();

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
    new Set([...triage.activeLenses, ...(browserSignal ? (['ui'] as const) : [])]),
  );
  const activeLenses = candidateLenses.filter((lens) => isLensEnabled(config, lens));

  if ((triage.skipReason && !browserSignal) || activeLenses.length === 0) {
    logger?.info?.(`Triage skipped specialists: ${triage.skipReason ?? 'no active lenses'}`);
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
  const effectiveUrlA = options.liveUrls?.A ?? bundle.abReport.browserDiff?.urls?.A;
  const effectiveUrlB = options.liveUrls?.B ?? bundle.abReport.browserDiff?.urls?.B;
  const interactiveBrowser =
    isCheckEnabled(config, 'interactive-browser') && Boolean(effectiveUrlA || effectiveUrlB);
  const extraMcpServers = interactiveBrowser ? [resolvePlaywrightMcpServer(config)] : undefined;
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
          userPrompt:
            isUi && liveUrlsNote ? `${prompt.userPrompt}${liveUrlsNote}` : prompt.userPrompt,
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
      Boolean(effectiveUrlA || effectiveUrlB || options.composeFiles?.A || options.composeFiles?.B);
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
    standards = adoptReconciledStandards(standards, verifierResult.output.reconciledStandards);
  } else {
    logger?.info?.('Stage 2 (Verifier) skipped: 0 candidate findings.');
  }

  // Stage 3: Confidence Gate, Dedup, Ranking & Inline Cap
  const gated = rawVerified.filter(
    (f) => f.verdict !== 'REJECTED' && f.confidence >= config.review.confidenceThreshold,
  );
  const deduped = deduplicateVerifiedFindings(gated);
  const sorted = deduped.toSorted(compareVerifiedFindings);

  // Cap inline-mapped findings at config.review.maxInlineComments while preserving out-of-diff findings
  const mapped = mapFindingsToDiff(sorted, bundle.diffFiles);
  const maxInline = config.review.maxInlineComments;
  const keptInlineIds = new Set(mapped.inlineFindings.slice(0, maxInline).map((m) => m.finding.id));
  const summaryIds = new Set(mapped.summaryOnlyFindings.map((f) => f.id));

  const survivingFindings = sorted.filter((f) => keptInlineIds.has(f.id) || summaryIds.has(f.id));

  const droppedCount = Math.max(0, rawVerified.length - survivingFindings.length);
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

  return res.output;
}
