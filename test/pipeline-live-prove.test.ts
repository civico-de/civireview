import { describe, expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config/loader.ts';
import { runReviewPipeline } from '../src/engine/pipeline.ts';
import { createRunnerRegistry } from '../src/runners/registry.ts';
import type { StageRunner } from '../src/runners/types.ts';
import { makeBundle, SAMPLE_PATCH } from './helpers/bundle.ts';

async function runWith(composeFiles?: { A?: string; B?: string }, supportsExtraTools = true) {
  const config = loadConfig('/tmp/nonexistent-cfg-dir', {
    preset: 'sonnet',
    review: { maxFollowUpRounds: 0 },
  });
  const seen: Array<{ stage: string; liveTool: boolean; note: boolean; settleRule: boolean }> = [];
  const runner: StageRunner = {
    providers: ['anthropic'],
    supportsLiveStacks: supportsExtraTools,
    async run(req) {
      seen.push({
        stage: req.stage,
        liveTool: Boolean(req.liveStacks),
        note: req.userPrompt.includes('LIVE INSTANCES'),
        settleRule: req.systemPrompt.includes('SETTLE GAPS LIVE'),
      });
      const base = { model: req.model, provider: 'anthropic' as const, durationMs: 1 };
      if (req.stage === 'triage') {
        return {
          ...base,
          output: req.schema.parse({
            prKind: 'core-bugfix',
            intent: 'bugfix',
            riskLevel: 'medium',
            activeLenses: ['correctness'],
            summaryBullets: ['NOT VERIFIED: the job was not run.'],
            recommendedAbTests: [],
          }),
        };
      }
      if (req.stage.startsWith('specialist:')) {
        return {
          ...base,
          output: req.schema.parse({
            lens: 'correctness',
            summary: 'Nothing found.',
            findings: [],
            checkedWithoutFindings: [],
          }),
        };
      }
      return { ...base, output: req.schema.parse({ notes: 'n', verifiedFindings: [] }) };
    },
  };
  const review = await runReviewPipeline({
    bundle: makeBundle(),
    filteredPatch: SAMPLE_PATCH,
    config,
    cwd: process.cwd(),
    ...(composeFiles ? { composeFiles } : {}),
    registry: createRunnerRegistry({ anthropic: runner }),
    logger: { info: () => {}, warn: () => {} },
  });
  return { review, seen };
}

describe('live instances in the review stages', () => {
  test('specialists and verifier get the live tool when both stacks are kept', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'civireview-live-'));
    const A = join(dir, 'a.yml');
    const B = join(dir, 'b.yml');
    writeFileSync(A, 'services: {}');
    writeFileSync(B, 'services: {}');

    const { seen } = await runWith({ A, B });
    const specialist = seen.find((s) => s.stage === 'specialist:correctness');
    const verifier = seen.find((s) => s.stage === 'verifier');
    expect(specialist).toMatchObject({ liveTool: true, note: true });
    expect(verifier).toMatchObject({ liveTool: true, note: true, settleRule: true });
    expect(seen.find((s) => s.stage === 'triage')?.liveTool).toBe(false);
  });

  test('without kept stacks no stage gets the tool or its instructions', async () => {
    const { seen } = await runWith();
    expect(seen.length).toBeGreaterThan(2);
    for (const s of seen) {
      expect(s).toMatchObject({ liveTool: false, note: false, settleRule: false });
    }
  });

  test('a runner that cannot pass tools on gets neither the tool nor its instructions', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'civireview-live-'));
    const A = join(dir, 'a.yml');
    const B = join(dir, 'b.yml');
    writeFileSync(A, 'services: {}');
    writeFileSync(B, 'services: {}');
    const { seen } = await runWith({ A, B }, false);
    for (const s of seen) {
      expect(s).toMatchObject({ liveTool: false, note: false, settleRule: false });
    }
  });

  test('one kept stack is not enough', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'civireview-live-'));
    const A = join(dir, 'a.yml');
    writeFileSync(A, 'services: {}');
    const { seen } = await runWith({ A });
    expect(seen.some((s) => s.liveTool)).toBe(false);
  });
});
