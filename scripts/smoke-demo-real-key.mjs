#!/usr/bin/env node
import { once } from "node:events";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const DEFAULT_QUERY = decodeURIComponent(
  "%E4%B8%BA%E4%BA%86%E5%B7%A5%E4%BD%9C%E8%83%BD%E8%BF%BD%E6%B1%82%E8%87%AA%E5%B7%B1%E6%83%B3%E5%81%9A%E7%9A%84%E4%BA%8B%EF%BC%8C%E9%95%BF%E6%9C%9F%E5%BC%82%E5%9C%B0%E6%81%8B%E7%9C%9F%E7%9A%84%E5%80%BC%E5%BE%97%E5%90%97%EF%BC%9F"
);
const VALIDATION_QUERIES = [
  DEFAULT_QUERY,
  decodeURIComponent("%33%35%E5%B2%81%E8%A3%B8%E8%BE%9E%E6%98%AF%E4%B8%8D%E6%98%AF%E5%AE%8C%E4%BA%86"),
  decodeURIComponent("%E6%88%91%E4%B8%8D%E6%83%B3%E4%B8%8A%E7%8F%AD%E4%BD%86%E4%B9%9F%E4%B8%8D%E7%9F%A5%E9%81%93%E8%83%BD%E5%B9%B2%E5%98%9B"),
  decodeURIComponent("%E7%95%99%E5%9C%A8%E5%8C%97%E4%BA%AC%E8%BF%98%E6%98%AF%E5%9B%9E%E8%80%81%E5%AE%B6"),
  decodeURIComponent("%E4%B8%8D%E6%83%B3%E8%AF%BB%E7%A0%94%E4%BA%86%E6%80%8E%E4%B9%88%E5%8A%9E"),
  decodeURIComponent("%E8%A6%81%E4%B8%8D%E8%A6%81%E5%92%8C%E9%95%BF%E6%9C%9F%E6%B6%88%E8%80%97%E6%88%91%E7%9A%84%E6%9C%8B%E5%8F%8B%E6%96%AD%E8%81%94"),
  decodeURIComponent("%E7%88%B6%E6%AF%8D%E4%B8%8D%E5%90%8C%E6%84%8F%E6%88%91%E7%9A%84%E9%80%89%E6%8B%A9%E6%80%8E%E4%B9%88%E5%8A%9E")
];
const DEFAULT_CHAT_MESSAGES = [
  decodeURIComponent("%E4%BD%A0%E5%BD%93%E6%97%B6%E4%B8%BA%E4%BB%80%E4%B9%88%E8%BF%99%E4%B9%88%E9%80%89%EF%BC%9F"),
  decodeURIComponent("%E4%BD%A0%E5%90%8E%E6%9D%A5%E5%90%8E%E6%82%94%E4%BA%86%E5%90%97%EF%BC%9F"),
  decodeURIComponent("%E8%BF%99%E4%B8%AA%E9%80%89%E6%8B%A9%E6%9C%80%E5%A4%A7%E7%9A%84%E4%BB%A3%E4%BB%B7%E6%98%AF%E4%BB%80%E4%B9%88%EF%BC%9F"),
  decodeURIComponent("%E5%A6%82%E6%9E%9C%E6%88%91%E4%B9%9F%E6%83%B3%E8%BF%99%E4%B9%88%E5%81%9A%EF%BC%8C%E4%BD%A0%E4%BC%9A%E6%8F%90%E9%86%92%E6%88%91%E4%BB%80%E4%B9%88%EF%BC%9F"),
  decodeURIComponent("%E4%BD%A0%E9%82%A3%E6%97%B6%E5%80%99%E6%9C%80%E5%AE%B3%E6%80%95%E7%9A%84%E6%98%AF%E4%BB%80%E4%B9%88%EF%BC%9F")
];
const PERSONA_REPLY_FORBIDDEN_FRAGMENTS = [
  "根据公开资料",
  "公开资料",
  "作为 AI",
  "作为AI",
  "我无法确认",
  "我不能代表作者本人",
  "公开内容没有提到，所以无法回答",
  "公开内容不足以回答这个问题",
  "所以无法回答",
  "无法回答"
];
const REQUIRED_DEMO_STAGES = [
  "intent_expand",
  "candidate_rerank",
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

  const validationQueries = readQueryListEnv("DEMO_SMOKE_QUERIES", VALIDATION_QUERIES);
  const chatMessages = readQueryListEnv("DEMO_SMOKE_CHAT_MESSAGES", DEFAULT_CHAT_MESSAGES);
  const count = parsePositiveInt(process.env.DEMO_SMOKE_COUNT, 3);
  const dataMode = resolveSmokeDataMode();
  process.env.DATA_MODE = process.env.DATA_MODE || dataMode;
  printZhihuRiskNotice(dataMode, validationQueries.length);

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

    const validationRuns = [];
    for (const [index, query] of validationQueries.entries()) {
      validationRuns.push(
        await runDemoSearch(baseUrl, query, count, dataMode, `validation query ${index + 1}`)
      );
    }

    const cacheHitRun = await runDemoSearch(
      baseUrl,
      validationQueries[0],
      count,
      dataMode,
      "cache hit query"
    );

    assertEqual(
      readRecord(cacheHitRun.data.debug, "cache hit data.debug").cacheHit,
      true,
      "cache hit data.debug.cacheHit"
    );

    const demoData = validationRuns[0].data;
    const people = assertNonEmptyArray(demoData.people, "data.people");
    for (const run of validationRuns) {
      printDemoRunDetails(run);
    }
    printDemoRunDetails(cacheHitRun);

    const firstPerson = readRecord(people[0], "data.people[0]");
    const firstPersona = readRecord(firstPerson.aiPersona, "data.people[0].aiPersona");
    const personaId = readString(firstPersona.personaId, "data.people[0].aiPersona.personaId");
    const queryId = readString(demoData.queryId, "data.queryId");

    const chatRuns = [];
    for (const [index, message] of chatMessages.entries()) {
      const personaChat = await requestJson(`${baseUrl}/api/personas/chat`, {
        method: "POST",
        body: {
          personaId,
          queryId,
          message
        }
      });

      assertSuccess(personaChat, `POST /api/personas/chat sample ${index + 1}`);
      const chatData = readRecord(personaChat.body.data, `persona chat data sample ${index + 1}`);
      assertPersonaChatAcceptance(chatData, `persona chat sample ${index + 1}`);

      const chatDebug = readRecord(chatData.debug, `persona chat data sample ${index + 1}.debug`);
      assertEqual(chatDebug.chatMode, "real_llm_chat", `data.debug.chatMode sample ${index + 1}`);
      chatRuns.push({
        message,
        data: chatData,
        debug: chatDebug
      });
    }

    console.log(`PASS demo ${dataMode} LLM/persona smoke`);
    console.log(`demo counts paths=${demoData.paths.length} people=${demoData.people.length} derivedPersonas=${people.length}`);
    console.log(
      `demo stages ${REQUIRED_DEMO_STAGES.map((stage) => `${stage}=recorded`).join(" ")}`
    );
    console.log(`validation queries=${validationRuns.length} cacheQuery="${validationQueries[0]}"`);
    printPersonaChatInspection(chatRuns);
    console.log(`summary cacheHit=${readRecord(cacheHitRun.data.debug, "cache debug").cacheHit} persona_chat_samples=${chatRuns.length}`);
  } finally {
    await closeServer(server);
  }
}

async function runDemoSearch(baseUrl, query, count, dataMode, label) {
  const startedAt = Date.now();
  const demoSearch = await requestJson(`${baseUrl}/api/demo/search`, {
    method: "POST",
    body: {
      query,
      count,
      dataMode
    }
  });
  const durationMs = Date.now() - startedAt;

  assertSuccess(demoSearch, `POST /api/demo/search ${label}`);
  const data = readRecord(demoSearch.body.data, `${label} data`);
  assertNonEmptyArray(data.paths, `${label} data.paths`);
  assertNonEmptyArray(data.people, `${label} data.people`);
  assertDerivedTopLevelFieldsOmitted(data, `${label} data`);
  assertPeoplePersonaEntries(data.people, `${label} data.people`);
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
  assertPathExtractionFields(data.paths, debug, `${label} data.paths`);
  assertSearchPlan(debug, query, `${label} data.debug`);
  assertCandidateQuality(debug, `${label} data.debug.candidateQuality`);
  assertCandidatePipelineDebug(debug, `${label} data.debug`);
  assertExperienceSummaries(data.people, `${label} data.people`);

  return {
    label,
    query,
    durationMs,
    data
  };
}

function resolveSmokeDataMode() {
  const requested = String(process.env.DATA_MODE || process.env.DEMO_SMOKE_DATA_MODE || "")
    .trim()
    .toLowerCase();
  if (["replay", "cache_first", "real"].includes(requested)) {
    return requested;
  }

  return isTruthy(process.env.ALLOW_REAL_ZH_API) ? "real" : "replay";
}

function printZhihuRiskNotice(dataMode, queryCount) {
  const allowReal = dataMode === "real" || isTruthy(process.env.ALLOW_REAL_ZH_API);
  const estimatedSearchRounds = queryCount * 6;
  if (!allowReal) {
    console.log(
      `Zhihu API guard: dataMode=${dataMode}; replay/cache-first smoke should consume 0 real Zhihu API calls.`
    );
    return;
  }

  console.warn("WARNING: real Zhihu API + LLM/persona smoke is enabled.");
  console.warn(
    `Estimated upper bound: ${queryCount} demo queries * 6 search rounds = ${estimatedSearchRounds} real search attempts before fixture/cache hits.`
  );
  console.warn("Real search calls are logged locally; no daily budget cap is enforced.");
}

function isTruthy(value) {
  return ["1", "true", "yes", "on"].includes(String(value || "").trim().toLowerCase());
}

function assertDerivedTopLevelFieldsOmitted(data, label) {
  if ("personas" in data) {
    throw new Error(`${label}.personas should be omitted; derive from people[].aiPersona.`);
  }

  if ("sections" in data) {
    throw new Error(`${label}.sections should be omitted; derive layout on the client.`);
  }
}

function assertPeoplePersonaEntries(people, label) {
  for (const [index, value] of people.entries()) {
    const person = readRecord(value, `${label}[${index}]`);
    const aiPersona = readRecord(person.aiPersona, `${label}[${index}].aiPersona`);
    readString(aiPersona.personaId, `${label}[${index}].aiPersona.personaId`);
  }
}

function assertCandidatePipelineDebug(debug, label) {
  const topicSignals = assertNonEmptyArray(debug.topicSignals, `${label}.topicSignals`);
  if (topicSignals.length < 4) {
    throw new Error(`${label}.topicSignals expected several dynamic signals, got ${topicSignals.length}.`);
  }

  const roughTierDistribution = readRecord(debug.roughTierDistribution, `${label}.roughTierDistribution`);
  for (const key of ["strong", "usable", "backup", "drop"]) {
    if (!Number.isFinite(roughTierDistribution[key])) {
      throw new Error(`${label}.roughTierDistribution.${key} expected number.`);
    }
  }

  for (const key of [
    "rawCandidateCount",
    "dedupedCandidateCount",
    "rerankCandidatesCount",
    "selectedCandidatesCount",
    "droppedCandidatesCount",
    "finalCandidateCount"
  ]) {
    if (!Number.isFinite(debug[key])) {
      throw new Error(`${label}.${key} expected a finite number.`);
    }
  }

  if (debug.rerankCandidatesCount > 20) {
    throw new Error(`${label}.rerankCandidatesCount must be <= 20.`);
  }

  const finalCandidates = assertNonEmptyArray(debug.finalCandidates, `${label}.finalCandidates`);
  for (const candidate of finalCandidates) {
    const item = readRecord(candidate, `${label}.finalCandidates[]`);
    assertNonEmptyString(item.title, `${label}.finalCandidates.title`);
    assertNonEmptyString(item.summaryAngle, `${label}.finalCandidates.summaryAngle`);
    assertNonEmptyString(item.relationToUserIntent, `${label}.finalCandidates.relationToUserIntent`);
    assertNonEmptyString(item.diversityKey, `${label}.finalCandidates.diversityKey`);
    if (item.sourceRefs !== undefined) {
      assertArray(item.sourceRefs, `${label}.finalCandidates.sourceRefs`);
    }
  }
}

function assertExperiencePathTitles(paths, label) {
  const pathItems = assertNonEmptyArray(paths, label);
  if (pathItems.length < 3 || pathItems.length > 5) {
    throw new Error(`${label} expected 3-5 paths, got ${pathItems.length}.`);
  }
  const titles = pathItems.map((item) => readString(readRecord(item, label).title, `${label}.title`));
  const allowedTitles = new Set([
    "辞职后复盘：后悔、回流与再选择",
    "待业中的拉扯：想走出去但没有确定路径",
    "过渡型路径：先解决现金流，再决定下一步",
    "不上班后的真实日常：时间、成本和生活节奏",
    "低成本备选方案：回老家、自由职业、远程/副业",
    "观点型参考：只能作为方向，不当作亲历"
  ]);
  const internalFragments = [
    "roughTier",
    "roughScore",
    "diversityKey",
    "contentRole",
    "keepReason",
    "规则兜底保留",
    "used_as_core_evidence"
  ];

  for (const title of titles) {
    const normalized = title.replace(/（补充视角 \d+）$/, "");
    if (!allowedTitles.has(normalized)) {
      throw new Error(`${label} title expected role-mapped display wording; got ${title}.`);
    }

    for (const fragment of internalFragments) {
      if (title.includes(fragment)) {
        throw new Error(`${label} title leaked internal field ${fragment}; got ${title}.`);
      }
    }
  }
}

function assertPathExtractionFields(paths, debug, label) {
  const pathItems = assertNonEmptyArray(paths, label);
  const summaryPrefixes = new Set();

  pathItems.forEach((path, index) => {
    const item = readRecord(path, `${label}[${index}]`);
    assertNonEmptyString(item.summary, `${label}[${index}].summary`);
    assertNonEmptyString(item.whyRelevant, `${label}[${index}].whyRelevant`);
    assertNonEmptyString(item.tradeoff, `${label}[${index}].tradeoff`);
    assertNonEmptyArray(item.sourceRefs, `${label}[${index}].sourceRefs`);
    assertNonEmptyString(item.diversityKey, `${label}[${index}].diversityKey`);
    for (const field of ["title", "summary", "tradeoff"]) {
      const text = String(item[field] || "");
      for (const fragment of ["roughTier", "roughScore", "diversityKey", "contentRole", "keepReason", "规则兜底保留"]) {
        if (text.includes(fragment)) {
          throw new Error(`${label}[${index}].${field} leaked internal field ${fragment}.`);
        }
      }
    }

    const prefix = String(item.summary).slice(0, 20);
    if (summaryPrefixes.has(prefix)) {
      throw new Error(`${label}[${index}].summary repeats first 20 chars: ${prefix}`);
    }
    summaryPrefixes.add(prefix);
  });

  if (typeof debug.composerFallbackTriggered !== "boolean") {
    throw new Error(`${label} debug.composerFallbackTriggered expected boolean.`);
  }
  if (typeof debug.pathDuplicateFound !== "boolean") {
    throw new Error(`${label} debug.pathDuplicateFound expected boolean.`);
  }
  const diversityCheck = readRecord(debug.pathDiversityCheck, `${label} debug.pathDiversityCheck`);
  if (!Number.isFinite(diversityCheck.rewriteCount) || !Number.isFinite(diversityCheck.mergeCount)) {
    throw new Error(`${label} debug.pathDiversityCheck expected rewriteCount and mergeCount.`);
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
    for (const key of [
      "relevanceScore",
      "qualityScore",
      "experienceSignalScore",
      "contentLength",
      "roughScore",
      "topicHitScore",
      "narrativeScore",
      "specificityScore",
      "basicQualityScore",
      "penaltyScore"
    ]) {
      if (!Number.isFinite(item[key])) {
        throw new Error(`${label}.${key} expected a finite number.`);
      }
    }
    assertNonEmptyString(item.filterReason, `${label}.filterReason`);
    assertNonEmptyString(item.matchedQuery, `${label}.matchedQuery`);
    assertNonEmptyString(item.queryType, `${label}.queryType`);
    assertNonEmptyString(item.roughTier, `${label}.roughTier`);
    assertNonEmptyString(item.roughReason, `${label}.roughReason`);

    if (item.contentLength < 30 && item.usedAsEvidence === true) {
      throw new Error(`${label} short candidate became core evidence: ${item.title || item.candidateId}.`);
    }
  }
}

function assertSearchPlan(debug, originalQuery, label) {
  const searchQueries = assertNonEmptyArray(debug.searchQueries, `${label}.searchQueries`);
  if (searchQueries.length < 8) {
    throw new Error(`${label}.searchQueries expected at least 8 items, got ${searchQueries.length}.`);
  }

  const first = readRecord(searchQueries[0], `${label}.searchQueries[0]`);
  assertEqual(readString(first.query, `${label}.searchQueries[0].query`), originalQuery, `${label}.searchQueries[0].query`);
  assertEqual(readString(first.type, `${label}.searchQueries[0].type`), "original", `${label}.searchQueries[0].type`);

  const queryTypes = new Set(
    searchQueries.map((item, index) => readString(readRecord(item, `${label}.searchQueries[${index}]`).type, `${label}.searchQueries[${index}].type`))
  );
  if (queryTypes.size < 5) {
    throw new Error(`${label}.searchQueries expected at least 5 query types, got ${Array.from(queryTypes).join(",")}.`);
  }

  const searchQueryResults = assertNonEmptyArray(debug.searchQueryResults, `${label}.searchQueryResults`);
  const searchDebug = readRecord(debug.search, `${label}.search`);
  const queriesUsed = assertNonEmptyArray(searchDebug.queriesUsed, `${label}.search.queriesUsed`);
  const searchRounds = assertNonEmptyArray(searchDebug.searchRounds, `${label}.search.searchRounds`);
  if (queriesUsed.length < 3 || queriesUsed.length > 6) {
    throw new Error(`${label}.search.queriesUsed expected 3-6 items, got ${queriesUsed.length}.`);
  }
  assertEqual(searchRounds.length, queriesUsed.length, `${label}.search.searchRounds length`);
  assertEqual(searchQueryResults.length, searchRounds.length, `${label}.searchQueryResults length`);
  if (!Number.isFinite(searchDebug.totalRawResults) || searchDebug.totalRawResults <= 0) {
    throw new Error(`${label}.search.totalRawResults expected > 0.`);
  }
  if (!Number.isFinite(searchDebug.totalDedupedCandidates) || searchDebug.totalDedupedCandidates <= 0) {
    throw new Error(`${label}.search.totalDedupedCandidates expected > 0.`);
  }
  assertArray(searchDebug.failedQueries, `${label}.search.failedQueries`);
  assertArray(searchDebug.emptyQueries, `${label}.search.emptyQueries`);
  if (typeof searchDebug.degraded !== "boolean") {
    throw new Error(`${label}.search.degraded expected boolean.`);
  }
  const candidates = assertNonEmptyArray(searchDebug.candidates, `${label}.search.candidates`);
  candidates.slice(0, 3).forEach((candidate, index) => {
    const item = readRecord(candidate, `${label}.search.candidates[${index}]`);
    assertNonEmptyString(item.title, `${label}.search.candidates[${index}].title`);
    assertNonEmptyString(item.url, `${label}.search.candidates[${index}].url`);
    assertNonEmptyString(item.queryUsed, `${label}.search.candidates[${index}].queryUsed`);
  });
  searchQueryResults.forEach((item, index) => {
    const result = readRecord(item, `${label}.searchQueryResults[${index}]`);
    if (!Number.isFinite(result.returnedCount)) {
      throw new Error(`${label}.searchQueryResults[${index}].returnedCount expected a finite number.`);
    }
  });

  for (const key of ["mergedCandidateCount", "dedupedCandidateCount", "validCandidateCount"]) {
    if (!Number.isFinite(debug[key])) {
      throw new Error(`${label}.${key} expected a finite number.`);
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

function assertPersonaChatAcceptance(chatData, label) {
  const reply = readString(chatData.reply, `${label} data.reply`);
  const boundaryNotice = readString(chatData.boundaryNotice, `${label} data.boundaryNotice`);
  assertArray(chatData.sourceRefs, `${label} data.sourceRefs`);
  assertArray(chatData.suggestedQuestions, `${label} data.suggestedQuestions`);

  if (!reply.includes("我")) {
    throw new Error(`${label} data.reply must use first person.`);
  }

  for (const fragment of PERSONA_REPLY_FORBIDDEN_FRAGMENTS) {
    if (reply.includes(fragment)) {
      throw new Error(`${label} data.reply should not include ${fragment}.`);
    }
  }

  if (reply.includes(boundaryNotice)) {
    throw new Error(`${label} data.reply repeated boundaryNotice.`);
  }

  if (chatData.debug?.chatMode === "real_llm_chat") {
    assertNonEmptyArray(chatData.sourceRefs, `${label} data.sourceRefs when real`);
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
  printSearchPlan(run);
  printCandidatePipeline(run);
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
  const diversityCheck = isRecord(debug.pathDiversityCheck) ? debug.pathDiversityCheck : {};
  console.log(
    `paths ${run.label} query="${run.query}" pathSource=${debug.pathSource || ""} count=${paths.length} composerFallback=${debug.composerFallbackTriggered === true} duplicateFound=${debug.pathDuplicateFound === true} rewrites=${formatNumber(diversityCheck.rewriteCount)} merges=${formatNumber(diversityCheck.mergeCount)}`
  );

  paths.forEach((path, index) => {
    const item = readRecord(path, `${run.label} data.paths[${index}]`);
    const title = readString(item.title, `${run.label} data.paths[${index}].title`);
    const summary = typeof item.summary === "string" ? item.summary : "";
    const whyRelevant = typeof item.whyRelevant === "string" ? item.whyRelevant : "";
    const tradeoff = typeof item.tradeoff === "string" ? item.tradeoff : "";
    const diversityKey = typeof item.diversityKey === "string" ? item.diversityKey : "";
    const sourceRefCount = Array.isArray(item.sourceRefs) ? item.sourceRefs.length : 0;
    const source = formatPathSource(item, debug);

    console.log(`  path[${index + 1}] title=${title}`);
    console.log(`    summary=${summary}`);
    console.log(`    whyRelevant=${whyRelevant}`);
    console.log(`    tradeoff=${tradeoff}`);
    console.log(`    sourceRefs=${sourceRefCount} diversityKey=${diversityKey}`);
    console.log(`    source=${source}`);
  });
}

function printSearchPlan(run) {
  const debug = readRecord(run.data.debug, `${run.label} debug`);
  const searchQueries = assertNonEmptyArray(debug.searchQueries, `${run.label} data.debug.searchQueries`);
  const searchQueryResults = Array.isArray(debug.searchQueryResults) ? debug.searchQueryResults : [];
  const searchDebug = isRecord(debug.search) ? debug.search : {};
  const queriesUsed = Array.isArray(searchDebug.queriesUsed) ? searchDebug.queriesUsed : [];
  const searchRounds = Array.isArray(searchDebug.searchRounds) ? searchDebug.searchRounds : [];
  const failedQueries = Array.isArray(searchDebug.failedQueries) ? searchDebug.failedQueries : [];
  const emptyQueries = Array.isArray(searchDebug.emptyQueries) ? searchDebug.emptyQueries : [];
  const candidates = Array.isArray(searchDebug.candidates) ? searchDebug.candidates : [];
  const focusTags = Array.isArray(run.data.analysis?.focusTags) ? run.data.analysis.focusTags.join(",") : "";
  const topicSignals = Array.isArray(debug.topicSignals) ? debug.topicSignals.join(",") : "";
  console.log(
    `searchPlan ${run.label} originalQuery="${debug.originalQuery || run.query}" userCoreQuestion="${debug.userCoreQuestion || ""}" intent="${run.data.analysis?.intent || ""}" focusTags="${focusTags}" topicSignals="${topicSignals}" searchQueries=${searchQueries.length}`
  );
  console.log(
    `  counts raw=${formatNumber(debug.rawCandidateCount)} merged=${formatNumber(debug.mergedCandidateCount)} deduped=${formatNumber(debug.dedupedCandidateCount)} valid=${formatNumber(debug.validCandidateCount)} fallbackReason=${debug.fallbackReason || ""}`
  );
  console.log(
    `searchDebug ${run.label} originalQuery="${debug.originalQuery || run.query}" intent="${run.data.analysis?.intent || ""}" queriesUsed=${queriesUsed.length} searchRounds=${searchRounds.length} totalRawResults=${formatNumber(searchDebug.totalRawResults)} totalDedupedCandidates=${formatNumber(searchDebug.totalDedupedCandidates)} degraded=${searchDebug.degraded === true} fallbackReason=${searchDebug.fallbackReason || ""}`
  );
  console.log(`  queriesUsed=${queriesUsed.join(" | ")}`);
  console.log(`  failedQueries=${failedQueries.join(" | ") || "[]"}`);
  console.log(`  emptyQueries=${emptyQueries.join(" | ") || "[]"}`);

  candidates.slice(0, 3).forEach((candidate, index) => {
    if (!isRecord(candidate)) return;
    console.log(
      `  topCandidate[${index + 1}] title=${candidate.title || ""} url=${candidate.url || ""} queryUsed=${candidate.queryUsed || ""}`
    );
  });

  searchQueries.forEach((plan, index) => {
    const item = readRecord(plan, `${run.label} data.debug.searchQueries[${index}]`);
    const query = readString(item.query, `${run.label} data.debug.searchQueries[${index}].query`);
    const type = readString(item.type, `${run.label} data.debug.searchQueries[${index}].type`);
    const purpose = typeof item.purpose === "string" ? item.purpose : "";
    const priority = Number.isFinite(item.priority) ? item.priority : "";
    const result = searchQueryResults.find((candidate) => isRecord(candidate) && candidate.query === query);
    const returnedCount = isRecord(result) && Number.isFinite(result.returnedCount) ? result.returnedCount : "n/a";
    const error = isRecord(result) && typeof result.error === "string" ? ` error=${result.error}` : "";
    console.log(
      `  query[${index + 1}] priority=${priority} type=${type} returned=${returnedCount} query=${query} purpose=${purpose}${error}`
    );
  });
}

function printCandidatePipeline(run) {
  const debug = readRecord(run.data.debug, `${run.label} debug`);
  const rough = isRecord(debug.roughTierDistribution) ? debug.roughTierDistribution : {};
  console.log(
    `candidatePipeline ${run.label} query="${run.query}" rerankEnabled=${debug.rerankEnabled === true} rerankUsed=${debug.rerankUsed === true} rerankDurationMs=${formatNumber(debug.rerankDurationMs)} rerankFailedReason=${debug.rerankFailedReason || ""}`
  );
  console.log(
    `  rough strong=${formatNumber(rough.strong)} usable=${formatNumber(rough.usable)} backup=${formatNumber(rough.backup)} drop=${formatNumber(rough.drop)} rerankCandidates=${formatNumber(debug.rerankCandidatesCount)} selected=${formatNumber(debug.selectedCandidatesCount)} dropped=${formatNumber(debug.droppedCandidatesCount)} final=${formatNumber(debug.finalCandidateCount)}`
  );
  console.log(
    `  refill triggered=${debug.refillTriggered === true} reason=${debug.refillReason || ""} refillCandidates=${formatNumber(debug.refillCandidateCount)}`
  );
  const refillQueries = Array.isArray(debug.refillQueries) ? debug.refillQueries : [];
  refillQueries.forEach((query, index) => {
    if (!isRecord(query)) return;
    console.log(
      `    refillQuery[${index + 1}] type=${query.type || ""} query=${query.query || ""} purpose=${query.purpose || ""}`
    );
  });

  const finalCandidates = Array.isArray(debug.finalCandidates) ? debug.finalCandidates : [];
  finalCandidates.slice(0, 10).forEach((candidate, index) => {
    if (!isRecord(candidate)) return;
    console.log(
      `    final[${index + 1}] title=${candidate.title || ""} author=${candidate.author || ""} matchedQuery=${candidate.matchedQuery || ""} queryType=${candidate.queryType || ""} roughScore=${formatNumber(candidate.roughScore)} relevanceScore=${formatNumber(candidate.relevanceScore)} contentRole=${candidate.contentRole || ""} diversityKey=${candidate.diversityKey || ""} sourceRefs=${Array.isArray(candidate.sourceRefs) ? candidate.sourceRefs.length : 0}`
    );
    console.log(`      relation=${candidate.relationToUserIntent || ""}`);
    console.log(`      summaryAngle=${candidate.summaryAngle || ""}`);
    console.log(`      keepReason=${candidate.keepReason || ""}`);
  });

  const dropped = Array.isArray(debug.droppedCandidates) ? debug.droppedCandidates : [];
  dropped.slice(0, 3).forEach((candidate, index) => {
    if (!isRecord(candidate)) return;
    console.log(
      `    dropped[${index + 1}] title=${candidate.title || ""} roughScore=${formatNumber(candidate.roughScore)} dropReason=${candidate.dropReason || ""}`
    );
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
      `  stage=${timing.stageName} provider=${timing.provider || ""} model=${timing.model || ""} durationMs=${timing.durationMs} llmUsed=${timing.llmUsed} fallbackUsed=${timing.fallbackUsed} fallbackReason=${timing.fallbackReason || ""}`
    );
  }
}

function printPersonaChatInspection(chatRuns) {
  console.log(`personaChatInspection samples=${chatRuns.length}`);
  chatRuns.forEach((run, index) => {
    const sourceRefCount = Array.isArray(run.data.sourceRefs) ? run.data.sourceRefs.length : 0;
    const suggestedCount = Array.isArray(run.data.suggestedQuestions) ? run.data.suggestedQuestions.length : 0;
    console.log(
      `  chat[${index + 1}] mode=${run.debug.chatMode || ""} sourceRefs=${sourceRefCount} suggestedQuestions=${suggestedCount} question=${run.message}`
    );
    console.log(`    boundaryNotice=${run.data.boundaryNotice || ""}`);
    console.log(`    reply=${previewText(run.data.reply || "", 180)}`);
  });
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
  const matchedQuery = typeof candidate.matchedQuery === "string" ? ` matchedQuery=${candidate.matchedQuery}` : "";
  const queryType = typeof candidate.queryType === "string" ? ` queryType=${candidate.queryType}` : "";
  return title
    ? `title=${title}${matchedQuery}${queryType}`
    : `candidateId=${candidateId || "unknown"}${matchedQuery}${queryType}`;
}

function formatNumber(value) {
  return Number.isFinite(value) ? String(value) : "n/a";
}

function previewText(value, maxLength) {
  const normalized = String(value).replace(/\s+/g, " ").trim();
  return normalized.length <= maxLength ? normalized : `${normalized.slice(0, maxLength - 3)}...`;
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

function assertArray(value, label) {
  if (!Array.isArray(value)) {
    throw new Error(`${label} expected an array.`);
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

function readQueryListEnv(name, fallback) {
  const value = process.env[name];
  if (!value || !value.trim()) {
    return fallback;
  }

  const queries = value
    .split("|")
    .map((item) => item.trim())
    .filter(Boolean);

  return queries.length > 0 ? queries : fallback;
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
