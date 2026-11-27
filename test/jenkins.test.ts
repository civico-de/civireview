import { describe, expect, test } from 'bun:test';
import { computeFinalVerdict } from '../src/engine/findings.ts';
import { computeConfidenceScore, reconcileMatrixForTriage } from '../src/engine/matrix.ts';
import {
  fetchJenkinsStatus,
  parseBadStyleFiles,
  parseDuderinoFailedTasks,
} from '../src/evidence/jenkins.ts';

const SAMPLE_DUDERINO_FAILED_HTML = `
<table class="table table-striped">
<tbody>
<tr><td><a href="https://test.civicrm.org/job/CiviCRM-Test/257689"><span class="glyphicon glyphicon-remove text-danger"></span></a></td><td><code>drupal-clean</code></td><td><code>php82m57</code></td><td><code>phpunit-e2e phpunit-uf</code></td><td><code>disable</code></td><td><span>test-3</span></td><td><div><a href="https://test.civicrm.org/job/CiviCRM-Test/257689/testReport"><span class="text-danger">2 failed</span>, <span class="text-success">1481 passed</span>, <span class="text-warning">404 skipped</span></a></div></td><td><div role="group" class="btn-group"></div></td></tr>
<tr><td><a href="https://test.civicrm.org/job/CiviCRM-Style/99100"><span class="glyphicon glyphicon-remove text-danger"></span></a></td><td><code>style</code></td><td><code>php82</code></td><td><code>civilint</code></td><td><code>disable</code></td><td><span>test-1</span></td><td><div><span class="text-danger">1 failed</span></div></td><td><div role="group" class="btn-group"></div></td></tr>
</tbody>
</table>
`;

const SAMPLE_BAD_STYLE_HTML = `
<div id="bad-style-details-body">
  <ul>
    <li><code>CRM/Contact/BAO/Contact.php</code></li>
    <li><code>ext/sequentialcreditnotes/sequentialcreditnotes.php</code></li>
  </ul>
</div>
`;

describe('Jenkins / Duderino CI evidence & flaky-CI reconciliation', () => {
  test('parseDuderinoFailedTasks and parseBadStyleFiles extract job metadata and style files', () => {
    const tasks = parseDuderinoFailedTasks(SAMPLE_DUDERINO_FAILED_HTML);
    expect(tasks).toHaveLength(2);
    expect(tasks[0]!.job).toBe('CiviCRM-Test');
    expect(tasks[0]!.build).toBe('257689');
    expect(tasks[0]!.cells).toBe('drupal-clean php82m57 phpunit-e2e phpunit-uf');
    expect(tasks[0]!.results).toBe('2 failed, 1481 passed, 404 skipped');

    const badFiles = parseBadStyleFiles(SAMPLE_BAD_STYLE_HTML);
    expect(badFiles).toEqual([
      'CRM/Contact/BAO/Contact.php',
      'ext/sequentialcreditnotes/sequentialcreditnotes.php',
    ]);
  });

  test('fetchJenkinsStatus follows Duderino failed jobs into authenticated Jenkins testReport API and public bad-style', async () => {
    const requestedUrls: string[] = [];
    const mockFetch = (async (url: string | URL | Request, init?: RequestInit) => {
      const u = String(url);
      requestedUrls.push(u);
      if (u.includes('/tasks?filter=failed')) {
        return new Response(SAMPLE_DUDERINO_FAILED_HTML, { status: 200 });
      }
      if (u.includes('/bad-style')) {
        return new Response(SAMPLE_BAD_STYLE_HTML, { status: 200 });
      }
      if (u.includes('/job/CiviCRM-Test/257689/testReport/api/json')) {
        const headers = init?.headers as Record<string, string> | undefined;
        expect(headers?.Authorization).toMatch(/^Basic /);
        return new Response(
          JSON.stringify({
            failCount: 1,
            passCount: 1481,
            skipCount: 404,
            suites: [
              {
                cases: [
                  {
                    className: 'E2E_Core_SeleniumFlakeTest',
                    name: 'testSlowModalTimeout',
                    status: 'FAILED',
                    errorStackTrace:
                      'E2E_Core_SeleniumFlakeTest::testSlowModalTimeout\nTimed out waiting for modal after 30s\n/var/www/tests/E2E/SeleniumFlakeTest.php:88',
                  },
                ],
              },
            ],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      return new Response('Not found', { status: 404 });
    }) as unknown as typeof fetch;

    const ci = await fetchJenkinsStatus({
      statuses: [
        {
          context: 'CiviCRM-PR',
          state: 'failure',
          targetUrl: 'https://test.civicrm.org/duderino/batch/CiviCRM-PR/20894421',
        },
      ],
      jenkinsUser: 'botuser',
      jenkinsToken: 'secret-token',
      fetchImpl: mockFetch,
    });

    expect(ci.overallState).toBe('failure');
    expect(ci.jenkinsBatchUrl).toBe('https://test.civicrm.org/duderino/batch/CiviCRM-PR/20894421');
    expect(ci.jenkinsFailedTests).toContain('E2E_Core_SeleniumFlakeTest::testSlowModalTimeout');
    expect(ci.jenkinsFailedTests).toContain('CiviCRM-Style:CRM/Contact/BAO/Contact.php');
    expect(ci.jenkinsFailureDetails?.some((d) => d.includes('Timed out waiting for modal'))).toBe(
      true,
    );
    expect(requestedUrls.some((u) => u.includes('/testReport/api/json'))).toBe(true);
  });

  test('reconcileMatrixForTriage downgrades likely-flaky CI to WARN and upgrades NFC passed-both to PASS', () => {
    const matrix = [
      {
        check: 'CI / Jenkins',
        status: 'FAIL' as const,
        detail:
          '1 CI checks: 0 passed, 1 failed — failed tests: E2E_Core_SeleniumFlakeTest::testSlowModalTimeout',
      },
      {
        check: 'A/B Proof-of-Fix',
        status: 'WARN' as const,
        detail: '1 test(s) passed on A and B (no fail-to-pass transition observed)',
        noFailToPass: true,
      },
    ];

    const reconciled = reconcileMatrixForTriage(matrix, {
      prKind: 'core-ref-nfc',
      intent: 'refactor',
      riskLevel: 'low',
      activeLenses: ['correctness', 'tests'],
      summaryBullets: ['Refactor'],
      recommendedAbTests: [],
      ciFailureAssessment: 'likely-flaky',
      ciFailureReason: 'Unrelated Selenium modal timeout in E2E suite',
    });

    const ciRow = reconciled.find((r) => r.check === 'CI / Jenkins');
    const proofRow = reconciled.find((r) => r.check === 'A/B Proof-of-Fix');
    expect(ciRow?.status).toBe('WARN');
    expect(ciRow?.detail).toContain('likely unrelated flake');
    expect(proofRow?.status).toBe('PASS');
    expect(proofRow?.detail).toBe('1 test(s) passed on A and B');

    expect(computeFinalVerdict([], reconciled)).toBe('NO_ISSUES_FOUND');
    const score = computeConfidenceScore({
      verdict: 'NO_ISSUES_FOUND',
      findings: [],
      verificationMatrix: reconciled,
      prKind: 'core-ref-nfc',
    });
    expect(score.score).toBe(4);
    expect(score.rationale).toContain('likely unrelated flake');
  });
});
