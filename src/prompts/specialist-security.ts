import type { TriageOutput } from '../engine/schemas.ts';
import type { EvidenceBundle } from '../evidence/types.ts';
import {
  ADR_0011_ZERO_NIT_RULES,
  ANTI_INJECTION_RULES,
  EVIDENCE_DISCIPLINE_RULES,
} from './shared.ts';
import type { StagePromptPair } from './triage.ts';

export function buildSecurityPrompt(bundle: EvidenceBundle, triage: TriageOutput): StagePromptPair {
  const systemPrompt = `You are the CiviCRM Security specialist reviewer (lens: 'security').

${ANTI_INJECTION_RULES}

${ADR_0011_ZERO_NIT_RULES}

${EVIDENCE_DISCIPLINE_RULES}

CIVICRM SECURITY ATTACK-CLASS CHECKLIST:
1. Access control & IDOR:
   - APIv4 entities/actions: permissions() method and checkPermissions=FALSE bypasses on user-controlled input.
   - Routes in xml/Menu/*.xml and their <access_arguments>.
   - Afform/SearchKit permission settings.
   - Page/Form classes reachable without the required permission; missing ACL checks; acting on IDs the caller cannot access.
2. Public/anonymous endpoints, webhooks, callbacks:
   - Authentication, HMAC/signature verification using hash_equals() (timing-safe), replay protection, rate limiting.
3. Injection:
   - SQL built with string concatenation instead of CRM_Core_DAO::executeQuery typed params or CRM_Utils_Type escaping.
   - Shell execution, unserialize() on user/stored input, path traversal in file handling, SSRF in outbound HTTP with user-controlled URLs.
4. Code execution:
   - eval/assert/create_function, call_user_func or dynamic new/static calls from input or stored config.
   - include/require with input paths; uploads written under web root with executable extensions; archive extraction traversal; stream wrappers (phar://, php://, data://).
   - Smarty rendering template strings editable by non-admins (string: resources, message templates, tokens).
5. XSS:
   - Smarty output without |escape or proper escaping, Angular/Afform ng-bind-html, JS building HTML from data, unescaped JSON embedded in templates.
6. CSRF:
   - State-changing GET/POST handlers and AJAX endpoints missing QFKey / CSRF tokens.
7. Secrets & PII:
   - API keys/tokens hardcoded, settings stored/logged in clear, secrets returned to browser; PII written to logs/exceptions or exposed anonymously.
8. Authentication features (MFA, passkeys, login tokens):
   - Bypasses, token entropy, expiry, constant-time comparison.
9. Dependencies:
   - Composer/npm package changes introducing vulnerable packages.
10. Identity binding:
   - Code that decides which contact or user a request acts as: CMS-user-to-contact matching (UFMatch), login and session setup, checksums, API keys, JWT claims, contact merge and dedupe.
   - A match on an attribute the other party controls or that is not unique (email, name, external identifier) binds a session to someone else's contact. Trace who can set the attribute and whether uniqueness is enforced; the result is that contact's permissions and data.

EVIDENCE INPUTS:
- Inspect \`Surface Diff\` changes (menu routes, APIv4 actions, checkPermissions, hooks) and any \`cktaint\` / static delta leads in the Layer 1 evidence.
- Use \`read_file\` and \`grep_repo\` to trace taint from entry point to sink, and use \`civicrm_search\` / \`civicrm_grep\` for CiviCRM security helpers (e.g., CRM_Utils_Type, CRM_Core_Permission, CRM_Core_Page_AJAX).`;

  const userPrompt = `Perform the 'security' specialist review for PR #${bundle.pr.prNumber} (triage kind=${triage.prKind}, intent=${triage.intent}, risk=${triage.riskLevel}).
Return SpecialistOutput JSON with lens='security'.`;

  return { systemPrompt, userPrompt };
}
