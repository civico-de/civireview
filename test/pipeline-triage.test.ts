import { describe, expect, test } from 'bun:test';
import { loadConfig } from '../src/config/loader.ts';
import { runReviewPipeline } from '../src/engine/pipeline.ts';
import { createRunnerRegistry } from '../src/runners/registry.ts';
import type { StageRunner } from '../src/runners/types.ts';
import { makeBundle } from './helpers/bundle.ts';

const finding = (id: string, line: number) => ({
  id,
  lens: 'correctness',
  title: `Finding ${id}`,
  severity: 'medium',
  path: 'CRM/Contact/BAO/Contact.php',
  startLine: line,
  endLine: line,
  side: 'RIGHT',
  issue: 'Issue',
  failureScenario: 'Scenario',
  evidence: 'Evidence',
  suggestedFix: 'Fix',
  mcpCitations: [],
});

describe('review pipeline triage and finding cap', () => {
  test('refuses to report READY when triage selects no lens and gives no reason', async () => {
    const config = loadConfig('/tmp/nonexistent-cfg-dir', { preset: 'sonnet' });
    const mockRunner: StageRunner = {
      providers: ['anthropic'],
      async run(req) {
        return {
          output: req.schema.parse({
            prKind: 'core-bugfix',
            riskLevel: 'low',
            activeLenses: [],
            summaryBullets: ['Changes a query.'],
            recommendedAbTests: [],
          }),
          model: req.model,
          provider: 'anthropic',
          durationMs: 1,
        };
      },
    };

    await expect(
      runReviewPipeline({
        bundle: makeBundle(),
        filteredPatch: '',
        config,
        cwd: process.cwd(),
        registry: createRunnerRegistry({ anthropic: mockRunner }),
      }),
    ).rejects.toThrow(/no active lenses and no skipReason/);
  });

  test('names the config as the reason when every selected lens is disabled', async () => {
    const config = loadConfig('/tmp/nonexistent-cfg-dir', {
      preset: 'sonnet',
      review: { exclude: ['correctness'] },
    });
    const mockRunner: StageRunner = {
      providers: ['anthropic'],
      async run(req) {
        return {
          output: req.schema.parse({
            prKind: 'core-bugfix',
            riskLevel: 'low',
            activeLenses: ['correctness'],
            summaryBullets: ['Changes a query.'],
            recommendedAbTests: [],
          }),
          model: req.model,
          provider: 'anthropic',
          durationMs: 1,
        };
      },
    };

    const review = await runReviewPipeline({
      bundle: makeBundle(),
      filteredPatch: '',
      config,
      cwd: process.cwd(),
      registry: createRunnerRegistry({ anthropic: mockRunner }),
    });
    expect(review.walkthrough.join(' ')).toContain('disabled by config');
  });

  test('keeps findings beyond maxInlineComments so the formatter can move them to the summary', async () => {
    const config = loadConfig('/tmp/nonexistent-cfg-dir', {
      preset: 'sonnet',
      review: { confidenceThreshold: 80, maxInlineComments: 1 },
    });
    const candidates = [finding('a', 11), finding('b', 13)];

    const mockRunner: StageRunner = {
      providers: ['anthropic'],
      async run(req) {
        let output: unknown;
        if (req.stage === 'triage') {
          output = {
            prKind: 'core-bugfix',
            riskLevel: 'low',
            activeLenses: ['correctness'],
            summaryBullets: ['Changes a query.'],
            recommendedAbTests: [],
          };
        } else if (req.stage === 'specialist:correctness') {
          output = {
            lens: 'correctness',
            summary: 'ok',
            findings: candidates,
            checkedWithoutFindings: [],
          };
        } else {
          output = {
            notes: 'ok',
            verifiedFindings: candidates.map((c) => ({
              ...c,
              reassessedSeverity: 'medium',
              verdict: 'CONFIRMED',
              confidence: 90,
              verificationEvidence: 'Confirmed',
            })),
          };
        }
        return {
          output: req.schema.parse(output),
          model: req.model,
          provider: 'anthropic',
          durationMs: 1,
        };
      },
    };

    const review = await runReviewPipeline({
      bundle: makeBundle(),
      filteredPatch: '',
      config,
      cwd: process.cwd(),
      registry: createRunnerRegistry({ anthropic: mockRunner }),
    });
    expect(review.findings.map((f) => f.id).toSorted()).toEqual(['a', 'b']);
  });
});
