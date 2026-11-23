import type { EvidenceBundle } from '../evidence/types.ts';
import type {
  BlastRadiusItem,
  FinalVerdict,
  FindingVerdict,
  RelatedItem,
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
  const hasOpenReviewerThread = Boolean(
    verificationMatrix?.some((m) => m.check === 'Reviewer Thread' && m.status === 'WARN'),
  );
  if (findings.length === 0) {
    if (hasEmpiricalFailure) return 'NEEDS_CHANGES';
    if (hasOpenReviewerThread) return 'QUESTIONS_ONLY';
    return 'READY';
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

export function filterGroundedRelatedItems(
  items: RelatedItem[] | undefined,
  bundle: EvidenceBundle,
): RelatedItem[] {
  if (!items || items.length === 0) return [];
  const allowedUrls = new Set<string>([
    ...(bundle.candidateRelatedPrs ?? []).map((p) => p.url.toLowerCase()),
    ...(bundle.candidateRelatedIssues ?? []).map((i) => i.url.toLowerCase()),
  ]);
  const prBaseByUrl = new Map<string, string>(
    (bundle.candidateRelatedPrs ?? [])
      .filter((p) => Boolean(p.baseBranch))
      .map((p) => [p.url.toLowerCase(), p.baseBranch!.toLowerCase()]),
  );
  const prMergeCheckByUrl = new Map<string, 'conflicts' | 'clean'>(
    (bundle.candidateRelatedPrs ?? [])
      .filter((p) => Boolean(p.mergeConflict))
      .map((p) => [p.url.toLowerCase(), p.mergeConflict!]),
  );
  const currentBase = bundle.pr.baseBranch.toLowerCase();
  if (allowedUrls.size === 0) return [];
  const seen = new Set<string>();
  return items
    .filter((item) => {
      const key = item.url.toLowerCase();
      if (item.confidence < 60 || !allowedUrls.has(key) || seen.has(key)) {
        return false;
      }
      seen.add(key);
      return true;
    })
    .map((item) => {
      const urlKey = item.url.toLowerCase();
      const candidateBase = prBaseByUrl.get(urlKey);
      if (
        item.kind === 'pr' &&
        candidateBase &&
        candidateBase !== currentBase &&
        (item.relationship === 'duplicate' || item.relationship === 'conflicts')
      ) {
        return { ...item, relationship: 'related' as const };
      }
      if (
        item.kind === 'pr' &&
        item.relationship === 'conflicts' &&
        prMergeCheckByUrl.get(urlKey) === 'clean'
      ) {
        return { ...item, relationship: 'related' as const };
      }
      return item;
    })
    .toSorted((a, b) => b.confidence - a.confidence)
    .slice(0, 5);
}
