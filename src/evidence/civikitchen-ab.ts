import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, join, resolve, sep } from 'node:path';
import {
  BrowserConfigSchema,
  ChecksConfigSchema,
  ReviewSettingsSchema,
  isCheckEnabled,
  type AbConfig,
  type BrowserConfig,
  type ChecksConfig,
  type ReviewSettings,
} from '../config/schema.ts';
import { discoverStandaloneRoutes } from './browser-routes.ts';
import {
  extractAddedTestMethods,
  type AddedTestMethod,
} from './diff-filter.ts';
import {
  BrowserDiffReportSchema,
  LiveSurfaceDiffSchema,
  type AbCheckResult,
  type AbRunReport,
  type BrowserDiffReport,
  type DiffFile,
  type LiveSurfaceDiff,
  type RepoInfo,
  type StaticDeltaFinding,
  type StaticDeltaReport,
  type SurfaceChange,
  type SurfaceDiffReport,
  type TautologicalTest,
} from './types.ts';

export interface RunCommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export type ExecFn = (
  args: string[],
  opts?: { cwd?: string; env?: Record<string, string | undefined>; timeoutMs?: number },
) => Promise<RunCommandResult>;

async function defaultExec(
  args: string[],
  opts: { cwd?: string; env?: Record<string, string | undefined>; timeoutMs?: number } = {},
): Promise<RunCommandResult> {
  const [cmd, ...rest] = args;
  if (!cmd) {
    return { exitCode: 2, stdout: '', stderr: 'empty command' };
  }
  const proc = Bun.spawn([cmd, ...rest], {
    cwd: opts.cwd,
    env: opts.env ? { ...process.env, ...opts.env } : process.env,
    stdout: 'pipe',
    stderr: 'pipe',
  });

  let timer: ReturnType<typeof setTimeout> | undefined;
  if (opts.timeoutMs && opts.timeoutMs > 0) {
    timer = setTimeout(() => {
      try {
        proc.kill();
      } catch {
        // ignore kill error
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
 * Computes touched CiviCRM top-level directories, static surface changes,
 * and unverified surfaces directly from the filtered diff.
 */
export function computeSurfaceDiff(
  diffFiles: DiffFile[],
  repoInfo: RepoInfo,
): SurfaceDiffReport {
  const changes: SurfaceChange[] = [];
  const unverifiedSurfaces = new Set<string>();
  const touchedComponents = new Set<string>();

  for (const file of diffFiles) {
    const p = file.path;
    const changeType: SurfaceChange['change'] =
      file.status === 'added'
        ? 'added'
        : file.status === 'deleted'
          ? 'removed'
          : 'modified';

    if (repoInfo.kind === 'civicrm-core') {
      const top = p.split('/')[0];
      if (
        top === 'CRM' ||
        top === 'Civi' ||
        top === 'api' ||
        top === 'templates' ||
        top === 'css' ||
        top === 'js' ||
        top === 'ang' ||
        top === 'xml'
      ) {
        touchedComponents.add(top);
      } else if (top === 'ext') {
        const extSub = p.split('/').slice(0, 2).join('/');
        if (extSub) touchedComponents.add(extSub);
      }
    } else if (repoInfo.kind === 'civicrm-extension') {
      touchedComponents.add(repoInfo.extensionName ?? 'extension');
    }

    if (file.flags.isMenuXml) {
      changes.push({
        kind: 'menu-route',
        change: changeType,
        path: p,
        detail: 'Menu route XML changed; inspect <access_arguments> and <page_callback>.',
      });
    }
    if (file.flags.isApiV4) {
      changes.push({
        kind: 'apiv4-action',
        change: changeType,
        path: p,
        detail: 'APIv4 class changed; inspect permissions() and checkPermissions usage.',
      });
    }
    if (file.flags.isSchema) {
      changes.push({
        kind: 'schema',
        change: changeType,
        path: p,
        detail: 'Schema definition changed; mounts do not run schema rebuilds.',
      });
      if (repoInfo.kind === 'civicrm-core') {
        unverifiedSurfaces.add(
          'schema change (xml/schema) not rebuilt by container mount',
        );
      }
    }
    if (file.flags.isUpgrade) {
      changes.push({
        kind: 'upgrade',
        change: changeType,
        path: p,
        detail: 'Upgrade handler changed; requires upgrade path verification.',
      });
      if (repoInfo.kind === 'civicrm-core') {
        unverifiedSurfaces.add(
          'upgrade path (CRM/Upgrade/*) not verified locally by ck ab mount',
        );
      }
    }
    if (file.flags.isManaged) {
      changes.push({
        kind: 'managed',
        change: changeType,
        path: p,
        detail: 'Managed entity definition changed.',
      });
    }
    if (file.flags.isComposer) {
      changes.push({
        kind: 'composer',
        change: changeType,
        path: p,
        detail: 'Composer dependency manifest changed; container vendor/ is unchanged.',
      });
      unverifiedSurfaces.add(
        'composer dependencies changed; composer install not executed in mounted container',
      );
    }
    if (file.flags.isSmartyTemplate || file.flags.isAfform) {
      changes.push({
        kind: 'template',
        change: changeType,
        path: p,
        detail: 'Template or Afform layout changed.',
      });
    }

    // Inspect added/removed lines for permission/hook markers
    const patch = file.rawPatch;
    if (/^[+-].*checkPermissions/m.test(patch)) {
      changes.push({
        kind: 'permission-check',
        change: 'modified',
        path: p,
        detail: 'Diff touches checkPermissions flag or permission callback.',
      });
    }
    if (/^[+-].*function\s+[a-z0-9_]+_civicrm_/im.test(patch)) {
      changes.push({
        kind: 'hook',
        change: changeType,
        path: p,
        detail: 'Diff defines or modifies a CiviCRM hook implementation.',
      });
    }
  }

  const summary =
    changes.length === 0
      ? 'No high-risk structural surface changes detected.'
      : `Detected ${changes.length} surface change(s) across [${Array.from(touchedComponents).join(', ') || 'repo'}].`;

  return {
    changes,
    unverifiedSurfaces: Array.from(unverifiedSurfaces),
    touchedComponents: Array.from(touchedComponents),
    summary,
  };
}

/**
 * Resolves the `ck` launcher command prefix (`[cmd, ...baseArgs]`).
 */
export async function resolveCkCommand(
  abConfig: AbConfig,
  execFn: ExecFn = defaultExec,
): Promise<{ command: string[]; label: string } | null> {
  if (abConfig.ckCommand) {
    const parts = abConfig.ckCommand.trim().split(/\s+/);
    if (parts[0]) {
      return { command: parts, label: abConfig.ckCommand };
    }
  }

  const ckPath = abConfig.civikitchenPath ?? process.env.CIVIKITCHEN_PATH;
  if (ckPath) {
    const scaffoldCk = join(resolve(ckPath), 'scaffold', 'ck');
    if (existsSync(scaffoldCk)) {
      return { command: [scaffoldCk], label: scaffoldCk };
    }
  }

  const whichCk = await execFn(['which', 'ck']);
  if (whichCk.exitCode === 0 && whichCk.stdout.trim()) {
    const bin = whichCk.stdout.trim();
    return { command: [bin], label: bin };
  }

  const dockerCheck = await execFn(['which', 'docker']);
  if (dockerCheck.exitCode === 0) {
    const home = homedir();
    return {
      command: [
        'docker',
        'run',
        '--rm',
        '-i',
        '-v',
        '/var/run/docker.sock:/var/run/docker.sock',
        '-v',
        `${home}:${home}`,
        '-w',
        process.cwd(),
        'ghcr.io/civico-de/civikitchen-cli',
      ],
      label: 'ghcr.io/civico-de/civikitchen-cli',
    };
  }

  return null;
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
  const rawCounts = (data.counts ?? undefined) as
    | Record<string, unknown>
    | undefined;

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
  const composeFiles =
    composeA || composeB ? { A: composeA, B: composeB } : undefined;

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

/**
 * Merges live `surface-diff.json` risk flags and category changes into the static SurfaceDiffReport.
 */
export function mergeLiveSurfaceDiff(
  report: SurfaceDiffReport,
  live: LiveSurfaceDiff,
): SurfaceDiffReport {
  const mergedChanges = [...report.changes];
  const unverified = new Set(report.unverifiedSurfaces);

  if (live.error) {
    unverified.add(`Live surface capture failed: ${live.error}`);
    return {
      ...report,
      unverifiedSurfaces: Array.from(unverified),
      liveSurfaceDiff: live,
    };
  }

  const categoryMap: Array<{
    key: 'api4' | 'api3' | 'routes' | 'afform';
    kind: SurfaceChange['kind'];
    label: string;
  }> = [
    { key: 'api4', kind: 'apiv4-action', label: 'APIv4' },
    { key: 'api3', kind: 'apiv4-action', label: 'APIv3' },
    { key: 'routes', kind: 'menu-route', label: 'Route' },
    { key: 'afform', kind: 'template', label: 'Afform' },
  ];

  for (const cat of categoryMap) {
    const bucket = live[cat.key];
    if (!bucket) continue;
    for (const [changeKey, changeType] of [
      ['added', 'added'],
      ['removed', 'removed'],
      ['changed', 'modified'],
    ] as const) {
      for (const item of bucket[changeKey]) {
        const target =
          cat.key === 'api4' || cat.key === 'api3'
            ? item.entity && item.action
              ? `${String(item.entity)}.${String(item.action)}`
              : String(item.name ?? item.entity ?? item.action ?? 'api')
            : String(
                item.name ??
                  item.path ??
                  item.route ??
                  item.entity ??
                  'surface',
              );
        mergedChanges.push({
          kind: cat.kind,
          change: changeType,
          path: target,
          detail: `Live ${cat.label} surface ${changeKey}: ${target}`,
        });
      }
    }
  }

  for (const flag of live.risk_flags) {
    mergedChanges.push({
      kind: 'permission-check',
      change: 'modified',
      path: flag.target,
      detail: `[${flag.severity.toUpperCase()} ${flag.code}] ${flag.reason}`,
    });
  }

  return {
    ...report,
    changes: mergedChanges,
    unverifiedSurfaces: Array.from(unverified),
    liveSurfaceDiff: live,
    summary:
      live.risk_flags.length > 0
        ? `${report.summary} Live surface diff flagged ${live.risk_flags.length} risk(s).`
        : report.summary,
  };
}

function deriveRegressionTargets(
  diffFiles: DiffFile[],
  worktreeRoot?: string,
): string[] {
  const targets = new Set<string>();
  const exists = (rel: string): boolean =>
    worktreeRoot ? existsSync(join(worktreeRoot, rel)) : true;

  for (const file of diffFiles) {
    if (file.flags.isTest) continue;
    const p = file.path;

    // 1. Exact mirror test file (e.g. CRM/Core/Resources/Common.php -> tests/phpunit/CRM/Core/Resources/CommonTest.php)
    if (p.endsWith('.php') && (p.startsWith('CRM/') || p.startsWith('Civi/'))) {
      const exactTest = `tests/phpunit/${p.slice(0, -4)}Test.php`;
      if (worktreeRoot && exists(exactTest)) {
        targets.add(exactTest);
        continue;
      }
    }

    // 2. Narrowest subdirectory test suite (e.g. CRM/Core/Resources/Common.php -> tests/phpunit/CRM/Core/Resources or ResourcesTest.php)
    const crmDeep = p.match(/^CRM\/([^/]+)\/([^/]+)\//);
    if (crmDeep?.[1] && crmDeep[2]) {
      const subDir = `tests/phpunit/CRM/${crmDeep[1]}/${crmDeep[2]}`;
      const subFile = `tests/phpunit/CRM/${crmDeep[1]}/${crmDeep[2]}Test.php`;
      if (worktreeRoot && exists(subDir)) {
        targets.add(subDir);
        continue;
      }
      if (worktreeRoot && exists(subFile)) {
        targets.add(subFile);
        continue;
      }
    }

    const civiMatch = p.match(/^Civi\/([^/]+)\//);
    if (civiMatch?.[1] && civiMatch[1] !== 'Api4') {
      const civiDir = `tests/phpunit/Civi/${civiMatch[1]}`;
      if (exists(civiDir)) {
        targets.add(civiDir);
        continue;
      }
    }

    const crmMatch = p.match(/^CRM\/([^/]+)\//);
    if (crmMatch?.[1] && crmMatch[1] !== 'Core') {
      const candidate = `tests/phpunit/CRM/${crmMatch[1]}`;
      if (exists(candidate)) {
        targets.add(candidate);
        continue;
      }
    }

    const api4Match = p.match(/^Civi\/Api4\/([^/.]+)/);
    if (api4Match?.[1]) {
      const api4Test = `tests/phpunit/api/v4/${api4Match[1]}Test.php`;
      if (exists(api4Test)) {
        targets.add(api4Test);
        continue;
      }
    }

    // Core extensions under ext/<name>/ (e.g. ext/financialacls/..., ext/afform/core/...)
    const extMatch = p.match(/^ext\/([^/]+)\//);
    if (extMatch?.[1]) {
      const extName = extMatch[1];
      // Prefer modified test files from the same core extension that exist on base A
      let addedFromDiff = false;
      for (const tf of diffFiles) {
        if (
          tf.flags.isTest &&
          /Test\.php$/i.test(tf.path) &&
          tf.path.startsWith(`ext/${extName}/`) &&
          exists(tf.path)
        ) {
          targets.add(tf.path);
          addedFromDiff = true;
        }
      }
      if (!addedFromDiff) {
        const extTestDir = `ext/${extName}/tests/phpunit`;
        if (exists(extTestDir)) {
          targets.add(extTestDir);
        }
      }
    }
  }
  return Array.from(targets).slice(0, 3);
}

interface ParsedTaintItem {
  key: string;
  path?: string;
  line?: number;
  message: string;
  severity: 'error' | 'warning' | 'info';
}

function stripAnsi(str: string): string {
  return str.replace(/\x1B\[[0-9;]*[mGKHF]/g, '');
}

/**
 * Parses `ck taint` stdout/JSON into normalized findings so A-vs-B delta
 * only reports genuinely new findings introduced on B.
 */
export function parseTaintFindings(rawOutput: string): ParsedTaintItem[] {
  const cleaned = stripAnsi(rawOutput).trim();
  if (!cleaned) return [];

  if (cleaned.startsWith('{') || cleaned.startsWith('[')) {
    try {
      const parsed = JSON.parse(cleaned) as unknown;
      const list = Array.isArray(parsed)
        ? parsed
        : parsed &&
            typeof parsed === 'object' &&
            Array.isArray((parsed as Record<string, unknown>).findings)
          ? ((parsed as Record<string, unknown>).findings as unknown[])
          : null;
      if (list) {
        return list
          .filter((item): item is Record<string, unknown> =>
            Boolean(item && typeof item === 'object'),
          )
          .map((item) => {
            const path =
              typeof item.path === 'string'
                ? item.path
                : typeof item.file === 'string'
                  ? item.file
                  : undefined;
            const lineNum =
              typeof item.line === 'number' && item.line > 0
                ? item.line
                : undefined;
            const msg = String(
              item.message ?? item.title ?? item.type ?? JSON.stringify(item),
            );
            const rawSev = String(item.severity ?? 'warning').toLowerCase();
            const severity: ParsedTaintItem['severity'] =
              rawSev === 'error' || rawSev === 'high' || rawSev === 'critical'
                ? 'error'
                : rawSev === 'info'
                  ? 'info'
                  : 'warning';
            return {
              key: `${path ?? ''}:${lineNum ?? ''}:${msg.trim()}`,
              path,
              line: lineNum,
              message: msg.trim(),
              severity,
            };
          });
      }
    } catch {
      // Fall through to line-based parsing
    }
  }

  const items: ParsedTaintItem[] = [];
  for (const rawLine of cleaned.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    if (
      /^(?:ck\s+taint|===|---|Total:|0\s+issue|No\s+taint|PASS\b|OK\b)/i.test(
        line,
      )
    ) {
      continue;
    }
    const locMatch = line.match(
      /^([A-Za-z0-9_./-]+\.php):(\d+)(?::\d+)?\s*[:-]?\s*(.+)$/,
    );
    if (locMatch?.[1] && locMatch[2] && locMatch[3]) {
      const path = locMatch[1];
      const lineNum = Number(locMatch[2]);
      const msg = locMatch[3].trim();
      items.push({
        key: `${path}:${lineNum}:${msg}`,
        path,
        line: Number.isInteger(lineNum) && lineNum > 0 ? lineNum : undefined,
        message: `${path}:${lineNum}: ${msg}`,
        severity: /\b(?:error|high|critical|sql\s*injection|xss)\b/i.test(msg)
          ? 'error'
          : 'warning',
      });
    } else {
      items.push({
        key: line,
        message: line,
        severity: /\b(?:error|high|critical)\b/i.test(line)
          ? 'error'
          : 'warning',
      });
    }
  }
  return items;
}

function buildCkAbName(workDir: string, checkName: string): string {
  const dirSlug =
    basename(workDir)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 16) || 'run';
  const checkSlug =
    checkName
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 24) || 'ab';
  return `civireview-${dirSlug}-${checkSlug}`;
}

function matchesPhpUnitMethod(testCaseName: string, method: string): boolean {
  const marker = `::${method}`;
  const idx = testCaseName.indexOf(marker);
  if (idx === -1) return false;
  const after = testCaseName.slice(idx + marker.length);
  return after === '' || after.startsWith(' with data set') || after.startsWith('#');
}

function shellQuote(arg: string): string {
  return `'${arg.replaceAll("'", "'\\''")}'`;
}

function findEnclosingModifiedTestMethods(
  targetDiff: DiffFile,
  worktreeRoot?: string,
): string[] {
  if (!worktreeRoot) return [];
  const fullPath = join(worktreeRoot, targetDiff.path);
  if (!existsSync(fullPath)) return [];
  let lines: string[];
  try {
    lines = readFileSync(fullPath, 'utf8').split(/\r?\n/);
  } catch {
    return [];
  }
  const found = new Set<string>();
  const methodRe =
    /^\s*(?:(?:public|protected|private|final|static)\s+)*function\s+(test[A-Za-z0-9_]+)\s*\(/;
  const anyFuncRe =
    /^\s*(?:(?:public|protected|private|final|static)\s+)*function\s+([A-Za-z0-9_]+)\s*\(/;

  for (const hunk of targetDiff.hunks) {
    const startIdx = Math.min(Math.max(0, hunk.newStart - 1), lines.length - 1);
    for (let i = startIdx; i >= 0; i--) {
      const line = lines[i] ?? '';
      const testMatch = line.match(methodRe);
      if (testMatch?.[1]) {
        found.add(testMatch[1]);
        break;
      }
      if (anyFuncRe.test(line)) {
        // Inside a non-test helper/setUp/dataProvider method — cannot safely filter
        return [];
      }
    }
  }
  return Array.from(found);
}

function buildPerFileFilterArgs(
  targetPath: string,
  diffFiles: DiffFile[],
  addedTestMethods: AddedTestMethod[],
  worktreeB?: string,
): string[] {
  const targetDiff = diffFiles.find((f) => f.path === targetPath);
  if (!targetDiff || targetDiff.status !== 'modified') return [];
  const added = Array.from(
    new Set(
      addedTestMethods
        .filter((m) => m.file === targetPath)
        .map((m) => m.method),
    ),
  );
  const methods =
    added.length > 0
      ? added
      : findEnclosingModifiedTestMethods(targetDiff, worktreeB);
  if (methods.length < 1 || methods.length > 10) return [];
  return ['--filter', `/(^|::)(${methods.join('|')})(\\s|$)/`];
}

/**
 * Builds the container command for 1 or more PHPUnit/ckcoretest targets.
 * PHPUnit 9 only accepts a single test path per invocation (and `ckcoretest`
 * switches working directory per extension `phpunit.xml.dist`), so multiple
 * targets are executed sequentially in one stack boot and their JUnit XML
 * reports are merged into `/tmp/ck-ab.xml`.
 */
export function buildMultiTargetTestCommand(
  runnerBin: 'ckcoretest' | 'phpunit',
  targets: Array<{ path: string; filterArgs?: string[] }>,
): string[] {
  if (targets.length === 1) {
    const only = targets[0]!;
    return [
      runnerBin,
      '--log-junit',
      '/tmp/ck-ab.xml',
      ...(only.filterArgs ?? []),
      only.path,
    ];
  }

  const lines: string[] = ['rm -f /tmp/ck-ab.xml /tmp/ck-ab-part-*.xml', 'rc=0'];
  targets.forEach((t, idx) => {
    const partXml = `/tmp/ck-ab-part-${idx}.xml`;
    const filterPart = (t.filterArgs ?? []).map(shellQuote).join(' ');
    const filteredCmd = [
      runnerBin,
      '--log-junit',
      partXml,
      ...(filterPart ? [filterPart] : []),
      shellQuote(t.path),
    ].join(' ');
    lines.push(`${filteredCmd} || rc=$?`);
    if (filterPart) {
      const unfilteredCmd = `${runnerBin} --log-junit ${partXml} ${shellQuote(t.path)}`;
      lines.push(
        `if [ ! -f ${partXml} ] || ! grep -q '<testcase' ${partXml}; then ${unfilteredCmd} || rc=$?; fi`,
      );
    }
  });

  const phpMerge =
    '$out=new DOMDocument("1.0","UTF-8");' +
    '$root=$out->appendChild($out->createElement("testsuites"));' +
    'foreach(glob("/tmp/ck-ab-part-*.xml")?:[] as $f){' +
    '$d=new DOMDocument();' +
    'if(@$d->load($f)){' +
    'foreach($d->getElementsByTagName("testsuite") as $s){' +
    'if($s->parentNode&&$s->parentNode->nodeName==="testsuites"){' +
    '$root->appendChild($out->importNode($s,true));' +
    '}}}}' +
    'if($root->childNodes->length>0){$out->save("/tmp/ck-ab.xml");}';

  lines.push(`php -r ${shellQuote(phpMerge)}`);
  lines.push('exit "$rc"');
  return ['sh', '-c', lines.join('; ')];
}

function buildProofOfFixFilterArgs(
  targetFiles: string[],
  diffFiles: DiffFile[],
  addedTestMethods: AddedTestMethod[],
): string[] {
  if (targetFiles.length !== 1) return [];
  return buildPerFileFilterArgs(targetFiles[0]!, diffFiles, addedTestMethods);
}

function stripFilterArgs(cmd: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < cmd.length; i++) {
    if (cmd[i] === '--filter' && i + 1 < cmd.length) {
      i += 1;
      continue;
    }
    out.push(cmd[i]!);
  }
  return out;
}

function isMountableCorePath(filePath: string): boolean {
  if (!filePath || filePath.startsWith('/') || filePath.includes('..')) return false;
  return /^(CRM|Civi|api|ext|schema|sql|templates|xml|ang|css|js|mixin|packages|tests)\//.test(
    filePath,
  );
}

function isCoreTestPath(filePath: string): boolean {
  return (
    filePath.startsWith('tests/') ||
    /^ext\/[^/]+(?:\/[^/]+)*\/tests\//.test(filePath)
  );
}

function formatAbOutputSnippet(stdout: string, stderr: string, exitCode: number): string {
  const outTrim = stdout.trim();
  const errTrim = stderr
    .split(/\r?\n/)
    .filter(
      (line) =>
        !/^\s*(?:Network|Container)\s+\S+\s+(?:Creating|Created|Starting|Started|Waiting|Healthy|Running|Stopping|Stopped|Removing|Removed)\b/.test(
          line,
        ),
    )
    .join('\n')
    .trim();
  if (exitCode !== 0 && errTrim) {
    if (!outTrim) return errTrim.slice(0, 4000);
    return `${outTrim}\n[stderr]\n${errTrim}`.slice(0, 4000);
  }
  return (stdout || errTrim || stderr).slice(0, 4000);
}

function isUnsupportedCkFlagError(
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

function extractKeyValueFromOutput(
  stdout: string,
  stderr: string,
  key: string,
): string | undefined {
  const combined = `${stdout}\n${stderr}`;
  const re = new RegExp(`(?:^|\\s)${key}=([^\\s"']+)`, 'm');
  const match = combined.match(re);
  return match?.[1]?.trim();
}

function copyScreenshotIfSafe(
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
    (c) =>
      (c === allowedBase || c.startsWith(allowedBase + sep)) && existsSync(c),
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

export interface RunCiviKitchenAbOptions {
  repoRoot: string;
  repoInfo: RepoInfo;
  baseSha: string;
  headSha: string;
  prNumber?: number;
  baseBranch?: string;
  diffFiles: DiffFile[];
  abConfig: AbConfig;
  checksConfig?: ChecksConfig;
  browserConfig?: BrowserConfig;
  reviewConfig?: ReviewSettings;
  prBody?: string;
  outputDir?: string;
  execFn?: ExecFn;
  worktreeBaseDir?: string;
}

export interface CiviKitchenAbOutcome {
  abReport: AbRunReport;
  staticDelta: StaticDeltaReport;
  urls?: { A?: string; B?: string };
  composeFiles?: { A?: string; B?: string };
  workDir?: string;
  cleanup: () => Promise<void>;
}

/**
 * Orchestrates CiviKitchen A/B verification for CiviCRM Core PRs and Extension PRs,
 * creating temporary git worktrees under `$HOME` (for Docker bind-mount compatibility)
 * and cleaning them up in a guaranteed `finally` block (or via `cleanup()` when kept alive).
 */
export async function runCiviKitchenAb(
  options: RunCiviKitchenAbOptions,
): Promise<CiviKitchenAbOutcome> {
  const execFn = options.execFn ?? defaultExec;
  const { repoRoot, repoInfo, baseSha, headSha, diffFiles, abConfig } = options;

  const checksConfig = options.checksConfig ?? ChecksConfigSchema.parse({});
  const browserConfig = options.browserConfig ?? BrowserConfigSchema.parse({});
  const reviewConfig = options.reviewConfig ?? ReviewSettingsSchema.parse({});
  const effectiveCfg = {
    ab: abConfig,
    checks: checksConfig,
    review: reviewConfig,
  };

  let surfaceDiff = computeSurfaceDiff(diffFiles, repoInfo);
  const notVerified = [...surfaceDiff.unverifiedSurfaces];
  const imageA = repoInfo.recommendedImage;
  const imageB = repoInfo.recommendedImage;

  const emptyStatic: StaticDeltaReport = {
    executed: false,
    toolsRun: [],
    findings: [],
    summary: 'Static delta check did not run.',
  };
  const noopCleanup = async () => {};

  if (!abConfig.enabled) {
    notVerified.push('CiviKitchen A/B verification disabled by config (--no-ab).');
    return {
      abReport: {
        executed: false,
        imageA,
        imageB,
        checks: [],
        surfaceDiff,
        demoConsoleErrors: [],
        notVerified,
      },
      staticDelta: emptyStatic,
      cleanup: noopCleanup,
    };
  }

  const dockerInfo = await execFn(['docker', 'info'], { timeoutMs: 10_000 });
  if (dockerInfo.exitCode !== 0) {
    notVerified.push(
      'Docker daemon unavailable; live CiviKitchen A/B execution skipped.',
    );
    return {
      abReport: {
        executed: false,
        imageA,
        imageB,
        checks: [],
        surfaceDiff,
        demoConsoleErrors: [],
        notVerified,
      },
      staticDelta: emptyStatic,
      cleanup: noopCleanup,
    };
  }

  const ck = await resolveCkCommand(abConfig, execFn);
  if (!ck) {
    notVerified.push(
      'ck CLI not found and Docker unavailable; live A/B checks skipped.',
    );
    return {
      abReport: {
        executed: false,
        imageA,
        imageB,
        checks: [],
        surfaceDiff,
        demoConsoleErrors: [],
        notVerified,
      },
      staticDelta: emptyStatic,
      cleanup: noopCleanup,
    };
  }

  // Create worktrees inside $HOME by default so macOS Colima / Docker Desktop can bind-mount them
  const tmpBaseParent =
    options.worktreeBaseDir ??
    process.env.CIVIREVIEW_WORKTREE_DIR ??
    join(homedir(), '.civireview-worktrees');
  mkdirSync(tmpBaseParent, { recursive: true });
  const workDir = mkdtempSync(join(tmpBaseParent, 'run-'));
  const worktreeA = join(workDir, 'A');
  const worktreeB = join(workDir, 'B');
  const outRoot = join(workDir, 'out');
  mkdirSync(outRoot, { recursive: true });

  const checks: AbCheckResult[] = [];
  const staticFindings: StaticDeltaFinding[] = [];
  const toolsRun: string[] = [];
  let demoArtifactsDir: string | undefined;
  const demoConsoleErrors: string[] = [];
  let browserDiff: BrowserDiffReport | undefined;
  let keptUrls: { A?: string; B?: string } | undefined;
  let keptComposeFiles: { A?: string; B?: string } | undefined;

  const interactiveBrowser = isCheckEnabled(effectiveCfg, 'interactive-browser');
  const liveProve = isCheckEnabled(effectiveCfg, 'live-prove');
  const keepLive = abConfig.keepStacks || interactiveBrowser || liveProve;
  const wantSurface = isCheckEnabled(effectiveCfg, 'surface');

  let worktreesCreated = false;

  try {
    let wtA = await execFn(
      ['git', '-C', repoRoot, 'worktree', 'add', '--detach', worktreeA, baseSha],
      { timeoutMs: 60_000 },
    );
    let wtB = await execFn(
      ['git', '-C', repoRoot, 'worktree', 'add', '--detach', worktreeB, headSha],
      { timeoutMs: 60_000 },
    );

    // If a new PR commit or force-push head/base SHA is not yet in the local clone,
    // fetch the PR head and base branch without touching the local working tree.
    if (
      (wtA.exitCode !== 0 || wtB.exitCode !== 0) &&
      options.prNumber &&
      options.prNumber > 0
    ) {
      const fetchRefs = [`pull/${options.prNumber}/head`];
      if (options.baseBranch && /^[A-Za-z0-9._/-]+$/.test(options.baseBranch)) {
        fetchRefs.push(options.baseBranch);
      }
      if (wtA.exitCode !== 0 && /^[0-9a-f]{7,40}$/i.test(baseSha)) {
        fetchRefs.push(baseSha);
      }
      await execFn(
        ['git', '-C', repoRoot, 'fetch', '--no-tags', 'origin', ...fetchRefs],
        { timeoutMs: 120_000 },
      );
      if (wtA.exitCode !== 0) {
        wtA = await execFn(
          ['git', '-C', repoRoot, 'worktree', 'add', '--detach', worktreeA, baseSha],
          { timeoutMs: 60_000 },
        );
      }
      if (wtB.exitCode !== 0) {
        wtB = await execFn(
          ['git', '-C', repoRoot, 'worktree', 'add', '--detach', worktreeB, headSha],
          { timeoutMs: 60_000 },
        );
      }
    }

    if (wtA.exitCode !== 0 || wtB.exitCode !== 0) {
      notVerified.push(
        `Could not materialize git worktrees for ${baseSha} and ${headSha}: ${wtA.stderr || wtB.stderr}`,
      );
      return {
        abReport: {
          executed: false,
          ckCommand: ck.label,
          imageA,
          imageB,
          checks: [],
          surfaceDiff,
          demoConsoleErrors,
          notVerified,
        },
        staticDelta: emptyStatic,
        cleanup: noopCleanup,
      };
    }
    worktreesCreated = true;

    const touchedTestFiles = diffFiles
      .filter(
        (f) => f.flags.isTest && f.status !== 'deleted' && /Test\.php$/i.test(f.path),
      )
      .map((f) => f.path);
    const addedTestMethods = extractAddedTestMethods(diffFiles);
    const hasProductionCodeChange = diffFiles.some(
      (f) => !f.flags.isTest && !f.flags.isDocsOnly,
    );
    const uiTouched = diffFiles.some((f) => f.flags.isFrontendAsset);

    const runAbInvocation = async (
      name: string,
      imgA: string,
      imgB: string,
      mounts: string[],
      innerCmd: string[],
      extraFlags: string[] = [],
    ): Promise<{ check: AbCheckResult; subOut: string; stdout: string; stderr: string }> => {
      const subOut = join(outRoot, name);
      mkdirSync(subOut, { recursive: true });
      const jsonReportPath = join(subOut, 'ab-report.json');
      const surfaceDiffPath = join(subOut, 'surface-diff.json');
      const abName = buildCkAbName(workDir, name);

      let effectiveInnerCmd = innerCmd;
      const buildArgs = (
        withJsonAndSurface: boolean,
        withName: boolean,
        cmd: string[],
      ): string[] => [
        ...ck.command,
        'ab',
        imgA,
        imgB,
        ...mounts,
        '--out',
        subOut,
        ...(withName ? ['--name', abName] : []),
        ...(withJsonAndSurface
          ? ['--json', jsonReportPath, ...(wantSurface ? ['--surface'] : [])]
          : []),
        ...extraFlags,
        ...(abConfig.keepStacks && !extraFlags.includes('--keep')
          ? ['--keep']
          : []),
        '--',
        ...cmd,
      ];

      let withJsonAndSurface = true;
      let withName = true;
      let args = buildArgs(withJsonAndSurface, withName, effectiveInnerCmd);
      let res = await execFn(args, { timeoutMs: 600_000 });

      for (let attempt = 0; attempt < 2; attempt++) {
        if (existsSync(jsonReportPath)) break;
        const rejectedName =
          withName &&
          isUnsupportedCkFlagError(res.exitCode, res.stdout, res.stderr, /--name/i);
        const rejectedJson =
          withJsonAndSurface &&
          isUnsupportedCkFlagError(
            res.exitCode,
            res.stdout,
            res.stderr,
            /--json|--surface/i,
          );
        if (!rejectedName && !rejectedJson) break;
        if (rejectedName) withName = false;
        if (rejectedJson) withJsonAndSurface = false;
        args = buildArgs(withJsonAndSurface, withName, effectiveInnerCmd);
        res = await execFn(args, { timeoutMs: 600_000 });
      }

      // If a PHPUnit --filter matched zero test cases (e.g., inherited/renamed test),
      // retry once without --filter so Proof-of-Fix still executes the full test file.
      if (
        res.exitCode !== 0 &&
        !existsSync(jsonReportPath) &&
        effectiveInnerCmd.includes('--filter') &&
        /holds no test case/i.test(`${res.stderr}\n${res.stdout}`)
      ) {
        effectiveInnerCmd = stripFilterArgs(effectiveInnerCmd);
        args = buildArgs(withJsonAndSurface, withName, effectiveInnerCmd);
        res = await execFn(args, { timeoutMs: 600_000 });
      }

      const isProofOfFix = name === 'proof-of-fix';

      if (existsSync(jsonReportPath)) {
        try {
          const rawJson = readFileSync(jsonReportPath, 'utf8');
          const parsedJson = parseCkAbJsonReport(rawJson);

          let liveSurface = parsedJson.surfaceDiff;
          if (!liveSurface && existsSync(surfaceDiffPath)) {
            const rawSurf = JSON.parse(readFileSync(surfaceDiffPath, 'utf8'));
            const surfRes = LiveSurfaceDiffSchema.safeParse(rawSurf);
            if (surfRes.success) liveSurface = surfRes.data;
          }
          if (liveSurface && !surfaceDiff.liveSurfaceDiff) {
            surfaceDiff = mergeLiveSurfaceDiff(surfaceDiff, liveSurface);
          }

          if (parsedJson.urls) {
            keptUrls = { ...keptUrls, ...parsedJson.urls };
          }
          if (parsedJson.composeFiles) {
            keptComposeFiles = { ...keptComposeFiles, ...parsedJson.composeFiles };
          }

          const tautologicalTests: TautologicalTest[] = [];
          if (
            isProofOfFix &&
            hasProductionCodeChange &&
            addedTestMethods.length > 0
          ) {
            for (const added of addedTestMethods) {
              const wasFixed = parsedJson.fixed.some((tc) =>
                matchesPhpUnitMethod(tc, added.method),
              );
              if (wasFixed) continue;
              const matchedPassedBoth = parsedJson.passedBoth.find((tc) =>
                matchesPhpUnitMethod(tc, added.method),
              );
              if (matchedPassedBoth) {
                tautologicalTests.push({
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

          const status: AbCheckResult['status'] =
            parsedJson.regressions.length > 0
              ? 'FAIL'
              : bootstrapCrash
                ? 'ERROR'
                : effectiveExit === 0
                  ? 'PASS'
                  : parsedJson.mode === 'exit-status' && effectiveExit === 1
                    ? 'FAIL'
                    : 'ERROR';

          const tautSummary =
            tautologicalTests.length > 0
              ? `${tautologicalTests.length} added test method(s) PASSED on unfixed base A (tautological: ${tautologicalTests.map((t) => t.method).join(', ')})`
              : undefined;

          const baseSummary =
            parsedJson.regressions.length > 0
              ? `${parsedJson.regressions.length} regression(s) (pass on A, fail on B)`
              : bootstrapCrash
                ? `0 tests passed on A or B (${parsedJson.bothFail.length} error/failure on both, ${(parsedJson.counts?.a ?? 0) - parsedJson.bothFail.length} skipped — likely bootstrap/setup crash)`
                : parsedJson.fixed.length > 0
                  ? `${parsedJson.fixed.length} test(s) red on A, green on B`
                  : parsedJson.mode === 'exit-status' &&
                      parsedJson.exitCodeA !== undefined &&
                      parsedJson.exitCodeB !== undefined
                    ? `exit-status mode: A=${parsedJson.exitCodeA}, B=${parsedJson.exitCodeB}`
                    : tautSummary
                      ? tautSummary
                      : parsedJson.passedBoth.length > 0 &&
                          parsedJson.bothFail.length === 0
                        ? `${parsedJson.passedBoth.length} test(s) passed on A and B`
                        : `ck ab (${parsedJson.mode}) exited with ${effectiveExit}`;

          const summary =
            tautSummary && baseSummary !== tautSummary
              ? `${baseSummary}; ${tautSummary}`
              : baseSummary;

          const anyNonZeroExit =
            effectiveExit !== 0 ||
            (parsedJson.exitCodeA ?? 0) !== 0 ||
            (parsedJson.exitCodeB ?? 0) !== 0;

          return {
            subOut,
            stdout: res.stdout,
            stderr: res.stderr,
            check: {
              name,
              command: args.join(' '),
              imageA: imgA,
              imageB: imgB,
              status,
              mode: parsedJson.mode,
              exitCodeA: parsedJson.exitCodeA,
              exitCodeB: parsedJson.exitCodeB,
              fixed: parsedJson.fixed,
              regressions: parsedJson.regressions,
              bothFail: parsedJson.bothFail,
              gone: parsedJson.gone,
              onlyOnB: parsedJson.onlyOnB,
              passedBoth: parsedJson.passedBoth,
              tautologicalTests,
              addedTestMethods: isProofOfFix ? addedTestMethods : [],
              counts: parsedJson.counts,
              summary,
              outputSnippet: formatAbOutputSnippet(
                res.stdout,
                res.stderr,
                anyNonZeroExit ? 1 : 0,
              ),
            },
          };
        } catch {
          // Fall through to stdout parsing if JSON file was malformed
        }
      }

      if (!surfaceDiff.liveSurfaceDiff && existsSync(surfaceDiffPath)) {
        try {
          const rawSurf = JSON.parse(readFileSync(surfaceDiffPath, 'utf8'));
          const surfRes = LiveSurfaceDiffSchema.safeParse(rawSurf);
          if (surfRes.success) {
            surfaceDiff = mergeLiveSurfaceDiff(surfaceDiff, surfRes.data);
          }
        } catch {
          // Ignore malformed surface-diff.json
        }
      }

      const parsed = parseCkAbOutput(res.stdout);
      const status: AbCheckResult['status'] =
        res.exitCode === 0
          ? 'PASS'
          : parsed.regressions.length > 0
            ? 'FAIL'
            : 'ERROR';
      return {
        subOut,
        stdout: res.stdout,
        stderr: res.stderr,
        check: {
          name,
          command: args.join(' '),
          imageA: imgA,
          imageB: imgB,
          status,
          exitCodeA: parsed.exitCodeA,
          exitCodeB: parsed.exitCodeB,
          fixed: parsed.fixed,
          regressions: parsed.regressions,
          bothFail: parsed.bothFail,
          gone: parsed.gone,
          passedBoth: [],
          tautologicalTests: [],
          addedTestMethods: isProofOfFix ? addedTestMethods : [],
          summary:
            parsed.regressions.length > 0
              ? `${parsed.regressions.length} regression(s) (pass on A, fail on B)`
              : parsed.fixed.length > 0
                ? `${parsed.fixed.length} test(s) red on A, green on B`
                : `ck ab exited with ${res.exitCode}`,
          outputSnippet: formatAbOutputSnippet(res.stdout, res.stderr, res.exitCode),
        },
      };
    };

    // Build shared mounts per repo kind
    let abMounts: string[] = [];
    let mountsAOnly: string[] = [];
    let mountsBOnly: string[] = [];

    if (repoInfo.kind === 'civicrm-core') {
      // Prefer surgical per-file bind mounts for core PRs so we never clobber
      // image-generated GenCode files or create CRM/ vs Civi/ commit skew against
      // the cached standalone-master container image.
      const mountableCoreFiles = diffFiles.filter((f) => isMountableCorePath(f.path));
      const coreProdFiles = mountableCoreFiles.filter((f) => !isCoreTestPath(f.path));
      const coreTestFiles = mountableCoreFiles.filter((f) => isCoreTestPath(f.path));
      const hasDeletedCoreFile = mountableCoreFiles.some(
        (f) => f.status === 'deleted' || f.status === 'renamed',
      );
      const allFilesMaterialized = mountableCoreFiles.every((f) =>
        f.status === 'added'
          ? existsSync(join(worktreeB, f.path))
          : existsSync(join(worktreeA, f.path)) && existsSync(join(worktreeB, f.path)),
      );
      const useFileMounts =
        mountableCoreFiles.length > 0 &&
        mountableCoreFiles.length <= 40 &&
        !hasDeletedCoreFile &&
        allFilesMaterialized;

      let proofTestMounts: string[] = [];
      let baseTestMounts: string[] = [];

      if (useFileMounts) {
        for (const f of coreProdFiles) {
          if (existsSync(join(worktreeA, f.path))) {
            abMounts.push(
              '--mount-a',
              `${join(worktreeA, f.path)}:/var/www/html/core/${f.path}:ro`,
            );
            mountsAOnly.push(
              '--mount',
              `${join(worktreeA, f.path)}:/var/www/html/core/${f.path}:ro`,
            );
          }
          if (existsSync(join(worktreeB, f.path))) {
            abMounts.push(
              '--mount-b',
              `${join(worktreeB, f.path)}:/var/www/html/core/${f.path}:ro`,
            );
            mountsBOnly.push(
              '--mount',
              `${join(worktreeB, f.path)}:/var/www/html/core/${f.path}:ro`,
            );
          }
        }
        for (const f of coreTestFiles) {
          if (existsSync(join(worktreeB, f.path))) {
            proofTestMounts.push(
              '--mount',
              `${join(worktreeB, f.path)}:/var/www/html/core/${f.path}:ro`,
            );
          }
          if (existsSync(join(worktreeA, f.path))) {
            baseTestMounts.push(
              '--mount',
              `${join(worktreeA, f.path)}:/var/www/html/core/${f.path}:ro`,
            );
          }
        }
      } else {
        const dirs = new Set(surfaceDiff.touchedComponents);
        // Keep CRM/ and Civi/ in lockstep when falling back to directory mounts
        if (dirs.has('CRM') || dirs.has('Civi')) {
          dirs.add('CRM');
          dirs.add('Civi');
        }
        for (const dir of dirs) {
          if (existsSync(join(worktreeA, dir))) {
            abMounts.push('--mount-a', `${join(worktreeA, dir)}:/var/www/html/core/${dir}:ro`);
            mountsAOnly.push('--mount', `${join(worktreeA, dir)}:/var/www/html/core/${dir}:ro`);
          }
          if (existsSync(join(worktreeB, dir))) {
            abMounts.push('--mount-b', `${join(worktreeB, dir)}:/var/www/html/core/${dir}:ro`);
            mountsBOnly.push('--mount', `${join(worktreeB, dir)}:/var/www/html/core/${dir}:ro`);
          }
        }
        if (existsSync(join(worktreeB, 'tests'))) {
          proofTestMounts = [
            '--mount',
            `${join(worktreeB, 'tests')}:/var/www/html/core/tests:ro`,
          ];
        }
        if (existsSync(join(worktreeA, 'tests'))) {
          baseTestMounts = [
            '--mount',
            `${join(worktreeA, 'tests')}:/var/www/html/core/tests:ro`,
          ];
        }
      }

      if (isCheckEnabled(effectiveCfg, 'ab-tests')) {
        if (touchedTestFiles.length > 0 && (useFileMounts || existsSync(join(worktreeB, 'tests')))) {
          const proofTargets = touchedTestFiles.slice(0, 5);
          const proofCmd = buildMultiTargetTestCommand(
            'ckcoretest',
            proofTargets.map((targetPath) => ({
              path: targetPath,
              filterArgs: buildPerFileFilterArgs(
                targetPath,
                diffFiles,
                addedTestMethods,
                worktreeB,
              ),
            })),
          );
          const { check } = await runAbInvocation(
            'proof-of-fix',
            imageA,
            imageB,
            [...proofTestMounts, ...abMounts],
            proofCmd,
          );
          checks.push(check);
        } else {
          notVerified.push(
            'No added/modified PHPUnit tests in PR; Proof-of-Fix A/B test skipped.',
          );
        }

        const regressionTargets = deriveRegressionTargets(diffFiles, worktreeA);
        if (regressionTargets.length > 0 && (useFileMounts || existsSync(join(worktreeA, 'tests')))) {
          const regressionCmd = buildMultiTargetTestCommand(
            'ckcoretest',
            regressionTargets.map((targetPath) => ({ path: targetPath })),
          );
          const { check } = await runAbInvocation(
            'base-test-regression',
            imageA,
            imageB,
            [...baseTestMounts, ...abMounts],
            regressionCmd,
          );
          checks.push(check);
        }
      }

      if (abConfig.runDemo && uiTouched) {
        const demoOut = join(outRoot, 'demo');
        mkdirSync(demoOut, { recursive: true });
        const diffRes = await execFn(
          ['git', '-C', repoRoot, 'diff', baseSha, headSha],
          { timeoutMs: 30_000 },
        );
        const patchFile = join(workDir, 'pr.patch');
        await Bun.write(patchFile, diffRes.stdout);
        const demoRes = await execFn(
          [...ck.command, 'demo', patchFile, '--out', demoOut],
          { timeoutMs: 300_000 },
        );
        if (demoRes.exitCode === 0) {
          demoArtifactsDir = demoOut;
        } else {
          notVerified.push(`ck demo exited with ${demoRes.exitCode}`);
        }
      }
    } else if (repoInfo.kind === 'civicrm-extension') {
      const extName = repoInfo.extensionName ?? 'myext';
      abMounts = [
        '--mount-a',
        `${worktreeA}:/var/www/html/ext/${extName}:ro`,
        '--mount-b',
        `${worktreeB}:/var/www/html/ext/${extName}:ro`,
      ];
      mountsAOnly = ['--mount', `${worktreeA}:/var/www/html/ext/${extName}:ro`];
      mountsBOnly = ['--mount', `${worktreeB}:/var/www/html/ext/${extName}:ro`];

      if (isCheckEnabled(effectiveCfg, 'ab-tests')) {
        const existingBTests = touchedTestFiles.filter((tf) =>
          existsSync(join(worktreeB, tf)),
        );
        if (existingBTests.length > 0) {
          // Bind-mount each added/modified test file from worktreeB into Stack A too
          // so brand-new PR tests execute on BOTH A and B (true red-on-A / green-on-B).
          const proofMounts = [...abMounts];
          for (const tf of existingBTests) {
            proofMounts.push(
              '--mount-a',
              `${join(worktreeB, tf)}:/var/www/html/ext/${extName}/${tf}:ro`,
            );
          }
          const extProofTargets = existingBTests.slice(0, 5);
          const extProofCmd = buildMultiTargetTestCommand(
            'phpunit',
            extProofTargets.map((tf) => ({
              path: `/var/www/html/ext/${extName}/${tf}`,
              filterArgs: buildPerFileFilterArgs(
                tf,
                diffFiles,
                addedTestMethods,
                worktreeB,
              ),
            })),
          );

          const { check } = await runAbInvocation(
            'proof-of-fix',
            imageA,
            imageB,
            proofMounts,
            extProofCmd,
          );
          checks.push(check);
        } else {
          notVerified.push(
            'No added/modified PHPUnit tests in PR; Proof-of-Fix A/B test skipped.',
          );
        }

        if (existsSync(join(worktreeA, 'tests/phpunit'))) {
          const { check } = await runAbInvocation(
            'base-test-regression',
            imageA,
            imageB,
            abMounts,
            [
              'phpunit',
              '--log-junit',
              '/tmp/ck-ab.xml',
              `/var/www/html/ext/${extName}/tests/phpunit`,
            ],
          );
          checks.push(check);
        }
      }

      if (isCheckEnabled(effectiveCfg, 'matrix') && imageA !== 'standalone-beta') {
        const { check } = await runAbInvocation(
          'floor-vs-beta-matrix',
          imageA,
          'standalone-beta',
          ['--mount', `${worktreeB}:/var/www/html/ext/${extName}:ro`],
          [
            'phpunit',
            '--log-junit',
            '/tmp/ck-ab.xml',
            `/var/www/html/ext/${extName}/tests/phpunit`,
          ],
        );
        checks.push(check);
      }
    } else {
      notVerified.push(
        'Repository is generic (neither civicrm-core nor civicrm-extension); CiviKitchen A/B skipped.',
      );
    }

    // Static delta (`ck taint` A vs B), lifecycle/schema (`ck lifecycle`, `ck schema`), and Standalone Browser A/B
    if (repoInfo.kind === 'civicrm-core' || repoInfo.kind === 'civicrm-extension') {
      if (
        repoInfo.kind === 'civicrm-extension' &&
        isCheckEnabled(effectiveCfg, 'static-delta') &&
        mountsAOnly.length > 0 &&
        mountsBOnly.length > 0
      ) {
        const taintA = await execFn(
          [...ck.command, 'run', imageA, ...mountsAOnly, '--', 'ck', 'taint'],
          { timeoutMs: 180_000 },
        );
        const taintB = await execFn(
          [...ck.command, 'run', imageB, ...mountsBOnly, '--', 'ck', 'taint'],
          { timeoutMs: 180_000 },
        );

        if (
          isUnsupportedCkFlagError(taintA.exitCode, taintA.stdout, taintA.stderr, /\btaint\b/i) ||
          isUnsupportedCkFlagError(taintB.exitCode, taintB.stdout, taintB.stderr, /\btaint\b/i) ||
          /runs in the dev stack/i.test(`${taintA.stderr}\n${taintB.stderr}`)
        ) {
          notVerified.push('Installed ck CLI does not support `ck taint`; static taint delta skipped.');
        } else {
          toolsRun.push('cktaint');
          const itemsA = parseTaintFindings(taintA.stdout || taintA.stderr);
          const itemsB = parseTaintFindings(taintB.stdout || taintB.stderr);
          const keysA = new Set(itemsA.map((item) => item.key));
          const newOnB = itemsB.filter((item) => !keysA.has(item.key));

          for (const item of newOnB) {
            staticFindings.push({
              tool: 'cktaint',
              severity: item.severity,
              path: item.path,
              line: item.line,
              message: item.message,
              isNewOnHead: true,
            });
          }

          if (
            newOnB.length === 0 &&
            taintB.exitCode !== 0 &&
            taintA.exitCode === 0 &&
            (taintB.stdout || taintB.stderr).trim()
          ) {
            staticFindings.push({
              tool: 'cktaint',
              severity: 'warning',
              message: (taintB.stdout || taintB.stderr).trim().slice(0, 1500),
              isNewOnHead: true,
            });
          }
        }
      }

      if (isCheckEnabled(effectiveCfg, 'lifecycle')) {
        const needsLifecycle = diffFiles.some(
          (f) => f.flags.isUpgrade || f.flags.isSchema || f.flags.isManaged,
        );
        const needsSchema = diffFiles.some(
          (f) => f.flags.isSchema || f.flags.isUpgrade,
        );

        if (
          repoInfo.kind === 'civicrm-extension' &&
          (needsLifecycle || reviewConfig.include.includes('lifecycle')) &&
          mountsBOnly.length > 0
        ) {
          const lcRes = await execFn(
            [...ck.command, 'run', imageB, ...mountsBOnly, '--', 'ck', 'lifecycle'],
            { timeoutMs: 180_000 },
          );
          if (
            isUnsupportedCkFlagError(lcRes.exitCode, lcRes.stdout, lcRes.stderr, /\blifecycle\b/i) ||
            /runs in the dev stack/i.test(lcRes.stderr)
          ) {
            notVerified.push('Installed ck CLI does not support `ck lifecycle`; lifecycle check skipped.');
          } else {
            toolsRun.push('cklifecycle');
            if (lcRes.exitCode !== 0) {
              staticFindings.push({
                tool: 'cklifecycle',
                severity: 'error',
                message: (lcRes.stdout || lcRes.stderr).trim().slice(0, 1500) || `ck lifecycle exited with ${lcRes.exitCode}`,
                isNewOnHead: true,
              });
            }
          }
        }

        if (repoInfo.kind === 'civicrm-extension' && needsSchema && mountsBOnly.length > 0) {
          const schemaRes = await execFn(
            [...ck.command, 'run', imageB, ...mountsBOnly, '--', 'ck', 'schema'],
            { timeoutMs: 180_000 },
          );
          if (
            isUnsupportedCkFlagError(schemaRes.exitCode, schemaRes.stdout, schemaRes.stderr, /\bschema\b/i) ||
            /runs in the dev stack/i.test(schemaRes.stderr)
          ) {
            notVerified.push('Installed ck CLI does not support `ck schema`; schema check skipped.');
          } else {
            toolsRun.push('ckschema');
            if (schemaRes.exitCode !== 0) {
              staticFindings.push({
                tool: 'ckschema',
                severity: 'error',
                message: (schemaRes.stdout || schemaRes.stderr).trim().slice(0, 1500) || `ck schema exited with ${schemaRes.exitCode}`,
                isNewOnHead: true,
              });
            }
          }
        }
      }

      // Standalone Browser A/B Verification (ON by default when UI routes/assets exist)
      const browserEnabled = isCheckEnabled(effectiveCfg, 'browser');
      const a11yEnabled = isCheckEnabled(effectiveCfg, 'a11y');
      const routes = browserEnabled
        ? discoverStandaloneRoutes({
            diffFiles,
            surfaceDiff,
            prBody: options.prBody,
            config: { browser: browserConfig },
          })
        : { pages: [], anonymousPages: [], reason: 'browser check disabled' };

      const hasRoutes = routes.pages.length > 0 || routes.anonymousPages.length > 0;
      if ((browserEnabled && hasRoutes) || interactiveBrowser || liveProve) {
        const subOut = join(outRoot, 'browser-ab');
        mkdirSync(subOut, { recursive: true });
        const jsonReportPath = join(subOut, 'ab-report.json');
        const browserDiffPath = join(subOut, 'browser-diff.json');
        const surfaceDiffPath = join(subOut, 'surface-diff.json');

        const browserAbName = buildCkAbName(workDir, 'browser-ab');
        const buildBrowserArgs = (withName: boolean): string[] => [
          ...ck.command,
          'ab',
          imageA,
          imageB,
          ...abMounts,
          '--out',
          subOut,
          ...(withName ? ['--name', browserAbName] : []),
          '--json',
          jsonReportPath,
          ...(wantSurface ? ['--surface'] : []),
          ...routes.pages.flatMap((p) => ['--page', p]),
          ...routes.anonymousPages.flatMap((p) => ['--anon-page', p]),
          ...(!a11yEnabled ? ['--no-a11y'] : []),
          '--expose',
          ...(keepLive ? ['--keep'] : []),
          '--',
          'true',
        ];

        let browserRes = await execFn(buildBrowserArgs(true), { timeoutMs: 300_000 });
        if (
          !existsSync(jsonReportPath) &&
          !existsSync(browserDiffPath) &&
          isUnsupportedCkFlagError(
            browserRes.exitCode,
            browserRes.stdout,
            browserRes.stderr,
            /--name/i,
          )
        ) {
          browserRes = await execFn(buildBrowserArgs(false), { timeoutMs: 300_000 });
        }

        if (
          !existsSync(jsonReportPath) &&
          !existsSync(browserDiffPath) &&
          isUnsupportedCkFlagError(
            browserRes.exitCode,
            browserRes.stdout,
            browserRes.stderr,
            /--page|--anon-page|--no-a11y|--expose/i,
          )
        ) {
          notVerified.push(
            'Installed ck CLI does not support --page/--expose Standalone browser A/B flags; browser diff skipped.',
          );
        } else {
          let parsedJson: ParsedCkAbJsonReport | undefined;
          if (existsSync(jsonReportPath)) {
            try {
              parsedJson = parseCkAbJsonReport(
                readFileSync(jsonReportPath, 'utf8'),
              );
              if (parsedJson.surfaceDiff && !surfaceDiff.liveSurfaceDiff) {
                surfaceDiff = mergeLiveSurfaceDiff(
                  surfaceDiff,
                  parsedJson.surfaceDiff,
                );
              }
              if (parsedJson.urls) {
                keptUrls = { ...keptUrls, ...parsedJson.urls };
              }
              if (parsedJson.composeFiles) {
                keptComposeFiles = {
                  ...keptComposeFiles,
                  ...parsedJson.composeFiles,
                };
              }
              if (parsedJson.browserDiff) {
                browserDiff = parsedJson.browserDiff;
              }
            } catch {
              // Ignore malformed ab-report.json
            }
          }

          if (!surfaceDiff.liveSurfaceDiff && existsSync(surfaceDiffPath)) {
            try {
              const surfRes = LiveSurfaceDiffSchema.safeParse(
                JSON.parse(readFileSync(surfaceDiffPath, 'utf8')),
              );
              if (surfRes.success) {
                surfaceDiff = mergeLiveSurfaceDiff(surfaceDiff, surfRes.data);
              }
            } catch {
              // Ignore malformed surface-diff.json
            }
          }

          if (!browserDiff && existsSync(browserDiffPath)) {
            try {
              const bdRes = BrowserDiffReportSchema.safeParse(
                JSON.parse(readFileSync(browserDiffPath, 'utf8')),
              );
              if (bdRes.success) {
                browserDiff = bdRes.data;
              }
            } catch {
              // Ignore malformed browser-diff.json
            }
          }

          // Parse exposed URLs and compose file paths from stdout/stderr if not in JSON
          const envUrlA = validateLocalhostUrl(
            extractKeyValueFromOutput(browserRes.stdout, browserRes.stderr, 'A_URL'),
          );
          const envUrlB = validateLocalhostUrl(
            extractKeyValueFromOutput(browserRes.stdout, browserRes.stderr, 'B_URL'),
          );
          if (envUrlA || envUrlB) {
            keptUrls = {
              A: envUrlA ?? keptUrls?.A,
              B: envUrlB ?? keptUrls?.B,
            };
          }

          const envComposeA = extractKeyValueFromOutput(
            browserRes.stdout,
            browserRes.stderr,
            'COMPOSE_A',
          );
          const envComposeB = extractKeyValueFromOutput(
            browserRes.stdout,
            browserRes.stderr,
            'COMPOSE_B',
          );
          const candidateComposeA =
            keptComposeFiles?.A ??
            envComposeA ??
            (existsSync(join(subOut, 'A.compose.json'))
              ? join(subOut, 'A.compose.json')
              : existsSync(join(subOut, 'compose-a.yml'))
                ? join(subOut, 'compose-a.yml')
                : existsSync(join(subOut, 'docker-compose.a.yml'))
                  ? join(subOut, 'docker-compose.a.yml')
                  : undefined);
          const candidateComposeB =
            keptComposeFiles?.B ??
            envComposeB ??
            (existsSync(join(subOut, 'B.compose.json'))
              ? join(subOut, 'B.compose.json')
              : existsSync(join(subOut, 'compose-b.yml'))
                ? join(subOut, 'compose-b.yml')
                : existsSync(join(subOut, 'docker-compose.b.yml'))
                  ? join(subOut, 'docker-compose.b.yml')
                  : undefined);
          if (candidateComposeA || candidateComposeB) {
            keptComposeFiles = { A: candidateComposeA, B: candidateComposeB };
          }

          if (!browserDiff && browserRes.exitCode !== 0) {
            browserDiff = BrowserDiffReportSchema.parse({
              error:
                (browserRes.stderr || browserRes.stdout).trim().slice(0, 600) ||
                `ck ab browser probe exited with ${browserRes.exitCode}`,
              probedRoutes: routes.pages,
              probedAnonymousRoutes: routes.anonymousPages,
              ...(keptUrls ? { urls: keptUrls } : {}),
            });
          } else if (browserDiff) {
            const destScreenshotsDir = options.outputDir
              ? join(options.outputDir, 'screenshots')
              : undefined;

            const copiedScreenshots = browserDiff.screenshots.map((shot, idx) => {
              const slug = shot.route
                .replace(/[^a-zA-Z0-9_-]+/g, '_')
                .replace(/^_+|_+$/g, '')
                .slice(0, 48);
              const prefix = `${String(idx + 1).padStart(2, '0')}-${slug || 'page'}-${shot.mode}`;
              const beforeRaw = shot.before ?? undefined;
              const afterRaw = shot.after ?? undefined;
              const before = destScreenshotsDir
                ? (copyScreenshotIfSafe(
                    beforeRaw,
                    subOut,
                    workDir,
                    destScreenshotsDir,
                    `${prefix}-before`,
                  ) ?? beforeRaw)
                : beforeRaw;
              const after = destScreenshotsDir
                ? (copyScreenshotIfSafe(
                    afterRaw,
                    subOut,
                    workDir,
                    destScreenshotsDir,
                    `${prefix}-after`,
                  ) ?? afterRaw)
                : afterRaw;
              return { ...shot, before, after };
            });

            browserDiff = {
              ...browserDiff,
              probedRoutes:
                browserDiff.probedRoutes.length > 0
                  ? browserDiff.probedRoutes
                  : routes.pages,
              probedAnonymousRoutes:
                browserDiff.probedAnonymousRoutes.length > 0
                  ? browserDiff.probedAnonymousRoutes
                  : routes.anonymousPages,
              screenshots: copiedScreenshots,
              ...(keptUrls ? { urls: keptUrls } : {}),
            };
          }

          if (browserDiff?.error) {
            notVerified.push(`Standalone browser A/B error: ${browserDiff.error}`);
          }
        }
      }
    }
  } finally {
    if (!keepLive) {
      if (worktreesCreated) {
        await execFn(['git', '-C', repoRoot, 'worktree', 'remove', '--force', worktreeA]);
        await execFn(['git', '-C', repoRoot, 'worktree', 'remove', '--force', worktreeB]);
      }
      rmSync(workDir, { recursive: true, force: true });
    }
  }

  const cleanup = async () => {
    if (!keepLive || abConfig.keepStacks) {
      return;
    }
    try {
      for (const cf of [keptComposeFiles?.A, keptComposeFiles?.B]) {
        if (cf && existsSync(cf)) {
          await execFn(
            ['docker', 'compose', '-f', cf, 'down', '--remove-orphans', '-v'],
            { timeoutMs: 60_000 },
          );
        }
      }
    } finally {
      if (worktreesCreated) {
        await execFn(['git', '-C', repoRoot, 'worktree', 'remove', '--force', worktreeA]);
        await execFn(['git', '-C', repoRoot, 'worktree', 'remove', '--force', worktreeB]);
      }
      rmSync(workDir, { recursive: true, force: true });
    }
  };

  return {
    abReport: {
      executed: checks.length > 0 || browserDiff !== undefined,
      ckCommand: ck.label,
      imageA,
      imageB,
      checks,
      surfaceDiff,
      ...(browserDiff ? { browserDiff } : {}),
      demoArtifactsDir,
      demoConsoleErrors,
      notVerified: Array.from(
        new Set([...notVerified, ...surfaceDiff.unverifiedSurfaces]),
      ),
    },
    staticDelta: {
      executed: toolsRun.length > 0,
      toolsRun,
      findings: staticFindings,
      summary:
        toolsRun.length === 0
          ? 'No static CiviKitchen gates executed.'
          : `Executed [${toolsRun.join(', ')}] with ${staticFindings.length} finding(s).`,
    },
    ...(keptUrls ? { urls: keptUrls } : {}),
    ...(keptComposeFiles ? { composeFiles: keptComposeFiles } : {}),
    ...(keepLive ? { workDir } : {}),
    cleanup,
  };
}
