import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import type { AddedTestMethod } from '../diff-filter.ts';
import type { DiffFile } from '../types.ts';

/**
 * Returns true if the test path is a Mink/Selenium E2E test that cannot run
 * in headless PHPUnit without a WebDriver server.
 */
export function isE2eMinkTestPath(filePath: string): boolean {
  return /(?:^|\/)tests\/phpunit\/E2E\//i.test(filePath);
}

function isLikelyHeadlessTestFile(absPath: string): boolean {
  try {
    const head = readFileSync(absPath, 'utf8').slice(0, 2000);
    return /HeadlessInterface|@group\s+headless/i.test(head);
  } catch {
    return false;
  }
}

function listUnmodifiedPhpUnitTests(
  dirRel: string,
  worktreeRoot: string,
  excludedPaths: Set<string>,
  limit: number,
): string[] {
  const headless: string[] = [];
  const fallback: string[] = [];
  const walk = (rel: string): void => {
    if (headless.length >= limit) return;
    const abs = join(worktreeRoot, rel);
    let entries;
    try {
      entries = readdirSync(abs, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (headless.length >= limit) return;
      const childRel = `${rel}/${entry.name}`;
      if (entry.isDirectory()) {
        if (entry.name.toLowerCase() === 'e2e') continue;
        walk(childRel);
      } else if (
        entry.isFile() &&
        /Test\.php$/i.test(entry.name) &&
        !excludedPaths.has(childRel) &&
        !isE2eMinkTestPath(childRel)
      ) {
        if (isLikelyHeadlessTestFile(join(worktreeRoot, childRel))) {
          headless.push(childRel);
        } else if (fallback.length < limit) {
          fallback.push(childRel);
        }
      }
    }
  };
  walk(dirRel);
  return headless.length > 0 ? headless.slice(0, limit) : fallback.slice(0, limit);
}

export function deriveRegressionTargets(diffFiles: DiffFile[], worktreeRoot?: string): string[] {
  const targets = new Set<string>();
  const exists = (rel: string): boolean =>
    worktreeRoot ? existsSync(join(worktreeRoot, rel)) : true;

  // Exclude any test file modified/touched in the PR diff from base-test-regression:
  // when a PR intentionally updates an existing test's assertion for the bug being fixed,
  // running the unmodified base test file against the fixed PR produces a false FAIL.
  const prTouchedTestPaths = new Set(diffFiles.filter((f) => f.flags.isTest).map((f) => f.path));

  const addCandidate = (candidate: string): boolean => {
    if (prTouchedTestPaths.has(candidate) || isE2eMinkTestPath(candidate)) {
      return false;
    }
    if (!exists(candidate)) {
      return false;
    }
    const hasModifiedInside = Array.from(prTouchedTestPaths).some((tp) =>
      tp.startsWith(`${candidate}/`),
    );
    if (worktreeRoot) {
      let isDir = false;
      try {
        isDir = statSync(join(worktreeRoot, candidate)).isDirectory();
      } catch {
        return false;
      }
      if (isDir) {
        const siblings = listUnmodifiedPhpUnitTests(candidate, worktreeRoot, prTouchedTestPaths, 3);
        for (const s of siblings) {
          targets.add(s);
        }
        return siblings.length > 0;
      }
    } else if (hasModifiedInside) {
      return false;
    }
    targets.add(candidate);
    return true;
  };

  for (const file of diffFiles) {
    if (file.flags.isTest) continue;
    const p = file.path;

    // 1. Exact mirror test file (e.g. CRM/Core/Resources/Common.php -> tests/phpunit/CRM/Core/Resources/CommonTest.php)
    if (p.endsWith('.php') && (p.startsWith('CRM/') || p.startsWith('Civi/'))) {
      const exactTest = `tests/phpunit/${p.slice(0, -4)}Test.php`;
      if (worktreeRoot && addCandidate(exactTest)) {
        continue;
      }
    }

    // 2. Narrowest subdirectory test suite (e.g. CRM/Core/Resources/Common.php -> tests/phpunit/CRM/Core/Resources or ResourcesTest.php)
    const crmDeep = p.match(/^CRM\/([^/]+)\/([^/]+)\//);
    if (crmDeep?.[1] && crmDeep[2]) {
      const subDir = `tests/phpunit/CRM/${crmDeep[1]}/${crmDeep[2]}`;
      const subFile = `tests/phpunit/CRM/${crmDeep[1]}/${crmDeep[2]}Test.php`;
      if (worktreeRoot && addCandidate(subDir)) {
        continue;
      }
      if (worktreeRoot && addCandidate(subFile)) {
        continue;
      }
    }

    const civiMatch = p.match(/^Civi\/([^/]+)\//);
    if (civiMatch?.[1] && civiMatch[1] !== 'Api4') {
      const civiDir = `tests/phpunit/Civi/${civiMatch[1]}`;
      if (addCandidate(civiDir)) {
        continue;
      }
    }

    const crmMatch = p.match(/^CRM\/([^/]+)\//);
    if (crmMatch?.[1] && crmMatch[1] !== 'Core') {
      const candidate = `tests/phpunit/CRM/${crmMatch[1]}`;
      if (addCandidate(candidate)) {
        continue;
      }
    }

    const api4Match = p.match(/^Civi\/Api4\/([^/.]+)/);
    if (api4Match?.[1]) {
      const api4Test = `tests/phpunit/api/v4/${api4Match[1]}Test.php`;
      if (addCandidate(api4Test)) {
        continue;
      }
    }

    // Core extensions under ext/<name>/ (e.g. ext/financialacls/..., ext/afform/core/...)
    const extSubMatch = p.match(/^ext\/([^/]+)\/([^/]+)\//);
    if (extSubMatch?.[1] && extSubMatch[2]) {
      const subExtTestDir = `ext/${extSubMatch[1]}/${extSubMatch[2]}/tests/phpunit`;
      if (worktreeRoot && addCandidate(subExtTestDir)) {
        continue;
      }
    }

    const extMatch = p.match(/^ext\/([^/]+)\//);
    if (extMatch?.[1]) {
      const extTestDir = `ext/${extMatch[1]}/tests/phpunit`;
      addCandidate(extTestDir);
    }
  }
  return Array.from(targets).slice(0, 3);
}

export function buildCkAbName(workDir: string, checkName: string): string {
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

export function matchesPhpUnitMethod(testCaseName: string, method: string): boolean {
  const marker = `::${method}`;
  const idx = testCaseName.indexOf(marker);
  if (idx === -1) return false;
  const after = testCaseName.slice(idx + marker.length);
  return after === '' || after.startsWith(' with data set') || after.startsWith('#');
}

export function shellQuote(arg: string): string {
  return `'${arg.replaceAll("'", "'\\''")}'`;
}

export function findEnclosingModifiedTestMethods(
  targetDiff: DiffFile,
  worktreeRoot?: string,
): string[] {
  return enclosingTestMethods(targetDiff, worktreeRoot).methods;
}

/** `outsideTest` is set when a hunk starts in a helper, where no method filter is safe. */
function enclosingTestMethods(
  targetDiff: DiffFile,
  worktreeRoot?: string,
): { methods: string[]; outsideTest: boolean } {
  const none = { methods: [], outsideTest: false };
  if (!worktreeRoot) return none;
  const fullPath = join(worktreeRoot, targetDiff.path);
  if (!existsSync(fullPath)) return none;
  let lines: string[];
  try {
    lines = readFileSync(fullPath, 'utf8').split(/\r?\n/);
  } catch {
    return none;
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
        return { methods: [], outsideTest: true };
      }
    }
  }
  return { methods: Array.from(found), outsideTest: false };
}

export function buildPerFileFilterArgs(
  targetPath: string,
  diffFiles: DiffFile[],
  addedTestMethods: AddedTestMethod[],
  worktreeB?: string,
): string[] {
  const targetDiff = diffFiles.find((f) => f.path === targetPath);
  if (!targetDiff || targetDiff.status !== 'modified') return [];
  const added = Array.from(
    new Set(addedTestMethods.filter((m) => m.file === targetPath).map((m) => m.method)),
  );
  // Added methods alone would leave out an existing test the PR also changes; a change
  // in a helper can affect any test, so then the whole file runs.
  const enclosing = enclosingTestMethods(targetDiff, worktreeB);
  if (enclosing.outsideTest) return [];
  const methods = Array.from(new Set([...added, ...enclosing.methods]));
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
    return [runnerBin, '--log-junit', '/tmp/ck-ab.xml', ...(only.filterArgs ?? []), only.path];
  }

  const lines: string[] = [
    'rm -f /tmp/ck-ab.xml /tmp/ck-ab-part-*.xml',
    '_ck_run() { if command -v timeout >/dev/null 2>&1; then timeout -k 10 120 "$@"; else "$@"; fi; }',
    'rc=0',
  ];
  targets.forEach((t, idx) => {
    const partXml = `/tmp/ck-ab-part-${idx}.xml`;
    const filterPart = (t.filterArgs ?? []).map(shellQuote).join(' ');
    const filteredCmd = [
      '_ck_run',
      runnerBin,
      '--log-junit',
      partXml,
      ...(filterPart ? [filterPart] : []),
      shellQuote(t.path),
    ].join(' ');
    lines.push(`${filteredCmd} || rc=$?`);
    if (filterPart) {
      const unfilteredCmd = `_ck_run ${runnerBin} --log-junit ${partXml} ${shellQuote(t.path)}`;
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

export function buildProofOfFixFilterArgs(
  targetFiles: string[],
  diffFiles: DiffFile[],
  addedTestMethods: AddedTestMethod[],
): string[] {
  if (targetFiles.length !== 1) return [];
  return buildPerFileFilterArgs(targetFiles[0]!, diffFiles, addedTestMethods);
}

export function stripFilterArgs(cmd: string[]): string[] {
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

export const CORE_COMPOSER_FILES = ['composer.json', 'composer.lock'];
/** Composer's post-install scripts; the release tarball images lack them. */
const CORE_COMPOSER_SCRIPTS = 'tools/scripts/composer';

export function isCoreComposerFile(filePath: string): boolean {
  return CORE_COMPOSER_FILES.includes(filePath);
}

export function isMountableCorePath(filePath: string): boolean {
  if (!filePath || filePath.startsWith('/') || filePath.includes('..')) {
    return false;
  }
  return /^(CRM|Civi|api|ext|schema|sql|templates|xml|ang|css|js|mixin|packages|tests)\//.test(
    filePath,
  );
}

export function isCoreTestPath(filePath: string): boolean {
  return filePath.startsWith('tests/') || /^ext\/[^/]+(?:\/[^/]+)*\/tests\//.test(filePath);
}

export interface CoreMountPlan {
  abMounts: string[];
  mountsAOnly: string[];
  mountsBOnly: string[];
  proofTestMounts: string[];
  baseTestMounts: string[];
  useFileMounts: boolean;
  /** Files the base lacks that stay visible from the image. */
  staleImageFiles: string[];
  /** PR-deleted or renamed-away files of extensions with build output; B still sees the image's copy. */
  prDeletedImageFiles: string[];
}

/**
 * `ext/<name>` directories whose image copy holds files git does not track:
 * composer downloads declared in core's composer.json, compiled assets.
 * Undefined when the base's composer.json cannot be read.
 */
function extDirsWithBuildOutput(worktreeA: string): Set<string> | undefined {
  let downloads: Record<string, { path?: unknown }>;
  try {
    const composer = JSON.parse(readFileSync(join(worktreeA, 'composer.json'), 'utf8'));
    downloads = composer?.extra?.downloads ?? {};
  } catch {
    return undefined;
  }
  const dirs = new Set<string>();
  for (const d of Object.values(downloads)) {
    if (typeof d?.path === 'string' && d.path.startsWith('ext/')) {
      dirs.add(d.path.split('/').slice(0, 2).join('/'));
    }
  }
  return dirs;
}

/**
 * Maps a drifted path to what is mounted for it: its top-level directory, its
 * `ext/<name>` directory, or the file itself for `tests/` and for extensions
 * with build output, whose directory mount would hide that output.
 */
function driftUnitMapper(worktreeA: string): (p: string) => { unit: string; isDir: boolean } {
  const buildOutput = extDirsWithBuildOutput(worktreeA);
  return (p) => {
    if (p.startsWith('ext/')) {
      const ext = p.split('/').slice(0, 2).join('/');
      const singly =
        !buildOutput ||
        buildOutput.has(ext) ||
        existsSync(join(worktreeA, ext, 'composer.compile.json'));
      return singly ? { unit: p, isDir: false } : { unit: ext, isDir: true };
    }
    if (isCoreTestPath(p)) return { unit: p, isDir: false };
    return { unit: p.split('/')[0] ?? p, isDir: true };
  };
}

/**
 * Mount specs that bring the image's core up to the base from `worktreeA`, and
 * the single-mounted `ext/` files the base deleted, which stay in the image.
 * Deleted test files stay too; nothing targets them.
 */
function baseDriftMounts(
  driftFiles: string[],
  worktreeA: string,
  unitOf: (p: string) => { unit: string; isDir: boolean },
  skip: (path: string) => boolean,
): { specs: string[]; staleImageFiles: string[] } {
  const specs = new Set<string>();
  const staleImageFiles: string[] = [];
  for (const p of driftFiles) {
    if (!isMountableCorePath(p) || skip(p)) continue;
    const { unit } = unitOf(p);
    if (existsSync(join(worktreeA, unit))) {
      specs.add(`${join(worktreeA, unit)}:/var/www/html/core/${unit}:ro`);
    } else if (p.startsWith('ext/') && !isCoreTestPath(p)) {
      staleImageFiles.push(p);
    }
  }
  return { specs: Array.from(specs), staleImageFiles };
}

/**
 * Computes Docker bind-mount arguments for a `civicrm-core` PR: per-file mounts
 * for small PRs (<= 40 files, no deletes/renames), touched directories
 * otherwise. `baseDriftFiles`, the paths in which the image's core differs from
 * the base, come from `worktreeA` into both A and B, so A runs on the base.
 */
export function buildCoreMountPlan(
  diffFiles: DiffFile[],
  touchedComponents: string[],
  worktreeA: string,
  worktreeB: string,
  baseDriftFiles: string[] = [],
): CoreMountPlan {
  const abMounts: string[] = [];
  const mountsAOnly: string[] = [];
  const mountsBOnly: string[] = [];
  let proofTestMounts: string[] = [];
  let baseTestMounts: string[] = [];
  let staleImageFiles: string[] = [];
  const prDeletedImageFiles: string[] = [];

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
  // A file the base lacks has no mount point inside a read-only directory mount.
  const unitOf = driftUnitMapper(worktreeA);
  const driftDirs = new Set(
    baseDriftFiles
      .filter(isMountableCorePath)
      .map(unitOf)
      .filter((u) => u.isDir)
      .map((u) => u.unit),
  );
  const addedUnderDriftDir = mountableCoreFiles.some(
    (f) =>
      !existsSync(join(worktreeA, f.path)) &&
      Array.from(driftDirs).some((d) => f.path.startsWith(`${d}/`)),
  );
  const useFileMounts =
    mountableCoreFiles.length > 0 &&
    mountableCoreFiles.length <= 40 &&
    !hasDeletedCoreFile &&
    allFilesMaterialized &&
    !addedUnderDriftDir;

  const addShared = (spec: string) => {
    abMounts.push('--mount', spec);
    mountsAOnly.push('--mount', spec);
    mountsBOnly.push('--mount', spec);
  };

  // Each side gets its composer files; the image syncs vendor/ to ones it was not installed from.
  const prComposer = diffFiles.some((f) => isCoreComposerFile(f.path));
  const driftComposer = baseDriftFiles.some(isCoreComposerFile);
  for (const f of [...CORE_COMPOSER_FILES, CORE_COMPOSER_SCRIPTS]) {
    const specA = `${join(worktreeA, f)}:/var/www/html/core/${f}:ro`;
    const specB = `${join(worktreeB, f)}:/var/www/html/core/${f}:ro`;
    if (prComposer) {
      if (existsSync(join(worktreeA, f))) {
        abMounts.push('--mount-a', specA);
        mountsAOnly.push('--mount', specA);
      }
      if (existsSync(join(worktreeB, f))) {
        abMounts.push('--mount-b', specB);
        mountsBOnly.push('--mount', specB);
      }
    } else if (driftComposer && existsSync(join(worktreeA, f))) {
      addShared(specA);
    }
  }

  if (useFileMounts) {
    const prPaths = new Set(diffFiles.map((f) => f.path));
    // A PR path the base lacks stays the drift's business: A must not see the image's copy.
    const drift = baseDriftMounts(
      baseDriftFiles,
      worktreeA,
      unitOf,
      (p) => prPaths.has(p) && existsSync(join(worktreeA, p)),
    );
    drift.specs.forEach(addShared);
    staleImageFiles = drift.staleImageFiles;

    for (const f of coreProdFiles) {
      if (existsSync(join(worktreeA, f.path))) {
        abMounts.push('--mount-a', `${join(worktreeA, f.path)}:/var/www/html/core/${f.path}:ro`);
        mountsAOnly.push('--mount', `${join(worktreeA, f.path)}:/var/www/html/core/${f.path}:ro`);
      }
      if (existsSync(join(worktreeB, f.path))) {
        abMounts.push('--mount-b', `${join(worktreeB, f.path)}:/var/www/html/core/${f.path}:ro`);
        mountsBOnly.push('--mount', `${join(worktreeB, f.path)}:/var/www/html/core/${f.path}:ro`);
      }
    }
    const isTestOnlyPr = coreProdFiles.length === 0 && !prComposer && coreTestFiles.length > 0;
    for (const f of coreTestFiles) {
      if (isE2eMinkTestPath(f.path)) continue;
      if (isTestOnlyPr) {
        // Test-only PR (0 production files changed): mount base A's test into A and PR B's test into B
        // so `ck ab` compares old vs refactored test instead of exiting 2 ("same mounts; nothing to compare").
        if (existsSync(join(worktreeA, f.path))) {
          proofTestMounts.push(
            '--mount-a',
            `${join(worktreeA, f.path)}:/var/www/html/core/${f.path}:ro`,
          );
          baseTestMounts.push(
            '--mount-a',
            `${join(worktreeA, f.path)}:/var/www/html/core/${f.path}:ro`,
          );
        }
        if (existsSync(join(worktreeB, f.path))) {
          proofTestMounts.push(
            '--mount-b',
            `${join(worktreeB, f.path)}:/var/www/html/core/${f.path}:ro`,
          );
          baseTestMounts.push(
            '--mount-b',
            `${join(worktreeB, f.path)}:/var/www/html/core/${f.path}:ro`,
          );
        }
      } else {
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
    }
  } else {
    // Extensions with build output keep their image directory; their PR files are mounted singly.
    const dirs = new Set(touchedComponents.filter((d) => unitOf(`${d}/`).isDir));
    const singlyMounted = mountableCoreFiles.filter(
      (f) => f.path.startsWith('ext/') && !unitOf(f.path).isDir,
    );
    for (const f of coreProdFiles) {
      const { unit, isDir } = unitOf(f.path);
      if (isDir) dirs.add(unit);
    }
    // A test-only PR compares the base's tests on A with the PR's on B.
    const testOnly = coreProdFiles.length === 0 && !prComposer;
    const extTestMounts = { proof: [] as string[], base: [] as string[] };
    for (const f of singlyMounted) {
      const pathA = f.oldPath ?? f.path;
      const specA = `${join(worktreeA, pathA)}:/var/www/html/core/${pathA}:ro`;
      const specB = `${join(worktreeB, f.path)}:/var/www/html/core/${f.path}:ro`;
      const inA = existsSync(join(worktreeA, pathA));
      const inB = existsSync(join(worktreeB, f.path));
      if (isCoreTestPath(f.path)) {
        if (testOnly) {
          const sides = [
            ...(inA ? ['--mount-a', specA] : []),
            ...(inB ? ['--mount-b', specB] : []),
          ];
          extTestMounts.proof.push(...sides);
          extTestMounts.base.push(...sides);
        } else {
          if (inB) extTestMounts.proof.push('--mount', specB);
          if (inA) extTestMounts.base.push('--mount', specA);
        }
        continue;
      }
      if (inA) {
        abMounts.push('--mount-a', specA);
        mountsAOnly.push('--mount', specA);
      }
      if (inB) {
        abMounts.push('--mount-b', specB);
        mountsBOnly.push('--mount', specB);
      }
      if (inA && (!inB || pathA !== f.path)) prDeletedImageFiles.push(pathA);
    }
    // Keep CRM/ and Civi/ in lockstep when falling back to directory mounts
    if (dirs.has('CRM') || dirs.has('Civi')) {
      dirs.add('CRM');
      dirs.add('Civi');
    }
    const prPaths = new Set(
      singlyMounted
        .flatMap((f) => [f.path, f.oldPath ?? f.path])
        .filter((p) => existsSync(join(worktreeA, p))),
    );
    const ownMount = (p: string) =>
      p.startsWith('tests/') ||
      prPaths.has(p) ||
      Array.from(dirs).some((d) => p === d || p.startsWith(`${d}/`));
    const drift = baseDriftMounts(baseDriftFiles, worktreeA, unitOf, ownMount);
    drift.specs.forEach(addShared);
    staleImageFiles = drift.staleImageFiles;
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
    const testsA = `${join(worktreeA, 'tests')}:/var/www/html/core/tests:ro`;
    const testsB = `${join(worktreeB, 'tests')}:/var/www/html/core/tests:ro`;
    const hasA = existsSync(join(worktreeA, 'tests'));
    const hasB = existsSync(join(worktreeB, 'tests'));
    if (testOnly) {
      const sides = [
        ...(hasA ? ['--mount-a', testsA] : []),
        ...(hasB ? ['--mount-b', testsB] : []),
      ];
      proofTestMounts = [...sides];
      baseTestMounts = [...sides];
    } else {
      if (hasB) proofTestMounts = ['--mount', testsB];
      if (hasA) baseTestMounts = ['--mount', testsA];
    }
    proofTestMounts.push(...extTestMounts.proof);
    baseTestMounts.push(...extTestMounts.base);
  }

  return {
    abMounts,
    mountsAOnly,
    mountsBOnly,
    proofTestMounts,
    baseTestMounts,
    useFileMounts,
    staleImageFiles,
    prDeletedImageFiles,
  };
}
