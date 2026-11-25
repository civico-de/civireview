import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { FinalReviewSchema, type FinalReview } from '../engine/schemas.ts';
import { extractAllReviewedMarkers, fetchAllPages } from '../evidence/github.ts';
import { EvidenceBundleSchema, type EvidenceBundle } from '../evidence/types.ts';
import { formatReviewMarkdown, type GitHubReviewCommentInput } from './formatter.ts';
import {
  appendFallbackCommentsToSummary,
  COLLAPSED_RE,
  MOVED_TO_SUMMARY_HEADING,
  UPDATE_REVIEW_MUTATION,
  type PublisherOctokit,
} from './publisher.ts';

/** The render options the watcher saves beside a review as `render.json`. */
export const RenderOptionsSchema = z.object({
  format: z.number().int(),
  preset: z.string().optional(),
  maxInlineComments: z.number().int().optional(),
  triggerCommentId: z.number().int().optional(),
  mentionUsers: z.boolean().optional(),
});
export type RenderOptions = z.infer<typeof RenderOptionsSchema>;

export interface SavedReview {
  review: FinalReview;
  bundle: EvidenceBundle;
  render: RenderOptions;
}

/** Reads `review.json`, `evidence.json` and `render.json`; all three are required. */
export function loadSavedReview(dir: string): SavedReview {
  const files = ['review.json', 'evidence.json', 'render.json'];
  const missing = files.filter((f) => !existsSync(join(dir, f)));
  if (missing.length > 0) {
    throw new Error(`${dir} lacks ${missing.join(', ')}; nothing to rerender.`);
  }
  const read = (f: string): unknown => JSON.parse(readFileSync(join(dir, f), 'utf8'));
  return {
    review: FinalReviewSchema.parse(read('review.json')),
    bundle: EvidenceBundleSchema.parse(read('evidence.json')),
    render: RenderOptionsSchema.parse(read('render.json')),
  };
}

export interface RerenderOctokit {
  graphql(query: string, variables: Record<string, unknown>): Promise<unknown>;
  rest: {
    pulls: {
      listReviews: PublisherOctokit['rest']['pulls']['listReviews'];
      listCommentsForReview(params: {
        owner: string;
        repo: string;
        pull_number: number;
        review_id: number;
        per_page?: number;
        page?: number;
      }): Promise<{
        data: Array<{
          id: number;
          node_id: string;
          path: string;
          line?: number | null;
          original_line?: number | null;
          start_line?: number | null;
          original_start_line?: number | null;
          side?: string | null;
          body: string;
        }>;
      }>;
    };
  };
}

export interface RerenderPlan {
  reviewId: number;
  reviewNodeId: string;
  reviewUrl?: string;
  body: string;
  bodyChanged: boolean;
  /** Inline comments whose body changes, with the GraphQL id to update. */
  comments: Array<{ id: number; nodeId: string; path: string; line: number; body: string }>;
  unchangedComments: number;
  inlineMovedToSummary: boolean;
}

const UPDATE_COMMENT_MUTATION = `mutation ($id: ID!, $body: String!) {
  updatePullRequestReviewComment(input: { pullRequestReviewCommentId: $id, body: $body }) {
    pullRequestReviewComment { id }
  }
}`;

const commentKey = (c: { path: string; line: number; start_line?: number; side: string }) =>
  `${c.path}:${c.start_line ? `${c.start_line}-` : ''}${c.line}:${c.side}`;

/**
 * Renders a saved review in the current layout and matches it to the posted review (by
 * head SHA and trigger comment) and its inline comments (by path, line and side). Any
 * mismatch is an error, so a plan is either complete or not made.
 */
export async function planRerender(
  saved: SavedReview,
  octokit: RerenderOctokit,
  botLogin?: string,
): Promise<RerenderPlan> {
  const { review, bundle, render } = saved;
  const [owner, repo] = review.repo.split('/') as [string, string];
  const pr = { owner, repo, pull_number: review.prNumber };
  const formatted = formatReviewMarkdown(review, bundle, {
    preset: render.preset,
    maxInlineComments: render.maxInlineComments,
    triggerCommentId: render.triggerCommentId,
    mentionUsers: render.mentionUsers,
  });

  const reviews = await fetchAllPages((page) =>
    octokit.rest.pulls.listReviews({ ...pr, per_page: 100, page }).then((r) => r.data),
  );
  const login = botLogin?.toLowerCase();
  const matches = reviews.filter((r) => {
    if (login && r.user?.login?.toLowerCase() !== login) return false;
    const marker = extractAllReviewedMarkers([{ body: r.body }]).at(-1);
    return (
      marker?.headSha === review.headSha && marker.triggerCommentId === render.triggerCommentId
    );
  });
  const where = `${review.repo}#${review.prNumber} (head ${review.headSha.slice(0, 7)}${render.triggerCommentId ? `, trigger comment ${render.triggerCommentId}` : ''})`;
  if (matches.length !== 1) {
    throw new Error(`Expected one posted review for ${where}, found ${matches.length}.`);
  }
  const target = matches[0]!;
  if (COLLAPSED_RE.test(target.body ?? '')) {
    throw new Error(
      `Review ${target.id} on ${where} is collapsed under a later review; rerender that one.`,
    );
  }
  if (!target.node_id) throw new Error(`Review ${target.id} has no node_id in the response.`);

  const posted = await fetchAllPages((page) =>
    octokit.rest.pulls
      .listCommentsForReview({ ...pr, review_id: target.id, per_page: 100, page })
      .then((r) => r.data),
  );
  // A review whose inline comments GitHub refused was posted with them in the summary.
  const inlineMovedToSummary =
    posted.length === 0 &&
    formatted.inlineComments.length > 0 &&
    (target.body ?? '').includes(MOVED_TO_SUMMARY_HEADING);
  const wanted: GitHubReviewCommentInput[] = inlineMovedToSummary ? [] : formatted.inlineComments;
  const body = inlineMovedToSummary
    ? appendFallbackCommentsToSummary(formatted.summaryBody, formatted.inlineComments)
    : formatted.summaryBody;

  const byKey = new Map<string, (typeof posted)[number]>();
  for (const c of posted) {
    // The review's own position; `line` moves with later commits.
    const line = c.original_line ?? c.line;
    if (line == null) throw new Error(`Inline comment ${c.id} has no line; cannot match it.`);
    const start = c.original_start_line ?? c.start_line ?? undefined;
    byKey.set(commentKey({ path: c.path, line, start_line: start, side: c.side ?? 'RIGHT' }), c);
  }
  const wantedKeys = new Set(wanted.map(commentKey));
  if (wantedKeys.size !== wanted.length) {
    throw new Error(
      `Two saved inline findings of review ${target.id} share a line; cannot match them.`,
    );
  }
  const unmatched = [
    ...wanted.filter((w) => !byKey.has(commentKey(w))).map((w) => `new ${commentKey(w)}`),
    ...[...byKey.keys()].filter((k) => !wantedKeys.has(k)).map((k) => `posted ${k}`),
  ];
  if (unmatched.length > 0 || byKey.size !== posted.length) {
    throw new Error(
      `Inline comments of review ${target.id} do not match the saved review: ${unmatched.join(', ') || 'two comments share a line'}.`,
    );
  }

  const comments: RerenderPlan['comments'] = [];
  let unchangedComments = 0;
  for (const w of wanted) {
    const c = byKey.get(commentKey(w))!;
    if (c.body === w.body) unchangedComments++;
    else comments.push({ id: c.id, nodeId: c.node_id, path: w.path, line: w.line, body: w.body });
  }
  return {
    reviewId: target.id,
    reviewNodeId: target.node_id,
    reviewUrl: target.html_url,
    body,
    bodyChanged: (target.body ?? '') !== body,
    comments,
    unchangedComments,
    inlineMovedToSummary,
  };
}

/** Writes a plan: the review body first, then each changed inline comment. */
export async function applyRerender(plan: RerenderPlan, octokit: RerenderOctokit): Promise<void> {
  if (plan.bodyChanged) {
    await octokit.graphql(UPDATE_REVIEW_MUTATION, { id: plan.reviewNodeId, body: plan.body });
  }
  for (const c of plan.comments) {
    await octokit.graphql(UPDATE_COMMENT_MUTATION, { id: c.nodeId, body: c.body });
  }
}
