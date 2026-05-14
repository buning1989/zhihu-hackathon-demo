import dotenv from "dotenv";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const backendDir = resolve(scriptDir, "..");
const rootDir = resolve(backendDir, "..");

dotenv.config({ path: resolve(rootDir, ".env.local"), override: false });
dotenv.config({ path: resolve(backendDir, ".env.local"), override: false });

if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL is required to run agent worker smoke.");
  process.exit(1);
}

if (!process.env.REDIS_URL) {
  console.error("REDIS_URL is required to run agent worker smoke.");
  process.exit(1);
}

const repositoryPath = resolve(backendDir, "dist/agent/agentRepository.js");
const queuePath = resolve(backendDir, "dist/agent/agentQueue.js");
if (!existsSync(repositoryPath) || !existsSync(queuePath)) {
  console.error("Built agent runtime not found. Run `npm run build -w backend` before smoke:agent-worker.");
  process.exit(1);
}

const timeoutMs = readPositiveInteger(process.env.SMOKE_AGENT_WORKER_TIMEOUT_MS, 30000);
const apiBaseUrl = normalizeApiBaseUrl(process.env.AGENT_API_BASE_URL);

let closeQueue = async () => undefined;
let exitCode = 0;
try {
  const { taskId, getSnapshot } = apiBaseUrl
    ? await createTaskViaHttp(apiBaseUrl)
    : await createTaskViaRepository();

  const completedSnapshot = await waitForCompletedSnapshot(taskId, getSnapshot);

  assert(completedSnapshot.task.status === "completed", "task did not complete");
  assert(
    completedSnapshot.stages.some(
      (stage) => stage.stageName === "understand_goal_rule" && stage.status === "succeeded"
    ),
    "understand_goal_rule stage did not succeed"
  );
  assert(
    completedSnapshot.stages.some(
      (stage) =>
        stage.stageName === "plan_search_llm" &&
        (stage.status === "succeeded" || stage.status === "fallback")
    ),
    "plan_search_llm stage did not succeed or fallback"
  );
  assert(
    completedSnapshot.stages.some(
      (stage) =>
        stage.stageName === "retrieve_sources" &&
        (stage.status === "succeeded" || stage.status === "fallback")
    ),
    "retrieve_sources stage did not succeed or fallback"
  );
  assert(
    completedSnapshot.stages.some(
      (stage) => stage.stageName === "normalize_candidates" && stage.status === "succeeded"
    ),
    "normalize_candidates stage did not succeed"
  );
  assert(
    completedSnapshot.stages.some(
      (stage) =>
        stage.stageName === "evidence_extract_llm" &&
        (stage.status === "succeeded" || stage.status === "fallback")
    ),
    "evidence_extract_llm stage did not succeed or fallback"
  );
  assert(completedSnapshot.stages.length === 5, "agent worker did not record 5 stages");
  assert(
    completedSnapshot.artifacts.some((artifact) => artifact.type === "intent"),
    "intent artifact was not found"
  );
  assert(
    completedSnapshot.artifacts.some((artifact) => artifact.type === "search_plan"),
    "search_plan artifact was not found"
  );
  assert(
    completedSnapshot.artifacts.some((artifact) => artifact.type === "raw_sources"),
    "raw_sources artifact was not found"
  );
  const candidatesArtifact = completedSnapshot.artifacts.find(
    (artifact) => artifact.type === "candidates"
  );
  assert(candidatesArtifact, "candidates artifact was not found");
  const evidenceArtifact = completedSnapshot.artifacts.find(
    (artifact) => artifact.type === "evidence"
  );
  assert(evidenceArtifact, "evidence artifact was not found");
  assert(
    Array.isArray(evidenceArtifact.data?.evidenceItems),
    "evidence artifact did not include evidenceItems array"
  );
  assert(
    completedSnapshot.task.resultArtifactId === evidenceArtifact.id,
    "task.resultArtifactId does not point to evidence artifact"
  );
  assert(
    completedSnapshot.events.some((event) => event.type === "task.completed"),
    "task.completed event was not found"
  );

  console.log("agent worker smoke ok");
  console.log(`taskId=${completedSnapshot.task.id}`);
  console.log(`stageCount=${completedSnapshot.stages.length}`);
  console.log(`artifactCount=${completedSnapshot.artifacts.length}`);
  console.log(`eventCount=${completedSnapshot.events.length}`);
  console.log(`resultArtifactId=${completedSnapshot.task.resultArtifactId}`);
} catch (error) {
  console.error("agent worker smoke failed");
  console.error(error);
  exitCode = 1;
} finally {
  await closeQueue().catch(() => undefined);
}

if (exitCode) {
  process.exit(exitCode);
}

async function createTaskViaRepository() {
  const { agentRepository } = await import(repositoryPath);
  const { closeAgentTaskQueue, enqueueAgentTask } = await import(queuePath);
  closeQueue = closeAgentTaskQueue;

  const snapshot = await agentRepository.createTaskWithCreatedEvent({
    query: "agent worker smoke persistent task",
    metadata: {
      source: "agent_worker_smoke",
      createdBy: "backend/scripts/smoke-agent-worker.mjs"
    }
  });
  const enqueueResult = await enqueueAgentTask(snapshot.task.id);
  await agentRepository.createEvent({
    taskId: snapshot.task.id,
    type: "task.enqueued",
    payload: {
      jobId: enqueueResult.jobId,
      queueName: enqueueResult.queueName,
      source: "agent_worker_smoke"
    }
  });

  return {
    taskId: snapshot.task.id,
    getSnapshot: (taskId) => agentRepository.getTaskSnapshot(taskId)
  };
}

async function createTaskViaHttp(baseUrl) {
  const response = await fetch(`${baseUrl}/api/agent/tasks`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      query: "agent worker smoke persistent task",
      metadata: {
        source: "agent_worker_smoke",
        createdBy: "backend/scripts/smoke-agent-worker.mjs"
      }
    })
  });
  const body = await readJsonResponse(response);

  if (!response.ok || !body?.success) {
    throw new Error(`POST /api/agent/tasks failed: ${response.status} ${JSON.stringify(body)}`);
  }

  const taskId = typeof body.data?.taskId === "string" ? body.data.taskId : "";
  assert(taskId, "POST /api/agent/tasks did not return taskId");
  assert(body.data?.queueStatus === "enqueued", "POST /api/agent/tasks did not enqueue task");

  return {
    taskId,
    getSnapshot: (taskId) => getTaskSnapshotViaHttp(baseUrl, taskId)
  };
}

async function getTaskSnapshotViaHttp(baseUrl, taskId) {
  const response = await fetch(`${baseUrl}/api/agent/tasks/${encodeURIComponent(taskId)}`);
  if (response.status === 404) {
    return undefined;
  }

  const body = await readJsonResponse(response);
  if (!response.ok || !body?.success) {
    throw new Error(`GET /api/agent/tasks/${taskId} failed: ${response.status} ${JSON.stringify(body)}`);
  }

  return body.data;
}

async function waitForCompletedSnapshot(taskId, getSnapshot) {
  const startedAt = Date.now();
  let lastSnapshot;

  while (Date.now() - startedAt < timeoutMs) {
    const snapshot = await getSnapshot(taskId);
    if (snapshot) {
      lastSnapshot = snapshot;
      if (snapshot.task.status === "completed") {
        return snapshot;
      }

      if (snapshot.task.status === "failed") {
        throw new Error(`task failed: ${snapshot.task.error ?? "unknown error"}`);
      }
    }

    await delay(500);
  }

  throw new Error(
    `timed out waiting for task completion; last status=${lastSnapshot?.task.status ?? "missing"}`
  );
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function delay(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function readPositiveInteger(value, fallback) {
  if (!value) {
    return fallback;
  }

  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function normalizeApiBaseUrl(value) {
  const normalized = value?.trim();
  return normalized ? normalized.replace(/\/+$/, "") : "";
}

async function readJsonResponse(response) {
  const text = await response.text();
  return text ? JSON.parse(text) : undefined;
}
