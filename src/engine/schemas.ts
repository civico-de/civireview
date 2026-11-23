import { z } from 'zod';
import { ModelSpecSchema } from '../config/schema.ts';

export const SeveritySchema = z.enum(['critical', 'high', 'medium', 'low']);
export type Severity = z.infer<typeof SeveritySchema>;

export const EvidenceLevelSchema = z.enum(['PROVEN', 'CONFIRMED', 'NEEDS_QUESTION']);
export type EvidenceLevel = z.infer<typeof EvidenceLevelSchema>;

export const SpecialistLensSchema = z.enum(['correctness', 'security', 'tests', 'ui']);
export type SpecialistLens = z.infer<typeof SpecialistLensSchema>;

export const StandardVerdictSchema = z.object({
  code: z.string().min(1),
  status: z.enum(['PASS', 'ISSUE', 'N/A']),
  note: z.string(),
});
export type StandardVerdict = z.infer<typeof StandardVerdictSchema>;

export const CandidateFindingSchema = z.object({
  id: z.string().min(1),
  lens: SpecialistLensSchema,
  title: z.string().min(1),
  severity: SeveritySchema,
  path: z.string().min(1),
  startLine: z.number().int().positive(),
  endLine: z.number().int().positive(),
  side: z.enum(['RIGHT', 'LEFT']),
  issue: z.string().min(1),
  failureScenario: z.string().min(1),
  evidence: z.string().min(1),
  suggestedFix: z.string(),
  suggestionCode: z.string().optional(),
  mcpCitations: z.array(z.string()),
});
export type CandidateFinding = z.infer<typeof CandidateFindingSchema>;

export const PrKindSchema = z.enum([
  'core-bugfix',
  'core-feature',
  'core-ref-nfc',
  'extension-pr',
  'security-sensitive',
  'ui-change',
  'docs-only',
]);
export type PrKind = z.infer<typeof PrKindSchema>;

export const RelatedItemSchema = z.object({
  kind: z.enum(['pr', 'gitlab-issue']),
  ref: z.string().min(1),
  title: z.string().min(1),
  url: z.string().min(1),
  relationship: z.enum(['duplicate', 'conflicts', 'related']),
  confidence: z.number().min(0).max(100),
  reason: z.string().min(1),
});
export type RelatedItem = z.infer<typeof RelatedItemSchema>;

export const TriageOutputSchema = z.object({
  prKind: PrKindSchema,
  riskLevel: z.enum(['low', 'medium', 'high']),
  activeLenses: z.array(SpecialistLensSchema),
  shortSummary: z.string().min(1).max(400).optional(),
  summaryBullets: z.array(z.string()),
  recommendedAbTests: z.array(z.string()),
  relatedItems: z.array(RelatedItemSchema).max(6).optional(),
  skipReason: z.string().optional(),
});
export type TriageOutput = z.infer<typeof TriageOutputSchema>;

export const BlastRadiusItemSchema = z.object({
  repo: z.string(),
  path: z.string(),
  symbol: z.string(),
  impact: z.string(),
});
export type BlastRadiusItem = z.infer<typeof BlastRadiusItemSchema>;

export const SpecialistOutputSchema = z.object({
  lens: SpecialistLensSchema,
  summary: z.string(),
  findings: z.array(CandidateFindingSchema),
  standards: z.array(StandardVerdictSchema).optional(),
  blastRadius: z.array(BlastRadiusItemSchema).optional(),
  checkedWithoutFindings: z.array(z.string()),
});
export type SpecialistOutput = z.infer<typeof SpecialistOutputSchema>;

export const FindingVerdictSchema = z.enum(['PROVEN', 'CONFIRMED', 'NEEDS_QUESTION', 'REJECTED']);
export type FindingVerdict = z.infer<typeof FindingVerdictSchema>;

export const VerifiedFindingSchema = CandidateFindingSchema.extend({
  verdict: FindingVerdictSchema,
  reassessedSeverity: SeveritySchema,
  confidence: z.number().min(0).max(100),
  verificationEvidence: z.string().min(1),
  liveProofCommand: z.string().optional(),
  liveProofOutput: z.string().optional(),
});
export type VerifiedFinding = z.infer<typeof VerifiedFindingSchema>;

export const FollowUpLeadSchema = z.object({
  lens: SpecialistLensSchema,
  question: z.string().min(1),
  targetPaths: z.array(z.string()).default([]),
  reason: z.string().min(1),
});
export type FollowUpLead = z.infer<typeof FollowUpLeadSchema>;

export const VerifierOutputSchema = z.object({
  verifiedFindings: z.array(VerifiedFindingSchema),
  reconciledStandards: z.array(StandardVerdictSchema).optional(),
  followUpLeads: z.array(FollowUpLeadSchema).max(3).default([]),
  notes: z.string(),
});
export type VerifierOutput = z.infer<typeof VerifierOutputSchema>;

export const VerificationStatusSchema = z.enum(['PASS', 'FAIL', 'WARN', 'SKIPPED', 'NOT_VERIFIED']);
export type VerificationStatus = z.infer<typeof VerificationStatusSchema>;

export const VerificationMatrixEntrySchema = z.object({
  check: z.string().min(1),
  status: VerificationStatusSchema,
  detail: z.string(),
});
export type VerificationMatrixEntry = z.infer<typeof VerificationMatrixEntrySchema>;

export const StageTokenUsageSchema = z.object({
  stage: z.string().min(1),
  model: ModelSpecSchema,
  inputTokens: z.number().nonnegative(),
  outputTokens: z.number().nonnegative(),
  cachedInputTokens: z.number().nonnegative().optional(),
  cacheWriteInputTokens: z.number().nonnegative().optional(),
  totalTokens: z.number().nonnegative(),
  estimatedUsd: z.number().nonnegative().optional(),
});
export type StageTokenUsage = z.infer<typeof StageTokenUsageSchema>;

export const TokenUsageTotalsSchema = z.object({
  inputTokens: z.number().nonnegative(),
  outputTokens: z.number().nonnegative(),
  cachedInputTokens: z.number().nonnegative().optional(),
  cacheWriteInputTokens: z.number().nonnegative().optional(),
  totalTokens: z.number().nonnegative(),
  estimatedUsd: z.number().nonnegative().optional(),
  byStage: z.array(StageTokenUsageSchema).optional(),
});
export type TokenUsageTotals = z.infer<typeof TokenUsageTotalsSchema>;

export const FinalVerdictSchema = z.enum(['READY', 'NEEDS_CHANGES', 'QUESTIONS_ONLY']);
export type FinalVerdict = z.infer<typeof FinalVerdictSchema>;

export const ConfidenceScoreSchema = z.union([
  z.literal(1),
  z.literal(2),
  z.literal(3),
  z.literal(4),
  z.literal(5),
]);
export type ConfidenceScore = z.infer<typeof ConfidenceScoreSchema>;

export const FinalReviewSchema = z.object({
  schemaVersion: z.literal('1'),
  repo: z.string().min(1),
  prNumber: z.number().int().nonnegative(),
  baseSha: z.string().min(1),
  headSha: z.string().min(1),
  prKind: PrKindSchema,
  verdict: FinalVerdictSchema,
  score: ConfidenceScoreSchema.optional(),
  scoreRationale: z.string().optional(),
  shortSummary: z.string().optional(),
  walkthrough: z.array(z.string()),
  verificationMatrix: z.array(VerificationMatrixEntrySchema),
  notVerified: z.array(z.string()),
  standards: z.array(StandardVerdictSchema).optional(),
  blastRadius: z.array(BlastRadiusItemSchema),
  relatedItems: z.array(RelatedItemSchema).optional(),
  findings: z.array(VerifiedFindingSchema),
  droppedCount: z.number().int().nonnegative(),
  modelsUsed: z.record(z.string(), ModelSpecSchema),
  tokenUsage: TokenUsageTotalsSchema.optional(),
  generatedAt: z.string(),
});
export type FinalReview = z.infer<typeof FinalReviewSchema>;

export const ThreadReplyOutputSchema = z.object({
  reply: z.string().min(1),
  resolved: z.boolean(),
  references: z.array(z.string()),
});
export type ThreadReplyOutput = z.infer<typeof ThreadReplyOutputSchema>;
