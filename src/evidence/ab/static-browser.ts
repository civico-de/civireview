import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  isCheckEnabled,
  type AbConfig,
  type BrowserConfig,
  type ChecksConfig,
  type ReviewSettings,
} from '../../config/schema.ts';
import { discoverStandaloneRoutes } from '../browser-routes.ts';
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
  repoInfo: RepoInfo;
  diffFiles: DiffFile[];
  imageA: string;
  imageB: string;
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

/**
 * Runs static taint delta (`ck taint` A vs B) and lifecycle/schema checks
 * (`ck lifecycle`, `ck schema`) for CiviCRM extensions.
 */
export async function runStaticAndLifecycleChecks(ctx: StaticLifecycleContext): Promise<void> {
  const {
    execFn,
    ckCommand,
    repoInfo,
    diffFiles,
    imageA,
    imageB,
    mountsAOnly,
    mountsBOnly,
    effectiveCfg,
    toolsRun,
    staticFindings,
    notVerified,
  } = ctx;

  if (
    repoInfo.kind === 'civicrm-extension' &&
    isCheckEnabled(effectiveCfg, 'static-delta') &&
    mountsAOnly.length > 0 &&
    mountsBOnly.length > 0
  ) {
    const taintA = await execFn(
      [...ckCommand, 'run', imageA, ...mountsAOnly, '--', 'ck', 'taint'],
      { timeoutMs: 180_000 },
    );
    const taintB = await execFn(
      [...ckCommand, 'run', imageB, ...mountsBOnly, '--', 'ck', 'taint'],
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
    const needsSchema = diffFiles.some((f) => f.flags.isSchema || f.flags.isUpgrade);

    if (
      repoInfo.kind === 'civicrm-extension' &&
      (needsLifecycle || effectiveCfg.review.include.includes('lifecycle')) &&
      mountsBOnly.length > 0
    ) {
      const lcRes = await execFn(
        [...ckCommand, 'run', imageB, ...mountsBOnly, '--', 'ck', 'lifecycle'],
        { timeoutMs: 180_000 },
      );
      if (
        isUnsupportedCkFlagError(lcRes.exitCode, lcRes.stdout, lcRes.stderr, /\blifecycle\b/i) ||
        /runs in the dev stack/i.test(lcRes.stderr)
      ) {
        notVerified.push(
          'Installed ck CLI does not support `ck lifecycle`; lifecycle check skipped.',
        );
      } else {
        toolsRun.push('cklifecycle');
        if (lcRes.exitCode !== 0) {
          staticFindings.push({
            tool: 'cklifecycle',
            severity: 'error',
            message:
              (lcRes.stdout || lcRes.stderr).trim().slice(0, 1500) ||
              `ck lifecycle exited with ${lcRes.exitCode}`,
            isNewOnHead: true,
          });
        }
      }
    }

    if (repoInfo.kind === 'civicrm-extension' && needsSchema && mountsBOnly.length > 0) {
      const schemaRes = await execFn(
        [...ckCommand, 'run', imageB, ...mountsBOnly, '--', 'ck', 'schema'],
        { timeoutMs: 180_000 },
      );
      if (
        isUnsupportedCkFlagError(
          schemaRes.exitCode,
          schemaRes.stdout,
          schemaRes.stderr,
          /\bschema\b/i,
        ) ||
        /runs in the dev stack/i.test(schemaRes.stderr)
      ) {
        notVerified.push('Installed ck CLI does not support `ck schema`; schema check skipped.');
      } else {
        toolsRun.push('ckschema');
        if (schemaRes.exitCode !== 0) {
          staticFindings.push({
            tool: 'ckschema',
            severity: 'error',
            message:
              (schemaRes.stdout || schemaRes.stderr).trim().slice(0, 1500) ||
              `ck schema exited with ${schemaRes.exitCode}`,
            isNewOnHead: true,
          });
        }
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
  const routes = browserEnabled
    ? discoverStandaloneRoutes({
        diffFiles: ctx.diffFiles,
        surfaceDiff,
        prBody: ctx.prBody,
        config: { browser: ctx.browserConfig },
      })
    : { pages: [], anonymousPages: [], reason: 'browser check disabled' };

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
    'true',
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
      ...(keptUrls ? { urls: keptUrls } : {}),
    };
  }

  if (browserDiff?.error) {
    ctx.notVerified.push(`Standalone browser A/B error: ${browserDiff.error}`);
  }

  return { surfaceDiff, browserDiff, keptUrls, keptComposeFiles };
}
