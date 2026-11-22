import type { VerifiedFinding } from './schemas.ts';
import type { DiffFile, DiffHunk } from '../evidence/types.ts';

export interface MappedInlineFinding {
  finding: VerifiedFinding;
  path: string;
  line: number;
  startLine?: number;
  side: 'RIGHT' | 'LEFT';
  suggestionBlock?: string;
  snapped: boolean;
}

export interface LineMappingResult {
  inlineFindings: MappedInlineFinding[];
  summaryOnlyFindings: VerifiedFinding[];
}

const SNAP_OFFSETS = [0, -1, 1, -2, 2] as const;
const MAX_SUGGESTION_LINES = 15;

function normalizePath(p: string): string {
  return p.replaceAll('\\', '/').replace(/^\.\//, '');
}

function getHunkIndexForLine(
  hunks: DiffHunk[],
  line: number,
  side: 'RIGHT' | 'LEFT',
): number {
  for (let i = 0; i < hunks.length; i++) {
    const h = hunks[i];
    if (!h) continue;
    const start = side === 'RIGHT' ? h.newStart : h.oldStart;
    const count = side === 'RIGHT' ? h.newCount : h.oldCount;
    if (count === 0) continue;
    if (line >= start && line < start + count) {
      return i;
    }
  }
  return -1;
}

function snapToValidLine(
  target: number,
  validSet: Set<number>,
  hunks: DiffHunk[],
  side: 'RIGHT' | 'LEFT',
  requiredHunkIdx?: number,
): { line: number; hunkIdx: number; offset: number } | null {
  for (const offset of SNAP_OFFSETS) {
    const candidate = target + offset;
    if (candidate <= 0 || !validSet.has(candidate)) continue;
    const hunkIdx = getHunkIndexForLine(hunks, candidate, side);
    if (hunkIdx === -1) continue;
    if (requiredHunkIdx !== undefined && hunkIdx !== requiredHunkIdx) {
      continue;
    }
    return { line: candidate, hunkIdx, offset };
  }
  return null;
}

export interface SanitizeSuggestionOptions {
  side: 'RIGHT' | 'LEFT';
  sameHunk: boolean;
  lineSpan: number;
  collapsedRange?: boolean;
}

/**
 * Validates and formats a GitHub `suggestion` fenced code block.
 * Only emitted when single-hunk, `side === 'RIGHT'`, and <= 15 lines.
 */
export function sanitizeSuggestionCode(
  rawCode: string | undefined,
  opts: SanitizeSuggestionOptions,
): string | undefined {
  if (!rawCode) return undefined;
  if (opts.side !== 'RIGHT' || !opts.sameHunk || opts.collapsedRange) {
    return undefined;
  }

  let cleaned = rawCode.replace(/\r\n/g, '\n');
  // Strip accidental outer ```suggestion or ``` fences from LLM output
  const fenceMatch = cleaned.match(
    /^\s*```(?:suggestion|[A-Za-z0-9_-]*)\n([\s\S]*?)\n```\s*$/,
  );
  if (fenceMatch?.[1] !== undefined) {
    cleaned = fenceMatch[1];
  }

  if (!cleaned.trim()) return undefined;
  if (cleaned.includes('```')) return undefined;

  const lineCount = cleaned.split('\n').length;
  if (lineCount > MAX_SUGGESTION_LINES || opts.lineSpan > MAX_SUGGESTION_LINES) {
    return undefined;
  }

  return `\`\`\`suggestion\n${cleaned}\n\`\`\``;
}

/**
 * Maps verified findings onto valid GitHub PR diff hunk lines.
 * Out-of-diff findings are never dropped; they are routed to `summaryOnlyFindings`
 * so GitHub's PR Review API never rejects the batch with HTTP 422.
 */
export function mapFindingsToDiff(
  findings: VerifiedFinding[],
  diffFiles: DiffFile[],
): LineMappingResult {
  const byPath = new Map<string, DiffFile>();
  for (const file of diffFiles) {
    byPath.set(normalizePath(file.path), file);
    if (file.oldPath) {
      byPath.set(normalizePath(file.oldPath), file);
    }
  }

  const inlineFindings: MappedInlineFinding[] = [];
  const summaryOnlyFindings: VerifiedFinding[] = [];

  for (const finding of findings) {
    const file = byPath.get(normalizePath(finding.path));
    if (!file || file.isBinary || file.hunks.length === 0) {
      summaryOnlyFindings.push(finding);
      continue;
    }

    const side = finding.side;
    const validSet = new Set(
      side === 'RIGHT' ? file.validRightLines : file.validLeftLines,
    );
    if (validSet.size === 0) {
      summaryOnlyFindings.push(finding);
      continue;
    }

    const rawLo = Math.min(finding.startLine, finding.endLine);
    const rawHi = Math.max(finding.startLine, finding.endLine);

    const hiSnap = snapToValidLine(rawHi, validSet, file.hunks, side);
    if (!hiSnap) {
      summaryOnlyFindings.push(finding);
      continue;
    }

    let finalStartLine: number | undefined;
    const finalEndLine = hiSnap.line;
    let snapped = hiSnap.offset !== 0;
    let collapsedRange = false;

    if (rawLo < rawHi) {
      const loSnap = snapToValidLine(
        rawLo,
        validSet,
        file.hunks,
        side,
        hiSnap.hunkIdx,
      );
      if (loSnap && loSnap.line < finalEndLine) {
        finalStartLine = loSnap.line;
        if (loSnap.offset !== 0) snapped = true;
      } else if (loSnap && loSnap.line === finalEndLine) {
        if (loSnap.offset !== 0) snapped = true;
      } else {
        // startLine lies outside endLine's hunk (>2 lines away or different hunk).
        // If endLine was exact, safely snap to single-line; otherwise demote.
        if (hiSnap.offset === 0) {
          collapsedRange = true;
          snapped = true;
        } else {
          summaryOnlyFindings.push(finding);
          continue;
        }
      }
    }

    const lineSpan =
      finalStartLine !== undefined ? finalEndLine - finalStartLine + 1 : 1;

    const suggestionBlock = sanitizeSuggestionCode(finding.suggestionCode, {
      side,
      sameHunk: true,
      lineSpan,
      collapsedRange,
    });

    inlineFindings.push({
      finding,
      path: file.path,
      line: finalEndLine,
      startLine: finalStartLine,
      side,
      suggestionBlock,
      snapped,
    });
  }

  return {
    inlineFindings,
    summaryOnlyFindings,
  };
}
