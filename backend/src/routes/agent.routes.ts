import { createHash } from "node:crypto";
import { Router } from "express";
import { getCurrentUserContext, type UserContext } from "../auth/session.js";
import { assertAgentTaskQueueReady, enqueueAgentTask } from "../agent/agentQueue.js";
import {
  buildActorIdentity,
  buildAgentCacheIdentity,
  buildAgentCacheKey,
  getAgentCostBudget,
  sanitizeMetadataForStorage
} from "../agent/agentCache.js";
import {
  buildPersistentAgentTaskPendingResultData,
  buildPersistentAgentTaskStartData,
  buildPersistentAgentTaskStatusData,
  resolveProductionFinalResult
} from "../agent/agentTaskApi.js";
import { agentRepository } from "../agent/agentRepository.js";
import type { PersistentAgentTask } from "../agent/agentModels.js";
import { completeTask, createTask, failTask, getTask } from "../agent/agentTaskStore.js";
import { buildPersistentAgentTaskView } from "../agent/agentTaskView.js";
import { config } from "../config/env.js";
import type {
  AgentSearchTaskStartApiResponse,
  AgentTaskApiResponse,
  RunDemoSearchAgent
} from "../agent/agentTypes.js";
import { parseDemoSearchRequest, type DemoSearchRequest } from "../services/demoSearch.service.js";
import { HttpError } from "../utils/httpError.js";

const RUN_DEMO_SEARCH_AGENT_MODULE_PATH = "../agent/runDemoSearchAgent.js";

export const agentRoutes = Router();

agentRoutes.post("/tasks", async (req, res, next) => {
  try {
    const request = parseCreatePersistentAgentTaskRequest(req.body);
    const userContext = getCurrentUserContext(req);
    const createdAt = new Date().toISOString();
    const normalizedQuery = normalizeQuery(request.query);
    const storedMetadata = sanitizeMetadataForStorage(request.metadata);
    const anonymousId = readString(request.metadata.anonymousId) || req.ip || "anonymous";
    const actor = buildActorIdentity({
      userId: userContext.userId,
      anonymousId
    });
    const cacheIdentity = buildAgentCacheIdentity({
      normalizedQuery,
      metadata: storedMetadata,
      userId: userContext.userId
    });
    const queryCacheKey = buildAgentCacheKey(cacheIdentity);
    await assertAgentDatabaseReady();

    const runningReusableTask = await agentRepository.findReusableTaskByCacheKey({
      queryCacheKey,
      statuses: ["created", "queued", "running", "partial_ready", "waiting_retry"]
    });
    if (runningReusableTask) {
      res.json({
        success: true,
        data: buildPersistentAgentTaskStartData(runningReusableTask, {
          status: mapReusableTaskStartStatus(runningReusableTask),
          queueStatus: "reused_running",
          cacheHit: false,
          reused: true,
          reusedReason: "running_task"
        })
      });
      return;
    }

    const succeededReusableTask = await agentRepository.findReusableTaskByCacheKey({
      queryCacheKey,
      statuses: ["succeeded", "completed"],
      ttlHours: config.agent.cache.finalResultTtlHours
    });
    if (succeededReusableTask) {
      res.json({
        success: true,
        data: buildPersistentAgentTaskStartData(succeededReusableTask, {
          status: "succeeded",
          queueStatus: "reused_succeeded",
          cacheHit: true,
          reused: true,
          reusedReason: "recent_succeeded_task"
        })
      });
      return;
    }

    await assertAgentRateLimit(actor);
    await assertAgentTaskQueueReady();
    const snapshot = await agentRepository.createTaskWithCreatedEvent({
      query: request.query,
      userId: userContext.userId ?? null,
      metadata: {
        ...storedMetadata,
        originalQuery: request.query,
        normalizedQuery,
        queryHash: hashQuery(normalizedQuery),
        queryCacheKey,
        cacheIdentity,
        metadataHash: cacheIdentity.metadataHash,
        actorHash: actor.actorHash,
        actorType: actor.actorType,
        costBudget: getAgentCostBudget(),
        frontendStatus: "任务已创建",
        progressPercent: 0,
        partialAvailable: false,
        resultAvailable: false,
        degraded: false,
        degradedReason: null,
        createdAt
      }
    });
    const queuedAt = new Date().toISOString();
    const queuedTask = await agentRepository.updateTaskStatus(snapshot.task.id, {
      status: "queued",
      currentStage: "understand_goal_rule",
      progress: 5,
      metadata: {
        ...snapshot.task.metadata,
        frontendStatus: "正在理解你的问题",
        progressPercent: 5,
        queuedAt
      }
    });
    let enqueueResult: Awaited<ReturnType<typeof enqueueAgentTask>>;
    try {
      enqueueResult = await enqueueAgentTask(snapshot.task.id);
    } catch (error) {
      const failedAt = new Date().toISOString();
      const message = toErrorMessage(error);
      await agentRepository.updateTaskStatus(snapshot.task.id, {
        status: "failed",
        currentStage: "enqueue_agent_task",
        progress: 5,
        completedAt: failedAt,
        error: message,
        metadata: {
          ...(queuedTask ?? snapshot.task).metadata,
          frontendStatus: "任务失败",
          errorCode: "AGENT_QUEUE_ENQUEUE_FAILED",
          errorMessage: message,
          resultAvailable: false,
          finishedAt: failedAt
        }
      });
      throw error;
    }
    await agentRepository.createEvent({
      taskId: snapshot.task.id,
      type: "task.enqueued",
      payload: {
        jobId: enqueueResult.jobId,
        queueName: enqueueResult.queueName
      }
    });

    res.json({
      success: true,
      data: buildPersistentAgentTaskStartData(queuedTask ?? snapshot.task, {
        cacheHit: false,
        reused: false
      })
    });
  } catch (error) {
    next(toPersistentAgentTaskHttpError(error));
  }
});

agentRoutes.post("/search", (req, res, next) => {
  try {
    const request = parseDemoSearchRequest(req.body);
    const userContext = getCurrentUserContext(req);
    const task = createTask({ request });

    void runSearchTaskInBackground(task.id, request, userContext);

    res.json({
      success: true,
      data: {
        taskId: task.id,
        status: "running",
        createdAt: task.createdAt
      }
    } satisfies AgentSearchTaskStartApiResponse);
  } catch (error) {
    next(error);
  }
});

agentRoutes.get("/tasks", async (req, res, next) => {
  try {
    if (!agentRepository.isConfigured()) {
      throw new HttpError(
        503,
        "AGENT_DATABASE_UNCONFIGURED",
        "DATABASE_URL is not configured; persistent Agent Runtime is unavailable"
      );
    }

    const limit = readPositiveInteger(req.query.limit, 20);
    const tasks = await agentRepository.listRecentTasks(limit);

    res.json({
      success: true,
      data: {
        tasks
      }
    });
  } catch (error) {
    next(error);
  }
});

agentRoutes.get("/tasks/:taskId", async (req, res, next) => {
  try {
    const taskId = req.params.taskId.trim();
    const task = getTask(taskId);

    if (task) {
      res.json({
        success: true,
        data: task
      } satisfies AgentTaskApiResponse);
      return;
    }

    if (!agentRepository.isConfigured()) {
      throw new HttpError(404, "AGENT_TASK_NOT_FOUND", "Agent task not found");
    }

    const snapshot = await agentRepository.getTaskSnapshot(taskId);
    if (!snapshot) {
      throw new HttpError(404, "AGENT_TASK_NOT_FOUND", "Agent task not found");
    }

    res.json({
      success: true,
      data: buildPersistentAgentTaskStatusData(snapshot)
    });
  } catch (error) {
    next(error);
  }
});

agentRoutes.get("/tasks/:taskId/result", async (req, res, next) => {
  try {
    const taskId = req.params.taskId.trim();

    if (!agentRepository.isConfigured()) {
      throw new HttpError(404, "AGENT_TASK_NOT_FOUND", "Agent task not found");
    }

    const snapshot = await agentRepository.getTaskSnapshot(taskId);
    if (!snapshot) {
      throw new HttpError(404, "AGENT_TASK_NOT_FOUND", "Agent task not found");
    }

    const status = buildPersistentAgentTaskStatusData(snapshot);
    if (!status.resultAvailable || status.status !== "succeeded") {
      res.status(202).json({
        success: true,
        data: buildPersistentAgentTaskPendingResultData(snapshot)
      });
      return;
    }

    const finalResult = resolveProductionFinalResult(snapshot);
    if (!finalResult) {
      throw new HttpError(
        500,
        "AGENT_RESULT_MISSING",
        "Agent task succeeded but final_result is unavailable"
      );
    }

    res.json({
      success: true,
      data: {
        taskId,
        status: "succeeded",
        final_result: finalResult
      }
    });
  } catch (error) {
    next(error);
  }
});

agentRoutes.get("/tasks/:taskId/view", async (req, res, next) => {
  try {
    const taskId = req.params.taskId.trim();

    if (!agentRepository.isConfigured()) {
      throw new HttpError(404, "AGENT_TASK_NOT_FOUND", "Agent task not found");
    }

    const snapshot = await agentRepository.getTaskSnapshot(taskId);
    if (!snapshot) {
      throw new HttpError(404, "AGENT_TASK_NOT_FOUND", "Agent task not found");
    }

    res.json({
      success: true,
      data: buildPersistentAgentTaskView(snapshot)
    });
  } catch (error) {
    next(error);
  }
});

function parseCreatePersistentAgentTaskRequest(body: unknown): {
  query: string;
  metadata: Record<string, unknown>;
} {
  const record = isRecord(body) ? body : {};
  const query = readString(record.query).trim();

  if (!query) {
    throw new HttpError(400, "QUERY_REQUIRED", "Missing required body field: query");
  }

  if (record.metadata !== undefined && !isRecord(record.metadata)) {
    throw new HttpError(400, "METADATA_INVALID", "metadata must be an object");
  }

  return {
    query,
    metadata: record.metadata ?? {}
  };
}

async function runSearchTaskInBackground(
  taskId: string,
  request: DemoSearchRequest,
  userContext: UserContext
): Promise<void> {
  try {
    const runDemoSearchAgent = await loadRunDemoSearchAgent();
    const result = await runDemoSearchAgent({
      taskId,
      request,
      userContext
    });

    if (result) {
      completeTask(taskId, result);
    }
  } catch (error) {
    failTask(taskId, error);
  }
}

function readString(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }

  if (typeof value === "number") {
    return String(value);
  }

  return "";
}

function normalizeQuery(query: string): string {
  return query.replace(/\s+/g, " ").trim();
}

function hashQuery(query: string): string {
  return createHash("sha256").update(query).digest("hex");
}

function mapReusableTaskStartStatus(
  task: PersistentAgentTask
): "queued" | "running" | "succeeded" {
  if (task.status === "succeeded" || task.status === "completed") {
    return "succeeded";
  }

  if (task.status === "running" || task.status === "partial_ready" || task.status === "waiting_retry") {
    return "running";
  }

  return "queued";
}

async function assertAgentRateLimit(actor: {
  actorHash: string;
  actorType: "anonymous" | "user";
}): Promise<void> {
  const activeCount = await agentRepository.countActiveTasksByActor(actor.actorHash);
  const activeLimit =
    actor.actorType === "user"
      ? config.agent.limits.userRunning
      : config.agent.limits.anonymousRunning;
  if (activeCount >= activeLimit) {
    throw new HttpError(
      429,
      "RATE_LIMITED",
      `Too many running Agent tasks; limit is ${activeLimit}`
    );
  }

  const windowHours = actor.actorType === "user" ? 24 : 1;
  const createLimit =
    actor.actorType === "user"
      ? config.agent.limits.userDaily
      : config.agent.limits.anonymousHourly;
  const createdCount = await agentRepository.countTasksByActorSince({
    actorHash: actor.actorHash,
    since: new Date(Date.now() - windowHours * 60 * 60 * 1000).toISOString()
  });

  if (createdCount >= createLimit) {
    throw new HttpError(
      429,
      "RATE_LIMITED",
      `Too many Agent tasks in the current window; limit is ${createLimit}`
    );
  }
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function readPositiveInteger(value: unknown, fallback: number): number {
  const first = Array.isArray(value) ? value[0] : value;
  const next = Number(first);
  return Number.isInteger(next) && next > 0 ? next : fallback;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function assertAgentDatabaseReady(): Promise<void> {
  if (!agentRepository.isConfigured()) {
    throw new HttpError(
      503,
      "AGENT_DATABASE_UNCONFIGURED",
      "DATABASE_URL is not configured; persistent Agent Runtime is unavailable"
    );
  }

  await agentRepository.getTask("__agent_runtime_preflight__");
}

function toPersistentAgentTaskHttpError(error: unknown): unknown {
  if (error instanceof HttpError) {
    return error;
  }

  if (isPostgresUnavailableError(error)) {
    return new HttpError(
      503,
      "AGENT_DATABASE_UNAVAILABLE",
      "Agent database is unavailable; check DATABASE_URL and run npm run db:migrate -w backend"
    );
  }

  if (isRedisUnavailableError(error)) {
    return new HttpError(
      503,
      "AGENT_QUEUE_UNAVAILABLE",
      "Agent queue is unavailable; check REDIS_URL and Redis connectivity"
    );
  }

  return error;
}

function isPostgresUnavailableError(error: unknown): boolean {
  if (!isRecord(error)) {
    return false;
  }

  const code = readString(error.code);
  return [
    "ECONNREFUSED",
    "ENOTFOUND",
    "ETIMEDOUT",
    "ECONNRESET",
    "28P01",
    "3D000",
    "42P01"
  ].includes(code);
}

function isRedisUnavailableError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : "";
  if (
    /redis|connection is closed|connect econnrefused|stream isn't writeable|max retries|command timed out/i.test(
      message
    )
  ) {
    return true;
  }

  if (!isRecord(error)) {
    return false;
  }

  const code = readString(error.code);
  return [
    "ECONNREFUSED",
    "ENOTFOUND",
    "ETIMEDOUT",
    "ECONNRESET",
    "NR_CLOSED"
  ].includes(code);
}

async function loadRunDemoSearchAgent(): Promise<RunDemoSearchAgent> {
  const agentModule = await import(RUN_DEMO_SEARCH_AGENT_MODULE_PATH) as {
    runDemoSearchAgent?: RunDemoSearchAgent;
  };

  if (typeof agentModule.runDemoSearchAgent !== "function") {
    throw new Error("runDemoSearchAgent export is missing");
  }

  return agentModule.runDemoSearchAgent;
}
