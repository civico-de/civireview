import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { tool, type ToolSet } from 'ai';
import { z } from 'zod';
import { validateLocalhostUrl, type ExecFn } from '../evidence/civikitchen-ab.ts';
import { LIVE_BROWSER_NOTE, LIVE_INSTANCE_NOTE, liveCmsNote } from '../prompts/shared.ts';
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
  /** The `ck` launcher; without it the tool has no browser mode. */
  ck?: string[];
  /** Where steps modules are written; Docker must share it. */
  stepsDir?: string;
  /** CMS sites with the change applied, offered to the browser mode by name. */
  cmsSites?: Array<{ cms: string; url: string }>;
}

const DEFAULT_EXEC_TIMEOUT_S = 60;
const MAX_OUTPUT_CHARS = 6000;
const MAX_STEPS_CHARS = 20_000;
// Around the steps' own time limit: `ck steps` ends its browser 30 s after it and may take
// 5 s to stop it, so the report of a run out of time still arrives.
const BROWSER_OVERHEAD_S = 45;
// Below this the steps have no time to do anything worth a browser start.
const MIN_BROWSER_STEPS_S = 30;
// Docker shares the home directory with its VM on macOS; the temp directory it does not.
const DEFAULT_STEPS_DIR = join(homedir(), '.cache', 'civireview', 'steps');
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

/** What `ck steps` reports about one run of a steps module. */
interface BrowserReport {
  ok: boolean;
  error?: string;
  value?: unknown;
  url?: string;
  title?: string;
  text?: string;
  errors: string[];
}

function parseBrowserReport(stdout: string): BrowserReport | undefined {
  const last = stdout.trim().split('\n').at(-1) ?? '';
  try {
    const report: unknown = JSON.parse(last);
    if (
      report !== null &&
      typeof report === 'object' &&
      typeof (report as BrowserReport).ok === 'boolean' &&
      Array.isArray((report as BrowserReport).errors)
    ) {
      return report as BrowserReport;
    }
  } catch {
    // no report; the caller reports the run as failed
  }
  return undefined;
}

/**
 * Creates the `live_probe_ab` tool on the kept, disposable A (base) and B (head) stacks:
 * localhost HTTP GET, any command run inside the app container as www-data, and a steps
 * module run in a logged-in browser. Commands never reach a host shell; they run via
 * `docker compose exec` with an argv, the browser in a container of its own.
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
  // A browser call stays within the limit of one exec, its overhead included.
  const maxStepsSeconds = maxExecSeconds - BROWSER_OVERHEAD_S;
  const ck = maxStepsSeconds >= MIN_BROWSER_STEPS_S ? options.ck : undefined;
  const stepsDir = options.stepsDir ?? DEFAULT_STEPS_DIR;

  const cmsSites = new Map(
    (ck ? (options.cmsSites ?? []) : []).flatMap((site) => {
      const url = validateLocalhostUrl(site.url);
      return url ? [[site.cms, url] as const] : [];
    }),
  );

  const browse = async (
    site: string | undefined,
    cms: string,
    phase: 'before' | 'after',
    module: string,
    requestedSeconds: number,
  ) => {
    if (!ck || !site) return { ran: false, error: 'This site has no browser access.' };
    const timeoutSeconds = Math.min(requestedSeconds, maxStepsSeconds);
    const res = await execFn(
      [
        ...ck,
        'steps',
        site,
        module,
        '--cms',
        cms,
        '--phase',
        phase,
        '--timeout',
        String(timeoutSeconds),
      ],
      { timeoutMs: (timeoutSeconds + BROWSER_OVERHEAD_S) * 1000 },
    );
    const report = parseBrowserReport(res.stdout);
    if (!report) {
      // The steps never ran: no login, no browser, a launcher without the command.
      return {
        ran: false,
        error: truncateText(res.stderr.trim() || `ck steps gave no report (exit ${res.exitCode})`),
      };
    }
    return { ran: true, ...report };
  };

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
        (ck
          ? '`browser` runs a Playwright steps module in a browser logged in as admin: pass `steps`, ' +
            'the source of an ES module such as ' +
            '`export default async ({ page, url }) => { await page.goto(url("civicrm/contact/add?reset=1&ct=Individual")); ' +
            'await page.locator("#first_name").fill("Ada"); await page.locator("#_qf_Contact_upload_view-bottom").click(); ' +
            'await page.waitForLoadState("networkidle"); return { heading: await page.locator("h1").first().innerText() }; }`. ' +
            '`url(route)` builds the address of a CiviCRM route, `page` is a Playwright Page. Per stack the result holds ' +
            '`ok`, the `error` the steps threw, the JSON `value` they returned, and where they ended: `url`, `title`, ' +
            'the page as an accessibility tree in `text`, and the script `errors` the pages logged. ' +
            'To find selectors, first run steps that only open the page and read `text`. ' +
            '`differs` compares ok, error, value and script errors; compare the page text yourself. ' +
            `The steps get at most ${maxStepsSeconds} s. ` +
            (cmsSites.size > 0
              ? `With \`cms\` (${[...cmsSites.keys()].join(', ')}) the steps run on that CMS site instead, which has the PR applied and no base beside it; \`url(route)\` builds that CMS's addresses. `
              : '')
          : '') +
        'Other review stages share these stacks and may have left data behind.',
      inputSchema: z.object({
        mode: z.enum(ck ? ['exec', 'http-get', 'browser'] : ['exec', 'http-get']),
        argv: z
          .array(z.string())
          .optional()
          .describe(
            'Command and arguments for exec, no shell (e.g. ["cv","api4","Membership.get"])',
          ),
        target: z
          .enum(['both', 'A', 'B'])
          .default('both')
          .describe('Stack to run exec or browser on; set up a scenario on both before comparing'),
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
        steps: z
          .string()
          .max(MAX_STEPS_CHARS)
          .optional()
          .describe('Source of the steps module for browser; its default export is the function'),
        cms: z
          .string()
          .optional()
          .describe('For browser: run the steps on this kept CMS site instead of A and B'),
      }),
      execute: async ({ mode, argv, target, timeoutSeconds, route, steps, cms }) => {
        if (mode === 'browser') {
          if (!steps?.trim()) {
            throw new Error('browser needs the source of a steps module in `steps`.');
          }
          mkdirSync(stepsDir, { recursive: true });
          const dir = mkdtempSync(join(stepsDir, 'run-'));
          try {
            const module = join(dir, 'steps.mts');
            writeFileSync(module, steps);
            if (cms) {
              const siteUrl = cmsSites.get(cms);
              if (!siteUrl) {
                throw new Error(
                  `No ${cms} site is running (available: ${[...cmsSites.keys()].join(', ') || 'none'}).`,
                );
              }
              const site = await browse(siteUrl, cms, 'after', module, timeoutSeconds);
              return { mode, cms, site };
            }
            const [a, b] = await Promise.all([
              target === 'B'
                ? undefined
                : browse(urlA, 'standalone', 'before', module, timeoutSeconds),
              target === 'A'
                ? undefined
                : browse(urlB, 'standalone', 'after', module, timeoutSeconds),
            ]);
            const compared = (r: NonNullable<typeof a>) =>
              JSON.stringify(
                'ok' in r ? [r.ok, r.error ?? null, r.value ?? null, r.errors] : [r.error],
              );
            return {
              mode,
              target,
              ...(a ? { a } : {}),
              ...(b ? { b } : {}),
              ...(a && b ? { differs: compared(a) !== compared(b) } : {}),
            };
          } finally {
            rmSync(dir, { recursive: true, force: true });
          }
        }
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
    ...(stacks.ck ? { ck: stacks.ck } : {}),
    ...(stacks.cmsSites ? { cmsSites: stacks.cmsSites } : {}),
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
  /** The `ck` launcher, for the browser mode. */
  ck?: string[];
  cmsSites?: Array<{ cms: string; url: string }>;
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
          ...(options.ck ? { ck: options.ck } : {}),
          ...(options.ck && options.cmsSites?.length
            ? { cmsSites: options.cmsSites.map(({ cms, url }) => ({ cms, url })) }
            : {}),
        }
      : undefined;
  const canBrowse =
    Boolean(stacks?.ck) &&
    (stacks?.maxExecSeconds ?? 0) - BROWSER_OVERHEAD_S >= MIN_BROWSER_STEPS_S;
  const browser = canBrowse && Boolean(stacks?.urls.A && stacks.urls.B);
  const cmsNote =
    canBrowse && stacks?.cmsSites?.length
      ? liveCmsNote(stacks.cmsSites.map((site) => site.cms))
      : '';
  return (model) =>
    stacks && options.registry.get(parseModelSpec(model).provider)?.supportsLiveStacks
      ? { stacks, note: LIVE_INSTANCE_NOTE + (browser ? LIVE_BROWSER_NOTE : '') + cmsNote }
      : { note: '' };
}
