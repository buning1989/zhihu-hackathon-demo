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
const CHUNK_CANDIDATE_COUNT = 2;
const MAX_EVIDENCE_PER_CHUNK = 2;
const MAX_EXCERPT_LENGTH = 180;
const MAX_EVIDENCE_TEXT_LENGTH = 320;
const MAX_LLM_EVIDENCE_TEXT_LENGTH = 96;
const MAX_REASON_LENGTH = 60;
const MIN_EXPERIENCE_EVIDENCE_SCORE = 0.38;
const MIN_EXPERIENCE_EVIDENCE_CONFIDENCE = 0.45;
const MAX_STAGE_FAILURE_RATIO = 0.5;
const MAX_EVIDENCE_FACET_LENGTH = 80;
const MIN_BACKFILL_RELEVANCE_SCORE = 0.34;
export const AGENT_EVIDENCE_EXTRACTION_VERSION = "agent.evidence_extract.v5.structured_grounded_samples";

interface EvidenceChunkStats {
  chunkCount: number;
  chunkSuccessCount: number;
  chunkFailureCount: number;
  repairCount: number;
  retryCount: number;
  chunkFailureReasons: string[];
}

interface EvidenceChunkResult {
  data: EvidenceArtifactData;
  status: "succeeded" | "degraded";
  fallbackUsed: boolean;
  fallbackReason: string | null;
  stats: EvidenceChunkStats;
}

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
  const result = await runChunkedEvidenceExtraction({
    taskId,
    candidates: limitedCandidates,
    searchPlan,
    intent,
    originalQuery
  });

  return {
    artifactType: AGENT_ARTIFACT_EVIDENCE,
    data: result.data,
    status: result.status,
    fallbackUsed: result.fallbackUsed,
    fallbackReason: result.fallbackReason
  };
}

async function runChunkedEvidenceExtraction(input: {
  taskId: string;
  candidates: CandidateItem[];
  searchPlan?: SearchPlanArtifactData;
  intent?: IntentArtifactData;
  originalQuery: string;
}): Promise<EvidenceChunkResult> {
  const chunks = chunkCandidates(input.candidates);
  const stats: EvidenceChunkStats = {
    chunkCount: chunks.length,
    chunkSuccessCount: 0,
    chunkFailureCount: 0,
    repairCount: 0,
    retryCount: 0,
    chunkFailureReasons: []
  };
  const evidenceItems: EvidenceItem[] = [];
  let anyLlmSuccess = false;

  for (const [chunkIndex, chunk] of chunks.entries()) {
    const chunkResult = await runEvidenceChunk(input, chunk, chunkIndex, false);
    const normalized = normalizeChunkResult(chunkResult.data, chunk, evidenceItems.length);
    let chunkEvidenceItems = chunkResult.status === "success" ? normalized.evidenceItems : [];
    let repaired = false;
    let fallbackReason = chunkResult.fallbackReason || null;

    if (chunkResult.errorType === "JSON_PARSE_FAILED" || chunkResult.errorType === "SCHEMA_VALIDATION_FAILED") {
      const repairedData = repairEvidenceChunkFromRawText(chunkResult.rawText, chunk);
      if (repairedData.evidenceItems.length > 0) {
        const repairedNormalized = normalizeChunkResult(repairedData, chunk, evidenceItems.length);
        chunkEvidenceItems = repairedNormalized.evidenceItems;
        repaired = true;
        anyLlmSuccess = true;
        stats.repairCount += 1;
        fallbackReason = null;
      } else if (shouldRetryChunk(chunkResult)) {
        stats.retryCount += 1;
        const retryResult = await runEvidenceChunk(input, chunk, chunkIndex, true);
        fallbackReason = retryResult.fallbackReason || null;
        const retryNormalized = normalizeChunkResult(retryResult.data, chunk, evidenceItems.length);
        chunkEvidenceItems = retryResult.status === "success" ? retryNormalized.evidenceItems : [];
        if (retryResult.status === "success") {
          anyLlmSuccess = true;
          fallbackReason = null;
        } else if (
          retryResult.errorType === "JSON_PARSE_FAILED" ||
          retryResult.errorType === "SCHEMA_VALIDATION_FAILED"
        ) {
          const retryRepair = repairEvidenceChunkFromRawText(retryResult.rawText, chunk);
          if (retryRepair.evidenceItems.length > 0) {
            const retryRepairedNormalized = normalizeChunkResult(retryRepair, chunk, evidenceItems.length);
            chunkEvidenceItems = retryRepairedNormalized.evidenceItems;
            repaired = true;
            anyLlmSuccess = true;
            stats.repairCount += 1;
            fallbackReason = null;
          }
        }
      }
    } else if (chunkResult.status === "success") {
      anyLlmSuccess = true;
    }

    if (chunkEvidenceItems.length > 0) {
      const remainingBudget = Math.max(MAX_LLM_CANDIDATES - evidenceItems.length - chunkEvidenceItems.length, 0);
      const backfillEvidenceItems = buildBackfillEvidenceForUncoveredCandidates(
        chunk,
        chunkEvidenceItems,
        evidenceItems.length + chunkEvidenceItems.length,
        remainingBudget
      );
      evidenceItems.push(...chunkEvidenceItems, ...backfillEvidenceItems);
      stats.chunkSuccessCount += 1;
      continue;
    }

    stats.chunkFailureCount += 1;
    stats.chunkFailureReasons.push(fallbackReason || "chunk produced no valid evidence");

    if (!repaired) {
      const fallback = buildEvidenceFallback(chunk, fallbackReason || "chunk evidence extraction failed");
      const normalizedFallback = normalizeChunkResult(fallback, chunk, evidenceItems.length);
      evidenceItems.push(...normalizedFallback.evidenceItems);
    }
  }

  const limitedEvidenceItems = evidenceItems.slice(0, MAX_LLM_CANDIDATES);
  const candidateById = new Map(input.candidates.map((candidate) => [candidate.id, candidate]));
  const qualityReport = buildEvidenceQualityReport(limitedEvidenceItems, candidateById, stats);
  const failureRatio = stats.chunkCount > 0 ? stats.chunkFailureCount / stats.chunkCount : 0;
  const mostlyFailed = failureRatio > MAX_STAGE_FAILURE_RATIO;
  const fallbackReasons = uniqueNonEmpty(stats.chunkFailureReasons);
  const stageDegraded = mostlyFailed || !anyLlmSuccess;

  return {
    status: stageDegraded ? "degraded" : "succeeded",
    fallbackUsed: mostlyFailed || !anyLlmSuccess,
    fallbackReason:
      stageDegraded
        ? uniqueNonEmpty([
            !anyLlmSuccess ? "NO_LLM_CHUNK_SUCCEEDED" : "",
            mostlyFailed ? "EVIDENCE_CHUNK_MOSTLY_FAILED" : "",
            ...fallbackReasons
          ]).join("; ")
        : null,
    stats,
    data: {
      evidenceItems: limitedEvidenceItems,
      qualityReport,
      strategy: anyLlmSuccess ? "llm_extracted" : "rule_fallback",
      llmUsed: anyLlmSuccess,
      ...(mostlyFailed || fallbackReasons.length > 0
        ? { fallbackReason: uniqueNonEmpty([mostlyFailed ? "EVIDENCE_CHUNK_MOSTLY_FAILED" : "", ...fallbackReasons]).join("; ") }
        : {})
    }
  };
}

async function runEvidenceChunk(
  input: {
    taskId: string;
    candidates: CandidateItem[];
    searchPlan?: SearchPlanArtifactData;
    intent?: IntentArtifactData;
    originalQuery: string;
  },
  chunk: CandidateItem[],
  chunkIndex: number,
  retry: boolean
) {
  return llmGateway.runJson<EvidenceArtifactData>({
    stageName: AGENT_STAGE_EVIDENCE_EXTRACT_LLM,
    provider: config.agent.llm.provider,
    model: config.agent.llm.model,
    messages: buildEvidenceExtractMessages(chunk, input.searchPlan, input.intent, {
      chunkIndex,
      retry
    }),
    timeoutMs: config.agent.llm.timeoutMs,
    retries: retry ? 0 : config.agent.llm.retries,
    schemaName: "agent.evidence.v1",
    responseFormat: { type: "json_object" },
    validate: isEvidenceArtifactData,
    fallback: (context) => buildEvidenceFallback(chunk, context.fallbackReason),
    metadata: {
      originalQuery: input.originalQuery,
      candidateCount: chunk.length,
      candidateIds: chunk.map((candidate) => candidate.id),
      evidenceExtractionVersion: AGENT_EVIDENCE_EXTRACTION_VERSION,
      chunkIndex,
      retry,
      candidates: chunk.map(toGatewayCandidateMetadata)
    },
    maxTokens: retry ? 700 : 900,
    temperature: 0,
    onEvent: async (type, payload) => {
      await agentRepository.createEvent({
        taskId: input.taskId,
        type,
        payload: {
          ...payload,
          chunkIndex,
          chunkCandidateIds: chunk.map((candidate) => candidate.id),
          retry
        }
      });
    }
  });
}

function buildEvidenceExtractMessages(
  candidates: CandidateItem[],
  searchPlan?: SearchPlanArtifactData,
  intent?: IntentArtifactData,
  options: { chunkIndex: number; retry: boolean } = { chunkIndex: 0, retry: false }
) {
  return [
    {
      role: "system" as const,
      content:
        "你是证据片段抽取器。只输出极简 JSON object。只能复制候选中的短证据，不要总结，不要编造，不要输出 Markdown。"
    },
    {
      role: "user" as const,
      content: JSON.stringify({
        task: "从本片候选中抽取可支撑用户问题的短证据",
        chunkIndex: options.chunkIndex,
        retry: options.retry,
        outputShape: {
          evidenceItems: [
            {
              id: "string",
              candidateId: "string",
              sourceCandidateId: "string",
              evidenceText: "不超过60字",
              excerpt: "不超过60字",
              normalizedClaim: "不超过40字",
              supportType: "experience_fact",
              isExperienceEvidence: true,
              confidence: 0.78,
              situation: "片段中出现的处境",
              choice: "片段中出现的选择",
              process: "片段中出现的过程",
              outcome: "片段中出现的结果",
              costOrRisk: "片段中出现的代价或风险",
              takeaway: "对当前问题的参考价值"
            }
          ],
          strategy: "llm_extracted",
          llmUsed: true
        },
        constraints: [
          `本片最多返回 ${MAX_EVIDENCE_PER_CHUNK} 条 evidenceItems，证据不足时返回更少条`,
          "每个 candidate 最多 1 条 evidence",
          "如果本片多个 candidate 都有清晰证据，优先各返回 1 条，不要遗漏合格证据",
          "evidenceText 必须直接摘自 candidate.excerpt 或 title 的可见信息",
          "evidenceText 和 excerpt 都不超过 60 个中文字符",
          "normalizedClaim 用 8 到 40 个中文字符概括这条证据支持的具体点",
          "不要输出 title、author、sourceUrl、reason；后端会补齐",
          "situation/choice/process/outcome/costOrRisk/takeaway 只能基于 evidenceText 或 candidate.excerpt 里的明确信息，缺失就用空字符串",
          "不要为了补齐字段而编造人物故事；不能把观点作者包装成亲历者",
          "supportType 只能是 experience_fact、decision_point、constraint、emotion_change、outcome、tradeoff、opinion、context 之一",
          "只有候选确实包含亲历、时间线、决策、约束、情绪变化、结果反馈或代价描述时，isExperienceEvidence 才能为 true",
          "纯观点、鸡汤、营销导流、套话或过短信号不能作为 isExperienceEvidence=true",
          "所有字符串必须是单行文本，不要包含换行符",
          "confidence 必须在 0 到 1 之间",
          "必须返回完整 JSON object，缺证据时返回 {\"evidenceItems\":[],\"strategy\":\"llm_extracted\",\"llmUsed\":true}",
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
          title: truncateText(candidate.title, 80),
          excerpt: truncateText(candidate.excerpt, MAX_EXCERPT_LENGTH),
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

function chunkCandidates(candidates: CandidateItem[]): CandidateItem[][] {
  const chunks: CandidateItem[][] = [];
  for (let index = 0; index < candidates.length; index += CHUNK_CANDIDATE_COUNT) {
    chunks.push(candidates.slice(index, index + CHUNK_CANDIDATE_COUNT));
  }

  return chunks;
}

function toFallbackEvidenceItem(candidate: CandidateItem, index: number): EvidenceItem {
  const evidenceText =
    truncateText(candidate.excerpt, MAX_EVIDENCE_TEXT_LENGTH) ||
    "使用 candidate.excerpt 作为规则证据";
  const supportType = inferSupportType(evidenceText, candidate);
  const confidence = calculateEvidenceConfidence(candidate, 0.5);
  const isExperienceEvidence = inferIsExperienceEvidence(candidate, supportType, confidence);
  const facets = buildEvidenceFacets(evidenceText, candidate, supportType);

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
    confidence,
    ...facets
  };
}

function buildBackfillEvidenceForUncoveredCandidates(
  candidates: CandidateItem[],
  evidenceItems: EvidenceItem[],
  startIndex: number,
  maxItems: number
): EvidenceItem[] {
  if (maxItems <= 0) {
    return [];
  }

  const coveredCandidateIds = new Set(evidenceItems.map((item) => item.candidateId));
  return candidates
    .filter((candidate) => !coveredCandidateIds.has(candidate.id))
    .filter(shouldBackfillCandidateEvidence)
    .slice(0, maxItems)
    .map((candidate, index) => toFallbackEvidenceItem(candidate, startIndex + index));
}

function shouldBackfillCandidateEvidence(candidate: CandidateItem): boolean {
  return (
    candidate.selectedForEvidence &&
    candidate.qualityScore >= 0.45 &&
    candidate.relevanceScore >= MIN_BACKFILL_RELEVANCE_SCORE &&
    candidate.excerpt.trim().replace(/\s+/g, " ").length >= 60
  );
}

function normalizeChunkResult(
  data: EvidenceArtifactData,
  candidates: CandidateItem[],
  startIndex: number
): EvidenceArtifactData {
  const candidateById = new Map(candidates.map((candidate) => [candidate.id, candidate]));
  const evidenceItems = data.evidenceItems
    .slice(0, MAX_EVIDENCE_PER_CHUNK)
    .map((item, index) => normalizeEvidenceItem(item, startIndex + index, candidateById))
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
  const fallbackFacets = buildEvidenceFacets(evidenceText, candidate, supportType);

  return {
    id: buildEvidenceId(candidate.id, item.sourceUrl || candidate.url, item.title || candidate.title, index),
    candidateId: candidate.id,
    sourceCandidateId: candidate.id,
    title: truncateText(item.title || candidate.title, 120),
    author: truncateText(item.author || candidate.author, 80),
    sourceUrl: item.sourceUrl || candidate.url,
    evidenceText,
    excerpt: truncateText(item.excerpt || evidenceText, MAX_LLM_EVIDENCE_TEXT_LENGTH),
    reason: truncateText(item.reason || item.normalizedClaim || evidenceText, MAX_REASON_LENGTH),
    normalizedClaim: truncateText(item.normalizedClaim || item.reason || evidenceText, MAX_REASON_LENGTH),
    supportType,
    isExperienceEvidence,
    confidence,
    situation: truncateText(item.situation || fallbackFacets.situation || "", MAX_EVIDENCE_FACET_LENGTH),
    choice: truncateText(item.choice || fallbackFacets.choice || "", MAX_EVIDENCE_FACET_LENGTH),
    process: truncateText(item.process || fallbackFacets.process || "", MAX_EVIDENCE_FACET_LENGTH),
    outcome: truncateText(item.outcome || fallbackFacets.outcome || "", MAX_EVIDENCE_FACET_LENGTH),
    costOrRisk: truncateText(item.costOrRisk || fallbackFacets.costOrRisk || "", MAX_EVIDENCE_FACET_LENGTH),
    takeaway: truncateText(item.takeaway || fallbackFacets.takeaway || "", MAX_EVIDENCE_FACET_LENGTH)
  };
}

function repairEvidenceChunkFromRawText(
  rawText: string,
  candidates: CandidateItem[]
): EvidenceArtifactData {
  if (!rawText.trim()) {
    return buildEmptyLlmEvidenceArtifact();
  }

  const parsed = parseJsonCandidate(rawText);
  if (isEvidenceArtifactData(parsed)) {
    return parsed as EvidenceArtifactData;
  }

  const repairedItems = extractEvidenceItemsFromPartialJson(rawText);
  const candidateIds = new Set(candidates.map((candidate) => candidate.id));
  const evidenceItems = repairedItems
    .filter((item) => candidateIds.has(readString(item.candidateId) || readString(item.sourceCandidateId)))
    .slice(0, MAX_EVIDENCE_PER_CHUNK)
    .map((item, index) => ({
      id: readString(item.id) || `repaired_evidence_${index + 1}`,
      candidateId: readString(item.candidateId) || readString(item.sourceCandidateId),
      sourceCandidateId: readString(item.sourceCandidateId) || readString(item.candidateId),
      title: readString(item.title),
      author: readString(item.author),
      sourceUrl: readString(item.sourceUrl),
      evidenceText: readString(item.evidenceText) || readString(item.excerpt),
      excerpt: readString(item.excerpt) || readString(item.evidenceText),
      reason: readString(item.reason),
      normalizedClaim: readString(item.normalizedClaim),
      supportType: isEvidenceSupportType(item.supportType) ? item.supportType : "context",
      isExperienceEvidence: readBoolean(item.isExperienceEvidence),
      confidence: readNumber(item.confidence, 0.5),
      situation: readString(item.situation),
      choice: readString(item.choice),
      process: readString(item.process),
      outcome: readString(item.outcome),
      costOrRisk: readString(item.costOrRisk),
      takeaway: readString(item.takeaway)
    }))
    .filter(isEvidenceItem) as EvidenceItem[];

  return {
    evidenceItems,
    strategy: "llm_extracted",
    llmUsed: true
  };
}

function parseJsonCandidate(rawText: string): unknown {
  try {
    return JSON.parse(stripJsonCodeFence(rawText));
  } catch {
    return undefined;
  }
}

function stripJsonCodeFence(rawText: string): string {
  return rawText
    .trim()
    .replace(/^```(?:json)?/i, "")
    .replace(/```$/i, "")
    .trim();
}

function extractEvidenceItemsFromPartialJson(rawText: string): Record<string, unknown>[] {
  const arrayStart = rawText.indexOf("[");
  if (arrayStart < 0) {
    return [];
  }

  const items: Record<string, unknown>[] = [];
  let depth = 0;
  let inString = false;
  let escaped = false;
  let objectStart = -1;

  for (let index = arrayStart; index < rawText.length; index += 1) {
    const char = rawText[index];

    if (escaped) {
      escaped = false;
      continue;
    }

    if (char === "\\") {
      escaped = true;
      continue;
    }

    if (char === "\"") {
      inString = !inString;
      continue;
    }

    if (inString) {
      continue;
    }

    if (char === "{") {
      if (depth === 0) {
        objectStart = index;
      }
      depth += 1;
      continue;
    }

    if (char === "}") {
      depth -= 1;
      if (depth === 0 && objectStart >= 0) {
        const objectText = rawText.slice(objectStart, index + 1);
        const parsed = parseJsonCandidate(objectText);
        if (isRecord(parsed)) {
          items.push(parsed);
        }
        objectStart = -1;
      }
    }
  }

  return items;
}

function buildEmptyLlmEvidenceArtifact(): EvidenceArtifactData {
  return {
    evidenceItems: [],
    strategy: "llm_extracted",
    llmUsed: true
  };
}

function shouldRetryChunk(result: {
  errorType?: string;
  rawText: string;
}): boolean {
  return Boolean(
    result.errorType === "JSON_PARSE_FAILED" ||
      result.errorType === "SCHEMA_VALIDATION_FAILED" ||
      (result.errorType && !result.rawText)
  );
}

function buildEvidenceQualityReport(
  evidenceItems: EvidenceItem[],
  candidateById: Map<string, CandidateItem>,
  stats?: EvidenceChunkStats
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
    invalidCandidateEvidenceCount,
    ...(stats
      ? {
          chunkCount: stats.chunkCount,
          chunkSuccessCount: stats.chunkSuccessCount,
          chunkFailureCount: stats.chunkFailureCount,
          repairCount: stats.repairCount,
          retryCount: stats.retryCount,
          chunkFailureReasons: stats.chunkFailureReasons
        }
      : {})
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

function buildEvidenceFacets(
  evidenceText: string,
  candidate: CandidateItem,
  supportType: EvidenceSupportType
): Pick<EvidenceItem, "situation" | "choice" | "process" | "outcome" | "costOrRisk" | "takeaway"> {
  const text = truncateText(evidenceText || candidate.excerpt || candidate.title, MAX_EVIDENCE_FACET_LENGTH);
  const title = truncateText(candidate.title, 48);
  const hasDecisionSignal = /决定|选择|放弃|坚持|犹豫|权衡|要不要|是否|转行|异地|不工作|裸辞|失业/.test(evidenceText);
  const hasCostSignal = /代价|风险|损失|预算|安全垫|现金流|成本|压力|现实|收入|工资|见面|年龄/.test(evidenceText);
  const hasOutcomeSignal = /结果|最后|后来|发现|影响|换来|变成|失败|成功|满意|不担心|着急/.test(evidenceText);

  return {
    situation: text,
    choice: hasDecisionSignal ? text : "",
    process: supportType === "constraint" || supportType === "context" ? text : "",
    outcome: hasOutcomeSignal || supportType === "outcome" ? text : "",
    costOrRisk: hasCostSignal || supportType === "tradeoff" ? text : "",
    takeaway: title ? `可作为「${title}」中的公开内容样本对照。` : "可作为公开内容样本对照。"
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
    (value.title === undefined || typeof value.title === "string") &&
    (value.author === undefined || typeof value.author === "string") &&
    (value.sourceUrl === undefined || typeof value.sourceUrl === "string") &&
    typeof value.evidenceText === "string" &&
    (value.excerpt === undefined || typeof value.excerpt === "string") &&
    (value.reason === undefined || typeof value.reason === "string") &&
    (value.normalizedClaim === undefined || typeof value.normalizedClaim === "string") &&
    (value.supportType === undefined || isEvidenceSupportType(value.supportType)) &&
    (value.isExperienceEvidence === undefined || typeof value.isExperienceEvidence === "boolean") &&
    typeof value.confidence === "number" &&
    Number.isFinite(value.confidence) &&
    value.confidence >= 0 &&
    value.confidence <= 1 &&
    (value.situation === undefined || typeof value.situation === "string") &&
    (value.choice === undefined || typeof value.choice === "string") &&
    (value.process === undefined || typeof value.process === "string") &&
    (value.outcome === undefined || typeof value.outcome === "string") &&
    (value.costOrRisk === undefined || typeof value.costOrRisk === "string") &&
    (value.takeaway === undefined || typeof value.takeaway === "string")
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

function readString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function readNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function readBoolean(value: unknown): boolean {
  return typeof value === "boolean" ? value : false;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
