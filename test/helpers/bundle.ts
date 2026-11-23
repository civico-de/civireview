import { parseUnifiedDiff } from '../../src/evidence/diff-filter.ts';
import type { EvidenceBundle } from '../../src/evidence/types.ts';

export const SAMPLE_PATCH = `diff --git a/CRM/Contact/BAO/Contact.php b/CRM/Contact/BAO/Contact.php
index 1111111..2222222 100644
--- a/CRM/Contact/BAO/Contact.php
+++ b/CRM/Contact/BAO/Contact.php
@@ -10,4 +10,6 @@ class CRM_Contact_BAO_Contact {
   public static function run($id) {
-    return CRM_Core_DAO::executeQuery("SELECT * FROM civicrm_contact WHERE id = " . $id);
+    $sql = "SELECT * FROM civicrm_contact WHERE id = " . $id;
+    return CRM_Core_DAO::executeQuery($sql);
   }
 }
`;

export function makeBundle(overrides: Partial<EvidenceBundle> = {}): EvidenceBundle {
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
      prNumber: 32001,
      title: 'Fix contact lookup',
      body: 'Refactors contact query',
      author: 'contributor',
      baseBranch: 'master',
      headBranch: 'fix-lookup',
      baseSha: '1111111111111111111111111111111111111111',
      headSha: '2222222222222222222222222222222222222222',
      labels: [],
      draft: false,
    },
    comments: [],
    linkedIssues: [],
    diffFiles: parseUnifiedDiff(SAMPLE_PATCH),
    droppedNoiseFiles: [],
    diffTruncated: false,
    abReport: {
      executed: true,
      imageA: 'standalone-master',
      imageB: 'standalone-master',
      checks: [
        {
          name: 'proof-of-fix',
          command: 'ck ab ...',
          imageA: 'standalone-master',
          imageB: 'standalone-master',
          status: 'PASS',
          fixed: ['CRM_Contact_BAO_ContactTest::testRun'],
          regressions: [],
          bothFail: [],
          gone: [],
          passedBoth: [],
          tautologicalTests: [],
          addedTestMethods: [],
          summary: '1 test(s) red on A, green on B',
        },
      ],
      surfaceDiff: {
        changes: [],
        unverifiedSurfaces: [],
        touchedComponents: ['CRM'],
        summary: 'No structural surface changes.',
      },
      demoConsoleErrors: [],
      notVerified: [],
    },
    staticDelta: {
      executed: true,
      toolsRun: ['cktaint'],
      findings: [],
      summary: 'Executed [cktaint] with 0 finding(s).',
    },
    ciStatus: {
      overallState: 'success',
      checks: [{ name: 'Duderino', state: 'success' }],
      jenkinsFailedTests: [],
      summary: '1 CI checks: 1 passed, 0 failed, 0 pending.',
    },
    notVerified: [],
    ...overrides,
  };
}
