import type { ExecFn } from './parsers.ts';

/**
 * Moves worktrees A and B onto GitHub's test merge of the PR (`refs/pull/N/merge`):
 * A on its first parent, the base branch as GitHub last merged it, B on the merge.
 * Returns an error text when GitHub has no merge, e.g. for a PR with conflicts.
 */
export async function checkoutPrMerge(params: {
  repoRoot: string;
  prNumber: number;
  baseSha: string;
  headSha: string;
  worktreeA: string;
  worktreeB: string;
  execFn: ExecFn;
}): Promise<{ base: string; merge: string } | { error: string }> {
  const { repoRoot, prNumber, baseSha, headSha, worktreeA, worktreeB, execFn } = params;
  const ref = `refs/civireview/pull-${prNumber}-merge`;
  const fetched = await execFn(
    ['git', '-C', repoRoot, 'fetch', '--no-tags', 'origin', `+refs/pull/${prNumber}/merge:${ref}`],
    { timeoutMs: 180_000 },
  );
  if (fetched.exitCode !== 0) {
    return { error: `GitHub has no merge of the PR into its base (${fetched.stderr.trim()})` };
  }
  const parents = await execFn(['git', '-C', repoRoot, 'rev-list', '--parents', '-n', '1', ref], {
    timeoutMs: 10_000,
  });
  const [merge, base, head] = parents.stdout.trim().split(/\s+/);
  if (parents.exitCode !== 0 || !merge || !base || !head) {
    return { error: `${ref} is not a merge commit` };
  }
  if (head !== headSha) {
    return {
      error: `GitHub's merge is of ${head.slice(0, 10)}, not of the head ${headSha.slice(0, 10)}`,
    };
  }
  const contains = await execFn(
    ['git', '-C', repoRoot, 'merge-base', '--is-ancestor', baseSha, base],
    { timeoutMs: 30_000 },
  );
  if (contains.exitCode !== 0) {
    return {
      error: `GitHub's merge is onto ${base.slice(0, 10)}, which lacks the base ${baseSha.slice(0, 10)}`,
    };
  }
  const checkout = (dir: string, sha: string) =>
    execFn(['git', '-C', dir, 'checkout', '--quiet', '--detach', sha], { timeoutMs: 120_000 });
  for (const [dir, sha] of [
    [worktreeA, base],
    [worktreeB, merge],
  ] as const) {
    const res = await checkout(dir, sha);
    if (res.exitCode === 0) continue;
    // Both worktrees go back to the PR's base and head, or the run stops.
    for (const [d, original] of [
      [worktreeA, baseSha],
      [worktreeB, headSha],
    ] as const) {
      const back = await checkout(d, original);
      if (back.exitCode !== 0) {
        throw new Error(`Could not restore ${d} to ${original}: ${back.stderr.trim()}`);
      }
    }
    return { error: `checkout of ${sha} failed: ${res.stderr.trim()}` };
  }
  return { base, merge };
}
