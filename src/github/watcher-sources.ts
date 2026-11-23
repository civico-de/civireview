import type { AuthorAssociation } from '../config/schema.ts';
import { parseMentionCommand } from './commands.ts';
import {
  isAuthorAuthorized,
  makeCommentKey,
  type AuthorAuthPolicy,
  type WatcherCommentItem,
  type WatcherMention,
  type WatcherOctokit,
} from './watcher-auth.ts';

export function splitOwnerRepo(fullName: string): { owner: string; repo: string } | null {
  const parts = fullName.split('/');
  if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
  return { owner: parts[0], repo: parts[1] };
}

const MAX_COMMENT_PAGES = 5;

export async function fetchPagedIssueComments(
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

export async function fetchPagedReviewComments(
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

export interface PrCommentsCacheEntry {
  issueComments: WatcherCommentItem[];
  reviewComments: WatcherCommentItem[];
}

export async function collectMatchingCommentsForPr(params: {
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
    ...cached.issueComments.map((c) => ({
      ...c,
      kind: 'issue_comment' as const,
    })),
    ...cached.reviewComments.map((c) => ({
      ...c,
      kind: 'review_comment' as const,
    })),
  ];

  const ageCutoffMs =
    maxCommentAgeMinutes !== undefined ? nowMs - maxCommentAgeMinutes * 60_000 : undefined;

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
export async function pollSearchMentions(options: PollSearchOptions): Promise<WatcherMention[]> {
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

  const repoFilter = repos && repos.length > 0 ? new Set(repos.map((r) => r.toLowerCase())) : null;

  let response: Awaited<
    ReturnType<WatcherOctokit['rest']['activity']['listNotificationsForAuthenticatedUser']>
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
      ...(lastModified ? { headers: { 'If-Modified-Since': lastModified } } : {}),
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
    response.headers?.['last-modified'] ?? response.headers?.['Last-Modified'] ?? lastModified;

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
