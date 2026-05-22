import type {
  PersistentAgentArtifact,
  PersistentAgentStageRun,
  PersistentAgentTask,
  PersistentAgentTaskSnapshot,
  PersistentAgentTaskStatus
} from "./agentModels.js";
import {
  buildProductionFinalResult,
  isProductionFinalResultData,
  type ProductionFinalResultData
} from "./agentProductionResult.js";
import {
  isAgentNeedInputPayload,
  type AgentNeedInputPayload
} from "./agentClarification.js";
import {
  AGENT_ARTIFACT_CANDIDATES,
  AGENT_ARTIFACT_EVIDENCE,
  AGENT_ARTIFACT_FINAL_RESULT,
  AGENT_ARTIFACT_GUARDED_FINAL_RESULT,
  AGENT_ARTIFACT_PRODUCTION_FINAL_RESULT,
  AGENT_STAGE_EVIDENCE_EXTRACT_LLM,
  AGENT_STAGE_GROUNDING_GUARD_LLM,
  AGENT_STAGE_NORMALIZE_CANDIDATES,
  AGENT_STAGE_PLAN_SEARCH_LLM,
  AGENT_STAGE_RESPONSE_COMPOSE_LLM,
  AGENT_STAGE_RETRIEVE_SOURCES,
  AGENT_STAGE_UNDERSTAND_GOAL_RULE,
  type CandidatesArtifactData,
  type EvidenceArtifactData,
  type FinalResultArtifactData,
  type GroundingGuardReport,
  type GuardedFinalResultArtifactData
} from "./stages/stageTypes.js";

const POLL_AFTER_MS = 2000;
const STAGE_ORDER = [
  AGENT_STAGE_UNDERSTAND_GOAL_RULE,
  AGENT_STAGE_PLAN_SEARCH_LLM,
  AGENT_STAGE_RETRIEVE_SOURCES,
  AGENT_STAGE_NORMALIZE_CANDIDATES,
  AGENT_STAGE_EVIDENCE_EXTRACT_LLM,
  AGENT_STAGE_RESPONSE_COMPOSE_LLM,
  AGENT_STAGE_GROUNDING_GUARD_LLM
] as const;

const STAGE_LABELS: Record<string, string> = {
  [AGENT_STAGE_UNDERSTAND_GOAL_RULE]: "正在理解你的问题",
  [AGENT_STAGE_PLAN_SEARCH_LLM]: "正在规划检索方向",
  [AGENT_STAGE_RETRIEVE_SOURCES]: "正在查找知乎公开内容",
  [AGENT_STAGE_NORMALIZE_CANDIDATES]: "正在筛选高质量样本",
  [AGENT_STAGE_EVIDENCE_EXTRACT_LLM]: "正在抽取证据片段",
  [AGENT_STAGE_RESPONSE_COMPOSE_LLM]: "正在整理路径和样本",
  [AGENT_STAGE_GROUNDING_GUARD_LLM]: "正在检查证据边界"
};

export interface PersistentAgentTaskStartData {
  taskId: string;
  status: "queued" | "running" | "need_input" | "succeeded";
  frontendStatus: string;
  pollAfterMs: number;
  resultUrl: string;
  queueStatus: "enqueued" | "need_input" | "reused_running" | "reused_succeeded";
  eventsUrl: string;
  needInput?: AgentNeedInputPayload | null;
  cacheHit?: boolean;
  reused?: boolean;
  reusedReason?: "running_task" | "recent_succeeded_task";
  refinedFromTaskId?: string;
}

export interface PersistentAgentTaskStatusData {
  taskId: string;
  status:
    | "created"
    | "queued"
    | "running"
    | "need_input"
    | "partial_ready"
    | "succeeded"
    | "failed"
    | "cancelled"
    | "expired";
  frontendStatus: string;
  progressPercent: number;
  pollAfterMs: number;
  partialAvailable: boolean;
  resultAvailable: boolean;
  needInput: AgentNeedInputPayload | null;
  stages: Array<{
    name: string;
    stageOrder: number;
    status:
      | "waiting"
      | "running"
      | "succeeded"
      | "failed_retryable"
      | "failed_final"
      | "skipped"
      | "degraded";
    attempt: number;
    maxAttempts: number;
    startedAt: string | null;
    finishedAt: string | null;
    latencyMs: number | null;
    errorCode: string | null;
    errorMessage: string | null;
    outputRef: string | null;
  }>;
  degraded: boolean;
  degradedReason: string | null;
  error: {
    errorCode: string;
    errorMessage: string;
  } | null;
}

export function buildPersistentAgentTaskStartData(
  task: PersistentAgentTask,
  options: {
    status?: PersistentAgentTaskStartData["status"];
    queueStatus?: PersistentAgentTaskStartData["queueStatus"];
    cacheHit?: boolean;
    reused?: boolean;
    reusedReason?: PersistentAgentTaskStartData["reusedReason"];
  } = {}
): PersistentAgentTaskStartData {
  return {
    taskId: task.id,
    status: options.status ?? "queued",
    frontendStatus: readString(task.metadata.frontendStatus) || "正在理解你的问题",
    pollAfterMs: options.status === "succeeded" || options.status === "need_input" ? 0 : POLL_AFTER_MS,
    resultUrl: `/api/agent/tasks/${encodeURIComponent(task.id)}/result`,
    queueStatus: options.queueStatus ?? "enqueued",
    eventsUrl: `/api/agent/tasks/${encodeURIComponent(task.id)}/events`,
    ...(readNeedInput(task.metadata) ? { needInput: readNeedInput(task.metadata) } : {}),
    ...(options.cacheHit !== undefined ? { cacheHit: options.cacheHit } : {}),
    ...(options.reused !== undefined ? { reused: options.reused } : {}),
    ...(options.reusedReason ? { reusedReason: options.reusedReason } : {}),
    ...(readString(task.metadata.refinedFromTaskId)
      ? { refinedFromTaskId: readString(task.metadata.refinedFromTaskId) }
      : {})
  };
}

export function buildPersistentAgentTaskStatusData(
  snapshot: PersistentAgentTaskSnapshot
): PersistentAgentTaskStatusData {
  const status = mapTaskStatus(snapshot.task);
  const result = resolveProductionFinalResult(snapshot);
  const partialAvailable =
    readBoolean(snapshot.task.metadata.partialAvailable) ||
    hasAnyArtifact(snapshot, [
      AGENT_ARTIFACT_CANDIDATES,
      AGENT_ARTIFACT_EVIDENCE,
      AGENT_ARTIFACT_FINAL_RESULT,
      AGENT_ARTIFACT_GUARDED_FINAL_RESULT,
      AGENT_ARTIFACT_PRODUCTION_FINAL_RESULT
    ]) ||
    status === "partial_ready" ||
    status === "succeeded";
  const resultAvailable =
    readBoolean(snapshot.task.metadata.resultAvailable) || Boolean(result) || status === "succeeded";
  const stages = buildStatusStages(snapshot.stages);
  const degraded =
    readBoolean(snapshot.task.metadata.degraded) || stages.some((stage) => stage.status === "degraded");
  const degradedReason = readNullableString(snapshot.task.metadata.degradedReason);

  return {
    taskId: snapshot.task.id,
    status,
    frontendStatus: readString(snapshot.task.metadata.frontendStatus) || getFrontendStatus(snapshot.task, status),
    progressPercent: normalizeProgress(snapshot.task.progress),
    pollAfterMs: isTerminalTaskStatus(status) || status === "need_input" ? 0 : POLL_AFTER_MS,
    partialAvailable,
    resultAvailable,
    needInput: readNeedInput(snapshot.task.metadata),
    stages,
    degraded,
    degradedReason,
    error: status === "failed" ? readTaskError(snapshot.task) : null
  };
}

export function buildPersistentAgentTaskPendingResultData(
  snapshot: PersistentAgentTaskSnapshot
): PersistentAgentTaskStatusData {
  return buildPersistentAgentTaskStatusData(snapshot);
}

export function resolveProductionFinalResult(
  snapshot: PersistentAgentTaskSnapshot
): ProductionFinalResultData | undefined {
  const productionArtifact = findLatestArtifact(snapshot, AGENT_ARTIFACT_PRODUCTION_FINAL_RESULT);
  if (productionArtifact && isProductionFinalResultData(productionArtifact.data)) {
    return productionArtifact.data;
  }

  const candidates = readArtifactData(snapshot, AGENT_ARTIFACT_CANDIDATES, isCandidatesArtifactData);
  const evidence = readArtifactData(snapshot, AGENT_ARTIFACT_EVIDENCE, isEvidenceArtifactData);
  const guarded = readArtifactData(
    snapshot,
    AGENT_ARTIFACT_GUARDED_FINAL_RESULT,
    isGuardedFinalResultArtifactData
  );
  const finalResult =
    guarded?.result ?? readArtifactData(snapshot, AGENT_ARTIFACT_FINAL_RESULT, isFinalResultArtifactData);

  if (!candidates || !evidence || !finalResult) {
    return undefined;
  }

  return buildProductionFinalResult({
    taskId: snapshot.task.id,
    finalResult,
    candidates,
    evidence,
    guard: guarded?.guard ?? buildMissingGuardReport()
  });
}

function buildStatusStages(stages: PersistentAgentStageRun[]): PersistentAgentTaskStatusData["stages"] {
  const latestStageByName = new Map<string, PersistentAgentStageRun>();
  for (const stage of stages) {
    latestStageByName.set(stage.stageName, stage);
  }

  return STAGE_ORDER.map((stageName, index) => {
    const stage = latestStageByName.get(stageName);
    const errorMessage = stage?.error ?? null;

    return {
      name: stageName,
      stageOrder: index + 1,
      status: mapStageStatus(stage),
      attempt: stage?.attempt ?? 0,
      maxAttempts: getStageMaxAttempts(stageName),
      startedAt: stage?.startedAt ?? null,
      finishedAt: stage?.endedAt ?? null,
      latencyMs: stage?.durationMs ?? null,
      errorCode: errorMessage ? "AGENT_STAGE_FAILED" : null,
      errorMessage,
      outputRef: stage?.outputArtifactIds[0] ?? null
    };
  });
}

function mapTaskStatus(
  task: PersistentAgentTask
): PersistentAgentTaskStatusData["status"] {
  if (task.expiresAt && Date.parse(task.expiresAt) <= Date.now() && !isTerminalPersistentStatus(task.status)) {
    return "expired";
  }

  if (task.status === "completed") {
    return "succeeded";
  }

  if (isPhaseOneTaskStatus(task.status)) {
    return task.status;
  }

  return task.status === "waiting_retry" ? "running" : "running";
}

function mapStageStatus(
  stage: PersistentAgentStageRun | undefined
): PersistentAgentTaskStatusData["stages"][number]["status"] {
  if (!stage || stage.status === "pending" || stage.status === "waiting") {
    return "waiting";
  }

  if (stage.status === "running") {
    return "running";
  }

  if (stage.status === "retrying" || stage.status === "failed_retryable") {
    return "failed_retryable";
  }

  if (stage.status === "succeeded") {
    return "succeeded";
  }

  if (stage.status === "fallback" || stage.status === "degraded") {
    return "degraded";
  }

  if (stage.status === "skipped") {
    return "skipped";
  }

  return "failed_final";
}

function getFrontendStatus(
  task: PersistentAgentTask,
  status: PersistentAgentTaskStatusData["status"]
): string {
  if (status === "created") {
    return "任务已创建";
  }

  if (status === "queued") {
    return "正在理解你的问题";
  }

  if (status === "need_input") {
    return "需要你补充一点信息";
  }

  if (status === "partial_ready") {
    return "已找到可展示线索，继续检查证据";
  }

  if (status === "succeeded") {
    return "结果已准备好";
  }

  if (status === "failed") {
    return "任务失败";
  }

  if (status === "expired") {
    return "任务已过期";
  }

  return task.currentStage ? STAGE_LABELS[task.currentStage] ?? "正在处理任务" : "正在处理任务";
}

function readTaskError(task: PersistentAgentTask): {
  errorCode: string;
  errorMessage: string;
} {
  return {
    errorCode: readString(task.metadata.errorCode) || "AGENT_TASK_FAILED",
    errorMessage: readString(task.metadata.errorMessage) || task.error || "Agent task failed"
  };
}

function isPhaseOneTaskStatus(
  status: PersistentAgentTaskStatus
): status is PersistentAgentTaskStatusData["status"] {
  return [
    "created",
    "queued",
    "running",
    "need_input",
    "partial_ready",
    "succeeded",
    "failed",
    "cancelled",
    "expired"
  ].includes(status);
}

function isTerminalTaskStatus(status: PersistentAgentTaskStatusData["status"]): boolean {
  return ["succeeded", "failed", "cancelled", "expired"].includes(status);
}

function isTerminalPersistentStatus(status: PersistentAgentTaskStatus): boolean {
  return ["succeeded", "completed", "failed", "cancelled", "expired"].includes(status);
}

function getStageMaxAttempts(stageName: string): number {
  if (stageName === AGENT_STAGE_RETRIEVE_SOURCES) {
    return 3;
  }

  if (
    [
      AGENT_STAGE_PLAN_SEARCH_LLM,
      AGENT_STAGE_EVIDENCE_EXTRACT_LLM,
      AGENT_STAGE_RESPONSE_COMPOSE_LLM,
      AGENT_STAGE_GROUNDING_GUARD_LLM
    ].includes(stageName)
  ) {
    return 2;
  }

  return 1;
}

function hasAnyArtifact(snapshot: PersistentAgentTaskSnapshot, artifactTypes: string[]): boolean {
  const typeSet = new Set(artifactTypes);
  return snapshot.artifacts.some((artifact) => typeSet.has(artifact.type));
}

function readArtifactData<TData>(
  snapshot: PersistentAgentTaskSnapshot,
  type: string,
  guard: (value: unknown) => value is TData
): TData | undefined {
  const artifact = findLatestArtifact(snapshot, type);
  return artifact && guard(artifact.data) ? artifact.data : undefined;
}

function findLatestArtifact(
  snapshot: PersistentAgentTaskSnapshot,
  type: string
): PersistentAgentArtifact | undefined {
  return [...snapshot.artifacts].reverse().find((artifact) => artifact.type === type);
}

function buildMissingGuardReport(): GroundingGuardReport {
  return {
    status: "fallback",
    unsupportedClaims: [],
    removedItems: [],
    warnings: ["grounding_guard artifact missing; deterministic validator rebuilt result on read"],
    evidenceCoverage: null
  };
}

function isCandidatesArtifactData(value: unknown): value is CandidatesArtifactData {
  const record = asRecord(value);
  return Boolean(record && Array.isArray(record.candidates));
}

function isEvidenceArtifactData(value: unknown): value is EvidenceArtifactData {
  const record = asRecord(value);
  return Boolean(record && Array.isArray(record.evidenceItems));
}

function isFinalResultArtifactData(value: unknown): value is FinalResultArtifactData {
  const record = asRecord(value);
  return Boolean(
    record &&
      record.schemaVersion === "agent.final_result.v1" &&
      typeof record.summary === "string" &&
      Array.isArray(record.paths) &&
      Array.isArray(record.people) &&
      Array.isArray(record.suggestedQuestions)
  );
}

function isGuardedFinalResultArtifactData(value: unknown): value is GuardedFinalResultArtifactData {
  const record = asRecord(value);
  return Boolean(
    record &&
      record.schemaVersion === "agent.guarded_final_result.v1" &&
      isFinalResultArtifactData(record.result) &&
      asRecord(record.guard)
  );
}

function normalizeProgress(value: number): number {
  return Math.min(Math.max(Math.trunc(value), 0), 100);
}

function readString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function readNullableString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function readBoolean(value: unknown): boolean {
  return typeof value === "boolean" ? value : false;
}

function readNeedInput(metadata: Record<string, unknown>): AgentNeedInputPayload | null {
  return isAgentNeedInputPayload(metadata.needInput) ? metadata.needInput : null;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}
