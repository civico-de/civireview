import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config/loader.ts';
import {
  buildVerificationMatrix,
  computeConfidenceScore,
  resolveStageEffort,
  runReviewPipeline,
  runThreadReply,
} from '../src/engine/pipeline.ts';
import { FinalReviewSchema } from '../src/engine/schemas.ts';
import { parseUnifiedDiff } from '../src/evidence/diff-filter.ts';
import type { EvidenceBundle } from '../src/evidence/types.ts';
import { createRunnerRegistry } from '../src/runners/registry.ts';
import {
  parseModelSpec,
  type StageImageInput,
  type StageRunner,
} from '../src/runners/types.ts';

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'civireview-pipe-test-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

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

describe('review pipeline', () => {
  test('executes Stage 0 -> parallel mixed-model Stage 1 -> Stage 2 Verifier -> Stage 3 gate/dedup/rank', async () => {
    const config = loadConfig('/tmp/nonexistent-cfg-dir', {
      preset: 'cross-model',
      models: {
        specialists: {
          security: 'google:gemini-2.5-pro',
        },
      },
      review: {
        confidenceThreshold: 80,
        maxInlineComments: 10,
      },
    });

    const stageCalls: Array<{ stage: string; model: string; mcpMode?: string }> = [];

    const mockRunner: StageRunner = {
      providers: ['anthropic', 'openai', 'google'],
      async run(req) {
        stageCalls.push({
          stage: req.stage,
          model: req.model,
          mcpMode: req.mcpScope?.mode,
        });

        if (req.stage === 'triage') {
          return {
            output: req.schema.parse({
              prKind: 'security-sensitive',
              riskLevel: 'high',
              activeLenses: ['correctness', 'security', 'tests'],
              summaryBullets: ['Refactors SQL lookup in CRM_Contact_BAO_Contact::run'],
              recommendedAbTests: ['tests/phpunit/CRM/Contact/BAOTest.php'],
            }),
            model: req.model,
            provider: parseModelSpec(req.model).provider,
            usage: { inputTokens: 100, outputTokens: 40, cachedInputTokens: 50, totalTokens: 140 },
            durationMs: 5,
          };
        }

        if (req.stage === 'specialist:correctness') {
          return {
            output: req.schema.parse({
              lens: 'correctness',
              summary: 'Checked BAO correctness',
              findings: [
                {
                  id: 'corr-1',
                  lens: 'correctness',
                  title: 'False positive null check',
                  severity: 'medium',
                  path: 'CRM/Contact/BAO/Contact.php',
                  startLine: 11,
                  endLine: 11,
                  side: 'RIGHT',
                  issue: 'Looks unguarded',
                  failureScenario: 'Null id',
                  evidence: 'Line 11',
                  suggestedFix: 'Check empty',
                  mcpCitations: [],
                },
                {
                  id: 'corr-dup',
                  lens: 'correctness',
                  title: 'Unparameterized SQL query (duplicate lower-priority)',
                  severity: 'medium',
                  path: 'CRM/Contact/BAO/Contact.php',
                  startLine: 11,
                  endLine: 12,
                  side: 'RIGHT',
                  issue: 'Direct SQL concatenation',
                  failureScenario: 'SQL error or injection',
                  evidence: 'Line 11-12',
                  suggestedFix: 'Use %1 parameter',
                  mcpCitations: [],
                },
              ],
              standards: [
                { code: 'r-explain', status: 'PASS', note: 'Clear PR description' },
                { code: 'r-test', status: 'PASS', note: 'A/B proof passed' },
              ],
              blastRadius: [
                {
                  repo: 'civicrm/civicrm-core',
                  path: 'CRM/Contact/Page/View.php',
                  symbol: 'CRM_Contact_BAO_Contact::run',
                  impact: 'Calls run() with route param',
                },
              ],
              checkedWithoutFindings: ['Cache invalidation'],
            }),
            model: req.model,
            provider: parseModelSpec(req.model).provider,
            usage: { inputTokens: 200, outputTokens: 80, totalTokens: 280 },
            durationMs: 10,
          };
        }

        if (req.stage === 'specialist:security') {
          return {
            output: req.schema.parse({
              lens: 'security',
              summary: 'Found SQL injection',
              findings: [
                {
                  id: 'sec-sqli',
                  lens: 'security',
                  title: 'SQL Injection via unescaped $id',
                  severity: 'critical',
                  path: 'CRM/Contact/BAO/Contact.php',
                  startLine: 11,
                  endLine: 12,
                  side: 'RIGHT',
                  issue: '$id is concatenated directly into SQL.',
                  failureScenario: 'Attacker passes crafted $id to extract arbitrary DB rows.',
                  evidence: 'Line 11 concatenates $id',
                  suggestedFix: 'Use CRM_Core_DAO::executeQuery params array.',
                  suggestionCode:
                    'return CRM_Core_DAO::executeQuery("SELECT * FROM civicrm_contact WHERE id = %1", [1 => [$id, "Integer"]]);',
                  mcpCitations: ['civicrm_read:CRM/Core/DAO.php'],
                },
              ],
              checkedWithoutFindings: [],
            }),
            model: req.model,
            provider: parseModelSpec(req.model).provider,
            usage: { inputTokens: 220, outputTokens: 90, totalTokens: 310 },
            durationMs: 12,
          };
        }

        if (req.stage === 'specialist:tests') {
          return {
            output: req.schema.parse({
              lens: 'tests',
              summary: 'Low-confidence test note',
              findings: [
                {
                  id: 'test-low',
                  lens: 'tests',
                  title: 'Uncertain edge-case test gap',
                  severity: 'low',
                  path: 'CRM/Contact/BAO/Contact.php',
                  startLine: 13,
                  endLine: 13,
                  side: 'RIGHT',
                  issue: 'Could test negative IDs',
                  failureScenario: 'Negative id passed',
                  evidence: 'Only positive id tested',
                  suggestedFix: 'Add negative id assertion',
                  mcpCitations: [],
                },
              ],
              checkedWithoutFindings: [],
            }),
            model: req.model,
            provider: parseModelSpec(req.model).provider,
            usage: { inputTokens: 150, outputTokens: 50, totalTokens: 200 },
            durationMs: 8,
          };
        }

        if (req.stage === 'verifier') {
          return {
            output: req.schema.parse({
              notes: 'Audited 4 candidates',
              verifiedFindings: [
                {
                  id: 'corr-1',
                  lens: 'correctness',
                  title: 'False positive null check',
                  severity: 'medium',
                  reassessedSeverity: 'medium',
                  verdict: 'REJECTED',
                  confidence: 25,
                  path: 'CRM/Contact/BAO/Contact.php',
                  startLine: 11,
                  endLine: 11,
                  side: 'RIGHT',
                  issue: 'Looks unguarded',
                  failureScenario: 'Null id',
                  evidence: 'Line 11',
                  verificationEvidence: 'Disproved: caller validates non-null int.',
                  suggestedFix: 'None',
                  mcpCitations: [],
                },
                {
                  id: 'corr-dup',
                  lens: 'correctness',
                  title: 'Unparameterized SQL query (duplicate lower-priority)',
                  severity: 'medium',
                  reassessedSeverity: 'medium',
                  verdict: 'CONFIRMED',
                  confidence: 85,
                  path: 'CRM/Contact/BAO/Contact.php',
                  startLine: 11,
                  endLine: 12,
                  side: 'RIGHT',
                  issue: 'Direct SQL concatenation',
                  failureScenario: 'SQL error or injection',
                  evidence: 'Line 11-12',
                  verificationEvidence: 'Confirmed in diff',
                  suggestedFix: 'Use %1 parameter',
                  mcpCitations: [],
                },
                {
                  id: 'sec-sqli',
                  lens: 'security',
                  title: 'SQL Injection via unescaped $id',
                  severity: 'critical',
                  reassessedSeverity: 'critical',
                  verdict: 'PROVEN',
                  confidence: 98,
                  path: 'CRM/Contact/BAO/Contact.php',
                  startLine: 11,
                  endLine: 12,
                  side: 'RIGHT',
                  issue: '$id is concatenated directly into SQL.',
                  failureScenario: 'Attacker passes crafted $id to extract arbitrary DB rows.',
                  evidence: 'Line 11 concatenates $id',
                  verificationEvidence: 'Verified directly against CRM_Core_DAO::executeQuery contract.',
                  suggestedFix: 'Use typed SQL parameter.',
                  suggestionCode:
                    'return CRM_Core_DAO::executeQuery("SELECT * FROM civicrm_contact WHERE id = %1", [1 => [$id, "Integer"]]);',
                  mcpCitations: ['civicrm_read:CRM/Core/DAO.php'],
                },
                {
                  id: 'test-low',
                  lens: 'tests',
                  title: 'Uncertain edge-case test gap',
                  severity: 'low',
                  reassessedSeverity: 'low',
                  verdict: 'NEEDS_QUESTION',
                  confidence: 65,
                  path: 'CRM/Contact/BAO/Contact.php',
                  startLine: 13,
                  endLine: 13,
                  side: 'RIGHT',
                  issue: 'Could test negative IDs',
                  failureScenario: 'Negative id passed',
                  evidence: 'Only positive id tested',
                  verificationEvidence: 'Below threshold (65 < 80)',
                  suggestedFix: 'Add test',
                  mcpCitations: [],
                },
              ],
            }),
            model: req.model,
            provider: parseModelSpec(req.model).provider,
            usage: { inputTokens: 300, outputTokens: 120, totalTokens: 420 },
            durationMs: 15,
          };
        }

        throw new Error(`Unexpected stage ${req.stage}`);
      },
    };

    const registry = createRunnerRegistry({
      anthropic: mockRunner,
      openai: mockRunner,
      google: mockRunner,
    });

    const review = await runReviewPipeline({
      bundle: makeBundle(),
      filteredPatch: SAMPLE_PATCH,
      config,
      cwd: process.cwd(),
      registry,
    });

    // Validate FinalReviewSchema strictly
    expect(() => FinalReviewSchema.parse(review)).not.toThrow();

    // Mixed models & public MCP scope invariant verified
    expect(stageCalls.find((c) => c.stage === 'triage')?.model).toBe(
      'anthropic:claude-haiku-5-5',
    );
    expect(stageCalls.find((c) => c.stage === 'specialist:security')?.model).toBe(
      'google:gemini-2.5-pro',
    );
    expect(stageCalls.find((c) => c.stage === 'verifier')?.model).toBe(
      'openai:gpt-5.2',
    );
    expect(stageCalls.every((c) => c.mcpMode === 'public')).toBe(true);

    // Gate + Dedup: corr-1 (REJECTED), test-low (<80), corr-dup (overlapped by critical PROVEN sec-sqli) dropped!
    expect(review.findings).toHaveLength(1);
    expect(review.findings[0]!.id).toBe('sec-sqli');
    expect(review.droppedCount).toBe(3);
    expect(review.verdict).toBe('NEEDS_CHANGES');
    expect(review.standards).toHaveLength(2);
    expect(review.blastRadius).toHaveLength(1);
    expect(review.tokenUsage?.totalTokens).toBe(140 + 280 + 310 + 200 + 420);
    expect(review.tokenUsage?.cachedInputTokens).toBe(50);
    expect(
      review.verificationMatrix.find((m) => m.check === 'CiviKitchen A/B Proof-of-Fix')
        ?.status,
    ).toBe('PASS');
  });

  test('skips specialists and verifier cleanly when triage sets skipReason', async () => {
    const config = loadConfig('/tmp/nonexistent-cfg-dir', { preset: 'sonnet' });
    const stagesRun: string[] = [];

    const mockRunner: StageRunner = {
      providers: ['anthropic'],
      async run(req) {
        stagesRun.push(req.stage);
        return {
          output: req.schema.parse({
            prKind: 'docs-only',
            riskLevel: 'low',
            activeLenses: [],
            summaryBullets: ['Updates README documentation only.'],
            recommendedAbTests: [],
            skipReason: 'Documentation-only change',
          }),
          model: req.model,
          provider: 'anthropic',
          durationMs: 2,
        };
      },
    };

    const registry = createRunnerRegistry({ anthropic: mockRunner });
    const review = await runReviewPipeline({
      bundle: makeBundle(),
      filteredPatch: '',
      config,
      cwd: process.cwd(),
      registry,
    });

    expect(stagesRun).toEqual(['triage']);
    expect(review.verdict).toBe('READY');
    expect(review.findings).toHaveLength(0);
  });

  test('runThreadReply returns validated ThreadReplyOutput', async () => {
    const config = loadConfig('/tmp/nonexistent-cfg-dir', { preset: 'sonnet' });
    const mockRunner: StageRunner = {
      providers: ['anthropic'],
      async run(req) {
        expect(req.stage).toBe('thread-reply');
        return {
          output: req.schema.parse({
            reply: 'Yes, wrapping $id in typed %1 Integer parameter resolves the SQLi.',
            resolved: true,
            references: ['CRM/Contact/BAO/Contact.php:11'],
          }),
          model: req.model,
          provider: 'anthropic',
          durationMs: 3,
        };
      },
    };

    const registry = createRunnerRegistry({ anthropic: mockRunner });
    const reply = await runThreadReply({
      bundle: makeBundle(),
      filteredPatch: SAMPLE_PATCH,
      threadContext: {
        repo: 'civicrm/civicrm-core',
        prNumber: 32001,
        path: 'CRM/Contact/BAO/Contact.php',
        line: 11,
        originalComment: 'SQL injection risk',
        threadHistory: [],
        userFollowUp: '@civireview I updated it to use %1, is this good now?',
      },
      config,
      cwd: process.cwd(),
      registry,
    });

    expect(reply.resolved).toBe(true);
    expect(reply.references).toEqual(['CRM/Contact/BAO/Contact.php:11']);
  });

  test('filters lenses via review.include/exclude, attaches multimodal screenshots to ui & verifier, and includes Browser A/B (Standalone) in matrix', async () => {
    const dir = makeTempDir();
    const beforePng = join(dir, 'before.png');
    const afterPng = join(dir, 'after.png');
    writeFileSync(beforePng, Buffer.from('PNG_A'));
    writeFileSync(afterPng, Buffer.from('PNG_B'));

    const config = loadConfig('/tmp/nonexistent-cfg-dir', {
      preset: 'sonnet',
      review: {
        include: ['browser', 'ui'],
      },
    });

    const bundleWithBrowser = makeBundle({
      abReport: {
        executed: true,
        imageA: 'standalone-master',
        imageB: 'standalone-master',
        checks: [],
        surfaceDiff: {
          changes: [],
          unverifiedSurfaces: [],
          touchedComponents: ['templates'],
          summary: 'Template touched.',
        },
        browserDiff: {
          new_console_errors: ['ReferenceError: crmUi is not defined'],
          new_page_errors: [],
          new_network_failures: [],
          new_a11y_violations: [],
          render_regressions: [],
          screenshots: [
            {
              route: 'civicrm/dashboard?reset=1',
              mode: 'authenticated',
              before: beforePng,
              after: afterPng,
            },
          ],
          risk_flags: [],
          probedRoutes: ['civicrm/dashboard?reset=1'],
          probedAnonymousRoutes: [],
        },
        demoConsoleErrors: [],
        notVerified: [],
      },
    });

    const stagesRun: Array<{ stage: string; images?: StageImageInput[] }> = [];
    const mockRunner: StageRunner = {
      providers: ['anthropic'],
      async run(req) {
        stagesRun.push({ stage: req.stage, images: req.images });
        if (req.stage === 'triage') {
          return {
            output: req.schema.parse({
              prKind: 'ui-change',
              riskLevel: 'medium',
              // Notice 'correctness' and 'security' are returned by triage,
              // but review.include=['browser','ui'] should filter them out and keep 'ui'!
              activeLenses: ['correctness', 'security'],
              summaryBullets: ['Touches dashboard template'],
              recommendedAbTests: [],
            }),
            model: req.model,
            provider: 'anthropic',
            durationMs: 2,
          };
        }
        if (req.stage === 'specialist:ui') {
          return {
            output: req.schema.parse({
              lens: 'ui',
              summary: 'Found JS error in browser A/B',
              findings: [
                {
                  id: 'ui-1',
                  lens: 'ui',
                  title: 'Undefined crmUi reference on dashboard',
                  severity: 'high',
                  path: 'CRM/Contact/BAO/Contact.php',
                  startLine: 11,
                  endLine: 11,
                  side: 'RIGHT',
                  issue: 'Browser A/B caught ReferenceError: crmUi is not defined',
                  failureScenario: 'Dashboard fails to initialize',
                  evidence: 'Browser console regression + after.png',
                  suggestedFix: 'Define crmUi before use',
                  mcpCitations: [],
                },
              ],
              checkedWithoutFindings: [],
            }),
            model: req.model,
            provider: 'anthropic',
            durationMs: 2,
          };
        }
        if (req.stage === 'verifier') {
          return {
            output: req.schema.parse({
              notes: 'Verified with browser diff + screenshots',
              verifiedFindings: [
                {
                  id: 'ui-1',
                  lens: 'ui',
                  title: 'Undefined crmUi reference on dashboard',
                  severity: 'high',
                  reassessedSeverity: 'high',
                  verdict: 'PROVEN',
                  confidence: 95,
                  path: 'CRM/Contact/BAO/Contact.php',
                  startLine: 11,
                  endLine: 11,
                  side: 'RIGHT',
                  issue: 'Browser A/B caught ReferenceError: crmUi is not defined',
                  failureScenario: 'Dashboard fails to initialize',
                  evidence: 'Browser console regression + after.png',
                  verificationEvidence: 'Confirmed in Browser A/B console diff',
                  suggestedFix: 'Define crmUi before use',
                  mcpCitations: [],
                },
              ],
            }),
            model: req.model,
            provider: 'anthropic',
            durationMs: 2,
          };
        }
        throw new Error(`Unexpected stage ${req.stage}`);
      },
    };

    const registry = createRunnerRegistry({ anthropic: mockRunner });
    const review = await runReviewPipeline({
      bundle: bundleWithBrowser,
      filteredPatch: SAMPLE_PATCH,
      config,
      cwd: process.cwd(),
      registry,
    });

    // Only triage, specialist:ui (auto-activated + allowed by include), and verifier ran
    expect(stagesRun.map((s) => s.stage)).toEqual([
      'triage',
      'specialist:ui',
      'verifier',
    ]);
    // Both specialist:ui and verifier received the before/after screenshots
    expect(stagesRun[1]!.images).toHaveLength(2);
    expect(stagesRun[2]!.images).toHaveLength(2);
    expect(stagesRun[1]!.images![0]!.label).toContain('BEFORE (base A)');
    expect(stagesRun[1]!.images![1]!.label).toContain('AFTER (head B)');

    const browserRow = review.verificationMatrix.find(
      (m) => m.check === 'Browser A/B (Standalone)',
    );
    expect(browserRow).toBeDefined();
    expect(browserRow!.status).toBe('FAIL');
    expect(browserRow!.detail).toContain('1 console');
  });

  test('filters non-canonical standards, adopts Stage 2 reconciledStandards, and flips stale ISSUEs on READY', async () => {
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
    const review = await runReviewPipeline({
      bundle: makeBundle(),
      filteredPatch: SAMPLE_PATCH,
      config,
      cwd: process.cwd(),
      registry,
    });

    // Non-canonical ad-hoc codes were filtered before Stage 2 and from final output
    expect(verifierUserPrompt).not.toContain('"A/B"');
    expect(verifierUserPrompt).not.toContain('"upgrade-schema"');
    expect(verifierUserPrompt).toContain('"r-code"');

    expect(review.verdict).toBe('READY');
    expect(review.findings).toHaveLength(0);
    const codes = review.standards?.map((s) => s.code) ?? [];
    expect(codes).toEqual(['r-explain', 'r-code', 'r-tech']);
    // Stage 2 reconciled r-code -> PASS, deterministic pass flipped stale r-tech -> PASS
    expect(review.standards?.find((s) => s.code === 'r-code')?.status).toBe('PASS');
    expect(review.standards?.find((s) => s.code === 'r-tech')?.status).toBe('PASS');
    expect(review.standards?.find((s) => s.code === 'r-tech')?.note).toContain(
      'Reconciled',
    );
  });

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
        notVerified: [],
      },
    });

    const { verificationMatrix } = buildVerificationMatrix(tautBundle);
    const proofRow = verificationMatrix.find(
      (m) => m.check === 'CiviKitchen A/B Proof-of-Fix',
    );
    expect(proofRow).toBeDefined();
    expect(proofRow!.status).toBe('WARN');
    expect(proofRow!.detail).toContain('testOrderByAlwaysIncludesContactId');

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

    expect(review.verdict).toBe('QUESTIONS_ONLY');
    expect(review.findings).toHaveLength(1);
    expect(review.findings[0]!.verdict).toBe('PROVEN');
    expect(review.standards?.find((s) => s.code === 'r-maint')?.status).toBe(
      'ISSUE',
    );
    expect(review.standards?.find((s) => s.code === 'r-run')?.status).toBe(
      'ISSUE',
    );
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
        notVerified: [],
      },
    });

    const { verificationMatrix } = buildVerificationMatrix(guardedBundle);
    const proofRow = verificationMatrix.find(
      (r) => r.check === 'CiviKitchen A/B Proof-of-Fix',
    );
    expect(proofRow?.status).toBe('PASS');
    expect(proofRow?.detail).toContain('1 test(s) red on A, green on B');
    expect(proofRow?.detail).toContain('regression-guard');
    expect(proofRow?.detail).toContain('testGuard');
  });

  test('computeConfidenceScore maps findings and empirical matrix cleanly across 1-5 scale', () => {
    const cleanMatrix = [
      { check: 'CI / Jenkins', status: 'PASS' as const, detail: '1/1 passed' },
      { check: 'CiviKitchen A/B Proof-of-Fix', status: 'PASS' as const, detail: '2 test(s) red on A, green on B' },
      { check: 'Base-Test Regression', status: 'PASS' as const, detail: '30 test(s) passed on A and B' },
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
      verdict: 'READY',
      findings: [],
      verificationMatrix: cleanMatrix,
      prKind: 'core-bugfix',
    });
    expect(s5.score).toBe(5);
    expect(s5.rationale).toContain('No verified issues');

    // 4/5: low-severity finding OR minor surface risk flag
    const s4 = computeConfidenceScore({
      verdict: 'QUESTIONS_ONLY',
      findings: [baseFinding],
      verificationMatrix: cleanMatrix,
      prKind: 'core-bugfix',
    });
    expect(s4.score).toBe(4);

    // 3/5: confirmed medium finding or base-test regression failure
    const s3 = computeConfidenceScore({
      verdict: 'QUESTIONS_ONLY',
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
      verdict: 'NEEDS_CHANGES',
      findings: [{ ...baseFinding, severity: 'high', reassessedSeverity: 'high' }],
      verificationMatrix: cleanMatrix,
      prKind: 'security-sensitive',
    });
    expect(s2.score).toBe(2);

    // 1/5: confirmed critical finding
    const s1 = computeConfidenceScore({
      verdict: 'NEEDS_CHANGES',
      findings: [{ ...baseFinding, severity: 'critical', reassessedSeverity: 'critical', verdict: 'PROVEN' }],
      verificationMatrix: cleanMatrix,
      prKind: 'security-sensitive',
    });
    expect(s1.score).toBe(1);
  });

  test('resolveStageEffort dynamically scales effort per stage and PR risk and respects overrides', () => {
    const baseCfg = loadConfig(process.cwd());
    const smallBundle = makeBundle();
    const cleanMatrix = [
      { check: 'CI / Jenkins', status: 'PASS' as const, detail: 'green' },
    ];
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

    // Default `auto`: triage=low, threadReply=medium, small PR specialist=medium, medium-only verifier=medium
    expect(
      resolveStageEffort({ stage: 'triage', config: baseCfg, bundle: smallBundle }),
    ).toBe('low');
    expect(
      resolveStageEffort({ stage: 'threadReply', config: baseCfg, bundle: smallBundle }),
    ).toBe('medium');
    expect(
      resolveStageEffort({
        stage: 'specialist',
        lens: 'correctness',
        config: baseCfg,
        bundle: smallBundle,
        triage: smallTriage,
        verificationMatrix: cleanMatrix,
      }),
    ).toBe('medium');
    expect(
      resolveStageEffort({
        stage: 'verifier',
        config: baseCfg,
        bundle: smallBundle,
        triage: smallTriage,
        candidates: [medCandidate],
        verificationMatrix: cleanMatrix,
      }),
    ).toBe('medium');

    // Escalates verifier to `high` on high/critical findings, security-sensitive PRs, or failing A/B,
    // while keeping parallel Stage 1 specialists at `medium` in `auto` mode to avoid 4x token burn
    expect(
      resolveStageEffort({
        stage: 'verifier',
        config: baseCfg,
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
        config: baseCfg,
        bundle: smallBundle,
        triage: { ...smallTriage, prKind: 'security-sensitive' },
        verificationMatrix: cleanMatrix,
      }),
    ).toBe('medium');
    expect(
      resolveStageEffort({
        stage: 'verifier',
        config: baseCfg,
        bundle: smallBundle,
        triage: smallTriage,
        candidates: [medCandidate],
        verificationMatrix: [
          { check: 'Base-Test Regression', status: 'FAIL' as const, detail: '1 failed' },
        ],
      }),
    ).toBe('high');

    // Global override and per-stage override precedence
    const globalCfg = loadConfig(process.cwd(), {
      review: { effort: 'xhigh' },
    });
    expect(
      resolveStageEffort({ stage: 'verifier', config: globalCfg }),
    ).toBe('xhigh');

    const perStageCfg = loadConfig(process.cwd(), {
      review: {
        effort: 'low',
        stageEffort: { verifier: 'max' },
      },
    });
    expect(
      resolveStageEffort({ stage: 'triage', config: perStageCfg }),
    ).toBe('low');
    expect(
      resolveStageEffort({ stage: 'verifier', config: perStageCfg }),
    ).toBe('max');
  });
});
