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
  const { taskId, readToken, getSnapshot } = apiBaseUrl
    ? await createTaskViaHttp(apiBaseUrl)
    : await createTaskViaRepository();

  const completedSnapshot = await waitForCompletedSnapshot(taskId, getSnapshot, readToken);

  assert(
    completedSnapshot.task.status === "succeeded" || completedSnapshot.task.status === "completed",
    "task did not complete"
  );
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
        (stage.status === "succeeded" || stage.status === "fallback" || stage.status === "degraded")
    ),
    "plan_search_llm stage did not succeed or fallback"
  );
  assert(
    completedSnapshot.stages.some(
      (stage) =>
        stage.stageName === "retrieve_sources" &&
        (stage.status === "succeeded" || stage.status === "fallback" || stage.status === "degraded")
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
        (stage.status === "succeeded" || stage.status === "fallback" || stage.status === "degraded")
    ),
    "evidence_extract_llm stage did not succeed or fallback"
  );
  assert(
    completedSnapshot.stages.some(
      (stage) =>
        stage.stageName === "response_compose_llm" &&
        (stage.status === "succeeded" || stage.status === "fallback" || stage.status === "degraded")
    ),
    "response_compose_llm stage did not succeed or fallback"
  );
  assert(
    completedSnapshot.stages.some(
      (stage) =>
        stage.stageName === "grounding_guard_llm" &&
        (stage.status === "succeeded" || stage.status === "fallback" || stage.status === "degraded")
    ),
    "grounding_guard_llm stage did not succeed or fallback"
  );
  assert(completedSnapshot.stages.length === 7, "agent worker did not record 7 stages");
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
  const finalResultArtifact = completedSnapshot.artifacts.find(
    (artifact) => artifact.type === "final_result"
  );
  assert(finalResultArtifact, "final_result artifact was not found");
  assert(
    finalResultArtifact.data?.schemaVersion === "agent.final_result.v1",
    "final_result artifact schemaVersion was not agent.final_result.v1"
  );
  assert(typeof finalResultArtifact.data?.summary === "string", "final_result summary was missing");
  assert(Array.isArray(finalResultArtifact.data?.paths), "final_result paths array was missing");
  assert(Array.isArray(finalResultArtifact.data?.people), "final_result people array was missing");
  assert(
    Array.isArray(finalResultArtifact.data?.suggestedQuestions),
    "final_result suggestedQuestions array was missing"
  );
  const guardedFinalResultArtifact = completedSnapshot.artifacts.find(
    (artifact) => artifact.type === "guarded_final_result"
  );
  assert(guardedFinalResultArtifact, "guarded_final_result artifact was not found");
  assert(
    guardedFinalResultArtifact.data?.schemaVersion === "agent.guarded_final_result.v1",
    "guarded_final_result artifact schemaVersion was not agent.guarded_final_result.v1"
  );
  assert(guardedFinalResultArtifact.data?.result, "guarded_final_result result was missing");
  assert(guardedFinalResultArtifact.data?.guard, "guarded_final_result guard was missing");
  const productionFinalResultArtifact = completedSnapshot.artifacts.find(
    (artifact) => artifact.type === "production_final_result"
  );
  assert(productionFinalResultArtifact, "production_final_result artifact was not found");
  assert(
    completedSnapshot.task.resultArtifactId === productionFinalResultArtifact.id,
    "task.resultArtifactId does not point to production_final_result artifact"
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
  const readToken = typeof body.data?.readToken === "string" ? body.data.readToken : "";
  assert(taskId, "POST /api/agent/tasks did not return taskId");
  assert(readToken, "POST /api/agent/tasks did not return readToken");
  assert(body.data?.queueStatus === "enqueued", "POST /api/agent/tasks did not enqueue task");
  assert(body.data?.status === "queued", "POST /api/agent/tasks did not return queued status");
  assert(body.data?.resultUrl, "POST /api/agent/tasks did not return resultUrl");

  return {
    taskId,
    readToken,
    getSnapshot: (taskId, readToken) => getTaskSnapshotViaHttp(baseUrl, taskId, readToken)
  };
}

async function getTaskSnapshotViaHttp(baseUrl, taskId, readToken) {
  const response = await fetch(`${baseUrl}/api/agent/tasks/${encodeURIComponent(taskId)}`, {
    headers: agentReadTokenHeaders(readToken)
  });
  if (response.status === 404) {
    return undefined;
  }

  const body = await readJsonResponse(response);
  if (!response.ok || !body?.success) {
    throw new Error(`GET /api/agent/tasks/${taskId} failed: ${response.status} ${JSON.stringify(body)}`);
  }

  return body.data;
}

async function waitForCompletedSnapshot(taskId, getSnapshot, readToken) {
  const startedAt = Date.now();
  let lastSnapshot;

  while (Date.now() - startedAt < timeoutMs) {
    const snapshot = await getSnapshot(taskId, readToken);
    if (snapshot) {
      lastSnapshot = snapshot;
      if (snapshot.task?.status === "succeeded" || snapshot.task?.status === "completed") {
        return snapshot;
      }

      if (snapshot.task?.status === "failed") {
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

function agentReadTokenHeaders(readToken) {
  const token = String(readToken || "").trim();
  return token ? { "X-Agent-Read-Token": token } : {};
}

async function readJsonResponse(response) {
  const text = await response.text();
  return text ? JSON.parse(text) : undefined;
}
