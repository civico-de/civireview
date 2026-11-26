import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config/loader.ts';
import { parseUnifiedDiff } from '../src/evidence/diff-filter.ts';
import { runReviewPipeline, runThreadReply } from '../src/engine/pipeline.ts';
import { FinalReviewSchema } from '../src/engine/schemas.ts';
import { makeBundle, SAMPLE_PATCH } from './helpers/bundle.ts';
import { createRunnerRegistry } from '../src/runners/registry.ts';
import { parseModelSpec, type StageImageInput, type StageRunner } from '../src/runners/types.ts';

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
                  verificationEvidence:
                    'Verified directly against CRM_Core_DAO::executeQuery contract.',
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
    expect(stageCalls.find((c) => c.stage === 'triage')?.model).toBe('anthropic:claude-haiku-5-5');
    expect(stageCalls.find((c) => c.stage === 'specialist:security')?.model).toBe(
      'google:gemini-2.5-pro',
    );
    expect(stageCalls.find((c) => c.stage === 'verifier')?.model).toBe('openai:gpt-5.2');
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
    expect(review.verificationMatrix.find((m) => m.check === 'A/B Proof-of-Fix')?.status).toBe(
      'PASS',
    );
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
      bundle: makeBundle({
        diffFiles: parseUnifiedDiff(`diff --git a/README.md b/README.md
--- a/README.md
+++ b/README.md
@@ -1,2 +1,3 @@
 # Title
+One more sentence.
 End.
`),
      }),
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
        cmsDemos: [],
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
    expect(stagesRun.map((s) => s.stage)).toEqual(['triage', 'specialist:ui', 'verifier']);
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

  test('runs Stage 1 specialists sequentially for cache warming and logs per-stage token/cache telemetry', async () => {
    const config = loadConfig('/tmp/nonexistent-cfg-dir', { preset: 'sonnet-opus' });
    let inFlightSpecialists = 0;
    let maxConcurrentSpecialists = 0;
    const logs: string[] = [];

    const mockRunner: StageRunner = {
      providers: ['anthropic'],
      async run(req) {
        if (req.stage.startsWith('specialist:')) {
          inFlightSpecialists += 1;
          maxConcurrentSpecialists = Math.max(maxConcurrentSpecialists, inFlightSpecialists);
          await new Promise((r) => setTimeout(r, 5));
          inFlightSpecialists -= 1;
        }
        if (req.stage === 'triage') {
          return {
            output: req.schema.parse({
              prKind: 'core-bugfix',
              riskLevel: 'medium',
              activeLenses: ['correctness', 'security', 'tests'],
              summaryBullets: ['NEEDS_QUESTION: Unverified triage note'],
              recommendedAbTests: [],
            }),
            model: req.model,
            provider: 'anthropic',
            durationMs: 1200,
            usage: {
              inputTokens: 1000,
              outputTokens: 200,
              totalTokens: 1200,
              steps: 4,
              toolCalls: 6,
            },
          };
        }
        if (req.stage === 'verifier') {
          return {
            output: req.schema.parse({
              verifiedFindings: [],
              reconciledWalkthrough: ['CONFIRMED: Verified by Opus verifier in deep mode'],
              notes: 'Clean PR verified in deep mode',
            }),
            model: req.model,
            provider: 'anthropic',
            durationMs: 2500,
            usage: {
              inputTokens: 100,
              cacheWriteInputTokens: 500,
              cachedInputTokens: 19_500,
              outputTokens: 250,
              totalTokens: 20_350,
              steps: 5,
              toolCalls: 8,
            },
          };
        }
        const lens = req.stage.replace('specialist:', '');
        const isFirst = req.stage === 'specialist:correctness';
        return {
          output: req.schema.parse({
            lens,
            summary: 'Checked cleanly.',
            findings: [],
            checkedWithoutFindings: ['CRM/Contact/BAO/Contact.php'],
          }),
          model: req.model,
          provider: 'anthropic',
          durationMs: 3400,
          usage: {
            inputTokens: 500,
            cacheWriteInputTokens: isFirst ? 20_000 : 1_000,
            cachedInputTokens: isFirst ? 0 : 19_000,
            outputTokens: 300,
            totalTokens: 20_800,
            steps: 7,
            toolCalls: 11,
          },
        };
      },
    };

    const registry = createRunnerRegistry({ anthropic: mockRunner });
    const review = await runReviewPipeline({
      bundle: makeBundle(),
      filteredPatch: SAMPLE_PATCH,
      config,
      cwd: process.cwd(),
      registry,
      logger: { info: (msg) => logs.push(msg) },
    });

    expect(maxConcurrentSpecialists).toBe(1);
    expect(review.walkthrough).toEqual(['CONFIRMED: Verified by Opus verifier in deep mode']);
    expect(
      logs.some(
        (l) =>
          l.includes('[stage] triage') &&
          l.includes('effort=high') &&
          l.includes('steps=4/10 tools=6'),
      ),
    ).toBe(true);
    expect(
      logs.some(
        (l) =>
          l.includes('[stage] specialist:correctness') &&
          l.includes('steps=7/35 tools=11') &&
          l.includes('cache_write=20,000') &&
          l.includes('0% hit'),
      ),
    ).toBe(true);
    expect(
      logs.some(
        (l) =>
          l.includes('[stage] specialist:security') &&
          l.includes('cache_read=19,000') &&
          l.includes('93% hit'),
      ),
    ).toBe(true);
    expect(logs.some((l) => l.includes('[telemetry] total stages=5') && l.includes('cost=$'))).toBe(
      true,
    );
  });

  test('executes bounded verifier follow-up investigation loop and stops at maxFollowUpRounds', async () => {
    const config = loadConfig('/tmp/nonexistent-cfg-dir', {
      preset: 'sonnet-opus',
      review: { maxFollowUpRounds: 1 },
    });
    const stagesRun: string[] = [];

    const mockRunner: StageRunner = {
      providers: ['anthropic'],
      async run(req) {
        stagesRun.push(req.stage);
        if (req.stage === 'triage') {
          return {
            output: req.schema.parse({
              prKind: 'core-bugfix',
              riskLevel: 'medium',
              activeLenses: ['correctness'],
              summaryBullets: ['Changes entityInfo contract'],
              recommendedAbTests: [],
            }),
            model: req.model,
            provider: 'anthropic',
            durationMs: 100,
          };
        }
        if (req.stage === 'specialist:correctness') {
          return {
            output: req.schema.parse({
              lens: 'correctness',
              summary: 'Initial check',
              findings: [
                {
                  id: 'init-1',
                  lens: 'correctness',
                  title: 'Initial candidate',
                  severity: 'medium',
                  path: 'CRM/Contact/BAO/Contact.php',
                  startLine: 11,
                  endLine: 11,
                  side: 'RIGHT',
                  issue: 'Initial issue',
                  failureScenario: 'Fails on null',
                  evidence: 'Line 11',
                  suggestedFix: 'Guard null',
                  mcpCitations: [],
                },
              ],
              checkedWithoutFindings: [],
            }),
            model: req.model,
            provider: 'anthropic',
            durationMs: 200,
          };
        }
        if (req.stage === 'verifier') {
          return {
            output: req.schema.parse({
              verifiedFindings: [
                {
                  id: 'init-1',
                  lens: 'correctness',
                  title: 'Initial candidate',
                  severity: 'medium',
                  reassessedSeverity: 'medium',
                  verdict: 'REJECTED',
                  confidence: 20,
                  path: 'CRM/Contact/BAO/Contact.php',
                  startLine: 11,
                  endLine: 11,
                  side: 'RIGHT',
                  issue: 'Initial issue',
                  failureScenario: 'Fails on null',
                  evidence: 'Line 11',
                  verificationEvidence: 'Disproved',
                  suggestedFix: 'None',
                  mcpCitations: [],
                },
              ],
              followUpLeads: [
                {
                  lens: 'correctness',
                  question: 'Check downstream JS decorators reading entityInfo.name',
                  targetPaths: ['CRM/Contact/BAO/Contact.php'],
                  reason: 'Verifier spotted contract shape change',
                },
              ],
              notes: 'Need follow-up on entityInfo callers',
            }),
            model: req.model,
            provider: 'anthropic',
            durationMs: 250,
          };
        }
        if (req.stage === 'specialist:correctness:followup-1') {
          expect(req.userPrompt).toContain('FOLLOW-UP INVESTIGATION (Round 1/1');
          expect(req.userPrompt).toContain('entityInfo.name');
          return {
            output: req.schema.parse({
              lens: 'correctness',
              summary: 'Found broken caller',
              findings: [
                {
                  id: 'fu-1',
                  lens: 'correctness',
                  title: 'Downstream caller breaks on entityInfo map',
                  severity: 'high',
                  path: 'CRM/Contact/BAO/Contact.php',
                  startLine: 11,
                  endLine: 11,
                  side: 'RIGHT',
                  issue: 'entityInfo changed from record to map',
                  failureScenario: 'Extensions reading entityInfo.name fail',
                  evidence: 'Line 11',
                  suggestedFix: 'Keep backward-compatible shape',
                  mcpCitations: [],
                },
              ],
              checkedWithoutFindings: [],
            }),
            model: req.model,
            provider: 'anthropic',
            durationMs: 180,
          };
        }
        return {
          output: req.schema.parse({
            verifiedFindings: [
              {
                id: 'fu-1',
                lens: 'correctness',
                title: 'Downstream caller breaks on entityInfo map',
                severity: 'high',
                reassessedSeverity: 'high',
                verdict: 'CONFIRMED',
                confidence: 92,
                path: 'CRM/Contact/BAO/Contact.php',
                startLine: 11,
                endLine: 11,
                side: 'RIGHT',
                issue: 'entityInfo changed from record to map',
                failureScenario: 'Extensions reading entityInfo.name fail',
                evidence: 'Line 11',
                verificationEvidence: 'Verified in callers',
                suggestedFix: 'Keep backward-compatible shape',
                mcpCitations: [],
              },
            ],
            followUpLeads: [
              {
                lens: 'security',
                question: 'Should not run past maxFollowUpRounds',
                targetPaths: [],
                reason: 'Cap test',
              },
            ],
            notes: 'Confirmed follow-up finding',
          }),
          model: req.model,
          provider: 'anthropic',
          durationMs: 220,
        };
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

    expect(stagesRun).toEqual([
      'triage',
      'specialist:correctness',
      'verifier',
      'specialist:correctness:followup-1',
      'verifier:followup-1',
    ]);
    expect(review.findings).toHaveLength(1);
    expect(review.findings[0]!.id).toBe('fu-1');
    expect(review.verdict).toBe('NEEDS_CHANGES');
  });
});
