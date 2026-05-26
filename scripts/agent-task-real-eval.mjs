#!/usr/bin/env node
import { once } from "node:events";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const QUERIES = [
  "长期异地恋真的值得吗",
  "不工作了能去哪儿",
  "为了工作能追求自己想做的事，长期异地恋真的值得吗",
  "毕业后该去大城市还是回老家",
  "裸辞之后的人后来怎么样了",
  "转行做产品经理现实吗",
  "三十岁还适合重新开始吗",
  "要不要为了稳定放弃喜欢的事"
];

await main().catch((error) => {
  console.error(`FAIL ${error instanceof Error ? error.stack || error.message : String(error)}`);
  process.exitCode = 1;
});

async function main() {
  const repoRoot = process.cwd();
  const appPath = join(repoRoot, "backend", "dist", "app.js");
  if (!existsSync(appPath)) {
    throw new Error("backend/dist/app.js not found. Run `npm run build -w backend` first.");
  }

  const tempDir = mkdtempSync(join(tmpdir(), "agent-task-real-eval-"));
  process.env.AGENT_TASK_STORE = process.env.AGENT_TASK_STORE || "sqlite";
  process.env.AGENT_TASK_DB_PATH = process.env.AGENT_TASK_DB_PATH || join(tempDir, "agent-tasks.sqlite");
  process.env.DATA_MODE = process.env.DATA_MODE || "real";

  const [{ app }, { config }, { llmRouter }] = await Promise.all([
    import(pathToFileURL(appPath).href),
    import(pathToFileURL(join(repoRoot, "backend", "dist", "config", "env.js")).href),
    import(pathToFileURL(join(repoRoot, "backend", "dist", "llm", "llmRouter.js")).href)
  ]);

  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Eval server did not expose a TCP address.");
  }

  const baseUrl = `http://127.0.0.1:${address.port}`;
  const results = [];
  try {
    for (const query of QUERIES) {
      const result = await evaluateQuery(baseUrl, query);
      results.push(result);
      console.log(formatCompactRow(result));
    }
  } finally {
    await closeServer(server);
  }

  const summary = summarize(results);
  const report = {
    generatedAt: new Date().toISOString(),
    providerModel: {
      evidence_extract: {
        provider: llmRouter.getProviderForTask("evidence_extract"),
        model: llmRouter.getModelForTask("evidence_extract"),
        configured: llmRouter.isTaskConfigured("evidence_extract")
      },
      experience_summary: {
        provider: llmRouter.getProviderForTask("experience_summary"),
        model: llmRouter.getModelForTask("experience_summary"),
        configured: llmRouter.isTaskConfigured("experience_summary")
      }
    },
    timeoutMs: {
      evidence_extract: config.agentTask.timeouts.evidenceExtractMs,
      experience_summary: config.agentTask.timeouts.experienceSummaryMs
    },
    summary,
    results
  };
  const outputPath = process.env.AGENT_TASK_REAL_EVAL_OUTPUT || join(tempDir, "agent-task-real-eval.json");
  writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`);

  printMarkdownReport(report, outputPath);

  if (
    summary.partialDisplayable < 7 ||
    summary.evidenceSucceeded < 5 ||
    summary.summarySucceeded < 5 ||
    summary.demoFallback > 0 ||
    summary.http500 > 0
  ) {
    process.exitCode = 1;
  }
}

async function evaluateQuery(baseUrl, query) {
  const startedAt = Date.now();
  const record = {
    query,
    taskId: "",
    created: false,
    partialMs: null,
    finalMs: null,
    status: "",
    degraded: false,
    demoFallback: false,
    http500: false,
    evidenceStatus: "missing",
    evidenceDurationMs: null,
    summaryStatus: "missing",
    summaryDurationMs: null,
    evidenceSamples: 0,
    experienceSummaries: 0,
    paths: 0,
    people: 0,
    failedStages: [],
    degradedReason: ""
  };

  const created = await requestJson(`${baseUrl}/api/agent/tasks`, {
    method: "POST",
    body: {
      query,
      count: 5,
      dataMode: "real",
      metadata: { source: "agent-task-real-eval" }
    }
  });
  record.http500 = record.http500 || created.status >= 500;
  record.created = created.ok && created.body?.success === true && Boolean(created.body?.data?.taskId);
  if (!record.created) {
    record.status = `create_failed_${created.status}`;
    return record;
  }

  record.taskId = created.body.data.taskId;
  const partial = await waitForTask(baseUrl, record.taskId, (data) => data.hasPartialResult === true, startedAt);
  record.http500 = record.http500 || partial.http500;
  record.partialMs = partial.elapsedMs;

  const final = await waitForTask(
    baseUrl,
    record.taskId,
    (data) => ["succeeded", "degraded", "failed"].includes(String(data.status)),
    startedAt
  );
  record.http500 = record.http500 || final.http500;
  record.finalMs = final.elapsedMs;
  const statusData = final.data || {};
  record.status = String(statusData.status || "unknown");
  record.degraded = Boolean(statusData.degraded);
  record.failedStages = Array.isArray(statusData.failedStages) ? statusData.failedStages : [];
  record.degradedReason = String(statusData.degradedReason || "");

  const stages = Array.isArray(statusData.stages) ? statusData.stages : [];
  const evidenceStage = stages.find((stage) => stage?.name === "evidence_extract");
  const summaryStage = stages.find((stage) => stage?.name === "experience_summary");
  record.evidenceStatus = String(evidenceStage?.status || "missing");
  record.evidenceDurationMs = durationBetween(evidenceStage?.startedAt, evidenceStage?.finishedAt);
  record.summaryStatus = String(summaryStage?.status || "missing");
  record.summaryDurationMs = durationBetween(summaryStage?.startedAt, summaryStage?.finishedAt);

  const resultResponse = await requestJson(`${baseUrl}/api/agent/tasks/${encodeURIComponent(record.taskId)}/result`);
  record.http500 = record.http500 || resultResponse.status >= 500;
  const result = resultResponse.body?.data?.result;
  if (result && typeof result === "object") {
    const meta = result.meta && typeof result.meta === "object" ? result.meta : {};
    const people = Array.isArray(result.people) ? result.people : [];
    record.demoFallback = result.dataMode === "mock";
    record.paths = Array.isArray(result.paths) ? result.paths.length : 0;
    record.people = people.length;
    record.evidenceSamples = Array.isArray(meta.evidenceSamples) ? meta.evidenceSamples.length : 0;
    record.experienceSummaries = people.filter((person) =>
      typeof person?.experienceSummary === "string" && person.experienceSummary.trim()
    ).length;
  }

  return record;
}

async function waitForTask(baseUrl, taskId, predicate, startedAt) {
  const timeoutAt = Date.now() + 240000;
  let latest = null;
  let http500 = false;

  while (Date.now() < timeoutAt) {
    await sleep(350);
    const response = await requestJson(`${baseUrl}/api/agent/tasks/${encodeURIComponent(taskId)}`);
    http500 = http500 || response.status >= 500;
    if (response.ok && response.body?.success === true) {
      latest = response.body.data;
      if (predicate(latest)) {
        return {
          data: latest,
          elapsedMs: Date.now() - startedAt,
          http500
        };
      }
    }
  }

  return {
    data: latest,
    elapsedMs: Date.now() - startedAt,
    http500
  };
}

async function requestJson(url, options = {}) {
  let response;
  let text = "";
  try {
    response = await fetch(url, {
      method: options.method || "GET",
      headers: { "Content-Type": "application/json" },
      body: options.body === undefined ? undefined : JSON.stringify(options.body)
    });
    text = await response.text();
  } catch (error) {
    return {
      ok: false,
      status: 0,
      body: { error: { message: error instanceof Error ? error.message : String(error) } }
    };
  }

  return {
    ok: response.ok,
    status: response.status,
    body: text ? JSON.parse(text) : null
  };
}

function summarize(results) {
  return {
    total: results.length,
    created: results.filter((item) => item.created).length,
    partialDisplayable: results.filter((item) => item.paths > 0 && item.people > 0).length,
    evidenceSucceeded: results.filter((item) => item.evidenceStatus === "succeeded").length,
    summarySucceeded: results.filter((item) => item.summaryStatus === "succeeded").length,
    timedOut: results.filter((item) =>
      item.evidenceStatus === "timed_out" || item.summaryStatus === "timed_out"
    ).length,
    degraded: results.filter((item) => item.degraded).length,
    demoFallback: results.filter((item) => item.demoFallback).length,
    http500: results.filter((item) => item.http500).length
  };
}

function printMarkdownReport(report, outputPath) {
  const provider = report.providerModel;
  console.log("\n# Agent Task Real Eval");
  console.log(`\noutput: ${outputPath}`);
  console.log(
    `provider/model: evidence=${provider.evidence_extract.provider}/${provider.evidence_extract.model}, summary=${provider.experience_summary.provider}/${provider.experience_summary.model}`
  );
  console.log(
    `timeouts: evidence=${report.timeoutMs.evidence_extract}ms, summary=${report.timeoutMs.experience_summary}ms`
  );
  console.log(
    `summary: partialDisplayable=${report.summary.partialDisplayable}/${report.summary.total}, evidenceSucceeded=${report.summary.evidenceSucceeded}/${report.summary.total}, summarySucceeded=${report.summary.summarySucceeded}/${report.summary.total}, timedOut=${report.summary.timedOut}, degraded=${report.summary.degraded}, demoFallback=${report.summary.demoFallback}, http500=${report.summary.http500}`
  );
  console.log("\n| Query | partial | final | evidence | evidence ms | summary | summary ms | evidenceSamples | experienceSummary | degraded | 500 | demo fallback |");
  console.log("|---|---:|---:|---|---:|---|---:|---:|---:|---|---|---|");
  for (const item of report.results) {
    console.log(
      `| ${escapeCell(item.query)} | ${formatMs(item.partialMs)} | ${formatMs(item.finalMs)} | ${item.evidenceStatus} | ${formatMs(item.evidenceDurationMs)} | ${item.summaryStatus} | ${formatMs(item.summaryDurationMs)} | ${item.evidenceSamples} | ${item.experienceSummaries} | ${item.degraded} | ${item.http500} | ${item.demoFallback} |`
    );
  }
}

function formatCompactRow(item) {
  return [
    "REAL_EVAL_ROW",
    JSON.stringify(item.query),
    `partial=${formatMs(item.partialMs)}`,
    `final=${formatMs(item.finalMs)}`,
    `evidence=${item.evidenceStatus}/${formatMs(item.evidenceDurationMs)}`,
    `summary=${item.summaryStatus}/${formatMs(item.summaryDurationMs)}`,
    `samples=${item.evidenceSamples}`,
    `summaries=${item.experienceSummaries}`,
    `degraded=${item.degraded}`,
    `500=${item.http500}`,
    `fallback=${item.demoFallback}`
  ].join(" ");
}

function durationBetween(startedAt, finishedAt) {
  if (!startedAt || !finishedAt) {
    return null;
  }

  const started = Date.parse(startedAt);
  const finished = Date.parse(finishedAt);
  if (!Number.isFinite(started) || !Number.isFinite(finished)) {
    return null;
  }

  return Math.max(0, finished - started);
}

function escapeCell(value) {
  return String(value).replace(/\|/g, "\\|");
}

function formatMs(value) {
  return value === null || value === undefined ? "-" : `${Math.round(value)}ms`;
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
