import { Octokit } from '@octokit/rest';
import type { ReviewEvent } from '../config/schema.ts';
import type { FinalReview } from '../engine/schemas.ts';
import { resolveGitHubToken } from '../evidence/github.ts';
import type { EvidenceBundle } from '../evidence/types.ts';
import {
  formatReviewMarkdown,
  MAX_GITHUB_BODY_CHARS,
  truncateForGitHub,
  type GitHubReviewCommentInput,
} from './formatter.ts';

export interface PublisherOctokit {
  rest: {
    pulls: {
      createReview(params: {
        owner: string;
        repo: string;
        pull_number: number;
        commit_id: string;
        event: 'COMMENT' | 'REQUEST_CHANGES' | 'APPROVE';
        body: string;
        comments?: GitHubReviewCommentInput[];
      }): Promise<{ data: { id: number; html_url?: string } }>;
      createReplyForReviewComment(params: {
        owner: string;
        repo: string;
        pull_number: number;
        comment_id: number;
        body: string;
      }): Promise<{ data: { id: number; html_url?: string } }>;
    };
    reactions?: {
      createForIssueComment(params: {
        owner: string;
        repo: string;
        comment_id: number;
        content: '+1' | '-1' | 'laugh' | 'confused' | 'heart' | 'hooray' | 'rocket' | 'eyes';
      }): Promise<unknown>;
      createForPullRequestReviewComment?(params: {
        owner: string;
        repo: string;
        comment_id: number;
        content: '+1' | '-1' | 'laugh' | 'confused' | 'heart' | 'hooray' | 'rocket' | 'eyes';
      }): Promise<unknown>;
    };
  };
}

export interface PublishReviewOptions {
  owner: string;
  repo: string;
  prNumber: number;
  review: FinalReview;
  bundle: EvidenceBundle;
  token?: string;
  dryRun?: boolean;
  force?: boolean;
  commentId?: number;
  octokit?: PublisherOctokit;
  preset?: string;
  maxInlineComments?: number;
  reviewEvent?: ReviewEvent;
  mentionUsers?: boolean;
}

export interface PublishReviewResult {
  posted: boolean;
  skippedDuplicate?: boolean;
  fallbackUsed: boolean;
  reviewId?: number;
  htmlUrl?: string;
  summaryBody: string;
  inlineComments: GitHubReviewCommentInput[];
}

function resolveReviewEvent(
  verdict: FinalReview['verdict'],
  configured: ReviewEvent = 'COMMENT',
): ReviewEvent {
  if (configured === 'REQUEST_CHANGES') {
    return verdict === 'NEEDS_CHANGES' ? 'REQUEST_CHANGES' : 'COMMENT';
  }
  if (configured === 'APPROVE') {
    return verdict === 'READY' ? 'APPROVE' : 'COMMENT';
  }
  return 'COMMENT';
}

function isHttp422(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as { status?: number; response?: { status?: number }; message?: string };
  if (e.status === 422 || e.response?.status === 422) return true;
  if (typeof e.message === 'string' && /\b422\b|unprocessable/i.test(e.message)) {
    return true;
  }
  return false;
}

function appendFallbackCommentsToSummary(
  summaryBody: string,
  comments: GitHubReviewCommentInput[],
): string {
  if (comments.length === 0) return summaryBody;
  const fullBlock =
    `### Inline Findings (Moved to Summary)\n\n` +
    comments
      .map((c) => {
        const range = c.start_line ? `${c.start_line}-${c.line}` : `${c.line}`;
        return `#### \`${c.path}:${range}\` (${c.side})\n\n${c.body}`;
      })
      .join('\n\n---\n\n');
  const movedBlock = truncateForGitHub(
    fullBlock,
    Math.max(0, MAX_GITHUB_BODY_CHARS - summaryBody.length - 100),
  );

  const markerIdx = summaryBody.lastIndexOf('<!-- civireview:v1');
  if (markerIdx !== -1) {
    return (
      summaryBody.slice(0, markerIdx).trimEnd() +
      '\n\n' +
      movedBlock +
      '\n\n' +
      summaryBody.slice(markerIdx)
    );
  }
  return `${summaryBody}\n\n${movedBlock}`;
}

async function addCompletionReaction(
  octokit: PublisherOctokit,
  owner: string,
  repo: string,
  commentId: number,
  verdict: FinalReview['verdict'],
): Promise<void> {
  if (!octokit.rest.reactions) return;
  const content = verdict === 'READY' ? 'rocket' : verdict === 'NEEDS_CHANGES' ? 'confused' : '+1';

  try {
    await octokit.rest.reactions.createForIssueComment({
      owner,
      repo,
      comment_id: commentId,
      content,
    });
  } catch {
    if (octokit.rest.reactions.createForPullRequestReviewComment) {
      try {
        await octokit.rest.reactions.createForPullRequestReviewComment({
          owner,
          repo,
          comment_id: commentId,
          content,
        });
      } catch {
        // Ignore reaction failures
      }
    }
  }
}

async function getOctokit(injected?: PublisherOctokit, token?: string): Promise<PublisherOctokit> {
  if (injected) return injected;
  const resolvedToken = await resolveGitHubToken(token);
  if (!resolvedToken) {
    throw new Error(
      'GitHub token required to publish review (set GITHUB_TOKEN or pass --token, or use --dry-run).',
    );
  }
  return new Octokit({ auth: resolvedToken }) as unknown as PublisherOctokit;
}

/**
 * Formats and posts a complete PR review (summary + batched inline comments) in a
 * single `pulls.createReview` API call, with automatic HTTP 422 fallback.
 */
export async function publishReview(options: PublishReviewOptions): Promise<PublishReviewResult> {
  const { owner, repo, prNumber, review, bundle, dryRun, force, commentId } = options;

  const formatted = formatReviewMarkdown(review, bundle, {
    preset: options.preset,
    maxInlineComments: options.maxInlineComments,
    triggerCommentId: commentId,
    mentionUsers: options.mentionUsers,
  });

  if (dryRun) {
    return {
      posted: false,
      fallbackUsed: false,
      summaryBody: formatted.summaryBody,
      inlineComments: formatted.inlineComments,
    };
  }

  // Prevent duplicate reviews for the exact same head SHA unless `--full` / `force: true` is requested.
  if (!force && bundle.pr.lastReviewedHeadSha && bundle.pr.lastReviewedHeadSha === review.headSha) {
    return {
      posted: false,
      skippedDuplicate: true,
      fallbackUsed: false,
      summaryBody: formatted.summaryBody,
      inlineComments: formatted.inlineComments,
    };
  }

  const octokit = await getOctokit(options.octokit, options.token);
  // Closed/merged PRs only accept COMMENT reviews (GitHub returns 422 for REQUEST_CHANGES/APPROVE)
  const isClosedOrMerged = bundle.pr.state === 'closed' || Boolean(bundle.pr.merged);
  const event = isClosedOrMerged
    ? 'COMMENT'
    : resolveReviewEvent(review.verdict, options.reviewEvent);

  // 422 fallbacks, most to least faithful: a plain COMMENT review (e.g. REQUEST_CHANGES or
  // APPROVE is refused on one's own PR), then the inline comments folded into the summary.
  const attempts: Array<{ event: ReviewEvent; moveInline: boolean }> = [
    { event, moveInline: false },
    ...(event !== 'COMMENT' ? [{ event: 'COMMENT' as const, moveInline: false }] : []),
    ...(formatted.inlineComments.length > 0
      ? [{ event: 'COMMENT' as const, moveInline: true }]
      : []),
  ];

  let fallbackUsed = false;
  let finalSummary = formatted.summaryBody;
  let finalComments = formatted.inlineComments;
  let responseData: { id: number; html_url?: string } | undefined;

  for (const [index, attempt] of attempts.entries()) {
    finalSummary = attempt.moveInline
      ? appendFallbackCommentsToSummary(formatted.summaryBody, formatted.inlineComments)
      : formatted.summaryBody;
    finalComments = attempt.moveInline ? [] : formatted.inlineComments;
    try {
      const res = await octokit.rest.pulls.createReview({
        owner,
        repo,
        pull_number: prNumber,
        commit_id: review.headSha,
        event: attempt.event,
        body: finalSummary,
        comments: finalComments,
      });
      responseData = res.data;
      fallbackUsed = attempt.moveInline;
      break;
    } catch (err) {
      if (!isHttp422(err) || index === attempts.length - 1) throw err;
    }
  }
  if (!responseData) throw new Error('Review was not posted.');

  if (commentId !== undefined) {
    await addCompletionReaction(octokit, owner, repo, commentId, review.verdict);
  }

  return {
    posted: true,
    fallbackUsed,
    reviewId: responseData.id,
    htmlUrl: responseData.html_url,
    summaryBody: finalSummary,
    inlineComments: finalComments,
  };
}

export interface PublishThreadReplyOptions {
  owner: string;
  repo: string;
  prNumber: number;
  commentId: number;
  replyBody: string;
  token?: string;
  dryRun?: boolean;
  octokit?: PublisherOctokit;
}

/**
 * Posts a reply to an existing inline PR review comment thread.
 */
export async function publishThreadReply(
  options: PublishThreadReplyOptions,
): Promise<{ posted: boolean; commentId?: number; htmlUrl?: string; body: string }> {
  if (options.dryRun) {
    return {
      posted: false,
      body: options.replyBody,
    };
  }

  const octokit = await getOctokit(options.octokit, options.token);
  const res = await octokit.rest.pulls.createReplyForReviewComment({
    owner: options.owner,
    repo: options.repo,
    pull_number: options.prNumber,
    comment_id: options.commentId,
    body: options.replyBody,
  });

  if (octokit.rest.reactions?.createForPullRequestReviewComment) {
    try {
      await octokit.rest.reactions.createForPullRequestReviewComment({
        owner: options.owner,
        repo: options.repo,
        comment_id: options.commentId,
        content: '+1',
      });
    } catch {
      // Ignore reaction errors
    }
  }

  return {
    posted: true,
    commentId: res.data.id,
    htmlUrl: res.data.html_url,
    body: options.replyBody,
  };
}
