import type { CiCheckItem, CiStatusReport } from './types.ts';

export interface CommitStatusInput {
  context: string;
  state: string;
  targetUrl?: string | null;
  description?: string | null;
}

export interface FetchJenkinsStatusOptions {
  statuses: CommitStatusInput[];
  fetchImpl?: typeof fetch;
  jenkinsUser?: string;
  jenkinsToken?: string;
  timeoutMs?: number;
}

const JENKINS_BASE = 'https://test.civicrm.org';
const DUDERINO_BATCH_RE = /https?:\/\/test\.civicrm\.org\/duderino\/batch\/[A-Za-z0-9._-]+\/\d+/i;

function normalizeCiState(rawState: string): CiCheckItem['state'] {
  const s = rawState.toLowerCase();
  if (s === 'success' || s === 'passed') return 'success';
  if (s === 'failure' || s === 'failed') return 'failure';
  if (s === 'pending' || s === 'queued' || s === 'in_progress') return 'pending';
  if (s === 'error') return 'error';
  return 'unknown';
}

function stripHtmlTags(raw: string): string {
  return raw
    .replace(/<[^>]*>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

export interface DuderinoFailedTask {
  job: string;
  build: string;
  jobUrl: string;
  cells: string;
  results: string;
}

/**
 * Parses failed task rows from `test.civicrm.org/duderino/batch/.../tasks?filter=failed`.
 */
export function parseDuderinoFailedTasks(html: string): DuderinoFailedTask[] {
  const flat = html.replace(/\r?\n/g, ' ');
  const tasks: DuderinoFailedTask[] = [];
  const rowMatches = flat.match(/<tr><td><a href="https?:\/\/test\.civicrm\.org\/job\/.*?<\/tr>/gi);
  if (!rowMatches) return tasks;

  for (const row of rowMatches) {
    const linkMatch = row.match(
      /href="(https?:\/\/test\.civicrm\.org\/job\/([A-Za-z0-9._-]+)\/(\d+))"/i,
    );
    if (!linkMatch?.[1] || !linkMatch[2] || !linkMatch[3]) continue;
    const jobUrl = linkMatch[1];
    const job = linkMatch[2];
    const build = linkMatch[3];

    const codeCells = Array.from(row.matchAll(/<code>([^<]*)<\/code>/gi))
      .slice(0, 3)
      .map((m) => stripHtmlTags(m[1] ?? ''))
      .filter(Boolean)
      .join(' ');

    const resultsMatch = row.match(/<td><div>(.*?)<\/div><\/td><td><div role="group"/i);
    const results = resultsMatch?.[1] ? stripHtmlTags(resultsMatch[1]) : '';

    tasks.push({
      job,
      build,
      jobUrl,
      cells: codeCells,
      results,
    });
  }
  return tasks;
}

/**
 * Extracts offending file paths from Duderino's public `CiviCRM-Style/<build>/bad-style` page.
 */
export function parseBadStyleFiles(html: string): string[] {
  const marker = 'id="bad-style-details-body"';
  const idx = html.indexOf(marker);
  if (idx === -1) return [];
  const slice = html.slice(idx);
  const endIdx = slice.indexOf('</ul>');
  const section = endIdx !== -1 ? slice.slice(0, endIdx) : slice.slice(0, 4000);
  const files: string[] = [];
  for (const m of section.matchAll(/<code>([^<]+)<\/code>/gi)) {
    const file = stripHtmlTags(m[1] ?? '');
    if (file && !files.includes(file)) {
      files.push(file);
    }
  }
  return files.slice(0, 30);
}

interface ExtractedJenkinsCase {
  label: string;
  traceSnippet?: string;
}

function extractJenkinsFailedCasesFromJson(data: unknown): ExtractedJenkinsCase[] {
  const failed: ExtractedJenkinsCase[] = [];
  const seen = new Set<string>();
  if (!data || typeof data !== 'object') return failed;
  const obj = data as Record<string, unknown>;
  const suites = Array.isArray(obj.suites) ? obj.suites : [];
  for (const suite of suites) {
    if (!suite || typeof suite !== 'object') continue;
    const cases = Array.isArray((suite as Record<string, unknown>).cases)
      ? ((suite as Record<string, unknown>).cases as unknown[])
      : [];
    for (const testCase of cases) {
      if (!testCase || typeof testCase !== 'object') continue;
      const tc = testCase as Record<string, unknown>;
      const status = typeof tc.status === 'string' ? tc.status.toUpperCase() : '';
      if (status === 'FAILED' || status === 'REGRESSION') {
        const cls = typeof tc.className === 'string' ? tc.className : '';
        const name = typeof tc.name === 'string' ? tc.name : '';
        const label = cls && name ? `${cls}::${name}` : cls || name;
        if (!label || seen.has(label)) continue;
        seen.add(label);

        const rawTrace =
          typeof tc.errorStackTrace === 'string' && tc.errorStackTrace.trim()
            ? tc.errorStackTrace
            : typeof tc.errorDetails === 'string'
              ? tc.errorDetails
              : '';
        const traceLines = rawTrace
          .split(/\r?\n/)
          .map((l) => l.trim())
          .filter((l) => l.length > 0 && l !== label)
          .slice(0, 5);
        const traceSnippet =
          traceLines.length > 0 ? traceLines.join(' | ').slice(0, 320) : undefined;
        failed.push({ label, traceSnippet });
        if (failed.length >= 25) return failed;
      }
    }
  }
  return failed;
}

/**
 * Summarizes PR commit statuses and fetches public CiviCRM Duderino failed
 * tasks, `CiviCRM-Style` bad-style files, and optional authenticated Jenkins
 * `/testReport/api/json` failed test names + stack traces without throwing.
 */
export async function fetchJenkinsStatus(
  options: FetchJenkinsStatusOptions,
): Promise<CiStatusReport> {
  const fetchFn = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? 8000;
  const jenkinsUser = options.jenkinsUser ?? process.env.CIVICRM_JENKINS_USER;
  const jenkinsToken = options.jenkinsToken ?? process.env.CIVICRM_JENKINS_TOKEN;
  const authHeader =
    jenkinsUser && jenkinsToken
      ? `Basic ${Buffer.from(`${jenkinsUser}:${jenkinsToken}`).toString('base64')}`
      : undefined;

  const checks: CiCheckItem[] = [];
  let jenkinsBatchUrl: string | undefined;
  const jenkinsFailedTests: string[] = [];
  const jenkinsFailureDetails: string[] = [];

  for (const st of options.statuses) {
    const targetUrl = st.targetUrl ?? undefined;
    const item: CiCheckItem = {
      name: st.context,
      state: normalizeCiState(st.state),
      targetUrl,
      description: st.description ?? undefined,
    };

    if (targetUrl) {
      const batchMatch = targetUrl.match(DUDERINO_BATCH_RE);
      if (batchMatch && !jenkinsBatchUrl) {
        jenkinsBatchUrl = batchMatch[0];
      }
    }

    checks.push(item);
  }

  const failingJenkinsJobs: Array<{ job: string; build: string; jobUrl: string; header: string }> =
    [];

  // 1. Fetch public Duderino failed tasks page (`<batchUrl>/tasks?filter=failed`)
  if (jenkinsBatchUrl) {
    try {
      const resp = await fetchFn(`${jenkinsBatchUrl}/tasks?filter=failed`, {
        signal: AbortSignal.timeout(timeoutMs),
        headers: { Accept: 'text/html' },
      });
      if (resp.ok) {
        const html = await resp.text();
        const tasks = parseDuderinoFailedTasks(html).slice(0, 6);
        for (const task of tasks) {
          const header = `${task.job} #${task.build}${task.cells ? ` (${task.cells})` : ''}${task.results ? ` — ${task.results}` : ''}`;
          if (task.job === 'CiviCRM-Style') {
            try {
              const styleResp = await fetchFn(
                `${JENKINS_BASE}/duderino/build/CiviCRM-Style/${task.build}/bad-style`,
                { signal: AbortSignal.timeout(timeoutMs), headers: { Accept: 'text/html' } },
              );
              if (styleResp.ok) {
                const badFiles = parseBadStyleFiles(await styleResp.text());
                if (badFiles.length > 0) {
                  jenkinsFailureDetails.push(`${header}: bad style in ${badFiles.join(', ')}`);
                  for (const f of badFiles) {
                    const tag = `CiviCRM-Style:${f}`;
                    if (!jenkinsFailedTests.includes(tag)) jenkinsFailedTests.push(tag);
                  }
                } else {
                  jenkinsFailureDetails.push(header);
                }
              }
            } catch {
              jenkinsFailureDetails.push(header);
            }
          } else if (/[1-9]\d*\s+failed/i.test(task.results)) {
            failingJenkinsJobs.push({
              job: task.job,
              build: task.build,
              jobUrl: task.jobUrl,
              header,
            });
            if (!authHeader) {
              jenkinsFailureDetails.push(
                `${header} (test names require CIVICRM_JENKINS_USER + CIVICRM_JENKINS_TOKEN)`,
              );
            }
          } else {
            jenkinsFailureDetails.push(`${header} (no JUnit test report — see console)`);
          }
        }
      }
    } catch {
      // Degrade gracefully when test.civicrm.org is unreachable
    }
  }

  // Also include any direct `/job/<name>/<build>` failing commit status URLs
  for (const c of checks) {
    if ((c.state !== 'failure' && c.state !== 'error') || !c.targetUrl) continue;
    const directMatch = c.targetUrl.match(
      /(https?:\/\/test\.civicrm\.org\/job\/([A-Za-z0-9._-]+)\/(\d+))/i,
    );
    if (
      directMatch?.[1] &&
      directMatch[2] &&
      directMatch[3] &&
      !failingJenkinsJobs.some((j) => j.jobUrl === directMatch[1])
    ) {
      failingJenkinsJobs.push({
        job: directMatch[2],
        build: directMatch[3],
        jobUrl: directMatch[1],
        header: `${directMatch[2]} #${directMatch[3]}`,
      });
    }
  }

  // 2. If Jenkins credentials are available, fetch exact failed test names + stack traces
  if (authHeader && failingJenkinsJobs.length > 0) {
    const reportTree =
      'failCount,passCount,skipCount,suites[cases[className,name,status,errorStackTrace,errorDetails]]';
    for (const target of failingJenkinsJobs.slice(0, 5)) {
      try {
        const cleanUrl = target.jobUrl.replace(/\/+$/, '');
        const reportUrl = `${cleanUrl}/testReport/api/json?tree=${reportTree}`;
        const resp = await fetchFn(reportUrl, {
          signal: AbortSignal.timeout(timeoutMs),
          headers: {
            Authorization: authHeader,
            Accept: 'application/json',
          },
        });
        if (resp.ok) {
          const json = await resp.json();
          const cases = extractJenkinsFailedCasesFromJson(json);
          if (cases.length > 0) {
            const caseSummaries = cases
              .slice(0, 8)
              .map((c) => (c.traceSnippet ? `${c.label} (${c.traceSnippet})` : c.label));
            jenkinsFailureDetails.push(`${target.header}: ${caseSummaries.join('; ')}`);
            for (const c of cases) {
              if (!jenkinsFailedTests.includes(c.label)) {
                jenkinsFailedTests.push(c.label);
              }
            }
          } else {
            jenkinsFailureDetails.push(target.header);
          }
        } else {
          jenkinsFailureDetails.push(`${target.header} (Jenkins API HTTP ${resp.status})`);
        }
      } catch {
        jenkinsFailureDetails.push(target.header);
      }
    }
  }

  let overallState: CiStatusReport['overallState'] = 'unknown';
  if (checks.length > 0) {
    if (checks.some((c) => c.state === 'failure' || c.state === 'error')) {
      overallState = 'failure';
    } else if (checks.some((c) => c.state === 'pending')) {
      overallState = 'pending';
    } else if (checks.every((c) => c.state === 'success')) {
      overallState = 'success';
    }
  }

  const passedCount = checks.filter((c) => c.state === 'success').length;
  const failedCount = checks.filter((c) => c.state === 'failure' || c.state === 'error').length;
  const pendingCount = checks.filter((c) => c.state === 'pending').length;

  const summary =
    checks.length === 0
      ? 'No CI commit statuses reported.'
      : `${checks.length} CI checks: ${passedCount} passed, ${failedCount} failed, ${pendingCount} pending${jenkinsFailedTests.length > 0 ? ` (${jenkinsFailedTests.length} failed test(s) extracted)` : ''}.`;

  return {
    overallState,
    checks,
    jenkinsBatchUrl,
    jenkinsFailedTests,
    ...(jenkinsFailureDetails.length > 0 ? { jenkinsFailureDetails } : {}),
    summary,
  };
}
