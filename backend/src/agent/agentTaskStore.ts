import { randomUUID } from "node:crypto";
import {
  AGENT_TASK_CLEANUP_INTERVAL_MS,
  AGENT_TASK_TTL_MS
} from "./agentTimeouts.js";
import type {
  AgentPartialResult,
  AgentStage,
  AgentStageName,
  AgentTask,
  AgentTaskDebug,
  AgentTaskError,
  CreateAgentTaskInput,
  UpdateAgentTaskInput
} from "./agentTypes.js";
import type { DemoSearchRequest } from "../services/demoSearch.service.js";
import { HttpError } from "../utils/httpError.js";

const tasks = new Map<string, AgentTask>();
let nextCleanupAt = 0;

const cleanupTimer = setInterval(cleanupExpiredTasks, AGENT_TASK_CLEANUP_INTERVAL_MS);
cleanupTimer.unref?.();

const STAGE_LABELS: Record<AgentStageName, string> = {
  intent_expand: "理解问题与扩展检索方向",
  content_search: "搜索知乎公开内容",
  candidate_rank: "筛选相似人生样本",
  evidence_extract: "抽取关键经历和证据",
  response_compose: "整理路径与人物卡片",
  persona_prepare: "准备可追问经验回声",
  grounding_guard: "检查证据边界"
};

export const AGENT_STAGE_ORDER = Object.keys(STAGE_LABELS) as AgentStageName[];

export function createTask(input: CreateAgentTaskInput | DemoSearchRequest): AgentTask {
  cleanupExpiredTasksIfDue();

  const nowMs = Date.now();
  const id = createTaskId();
  const taskInput = normalizeCreateTaskInput(input);
  const task: AgentTask = {
    id,
    taskId: id,
    type: taskInput.type ?? "demo_search",
    status: "running",
    input: { ...taskInput.request },
    stages: createInitialStages(),
    partial: {},
    createdAt: new Date(nowMs).toISOString(),
    updatedAt: new Date(nowMs).toISOString(),
    expiresAt: new Date(nowMs + (taskInput.ttlMs ?? AGENT_TASK_TTL_MS)).toISOString()
  };

  tasks.set(task.id, task);
  return snapshotTask(task);
}

export function getTask(taskId: string): AgentTask | undefined {
  const task = getMutableTask(taskId);
  return task ? snapshotTask(task) : undefined;
}

export function updateTask(
  taskId: string,
  update: UpdateAgentTaskInput
): AgentTask | undefined {
  const task = getMutableTask(taskId);
  if (!task) {
    return undefined;
  }

  const now = new Date().toISOString();

  if (update.status) {
    task.status = update.status;
  }

  if ("currentStage" in update) {
    if (update.currentStage) {
      task.currentStage = update.currentStage;
    } else {
      delete task.currentStage;
    }
  }

  if (update.stages) {
    task.stages = cloneStages(update.stages);
  }

  if (update.partial) {
    task.partial = mergePartial(task.partial, update.partial);
  }

  if ("result" in update) {
    task.result = update.result;
  }

  if ("error" in update) {
    if (update.error) {
      task.error = { ...update.error };
    } else {
      delete task.error;
    }
  }

  if (update.debug) {
    task.debug = mergeDebug(task.debug, update.debug);
  }

  task.updatedAt = now;
  return snapshotTask(task);
}

export function completeTask(
  taskId: string,
  result: AgentTask["result"]
): AgentTask | undefined {
  const task = getMutableTask(taskId);
  if (!task) {
    return undefined;
  }

  const now = new Date().toISOString();
  task.status = "completed";
  task.result = result;
  task.partial = mergePartial(task.partial, extractPartialFromResult(result));
  task.debug = mergeDebug(task.debug, extractDebugFromResult(result));
  task.completedAt = now;
  task.updatedAt = now;
  delete task.currentStage;
  delete task.error;
  delete task.failedAt;
  return snapshotTask(task);
}

export function failTask(taskId: string, error: unknown): AgentTask | undefined {
  const task = getMutableTask(taskId);
  if (!task) {
    return undefined;
  }

  const now = new Date().toISOString();
  task.status = "failed";
  task.error = normalizeTaskError(error);
  task.failedAt = now;
  task.updatedAt = now;
  delete task.currentStage;
  delete task.completedAt;
  return snapshotTask(task);
}

export function updateTaskStage(
  taskId: string,
  stageName: AgentStageName,
  patch: Partial<Omit<AgentStage, "name" | "label">>
): AgentTask | undefined {
  const task = getMutableTask(taskId);
  if (!task) {
    return undefined;
  }

  const nextStages = task.stages.map((stage) =>
    stage.name === stageName
      ? {
          ...stage,
          ...patch,
          error: patch.error ? { ...patch.error, stage: patch.error.stage ?? stageName } : patch.error
        }
      : stage
  );

  return updateTask(taskId, {
    currentStage:
      patch.status === "running"
        ? stageName
        : task.currentStage === stageName
          ? null
          : task.currentStage,
    stages: nextStages
  });
}

export function cleanupExpiredTasks(nowMs = Date.now()): number {
  let deletedCount = 0;

  for (const [taskId, task] of tasks) {
    if (isExpired(task, nowMs)) {
      tasks.delete(taskId);
      deletedCount += 1;
    }
  }

  nextCleanupAt = nowMs + AGENT_TASK_CLEANUP_INTERVAL_MS;
  return deletedCount;
}

function getMutableTask(taskId: string): AgentTask | undefined {
  cleanupExpiredTasksIfDue();

  const task = tasks.get(taskId);
  if (!task) {
    return undefined;
  }

  if (isExpired(task)) {
    tasks.delete(taskId);
    return undefined;
  }

  return task;
}

function cleanupExpiredTasksIfDue(): void {
  const nowMs = Date.now();
  if (nowMs >= nextCleanupAt) {
    cleanupExpiredTasks(nowMs);
  }
}

function normalizeCreateTaskInput(
  input: CreateAgentTaskInput | DemoSearchRequest
): CreateAgentTaskInput {
  if ("request" in input) {
    return input;
  }

  return {
    request: input
  };
}

function isExpired(task: AgentTask, nowMs = Date.now()): boolean {
  return Date.parse(task.expiresAt) <= nowMs;
}

function createTaskId(): string {
  return `agent_task_${randomUUID()}`;
}

function normalizeTaskError(error: unknown): AgentTaskError {
  if (error instanceof HttpError) {
    return {
      code: error.code,
      message: error.message
    };
  }

  if (error instanceof Error) {
    return {
      code: error.name || "AGENT_TASK_FAILED",
      message: error.message || "Agent task failed"
    };
  }

  return {
    code: "AGENT_TASK_FAILED",
    message: "Agent task failed"
  };
}

function createInitialStages(): AgentStage[] {
  return AGENT_STAGE_ORDER.map((name) => ({
    name,
    label: STAGE_LABELS[name],
    status: "pending"
  }));
}

function cloneStages(stages: AgentStage[]): AgentStage[] {
  return stages.map((stage) => ({
    ...stage,
    ...(stage.error ? { error: { ...stage.error } } : {})
  }));
}

function mergePartial(
  current: AgentPartialResult,
  patch: AgentPartialResult
): AgentPartialResult {
  return {
    ...current,
    ...patch
  };
}

function mergeDebug(
  current: AgentTaskDebug | undefined,
  patch: AgentTaskDebug
): AgentTaskDebug {
  return {
    ...(current ?? {}),
    ...patch
  };
}

function extractPartialFromResult(
  result: AgentTask["result"]
): AgentPartialResult {
  if (!result) {
    return {};
  }

  return {
    expandedQueries: result.debug.searchQueries,
    searchStats: {
      rawCandidateCount: result.debug.rawCandidateCount,
      mergedCandidateCount: result.debug.mergedCandidateCount,
      dedupedCandidateCount: result.debug.dedupedCandidateCount,
      validCandidateCount: result.debug.validCandidateCount,
      finalCandidateCount: result.debug.finalCandidateCount
    },
    candidates: result.debug.finalCandidates,
    evidence: result.meta.sourceRefs,
    paths: result.paths,
    people: result.people,
    personas: result.personas
  };
}

function extractDebugFromResult(result: AgentTask["result"]): AgentTaskDebug {
  if (!result) {
    return {};
  }

  return {
    timings: result.debug.timings,
    llmStages: result.meta.llmStages,
    fallbackStages: result.meta.fallbackStages,
    timedOutStages: result.meta.timedOutStages,
    notes: result.debug.notes,
    cacheHit: result.debug.cacheHit,
    fallbackUsed: result.debug.fallbackUsed
  };
}

function snapshotTask(task: AgentTask): AgentTask {
  return {
    ...task,
    input: { ...task.input },
    stages: cloneStages(task.stages),
    partial: { ...task.partial },
    ...(task.debug ? { debug: { ...task.debug } } : {}),
    ...(task.error ? { error: { ...task.error } } : {})
  };
}
