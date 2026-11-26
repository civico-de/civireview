import { standaloneRan } from '../engine/findings.ts';
import { mapFindingsToDiff, type MappedInlineFinding } from '../engine/line-mapper.ts';
import { buildShortSummary, computeConfidenceScore } from '../engine/pipeline.ts';
import { formatUsd } from '../runners/pricing.ts';
import type {
  ConfidenceScore,
  FinalReview,
  FinalVerdict,
  VerificationMatrixEntry,
  VerificationStatus,
  VerifiedFinding,
} from '../engine/schemas.ts';
import { cmsLabel } from '../evidence/cms-scope.ts';
import { reviewProfile } from '../evidence/repo-detect.ts';
import type { EvidenceBundle } from '../evidence/types.ts';

export interface GitHubReviewCommentInput {
  path: string;
  line: number;
  start_line?: number;
  side: 'RIGHT' | 'LEFT';
  start_side?: 'RIGHT' | 'LEFT';
  body: string;
}

export interface FormatReviewOptions {
  preset?: string;
  maxInlineComments?: number;
  triggerCommentId?: number;
  mentionUsers?: boolean;
}

const CODE_ANNOTATION_TAGS = new Set([
  'param',
  'return',
  'returns',
  'var',
  'type',
  'throws',
  'todo',
  'deprecated',
  'internal',
  'see',
  'link',
  'covers',
  'dataprovider',
  'depends',
  'before',
  'after',
  'test',
  'group',
  'runinseparateprocess',
  'preserveglobalstate',
  'suppresswarnings',
  'psalm',
  'phpstan',
  'template',
  'extends',
  'implements',
  'property',
  'method',
  'mixin',
  'author',
  'license',
  'since',
  'version',
  'package',
  'subpackage',
  'category',
  'copyright',
  'inheritdoc',
]);

/**
 * Replaces raw `@username` GitHub mentions outside backticks/code blocks with
 * `` `username` `` when `mentionUsers` is `false` (default) so posted reviews
 * never send unsolicited GitHub notifications to PR commenters.
 */
export function sanitizeGitHubMentions(markdown: string, mentionUsers = false): string {
  if (mentionUsers) return markdown;
  // Split preserving fenced code blocks and inline code spans so we never touch code
  const segments = markdown.split(/(```[\s\S]*?```|`[^`\n]+`)/g);
  return segments
    .map((seg, idx) => {
      if (idx % 2 === 1) return seg;
      return seg.replace(
        /(^|[^A-Za-z0-9_/`])@([A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38})\b/g,
        (full, prefix: string, handle: string) => {
          if (CODE_ANNOTATION_TAGS.has(handle.toLowerCase())) {
            return full;
          }
          return `${prefix}\`${handle}\``;
        },
      );
    })
    .join('');
}

/** GitHub rejects review and comment bodies above 65,536 characters. */
export const MAX_GITHUB_BODY_CHARS = 60_000;

export function truncateForGitHub(text: string, max = MAX_GITHUB_BODY_CHARS): string {
  if (text.length <= max) return text;
  const note = "\n\n_… truncated to fit GitHub's size limit._";
  return text.slice(0, Math.max(0, max - note.length)) + note;
}

/** Drops optional `<details>` sections from the end, then truncates the largest remaining ones. */
export function fitSectionsToLimit(
  sections: string[],
  max = MAX_GITHUB_BODY_CHARS,
  keep: ReadonlySet<string> = new Set(),
): string[] {
  const out = [...sections];
  const total = () => out.join('\n\n').length;
  // The last section holds the footer and dedup marker and always stays; sections in
  // `keep` are only truncated.
  let omitted = 0;
  for (let i = out.length - 2; i >= 0 && total() > max; i--) {
    if (out[i]?.startsWith('<details>') && !keep.has(out[i]!)) {
      out.splice(i, 1);
      omitted++;
    }
  }
  if (omitted > 0) {
    out.splice(
      out.length - 1,
      0,
      `_${omitted} detail section(s) omitted to fit GitHub's size limit._`,
    );
  }
  // One pass per section is enough: each pass cuts the largest one left.
  for (let pass = 0; pass < out.length && total() > max; pass++) {
    let largest = 0;
    for (let i = 1; i < out.length - 1; i++) {
      if ((out[i]?.length ?? 0) > (out[largest]?.length ?? 0)) largest = i;
    }
    const section = out[largest] ?? '';
    const target = Math.max(0, section.length - (total() - max));
    // A cut disclosure keeps its closing tag, or it would fold the footer too.
    const close = '\n</details>';
    out[largest] = section.endsWith(close)
      ? truncateForGitHub(section.slice(0, -close.length), Math.max(0, target - close.length)) +
        close
      : truncateForGitHub(section, target);
  }
  return out;
}

/** Fence long enough that the content cannot close it early. */
function fencedBlock(content: string, info: string): string[] {
  const longestRun = Math.max(0, ...(content.match(/`+/g) ?? []).map((run) => run.length));
  const fence = '`'.repeat(Math.max(3, longestRun + 1));
  return [`${fence}${info}`, content, fence];
}

/** Inline code span that survives backticks inside the content. */
function inlineCode(content: string): string {
  if (!content.includes('`')) return `\`${content}\``;
  return `\`\` ${content} \`\``;
}

export interface FormattedReviewOutput {
  summaryBody: string;
  inlineComments: GitHubReviewCommentInput[];
  overflowFindings: VerifiedFinding[];
}

function verdictBadge(verdict: FinalVerdict): string {
  switch (verdict) {
    case 'READY':
      return '🟢 **Ready**';
    case 'NEEDS_CHANGES':
      return '🔴 **Needs Changes**';
    case 'QUESTIONS_ONLY':
      return '🟡 **Questions Only**';
  }
}

function scoreBadge(score: ConfidenceScore): string {
  const filled = '★'.repeat(score);
  const empty = '☆'.repeat(5 - score);
  return `**${score}/5** \`${filled}${empty}\``;
}

function matrixStatusBadge(status: VerificationStatus): string {
  switch (status) {
    case 'PASS':
      return '✅ PASS';
    case 'FAIL':
      return '❌ FAIL';
    case 'WARN':
      return '⚠️ WARN';
    case 'SKIPPED':
      return '⏭️ SKIPPED';
    case 'NOT_VERIFIED':
      return '❔ NOT VERIFIED';
  }
}

function escapeTableCell(text: string): string {
  return text.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ').trim();
}

export function formatInlineCommentBody(mapped: MappedInlineFinding): string {
  const f = mapped.finding;
  const badge = `[${f.reassessedSeverity.toUpperCase()} | ${f.verdict}]`;
  const lines: string[] = [`**${badge} ${f.title}**`, '', f.issue];
  if (f.suggestedFix.trim()) {
    lines.push('', `**Suggested fix:** ${f.suggestedFix}`);
  }
  if (mapped.suggestionBlock) {
    lines.push('', mapped.suggestionBlock);
  }
  lines.push(
    '',
    `<details>\n<summary>Evidence (${f.confidence}%, \`${f.lens}\`${mapped.snapped ? ', line snapped to hunk' : ''})</summary>`,
    '',
    ...findingEvidence(f),
    '</details>',
  );
  return lines.join('\n');
}

/** Failure scenario, evidence, proof and references of a finding, as Markdown lines. */
function findingEvidence(f: VerifiedFinding): string[] {
  const lines = [
    `**Failure scenario:** ${f.failureScenario}`,
    '',
    `**Verification evidence:** ${f.verificationEvidence}`,
  ];
  if (f.liveProofCommand) {
    lines.push('', `**Proof command:** ${inlineCode(f.liveProofCommand)}`);
  }
  if (f.liveProofOutput) {
    lines.push('', ...fencedBlock(f.liveProofOutput.slice(0, 800), 'text'));
  }
  if (f.mcpCitations.length > 0) {
    lines.push('', `**References:** ${f.mcpCitations.join(', ')}`);
  }
  lines.push('');
  return lines;
}

function formatSummaryFinding(f: VerifiedFinding): string {
  const badge = `[${f.reassessedSeverity.toUpperCase()} | ${f.verdict}]`;
  const parts: string[] = [
    `#### ${badge} ${f.title} (\`${lineRefOf(f)}\`, ${f.side})`,
    `_Confidence ${f.confidence}%, \`${f.lens}\`_`,
    '',
    f.issue,
  ];
  if (f.suggestedFix.trim()) {
    parts.push('', `**Suggested fix:** ${f.suggestedFix}`);
  }
  parts.push('', ...findingEvidence(f));
  return parts.join('\n').trimEnd();
}

/**
 * The version of the review's layout. Raise it when the rendering changes, so reviews
 * rendered before can be told apart and rendered again from their saved data.
 */
export const REVIEW_FORMAT = 2;

/**
 * Formats a verified `FinalReview` and `EvidenceBundle` into a GitHub PR summary body
 * and batched inline review comments.
 */
function relatedBadge(rel: 'duplicate' | 'conflicts' | 'related'): string {
  switch (rel) {
    case 'duplicate':
      return '♻️ `duplicate`';
    case 'conflicts':
      return '⚠️ `conflicts`';
    case 'related':
      return '🔗 `related`';
  }
}

function truncateOneLine(text: string, maxLen = 140): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  if (clean.length <= maxLen) return clean;
  const slice = clean.slice(0, maxLen - 1);
  const lastSpace = slice.lastIndexOf(' ');
  const cut = lastSpace >= Math.floor(maxLen * 0.6) ? slice.slice(0, lastSpace) : slice;
  return `${cut.replace(/[,;:\-–—]+$/, '').trimEnd()}…`;
}

function buildActionItems(review: FinalReview, mentionUsers = false): string[] {
  const items: string[] = [];

  for (const condition of review.mergeConditions ?? []) {
    items.push(
      `- [ ] **Merge condition** (from the PR description): ${truncateOneLine(condition, 240)}`,
    );
  }

  for (const f of review.findings) {
    const question = f.verdict === 'NEEDS_QUESTION' ? ' · question' : '';
    items.push(
      `- [ ] **${f.reassessedSeverity.toUpperCase()}${question}** \`${lineRefOf(f)}\` — ${f.title}`,
    );
  }

  for (const row of review.verificationMatrix) {
    if (row.status === 'FAIL') {
      items.push(
        `- [ ] **Check failed** ${checkLabel(row.check)}: ${truncateOneLine(row.detail, 160)}`,
      );
    }
  }

  for (const rel of review.relatedItems ?? []) {
    if (rel.relationship === 'conflicts' || rel.relationship === 'duplicate') {
      const label = rel.kind === 'pr' ? `PR ${rel.ref}` : rel.ref;
      const relation = rel.relationship === 'conflicts' ? 'Conflicts with' : 'Duplicate of';
      items.push(
        `- [ ] **${relation}** [${label}](${rel.url}): ${truncateOneLine(rel.reason, 160)}`,
      );
    }
  }

  const findingFileBasenames = review.findings
    .map((f) => f.path.split('/').pop()?.toLowerCase())
    .filter((b): b is string => Boolean(b && b.length >= 5));

  for (const tr of review.threadResolutions ?? []) {
    if (tr.status === 'open') {
      const combined = `${tr.topic} ${tr.detail}`.toLowerCase();
      if (findingFileBasenames.some((base) => combined.includes(base))) {
        continue;
      }
      const cleanAuthor = tr.author.replace(/^@/, '');
      const handle = mentionUsers ? `@${cleanAuthor}` : `\`${cleanAuthor}\``;
      items.push(`- [ ] **Open thread** ${handle}: ${truncateOneLine(tr.topic, 160)}`);
    }
  }

  return items;
}

const CHECK_LABELS: Record<string, string> = {
  'CI / Jenkins': 'CI',
  'A/B Proof-of-Fix': 'Proof of fix',
  'CiviKitchen A/B Proof-of-Fix': 'Proof of fix',
  'Base-Test Regression': 'Base tests',
  'Version Matrix': 'Versions',
  'Live Surface Diff': 'Surface',
  'Static / Taint Delta': 'Taint',
  'Browser A/B (Standalone)': 'Browser',
  'Reviewer Thread': 'Threads',
  'CMS Browser A/B': 'CMS',
  Demo: 'Demo',
};

function checkLabel(check: string): string {
  return CHECK_LABELS[check] ?? check;
}

const CHECK_ICONS: Record<VerificationStatus, string> = {
  PASS: '✅',
  FAIL: '❌',
  WARN: '⚠️',
  SKIPPED: '⏭️',
  NOT_VERIFIED: '❔',
};

/** One line of status icons; checks that do not apply are left out. */
function checksLine(matrix: VerificationMatrixEntry[]): string {
  return matrix
    .filter((row) => row.status !== 'SKIPPED')
    .map((row) => `${CHECK_ICONS[row.status]} ${checkLabel(row.check)}`)
    .join(' · ');
}

function details(summary: string, body: string): string {
  return `<details>\n<summary>${summary}</summary>\n\n${body}\n</details>`;
}

function lineRefOf(f: { path: string; startLine: number; endLine: number }): string {
  return f.startLine === f.endLine
    ? `${f.path}:${f.startLine}`
    : `${f.path}:${f.startLine}-${f.endLine}`;
}

export function formatReviewMarkdown(
  review: FinalReview,
  bundle: EvidenceBundle,
  options: FormatReviewOptions = {},
): FormattedReviewOutput {
  const preset = options.preset ?? 'custom';
  const maxInline = options.maxInlineComments ?? 10;
  const mentionUsers = options.mentionUsers ?? false;

  const { inlineFindings, summaryOnlyFindings } = mapFindingsToDiff(
    review.findings,
    bundle.diffFiles,
  );

  const keptInline = inlineFindings.slice(0, maxInline);
  const overflowFromCap = inlineFindings.slice(maxInline).map((m) => m.finding);
  const allSummaryFindings = [...summaryOnlyFindings, ...overflowFromCap];

  const inlineComments: GitHubReviewCommentInput[] = keptInline.map((m) => ({
    path: m.path,
    line: m.line,
    ...(m.startLine !== undefined ? { start_line: m.startLine, start_side: m.side } : {}),
    side: m.side,
    body: truncateForGitHub(sanitizeGitHubMentions(formatInlineCommentBody(m), mentionUsers)),
  }));

  const sections: string[] = [];

  const computedScore =
    review.score !== undefined
      ? {
          score: review.score,
          rationale:
            review.scoreRationale ??
            computeConfidenceScore({
              verdict: review.verdict,
              findings: review.findings,
              verificationMatrix: review.verificationMatrix,
              prKind: review.prKind,
            }).rationale,
        }
      : computeConfidenceScore({
          verdict: review.verdict,
          findings: review.findings,
          verificationMatrix: review.verificationMatrix,
          prKind: review.prKind,
        });

  const shortSummary =
    review.shortSummary?.trim() ||
    buildShortSummary({
      prTitle: bundle.pr.title,
      verificationMatrix: review.verificationMatrix,
      scoreRationale: computedScore.rationale,
    });

  const showImages =
    bundle.repoInfo.kind === 'civicrm-extension' ||
    bundle.abReport.imageA !== bundle.abReport.imageB;
  const imagesMeta = showImages
    ? ` · **Images:** \`${bundle.abReport.imageA}\` vs \`${bundle.abReport.imageB}\``
    : '';

  // Visible: verdict, what the PR does, what to address, one line of checks.
  sections.push(
    `## CiviReview: ${verdictBadge(review.verdict)} · ${scoreBadge(computedScore.score)}\n\n${shortSummary}`,
  );
  const actionItems = buildActionItems(review, mentionUsers);
  sections.push(
    actionItems.length > 0
      ? `**To address (${actionItems.length})**\n${actionItems.join('\n')}`
      : 'No findings above the confidence gate.',
  );
  const checks = checksLine(review.verificationMatrix);
  if (checks) sections.push(checks);

  // Everything else is folded. Findings outside the diff have no inline comment, so
  // their section is never dropped to fit the size limit.
  const keep = new Set<string>();
  if (allSummaryFindings.length > 0) {
    const outside = details(
      `Findings outside the diff (${allSummaryFindings.length})`,
      allSummaryFindings.map(formatSummaryFinding).join('\n\n'),
    );
    keep.add(outside);
    sections.push(outside);
  }

  const verification: string[] = [
    `**Merge confidence (${computedScore.score}/5):** ${computedScore.rationale}`,
    '',
    `**PR:** \`${review.repo}#${review.prNumber}\` · **Profile:** \`${reviewProfile(bundle.repoInfo)}\` · **Kind:** \`${review.prKind}\` · **Commits:** \`${review.baseSha.slice(0, 7)}\` → \`${review.headSha.slice(0, 7)}\`${imagesMeta}`,
  ];
  if (review.verificationMatrix.length > 0) {
    const matrixRows = review.verificationMatrix
      .map(
        (row) =>
          `| ${escapeTableCell(row.check)} | ${matrixStatusBadge(row.status)} | ${escapeTableCell(row.detail)} |`,
      )
      .join('\n');
    verification.push('', `| Check | Status | Detail |\n| --- | --- | --- |\n${matrixRows}`);
  }
  if (review.notVerified.length > 0) {
    verification.push(
      '',
      `**Not verified:**\n${review.notVerified.map((item) => `- ${item}`).join('\n')}`,
    );
  }
  if (bundle.repoInfo.kind === 'civicrm-core' || bundle.repoInfo.kind === 'civicrm-extension') {
    const cmsRan = bundle.abReport.cmsDemos
      .filter((d) => d.status !== 'NOT_VERIFIED')
      .map((d) => cmsLabel(d.cms));
    const ran = [...(standaloneRan(review.verificationMatrix) ? ['Standalone'] : []), ...cmsRan];
    const otherCms =
      ran.length > 0 ? `any CMS other than ${ran.join(', ')}` : 'behaviour on a running site';
    verification.push(
      '',
      `**Outside this review:** ${otherCms}; viewports other than 1280×800; whether the approach is right for the project; when to merge. Ready means no technical issue was found in what was checked.`,
    );
  }
  const bd = bundle.abReport.browserDiff;
  if (bd) {
    const routesList = Array.from(
      new Set([
        ...bd.probedRoutes,
        ...bd.probedAnonymousRoutes,
        ...bd.screenshots.map((s) => s.route),
      ]),
    );
    const browserLines: string[] = [
      `- **Probed routes (${routesList.length}):** ${routesList.map((r) => `\`${r}\``).join(', ') || 'none'}`,
      `- **New console errors:** ${bd.new_console_errors.length} · **Page errors:** ${bd.new_page_errors.length} · **Network failures:** ${bd.new_network_failures.length} · **A11y violations:** ${bd.new_a11y_violations.length} · **Render regressions:** ${bd.render_regressions.length}`,
    ];
    if (bd.screenshots.length > 0) {
      browserLines.push(
        `- **Screenshots:** ${bd.screenshots.length} before/after pair(s) captured`,
      );
    }
    const formatBrowserDetail = (label: string, items: unknown[]) => {
      if (items.length === 0) return;
      const preview = items
        .slice(0, 5)
        .map((it) => (typeof it === 'string' ? it : JSON.stringify(it)))
        .join('; ');
      browserLines.push(`- **${label}:** ${preview}`);
    };
    formatBrowserDetail('Console regressions', bd.new_console_errors);
    formatBrowserDetail('Page errors', bd.new_page_errors);
    formatBrowserDetail('Network failures', bd.new_network_failures);
    formatBrowserDetail('A11y regressions', bd.new_a11y_violations);
    formatBrowserDetail('Render regressions', bd.render_regressions);
    if (bd.error) {
      browserLines.push(`- **Error:** ${bd.error}`);
    }
    verification.push('', `**Standalone browser A/B**\n${browserLines.join('\n')}`);
  }
  const unverifiedCount =
    review.verificationMatrix.filter((row) => row.status === 'NOT_VERIFIED').length +
    review.notVerified.length;
  sections.push(
    details(
      `Verification (${review.verificationMatrix.length} checks${unverifiedCount > 0 ? `, ${unverifiedCount} not verified` : ''})`,
      verification.join('\n'),
    ),
  );

  if (review.threadResolutions && review.threadResolutions.length > 0) {
    const openCount = review.threadResolutions.filter((t) => t.status === 'open').length;
    const resolvedCount = review.threadResolutions.length - openCount;
    const statusSummary =
      openCount > 0
        ? `${openCount} open, ${resolvedCount} addressed/answered`
        : `all ${review.threadResolutions.length} addressed/answered`;
    const rows = review.threadResolutions
      .map((t) => {
        const badge =
          t.status === 'addressed'
            ? '✅ Addressed'
            : t.status === 'answered'
              ? '💬 Answered'
              : '⏳ Open';
        const cleanAuthor = t.author.replace(/^@/, '');
        const handle = mentionUsers ? `@${cleanAuthor}` : `\`${cleanAuthor}\``;
        return `| ${escapeTableCell(handle)} | ${escapeTableCell(t.topic)} | ${badge} | ${escapeTableCell(t.detail)} |`;
      })
      .join('\n');
    sections.push(
      details(
        `Reviewer threads (${statusSummary})`,
        `| Reviewer | Question / Request | Status | Detail |\n| --- | --- | --- | --- |\n${rows}`,
      ),
    );
  }

  const more: Array<{ label: string; body: string }> = [];
  if (review.walkthrough.length > 0) {
    more.push({
      label: 'walkthrough',
      body: `#### Walkthrough\n\n${review.walkthrough.map((b) => `- ${b}`).join('\n')}`,
    });
  }
  if (review.standards && review.standards.length > 0) {
    const stdRows = review.standards
      .map(
        (s) =>
          `| \`${escapeTableCell(s.code)}\` | ${escapeTableCell(s.status)} | ${escapeTableCell(s.note)} |`,
      )
      .join('\n');
    const issueCount = review.standards.filter((s) => s.status === 'ISSUE').length;
    more.push({
      label:
        issueCount > 0
          ? `standards (${issueCount} issue${issueCount === 1 ? '' : 's'})`
          : 'standards',
      body: `#### CiviCRM core standards\n\n| Code | Status | Note |\n| --- | --- | --- |\n${stdRows}`,
    });
  }
  if (review.blastRadius.length > 0) {
    const blastRows = review.blastRadius
      .map(
        (b) =>
          `| ${escapeTableCell(b.repo)} | \`${escapeTableCell(b.path)}\` | \`${escapeTableCell(b.symbol)}\` | ${escapeTableCell(b.impact)} |`,
      )
      .join('\n');
    more.push({
      label: 'blast radius',
      body: `#### Ecosystem blast radius\n\n| Repo | Path | Symbol | Impact |\n| --- | --- | --- | --- |\n${blastRows}`,
    });
  }
  if (review.relatedItems && review.relatedItems.length > 0) {
    const relRows = review.relatedItems
      .map((item) => {
        const label = item.kind === 'pr' ? `PR ${item.ref}` : item.ref;
        const safeTitle = escapeTableCell(item.title);
        return `| [${escapeTableCell(label)}](${item.url}) — ${safeTitle} | ${relatedBadge(item.relationship)} | **${Math.round(item.confidence)}%** | ${escapeTableCell(item.reason)} |`;
      })
      .join('\n');
    more.push({
      label: `related (${review.relatedItems.length})`,
      body: `#### Related open PRs and issues\n\n| Item | Relation | Confidence | Why |\n| --- | --- | --- | --- |\n${relRows}`,
    });
  }
  if (review.uncertainFindings && review.uncertainFindings.length > 0) {
    const uncertainBody = review.uncertainFindings
      .map(
        (f) =>
          `- **[${f.reassessedSeverity.toUpperCase()} | ${f.verdict} | ${f.confidence}%]** \`${lineRefOf(f)}\` — **${f.title}**: ${f.issue}`,
      )
      .join('\n');
    more.push({
      label: `lower-confidence notes (${review.uncertainFindings.length})`,
      body: `#### Lower-confidence notes (below the posting gate)\n\n${uncertainBody}`,
    });
  }
  if (review.rejectedFindings && review.rejectedFindings.length > 0) {
    const rejectedBody = review.rejectedFindings
      .map(
        (f) =>
          `- **[${f.reassessedSeverity.toUpperCase()} | ${f.verdict} | ${f.confidence}%]** \`${lineRefOf(f)}\` — **${f.title}** — verifier: ${f.verificationEvidence}`,
      )
      .join('\n');
    more.push({
      label: `rejected (${review.rejectedFindings.length})`,
      body: `#### Rejected or below 50% confidence\n\n${rejectedBody}`,
    });
  }
  const hiddenDroppedCount = Math.max(
    0,
    review.droppedCount -
      (review.uncertainFindings?.length ?? 0) -
      (review.rejectedFindings?.length ?? 0),
  );
  if (hiddenDroppedCount > 0) {
    more.push({
      label: '',
      body: `_${hiddenDroppedCount} further candidate finding(s) are not listed: duplicates of the findings above, or lower-confidence notes beyond the five shown._`,
    });
  }
  if (more.length > 0) {
    const labels = more.map((m) => m.label).filter(Boolean);
    const summary = labels.length > 0 ? labels.join(' · ') : 'notes';
    sections.push(
      details(
        `More: ${summary.charAt(0).toUpperCase()}${summary.slice(1)}`,
        more.map((m) => m.body).join('\n\n'),
      ),
    );
  }

  // Compact footer with hidden dedup marker
  const usesCliSubscription = Object.values(review.modelsUsed).some((spec) =>
    /^(?:claude-cli|codex-cli|opencode-cli):/.test(spec),
  );
  let tokenLine = '';
  if (review.tokenUsage) {
    const tu = review.tokenUsage;
    const costLabel =
      tu.estimatedUsd !== undefined
        ? ` · ${formatUsd(tu.estimatedUsd)}${usesCliSubscription && tu.estimatedUsd > 0 ? ' (API-equiv.)' : ''}`
        : '';
    tokenLine = ` · ${tu.totalTokens.toLocaleString('en-US')} tokens${costLabel}`;
  }

  const triggerAttr =
    options.triggerCommentId !== undefined ? ` trigger_comment=${options.triggerCommentId}` : '';
  sections.push(
    `---\n` +
      `<sub>Automated AI-assisted review, **alpha**: it may miss issues or report false positives, so verify findings before acting and [open an issue](https://github.com/civico-de/civireview/issues/new) with feedback. Reviewed by [civireview](https://github.com/civico-de/civireview) · \`${preset}\`${tokenLine}</sub>\n` +
      `<!-- civireview:v1 head_sha=${review.headSha} base_sha=${review.baseSha} preset=${preset} score=${computedScore.score}/5 format=${REVIEW_FORMAT}${triggerAttr} -->`,
  );

  return {
    summaryBody: sanitizeGitHubMentions(
      fitSectionsToLimit(sections, MAX_GITHUB_BODY_CHARS, keep).join('\n\n'),
      mentionUsers,
    ),
    inlineComments,
    overflowFindings: allSummaryFindings,
  };
}
