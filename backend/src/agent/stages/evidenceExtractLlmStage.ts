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
  type EvidenceSupportType,
  type IntentArtifactData,
  type SearchPlanArtifactData
} from "./stageTypes.js";

const MAX_LLM_CANDIDATES = 6;
const MAX_EXCERPT_LENGTH = 240;
const MAX_EVIDENCE_TEXT_LENGTH = 320;
const MAX_LLM_EVIDENCE_TEXT_LENGTH = 140;
const MAX_REASON_LENGTH = 80;
const MIN_EXPERIENCE_EVIDENCE_SCORE = 0.5;
const MIN_EXPERIENCE_EVIDENCE_CONFIDENCE = 0.45;

export async function runEvidenceExtractLlmStage(
  taskId: string,
  candidates: CandidatesArtifactData,
  searchPlan?: SearchPlanArtifactData,
  intent?: IntentArtifactData
): Promise<AgentStageOutput<EvidenceArtifactData>> {
  const limitedCandidates = candidates.candidates
    .filter((candidate) => candidate.selectedForEvidence)
    .slice(0, MAX_LLM_CANDIDATES);

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
    data: normalizeEvidenceArtifactData(result.data, limitedCandidates),
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
              id: "string",
              candidateId: "string",
              sourceCandidateId: "string",
              title: "string",
              author: "string",
              sourceUrl: "string",
              evidenceText: "string",
              excerpt: "string",
              reason: "string",
              normalizedClaim: "string",
              supportType: "experience_fact",
              isExperienceEvidence: true,
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
          "supportType 只能是 experience_fact、decision_point、constraint、emotion_change、outcome、tradeoff、opinion、context 之一",
          "只有候选确实包含亲历、时间线、决策、约束、情绪变化、结果反馈或代价描述时，isExperienceEvidence 才能为 true",
          "纯观点、鸡汤、营销导流、套话或过短信号不能作为 isExperienceEvidence=true",
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
          score: candidate.score,
          normalizedSearchScore: candidate.normalizedSearchScore,
          relevanceScore: candidate.relevanceScore,
          experienceScore: candidate.experienceScore,
          qualityScore: candidate.qualityScore,
          qualitySignals: candidate.qualitySignals
        }))
      })
    }
  ];
}

function buildEvidenceFallback(
  candidates: CandidateItem[],
  fallbackReason: string
): EvidenceArtifactData {
  const evidenceItems = candidates.map(toFallbackEvidenceItem);
  return {
    evidenceItems,
    qualityReport: buildEvidenceQualityReport(evidenceItems, new Map(candidates.map((item) => [item.id, item]))),
    strategy: "rule_fallback",
    llmUsed: false,
    fallbackReason
  };
}

function toFallbackEvidenceItem(candidate: CandidateItem, index: number): EvidenceItem {
  const evidenceText =
    truncateText(candidate.excerpt, MAX_EVIDENCE_TEXT_LENGTH) ||
    "使用 candidate.excerpt 作为规则证据";
  const supportType = inferSupportType(evidenceText, candidate);
  const confidence = calculateEvidenceConfidence(candidate, 0.5);
  const isExperienceEvidence = inferIsExperienceEvidence(candidate, supportType, confidence);

  return {
    id: buildEvidenceId(candidate.id, candidate.url, candidate.title, index),
    candidateId: candidate.id,
    sourceCandidateId: candidate.id,
    title: candidate.title,
    author: candidate.author,
    sourceUrl: candidate.url,
    evidenceText,
    excerpt: evidenceText,
    reason: "rule_fallback_from_excerpt",
    normalizedClaim: truncateText(evidenceText, MAX_REASON_LENGTH),
    supportType,
    isExperienceEvidence,
    confidence
  };
}

function normalizeEvidenceArtifactData(
  data: EvidenceArtifactData,
  candidates: CandidateItem[]
): EvidenceArtifactData {
  const candidateById = new Map(candidates.map((candidate) => [candidate.id, candidate]));
  const evidenceItems = data.evidenceItems
    .slice(0, MAX_LLM_CANDIDATES)
    .map((item, index) => normalizeEvidenceItem(item, index, candidateById))
    .filter((item): item is EvidenceItem => Boolean(item));

  return {
    ...data,
    evidenceItems,
    qualityReport: buildEvidenceQualityReport(evidenceItems, candidateById)
  };
}

function normalizeEvidenceItem(
  item: EvidenceItem,
  index: number,
  candidateById: Map<string, CandidateItem>
): EvidenceItem | null {
  const candidateId = item.candidateId || item.sourceCandidateId;
  const candidate = candidateById.get(candidateId);
  if (!candidate) {
    return null;
  }

  const evidenceText = truncateText(item.evidenceText || candidate.excerpt, MAX_LLM_EVIDENCE_TEXT_LENGTH);
  const supportType = isEvidenceSupportType(item.supportType)
    ? item.supportType
    : inferSupportType(evidenceText, candidate);
  const confidence = calculateEvidenceConfidence(candidate, item.confidence);
  const isExperienceEvidence =
    typeof item.isExperienceEvidence === "boolean"
      ? item.isExperienceEvidence &&
        inferIsExperienceEvidence(candidate, supportType, confidence)
      : inferIsExperienceEvidence(candidate, supportType, confidence);

  return {
    id: buildEvidenceId(candidate.id, item.sourceUrl || candidate.url, item.title || candidate.title, index),
    candidateId: candidate.id,
    sourceCandidateId: candidate.id,
    title: truncateText(item.title || candidate.title, 120),
    author: truncateText(item.author || candidate.author, 80),
    sourceUrl: item.sourceUrl || candidate.url,
    evidenceText,
    excerpt: truncateText(item.excerpt || evidenceText, MAX_LLM_EVIDENCE_TEXT_LENGTH),
    reason: truncateText(item.reason || "llm_extracted_from_candidate", MAX_REASON_LENGTH),
    normalizedClaim: truncateText(item.normalizedClaim || item.reason || evidenceText, MAX_REASON_LENGTH),
    supportType,
    isExperienceEvidence,
    confidence
  };
}

function buildEvidenceQualityReport(
  evidenceItems: EvidenceItem[],
  candidateById: Map<string, CandidateItem>
): NonNullable<EvidenceArtifactData["qualityReport"]> {
  const lowConfidenceEvidenceIds = evidenceItems
    .filter((item) => item.confidence < MIN_EXPERIENCE_EVIDENCE_CONFIDENCE)
    .map((item) => item.id);
  const invalidCandidateEvidenceCount = evidenceItems.filter(
    (item) => !candidateById.has(item.sourceCandidateId)
  ).length;

  return {
    totalEvidenceCount: evidenceItems.length,
    experienceEvidenceCount: evidenceItems.filter((item) => item.isExperienceEvidence).length,
    lowConfidenceEvidenceIds,
    invalidCandidateEvidenceCount
  };
}

function inferSupportType(text: string, candidate: CandidateItem): EvidenceSupportType {
  const normalized = text.toLowerCase();
  if (candidate.experienceScore >= MIN_EXPERIENCE_EVIDENCE_SCORE && /我|本人|亲身|经历过|尝试过/.test(normalized)) {
    return "experience_fact";
  }
  if (/决定|选择|放弃|坚持|犹豫|权衡|要不要|是否/.test(normalized)) {
    return "decision_point";
  }
  if (/存款|房租|收入|家庭|父母|城市|时间|成本|压力|现实|约束/.test(normalized)) {
    return "constraint";
  }
  if (/焦虑|后悔|轻松|崩溃|迷茫|害怕|开心|难受|变化/.test(normalized)) {
    return "emotion_change";
  }
  if (/结果|最后|后来|发现|影响|换来|变成|失败|成功|复盘/.test(normalized)) {
    return "outcome";
  }
  if (/代价|风险|损失|预算|安全垫|现金流|回撤/.test(normalized)) {
    return "tradeoff";
  }
  if (/观点|认为|建议|应该|最好|方法|技巧/.test(normalized)) {
    return "opinion";
  }

  return "context";
}

function inferIsExperienceEvidence(
  candidate: CandidateItem,
  supportType: EvidenceSupportType,
  confidence: number
): boolean {
  return (
    candidate.experienceScore >= MIN_EXPERIENCE_EVIDENCE_SCORE &&
    hasStrongExperienceSignal(candidate) &&
    confidence >= MIN_EXPERIENCE_EVIDENCE_CONFIDENCE &&
    ["experience_fact", "decision_point", "emotion_change", "outcome"].includes(supportType)
  );
}

function hasStrongExperienceSignal(candidate: CandidateItem): boolean {
  return candidate.qualitySignals.some(
    (signal) =>
      signal.startsWith("experience:first_person") ||
      signal.startsWith("experience:timeline") ||
      signal.startsWith("experience:outcome_feedback") ||
      signal.startsWith("experience:non_template_expression")
  );
}

function calculateEvidenceConfidence(candidate: CandidateItem, rawConfidence: number): number {
  const normalizedRawConfidence = Number.isFinite(rawConfidence)
    ? Math.max(0, Math.min(1, rawConfidence))
    : 0.4;
  const candidateBound = Math.min(1, candidate.qualityScore + 0.1);
  const blended = normalizedRawConfidence * 0.6 + candidate.qualityScore * 0.25 + candidate.relevanceScore * 0.15;

  return clampScore(Math.min(blended, candidateBound));
}

function toGatewayCandidateMetadata(candidate: CandidateItem): Record<string, unknown> {
  return {
    id: candidate.id,
    type: candidate.type,
    title: candidate.title,
    author: candidate.author,
    sourceUrl: candidate.url,
    excerpt: truncateText(candidate.excerpt, MAX_EXCERPT_LENGTH),
    score: candidate.score,
    normalizedSearchScore: candidate.normalizedSearchScore,
    relevanceScore: candidate.relevanceScore,
    experienceScore: candidate.experienceScore,
    qualityScore: candidate.qualityScore,
    selectedForEvidence: candidate.selectedForEvidence
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
    (value.id === undefined || typeof value.id === "string") &&
    (value.sourceCandidateId === undefined || typeof value.sourceCandidateId === "string") &&
    typeof value.title === "string" &&
    typeof value.author === "string" &&
    typeof value.sourceUrl === "string" &&
    typeof value.evidenceText === "string" &&
    (value.excerpt === undefined || typeof value.excerpt === "string") &&
    typeof value.reason === "string" &&
    (value.normalizedClaim === undefined || typeof value.normalizedClaim === "string") &&
    (value.supportType === undefined || isEvidenceSupportType(value.supportType)) &&
    (value.isExperienceEvidence === undefined || typeof value.isExperienceEvidence === "boolean") &&
    typeof value.confidence === "number" &&
    Number.isFinite(value.confidence) &&
    value.confidence >= 0 &&
    value.confidence <= 1
  );
}

function buildEvidenceId(candidateId: string, sourceUrl: string, title: string, index: number): string {
  return `evidence_${hashSafeId(candidateId || sourceUrl || title)}_${index + 1}`;
}

function hashSafeId(value: string): string {
  const normalized = value.replace(/[^a-zA-Z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  return normalized.slice(0, 48) || "item";
}

function clampScore(value: number): number {
  return Math.min(Math.max(Number(value.toFixed(2)), 0), 1);
}

function isEvidenceSupportType(value: unknown): value is EvidenceSupportType {
  return (
    value === "experience_fact" ||
    value === "decision_point" ||
    value === "constraint" ||
    value === "emotion_change" ||
    value === "outcome" ||
    value === "tradeoff" ||
    value === "opinion" ||
    value === "context"
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
