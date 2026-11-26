import { describe, expect, test } from 'bun:test';
import {
  fetchGitLabIssue,
  fetchGitLabIssues,
  parseGitLabIssueRefs,
  parseIssueRefs,
  parseLabArchiveMarkdown,
} from '../src/evidence/github.ts';
import type { EvidenceBundle } from '../src/evidence/types.ts';
import type { ConnectedMcpHandle } from '../src/mcp/client.ts';
import { buildSharedEvidencePrefix } from '../src/prompts/shared.ts';

describe('GitLab (lab.civicrm.org) & GitHub linked issue extraction', () => {
  test('parseGitLabIssueRefs extracts lab.civicrm.org URLs and CiviCRM shorthands while ignoring external hosts', () => {
    const text = [
      'Fixes https://lab.civicrm.org/dev/core/-/issues/5842',
      'Work item URL: https://lab.civicrm.org/dev/core/-/work_items/5000',
      'Also see https://lab.civicrm.org/dev/financial/issues/123 and dev/core#5842 (dup)',
      'Extension context: extensions/afform#45 and dev/user-interface#99',
      'Evil SSRF attempt: https://evil.example.com/dev/core/-/issues/999',
    ].join('\n');

    const glRefs = parseGitLabIssueRefs(text);
    expect(glRefs).toEqual([
      { projectPath: 'dev/core', iid: 5842 },
      { projectPath: 'dev/core', iid: 5000 },
      { projectPath: 'dev/financial', iid: 123 },
      { projectPath: 'extensions/afform', iid: 45 },
      { projectPath: 'dev/user-interface', iid: 99 },
    ]);

    // Ensure GitHub parser does not misroute `Fixes dev/core#5842` to github.com/dev/core
    const ghRefs = parseIssueRefs(
      'Fixes dev/core#5842, Closes #77, Refs https://github.com/civicrm/civicrm-core/issues/88',
      'civicrm/civicrm-core',
    );
    expect(ghRefs).toEqual([
      { owner: 'civicrm', repo: 'civicrm-core', number: 77 },
      { owner: 'civicrm', repo: 'civicrm-core', number: 88 },
    ]);
  });

  test('fetchGitLabIssue leaves the token out for a public PR', async () => {
    const sent: Array<string | null> = [];
    const mockFetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      sent.push(new Headers(init?.headers).get('PRIVATE-TOKEN'));
      return new Response(
        JSON.stringify({ iid: 1, title: 't', description: '', state: 'opened', web_url: 'u' }),
        {
          status: 200,
        },
      );
    }) as unknown as typeof fetch;
    const saved = process.env.GITLAB_TOKEN;
    process.env.GITLAB_TOKEN = 'lab-token';
    try {
      await fetchGitLabIssue({ projectPath: 'dev/core', iid: 1 }, mockFetch);
      await fetchGitLabIssue({ projectPath: 'dev/core', iid: 1 }, mockFetch, true);
    } finally {
      if (saved === undefined) delete process.env.GITLAB_TOKEN;
      else process.env.GITLAB_TOKEN = saved;
    }
    expect(sent).toEqual(['lab-token', 'lab-token', null, null]);
  });

  test('fetchGitLabIssue retrieves issue metadata and filters out system notes', async () => {
    const calls: string[] = [];
    const mockFetch = (async (url: string | URL | Request) => {
      const u = String(url);
      calls.push(u);
      if (u.endsWith('/notes?per_page=20&sort=asc')) {
        return new Response(
          JSON.stringify([
            {
              system: true,
              body: 'added ~bug label',
              author: { username: 'bot' },
              created_at: '2026-11-01T10:00:00Z',
            },
            {
              system: false,
              body: 'Repro steps: submit optional Activity block with this.day default.',
              author: { username: 'colemanw' },
              created_at: '2026-11-01T11:00:00Z',
            },
          ]),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      return new Response(
        JSON.stringify({
          iid: 5842,
          title: 'Afform swallows save errors',
          description: 'Detailed bug description from GitLab.',
          state: 'opened',
          labels: ['bug', 'afform'],
          web_url: 'https://lab.civicrm.org/dev/core/-/issues/5842',
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }) as unknown as typeof fetch;

    const issue = await fetchGitLabIssue({ projectPath: 'dev/core', iid: 5842 }, mockFetch);

    expect(calls[0]).toBe('https://lab.civicrm.org/api/v4/projects/dev%2Fcore/issues/5842');
    expect(issue).toEqual({
      number: 5842,
      repo: 'lab.civicrm.org/dev/core',
      source: 'gitlab',
      title: 'Afform swallows save errors',
      body: 'Detailed bug description from GitLab.',
      state: 'opened',
      url: 'https://lab.civicrm.org/dev/core/-/issues/5842',
      labels: ['bug', 'afform'],
      comments: [
        {
          author: 'colemanw',
          body: 'Repro steps: submit optional Activity block with this.day default.',
          createdAt: '2026-11-01T11:00:00Z',
        },
      ],
    });

    // Verify shared prompt embeds GitLab issue + discussion safely inside <untrusted_pr_data>
    const bundle: EvidenceBundle = {
      schemaVersion: '1',
      collectedAt: '2026-11-22T22:00:00Z',
      repoInfo: {
        kind: 'civicrm-core',
        root: '/tmp/core',
        recommendedImage: 'standalone-master',
      },
      pr: {
        repo: 'civicrm/civicrm-core',
        isPrivateRepo: false,
        prNumber: 38196,
        title: 'Fix Afform',
        body: 'Closes dev/core#5842',
        author: 'alice',
        baseBranch: 'master',
        headBranch: 'fix',
        baseSha: 'aaaaaaa',
        headSha: 'bbbbbbb',
        labels: [],
        draft: false,
      },
      comments: [],
      linkedIssues: [issue!],
      diffFiles: [],
      droppedNoiseFiles: [],
      diffTruncated: false,
      abReport: {
        executed: false,
        imageA: 'standalone-master',
        imageB: 'standalone-master',
        checks: [],
        surfaceDiff: {
          changes: [],
          unverifiedSurfaces: [],
          touchedComponents: [],
          summary: 'None',
        },
        demoConsoleErrors: [],
        cmsDemos: [],
        notVerified: [],
      },
      staticDelta: {
        executed: false,
        toolsRun: [],
        findings: [],
        summary: 'None',
      },
      ciStatus: {
        overallState: 'success',
        checks: [],
        jenkinsFailedTests: [],
        summary: 'Pass',
      },
      notVerified: [],
    };
    const prefix = buildSharedEvidencePrefix(bundle, '');
    expect(prefix).toContain('<untrusted_pr_data section="linked_issues">');
    expect(prefix).toContain('[GitLab] Issue lab.civicrm.org/dev/core#5842');
    expect(prefix).toContain('@colemanw: Repro steps');
  });

  test('fetchGitLabIssues prefers MCP (live civicrm_issue or public lab archive) and falls back to REST API', async () => {
    const sampleArchiveMd = [
      '# SearchKit: Allow formatting of the totals in the footer',
      '',
      'https://lab.civicrm.org/dev/core/-/work_items/5000',
      'closed · created 2024-02-12',
      '',
      'SearchKit allows creating a footer row.',
      '',
      '## Comment by colemanw',
      '',
      'Formatting works now, PR #31649.',
    ].join('\n');

    const parsedMd = parseLabArchiveMarkdown(sampleArchiveMd, {
      projectPath: 'dev/core',
      iid: 5000,
    });
    expect(parsedMd?.title).toBe('SearchKit: Allow formatting of the totals in the footer');
    expect(parsedMd?.state).toBe('closed');
    expect(parsedMd?.comments).toEqual([
      { author: 'colemanw', body: 'Formatting works now, PR #31649.' },
    ]);

    let closed = false;
    let restCalled = 0;
    const mockConnect = async (): Promise<ConnectedMcpHandle> => ({
      client: null,
      tools: {
        civicrm_read: {
          execute: async (args: Record<string, unknown>) => {
            if (args.path === 'lab/dev-core__5000.md') {
              return { content: [{ type: 'text', text: sampleArchiveMd }] };
            }
            return {
              content: [{ type: 'text', text: 'Not in index: lab/dev-core__9999.md' }],
              isError: true,
            };
          },
        },
      } as unknown as ConnectedMcpHandle['tools'],
      close: async () => {
        closed = true;
      },
    });
    const mockFetch = (async () => {
      restCalled++;
      return new Response(
        JSON.stringify({
          title: 'Brand new unindexed issue',
          description: 'Freshly filed.',
          state: 'opened',
          web_url: 'https://lab.civicrm.org/dev/core/-/issues/9999',
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }) as unknown as typeof fetch;

    const issues = await fetchGitLabIssues(
      [
        { projectPath: 'dev/core', iid: 5000 },
        { projectPath: 'dev/core', iid: 9999 },
      ],
      {
        mcpScope: {
          enabled: true,
          mode: 'public',
          url: 'https://mcp.civico.de/mcp',
          token: null,
          headers: {},
        },
        connectMcp: mockConnect,
        fetchImpl: mockFetch,
      },
    );

    expect(closed).toBe(true);
    expect(issues).toHaveLength(2);
    expect(issues[0]!.comments?.[0]?.author).toBe('colemanw');
    expect(issues[1]!.title).toBe('Brand new unindexed issue');
    expect(restCalled).toBeGreaterThanOrEqual(1);
  });
});
