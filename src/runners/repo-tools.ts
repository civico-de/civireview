import {
  existsSync,
  lstatSync,
  readdirSync,
  readFileSync,
  realpathSync,
} from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { tool, type ToolSet } from 'ai';
import { z } from 'zod';

const MAX_OUTPUT_CHARS = 16_000;

function truncateOutput(text: string, limit = MAX_OUTPUT_CHARS): string {
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}\n... [truncated at ${limit} chars]`;
}

/**
 * Resolves a relative path inside `cwd`, blocking path traversal (`..`),
 * absolute paths outside `cwd`, null bytes, and symlink escapes.
 */
export function resolveSafeRepoPath(cwd: string, targetPath: string): string {
  if (!targetPath || targetPath.includes('\0')) {
    throw new Error(`Invalid repository path: "${targetPath}"`);
  }
  if (isAbsolute(targetPath)) {
    throw new Error(`Absolute paths are not allowed: "${targetPath}"`);
  }

  const realRoot = realpathSync(cwd);
  const candidate = resolve(realRoot, targetPath);

  if (candidate !== realRoot && !candidate.startsWith(realRoot + sep)) {
    throw new Error(`Path escapes repository root: "${targetPath}"`);
  }

  if (existsSync(candidate) || isSymlink(candidate)) {
    const realTarget = realpathSync(candidate);
    if (realTarget !== realRoot && !realTarget.startsWith(realRoot + sep)) {
      throw new Error(`Symlink escapes repository root: "${targetPath}"`);
    }
    return realTarget;
  }

  return candidate;
}

function isSymlink(p: string): boolean {
  try {
    return lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
}

function assertSafeGitArg(arg: string, label: string): string {
  if (!arg || arg.includes('\0') || arg.startsWith('-')) {
    throw new Error(`Unsafe git ${label}: "${arg}"`);
  }
  return arg;
}

async function execReadOnlyGit(cwd: string, args: string[]): Promise<string> {
  const realRoot = realpathSync(cwd);
  const proc = Bun.spawn(['git', '-C', realRoot, ...args], {
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (exitCode !== 0) {
    return `git error (${exitCode}): ${truncateOutput(stderr.trim(), 1000)}`;
  }
  return truncateOutput(stdout);
}

function walkFiles(
  root: string,
  dir: string,
  results: string[],
  limit: number,
): void {
  if (results.length >= limit) return;
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (results.length >= limit) return;
    if (
      entry.name === '.git' ||
      entry.name === 'node_modules' ||
      entry.name === 'vendor'
    ) {
      continue;
    }
    const full = join(dir, entry.name);
    if (entry.isSymbolicLink()) {
      try {
        const real = realpathSync(full);
        if (real !== root && !real.startsWith(root + sep)) continue;
      } catch {
        continue;
      }
    }
    if (entry.isDirectory()) {
      walkFiles(root, full, results, limit);
    } else if (entry.isFile()) {
      results.push(relative(root, full));
    }
  }
}

/**
 * Creates a read-only, strictly sandboxed `ToolSet` for AI SDK runners.
 * Zero write or arbitrary command execution capabilities are exposed.
 */
export function createRepoTools(cwd: string): ToolSet {
  const realRoot = realpathSync(cwd);

  return {
    read_file: tool({
      description:
        'Read lines from a file inside the repository. Returns line-numbered text.',
      inputSchema: z.object({
        path: z.string().describe('Repository-relative file path'),
        startLine: z.number().int().positive().optional(),
        endLine: z.number().int().positive().optional(),
      }),
      execute: async ({ path, startLine, endLine }) => {
        const safePath = resolveSafeRepoPath(realRoot, path);
        const content = readFileSync(safePath, 'utf8');
        const allLines = content.split(/\r?\n/);
        const start = Math.max(1, startLine ?? 1);
        const end = Math.min(allLines.length, endLine ?? start + 250);
        const slice = allLines
          .slice(start - 1, end)
          .map((l, idx) => `${start + idx}: ${l}`)
          .join('\n');
        return truncateOutput(slice);
      },
    }),

    grep_repo: tool({
      description:
        'Search repository files for a regex or literal pattern (read-only).',
      inputSchema: z.object({
        pattern: z.string().min(1).describe('Search pattern'),
        subpath: z
          .string()
          .optional()
          .describe('Optional repository-relative directory or file'),
        fixedStrings: z.boolean().optional(),
        maxMatches: z.number().int().positive().max(100).optional(),
      }),
      execute: async ({ pattern, subpath, fixedStrings, maxMatches }) => {
        const searchRoot = subpath
          ? resolveSafeRepoPath(realRoot, subpath)
          : realRoot;
        const cap = maxMatches ?? 40;
        const args = [
          'rg',
          '--no-heading',
          '--line-number',
          '--max-count',
          '10',
          '--glob',
          '!.git/**',
          '--glob',
          '!vendor/**',
          '--glob',
          '!node_modules/**',
        ];
        if (fixedStrings) args.push('--fixed-strings');
        args.push('--', pattern, searchRoot);

        try {
          const proc = Bun.spawn(args, { stdout: 'pipe', stderr: 'pipe' });
          const [stdout, exitCode] = await Promise.all([
            new Response(proc.stdout).text(),
            proc.exited,
          ]);
          if (exitCode === 1) return 'No matches found.';
          const lines = stdout
            .split(/\r?\n/)
            .filter(Boolean)
            .slice(0, cap)
            .map((line) =>
              line.startsWith(realRoot + sep)
                ? line.slice(realRoot.length + 1)
                : line,
            );
          return truncateOutput(lines.join('\n'));
        } catch {
          // Fallback JS search if rg is unavailable
          const files: string[] = [];
          walkFiles(realRoot, searchRoot, files, 500);
          const hits: string[] = [];
          const matcher = fixedStrings
            ? (line: string) => line.includes(pattern)
            : (() => {
                const re = new RegExp(pattern);
                return (line: string) => re.test(line);
              })();
          for (const rel of files) {
            if (hits.length >= cap) break;
            try {
              const text = readFileSync(join(realRoot, rel), 'utf8');
              const lines = text.split(/\r?\n/);
              for (let i = 0; i < lines.length; i++) {
                if (matcher(lines[i] ?? '')) {
                  hits.push(`${rel}:${i + 1}:${lines[i]}`);
                  if (hits.length >= cap) break;
                }
              }
            } catch {
              // ignore unreadable files
            }
          }
          return hits.length > 0
            ? truncateOutput(hits.join('\n'))
            : 'No matches found.';
        }
      },
    }),

    list_files: tool({
      description: 'List repository files under an optional relative directory.',
      inputSchema: z.object({
        subpath: z.string().optional(),
        limit: z.number().int().positive().max(500).optional(),
      }),
      execute: async ({ subpath, limit }) => {
        const target = subpath
          ? resolveSafeRepoPath(realRoot, subpath)
          : realRoot;
        const files: string[] = [];
        walkFiles(realRoot, target, files, limit ?? 200);
        return truncateOutput(files.join('\n') || '(no files)');
      },
    }),

    git_show: tool({
      description:
        'Show a file at a specific git revision (read-only, e.g. baseSha:path).',
      inputSchema: z.object({
        rev: z.string().min(1).describe('Git commit SHA or ref'),
        path: z.string().min(1).describe('Repository-relative file path'),
      }),
      execute: async ({ rev, path }) => {
        assertSafeGitArg(rev, 'revision');
        resolveSafeRepoPath(realRoot, path);
        return execReadOnlyGit(realRoot, ['show', `${rev}:${path}`]);
      },
    }),

    git_log: tool({
      description: 'Show recent git commit history for a file or the repository.',
      inputSchema: z.object({
        path: z.string().optional(),
        limit: z.number().int().positive().max(50).optional(),
      }),
      execute: async ({ path, limit }) => {
        const count = limit ?? 15;
        const args = ['log', `--max-count=${count}`, '--oneline'];
        if (path) {
          resolveSafeRepoPath(realRoot, path);
          args.push('--', path);
        }
        return execReadOnlyGit(realRoot, args);
      },
    }),
  };
}
