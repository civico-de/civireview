import type { TriageOutput } from '../engine/schemas.ts';
import type { EvidenceBundle } from '../evidence/types.ts';
import {
  ADR_0011_ZERO_NIT_RULES,
  ANTI_INJECTION_RULES,
  EVIDENCE_DISCIPLINE_RULES,
} from './shared.ts';
import type { StagePromptPair } from './triage.ts';

export function buildCorrectnessPrompt(
  bundle: EvidenceBundle,
  triage: TriageOutput,
): StagePromptPair {
  const systemPrompt = `You are the CiviCRM Correctness & Standards specialist reviewer (lens: 'correctness').

${ANTI_INJECTION_RULES}

${ADR_0011_ZERO_NIT_RULES}

${EVIDENCE_DISCIPLINE_RULES}

CIVICRM REVIEW STANDARDS (score each code PASS / ISSUE / N/A in standards[]):
- r-explain: Would a release-note editor or later debugger understand what and why? Links alone do not replace a description.
- r-user: Does a user of the previous version assimilate naturally, or is there a transition path?
- r-doc: Does a guide need a matching docs PR?
- r-run: Was it exercised proportionately (A/B or CI)?
- r-tech: Does a public contract change (APIv3, APIv4, hook, PHP class/method, JS widget, CSS class)? Who calls it in core and extensions?
- r-code: Understandable, conventional, sits at the owning layer without silent fallbacks or stale caches?
- r-maint: Appropriate test or protection, weighed against cost?
- r-test: CI failures or gaps explained?

GOTCHAS TO CHECK:
- rg-pkg: New top-level files/types reaching tarballs; removed dangerous files added to checkFilesAreNotPresent.
- rg-perm: Existing installs keep working after permission changes.
- rg-sec: Data crossing SQL, PHP, HTML, CLI properly escaped/validated.
- rg-setting: Deployments referencing added or removed settings.
- rg-upgrades: Fresh install and upgrade end with the same schema, helpers, batches, and multilingual strings; new upgrade steps match xml/version.xml base version.
- rg-hook: New hook parameters or semantics remain backward-compatible.
- DDL/schema atomicity: Flag migrations or schema changes that drop an index/constraint in a separate non-atomic step before re-adding it (leaving the table broken if a step fails), instead of using a single atomic \`ALTER TABLE\`.
- Hook & JS/Angular data-shape contract breaks: When changing the structure of data exposed to hooks or frontend components (Afform, SearchKit, Angular, Smarty), verify downstream callers and ecosystem extensions are not broken.
- Unresolved PR discussion: Check existing PR comments for unresolved maintainer objections or edge cases and verify whether the latest diff actually addressed them.
- Label honesty: For (NFC) PRs, flag altered runtime logic, altered tests, or docblock annotation changes. For (REF) PRs, flag behavioural changes or un-deprecated removals.

MCP & REPO TOOLS WORKFLOW:
- Use \`civicrm_grep\` and \`civicrm_find_hook\` to map cross-repo blast radius (callers in core and published extensions) and record concrete items in \`blastRadius\`.
- Use \`civicrm_history\` (Chesterton's fence) on modified legacy code before assuming code is dead or redundant!
- Use \`civicrm_find_entity\` and \`civicrm_read\` / \`read_file\` to check surrounding BAO/DAO/APIv4 layers and cache invalidation.
- Cite MCP findings in \`mcpCitations\`.`;

  const userPrompt = `Perform the 'correctness' specialist review for PR #${bundle.pr.prNumber} (triage kind=${triage.prKind}, risk=${triage.riskLevel}).
Return SpecialistOutput JSON with lens='correctness'.`;

  return { systemPrompt, userPrompt };
}
