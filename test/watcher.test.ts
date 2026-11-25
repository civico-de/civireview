import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config/loader.ts';
import type { FinalReview } from '../src/engine/schemas.ts';
import type { EvidenceBundle } from '../src/evidence/types.ts';
import {
  isInlineThreadReplyMention,
  loadSeenState,
  pollNotificationMentions,
  pollSearchMentions,
  runWatcherOnce,
  type WatcherMention,
  type WatcherOctokit,
} from '../src/github/watcher.ts';

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'civireview-watch-test-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

describe('github watcher polling & execution', () => {
  test('search mode enforces allowedAuthors, parses flags, and deduplicates seen comment IDs', async () => {
    const dir = makeTempDir();
    const statePath = join(dir, 'seen.json');
    const config = loadConfig(dir);

    const reactions: unknown[] = [];
    const octokit: WatcherOctokit = {
      rest: {
        search: {
          async issuesAndPullRequests() {
            return {
              data: {
                items: [{ number: 1234 }],
              },
            };
          },
        },
        issues: {
          async listComments() {
            return {
              data: [
                {
                  id: 101,
                  user: { login: 'stranger' },
                  body: '@civireview --full',
                },
                {
                  id: 102,
                  user: { login: 'trusted-maintainer' },
                  body: '@civireview --preset cross-model --no-ab',
                },
              ],
            };
          },
        },
        pulls: {
          async listReviewComments() {
            return { data: [] };
          },
          async listReviews() {
            return { data: [] };
          },
          async createReview() {
            return { data: { id: 1 } };
          },
          async createReplyForReviewComment() {
            return { data: { id: 2 } };
          },
        },
        reactions: {
          async createForIssueComment(params) {
            reactions.push(params);
          },
        },
        activity: {
          async listNotificationsForAuthenticatedUser() {
            return { status: 200, data: [] };
          },
          async markThreadAsRead() {},
        },
      },
    };

    const processedMentions: WatcherMention[] = [];

    // First run: processes comment 102 from trusted-maintainer, ignores stranger (101)
    const first = await runWatcherOnce({
      mode: 'search',
      repos: ['civicrm/civicrm-core'],
      allowedAuthors: ['trusted-maintainer'],
      statePath,
      config,
      repoRoot: dir,
      octokit,
      onProcessMention: async (m) => {
        processedMentions.push(m);
      },
    });

    expect(first.processed).toHaveLength(1);
    expect(first.processed[0]!.commentId).toBe(102);
    expect(first.processed[0]!.flags.preset).toBe('cross-model');
    expect(first.processed[0]!.flags.ab).toBe(false);
    expect(reactions).toHaveLength(1);

    // Second run: comment 102 is already in seen.json -> 0 processed
    const second = await runWatcherOnce({
      mode: 'search',
      repos: ['civicrm/civicrm-core'],
      allowedAuthors: ['trusted-maintainer'],
      statePath,
      config,
      repoRoot: dir,
      octokit,
      onProcessMention: async (m) => {
        processedMentions.push(m);
      },
    });

    expect(second.processed).toHaveLength(0);
    expect(processedMentions).toHaveLength(1);
  });

  test('notifications mode filters mention PRs, marks threads read, and handles HTTP 304', async () => {
    const dir = makeTempDir();
    const statePath = join(dir, 'seen.json');
    const config = loadConfig(dir);
    const markedRead: string[] = [];
    let callCount = 0;

    const octokit: WatcherOctokit = {
      rest: {
        search: {
          async issuesAndPullRequests() {
            return { data: { items: [] } };
          },
        },
        issues: {
          async listComments() {
            return {
              data: [
                {
                  id: 500,
                  user: { login: 'alice' },
                  body: '@civireview --demo',
                },
              ],
            };
          },
        },
        pulls: {
          async listReviewComments() {
            return { data: [] };
          },
          async listReviews() {
            return { data: [] };
          },
          async createReview() {
            return { data: { id: 1 } };
          },
          async createReplyForReviewComment() {
            return { data: { id: 2 } };
          },
        },
        activity: {
          async listNotificationsForAuthenticatedUser(params) {
            callCount++;
            if (callCount === 1) {
              return {
                status: 200,
                headers: { 'last-modified': 'Sun, 22 Nov 2026 12:00:00 GMT' },
                data: [
                  {
                    id: 'thread-1',
                    reason: 'mention',
                    repository: { full_name: 'civicrm/civicrm-core' },
                    subject: {
                      type: 'PullRequest',
                      url: 'https://api.github.com/repos/civicrm/civicrm-core/pulls/77',
                    },
                  },
                  {
                    id: 'thread-2',
                    reason: 'subscribed',
                    repository: { full_name: 'civicrm/civicrm-core' },
                    subject: {
                      type: 'Issue',
                      url: 'https://api.github.com/repos/civicrm/civicrm-core/issues/88',
                    },
                  },
                ],
              };
            }
            expect(params.headers?.['If-Modified-Since']).toBe('Sun, 22 Nov 2026 12:00:00 GMT');
            const err = new Error('Not Modified') as Error & { status: number };
            err.status = 304;
            throw err;
          },
          async markThreadAsRead({ thread_id }) {
            markedRead.push(thread_id);
          },
        },
      },
    };

    const res1 = await runWatcherOnce({
      mode: 'notifications',
      repos: ['civicrm/civicrm-core'],
      allowedAuthors: ['alice'],
      statePath,
      config,
      repoRoot: dir,
      octokit,
      onProcessMention: async () => {},
    });

    expect(res1.processed).toHaveLength(1);
    expect(res1.processed[0]!.prNumber).toBe(77);
    expect(res1.processed[0]!.flags.demo).toBe(true);
    expect(markedRead).toEqual(['thread-1']);

    // Second run gets HTTP 304 Not Modified cleanly
    const res2 = await runWatcherOnce({
      mode: 'notifications',
      repos: ['civicrm/civicrm-core'],
      allowedAuthors: ['alice'],
      statePath,
      config,
      repoRoot: dir,
      octokit,
      onProcessMention: async () => {},
    });
    expect(res2.processed).toHaveLength(0);

    // Direct helper check
    const direct304 = await pollNotificationMentions({
      octokit,
      repos: ['civicrm/civicrm-core'],
      trigger: '@civireview',
      allowedAuthors: ['alice'],
      seenKeys: new Set(),
      lastModified: 'Sun, 22 Nov 2026 12:00:00 GMT',
    });
    expect(direct304.mentions).toHaveLength(0);
    expect(
      await pollSearchMentions({
        octokit,
        repos: ['civicrm/civicrm-core'],
        trigger: '@civireview',
        allowedAuthors: ['alice'],
        seenKeys: new Set(),
      }),
    ).toHaveLength(0);
  });

  test('search mode includes closed/merged PRs when includeClosedPrs is true and restricts to is:open when false', async () => {
    const queries: string[] = [];
    const octokit: WatcherOctokit = {
      rest: {
        search: {
          async issuesAndPullRequests(params) {
            queries.push(params.q);
            return { data: { items: [{ number: 555 }] } };
          },
        },
        issues: {
          async listComments() {
            return {
              data: [
                {
                  id: 901,
                  user: { login: 'maintainer' },
                  body: '@civireview --no-ab',
                },
              ],
            };
          },
        },
        pulls: {
          async listReviewComments() {
            return { data: [] };
          },
          async listReviews() {
            return { data: [] };
          },
          async createReview() {
            return { data: { id: 1 } };
          },
          async createReplyForReviewComment() {
            return { data: { id: 2 } };
          },
        },
        activity: {
          async listNotificationsForAuthenticatedUser() {
            return { status: 200, data: [] };
          },
          async markThreadAsRead() {},
        },
      },
    };

    const withClosed = await pollSearchMentions({
      octokit,
      repos: ['civicrm/civicrm-core'],
      trigger: '@civireview',
      allowedAuthors: ['maintainer'],
      includeClosedPrs: true,
      seenKeys: new Set(),
    });
    expect(withClosed).toHaveLength(1);
    expect(queries[0]).not.toContain('is:open');

    await pollSearchMentions({
      octokit,
      repos: ['civicrm/civicrm-core'],
      trigger: '@civireview',
      allowedAuthors: ['maintainer'],
      includeClosedPrs: false,
      seenKeys: new Set(),
    });
    expect(queries[1]).toContain('is:open');
  });

  test('routes inline review_comment questions to runThreadReply + publishThreadReply with zero-Docker config', async () => {
    const dir = makeTempDir();
    const statePath = join(dir, 'seen.json');
    const config = loadConfig(dir);

    const mockBundle: EvidenceBundle = {
      schemaVersion: '1',
      collectedAt: '2026-11-23T12:00:00Z',
      repoInfo: {
        kind: 'civicrm-core',
        root: dir,
        recommendedImage: 'standalone-master',
      },
      pr: {
        repo: 'civicrm/civicrm-core',
        isPrivateRepo: false,
        prNumber: 38196,
        title: 'Test PR',
        body: '',
        author: 'author',
        baseBranch: 'master',
        headBranch: 'fix',
        baseSha: '1111111111111111111111111111111111111111',
        headSha: '2222222222222222222222222222222222222222',
        labels: [],
        draft: false,
      },
      comments: [
        {
          id: 800,
          author: 'civireview-bot',
          body: 'Potential bug on line 42.',
          createdAt: '2026-11-23T11:00:00Z',
          kind: 'review_comment',
          path: 'CRM/Foo.php',
          line: 42,
        },
        {
          id: 801,
          author: 'civicrm-member',
          body: '@civireview why does this fail when contact_id is null?',
          createdAt: '2026-11-23T11:05:00Z',
          kind: 'review_comment',
          path: 'CRM/Foo.php',
          line: 42,
          inReplyToId: 800,
        },
      ],
      linkedIssues: [],
      diffFiles: [],
      droppedNoiseFiles: [],
      diffTruncated: false,
      ciStatus: {
        overallState: 'success',
        checks: [],
        jenkinsFailedTests: [],
        summary: 'ok',
      },
      abReport: {
        executed: false,
        imageA: 'standalone-master',
        imageB: 'standalone-master',
        checks: [],
        surfaceDiff: {
          changes: [],
          unverifiedSurfaces: [],
          touchedComponents: [],
          summary: 'none',
        },
        demoConsoleErrors: [],
        notVerified: [],
      },
      staticDelta: {
        executed: false,
        toolsRun: [],
        findings: [],
        summary: 'skipped',
      },
      notVerified: [],
    };

    const postedReplies: Array<{ commentId: number; replyBody: string }> = [];
    const postedReviews: number[] = [];
    const abEnabledCalls: boolean[] = [];

    const octokit: WatcherOctokit = {
      rest: {
        search: {
          async issuesAndPullRequests() {
            return { data: { items: [{ number: 38196 }] } };
          },
        },
        issues: {
          async listComments() {
            return { data: [] };
          },
        },
        pulls: {
          async listReviewComments() {
            return {
              data: [
                {
                  id: 801,
                  user: { login: 'civicrm-member' },
                  author_association: 'MEMBER',
                  body: '@civireview why does this fail when contact_id is null?',
                },
                {
                  id: 802,
                  user: { login: 'civicrm-member' },
                  author_association: 'MEMBER',
                  body: '@civireview --full',
                },
              ],
            };
          },
          async listReviews() {
            return { data: [] };
          },
          async createReview() {
            return { data: { id: 1 } };
          },
          async createReplyForReviewComment() {
            return { data: { id: 2 } };
          },
        },
        activity: {
          async listNotificationsForAuthenticatedUser() {
            return { status: 200, data: [] };
          },
          async markThreadAsRead() {},
        },
      },
    };

    const mockReview: FinalReview = {
      schemaVersion: '1',
      repo: 'civicrm/civicrm-core',
      prNumber: 38196,
      baseSha: mockBundle.pr.baseSha,
      headSha: mockBundle.pr.headSha,
      prKind: 'core-bugfix',
      verdict: 'READY',
      score: 5,
      shortSummary: 'Looks good.',
      walkthrough: ['No issues.'],
      verificationMatrix: [],
      notVerified: [],
      blastRadius: [],
      findings: [],
      droppedCount: 0,
      modelsUsed: { verifier: 'anthropic:claude-sonnet-4-6' },
      tokenUsage: {
        inputTokens: 100,
        outputTokens: 50,
        totalTokens: 150,
        estimatedUsd: 0.12,
      },
      generatedAt: '2026-11-23T12:00:00Z',
    };

    const res = await runWatcherOnce({
      mode: 'search',
      repos: ['civicrm/civicrm-core'],
      allowedOrgs: ['civicrm'],
      statePath,
      config,
      repoRoot: dir,
      octokit,
      deps: {
        collectEvidence: async (opts) => {
          abEnabledCalls.push(opts.config.ab.enabled);
          return {
            bundle: mockBundle,
            filteredPatch: '',
            cleanup: async () => {},
          };
        },
        runThreadReply: async (opts) => {
          if (opts.usage) opts.usage.estimatedUsd = 0.2;
          expect(opts.threadContext.userFollowUp).toContain('contact_id is null');
          return {
            reply: 'Because getValue() throws when contact_id is null.',
            resolved: false,
            references: ['CRM/Foo.php:42'],
          };
        },
        publishThreadReply: async (opts) => {
          postedReplies.push({
            commentId: opts.commentId,
            replyBody: opts.replyBody,
          });
          return { posted: true, commentId: 999, body: opts.replyBody };
        },
        runReviewPipeline: async () => mockReview,
        publishReview: async (opts) => {
          postedReviews.push(opts.commentId ?? 0);
          return {
            posted: true,
            fallbackUsed: false,
            summaryBody: 'ok',
            inlineComments: [],
          };
        },
      },
    });

    expect(res.processed.map((m) => m.commentId)).toEqual([801, 802]);
    // 801 routed to lightweight reply (ab=false); 802 (--full) routed to full review (ab=true)
    expect(abEnabledCalls).toEqual([false, true]);
    expect(postedReplies).toHaveLength(1);
    expect(postedReplies[0]!.commentId).toBe(801);
    expect(postedReplies[0]!.replyBody).toContain('<!-- civireview:reply trigger_comment=801 -->');
    expect(postedReviews).toEqual([802]);

    // A reply is a paid model call and counts against the daily limit.
    expect(
      (loadSeenState(statePath).recentRuns ?? [])
        .filter((r) => r.kind === 'reply')
        .map((r) => r.estimatedUsd),
    ).toEqual([0.2]);

    // Sanity check helper directly
    expect(isInlineThreadReplyMention(res.processed[0]!)).toBe(true);
    expect(isInlineThreadReplyMention(res.processed[1]!)).toBe(false);
  });

  test('notifications mode catches follow-up mentions with reason=comment and preserves lastModified when throttled', async () => {
    const dir = makeTempDir();
    const statePath = join(dir, 'seen.json');
    const config = loadConfig(dir);

    const octokit: WatcherOctokit = {
      rest: {
        search: {
          async issuesAndPullRequests() {
            return { data: { items: [] } };
          },
        },
        issues: {
          async listComments() {
            return {
              data: [
                {
                  id: 951,
                  user: { login: 'core-member' },
                  author_association: 'MEMBER',
                  body: '@civireview --full',
                },
                {
                  id: 952,
                  user: { login: 'core-member' },
                  author_association: 'MEMBER',
                  body: '@civireview --full',
                },
              ],
            };
          },
        },
        pulls: {
          async listReviewComments() {
            return { data: [] };
          },
          async listReviews() {
            return { data: [] };
          },
          async createReview() {
            return { data: { id: 1 } };
          },
          async createReplyForReviewComment() {
            return { data: { id: 2 } };
          },
        },
        activity: {
          async listNotificationsForAuthenticatedUser() {
            return {
              status: 200,
              headers: { 'last-modified': 'Mon, 23 Nov 2026 00:15:00 GMT' },
              data: [
                {
                  id: 'thread-comment',
                  reason: 'comment',
                  repository: { full_name: 'civicrm/civicrm-core' },
                  subject: {
                    type: 'PullRequest',
                    url: 'https://api.github.com/repos/civicrm/civicrm-core/pulls/38196',
                  },
                },
              ],
            };
          },
          async markThreadAsRead() {},
        },
      },
    };

    const res = await runWatcherOnce({
      mode: 'notifications',
      repos: ['civicrm/civicrm-core'],
      allowedOrgs: ['civicrm'],
      maxReviewsPerHour: 1,
      statePath,
      config,
      repoRoot: dir,
      octokit,
      onProcessMention: async () => {},
    });

    expect(res.processed.map((m) => m.commentId)).toEqual([951]);
    expect(res.throttled.map((m) => m.commentId)).toEqual([952]);
    // Must NOT advance lastModified while mention 952 is still throttled
    expect(loadSeenState(statePath).lastModified).toBeUndefined();

    // 952 fails with attempts left: the cursor stays, or a 304 would hide the retry.
    const failing = await runWatcherOnce({
      mode: 'notifications',
      repos: ['civicrm/civicrm-core'],
      allowedOrgs: ['civicrm'],
      statePath,
      config,
      repoRoot: dir,
      octokit,
      onProcessMention: async () => {
        throw new Error('model unavailable');
      },
    });
    expect(failing.failed.map((m) => m.commentId)).toEqual([952]);
    expect(loadSeenState(statePath).lastModified).toBeUndefined();

    // Once nothing is left for a later pass the cursor advances.
    await runWatcherOnce({
      mode: 'notifications',
      repos: ['civicrm/civicrm-core'],
      allowedOrgs: ['civicrm'],
      statePath,
      config,
      repoRoot: dir,
      octokit,
      onProcessMention: async () => {},
    });
    expect(loadSeenState(statePath).lastModified).toBe('Mon, 23 Nov 2026 00:15:00 GMT');
  });

  test('lockModels ignores --preset, --model, and --verifier overrides from PR comments while still honoring --effort high', async () => {
    const dir = makeTempDir();
    const statePath = join(dir, 'seen.json');
    const config = loadConfig(dir, { preset: 'sonnet-opus' });

    const seenConfigs: Array<{
      preset: string;
      verifier: string;
      correctness: string;
      effort: string;
    }> = [];

    const octokit: WatcherOctokit = {
      rest: {
        search: {
          async issuesAndPullRequests() {
            return { data: { items: [{ number: 38200 }] } };
          },
        },
        issues: {
          async listComments() {
            return {
              data: [
                {
                  id: 990,
                  user: { login: 'core-member' },
                  author_association: 'MEMBER',
                  body: '@civireview --preset cross-model --model anthropic:claude-fable-5-2 --verifier anthropic:claude-fable-5-2 --effort high',
                },
              ],
            };
          },
        },
        pulls: {
          async listReviewComments() {
            return { data: [] };
          },
          async listReviews() {
            return { data: [] };
          },
          async createReview() {
            return { data: { id: 1 } };
          },
          async createReplyForReviewComment() {
            return { data: { id: 2 } };
          },
        },
        activity: {
          async listNotificationsForAuthenticatedUser() {
            return { status: 200, data: [] };
          },
          async markThreadAsRead() {},
        },
      },
    };

    const mockBundle: EvidenceBundle = {
      schemaVersion: '1',
      collectedAt: '2026-11-23T00:00:00Z',
      repoInfo: {
        kind: 'civicrm-core',
        root: dir,
        recommendedImage: 'standalone-master',
      },
      pr: {
        repo: 'civicrm/civicrm-core',
        isPrivateRepo: false,
        prNumber: 38200,
        title: 'Test',
        body: '',
        author: 'core-member',
        baseBranch: 'master',
        headBranch: 'fix',
        baseSha: '1111111111111111111111111111111111111111',
        headSha: '2222222222222222222222222222222222222222',
        labels: [],
        draft: false,
      },
      comments: [],
      linkedIssues: [],
      diffFiles: [],
      droppedNoiseFiles: [],
      diffTruncated: false,
      ciStatus: {
        overallState: 'success',
        checks: [],
        jenkinsFailedTests: [],
        summary: 'ok',
      },
      abReport: {
        executed: false,
        imageA: 'standalone-master',
        imageB: 'standalone-master',
        checks: [],
        surfaceDiff: {
          changes: [],
          unverifiedSurfaces: [],
          touchedComponents: [],
          summary: 'none',
        },
        demoConsoleErrors: [],
        notVerified: [],
      },
      staticDelta: {
        executed: false,
        toolsRun: [],
        findings: [],
        summary: 'skipped',
      },
      notVerified: [],
    };

    const mockReview: FinalReview = {
      schemaVersion: '1',
      repo: 'civicrm/civicrm-core',
      prNumber: 38200,
      baseSha: mockBundle.pr.baseSha,
      headSha: mockBundle.pr.headSha,
      prKind: 'core-bugfix',
      verdict: 'READY',
      score: 5,
      shortSummary: 'Ok.',
      walkthrough: ['Ok.'],
      verificationMatrix: [],
      notVerified: [],
      blastRadius: [],
      findings: [],
      droppedCount: 0,
      modelsUsed: { verifier: 'anthropic:claude-opus-5-5' },
      generatedAt: '2026-11-23T00:00:00Z',
    };

    await runWatcherOnce({
      mode: 'search',
      repos: ['civicrm/civicrm-core'],
      allowedOrgs: ['civicrm'],
      lockModels: true,
      statePath,
      config,
      repoRoot: dir,
      octokit,
      deps: {
        collectEvidence: async (opts) => {
          seenConfigs.push({
            preset: opts.config.preset,
            verifier: opts.config.models.verifier,
            correctness: opts.config.models.specialists.correctness,
            effort: opts.config.review.effort,
          });
          return {
            bundle: mockBundle,
            filteredPatch: '',
            cleanup: async () => {},
          };
        },
        runReviewPipeline: async () => mockReview,
        publishReview: async () => ({
          posted: true,
          fallbackUsed: false,
          summaryBody: 'ok',
          inlineComments: [],
        }),
      },
    });

    expect(seenConfigs).toEqual([
      {
        preset: 'sonnet-opus',
        verifier: 'anthropic:claude-opus-5-5',
        correctness: 'anthropic:claude-sonnet-5-5',
        effort: 'high',
      },
    ]);
  });
});
