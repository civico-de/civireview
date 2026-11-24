import type { ResolvedCiviReviewConfig } from '../config/schema.ts';
import { formatUsd } from '../runners/pricing.ts';

/** A review stopped by `review.maxBudgetUsd`; running it again would spend the same amount. */
export class BudgetExceededError extends Error {
  constructor(
    readonly estimatedUsd: number,
    maxBudgetUsd: number,
    nextStage: string,
  ) {
    super(
      `Review stopped before ${nextStage}: estimated cost ${formatUsd(estimatedUsd)} reached review.maxBudgetUsd ${formatUsd(maxBudgetUsd)}`,
    );
    this.name = 'BudgetExceededError';
  }
}

/** Throws before `nextStage` when the estimated cost so far has reached `maxBudgetUsd`. */
export function assertWithinBudget(
  estimatedUsd: number | undefined,
  maxBudgetUsd: number | undefined,
  nextStage: string,
): void {
  if (maxBudgetUsd !== undefined && (estimatedUsd ?? 0) >= maxBudgetUsd) {
    throw new BudgetExceededError(estimatedUsd ?? 0, maxBudgetUsd, nextStage);
  }
}

// These runners report no token usage, so their cost cannot be estimated.
const UNMETERED_PROVIDERS = new Set(['codex-cli', 'opencode-cli']);

/** Rejects `review.maxBudgetUsd` together with a model whose cost the cap could not see. */
export function assertBudgetEnforceable(config: ResolvedCiviReviewConfig): void {
  if (config.review.maxBudgetUsd === undefined) return;
  const { triage, verifier, specialists } = config.models;
  const unmetered = [triage, verifier, ...Object.values(specialists)].filter((spec) =>
    UNMETERED_PROVIDERS.has(spec.split(':')[0] ?? ''),
  );
  if (unmetered.length > 0) {
    throw new Error(
      `review.maxBudgetUsd cannot be enforced for ${[...new Set(unmetered)].join(', ')}: the runner reports no token usage. Remove the cap or use a metered provider.`,
    );
  }
}
