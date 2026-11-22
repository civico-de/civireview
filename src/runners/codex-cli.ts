import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { z } from 'zod';
import { extractJsonFromCliText, toCliJsonSchema } from './claude-cli.ts';
import {
  parseModelSpec,
  type StageRequest,
  type StageResult,
  type StageRunner,
} from './types.ts';

function makeOpenAiStrictSchema(node: unknown): unknown {
  if (Array.isArray(node)) {
    return node.map(makeOpenAiStrictSchema);
  }
  if (!node || typeof node !== 'object') {
    return node;
  }
  const obj = { ...(node as Record<string, unknown>) };
  delete obj.$schema;
  // OpenAI strict mode rejects unsupported keywords on objects/strings in some contexts
  delete obj.propertyNames;

  if (obj.type === 'object' && obj.properties && typeof obj.properties === 'object') {
    const props = obj.properties as Record<string, unknown>;
    const existingRequired = new Set<string>(
      Array.isArray(obj.required) ? (obj.required as string[]) : [],
    );
    const nextProps: Record<string, unknown> = {};
    for (const [key, propVal] of Object.entries(props)) {
      let transformed = makeOpenAiStrictSchema(propVal) as Record<string, unknown>;
      if (!existingRequired.has(key)) {
        if (typeof transformed.type === 'string') {
          transformed = { ...transformed, type: [transformed.type, 'null'] };
        } else if (Array.isArray(transformed.type)) {
          if (!transformed.type.includes('null')) {
            transformed = { ...transformed, type: [...transformed.type, 'null'] };
          }
        } else if (Array.isArray(transformed.anyOf)) {
          transformed = {
            ...transformed,
            anyOf: [...transformed.anyOf, { type: 'null' }],
          };
        } else {
          transformed = { anyOf: [transformed, { type: 'null' }] };
        }
      }
      nextProps[key] = transformed;
    }
    obj.properties = nextProps;
    obj.required = Object.keys(nextProps);
    obj.additionalProperties = false;
  } else if (obj.type === 'object' && !obj.properties) {
    obj.additionalProperties = false;
  }

  if (obj.items !== undefined) {
    obj.items = makeOpenAiStrictSchema(obj.items);
  }
  if (Array.isArray(obj.anyOf)) {
    obj.anyOf = obj.anyOf.map(makeOpenAiStrictSchema);
  }
  if (Array.isArray(obj.oneOf)) {
    obj.oneOf = obj.oneOf.map(makeOpenAiStrictSchema);
  }
  if (Array.isArray(obj.allOf)) {
    obj.allOf = obj.allOf.map(makeOpenAiStrictSchema);
  }
  if (obj.$defs && typeof obj.$defs === 'object') {
    const nextDefs: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj.$defs as Record<string, unknown>)) {
      nextDefs[k] = makeOpenAiStrictSchema(v);
    }
    obj.$defs = nextDefs;
  }
  return obj;
}

export function toCodexStrictJsonSchema(schema: z.ZodType): Record<string, unknown> {
  return makeOpenAiStrictSchema(toCliJsonSchema(schema)) as Record<string, unknown>;
}

function stripNullFields(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(stripNullFields);
  }
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (v !== null) {
        out[k] = stripNullFields(v);
      }
    }
    return out;
  }
  return value;
}

export class CodexCliRunner implements StageRunner {
  readonly providers = ['codex-cli'] as const;

  async run<T>(req: StageRequest<T>): Promise<StageResult<T>> {
    const start = Date.now();
    const parsed = parseModelSpec(req.model);

    const tmpDir = mkdtempSync(join(tmpdir(), 'civireview-codex-'));
    chmodSync(tmpDir, 0o700);
    const schemaPath = join(tmpDir, 'output-schema.json');
    const outPath = join(tmpDir, 'last-message.json');

    writeFileSync(
      schemaPath,
      JSON.stringify(toCodexStrictJsonSchema(req.schema), null, 2),
      { mode: 0o600 },
    );

    const fullPrompt = [
      req.systemPrompt,
      req.sharedPrefix ?? '',
      req.userPrompt,
      'Respond with valid JSON matching the provided output schema only.',
    ]
      .filter(Boolean)
      .join('\n\n');

    const codexBin = process.env.CODEX_BIN || 'codex';
    const imageFlags: string[] = [];
    for (const img of (req.images ?? []).slice(0, 6)) {
      if (existsSync(img.path)) {
        imageFlags.push('-i', img.path);
      }
    }

    const args = [
      codexBin,
      'exec',
      ...(parsed.modelId !== 'default' ? ['--model', parsed.modelId] : []),
      '--sandbox',
      'read-only',
      '--output-schema',
      schemaPath,
      '--output-last-message',
      outPath,
      ...imageFlags,
      ...(req.mcpScope?.enabled && req.mcpScope.url
        ? [
            '-c',
            `mcp_servers.civicrm-knowledge.url=${JSON.stringify(req.mcpScope.url)}`,
          ]
        : []),
      '-',
    ];

    try {
      const proc = Bun.spawn(args, {
        cwd: req.cwd,
        stdin: new Blob([fullPrompt]),
        stdout: 'pipe',
        stderr: 'pipe',
      });

      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);

      if (exitCode !== 0) {
        const errTail = (stderr || stdout).slice(-1500);
        throw new Error(`codex CLI exited with ${exitCode}: ${errTail}`);
      }

      let rawText = stdout;
      try {
        rawText = readFileSync(outPath, 'utf8');
      } catch {
        // Fallback to stdout
      }

      const candidate = stripNullFields(extractJsonFromCliText(rawText));
      const output = req.schema.parse(candidate);

      return {
        output,
        model: parsed.raw,
        provider: parsed.provider,
        durationMs: Date.now() - start,
        rawText,
      };
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  }
}
