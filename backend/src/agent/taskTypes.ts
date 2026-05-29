import type { UserContext } from "../auth/session.js";
import type { DemoDataMode, DemoSearchQueryPlan } from "../types/demo.types.js";

export const AGENT_STAGE_ORDER = [
  "intent_expand",
  "retrieve_search",
  "candidate_select",
  "partial_compose",
  "evidence_extract",
  "experience_summary",
  "grounding_guard",
  "persona_prepare"
] as const;

export type AgentStageName = (typeof AGENT_STAGE_ORDER)[number];

export type AgentTaskStatus =
  | "queued"
  | "need_input"
  | "running"
  | "partial_ready"
  | "succeeded"
  | "degraded"
  | "failed"
  | "canceled";

export type AgentStageStatus =
  | "pending"
  | "running"
  | "succeeded"
  | "degraded"
  | "failed"
  | "skipped"
  | "timed_out";

export interface AgentTaskInput {
  query: string;
  count: number;
  requestedDataMode: DemoDataMode;
  dataMode: DemoDataMode;
  metadata: Record<string, unknown>;
  userContext?: UserContext;
}

export interface AgentIntentResult {
  intent: string;
  userCoreQuestion: string;
  focusTags: string[];
  topicSignals: string[];
  searchQueries: DemoSearchQueryPlan[];
}

export interface AgentStageRecord {
  name: AgentStageName;
  status: AgentStageStatus;
  attempt: number;
  timeoutMs: number;
  startedAt: string | null;
  finishedAt: string | null;
  provider?: string;
  model?: string;
  inputSummary?: Record<string, unknown>;
  outputSummary?: Record<string, unknown>;
  errorCode?: string;
  errorMessage?: string;
  fallbackUsed: boolean;
  fallbackReason?: string;
  retryable: boolean;
}

export interface AgentNeedInputOption {
  id: string;
  label: string;
  refineHint?: string;
}

export interface AgentNeedInputCard {
  id: string;
  title: string;
  question: string;
  type: string;
  required: boolean;
  options: AgentNeedInputOption[];
}

export interface AgentNeedInput {
  reason: string;
  title: string;
  description: string;
  primaryActionText: string;
  skipActionText: string;
  source: "similarity_clarification_planner";
  llmUsed: boolean;
  fallbackReason?: string;
  cards: AgentNeedInputCard[];
  questions: AgentNeedInputCard[];
}

export interface AgentTaskRecord {
  taskId: string;
  query: string;
  status: AgentTaskStatus;
  currentStage: AgentStageName | null;
  progress: number;
  degraded: boolean;
  degradedReason: string | null;
  degradedReasons: string[];
  failedStages: AgentStageName[];
  retryable: boolean;
  retryableStages: AgentStageName[];
  dataMode: DemoDataMode;
  requestedDataMode: DemoDataMode;
  error?: {
    code: string;
    message: string;
  };
  needInput?: AgentNeedInput | null;
  readToken: string;
  input: AgentTaskInput;
  intent?: AgentIntentResult;
  createdAt: string;
  updatedAt: string;
  partialReadyAt: string | null;
  finishedAt: string | null;
}

export interface AgentTaskSnapshot {
  task: AgentTaskRecord;
  stages: AgentStageRecord[];
  partialResult?: unknown;
  finalResult?: unknown;
}

export interface CreateAgentTaskInput {
  query: string;
  count: number;
  dataMode: DemoDataMode;
  requestedDataMode: DemoDataMode;
  metadata: Record<string, unknown>;
  userContext?: UserContext;
}
