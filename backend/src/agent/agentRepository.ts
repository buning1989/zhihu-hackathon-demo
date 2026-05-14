import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { config } from "../config/env.js";
import { getPostgresPool, isPostgresConfigured, queryPostgres } from "../db/postgres.js";
import { HttpError } from "../utils/httpError.js";
import type {
  CreatePersistentAgentArtifactInput,
  CreatePersistentAgentEventInput,
  CreatePersistentAgentStageRunInput,
  CreatePersistentAgentTaskInput,
  PersistentAgentArtifact,
  PersistentAgentEvent,
  PersistentAgentStageRun,
  PersistentAgentTask,
  PersistentAgentTaskSnapshot,
  UpdatePersistentAgentStageRunInput,
  UpdatePersistentAgentTaskStatusInput
} from "./agentModels.js";

interface AgentTaskRow {
  id: string;
  user_id: string | null;
  query: string;
  status: PersistentAgentTask["status"];
  current_stage: string | null;
  progress: number;
  result_artifact_id: string | null;
  error: string | null;
  metadata: Record<string, unknown>;
  created_at: Date;
  updated_at: Date;
  started_at: Date | null;
  completed_at: Date | null;
  expires_at: Date | null;
}

interface AgentStageRunRow {
  id: string;
  task_id: string;
  stage_name: string;
  status: PersistentAgentStageRun["status"];
  attempt: number;
  timeout_ms: number | null;
  input_artifact_ids: string[];
  output_artifact_ids: string[];
  model: string | null;
  fallback_used: boolean;
  fallback_reason: string | null;
  error: string | null;
  started_at: Date | null;
  ended_at: Date | null;
  duration_ms: number | null;
  created_at: Date;
  updated_at: Date;
}

interface AgentArtifactRow {
  id: string;
  task_id: string;
  type: string;
  data: unknown;
  created_at: Date;
}

interface AgentEventRow {
  id: string;
  task_id: string;
  type: string;
  payload: Record<string, unknown>;
  created_at: Date;
}

export class AgentRepository {
  isConfigured(): boolean {
    return isPostgresConfigured();
  }

  async createTask(input: CreatePersistentAgentTaskInput): Promise<PersistentAgentTask> {
    assertConfigured();

    const id = createAgentRecordId("agent_task");
    const expiresAt = input.expiresAt ?? createDefaultExpiresAt();
    const result = await queryPostgres<AgentTaskRow>(
      `
        INSERT INTO agent_tasks (id, user_id, query, status, metadata, expires_at)
        VALUES ($1, $2, $3, 'queued', $4::jsonb, $5)
        RETURNING *
      `,
      [
        id,
        input.userId ?? null,
        input.query,
        stringifyJsonb(input.metadata ?? {}),
        expiresAt
      ]
    );

    return mapTaskRow(result.rows[0]);
  }

  async getTask(taskId: string): Promise<PersistentAgentTask | undefined> {
    assertConfigured();

    const result = await queryPostgres<AgentTaskRow>(
      "SELECT * FROM agent_tasks WHERE id = $1",
      [taskId]
    );

    return result.rows[0] ? mapTaskRow(result.rows[0]) : undefined;
  }

  async listRecentTasks(limit = 20): Promise<PersistentAgentTask[]> {
    assertConfigured();

    const safeLimit = Math.min(Math.max(Math.trunc(limit), 1), 100);
    const result = await queryPostgres<AgentTaskRow>(
      "SELECT * FROM agent_tasks ORDER BY created_at DESC LIMIT $1",
      [safeLimit]
    );

    return result.rows.map(mapTaskRow);
  }

  async updateTaskStatus(
    taskId: string,
    patch: UpdatePersistentAgentTaskStatusInput
  ): Promise<PersistentAgentTask | undefined> {
    assertConfigured();

    const current = await this.getTask(taskId);
    if (!current) {
      return undefined;
    }

    const result = await queryPostgres<AgentTaskRow>(
      `
        UPDATE agent_tasks
        SET
          status = $2,
          current_stage = $3,
          progress = $4,
          result_artifact_id = $5,
          error = $6,
          metadata = $7::jsonb,
          started_at = $8,
          completed_at = $9,
          expires_at = $10,
          updated_at = now()
        WHERE id = $1
        RETURNING *
      `,
      [
        taskId,
        patch.status ?? current.status,
        patch.currentStage === undefined ? current.currentStage : patch.currentStage,
        patch.progress ?? current.progress,
        patch.resultArtifactId === undefined ? current.resultArtifactId : patch.resultArtifactId,
        patch.error === undefined ? current.error : patch.error,
        stringifyJsonb(patch.metadata ?? current.metadata),
        patch.startedAt === undefined ? current.startedAt : patch.startedAt,
        patch.completedAt === undefined ? current.completedAt : patch.completedAt,
        patch.expiresAt === undefined ? current.expiresAt : patch.expiresAt
      ]
    );

    return result.rows[0] ? mapTaskRow(result.rows[0]) : undefined;
  }

  async createStageRun(
    input: CreatePersistentAgentStageRunInput
  ): Promise<PersistentAgentStageRun> {
    assertConfigured();

    const id = createAgentRecordId("agent_stage");
    const result = await queryPostgres<AgentStageRunRow>(
      `
        INSERT INTO agent_stage_runs (
          id, task_id, stage_name, status, attempt, timeout_ms,
          input_artifact_ids, output_artifact_ids, model, fallback_used,
          fallback_reason, error, started_at, ended_at, duration_ms
        )
        VALUES (
          $1, $2, $3, $4, $5, $6,
          $7::jsonb, $8::jsonb, $9, $10,
          $11, $12, $13, $14, $15
        )
        RETURNING *
      `,
      [
        id,
        input.taskId,
        input.stageName,
        input.status ?? "pending",
        input.attempt ?? 1,
        input.timeoutMs ?? null,
        stringifyJsonb(input.inputArtifactIds ?? []),
        stringifyJsonb(input.outputArtifactIds ?? []),
        input.model ?? null,
        input.fallbackUsed ?? false,
        input.fallbackReason ?? null,
        input.error ?? null,
        input.startedAt ?? null,
        input.endedAt ?? null,
        input.durationMs ?? null
      ]
    );

    return mapStageRunRow(result.rows[0]);
  }

  async updateStageRun(
    stageRunId: string,
    patch: UpdatePersistentAgentStageRunInput
  ): Promise<PersistentAgentStageRun | undefined> {
    assertConfigured();

    const current = await this.getStageRun(stageRunId);
    if (!current) {
      return undefined;
    }

    const result = await queryPostgres<AgentStageRunRow>(
      `
        UPDATE agent_stage_runs
        SET
          status = $2,
          attempt = $3,
          timeout_ms = $4,
          input_artifact_ids = $5::jsonb,
          output_artifact_ids = $6::jsonb,
          model = $7,
          fallback_used = $8,
          fallback_reason = $9,
          error = $10,
          started_at = $11,
          ended_at = $12,
          duration_ms = $13,
          updated_at = now()
        WHERE id = $1
        RETURNING *
      `,
      [
        stageRunId,
        patch.status ?? current.status,
        patch.attempt ?? current.attempt,
        patch.timeoutMs === undefined ? current.timeoutMs : patch.timeoutMs,
        stringifyJsonb(patch.inputArtifactIds ?? current.inputArtifactIds),
        stringifyJsonb(patch.outputArtifactIds ?? current.outputArtifactIds),
        patch.model === undefined ? current.model : patch.model,
        patch.fallbackUsed ?? current.fallbackUsed,
        patch.fallbackReason === undefined ? current.fallbackReason : patch.fallbackReason,
        patch.error === undefined ? current.error : patch.error,
        patch.startedAt === undefined ? current.startedAt : patch.startedAt,
        patch.endedAt === undefined ? current.endedAt : patch.endedAt,
        patch.durationMs === undefined ? current.durationMs : patch.durationMs
      ]
    );

    return result.rows[0] ? mapStageRunRow(result.rows[0]) : undefined;
  }

  async createArtifact(
    input: CreatePersistentAgentArtifactInput
  ): Promise<PersistentAgentArtifact> {
    assertConfigured();

    const id = createAgentRecordId("agent_artifact");
    const result = await queryPostgres<AgentArtifactRow>(
      `
        INSERT INTO agent_artifacts (id, task_id, type, data)
        VALUES ($1, $2, $3, $4::jsonb)
        RETURNING *
      `,
      [id, input.taskId, input.type, stringifyJsonb(input.data)]
    );

    return mapArtifactRow(result.rows[0]);
  }

  async listArtifactsByTask(taskId: string): Promise<PersistentAgentArtifact[]> {
    assertConfigured();

    const result = await queryPostgres<AgentArtifactRow>(
      "SELECT * FROM agent_artifacts WHERE task_id = $1 ORDER BY created_at ASC",
      [taskId]
    );

    return result.rows.map(mapArtifactRow);
  }

  async createEvent(input: CreatePersistentAgentEventInput): Promise<PersistentAgentEvent> {
    assertConfigured();

    const id = createAgentRecordId("agent_event");
    const result = await queryPostgres<AgentEventRow>(
      `
        INSERT INTO agent_events (id, task_id, type, payload)
        VALUES ($1, $2, $3, $4::jsonb)
        RETURNING *
      `,
      [id, input.taskId, input.type, stringifyJsonb(input.payload ?? {})]
    );

    return mapEventRow(result.rows[0]);
  }

  async listEventsByTask(taskId: string): Promise<PersistentAgentEvent[]> {
    assertConfigured();

    const result = await queryPostgres<AgentEventRow>(
      "SELECT * FROM agent_events WHERE task_id = $1 ORDER BY created_at ASC",
      [taskId]
    );

    return result.rows.map(mapEventRow);
  }

  async getTaskSnapshot(taskId: string): Promise<PersistentAgentTaskSnapshot | undefined> {
    assertConfigured();

    const task = await this.getTask(taskId);
    if (!task) {
      return undefined;
    }

    const [stages, artifacts, events] = await Promise.all([
      this.listStageRunsByTask(taskId),
      this.listArtifactsByTask(taskId),
      this.listEventsByTask(taskId)
    ]);

    return {
      task,
      stages,
      artifacts,
      events
    };
  }

  async createTaskWithCreatedEvent(
    input: CreatePersistentAgentTaskInput
  ): Promise<PersistentAgentTaskSnapshot> {
    assertConfigured();

    const pool = getPostgresPool();
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const task = await insertTask(client, input);
      const event = await insertEvent(client, {
        taskId: task.id,
        type: "task.created",
        payload: {
          query: task.query,
          status: task.status
        }
      });
      await client.query("COMMIT");

      return {
        task,
        stages: [],
        artifacts: [],
        events: [event]
      };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  private async listStageRunsByTask(taskId: string): Promise<PersistentAgentStageRun[]> {
    const result = await queryPostgres<AgentStageRunRow>(
      "SELECT * FROM agent_stage_runs WHERE task_id = $1 ORDER BY created_at ASC",
      [taskId]
    );

    return result.rows.map(mapStageRunRow);
  }

  private async getStageRun(stageRunId: string): Promise<PersistentAgentStageRun | undefined> {
    const result = await queryPostgres<AgentStageRunRow>(
      "SELECT * FROM agent_stage_runs WHERE id = $1",
      [stageRunId]
    );

    return result.rows[0] ? mapStageRunRow(result.rows[0]) : undefined;
  }
}

export const agentRepository = new AgentRepository();

async function insertTask(
  client: PoolClient,
  input: CreatePersistentAgentTaskInput
): Promise<PersistentAgentTask> {
  const id = createAgentRecordId("agent_task");
  const result = await client.query<AgentTaskRow>(
    `
      INSERT INTO agent_tasks (id, user_id, query, status, metadata, expires_at)
      VALUES ($1, $2, $3, 'queued', $4::jsonb, $5)
      RETURNING *
    `,
    [
      id,
      input.userId ?? null,
      input.query,
      stringifyJsonb(input.metadata ?? {}),
      input.expiresAt ?? createDefaultExpiresAt()
    ]
  );

  return mapTaskRow(result.rows[0]);
}

async function insertEvent(
  client: PoolClient,
  input: CreatePersistentAgentEventInput
): Promise<PersistentAgentEvent> {
  const id = createAgentRecordId("agent_event");
  const result = await client.query<AgentEventRow>(
    `
      INSERT INTO agent_events (id, task_id, type, payload)
      VALUES ($1, $2, $3, $4::jsonb)
      RETURNING *
    `,
    [id, input.taskId, input.type, stringifyJsonb(input.payload ?? {})]
  );

  return mapEventRow(result.rows[0]);
}

function assertConfigured(): void {
  if (!isPostgresConfigured()) {
    throw new HttpError(
      503,
      "AGENT_DATABASE_UNCONFIGURED",
      "DATABASE_URL is not configured; persistent Agent Runtime is unavailable"
    );
  }
}

function createAgentRecordId(prefix: string): string {
  return `${prefix}_${randomUUID()}`;
}

function stringifyJsonb(value: unknown): string {
  return JSON.stringify(value, (_key, nestedValue) => {
    if (typeof nestedValue === "string") {
      return sanitizeJsonString(nestedValue);
    }

    return nestedValue;
  });
}

function sanitizeJsonString(value: string): string {
  let result = "";

  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);

    if (code === 0) {
      continue;
    }

    if (code >= 0xd800 && code <= 0xdbff) {
      const nextCode = value.charCodeAt(index + 1);
      if (nextCode >= 0xdc00 && nextCode <= 0xdfff) {
        result += value[index] + value[index + 1];
        index += 1;
      } else {
        result += "\uFFFD";
      }
      continue;
    }

    if (code >= 0xdc00 && code <= 0xdfff) {
      result += "\uFFFD";
      continue;
    }

    result += value[index];
  }

  return result;
}

function createDefaultExpiresAt(): string {
  return new Date(Date.now() + config.agent.taskTtlHours * 60 * 60 * 1000).toISOString();
}

function mapTaskRow(row: AgentTaskRow): PersistentAgentTask {
  return {
    id: row.id,
    userId: row.user_id,
    query: row.query,
    status: row.status,
    currentStage: row.current_stage,
    progress: row.progress,
    resultArtifactId: row.result_artifact_id,
    error: row.error,
    metadata: row.metadata ?? {},
    createdAt: toIsoString(row.created_at),
    updatedAt: toIsoString(row.updated_at),
    startedAt: toIsoStringOrNull(row.started_at),
    completedAt: toIsoStringOrNull(row.completed_at),
    expiresAt: toIsoStringOrNull(row.expires_at)
  };
}

function mapStageRunRow(row: AgentStageRunRow): PersistentAgentStageRun {
  return {
    id: row.id,
    taskId: row.task_id,
    stageName: row.stage_name,
    status: row.status,
    attempt: row.attempt,
    timeoutMs: row.timeout_ms,
    inputArtifactIds: normalizeStringArray(row.input_artifact_ids),
    outputArtifactIds: normalizeStringArray(row.output_artifact_ids),
    model: row.model,
    fallbackUsed: row.fallback_used,
    fallbackReason: row.fallback_reason,
    error: row.error,
    startedAt: toIsoStringOrNull(row.started_at),
    endedAt: toIsoStringOrNull(row.ended_at),
    durationMs: row.duration_ms,
    createdAt: toIsoString(row.created_at),
    updatedAt: toIsoString(row.updated_at)
  };
}

function mapArtifactRow(row: AgentArtifactRow): PersistentAgentArtifact {
  return {
    id: row.id,
    taskId: row.task_id,
    type: row.type,
    data: row.data,
    createdAt: toIsoString(row.created_at)
  };
}

function mapEventRow(row: AgentEventRow): PersistentAgentEvent {
  return {
    id: row.id,
    taskId: row.task_id,
    type: row.type,
    payload: row.payload ?? {},
    createdAt: toIsoString(row.created_at)
  };
}

function normalizeStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function toIsoString(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function toIsoStringOrNull(value: Date | string | null): string | null {
  return value ? toIsoString(value) : null;
}
