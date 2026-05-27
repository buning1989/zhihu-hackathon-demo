#!/usr/bin/env node
import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

await main().catch((error) => {
  console.error(`FAIL ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});

async function main() {
  const scriptDir = dirname(fileURLToPath(import.meta.url));
  const repoRoot = dirname(scriptDir);
  process.chdir(repoRoot);
  const dataMode = resolveSmokeDataMode();
  process.env.DATA_MODE = process.env.DATA_MODE || dataMode;
  printZhihuRiskNotice(dataMode, 1);

  const appPath = join(repoRoot, "backend", "dist", "app.js");
  if (!existsSync(appPath)) {
    throw new Error("backend/dist/app.js not found. Run `npm run build -w backend` first.");
  }

  const { app } = await import(pathToFileURL(appPath).href);
  const server = app.listen(0, "127.0.0.1");

  try {
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Smoke server did not expose a TCP address.");
    }

    const baseUrl = `http://127.0.0.1:${address.port}`;
    const mockTask = await createTask(baseUrl, {
      query: "35岁裸辞之后还能去哪儿",
      count: 3,
      dataMode: "mock"
    });
    assertNonEmptyString(mockTask.taskId, "mock taskId");
    assertEqual(mockTask.status, "queued", "mock initial status");

    const mockPartial = await waitForTask(baseUrl, mockTask.taskId, (data) =>
      data.hasPartialResult === true || ["partial_ready", "succeeded", "degraded"].includes(String(data.status))
    );
    assertEqual(mockPartial.hasPartialResult, true, "mock partial flag");

    const view = await requestJson(`${baseUrl}/api/agent/tasks/${mockTask.taskId}/view`);
    assertSuccess(view, "mock view");
    assertEqual(view.body.data.result.dataMode, "mock", "mock view dataMode");
    assertNonEmptyArray(view.body.data.result.paths, "mock view paths");
    assertNonEmptyArray(view.body.data.result.people, "mock view people");

    const mockFinal = await waitForTask(baseUrl, mockTask.taskId, (data) =>
      ["succeeded", "degraded", "failed"].includes(String(data.status))
    );
    if (!["succeeded", "degraded"].includes(String(mockFinal.status))) {
      throw new Error(`mock final status: expected succeeded or degraded, got ${String(mockFinal.status)}`);
    }
    assertStage(mockFinal, "intent_expand", ["succeeded"]);
    assertStage(mockFinal, "partial_compose", ["succeeded"]);
    const mockEvidenceStage = assertStage(mockFinal, "evidence_extract", ["succeeded", "degraded", "timed_out"]);
    const mockSummaryStage = assertStage(mockFinal, "experience_summary", ["succeeded", "degraded", "timed_out"]);

    const result = await requestJson(`${baseUrl}/api/agent/tasks/${mockTask.taskId}/result`);
    assertSuccess(result, "mock result");
    assertEqual(result.body.data.result.dataMode, "mock", "mock final dataMode");
    assertEvidenceResult(result.body.data.result, mockEvidenceStage.status, "mock final evidence");
    assertExperienceSummaryResult(result.body.data.result, mockSummaryStage.status, "mock final experience summary");
    if (mockEvidenceStage.status !== "succeeded") {
      assertEqual(mockFinal.degraded, true, "mock degraded flag");
      assertIncludes(mockFinal.failedStages, "evidence_extract", "mock failedStages");
    }
    if (mockSummaryStage.status !== "succeeded") {
      assertEqual(mockFinal.degraded, true, "mock summary degraded flag");
      assertIncludes(mockFinal.failedStages, "experience_summary", "mock summary failedStages");
    }
    const unsupportedRetry = await retryStage(baseUrl, mockTask.taskId, "intent_expand");
    assertEqual(unsupportedRetry.status, 400, "unsupported retry status");
    assertEqual(
      unsupportedRetry.body.error.code,
      "STAGE_RETRY_NOT_SUPPORTED",
      "unsupported retry code"
    );

    const realTask = await createTask(baseUrl, {
      query: dataMode === "real" ? "真实模式失败时不能静默返回 mock" : "不工作了能去哪儿",
      count: 3,
      dataMode
    });
    const realFinal = await waitForTask(baseUrl, realTask.taskId, (data) =>
      ["succeeded", "degraded", "failed"].includes(String(data.status))
    );
    const realView = await requestJson(`${baseUrl}/api/agent/tasks/${realTask.taskId}/view`);

    if (realView.status === 200) {
      assertSuccess(realView, "real view");
      assertNotIncludes(JSON.stringify(realView.body), '"dataMode":"mock"', "real view no mock mode");
    }

    await assertInMemoryStoreCanCreateTask(repoRoot);
    await assertSqliteTaskPersistenceAcrossRestart(repoRoot);

    console.log("PASS agent task smoke");
    console.log(
      `mockTask=${mockTask.taskId} mockStatus=${mockFinal.status} realTask=${realTask.taskId} realStatus=${realFinal.status} realDegraded=${Boolean(realFinal.degraded)}`
    );
  } finally {
    await closeServer(server);
  }
}

function resolveSmokeDataMode() {
  const requested = String(process.env.DATA_MODE || process.env.AGENT_SMOKE_DATA_MODE || "")
    .trim()
    .toLowerCase();
  if (["replay", "cache_first", "real"].includes(requested)) {
    return requested;
  }

  return isTruthy(process.env.ALLOW_REAL_ZH_API) ? "real" : "replay";
}

function printZhihuRiskNotice(dataMode, queryCount) {
  const allowReal = dataMode === "real" || isTruthy(process.env.ALLOW_REAL_ZH_API);
  if (!allowReal) {
    console.log(
      `Zhihu API guard: dataMode=${dataMode}; agent smoke should consume 0 real Zhihu API calls.`
    );
    return;
  }

  console.warn("WARNING: real Zhihu API agent smoke is enabled.");
  console.warn(
    `Estimated upper bound: ${queryCount} agent queries * up to 7 search rounds = ${queryCount * 7} real search attempts before fixture/cache hits.`
  );
  console.warn(
    `Budget: ZH_API_DAILY_DEV_BUDGET=${process.env.ZH_API_DAILY_DEV_BUDGET || "50"}; repeated normalized queries should hit local fixtures.`
  );
}

function isTruthy(value) {
  return ["1", "true", "yes", "on"].includes(String(value || "").trim().toLowerCase());
}

async function assertInMemoryStoreCanCreateTask(repoRoot) {
  const taskStoreModule = await import(
    pathToFileURL(join(repoRoot, "backend", "dist", "agent", "taskStore.js")).href
  );
  const store = new taskStoreModule.InMemoryAgentTaskStore();
  const snapshot = store.createTask({
    query: "内存模式仍可创建任务",
    count: 1,
    dataMode: "mock",
    requestedDataMode: "mock",
    metadata: {
      smoke: true
    }
  });

  assertNonEmptyString(snapshot.task.taskId, "memory taskId");
  assertEqual(snapshot.task.status, "queued", "memory task status");
  assertNonEmptyArray(snapshot.stages, "memory task stages");
}

async function assertSqliteTaskPersistenceAcrossRestart(repoRoot) {
  const serverPath = join(repoRoot, "backend", "dist", "server.js");
  const tempDir = mkdtempSync(join(tmpdir(), "agent-task-sqlite-smoke-"));
  const dbPath = join(tempDir, "agent-tasks.sqlite");
  const port = await findFreePort();
  let server = null;

  try {
    server = startBackendServer(serverPath, {
      BACKEND_PORT: String(port),
      AGENT_TASK_STORE: "sqlite",
      AGENT_TASK_DB_PATH: dbPath,
      DATA_MODE: "mock",
      LLM_ENABLED: "false"
    });
    await waitForBackend(`http://127.0.0.1:${port}`);

    const baseUrl = `http://127.0.0.1:${port}`;
    const created = await createTask(baseUrl, {
      query: "SQLite 重启恢复验证",
      count: 3,
      dataMode: "mock"
    });
    const final = await waitForTask(baseUrl, created.taskId, (data) =>
      ["succeeded", "degraded", "failed"].includes(String(data.status))
    );
    assertEqual(final.hasPartialResult, true, "sqlite before restart has partial result");
    assertEqual(final.hasFinalResult, true, "sqlite before restart has final result");
    const sqliteEvidenceStage = assertStage(final, "evidence_extract", ["degraded", "timed_out"]);
    const sqliteSummaryStage = assertStage(final, "experience_summary", ["degraded", "timed_out"]);
    assertEqual(final.degraded, true, "sqlite before restart degraded flag");
    assertIncludes(final.failedStages, "evidence_extract", "sqlite before restart failedStages");
    assertIncludes(final.failedStages, "experience_summary", "sqlite before restart summary failedStages");

    await stopBackendServer(server);
    server = null;

    server = startBackendServer(serverPath, {
      BACKEND_PORT: String(port),
      AGENT_TASK_STORE: "sqlite",
      AGENT_TASK_DB_PATH: dbPath,
      DATA_MODE: "mock",
      LLM_ENABLED: "false"
    });
    await waitForBackend(baseUrl);

    const restoredStatus = await requestJson(`${baseUrl}/api/agent/tasks/${created.taskId}`);
    assertSuccess(restoredStatus, "sqlite restored status");
    assertEqual(restoredStatus.body.data.taskId, created.taskId, "sqlite restored taskId");
    assertEqual(restoredStatus.body.data.hasPartialResult, true, "sqlite restored partial flag");
    assertEqual(restoredStatus.body.data.hasFinalResult, true, "sqlite restored final flag");
    const restoredEvidenceStage = assertStage(restoredStatus.body.data, "evidence_extract", ["degraded", "timed_out"]);
    const restoredSummaryStage = assertStage(restoredStatus.body.data, "experience_summary", ["degraded", "timed_out"]);
    assertEqual(restoredEvidenceStage.status, sqliteEvidenceStage.status, "sqlite restored evidence stage status");
    assertEqual(restoredSummaryStage.status, sqliteSummaryStage.status, "sqlite restored summary stage status");

    const restoredView = await requestJson(`${baseUrl}/api/agent/tasks/${created.taskId}/view`);
    assertSuccess(restoredView, "sqlite restored view");
    assertNonEmptyArray(restoredView.body.data.result.paths, "sqlite restored view paths");

    const restoredResult = await requestJson(`${baseUrl}/api/agent/tasks/${created.taskId}/result`);
    assertSuccess(restoredResult, "sqlite restored result");
    assertEqual(restoredResult.body.data.result.dataMode, "mock", "sqlite restored final dataMode");
    assertEvidenceResult(
      restoredResult.body.data.result,
      restoredEvidenceStage.status,
      "sqlite restored evidence"
    );
    assertExperienceSummaryResult(
      restoredResult.body.data.result,
      restoredSummaryStage.status,
      "sqlite restored experience summary"
    );

    const retryStarted = await retryStage(baseUrl, created.taskId, "evidence_extract");
    assertSuccess(retryStarted, "sqlite evidence retry start");
    const retryStartedStage = assertStage(retryStarted.body.data, "evidence_extract", ["running"]);
    assertEqual(
      retryStartedStage.attempt,
      restoredEvidenceStage.attempt + 1,
      "sqlite retry attempt increments on start"
    );
    assertEqual(retryStarted.body.data.hasPartialResult, true, "sqlite retry keeps partial flag");

    const retryFinal = await waitForTask(baseUrl, created.taskId, (data) =>
      ["succeeded", "degraded", "failed"].includes(String(data.status))
    );
    const retryEvidenceStage = assertStage(retryFinal, "evidence_extract", ["degraded", "timed_out"]);
    const retrySummaryStage = assertStage(retryFinal, "experience_summary", ["degraded", "timed_out"]);
    if (Number(retryEvidenceStage.attempt) < Number(restoredEvidenceStage.attempt) + 1) {
      throw new Error(
        `sqlite retry final attempt expected >= ${Number(restoredEvidenceStage.attempt) + 1}, got ${String(retryEvidenceStage.attempt)}`
      );
    }
    assertEqual(retryFinal.hasPartialResult, true, "sqlite retry final keeps partial result");
    assertEqual(retryFinal.hasFinalResult, true, "sqlite retry final keeps final result");
    assertIncludes(retryFinal.failedStages, "evidence_extract", "sqlite retry final failedStages");
    assertIncludes(retryFinal.failedStages, "experience_summary", "sqlite retry final summary failedStages");

    const retryResult = await requestJson(`${baseUrl}/api/agent/tasks/${created.taskId}/result`);
    assertSuccess(retryResult, "sqlite retry result");
    assertEvidenceResult(
      retryResult.body.data.result,
      retryEvidenceStage.status,
      "sqlite retry evidence"
    );
    assertExperienceSummaryResult(
      retryResult.body.data.result,
      retrySummaryStage.status,
      "sqlite retry experience summary"
    );

    await stopBackendServer(server);
    server = null;

    server = startBackendServer(serverPath, {
      BACKEND_PORT: String(port),
      AGENT_TASK_STORE: "sqlite",
      AGENT_TASK_DB_PATH: dbPath,
      DATA_MODE: "mock",
      LLM_ENABLED: "false"
    });
    await waitForBackend(baseUrl);

    const retryRestoredStatus = await requestJson(`${baseUrl}/api/agent/tasks/${created.taskId}`);
    assertSuccess(retryRestoredStatus, "sqlite retry restored status");
    const retryRestoredStage = assertStage(
      retryRestoredStatus.body.data,
      "evidence_extract",
      ["degraded", "timed_out"]
    );
    const retryRestoredSummaryStage = assertStage(
      retryRestoredStatus.body.data,
      "experience_summary",
      ["degraded", "timed_out"]
    );
    assertEqual(
      retryRestoredStage.attempt,
      retryEvidenceStage.attempt,
      "sqlite retry restored attempt"
    );
    assertEqual(
      retryRestoredSummaryStage.status,
      retrySummaryStage.status,
      "sqlite retry restored summary status"
    );
  } finally {
    if (server) {
      await stopBackendServer(server);
    }
    rmSync(tempDir, { recursive: true, force: true });
  }
}

async function createTask(baseUrl, body) {
  const response = await requestJson(`${baseUrl}/api/agent/tasks`, {
    method: "POST",
    body
  });
  assertSuccess(response, "create task");
  return readRecord(response.body.data, "create task data");
}

async function retryStage(baseUrl, taskId, stageName) {
  return await requestJson(
    `${baseUrl}/api/agent/tasks/${taskId}/stages/${stageName}/retry`,
    {
      method: "POST"
    }
  );
}

async function waitForTask(baseUrl, taskId, predicate) {
  let latest = null;
  const timeoutMs = Number.parseInt(process.env.AGENT_SMOKE_WAIT_TIMEOUT_MS || "90000", 10);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await sleep(250);
    const response = await requestJson(`${baseUrl}/api/agent/tasks/${taskId}`);
    assertSuccess(response, "task status");
    latest = readRecord(response.body.data, "task status data");
    if (predicate(latest)) {
      return latest;
    }
  }

  throw new Error(`Timed out waiting for task ${taskId}; latest=${JSON.stringify(latest)}`);
}

async function requestJson(url, options = {}) {
  const response = await fetch(url, {
    method: options.method || "GET",
    headers: {
      "Content-Type": "application/json"
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body)
  });
  const text = await response.text();
  return {
    status: response.status,
    body: text ? JSON.parse(text) : null
  };
}

async function findFreePort() {
  const { createServer } = await import("node:net");
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  await closeServer(server);
  if (!address || typeof address === "string") {
    throw new Error("Could not allocate a free TCP port for sqlite restart smoke.");
  }
  return address.port;
}

function startBackendServer(serverPath, env) {
  const child = spawn(process.execPath, [serverPath], {
    env: {
      ...process.env,
      ...env
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.output = "";
  child.stdout.on("data", (chunk) => {
    child.output += chunk;
  });
  child.stderr.on("data", (chunk) => {
    child.output += chunk;
  });
  return child;
}

async function waitForBackend(baseUrl) {
  let lastError = "";
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const response = await fetch(`${baseUrl}/health`);
      if (response.ok) {
        return;
      }
      lastError = `HTTP ${response.status}`;
    } catch (error) {
      lastError = String(error?.message || error);
    }
    await sleep(50);
  }

  throw new Error(`Timed out waiting for backend ${baseUrl}; lastError=${lastError}`);
}

async function stopBackendServer(child) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }

  child.kill("SIGTERM");
  const timeout = setTimeout(() => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
    }
  }, 3000);
  try {
    await once(child, "exit");
  } finally {
    clearTimeout(timeout);
  }
}

function assertSuccess(response, label) {
  if (response.status < 200 || response.status >= 300 || response.body?.success !== true) {
    throw new Error(`${label}: expected success response, got ${response.status} ${JSON.stringify(response.body)}`);
  }
}

function assertStage(taskData, stageName, allowedStatuses) {
  const stages = assertNonEmptyArray(taskData.stages, `${stageName} stages`);
  const stage = stages.find((item) => isRecord(item) && item.name === stageName);
  if (!stage) {
    throw new Error(`Missing stage ${stageName}`);
  }

  if (!allowedStatuses.includes(String(stage.status))) {
    throw new Error(`Stage ${stageName} expected ${allowedStatuses.join(" or ")}, got ${String(stage.status)}`);
  }

  return stage;
}

function assertEvidenceResult(result, stageStatus, label) {
  const record = readRecord(result, `${label} result`);
  const meta = readRecord(record.meta, `${label} meta`);
  const evidenceExtract = readRecord(meta.evidenceExtract, `${label} meta.evidenceExtract`);
  assertEqual(evidenceExtract.status, stageStatus, `${label} evidence status`);
  assertNonEmptyArray(meta.evidenceSamples, `${label} evidence samples`);

  if (stageStatus === "succeeded") {
    assertEqual(evidenceExtract.llmExtracted, true, `${label} llmExtracted`);
  } else {
    assertIncludes(meta.fallbackStages, "evidence_extract", `${label} fallbackStages`);
  }
}

function assertExperienceSummaryResult(result, stageStatus, label) {
  const record = readRecord(result, `${label} result`);
  const meta = readRecord(record.meta, `${label} meta`);
  const experienceSummary = readRecord(meta.experienceSummary, `${label} meta.experienceSummary`);
  assertEqual(experienceSummary.status, stageStatus, `${label} summary status`);

  if (stageStatus === "succeeded") {
    assertEqual(experienceSummary.llmGenerated, true, `${label} llmGenerated`);
    const people = assertNonEmptyArray(record.people, `${label} people`);
    const hasSummary = people.some((person) =>
      isRecord(person) &&
      typeof person.experienceSummary === "string" &&
      person.experienceSummary.trim().length > 0
    );
    if (!hasSummary) {
      throw new Error(`${label}: expected at least one people[].experienceSummary`);
    }
  } else {
    assertIncludes(meta.fallbackStages, "experience_summary", `${label} fallbackStages`);
    const people = assertNonEmptyArray(record.people, `${label} people fallback`);
    assertNonEmptyArray(people[0]?.articles, `${label} fallback people articles`);
  }
}

function readRecord(value, label) {
  if (!isRecord(value)) {
    throw new Error(`${label}: expected object`);
  }

  return value;
}

function assertNonEmptyArray(value, label) {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`${label}: expected non-empty array`);
  }

  return value;
}

function assertNonEmptyString(value, label) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${label}: expected non-empty string`);
  }
}

function assertEqual(actual, expected, label) {
  if (actual !== expected) {
    throw new Error(`${label}: expected ${String(expected)}, got ${String(actual)}`);
  }
}

function assertIncludes(value, expected, label) {
  if (!Array.isArray(value) || !value.includes(expected)) {
    throw new Error(`${label}: expected array to include ${expected}, got ${JSON.stringify(value)}`);
  }
}

function assertNotIncludes(value, expected, label) {
  if (String(value).includes(expected)) {
    throw new Error(`${label}: expected value not to include ${expected}`);
  }
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function sleep(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function closeServer(server) {
  await new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }

      resolve();
    });
  });
}
