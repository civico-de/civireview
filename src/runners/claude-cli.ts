import { z } from 'zod';
import { writeMcpConfigFile } from '../mcp/client.ts';
import { runCliProcess } from './cli-process.ts';
import { liveProbeMcpServer } from './live-prove.ts';
import { estimateStageCostUsd, roundUsd } from './pricing.ts';
import {
  parseModelSpec,
  type StageRequest,
  type StageResult,
  type StageRunner,
  type StageUsage,
  type ToolUse,
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
    throw new Error(`Could not parse JSON from CLI output: ${trimmed.slice(0, 300)}`);
  }
}

type ContentBlock = {
  type?: string;
  id?: string;
  name?: string;
  input?: unknown;
  tool_use_id?: string;
  content?: unknown;
  is_error?: boolean;
};

/** MCP tools carry `mcp__<server>__`; the in-process runner names them bare. */
const bareToolName = (name: string) => name.replace(/^mcp__.+?__/, '');

/**
 * Reads `--output-format stream-json`: the final `result` event, and each tool call with
 * input and result shortened like the in-process runner records them.
 */
function streamEvents(stdout: string): Array<Record<string, unknown>> {
  return stdout
    .split('\n')
    .filter((line) => line.trim().startsWith('{'))
    .map((line) => {
      try {
        return JSON.parse(line) as Record<string, unknown>;
      } catch {
        throw new Error(`claude CLI stream has a line that is not JSON: ${line.slice(0, 200)}`);
      }
    });
}

/** The result event's error, or the tail of the output when the stream has none. */
function describeFailure(stdout: string, stderr: string): string {
  try {
    const result = streamEvents(stdout).findLast((e) => e.type === 'result');
    if (result) {
      const errors = Array.isArray(result.errors) ? result.errors.join('; ') : '';
      return `${String(result.subtype ?? 'error')}: ${errors || String(result.result ?? '')}`.slice(
        0,
        1000,
      );
    }
  } catch {
    // not a stream; fall through to the raw text
  }
  return (stderr || stdout).slice(-1000);
}

export function parseClaudeStream(stdout: string): {
  envelope: Record<string, unknown>;
  toolUses: ToolUse[];
  /** MCP servers the CLI reported as not connected. */
  mcpFailures: string[];
} {
  const events = streamEvents(stdout);
  const init = events.find((e) => e.type === 'system' && e.subtype === 'init');
  const mcpFailures = ((init?.mcp_servers ?? []) as Array<{ name?: string; status?: string }>)
    .filter((server) => server.status !== 'connected')
    .map((server) => `${server.name ?? '?'} (${server.status ?? 'unknown'})`);
  const blocks = (e: Record<string, unknown>) =>
    ((e.message as { content?: unknown } | undefined)?.content ?? []) as ContentBlock[];
  const results = new Map<string, ContentBlock>();
  for (const e of events.filter((ev) => ev.type === 'user')) {
    for (const b of blocks(e))
      if (b.type === 'tool_result' && b.tool_use_id) results.set(b.tool_use_id, b);
  }
  const toolUses = events
    .filter((e) => e.type === 'assistant')
    .flatMap(blocks)
    // The CLI may deliver --json-schema output as a tool call; the API runner has no such call.
    .filter((b) => b.type === 'tool_use' && b.name !== 'StructuredOutput')
    .map((b) => {
      const res = b.id ? results.get(b.id) : undefined;
      const text = Array.isArray(res?.content)
        ? (res.content as Array<{ text?: string }>).map((c) => c.text ?? '').join('')
        : typeof res?.content === 'string'
          ? res.content
          : undefined;
      return {
        tool: bareToolName(b.name ?? ''),
        input: (JSON.stringify(b.input) ?? '').slice(0, 300),
        // A failed call has no output, as in the in-process runner.
        ...(text !== undefined && !res?.is_error ? { output: text.slice(0, 300) } : {}),
      };
    });
  const envelope = events.findLast((e) => e.type === 'result');
  if (!envelope) throw new Error(`claude CLI returned no result event: ${stdout.slice(-500)}`);
  return { envelope, toolUses, mcpFailures };
}

export function toCliJsonSchema(schema: z.ZodType): Record<string, unknown> {
  const raw = z.toJSONSchema(schema, { target: 'draft-7' }) as Record<string, unknown>;
  delete raw.$schema;
  return raw;
}

export class ClaudeCliRunner implements StageRunner {
  readonly providers = ['claude-cli'] as const;
  readonly supportsLiveStacks = true;

  async run<T>(req: StageRequest<T>): Promise<StageResult<T>> {
    const start = Date.now();
    const parsed = parseModelSpec(req.model);
    const jsonSchema = JSON.stringify(toCliJsonSchema(req.schema));
    const stdioServers = [
      ...(req.extraMcpServers ?? []),
      ...(req.liveStacks ? [liveProbeMcpServer(req.liveStacks)] : []),
    ];
    const mcpFile = writeMcpConfigFile(req.mcpScope, stdioServers);
    const knowledge = Boolean(req.mcpScope?.enabled && req.mcpScope.url);

    const imageBlock =
      req.images && req.images.length > 0
        ? [
            '## Before / After Standalone Browser Screenshots',
            'Inspect these PNG screenshots with your Read tool to verify visual layout, rendering, and UI regressions:',
            ...req.images.slice(0, 6).map((img) => `- ${img.label}: ${img.path}`),
          ].join('\n')
        : '';

    const fullPrompt = [req.systemPrompt, req.sharedPrefix ?? '', imageBlock, req.userPrompt]
      .filter(Boolean)
      .join('\n\n');

    const allowedTools = [
      'Read',
      'Grep',
      'Glob',
      ...(knowledge ? ['mcp__civicrm-knowledge__*'] : []),
      ...stdioServers.map((server) => `mcp__${server.name}__*`),
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
      'stream-json',
      '--verbose',
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
      const { stdout, stderr, exitCode } = await runCliProcess(args, {
        cwd: req.cwd,
        stdin: fullPrompt,
        timeoutMs: req.timeoutMs,
        // MCP tools load with their schema up front, as on the API path; deferred, the model
        // sees only the name and has to fetch the rest through ToolSearch.
        env: { ...process.env, ENABLE_TOOL_SEARCH: 'false' },
        label: 'claude CLI',
      });

      if (exitCode !== 0) {
        throw new Error(`claude CLI exited with ${exitCode}: ${describeFailure(stdout, stderr)}`);
      }

      const { envelope, toolUses, mcpFailures } = parseClaudeStream(stdout);
      // The prompt promised the live tool; a review without it would miss that silently.
      const liveDown = mcpFailures.find((f) => f.startsWith('live-probe '));
      if (liveDown) throw new Error(`claude CLI could not start the live tool: ${liveDown}`);
      for (const failure of mcpFailures) {
        console.warn(`[civireview:warn] MCP server ${failure} unavailable, continuing without it`);
      }
      const rawCandidate =
        envelope.structured_output ??
        (typeof envelope.result === 'string'
          ? extractJsonFromCliText(envelope.result)
          : (envelope.result ?? envelope));

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
          inputTokens + outputTokens + (cachedInputTokens ?? 0) + (cacheWriteInputTokens ?? 0);
        const baseUsage: StageUsage = {
          inputTokens,
          outputTokens,
          cachedInputTokens,
          cacheWriteInputTokens,
          totalTokens,
          estimatedUsd: reportedCostUsd,
          ...(typeof envelope.num_turns === 'number' ? { steps: envelope.num_turns } : {}),
          toolCalls: toolUses.length,
          toolUses,
        };
        usage = {
          ...baseUsage,
          estimatedUsd: reportedCostUsd ?? estimateStageCostUsd(parsed.raw, baseUsage),
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
