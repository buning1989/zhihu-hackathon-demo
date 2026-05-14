import { agentRepository } from "../agentRepository.js";
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
  IntentArtifactData,
  RawSourcesArtifactData,
  SearchPlanArtifactData
} from "./stageTypes.js";
import {
  AGENT_STAGE_EVIDENCE_EXTRACT_LLM,
  AGENT_STAGE_NORMALIZE_CANDIDATES,
  AGENT_STAGE_PLAN_SEARCH_LLM,
  AGENT_STAGE_RETRIEVE_SOURCES,
  AGENT_STAGE_UNDERSTAND_GOAL_RULE
} from "./stageTypes.js";
import { runEvidenceExtractLlmStage } from "./evidenceExtractLlmStage.js";
import { runUnderstandGoalRuleStage } from "./understandGoalRuleStage.js";

interface ExecuteAgentStageInput<TData> {
  taskId: string;
  stageName: AgentBusinessStageName;
  inputArtifactIds?: string[];
  progressStarted: number;
  progressCompleted: number;
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
  await agentRepository.updateTaskStatus(taskId, {
    status: "running",
    currentStage: AGENT_STAGE_UNDERSTAND_GOAL_RULE,
    progress: 5,
    startedAt: task.startedAt ?? startedAt,
    completedAt: null,
    error: null
  });
  await agentRepository.createEvent({
    taskId,
    type: "task.started",
    payload: {
      status: "running"
    }
  });

  try {
    const intentStage = await executeAgentStage<IntentArtifactData>({
      taskId,
      stageName: AGENT_STAGE_UNDERSTAND_GOAL_RULE,
      progressStarted: 10,
      progressCompleted: 28,
      run: () => runUnderstandGoalRuleStage(task)
    });
    const intent = intentStage.output.data;

    const searchPlanStage = await executeAgentStage<SearchPlanArtifactData>({
      taskId,
      stageName: AGENT_STAGE_PLAN_SEARCH_LLM,
      inputArtifactIds: [intentStage.artifact.id],
      progressStarted: 30,
      progressCompleted: 43,
      run: () => runPlanSearchLlmStage(taskId, intent)
    });
    const searchPlan = searchPlanStage.output.data;

    const rawSourcesStage = await executeAgentStage<RawSourcesArtifactData>({
      taskId,
      stageName: AGENT_STAGE_RETRIEVE_SOURCES,
      inputArtifactIds: [searchPlanStage.artifact.id],
      progressStarted: 48,
      progressCompleted: 65,
      run: () => runRetrieveSourcesStage(searchPlan, intent)
    });
    const rawSources = rawSourcesStage.output.data;

    const candidatesStage = await executeAgentStage<CandidatesArtifactData>({
      taskId,
      stageName: AGENT_STAGE_NORMALIZE_CANDIDATES,
      inputArtifactIds: [rawSourcesStage.artifact.id],
      progressStarted: 70,
      progressCompleted: 82,
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
      progressStarted: 86,
      progressCompleted: 95,
      run: () => runEvidenceExtractLlmStage(taskId, candidates, searchPlan, intent)
    });

    const completedAt = new Date().toISOString();
    await agentRepository.updateTaskStatus(taskId, {
      status: "completed",
      currentStage: "completed",
      progress: 100,
      resultArtifactId: evidenceStage.artifact.id,
      completedAt,
      error: null
    });
    await agentRepository.createEvent({
      taskId,
      type: "task.completed",
      payload: {
        status: "completed",
        resultArtifactId: evidenceStage.artifact.id
      }
    });
  } catch (error) {
    const failedAt = new Date().toISOString();
    const stageName =
      error instanceof AgentStageExecutionError ? error.stageName : "agent_stage_workflow";
    const message = toErrorMessage(error);

    await agentRepository.updateTaskStatus(taskId, {
      status: "failed",
      currentStage: stageName,
      completedAt: failedAt,
      error: message
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
  await agentRepository.updateTaskStatus(input.taskId, {
    status: "running",
    currentStage: input.stageName,
    progress: input.progressStarted,
    error: null
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
    const output = await input.run();
    const status = output.status ?? "succeeded";
    const fallbackUsed = output.fallbackUsed ?? status === "fallback";
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
      type: status === "fallback" ? "stage.fallback" : "stage.completed",
      payload: {
        stageRunId: stage.id,
        stageName: input.stageName,
        status,
        fallbackUsed,
        fallbackReason,
        artifactId: artifact.id,
        durationMs
      }
    });
    await agentRepository.updateTaskStatus(input.taskId, {
      status: "running",
      currentStage: input.stageName,
      progress: input.progressCompleted,
      error: null
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
      status: "failed",
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

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
