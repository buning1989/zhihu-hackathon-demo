import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { Router, type Request } from "express";
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
import {
  AGENT_PRODUCTION_FINAL_RESULT_SCHEMA_VERSION,
  type ProductionFinalResultData
} from "../agent/agentProductionResult.js";
import { agentRepository } from "../agent/agentRepository.js";
import type { PersistentAgentTask, PersistentAgentTaskSnapshot } from "../agent/agentModels.js";
import { buildPersistentAgentTaskDebugData } from "../agent/agentTaskDebug.js";
import { completeTask, createTask, failTask, getTask } from "../agent/agentTaskStore.js";
import { buildPersistentAgentTaskView } from "../agent/agentTaskView.js";
import {
  buildAgentRefineContext,
  detectAgentNeedInput,
  isAgentNeedInputPayload
} from "../agent/agentClarification.js";
import { config } from "../config/env.js";
import type {
  AgentSearchTaskStartApiResponse,
  AgentTaskApiResponse,
  RunDemoSearchAgent
} from "../agent/agentTypes.js";
import { AGENT_ARTIFACT_PRODUCTION_FINAL_RESULT } from "../agent/stages/stageTypes.js";
import { parseDemoSearchRequest, type DemoSearchRequest } from "../services/demoSearch.service.js";
import { HttpError } from "../utils/httpError.js";

const RUN_DEMO_SEARCH_AGENT_MODULE_PATH = "../agent/runDemoSearchAgent.js";
const legacyTaskReadTokenHashes = new Map<string, string>();

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
    const storedCacheIdentity = buildStoredCacheIdentity(cacheIdentity);
    const suppliedReadToken = readAgentReadToken(req);
    await assertAgentDatabaseReady();

    const needInput = detectAgentNeedInput({
      query: request.query,
      metadata: storedMetadata
    });
    if (needInput) {
      await assertAgentRateLimit(actor);
      const readCredential = createAgentReadCredential();
      const snapshot = await agentRepository.createTaskWithCreatedEvent({
        query: request.query,
        userId: userContext.userId ?? null,
        metadata: {
          ...storedMetadata,
          queryHash: hashQuery(normalizedQuery),
          queryCacheKey,
          cacheIdentity: storedCacheIdentity,
          metadataHash: cacheIdentity.metadataHash,
          actorHash: actor.actorHash,
          actorType: actor.actorType,
          readTokenHash: readCredential.readTokenHash,
          costBudget: getAgentCostBudget(),
          frontendStatus: "需要你补充一点信息",
          progressPercent: 0,
          partialAvailable: false,
          resultAvailable: false,
          degraded: false,
          degradedReason: null,
          clarifyNeeded: true,
          needInput,
          createdAt
        }
      });
      const needInputTask = await agentRepository.updateTaskStatus(snapshot.task.id, {
        status: "need_input",
        currentStage: "clarify_need_input",
        progress: 0,
        metadata: {
          ...snapshot.task.metadata,
          frontendStatus: "需要你补充一点信息",
          progressPercent: 0,
          needInput
        }
      });
      await agentRepository.createEvent({
        taskId: snapshot.task.id,
        type: "task.need_input",
        payload: {
          reason: needInput.reason,
          questionKeys: needInput.questions.map((question) => question.key)
        }
      });

      res.json({
        success: true,
        data: buildPersistentAgentTaskStartData(needInputTask ?? snapshot.task, {
          status: "need_input",
          queueStatus: "need_input",
          cacheHit: false,
          reused: false,
          readToken: readCredential.readToken
        })
      });
      return;
    }

    const runningReusableTask = await agentRepository.findReusableTaskByCacheKey({
      queryCacheKey,
      statuses: ["created", "queued", "running", "partial_ready", "waiting_retry"]
    });
    if (
      runningReusableTask &&
      canReuseExistingTask({
        task: runningReusableTask,
        actorHash: actor.actorHash,
        userContext,
        readToken: suppliedReadToken
      })
    ) {
      await recordTaskReuseEvent(runningReusableTask, "running_task");
      res.json({
        success: true,
        data: buildPersistentAgentTaskStartData(runningReusableTask, {
          status: mapReusableTaskStartStatus(runningReusableTask),
          queueStatus: "reused_running",
          cacheHit: false,
          reused: true,
          reusedReason: "running_task",
          readToken: suppliedReadToken
        })
      });
      return;
    }

    const succeededReusableTask = await agentRepository.findReusableTaskByCacheKey({
      queryCacheKey,
      statuses: ["succeeded", "completed"],
      ttlHours: config.agent.cache.finalResultTtlHours
    });
    const succeededReusableSnapshot = succeededReusableTask
      ? await getReusableProductionFinalResultSnapshot(succeededReusableTask.id)
      : null;
    if (succeededReusableSnapshot) {
      if (
        canReuseExistingTask({
          task: succeededReusableSnapshot.snapshot.task,
          actorHash: actor.actorHash,
          userContext,
          readToken: suppliedReadToken
        })
      ) {
        await recordTaskReuseEvent(succeededReusableSnapshot.snapshot.task, "recent_succeeded_task");
        res.json({
          success: true,
          data: buildPersistentAgentTaskStartData(succeededReusableSnapshot.snapshot.task, {
            status: "succeeded",
            queueStatus: "reused_succeeded",
            cacheHit: true,
            reused: true,
            reusedReason: "recent_succeeded_task",
            readToken: suppliedReadToken
          })
        });
        return;
      }

      await assertAgentRateLimit(actor);
      const copiedTask = await createCopiedSucceededTask({
        query: request.query,
        userId: userContext.userId,
        storedMetadata,
        normalizedQuery,
        queryCacheKey,
        cacheIdentity,
        storedCacheIdentity,
        actor,
        sourceSnapshot: succeededReusableSnapshot.snapshot,
        finalResult: succeededReusableSnapshot.finalResult,
        createdAt
      });
      res.json({
        success: true,
        data: buildPersistentAgentTaskStartData(copiedTask.task, {
          status: "succeeded",
          queueStatus: "reused_succeeded",
          cacheHit: true,
          reused: true,
          reusedReason: "recent_succeeded_task",
          readToken: copiedTask.readToken
        })
      });
      return;
    }

    await assertAgentRateLimit(actor);
    await assertAgentTaskQueueReady();
    const readCredential = createAgentReadCredential();
    const snapshot = await agentRepository.createTaskWithCreatedEvent({
      query: request.query,
      userId: userContext.userId ?? null,
      metadata: {
        ...storedMetadata,
        queryHash: hashQuery(normalizedQuery),
        queryCacheKey,
        cacheIdentity: storedCacheIdentity,
        metadataHash: cacheIdentity.metadataHash,
        actorHash: actor.actorHash,
        actorType: actor.actorType,
        readTokenHash: readCredential.readTokenHash,
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
        reused: false,
        readToken: readCredential.readToken
      })
    });
  } catch (error) {
    next(toPersistentAgentTaskHttpError(error));
  }
});

agentRoutes.post("/tasks/:taskId/refine", async (req, res, next) => {
  try {
    const parentTaskId = req.params.taskId.trim();
    const request = parseRefinePersistentAgentTaskRequest(req.body);
    const userContext = getCurrentUserContext(req);
    const createdAt = new Date().toISOString();
    await assertAgentDatabaseReady();

    const parentSnapshot = await agentRepository.getTaskSnapshot(parentTaskId);
    if (!parentSnapshot) {
      throw new HttpError(404, "AGENT_TASK_NOT_FOUND", "Agent task not found");
    }
    assertTaskReadAccess(parentSnapshot.task, req, userContext);

    const parentNeedInput = isAgentNeedInputPayload(parentSnapshot.task.metadata.needInput)
      ? parentSnapshot.task.metadata.needInput
      : null;
    if (parentSnapshot.task.status !== "need_input" && !parentNeedInput) {
      throw new HttpError(
        409,
        "AGENT_TASK_NOT_WAITING_FOR_INPUT",
        "Agent task is not waiting for clarification input"
      );
    }

    const originalContext = readString(parentSnapshot.task.metadata.originalContext);
    const refineContext = buildAgentRefineContext({
      originalQuery: originalContext
        ? `${parentSnapshot.task.query}\n原上下文：${originalContext}`
        : parentSnapshot.task.query,
      needInput: parentNeedInput,
      answers: request.answers,
      refineQuery: request.refineQuery
    });
    const storedMetadata = sanitizeMetadataForStorage({
      ...request.metadata,
      refinedFromTaskId: parentSnapshot.task.id,
      clarifyRefined: true,
      originalQueryHash: hashQuery(parentSnapshot.task.query),
      refineAnswerHash: refineContext.answerHash,
      refineAnswerSummary: refineContext.answerSummary,
      refineAnswers: refineContext.sanitizedAnswers,
      ...(refineContext.refineQueryHash ? { refineQueryHash: refineContext.refineQueryHash } : {})
    });
    const normalizedQuery = normalizeQuery(refineContext.refinedQuery);
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
    const storedCacheIdentity = buildStoredCacheIdentity(cacheIdentity);

    await assertAgentRateLimit(actor);
    await assertAgentTaskQueueReady();
    const readCredential = createAgentReadCredential();
    const snapshot = await agentRepository.createTaskWithCreatedEvent({
      query: refineContext.refinedQuery,
      userId: userContext.userId ?? null,
      metadata: {
        ...storedMetadata,
        queryHash: hashQuery(normalizedQuery),
        queryCacheKey,
        cacheIdentity: storedCacheIdentity,
        metadataHash: cacheIdentity.metadataHash,
        actorHash: actor.actorHash,
        actorType: actor.actorType,
        readTokenHash: readCredential.readTokenHash,
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
        queueName: enqueueResult.queueName,
        refinedFromTaskId: parentSnapshot.task.id
      }
    });
    await agentRepository.createEvent({
      taskId: parentSnapshot.task.id,
      type: "task.refined",
      payload: {
        refinedTaskId: snapshot.task.id,
        answerHash: refineContext.answerHash
      }
    });

    res.json({
      success: true,
      data: buildPersistentAgentTaskStartData(queuedTask ?? snapshot.task, {
        cacheHit: false,
        reused: false,
        readToken: readCredential.readToken
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
    const readCredential = createAgentReadCredential();
    legacyTaskReadTokenHashes.set(task.id, readCredential.readTokenHash);

    void runSearchTaskInBackground(task.id, request, userContext);

    res.json({
      success: true,
      data: {
        taskId: task.id,
        readToken: readCredential.readToken,
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
    assertAgentInternalAdminAccess(req);
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
      assertLegacyTaskReadAccess(taskId, req);
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
    assertTaskReadAccess(snapshot.task, req, getCurrentUserContext(req));

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
    assertTaskReadAccess(snapshot.task, req, getCurrentUserContext(req));

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
    assertTaskReadAccess(snapshot.task, req, getCurrentUserContext(req));

    res.json({
      success: true,
      data: buildPersistentAgentTaskView(snapshot)
    });
  } catch (error) {
    next(error);
  }
});

agentRoutes.get("/tasks/:taskId/debug", async (req, res, next) => {
  try {
    assertAgentDebugAccess(req);
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
      data: buildPersistentAgentTaskDebugData(snapshot)
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

function parseRefinePersistentAgentTaskRequest(body: unknown): {
  answers: Record<string, unknown>;
  refineQuery: string;
  metadata: Record<string, unknown>;
} {
  const record = isRecord(body) ? body : {};

  if (record.answers !== undefined && !isRecord(record.answers)) {
    throw new HttpError(400, "REFINE_ANSWERS_INVALID", "answers must be an object");
  }

  if (record.metadata !== undefined && !isRecord(record.metadata)) {
    throw new HttpError(400, "METADATA_INVALID", "metadata must be an object");
  }

  const answers = record.answers ?? {};
  const refineQuery = readString(record.refineQuery).trim();
  if (Object.keys(answers).length === 0 && !refineQuery) {
    throw new HttpError(
      400,
      "REFINE_INPUT_REQUIRED",
      "Provide at least one clarification answer or refineQuery"
    );
  }

  return {
    answers,
    refineQuery,
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
  if (!config.agent.limits.rateLimitEnabled) {
    return;
  }

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

async function recordTaskReuseEvent(
  task: PersistentAgentTask,
  reusedReason: "running_task" | "recent_succeeded_task"
): Promise<void> {
  try {
    await agentRepository.createEvent({
      taskId: task.id,
      type: "task.reused",
      payload: {
        status: task.status,
        reusedReason,
        queryCacheKey: readString(task.metadata.queryCacheKey)
      }
    });
  } catch {
    // Debug events must not break the cost-saving reuse path.
  }
}

async function createCopiedSucceededTask(input: {
  query: string;
  userId?: string | null;
  storedMetadata: Record<string, unknown>;
  normalizedQuery: string;
  queryCacheKey: string;
  cacheIdentity: { metadataHash: string };
  storedCacheIdentity: Record<string, unknown>;
  actor: {
    actorHash: string;
    actorType: "anonymous" | "user";
  };
  sourceSnapshot: PersistentAgentTaskSnapshot;
  finalResult: ProductionFinalResultData;
  createdAt: string;
}): Promise<{
  task: PersistentAgentTask;
  readToken: string;
}> {
  const readCredential = createAgentReadCredential();
  const baseMetadata = {
    ...input.storedMetadata,
    queryHash: hashQuery(input.normalizedQuery),
    queryCacheKey: input.queryCacheKey,
    cacheIdentity: input.storedCacheIdentity,
    metadataHash: input.cacheIdentity.metadataHash,
    actorHash: input.actor.actorHash,
    actorType: input.actor.actorType,
    readTokenHash: readCredential.readTokenHash,
    costBudget: getAgentCostBudget(),
    frontendStatus: "结果已准备好",
    progressPercent: 100,
    partialAvailable: true,
    resultAvailable: true,
    degraded: input.finalResult.degraded,
    degradedReason: input.finalResult.degradedReason,
    cacheHit: true,
    reused: true,
    reusedReason: "recent_succeeded_task",
    reusedSourceTaskHash: hashQuery(input.sourceSnapshot.task.id),
    copiedFromCache: true,
    createdAt: input.createdAt,
    finishedAt: input.createdAt
  };
  const snapshot = await agentRepository.createTaskWithCreatedEvent({
    query: input.query,
    userId: input.userId ?? null,
    metadata: baseMetadata
  });
  const copiedFinalResult: ProductionFinalResultData = {
    ...input.finalResult,
    taskId: snapshot.task.id,
    query: input.query,
    meta: {
      ...input.finalResult.meta
    }
  };
  const artifact = await agentRepository.createArtifact({
    taskId: snapshot.task.id,
    type: AGENT_ARTIFACT_PRODUCTION_FINAL_RESULT,
    data: copiedFinalResult
  });
  const task = await agentRepository.updateTaskStatus(snapshot.task.id, {
    status: "succeeded",
    currentStage: "cache_reuse",
    progress: 100,
    resultArtifactId: artifact.id,
    startedAt: input.createdAt,
    completedAt: input.createdAt,
    metadata: baseMetadata
  });
  await agentRepository.createEvent({
    taskId: snapshot.task.id,
    type: "task.reused",
    payload: {
      status: "succeeded",
      reusedReason: "recent_succeeded_task",
      queryCacheKey: input.queryCacheKey,
      copiedResult: true,
      sourceTaskHash: hashQuery(input.sourceSnapshot.task.id)
    }
  });

  return {
    task: task ?? snapshot.task,
    readToken: readCredential.readToken
  };
}

function assertAgentDebugAccess(req: Request): void {
  if (config.nodeEnv === "production") {
    throw new HttpError(404, "AGENT_DEBUG_DISABLED", "Agent debug endpoint is disabled");
  }

  assertAgentInternalAdminAccess(req);
}

function assertAgentInternalAdminAccess(req: Request): void {
  const configuredToken = config.agent.debugToken;
  if (configuredToken) {
    const suppliedToken =
      readHeader(req, "x-agent-debug-token") ||
      readHeader(req, "x-admin-debug-token") ||
      readBearerToken(req);
    if (safeEqual(configuredToken, suppliedToken)) {
      return;
    }

    throw new HttpError(403, "AGENT_ADMIN_REQUIRED", "Agent internal debug access is required");
  }

  if (config.nodeEnv !== "production" && isLocalRequest(req)) {
    return;
  }

  throw new HttpError(403, "AGENT_ADMIN_REQUIRED", "Agent internal debug access is required");
}

async function getReusableProductionFinalResultSnapshot(taskId: string): Promise<{
  snapshot: PersistentAgentTaskSnapshot;
  finalResult: ProductionFinalResultData;
} | null> {
  try {
    const snapshot = await agentRepository.getTaskSnapshot(taskId);
    if (!snapshot) {
      return null;
    }
    const finalResult = resolveProductionFinalResult(snapshot);
    return finalResult?.schemaVersion === AGENT_PRODUCTION_FINAL_RESULT_SCHEMA_VERSION
      ? { snapshot, finalResult }
      : null;
  } catch {
    return null;
  }
}

function canReuseExistingTask(input: {
  task: PersistentAgentTask;
  actorHash: string;
  userContext: UserContext;
  readToken: string;
}): boolean {
  if (readString(input.task.metadata.actorHash) !== input.actorHash) {
    return false;
  }

  if (hasUserOwnership(input.task, input.userContext)) {
    return true;
  }

  return hasValidReadToken(input.task, input.readToken);
}

function assertTaskReadAccess(
  task: PersistentAgentTask,
  req: Request,
  userContext: UserContext
): void {
  if (hasUserOwnership(task, userContext)) {
    return;
  }

  if (hasValidReadToken(task, readAgentReadToken(req))) {
    return;
  }

  throw new HttpError(403, "AGENT_TASK_FORBIDDEN", "Agent task read token is required");
}

function assertLegacyTaskReadAccess(taskId: string, req: Request): void {
  const expectedHash = legacyTaskReadTokenHashes.get(taskId);
  if (expectedHash && safeEqual(expectedHash, hashReadToken(readAgentReadToken(req)))) {
    return;
  }

  throw new HttpError(403, "AGENT_TASK_FORBIDDEN", "Agent task read token is required");
}

function hasUserOwnership(task: PersistentAgentTask, userContext: UserContext): boolean {
  return Boolean(userContext.userId && task.userId && userContext.userId === task.userId);
}

function hasValidReadToken(task: PersistentAgentTask, readToken: string): boolean {
  return Boolean(readToken && safeEqual(readString(task.metadata.readTokenHash), hashReadToken(readToken)));
}

function createAgentReadCredential(): {
  readToken: string;
  readTokenHash: string;
} {
  const readToken = randomBytes(32).toString("base64url");
  return {
    readToken,
    readTokenHash: hashReadToken(readToken)
  };
}

function hashReadToken(readToken: string): string {
  return createHash("sha256").update(readToken).digest("hex");
}

function readAgentReadToken(req: Request): string {
  return (
    readHeader(req, "x-agent-read-token") ||
    readQueryString(req.query.readToken) ||
    (isRecord(req.body) ? readString(req.body.readToken) : "")
  ).trim();
}

function buildStoredCacheIdentity(identity: {
  normalizedQuery: string;
  metadataHash: string;
  dataMode: string;
  provider: string;
  schemaVersion: string;
  promptVersion: string;
  scoringVersion: string;
  evidenceExtractionVersion: string;
  llm: Record<string, unknown>;
}): Record<string, unknown> {
  return {
    normalizedQueryHash: hashQuery(identity.normalizedQuery),
    metadataHash: identity.metadataHash,
    dataMode: identity.dataMode,
    provider: identity.provider,
    schemaVersion: identity.schemaVersion,
    promptVersion: identity.promptVersion,
    scoringVersion: identity.scoringVersion,
    evidenceExtractionVersion: identity.evidenceExtractionVersion,
    llm: identity.llm
  };
}

function readHeader(req: Request, name: string): string {
  return readString(req.headers[name]);
}

function readQueryString(value: unknown): string {
  const first = Array.isArray(value) ? value[0] : value;
  return readString(first);
}

function readBearerToken(req: Request): string {
  const authorization = readHeader(req, "authorization");
  const match = /^Bearer\s+(.+)$/i.exec(authorization);
  return match?.[1]?.trim() ?? "";
}

function safeEqual(left: string, right: string): boolean {
  if (!left || !right) {
    return false;
  }

  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function isLocalRequest(req: Request): boolean {
  const candidates = [
    req.ip,
    req.socket.remoteAddress,
    readHeader(req, "host").split(":")[0]
  ].filter(Boolean);

  return candidates.some((value) =>
    value === "127.0.0.1" ||
    value === "::1" ||
    value === "::ffff:127.0.0.1" ||
    value === "localhost"
  );
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
