import dotenv from "dotenv";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const backendDir = resolve(scriptDir, "..");
const rootDir = resolve(backendDir, "..");

dotenv.config({ path: resolve(rootDir, ".env.local"), override: false });
dotenv.config({ path: resolve(backendDir, ".env.local"), override: false });

const apiBaseUrl = normalizeApiBaseUrl(process.env.AGENT_API_BASE_URL || process.env.BACKEND_URL || "http://127.0.0.1:8000");
const timeoutMs = readPositiveInteger(process.env.SMOKE_AGENT_PRODUCTION_TIMEOUT_MS, 60000);
const pollDelayMs = readPositiveInteger(process.env.SMOKE_AGENT_PRODUCTION_POLL_MS, 500);
const expectRateLimit = readBoolean(
  process.env.SMOKE_AGENT_EXPECT_RATE_LIMIT ?? process.env.AGENT_RATE_LIMIT_ENABLED,
  false
);
const minCandidateQualityScore = 0.45;
const minEvidenceConfidence = 0.35;
const queries = [
  "我要不要裸辞？",
  "异地恋到底值不值得坚持？",
  "考研失败后该怎么办？",
  "要不要从大城市回老家？",
  "不结婚以后会不会后悔？"
];

let exitCode = 0;
try {
  const startedByQuery = new Map();
  for (const [index, query] of queries.entries()) {
    const anonymousId = `agent_production_smoke_${index + 1}`;
    const started = await createTask(query, {
      anonymousId
    });
    startedByQuery.set(query, { ...started, anonymousId });
    const status = await waitForTerminalStatus(started.taskId, query);

    if (status.status === "failed") {
      assert(status.error?.errorCode, `${query}: failed task missing errorCode`);
      assert(status.error?.errorMessage, `${query}: failed task missing errorMessage`);
      throw new Error(`${query}: task failed ${status.error.errorCode}: ${status.error.errorMessage}`);
    }

    assert(status.status === "succeeded", `${query}: task did not succeed`);
    assert(status.resultAvailable === true, `${query}: resultAvailable was not true`);
    const result = await readTaskResult(started.resultUrl || `/api/agent/tasks/${encodeURIComponent(started.taskId)}/result`);
    assertProductionFinalResult(result.final_result, query);
    await assertTaskDebug(started.taskId, query);
    console.log(`agent production smoke ok: ${query} taskId=${started.taskId}`);
  }

  await assertSucceededTaskReuse(queries[0], startedByQuery.get(queries[0]));
  await assertClarifyRefineFlow();
  await assertRunningTaskReuseAndRateLimit();
  console.log("agent production smoke ok");
} catch (error) {
  console.error("agent production smoke failed");
  console.error(error);
  exitCode = 1;
}

if (exitCode) {
  process.exit(exitCode);
}

async function createTask(query, options = {}) {
  const response = await fetch(`${apiBaseUrl}/api/agent/tasks`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      query,
      metadata: {
        source: "agent_production_smoke",
        createdBy: "backend/scripts/smoke-agent-production.mjs",
        ...(options.metadata ?? {}),
        ...(options.anonymousId ? { anonymousId: options.anonymousId } : {})
      }
    })
  });
  const body = await readJsonResponse(response);

  if (!response.ok || !body?.success) {
    const errorCode = body?.error?.code;
    if (errorCode === "AGENT_DATABASE_UNCONFIGURED") {
      throw new Error(
        "POST /api/agent/tasks failed: DATABASE_URL is not configured. Start the compose stack or set DATABASE_URL for the backend and worker."
      );
    }

    if (errorCode === "AGENT_QUEUE_UNCONFIGURED") {
      throw new Error(
        "POST /api/agent/tasks failed: REDIS_URL is not configured. Start the compose stack or set REDIS_URL for the backend and worker."
      );
    }

    throw new Error(`POST /api/agent/tasks failed for ${query}: ${response.status} ${JSON.stringify(body)}`);
  }

  assert(typeof body.data?.taskId === "string" && body.data.taskId, `${query}: taskId missing`);
  const allowedStatuses = options.expectNeedInput
    ? ["need_input"]
    : ["queued", "running", "succeeded"];
  assert(allowedStatuses.includes(body.data.status), `${query}: create status invalid`);
  assert(typeof body.data.frontendStatus === "string" && body.data.frontendStatus, `${query}: frontendStatus missing`);
  assert(Number.isFinite(body.data.pollAfterMs), `${query}: pollAfterMs missing`);
  assert(typeof body.data.resultUrl === "string" && body.data.resultUrl, `${query}: resultUrl missing`);

  return body.data;
}

async function refineTask(taskId, body) {
  const response = await fetch(`${apiBaseUrl}/api/agent/tasks/${encodeURIComponent(taskId)}/refine`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body)
  });
  const responseBody = await readJsonResponse(response);
  if (!response.ok || !responseBody?.success) {
    throw new Error(`POST /api/agent/tasks/${taskId}/refine failed: ${response.status} ${JSON.stringify(responseBody)}`);
  }

  assert(typeof responseBody.data?.taskId === "string" && responseBody.data.taskId, "refine: taskId missing");
  assert(responseBody.data.taskId !== taskId, "refine: reused original taskId");
  assert(["queued", "running", "succeeded"].includes(responseBody.data.status), "refine: status invalid");
  assert(responseBody.data.refinedFromTaskId === taskId, "refine: refinedFromTaskId missing");
  return responseBody.data;
}

async function assertClarifyRefineFlow() {
  const suffix = Date.now().toString(36);
  const anonymousId = `agent_phase5_clarify_${suffix}`;
  const vagueQuery = "我要不要离职？";
  const needInputStarted = await createTask(vagueQuery, {
    anonymousId,
    expectNeedInput: true,
    metadata: {
      phase: "phase5_clarify"
    }
  });

  assert(needInputStarted.queueStatus === "need_input", "clarify: queueStatus should be need_input");
  assert(isNeedInputPayload(needInputStarted.needInput), "clarify: create response needInput missing");
  assertNeedInputPayload(needInputStarted.needInput, "clarify create");

  const needInputStatus = await getTaskStatus(needInputStarted.taskId);
  assert(needInputStatus.status === "need_input", "clarify: status endpoint did not return need_input");
  assert(needInputStatus.pollAfterMs === 0, "clarify: need_input should not ask polling");
  assertNeedInputPayload(needInputStatus.needInput, "clarify status");

  const needInputDebug = await readTaskDebug(needInputStarted.taskId);
  const originalCacheKey = needInputDebug.cache?.queryCacheKey;
  assert(typeof originalCacheKey === "string" && originalCacheKey, "clarify: original cache key missing");

  const sensitiveFreeText = "我不想在 debug 里暴露这段补充文本";
  const refined = await refineTask(needInputStarted.taskId, {
    answers: {
      currentSituation: "工作痛苦",
      timeline: "1 个月内",
      riskTolerance: "不能失去稳定收入",
      additionalContext: sensitiveFreeText
    },
    refineQuery: "我更关心不辞职怎么调整",
    metadata: {
      anonymousId,
      source: "agent_production_smoke",
      phase: "phase5_refine"
    }
  });
  const refinedStatus = await waitForTerminalStatus(refined.taskId, "phase5 refined task");
  assert(refinedStatus.status === "succeeded", "refine: refined task did not succeed");
  assert(refinedStatus.resultAvailable === true, "refine: resultAvailable was not true");
  const result = await readTaskResult(refined.resultUrl || `/api/agent/tasks/${encodeURIComponent(refined.taskId)}/result`);
  assertProductionFinalResult(result.final_result, "phase5 refined task");

  const refinedDebug = await readTaskDebug(refined.taskId);
  const refinedCacheKey = refinedDebug.cache?.queryCacheKey;
  assert(typeof refinedCacheKey === "string" && refinedCacheKey, "refine: refined cache key missing");
  assert(refinedCacheKey !== originalCacheKey, "refine: cache key should include refined context");
  assert(
    !JSON.stringify(refinedDebug).includes(sensitiveFreeText),
    "refine: debug leaked optional freeText"
  );
  console.log(`agent production clarify/refine smoke ok: parent=${needInputStarted.taskId} refined=${refined.taskId}`);
}

async function assertSucceededTaskReuse(query, originalTask) {
  assert(originalTask?.taskId, `${query}: original task missing for reuse check`);
  const reused = await createTask(query, {
    anonymousId: originalTask.anonymousId
  });

  assert(reused.taskId === originalTask.taskId, `${query}: succeeded cache did not reuse taskId`);
  assert(reused.cacheHit === true, `${query}: succeeded cacheHit was not true`);
  assert(reused.reused === true, `${query}: succeeded reused was not true`);
  assert(reused.queueStatus === "reused_succeeded", `${query}: succeeded queueStatus invalid`);

  const debug = await readTaskDebug(originalTask.taskId);
  assert(debug.cache?.reusedEventCount >= 1, `${query}: reused event missing from debug`);
}

async function assertRunningTaskReuseAndRateLimit() {
  const suffix = Date.now().toString(36);
  const anonymousId = `agent_phase3_limit_${suffix}`;
  const query = `Phase 3 running reuse ${suffix}`;
  const started = await createTask(query, { anonymousId });
  const reused = await createTask(query, { anonymousId });

  assert(reused.taskId === started.taskId, "running task reuse did not return existing taskId");
  assert(reused.reused === true, "running task reuse missing reused flag");
  assert(
    reused.queueStatus === "reused_running" || reused.queueStatus === "reused_succeeded",
    "running task reuse queueStatus invalid"
  );

  if (expectRateLimit) {
    await assertRateLimited(`${query} different`, anonymousId);
  } else {
    console.log("agent production rate limit smoke skipped: AGENT_RATE_LIMIT_ENABLED is not true");
  }

  const status = await waitForTerminalStatus(started.taskId, query);
  assert(status.status === "succeeded", "running reuse seed task did not succeed");
}

async function assertRateLimited(query, anonymousId) {
  const response = await fetch(`${apiBaseUrl}/api/agent/tasks`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      query,
      metadata: {
        source: "agent_production_smoke",
        createdBy: "backend/scripts/smoke-agent-production.mjs",
        anonymousId
      }
    })
  });
  const body = await readJsonResponse(response);
  assert(response.status === 429, `${query}: expected RATE_LIMITED status 429`);
  assert(body?.error?.code === "RATE_LIMITED", `${query}: expected RATE_LIMITED error code`);
}

async function waitForTerminalStatus(taskId, query) {
  const startedAt = Date.now();
  let lastStatus;

  while (Date.now() - startedAt < timeoutMs) {
    const status = await getTaskStatus(taskId);
    lastStatus = status;

    assert(status.taskId === taskId, `${query}: status taskId mismatch`);
    assert(typeof status.frontendStatus === "string", `${query}: status frontendStatus missing`);
    assert(Number.isFinite(status.progressPercent), `${query}: progressPercent missing`);
    assert(Array.isArray(status.stages), `${query}: stages missing`);
    assert(status.stages.length === 7, `${query}: expected 7 stages`);

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

async function readTaskResult(resultUrl) {
  const url = resultUrl.startsWith("http") ? resultUrl : `${apiBaseUrl}${resultUrl}`;
  const response = await fetch(url);
  const body = await readJsonResponse(response);
  if (!response.ok || !body?.success) {
    throw new Error(`GET ${url} failed: ${response.status} ${JSON.stringify(body)}`);
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

async function assertTaskDebug(taskId, label) {
  const debug = await readTaskDebug(taskId);
  assert(debug?.task?.id === taskId, `${label}: debug task id mismatch`);
  assert(Array.isArray(debug.stages), `${label}: debug stages missing`);
  assert(isRecord(debug.events), `${label}: debug events missing`);
  assert(isRecord(debug.artifacts), `${label}: debug artifacts missing`);
  assert(isRecord(debug.summaries), `${label}: debug summaries missing`);
  assert(isRecord(debug.summaries.rawSources), `${label}: debug raw_sources summary missing`);
  assert(isRecord(debug.summaries.candidates), `${label}: debug candidates summary missing`);
  assert(isRecord(debug.summaries.evidence), `${label}: debug evidence summary missing`);
  assert(isRecord(debug.summaries.productionFinalResult), `${label}: debug final summary missing`);
  assert(isRecord(debug.groundingReport), `${label}: debug groundingReport missing`);
  assert(Number.isFinite(debug.totalDurationMs), `${label}: debug totalDurationMs missing`);

  const metadataText = JSON.stringify(debug.task.metadata ?? {});
  assert(!hasSensitiveMetadataKey(debug.task.metadata ?? {}), `${label}: debug leaked sensitive metadata key`);
  assert(!/agent_production_smoke_[0-9]+/i.test(metadataText), `${label}: debug leaked raw anonymousId`);
}

function assertProductionFinalResult(finalResult, label) {
  assert(finalResult?.schemaVersion === "agent.production_final_result.v2", `${label}: final_result schemaVersion invalid`);
  assert(typeof finalResult.summary === "string", `${label}: summary missing`);
  assert(Array.isArray(finalResult.paths), `${label}: paths missing`);
  assert(Array.isArray(finalResult.sources), `${label}: sources missing`);
  assert(isRecord(finalResult.evidenceMap), `${label}: evidenceMap missing`);
  assert(Array.isArray(finalResult.evidenceSamples), `${label}: evidenceSamples missing`);
  assert(isRecord(finalResult.groundingReport), `${label}: groundingReport missing`);
  assert(typeof finalResult.degraded === "boolean", `${label}: degraded missing`);
  assert(finalResult.degradedReason === null || typeof finalResult.degradedReason === "string", `${label}: degradedReason invalid`);
  assert(finalResult.paths.length > 0 || finalResult.degraded === true, `${label}: no paths should be degraded`);
  assert(
    finalResult.evidenceSamples.length >= 4 || finalResult.degraded === true,
    `${label}: evidenceSamples below display floor should be degraded`
  );
  if (finalResult.degraded === true) {
    assert(typeof finalResult.degradedReason === "string" && finalResult.degradedReason, `${label}: degraded reason missing`);
  }

  assertDeterministicQualityReport(finalResult.groundingReport, label);
  const sourceById = new Map(finalResult.sources.map((source) => [source.sourceCandidateId, source]));
  for (const [index, source] of finalResult.sources.entries()) {
    assertProductionSource(source, `${label}: sources[${index}]`);
  }

  for (const [id, evidenceItem] of Object.entries(finalResult.evidenceMap)) {
    assertProductionEvidenceItem(id, evidenceItem, sourceById, `${label}: evidenceMap.${id}`);
  }

  for (const [index, path] of finalResult.paths.entries()) {
    assert(typeof path.title === "string" && path.title, `${label}: paths[${index}].title missing`);
    assert(typeof path.summary === "string" && path.summary, `${label}: paths[${index}].summary missing`);
    assert(typeof path.angle === "string" && path.angle, `${label}: paths[${index}].angle missing`);
    assertSourceRefs(path.sourceRefs, sourceById, finalResult.evidenceMap, `${label}: paths[${index}]`, {
      requireExperienceEvidence: false
    });
  }

  for (const [index, sample] of finalResult.evidenceSamples.entries()) {
    assertProductionEvidenceSample(sample, sourceById, finalResult.evidenceMap, `${label}: evidenceSamples[${index}]`);
  }

  const badSourceRefCount =
    finalResult.groundingReport.deterministicValidator?.qualityReport?.lowQualityCandidateIds?.length ??
    0;
  assert(badSourceRefCount === 0, `${label}: bad source refs or low quality candidates detected`);
  const invalidEvidenceSampleCount =
    finalResult.groundingReport.deterministicValidator?.qualityReport?.invalidEvidenceSampleIds?.length ??
    0;
  assert(invalidEvidenceSampleCount === 0, `${label}: invalid evidence samples detected`);
}

function assertProductionSource(source, label) {
  assert(typeof source.sourceCandidateId === "string" && source.sourceCandidateId, `${label}: sourceCandidateId missing`);
  assert(Number.isFinite(source.normalizedSearchScore), `${label}: normalizedSearchScore missing`);
  assert(Number.isFinite(source.relevanceScore), `${label}: relevanceScore missing`);
  assert(Number.isFinite(source.experienceScore), `${label}: experienceScore missing`);
  assert(Number.isFinite(source.qualityScore), `${label}: qualityScore missing`);
  assert(Array.isArray(source.qualitySignals), `${label}: qualitySignals missing`);
  assert(source.selectedForEvidence === true, `${label}: selectedForEvidence must be true`);
  assert(
    source.qualityScore >= minCandidateQualityScore,
    `${label}: qualityScore below threshold ${source.qualityScore}`
  );
}

function assertProductionEvidenceItem(id, evidenceItem, sourceById, label) {
  assert(evidenceItem.id === id, `${label}: id mismatch`);
  assert(sourceById.has(evidenceItem.sourceCandidateId), `${label}: sourceCandidateId missing`);
  assert(typeof evidenceItem.supportType === "string" && evidenceItem.supportType, `${label}: supportType missing`);
  assert(typeof evidenceItem.isExperienceEvidence === "boolean", `${label}: isExperienceEvidence missing`);
  assert(Number.isFinite(evidenceItem.confidence), `${label}: confidence missing`);
  assert(evidenceItem.confidence >= minEvidenceConfidence, `${label}: confidence below threshold`);
  assert(typeof evidenceItem.evidenceText === "string" && evidenceItem.evidenceText, `${label}: evidenceText missing`);
  assert(typeof evidenceItem.excerpt === "string" && evidenceItem.excerpt, `${label}: excerpt missing`);
  assert(typeof evidenceItem.reason === "string" && evidenceItem.reason, `${label}: reason missing`);
  assert(typeof evidenceItem.normalizedClaim === "string" && evidenceItem.normalizedClaim, `${label}: normalizedClaim missing`);
}

function assertProductionEvidenceSample(sample, sourceById, evidenceMap, label) {
  assert(typeof sample.id === "string" && sample.id, `${label}: id missing`);
  assert(sourceById.has(sample.sourceCandidateId), `${label}: sourceCandidateId missing`);
  const evidenceItem = evidenceMap[sample.evidenceItemId];
  assert(evidenceItem, `${label}: evidenceItemId missing`);
  assert(
    evidenceItem.sourceCandidateId === sample.sourceCandidateId,
    `${label}: evidenceItemId belongs to ${evidenceItem.sourceCandidateId}`
  );
  assert(typeof sample.snippet === "string" && sample.snippet, `${label}: snippet missing`);
  assert(typeof sample.whyRelevant === "string" && sample.whyRelevant, `${label}: whyRelevant missing`);
  assert(
    ["experience", "decision", "opinion", "context"].includes(sample.sampleType),
    `${label}: sampleType invalid`
  );
  assert(Number.isFinite(sample.confidence), `${label}: confidence missing`);
}

function assertSourceRefs(sourceRefs, sourceById, evidenceMap, label, options) {
  assert(Array.isArray(sourceRefs) && sourceRefs.length > 0, `${label}: sourceRefs missing`);

  let hasExperienceEvidence = false;
  for (const [index, sourceRef] of sourceRefs.entries()) {
    const source = sourceById.get(sourceRef.sourceCandidateId);
    assert(source, `${label}: sourceRefs[${index}].sourceCandidateId missing`);
    assert(source.qualityScore >= minCandidateQualityScore, `${label}: sourceRefs[${index}].candidate low quality`);
    assert(Array.isArray(sourceRef.evidenceItemIds) && sourceRef.evidenceItemIds.length > 0, `${label}: sourceRefs[${index}].evidenceItemIds missing`);

    for (const evidenceItemId of sourceRef.evidenceItemIds) {
      const evidenceItem = evidenceMap[evidenceItemId];
      assert(evidenceItem, `${label}: evidenceItem ${evidenceItemId} missing`);
      assert(
        evidenceItem.sourceCandidateId === sourceRef.sourceCandidateId,
        `${label}: evidenceItem ${evidenceItemId} belongs to ${evidenceItem.sourceCandidateId}`
      );
      assert(evidenceItem.confidence >= minEvidenceConfidence, `${label}: evidenceItem ${evidenceItemId} low confidence`);
      if (evidenceItem.isExperienceEvidence) {
        hasExperienceEvidence = true;
      }
    }
  }

  if (options.requireExperienceEvidence) {
    assert(hasExperienceEvidence, `${label}: persona missing experience evidence`);
  }
}

function assertDeterministicQualityReport(groundingReport, label) {
  const validator = groundingReport.deterministicValidator;
  assert(
    validator?.status === "passed" || validator?.status === "repaired" || validator?.status === "failed",
    `${label}: validator status invalid`
  );
  assert(Array.isArray(validator.removedPathIds), `${label}: removedPathIds missing`);
  assert(Array.isArray(validator.removedPersonaIds), `${label}: removedPersonaIds missing`);
  assert(Array.isArray(validator.warnings), `${label}: validator warnings missing`);
  const qualityReport = validator.qualityReport;
  assert(qualityReport?.checked === true, `${label}: deterministic quality report missing`);
  assert(Array.isArray(qualityReport.lowQualityCandidateIds), `${label}: lowQualityCandidateIds missing`);
  assert(Array.isArray(qualityReport.lowConfidenceEvidenceIds), `${label}: lowConfidenceEvidenceIds missing`);
  assert(Array.isArray(qualityReport.personaWithoutExperienceEvidenceIds), `${label}: personaWithoutExperienceEvidenceIds missing`);
  assert(Array.isArray(qualityReport.invalidEvidenceSampleIds), `${label}: invalidEvidenceSampleIds missing`);
  assert(qualityReport.lowQualityCandidateIds.length === 0, `${label}: final result contains low quality candidate`);
  assert(qualityReport.lowConfidenceEvidenceIds.length === 0, `${label}: final result contains low confidence evidence`);
  assert(qualityReport.invalidEvidenceSampleIds.length === 0, `${label}: final result contains invalid evidence sample`);
  assert(
    qualityReport.personaWithoutExperienceEvidenceIds.length === 0,
    `${label}: final result contains persona without experience evidence`
  );
}

function assertNeedInputPayload(needInput, label) {
  assert(isNeedInputPayload(needInput), `${label}: needInput missing`);
  assert(typeof needInput.reason === "string" && needInput.reason, `${label}: needInput reason missing`);
  assert(needInput.questions.length > 0 && needInput.questions.length <= 3, `${label}: question count invalid`);
  for (const [index, question] of needInput.questions.entries()) {
    assert(typeof question.key === "string" && question.key, `${label}: question[${index}].key missing`);
    assert(typeof question.label === "string" && question.label, `${label}: question[${index}].label missing`);
    assert(question.type === "single_select", `${label}: question[${index}].type invalid`);
    assert(Array.isArray(question.options), `${label}: question[${index}].options missing`);
    assert(question.options.length > 0 && question.options.length <= 5, `${label}: question[${index}].options count invalid`);
  }
}

function isNeedInputPayload(value) {
  return isRecord(value) && typeof value.reason === "string" && Array.isArray(value.questions);
}

function hasSensitiveMetadataKey(value) {
  if (Array.isArray(value)) {
    return value.some(hasSensitiveMetadataKey);
  }

  if (!isRecord(value)) {
    return false;
  }

  return Object.entries(value).some(([key, nestedValue]) => {
    if (/anonymousId|actorHash|authorization|cookie|token/i.test(key)) {
      return true;
    }

    if (/secret/i.test(key) && key !== "degradedReason") {
      return true;
    }

    return hasSensitiveMetadataKey(nestedValue);
  });
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function delay(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function readPositiveInteger(value, fallback) {
  if (!value) {
    return fallback;
  }

  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function readBoolean(value, fallback) {
  if (!value) {
    return fallback;
  }

  const normalized = String(value).trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) {
    return true;
  }

  if (["0", "false", "no", "off"].includes(normalized)) {
    return false;
  }

  return fallback;
}

function normalizeApiBaseUrl(value) {
  return String(value || "").trim().replace(/\/+$/, "");
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function readJsonResponse(response) {
  const text = await response.text();
  return text ? JSON.parse(text) : undefined;
}
