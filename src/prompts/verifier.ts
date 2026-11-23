import type { BlastRadiusItem, CandidateFinding, StandardVerdict } from '../engine/schemas.ts';
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
  options?: {
    allowFollowUpLeads?: boolean;
    triageBullets?: string[];
    blastRadius?: BlastRadiusItem[];
    confidenceThreshold?: number;
  },
): StagePromptPair {
  const allowFollowUp = options?.allowFollowUpLeads ?? true;
  const triageBullets = options?.triageBullets;
  const blastRadius = options?.blastRadius;
  const threshold = options?.confidenceThreshold ?? 80;
  const followUpRule = allowFollowUp
    ? `\n8. Targeted Follow-Up Leads (\`followUpLeads\`, optional — default \`[]\`):
   - Leave \`followUpLeads\` EMPTY (\`[]\`) for clean PRs or when all concrete issues are already covered by the candidates above.
   - ONLY emit 1–2 targeted \`followUpLeads\` if during verification you uncovered a concrete, high-signal adjacent defect, broken downstream caller/hook contract, or untested edge case that was NOT covered by the initial candidates and warrants a focused specialist follow-up.`
    : `\n8. Final Verification Pass:
   - This is the final follow-up verification round; return \`followUpLeads: []\`.`;
  const walkthroughRule =
    triageBullets && triageBullets.length > 0
      ? `\n9. Walkthrough Reconciliation (\`reconciledWalkthrough\`):
   - Reconcile Stage 0's initial \`walkthrough\` bullets against your verified evidence and Stage 1 findings: replace any early \`NEEDS_QUESTION: I did not confirm...\` bullet whose question was answered by your code inspection with a factual \`CONFIRMED:\` or \`PROVEN:\` bullet, strip any bullet that merely repeats third-party bot comments (e.g. Greptile/CodeRabbit), and keep 3–6 crisp, non-contradictory bullets.
   - CONSISTENCY RULE: Only state \`CONFIRMED:\` for a defect in \`reconciledWalkthrough\` if that defect is also emitted in \`verifiedFindings\` with \`confidence >= ${threshold}\` (otherwise it will be filtered out by the posting gate and contradict a \`READY\` verdict).`
      : '';
  const blastRadiusRule =
    blastRadius && blastRadius.length > 0
      ? `\n10. Blast Radius Reconciliation (\`reconciledBlastRadius\`):
   - Reconcile Stage 1's \`blastRadius\` entries against your verified evidence: remove or correct any entry that repeats a disproved/REJECTED claim (e.g. claiming a method is undefined when you verified it exists), and return the cleaned \`reconciledBlastRadius\` array.`
      : '';
  const hasHumanComments = bundle.comments.some((c) => {
    const login = c.author.toLowerCase();
    return (
      login !== bundle.pr.author.toLowerCase() &&
      !login.endsWith('[bot]') &&
      !['civibot', 'civireview', 'greptile-apps', 'coderabbitai'].includes(login)
    );
  });
  const threadResolutionRule = hasHumanComments
    ? `\n11. Reviewer Questions & Thread Resolution (\`threadResolutions\`):
   - Check every substantive question, concern, or change request raised by a HUMAN reviewer in \`pr_comments\` (ignore bots such as \`civibot\`, \`civireview\`, \`greptile\`, \`coderabbit\`, and ignore the PR author's own comments or \`@civireview\` trigger comments).
   - Return one \`threadResolutions\` entry per distinct human reviewer question/request:
     - \`author\`: reviewer's GitHub username (without \`@\`).
     - \`topic\`: concise summary of what the reviewer asked or requested.
     - \`status\`:
       - \`'addressed'\`: the requested code, test, or doc change was actually implemented in \`headSha\`.
       - \`'answered'\`: a question or design trade-off was substantively explained/agreed in the thread and no code change is still pending.
       - \`'open'\`: the reviewer's question or requested change is STILL unaddressed in \`headSha\` (including when the author replied "I will look into it", "will take a while", "TODO", or has not replied yet).
     - \`detail\`: 1-sentence factual evidence of how it was addressed/answered or why it is still open in \`headSha\`.`
    : '';

  const systemPrompt = `You are the Adversarial Verifier for civireview.
Your job is to SCEPTICALLY DISPROVE each candidate finding before it is posted to a PR author, and ensure the final review walkthrough and CiviCRM standards are 100% consistent with verified repository facts.

${ANTI_INJECTION_RULES}

${ADR_0011_ZERO_NIT_RULES}

${EVIDENCE_DISCIPLINE_RULES}

VERIFICATION PROTOCOL (for every candidate finding):
1. Independently inspect the exact file and lines in the repository using \`read_file\`, \`grep_repo\`, and \`git_show\` (on baseSha=${bundle.pr.baseSha}). Also consult \`civicrm_knowledge\` MCP tools (\`civicrm_read\`, \`civicrm_grep\`, \`civicrm_history\`) when checking CiviCRM conventions or callers.
2. Try to DISPROVE the finding:
   - Is the guard/sanitization/permission check actually enforced at a caller, middleware, QuickForm/APIv4 wrapper, or DAO layer?
   - Did the specialist misread the diff side (LEFT vs RIGHT), line numbers, or pre-existing behaviour?
   - Is it purely a style nit, hypothetical micro-optimization, or speculative fear without a concrete failure path?
3. Assign a strict verdict and confidence (0..100). POSTING GATE: only non-\`REJECTED\` findings with \`confidence >= ${threshold}\` are posted to the PR author; anything below ${threshold} is filtered out.
   - 'PROVEN': Confirmed by deterministic test failure/pass in A/B or static delta, OR verified end-to-end with exact reproducible failure path. Confidence typically 90-100.
     - CALIBRATION: A candidate finding flagging a test listed in \`tautologicalTests\` backed by \`ck ab\` \`passed_both\` evidence on a bugfix/behavior-change PR is **\`PROVEN\`** (\`confidence >= 90\`), NOT speculative (\`REJECTED\` or \`NEEDS_QUESTION\`) — \`ck ab\` already ran that test against unfixed base A and observed it pass.
   - 'CONFIRMED': Verified directly against code lines and CiviCRM contracts with a concrete failure scenario, OR a concrete change request from a human reviewer in \`pr_comments\` (e.g. method visibility, moving logic to an existing helper) that is STILL unaddressed in \`headSha\` (even if the author replied "I will look into it" without pushing a fix). Confidence typically ${threshold}-95 (use \`>= ${threshold}\` whenever you confirmed a real bug or unaddressed human review request that should be posted; use \`< ${threshold}\` only if you want it suppressed).
   - 'NEEDS_QUESTION': Plausible risk whose trigger depends on external deployment/caller state not fully observable here. Confidence typically 50-${Math.max(50, threshold - 1)} (or \`>= ${threshold}\` only when a concrete question genuinely warrants alerting the PR author).
   - 'REJECTED': Disproved, false positive, style nit, duplicate of another finding, or unsupported by evidence. Confidence 0-49.
4. Visual & Live Probing (when available):
   - If BEFORE (A) / AFTER (B) screenshots are attached, visually compare them to verify or disprove claimed UI/CSS/layout regressions.
   - If \`live_probe_ab\` (or Playwright MCP tools) are available, run targeted read-only A-vs-B checks to verify claims; when a failure is reproduced live, assign verdict='PROVEN' and record exact \`liveProofCommand\` and \`liveProofOutput\`.
5. Set \`reassessedSeverity\` accurately (downgrade overblown severities; keep critical/high only for real impact).
6. Preserve exact \`path\`, \`startLine\`, \`endLine\`, and \`side\` verified against the file/diff.
7. Standards Reconciliation:
   - When Stage 1 \`r-*\`/\`rg-*\` \`standards\` are provided, return \`reconciledStandards\` reconciling Stage 1's \`r-*\`/\`rg-*\` standards against your final verified verdicts: downgrade any Stage 1 \`ISSUE\` whose underlying candidate finding(s) were \`REJECTED\` to \`PASS\` (with a clear note) or \`N/A\`, and keep \`ISSUE\` only when backed by a surviving finding or deterministic Layer 1 failure.${followUpRule}${walkthroughRule}${blastRadiusRule}${threadResolutionRule}`;

  const serializedCandidates = JSON.stringify(candidates, null, 2);
  const standardsSection =
    standards && standards.length > 0
      ? `\n\nStage 1 CiviCRM Standards to reconcile into \`reconciledStandards\`:\n${JSON.stringify(standards, null, 2)}`
      : '';
  const walkthroughSection =
    triageBullets && triageBullets.length > 0
      ? `\n\nStage 0 Walkthrough Bullets to reconcile into \`reconciledWalkthrough\`:\n${JSON.stringify(triageBullets, null, 2)}`
      : '';
  const blastRadiusSection =
    blastRadius && blastRadius.length > 0
      ? `\n\nStage 1 Blast Radius to reconcile into \`reconciledBlastRadius\`:\n${JSON.stringify(blastRadius, null, 2)}`
      : '';
  const userPrompt =
    candidates.length > 0
      ? `Verify the following ${candidates.length} candidate finding(s) for PR #${bundle.pr.prNumber} in ${bundle.pr.repo}:

${serializedCandidates}${standardsSection}${walkthroughSection}${blastRadiusSection}

Return VerifierOutput JSON with one VerifiedFinding entry per candidate (do not silently omit candidates; mark disproved ones as verdict='REJECTED')${standards && standards.length > 0 ? ', plus `reconciledStandards` matching your final verdicts' : ''}${triageBullets && triageBullets.length > 0 ? ', plus `reconciledWalkthrough`' : ''}${blastRadius && blastRadius.length > 0 ? ', plus `reconciledBlastRadius`' : ''}.`
      : `Stage 1 specialists reported 0 candidate findings for PR #${bundle.pr.prNumber} in ${bundle.pr.repo}.${standardsSection}${walkthroughSection}${blastRadiusSection}

Perform an independent adversarial audit of the PR diff, standards, and walkthrough bullets:
- Return \`verifiedFindings: []\`.
- If Stage 1 missed a concrete, high-signal defect or broken test/caller contract, emit 1–2 targeted \`followUpLeads\`; otherwise return \`followUpLeads: []\`.${standards && standards.length > 0 ? '\n- Return `reconciledStandards` verifying Stage 1 standards.' : ''}${triageBullets && triageBullets.length > 0 ? '\n- Return `reconciledWalkthrough` resolving any unverified Stage 0 `NEEDS_QUESTION` bullets against the repository.' : ''}${blastRadius && blastRadius.length > 0 ? '\n- Return `reconciledBlastRadius` removing any inaccurate blast-radius claims.' : ''}`;

  return { systemPrompt, userPrompt };
}
