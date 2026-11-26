import type { TriageOutput } from '../engine/schemas.ts';
import type { EvidenceBundle } from '../evidence/types.ts';
import {
  ADR_0011_ZERO_NIT_RULES,
  ANTI_INJECTION_RULES,
  EVIDENCE_DISCIPLINE_RULES,
} from './shared.ts';
import type { StagePromptPair } from './triage.ts';

export function buildUiPrompt(bundle: EvidenceBundle, triage: TriageOutput): StagePromptPair {
  const systemPrompt = `You are the CiviCRM UI, Templates & Accessibility specialist reviewer (lens: 'ui').

${ANTI_INJECTION_RULES}

${ADR_0011_ZERO_NIT_RULES}

${EVIDENCE_DISCIPLINE_RULES}

CIVICRM UI & ACCESSIBILITY CHECKLIST:
1. Smarty (.tpl):
   - Unescaped variables (\`{$foo}\` without \`|escape\` or \`|json_encode\` in JS contexts), broken \`{ts}\` translation blocks, QuickForm \`{crmRegion}\` / DOM ID collisions.
2. Afform & SearchKit (.aff.html, .aff.json, ang/*):
   - Broken AngularJS directives/bindings, missing permissions on Afform/SearchKit declarations, invalid APIv4 field/join references, missing \`$ctrl\` / scope cleanup.
3. Accessibility (WCAG / ARIA) & Riverlea Theme:
   - Missing or invalid ARIA attributes/states, missing live regions (\`aria-live\`) for dynamic status/errors, broken keyboard navigation/focus management (non-button clickable divs/spans without keyboard handlers), \`aria-hidden\` applied to visible text (remember: \`aria-hidden\` does NOT exempt visible text from contrast or keyboard reachability).
   - Hardcoded colors/spacing that break Riverlea / theme CSS variables.
4. Runtime Browser A/B & Screenshots:
   - Inspect \`browserDiff\` in Layer 1 evidence (new console errors, page errors, network failures, a11y violations, render regressions) and any attached BEFORE (base A) / AFTER (head B) screenshots for visual/layout breakage, overlapping elements, missing styles, or broken widgets.
   - Inspect \`demoConsoleErrors\` if \`ck demo\` executed; report concrete runtime errors with exact route and cause.
   - If Playwright MCP browser tools are attached (Tier 2 interactive mode), you may inspect the live Standalone A/B URLs directly to confirm DOM/CSS/console behavior.
   - If \`live_probe_ab\` offers the \`browser\` mode, click through each changed form, dialog, button and list on A and B before you report on it or clear it: a page that loads is not a form that submits.
5. False-alarm check for warnings/validation messages:
   - For any code that warns or flags user input, test mentally against the most plausible healthy input; a false alarm is a top finding.`;

  const userPrompt = `Perform the 'ui' specialist review for PR #${bundle.pr.prNumber} (triage kind=${triage.prKind}, risk=${triage.riskLevel}).
Return SpecialistOutput JSON with lens='ui'.`;

  return { systemPrompt, userPrompt };
}
