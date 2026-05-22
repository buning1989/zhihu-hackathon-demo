import { createHash } from "node:crypto";
import type {
  CandidateItem,
  CandidatesArtifactData,
  EvidenceArtifactData,
  EvidenceItem,
  EvidenceSupportType,
  FinalResultArtifactData,
  FinalResultPath,
  FinalResultPerson,
  GroundingGuardReport
} from "./stages/stageTypes.js";

const MIN_FINAL_CANDIDATE_QUALITY_SCORE = 0.45;
const MIN_FINAL_EVIDENCE_CONFIDENCE = 0.35;
const MIN_PERSONA_EVIDENCE_CONFIDENCE = 0.45;
const MIN_DISPLAY_EVIDENCE_SAMPLE_COUNT = 4;
export const AGENT_PRODUCTION_FINAL_RESULT_SCHEMA_VERSION = "agent.production_final_result.v2";

export type ProductionFinalResultSchemaVersion =
  | "agent.production_final_result.v1"
  | "agent.production_final_result.v2";

export type ProductionEvidenceSampleType =
  | "experience"
  | "decision"
  | "opinion"
  | "context";

export interface ProductionSourceRef {
  sourceCandidateId: string;
  evidenceItemIds: string[];
}

export interface ProductionFinalResultPath {
  id: string;
  title: string;
  summary: string;
  angle: string;
  evidenceIds: string[];
  sourceIds: string[];
  sourceRefs: ProductionSourceRef[];
  confidence: number;
  /** @deprecated v1 compatibility only. New v2 consumers should use title/summary/angle/sourceRefs. */
  coreChoice?: string;
  /** @deprecated v1 compatibility only. */
  suitableFor?: string[];
  /** @deprecated v1 compatibility only. */
  prerequisites?: string[];
  /** @deprecated v1 compatibility only. */
  benefits?: string[];
  /** @deprecated v1 compatibility only. */
  costsOrRisks?: string[];
  /** @deprecated v1 compatibility only. */
  suitableContext?: string;
  /** @deprecated v1 compatibility only. */
  tradeoffs?: string;
}

export interface ProductionFinalResultPersona {
  id: string;
  displayLabel: string;
  summary: string;
  chatEnabled: boolean;
  sourceRefs: ProductionSourceRef[];
  confidence: number;
  boundary: string;
}

export interface ProductionFinalResultSource {
  id: string;
  sourceCandidateId: string;
  rawSourceId: string;
  provider: string;
  type: string;
  title: string;
  author: string;
  url: string;
  excerpt: string;
  score: number;
  normalizedSearchScore: number;
  relevanceScore: number;
  experienceScore: number;
  qualityScore: number;
  qualitySignals: string[];
  selectedForEvidence: boolean;
  rejectReason: string | null;
}

export interface ProductionEvidenceItem {
  id: string;
  sourceCandidateId: string;
  title: string;
  author: string;
  sourceUrl: string;
  evidenceText: string;
  excerpt: string;
  reason: string;
  normalizedClaim: string;
  supportType: EvidenceSupportType;
  isExperienceEvidence: boolean;
  confidence: number;
  /** @deprecated v1 compatibility only. */
  situation?: string;
  /** @deprecated v1 compatibility only. */
  choice?: string;
  /** @deprecated v1 compatibility only. */
  process?: string;
  /** @deprecated v1 compatibility only. */
  outcome?: string;
  /** @deprecated v1 compatibility only. */
  costOrRisk?: string;
  /** @deprecated v1 compatibility only. */
  takeaway?: string;
}

export interface ProductionEvidenceSample {
  id: string;
  sourceCandidateId: string;
  evidenceItemId: string;
  title: string;
  author: string;
  sourceUrl: string;
  snippet: string;
  whyRelevant: string;
  sampleType: ProductionEvidenceSampleType;
  confidence: number;
  /** @deprecated v1 compatibility only. */
  situation?: string;
  /** @deprecated v1 compatibility only. */
  choice?: string;
  /** @deprecated v1 compatibility only. */
  keyExperience?: string;
  /** @deprecated v1 compatibility only. */
  judgment?: string;
  /** @deprecated v1 compatibility only. */
  referenceValue?: string;
  /** @deprecated v1 compatibility only. */
  limit?: string;
  /** @deprecated v1 compatibility only. */
  evidenceText?: string;
  /** @deprecated v1 compatibility only. */
  supportType?: EvidenceSupportType;
  /** @deprecated v1 compatibility only. */
  isExperienceEvidence?: boolean;
}

export interface DeterministicGroundingReport {
  status: "passed" | "repaired" | "failed";
  removedPathIds: string[];
  removedPersonaIds: string[];
  warnings: string[];
  qualityReport: {
    checked: true;
    minCandidateQualityScore: number;
    minEvidenceConfidence: number;
    minPersonaEvidenceConfidence: number;
    minDisplayEvidenceSampleCount: number;
    lowQualityCandidateIds: string[];
    lowConfidenceEvidenceIds: string[];
    personaWithoutExperienceEvidenceIds: string[];
    pathWithoutEvidenceIds: string[];
    invalidEvidenceSampleIds: string[];
  };
}

export interface ProductionFinalResultData {
  schemaVersion: ProductionFinalResultSchemaVersion;
  taskId: string;
  query?: string;
  summary: string;
  paths: ProductionFinalResultPath[];
  /** @deprecated v1 compatibility only. Prefer evidenceSamples for display cards in v2. */
  personas?: ProductionFinalResultPersona[];
  sources: ProductionFinalResultSource[];
  evidenceMap: Record<string, ProductionEvidenceItem>;
  evidenceSamples?: ProductionEvidenceSample[];
  groundingReport: {
    llmGuard: GroundingGuardReport;
    deterministicValidator: DeterministicGroundingReport;
  };
  degraded: boolean;
  degradedReason: string | null;
  suggestedQuestions: string[];
  warnings?: string[];
  meta: {
    generatedAt: string;
    sourcePolicy: string;
    originalResultSchemaVersion: FinalResultArtifactData["schemaVersion"];
  };
}

interface BuildProductionFinalResultInput {
  taskId: string;
  query?: string;
  finalResult: FinalResultArtifactData;
  candidates: CandidatesArtifactData;
  evidence: EvidenceArtifactData;
  guard: GroundingGuardReport;
  degradedReasons?: string[];
}

interface EvidenceInputItem extends EvidenceItem {
  id: string;
}

export function buildProductionFinalResult(
  input: BuildProductionFinalResultInput
): ProductionFinalResultData {
  const candidateById = new Map(
    input.candidates.candidates.map((candidate) => [candidate.id, candidate])
  );
  const evidenceItems = input.evidence.evidenceItems
    .map(toEvidenceInputItem)
    .filter((item) => candidateById.has(item.candidateId));
  const evidenceById = new Map(evidenceItems.map((item) => [item.id, item]));
  const evidenceByCandidateId = groupEvidenceByCandidateId(evidenceItems);
  const sources = input.candidates.candidates
    .filter((candidate) => candidate.selectedForEvidence)
    .map(toProductionSource);
  const finalPaths = ensureGroundedFinalPaths(
    input.finalResult.paths,
    evidenceItems,
    candidateById
  );
  const evidenceMap = Object.fromEntries(
    evidenceItems.map((item) => [item.id, toProductionEvidenceItem(item)])
  );
  const evidenceSamples = buildEvidenceSamples(evidenceItems, candidateById);
  const builtPaths = finalPaths.map((path, index) =>
    toProductionPath(path, index, candidateById, evidenceById, evidenceByCandidateId)
  );
  const builtPersonas = input.finalResult.people.map((person, index) =>
    toProductionPersona(person, index, candidateById, evidenceById, evidenceByCandidateId)
  );
  const validation = validateProductionItems({
    paths: builtPaths,
    personas: builtPersonas,
    evidenceSamples,
    sourceIds: new Set(sources.map((source) => source.sourceCandidateId)),
    candidateById,
    evidenceMap
  });
  const degradedReasons = uniqueNonEmpty([
    ...(input.degradedReasons ?? []),
    input.finalResult.fallbackReason ?? "",
    getGroundingGuardDegradedReason(input.guard),
    validation.status === "passed" ? "" : `deterministic_validator_${validation.status}`,
    validation.paths.length === 0 ? "deterministic_validator_no_paths" : "",
    evidenceSamples.length < MIN_DISPLAY_EVIDENCE_SAMPLE_COUNT ? "evidence_samples_insufficient" : ""
  ]);

  return {
    schemaVersion: AGENT_PRODUCTION_FINAL_RESULT_SCHEMA_VERSION,
    taskId: input.taskId,
    query: input.query ?? "",
    summary: buildProductionSummary(input.finalResult.summary, validation.paths, evidenceSamples),
    paths: validation.paths,
    personas: validation.personas,
    sources,
    evidenceMap,
    evidenceSamples,
    groundingReport: {
      llmGuard: input.guard,
      deterministicValidator: {
        status: validation.status,
        removedPathIds: validation.removedPathIds,
        removedPersonaIds: validation.removedPersonaIds,
        warnings: validation.warnings,
        qualityReport: validation.qualityReport
      }
    },
    degraded: degradedReasons.length > 0,
    degradedReason: degradedReasons.join("; ") || null,
    suggestedQuestions: input.finalResult.suggestedQuestions,
    warnings: uniqueNonEmpty([
      ...input.guard.warnings,
      ...validation.warnings
    ]),
    meta: {
      generatedAt: new Date().toISOString(),
      sourcePolicy: "AI organizes public content and evidence; it is not a factual source.",
      originalResultSchemaVersion: input.finalResult.schemaVersion
    }
  };
}

function getGroundingGuardDegradedReason(guard: GroundingGuardReport): string {
  if (guard.status === "fallback") {
    return "grounding_guard_fallback";
  }
  if (guard.status === "partial") {
    return "grounding_guard_partial";
  }
  if (guard.status === "repaired" && (guard.hardRepairReasons?.length ?? 0) > 0) {
    return "grounding_guard_hard_repaired";
  }

  return "";
}

export function isProductionFinalResultData(value: unknown): value is ProductionFinalResultData {
  if (!isRecord(value)) {
    return false;
  }

  const schemaVersion = value.schemaVersion;
  const isSupportedSchema =
    schemaVersion === "agent.production_final_result.v1" ||
    schemaVersion === "agent.production_final_result.v2";

  return (
    isSupportedSchema &&
    typeof value.taskId === "string" &&
    (value.query === undefined || typeof value.query === "string") &&
    typeof value.summary === "string" &&
    Array.isArray(value.paths) &&
    value.paths.every(isProductionPath) &&
    (value.personas === undefined ||
      (Array.isArray(value.personas) && value.personas.every(isProductionPersona))) &&
    Array.isArray(value.sources) &&
    value.sources.every(isProductionSource) &&
    isRecord(value.evidenceMap) &&
    Object.values(value.evidenceMap).every(isProductionEvidenceItem) &&
    (value.evidenceSamples === undefined
      ? schemaVersion === "agent.production_final_result.v1"
      : Array.isArray(value.evidenceSamples) &&
        value.evidenceSamples.every(isProductionEvidenceSample)) &&
    isRecord(value.groundingReport) &&
    typeof value.degraded === "boolean" &&
    (value.degradedReason === null || typeof value.degradedReason === "string") &&
    (value.warnings === undefined || isStringArray(value.warnings))
  );
}

function toProductionPath(
  path: FinalResultPath,
  index: number,
  candidateById: Map<string, CandidateItem>,
  evidenceById: Map<string, EvidenceInputItem>,
  evidenceByCandidateId: Map<string, EvidenceInputItem[]>
): ProductionFinalResultPath {
  const sourceRefs = buildSourceRefs(
    path.candidateIds,
    path.evidenceIds,
    candidateById,
    evidenceById,
    evidenceByCandidateId
  );

  return {
    id: stableId("path", `${path.title}:${index}`),
    title: path.title,
    summary: path.summary,
    angle: readPathString(path.angle) || inferPathAngle(path, sourceRefs, evidenceById),
    evidenceIds: uniqueNonEmpty(sourceRefs.flatMap((sourceRef) => sourceRef.evidenceItemIds)),
    sourceIds: uniqueNonEmpty(sourceRefs.map((sourceRef) => sourceRef.sourceCandidateId)),
    sourceRefs,
    confidence: calculateConfidence(sourceRefs, candidateById, evidenceById)
  };
}

function toProductionPersona(
  person: FinalResultPerson,
  index: number,
  candidateById: Map<string, CandidateItem>,
  evidenceById: Map<string, EvidenceInputItem>,
  evidenceByCandidateId: Map<string, EvidenceInputItem[]>
): ProductionFinalResultPersona {
  const sourceRefs = buildSourceRefs(
    [person.candidateId],
    person.evidenceIds.filter((evidenceId) => evidenceById.get(evidenceId)?.candidateId === person.candidateId),
    candidateById,
    evidenceById,
    evidenceByCandidateId
  );
  const displayName = person.name || candidateById.get(person.candidateId)?.author || "Zhihu sample";

  return {
    id: stableId("persona", `${person.candidateId}:${displayName}:${index}`),
    displayLabel: `${displayName} public-content sample`,
    summary: person.reason,
    chatEnabled: false,
    sourceRefs,
    confidence: calculateConfidence(sourceRefs, candidateById, evidenceById),
    boundary: "Generated from public Zhihu content and evidence; it does not represent the author."
  };
}

function ensureGroundedFinalPaths(
  paths: FinalResultPath[],
  evidenceItems: EvidenceInputItem[],
  candidateById: Map<string, CandidateItem>
): FinalResultPath[] {
  if (evidenceItems.length === 0) {
    return paths;
  }

  const validPaths = paths.filter((path) => path.evidenceIds.length > 0 || path.candidateIds.length > 0);
  const existingEvidenceIds = new Set(validPaths.flatMap((path) => path.evidenceIds));
  const supplemental = evidenceItems
    .filter((item) => !existingEvidenceIds.has(item.id) && candidateById.has(item.candidateId))
    .map((item, index) => buildSupplementalFinalPath(item, candidateById.get(item.candidateId), index))
    .filter((path): path is FinalResultPath => Boolean(path));

  const merged = [...validPaths, ...supplemental];
  if (merged.length >= 3) {
    return merged.slice(0, 3);
  }

  if (validPaths.length === 1 && evidenceItems.length >= 3) {
    const splitPaths = evidenceItems
      .filter((item) => candidateById.has(item.candidateId))
      .slice(0, 3)
      .map((item, index) => buildSupplementalFinalPath(item, candidateById.get(item.candidateId), index))
      .filter((path): path is FinalResultPath => Boolean(path));
    return splitPaths.length > merged.length ? splitPaths : merged;
  }

  return merged;
}

function buildSupplementalFinalPath(
  item: EvidenceInputItem,
  candidate: CandidateItem | undefined,
  index: number
): FinalResultPath | null {
  if (!candidate) {
    return null;
  }

  const title = buildSupplementalPathTitle(item, candidate, index);
  const claim = truncateText(item.normalizedClaim || item.evidenceText, 96);

  return {
    title,
    summary: `这条路径来自「${truncateText(candidate.title, 32)}」的证据片段：${claim}。它只提供一个公开样本中的选择线索，不能推断完整人生。`,
    angle: inferEvidenceChoice(item) || "把来源片段中的选择作为一个对照方向。",
    evidenceIds: [item.id],
    candidateIds: [candidate.id]
  };
}

function buildSupplementalPathTitle(
  item: EvidenceInputItem,
  candidate: CandidateItem,
  index: number
): string {
  const text = `${candidate.title} ${item.evidenceText}`;
  if (/异地|恋爱|伴侣|女朋友|男朋友|夫妻/.test(text)) {
    return index === 0 ? "样本路径：优先工作但承担关系不确定性" : "样本路径：把异地成本摊开比较";
  }
  if (/ai|人工智能|大模型|产品|转行|非科班|算法/i.test(text)) {
    return index === 0 ? "样本路径：从已有经验切入 AI" : "样本路径：先用学习和项目验证转行";
  }
  if (/不上班|不工作|失业|裸辞|离职|自由职业/.test(text)) {
    return index === 0 ? "样本路径：用替代收入接住现金流" : "样本路径：先恢复生活秩序和安全垫";
  }

  return "样本路径：围绕公开证据做对照";
}

function buildEvidenceSamples(
  evidenceItems: EvidenceInputItem[],
  candidateById: Map<string, CandidateItem>
): ProductionEvidenceSample[] {
  return evidenceItems
    .filter((item) => candidateById.has(item.candidateId))
    .slice(0, 6)
    .map((item) => {
      const candidate = candidateById.get(item.candidateId);
      const snippet = item.excerpt || item.evidenceText;
      const whyRelevant = item.normalizedClaim || item.reason || item.evidenceText;

      return {
        id: `sample_${item.id}`,
        sourceCandidateId: item.candidateId,
        evidenceItemId: item.id,
        title: candidate?.title || item.title,
        author: candidate?.author || item.author || "知乎用户",
        sourceUrl: candidate?.url || item.sourceUrl,
        snippet: truncateText(snippet, 180),
        whyRelevant: truncateText(whyRelevant, 160),
        sampleType: mapEvidenceSampleType(item.supportType),
        confidence: item.confidence
      };
    });
}

function buildSourceRefs(
  requestedCandidateIds: string[],
  requestedEvidenceIds: string[],
  candidateById: Map<string, CandidateItem>,
  evidenceById: Map<string, EvidenceInputItem>,
  evidenceByCandidateId: Map<string, EvidenceInputItem[]>
): ProductionSourceRef[] {
  const sourceCandidateIds = uniqueNonEmpty([
    ...requestedCandidateIds,
    ...requestedEvidenceIds
      .map((evidenceId) => evidenceById.get(evidenceId)?.candidateId ?? "")
      .filter(Boolean)
  ]).filter((candidateId) => candidateById.has(candidateId));

  return sourceCandidateIds.flatMap((candidateId) => {
    const requestedIdsForCandidate = requestedEvidenceIds.filter(
      (evidenceId) => evidenceById.get(evidenceId)?.candidateId === candidateId
    );
    const fallbackIdsForCandidate = (evidenceByCandidateId.get(candidateId) ?? [])
      .slice(0, 2)
      .map((item) => item.id);
    const evidenceItemIds = uniqueNonEmpty([
      ...requestedIdsForCandidate,
      ...fallbackIdsForCandidate
    ]).filter((evidenceId) => evidenceById.get(evidenceId)?.candidateId === candidateId);

    if (evidenceItemIds.length === 0) {
      return [];
    }

    return [
      {
        sourceCandidateId: candidateId,
        evidenceItemIds
      }
    ];
  });
}

function mapEvidenceSampleType(supportType: EvidenceSupportType): ProductionEvidenceSampleType {
  if (supportType === "experience_fact") {
    return "experience";
  }
  if (supportType === "decision_point" || supportType === "tradeoff" || supportType === "outcome") {
    return "decision";
  }
  if (supportType === "opinion") {
    return "opinion";
  }
  return "context";
}

function buildProductionSummary(
  originalSummary: string,
  paths: ProductionFinalResultPath[],
  evidenceSamples: ProductionEvidenceSample[]
): string {
  if (paths.length === 0) {
    return originalSummary || "当前证据不足以整理出稳定路径。";
  }

  const pathChoices = paths
    .map((path) => path.angle || path.title)
    .map(stripTrailingPunctuation)
    .filter(Boolean)
    .filter((value, index, array) => array.indexOf(value) === index)
    .slice(0, 3)
    .join("；");
  const sampleCount = evidenceSamples.length;

  return `这些知乎公开样本呈现了 ${paths.length} 类角度：${pathChoices}。共整理 ${sampleCount} 条可追溯证据样本；这里只做来源归纳，不把样本改写成个人建议或完整人生报告。`;
}

function inferPathAngle(
  path: FinalResultPath,
  sourceRefs: ProductionSourceRef[],
  evidenceById: Map<string, EvidenceInputItem>
): string {
  const firstEvidence = sourceRefs
    .flatMap((sourceRef) => sourceRef.evidenceItemIds)
    .map((evidenceId) => evidenceById.get(evidenceId))
    .find(Boolean);

  if (firstEvidence) {
    return inferEvidenceChoice(firstEvidence);
  }

  return path.summary || "把有证据支撑的公开样本作为一个对照方向。";
}

function inferTradeoff(
  sourceRefs: ProductionSourceRef[],
  evidenceById: Map<string, EvidenceInputItem>
): string {
  const evidence = sourceRefs
    .flatMap((sourceRef) => sourceRef.evidenceItemIds)
    .map((evidenceId) => evidenceById.get(evidenceId))
    .find(Boolean);

  return evidence ? inferEvidenceCostOrRisk(evidence) : "公开片段有限，不能推断完整经历和长期结果。";
}

function inferEvidenceChoice(item: EvidenceInputItem): string {
  const text = `${item.choice || ""} ${item.evidenceText}`;
  if (/异地|恋爱|伴侣|女朋友|男朋友|夫妻/.test(text)) {
    if (/工作|工资|事业|赚钱|前途|机会/.test(text)) {
      return "在工作机会和关系距离之间，来源样本把职业现实放进优先比较。";
    }
    return "围绕异地关系的期限、见面成本和继续条件做取舍。";
  }
  if (/ai|人工智能|大模型|产品|转行|非科班|算法/i.test(text)) {
    if (/之前|我就是|做软件|医学转|java|经验|摸爬滚打/.test(text)) {
      return "把已有经历或技能转成进入 AI 相关岗位的切入点。";
    }
    return "先通过学习、项目或岗位能力验证 AI 转行可行性。";
  }
  if (/不上班|不工作|失业|裸辞|离职|自由职业/.test(text)) {
    if (/跑车|送货|摆摊|接项目|远程|自媒体|收入|现金流|挣钱/.test(text)) {
      return "用替代收入或低成本试运行接住离开工作后的现金流。";
    }
    return "先处理失业或停工后的生活秩序，再判断下一站。";
  }

  return item.choice || item.normalizedClaim || "把来源片段中的选择作为对照。";
}

function inferEvidenceCostOrRisk(item: EvidenceInputItem): string {
  const text = `${item.costOrRisk || ""} ${item.evidenceText}`;
  if (/异地|恋爱|伴侣|夫妻|女朋友|男朋友/.test(text)) {
    return "关系变淡、分手、见面成本和长期不确定性需要实际承担。";
  }
  if (/ai|人工智能|大模型|产品|转行|非科班|算法/i.test(text)) {
    return "学习成本、作品验证成本和岗位匹配不确定性仍然存在。";
  }
  if (/不上班|不工作|失业|裸辞|离职|自由职业/.test(text)) {
    return "现金流、再就业、收入稳定性和生活状态可能承压。";
  }

  return item.costOrRisk || "公开片段有限，不能推断完整经历和长期结果。";
}

function readPathString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function readPathStringArray(value: unknown, fallback: string[]): string[] {
  if (!Array.isArray(value)) {
    return fallback;
  }

  const result = uniqueNonEmpty(value.filter((item): item is string => typeof item === "string"));
  return result.length > 0 ? result : fallback;
}

function stripTrailingPunctuation(value: string): string {
  return value.replace(/[。；;,.，、\s]+$/g, "").trim();
}

function validateProductionItems(input: {
  paths: ProductionFinalResultPath[];
  personas: ProductionFinalResultPersona[];
  evidenceSamples: ProductionEvidenceSample[];
  sourceIds: Set<string>;
  candidateById: Map<string, CandidateItem>;
  evidenceMap: Record<string, ProductionEvidenceItem>;
}): {
  status: DeterministicGroundingReport["status"];
  paths: ProductionFinalResultPath[];
  personas: ProductionFinalResultPersona[];
  removedPathIds: string[];
  removedPersonaIds: string[];
  warnings: string[];
  qualityReport: DeterministicGroundingReport["qualityReport"];
} {
  const pathWarnings: string[] = [];
  const personaWarnings: string[] = [];
  const sampleWarnings: string[] = [];
  const removedPathIds: string[] = [];
  const removedPersonaIds: string[] = [];
  const paths = input.paths.filter((path) => {
    const valid = validateSourceRefs({
      sourceRefs: path.sourceRefs,
      sourceIds: input.sourceIds,
      candidateById: input.candidateById,
      evidenceMap: input.evidenceMap,
      warnings: pathWarnings,
      itemLabel: path.id,
      requireExperienceEvidence: false
    });
    if (!valid) {
      removedPathIds.push(path.id);
    }
    return valid;
  });
  const personas = input.personas.filter((persona) => {
    const valid = validateSourceRefs({
      sourceRefs: persona.sourceRefs,
      sourceIds: input.sourceIds,
      candidateById: input.candidateById,
      evidenceMap: input.evidenceMap,
      warnings: personaWarnings,
      itemLabel: persona.id,
      requireExperienceEvidence: true
    });
    if (!valid) {
      removedPersonaIds.push(persona.id);
    }
    return valid;
  });
  const invalidEvidenceSampleIds = findInvalidEvidenceSampleIds({
    evidenceSamples: input.evidenceSamples,
    sourceIds: input.sourceIds,
    evidenceMap: input.evidenceMap,
    warnings: sampleWarnings
  });
  const qualityReport = buildQualityReport({
    paths,
    personas,
    evidenceSamples: input.evidenceSamples,
    invalidEvidenceSampleIds,
    candidateById: input.candidateById,
    evidenceMap: input.evidenceMap
  });

  const blockingIssueCount = pathWarnings.length + removedPathIds.length + invalidEvidenceSampleIds.length;
  const status =
    blockingIssueCount === 0
      ? "passed"
      : paths.length > 0 || input.evidenceSamples.length > invalidEvidenceSampleIds.length
        ? "repaired"
        : "failed";

  return {
    status,
    paths,
    personas,
    removedPathIds,
    removedPersonaIds,
    warnings: uniqueNonEmpty([...pathWarnings, ...personaWarnings, ...sampleWarnings]),
    qualityReport
  };
}

function findInvalidEvidenceSampleIds(input: {
  evidenceSamples: ProductionEvidenceSample[];
  sourceIds: Set<string>;
  evidenceMap: Record<string, ProductionEvidenceItem>;
  warnings: string[];
}): string[] {
  const invalidIds: string[] = [];
  for (const sample of input.evidenceSamples) {
    const evidenceItem = input.evidenceMap[sample.evidenceItemId];
    if (!input.sourceIds.has(sample.sourceCandidateId)) {
      input.warnings.push(`${sample.id}: evidence sample sourceCandidateId missing: ${sample.sourceCandidateId}`);
      invalidIds.push(sample.id);
      continue;
    }
    if (!evidenceItem) {
      input.warnings.push(`${sample.id}: evidence sample evidenceItemId missing: ${sample.evidenceItemId}`);
      invalidIds.push(sample.id);
      continue;
    }
    if (evidenceItem.sourceCandidateId !== sample.sourceCandidateId) {
      input.warnings.push(
        `${sample.id}: evidence sample ${sample.evidenceItemId} belongs to ${evidenceItem.sourceCandidateId}, not ${sample.sourceCandidateId}`
      );
      invalidIds.push(sample.id);
    }
  }

  return uniqueNonEmpty(invalidIds);
}

function validateSourceRefs(input: {
  sourceRefs: ProductionSourceRef[];
  sourceIds: Set<string>;
  candidateById: Map<string, CandidateItem>;
  evidenceMap: Record<string, ProductionEvidenceItem>;
  warnings: string[];
  itemLabel: string;
  requireExperienceEvidence: boolean;
}): boolean {
  const {
    sourceRefs,
    sourceIds,
    candidateById,
    evidenceMap,
    warnings,
    itemLabel,
    requireExperienceEvidence
  } = input;

  if (sourceRefs.length === 0) {
    warnings.push(`${itemLabel}: sourceRefs missing`);
    return false;
  }

  let hasExperienceEvidence = false;
  for (const sourceRef of sourceRefs) {
    if (!sourceIds.has(sourceRef.sourceCandidateId)) {
      warnings.push(`${itemLabel}: sourceCandidateId missing: ${sourceRef.sourceCandidateId}`);
      return false;
    }

    const candidate = candidateById.get(sourceRef.sourceCandidateId);
    if (!isCandidateAllowedInFinal(candidate)) {
      warnings.push(`${itemLabel}: candidate below quality threshold: ${sourceRef.sourceCandidateId}`);
      return false;
    }

    if (sourceRef.evidenceItemIds.length === 0) {
      warnings.push(`${itemLabel}: evidenceItemIds missing for sourceCandidateId: ${sourceRef.sourceCandidateId}`);
      return false;
    }

    for (const evidenceItemId of sourceRef.evidenceItemIds) {
      const evidenceItem = evidenceMap[evidenceItemId];
      if (!evidenceItem) {
        warnings.push(`${itemLabel}: evidenceItemId missing: ${evidenceItemId}`);
        return false;
      }

      if (evidenceItem.sourceCandidateId !== sourceRef.sourceCandidateId) {
        warnings.push(
          `${itemLabel}: evidenceItemId ${evidenceItemId} belongs to ${evidenceItem.sourceCandidateId}, not ${sourceRef.sourceCandidateId}`
        );
        return false;
      }

      if (evidenceItem.confidence < MIN_FINAL_EVIDENCE_CONFIDENCE) {
        warnings.push(`${itemLabel}: evidenceItemId below confidence threshold: ${evidenceItemId}`);
        return false;
      }

      if (
        evidenceItem.isExperienceEvidence &&
        evidenceItem.confidence >= MIN_PERSONA_EVIDENCE_CONFIDENCE
      ) {
        hasExperienceEvidence = true;
      }
    }
  }

  if (requireExperienceEvidence && !hasExperienceEvidence) {
    warnings.push(`${itemLabel}: persona missing experience evidence`);
    return false;
  }

  return true;
}

function toProductionSource(candidate: CandidateItem): ProductionFinalResultSource {
  return {
    id: candidate.id,
    sourceCandidateId: candidate.id,
    rawSourceId: candidate.sourceId,
    provider: candidate.provider,
    type: candidate.type ?? "",
    title: candidate.title,
    author: candidate.author,
    url: candidate.url,
    excerpt: candidate.excerpt,
    score: candidate.score,
    normalizedSearchScore: candidate.normalizedSearchScore,
    relevanceScore: candidate.relevanceScore,
    experienceScore: candidate.experienceScore,
    qualityScore: candidate.qualityScore,
    qualitySignals: candidate.qualitySignals,
    selectedForEvidence: candidate.selectedForEvidence,
    rejectReason: candidate.rejectReason ?? null
  };
}

function toProductionEvidenceItem(item: EvidenceInputItem): ProductionEvidenceItem {
  return {
    id: item.id,
    sourceCandidateId: item.sourceCandidateId || item.candidateId,
    title: item.title,
    author: item.author,
    sourceUrl: item.sourceUrl,
    evidenceText: item.evidenceText,
    excerpt: item.excerpt,
    reason: item.reason,
    normalizedClaim: item.normalizedClaim,
    supportType: item.supportType,
    isExperienceEvidence: item.isExperienceEvidence,
    confidence: item.confidence
  };
}

function groupEvidenceByCandidateId(
  evidenceItems: EvidenceInputItem[]
): Map<string, EvidenceInputItem[]> {
  const result = new Map<string, EvidenceInputItem[]>();
  for (const item of evidenceItems) {
    const group = result.get(item.candidateId) ?? [];
    group.push(item);
    result.set(item.candidateId, group);
  }

  return result;
}

function toEvidenceInputItem(item: EvidenceItem, index: number): EvidenceInputItem {
  return {
    ...item,
    id: item.id || `evidence_${hashSafeId(item.candidateId || item.sourceUrl || item.title)}_${index + 1}`
  };
}

function calculateConfidence(
  sourceRefs: ProductionSourceRef[],
  candidateById: Map<string, CandidateItem>,
  evidenceById: Map<string, EvidenceInputItem>
): number {
  const candidateScores = sourceRefs
    .map((sourceRef) => candidateById.get(sourceRef.sourceCandidateId)?.qualityScore)
    .filter(isNumber);
  const evidenceScores = sourceRefs
    .flatMap((sourceRef) => sourceRef.evidenceItemIds)
    .map((evidenceId) => evidenceById.get(evidenceId)?.confidence)
    .filter(isNumber);
  const scores = [...candidateScores, ...evidenceScores];
  if (scores.length === 0) {
    return 0;
  }

  return clampScore(scores.reduce((sum, score) => sum + score, 0) / scores.length);
}

function buildQualityReport(input: {
  paths: ProductionFinalResultPath[];
  personas: ProductionFinalResultPersona[];
  evidenceSamples: ProductionEvidenceSample[];
  invalidEvidenceSampleIds: string[];
  candidateById: Map<string, CandidateItem>;
  evidenceMap: Record<string, ProductionEvidenceItem>;
}): DeterministicGroundingReport["qualityReport"] {
  const referencedSourceRefs = [...input.paths, ...input.personas].flatMap((item) => item.sourceRefs);
  const referencedCandidateIds = uniqueNonEmpty(referencedSourceRefs.map((sourceRef) => sourceRef.sourceCandidateId));
  const referencedEvidenceIds = uniqueNonEmpty(
    [
      ...referencedSourceRefs.flatMap((sourceRef) => sourceRef.evidenceItemIds),
      ...input.evidenceSamples.map((sample) => sample.evidenceItemId)
    ]
  );
  const lowQualityCandidateIds = referencedCandidateIds.filter(
    (candidateId) => !isCandidateAllowedInFinal(input.candidateById.get(candidateId))
  );
  const lowConfidenceEvidenceIds = referencedEvidenceIds.filter((evidenceId) => {
    const item = input.evidenceMap[evidenceId];
    return !item || item.confidence < MIN_FINAL_EVIDENCE_CONFIDENCE;
  });
  const personaWithoutExperienceEvidenceIds = input.personas
    .filter((persona) => !hasExperienceEvidence(persona.sourceRefs, input.evidenceMap))
    .map((persona) => persona.id);
  const pathWithoutEvidenceIds = input.paths
    .filter((path) => path.sourceRefs.every((sourceRef) => sourceRef.evidenceItemIds.length === 0))
    .map((path) => path.id);

  return {
    checked: true,
    minCandidateQualityScore: MIN_FINAL_CANDIDATE_QUALITY_SCORE,
    minEvidenceConfidence: MIN_FINAL_EVIDENCE_CONFIDENCE,
    minPersonaEvidenceConfidence: MIN_PERSONA_EVIDENCE_CONFIDENCE,
    minDisplayEvidenceSampleCount: MIN_DISPLAY_EVIDENCE_SAMPLE_COUNT,
    lowQualityCandidateIds,
    lowConfidenceEvidenceIds,
    personaWithoutExperienceEvidenceIds,
    pathWithoutEvidenceIds,
    invalidEvidenceSampleIds: input.invalidEvidenceSampleIds
  };
}

function hasExperienceEvidence(
  sourceRefs: ProductionSourceRef[],
  evidenceMap: Record<string, ProductionEvidenceItem>
): boolean {
  return sourceRefs
    .flatMap((sourceRef) => sourceRef.evidenceItemIds)
    .some((evidenceId) => {
      const item = evidenceMap[evidenceId];
      return Boolean(
        item?.isExperienceEvidence && item.confidence >= MIN_PERSONA_EVIDENCE_CONFIDENCE
      );
    });
}

function isCandidateAllowedInFinal(candidate: CandidateItem | undefined): boolean {
  return Boolean(
    candidate &&
      candidate.selectedForEvidence &&
      candidate.qualityScore >= MIN_FINAL_CANDIDATE_QUALITY_SCORE
  );
}

function stableId(prefix: string, value: string): string {
  return `${prefix}_${createHash("sha1").update(value).digest("hex").slice(0, 12)}`;
}

function hashSafeId(value: string): string {
  const normalized = value.replace(/[^a-zA-Z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  return normalized.slice(0, 48) || "item";
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

function clampScore(value: number): number {
  return Math.min(Math.max(Number(value.toFixed(2)), 0), 1);
}

function isNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function truncateText(value: string, maxLength: number): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }

  return `${normalized.slice(0, Math.max(maxLength - 1, 0))}…`;
}

function isProductionPath(value: unknown): value is ProductionFinalResultPath {
  if (!isRecord(value)) {
    return false;
  }

  return (
    typeof value.id === "string" &&
    typeof value.title === "string" &&
    typeof value.summary === "string" &&
    (value.angle === undefined || typeof value.angle === "string") &&
    (value.coreChoice === undefined || typeof value.coreChoice === "string") &&
    (value.suitableFor === undefined || isStringArray(value.suitableFor)) &&
    (value.prerequisites === undefined || isStringArray(value.prerequisites)) &&
    (value.benefits === undefined || isStringArray(value.benefits)) &&
    (value.costsOrRisks === undefined || isStringArray(value.costsOrRisks)) &&
    (value.evidenceIds === undefined || isStringArray(value.evidenceIds)) &&
    (value.sourceIds === undefined || isStringArray(value.sourceIds)) &&
    (value.suitableContext === undefined || typeof value.suitableContext === "string") &&
    (value.tradeoffs === undefined || typeof value.tradeoffs === "string") &&
    Array.isArray(value.sourceRefs) &&
    value.sourceRefs.every(isProductionSourceRef) &&
    typeof value.confidence === "number"
  );
}

function isProductionPersona(value: unknown): value is ProductionFinalResultPersona {
  if (!isRecord(value)) {
    return false;
  }

  return (
    typeof value.id === "string" &&
    typeof value.displayLabel === "string" &&
    typeof value.summary === "string" &&
    typeof value.chatEnabled === "boolean" &&
    Array.isArray(value.sourceRefs) &&
    value.sourceRefs.every(isProductionSourceRef) &&
    typeof value.confidence === "number" &&
    typeof value.boundary === "string"
  );
}

function isProductionSourceRef(value: unknown): value is ProductionSourceRef {
  if (!isRecord(value)) {
    return false;
  }

  return typeof value.sourceCandidateId === "string" && isStringArray(value.evidenceItemIds);
}

function isProductionSource(value: unknown): value is ProductionFinalResultSource {
  if (!isRecord(value)) {
    return false;
  }

  return (
    typeof value.id === "string" &&
    typeof value.sourceCandidateId === "string" &&
    typeof value.rawSourceId === "string" &&
    typeof value.provider === "string" &&
    typeof value.type === "string" &&
    typeof value.title === "string" &&
    typeof value.author === "string" &&
    typeof value.url === "string" &&
    typeof value.excerpt === "string" &&
    typeof value.score === "number" &&
    typeof value.normalizedSearchScore === "number" &&
    typeof value.relevanceScore === "number" &&
    typeof value.experienceScore === "number" &&
    typeof value.qualityScore === "number" &&
    isStringArray(value.qualitySignals) &&
    typeof value.selectedForEvidence === "boolean" &&
    (value.rejectReason === null || typeof value.rejectReason === "string")
  );
}

function isProductionEvidenceItem(value: unknown): value is ProductionEvidenceItem {
  if (!isRecord(value)) {
    return false;
  }

  return (
    typeof value.id === "string" &&
    typeof value.sourceCandidateId === "string" &&
    typeof value.title === "string" &&
    typeof value.author === "string" &&
    typeof value.sourceUrl === "string" &&
    typeof value.evidenceText === "string" &&
    typeof value.excerpt === "string" &&
    typeof value.reason === "string" &&
    typeof value.normalizedClaim === "string" &&
    isEvidenceSupportType(value.supportType) &&
    typeof value.isExperienceEvidence === "boolean" &&
    typeof value.confidence === "number" &&
    (value.situation === undefined || typeof value.situation === "string") &&
    (value.choice === undefined || typeof value.choice === "string") &&
    (value.process === undefined || typeof value.process === "string") &&
    (value.outcome === undefined || typeof value.outcome === "string") &&
    (value.costOrRisk === undefined || typeof value.costOrRisk === "string") &&
    (value.takeaway === undefined || typeof value.takeaway === "string")
  );
}

function isProductionEvidenceSample(value: unknown): value is ProductionEvidenceSample {
  if (!isRecord(value)) {
    return false;
  }

  const hasV2Text =
    typeof value.snippet === "string" &&
    typeof value.whyRelevant === "string" &&
    isProductionEvidenceSampleType(value.sampleType);
  const hasDeprecatedV1Text =
    typeof value.situation === "string" &&
    typeof value.choice === "string" &&
    typeof value.keyExperience === "string" &&
    typeof value.judgment === "string" &&
    typeof value.referenceValue === "string" &&
    typeof value.limit === "string" &&
    typeof value.evidenceText === "string";

  return (
    typeof value.id === "string" &&
    typeof value.sourceCandidateId === "string" &&
    typeof value.evidenceItemId === "string" &&
    typeof value.title === "string" &&
    typeof value.author === "string" &&
    typeof value.sourceUrl === "string" &&
    (hasV2Text || hasDeprecatedV1Text) &&
    (value.supportType === undefined || isEvidenceSupportType(value.supportType)) &&
    (value.isExperienceEvidence === undefined || typeof value.isExperienceEvidence === "boolean") &&
    typeof value.confidence === "number"
  );
}

function isProductionEvidenceSampleType(value: unknown): value is ProductionEvidenceSampleType {
  return value === "experience" || value === "decision" || value === "opinion" || value === "context";
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

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
