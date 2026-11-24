import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { tool, type ToolSet } from 'ai';
import { z } from 'zod';
import { validateLocalhostUrl, type ExecFn } from '../evidence/civikitchen-ab.ts';
import { LIVE_INSTANCE_NOTE } from '../prompts/shared.ts';
import type { RunnerRegistry } from './registry.ts';
import { parseModelSpec, type ExtraMcpServerConfig, type LiveStacks } from './types.ts';

export interface CreateLiveProbeToolOptions {
  urlA?: string;
  urlB?: string;
  composeFileA?: string;
  composeFileB?: string;
  serviceName?: string;
  execFn?: ExecFn;
  fetchFn?: typeof fetch;
  /** Longest timeout a single exec may ask for. */
  maxExecSeconds?: number;
}

const DEFAULT_EXEC_TIMEOUT_S = 60;
const MAX_OUTPUT_CHARS = 6000;
// Output beyond this per stream kills the local exec; the in-container timeout still bounds
// the command itself. The A/B comparison covers what was read.
const MAX_CAPTURE_BYTES = 1_000_000;
// $1 is the limit, the rest the argv; arguments stay positional and are never parsed by sh.
const IN_CONTAINER_TIMEOUT =
  't=$1; shift; if command -v timeout >/dev/null 2>&1; then exec timeout -k 5 "$t" "$@"; fi; exec "$@"';

/** Reads at most `limit` bytes and reports whether the stream had more. */
async function readCapped(
  stream: ReadableStream<Uint8Array>,
  limit: number,
  onOverflow: () => void,
) {
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of stream) {
    if (size > limit) continue;
    chunks.push(chunk.subarray(0, Math.max(0, limit - size)));
    size += chunk.length;
    if (size > limit) onOverflow();
  }
  const text = new TextDecoder().decode(Buffer.concat(chunks));
  return size > limit ? `${text}\n... [output stopped at ${limit} bytes; command killed]` : text;
}

export async function execWithCappedOutput(args: string[], opts: { timeoutMs?: number } = {}) {
  const [cmd, ...rest] = args;
  if (!cmd) return { exitCode: 2, stdout: '', stderr: 'empty command' };
  const proc = Bun.spawn([cmd, ...rest], {
    stdout: 'pipe',
    stderr: 'pipe',
  });
  let timedOut = false;
  const kill = () => {
    try {
      proc.kill();
    } catch {
      // already exited
    }
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  if (opts.timeoutMs && opts.timeoutMs > 0) {
    timer = setTimeout(() => {
      timedOut = true;
      kill();
    }, opts.timeoutMs);
  }
  try {
    const [stdout, stderr, exitCode] = await Promise.all([
      readCapped(proc.stdout, MAX_CAPTURE_BYTES, kill),
      readCapped(proc.stderr, MAX_CAPTURE_BYTES, kill),
      proc.exited,
    ]);
    return { exitCode, stdout, stderr, timedOut };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function buildSafeLocalRouteUrl(baseUrl: string, route: string): URL {
  const trimmed = route.trim();
  if (!trimmed || /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(trimmed) || trimmed.startsWith('//')) {
    throw new Error(
      `Invalid route "${route}": must be a relative CiviCRM path (e.g. civicrm/dashboard).`,
    );
  }
  const normalized = trimmed.replace(/^\/+/, '');
  const base = new URL(baseUrl);
  const resolved = new URL(`/${normalized}`, base);
  if (resolved.origin !== base.origin) {
    throw new Error(`Route "${route}" escaped localhost stack origin.`);
  }
  return resolved;
}

/** Keeps head and tail, where PHPUnit and cv put their summary and error. */
function truncateText(text: string, limit = MAX_OUTPUT_CHARS): string {
  if (text.length <= limit) return text;
  const half = Math.floor(limit / 2);
  return `${text.slice(0, half)}\n... [${text.length - limit} chars truncated] ...\n${text.slice(-half)}`;
}

/**
 * Creates the `live_probe_ab` tool on the kept, disposable A (base) and B (head) stacks:
 * localhost HTTP GET, and any command run inside the app container as www-data.
 * Commands never reach a host shell; they run via `docker compose exec` with an argv.
 */
export function createLiveProbeTool(options: CreateLiveProbeToolOptions): ToolSet {
  const urlA = validateLocalhostUrl(options.urlA);
  const urlB = validateLocalhostUrl(options.urlB);
  const composeFiles = {
    A: options.composeFileA && existsSync(options.composeFileA) ? options.composeFileA : undefined,
    B: options.composeFileB && existsSync(options.composeFileB) ? options.composeFileB : undefined,
  };
  const serviceName = options.serviceName ?? 'app';
  const execFn = options.execFn ?? execWithCappedOutput;
  const fetchFn = options.fetchFn ?? fetch;
  const maxExecSeconds = Math.max(1, Math.floor(options.maxExecSeconds ?? 600));

  const execIn = async (side: 'A' | 'B', argv: string[], timeoutSeconds: number) => {
    const composeFile = composeFiles[side];
    if (!composeFile) {
      return { exitCode: -1, raw: '', output: `Stack ${side} is not running.` };
    }
    const res = await execFn(
      [
        'docker',
        'compose',
        '-f',
        composeFile,
        'exec',
        '-T',
        '-u',
        'www-data',
        '-w',
        '/var/www/html',
        serviceName,
        // Killing `docker compose exec` leaves the container process running; bound it inside.
        'sh',
        '-c',
        IN_CONTAINER_TIMEOUT,
        'live-probe',
        String(timeoutSeconds),
        ...argv,
      ],
      { timeoutMs: (timeoutSeconds + 15) * 1000 },
    );
    const raw = [res.stdout, res.stderr].filter((s) => s.trim()).join('\n--- stderr ---\n');
    return {
      exitCode: res.exitCode,
      ...(res.timedOut || res.exitCode === 124 ? { timedOut: true } : {}),
      raw,
      output: truncateText(raw),
    };
  };

  return {
    live_probe_ab: tool({
      description:
        'Run checks on the running, disposable CiviCRM Standalone stacks A (base) and B (PR head). ' +
        '`exec` runs an argv inside the app container as www-data in /var/www/html, e.g. ' +
        '["cv","api4","Contact.create","{\\"values\\":{\\"contact_type\\":\\"Individual\\"}}"], ' +
        '["cv","api3","Job.send_reminder"], ["cv","ev","return CRM_Core_DAO::singleValueQuery(\'SELECT 1\');"]. ' +
        'Writes are allowed: create records and run jobs to reproduce a scenario. ' +
        '`http-get` fetches a relative route anonymously from both stacks. ' +
        'Other review stages share these stacks and may have left data behind.',
      inputSchema: z.object({
        mode: z.enum(['exec', 'http-get']),
        argv: z
          .array(z.string())
          .optional()
          .describe(
            'Command and arguments for exec, no shell (e.g. ["cv","api4","Membership.get"])',
          ),
        target: z
          .enum(['both', 'A', 'B'])
          .default('both')
          .describe('Stack to run exec on; set up a scenario on both before comparing'),
        timeoutSeconds: z
          .number()
          .int()
          .min(1)
          .max(maxExecSeconds)
          .default(Math.min(DEFAULT_EXEC_TIMEOUT_S, maxExecSeconds))
          .describe(`Per stack; at most ${maxExecSeconds} s so the stage keeps time to evaluate`),
        route: z
          .string()
          .optional()
          .describe('Relative CiviCRM route for http-get (e.g. civicrm/dashboard?reset=1)'),
      }),
      execute: async ({ mode, argv, target, timeoutSeconds, route }) => {
        if (mode === 'http-get') {
          if (!urlA || !urlB) {
            return { error: 'Live A/B HTTP URLs are unavailable.', differs: false };
          }
          const targetRoute = route ?? 'civicrm/dashboard?reset=1';
          const targetA = buildSafeLocalRouteUrl(urlA, targetRoute);
          const targetB = buildSafeLocalRouteUrl(urlB, targetRoute);

          const probeHttp = async (url: URL) => {
            const resp = await fetchFn(url.toString(), {
              method: 'GET',
              redirect: 'manual',
              signal: AbortSignal.timeout(10_000),
            });
            const body = await resp.text();
            return {
              body,
              url: url.toString(),
              status: resp.status,
              contentType: resp.headers.get('content-type') ?? '',
              location: resp.headers.get('location') ?? undefined,
              bodySnippet: truncateText(body, 1500),
            };
          };

          const [{ body: bodyA, ...a }, { body: bodyB, ...b }] = await Promise.all([
            probeHttp(targetA),
            probeHttp(targetB),
          ]);
          // The snippets are for display; a difference further down still counts.
          const differs = a.status !== b.status || a.location !== b.location || bodyA !== bodyB;
          return {
            mode,
            route: targetRoute,
            a,
            b,
            differs,
            command: `GET ${targetRoute} on A (${urlA}) vs B (${urlB})`,
          };
        }

        if (!argv || argv.length === 0 || !argv[0]?.trim()) {
          throw new Error('exec needs a non-empty argv.');
        }
        if (argv.some((arg) => arg.includes('\0'))) {
          throw new Error('argv must not contain null bytes.');
        }
        const [a, b] = await Promise.all([
          target === 'B' ? undefined : execIn('A', argv, timeoutSeconds),
          target === 'A' ? undefined : execIn('B', argv, timeoutSeconds),
        ]);
        const shown = (r: typeof a) => {
          if (!r) return undefined;
          const { raw: _raw, ...rest } = r;
          return rest;
        };
        return {
          mode,
          // First after the mode, so a shortened copy of the result still carries them.
          exitCodes: { ...(a ? { A: a.exitCode } : {}), ...(b ? { B: b.exitCode } : {}) },
          command: argv.join(' '),
          target,
          ...(a ? { a: shown(a) } : {}),
          ...(b ? { b: shown(b) } : {}),
          // Compares the full output; a difference in the truncated middle still counts.
          ...(a && b ? { differs: a.exitCode !== b.exitCode || a.raw !== b.raw } : {}),
        };
      },
    }),
  };
}

/** The live tool on the given stacks, for runners that run the tool loop themselves. */
export function liveProbeTool(stacks: LiveStacks): ToolSet {
  return createLiveProbeTool({
    urlA: stacks.urls.A,
    urlB: stacks.urls.B,
    composeFileA: stacks.composeFiles.A,
    composeFileB: stacks.composeFiles.B,
    maxExecSeconds: stacks.maxExecSeconds,
  });
}

/** The same tool as a stdio MCP server, for runners whose CLI runs the tool loop. */
export function liveProbeMcpServer(stacks: LiveStacks): ExtraMcpServerConfig {
  return {
    name: 'live-probe',
    command: process.execPath,
    args: [join(import.meta.dir, '..', 'mcp', 'live-probe-server.ts'), JSON.stringify(stacks)],
    // Above the exec's own host timeout, so the exec reports its timeout first.
    timeoutMs: (stacks.maxExecSeconds + 30) * 1000,
  };
}

/**
 * Returns, per stage model, the kept stacks and the prompt note. A stage gets neither when
 * one of the stacks is gone (a split evidence/review run) or its runner cannot offer the tool.
 * One exec may take at most half the stage timeout, so a slow command cannot end the stage.
 */
export function createStageLiveTools(options: {
  enabled: boolean;
  stageTimeoutMs: number;
  registry: RunnerRegistry;
  urls: { A?: string; B?: string };
  composeFiles?: { A?: string; B?: string };
}): (model: string) => { stacks?: LiveStacks; note: string } {
  const { A, B } = options.composeFiles ?? {};
  const stacks: LiveStacks | undefined =
    options.enabled && A && B && existsSync(A) && existsSync(B)
      ? {
          composeFiles: { A, B },
          urls: {
            A: validateLocalhostUrl(options.urls.A),
            B: validateLocalhostUrl(options.urls.B),
          },
          maxExecSeconds: Math.max(1, Math.floor(options.stageTimeoutMs / 2000)),
        }
      : undefined;
  return (model) =>
    stacks && options.registry.get(parseModelSpec(model).provider)?.supportsLiveStacks
      ? { stacks, note: LIVE_INSTANCE_NOTE }
      : { note: '' };
}
