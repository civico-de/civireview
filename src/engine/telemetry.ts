import { formatUsd } from '../runners/pricing.ts';
import type { StageUsage } from '../runners/types.ts';
import type { ModelSpec } from '../config/schema.ts';

/** ` (read_file:5, live_probe_ab:2)`, or nothing without named calls. */
function formatToolCounts(toolUses: StageUsage['toolUses']): string {
  if (!toolUses?.length) return '';
  const counts = new Map<string, number>();
  for (const u of toolUses) counts.set(u.tool, (counts.get(u.tool) ?? 0) + 1);
  return ` (${[...counts].map(([tool, n]) => `${tool}:${n}`).join(', ')})`;
}

/** One log line per stage: model, steps, named tool calls, duration, tokens and cost. */
export function formatStageTelemetry(params: {
  stage: string;
  model: ModelSpec;
  effort?: string;
  maxSteps?: number;
  durationMs: number;
  usage?: StageUsage;
  stageCost?: number;
}): string {
  const { stage, model, effort, maxSteps, durationMs, usage, stageCost } = params;
  const durStr = `${(durationMs / 1000).toFixed(1)}s`;
  const effortStr = effort ? ` effort=${effort}` : '';
  if (!usage) {
    return `[stage] ${stage} model=${model}${effortStr} dur=${durStr} usage=n/a`;
  }
  const stepsStr =
    usage.steps !== undefined
      ? ` steps=${usage.steps}${maxSteps !== undefined ? `/${maxSteps}` : ''}${usage.toolCalls !== undefined ? ` tools=${usage.toolCalls}${formatToolCounts(usage.toolUses)}` : ''}`
      : '';
  const cacheWrite = usage.cacheWriteInputTokens ?? 0;
  const cacheRead = usage.cachedInputTokens ?? 0;
  const totalIn = usage.inputTokens + cacheWrite + cacheRead;
  const hitPct = totalIn > 0 ? Math.round((cacheRead / totalIn) * 100) : 0;
  const costStr = stageCost !== undefined ? ` cost=${formatUsd(stageCost)}` : '';
  return (
    `[stage] ${stage} model=${model}${effortStr}${stepsStr} dur=${durStr}` +
    ` in=${usage.inputTokens.toLocaleString('en-US')}` +
    ` cache_write=${cacheWrite.toLocaleString('en-US')}` +
    ` cache_read=${cacheRead.toLocaleString('en-US')} (${hitPct}% hit)` +
    ` out=${usage.outputTokens.toLocaleString('en-US')}${costStr}`
  );
}
