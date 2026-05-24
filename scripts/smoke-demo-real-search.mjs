#!/usr/bin/env node
import { once } from "node:events";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const DEFAULT_QUERY = decodeURIComponent(
  "%E4%B8%BA%E4%BA%86%E5%B7%A5%E4%BD%9C%E8%83%BD%E8%BF%BD%E6%B1%82%E8%87%AA%E5%B7%B1%E6%83%B3%E5%81%9A%E7%9A%84%E4%BA%8B%EF%BC%8C%E9%95%BF%E6%9C%9F%E5%BC%82%E5%9C%B0%E6%81%8B%E7%9C%9F%E7%9A%84%E5%80%BC%E5%BE%97%E5%90%97%EF%BC%9F"
);
const DEFAULT_QUERIES = [DEFAULT_QUERY];
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
    const validationQueries = readQueryListEnv("DEMO_SMOKE_QUERIES", DEFAULT_QUERIES);
    const count = parsePositiveInt(process.env.DEMO_SMOKE_COUNT, 3);
    const runs = [];

    for (const [index, query] of validationQueries.entries()) {
      runs.push(await runDemoSearch(baseUrl, query, count, `search query ${index + 1}`));
    }

    for (const run of runs) {
      printSearchInspection(run);
    }

    console.log("PASS demo real search smoke");
    console.log(`validation queries=${runs.length}`);
  } finally {
    await closeServer(server);
  }
}

async function runDemoSearch(baseUrl, query, count, label) {
  const startedAt = Date.now();
  const response = await requestJson(`${baseUrl}/api/demo/search`, {
    method: "POST",
    body: {
      query,
      count,
      dataMode: "real"
    }
  });
  const durationMs = Date.now() - startedAt;

  assertSuccess(response, `POST /api/demo/search ${label}`);
  const data = readRecord(response.body.data, `${label} data`);
  const debug = readRecord(data.debug, `${label} data.debug`);
  const search = readRecord(debug.search, `${label} data.debug.search`);
  assertSearchDebug(search, `${label} data.debug.search`);
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

function printSearchInspection(run) {
  const search = run.search;
  const candidates = Array.isArray(search.candidates) ? search.candidates : [];
  console.log(
    `searchSmoke ${run.label} query="${run.query}" durationMs=${run.durationMs} queriesUsed=${search.queriesUsed.length} searchRounds=${search.searchRounds.length} totalRawResults=${search.totalRawResults} totalDedupedCandidates=${search.totalDedupedCandidates} degraded=${search.degraded === true} fallbackReason=${search.fallbackReason || ""}`
  );
  console.log(`  failedQueries=${Array.isArray(search.failedQueries) && search.failedQueries.length ? search.failedQueries.join(" | ") : "[]"}`);
  console.log(`  emptyQueries=${Array.isArray(search.emptyQueries) && search.emptyQueries.length ? search.emptyQueries.join(" | ") : "[]"}`);
  candidates.slice(0, 3).forEach((candidate, index) => {
    if (!isRecord(candidate)) return;
    console.log(
      `  topCandidate[${index + 1}] title=${candidate.title || ""} url=${candidate.url || ""} queryUsed=${candidate.queryUsed || ""}`
    );
  });
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
