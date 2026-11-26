import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  isCheckEnabled,
  type AbConfig,
  type BrowserConfig,
  type ChecksConfig,
  type ReviewSettings,
} from '../../config/schema.ts';
import { discoverStandaloneRoutes, readExtensionRouteSources } from '../browser-routes.ts';
import { parseXmlAttr } from '../repo-detect.ts';
import {
  BrowserDiffReportSchema,
  LiveSurfaceDiffSchema,
  type BrowserDiffReport,
  type DiffFile,
  type RepoInfo,
  type StaticDeltaFinding,
  type SurfaceDiffReport,
} from '../types.ts';
import {
  copyScreenshotIfSafe,
  extractKeyValueFromOutput,
  isUnsupportedCkFlagError,
  parseCkAbJsonReport,
  newTaintFindings,
  parseTaintFindings,
  validateLocalhostUrl,
  type ExecFn,
  type ParsedCkAbJsonReport,
} from './parsers.ts';
import { mergeLiveSurfaceDiff } from './surface-diff.ts';
import { buildCkAbName } from './test-targets.ts';

export interface StaticLifecycleContext {
  execFn: ExecFn;
  ckCommand: string[];
  workDir: string;
  repoInfo: RepoInfo;
  diffFiles: DiffFile[];
  imageA: string;
  imageB: string;
  worktreeA: string;
  worktreeB: string;
  mountsAOnly: string[];
  mountsBOnly: string[];
  effectiveCfg: {
    ab: AbConfig;
    checks: ChecksConfig;
    review: ReviewSettings;
  };
  toolsRun: string[];
  staticFindings: StaticDeltaFinding[];
  notVerified: string[];
}

/** One extension the gates run against: a whole extension repo or a bundled core extension. */
export interface ExtensionTarget {
  key: string;
  containerDir: string;
  // Host directories holding the extension at base and head; `hostA` is absent for a new extension.
  hostA?: string;
  hostB: string;
  // Repo-relative prefix of the extension's files ('' for an extension repo).
  repoPrefix: string;
}

const MAX_BUNDLED_TARGETS = 2;

/** Resolves which extensions the lifecycle, taint and upgrade-parity gates run against. */
export function resolveExtensionTargets(
  repoInfo: RepoInfo,
  worktreeA: string,
  worktreeB: string,
): ExtensionTarget[] {
  if (repoInfo.kind === 'civicrm-extension') {
    const name = repoInfo.extensionName ?? 'myext';
    return [
      {
        key: repoInfo.extensionKey ?? name,
        containerDir: `/var/www/html/ext/${name}`,
        hostA: existsSync(join(worktreeA, 'info.xml')) ? worktreeA : undefined,
        hostB: worktreeB,
        repoPrefix: '',
      },
    ];
  }
  const targets: ExtensionTarget[] = [];
  for (const dir of (repoInfo.bundledExtensions ?? []).slice(0, MAX_BUNDLED_TARGETS)) {
    const infoB = join(worktreeB, dir, 'info.xml');
    if (!existsSync(infoB)) continue;
    const key = parseXmlAttr(readFileSync(infoB, 'utf8'), 'extension', 'key');
    if (!key || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(key)) continue;
    targets.push({
      key,
      containerDir: `/var/www/html/core/${dir}`,
      hostA: existsSync(join(worktreeA, dir, 'info.xml')) ? join(worktreeA, dir) : undefined,
      hostB: join(worktreeB, dir),
      repoPrefix: `${dir}/`,
    });
  }
  return targets;
}

// The ck tools read info.xml from the working directory; `ck run` starts in /var/www/html.
const IN_DIR = ['bash', '-c', 'cd "$1" && shift && exec "$@"', '_'];
// `ck lifecycle` starts with a disable; bundled extensions ship uninstalled in the image.
const ENABLED_IN_DIR = [
  'bash',
  '-c',
  'cd "$1" && { cv ext:enable "$2" >/dev/null 2>&1; shift 2; exec "$@"; }',
  '_',
];

/**
 * Installs the base copy, upgrades to the head copy and compares the result with a
 * fresh install of head. Exit 0 parity, 1 schema differs, 3 a step failed.
 */
export const UPGRADE_PARITY_SCRIPT = `set -u
key="$1"; dir="$2"; db="\${CIVICRM_DB_NAME:-civicrm}"
step() { label="$1"; shift; if ! "$@" > /tmp/cr-step.log 2>&1; then echo "upgrade-parity: step failed: $label" >&2; tail -15 /tmp/cr-step.log >&2; exit 3; fi; }
swap() { rm -rf "$dir" && cp -a "$1" "$dir"; }
step "copy base" swap /opt/cr-a
step "flush" cv flush
step "install base" cv ext:enable "$key"
step "copy head" swap /opt/cr-b
step "flush" cv flush
step "upgrade" cv upgrade:db --mode=ext
cd "$dir" || exit 3
step "dump upgraded" ckschemadiff dump "$db" /tmp/cr-upgraded.sql
step "disable" cv ext:disable "$key"
step "uninstall" cv ext:uninstall "$key"
step "fresh install" cv ext:enable "$key"
step "dump fresh" ckschemadiff dump "$db" /tmp/cr-fresh.sql
ckschemadiff diff /tmp/cr-fresh.sql /tmp/cr-upgraded.sql; rc=$?
[ "$rc" -eq 0 ] && echo "upgrade-parity: schemas identical"
exit "$rc"
`;
const PARITY_IDENTICAL = /^upgrade-parity: schemas identical$/m;

/** Container path of a `src:dst[:ro]` mount spec; the host path may itself contain a colon. */
function mountDestination(spec: string): string {
  const withoutMode = spec.replace(/:(ro|rw)$/, '');
  return withoutMode.slice(withoutMode.lastIndexOf(':') + 1);
}

/** Drops `--mount src:dst` pairs whose destination lies inside `containerDir`. */
function mountsOutside(mounts: string[], containerDir: string): string[] {
  const kept: string[] = [];
  for (let i = 0; i + 1 < mounts.length; i += 2) {
    const dst = mountDestination(mounts[i + 1]!);
    if (dst !== containerDir && !dst.startsWith(`${containerDir}/`)) {
      kept.push(mounts[i]!, mounts[i + 1]!);
    }
  }
  return kept;
}

function unsupported(
  res: { exitCode: number; stdout: string; stderr: string },
  re: RegExp,
): boolean {
  return (
    isUnsupportedCkFlagError(res.exitCode, res.stdout, res.stderr, re) ||
    /runs in the dev stack/i.test(res.stderr)
  );
}

function gateOutput(res: { stdout: string; stderr: string }): string {
  return `${res.stdout}\n${res.stderr}`
    .split(/\r?\n/)
    .filter((line) => line.trim() && !/^\s*(Container|Network|Volume) /.test(line))
    .join('\n')
    .trim();
}

/**
 * Runs the extension gates from each extension's root: static taint delta
 * (`ck taint` A vs B), `ck lifecycle`, and install-vs-upgrade schema parity.
 * A gate that cannot run is reported as not verified, never as a finding.
 */
export async function runStaticAndLifecycleChecks(ctx: StaticLifecycleContext): Promise<void> {
  const { execFn, ckCommand, diffFiles, imageA, imageB, effectiveCfg } = ctx;
  const { toolsRun, staticFindings, notVerified } = ctx;
  const markRun = (tool: string) => {
    if (!toolsRun.includes(tool)) toolsRun.push(tool);
  };

  // `ck run` refuses to start while a stack of its name exists, and a run that is cut off
  // leaves its stack behind: each gate gets its own stack, removed after a timeout.
  const ckRun = async (
    label: string,
    image: string,
    mounts: string[],
    command: string[],
    timeoutMs: number,
  ) => {
    const name = buildCkAbName(ctx.workDir, label);
    const res = await execFn(
      [...ckCommand, 'run', image, '--name', name, ...mounts, '--', ...command],
      { timeoutMs },
    );
    if (res.timedOut) {
      await execFn(['docker', 'compose', '-p', name, 'down', '-v'], { timeoutMs: 60_000 });
    }
    return res;
  };

  for (const dir of (ctx.repoInfo.bundledExtensions ?? []).slice(MAX_BUNDLED_TARGETS)) {
    notVerified.push(
      `${dir} not checked: the extension gates run for the first ${MAX_BUNDLED_TARGETS} bundled extensions of a PR`,
    );
  }

  const targets = resolveExtensionTargets(ctx.repoInfo, ctx.worktreeA, ctx.worktreeB);
  for (const dir of (ctx.repoInfo.bundledExtensions ?? []).slice(0, MAX_BUNDLED_TARGETS)) {
    if (!targets.some((t) => t.repoPrefix === `${dir}/`)) {
      notVerified.push(`${dir} not checked: no info.xml with a valid key in the PR head`);
    }
  }

  for (const target of targets) {
    const files = diffFiles.filter((f) => f.path.startsWith(target.repoPrefix));
    const inDir = [...IN_DIR, target.containerDir];

    // A change to tests alone leaves the extension's code as it is in the image.
    if (files.every((f) => f.flags.isTest)) continue;
    if (ctx.mountsBOnly.length === 0) {
      notVerified.push(`${target.key} not checked: no file of the PR head could be mounted`);
      continue;
    }

    if (isCheckEnabled(effectiveCfg, 'static-delta')) {
      const taintCmd = [...inDir, 'ck', 'taint'];
      const taintA = await ckRun('taint-a', imageA, ctx.mountsAOnly, taintCmd, 300_000);
      const taintB = await ckRun('taint-b', imageB, ctx.mountsBOnly, taintCmd, 300_000);

      if (unsupported(taintA, /\btaint\b/i) || unsupported(taintB, /\btaint\b/i)) {
        notVerified.push(
          'Installed ck CLI does not support `ck taint`; static taint delta skipped.',
        );
      } else if (taintA.timedOut || taintB.timedOut) {
        notVerified.push(`ck taint timed out for ${target.key}; static taint delta skipped.`);
      } else {
        const sides = [taintA, taintB].map((res) => ({
          res,
          items: parseTaintFindings(`${res.stdout}\n${res.stderr}`),
        }));
        // A non-zero exit without an error-level issue is a tool failure, not a taint finding.
        const failed = sides.find(
          (side) => side.res.exitCode !== 0 && !side.items.some((i) => i.severity === 'error'),
        );
        if (failed) {
          notVerified.push(
            `ck taint failed for ${target.key} (exit ${failed.res.exitCode}); static taint delta skipped.`,
          );
        } else {
          markRun('cktaint');
          for (const item of newTaintFindings(sides[0]!.items, sides[1]!.items)) {
            staticFindings.push({
              tool: 'cktaint',
              severity: item.severity,
              path: `${target.repoPrefix}${item.path}`,
              line: item.line,
              message: item.message,
              isNewOnHead: true,
            });
          }
        }
      }
    }

    const needsLifecycle = files.some(
      (f) => f.flags.isUpgrade || f.flags.isSchema || f.flags.isManaged,
    );
    const needsParity = files.some((f) => f.flags.isSchema || f.flags.isUpgrade);
    if (!isCheckEnabled(effectiveCfg, 'lifecycle')) {
      if (needsLifecycle) {
        notVerified.push(
          `install, uninstall and upgrade path of ${target.key} not verified (lifecycle check disabled)`,
        );
      }
      continue;
    }

    if (needsLifecycle || effectiveCfg.review.include.includes('lifecycle')) {
      const lcRes = await ckRun(
        'lifecycle',
        imageB,
        ctx.mountsBOnly,
        [...ENABLED_IN_DIR, target.containerDir, target.key, 'ck', 'lifecycle'],
        300_000,
      );
      if (unsupported(lcRes, /\blifecycle\b/i)) {
        notVerified.push(
          'Installed ck CLI does not support `ck lifecycle`; lifecycle check skipped.',
        );
      } else if (lcRes.timedOut || !gateOutput(lcRes).includes('### Lifecycle gate')) {
        // Without the gate's report the run stopped before the check (stack boot, missing info.xml).
        notVerified.push(`ck lifecycle did not run for ${target.key}; lifecycle not verified.`);
      } else {
        markRun('cklifecycle');
        if (lcRes.exitCode !== 0) {
          staticFindings.push({
            tool: 'cklifecycle',
            severity: 'error',
            message: gateOutput(lcRes).slice(-1500),
            isNewOnHead: true,
          });
        }
      }
    }

    // A directory mount over a parent keeps the extension directory read-only.
    const coveredByMount = ctx.mountsBOnly.some(
      (m) => m !== '--mount' && target.containerDir.startsWith(`${mountDestination(m)}/`),
    );
    if (needsParity && target.hostA && coveredByMount) {
      notVerified.push(
        `Upgrade parity skipped for ${target.key}: the PR is mounted as whole directories, so the extension cannot be replaced in the instance.`,
      );
    } else if (needsParity && !target.hostA) {
      notVerified.push(
        `Upgrade parity skipped for ${target.key}: the PR adds the extension, there is no base version to upgrade from.`,
      );
    } else if (needsParity && target.hostA) {
      const res = await ckRun(
        'parity',
        imageB,
        [
          ...mountsOutside(ctx.mountsBOnly, target.containerDir),
          '--mount',
          `${target.hostA}:/opt/cr-a:ro`,
          '--mount',
          `${target.hostB}:/opt/cr-b:ro`,
        ],
        ['bash', '-c', UPGRADE_PARITY_SCRIPT, 'upgrade-parity', target.key, target.containerDir],
        420_000,
      );
      const out = gateOutput(res);
      if (res.exitCode === 0 && !res.timedOut && PARITY_IDENTICAL.test(out)) {
        markRun('ckschemaparity');
      } else if (res.exitCode === 1 && /the two schemas differ/.test(out)) {
        markRun('ckschemaparity');
        const diffStart = out.indexOf('--- fresh install');
        staticFindings.push({
          tool: 'ckschemaparity',
          severity: 'warning',
          message:
            `Upgrading ${target.key} from base to head leaves a different schema than a fresh install of head ` +
            `(a pure column-order difference is harmless):\n${out.slice(Math.max(diffStart, 0)).slice(0, 1400)}`,
          isNewOnHead: true,
        });
      } else {
        const failed = out.match(/upgrade-parity: step failed: (.+)/)?.[1];
        notVerified.push(
          `upgrade path of ${target.key} not verified: ` +
            (res.timedOut
              ? 'the parity run timed out'
              : failed
                ? `step "${failed}" failed`
                : `the parity run exited with ${res.exitCode}`),
        );
      }
    }
  }
}

export interface StandaloneBrowserContext {
  execFn: ExecFn;
  ckCommand: string[];
  workDir: string;
  outRoot: string;
  outputDir?: string;
  repoInfo: RepoInfo;
  worktreeA: string;
  worktreeB: string;
  diffFiles: DiffFile[];
  prBody?: string;
  imageA: string;
  imageB: string;
  abMounts: string[];
  browserConfig: BrowserConfig;
  effectiveCfg: {
    ab: AbConfig;
    checks: ChecksConfig;
    review: ReviewSettings;
  };
  wantSurface: boolean;
  interactiveBrowser: boolean;
  liveProve: boolean;
  keepLive: boolean;
  surfaceDiff: SurfaceDiffReport;
  keptUrls?: { A?: string; B?: string };
  keptComposeFiles?: { A?: string; B?: string };
  notVerified: string[];
}

export interface StandaloneBrowserResult {
  surfaceDiff: SurfaceDiffReport;
  browserDiff?: BrowserDiffReport;
  keptUrls?: { A?: string; B?: string };
  keptComposeFiles?: { A?: string; B?: string };
}

/**
 * Runs Standalone Browser A/B verification (`ck ab --page ... --expose`),
 * captures live surface/browser diffs, extracts exposed URLs & compose files,
 * and safely copies before/after screenshots into `outputDir/screenshots`.
 */
export async function runStandaloneBrowserAb(
  ctx: StandaloneBrowserContext,
): Promise<StandaloneBrowserResult> {
  let { surfaceDiff, keptUrls, keptComposeFiles } = ctx;
  let browserDiff: BrowserDiffReport | undefined;

  const browserEnabled = isCheckEnabled(ctx.effectiveCfg, 'browser');
  const a11yEnabled = isCheckEnabled(ctx.effectiveCfg, 'a11y');
  const targets = resolveExtensionTargets(ctx.repoInfo, ctx.worktreeA, ctx.worktreeB);
  const routes = browserEnabled
    ? discoverStandaloneRoutes({
        diffFiles: ctx.diffFiles,
        surfaceDiff,
        prBody: ctx.prBody,
        extensionRouteSources: readExtensionRouteSources(
          targets.map((t) => ({ hostDir: t.hostB, repoPrefix: t.repoPrefix })),
        ),
        config: { browser: ctx.browserConfig },
      })
    : {
        pages: [],
        anonymousPages: [],
        reason: 'browser check disabled',
        usedFallback: false,
        contextOnly: false,
      };
  // Bundled extensions ship disabled in the image; their pages exist only once enabled.
  const bundledKeys = ctx.repoInfo.kind === 'civicrm-core' ? targets.map((t) => t.key) : [];
  const setupCommand = bundledKeys.length > 0 ? ['cv', 'ext:enable', ...bundledKeys] : ['true'];

  const hasRoutes = routes.pages.length > 0 || routes.anonymousPages.length > 0;
  if (!((browserEnabled && hasRoutes) || ctx.interactiveBrowser || ctx.liveProve)) {
    return { surfaceDiff, browserDiff, keptUrls, keptComposeFiles };
  }

  const subOut = join(ctx.outRoot, 'browser-ab');
  mkdirSync(subOut, { recursive: true });
  const jsonReportPath = join(subOut, 'ab-report.json');
  const browserDiffPath = join(subOut, 'browser-diff.json');
  const surfaceDiffPath = join(subOut, 'surface-diff.json');

  const browserAbName = buildCkAbName(ctx.workDir, 'browser-ab');
  const buildBrowserArgs = (withName: boolean): string[] => [
    ...ctx.ckCommand,
    'ab',
    ctx.imageA,
    ctx.imageB,
    ...ctx.abMounts,
    '--out',
    subOut,
    ...(withName ? ['--name', browserAbName] : []),
    '--json',
    jsonReportPath,
    ...(ctx.wantSurface ? ['--surface'] : []),
    ...routes.pages.flatMap((p) => ['--page', p]),
    ...routes.anonymousPages.flatMap((p) => ['--anon-page', p]),
    ...(!a11yEnabled ? ['--no-a11y'] : []),
    '--expose',
    ...(ctx.keepLive ? ['--keep'] : []),
    '--',
    ...setupCommand,
  ];

  let browserRes = await ctx.execFn(buildBrowserArgs(true), {
    timeoutMs: 300_000,
  });
  if (
    !existsSync(jsonReportPath) &&
    !existsSync(browserDiffPath) &&
    isUnsupportedCkFlagError(browserRes.exitCode, browserRes.stdout, browserRes.stderr, /--name/i)
  ) {
    browserRes = await ctx.execFn(buildBrowserArgs(false), {
      timeoutMs: 300_000,
    });
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
    ctx.notVerified.push(
      'Installed ck CLI does not support --page/--expose Standalone browser A/B flags; browser diff skipped.',
    );
    return { surfaceDiff, browserDiff, keptUrls, keptComposeFiles };
  }

  let parsedJson: ParsedCkAbJsonReport | undefined;
  if (existsSync(jsonReportPath)) {
    try {
      parsedJson = parseCkAbJsonReport(readFileSync(jsonReportPath, 'utf8'));
      if (parsedJson.surfaceDiff && !surfaceDiff.liveSurfaceDiff) {
        surfaceDiff = mergeLiveSurfaceDiff(surfaceDiff, parsedJson.surfaceDiff);
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

  const envComposeA = extractKeyValueFromOutput(browserRes.stdout, browserRes.stderr, 'COMPOSE_A');
  const envComposeB = extractKeyValueFromOutput(browserRes.stdout, browserRes.stderr, 'COMPOSE_B');
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

  // A missing report leaves the exit codes undefined: the setup is then unproven, not passed.
  const setupFailed =
    bundledKeys.length > 0 && (parsedJson?.exitCodeA !== 0 || parsedJson?.exitCodeB !== 0);
  if (setupFailed) {
    // Without the extension enabled on both sides its routes do not exist; the probe compares nothing.
    browserDiff = BrowserDiffReportSchema.parse({
      error: `could not enable ${bundledKeys.join(', ')} (exit ${parsedJson?.exitCodeA ?? 'unknown'} on base, ${parsedJson?.exitCodeB ?? 'unknown'} on head)`,
      probedRoutes: routes.pages,
      probedAnonymousRoutes: routes.anonymousPages,
    });
  } else if (!browserDiff && browserRes.exitCode !== 0) {
    browserDiff = BrowserDiffReportSchema.parse({
      error:
        (browserRes.stderr || browserRes.stdout).trim().slice(0, 600) ||
        `ck ab browser probe exited with ${browserRes.exitCode}`,
      probedRoutes: routes.pages,
      probedAnonymousRoutes: routes.anonymousPages,
      ...(keptUrls ? { urls: keptUrls } : {}),
    });
  } else if (browserDiff) {
    const destScreenshotsDir = ctx.outputDir ? join(ctx.outputDir, 'screenshots') : undefined;

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
            ctx.workDir,
            destScreenshotsDir,
            `${prefix}-before`,
          ) ?? beforeRaw)
        : beforeRaw;
      const after = destScreenshotsDir
        ? (copyScreenshotIfSafe(
            afterRaw,
            subOut,
            ctx.workDir,
            destScreenshotsDir,
            `${prefix}-after`,
          ) ?? afterRaw)
        : afterRaw;
      return { ...shot, before, after };
    });

    browserDiff = {
      ...browserDiff,
      probedRoutes: browserDiff.probedRoutes.length > 0 ? browserDiff.probedRoutes : routes.pages,
      probedAnonymousRoutes:
        browserDiff.probedAnonymousRoutes.length > 0
          ? browserDiff.probedAnonymousRoutes
          : routes.anonymousPages,
      screenshots: copiedScreenshots,
      ...(routes.usedFallback || routes.contextOnly ? { smokeOnly: true } : {}),
      ...(keptUrls ? { urls: keptUrls } : {}),
    };
  }

  if (browserDiff?.error) {
    ctx.notVerified.push(`Standalone browser A/B error: ${browserDiff.error}`);
  }

  return { surfaceDiff, browserDiff, keptUrls, keptComposeFiles };
}
