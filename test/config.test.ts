import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig, resolveModels } from '../src/config/loader.ts';
import { PRESETS, isCheckEnabled, isLensEnabled } from '../src/config/schema.ts';

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'civireview-cfg-test-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

describe('config schema and loader', () => {
  test('returns sonnet preset defaults when no config file exists', () => {
    const dir = makeTempDir();
    const cfg = loadConfig(dir);

    expect(cfg.preset).toBe('sonnet');
    expect(cfg.trigger).toBe('@civireview');
    expect(cfg.models).toEqual(PRESETS.sonnet);
    expect(cfg.mcp.publicUrl).toBe('https://mcp.civico.de/mcp');
    expect(cfg.mcp.tokenEnv).toBe('CIVICRM_MCP_TOKEN');
    expect(cfg.mcp.enabled).toBe(true);
    expect(cfg.ab.enabled).toBe(true);
    expect(cfg.review.confidenceThreshold).toBe(80);
    expect(cfg.review.maxInlineComments).toBe(10);
    expect(cfg.review.maxDiffBytes).toBe(250_000);
    expect(cfg.review.depth).toBe('deep');
    expect(cfg.review.maxSteps).toBe(35);
    expect(cfg.review.triageMaxSteps).toBe(10);
    expect(cfg.review.maxOutputTokens).toBe(16_384);
    expect(cfg.review.maxFollowUpRounds).toBe(2);
    expect(cfg.review.stageTimeoutMs).toBe(360_000);
    expect(cfg.review.autoPost).toBe(true);
    expect(cfg.review.reviewEvent).toBe('COMMENT');

    const fastCfg = loadConfig(dir, { review: { depth: 'fast' } });
    expect(fastCfg.review.maxSteps).toBe(12);
    expect(fastCfg.review.triageMaxSteps).toBe(4);
    expect(fastCfg.review.maxOutputTokens).toBe(8_192);
    expect(fastCfg.review.maxFollowUpRounds).toBe(0);
    expect(fastCfg.review.stageTimeoutMs).toBe(180_000);

    const balancedCfg = loadConfig(dir, { review: { depth: 'balanced' } });
    expect(balancedCfg.review.maxSteps).toBe(18);
    expect(balancedCfg.review.triageMaxSteps).toBe(6);
    expect(balancedCfg.review.maxOutputTokens).toBe(12_288);
    expect(balancedCfg.review.maxFollowUpRounds).toBe(1);
    expect(balancedCfg.review.stageTimeoutMs).toBe(240_000);
  });

  test('resolves all named presets cleanly', () => {
    expect(resolveModels('sonnet').triage).toBe('anthropic:claude-sonnet-5-5');
    expect(resolveModels('sonnet-opus').triage).toBe('anthropic:claude-sonnet-5-5');
    expect(resolveModels('sonnet-opus').verifier).toBe('anthropic:claude-opus-5-5');
    expect(resolveModels('cross-model').verifier).toBe('openai:gpt-5.2');
    expect(resolveModels('subscription').triage).toBe('claude-cli:haiku');
    expect(resolveModels('subscription').verifier).toBe('claude-cli:opus');
    expect(resolveModels('local-gpu').triage).toBe('openai-compat:local');
    expect(resolveModels('local-gpu').verifier).toBe('opencode-cli:local');
  });

  test('loads civireview.yaml and merges per-stage overrides + CLI overrides', () => {
    const dir = makeTempDir();
    writeFileSync(
      join(dir, 'civireview.yaml'),
      `
trigger: "@review-bot"
preset: cross-model
models:
  specialists:
    security: openai:gpt-5.2
    ui: google:gemini-2.5-pro
ab:
  runDemo: true
review:
  confidenceThreshold: 85
`,
      'utf8',
    );

    const cfg = loadConfig(dir, {
      models: {
        verifier: 'anthropic:claude-opus-4-6',
      },
      review: {
        maxInlineComments: 5,
      },
    });

    expect(cfg.trigger).toBe('@review-bot');
    expect(cfg.preset).toBe('cross-model');
    expect(cfg.models.triage).toBe('anthropic:claude-haiku-5-5');
    expect(cfg.models.specialists.correctness).toBe('anthropic:claude-sonnet-5-5');
    expect(cfg.models.specialists.security).toBe('openai:gpt-5.2');
    expect(cfg.models.specialists.ui).toBe('google:gemini-2.5-pro');
    // CLI override beats YAML & preset
    expect(cfg.models.verifier).toBe('anthropic:claude-opus-4-6');
    expect(cfg.ab.runDemo).toBe(true);
    expect(cfg.review.confidenceThreshold).toBe(85);
    expect(cfg.review.maxInlineComments).toBe(5);
  });

  test('loads .civireview.yaml fallback and rejects invalid model spec', () => {
    const dir = makeTempDir();
    writeFileSync(
      join(dir, '.civireview.yaml'),
      `
models:
  triage: invalid-provider:foo
`,
      'utf8',
    );

    expect(() => loadConfig(dir)).toThrow();
  });

  test('defaults browser & a11y checks to ON and resolves include/exclude for checks and lenses', () => {
    const dir = makeTempDir();
    const cfg = loadConfig(dir);

    expect(cfg.checks.browser).toBe(true);
    expect(cfg.checks.a11y).toBe(true);
    expect(cfg.checks.abTests).toBe(true);
    expect(cfg.checks.surface).toBe(true);
    expect(cfg.checks.staticDelta).toBe(true);
    expect(cfg.checks.lifecycle).toBe(true);
    expect(cfg.checks.interactiveBrowser).toBe(false);
    expect(cfg.checks.matrix).toBe(false);
    expect(cfg.checks.liveProve).toBe(false);
    expect(cfg.browser.maxAutoPages).toBe(5);
    expect(cfg.browser.viewport).toBe('1280x800');
    expect(cfg.browser.sendScreenshotsToLlm).toBe(true);

    expect(isCheckEnabled(cfg, 'browser')).toBe(true);
    expect(isCheckEnabled(cfg, 'a11y')).toBe(true);
    expect(isCheckEnabled(cfg, 'matrix')).toBe(false);
    expect(isLensEnabled(cfg, 'security')).toBe(true);
    expect(isLensEnabled(cfg, 'ui')).toBe(true);

    // Exclude skips specific checks/lenses while keeping others enabled
    const excludedCfg = loadConfig(dir, {
      review: { exclude: ['a11y', 'tests'] },
    });
    expect(isCheckEnabled(excludedCfg, 'browser')).toBe(true);
    expect(isCheckEnabled(excludedCfg, 'a11y')).toBe(false);
    expect(isLensEnabled(excludedCfg, 'tests')).toBe(false);
    expect(isLensEnabled(excludedCfg, 'ui')).toBe(true);

    // Non-empty include restricts both checks and lenses strictly to listed keys (minus exclude)
    const includedCfg = loadConfig(dir, {
      review: {
        include: ['browser', 'a11y', 'ui', 'security'],
        exclude: ['a11y'],
      },
    });
    expect(isCheckEnabled(includedCfg, 'browser')).toBe(true);
    expect(isCheckEnabled(includedCfg, 'a11y')).toBe(false);
    expect(isCheckEnabled(includedCfg, 'ab-tests')).toBe(false);
    expect(isLensEnabled(includedCfg, 'ui')).toBe(true);
    expect(isLensEnabled(includedCfg, 'security')).toBe(true);
    expect(isLensEnabled(includedCfg, 'correctness')).toBe(false);
  });
});
