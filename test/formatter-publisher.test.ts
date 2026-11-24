import { describe, expect, test } from 'bun:test';
import type { FinalReview } from '../src/engine/schemas.ts';
import { parseUnifiedDiff } from '../src/evidence/diff-filter.ts';
import { extractAllReviewedMarkers } from '../src/evidence/github.ts';
import type { EvidenceBundle } from '../src/evidence/types.ts';
import { formatReviewMarkdown } from '../src/github/formatter.ts';
import {
  publishReview,
  publishThreadReply,
  type PublisherOctokit,
} from '../src/github/publisher.ts';

const DIFF = `diff --git a/CRM/Contact/BAO/Contact.php b/CRM/Contact/BAO/Contact.php
index 1111111..2222222 100644
--- a/CRM/Contact/BAO/Contact.php
+++ b/CRM/Contact/BAO/Contact.php
@@ -10,3 +10,4 @@ class CRM_Contact_BAO_Contact {
   public static function run($id) {
+    return $id;
   }
 }
`;

function makeSampleBundle(): EvidenceBundle {
  return {
    schemaVersion: '1',
    collectedAt: '2026-11-22T12:00:00Z',
    repoInfo: {
      kind: 'civicrm-core',
      root: '/tmp/repo',
      recommendedImage: 'standalone-master',
    },
    pr: {
      repo: 'civicrm/civicrm-core',
      isPrivateRepo: false,
      prNumber: 99,
      title: 'Test PR',
      body: 'Body',
      author: 'alice',
      baseBranch: 'master',
      headBranch: 'fix',
      baseSha: 'aaaa1111',
      headSha: 'bbbb2222',
      labels: [],
      draft: false,
    },
    comments: [],
    linkedIssues: [],
    diffFiles: parseUnifiedDiff(DIFF),
    droppedNoiseFiles: [],
    diffTruncated: false,
    abReport: {
      executed: true,
      imageA: 'standalone-master',
      imageB: 'standalone-master',
      checks: [],
      surfaceDiff: {
        changes: [],
        unverifiedSurfaces: [],
        touchedComponents: ['CRM'],
        summary: 'No surface changes.',
      },
      demoConsoleErrors: [],
      notVerified: ['Upgrade step not run'],
    },
    staticDelta: {
      executed: false,
      toolsRun: [],
      findings: [],
      summary: 'Skipped',
    },
    ciStatus: {
      overallState: 'success',
      checks: [],
      jenkinsFailedTests: [],
      summary: 'All passed',
    },
    notVerified: ['Upgrade step not run'],
  };
}

function makeSampleReview(): FinalReview {
  return {
    schemaVersion: '1',
    repo: 'civicrm/civicrm-core',
    prNumber: 99,
    baseSha: 'aaaa1111',
    headSha: 'bbbb2222',
    prKind: 'core-bugfix',
    verdict: 'NEEDS_CHANGES',
    walkthrough: ['Fixes contact lookup'],
    verificationMatrix: [
      { check: 'CI / Jenkins', status: 'PASS', detail: 'All passed' },
      {
        check: 'CiviKitchen A/B Proof-of-Fix',
        status: 'PASS',
        detail: 'standalone-master vs standalone-master: 1 test red on A, green on B',
      },
    ],
    notVerified: ['Upgrade step not run'],
    standards: [
      { code: 'r-explain', status: 'PASS', note: 'Good summary' },
      { code: 'r-test', status: 'PASS', note: 'Red/Green proven' },
    ],
    blastRadius: [
      {
        repo: 'civicrm/civicrm-core',
        path: 'CRM/Contact/Page/View.php',
        symbol: 'Contact::run',
        impact: 'Caller checked',
      },
    ],
    findings: [
      {
        id: 'inline-1',
        lens: 'correctness',
        title: 'Inline bug',
        severity: 'high',
        reassessedSeverity: 'high',
        verdict: 'PROVEN',
        confidence: 95,
        path: 'CRM/Contact/BAO/Contact.php',
        startLine: 11,
        endLine: 11,
        side: 'RIGHT',
        issue: 'Returns raw $id',
        failureScenario: 'Caller expects array',
        evidence: 'Line 11',
        verificationEvidence: 'Proven by test',
        suggestedFix: 'Return array',
        suggestionCode: 'return [$id];',
        mcpCitations: ['civicrm_read:CRM/Contact/BAO/Contact.php'],
      },
      {
        id: 'summary-1',
        lens: 'correctness',
        title: 'Untouched caller mismatch',
        severity: 'medium',
        reassessedSeverity: 'medium',
        verdict: 'CONFIRMED',
        confidence: 88,
        path: 'CRM/Contact/Page/View.php',
        startLine: 40,
        endLine: 40,
        side: 'RIGHT',
        issue: 'Expects object',
        failureScenario: 'TypeError in View.php',
        evidence: 'Line 40 of View.php',
        verificationEvidence: 'Confirmed via read_file',
        suggestedFix: 'Update caller',
        mcpCitations: [],
      },
    ],
    droppedCount: 1,
    modelsUsed: {
      triage: 'anthropic:claude-haiku-4-5',
      'specialist:correctness': 'anthropic:claude-sonnet-4-6',
      verifier: 'openai:gpt-5.2',
    },
    tokenUsage: {
      inputTokens: 500,
      outputTokens: 150,
      cachedInputTokens: 200,
      totalTokens: 650,
    },
    generatedAt: '2026-11-22T12:01:00Z',
  };
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

    expect(formatted.summaryBody).toContain('Needs Changes');
    expect(formatted.summaryBody).toContain('Confidence: **2/5** `★★☆☆☆`');
    expect(formatted.summaryBody).toContain('> **Summary:**');
    expect(formatted.summaryBody).toContain('> **Merge Confidence (2/5):**');
    expect(formatted.summaryBody).toContain('### Action Items (2)');
    expect(formatted.summaryBody).toContain(
      '- [ ] **[HIGH | PROVEN]** `CRM/Contact/BAO/Contact.php:11` — Inline bug — Return array',
    );
    expect(formatted.summaryBody).toContain(
      '- [ ] **[MEDIUM | CONFIRMED]** `CRM/Contact/Page/View.php:40` — Untouched caller mismatch — Update caller',
    );
    expect(formatted.summaryBody).toContain('<summary>Detailed Walkthrough (1 note)</summary>');
    expect(formatted.summaryBody).toContain('Empirical Verification Matrix');
    expect(formatted.summaryBody).toContain('CiviKitchen A/B Proof-of-Fix');
    expect(formatted.summaryBody).toContain('Not Verified:');
    expect(formatted.summaryBody).toContain('Upgrade step not run');
    expect(formatted.summaryBody).toContain('CiviCRM Core Standards');
    expect(formatted.summaryBody).toContain('`r-explain`');
    expect(formatted.summaryBody).toContain('Ecosystem Blast Radius');
    expect(formatted.summaryBody).toContain('Untouched caller mismatch');
    expect(formatted.summaryBody).not.toContain('AGENTS.md');
    expect(formatted.summaryBody).not.toContain('**Images:**');
    expect(formatted.summaryBody).toContain(
      'Reviewed by [civireview](https://github.com/civico-de/civireview) · `cross-model` · 650 tokens',
    );
    expect(formatted.summaryBody).toContain(
      '<!-- civireview:v1 head_sha=bbbb2222 base_sha=aaaa1111 preset=cross-model score=2/5 -->',
    );
  });

  test('formatReviewMarkdown omits extension-only clutter on core and avoids Summary/Confidence duplication', () => {
    const bundle = makeSampleBundle();
    const review = makeSampleReview();
    review.verdict = 'READY';
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
      '> **Summary:** Changes: Test PR. A/B testing proved 1 test(s) failed on base, passed on PR.',
    );
    expect(formatted.summaryBody).not.toContain('### Action Items');

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
    expect(withFailures.summaryBody).toContain('### Action Items (2)');
    expect(withFailures.summaryBody).toContain(
      '- [ ] **[CHECK FAILED]** Resolve `CI / Jenkins`: 1 check failed',
    );
    expect(withFailures.summaryBody).toContain(
      '- [ ] **[CONFLICTS]** Coordinate with [PR #38120](https://github.com/civicrm/civicrm-core/pull/38120): Edits the same file',
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
