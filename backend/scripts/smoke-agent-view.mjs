import dotenv from "dotenv";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const backendDir = resolve(scriptDir, "..");
const rootDir = resolve(backendDir, "..");

dotenv.config({ path: resolve(rootDir, ".env.local"), override: false });
dotenv.config({ path: resolve(backendDir, ".env.local"), override: false });

const apiBaseUrl = normalizeApiBaseUrl(process.env.AGENT_API_BASE_URL || "http://127.0.0.1:8000");
const timeoutMs = readPositiveInteger(process.env.SMOKE_AGENT_VIEW_TIMEOUT_MS, 30000);

let exitCode = 0;
try {
  const { taskId, readToken } = await createPersistentTask();
  const view = await waitForCompletedView(taskId, readToken);
  const result = view.result;

  assert(view.status === "succeeded" || view.status === "completed", "task view did not complete");
  assert(Array.isArray(view.stages) && view.stages.length === 7, "task view did not include 7 stages");
  assert(result, "task view result was missing");
  assert(result.meta?.runtime === "persistent-agent", "result.meta.runtime was not persistent-agent");
  assert(result.meta?.taskId === taskId, "result.meta.taskId did not match taskId");
  assert(result.meta?.guard, "result.meta.guard was missing");
  assert(result.analysis && Array.isArray(result.analysis.steps), "result.analysis.steps was missing");
  assert(Array.isArray(result.paths), "result.paths was missing");
  assert(Array.isArray(result.people), "result.people was missing");
  assert(result.people.length > 0, "result.people was empty");

  console.log("agent view smoke ok");
  console.log(`taskId=${taskId}`);
  console.log(`stageCount=${view.stages.length}`);
  console.log(`pathCount=${result.paths.length}`);
  console.log(`peopleCount=${result.people.length}`);
  console.log(`guardStatus=${result.meta.guard.status}`);
} catch (error) {
  console.error("agent view smoke failed");
  console.error(error);
  exitCode = 1;
}

if (exitCode) {
  process.exit(exitCode);
}

async function createPersistentTask() {
  const response = await fetch(`${apiBaseUrl}/api/agent/tasks`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      query: "不工作了之后，我想去新西兰生活",
      metadata: {
        source: "agent_view_smoke",
        createdBy: "backend/scripts/smoke-agent-view.mjs"
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
  assert(body.data?.status === "queued", "POST /api/agent/tasks did not return queued status");
  assert(body.data?.resultUrl, "POST /api/agent/tasks did not return resultUrl");
  const readToken = typeof body.data?.readToken === "string" ? body.data.readToken : "";
  assert(readToken, "POST /api/agent/tasks did not return readToken");
  return { taskId, readToken };
}

async function waitForCompletedView(taskId, readToken) {
  const startedAt = Date.now();
  let lastView;

  while (Date.now() - startedAt < timeoutMs) {
    const view = await getTaskView(taskId, readToken);
    lastView = view;

    if (view.status === "succeeded" || view.status === "completed") {
      return view;
    }

    if (view.status === "failed") {
      throw new Error(`task failed: ${view.error?.message ?? "unknown error"}`);
    }

    await delay(500);
  }

  throw new Error(`timed out waiting for task view; last status=${lastView?.status ?? "missing"}`);
}

async function getTaskView(taskId, readToken) {
  const response = await fetch(`${apiBaseUrl}/api/agent/tasks/${encodeURIComponent(taskId)}/view`, {
    headers: agentReadTokenHeaders(readToken)
  });
  const body = await readJsonResponse(response);
  if (!response.ok || !body?.success) {
    throw new Error(`GET /api/agent/tasks/${taskId}/view failed: ${response.status} ${JSON.stringify(body)}`);
  }

  return body.data;
}

function agentReadTokenHeaders(readToken) {
  const token = String(readToken || "").trim();
  return token ? { "X-Agent-Read-Token": token } : {};
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
  return String(value || "").trim().replace(/\/+$/, "");
}

async function readJsonResponse(response) {
  const text = await response.text();
  return text ? JSON.parse(text) : undefined;
}
