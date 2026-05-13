#!/usr/bin/env node
import { once } from "node:events";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const DEFAULT_QUERY = decodeURIComponent(
  "%E4%B8%8D%E5%B7%A5%E4%BD%9C%E4%BA%86%E8%83%BD%E5%8E%BB%E5%93%AA%E5%84%BF"
);
const RELATIONSHIP_QUERY = decodeURIComponent(
  "%E4%B8%BA%E4%BA%86%E5%B7%A5%E4%BD%9C%EF%BC%8C%E5%BC%82%E5%9C%B0%E6%81%8B%E5%80%BC%E5%BE%97%E5%90%97"
);
const DEFAULT_CHAT_MESSAGE = decodeURIComponent(
  "%E8%BF%99%E6%AE%B5%E5%85%AC%E5%BC%80%E5%86%85%E5%AE%B9%E9%87%8C%EF%BC%8C%E7%AC%AC%E4%B8%80%E6%AD%A5%E5%BA%94%E8%AF%A5%E6%83%B3%E6%B8%85%E6%A5%9A%E4%BB%80%E4%B9%88%EF%BC%9F"
);
const REQUIRED_DEMO_STAGES = [
  "intent_expand",
  "evidence_extract",
  "demo_response_compose",
  "grounding_guard"
];

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
    const firstQuery = readEnv("DEMO_SMOKE_QUERY_A", RELATIONSHIP_QUERY);
    const cachedQuery = readEnv("DEMO_SMOKE_QUERY", DEFAULT_QUERY);
    const chatMessage = readEnv("DEMO_SMOKE_CHAT_MESSAGE", DEFAULT_CHAT_MESSAGE);
    const count = parsePositiveInt(process.env.DEMO_SMOKE_COUNT, 3);

    const firstRun = await runDemoSearch(baseUrl, firstQuery, count, "first query");
    const cacheWarmRun = await runDemoSearch(baseUrl, cachedQuery, count, "cache warm query");
    const cacheHitRun = await runDemoSearch(baseUrl, cachedQuery, count, "cache hit query");

    assertEqual(
      readRecord(cacheHitRun.data.debug, "cache hit data.debug").cacheHit,
      true,
      "cache hit data.debug.cacheHit"
    );

    const demoData = cacheWarmRun.data;
    const personas = assertNonEmptyArray(demoData.personas, "data.personas");
    printDemoTiming(firstRun);
    printDemoTiming(cacheWarmRun);
    printDemoTiming(cacheHitRun);

    const firstPersona = readRecord(personas[0], "data.personas[0]");
    const personaId = readString(firstPersona.id, "data.personas[0].id");
    const queryId = readString(demoData.queryId, "data.queryId");

    const personaChat = await requestJson(`${baseUrl}/api/personas/chat`, {
      method: "POST",
      body: {
        personaId,
        queryId,
        message: chatMessage
      }
    });

    assertSuccess(personaChat, "POST /api/personas/chat");
    const chatData = readRecord(personaChat.body.data, "persona chat data");
    assertNonEmptyString(chatData.reply, "data.reply");
    assertNonEmptyArray(chatData.sourceRefs, "data.sourceRefs");
    assertNonEmptyArray(chatData.suggestedQuestions, "data.suggestedQuestions");
    assertNonEmptyString(chatData.boundaryNotice, "data.boundaryNotice");

    const chatDebug = readRecord(chatData.debug, "data.debug");
    assertEqual(chatDebug.chatMode, "real_llm_chat", "data.debug.chatMode");

    console.log("PASS demo real-key smoke");
    console.log(`demo counts paths=${demoData.paths.length} people=${demoData.people.length} personas=${personas.length}`);
    console.log(
      `demo stages ${REQUIRED_DEMO_STAGES.map((stage) => `${stage}=recorded`).join(" ")}`
    );
    console.log(`summary cacheHit=${readRecord(cacheHitRun.data.debug, "cache debug").cacheHit} persona_chat=${chatDebug.chatMode}`);
  } finally {
    await closeServer(server);
  }
}

async function runDemoSearch(baseUrl, query, count, label) {
  const startedAt = Date.now();
  const demoSearch = await requestJson(`${baseUrl}/api/demo/search`, {
    method: "POST",
    body: {
      query,
      count,
      dataMode: "real"
    }
  });
  const durationMs = Date.now() - startedAt;

  assertSuccess(demoSearch, `POST /api/demo/search ${label}`);
  const data = readRecord(demoSearch.body.data, `${label} data`);
  assertNonEmptyArray(data.paths, `${label} data.paths`);
  assertNonEmptyArray(data.people, `${label} data.people`);
  assertNonEmptyArray(data.personas, `${label} data.personas`);
  const debug = readRecord(data.debug, `${label} data.debug`);
  const stageResults = assertNonEmptyArray(
    debug.llmStageResults,
    `${label} data.debug.llmStageResults`
  );
  const timings = assertNonEmptyArray(debug.timings, `${label} data.debug.timings`);

  for (const stage of REQUIRED_DEMO_STAGES) {
    assertStageRecorded(stageResults, stage);
    assertStageTiming(timings, stage);
  }

  return {
    label,
    query,
    durationMs,
    data
  };
}

async function requestJson(url, options) {
  const response = await fetch(url, {
    method: options.method,
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(options.body)
  });
  const text = await response.text();
  let body;

  try {
    body = JSON.parse(text);
  } catch {
    throw new Error(`${options.method} ${new URL(url).pathname} did not return JSON.`);
  }

  return {
    status: response.status,
    body
  };
}

function assertSuccess(response, label) {
  if (response.status !== 200 || response.body?.success !== true) {
    throw new Error(`${label} expected success=true HTTP 200; got ${summarizeResponse(response)}.`);
  }
}

function assertStageRecorded(stageResults, stage) {
  const result = findStage(stageResults, stage);
  if (!result) {
    throw new Error(`data.debug.llmStageResults missing ${stage}.`);
  }

  if (!Number.isFinite(result.attempted) || !Number.isFinite(result.succeeded)) {
    throw new Error(`data.debug.llmStageResults.${stage} missing counters.`);
  }
}

function assertStageAttemptedSucceeded(stageResults, stage) {
  const result = findStage(stageResults, stage);
  if (!result) {
    throw new Error(`data.debug.llmStageResults missing ${stage}.`);
  }

  assertEqual(result.attempted, 1, `data.debug.llmStageResults.${stage}.attempted`);
  assertEqual(result.succeeded, 1, `data.debug.llmStageResults.${stage}.succeeded`);
  return result;
}

function findStage(stageResults, stage) {
  return stageResults.find((item) => isRecord(item) && item.stage === stage);
}

function assertStageTiming(timings, stage) {
  const timing = timings.find((item) => isRecord(item) && item.stageName === stage);
  if (!timing) {
    throw new Error(`data.debug.timings missing ${stage}.`);
  }

  if (!Number.isFinite(timing.durationMs) || timing.durationMs < 0) {
    throw new Error(`data.debug.timings.${stage}.durationMs expected a non-negative number.`);
  }

  if (typeof timing.llmUsed !== "boolean") {
    throw new Error(`data.debug.timings.${stage}.llmUsed expected boolean.`);
  }

  if (typeof timing.fallbackUsed !== "boolean") {
    throw new Error(`data.debug.timings.${stage}.fallbackUsed expected boolean.`);
  }
}

function printDemoTiming(run) {
  const debug = readRecord(run.data.debug, `${run.label} debug`);
  const timings = Array.isArray(debug.timings) ? debug.timings : [];
  console.log(
    `timing ${run.label} query="${run.query}" totalMs=${run.durationMs} metaLatencyMs=${run.data.meta?.latencyMs} cacheHit=${debug.cacheHit === true}`
  );

  for (const timing of timings) {
    if (!isRecord(timing)) {
      continue;
    }

    console.log(
      `  stage=${timing.stageName} durationMs=${timing.durationMs} llmUsed=${timing.llmUsed} fallbackUsed=${timing.fallbackUsed} fallbackReason=${timing.fallbackReason || ""}`
    );
  }
}

function assertEqual(actual, expected, label) {
  if (actual !== expected) {
    throw new Error(`${label} expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}.`);
  }
}

function assertNonEmptyArray(value, label) {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`${label} expected a non-empty array.`);
  }

  return value;
}

function assertNonEmptyString(value, label) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${label} expected a non-empty string.`);
  }
}

function readRecord(value, label) {
  if (!isRecord(value)) {
    throw new Error(`${label} expected an object.`);
  }

  return value;
}

function readString(value, label) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${label} expected a non-empty string.`);
  }

  return value;
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readEnv(name, fallback) {
  const value = process.env[name];
  return value && value.trim() ? value.trim() : fallback;
}

function parsePositiveInt(value, fallback) {
  if (!value) {
    return fallback;
  }

  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function summarizeResponse(response) {
  const error = response.body?.error;
  if (isRecord(error)) {
    const code = typeof error.code === "string" ? error.code : "UNKNOWN_ERROR";
    const message = typeof error.message === "string" ? error.message : "No message";
    return `HTTP ${response.status} ${code}: ${message}`;
  }

  return `HTTP ${response.status}`;
}

async function closeServer(server) {
  if (!server.listening) {
    return;
  }

  await new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}
