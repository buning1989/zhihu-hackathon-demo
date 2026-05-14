export const AGENT_STAGE_UNDERSTAND_GOAL_RULE = "understand_goal_rule";
export const AGENT_STAGE_RETRIEVE_SOURCES = "retrieve_sources";
export const AGENT_STAGE_NORMALIZE_CANDIDATES = "normalize_candidates";

export type AgentBusinessStageName =
  | typeof AGENT_STAGE_UNDERSTAND_GOAL_RULE
  | typeof AGENT_STAGE_RETRIEVE_SOURCES
  | typeof AGENT_STAGE_NORMALIZE_CANDIDATES;

export const AGENT_ARTIFACT_INTENT = "intent";
export const AGENT_ARTIFACT_RAW_SOURCES = "raw_sources";
export const AGENT_ARTIFACT_CANDIDATES = "candidates";

export interface AgentStageOutput<TData> {
  artifactType: string;
  data: TData;
  status?: "succeeded" | "fallback";
  fallbackUsed?: boolean;
  fallbackReason?: string | null;
}

export interface IntentArtifactData {
  originalQuery: string;
  normalizedQuery: string;
  expandedQueries: string[];
  strategy: "rule_based";
  llmUsed: false;
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
  title: string;
  author: string;
  excerpt: string;
  url: string;
  score: number;
  provider: string;
}

export interface CandidatesArtifactData {
  candidates: CandidateItem[];
  candidateCount: number;
  strategy: "rule_based";
}
