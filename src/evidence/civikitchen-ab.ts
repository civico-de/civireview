import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
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
import { extractAddedTestMethods } from './diff-filter.ts';
import { detectBundledExtensions } from './repo-detect.ts';
import {
  LiveSurfaceDiffSchema,
  type AbCheckResult,
  type AbRunReport,
  type BrowserDiffReport,
  type DiffFile,
  type RepoInfo,
  type StaticDeltaFinding,
  type StaticDeltaReport,
} from './types.ts';
import {
  buildAbCheckFromJson,
  buildAbCheckFromStdout,
  formatAbDiagnosticTail,
  isUnsupportedCkFlagError,
  parseCkAbJsonReport,
  parseCkAbOutput,
  parseDemoErrors,
  parseTaintFindings,
  validateLocalhostUrl,
  type ExecFn,
  type ParsedCkAbJsonReport,
  type RunCommandResult,
} from './ab/parsers.ts';
import {
  civikitchenImageRef,
  collectBaseDriftSinceImage,
  resolveAvailableCivikitchenImage,
} from './ab/image-drift.ts';
import { runStandaloneBrowserAb, runStaticAndLifecycleChecks } from './ab/static-browser.ts';
import { computeSurfaceDiff, mergeLiveSurfaceDiff } from './ab/surface-diff.ts';
import {
  buildCkAbName,
  buildCoreMountPlan,
  isCoreComposerFile,
  buildMultiTargetTestCommand,
  buildPerFileFilterArgs,
  deriveRegressionTargets,
  isE2eMinkTestPath,
  stripFilterArgs,
} from './ab/test-targets.ts';

export {
  buildMultiTargetTestCommand,
  computeSurfaceDiff,
  mergeLiveSurfaceDiff,
  parseCkAbJsonReport,
  parseCkAbOutput,
  parseTaintFindings,
  validateLocalhostUrl,
  type ExecFn,
  type ParsedCkAbJsonReport,
  type RunCommandResult,
};

async function defaultExec(
  args: string[],
  opts: {
    cwd?: string;
    env?: Record<string, string | undefined>;
    timeoutMs?: number;
  } = {},
): Promise<RunCommandResult> {
  const [cmd, ...rest] = args;
  if (!cmd) {
    return { exitCode: 2, stdout: '', stderr: 'empty command' };
  }
  const startMs = Date.now();
  const proc = Bun.spawn([cmd, ...rest], {
    cwd: opts.cwd,
    env: opts.env ? { ...process.env, ...opts.env } : process.env,
    stdout: 'pipe',
    stderr: 'pipe',
  });

  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  if (opts.timeoutMs && opts.timeoutMs > 0) {
    timer = setTimeout(() => {
      timedOut = true;
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
    return {
      exitCode,
      stdout,
      stderr,
      timedOut,
      durationMs: Date.now() - startMs,
    };
  } finally {
    if (timer) clearTimeout(timer);
  }
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
async function noopCleanup(): Promise<void> {}

const MAX_PROOF_TEST_FILES = 5;

/** Names the changed test files that proof of fix leaves out. */
export function noteSkippedProofTargets(testFiles: string[], notVerified: string[]): void {
  const skipped = testFiles.slice(MAX_PROOF_TEST_FILES);
  if (skipped.length > 0) {
    notVerified.push(
      `Proof of fix ran the first ${MAX_PROOF_TEST_FILES} changed test files; not run: ${skipped.join(', ')}`,
    );
  }
}

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
  let imageA = repoInfo.recommendedImage;
  let imageB = repoInfo.recommendedImage;

  const emptyStatic: StaticDeltaReport = {
    executed: false,
    toolsRun: [],
    findings: [],
    summary: 'Static delta check did not run.',
  };

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
    notVerified.push('Docker daemon unavailable; live CiviKitchen A/B execution skipped.');
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
    notVerified.push('ck CLI not found and Docker unavailable; live A/B checks skipped.');
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

  const resolvedImg = await resolveAvailableCivikitchenImage(
    repoInfo.recommendedImage,
    repoInfo.kind,
    execFn,
  );
  imageA = resolvedImg.tag;
  imageB = resolvedImg.tag;
  if (!resolvedImg.found) {
    notVerified.push(
      `CiviKitchen image ${civikitchenImageRef(resolvedImg.tag)} is not published; live A/B checks skipped.`,
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
  if (resolvedImg.fallbackFrom) {
    notVerified.push(
      `A/B ran on ${resolvedImg.tag} because ${resolvedImg.fallbackFrom} is not published; that CiviCRM version was not tested.`,
    );
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
  let completed = false;

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
    if ((wtA.exitCode !== 0 || wtB.exitCode !== 0) && options.prNumber && options.prNumber > 0) {
      const fetchRefs = [`pull/${options.prNumber}/head`];
      if (options.baseBranch && /^[A-Za-z0-9._/-]+$/.test(options.baseBranch)) {
        fetchRefs.push(options.baseBranch);
      }
      if (wtA.exitCode !== 0 && /^[0-9a-f]{7,40}$/i.test(baseSha)) {
        fetchRefs.push(baseSha);
      }
      await execFn(['git', '-C', repoRoot, 'fetch', '--no-tags', 'origin', ...fetchRefs], {
        timeoutMs: 120_000,
      });
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

    if (repoInfo.kind === 'civicrm-core') {
      // The caller's checkout may predate an extension; the head worktree is authoritative.
      const bundled = detectBundledExtensions(
        worktreeB,
        diffFiles.map((f) => f.path),
      );
      repoInfo.bundledExtensions = bundled.length > 0 ? bundled : undefined;
      const stale = new Set(surfaceDiff.unverifiedSurfaces);
      surfaceDiff = computeSurfaceDiff(diffFiles, repoInfo);
      notVerified.splice(0, notVerified.length, ...notVerified.filter((n) => !stale.has(n)));
      notVerified.push(...surfaceDiff.unverifiedSurfaces);
    }

    const allTouchedTestPhp = diffFiles
      .filter((f) => f.flags.isTest && f.status !== 'deleted' && /Test\.php$/i.test(f.path))
      .map((f) => f.path);
    const skippedE2eTests = allTouchedTestPhp.filter((p) => isE2eMinkTestPath(p));
    if (skippedE2eTests.length > 0) {
      notVerified.push(
        `Skipped ${skippedE2eTests.length} E2E/Mink test file(s) from headless PHPUnit proof-of-fix (requires Selenium/WebDriver): ${skippedE2eTests.join(', ')}`,
      );
    }
    const touchedTestFiles = allTouchedTestPhp.filter((p) => !isE2eMinkTestPath(p));
    const addedTestMethods = extractAddedTestMethods(diffFiles).filter(
      (m) => !isE2eMinkTestPath(m.file),
    );
    const hasProductionCodeChange = diffFiles.some((f) => !f.flags.isTest && !f.flags.isDocsOnly);
    const uiTouched = diffFiles.some((f) => f.flags.isFrontendAsset);

    const runAbInvocation = async (
      name: string,
      imgA: string,
      imgB: string,
      mounts: string[],
      innerCmd: string[],
      extraFlags: string[] = [],
    ): Promise<{
      check: AbCheckResult;
      subOut: string;
      stdout: string;
      stderr: string;
    }> => {
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
        ...(abConfig.keepStacks && !extraFlags.includes('--keep') ? ['--keep'] : []),
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
          withName && isUnsupportedCkFlagError(res.exitCode, res.stdout, res.stderr, /--name/i);
        const rejectedJson =
          withJsonAndSurface &&
          isUnsupportedCkFlagError(res.exitCode, res.stdout, res.stderr, /--json|--surface/i);
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

      // Transient Docker/runner failure retry: if ck ab exited non-zero without
      // writing a report, did not time out, and did not hit a deterministic exit-2
      // condition (missing image, only B wrote, holds no test case, same mounts), retry once.
      const combinedOut = `${res.stderr}\n${res.stdout}`;
      const isDeterministicExit2 =
        /only B wrote\b|holds no test case|same mounts; nothing to compare|failed to resolve reference|manifest unknown|:\s*not found\b|No such image/i.test(
          combinedOut,
        );
      if (
        res.exitCode !== 0 &&
        !res.timedOut &&
        !existsSync(jsonReportPath) &&
        !isDeterministicExit2
      ) {
        const durSec = ((res.durationMs ?? 0) / 1000).toFixed(1);
        console.error(
          `[civireview:ab] ${name} exited ${res.exitCode} without report after ${durSec}s; retrying once (tail: ${formatAbDiagnosticTail(res.stdout, res.stderr)})`,
        );
        res = await execFn(args, { timeoutMs: 600_000 });
      }

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

          return {
            subOut,
            stdout: res.stdout,
            stderr: res.stderr,
            check: buildAbCheckFromJson({
              name,
              args,
              imageA: imgA,
              imageB: imgB,
              res,
              parsedJson,
              hasProductionCodeChange,
              addedTestMethods,
            }),
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

      const check = buildAbCheckFromStdout({
        name,
        args,
        imageA: imgA,
        imageB: imgB,
        res,
        addedTestMethods,
      });
      if (check.status === 'ERROR') {
        const durStr =
          res.durationMs !== undefined ? ` after ${(res.durationMs / 1000).toFixed(1)}s` : '';
        const timeoutNote = res.timedOut || res.exitCode === 143 ? ' [TIMED OUT]' : '';
        const tail = formatAbDiagnosticTail(res.stdout, res.stderr);
        console.error(
          `[civireview:ab] ${name} runner error (exit ${res.exitCode}${timeoutNote}${durStr}) cmd="${effectiveInnerCmd.join(' ').slice(0, 180)}" tail: ${tail}`,
        );
      }
      return {
        subOut,
        stdout: res.stdout,
        stderr: res.stderr,
        check,
      };
    };

    // Build shared mounts per repo kind
    let abMounts: string[] = [];
    let mountsAOnly: string[] = [];
    let mountsBOnly: string[] = [];

    if (repoInfo.kind === 'civicrm-core') {
      const drift = await collectBaseDriftSinceImage({
        repoRoot,
        baseSha,
        imageTag: imageA,
        execFn,
      });
      if (!drift.files) {
        notVerified.push(
          `Core commit of ${imageA} not resolved; A runs on the image's core with only the PR's directories taken from the base.`,
        );
      }
      const composerDiffers =
        (drift.files ?? []).some(isCoreComposerFile) ||
        diffFiles.some((f) => isCoreComposerFile(f.path));
      if (composerDiffers && !drift.vendorSync) {
        notVerified.push(
          `Composer dependencies differ from ${imageA}'s, which does not sync vendor/ at boot; vendor/ is the image's.`,
        );
      }
      const mountPlan = buildCoreMountPlan(
        diffFiles,
        surfaceDiff.touchedComponents,
        worktreeA,
        worktreeB,
        drift.files ?? [],
      );
      if (mountPlan.staleImageFiles.length > 0) {
        notVerified.push(
          `Files the base lacks stay visible from ${imageA}: ${mountPlan.staleImageFiles.join(', ')}`,
        );
      }
      if (mountPlan.prDeletedImageFiles.length > 0) {
        notVerified.push(
          `Files the PR deletes or renames stay in ${imageA} on B: ${mountPlan.prDeletedImageFiles.join(', ')}`,
        );
      }
      abMounts = mountPlan.abMounts;
      mountsAOnly = mountPlan.mountsAOnly;
      mountsBOnly = mountPlan.mountsBOnly;
      const { proofTestMounts, baseTestMounts, useFileMounts } = mountPlan;

      if (isCheckEnabled(effectiveCfg, 'ab-tests')) {
        if (
          touchedTestFiles.length > 0 &&
          (useFileMounts || existsSync(join(worktreeB, 'tests')))
        ) {
          const proofTargets = touchedTestFiles.slice(0, MAX_PROOF_TEST_FILES);
          noteSkippedProofTargets(touchedTestFiles, notVerified);
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
        } else if (skippedE2eTests.length === 0) {
          notVerified.push('No added/modified PHPUnit tests in PR; Proof-of-Fix A/B test skipped.');
        }

        const regressionTargets = deriveRegressionTargets(diffFiles, worktreeA);
        if (
          regressionTargets.length > 0 &&
          (useFileMounts || existsSync(join(worktreeA, 'tests')))
        ) {
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
        const diffRes = await execFn(['git', '-C', repoRoot, 'diff', baseSha, headSha], {
          timeoutMs: 30_000,
        });
        const patchFile = join(workDir, 'pr.patch');
        await Bun.write(patchFile, diffRes.stdout);
        const demoRes = await execFn([...ck.command, 'demo', patchFile, '--out', demoOut], {
          timeoutMs: 300_000,
        });
        if (demoRes.exitCode === 0) {
          demoArtifactsDir = demoOut;
          demoConsoleErrors.push(...parseDemoErrors(demoRes.stdout));
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
        const existingBTests = touchedTestFiles.filter((tf) => existsSync(join(worktreeB, tf)));
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
          const extProofTargets = existingBTests.slice(0, MAX_PROOF_TEST_FILES);
          noteSkippedProofTargets(existingBTests, notVerified);
          const extProofCmd = buildMultiTargetTestCommand(
            'phpunit',
            extProofTargets.map((tf) => ({
              path: `/var/www/html/ext/${extName}/${tf}`,
              filterArgs: buildPerFileFilterArgs(tf, diffFiles, addedTestMethods, worktreeB),
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
        } else if (skippedE2eTests.length === 0) {
          notVerified.push('No added/modified PHPUnit tests in PR; Proof-of-Fix A/B test skipped.');
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
      await runStaticAndLifecycleChecks({
        execFn,
        ckCommand: ck.command,
        workDir,
        repoInfo,
        diffFiles,
        imageA,
        imageB,
        worktreeA,
        worktreeB,
        mountsAOnly,
        mountsBOnly,
        effectiveCfg,
        toolsRun,
        staticFindings,
        notVerified,
      });

      const browserOutcome = await runStandaloneBrowserAb({
        execFn,
        ckCommand: ck.command,
        workDir,
        outRoot,
        outputDir: options.outputDir,
        repoInfo,
        worktreeA,
        worktreeB,
        diffFiles,
        prBody: options.prBody,
        imageA,
        imageB,
        abMounts,
        browserConfig,
        effectiveCfg,
        wantSurface,
        interactiveBrowser,
        liveProve,
        keepLive,
        surfaceDiff,
        keptUrls,
        keptComposeFiles,
        notVerified,
      });
      surfaceDiff = browserOutcome.surfaceDiff;
      browserDiff = browserOutcome.browserDiff;
      keptUrls = browserOutcome.keptUrls;
      keptComposeFiles = browserOutcome.keptComposeFiles;
    }
    completed = true;
  } finally {
    // Kept for a live probe only after a complete run; each worktree is removed on its own,
    // since the first can exist without the second.
    if (!keepLive || !completed) {
      await execFn(['git', '-C', repoRoot, 'worktree', 'remove', '--force', worktreeA]);
      await execFn(['git', '-C', repoRoot, 'worktree', 'remove', '--force', worktreeB]);
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
          await execFn(['docker', 'compose', '-f', cf, 'down', '--remove-orphans', '-v'], {
            timeoutMs: 60_000,
          });
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
      notVerified: Array.from(new Set([...notVerified, ...surfaceDiff.unverifiedSurfaces])),
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
