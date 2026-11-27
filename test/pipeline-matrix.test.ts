import { describe, expect, test } from 'bun:test';
import { loadConfig } from '../src/config/loader.ts';
import { findingsVerdict, hasBlockingIssue } from '../src/engine/findings.ts';
import { applyThreadResolutionsToMatrix } from '../src/engine/matrix.ts';
import {
  buildVerificationMatrix,
  computeConfidenceScore,
  computeFinalVerdict,
  resolveStageEffort,
  runReviewPipeline,
} from '../src/engine/pipeline.ts';
import { parseUnifiedDiff } from '../src/evidence/diff-filter.ts';
import type { EvidenceBundle } from '../src/evidence/types.ts';
import { createRunnerRegistry } from '../src/runners/registry.ts';
import { sanitizeGitHubMentions } from '../src/github/formatter.ts';
import type { StageRunner } from '../src/runners/types.ts';
import { makeSampleReview } from './helpers/review-fixtures.ts';

const SAMPLE_PATCH = `diff --git a/CRM/Contact/BAO/Contact.php b/CRM/Contact/BAO/Contact.php
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

function makeBundle(overrides: Partial<EvidenceBundle> = {}): EvidenceBundle {
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
      cmsDemos: [],
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

describe('pipeline matrix, scoring, effort & verdict reconciliation', () => {
  test.each([
    ['A/B ran', false],
    ['A/B gave no result', true],
  ])(
    'filters non-canonical standards, adopts Stage 2 reconciledStandards, and flips stale ISSUEs (%s)',
    async (_label, abBroke) => {
      const config = loadConfig('/tmp/nonexistent-cfg-dir', {
        preset: 'sonnet',
        review: {
          include: ['correctness'],
          confidenceThreshold: 80,
        },
      });

      let verifierUserPrompt = '';
      const mockRunner: StageRunner = {
        providers: ['anthropic'],
        async run(req) {
          if (req.stage === 'triage') {
            return {
              output: req.schema.parse({
                prKind: 'core-bugfix',
                riskLevel: 'low',
                activeLenses: ['correctness'],
                summaryBullets: ['Simple fix'],
                recommendedAbTests: [],
              }),
              model: req.model,
              provider: 'anthropic',
              durationMs: 1,
            };
          }
          if (req.stage === 'specialist:correctness') {
            return {
              output: req.schema.parse({
                lens: 'correctness',
                summary: 'Potential issue',
                findings: [
                  {
                    id: 'corr-fp',
                    lens: 'correctness',
                    title: 'Speculative code issue',
                    severity: 'medium',
                    path: 'CRM/Contact/BAO/Contact.php',
                    startLine: 11,
                    endLine: 11,
                    side: 'RIGHT',
                    issue: 'Might fail',
                    failureScenario: 'Edge case',
                    evidence: 'Line 11',
                    suggestedFix: 'Guard',
                    mcpCitations: [],
                  },
                ],
                standards: [
                  { code: 'r-explain', status: 'PASS', note: 'Clear PR' },
                  { code: 'r-code', status: 'ISSUE', note: 'Speculative issue' },
                  { code: 'r-tech', status: 'ISSUE', note: 'Unbacked tech worry' },
                  { code: 'A/B', status: 'PASS', note: 'Invented ad-hoc code' },
                  { code: 'CI', status: 'PASS', note: 'Invented ad-hoc code' },
                  { code: 'upgrade-schema', status: 'N/A', note: 'Invented code' },
                ],
                checkedWithoutFindings: [],
              }),
              model: req.model,
              provider: 'anthropic',
              durationMs: 1,
            };
          }
          if (req.stage === 'verifier') {
            verifierUserPrompt = req.userPrompt;
            return {
              output: req.schema.parse({
                notes: 'Disproved corr-fp and reconciled standards',
                verifiedFindings: [
                  {
                    id: 'corr-fp',
                    lens: 'correctness',
                    title: 'Speculative code issue',
                    severity: 'medium',
                    reassessedSeverity: 'medium',
                    verdict: 'REJECTED',
                    confidence: 20,
                    path: 'CRM/Contact/BAO/Contact.php',
                    startLine: 11,
                    endLine: 11,
                    side: 'RIGHT',
                    issue: 'Might fail',
                    failureScenario: 'Edge case',
                    evidence: 'Line 11',
                    verificationEvidence: 'Disproved',
                    suggestedFix: 'None',
                    mcpCitations: [],
                  },
                ],
                reconciledStandards: [
                  { code: 'r-code', status: 'PASS', note: 'Candidate rejected by verifier' },
                  { code: 'bogus-code', status: 'ISSUE', note: 'Should be filtered' },
                ],
              }),
              model: req.model,
              provider: 'anthropic',
              durationMs: 1,
            };
          }
          throw new Error(`Unexpected stage ${req.stage}`);
        },
      };

      const registry = createRunnerRegistry({ anthropic: mockRunner });
      const bundle = makeBundle();
      const review = await runReviewPipeline({
        bundle: abBroke
          ? { ...bundle, abReport: { ...bundle.abReport, executed: false, checks: [] } }
          : bundle,
        filteredPatch: SAMPLE_PATCH,
        config,
        cwd: process.cwd(),
        registry,
      });

      // Non-canonical ad-hoc codes were filtered before Stage 2 and from final output
      expect(verifierUserPrompt).not.toContain('"A/B"');
      expect(verifierUserPrompt).not.toContain('"upgrade-schema"');
      expect(verifierUserPrompt).toContain('"r-code"');

      expect(review.verdict).toBe(abBroke ? 'NOT_VERIFIED' : 'NO_ISSUES_FOUND');
      expect(review.findings).toHaveLength(0);
      const codes = review.standards?.map((s) => s.code) ?? [];
      expect(codes).toEqual(['r-explain', 'r-code', 'r-tech']);
      // Stage 2 reconciled r-code -> PASS, deterministic pass flipped stale r-tech -> PASS
      expect(review.standards?.find((s) => s.code === 'r-code')?.status).toBe('PASS');
      expect(review.standards?.find((s) => s.code === 'r-tech')?.status).toBe('PASS');
      expect(review.standards?.find((s) => s.code === 'r-tech')?.note).toContain('Reconciled');
    },
  );

  test('buildVerificationMatrix marks tautologicalTests as WARN and pipeline keeps r-maint/r-run consistent', async () => {
    const tautBundle = makeBundle({
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
            fixed: [],
            regressions: [],
            bothFail: [],
            gone: [],
            passedBoth: ['QueryTest::testOrderByAlwaysIncludesContactId'],
            tautologicalTests: [
              {
                file: 'tests/phpunit/CRM/Contact/BAO/QueryTest.php',
                method: 'testOrderByAlwaysIncludesContactId',
                line: 100,
                testCaseName: 'QueryTest::testOrderByAlwaysIncludesContactId',
              },
            ],
            addedTestMethods: [
              {
                file: 'tests/phpunit/CRM/Contact/BAO/QueryTest.php',
                method: 'testOrderByAlwaysIncludesContactId',
                line: 100,
              },
            ],
            summary:
              '1 added test method(s) PASSED on unfixed base A (tautological: testOrderByAlwaysIncludesContactId)',
          },
        ],
        surfaceDiff: {
          changes: [],
          unverifiedSurfaces: [],
          touchedComponents: ['CRM'],
          summary: 'No structural surface changes.',
        },
        demoConsoleErrors: [],
        cmsDemos: [],
        notVerified: [],
      },
    });

    const { verificationMatrix } = buildVerificationMatrix(tautBundle);
    const proofRow = verificationMatrix.find((m) => m.check === 'A/B Proof-of-Fix');
    expect(proofRow).toBeDefined();
    expect(proofRow!.status).toBe('WARN');
    expect(proofRow!.detail).toContain('testOrderByAlwaysIncludesContactId');
    expect(proofRow!.detail).not.toContain('standalone-master vs standalone-master');

    const config = loadConfig('/tmp/nonexistent-cfg-dir', {
      preset: 'sonnet',
      review: {
        include: ['correctness', 'tests'],
        confidenceThreshold: 80,
      },
    });
    const mockRunner: StageRunner = {
      providers: ['anthropic'],
      async run(req) {
        if (req.stage === 'triage') {
          return {
            output: req.schema.parse({
              prKind: 'core-bugfix',
              riskLevel: 'medium',
              activeLenses: ['correctness', 'tests'],
              summaryBullets: ['Bugfix with tautological test'],
              recommendedAbTests: [],
            }),
            model: req.model,
            provider: 'anthropic',
            durationMs: 1,
          };
        }
        if (req.stage === 'specialist:correctness') {
          return {
            output: req.schema.parse({
              lens: 'correctness',
              summary: 'Code ok',
              findings: [],
              standards: [
                { code: 'r-run', status: 'PASS', note: 'A/B ran' },
                { code: 'r-maint', status: 'PASS', note: 'Test present' },
              ],
              checkedWithoutFindings: ['Code logic'],
            }),
            model: req.model,
            provider: 'anthropic',
            durationMs: 1,
          };
        }
        if (req.stage === 'specialist:tests') {
          return {
            output: req.schema.parse({
              lens: 'tests',
              summary: 'Tautological test detected',
              findings: [
                {
                  id: 'test-taut-1',
                  lens: 'tests',
                  title: 'Added test passes on unfixed base A',
                  severity: 'medium',
                  path: 'tests/phpunit/CRM/Contact/BAO/QueryTest.php',
                  startLine: 100,
                  endLine: 100,
                  side: 'RIGHT',
                  issue: 'testOrderByAlwaysIncludesContactId passed on unfixed base A',
                  failureScenario: 'Regression would not be caught',
                  evidence: 'ck ab passed_both',
                  suggestedFix: 'Assert pre-fix failure',
                  mcpCitations: [],
                },
              ],
              checkedWithoutFindings: [],
            }),
            model: req.model,
            provider: 'anthropic',
            durationMs: 1,
          };
        }
        if (req.stage === 'verifier') {
          return {
            output: req.schema.parse({
              notes: 'Confirmed tautological test via ck ab passed_both',
              verifiedFindings: [
                {
                  id: 'test-taut-1',
                  lens: 'tests',
                  title: 'Added test passes on unfixed base A',
                  severity: 'medium',
                  reassessedSeverity: 'medium',
                  verdict: 'PROVEN',
                  confidence: 95,
                  path: 'tests/phpunit/CRM/Contact/BAO/QueryTest.php',
                  startLine: 100,
                  endLine: 100,
                  side: 'RIGHT',
                  issue: 'testOrderByAlwaysIncludesContactId passed on unfixed base A',
                  failureScenario: 'Regression would not be caught',
                  evidence: 'ck ab passed_both',
                  verificationEvidence: 'ck ab proved test passed on unfixed base A',
                  suggestedFix: 'Assert pre-fix failure',
                  mcpCitations: [],
                },
              ],
            }),
            model: req.model,
            provider: 'anthropic',
            durationMs: 1,
          };
        }
        throw new Error(`Unexpected stage ${req.stage}`);
      },
    };

    const registry = createRunnerRegistry({ anthropic: mockRunner });
    const review = await runReviewPipeline({
      bundle: tautBundle,
      filteredPatch: SAMPLE_PATCH,
      config,
      cwd: process.cwd(),
      registry,
    });

    expect(review.verdict).toBe('ISSUES_FOUND');
    expect(review.findings).toHaveLength(1);
    expect(review.findings[0]!.verdict).toBe('PROVEN');
    expect(review.standards?.find((s) => s.code === 'r-maint')?.status).toBe('ISSUE');
    expect(review.standards?.find((s) => s.code === 'r-run')?.status).toBe('ISSUE');
  });

  test('buildVerificationMatrix keeps PASS with regression-guard note when fixed > 0 alongside passed_both guard tests', () => {
    const guardedBundle = makeBundle({
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
            fixed: ['AfformSubmitUsageTest::testRollback'],
            regressions: [],
            bothFail: [],
            gone: [],
            passedBoth: ['AfformContributionTest::testGuard'],
            tautologicalTests: [
              {
                file: 'ext/civi_contribute/tests/phpunit/AfformContributionTest.php',
                method: 'testGuard',
                line: 261,
                testCaseName: 'AfformContributionTest::testGuard',
              },
            ],
            addedTestMethods: [],
            summary: '1 test(s) red on A, green on B',
          },
        ],
        surfaceDiff: {
          changes: [],
          unverifiedSurfaces: [],
          touchedComponents: ['ext'],
          summary: 'No structural surface changes.',
        },
        demoConsoleErrors: [],
        cmsDemos: [],
        notVerified: [],
      },
    });

    const { verificationMatrix } = buildVerificationMatrix(guardedBundle);
    const proofRow = verificationMatrix.find((r) => r.check === 'A/B Proof-of-Fix');
    expect(proofRow?.status).toBe('PASS');
    expect(proofRow?.detail).toContain('1 test(s) failed on base, passed on PR');
    expect(proofRow?.detail).toContain('regression-guard');
    expect(proofRow?.detail).toContain('testGuard');
    expect(proofRow?.detail).not.toContain('standalone-master vs standalone-master');
    // Core matrix omits inapplicable Demo and skipped Browser rows
    expect(verificationMatrix.find((r) => r.check === 'Demo')).toBeUndefined();
    expect(verificationMatrix.find((r) => r.check === 'Browser A/B (Standalone)')).toBeUndefined();

    // When staticDelta did not execute on civicrm-core (real core behavior), omit Static / Taint Delta
    const coreNoStatic = buildVerificationMatrix(
      makeBundle({
        staticDelta: {
          executed: false,
          toolsRun: [],
          findings: [],
          summary: 'No static CiviKitchen gates executed.',
        },
      }),
    );
    expect(
      coreNoStatic.verificationMatrix.find((r) => r.check === 'Static / Taint Delta'),
    ).toBeUndefined();
  });

  test('computeConfidenceScore maps findings and empirical matrix cleanly across 1-5 scale', () => {
    const cleanMatrix = [
      { check: 'CI / Jenkins', status: 'PASS' as const, detail: '1/1 passed' },
      {
        check: 'CiviKitchen A/B Proof-of-Fix',
        status: 'PASS' as const,
        detail: '2 test(s) red on A, green on B',
      },
      {
        check: 'Base-Test Regression',
        status: 'PASS' as const,
        detail: '30 test(s) passed on A and B',
      },
      { check: 'Live Surface Diff', status: 'PASS' as const, detail: '0 risk flags' },
    ];
    const baseFinding = {
      id: 'f1',
      lens: 'correctness' as const,
      title: 'Bug',
      severity: 'low' as const,
      reassessedSeverity: 'low' as const,
      verdict: 'CONFIRMED' as const,
      confidence: 88,
      path: 'CRM/Foo.php',
      startLine: 10,
      endLine: 10,
      side: 'RIGHT' as const,
      issue: 'Issue',
      failureScenario: 'Scenario',
      evidence: 'Evidence',
      verificationEvidence: 'Verified',
      suggestedFix: 'Fix',
      mcpCitations: [],
    };

    // 5/5: clean checks, 0 findings
    const s5 = computeConfidenceScore({
      verdict: 'NO_ISSUES_FOUND',
      findings: [],
      verificationMatrix: cleanMatrix,
      prKind: 'core-bugfix',
    });
    expect(s5.score).toBe(5);
    expect(s5.rationale).toContain('No verified issues');

    // 4/5: low-severity finding OR minor surface risk flag
    const s4 = computeConfidenceScore({
      verdict: 'ISSUES_FOUND',
      findings: [baseFinding],
      verificationMatrix: cleanMatrix,
      prKind: 'core-bugfix',
    });
    expect(s4.score).toBe(4);

    // 3/5: confirmed medium finding or base-test regression failure
    const s3 = computeConfidenceScore({
      verdict: 'ISSUES_FOUND',
      findings: [{ ...baseFinding, severity: 'medium', reassessedSeverity: 'medium' }],
      verificationMatrix: [
        ...cleanMatrix.slice(0, 2),
        { check: 'Base-Test Regression', status: 'FAIL', detail: '1 test failed on head' },
      ],
      prKind: 'security-sensitive',
    });
    expect(s3.score).toBe(3);
    expect(s3.rationale).toContain('confirmed medium');
    expect(s3.rationale).toContain('Base-Test Regression');

    // 2/5: confirmed high finding
    const s2 = computeConfidenceScore({
      verdict: 'ISSUES_FOUND',
      findings: [{ ...baseFinding, severity: 'high', reassessedSeverity: 'high' }],
      verificationMatrix: cleanMatrix,
      prKind: 'security-sensitive',
    });
    expect(s2.score).toBe(2);

    // 1/5: confirmed critical finding
    const s1 = computeConfidenceScore({
      verdict: 'ISSUES_FOUND',
      findings: [
        { ...baseFinding, severity: 'critical', reassessedSeverity: 'critical', verdict: 'PROVEN' },
      ],
      verificationMatrix: cleanMatrix,
      prKind: 'security-sensitive',
    });
    expect(s1.score).toBe(1);
  });

  test('a confirmed finding of any severity is an issue; unconfirmed ones are questions', () => {
    const base = makeSampleReview().findings[0]!;
    const finding = (
      reassessedSeverity: typeof base.reassessedSeverity,
      verdict: typeof base.verdict,
    ) => ({ ...base, reassessedSeverity, verdict });

    expect(findingsVerdict([finding('medium', 'CONFIRMED')])).toBe('ISSUES_FOUND');
    expect(findingsVerdict([finding('low', 'PROVEN')])).toBe('ISSUES_FOUND');
    expect(findingsVerdict([finding('critical', 'NEEDS_QUESTION')])).toBe('QUESTIONS_ONLY');
    expect(findingsVerdict([finding('high', 'NEEDS_QUESTION'), finding('low', 'CONFIRMED')])).toBe(
      'ISSUES_FOUND',
    );

    // A change request stands on a failed check or a confirmed critical or high finding.
    expect(hasBlockingIssue([finding('medium', 'CONFIRMED')])).toBe(false);
    expect(hasBlockingIssue([finding('high', 'NEEDS_QUESTION')])).toBe(false);
    expect(hasBlockingIssue([finding('high', 'CONFIRMED')])).toBe(true);
    expect(hasBlockingIssue([], [{ check: 'CI / Jenkins', status: 'FAIL', detail: 'red' }])).toBe(
      true,
    );
  });

  test('computeFinalVerdict upgrades NO_ISSUES_FOUND to ISSUES_FOUND when empirical checks fail', () => {
    // Without a verification matrix (optional param), 0 findings -> NO_ISSUES_FOUND
    expect(computeFinalVerdict([])).toBe('NO_ISSUES_FOUND');

    // Clean or WARN/SKIPPED/NOT_VERIFIED matrix -> NO_ISSUES_FOUND
    expect(
      computeFinalVerdict(
        [],
        [
          { check: 'CI / Jenkins', status: 'PASS', detail: 'green' },
          { check: 'A/B Proof-of-Fix', status: 'WARN', detail: 'tautological' },
          { check: 'Live Surface Diff', status: 'FAIL', detail: 'non-blocking check' },
        ],
      ),
    ).toBe('NO_ISSUES_FOUND');

    // Each blocking empirical check with status FAIL upgrades NO_ISSUES_FOUND -> ISSUES_FOUND
    const blockingChecks = [
      'CI / Jenkins',
      'A/B Proof-of-Fix',
      'CiviKitchen A/B Proof-of-Fix',
      'Base-Test Regression',
      'Browser A/B (Standalone)',
      'Static / Taint Delta',
      'Demo',
    ];
    for (const check of blockingChecks) {
      expect(computeFinalVerdict([], [{ check, status: 'FAIL', detail: `${check} failed` }])).toBe(
        'ISSUES_FOUND',
      );
    }
  });

  test('a code PR whose runtime checks gave no result is not Ready and scores at most 3', () => {
    const crashed = [
      { check: 'CI / Jenkins', status: 'PASS' as const, detail: 'green' },
      {
        check: 'A/B Proof-of-Fix',
        status: 'NOT_VERIFIED' as const,
        detail: 'Internal A/B test runner error (exit 2)',
      },
      {
        check: 'Base-Test Regression',
        status: 'NOT_VERIFIED' as const,
        detail: 'Internal A/B test runner error (exit 2)',
      },
      {
        check: 'Browser A/B (Standalone)',
        status: 'NOT_VERIFIED' as const,
        detail: 'no container',
      },
    ];
    expect(computeFinalVerdict([], crashed, 'core-bugfix')).toBe('NOT_VERIFIED');
    // The code standards are reconciled on the findings alone.
    expect(findingsVerdict([], crashed)).toBe('NO_ISSUES_FOUND');
    const crashedScore = computeConfidenceScore({
      verdict: 'NOT_VERIFIED',
      findings: [],
      verificationMatrix: crashed,
      prKind: 'core-bugfix',
    });
    expect(crashedScore.score).toBe(3);
    expect(crashedScore.rationale).toContain('Not verified at runtime');

    // One runtime check with a result is enough.
    const oneRan = [
      ...crashed.slice(0, 3),
      { check: 'Browser A/B (Standalone)', status: 'PASS' as const, detail: '3 routes' },
    ];
    expect(computeFinalVerdict([], oneRan, 'core-bugfix')).toBe('NO_ISSUES_FOUND');
    // Not applicable (skipped or absent) is no failure, nor is a docs-only PR.
    expect(
      computeFinalVerdict(
        [],
        [{ check: 'Base-Test Regression', status: 'SKIPPED', detail: 'no target' }],
        'core-bugfix',
      ),
    ).toBe('NO_ISSUES_FOUND');
    expect(computeFinalVerdict([], crashed, 'docs-only')).toBe('NO_ISSUES_FOUND');
  });

  test('resolveStageEffort dynamically scales effort per stage and PR risk and respects overrides', () => {
    const baseCfg = loadConfig(process.cwd());
    const smallBundle = makeBundle();
    const cleanMatrix = [{ check: 'CI / Jenkins', status: 'PASS' as const, detail: 'green' }];
    const smallTriage = {
      prKind: 'core-bugfix' as const,
      riskLevel: 'low' as const,
      shortSummary: 'Fixes edge case.',
      summaryBullets: ['Fixes edge case.'],
      activeLenses: ['correctness' as const],
      recommendedAbTests: [],
    };
    const medCandidate = {
      id: 'c1',
      lens: 'correctness' as const,
      severity: 'medium' as const,
      confidence: 85,
      title: 'Edge case',
      path: 'CRM/Foo.php',
      startLine: 10,
      endLine: 12,
      side: 'RIGHT' as const,
      issue: 'Issue',
      failureScenario: 'Scenario',
      evidence: 'Evidence',
      suggestedFix: 'Fix',
      mcpCitations: [],
    };

    // Default `deep` profile: triage=high, all specialists=high, verifier=high
    expect(resolveStageEffort({ stage: 'triage', config: baseCfg, bundle: smallBundle })).toBe(
      'high',
    );
    expect(resolveStageEffort({ stage: 'threadReply', config: baseCfg, bundle: smallBundle })).toBe(
      'medium',
    );
    expect(
      resolveStageEffort({
        stage: 'specialist',
        lens: 'correctness',
        config: baseCfg,
        bundle: smallBundle,
        triage: smallTriage,
        verificationMatrix: cleanMatrix,
      }),
    ).toBe('high');
    expect(
      resolveStageEffort({
        stage: 'specialist',
        lens: 'tests',
        config: baseCfg,
        bundle: smallBundle,
        triage: smallTriage,
        verificationMatrix: cleanMatrix,
      }),
    ).toBe('high');
    expect(
      resolveStageEffort({
        stage: 'verifier',
        config: baseCfg,
        bundle: smallBundle,
        triage: smallTriage,
        candidates: [medCandidate],
        verificationMatrix: cleanMatrix,
      }),
    ).toBe('high');

    // `balanced` profile: triage=low, specialists=medium, verifier scales medium -> high on high-risk/failing checks
    const balancedCfg = loadConfig(process.cwd(), { review: { depth: 'balanced' } });
    expect(resolveStageEffort({ stage: 'triage', config: balancedCfg, bundle: smallBundle })).toBe(
      'low',
    );
    expect(
      resolveStageEffort({
        stage: 'verifier',
        config: balancedCfg,
        bundle: smallBundle,
        triage: smallTriage,
        candidates: [medCandidate],
        verificationMatrix: cleanMatrix,
      }),
    ).toBe('medium');
    expect(
      resolveStageEffort({
        stage: 'verifier',
        config: balancedCfg,
        bundle: smallBundle,
        triage: smallTriage,
        candidates: [{ ...medCandidate, severity: 'high' }],
        verificationMatrix: cleanMatrix,
      }),
    ).toBe('high');
    expect(
      resolveStageEffort({
        stage: 'specialist',
        lens: 'security',
        config: balancedCfg,
        bundle: smallBundle,
        triage: { ...smallTriage, prKind: 'security-sensitive' },
        verificationMatrix: cleanMatrix,
      }),
    ).toBe('medium');
    expect(
      resolveStageEffort({
        stage: 'verifier',
        config: balancedCfg,
        bundle: smallBundle,
        triage: smallTriage,
        candidates: [medCandidate],
        verificationMatrix: [
          { check: 'Base-Test Regression', status: 'FAIL' as const, detail: '1 failed' },
        ],
      }),
    ).toBe('high');

    // `fast` profile: triage=low, specialist=low, verifier=medium
    const fastCfg = loadConfig(process.cwd(), { review: { depth: 'fast' } });
    expect(resolveStageEffort({ stage: 'triage', config: fastCfg })).toBe('low');
    expect(resolveStageEffort({ stage: 'specialist', lens: 'correctness', config: fastCfg })).toBe(
      'low',
    );
    expect(resolveStageEffort({ stage: 'verifier', config: fastCfg })).toBe('medium');

    // Global override and per-stage override precedence
    const globalCfg = loadConfig(process.cwd(), {
      review: { effort: 'xhigh' },
    });
    expect(resolveStageEffort({ stage: 'verifier', config: globalCfg })).toBe('xhigh');

    const perStageCfg = loadConfig(process.cwd(), {
      review: {
        effort: 'low',
        stageEffort: { verifier: 'max' },
      },
    });
    expect(resolveStageEffort({ stage: 'triage', config: perStageCfg })).toBe('low');
    expect(resolveStageEffort({ stage: 'verifier', config: perStageCfg })).toBe('max');
  });

  test('applyThreadResolutionsToMatrix adds Reviewer Thread row and caps open feedback at 4/5 QUESTIONS_ONLY', () => {
    const baseMatrix = [{ check: 'CI / Jenkins', status: 'PASS' as const, detail: '1/1 passed' }];
    const withOpen = applyThreadResolutionsToMatrix(baseMatrix, [
      {
        author: 'ufundo',
        topic: 'Use postContainerBoot',
        status: 'addressed',
        detail: 'Moved call into postContainerBoot().',
      },
      {
        author: 'ufundo',
        topic: 'Make restrictPrivateDir() private or fold into restrictAccess()',
        status: 'open',
        detail: 'Author replied "I will look into it"; helper is still public static in head.',
      },
    ]);
    const threadRow = withOpen.find((m) => m.check === 'Reviewer Thread');
    expect(threadRow?.status).toBe('WARN');
    expect(threadRow?.detail).toContain('1 open question/request(s) (`ufundo`)');
    expect(computeFinalVerdict([], withOpen)).toBe('QUESTIONS_ONLY');
    const scoreRes = computeConfidenceScore({
      verdict: 'QUESTIONS_ONLY',
      findings: [],
      verificationMatrix: withOpen,
    });
    expect(scoreRes.score).toBe(4);
    expect(scoreRes.rationale).toContain('Unaddressed reviewer feedback');

    expect(
      sanitizeGitHubMentions('Address @mattwire and @elisseck, keep @param and `@totten`', false),
    ).toBe('Address `mattwire` and `elisseck`, keep @param and `@totten`');
    expect(sanitizeGitHubMentions('Address @mattwire', true)).toBe('Address @mattwire');

    const allResolved = applyThreadResolutionsToMatrix(baseMatrix, [
      {
        author: 'ufundo',
        topic: 'Use postContainerBoot',
        status: 'addressed',
        detail: 'Moved call into postContainerBoot().',
      },
    ]);
    expect(allResolved.find((m) => m.check === 'Reviewer Thread')?.status).toBe('PASS');
    expect(computeFinalVerdict([], allResolved)).toBe('NO_ISSUES_FOUND');
  });
});
