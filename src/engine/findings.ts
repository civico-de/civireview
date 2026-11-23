import type {
  BlastRadiusItem,
  FinalVerdict,
  FindingVerdict,
  Severity,
  VerificationMatrixEntry,
  VerifiedFinding,
} from './schemas.ts';

export const SEVERITY_RANK: Record<Severity, number> = {
  critical: 4,
  high: 3,
  medium: 2,
  low: 1,
};

export const EVIDENCE_RANK: Record<FindingVerdict, number> = {
  PROVEN: 3,
  CONFIRMED: 2,
  NEEDS_QUESTION: 1,
  REJECTED: 0,
};

const EMPIRICAL_BLOCKING_CHECKS = new Set<string>([
  'CI / Jenkins',
  'A/B Proof-of-Fix',
  'CiviKitchen A/B Proof-of-Fix',
  'Base-Test Regression',
  'Browser A/B (Standalone)',
  'Static / Taint Delta',
  'Demo',
]);

export function compareVerifiedFindings(a: VerifiedFinding, b: VerifiedFinding): number {
  const sevDiff = SEVERITY_RANK[b.reassessedSeverity] - SEVERITY_RANK[a.reassessedSeverity];
  if (sevDiff !== 0) return sevDiff;

  const evDiff = EVIDENCE_RANK[b.verdict] - EVIDENCE_RANK[a.verdict];
  if (evDiff !== 0) return evDiff;

  const confDiff = b.confidence - a.confidence;
  if (confDiff !== 0) return confDiff;

  const pathDiff = a.path.localeCompare(b.path);
  if (pathDiff !== 0) return pathDiff;

  return a.startLine - b.startLine;
}

export function normalizePath(p: string): string {
  return p.replaceAll('\\', '/').replace(/^\.\//, '');
}

export function rangesOverlap(aStart: number, aEnd: number, bStart: number, bEnd: number): boolean {
  const aLo = Math.min(aStart, aEnd);
  const aHi = Math.max(aStart, aEnd);
  const bLo = Math.min(bStart, bEnd);
  const bHi = Math.max(bStart, bEnd);
  return aLo <= bHi && bLo <= aHi;
}

export function deduplicateVerifiedFindings(findings: VerifiedFinding[]): VerifiedFinding[] {
  const sorted = findings.toSorted(compareVerifiedFindings);
  const kept: VerifiedFinding[] = [];

  for (const candidate of sorted) {
    const normPath = normalizePath(candidate.path);
    const duplicate = kept.some(
      (existing) =>
        normalizePath(existing.path) === normPath &&
        existing.side === candidate.side &&
        rangesOverlap(existing.startLine, existing.endLine, candidate.startLine, candidate.endLine),
    );
    if (!duplicate) {
      kept.push(candidate);
    }
  }

  return kept;
}

export function computeFinalVerdict(
  findings: VerifiedFinding[],
  verificationMatrix?: VerificationMatrixEntry[],
): FinalVerdict {
  const hasEmpiricalFailure = Boolean(
    verificationMatrix?.some((m) => m.status === 'FAIL' && EMPIRICAL_BLOCKING_CHECKS.has(m.check)),
  );
  if (findings.length === 0) {
    return hasEmpiricalFailure ? 'NEEDS_CHANGES' : 'READY';
  }
  const needsChanges =
    hasEmpiricalFailure ||
    findings.some(
      (f) =>
        (f.reassessedSeverity === 'critical' || f.reassessedSeverity === 'high') &&
        (f.verdict === 'PROVEN' || f.verdict === 'CONFIRMED'),
    );
  return needsChanges ? 'NEEDS_CHANGES' : 'QUESTIONS_ONLY';
}

export function mergeBlastRadius(lists: Array<BlastRadiusItem[] | undefined>): BlastRadiusItem[] {
  const byRepoPath = new Map<string, BlastRadiusItem>();
  for (const list of lists) {
    if (!list) continue;
    for (const item of list) {
      const key = `${item.repo.trim().toLowerCase()}|${normalizePath(item.path).toLowerCase()}`;
      const existing = byRepoPath.get(key);
      if (!existing || item.impact.length > existing.impact.length) {
        byRepoPath.set(key, item);
      }
    }
  }
  return Array.from(byRepoPath.values());
}
