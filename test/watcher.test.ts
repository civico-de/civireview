import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config/loader.ts';
import {
  isInlineThreadReplyMention,
  loadSeenState,
  pollNotificationMentions,
  pollSearchMentions,
  runWatcherOnce,
  type WatcherMention,
  type WatcherOctokit,
} from '../src/github/watcher.ts';
import type { EvidenceBundle } from '../src/evidence/types.ts';
import type { FinalReview } from '../src/engine/schemas.ts';

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

describe('github watcher', () => {
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

  test('refuses to run without allowedAuthors allowlist', async () => {
    const dir = makeTempDir();
    const config = loadConfig(dir);

    await expect(
      runWatcherOnce({
        mode: 'search',
        repos: ['civicrm/civicrm-core'],
        allowedAuthors: [],
        config,
        repoRoot: dir,
      }),
    ).rejects.toThrow(/allowedAuthors/);
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
            expect(params.headers?.['If-Modified-Since']).toBe(
              'Sun, 22 Nov 2026 12:00:00 GMT',
            );
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

  test('allowedOrgs authorizes civicrm org members (including private) via author_association in 0 org API calls and rejects outsiders/bots', async () => {
    const dir = makeTempDir();
    const statePath = join(dir, 'seen.json');
    const config = loadConfig(dir);

    const orgApiCalls: string[] = [];
    const octokit: WatcherOctokit = {
      rest: {
        search: {
          async issuesAndPullRequests() {
            return { data: { items: [{ number: 38196 }] } };
          },
        },
        issues: {
          async listComments() {
            return {
              data: [
                {
                  id: 201,
                  user: { login: 'private-civicrm-member' },
                  author_association: 'MEMBER',
                  body: '@civireview',
                },
                {
                  id: 202,
                  user: { login: 'org-owner' },
                  author_association: 'OWNER',
                  body: '@civireview --full',
                },
                {
                  id: 203,
                  user: { login: 'dependabot[bot]', type: 'Bot' },
                  author_association: 'MEMBER',
                  body: '@civireview',
                },
                {
                  id: 204,
                  user: { login: 'random-outsider' },
                  author_association: 'NONE',
                  body: '@civireview',
                },
              ],
            };
          },
        },
        pulls: {
          async listReviewComments() {
            return { data: [] };
          },
          async createReview() {
            return { data: { id: 1 } };
          },
          async createReplyForReviewComment() {
            return { data: { id: 2 } };
          },
        },
        orgs: {
          async checkMembershipForUser({ org, username }) {
            orgApiCalls.push(`member:${org}:${username}`);
            const err = new Error('Not Found') as Error & { status: number };
            err.status = 404;
            throw err;
          },
          async checkPublicMembershipForUser({ org, username }) {
            orgApiCalls.push(`public:${org}:${username}`);
            const err = new Error('Not Found') as Error & { status: number };
            err.status = 404;
            throw err;
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

    const res = await runWatcherOnce({
      mode: 'search',
      repos: ['civicrm/civicrm-core'],
      allowedOrgs: ['civicrm'],
      statePath,
      config,
      repoRoot: dir,
      octokit,
      onProcessMention: async () => {},
    });

    expect(res.processed.map((m) => m.author)).toEqual([
      'private-civicrm-member',
      'org-owner',
    ]);
    // Org API was NEVER called for MEMBER/OWNER or Bot; only checked for outsider
    expect(orgApiCalls).toEqual([
      'member:civicrm:random-outsider',
      'public:civicrm:random-outsider',
    ]);
  });

  test('allowedOrgs falls back to cached public org membership API on cross-org repos', async () => {
    const dir = makeTempDir();
    const statePath = join(dir, 'seen.json');
    const config = loadConfig(dir);

    let publicApiCalls = 0;
    const octokit: WatcherOctokit = {
      rest: {
        search: {
          async issuesAndPullRequests() {
            return { data: { items: [{ number: 12 }] } };
          },
        },
        issues: {
          async listComments() {
            return {
              data: [
                {
                  id: 301,
                  user: { login: 'core-dev' },
                  author_association: 'NONE',
                  body: '@civireview',
                },
                {
                  id: 302,
                  user: { login: 'core-dev' },
                  author_association: 'NONE',
                  body: '@civireview --full',
                },
                {
                  id: 303,
                  user: { login: 'outsider' },
                  author_association: 'NONE',
                  body: '@civireview',
                },
              ],
            };
          },
        },
        pulls: {
          async listReviewComments() {
            return { data: [] };
          },
          async createReview() {
            return { data: { id: 1 } };
          },
          async createReplyForReviewComment() {
            return { data: { id: 2 } };
          },
        },
        orgs: {
          async checkMembershipForUser() {
            const err = new Error('Forbidden') as Error & { status: number };
            err.status = 403;
            throw err;
          },
          async checkPublicMembershipForUser({ username }) {
            publicApiCalls++;
            if (username === 'core-dev') return { status: 204 };
            const err = new Error('Not Found') as Error & { status: number };
            err.status = 404;
            throw err;
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

    const res = await runWatcherOnce({
      mode: 'search',
      repos: ['someone/fork-core'],
      allowedOrgs: ['civicrm'],
      statePath,
      config,
      repoRoot: dir,
      octokit,
      onProcessMention: async () => {},
    });

    expect(res.processed.map((m) => m.commentId)).toEqual([301, 302]);
    // 1 call for core-dev (cached for comment 302) + 1 call for outsider
    expect(publicApiCalls).toBe(2);
  });

  test('enforces maxReviewsPerHour and maxDailyUsd without losing deferred mentions', async () => {
    const dir = makeTempDir();
    const statePath = join(dir, 'seen.json');
    const config = loadConfig(dir);

    const octokit: WatcherOctokit = {
      rest: {
        search: {
          async issuesAndPullRequests() {
            return { data: { items: [{ number: 500 }] } };
          },
        },
        issues: {
          async listComments() {
            return {
              data: [
                {
                  id: 401,
                  user: { login: 'dev1' },
                  author_association: 'MEMBER',
                  body: '@civireview',
                },
                {
                  id: 402,
                  user: { login: 'dev2' },
                  author_association: 'MEMBER',
                  body: '@civireview',
                },
                {
                  id: 403,
                  user: { login: 'dev3' },
                  author_association: 'MEMBER',
                  body: '@civireview',
                },
              ],
            };
          },
        },
        pulls: {
          async listReviewComments() {
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

    let currentMs = Date.parse('2026-11-23T10:00:00Z');
    const pass1 = await runWatcherOnce({
      mode: 'search',
      repos: ['civicrm/civicrm-core'],
      allowedOrgs: ['civicrm'],
      maxReviewsPerHour: 2,
      maxDailyUsd: 0.5,
      statePath,
      config,
      repoRoot: dir,
      octokit,
      now: () => currentMs,
      onProcessMention: async () => ({ estimatedUsd: 0.3 }),
    });

    // Comment 401 ($0.30) + 402 ($0.30 -> total $0.60) run; 403 hits both hourly (2/2) and daily ($0.60/$0.50) caps
    expect(pass1.processed.map((m) => m.commentId)).toEqual([401, 402]);
    expect(pass1.throttled.map((m) => m.commentId)).toEqual([403]);

    // 61 minutes later (same UTC day): hourly window cleared, but daily USD cap ($0.60 >= $0.50) still blocks 403
    currentMs = Date.parse('2026-11-23T11:01:00Z');
    const pass2 = await runWatcherOnce({
      mode: 'search',
      repos: ['civicrm/civicrm-core'],
      allowedOrgs: ['civicrm'],
      maxReviewsPerHour: 2,
      maxDailyUsd: 0.5,
      statePath,
      config,
      repoRoot: dir,
      octokit,
      now: () => currentMs,
      onProcessMention: async () => ({ estimatedUsd: 0.2 }),
    });
    expect(pass2.processed).toHaveLength(0);
    expect(pass2.throttled.map((m) => m.commentId)).toEqual([403]);

    // Next UTC day: comment 403 was not marked seen, so it runs cleanly now
    currentMs = Date.parse('2026-11-24T00:05:00Z');
    const pass3 = await runWatcherOnce({
      mode: 'search',
      repos: ['civicrm/civicrm-core'],
      allowedOrgs: ['civicrm'],
      maxReviewsPerHour: 2,
      maxDailyUsd: 0.5,
      statePath,
      config,
      repoRoot: dir,
      octokit,
      now: () => currentMs,
      onProcessMention: async () => ({ estimatedUsd: 0.2 }),
    });
    expect(pass3.processed.map((m) => m.commentId)).toEqual([403]);
    expect(pass3.throttled).toHaveLength(0);
    expect(loadSeenState(statePath).seenCommentKeys).toHaveLength(3);
  });

  test('applies maxCommentAgeMinutes, ignores self-markers, performs zero-Docker pre-flight dedup, and supports checkOnly', async () => {
    const dir = makeTempDir();
    const statePath = join(dir, 'seen.json');
    const config = loadConfig(dir);
    const nowMs = Date.parse('2026-11-23T12:00:00Z');

    let collectCalls = 0;
    const octokit: WatcherOctokit = {
      rest: {
        search: {
          async issuesAndPullRequests() {
            return { data: { items: [{ number: 700 }] } };
          },
        },
        issues: {
          async listComments() {
            return {
              data: [
                {
                  id: 701,
                  user: { login: 'member' },
                  author_association: 'MEMBER',
                  created_at: '2026-11-20T00:00:00Z', // too old
                  body: '@civireview',
                },
                {
                  id: 702,
                  user: { login: 'member' },
                  author_association: 'MEMBER',
                  created_at: '2026-11-23T11:50:00Z',
                  body: 'Review summary mentioning @civireview\n<!-- civireview:v1 head=aaa -->',
                },
                {
                  id: 703,
                  user: { login: 'member' },
                  author_association: 'MEMBER',
                  created_at: '2026-11-23T11:55:00Z',
                  body: '@civireview', // already reviewed for head deadbeef
                },
                {
                  id: 704,
                  user: { login: 'member' },
                  author_association: 'MEMBER',
                  created_at: '2026-11-23T11:58:00Z',
                  body: '@civireview --full', // explicitly forces rerun
                },
              ],
            };
          },
        },
        pulls: {
          async listReviewComments() {
            return { data: [] };
          },
          async get() {
            return { data: { head: { sha: 'deadbeef1234567890' } } };
          },
          async listReviews() {
            return {
              data: [
                {
                  id: 99,
                  body: 'Previous review\n<!-- civireview:v1 head=deadbeef1234567890 base=1111111 trigger_comment=700 -->',
                  submitted_at: '2026-11-23T11:00:00Z',
                },
              ],
            };
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

    const checkRes = await runWatcherOnce({
      mode: 'search',
      repos: ['civicrm/civicrm-core'],
      allowedOrgs: ['civicrm'],
      maxCommentAgeMinutes: 60,
      checkOnly: true,
      statePath,
      config,
      repoRoot: dir,
      octokit,
      now: () => nowMs,
      deps: {
        collectEvidence: (async () => {
          collectCalls++;
          throw new Error('should not be called in checkOnly');
        }) as never,
      },
    });

    expect(collectCalls).toBe(0);
    expect(checkRes.processed).toHaveLength(0);
    // 701 ignored (too old), 702 ignored (self marker), 703 skipped duplicate (same head), 704 pending (--full)
    expect(checkRes.skippedDuplicate.map((m) => m.commentId)).toEqual([703]);
    expect(checkRes.pending.map((m) => m.commentId)).toEqual([704]);
    // checkOnly must not mutate seen.json
    expect(loadSeenState(statePath).seenCommentKeys).toHaveLength(0);
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
    expect(postedReplies[0]!.replyBody).toContain(
      '<!-- civireview:reply trigger_comment=801 -->',
    );
    expect(postedReviews).toEqual([802]);

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
