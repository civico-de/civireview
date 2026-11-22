import type { TriageOutput } from '../engine/schemas.ts';
import type { EvidenceBundle } from '../evidence/types.ts';
import {
  ADR_0011_ZERO_NIT_RULES,
  ANTI_INJECTION_RULES,
  EVIDENCE_DISCIPLINE_RULES,
} from './shared.ts';
import type { StagePromptPair } from './triage.ts';

export function buildTestsPrompt(
  bundle: EvidenceBundle,
  triage: TriageOutput,
): StagePromptPair {
  const systemPrompt = `You are the CiviCRM Tests & Verification specialist reviewer (lens: 'tests').

${ANTI_INJECTION_RULES}

${ADR_0011_ZERO_NIT_RULES}

${EVIDENCE_DISCIPLINE_RULES}

TEST QUALITY & A/B PROOF AUDIT:
1. Red-on-A / Green-on-B Proof-of-Fix:
   - Inspect CiviKitchen A/B results in the Layer 1 evidence.
   - A bugfix or behavioural PR whose new test passes on BOTH base (A) and head (B) proves nothing — flag tautological or non-reproducing tests!
   - If \`tautologicalTests\` is non-empty on a bugfix or behavior-change PR, emit a concrete \`medium\` candidate finding anchored directly at the exact \`file:line\` (\`startLine: line, endLine: line, side: 'RIGHT'\`) of the tautological test method explaining that \`ck ab\` proved it already passed on unfixed base A (\`fixed: 0\` / did not reproduce the bug on A).
   - If no test was added for a non-trivial bugfix/feature, flag what specific scenario needs test coverage (unless clearly exempt).
2. Tautological / Weak Assertions:
   - Flag tests that mock away the unit under test, assert only \`assertTrue(true)\` / non-empty without checking the actual mutated state/response, or silently swallow exceptions.
3. Base-Test Regression & CI Failures:
   - Inspect \`base-test-regression\` A/B results and Jenkins/Duderino CI failed tests. Explain whether CI failures are caused by this PR or pre-existing flakes (use \`civicrm_issues\` / \`civicrm_search\` if needed).
4. Upgrade & Schema Parity (rg-upgrades):
   - When CRM/Upgrade/*, Upgrader.php, xml/schema/*, schema/*.entityType.php, or managed/* are modified:
     - Verify fresh install and upgrade produce identical schema, custom data/option values, managed entities, and multilingual state.
     - Verify upgrade steps match the version in xml/version.xml on the base branch.
     - Note clearly what could not be verified locally by mounts.`;

  const proofCheck = bundle.abReport.checks.find(
    (c) => c.name === 'proof-of-fix',
  );
  const tautological = proofCheck?.tautologicalTests ?? [];
  const fixedCount = proofCheck?.fixed.length ?? 0;
  const tautNote =
    tautological.length > 0
      ? fixedCount === 0
        ? `\nNOTE: Layer 1 \`ck ab\` detected tautological added test(s) that PASSED on unfixed base A with 0 red-on-A/green-on-B tests: ${tautological.map((t) => `${t.file}:${t.line} (${t.method})`).join(', ')}. Anchor a \`medium\` finding directly at \`file:line\` if this PR fixes a bug or changes behavior.`
        : `\nNOTE: Layer 1 \`ck ab\` proved ${fixedCount} test(s) red-on-A -> green-on-B, while these additional added test(s) passed on BOTH A and B: ${tautological.map((t) => `${t.file}:${t.line} (${t.method})`).join(', ')}. Only flag them if they fail to exercise their intended regression guard (do not penalize genuine non-regression guards).`
      : '';

  const userPrompt = `Perform the 'tests' specialist review for PR #${bundle.pr.prNumber} (triage kind=${triage.prKind}, risk=${triage.riskLevel}).${tautNote}
Return SpecialistOutput JSON with lens='tests'.`;

  return { systemPrompt, userPrompt };
}
