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
