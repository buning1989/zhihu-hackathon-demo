#!/usr/bin/env node
import { once } from "node:events";
import { existsSync } from "node:fs";
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

    const mockFinal = await waitForTask(baseUrl, mockTask.taskId, (data) =>
      ["succeeded", "degraded", "failed"].includes(String(data.status))
    );
    assertEqual(mockFinal.status, "succeeded", "mock final status");
    assertStage(mockFinal, "intent_expand", ["succeeded"]);
    assertStage(mockFinal, "partial_compose", ["succeeded"]);
    assertStage(mockFinal, "evidence_extract", ["skipped", "degraded"]);

    const view = await requestJson(`${baseUrl}/api/agent/tasks/${mockTask.taskId}/view`);
    assertSuccess(view, "mock view");
    assertEqual(view.body.data.result.dataMode, "mock", "mock view dataMode");
    assertNonEmptyArray(view.body.data.result.paths, "mock view paths");
    assertNonEmptyArray(view.body.data.result.people, "mock view people");

    const result = await requestJson(`${baseUrl}/api/agent/tasks/${mockTask.taskId}/result`);
    assertSuccess(result, "mock result");
    assertEqual(result.body.data.result.dataMode, "mock", "mock final dataMode");

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

    console.log("PASS agent task smoke");
    console.log(
      `mockTask=${mockTask.taskId} mockStatus=${mockFinal.status} realTask=${realTask.taskId} realStatus=${realFinal.status} realDegraded=${Boolean(realFinal.degraded)}`
    );
  } finally {
    await closeServer(server);
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
  for (let attempt = 0; attempt < 80; attempt += 1) {
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
