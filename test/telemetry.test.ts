import { describe, expect, test } from 'bun:test';
import { formatStageTelemetry } from '../src/engine/telemetry.ts';

const base = { stage: 'verifier', model: 'anthropic:claude-opus-4-1', durationMs: 1000 } as const;
const usage = { inputTokens: 10, outputTokens: 5, totalTokens: 15, steps: 4 };

describe('stage telemetry', () => {
  test('names each tool with its call count', () => {
    const line = formatStageTelemetry({
      ...base,
      maxSteps: 35,
      usage: {
        ...usage,
        toolCalls: 3,
        toolUses: [
          { tool: 'read_file', input: '{}' },
          { tool: 'live_probe_ab', input: '{}' },
          { tool: 'read_file', input: '{}' },
        ],
      },
    });
    expect(line).toContain('steps=4/35 tools=3 (read_file:2, live_probe_ab:1)');
  });

  test('stays a bare count without named calls', () => {
    const line = formatStageTelemetry({ ...base, usage: { ...usage, toolCalls: 0 } });
    expect(line).toContain('steps=4 tools=0 dur=');
  });
});
