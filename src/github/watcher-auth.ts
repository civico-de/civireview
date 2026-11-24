import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { AuthorAssociation } from '../config/schema.ts';
import type { ParsedMentionFlags } from './commands.ts';
import type { PublisherOctokit } from './publisher.ts';

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
      get?(params: { owner: string; repo: string; pull_number: number }): Promise<{
        data: {
          head?: { sha?: string };
        };
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
    repos?: {
      getCombinedStatusForRef?(params: { owner: string; repo: string; ref: string }): Promise<{
        data: {
          state?: string;
          statuses?: Array<{ context?: string; state?: string }>;
        };
      }>;
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
  /** Failed processing attempts per comment key; a mention is given up after a few. */
  failedAttempts?: Record<string, number>;
}

export function loadSeenState(statePath: string): SeenState {
  if (!existsSync(statePath)) {
    return { seenCommentKeys: [], recentRuns: [] };
  }
  let raw: Partial<SeenState>;
  try {
    raw = JSON.parse(readFileSync(statePath, 'utf8')) as Partial<SeenState>;
  } catch (err) {
    // An empty state would re-process every old mention, so a broken file is an error.
    throw new Error(
      `Watcher state file ${statePath} is unreadable (${err instanceof Error ? err.message : String(err)}); fix or delete it to start from scratch.`,
      { cause: err },
    );
  }
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
  const failedAttempts: Record<string, number> = {};
  if (raw.failedAttempts && typeof raw.failedAttempts === 'object') {
    for (const [key, n] of Object.entries(raw.failedAttempts)) {
      if (typeof n === 'number' && Number.isFinite(n) && n > 0) failedAttempts[key] = n;
    }
  }
  return {
    seenCommentKeys: Array.isArray(raw.seenCommentKeys) ? raw.seenCommentKeys.map(String) : [],
    lastModified: typeof raw.lastModified === 'string' ? raw.lastModified : undefined,
    recentRuns,
    failedAttempts,
  };
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
    ...(state.failedAttempts && Object.keys(state.failedAttempts).length > 0
      ? { failedAttempts: state.failedAttempts }
      : {}),
  };
  // Write-then-rename so an interrupted write never leaves a truncated state file.
  const tmpPath = `${statePath}.tmp`;
  writeFileSync(tmpPath, JSON.stringify(bounded, null, 2), 'utf8');
  renameSync(tmpPath, statePath);
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

export function hasAnyAuthPolicy(policy: AuthorAuthPolicy): boolean {
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
  const { author, authorType, authorAssociation, repoOwner, policy, octokit, orgMembershipCache } =
    params;

  if (!author) return false;
  if (policy.allowAnyAuthor) return true;

  const lower = author.toLowerCase();
  if (policy.allowedAuthors?.some((allowed) => allowed.toLowerCase() === lower)) {
    return true;
  }

  // Prevent bot accounts from triggering via org or association wildcards
  if (lower.endsWith('[bot]') || authorType === 'Bot') {
    return false;
  }

  const assoc = authorAssociation?.toUpperCase();
  if (assoc && policy.allowedAssociations?.some((a) => a.toUpperCase() === assoc)) {
    return true;
  }

  if (policy.allowedOrgs && policy.allowedOrgs.length > 0) {
    const repoOwnerLower = repoOwner.toLowerCase();
    for (const org of policy.allowedOrgs) {
      const orgLower = org.toLowerCase();
      // Fast path: GitHub sets author_association=MEMBER|OWNER for ALL org members
      // (both public and private) on repositories owned by that organization.
      if (repoOwnerLower === orgLower && (assoc === 'MEMBER' || assoc === 'OWNER')) {
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

export function summarizeRunBudget(
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
