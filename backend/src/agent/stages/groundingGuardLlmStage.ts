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
  type FinalResultPath,
  type FinalResultPerson,
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

  const result = await llmGateway.runJson<unknown>({
    stageName: AGENT_STAGE_GROUNDING_GUARD_LLM,
    provider: config.agent.llm.provider,
    model: config.agent.llm.model,
    messages: buildGroundingGuardMessages(finalResult, limitedCandidates, limitedEvidence),
    timeoutMs: config.agent.llm.timeoutMs,
    retries: config.agent.llm.retries,
    schemaName: "agent.guarded_final_result.v1",
    responseFormat: { type: "json_object" },
    validate: (value) => Boolean(normalizeGuardedFinalResultArtifactData(value, finalResult)),
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
  const guardedResult =
    normalizeGuardedFinalResultArtifactData(result.data, finalResult) ??
    buildGuardedFinalResultFallback(
      finalResult,
      limitedCandidates,
      limitedEvidence,
      result.fallbackReason || "grounding_guard output could not be normalized"
    );

  return {
    artifactType: AGENT_ARTIFACT_GUARDED_FINAL_RESULT,
    data: applyDeterministicQualityReport(guardedResult, finalResult, limitedCandidates, limitedEvidence),
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
        "你是事实边界和证据支撑校验器。只输出符合 agent.guarded_final_result.v1 的 JSON object，不要输出解释。只能基于输入 final_result、candidates、evidenceItems 校验或轻量修正，不要新增事实，不要构造 AI 分身。"
    },
    {
      role: "user" as const,
      content: JSON.stringify({
        task: "校验 final_result 的轻路径、人物索引和追问是否有候选与证据支撑",
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
          "最外层必须直接是 schemaVersion/result/guard/strategy/llmUsed，不要包在 task、outputShape、finalResult、candidates 或 evidenceItems 里",
          "不要回显本条 user JSON，不要复制 candidates/evidenceItems 到输出",
          "result.schemaVersion 必须保持 agent.final_result.v1",
          "result.paths 只需要保留 title、summary、angle、evidenceIds、candidateIds；不要新增或要求 coreChoice、suitableFor、prerequisites、benefits、costsOrRisks",
          "后端会由 sources/evidenceMap 生成 production evidenceSamples；不要输出 evidenceSamples，也不要因为未看到 evidenceSamples 而删除 paths",
          "如果 paths/people 引用不存在的 evidenceIds 或 candidateIds，应只修复对应局部引用或删除对应条目，并写入 guard.warnings",
          "qualityScore 低于阈值的 candidate 不能作为最终 paths/people 的支撑",
          "people 只是样本索引；缺少真实经历证据时可以删除该 people，不要影响其他 path",
          "低 confidence evidence 不能支撑强结论",
          "如果只是保守措辞、样本归纳表达或证据有限提示，但未删除/修改 paths/people/evidenceIds/candidateIds，则 guard.status 保持 passed，只写 warnings",
          "只有删除 path、修复 path 的 evidenceIds/candidateIds 或移除不被证据支撑的强结论时，guard.status 才能是 repaired",
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
    hasPathReferenceChange(originalFinalResult, data.result) ? "source_refs_repaired" : "",
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
      return [];
    }

    if (validExperienceEvidenceIds.length !== person.evidenceIds.length) {
      warnings.push(`people[${index}] repaired by deterministic quality rules`);
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
  return items.flatMap((item) => {
    if (/people|persona/i.test(item)) {
      return [];
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

function hasPathReferenceChange(before: FinalResultArtifactData, after: FinalResultArtifactData): boolean {
  return JSON.stringify(toPathReferenceSignature(before)) !== JSON.stringify(toPathReferenceSignature(after));
}

function toPathReferenceSignature(result: FinalResultArtifactData) {
  return result.paths.map((path) => ({
    evidenceIds: [...path.evidenceIds].sort(),
    candidateIds: [...path.candidateIds].sort()
  }));
}

function isOvergeneralizedPathSummary(summary: string): boolean {
  return /你应该|建议你|你最好|一定要|你一定|只要.+就|心理治疗|心理咨询|咨询师|药物|看医生|诊断|抑郁症|焦虑症/.test(
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

function normalizeGuardedFinalResultArtifactData(
  value: unknown,
  originalFinalResult: FinalResultArtifactData
): GuardedFinalResultArtifactData | null {
  const unwrapped = unwrapGuardedFinalResultRecord(value);
  if (!unwrapped.record) {
    return null;
  }

  const result = normalizeFinalResultArtifactData(unwrapped.record.result, originalFinalResult);
  const guard = normalizeGroundingGuardReport(unwrapped.record.guard, unwrapped.normalizedWarnings);
  if (!result || !guard) {
    return null;
  }

  return {
    schemaVersion: "agent.guarded_final_result.v1",
    result,
    guard,
    strategy:
      unwrapped.record.strategy === "rule_fallback" || unwrapped.record.strategy === "llm_guarded"
        ? unwrapped.record.strategy
        : "llm_guarded",
    llmUsed: readBoolean(unwrapped.record.llmUsed, true),
    ...(readString(unwrapped.record.fallbackReason)
      ? { fallbackReason: readString(unwrapped.record.fallbackReason) }
      : {})
  };
}

function unwrapGuardedFinalResultRecord(value: unknown): {
  record: Record<string, unknown> | null;
  normalizedWarnings: string[];
} {
  if (!isRecord(value)) {
    return {
      record: null,
      normalizedWarnings: []
    };
  }

  if (looksLikeGuardedFinalResult(value)) {
    return {
      record: value,
      normalizedWarnings: []
    };
  }

  for (const key of ["outputShape", "guardedFinalResult", "data"]) {
    const nested = value[key];
    if (isRecord(nested) && looksLikeGuardedFinalResult(nested)) {
      return {
        record: nested,
        normalizedWarnings: [`grounding_guard normalized nested ${key} output`]
      };
    }
  }

  if (isRecord(value.result) || isRecord(value.guard)) {
    return {
      record: value,
      normalizedWarnings: ["grounding_guard normalized partial guarded output"]
    };
  }

  return {
    record: null,
    normalizedWarnings: []
  };
}

function looksLikeGuardedFinalResult(value: Record<string, unknown>): boolean {
  return (
    value.schemaVersion === "agent.guarded_final_result.v1" ||
    isRecord(value.result) ||
    isRecord(value.guard) ||
    value.strategy === "llm_guarded" ||
    value.strategy === "rule_fallback"
  );
}

function normalizeFinalResultArtifactData(
  value: unknown,
  originalFinalResult: FinalResultArtifactData
): FinalResultArtifactData | null {
  if (!isRecord(value)) {
    return originalFinalResult;
  }

  const rawPaths = Array.isArray(value.paths) ? value.paths : originalFinalResult.paths;
  const rawPeople = Array.isArray(value.people) ? value.people : originalFinalResult.people;
  const paths = rawPaths
    .map((path, index) => normalizeFinalResultPath(path, originalFinalResult.paths[index]))
    .filter((path): path is FinalResultPath => Boolean(path));
  const people = rawPeople
    .map((person, index) => normalizeFinalResultPerson(person, originalFinalResult.people[index]))
    .filter((person): person is FinalResultPerson => Boolean(person));

  return {
    schemaVersion: "agent.final_result.v1",
    summary: readString(value.summary) || originalFinalResult.summary,
    paths,
    people,
    suggestedQuestions: readStringArray(value.suggestedQuestions, originalFinalResult.suggestedQuestions),
    strategy:
      value.strategy === "rule_fallback" || value.strategy === "llm_composed"
        ? value.strategy
        : originalFinalResult.strategy,
    llmUsed: readBoolean(value.llmUsed, originalFinalResult.llmUsed),
    ...(readString(value.fallbackReason)
      ? { fallbackReason: readString(value.fallbackReason) }
      : originalFinalResult.fallbackReason
        ? { fallbackReason: originalFinalResult.fallbackReason }
        : {})
  };
}

function normalizeFinalResultPath(value: unknown, fallback?: FinalResultPath): FinalResultPath | null {
  const record = isRecord(value) ? value : {};
  const title = readString(record.title) || fallback?.title || "";
  const summary = readString(record.summary) || fallback?.summary || "";
  const evidenceIds = readStringArray(record.evidenceIds, fallback?.evidenceIds ?? []);
  const candidateIds = readStringArray(record.candidateIds, fallback?.candidateIds ?? []);

  if (!title || !summary) {
    return null;
  }

  return {
    title,
    summary,
    ...(readString(record.angle) || fallback?.angle
      ? { angle: readString(record.angle) || fallback?.angle || "" }
      : {}),
    evidenceIds,
    candidateIds,
    ...(readString(record.coreChoice) || fallback?.coreChoice
      ? { coreChoice: readString(record.coreChoice) || fallback?.coreChoice || "" }
      : {}),
    ...(readStringArray(record.suitableFor, fallback?.suitableFor ?? []).length > 0
      ? { suitableFor: readStringArray(record.suitableFor, fallback?.suitableFor ?? []) }
      : {}),
    ...(readStringArray(record.prerequisites, fallback?.prerequisites ?? []).length > 0
      ? { prerequisites: readStringArray(record.prerequisites, fallback?.prerequisites ?? []) }
      : {}),
    ...(readStringArray(record.benefits, fallback?.benefits ?? []).length > 0
      ? { benefits: readStringArray(record.benefits, fallback?.benefits ?? []) }
      : {}),
    ...(readStringArray(record.costsOrRisks, fallback?.costsOrRisks ?? []).length > 0
      ? { costsOrRisks: readStringArray(record.costsOrRisks, fallback?.costsOrRisks ?? []) }
      : {})
  };
}

function normalizeFinalResultPerson(value: unknown, fallback?: FinalResultPerson): FinalResultPerson | null {
  const record = isRecord(value) ? value : {};
  const name = readString(record.name) || fallback?.name || "";
  const reason = readString(record.reason) || fallback?.reason || "";
  const candidateId = readString(record.candidateId) || fallback?.candidateId || "";
  const evidenceIds = readStringArray(record.evidenceIds, fallback?.evidenceIds ?? []);

  if (!name || !reason || !candidateId) {
    return null;
  }

  return {
    name,
    reason,
    candidateId,
    evidenceIds
  };
}

function normalizeGroundingGuardReport(
  value: unknown,
  normalizedWarnings: string[]
): GroundingGuardReport | null {
  const record = isRecord(value) ? value : {};
  const status = normalizeGuardStatus(record.status);
  const warnings = uniqueNonEmpty([
    ...readStringArray(record.warnings, []),
    ...normalizedWarnings
  ]);
  const hardRepairReasons = readStringArray(record.hardRepairReasons, []);
  const softWarningReasons = readStringArray(record.softWarningReasons, []);
  const repairReasonCounts = readNumberRecord(record.repairReasonCounts);
  const deterministicQualityReport = normalizeDeterministicQualityReport(
    record.deterministicQualityReport
  );

  return {
    status,
    unsupportedClaims: readStringArray(record.unsupportedClaims, []),
    removedItems: readStringArray(record.removedItems, []),
    warnings,
    evidenceCoverage: normalizeEvidenceCoverage(record.evidenceCoverage),
    ...(hardRepairReasons.length > 0 ? { hardRepairReasons } : {}),
    ...(softWarningReasons.length > 0 ? { softWarningReasons } : {}),
    ...(Object.keys(repairReasonCounts).length > 0 ? { repairReasonCounts } : {}),
    ...(deterministicQualityReport ? { deterministicQualityReport } : {})
  };
}

function normalizeGuardStatus(value: unknown): GroundingGuardReport["status"] {
  const status = readString(value).toLowerCase();
  if (status === "passed" || status === "repaired" || status === "partial" || status === "fallback") {
    return status;
  }
  if (status === "pass" || status === "ok" || status === "success") {
    return "passed";
  }
  if (status === "warning" || status === "warnings") {
    return "partial";
  }
  return "passed";
}

function normalizeEvidenceCoverage(value: unknown): number | null {
  const parsed = readNumber(value, Number.NaN);
  if (!Number.isFinite(parsed)) {
    return null;
  }
  if (parsed > 1 && parsed <= 100) {
    return clampScore(parsed / 100);
  }
  return parsed >= 0 && parsed <= 1 ? clampScore(parsed) : null;
}

function normalizeDeterministicQualityReport(
  value: unknown
): GroundingGuardReport["deterministicQualityReport"] | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  return {
    checked: readBoolean(value.checked, false),
    lowQualityCandidateIds: readStringArray(value.lowQualityCandidateIds, []),
    lowConfidenceEvidenceIds: readStringArray(value.lowConfidenceEvidenceIds, []),
    personaWithoutExperienceEvidenceIds: readStringArray(
      value.personaWithoutExperienceEvidenceIds,
      []
    )
  };
}

function readString(value: unknown): string {
  if (typeof value === "string") {
    return value.replace(/\s+/g, " ").trim();
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return "";
}

function readStringArray(value: unknown, fallback: string[]): string[] {
  if (Array.isArray(value)) {
    return uniqueNonEmpty(value.map(readString));
  }
  const single = readString(value);
  return single ? [single] : fallback;
}

function readBoolean(value: unknown, fallback: boolean): boolean {
  if (typeof value === "boolean") {
    return value;
  }
  const normalized = readString(value).toLowerCase();
  if (["true", "1", "yes", "on"].includes(normalized)) {
    return true;
  }
  if (["false", "0", "no", "off"].includes(normalized)) {
    return false;
  }
  return fallback;
}

function readNumber(value: unknown, fallback: number): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  const parsed = Number.parseFloat(readString(value));
  return Number.isFinite(parsed) ? parsed : fallback;
}

function readNumberRecord(value: unknown): Record<string, number> {
  if (!isRecord(value)) {
    return {};
  }

  const result: Record<string, number> = {};
  for (const [key, rawValue] of Object.entries(value)) {
    const parsed = readNumber(rawValue, Number.NaN);
    if (Number.isFinite(parsed)) {
      result[key] = parsed;
    }
  }

  return result;
}

function clampScore(value: number): number {
  return Math.min(Math.max(Number(value.toFixed(3)), 0), 1);
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
    (value.angle === undefined || typeof value.angle === "string") &&
    isStringArray(value.evidenceIds) &&
    isStringArray(value.candidateIds) &&
    (value.coreChoice === undefined || typeof value.coreChoice === "string") &&
    (value.suitableFor === undefined || isStringArray(value.suitableFor)) &&
    (value.prerequisites === undefined || isStringArray(value.prerequisites)) &&
    (value.benefits === undefined || isStringArray(value.benefits)) &&
    (value.costsOrRisks === undefined || isStringArray(value.costsOrRisks))
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
