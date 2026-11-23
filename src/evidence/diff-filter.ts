import type { DiffFile, DiffFileStatus, DiffHunk, FileSurfaceFlags } from './types.ts';

const NOISE_EXACT_BASENAMES = new Set([
  'composer.lock',
  'package-lock.json',
  'yarn.lock',
  'pnpm-lock.yaml',
  'bun.lock',
  'bun.lockb',
  'npm-shrinkwrap.json',
]);

const NOISE_PATH_PREFIXES = ['vendor/', 'node_modules/', 'bower_components/', 'dist/', '.yarn/'];

const NOISE_EXTENSIONS = [
  '.min.js',
  '.min.css',
  '.js.map',
  '.css.map',
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.ico',
  '.woff',
  '.woff2',
  '.ttf',
  '.eot',
  '.otf',
  '.pdf',
  '.zip',
  '.tar.gz',
  '.phar',
];

/**
 * Returns true if `filePath` is noisy generated/vendored/lockfile/binary content
 * that should be excluded from LLM review diffs.
 */
export function isNoiseFile(filePath: string): boolean {
  const normalized = filePath.replaceAll('\\', '/').replace(/^\.\//, '');
  const base = normalized.split('/').pop() ?? normalized;

  if (NOISE_EXACT_BASENAMES.has(base)) {
    return true;
  }
  for (const prefix of NOISE_PATH_PREFIXES) {
    if (normalized.startsWith(prefix) || normalized.includes(`/${prefix}`)) {
      return true;
    }
  }
  const lower = normalized.toLowerCase();
  for (const ext of NOISE_EXTENSIONS) {
    if (lower.endsWith(ext)) {
      return true;
    }
  }
  return false;
}

/**
 * Classifies a repository-relative path into CiviCRM surface flags.
 */
export function classifyFilePath(filePath: string): FileSurfaceFlags {
  const p = filePath.replaceAll('\\', '/').replace(/^\.\//, '');
  const lower = p.toLowerCase();

  const isComposer =
    p === 'composer.json' ||
    p === 'composer.lock' ||
    p.endsWith('/composer.json') ||
    p.endsWith('/composer.lock');

  const isSchema =
    p.startsWith('xml/schema/') ||
    p.includes('/xml/schema/') ||
    /^schema\/.*\.entityType\.php$/i.test(p) ||
    /\/schema\/.*\.entityType\.php$/i.test(p);

  const isUpgrade =
    p.startsWith('CRM/Upgrade/') || p.includes('/CRM/Upgrade/') || /(^|\/)Upgrader\.php$/.test(p);

  const isManaged = p.startsWith('managed/') || p.includes('/managed/');

  const isSmartyTemplate = lower.endsWith('.tpl');
  const isAfform =
    lower.endsWith('.aff.html') ||
    lower.endsWith('.aff.json') ||
    p.includes('/afform/') ||
    p.startsWith('ang/');

  const isFrontendAsset =
    isSmartyTemplate ||
    isAfform ||
    lower.endsWith('.js') ||
    lower.endsWith('.ts') ||
    lower.endsWith('.tsx') ||
    lower.endsWith('.jsx') ||
    lower.endsWith('.css') ||
    lower.endsWith('.scss') ||
    lower.endsWith('.html');

  const isTest =
    p.startsWith('tests/') ||
    p.includes('/tests/') ||
    p.endsWith('Test.php') ||
    /\.(test|spec)\.(ts|tsx|js|jsx)$/.test(lower);

  const isMenuXml =
    (p.startsWith('xml/Menu/') || p.includes('/xml/Menu/')) && lower.endsWith('.xml');

  const isApiV4 =
    (p.startsWith('Civi/Api4/') || p.includes('/Civi/Api4/')) && lower.endsWith('.php');

  const isDocsOnly =
    lower.endsWith('.md') ||
    lower.endsWith('.rst') ||
    lower.endsWith('.txt') ||
    p.startsWith('docs/');

  return {
    isComposer,
    isSchema,
    isUpgrade,
    isManaged,
    isSmartyTemplate,
    isAfform,
    isFrontendAsset,
    isTest,
    isMenuXml,
    isApiV4,
    isDocsOnly,
  };
}

const HUNK_HEADER_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/;

function stripGitPrefix(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.startsWith('a/') || trimmed.startsWith('b/')) {
    return trimmed.slice(2);
  }
  return trimmed;
}

function parseHeaderPaths(line: string): { oldPath: string; newPath: string } {
  // Format: diff --git a/foo b/bar (possibly quoted)
  const rest = line.slice('diff --git '.length).trim();
  const quotedMatch = rest.match(/^"a\/(.+?)" "b\/(.+?)"$/);
  if (quotedMatch && quotedMatch[1] && quotedMatch[2]) {
    return { oldPath: quotedMatch[1], newPath: quotedMatch[2] };
  }
  const spaceIdx = rest.indexOf(' b/');
  if (spaceIdx !== -1) {
    const left = rest.slice(0, spaceIdx);
    const right = rest.slice(spaceIdx + 1);
    return {
      oldPath: stripGitPrefix(left),
      newPath: stripGitPrefix(right),
    };
  }
  const parts = rest.split(/\s+/);
  return {
    oldPath: stripGitPrefix(parts[0] ?? ''),
    newPath: stripGitPrefix(parts[1] ?? parts[0] ?? ''),
  };
}

/**
 * Parses a git unified diff string into structured `DiffFile` entries with
 * per-hunk ranges and exact valid right/left line numbers for inline comments.
 */
export function parseUnifiedDiff(diffText: string): DiffFile[] {
  if (!diffText.trim()) return [];

  const lines = diffText.split(/\r?\n/);
  const files: DiffFile[] = [];

  let currentLines: string[] = [];
  const flushFile = () => {
    if (currentLines.length === 0) return;
    const parsed = parseSingleFileDiff(currentLines);
    if (parsed) {
      files.push(parsed);
    }
    currentLines = [];
  };

  for (const line of lines) {
    if (line.startsWith('diff --git ')) {
      flushFile();
    }
    if (currentLines.length > 0 || line.startsWith('diff --git ')) {
      currentLines.push(line);
    }
  }
  flushFile();

  return files;
}

function parseSingleFileDiff(lines: string[]): DiffFile | null {
  const firstLine = lines[0];
  if (!firstLine || !firstLine.startsWith('diff --git ')) {
    return null;
  }

  let { oldPath, newPath } = parseHeaderPaths(firstLine);
  let status: DiffFileStatus = 'modified';
  let isBinary = false;
  let additions = 0;
  let deletions = 0;

  const hunks: DiffHunk[] = [];
  const validRightLines: number[] = [];
  const validLeftLines: number[] = [];

  let currentHunk: DiffHunk | null = null;
  let leftCursor = 0;
  let rightCursor = 0;

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i] ?? '';

    if (currentHunk === null) {
      if (line.startsWith('new file mode ')) {
        status = 'added';
        continue;
      }
      if (line.startsWith('deleted file mode ')) {
        status = 'deleted';
        continue;
      }
      if (line.startsWith('rename from ')) {
        status = 'renamed';
        oldPath = line.slice('rename from '.length).trim();
        continue;
      }
      if (line.startsWith('rename to ')) {
        status = 'renamed';
        newPath = line.slice('rename to '.length).trim();
        continue;
      }
      if (line.startsWith('Binary files ') || line === 'GIT binary patch') {
        isBinary = true;
        continue;
      }
      if (line.startsWith('--- ')) {
        const candidate = line.slice(4).trim();
        if (candidate !== '/dev/null') {
          oldPath = stripGitPrefix(candidate);
        }
        continue;
      }
      if (line.startsWith('+++ ')) {
        const candidate = line.slice(4).trim();
        if (candidate !== '/dev/null') {
          newPath = stripGitPrefix(candidate);
        }
        continue;
      }
    }

    const hunkMatch = line.match(HUNK_HEADER_RE);
    if (hunkMatch) {
      const oldStart = Number(hunkMatch[1]);
      const oldCount = hunkMatch[2] !== undefined ? Number(hunkMatch[2]) : 1;
      const newStart = Number(hunkMatch[3]);
      const newCount = hunkMatch[4] !== undefined ? Number(hunkMatch[4]) : 1;
      currentHunk = {
        header: line,
        oldStart,
        oldCount,
        newStart,
        newCount,
        lines: [],
      };
      hunks.push(currentHunk);
      leftCursor = oldStart;
      rightCursor = newStart;
      continue;
    }

    if (currentHunk) {
      if (line === '' && i === lines.length - 1) {
        // Trailing newline after split('\n') is not a hunk context line
        continue;
      }
      currentHunk.lines.push(line);
      if (line.startsWith('+')) {
        additions++;
        if (rightCursor > 0) validRightLines.push(rightCursor);
        rightCursor++;
      } else if (line.startsWith('-')) {
        deletions++;
        if (leftCursor > 0) validLeftLines.push(leftCursor);
        leftCursor++;
      } else if (line.startsWith('\\')) {
        // "\ No newline at end of file" — does not advance cursors
      } else if (line.startsWith(' ')) {
        if (leftCursor > 0) validLeftLines.push(leftCursor);
        if (rightCursor > 0) validRightLines.push(rightCursor);
        leftCursor++;
        rightCursor++;
      }
    }
  }

  const effectivePath = status === 'deleted' ? oldPath : newPath || oldPath;

  return {
    path: effectivePath,
    oldPath: oldPath !== effectivePath ? oldPath : undefined,
    status,
    isBinary,
    additions,
    deletions,
    hunks,
    validRightLines,
    validLeftLines,
    flags: classifyFilePath(effectivePath),
    rawPatch: lines.join('\n'),
  };
}

export interface AddedTestMethod {
  file: string;
  method: string;
  line: number;
}

const ADDED_PHPUNIT_TEST_METHOD_RE = /^\+\s*(?:public\s+)?function\s+(test[A-Za-z0-9_]+)\s*\(/;

/**
 * Extracts newly added PHPUnit test methods (with their right-side line numbers)
 * from test files in the parsed diff.
 */
export function extractAddedTestMethods(diffFiles: DiffFile[]): AddedTestMethod[] {
  const results: AddedTestMethod[] = [];

  for (const file of diffFiles) {
    if (!file.flags.isTest || file.status === 'deleted') {
      continue;
    }

    for (const hunk of file.hunks) {
      let rightCursor = hunk.newStart;
      for (const line of hunk.lines) {
        if (line.startsWith('+')) {
          const match = line.match(ADDED_PHPUNIT_TEST_METHOD_RE);
          if (match?.[1] && rightCursor > 0) {
            results.push({
              file: file.path,
              method: match[1],
              line: rightCursor,
            });
          }
          rightCursor++;
        } else if (line.startsWith(' ')) {
          rightCursor++;
        }
        // '-' and '\ No newline at end of file' do not advance rightCursor
      }
    }
  }

  return results;
}

export interface FilteredDiffResult {
  files: DiffFile[];
  droppedNoiseFiles: string[];
  filteredPatch: string;
  truncated: boolean;
}

export interface DiffPathFilters {
  include?: string[];
  exclude?: string[];
}

function normalizeRelPath(p: string): string {
  return p.replaceAll('\\', '/').replace(/^\.\//, '');
}

/**
 * Compiles a repo-relative glob pattern (`*`, `**`, `?`) into a RegExp.
 */
export function globToRegExp(pattern: string): RegExp {
  let pat = normalizeRelPath(pattern.trim());
  if (pat.endsWith('/')) {
    pat = `${pat}**`;
  }

  let regex = '^';
  let i = 0;
  while (i < pat.length) {
    if (pat.startsWith('**/', i)) {
      regex += '(?:.+/)?';
      i += 3;
      continue;
    }
    if (pat.startsWith('/**', i)) {
      regex += '(?:/.*)';
      i += 3;
      continue;
    }
    if (pat.startsWith('**', i)) {
      regex += '.*';
      i += 2;
      continue;
    }
    const ch = pat[i]!;
    if (ch === '*') {
      regex += '[^/]*';
    } else if (ch === '?') {
      regex += '[^/]';
    } else if (/[.+^${}()|[\]\\]/.test(ch)) {
      regex += `\\${ch}`;
    } else {
      regex += ch;
    }
    i++;
  }
  regex += '$';
  return new RegExp(regex);
}

/**
 * Returns true if `filePath` matches the glob `pattern` (`*`, `**`, `?`).
 */
export function matchesGlob(filePath: string, pattern: string): boolean {
  if (!pattern.trim()) return false;
  return globToRegExp(pattern).test(normalizeRelPath(filePath));
}

/**
 * Parses a unified diff, drops noise/binary/lock/vendor files and optional
 * path include/exclude globs, and bounds the assembled patch text to `maxBytes`.
 */
export function filterAndTruncateDiff(
  diffText: string,
  maxBytes: number,
  pathFilters?: DiffPathFilters,
): FilteredDiffResult {
  const parsed = parseUnifiedDiff(diffText);
  const files: DiffFile[] = [];
  const droppedNoiseFiles: string[] = [];

  const includes = (pathFilters?.include ?? []).filter((p) => p.trim().length > 0);
  const excludes = (pathFilters?.exclude ?? []).filter((p) => p.trim().length > 0);

  for (const file of parsed) {
    if (file.isBinary || isNoiseFile(file.path)) {
      droppedNoiseFiles.push(file.path);
      continue;
    }
    if (excludes.some((pat) => matchesGlob(file.path, pat))) {
      droppedNoiseFiles.push(file.path);
      continue;
    }
    if (includes.length > 0 && !includes.some((pat) => matchesGlob(file.path, pat))) {
      droppedNoiseFiles.push(file.path);
      continue;
    }
    files.push(file);
  }

  const patchChunks: string[] = [];
  let currentBytes = 0;
  let truncated = false;

  for (const file of files) {
    const chunk = file.rawPatch;
    const chunkBytes = Buffer.byteLength(chunk, 'utf8') + 1;
    if (currentBytes + chunkBytes > maxBytes) {
      truncated = true;
      const remaining = maxBytes - currentBytes;
      if (remaining > 256) {
        const slice = Buffer.from(chunk, 'utf8')
          .subarray(0, remaining - 64)
          .toString('utf8');
        patchChunks.push(`${slice}\n... [TRUNCATED: exceeded ${maxBytes} bytes]`);
      }
      break;
    }
    patchChunks.push(chunk);
    currentBytes += chunkBytes;
  }

  return {
    files,
    droppedNoiseFiles,
    filteredPatch: patchChunks.join('\n'),
    truncated,
  };
}
