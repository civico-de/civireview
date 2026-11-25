import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config/loader.ts';
import { loadSeenState, runWatcherOnce, type WatcherOctokit } from '../src/github/watcher.ts';

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'civireview-watch-auth-test-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

describe('github watcher auth, budget & dedup', () => {
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

    expect(res.processed.map((m) => m.author)).toEqual(['private-civicrm-member', 'org-owner']);
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

  test('waitForCi defers reviews while CI/Jenkins is pending and proceeds once finished or --full', async () => {
    const dir = makeTempDir();
    const statePath = join(dir, 'seen.json');
    const config = loadConfig(dir, { preset: 'sonnet-opus' });
    const nowMs = Date.parse('2026-11-23T12:00:00Z');
    let ciState: 'pending' | 'success' = 'pending';
    let markedRead = 0;

    const octokit: WatcherOctokit = {
      rest: {
        search: {
          async issuesAndPullRequests() {
            return {
              data: {
                items: [
                  {
                    number: 38300,
                    repository_url: 'https://api.github.com/repos/civicrm/civicrm-core',
                    pull_request: {},
                  },
                ],
              },
            };
          },
        },
        issues: {
          async listComments() {
            return {
              data: [
                {
                  id: 801,
                  body: '@civireview',
                  user: { login: 'eileenmcnaughton' },
                  author_association: 'MEMBER',
                  created_at: '2026-11-23T11:50:00Z',
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
          async get() {
            return { data: { head: { sha: 'abc1234567890' } } };
          },
          async createReview() {
            return { data: { id: 1 } };
          },
          async createReplyForReviewComment() {
            return { data: { id: 1 } };
          },
        },
        repos: {
          async getCombinedStatusForRef() {
            return {
              data: {
                state: ciState,
                statuses: [{ context: 'CiviCRM-PR', state: ciState }],
              },
            };
          },
        },
        activity: {
          async listNotificationsForAuthenticatedUser() {
            return { data: [] };
          },
          async markThreadAsRead() {
            markedRead++;
          },
        },
      },
    };

    // 1. While Jenkins is pending -> deferred into waitingForCi (0 pending, 0 processed)
    const deferred = await runWatcherOnce({
      mode: 'search',
      repos: ['civicrm/civicrm-core'],
      allowedOrgs: ['civicrm'],
      waitForCi: true,
      waitForCiMaxMinutes: 90,
      checkOnly: true,
      statePath,
      config,
      repoRoot: dir,
      octokit,
      now: () => nowMs,
    });
    expect(deferred.waitingForCi.map((m) => m.commentId)).toEqual([801]);
    expect(deferred.pending).toHaveLength(0);
    expect(markedRead).toBe(0);

    // 2. Once Jenkins finishes (success) -> ready in pending!
    ciState = 'success';
    const ready = await runWatcherOnce({
      mode: 'search',
      repos: ['civicrm/civicrm-core'],
      allowedOrgs: ['civicrm'],
      waitForCi: true,
      waitForCiMaxMinutes: 90,
      checkOnly: true,
      statePath,
      config,
      repoRoot: dir,
      octokit,
      now: () => nowMs,
    });
    expect(ready.waitingForCi).toHaveLength(0);
    expect(ready.pending.map((m) => m.commentId)).toEqual([801]);

    // 3. If Jenkins stays pending past waitForCiMaxMinutes -> proceeds anyway
    ciState = 'pending';
    const timedOut = await runWatcherOnce({
      mode: 'search',
      repos: ['civicrm/civicrm-core'],
      allowedOrgs: ['civicrm'],
      waitForCi: true,
      waitForCiMaxMinutes: 5,
      checkOnly: true,
      statePath,
      config,
      repoRoot: dir,
      octokit,
      now: () => nowMs,
    });
    expect(timedOut.waitingForCi).toHaveLength(0);
    expect(timedOut.pending.map((m) => m.commentId)).toEqual([801]);
  });
});
