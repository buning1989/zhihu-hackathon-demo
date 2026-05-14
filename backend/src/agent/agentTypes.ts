import type { UserContext } from "../auth/session.js";
import type { DemoSearchRequest } from "../services/demoSearch.service.js";
import type { ApiSuccessResponse } from "../types/api.types.js";
import type {
  DemoDataMode,
  DemoDebugTiming,
  DemoLlmStageMeta,
  DemoSearchQueryPlan,
  DemoSearchResponse
} from "../types/demo.types.js";

export type AgentTaskType = "demo_search";
export type AgentTaskStatus = "running" | "completed" | "failed";
export type AgentStageName =
  | "intent_expand"
  | "content_search"
  | "candidate_rank"
  | "evidence_extract"
  | "response_compose"
  | "grounding_guard"
  | "persona_prepare";
export type AgentStageStatus =
  | "pending"
  | "running"
  | "completed"
  | "fallback"
  | "timeout"
  | "error";

export interface AgentTaskError {
  code: string;
  message: string;
  stage?: AgentStageName;
}

export interface AgentStage {
  name: AgentStageName;
  label: string;
  status: AgentStageStatus;
  startedAt?: string;
  endedAt?: string;
  durationMs?: number;
  fallbackReason?: string;
  error?: AgentTaskError;
}

export interface AgentPartialResult {
  expandedQueries?: DemoSearchQueryPlan[];
  searchStats?: Record<string, unknown>;
  candidates?: unknown[];
  evidence?: unknown[];
  paths?: DemoSearchResponse["paths"];
  people?: DemoSearchResponse["people"];
  personas?: DemoSearchResponse["personas"];
}

export interface AgentTaskDebug {
  timings?: DemoDebugTiming[];
  llmStages?: DemoLlmStageMeta[];
  fallbackStages?: string[];
  timedOutStages?: string[];
  notes?: string[];
  [key: string]: unknown;
}

export interface AgentTask {
  id: string;
  taskId: string;
  type: AgentTaskType;
  status: AgentTaskStatus;
  input: {
    query: string;
    count: number;
    dataMode: DemoDataMode;
  };
  currentStage?: AgentStageName;
  stages: AgentStage[];
  partial: AgentPartialResult;
  result?: DemoSearchResponse;
  error?: AgentTaskError;
  debug?: AgentTaskDebug;
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
  completedAt?: string;
  failedAt?: string;
}

export interface CreateAgentTaskInput {
  type?: AgentTaskType;
  request: DemoSearchRequest;
  ttlMs?: number;
}

export interface UpdateAgentTaskInput {
  status?: AgentTaskStatus;
  currentStage?: AgentStageName | null;
  stages?: AgentStage[];
  partial?: AgentPartialResult;
  result?: DemoSearchResponse;
  error?: AgentTaskError | null;
  debug?: AgentTaskDebug;
}

export interface RunDemoSearchAgentInput {
  taskId: string;
  request: DemoSearchRequest;
  userContext?: UserContext;
}

export type RunDemoSearchAgent = (
  input: RunDemoSearchAgentInput
) => Promise<DemoSearchResponse | void> | DemoSearchResponse | void;

export interface AgentSearchTaskStartResponse {
  taskId: string;
  status: "running";
  createdAt: string;
}

export type AgentSearchTaskStartApiResponse =
  ApiSuccessResponse<AgentSearchTaskStartResponse>;
export type AgentTaskApiResponse = ApiSuccessResponse<AgentTask>;
