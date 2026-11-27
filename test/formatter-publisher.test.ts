import { describe, expect, test } from 'bun:test';
import type { FinalReview } from '../src/engine/schemas.ts';
import { extractAllReviewedMarkers } from '../src/evidence/github.ts';
import { BrowserDiffReportSchema, type EvidenceBundle } from '../src/evidence/types.ts';
import {
  fitSectionsToLimit,
  formatReviewMarkdown,
  MAX_GITHUB_BODY_CHARS,
  REVIEW_FORMAT,
} from '../src/github/formatter.ts';
import { formatThreadReplyBody } from '../src/github/thread-reply.ts';
import { makeSampleBundle, makeSampleReview } from './helpers/review-fixtures.ts';
import {
  publishReview,
  publishThreadReply,
  type PublisherOctokit,
} from '../src/github/publisher.ts';

/** The part of a summary shown without opening anything, and the rest. */
function splitAtFirstDetails(body: string): [string, string] {
  const at = body.indexOf('<details>');
  return at < 0 ? [body, ''] : [body.slice(0, at), body.slice(at)];
}

describe('formatter & publisher', () => {
  test('formatReviewMarkdown names the profile next to the kind', () => {
    const bundle = makeSampleBundle();
    expect(formatReviewMarkdown(makeSampleReview(), bundle).summaryBody).toContain(
      '**Profile:** `core` ·',
    );
    bundle.repoInfo.bundledExtensions = ['ext/widgets'];
    expect(formatReviewMarkdown(makeSampleReview(), bundle).summaryBody).toContain(
      '**Profile:** `core-extension` ·',
    );
  });

  test('formatReviewMarkdown renders A/B matrix, r-* table, blast radius, disclosure, and marker', () => {
    const review = makeSampleReview();
    const bundle = makeSampleBundle();
    const formatted = formatReviewMarkdown(review, bundle, {
      preset: 'cross-model',
    });

    expect(formatted.inlineComments).toHaveLength(1);
    expect(formatted.inlineComments[0]!.path).toBe('CRM/Contact/BAO/Contact.php');
    expect(formatted.inlineComments[0]!.line).toBe(11);
    expect(formatted.inlineComments[0]!.body).toContain('[HIGH | PROVEN]');
    expect(formatted.inlineComments[0]!.body).toContain('```suggestion');
    // The inline comment shows issue and fix; scenario and evidence are folded.
    const inline = formatted.inlineComments[0]!.body;
    expect(inline.indexOf('**Suggested fix:**')).toBeLessThan(inline.indexOf('<details>'));
    expect(inline.indexOf('<details>')).toBeLessThan(inline.indexOf('**Failure scenario:**'));

    const [visible, folded] = splitAtFirstDetails(formatted.summaryBody);
    expect(visible).toContain('## CiviReview: 🔴 **Issues found** · 1 high, 1 medium\n');
    expect(visible).toContain('**To address (2)**');
    expect(visible).toContain('- [ ] **HIGH** `CRM/Contact/BAO/Contact.php:11` — Inline bug');
    expect(visible).toContain(
      '- [ ] **MEDIUM** `CRM/Contact/Page/View.php:40` — Untouched caller mismatch',
    );
    expect(visible).toContain('✅ CI · ✅ Proof of fix');
    expect(folded).toContain('<summary>Findings outside the diff (1)</summary>');
    expect(folded).toContain('**Score (2/5):**');
    expect(folded).toContain('<summary>Verification (2 checks, 1 not verified)</summary>');
    expect(folded).toContain('| CiviKitchen A/B Proof-of-Fix | ✅ PASS |');
    expect(folded).toContain('**Not verified:**\n- Upgrade step not run');
    expect(folded).toContain('<summary>More: Walkthrough · standards · blast radius</summary>');
    expect(folded).toContain('#### CiviCRM core standards');
    expect(folded).toContain('`r-explain`');
    expect(folded).toContain('#### Ecosystem blast radius');
    expect(formatted.summaryBody).not.toContain('AGENTS.md');
    expect(formatted.summaryBody).not.toContain('**Images:**');
    expect(formatted.summaryBody).toContain(
      'Reviewed by [civireview](https://github.com/civico-de/civireview) · `cross-model` · 650 tokens',
    );
    expect(formatted.summaryBody).toContain(
      `<!-- civireview:v1 head_sha=bbbb2222 base_sha=aaaa1111 preset=cross-model score=2/5 format=${REVIEW_FORMAT} -->`,
    );
  });

  test('formatReviewMarkdown omits extension-only clutter on core and avoids Summary/Confidence duplication', () => {
    const bundle = makeSampleBundle();
    const review = makeSampleReview();
    review.verdict = 'NO_ISSUES_FOUND';
    review.findings = [];
    review.droppedCount = 0;
    review.verificationMatrix = [
      { check: 'CI / Jenkins', status: 'PASS', detail: '3/3 checks passed' },
      {
        check: 'A/B Proof-of-Fix',
        status: 'PASS',
        detail: '1 test(s) failed on base, passed on PR',
      },
    ];

    const formatted = formatReviewMarkdown(review, bundle, {
      preset: 'sonnet-opus',
    });

    expect(formatted.summaryBody).not.toContain('AGENTS.md');
    expect(formatted.summaryBody).not.toContain('**Images:**');
    expect(formatted.summaryBody).not.toContain('standalone-master vs standalone-master');
    // Summary and Merge Confidence must not repeat the exact same rationale sentence
    const rationaleOccurrences =
      formatted.summaryBody.split('No verified issues; passed CI / Jenkins, A/B Proof-of-Fix.')
        .length - 1;
    expect(rationaleOccurrences).toBe(1);
    expect(formatted.summaryBody).toContain(
      '## CiviReview: 🟢 **No issues found**\n\nChanges: Test PR. A/B testing proved 1 test(s) failed on base, passed on PR.',
    );
    expect(formatted.summaryBody).not.toContain('**To address');
    expect(formatted.summaryBody).toContain('No findings above the confidence gate.');

    // Failing check + conflicting PR show up as interactive checklist items even with 0 findings
    review.verificationMatrix.push({
      check: 'CI / Jenkins',
      status: 'FAIL',
      detail: '1 check failed',
    });
    review.relatedItems = [
      {
        kind: 'pr',
        ref: '#38120',
        title: 'Conflicting PR',
        url: 'https://github.com/civicrm/civicrm-core/pull/38120',
        relationship: 'conflicts',
        confidence: 90,
        reason: 'Edits the same file',
      },
    ];
    const withFailures = formatReviewMarkdown(review, bundle, {
      preset: 'sonnet-opus',
    });
    expect(withFailures.summaryBody).toContain('**To address (2)**');
    expect(withFailures.summaryBody).toContain('- [ ] **Check failed** CI: 1 check failed');
    expect(withFailures.summaryBody).toContain(
      '- [ ] **Conflicts with** [PR #38120](https://github.com/civicrm/civicrm-core/pull/38120): Edits the same file',
    );

    // Extension reviews still show Images metadata
    const extBundle = makeSampleBundle();
    extBundle.repoInfo.kind = 'civicrm-extension';
    extBundle.abReport.imageA = 'standalone-5.70';
    extBundle.abReport.imageB = 'standalone-beta';
    const extFormatted = formatReviewMarkdown(review, extBundle, {
      preset: 'sonnet-opus',
    });
    expect(extFormatted.summaryBody).toContain(
      '**Images:** `standalone-5.70` vs `standalone-beta`',
    );
  });

  test('publishReview posts batched review + reaction and respects dryRun', async () => {
    const review = makeSampleReview();
    const bundle = makeSampleBundle();

    const createReviewCalls: unknown[] = [];
    const reactionCalls: unknown[] = [];
    const octokit: PublisherOctokit = {
      rest: {
        pulls: {
          async listReviews() {
            return { data: [] };
          },
          async createReview(params) {
            createReviewCalls.push(params);
            return { data: { id: 777, html_url: 'https://github.com/test/review/777' } };
          },
          async createReplyForReviewComment() {
            return { data: { id: 888 } };
          },
        },
        reactions: {
          async createForIssueComment(params) {
            reactionCalls.push(params);
          },
        },
      },
    };

    const dryRes = await publishReview({
      owner: 'civicrm',
      repo: 'civicrm-core',
      prNumber: 99,
      review,
      bundle,
      dryRun: true,
      octokit,
      preset: 'cross-model',
    });
    expect(dryRes.posted).toBe(false);
    expect(createReviewCalls).toHaveLength(0);

    const liveRes = await publishReview({
      owner: 'civicrm',
      repo: 'civicrm-core',
      prNumber: 99,
      review,
      bundle,
      dryRun: false,
      commentId: 555,
      octokit,
      preset: 'cross-model',
    });
    expect(liveRes.posted).toBe(true);
    expect(liveRes.fallbackUsed).toBe(false);
    expect(liveRes.reviewId).toBe(777);
    expect(createReviewCalls).toHaveLength(1);
    expect(reactionCalls).toHaveLength(1);
  });

  test('publishReview falls back cleanly on HTTP 422 by moving inline comments to summary', async () => {
    const review = makeSampleReview();
    const bundle = makeSampleBundle();

    const calls: Array<{ commentsCount: number; body: string }> = [];
    const octokit: PublisherOctokit = {
      rest: {
        pulls: {
          async listReviews() {
            return { data: [] };
          },
          async createReview(params) {
            calls.push({
              commentsCount: params.comments?.length ?? 0,
              body: params.body,
            });
            if (calls.length === 1) {
              const err = new Error('Unprocessable Entity') as Error & { status: number };
              err.status = 422;
              throw err;
            }
            return { data: { id: 900 } };
          },
          async createReplyForReviewComment() {
            return { data: { id: 1 } };
          },
        },
      },
    };

    const res = await publishReview({
      owner: 'civicrm',
      repo: 'civicrm-core',
      prNumber: 99,
      review,
      bundle,
      octokit,
    });

    expect(calls).toHaveLength(2);
    expect(calls[0]!.commentsCount).toBe(1);
    expect(calls[1]!.commentsCount).toBe(0);
    expect(calls[1]!.body).toContain('Inline Findings (Moved to Summary)');
    expect(res.fallbackUsed).toBe(true);
    expect(res.posted).toBe(true);
  });

  test('publishThreadReply posts reply via createReplyForReviewComment', async () => {
    const replies: unknown[] = [];
    const octokit: PublisherOctokit = {
      rest: {
        pulls: {
          async listReviews() {
            return { data: [] };
          },
          async createReview() {
            return { data: { id: 1 } };
          },
          async createReplyForReviewComment(params) {
            replies.push(params);
            return { data: { id: 456 } };
          },
        },
      },
    };

    const res = await publishThreadReply({
      owner: 'civicrm',
      repo: 'civicrm-core',
      prNumber: 99,
      commentId: 123,
      replyBody: 'Looks fixed now!',
      octokit,
    });

    expect(res.posted).toBe(true);
    expect(res.commentId).toBe(456);
    expect(replies).toHaveLength(1);
  });

  test('publishReview forces COMMENT event on closed or merged PRs', async () => {
    const review = makeSampleReview();
    const bundle = makeSampleBundle();
    bundle.pr.state = 'closed';
    bundle.pr.merged = true;

    const eventsPosted: string[] = [];
    const octokit: PublisherOctokit = {
      rest: {
        pulls: {
          async listReviews() {
            return { data: [] };
          },
          async createReview(params) {
            eventsPosted.push(params.event);
            return { data: { id: 999 } };
          },
          async createReplyForReviewComment() {
            return { data: { id: 1 } };
          },
        },
      },
    };

    await publishReview({
      owner: 'civicrm',
      repo: 'civicrm-core',
      prNumber: 99,
      review,
      bundle,
      reviewEvent: 'REQUEST_CHANGES',
      octokit,
    });

    expect(eventsPosted).toEqual(['COMMENT']);
  });

  test('publishReview prevents duplicate reviews on same headSha unless force=true and embeds trigger_comment', async () => {
    const review = makeSampleReview();
    const bundle = makeSampleBundle();
    bundle.pr.lastReviewedHeadSha = review.headSha;

    let calls = 0;
    const postedBodies: string[] = [];
    const octokit: PublisherOctokit = {
      rest: {
        pulls: {
          async listReviews() {
            return { data: [] };
          },
          async createReview(params) {
            calls++;
            postedBodies.push(params.body);
            return { data: { id: 1000 + calls } };
          },
          async createReplyForReviewComment() {
            return { data: { id: 1 } };
          },
        },
      },
    };

    // Duplicate on same headSha without force -> skipped
    const skipped = await publishReview({
      owner: 'civicrm',
      repo: 'civicrm-core',
      prNumber: 99,
      review,
      bundle,
      commentId: 4242,
      octokit,
    });
    expect(skipped.posted).toBe(false);
    expect(skipped.skippedDuplicate).toBe(true);
    expect(calls).toBe(0);

    // Explicit --full (force=true) -> posts and embeds trigger_comment=4242
    const forced = await publishReview({
      owner: 'civicrm',
      repo: 'civicrm-core',
      prNumber: 99,
      review,
      bundle,
      commentId: 4242,
      force: true,
      octokit,
    });
    expect(forced.posted).toBe(true);
    expect(calls).toBe(1);
    const markers = extractAllReviewedMarkers([{ body: postedBodies[0]! }]);
    expect(markers).toEqual([
      {
        headSha: 'bbbb2222',
        baseSha: 'aaaa1111',
        triggerCommentId: 4242,
      },
    ]);
  });
});

function recordingOctokit(failWhen: (call: { event: string; comments: number }) => boolean) {
  const calls: Array<{ event: string; comments: number; body: string }> = [];
  const octokit: PublisherOctokit = {
    rest: {
      pulls: {
        async listReviews() {
          return { data: [] };
        },
        async createReview(params) {
          const call = {
            event: params.event,
            comments: params.comments?.length ?? 0,
            body: params.body,
          };
          calls.push(call);
          if (failWhen(call)) {
            throw Object.assign(new Error('Unprocessable Entity'), { status: 422 });
          }
          return { data: { id: 900 } };
        },
        async createReplyForReviewComment() {
          return { data: { id: 1 } };
        },
      },
    },
  };
  return { calls, octokit };
}

const mediumOnly = (verdict: 'CONFIRMED' | 'NEEDS_QUESTION'): FinalReview => {
  const review = makeSampleReview();
  return {
    ...review,
    verdict: verdict === 'CONFIRMED' ? 'ISSUES_FOUND' : 'QUESTIONS_ONLY',
    findings: [{ ...review.findings[1]!, verdict }],
  };
};

const reactionFor = async (review: FinalReview) => {
  const reactions: string[] = [];
  const { octokit } = recordingOctokit(() => false);
  octokit.rest.reactions = {
    async createForIssueComment(params) {
      reactions.push(params.content);
    },
  };
  await publishReview({
    owner: 'civicrm',
    repo: 'civicrm-core',
    prNumber: 99,
    review,
    bundle: makeSampleBundle(),
    commentId: 555,
    octokit,
  });
  return reactions;
};

const kindLine = (review: FinalReview) =>
  formatReviewMarkdown(review, makeSampleBundle()).summaryBody.match(/\*\*Kind:\*\*[^\n]*/)![0];
describe('verdict in the header, the lists and the reaction', () => {
  test('an unconfirmed finding and an open thread are questions, not things to address', () => {
    const review: FinalReview = {
      ...mediumOnly('NEEDS_QUESTION'),
      threadResolutions: [
        { author: 'bob', topic: 'Why public?', status: 'open', detail: 'Still public.' },
      ],
    };
    const [visible] = splitAtFirstDetails(
      formatReviewMarkdown(review, makeSampleBundle()).summaryBody,
    );
    expect(visible).toContain('## CiviReview: 🟡 **Questions only**\n');
    expect(visible).not.toContain('**To address');
    expect(visible).toContain(
      '**Questions (2)**\n- [ ] **MEDIUM** `CRM/Contact/Page/View.php:40` — Untouched caller mismatch\n- [ ] **Open thread** `bob`: Why public?',
    );
  });

  test('a single confirmed medium finding is named as the issue found', () => {
    const [visible] = splitAtFirstDetails(
      formatReviewMarkdown(mediumOnly('CONFIRMED'), makeSampleBundle()).summaryBody,
    );
    expect(visible).toContain('## CiviReview: 🔴 **Issues found** · 1 medium\n');
    expect(visible).toContain('**To address (1)**');
    expect(visible).not.toContain('**Questions');
  });

  test('the intent stands next to the kind when triage gave one', () => {
    expect(kindLine({ ...makeSampleReview(), intent: 'bugfix' })).toContain(
      '**Kind:** `core-bugfix` · **Intent:** `bugfix` · **Commits:**',
    );
    expect(kindLine(makeSampleReview())).toContain('**Kind:** `core-bugfix` · **Commits:**');
  });

  test('nothing found without a runtime result names the checks that gave none', () => {
    const review: FinalReview = {
      ...makeSampleReview(),
      verdict: 'NOT_VERIFIED',
      findings: [],
      verificationMatrix: [
        { check: 'CI / Jenkins', status: 'PASS', detail: 'All passed' },
        { check: 'A/B Proof-of-Fix', status: 'NOT_VERIFIED', detail: 'runner error' },
      ],
    };
    const [visible] = splitAtFirstDetails(
      formatReviewMarkdown(review, makeSampleBundle()).summaryBody,
    );
    expect(visible).toContain('## CiviReview: ⚪ **Not verified**\n');
    expect(visible).toContain(
      'No findings above the confidence gate, but no runtime check gave a result (Proof of fix).',
    );
  });

  test('the reaction is a thumbs-up only for no issues and never the eyes of a running review', async () => {
    const clean: FinalReview = { ...makeSampleReview(), verdict: 'NO_ISSUES_FOUND', findings: [] };
    expect(await reactionFor(clean)).toEqual(['+1']);
    expect(await reactionFor({ ...clean, verdict: 'NOT_VERIFIED' })).toEqual(['confused']);
    expect(await reactionFor(mediumOnly('NEEDS_QUESTION'))).toEqual(['confused']);
    expect(await reactionFor(mediumOnly('CONFIRMED'))).toEqual(['confused']);
  });

  test('a confirmed medium finding alone does not request changes', async () => {
    const { calls, octokit } = recordingOctokit(() => false);
    await publishReview({
      owner: 'civicrm',
      repo: 'civicrm-core',
      prNumber: 99,
      review: mediumOnly('CONFIRMED'),
      bundle: makeSampleBundle(),
      octokit,
      reviewEvent: 'REQUEST_CHANGES',
    });
    expect(calls.map((c) => c.event)).toEqual(['COMMENT']);
  });
});

describe('publishing limits and fallbacks', () => {
  test('a refused REQUEST_CHANGES is retried as COMMENT with the inline comments kept', async () => {
    const { calls, octokit } = recordingOctokit((c) => c.event === 'REQUEST_CHANGES');

    const res = await publishReview({
      owner: 'civicrm',
      repo: 'civicrm-core',
      prNumber: 99,
      review: makeSampleReview(),
      bundle: makeSampleBundle(),
      octokit,
      reviewEvent: 'REQUEST_CHANGES',
    });

    expect(calls.map((c) => [c.event, c.comments])).toEqual([
      ['REQUEST_CHANGES', 1],
      ['COMMENT', 1],
    ]);
    expect(res.posted).toBe(true);
    expect(res.fallbackUsed).toBe(false);
    expect(res.inlineComments).toHaveLength(1);
  });

  test('still folds inline comments into the summary when COMMENT with comments is refused too', async () => {
    const { calls, octokit } = recordingOctokit((c) => c.comments > 0);

    const res = await publishReview({
      owner: 'civicrm',
      repo: 'civicrm-core',
      prNumber: 99,
      review: makeSampleReview(),
      bundle: makeSampleBundle(),
      octokit,
      reviewEvent: 'REQUEST_CHANGES',
    });

    expect(calls.map((c) => [c.event, c.comments])).toEqual([
      ['REQUEST_CHANGES', 1],
      ['COMMENT', 1],
      ['COMMENT', 0],
    ]);
    expect(res.fallbackUsed).toBe(true);
  });

  test('a 422 without inline comments or a different error is not retried', async () => {
    const bundle = makeSampleBundle();
    const review = makeSampleReview();
    review.findings = [];
    const { calls, octokit } = recordingOctokit(() => true);

    await expect(
      publishReview({ owner: 'o', repo: 'r', prNumber: 1, review, bundle, octokit }),
    ).rejects.toThrow('Unprocessable Entity');
    expect(calls).toHaveLength(1);
  });

  test('keeps summary and inline comment bodies below the GitHub limit and the marker intact', () => {
    const review = makeSampleReview();
    const huge = 'x'.repeat(70_000);
    review.findings[0]!.issue = huge;
    review.blastRadius = Array.from({ length: 400 }, (_, i) => ({
      repo: 'civicrm/civicrm-core',
      path: `CRM/File${i}.php`,
      symbol: `Symbol${i}`,
      impact: 'y'.repeat(300),
    }));
    review.standards = Array.from({ length: 300 }, (_, i) => ({
      code: `r-${i}`,
      status: 'PASS' as const,
      note: 'z'.repeat(300),
    }));

    const out = formatReviewMarkdown(review, makeSampleBundle());

    expect(out.summaryBody.length).toBeLessThan(65_536);
    expect(out.summaryBody).toContain('<!-- civireview:v1');
    expect(out.summaryBody).toContain('omitted to fit GitHub');
    for (const comment of out.inlineComments) {
      expect(comment.body.length).toBeLessThan(65_536);
    }
  });

  test('proof output containing backticks cannot close its own fence', () => {
    const review = makeSampleReview();
    review.findings[0]!.liveProofCommand = 'echo `date`';
    review.findings[0]!.liveProofOutput = 'before\n```\nafter';

    const out = formatReviewMarkdown(review, makeSampleBundle());
    const body = out.inlineComments[0]!.body;

    expect(body).toContain('````text\nbefore\n```\nafter\n````');
    expect(body).toContain('`` echo `date` ``');
  });
});

const body = (review: FinalReview, bundle: EvidenceBundle, mentionUsers = false) =>
  formatReviewMarkdown(review, bundle, { mentionUsers }).summaryBody;

describe('formatter reference sections', () => {
  test('a clean browser probe is folded and lists its routes', () => {
    const bundle = makeSampleBundle();
    bundle.abReport.browserDiff = BrowserDiffReportSchema.parse({
      probedRoutes: ['civicrm/admin/thing'],
      probedAnonymousRoutes: ['civicrm/thing/public'],
    });
    const [visible, folded] = splitAtFirstDetails(body(makeSampleReview(), bundle));
    expect(folded).toContain('**Standalone browser A/B**');
    expect(folded).toContain('`civicrm/admin/thing`, `civicrm/thing/public`');
    expect(visible).not.toContain('civicrm/admin/thing');
  });

  test('a browser regression shows as a failed check and its detail is folded', () => {
    const bundle = makeSampleBundle();
    bundle.abReport.browserDiff = BrowserDiffReportSchema.parse({
      probedRoutes: ['civicrm/admin/thing'],
      new_console_errors: ['TypeError: x is undefined'],
    });
    const review = makeSampleReview();
    review.verificationMatrix.push({
      check: 'Browser A/B (Standalone)',
      status: 'FAIL',
      detail: 'Probed 1 route(s): 1 console regression(s).',
    });
    const [visible, folded] = splitAtFirstDetails(body(review, bundle));
    expect(visible).toContain('❌ Browser');
    expect(visible).toContain(
      '- [ ] **Check failed** Browser: Probed 1 route(s): 1 console regression(s).',
    );
    expect(folded).toContain('- **Console regressions:** TypeError: x is undefined');
  });

  test('a failed probe shows as not verified and its error is folded', () => {
    const bundle = makeSampleBundle();
    bundle.abReport.browserDiff = BrowserDiffReportSchema.parse({
      error: 'could not enable widgets',
    });
    const review = makeSampleReview();
    review.verificationMatrix.push({
      check: 'Browser A/B (Standalone)',
      status: 'NOT_VERIFIED',
      detail: 'Standalone browser A/B failed: could not enable widgets',
    });
    const [visible, folded] = splitAtFirstDetails(body(review, bundle));
    expect(visible).toContain('❔ Browser');
    expect(folded).toContain('- **Error:** could not enable widgets');
  });

  test('the visible part holds no table, evidence or check detail', () => {
    const review = makeSampleReview();
    review.verificationMatrix.push({
      check: 'Base-Test Regression',
      status: 'SKIPPED',
      detail: 'none',
    });
    const [visible] = splitAtFirstDetails(body(review, makeSampleBundle()));
    expect(visible).not.toMatch(/^\|/m);
    expect(visible).not.toContain('Failure scenario');
    expect(visible).not.toContain('**Score (');
    expect(visible).not.toContain('Base tests');
    expect(visible.trim().split('\n').length).toBeLessThanOrEqual(10);
  });

  test('related items are a table whose cells cannot break out of it', () => {
    const review: FinalReview = {
      ...makeSampleReview(),
      relatedItems: [
        {
          kind: 'pr',
          ref: '#123',
          title: 'Fix a | b',
          url: 'https://github.com/civicrm/civicrm-core/pull/123',
          relationship: 'duplicate',
          confidence: 91.4,
          reason: 'same file',
        },
      ],
    };
    const out = body(review, makeSampleBundle());
    expect(out).toContain('#### Related open PRs and issues');
    expect(out).toContain('[PR #123](https://github.com/civicrm/civicrm-core/pull/123)');
    expect(out).toContain('**91%**');
    expect(out).not.toContain('Fix a | b');
  });

  const withThreads: FinalReview = {
    ...makeSampleReview(),
    threadResolutions: [
      { author: '@bob', topic: 'Why public?', status: 'open', detail: 'Still public.' },
      { author: 'carol', topic: 'Add a test', status: 'addressed', detail: 'Test added.' },
    ],
  };

  test('reviewers are not mentioned unless asked for', () => {
    const out = body(withThreads, makeSampleBundle());
    expect(out).toContain('<summary>Reviewer threads (1 open, 1 addressed/answered)</summary>');
    expect(out).toContain('- [ ] **Open thread** `bob`: Why public?');
    expect(out).toContain('| `bob` | Why public? | ⏳ Open | Still public. |');
    expect(out).not.toContain('@bob');
    expect(out).not.toContain('@carol');
  });

  test('mentionUsers turns reviewer names into mentions', () => {
    const out = body(withThreads, makeSampleBundle(), true);
    expect(out).toContain('| @bob | Why public? |');
    expect(out).toContain('| @carol | Add a test | ✅ Addressed |');
  });
});

describe('GitHub body limit', () => {
  test('two oversized sections are both cut and the footer stays', () => {
    const footer = '<!-- civireview:v1 head_sha=abc -->';
    const out = fitSectionsToLimit(['# Title', 'a'.repeat(70_000), 'b'.repeat(70_000), footer]);
    expect(out.join('\n\n').length).toBeLessThanOrEqual(MAX_GITHUB_BODY_CHARS);
    expect(out.at(-1)).toBe(footer);
  });

  test('a kept detail section is truncated, never dropped', () => {
    const kept = `<details>\n<summary>Findings outside the diff (1)</summary>\n\n${'k'.repeat(60_000)}\n</details>`;
    const other = `<details>\n<summary>More</summary>\n\n${'m'.repeat(1_000)}\n</details>`;
    const out = fitSectionsToLimit(['# Title', kept, other, 'footer'], 50_000, new Set([kept]));
    expect(out.join('\n\n').length).toBeLessThanOrEqual(50_000);
    expect(out.some((s) => s.startsWith('<details>\n<summary>Findings outside the diff'))).toBe(
      true,
    );
    expect(out.some((s) => s.includes('<summary>More</summary>'))).toBe(false);
    expect(out[1]!.endsWith("_… truncated to fit GitHub's size limit._\n</details>")).toBe(true);
  });

  test('findings outside the diff survive an oversized review body', () => {
    const review = makeSampleReview();
    const outside = review.findings.find((f) => f.path === 'CRM/Contact/Page/View.php')!;
    outside.verificationEvidence = 'e'.repeat(70_000);
    const md = formatReviewMarkdown(review, makeSampleBundle()).summaryBody;
    expect(md.length).toBeLessThanOrEqual(MAX_GITHUB_BODY_CHARS);
    expect(md).toContain('<summary>Findings outside the diff (1)</summary>');
    expect(md).toContain('**Failure scenario:** TypeError in View.php');
    expect(md).not.toContain('<summary>More:');
  });

  test('a body within the limit is left alone', () => {
    const sections = ['# Title', 'short', 'footer'];
    expect(fitSectionsToLimit(sections)).toEqual(sections);
  });

  test('an oversized thread reply is cut and keeps its dedup marker', () => {
    const replyBody = formatThreadReplyBody(
      { reply: 'x'.repeat(80_000), resolved: false, references: ['CRM/Foo.php:1'] },
      { triggerCommentId: 7 },
    );
    expect(replyBody.length).toBeLessThanOrEqual(MAX_GITHUB_BODY_CHARS);
    expect(replyBody).toContain('<!-- civireview:reply trigger_comment=7 -->');
    expect(formatThreadReplyBody({ reply: 'ok', resolved: true, references: [] })).not.toContain(
      'truncated',
    );
  });
});
