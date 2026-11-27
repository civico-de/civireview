import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { basename, join, resolve, sep } from 'node:path';
import type { AddedTestMethod } from '../diff-filter.ts';
import {
  BrowserDiffReportSchema,
  LiveSurfaceDiffSchema,
  type AbCheckResult,
  type BrowserDiffReport,
  type LiveSurfaceDiff,
  type BasePassingTest,
} from '../types.ts';
import { matchesPhpUnitMethod } from './test-targets.ts';

export interface RunCommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut?: boolean;
  durationMs?: number;
}

export type ExecFn = (
  args: string[],
  opts?: {
    cwd?: string;
    env?: Record<string, string | undefined>;
    timeoutMs?: number;
  },
) => Promise<RunCommandResult>;

const LOCALHOST_URL_RE = /^http:\/\/(127\.0\.0\.1|localhost):\d+$/;

/**
 * Strictly validates that a stack URL targets localhost / 127.0.0.1 with an explicit port.
 */
export function validateLocalhostUrl(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const trimmed = raw.trim().replace(/\/+$/, '');
  return LOCALHOST_URL_RE.test(trimmed) ? trimmed : undefined;
}

/**
 * Parses `ck ab` stdout lines into structured test outcome arrays.
 */
export function parseCkAbOutput(stdout: string): {
  fixed: string[];
  regressions: string[];
  bothFail: string[];
  gone: string[];
  exitCodeA?: number;
  exitCodeB?: number;
} {
  const fixed: string[] = [];
  const regressions: string[] = [];
  const bothFail: string[] = [];
  const gone: string[] = [];
  let exitCodeA: number | undefined;
  let exitCodeB: number | undefined;

  let currentGroup: 'regression' | 'fixed' | 'both' | 'gone' | null = null;
  for (const rawLine of stdout.split(/\r?\n/)) {
    const exitMatchA = rawLine.match(/^ck ab: A .*?: exit (\d+)/);
    if (exitMatchA?.[1]) exitCodeA = Number(exitMatchA[1]);
    const exitMatchB = rawLine.match(/^ck ab: B .*?: exit (\d+)/);
    if (exitMatchB?.[1]) exitCodeB = Number(exitMatchB[1]);

    if (rawLine.startsWith('ck ab: pass on A, fail on B:')) {
      currentGroup = 'regression';
      continue;
    }
    if (rawLine.startsWith('ck ab: fail on A, pass on B:')) {
      currentGroup = 'fixed';
      continue;
    }
    if (rawLine.startsWith('ck ab: fail on both:')) {
      currentGroup = 'both';
      continue;
    }
    if (rawLine.startsWith('ck ab: ran on A, skipped or missing on B:')) {
      currentGroup = 'gone';
      continue;
    }
    if (rawLine.startsWith('ck ab:')) {
      currentGroup = null;
      continue;
    }

    const trimmed = rawLine.trim();
    if (trimmed && currentGroup) {
      if (currentGroup === 'regression') regressions.push(trimmed);
      else if (currentGroup === 'fixed') fixed.push(trimmed);
      else if (currentGroup === 'both') bothFail.push(trimmed);
      else if (currentGroup === 'gone') gone.push(trimmed);
    }
  }

  return { fixed, regressions, bothFail, gone, exitCodeA, exitCodeB };
}

export interface ParsedCkAbJsonReport {
  mode: 'junit' | 'exit-status';
  exitCodeA?: number;
  exitCodeB?: number;
  fixed: string[];
  regressions: string[];
  bothFail: string[];
  gone: string[];
  onlyOnB: string[];
  passedBoth: string[];
  counts?: Record<string, number>;
  exitCode?: number;
  surfaceDiff?: LiveSurfaceDiff;
  browserDiff?: BrowserDiffReport;
  urls?: { A?: string; B?: string };
  composeFiles?: { A?: string; B?: string };
}

function toStringArray(val: unknown): string[] {
  return Array.isArray(val) ? val.map((item) => String(item)) : [];
}

/**
 * Parses the structured JSON report emitted by `ck ab --json <path> [--surface]`.
 */
export function parseCkAbJsonReport(rawJson: string): ParsedCkAbJsonReport {
  const data = JSON.parse(rawJson) as Record<string, unknown>;
  const a = (data.A ?? {}) as Record<string, unknown>;
  const b = (data.B ?? {}) as Record<string, unknown>;
  const groups = (data.groups ?? {}) as Record<string, unknown>;
  const rawCounts = (data.counts ?? undefined) as Record<string, unknown> | undefined;

  const counts: Record<string, number> | undefined = rawCounts
    ? (Object.fromEntries(
        Object.entries(rawCounts).filter(([, v]) => typeof v === 'number'),
      ) as Record<string, number>)
    : undefined;

  let surfaceDiff: LiveSurfaceDiff | undefined;
  if (data.surface_diff && typeof data.surface_diff === 'object') {
    const parsedSurface = LiveSurfaceDiffSchema.safeParse(data.surface_diff);
    if (parsedSurface.success) {
      surfaceDiff = parsedSurface.data;
    }
  }

  let browserDiff: BrowserDiffReport | undefined;
  if (data.browser_diff && typeof data.browser_diff === 'object') {
    const parsedBrowser = BrowserDiffReportSchema.safeParse(data.browser_diff);
    if (parsedBrowser.success) {
      browserDiff = parsedBrowser.data;
    }
  }

  const rawUrls = (data.urls ?? {}) as Record<string, unknown>;
  const urlA =
    validateLocalhostUrl(rawUrls.A) ??
    validateLocalhostUrl(a.url) ??
    validateLocalhostUrl(browserDiff?.urls?.A);
  const urlB =
    validateLocalhostUrl(rawUrls.B) ??
    validateLocalhostUrl(b.url) ??
    validateLocalhostUrl(browserDiff?.urls?.B);
  const urls = urlA || urlB ? { A: urlA, B: urlB } : undefined;

  const composeA =
    typeof a.compose === 'string'
      ? a.compose
      : typeof data.compose_a === 'string'
        ? data.compose_a
        : undefined;
  const composeB =
    typeof b.compose === 'string'
      ? b.compose
      : typeof data.compose_b === 'string'
        ? data.compose_b
        : undefined;
  const composeFiles = composeA || composeB ? { A: composeA, B: composeB } : undefined;

  return {
    mode: data.mode === 'exit-status' ? 'exit-status' : 'junit',
    exitCodeA: typeof a.status === 'number' ? a.status : undefined,
    exitCodeB: typeof b.status === 'number' ? b.status : undefined,
    fixed: toStringArray(groups.fixed),
    regressions: toStringArray(groups.regression),
    bothFail: toStringArray(groups.both),
    gone: toStringArray(groups.gone),
    onlyOnB: toStringArray(groups.only_on_b),
    passedBoth: toStringArray(groups.passed_both),
    counts,
    exitCode: typeof data.exit_code === 'number' ? data.exit_code : undefined,
    surfaceDiff,
    browserDiff,
    urls,
    composeFiles,
  };
}

export interface ParsedTaintItem {
  key: string;
  path: string;
  line: number;
  message: string;
  severity: 'error' | 'info';
}

export function stripAnsi(str: string): string {
  // Colour/cursor sequences and OSC 8 terminal hyperlinks, which Psalm wraps around paths.
  // oxlint-disable-next-line no-control-regex
  return str.replace(/\x1B\[[0-9;]*[mGKHF]|\x1B\]8;;[^\x1B\x07]*(?:\x1B\\|\x07)/g, '');
}

const PSALM_ISSUE_RE = /^(ERROR|INFO): (\w+) - (.+?):(\d+):\d+ - (.+)$/;

/**
 * Reads the issue lines of `cktaint` (Psalm console format); trace and summary lines are skipped.
 * The key leaves out the line number so that code moved by the PR is not reported as new.
 */
export function parseTaintFindings(rawOutput: string): ParsedTaintItem[] {
  const items: ParsedTaintItem[] = [];
  for (const line of stripAnsi(rawOutput).split(/\r?\n/)) {
    const m = PSALM_ISSUE_RE.exec(line.trim());
    if (!m) continue;
    const [, level, type, path, lineNo, msg] = m as unknown as [
      string,
      string,
      string,
      string,
      string,
      string,
    ];
    items.push({
      key: `${type}:${path}:${msg}`,
      path,
      line: Number(lineNo),
      message: `${type}: ${msg}`,
      severity: level === 'ERROR' ? 'error' : 'info',
    });
  }
  return items;
}

/**
 * Items of `head` that `base` does not have. A head item is paired with a base item on the
 * same line first, then with a moved one; a pair counts as new only when `INFO` became `ERROR`.
 */
export function newTaintFindings(
  base: ParsedTaintItem[],
  head: ParsedTaintItem[],
): ParsedTaintItem[] {
  const pool = [...base];
  const takeBase = (matches: (b: ParsedTaintItem) => boolean): ParsedTaintItem | undefined => {
    const i = pool.findIndex(matches);
    return i < 0 ? undefined : pool.splice(i, 1)[0];
  };
  // Equal severity pairs first, so an unchanged error is never paired with a base info.
  let rest = head;
  for (const sameLine of [true, false]) {
    rest = rest.filter(
      (h) =>
        !takeBase(
          (b) => b.key === h.key && b.severity === h.severity && (!sameLine || b.line === h.line),
        ),
    );
  }
  return rest.filter((h) => {
    const b = takeBase((x) => x.key === h.key);
    return !b || (h.severity === 'error' && b.severity !== 'error');
  });
}

/**
 * Script errors `ck demo` prints for the recordings with the PR applied, leaving out
 * those the recording of the base printed as well.
 */
export function parseDemoErrors(stdout: string): string[] {
  const byPhase: Record<'before' | 'after', string[]> = { before: [], after: [] };
  let phase: 'before' | 'after' | undefined;
  for (const line of stripAnsi(stdout).split(/\r?\n/)) {
    if (line.startsWith('ck demo:')) {
      phase = /^ck demo: .* (before|after): \d+ script errors$/.exec(line)?.[1] as typeof phase;
    } else if (phase && line.startsWith('  ')) {
      byPhase[phase].push(line.trim());
    }
  }
  const onBase = new Set(byPhase.before);
  return byPhase.after.filter((error) => !onBase.has(error));
}

const COMPOSE_PROGRESS_RE =
  /^\s*(?:Network|Container)\s+\S+\s+(?:Creating|Created|Starting|Started|Waiting|Healthy|Running|Stopping|Stopped|Removing|Removed)\b/;

export function formatAbOutputSnippet(stdout: string, stderr: string, exitCode: number): string {
  const outTrim = stdout.trim();
  const errTrim = stderr
    .split(/\r?\n/)
    .filter((line) => !COMPOSE_PROGRESS_RE.test(line))
    .join('\n')
    .trim();
  if (exitCode !== 0 && errTrim) {
    if (!outTrim) return errTrim.slice(0, 4000);
    return `${outTrim}\n[stderr]\n${errTrim}`.slice(0, 4000);
  }
  return (stdout || errTrim || stderr).slice(0, 4000);
}

/**
 * Extracts the tail (last 10 meaningful lines) of stdout/stderr, stripping
 * Docker Compose progress lines so runner error logs show the actual failure cause.
 */
export function formatAbDiagnosticTail(stdout: string, stderr: string): string {
  const lines = `${stderr}\n${stdout}`
    .split(/\r?\n/)
    .map((l) => stripAnsi(l).trim())
    .filter((l) => l.length > 0 && !COMPOSE_PROGRESS_RE.test(l));
  if (lines.length === 0) {
    const rawTail = `${stderr}\n${stdout}`
      .split(/\r?\n/)
      .map((l) => stripAnsi(l).trim())
      .filter((l) => l.length > 0)
      .slice(-5);
    return rawTail.length > 0 ? rawTail.join(' | ').slice(0, 600) : 'no output';
  }
  return lines.slice(-10).join(' | ').slice(0, 800);
}

export function isUnsupportedCkFlagError(
  exitCode: number,
  stdout: string,
  stderr: string,
  flagPattern: RegExp,
): boolean {
  if (exitCode === 0) return false;
  const combined = `${stderr}\n${stdout}`;
  return (
    /(?:unknown|unrecognized|invalid|unexpected|no\s+such)\s+(?:option|argument|flag|command|subcommand)|^usage:\s*ck\b/im.test(
      combined,
    ) &&
    flagPattern.test(combined) &&
    !combined.includes('ck ab: A')
  );
}

export function extractKeyValueFromOutput(
  stdout: string,
  stderr: string,
  key: string,
): string | undefined {
  const combined = `${stdout}\n${stderr}`;
  const re = new RegExp(`(?:^|\\s)${key}=([^\\s"']+)`, 'm');
  const match = combined.match(re);
  return match?.[1]?.trim();
}

export function copyScreenshotIfSafe(
  rawPath: string | undefined,
  subOut: string,
  workDir: string,
  destDir: string,
  destName: string,
): string | undefined {
  if (!rawPath) return undefined;
  const candidates = rawPath.startsWith('/')
    ? [resolve(rawPath)]
    : [resolve(subOut, 'screenshots', rawPath), resolve(subOut, rawPath)];
  const allowedBase = resolve(workDir);
  const candidate = candidates.find(
    (c) => (c === allowedBase || c.startsWith(allowedBase + sep)) && existsSync(c),
  );
  if (!candidate) {
    return undefined;
  }
  mkdirSync(destDir, { recursive: true });
  const ext = basename(candidate).match(/\.(png|jpe?g|webp)$/i)?.[0] ?? '.png';
  const destPath = join(destDir, `${destName}${ext}`);
  copyFileSync(candidate, destPath);
  return destPath;
}

export function buildAbCheckFromJson(params: {
  name: string;
  args: string[];
  imageA: string;
  imageB: string;
  res: RunCommandResult;
  parsedJson: ParsedCkAbJsonReport;
  hasProductionCodeChange: boolean;
  addedTestMethods: AddedTestMethod[];
}): AbCheckResult {
  const { name, args, imageA, imageB, res, parsedJson, hasProductionCodeChange, addedTestMethods } =
    params;
  const isProofOfFix = name === 'proof-of-fix';

  const basePassingTests: BasePassingTest[] = [];
  if (isProofOfFix && hasProductionCodeChange && addedTestMethods.length > 0) {
    for (const added of addedTestMethods) {
      const wasFixed = parsedJson.fixed.some((tc) => matchesPhpUnitMethod(tc, added.method));
      if (wasFixed) continue;
      const matchedPassedBoth = parsedJson.passedBoth.find((tc) =>
        matchesPhpUnitMethod(tc, added.method),
      );
      if (matchedPassedBoth) {
        basePassingTests.push({
          file: added.file,
          method: added.method,
          line: added.line,
          testCaseName: matchedPassedBoth,
        });
      }
    }
  }

  const effectiveExit = parsedJson.exitCode ?? res.exitCode;
  const bootstrapCrash =
    parsedJson.mode === 'junit' &&
    parsedJson.fixed.length === 0 &&
    parsedJson.regressions.length === 0 &&
    parsedJson.passedBoth.length === 0 &&
    parsedJson.bothFail.length > 0 &&
    (parsedJson.counts?.a ?? 0) > parsedJson.bothFail.length;

  const exitStatusBothNonZero =
    parsedJson.mode === 'exit-status' &&
    (parsedJson.exitCodeA ?? 0) !== 0 &&
    (parsedJson.exitCodeB ?? 0) !== 0;

  // A JUnit comparison without a single test case compared nothing.
  const noResult =
    parsedJson.mode === 'junit' &&
    [
      parsedJson.fixed,
      parsedJson.regressions,
      parsedJson.passedBoth,
      parsedJson.bothFail,
      parsedJson.gone,
      parsedJson.onlyOnB ?? [],
    ].every((group) => group.length === 0);

  const status: AbCheckResult['status'] =
    parsedJson.regressions.length > 0
      ? 'FAIL'
      : bootstrapCrash || exitStatusBothNonZero || noResult
        ? 'ERROR'
        : effectiveExit === 0
          ? 'PASS'
          : parsedJson.mode === 'exit-status' && effectiveExit === 1
            ? 'FAIL'
            : 'ERROR';

  const basePassingSummary =
    basePassingTests.length > 0
      ? `${basePassingTests.length} added test method(s) pass on base A and on B (${basePassingTests.map((t) => t.method).join(', ')})`
      : undefined;

  const aFailedBPassedOnlyOnB =
    isProofOfFix &&
    parsedJson.fixed.length === 0 &&
    parsedJson.onlyOnB.length > 0 &&
    (parsedJson.exitCodeA ?? 0) !== 0 &&
    (parsedJson.exitCodeB ?? 0) === 0;

  const effectiveFixed = aFailedBPassedOnlyOnB ? parsedJson.onlyOnB : parsedJson.fixed;

  const baseSummary =
    parsedJson.regressions.length > 0
      ? `${parsedJson.regressions.length} regression(s) (pass on A, fail on B)`
      : bootstrapCrash
        ? `0 tests passed on A or B (${parsedJson.bothFail.length} error/failure on both, ${(parsedJson.counts?.a ?? 0) - parsedJson.bothFail.length} skipped — likely bootstrap/setup crash)`
        : effectiveFixed.length > 0
          ? `${effectiveFixed.length} test(s) red on A, green on B`
          : parsedJson.mode === 'exit-status' &&
              parsedJson.exitCodeA !== undefined &&
              parsedJson.exitCodeB !== undefined
            ? `exit-status mode: A=${parsedJson.exitCodeA}, B=${parsedJson.exitCodeB}`
            : basePassingSummary
              ? basePassingSummary
              : parsedJson.passedBoth.length > 0 && parsedJson.bothFail.length === 0
                ? `${parsedJson.passedBoth.length} test(s) passed on A and B`
                : parsedJson.passedBoth.length > 0 && parsedJson.bothFail.length > 0
                  ? `${parsedJson.passedBoth.length} test(s) passed on A and B (${parsedJson.bothFail.length} pre-existing failure(s) on both)`
                  : parsedJson.bothFail.length > 0
                    ? `0 new regressions (${parsedJson.bothFail.length} pre-existing failure(s) on both A and B)`
                    : `ck ab (${parsedJson.mode}) exited with ${effectiveExit}`;

  const summary = noResult
    ? 'the report of the run lists no test'
    : basePassingSummary && baseSummary !== basePassingSummary
      ? `${baseSummary}; ${basePassingSummary}`
      : baseSummary;

  const anyNonZeroExit =
    effectiveExit !== 0 || (parsedJson.exitCodeA ?? 0) !== 0 || (parsedJson.exitCodeB ?? 0) !== 0;

  return {
    name,
    command: args.join(' '),
    imageA,
    imageB,
    status,
    mode: parsedJson.mode,
    exitCodeA: parsedJson.exitCodeA,
    exitCodeB: parsedJson.exitCodeB,
    fixed: effectiveFixed,
    regressions: parsedJson.regressions,
    bothFail: parsedJson.bothFail,
    gone: parsedJson.gone,
    onlyOnB: parsedJson.onlyOnB,
    passedBoth: parsedJson.passedBoth,
    basePassingTests,
    addedTestMethods: isProofOfFix ? addedTestMethods : [],
    counts: parsedJson.counts,
    summary,
    outputSnippet: formatAbOutputSnippet(res.stdout, res.stderr, anyNonZeroExit ? 1 : 0),
  };
}

export function buildAbCheckFromStdout(params: {
  name: string;
  args: string[];
  imageA: string;
  imageB: string;
  res: RunCommandResult;
  addedTestMethods: AddedTestMethod[];
}): AbCheckResult {
  const { name, args, imageA, imageB, res, addedTestMethods } = params;
  const isProofOfFix = name === 'proof-of-fix';
  const parsed = parseCkAbOutput(res.stdout);
  const combined = `${res.stderr}\n${res.stdout}`;

  // Handle known AbCommand exit-2 diagnostics cleanly instead of surfacing opaque runner errors:
  // 1. Base A crashed before writing JUnit XML while PR B wrote JUnit XML (e.g. PR adds a new class/method)
  if (isProofOfFix && res.exitCode !== 0 && /only B wrote\b/i.test(combined)) {
    return {
      name,
      command: args.join(' '),
      imageA,
      imageB,
      status: 'ERROR',
      fixed: parsed.fixed,
      regressions: [],
      bothFail: [],
      gone: [],
      passedBoth: [],
      basePassingTests: [],
      addedTestMethods,
      summary: 'the base stopped before its tests ran; the result on the PR was not compared',
      outputSnippet: formatAbOutputSnippet(res.stdout, res.stderr, res.exitCode),
    };
  }

  // 2. Target contained 0 runnable headless test cases or identical mounts
  if (
    res.exitCode !== 0 &&
    (/holds no test case/i.test(combined) || /same mounts; nothing to compare/i.test(combined))
  ) {
    return {
      name,
      command: args.join(' '),
      imageA,
      imageB,
      status: 'SKIPPED',
      exitCodeA: parsed.exitCodeA,
      exitCodeB: parsed.exitCodeB,
      fixed: [],
      regressions: [],
      bothFail: [],
      gone: [],
      passedBoth: [],
      basePassingTests: [],
      addedTestMethods: isProofOfFix ? addedTestMethods : [],
      summary: /holds no test case/i.test(combined)
        ? 'No matching headless PHPUnit test cases in target.'
        : 'Identical base and PR mounts; skipped.',
      outputSnippet: formatAbOutputSnippet(res.stdout, res.stderr, res.exitCode),
    };
  }

  const status: AbCheckResult['status'] =
    res.exitCode === 0 ? 'PASS' : parsed.regressions.length > 0 ? 'FAIL' : 'ERROR';
  return {
    name,
    command: args.join(' '),
    imageA,
    imageB,
    status,
    exitCodeA: parsed.exitCodeA,
    exitCodeB: parsed.exitCodeB,
    fixed: parsed.fixed,
    regressions: parsed.regressions,
    bothFail: parsed.bothFail,
    gone: parsed.gone,
    passedBoth: [],
    basePassingTests: [],
    addedTestMethods: isProofOfFix ? addedTestMethods : [],
    summary:
      parsed.regressions.length > 0
        ? `${parsed.regressions.length} regression(s) (pass on A, fail on B)`
        : parsed.fixed.length > 0
          ? `${parsed.fixed.length} test(s) red on A, green on B`
          : `Internal A/B test runner error (exit ${res.exitCode}) — not a PR failure`,
    outputSnippet: formatAbOutputSnippet(res.stdout, res.stderr, res.exitCode),
  };
}
