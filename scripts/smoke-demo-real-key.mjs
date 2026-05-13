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
const CAREER_TRANSITION_QUERY = decodeURIComponent(
  "%33%35%E5%B2%81%E8%BD%AC%E8%A1%8C%E8%BF%98%E6%9D%A5%E5%BE%97%E5%8F%8A%E5%90%97"
);
const DEFAULT_CHAT_MESSAGE = decodeURIComponent(
  "%E8%BF%99%E6%AE%B5%E5%85%AC%E5%BC%80%E5%86%85%E5%AE%B9%E9%87%8C%EF%BC%8C%E7%AC%AC%E4%B8%80%E6%AD%A5%E5%BA%94%E8%AF%A5%E6%83%B3%E6%B8%85%E6%A5%9A%E4%BB%80%E4%B9%88%EF%BC%9F"
);
const REQUIRED_DEMO_STAGES = [
  "intent_expand",
  "evidence_extract",
  "demo_response_compose",
  "experience_summary",
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
    const secondQuery = readEnv("DEMO_SMOKE_QUERY_B", CAREER_TRANSITION_QUERY);
    const cachedQuery = readEnv("DEMO_SMOKE_QUERY", DEFAULT_QUERY);
    const chatMessage = readEnv("DEMO_SMOKE_CHAT_MESSAGE", DEFAULT_CHAT_MESSAGE);
    const count = parsePositiveInt(process.env.DEMO_SMOKE_COUNT, 3);

    const firstRun = await runDemoSearch(baseUrl, firstQuery, count, "first query");
    const secondRun = await runDemoSearch(baseUrl, secondQuery, count, "second query");
    const cacheWarmRun = await runDemoSearch(baseUrl, cachedQuery, count, "cache warm query");
    const cacheHitRun = await runDemoSearch(baseUrl, cachedQuery, count, "cache hit query");

    assertEqual(
      readRecord(cacheHitRun.data.debug, "cache hit data.debug").cacheHit,
      true,
      "cache hit data.debug.cacheHit"
    );

    const demoData = cacheWarmRun.data;
    const personas = assertNonEmptyArray(demoData.personas, "data.personas");
    printDemoRunDetails(firstRun);
    printDemoRunDetails(secondRun);
    printDemoRunDetails(cacheWarmRun);
    printDemoRunDetails(cacheHitRun);

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
  assertExperiencePathTitles(data.paths, `${label} data.paths`);
  assertCandidateQuality(debug, `${label} data.debug.candidateQuality`);
  assertExperienceSummaries(data.people, `${label} data.people`);

  return {
    label,
    query,
    durationMs,
    data
  };
}

function assertExperiencePathTitles(paths, label) {
  const pathItems = assertNonEmptyArray(paths, label);
  const titles = pathItems.map((item) => readString(readRecord(item, label).title, `${label}.title`));
  const adviceFragments = [
    "比较工作机会",
    "确认目标岗位",
    "先试一个可逆周期",
    "先确定停靠",
    "把现金流和保障算清楚",
    "小步试错控制"
  ];

  for (const title of titles) {
    if (!title.includes("有人")) {
      throw new Error(`${label} title expected experience-sample wording with 有人; got ${title}.`);
    }

    for (const fragment of adviceFragments) {
      if (title.includes(fragment)) {
        throw new Error(`${label} title should not be advice-style; got ${title}.`);
      }
    }
  }
}

function assertCandidateQuality(debug, label) {
  const candidates = assertNonEmptyArray(debug.candidateQuality, label);
  const used = candidates.filter((candidate) => isRecord(candidate) && candidate.usedAsEvidence === true);
  if (used.length === 0) {
    throw new Error(`${label} expected at least one candidate usedAsEvidence=true.`);
  }

  for (const candidate of candidates) {
    const item = readRecord(candidate, label);
    for (const key of ["relevanceScore", "qualityScore", "experienceSignalScore", "contentLength"]) {
      if (!Number.isFinite(item[key])) {
        throw new Error(`${label}.${key} expected a finite number.`);
      }
    }
    assertNonEmptyString(item.filterReason, `${label}.filterReason`);

    if (item.contentLength < 30 && item.usedAsEvidence === true) {
      throw new Error(`${label} short candidate became core evidence: ${item.title || item.candidateId}.`);
    }
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

function printDemoRunDetails(run) {
  printDemoPaths(run);
  printExperienceSummaries(run);
  printCandidateQuality(run);
  printDemoTiming(run);
}

function assertExperienceSummaries(people, label) {
  const items = assertNonEmptyArray(people, label);
  let readyCount = 0;

  items.slice(0, 3).forEach((person, index) => {
    const item = readRecord(person, `${label}[${index}]`);
    const source = readString(item.experienceSummarySource, `${label}[${index}].experienceSummarySource`);
    const status = readString(item.experienceSummaryStatus, `${label}[${index}].experienceSummaryStatus`);

    if (!["llm", "fallback", "none"].includes(source)) {
      throw new Error(`${label}[${index}].experienceSummarySource invalid: ${source}.`);
    }

    if (!["ready", "pending", "failed"].includes(status)) {
      throw new Error(`${label}[${index}].experienceSummaryStatus invalid: ${status}.`);
    }

    if (status === "ready") {
      readyCount += 1;
      assertEqual(source, "llm", `${label}[${index}].experienceSummarySource when ready`);
      assertNonEmptyString(item.experienceSummary, `${label}[${index}].experienceSummary`);
      assertExperienceSummaryText(item.experienceSummary, `${label}[${index}].experienceSummary`);
      if (!Number.isFinite(item.experienceSummaryConfidence)) {
        throw new Error(`${label}[${index}].experienceSummaryConfidence expected number when ready.`);
      }
    } else if (item.experienceSummary !== null) {
      throw new Error(`${label}[${index}].experienceSummary must be null when status=${status}.`);
    }
  });

  if (readyCount === 0) {
    throw new Error(`${label} expected at least one ready LLM experienceSummary.`);
  }
}

function assertExperienceSummaryText(value, label) {
  const adviceFragments = ["你应该", "建议先", "建议你", "可以考虑", "你可以", "应该先", "最好先"];
  const experienceMarkers = ["这个样本", "这段经历", "作者", "TA", "ta"];

  if (!experienceMarkers.some((marker) => value.includes(marker))) {
    throw new Error(`${label} should read like an experience summary; got ${value}.`);
  }

  for (const fragment of adviceFragments) {
    if (value.includes(fragment)) {
      throw new Error(`${label} should not be advice-style; got ${value}.`);
    }
  }
}

function printDemoPaths(run) {
  const debug = readRecord(run.data.debug, `${run.label} debug`);
  const paths = assertNonEmptyArray(run.data.paths, `${run.label} data.paths`);
  console.log(`paths ${run.label} query="${run.query}" pathSource=${debug.pathSource || ""}`);

  paths.forEach((path, index) => {
    const item = readRecord(path, `${run.label} data.paths[${index}]`);
    const title = readString(item.title, `${run.label} data.paths[${index}].title`);
    const summary = typeof item.summary === "string" ? item.summary : "";
    const source = formatPathSource(item, debug);

    console.log(`  path[${index + 1}] title=${title}`);
    console.log(`    summary=${summary}`);
    console.log(`    source=${source}`);
  });
}

function printExperienceSummaries(run) {
  const people = assertNonEmptyArray(run.data.people, `${run.label} data.people`);
  console.log(`experienceSummary ${run.label} query="${run.query}"`);

  people.slice(0, 3).forEach((person, index) => {
    const item = readRecord(person, `${run.label} data.people[${index}]`);
    console.log(
      `  person[${index + 1}] status=${item.experienceSummaryStatus || ""} source=${item.experienceSummarySource || ""} confidence=${formatNumber(item.experienceSummaryConfidence)}`
    );
    console.log(`    summary=${item.experienceSummary || ""}`);
  });
}

function printCandidateQuality(run) {
  const debug = readRecord(run.data.debug, `${run.label} debug`);
  const candidates = assertNonEmptyArray(
    debug.candidateQuality,
    `${run.label} data.debug.candidateQuality`
  );
  const preview = selectCandidateQualityPreview(candidates);
  console.log(
    `candidateQuality ${run.label} query="${run.query}" shown=${preview.length}/${candidates.length}`
  );

  preview.forEach((candidate, index) => {
    const item = readRecord(candidate, `${run.label} data.debug.candidateQuality[${index}]`);
    const label = readCandidateLabel(item);

    console.log(
      `  candidate[${index + 1}] ${label} contentLength=${formatNumber(item.contentLength)} relevanceScore=${formatNumber(item.relevanceScore)} qualityScore=${formatNumber(item.qualityScore)} experienceSignalScore=${formatNumber(item.experienceSignalScore)} usedAsEvidence=${item.usedAsEvidence === true}`
    );
    console.log(`    filterReason=${String(item.filterReason || "")}`);
  });
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

function selectCandidateQualityPreview(candidates) {
  const records = candidates.filter(isRecord);
  const used = records.filter((candidate) => candidate.usedAsEvidence === true);
  const downranked = records.filter((candidate) => candidate.usedAsEvidence !== true);
  const preview = [...used.slice(0, 2), ...downranked.slice(0, 1)];

  if (preview.length >= 2 || records.length <= preview.length) {
    return preview.slice(0, 3);
  }

  return [...preview, ...records.filter((candidate) => !preview.includes(candidate))].slice(0, 3);
}

function formatPathSource(path, debug) {
  const directSource =
    typeof path.source === "string"
      ? path.source
      : typeof path.pathSource === "string"
        ? path.pathSource
        : "";
  const sourceRefs = Array.isArray(path.sourceRefs) ? path.sourceRefs.filter(Boolean).join(",") : "";

  return [
    directSource,
    debug.pathSource ? `pathSource=${debug.pathSource}` : "",
    sourceRefs ? `sourceRefs=${sourceRefs}` : ""
  ]
    .filter(Boolean)
    .join(" ");
}

function readCandidateLabel(candidate) {
  const title = typeof candidate.title === "string" ? candidate.title.trim() : "";
  const candidateId = typeof candidate.candidateId === "string" ? candidate.candidateId.trim() : "";
  return title ? `title=${title}` : `candidateId=${candidateId || "unknown"}`;
}

function formatNumber(value) {
  return Number.isFinite(value) ? String(value) : "n/a";
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
