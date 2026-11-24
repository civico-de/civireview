#!/usr/bin/env bun
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { loadConfig } from '../src/config/loader.ts';
import {
  AuthorAssociationSchema,
  EffortModeSchema,
  ModelSpecSchema,
  PresetNameSchema,
  ReviewDepthSchema,
  WatchModeSchema,
  type AuthorAssociation,
  type ModelOverrides,
  type PresetName,
} from '../src/config/schema.ts';
import { runReviewPipeline, runThreadReply } from '../src/engine/pipeline.ts';
import { FinalReviewSchema, ThreadReplyOutputSchema } from '../src/engine/schemas.ts';
import { collectEvidence } from '../src/evidence/collector.ts';
import { EvidenceBundleSchema } from '../src/evidence/types.ts';
import { parseMentionCommand } from '../src/github/commands.ts';
import { formatReviewMarkdown } from '../src/github/formatter.ts';
import { publishReview, publishThreadReply } from '../src/github/publisher.ts';
import { buildThreadContextFromBundle, formatThreadReplyBody } from '../src/github/thread-reply.ts';
import { runWatcher } from '../src/github/watcher.ts';

const HELP_TEXT = `civireview — CiviCRM-native multi-model AI PR reviewer

Usage:
  civireview pr <pr-url-or-number> [options]
  civireview local [options]
  civireview evidence --repo <owner/name> --pr <num> --out <dir> [options]
  civireview review --evidence <dir> --out <review.json> [options]
  civireview publish --review <review.json> --evidence <dir> [options]
  civireview reply --repo <owner/name> --pr <num> --comment-id <id> --evidence <dir> --question <text> [options]
  civireview parse-command --body-env <ENV_VAR> [--trigger @civireview]
  civireview watch [options]

Subcommands:
  pr              Collect evidence, run multi-model review, and post to GitHub PR
  local           Review local git branch diff and print Markdown report
  evidence        Layer 1 ONLY: collect PR + CiviKitchen A/B evidence bundle (no LLM secrets)
  review          Layer 2 ONLY: run LLM review pipeline on saved evidence bundle
  publish         Layer 3 ONLY: format and post saved review.json (or --reply) to GitHub PR
  reply           Answer a follow-up question in an inline PR review comment thread
  parse-command   Safely parse @civireview flags from an environment variable
  watch           Poll upstream repos or notifications for @civireview mentions

Common Options:
  --repo <owner/name>       GitHub repository slug
  --preset <name>           Model preset (sonnet, sonnet-opus, cross-model, subscription, local-gpu)
  --effort <mode>           Reasoning effort (auto [default], low, medium, high, xhigh, max)
  --depth <profile>         Review depth profile (fast, balanced, deep [default])
  --model <provider:model>  Override all specialist models
  --triage <provider:m>     Override Stage 0 triage model
  --verifier <provider:m>   Override verifier model
  --ab / --no-ab            Enable or disable CiviKitchen A/B verification
  --browser / --no-browser  Enable or disable Standalone browser A/B verification (default: on)
  --page <civicrm/...>      Explicit Standalone route to probe in browser A/B (repeatable)
  --interactive-browser     Keep A/B stacks alive and attach Playwright MCP (Tier 2)
  --live-prove              Keep A/B stacks alive and attach bounded live_probe_ab to Verifier
  --include <csv>           Only run listed checks/lenses (repeatable or comma-separated)
  --exclude <csv>           Skip listed checks/lenses (repeatable or comma-separated)
  --demo                    Enable interactive ck demo run
  --full                    Ignore incremental marker and review full PR diff
  --dry-run                 Print formatted output instead of posting to GitHub
  --out <path>              Output directory or file path
  --cwd <dir>               Repository working directory (default: process.cwd())
  --base <ref>              (local) Branch to compare against
  --head-sha <sha>          (evidence) Fail when the PR head is no longer this commit
  --base-sha <sha>          (evidence) Fail when the PR base is no longer this commit
  --body-env <ENV_VAR>      (parse-command) Variable holding the comment body (default: COMMENT_BODY)
  --trigger <text>          Mention to react to (default: @civireview)
  --bot-login <login>       Login the reviews are posted as; only its comments count as review markers
  -h, --help                Show this help message

Reply Options:
  --pr <num>                Pull request number
  --comment-id <id>         GitHub pull_request_review_comment ID to reply to
  --evidence <dir>          Evidence bundle directory
  --question <text>         Follow-up question text
  --reply <reply.json>      (publish) Path to generated reply JSON for isolated CI publishing

Watch Options:
  --mode <search|notifications>        Polling mode (default: search)
  --repos <owner/repo,...>             Comma-separated repos to watch
  --allow <user1,user2,...>            Comma-separated GitHub usernames allowed to trigger
  --allow-orgs <org1,org2,...>         Comma-separated GitHub orgs whose members can trigger (e.g. civicrm)
  --allow-associations <csv>           Allowed GitHub author_associations (OWNER,MEMBER,COLLABORATOR,CONTRIBUTOR)
  --max-per-hour <N>                   Rolling hourly cap on reviews/replies (defers excess mentions)
  --max-daily-usd <USD>                Rolling UTC-day estimated USD cap (defers excess mentions)
  --max-age-minutes <N>                Ignore comments older than N minutes (cold-start safeguard)
  --lock-models                        Ignore --preset/--model/--verifier overrides from PR comments
  --wait-for-ci                        Defer full PR reviews while CI/Jenkins statuses are pending
  --wait-for-ci-max-minutes <n>        Max minutes to wait for pending CI before reviewing anyway (default: 90)
  --state <path>                       Path to persistent seen/budget state file
  --out <dir>                          Save each finished review of a public repo as <dir>/<owner>-<repo>-<pr>-<comment>/review.json
  --check-only                         Poll for pending mentions and print JSON without reviewing
  --include-closed                     Include closed/merged PRs in search mode (default)
  --open-only                          Only scan open PRs in search mode
  --interval <sec>                     Poll interval in seconds (default: 60)
  --once                               Run a single poll pass and exit
`;

function splitOwnerRepo(slug: string): { owner: string; repo: string } {
  const parts = slug.trim().split('/');
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new Error(`Invalid repository slug "${slug}". Expected "<owner>/<repo>".`);
  }
  return { owner: parts[0], repo: parts[1] };
}

function parseCsvList(values?: string[]): string[] | undefined {
  if (!values || values.length === 0) return undefined;
  const items = values
    .flatMap((v) => v.split(','))
    .map((s) => s.trim())
    .filter(Boolean);
  return items.length > 0 ? items : undefined;
}

function parsePrTarget(
  target: string,
  repoFlag?: string,
): { owner: string; repo: string; prNumber: number } {
  const urlMatch = target.match(/^https?:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/i);
  if (urlMatch?.[1] && urlMatch[2] && urlMatch[3]) {
    return {
      owner: urlMatch[1],
      repo: urlMatch[2],
      prNumber: Number(urlMatch[3]),
    };
  }

  const slugMatch = target.match(/^([^/\s]+)\/([^#\s]+)#(\d+)$/);
  if (slugMatch?.[1] && slugMatch[2] && slugMatch[3]) {
    return {
      owner: slugMatch[1],
      repo: slugMatch[2],
      prNumber: Number(slugMatch[3]),
    };
  }

  const prNum = Number(target);
  if (!Number.isInteger(prNum) || prNum <= 0) {
    throw new Error(
      `Invalid PR target "${target}". Provide a PR URL, owner/repo#123, or PR number with --repo.`,
    );
  }
  if (!repoFlag) {
    throw new Error('--repo <owner/name> is required when passing a bare PR number.');
  }
  const { owner, repo } = splitOwnerRepo(repoFlag);
  return { owner, repo, prNumber: prNum };
}

async function resolveGitLocalRefs(
  cwd: string,
  baseRefArg?: string,
): Promise<{ baseSha: string; headSha: string; baseBranch: string }> {
  const runGit = async (args: string[]): Promise<string | null> => {
    const proc = Bun.spawn(['git', '-C', cwd, ...args], {
      stdout: 'pipe',
      stderr: 'ignore',
    });
    const out = await new Response(proc.stdout).text();
    const code = await proc.exited;
    return code === 0 ? out.trim() : null;
  };

  const headSha = (await runGit(['rev-parse', 'HEAD'])) ?? 'HEAD';
  const candidates = baseRefArg
    ? [baseRefArg]
    : ['origin/master', 'origin/main', 'master', 'main', 'HEAD~1'];

  for (const ref of candidates) {
    const verified = await runGit(['rev-parse', '--verify', ref]);
    if (!verified) continue;
    const mergeBase =
      ref === 'HEAD~1' ? verified : ((await runGit(['merge-base', verified, headSha])) ?? verified);
    return {
      baseSha: mergeBase,
      headSha,
      baseBranch: ref.replace(/^origin\//, ''),
    };
  }

  throw new Error('Could not resolve a base git ref. Pass --base <ref> explicitly.');
}

function buildConfigOverrides(opts: {
  botLogin?: string;
  preset?: string;
  effort?: string;
  depth?: string;
  model?: string;
  triage?: string;
  verifier?: string;
  ab?: boolean;
  demo?: boolean;
  browser?: boolean;
  interactiveBrowser?: boolean;
  liveProve?: boolean;
  include?: string[];
  exclude?: string[];
  pages?: string[];
}) {
  let preset: PresetName | undefined;
  if (opts.preset !== undefined) {
    preset = PresetNameSchema.parse(opts.preset);
  }

  const models: ModelOverrides = {};
  if (opts.model !== undefined) {
    const spec = ModelSpecSchema.parse(opts.model);
    models.specialists = {
      correctness: spec,
      security: spec,
      tests: spec,
      ui: spec,
    };
    // When overriding specialists to a local CLI provider without specifying --preset
    // or --triage (and with no Anthropic API key configured), avoid failing Stage 0 on
    // the default `sonnet` preset's API-backed `anthropic:claude-haiku-5-5`.
    if (
      opts.preset === undefined &&
      opts.triage === undefined &&
      !process.env.ANTHROPIC_API_KEY &&
      /^(?:claude-cli|codex-cli|opencode-cli):/.test(spec)
    ) {
      models.triage = spec.startsWith('claude-cli:') ? 'claude-cli:haiku' : spec;
    }
  }
  if (opts.triage !== undefined) {
    models.triage = ModelSpecSchema.parse(opts.triage);
  }
  if (opts.verifier !== undefined) {
    models.verifier = ModelSpecSchema.parse(opts.verifier);
  }

  const checks: Record<string, boolean> = {};
  if (opts.browser !== undefined) checks.browser = opts.browser;
  if (opts.interactiveBrowser) checks.interactiveBrowser = true;
  if (opts.liveProve) checks.liveProve = true;

  const review: Record<string, unknown> = {};
  if (opts.effort !== undefined) {
    review.effort = EffortModeSchema.parse(opts.effort.toLowerCase());
  }
  if (opts.depth !== undefined) {
    review.depth = ReviewDepthSchema.parse(opts.depth.toLowerCase());
  }
  if (opts.include && opts.include.length > 0) review.include = opts.include;
  if (opts.exclude && opts.exclude.length > 0) review.exclude = opts.exclude;

  return {
    botLogin: opts.botLogin,
    preset,
    models: Object.keys(models).length > 0 ? models : undefined,
    ab:
      opts.ab !== undefined || opts.demo !== undefined || opts.liveProve
        ? {
            ...(opts.ab !== undefined ? { enabled: opts.ab } : {}),
            ...(opts.demo !== undefined ? { runDemo: opts.demo } : {}),
            ...(opts.liveProve ? { liveProve: true } : {}),
          }
        : undefined,
    checks: Object.keys(checks).length > 0 ? checks : undefined,
    browser: opts.pages && opts.pages.length > 0 ? { pages: opts.pages } : undefined,
    review: Object.keys(review).length > 0 ? review : undefined,
  };
}

function parseBoolPairFlag(argv: string[], posFlag: string, negFlag: string): boolean | undefined {
  let result: boolean | undefined;
  for (const arg of argv) {
    if (arg === posFlag) result = true;
    if (arg === negFlag) result = false;
  }
  return result;
}

function parseOptionalPositiveNumber(
  raw: string | undefined,
  flagName: string,
  integer = false,
): number | undefined {
  if (raw === undefined) return undefined;
  const num = Number(raw);
  if (!Number.isFinite(num) || num <= 0 || (integer && !Number.isInteger(num))) {
    throw new Error(`Invalid ${flagName} value "${raw}"`);
  }
  return num;
}

async function main(): Promise<void> {
  const rawArgv = process.argv.slice(2);
  if (
    rawArgv.length === 0 ||
    rawArgv[0] === '-h' ||
    rawArgv[0] === '--help' ||
    rawArgv[0] === 'help'
  ) {
    console.log(HELP_TEXT);
    return;
  }

  const subcommand = rawArgv[0]!;
  const subArgv = rawArgv.slice(1);
  const abFlag = parseBoolPairFlag(subArgv, '--ab', '--no-ab');
  const browserFlag = parseBoolPairFlag(subArgv, '--browser', '--no-browser');
  const sanitizedSubArgv = subArgv.filter(
    (a) => a !== '--no-ab' && a !== '--ab' && a !== '--no-browser' && a !== '--browser',
  );

  const { values, positionals } = parseArgs({
    args: sanitizedSubArgv,
    allowPositionals: true,
    options: {
      repo: { type: 'string' },
      pr: { type: 'string' },
      preset: { type: 'string' },
      effort: { type: 'string' },
      depth: { type: 'string' },
      model: { type: 'string' },
      triage: { type: 'string' },
      verifier: { type: 'string' },
      demo: { type: 'boolean', default: false },
      full: { type: 'boolean', default: false },
      'dry-run': { type: 'boolean', default: false },
      'interactive-browser': { type: 'boolean', default: false },
      'live-prove': { type: 'boolean', default: false },
      include: { type: 'string', multiple: true },
      exclude: { type: 'string', multiple: true },
      page: { type: 'string', multiple: true },
      out: { type: 'string' },
      base: { type: 'string' },
      'base-sha': { type: 'string' },
      'head-sha': { type: 'string' },
      evidence: { type: 'string' },
      review: { type: 'string' },
      reply: { type: 'string' },
      question: { type: 'string' },
      'comment-id': { type: 'string' },
      'body-env': { type: 'string' },
      trigger: { type: 'string' },
      'bot-login': { type: 'string' },
      mode: { type: 'string' },
      repos: { type: 'string', multiple: true },
      allow: { type: 'string', multiple: true },
      'allow-orgs': { type: 'string', multiple: true },
      'allow-associations': { type: 'string', multiple: true },
      'max-per-hour': { type: 'string' },
      'max-daily-usd': { type: 'string' },
      'max-age-minutes': { type: 'string' },
      'lock-models': { type: 'boolean', default: false },
      'wait-for-ci': { type: 'boolean', default: false },
      'wait-for-ci-max-minutes': { type: 'string' },
      state: { type: 'string' },
      'check-only': { type: 'boolean', default: false },
      'include-closed': { type: 'boolean', default: false },
      'open-only': { type: 'boolean', default: false },
      interval: { type: 'string' },
      once: { type: 'boolean', default: false },
      cwd: { type: 'string' },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });

  if (values.help) {
    console.log(HELP_TEXT);
    return;
  }

  const cwd = resolve(values.cwd ?? process.cwd());
  const includeList = parseCsvList(values.include);
  const excludeList = parseCsvList(values.exclude);
  const pageList = parseCsvList(values.page);

  if (subcommand === 'parse-command') {
    const envName = values['body-env'] ?? 'COMMENT_BODY';
    const body = process.env[envName] ?? '';
    const parsed = parseMentionCommand(body, values.trigger ?? '@civireview');
    console.log(JSON.stringify(parsed, null, 2));
    return;
  }

  if (subcommand === 'evidence') {
    if (!values.repo || !values.pr || !values.out) {
      throw new Error('civireview evidence requires --repo <owner/name> --pr <num> --out <dir>');
    }
    const { owner, repo } = splitOwnerRepo(values.repo);
    const prNumber = Number(values.pr);
    if (!Number.isInteger(prNumber) || prNumber <= 0) {
      throw new Error(`Invalid --pr value "${values.pr}"`);
    }

    const config = loadConfig(
      cwd,
      buildConfigOverrides({
        botLogin: values['bot-login'],
        ab: abFlag,
        demo: values.demo ? true : undefined,
        browser: browserFlag,
        interactiveBrowser: values['interactive-browser'] ? true : undefined,
        liveProve: values['live-prove'] ? true : undefined,
        include: includeList,
        exclude: excludeList,
        pages: pageList,
      }),
    );

    const outDir = resolve(values.out);
    const { bundle, cleanup } = await collectEvidence({
      repoRoot: cwd,
      config,
      outputDir: outDir,
      owner,
      repo,
      prNumber,
      incremental: !values.full,
    });

    try {
      if (values['head-sha'] && bundle.pr.headSha !== values['head-sha']) {
        throw new Error(
          `PR head SHA changed since authorization (expected ${values['head-sha']}, got ${bundle.pr.headSha}). Refusing to proceed.`,
        );
      }
      if (values['base-sha'] && bundle.pr.baseSha !== values['base-sha']) {
        throw new Error(
          `PR base SHA changed since authorization (expected ${values['base-sha']}, got ${bundle.pr.baseSha}). Refusing to proceed.`,
        );
      }

      console.error(`Evidence written to ${outDir}`);
    } finally {
      await cleanup();
    }
    return;
  }

  if (subcommand === 'review') {
    if (!values.evidence || !values.out) {
      throw new Error('civireview review requires --evidence <dir> --out <review.json>');
    }
    const evidenceDir = resolve(values.evidence);
    const bundle = EvidenceBundleSchema.parse(
      JSON.parse(readFileSync(join(evidenceDir, 'evidence.json'), 'utf8')),
    );
    const filteredPatch = readFileSync(join(evidenceDir, 'diff.patch'), 'utf8');

    const config = loadConfig(
      cwd,
      buildConfigOverrides({
        botLogin: values['bot-login'],
        preset: values.preset,
        effort: values.effort,
        depth: values.depth,
        model: values.model,
        triage: values.triage,
        verifier: values.verifier,
        interactiveBrowser: values['interactive-browser'] ? true : undefined,
        liveProve: values['live-prove'] ? true : undefined,
        include: includeList,
        exclude: excludeList,
      }),
    );

    const review = await runReviewPipeline({
      bundle,
      filteredPatch,
      config,
      cwd,
      liveUrls: bundle.abReport.browserDiff?.urls,
      logger: {
        info: (msg) => console.error(`[civireview] ${msg}`),
        warn: (msg) => console.error(`[civireview:warn] ${msg}`),
      },
    });

    const outPath = resolve(values.out);
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, JSON.stringify(review, null, 2), 'utf8');
    console.error(
      `Review written to ${outPath} (verdict=${review.verdict}${review.score ? `, score=${review.score}/5` : ''}${review.tokenUsage?.estimatedUsd !== undefined ? `, est_cost=$${review.tokenUsage.estimatedUsd.toFixed(2)}` : ''})`,
    );
    return;
  }

  if (subcommand === 'reply') {
    if (!values.evidence || !values['comment-id']) {
      throw new Error(
        'civireview reply requires --evidence <dir> --comment-id <id> [--repo owner/repo --pr num --question text]',
      );
    }
    const evidenceDir = resolve(values.evidence);
    const bundle = EvidenceBundleSchema.parse(
      JSON.parse(readFileSync(join(evidenceDir, 'evidence.json'), 'utf8')),
    );
    const filteredPatch = readFileSync(join(evidenceDir, 'diff.patch'), 'utf8');

    const repoSlug = values.repo ?? bundle.pr.repo;
    const { owner, repo } = splitOwnerRepo(repoSlug);
    const prNumber = values.pr ? Number(values.pr) : bundle.pr.prNumber;
    const commentId = Number(values['comment-id']);
    if (!Number.isInteger(commentId) || commentId <= 0) {
      throw new Error(`Invalid --comment-id value "${values['comment-id']}"`);
    }

    const config = loadConfig(
      cwd,
      buildConfigOverrides({
        botLogin: values['bot-login'],
        preset: values.preset,
        effort: values.effort,
        depth: values.depth,
        model: values.model,
        triage: values.triage,
        verifier: values.verifier,
      }),
    );

    const threadContext = buildThreadContextFromBundle(bundle, commentId, values.question ?? '');

    const replyOutput = await runThreadReply({
      bundle,
      filteredPatch,
      threadContext,
      config,
      cwd,
    });

    const replyBody = formatThreadReplyBody(replyOutput, {
      triggerCommentId: commentId,
    });

    if (values.out) {
      const outPath = resolve(values.out);
      mkdirSync(dirname(outPath), { recursive: true });
      writeFileSync(outPath, JSON.stringify({ ...replyOutput, body: replyBody }, null, 2), 'utf8');
      console.error(`Reply written to ${outPath}`);
    }

    if (values['dry-run']) {
      console.log(replyBody);
      return;
    }

    const published = await publishThreadReply({
      owner,
      repo,
      prNumber,
      commentId,
      replyBody,
    });
    console.error(
      `Published thread reply #${published.commentId ?? 'unknown'}${published.htmlUrl ? ` (${published.htmlUrl})` : ''}`,
    );
    return;
  }

  if (subcommand === 'publish') {
    if (!values.evidence) {
      throw new Error(
        'civireview publish requires --evidence <dir> and either --review <review.json> or --reply <reply.json>',
      );
    }
    const evidenceDir = resolve(values.evidence);
    const bundle = EvidenceBundleSchema.parse(
      JSON.parse(readFileSync(join(evidenceDir, 'evidence.json'), 'utf8')),
    );

    if (values.reply) {
      if (!values['comment-id']) {
        throw new Error('civireview publish --reply requires --comment-id <id>');
      }
      const commentId = Number(values['comment-id']);
      const rawReply = JSON.parse(readFileSync(resolve(values.reply), 'utf8'));
      const validatedReply = ThreadReplyOutputSchema.parse(rawReply);
      const replyBody =
        typeof rawReply.body === 'string' && rawReply.body.trim()
          ? rawReply.body
          : formatThreadReplyBody(validatedReply);
      const { owner, repo } = splitOwnerRepo(bundle.pr.repo);

      const published = await publishThreadReply({
        owner,
        repo,
        prNumber: bundle.pr.prNumber,
        commentId,
        replyBody,
        dryRun: values['dry-run'],
      });
      if (values['dry-run']) {
        console.log(published.body);
      } else {
        console.error(
          `Published thread reply #${published.commentId ?? 'unknown'}${published.htmlUrl ? ` (${published.htmlUrl})` : ''}`,
        );
      }
      return;
    }

    if (!values.review) {
      throw new Error('civireview publish requires --review <review.json> --evidence <dir>');
    }
    const review = FinalReviewSchema.parse(
      JSON.parse(readFileSync(resolve(values.review), 'utf8')),
    );
    const { owner, repo } = splitOwnerRepo(review.repo);
    const config = loadConfig(
      cwd,
      values.preset ? { preset: PresetNameSchema.parse(values.preset) } : {},
    );

    const commentId = values['comment-id'] ? Number(values['comment-id']) : undefined;

    const result = await publishReview({
      owner,
      repo,
      prNumber: review.prNumber,
      review,
      bundle,
      dryRun: values['dry-run'],
      force: values.full,
      commentId: Number.isFinite(commentId) ? commentId : undefined,
      preset: values.preset ?? config.preset,
      maxInlineComments: config.review.maxInlineComments,
      reviewEvent: config.review.reviewEvent,
      mentionUsers: config.review.mentionUsers,
    });

    if (values['dry-run']) {
      console.log(result.summaryBody);
      console.error(`[dry-run] Would post ${result.inlineComments.length} inline comment(s).`);
    } else if (result.skippedDuplicate) {
      console.error(
        `Skipped duplicate review for ${review.repo}#${review.prNumber} (${review.headSha.slice(0, 7)} already reviewed; pass --full to force).`,
      );
    } else {
      console.error(
        `Published review #${result.reviewId ?? 'unknown'}${result.htmlUrl ? ` (${result.htmlUrl})` : ''}${result.fallbackUsed ? ' [422 fallback applied]' : ''}`,
      );
    }
    return;
  }

  if (subcommand === 'pr') {
    const target = positionals[0] ?? values.pr;
    if (!target) {
      throw new Error(
        'civireview pr requires <pr-url-or-number> (e.g. civireview pr 123 --repo owner/repo)',
      );
    }
    const { owner, repo, prNumber } = parsePrTarget(target, values.repo);
    const config = loadConfig(
      cwd,
      buildConfigOverrides({
        botLogin: values['bot-login'],
        preset: values.preset,
        effort: values.effort,
        depth: values.depth,
        model: values.model,
        triage: values.triage,
        verifier: values.verifier,
        ab: abFlag,
        demo: values.demo ? true : undefined,
        browser: browserFlag,
        interactiveBrowser: values['interactive-browser'] ? true : undefined,
        liveProve: values['live-prove'] ? true : undefined,
        include: includeList,
        exclude: excludeList,
        pages: pageList,
      }),
    );

    const outDir = values.out ? resolve(values.out) : undefined;
    const tempScreenshotDir = outDir ? undefined : mkdtempSync(join(tmpdir(), 'civireview-pr-'));
    const effectiveOutDir = outDir ?? tempScreenshotDir;

    const { bundle, filteredPatch, urls, composeFiles, cleanup } = await collectEvidence({
      repoRoot: cwd,
      config,
      outputDir: effectiveOutDir,
      owner,
      repo,
      prNumber,
      incremental: !values.full,
    });

    try {
      const dryRun = values['dry-run'] || !config.review.autoPost;
      if (
        !values.full &&
        !dryRun &&
        bundle.pr.lastReviewedHeadSha &&
        bundle.pr.lastReviewedHeadSha === bundle.pr.headSha
      ) {
        console.error(
          `[civireview] ${owner}/${repo}#${prNumber} head ${bundle.pr.headSha.slice(0, 7)} was already reviewed; pass --full to re-review.`,
        );
        return;
      }

      const review = await runReviewPipeline({
        bundle,
        filteredPatch,
        config,
        cwd,
        liveUrls: urls,
        composeFiles,
        logger: {
          info: (msg) => console.error(`[civireview] ${msg}`),
          warn: (msg) => console.error(`[civireview:warn] ${msg}`),
        },
      });

      const published = await publishReview({
        owner,
        repo,
        prNumber,
        review,
        bundle,
        dryRun,
        force: values.full,
        preset: config.preset,
        maxInlineComments: config.review.maxInlineComments,
        reviewEvent: config.review.reviewEvent,
        mentionUsers: config.review.mentionUsers,
      });

      if (outDir) {
        mkdirSync(outDir, { recursive: true });
        writeFileSync(join(outDir, 'review.json'), JSON.stringify(review, null, 2), 'utf8');
        writeFileSync(join(outDir, 'review.md'), published.summaryBody, 'utf8');
      }

      if (dryRun) {
        console.log(published.summaryBody);
        console.error(
          `[dry-run] Verdict=${review.verdict}${review.score ? `, Score=${review.score}/5` : ''}${review.tokenUsage?.estimatedUsd !== undefined ? `, EstCost=$${review.tokenUsage.estimatedUsd.toFixed(2)}` : ''}, inline=${published.inlineComments.length}`,
        );
      } else {
        console.error(
          `Published review #${published.reviewId ?? 'unknown'} (${review.verdict}${review.score ? `, ${review.score}/5` : ''}${review.tokenUsage?.estimatedUsd !== undefined ? `, ~$${review.tokenUsage.estimatedUsd.toFixed(2)}` : ''})${published.htmlUrl ? `: ${published.htmlUrl}` : ''}`,
        );
      }
    } finally {
      await cleanup();
      if (tempScreenshotDir) {
        rmSync(tempScreenshotDir, { recursive: true, force: true });
      }
    }
    return;
  }

  if (subcommand === 'local') {
    const config = loadConfig(
      cwd,
      buildConfigOverrides({
        botLogin: values['bot-login'],
        preset: values.preset,
        effort: values.effort,
        depth: values.depth,
        model: values.model,
        triage: values.triage,
        verifier: values.verifier,
        ab: abFlag,
        demo: values.demo ? true : undefined,
        browser: browserFlag,
        interactiveBrowser: values['interactive-browser'] ? true : undefined,
        liveProve: values['live-prove'] ? true : undefined,
        include: includeList,
        exclude: excludeList,
        pages: pageList,
      }),
    );

    const refs = await resolveGitLocalRefs(cwd, values.base);
    const outDir = values.out ? resolve(values.out) : undefined;
    const tempOutDir = outDir ? undefined : mkdtempSync(join(tmpdir(), 'civireview-local-'));

    const { bundle, filteredPatch, urls, composeFiles, cleanup } = await collectEvidence({
      repoRoot: cwd,
      config,
      outputDir: outDir ?? tempOutDir,
      baseSha: refs.baseSha,
      headSha: refs.headSha,
      baseBranch: refs.baseBranch,
    });

    try {
      const review = await runReviewPipeline({
        bundle,
        filteredPatch,
        config,
        cwd,
        liveUrls: urls,
        composeFiles,
        logger: {
          info: (msg) => console.error(`[civireview] ${msg}`),
          warn: (msg) => console.error(`[civireview:warn] ${msg}`),
        },
      });

      const formatted = formatReviewMarkdown(review, bundle, {
        preset: config.preset,
        maxInlineComments: config.review.maxInlineComments,
        mentionUsers: config.review.mentionUsers,
      });
      console.log(formatted.summaryBody);
      if (formatted.inlineComments.length > 0) {
        console.log('\n### Inline Findings\n');
        for (const c of formatted.inlineComments) {
          const range = c.start_line ? `${c.start_line}-${c.line}` : `${c.line}`;
          console.log(`#### \`${c.path}:${range}\` (${c.side})\n\n${c.body}\n`);
        }
      }
    } finally {
      await cleanup();
      if (tempOutDir) {
        rmSync(tempOutDir, { recursive: true, force: true });
      }
    }
    return;
  }

  if (subcommand === 'watch') {
    const config = loadConfig(
      cwd,
      buildConfigOverrides({
        botLogin: values['bot-login'],
        preset: values.preset,
        effort: values.effort,
        depth: values.depth,
        model: values.model,
        triage: values.triage,
        verifier: values.verifier,
        ab: abFlag,
        demo: values.demo ? true : undefined,
        browser: browserFlag,
        interactiveBrowser: values['interactive-browser'] ? true : undefined,
        liveProve: values['live-prove'] ? true : undefined,
        include: includeList,
        exclude: excludeList,
        pages: pageList,
      }),
    );

    const mode = WatchModeSchema.parse(values.mode ?? config.watch?.mode ?? 'search');
    const repos = (values.repos ?? [])
      .flatMap((r) => r.split(','))
      .map((s) => s.trim())
      .filter(Boolean);
    const effectiveRepos = repos.length > 0 ? repos : (config.watch?.repos ?? []);

    const allow = parseCsvList(values.allow) ?? [];
    const effectiveAllow = allow.length > 0 ? allow : (config.watch?.allowedAuthors ?? []);

    const allowOrgs = parseCsvList(values['allow-orgs']) ?? [];
    const effectiveAllowOrgs = allowOrgs.length > 0 ? allowOrgs : (config.watch?.allowedOrgs ?? []);

    const rawAssoc = parseCsvList(values['allow-associations']) ?? [];
    const effectiveAllowAssociations: AuthorAssociation[] =
      rawAssoc.length > 0
        ? rawAssoc.map((a) => AuthorAssociationSchema.parse(a.toUpperCase()))
        : (config.watch?.allowedAssociations ?? []);

    const maxReviewsPerHour =
      parseOptionalPositiveNumber(values['max-per-hour'], '--max-per-hour', true) ??
      config.watch?.maxReviewsPerHour;
    const maxDailyUsd =
      parseOptionalPositiveNumber(values['max-daily-usd'], '--max-daily-usd', false) ??
      config.watch?.maxDailyUsd;
    const maxCommentAgeMinutes =
      parseOptionalPositiveNumber(values['max-age-minutes'], '--max-age-minutes', true) ??
      config.watch?.maxCommentAgeMinutes;

    const intervalSec = values.interval
      ? Number(values.interval)
      : (config.watch?.intervalSec ?? 60);

    const includeClosedPrs = !values['open-only'];
    const checkOnly = Boolean(values['check-only']);

    const passResult = await runWatcher({
      mode,
      repos: effectiveRepos,
      allowedAuthors: effectiveAllow,
      allowedOrgs: effectiveAllowOrgs,
      allowedAssociations: effectiveAllowAssociations,
      includeClosedPrs,
      maxReviewsPerHour,
      maxDailyUsd,
      maxCommentAgeMinutes,
      lockModels: values['lock-models'] ? true : config.watch?.lockModels,
      waitForCi: values['wait-for-ci'] ? true : config.watch?.waitForCi,
      waitForCiMaxMinutes:
        parseOptionalPositiveNumber(
          values['wait-for-ci-max-minutes'],
          '--wait-for-ci-max-minutes',
          true,
        ) ?? config.watch?.waitForCiMaxMinutes,
      trigger: values.trigger ?? config.trigger,
      intervalSec,
      once: values.once || checkOnly,
      checkOnly,
      statePath: values.state ? resolve(values.state) : config.watch?.statePath,
      outDir: values.out ? resolve(values.out) : undefined,
      config,
      repoRoot: cwd,
      dryRun: values['dry-run'],
      logger: {
        info: (msg) => console.error(`[civireview:watch] ${msg}`),
        warn: (msg) => console.error(`[civireview:watch:warn] ${msg}`),
      },
    });

    if (checkOnly && passResult) {
      console.log(
        JSON.stringify(
          {
            pendingCount: passResult.pending.length,
            throttledCount: passResult.throttled.length,
            skippedDuplicateCount: passResult.skippedDuplicate.length,
            waitingForCiCount: passResult.waitingForCi.length,
            pending: passResult.pending.map((m) => ({
              repo: m.repoFullName,
              prNumber: m.prNumber,
              commentId: m.commentId,
              commentKind: m.commentKind,
              author: m.author,
              authorAssociation: m.authorAssociation,
            })),
          },
          null,
          2,
        ),
      );
    }
    if (passResult && passResult.failed.length > 0) {
      throw new Error(`${passResult.failed.length} mention(s) failed; see warnings above.`);
    }
    return;
  }

  throw new Error(`Unknown subcommand "${subcommand}". Run "civireview --help" for usage.`);
}

main().catch((err) => {
  console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
