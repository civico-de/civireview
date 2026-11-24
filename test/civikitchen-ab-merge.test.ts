import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AbConfigSchema, ChecksConfigSchema } from '../src/config/schema.ts';
import { runCiviKitchenAb, type ExecFn } from '../src/evidence/civikitchen-ab.ts';
import { parseUnifiedDiff } from '../src/evidence/diff-filter.ts';

const IMAGE_SHA = 'd'.repeat(40);
const OLD_BASE = 'a'.repeat(40);
const HEAD = 'b'.repeat(40);
const MASTER = 'c'.repeat(40);
const MERGE = 'e'.repeat(40);

const diffFiles = parseUnifiedDiff(
  [
    'diff --git a/CRM/Utils/Money.php b/CRM/Utils/Money.php',
    '--- a/CRM/Utils/Money.php',
    '+++ b/CRM/Utils/Money.php',
    '@@ -1 +1,2 @@',
    ' <?php',
    '+// fix',
  ].join('\n'),
);

/**
 * Fakes git and docker for one core review: `driftByBase` gives the paths that differ
 * between the image's core and each base, `merge` what GitHub's merge ref resolves to.
 */
async function review(opts: {
  driftByBase: Record<string, string>;
  merge?: { parents: string } | 'missing';
  prNumber?: number;
  failCheckout?: string;
  staleMergeBase?: boolean;
}) {
  const repoDir = mkdtempSync(join(tmpdir(), 'civireview-merge-'));
  const calls: string[][] = [];
  const execFn: ExecFn = async (args) => {
    calls.push(args);
    if (args[0] === 'docker' && args[1] === 'run') {
      return { exitCode: 0, stdout: `git . ${IMAGE_SHA}\nvendor-sync\n`, stderr: '' };
    }
    if (args[0] === 'git' && args[3] === 'worktree' && args[4] === 'add') {
      const target = args[6]!;
      mkdirSync(join(target, 'CRM/Utils'), { recursive: true });
      writeFileSync(join(target, 'CRM/Utils/Money.php'), '<?php\n');
      writeFileSync(join(target, 'composer.lock'), '{}\n');
      return { exitCode: 0, stdout: '', stderr: '' };
    }
    if (args[0] === 'git' && args[3] === 'diff' && args.includes(IMAGE_SHA)) {
      return { exitCode: 0, stdout: opts.driftByBase[args.at(-1)!] ?? '', stderr: '' };
    }
    if (args[0] === 'git' && args[3] === 'fetch' && (args.at(-1) ?? '').includes('/merge:')) {
      return opts.merge === 'missing' || !opts.merge
        ? { exitCode: 128, stdout: '', stderr: "couldn't find remote ref" }
        : { exitCode: 0, stdout: '', stderr: '' };
    }
    if (args[0] === 'git' && args[3] === 'merge-base') {
      return { exitCode: opts.staleMergeBase ? 1 : 0, stdout: '', stderr: '' };
    }
    if (args[0] === 'git' && args[3] === 'checkout' && args.at(-1) === opts.failCheckout) {
      return { exitCode: 1, stdout: '', stderr: 'checkout failed' };
    }
    if (args[0] === 'git' && args[3] === 'rev-list' && opts.merge && opts.merge !== 'missing') {
      return { exitCode: 0, stdout: `${opts.merge.parents}\n`, stderr: '' };
    }
    return { exitCode: 0, stdout: '', stderr: '' };
  };
  try {
    const outcome = await runCiviKitchenAb({
      repoRoot: repoDir,
      repoInfo: { kind: 'civicrm-core', root: repoDir, recommendedImage: 'standalone-master' },
      baseSha: OLD_BASE,
      headSha: HEAD,
      prNumber: opts.prNumber ?? 32384,
      diffFiles,
      abConfig: AbConfigSchema.parse({ enabled: true, ckCommand: 'ck' }),
      checksConfig: ChecksConfigSchema.parse({ liveProve: false, browser: false }),
      execFn,
      worktreeBaseDir: join(repoDir, '.worktrees'),
    });
    return { outcome, calls };
  } finally {
    rmSync(repoDir, { recursive: true, force: true });
  }
}

const checkouts = (calls: string[][]) =>
  calls.filter((a) => a[0] === 'git' && a[3] === 'checkout').map((a) => a.at(-1));

describe('A/B on a base whose composer files differ from the image', () => {
  test("runs on GitHub's merge: A on its first parent, B on the merge", async () => {
    const { outcome, calls } = await review({
      driftByBase: {
        [OLD_BASE]: 'composer.lock\nCRM/Utils/Money.php\n',
        [MASTER]: 'Civi/New.php\n',
      },
      merge: { parents: `${MERGE} ${MASTER} ${HEAD}` },
    });
    expect(checkouts(calls)).toEqual([MASTER, MERGE]);
    expect(outcome.abReport.testedMerge).toEqual({ base: MASTER, merge: MERGE });
    // The drift, and with it the mounts, is taken again against the merge base.
    const driftBases = calls
      .filter((a) => a[0] === 'git' && a[3] === 'diff' && a.includes(IMAGE_SHA))
      .map((a) => a.at(-1));
    expect(driftBases).toEqual([OLD_BASE, MASTER]);
    expect(outcome.abReport.notVerified.join('\n')).not.toContain('composer dependencies');
  });

  test('stays on the old base and says why when GitHub has no merge', async () => {
    const { outcome, calls } = await review({
      driftByBase: { [OLD_BASE]: 'composer.lock\n' },
      merge: 'missing',
    });
    expect(checkouts(calls)).toEqual([]);
    expect(outcome.abReport.testedMerge).toBeUndefined();
    expect(outcome.abReport.notVerified.join('\n')).toContain(
      `The base ${OLD_BASE.slice(0, 10)} has other composer dependencies than standalone-master and A/B runs on it; GitHub has no merge of the PR into its base`,
    );
  });

  test('does not use a merge GitHub computed for an earlier head', async () => {
    const { outcome, calls } = await review({
      driftByBase: { [OLD_BASE]: 'composer.lock\n' },
      merge: { parents: `${MERGE} ${MASTER} ${'f'.repeat(40)}` },
    });
    expect(checkouts(calls)).toEqual([]);
    expect(outcome.abReport.testedMerge).toBeUndefined();
    expect(outcome.abReport.notVerified.join('\n')).toContain(
      `GitHub's merge is of ffffffffff, not of the head ${HEAD.slice(0, 10)}`,
    );
  });

  test('does not use a merge onto a commit that lacks the PR base', async () => {
    const { outcome, calls } = await review({
      driftByBase: { [OLD_BASE]: 'composer.lock\n' },
      merge: { parents: `${MERGE} ${MASTER} ${HEAD}` },
      staleMergeBase: true,
    });
    expect(checkouts(calls)).toEqual([]);
    expect(outcome.abReport.testedMerge).toBeUndefined();
    expect(outcome.abReport.notVerified.join('\n')).toContain(
      `GitHub's merge is onto ${MASTER.slice(0, 10)}, which lacks the base ${OLD_BASE.slice(0, 10)}`,
    );
  });

  test('puts both worktrees back on base and head when a checkout fails', async () => {
    const { outcome, calls } = await review({
      driftByBase: { [OLD_BASE]: 'composer.lock\n' },
      merge: { parents: `${MERGE} ${MASTER} ${HEAD}` },
      failCheckout: MERGE,
    });
    expect(checkouts(calls)).toEqual([MASTER, MERGE, OLD_BASE, HEAD]);
    expect(outcome.abReport.testedMerge).toBeUndefined();
    expect(outcome.abReport.notVerified.join('\n')).toContain(`checkout of ${MERGE} failed`);
  });

  test('a base with the image composer files stays on the PR base', async () => {
    const { outcome, calls } = await review({
      driftByBase: { [OLD_BASE]: 'CRM/Utils/Money.php\n' },
      merge: { parents: `${MERGE} ${MASTER} ${HEAD}` },
    });
    expect(calls.some((a) => (a.at(-1) ?? '').includes('/merge:'))).toBe(false);
    expect(outcome.abReport.testedMerge).toBeUndefined();
  });
});
