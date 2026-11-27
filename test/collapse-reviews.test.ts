import { describe, expect, test } from 'bun:test';
import type { FinalReview } from '../src/engine/schemas.ts';
import { formatReviewMarkdown } from '../src/github/formatter.ts';
import {
  collapseReviewBody,
  publishReview,
  type PublisherOctokit,
} from '../src/github/publisher.ts';
import { makeSampleBundle, makeSampleReview } from './helpers/review-fixtures.ts';

const BOT = 'civireview-bot';
const NEW_URL = 'https://github.com/civicrm/civicrm-core/pull/99#pullrequestreview-900';

function oldReviewBody(headSha: string, verdict: FinalReview['verdict']): string {
  const review = { ...makeSampleReview(), headSha, verdict };
  return formatReviewMarkdown(review, makeSampleBundle()).summaryBody;
}

function collapseOctokit(
  reviews: Array<{ id: number; body: string; user: { login: string } }>,
  failIds: number[] = [],
  failResponse?: { status: number; headers: Record<string, string> },
) {
  const updates: Array<{ review_id: number; body: string }> = [];
  const calls: string[] = [];
  const octokit: PublisherOctokit = {
    async graphql(query, variables) {
      calls.push('graphql');
      expect(query).toContain('updatePullRequestReview');
      const reviewId = Number(String(variables.id).replace('PRR_', ''));
      if (failIds.includes(reviewId)) {
        throw failResponse
          ? Object.assign(new Error('Not Found'), {
              status: failResponse.status,
              response: failResponse,
            })
          : Object.assign(new Error('Server Error'), { status: 500 });
      }
      updates.push({ review_id: reviewId, body: String(variables.body) });
      return {};
    },
    rest: {
      pulls: {
        async createReview() {
          calls.push('createReview');
          return {
            data: {
              id: 900,
              html_url: NEW_URL,
              submitted_at: '2026-11-24T10:00:00Z',
              user: { login: BOT },
            },
          };
        },
        async listReviews() {
          calls.push('listReviews');
          return { data: reviews.map((r) => ({ ...r, node_id: `PRR_${r.id}` })) };
        },
        async createReplyForReviewComment() {
          throw new Error('unexpected createReplyForReviewComment');
        },
      },
    },
  };
  return { octokit, updates, calls };
}

function publishWith(octokit: PublisherOctokit, warnings: string[] = [], dryRun = false) {
  return publishReview({
    owner: 'civicrm',
    repo: 'civicrm-core',
    prNumber: 99,
    review: makeSampleReview(),
    bundle: makeSampleBundle(),
    octokit,
    dryRun,
    logger: { warn: (m) => warnings.push(m) },
  });
}

describe('collapsing earlier reviews', () => {
  test('a review posted after this one is left alone', async () => {
    const { octokit, updates } = collapseOctokit([
      { id: 1, body: oldReviewBody('1111111aaaa', 'NO_ISSUES_FOUND'), user: { login: BOT } },
      { id: 901, body: oldReviewBody('9999999eeee', 'NO_ISSUES_FOUND'), user: { login: BOT } },
    ]);

    const res = await publishWith(octokit);

    expect(res.collapsedReviewIds).toEqual([1]);
    expect(updates.map((u) => u.review_id)).toEqual([1]);
  });

  test('both earlier own reviews collapse to a one-line summary above the full body', async () => {
    const first = oldReviewBody('1111111aaaa', 'ISSUES_FOUND');
    const second = oldReviewBody('2222222bbbb', 'NO_ISSUES_FOUND');
    const { octokit, updates } = collapseOctokit([
      { id: 1, body: first, user: { login: BOT } },
      { id: 2, body: second, user: { login: 'CiviReview-Bot' } },
    ]);

    const res = await publishWith(octokit);

    expect(res.posted).toBe(true);
    expect(res.collapsedReviewIds).toEqual([1, 2]);
    expect(updates.map((u) => u.review_id)).toEqual([1, 2]);
    const [firstLine, ...rest] = updates[0]!.body.split('\n');
    expect(firstLine).toMatch(
      /^Superseded by \[the review of 2026-11-24\]\(https:\/\/github\.com\/civicrm\/civicrm-core\/pull\/99#pullrequestreview-900\) · 🔴 Issues found$/,
    );
    expect(rest.join('\n')).toContain(
      `<details><summary>Earlier review</summary>\n\n${first}\n\n</details>`,
    );
    expect(updates[1]!.body.split('\n')[0]).toMatch(/· 🟢 No issues found$/);
  });

  test('a review whose header carries a score keeps it in the one-line summary', () => {
    for (const header of [
      '## CiviReview: 🟡 **Questions only** · **3/5**',
      '## CiviReview: 🟡 **Questions only** · Confidence: **3/5**',
    ]) {
      const line = collapseReviewBody(`${header}\n\nbody`, 'https://example.org/r', '2026-11-24');
      expect(line.split('\n')[0]).toBe(
        'Superseded by [the review of 2026-11-24](https://example.org/r) · 🟡 Questions only · 3/5',
      );
    }
  });

  test('a collapsed review is not wrapped again', async () => {
    const collapsed = collapseReviewBody(
      oldReviewBody('1111111aaaa', 'NO_ISSUES_FOUND'),
      NEW_URL,
      '2026-11-23',
    );
    const { octokit, updates } = collapseOctokit([
      { id: 1, body: collapsed, user: { login: BOT } },
    ]);

    const res = await publishWith(octokit);

    expect(res.collapsedReviewIds).toEqual([]);
    expect(updates).toHaveLength(0);
  });

  test('a review in the first layout still collapses with its verdict and confidence', () => {
    const v1 = '## CiviReview: 🟡 **Questions Only** · Confidence: **3/5** `★★★☆☆`\n\nBody';
    expect(collapseReviewBody(v1, NEW_URL, '2026-11-24').split('\n')[0]).toBe(
      `Superseded by [the review of 2026-11-24](${NEW_URL}) · 🟡 Questions Only · 3/5`,
    );
  });

  test('a header that cannot be parsed leaves only the superseded link', () => {
    const note = 'Hand-written note\n\n<!-- civireview:v1 head_sha=abc base_sha=def -->';
    const out = collapseReviewBody(note, NEW_URL, '2026-11-24');
    expect(out.split('\n')[0]).toBe(`Superseded by [the review of 2026-11-24](${NEW_URL})`);
    expect(out).toContain(note);
  });

  test("other users' reviews and own reviews without a civireview marker stay untouched", async () => {
    const { octokit, updates } = collapseOctokit([
      { id: 1, body: oldReviewBody('1111111aaaa', 'NO_ISSUES_FOUND'), user: { login: 'alice' } },
      { id: 2, body: 'LGTM, merging after CI.', user: { login: BOT } },
      { id: 3, body: oldReviewBody('3333333cccc', 'NO_ISSUES_FOUND'), user: { login: BOT } },
    ]);

    const res = await publishWith(octokit);

    expect(updates.map((u) => u.review_id)).toEqual([3]);
    expect(res.collapsedReviewIds).toEqual([3]);
  });

  test('a failed update is logged with its review id and the run continues', async () => {
    const warnings: string[] = [];
    const { octokit, updates } = collapseOctokit(
      [
        { id: 1, body: oldReviewBody('1111111aaaa', 'NO_ISSUES_FOUND'), user: { login: BOT } },
        { id: 2, body: oldReviewBody('2222222bbbb', 'NO_ISSUES_FOUND'), user: { login: BOT } },
      ],
      [1],
    );

    const res = await publishWith(octokit, warnings);

    expect(res.posted).toBe(true);
    expect(res.reviewId).toBe(900);
    expect(updates.map((u) => u.review_id)).toEqual([2]);
    expect(warnings).toEqual(['Could not collapse earlier review 1: Error: Server Error']);
  });

  test("a refused update names the token's scopes and the ones the endpoint accepts", async () => {
    const review = {
      id: 1,
      body: oldReviewBody('1111111aaaa', 'NO_ISSUES_FOUND'),
      user: { login: BOT },
    };
    const classic = collapseOctokit([review], [1], {
      status: 404,
      headers: {
        'x-oauth-scopes': 'notifications, public_repo',
        'x-accepted-oauth-scopes': 'repo',
      },
    });
    const fineGrained = collapseOctokit([review], [1], { status: 404, headers: {} });
    const warnings: string[] = [];

    await publishWith(classic.octokit, warnings);
    await publishWith(fineGrained.octokit, warnings);

    expect(warnings).toEqual([
      'Could not collapse earlier review 1: Error: Not Found (x-oauth-scopes: notifications, public_repo; x-accepted-oauth-scopes: repo)',
      'Could not collapse earlier review 1: Error: Not Found (no scope headers: a fine-grained token or a GitHub App)',
    ]);
  });

  test('the update goes through GraphQL by node id, which a non-member token may use', async () => {
    const { octokit, calls } = collapseOctokit([
      { id: 1, body: oldReviewBody('1111111aaaa', 'NO_ISSUES_FOUND'), user: { login: BOT } },
    ]);

    await publishWith(octokit);

    expect(calls).toEqual(['createReview', 'listReviews', 'graphql']);
  });

  test('a client without GraphQL says so and leaves earlier reviews alone', async () => {
    const { octokit, updates } = collapseOctokit([
      { id: 1, body: oldReviewBody('1111111aaaa', 'NO_ISSUES_FOUND'), user: { login: BOT } },
    ]);
    const warnings: string[] = [];

    const res = await publishWith({ rest: octokit.rest }, warnings);

    expect(res.posted).toBe(true);
    expect(updates).toEqual([]);
    expect(warnings).toEqual([
      'The GitHub client has no GraphQL support; earlier reviews not collapsed.',
    ]);
  });

  test('dry-run neither lists nor updates reviews', async () => {
    const { octokit, calls } = collapseOctokit([
      { id: 1, body: oldReviewBody('1111111aaaa', 'NO_ISSUES_FOUND'), user: { login: BOT } },
    ]);

    const res = await publishWith(octokit, [], true);

    expect(res.posted).toBe(false);
    expect(calls).toEqual([]);
  });
});
