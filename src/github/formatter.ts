import { mapFindingsToDiff, type MappedInlineFinding } from '../engine/line-mapper.ts';
import { buildShortSummary, computeConfidenceScore } from '../engine/pipeline.ts';
import { formatUsd } from '../runners/pricing.ts';
import type {
  ConfidenceScore,
  FinalReview,
  FinalVerdict,
  VerificationStatus,
  VerifiedFinding,
} from '../engine/schemas.ts';
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
export function fitSectionsToLimit(sections: string[], max = MAX_GITHUB_BODY_CHARS): string[] {
  const out = [...sections];
  const total = () => out.join('\n\n').length;
  // The last section holds the footer and dedup marker and always stays.
  let omitted = 0;
  for (let i = out.length - 2; i >= 0 && total() > max; i--) {
    if (out[i]?.startsWith('<details>')) {
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
    out[largest] = truncateForGitHub(section, Math.max(0, section.length - (total() - max)));
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
  const lines: string[] = [
    `**${badge} ${f.title}**`,
    `_Lens: \`${f.lens}\` · Confidence: ${f.confidence}%${mapped.snapped ? ' · Line snapped to hunk' : ''}_`,
    '',
    f.issue,
    '',
    `**Failure scenario:** ${f.failureScenario}`,
    '',
    `**Verification evidence:** ${f.verificationEvidence}`,
  ];

  if (f.liveProofCommand) {
    lines.push(`**Proof command:** ${inlineCode(f.liveProofCommand)}`);
  }
  if (f.liveProofOutput) {
    lines.push('', ...fencedBlock(f.liveProofOutput.slice(0, 800), 'text'));
  }
  if (f.suggestedFix.trim()) {
    lines.push('', `**Suggested fix:** ${f.suggestedFix}`);
  }
  if (f.mcpCitations.length > 0) {
    lines.push('', `**References:** ${f.mcpCitations.join(', ')}`);
  }
  if (mapped.suggestionBlock) {
    lines.push('', mapped.suggestionBlock);
  }

  return lines.join('\n');
}

function formatSummaryFinding(f: VerifiedFinding): string {
  const badge = `[${f.reassessedSeverity.toUpperCase()} | ${f.verdict}]`;
  const loc =
    f.startLine === f.endLine
      ? `\`${f.path}:${f.endLine}\``
      : `\`${f.path}:${f.startLine}-${f.endLine}\``;
  const parts: string[] = [
    `#### ${badge} ${f.title} (${loc}, ${f.side})`,
    `- **Confidence:** ${f.confidence}% (\`${f.lens}\`)`,
    `- **Issue:** ${f.issue}`,
    `- **Failure scenario:** ${f.failureScenario}`,
    `- **Verification evidence:** ${f.verificationEvidence}`,
  ];
  if (f.suggestedFix.trim()) {
    parts.push(`- **Suggested fix:** ${f.suggestedFix}`);
  }
  if (f.mcpCitations.length > 0) {
    parts.push(`- **References:** ${f.mcpCitations.join(', ')}`);
  }
  return parts.join('\n');
}

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

  for (const f of review.findings) {
    const loc =
      f.startLine === f.endLine
        ? `\`${f.path}:${f.endLine}\``
        : `\`${f.path}:${f.startLine}-${f.endLine}\``;
    const fixHint =
      f.verdict === 'NEEDS_QUESTION'
        ? ''
        : f.suggestedFix.trim()
          ? ` — ${truncateOneLine(f.suggestedFix, 220)}`
          : '';
    items.push(
      `- [ ] **[${f.reassessedSeverity.toUpperCase()} | ${f.verdict}]** ${loc} — ${f.title}${fixHint}`,
    );
  }

  for (const row of review.verificationMatrix) {
    if (row.status === 'FAIL') {
      items.push(
        `- [ ] **[CHECK FAILED]** Resolve \`${row.check}\`: ${truncateOneLine(row.detail, 220)}`,
      );
    }
  }

  for (const rel of review.relatedItems ?? []) {
    if (rel.relationship === 'conflicts' || rel.relationship === 'duplicate') {
      const label = rel.kind === 'pr' ? `PR ${rel.ref}` : rel.ref;
      items.push(
        `- [ ] **[${rel.relationship.toUpperCase()}]** Coordinate with [${label}](${rel.url}): ${truncateOneLine(rel.reason, 220)}`,
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
      items.push(
        `- [ ] **[OPEN REVIEWER FEEDBACK]** Address ${handle}: ${tr.topic} — ${truncateOneLine(tr.detail, 220)}`,
      );
    }
  }

  return items;
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
      findings: review.findings,
      verificationMatrix: review.verificationMatrix,
      scoreRationale: computedScore.rationale,
    });

  const showImages =
    bundle.repoInfo.kind === 'civicrm-extension' ||
    bundle.abReport.imageA !== bundle.abReport.imageB;
  const imagesMeta = showImages
    ? ` · **Images:** \`${bundle.abReport.imageA}\` vs \`${bundle.abReport.imageB}\``
    : '';

  // Header + TL;DR Short Summary (scannable in 5 seconds)
  sections.push(
    `## CiviReview: ${verdictBadge(review.verdict)} · Confidence: ${scoreBadge(computedScore.score)}\n\n` +
      `_Automated AI-assisted review (**alpha** — experimental tool under active development; may miss issues or report false positives, so please verify findings before acting and [open an issue](https://github.com/civico-de/civireview/issues/new) with any feedback)._\n\n` +
      `> **Summary:** ${shortSummary}\n` +
      `>\n` +
      `> **Merge Confidence (${computedScore.score}/5):** ${computedScore.rationale}\n\n` +
      `- **PR:** \`${review.repo}#${review.prNumber}\` · **Profile:** \`${reviewProfile(bundle.repoInfo)}\` · **Kind:** \`${review.prKind}\` · **Commits:** \`${review.baseSha.slice(0, 7)}\` → \`${review.headSha.slice(0, 7)}\`${imagesMeta}`,
  );

  // Zone 1 (Top — always visible): Action Items + Summary-Only Findings + Verification Matrix + Related PRs
  const actionItems = buildActionItems(review, mentionUsers);
  if (actionItems.length > 0) {
    sections.push(`### Action Items (${actionItems.length})\n${actionItems.join('\n')}`);
  } else {
    sections.push(`### Findings\nNo verified high-signal issues found above the confidence gate.`);
  }

  // Render out-of-diff / summary-only findings right below Action Items (not buried below reference tables)
  if (allSummaryFindings.length > 0) {
    sections.push(
      `### Findings (Out-of-Diff / Summary)\n\n` +
        allSummaryFindings.map(formatSummaryFinding).join('\n\n'),
    );
  }

  // Empirical Verification Matrix (always visible, compact table)
  const matrixRows = review.verificationMatrix
    .map(
      (row) =>
        `| ${escapeTableCell(row.check)} | ${matrixStatusBadge(row.status)} | ${escapeTableCell(row.detail)} |`,
    )
    .join('\n');

  let matrixSection =
    `### Empirical Verification Matrix\n\n` +
    `| Check | Status | Detail |\n` +
    `| --- | --- | --- |\n` +
    `${matrixRows}`;

  if (review.notVerified.length > 0) {
    matrixSection +=
      `\n\n**Not Verified:**\n` + review.notVerified.map((item) => `- ${item}`).join('\n');
  }
  sections.push(matrixSection);

  // Standalone Browser A/B: only expand in Zone 1 when regressions exist; otherwise group in Zone 2 <details>
  const bd = bundle.abReport.browserDiff;
  let cleanBrowserDetailsSection: string | undefined;
  if (bd) {
    const routesList = Array.from(
      new Set([
        ...bd.probedRoutes,
        ...bd.probedAnonymousRoutes,
        ...bd.screenshots.map((s) => s.route),
      ]),
    );
    const hasBrowserRegressions =
      Boolean(bd.error) ||
      bd.new_console_errors.length > 0 ||
      bd.new_page_errors.length > 0 ||
      bd.new_network_failures.length > 0 ||
      bd.new_a11y_violations.length > 0 ||
      bd.render_regressions.length > 0;
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
    if (hasBrowserRegressions) {
      sections.push(`### Standalone Browser A/B\n\n${browserLines.join('\n')}`);
    } else {
      cleanBrowserDetailsSection = `<details>\n<summary>Standalone Browser A/B (${routesList.length} route(s), 0 regressions)</summary>\n\n${browserLines.join('\n')}\n</details>`;
    }
  }

  // Related Open PRs & Possible Unlinked GitLab Issues (only when grounded items exist)
  if (review.relatedItems && review.relatedItems.length > 0) {
    const relRows = review.relatedItems
      .map((item) => {
        const label = item.kind === 'pr' ? `PR ${item.ref}` : item.ref;
        const safeTitle = escapeTableCell(item.title);
        return `| [${escapeTableCell(label)}](${item.url}) — ${safeTitle} | ${relatedBadge(item.relationship)} | **${Math.round(item.confidence)}%** | ${escapeTableCell(item.reason)} |`;
      })
      .join('\n');
    sections.push(
      `### Related Open PRs & Issues\n\n| Item | Relation | Confidence | Why |\n| --- | --- | --- | --- |\n${relRows}`,
    );
  }

  // Zone 2 (Bottom — all reference details consistently in collapsed <details> blocks)
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
      `<details>\n<summary>Reviewer Questions & Thread Resolution (${statusSummary})</summary>\n\n| Reviewer | Question / Request | Status | Detail |\n| --- | --- | --- | --- |\n${rows}\n</details>`,
    );
  }

  if (review.walkthrough.length > 0) {
    const noteLabel = review.walkthrough.length === 1 ? 'note' : 'notes';
    sections.push(
      `<details>\n<summary>Detailed Walkthrough (${review.walkthrough.length} ${noteLabel})</summary>\n\n${review.walkthrough.map((b) => `- ${b}`).join('\n')}\n</details>`,
    );
  }

  if (review.standards && review.standards.length > 0) {
    const stdRows = review.standards
      .map(
        (s) =>
          `| \`${escapeTableCell(s.code)}\` | ${escapeTableCell(s.status)} | ${escapeTableCell(s.note)} |`,
      )
      .join('\n');
    const issueCount = review.standards.filter((s) => s.status === 'ISSUE').length;
    const statusLabel = issueCount > 0 ? `${issueCount} ISSUE` : 'all PASS/N/A';
    const stdTable = `| Code | Status | Note |\n| --- | --- | --- |\n${stdRows}`;
    sections.push(
      `<details>\n<summary>CiviCRM Core Standards (${review.standards.length} checks — ${statusLabel})</summary>\n\n${stdTable}\n</details>`,
    );
  }

  if (review.blastRadius.length > 0) {
    const blastRows = review.blastRadius
      .map(
        (b) =>
          `| ${escapeTableCell(b.repo)} | \`${escapeTableCell(b.path)}\` | \`${escapeTableCell(b.symbol)}\` | ${escapeTableCell(b.impact)} |`,
      )
      .join('\n');
    const itemLabel = review.blastRadius.length === 1 ? 'item' : 'items';
    sections.push(
      `<details>\n<summary>Ecosystem Blast Radius (${review.blastRadius.length} ${itemLabel})</summary>\n\n| Repo | Path | Symbol | Impact |\n| --- | --- | --- | --- |\n${blastRows}\n</details>`,
    );
  }

  if (cleanBrowserDetailsSection) {
    sections.push(cleanBrowserDetailsSection);
  }

  if (review.uncertainFindings && review.uncertainFindings.length > 0) {
    const uncertainBody = review.uncertainFindings
      .map(
        (f) =>
          `- **[${f.reassessedSeverity.toUpperCase()} | ${f.verdict} | ${f.confidence}%]** \`${lineRefOf(f)}\` — **${f.title}**: ${f.issue}`,
      )
      .join('\n');
    sections.push(
      `<details>\n<summary>Lower-Confidence Notes (${review.uncertainFindings.length} — below posting gate, for optional review)</summary>\n\n${uncertainBody}\n</details>`,
    );
  }

  if (review.rejectedFindings && review.rejectedFindings.length > 0) {
    const rejectedBody = review.rejectedFindings
      .map(
        (f) =>
          `- **[${f.reassessedSeverity.toUpperCase()} | ${f.verdict} | ${f.confidence}%]** \`${lineRefOf(f)}\` — **${f.title}** — verifier: ${f.verificationEvidence}`,
      )
      .join('\n');
    sections.push(
      `<details>\n<summary>Rejected or below 50% confidence (${review.rejectedFindings.length})</summary>\n\n${rejectedBody}\n</details>`,
    );
  }

  const hiddenDroppedCount = Math.max(
    0,
    review.droppedCount -
      (review.uncertainFindings?.length ?? 0) -
      (review.rejectedFindings?.length ?? 0),
  );
  if (hiddenDroppedCount > 0) {
    sections.push(
      `_Note: ${hiddenDroppedCount} further candidate finding(s) are not listed: duplicates of the findings above, or lower-confidence notes beyond the five shown._`,
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
      `<sub>Reviewed by [civireview](https://github.com/civico-de/civireview) · \`${preset}\`${tokenLine}</sub>\n` +
      `<!-- civireview:v1 head_sha=${review.headSha} base_sha=${review.baseSha} preset=${preset} score=${computedScore.score}/5${triggerAttr} -->`,
  );

  return {
    summaryBody: sanitizeGitHubMentions(fitSectionsToLimit(sections).join('\n\n'), mentionUsers),
    inlineComments,
    overflowFindings: allSummaryFindings,
  };
}
