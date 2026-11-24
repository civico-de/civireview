import { describe, expect, test } from 'bun:test';
import { loadConfig } from '../src/config/loader.ts';
import { runReviewPipeline } from '../src/engine/pipeline.ts';
import { withUniqueIds } from '../src/engine/verdicts.ts';
import type { CandidateFinding, VerifiedFinding } from '../src/engine/schemas.ts';
import { formatReviewMarkdown } from '../src/github/formatter.ts';
import { createRunnerRegistry } from '../src/runners/registry.ts';
import type { StageRunner } from '../src/runners/types.ts';
import { makeBundle, SAMPLE_PATCH } from './helpers/bundle.ts';

const SEC_CANDIDATE: CandidateFinding = {
  id: 'sec-1',
  lens: 'security',
  title: "Session receives another account's contact",
  severity: 'high',
  path: 'CRM/Contact/BAO/Contact.php',
  startLine: 11,
  endLine: 12,
  side: 'RIGHT',
  issue: 'The returned contact_id belongs to a different CMS account.',
  failureScenario: 'Second account logs in and acts as the first contact.',
  evidence: 'Line 11 returns the other match.',
  suggestedFix: 'Do not hand over a linked contact.',
  mcpCitations: [],
};

function verdictFor(
  c: CandidateFinding,
  verdict: VerifiedFinding['verdict'],
  confidence: number,
): VerifiedFinding {
  return {
    ...c,
    verdict,
    confidence,
    reassessedSeverity: c.severity,
    verificationEvidence: `Verifier reason for ${c.id}.`,
  };
}

async function runWith(responses: VerifiedFinding[][], confidenceThreshold = 80) {
  const config = loadConfig('/tmp/nonexistent-cfg-dir', {
    preset: 'sonnet',
    review: { maxFollowUpRounds: 0, confidenceThreshold },
  });
  const logLines: string[] = [];
  const verifierCalls: Array<{ stage: string; userPrompt: string }> = [];
  const runner: StageRunner = {
    providers: ['anthropic'],
    async run(req) {
      const base = { model: req.model, provider: 'anthropic' as const, durationMs: 1 };
      if (req.stage === 'triage') {
        return {
          ...base,
          output: req.schema.parse({
            prKind: 'core-bugfix',
            riskLevel: 'medium',
            activeLenses: ['security'],
            summaryBullets: [],
            recommendedAbTests: [],
          }),
        };
      }
      if (req.stage === 'specialist:security') {
        return {
          ...base,
          output: req.schema.parse({
            lens: 'security',
            summary: 'One candidate.',
            findings: [SEC_CANDIDATE],
            checkedWithoutFindings: [],
          }),
        };
      }
      if (req.stage.startsWith('verifier')) {
        const verifiedFindings = responses[verifierCalls.length] ?? [];
        verifierCalls.push({ stage: req.stage, userPrompt: req.userPrompt });
        return { ...base, output: req.schema.parse({ notes: 'n', verifiedFindings }) };
      }
      throw new Error(`Unexpected stage ${req.stage}`);
    },
  };
  const review = await runReviewPipeline({
    bundle: makeBundle(),
    filteredPatch: SAMPLE_PATCH,
    config,
    cwd: process.cwd(),
    registry: createRunnerRegistry({ anthropic: runner }),
    logger: { info: (m) => logLines.push(m), warn: (m) => logLines.push(m) },
  }).catch((error: unknown) => error as Error);
  return { review, logLines, verifierCalls };
}

function reviewOf(result: Awaited<ReturnType<typeof runWith>>) {
  if (result.review instanceof Error) throw result.review;
  return result.review;
}

describe('verifier coverage', () => {
  test('re-asks the verifier for a candidate it returned no verdict for', async () => {
    const result = await runWith([[], [verdictFor(SEC_CANDIDATE, 'CONFIRMED', 90)]]);
    const review = reviewOf(result);

    expect(result.verifierCalls.map((c) => c.stage)).toEqual(['verifier', 'verifier:retry-1']);
    expect(result.verifierCalls[1]!.userPrompt).toContain('sec-1');
    expect(review.findings.map((f) => f.id)).toEqual(['sec-1']);
    expect(result.logLines.some((l) => l.includes('sec-1') && l.includes('retry 1/3'))).toBe(true);
  });

  test('fails the review when a candidate stays without a verdict after the retries', async () => {
    const result = await runWith([]);

    expect(result.review).toBeInstanceOf(Error);
    expect((result.review as Error).message).toBe(
      'Verifier returned no verdict for sec-1 after 3 retries',
    );
    expect(result.verifierCalls).toHaveLength(4);
  });

  test('ignores a verdict for an unknown id and asks again for the real one', async () => {
    const renamed = { ...verdictFor(SEC_CANDIDATE, 'CONFIRMED', 90), id: 'security-1' };
    const result = await runWith([[renamed], [verdictFor(SEC_CANDIDATE, 'CONFIRMED', 90)]]);
    const review = reviewOf(result);

    expect(review.findings.map((f) => f.id)).toEqual(['sec-1']);
    expect(result.logLines.some((l) => l.includes('security-1') && l.includes('unknown id'))).toBe(
      true,
    );
  });

  test('logs a rejected candidate and lists it with its reason without blocking READY', async () => {
    const result = await runWith([[verdictFor(SEC_CANDIDATE, 'REJECTED', 20)]]);
    const review = reviewOf(result);
    const body = formatReviewMarkdown(review, makeBundle()).summaryBody;

    expect(result.verifierCalls).toHaveLength(1);
    expect(review.verdict).toBe('READY');
    expect(review.rejectedFindings?.map((f) => f.id)).toEqual(['sec-1']);
    expect(result.logLines.some((l) => l.includes('sec-1') && l.includes('REJECTED'))).toBe(true);
    expect(body).toContain('Rejected by the Verifier (1)');
    expect(body).toContain('Verifier reason for sec-1.');
  });

  test('a candidate covered on the first call needs no retry and adds no rejected list', async () => {
    const result = await runWith([[verdictFor(SEC_CANDIDATE, 'CONFIRMED', 90)]]);
    const review = reviewOf(result);

    expect(result.verifierCalls).toHaveLength(1);
    expect(review.findings.map((f) => f.id)).toEqual(['sec-1']);
    expect(review.rejectedFindings).toBeUndefined();
  });

  test('a finding posted under a gate below 50 is not listed as rejected', async () => {
    const review = reviewOf(await runWith([[verdictFor(SEC_CANDIDATE, 'CONFIRMED', 45)]], 40));
    expect(review.findings.map((f) => f.id)).toEqual(['sec-1']);
    expect(review.rejectedFindings ?? []).toEqual([]);
  });

  test('candidates of two specialists sharing an id are kept apart', () => {
    const taken = new Set<string>();
    const first = withUniqueIds([SEC_CANDIDATE], taken);
    const second = withUniqueIds([{ ...SEC_CANDIDATE, lens: 'correctness' }, SEC_CANDIDATE], taken);
    expect([...first, ...second].map((c) => c.id)).toEqual(['sec-1', 'sec-1-2', 'sec-1-3']);
    expect(first[0]).toBe(SEC_CANDIDATE);
  });
});
