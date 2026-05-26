#!/usr/bin/env node
import { once } from "node:events";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const DEFAULT_QUERIES = [
  "35岁从互联网大厂裸辞，要不要创业？",
  "30岁女生从体制内辞职去做自媒体靠谱吗？",
  "产品经理被裁后，要不要转自由职业？",
  "在北京工作十年，想回老家开店现实吗？",
  "施工单位正式工辞职后，不知道能做什么？"
];
const GENERIC_PRIMARY_RE = /真实经历|后悔吗|怎么办|值得吗|迷茫/;
const OBJECTIVE_WORD_RE = /[2-6]\d岁|互联网|教育|医疗|施工单位|建筑|体制内|大厂|国企|外企|创业公司|产品经理|运营|程序员|技术|研发|设计|销售|市场|北京|上海|深圳|广州|杭州|成都|老家|县城|一线城市|二线城市|正式工|裸辞|辞职|离职|被裁|待业|失业|不工作|在职|工作十年|创业|自由职业|转行|回老家|开店|自媒体|出路/;
const BACKGROUND_IDENTITY_RE = /[2-6]\d岁|互联网|教育|医疗|施工单位|建筑|体制内|大厂|国企|外企|创业公司|产品经理|运营|程序员|技术|研发|设计|销售|市场|北京|上海|深圳|广州|杭州|成都|老家|县城|一线城市|二线城市|正式工/;
const RELATIONSHIP_SIGNAL_RE = /异地恋|恋爱|距离|伴侣|男友|女友|城市|分开|团聚|见面|未来规划|工作选择|职业发展|工作机会/;
const CAREER_TRADEOFF_RE = /为了工作|工作机会|职业选择|职业发展|追求自己|想做的事|追求梦想|梦想|高薪|裸辞|稳定工作|工作调动/;
const GENERIC_WORK_REVIEW_RE = /复盘|效率|方法|目标|成长|管理|提升|曾国藩|工作复盘/;

await main().catch((error) => {
  console.error(`FAIL ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});

async function main() {
  const scriptDir = dirname(fileURLToPath(import.meta.url));
  const repoRoot = dirname(scriptDir);
  process.chdir(repoRoot);

  const validationQueries = readQueryListEnv("DEMO_SMOKE_QUERIES", DEFAULT_QUERIES);
  const count = parsePositiveInt(process.env.DEMO_SMOKE_COUNT, 3);
  const dataMode = resolveSmokeDataMode();
  process.env.DATA_MODE = process.env.DATA_MODE || dataMode;
  if (dataMode !== "real" && process.env.LLM_ENABLED === undefined) {
    process.env.LLM_ENABLED = "false";
  }
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
    const runs = [];

    for (const [index, query] of validationQueries.entries()) {
      runs.push(await runDemoSearch(baseUrl, query, count, dataMode, `search query ${index + 1}`));
    }

    for (const run of runs) {
      printSearchInspection(run);
    }

    console.log(`PASS demo ${dataMode} search smoke`);
    console.log(`validation queries=${runs.length}`);
  } finally {
    await closeServer(server);
  }
}

async function runDemoSearch(baseUrl, query, count, dataMode, label) {
  const startedAt = Date.now();
  const response = await requestJson(`${baseUrl}/api/demo/search`, {
    method: "POST",
    body: {
      query,
      count,
      dataMode
    }
  });
  const durationMs = Date.now() - startedAt;

  assertSuccess(response, `POST /api/demo/search ${label}`);
  const data = readRecord(response.body.data, `${label} data`);
  assertDerivedTopLevelFieldsOmitted(data, `${label} data`);
  assertPeoplePersonaEntries(
    assertNonEmptyArray(data.people, `${label} data.people`),
    `${label} data.people`
  );
  const debug = readRecord(data.debug, `${label} data.debug`);
  const search = readRecord(debug.search, `${label} data.debug.search`);
  assertSearchDebug(search, `${label} data.debug.search`);
  assertObjectiveIntentDebug(debug, search, `${label} data.debug`);
  assertCandidateQuality(debug, query, `${label} data.debug`);

  return {
    label,
    query,
    durationMs,
    data,
    debug,
    search
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

  console.warn("WARNING: real Zhihu API smoke is enabled.");
  console.warn(
    `Estimated upper bound: ${queryCount} demo queries * 6 search rounds = ${estimatedSearchRounds} real search attempts before fixture/cache hits.`
  );
  console.warn(
    `Budget: ZH_API_DAILY_DEV_BUDGET=${process.env.ZH_API_DAILY_DEV_BUDGET || "50"}; repeated normalized queries should hit local fixtures.`
  );
}

function isTruthy(value) {
  return ["1", "true", "yes", "on"].includes(String(value || "").trim().toLowerCase());
}

function assertSearchDebug(search, label) {
  const queriesUsed = assertNonEmptyArray(search.queriesUsed, `${label}.queriesUsed`);
  const searchRounds = assertNonEmptyArray(search.searchRounds, `${label}.searchRounds`);
  const candidates = assertNonEmptyArray(search.candidates, `${label}.candidates`);

  if (queriesUsed.length < 3) {
    throw new Error(`${label}.queriesUsed expected at least 3 items, got ${queriesUsed.length}.`);
  }

  if (searchRounds.length < 3) {
    throw new Error(`${label}.searchRounds expected at least 3 items, got ${searchRounds.length}.`);
  }

  if (!Number.isFinite(search.totalRawResults) || search.totalRawResults <= 0) {
    throw new Error(`${label}.totalRawResults expected > 0.`);
  }

  if (!Number.isFinite(search.totalDedupedCandidates) || search.totalDedupedCandidates <= 0) {
    throw new Error(`${label}.totalDedupedCandidates expected > 0.`);
  }

  candidates.slice(0, 3).forEach((candidate, index) => {
    const item = readRecord(candidate, `${label}.candidates[${index}]`);
    assertNonEmptyString(item.title, `${label}.candidates[${index}].title`);
    assertNonEmptyString(item.url, `${label}.candidates[${index}].url`);
    assertNonEmptyString(item.queryUsed, `${label}.candidates[${index}].queryUsed`);
  });

  const isRelationshipRun = search.queriesUsed.some((query) => RELATIONSHIP_SIGNAL_RE.test(String(query)));
  if (!isRelationshipRun) {
    return;
  }

  const topRelationshipCount = candidates.slice(0, 3).filter((candidate) => {
    const item = readRecord(candidate, `${label}.topCandidate`);
    return RELATIONSHIP_SIGNAL_RE.test(
      [item.title, item.snippet, item.excerpt, item.text, item.rawContent, item.queryUsed]
        .filter(Boolean)
        .join("\n")
    );
  }).length;

  if (topRelationshipCount < 2) {
    throw new Error(`${label}.candidates top 3 expected at least 2 relationship-related candidates.`);
  }
}

function assertObjectiveIntentDebug(debug, search, label) {
  const intentStage = readRecord(debug.intentStage, `${label}.intentStage`);
  const objectiveSlots = readRecord(intentStage.objectiveSlots, `${label}.intentStage.objectiveSlots`);
  const missingSlots = assertArray(intentStage.missingSlots, `${label}.intentStage.missingSlots`);
  const queryPlan = readRecord(intentStage.queryPlan, `${label}.intentStage.queryPlan`);
  const primary = assertNonEmptyArray(queryPlan.primary, `${label}.intentStage.queryPlan.primary`);
  const secondary = assertArray(queryPlan.secondary, `${label}.intentStage.queryPlan.secondary`);
  const fallback = assertArray(queryPlan.fallback, `${label}.intentStage.queryPlan.fallback`);

  if (!missingSlots.every((item) => typeof item === "string")) {
    throw new Error(`${label}.intentStage.missingSlots expected string array.`);
  }

  for (const slotName of ["age", "industry", "companyType", "role", "city", "status", "direction", "constraint"]) {
    if (!(slotName in objectiveSlots)) {
      throw new Error(`${label}.intentStage.objectiveSlots missing ${slotName}.`);
    }
  }

  const firstThreePrimary = primary.slice(0, 3).join(" | ");
  if (GENERIC_PRIMARY_RE.test(firstThreePrimary)) {
    throw new Error(`${label}.queryPlan.primary first 3 contained generic problem words: ${firstThreePrimary}`);
  }

  const objectivePrimaryCount = primary.filter((query) => OBJECTIVE_WORD_RE.test(String(query))).length;
  if (primary.length > 0 && objectivePrimaryCount / primary.length < 0.7) {
    throw new Error(`${label}.queryPlan.primary expected >=70% objective queries, got ${objectivePrimaryCount}/${primary.length}.`);
  }

  const identityQueryCount = search.queriesUsed.filter((query) => BACKGROUND_IDENTITY_RE.test(String(query))).length;
  if (identityQueryCount < 2) {
    throw new Error(`${label}.search.queriesUsed expected at least 2 objective identity/background queries.`);
  }

  if (!fallback.every((query) => typeof query === "string") || !secondary.every((query) => typeof query === "string")) {
    throw new Error(`${label}.queryPlan secondary/fallback expected string arrays.`);
  }
}

function assertCandidateQuality(debug, query, label) {
  const candidateQuality = assertNonEmptyArray(debug.candidateQuality, `${label}.candidateQuality`);
  if (!query.includes("异地恋")) {
    return;
  }

  for (const candidate of candidateQuality) {
    const item = readRecord(candidate, `${label}.candidateQuality[]`);
    const text = [item.title, item.matchedQuery, item.queryPurpose].filter(Boolean).join("\n");
    const genericWorkReview = GENERIC_WORK_REVIEW_RE.test(text);
    const hasRelationshipOrCareer = RELATIONSHIP_SIGNAL_RE.test(text) || CAREER_TRADEOFF_RE.test(text);
    const roughTier = typeof item.roughTier === "string" ? item.roughTier : "";
    const tooStrong = roughTier === "strong" || roughTier === "usable";

    if (genericWorkReview && !hasRelationshipOrCareer && item.usedAsEvidence === true && tooStrong) {
      throw new Error(
        `${label}.candidateQuality generic work-review candidate became core evidence: ${item.title}`
      );
    }
  }
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
    assertNonEmptyString(aiPersona.personaId, `${label}[${index}].aiPersona.personaId`);
  }
}

function printSearchInspection(run) {
  const search = run.search;
  const intentStage = isRecord(run.debug.intentStage) ? run.debug.intentStage : {};
  const queryPlan = isRecord(intentStage.queryPlan) ? intentStage.queryPlan : {};
  const candidates = Array.isArray(search.candidates) ? search.candidates : [];
  console.log(
    `searchSmoke ${run.label} query="${run.query}" durationMs=${run.durationMs} queriesUsed=${search.queriesUsed.length} searchRounds=${search.searchRounds.length} totalRawResults=${search.totalRawResults} totalDedupedCandidates=${search.totalDedupedCandidates} degraded=${search.degraded === true} fallbackReason=${search.fallbackReason || ""}`
  );
  console.log(`  objectiveSlots=${JSON.stringify(intentStage.objectiveSlots || {})}`);
  console.log(`  missingSlots=${Array.isArray(intentStage.missingSlots) ? intentStage.missingSlots.join(" | ") : "[]"}`);
  console.log(`  queryPlan.primary=${Array.isArray(queryPlan.primary) ? queryPlan.primary.join(" | ") : "[]"}`);
  console.log(`  queryPlan.secondary=${Array.isArray(queryPlan.secondary) ? queryPlan.secondary.join(" | ") : "[]"}`);
  console.log(`  queryPlan.fallback=${Array.isArray(queryPlan.fallback) ? queryPlan.fallback.join(" | ") : "[]"}`);
  console.log(`  queriesUsed=${Array.isArray(search.queriesUsed) ? search.queriesUsed.join(" | ") : "[]"}`);
  console.log(`  failedQueries=${Array.isArray(search.failedQueries) && search.failedQueries.length ? search.failedQueries.join(" | ") : "[]"}`);
  console.log(`  emptyQueries=${Array.isArray(search.emptyQueries) && search.emptyQueries.length ? search.emptyQueries.join(" | ") : "[]"}`);
  printLlmStageModels(run);
  candidates.slice(0, 3).forEach((candidate, index) => {
    if (!isRecord(candidate)) return;
    console.log(
      `  topCandidate[${index + 1}] title=${candidate.title || ""} url=${candidate.url || ""} queryUsed=${candidate.queryUsed || ""}`
    );
  });
}

function printLlmStageModels(run) {
  const timings = Array.isArray(run.debug.timings) ? run.debug.timings.filter(isRecord) : [];
  if (timings.length === 0) {
    const intentStage = isRecord(run.debug.intentStage) ? run.debug.intentStage : {};
    console.log(
      `  llmStage=none provider=${intentStage.provider || ""} model=${intentStage.model || ""}`
    );
    return;
  }

  for (const timing of timings) {
    const status = timing.llmUsed
      ? "success"
      : String(timing.fallbackReason || "").match(/timeout|timed out|exceeded|LLM_TASK_TIMEOUT|LLM_TIMEOUT/i)
        ? "timeout"
        : "fallback";
    console.log(
      `  llmStage=${timing.stageName} provider=${timing.provider || ""} model=${timing.model || ""} durationMs=${timing.durationMs} status=${status} fallbackUsed=${timing.fallbackUsed}`
    );
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

function readRecord(value, label) {
  if (!isRecord(value)) {
    throw new Error(`${label} expected object.`);
  }

  return value;
}

function assertArray(value, label) {
  if (!Array.isArray(value)) {
    throw new Error(`${label} expected array.`);
  }

  return value;
}

function assertNonEmptyArray(value, label) {
  const array = assertArray(value, label);
  if (array.length === 0) {
    throw new Error(`${label} expected non-empty array.`);
  }

  return array;
}

function assertNonEmptyString(value, label) {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${label} expected non-empty string.`);
  }
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function summarizeResponse(response) {
  return JSON.stringify(response.body).slice(0, 500);
}

function readQueryListEnv(name, fallback) {
  const value = process.env[name];
  if (!value) {
    return fallback;
  }

  const parsed = value
    .split(/\n|\|/)
    .map((item) => item.trim())
    .filter(Boolean);
  return parsed.length > 0 ? parsed : fallback;
}

function parsePositiveInt(value, fallback) {
  if (!value) {
    return fallback;
  }

  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

async function closeServer(server) {
  if (!server.listening) {
    return;
  }

  await new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}
