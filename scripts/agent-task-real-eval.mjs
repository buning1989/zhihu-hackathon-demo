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

const REVIEW_OUTPUT_PATH = "/private/tmp/agent-result-review.md";
const TEMPLATE_PATH_FRAGMENTS = [
  "不上班后的真实日常",
  "过渡型路径：先解决现金流",
  "辞职后复盘",
  "待业中的拉扯",
  "有人先拉开距离",
  "有人把边界说清",
  "有人选择断联"
];
const GUIDE_MARKERS = ["指南", "方法", "路径", "工具准备", "最快入门", "零基础", "教程", "攻略", "课程", "训练营", "抄作业"];
const MARKETING_MARKERS = [
  "加微信",
  "私信",
  "报名",
  "咨询",
  "课程",
  "训练营",
  "推广",
  "带货",
  "官方",
  "学院",
  "转行辅导",
  "简历辅导",
  "面试辅导",
  "就业班",
  "机构培训",
  "培训毕业",
  "报班",
  "学员"
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
  const dataMode = resolveEvalDataMode();
  process.env.AGENT_TASK_STORE = process.env.AGENT_TASK_STORE || "sqlite";
  process.env.AGENT_TASK_DB_PATH = process.env.AGENT_TASK_DB_PATH || join(tempDir, "agent-tasks.sqlite");
  process.env.DATA_MODE = process.env.DATA_MODE || dataMode;
  printZhihuRiskNotice(dataMode, QUERIES.length);

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
      const result = await evaluateQuery(baseUrl, query, dataMode);
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

  const reviewPath = process.env.AGENT_RESULT_REVIEW_OUTPUT || REVIEW_OUTPUT_PATH;
  const markdownReport = buildMarkdownReport(report, outputPath, reviewPath);
  writeFileSync(reviewPath, markdownReport);
  printMarkdownReport(markdownReport);

  const strictLlmThresholds = dataMode === "real" || isTruthy(process.env.AGENT_TASK_EVAL_STRICT_LLM);
  const qualityFailed =
    summary.pathMismatchCount > 1 ||
    summary.templatePathCount > 0 ||
    summary.opinionAsExperienceCount > 0 ||
    summary.marketingSuspectCount > 0 ||
    summary.peopleIssueCount > 0 ||
    summary.unsupportedPathCount > 0;
  const failed = strictLlmThresholds
    ? summary.partialDisplayable < 7 ||
      summary.evidenceSucceeded < 7 ||
      summary.summarySucceeded < 6 ||
      summary.candidateSelectFailed > 0 ||
      summary.demoFallback > 0 ||
      summary.http500 > 0 ||
      qualityFailed
    : summary.partialDisplayable < summary.total ||
      summary.candidateSelectFailed > 0 ||
      summary.demoFallback > 0 ||
      summary.http500 > 0 ||
      qualityFailed;

  if (failed) {
    process.exitCode = 1;
  }
}

async function evaluateQuery(baseUrl, query, dataMode) {
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
    candidateSelectStatus: "missing",
    evidenceStatus: "missing",
    evidenceDurationMs: null,
    summaryStatus: "missing",
    summaryDurationMs: null,
    evidenceSamples: 0,
    experienceSummaries: 0,
    feedItems: 0,
    paths: 0,
    people: 0,
    pathMismatchCount: 0,
    weakCandidateCount: 0,
    opinionAsExperienceCount: 0,
    marketingSuspectCount: 0,
    peopleIssueCount: 0,
    unsupportedPathCount: 0,
    templatePathCount: 0,
    supplementalTriggered: false,
    supplementalQueryCount: 0,
    supplementalCandidateCount: 0,
    supplementalQueries: [],
    peopleTypeDistribution: {},
    pathTypeDistribution: {},
    qualityIssues: [],
    failedStages: [],
    degradedReason: ""
  };

  const created = await requestJson(`${baseUrl}/api/agent/tasks`, {
    method: "POST",
    body: {
      query,
      count: 10,
      dataMode,
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
  const candidateSelectStage = stages.find((stage) => stage?.name === "candidate_select");
  const evidenceStage = stages.find((stage) => stage?.name === "evidence_extract");
  const summaryStage = stages.find((stage) => stage?.name === "experience_summary");
  record.candidateSelectStatus = String(candidateSelectStage?.status || "missing");
  record.evidenceStatus = String(evidenceStage?.status || "missing");
  record.evidenceDurationMs = durationBetween(evidenceStage?.startedAt, evidenceStage?.finishedAt);
  record.summaryStatus = String(summaryStage?.status || "missing");
  record.summaryDurationMs = durationBetween(summaryStage?.startedAt, summaryStage?.finishedAt);
  const candidateOutputSummary = candidateSelectStage?.outputSummary && typeof candidateSelectStage.outputSummary === "object"
    ? candidateSelectStage.outputSummary
    : {};
  record.supplementalTriggered = candidateOutputSummary.supplementalSearchTriggered === true;
  record.supplementalQueryCount = Number(candidateOutputSummary.supplementalQueryCount || 0);
  record.supplementalCandidateCount = Number(candidateOutputSummary.supplementalCandidateCount || 0);
  record.supplementalQueries = Array.isArray(candidateOutputSummary.supplementalQueries)
    ? candidateOutputSummary.supplementalQueries
    : [];

  const resultResponse = await requestJson(`${baseUrl}/api/agent/tasks/${encodeURIComponent(record.taskId)}/result`);
  record.http500 = record.http500 || resultResponse.status >= 500;
  const result = resultResponse.body?.data?.result;
  if (result && typeof result === "object") {
    const meta = result.meta && typeof result.meta === "object" ? result.meta : {};
    const people = Array.isArray(result.people) ? result.people : [];
    const feedItems = Array.isArray(result.feedItems) ? result.feedItems : [];
    record.demoFallback = result.dataMode === "mock";
    const paths = Array.isArray(result.paths) ? result.paths : [];
    record.feedItems = feedItems.length;
    record.paths = paths.length;
    record.people = people.length;
    record.peopleTypeDistribution = countValues(
      people.map((person) => String(person?.sampleType || "unknown"))
    );
    record.pathTypeDistribution = countValues(
      paths.map((path) => String(path?.contentRole || path?.role || path?.stance || "unknown"))
    );
    record.evidenceSamples = Array.isArray(meta.evidenceSamples) ? meta.evidenceSamples.length : 0;
    record.experienceSummaries = people.filter((person) =>
      typeof person?.experienceSummary === "string" && person.experienceSummary.trim()
    ).length;
    const debug = result.debug && typeof result.debug === "object" ? result.debug : {};
    if (debug.refillTriggered === true) {
      record.supplementalTriggered = true;
      record.supplementalQueries = Array.isArray(debug.refillQueries)
        ? debug.refillQueries
        : record.supplementalQueries;
      record.supplementalQueryCount = record.supplementalQueries.length;
      record.supplementalCandidateCount = Number(debug.refillCandidateCount || record.supplementalCandidateCount || 0);
    }
    Object.assign(record, inspectResultQuality(query, result));
  }

  return record;
}

function resolveEvalDataMode() {
  const requested = String(process.env.DATA_MODE || process.env.AGENT_TASK_EVAL_DATA_MODE || "")
    .trim()
    .toLowerCase();
  if (["replay", "cache_first", "real"].includes(requested)) {
    return requested;
  }

  return isTruthy(process.env.ALLOW_REAL_ZH_API) ? "real" : "replay";
}

function printZhihuRiskNotice(dataMode, queryCount) {
  const allowReal = dataMode === "real" || isTruthy(process.env.ALLOW_REAL_ZH_API);
  if (!allowReal) {
    console.log(
      `Zhihu API guard: dataMode=${dataMode}; replay/cache-first eval should consume 0 real Zhihu API calls.`
    );
    return;
  }

  console.warn("WARNING: real Zhihu API agent eval is enabled.");
  console.warn(
    `Estimated upper bound: ${queryCount} agent queries * up to 7 search rounds = ${queryCount * 7} real search attempts before fixture/cache hits.`
  );
  console.warn(
    `Budget: ZH_API_DAILY_DEV_BUDGET=${process.env.ZH_API_DAILY_DEV_BUDGET || "50"}; repeated normalized queries should hit local fixtures.`
  );
}

function isTruthy(value) {
  return ["1", "true", "yes", "on"].includes(String(value || "").trim().toLowerCase());
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
    partialDisplayable: results.filter((item) => item.feedItems > 0 && item.people > 0).length,
    candidateSelectFailed: results.filter((item) => item.candidateSelectStatus === "failed").length,
    evidenceSucceeded: results.filter((item) => item.evidenceStatus === "succeeded").length,
    summarySucceeded: results.filter((item) => item.summaryStatus === "succeeded").length,
    timedOut: results.filter((item) =>
      item.evidenceStatus === "timed_out" || item.summaryStatus === "timed_out"
    ).length,
    degraded: results.filter((item) => item.degraded).length,
    demoFallback: results.filter((item) => item.demoFallback).length,
    http500: results.filter((item) => item.http500).length,
    pathMismatchCount: sumBy(results, "pathMismatchCount"),
    weakCandidateCount: sumBy(results, "weakCandidateCount"),
    opinionAsExperienceCount: sumBy(results, "opinionAsExperienceCount"),
    marketingSuspectCount: sumBy(results, "marketingSuspectCount"),
    peopleIssueCount: sumBy(results, "peopleIssueCount"),
    unsupportedPathCount: sumBy(results, "unsupportedPathCount"),
    templatePathCount: sumBy(results, "templatePathCount"),
    supplementalTriggered: results.filter((item) => item.supplementalTriggered).length,
    supplementalQueryCount: sumBy(results, "supplementalQueryCount"),
    supplementalCandidateCount: sumBy(results, "supplementalCandidateCount")
  };
}

function inspectResultQuality(query, result) {
  const queryContext = buildQueryContext(query);
  const sourceTextByRef = buildSourceTextByRef(result);
  const qualityIssues = [];
  let pathMismatchCount = 0;
  let unsupportedPathCount = 0;
  let templatePathCount = 0;

  const paths = Array.isArray(result.paths) ? result.paths : [];
  if (paths.length > 0) {
    unsupportedPathCount += paths.length;
    qualityIssues.push(`pathLeak: public result exposed ${paths.length} paths`);
  }
  for (const path of paths) {
    const titleText = [path?.title, path?.displayLabel].filter(Boolean).join(" ");
    const fullPathText = [path?.title, path?.summary, path?.displayLabel].filter(Boolean).join(" ");
    const sourceText = Array.isArray(path?.sourceRefs)
      ? path.sourceRefs.map((sourceRef) => sourceTextByRef.get(sourceRef) || "").join("\n")
      : "";
    const titleMatchesQuery = queryContext.titleTerms.some((term) => titleText.includes(term));
    const sourceSupportsPath = queryContext.sourceTerms.some((term) => sourceText.includes(term));

    if (!titleMatchesQuery) {
      pathMismatchCount += 1;
      qualityIssues.push(`pathMismatch: ${path?.title || path?.id || "unknown path"}`);
    }

    if (!sourceSupportsPath || !Array.isArray(path?.sourceRefs) || path.sourceRefs.length === 0) {
      unsupportedPathCount += 1;
      qualityIssues.push(`unsupportedPath: ${path?.title || path?.id || "unknown path"}`);
    }

    if (TEMPLATE_PATH_FRAGMENTS.some((fragment) => fullPathText.includes(fragment))) {
      templatePathCount += 1;
      qualityIssues.push(`templatePath: ${path?.title || path?.id || "unknown path"}`);
    }
  }

  const people = Array.isArray(result.people) ? result.people : [];
  let weakCandidateCount = 0;
  let opinionAsExperienceCount = 0;
  let marketingSuspectCount = 0;
  let nonExperienceFeedCount = 0;
  for (const person of people) {
    const article = Array.isArray(person?.articles) ? person.articles[0] : undefined;
    const sourceRefs = Array.isArray(person?.sourceRefs) ? person.sourceRefs : [];
    const sourceText = [
      person?.name,
      person?.oneLine,
      article?.title,
      article?.summary,
      article?.text,
      sourceRefs.map((sourceRef) => sourceTextByRef.get(sourceRef) || "").join("\n")
    ].filter(Boolean).join("\n");
    const sourceSupportsCandidate = queryContext.sourceTerms.some((term) => sourceText.includes(term));
    const matchScore = Number(person?.match?.score ?? 0);
    const guideLike = GUIDE_MARKERS.some((marker) => sourceText.includes(marker));
    const marketingLike =
      MARKETING_MARKERS.some((marker) => sourceText.includes(marker)) ||
      /带过[几数百千\d]+人|培训辅导|付费咨询|预约咨询/.test(sourceText);
    const firstPersonLike = /我|本人|我的|我们|当时|后来|决定|选择|结果|后悔/.test(sourceText);

    if (person?.sampleType !== "experience_sample") {
      nonExperienceFeedCount += 1;
      qualityIssues.push(`nonExperienceInFeed: ${article?.title || person?.id || "unknown person"}`);
    }

    if (!sourceSupportsCandidate || matchScore < 0.48) {
      weakCandidateCount += 1;
      qualityIssues.push(`weakCandidate: ${article?.title || person?.id || "unknown person"}`);
    }

    if (person?.sampleType === "experience_sample" && guideLike && !firstPersonLike) {
      opinionAsExperienceCount += 1;
      qualityIssues.push(`opinionAsExperience: ${article?.title || person?.id || "unknown person"}`);
    }

    if (marketingLike) {
      marketingSuspectCount += 1;
      qualityIssues.push(`marketingSuspect: ${article?.title || person?.id || "unknown person"}`);
    }
  }

  return {
    pathMismatchCount,
    weakCandidateCount,
    opinionAsExperienceCount,
    marketingSuspectCount,
    peopleIssueCount:
      weakCandidateCount + opinionAsExperienceCount + marketingSuspectCount + nonExperienceFeedCount,
    unsupportedPathCount,
    templatePathCount,
    qualityIssues
  };
}

function buildQueryContext(query) {
  const normalized = String(query || "").replace(/\s+/g, " ").trim();
  if (/异地恋|长期异地|远距离恋爱/.test(normalized) && /工作|职业|事业|想做的事|追求/.test(normalized)) {
    return {
      titleTerms: ["工作与长期异地恋", "长期异地恋", "异地恋"],
      sourceTerms: ["异地恋", "长期异地", "工作", "职业", "事业", "见面", "团聚", "城市", "距离", "恋爱"]
    };
  }
  if (/异地恋|长期异地|远距离恋爱/.test(normalized)) {
    return {
      titleTerms: ["长期异地恋", "异地恋"],
      sourceTerms: ["异地恋", "长期异地", "恋爱", "伴侣", "见面", "距离", "团聚", "城市"]
    };
  }
  if (/转行|转岗|换行业|转产品/.test(normalized) && /产品经理|产品岗|pm/i.test(normalized)) {
    return {
      titleTerms: ["转行做产品经理", "产品经理", "转行"],
      sourceTerms: ["转行", "转岗", "产品经理", "产品岗", "PM", "pm", "门槛", "能力", "项目", "岗位"]
    };
  }
  if (/大城市|一线城市|城市/.test(normalized) && /回老家|老家|家乡|回家/.test(normalized)) {
    return {
      titleTerms: ["大城市还是回老家", "大城市", "回老家", "老家"],
      sourceTerms: ["毕业", "大城市", "一线城市", "城市", "回老家", "老家", "家乡", "机会", "成本"]
    };
  }
  if (/裸辞/.test(normalized)) {
    return {
      titleTerms: ["裸辞之后", "裸辞"],
      sourceTerms: ["裸辞", "辞职", "离职", "后来", "后悔", "现金流", "节奏", "空窗"]
    };
  }
  if (/不工作|不上班|待业|失业/.test(normalized)) {
    return {
      titleTerms: ["不工作", "不上班"],
      sourceTerms: ["不工作", "不上班", "待业", "失业", "工作", "生活", "现金流", "预算", "副业"]
    };
  }
  if (/三十岁|30岁/.test(normalized)) {
    return {
      titleTerms: ["三十岁重新开始", "三十岁", "30岁"],
      sourceTerms: ["三十岁", "30岁", "重新开始", "年龄", "试错", "学习", "收入"]
    };
  }
  if (/稳定|安稳|体制内|铁饭碗/.test(normalized) && /喜欢|热爱|兴趣|梦想|想做的事|追求/.test(normalized)) {
    return {
      titleTerms: ["稳定和喜欢的事", "稳定", "喜欢的事"],
      sourceTerms: ["稳定", "稳定工作", "喜欢的事", "热爱", "兴趣", "梦想", "放弃", "取舍"]
    };
  }

  const terms = normalized.split(/[，。！？、,.!?\s/|:：；;（）()《》"“”]+/).filter((item) => item.length >= 2);
  return {
    titleTerms: terms.slice(0, 3),
    sourceTerms: terms.slice(0, 8)
  };
}

function buildSourceTextByRef(result) {
  const sourceTextByRef = new Map();
  const meta = result?.meta && typeof result.meta === "object" ? result.meta : {};
  const sourceRefs = Array.isArray(meta.sourceRefs) ? meta.sourceRefs : [];
  for (const sourceRef of sourceRefs) {
    sourceTextByRef.set(sourceRef.id, [sourceRef.title, sourceRef.author].filter(Boolean).join("\n"));
  }

  const debugCandidates = Array.isArray(result?.debug?.search?.candidates)
    ? result.debug.search.candidates
    : [];
  for (const sourceRef of sourceRefs) {
    const matchedCandidate = debugCandidates.find((candidate) =>
      candidate?.title && sourceRef.title && candidate.title === sourceRef.title
    );
    if (!matchedCandidate) {
      continue;
    }

    sourceTextByRef.set(sourceRef.id, [
      sourceTextByRef.get(sourceRef.id) || "",
      matchedCandidate.snippet,
      matchedCandidate.text
    ].filter(Boolean).join("\n"));
  }

  const people = Array.isArray(result?.people) ? result.people : [];
  for (const person of people) {
    const articles = Array.isArray(person?.articles) ? person.articles : [];
    for (const article of articles) {
      const text = [
        article?.title,
        article?.summary,
        article?.text,
        article?.evidenceText,
        Array.isArray(article?.evidence) ? article.evidence.map((item) => item.text).join("\n") : ""
      ].filter(Boolean).join("\n");
      const refs = Array.isArray(article?.sourceRefs) && article.sourceRefs.length
        ? article.sourceRefs
        : Array.isArray(person?.sourceRefs)
          ? person.sourceRefs
          : [];
      for (const ref of refs) {
        sourceTextByRef.set(ref, [sourceTextByRef.get(ref) || "", text].filter(Boolean).join("\n"));
      }
    }
  }

  return sourceTextByRef;
}

function sumBy(items, key) {
  return items.reduce((total, item) => total + Number(item[key] || 0), 0);
}

function countValues(values) {
  return values.reduce((counts, value) => {
    counts[value] = (counts[value] || 0) + 1;
    return counts;
  }, {});
}

function formatDistribution(distribution) {
  const entries = Object.entries(distribution || {});
  if (!entries.length) {
    return "-";
  }
  return entries.map(([key, value]) => `${key}:${value}`).join(", ");
}

function buildMarkdownReport(report, outputPath, reviewPath) {
  const provider = report.providerModel;
  const lines = [];
  lines.push("# Agent Task Real Eval");
  lines.push("");
  lines.push(`output: ${outputPath}`);
  lines.push(`review: ${reviewPath}`);
  lines.push(
    `provider/model: evidence=${provider.evidence_extract.provider}/${provider.evidence_extract.model}, summary=${provider.experience_summary.provider}/${provider.experience_summary.model}`
  );
  lines.push(
    `timeouts: evidence=${report.timeoutMs.evidence_extract}ms, summary=${report.timeoutMs.experience_summary}ms`
  );
  lines.push(
    `summary: partialDisplayable=${report.summary.partialDisplayable}/${report.summary.total}, candidateSelectFailed=${report.summary.candidateSelectFailed}, evidenceSucceeded=${report.summary.evidenceSucceeded}/${report.summary.total}, summarySucceeded=${report.summary.summarySucceeded}/${report.summary.total}, timedOut=${report.summary.timedOut}, degraded=${report.summary.degraded}, demoFallback=${report.summary.demoFallback}, http500=${report.summary.http500}`
  );
  lines.push(
    `quality: pathMismatch=${report.summary.pathMismatchCount}, weakCandidate=${report.summary.weakCandidateCount}, opinionAsExperience=${report.summary.opinionAsExperienceCount}, marketingSuspect=${report.summary.marketingSuspectCount}, peopleIssue=${report.summary.peopleIssueCount}, unsupportedPath=${report.summary.unsupportedPathCount}, templatePath=${report.summary.templatePathCount}`
  );
  lines.push(
    `supplementalSearch: triggered=${report.summary.supplementalTriggered}/${report.summary.total}, queries=${report.summary.supplementalQueryCount}, candidates=${report.summary.supplementalCandidateCount}`
  );
  lines.push("");
  lines.push("| Query | partial | final | candidate_select | evidence | evidence ms | summary | summary ms | feed | paths | people |补搜| mismatch | weak | opinionAsExp | marketing | unsupported | template |");
  lines.push("|---|---:|---:|---|---|---:|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|");
  for (const item of report.results) {
    lines.push(
      `| ${escapeCell(item.query)} | ${formatMs(item.partialMs)} | ${formatMs(item.finalMs)} | ${item.candidateSelectStatus} | ${item.evidenceStatus} | ${formatMs(item.evidenceDurationMs)} | ${item.summaryStatus} | ${formatMs(item.summaryDurationMs)} | ${item.feedItems} | ${item.paths} | ${item.people} | ${item.supplementalTriggered ? `${item.supplementalQueryCount}/${item.supplementalCandidateCount}` : "-"} | ${item.pathMismatchCount} | ${item.weakCandidateCount} | ${item.opinionAsExperienceCount} | ${item.marketingSuspectCount} | ${item.unsupportedPathCount} | ${item.templatePathCount} |`
    );
  }
  lines.push("");
  lines.push("## People/Card Type Distribution");
  for (const item of report.results) {
    lines.push(`- ${item.query}: ${formatDistribution(item.peopleTypeDistribution)}`);
  }
  lines.push("");
  lines.push("## Path Type Distribution");
  for (const item of report.results) {
    lines.push(`- ${item.query}: ${formatDistribution(item.pathTypeDistribution)}`);
  }
  lines.push("");
  lines.push("## Supplemental Queries");
  for (const item of report.results) {
    if (!item.supplementalQueries.length) {
      continue;
    }
    lines.push(`- ${item.query}`);
    for (const queryPlan of item.supplementalQueries.slice(0, 3)) {
      lines.push(`  - ${queryPlan.query}: ${queryPlan.purpose || ""}`);
    }
  }
  lines.push("");
  lines.push("## Quality Issues");
  for (const item of report.results) {
    if (!item.qualityIssues.length) {
      continue;
    }
    lines.push(`- ${item.query}`);
    for (const issue of item.qualityIssues.slice(0, 8)) {
      lines.push(`  - ${issue}`);
    }
  }
  lines.push("");

  return `${lines.join("\n")}\n`;
}

function printMarkdownReport(markdownReport) {
  console.log(`\n${markdownReport.trim()}`);
}

function formatCompactRow(item) {
  return [
    "REAL_EVAL_ROW",
    JSON.stringify(item.query),
    `partial=${formatMs(item.partialMs)}`,
    `final=${formatMs(item.finalMs)}`,
    `candidate=${item.candidateSelectStatus}`,
    `evidence=${item.evidenceStatus}/${formatMs(item.evidenceDurationMs)}`,
    `summary=${item.summaryStatus}/${formatMs(item.summaryDurationMs)}`,
    `samples=${item.evidenceSamples}`,
    `summaries=${item.experienceSummaries}`,
    `feed=${item.feedItems}`,
    `paths=${item.paths}`,
    `mismatch=${item.pathMismatchCount}`,
    `weak=${item.weakCandidateCount}`,
    `opinionAsExp=${item.opinionAsExperienceCount}`,
    `marketing=${item.marketingSuspectCount}`,
    `unsupported=${item.unsupportedPathCount}`,
    `template=${item.templatePathCount}`,
    `supplemental=${item.supplementalTriggered ? `${item.supplementalQueryCount}/${item.supplementalCandidateCount}` : "0/0"}`,
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
