import { z } from 'zod';

export const TargetSchema = z.object({ personName: z.string().trim().min(1).max(100), companyName: z.string().trim().max(160) }).strict();
export type Target = z.infer<typeof TargetSchema>;
export const ModeSchema = z.enum(['demo', 'live']);
export const ScenarioSchema = z.enum(['normal', 'ambiguous', 'failure', 'no_evidence']);
export type Scenario = z.infer<typeof ScenarioSchema>;
export const ResearchInputSchema = z.object({
  text: z.string().trim().min(1).max(2000),
  requestId: z.string().regex(/^[a-zA-Z0-9_-]{8,80}$/),
  subjectRevision: z.number().int().positive(),
  mode: ModeSchema.default('demo'), scenario: ScenarioSchema.default('normal'),
  selectedCandidateId: z.string().max(80).optional(),
  conversationId: z.string().uuid().optional(),
}).strict();
export type ResearchInput = z.infer<typeof ResearchInputSchema>;
export const TopicSchema = z.enum(['recent_x', 'popular_x', 'profile']);
export type CardTopic = z.infer<typeof TopicSchema>;
export const XPostSchema = z.object({
  id: z.string().regex(/^\d{1,25}$/), authorId: z.string().regex(/^\d{1,25}$/), username: z.string().regex(/^[A-Za-z0-9_]{1,15}$/),
  createdAt: z.iso.datetime(), likeCount: z.number().int().nonnegative(), repostCount: z.number().int().nonnegative(),
  replyCount: z.number().int().nonnegative(), quoteCount: z.number().int().nonnegative(), text: z.string().max(30000),
  selectionScope: z.literal('full_archive_sample').optional(),
}).strict();
export type XPost = z.infer<typeof XPostSchema>;
export const SearchHitSchema = z.object({ url: z.url().max(2048), title: z.string().max(400), snippet: z.string().max(3000).optional(), topic: TopicSchema.optional() }).strict();
export type SearchHit = z.infer<typeof SearchHitSchema>;
export const EvidenceSourceSchema = z.object({
  sourceId: z.string().min(1).max(100), url: z.url().max(2048), title: z.string().max(400),
  retrievedAt: z.iso.datetime(), text: z.string().max(40000),
  kind: z.enum(['web', 'x', 'fixture']),
  topic: TopicSchema.optional(), xPost: XPostSchema.optional(),
}).strict();
export type EvidenceSource = z.infer<typeof EvidenceSourceSchema>;
export const CandidateSchema = z.object({ id: z.string().min(1).max(80), personName: z.string().trim().min(1).max(100), companyName: z.string().trim().max(160), reason: z.string().max(400), sourceIds: z.array(z.string()).max(4) }).strict();
export type Candidate = z.infer<typeof CandidateSchema>;
export const PlanDecisionSchema = z.object({
  target: TargetSchema.nullable(), needsConfirmation: z.boolean(),
  candidates: z.array(CandidateSchema).max(5), query: z.string().max(300), reason: z.string().max(600),
  hasPersonMention: z.boolean().optional(),
}).strict();
export type PlanDecision = z.infer<typeof PlanDecisionSchema>;
const withoutOmission = (value: string) => !/[…⋯]|\.{3}|。{3}|[\r\n]/u.test(value);
const DisplayFactSchema = z.string().trim().min(1).max(28).refine(withoutOmission);
const DisplayQuestionSchema = z.string().trim().min(2).max(26).refine(withoutOmission).refine(value => /[?？]$/u.test(value));
export const ProposedCardSchema = z.object({ fact: z.string().min(1).max(200), suggestedQuestion: z.string().min(1).max(180), sourceId: z.string().max(100), excerpt: z.string().min(1).max(1000),
  displayFact: DisplayFactSchema.optional(), displayQuestion: DisplayQuestionSchema.optional(),
}).strict();

/** Display helpers never replace the complete source-backed fact. Invalid
 * helpers are omitted so existing callers can still show the original card. */
export function validatedCardDisplay(fact: string, excerpt: string, displayFact: unknown, displayQuestion: unknown): { displayFact?: string; displayQuestion?: string } {
  const shortFact = DisplayFactSchema.safeParse(displayFact);
  const question = DisplayQuestionSchema.safeParse(displayQuestion);
  // Do not turn a denial, former role or future plan into a current assertion.
  const qualified = /ない|ません|なかった|なく|未経験|未実施|予定|計画|かつて|以前|前職|過去|\b(?:not|never|no|former|previously|planned|if|unless|without)\b/iu.test(fact);
  const factValid = shortFact.success && fact.includes(shortFact.data) && excerpt.includes(shortFact.data) && (!qualified || shortFact.data === fact);
  return { ...(factValid ? { displayFact: shortFact.data } : {}), ...(question.success ? { displayQuestion: question.data } : {}) };
}
export const AssessmentSchema = z.object({
  identityVerified: z.boolean(), needsConfirmation: z.boolean(), candidates: z.array(CandidateSchema).max(5),
  publicPersonVerified: z.boolean().optional(), publicIdentitySourceIds: z.array(z.string().min(1).max(100)).max(4).optional(),
  cards: z.array(ProposedCardSchema).max(4), followUpQuery: z.string().max(300).nullable(), reason: z.string().max(600),
}).strict();
export type Assessment = z.infer<typeof AssessmentSchema>;
export const CardSchema = ProposedCardSchema.extend({ cardId: z.string(), expiresAt: z.iso.datetime(), requestId: z.string(), subjectRevision: z.number().int(), topic: TopicSchema.optional() }).strict();
export type Card = z.infer<typeof CardSchema>;
export const TraceEventSchema = z.object({ eventId: z.number().int().positive(), step: z.string().max(60), message: z.string().max(800), at: z.iso.datetime() }).strict();
export type TraceEvent = z.infer<typeof TraceEventSchema>;
export const UsageSchema = z.object({ llm: z.number().int().nonnegative(), searches: z.number().int().nonnegative(), pages: z.number().int().nonnegative(), elapsedMs: z.number().nonnegative(), reservedUsd: z.number().nonnegative(), actualUsd: z.number().nonnegative().nullable(), costKnown: z.boolean(),
  reportedUsd: z.number().finite().nonnegative().optional(), reportedCostCalls: z.number().int().nonnegative().optional(),
}).strict();
export type Usage = z.infer<typeof UsageSchema>;
export const ResearchResultSchema = z.object({
  requestId: z.string(), subjectRevision: z.number().int(), mode: ModeSchema,
  status: z.enum(['ready', 'partial', 'no_evidence', 'awaiting_confirmation', 'failed', 'cancelled']),
  target: TargetSchema.nullable(), candidates: z.array(CandidateSchema).max(5),
  cards: z.array(CardSchema).max(4), sources: z.array(EvidenceSourceSchema).max(6),
  trace: z.array(TraceEventSchema).max(60), reasonCode: z.string().max(80), message: z.string().max(800), usage: UsageSchema,
}).strict();
export type ResearchResult = z.infer<typeof ResearchResultSchema>;
export const RuntimeStatusSchema = z.object({
  streamingEnabled: z.boolean().optional(),
  liveEnabled: z.boolean(), missing: z.array(z.string()), sttEnabled: z.boolean(), xEnabled: z.boolean(),
  accessCodeRequired: z.boolean(), version: z.string(),
}).strict();
export type RuntimeStatus = z.infer<typeof RuntimeStatusSchema>;
