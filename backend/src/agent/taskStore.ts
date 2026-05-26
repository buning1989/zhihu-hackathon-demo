import { randomBytes, randomUUID } from "node:crypto";
import {
  AGENT_STAGE_ORDER,
  type AgentStageName,
  type AgentStageRecord,
  type AgentStageStatus,
  type AgentTaskRecord,
  type AgentTaskSnapshot,
  type CreateAgentTaskInput
} from "./taskTypes.js";

export interface AgentTaskStore {
  createTask(input: CreateAgentTaskInput): AgentTaskSnapshot;
  getTask(taskId: string): AgentTaskSnapshot | undefined;
  patchTask(
    taskId: string,
    patch: Partial<Omit<AgentTaskRecord, "taskId" | "input" | "createdAt" | "readToken">>
  ): AgentTaskSnapshot;
  patchStage(
    taskId: string,
    stageName: AgentStageName,
    patch: Partial<Omit<AgentStageRecord, "name">>
  ): AgentTaskSnapshot;
  setIntent(taskId: string, intent: AgentTaskRecord["intent"]): AgentTaskSnapshot;
  setPartialResult(taskId: string, result: unknown): AgentTaskSnapshot;
  setFinalResult(taskId: string, result: unknown): AgentTaskSnapshot;
}

interface StoredTask {
  task: AgentTaskRecord;
  stages: AgentStageRecord[];
  partialResult?: unknown;
  finalResult?: unknown;
}

export class InMemoryAgentTaskStore implements AgentTaskStore {
  private readonly tasks = new Map<string, StoredTask>();

  createTask(input: CreateAgentTaskInput): AgentTaskSnapshot {
    const now = new Date().toISOString();
    const taskId = `task_${randomUUID()}`;
    const stored: StoredTask = {
      task: {
        taskId,
        query: input.query,
        status: "queued",
        currentStage: null,
        progress: 0,
        degraded: false,
        degradedReason: null,
        degradedReasons: [],
        failedStages: [],
        retryable: false,
        retryableStages: [],
        dataMode: input.dataMode,
        requestedDataMode: input.requestedDataMode,
        readToken: randomReadToken(),
        input: {
          query: input.query,
          count: input.count,
          requestedDataMode: input.requestedDataMode,
          dataMode: input.dataMode,
          metadata: clone(input.metadata),
          userContext: input.userContext ? clone(input.userContext) : undefined
        },
        createdAt: now,
        updatedAt: now,
        partialReadyAt: null,
        finishedAt: null
      },
      stages: AGENT_STAGE_ORDER.map((name) => ({
        name,
        status: "pending",
        attempt: 0,
        timeoutMs: 0,
        startedAt: null,
        finishedAt: null,
        fallbackUsed: false,
        retryable: false
      }))
    };

    this.tasks.set(taskId, stored);
    return cloneSnapshot(stored);
  }

  getTask(taskId: string): AgentTaskSnapshot | undefined {
    const stored = this.tasks.get(taskId);
    return stored ? cloneSnapshot(stored) : undefined;
  }

  patchTask(
    taskId: string,
    patch: Partial<Omit<AgentTaskRecord, "taskId" | "input" | "createdAt" | "readToken">>
  ): AgentTaskSnapshot {
    const stored = this.requireTask(taskId);
    stored.task = {
      ...stored.task,
      ...clone(patch),
      updatedAt: new Date().toISOString()
    };
    return cloneSnapshot(stored);
  }

  patchStage(
    taskId: string,
    stageName: AgentStageName,
    patch: Partial<Omit<AgentStageRecord, "name">>
  ): AgentTaskSnapshot {
    const stored = this.requireTask(taskId);
    stored.stages = stored.stages.map((stage) =>
      stage.name === stageName ? { ...stage, ...clone(patch) } : stage
    );
    stored.task.updatedAt = new Date().toISOString();
    return cloneSnapshot(stored);
  }

  setIntent(taskId: string, intent: AgentTaskRecord["intent"]): AgentTaskSnapshot {
    const stored = this.requireTask(taskId);
    stored.task.intent = intent ? clone(intent) : undefined;
    stored.task.updatedAt = new Date().toISOString();
    return cloneSnapshot(stored);
  }

  setPartialResult(taskId: string, result: unknown): AgentTaskSnapshot {
    const stored = this.requireTask(taskId);
    stored.partialResult = clone(result);
    stored.task.updatedAt = new Date().toISOString();
    return cloneSnapshot(stored);
  }

  setFinalResult(taskId: string, result: unknown): AgentTaskSnapshot {
    const stored = this.requireTask(taskId);
    stored.finalResult = clone(result);
    stored.task.updatedAt = new Date().toISOString();
    return cloneSnapshot(stored);
  }

  private requireTask(taskId: string): StoredTask {
    const stored = this.tasks.get(taskId);
    if (!stored) {
      throw new Error(`Agent task not found: ${taskId}`);
    }

    return stored;
  }
}

export const agentTaskStore: AgentTaskStore = new InMemoryAgentTaskStore();

export function isTerminalStageStatus(status: AgentStageStatus): boolean {
  return ["succeeded", "degraded", "failed", "skipped", "timed_out"].includes(status);
}

function randomReadToken(): string {
  return randomBytes(18).toString("base64url");
}

function cloneSnapshot(stored: StoredTask): AgentTaskSnapshot {
  return {
    task: clone(stored.task),
    stages: clone(stored.stages),
    ...(stored.partialResult === undefined ? {} : { partialResult: clone(stored.partialResult) }),
    ...(stored.finalResult === undefined ? {} : { finalResult: clone(stored.finalResult) })
  };
}

function clone<T>(value: T): T {
  if (value === undefined || value === null) {
    return value;
  }

  return JSON.parse(JSON.stringify(value)) as T;
}
