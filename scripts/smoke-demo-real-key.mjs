#!/usr/bin/env node
import { once } from "node:events";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const DEFAULT_QUERY = decodeURIComponent(
  "%E4%B8%8D%E5%B7%A5%E4%BD%9C%E4%BA%86%E8%83%BD%E5%8E%BB%E5%93%AA%E5%84%BF"
);
const DEFAULT_CHAT_MESSAGE = decodeURIComponent(
  "%E8%BF%99%E6%AE%B5%E5%85%AC%E5%BC%80%E5%86%85%E5%AE%B9%E9%87%8C%EF%BC%8C%E7%AC%AC%E4%B8%80%E6%AD%A5%E5%BA%94%E8%AF%A5%E6%83%B3%E6%B8%85%E6%A5%9A%E4%BB%80%E4%B9%88%EF%BC%9F"
);
const REQUIRED_DEEPSEEK_STAGES = [
  "intent_expand",
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
    const query = readEnv("DEMO_SMOKE_QUERY", DEFAULT_QUERY);
    const chatMessage = readEnv("DEMO_SMOKE_CHAT_MESSAGE", DEFAULT_CHAT_MESSAGE);
    const count = parsePositiveInt(process.env.DEMO_SMOKE_COUNT, 3);

    const demoSearch = await requestJson(`${baseUrl}/api/demo/search`, {
      method: "POST",
      body: {
        query,
        count,
        dataMode: "real"
      }
    });

    assertSuccess(demoSearch, "POST /api/demo/search");
    const demoData = readRecord(demoSearch.body.data, "demo search data");
    assertNonEmptyArray(demoData.paths, "data.paths");
    assertNonEmptyArray(demoData.people, "data.people");
    const personas = assertNonEmptyArray(demoData.personas, "data.personas");
    const debug = readRecord(demoData.debug, "data.debug");
    assertEqual(debug.llmUsed, true, "data.debug.llmUsed");

    const stageResults = assertNonEmptyArray(
      debug.llmStageResults,
      "data.debug.llmStageResults"
    );
    for (const stage of REQUIRED_DEEPSEEK_STAGES) {
      assertStageSucceeded(stageResults, stage);
    }

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
    assertEqual(chatDebug.chatMode, "mock_fallback", "data.debug.chatMode");

    const evidenceStage = findStage(stageResults, "evidence_extract");
    const evidenceStatus = evidenceStage
      ? `evidence_extract attempted=${evidenceStage.attempted} succeeded=${evidenceStage.succeeded}`
      : "evidence_extract not reported";

    console.log("PASS demo real-key smoke");
    console.log(`demo counts paths=${demoData.paths.length} people=${demoData.people.length} personas=${personas.length}`);
    console.log(
      `deepseek stages ${REQUIRED_DEEPSEEK_STAGES.map((stage) => `${stage}=1`).join(" ")}`
    );
    console.log(`${evidenceStatus}; persona_chat=mock_fallback`);
  } finally {
    await closeServer(server);
  }
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

function assertStageSucceeded(stageResults, stage) {
  const result = findStage(stageResults, stage);
  if (!result) {
    throw new Error(`data.debug.llmStageResults missing ${stage}.`);
  }

  assertEqual(result.succeeded, 1, `data.debug.llmStageResults.${stage}.succeeded`);
}

function findStage(stageResults, stage) {
  return stageResults.find((item) => isRecord(item) && item.stage === stage);
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
