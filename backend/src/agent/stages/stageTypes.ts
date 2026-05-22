export const AGENT_STAGE_UNDERSTAND_GOAL_RULE = "understand_goal_rule";
export const AGENT_STAGE_PLAN_SEARCH_LLM = "plan_search_llm";
export const AGENT_STAGE_RETRIEVE_SOURCES = "retrieve_sources";
export const AGENT_STAGE_NORMALIZE_CANDIDATES = "normalize_candidates";
export const AGENT_STAGE_EVIDENCE_EXTRACT_LLM = "evidence_extract_llm";
export const AGENT_STAGE_RESPONSE_COMPOSE_LLM = "response_compose_llm";
export const AGENT_STAGE_GROUNDING_GUARD_LLM = "grounding_guard_llm";

export type AgentBusinessStageName =
  | typeof AGENT_STAGE_UNDERSTAND_GOAL_RULE
  | typeof AGENT_STAGE_PLAN_SEARCH_LLM
  | typeof AGENT_STAGE_RETRIEVE_SOURCES
  | typeof AGENT_STAGE_NORMALIZE_CANDIDATES
  | typeof AGENT_STAGE_EVIDENCE_EXTRACT_LLM
  | typeof AGENT_STAGE_RESPONSE_COMPOSE_LLM
  | typeof AGENT_STAGE_GROUNDING_GUARD_LLM;

export const AGENT_ARTIFACT_INTENT = "intent";
export const AGENT_ARTIFACT_SEARCH_PLAN = "search_plan";
export const AGENT_ARTIFACT_RAW_SOURCES = "raw_sources";
export const AGENT_ARTIFACT_CANDIDATES = "candidates";
export const AGENT_ARTIFACT_EVIDENCE = "evidence";
export const AGENT_ARTIFACT_FINAL_RESULT = "final_result";
export const AGENT_ARTIFACT_GUARDED_FINAL_RESULT = "guarded_final_result";
export const AGENT_ARTIFACT_PRODUCTION_FINAL_RESULT = "production_final_result";

export interface AgentStageOutput<TData> {
  artifactType: string;
  data: TData;
  status?: "succeeded" | "fallback" | "degraded";
  fallbackUsed?: boolean;
  fallbackReason?: string | null;
  cacheHit?: boolean;
  cacheKey?: string | null;
}

export interface IntentArtifactData {
  originalQuery: string;
  normalizedQuery: string;
  expandedQueries: string[];
  strategy: "rule_based";
  llmUsed: false;
}

export interface SearchPlanArtifactData {
  originalQuery: string;
  expandedQueries: string[];
  searchAngles: string[];
  negativeKeywords: string[];
  targetPersonTypes: string[];
  strategy: "llm_planned" | "rule_fallback";
  llmUsed: boolean;
  fallbackReason?: string;
}

export interface RawSourceItem {
  sourceId: string;
  provider: "zhihu" | "mock" | "empty";
  type: string;
  title: string;
  url: string;
  author: string;
  excerpt: string;
  score: number;
  raw?: Record<string, unknown>;
}

export interface RawSourcesArtifactData {
  query: string;
  expandedQueries: string[];
  sources: RawSourceItem[];
  sourceCount: number;
  provider: "zhihu" | "mock" | "empty";
  fallbackUsed: boolean;
  fallbackReason?: string | null;
}

export interface CandidateItem {
  id: string;
  sourceId: string;
  type?: string;
  title: string;
  author: string;
  excerpt: string;
  url: string;
  score: number;
  provider: string;
  normalizedSearchScore: number;
  relevanceScore: number;
  experienceScore: number;
  qualityScore: number;
  qualitySignals: string[];
  rejectReason?: string | null;
  selectedForEvidence: boolean;
}

export interface CandidatesArtifactData {
  candidates: CandidateItem[];
  candidateCount: number;
  sourceCount?: number;
  filteredOutCount?: number;
  dedupedSourceCount?: number;
  filters?: {
    acceptedTypes: string[];
    minScoreExclusive?: number;
    minSelectedQualityScore?: number;
    maxSelectedForEvidence?: number;
  };
  qualityReport?: {
    selectedForEvidenceCount: number;
    rejectedCount: number;
    minSelectedQualityScore: number;
    lowQualityCandidateIds: string[];
    rejectReasonCounts?: Record<string, number>;
  };
  strategy: "rule_based";
}

export type EvidenceSupportType =
  | "experience_fact"
  | "decision_point"
  | "constraint"
  | "emotion_change"
  | "outcome"
  | "tradeoff"
  | "opinion"
  | "context";

export interface EvidenceItem {
  id: string;
  candidateId: string;
  sourceCandidateId: string;
  title: string;
  author: string;
  sourceUrl: string;
  evidenceText: string;
  excerpt: string;
  reason: string;
  normalizedClaim: string;
  supportType: EvidenceSupportType;
  isExperienceEvidence: boolean;
  confidence: number;
}

export interface EvidenceArtifactData {
  evidenceItems: EvidenceItem[];
  qualityReport?: {
    totalEvidenceCount: number;
    experienceEvidenceCount: number;
    lowConfidenceEvidenceIds: string[];
    invalidCandidateEvidenceCount: number;
    chunkCount?: number;
    chunkSuccessCount?: number;
    chunkFailureCount?: number;
    repairCount?: number;
    retryCount?: number;
    chunkFailureReasons?: string[];
  };
  strategy: "llm_extracted" | "rule_fallback";
  llmUsed: boolean;
  fallbackReason?: string;
}

export interface FinalResultPath {
  title: string;
  summary: string;
  evidenceIds: string[];
  candidateIds: string[];
}

export interface FinalResultPerson {
  name: string;
  reason: string;
  candidateId: string;
  evidenceIds: string[];
}

export interface FinalResultArtifactData {
  schemaVersion: "agent.final_result.v1";
  summary: string;
  paths: FinalResultPath[];
  people: FinalResultPerson[];
  suggestedQuestions: string[];
  strategy: "llm_composed" | "rule_fallback";
  llmUsed: boolean;
  fallbackReason?: string;
}

export interface GroundingGuardReport {
  status: "passed" | "repaired" | "partial" | "fallback";
  unsupportedClaims: string[];
  removedItems: string[];
  warnings: string[];
  evidenceCoverage: number | null;
  deterministicQualityReport?: {
    checked: boolean;
    lowQualityCandidateIds: string[];
    lowConfidenceEvidenceIds: string[];
    personaWithoutExperienceEvidenceIds: string[];
  };
}

export interface GuardedFinalResultArtifactData {
  schemaVersion: "agent.guarded_final_result.v1";
  result: FinalResultArtifactData;
  guard: GroundingGuardReport;
  strategy: "llm_guarded" | "rule_fallback";
  llmUsed: boolean;
  fallbackReason?: string;
}
