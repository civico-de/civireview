import { describe, expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FinalVerdictSchema } from '../src/engine/schemas.ts';
import { formatReviewMarkdown } from '../src/github/formatter.ts';
import {
  applyRerender,
  loadSavedReview,
  planRerender,
  type RerenderOctokit,
  type SavedReview,
} from '../src/github/rerender.ts';
import { makeSampleBundle, makeSampleReview } from './helpers/review-fixtures.ts';

const TRIGGER = 55;
const OLD_MARKER = `<!-- civireview:v1 head_sha=bbbb2222 base_sha=aaaa1111 preset=custom score=2/5 trigger_comment=${TRIGGER} -->`;

function saved(): SavedReview {
  return {
    review: makeSampleReview(),
    bundle: makeSampleBundle(),
    render: { format: 1, preset: 'custom', triggerCommentId: TRIGGER },
  };
}

type PostedReview = { id: number; node_id: string; body: string; user: { login: string } };
type PostedComment = {
  id: number;
  node_id: string;
  path: string;
  line: number | null;
  original_line?: number;
  original_start_line?: number;
  side: string;
  body: string;
};

function mockOctokit(reviews: PostedReview[], comments: PostedComment[]) {
  const writes: Array<{ query: string; id: unknown; body: unknown }> = [];
  const octokit: RerenderOctokit = {
    async graphql(query, variables) {
      writes.push({ query, id: variables.id, body: variables.body });
      return {};
    },
    rest: {
      pulls: {
        async listReviews() {
          return { data: reviews };
        },
        async listCommentsForReview() {
          return { data: comments };
        },
      },
    },
  };
  return { octokit, writes };
}

const oldReview = (
  body = `## CiviReview: 🔴 **Needs Changes** · Confidence: **2/5**\n\n${OLD_MARKER}`,
) => ({
  id: 10,
  node_id: 'PRR_10',
  body,
  user: { login: 'civireview' },
});
const oldInline = (body = 'old inline body') => ({
  id: 20,
  node_id: 'PRRC_20',
  path: 'CRM/Contact/BAO/Contact.php',
  line: 11,
  side: 'RIGHT',
  body,
});

describe('rerender', () => {
  test('updates the matching review and its inline comment through GraphQL', async () => {
    const { octokit, writes } = mockOctokit(
      [oldReview(), { ...oldReview(), id: 11, node_id: 'PRR_11', body: 'unrelated' }],
      [oldInline()],
    );

    const plan = await planRerender(saved(), octokit, 'civireview');
    await applyRerender(plan, octokit);

    expect(plan.reviewId).toBe(10);
    expect(plan.body).toContain('## CiviReview: 🔴 **Issues found** · 1 high, 1 medium');
    expect(plan.body).toContain(`format=4 trigger_comment=${TRIGGER} -->`);
    expect(writes.map((w) => [w.id, w.query.includes('updatePullRequestReviewComment')])).toEqual([
      ['PRR_10', false],
      ['PRRC_20', true],
    ]);
    expect(String(writes[1]!.body)).toContain('<summary>Evidence');
  });

  test('an unchanged review writes nothing', async () => {
    const s = saved();
    const formatted = formatReviewMarkdown(s.review, s.bundle, {
      preset: 'custom',
      triggerCommentId: TRIGGER,
    });
    const { octokit, writes } = mockOctokit(
      [oldReview(formatted.summaryBody)],
      [oldInline(formatted.inlineComments[0]!.body)],
    );

    const plan = await planRerender(s, octokit);
    await applyRerender(plan, octokit);

    expect(plan.bodyChanged).toBe(false);
    expect(plan.unchangedComments).toBe(1);
    expect(writes).toEqual([]);
  });

  test('inline findings GitHub refused stay in the summary', async () => {
    const posted = `## CiviReview\n\n### Inline Findings (Moved to Summary)\n\n…\n\n${OLD_MARKER}`;
    const { octokit } = mockOctokit([oldReview(posted)], []);
    const plan = await planRerender(saved(), octokit);
    expect(plan.inlineMovedToSummary).toBe(true);
    expect(plan.body).toContain('### Inline Findings (Moved to Summary)');
    expect(plan.comments).toEqual([]);
  });

  test('no or several matching reviews are an error', async () => {
    await expect(planRerender(saved(), mockOctokit([], []).octokit)).rejects.toThrow(
      'Expected one posted review for civicrm/civicrm-core#99 (head bbbb222, trigger comment 55), found 0.',
    );
    const twice = mockOctokit([oldReview(), { ...oldReview(), id: 12 }], []).octokit;
    await expect(planRerender(saved(), twice)).rejects.toThrow('found 2.');
  });

  test('a review by another login does not match', async () => {
    const { octokit } = mockOctokit([{ ...oldReview(), user: { login: 'someone' } }], []);
    await expect(planRerender(saved(), octokit, 'civireview')).rejects.toThrow('found 0.');
  });

  test('a collapsed review is refused', async () => {
    const collapsed = `Superseded by …\n\n<details><summary>Earlier review</summary>\n\n${OLD_MARKER}\n</details>\n<!-- civireview:collapsed -->`;
    const { octokit } = mockOctokit([oldReview(collapsed)], []);
    await expect(planRerender(saved(), octokit)).rejects.toThrow(
      'is collapsed under a later review',
    );
  });

  test('an inline comment on another line stops the plan before any write', async () => {
    const { octokit, writes } = mockOctokit([oldReview()], [{ ...oldInline(), line: 12 }]);
    await expect(planRerender(saved(), octokit)).rejects.toThrow(
      'new CRM/Contact/BAO/Contact.php:11:RIGHT, posted CRM/Contact/BAO/Contact.php:12:RIGHT',
    );
    expect(writes).toEqual([]);
  });

  test('deleted inline comments are a mismatch, not a moved summary', async () => {
    const { octokit, writes } = mockOctokit([oldReview()], []);
    await expect(planRerender(saved(), octokit)).rejects.toThrow(
      'new CRM/Contact/BAO/Contact.php:11:RIGHT',
    );
    expect(writes).toEqual([]);
  });

  test('a comment shifted by later commits matches by its original line', async () => {
    const { octokit } = mockOctokit(
      [oldReview()],
      [{ ...oldInline(), line: 30, original_line: 11 }],
    );
    const plan = await planRerender(saved(), octokit);
    expect(plan.comments.map((c) => c.id)).toEqual([20]);
  });

  test('a multiline comment matches only with the same start line', async () => {
    const posted = { ...oldInline(), original_start_line: 9 };
    const { octokit, writes } = mockOctokit([oldReview()], [posted]);
    await expect(planRerender(saved(), octokit)).rejects.toThrow(
      'posted CRM/Contact/BAO/Contact.php:9-11:RIGHT',
    );
    expect(writes).toEqual([]);
  });

  test('two saved findings on one line stop the plan', async () => {
    const s = saved();
    const inline = s.review.findings.find((f) => f.path === 'CRM/Contact/BAO/Contact.php')!;
    s.review.findings.push({ ...inline, id: `${inline.id}-twin`, title: 'Twin' });
    const { octokit, writes } = mockOctokit([oldReview()], [oldInline()]);
    await expect(planRerender(s, octokit)).rejects.toThrow('share a line');
    expect(writes).toEqual([]);
  });

  test('a saved directory names every missing file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rerender-'));
    writeFileSync(join(dir, 'review.json'), '{}');
    expect(() => loadSavedReview(dir)).toThrow(`${dir} lacks evidence.json, render.json`);
  });

  test('a saved verdict is computed again from the saved findings and checks', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rerender-'));
    const review = makeSampleReview();
    const mediumOnly = { ...review, verdict: 'QUESTIONS_ONLY', findings: [review.findings[1]] };
    writeFileSync(join(dir, 'review.json'), JSON.stringify(mediumOnly));
    writeFileSync(join(dir, 'evidence.json'), JSON.stringify(makeSampleBundle()));
    writeFileSync(join(dir, 'render.json'), JSON.stringify({ format: 3 }));
    expect(loadSavedReview(dir).review.verdict).toBe('ISSUES_FOUND');
  });
});

describe('saved reviews', () => {
  test('a verdict saved under its earlier name is read as the current one', () => {
    expect(FinalVerdictSchema.parse('READY')).toBe('NO_ISSUES_FOUND');
    expect(FinalVerdictSchema.parse('NEEDS_CHANGES')).toBe('ISSUES_FOUND');
    expect(FinalVerdictSchema.parse('QUESTIONS_ONLY')).toBe('QUESTIONS_ONLY');
    expect(FinalVerdictSchema.safeParse('APPROVED').success).toBe(false);
  });
});
