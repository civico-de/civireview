import { basename } from 'node:path';
import { Octokit } from '@octokit/rest';
import { parseGitLabIssueRefs } from './github.ts';
import type {
  CandidateRelatedIssue,
  CandidateRelatedPr,
  DiffFile,
  LinkedIssue,
  RepoKind,
} from './types.ts';

const STOPWORDS = new Set([
  'the',
  'and',
  'for',
  'with',
  'from',
  'that',
  'this',
  'when',
  'into',
  'only',
  'not',
  'are',
  'was',
  'were',
  'has',
  'have',
  'had',
  'can',
  'cannot',
  'cant',
  'does',
  'dont',
  'fix',
  'fixes',
  'fixed',
  'add',
  'adds',
  'added',
  'update',
  'updates',
  'updated',
  'make',
  'makes',
  'use',
  'uses',
  'using',
  'ensure',
  'allow',
  'avoid',
  'prevent',
  'handle',
  'check',
  'test',
  'tests',
  'core',
  'dev',
  'civicrm',
  'php',
  'html',
  'json',
  'tpl',
  'xml',
]);

export interface RelatedPrOctokit {
  rest: {
    pulls: {
      list(params: {
        owner: string;
        repo: string;
        state: 'open';
        sort: 'updated';
        direction: 'desc';
        per_page: number;
      }): Promise<{
        data: Array<{
          number: number;
          title: string;
          body?: string | null;
          html_url: string;
          draft?: boolean;
          base?: { ref?: string | null } | null;
          user?: { login?: string | null } | null;
        }>;
      }>;
      listFiles(params: {
        owner: string;
        repo: string;
        pull_number: number;
        per_page: number;
      }): Promise<{
        data: Array<{ filename: string }>;
      }>;
    };
  };
}

/**
 * Extracts normalized CiviCRM component prefix (e.g. `Afform - ...` -> `afform`)
 * if present in a PR title.
 */
export function extractComponentPrefix(title: string): string | undefined {
  const cleaned = title.replace(/\bdev\/[a-z0-9_-]+#\d+\b/gi, '').trim();
  const match = cleaned.match(/^([A-Za-z][A-Za-z0-9_ ]{1,24}?)\s*(?:[-–—:]|\s-\s)/);
  if (!match?.[1]) return undefined;
  const norm = match[1].trim().toLowerCase();
  if (norm.length < 2 || STOPWORDS.has(norm)) return undefined;
  return norm;
}

/**
 * Extracts significant domain keywords from a PR title and touched file basenames.
 */
export function extractPrKeywords(title: string, diffFiles: DiffFile[]): string[] {
  const tokens = new Set<string>();
  const addWords = (text: string) => {
    const cleaned = text.replace(/\bdev\/[a-z0-9_-]+#\d+\b/gi, ' ');
    for (const raw of cleaned.split(/[^A-Za-z0-9_]+/)) {
      const w = raw.toLowerCase();
      if (w.length >= 3 && !STOPWORDS.has(w) && !/^\d+$/.test(w)) {
        tokens.add(w);
      }
    }
  };
  addWords(title);
  for (const f of diffFiles.slice(0, 12)) {
    if (f.flags.isTest) continue;
    const base = basename(f.path).replace(/\.[^.]+$/, '');
    // Split CamelCase identifiers into words as well as keeping the full token
    const splitCamel = base.replace(/([a-z])([A-Z])/g, '$1 $2');
    addWords(splitCamel);
    if (base.length >= 4 && !STOPWORDS.has(base.toLowerCase())) {
      tokens.add(base.toLowerCase());
    }
  }
  return Array.from(tokens);
}

function extractIssueRefSet(text: string, linkedIssues?: LinkedIssue[]): Set<string> {
  const refs = new Set<string>();
  for (const r of parseGitLabIssueRefs(text)) {
    refs.add(`${r.projectPath.toLowerCase()}#${r.iid}`);
  }
  for (const iss of linkedIssues ?? []) {
    refs.add(`${iss.repo.toLowerCase()}#${iss.number}`);
  }
  return refs;
}

export interface CollectRelatedOpenPrsOptions {
  owner: string;
  repo: string;
  prNumber: number;
  prTitle: string;
  prBody: string;
  prAuthor?: string;
  baseBranch?: string;
  repoRoot?: string;
  baseSha?: string;
  headSha?: string;
  diffFiles: DiffFile[];
  linkedIssues: LinkedIssue[];
  token?: string;
  octokit?: RelatedPrOctokit;
  maxCandidates?: number;
  gitExec?: (args: string[]) => Promise<{ exitCode: number; stdout: string; stderr: string }>;
}

async function defaultGitExec(
  args: string[],
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(['git', ...args], {
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const timer = setTimeout(() => {
    try {
      proc.kill();
    } catch {
      // ignore kill error
    }
  }, 15_000);
  try {
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { exitCode, stdout, stderr };
  } finally {
    clearTimeout(timer);
  }
}

export function parseMergeTreeConflicts(stdout: string): string[] {
  const files = new Set<string>();
  for (const line of stdout.split(/\r?\n/)) {
    const match = line.match(/^CONFLICT \([^)]*\): Merge conflict in (.+)$/);
    if (match?.[1]) {
      files.add(match[1].trim());
    }
  }
  return Array.from(files);
}

/**
 * Deterministically tests whether overlapping open PRs on the same base branch
 * have real textual merge conflicts using `git merge-tree --write-tree`
 * (read-only, no working-tree modifications). Always fails soft.
 */
export async function checkRelatedPrMergeConflicts(params: {
  repoRoot: string;
  baseSha: string;
  headSha: string;
  baseBranch?: string;
  candidates: CandidateRelatedPr[];
  gitExec?: (args: string[]) => Promise<{ exitCode: number; stdout: string; stderr: string }>;
}): Promise<CandidateRelatedPr[]> {
  const gitExec = params.gitExec ?? defaultGitExec;
  const currentBase = params.baseBranch?.toLowerCase();
  const toCheck = params.candidates
    .filter((c) => {
      if (c.overlappingFiles.length === 0) return false;
      if (currentBase && c.baseBranch && c.baseBranch.toLowerCase() !== currentBase) {
        return false;
      }
      return true;
    })
    .slice(0, 4);

  if (toCheck.length === 0) return params.candidates;

  const refSpecs = toCheck.map(
    (c) => `pull/${c.number}/head:refs/civireview/related-pr-${c.number}`,
  );
  const fetchRes = await gitExec([
    '-C',
    params.repoRoot,
    'fetch',
    '--no-tags',
    'origin',
    ...refSpecs,
  ]);
  if (fetchRes.exitCode !== 0) {
    return params.candidates;
  }

  const results = new Map<
    number,
    { mergeConflict: 'conflicts' | 'clean'; conflictingFiles?: string[] }
  >();
  for (const c of toCheck) {
    const otherRef = `refs/civireview/related-pr-${c.number}`;
    const overlapSet = new Set(c.overlappingFiles);
    const res = await gitExec([
      '-C',
      params.repoRoot,
      'merge-tree',
      '--write-tree',
      params.headSha,
      otherRef,
    ]);
    if (res.exitCode === 0) {
      results.set(c.number, { mergeConflict: 'clean' });
    } else if (res.exitCode === 1) {
      // Only count conflicts in files that BOTH PRs actually modified; conflicts
      // in non-overlapping files are caused by base-branch history drift when one
      // PR was branched from an older commit on master.
      const files = parseMergeTreeConflicts(res.stdout).filter((f) => overlapSet.has(f));
      if (files.length > 0) {
        results.set(c.number, {
          mergeConflict: 'conflicts',
          conflictingFiles: files.slice(0, 8),
        });
      } else {
        results.set(c.number, { mergeConflict: 'clean' });
      }
    }
  }

  return params.candidates.map((c) => {
    const found = results.get(c.number);
    if (!found) return c;
    return {
      ...c,
      mergeConflict: found.mergeConflict,
      ...(found.conflictingFiles ? { conflictingFiles: found.conflictingFiles } : {}),
    };
  });
}

/**
 * Deterministically discovers open PRs in the same repo that overlap on files,
 * share a linked issue ref, or strongly match title/component keywords.
 * Always fails soft (returns `[]`) so API errors never block a review.
 */
export async function collectRelatedOpenPrs(
  options: CollectRelatedOpenPrsOptions,
): Promise<CandidateRelatedPr[]> {
  const maxCandidates = options.maxCandidates ?? 8;
  const octokit: RelatedPrOctokit =
    options.octokit ??
    (new Octokit({
      auth: options.token ?? process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN,
    }) as unknown as RelatedPrOctokit);

  try {
    const { data: openPrs } = await octokit.rest.pulls.list({
      owner: options.owner,
      repo: options.repo,
      state: 'open',
      sort: 'updated',
      direction: 'desc',
      per_page: 100,
    });

    const currentFiles = new Set(options.diffFiles.map((f) => f.path));
    const currentComponent = extractComponentPrefix(options.prTitle);
    const currentKeywords = new Set(extractPrKeywords(options.prTitle, options.diffFiles));
    const currentRefs = extractIssueRefSet(
      `${options.prTitle}\n${options.prBody}`,
      options.linkedIssues,
    );

    const currentAuthor = options.prAuthor?.toLowerCase();
    const currentBase = options.baseBranch?.toLowerCase();
    const currentTitleNorm = options.prTitle.trim().toLowerCase();

    const preScored = openPrs
      .filter((p) => {
        if (p.number === options.prNumber) return false;
        // Skip routine same-author release-branch backport pairs (e.g. 6.20 vs 6.21 vs master)
        const pBase = p.base?.ref?.toLowerCase();
        const pAuthor = p.user?.login?.toLowerCase();
        if (
          currentBase &&
          pBase &&
          pBase !== currentBase &&
          currentAuthor &&
          pAuthor === currentAuthor
        ) {
          const pRefs = extractIssueRefSet(`${p.title}\n${p.body ?? ''}`);
          const sharesIssue = Array.from(pRefs).some((r) => currentRefs.has(r));
          if (p.title.trim().toLowerCase() === currentTitleNorm || sharesIssue) {
            return false;
          }
        }
        return true;
      })
      .map((p) => {
        const pComponent = extractComponentPrefix(p.title);
        const pRefs = extractIssueRefSet(`${p.title}\n${p.body ?? ''}`);
        const sharedIssueRefs = Array.from(pRefs).filter((r) => currentRefs.has(r));

        const pText = `${p.title} ${(p.body ?? '').slice(0, 400)}`.toLowerCase();
        let kwHits = 0;
        for (const kw of currentKeywords) {
          if (pText.includes(kw)) kwHits++;
        }

        let score = sharedIssueRefs.length * 100 + kwHits * 6;
        if (currentComponent && pComponent && currentComponent === pComponent) {
          score += 20;
        }
        return { pr: p, score, sharedIssueRefs };
      })
      .filter((item) => item.score >= 12)
      .toSorted((a, b) => b.score - a.score)
      .slice(0, 10);

    if (preScored.length === 0) return [];

    // Fetch changed file lists for top 10 pre-scored candidates in parallel to detect exact file conflicts
    const enriched = await Promise.all(
      preScored.map(async (item) => {
        let overlappingFiles: string[] = [];
        try {
          const { data: files } = await octokit.rest.pulls.listFiles({
            owner: options.owner,
            repo: options.repo,
            pull_number: item.pr.number,
            per_page: 50,
          });
          overlappingFiles = files
            .map((f) => f.filename)
            .filter((name) => currentFiles.has(name))
            .slice(0, 8);
        } catch {
          // Ignore per-PR file list failures
        }
        const finalScore =
          item.score + (overlappingFiles.length > 0 ? 50 + overlappingFiles.length * 15 : 0);
        return {
          ...item,
          overlappingFiles,
          finalScore,
        };
      }),
    );

    const candidates: CandidateRelatedPr[] = enriched
      .filter(
        (e) => e.overlappingFiles.length > 0 || e.sharedIssueRefs.length > 0 || e.finalScore >= 24,
      )
      .toSorted((a, b) => b.finalScore - a.finalScore)
      .slice(0, maxCandidates)
      .map((e) => ({
        number: e.pr.number,
        title: e.pr.title,
        author: e.pr.user?.login ?? 'unknown',
        ...(e.pr.base?.ref ? { baseBranch: e.pr.base.ref } : {}),
        url: e.pr.html_url,
        overlappingFiles: e.overlappingFiles,
        sharedIssueRefs: e.sharedIssueRefs,
        ...(e.pr.draft ? { draft: true } : {}),
      }));

    if (options.repoRoot && options.baseSha && options.headSha) {
      return await checkRelatedPrMergeConflicts({
        repoRoot: options.repoRoot,
        baseSha: options.baseSha,
        headSha: options.headSha,
        baseBranch: options.baseBranch,
        candidates,
        gitExec: options.gitExec,
      });
    }
    return candidates;
  } catch {
    return [];
  }
}

export interface CollectRelatedGitLabIssuesOptions {
  prTitle: string;
  diffFiles: DiffFile[];
  linkedIssues: LinkedIssue[];
  repoKind: RepoKind;
  fetchFn?: typeof fetch;
  maxCandidates?: number;
}

/**
 * Builds a concise 4-6 word GitLab search query from the PR title.
 */
export function buildGitLabSearchQuery(prTitle: string): string {
  const cleaned = prTitle.replace(/\bdev\/[a-z0-9_-]+#\d+\b/gi, ' ').replace(/[^\w\s-]/g, ' ');
  const words: string[] = [];
  const seen = new Set<string>();
  for (const raw of cleaned.split(/\s+/)) {
    const w = raw.replace(/^-+|-+$/g, '');
    const lower = w.toLowerCase();
    if (w.length < 3 || STOPWORDS.has(lower) || /^\d+$/.test(w) || seen.has(lower)) {
      continue;
    }
    seen.add(lower);
    words.push(w);
    if (words.length >= 5) break;
  }
  return words.join(' ');
}

interface GitLabGroupIssueRow {
  iid: number;
  title: string;
  state: string;
  web_url: string;
  description?: string | null;
  labels?: string[];
  references?: { full?: string };
}

/**
 * Searches `lab.civicrm.org` open `dev/*` issues for possible related/unlinked issues.
 * Excludes any issue already present in `linkedIssues`. Always fails soft (`[]`).
 */
export async function collectRelatedGitLabIssues(
  options: CollectRelatedGitLabIssuesOptions,
): Promise<CandidateRelatedIssue[]> {
  if (options.repoKind === 'generic') return [];
  const query = buildGitLabSearchQuery(options.prTitle);
  if (query.length < 4) return [];

  const maxCandidates = options.maxCandidates ?? 5;
  const fetchFn = options.fetchFn ?? fetch;
  const alreadyLinkedUrls = new Set(options.linkedIssues.map((i) => i.url.toLowerCase()));
  const alreadyLinkedRefs = new Set(
    options.linkedIssues.map((i) => `${i.repo.toLowerCase()}#${i.number}`),
  );

  try {
    const url =
      `https://lab.civicrm.org/api/v4/groups/dev/issues?state=opened&per_page=8&search=` +
      encodeURIComponent(query);
    const res = await fetchFn(url, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(6_000),
    });
    if (!res.ok) return [];
    const rows = (await res.json()) as GitLabGroupIssueRow[];
    if (!Array.isArray(rows)) return [];

    const out: CandidateRelatedIssue[] = [];
    for (const row of rows) {
      if (!row || typeof row.iid !== 'number' || !row.web_url || !row.title) continue;
      const fullRef =
        row.references?.full?.replace(/^\/+/, '') ??
        row.web_url
          .replace(/^https?:\/\/lab\.civicrm\.org\//i, '')
          .replace(/\/-\/issues\/(\d+).*$/, '#$1');
      if (
        alreadyLinkedUrls.has(row.web_url.toLowerCase()) ||
        alreadyLinkedRefs.has(fullRef.toLowerCase())
      ) {
        continue;
      }
      const snippet = (row.description ?? '').replace(/\s+/g, ' ').trim().slice(0, 180);
      out.push({
        ref: fullRef,
        title: row.title,
        state: row.state ?? 'opened',
        url: row.web_url,
        labels: Array.isArray(row.labels) ? row.labels.slice(0, 5) : [],
        snippet,
      });
      if (out.length >= maxCandidates) break;
    }
    return out;
  } catch {
    return [];
  }
}
