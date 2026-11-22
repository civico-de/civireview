import type { ToolSet } from 'ai';
import { z } from 'zod';
import {
  ModelSpecSchema,
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
  extraTools?: ToolSet;
  extraMcpServers?: ExtraMcpServerConfig[];
  maxSteps?: number;
  maxOutputTokens?: number;
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
  run<T>(req: StageRequest<T>): Promise<StageResult<T>>;
}
