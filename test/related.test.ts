import { describe, expect, test } from 'bun:test';
import { loadConfig } from '../src/config/loader.ts';
import { runReviewPipeline } from '../src/engine/pipeline.ts';
import { parseUnifiedDiff } from '../src/evidence/diff-filter.ts';
import {
  buildGitLabSearchQuery,
  checkRelatedPrMergeConflicts,
  collectRelatedGitLabIssues,
  collectRelatedOpenPrs,
  extractComponentPrefix,
  type RelatedPrOctokit,
} from '../src/evidence/related.ts';
import type { EvidenceBundle } from '../src/evidence/types.ts';
import { formatReviewMarkdown } from '../src/github/formatter.ts';
import { createRunnerRegistry } from '../src/runners/registry.ts';
import type { StageRunner } from '../src/runners/types.ts';

const SAMPLE_DIFF = `diff --git a/ext/afform/core/ang/afField/Number.tpl b/ext/afform/core/ang/afField/Number.tpl
index 1111111..2222222 100644
--- a/ext/afform/core/ang/afField/Number.tpl
+++ b/ext/afform/core/ang/afField/Number.tpl
@@ -1,3 +1,3 @@
-<input min="{{ field.min || '' }}" />
+<input min="{{ field.min }}" />
`;

describe('related open PRs & GitLab issue discovery', () => {
  test('extractComponentPrefix and buildGitLabSearchQuery normalize CiviCRM PR titles', () => {
    expect(extractComponentPrefix('Afform - A number field minimum of 0 is dropped')).toBe(
      'afform',
    );
    expect(extractComponentPrefix('dev/core#6894 SearchKit - Enable Actions')).toBe('searchkit');
    const q = buildGitLabSearchQuery(
      'dev/core#6894 Afform - A number field minimum or maximum of 0 is dropped',
    );
    expect(q.toLowerCase()).toContain('afform');
    expect(q.toLowerCase()).toContain('number');
    expect(q).not.toContain('6894');
  });

  test('collectRelatedOpenPrs ranks overlapping files and shared issue refs while excluding self', async () => {
    const diffFiles = parseUnifiedDiff(SAMPLE_DIFF);
    const octokit: RelatedPrOctokit = {
      rest: {
        pulls: {
          async list() {
            return {
              data: [
                {
                  number: 38176,
                  title: 'Afform - Keep number field min of 0',
                  body: 'Fixes dev/core#6900',
                  html_url: 'https://github.com/civicrm/civicrm-core/pull/38176',
                  user: { login: 'alice' },
                },
                {
                  number: 38120,
                  title: 'Afform - Number field bounds validation',
                  body: 'Adjusts Number.tpl min/max',
                  html_url: 'https://github.com/civicrm/civicrm-core/pull/38120',
                  user: { login: 'bob' },
                },
                {
                  number: 38150,
                  title: 'Afform - Alternate fix for dev/core#6900',
                  body: 'Also addresses dev/core#6900',
                  html_url: 'https://github.com/civicrm/civicrm-core/pull/38150',
                  user: { login: 'carol' },
                },
                {
                  number: 38199,
                  title: 'CiviMail - Unrelated mailer tweak',
                  body: 'Mailer only',
                  html_url: 'https://github.com/civicrm/civicrm-core/pull/38199',
                  user: { login: 'dave' },
                },
              ],
            };
          },
          async listFiles({ pull_number }) {
            if (pull_number === 38120) {
              return {
                data: [{ filename: 'ext/afform/core/ang/afField/Number.tpl' }],
              };
            }
            return { data: [{ filename: 'CRM/Other.php' }] };
          },
        },
      },
    };

    const res = await collectRelatedOpenPrs({
      owner: 'civicrm',
      repo: 'civicrm-core',
      prNumber: 38176,
      prTitle: 'Afform - Keep number field min of 0',
      prBody: 'Fixes dev/core#6900',
      diffFiles,
      linkedIssues: [],
      octokit,
    });

    expect(res.map((p) => p.number)).not.toContain(38176);
    expect(res.map((p) => p.number)).not.toContain(38199);
    const conflictPr = res.find((p) => p.number === 38120);
    const dupPr = res.find((p) => p.number === 38150);
    expect(conflictPr?.overlappingFiles).toEqual(['ext/afform/core/ang/afField/Number.tpl']);
    expect(dupPr?.sharedIssueRefs).toEqual(['dev/core#6900']);
  });

  test('collectRelatedOpenPrs skips same-author release-branch backport pairs targeting a different baseBranch', async () => {
    const diffFiles = parseUnifiedDiff(SAMPLE_DIFF);
    const octokit: RelatedPrOctokit = {
      rest: {
        pulls: {
          async list() {
            return {
              data: [
                {
                  number: 38164,
                  title: 'dev/core#6948 Revert unique index on Country.iso_code',
                  body: 'Backport to 6.21',
                  html_url: 'https://github.com/civicrm/civicrm-core/pull/38164',
                  base: { ref: '6.21' },
                  user: { login: 'colemanw' },
                },
              ],
            };
          },
          async listFiles() {
            return { data: [{ filename: 'ext/afform/core/ang/afField/Number.tpl' }] };
          },
        },
      },
    };

    const res = await collectRelatedOpenPrs({
      owner: 'civicrm',
      repo: 'civicrm-core',
      prNumber: 38165,
      prTitle: 'dev/core#6948 Revert unique index on Country.iso_code',
      prBody: 'Backport to 6.20',
      prAuthor: 'colemanw',
      baseBranch: '6.20',
      diffFiles,
      linkedIssues: [],
      octokit,
    });

    expect(res).toHaveLength(0);
  });

  test('collectRelatedGitLabIssues queries lab.civicrm.org and excludes already-linked issues', async () => {
    const mockFetch = (async () =>
      new Response(
        JSON.stringify([
          {
            iid: 6900,
            title: 'Already linked issue',
            state: 'opened',
            web_url: 'https://lab.civicrm.org/dev/core/-/issues/6900',
            references: { full: 'dev/core#6900' },
            labels: ['Afform'],
            description: 'Already linked',
          },
          {
            iid: 6912,
            title: 'FormBuilder drops 0 min/max on number inputs',
            state: 'opened',
            web_url: 'https://lab.civicrm.org/dev/core/-/issues/6912',
            references: { full: 'dev/core#6912' },
            labels: ['Afform', 'Bug'],
            description: 'Setting min=0 on a Number field is ignored in Angular.',
          },
        ]),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      )) as unknown as typeof fetch;

    const res = await collectRelatedGitLabIssues({
      prTitle: 'Afform - Number field minimum of 0 is dropped',
      diffFiles: parseUnifiedDiff(SAMPLE_DIFF),
      linkedIssues: [
        {
          number: 6900,
          repo: 'dev/core',
          source: 'gitlab',
          title: 'Already linked issue',
          body: '',
          state: 'opened',
          url: 'https://lab.civicrm.org/dev/core/-/issues/6900',
        },
      ],
      repoKind: 'civicrm-core',
      fetchFn: mockFetch,
    });

    expect(res).toHaveLength(1);
    expect(res[0]!.ref).toBe('dev/core#6912');
    expect(res[0]!.labels).toEqual(['Afform', 'Bug']);
  });

  test('pipeline filters ungrounded/low-confidence relatedItems and formatter renders confidence table', async () => {
    const bundle: EvidenceBundle = {
      schemaVersion: '1',
      collectedAt: '2026-11-23T12:00:00Z',
      repoInfo: {
        kind: 'civicrm-core',
        root: '/tmp/repo',
        recommendedImage: 'standalone-master',
      },
      pr: {
        repo: 'civicrm/civicrm-core',
        isPrivateRepo: false,
        prNumber: 38176,
        title: 'Afform - Keep number field min of 0',
        body: 'Fixes min=0',
        author: 'alice',
        baseBranch: 'master',
        headBranch: 'fix-min',
        baseSha: 'aaaa1111',
        headSha: 'bbbb2222',
        labels: [],
        draft: false,
      },
      comments: [],
      linkedIssues: [],
      candidateRelatedPrs: [
        {
          number: 38120,
          title: 'Afform - Number field bounds validation',
          author: 'bob',
          url: 'https://github.com/civicrm/civicrm-core/pull/38120',
          overlappingFiles: ['ext/afform/core/ang/afField/Number.tpl'],
          sharedIssueRefs: [],
        },
      ],
      candidateRelatedIssues: [
        {
          ref: 'dev/core#6912',
          title: 'FormBuilder drops 0 min/max on number inputs',
          state: 'opened',
          url: 'https://lab.civicrm.org/dev/core/-/issues/6912',
          labels: ['Afform'],
          snippet: 'Setting min=0 is ignored.',
        },
      ],
      diffFiles: parseUnifiedDiff(SAMPLE_DIFF),
      droppedNoiseFiles: [],
      diffTruncated: false,
      abReport: {
        executed: true,
        imageA: 'standalone-master',
        imageB: 'standalone-master',
        checks: [],
        surfaceDiff: {
          changes: [],
          unverifiedSurfaces: [],
          touchedComponents: ['Afform'],
          summary: 'No surface changes.',
        },
        demoConsoleErrors: [],
        notVerified: [],
      },
      staticDelta: { executed: false, toolsRun: [], findings: [], summary: 'Skipped' },
      ciStatus: {
        overallState: 'success',
        checks: [{ name: 'Jenkins', state: 'success' }],
        jenkinsFailedTests: [],
        summary: '1/1 passed',
      },
      notVerified: [],
    };

    const config = loadConfig('/tmp/nonexistent-cfg-dir', { preset: 'sonnet-opus' });
    const mockRunner: StageRunner = {
      providers: ['anthropic'],
      async run(req) {
        if (req.stage !== 'triage') {
          const output = req.stage.startsWith('specialist')
            ? { lens: 'correctness', summary: 'none', findings: [], checkedWithoutFindings: [] }
            : { verifiedFindings: [], notes: 'none' };
          return {
            output: req.schema.parse(output),
            model: req.model,
            provider: 'anthropic',
            durationMs: 1,
          };
        }
        return {
          output: req.schema.parse({
            prKind: 'core-bugfix',
            riskLevel: 'low',
            activeLenses: ['correctness'],
            summaryBullets: ['Fixes min=0 attribute'],
            recommendedAbTests: [],
            relatedItems: [
              {
                kind: 'pr',
                ref: '#38120',
                title: 'Afform - Number field bounds validation',
                url: 'https://github.com/civicrm/civicrm-core/pull/38120',
                relationship: 'conflicts',
                confidence: 90,
                reason: 'Modifies the same Number.tpl file.',
              },
              {
                kind: 'gitlab-issue',
                ref: 'dev/core#6912',
                title: 'FormBuilder drops 0 min/max on number inputs',
                url: 'https://lab.civicrm.org/dev/core/-/issues/6912',
                relationship: 'related',
                confidence: 85,
                reason: 'Describes the exact 0 min/max bug.',
              },
              {
                kind: 'pr',
                ref: '#99999',
                title: 'Hallucinated PR not in candidates',
                url: 'https://github.com/civicrm/civicrm-core/pull/99999',
                relationship: 'duplicate',
                confidence: 95,
                reason: 'Should be filtered out by grounding check.',
              },
              {
                kind: 'gitlab-issue',
                ref: 'dev/core#6912',
                title: 'Low confidence duplicate',
                url: 'https://lab.civicrm.org/dev/core/-/issues/6912',
                relationship: 'related',
                confidence: 45,
                reason: 'Below 60% threshold.',
              },
            ],
          }),
          model: req.model,
          provider: 'anthropic',
          durationMs: 50,
        };
      },
    };

    const review = await runReviewPipeline({
      bundle,
      filteredPatch: SAMPLE_DIFF,
      config,
      cwd: process.cwd(),
      registry: createRunnerRegistry({ anthropic: mockRunner }),
    });

    expect(review.relatedItems).toHaveLength(2);
    expect(review.relatedItems![0]!.ref).toBe('#38120');
    expect(review.relatedItems![1]!.ref).toBe('dev/core#6912');

    const md = formatReviewMarkdown(review, bundle, { preset: 'sonnet-opus' }).summaryBody;
    expect(md).toContain('#### Related open PRs and issues');
    expect(md).toContain('⚠️ `conflicts`');
    expect(md).toContain('**90%**');
    expect(md).toContain('dev/core#6912');
    expect(md).toContain('**85%**');
    expect(md).not.toContain('#99999');
  });

  test('checkRelatedPrMergeConflicts marks clean vs conflicting PRs using git merge-tree', async () => {
    const calls: string[][] = [];
    const gitExec = async (args: string[]) => {
      calls.push(args);
      if (args.includes('fetch')) {
        return { exitCode: 0, stdout: '', stderr: '' };
      }
      if (args.includes('merge-tree')) {
        if (args.includes('refs/civireview/related-pr-101')) {
          return {
            exitCode: 1,
            stdout:
              'deadbeef\nCONFLICT (content): Merge conflict in ext/financialacls/financialacls.php\n',
            stderr: '',
          };
        }
        if (args.includes('refs/civireview/related-pr-102')) {
          // Conflict only in a file NOT in overlappingFiles (caused by base-branch drift)
          return {
            exitCode: 1,
            stdout:
              'deadbeef\nCONFLICT (content): Merge conflict in CRM/Event/Form/Registration.php\n',
            stderr: '',
          };
        }
        return { exitCode: 0, stdout: 'cafebabe\n', stderr: '' };
      }
      return { exitCode: 1, stdout: '', stderr: '' };
    };

    const res = await checkRelatedPrMergeConflicts({
      repoRoot: '/tmp/repo',
      baseSha: 'aaaa1111',
      headSha: 'bbbb2222',
      baseBranch: 'master',
      candidates: [
        {
          number: 101,
          title: 'Conflicting PR',
          author: 'alice',
          baseBranch: 'master',
          url: 'https://github.com/civicrm/civicrm-core/pull/101',
          overlappingFiles: ['ext/financialacls/financialacls.php'],
          sharedIssueRefs: [],
        },
        {
          number: 102,
          title: 'Clean same-file PR',
          author: 'bob',
          baseBranch: 'master',
          url: 'https://github.com/civicrm/civicrm-core/pull/102',
          overlappingFiles: ['ext/financialacls/financialacls.php'],
          sharedIssueRefs: [],
        },
      ],
      gitExec,
    });

    expect(calls.some((c) => c.includes('fetch'))).toBe(true);
    expect(res[0]?.mergeConflict).toBe('conflicts');
    expect(res[0]?.conflictingFiles).toEqual(['ext/financialacls/financialacls.php']);
    expect(res[1]?.mergeConflict).toBe('clean');
    expect(res[1]?.conflictingFiles).toBeUndefined();
  });
});
