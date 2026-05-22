import { Worker, type Job } from "bullmq";
import {
  AGENT_TASK_JOB_NAME,
  createAgentRedisConnection,
  getAgentTaskQueueName,
  type AgentTaskJobData
} from "./agentQueue.js";
import { runAgentTaskStageWorkflow } from "./stages/agentStageExecutor.js";

export interface StartAgentWorkerOptions {
  concurrency?: number;
}

export async function startAgentWorker(
  options: StartAgentWorkerOptions = {}
): Promise<Worker<AgentTaskJobData>> {
  const worker = new Worker<AgentTaskJobData, unknown, string>(
    getAgentTaskQueueName(),
    processAgentTaskJob,
    {
      concurrency: options.concurrency ?? 1,
      connection: createAgentRedisConnection({
        enableOfflineQueue: true,
        maxRetriesPerRequest: null
      })
    }
  );

  worker.on("completed", (job) => {
    console.log(`agent worker completed job ${job.id ?? ""} taskId=${job.data.taskId}`);
  });
  worker.on("failed", (job, error) => {
    console.error(
      `agent worker failed job ${job?.id ?? ""} taskId=${job?.data.taskId ?? ""}: ${error.message}`
    );
  });
  worker.on("error", (error) => {
    console.error(`agent worker error: ${error.message}`);
  });

  await worker.waitUntilReady();
  console.log(`agent worker listening queue=${getAgentTaskQueueName()}`);

  return worker;
}

async function processAgentTaskJob(job: Job<AgentTaskJobData>): Promise<{
  taskId: string;
  status: "succeeded";
}> {
  if (job.name !== AGENT_TASK_JOB_NAME) {
    throw new Error(`Unsupported agent job name: ${job.name}`);
  }

  const taskId = readTaskId(job.data);
  await runAgentTaskStageWorkflow(taskId);

  return {
    taskId,
    status: "succeeded"
  };
}

function readTaskId(data: AgentTaskJobData): string {
  const taskId = typeof data.taskId === "string" ? data.taskId.trim() : "";
  if (!taskId) {
    throw new Error("Agent task job is missing taskId");
  }

  return taskId;
}
