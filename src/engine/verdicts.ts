import type { EvidenceBundle } from '../evidence/types.ts';
import type { CandidateFinding, TriageOutput, VerifiedFinding } from './schemas.ts';

/** Verifier calls for candidates still without a verdict before the review fails. */
export const MAX_VERDICT_RETRIES = 3;

/**
 * Returns one verdict per candidate, re-asking the verifier for the missing ones.
 * A verdict for an unknown id does not count. Throws when candidates stay without one.
 */
export async function collectVerdicts(params: {
  batch: CandidateFinding[];
  first: VerifiedFinding[];
  stagePrefix: string;
  ask: (missing: CandidateFinding[], stage: string) => Promise<VerifiedFinding[]>;
  warn?: (msg: string) => void;
}): Promise<VerifiedFinding[]> {
  const { batch, stagePrefix, ask, warn } = params;
  const ids = new Set(batch.map((c) => c.id));
  const byId = new Map<string, VerifiedFinding>();
  const take = (verdicts: VerifiedFinding[]) => {
    for (const f of verdicts) {
      if (!ids.has(f.id)) {
        warn?.(`[finding] ${f.id} ignored: the verifier returned a verdict for an unknown id`);
      } else if (!byId.has(f.id)) {
        byId.set(f.id, f);
      }
    }
  };
  take(params.first);
  for (let retry = 1; ; retry++) {
    const missing = batch.filter((c) => !byId.has(c.id));
    if (missing.length === 0) break;
    const missingIds = missing.map((c) => c.id).join(', ');
    if (retry > MAX_VERDICT_RETRIES) {
      throw new Error(
        `Verifier returned no verdict for ${missingIds} after ${MAX_VERDICT_RETRIES} retries`,
      );
    }
    warn?.(
      `[finding] ${missingIds}: no verdict from ${stagePrefix}; retry ${retry}/${MAX_VERDICT_RETRIES}`,
    );
    take(await ask(missing, `${stagePrefix}:retry-${retry}`));
  }
  return batch.map((c) => byId.get(c.id)!);
}

/** Renames candidates whose id is in `taken` to `<id>-<n>` and records every id in `taken`. */
export function withUniqueIds(batch: CandidateFinding[], taken: Set<string>): CandidateFinding[] {
  return batch.map((c) => {
    let id = c.id;
    for (let n = 2; taken.has(id); n++) id = `${c.id}-${n}`;
    taken.add(id);
    return id === c.id ? c : { ...c, id };
  });
}

/**
 * Turns `PROVEN` into `CONFIRMED` when no run produced a result and the finding carries no live proof:
 * nothing can have reproduced it.
 */
export function withoutUnprovenProof(
  findings: VerifiedFinding[],
  evidenceRan: boolean,
  warn?: (msg: string) => void,
): VerifiedFinding[] {
  return findings.map((f) => {
    if (f.verdict !== 'PROVEN' || evidenceRan || f.liveProofOutput) return f;
    warn?.(
      `[finding] ${f.id} PROVEN lowered to CONFIRMED: no run produced a result and no live proof`,
    );
    return { ...f, verdict: 'CONFIRMED' };
  });
}

/** True when a test run, an extension gate, the browser probe or the live capture gave a result. */
export function hasRunEvidence(bundle: EvidenceBundle): boolean {
  const { checks, browserDiff, surfaceDiff } = bundle.abReport;
  const live = surfaceDiff.liveSurfaceDiff;
  return (
    checks.some((c) => c.status === 'PASS' || c.status === 'FAIL') ||
    bundle.staticDelta.toolsRun.length > 0 ||
    (browserDiff !== undefined && !browserDiff.error && browserDiff.counts?.routes !== 0) ||
    (live !== undefined && !live.error)
  );
}

/**
 * The skip reason triage may act on: only for a PR it calls docs-only whose changed files
 * are all documentation. A model's label alone never skips a code review.
 */
export function acceptedSkipReason(
  triage: TriageOutput,
  bundle: EvidenceBundle,
  warn?: (msg: string) => void,
): string | undefined {
  if (!triage.skipReason) return undefined;
  const docsOnly =
    triage.prKind === 'docs-only' &&
    bundle.diffFiles.length > 0 &&
    bundle.diffFiles.every((f) => f.flags.isDocsOnly);
  if (!docsOnly) warn?.(`Triage skip reason ignored, the PR changes code: ${triage.skipReason}`);
  return docsOnly ? triage.skipReason : undefined;
}
