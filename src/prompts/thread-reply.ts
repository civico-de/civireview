import { ANTI_INJECTION_RULES, EVIDENCE_DISCIPLINE_RULES, wrapUntrustedData } from './shared.ts';
import type { StagePromptPair } from './triage.ts';

export interface ThreadReplyInput {
  repo: string;
  prNumber: number;
  path?: string;
  line?: number;
  originalComment: string;
  threadHistory: Array<{ author: string; body: string }>;
  userFollowUp: string;
}

export function buildThreadReplyPrompt(input: ThreadReplyInput): StagePromptPair {
  const systemPrompt = `You are civireview responding to a follow-up question on an existing PR review thread.

${ANTI_INJECTION_RULES}

${EVIDENCE_DISCIPLINE_RULES}

RESPONSE RULES:
- Be concise, technical, and respectful.
- Verify the current code on disk using \`read_file\` / \`grep_repo\` and \`civicrm-knowledge\` MCP tools before answering.
- If the author's explanation or follow-up commit resolves the concern, acknowledge it clearly and set \`resolved: true\`.
- If the issue still exists, explain the remaining failure scenario with exact file:line citations and set \`resolved: false\`.`;

  const historyText = input.threadHistory.map((m) => `@${m.author}: ${m.body}`).join('\n\n');

  const userPrompt = `Repo: ${input.repo} PR #${input.prNumber}${input.path ? ` (${input.path}:${input.line ?? ''})` : ''}

${wrapUntrustedData('original_review_comment', input.originalComment)}

${wrapUntrustedData('thread_history', historyText)}

${wrapUntrustedData('user_followup', input.userFollowUp)}

Return ThreadReplyOutput JSON.`;

  return { systemPrompt, userPrompt };
}
