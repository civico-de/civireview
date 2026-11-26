import { mkdirSync } from 'node:fs';
import { basename, extname, join } from 'node:path';
import type { BrowserConfig } from '../../config/schema.ts';
import { cmsLabel, cmsScope, type RunnableCms } from '../cms-scope.ts';
import type { CmsDemoResult, DiffFile } from '../types.ts';
import { parseDemoErrors, stripAnsi, type ExecFn, type RunCommandResult } from './parsers.ts';

/** CMS stacks booted per review; each one pulls an image of several GB. */
export const MAX_CMS_DEMOS = 2;

/** Every CiviCRM page on a CMS runs its bootstrap, URL, permission and hook integration. */
export const CMS_SMOKE_ROUTES = ['civicrm/dashboard?reset=1', 'civicrm/contact/search?reset=1'];

// `ck demo` waits up to 900 s for a stack to boot, then records twice.
const DEMO_TIMEOUT_MS = 1_500_000;

/** A CMS site `ck demo --keep` left running, with the change applied. */
export interface KeptCmsSite {
  cms: RunnableCms;
  url: string;
  project: string;
}

/** The compose project `ck demo` boots for a patch file on one CMS. */
export function cmsDemoProject(patchFile: string, cms: string): string {
  const label = basename(patchFile, extname(patchFile))
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return `ck-demo-${label || 'diff'}-${cms}`;
}

function lastLine(text: string): string {
  return (
    stripAnsi(text)
      .split(/\r?\n/)
      .map((l) => l.trim())
      .findLast((l) => l !== '') ?? ''
  ).slice(0, 300);
}

/**
 * Reads one `ck demo --cms <cms>` run. A page that loads on the base and shows no CiviCRM
 * with the change applied is a failure of the change; any other broken run proves nothing.
 */
export function parseCmsDemoOutcome(
  cms: RunnableCms,
  routes: string[],
  res: Pick<RunCommandResult, 'exitCode' | 'stdout' | 'stderr'>,
): CmsDemoResult {
  const label = cmsLabel(cms);
  const stdout = stripAnsi(res.stdout);
  const base = { cms, routes };
  if (res.exitCode === 0) {
    const newScriptErrors = parseDemoErrors(res.stdout);
    return newScriptErrors.length > 0
      ? {
          ...base,
          status: 'FAIL',
          newScriptErrors,
          detail: `${label}: ${newScriptErrors.length} script error(s) with the change that the base does not log on ${routes.length} route(s): ${newScriptErrors.slice(0, 3).join('; ').slice(0, 400)}`,
        }
      : {
          ...base,
          status: 'PASS',
          newScriptErrors,
          detail: `${label}: logged in and loaded ${routes.length} route(s) without and with the change; no new script errors.`,
        };
  }
  // The image carries master as of its daily build; a PR on a newer or older base may not apply.
  const unapplied = /the change does not apply to [^(\n]+/.exec(stripAnsi(res.stderr))?.[0].trim();
  const reason =
    unapplied ?? (lastLine(res.stderr) || lastLine(res.stdout) || `exit ${res.exitCode}`);
  // The recorder's own assertion; any other failure of the second recording may be the runner's.
  const brokenPage = /\S+ shows no CiviCRM page on [^\n]+/.exec(stripAnsi(res.stderr))?.[0];
  if (brokenPage && /^ck demo: recording .+ after$/m.test(stdout)) {
    return {
      ...base,
      status: 'FAIL',
      newScriptErrors: [],
      detail: `${label}: the pages loaded on the base and not with the change applied: ${brokenPage.slice(0, 300)}`,
    };
  }
  return {
    ...base,
    status: 'NOT_VERIFIED',
    newScriptErrors: [],
    detail: `${label}: ck demo gave no result (exit ${res.exitCode}): ${reason}`,
  };
}

/** Removes a `ck demo` stack and its volumes; returns the exit code of the removal. */
export async function removeCmsStack(execFn: ExecFn, project: string): Promise<number> {
  const down = await execFn(
    ['docker', 'compose', '-p', project, 'down', '--remove-orphans', '-v'],
    { timeoutMs: 120_000 },
  );
  return down.exitCode;
}

/** Records the PR without and with its change on each CMS, one `ck demo` run per CMS. */
export async function runCmsDemos(params: {
  execFn: ExecFn;
  ckCommand: string[];
  patchFile: string;
  outRoot: string;
  cms: RunnableCms[];
  routes: string[];
  /** Filled with the sites left running, for stages that drive a browser on them. */
  kept?: KeptCmsSite[];
}): Promise<CmsDemoResult[]> {
  const results: CmsDemoResult[] = [];
  for (const cms of params.cms) {
    const out = join(params.outRoot, `cms-demo-${cms}`);
    mkdirSync(out, { recursive: true });
    const res = await params.execFn(
      [
        ...params.ckCommand,
        'demo',
        params.patchFile,
        '--cms',
        cms,
        ...params.routes.flatMap((r) => ['--page', r]),
        '--out',
        out,
        ...(params.kept ? ['--keep'] : []),
      ],
      { timeoutMs: DEMO_TIMEOUT_MS },
    );
    const outcome = parseCmsDemoOutcome(cms, params.routes, res);
    const project = cmsDemoProject(params.patchFile, cms);
    const keptUrl = /^ck demo: kept .+ at (http:\/\/localhost:\d+) /m.exec(
      stripAnsi(res.stdout),
    )?.[1];
    if (res.exitCode === 0 && keptUrl) params.kept?.push({ cms, url: keptUrl, project });
    if (res.exitCode !== 0) {
      // A run killed by the timeout never reached its own teardown. Compose 5.8 removes the
      // containers and volumes of a project by name, without its compose file.
      const down = await removeCmsStack(params.execFn, project);
      if (down !== 0) {
        outcome.detail += ` Its stack ${project} could not be removed (exit ${down}).`;
      }
    }
    results.push(outcome);
  }
  return results;
}

/**
 * Code of a CMS integration never runs on the Standalone stacks: records the PR on each
 * CMS its changed files belong to, and on those the configuration names.
 */
export async function runCmsDemosForDiff(params: {
  execFn: ExecFn;
  ckCommand: string[];
  repoRoot: string;
  baseSha: string;
  headSha: string;
  workDir: string;
  outRoot: string;
  diffFiles: DiffFile[];
  browserConfig: BrowserConfig;
  notVerified: string[];
  kept?: KeptCmsSite[];
}): Promise<CmsDemoResult[]> {
  const { diffFiles, browserConfig } = params;
  const wanted = Array.from(new Set([...cmsScope(diffFiles).runnable, ...browserConfig.cms]));
  if (wanted.length === 0) return [];
  const diffRes = await params.execFn(
    // From the merge base: a base branch that moved on must not show up as reverted changes.
    ['git', '-C', params.repoRoot, 'diff', `${params.baseSha}...${params.headSha}`],
    { timeoutMs: 30_000 },
  );
  // The file name becomes the compose project: unique per run, so parallel reviews do not share stacks.
  const patchFile = join(params.workDir, `cr-${basename(params.workDir)}.patch`);
  await Bun.write(patchFile, diffRes.stdout);
  for (const skipped of wanted.slice(MAX_CMS_DEMOS)) {
    params.notVerified.push(
      `${cmsLabel(skipped)} not run: a review boots at most ${MAX_CMS_DEMOS} CMS stacks.`,
    );
  }
  return runCmsDemos({
    execFn: params.execFn,
    ckCommand: params.ckCommand,
    patchFile,
    outRoot: params.outRoot,
    cms: wanted.slice(0, MAX_CMS_DEMOS),
    ...(params.kept ? { kept: params.kept } : {}),
    // `ck demo` loads every route on the base too: only routes every release has.
    routes: [...CMS_SMOKE_ROUTES],
  });
}
