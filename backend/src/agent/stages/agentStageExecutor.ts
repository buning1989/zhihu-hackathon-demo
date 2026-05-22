import { agentRepository } from "../agentRepository.js";
import { getAgentCacheTtlHours } from "../agentCache.js";
import { buildProductionFinalResult } from "../agentProductionResult.js";
import type { PersistentAgentTaskStatus } from "../agentModels.js";
import type {
  PersistentAgentArtifact,
  PersistentAgentStageRun
} from "../agentModels.js";
import { runNormalizeCandidatesStage } from "./normalizeCandidatesStage.js";
import { runPlanSearchLlmStage } from "./planSearchLlmStage.js";
import { runRetrieveSourcesStage } from "./retrieveSourcesStage.js";
import type {
  AgentBusinessStageName,
  AgentStageOutput,
  CandidatesArtifactData,
  EvidenceArtifactData,
  FinalResultArtifactData,
  GuardedFinalResultArtifactData,
  IntentArtifactData,
  RawSourcesArtifactData,
  SearchPlanArtifactData
} from "./stageTypes.js";
import {
  AGENT_ARTIFACT_CANDIDATES,
  AGENT_ARTIFACT_EVIDENCE,
  AGENT_STAGE_EVIDENCE_EXTRACT_LLM,
  AGENT_STAGE_GROUNDING_GUARD_LLM,
  AGENT_STAGE_NORMALIZE_CANDIDATES,
  AGENT_STAGE_PLAN_SEARCH_LLM,
  AGENT_ARTIFACT_PRODUCTION_FINAL_RESULT,
  AGENT_ARTIFACT_RAW_SOURCES,
  AGENT_STAGE_RESPONSE_COMPOSE_LLM,
  AGENT_STAGE_RETRIEVE_SOURCES,
  AGENT_STAGE_UNDERSTAND_GOAL_RULE
} from "./stageTypes.js";
import { runEvidenceExtractLlmStage } from "./evidenceExtractLlmStage.js";
import { runGroundingGuardLlmStage } from "./groundingGuardLlmStage.js";
import { runResponseComposeLlmStage } from "./responseComposeLlmStage.js";
import { runUnderstandGoalRuleStage } from "./understandGoalRuleStage.js";

interface ExecuteAgentStageInput<TData> {
  taskId: string;
  stageName: AgentBusinessStageName;
  inputArtifactIds?: string[];
  progressStarted: number;
  progressCompleted: number;
  taskStatus?: Extract<PersistentAgentTaskStatus, "running" | "partial_ready">;
  partialAvailableAfter?: boolean;
  cache?: {
    cacheKey: string;
    artifactType: string;
    ttlHours: number;
    validate: (value: unknown) => value is TData;
  };
  run: () => Promise<AgentStageOutput<TData>> | AgentStageOutput<TData>;
}

interface ExecutedAgentStage<TData> {
  stage: PersistentAgentStageRun;
  artifact: PersistentAgentArtifact;
  output: AgentStageOutput<TData>;
}

export class AgentStageExecutionError extends Error {
  readonly stageName: string;

  constructor(stageName: string, cause: unknown) {
    super(`Agent stage ${stageName} failed: ${toErrorMessage(cause)}`);
    this.name = "AgentStageExecutionError";
    this.stageName = stageName;
  }
}

export async function runAgentTaskStageWorkflow(taskId: string): Promise<void> {
  const task = await agentRepository.getTask(taskId);
  if (!task) {
    throw new Error(`Agent task not found: ${taskId}`);
  }

  const startedAt = new Date().toISOString();
  await updateTaskStatusWithMetadata(taskId, {
    status: "running",
    currentStage: AGENT_STAGE_UNDERSTAND_GOAL_RULE,
    progress: 5,
    startedAt: task.startedAt ?? startedAt,
    completedAt: null,
    error: null
  }, {
    frontendStatus: getFrontendStatus(AGENT_STAGE_UNDERSTAND_GOAL_RULE),
    progressPercent: 5,
    partialAvailable: false,
    resultAvailable: false,
    degraded: false,
    degradedReason: null,
    startedAt
  });
  await agentRepository.createEvent({
    taskId,
    type: "task.started",
    payload: {
      status: "running"
    }
  });

  try {
    const queryCacheKey = readString(task.metadata.queryCacheKey);
    const intentStage = await executeAgentStage<IntentArtifactData>({
      taskId,
      stageName: AGENT_STAGE_UNDERSTAND_GOAL_RULE,
      progressStarted: 10,
      progressCompleted: 20,
      run: () => runUnderstandGoalRuleStage(task)
    });
    const intent = intentStage.output.data;

    const searchPlanStage = await executeAgentStage<SearchPlanArtifactData>({
      taskId,
      stageName: AGENT_STAGE_PLAN_SEARCH_LLM,
      inputArtifactIds: [intentStage.artifact.id],
      progressStarted: 22,
      progressCompleted: 34,
      run: () => runPlanSearchLlmStage(taskId, intent)
    });
    const searchPlan = searchPlanStage.output.data;

    const rawSourcesStage = await executeAgentStage<RawSourcesArtifactData>({
      taskId,
      stageName: AGENT_STAGE_RETRIEVE_SOURCES,
      inputArtifactIds: [searchPlanStage.artifact.id],
      progressStarted: 38,
      progressCompleted: 52,
      partialAvailableAfter: true,
      cache: buildStageCache(queryCacheKey, AGENT_ARTIFACT_RAW_SOURCES, isRawSourcesArtifactData),
      run: () => runRetrieveSourcesStage(searchPlan, intent)
    });
    const rawSources = rawSourcesStage.output.data;

    const candidatesStage = await executeAgentStage<CandidatesArtifactData>({
      taskId,
      stageName: AGENT_STAGE_NORMALIZE_CANDIDATES,
      inputArtifactIds: [rawSourcesStage.artifact.id],
      progressStarted: 56,
      progressCompleted: 66,
      taskStatus: "partial_ready",
      partialAvailableAfter: true,
      cache: buildStageCache(queryCacheKey, AGENT_ARTIFACT_CANDIDATES, isCandidatesArtifactData),
      run: () => runNormalizeCandidatesStage(rawSources)
    });
    const candidates = candidatesStage.output.data;

    const evidenceStage = await executeAgentStage<EvidenceArtifactData>({
      taskId,
      stageName: AGENT_STAGE_EVIDENCE_EXTRACT_LLM,
      inputArtifactIds: [
        candidatesStage.artifact.id,
        searchPlanStage.artifact.id,
        intentStage.artifact.id
      ],
      progressStarted: 70,
      progressCompleted: 80,
      taskStatus: "partial_ready",
      partialAvailableAfter: true,
      cache: buildStageCache(queryCacheKey, AGENT_ARTIFACT_EVIDENCE, isEvidenceArtifactData),
      run: () => runEvidenceExtractLlmStage(taskId, candidates, searchPlan, intent)
    });
    const evidence = evidenceStage.output.data;

    const finalResultStage = await executeAgentStage<FinalResultArtifactData>({
      taskId,
      stageName: AGENT_STAGE_RESPONSE_COMPOSE_LLM,
      inputArtifactIds: [
        intentStage.artifact.id,
        searchPlanStage.artifact.id,
        candidatesStage.artifact.id,
        evidenceStage.artifact.id
      ],
      progressStarted: 84,
      progressCompleted: 91,
      taskStatus: "partial_ready",
      partialAvailableAfter: true,
      run: () => runResponseComposeLlmStage(taskId, intent, searchPlan, candidates, evidence)
    });
    const finalResult = finalResultStage.output.data;

    const guardedFinalResultStage = await executeAgentStage<GuardedFinalResultArtifactData>({
      taskId,
      stageName: AGENT_STAGE_GROUNDING_GUARD_LLM,
      inputArtifactIds: [
        finalResultStage.artifact.id,
        candidatesStage.artifact.id,
        evidenceStage.artifact.id
      ],
      progressStarted: 94,
      progressCompleted: 98,
      taskStatus: "partial_ready",
      partialAvailableAfter: true,
      run: () => runGroundingGuardLlmStage(taskId, finalResult, candidates, evidence)
    });
    const guardedFinalResult = guardedFinalResultStage.output.data;
    const productionFinalResult = buildProductionFinalResult({
      taskId,
      finalResult: guardedFinalResult.result,
      candidates,
      evidence,
      guard: guardedFinalResult.guard,
      degradedReasons: [
        ...[
          searchPlanStage,
          rawSourcesStage,
          evidenceStage,
          finalResultStage,
          guardedFinalResultStage
        ]
          .filter((stage) => stage.output.fallbackUsed || stage.output.status === "fallback" || stage.output.status === "degraded")
          .map((stage) => `${stage.stage.stageName}: ${stage.output.fallbackReason ?? "degraded"}`)
      ]
    });
    const productionArtifact = await agentRepository.createArtifact({
      taskId,
      type: AGENT_ARTIFACT_PRODUCTION_FINAL_RESULT,
      data: productionFinalResult
    });
    await agentRepository.createEvent({
      taskId,
      type: "artifact.created",
      payload: {
        stageName: "final_result_validator",
        artifactId: productionArtifact.id,
        type: productionArtifact.type,
        deterministicValidator:
          productionFinalResult.groundingReport.deterministicValidator.status
      }
    });

    const completedAt = new Date().toISOString();
    await updateTaskStatusWithMetadata(taskId, {
      status: "succeeded",
      currentStage: "completed",
      progress: 100,
      resultArtifactId: productionArtifact.id,
      completedAt,
      error: null
    }, {
      frontendStatus: "结果已准备好",
      progressPercent: 100,
      partialAvailable: true,
      resultAvailable: true,
      degraded: productionFinalResult.degraded,
      degradedReason: productionFinalResult.degradedReason,
      finishedAt: completedAt,
      resultArtifactType: productionArtifact.type
    });
    await agentRepository.createEvent({
      taskId,
      type: "task.completed",
      payload: {
        status: "succeeded",
        resultArtifactId: productionArtifact.id
      }
    });
  } catch (error) {
    const failedAt = new Date().toISOString();
    const stageName =
      error instanceof AgentStageExecutionError ? error.stageName : "agent_stage_workflow";
    const message = toErrorMessage(error);

    await updateTaskStatusWithMetadata(taskId, {
      status: "failed",
      currentStage: stageName,
      completedAt: failedAt,
      error: message
    }, {
      frontendStatus: "任务失败",
      errorCode: "AGENT_STAGE_FAILED",
      errorMessage: message,
      resultAvailable: false,
      finishedAt: failedAt
    });
    await agentRepository.createEvent({
      taskId,
      type: "task.failed",
      payload: {
        stageName,
        error: message
      }
    });

    throw error;
  }
}

async function executeAgentStage<TData>(
  input: ExecuteAgentStageInput<TData>
): Promise<ExecutedAgentStage<TData>> {
  await updateTaskStatusWithMetadata(input.taskId, {
    status: input.taskStatus ?? "running",
    currentStage: input.stageName,
    progress: input.progressStarted,
    error: null
  }, {
    frontendStatus: getFrontendStatus(input.stageName),
    progressPercent: input.progressStarted
  });

  const stageStartedAt = new Date();
  const stage = await agentRepository.createStageRun({
    taskId: input.taskId,
    stageName: input.stageName,
    status: "running",
    inputArtifactIds: input.inputArtifactIds ?? [],
    startedAt: stageStartedAt.toISOString()
  });

  await agentRepository.createEvent({
    taskId: input.taskId,
    type: "stage.started",
    payload: {
      stageRunId: stage.id,
      stageName: input.stageName,
      inputArtifactIds: input.inputArtifactIds ?? []
    }
  });

  try {
    const output = (await readCachedStageOutput(input)) ?? (await input.run());
    const outputStatus = output.status ?? "succeeded";
    const status = outputStatus === "fallback" ? "degraded" : outputStatus;
    const fallbackUsed =
      output.fallbackUsed ?? (outputStatus === "fallback" || outputStatus === "degraded");
    const fallbackReason = output.fallbackReason ?? null;
    const artifact = await agentRepository.createArtifact({
      taskId: input.taskId,
      type: output.artifactType,
      data: output.data
    });

    await agentRepository.createEvent({
      taskId: input.taskId,
      type: "artifact.created",
      payload: {
        stageName: input.stageName,
        artifactId: artifact.id,
        type: artifact.type
      }
    });

    const stageEndedAt = new Date();
    const durationMs = stageEndedAt.getTime() - stageStartedAt.getTime();
    const updatedStage = await agentRepository.updateStageRun(stage.id, {
      status,
      outputArtifactIds: [artifact.id],
      fallbackUsed,
      fallbackReason,
      endedAt: stageEndedAt.toISOString(),
      durationMs
    });

    await agentRepository.createEvent({
      taskId: input.taskId,
      type: status === "degraded" ? "stage.degraded" : "stage.completed",
      payload: {
        stageRunId: stage.id,
        stageName: input.stageName,
        status,
        fallbackUsed,
        fallbackReason,
        cacheHit: output.cacheHit ?? false,
        cacheKey: output.cacheKey ?? null,
        artifactId: artifact.id,
        durationMs
      }
    });
    await updateTaskStatusWithMetadata(input.taskId, {
      status: input.partialAvailableAfter ? "partial_ready" : input.taskStatus ?? "running",
      currentStage: input.stageName,
      progress: input.progressCompleted,
      error: null
    }, {
      frontendStatus: input.partialAvailableAfter
        ? "已找到可展示线索，继续检查证据"
        : getFrontendStatus(input.stageName),
      progressPercent: input.progressCompleted,
      ...(input.partialAvailableAfter ? { partialAvailable: true } : {})
    });

    return {
      stage: updatedStage ?? {
        ...stage,
        status,
        outputArtifactIds: [artifact.id],
        fallbackUsed,
        fallbackReason,
        endedAt: stageEndedAt.toISOString(),
        durationMs
      },
      artifact,
      output
    };
  } catch (error) {
    const failedAt = new Date();
    const message = toErrorMessage(error);

    await agentRepository.updateStageRun(stage.id, {
      status: "failed_final",
      error: message,
      endedAt: failedAt.toISOString(),
      durationMs: failedAt.getTime() - stageStartedAt.getTime()
    });
    await agentRepository.createEvent({
      taskId: input.taskId,
      type: "stage.failed",
      payload: {
        stageRunId: stage.id,
        stageName: input.stageName,
        error: message
      }
    });

    throw new AgentStageExecutionError(input.stageName, error);
  }
}

async function readCachedStageOutput<TData>(
  input: ExecuteAgentStageInput<TData>
): Promise<AgentStageOutput<TData> | undefined> {
  if (!input.cache?.cacheKey) {
    return undefined;
  }

  const cachedArtifact = await agentRepository.findCachedArtifactByTaskCacheKey({
    queryCacheKey: input.cache.cacheKey,
    artifactType: input.cache.artifactType,
    ttlHours: input.cache.ttlHours
  });
  if (!cachedArtifact || !input.cache.validate(cachedArtifact.data)) {
    return undefined;
  }

  await agentRepository.createEvent({
    taskId: input.taskId,
    type: "stage.cache_hit",
    payload: {
      stageName: input.stageName,
      cacheKey: input.cache.cacheKey,
      cachedTaskId: cachedArtifact.taskId,
      cachedArtifactId: cachedArtifact.id,
      type: cachedArtifact.type
    }
  });

  return {
    artifactType: input.cache.artifactType,
    data: cachedArtifact.data,
    status: "succeeded",
    fallbackUsed: false,
    fallbackReason: null,
    cacheHit: true,
    cacheKey: input.cache.cacheKey
  };
}

async function updateTaskStatusWithMetadata(
  taskId: string,
  patch: Parameters<typeof agentRepository.updateTaskStatus>[1],
  metadataPatch: Record<string, unknown>
): Promise<void> {
  const current = await agentRepository.getTask(taskId);
  await agentRepository.updateTaskStatus(taskId, {
    ...patch,
    metadata: {
      ...(current?.metadata ?? {}),
      ...metadataPatch
    }
  });
}

function getFrontendStatus(stageName: string): string {
  const labels: Record<string, string> = {
    [AGENT_STAGE_UNDERSTAND_GOAL_RULE]: "正在理解你的问题",
    [AGENT_STAGE_PLAN_SEARCH_LLM]: "正在规划检索方向",
    [AGENT_STAGE_RETRIEVE_SOURCES]: "正在查找知乎公开内容",
    [AGENT_STAGE_NORMALIZE_CANDIDATES]: "正在筛选高质量样本",
    [AGENT_STAGE_EVIDENCE_EXTRACT_LLM]: "正在抽取证据片段",
    [AGENT_STAGE_RESPONSE_COMPOSE_LLM]: "正在整理路径和样本",
    [AGENT_STAGE_GROUNDING_GUARD_LLM]: "正在检查证据边界"
  };

  return labels[stageName] ?? "正在处理任务";
}

function buildStageCache<TData>(
  cacheKey: string,
  artifactType: string,
  validate: (value: unknown) => value is TData
): ExecuteAgentStageInput<TData>["cache"] | undefined {
  const ttlHours = getAgentCacheTtlHours(artifactType);
  if (!cacheKey || !ttlHours) {
    return undefined;
  }

  return {
    cacheKey,
    artifactType,
    ttlHours,
    validate
  };
}

function isRawSourcesArtifactData(value: unknown): value is RawSourcesArtifactData {
  return Boolean(
    isRecord(value) &&
      typeof value.query === "string" &&
      Array.isArray(value.expandedQueries) &&
      Array.isArray(value.sources)
  );
}

function isCandidatesArtifactData(value: unknown): value is CandidatesArtifactData {
  return Boolean(isRecord(value) && Array.isArray(value.candidates));
}

function isEvidenceArtifactData(value: unknown): value is EvidenceArtifactData {
  return Boolean(isRecord(value) && Array.isArray(value.evidenceItems));
}

function readString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
