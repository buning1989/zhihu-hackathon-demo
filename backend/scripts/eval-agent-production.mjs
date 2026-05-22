import dotenv from "dotenv";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const backendDir = resolve(scriptDir, "..");
const rootDir = resolve(backendDir, "..");

dotenv.config({ path: resolve(rootDir, ".env.local"), override: false });
dotenv.config({ path: resolve(backendDir, ".env.local"), override: false });

const apiBaseUrl = normalizeApiBaseUrl(
  process.env.AGENT_API_BASE_URL || process.env.BACKEND_URL || "http://127.0.0.1:8000"
);
const timeoutMs = readPositiveInteger(process.env.EVAL_AGENT_PRODUCTION_TIMEOUT_MS, 120000);
const pollDelayMs = readPositiveInteger(process.env.EVAL_AGENT_PRODUCTION_POLL_MS, 500);
const EVAL_QUERIES = [
  { category: "职业与工作", query: "我要不要裸辞？" },
  { category: "职业与工作", query: "工作很痛苦但工资不错，要不要离职？" },
  { category: "职业与工作", query: "要不要从大厂去创业公司？" },
  { category: "职业与工作", query: "工作三年没有成长，要不要转行？" },
  { category: "职业与工作", query: "刚毕业第一份工作不喜欢要不要换？" },
  { category: "学业与成长", query: "考研失败后该怎么办？" },
  { category: "学业与成长", query: "要不要二战考研？" },
  { category: "学业与成长", query: "大学专业不喜欢要不要转专业？" },
  { category: "学业与成长", query: "毕业后还要不要继续读书？" },
  { category: "学业与成长", query: "自学很难坚持怎么办？" },
  { category: "亲密关系", query: "异地恋到底值不值得坚持？" },
  { category: "亲密关系", query: "恋爱很累但舍不得分手怎么办？" },
  { category: "亲密关系", query: "发现对方不适合结婚要不要分手？" },
  { category: "亲密关系", query: "长期单身会不会越来越难恋爱？" },
  { category: "亲密关系", query: "和伴侣价值观不同还能继续吗？" },
  { category: "城市与生活选择", query: "要不要从大城市回老家？" },
  { category: "城市与生活选择", query: "要不要离开北上广回老家？" },
  { category: "城市与生活选择", query: "在一线城市买不起房要不要离开？" },
  { category: "城市与生活选择", query: "小城市生活安稳但不甘心怎么办？" },
  { category: "城市与生活选择", query: "为了伴侣换城市值得吗？" },
  { category: "婚育与家庭", query: "不结婚以后会不会后悔？" },
  { category: "婚育与家庭", query: "要不要为了父母催婚而结婚？" },
  { category: "婚育与家庭", query: "到底要不要生孩子？" },
  { category: "婚育与家庭", query: "和父母观念冲突要不要搬出去？" },
  { category: "婚育与家庭", query: "结婚前发现家庭条件差距大怎么办？" },
  { category: "自我状态与人生低谷", query: "人生低谷期该怎么熬过去？" },
  { category: "自我状态与人生低谷", query: "对什么都提不起兴趣怎么办？" },
  { category: "自我状态与人生低谷", query: "觉得自己很失败怎么办？" },
  { category: "自我状态与人生低谷", query: "三十岁一事无成还有机会吗？" },
  { category: "自我状态与人生低谷", query: "长期焦虑内耗该怎么办？" }
];
const queryLimit = readPositiveInteger(process.env.EVAL_AGENT_PRODUCTION_LIMIT, EVAL_QUERIES.length);
const failOnFailed = readBoolean(process.env.EVAL_AGENT_PRODUCTION_FAIL_ON_FAILED, false);
const freshRun = readBoolean(process.env.EVAL_AGENT_PRODUCTION_FRESH, false);
const evalRunId = process.env.EVAL_AGENT_PRODUCTION_RUN_ID || `eval_${Date.now().toString(36)}`;
const evalQueries = EVAL_QUERIES.slice(0, Math.min(queryLimit, EVAL_QUERIES.length));

const rows = [];
let exitCode = 0;

try {
  for (const [index, item] of evalQueries.entries()) {
    const startedAt = Date.now();
    const row = await runEvalQuery(item, index, startedAt);
    rows.push(row);
    console.log(JSON.stringify(row));
  }

  const summary = buildSummary(rows);
  console.log(JSON.stringify({ summary }));

  if (failOnFailed && summary.failedTaskList.length > 0) {
    exitCode = 1;
  }
} catch (error) {
  console.error("agent production eval failed");
  console.error(error);
  exitCode = 1;
}

if (exitCode) {
  process.exit(exitCode);
}

async function runEvalQuery(item, index, startedAt) {
  let started;
  try {
    started = await createTask(item.query, index);
  } catch (error) {
    return buildFailedCreateRow(item, error, Date.now() - startedAt);
  }

  let status;
  try {
    status = await waitForTerminalStatus(started.taskId, item.query);
  } catch (error) {
    return {
      ...buildBaseRow(item, started),
      status: "failed",
      errorCode: "EVAL_WAIT_FAILED",
      errorMessage: toErrorMessage(error),
      totalDurationMs: Date.now() - startedAt
    };
  }

  let debug = null;
  try {
    debug = await readTaskDebug(started.taskId);
  } catch (error) {
    if (status.status === "failed") {
      return {
        ...buildBaseRow(item, started),
        status: "failed",
        errorCode: "EVAL_DEBUG_FAILED",
        errorMessage: toErrorMessage(error),
        totalDurationMs: Date.now() - startedAt
      };
    }
  }

  return buildEvalRow({
    item,
    started,
    status,
    debug,
    requestDurationMs: Date.now() - startedAt
  });
}

async function createTask(query, index) {
  const response = await fetch(`${apiBaseUrl}/api/agent/tasks`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      query,
      metadata: {
        source: freshRun ? `agent_production_eval_${evalRunId}` : "agent_production_eval",
        createdBy: "backend/scripts/eval-agent-production.mjs",
        ...(freshRun ? { evalRunId } : {}),
        anonymousId: freshRun
          ? `agent_production_eval_${evalRunId}_${index + 1}`
          : `agent_production_eval_${index + 1}`
      }
    })
  });
  const body = await readJsonResponse(response);

  if (!response.ok || !body?.success) {
    const error = new Error(`POST /api/agent/tasks failed: ${response.status}`);
    error.status = response.status;
    error.body = body;
    throw error;
  }

  return body.data;
}

async function waitForTerminalStatus(taskId, query) {
  const startedAt = Date.now();
  let lastStatus;

  while (Date.now() - startedAt < timeoutMs) {
    const status = await getTaskStatus(taskId);
    lastStatus = status;

    if (status.status === "succeeded" || status.status === "failed") {
      return status;
    }

    await delay(status.pollAfterMs > 0 ? Math.min(status.pollAfterMs, pollDelayMs) : pollDelayMs);
  }

  throw new Error(`${query}: timed out waiting for terminal status; last=${lastStatus?.status ?? "missing"}`);
}

async function getTaskStatus(taskId) {
  const response = await fetch(`${apiBaseUrl}/api/agent/tasks/${encodeURIComponent(taskId)}`);
  const body = await readJsonResponse(response);
  if (!response.ok || !body?.success) {
    throw new Error(`GET /api/agent/tasks/${taskId} failed: ${response.status} ${JSON.stringify(body)}`);
  }

  return body.data;
}

async function readTaskDebug(taskId) {
  const response = await fetch(`${apiBaseUrl}/api/agent/tasks/${encodeURIComponent(taskId)}/debug`);
  const body = await readJsonResponse(response);
  if (!response.ok || !body?.success) {
    throw new Error(`GET /api/agent/tasks/${taskId}/debug failed: ${response.status} ${JSON.stringify(body)}`);
  }

  return body.data;
}

function buildEvalRow({ item, started, status, debug, requestDurationMs }) {
  const finalSummary = debug?.summaries?.productionFinalResult ?? {};
  const candidateSummary = debug?.summaries?.candidates ?? {};
  const rawSourcesSummary = debug?.summaries?.rawSources ?? {};
  const evidenceSummary = debug?.summaries?.evidence ?? {};

  return {
    category: item.category,
    query: item.query,
    taskId: started.taskId,
    status: status.status,
    sourceCount: readNumber(rawSourcesSummary.sourceCount, 0),
    selectedForEvidenceCount: readNumber(candidateSummary.selectedForEvidenceCount, 0),
    evidenceCount: readNumber(evidenceSummary.evidenceCount, 0),
    experienceEvidenceCount: readNumber(evidenceSummary.experienceEvidenceCount, 0),
    evidenceChunkCount: readNumber(evidenceSummary.chunkCount, 0),
    evidenceChunkSuccessCount: readNumber(evidenceSummary.chunkSuccessCount, 0),
    evidenceChunkFailureCount: readNumber(evidenceSummary.chunkFailureCount, 0),
    evidenceRepairCount: readNumber(evidenceSummary.repairCount, 0),
    evidenceRetryCount: readNumber(evidenceSummary.retryCount, 0),
    evidenceChunkFailureReasons: Array.isArray(evidenceSummary.chunkFailureReasons)
      ? evidenceSummary.chunkFailureReasons
      : [],
    pathCount: readNumber(finalSummary.pathCount, 0),
    personaCount: readNumber(finalSummary.personaCount, 0),
    degraded: readBooleanValue(finalSummary.degraded),
    degradedReason: readNullableString(finalSummary.degradedReason),
    deterministicValidator: readNullableString(finalSummary.deterministicValidatorStatus),
    llmGuardStatus: readNullableString(finalSummary.llmGuardStatus),
    groundingWarningCount: readNumber(finalSummary.groundingWarningCount, 0),
    groundingRemovedItemCount: readNumber(finalSummary.groundingRemovedItemCount, 0),
    deterministicRemovedPathCount: readNumber(finalSummary.deterministicRemovedPathCount, 0),
    deterministicRemovedPersonaCount: readNumber(finalSummary.deterministicRemovedPersonaCount, 0),
    lowQualityCandidateIdsCount: readNumber(finalSummary.lowQualityCandidateCount, 0),
    lowConfidenceEvidenceIdsCount: readNumber(finalSummary.lowConfidenceEvidenceCount, 0),
    personaWithoutExperienceEvidenceIdsCount: readNumber(
      finalSummary.personaWithoutExperienceEvidenceCount,
      0
    ),
    pathWithoutEvidenceIdsCount: readNumber(finalSummary.pathWithoutEvidenceCount, 0),
    cacheHit: Boolean(started.cacheHit),
    reused: Boolean(started.reused),
    stageCacheHitCount: readNumber(debug?.cache?.cacheHitEventCount, 0),
    reusedEventCount: readNumber(debug?.cache?.reusedEventCount, 0),
    totalDurationMs: readNumber(debug?.totalDurationMs, requestDurationMs),
    failedStage: debug?.failedStage ?? null,
    errorCode: status.error?.errorCode ?? debug?.errorCode ?? null,
    errorMessage: status.error?.errorMessage ?? debug?.errorMessage ?? null,
    recentEventTypes: Array.isArray(debug?.events?.items)
      ? debug.events.items.slice(-5).map((event) => event.type)
      : []
  };
}

function buildBaseRow(item, started) {
  return {
    category: item.category,
    query: item.query,
    taskId: started?.taskId ?? null,
    cacheHit: Boolean(started?.cacheHit),
    reused: Boolean(started?.reused)
  };
}

function buildFailedCreateRow(item, error, totalDurationMs) {
  const body = error.body;
  return {
    category: item.category,
    query: item.query,
    taskId: null,
    status: "failed",
    sourceCount: 0,
    selectedForEvidenceCount: 0,
    evidenceCount: 0,
    experienceEvidenceCount: 0,
    evidenceChunkCount: 0,
    evidenceChunkSuccessCount: 0,
    evidenceChunkFailureCount: 0,
    evidenceRepairCount: 0,
    evidenceRetryCount: 0,
    evidenceChunkFailureReasons: [],
    pathCount: 0,
    personaCount: 0,
    degraded: false,
    degradedReason: null,
    deterministicValidator: null,
    lowQualityCandidateIdsCount: 0,
    lowConfidenceEvidenceIdsCount: 0,
    personaWithoutExperienceEvidenceIdsCount: 0,
    pathWithoutEvidenceIdsCount: 0,
    cacheHit: false,
    reused: false,
    stageCacheHitCount: 0,
    reusedEventCount: 0,
    totalDurationMs,
    failedStage: "create_task",
    errorCode: body?.error?.code ?? "EVAL_CREATE_FAILED",
    errorMessage: body?.error?.message ?? toErrorMessage(error),
    recentEventTypes: []
  };
}

function buildSummary(resultRows) {
  const total = resultRows.length;
  const succeededRows = resultRows.filter((row) => row.status === "succeeded");
  const rowsWithValidator = resultRows.filter((row) => row.deterministicValidator);
  const failedRows = resultRows.filter((row) => row.status !== "succeeded");
  const badRefsCount = resultRows.reduce(
    (sum, row) =>
      sum +
      row.lowQualityCandidateIdsCount +
      row.lowConfidenceEvidenceIdsCount +
      row.personaWithoutExperienceEvidenceIdsCount +
      row.pathWithoutEvidenceIdsCount,
    0
  );
  const degradedReasonCounts = countReasons(resultRows.flatMap((row) => splitReasons(row.degradedReason)));
  const deterministicValidatorCounts = countReasons(
    resultRows.map((row) => row.deterministicValidator).filter(Boolean)
  );
  const llmGuardStatusCounts = countReasons(resultRows.map((row) => row.llmGuardStatus).filter(Boolean));
  const evidenceChunkFailureReasonCounts = countReasons(
    resultRows.flatMap((row) => row.evidenceChunkFailureReasons ?? [])
  );

  return {
    total,
    successCount: succeededRows.length,
    successRate: ratio(succeededRows.length, total),
    avgDurationMs: average(resultRows.map((row) => row.totalDurationMs)),
    avgSelectedForEvidence: average(resultRows.map((row) => row.selectedForEvidenceCount)),
    avgEvidence: average(resultRows.map((row) => row.evidenceCount)),
    avgEvidenceChunkFailures: average(resultRows.map((row) => row.evidenceChunkFailureCount)),
    evidenceRepairCount: resultRows.reduce((sum, row) => sum + row.evidenceRepairCount, 0),
    evidenceRetryCount: resultRows.reduce((sum, row) => sum + row.evidenceRetryCount, 0),
    avgPaths: average(resultRows.map((row) => row.pathCount)),
    avgPersonas: average(resultRows.map((row) => row.personaCount)),
    degradedRate: ratio(resultRows.filter((row) => row.degraded).length, total),
    groundingPassedRate: ratio(
      rowsWithValidator.filter((row) => row.deterministicValidator === "passed").length,
      rowsWithValidator.length
    ),
    badRefsCount,
    cacheHitCount: resultRows.filter((row) => row.cacheHit).length,
    reusedCount: resultRows.filter((row) => row.reused).length,
    stageCacheHitCount: resultRows.reduce((sum, row) => sum + row.stageCacheHitCount, 0),
    degradedReasonCounts,
    deterministicValidatorCounts,
    llmGuardStatusCounts,
    evidenceChunkFailureReasonCounts,
    failedTaskList: failedRows.map((row) => ({
      category: row.category,
      query: row.query,
      taskId: row.taskId,
      status: row.status,
      failedStage: row.failedStage,
      errorCode: row.errorCode,
      errorMessage: row.errorMessage,
      cacheHit: row.cacheHit,
      reused: row.reused,
      recentEventTypes: row.recentEventTypes
    }))
  };
}

function average(values) {
  const finiteValues = values.filter(Number.isFinite);
  if (finiteValues.length === 0) {
    return null;
  }

  return roundNumber(finiteValues.reduce((sum, value) => sum + value, 0) / finiteValues.length);
}

function ratio(count, total) {
  if (!total) {
    return null;
  }

  return roundNumber(count / total);
}

function splitReasons(value) {
  if (!value) {
    return [];
  }

  return String(value)
    .split(";")
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => {
      if (item.includes("JSON parse failed")) {
        return "evidence_json_parse_failed";
      }
      if (item.includes("grounding_guard_repaired")) {
        return "grounding_guard_repaired";
      }
      if (item.includes("deterministic_validator_repaired")) {
        return "deterministic_validator_repaired";
      }
      if (item.includes("deterministic_validator_failed")) {
        return "deterministic_validator_failed";
      }
      return item;
    });
}

function countReasons(values) {
  return values.reduce((result, value) => {
    result[value] = (result[value] ?? 0) + 1;
    return result;
  }, {});
}

function roundNumber(value) {
  return Math.round(value * 1000) / 1000;
}

function readNumber(value, fallback) {
  return Number.isFinite(value) ? value : fallback;
}

function readNullableString(value) {
  return typeof value === "string" && value.trim() ? value : null;
}

function readBooleanValue(value) {
  return typeof value === "boolean" ? value : false;
}

function readBoolean(value, fallback) {
  if (value === undefined) {
    return fallback;
  }

  return ["1", "true", "yes", "on"].includes(String(value).trim().toLowerCase());
}

function readPositiveInteger(value, fallback) {
  if (!value) {
    return fallback;
  }

  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function normalizeApiBaseUrl(value) {
  return String(value || "").trim().replace(/\/+$/, "");
}

function toErrorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function delay(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function readJsonResponse(response) {
  const text = await response.text();
  return text ? JSON.parse(text) : undefined;
}
