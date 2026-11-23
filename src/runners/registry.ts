import type { ModelProvider } from '../config/schema.ts';
import { AiSdkRunner } from './ai-sdk.ts';
import { ClaudeCliRunner } from './claude-cli.ts';
import { CodexCliRunner } from './codex-cli.ts';
import { OpenCodeCliRunner } from './opencode-cli.ts';
import { parseModelSpec, type StageRequest, type StageResult, type StageRunner } from './types.ts';

export type RunnerRegistry = Map<ModelProvider, StageRunner>;

/**
 * Builds the provider -> StageRunner dispatch map. Pass `overrides` to inject
 * mock runners for deterministic tests.
 */
export function createRunnerRegistry(
  overrides: Partial<Record<ModelProvider, StageRunner>> = {},
): RunnerRegistry {
  const registry: RunnerRegistry = new Map();

  const defaults: StageRunner[] = [
    new AiSdkRunner(),
    new ClaudeCliRunner(),
    new CodexCliRunner(),
    new OpenCodeCliRunner(),
  ];

  for (const runner of defaults) {
    for (const provider of runner.providers) {
      registry.set(provider, runner);
    }
  }

  for (const [provider, runner] of Object.entries(overrides) as Array<
    [ModelProvider, StageRunner | undefined]
  >) {
    if (runner) {
      registry.set(provider, runner);
    }
  }

  return registry;
}

/**
 * Dispatches a stage execution to the runner registered for `req.model`'s provider.
 */
export async function runStage<T>(
  req: StageRequest<T>,
  registry: RunnerRegistry = createRunnerRegistry(),
): Promise<StageResult<T>> {
  const parsed = parseModelSpec(req.model);
  const runner = registry.get(parsed.provider);
  if (!runner) {
    throw new Error(`No StageRunner registered for provider "${parsed.provider}"`);
  }
  return runner.run(req);
}
