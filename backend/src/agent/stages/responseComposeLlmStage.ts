import { config } from "../../config/env.js";
import { llmGateway } from "../../llm/llmGateway.js";
import { agentRepository } from "../agentRepository.js";
import {
  AGENT_ARTIFACT_FINAL_RESULT,
  AGENT_STAGE_RESPONSE_COMPOSE_LLM,
  type AgentStageOutput,
  type CandidateItem,
  type CandidatesArtifactData,
  type EvidenceArtifactData,
  type EvidenceItem,
  type FinalResultArtifactData,
  type FinalResultPath,
  type FinalResultPerson,
  type IntentArtifactData,
  type SearchPlanArtifactData
} from "./stageTypes.js";

const MAX_LLM_CANDIDATES = 8;
const MAX_LLM_EVIDENCE_ITEMS = 12;
const MAX_EXCERPT_LENGTH = 360;
const MAX_EVIDENCE_TEXT_LENGTH = 280;

interface EvidenceInputItem extends EvidenceItem {
  id: string;
}

export async function runResponseComposeLlmStage(
  taskId: string,
  intent: IntentArtifactData,
  searchPlan: SearchPlanArtifactData,
  candidates: CandidatesArtifactData,
  evidence: EvidenceArtifactData
): Promise<AgentStageOutput<FinalResultArtifactData>> {
  const limitedCandidates = candidates.candidates.slice(0, MAX_LLM_CANDIDATES);
  const limitedEvidence = evidence.evidenceItems
    .slice(0, MAX_LLM_EVIDENCE_ITEMS)
    .map(toEvidenceInputItem);

  const result = await llmGateway.runJson<FinalResultArtifactData>({
    stageName: AGENT_STAGE_RESPONSE_COMPOSE_LLM,
    provider: config.agent.llm.provider,
    model: config.agent.llm.model,
    messages: buildResponseComposeMessages(intent, searchPlan, limitedCandidates, limitedEvidence),
    timeoutMs: config.agent.llm.timeoutMs,
    retries: config.agent.llm.retries,
    schemaName: "agent.final_result.v1",
    responseFormat: { type: "json_object" },
    validate: isFinalResultArtifactData,
    fallback: (context) =>
      buildFinalResultFallback(limitedCandidates, limitedEvidence, context.fallbackReason),
    metadata: {
      originalQuery: intent.originalQuery,
      candidateCount: limitedCandidates.length,
      evidenceCount: limitedEvidence.length,
      candidates: limitedCandidates.map(toGatewayCandidateMetadata),
      evidenceItems: limitedEvidence.map(toGatewayEvidenceMetadata)
    },
    maxTokens: 1800,
    temperature: 0.2,
    onEvent: async (type, payload) => {
      await agentRepository.createEvent({
        taskId,
        type,
        payload: { ...payload }
      });
    }
  });

  return {
    artifactType: AGENT_ARTIFACT_FINAL_RESULT,
    data: result.data,
    status: result.status === "success" ? "succeeded" : "fallback",
    fallbackUsed: result.fallbackUsed,
    fallbackReason: result.fallbackReason || null
  };
}

function buildResponseComposeMessages(
  intent: IntentArtifactData,
  searchPlan: SearchPlanArtifactData,
  candidates: CandidateItem[],
  evidenceItems: EvidenceInputItem[]
) {
  return [
    {
      role: "system" as const,
      content:
        "你是结果组织器。只输出 JSON，不要输出解释。只能基于输入 candidates 和 evidence 组织展示结果，不要编造事实，不要做 grounding guard，不要构造 AI 分身。"
    },
    {
      role: "user" as const,
      content: JSON.stringify({
        task: "把检索候选和证据组织成最终可展示结果",
        outputShape: {
          schemaVersion: "agent.final_result.v1",
          summary: "string",
          paths: [
            {
              title: "string",
              summary: "string",
              evidenceIds: ["string"],
              candidateIds: ["string"]
            }
          ],
          people: [
            {
              name: "string",
              reason: "string",
              candidateId: "string",
              evidenceIds: ["string"]
            }
          ],
          suggestedQuestions: ["string"],
          strategy: "llm_composed",
          llmUsed: true
        },
        constraints: [
          "summary 必须基于输入 evidence/candidates",
          "paths[].evidenceIds 只能引用输入 evidenceItems[].id",
          "paths[].candidateIds 只能引用输入 candidates[].id",
          "people[].candidateId 只能引用输入 candidates[].id",
          "people[].evidenceIds 只能引用输入 evidenceItems[].id",
          "不要生成 AI 分身",
          "不要输出作者本人实时回应、联系方式或私信建议"
        ],
        intent: {
          originalQuery: intent.originalQuery,
          normalizedQuery: intent.normalizedQuery,
          expandedQueries: intent.expandedQueries
        },
        searchPlan: {
          originalQuery: searchPlan.originalQuery,
          expandedQueries: searchPlan.expandedQueries,
          searchAngles: searchPlan.searchAngles,
          targetPersonTypes: searchPlan.targetPersonTypes
        },
        candidates: candidates.map((candidate) => ({
          id: candidate.id,
          type: candidate.type,
          title: truncateText(candidate.title, 120),
          author: truncateText(candidate.author, 80),
          excerpt: truncateText(candidate.excerpt, MAX_EXCERPT_LENGTH),
          url: candidate.url,
          score: candidate.score
        })),
        evidenceItems: evidenceItems.map((item) => ({
          id: item.id,
          candidateId: item.candidateId,
          title: truncateText(item.title, 120),
          author: truncateText(item.author, 80),
          sourceUrl: item.sourceUrl,
          evidenceText: truncateText(item.evidenceText, MAX_EVIDENCE_TEXT_LENGTH),
          reason: truncateText(item.reason, 160),
          confidence: item.confidence
        }))
      })
    }
  ];
}

function buildFinalResultFallback(
  candidates: CandidateItem[],
  evidenceItems: EvidenceInputItem[],
  fallbackReason: string
): FinalResultArtifactData {
  return {
    schemaVersion: "agent.final_result.v1",
    summary: "已根据候选内容和证据整理出初步结果。",
    paths: buildFallbackPaths(candidates, evidenceItems),
    people: buildFallbackPeople(candidates, evidenceItems),
    suggestedQuestions: [
      "这些路径分别有哪些风险？",
      "哪些经历和我的问题最相似？",
      "如果先暂停工作，应该先准备什么？"
    ],
    strategy: "rule_fallback",
    llmUsed: false,
    fallbackReason
  };
}

function buildFallbackPaths(
  candidates: CandidateItem[],
  evidenceItems: EvidenceInputItem[]
): FinalResultPath[] {
  if (candidates.length === 0) {
    return [];
  }

  return [
    {
      title: "先从相似经历里拆出可选路径",
      summary: "候选内容中已经出现了一些与问题相关的经历片段，可以先按生活安排、风险和后续收入来源继续比较。",
      evidenceIds: evidenceItems.slice(0, 3).map((item) => item.id),
      candidateIds: candidates.slice(0, 3).map((candidate) => candidate.id)
    }
  ];
}

function buildFallbackPeople(
  candidates: CandidateItem[],
  evidenceItems: EvidenceInputItem[]
): FinalResultPerson[] {
  return candidates.slice(0, 3).map((candidate) => ({
    name: candidate.author || "知乎用户",
    reason: "TA 的内容和当前问题存在相似经历或选择线索，适合作为后续对比样本。",
    candidateId: candidate.id,
    evidenceIds: evidenceItems
      .filter((item) => item.candidateId === candidate.id)
      .slice(0, 2)
      .map((item) => item.id)
  }));
}

function toEvidenceInputItem(item: EvidenceItem, index: number): EvidenceInputItem {
  return {
    ...item,
    id: `evidence_${hashSafeId(item.candidateId || item.sourceUrl || item.title)}_${index + 1}`,
    evidenceText: truncateText(item.evidenceText, MAX_EVIDENCE_TEXT_LENGTH),
    reason: truncateText(item.reason, 160)
  };
}

function toGatewayCandidateMetadata(candidate: CandidateItem): Record<string, unknown> {
  return {
    id: candidate.id,
    type: candidate.type,
    title: candidate.title,
    author: candidate.author,
    excerpt: truncateText(candidate.excerpt, MAX_EXCERPT_LENGTH),
    url: candidate.url,
    score: candidate.score
  };
}

function toGatewayEvidenceMetadata(item: EvidenceInputItem): Record<string, unknown> {
  return {
    id: item.id,
    candidateId: item.candidateId,
    title: item.title,
    author: item.author,
    sourceUrl: item.sourceUrl,
    evidenceText: truncateText(item.evidenceText, MAX_EVIDENCE_TEXT_LENGTH),
    confidence: item.confidence
  };
}

function isFinalResultArtifactData(value: unknown): boolean {
  if (!isRecord(value)) {
    return false;
  }

  const strategy = value.strategy;
  return (
    value.schemaVersion === "agent.final_result.v1" &&
    typeof value.summary === "string" &&
    Array.isArray(value.paths) &&
    value.paths.every(isFinalResultPath) &&
    Array.isArray(value.people) &&
    value.people.every(isFinalResultPerson) &&
    Array.isArray(value.suggestedQuestions) &&
    value.suggestedQuestions.every((item) => typeof item === "string") &&
    (strategy === "llm_composed" || strategy === "rule_fallback") &&
    typeof value.llmUsed === "boolean" &&
    (value.fallbackReason === undefined || typeof value.fallbackReason === "string")
  );
}

function isFinalResultPath(value: unknown): boolean {
  if (!isRecord(value)) {
    return false;
  }

  return (
    typeof value.title === "string" &&
    typeof value.summary === "string" &&
    isStringArray(value.evidenceIds) &&
    isStringArray(value.candidateIds)
  );
}

function isFinalResultPerson(value: unknown): boolean {
  if (!isRecord(value)) {
    return false;
  }

  return (
    typeof value.name === "string" &&
    typeof value.reason === "string" &&
    typeof value.candidateId === "string" &&
    isStringArray(value.evidenceIds)
  );
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function hashSafeId(value: string): string {
  const normalized = value.replace(/[^a-zA-Z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  return normalized.slice(0, 48) || "item";
}

function truncateText(value: string, maxLength: number): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }

  return `${normalized.slice(0, Math.max(maxLength - 1, 0))}…`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
