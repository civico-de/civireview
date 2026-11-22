import { afterEach, describe, expect, test } from 'bun:test';
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { createLiveProbeTool } from '../src/runners/live-prove.ts';
import {
  createRunnerRegistry,
  runStage,
} from '../src/runners/registry.ts';
import {
  createRepoTools,
  resolveSafeRepoPath,
} from '../src/runners/repo-tools.ts';
import { parseModelSpec, type StageRunner } from '../src/runners/types.ts';

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'civireview-runner-test-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

describe('runners', () => {
  test('parseModelSpec parses all 8 supported providers and preserves colons in modelId', () => {
    expect(parseModelSpec('anthropic:claude-sonnet-4-6')).toEqual({
      raw: 'anthropic:claude-sonnet-4-6',
      provider: 'anthropic',
      modelId: 'claude-sonnet-4-6',
    });
    expect(parseModelSpec('openai:gpt-5.2')).toEqual({
      raw: 'openai:gpt-5.2',
      provider: 'openai',
      modelId: 'gpt-5.2',
    });
    expect(parseModelSpec('google:gemini-2.5-pro')).toEqual({
      raw: 'google:gemini-2.5-pro',
      provider: 'google',
      modelId: 'gemini-2.5-pro',
    });
    expect(parseModelSpec('openrouter:anthropic/claude-sonnet-4-6')).toEqual({
      raw: 'openrouter:anthropic/claude-sonnet-4-6',
      provider: 'openrouter',
      modelId: 'anthropic/claude-sonnet-4-6',
    });
    expect(parseModelSpec('openai-compat:qwen2.5-coder:32b')).toEqual({
      raw: 'openai-compat:qwen2.5-coder:32b',
      provider: 'openai-compat',
      modelId: 'qwen2.5-coder:32b',
    });
    expect(parseModelSpec('claude-cli:opus')).toEqual({
      raw: 'claude-cli:opus',
      provider: 'claude-cli',
      modelId: 'opus',
    });
    expect(parseModelSpec('codex-cli:gpt-5.2-codex')).toEqual({
      raw: 'codex-cli:gpt-5.2-codex',
      provider: 'codex-cli',
      modelId: 'gpt-5.2-codex',
    });
    expect(parseModelSpec('opencode-cli:local')).toEqual({
      raw: 'opencode-cli:local',
      provider: 'opencode-cli',
      modelId: 'local',
    });

    expect(() => parseModelSpec('unknown:model')).toThrow();
    expect(() => parseModelSpec('anthropic')).toThrow();
  });

  test('resolveSafeRepoPath blocks path traversal, absolute paths, and symlink escapes', async () => {
    const repoDir = makeTempDir();
    const outsideDir = makeTempDir();
    mkdirSync(join(repoDir, 'src'), { recursive: true });
    writeFileSync(join(repoDir, 'src', 'ok.txt'), 'line1\nline2\n', 'utf8');
    writeFileSync(join(outsideDir, 'secret.txt'), 'top-secret', 'utf8');
    symlinkSync(
      join(outsideDir, 'secret.txt'),
      join(repoDir, 'src', 'escape-link.txt'),
    );

    expect(resolveSafeRepoPath(repoDir, 'src/ok.txt')).toContain('ok.txt');
    expect(() => resolveSafeRepoPath(repoDir, '../secret.txt')).toThrow();
    expect(() =>
      resolveSafeRepoPath(repoDir, 'src/../../secret.txt'),
    ).toThrow();
    expect(() => resolveSafeRepoPath(repoDir, '/etc/passwd')).toThrow();
    expect(() =>
      resolveSafeRepoPath(repoDir, 'src/escape-link.txt'),
    ).toThrow();

    const tools = createRepoTools(repoDir);
    const readTool = tools.read_file;
    expect(readTool).toBeDefined();
    if (readTool && 'execute' in readTool && readTool.execute) {
      const content = await readTool.execute(
        { path: 'src/ok.txt' },
        { toolCallId: 't1', messages: [], context: undefined },
      );
      expect(content).toContain('1: line1');

      await expect(
        readTool.execute(
          { path: 'src/escape-link.txt' },
          { toolCallId: 't2', messages: [], context: undefined },
        ),
      ).rejects.toThrow();
    }
  });

  test('createRunnerRegistry dispatches to mocked provider runner', async () => {
    const Schema = z.object({ ok: z.boolean(), note: z.string() });
    const calls: string[] = [];

    const mockRunner: StageRunner = {
      providers: ['anthropic', 'openai'],
      async run(req) {
        calls.push(`${req.stage}:${req.model}`);
        return {
          output: req.schema.parse({ ok: true, note: 'mocked' }),
          model: req.model,
          provider: parseModelSpec(req.model).provider,
          durationMs: 1,
        };
      },
    };

    const registry = createRunnerRegistry({
      anthropic: mockRunner,
      openai: mockRunner,
    });

    const res = await runStage(
      {
        stage: 'verifier',
        model: 'openai:gpt-5.2',
        cwd: process.cwd(),
        systemPrompt: 'sys',
        userPrompt: 'usr',
        schema: Schema,
      },
      registry,
    );

    expect(res.provider).toBe('openai');
    expect(res.output).toEqual({ ok: true, note: 'mocked' });
    expect(calls).toEqual(['verifier:openai:gpt-5.2']);
  });

  test('createLiveProbeTool enforces localhost-only URLs and read-only cv api4 probes', async () => {
    const dir = makeTempDir();
    const composeA = join(dir, 'compose-a.yml');
    const composeB = join(dir, 'compose-b.yml');
    writeFileSync(composeA, 'services: {}');
    writeFileSync(composeB, 'services: {}');

    const toolSet = createLiveProbeTool({
      urlA: 'http://127.0.0.1:41001',
      urlB: 'http://localhost:41002',
      composeFileA: composeA,
      composeFileB: composeB,
      fetchFn: (async (input: string | URL | Request) => {
        const url = String(input);
        const body = url.includes('41001') ? 'old-a' : 'new-b';
        return new Response(body, {
          status: url.includes('41001') ? 500 : 200,
          headers: { 'content-type': 'text/html' },
        });
      }) as typeof fetch,
      execFn: async (args) => {
        const isA = args.includes(composeA);
        return {
          exitCode: 0,
          stdout: isA ? '[{"id":1}]' : '[{"id":1},{"id":2}]',
          stderr: '',
        };
      },
    });

    const probe = toolSet.live_probe_ab!;
    expect(probe.execute).toBeDefined();

    const httpRes = (await probe.execute!(
      { mode: 'http-get', route: 'civicrm/dashboard?reset=1', action: 'get' },
      { toolCallId: 'p1', messages: [], context: undefined },
    )) as { a: { status: number }; b: { status: number }; differs: boolean };
    expect(httpRes.a.status).toBe(500);
    expect(httpRes.b.status).toBe(200);
    expect(httpRes.differs).toBe(true);

    // Rejects off-origin URL injection
    await expect(
      probe.execute!(
        { mode: 'http-get', route: 'https://evil.example/steal', action: 'get' },
        { toolCallId: 'p2', messages: [], context: undefined },
      ),
    ).rejects.toThrow(/Invalid route/);

    const api4Res = (await probe.execute!(
      { mode: 'api4-read', entity: 'Contact', action: 'get', paramsJson: '{"limit":2}' },
      { toolCallId: 'p3', messages: [], context: undefined },
    )) as { differs: boolean; command: string };
    expect(api4Res.differs).toBe(true);
    expect(api4Res.command).toContain('cv api4 Contact.get');

    // Rejects unsafe entity names
    await expect(
      probe.execute!(
        { mode: 'api4-read', entity: 'Contact; rm -rf /', action: 'get' },
        { toolCallId: 'p4', messages: [], context: undefined },
      ),
    ).rejects.toThrow(/Invalid APIv4 entity/);
  });
});
