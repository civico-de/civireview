import { parseModelSpec, type StageUsage } from './types.ts';

export interface ModelPricing {
  /** USD per 1M uncached input tokens. */
  inputPerMillion: number;
  /** USD per 1M output tokens. */
  outputPerMillion: number;
  /** USD per 1M cache-read input tokens (defaults to inputPerMillion if unset). */
  cacheReadPerMillion: number;
  /** USD per 1M cache-write input tokens (defaults to inputPerMillion if unset). */
  cacheWritePerMillion: number;
}

interface PricingRule {
  match: RegExp;
  pricing: ModelPricing;
}

/**
 * Published API token pricing (USD per 1M tokens).
 * Ordered most-specific first so e.g. `gpt-5-mini` matches before `gpt-5`.
 */
const MODEL_PRICING_RULES: readonly PricingRule[] = [
  // Anthropic Claude (API + claude-cli aliases + OpenRouter anthropic/*)
  {
    match: /(?:^|[/:_-])(?:claude-)?opus-4-[56]|^opus$/i,
    pricing: {
      inputPerMillion: 5.0,
      outputPerMillion: 25.0,
      cacheReadPerMillion: 0.5,
      cacheWritePerMillion: 6.25,
    },
  },
  {
    match: /(?:^|[/:_-])(?:claude-)?opus-4(?:\b|-0|-1)/i,
    pricing: {
      inputPerMillion: 15.0,
      outputPerMillion: 75.0,
      cacheReadPerMillion: 1.5,
      cacheWritePerMillion: 18.75,
    },
  },
  {
    match: /(?:^|[/:_-])(?:claude-)?sonnet-4|^sonnet$/i,
    pricing: {
      inputPerMillion: 3.0,
      outputPerMillion: 15.0,
      cacheReadPerMillion: 0.3,
      cacheWritePerMillion: 3.75,
    },
  },
  {
    match: /(?:^|[/:_-])(?:claude-)?haiku-4|^haiku$/i,
    pricing: {
      inputPerMillion: 1.0,
      outputPerMillion: 5.0,
      cacheReadPerMillion: 0.1,
      cacheWritePerMillion: 1.25,
    },
  },
  {
    match: /(?:^|[/:_-])claude-3-5-haiku/i,
    pricing: {
      inputPerMillion: 0.8,
      outputPerMillion: 4.0,
      cacheReadPerMillion: 0.08,
      cacheWritePerMillion: 1.0,
    },
  },

  // OpenAI GPT-5 / GPT-4o (API + codex-cli + OpenRouter openai/*)
  {
    match: /(?:^|[/:_-])gpt-5\.2-instant/i,
    pricing: {
      inputPerMillion: 1.5,
      outputPerMillion: 6.0,
      cacheReadPerMillion: 0.75,
      cacheWritePerMillion: 1.5,
    },
  },
  {
    match: /(?:^|[/:_-])gpt-5\.[2-9]|(?:^|[/:_-])gpt-6/i,
    pricing: {
      inputPerMillion: 1.75,
      outputPerMillion: 14.0,
      cacheReadPerMillion: 0.175,
      cacheWritePerMillion: 1.75,
    },
  },
  {
    match: /(?:^|[/:_-])gpt-5-mini/i,
    pricing: {
      inputPerMillion: 0.25,
      outputPerMillion: 2.0,
      cacheReadPerMillion: 0.025,
      cacheWritePerMillion: 0.25,
    },
  },
  {
    match: /(?:^|[/:_-])gpt-5(?:\b|-)/i,
    pricing: {
      inputPerMillion: 1.25,
      outputPerMillion: 10.0,
      cacheReadPerMillion: 0.125,
      cacheWritePerMillion: 1.25,
    },
  },
  {
    match: /(?:^|[/:_-])gpt-4o-mini/i,
    pricing: {
      inputPerMillion: 0.15,
      outputPerMillion: 0.6,
      cacheReadPerMillion: 0.075,
      cacheWritePerMillion: 0.15,
    },
  },
  {
    match: /(?:^|[/:_-])gpt-4o(?:\b|-)/i,
    pricing: {
      inputPerMillion: 2.5,
      outputPerMillion: 10.0,
      cacheReadPerMillion: 1.25,
      cacheWritePerMillion: 2.5,
    },
  },

  // Google Gemini 2.5 (API + OpenRouter google/*)
  {
    match: /(?:^|[/:_-])gemini-2\.5-pro/i,
    pricing: {
      inputPerMillion: 1.25,
      outputPerMillion: 10.0,
      cacheReadPerMillion: 0.125,
      cacheWritePerMillion: 1.25,
    },
  },
  {
    match: /(?:^|[/:_-])gemini-2\.5-flash-lite/i,
    pricing: {
      inputPerMillion: 0.1,
      outputPerMillion: 0.4,
      cacheReadPerMillion: 0.025,
      cacheWritePerMillion: 0.1,
    },
  },
  {
    match: /(?:^|[/:_-])gemini-2\.5-flash/i,
    pricing: {
      inputPerMillion: 0.3,
      outputPerMillion: 2.5,
      cacheReadPerMillion: 0.075,
      cacheWritePerMillion: 0.3,
    },
  },
];

const ZERO_PRICING: ModelPricing = {
  inputPerMillion: 0,
  outputPerMillion: 0,
  cacheReadPerMillion: 0,
  cacheWritePerMillion: 0,
};

/**
 * Resolves published per-million-token API pricing for a `<provider>:<modelId>` spec.
 * Local `openai-compat:*` models resolve to $0.00; unknown models return `undefined`.
 */
export function lookupModelPricing(modelSpec: string): ModelPricing | undefined {
  let provider = '';
  let modelId = modelSpec;
  try {
    const parsed = parseModelSpec(modelSpec);
    provider = parsed.provider;
    modelId = parsed.modelId;
  } catch {
    // Allow raw model names in tests/helpers
  }

  if (provider === 'openai-compat') {
    return ZERO_PRICING;
  }

  for (const rule of MODEL_PRICING_RULES) {
    if (rule.match.test(modelId)) {
      return rule.pricing;
    }
  }

  // Provider-level defaults for `default` CLI aliases
  if (provider === 'claude-cli' && modelId === 'default') {
    return {
      inputPerMillion: 3.0,
      outputPerMillion: 15.0,
      cacheReadPerMillion: 0.3,
      cacheWritePerMillion: 3.75,
    };
  }
  if (provider === 'codex-cli' && modelId === 'default') {
    return {
      inputPerMillion: 1.75,
      outputPerMillion: 14.0,
      cacheReadPerMillion: 0.175,
      cacheWritePerMillion: 1.75,
    };
  }

  return undefined;
}

/**
 * Computes estimated API USD cost for a single stage from token usage.
 * Prefers a runner-supplied exact cost (`usage.estimatedUsd`, e.g. Claude CLI's
 * `total_cost_usd`) when present.
 */
export function estimateStageCostUsd(
  modelSpec: string,
  usage: StageUsage,
): number | undefined {
  if (
    typeof usage.estimatedUsd === 'number' &&
    Number.isFinite(usage.estimatedUsd) &&
    usage.estimatedUsd >= 0
  ) {
    return roundUsd(usage.estimatedUsd);
  }

  const pricing = lookupModelPricing(modelSpec);
  if (!pricing) return undefined;

  const cacheRead = usage.cachedInputTokens ?? 0;
  const cacheWrite = usage.cacheWriteInputTokens ?? 0;
  const uncachedInput = usage.inputTokens;
  const output = usage.outputTokens;

  const usd =
    (uncachedInput * pricing.inputPerMillion +
      cacheWrite * pricing.cacheWritePerMillion +
      cacheRead * pricing.cacheReadPerMillion +
      output * pricing.outputPerMillion) /
    1_000_000;

  return roundUsd(usd);
}

export function roundUsd(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

export function formatUsd(usd: number): string {
  if (usd === 0) return '$0.00';
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  return `$${usd.toFixed(2)}`;
}
