import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { Octokit } from '@octokit/rest';
import { resolveModels } from '../config/loader.ts';
import type {
  AuthorAssociation,
  ResolvedCiviReviewConfig,
} from '../config/schema.ts';
import { runReviewPipeline, runThreadReply } from '../engine/pipeline.ts';
import { collectEvidence } from '../evidence/collector.ts';
import {
  extractAllReviewedMarkers,
  resolveGitHubToken,
} from '../evidence/github.ts';
import { parseMentionCommand, type ParsedMentionFlags } from './commands.ts';
import {
  publishReview,
  publishThreadReply,
  type PublisherOctokit,
} from './publisher.ts';
import {
  buildThreadContextFromBundle,
  formatThreadReplyBody,
  hasExistingThreadReplyMarker,
} from './thread-reply.ts';

export interface WatcherMention {
  repoFullName: string;
  owner: string;
  repo: string;
  prNumber: number;
  commentId: number;
  commentKind: 'issue_comment' | 'review_comment';
  author: string;
  authorAssociation?: string;
  createdAt?: string;
  body: string;
  flags: ParsedMentionFlags;
  question: string;
  threadId?: string;
}

export interface WatcherCommentItem {
  id: number;
  body?: string | null;
  user?: { login?: string; type?: string } | null;
  author_association?: string;
  created_at?: string;
}

export interface WatcherOctokit extends PublisherOctokit {
  rest: PublisherOctokit['rest'] & {
    search: {
      issuesAndPullRequests(params: {
        q: string;
        sort?: 'updated' | 'created' | 'comments';
        per_page?: number;
      }): Promise<{
        data: {
          items: Array<{
            number: number;
            repository_url?: string;
          }>;
        };
      }>;
    };
    issues: {
      listComments(params: {
        owner: string;
        repo: string;
        issue_number: number;
        per_page?: number;
        page?: number;
      }): Promise<{
        data: WatcherCommentItem[];
      }>;
    };
    pulls: PublisherOctokit['rest']['pulls'] & {
      listReviewComments(params: {
        owner: string;
        repo: string;
        pull_number: number;
        per_page?: number;
        page?: number;
      }): Promise<{
        data: WatcherCommentItem[];
      }>;
      get?(params: {
        owner: string;
        repo: string;
        pull_number: number;
      }): Promise<{
        data: {
          head?: { sha?: string };
        };
      }>;
      listReviews?(params: {
        owner: string;
        repo: string;
        pull_number: number;
        per_page?: number;
      }): Promise<{
        data: Array<{
          id: number;
          body?: string | null;
          submitted_at?: string;
        }>;
      }>;
    };
    orgs?: {
      checkMembershipForUser?(params: {
        org: string;
        username: string;
      }): Promise<{ status?: number }>;
      checkPublicMembershipForUser?(params: {
        org: string;
        username: string;
      }): Promise<{ status?: number }>;
    };
    activity: {
      listNotificationsForAuthenticatedUser(params: {
        all?: boolean;
        since?: string;
        per_page?: number;
        headers?: Record<string, string>;
      }): Promise<{
        status?: number;
        headers?: Record<string, string | undefined>;
        data: Array<{
          id: string;
          reason: string;
          repository?: { full_name?: string };
          subject?: {
            type?: string | null;
            url?: string | null;
            latest_comment_url?: string | null;
          };
        }>;
      }>;
      markThreadAsRead(params: { thread_id: string }): Promise<unknown>;
    };
  };
}

export interface WatcherRunRecord {
  at: string;
  repo: string;
  prNumber: number;
  commentId: number;
  kind: 'review' | 'reply';
  estimatedUsd?: number;
}

export interface SeenState {
  seenCommentKeys: string[];
  lastModified?: string;
  recentRuns?: WatcherRunRecord[];
}

export function loadSeenState(statePath: string): SeenState {
  if (!existsSync(statePath)) {
    return { seenCommentKeys: [], recentRuns: [] };
  }
  try {
    const raw = JSON.parse(readFileSync(statePath, 'utf8')) as Partial<SeenState>;
    const recentRuns: WatcherRunRecord[] = Array.isArray(raw.recentRuns)
      ? raw.recentRuns.filter(
          (r): r is WatcherRunRecord =>
            Boolean(r) &&
            typeof r === 'object' &&
            typeof r.at === 'string' &&
            typeof r.repo === 'string' &&
            typeof r.prNumber === 'number' &&
            typeof r.commentId === 'number' &&
            (r.kind === 'review' || r.kind === 'reply'),
        )
      : [];
    return {
      seenCommentKeys: Array.isArray(raw.seenCommentKeys)
        ? raw.seenCommentKeys.map(String)
        : [],
      lastModified:
        typeof raw.lastModified === 'string' ? raw.lastModified : undefined,
      recentRuns,
    };
  } catch {
    return { seenCommentKeys: [], recentRuns: [] };
  }
}

export function saveSeenState(
  statePath: string,
  state: SeenState,
  nowMs: number = Date.now(),
): void {
  mkdirSync(dirname(statePath), { recursive: true });
  const cutoffMs = nowMs - 48 * 3_600_000;
  const recentRuns = (state.recentRuns ?? [])
    .filter((r) => {
      const ts = Date.parse(r.at);
      return Number.isFinite(ts) && ts >= cutoffMs;
    })
    .slice(-1000);

  // Keep state bounded to last 5000 comment keys and last 48h of runs
  const bounded: SeenState = {
    seenCommentKeys: state.seenCommentKeys.slice(-5000),
    ...(state.lastModified ? { lastModified: state.lastModified } : {}),
    ...(recentRuns.length > 0 ? { recentRuns } : {}),
  };
  writeFileSync(statePath, JSON.stringify(bounded, null, 2), 'utf8');
}

export function makeCommentKey(repoFullName: string, commentId: number): string {
  return `${repoFullName.toLowerCase()}#${commentId}`;
}

export interface AuthorAuthPolicy {
  allowedAuthors?: string[];
  allowedOrgs?: string[];
  allowedAssociations?: AuthorAssociation[];
  allowAnyAuthor?: boolean;
}

function hasAnyAuthPolicy(policy: AuthorAuthPolicy): boolean {
  return Boolean(
    policy.allowAnyAuthor ||
      (policy.allowedAuthors && policy.allowedAuthors.length > 0) ||
      (policy.allowedOrgs && policy.allowedOrgs.length > 0) ||
      (policy.allowedAssociations && policy.allowedAssociations.length > 0),
  );
}

async function checkOrgMembershipViaApi(
  octokit: WatcherOctokit,
  org: string,
  username: string,
): Promise<boolean> {
  const orgsApi = octokit.rest.orgs;
  if (!orgsApi) return false;

  if (orgsApi.checkMembershipForUser) {
    try {
      const res = await orgsApi.checkMembershipForUser({ org, username });
      if (res?.status === undefined || res.status === 204) {
        return true;
      }
    } catch {
      // 302 / 401 / 403 / 404 (e.g. token lacks read:org or requester is not in org):
      // fall through to public membership check.
    }
  }

  if (orgsApi.checkPublicMembershipForUser) {
    try {
      const res = await orgsApi.checkPublicMembershipForUser({ org, username });
      if (res?.status === undefined || res.status === 204) {
        return true;
      }
    } catch {
      return false;
    }
  }

  return false;
}

/**
 * Checks whether `author` is allowed to trigger a review on `repoOwner/*`.
 *
 * For `allowedOrgs`, when commenting on a repository owned by that org (such as
 * `civicrm/civicrm-core` with `allowedOrgs: ['civicrm']`), GitHub's server-computed
 * `author_association` (`MEMBER` or `OWNER`) authorizes BOTH public and private org
 * members in zero extra API calls. Cross-repo comments or missing associations fall
 * back to cached `orgs.checkMembershipForUser` / `orgs.checkPublicMembershipForUser`.
 */
export async function isAuthorAuthorized(params: {
  author: string;
  authorType?: string;
  authorAssociation?: string;
  repoOwner: string;
  policy: AuthorAuthPolicy;
  octokit: WatcherOctokit;
  orgMembershipCache?: Map<string, boolean>;
}): Promise<boolean> {
  const {
    author,
    authorType,
    authorAssociation,
    repoOwner,
    policy,
    octokit,
    orgMembershipCache,
  } = params;

  if (!author) return false;
  if (policy.allowAnyAuthor) return true;

  const lower = author.toLowerCase();
  if (
    policy.allowedAuthors?.some((allowed) => allowed.toLowerCase() === lower)
  ) {
    return true;
  }

  // Prevent bot accounts from triggering via org or association wildcards
  if (lower.endsWith('[bot]') || authorType === 'Bot') {
    return false;
  }

  const assoc = authorAssociation?.toUpperCase();
  if (
    assoc &&
    policy.allowedAssociations?.some((a) => a.toUpperCase() === assoc)
  ) {
    return true;
  }

  if (policy.allowedOrgs && policy.allowedOrgs.length > 0) {
    const repoOwnerLower = repoOwner.toLowerCase();
    for (const org of policy.allowedOrgs) {
      const orgLower = org.toLowerCase();
      // Fast path: GitHub sets author_association=MEMBER|OWNER for ALL org members
      // (both public and private) on repositories owned by that organization.
      if (
        repoOwnerLower === orgLower &&
        (assoc === 'MEMBER' || assoc === 'OWNER')
      ) {
        return true;
      }

      const cacheKey = `${orgLower}:${lower}`;
      if (orgMembershipCache?.has(cacheKey)) {
        if (orgMembershipCache.get(cacheKey)) return true;
        continue;
      }

      const isMember = await checkOrgMembershipViaApi(octokit, org, author);
      orgMembershipCache?.set(cacheKey, isMember);
      if (isMember) return true;
    }
  }

  return false;
}

/**
 * Returns true when a mention is a follow-up question inside an inline review
 * comment thread (and does not explicitly pass full-review rerun flags).
 */
export function isInlineThreadReplyMention(mention: WatcherMention): boolean {
  if (mention.commentKind !== 'review_comment') return false;
  if (!mention.question.trim()) return false;
  const f = mention.flags;
  const hasReviewRerunFlag = Boolean(
    f.full ||
      f.preset ||
      f.effort ||
      f.model ||
      f.verifier ||
      f.ab !== undefined ||
      f.demo !== undefined ||
      f.browser !== undefined ||
      f.interactiveBrowser ||
      f.liveProve ||
      (f.include && f.include.length > 0) ||
      (f.exclude && f.exclude.length > 0) ||
      (f.pages && f.pages.length > 0),
  );
  return !hasReviewRerunFlag;
}

function splitOwnerRepo(fullName: string): { owner: string; repo: string } | null {
  const parts = fullName.split('/');
  if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
  return { owner: parts[0], repo: parts[1] };
}

const MAX_COMMENT_PAGES = 5;

async function fetchPagedIssueComments(
  octokit: WatcherOctokit,
  owner: string,
  repo: string,
  prNumber: number,
): Promise<WatcherCommentItem[]> {
  const all: WatcherCommentItem[] = [];
  for (let page = 1; page <= MAX_COMMENT_PAGES; page++) {
    const res = await octokit.rest.issues.listComments({
      owner,
      repo,
      issue_number: prNumber,
      per_page: 100,
      ...(page > 1 ? { page } : {}),
    });
    all.push(...res.data);
    if (res.data.length < 100) break;
  }
  return all;
}

async function fetchPagedReviewComments(
  octokit: WatcherOctokit,
  owner: string,
  repo: string,
  prNumber: number,
): Promise<WatcherCommentItem[]> {
  const all: WatcherCommentItem[] = [];
  for (let page = 1; page <= MAX_COMMENT_PAGES; page++) {
    const res = await octokit.rest.pulls.listReviewComments({
      owner,
      repo,
      pull_number: prNumber,
      per_page: 100,
      ...(page > 1 ? { page } : {}),
    });
    all.push(...res.data);
    if (res.data.length < 100) break;
  }
  return all;
}

interface PrCommentsCacheEntry {
  issueComments: WatcherCommentItem[];
  reviewComments: WatcherCommentItem[];
}

async function collectMatchingCommentsForPr(params: {
  octokit: WatcherOctokit;
  repoFullName: string;
  owner: string;
  repo: string;
  prNumber: number;
  trigger: string;
  policy: AuthorAuthPolicy;
  maxCommentAgeMinutes?: number;
  nowMs?: number;
  seenKeys: Set<string>;
  orgMembershipCache?: Map<string, boolean>;
  prCommentsCache?: Map<string, PrCommentsCacheEntry>;
  threadId?: string;
}): Promise<WatcherMention[]> {
  const {
    octokit,
    repoFullName,
    owner,
    repo,
    prNumber,
    trigger,
    policy,
    maxCommentAgeMinutes,
    nowMs = Date.now(),
    seenKeys,
    orgMembershipCache,
    prCommentsCache,
    threadId,
  } = params;

  const prCacheKey = `${repoFullName.toLowerCase()}#${prNumber}`;
  let cached = prCommentsCache?.get(prCacheKey);
  if (!cached) {
    const [issueComments, reviewComments] = await Promise.all([
      fetchPagedIssueComments(octokit, owner, repo, prNumber),
      fetchPagedReviewComments(octokit, owner, repo, prNumber),
    ]);
    cached = { issueComments, reviewComments };
    prCommentsCache?.set(prCacheKey, cached);
  }

  const combined = [
    ...cached.issueComments.map((c) => ({ ...c, kind: 'issue_comment' as const })),
    ...cached.reviewComments.map((c) => ({ ...c, kind: 'review_comment' as const })),
  ];

  const ageCutoffMs =
    maxCommentAgeMinutes !== undefined
      ? nowMs - maxCommentAgeMinutes * 60_000
      : undefined;

  const mentions: WatcherMention[] = [];
  for (const c of combined) {
    const key = makeCommentKey(repoFullName, c.id);
    if (seenKeys.has(key)) continue;

    const body = c.body ?? '';
    // Never trigger on civireview's own comments/reviews
    if (body.includes('<!-- civireview:')) continue;

    if (ageCutoffMs !== undefined && c.created_at) {
      const createdMs = Date.parse(c.created_at);
      if (Number.isFinite(createdMs) && createdMs < ageCutoffMs) {
        continue;
      }
    }

    let parsed;
    try {
      parsed = parseMentionCommand(body, trigger);
    } catch {
      // Invalid command flags in comment; skip cleanly
      continue;
    }
    if (!parsed.triggered) continue;

    const author = c.user?.login ?? '';
    const authorized = await isAuthorAuthorized({
      author,
      authorType: c.user?.type,
      authorAssociation: c.author_association,
      repoOwner: owner,
      policy,
      octokit,
      orgMembershipCache,
    });
    if (!authorized) continue;

    mentions.push({
      repoFullName,
      owner,
      repo,
      prNumber,
      commentId: c.id,
      commentKind: c.kind,
      author,
      authorAssociation: c.author_association,
      createdAt: c.created_at,
      body,
      flags: parsed.flags,
      question: parsed.question,
      threadId,
    });
  }

  return mentions;
}

export interface PollSearchOptions {
  octokit: WatcherOctokit;
  repos: string[];
  trigger: string;
  allowedAuthors?: string[];
  allowedOrgs?: string[];
  allowedAssociations?: AuthorAssociation[];
  allowAnyAuthor?: boolean;
  includeClosedPrs?: boolean;
  maxCommentAgeMinutes?: number;
  nowMs?: number;
  seenKeys: Set<string>;
  orgMembershipCache?: Map<string, boolean>;
  prCommentsCache?: Map<string, PrCommentsCacheEntry>;
}

/**
 * Polls GitHub issue/PR search API for PRs containing the trigger mention.
 * By default `includeClosedPrs` is `true` so `@civireview` works on closed/merged PRs too.
 * Zero dedicated bot account required — works with any personal or CI GitHub token.
 */
export async function pollSearchMentions(
  options: PollSearchOptions,
): Promise<WatcherMention[]> {
  const {
    octokit,
    repos,
    trigger,
    allowedAuthors = [],
    allowedOrgs = [],
    allowedAssociations = [],
    allowAnyAuthor,
    includeClosedPrs = true,
    maxCommentAgeMinutes,
    nowMs,
    seenKeys,
    orgMembershipCache = new Map<string, boolean>(),
    prCommentsCache,
  } = options;
  const policy: AuthorAuthPolicy = {
    allowedAuthors,
    allowedOrgs,
    allowedAssociations,
    allowAnyAuthor,
  };
  const mentions: WatcherMention[] = [];

  for (const repoFullName of repos) {
    const split = splitOwnerRepo(repoFullName);
    if (!split) continue;

    const query = includeClosedPrs
      ? `"${trigger}" in:comments repo:${repoFullName} is:pr`
      : `"${trigger}" in:comments repo:${repoFullName} is:pr is:open`;
    const { data } = await octokit.rest.search.issuesAndPullRequests({
      q: query,
      sort: 'updated',
      per_page: 30,
    });

    for (const item of data.items) {
      const found = await collectMatchingCommentsForPr({
        octokit,
        repoFullName,
        owner: split.owner,
        repo: split.repo,
        prNumber: item.number,
        trigger,
        policy,
        maxCommentAgeMinutes,
        nowMs,
        seenKeys,
        orgMembershipCache,
        prCommentsCache,
      });
      mentions.push(...found);
    }
  }

  return mentions;
}

export interface PollNotificationsOptions {
  octokit: WatcherOctokit;
  repos?: string[];
  trigger: string;
  allowedAuthors?: string[];
  allowedOrgs?: string[];
  allowedAssociations?: AuthorAssociation[];
  allowAnyAuthor?: boolean;
  maxCommentAgeMinutes?: number;
  nowMs?: number;
  seenKeys: Set<string>;
  lastModified?: string;
  orgMembershipCache?: Map<string, boolean>;
  prCommentsCache?: Map<string, PrCommentsCacheEntry>;
}

/**
 * Polls `GET /notifications` with `If-Modified-Since` (honoring HTTP 304 zero-cost responses)
 * for `mention` notifications on Pull Requests.
 */
export async function pollNotificationMentions(
  options: PollNotificationsOptions,
): Promise<{ mentions: WatcherMention[]; lastModified?: string }> {
  const {
    octokit,
    repos,
    trigger,
    allowedAuthors = [],
    allowedOrgs = [],
    allowedAssociations = [],
    allowAnyAuthor,
    maxCommentAgeMinutes,
    nowMs,
    seenKeys,
    lastModified,
    orgMembershipCache = new Map<string, boolean>(),
    prCommentsCache,
  } = options;
  const policy: AuthorAuthPolicy = {
    allowedAuthors,
    allowedOrgs,
    allowedAssociations,
    allowAnyAuthor,
  };

  const repoFilter =
    repos && repos.length > 0
      ? new Set(repos.map((r) => r.toLowerCase()))
      : null;

  let response: Awaited<
    ReturnType<
      WatcherOctokit['rest']['activity']['listNotificationsForAuthenticatedUser']
    >
  >;
  const sinceIso =
    maxCommentAgeMinutes !== undefined
      ? new Date((nowMs ?? Date.now()) - maxCommentAgeMinutes * 60_000).toISOString()
      : undefined;

  try {
    // Use `all: true` so notifications accidentally marked read by opening a PR
    // in a browser or email client while signed in as the bot are never dropped.
    // Deduplication is enforced via `seen.json` + posted `trigger_comment` markers.
    response = await octokit.rest.activity.listNotificationsForAuthenticatedUser({
      all: true,
      ...(sinceIso ? { since: sinceIso } : {}),
      per_page: 50,
      ...(lastModified
        ? { headers: { 'If-Modified-Since': lastModified } }
        : {}),
    });
  } catch (err) {
    const status = (err as { status?: number })?.status;
    if (status === 304) {
      return { mentions: [], lastModified };
    }
    throw err;
  }

  if (response.status === 304) {
    return { mentions: [], lastModified };
  }

  const nextLastModified =
    response.headers?.['last-modified'] ??
    response.headers?.['Last-Modified'] ??
    lastModified;

  const mentions: WatcherMention[] = [];

  for (const notif of response.data) {
    // Accept both direct `mention` and `comment` (GitHub may keep or switch a
    // subscribed PR thread's reason to `comment` when a follow-up @civireview
    // arrives alongside other comments). Actual triggering still requires an
    // authorized `@civireview` mention inside collectMatchingCommentsForPr.
    if (notif.reason !== 'mention' && notif.reason !== 'comment') continue;
    if (notif.subject?.type !== 'PullRequest') continue;

    const repoFullName = notif.repository?.full_name;
    if (!repoFullName) continue;
    if (repoFilter && !repoFilter.has(repoFullName.toLowerCase())) continue;

    const split = splitOwnerRepo(repoFullName);
    if (!split) continue;

    const prMatch = notif.subject.url?.match(/\/pulls\/(\d+)$/);
    if (!prMatch?.[1]) continue;
    const prNumber = Number(prMatch[1]);
    if (!Number.isInteger(prNumber) || prNumber <= 0) continue;

    const found = await collectMatchingCommentsForPr({
      octokit,
      repoFullName,
      owner: split.owner,
      repo: split.repo,
      prNumber,
      trigger,
      policy,
      maxCommentAgeMinutes,
      nowMs,
      seenKeys,
      orgMembershipCache,
      prCommentsCache,
      threadId: notif.id,
    });
    mentions.push(...found);
  }

  return {
    mentions,
    lastModified: nextLastModified,
  };
}

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
  trigger?: string;
  intervalSec?: number;
  once?: boolean;
  checkOnly?: boolean;
  statePath?: string;
  config: ResolvedCiviReviewConfig;
  repoRoot: string;
  token?: string;
  dryRun?: boolean;
  octokit?: WatcherOctokit;
  signal?: AbortSignal;
  now?: () => number;
  deps?: WatcherDeps;
  onProcessMention?: (
    mention: WatcherMention,
  ) => Promise<void | { estimatedUsd?: number }>;
  logger?: { info(msg: string): void; warn(msg: string): void };
}

export interface WatcherPassResult {
  processed: WatcherMention[];
  pending: WatcherMention[];
  throttled: WatcherMention[];
  skippedDuplicate: WatcherMention[];
}

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
      ...(flags.liveProve !== undefined ? { liveProve: flags.liveProve } : {}),
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
            pages: Array.from(
              new Set([...baseConfig.browser.pages, ...flags.pages]),
            ),
          }
        : {}),
    },
    review: {
      ...baseConfig.review,
      ...(flags.effort ? { effort: flags.effort } : {}),
      ...(flags.include && flags.include.length > 0
        ? { include: flags.include }
        : {}),
      ...(flags.exclude && flags.exclude.length > 0
        ? {
            exclude: Array.from(
              new Set([...baseConfig.review.exclude, ...flags.exclude]),
            ),
          }
        : {}),
    },
  };
}

function buildLightweightReplyConfig(
  config: ResolvedCiviReviewConfig,
): ResolvedCiviReviewConfig {
  return {
    ...config,
    ab: {
      ...config.ab,
      enabled: false,
      runDemo: false,
      runMatrix: false,
      keepStacks: false,
      liveProve: false,
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

async function addEyesReaction(
  octokit: WatcherOctokit,
  mention: WatcherMention,
): Promise<void> {
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

function summarizeRunBudget(
  recentRuns: WatcherRunRecord[],
  nowMs: number,
): { runsLastHour: number; usdToday: number } {
  const hourAgo = nowMs - 3_600_000;
  const todayUtc = new Date(nowMs).toISOString().slice(0, 10);

  let runsLastHour = 0;
  let usdToday = 0;

  for (const r of recentRuns) {
    const ts = Date.parse(r.at);
    if (!Number.isFinite(ts)) continue;
    if (ts >= hourAgo && ts <= nowMs + 60_000) {
      runsLastHour++;
    }
    if (r.at.slice(0, 10) === todayUtc && typeof r.estimatedUsd === 'number') {
      usdToday += r.estimatedUsd;
    }
  }

  return { runsLastHour, usdToday };
}

/**
 * Executes a single poll-and-review pass for `civireview watch`.
 */
export async function runWatcherOnce(
  options: WatcherOptions,
): Promise<WatcherPassResult> {
  const allowedAuthors =
    options.allowedAuthors ?? options.config.watch?.allowedAuthors ?? [];
  const allowedOrgs =
    options.allowedOrgs ?? options.config.watch?.allowedOrgs ?? [];
  const allowedAssociations =
    options.allowedAssociations ??
    options.config.watch?.allowedAssociations ??
    [];

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
    throw new Error(
      'Watcher search mode requires at least one repo (--repos owner/name).',
    );
  }

  const nowFn = options.now ?? Date.now;
  const nowMs = nowFn();
  const trigger = options.trigger ?? options.config.trigger ?? '@civireview';
  const statePath =
    options.statePath ??
    options.config.watch?.statePath ??
    '.civireview-state/seen.json';
  const maxReviewsPerHour =
    options.maxReviewsPerHour ?? options.config.watch?.maxReviewsPerHour;
  const maxDailyUsd = options.maxDailyUsd ?? options.config.watch?.maxDailyUsd;
  const maxCommentAgeMinutes =
    options.maxCommentAgeMinutes ?? options.config.watch?.maxCommentAgeMinutes;
  const lockModels = options.lockModels ?? options.config.watch?.lockModels ?? false;

  const token = options.octokit
    ? options.token
    : await resolveGitHubToken(options.token);
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
    Array<{ id: number; body?: string | null; submitted_at?: string }>
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
  const runReviewPipelineFn =
    options.deps?.runReviewPipeline ?? runReviewPipeline;
  const runThreadReplyFn = options.deps?.runThreadReply ?? runThreadReply;
  const publishReviewFn = options.deps?.publishReview ?? publishReview;
  const publishThreadReplyFn =
    options.deps?.publishThreadReply ?? publishThreadReply;

  const processed: WatcherMention[] = [];
  const pending: WatcherMention[] = [];
  const throttled: WatcherMention[] = [];
  const skippedDuplicate: WatcherMention[] = [];

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
          cachedComments.reviewComments,
          mention.commentId,
        )
      ) {
        preflightDuplicateReason = `thread reply for comment ${mention.commentId} already posted`;
      }
    } else if (!options.onProcessMention) {
      const markerSources: Array<{ body: string; createdAt?: string }> = [];
      for (const c of cachedComments?.issueComments ?? []) {
        if (c.body) {
          markerSources.push({ body: c.body, createdAt: c.created_at });
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
            markerSources.push({ body: r.body, createdAt: r.submitted_at });
          }
        }
      }

      const markers = extractAllReviewedMarkers(markerSources);
      if (markers.some((m) => m.triggerCommentId === mention.commentId)) {
        preflightDuplicateReason = `comment ${mention.commentId} already triggered a posted review`;
      } else if (
        !mention.flags.full &&
        markers.length > 0 &&
        octokit.rest.pulls.get
      ) {
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

    // Rate limit & daily USD budget guard (deferred mentions are NOT marked seen)
    const budget = summarizeRunBudget(state.recentRuns, nowFn());
    if (
      maxReviewsPerHour !== undefined &&
      budget.runsLastHour >= maxReviewsPerHour
    ) {
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
    let actuallyRan = true;

    if (options.onProcessMention) {
      const res = await options.onProcessMention(mention);
      if (res && typeof res.estimatedUsd === 'number') {
        estimatedUsd = res.estimatedUsd;
      }
    } else if (isThreadReply) {
      const effectiveConfig = buildLightweightReplyConfig(
        applyMentionFlagsToConfig(options.config, mention.flags, { lockModels }),
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
        if (hasExistingThreadReplyMarker(bundle.comments, mention.commentId)) {
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
          });
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
      const effectiveConfig = applyMentionFlagsToConfig(
        options.config,
        mention.flags,
        { lockModels },
      );
      const { bundle, filteredPatch, urls, composeFiles, cleanup } =
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
        const markers = extractAllReviewedMarkers(bundle.comments);
        const alreadyTriggered = markers.some(
          (m) => m.triggerCommentId === mention.commentId,
        );
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
            logger: options.logger,
          });
          estimatedUsd = review.tokenUsage?.estimatedUsd;

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
          });
          options.logger?.info(
            `Finished ${mention.repoFullName}#${mention.prNumber}: verdict=${review.verdict}${review.score ? ` (${review.score}/5)` : ''}${estimatedUsd !== undefined ? `, est=$${estimatedUsd.toFixed(2)}` : ''}${published.htmlUrl ? ` -> ${published.htmlUrl}` : ''}`,
          );
        }
      } finally {
        await cleanup();
      }
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
    // Only advance If-Modified-Since cursor once no mentions were deferred by
    // rate/budget caps, so throttled notifications are re-fetched cleanly later.
    if (pendingLastModified && throttled.length === 0) {
      state.lastModified = pendingLastModified;
    }
    saveSeenState(statePath, state, nowFn());
  }
  return { processed, pending, throttled, skippedDuplicate };
}

/**
 * Starts the `civireview watch` polling loop (or runs a single pass when `once: true`).
 */
export async function runWatcher(
  options: WatcherOptions,
): Promise<WatcherPassResult | void> {
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
