import { afterEach, describe, expect, test } from 'bun:test';
import { BudgetExceededError } from '../src/engine/budget.ts';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config/loader.ts';
import {
  loadSeenState,
  runWatcherOnce,
  saveSeenState,
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

function makeFailingSetup(commentIds: number[], pipelineError?: Error, isPrivateRepo?: boolean) {
  const dir = makeTempDir();
  const config = loadConfig(dir);
  const octokit = {
    rest: {
      search: {
        async issuesAndPullRequests() {
          return { data: { items: [{ number: 7 }] } };
        },
      },
      issues: {
        async listComments() {
          return {
            data: commentIds.map((id) => ({
              id,
              user: { login: 'maint' },
              body: '@civireview',
            })),
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
      reactions: { async createForIssueComment() {} },
      activity: {
        async listNotificationsForAuthenticatedUser() {
          return { status: 200, data: [] };
        },
        async markThreadAsRead() {},
      },
    },
  } as unknown as WatcherOctokit;

  const pipelineRuns: number[] = [];
  const published: number[] = [];
  const deps = {
    collectEvidence: async () => ({
      bundle: {
        comments: [],
        pr: { headSha: 'abc1234', lastReviewedHeadSha: undefined, isPrivateRepo },
        diffFiles: [],
        abReport: { executed: false, checks: [] },
      },
      filteredPatch: '',
      urls: undefined,
      composeFiles: undefined,
      cleanup: async () => {},
    }),
    runReviewPipeline: async (opts: { usage?: { estimatedUsd?: number } }) => {
      pipelineRuns.push(pipelineRuns.length + 1);
      // The stages before the failure cost 0.4.
      if (pipelineError && opts.usage) opts.usage.estimatedUsd = 0.4;
      if (pipelineError) throw pipelineError;
      return { verdict: 'READY', tokenUsage: { estimatedUsd: 1.5 } };
    },
    publishReview: async (opts: { commentId?: number }) => {
      if (opts.commentId === 101) throw new Error('HTTP 403 Resource not accessible');
      published.push(opts.commentId ?? 0);
      return {};
    },
  };
  const statePath = join(dir, 'seen.json');
  const pass = (extra: Record<string, unknown> = {}) =>
    runWatcherOnce({
      mode: 'search',
      repos: ['o/r'],
      allowedAuthors: ['maint'],
      statePath,
      config,
      repoRoot: dir,
      octokit,
      deps,
      ...extra,
    } as unknown as Parameters<typeof runWatcherOnce>[0]);
  return { pass, statePath, pipelineRuns, published, dir };
}

describe('watcher failure handling and state file', () => {
  test('a failing mention counts against the rate limit instead of retrying without bound', async () => {
    const { pass, pipelineRuns } = makeFailingSetup([101]);

    const first = await pass({ maxReviewsPerHour: 2 });
    const second = await pass({ maxReviewsPerHour: 2 });
    const third = await pass({ maxReviewsPerHour: 2 });

    expect(first.failed).toHaveLength(1);
    expect(second.failed).toHaveLength(1);
    expect(third.failed).toHaveLength(0);
    expect(third.throttled).toHaveLength(1);
    expect(pipelineRuns).toHaveLength(2);
  });

  test('a review stopped by its budget is not retried and its cost is recorded', async () => {
    const { pass, statePath, pipelineRuns } = makeFailingSetup(
      [101],
      new BudgetExceededError(2, 2, 'verifier'),
    );
    await pass();
    await pass();
    expect(pipelineRuns).toHaveLength(1);
    const state = loadSeenState(statePath);
    expect(state.seenCommentKeys).toContain('o/r#101');
    expect((state.recentRuns ?? []).map((r) => r.estimatedUsd)).toEqual([2]);
  });

  test('a review that fails midway still counts what its finished stages cost', async () => {
    const { pass, statePath } = makeFailingSetup([102], new Error('verifier crashed'));
    await pass();
    expect((loadSeenState(statePath).recentRuns ?? []).map((r) => r.estimatedUsd)).toEqual([0.4]);
  });

  test('saves the review of a public repo, also when posting it fails', async () => {
    const { pass, dir } = makeFailingSetup([101, 102], undefined, false);
    const outDir = join(dir, 'out');
    await pass({ outDir });
    for (const id of [101, 102]) {
      const saved = JSON.parse(readFileSync(join(outDir, `o-r-7-${id}`, 'review.json'), 'utf8'));
      expect(saved.verdict).toBe('READY');
    }
  });

  test('does not save the review of a private or unclassified repo', async () => {
    for (const isPrivateRepo of [true, undefined]) {
      const { pass, dir } = makeFailingSetup([102], undefined, isPrivateRepo);
      const outDir = join(dir, 'out');
      const result = await pass({ outDir });
      expect(result.processed).toHaveLength(1);
      expect(existsSync(outDir)).toBe(false);
    }
  });

  test('gives up on a mention after repeated failures and keeps processing the others', async () => {
    const { pass, statePath, pipelineRuns, published } = makeFailingSetup([101, 102]);

    const first = await pass();
    expect(first.failed.map((m) => m.commentId)).toEqual([101]);
    expect(first.processed.map((m) => m.commentId)).toEqual([102]);
    expect(published).toEqual([102]);

    await pass();
    await pass();
    expect(loadSeenState(statePath).seenCommentKeys).toContain('o/r#101');
    expect(loadSeenState(statePath).failedAttempts).toEqual({});

    const runsBefore = pipelineRuns.length;
    const fourth = await pass();
    expect(fourth.failed).toHaveLength(0);
    expect(pipelineRuns).toHaveLength(runsBefore);
  });

  test('an unreadable state file is an error, not an empty state', () => {
    const dir = makeTempDir();
    const statePath = join(dir, 'seen.json');
    writeFileSync(statePath, '{"seenCommentKeys": ["o/r#1", ');

    expect(() => loadSeenState(statePath)).toThrow(/unreadable/);
    expect(loadSeenState(join(dir, 'missing.json')).seenCommentKeys).toEqual([]);
  });

  test('saveSeenState never writes the state file in place: a failed save keeps the previous state', () => {
    const dir = makeTempDir();
    const statePath = join(dir, 'seen.json');
    saveSeenState(statePath, { seenCommentKeys: ['o/r#1'] });
    // A directory at the temp path makes the write of the replacement fail.
    mkdirSync(`${statePath}.tmp`);

    expect(() => saveSeenState(statePath, { seenCommentKeys: ['o/r#1', 'o/r#2'] })).toThrow();

    expect(loadSeenState(statePath).seenCommentKeys).toEqual(['o/r#1']);
  });

  test('saveSeenState leaves no temp file behind', () => {
    const dir = makeTempDir();
    const statePath = join(dir, 'state', 'seen.json');
    saveSeenState(statePath, { seenCommentKeys: ['o/r#1'] });
    saveSeenState(statePath, { seenCommentKeys: ['o/r#1', 'o/r#2'] });

    expect(loadSeenState(statePath).seenCommentKeys).toEqual(['o/r#1', 'o/r#2']);
    expect(existsSync(`${statePath}.tmp`)).toBe(false);
  });
});
