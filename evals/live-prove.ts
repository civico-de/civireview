#!/usr/bin/env bun
/**
 * Eval for the live instances (`live-prove`).
 *
 *   bun run eval                 plumbing only: real kept stacks, no model
 *   bun run eval --with-model    also replays civicrm/civicrm-core#38258 as a dry run (~$1)
 *   bun run eval --with-model --preset subscription    the same on a logged-in claude CLI
 *
 * Plumbing proves that the tool reaches both kept stacks. The model case proves that the
 * review stages use it: the PR's "NOT VERIFIED" points needed the scheduled reminder job (Job.send_reminder),
 * so a passing run calls `live_probe_ab` with that job.
 */
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import type { ToolSet } from 'ai';
import { FinalReviewSchema } from '../src/engine/schemas.ts';
import { parseCkAbJsonReport } from '../src/evidence/ab/parsers.ts';
import { connectStdioMcpClient, outsideWorktree } from '../src/mcp/client.ts';
import { runCliProcess } from '../src/runners/cli-process.ts';
import {
  createLiveProbeTool,
  execWithCappedOutput,
  liveProbeMcpServer,
} from '../src/runners/live-prove.ts';

const MODEL_CASE = {
  repo: 'civicrm/civicrm-core',
  pr: '38258',
  // APIv4 or APIv3 from cv, or via `cv ev`
  expectedSetup: /ActionSchedule\W{1,6}(create|save)/i,
  // Reported, not required: calling the changed code directly proves as much.
  reminderJob: /send_reminder/i,
};

const SUCCESS_ON_BOTH = '"mode":"exec","exitCodes":{"A":0,"B":0}';

const { values } = parseArgs({
  options: {
    'with-model': { type: 'boolean', default: false },
    work: { type: 'string', default: join(homedir(), '.cache', 'civireview-eval') },
    // Plumbing needs two different Standalone images; `ck ab` refuses identical sides.
    'image-a': { type: 'string', default: 'standalone' },
    'image-b': { type: 'string', default: 'standalone-master' },
    preset: { type: 'string', default: 'sonnet-opus' },
  },
});

const results: Array<{ check: string; pass: boolean; detail: string }> = [];
const record = (check: string, pass: boolean, detail: string) => {
  results.push({ check, pass, detail });
  console.error(`${pass ? 'PASS' : 'FAIL'}  ${check}: ${detail}`);
};

const missing: string[] = [];
const civikitchen = process.env.CIVIKITCHEN_PATH;
const ck = civikitchen ? join(resolve(civikitchen), 'scaffold', 'ck') : '';
if (!civikitchen || !existsSync(ck)) missing.push('CIVIKITCHEN_PATH (a civikitchen checkout)');
if (values['with-model'] && values.preset !== 'subscription' && !process.env.ANTHROPIC_API_KEY) {
  missing.push('ANTHROPIC_API_KEY');
}
if (missing.length > 0) {
  console.error(`Missing: ${missing.join(', ')}`);
  process.exit(2);
}

// Container mounts only reach directories colima shares, so the work dir sits under $HOME.
const work = resolve(values.work);
mkdirSync(work, { recursive: true });

/** Never hangs: on timeout the process is killed and the call settles, even with open pipes. */
async function run(
  args: string[],
  cwd?: string,
  timeoutMs = 900_000,
  env: Record<string, string> = {},
) {
  try {
    return await runCliProcess(args, {
      cwd,
      timeoutMs,
      env: { ...process.env, ...env },
      label: args[0] ?? 'command',
    });
  } catch (err) {
    return { stdout: '', stderr: err instanceof Error ? err.message : String(err), exitCode: -1 };
  }
}

type ExecResult = {
  a?: { exitCode: number; output: string; timedOut?: boolean };
  b?: { exitCode: number; output: string; timedOut?: boolean };
};

const bothOk = (r: ExecResult) => r.a?.exitCode === 0 && r.b?.exitCode === 0;
const brief = (r: ExecResult) =>
  `A exit ${r.a?.exitCode} / B exit ${r.b?.exitCode}: ${(r.b?.output ?? '').slice(0, 160)}`;

async function plumbing() {
  const out = join(work, 'plumbing');
  mkdirSync(out, { recursive: true });
  const reportPath = join(out, 'ab.json');
  // Stop an interrupted run's stacks, then drop its files so they cannot pass for this run's.
  await stopStacksUnder(out);
  for (const file of ['ab.json', 'A.compose.json', 'B.compose.json']) {
    rmSync(join(out, file), { force: true });
  }
  try {
    await plumbingChecks(out, reportPath);
  } finally {
    // ck ab writes the compose files before it starts a stack, so this also covers a failed start.
    await stopStacksUnder(out);
  }
}

async function plumbingChecks(out: string, reportPath: string) {
  const ab = await run([
    ck,
    'ab',
    values['image-a'],
    values['image-b'],
    '--name',
    'civireview-eval',
    '--out',
    out,
    '--json',
    reportPath,
    '--expose',
    '--keep',
    '--',
    'true',
  ]);
  if (!existsSync(reportPath)) {
    record('stacks start', false, `ck ab exit ${ab.exitCode}: ${ab.stderr.slice(-500)}`);
    return;
  }
  const report = parseCkAbJsonReport(readFileSync(reportPath, 'utf8'));
  // `ck ab` writes the kept stacks' compose files into --out, where the review run reads them.
  const composeA = join(out, 'A.compose.json');
  const composeB = join(out, 'B.compose.json');

  const kept = existsSync(composeA) && existsSync(composeB);
  record('stacks start', kept, `compose A=${composeA} B=${composeB}`);
  if (!kept) return;

  const tool = (
    createLiveProbeTool({
      urlA: report.urls?.A,
      urlB: report.urls?.B,
      composeFileA: composeA,
      composeFileB: composeB,
      execFn: execWithCappedOutput,
    }) as ToolSet
  ).live_probe_ab!;
  const call = (input: Record<string, unknown>) =>
    tool.execute!(
      { target: 'both', timeoutSeconds: 120, ...input },
      { toolCallId: 'eval', messages: [], context: undefined },
    ) as Promise<ExecResult & { a?: { status?: number }; b?: { status?: number } }>;

  const create = await call({
    mode: 'exec',
    argv: [
      'cv',
      'api4',
      'Contact.create',
      '{"values":{"contact_type":"Organization","organization_name":"civireview eval"}}',
    ],
  });
  record('cv api4 write on both', bothOk(create), brief(create));

  const job = await call({ mode: 'exec', argv: ['cv', 'api3', 'Job.send_reminder'] });
  record('scheduled job on both', bothOk(job), brief(job));
  // The model case reads results shortened to 300 characters, as review.json keeps them.
  record(
    'exit codes survive shortening',
    (JSON.stringify(job) ?? '').slice(0, 300).includes(SUCCESS_ON_BOTH),
    (JSON.stringify(job) ?? '').slice(0, 120),
  );

  // The claude CLI runner reaches the same tool through the stdio MCP server.
  const mcp = await connectStdioMcpClient(
    outsideWorktree(
      liveProbeMcpServer({
        composeFiles: { A: composeA, B: composeB },
        urls: { A: report.urls?.A, B: report.urls?.B },
        maxExecSeconds: 120,
      }),
    ),
  );
  try {
    const viaMcp = (await mcp.tools.live_probe_ab?.execute?.(
      { mode: 'exec', argv: ['cv', 'api3', 'Job.send_reminder'] },
      { toolCallId: 'eval-mcp', messages: [], context: undefined },
    )) as { content?: Array<{ text?: string }> } | undefined;
    const text = viaMcp?.content?.[0]?.text ?? '';
    record(
      'scheduled job via MCP server',
      text.startsWith(`{${SUCCESS_ON_BOTH}`),
      text.slice(0, 120) || 'no tool',
    );
  } finally {
    await mcp.close();
  }

  const started = Date.now();
  const slow = await call({ mode: 'exec', argv: ['sleep', '30'], timeoutSeconds: 2 });
  const seconds = Math.round((Date.now() - started) / 1000);
  record(
    'timeout inside the container',
    Boolean(slow.a?.timedOut && slow.b?.timedOut) && seconds < 20,
    `A exit ${slow.a?.exitCode} / B exit ${slow.b?.exitCode} after ${seconds}s`,
  );

  if (report.urls?.A && report.urls?.B) {
    const page = (await call({ mode: 'http-get', route: 'civicrm/login' })) as {
      a?: { status?: number };
      b?: { status?: number };
    };
    record(
      'http-get on both',
      (page.a?.status ?? 500) < 500 && (page.b?.status ?? 500) < 500,
      `A ${page.a?.status} / B ${page.b?.status}`,
    );
  } else {
    record('http-get on both', false, 'ck ab reported no URLs');
  }
}

async function stopStacksUnder(dir: string) {
  if (!existsSync(dir)) return;
  for await (const file of new Bun.Glob('**/[AB].compose.json').scan({
    cwd: dir,
    absolute: true,
  })) {
    await run(
      ['docker', 'compose', '-f', file, 'down', '--remove-orphans', '-v'],
      undefined,
      120_000,
    );
  }
}

async function modelCase() {
  const checkout = join(work, 'civicrm-core');
  if (!existsSync(join(checkout, '.git'))) {
    const clone = await run([
      'git',
      'clone',
      '--filter=blob:none',
      `https://github.com/${MODEL_CASE.repo}.git`,
      checkout,
    ]);
    if (clone.exitCode !== 0) {
      record('model case: checkout', false, clone.stderr.slice(-300));
      return;
    }
  }
  const out = join(work, 'model');
  // The review keeps its worktrees and stacks here, so a killed review can be cleaned up.
  const worktrees = join(work, 'model-worktrees');
  const cleanReview = async () => {
    await stopStacksUnder(worktrees);
    rmSync(worktrees, { recursive: true, force: true });
    await run(['git', '-C', checkout, 'worktree', 'prune'], undefined, 60_000);
  };
  await cleanReview();
  rmSync(out, { recursive: true, force: true });
  const cli = resolve(import.meta.dir, '..', 'bin', 'civireview.ts');
  const review = await run(
    [
      'bun',
      'run',
      cli,
      'pr',
      MODEL_CASE.pr,
      '--repo',
      MODEL_CASE.repo,
      '--dry-run',
      '--full',
      '--preset',
      values.preset,
      '--out',
      out,
    ],
    checkout,
    2_700_000,
    { CIVIREVIEW_WORKTREE_DIR: worktrees },
  );
  // A killed review skips its own cleanup.
  await cleanReview();
  const reviewPath = join(out, 'review.json');
  if (review.exitCode !== 0 || !existsSync(reviewPath)) {
    record(
      'model case: review ran',
      false,
      `exit ${review.exitCode}: ${review.stderr.slice(-800)}`,
    );
    return;
  }
  const output = FinalReviewSchema.parse(JSON.parse(readFileSync(reviewPath, 'utf8')));
  const stages = output.tokenUsage?.byStage ?? [];
  const liveUses = stages.flatMap((s) =>
    (s.toolUses ?? [])
      .filter((u) => u.tool === 'live_probe_ab')
      .map((u) => ({ stage: s.stage, input: u.input, output: u.output ?? '' })),
  );
  const byStage = [...new Set(liveUses.map((u) => u.stage))].join(', ') || 'none';
  record(
    'model case: stages call the live tool',
    liveUses.length > 0,
    `${liveUses.length} call(s) in ${byStage}`,
  );
  // A run without setup proves nothing on a fresh stack. Setup and run count only within one
  // stage, whose calls are in order; the order across stages is not recorded.
  const ok = (u: (typeof liveUses)[number]) => u.output.includes(SUCCESS_ON_BOTH);
  const reproduced = [...new Set(liveUses.map((u) => u.stage))].flatMap((stage) => {
    const calls = liveUses.filter((u) => u.stage === stage);
    const setupAt = calls.findIndex((u) => MODEL_CASE.expectedSetup.test(u.input) && ok(u));
    const exercised = setupAt >= 0 ? calls.slice(setupAt + 1).find(ok) : undefined;
    return exercised ? [{ setup: calls[setupAt]!, run: exercised }] : [];
  })[0];
  const setups = liveUses.filter((u) => MODEL_CASE.expectedSetup.test(u.input) && ok(u)).length;
  const jobs = liveUses.filter((u) => MODEL_CASE.reminderJob.test(u.input) && ok(u)).length;
  record(
    'model case: reminder set up, then exercised, in one stage on both stacks',
    Boolean(reproduced),
    reproduced
      ? `${reproduced.run.stage}: ${reproduced.setup.input.slice(0, 120)} -> ${reproduced.run.input.slice(0, 120)}`
      : `successful setups ${setups}, no successful call after one within a stage`,
  );
  console.error(`Job.send_reminder run successfully: ${jobs} time(s)`);
  const open = output.walkthrough.filter((b) => /NOT VERIFIED|NEEDS_QUESTION/.test(b));
  console.error(`\nverdict ${output.verdict}, est. $${output.tokenUsage?.estimatedUsd ?? '?'}`);
  console.error(
    `Points still open (${open.length}):${open.map((b) => `\n  - ${b}`).join('') || ' none'}`,
  );
}

await plumbing();
if (values['with-model']) await modelCase();

const failed = results.filter((r) => !r.pass);
console.error(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length > 0 ? 1 : 0);
