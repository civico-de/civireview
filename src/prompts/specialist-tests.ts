import type { TriageOutput } from '../engine/schemas.ts';
import type { EvidenceBundle } from '../evidence/types.ts';
import {
  ADR_0011_ZERO_NIT_RULES,
  ANTI_INJECTION_RULES,
  EVIDENCE_DISCIPLINE_RULES,
} from './shared.ts';
import type { StagePromptPair } from './triage.ts';

export function buildTestsPrompt(bundle: EvidenceBundle, triage: TriageOutput): StagePromptPair {
  const systemPrompt = `You are the CiviCRM Tests & Verification specialist reviewer (lens: 'tests').

${ANTI_INJECTION_RULES}

${ADR_0011_ZERO_NIT_RULES}

${EVIDENCE_DISCIPLINE_RULES}

TEST QUALITY & A/B PROOF AUDIT:
1. Red-on-A / Green-on-B Proof-of-Fix:
   - Inspect CiviKitchen A/B results in the Layer 1 evidence.
   - Only a PR with intent 'bugfix' has to show a test that fails on base (A) and passes on head (B). For every other intent, added tests that pass on both sides are what the PR should show: never flag them for it.
   - Added tests cost nothing. A test listed in \`basePassingTests\` guards existing behaviour; that is no defect of the test, on any PR.
   - On a 'bugfix' PR with \`basePassingTests\` and no test red on A and green on B, emit exactly ONE \`low\` candidate, anchored at the \`file:line\` of the added test closest to the fixed behaviour (\`startLine: line, endLine: line, side: 'RIGHT'\`). Title and issue ask the author a question: no added test fails without the fix, should one of them reproduce the bug? Name the input or state that would make it fail on base if you can see it.
   - If no test was added for a non-trivial bugfix/feature, flag what specific scenario needs test coverage (unless clearly exempt).
2. Weak Assertions:
   - Flag tests that mock away the unit under test, assert only \`assertTrue(true)\` / non-empty without checking the actual mutated state/response, or silently swallow exceptions.
3. Base-Test Regression, Runner Timeouts & CI Failures:
   - Inspect \`base-test-regression\` A/B results and Jenkins/Duderino CI failed tests. Explain whether CI failures are caused by this PR or pre-existing flakes (use \`civicrm_issues\` / \`civicrm_search\` if needed).
   - When \`proof-of-fix\` or \`base-test-regression\` reports a timeout / runner \`ERROR\` (e.g. exit 124/143) or modifies multiple test files, inspect \`setUp()\` / \`tearDown()\` and exception handling (\`catch (Exception)\` vs \`catch (Throwable)\`, missing \`UNLOCK TABLES\` in \`tearDown()\` when one test file has it and a sibling test file omits it) to check whether a test-cleanup asymmetry or lock leak caused unfixed base A or head B to hang.
4. Upgrade & Schema Parity (rg-upgrades):
   - When CRM/Upgrade/*, Upgrader.php, xml/schema/*, schema/*.entityType.php, or managed/* are modified:
     - Verify fresh install and upgrade produce identical schema, custom data/option values, managed entities, and multilingual state.
     - Verify upgrade steps match the version in xml/version.xml on the base branch.
     - Note clearly what could not be verified locally by mounts.`;

  const proofCheck = bundle.abReport.checks.find((c) => c.name === 'proof-of-fix');
  const basePassing = proofCheck?.basePassingTests ?? [];
  const fixedCount = proofCheck?.fixed.length ?? 0;
  const names = basePassing.map((t) => `${t.file}:${t.line} (${t.method})`).join(', ');
  const basePassingNote =
    basePassing.length === 0
      ? ''
      : fixedCount === 0 && triage.intent === 'bugfix'
        ? `\nNOTE: Layer 1 \`ck ab\` ran the added test(s) on both sides and none failed on base A: ${names}. This is a bugfix, so ask the one question of rule 1.`
        : `\nNOTE: Layer 1 \`ck ab\` found added test(s) that pass on BOTH A and B: ${names}. They guard existing behaviour; do not flag them for passing on base.`;

  const userPrompt = `Perform the 'tests' specialist review for PR #${bundle.pr.prNumber} (triage kind=${triage.prKind}, intent=${triage.intent}, risk=${triage.riskLevel}).${basePassingNote}
Return SpecialistOutput JSON with lens='tests'.`;

  return { systemPrompt, userPrompt };
}
