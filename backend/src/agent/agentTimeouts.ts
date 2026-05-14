import type { AgentStageName } from "./agentTypes.js";
import type { LlmTaskType } from "../llm/llmRouter.js";

export const AGENT_TASK_TTL_MS = 30 * 60 * 1000;
export const AGENT_TASK_CLEANUP_INTERVAL_MS = 5 * 60 * 1000;
export const AGENT_TOTAL_TIMEOUT_MS = 240 * 1000;

export const AGENT_STAGE_TIMEOUT_MS: Record<AgentStageName, number> = {
  intent_expand: 15 * 1000,
  content_search: 60 * 1000,
  candidate_rank: 15 * 1000,
  evidence_extract: 60 * 1000,
  response_compose: 45 * 1000,
  grounding_guard: 15 * 1000,
  persona_prepare: 20 * 1000
};

export const AGENT_LLM_TASK_TIMEOUT_MS: Partial<Record<LlmTaskType, number>> = {
  intent_expand: AGENT_STAGE_TIMEOUT_MS.intent_expand,
  candidate_rerank: AGENT_STAGE_TIMEOUT_MS.candidate_rank,
  evidence_extract: AGENT_STAGE_TIMEOUT_MS.evidence_extract,
  demo_response_compose: AGENT_STAGE_TIMEOUT_MS.response_compose,
  experience_summary: AGENT_STAGE_TIMEOUT_MS.persona_prepare,
  grounding_guard: AGENT_STAGE_TIMEOUT_MS.grounding_guard
};
