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
  const methods =
    added.length > 0 ? added : findEnclosingModifiedTestMethods(targetDiff, worktreeB);
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
}

const MAX_STALE_OVERLAY_FILES = 50;

/**
 * Computes Docker bind-mount arguments for a `civicrm-core` PR, preferring
 * surgical per-file mounts (<= 40 files, no deletes/renames) to avoid
 * clobbering image-generated GenCode files.
 *
 * Optional `extraBaseFiles` (e.g. files merged to `baseSha` after the Docker
 * image was built) are mounted from `worktreeA` into both A and B so a PR
 * depending on a recently-merged class/method still runs cleanly without
 * rebuilding the Docker image.
 */
export function buildCoreMountPlan(
  diffFiles: DiffFile[],
  touchedComponents: string[],
  worktreeA: string,
  worktreeB: string,
  extraBaseFiles: string[] = [],
): CoreMountPlan {
  const abMounts: string[] = [];
  const mountsAOnly: string[] = [];
  const mountsBOnly: string[] = [];
  let proofTestMounts: string[] = [];
  let baseTestMounts: string[] = [];

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

  if (useFileMounts) {
    const prPaths = new Set(diffFiles.map((f) => f.path));
    const overlayFiles = Array.from(new Set(extraBaseFiles))
      .filter(
        (p) =>
          isMountableCorePath(p) &&
          !isE2eMinkTestPath(p) &&
          !prPaths.has(p) &&
          !/^CRM\/[^/]+\/DAO\//.test(p) &&
          existsSync(join(worktreeA, p)),
      )
      .slice(0, MAX_STALE_OVERLAY_FILES);
    for (const p of overlayFiles) {
      const mountSpec = `${join(worktreeA, p)}:/var/www/html/core/${p}:ro`;
      abMounts.push('--mount', mountSpec);
      mountsAOnly.push('--mount', mountSpec);
      mountsBOnly.push('--mount', mountSpec);
    }

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
    const isTestOnlyPr = coreProdFiles.length === 0 && coreTestFiles.length > 0;
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
    const dirs = new Set(touchedComponents);
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
      proofTestMounts = ['--mount', `${join(worktreeB, 'tests')}:/var/www/html/core/tests:ro`];
    }
    if (existsSync(join(worktreeA, 'tests'))) {
      baseTestMounts = ['--mount', `${join(worktreeA, 'tests')}:/var/www/html/core/tests:ro`];
    }
  }

  return {
    abMounts,
    mountsAOnly,
    mountsBOnly,
    proofTestMounts,
    baseTestMounts,
    useFileMounts,
  };
}
