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

    const result = await requestJson(`${baseUrl}/api/agent/tasks/${mockTask.taskId}/result`);
    assertSuccess(result, "mock result");
    assertEqual(result.body.data.result.dataMode, "mock", "mock final dataMode");
    assertEvidenceResult(result.body.data.result, mockEvidenceStage.status, "mock final evidence");
    if (mockEvidenceStage.status !== "succeeded") {
      assertEqual(mockFinal.degraded, true, "mock degraded flag");
      assertIncludes(mockFinal.failedStages, "evidence_extract", "mock failedStages");
    }

    const realTask = await createTask(baseUrl, {
      query: "真实模式失败时不能静默返回 mock",
      count: 3,
      dataMode: "real"
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
    assertEqual(final.degraded, true, "sqlite before restart degraded flag");
    assertIncludes(final.failedStages, "evidence_extract", "sqlite before restart failedStages");

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
    assertEqual(restoredEvidenceStage.status, sqliteEvidenceStage.status, "sqlite restored evidence stage status");

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

async function waitForTask(baseUrl, taskId, predicate) {
  let latest = null;
  for (let attempt = 0; attempt < 180; attempt += 1) {
    await sleep(50);
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
