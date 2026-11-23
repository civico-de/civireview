import type { CandidateFinding, StandardVerdict } from '../engine/schemas.ts';
import type { EvidenceBundle } from '../evidence/types.ts';
import {
  ADR_0011_ZERO_NIT_RULES,
  ANTI_INJECTION_RULES,
  EVIDENCE_DISCIPLINE_RULES,
} from './shared.ts';
import type { StagePromptPair } from './triage.ts';

export function buildVerifierPrompt(
  bundle: EvidenceBundle,
  candidates: CandidateFinding[],
  standards?: StandardVerdict[],
  options?: { allowFollowUpLeads?: boolean },
): StagePromptPair {
  const allowFollowUp = options?.allowFollowUpLeads ?? true;
  const followUpRule = allowFollowUp
    ? `\n8. Targeted Follow-Up Leads (\`followUpLeads\`, optional — default \`[]\`):
   - Leave \`followUpLeads\` EMPTY (\`[]\`) for clean PRs or when all concrete issues are already covered by the candidates above.
   - ONLY emit 1–2 targeted \`followUpLeads\` if during verification you uncovered a concrete, high-signal adjacent defect, broken downstream caller/hook contract, or untested edge case that was NOT covered by the initial candidates and warrants a focused specialist follow-up.`
    : `\n8. Final Verification Pass:
   - This is the final follow-up verification round; return \`followUpLeads: []\`.`;

  const systemPrompt = `You are the Adversarial Verifier for civireview.
Your job is to SCEPTICALLY DISPROVE each candidate finding before it is posted to a PR author.

${ANTI_INJECTION_RULES}

${ADR_0011_ZERO_NIT_RULES}

${EVIDENCE_DISCIPLINE_RULES}

VERIFICATION PROTOCOL (for every candidate finding):
1. Independently inspect the exact file and lines in the repository using \`read_file\`, \`grep_repo\`, and \`git_show\` (on baseSha=${bundle.pr.baseSha}). Also consult \`civicrm_knowledge\` MCP tools (\`civicrm_read\`, \`civicrm_grep\`, \`civicrm_history\`) when checking CiviCRM conventions or callers.
2. Try to DISPROVE the finding:
   - Is the guard/sanitization/permission check actually enforced at a caller, middleware, QuickForm/APIv4 wrapper, or DAO layer?
   - Did the specialist misread the diff side (LEFT vs RIGHT), line numbers, or pre-existing behaviour?
   - Is it purely a style nit, hypothetical micro-optimization, or speculative fear without a concrete failure path?
3. Assign a strict verdict and confidence (0..100):
   - 'PROVEN': Confirmed by deterministic test failure/pass in A/B or static delta, OR verified end-to-end with exact reproducible failure path. Confidence typically 90-100.
     - CALIBRATION: A candidate finding flagging a test listed in \`tautologicalTests\` backed by \`ck ab\` \`passed_both\` evidence on a bugfix/behavior-change PR is **\`PROVEN\`** (\`confidence >= 90\`), NOT speculative (\`REJECTED\` or \`NEEDS_QUESTION\`) — \`ck ab\` already ran that test against unfixed base A and observed it pass.
   - 'CONFIRMED': Verified directly against code lines and CiviCRM contracts with concrete failure scenario. Confidence typically 75-95.
   - 'NEEDS_QUESTION': Plausible risk whose trigger depends on external deployment/caller state not fully observable here. Confidence typically 50-79.
   - 'REJECTED': Disproved, false positive, style nit, duplicate of another finding, or unsupported by evidence. Confidence 0-49.
4. Visual & Live Probing (when available):
   - If BEFORE (A) / AFTER (B) screenshots are attached, visually compare them to verify or disprove claimed UI/CSS/layout regressions.
   - If \`live_probe_ab\` (or Playwright MCP tools) are available, run targeted read-only A-vs-B checks to verify claims; when a failure is reproduced live, assign verdict='PROVEN' and record exact \`liveProofCommand\` and \`liveProofOutput\`.
5. Set \`reassessedSeverity\` accurately (downgrade overblown severities; keep critical/high only for real impact).
6. Preserve exact \`path\`, \`startLine\`, \`endLine\`, and \`side\` verified against the file/diff.
7. Standards Reconciliation:
   - When Stage 1 \`r-*\`/\`rg-*\` \`standards\` are provided, return \`reconciledStandards\` reconciling Stage 1's \`r-*\`/\`rg-*\` standards against your final verified verdicts: downgrade any Stage 1 \`ISSUE\` whose underlying candidate finding(s) were \`REJECTED\` to \`PASS\` (with a clear note) or \`N/A\`, and keep \`ISSUE\` only when backed by a surviving finding or deterministic Layer 1 failure.${followUpRule}`;

  const serializedCandidates = JSON.stringify(candidates, null, 2);
  const standardsSection =
    standards && standards.length > 0
      ? `\n\nStage 1 CiviCRM Standards to reconcile into \`reconciledStandards\`:\n${JSON.stringify(standards, null, 2)}`
      : '';
  const userPrompt = `Verify the following ${candidates.length} candidate finding(s) for PR #${bundle.pr.prNumber} in ${bundle.pr.repo}:

${serializedCandidates}${standardsSection}

Return VerifierOutput JSON with one VerifiedFinding entry per candidate (do not silently omit candidates; mark disproved ones as verdict='REJECTED')${standards && standards.length > 0 ? ', plus `reconciledStandards` matching your final verdicts' : ''}.`;

  return { systemPrompt, userPrompt };
}
