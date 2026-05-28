export const DEMO_SCHEMA_VERSION = "demo.v1" as const;
export const DEMO_PERSONA_BOUNDARY_NOTICE =
  "这个分身基于作者公开内容生成，只能作为阅读辅助，不代表作者本人实时回应。";
export const PERSONA_CHAT_FALLBACK_BOUNDARY_NOTICE =
  "当前回复基于有限公开内容生成，只能作为阅读辅助，不代表作者本人实时回应。";

export type DemoSchemaVersion = typeof DEMO_SCHEMA_VERSION;
export type DemoDataMode = "mock" | "cache_first" | "replay" | "real";
export type DemoPersonaChatMode = "off" | "mock" | "real";
export type DemoExperienceSummarySource = "llm" | "fallback" | "none";
export type DemoExperienceSummaryStatus = "ready" | "pending" | "failed";
export type DemoDisplayTier = "core" | "supplement";
export type DemoEvidenceStatus = "llm_extracted" | "raw_snippet_only";
export type DemoSearchQueryType =
  | "original"
  | "real_experience"
  | "life_path"
  | "failure_review"
  | "decision_conflict"
  | "alternative_solution";
export type DemoRoughTier = "strong" | "usable" | "backup" | "drop";
export type DemoContentRole =
  | "real_experience"
  | "life_path"
  | "failure_review"
  | "decision_conflict"
  | "alternative_solution"
  | "viewpoint";
export type DemoDebugFallbackKind =
  | ""
  | "no_llm_config"
  | "partial_llm_fallback"
  | "all_llm_failed";
export type DemoDebugPathSource = "llm" | "rule" | "fallback";
export type DemoObjectiveSlotName =
  | "age"
  | "industry"
  | "companyType"
  | "role"
  | "city"
  | "status"
  | "direction"
  | "constraint";

export type DemoObjectiveSlots = Record<DemoObjectiveSlotName, string | null>;

export interface DemoObjectiveQueryPlan {
  primary: string[];
  secondary: string[];
  fallback: string[];
}

export interface DemoSearchRequestBody {
  query?: unknown;
  count?: unknown;
  mode?: unknown;
  dataMode?: unknown;
  clarificationAnswers?: unknown;
  allowMockFallback?: unknown;
}

export interface DemoClarificationAnswers {
  [key: string]: string;
}

export type DemoClarificationAmbiguityLevel = "low" | "medium" | "high";
export type DemoClarificationQuestionType = "single_select" | "multi_select" | "free_text";

export interface DemoClarifyingCard {
  show: boolean;
  title: string;
  description: string;
  questions: DemoClarificationQuestion[];
  primaryActionText: string;
  skipActionText: string;
}

export interface DemoClarificationQuestion {
  id: string;
  slot?: string;
  selectedReason?: string;
  queryTokens?: string[];
  score?: number;
  label: string;
  question?: string;
  type: DemoClarificationQuestionType;
  required: boolean;
  options?: DemoClarificationOption[];
}

export interface DemoClarificationOption {
  id: string;
  label: string;
  queryTokens?: string[];
}

export interface DemoClarificationStage {
  needClarification: boolean;
  ambiguityLevel: DemoClarificationAmbiguityLevel;
  llmUsed: boolean;
  fallbackReason?: string;
}

export interface DemoIntentSearchPlanResponse {
  intent: string;
  intentSummary: string;
  focusTags: string[];
  searchPlan: DemoIntentSearchPlan;
  contextUsed?: DemoContextUsed;
  debug: DemoIntentSearchPlanDebug;
}

export interface DemoIntentSearchPlan {
  coreQueries: string[];
  expandedQueries: string[];
  exploratoryQueries: string[];
  rankingSignals: string[];
  negativeHints: string[];
  expectedEvidenceTypes: string[];
}

export interface DemoIntentSearchPlanDebug {
  stage: "intent_expand";
  llmUsed: boolean;
  provider: string;
  model: string;
  fallbackReason?: string;
  clarificationAnswerKeys: string[];
  latencyMs: number;
  objectiveSlots?: DemoObjectiveSlots;
  missingSlots?: DemoObjectiveSlotName[];
  queryPlan?: DemoObjectiveQueryPlan;
  notes: string[];
}

export interface DemoSearchResponse {
  schemaVersion: DemoSchemaVersion;
  queryId: string;
  query: string;
  dataMode: DemoDataMode;
  contextUsed?: DemoContextUsed;
  features: DemoFeatures;
  analysis: DemoAnalysis;
  feedItems?: DemoFeedItem[];
  paths: DemoPath[];
  people: DemoPerson[];
  personas?: DemoPersona[];
  sections?: DemoSection[];
  meta: DemoMeta;
  debug: DemoDebug;
  clarifyingCard?: DemoClarifyingCard;
  clarificationStage?: DemoClarificationStage;
}

export interface DemoFeatures {
  aiPersona: boolean;
  personaChat: DemoPersonaChatMode;
  saveSample: boolean;
  articleBody: boolean;
  sourceEvidenceRequired: true;
}

export interface DemoContextUsed {
  provider: "zhihu";
  loggedIn: boolean;
  zhihuProfileUsed: boolean;
  profileSignals: string[];
  usedFor: Array<"intent_expand" | "search_query_expand" | "fit_reason">;
}

export interface DemoAnalysis {
  summary: string;
  intent: string;
  focusTags: string[];
  steps: DemoAnalysisStep[];
}

export interface DemoAnalysisStep {
  id: string;
  label: string;
  status: "done" | "pending";
  evidenceIds: string[];
  sourceRefs: string[];
}

export interface DemoPath {
  id: string;
  title: string;
  summary: string;
  whyRelevant?: string;
  tradeoff?: string;
  displayLabel?: string;
  displayTradeoff?: string;
  fitReason?: string;
  diversityKey?: string;
  contentRole?: DemoContentRole;
  stance: "experience" | "viewpoint" | "mixed";
  personRefs?: string[];
  evidenceIds: string[];
  sourceRefs: string[];
}

export interface DemoFeedSummaryPayload {
  whatHappened: string;
  keyChoiceOrChange: string;
  referenceValue: string;
  markdown: string;
}

export interface DemoFeedItem {
  id: string;
  personId: string;
  authorName: string;
  authorAvatar: string;
  sourceTitle: string;
  sourcePlatform: string;
  sourceUrl: string;
  directionLabel: string;
  snippet: string;
  summaryText: string | null;
  summaryPayload: DemoFeedSummaryPayload;
  sampleType: "experience_sample";
  evidenceIds: string[];
  sourceRefs: string[];
  saveSampleId: string;
}

export interface DemoPerson {
  id: string;
  name: string;
  sampleType?: "experience_sample" | "viewpoint_author" | "content_sample";
  pathId: string;
  role: string;
  roleLabel?: string;
  badge: string;
  displayTier?: DemoDisplayTier;
  evidenceStatus?: DemoEvidenceStatus;
  canChat?: boolean;
  displayLabel?: string;
  displayTradeoff?: string;
  directionLabel?: string;
  sourceTitle?: string;
  sourcePlatform?: string;
  sourceUrl?: string;
  snippet?: string;
  summaryText?: string | null;
  summaryPayload?: DemoFeedSummaryPayload;
  saveSampleId?: string;
  avatar: string;
  oneLine: string;
  experienceSummary: string | null;
  experienceSummarySource: DemoExperienceSummarySource;
  experienceSummaryStatus: DemoExperienceSummaryStatus;
  experienceSummaryConfidence?: number;
  matchedPathTitle?: string;
  relevanceReason?: string;
  fitReason?: string;
  who: string;
  overlaps: string[];
  timeline: DemoTimelineEvent[];
  lesson: string;
  articles: DemoArticle[];
  match: DemoMatch;
  aiPersona: DemoPersonPersona;
  evidenceIds: string[];
  sourceRefs: string[];
}

export interface DemoTimelineEvent {
  date: string;
  event: string;
  evidenceIds: string[];
  sourceRefs: string[];
}

export interface DemoArticle {
  id: string;
  title: string;
  text: string;
  url: string;
  author: string;
  avatar: string;
  sourceName: string;
  sourceUrl: string;
  summary: string;
  evidenceStatus?: DemoEvidenceStatus;
  evidenceText?: string;
  evidence: DemoEvidence[];
  body: DemoBlock[];
  sourceRefs: string[];
}

export interface DemoEvidence {
  id: string;
  label: string;
  text: string;
  sourceRefId: string;
  sourceUrl: string;
}

export interface DemoBlock {
  type: "paragraph" | "evidence";
  text: string;
  evidenceIds: string[];
  sourceRefs: string[];
}

export interface DemoMatch {
  score: number;
  level: "low" | "medium" | "high";
  reasons: string[];
  matchedVariables: string[];
  riskNotes: string[];
  contentRelevance: number;
  experienceSimilarity: number;
  evidenceQuality: number;
  personaReadiness: number;
  evidenceIds: string[];
  sourceRefs: string[];
}

export interface DemoPersonPersona {
  enabled: boolean;
  canChat?: boolean;
  evidenceStatus?: DemoEvidenceStatus;
  displayLabel?: string;
  displayTradeoff?: string;
  personaId: string;
  displayName: string;
  label: string;
  openingLine: string;
  suggestedQuestions: string[];
  boundary: string;
  grounding: {
    personId: string;
    articleIds: string[];
    evidenceRequired: true;
    sourceRefs: string[];
  };
}

export interface DemoPersona {
  id: string;
  personId: string;
  displayName: string;
  avatar: string;
  personaType: "experience_echo";
  canChat?: boolean;
  displayTier?: DemoDisplayTier;
  evidenceStatus?: DemoEvidenceStatus;
  displayLabel?: string;
  displayTradeoff?: string;
  intro: string;
  fitReason?: string;
  boundaryNotice: string;
  sourceRefs: string[];
  suggestedQuestions: string[];
}

export interface DemoSection {
  id: string;
  type: "analysis" | "paths" | "people" | "personas";
  title: string;
  itemRefs: string[];
}

export interface DemoSourceRef {
  id: string;
  provider: "zhihu" | "mock";
  type: "zhihu_answer" | "mock_answer";
  title: string;
  url: string;
  author: string;
  evidenceIds: string[];
}

export interface DemoMeta {
  sourceRefs: DemoSourceRef[];
  evidenceCount: number;
  generatedAt: string;
  latencyMs: number;
  totalDurationMs?: number;
  fallbackUsed: boolean;
  fallbackStages?: string[];
  llmStages?: DemoLlmStageMeta[];
  timedOutStages?: string[];
  experienceSummary?: DemoExperienceSummaryMeta;
}

export interface DemoLlmStageMeta {
  taskType: DemoDebugTiming["stageName"] | string;
  provider?: string;
  model?: string;
  status: "success" | "fallback" | "timeout" | "skipped";
  durationMs: number;
  fallbackReason: string;
}

export interface DemoExperienceSummaryMeta {
  status: "succeeded" | "degraded" | "timed_out";
  llmGenerated: boolean;
  provider?: string;
  model?: string;
  inputCandidateCount: number;
  promptCandidateCount: number;
  acceptedSummaryCount: number;
  fallbackReason?: string;
}

export interface DemoSearchQueryPlan {
  query: string;
  type: DemoSearchQueryType;
  purpose: string;
  priority: number;
}

export interface DemoSearchQueryResultDebug extends DemoSearchQueryPlan {
  returnedCount: number;
  roundIndex?: number;
  success?: boolean;
  rawResultCount?: number;
  errorCode?: string;
  errorMessage?: string;
  error?: string;
  isEmptyResult?: boolean;
}

export interface DemoSearchRoundDebug {
  query: string;
  roundIndex: number;
  success: boolean;
  rawResultCount: number;
  errorCode?: string;
  errorMessage?: string;
  isEmptyResult?: boolean;
}

export interface DemoSearchCandidate {
  sourceId: string;
  title: string;
  url: string;
  authorName?: string;
  snippet?: string;
  excerpt?: string;
  rawContent?: string;
  text?: string;
  sourceType?: string;
  queryUsed: string;
  searchRound: number;
  rawPayload?: unknown;
}

export interface DemoSearchDebug {
  dataMode: string;
  queriesUsed: string[];
  searchRounds: DemoSearchRoundDebug[];
  totalRawResults: number;
  totalDedupedCandidates: number;
  failedQueries: string[];
  emptyQueries: string[];
  degraded: boolean;
  fallbackReason?: string;
  candidates?: DemoSearchCandidate[];
}

export interface DemoDebug {
  composer: "mock" | "real_rule_composer" | "real_llm_composer";
  originalQuery: string;
  normalizedQuery: string;
  requestedDataMode: DemoDataMode;
  resolvedDataMode: DemoDataMode;
  cacheHit: boolean;
  cacheKeyPreview: string;
  itemCount: number;
  sourceItemCount?: number;
  pathCount?: number;
  peopleCount?: number;
  personaCount?: number;
  llmUsed?: boolean;
  fallbackUsed: boolean;
  llmComposerUsed: boolean;
  llmRepairUsed?: boolean;
  llmRepairFailed?: boolean;
  llmStageResults?: DemoDebugLlmStageResult[];
  llmArtifactSources?: Record<DemoLlmArtifactSourceStage, DemoLlmArtifactSource>;
  timings?: DemoDebugTiming[];
  enhancedPeopleCount?: number;
  enhancedPathCount?: number;
  partialFallbackUsed?: boolean;
  pathSource: DemoDebugPathSource;
  composerFallbackTriggered?: boolean;
  pathDuplicateFound?: boolean;
  pathDiversityCheck?: DemoPathDiversityCheck;
  intentStage: DemoDebugIntentStage;
  fallbackKind: DemoDebugFallbackKind;
  fallbackReason: string;
  guardWarnings: string[];
  userCoreQuestion?: string;
  topicSignals?: string[];
  searchQueries?: DemoSearchQueryPlan[];
  searchQueryResults?: DemoSearchQueryResultDebug[];
  search?: DemoSearchDebug;
  rawCandidateCount?: number;
  mergedCandidateCount?: number;
  dedupedCandidateCount?: number;
  validCandidateCount?: number;
  roughTierDistribution?: DemoRoughTierDistribution;
  rerankEnabled?: boolean;
  rerankUsed?: boolean;
  rerankDurationMs?: number;
  rerankFailedReason?: string;
  rerankCandidatesCount?: number;
  selectedCandidatesCount?: number;
  droppedCandidatesCount?: number;
  refillTriggered?: boolean;
  refillReason?: string;
  refillQueries?: DemoSearchQueryPlan[];
  refillCandidateCount?: number;
  finalCandidateCount?: number;
  finalCandidates?: DemoFinalCandidateDebug[];
  droppedCandidates?: DemoDroppedCandidateDebug[];
  candidateQuality?: DemoCandidateQuality[];
  experienceSummaryDebug?: DemoExperienceSummaryDebug[];
  clarificationContext?: DemoDebugClarificationContext;
  clarificationPlan?: DemoDebugClarificationPlan;
  notes: string[];
}

export interface DemoDebugClarificationPlan {
  intentCategory: string;
  knownFacts?: DemoClarificationKnownFact[];
  choiceFrame?: DemoClarificationChoiceFrame;
  missingSimilarityDimensions?: DemoClarificationMissingSimilarityDimension[];
  candidateQuestions?: DemoClarificationCandidateQuestion[];
  scoringDetails?: DemoClarificationScoringDetail[];
  knownSlots: Record<string, string | null>;
  missingSimilaritySlots: string[];
  selectedQuestions: DemoDebugSelectedClarificationQuestion[];
  rejectedQuestions: DemoDebugRejectedClarificationQuestion[];
  selectedSlots: string[];
  queryPlan?: DemoObjectiveQueryPlan;
}

export interface DemoClarificationKnownFact {
  slot: string;
  value: string;
  evidence: string;
  confidence: number;
  queryTokens?: string[];
}

export interface DemoClarificationChoiceFrame {
  type: string;
  currentPath: string | null;
  targetOptions: string[];
  avoidPath: string | null;
  action: string;
  queryTokens?: string[];
}

export interface DemoClarificationMissingSimilarityDimension {
  slot: string;
  reason: string;
  queryUtility: number;
  similarityPower: number;
}

export interface DemoClarificationCandidateQuestion {
  slot: string;
  question: string;
  type: string;
  options: string[];
  whyUseful: string;
  queryTokens: string[];
  similarityPower: number;
  queryUtility: number;
  answerability: number;
  targetRelevance?: number;
  riskFlags: string[];
}

export interface DemoClarificationScoringDetail {
  slot: string;
  question: string;
  score: number;
  similarityPower: number;
  queryUtility: number;
  answerability: number;
  targetRelevance: number;
  knownPenalty: number;
  futurePenalty: number;
  preferencePenalty: number;
  selected: boolean;
}

export interface DemoDebugSelectedClarificationQuestion {
  slot: string;
  question: string;
  selectedReason: string;
  queryTokens?: string[];
  score?: number;
  answer?: string;
}

export interface DemoDebugRejectedClarificationQuestion {
  slot?: string;
  question: string;
  reason: string;
  queryTokens?: string[];
  riskFlags?: string[];
}

export interface DemoDebugClarificationContext {
  originalQuery: string;
  answers: DemoClarificationAnswers;
  answerLabels: DemoClarificationAnswers;
  unresolvedAnswers?: DemoClarificationAnswers;
  answerSummary: string;
  searchHints: string[];
  applied: boolean;
  searchHintCount: number;
  queryPlan?: DemoObjectiveQueryPlan;
}

export interface DemoMatchedQueryDebug {
  query: string;
  type?: DemoSearchQueryType;
  purpose?: string;
}

export interface DemoRoughTierDistribution {
  strong: number;
  usable: number;
  backup: number;
  drop: number;
}

export interface DemoCandidateQuality {
  candidateId: string;
  sourceRefId?: string;
  title: string;
  matchedQuery?: string;
  matchedQueries?: DemoMatchedQueryDebug[];
  queryType?: DemoSearchQueryType;
  queryPurpose?: string;
  relevanceScore: number;
  qualityScore: number;
  experienceSignalScore: number;
  contentLength: number;
  filterReason: string;
  usedAsEvidence: boolean;
  roughScore?: number;
  topicHitScore?: number;
  narrativeScore?: number;
  specificityScore?: number;
  basicQualityScore?: number;
  penaltyScore?: number;
  roughTier?: DemoRoughTier;
  relevanceSignals?: string[];
  narrativeSignals?: string[];
  specificitySignals?: string[];
  penaltySignals?: string[];
  roughReason?: string;
  contentRole?: DemoContentRole;
  relationToUserIntent?: string;
  summaryAngle?: string;
  diversityKey?: string;
  keepReason?: string;
  dropReason?: string;
}

export interface DemoFinalCandidateDebug {
  candidateId: string;
  title: string;
  author: string;
  matchedQuery?: string;
  queryType?: DemoSearchQueryType;
  roughScore: number;
  relevanceScore?: number;
  contentRole?: DemoContentRole;
  relationToUserIntent?: string;
  summaryAngle?: string;
  diversityKey?: string;
  keepReason?: string;
  sourceRefs?: string[];
}

export interface DemoPathDiversityCheck {
  duplicateFound: boolean;
  duplicateTitleCount: number;
  duplicateSummaryPrefixCount: number;
  duplicateDiversityKeys: string[];
  rewriteCount: number;
  mergeCount: number;
  notes: string[];
}

export interface DemoDroppedCandidateDebug {
  candidateId: string;
  title: string;
  roughScore: number;
  dropReason: string;
}

export interface DemoDebugTiming {
  stageName:
    | "intent_expand"
    | "candidate_rerank"
    | "evidence_extract"
    | "demo_response_compose"
    | "experience_summary"
    | "grounding_guard"
    | "persona_chat"
    | "similarity_clarification_plan"
    | "path_enhancer"
    | "people_enhancer"
    | "persona_enhancer";
  provider?: string;
  model?: string;
  durationMs: number;
  llmUsed: boolean;
  fallbackUsed: boolean;
  fallbackReason: string;
}

export interface DemoDebugIntentStage {
  mode: "rule" | "llm" | "hybrid" | "fallback";
  llmUsed: boolean;
  provider?: string;
  model?: string;
  fallbackReason: string;
  intentSource: "rule" | "llm";
  focusTagsSource: "rule" | "llm";
  objectiveSlots?: DemoObjectiveSlots;
  missingSlots?: DemoObjectiveSlotName[];
  queryPlan?: DemoObjectiveQueryPlan;
}

export interface DemoDebugLlmStageResult {
  stage:
    | "intent_expand"
    | "candidate_rerank"
    | "evidence_extract"
    | "demo_response_compose"
    | "experience_summary"
    | "grounding_guard"
    | "persona_chat"
    | "similarity_clarification_plan"
    | "path_enhancer"
    | "people_enhancer"
    | "persona_enhancer";
  attempted: number;
  succeeded: number;
  failed: number;
  repairUsed: number;
  repairFailed: number;
  fallbackReasons: string[];
  provider?: string;
  model?: string;
}

export interface DemoExperienceSummaryDebug {
  personId: string;
  status: DemoExperienceSummaryStatus;
  source: DemoExperienceSummarySource;
  reason: string;
  cacheHit: boolean;
  fallbackSummary?: string;
}

export type DemoLlmArtifactSourceStage =
  | "intent_expand"
  | "candidate_rerank"
  | "evidence_extract"
  | "demo_response_compose"
  | "experience_summary"
  | "grounding_guard";

export interface DemoLlmArtifactSource {
  source: "llm" | "rule_fallback" | "skipped";
  stageStatus: "success" | "fallback" | "skipped";
  fallbackReason?: string;
}
