import { z } from 'zod';
import { extractJsonFromCliText } from './claude-cli.ts';
import {
  parseModelSpec,
  type StageRequest,
  type StageResult,
  type StageRunner,
} from './types.ts';

export class OpenCodeCliRunner implements StageRunner {
  readonly providers = ['opencode-cli'] as const;

  async run<T>(req: StageRequest<T>): Promise<StageResult<T>> {
    const start = Date.now();
    const parsed = parseModelSpec(req.model);
    const jsonSchema = JSON.stringify(z.toJSONSchema(req.schema), null, 2);

    const openCodeConfig: Record<string, unknown> = {
      permission: {
        edit: 'deny',
        bash: 'deny',
        webfetch: 'deny',
      },
    };
    if (req.mcpScope?.enabled && req.mcpScope.url) {
      openCodeConfig.mcp = {
        'civicrm-knowledge': {
          type: 'remote',
          url: req.mcpScope.url,
          ...(Object.keys(req.mcpScope.headers).length > 0
            ? { headers: req.mcpScope.headers }
            : {}),
          enabled: true,
        },
      };
    }

    const fullPrompt = [
      req.systemPrompt,
      req.sharedPrefix ?? '',
      req.userPrompt,
      `Return ONLY valid JSON conforming to this JSON Schema:\n${jsonSchema}`,
    ]
      .filter(Boolean)
      .join('\n\n');

    const args = [
      'opencode',
      'run',
      '--standalone',
      '-m',
      parsed.modelId,
      fullPrompt,
    ];

    const proc = Bun.spawn(args, {
      cwd: req.cwd,
      env: {
        ...process.env,
        OPENCODE_CONFIG_CONTENT: JSON.stringify(openCodeConfig),
      },
      stdout: 'pipe',
      stderr: 'pipe',
    });

    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);

    if (exitCode !== 0) {
      throw new Error(
        `opencode CLI exited with ${exitCode}: ${(stderr || stdout).slice(0, 1000)}`,
      );
    }

    const candidate = extractJsonFromCliText(stdout);
    const output = req.schema.parse(candidate);

    return {
      output,
      model: parsed.raw,
      provider: parsed.provider,
      durationMs: Date.now() - start,
      rawText: stdout,
    };
  }
}
