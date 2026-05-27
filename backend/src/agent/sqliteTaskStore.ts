import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import {
  AGENT_STAGE_ORDER,
  type AgentStageName,
  type AgentStageRecord,
  type AgentTaskRecord,
  type AgentTaskSnapshot,
  type CreateAgentTaskInput
} from "./taskTypes.js";
import {
  cloneAgentTaskSnapshot,
  cloneJson,
  createInitialAgentTaskSnapshot,
  type AgentTaskStore
} from "./taskStore.js";

interface TaskRow {
  task_id: string;
  query: string;
  status: AgentTaskRecord["status"];
  current_stage: AgentStageName | null;
  progress: number;
  degraded: number;
  degraded_reason: string | null;
  degraded_reasons_json: string;
  failed_stages_json: string;
  retryable: number;
  retryable_stages_json: string;
  data_mode: AgentTaskRecord["dataMode"];
  requested_data_mode: AgentTaskRecord["requestedDataMode"];
  read_token: string;
  input_json: string;
  intent_json: string | null;
  error_json: string | null;
  created_at: string;
  updated_at: string;
  partial_ready_at: string | null;
  finished_at: string | null;
}

interface StageRow {
  task_id: string;
  stage_order: number;
  name: AgentStageName;
  status: AgentStageRecord["status"];
  attempt: number;
  timeout_ms: number;
  started_at: string | null;
  finished_at: string | null;
  provider: string | null;
  model: string | null;
  input_summary_json: string | null;
  output_summary_json: string | null;
  error_code: string | null;
  error_message: string | null;
  fallback_used: number;
  fallback_reason: string | null;
  retryable: number;
}

interface ResultRow {
  task_id: string;
  partial_result_json: string | null;
  final_result_json: string | null;
  result_version: number;
  updated_at: string;
}

export class SqliteAgentTaskStore implements AgentTaskStore {
  private readonly db: Database.Database;

  constructor(dbPath: string) {
    const resolvedPath = dbPath === ":memory:" ? dbPath : resolve(dbPath);
    if (dbPath !== ":memory:") {
      mkdirSync(dirname(resolvedPath), { recursive: true });
    }

    this.db = new Database(resolvedPath);
    this.db.pragma("foreign_keys = ON");
    this.db.pragma("journal_mode = WAL");
    this.initSchema();
    this.recoverInterruptedTasks();
  }

  createTask(input: CreateAgentTaskInput): AgentTaskSnapshot {
    const snapshot = createInitialAgentTaskSnapshot(input);
    const insert = this.db.transaction(() => {
      this.insertTask(snapshot.task);
      snapshot.stages.forEach((stage, index) => {
        this.upsertStage(snapshot.task.taskId, stage, index);
      });
      this.ensureResultRow(snapshot.task.taskId, snapshot.task.updatedAt);
    });

    insert();
    return cloneAgentTaskSnapshot(snapshot);
  }

  getTask(taskId: string): AgentTaskSnapshot | undefined {
    const taskRow = this.db
      .prepare("SELECT * FROM agent_tasks WHERE task_id = ?")
      .get(taskId) as TaskRow | undefined;
    if (!taskRow) {
      return undefined;
    }

    const stageRows = this.db
      .prepare("SELECT * FROM agent_task_stages WHERE task_id = ? ORDER BY stage_order ASC")
      .all(taskId) as StageRow[];
    const resultRow = this.db
      .prepare("SELECT * FROM agent_task_results WHERE task_id = ?")
      .get(taskId) as ResultRow | undefined;

    return {
      task: taskFromRow(taskRow),
      stages: stageRows.map(stageFromRow),
      ...(resultRow?.partial_result_json === null || resultRow?.partial_result_json === undefined
        ? {}
        : { partialResult: parseJson(resultRow.partial_result_json, null) }),
      ...(resultRow?.final_result_json === null || resultRow?.final_result_json === undefined
        ? {}
        : { finalResult: parseJson(resultRow.final_result_json, null) })
    };
  }

  patchTask(
    taskId: string,
    patch: Partial<Omit<AgentTaskRecord, "taskId" | "input" | "createdAt" | "readToken">>
  ): AgentTaskSnapshot {
    const snapshot = this.requireTask(taskId);
    const task = {
      ...snapshot.task,
      ...cloneJson(patch),
      updatedAt: new Date().toISOString()
    };
    this.updateTask(task);
    return this.requireTask(taskId);
  }

  patchStage(
    taskId: string,
    stageName: AgentStageName,
    patch: Partial<Omit<AgentStageRecord, "name">>
  ): AgentTaskSnapshot {
    const snapshot = this.requireTask(taskId);
    const stageIndex = snapshot.stages.findIndex((stage) => stage.name === stageName);
    if (stageIndex < 0) {
      throw new Error(`Agent task stage not found: ${taskId}/${stageName}`);
    }

    const stage = {
      ...snapshot.stages[stageIndex],
      ...cloneJson(patch)
    };
    const now = new Date().toISOString();
    const update = this.db.transaction(() => {
      this.upsertStage(taskId, stage, stageIndex);
      this.touchTask(taskId, now);
    });
    update();

    return this.requireTask(taskId);
  }

  setIntent(taskId: string, intent: AgentTaskRecord["intent"]): AgentTaskSnapshot {
    const snapshot = this.requireTask(taskId);
    const task = {
      ...snapshot.task,
      intent: intent ? cloneJson(intent) : undefined,
      updatedAt: new Date().toISOString()
    };
    this.updateTask(task);
    return this.requireTask(taskId);
  }

  setPartialResult(taskId: string, result: unknown): AgentTaskSnapshot {
    this.requireTask(taskId);
    this.upsertResult(taskId, { partialResult: cloneJson(result) });
    return this.requireTask(taskId);
  }

  setFinalResult(taskId: string, result: unknown): AgentTaskSnapshot {
    this.requireTask(taskId);
    this.upsertResult(taskId, { finalResult: cloneJson(result) });
    return this.requireTask(taskId);
  }

  close(): void {
    this.db.close();
  }

  private initSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS agent_tasks (
        task_id TEXT PRIMARY KEY,
        query TEXT NOT NULL,
        status TEXT NOT NULL,
        current_stage TEXT,
        progress REAL NOT NULL DEFAULT 0,
        degraded INTEGER NOT NULL DEFAULT 0,
        degraded_reason TEXT,
        degraded_reasons_json TEXT NOT NULL,
        failed_stages_json TEXT NOT NULL,
        retryable INTEGER NOT NULL DEFAULT 0,
        retryable_stages_json TEXT NOT NULL,
        data_mode TEXT NOT NULL,
        requested_data_mode TEXT NOT NULL,
        read_token TEXT NOT NULL,
        input_json TEXT NOT NULL,
        intent_json TEXT,
        error_json TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        partial_ready_at TEXT,
        finished_at TEXT
      );

      CREATE TABLE IF NOT EXISTS agent_task_stages (
        task_id TEXT NOT NULL,
        stage_order INTEGER NOT NULL,
        name TEXT NOT NULL,
        status TEXT NOT NULL,
        attempt INTEGER NOT NULL DEFAULT 0,
        timeout_ms INTEGER NOT NULL DEFAULT 0,
        started_at TEXT,
        finished_at TEXT,
        provider TEXT,
        model TEXT,
        input_summary_json TEXT,
        output_summary_json TEXT,
        error_code TEXT,
        error_message TEXT,
        fallback_used INTEGER NOT NULL DEFAULT 0,
        fallback_reason TEXT,
        retryable INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (task_id, name),
        FOREIGN KEY (task_id) REFERENCES agent_tasks(task_id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS agent_task_results (
        task_id TEXT PRIMARY KEY,
        partial_result_json TEXT,
        final_result_json TEXT,
        result_version INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (task_id) REFERENCES agent_tasks(task_id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_agent_tasks_status_updated_at
        ON agent_tasks(status, updated_at);
    `);
  }

  private recoverInterruptedTasks(): void {
    const rows = this.db
      .prepare(
        "SELECT task_id FROM agent_tasks WHERE status IN ('queued', 'running', 'partial_ready')"
      )
      .all() as Array<{ task_id: string }>;

    for (const row of rows) {
      const snapshot = this.getTask(row.task_id);
      if (!snapshot) {
        continue;
      }

      const runningStage = snapshot.stages.find((stage) =>
        stage.name === snapshot.task.currentStage && stage.status === "running"
      )?.name;
      const interruptedStage = runningStage
        ?? (snapshot.partialResult === undefined ? snapshot.task.currentStage ?? "intent_expand" : "persona_prepare");
      const reason = snapshot.partialResult === undefined
        ? "服务重启后任务后台执行已中断，可重新提交任务"
        : "服务重启后任务后台执行已中断，已保留已有部分结果";

      if (runningStage) {
        this.patchStage(snapshot.task.taskId, runningStage, {
          status: "timed_out",
          finishedAt: new Date().toISOString(),
          errorCode: "AGENT_TASK_INTERRUPTED",
          errorMessage: reason,
          fallbackUsed: true,
          fallbackReason: reason,
          retryable: true
        });
      }

      if (snapshot.partialResult !== undefined && snapshot.finalResult === undefined) {
        this.setFinalResult(snapshot.task.taskId, snapshot.partialResult);
      }

      this.patchTask(snapshot.task.taskId, {
        status: snapshot.partialResult === undefined ? "failed" : "degraded",
        currentStage: null,
        progress: 1,
        degraded: true,
        degradedReason: reason,
        degradedReasons: uniqueStrings([...snapshot.task.degradedReasons, reason]),
        failedStages: uniqueStages([...snapshot.task.failedStages, interruptedStage]),
        retryable: true,
        retryableStages: uniqueStages([...snapshot.task.retryableStages, interruptedStage]),
        error: snapshot.partialResult === undefined
          ? {
              code: "AGENT_TASK_INTERRUPTED",
              message: reason
            }
          : snapshot.task.error,
        finishedAt: snapshot.task.finishedAt ?? new Date().toISOString()
      });
    }
  }

  private insertTask(task: AgentTaskRecord): void {
    this.db.prepare(`
      INSERT INTO agent_tasks (
        task_id, query, status, current_stage, progress, degraded, degraded_reason,
        degraded_reasons_json, failed_stages_json, retryable, retryable_stages_json,
        data_mode, requested_data_mode, read_token, input_json, intent_json, error_json,
        created_at, updated_at, partial_ready_at, finished_at
      ) VALUES (
        @taskId, @query, @status, @currentStage, @progress, @degraded, @degradedReason,
        @degradedReasonsJson, @failedStagesJson, @retryable, @retryableStagesJson,
        @dataMode, @requestedDataMode, @readToken, @inputJson, @intentJson, @errorJson,
        @createdAt, @updatedAt, @partialReadyAt, @finishedAt
      )
    `).run(taskParams(task));
  }

  private updateTask(task: AgentTaskRecord): void {
    const result = this.db.prepare(`
      UPDATE agent_tasks SET
        query = @query,
        status = @status,
        current_stage = @currentStage,
        progress = @progress,
        degraded = @degraded,
        degraded_reason = @degradedReason,
        degraded_reasons_json = @degradedReasonsJson,
        failed_stages_json = @failedStagesJson,
        retryable = @retryable,
        retryable_stages_json = @retryableStagesJson,
        data_mode = @dataMode,
        requested_data_mode = @requestedDataMode,
        input_json = @inputJson,
        intent_json = @intentJson,
        error_json = @errorJson,
        updated_at = @updatedAt,
        partial_ready_at = @partialReadyAt,
        finished_at = @finishedAt
      WHERE task_id = @taskId
    `).run(taskParams(task));
    if (result.changes === 0) {
      throw new Error(`Agent task not found: ${task.taskId}`);
    }
  }

  private upsertStage(taskId: string, stage: AgentStageRecord, stageOrder: number): void {
    this.db.prepare(`
      INSERT INTO agent_task_stages (
        task_id, stage_order, name, status, attempt, timeout_ms, started_at, finished_at,
        provider, model, input_summary_json, output_summary_json, error_code, error_message,
        fallback_used, fallback_reason, retryable
      ) VALUES (
        @taskId, @stageOrder, @name, @status, @attempt, @timeoutMs, @startedAt, @finishedAt,
        @provider, @model, @inputSummaryJson, @outputSummaryJson, @errorCode, @errorMessage,
        @fallbackUsed, @fallbackReason, @retryable
      )
      ON CONFLICT(task_id, name) DO UPDATE SET
        stage_order = excluded.stage_order,
        status = excluded.status,
        attempt = excluded.attempt,
        timeout_ms = excluded.timeout_ms,
        started_at = excluded.started_at,
        finished_at = excluded.finished_at,
        provider = excluded.provider,
        model = excluded.model,
        input_summary_json = excluded.input_summary_json,
        output_summary_json = excluded.output_summary_json,
        error_code = excluded.error_code,
        error_message = excluded.error_message,
        fallback_used = excluded.fallback_used,
        fallback_reason = excluded.fallback_reason,
        retryable = excluded.retryable
    `).run(stageParams(taskId, stage, stageOrder));
  }

  private ensureResultRow(taskId: string, updatedAt: string): void {
    this.db.prepare(`
      INSERT INTO agent_task_results (task_id, result_version, updated_at)
      VALUES (?, 0, ?)
      ON CONFLICT(task_id) DO NOTHING
    `).run(taskId, updatedAt);
  }

  private upsertResult(
    taskId: string,
    values: {
      partialResult?: unknown;
      finalResult?: unknown;
    }
  ): void {
    const now = new Date().toISOString();
    const update = this.db.transaction(() => {
      this.ensureResultRow(taskId, now);
      if ("partialResult" in values) {
        this.db.prepare(`
          UPDATE agent_task_results
          SET partial_result_json = ?, result_version = result_version + 1, updated_at = ?
          WHERE task_id = ?
        `).run(toJson(values.partialResult), now, taskId);
      }
      if ("finalResult" in values) {
        this.db.prepare(`
          UPDATE agent_task_results
          SET final_result_json = ?, result_version = result_version + 1, updated_at = ?
          WHERE task_id = ?
        `).run(toJson(values.finalResult), now, taskId);
      }
      this.touchTask(taskId, now);
    });
    update();
  }

  private touchTask(taskId: string, updatedAt: string): void {
    const result = this.db.prepare(
      "UPDATE agent_tasks SET updated_at = ? WHERE task_id = ?"
    ).run(updatedAt, taskId);
    if (result.changes === 0) {
      throw new Error(`Agent task not found: ${taskId}`);
    }
  }

  private requireTask(taskId: string): AgentTaskSnapshot {
    const snapshot = this.getTask(taskId);
    if (!snapshot) {
      throw new Error(`Agent task not found: ${taskId}`);
    }

    return snapshot;
  }
}

function taskParams(task: AgentTaskRecord): Record<string, unknown> {
  return {
    taskId: task.taskId,
    query: task.query,
    status: task.status,
    currentStage: task.currentStage,
    progress: task.progress,
    degraded: task.degraded ? 1 : 0,
    degradedReason: task.degradedReason,
    degradedReasonsJson: toJson(task.degradedReasons),
    failedStagesJson: toJson(task.failedStages),
    retryable: task.retryable ? 1 : 0,
    retryableStagesJson: toJson(task.retryableStages),
    dataMode: task.dataMode,
    requestedDataMode: task.requestedDataMode,
    readToken: task.readToken,
    inputJson: toJson(task.input),
    intentJson: optionalJson(task.intent),
    errorJson: optionalJson(task.error),
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    partialReadyAt: task.partialReadyAt,
    finishedAt: task.finishedAt
  };
}

function stageParams(taskId: string, stage: AgentStageRecord, stageOrder: number): Record<string, unknown> {
  return {
    taskId,
    stageOrder,
    name: stage.name,
    status: stage.status,
    attempt: stage.attempt,
    timeoutMs: stage.timeoutMs,
    startedAt: stage.startedAt,
    finishedAt: stage.finishedAt,
    provider: stage.provider ?? null,
    model: stage.model ?? null,
    inputSummaryJson: optionalJson(stage.inputSummary),
    outputSummaryJson: optionalJson(stage.outputSummary),
    errorCode: stage.errorCode ?? null,
    errorMessage: stage.errorMessage ?? null,
    fallbackUsed: stage.fallbackUsed ? 1 : 0,
    fallbackReason: stage.fallbackReason ?? null,
    retryable: stage.retryable ? 1 : 0
  };
}

function taskFromRow(row: TaskRow): AgentTaskRecord {
  return {
    taskId: row.task_id,
    query: row.query,
    status: row.status,
    currentStage: row.current_stage,
    progress: row.progress,
    degraded: row.degraded === 1,
    degradedReason: row.degraded_reason,
    degradedReasons: parseJson<string[]>(row.degraded_reasons_json, []),
    failedStages: parseJson<AgentStageName[]>(row.failed_stages_json, []),
    retryable: row.retryable === 1,
    retryableStages: parseJson<AgentStageName[]>(row.retryable_stages_json, []),
    dataMode: row.data_mode,
    requestedDataMode: row.requested_data_mode,
    ...(row.error_json ? { error: parseJson<AgentTaskRecord["error"]>(row.error_json, undefined) } : {}),
    readToken: row.read_token,
    input: parseJson<AgentTaskRecord["input"]>(row.input_json, {
      query: row.query,
      count: 10,
      dataMode: row.data_mode,
      requestedDataMode: row.requested_data_mode,
      metadata: {}
    }),
    ...(row.intent_json ? { intent: parseJson<AgentTaskRecord["intent"]>(row.intent_json, undefined) } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    partialReadyAt: row.partial_ready_at,
    finishedAt: row.finished_at
  };
}

function stageFromRow(row: StageRow): AgentStageRecord {
  return {
    name: row.name,
    status: row.status,
    attempt: row.attempt,
    timeoutMs: row.timeout_ms,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    ...(row.provider ? { provider: row.provider } : {}),
    ...(row.model ? { model: row.model } : {}),
    ...(row.input_summary_json
      ? { inputSummary: parseJson<Record<string, unknown>>(row.input_summary_json, {}) }
      : {}),
    ...(row.output_summary_json
      ? { outputSummary: parseJson<Record<string, unknown>>(row.output_summary_json, {}) }
      : {}),
    ...(row.error_code ? { errorCode: row.error_code } : {}),
    ...(row.error_message ? { errorMessage: row.error_message } : {}),
    fallbackUsed: row.fallback_used === 1,
    ...(row.fallback_reason ? { fallbackReason: row.fallback_reason } : {}),
    retryable: row.retryable === 1
  };
}

function toJson(value: unknown): string {
  return JSON.stringify(value ?? null);
}

function optionalJson(value: unknown): string | null {
  return value === undefined ? null : JSON.stringify(value);
}

function parseJson<T>(value: string, fallback: T): T {
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function uniqueStrings(values: string[]): string[] {
  return Array.from(new Set(values.filter(Boolean)));
}

function uniqueStages(values: AgentStageName[]): AgentStageName[] {
  const stageNames = new Set<AgentStageName>(AGENT_STAGE_ORDER);
  return Array.from(new Set(values.filter((value) => stageNames.has(value))));
}
