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
const MIN_FINAL_CANDIDATE_QUALITY_SCORE = 0.45;
const MIN_FINAL_EVIDENCE_CONFIDENCE = 0.35;

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
    maxTokens: 2600,
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
    data: applyDeterministicQualityReport(result.data, finalResult, limitedCandidates, limitedEvidence),
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
          "qualityScore 低于阈值的 candidate 不能作为最终 paths/people 的支撑",
          "persona 必须至少有一条 isExperienceEvidence=true 的 evidence",
          "低 confidence evidence 不能支撑强结论",
          "如果只是保守措辞、样本归纳表达或证据有限提示，但未删除/修改 paths/people/evidenceIds/candidateIds，则 guard.status 保持 passed，只写 warnings",
          "只有删除 path/person、修复 evidenceIds/candidateIds 或移除不被证据支撑的强结论时，guard.status 才能是 repaired",
          "不要把“公开样本不能推出唯一答案”这类保守边界句当作 unsupported claim",
          "自我状态、低谷、焦虑、内耗相关内容不得保留心理治疗、诊断、药物、咨询师或医疗建议",
          "必须输出完整 JSON object，不要截断，不要输出 Markdown",
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
          score: candidate.score,
          normalizedSearchScore: candidate.normalizedSearchScore,
          relevanceScore: candidate.relevanceScore,
          experienceScore: candidate.experienceScore,
          qualityScore: candidate.qualityScore,
          selectedForEvidence: candidate.selectedForEvidence,
          qualitySignals: candidate.qualitySignals
        })),
        evidenceItems: evidenceItems.map((item) => ({
          id: item.id,
          candidateId: item.candidateId,
          sourceCandidateId: item.sourceCandidateId,
          title: truncateText(item.title, 120),
          author: truncateText(item.author, 80),
          sourceUrl: item.sourceUrl,
          evidenceText: truncateText(item.evidenceText, MAX_EVIDENCE_TEXT_LENGTH),
          reason: truncateText(item.reason, 160),
          normalizedClaim: item.normalizedClaim,
          supportType: item.supportType,
          isExperienceEvidence: item.isExperienceEvidence,
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

function applyDeterministicQualityReport(
  data: GuardedFinalResultArtifactData,
  originalFinalResult: FinalResultArtifactData,
  candidates: CandidateItem[],
  evidenceItems: EvidenceInputItem[]
): GuardedFinalResultArtifactData {
  const repair = repairFinalResultWithDeterministicRules(data.result, candidates, evidenceItems);
  const deterministicWarnings = buildRuleWarnings(repair.result, candidates, evidenceItems);
  const qualityReport = buildDeterministicQualityReport(repair.result, candidates, evidenceItems);
  const warnings = uniqueNonEmpty([
    ...data.guard.warnings,
    ...repair.warnings,
    ...deterministicWarnings
  ]);
  const removedItems = uniqueNonEmpty([...data.guard.removedItems, ...repair.removedItems]);
  const hardRepairReasons = uniqueNonEmpty([
    ...classifyRemovedItems(data.guard.removedItems),
    ...repair.hardRepairReasons,
    hasReferenceChange(originalFinalResult, data.result) ? "source_refs_repaired" : "",
    data.guard.status === "fallback" ? "llm_guard_fallback" : ""
  ]);
  const softWarningReasons = uniqueNonEmpty([
    ...warnings.map(classifyGroundingWarning).filter((reason) => !hardRepairReasons.includes(reason)),
    data.guard.status !== "passed" && hardRepairReasons.length === 0
      ? "llm_guard_overconservative"
      : ""
  ]);
  const status =
    data.guard.status === "fallback"
      ? "fallback"
      : hardRepairReasons.length > 0
        ? "repaired"
        : "passed";
  const repairReasonCounts = countReasons([...hardRepairReasons, ...softWarningReasons]);

  return {
    ...data,
    result: repair.result,
    guard: {
      ...data.guard,
      status,
      removedItems,
      warnings,
      hardRepairReasons,
      softWarningReasons,
      repairReasonCounts,
      deterministicQualityReport: qualityReport
    }
  };
}

function repairFinalResultWithDeterministicRules(
  finalResult: FinalResultArtifactData,
  candidates: CandidateItem[],
  evidenceItems: EvidenceInputItem[]
): {
  result: FinalResultArtifactData;
  removedItems: string[];
  warnings: string[];
  hardRepairReasons: string[];
} {
  const candidateById = new Map(candidates.map((candidate) => [candidate.id, candidate]));
  const evidenceById = new Map(evidenceItems.map((item) => [item.id, item]));
  const removedItems: string[] = [];
  const warnings: string[] = [];
  const hardRepairReasons: string[] = [];
  const paths = finalResult.paths.flatMap((path, index) => {
    if (isOvergeneralizedPathSummary(path.summary)) {
      removedItems.push(`paths[${index}]`);
      warnings.push(`paths[${index}] removed for overgeneralized or advice-like summary`);
      hardRepairReasons.push("path_summary_overgeneralized");
      return [];
    }

    const validEvidenceIds = path.evidenceIds.filter((id) => !isLowConfidenceEvidence(evidenceById.get(id)));
    const validCandidateIds = uniqueNonEmpty([
      ...path.candidateIds.filter((id) => !isLowQualityCandidate(candidateById.get(id))),
      ...validEvidenceIds
        .map((id) => evidenceById.get(id)?.candidateId ?? "")
        .filter((id) => !isLowQualityCandidate(candidateById.get(id)))
    ]);

    if (validEvidenceIds.length === 0 || validCandidateIds.length === 0) {
      removedItems.push(`paths[${index}]`);
      warnings.push(`paths[${index}] removed by deterministic quality rules`);
      hardRepairReasons.push(validEvidenceIds.length === 0 ? "evidence_support_weak" : "source_refs_repaired");
      return [];
    }

    if (
      validEvidenceIds.length !== path.evidenceIds.length ||
      validCandidateIds.length !== path.candidateIds.length
    ) {
      warnings.push(`paths[${index}] repaired by deterministic quality rules`);
      hardRepairReasons.push("source_refs_repaired");
    }

    return [
      {
        ...path,
        evidenceIds: validEvidenceIds,
        candidateIds: validCandidateIds
      }
    ];
  });
  const people = finalResult.people.flatMap((person, index) => {
    const candidate = candidateById.get(person.candidateId);
    const validExperienceEvidenceIds = person.evidenceIds.filter((id) => {
      const evidence = evidenceById.get(id);
      return (
        evidence?.candidateId === person.candidateId &&
        !isLowConfidenceEvidence(evidence) &&
        evidence.isExperienceEvidence
      );
    });

    if (isLowQualityCandidate(candidate) || validExperienceEvidenceIds.length === 0) {
      removedItems.push(`people[${index}]`);
      warnings.push(`people[${index}] removed by deterministic quality rules`);
      hardRepairReasons.push(
        validExperienceEvidenceIds.length === 0 ? "persona_evidence_insufficient" : "evidence_support_weak"
      );
      return [];
    }

    if (validExperienceEvidenceIds.length !== person.evidenceIds.length) {
      warnings.push(`people[${index}] repaired by deterministic quality rules`);
      hardRepairReasons.push("persona_evidence_insufficient");
    }

    return [
      {
        ...person,
        evidenceIds: validExperienceEvidenceIds
      }
    ];
  });

  return {
    result: {
      ...finalResult,
      paths,
      people
    },
    removedItems,
    warnings,
    hardRepairReasons: uniqueNonEmpty(hardRepairReasons)
  };
}

function buildRuleWarnings(
  finalResult: FinalResultArtifactData,
  candidates: CandidateItem[],
  evidenceItems: EvidenceInputItem[]
): string[] {
  const warnings: string[] = [];
  const candidateById = new Map(candidates.map((candidate) => [candidate.id, candidate]));
  const evidenceById = new Map(evidenceItems.map((item) => [item.id, item]));

  finalResult.paths.forEach((path, index) => {
    const missingEvidence = path.evidenceIds.filter((id) => !evidenceById.has(id));
    const missingCandidates = path.candidateIds.filter((id) => !candidateById.has(id));
    const lowQualityCandidates = path.candidateIds.filter((id) => isLowQualityCandidate(candidateById.get(id)));
    const lowConfidenceEvidence = path.evidenceIds.filter((id) => isLowConfidenceEvidence(evidenceById.get(id)));
    if (missingEvidence.length > 0) {
      warnings.push(`paths[${index}].evidenceIds missing: ${missingEvidence.join(", ")}`);
    }
    if (missingCandidates.length > 0) {
      warnings.push(`paths[${index}].candidateIds missing: ${missingCandidates.join(", ")}`);
    }
    if (lowQualityCandidates.length > 0) {
      warnings.push(`paths[${index}].candidateIds low quality: ${lowQualityCandidates.join(", ")}`);
    }
    if (lowConfidenceEvidence.length > 0) {
      warnings.push(`paths[${index}].evidenceIds low confidence: ${lowConfidenceEvidence.join(", ")}`);
    }
  });

  finalResult.people.forEach((person, index) => {
    const personEvidence = person.evidenceIds
      .map((id) => evidenceById.get(id))
      .filter((item): item is EvidenceInputItem => Boolean(item));

    if (person.candidateId && !candidateById.has(person.candidateId)) {
      warnings.push(`people[${index}].candidateId missing: ${person.candidateId}`);
    }
    if (isLowQualityCandidate(candidateById.get(person.candidateId))) {
      warnings.push(`people[${index}].candidateId low quality: ${person.candidateId}`);
    }
    const missingEvidence = person.evidenceIds.filter((id) => !evidenceById.has(id));
    const lowConfidenceEvidence = person.evidenceIds.filter((id) => isLowConfidenceEvidence(evidenceById.get(id)));
    if (missingEvidence.length > 0) {
      warnings.push(`people[${index}].evidenceIds missing: ${missingEvidence.join(", ")}`);
    }
    if (lowConfidenceEvidence.length > 0) {
      warnings.push(`people[${index}].evidenceIds low confidence: ${lowConfidenceEvidence.join(", ")}`);
    }
    if (!personEvidence.some((item) => item.isExperienceEvidence)) {
      warnings.push(`people[${index}] has no experience evidence`);
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

function classifyRemovedItems(items: string[]): string[] {
  return items.map((item) => {
    if (/people|persona/i.test(item)) {
      return "persona_evidence_insufficient";
    }
    if (/path/i.test(item)) {
      return "evidence_support_weak";
    }
    return "source_refs_repaired";
  });
}

function classifyGroundingWarning(value: string): string {
  const normalized = value.toLowerCase();
  if (/overgeneralized|advice-like|unsupported|泛化|强建议|summary/.test(normalized)) {
    return "path_summary_overgeneralized";
  }
  if (/low confidence|below confidence|confidence/.test(normalized)) {
    return "evidence_support_weak";
  }
  if (/missing|candidateids|evidenceids|sourcecandidateid|source ref|sourceref/.test(normalized)) {
    return "source_refs_repaired";
  }
  if (/people|persona|experience evidence|真实经历/.test(normalized)) {
    return "persona_evidence_insufficient";
  }
  if (/evidence|quality|support/.test(normalized)) {
    return "evidence_support_weak";
  }
  if (/低谷|焦虑|内耗|自我状态/.test(value)) {
    return "self_state_lacks_experience_evidence";
  }
  return "llm_guard_overconservative";
}

function hasReferenceChange(before: FinalResultArtifactData, after: FinalResultArtifactData): boolean {
  return JSON.stringify(toReferenceSignature(before)) !== JSON.stringify(toReferenceSignature(after));
}

function toReferenceSignature(result: FinalResultArtifactData) {
  return {
    paths: result.paths.map((path) => ({
      evidenceIds: [...path.evidenceIds].sort(),
      candidateIds: [...path.candidateIds].sort()
    })),
    people: result.people.map((person) => ({
      candidateId: person.candidateId,
      evidenceIds: [...person.evidenceIds].sort()
    }))
  };
}

function isOvergeneralizedPathSummary(summary: string): boolean {
  return /你应该|应该|建议你|最好|一定要|你一定|只要.+就|方法|策略|重要性|意志力|心理治疗|心理咨询|咨询师|药物|看医生|诊断|抑郁症|焦虑症/.test(
    summary
  );
}

function countReasons(values: string[]): Record<string, number> {
  return values.reduce<Record<string, number>>((result, value) => {
    result[value] = (result[value] ?? 0) + 1;
    return result;
  }, {});
}

function buildDeterministicQualityReport(
  finalResult: FinalResultArtifactData,
  candidates: CandidateItem[],
  evidenceItems: EvidenceInputItem[]
): NonNullable<GroundingGuardReport["deterministicQualityReport"]> {
  const candidateById = new Map(candidates.map((candidate) => [candidate.id, candidate]));
  const evidenceById = new Map(evidenceItems.map((item) => [item.id, item]));
  const referencedCandidateIds = uniqueNonEmpty([
    ...finalResult.paths.flatMap((path) => path.candidateIds),
    ...finalResult.people.map((person) => person.candidateId)
  ]);
  const referencedEvidenceIds = uniqueNonEmpty([
    ...finalResult.paths.flatMap((path) => path.evidenceIds),
    ...finalResult.people.flatMap((person) => person.evidenceIds)
  ]);
  const lowQualityCandidateIds = referencedCandidateIds.filter((id) =>
    isLowQualityCandidate(candidateById.get(id))
  );
  const lowConfidenceEvidenceIds = referencedEvidenceIds.filter((id) =>
    isLowConfidenceEvidence(evidenceById.get(id))
  );
  const personaWithoutExperienceEvidenceIds = finalResult.people
    .filter((person) => {
      const personEvidence = person.evidenceIds
        .map((id) => evidenceById.get(id))
        .filter((item): item is EvidenceInputItem => Boolean(item));
      return !personEvidence.some((item) => item.isExperienceEvidence);
    })
    .map((person, index) => person.candidateId || `people[${index}]`);

  return {
    checked: true,
    lowQualityCandidateIds,
    lowConfidenceEvidenceIds,
    personaWithoutExperienceEvidenceIds
  };
}

function toEvidenceInputItem(item: EvidenceItem, index: number): EvidenceInputItem {
  return {
    ...item,
    id: item.id || `evidence_${hashSafeId(item.candidateId || item.sourceUrl || item.title)}_${index + 1}`,
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
    score: candidate.score,
    normalizedSearchScore: candidate.normalizedSearchScore,
    relevanceScore: candidate.relevanceScore,
    experienceScore: candidate.experienceScore,
    qualityScore: candidate.qualityScore,
    selectedForEvidence: candidate.selectedForEvidence
  };
}

function toGatewayEvidenceMetadata(item: EvidenceInputItem): Record<string, unknown> {
  return {
    id: item.id,
    candidateId: item.candidateId,
    sourceCandidateId: item.sourceCandidateId,
    title: item.title,
    author: item.author,
    sourceUrl: item.sourceUrl,
    evidenceText: truncateText(item.evidenceText, MAX_EVIDENCE_TEXT_LENGTH),
    supportType: item.supportType,
    isExperienceEvidence: item.isExperienceEvidence,
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
    (value.hardRepairReasons === undefined || isStringArray(value.hardRepairReasons)) &&
    (value.softWarningReasons === undefined || isStringArray(value.softWarningReasons)) &&
    (value.repairReasonCounts === undefined || isNumberRecord(value.repairReasonCounts)) &&
    (value.evidenceCoverage === null ||
      (typeof value.evidenceCoverage === "number" &&
        Number.isFinite(value.evidenceCoverage) &&
        value.evidenceCoverage >= 0 &&
        value.evidenceCoverage <= 1)) &&
    (value.deterministicQualityReport === undefined ||
      isDeterministicQualityReport(value.deterministicQualityReport))
  );
}

function isDeterministicQualityReport(value: unknown): boolean {
  if (!isRecord(value)) {
    return false;
  }

  return (
    typeof value.checked === "boolean" &&
    isStringArray(value.lowQualityCandidateIds) &&
    isStringArray(value.lowConfidenceEvidenceIds) &&
    isStringArray(value.personaWithoutExperienceEvidenceIds)
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

function isNumberRecord(value: unknown): value is Record<string, number> {
  return isRecord(value) && Object.values(value).every((item) => typeof item === "number" && Number.isFinite(item));
}

function hashSafeId(value: string): string {
  const normalized = value.replace(/[^a-zA-Z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  return normalized.slice(0, 48) || "item";
}

function isLowQualityCandidate(candidate: CandidateItem | undefined): boolean {
  return (
    !candidate ||
    !candidate.selectedForEvidence ||
    candidate.qualityScore < MIN_FINAL_CANDIDATE_QUALITY_SCORE
  );
}

function isLowConfidenceEvidence(item: EvidenceInputItem | undefined): boolean {
  return !item || item.confidence < MIN_FINAL_EVIDENCE_CONFIDENCE;
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
