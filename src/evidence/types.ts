import { z } from 'zod';

export const RepoKindSchema = z.enum(['civicrm-core', 'civicrm-extension', 'generic']);
export type RepoKind = z.infer<typeof RepoKindSchema>;

export const FileSurfaceFlagsSchema = z.object({
  isComposer: z.boolean(),
  isSchema: z.boolean(),
  isUpgrade: z.boolean(),
  isManaged: z.boolean(),
  isSmartyTemplate: z.boolean(),
  isAfform: z.boolean(),
  isFrontendAsset: z.boolean(),
  isTest: z.boolean(),
  isMenuXml: z.boolean(),
  isApiV4: z.boolean(),
  isDocsOnly: z.boolean(),
});
export type FileSurfaceFlags = z.infer<typeof FileSurfaceFlagsSchema>;

export const DiffHunkSchema = z.object({
  header: z.string(),
  oldStart: z.number().int().nonnegative(),
  oldCount: z.number().int().nonnegative(),
  newStart: z.number().int().nonnegative(),
  newCount: z.number().int().nonnegative(),
  lines: z.array(z.string()),
});
export type DiffHunk = z.infer<typeof DiffHunkSchema>;

export const DiffFileStatusSchema = z.enum(['added', 'modified', 'deleted', 'renamed']);
export type DiffFileStatus = z.infer<typeof DiffFileStatusSchema>;

export const DiffFileSchema = z.object({
  path: z.string(),
  oldPath: z.string().optional(),
  status: DiffFileStatusSchema,
  isBinary: z.boolean(),
  additions: z.number().int().nonnegative(),
  deletions: z.number().int().nonnegative(),
  hunks: z.array(DiffHunkSchema),
  validRightLines: z.array(z.number().int().positive()),
  validLeftLines: z.array(z.number().int().positive()),
  flags: FileSurfaceFlagsSchema,
  rawPatch: z.string(),
});
export type DiffFile = z.infer<typeof DiffFileSchema>;

export const SurfaceChangeSchema = z.object({
  kind: z.enum([
    'menu-route',
    'apiv4-entity',
    'apiv4-action',
    'permission-check',
    'hook',
    'schema',
    'upgrade',
    'managed',
    'composer',
    'template',
  ]),
  change: z.enum(['added', 'modified', 'removed']),
  path: z.string(),
  detail: z.string(),
});
export type SurfaceChange = z.infer<typeof SurfaceChangeSchema>;

export const SurfaceDiffCategorySchema = z.object({
  added: z.array(z.record(z.string(), z.unknown())),
  removed: z.array(z.record(z.string(), z.unknown())),
  changed: z.array(z.record(z.string(), z.unknown())),
});
export type SurfaceDiffCategory = z.infer<typeof SurfaceDiffCategorySchema>;

export const LiveSurfaceRiskFlagSchema = z.object({
  code: z.string(),
  severity: z.string(),
  category: z.string(),
  target: z.string(),
  reason: z.string(),
});
export type LiveSurfaceRiskFlag = z.infer<typeof LiveSurfaceRiskFlagSchema>;

export const LiveSurfaceDiffSchema = z.object({
  api4: SurfaceDiffCategorySchema.optional(),
  api3: SurfaceDiffCategorySchema.optional(),
  routes: SurfaceDiffCategorySchema.optional(),
  afform: SurfaceDiffCategorySchema.optional(),
  risk_flags: z.array(LiveSurfaceRiskFlagSchema).default([]),
  counts: z.record(z.string(), z.unknown()).optional(),
  error: z.string().optional(),
});
export type LiveSurfaceDiff = z.infer<typeof LiveSurfaceDiffSchema>;

export const SurfaceDiffReportSchema = z.object({
  changes: z.array(SurfaceChangeSchema),
  unverifiedSurfaces: z.array(z.string()),
  touchedComponents: z.array(z.string()),
  summary: z.string(),
  liveSurfaceDiff: LiveSurfaceDiffSchema.optional(),
});
export type SurfaceDiffReport = z.infer<typeof SurfaceDiffReportSchema>;

export const AbComparisonItemSchema = z.object({
  testName: z.string(),
  outcome: z.enum(['fixed', 'regression', 'both_fail', 'gone', 'both_pass']),
});
export type AbComparisonItem = z.infer<typeof AbComparisonItemSchema>;

export const TautologicalTestSchema = z.object({
  file: z.string(),
  method: z.string(),
  line: z.number().int().positive(),
  testCaseName: z.string(),
});
export type TautologicalTest = z.infer<typeof TautologicalTestSchema>;

export const AbCheckResultSchema = z.object({
  name: z.string(),
  command: z.string(),
  imageA: z.string(),
  imageB: z.string(),
  status: z.enum(['PASS', 'FAIL', 'ERROR', 'SKIPPED']),
  mode: z.enum(['junit', 'exit-status']).optional(),
  exitCodeA: z.number().int().optional(),
  exitCodeB: z.number().int().optional(),
  fixed: z.array(z.string()),
  regressions: z.array(z.string()),
  bothFail: z.array(z.string()),
  gone: z.array(z.string()),
  onlyOnB: z.array(z.string()).optional(),
  passedBoth: z.array(z.string()).default([]),
  tautologicalTests: z.array(TautologicalTestSchema).default([]),
  addedTestMethods: z
    .array(
      z.object({
        file: z.string(),
        method: z.string(),
        line: z.number().int().positive(),
      }),
    )
    .default([]),
  counts: z.record(z.string(), z.number()).optional(),
  summary: z.string(),
  outputSnippet: z.string().optional(),
});
export type AbCheckResult = z.infer<typeof AbCheckResultSchema>;

export const BrowserDiffScreenshotSchema = z.object({
  route: z.string(),
  mode: z.string().default('authenticated'),
  before: z.string().nullish(),
  after: z.string().nullish(),
});
export type BrowserDiffScreenshot = z.infer<typeof BrowserDiffScreenshotSchema>;

export const BrowserDiffReportSchema = z.object({
  new_console_errors: z.array(z.unknown()).default([]),
  new_page_errors: z.array(z.unknown()).default([]),
  new_network_failures: z.array(z.unknown()).default([]),
  new_a11y_violations: z.array(z.unknown()).default([]),
  render_regressions: z.array(z.unknown()).default([]),
  screenshots: z.array(BrowserDiffScreenshotSchema).default([]),
  risk_flags: z.array(z.record(z.string(), z.unknown())).default([]),
  counts: z.record(z.string(), z.unknown()).optional(),
  error: z.string().optional(),
  urls: z
    .object({
      A: z.string().optional(),
      B: z.string().optional(),
    })
    .optional(),
  probedRoutes: z.array(z.string()).default([]),
  probedAnonymousRoutes: z.array(z.string()).default([]),
  // True when only the dashboard fallback was probed, not a route of the changed UI.
  smokeOnly: z.boolean().optional(),
});
export type BrowserDiffReport = z.infer<typeof BrowserDiffReportSchema>;

export const AbRunReportSchema = z.object({
  executed: z.boolean(),
  ckCommand: z.string().optional(),
  imageA: z.string(),
  imageB: z.string(),
  checks: z.array(AbCheckResultSchema),
  surfaceDiff: SurfaceDiffReportSchema,
  browserDiff: BrowserDiffReportSchema.optional(),
  demoArtifactsDir: z.string().optional(),
  demoConsoleErrors: z.array(z.string()).default([]),
  notVerified: z.array(z.string()),
  /** Set when A/B ran on GitHub's merge of the PR: A is its first parent, B the merge. */
  testedMerge: z.object({ base: z.string(), merge: z.string() }).optional(),
});
export type AbRunReport = z.infer<typeof AbRunReportSchema>;

export const StaticDeltaFindingSchema = z.object({
  tool: z.string(),
  severity: z.enum(['error', 'warning', 'info']),
  path: z.string().optional(),
  line: z.number().int().positive().optional(),
  message: z.string(),
  isNewOnHead: z.boolean(),
});
export type StaticDeltaFinding = z.infer<typeof StaticDeltaFindingSchema>;

export const StaticDeltaReportSchema = z.object({
  executed: z.boolean(),
  toolsRun: z.array(z.string()),
  findings: z.array(StaticDeltaFindingSchema),
  summary: z.string(),
});
export type StaticDeltaReport = z.infer<typeof StaticDeltaReportSchema>;

export const CiCheckItemSchema = z.object({
  name: z.string(),
  state: z.enum(['success', 'failure', 'pending', 'error', 'unknown']),
  targetUrl: z.string().optional(),
  description: z.string().optional(),
  failedTests: z.array(z.string()).optional(),
});
export type CiCheckItem = z.infer<typeof CiCheckItemSchema>;

export const CiStatusReportSchema = z.object({
  overallState: z.enum(['success', 'failure', 'pending', 'unknown']),
  checks: z.array(CiCheckItemSchema),
  jenkinsBatchUrl: z.string().optional(),
  jenkinsFailedTests: z.array(z.string()),
  jenkinsFailureDetails: z.array(z.string()).optional(),
  summary: z.string(),
});
export type CiStatusReport = z.infer<typeof CiStatusReportSchema>;

export const PrMetadataSchema = z.object({
  repo: z.string(),
  isPrivateRepo: z.boolean(),
  prNumber: z.number().int().nonnegative(),
  title: z.string(),
  body: z.string(),
  author: z.string(),
  baseBranch: z.string(),
  headBranch: z.string(),
  baseSha: z.string(),
  headSha: z.string(),
  lastReviewedHeadSha: z.string().optional(),
  labels: z.array(z.string()),
  draft: z.boolean(),
  state: z.string().optional(),
  merged: z.boolean().optional(),
  url: z.string().optional(),
});
export type PrMetadata = z.infer<typeof PrMetadataSchema>;

export const PrCommentSchema = z.object({
  id: z.union([z.number(), z.string()]),
  author: z.string(),
  kind: z.enum(['issue_comment', 'review_comment', 'review']),
  body: z.string(),
  path: z.string().optional(),
  line: z.number().int().optional(),
  inReplyToId: z.number().int().optional(),
  createdAt: z.string(),
});
export type PrComment = z.infer<typeof PrCommentSchema>;

export const LinkedIssueCommentSchema = z.object({
  author: z.string(),
  body: z.string(),
  createdAt: z.string().optional(),
});
export type LinkedIssueComment = z.infer<typeof LinkedIssueCommentSchema>;

export const LinkedIssueSchema = z.object({
  number: z.number().int().positive(),
  repo: z.string(),
  source: z.enum(['github', 'gitlab']).optional(),
  title: z.string(),
  body: z.string(),
  state: z.string(),
  url: z.string(),
  labels: z.array(z.string()).optional(),
  comments: z.array(LinkedIssueCommentSchema).optional(),
});
export type LinkedIssue = z.infer<typeof LinkedIssueSchema>;

export const RepoInfoSchema = z.object({
  kind: RepoKindSchema,
  root: z.string(),
  civicrmVersion: z.string().optional(),
  extensionKey: z.string().optional(),
  extensionName: z.string().optional(),
  civicrmFloor: z.string().optional(),
  // civicrm-core only: repo-relative roots of the bundled extensions the diff touches.
  bundledExtensions: z.array(z.string()).optional(),
  recommendedImage: z.string(),
});
export type RepoInfo = z.infer<typeof RepoInfoSchema>;

export const CandidateRelatedPrSchema = z.object({
  number: z.number().int().positive(),
  title: z.string(),
  author: z.string(),
  baseBranch: z.string().optional(),
  url: z.string(),
  overlappingFiles: z.array(z.string()).default([]),
  sharedIssueRefs: z.array(z.string()).default([]),
  draft: z.boolean().optional(),
  mergeConflict: z.enum(['conflicts', 'clean']).optional(),
  conflictingFiles: z.array(z.string()).optional(),
});
export type CandidateRelatedPr = z.infer<typeof CandidateRelatedPrSchema>;

export const CandidateRelatedIssueSchema = z.object({
  ref: z.string().min(1),
  title: z.string(),
  state: z.string(),
  url: z.string(),
  labels: z.array(z.string()).default([]),
  snippet: z.string().default(''),
});
export type CandidateRelatedIssue = z.infer<typeof CandidateRelatedIssueSchema>;

export const EvidenceBundleSchema = z.object({
  schemaVersion: z.literal('1'),
  collectedAt: z.string(),
  repoInfo: RepoInfoSchema,
  pr: PrMetadataSchema,
  comments: z.array(PrCommentSchema),
  linkedIssues: z.array(LinkedIssueSchema),
  candidateRelatedPrs: z.array(CandidateRelatedPrSchema).optional(),
  candidateRelatedIssues: z.array(CandidateRelatedIssueSchema).optional(),
  diffFiles: z.array(DiffFileSchema),
  droppedNoiseFiles: z.array(z.string()),
  diffTruncated: z.boolean(),
  abReport: AbRunReportSchema,
  staticDelta: StaticDeltaReportSchema,
  ciStatus: CiStatusReportSchema,
  notVerified: z.array(z.string()),
});
export type EvidenceBundle = z.infer<typeof EvidenceBundleSchema>;
