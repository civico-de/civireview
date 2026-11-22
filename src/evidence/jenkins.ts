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

const DUDERINO_BATCH_RE =
  /https?:\/\/test\.civicrm\.org\/duderino\/batch\/CiviCRM-PR\/[^/\s?#]+/i;

function normalizeCiState(
  rawState: string,
): CiCheckItem['state'] {
  const s = rawState.toLowerCase();
  if (s === 'success' || s === 'passed') return 'success';
  if (s === 'failure' || s === 'failed') return 'failure';
  if (s === 'pending' || s === 'queued' || s === 'in_progress') return 'pending';
  if (s === 'error') return 'error';
  return 'unknown';
}

function extractDuderinoSummary(htmlOrText: string): {
  failedTests: string[];
  summaryNote?: string;
} {
  const failedTests: string[] = [];
  // Duderino pages list failed jobs or test class/method identifiers
  const jobFailureRe =
    /(?:FAILED|FAILURE|FAIL)\s*[:\-]?\s*([A-Za-z0-9_\\/:.-]+Test(?:::[A-Za-z0-9_]+)?)/g;
  for (const match of htmlOrText.matchAll(jobFailureRe)) {
    if (match[1] && !failedTests.includes(match[1])) {
      failedTests.push(match[1]);
    }
  }
  const countMatch = htmlOrText.match(
    /(\d+)\s+pass(?:ed|ing)?[,;\s]+(\d+)\s+fail(?:ed|ing|ure)?/i,
  );
  const summaryNote = countMatch
    ? `${countMatch[1]} passed, ${countMatch[2]} failed`
    : undefined;
  return { failedTests: failedTests.slice(0, 30), summaryNote };
}

function extractJenkinsFailedTestsFromJson(data: unknown): string[] {
  const failed: string[] = [];
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
        if (label && !failed.includes(label)) {
          failed.push(label);
        }
      }
    }
  }
  return failed.slice(0, 50);
}

/**
 * Summarizes PR commit statuses and fetches public CiviCRM Duderino batch
 * info (and optional authenticated Jenkins test failures) without throwing.
 */
export async function fetchJenkinsStatus(
  options: FetchJenkinsStatusOptions,
): Promise<CiStatusReport> {
  const fetchFn = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? 8000;
  const jenkinsUser =
    options.jenkinsUser ?? process.env.CIVICRM_JENKINS_USER;
  const jenkinsToken =
    options.jenkinsToken ?? process.env.CIVICRM_JENKINS_TOKEN;

  const checks: CiCheckItem[] = [];
  let jenkinsBatchUrl: string | undefined;
  const jenkinsFailedTests: string[] = [];

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

  if (jenkinsBatchUrl) {
    try {
      const resp = await fetchFn(jenkinsBatchUrl, {
        signal: AbortSignal.timeout(timeoutMs),
        headers: { Accept: 'application/json, text/html' },
      });
      if (resp.ok) {
        const text = await resp.text();
        const { failedTests } = extractDuderinoSummary(text);
        for (const t of failedTests) {
          if (!jenkinsFailedTests.includes(t)) {
            jenkinsFailedTests.push(t);
          }
        }
      }
    } catch {
      // Degrade gracefully when test.civicrm.org is unreachable
    }
  }

  // If Jenkins credentials are available and any failing check links to a Jenkins job,
  // try fetching /testReport/api/json for exact failed test names.
  if (jenkinsUser && jenkinsToken) {
    const authHeader = `Basic ${Buffer.from(`${jenkinsUser}:${jenkinsToken}`).toString('base64')}`;
    const failingJenkinsUrls = checks
      .filter(
        (c) =>
          (c.state === 'failure' || c.state === 'error') &&
          c.targetUrl &&
          /jenkins|test\.civicrm\.org\/job\//i.test(c.targetUrl),
      )
      .map((c) => c.targetUrl as string)
      .slice(0, 5);

    for (const url of failingJenkinsUrls) {
      try {
        const cleanUrl = url.replace(/\/+$/, '');
        const reportUrl = `${cleanUrl}/testReport/api/json`;
        const resp = await fetchFn(reportUrl, {
          signal: AbortSignal.timeout(timeoutMs),
          headers: {
            Authorization: authHeader,
            Accept: 'application/json',
          },
        });
        if (resp.ok) {
          const json = await resp.json();
          const failed = extractJenkinsFailedTestsFromJson(json);
          for (const t of failed) {
            if (!jenkinsFailedTests.includes(t)) {
              jenkinsFailedTests.push(t);
            }
          }
        }
      } catch {
        // Ignore Jenkins fetch failures
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
  const failedCount = checks.filter(
    (c) => c.state === 'failure' || c.state === 'error',
  ).length;
  const pendingCount = checks.filter((c) => c.state === 'pending').length;

  const summary =
    checks.length === 0
      ? 'No CI commit statuses reported.'
      : `${checks.length} CI checks: ${passedCount} passed, ${failedCount} failed, ${pendingCount} pending${jenkinsFailedTests.length > 0 ? ` (${jenkinsFailedTests.length} failed test names extracted)` : ''}.`;

  return {
    overallState,
    checks,
    jenkinsBatchUrl,
    jenkinsFailedTests,
    summary,
  };
}
