import {
  CHECK_KEYS,
  ModelSpecSchema,
  PresetNameSchema,
  type ModelSpec,
  type PresetName,
} from '../config/schema.ts';

/**
 * Effort levels allowed from PR comments (`xhigh` and `max` are intentionally
 * restricted to local CLI / repository config to prevent runaway API spend).
 */
export const COMMENT_EFFORT_MODES = ['auto', 'low', 'medium', 'high'] as const;
export type CommentEffortMode = (typeof COMMENT_EFFORT_MODES)[number];
const COMMENT_EFFORT_SET = new Set<string>(COMMENT_EFFORT_MODES);

const ALLOWED_INCLUDE_EXCLUDE_KEYS = new Set<string>([
  ...CHECK_KEYS,
  'correctness',
  'security',
  'tests',
  'ui',
]);

export interface ParsedMentionFlags {
  full?: boolean;
  ab?: boolean;
  demo?: boolean;
  browser?: boolean;
  interactiveBrowser?: boolean;
  liveProve?: boolean;
  include?: string[];
  exclude?: string[];
  pages?: string[];
  preset?: PresetName;
  effort?: CommentEffortMode;
  model?: ModelSpec;
  verifier?: ModelSpec;
}

export interface ParsedMentionCommand {
  triggered: boolean;
  flags: ParsedMentionFlags;
  question: string;
}

function escapeRegExp(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Strips fenced code blocks, markdown blockquotes, and inline code spans
 * so mentions inside quoted replies or code examples do not trigger reviews.
 */
export function stripIgnoredMarkdownRegions(markdown: string): string {
  const lines = markdown.replace(/\r\n/g, '\n').split('\n');
  const kept: string[] = [];
  let activeFence: string | null = null;

  for (const line of lines) {
    const trimmedStart = line.trimStart();
    if (activeFence) {
      if (trimmedStart.startsWith(activeFence)) {
        activeFence = null;
      }
      continue;
    }

    const fenceMatch = trimmedStart.match(/^(```+|~~~+)/);
    if (fenceMatch?.[1]) {
      activeFence = fenceMatch[1].slice(0, 3);
      continue;
    }

    // Ignore markdown blockquotes
    if (/^\s*>/.test(line)) {
      continue;
    }

    // Strip inline code spans on active lines
    const withoutInlineCode = line.replace(/`[^`]*`/g, ' ');
    kept.push(withoutInlineCode);
  }

  return kept.join('\n');
}

function tokenizeCommandArgs(text: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (quote) {
      if (ch === quote) {
        quote = null;
      } else {
        current += ch;
      }
      continue;
    }

    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }

    if (/\s/.test(ch)) {
      if (current.length > 0) {
        tokens.push(current);
        current = '';
      }
      continue;
    }

    current += ch;
  }

  if (current.length > 0) {
    tokens.push(current);
  }

  return tokens;
}

/**
 * Safely parses `@civireview` mention commands and allowlisted flags from a PR/review comment.
 * Never evaluates shell expressions. Throws on invalid `--preset`, `--model`, or `--verifier` values.
 */
export function parseMentionCommand(
  commentBody: string,
  trigger = '@civireview',
): ParsedMentionCommand {
  const cleaned = stripIgnoredMarkdownRegions(commentBody);
  const escapedTrigger = escapeRegExp(trigger);
  // Require boundary before trigger (no word char or dot before @, preventing email matches)
  // and boundary after trigger (no word char or hyphen immediately after).
  const triggerRe = new RegExp(
    `(?:^|[\\s(\\[{"'])${escapedTrigger}(?=$|[\\s:,;.!?\\])}"'])`,
    'i',
  );

  const match = triggerRe.exec(cleaned);
  if (!match) {
    return {
      triggered: false,
      flags: {},
      question: '',
    };
  }

  const afterTrigger = cleaned.slice(match.index + match[0].length);
  const tokens = tokenizeCommandArgs(afterTrigger);

  const flags: ParsedMentionFlags = {};
  const questionTokens: string[] = [];

  const readFlagValue = (
    token: string,
    index: number,
    flagName: string,
  ): { value: string; nextIndex: number } => {
    const eqPrefix = `${flagName}=`;
    if (token.startsWith(eqPrefix)) {
      const val = token.slice(eqPrefix.length);
      if (!val) {
        throw new Error(`Missing value for ${flagName}`);
      }
      return { value: val, nextIndex: index };
    }
    const next = tokens[index + 1];
    if (!next || next.startsWith('--')) {
      throw new Error(`Missing value for ${flagName}`);
    }
    return { value: next, nextIndex: index + 1 };
  };

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!;
    if (token === '--full') {
      flags.full = true;
      continue;
    }
    if (token === '--ab') {
      flags.ab = true;
      continue;
    }
    if (token === '--no-ab') {
      flags.ab = false;
      continue;
    }
    if (token === '--demo') {
      flags.demo = true;
      continue;
    }
    if (token === '--no-browser') {
      flags.browser = false;
      continue;
    }
    if (token === '--browser') {
      flags.browser = true;
      continue;
    }
    if (token === '--interactive-browser') {
      flags.interactiveBrowser = true;
      continue;
    }
    if (token === '--live-prove') {
      flags.liveProve = true;
      continue;
    }
    if (token === '--include' || token.startsWith('--include=')) {
      const { value, nextIndex } = readFlagValue(token, i, '--include');
      const items = value
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      for (const item of items) {
        if (!ALLOWED_INCLUDE_EXCLUDE_KEYS.has(item)) {
          throw new Error(
            `Invalid --include key "${item}". Allowed: ${Array.from(ALLOWED_INCLUDE_EXCLUDE_KEYS).join(', ')}`,
          );
        }
      }
      flags.include = [...(flags.include ?? []), ...items];
      i = nextIndex;
      continue;
    }
    if (token === '--exclude' || token.startsWith('--exclude=')) {
      const { value, nextIndex } = readFlagValue(token, i, '--exclude');
      const items = value
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      for (const item of items) {
        if (!ALLOWED_INCLUDE_EXCLUDE_KEYS.has(item)) {
          throw new Error(
            `Invalid --exclude key "${item}". Allowed: ${Array.from(ALLOWED_INCLUDE_EXCLUDE_KEYS).join(', ')}`,
          );
        }
      }
      flags.exclude = [...(flags.exclude ?? []), ...items];
      i = nextIndex;
      continue;
    }
    if (token === '--page' || token.startsWith('--page=')) {
      const { value, nextIndex } = readFlagValue(token, i, '--page');
      const cleanedPage = value.trim().replace(/^\/+/, '');
      if (!cleanedPage.toLowerCase().startsWith('civicrm/')) {
        throw new Error(
          `Invalid --page route "${value}". Expected a "civicrm/..." route.`,
        );
      }
      flags.pages = [...(flags.pages ?? []), cleanedPage];
      i = nextIndex;
      continue;
    }
    if (token === '--preset' || token.startsWith('--preset=')) {
      const { value, nextIndex } = readFlagValue(token, i, '--preset');
      const parsed = PresetNameSchema.safeParse(value);
      if (!parsed.success) {
        throw new Error(
          `Invalid preset "${value}". Expected one of: ${PresetNameSchema.options.join(', ')}`,
        );
      }
      flags.preset = parsed.data;
      i = nextIndex;
      continue;
    }
    if (token === '--effort' || token.startsWith('--effort=')) {
      const { value, nextIndex } = readFlagValue(token, i, '--effort');
      const normalized = value.toLowerCase();
      if (!COMMENT_EFFORT_SET.has(normalized)) {
        throw new Error(
          `Invalid PR comment effort "${value}". Allowed in comments: ${COMMENT_EFFORT_MODES.join(', ')}`,
        );
      }
      flags.effort = normalized as CommentEffortMode;
      i = nextIndex;
      continue;
    }
    if (token === '--model' || token.startsWith('--model=')) {
      const { value, nextIndex } = readFlagValue(token, i, '--model');
      const parsed = ModelSpecSchema.safeParse(value);
      if (!parsed.success) {
        throw new Error(
          `Invalid model spec "${value}". Expected "<provider>:<modelId>"`,
        );
      }
      flags.model = parsed.data;
      i = nextIndex;
      continue;
    }
    if (token === '--verifier' || token.startsWith('--verifier=')) {
      const { value, nextIndex } = readFlagValue(token, i, '--verifier');
      const parsed = ModelSpecSchema.safeParse(value);
      if (!parsed.success) {
        throw new Error(
          `Invalid verifier model spec "${value}". Expected "<provider>:<modelId>"`,
        );
      }
      flags.verifier = parsed.data;
      i = nextIndex;
      continue;
    }

    questionTokens.push(token);
  }

  return {
    triggered: true,
    flags,
    question: questionTokens.join(' ').trim(),
  };
}
