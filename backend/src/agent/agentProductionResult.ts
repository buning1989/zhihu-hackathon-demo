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

export interface ProductionSourceRef {
  sourceCandidateId: string;
  evidenceItemIds: string[];
}

export interface ProductionFinalResultPath {
  id: string;
  title: string;
  summary: string;
  suitableContext: string;
  tradeoffs: string;
  sourceRefs: ProductionSourceRef[];
  confidence: number;
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
    lowQualityCandidateIds: string[];
    lowConfidenceEvidenceIds: string[];
    personaWithoutExperienceEvidenceIds: string[];
    pathWithoutEvidenceIds: string[];
  };
}

export interface ProductionFinalResultData {
  schemaVersion: "agent.production_final_result.v1";
  taskId: string;
  summary: string;
  paths: ProductionFinalResultPath[];
  personas: ProductionFinalResultPersona[];
  sources: ProductionFinalResultSource[];
  evidenceMap: Record<string, ProductionEvidenceItem>;
  groundingReport: {
    llmGuard: GroundingGuardReport;
    deterministicValidator: DeterministicGroundingReport;
  };
  degraded: boolean;
  degradedReason: string | null;
  suggestedQuestions: string[];
  meta: {
    generatedAt: string;
    sourcePolicy: string;
    originalResultSchemaVersion: FinalResultArtifactData["schemaVersion"];
  };
}

interface BuildProductionFinalResultInput {
  taskId: string;
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
  const evidenceMap = Object.fromEntries(
    evidenceItems.map((item) => [item.id, toProductionEvidenceItem(item)])
  );
  const builtPaths = input.finalResult.paths.map((path, index) =>
    toProductionPath(path, index, candidateById, evidenceById, evidenceByCandidateId)
  );
  const builtPersonas = input.finalResult.people.map((person, index) =>
    toProductionPersona(person, index, candidateById, evidenceById, evidenceByCandidateId)
  );
  const validation = validateProductionItems({
    paths: builtPaths,
    personas: builtPersonas,
    sourceIds: new Set(sources.map((source) => source.sourceCandidateId)),
    candidateById,
    evidenceMap
  });
  const degradedReasons = uniqueNonEmpty([
    ...(input.degradedReasons ?? []),
    input.finalResult.fallbackReason ?? "",
    getGroundingGuardDegradedReason(input.guard),
    validation.status === "passed" ? "" : `deterministic_validator_${validation.status}`
  ]);

  return {
    schemaVersion: "agent.production_final_result.v1",
    taskId: input.taskId,
    summary: input.finalResult.summary,
    paths: validation.paths,
    personas: validation.personas,
    sources,
    evidenceMap,
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

  return (
    value.schemaVersion === "agent.production_final_result.v1" &&
    typeof value.taskId === "string" &&
    typeof value.summary === "string" &&
    Array.isArray(value.paths) &&
    value.paths.every(isProductionPath) &&
    Array.isArray(value.personas) &&
    value.personas.every(isProductionPersona) &&
    Array.isArray(value.sources) &&
    value.sources.every(isProductionSource) &&
    isRecord(value.evidenceMap) &&
    Object.values(value.evidenceMap).every(isProductionEvidenceItem) &&
    isRecord(value.groundingReport) &&
    typeof value.degraded === "boolean" &&
    (value.degradedReason === null || typeof value.degradedReason === "string")
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
    suitableContext: path.summary,
    tradeoffs: "Only public content snippets are available, so this path is a comparison sample rather than advice.",
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

function validateProductionItems(input: {
  paths: ProductionFinalResultPath[];
  personas: ProductionFinalResultPersona[];
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
  const warnings: string[] = [];
  const removedPathIds: string[] = [];
  const removedPersonaIds: string[] = [];
  const paths = input.paths.filter((path) => {
    const valid = validateSourceRefs({
      sourceRefs: path.sourceRefs,
      sourceIds: input.sourceIds,
      candidateById: input.candidateById,
      evidenceMap: input.evidenceMap,
      warnings,
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
      warnings,
      itemLabel: persona.id,
      requireExperienceEvidence: true
    });
    if (!valid) {
      removedPersonaIds.push(persona.id);
    }
    return valid;
  });
  const qualityReport = buildQualityReport({
    paths,
    personas,
    candidateById: input.candidateById,
    evidenceMap: input.evidenceMap
  });

  const status =
    warnings.length === 0 && removedPathIds.length === 0 && removedPersonaIds.length === 0
      ? "passed"
      : paths.length > 0 || personas.length > 0
        ? "repaired"
        : "failed";

  return {
    status,
    paths,
    personas,
    removedPathIds,
    removedPersonaIds,
    warnings,
    qualityReport
  };
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
  candidateById: Map<string, CandidateItem>;
  evidenceMap: Record<string, ProductionEvidenceItem>;
}): DeterministicGroundingReport["qualityReport"] {
  const referencedSourceRefs = [...input.paths, ...input.personas].flatMap((item) => item.sourceRefs);
  const referencedCandidateIds = uniqueNonEmpty(referencedSourceRefs.map((sourceRef) => sourceRef.sourceCandidateId));
  const referencedEvidenceIds = uniqueNonEmpty(
    referencedSourceRefs.flatMap((sourceRef) => sourceRef.evidenceItemIds)
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
    lowQualityCandidateIds,
    lowConfidenceEvidenceIds,
    personaWithoutExperienceEvidenceIds,
    pathWithoutEvidenceIds
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

function isProductionPath(value: unknown): value is ProductionFinalResultPath {
  if (!isRecord(value)) {
    return false;
  }

  return (
    typeof value.id === "string" &&
    typeof value.title === "string" &&
    typeof value.summary === "string" &&
    typeof value.suitableContext === "string" &&
    typeof value.tradeoffs === "string" &&
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
    typeof value.confidence === "number"
  );
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
