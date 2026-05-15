import { config } from "../../config/env.js";
import { llmGateway } from "../../llm/llmGateway.js";
import { agentRepository } from "../agentRepository.js";
import {
  AGENT_ARTIFACT_GUARDED_FINAL_RESULT,
  AGENT_STAGE_GROUNDING_GUARD_LLM,
  type AgentStageOutput,
  type CandidateItem,
  type CandidatesArtifactData,
  type EvidenceArtifactData,
  type EvidenceItem,
  type FinalResultArtifactData,
  type GuardedFinalResultArtifactData,
  type GroundingGuardReport
} from "./stageTypes.js";

const MAX_LLM_CANDIDATES = 8;
const MAX_LLM_EVIDENCE_ITEMS = 12;
const MAX_EXCERPT_LENGTH = 280;
const MAX_EVIDENCE_TEXT_LENGTH = 240;

interface EvidenceInputItem extends EvidenceItem {
  id: string;
}

export async function runGroundingGuardLlmStage(
  taskId: string,
  finalResult: FinalResultArtifactData,
  candidates: CandidatesArtifactData,
  evidence: EvidenceArtifactData
): Promise<AgentStageOutput<GuardedFinalResultArtifactData>> {
  const limitedCandidates = candidates.candidates.slice(0, MAX_LLM_CANDIDATES);
  const limitedEvidence = evidence.evidenceItems
    .slice(0, MAX_LLM_EVIDENCE_ITEMS)
    .map(toEvidenceInputItem);

  const result = await llmGateway.runJson<GuardedFinalResultArtifactData>({
    stageName: AGENT_STAGE_GROUNDING_GUARD_LLM,
    provider: config.agent.llm.provider,
    model: config.agent.llm.model,
    messages: buildGroundingGuardMessages(finalResult, limitedCandidates, limitedEvidence),
    timeoutMs: config.agent.llm.timeoutMs,
    retries: config.agent.llm.retries,
    schemaName: "agent.guarded_final_result.v1",
    responseFormat: { type: "json_object" },
    validate: isGuardedFinalResultArtifactData,
    fallback: (context) =>
      buildGuardedFinalResultFallback(
        finalResult,
        limitedCandidates,
        limitedEvidence,
        context.fallbackReason
      ),
    metadata: {
      finalResult,
      candidateCount: limitedCandidates.length,
      evidenceCount: limitedEvidence.length,
      candidates: limitedCandidates.map(toGatewayCandidateMetadata),
      evidenceItems: limitedEvidence.map(toGatewayEvidenceMetadata)
    },
    maxTokens: 1800,
    temperature: 0.1,
    onEvent: async (type, payload) => {
      await agentRepository.createEvent({
        taskId,
        type,
        payload: { ...payload }
      });
    }
  });

  return {
    artifactType: AGENT_ARTIFACT_GUARDED_FINAL_RESULT,
    data: result.data,
    status: result.status === "success" ? "succeeded" : "fallback",
    fallbackUsed: result.fallbackUsed,
    fallbackReason: result.fallbackReason || null
  };
}

function buildGroundingGuardMessages(
  finalResult: FinalResultArtifactData,
  candidates: CandidateItem[],
  evidenceItems: EvidenceInputItem[]
) {
  return [
    {
      role: "system" as const,
      content:
        "你是事实边界和证据支撑校验器。只输出 JSON，不要输出解释。只能基于输入 final_result、candidates、evidenceItems 校验或轻量修正，不要新增事实，不要构造 AI 分身。"
    },
    {
      role: "user" as const,
      content: JSON.stringify({
        task: "校验 final_result 的路径、人物和追问是否有候选与证据支撑",
        outputShape: {
          schemaVersion: "agent.guarded_final_result.v1",
          result: finalResult,
          guard: {
            status: "passed",
            unsupportedClaims: [],
            removedItems: [],
            warnings: [],
            evidenceCoverage: 0.85
          },
          strategy: "llm_guarded",
          llmUsed: true
        },
        constraints: [
          "result.schemaVersion 必须保持 agent.final_result.v1",
          "如果 paths/people 引用不存在的 evidenceIds 或 candidateIds，应删除引用或降级该条目，并写入 guard.warnings",
          "不要新增输入之外的 evidenceIds 或 candidateIds",
          "不要生成新事实、作者身份推断、联系方式、私信建议或 AI 分身",
          "guard.status 只能是 passed、repaired 或 partial"
        ],
        finalResult,
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

function buildGuardedFinalResultFallback(
  finalResult: FinalResultArtifactData,
  candidates: CandidateItem[],
  evidenceItems: EvidenceInputItem[],
  fallbackReason: string
): GuardedFinalResultArtifactData {
  const warnings = buildRuleWarnings(finalResult, candidates, evidenceItems);

  return {
    schemaVersion: "agent.guarded_final_result.v1",
    result: finalResult,
    guard: {
      status: "fallback",
      unsupportedClaims: [],
      removedItems: [],
      warnings: ["grounding_guard fallback used", ...warnings],
      evidenceCoverage: null
    },
    strategy: "rule_fallback",
    llmUsed: false,
    fallbackReason
  };
}

function buildRuleWarnings(
  finalResult: FinalResultArtifactData,
  candidates: CandidateItem[],
  evidenceItems: EvidenceInputItem[]
): string[] {
  const warnings: string[] = [];
  const candidateIds = new Set(candidates.map((candidate) => candidate.id));
  const evidenceIds = new Set(evidenceItems.map((item) => item.id));

  finalResult.paths.forEach((path, index) => {
    const missingEvidence = path.evidenceIds.filter((id) => !evidenceIds.has(id));
    const missingCandidates = path.candidateIds.filter((id) => !candidateIds.has(id));
    if (missingEvidence.length > 0) {
      warnings.push(`paths[${index}].evidenceIds missing: ${missingEvidence.join(", ")}`);
    }
    if (missingCandidates.length > 0) {
      warnings.push(`paths[${index}].candidateIds missing: ${missingCandidates.join(", ")}`);
    }
  });

  finalResult.people.forEach((person, index) => {
    if (person.candidateId && !candidateIds.has(person.candidateId)) {
      warnings.push(`people[${index}].candidateId missing: ${person.candidateId}`);
    }
    const missingEvidence = person.evidenceIds.filter((id) => !evidenceIds.has(id));
    if (missingEvidence.length > 0) {
      warnings.push(`people[${index}].evidenceIds missing: ${missingEvidence.join(", ")}`);
    }
  });

  if (finalResult.paths.length > 0 && finalResult.paths.every((path) => path.evidenceIds.length === 0)) {
    warnings.push("paths have no evidenceIds");
  }
  if (finalResult.people.length > 0 && finalResult.people.every((person) => person.evidenceIds.length === 0)) {
    warnings.push("people have no evidenceIds");
  }

  return warnings;
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

function isGuardedFinalResultArtifactData(value: unknown): boolean {
  if (!isRecord(value)) {
    return false;
  }

  const strategy = value.strategy;
  return (
    value.schemaVersion === "agent.guarded_final_result.v1" &&
    isFinalResultArtifactData(value.result) &&
    isGroundingGuardReport(value.guard) &&
    (strategy === "llm_guarded" || strategy === "rule_fallback") &&
    typeof value.llmUsed === "boolean" &&
    (value.fallbackReason === undefined || typeof value.fallbackReason === "string")
  );
}

function isGroundingGuardReport(value: unknown): value is GroundingGuardReport {
  if (!isRecord(value)) {
    return false;
  }

  const status = value.status;
  return (
    (status === "passed" || status === "repaired" || status === "partial" || status === "fallback") &&
    isStringArray(value.unsupportedClaims) &&
    isStringArray(value.removedItems) &&
    isStringArray(value.warnings) &&
    (value.evidenceCoverage === null ||
      (typeof value.evidenceCoverage === "number" &&
        Number.isFinite(value.evidenceCoverage) &&
        value.evidenceCoverage >= 0 &&
        value.evidenceCoverage <= 1))
  );
}

function isFinalResultArtifactData(value: unknown): value is FinalResultArtifactData {
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
    isStringArray(value.suggestedQuestions) &&
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
