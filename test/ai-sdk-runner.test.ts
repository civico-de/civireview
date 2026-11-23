import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { AiSdkRunner } from '../src/runners/ai-sdk.ts';
import type { StageRequest } from '../src/runners/types.ts';

const Schema = z.object({ verdict: z.string() });

type ChatBody = { messages: Array<{ role: string; content: unknown }>; tools?: unknown[] };

let server: ReturnType<typeof Bun.serve>;
let requests: ChatBody[] = [];
let replies: Array<() => Response> = [];
let repo = '';
const savedEnv = { base: process.env.OPENAI_COMPAT_BASE_URL };

function completion(message: object, usage = { prompt_tokens: 100, completion_tokens: 20 }) {
  return () =>
    Response.json({
      id: 'cmpl-1',
      object: 'chat.completion',
      created: 1,
      model: 'local',
      choices: [{ index: 0, message: { role: 'assistant', ...message }, finish_reason: 'stop' }],
      usage: { ...usage, total_tokens: usage.prompt_tokens + usage.completion_tokens },
    });
}

beforeEach(() => {
  requests = [];
  replies = [];
  repo = mkdtempSync(join(tmpdir(), 'civireview-aisdk-'));
  writeFileSync(join(repo, 'hello.txt'), 'first line\nsecond line\n');
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      requests.push((await req.json()) as ChatBody);
      const next = replies.shift();
      return next ? next() : new Response('no canned reply left', { status: 500 });
    },
  });
  process.env.OPENAI_COMPAT_BASE_URL = `http://127.0.0.1:${server.port}/v1`;
});

afterEach(async () => {
  await server.stop(true);
  if (savedEnv.base === undefined) delete process.env.OPENAI_COMPAT_BASE_URL;
  else process.env.OPENAI_COMPAT_BASE_URL = savedEnv.base;
  rmSync(repo, { recursive: true, force: true });
});

function request(extra: Partial<StageRequest<z.infer<typeof Schema>>> = {}) {
  return {
    stage: 'triage',
    model: 'openai-compat:local',
    cwd: repo,
    systemPrompt: 'SYSTEM PROMPT',
    sharedPrefix: 'SHARED PREFIX',
    userPrompt: 'USER PROMPT',
    schema: Schema,
    maxSteps: 4,
    ...extra,
  } as StageRequest<z.infer<typeof Schema>>;
}

describe('AiSdkRunner against an OpenAI-compatible endpoint', () => {
  test('returns schema-validated output with prompts, structured-output request and usage', async () => {
    replies.push(completion({ content: '{"verdict":"ok"}' }));

    const res = await new AiSdkRunner().run(request());

    expect(res.output).toEqual({ verdict: 'ok' });
    expect(res.provider).toBe('openai-compat');
    expect(res.usage).toMatchObject({
      inputTokens: 100,
      outputTokens: 20,
      totalTokens: 120,
      steps: 1,
      toolCalls: 0,
    });

    const sent = requests[0]!;
    const systemText = sent.messages
      .filter((m) => m.role === 'system')
      .map((m) => m.content)
      .join('\n');
    expect(systemText).toContain('SHARED PREFIX');
    expect(systemText).toContain('SYSTEM PROMPT');
    expect(JSON.stringify(sent.messages.at(-1))).toContain('USER PROMPT');
    expect(JSON.stringify(sent)).toContain('json_schema');
  });

  test('lets the model read repository files through the sandboxed tools and counts the step', async () => {
    replies.push(
      completion({
        content: null,
        tool_calls: [
          {
            id: 'call_1',
            type: 'function',
            function: { name: 'read_file', arguments: JSON.stringify({ path: 'hello.txt' }) },
          },
        ],
      }),
      completion({ content: '{"verdict":"read it"}' }),
    );

    const res = await new AiSdkRunner().run(request());

    expect(res.output.verdict).toBe('read it');
    expect(res.usage).toMatchObject({ steps: 2, toolCalls: 1 });
    expect(JSON.stringify(requests[1])).toContain('2: second line');
  });

  test('a tool call outside the repository is answered with an error instead of file content', async () => {
    writeFileSync(join(repo, '..', 'civireview-outside.txt'), 'TOP SECRET');
    replies.push(
      completion({
        content: null,
        tool_calls: [
          {
            id: 'call_1',
            type: 'function',
            function: {
              name: 'read_file',
              arguments: JSON.stringify({ path: '../civireview-outside.txt' }),
            },
          },
        ],
      }),
      completion({ content: '{"verdict":"blocked"}' }),
    );

    try {
      await new AiSdkRunner().run(request());
    } finally {
      rmSync(join(repo, '..', 'civireview-outside.txt'), { force: true });
    }

    expect(JSON.stringify(requests[1])).not.toContain('TOP SECRET');
  });

  test('extracts JSON from fenced text when the structured output parse fails', async () => {
    replies.push(completion({ content: 'Sure:\n```json\n{"verdict":"fenced"}\n```' }));

    const res = await new AiSdkRunner().run(request());

    expect(res.output.verdict).toBe('fenced');
  });

  test('reports a descriptive error when the model returns no usable JSON', async () => {
    replies.push(completion({ content: 'I cannot help with that.' }));

    await expect(new AiSdkRunner().run(request())).rejects.toThrow(
      /Stage "triage" \(openai-compat:local\) produced no structured output/,
    );
  });

  test('rejects JSON that does not match the schema', async () => {
    replies.push(completion({ content: '{"wrong":1}' }));

    await expect(new AiSdkRunner().run(request())).rejects.toThrow();
  });

  test('surfaces an HTTP error from the endpoint', async () => {
    // 4xx is not retried by the SDK, which keeps the test fast.
    replies.push(() => new Response('bad request', { status: 400 }));

    await expect(new AiSdkRunner().run(request({ timeoutMs: 20_000 }))).rejects.toThrow();
  });

  test('rejects providers it does not handle', async () => {
    await expect(new AiSdkRunner().run(request({ model: 'claude-cli:sonnet' }))).rejects.toThrow(
      /does not support provider "claude-cli"/,
    );
  });
});
