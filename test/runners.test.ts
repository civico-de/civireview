import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import {
  createLiveProbeTool,
  createStageLiveTools,
  liveProbeTool,
  execWithCappedOutput,
} from '../src/runners/live-prove.ts';
import { createRunnerRegistry, runStage } from '../src/runners/registry.ts';
import { createRepoTools, resolveSafeRepoPath } from '../src/runners/repo-tools.ts';
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

const execPrefix = (f: string) => [
  'docker',
  'compose',
  '-f',
  f,
  'exec',
  '-T',
  '-u',
  'www-data',
  '-w',
  '/var/www/html',
  'app',
  'sh',
  '-c',
  't=$1; shift; if command -v timeout >/dev/null 2>&1; then exec timeout -k 5 "$t" "$@"; fi; exec "$@"',
  'live-probe',
  '120',
];

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
    symlinkSync(join(outsideDir, 'secret.txt'), join(repoDir, 'src', 'escape-link.txt'));

    expect(resolveSafeRepoPath(repoDir, 'src/ok.txt')).toContain('ok.txt');
    expect(() => resolveSafeRepoPath(repoDir, '../secret.txt')).toThrow();
    expect(() => resolveSafeRepoPath(repoDir, 'src/../../secret.txt')).toThrow();
    expect(() => resolveSafeRepoPath(repoDir, '/etc/passwd')).toThrow();
    expect(() => resolveSafeRepoPath(repoDir, 'src/escape-link.txt')).toThrow();

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

  test('createLiveProbeTool keeps HTTP on localhost and runs exec argv inside the A/B containers', async () => {
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
      { mode: 'http-get', route: 'civicrm/dashboard?reset=1', target: 'both', timeoutSeconds: 60 },
      { toolCallId: 'p1', messages: [], context: undefined },
    )) as { a: { status: number }; b: { status: number }; differs: boolean };
    expect(httpRes.a.status).toBe(500);
    expect(httpRes.b.status).toBe(200);
    expect(httpRes.differs).toBe(true);

    // A difference below the displayed snippet still counts.
    const longProbe = createLiveProbeTool({
      urlA: 'http://127.0.0.1:41001',
      urlB: 'http://localhost:41002',
      composeFileA: composeA,
      composeFileB: composeB,
      fetchFn: (async (input: string | URL | Request) =>
        new Response(
          'x'.repeat(5000) + (String(input).includes('41001') ? 'a' : 'b'),
        )) as typeof fetch,
      execFn: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
    }).live_probe_ab!;
    const longRes = (await longProbe.execute!(
      { mode: 'http-get', route: 'civicrm/dashboard', target: 'both', timeoutSeconds: 60 },
      { toolCallId: 'p1b', messages: [], context: undefined },
    )) as { differs: boolean; a: Record<string, unknown> };
    expect(longRes.differs).toBe(true);
    expect(longRes.a.body).toBeUndefined();

    // Rejects off-origin URL injection
    await expect(
      probe.execute!(
        {
          mode: 'http-get',
          route: 'https://evil.example/steal',
          target: 'both',
          timeoutSeconds: 60,
        },
        { toolCallId: 'p2', messages: [], context: undefined },
      ),
    ).rejects.toThrow(/Invalid route/);

    const execCalls: string[][] = [];
    const execProbe = createLiveProbeTool({
      composeFileA: composeA,
      composeFileB: composeB,
      execFn: async (args, opts) => {
        execCalls.push([...args, `timeout=${opts?.timeoutMs}`]);
        const isA = args.includes(composeA);
        return {
          exitCode: isA ? 1 : 0,
          stdout: isA ? 'DB Error: syntax error' : 'sent 1',
          stderr: '',
        };
      },
    }).live_probe_ab!;
    const argv = ['cv', 'api3', 'Job.send_reminder'];
    const execRes = (await execProbe.execute!(
      { mode: 'exec', argv, target: 'both', timeoutSeconds: 120 },
      { toolCallId: 'p3', messages: [], context: undefined },
    )) as { differs: boolean; a: { exitCode: number }; b: { output: string } };
    expect(execRes.differs).toBe(true);
    expect(execRes.a.exitCode).toBe(1);
    expect(execRes.b.output).toBe('sent 1');
    // review.json keeps 300 characters of a result; the exit codes must sit before any output
    expect(JSON.stringify(execRes)).toStartWith('{"mode":"exec","exitCodes":{"A":1,"B":0},');
    // argv goes through positionally, bounded by `timeout` inside the container
    expect(execCalls).toEqual([
      [...execPrefix(composeA), ...argv, 'timeout=135000'],
      [...execPrefix(composeB), ...argv, 'timeout=135000'],
    ]);

    execCalls.length = 0;
    const onlyB = (await execProbe.execute!(
      {
        mode: 'exec',
        argv: ['cv', 'api4', 'Contact.create', '{"values":{}}'],
        target: 'B',
        timeoutSeconds: 60,
      },
      { toolCallId: 'p4', messages: [], context: undefined },
    )) as Record<string, unknown>;
    expect(execCalls).toHaveLength(1);
    expect(execCalls[0]).toContain(composeB);
    expect(onlyB.a).toBeUndefined();
    expect(onlyB.differs).toBeUndefined();

    await expect(
      execProbe.execute!(
        { mode: 'exec', argv: [], target: 'both', timeoutSeconds: 60 },
        { toolCallId: 'p5', messages: [], context: undefined },
      ),
    ).rejects.toThrow(/non-empty argv/);

    // Outputs that differ only in the truncated middle still differ.
    const middleProbe = createLiveProbeTool({
      composeFileA: composeA,
      composeFileB: composeB,
      execFn: async (args) => ({
        exitCode: 0,
        stdout: 'x'.repeat(5000) + (args.includes(composeA) ? 'A' : 'B') + 'y'.repeat(5000),
        stderr: '',
      }),
    }).live_probe_ab!;
    const middle = (await middleProbe.execute!(
      { mode: 'exec', argv: ['cv', 'api4', 'Contact.get'], target: 'both', timeoutSeconds: 60 },
      { toolCallId: 'p6', messages: [], context: undefined },
    )) as { differs: boolean; a: { output: string; raw?: string }; b: { output: string } };
    expect(middle.a.output).toBe(middle.b.output);
    expect(middle.differs).toBe(true);
    expect(middle.a.raw).toBeUndefined();
  });

  test('execWithCappedOutput stops an endless command at the capture limit', async () => {
    const res = await execWithCappedOutput(['yes'], { timeoutMs: 20_000 });
    expect(res.timedOut).toBe(false);
    expect(res.stdout.length).toBeLessThan(1_100_000);
    expect(res.stdout).toContain('[output stopped at 1000000 bytes; command killed]');

    // Exactly at the limit is complete output, not an overflow.
    const exact = await execWithCappedOutput(['head', '-c', '1000000', '/dev/zero'], {
      timeoutMs: 20_000,
    });
    expect(exact.exitCode).toBe(0);
    expect(exact.stdout.length).toBe(1_000_000);
    expect(exact.stdout).not.toContain('output stopped');
  });

  test('createStageLiveTools caps one exec at half the stage timeout', () => {
    const dir = makeTempDir();
    const A = join(dir, 'a.yml');
    const B = join(dir, 'b.yml');
    writeFileSync(A, 'services: {}');
    writeFileSync(B, 'services: {}');
    const runner = {
      providers: ['anthropic'] as const,
      supportsLiveStacks: true,
      run: async () => {
        throw new Error('not called');
      },
    };
    const liveFor = createStageLiveTools({
      enabled: true,
      stageTimeoutMs: 360_000,
      registry: createRunnerRegistry({ anthropic: runner as unknown as StageRunner }),
      urls: {},
      composeFiles: { A, B },
    });
    const stacks = liveFor('anthropic:claude-opus-5-5').stacks!;
    expect(stacks.maxExecSeconds).toBe(180);
    const schema = liveProbeTool(stacks).live_probe_ab!.inputSchema as z.ZodType;
    const parse = (timeoutSeconds: number) =>
      schema.safeParse({ mode: 'exec', argv: ['true'], timeoutSeconds }).success;
    expect(parse(180)).toBe(true);
    expect(parse(181)).toBe(false);
  });
});
