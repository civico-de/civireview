import { z } from 'zod';
import {
  ModelSpecSchema,
  type EffortLevel,
  type ModelProvider,
  type ModelSpec,
} from '../config/schema.ts';
import type { McpScopeResult } from '../mcp/scope.ts';

export interface ParsedModelSpec {
  raw: ModelSpec;
  provider: ModelProvider;
  modelId: string;
}

/**
 * Parses and validates `<provider>:<modelId>` into its provider and model ID.
 * Splits only on the first colon so model IDs containing colons or slashes
 * (e.g. `openai-compat:qwen2.5:32b` or `openrouter:anthropic/claude-sonnet-4-6`)
 * are preserved intact.
 */
export function parseModelSpec(spec: string): ParsedModelSpec {
  const validated = ModelSpecSchema.parse(spec);
  const colonIdx = validated.indexOf(':');
  const provider = validated.slice(0, colonIdx) as ModelProvider;
  const modelId = validated.slice(colonIdx + 1);
  return {
    raw: validated,
    provider,
    modelId,
  };
}

export interface StageUsage {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens?: number;
  cacheWriteInputTokens?: number;
  totalTokens: number;
  estimatedUsd?: number;
  steps?: number;
  toolCalls?: number;
  /** Each tool call in order, with input and result as shortened JSON. */
  toolUses?: ToolUse[];
}

export interface ToolUse {
  tool: string;
  input: string;
  /** Missing when the call failed before returning. */
  output?: string;
}

export interface StageImageInput {
  label: string;
  path: string;
  mediaType: 'image/png' | 'image/jpeg' | 'image/webp';
}

export interface ExtraMcpServerConfig {
  name: string;
  command: string;
  args: string[];
  /** Wall-clock limit per tool call, for runners that pass it on. */
  timeoutMs?: number;
}

/** The kept A/B stacks a stage may run commands in. */
export interface LiveStacks {
  composeFiles: { A: string; B: string };
  urls: { A?: string; B?: string };
  /** Longest timeout a single exec may ask for. */
  maxExecSeconds: number;
  /** The `ck` launcher; with it and both URLs the tool can drive a browser. */
  ck?: string[];
  /** CMS sites with the change applied, for the browser mode; they have no base to compare. */
  cmsSites?: Array<{ cms: string; url: string }>;
}

export interface StageRequest<T> {
  stage: string;
  model: ModelSpec;
  cwd: string;
  systemPrompt: string;
  sharedPrefix?: string;
  userPrompt: string;
  schema: z.ZodType<T>;
  schemaName?: string;
  mcpScope?: McpScopeResult;
  images?: StageImageInput[];
  liveStacks?: LiveStacks;
  extraMcpServers?: ExtraMcpServerConfig[];
  maxSteps?: number;
  maxOutputTokens?: number;
  effort?: EffortLevel;
  timeoutMs?: number;
}

export interface StageResult<T> {
  output: T;
  model: ModelSpec;
  provider: ModelProvider;
  usage?: StageUsage;
  durationMs: number;
  rawText?: string;
}

export interface StageRunner {
  readonly providers: readonly ModelProvider[];
  /** True when the runner gives the model the live tool on `liveStacks`. */
  readonly supportsLiveStacks?: boolean;
  run<T>(req: StageRequest<T>): Promise<StageResult<T>>;
}
