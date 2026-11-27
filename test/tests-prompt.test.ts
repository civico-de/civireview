import { describe, expect, test } from 'bun:test';
import { TriageOutputSchema, type ChangeIntent } from '../src/engine/schemas.ts';
import { buildTestsPrompt } from '../src/prompts/specialist-tests.ts';
import { makeBundle } from './helpers/bundle.ts';

const triage = (intent: ChangeIntent) => ({
  prKind: 'extension-pr' as const,
  intent,
  riskLevel: 'low' as const,
  activeLenses: ['tests' as const],
  summaryBullets: [],
  recommendedAbTests: [],
});

/** A proof-of-fix run whose only added test passes on both sides. */
function bundleWithBasePassingTest(fixed: string[] = []) {
  const bundle = makeBundle();
  const proof = bundle.abReport.checks[0]!;
  proof.fixed = fixed;
  proof.basePassingTests = [
    { file: 'tests/XTest.php', method: 'testX', line: 3, testCaseName: 'XTest::testX' },
  ];
  return bundle;
}

describe('tests lens and added tests that pass on base', () => {
  test('triage has to say what the change is for', () => {
    const { intent: _intent, ...withoutIntent } = triage('bugfix');
    expect(TriageOutputSchema.safeParse(withoutIntent).success).toBe(false);
    expect(TriageOutputSchema.parse(triage('tests-only')).intent).toBe('tests-only');
  });

  test('only an unproven bugfix is asked whether a test should reproduce the bug', () => {
    const ask = 'This is a bugfix, so ask the one question of rule 1.';
    const leave = 'do not flag them for passing on base';

    const bugfix = buildTestsPrompt(bundleWithBasePassingTest(), triage('bugfix')).userPrompt;
    expect(bugfix).toContain('intent=bugfix');
    expect(bugfix).toContain('tests/XTest.php:3 (testX)');
    expect(bugfix).toContain(ask);

    for (const intent of ['feature', 'refactor', 'tests-only', 'docs'] as const) {
      const prompt = buildTestsPrompt(bundleWithBasePassingTest(), triage(intent)).userPrompt;
      expect(prompt).toContain(leave);
      expect(prompt).not.toContain(ask);
    }

    // A bugfix proven by another test: the extra test is a guard.
    const proven = buildTestsPrompt(bundleWithBasePassingTest(['XTest::testY']), triage('bugfix'));
    expect(proven.userPrompt).toContain(leave);
    expect(proven.userPrompt).not.toContain(ask);
  });

  test('the rules call a test that passes on both sides a guard, never a defect', () => {
    const { systemPrompt } = buildTestsPrompt(makeBundle(), triage('bugfix'));
    expect(systemPrompt).toContain('Added tests cost nothing.');
    expect(systemPrompt).not.toMatch(/tautolog/i);
  });
});
