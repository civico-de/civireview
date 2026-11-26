import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AbConfigSchema } from '../src/config/schema.ts';
import { runCiviKitchenAb, type ExecFn } from '../src/evidence/civikitchen-ab.ts';
import { parseUnifiedDiff } from '../src/evidence/diff-filter.ts';
import type { RepoInfo } from '../src/evidence/types.ts';

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

const JOOMLA_DIFF = `diff --git a/CRM/Utils/System/Joomla.php b/CRM/Utils/System/Joomla.php
--- a/CRM/Utils/System/Joomla.php
+++ b/CRM/Utils/System/Joomla.php
@@ -1,2 +1,3 @@
 <?php
+// fix
`;

/** Runs the A/B evidence of a Joomla-only core PR against a scripted `ck`. */
async function runJoomlaPr(script: { steps: boolean; failAfterDemo?: boolean }) {
  const repoDir = mkdtempSync(join(tmpdir(), 'civireview-live-browser-'));
  tempDirs.push(repoDir);
  const repoInfo: RepoInfo = {
    kind: 'civicrm-core',
    root: repoDir,
    recommendedImage: 'standalone-master',
  };
  const calls: string[][] = [];
  let demoDone = false;
  const execFn: ExecFn = async (args) => {
    calls.push(args);
    if (args[0] === 'git' && args[3] === 'worktree' && args[4] === 'add') {
      mkdirSync(join(args[6]!, 'CRM/Utils/System'), { recursive: true });
      writeFileSync(join(args[6]!, 'CRM/Utils/System/Joomla.php'), '<?php\n');
    }
    if (args[0] === 'ck' && args[1] === 'steps') {
      return script.steps
        ? { exitCode: 0, stdout: 'civikitchen-playwright:0123456789ab\n', stderr: '' }
        : { exitCode: 2, stdout: '', stderr: 'ck: steps runs in the dev stack\n' };
    }
    if (args[0] === 'ck' && args[1] === 'demo') {
      demoDone = true;
      const kept = args.includes('--keep')
        ? 'ck demo: kept Joomla at http://localhost:8301 (admin / admin)\n'
        : '';
      return { exitCode: 0, stdout: `ck demo: recording Joomla after\n${kept}`, stderr: '' };
    }
    if (script.failAfterDemo && demoDone && args[0] !== 'docker' && args[0] !== 'git') {
      throw new Error('the run broke after the CMS demo');
    }
    return { exitCode: 0, stdout: args[0] === 'git' ? JOOMLA_DIFF : '', stderr: '' };
  };
  const run = runCiviKitchenAb({
    repoRoot: repoDir,
    repoInfo,
    baseSha: 'aaaaaaa',
    headSha: 'bbbbbbb',
    diffFiles: parseUnifiedDiff(JOOMLA_DIFF),
    abConfig: AbConfigSchema.parse({ enabled: true, ckCommand: 'ck' }),
    execFn,
    worktreeBaseDir: join(repoDir, '.worktrees'),
  });
  const downs = () =>
    calls.filter((c) => c[0] === 'docker' && c[2] === '-p').map((c) => c.slice(3, 5).join(' '));
  const demo = () => calls.find((c) => c[0] === 'ck' && c[1] === 'demo');
  return { run, calls, downs, demo };
}

describe('browser access for the review stages', () => {
  test('a ck with `steps` keeps the CMS site and hands both to the stages', async () => {
    const { run, downs, demo } = await runJoomlaPr({ steps: true });
    const outcome = await run;
    expect(demo()).toContain('--keep');
    expect(outcome.browser?.ck).toEqual(['ck']);
    expect(outcome.browser?.cmsSites).toMatchObject([
      { cms: 'joomla', url: 'http://localhost:8301' },
    ]);
    expect(downs()).toEqual([]);
    await outcome.cleanup();
    expect(downs()).toEqual([`${outcome.browser!.cmsSites[0]!.project} down`]);
  });

  test('a ck without `steps` keeps no CMS site and offers no browser', async () => {
    const { run, downs, demo } = await runJoomlaPr({ steps: false });
    const outcome = await run;
    expect(demo()).toBeDefined();
    expect(demo()).not.toContain('--keep');
    expect(outcome.browser).toBeUndefined();
    await outcome.cleanup();
    expect(downs()).toEqual([]);
  });

  test('a run that breaks after the CMS demo removes the kept site', async () => {
    const { run, downs, demo } = await runJoomlaPr({ steps: true, failAfterDemo: true });
    await expect(run).rejects.toThrow('the run broke after the CMS demo');
    expect(demo()).toContain('--keep');
    expect(downs()).toHaveLength(1);
    expect(downs()[0]).toMatch(/^ck-demo-cr-.+-joomla down$/);
  });
});
