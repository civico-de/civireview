import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { ClaudeCliRunner, extractJsonFromCliText } from '../src/runners/claude-cli.ts';
import { CodexCliRunner, toCodexStrictJsonSchema } from '../src/runners/codex-cli.ts';
import { OpenCodeCliRunner } from '../src/runners/opencode-cli.ts';
import type { StageRequest } from '../src/runners/types.ts';

const Schema = z.object({ verdict: z.string(), note: z.string().optional() });

const FAKE_CLI = `#!/bin/sh
printf '%s\\n' "$@" > "$FAKE_DIR/args.txt"
printf '%s' "$ENABLE_TOOL_SEARCH" > "$FAKE_DIR/tool-search.txt"
printf '%s' "$OPENCODE_CONFIG_CONTENT" > "$FAKE_DIR/opencode-config.json"
cat > "$FAKE_DIR/stdin.txt"
while [ $# -gt 0 ]; do
  case "$1" in
    --output-last-message) out="$2" ;;
    --output-schema) cp "$2" "$FAKE_DIR/schema.json" ;;
    --mcp-config) cp "$2" "$FAKE_DIR/mcp-config.json" ;;
  esac
  shift
done
[ -n "$FAKE_SLEEP" ] && sleep "$FAKE_SLEEP"
[ -n "$out" ] && cp "$FAKE_DIR/stdout.txt" "$out"
cat "$FAKE_DIR/stdout.txt"
[ -n "$FAKE_STDERR" ] && printf '%s' "$FAKE_STDERR" >&2
exit "\${FAKE_EXIT:-0}"
`;

const ENV_KEYS = [
  'CLAUDE_BIN',
  'CODEX_BIN',
  'OPENCODE_BIN',
  'FAKE_DIR',
  'FAKE_EXIT',
  'FAKE_SLEEP',
  'FAKE_STDERR',
] as const;

let dir = '';
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
  dir = mkdtempSync(join(tmpdir(), 'civireview-cli-test-'));
  const bin = join(dir, 'fake-cli');
  writeFileSync(bin, FAKE_CLI);
  chmodSync(bin, 0o755);
  process.env.CLAUDE_BIN = bin;
  process.env.CODEX_BIN = bin;
  process.env.OPENCODE_BIN = bin;
  process.env.FAKE_DIR = dir;
  delete process.env.FAKE_EXIT;
  delete process.env.FAKE_SLEEP;
  delete process.env.FAKE_STDERR;
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  rmSync(dir, { recursive: true, force: true });
});

function respond(stdout: string): void {
  writeFileSync(join(dir, 'stdout.txt'), stdout);
}

function read(name: string): string {
  return readFileSync(join(dir, name), 'utf8');
}

function request(model: string, extra: Partial<StageRequest<z.infer<typeof Schema>>> = {}) {
  return {
    stage: 'triage',
    model,
    cwd: dir,
    systemPrompt: 'SYSTEM',
    sharedPrefix: 'SHARED',
    userPrompt: 'USER',
    schema: Schema,
    ...extra,
  } as StageRequest<z.infer<typeof Schema>>;
}

describe('extractJsonFromCliText', () => {
  test('parses plain JSON, fenced JSON and JSON embedded in prose', () => {
    expect(extractJsonFromCliText('{"a":1}')).toEqual({ a: 1 });
    expect(extractJsonFromCliText('Here:\n```json\n{"a":2}\n```\nDone')).toEqual({ a: 2 });
    expect(extractJsonFromCliText('Result is {"a":3} as requested.')).toEqual({ a: 3 });
  });

  test('rejects empty and non-JSON output with a clear error', () => {
    expect(() => extractJsonFromCliText('  ')).toThrow(/empty output/);
    expect(() => extractJsonFromCliText('no json here')).toThrow(/Could not parse JSON/);
  });
});

const event = (type: string, content: unknown[]) => JSON.stringify({ type, message: { content } });

const init = (status: string) =>
  JSON.stringify({
    type: 'system',
    subtype: 'init',
    mcp_servers: [
      { name: 'live-probe', status },
      { name: 'playwright', status: 'failed' },
    ],
  });

describe('claude CLI runner', () => {
  test('sends the prompt on stdin, restricts tools, and reads structured output with usage and cost', async () => {
    respond(
      JSON.stringify({
        type: 'result',
        structured_output: { verdict: 'ok' },
        total_cost_usd: 0.1234567,
        usage: {
          input_tokens: 100,
          output_tokens: 20,
          cache_read_input_tokens: 50,
          cache_creation_input_tokens: 10,
        },
      }),
    );

    const res = await new ClaudeCliRunner().run(
      request('claude-cli:sonnet', { effort: 'high', maxSteps: 7 }),
    );

    expect(res.output).toEqual({ verdict: 'ok' });
    expect(res.provider).toBe('claude-cli');
    expect(res.usage).toMatchObject({
      inputTokens: 100,
      outputTokens: 20,
      cachedInputTokens: 50,
      cacheWriteInputTokens: 10,
      totalTokens: 180,
    });
    expect(res.usage?.estimatedUsd).toBeCloseTo(0.1235, 4);

    const args = read('args.txt').split('\n');
    expect(args).toEqual(expect.arrayContaining(['-p', '--model', 'sonnet', '--effort', 'high']));
    expect(args[args.indexOf('--disallowedTools') + 1]).toBe('Write,Edit,Bash,NotebookEdit');
    expect(args[args.indexOf('--allowedTools') + 1]).toBe('Read,Grep,Glob');
    expect(args[args.indexOf('--max-turns') + 1]).toBe('7');
    expect(args[args.indexOf('--output-format') + 1]).toBe('stream-json');
    expect(args).toContain('--verbose');
    expect(read('stdin.txt')).toBe('SYSTEM\n\nSHARED\n\nUSER');
  });

  test('falls back to a JSON string in `result` and omits --model for the default model', async () => {
    respond(
      JSON.stringify({ type: 'result', result: 'Sure:\n```json\n{"verdict":"fenced"}\n```' }),
    );

    const res = await new ClaudeCliRunner().run(request('claude-cli:default'));

    expect(res.output.verdict).toBe('fenced');
    expect(read('args.txt')).not.toContain('--model');
  });

  test('records tool calls from the stream and offers the live tool over MCP', async () => {
    const stacks = mkdtempSync(join(tmpdir(), 'civireview-stacks-'));
    const composeFiles = { A: join(stacks, 'A.compose.json'), B: join(stacks, 'B.compose.json') };
    respond(
      [
        JSON.stringify({ type: 'system', subtype: 'init' }),
        event('assistant', [
          { type: 'tool_use', id: 't1', name: 'Read', input: { file_path: 'a.php' } },
          {
            type: 'tool_use',
            id: 't2',
            name: 'mcp__live-probe__live_probe_ab',
            input: { mode: 'exec', argv: ['cv', 'api3', 'Job.send_reminder'] },
          },
          { type: 'tool_use', id: 't3', name: 'Grep', input: { pattern: 'x' } },
          { type: 'tool_use', id: 't4', name: 'StructuredOutput', input: { verdict: 'ok' } },
        ]),
        event('user', [
          { type: 'tool_result', tool_use_id: 't1', content: 'line 1' },
          {
            type: 'tool_result',
            tool_use_id: 't2',
            content: [{ type: 'text', text: '{"mode":"exec","exitCodes":{"A":0,"B":0}}' }],
          },
          { type: 'tool_result', tool_use_id: 't3', content: 'boom', is_error: true },
        ]),
        JSON.stringify({
          type: 'result',
          num_turns: 3,
          structured_output: { verdict: 'ok' },
          usage: { input_tokens: 1, output_tokens: 1 },
        }),
      ].join('\n'),
    );

    const res = await new ClaudeCliRunner().run(
      request('claude-cli:sonnet', {
        liveStacks: { composeFiles, urls: {}, maxExecSeconds: 180 },
        extraMcpServers: [{ name: 'playwright', command: 'npx', args: ['-y', '@playwright/mcp'] }],
      }),
    );

    expect(res.usage).toMatchObject({ steps: 3, toolCalls: 3 });
    expect(res.usage?.toolUses).toEqual([
      { tool: 'Read', input: '{"file_path":"a.php"}', output: 'line 1' },
      {
        tool: 'live_probe_ab',
        input: '{"mode":"exec","argv":["cv","api3","Job.send_reminder"]}',
        output: '{"mode":"exec","exitCodes":{"A":0,"B":0}}',
      },
      { tool: 'Grep', input: '{"pattern":"x"}' },
    ]);
    const args = read('args.txt').split('\n');
    expect(args[args.indexOf('--allowedTools') + 1]).toBe(
      'Read,Grep,Glob,mcp__playwright__*,mcp__live-probe__*',
    );
    expect(read('tool-search.txt')).toBe('false');
    const config = JSON.parse(read('mcp-config.json'));
    const live = config.mcpServers['live-probe'];
    expect(live).toMatchObject({ type: 'stdio', command: process.execPath, timeout: 210_000 });
    // both servers start through the wrapper that leaves the PR worktree
    expect(live.args.slice(0, 3)).toEqual(['--cwd', expect.any(String), '--no-env-file']);
    expect(JSON.parse(live.args.at(-1)).composeFiles).toEqual(composeFiles);
    expect(config.mcpServers.playwright.args.slice(-3)).toEqual(['npx', '-y', '@playwright/mcp']);
  });

  test('fails when the stream has no result event', async () => {
    respond(JSON.stringify({ type: 'system', subtype: 'init' }));
    await expect(new ClaudeCliRunner().run(request('claude-cli:sonnet'))).rejects.toThrow(
      /no result event/,
    );
  });

  test('fails when the live tool server did not start, and warns for other servers', async () => {
    const stacks = mkdtempSync(join(tmpdir(), 'civireview-stacks-'));
    const composeFiles = { A: join(stacks, 'A.compose.json'), B: join(stacks, 'B.compose.json') };
    const result = JSON.stringify({ type: 'result', structured_output: { verdict: 'ok' } });
    const req = request('claude-cli:sonnet', {
      liveStacks: { composeFiles, urls: {}, maxExecSeconds: 60 },
    });

    respond([init('failed'), result].join('\n'));
    await expect(new ClaudeCliRunner().run(req)).rejects.toThrow(
      /could not start the live tool: live-probe \(failed\)/,
    );

    respond([init('connected'), result].join('\n'));
    const warnings: string[] = [];
    const warn = console.warn;
    console.warn = (msg: string) => warnings.push(msg);
    try {
      expect((await new ClaudeCliRunner().run(req)).output.verdict).toBe('ok');
    } finally {
      console.warn = warn;
    }
    expect(warnings).toEqual([
      '[civireview:warn] MCP server playwright (failed) unavailable, continuing without it',
    ]);
  });

  test('names the error of the result event on a non-zero exit', async () => {
    respond(
      [
        JSON.stringify({ type: 'system', subtype: 'init', tools: ['x'.repeat(2000)] }),
        JSON.stringify({
          type: 'result',
          subtype: 'error_max_turns',
          errors: ['Reached max turns (7)'],
        }),
      ].join('\n'),
    );
    process.env.FAKE_EXIT = '1';

    await expect(new ClaudeCliRunner().run(request('claude-cli:sonnet'))).rejects.toThrow(
      'claude CLI exited with 1: error_max_turns: Reached max turns (7)',
    );
  });

  test('reports a non-zero exit with the CLI output', async () => {
    respond('');
    process.env.FAKE_EXIT = '3';
    process.env.FAKE_STDERR = 'rate limited';

    await expect(new ClaudeCliRunner().run(request('claude-cli:sonnet'))).rejects.toThrow(
      /claude CLI exited with 3: rate limited/,
    );
  });

  test('rejects output that does not match the stage schema', async () => {
    respond(JSON.stringify({ type: 'result', structured_output: { wrong: true } }));

    await expect(new ClaudeCliRunner().run(request('claude-cli:sonnet'))).rejects.toThrow();
  });

  test('kills a CLI that outlives the stage timeout', async () => {
    respond('{}');
    process.env.FAKE_SLEEP = '30';
    const started = Date.now();

    await expect(
      new ClaudeCliRunner().run(request('claude-cli:sonnet', { timeoutMs: 300 })),
    ).rejects.toThrow(/claude CLI timed out after 300ms/);
    expect(Date.now() - started).toBeLessThan(10_000);
  });
});

describe('codex CLI runner', () => {
  test('runs read-only with a strict output schema and drops null fields from the answer', async () => {
    respond('{"verdict":"ok","note":null}');

    const res = await new CodexCliRunner().run(request('codex-cli:gpt-5.2', { effort: 'max' }));

    expect(res.output).toEqual({ verdict: 'ok' });
    const args = read('args.txt').split('\n');
    expect(args).toEqual(expect.arrayContaining(['exec', '--model', 'gpt-5.2']));
    expect(args[args.indexOf('--sandbox') + 1]).toBe('read-only');
    expect(args).toContain('model_reasoning_effort="xhigh"');
    expect(read('stdin.txt')).toContain(
      'Respond with valid JSON matching the provided output schema only.',
    );

    const schema = JSON.parse(read('schema.json')) as {
      required: string[];
      additionalProperties: boolean;
      properties: { note: { type: string[] } };
    };
    expect(schema.required).toEqual(['verdict', 'note']);
    expect(schema.additionalProperties).toBe(false);
    expect(schema.properties.note.type).toEqual(['string', 'null']);
  });

  test('reports the tail of the output on a non-zero exit', async () => {
    respond('');
    process.env.FAKE_EXIT = '2';
    process.env.FAKE_STDERR = 'sandbox violation';

    await expect(new CodexCliRunner().run(request('codex-cli:default'))).rejects.toThrow(
      /codex CLI exited with 2: sandbox violation/,
    );
  });

  test('kills a CLI that outlives the stage timeout', async () => {
    respond('{}');
    process.env.FAKE_SLEEP = '30';

    await expect(
      new CodexCliRunner().run(request('codex-cli:default', { timeoutMs: 300 })),
    ).rejects.toThrow(/codex CLI timed out/);
  });
});

describe('toCodexStrictJsonSchema', () => {
  test('makes optional properties required and nullable, recursively', () => {
    const nested = z.object({
      items: z.array(z.object({ id: z.string(), tag: z.string().optional() })),
    });

    const schema = toCodexStrictJsonSchema(nested) as {
      properties: {
        items: {
          items: {
            required: string[];
            additionalProperties: boolean;
            properties: Record<string, { type: unknown }>;
          };
        };
      };
    };

    const item = schema.properties.items.items;
    expect(item.required).toEqual(['id', 'tag']);
    expect(item.additionalProperties).toBe(false);
    expect(item.properties.tag!.type).toEqual(['string', 'null']);
    expect(item.properties.id!.type).toBe('string');
  });
});

describe('opencode CLI runner', () => {
  test('denies edit, bash and webfetch and parses the JSON answer', async () => {
    respond('Here you go:\n```json\n{"verdict":"ok"}\n```');

    const res = await new OpenCodeCliRunner().run(request('opencode-cli:local/qwen'));

    expect(res.output).toEqual({ verdict: 'ok' });
    expect(JSON.parse(read('opencode-config.json'))).toEqual({
      permission: { edit: 'deny', bash: 'deny', webfetch: 'deny' },
    });
    const args = read('args.txt').split('\n');
    expect(args.slice(0, 4)).toEqual(['run', '--standalone', '-m', 'local/qwen']);
  });

  test('kills a CLI that outlives the stage timeout', async () => {
    respond('{}');
    process.env.FAKE_SLEEP = '30';

    await expect(
      new OpenCodeCliRunner().run(request('opencode-cli:local/qwen', { timeoutMs: 300 })),
    ).rejects.toThrow(/opencode CLI timed out/);
  });
});
