import { createHash } from "node:crypto";
import type {
  PersistentAgentArtifact,
  PersistentAgentEvent,
  PersistentAgentStageRun,
  PersistentAgentTask,
  PersistentAgentTaskSnapshot
} from "./agentModels.js";
import type {
  CandidatesArtifactData,
  EvidenceArtifactData,
  GroundingGuardReport,
  RawSourcesArtifactData
} from "./stages/stageTypes.js";
import {
  AGENT_ARTIFACT_CANDIDATES,
  AGENT_ARTIFACT_EVIDENCE,
  AGENT_ARTIFACT_PRODUCTION_FINAL_RESULT,
  AGENT_ARTIFACT_RAW_SOURCES
} from "./stages/stageTypes.js";
import {
  isProductionFinalResultData,
  type ProductionFinalResultData
} from "./agentProductionResult.js";

const PREVIEW_LIMIT = 120;
const EVENT_LIMIT = 50;
const ARTIFACT_ITEM_LIMIT = 20;
const SENSITIVE_KEY_PARTS = [
  "anonymousid",
  "authorization",
  "cookie",
  "ip",
  "secret",
  "token"
];

export interface PersistentAgentTaskDebugData {
  task: {
    id: string;
    status: PersistentAgentTask["status"];
    currentStage: string | null;
    progress: number;
    queryPreview: string;
    queryLength: number;
    queryHash: string;
    userIdPresent: boolean;
    metadata: Record<string, unknown>;
    createdAt: string;
    updatedAt: string;
    startedAt: string | null;
    completedAt: string | null;
    expiresAt: string | null;
  };
  stages: Array<{
    id: string;
    name: string;
    status: PersistentAgentStageRun["status"];
    attempt: number;
    fallbackUsed: boolean;
    fallbackReason: string | null;
    cacheHit: boolean;
    cacheKey: string | null;
    model: string | null;
    startedAt: string | null;
    endedAt: string | null;
    durationMs: number | null;
    outputArtifactIds: string[];
    errorCode: string | null;
    errorMessage: string | null;
  }>;
  events: {
    count: number;
    items: Array<{
      id: string;
      type: string;
      createdAt: string;
      payload: Record<string, unknown>;
    }>;
  };
  artifacts: {
    count: number;
    byType: Record<string, number>;
    items: Array<{
      id: string;
      type: string;
      createdAt: string;
      summary: Record<string, unknown>;
    }>;
  };
  summaries: {
    rawSources: ReturnType<typeof summarizeRawSources> | null;
    candidates: ReturnType<typeof summarizeCandidates> | null;
    evidence: ReturnType<typeof summarizeEvidence> | null;
    productionFinalResult: ReturnType<typeof summarizeProductionFinalResult> | null;
  };
  groundingReport: ProductionFinalResultData["groundingReport"] | GroundingGuardReport | null;
  cache: {
    queryCacheKey: string | null;
    cacheIdentity: Record<string, unknown> | null;
    cacheHitEventCount: number;
    cacheHitStages: string[];
    reusedEventCount: number;
    reusedReasons: string[];
  };
  errorCode: string | null;
  errorMessage: string | null;
  failedStage: string | null;
  totalDurationMs: number | null;
}

export function buildPersistentAgentTaskDebugData(
  snapshot: PersistentAgentTaskSnapshot
): PersistentAgentTaskDebugData {
  const productionResult = findLatestProductionResult(snapshot.artifacts);
  const latestRawSources = readLatestArtifactData(
    snapshot.artifacts,
    AGENT_ARTIFACT_RAW_SOURCES,
    isRawSourcesArtifactData
  );
  const latestCandidates = readLatestArtifactData(
    snapshot.artifacts,
    AGENT_ARTIFACT_CANDIDATES,
    isCandidatesArtifactData
  );
  const latestEvidence = readLatestArtifactData(
    snapshot.artifacts,
    AGENT_ARTIFACT_EVIDENCE,
    isEvidenceArtifactData
  );
  const cacheHitEvents = snapshot.events.filter((event) => event.type === "stage.cache_hit");
  const cacheHitByStageName = buildCacheHitByStageName(cacheHitEvents);
  const reusedEvents = snapshot.events.filter((event) => event.type === "task.reused");
  const failedStage = findFailedStage(snapshot.stages, snapshot.task);
  const errorMessage =
    readString(snapshot.task.metadata.errorMessage) ||
    snapshot.task.error ||
    failedStage?.error ||
    null;

  return {
    task: {
      id: snapshot.task.id,
      status: snapshot.task.status,
      currentStage: snapshot.task.currentStage,
      progress: snapshot.task.progress,
      queryPreview: previewString(snapshot.task.query),
      queryLength: snapshot.task.query.length,
      queryHash: hashString(snapshot.task.query),
      userIdPresent: Boolean(snapshot.task.userId),
      metadata: sanitizeMetadata(snapshot.task.metadata),
      createdAt: snapshot.task.createdAt,
      updatedAt: snapshot.task.updatedAt,
      startedAt: snapshot.task.startedAt,
      completedAt: snapshot.task.completedAt,
      expiresAt: snapshot.task.expiresAt
    },
    stages: snapshot.stages.map((stage) => summarizeStage(stage, cacheHitByStageName)),
    events: summarizeEvents(snapshot.events),
    artifacts: summarizeArtifacts(snapshot.artifacts),
    summaries: {
      rawSources: latestRawSources ? summarizeRawSources(latestRawSources) : null,
      candidates: latestCandidates ? summarizeCandidates(latestCandidates) : null,
      evidence: latestEvidence ? summarizeEvidence(latestEvidence) : null,
      productionFinalResult: productionResult ? summarizeProductionFinalResult(productionResult) : null
    },
    groundingReport: productionResult?.groundingReport ?? null,
    cache: {
      queryCacheKey: readNullableString(snapshot.task.metadata.queryCacheKey),
      cacheIdentity: sanitizeCacheIdentity(snapshot.task.metadata.cacheIdentity),
      cacheHitEventCount: cacheHitEvents.length,
      cacheHitStages: uniqueNonEmpty(cacheHitEvents.map((event) => readString(event.payload.stageName))),
      reusedEventCount: reusedEvents.length,
      reusedReasons: uniqueNonEmpty(reusedEvents.map((event) => readString(event.payload.reusedReason)))
    },
    errorCode: readNullableString(snapshot.task.metadata.errorCode) ?? (errorMessage ? "AGENT_TASK_FAILED" : null),
    errorMessage,
    failedStage: failedStage?.stageName ?? (snapshot.task.status === "failed" ? snapshot.task.currentStage : null),
    totalDurationMs: calculateDurationMs(snapshot.task.startedAt ?? snapshot.task.createdAt, snapshot.task.completedAt)
  };
}

function summarizeStage(
  stage: PersistentAgentStageRun,
  cacheHitByStageName: Map<string, string>
): PersistentAgentTaskDebugData["stages"][number] {
  const cacheKey = cacheHitByStageName.get(stage.stageName) ?? null;

  return {
    id: stage.id,
    name: stage.stageName,
    status: stage.status,
    attempt: stage.attempt,
    fallbackUsed: stage.fallbackUsed,
    fallbackReason: stage.fallbackReason,
    cacheHit: Boolean(cacheKey),
    cacheKey,
    model: stage.model,
    startedAt: stage.startedAt,
    endedAt: stage.endedAt,
    durationMs: stage.durationMs,
    outputArtifactIds: stage.outputArtifactIds,
    errorCode: stage.error ? "AGENT_STAGE_FAILED" : null,
    errorMessage: stage.error
  };
}

function buildCacheHitByStageName(events: PersistentAgentEvent[]): Map<string, string> {
  const result = new Map<string, string>();
  for (const event of events) {
    const stageName = readString(event.payload.stageName);
    if (stageName) {
      result.set(stageName, readString(event.payload.cacheKey));
    }
  }

  return result;
}

function summarizeEvents(events: PersistentAgentEvent[]): PersistentAgentTaskDebugData["events"] {
  const items = events.slice(-EVENT_LIMIT).map((event) => ({
    id: event.id,
    type: event.type,
    createdAt: event.createdAt,
    payload: sanitizePayload(event.payload)
  }));

  return {
    count: events.length,
    items
  };
}

function summarizeArtifacts(artifacts: PersistentAgentArtifact[]): PersistentAgentTaskDebugData["artifacts"] {
  const byType: Record<string, number> = {};
  for (const artifact of artifacts) {
    byType[artifact.type] = (byType[artifact.type] ?? 0) + 1;
  }

  return {
    count: artifacts.length,
    byType,
    items: artifacts.slice(-ARTIFACT_ITEM_LIMIT).map((artifact) => ({
      id: artifact.id,
      type: artifact.type,
      createdAt: artifact.createdAt,
      summary: summarizeArtifactData(artifact)
    }))
  };
}

function summarizeArtifactData(artifact: PersistentAgentArtifact): Record<string, unknown> {
  if (artifact.type === AGENT_ARTIFACT_RAW_SOURCES && isRawSourcesArtifactData(artifact.data)) {
    return summarizeRawSources(artifact.data);
  }

  if (artifact.type === AGENT_ARTIFACT_CANDIDATES && isCandidatesArtifactData(artifact.data)) {
    return summarizeCandidates(artifact.data);
  }

  if (artifact.type === AGENT_ARTIFACT_EVIDENCE && isEvidenceArtifactData(artifact.data)) {
    return summarizeEvidence(artifact.data);
  }

  if (
    artifact.type === AGENT_ARTIFACT_PRODUCTION_FINAL_RESULT &&
    isProductionFinalResultData(artifact.data)
  ) {
    return summarizeProductionFinalResult(artifact.data);
  }

  return {
    dataType: Array.isArray(artifact.data) ? "array" : typeof artifact.data,
    keyCount: isRecord(artifact.data) ? Object.keys(artifact.data).length : null
  };
}

function summarizeRawSources(data: RawSourcesArtifactData) {
  return {
    queryPreview: previewString(data.query),
    expandedQueryCount: data.expandedQueries.length,
    sourceCount: data.sources.length,
    declaredSourceCount: data.sourceCount,
    provider: data.provider,
    fallbackUsed: data.fallbackUsed,
    fallbackReason: data.fallbackReason ?? null,
    sources: data.sources.slice(0, 10).map((source) => ({
      sourceId: source.sourceId,
      provider: source.provider,
      type: source.type,
      titlePreview: previewString(source.title),
      authorPreview: previewString(source.author, 40),
      url: source.url,
      score: source.score,
      excerptPreview: previewString(source.excerpt)
    }))
  };
}

function summarizeCandidates(data: CandidatesArtifactData) {
  const selected = data.candidates.filter((candidate) => candidate.selectedForEvidence);
  const lowQualityCandidateIds = data.qualityReport?.lowQualityCandidateIds ?? [];

  return {
    candidateCount: data.candidates.length,
    declaredCandidateCount: data.candidateCount,
    sourceCount: data.sourceCount ?? null,
    selectedForEvidenceCount: selected.length,
    rejectedCount: data.qualityReport?.rejectedCount ?? data.candidates.length - selected.length,
    avgRelevanceScore: average(data.candidates.map((candidate) => candidate.relevanceScore)),
    avgExperienceScore: average(data.candidates.map((candidate) => candidate.experienceScore)),
    avgQualityScore: average(data.candidates.map((candidate) => candidate.qualityScore)),
    lowQualityCandidateIds,
    rejectReasonCounts: data.qualityReport?.rejectReasonCounts ?? {},
    selectedCandidates: selected.slice(0, 10).map((candidate) => ({
      id: candidate.id,
      sourceId: candidate.sourceId,
      provider: candidate.provider,
      titlePreview: previewString(candidate.title),
      relevanceScore: candidate.relevanceScore,
      experienceScore: candidate.experienceScore,
      qualityScore: candidate.qualityScore,
      qualitySignals: candidate.qualitySignals.slice(0, 8)
    }))
  };
}

function summarizeEvidence(data: EvidenceArtifactData) {
  const experienceEvidence = data.evidenceItems.filter((item) => item.isExperienceEvidence);

  return {
    evidenceCount: data.evidenceItems.length,
    experienceEvidenceCount: experienceEvidence.length,
    lowConfidenceEvidenceIds: data.qualityReport?.lowConfidenceEvidenceIds ?? [],
    invalidCandidateEvidenceCount: data.qualityReport?.invalidCandidateEvidenceCount ?? 0,
    strategy: data.strategy,
    llmUsed: data.llmUsed,
    fallbackReason: data.fallbackReason ?? null,
    evidenceItems: data.evidenceItems.slice(0, 12).map((item) => ({
      id: item.id,
      sourceCandidateId: item.sourceCandidateId,
      supportType: item.supportType,
      isExperienceEvidence: item.isExperienceEvidence,
      confidence: item.confidence,
      normalizedClaimPreview: previewString(item.normalizedClaim),
      excerptPreview: previewString(item.excerpt)
    }))
  };
}

function summarizeProductionFinalResult(data: ProductionFinalResultData) {
  const qualityReport = data.groundingReport.deterministicValidator.qualityReport;

  return {
    schemaVersion: data.schemaVersion,
    taskId: data.taskId,
    summaryPreview: previewString(data.summary),
    pathCount: data.paths.length,
    personaCount: data.personas.length,
    sourceCount: data.sources.length,
    evidenceCount: Object.keys(data.evidenceMap).length,
    degraded: data.degraded,
    degradedReason: data.degradedReason,
    deterministicValidatorStatus: data.groundingReport.deterministicValidator.status,
    lowQualityCandidateCount: qualityReport.lowQualityCandidateIds.length,
    lowConfidenceEvidenceCount: qualityReport.lowConfidenceEvidenceIds.length,
    personaWithoutExperienceEvidenceCount: qualityReport.personaWithoutExperienceEvidenceIds.length,
    pathWithoutEvidenceCount: qualityReport.pathWithoutEvidenceIds.length,
    paths: data.paths.slice(0, 10).map((path) => ({
      id: path.id,
      titlePreview: previewString(path.title),
      confidence: path.confidence,
      sourceRefCount: path.sourceRefs.length,
      evidenceRefCount: path.sourceRefs.reduce((count, ref) => count + ref.evidenceItemIds.length, 0)
    })),
    personas: data.personas.slice(0, 10).map((persona) => ({
      id: persona.id,
      displayLabelPreview: previewString(persona.displayLabel, 80),
      chatEnabled: persona.chatEnabled,
      confidence: persona.confidence,
      sourceRefCount: persona.sourceRefs.length,
      evidenceRefCount: persona.sourceRefs.reduce((count, ref) => count + ref.evidenceItemIds.length, 0)
    }))
  };
}

function findLatestProductionResult(
  artifacts: PersistentAgentArtifact[]
): ProductionFinalResultData | undefined {
  return readLatestArtifactData(
    artifacts,
    AGENT_ARTIFACT_PRODUCTION_FINAL_RESULT,
    isProductionFinalResultData
  );
}

function readLatestArtifactData<TData>(
  artifacts: PersistentAgentArtifact[],
  type: string,
  guard: (value: unknown) => value is TData
): TData | undefined {
  const artifact = [...artifacts].reverse().find((item) => item.type === type);
  return artifact && guard(artifact.data) ? artifact.data : undefined;
}

function findFailedStage(
  stages: PersistentAgentStageRun[],
  task: PersistentAgentTask
): PersistentAgentStageRun | undefined {
  return [...stages].reverse().find((stage) =>
    ["failed", "failed_final", "failed_retryable"].includes(stage.status)
  ) ?? stages.find((stage) => stage.stageName === task.currentStage);
}

function sanitizeMetadata(metadata: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(metadata)) {
    if (key === "cacheIdentity") {
      result.cacheIdentity = sanitizeCacheIdentity(value);
      continue;
    }

    if (key === "originalQuery" || key === "normalizedQuery") {
      result[`${key}Preview`] = previewString(readString(value));
      result[`${key}Hash`] = hashString(readString(value));
      continue;
    }

    if (key === "actorHash" || isSensitiveKey(key)) {
      continue;
    }

    result[key] = sanitizeValue(value);
  }

  return result;
}

function sanitizeCacheIdentity(value: unknown): Record<string, unknown> | null {
  if (!isRecord(value)) {
    return null;
  }

  return {
    normalizedQueryPreview: previewString(readString(value.normalizedQuery)),
    normalizedQueryHash: hashString(readString(value.normalizedQuery)),
    metadataHash: readNullableString(value.metadataHash),
    dataMode: readNullableString(value.dataMode),
    provider: readNullableString(value.provider),
    schemaVersion: readNullableString(value.schemaVersion),
    promptVersion: readNullableString(value.promptVersion),
    scoringVersion: readNullableString(value.scoringVersion)
  };
}

function sanitizePayload(payload: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(payload)) {
    if (key === "query") {
      result.queryPreview = previewString(readString(value));
      result.queryHash = hashString(readString(value));
      continue;
    }

    if (isSensitiveKey(key)) {
      continue;
    }

    result[key] = sanitizeValue(value);
  }

  return result;
}

function sanitizeValue(value: unknown): unknown {
  if (typeof value === "string") {
    return previewString(value, 160);
  }

  if (Array.isArray(value)) {
    return value.slice(0, 20).map(sanitizeValue);
  }

  if (isRecord(value)) {
    const result: Record<string, unknown> = {};
    for (const [key, nestedValue] of Object.entries(value)) {
      if (isSensitiveKey(key)) {
        continue;
      }

      result[key] = sanitizeValue(nestedValue);
    }
    return result;
  }

  return value;
}

function isSensitiveKey(key: string): boolean {
  const normalized = key.toLowerCase();
  return SENSITIVE_KEY_PARTS.some((part) => normalized.includes(part));
}

function previewString(value: string, limit = PREVIEW_LIMIT): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length > limit ? `${normalized.slice(0, limit)}...` : normalized;
}

function calculateDurationMs(startedAt: string | null, completedAt: string | null): number | null {
  if (!startedAt || !completedAt) {
    return null;
  }

  const start = Date.parse(startedAt);
  const end = Date.parse(completedAt);
  return Number.isFinite(start) && Number.isFinite(end) && end >= start ? end - start : null;
}

function average(values: number[]): number | null {
  const finiteValues = values.filter(Number.isFinite);
  if (finiteValues.length === 0) {
    return null;
  }

  return roundNumber(finiteValues.reduce((sum, value) => sum + value, 0) / finiteValues.length);
}

function roundNumber(value: number): number {
  return Math.round(value * 100) / 100;
}

function uniqueNonEmpty(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function hashString(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function readString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function readNullableString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function isRawSourcesArtifactData(value: unknown): value is RawSourcesArtifactData {
  return Boolean(
    isRecord(value) &&
      typeof value.query === "string" &&
      Array.isArray(value.expandedQueries) &&
      Array.isArray(value.sources)
  );
}

function isCandidatesArtifactData(value: unknown): value is CandidatesArtifactData {
  return Boolean(isRecord(value) && Array.isArray(value.candidates));
}

function isEvidenceArtifactData(value: unknown): value is EvidenceArtifactData {
  return Boolean(isRecord(value) && Array.isArray(value.evidenceItems));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
