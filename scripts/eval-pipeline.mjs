#!/usr/bin/env node
// 核心体验链路评测脚本。
// 跑法：
//   node scripts/eval-pipeline.mjs                 跑全集并打印指标，与上次 baseline 对比
//   node scripts/eval-pipeline.mjs --baseline      把本次结果保存为 baseline 快照
//   node scripts/eval-pipeline.mjs --runs 2        每条 query 跑 2 次取均值
//   EVAL_BASE=http://127.0.0.1:8011 node scripts/eval-pipeline.mjs
//
// 依赖：后端已在目标 dataMode（默认 real）下启动。

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..");
const BASE = process.env.EVAL_BASE || "http://127.0.0.1:8011";
const DATA_MODE = process.env.EVAL_DATA_MODE || "real";
const args = process.argv.slice(2);
const SAVE_BASELINE = args.includes("--baseline");
const RUNS = Number.parseInt(args[args.indexOf("--runs") + 1], 10) > 0
  ? Number.parseInt(args[args.indexOf("--runs") + 1], 10)
  : 1;

const EVAL_DIR = resolve(REPO_ROOT, "backend", "eval");
const BASELINE_PATH = resolve(EVAL_DIR, "baseline.json");
const RUNS_DIR = resolve(EVAL_DIR, "runs");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function jpost(path, body) {
  const r = await fetch(BASE + path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  return { status: r.status, json: await r.json().catch(() => null) };
}
async function jget(path) {
  const r = await fetch(BASE + path);
  return { status: r.status, json: await r.json().catch(() => null) };
}

function textOf(person) {
  return [
    person.name,
    person.directionLabel,
    person.displayExcerpt,
    person.snippet,
    person.experienceSummary,
    person.oneLine,
    ...(person.articles || []).flatMap((a) => [a.title, a.text, a.summary])
  ]
    .filter(Boolean)
    .join(" ");
}

function pct(n) {
  return Number.isFinite(n) ? (n * 100).toFixed(0) + "%" : "n/a";
}

// 跑一次完整链路，返回该次原始观测
async function runOnce(item) {
  const t0 = Date.now();
  // 主链路（跳过澄清门，直达 intent→搜索→...→总结）
  const created = await jpost("/api/agent/tasks", {
    query: item.query,
    count: 10,
    dataMode: DATA_MODE,
    metadata: { skipNeedInput: true }
  });
  if (!created.json?.success) {
    return { error: `create failed ${created.status}: ${JSON.stringify(created.json)}` };
  }
  const taskId = created.json.data.taskId;
  let status = null;
  for (let i = 0; i < 150; i++) {
    const s = await jget(`/api/agent/tasks/${taskId}`);
    status = s.json?.data;
    if (!status) break;
    if (["succeeded", "degraded", "failed", "need_input", "canceled"].includes(status.status)) break;
    await sleep(700);
  }
  const latencyMs = Date.now() - t0;
  const res = await jget(`/api/agent/tasks/${taskId}/result`);
  const result = res.json?.data?.result;
  const stages = res.json?.data?.stages || status?.stages || [];

  // 单独探澄清门是否走 LLM。澄清门在主链路前暂停，不会触发知乎搜索；
  // dataMode 必须与本次 eval 一致，否则 real 模式的 LLM 澄清会被测成 mock fallback。
  let clarifyLlmUsed = null;
  const clarCreated = await jpost("/api/agent/tasks", {
    query: item.query,
    count: 10,
    dataMode: DATA_MODE
  });
  const clarData = clarCreated.json?.data;
  if (clarData?.status === "need_input") {
    clarifyLlmUsed = Boolean(clarData.needInput?.llmUsed);
  } else if (clarData?.taskId) {
    for (let i = 0; i < 80; i++) {
      const s = await jget(`/api/agent/tasks/${clarData.taskId}`);
      const data = s.json?.data;
      if (!data) break;
      if (data.status === "need_input") {
        clarifyLlmUsed = Boolean(data.needInput?.llmUsed);
        break;
      }
      if (["succeeded", "degraded", "failed", "canceled"].includes(data.status)) {
        clarifyLlmUsed = false;
        break;
      }
      await sleep(500);
    }
  }

  return { taskId, status, result, stages, latencyMs, clarifyLlmUsed };
}

function metricsFromObservation(item, obs) {
  if (obs.status?.status === "failed") {
    const code = obs.status?.error?.code;
    const message = obs.status?.error?.message || "task failed";
    return {
      error: `task failed${code ? ` ${code}` : ""}: ${message}`,
      latencyMs: obs.latencyMs
    };
  }
  if (obs.error || !obs.result) {
    return { error: obs.error || "no result", latencyMs: obs.latencyMs };
  }
  const r = obs.result;
  const people = r.people || [];
  const expPeople = people.filter((p) => p.sampleType === "experience_sample");
  const coreKw = item.coreSubjectKeywords || item.subjectKeywords || [];
  const topicKw = item.topicKeywords || item.subjectKeywords || [];
  const subjectHit = people.filter((p) => coreKw.some((kw) => textOf(p).includes(kw)));
  const topicHit = people.filter((p) => topicKw.some((kw) => textOf(p).includes(kw)));
  const summaryReady = expPeople.filter(
    (p) => p.experienceSummaryStatus === "ready" && p.experienceSummarySource === "llm"
  );
  const levelDist = { high: 0, medium: 0, low: 0 };
  for (const p of people) {
    const lvl = p.match?.level;
    if (lvl in levelDist) levelDist[lvl] += 1;
  }
  const intentStage = obs.stages.find((s) => s.name === "intent_expand");
  const personaIds = new Set(people.map((p) => p.id));
  const personas = r.personas || [];
  const personaConsistent = personas.filter((pa) => personaIds.has(pa.personId)).length;

  return {
    peopleCount: people.length,
    subjectMatchRate: people.length ? subjectHit.length / people.length : 0,
    topicMatchRate: people.length ? topicHit.length / people.length : 0,
    experienceSampleRate: people.length ? expPeople.length / people.length : 0,
    summaryReadyRate: expPeople.length ? summaryReady.length / expPeople.length : 0,
    matchLevelDist: levelDist,
    intentLlmUsed: intentStage ? intentStage.fallbackUsed === false : false,
    clarifyLlmUsed: obs.clarifyLlmUsed,
    degraded: obs.status?.status === "degraded" || obs.status?.degraded === true,
    personaConsistency: personas.length ? personaConsistent / personas.length : 1,
    personasCount: personas.length,
    latencyMs: obs.latencyMs,
    focusTags: r.analysis?.focusTags || [],
    searchQueries: readSearchQueries(r)
  };
}

function readSearchQueries(result) {
  const debugQueries = Array.isArray(result.debug?.searchQueries)
    ? result.debug.searchQueries
    : [];
  const queries = debugQueries
    .map((item) => typeof item === "string" ? item : item?.query)
    .filter(Boolean);
  if (queries.length > 0) {
    return queries;
  }

  return Array.isArray(result.debug?.search?.queriesUsed)
    ? result.debug.search.queriesUsed.filter(Boolean)
    : [];
}

function avg(nums) {
  const v = nums.filter((n) => Number.isFinite(n));
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : NaN;
}

function aggregateRuns(item, runMetrics) {
  const ok = runMetrics.filter((m) => !m.error);
  if (ok.length === 0) return { id: item.id, query: item.query, error: runMetrics[0]?.error };
  return {
    id: item.id,
    query: item.query,
    runs: ok.length,
    peopleCount: avg(ok.map((m) => m.peopleCount)),
    subjectMatchRate: avg(ok.map((m) => m.subjectMatchRate)),
    topicMatchRate: avg(ok.map((m) => m.topicMatchRate)),
    experienceSampleRate: avg(ok.map((m) => m.experienceSampleRate)),
    summaryReadyRate: avg(ok.map((m) => m.summaryReadyRate)),
    intentLlmUsed: ok.every((m) => m.intentLlmUsed),
    clarifyLlmUsed: ok.map((m) => m.clarifyLlmUsed).find((v) => v !== null) ?? null,
    degradedRate: avg(ok.map((m) => (m.degraded ? 1 : 0))),
    personaConsistency: avg(ok.map((m) => m.personaConsistency)),
    latencyP50: median(ok.map((m) => m.latencyMs)),
    latencyMax: Math.max(...ok.map((m) => m.latencyMs)),
    matchLevelDist: mergeLevels(ok.map((m) => m.matchLevelDist)),
    focusTagsSample: ok[0].focusTags,
    searchQueriesSample: ok[0].searchQueries
  };
}

function median(nums) {
  const v = nums.filter((n) => Number.isFinite(n)).sort((a, b) => a - b);
  if (!v.length) return NaN;
  const mid = Math.floor(v.length / 2);
  return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
}
function mergeLevels(dists) {
  return dists.reduce(
    (acc, d) => ({ high: acc.high + d.high, medium: acc.medium + d.medium, low: acc.low + d.low }),
    { high: 0, medium: 0, low: 0 }
  );
}

function overall(perQuery) {
  const ok = perQuery.filter((q) => !q.error);
  return {
    queries: perQuery.length,
    ok: ok.length,
    subjectMatchRate: avg(ok.map((q) => q.subjectMatchRate)),
    topicMatchRate: avg(ok.map((q) => q.topicMatchRate)),
    experienceSampleRate: avg(ok.map((q) => q.experienceSampleRate)),
    summaryReadyRate: avg(ok.map((q) => q.summaryReadyRate)),
    intentLlmUsedRate: avg(ok.map((q) => (q.intentLlmUsed ? 1 : 0))),
    clarifyLlmUsedRate: avg(ok.map((q) => (q.clarifyLlmUsed ? 1 : 0))),
    degradedRate: avg(ok.map((q) => q.degradedRate)),
    personaConsistency: avg(ok.map((q) => q.personaConsistency)),
    latencyP50: median(ok.map((q) => q.latencyP50)),
    latencyMax: Math.max(...ok.map((q) => q.latencyMax))
  };
}

function fmtArrow(cur, prev, higherBetter = true) {
  if (prev === undefined || prev === null || !Number.isFinite(prev) || !Number.isFinite(cur)) return "";
  const d = cur - prev;
  if (Math.abs(d) < 1e-6) return " (=)";
  const better = higherBetter ? d > 0 : d < 0;
  const sign = d > 0 ? "+" : "";
  return ` (${sign}${(d * 100).toFixed(0)}pp ${better ? "↑好" : "↓差"})`;
}

async function main() {
  const cfg = JSON.parse(readFileSync(resolve(EVAL_DIR, "queries.json"), "utf8"));
  const queries = cfg.queries;
  console.log(`eval base=${BASE} dataMode=${DATA_MODE} runs=${RUNS} queries=${queries.length}\n`);

  const perQuery = [];
  for (const item of queries) {
    process.stdout.write(`▶ ${item.id} "${item.query}" ... `);
    const runMetrics = [];
    for (let i = 0; i < RUNS; i++) {
      const obs = await runOnce(item);
      runMetrics.push(metricsFromObservation(item, obs));
    }
    const agg = aggregateRuns(item, runMetrics);
    perQuery.push(agg);
    if (agg.error) {
      console.log(`ERROR: ${agg.error}`);
    } else {
      console.log(
        `subj=${pct(agg.subjectMatchRate)} topic=${pct(agg.topicMatchRate)} exp=${pct(agg.experienceSampleRate)} sum=${pct(agg.summaryReadyRate)} intentLLM=${agg.intentLlmUsed} clarifyLLM=${agg.clarifyLlmUsed} deg=${pct(agg.degradedRate)} p50=${(agg.latencyP50 / 1000).toFixed(1)}s`
      );
    }
  }

  const summary = overall(perQuery);
  let baseline = null;
  if (existsSync(BASELINE_PATH)) {
    try { baseline = JSON.parse(readFileSync(BASELINE_PATH, "utf8")).summary; } catch {}
  }

  console.log("\n================ 汇总 ================");
  const b = baseline || {};
  console.log(`主体匹配率   subjectMatchRate     ${pct(summary.subjectMatchRate)}${fmtArrow(summary.subjectMatchRate, b.subjectMatchRate)}  (严格主体词，越高越切题)`);
  console.log(`话题匹配率   topicMatchRate       ${pct(summary.topicMatchRate)}${fmtArrow(summary.topicMatchRate, b.topicMatchRate)}  (宽松，仅参考)`);
  console.log(`经历样本率   experienceSampleRate ${pct(summary.experienceSampleRate)}${fmtArrow(summary.experienceSampleRate, b.experienceSampleRate)}`);
  console.log(`总结命中率   summaryReadyRate     ${pct(summary.summaryReadyRate)}${fmtArrow(summary.summaryReadyRate, b.summaryReadyRate)}  (目标≥80%)`);
  console.log(`意图走LLM率  intentLlmUsedRate    ${pct(summary.intentLlmUsedRate)}${fmtArrow(summary.intentLlmUsedRate, b.intentLlmUsedRate)}`);
  console.log(`澄清走LLM率  clarifyLlmUsedRate   ${pct(summary.clarifyLlmUsedRate)}${fmtArrow(summary.clarifyLlmUsedRate, b.clarifyLlmUsedRate)}`);
  console.log(`降级率       degradedRate         ${pct(summary.degradedRate)}${fmtArrow(summary.degradedRate, b.degradedRate, false)}`);
  console.log(`分身一致性   personaConsistency   ${pct(summary.personaConsistency)}${fmtArrow(summary.personaConsistency, b.personaConsistency)}`);
  console.log(`延迟 P50/Max latency             ${(summary.latencyP50 / 1000).toFixed(1)}s / ${(summary.latencyMax / 1000).toFixed(1)}s`);
  if (baseline) console.log("\n(对比对象：backend/eval/baseline.json)");

  const snapshot = {
    generatedAt: new Date().toISOString(),
    base: BASE,
    dataMode: DATA_MODE,
    runs: RUNS,
    summary,
    perQuery
  };
  mkdirSync(RUNS_DIR, { recursive: true });
  const runPath = resolve(RUNS_DIR, `${snapshot.generatedAt.replace(/[:.]/g, "-")}.json`);
  writeFileSync(runPath, JSON.stringify(snapshot, null, 2));
  console.log(`\n本次明细已存：${runPath}`);
  if (SAVE_BASELINE) {
    writeFileSync(BASELINE_PATH, JSON.stringify(snapshot, null, 2));
    console.log(`已保存为 baseline：${BASELINE_PATH}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
