import { Queue, type JobsOptions } from "bullmq";
import { Redis, type RedisOptions } from "ioredis";
import { config } from "../config/env.js";
import { HttpError } from "../utils/httpError.js";

export const AGENT_TASK_JOB_NAME = "agent-task";

export interface AgentTaskJobData {
  taskId: string;
}

export interface AgentTaskEnqueueResult {
  jobId: string;
  queueName: string;
}

let agentTaskQueue: Queue<AgentTaskJobData> | undefined;
let agentTaskQueueConnection: Redis | undefined;

export function isAgentQueueConfigured(): boolean {
  return Boolean(config.redisUrl);
}

export function getAgentTaskQueueName(): string {
  return config.agent.queueName;
}

export async function enqueueAgentTask(taskId: string): Promise<AgentTaskEnqueueResult> {
  assertQueueConfigured();

  try {
    const queue = getAgentTaskQueue();
    await queue.waitUntilReady();
    const job = await queue.add(AGENT_TASK_JOB_NAME, { taskId }, createAgentTaskJobOptions(taskId));

    return {
      jobId: job.id ?? taskId,
      queueName: queue.name
    };
  } catch (error) {
    await closeAgentTaskQueue().catch(() => undefined);
    throw error;
  }
}

export async function assertAgentTaskQueueReady(): Promise<void> {
  assertQueueConfigured();

  try {
    await getAgentTaskQueue().waitUntilReady();
  } catch (error) {
    await closeAgentTaskQueue().catch(() => undefined);
    throw error;
  }
}

export function createAgentRedisConnection(options: {
  maxRetriesPerRequest?: number | null;
  enableOfflineQueue?: boolean;
} = {}): Redis {
  assertQueueConfigured();

  const redisOptions: RedisOptions = {
    connectTimeout: 1000,
    enableOfflineQueue: options.enableOfflineQueue ?? false,
    maxRetriesPerRequest: options.maxRetriesPerRequest ?? 1,
    retryStrategy: (attempt) => {
      if (attempt > 3) {
        return null;
      }

      return Math.min(attempt * 100, 500);
    }
  };

  const connection = new Redis(config.redisUrl, redisOptions);
  connection.on("error", () => undefined);

  return connection;
}

export async function closeAgentTaskQueue(): Promise<void> {
  const queue = agentTaskQueue;
  const connection = agentTaskQueueConnection;

  agentTaskQueue = undefined;
  agentTaskQueueConnection = undefined;

  await queue?.close();

  if (connection) {
    await connection.quit().catch(() => {
      connection.disconnect();
    });
  }
}

function getAgentTaskQueue(): Queue<AgentTaskJobData> {
  agentTaskQueueConnection ??= createAgentRedisConnection({
    enableOfflineQueue: false,
    maxRetriesPerRequest: 1
  });

  agentTaskQueue ??= new Queue<AgentTaskJobData>(getAgentTaskQueueName(), {
    connection: agentTaskQueueConnection
  });

  return agentTaskQueue;
}

function createAgentTaskJobOptions(taskId: string): JobsOptions {
  return {
    attempts: 1,
    jobId: taskId,
    removeOnComplete: {
      age: 24 * 60 * 60,
      count: 1000
    },
    removeOnFail: {
      age: 7 * 24 * 60 * 60,
      count: 1000
    }
  };
}

function assertQueueConfigured(): void {
  if (!isAgentQueueConfigured()) {
    throw new HttpError(
      503,
      "AGENT_QUEUE_UNCONFIGURED",
      "REDIS_URL is not configured; persistent Agent task queue is unavailable"
    );
  }
}
