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
const deprecatedPathFields = [
  "coreChoice",
  "suitableFor",
  "prerequisites",
  "benefits",
  "costsOrRisks",
  "situation",
  "choice",
  "process",
  "outcome",
  "costOrRisk",
  "takeaway",
  "referenceValue",
  "sourceRefs",
  "confidence"
];
const deprecatedEvidenceItemFields = [
  "situation",
  "choice",
  "process",
  "outcome",
  "costOrRisk",
  "takeaway"
];
const deprecatedEvidenceSampleFields = [
  "sourceCandidateId",
  "evidenceItemId",
  "sampleType",
  "situation",
  "choice",
  "keyExperience",
  "judgment",
  "referenceValue",
  "limit",
  "evidenceText",
  "supportType",
  "isExperienceEvidence"
];
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
      anonymousId,
      ...(index === 0
        ? {
            metadata: {
              clarifyAnswers: { raw: "should_not_be_stored" },
              token: "should_not_be_stored",
              cookie: "should_not_be_stored",
              authorization: "should_not_be_stored"
            }
          }
        : {})
    });
    startedByQuery.set(query, { ...started, anonymousId });
    const status = await waitForTerminalStatus(started.taskId, query, started.readToken);

    if (status.status === "failed") {
      assert(status.error?.errorCode, `${query}: failed task missing errorCode`);
      assert(status.error?.errorMessage, `${query}: failed task missing errorMessage`);
      throw new Error(`${query}: task failed ${status.error.errorCode}: ${status.error.errorMessage}`);
    }

    assert(status.status === "succeeded", `${query}: task did not succeed`);
    assert(status.resultAvailable === true, `${query}: resultAvailable was not true`);
    if (index === 0) {
      await assertReadTokenAccessControls(started, query);
    }
    const result = await readTaskResult(
      started.resultUrl || `/api/agent/tasks/${encodeURIComponent(started.taskId)}/result`,
      started.readToken
    );
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
      "Content-Type": "application/json",
      ...agentReadTokenHeaders(options.readToken)
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
  assert(typeof body.data?.readToken === "string" && body.data.readToken, `${query}: readToken missing`);
  const allowedStatuses = options.expectNeedInput
    ? ["need_input"]
    : ["queued", "running", "succeeded"];
  assert(allowedStatuses.includes(body.data.status), `${query}: create status invalid`);
  assert(typeof body.data.frontendStatus === "string" && body.data.frontendStatus, `${query}: frontendStatus missing`);
  assert(Number.isFinite(body.data.pollAfterMs), `${query}: pollAfterMs missing`);
  assert(typeof body.data.resultUrl === "string" && body.data.resultUrl, `${query}: resultUrl missing`);

  return body.data;
}

async function refineTask(taskId, body, readToken) {
  const response = await fetch(`${apiBaseUrl}/api/agent/tasks/${encodeURIComponent(taskId)}/refine`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...agentReadTokenHeaders(readToken)
    },
    body: JSON.stringify(body)
  });
  const responseBody = await readJsonResponse(response);
  if (!response.ok || !responseBody?.success) {
    throw new Error(`POST /api/agent/tasks/${taskId}/refine failed: ${response.status} ${JSON.stringify(responseBody)}`);
  }

  assert(typeof responseBody.data?.taskId === "string" && responseBody.data.taskId, "refine: taskId missing");
  assert(typeof responseBody.data?.readToken === "string" && responseBody.data.readToken, "refine: readToken missing");
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

  await assertRequestForbidden(
    () => getTaskStatus(needInputStarted.taskId),
    "clarify: status without readToken should fail"
  );
  await assertRequestForbidden(
    () => getTaskStatus(needInputStarted.taskId, "wrong-token"),
    "clarify: status with wrong readToken should fail"
  );
  const needInputStatus = await getTaskStatus(needInputStarted.taskId, needInputStarted.readToken);
  assert(needInputStatus.status === "need_input", "clarify: status endpoint did not return need_input");
  assert(needInputStatus.pollAfterMs === 0, "clarify: need_input should not ask polling");
  assertNeedInputPayload(needInputStatus.needInput, "clarify status");

  const needInputDebug = await readTaskDebug(needInputStarted.taskId);
  const originalCacheKey = needInputDebug.cache?.queryCacheKey;
  assert(typeof originalCacheKey === "string" && originalCacheKey, "clarify: original cache key missing");

  const sensitiveFreeText = "我不想在 debug 里暴露这段补充文本";
  await assertRequestForbidden(
    () => refineTask(needInputStarted.taskId, {
      answers: {
        currentSituation: "工作痛苦"
      },
      metadata: {
        anonymousId
      }
    }),
    "clarify: refine without readToken should fail"
  );
  await assertRequestForbidden(
    () => refineTask(needInputStarted.taskId, {
      answers: {
        currentSituation: "工作痛苦"
      },
      metadata: {
        anonymousId
      }
    }, "wrong-token"),
    "clarify: refine with wrong readToken should fail"
  );

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
  }, needInputStarted.readToken);
  const refinedStatus = await waitForTerminalStatus(refined.taskId, "phase5 refined task", refined.readToken);
  assert(refinedStatus.status === "succeeded", "refine: refined task did not succeed");
  assert(refinedStatus.resultAvailable === true, "refine: resultAvailable was not true");
  const result = await readTaskResult(
    refined.resultUrl || `/api/agent/tasks/${encodeURIComponent(refined.taskId)}/result`,
    refined.readToken
  );
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
    anonymousId: originalTask.anonymousId,
    readToken: originalTask.readToken
  });

  assert(reused.taskId === originalTask.taskId, `${query}: succeeded cache did not reuse taskId`);
  assert(reused.cacheHit === true, `${query}: succeeded cacheHit was not true`);
  assert(reused.reused === true, `${query}: succeeded reused was not true`);
  assert(reused.queueStatus === "reused_succeeded", `${query}: succeeded queueStatus invalid`);

  const debug = await readTaskDebug(originalTask.taskId);
  assert(debug.cache?.reusedEventCount >= 1, `${query}: reused event missing from debug`);

  const copied = await createTask(query, {
    anonymousId: `${originalTask.anonymousId}_other_actor`
  });
  assert(copied.taskId !== originalTask.taskId, `${query}: cross-actor cache returned original taskId`);
  assert(copied.status === "succeeded", `${query}: cross-actor cache copy did not return succeeded`);
  assert(copied.cacheHit === true, `${query}: cross-actor cache copy missing cacheHit`);
  assert(copied.reused === true, `${query}: cross-actor cache copy missing reused`);
  const copiedResult = await readTaskResult(
    copied.resultUrl || `/api/agent/tasks/${encodeURIComponent(copied.taskId)}/result`,
    copied.readToken
  );
  assertProductionFinalResult(copiedResult.final_result, `${query}: copied cache result`);
  await assertRequestForbidden(
    () => readTaskResult(
      originalTask.resultUrl || `/api/agent/tasks/${encodeURIComponent(originalTask.taskId)}/result`,
      copied.readToken
    ),
    `${query}: copied readToken should not read original task`
  );
}

async function assertRunningTaskReuseAndRateLimit() {
  const suffix = Date.now().toString(36);
  const anonymousId = `agent_phase3_limit_${suffix}`;
  const query = `Phase 3 running reuse ${suffix}`;
  const started = await createTask(query, { anonymousId });
  const crossActor = await createTask(query, { anonymousId: `${anonymousId}_other` });
  assert(crossActor.taskId !== started.taskId, "cross-actor running task reused original taskId");
  const reused = await createTask(query, { anonymousId, readToken: started.readToken });

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

  const status = await waitForTerminalStatus(started.taskId, query, started.readToken);
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

async function waitForTerminalStatus(taskId, query, readToken) {
  const startedAt = Date.now();
  let lastStatus;

  while (Date.now() - startedAt < timeoutMs) {
    const status = await getTaskStatus(taskId, readToken);
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

async function getTaskStatus(taskId, readToken) {
  const response = await fetch(`${apiBaseUrl}/api/agent/tasks/${encodeURIComponent(taskId)}`, {
    headers: agentReadTokenHeaders(readToken)
  });
  const body = await readJsonResponse(response);
  if (!response.ok || !body?.success) {
    throw new Error(`GET /api/agent/tasks/${taskId} failed: ${response.status} ${JSON.stringify(body)}`);
  }

  return body.data;
}

async function readTaskResult(resultUrl, readToken) {
  const url = resultUrl.startsWith("http") ? resultUrl : `${apiBaseUrl}${resultUrl}`;
  const response = await fetch(url, {
    headers: agentReadTokenHeaders(readToken)
  });
  const body = await readJsonResponse(response);
  if (!response.ok || !body?.success) {
    throw new Error(`GET ${url} failed: ${response.status} ${JSON.stringify(body)}`);
  }

  return body.data;
}

async function assertReadTokenAccessControls(started, label) {
  await assertRequestForbidden(
    () => getTaskStatus(started.taskId),
    `${label}: status without readToken should fail`
  );
  await assertRequestForbidden(
    () => getTaskStatus(started.taskId, "wrong-token"),
    `${label}: status with wrong readToken should fail`
  );
  const status = await getTaskStatus(started.taskId, started.readToken);
  assert(status.taskId === started.taskId, `${label}: status with readToken taskId mismatch`);

  await assertRequestForbidden(
    () => readTaskResult(started.resultUrl || `/api/agent/tasks/${encodeURIComponent(started.taskId)}/result`),
    `${label}: result without readToken should fail`
  );
  await assertRequestForbidden(
    () => readTaskResult(
      started.resultUrl || `/api/agent/tasks/${encodeURIComponent(started.taskId)}/result`,
      "wrong-token"
    ),
    `${label}: result with wrong readToken should fail`
  );
  await readTaskResult(
    started.resultUrl || `/api/agent/tasks/${encodeURIComponent(started.taskId)}/result`,
    started.readToken
  );

  await assertRequestForbidden(
    () => readTaskView(started.taskId),
    `${label}: view without readToken should fail`
  );
  await assertRequestForbidden(
    () => readTaskView(started.taskId, "wrong-token"),
    `${label}: view with wrong readToken should fail`
  );
  await readTaskView(started.taskId, started.readToken);
}

async function readTaskView(taskId, readToken) {
  const response = await fetch(`${apiBaseUrl}/api/agent/tasks/${encodeURIComponent(taskId)}/view`, {
    headers: agentReadTokenHeaders(readToken)
  });
  const body = await readJsonResponse(response);
  if (!response.ok || !body?.success) {
    throw new Error(`GET /api/agent/tasks/${taskId}/view failed: ${response.status} ${JSON.stringify(body)}`);
  }

  return body.data;
}

async function readTaskDebug(taskId) {
  const response = await fetch(`${apiBaseUrl}/api/agent/tasks/${encodeURIComponent(taskId)}/debug`, {
    headers: agentDebugTokenHeaders()
  });
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
  assert(!/clarifyAnswers/i.test(metadataText), `${label}: debug leaked clarifyAnswers metadata`);
  assert(!/authorization|cookie|token/i.test(metadataText), `${label}: debug leaked auth metadata`);
}

async function assertRequestForbidden(action, label) {
  try {
    await action();
  } catch (error) {
    const message = String(error?.message || error);
    assert(/ 403 /.test(message) || /AGENT_TASK_FORBIDDEN/.test(message), label);
    return;
  }

  throw new Error(label);
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
  const sourceById = new Map(
    finalResult.sources.flatMap((source) => [
      [source.sourceCandidateId, source],
      [source.id, source]
    ])
  );
  for (const [index, source] of finalResult.sources.entries()) {
    assertProductionSource(source, `${label}: sources[${index}]`);
  }

  for (const [id, evidenceItem] of Object.entries(finalResult.evidenceMap)) {
    assertProductionEvidenceItem(id, evidenceItem, sourceById, `${label}: evidenceMap.${id}`);
  }

  for (const [index, path] of finalResult.paths.entries()) {
    assertFieldsAbsent(path, deprecatedPathFields, `${label}: paths[${index}]`);
    assert(typeof path.title === "string" && path.title, `${label}: paths[${index}].title missing`);
    assert(typeof path.summary === "string" && path.summary, `${label}: paths[${index}].summary missing`);
    assert(typeof path.angle === "string" && path.angle, `${label}: paths[${index}].angle missing`);
    assertPathReferences(path, sourceById, finalResult.evidenceMap, `${label}: paths[${index}]`);
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
  assertFieldsAbsent(evidenceItem, deprecatedEvidenceItemFields, label);
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
  assertFieldsAbsent(sample, deprecatedEvidenceSampleFields, label);
  assert(typeof sample.id === "string" && sample.id, `${label}: id missing`);
  assert(sourceById.has(sample.sourceId), `${label}: sourceId missing`);
  const evidenceItem = evidenceMap[sample.evidenceId];
  assert(evidenceItem, `${label}: evidenceId missing`);
  assert(
    evidenceItem.sourceCandidateId === sample.sourceId,
    `${label}: evidenceId belongs to ${evidenceItem.sourceCandidateId}`
  );
  assert(typeof sample.snippet === "string" && sample.snippet, `${label}: snippet missing`);
  assert(typeof sample.whyRelevant === "string" && sample.whyRelevant, `${label}: whyRelevant missing`);
  assert(
    ["experience", "decision", "opinion", "context"].includes(sample.evidenceType),
    `${label}: evidenceType invalid`
  );
  assert(typeof sample.angle === "string" && sample.angle, `${label}: angle missing`);
  assert(Number.isFinite(sample.confidence), `${label}: confidence missing`);
}

function assertPathReferences(path, sourceById, evidenceMap, label) {
  assert(Array.isArray(path.sourceIds) && path.sourceIds.length > 0, `${label}: sourceIds missing`);
  assert(Array.isArray(path.evidenceIds) && path.evidenceIds.length > 0, `${label}: evidenceIds missing`);

  const pathSourceIds = new Set(path.sourceIds);
  for (const [index, sourceId] of path.sourceIds.entries()) {
    const source = sourceById.get(sourceId);
    assert(source, `${label}: sourceIds[${index}] missing`);
    assert(source.qualityScore >= minCandidateQualityScore, `${label}: sourceIds[${index}] candidate low quality`);
  }

  for (const evidenceId of path.evidenceIds) {
    const evidenceItem = evidenceMap[evidenceId];
    assert(evidenceItem, `${label}: evidence ${evidenceId} missing`);
    assert(
      pathSourceIds.has(evidenceItem.sourceCandidateId),
      `${label}: evidence ${evidenceId} belongs to ${evidenceItem.sourceCandidateId}`
    );
    assert(evidenceItem.confidence >= minEvidenceConfidence, `${label}: evidence ${evidenceId} low confidence`);
  }
}

function assertFieldsAbsent(value, fields, label) {
  for (const field of fields) {
    assert(value[field] === undefined, `${label}: deprecated ${field} should not be present`);
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
  assert(Array.isArray(needInput.cards), `${label}: needInput cards missing`);
  assert(needInput.cards.length > 0 && needInput.cards.length <= 3, `${label}: card count invalid`);
  for (const [index, card] of needInput.cards.entries()) {
    assert(typeof card.id === "string" && card.id, `${label}: card[${index}].id missing`);
    assert(typeof card.title === "string" && card.title, `${label}: card[${index}].title missing`);
    assert(typeof card.question === "string" && card.question, `${label}: card[${index}].question missing`);
    assert(["single_choice", "multi_choice", "free_text"].includes(card.type), `${label}: card[${index}].type invalid`);
    assert(Array.isArray(card.options), `${label}: card[${index}].options missing`);
    assert(card.options.length > 0 && card.options.length <= 5, `${label}: card[${index}].options count invalid`);
    for (const [optionIndex, option] of card.options.entries()) {
      assert(typeof option.id === "string" && option.id, `${label}: card[${index}].option[${optionIndex}].id missing`);
      assert(typeof option.label === "string" && option.label, `${label}: card[${index}].option[${optionIndex}].label missing`);
      assert(
        typeof option.refineHint === "string" && option.refineHint,
        `${label}: card[${index}].option[${optionIndex}].refineHint missing`
      );
    }
  }
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
  return isRecord(value) &&
    typeof value.reason === "string" &&
    Array.isArray(value.cards) &&
    Array.isArray(value.questions);
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

function agentReadTokenHeaders(readToken) {
  const token = String(readToken || "").trim();
  return token ? { "X-Agent-Read-Token": token } : {};
}

function agentDebugTokenHeaders() {
  const token = String(process.env.ADMIN_DEBUG_TOKEN || process.env.AGENT_DEBUG_TOKEN || "").trim();
  return token ? { "X-Agent-Debug-Token": token } : {};
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function readJsonResponse(response) {
  const text = await response.text();
  return text ? JSON.parse(text) : undefined;
}
