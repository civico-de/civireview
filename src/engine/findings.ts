import type { EvidenceBundle } from '../evidence/types.ts';
import type {
  BlastRadiusItem,
  FinalVerdict,
  FindingVerdict,
  PrKind,
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

export const CMS_CHECK = 'CMS Browser A/B';

const EMPIRICAL_BLOCKING_CHECKS = new Set<string>([
  'CI / Jenkins',
  'A/B Proof-of-Fix',
  'CiviKitchen A/B Proof-of-Fix',
  'Base-Test Regression',
  'Version Matrix',
  'Browser A/B (Standalone)',
  'Static / Taint Delta',
  'Demo',
  CMS_CHECK,
]);

const RAN = new Set<string>(['PASS', 'WARN', 'FAIL']);

const RUNTIME_CHECKS = new Set<string>([
  'A/B Proof-of-Fix',
  'CiviKitchen A/B Proof-of-Fix',
  'Base-Test Regression',
  'Version Matrix',
  'Browser A/B (Standalone)',
  CMS_CHECK,
]);

/** True when a check that boots Standalone gave a result. */
export function standaloneRan(verificationMatrix: VerificationMatrixEntry[]): boolean {
  return verificationMatrix.some(
    (m) => RUNTIME_CHECKS.has(m.check) && m.check !== CMS_CHECK && RAN.has(m.status),
  );
}

/**
 * The runtime checks of a code PR that should have run but gave no result, when none
 * gave one: nothing was proven by running the code. Empty when a check ran or none applied.
 */
export function unverifiedRuntimeChecks(
  verificationMatrix: VerificationMatrixEntry[] = [],
  prKind?: PrKind,
): string[] {
  if (prKind === 'docs-only' || prKind === 'core-ref-nfc') return [];
  const runtime = verificationMatrix.filter((m) => RUNTIME_CHECKS.has(m.check));
  // Results from Standalone do not stand in for a change to another CMS's integration alone.
  const cms = runtime.find((m) => m.check === CMS_CHECK);
  if (cms?.coversWholeChange) return cms.status === 'NOT_VERIFIED' ? [cms.check] : [];
  // Nor does a login on another CMS stand in for running the shared code.
  const shared = runtime.filter((m) => m.check !== CMS_CHECK);
  if (shared.some((m) => RAN.has(m.status))) {
    return [];
  }
  return shared.filter((m) => m.status === 'NOT_VERIFIED').map((m) => m.check);
}

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

function sameTitle(a: VerifiedFinding, b: VerifiedFinding): boolean {
  return a.title.trim().toLowerCase() === b.title.trim().toLowerCase();
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
        // Within one lens only a repeated title is the same defect reported again.
        (existing.lens !== candidate.lens || sameTitle(existing, candidate)) &&
        rangesOverlap(existing.startLine, existing.endLine, candidate.startLine, candidate.endLine),
    );
    if (!duplicate) {
      kept.push(candidate);
    }
  }

  return kept;
}

/** The verdict on findings and checks; a code PR not verified at runtime has open questions. */
export function computeFinalVerdict(
  findings: VerifiedFinding[],
  verificationMatrix?: VerificationMatrixEntry[],
  prKind?: PrKind,
): FinalVerdict {
  const verdict = findingsVerdict(findings, verificationMatrix);
  return verdict === 'NO_ISSUES_FOUND' &&
    unverifiedRuntimeChecks(verificationMatrix, prKind).length > 0
    ? 'QUESTIONS_ONLY'
    : verdict;
}

/** The verdict on findings, failed checks and reviewer threads alone. */
export function findingsVerdict(
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
    if (hasEmpiricalFailure) return 'ISSUES_FOUND';
    if (hasOpenReviewerThread) return 'QUESTIONS_ONLY';
    return 'NO_ISSUES_FOUND';
  }
  const needsChanges =
    hasEmpiricalFailure ||
    findings.some(
      (f) =>
        (f.reassessedSeverity === 'critical' || f.reassessedSeverity === 'high') &&
        (f.verdict === 'PROVEN' || f.verdict === 'CONFIRMED'),
    );
  return needsChanges ? 'ISSUES_FOUND' : 'QUESTIONS_ONLY';
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
