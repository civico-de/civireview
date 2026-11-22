import { z } from 'zod';

export const MODEL_PROVIDERS = [
  'anthropic',
  'openai',
  'google',
  'openrouter',
  'openai-compat',
  'claude-cli',
  'codex-cli',
  'opencode-cli',
] as const;

export const ModelProviderSchema = z.enum(MODEL_PROVIDERS);
export type ModelProvider = z.infer<typeof ModelProviderSchema>;

const MODEL_SPEC_REGEX = new RegExp(
  `^(${MODEL_PROVIDERS.join('|')}):([A-Za-z0-9._:/@-]+)$`,
);

export const ModelSpecSchema = z
  .string()
  .regex(
    MODEL_SPEC_REGEX,
    `ModelSpec must be "<provider>:<model>" where provider is one of ${MODEL_PROVIDERS.join(', ')}`,
  );
export type ModelSpec = z.infer<typeof ModelSpecSchema>;

export const PRESET_NAMES = [
  'sonnet',
  'sonnet-opus',
  'cross-model',
  'subscription',
  'local-gpu',
] as const;

export const PresetNameSchema = z.enum(PRESET_NAMES);
export type PresetName = z.infer<typeof PresetNameSchema>;

export interface PresetModels {
  triage: ModelSpec;
  specialists: {
    correctness: ModelSpec;
    security: ModelSpec;
    tests: ModelSpec;
    ui: ModelSpec;
  };
  verifier: ModelSpec;
  threadReply: ModelSpec;
}

export const PRESETS: Record<PresetName, PresetModels> = {
  sonnet: {
    triage: 'anthropic:claude-haiku-4-5',
    specialists: {
      correctness: 'anthropic:claude-sonnet-4-6',
      security: 'anthropic:claude-sonnet-4-6',
      tests: 'anthropic:claude-sonnet-4-6',
      ui: 'anthropic:claude-sonnet-4-6',
    },
    verifier: 'anthropic:claude-sonnet-4-6',
    threadReply: 'anthropic:claude-sonnet-4-6',
  },
  'sonnet-opus': {
    triage: 'anthropic:claude-haiku-4-5',
    specialists: {
      correctness: 'anthropic:claude-sonnet-4-6',
      security: 'anthropic:claude-sonnet-4-6',
      tests: 'anthropic:claude-sonnet-4-6',
      ui: 'anthropic:claude-sonnet-4-6',
    },
    verifier: 'anthropic:claude-opus-4-6',
    threadReply: 'anthropic:claude-sonnet-4-6',
  },
  'cross-model': {
    triage: 'anthropic:claude-haiku-4-5',
    specialists: {
      correctness: 'anthropic:claude-sonnet-4-6',
      security: 'anthropic:claude-sonnet-4-6',
      tests: 'anthropic:claude-sonnet-4-6',
      ui: 'anthropic:claude-sonnet-4-6',
    },
    verifier: 'openai:gpt-5.2',
    threadReply: 'anthropic:claude-sonnet-4-6',
  },
  subscription: {
    triage: 'claude-cli:haiku',
    specialists: {
      correctness: 'claude-cli:sonnet',
      security: 'claude-cli:sonnet',
      tests: 'claude-cli:sonnet',
      ui: 'claude-cli:sonnet',
    },
    verifier: 'claude-cli:opus',
    threadReply: 'claude-cli:sonnet',
  },
  'local-gpu': {
    triage: 'openai-compat:local',
    specialists: {
      correctness: 'opencode-cli:local',
      security: 'opencode-cli:local',
      tests: 'opencode-cli:local',
      ui: 'opencode-cli:local',
    },
    verifier: 'opencode-cli:local',
    threadReply: 'openai-compat:local',
  },
};

export const SpecialistModelOverridesSchema = z
  .object({
    correctness: ModelSpecSchema.optional(),
    security: ModelSpecSchema.optional(),
    tests: ModelSpecSchema.optional(),
    ui: ModelSpecSchema.optional(),
  })
  .strict();

export const ModelOverridesSchema = z
  .object({
    triage: ModelSpecSchema.optional(),
    specialists: SpecialistModelOverridesSchema.optional(),
    verifier: ModelSpecSchema.optional(),
    threadReply: ModelSpecSchema.optional(),
  })
  .strict();

export type ModelOverrides = z.infer<typeof ModelOverridesSchema>;

export const CHECK_KEYS = [
  'ab-tests',
  'surface',
  'static-delta',
  'lifecycle',
  'browser',
  'a11y',
  'interactive-browser',
  'matrix',
  'live-prove',
] as const;

export const CheckKeySchema = z.enum(CHECK_KEYS);
export type CheckKey = z.infer<typeof CheckKeySchema>;

export const ChecksConfigSchema = z
  .object({
    abTests: z.boolean().default(true),
    surface: z.boolean().default(true),
    staticDelta: z.boolean().default(true),
    lifecycle: z.boolean().default(true),
    browser: z.boolean().default(true),
    a11y: z.boolean().default(true),
    interactiveBrowser: z.boolean().default(false),
    matrix: z.boolean().default(false),
    liveProve: z.boolean().default(false),
  })
  .strict();

export type ChecksConfig = z.infer<typeof ChecksConfigSchema>;

export const BrowserConfigSchema = z
  .object({
    pages: z.array(z.string()).default([]),
    anonymousPages: z.array(z.string()).default([]),
    maxAutoPages: z.number().int().min(1).max(20).default(5),
    viewport: z.string().default('1280x800'),
    sendScreenshotsToLlm: z.boolean().default(true),
    playwrightMcpCommand: z.string().min(1).optional(),
  })
  .strict();

export type BrowserConfig = z.infer<typeof BrowserConfigSchema>;

export const PathFiltersSchema = z
  .object({
    include: z.array(z.string()).default([]),
    exclude: z.array(z.string()).default([]),
  })
  .strict();

export type PathFilters = z.infer<typeof PathFiltersSchema>;

export const AbConfigSchema = z
  .object({
    enabled: z.boolean().default(true),
    runDemo: z.boolean().default(false),
    runMatrix: z.boolean().default(false),
    keepStacks: z.boolean().default(false),
    liveProve: z.boolean().default(false),
    civikitchenPath: z.string().min(1).optional(),
    ckCommand: z.string().min(1).optional(),
  })
  .strict();

export type AbConfig = z.infer<typeof AbConfigSchema>;

export const McpConfigSchema = z
  .object({
    publicUrl: z.url().default('https://mcp.civico.de/mcp'),
    teamUrl: z.url().optional(),
    tokenEnv: z.string().min(1).default('CIVICRM_MCP_TOKEN'),
    enabled: z.boolean().default(true),
  })
  .strict();

export type McpConfig = z.infer<typeof McpConfigSchema>;

export const ReviewEventSchema = z.enum([
  'COMMENT',
  'REQUEST_CHANGES',
  'APPROVE',
]);
export type ReviewEvent = z.infer<typeof ReviewEventSchema>;

export const ReviewSettingsSchema = z
  .object({
    confidenceThreshold: z.number().min(0).max(100).default(80),
    maxInlineComments: z.number().int().nonnegative().default(10),
    maxDiffBytes: z.number().int().positive().default(250_000),
    maxSteps: z.number().int().positive().default(15),
    maxBudgetUsd: z.number().positive().optional(),
    autoPost: z.boolean().default(true),
    reviewEvent: ReviewEventSchema.default('COMMENT'),
    include: z.array(z.string()).default([]),
    exclude: z.array(z.string()).default([]),
    paths: PathFiltersSchema.default({ include: [], exclude: [] }),
  })
  .strict();

export type ReviewSettings = z.infer<typeof ReviewSettingsSchema>;

export const WatchModeSchema = z.enum(['search', 'notifications']);
export type WatchMode = z.infer<typeof WatchModeSchema>;

export const AUTHOR_ASSOCIATIONS = [
  'OWNER',
  'MEMBER',
  'COLLABORATOR',
  'CONTRIBUTOR',
] as const;
export const AuthorAssociationSchema = z.enum(AUTHOR_ASSOCIATIONS);
export type AuthorAssociation = z.infer<typeof AuthorAssociationSchema>;

export const WatchConfigSchema = z
  .object({
    mode: WatchModeSchema.default('search'),
    repos: z.array(z.string().min(1)).default([]),
    allowedAuthors: z.array(z.string().min(1)).default([]),
    allowedOrgs: z.array(z.string().min(1)).default([]),
    allowedAssociations: z.array(AuthorAssociationSchema).default([]),
    maxReviewsPerHour: z.number().int().positive().optional(),
    maxDailyUsd: z.number().positive().optional(),
    maxCommentAgeMinutes: z.number().int().positive().optional(),
    intervalSec: z.number().int().positive().default(60),
    statePath: z.string().min(1).default('.civireview-state/seen.json'),
  })
  .strict();

export type WatchConfig = z.infer<typeof WatchConfigSchema>;

export const CiviReviewConfigSchema = z
  .object({
    trigger: z.string().min(1).default('@civireview'),
    preset: PresetNameSchema.default('sonnet'),
    models: ModelOverridesSchema.optional(),
    ab: AbConfigSchema.optional(),
    checks: ChecksConfigSchema.optional(),
    browser: BrowserConfigSchema.optional(),
    mcp: McpConfigSchema.optional(),
    review: ReviewSettingsSchema.optional(),
    watch: WatchConfigSchema.optional(),
  })
  .strict();

export type CiviReviewConfigInput = z.input<typeof CiviReviewConfigSchema>;
export type CiviReviewConfig = z.infer<typeof CiviReviewConfigSchema>;

export interface ResolvedCiviReviewConfig {
  trigger: string;
  preset: PresetName;
  models: PresetModels;
  ab: AbConfig;
  checks: ChecksConfig;
  browser: BrowserConfig;
  mcp: McpConfig;
  review: ReviewSettings;
  watch?: WatchConfig;
  configPath?: string;
}

/**
 * Pure helper determining whether a Layer 1 check key should run under `config`.
 * When `review.include` is non-empty, only listed checks/lenses run;
 * anything in `review.exclude` is skipped; `checks.*` flags apply otherwise.
 */
export function isCheckEnabled(
  config: Pick<ResolvedCiviReviewConfig, 'checks' | 'ab' | 'review'>,
  checkKey: CheckKey,
): boolean {
  if (config.review.exclude.includes(checkKey)) {
    return false;
  }
  if (config.review.include.length > 0) {
    return config.review.include.includes(checkKey);
  }
  switch (checkKey) {
    case 'ab-tests':
      return config.checks.abTests;
    case 'surface':
      return config.checks.surface;
    case 'static-delta':
      return config.checks.staticDelta;
    case 'lifecycle':
      return config.checks.lifecycle;
    case 'browser':
      return config.checks.browser;
    case 'a11y':
      return config.checks.a11y;
    case 'interactive-browser':
      return config.checks.interactiveBrowser;
    case 'matrix':
      return config.checks.matrix || config.ab.runMatrix;
    case 'live-prove':
      return config.checks.liveProve || config.ab.liveProve;
  }
}

/**
 * Pure helper determining whether a Layer 2 specialist lens should run under `config`.
 */
export function isLensEnabled(
  config: Pick<ResolvedCiviReviewConfig, 'review'>,
  lens: 'correctness' | 'security' | 'tests' | 'ui',
): boolean {
  if (config.review.exclude.includes(lens)) {
    return false;
  }
  if (config.review.include.length > 0) {
    return config.review.include.includes(lens);
  }
  return true;
}
