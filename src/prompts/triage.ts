import type { EvidenceBundle } from '../evidence/types.ts';
import {
  ANTI_INJECTION_RULES,
  EVIDENCE_DISCIPLINE_RULES,
} from './shared.ts';

export interface StagePromptPair {
  systemPrompt: string;
  userPrompt: string;
}

export function buildTriagePrompt(bundle: EvidenceBundle): StagePromptPair {
  const systemPrompt = `You are the CiviCRM PR Triage classifier for civireview.
Classify the pull request kind, risk level, which specialist lenses to activate, concise walkthrough bullets, and recommended A/B test paths.

${ANTI_INJECTION_RULES}

${EVIDENCE_DISCIPLINE_RULES}

CLASSIFICATION RULES:
- prKind:
  - 'docs-only': only markdown/rst/txt/docs files changed. Active lenses should be [].
  - 'core-ref-nfc': CiviCRM core PR marked (REF) or (NFC) in title/labels; verify label honesty (NFC must not alter runtime logic or tests; REF must preserve behaviour).
  - 'security-sensitive': touches xml/Menu/*.xml permissions, APIv4 permissions()/checkPermissions, SQL queries, auth/tokens, webhooks, file uploads, eval/unserialize, or Smarty/JS HTML rendering.
  - 'ui-change': touches Smarty .tpl, Afform .aff.html/.aff.json, SearchKit, JS/TS/CSS UI assets.
  - 'extension-pr': repoKind is 'civicrm-extension'.
  - 'core-bugfix' or 'core-feature': standard CiviCRM core fix or feature.
- activeLenses: choose from ['correctness', 'security', 'tests', 'ui'].
  - Activate 'ui' whenever templates/Afform/SearchKit/frontend assets are touched.
  - Activate 'security' whenever inputs, permissions, routes, APIv4, SQL, templates, webhooks, or auth are touched.
  - Activate 'correctness' and 'tests' for all non-docs PRs.
- shortSummary: 1–2 crisp sentences (<= 240 chars) in plain English summarizing WHAT this PR changes so a busy reviewer can understand it in 5 seconds without reading the full walkthrough.
- summaryBullets: 3–6 concise technical walkthrough bullets separating PROVEN, CONFIRMED, NEEDS_QUESTION, and NOT VERIFIED.`;

  const userPrompt = `Classify PR #${bundle.pr.prNumber} in ${bundle.pr.repo} (${bundle.repoInfo.kind}).
Return structured JSON matching TriageOutputSchema.`;

  return { systemPrompt, userPrompt };
}
