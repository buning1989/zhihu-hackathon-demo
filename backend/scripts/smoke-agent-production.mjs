import dotenv from "dotenv";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const backendDir = resolve(scriptDir, "..");
const rootDir = resolve(backendDir, "..");

dotenv.config({ path: resolve(rootDir, ".env.local"), override: false });
dotenv.config({ path: resolve(backendDir, ".env.local"), override: false });

const apiBaseUrl = normalizeApiBaseUrl(process.env.AGENT_API_BASE_URL || process.env.BACKEND_URL || "http://127.0.0.1:8000");
const timeoutMs = readPositiveInteger(process.env.SMOKE_AGENT_PRODUCTION_TIMEOUT_MS, 60000);
const pollDelayMs = readPositiveInteger(process.env.SMOKE_AGENT_PRODUCTION_POLL_MS, 500);
const queries = [
  "我要不要裸辞？",
  "异地恋到底值不值得坚持？",
  "考研失败后该怎么办？",
  "要不要从大城市回老家？",
  "不结婚以后会不会后悔？"
];

let exitCode = 0;
try {
  for (const query of queries) {
    const started = await createTask(query);
    const status = await waitForTerminalStatus(started.taskId, query);

    if (status.status === "failed") {
      assert(status.error?.errorCode, `${query}: failed task missing errorCode`);
      assert(status.error?.errorMessage, `${query}: failed task missing errorMessage`);
      throw new Error(`${query}: task failed ${status.error.errorCode}: ${status.error.errorMessage}`);
    }

    assert(status.status === "succeeded", `${query}: task did not succeed`);
    assert(status.resultAvailable === true, `${query}: resultAvailable was not true`);
    const result = await readTaskResult(started.resultUrl || `/api/agent/tasks/${encodeURIComponent(started.taskId)}/result`);
    assertProductionFinalResult(result.final_result, query);
    console.log(`agent production smoke ok: ${query} taskId=${started.taskId}`);
  }

  console.log("agent production smoke ok");
} catch (error) {
  console.error("agent production smoke failed");
  console.error(error);
  exitCode = 1;
}

if (exitCode) {
  process.exit(exitCode);
}

async function createTask(query) {
  const response = await fetch(`${apiBaseUrl}/api/agent/tasks`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      query,
      metadata: {
        source: "agent_production_smoke",
        createdBy: "backend/scripts/smoke-agent-production.mjs"
      }
    })
  });
  const body = await readJsonResponse(response);

  if (!response.ok || !body?.success) {
    const errorCode = body?.error?.code;
    if (errorCode === "AGENT_DATABASE_UNCONFIGURED") {
      throw new Error(
        "POST /api/agent/tasks failed: DATABASE_URL is not configured. Start the compose stack or set DATABASE_URL for the backend and worker."
      );
    }

    if (errorCode === "AGENT_QUEUE_UNCONFIGURED") {
      throw new Error(
        "POST /api/agent/tasks failed: REDIS_URL is not configured. Start the compose stack or set REDIS_URL for the backend and worker."
      );
    }

    throw new Error(`POST /api/agent/tasks failed for ${query}: ${response.status} ${JSON.stringify(body)}`);
  }

  assert(typeof body.data?.taskId === "string" && body.data.taskId, `${query}: taskId missing`);
  assert(body.data.status === "queued", `${query}: create status was not queued`);
  assert(typeof body.data.frontendStatus === "string" && body.data.frontendStatus, `${query}: frontendStatus missing`);
  assert(Number.isFinite(body.data.pollAfterMs), `${query}: pollAfterMs missing`);
  assert(typeof body.data.resultUrl === "string" && body.data.resultUrl, `${query}: resultUrl missing`);

  return body.data;
}

async function waitForTerminalStatus(taskId, query) {
  const startedAt = Date.now();
  let lastStatus;

  while (Date.now() - startedAt < timeoutMs) {
    const status = await getTaskStatus(taskId);
    lastStatus = status;

    assert(status.taskId === taskId, `${query}: status taskId mismatch`);
    assert(typeof status.frontendStatus === "string", `${query}: status frontendStatus missing`);
    assert(Number.isFinite(status.progressPercent), `${query}: progressPercent missing`);
    assert(Array.isArray(status.stages), `${query}: stages missing`);
    assert(status.stages.length === 7, `${query}: expected 7 stages`);

    if (status.status === "succeeded" || status.status === "failed") {
      return status;
    }

    await delay(status.pollAfterMs > 0 ? Math.min(status.pollAfterMs, pollDelayMs) : pollDelayMs);
  }

  throw new Error(`${query}: timed out waiting for terminal status; last=${lastStatus?.status ?? "missing"}`);
}

async function getTaskStatus(taskId) {
  const response = await fetch(`${apiBaseUrl}/api/agent/tasks/${encodeURIComponent(taskId)}`);
  const body = await readJsonResponse(response);
  if (!response.ok || !body?.success) {
    throw new Error(`GET /api/agent/tasks/${taskId} failed: ${response.status} ${JSON.stringify(body)}`);
  }

  return body.data;
}

async function readTaskResult(resultUrl) {
  const url = resultUrl.startsWith("http") ? resultUrl : `${apiBaseUrl}${resultUrl}`;
  const response = await fetch(url);
  const body = await readJsonResponse(response);
  if (!response.ok || !body?.success) {
    throw new Error(`GET ${url} failed: ${response.status} ${JSON.stringify(body)}`);
  }

  return body.data;
}

function assertProductionFinalResult(finalResult, label) {
  assert(finalResult?.schemaVersion === "agent.production_final_result.v1", `${label}: final_result schemaVersion invalid`);
  assert(typeof finalResult.summary === "string", `${label}: summary missing`);
  assert(Array.isArray(finalResult.paths), `${label}: paths missing`);
  assert(Array.isArray(finalResult.personas), `${label}: personas missing`);
  assert(Array.isArray(finalResult.sources), `${label}: sources missing`);
  assert(isRecord(finalResult.evidenceMap), `${label}: evidenceMap missing`);
  assert(isRecord(finalResult.groundingReport), `${label}: groundingReport missing`);
  assert(typeof finalResult.degraded === "boolean", `${label}: degraded missing`);
  assert(finalResult.paths.length > 0, `${label}: expected at least one path`);
  assert(finalResult.personas.length > 0, `${label}: expected at least one persona`);

  const sourceIds = new Set(finalResult.sources.map((source) => source.sourceCandidateId));
  for (const [index, path] of finalResult.paths.entries()) {
    assertSourceRefs(path.sourceRefs, sourceIds, finalResult.evidenceMap, `${label}: paths[${index}]`);
  }

  for (const [index, persona] of finalResult.personas.entries()) {
    assertSourceRefs(persona.sourceRefs, sourceIds, finalResult.evidenceMap, `${label}: personas[${index}]`);
  }
}

function assertSourceRefs(sourceRefs, sourceIds, evidenceMap, label) {
  assert(Array.isArray(sourceRefs) && sourceRefs.length > 0, `${label}: sourceRefs missing`);

  for (const [index, sourceRef] of sourceRefs.entries()) {
    assert(sourceIds.has(sourceRef.sourceCandidateId), `${label}: sourceRefs[${index}].sourceCandidateId missing`);
    assert(Array.isArray(sourceRef.evidenceItemIds) && sourceRef.evidenceItemIds.length > 0, `${label}: sourceRefs[${index}].evidenceItemIds missing`);

    for (const evidenceItemId of sourceRef.evidenceItemIds) {
      const evidenceItem = evidenceMap[evidenceItemId];
      assert(evidenceItem, `${label}: evidenceItem ${evidenceItemId} missing`);
      assert(
        evidenceItem.sourceCandidateId === sourceRef.sourceCandidateId,
        `${label}: evidenceItem ${evidenceItemId} belongs to ${evidenceItem.sourceCandidateId}`
      );
    }
  }
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

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function readJsonResponse(response) {
  const text = await response.text();
  return text ? JSON.parse(text) : undefined;
}
