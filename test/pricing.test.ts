import { describe, expect, test } from 'bun:test';
import {
  estimateStageCostUsd,
  formatUsd,
  lookupModelPricing,
} from '../src/runners/pricing.ts';

describe('model pricing & cost estimation', () => {
  test('computes Anthropic Claude Sonnet 4.6 cost including cache writes and reads', () => {
    const cost = estimateStageCostUsd('anthropic:claude-sonnet-4-6', {
      inputTokens: 10_000,
      cacheWriteInputTokens: 20_000,
      cachedInputTokens: 100_000,
      outputTokens: 2_000,
      totalTokens: 132_000,
    });
    // 10k * $3/M ($0.03) + 20k * $3.75/M ($0.075) + 100k * $0.30/M ($0.03) + 2k * $15/M ($0.03) = $0.165
    expect(cost).toBe(0.165);
  });

  test('computes Opus 4.6, Haiku 4.5, GPT-5.2, Gemini 2.5 Pro, and local GPU $0.00', () => {
    expect(lookupModelPricing('claude-cli:opus')?.outputPerMillion).toBe(25);
    expect(lookupModelPricing('claude-cli:haiku')?.inputPerMillion).toBe(1);
    expect(lookupModelPricing('openai:gpt-5.2')?.outputPerMillion).toBe(14);
    expect(lookupModelPricing('google:gemini-2.5-pro')?.inputPerMillion).toBe(1.25);

    const localCost = estimateStageCostUsd('openai-compat:qwen2.5-coder:32b', {
      inputTokens: 50_000,
      outputTokens: 5_000,
      totalTokens: 55_000,
    });
    expect(localCost).toBe(0);
    expect(formatUsd(0)).toBe('$0.00');
  });

  test('prefers runner-supplied exact cost (e.g. Claude CLI total_cost_usd)', () => {
    const cost = estimateStageCostUsd('claude-cli:sonnet', {
      inputTokens: 10,
      outputTokens: 100,
      totalTokens: 110,
      estimatedUsd: 0.1234,
    });
    expect(cost).toBe(0.1234);
    expect(formatUsd(cost!)).toBe('$0.12');
    expect(formatUsd(0.0042)).toBe('$0.0042');
  });
});
