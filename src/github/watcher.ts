import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Octokit } from '@octokit/rest';
import { BudgetExceededError } from '../engine/budget.ts';
import type { TokenUsageTotals } from '../engine/schemas.ts';
import { resolveModels } from '../config/loader.ts';
import type { AuthorAssociation, ResolvedCiviReviewConfig } from '../config/schema.ts';
import { runReviewPipeline, runThreadReply } from '../engine/pipeline.ts';
import { collectEvidence } from '../evidence/collector.ts';
import type { EvidenceBundle } from '../evidence/types.ts';
import { REVIEW_FORMAT, type FormatReviewOptions } from './formatter.ts';
import {
  extractAllReviewedMarkers,
  resolveGitHubToken,
  writtenBy,
  type MarkerSource,
} from '../evidence/github.ts';
import type { ParsedMentionFlags } from './commands.ts';
import { publishReview, publishThreadReply } from './publisher.ts';
import {
  buildThreadContextFromBundle,
  formatThreadReplyBody,
  hasExistingThreadReplyMarker,
} from './thread-reply.ts';
import {
  hasAnyAuthPolicy,
  isAuthorAuthorized,
  isInlineThreadReplyMention,
  loadSeenState,
  makeCommentKey,
  saveSeenState,
  summarizeRunBudget,
  type AuthorAuthPolicy,
  type SeenState,
  type WatcherCommentItem,
  type WatcherMention,
  type WatcherOctokit,
  type WatcherRunRecord,
} from './watcher-auth.ts';
import {
  pollNotificationMentions,
  pollSearchMentions,
  type PollNotificationsOptions,
  type PollSearchOptions,
  type PrCommentsCacheEntry,
} from './watcher-sources.ts';

export {
  isAuthorAuthorized,
  isInlineThreadReplyMention,
  loadSeenState,
  makeCommentKey,
  pollNotificationMentions,
  pollSearchMentions,
  saveSeenState,
  summarizeRunBudget,
  type AuthorAuthPolicy,
  type PollNotificationsOptions,
  type PollSearchOptions,
  type SeenState,
  type WatcherCommentItem,
  type WatcherMention,
  type WatcherOctokit,
  type WatcherRunRecord,
};

export interface WatcherDeps {
  collectEvidence?: typeof collectEvidence;
  runReviewPipeline?: typeof runReviewPipeline;
  runThreadReply?: typeof runThreadReply;
  publishReview?: typeof publishReview;
  publishThreadReply?: typeof publishThreadReply;
}

export interface WatcherOptions {
  mode: 'search' | 'notifications';
  repos: string[];
  allowedAuthors?: string[];
  allowedOrgs?: string[];
  allowedAssociations?: AuthorAssociation[];
  allowAnyAuthor?: boolean;
  includeClosedPrs?: boolean;
  maxReviewsPerHour?: number;
  maxDailyUsd?: number;
  maxCommentAgeMinutes?: number;
  /** When true, ignore `--preset`, `--model`, and `--verifier` overrides from PR comments. */
  lockModels?: boolean;
  /** When true, defer full PR reviews while CI/Jenkins commit statuses on head SHA are still pending. */
  waitForCi?: boolean;
  /** Max minutes to wait for pending CI before reviewing anyway (default: 90). */
  waitForCiMaxMinutes?: number;
  trigger?: string;
  intervalSec?: number;
  once?: boolean;
  checkOnly?: boolean;
  statePath?: string;
  /** Directory that receives one `review.json` per finished review of a public repository. */
  outDir?: string;
  config: ResolvedCiviReviewConfig;
  repoRoot: string;
  token?: string;
  dryRun?: boolean;
  octokit?: WatcherOctokit;
  signal?: AbortSignal;
  now?: () => number;
  deps?: WatcherDeps;
  onProcessMention?: (mention: WatcherMention) => Promise<void | { estimatedUsd?: number }>;
  logger?: { info(msg: string): void; warn(msg: string): void };
}

export interface WatcherPassResult {
  processed: WatcherMention[];
  pending: WatcherMention[];
  throttled: WatcherMention[];
  skippedDuplicate: WatcherMention[];
  waitingForCi: WatcherMention[];
  failed: WatcherMention[];
}

/** A mention whose processing keeps failing is marked seen after this many attempts. */
export const MAX_MENTION_ATTEMPTS = 3;

function applyMentionFlagsToConfig(
  baseConfig: ResolvedCiviReviewConfig,
  flags: ParsedMentionFlags,
  options: { lockModels?: boolean } = {},
): ResolvedCiviReviewConfig {
  const allowModels = !options.lockModels;
  const preset = allowModels && flags.preset ? flags.preset : baseConfig.preset;
  const models =
    allowModels && (flags.preset || flags.model || flags.verifier)
      ? resolveModels(
          preset,
          flags.preset ? undefined : baseConfig.models,
          flags.model
            ? {
                specialists: {
                  correctness: flags.model,
                  security: flags.model,
                  tests: flags.model,
                  ui: flags.model,
                },
              }
            : undefined,
          flags.verifier ? { verifier: flags.verifier } : undefined,
        )
      : baseConfig.models;

  return {
    ...baseConfig,
    preset,
    models,
    ab: {
      ...baseConfig.ab,
      ...(flags.ab !== undefined ? { enabled: flags.ab } : {}),
      ...(flags.demo !== undefined ? { runDemo: flags.demo } : {}),
    },
    checks: {
      ...baseConfig.checks,
      ...(flags.browser !== undefined ? { browser: flags.browser } : {}),
      ...(flags.interactiveBrowser !== undefined
        ? { interactiveBrowser: flags.interactiveBrowser }
        : {}),
      ...(flags.liveProve !== undefined ? { liveProve: flags.liveProve } : {}),
    },
    browser: {
      ...baseConfig.browser,
      ...(flags.pages && flags.pages.length > 0
        ? {
            pages: Array.from(new Set([...baseConfig.browser.pages, ...flags.pages])),
          }
        : {}),
    },
    review: {
      ...baseConfig.review,
      ...(flags.effort ? { effort: flags.effort } : {}),
      ...(flags.include && flags.include.length > 0 ? { include: flags.include } : {}),
      ...(flags.exclude && flags.exclude.length > 0
        ? {
            exclude: Array.from(new Set([...baseConfig.review.exclude, ...flags.exclude])),
          }
        : {}),
    },
  };
}

function buildLightweightReplyConfig(config: ResolvedCiviReviewConfig): ResolvedCiviReviewConfig {
  return {
    ...config,
    ab: {
      ...config.ab,
      enabled: false,
      runDemo: false,
      runMatrix: false,
      keepStacks: false,
    },
    checks: {
      ...config.checks,
      abTests: false,
      surface: false,
      staticDelta: false,
      lifecycle: false,
      browser: false,
      a11y: false,
      interactiveBrowser: false,
      matrix: false,
      liveProve: false,
    },
  };
}

async function addEyesReaction(octokit: WatcherOctokit, mention: WatcherMention): Promise<void> {
  if (!octokit.rest.reactions) return;
  try {
    if (
      mention.commentKind === 'review_comment' &&
      octokit.rest.reactions.createForPullRequestReviewComment
    ) {
      await octokit.rest.reactions.createForPullRequestReviewComment({
        owner: mention.owner,
        repo: mention.repo,
        comment_id: mention.commentId,
        content: 'eyes',
      });
    } else {
      await octokit.rest.reactions.createForIssueComment({
        owner: mention.owner,
        repo: mention.repo,
        comment_id: mention.commentId,
        content: 'eyes',
      });
    }
  } catch {
    // Ignore reaction errors
  }
}

/**
 * Executes a single poll-and-review pass for `civireview watch`.
 */
/**
 * Writes the review, its evidence and the options it is rendered with to
 * `<outDir>/<owner>-<repo>-<pr>-<commentId>/`: `review.json`, `evidence.json`, `render.json`.
 * Only for a repository known to be public: the directory may be published.
 */
function saveReviewJson(
  options: Pick<WatcherOptions, 'outDir' | 'logger'>,
  mention: WatcherMention,
  review: unknown,
  bundle: EvidenceBundle,
  render: FormatReviewOptions & { format: number },
): void {
  const isPrivateRepo = bundle.pr.isPrivateRepo;
  if (!options.outDir) return;
  if (isPrivateRepo !== false) {
    options.logger?.info(
      `review.json not written for ${mention.repoFullName}#${mention.prNumber}: the repository is not public`,
    );
    return;
  }
  const dir = join(
    options.outDir,
    `${mention.owner}-${mention.repo}-${mention.prNumber}-${mention.commentId}`,
  );
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'review.json'), JSON.stringify(review, null, 2), 'utf8');
  writeFileSync(join(dir, 'evidence.json'), JSON.stringify(bundle, null, 2), 'utf8');
  writeFileSync(join(dir, 'render.json'), JSON.stringify(render, null, 2), 'utf8');
}

export async function runWatcherOnce(options: WatcherOptions): Promise<WatcherPassResult> {
  const allowedAuthors = options.allowedAuthors ?? options.config.watch?.allowedAuthors ?? [];
  const allowedOrgs = options.allowedOrgs ?? options.config.watch?.allowedOrgs ?? [];
  const allowedAssociations =
    options.allowedAssociations ?? options.config.watch?.allowedAssociations ?? [];

  const policy: AuthorAuthPolicy = {
    allowedAuthors,
    allowedOrgs,
    allowedAssociations,
    allowAnyAuthor: options.allowAnyAuthor,
  };

  if (!hasAnyAuthPolicy(policy)) {
    throw new Error(
      'Watcher requires a non-empty allowedAuthors (--allow), allowedOrgs (--allow-orgs), or allowedAssociations (--allow-associations) policy for security unless allowAnyAuthor is explicitly set.',
    );
  }
  if (options.mode === 'search' && options.repos.length === 0) {
    throw new Error('Watcher search mode requires at least one repo (--repos owner/name).');
  }

  const nowFn = options.now ?? Date.now;
  const nowMs = nowFn();
  const trigger = options.trigger ?? options.config.trigger ?? '@civireview';
  const botLogin = options.config.botLogin;
  const statePath =
    options.statePath ?? options.config.watch?.statePath ?? '.civireview-state/seen.json';
  const maxReviewsPerHour = options.maxReviewsPerHour ?? options.config.watch?.maxReviewsPerHour;
  const maxDailyUsd = options.maxDailyUsd ?? options.config.watch?.maxDailyUsd;
  const maxCommentAgeMinutes =
    options.maxCommentAgeMinutes ?? options.config.watch?.maxCommentAgeMinutes;
  const lockModels = options.lockModels ?? options.config.watch?.lockModels ?? false;

  const token = options.octokit ? options.token : await resolveGitHubToken(options.token);
  const octokit: WatcherOctokit =
    options.octokit ??
    (new Octokit({
      ...(token ? { auth: token } : {}),
      log: {
        debug: () => {},
        info: () => {},
        warn: () => {},
        error: (msg: string) => options.logger?.warn(msg),
      },
    }) as unknown as WatcherOctokit);

  const state = loadSeenState(statePath);
  if (!state.recentRuns) state.recentRuns = [];
  const seenKeys = new Set(state.seenCommentKeys);
  const orgMembershipCache = new Map<string, boolean>();
  const prCommentsCache = new Map<string, PrCommentsCacheEntry>();
  const prReviewsCache = new Map<
    string,
    Array<{ id: number; body?: string | null; user?: { login?: string } | null }>
  >();
  const prHeadShaCache = new Map<string, string | undefined>();

  let pendingLastModified: string | undefined;
  let mentions: WatcherMention[] = [];
  if (options.mode === 'search') {
    mentions = await pollSearchMentions({
      octokit,
      repos: options.repos,
      trigger,
      allowedAuthors,
      allowedOrgs,
      allowedAssociations,
      allowAnyAuthor: options.allowAnyAuthor,
      includeClosedPrs: options.includeClosedPrs,
      maxCommentAgeMinutes,
      nowMs,
      seenKeys,
      orgMembershipCache,
      prCommentsCache,
    });
  } else {
    const res = await pollNotificationMentions({
      octokit,
      repos: options.repos,
      trigger,
      allowedAuthors,
      allowedOrgs,
      allowedAssociations,
      allowAnyAuthor: options.allowAnyAuthor,
      maxCommentAgeMinutes,
      nowMs,
      seenKeys,
      lastModified: state.lastModified,
      orgMembershipCache,
      prCommentsCache,
    });
    mentions = res.mentions;
    pendingLastModified = res.lastModified;
  }

  const collectEvidenceFn = options.deps?.collectEvidence ?? collectEvidence;
  const runReviewPipelineFn = options.deps?.runReviewPipeline ?? runReviewPipeline;
  const runThreadReplyFn = options.deps?.runThreadReply ?? runThreadReply;
  const publishReviewFn = options.deps?.publishReview ?? publishReview;
  const publishThreadReplyFn = options.deps?.publishThreadReply ?? publishThreadReply;

  const processed: WatcherMention[] = [];
  const pending: WatcherMention[] = [];
  const throttled: WatcherMention[] = [];
  const skippedDuplicate: WatcherMention[] = [];
  const waitingForCi: WatcherMention[] = [];
  const failed: WatcherMention[] = [];
  const prCiPendingCache = new Map<string, boolean>();
  const waitForCiMaxMinutes = options.waitForCiMaxMinutes ?? 90;

  for (const mention of mentions) {
    const key = makeCommentKey(mention.repoFullName, mention.commentId);
    if (seenKeys.has(key)) continue;

    const prCacheKey = `${mention.repoFullName.toLowerCase()}#${mention.prNumber}`;
    const cachedComments = prCommentsCache.get(prCacheKey);
    const isThreadReply = isInlineThreadReplyMention(mention);

    // Zero-Docker pre-flight dedup: avoid booting CiviKitchen containers or spending
    // rate-limit slots if GitHub already has a posted review/reply for this trigger or head SHA.
    let preflightDuplicateReason: string | undefined;
    if (isThreadReply) {
      if (
        cachedComments &&
        hasExistingThreadReplyMarker(
          writtenBy(
            cachedComments.reviewComments.map((c) => ({ body: c.body, author: c.user?.login })),
            botLogin,
          ),
          mention.commentId,
        )
      ) {
        preflightDuplicateReason = `thread reply for comment ${mention.commentId} already posted`;
      }
    } else if (!options.onProcessMention) {
      const markerSources: MarkerSource[] = [];
      for (const c of cachedComments?.issueComments ?? []) {
        if (c.body) {
          markerSources.push({ body: c.body, author: c.user?.login });
        }
      }
      if (octokit.rest.pulls.listReviews) {
        let reviews = prReviewsCache.get(prCacheKey);
        if (!reviews) {
          try {
            const res = await octokit.rest.pulls.listReviews({
              owner: mention.owner,
              repo: mention.repo,
              pull_number: mention.prNumber,
              per_page: 100,
            });
            reviews = res.data;
          } catch {
            reviews = [];
          }
          prReviewsCache.set(prCacheKey, reviews);
        }
        for (const r of reviews) {
          if (r.body) {
            markerSources.push({ body: r.body, author: r.user?.login });
          }
        }
      }

      const markers = extractAllReviewedMarkers(markerSources, botLogin);
      if (markers.some((m) => m.triggerCommentId === mention.commentId)) {
        preflightDuplicateReason = `comment ${mention.commentId} already triggered a posted review`;
      } else if (!mention.flags.full && markers.length > 0 && octokit.rest.pulls.get) {
        let headSha = prHeadShaCache.get(prCacheKey);
        if (!prHeadShaCache.has(prCacheKey)) {
          try {
            const prRes = await octokit.rest.pulls.get({
              owner: mention.owner,
              repo: mention.repo,
              pull_number: mention.prNumber,
            });
            headSha = prRes.data.head?.sha;
          } catch {
            headSha = undefined;
          }
          prHeadShaCache.set(prCacheKey, headSha);
        }
        const latestMarker = markers[markers.length - 1];
        if (headSha && latestMarker?.headSha === headSha) {
          preflightDuplicateReason = `head ${headSha.slice(0, 7)} already reviewed; use --full to force re-review`;
        }
      }
    }

    if (preflightDuplicateReason) {
      options.logger?.info(
        `Skipping duplicate for ${mention.repoFullName}#${mention.prNumber}: ${preflightDuplicateReason}.`,
      );
      skippedDuplicate.push(mention);
      seenKeys.add(key);
      if (!options.checkOnly && !options.dryRun) {
        if (mention.threadId) {
          try {
            await octokit.rest.activity.markThreadAsRead({
              thread_id: mention.threadId,
            });
          } catch {
            // Ignore mark-read errors
          }
        }
        state.seenCommentKeys.push(key);
        saveSeenState(statePath, state, nowFn());
      }
      continue;
    }

    // Zero-Docker CI wait gate: when --wait-for-ci is enabled, defer full PR reviews
    // while Jenkins / commit statuses on the PR head SHA are still `pending` (up to waitForCiMaxMinutes).
    if (
      !isThreadReply &&
      options.waitForCi &&
      !mention.flags.full &&
      octokit.rest.pulls.get &&
      octokit.rest.repos?.getCombinedStatusForRef
    ) {
      const mentionMs = mention.createdAt ? Date.parse(mention.createdAt) : Number.NaN;
      const ageMinutes = Number.isFinite(mentionMs) ? (nowMs - mentionMs) / 60_000 : 0;
      if (ageMinutes < waitForCiMaxMinutes) {
        let headSha = prHeadShaCache.get(prCacheKey);
        if (!prHeadShaCache.has(prCacheKey)) {
          try {
            const prRes = await octokit.rest.pulls.get({
              owner: mention.owner,
              repo: mention.repo,
              pull_number: mention.prNumber,
            });
            headSha = prRes.data.head?.sha;
          } catch {
            headSha = undefined;
          }
          prHeadShaCache.set(prCacheKey, headSha);
        }
        if (headSha) {
          const ciCacheKey = `${prCacheKey}@${headSha}`;
          let ciPending = prCiPendingCache.get(ciCacheKey);
          if (ciPending === undefined) {
            try {
              const statusRes = await octokit.rest.repos.getCombinedStatusForRef({
                owner: mention.owner,
                repo: mention.repo,
                ref: headSha,
              });
              const statuses = statusRes.data.statuses ?? [];
              ciPending =
                statuses.some((s) => (s.state ?? '').toLowerCase() === 'pending') ||
                (statuses.length > 0 && (statusRes.data.state ?? '').toLowerCase() === 'pending');
            } catch {
              ciPending = false;
            }
            prCiPendingCache.set(ciCacheKey, ciPending);
          }
          if (ciPending) {
            options.logger?.info(
              `Deferring ${mention.repoFullName}#${mention.prNumber}: CI/Jenkins still pending on ${headSha.slice(0, 7)} (age ${Math.max(0, Math.round(ageMinutes))}m < ${waitForCiMaxMinutes}m limit).`,
            );
            waitingForCi.push(mention);
            continue;
          }
        }
      }
    }

    // Rate limit & daily USD budget guard (deferred mentions are NOT marked seen)
    const budget = summarizeRunBudget(state.recentRuns, nowFn());
    if (maxReviewsPerHour !== undefined && budget.runsLastHour >= maxReviewsPerHour) {
      options.logger?.warn(
        `Hourly rate limit reached (${budget.runsLastHour}/${maxReviewsPerHour} runs in the last hour); deferring ${mention.repoFullName}#${mention.prNumber} (comment ${mention.commentId}).`,
      );
      throttled.push(mention);
      continue;
    }
    if (maxDailyUsd !== undefined && budget.usdToday >= maxDailyUsd) {
      options.logger?.warn(
        `Daily budget cap reached ($${budget.usdToday.toFixed(2)}/$${maxDailyUsd.toFixed(2)} UTC); deferring ${mention.repoFullName}#${mention.prNumber} (comment ${mention.commentId}).`,
      );
      throttled.push(mention);
      continue;
    }

    if (options.checkOnly) {
      pending.push(mention);
      continue;
    }

    options.logger?.info(
      `Triggered ${isThreadReply ? 'inline reply' : 'review'} on ${mention.repoFullName}#${mention.prNumber} by @${mention.author}${mention.authorAssociation ? ` (${mention.authorAssociation})` : ''} (comment ${mention.commentId})`,
    );

    if (!options.dryRun) {
      await addEyesReaction(octokit, mention);
    }

    let estimatedUsd: number | undefined;
    const usage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 } as TokenUsageTotals;
    let actuallyRan = true;

    try {
      if (options.onProcessMention) {
        const res = await options.onProcessMention(mention);
        if (res && typeof res.estimatedUsd === 'number') {
          estimatedUsd = res.estimatedUsd;
        }
      } else if (isThreadReply) {
        const effectiveConfig = buildLightweightReplyConfig(
          applyMentionFlagsToConfig(options.config, mention.flags, {
            lockModels,
          }),
        );
        const { bundle, filteredPatch, cleanup } = await collectEvidenceFn({
          repoRoot: options.repoRoot,
          config: effectiveConfig,
          owner: mention.owner,
          repo: mention.repo,
          prNumber: mention.prNumber,
          githubToken: token,
          incremental: false,
        });

        try {
          if (
            hasExistingThreadReplyMarker(writtenBy(bundle.comments, botLogin), mention.commentId)
          ) {
            options.logger?.info(
              `Skipping duplicate inline reply for ${mention.repoFullName}#${mention.prNumber} (comment ${mention.commentId}).`,
            );
            skippedDuplicate.push(mention);
            actuallyRan = false;
          } else {
            const threadContext = buildThreadContextFromBundle(
              bundle,
              mention.commentId,
              mention.question,
            );
            const replyOutput = await runThreadReplyFn({
              bundle,
              filteredPatch,
              threadContext,
              config: effectiveConfig,
              cwd: options.repoRoot,
              usage,
            });
            estimatedUsd = usage.estimatedUsd;
            const replyBody = formatThreadReplyBody(replyOutput, {
              triggerCommentId: mention.commentId,
            });
            await publishThreadReplyFn({
              owner: mention.owner,
              repo: mention.repo,
              prNumber: mention.prNumber,
              commentId: mention.commentId,
              replyBody,
              token,
              dryRun: options.dryRun,
              octokit,
            });
          }
        } finally {
          await cleanup();
        }
      } else {
        const effectiveConfig = applyMentionFlagsToConfig(options.config, mention.flags, {
          lockModels,
        });
        const { bundle, filteredPatch, urls, composeFiles, browser, cleanup } =
          await collectEvidenceFn({
            repoRoot: options.repoRoot,
            config: effectiveConfig,
            owner: mention.owner,
            repo: mention.repo,
            prNumber: mention.prNumber,
            githubToken: token,
            incremental: !mention.flags.full,
          });
        options.logger?.info(
          `Collected evidence for ${mention.repoFullName}#${mention.prNumber}: ${bundle.diffFiles.length} file(s), A/B=${bundle.abReport.executed ? `executed (${bundle.abReport.checks.length} check(s))` : 'skipped'}`,
        );

        try {
          // Idempotency guard even if local seen.json was deleted or watcher moved hosts:
          // skip if this exact comment already triggered a posted review, or if the
          // current head SHA was already reviewed and `--full` was not explicitly requested.
          const markers = extractAllReviewedMarkers(bundle.comments, botLogin);
          const alreadyTriggered = markers.some((m) => m.triggerCommentId === mention.commentId);
          const sameHeadAlreadyReviewed =
            !mention.flags.full &&
            Boolean(bundle.pr.lastReviewedHeadSha) &&
            bundle.pr.lastReviewedHeadSha === bundle.pr.headSha;

          if (alreadyTriggered || sameHeadAlreadyReviewed) {
            options.logger?.info(
              `Skipping duplicate review for ${mention.repoFullName}#${mention.prNumber} (head ${bundle.pr.headSha.slice(0, 7)} already reviewed; use --full to force re-review).`,
            );
            skippedDuplicate.push(mention);
            actuallyRan = false;
          } else {
            const review = await runReviewPipelineFn({
              bundle,
              filteredPatch,
              config: effectiveConfig,
              cwd: options.repoRoot,
              liveUrls: urls,
              composeFiles,
              browser,
              logger: options.logger,
              usage,
            });
            estimatedUsd = review.tokenUsage?.estimatedUsd;
            saveReviewJson(options, mention, review, bundle, {
              format: REVIEW_FORMAT,
              preset: effectiveConfig.preset,
              maxInlineComments: effectiveConfig.review.maxInlineComments,
              triggerCommentId: mention.commentId,
              mentionUsers: effectiveConfig.review.mentionUsers,
            });

            const published = await publishReviewFn({
              owner: mention.owner,
              repo: mention.repo,
              prNumber: mention.prNumber,
              review,
              bundle,
              token,
              dryRun: options.dryRun,
              force: Boolean(mention.flags.full),
              commentId: mention.commentId,
              octokit,
              preset: effectiveConfig.preset,
              maxInlineComments: effectiveConfig.review.maxInlineComments,
              reviewEvent: effectiveConfig.review.reviewEvent,
              mentionUsers: effectiveConfig.review.mentionUsers,
              logger: options.logger,
            });
            options.logger?.info(
              `Finished ${mention.repoFullName}#${mention.prNumber}: verdict=${review.verdict}${review.score ? ` (${review.score}/5)` : ''}${estimatedUsd !== undefined ? `, est=$${estimatedUsd.toFixed(2)}` : ''}${published.htmlUrl ? ` -> ${published.htmlUrl}` : ''}`,
            );
          }
        } finally {
          await cleanup();
        }
      }
    } catch (err) {
      // Count the attempt against the rate/budget caps (the models may already have run) and
      // keep going, so one failing mention neither loops forever nor blocks the others.
      const message = err instanceof Error ? err.message : String(err);
      failed.push(mention);
      const attempts = (state.failedAttempts?.[key] ?? 0) + 1;
      // A review over its budget would spend the same again on every retry.
      const overBudget = err instanceof BudgetExceededError;
      // Stages that finished before the failure were paid for.
      estimatedUsd ??= overBudget ? err.estimatedUsd : usage.estimatedUsd;
      const giveUp = overBudget || attempts >= MAX_MENTION_ATTEMPTS;
      options.logger?.warn(
        `Failed ${mention.repoFullName}#${mention.prNumber} (comment ${mention.commentId}, attempt ${attempts}/${MAX_MENTION_ATTEMPTS})${giveUp ? '; giving up on this mention' : ''}: ${message}`,
      );
      state.recentRuns.push({
        at: new Date(nowFn()).toISOString(),
        repo: mention.repoFullName,
        prNumber: mention.prNumber,
        commentId: mention.commentId,
        kind: isThreadReply ? 'reply' : 'review',
        ...(estimatedUsd !== undefined ? { estimatedUsd } : {}),
      });
      if (!options.dryRun) {
        state.failedAttempts = { ...state.failedAttempts, [key]: attempts };
        if (giveUp) {
          seenKeys.add(key);
          state.seenCommentKeys.push(key);
          delete state.failedAttempts[key];
        }
        saveSeenState(statePath, state, nowFn());
      }
      continue;
    }

    if (mention.threadId && !options.dryRun) {
      try {
        await octokit.rest.activity.markThreadAsRead({
          thread_id: mention.threadId,
        });
      } catch {
        // Ignore mark-read errors
      }
    }

    seenKeys.add(key);
    if (!options.dryRun) {
      state.seenCommentKeys.push(key);
      if (state.failedAttempts) delete state.failedAttempts[key];
      if (actuallyRan) {
        state.recentRuns.push({
          at: new Date(nowFn()).toISOString(),
          repo: mention.repoFullName,
          prNumber: mention.prNumber,
          commentId: mention.commentId,
          kind: isThreadReply ? 'reply' : 'review',
          ...(estimatedUsd !== undefined ? { estimatedUsd } : {}),
        });
      }
      saveSeenState(statePath, state, nowFn());
    } else if (actuallyRan) {
      // Track in-memory during dry-run so multiple mentions in one pass respect rate caps
      state.recentRuns.push({
        at: new Date(nowFn()).toISOString(),
        repo: mention.repoFullName,
        prNumber: mention.prNumber,
        commentId: mention.commentId,
        kind: isThreadReply ? 'reply' : 'review',
        ...(estimatedUsd !== undefined ? { estimatedUsd } : {}),
      });
    }

    if (actuallyRan) {
      processed.push(mention);
    }
  }

  if (!options.checkOnly && !options.dryRun) {
    // The If-Modified-Since cursor advances only when no mention is left for a later pass:
    // deferred by a cap, waiting for CI, or failed with attempts left.
    const retryable = failed.some(
      (m) => !seenKeys.has(makeCommentKey(m.repoFullName, m.commentId)),
    );
    if (pendingLastModified && throttled.length === 0 && waitingForCi.length === 0 && !retryable) {
      state.lastModified = pendingLastModified;
    }
    saveSeenState(statePath, state, nowFn());
  }
  return { processed, pending, throttled, skippedDuplicate, waitingForCi, failed };
}

/**
 * Starts the `civireview watch` polling loop (or runs a single pass when `once: true`).
 */
export async function runWatcher(options: WatcherOptions): Promise<WatcherPassResult | void> {
  if (options.once || options.checkOnly) {
    return await runWatcherOnce(options);
  }

  const intervalMs = Math.max(5, options.intervalSec ?? 60) * 1000;
  while (!options.signal?.aborted) {
    try {
      await runWatcherOnce(options);
    } catch (err) {
      options.logger?.warn(
        `Watcher poll error: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    if (options.signal?.aborted) break;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, intervalMs);
      options.signal?.addEventListener(
        'abort',
        () => {
          clearTimeout(timer);
          resolve();
        },
        { once: true },
      );
    });
  }
}
