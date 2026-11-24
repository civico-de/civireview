import { describe, expect, test } from 'bun:test';
import { loadConfig } from '../src/config/loader.ts';
import { assertBudgetEnforceable, assertWithinBudget } from '../src/engine/budget.ts';
import { runReviewPipeline } from '../src/engine/pipeline.ts';
import { createRunnerRegistry } from '../src/runners/registry.ts';
import type { StageRunner } from '../src/runners/types.ts';
import { makeBundle, SAMPLE_PATCH } from './helpers/bundle.ts';

/** Runs the pipeline with every stage costing `usdPerStage`; returns the stages that ran. */
async function runWithBudget(maxBudgetUsd: number | undefined, usdPerStage: number | undefined) {
  const config = loadConfig('/tmp/nonexistent-cfg-dir', {
    preset: 'sonnet',
    review: { maxFollowUpRounds: 0, ...(maxBudgetUsd === undefined ? {} : { maxBudgetUsd }) },
  });
  const stages: string[] = [];
  const runner: StageRunner = {
    providers: ['anthropic'],
    async run(req) {
      stages.push(req.stage);
      const usage = {
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        ...(usdPerStage === undefined ? {} : { estimatedUsd: usdPerStage }),
      };
      const base = { model: req.model, provider: 'anthropic' as const, durationMs: 1, usage };
      if (req.stage === 'triage') {
        return {
          ...base,
          output: req.schema.parse({
            prKind: 'core-bugfix',
            riskLevel: 'medium',
            activeLenses: ['correctness', 'security'],
            summaryBullets: [],
            recommendedAbTests: [],
          }),
        };
      }
      if (req.stage.startsWith('specialist:')) {
        return {
          ...base,
          output: req.schema.parse({
            lens: req.stage.split(':')[1],
            summary: 'Nothing.',
            findings: [],
            checkedWithoutFindings: [],
          }),
        };
      }
      return { ...base, output: req.schema.parse({ notes: 'n', verifiedFindings: [] }) };
    },
  };
  const result = await runReviewPipeline({
    bundle: makeBundle(),
    filteredPatch: SAMPLE_PATCH,
    config,
    cwd: process.cwd(),
    registry: createRunnerRegistry({ anthropic: runner }),
  }).catch((error: unknown) => error as Error);
  return { result, stages };
}

describe('review.maxBudgetUsd', () => {
  test('stops before the stage that follows the one reaching the cap', async () => {
    const { result, stages } = await runWithBudget(1, 0.5);
    expect(stages).toEqual(['triage', 'specialist:correctness']);
    expect((result as Error).message).toBe(
      'Review stopped before specialist:security: estimated cost $1.00 reached review.maxBudgetUsd $1.00',
    );
  });

  test('a review under the cap runs every stage', async () => {
    const { result, stages } = await runWithBudget(5, 0.5);
    expect(result).not.toBeInstanceOf(Error);
    expect(stages).toEqual(['triage', 'specialist:correctness', 'specialist:security', 'verifier']);
  });

  test('without a cap no cost stops the review', async () => {
    const { result, stages } = await runWithBudget(undefined, 500);
    expect(result).not.toBeInstanceOf(Error);
    expect(stages).toHaveLength(4);
  });

  test('stages without a cost estimate are not capped', async () => {
    const { result } = await runWithBudget(0.01, undefined);
    expect(result).not.toBeInstanceOf(Error);
  });

  test('the cap applies to the verifier as well', () => {
    expect(() => assertWithinBudget(2, 2, 'verifier')).toThrow(/before verifier/);
    expect(() => assertWithinBudget(1.99, 2, 'verifier')).not.toThrow();
  });
});

const withVerifier = (maxBudgetUsd?: number) =>
  loadConfig('/tmp/nonexistent-cfg-dir', {
    preset: 'sonnet',
    models: { verifier: 'codex-cli:some-model' },
    ...(maxBudgetUsd === undefined ? {} : { review: { maxBudgetUsd } }),
  });

describe('assertBudgetEnforceable', () => {
  test('a cap with a runner that reports no usage is rejected', () => {
    expect(() => assertBudgetEnforceable(withVerifier(5))).toThrow(
      /cannot be enforced for codex-cli:some-model/,
    );
  });

  test('no cap, or a cap with metered runners only, is accepted', () => {
    expect(() => assertBudgetEnforceable(withVerifier())).not.toThrow();
    expect(() =>
      assertBudgetEnforceable(
        loadConfig('/tmp/nonexistent-cfg-dir', { preset: 'sonnet', review: { maxBudgetUsd: 5 } }),
      ),
    ).not.toThrow();
  });
});
