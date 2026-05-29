import type { UserContext } from "../auth/session.js";
import { config } from "../config/env.js";
import { HttpError } from "../utils/httpError.js";
import type { DemoDataMode } from "../types/demo.types.js";
import { agentTaskStore } from "./taskStoreFactory.js";
import type { AgentTaskStore } from "./taskStore.js";
import { agentTaskRunner, type AgentTaskRunner } from "./taskRunner.js";
import type {
  AgentStageName,
  AgentStageRecord,
  AgentStageStatus,
  AgentTaskRecord,
  AgentTaskSnapshot
} from "./taskTypes.js";

interface AgentCreateTaskRequest {
  query?: unknown;
  count?: unknown;
  mode?: unknown;
  dataMode?: unknown;
  metadata?: unknown;
}

export interface AgentTaskStatusView {
  taskId: string;
  query: string;
  status: AgentTaskRecord["status"];
  currentStage: AgentTaskRecord["currentStage"];
  stage: AgentTaskRecord["currentStage"] | AgentTaskRecord["status"];
  progress: number;
  dataMode: DemoDataMode;
  requestedDataMode: DemoDataMode;
  degraded: boolean;
  degradedReason: string | null;
  degradedReasons: string[];
  failedStages: AgentStageName[];
  retryable: boolean;
  retryableStages: AgentStageName[];
  hasPartialResult: boolean;
  hasFinalResult: boolean;
  needInput: AgentTaskRecord["needInput"] | null;
  stages: AgentStageRecord[];
  readToken?: string;
  pollAfterMs: number;
  frontendStatus: string;
  error?: AgentTaskRecord["error"];
  createdAt: string;
  updatedAt: string;
  partialReadyAt: string | null;
  finishedAt: string | null;
}

export class AgentTaskService {
  constructor(
    private readonly store: AgentTaskStore,
    private readonly runner: AgentTaskRunner
  ) {}

  createTask(body: unknown, userContext?: UserContext): AgentTaskStatusView {
    const request = parseCreateTaskRequest(body);
    const snapshot = this.store.createTask({
      query: request.query,
      count: request.count,
      dataMode: request.dataMode,
      requestedDataMode: request.requestedDataMode,
      metadata: request.metadata,
      userContext
    });

    this.runner.start(snapshot.task.taskId);
    return toTaskStatusView(snapshot, { includeReadToken: true });
  }

  getTaskStatus(taskId: string): AgentTaskStatusView {
    return toTaskStatusView(this.requireTask(taskId));
  }

  getTaskView(taskId: string): Record<string, unknown> {
    const snapshot = this.requireTask(taskId);
    if (snapshot.partialResult === undefined) {
      throw new HttpError(202, "RESULT_NOT_READY", "Task partial view is not ready");
    }

    return {
      taskId,
      status: snapshot.task.status,
      resultStatus: snapshot.finalResult === undefined ? "partial" : "final",
      degraded: snapshot.task.degraded,
      degradedReason: snapshot.task.degradedReason,
      failedStages: snapshot.task.failedStages,
      retryable: snapshot.task.retryable,
      retryableStages: snapshot.task.retryableStages,
      stages: snapshot.stages,
      result: snapshot.partialResult
    };
  }

  getTaskResult(taskId: string): Record<string, unknown> {
    const snapshot = this.requireTask(taskId);
    if (snapshot.finalResult === undefined) {
      throw new HttpError(202, "RESULT_NOT_READY", "Task final result is not ready");
    }

    return {
      taskId,
      status: snapshot.task.status,
      resultStatus: snapshot.task.status === "failed" ? "degraded" : "final",
      degraded: snapshot.task.degraded,
      degradedReason: snapshot.task.degradedReason,
      failedStages: snapshot.task.failedStages,
      retryable: snapshot.task.retryable,
      retryableStages: snapshot.task.retryableStages,
      stages: snapshot.stages,
      result: snapshot.finalResult
    };
  }

  retryTaskStage(taskId: string, stageNameValue: string): AgentTaskStatusView {
    const stageName = parseRetryStageName(stageNameValue);
    const snapshot = this.requireTask(taskId);
    validateStageRetry(snapshot, stageName);
    const retrySnapshot = this.runner.retryEvidenceExtract(taskId);
    return toTaskStatusView(retrySnapshot);
  }

  private requireTask(taskId: string): AgentTaskSnapshot {
    const snapshot = this.store.getTask(taskId);
    if (!snapshot) {
      throw new HttpError(404, "AGENT_TASK_NOT_FOUND", `Agent task not found: ${taskId}`);
    }

    return snapshot;
  }
}

export const agentTaskService = new AgentTaskService(agentTaskStore, agentTaskRunner);

const RETRYABLE_EVIDENCE_STAGE_STATUSES = new Set<AgentStageStatus>([
  "degraded",
  "timed_out",
  "failed",
  "skipped"
]);

function parseCreateTaskRequest(body: unknown): {
  query: string;
  count: number;
  dataMode: DemoDataMode;
  requestedDataMode: DemoDataMode;
  metadata: Record<string, unknown>;
} {
  const record = isRecord(body) ? body : {};
  const metadata = isRecord(record.metadata) ? record.metadata : {};
  const query = typeof record.query === "string" ? record.query.trim() : "";

  if (!query) {
    throw new HttpError(400, "QUERY_REQUIRED", "Missing required field: query");
  }

  const requestedDataMode = parseDataMode(
    record.dataMode ?? record.mode ?? metadata.dataMode,
    config.dataMode
  );
  const dataMode: DemoDataMode = requestedDataMode;

  return {
    query,
    count: parseCount(record.count ?? metadata.count),
    dataMode,
    requestedDataMode,
    metadata: clone(metadata)
  };
}

function toTaskStatusView(
  snapshot: AgentTaskSnapshot,
  options: { includeReadToken?: boolean } = {}
): AgentTaskStatusView {
  const task = snapshot.task;

  return {
    taskId: task.taskId,
    query: task.query,
    status: task.status,
    currentStage: task.currentStage,
    stage: task.currentStage ?? task.status,
    progress: task.progress,
    dataMode: task.dataMode,
    requestedDataMode: task.requestedDataMode,
    degraded: task.degraded,
    degradedReason: task.degradedReason,
    degradedReasons: task.degradedReasons,
    failedStages: task.failedStages,
    retryable: task.retryable,
    retryableStages: task.retryableStages,
    hasPartialResult: snapshot.partialResult !== undefined,
    hasFinalResult: snapshot.finalResult !== undefined,
    needInput: task.needInput ?? null,
    stages: snapshot.stages,
    ...(options.includeReadToken ? { readToken: task.readToken } : {}),
    pollAfterMs: task.status === "queued" || task.status === "running" || task.status === "partial_ready" ? 700 : 0,
    frontendStatus: toFrontendStatus(task, snapshot.stages),
    ...(task.error ? { error: task.error } : {}),
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    partialReadyAt: task.partialReadyAt,
    finishedAt: task.finishedAt
  };
}

function toFrontendStatus(task: AgentTaskRecord, stages: AgentStageRecord[]): string {
  if (task.status === "queued") {
    return "准备创建任务";
  }

  if (task.status === "need_input") {
    return task.needInput?.reason || "先补充一点背景，帮你找到更像你的人";
  }

  if (task.status === "failed") {
    return task.degradedReason || "任务失败，可稍后重试";
  }

  if (task.status === "succeeded" || task.status === "degraded") {
    return task.degraded ? "结果已生成，部分阶段降级" : "结果已生成";
  }

  const runningStage = stages.find((stage) => stage.status === "running")?.name ?? task.currentStage;
  switch (runningStage) {
    case "intent_expand":
      return "正在理解问题并生成搜索计划";
    case "retrieve_search":
      return "正在召回知乎公开内容";
    case "candidate_select":
      return "正在筛选高质量候选";
    case "partial_compose":
      return "正在生成首批可展示结果";
    case "evidence_extract":
      return "正在补全证据提取";
    case "experience_summary":
      return "正在补全经历摘要";
    case "grounding_guard":
      return "正在做证据边界检查";
    case "persona_prepare":
      return "正在准备分身入口";
    default:
      return "正在处理任务";
  }
}

function parseCount(value: unknown): number {
  if (typeof value !== "number" && typeof value !== "string") {
    return 10;
  }

  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isFinite(parsed)) {
    return 10;
  }

  return Math.min(Math.max(parsed, 1), 20);
}

function parseDataMode(value: unknown, fallback: DemoDataMode): DemoDataMode {
  if (value === "mock" || value === "real" || value === "replay" || value === "cache_first") {
    return value;
  }

  return fallback;
}

function parseRetryStageName(value: string): "evidence_extract" {
  if (value !== "evidence_extract") {
    throw new HttpError(
      400,
      "STAGE_RETRY_NOT_SUPPORTED",
      "Only evidence_extract retry is supported in this version."
    );
  }

  return "evidence_extract";
}

function validateStageRetry(snapshot: AgentTaskSnapshot, stageName: "evidence_extract"): void {
  if (snapshot.task.status === "canceled") {
    throw new HttpError(409, "TASK_CANCELED", "Canceled tasks cannot be retried.");
  }

  if (snapshot.partialResult === undefined) {
    throw new HttpError(
      409,
      "STAGE_RETRY_REQUIRES_PARTIAL_RESULT",
      "Cannot retry evidence_extract before partial result is ready."
    );
  }

  const stage = snapshot.stages.find((item) => item.name === stageName);
  if (!stage) {
    throw new HttpError(404, "STAGE_NOT_FOUND", `Stage not found: ${stageName}`);
  }

  if (stage.status === "running") {
    throw new HttpError(409, "STAGE_RETRY_IN_PROGRESS", "evidence_extract is already running.");
  }

  const failedStageRequested = snapshot.task.failedStages.includes(stageName);
  if (!RETRYABLE_EVIDENCE_STAGE_STATUSES.has(stage.status) && !failedStageRequested) {
    throw new HttpError(
      409,
      "STAGE_RETRY_NOT_AVAILABLE",
      "evidence_extract can only be retried after it is skipped, failed, degraded, or timed out."
    );
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
