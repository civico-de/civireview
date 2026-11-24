import { existsSync, readFileSync } from 'node:fs';
import type { z } from 'zod';
import { createAnthropic } from '@ai-sdk/anthropic';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { createOpenAI } from '@ai-sdk/openai';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import {
  generateText,
  NoObjectGeneratedError,
  Output,
  stepCountIs,
  type ImagePart,
  type LanguageModel,
  type SystemModelMessage,
  type TextPart,
  type ToolSet,
  type UserModelMessage,
} from 'ai';
import { connectMcpClient, connectStdioMcpClient, type ConnectedMcpHandle } from '../mcp/client.ts';
import { extractJsonFromCliText } from './claude-cli.ts';
import { estimateStageCostUsd } from './pricing.ts';
import { createRepoTools } from './repo-tools.ts';
import {
  parseModelSpec,
  type ParsedModelSpec,
  type StageImageInput,
  type StageRequest,
  type StageResult,
  type StageRunner,
  type StageUsage,
} from './types.ts';
import { liveProbeTool } from './live-prove.ts';

const MAX_IMAGES_PER_STAGE = 6;
const MAX_TOTAL_IMAGE_BYTES = 4 * 1024 * 1024;

function buildMultimodalUserMessage(
  userPrompt: string,
  images: StageImageInput[] | undefined,
): UserModelMessage | null {
  if (!images || images.length === 0) return null;

  const parts: Array<TextPart | ImagePart> = [{ type: 'text', text: userPrompt }];
  let totalBytes = 0;
  let attachedCount = 0;

  for (const img of images) {
    if (attachedCount >= MAX_IMAGES_PER_STAGE) break;
    if (!existsSync(img.path)) continue;
    let bytes: Uint8Array;
    try {
      bytes = new Uint8Array(readFileSync(img.path));
    } catch {
      continue;
    }
    if (bytes.byteLength === 0) continue;
    if (totalBytes + bytes.byteLength > MAX_TOTAL_IMAGE_BYTES) continue;

    totalBytes += bytes.byteLength;
    attachedCount++;
    parts.push({ type: 'text', text: `[Screenshot: ${img.label}]` });
    parts.push({
      type: 'image',
      image: bytes,
      mediaType: img.mediaType,
    });
  }

  if (attachedCount === 0) return null;
  return { role: 'user', content: parts };
}

function resolveLanguageModel(parsed: ParsedModelSpec): LanguageModel {
  switch (parsed.provider) {
    case 'anthropic': {
      const anthropic = createAnthropic({
        apiKey: process.env.ANTHROPIC_API_KEY,
      });
      return anthropic(parsed.modelId);
    }
    case 'openai': {
      const openai = createOpenAI({
        apiKey: process.env.OPENAI_API_KEY,
      });
      return openai(parsed.modelId);
    }
    case 'google': {
      const google = createGoogleGenerativeAI({
        apiKey: process.env.GOOGLE_GENERATIVE_AI_API_KEY ?? process.env.GEMINI_API_KEY,
      });
      return google(parsed.modelId);
    }
    case 'openrouter': {
      const openrouter = createOpenAICompatible({
        name: 'openrouter',
        baseURL: process.env.OPENROUTER_BASE_URL ?? 'https://openrouter.ai/api/v1',
        apiKey: process.env.OPENROUTER_API_KEY,
        headers: {
          'HTTP-Referer': 'https://github.com/civico-de/civireview',
          'X-Title': 'civireview',
        },
        supportsStructuredOutputs: true,
      });
      return openrouter.chatModel(parsed.modelId);
    }
    case 'openai-compat': {
      const compat = createOpenAICompatible({
        name: 'openai-compat',
        baseURL: process.env.OPENAI_COMPAT_BASE_URL ?? 'http://127.0.0.1:11434/v1',
        apiKey: process.env.OPENAI_COMPAT_API_KEY ?? 'local',
        supportsStructuredOutputs: true,
      });
      return compat.chatModel(parsed.modelId);
    }
    default:
      throw new Error(`AiSdkRunner does not support provider "${parsed.provider}"`);
  }
}

/**
 * Structured output that accepts the object wrapped in prose or a code fence, which
 * models without a strict JSON mode produce. Strict parsing is tried first.
 */
function lenientObjectOutput<T>(schema: z.ZodType<T>, name: string) {
  const strict = Output.object<T>({ schema, name });
  return {
    ...strict,
    async parseCompleteOutput(...args: Parameters<typeof strict.parseCompleteOutput>) {
      try {
        return await strict.parseCompleteOutput(...args);
      } catch (strictErr) {
        try {
          return schema.parse(extractJsonFromCliText(args[0].text));
        } catch {
          throw strictErr;
        }
      }
    },
  };
}

function noStructuredOutputError(
  req: { stage: string },
  parsed: ParsedModelSpec,
  details: { steps?: number; maxSteps: number; finishReason?: string; textLength: number },
  cause: unknown,
): Error {
  const msg = cause instanceof Error ? cause.message : String(cause);
  return new Error(
    `Stage "${req.stage}" (${parsed.raw}) produced no structured output${details.steps === undefined ? '' : ` after ${details.steps}/${details.maxSteps} step(s)`} (finishReason=${details.finishReason ?? 'unknown'}, textLen=${details.textLength}): ${msg}`,
    { cause },
  );
}

export class AiSdkRunner implements StageRunner {
  readonly providers = ['anthropic', 'openai', 'google', 'openrouter', 'openai-compat'] as const;
  readonly supportsLiveStacks = true;

  async run<T>(req: StageRequest<T>): Promise<StageResult<T>> {
    const start = Date.now();
    const parsed = parseModelSpec(req.model);
    const model = resolveLanguageModel(parsed);

    const repoTools = createRepoTools(req.cwd);
    const mcpHandle = req.mcpScope
      ? await connectMcpClient(req.mcpScope)
      : { client: null, tools: {} as ToolSet, close: async () => {} };

    const extraMcpHandles: ConnectedMcpHandle[] = [];
    for (const server of req.extraMcpServers ?? []) {
      extraMcpHandles.push(await connectStdioMcpClient(server));
    }

    try {
      const extraMcpTools: ToolSet = Object.assign({}, ...extraMcpHandles.map((h) => h.tools));
      const tools: ToolSet = {
        ...repoTools,
        ...mcpHandle.tools,
        ...extraMcpTools,
        ...(req.liveStacks ? liveProbeTool(req.liveStacks) : {}),
      };

      // Put the shared PR evidence prefix FIRST with cacheControl so all stages
      // sharing the same model + tool definitions (e.g. sequential Stage 1 specialists)
      // hit the exact same KV cache prefix before their lens-specific system prompt.
      const instructions: SystemModelMessage[] = [];

      if (req.sharedPrefix) {
        instructions.push({
          role: 'system',
          content: req.sharedPrefix,
          ...(parsed.provider === 'anthropic'
            ? {
                providerOptions: {
                  anthropic: {
                    cacheControl: { type: 'ephemeral' as const },
                  },
                },
              }
            : {}),
        });
      }

      instructions.push({
        role: 'system',
        content: req.systemPrompt,
        ...(parsed.provider === 'anthropic'
          ? {
              providerOptions: {
                anthropic: {
                  cacheControl: { type: 'ephemeral' as const },
                },
              },
            }
          : {}),
      });

      const multimodalUserMsg = buildMultimodalUserMessage(req.userPrompt, req.images);

      let providerOptions: Record<string, Record<string, string | { type: string }>> | undefined;
      if (parsed.provider === 'anthropic') {
        // Top-level automatic cacheControl caches the growing multi-turn tool-result
        // history on every step ($0.10/M cache read instead of $2.00/M uncached input).
        providerOptions = {
          anthropic: {
            cacheControl: { type: 'ephemeral' },
            ...(req.effort ? { effort: req.effort } : {}),
          },
        };
      } else if (req.effort && parsed.provider === 'openai') {
        providerOptions = { openai: { reasoningEffort: req.effort } };
      }

      const maxSteps = Math.max(2, req.maxSteps ?? 15);
      const hasTools = Object.keys(tools).length > 0;

      const commonCallOptions = {
        model,
        instructions,
        tools,
        stopWhen: stepCountIs(maxSteps),
        // Guarantee the final step always emits the structured JSON object instead
        // of burning the last step on a tool call (which causes AI SDK to throw
        // `NoOutputGeneratedError: No output generated.`).
        ...(hasTools
          ? {
              prepareStep: ({ stepNumber }: { stepNumber: number }) => {
                if (stepNumber >= maxSteps - 1) {
                  return { toolChoice: 'none' as const };
                }
                return undefined;
              },
            }
          : {}),
        maxOutputTokens: req.maxOutputTokens,
        ...(providerOptions ? { providerOptions } : {}),
        timeout: req.timeoutMs,
        output: lenientObjectOutput<T>(req.schema, req.schemaName ?? req.stage),
      };

      let result;
      try {
        result = multimodalUserMsg
          ? await generateText({
              ...commonCallOptions,
              messages: [multimodalUserMsg],
            })
          : await generateText({
              ...commonCallOptions,
              prompt: req.userPrompt,
            });
      } catch (err) {
        if (NoObjectGeneratedError.isInstance(err)) {
          throw noStructuredOutputError(
            req,
            parsed,
            {
              maxSteps,
              finishReason: err.finishReason,
              textLength: err.text?.length ?? 0,
            },
            err,
          );
        }
        throw err;
      }

      let rawOutput: unknown;
      try {
        rawOutput = result.output;
      } catch (outputErr) {
        throw noStructuredOutputError(
          req,
          parsed,
          {
            steps: result.steps?.length ?? 0,
            maxSteps,
            finishReason: result.finishReason,
            textLength: result.text?.length ?? 0,
          },
          outputErr,
        );
      }

      const validated = req.schema.parse(rawOutput);
      const rawInputTokens = result.usage.inputTokens ?? 0;
      const outputTokens = result.usage.outputTokens ?? 0;
      const cachedInputTokens = result.usage.inputTokenDetails?.cacheReadTokens ?? undefined;
      const cacheWriteInputTokens = result.usage.inputTokenDetails?.cacheWriteTokens ?? undefined;
      const uncachedInputTokens =
        result.usage.inputTokenDetails?.noCacheTokens ??
        Math.max(0, rawInputTokens - (cachedInputTokens ?? 0) - (cacheWriteInputTokens ?? 0));

      const stepsCount = result.steps?.length ?? 1;
      const toolUses = (result.steps ?? []).flatMap((s) =>
        (s.toolCalls ?? []).map((c) => {
          const res = s.toolResults?.find((r) => r.toolCallId === c.toolCallId);
          return {
            tool: c.toolName,
            input: (JSON.stringify(c.input) ?? '').slice(0, 300),
            // No result means the tool threw or never ran.
            ...(res ? { output: (JSON.stringify(res.output) ?? '').slice(0, 300) } : {}),
          };
        }),
      );

      const baseUsage: StageUsage = {
        inputTokens: uncachedInputTokens,
        outputTokens,
        cachedInputTokens,
        cacheWriteInputTokens,
        totalTokens:
          uncachedInputTokens +
          (cacheWriteInputTokens ?? 0) +
          (cachedInputTokens ?? 0) +
          outputTokens,
        steps: stepsCount,
        toolCalls: toolUses.length,
        toolUses,
      };
      const usage: StageUsage = {
        ...baseUsage,
        estimatedUsd: estimateStageCostUsd(parsed.raw, baseUsage),
      };

      return {
        output: validated,
        model: parsed.raw,
        provider: parsed.provider,
        usage,
        durationMs: Date.now() - start,
        rawText: result.text,
      };
    } finally {
      await mcpHandle.close();
      for (const h of extraMcpHandles) {
        await h.close();
      }
    }
  }
}
