import { describe, expect, test } from 'bun:test';
import { estimateStageCostUsd, formatUsd, lookupModelPricing } from '../src/runners/pricing.ts';

describe('model pricing & cost estimation', () => {
  test('computes Anthropic Claude 5.5 (Sonnet 5.5, Opus 5.5, Haiku 5.5 tiered, Fable 5.2) costs accurately', () => {
    const sonnet55 = estimateStageCostUsd('anthropic:claude-sonnet-5-5', {
      inputTokens: 10_000,
      cacheWriteInputTokens: 20_000,
      cachedInputTokens: 100_000,
      outputTokens: 2_000,
      totalTokens: 132_000,
    });
    // 10k * $2/M ($0.02) + 20k * $2.50/M ($0.05) + 100k * $0.10/M ($0.01) + 2k * $10/M ($0.02) = $0.10
    expect(sonnet55).toBe(0.1);

    const opus55 = estimateStageCostUsd('anthropic:claude-opus-5-5', {
      inputTokens: 10_000,
      cachedInputTokens: 50_000,
      outputTokens: 2_000,
      totalTokens: 62_000,
    });
    // 10k * $4/M ($0.04) + 50k * $0.20/M ($0.01) + 2k * $20/M ($0.04) = $0.09
    expect(opus55).toBe(0.09);

    // Haiku 5.5 <= 100k prompt tokens ($0.10/$0.50) vs > 100k prompt tokens (5x: $0.50/$2.50)
    const haikuShort = estimateStageCostUsd('anthropic:claude-haiku-5-5', {
      inputTokens: 50_000,
      outputTokens: 2_000,
      totalTokens: 52_000,
    });
    expect(haikuShort).toBe(0.006);

    const haikuLong = estimateStageCostUsd('anthropic:claude-haiku-5-5', {
      inputTokens: 120_000,
      outputTokens: 2_000,
      totalTokens: 122_000,
    });
    // (120k * $0.10 + 2k * $0.50) * 5 / 1M = ($0.012 + $0.001) * 5 = $0.065
    expect(haikuLong).toBe(0.065);

    expect(lookupModelPricing('anthropic:claude-fable-5-2')?.outputPerMillion).toBe(40);
  });

  test('computes legacy Claude 4.x, CLI aliases, GPT-5.2, Gemini 2.5 Pro, and local GPU $0.00', () => {
    const sonnet46 = estimateStageCostUsd('anthropic:claude-sonnet-4-6', {
      inputTokens: 10_000,
      cacheWriteInputTokens: 20_000,
      cachedInputTokens: 100_000,
      outputTokens: 2_000,
      totalTokens: 132_000,
    });
    // 10k * $3/M ($0.03) + 20k * $3.75/M ($0.075) + 100k * $0.30/M ($0.03) + 2k * $15/M ($0.03) = $0.165
    expect(sonnet46).toBe(0.165);

    expect(lookupModelPricing('anthropic:claude-opus-4-6')?.outputPerMillion).toBe(25);
    expect(lookupModelPricing('anthropic:claude-haiku-4-5')?.inputPerMillion).toBe(1);
    expect(lookupModelPricing('claude-cli:opus')?.outputPerMillion).toBe(20);
    expect(lookupModelPricing('claude-cli:haiku')?.inputPerMillion).toBe(0.1);
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
