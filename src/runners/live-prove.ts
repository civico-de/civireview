import { existsSync } from 'node:fs';
import { tool, type ToolSet } from 'ai';
import { z } from 'zod';
import { validateLocalhostUrl, type ExecFn } from '../evidence/civikitchen-ab.ts';

export interface CreateLiveProbeToolOptions {
  urlA?: string;
  urlB?: string;
  composeFileA?: string;
  composeFileB?: string;
  serviceName?: string;
  execFn?: ExecFn;
  fetchFn?: typeof fetch;
}

const ENTITY_RE = /^[A-Za-z0-9_]+$/;
const ALLOWED_API4_ACTIONS = ['get', 'getActions', 'getFields'] as const;

async function defaultComposeExec(
  args: string[],
  opts: { timeoutMs?: number } = {},
) {
  const [cmd, ...rest] = args;
  if (!cmd) return { exitCode: 2, stdout: '', stderr: 'empty command' };
  const proc = Bun.spawn([cmd, ...rest], {
    stdout: 'pipe',
    stderr: 'pipe',
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  if (opts.timeoutMs && opts.timeoutMs > 0) {
    timer = setTimeout(() => {
      try {
        proc.kill();
      } catch {
        // ignore
      }
    }, opts.timeoutMs);
  }
  try {
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { exitCode, stdout, stderr };
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

function truncateText(text: string, limit = 2000): string {
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}\n... [truncated]`;
}

/**
 * Creates the bounded, read-only `live_probe_ab` tool for Stage 2 Verifier when
 * `--live-prove` is enabled. Strictly locked to the kept A/B localhost URLs
 * and read-only `cv api4 <Entity>.get|getActions|getFields` checks.
 */
export function createLiveProbeTool(
  options: CreateLiveProbeToolOptions,
): ToolSet {
  const urlA = validateLocalhostUrl(options.urlA);
  const urlB = validateLocalhostUrl(options.urlB);
  const composeFileA =
    options.composeFileA && existsSync(options.composeFileA)
      ? options.composeFileA
      : undefined;
  const composeFileB =
    options.composeFileB && existsSync(options.composeFileB)
      ? options.composeFileB
      : undefined;
  const serviceName = options.serviceName ?? 'app';
  const execFn = options.execFn ?? defaultComposeExec;
  const fetchFn = options.fetchFn ?? fetch;

  return {
    live_probe_ab: tool({
      description:
        'Execute a read-only A-vs-B live verification probe against the running base (A) and head (B) CiviCRM Standalone stacks. Supports safe localhost HTTP GET checks and read-only `cv api4` queries (get, getActions, getFields).',
      inputSchema: z.object({
        mode: z.enum(['http-get', 'api4-read']),
        route: z
          .string()
          .optional()
          .describe('Relative CiviCRM route for http-get (e.g. civicrm/dashboard?reset=1)'),
        entity: z
          .string()
          .optional()
          .describe('APIv4 entity name for api4-read (e.g. Contact)'),
        action: z.enum(ALLOWED_API4_ACTIONS).default('get'),
        paramsJson: z
          .string()
          .optional()
          .describe('Optional JSON object string for cv api4 params, e.g. {"limit":5}'),
      }),
      execute: async ({ mode, route, entity, action, paramsJson }) => {
        if (mode === 'http-get') {
          if (!urlA || !urlB) {
            return {
              error:
                'Live A/B HTTP URLs are unavailable (ensure stacks were exposed with --expose --keep).',
              differs: false,
            };
          }
          const targetRoute = route ?? 'civicrm/dashboard?reset=1';
          const targetA = buildSafeLocalRouteUrl(urlA, targetRoute);
          const targetB = buildSafeLocalRouteUrl(urlB, targetRoute);

          const probeHttp = async (target: URL) => {
            const resp = await fetchFn(target.toString(), {
              method: 'GET',
              redirect: 'manual',
              signal: AbortSignal.timeout(10_000),
            });
            const body = await resp.text();
            return {
              url: target.toString(),
              status: resp.status,
              contentType: resp.headers.get('content-type') ?? '',
              location: resp.headers.get('location') ?? undefined,
              bodySnippet: truncateText(body, 1500),
            };
          };

          const [a, b] = await Promise.all([probeHttp(targetA), probeHttp(targetB)]);
          const differs =
            a.status !== b.status ||
            a.location !== b.location ||
            a.bodySnippet !== b.bodySnippet;
          return {
            mode,
            route: targetRoute,
            a,
            b,
            differs,
            command: `GET ${targetRoute} on A (${urlA}) vs B (${urlB})`,
          };
        }

        // api4-read
        if (!entity || !ENTITY_RE.test(entity)) {
          throw new Error(
            `Invalid APIv4 entity "${entity ?? ''}": must match ${ENTITY_RE.source}`,
          );
        }
        let safeParamsArg: string | undefined;
        if (paramsJson && paramsJson.trim()) {
          const parsed = JSON.parse(paramsJson);
          if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
            throw new Error('paramsJson must be a JSON object.');
          }
          if ('chain' in parsed) {
            throw new Error('APIv4 "chain" parameter is forbidden in read-only live probes.');
          }
          safeParamsArg = JSON.stringify(parsed);
        }

        if (!composeFileA || !composeFileB) {
          return {
            error:
              'Docker Compose files for kept A/B stacks are unavailable for cv api4 probes.',
            differs: false,
          };
        }

        const api4Args = [
          'cv',
          'api4',
          `${entity}.${action}`,
          ...(safeParamsArg ? [safeParamsArg] : []),
        ];

        const [resA, resB] = await Promise.all([
          execFn(
            ['docker', 'compose', '-f', composeFileA, 'exec', '-T', '-u', 'www-data', '-w', '/var/www/html', serviceName, ...api4Args],
            { timeoutMs: 20_000 },
          ),
          execFn(
            ['docker', 'compose', '-f', composeFileB, 'exec', '-T', '-u', 'www-data', '-w', '/var/www/html', serviceName, ...api4Args],
            { timeoutMs: 20_000 },
          ),
        ]);

        const aOut = truncateText(resA.stdout || resA.stderr, 1500);
        const bOut = truncateText(resB.stdout || resB.stderr, 1500);
        return {
          mode,
          command: api4Args.join(' '),
          a: { exitCode: resA.exitCode, output: aOut },
          b: { exitCode: resB.exitCode, output: bOut },
          differs: resA.exitCode !== resB.exitCode || aOut !== bOut,
        };
      },
    }),
  };
}
