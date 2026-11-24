import type { CandidateFinding, VerifiedFinding } from './schemas.ts';

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
