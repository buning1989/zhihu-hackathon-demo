import { config } from "../../config/env.js";
import { llmGateway } from "../../llm/llmGateway.js";
import { agentRepository } from "../agentRepository.js";
import {
  AGENT_ARTIFACT_SEARCH_PLAN,
  AGENT_STAGE_PLAN_SEARCH_LLM,
  type AgentStageOutput,
  type IntentArtifactData,
  type SearchPlanArtifactData
} from "./stageTypes.js";

export async function runPlanSearchLlmStage(
  taskId: string,
  intent: IntentArtifactData
): Promise<AgentStageOutput<SearchPlanArtifactData>> {
  const result = await llmGateway.runJson<SearchPlanArtifactData>({
    stageName: AGENT_STAGE_PLAN_SEARCH_LLM,
    provider: config.agent.llm.provider,
    model: config.agent.llm.model,
    messages: buildPlanSearchMessages(intent),
    timeoutMs: config.agent.llm.timeoutMs,
    retries: config.agent.llm.retries,
    schemaName: "agent.search_plan.v1",
    responseFormat: { type: "json_object" },
    validate: isSearchPlanArtifactData,
    fallback: (context) => buildSearchPlanFallback(intent, context.fallbackReason),
    metadata: {
      originalQuery: intent.originalQuery
    },
    onEvent: async (type, payload) => {
      await agentRepository.createEvent({
        taskId,
        type,
        payload: { ...payload }
      });
    }
  });

  return {
    artifactType: AGENT_ARTIFACT_SEARCH_PLAN,
    data: result.data,
    status: result.status === "success" ? "succeeded" : "fallback",
    fallbackUsed: result.fallbackUsed,
    fallbackReason: result.fallbackReason || null
  };
}

function buildPlanSearchMessages(intent: IntentArtifactData) {
  return [
    {
      role: "system" as const,
      content:
        "你是搜索计划生成器。只输出 JSON，不要输出解释。不要总结内容，不要提取证据，不要构造人物。"
    },
    {
      role: "user" as const,
      content: JSON.stringify({
        task: "根据用户问题生成知乎检索计划",
        outputShape: {
          originalQuery: "string",
          expandedQueries: ["string"],
          searchAngles: ["string"],
          negativeKeywords: ["string"],
          targetPersonTypes: ["string"],
          strategy: "llm_planned",
          llmUsed: true
        },
        constraints: [
          "expandedQueries 必须包含 originalQuery",
          "expandedQueries 最多 6 条",
          "不要生成最终回答",
          "不要生成证据摘要",
          "不要生成 AI 分身"
        ],
        intent
      })
    }
  ];
}

function buildSearchPlanFallback(
  intent: IntentArtifactData,
  fallbackReason: string
): SearchPlanArtifactData {
  const originalQuery = intent.originalQuery || intent.normalizedQuery;

  return {
    originalQuery,
    expandedQueries: uniqueNonEmpty([originalQuery, ...intent.expandedQueries]),
    searchAngles: [],
    negativeKeywords: [],
    targetPersonTypes: [],
    strategy: "rule_fallback",
    llmUsed: false,
    fallbackReason
  };
}

function isSearchPlanArtifactData(value: unknown): boolean {
  if (!isRecord(value)) {
    return false;
  }

  const strategy = value.strategy;
  return (
    typeof value.originalQuery === "string" &&
    isStringArray(value.expandedQueries) &&
    value.expandedQueries.length > 0 &&
    isStringArray(value.searchAngles) &&
    optionalStringArray(value.negativeKeywords) &&
    isStringArray(value.targetPersonTypes) &&
    (strategy === "llm_planned" || strategy === "rule_fallback") &&
    typeof value.llmUsed === "boolean"
  );
}

function optionalStringArray(value: unknown): boolean {
  return value === undefined || isStringArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function uniqueNonEmpty(values: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];

  for (const value of values) {
    const normalized = value.trim();
    if (normalized && !seen.has(normalized)) {
      seen.add(normalized);
      result.push(normalized);
    }
  }

  return result;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
