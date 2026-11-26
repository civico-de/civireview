import type { FinalReview } from '../../src/engine/schemas.ts';
import { parseUnifiedDiff } from '../../src/evidence/diff-filter.ts';
import type { EvidenceBundle } from '../../src/evidence/types.ts';

/** A core PR with one inline and one out-of-diff finding, shared by the formatter tests. */
const DIFF = `diff --git a/CRM/Contact/BAO/Contact.php b/CRM/Contact/BAO/Contact.php
index 1111111..2222222 100644
--- a/CRM/Contact/BAO/Contact.php
+++ b/CRM/Contact/BAO/Contact.php
@@ -10,3 +10,4 @@ class CRM_Contact_BAO_Contact {
   public static function run($id) {
+    return $id;
   }
 }
`;

export function makeSampleBundle(): EvidenceBundle {
  return {
    schemaVersion: '1',
    collectedAt: '2026-11-22T12:00:00Z',
    repoInfo: {
      kind: 'civicrm-core',
      root: '/tmp/repo',
      recommendedImage: 'standalone-master',
    },
    pr: {
      repo: 'civicrm/civicrm-core',
      isPrivateRepo: false,
      prNumber: 99,
      title: 'Test PR',
      body: 'Body',
      author: 'alice',
      baseBranch: 'master',
      headBranch: 'fix',
      baseSha: 'aaaa1111',
      headSha: 'bbbb2222',
      labels: [],
      draft: false,
    },
    comments: [],
    linkedIssues: [],
    diffFiles: parseUnifiedDiff(DIFF),
    droppedNoiseFiles: [],
    diffTruncated: false,
    abReport: {
      executed: true,
      imageA: 'standalone-master',
      imageB: 'standalone-master',
      checks: [],
      surfaceDiff: {
        changes: [],
        unverifiedSurfaces: [],
        touchedComponents: ['CRM'],
        summary: 'No surface changes.',
      },
      demoConsoleErrors: [],
      cmsDemos: [],
      notVerified: ['Upgrade step not run'],
    },
    staticDelta: {
      executed: false,
      toolsRun: [],
      findings: [],
      summary: 'Skipped',
    },
    ciStatus: {
      overallState: 'success',
      checks: [],
      jenkinsFailedTests: [],
      summary: 'All passed',
    },
    notVerified: ['Upgrade step not run'],
  };
}

export function makeSampleReview(): FinalReview {
  return {
    schemaVersion: '1',
    repo: 'civicrm/civicrm-core',
    prNumber: 99,
    baseSha: 'aaaa1111',
    headSha: 'bbbb2222',
    prKind: 'core-bugfix',
    verdict: 'NEEDS_CHANGES',
    walkthrough: ['Fixes contact lookup'],
    verificationMatrix: [
      { check: 'CI / Jenkins', status: 'PASS', detail: 'All passed' },
      {
        check: 'CiviKitchen A/B Proof-of-Fix',
        status: 'PASS',
        detail: 'standalone-master vs standalone-master: 1 test red on A, green on B',
      },
    ],
    notVerified: ['Upgrade step not run'],
    standards: [
      { code: 'r-explain', status: 'PASS', note: 'Good summary' },
      { code: 'r-test', status: 'PASS', note: 'Red/Green proven' },
    ],
    blastRadius: [
      {
        repo: 'civicrm/civicrm-core',
        path: 'CRM/Contact/Page/View.php',
        symbol: 'Contact::run',
        impact: 'Caller checked',
      },
    ],
    findings: [
      {
        id: 'inline-1',
        lens: 'correctness',
        title: 'Inline bug',
        severity: 'high',
        reassessedSeverity: 'high',
        verdict: 'PROVEN',
        confidence: 95,
        path: 'CRM/Contact/BAO/Contact.php',
        startLine: 11,
        endLine: 11,
        side: 'RIGHT',
        issue: 'Returns raw $id',
        failureScenario: 'Caller expects array',
        evidence: 'Line 11',
        verificationEvidence: 'Proven by test',
        suggestedFix: 'Return array',
        suggestionCode: 'return [$id];',
        mcpCitations: ['civicrm_read:CRM/Contact/BAO/Contact.php'],
      },
      {
        id: 'summary-1',
        lens: 'correctness',
        title: 'Untouched caller mismatch',
        severity: 'medium',
        reassessedSeverity: 'medium',
        verdict: 'CONFIRMED',
        confidence: 88,
        path: 'CRM/Contact/Page/View.php',
        startLine: 40,
        endLine: 40,
        side: 'RIGHT',
        issue: 'Expects object',
        failureScenario: 'TypeError in View.php',
        evidence: 'Line 40 of View.php',
        verificationEvidence: 'Confirmed via read_file',
        suggestedFix: 'Update caller',
        mcpCitations: [],
      },
    ],
    droppedCount: 1,
    modelsUsed: {
      triage: 'anthropic:claude-haiku-4-5',
      'specialist:correctness': 'anthropic:claude-sonnet-4-6',
      verifier: 'openai:gpt-5.2',
    },
    tokenUsage: {
      inputTokens: 500,
      outputTokens: 150,
      cachedInputTokens: 200,
      totalTokens: 650,
    },
    generatedAt: '2026-11-22T12:01:00Z',
  };
}
