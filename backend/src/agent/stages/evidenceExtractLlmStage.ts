import { config } from "../../config/env.js";
import { llmGateway } from "../../llm/llmGateway.js";
import { agentRepository } from "../agentRepository.js";
import {
  AGENT_ARTIFACT_EVIDENCE,
  AGENT_STAGE_EVIDENCE_EXTRACT_LLM,
  type AgentStageOutput,
  type CandidateItem,
  type CandidatesArtifactData,
  type EvidenceArtifactData,
  type EvidenceItem,
  type IntentArtifactData,
  type SearchPlanArtifactData
} from "./stageTypes.js";

const MAX_LLM_CANDIDATES = 6;
const MAX_EXCERPT_LENGTH = 240;
const MAX_EVIDENCE_TEXT_LENGTH = 320;
const MAX_LLM_EVIDENCE_TEXT_LENGTH = 140;
const MAX_REASON_LENGTH = 80;

export async function runEvidenceExtractLlmStage(
  taskId: string,
  candidates: CandidatesArtifactData,
  searchPlan?: SearchPlanArtifactData,
  intent?: IntentArtifactData
): Promise<AgentStageOutput<EvidenceArtifactData>> {
  const limitedCandidates = candidates.candidates.slice(0, MAX_LLM_CANDIDATES);

  if (limitedCandidates.length === 0) {
    return {
      artifactType: AGENT_ARTIFACT_EVIDENCE,
      status: "fallback",
      fallbackUsed: true,
      fallbackReason: "NO_CANDIDATES: no candidates available for evidence extraction",
      data: {
        evidenceItems: [],
        strategy: "rule_fallback",
        llmUsed: false,
        fallbackReason: "NO_CANDIDATES: no candidates available for evidence extraction"
      }
    };
  }

  const originalQuery =
    searchPlan?.originalQuery || intent?.originalQuery || intent?.normalizedQuery || "";
  const result = await llmGateway.runJson<EvidenceArtifactData>({
    stageName: AGENT_STAGE_EVIDENCE_EXTRACT_LLM,
    provider: config.agent.llm.provider,
    model: config.agent.llm.model,
    messages: buildEvidenceExtractMessages(limitedCandidates, searchPlan, intent),
    timeoutMs: config.agent.llm.timeoutMs,
    retries: config.agent.llm.retries,
    schemaName: "agent.evidence.v1",
    responseFormat: { type: "json_object" },
    validate: isEvidenceArtifactData,
    fallback: (context) => buildEvidenceFallback(limitedCandidates, context.fallbackReason),
    metadata: {
      originalQuery,
      candidateCount: limitedCandidates.length,
      candidates: limitedCandidates.map(toGatewayCandidateMetadata)
    },
    maxTokens: 2200,
    temperature: 0,
    onEvent: async (type, payload) => {
      await agentRepository.createEvent({
        taskId,
        type,
        payload: { ...payload }
      });
    }
  });

  return {
    artifactType: AGENT_ARTIFACT_EVIDENCE,
    data: normalizeEvidenceArtifactData(result.data),
    status: result.status === "success" ? "succeeded" : "fallback",
    fallbackUsed: result.fallbackUsed,
    fallbackReason: result.fallbackReason || null
  };
}

function buildEvidenceExtractMessages(
  candidates: CandidateItem[],
  searchPlan?: SearchPlanArtifactData,
  intent?: IntentArtifactData
) {
  return [
    {
      role: "system" as const,
      content:
        "你是证据片段抽取器。只输出 JSON，不要输出解释。只能基于候选内容摘取证据，不要总结，不要编造，不要构造人物。"
    },
    {
      role: "user" as const,
      content: JSON.stringify({
        task: "从候选内容中抽取可支撑用户问题的证据片段",
        outputShape: {
          evidenceItems: [
            {
              candidateId: "string",
              title: "string",
              author: "string",
              sourceUrl: "string",
              evidenceText: "string",
              reason: "string",
              confidence: 0.78
            }
          ],
          strategy: "llm_extracted",
          llmUsed: true
        },
        constraints: [
          "evidenceText 必须来自 candidate.excerpt 或 title 的可见信息",
          "最多返回 6 条 evidenceItems，证据不足时返回更少条",
          "每条 evidenceText 不超过 140 个中文字符",
          "每条 reason 不超过 80 个中文字符",
          "所有字符串必须是单行文本，不要包含换行符",
          "confidence 必须在 0 到 1 之间",
          "必须返回完整 JSON object，不要输出 Markdown 代码块",
          "不要生成最终回答",
          "不要生成 AI 分身",
          "不要推断作者真实身份或经历"
        ],
        intent: intent
          ? {
              originalQuery: intent.originalQuery,
              normalizedQuery: intent.normalizedQuery,
              expandedQueries: intent.expandedQueries
            }
          : null,
        searchPlan: searchPlan
          ? {
              originalQuery: searchPlan.originalQuery,
              expandedQueries: searchPlan.expandedQueries,
              searchAngles: searchPlan.searchAngles,
              targetPersonTypes: searchPlan.targetPersonTypes
            }
          : null,
        candidates: candidates.map((candidate) => ({
          id: candidate.id,
          type: candidate.type,
          title: truncateText(candidate.title, 120),
          author: truncateText(candidate.author, 80),
          sourceUrl: candidate.url,
          excerpt: truncateText(candidate.excerpt, MAX_EXCERPT_LENGTH),
          score: candidate.score
        }))
      })
    }
  ];
}

function buildEvidenceFallback(
  candidates: CandidateItem[],
  fallbackReason: string
): EvidenceArtifactData {
  return {
    evidenceItems: candidates.map(toFallbackEvidenceItem),
    strategy: "rule_fallback",
    llmUsed: false,
    fallbackReason
  };
}

function toFallbackEvidenceItem(candidate: CandidateItem): EvidenceItem {
  return {
    candidateId: candidate.id,
    title: candidate.title,
    author: candidate.author,
    sourceUrl: candidate.url,
    evidenceText:
      truncateText(candidate.excerpt, MAX_EVIDENCE_TEXT_LENGTH) ||
      "使用 candidate.excerpt 作为规则证据",
    reason: "rule_fallback_from_excerpt",
    confidence: 0.4
  };
}

function normalizeEvidenceArtifactData(data: EvidenceArtifactData): EvidenceArtifactData {
  return {
    ...data,
    evidenceItems: data.evidenceItems.slice(0, MAX_LLM_CANDIDATES).map((item) => ({
      ...item,
      title: truncateText(item.title, 120),
      author: truncateText(item.author, 80),
      evidenceText: truncateText(item.evidenceText, MAX_LLM_EVIDENCE_TEXT_LENGTH),
      reason: truncateText(item.reason, MAX_REASON_LENGTH),
      confidence: Math.max(0, Math.min(1, item.confidence))
    }))
  };
}

function toGatewayCandidateMetadata(candidate: CandidateItem): Record<string, unknown> {
  return {
    id: candidate.id,
    type: candidate.type,
    title: candidate.title,
    author: candidate.author,
    sourceUrl: candidate.url,
    excerpt: truncateText(candidate.excerpt, MAX_EXCERPT_LENGTH),
    score: candidate.score
  };
}

function isEvidenceArtifactData(value: unknown): boolean {
  if (!isRecord(value)) {
    return false;
  }

  const strategy = value.strategy;
  return (
    Array.isArray(value.evidenceItems) &&
    value.evidenceItems.every(isEvidenceItem) &&
    (strategy === "llm_extracted" || strategy === "rule_fallback") &&
    typeof value.llmUsed === "boolean" &&
    (value.fallbackReason === undefined || typeof value.fallbackReason === "string")
  );
}

function isEvidenceItem(value: unknown): boolean {
  if (!isRecord(value)) {
    return false;
  }

  return (
    typeof value.candidateId === "string" &&
    typeof value.title === "string" &&
    typeof value.author === "string" &&
    typeof value.sourceUrl === "string" &&
    typeof value.evidenceText === "string" &&
    typeof value.reason === "string" &&
    typeof value.confidence === "number" &&
    Number.isFinite(value.confidence) &&
    value.confidence >= 0 &&
    value.confidence <= 1
  );
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
