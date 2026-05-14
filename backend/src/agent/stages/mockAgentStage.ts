import { agentRepository } from "../agentRepository.js";

const MOCK_STAGE_NAME = "mock_stage";
const MOCK_STAGE_DELAY_MS = 650;

export async function runMockAgentStage(taskId: string): Promise<void> {
  const task = await agentRepository.getTask(taskId);
  if (!task) {
    throw new Error(`Agent task not found: ${taskId}`);
  }

  const taskStartedAt = new Date();
  await agentRepository.updateTaskStatus(taskId, {
    status: "running",
    currentStage: MOCK_STAGE_NAME,
    progress: 10,
    startedAt: task.startedAt ?? taskStartedAt.toISOString(),
    error: null
  });
  await agentRepository.createEvent({
    taskId,
    type: "task.started",
    payload: {
      status: "running"
    }
  });

  const stageStartedAt = new Date();
  const stage = await agentRepository.createStageRun({
    taskId,
    stageName: MOCK_STAGE_NAME,
    status: "running",
    startedAt: stageStartedAt.toISOString()
  });
  await agentRepository.createEvent({
    taskId,
    type: "stage.started",
    payload: {
      stageRunId: stage.id,
      stageName: MOCK_STAGE_NAME
    }
  });

  try {
    await delay(MOCK_STAGE_DELAY_MS);

    const artifact = await agentRepository.createArtifact({
      taskId,
      type: "mock_result",
      data: {
        message: "mock agent stage completed"
      }
    });
    await agentRepository.createEvent({
      taskId,
      type: "artifact.created",
      payload: {
        artifactId: artifact.id,
        type: artifact.type
      }
    });

    const stageEndedAt = new Date();
    await agentRepository.updateStageRun(stage.id, {
      status: "succeeded",
      outputArtifactIds: [artifact.id],
      endedAt: stageEndedAt.toISOString(),
      durationMs: stageEndedAt.getTime() - stageStartedAt.getTime()
    });
    await agentRepository.createEvent({
      taskId,
      type: "stage.completed",
      payload: {
        stageRunId: stage.id,
        stageName: MOCK_STAGE_NAME,
        status: "succeeded",
        durationMs: stageEndedAt.getTime() - stageStartedAt.getTime()
      }
    });

    await agentRepository.updateTaskStatus(taskId, {
      status: "completed",
      currentStage: MOCK_STAGE_NAME,
      progress: 100,
      resultArtifactId: artifact.id,
      completedAt: stageEndedAt.toISOString(),
      error: null
    });
    await agentRepository.createEvent({
      taskId,
      type: "task.completed",
      payload: {
        resultArtifactId: artifact.id,
        status: "completed"
      }
    });
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
      taskId,
      type: "stage.failed",
      payload: {
        stageRunId: stage.id,
        stageName: MOCK_STAGE_NAME,
        error: message
      }
    });

    await agentRepository.updateTaskStatus(taskId, {
      status: "failed",
      currentStage: MOCK_STAGE_NAME,
      error: message,
      completedAt: failedAt.toISOString()
    });
    await agentRepository.createEvent({
      taskId,
      type: "task.failed",
      payload: {
        error: message
      }
    });

    throw error;
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
