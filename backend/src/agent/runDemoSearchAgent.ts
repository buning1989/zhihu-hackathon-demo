import type { UserContext } from "../auth/session.js";
import {
  type DemoSearchPipelineCallbacks,
  type DemoSearchPipelineStageName
} from "../llm/demoSearchOrchestrator.js";
import { demoSearchService, type DemoSearchRequest } from "../services/demoSearch.service.js";
import type { DemoSearchResponse } from "../types/demo.types.js";
import { withRequestBudget } from "../utils/requestBudget.js";
import {
  AGENT_LLM_TASK_MAX_RETRY,
  AGENT_LLM_TASK_MIN_TIMEOUT_MS,
  AGENT_LLM_TASK_RESERVED_AFTER_MS,
  AGENT_STAGE_TIMEOUT_MS,
  AGENT_LLM_TASK_TIMEOUT_MS,
  AGENT_SEARCH_CONCURRENCY,
  AGENT_SEARCH_QUERY_LIMIT,
  AGENT_TOTAL_TIMEOUT_MS
} from "./agentTimeouts.js";
import {
  getTask,
  updateTask,
  updateTaskStage
} from "./agentTaskStore.js";
import type {
  AgentPartialResult,
  AgentStage,
  AgentStageName,
  AgentTaskDebug,
  AgentTaskError
} from "./agentTypes.js";

export interface RunDemoSearchAgentInput {
  taskId: string;
  request: DemoSearchRequest;
  userContext?: UserContext;
}

export async function runDemoSearchAgent(
  input: RunDemoSearchAgentInput
): Promise<DemoSearchResponse> {
  const stageStartedAt = new Map<AgentStageName, number>();
  updateTask(input.taskId, {
    debug: {
      timeoutProfile: {
        totalTimeoutMs: AGENT_TOTAL_TIMEOUT_MS,
        stageTimeoutMs: AGENT_STAGE_TIMEOUT_MS,
        llmTaskTimeoutMs: AGENT_LLM_TASK_TIMEOUT_MS,
        llmTaskMinTimeoutMs: AGENT_LLM_TASK_MIN_TIMEOUT_MS,
        llmTaskReservedAfterMs: AGENT_LLM_TASK_RESERVED_AFTER_MS,
        llmTaskMaxRetry: AGENT_LLM_TASK_MAX_RETRY,
        searchQueryLimit: AGENT_SEARCH_QUERY_LIMIT,
        searchConcurrency: AGENT_SEARCH_CONCURRENCY
      }
    }
  });
  const callbacks: DemoSearchPipelineCallbacks = {
    onStageStart(stageName) {
      const agentStage = toAgentStageName(stageName);
      const now = Date.now();
      stageStartedAt.set(agentStage, now);
      updateTaskStage(input.taskId, agentStage, {
        status: "running",
        startedAt: new Date(now).toISOString()
      });
    },
    onStageComplete(stageName, payload) {
      finishStage(input.taskId, stageStartedAt, toAgentStageName(stageName), "completed", payload);
    },
    onStageFallback(stageName, reason, payload) {
      finishStage(input.taskId, stageStartedAt, toAgentStageName(stageName), "fallback", payload, reason);
    },
    onStageTimeout(stageName, reason, payload) {
      finishStage(input.taskId, stageStartedAt, toAgentStageName(stageName), "timeout", payload, reason);
    },
    onStageError(stageName, error, payload) {
      const agentStage = toAgentStageName(stageName);
      const taskError = toAgentTaskError(error, agentStage);
      finishStage(
        input.taskId,
        stageStartedAt,
        agentStage,
        "error",
        payload,
        taskError.message,
        taskError
      );
    },
    onPartialResult(partial) {
      updateTask(input.taskId, {
        partial: partial as AgentPartialResult
      });
    },
    onFinalResult(response) {
      updateTask(input.taskId, {
        partial: extractPartialFromResult(response),
        debug: extractDebugFromResult(response)
      });
      settlePendingStages(input.taskId, response);
    }
  };

  const result = await withRequestBudget(
    demoSearchService.search(input.request, input.userContext, {
      bypassCache: true,
      requestBudgetMs: AGENT_TOTAL_TIMEOUT_MS,
      stageTimeoutMs: AGENT_LLM_TASK_TIMEOUT_MS,
      stageMinTimeoutMs: AGENT_LLM_TASK_MIN_TIMEOUT_MS,
      stageReservedAfterMs: AGENT_LLM_TASK_RESERVED_AFTER_MS,
      stageMaxRetry: AGENT_LLM_TASK_MAX_RETRY,
      searchStageTimeoutMs: AGENT_STAGE_TIMEOUT_MS.content_search,
      searchQueryLimit: AGENT_SEARCH_QUERY_LIMIT,
      searchConcurrency: AGENT_SEARCH_CONCURRENCY,
      pipelineCallbacks: callbacks
    }),
    AGENT_TOTAL_TIMEOUT_MS,
    "AGENT_TASK_TIMEOUT",
    `Agent task exceeded ${AGENT_TOTAL_TIMEOUT_MS}ms total budget`
  );

  callbacks.onFinalResult?.(result);
  return result;
}

function finishStage(
  taskId: string,
  stageStartedAt: Map<AgentStageName, number>,
  stageName: AgentStageName,
  status: AgentStage["status"],
  payload?: Record<string, unknown>,
  fallbackReason?: string,
  error?: AgentTaskError
): void {
  const endedAtMs = Date.now();
  const startedAtMs = stageStartedAt.get(stageName) ?? endedAtMs;
  const observability = extractStageObservability(payload);
  updateTaskStage(taskId, stageName, {
    status,
    startedAt: new Date(startedAtMs).toISOString(),
    endedAt: new Date(endedAtMs).toISOString(),
    durationMs: endedAtMs - startedAtMs,
    ...observability,
    ...(fallbackReason ? { fallbackReason } : {}),
    ...(error ? { error } : {})
  });

  if (payload && Object.keys(payload).length > 0) {
    const task = getTask(taskId);
    const budgetTrace = readDebugArray(task?.debug?.budgetTrace);
    const providerTrace = readDebugArray(task?.debug?.providerTrace);
    updateTask(taskId, {
      debug: {
        [`${stageName}Payload`]: payload,
        budgetTrace: [
          ...budgetTrace,
          {
            stage: stageName,
            status,
            budgetMs: readNumber(payload.budgetMs),
            remainingBudgetMs: readNumber(payload.remainingBudgetMs),
            maxTimeoutMs: readNumber(payload.maxTimeoutMs),
            minTimeoutMs: readNumber(payload.minTimeoutMs),
            reserveAfterMs: readNumber(payload.reserveAfterMs),
            effectiveTimeoutMs: readNumber(payload.effectiveTimeoutMs),
            fallbackReason
          }
        ],
        providerTrace: [
          ...providerTrace,
          {
            stage: stageName,
            provider: readString(payload.provider),
            model: readString(payload.model),
            attempts: readNumber(payload.attempts)
          }
        ]
      }
    });
  }
}

function extractStageObservability(
  payload?: Record<string, unknown>
): Pick<AgentStage, "budgetMs" | "effectiveTimeoutMs" | "provider" | "model" | "attempts"> {
  if (!payload) {
    return {};
  }

  return {
    ...(readNumber(payload.budgetMs) ? { budgetMs: readNumber(payload.budgetMs) } : {}),
    ...(readNumber(payload.effectiveTimeoutMs)
      ? { effectiveTimeoutMs: readNumber(payload.effectiveTimeoutMs) }
      : {}),
    ...(readString(payload.provider) ? { provider: readString(payload.provider) } : {}),
    ...(readString(payload.model) ? { model: readString(payload.model) } : {}),
    ...(readNumber(payload.attempts) ? { attempts: readNumber(payload.attempts) } : {})
  };
}

function readNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function readDebugArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function settlePendingStages(taskId: string, response: DemoSearchResponse): void {
  const task = getTask(taskId);
  if (!task || task.status !== "running") {
    return;
  }

  const now = new Date().toISOString();
  const fallbackReason = response.meta.fallbackUsed
    ? response.debug.fallbackReason || "completed with deterministic fallback"
    : "";
  const stages = task.stages.map((stage) => {
    if (stage.status !== "pending" && stage.status !== "running") {
      return stage;
    }

    return {
      ...stage,
      status: fallbackReason ? "fallback" : "completed",
      startedAt: stage.startedAt ?? now,
      endedAt: now,
      durationMs: stage.startedAt ? Date.now() - Date.parse(stage.startedAt) : 0,
      ...(fallbackReason ? { fallbackReason } : {})
    } satisfies AgentStage;
  });

  updateTask(taskId, {
    currentStage: null,
    stages
  });
}

function toAgentStageName(stageName: DemoSearchPipelineStageName): AgentStageName {
  return stageName;
}

function toAgentTaskError(error: unknown, stage?: AgentStageName): AgentTaskError {
  if (error instanceof Error) {
    return {
      code: "code" in error && typeof error.code === "string" ? error.code : error.name || "ERROR",
      message: error.message || "Agent stage failed",
      ...(stage ? { stage } : {})
    };
  }

  return {
    code: "AGENT_STAGE_FAILED",
    message: "Agent stage failed",
    ...(stage ? { stage } : {})
  };
}

function extractPartialFromResult(response: DemoSearchResponse): AgentPartialResult {
  return {
    expandedQueries: response.debug.searchQueries,
    searchStats: {
      rawCandidateCount: response.debug.rawCandidateCount,
      mergedCandidateCount: response.debug.mergedCandidateCount,
      dedupedCandidateCount: response.debug.dedupedCandidateCount,
      validCandidateCount: response.debug.validCandidateCount,
      finalCandidateCount: response.debug.finalCandidateCount
    },
    candidates: response.debug.finalCandidates,
    evidence: response.meta.sourceRefs,
    paths: response.paths,
    people: response.people,
    personas: response.personas
  };
}

function extractDebugFromResult(response: DemoSearchResponse): AgentTaskDebug {
  return {
    timings: response.debug.timings,
    llmStages: response.meta.llmStages,
    fallbackStages: response.meta.fallbackStages,
    timedOutStages: response.meta.timedOutStages,
    notes: response.debug.notes,
    cacheHit: response.debug.cacheHit,
    fallbackUsed: response.debug.fallbackUsed,
    fallbackReason: response.debug.fallbackReason
  };
}
