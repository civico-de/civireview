import { Octokit } from '@octokit/rest';
import type { ResolvedCiviReviewConfig } from '../config/schema.ts';
import { connectMcpClient, type ConnectedMcpHandle } from '../mcp/client.ts';
import { resolveMcpScope, type McpScopeResult } from '../mcp/scope.ts';
import type { CommitStatusInput } from './jenkins.ts';
import type { LinkedIssue, PrComment, PrMetadata } from './types.ts';

// The marker is its own last line of a posted review. Anchoring it to a line start ignores
// quote-replies (`> <!-- … -->`), and taking the last match ignores marker text quoted in prose.
const MARKER_RE = /^<!--[ \t]*civireview:v1[ \t]+([^>\n]+?)[ \t]*-->[ \t\r]*$/gm;
const LINKED_ISSUE_RE =
  /(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?|ref(?:erence)?s?)\s+(?:([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)?#(\d+)|https:\/\/github\.com\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\/issues\/(\d+))/gi;
const GITLAB_URL_RE =
  /https?:\/\/lab\.civicrm\.org\/([A-Za-z0-9_.-]+(?:\/(?!-\/(?:issues|work_items)\/)[A-Za-z0-9_.-]+){1,4})\/(?:-\/)?(?:issues|work_items)\/(\d+)/gi;
const GITLAB_SHORTHAND_RE =
  /(?:^|[\s([,:;])((?:dev|extensions|infra|docs)\/[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+){0,3})#(\d+)\b/gi;
const GITLAB_NAMESPACES = new Set(['dev', 'extensions', 'infra', 'docs']);
const SAFE_GITLAB_PROJECT_RE = /^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+){1,4}$/;

export interface ParsedCivireviewMarker {
  headSha?: string;
  baseSha?: string;
  reviewedAt?: string;
  triggerCommentId?: number;
}

/**
 * Extracts all `<!-- civireview:v1 ... -->` markers from PR comments/reviews in order.
 */
export function extractAllReviewedMarkers(
  comments: Array<{ body: string }>,
): ParsedCivireviewMarker[] {
  const markers: ParsedCivireviewMarker[] = [];
  for (const item of comments) {
    const body = item?.body ?? '';
    const match = [...body.matchAll(MARKER_RE)].at(-1);
    if (!match?.[1]) continue;
    const attrs: ParsedCivireviewMarker = {};
    for (const pair of match[1].split(/\s+/)) {
      const eq = pair.indexOf('=');
      if (eq === -1) continue;
      const key = pair.slice(0, eq).trim();
      const val = pair.slice(eq + 1).trim();
      if (key === 'head' || key === 'head_sha') attrs.headSha = val;
      if (key === 'base' || key === 'base_sha') attrs.baseSha = val;
      if (key === 'at') attrs.reviewedAt = val;
      if (key === 'trigger_comment') {
        const parsedId = Number(val);
        if (Number.isInteger(parsedId) && parsedId > 0) {
          attrs.triggerCommentId = parsedId;
        }
      }
    }
    if (attrs.headSha || attrs.baseSha || attrs.triggerCommentId) {
      markers.push(attrs);
    }
  }
  return markers;
}

/**
 * Extracts the latest `<!-- civireview:v1 head=... base=... -->` marker from PR comments.
 */
export function extractLastReviewedMarker(
  comments: Array<{ body: string }>,
): ParsedCivireviewMarker | undefined {
  const all = extractAllReviewedMarkers(comments);
  return all.length > 0 ? all[all.length - 1] : undefined;
}

/**
 * Resolves a GitHub token from `explicitToken`, `GITHUB_TOKEN`, or `gh auth token`.
 */
export async function resolveGitHubToken(explicitToken?: string): Promise<string | undefined> {
  if (explicitToken) return explicitToken;
  if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN;
  if (process.env.GH_TOKEN) return process.env.GH_TOKEN;

  try {
    const proc = Bun.spawn(['gh', 'auth', 'token'], {
      stdout: 'pipe',
      stderr: 'ignore',
    });
    const text = await new Response(proc.stdout).text();
    const code = await proc.exited;
    if (code === 0 && text.trim()) {
      return text.trim();
    }
  } catch {
    // gh CLI not installed or unauthenticated
  }
  return undefined;
}

export interface FetchGitHubPrOptions {
  owner: string;
  repo: string;
  prNumber: number;
  token?: string;
  incremental?: boolean;
  config?: ResolvedCiviReviewConfig;
  /** Injected client (tests); defaults to one authenticated with the resolved token. */
  octokit?: Octokit;
}

export interface GitHubPrContext {
  pr: PrMetadata;
  diffText: string;
  comments: PrComment[];
  statuses: CommitStatusInput[];
  linkedIssues: LinkedIssue[];
}

export function parseIssueRefs(
  text: string,
  defaultOwnerRepo: string,
): Array<{ owner: string; repo: string; number: number }> {
  const seen = new Set<string>();
  const refs: Array<{ owner: string; repo: string; number: number }> = [];

  for (const match of text.matchAll(LINKED_ISSUE_RE)) {
    const repoSlug = match[1] ?? match[3] ?? defaultOwnerRepo;
    const numStr = match[2] ?? match[4];
    if (!numStr) continue;
    const num = Number(numStr);
    if (!Number.isInteger(num) || num <= 0) continue;
    const [owner, repo] = repoSlug.split('/');
    if (!owner || !repo) continue;
    // Do not misroute CiviCRM GitLab shorthands (e.g. `Fixes dev/core#5842`) to GitHub.
    if (match[1] && GITLAB_NAMESPACES.has(owner.toLowerCase())) continue;
    const key = `${owner}/${repo}#${num}`;
    if (!seen.has(key)) {
      seen.add(key);
      refs.push({ owner, repo, number: num });
    }
  }
  return refs.slice(0, 5);
}

export interface GitLabIssueRef {
  projectPath: string;
  iid: number;
}

/**
 * Extracts linked CiviCRM GitLab (`lab.civicrm.org`) issue references from PR
 * titles, bodies, and comments (both full URLs and `dev/core#123` shorthands).
 * Strictly limited to `lab.civicrm.org` to prevent SSRF from untrusted PR text.
 */
export function parseGitLabIssueRefs(text: string): GitLabIssueRef[] {
  const seen = new Set<string>();
  const refs: GitLabIssueRef[] = [];

  const pushRef = (rawProject: string, rawIid: string) => {
    const projectPath = rawProject.replace(/\/+$/, '').replace(/\/-$/, '');
    const iid = Number(rawIid);
    if (!SAFE_GITLAB_PROJECT_RE.test(projectPath) || !Number.isInteger(iid) || iid <= 0) {
      return;
    }
    const key = `${projectPath.toLowerCase()}#${iid}`;
    if (!seen.has(key)) {
      seen.add(key);
      refs.push({ projectPath, iid });
    }
  };

  for (const match of text.matchAll(GITLAB_URL_RE)) {
    if (match[1] && match[2]) pushRef(match[1], match[2]);
  }
  for (const match of text.matchAll(GITLAB_SHORTHAND_RE)) {
    if (match[1] && match[2]) pushRef(match[1], match[2]);
  }

  return refs.slice(0, 5);
}

/**
 * Fetches a public (or token-accessible) issue and its human discussion notes
 * from CiviCRM's GitLab instance (`https://lab.civicrm.org`).
 */
export async function fetchGitLabIssue(
  ref: GitLabIssueRef,
  fetchImpl: typeof fetch = fetch,
): Promise<LinkedIssue | null> {
  if (!SAFE_GITLAB_PROJECT_RE.test(ref.projectPath) || ref.iid <= 0) {
    return null;
  }

  const encodedProject = encodeURIComponent(ref.projectPath);
  const baseUrl = `https://lab.civicrm.org/api/v4/projects/${encodedProject}/issues/${ref.iid}`;
  const headers: Record<string, string> = {
    Accept: 'application/json',
    // lab.civicrm.org's WAF rejects unrecognized user agents without "curl"
    'User-Agent': 'civireview/0.1 (like curl)',
  };
  const glToken = process.env.CIVICRM_GITLAB_TOKEN || process.env.GITLAB_TOKEN;
  if (glToken) {
    headers['PRIVATE-TOKEN'] = glToken;
  }

  try {
    const resp = await fetchImpl(baseUrl, {
      headers,
      signal: AbortSignal.timeout(8_000),
    });
    if (!resp.ok) return null;
    const data = (await resp.json()) as Record<string, unknown>;
    if (typeof data.title !== 'string') return null;

    const comments: Array<{ author: string; body: string; createdAt?: string }> = [];
    try {
      const notesResp = await fetchImpl(`${baseUrl}/notes?per_page=20&sort=asc`, {
        headers,
        signal: AbortSignal.timeout(8_000),
      });
      if (notesResp.ok) {
        const notes = (await notesResp.json()) as Array<Record<string, unknown>>;
        if (Array.isArray(notes)) {
          for (const note of notes) {
            if (note.system === true) continue;
            const body = typeof note.body === 'string' ? note.body.trim() : '';
            if (!body) continue;
            const authorObj = note.author as Record<string, unknown> | undefined;
            const author =
              typeof authorObj?.username === 'string'
                ? authorObj.username
                : typeof authorObj?.name === 'string'
                  ? authorObj.name
                  : 'unknown';
            comments.push({
              author,
              body: body.slice(0, 1500),
              createdAt: typeof note.created_at === 'string' ? note.created_at : undefined,
            });
            if (comments.length >= 10) break;
          }
        }
      }
    } catch {
      // Notes fetch is best-effort
    }

    const labels = Array.isArray(data.labels)
      ? data.labels.map((l) => String(l)).filter(Boolean)
      : undefined;

    return {
      number: ref.iid,
      repo: `lab.civicrm.org/${ref.projectPath}`,
      source: 'gitlab',
      title: data.title,
      body: typeof data.description === 'string' ? data.description.slice(0, 8000) : '',
      state: typeof data.state === 'string' ? data.state : 'unknown',
      url:
        typeof data.web_url === 'string'
          ? data.web_url
          : `https://lab.civicrm.org/${ref.projectPath}/-/issues/${ref.iid}`,
      ...(labels && labels.length > 0 ? { labels } : {}),
      ...(comments.length > 0 ? { comments } : {}),
    };
  } catch {
    return null;
  }
}

function extractMcpTextResult(raw: unknown): { text: string; isError: boolean } {
  if (!raw || typeof raw !== 'object') {
    return { text: typeof raw === 'string' ? raw : '', isError: false };
  }
  const obj = raw as Record<string, unknown>;
  const isError = obj.isError === true;
  if (Array.isArray(obj.content)) {
    const text = obj.content
      .map((part) =>
        part &&
        typeof part === 'object' &&
        typeof (part as Record<string, unknown>).text === 'string'
          ? String((part as Record<string, unknown>).text)
          : '',
      )
      .filter(Boolean)
      .join('\n');
    return { text, isError };
  }
  return { text: JSON.stringify(raw), isError };
}

/**
 * Parses a markdown document read from the `civicrm-knowledge` MCP public `lab`
 * archive (`lab/<project-slug>__<iid>.md`) into a structured `LinkedIssue`.
 */
export function parseLabArchiveMarkdown(markdown: string, ref: GitLabIssueRef): LinkedIssue | null {
  const trimmed = markdown.trim();
  if (!trimmed || /^Not in index:/i.test(trimmed)) return null;

  const lines = trimmed.split(/\r?\n/);
  let title = `${ref.projectPath}#${ref.iid}`;
  let idx = 0;
  if (lines[0]?.startsWith('# ')) {
    title = lines[0].slice(2).trim() || title;
    idx = 1;
  }

  let url = `https://lab.civicrm.org/${ref.projectPath}/-/issues/${ref.iid}`;
  let state = 'unknown';

  while (idx < lines.length && lines[idx]!.trim() === '') idx++;
  if (lines[idx] && /^https:\/\/lab\.civicrm\.org\//i.test(lines[idx]!.trim())) {
    url = lines[idx]!.trim();
    idx++;
  }
  if (lines[idx] && /^(?:opened|open|closed)\b/i.test(lines[idx]!.trim())) {
    const m = lines[idx]!.trim().match(/^(opened|open|closed)\b/i);
    if (m?.[1]) state = m[1].toLowerCase();
    idx++;
  }

  const rest = lines.slice(idx).join('\n').trim();
  const commentSplitRe = /^## Comment by ([^\n]+)\n/gm;
  const matches = Array.from(rest.matchAll(commentSplitRe));

  const body = (matches.length > 0 ? rest.slice(0, matches[0]!.index) : rest).trim().slice(0, 8000);

  const comments: Array<{ author: string; body: string }> = [];
  for (let i = 0; i < matches.length && comments.length < 10; i++) {
    const m = matches[i]!;
    const author = (m[1] ?? 'unknown').trim();
    const start = (m.index ?? 0) + m[0].length;
    const end = i + 1 < matches.length ? (matches[i + 1]!.index ?? rest.length) : rest.length;
    const cBody = rest.slice(start, end).trim().slice(0, 1500);
    if (cBody) {
      comments.push({ author, body: cBody });
    }
  }

  return {
    number: ref.iid,
    repo: `lab.civicrm.org/${ref.projectPath}`,
    source: 'gitlab',
    title,
    body,
    state,
    url,
    ...(comments.length > 0 ? { comments } : {}),
  };
}

/**
 * Fetches linked `lab.civicrm.org` issues via `civicrm-knowledge` MCP first
 * (live `civicrm_issue` on team scope, or archived public `lab/<slug>__<iid>.md`
 * including full human discussion comments on public/guest scope), falling back
 * to the direct `lab.civicrm.org` REST v4 API for brand-new/unindexed issues.
 */
export async function fetchGitLabIssues(
  refs: GitLabIssueRef[],
  options: {
    mcpScope?: McpScopeResult;
    connectMcp?: (scope: McpScopeResult) => Promise<ConnectedMcpHandle>;
    fetchImpl?: typeof fetch;
  } = {},
): Promise<LinkedIssue[]> {
  if (refs.length === 0) return [];

  const connect = options.connectMcp ?? connectMcpClient;
  const mcpHandle =
    options.mcpScope?.enabled && options.mcpScope.url ? await connect(options.mcpScope) : null;

  const results: LinkedIssue[] = [];
  try {
    const issueTool = mcpHandle?.tools?.civicrm_issue as
      | { execute?: (args: Record<string, unknown>) => Promise<unknown> }
      | undefined;
    const readTool = mcpHandle?.tools?.civicrm_read as
      | { execute?: (args: Record<string, unknown>) => Promise<unknown> }
      | undefined;

    for (const ref of refs) {
      let resolved: LinkedIssue | null = null;

      // 1. Live MCP `civicrm_issue` (team scope — uses server's LAB_TOKEN for fresh notes)
      if (issueTool?.execute) {
        try {
          const raw = await issueTool.execute({
            ref: `${ref.projectPath}#${ref.iid}`,
          });
          const { text, isError } = extractMcpTextResult(raw);
          if (!isError && text.trim().startsWith('{')) {
            const parsed = JSON.parse(text) as Record<string, unknown>;
            if (typeof parsed.title === 'string' && !parsed.error) {
              const rawComments = Array.isArray(parsed.comments)
                ? (parsed.comments as Array<Record<string, unknown>>)
                : [];
              const comments = rawComments
                .map((c) => ({
                  author: String(c.author ?? 'unknown'),
                  body: String(c.body ?? '')
                    .trim()
                    .slice(0, 1500),
                  createdAt: typeof c.created === 'string' ? c.created : undefined,
                }))
                .filter((c) => c.body.length > 0)
                .slice(0, 10);
              const labels = Array.isArray(parsed.labels)
                ? parsed.labels.map((l) => String(l)).filter(Boolean)
                : undefined;
              resolved = {
                number: ref.iid,
                repo: `lab.civicrm.org/${ref.projectPath}`,
                source: 'gitlab',
                title: parsed.title,
                body: typeof parsed.body === 'string' ? parsed.body.slice(0, 8000) : '',
                state: typeof parsed.state === 'string' ? parsed.state : 'unknown',
                url:
                  typeof parsed.url === 'string'
                    ? parsed.url
                    : `https://lab.civicrm.org/${ref.projectPath}/-/issues/${ref.iid}`,
                ...(labels && labels.length > 0 ? { labels } : {}),
                ...(comments.length > 0 ? { comments } : {}),
              };
            }
          }
        } catch {
          // Fall through to public lab archive / direct API
        }
      }

      // 2. Public MCP `lab` archive via `civicrm_read` (includes human discussion comments anonymously!)
      if (!resolved && readTool?.execute) {
        try {
          const slug = ref.projectPath.replaceAll('/', '-');
          const raw = await readTool.execute({
            path: `lab/${slug}__${ref.iid}.md`,
          });
          const { text, isError } = extractMcpTextResult(raw);
          if (!isError && text) {
            resolved = parseLabArchiveMarkdown(text, ref);
          }
        } catch {
          // Fall through to direct API
        }
      }

      // 3. Direct lab.civicrm.org REST v4 fallback (e.g. brand-new unarchived issue or MCP offline)
      if (!resolved) {
        resolved = await fetchGitLabIssue(ref, options.fetchImpl);
      }

      if (resolved) {
        results.push(resolved);
      }
    }
  } finally {
    await mcpHandle?.close();
  }

  return results;
}

const MAX_LIST_PAGES = 20;

/** Collects every page (100 items each, oldest first) so newer comments are never cut off. */
export async function fetchAllPages<T>(
  fetchPage: (page: number) => Promise<T[]>,
  maxPages = MAX_LIST_PAGES,
): Promise<T[]> {
  const all: T[] = [];
  for (let page = 1; page <= maxPages; page++) {
    const items = await fetchPage(page);
    all.push(...items);
    if (items.length < 100) return all;
  }
  throw new Error(`More than ${maxPages * 100} items; refusing to use a truncated list.`);
}

/**
 * Fetches PR metadata, diff (incremental delta if prior civireview marker exists),
 * comments/reviews, commit statuses, and linked GitHub issues.
 */
export async function fetchGitHubPrContext(
  options: FetchGitHubPrOptions,
): Promise<GitHubPrContext> {
  let octokit = options.octokit;
  if (!octokit) {
    const token = await resolveGitHubToken(options.token);
    octokit = new Octokit(token ? { auth: token } : {});
  }

  const { owner, repo, prNumber } = options;

  const [{ data: repoData }, { data: prData }] = await Promise.all([
    octokit.repos.get({ owner, repo }),
    octokit.pulls.get({ owner, repo, pull_number: prNumber }),
  ]);

  const [issueComments, reviewComments, reviews] = await Promise.all([
    fetchAllPages((page) =>
      octokit.issues
        .listComments({ owner, repo, issue_number: prNumber, per_page: 100, page })
        .then((r) => r.data),
    ),
    fetchAllPages((page) =>
      octokit.pulls
        .listReviewComments({ owner, repo, pull_number: prNumber, per_page: 100, page })
        .then((r) => r.data),
    ),
    fetchAllPages((page) =>
      octokit.pulls
        .listReviews({ owner, repo, pull_number: prNumber, per_page: 100, page })
        .then((r) => r.data),
    ),
  ]);

  const comments: PrComment[] = [
    ...issueComments.map((c) => ({
      id: c.id,
      author: c.user?.login ?? 'unknown',
      kind: 'issue_comment' as const,
      body: c.body ?? '',
      createdAt: c.created_at,
    })),
    ...reviewComments.map((c) => ({
      id: c.id,
      author: c.user?.login ?? 'unknown',
      kind: 'review_comment' as const,
      body: c.body ?? '',
      path: c.path,
      line: c.line ?? c.original_line ?? undefined,
      inReplyToId: c.in_reply_to_id ?? undefined,
      createdAt: c.created_at,
    })),
    ...reviews
      .filter((r) => (r.body ?? '').trim().length > 0)
      .map((r) => ({
        id: r.id,
        author: r.user?.login ?? 'unknown',
        kind: 'review' as const,
        body: `[${r.state}] ${r.body ?? ''}`,
        createdAt: r.submitted_at ?? '',
      })),
  ].toSorted((a, b) => a.createdAt.localeCompare(b.createdAt));

  const marker = extractLastReviewedMarker(comments);
  const lastReviewedHeadSha = marker?.headSha;

  let diffText = '';
  const sameBase = !marker?.baseSha || marker.baseSha === prData.base.sha;
  if (
    options.incremental &&
    lastReviewedHeadSha &&
    lastReviewedHeadSha !== prData.head.sha &&
    sameBase
  ) {
    try {
      // Only use an incremental delta on a clean fast-forward (`ahead`).
      // On force-push / rebase (`diverged` or `behind`), fall back to the full PR diff
      // so unrelated base-branch commits are never pulled into the diff.
      const { data: compareMeta } = await octokit.repos.compareCommitsWithBasehead({
        owner,
        repo,
        basehead: `${lastReviewedHeadSha}...${prData.head.sha}`,
      });
      if (compareMeta.status === 'ahead') {
        const compareResp = await octokit.repos.compareCommitsWithBasehead({
          owner,
          repo,
          basehead: `${lastReviewedHeadSha}...${prData.head.sha}`,
          mediaType: { format: 'diff' },
        });
        diffText =
          typeof compareResp.data === 'string' ? compareResp.data : String(compareResp.data);
      }
    } catch {
      // Fallback to full PR diff if force-push invalidated lastReviewedHeadSha
    }
  }

  if (!diffText) {
    const diffResp = await octokit.pulls.get({
      owner,
      repo,
      pull_number: prNumber,
      mediaType: { format: 'diff' },
    });
    diffText = typeof diffResp.data === 'string' ? diffResp.data : String(diffResp.data);
  }

  const statuses: CommitStatusInput[] = [];
  try {
    const { data: combined } = await octokit.repos.getCombinedStatusForRef({
      owner,
      repo,
      ref: prData.head.sha,
    });
    for (const s of combined.statuses) {
      statuses.push({
        context: s.context,
        state: s.state,
        targetUrl: s.target_url,
        description: s.description,
      });
    }
  } catch {
    // Ignore status errors
  }

  try {
    const { data: checkRuns } = await octokit.checks.listForRef({
      owner,
      repo,
      ref: prData.head.sha,
      per_page: 100,
    });
    for (const cr of checkRuns.check_runs) {
      const state =
        cr.status !== 'completed'
          ? 'pending'
          : cr.conclusion === 'success' ||
              cr.conclusion === 'neutral' ||
              cr.conclusion === 'skipped'
            ? 'success'
            : 'failure';
      statuses.push({
        context: cr.name,
        state,
        targetUrl: cr.html_url ?? undefined,
        description: cr.output?.title ?? cr.conclusion ?? undefined,
      });
    }
  } catch {
    // Ignore check-runs permission errors on public tokens
  }

  const issueSearchCorpus = [prData.title, prData.body ?? '', ...comments.map((c) => c.body)].join(
    '\n',
  );

  const linkedRefs = parseIssueRefs(issueSearchCorpus, `${owner}/${repo}`);
  const linkedGitLabRefs = parseGitLabIssueRefs(issueSearchCorpus);
  const linkedIssues: LinkedIssue[] = [];

  for (const ref of linkedRefs) {
    try {
      const { data: issue } = await octokit.issues.get({
        owner: ref.owner,
        repo: ref.repo,
        issue_number: ref.number,
      });
      let ghIssueComments: Array<{ author: string; body: string; createdAt?: string }> | undefined;
      try {
        const { data: rawComments } = await octokit.issues.listComments({
          owner: ref.owner,
          repo: ref.repo,
          issue_number: ref.number,
          per_page: 10,
        });
        if (rawComments.length > 0) {
          ghIssueComments = rawComments
            .map((c) => ({
              author: c.user?.login ?? 'unknown',
              body: (c.body ?? '').trim().slice(0, 1500),
              createdAt: c.created_at,
            }))
            .filter((c) => c.body.length > 0);
        }
      } catch {
        // Best-effort issue comments fetch
      }
      const issueLabels = (issue.labels ?? [])
        .map((l) => (typeof l === 'string' ? l : (l.name ?? '')))
        .filter(Boolean);
      linkedIssues.push({
        number: issue.number,
        repo: `${ref.owner}/${ref.repo}`,
        source: 'github',
        title: issue.title,
        body: (issue.body ?? '').slice(0, 8000),
        state: issue.state,
        url: issue.html_url,
        ...(issueLabels.length > 0 ? { labels: issueLabels } : {}),
        ...(ghIssueComments && ghIssueComments.length > 0 ? { comments: ghIssueComments } : {}),
      });
    } catch {
      // Issue may be in a private repo or deleted
    }
  }

  if (linkedGitLabRefs.length > 0) {
    const mcpScope = options.config
      ? resolveMcpScope({
          isPrivateRepo: Boolean(repoData.private),
          config: options.config,
        })
      : undefined;
    const glResults = await fetchGitLabIssues(linkedGitLabRefs, { mcpScope });
    linkedIssues.push(...glResults);
  }

  const labels = (prData.labels ?? [])
    .map((l) => (typeof l === 'string' ? l : (l.name ?? '')))
    .filter(Boolean);

  return {
    pr: {
      repo: `${owner}/${repo}`,
      isPrivateRepo: Boolean(repoData.private),
      prNumber,
      title: prData.title,
      body: prData.body ?? '',
      author: prData.user?.login ?? 'unknown',
      baseBranch: prData.base.ref,
      headBranch: prData.head.ref,
      baseSha: prData.base.sha,
      headSha: prData.head.sha,
      lastReviewedHeadSha,
      labels,
      draft: Boolean(prData.draft),
      state: prData.state,
      merged: Boolean(prData.merged),
      url: prData.html_url,
    },
    diffText,
    comments,
    statuses,
    linkedIssues,
  };
}
