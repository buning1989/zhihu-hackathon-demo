export const DEMO_SCHEMA_VERSION = "demo.v1" as const;
export const DEMO_PERSONA_BOUNDARY_NOTICE = "该 AI 分身基于公开内容生成，不代表作者本人。";

export type DemoSchemaVersion = typeof DEMO_SCHEMA_VERSION;
export type DemoDataMode = "mock" | "cache_first" | "real";
export type DemoPersonaChatMode = "off" | "mock" | "real";
export type DemoExperienceSummarySource = "llm" | "fallback" | "none";
export type DemoExperienceSummaryStatus = "ready" | "pending" | "failed";
export type DemoSearchQueryType =
  | "original"
  | "real_experience"
  | "life_path"
  | "failure_review"
  | "decision_conflict"
  | "alternative_solution";
export type DemoDebugFallbackKind =
  | ""
  | "no_llm_config"
  | "partial_llm_fallback"
  | "all_llm_failed";
export type DemoDebugPathSource = "llm" | "rule" | "fallback";

export interface DemoSearchRequestBody {
  query?: unknown;
  count?: unknown;
  mode?: unknown;
  dataMode?: unknown;
}

export interface DemoSearchResponse {
  schemaVersion: DemoSchemaVersion;
  queryId: string;
  query: string;
  dataMode: DemoDataMode;
  contextUsed?: DemoContextUsed;
  features: DemoFeatures;
  analysis: DemoAnalysis;
  paths: DemoPath[];
  people: DemoPerson[];
  personas: DemoPersona[];
  sections: DemoSection[];
  meta: DemoMeta;
  debug: DemoDebug;
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
  fitReason?: string;
  stance: "experience" | "viewpoint" | "mixed";
  personRefs?: string[];
  evidenceIds: string[];
  sourceRefs: string[];
}

export interface DemoPerson {
  id: string;
  name: string;
  sampleType?: "experience_sample" | "viewpoint_author" | "content_sample";
  pathId: string;
  role: string;
  badge: string;
  avatar: string;
  oneLine: string;
  experienceSummary: string | null;
  experienceSummarySource: DemoExperienceSummarySource;
  experienceSummaryStatus: DemoExperienceSummaryStatus;
  experienceSummaryConfidence?: number;
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
  fallbackUsed: boolean;
}

export interface DemoSearchQueryPlan {
  query: string;
  type: DemoSearchQueryType;
  purpose: string;
  priority: number;
}

export interface DemoSearchQueryResultDebug extends DemoSearchQueryPlan {
  returnedCount: number;
  error?: string;
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
  timings?: DemoDebugTiming[];
  enhancedPeopleCount?: number;
  enhancedPathCount?: number;
  partialFallbackUsed?: boolean;
  pathSource: DemoDebugPathSource;
  intentStage: DemoDebugIntentStage;
  fallbackKind: DemoDebugFallbackKind;
  fallbackReason: string;
  guardWarnings: string[];
  searchQueries?: DemoSearchQueryPlan[];
  searchQueryResults?: DemoSearchQueryResultDebug[];
  mergedCandidateCount?: number;
  dedupedCandidateCount?: number;
  validCandidateCount?: number;
  candidateQuality?: DemoCandidateQuality[];
  experienceSummaryDebug?: DemoExperienceSummaryDebug[];
  notes: string[];
}

export interface DemoCandidateQuality {
  candidateId: string;
  sourceRefId?: string;
  title: string;
  matchedQuery?: string;
  queryType?: DemoSearchQueryType;
  queryPurpose?: string;
  relevanceScore: number;
  qualityScore: number;
  experienceSignalScore: number;
  contentLength: number;
  filterReason: string;
  usedAsEvidence: boolean;
}

export interface DemoDebugTiming {
  stageName:
    | "intent_expand"
    | "evidence_extract"
    | "demo_response_compose"
    | "experience_summary"
    | "grounding_guard"
    | "persona_chat"
    | "path_enhancer"
    | "people_enhancer"
    | "persona_enhancer";
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
}

export interface DemoDebugLlmStageResult {
  stage:
    | "intent_expand"
    | "evidence_extract"
    | "demo_response_compose"
    | "experience_summary"
    | "grounding_guard"
    | "persona_chat"
    | "path_enhancer"
    | "people_enhancer"
    | "persona_enhancer";
  attempted: number;
  succeeded: number;
  failed: number;
  repairUsed: number;
  repairFailed: number;
  fallbackReasons: string[];
}

export interface DemoExperienceSummaryDebug {
  personId: string;
  status: DemoExperienceSummaryStatus;
  source: DemoExperienceSummarySource;
  reason: string;
  cacheHit: boolean;
  fallbackSummary?: string;
}
