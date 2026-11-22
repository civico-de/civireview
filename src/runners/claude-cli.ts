import { z } from 'zod';
import { writeMcpConfigFile } from '../mcp/client.ts';
import { estimateStageCostUsd, roundUsd } from './pricing.ts';
import {
  parseModelSpec,
  type StageRequest,
  type StageResult,
  type StageRunner,
  type StageUsage,
} from './types.ts';

export function extractJsonFromCliText(text: string): unknown {
  const trimmed = text.trim();
  if (!trimmed) {
    throw new Error('CLI runner returned empty output');
  }

  try {
    return JSON.parse(trimmed);
  } catch {
    // Try fenced code block
    const fenceMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
    if (fenceMatch?.[1]) {
      return JSON.parse(fenceMatch[1].trim());
    }
    // Try outermost braces
    const firstBrace = trimmed.indexOf('{');
    const lastBrace = trimmed.lastIndexOf('}');
    if (firstBrace !== -1 && lastBrace > firstBrace) {
      return JSON.parse(trimmed.slice(firstBrace, lastBrace + 1));
    }
    throw new Error(
      `Could not parse JSON from CLI output: ${trimmed.slice(0, 300)}`,
    );
  }
}

export function toCliJsonSchema(schema: z.ZodType): Record<string, unknown> {
  const raw = z.toJSONSchema(schema, { target: 'draft-7' }) as Record<
    string,
    unknown
  >;
  delete raw.$schema;
  return raw;
}

export class ClaudeCliRunner implements StageRunner {
  readonly providers = ['claude-cli'] as const;

  async run<T>(req: StageRequest<T>): Promise<StageResult<T>> {
    const start = Date.now();
    const parsed = parseModelSpec(req.model);
    const jsonSchema = JSON.stringify(toCliJsonSchema(req.schema));
    const mcpFile = req.mcpScope ? writeMcpConfigFile(req.mcpScope) : null;

    const imageBlock =
      req.images && req.images.length > 0
        ? [
            '## Before / After Standalone Browser Screenshots',
            'Inspect these PNG screenshots with your Read tool to verify visual layout, rendering, and UI regressions:',
            ...req.images.slice(0, 6).map((img) => `- ${img.label}: ${img.path}`),
          ].join('\n')
        : '';

    const fullPrompt = [
      req.systemPrompt,
      req.sharedPrefix ?? '',
      imageBlock,
      req.userPrompt,
    ]
      .filter(Boolean)
      .join('\n\n');

    const allowedTools = [
      'Read',
      'Grep',
      'Glob',
      ...(mcpFile ? ['mcp__civicrm-knowledge__*'] : []),
    ].join(',');

    const claudeBin = process.env.CLAUDE_BIN || 'claude';
    const args = [
      claudeBin,
      '-p',
      '--setting-sources',
      '',
      ...(parsed.modelId !== 'default' ? ['--model', parsed.modelId] : []),
      ...(req.effort ? ['--effort', req.effort] : []),
      '--output-format',
      'json',
      '--json-schema',
      jsonSchema,
      ...(mcpFile ? ['--mcp-config', mcpFile.filePath, '--strict-mcp-config'] : []),
      '--allowedTools',
      allowedTools,
      '--disallowedTools',
      'Write,Edit,Bash,NotebookEdit',
      '--max-turns',
      String(req.maxSteps ?? 15),
    ];

    try {
      const proc = Bun.spawn(args, {
        cwd: req.cwd,
        stdin: new Blob([fullPrompt]),
        stdout: 'pipe',
        stderr: 'pipe',
      });

      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);

      if (exitCode !== 0) {
        throw new Error(
          `claude CLI exited with ${exitCode}: ${(stderr || stdout).slice(0, 1000)}`,
        );
      }

      const envelope = JSON.parse(stdout) as Record<string, unknown>;
      const rawCandidate =
        envelope.structured_output ??
        (typeof envelope.result === 'string'
          ? extractJsonFromCliText(envelope.result)
          : envelope.result ?? envelope);

      const output = req.schema.parse(rawCandidate);
      const rawUsage = envelope.usage as Record<string, unknown> | undefined;
      const reportedCostUsd =
        typeof envelope.total_cost_usd === 'number' &&
        Number.isFinite(envelope.total_cost_usd) &&
        envelope.total_cost_usd >= 0
          ? roundUsd(envelope.total_cost_usd)
          : undefined;
      let usage: StageUsage | undefined;
      if (rawUsage) {
        const inputTokens = Number(rawUsage.input_tokens ?? 0);
        const outputTokens = Number(rawUsage.output_tokens ?? 0);
        const cachedInputTokens =
          rawUsage.cache_read_input_tokens !== undefined
            ? Number(rawUsage.cache_read_input_tokens)
            : undefined;
        const cacheWriteInputTokens =
          rawUsage.cache_creation_input_tokens !== undefined
            ? Number(rawUsage.cache_creation_input_tokens)
            : undefined;
        const totalTokens =
          inputTokens +
          outputTokens +
          (cachedInputTokens ?? 0) +
          (cacheWriteInputTokens ?? 0);
        const baseUsage: StageUsage = {
          inputTokens,
          outputTokens,
          cachedInputTokens,
          cacheWriteInputTokens,
          totalTokens,
          estimatedUsd: reportedCostUsd,
        };
        usage = {
          ...baseUsage,
          estimatedUsd:
            reportedCostUsd ?? estimateStageCostUsd(parsed.raw, baseUsage),
        };
      }

      return {
        output,
        model: parsed.raw,
        provider: parsed.provider,
        usage,
        durationMs: Date.now() - start,
        rawText: stdout,
      };
    } finally {
      mcpFile?.cleanup();
    }
  }
}
