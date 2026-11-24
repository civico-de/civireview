import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ResolvedCiviReviewConfig } from '../config/schema.ts';
import { runCiviKitchenAb, type ExecFn } from './civikitchen-ab.ts';
import { filterAndTruncateDiff } from './diff-filter.ts';
import { fetchGitHubPrContext } from './github.ts';
import { fetchJenkinsStatus } from './jenkins.ts';
import { collectRelatedGitLabIssues, collectRelatedOpenPrs } from './related.ts';
import { detectBundledExtensions, detectRepoInfo } from './repo-detect.ts';
import { EvidenceBundleSchema, type EvidenceBundle, type PrMetadata } from './types.ts';

export interface CollectEvidenceOptions {
  repoRoot: string;
  config: ResolvedCiviReviewConfig;
  outputDir?: string;
  // GitHub PR mode:
  owner?: string;
  repo?: string;
  prNumber?: number;
  githubToken?: string;
  incremental?: boolean;
  // Local git diff fallback mode:
  baseSha?: string;
  headSha?: string;
  baseBranch?: string;
  isPrivateRepo?: boolean;
  execFn?: ExecFn;
}

async function runGitCommand(repoRoot: string, args: string[]): Promise<string> {
  const proc = Bun.spawn(['git', '-C', repoRoot, ...args], {
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code !== 0) {
    throw new Error(`git ${args.join(' ')} failed (${code}): ${stderr.trim()}`);
  }
  return stdout;
}

/**
 * Collects all Layer 1 deterministic evidence (PR metadata/local git diff,
 * filtered hunks, repo detection, CI/Jenkins status, CiviKitchen A/B results),
 * validates the `EvidenceBundle`, and optionally writes `evidence.json` +
 * `diff.patch` into `outputDir`.
 */
export async function collectEvidence(options: CollectEvidenceOptions): Promise<{
  bundle: EvidenceBundle;
  filteredPatch: string;
  urls?: { A?: string; B?: string };
  composeFiles?: { A?: string; B?: string };
  cleanup: () => Promise<void>;
}> {
  const { repoRoot, config } = options;

  let pr: PrMetadata;
  let rawDiffText: string;
  let comments: EvidenceBundle['comments'] = [];
  let linkedIssues: EvidenceBundle['linkedIssues'] = [];
  let ciStatus: EvidenceBundle['ciStatus'] = {
    overallState: 'unknown',
    checks: [],
    jenkinsFailedTests: [],
    summary: 'No CI commit statuses available (local mode).',
  };

  if (options.owner && options.repo && options.prNumber !== undefined) {
    const gh = await fetchGitHubPrContext({
      owner: options.owner,
      repo: options.repo,
      prNumber: options.prNumber,
      token: options.githubToken,
      incremental: options.incremental,
      config,
    });
    pr = gh.pr;
    rawDiffText = gh.diffText;
    comments = gh.comments;
    linkedIssues = gh.linkedIssues;
    ciStatus = await fetchJenkinsStatus({ statuses: gh.statuses });
  } else {
    const baseSha =
      options.baseSha ?? (await runGitCommand(repoRoot, ['rev-parse', 'HEAD~1'])).trim();
    const headSha =
      options.headSha ?? (await runGitCommand(repoRoot, ['rev-parse', 'HEAD'])).trim();
    rawDiffText = await runGitCommand(repoRoot, ['diff', baseSha, headSha]);
    const subject = (await runGitCommand(repoRoot, ['log', '-1', '--pretty=%s', headSha])).trim();

    pr = {
      repo: options.owner && options.repo ? `${options.owner}/${options.repo}` : 'local/repo',
      isPrivateRepo: options.isPrivateRepo ?? true,
      prNumber: options.prNumber ?? 0,
      title: subject || `Local diff ${baseSha.slice(0, 7)}..${headSha.slice(0, 7)}`,
      body: '',
      author: 'local',
      baseBranch: options.baseBranch ?? 'master',
      headBranch: 'HEAD',
      baseSha,
      headSha,
      labels: [],
      draft: false,
    };
  }

  const repoInfo = detectRepoInfo(repoRoot, pr.baseBranch);
  const filtered = filterAndTruncateDiff(
    rawDiffText,
    config.review.maxDiffBytes,
    config.review.paths,
  );
  if (repoInfo.kind === 'civicrm-core') {
    const bundled = detectBundledExtensions(
      repoRoot,
      filtered.files.map((f) => f.path),
    );
    if (bundled.length > 0) repoInfo.bundledExtensions = bundled;
  }

  const [abOutcome, candidateRelatedPrs, candidateRelatedIssues] = await Promise.all([
    runCiviKitchenAb({
      repoRoot,
      repoInfo,
      baseSha: pr.baseSha,
      headSha: pr.headSha,
      prNumber: pr.prNumber > 0 ? pr.prNumber : undefined,
      baseBranch: pr.baseBranch,
      diffFiles: filtered.files,
      abConfig: config.ab,
      checksConfig: config.checks,
      browserConfig: config.browser,
      reviewConfig: config.review,
      prBody: pr.body,
      outputDir: options.outputDir,
      execFn: options.execFn,
    }),
    options.owner && options.repo && options.prNumber !== undefined
      ? collectRelatedOpenPrs({
          owner: options.owner,
          repo: options.repo,
          prNumber: options.prNumber,
          prTitle: pr.title,
          prBody: pr.body,
          prAuthor: pr.author,
          baseBranch: pr.baseBranch,
          repoRoot,
          baseSha: pr.baseSha,
          headSha: pr.headSha,
          diffFiles: filtered.files,
          linkedIssues,
          token: options.githubToken,
        })
      : Promise.resolve([]),
    options.owner && options.repo && options.prNumber !== undefined
      ? collectRelatedGitLabIssues({
          prTitle: pr.title,
          diffFiles: filtered.files,
          linkedIssues,
          repoKind: repoInfo.kind,
        })
      : Promise.resolve([]),
  ]);
  const { abReport, staticDelta } = abOutcome;

  const notVerified = Array.from(
    new Set([
      ...abReport.notVerified,
      ...(filtered.truncated ? [`Diff truncated at ${config.review.maxDiffBytes} bytes.`] : []),
    ]),
  );

  const bundle = EvidenceBundleSchema.parse({
    schemaVersion: '1',
    collectedAt: new Date().toISOString(),
    repoInfo,
    pr,
    comments,
    linkedIssues,
    ...(candidateRelatedPrs.length > 0 ? { candidateRelatedPrs } : {}),
    ...(candidateRelatedIssues.length > 0 ? { candidateRelatedIssues } : {}),
    diffFiles: filtered.files,
    droppedNoiseFiles: filtered.droppedNoiseFiles,
    diffTruncated: filtered.truncated,
    abReport,
    staticDelta,
    ciStatus,
    notVerified,
  });

  if (options.outputDir) {
    mkdirSync(options.outputDir, { recursive: true });
    writeFileSync(
      join(options.outputDir, 'evidence.json'),
      JSON.stringify(bundle, null, 2),
      'utf8',
    );
    writeFileSync(join(options.outputDir, 'diff.patch'), filtered.filteredPatch, 'utf8');
  }

  return {
    bundle,
    filteredPatch: filtered.filteredPatch,
    urls: abOutcome.urls,
    composeFiles: abOutcome.composeFiles,
    cleanup: abOutcome.cleanup,
  };
}
