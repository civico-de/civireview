import type { Octokit } from '@octokit/rest';
import { describe, expect, test } from 'bun:test';
import {
  extractAllReviewedMarkers,
  extractLastReviewedMarker,
  fetchGitHubPrContext,
} from '../src/evidence/github.ts';

const HEAD = 'h'.repeat(40);
const BASE = 'b'.repeat(40);
const OLD_HEAD = 'o'.repeat(40);

interface FakeOptions {
  issueComments?: Array<{ id: number; body: string; created_at: string }>;
  compareStatus?: 'ahead' | 'diverged';
  checkRuns?: Array<{ name: string; status: string; conclusion: string | null }>;
}

function makeFakeOctokit(opts: FakeOptions = {}) {
  const calls: string[] = [];
  const user = { login: 'someone' };
  const fake = {
    repos: {
      async get() {
        return { data: { private: false } };
      },
      async compareCommitsWithBasehead(params: { mediaType?: unknown }) {
        calls.push(params.mediaType ? 'compare:diff' : 'compare:meta');
        return params.mediaType
          ? { data: 'DELTA-DIFF' }
          : { data: { status: opts.compareStatus ?? 'ahead' } };
      },
      async getCombinedStatusForRef() {
        return { data: { statuses: [] } };
      },
    },
    pulls: {
      async get(params: { mediaType?: unknown }) {
        if (params.mediaType) {
          calls.push('pull:diff');
          return { data: 'FULL-DIFF' };
        }
        return {
          data: {
            title: 'Fix it',
            body: 'Fixes #12',
            user,
            base: { ref: 'master', sha: BASE },
            head: { ref: 'fix', sha: HEAD },
            labels: [],
            draft: false,
            state: 'open',
            merged: false,
            html_url: 'https://github.com/o/r/pull/1',
          },
        };
      },
      async listReviewComments() {
        return { data: [] };
      },
      async listReviews() {
        return { data: [] };
      },
    },
    issues: {
      async listComments(params: { page?: number; per_page?: number; issue_number: number }) {
        if (params.issue_number !== 1) return { data: [] }; // linked issue
        const all = opts.issueComments ?? [];
        const page = params.page ?? 1;
        const start = (page - 1) * 100;
        calls.push(`issueComments:page${page}`);
        return { data: all.slice(start, start + 100).map((c) => ({ ...c, user })) };
      },
      async get() {
        return {
          data: {
            number: 12,
            title: 'Linked',
            body: 'b',
            state: 'open',
            html_url: 'u',
            labels: ['bug'],
          },
        };
      },
    },
    checks: {
      async listForRef() {
        return { data: { check_runs: opts.checkRuns ?? [] } };
      },
    },
  };
  return { octokit: fake as unknown as Octokit, calls };
}

function marker(head: string, extra = ''): string {
  return `Review text\n\n---\n<!-- civireview:v1 head_sha=${head} base_sha=${BASE} preset=sonnet score=4/5${extra} -->`;
}

function fetchContext(octokit: Octokit, incremental = false) {
  return fetchGitHubPrContext({ owner: 'o', repo: 'r', prNumber: 1, octokit, incremental });
}

describe('fetchGitHubPrContext', () => {
  test('reads every comment page so a marker or question past the first 100 is not lost', async () => {
    const comments = Array.from({ length: 230 }, (_, i) => ({
      id: i + 1,
      body: i === 205 ? marker(OLD_HEAD) : `comment ${i + 1}`,
      created_at: `2026-11-01T00:${String(Math.floor(i / 60)).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}Z`,
    }));
    const { octokit, calls } = makeFakeOctokit({ issueComments: comments });

    const ctx = await fetchContext(octokit);

    expect(ctx.comments).toHaveLength(230);
    expect(ctx.comments.at(-1)?.body).toBe('comment 230');
    expect(ctx.pr.lastReviewedHeadSha).toBe(OLD_HEAD);
    expect(calls.filter((c) => c.startsWith('issueComments:'))).toEqual([
      'issueComments:page1',
      'issueComments:page2',
      'issueComments:page3',
    ]);
  });

  test('uses the incremental delta only for a clean fast-forward', async () => {
    const comments = [{ id: 1, body: marker(OLD_HEAD), created_at: '2026-11-01T00:00:00Z' }];

    const ahead = makeFakeOctokit({ issueComments: comments, compareStatus: 'ahead' });
    const aheadContext = await fetchContext(ahead.octokit, true);
    expect(aheadContext.diffText).toBe('DELTA-DIFF');
    expect(aheadContext.fullDiffText).toBe('FULL-DIFF');

    const diverged = makeFakeOctokit({ issueComments: comments, compareStatus: 'diverged' });
    expect((await fetchContext(diverged.octokit, true)).diffText).toBe('FULL-DIFF');

    const notIncremental = makeFakeOctokit({ issueComments: comments });
    expect((await fetchContext(notIncremental.octokit, false)).diffText).toBe('FULL-DIFF');
  });

  test('maps check runs to pass / pending / fail and keeps PR metadata and linked issues', async () => {
    const { octokit } = makeFakeOctokit({
      checkRuns: [
        { name: 'lint', status: 'completed', conclusion: 'success' },
        { name: 'optional', status: 'completed', conclusion: 'neutral' },
        { name: 'build', status: 'in_progress', conclusion: null },
        { name: 'tests', status: 'completed', conclusion: 'failure' },
      ],
    });

    const ctx = await fetchContext(octokit);

    expect(Object.fromEntries(ctx.statuses.map((s) => [s.context, s.state]))).toEqual({
      lint: 'success',
      optional: 'success',
      build: 'pending',
      tests: 'failure',
    });
    expect(ctx.pr).toMatchObject({
      repo: 'o/r',
      headSha: HEAD,
      baseSha: BASE,
      baseBranch: 'master',
      state: 'open',
      isPrivateRepo: false,
    });
    expect(ctx.linkedIssues.map((i) => i.number)).toEqual([12]);
  });
});

describe('civireview marker parsing', () => {
  test('reads head, base and trigger comment from a posted review body', () => {
    const [m] = extractAllReviewedMarkers([{ body: marker(HEAD, ' trigger_comment=42') }]);
    expect(m).toEqual({ headSha: HEAD, baseSha: BASE, triggerCommentId: 42 });
  });

  test('ignores a quote-reply of a review and accepts CRLF line endings', () => {
    const quoted = `> Review text\n> <!-- civireview:v1 head_sha=${OLD_HEAD} base_sha=${BASE} -->\n\nThanks!`;
    expect(extractAllReviewedMarkers([{ body: quoted }])).toEqual([]);

    const crlf = marker(HEAD).replaceAll('\n', '\r\n');
    expect(extractLastReviewedMarker([{ body: crlf }])?.headSha).toBe(HEAD);
  });

  test('takes the marker at the end of the body, not marker text quoted in the prose', () => {
    const body = `Finding mentions \`<!-- civireview:v1 head_sha=${OLD_HEAD} -->\` inline.\n\n${marker(HEAD)}`;
    expect(extractLastReviewedMarker([{ body }])?.headSha).toBe(HEAD);

    const prose = `see <!-- civireview:v1 head_sha=${OLD_HEAD} --> in the diff`;
    expect(extractAllReviewedMarkers([{ body: prose }])).toEqual([]);
  });

  test('orders markers as given so the last review wins', () => {
    const last = extractLastReviewedMarker([{ body: marker(OLD_HEAD) }, { body: marker(HEAD) }]);
    expect(last?.headSha).toBe(HEAD);
  });

  test('with a trusted login a marker posted by anyone else is ignored', () => {
    const comments = [
      { body: marker(OLD_HEAD), author: 'Reviewer-Bot' },
      { body: marker(HEAD), author: 'contributor' },
    ];
    expect(extractLastReviewedMarker(comments, 'reviewer-bot')?.headSha).toBe(OLD_HEAD);
    expect(extractLastReviewedMarker(comments)?.headSha).toBe(HEAD);
  });
});
