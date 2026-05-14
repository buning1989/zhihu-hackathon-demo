import type { UserContext } from "../auth/session.js";
import {
  type DemoSearchPipelineCallbacks,
  type DemoSearchPipelineStageName
} from "../llm/demoSearchOrchestrator.js";
import { demoSearchService, type DemoSearchRequest } from "../services/demoSearch.service.js";
import type { DemoSearchResponse } from "../types/demo.types.js";
import { withRequestBudget } from "../utils/requestBudget.js";
import {
  AGENT_STAGE_TIMEOUT_MS,
  AGENT_LLM_TASK_TIMEOUT_MS,
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
      searchStageTimeoutMs: AGENT_STAGE_TIMEOUT_MS.content_search,
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
  updateTaskStage(taskId, stageName, {
    status,
    startedAt: new Date(startedAtMs).toISOString(),
    endedAt: new Date(endedAtMs).toISOString(),
    durationMs: endedAtMs - startedAtMs,
    ...(fallbackReason ? { fallbackReason } : {}),
    ...(error ? { error } : {})
  });

  if (payload && Object.keys(payload).length > 0) {
    updateTask(taskId, {
      debug: {
        [`${stageName}Payload`]: payload
      }
    });
  }
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
