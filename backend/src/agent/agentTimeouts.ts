import type { AgentStageName } from "./agentTypes.js";
import type { LlmTaskType } from "../llm/llmRouter.js";

export const AGENT_TASK_TTL_MS = 30 * 60 * 1000;
export const AGENT_TASK_CLEANUP_INTERVAL_MS = 5 * 60 * 1000;
export const AGENT_TOTAL_TIMEOUT_MS = 300 * 1000;

export const AGENT_STAGE_TIMEOUT_MS: Record<AgentStageName, number> = {
  intent_expand: 25 * 1000,
  clarification_planner: 25 * 1000,
  content_search: 60 * 1000,
  candidate_rank: 30 * 1000,
  evidence_extract: 90 * 1000,
  response_compose: 90 * 1000,
  grounding_guard: 30 * 1000,
  persona_prepare: 45 * 1000
};

export const AGENT_LLM_TASK_TIMEOUT_MS: Partial<Record<LlmTaskType, number>> = {
  intent_expand: AGENT_STAGE_TIMEOUT_MS.intent_expand,
  clarification_planner: AGENT_STAGE_TIMEOUT_MS.clarification_planner,
  candidate_rerank: AGENT_STAGE_TIMEOUT_MS.candidate_rank,
  evidence_extract: AGENT_STAGE_TIMEOUT_MS.evidence_extract,
  demo_response_compose: AGENT_STAGE_TIMEOUT_MS.response_compose,
  experience_summary: AGENT_STAGE_TIMEOUT_MS.persona_prepare,
  grounding_guard: AGENT_STAGE_TIMEOUT_MS.grounding_guard
};

export const AGENT_LLM_TASK_MIN_TIMEOUT_MS: Partial<Record<LlmTaskType, number>> = {
  intent_expand: 8 * 1000,
  clarification_planner: 5 * 1000,
  candidate_rerank: 5 * 1000,
  evidence_extract: 18 * 1000,
  demo_response_compose: 20 * 1000,
  experience_summary: 10 * 1000,
  grounding_guard: 6 * 1000
};

export const AGENT_LLM_TASK_RESERVED_AFTER_MS: Partial<Record<LlmTaskType, number>> = {
  intent_expand: 220 * 1000,
  clarification_planner: 210 * 1000,
  candidate_rerank: 190 * 1000,
  evidence_extract: 110 * 1000,
  demo_response_compose: 45 * 1000,
  experience_summary: 25 * 1000,
  grounding_guard: 5 * 1000
};

export const AGENT_LLM_TASK_MAX_RETRY: Partial<Record<LlmTaskType, number>> = {
  intent_expand: 1,
  clarification_planner: 1,
  candidate_rerank: 1,
  evidence_extract: 1,
  demo_response_compose: 1,
  experience_summary: 1,
  grounding_guard: 1
};

export const AGENT_SEARCH_QUERY_LIMIT = 8;
export const AGENT_SEARCH_CONCURRENCY = 3;
