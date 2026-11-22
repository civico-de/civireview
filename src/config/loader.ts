import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import yaml from 'js-yaml';
import {
  AbConfigSchema,
  BrowserConfigSchema,
  ChecksConfigSchema,
  CiviReviewConfigSchema,
  McpConfigSchema,
  PRESETS,
  ReviewSettingsSchema,
  WatchConfigSchema,
  type CiviReviewConfigInput,
  type ModelOverrides,
  type PresetModels,
  type PresetName,
  type ResolvedCiviReviewConfig,
} from './schema.ts';

const CONFIG_FILENAMES = ['civireview.yaml', '.civireview.yaml'] as const;

export interface ConfigOverrides {
  trigger?: string;
  preset?: PresetName;
  models?: ModelOverrides;
  ab?: Partial<CiviReviewConfigInput['ab']>;
  checks?: Partial<CiviReviewConfigInput['checks']>;
  browser?: Partial<CiviReviewConfigInput['browser']>;
  mcp?: Partial<CiviReviewConfigInput['mcp']>;
  review?: Partial<CiviReviewConfigInput['review']>;
}

/**
 * Resolves concrete model specs for every stage from a base preset plus optional overrides.
 */
export function resolveModels(
  preset: PresetName,
  ...overrideLayers: Array<ModelOverrides | undefined>
): PresetModels {
  const base = PRESETS[preset];
  const resolved: PresetModels = {
    triage: base.triage,
    specialists: { ...base.specialists },
    verifier: base.verifier,
    threadReply: base.threadReply,
  };

  for (const layer of overrideLayers) {
    if (!layer) continue;
    if (layer.triage !== undefined) {
      resolved.triage = layer.triage;
    }
    if (layer.verifier !== undefined) {
      resolved.verifier = layer.verifier;
    }
    if (layer.threadReply !== undefined) {
      resolved.threadReply = layer.threadReply;
    }
    if (layer.specialists) {
      if (layer.specialists.correctness !== undefined) {
        resolved.specialists.correctness = layer.specialists.correctness;
      }
      if (layer.specialists.security !== undefined) {
        resolved.specialists.security = layer.specialists.security;
      }
      if (layer.specialists.tests !== undefined) {
        resolved.specialists.tests = layer.specialists.tests;
      }
      if (layer.specialists.ui !== undefined) {
        resolved.specialists.ui = layer.specialists.ui;
      }
    }
  }

  return resolved;
}

function findConfigFile(repoRoot: string): string | undefined {
  for (const name of CONFIG_FILENAMES) {
    const candidate = join(repoRoot, name);
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

function stripUndefined<T extends Record<string, unknown>>(obj: T): Partial<T> {
  const result: Partial<T> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (value !== undefined) {
      (result as Record<string, unknown>)[key] = value;
    }
  }
  return result;
}

/**
 * Loads `civireview.yaml` or `.civireview.yaml` from `repoRoot` if present,
 * validates against `CiviReviewConfigSchema`, and merges preset defaults with
 * file config and CLI/comment overrides.
 */
export function loadConfig(
  repoRoot: string,
  overrides: ConfigOverrides = {},
): ResolvedCiviReviewConfig {
  const configPath = findConfigFile(repoRoot);
  let rawFileConfig: Record<string, unknown> = {};

  if (configPath) {
    const rawText = readFileSync(configPath, 'utf8');
    const parsed = yaml.load(rawText);
    if (parsed !== undefined && parsed !== null) {
      if (typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error(
          `Invalid config in ${configPath}: root must be a YAML mapping`,
        );
      }
      rawFileConfig = parsed as Record<string, unknown>;
    }
  }

  const parsedFile = CiviReviewConfigSchema.parse(rawFileConfig);

  const preset: PresetName = overrides.preset ?? parsedFile.preset;

  const mergedPaths =
    parsedFile.review?.paths || overrides.review?.paths
      ? {
          ...(parsedFile.review?.paths ?? {}),
          ...stripUndefined(overrides.review?.paths ?? {}),
        }
      : undefined;

  const mergedInput: CiviReviewConfigInput = {
    trigger: overrides.trigger ?? parsedFile.trigger,
    preset,
    ab: {
      ...(parsedFile.ab ?? {}),
      ...stripUndefined(overrides.ab ?? {}),
    },
    checks: {
      ...(parsedFile.checks ?? {}),
      ...stripUndefined(overrides.checks ?? {}),
    },
    browser: {
      ...(parsedFile.browser ?? {}),
      ...stripUndefined(overrides.browser ?? {}),
    },
    mcp: {
      ...(parsedFile.mcp ?? {}),
      ...stripUndefined(overrides.mcp ?? {}),
    },
    review: {
      ...(parsedFile.review ?? {}),
      ...stripUndefined(overrides.review ?? {}),
      ...(mergedPaths ? { paths: mergedPaths } : {}),
    },
    watch: parsedFile.watch,
  };

  // Validate merged non-model sections with defaults applied
  const validated = CiviReviewConfigSchema.parse(mergedInput);
  const models = resolveModels(preset, parsedFile.models, overrides.models);

  return {
    trigger: validated.trigger,
    preset: validated.preset,
    models,
    ab: AbConfigSchema.parse(validated.ab ?? {}),
    checks: ChecksConfigSchema.parse(validated.checks ?? {}),
    browser: BrowserConfigSchema.parse(validated.browser ?? {}),
    mcp: McpConfigSchema.parse(validated.mcp ?? {}),
    review: ReviewSettingsSchema.parse(validated.review ?? {}),
    watch: validated.watch ? WatchConfigSchema.parse(validated.watch) : undefined,
    configPath,
  };
}
