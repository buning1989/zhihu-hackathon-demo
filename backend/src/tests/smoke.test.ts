import { once } from "node:events";
import type { Response } from "express";
import { app } from "../app.js";
import { createAuthSession, type UserContext } from "../auth/session.js";
import { llmRouter, type LlmTaskType } from "../llm/llmRouter.js";
import { createOpenAICompatibleJsonCompletion } from "../llm/clients/openaiCompatible.js";
import { composeMultiLlmDemoSearchResponse } from "../llm/demoSearchOrchestrator.js";
import {
  createDeterministicSimilarityClarificationPlan,
  readClarificationAnswerResolution
} from "../llm/similarityClarificationPlanner.js";
import { createMockDemoSearchResponse } from "../mocks/demoSearch.mock.js";
import { demoSessionCacheService } from "../services/demoSessionCache.service.js";
import { searchService } from "../services/search.service.js";
import {
  DEMO_PERSONA_BOUNDARY_NOTICE,
  PERSONA_CHAT_FALLBACK_BOUNDARY_NOTICE
} from "../types/demo.types.js";
import type { DemoClarificationAnswers, DemoDebugClarificationContext } from "../types/demo.types.js";
import type { SearchItem } from "../types/api.types.js";

const PERSONA_CHAT_ACCEPTANCE_MESSAGES = [
  "你当时为什么这么选？",
  "你后来后悔了吗？",
  "这个选择最大的代价是什么？",
  "如果我也想这么做，你会提醒我什么？",
  "你那时候最害怕的是什么？"
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

const server = app.listen(0, "127.0.0.1");
await once(server, "listening");

try {
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Smoke server did not expose a TCP address");
  }

  const baseUrl = `http://127.0.0.1:${address.port}`;

  const health = await requestJson(`${baseUrl}/api/health`);
  assertEqual(health.status, 200, "GET /api/health status");
  assertEqual(health.body.success, true, "GET /api/health success");

  await assertAgentTasksMvp(baseUrl);

  const demoSearch = await requestJson(`${baseUrl}/api/demo/search`, {
    method: "POST",
    body: {
      query: "不工作了能去哪儿",
      count: 3,
      dataMode: "mock"
    }
  });

  assertEqual(demoSearch.status, 200, "POST /api/demo/search status");
  assertEqual(demoSearch.body.success, true, "POST /api/demo/search success");
  assertEqual(demoSearch.body.data.schemaVersion, "demo.v1", "demo schemaVersion");
  assertEqual(
    demoSearch.body.data.contextUsed.loggedIn,
    false,
    "anonymous demo context loggedIn"
  );
  assertNonEmptyArray(demoSearch.body.data.paths, "demo paths");
  assertNonEmptyArray(demoSearch.body.data.people, "demo people");
  assertEqual("personas" in demoSearch.body.data, false, "demo top-level personas omitted");
  assertEqual("sections" in demoSearch.body.data, false, "demo top-level sections omitted");
  assertNonEmptyString(
    demoSearch.body.data.people[0].aiPersona.personaId,
    "demo people[0].aiPersona.personaId"
  );
  assertClarifyingCard(demoSearch.body.data.clarifyingCard, "demo clarifyingCard");
  assertSimilarityClarifyingCard(
    demoSearch.body.data.clarifyingCard,
    demoSearch.body.data.debug,
    "demo similarity clarifyingCard"
  );
  await assertSimilarityClarificationRegressionCases(baseUrl);
  await assertClarifiedQueryExpansionUsesLegacyAnswers();
  assertEqual(
    demoSearch.body.data.clarificationStage.needClarification,
    true,
    "demo clarificationStage.needClarification"
  );

  const clarifiedDemoSearch = await requestJson(`${baseUrl}/api/demo/search`, {
    method: "POST",
    body: {
      query: "为了工作能追求自己想做的事，长期异地恋真的值得吗？",
      count: 3,
      dataMode: "mock",
      clarificationAnswers: {
        priority: "我更在意能不能追求自己想做的工作，但也不想轻易放弃关系",
        duration: "可能异地 1-2 年",
        relationshipStatus: "关系稳定，但对未来不确定",
        wantedSamples: "想看真实经历，尤其是坚持下来和最后分开的两类人"
      }
    }
  });

  assertEqual(clarifiedDemoSearch.status, 200, "clarified demo search status");
  assertEqual(clarifiedDemoSearch.body.success, true, "clarified demo search success");
  assertEqual(clarifiedDemoSearch.body.data.schemaVersion, "demo.v1", "clarified demo schemaVersion");
  assertNonEmptyArray(clarifiedDemoSearch.body.data.paths, "clarified demo paths");
  assertNonEmptyArray(clarifiedDemoSearch.body.data.people, "clarified demo people");
  assertEqual(
    "personas" in clarifiedDemoSearch.body.data,
    false,
    "clarified demo top-level personas omitted"
  );
  assertEqual(
    "sections" in clarifiedDemoSearch.body.data,
    false,
    "clarified demo top-level sections omitted"
  );
  assertNonEmptyString(
    clarifiedDemoSearch.body.data.people[0].aiPersona.personaId,
    "clarified demo people[0].aiPersona.personaId"
  );
  assertEqual(
    clarifiedDemoSearch.body.data.clarifyingCard.show,
    false,
    "clarified demo hides clarifyingCard"
  );
  assertEqual(
    clarifiedDemoSearch.body.data.clarificationStage.needClarification,
    false,
    "clarified demo clarificationStage.needClarification"
  );
  assertEqual(
    clarifiedDemoSearch.body.data.debug.clarificationContext.applied,
    true,
    "clarified demo clarificationContext.applied"
  );

  const loggedInDemoSearch = await requestJson(`${baseUrl}/api/demo/search`, {
    method: "POST",
    headers: {
      cookie: createLoggedInSessionCookie()
    },
    body: {
      query: "不工作了能去哪儿",
      count: 3,
      dataMode: "mock"
    }
  });

  assertEqual(loggedInDemoSearch.status, 200, "logged-in demo search status");
  assertEqual(loggedInDemoSearch.body.success, true, "logged-in demo search success");
  assertEqual(
    loggedInDemoSearch.body.data.contextUsed.loggedIn,
    true,
    "logged-in demo context loggedIn"
  );
  assertEqual(
    JSON.stringify(loggedInDemoSearch.body).includes("test-access-token"),
    false,
    "logged-in demo response does not expose token"
  );

  const authMe = await requestJson(`${baseUrl}/auth/me`, {
    headers: {
      cookie: createLoggedInSessionCookie()
    }
  });
  assertEqual(authMe.status, 200, "GET /auth/me status");
  assertEqual(authMe.body.success, true, "GET /auth/me success");
  assertEqual(authMe.body.data.id, "zhihu-test-user", "GET /auth/me data.id");
  assertEqual(authMe.body.data.name, "AI 产品经理", "GET /auth/me data.name");
  assertEqual(
    authMe.body.data.avatar,
    "https://example.test/avatar.png",
    "GET /auth/me data.avatar"
  );
  assertEqual(
    authMe.body.data.profileUrl,
    "https://www.zhihu.com/people/ai-product-manager",
    "GET /auth/me data.profileUrl"
  );
  assertEqual(
    JSON.stringify(authMe.body).includes("test-access-token"),
    false,
    "GET /auth/me does not expose token"
  );
  await assertQueryAwareDemoPaths(baseUrl);

  const personaId = demoSearch.body.data.people[0].aiPersona.personaId;
  const queryId = demoSearch.body.data.queryId;
  for (const message of PERSONA_CHAT_ACCEPTANCE_MESSAGES) {
    const personaChat = await requestJson(`${baseUrl}/api/personas/chat`, {
      method: "POST",
      body: {
        personaId,
        queryId,
        message
      }
    });

    assertEqual(personaChat.status, 200, `POST /api/personas/chat status: ${message}`);
    assertEqual(personaChat.body.success, true, `POST /api/personas/chat success: ${message}`);
    assertEqual(
      personaChat.body.data.schemaVersion,
      "personaChat.v1",
      `persona chat schemaVersion: ${message}`
    );
    assertPersonaChatExperienceReply(personaChat.body.data, `persona chat: ${message}`);
  }

  const missingPersonaId = await requestJson(`${baseUrl}/api/personas/chat`, {
    method: "POST",
    body: {
      queryId,
      message: "这段公开内容里，第一步应该想清楚什么？"
    }
  });
  assertEqual(missingPersonaId.status, 400, "missing personaId status");
  assertEqual(missingPersonaId.body.success, false, "missing personaId success");
  assertEqual(
    missingPersonaId.body.error.code,
    "PERSONA_ID_REQUIRED",
    "missing personaId error code"
  );

  const missingMessage = await requestJson(`${baseUrl}/api/personas/chat`, {
    method: "POST",
    body: {
      personaId,
      queryId
    }
  });
  assertEqual(missingMessage.status, 400, "missing message status");
  assertEqual(missingMessage.body.success, false, "missing message success");
  assertEqual(missingMessage.body.error.code, "MESSAGE_REQUIRED", "missing message error code");

  await assertDisabledPersonaFallback(baseUrl);
  await assertDeepSeekResponseFormatFallback();
  await assertLoggedInUserContextInRealComposer();
  await assertCandidateQualityPrefersExperience();
  await assertObjectiveQueryExpansionCases();
  await assertNoLlmConfigFallbackKind();
  await assertPartialLlmFallbackKind();
  await assertGroundingGuardInvalidFallback();

  console.log("backend smoke ok");
} finally {
  server.close();
}

interface RequestOptions {
  method?: "GET" | "POST";
  headers?: Record<string, string>;
  body?: unknown;
}

async function assertAgentTasksMvp(baseUrl: string): Promise<void> {
  const createMockTask = await requestJson(`${baseUrl}/api/agent/tasks`, {
    method: "POST",
    body: {
      query: "不工作了能去哪儿",
      count: 3,
      dataMode: "mock"
    }
  });

  assertEqual(createMockTask.status, 200, "POST /api/agent/tasks mock status");
  assertEqual(createMockTask.body.success, true, "POST /api/agent/tasks mock success");
  assertNonEmptyString(createMockTask.body.data.taskId, "agent mock taskId");
  assertEqual(createMockTask.body.data.status, "queued", "agent mock initial status");
  assertAgentStage(createMockTask.body.data, "intent_expand", ["pending"]);

  const mockTaskId = String(createMockTask.body.data.taskId);
  const finalMockStatus = await waitForAgentTask(baseUrl, mockTaskId, "mock task final", (data) =>
    data.status === "succeeded" || data.status === "degraded" || data.status === "failed"
  );

  if (finalMockStatus.status !== "succeeded" && finalMockStatus.status !== "degraded") {
    throw new Error(`agent mock final status: expected succeeded or degraded, got ${String(finalMockStatus.status)}`);
  }
  assertEqual(finalMockStatus.hasPartialResult, true, "agent mock has partial result");
  assertEqual(finalMockStatus.hasFinalResult, true, "agent mock has final result");
  assertAgentStage(finalMockStatus, "intent_expand", ["succeeded"]);
  assertAgentStage(finalMockStatus, "retrieve_search", ["skipped"]);
  assertAgentStage(finalMockStatus, "partial_compose", ["succeeded"]);
  const mockEvidenceStage = assertAgentStage(finalMockStatus, "evidence_extract", [
    "succeeded",
    "degraded",
    "timed_out"
  ]);
  const mockSummaryStage = assertAgentStage(finalMockStatus, "experience_summary", [
    "succeeded",
    "degraded",
    "timed_out"
  ]);

  const mockView = await requestJson(`${baseUrl}/api/agent/tasks/${mockTaskId}/view`);
  assertEqual(mockView.status, 200, "GET /api/agent/tasks/:taskId/view mock status");
  assertEqual(mockView.body.success, true, "GET /api/agent/tasks/:taskId/view mock success");
  assertEqual(mockView.body.data.result.dataMode, "mock", "agent mock view dataMode");
  assertNonEmptyArray(mockView.body.data.result.paths, "agent mock view paths");
  assertNonEmptyArray(mockView.body.data.result.people, "agent mock view people");

  const mockResult = await requestJson(`${baseUrl}/api/agent/tasks/${mockTaskId}/result`);
  assertEqual(mockResult.status, 200, "GET /api/agent/tasks/:taskId/result mock status");
  assertEqual(mockResult.body.success, true, "GET /api/agent/tasks/:taskId/result mock success");
  assertEqual(mockResult.body.data.result.dataMode, "mock", "agent mock final dataMode");
  assertEvidenceExtractResult(
    mockResult.body.data.result,
    String(mockEvidenceStage.status),
    "agent mock final evidence"
  );
  assertExperienceSummaryResult(
    mockResult.body.data.result,
    String(mockSummaryStage.status),
    "agent mock final experience summary"
  );
  if (mockEvidenceStage.status !== "succeeded") {
    assertEqual(finalMockStatus.degraded, true, "agent mock degraded after evidence fallback");
    assertIncludes(finalMockStatus.failedStages, "evidence_extract", "agent mock failedStages");
  }
  if (mockSummaryStage.status !== "succeeded") {
    assertEqual(finalMockStatus.degraded, true, "agent mock degraded after summary fallback");
    assertIncludes(finalMockStatus.failedStages, "experience_summary", "agent mock summary failedStages");
  }

  const originalSearch = searchService.search;
  searchService.search = async () => {
    throw new Error("synthetic real search failure for agent smoke");
  };

  try {
    const createRealTask = await requestJson(`${baseUrl}/api/agent/tasks`, {
      method: "POST",
      body: {
        query: "真实模式不允许静默 mock",
        count: 3,
        dataMode: "real"
      }
    });

    assertEqual(createRealTask.status, 200, "POST /api/agent/tasks real status");
    assertEqual(createRealTask.body.success, true, "POST /api/agent/tasks real success");
    assertNonEmptyString(createRealTask.body.data.taskId, "agent real taskId");

    const realTaskId = String(createRealTask.body.data.taskId);
    const finalRealStatus = await waitForAgentTask(baseUrl, realTaskId, "real no-mock task final", (data) =>
      data.status === "failed" || data.status === "succeeded" || data.status === "degraded"
    );

    assertEqual(finalRealStatus.status, "failed", "agent real no-mock final status");
    assertEqual(finalRealStatus.degraded, true, "agent real no-mock degraded");
    assertEqual(finalRealStatus.retryable, true, "agent real no-mock retryable");
    assertAgentStage(finalRealStatus, "retrieve_search", ["failed"]);

    const realView = await requestJson(`${baseUrl}/api/agent/tasks/${realTaskId}/view`);
    assertEqual(realView.status, 200, "GET /api/agent/tasks/:taskId/view real failed status");
    assertEqual(realView.body.success, true, "GET /api/agent/tasks/:taskId/view real failed success");
    assertEqual(realView.body.data.result.dataMode, "real", "agent real failed view dataMode");
    assertEqual(realView.body.data.result.degraded, true, "agent real failed view degraded");
    assertEqual(
      JSON.stringify(realView.body).includes('"dataMode":"mock"'),
      false,
      "agent real failed view does not contain mock result"
    );
  } finally {
    searchService.search = originalSearch;
  }
}

async function waitForAgentTask(
  baseUrl: string,
  taskId: string,
  label: string,
  predicate: (data: Record<string, unknown>) => boolean
): Promise<Record<string, unknown>> {
  let latest: Record<string, unknown> | null = null;

  for (let attempt = 0; attempt < 520; attempt += 1) {
    await sleep(25);
    const response = await requestJson(`${baseUrl}/api/agent/tasks/${taskId}`);
    assertEqual(response.status, 200, `${label} poll status`);
    assertEqual(response.body.success, true, `${label} poll success`);
    const data = response.body.data;
    if (!isRecord(data)) {
      throw new Error(`${label}: expected task data object`);
    }

    latest = data;
    if (predicate(data)) {
      return data;
    }
  }

  throw new Error(`${label}: timed out waiting for terminal task status; latest=${JSON.stringify(latest)}`);
}

function assertAgentStage(
  taskData: unknown,
  stageName: string,
  allowedStatuses: string[]
): Record<string, unknown> {
  if (!isRecord(taskData) || !Array.isArray(taskData.stages)) {
    throw new Error(`agent stage ${stageName}: expected task stages`);
  }

  const stage = taskData.stages.find((item) => isRecord(item) && item.name === stageName);
  if (!isRecord(stage)) {
    throw new Error(`agent stage ${stageName}: missing stage`);
  }

  if (!allowedStatuses.includes(String(stage.status))) {
    throw new Error(
      `agent stage ${stageName}: expected ${allowedStatuses.join(" or ")}, got ${String(stage.status)}`
    );
  }

  return stage;
}

function assertEvidenceExtractResult(
  result: unknown,
  stageStatus: string,
  label: string
): void {
  if (!isRecord(result) || !isRecord(result.meta)) {
    throw new Error(`${label}: expected result meta`);
  }

  if (!isRecord(result.meta.evidenceExtract)) {
    throw new Error(`${label}: expected meta.evidenceExtract`);
  }

  assertEqual(result.meta.evidenceExtract.status, stageStatus, `${label} status`);
  assertNonEmptyArray(result.meta.evidenceSamples, `${label} evidenceSamples`);

  if (stageStatus !== "succeeded") {
    assertIncludes(result.meta.fallbackStages, "evidence_extract", `${label} fallbackStages`);
  }
}

function assertExperienceSummaryResult(
  result: unknown,
  stageStatus: string,
  label: string
): void {
  if (!isRecord(result) || !isRecord(result.meta)) {
    throw new Error(`${label}: expected result meta`);
  }

  if (!isRecord(result.meta.experienceSummary)) {
    throw new Error(`${label}: expected meta.experienceSummary`);
  }

  assertEqual(result.meta.experienceSummary.status, stageStatus, `${label} status`);

  if (stageStatus === "succeeded") {
    assertEqual(result.meta.experienceSummary.llmGenerated, true, `${label} llmGenerated`);
    assertNonEmptyArray(result.people, `${label} people`);
  } else {
    assertIncludes(result.meta.fallbackStages, "experience_summary", `${label} fallbackStages`);
    assertNonEmptyArray(result.people, `${label} fallback people`);
  }
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function requestJson(url: string, options: RequestOptions = {}) {
  const response = await fetch(url, {
    method: options.method ?? "GET",
    headers: {
      ...(options.headers ?? {}),
      ...(options.body === undefined ? {} : { "Content-Type": "application/json" })
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body)
  });

  return {
    status: response.status,
    body: await response.json()
  };
}

function assertEqual(actual: unknown, expected: unknown, label: string): void {
  if (actual !== expected) {
    throw new Error(`${label}: expected ${String(expected)}, got ${String(actual)}`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertNonEmptyArray(value: unknown, label: string): void {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`${label}: expected non-empty array`);
  }
}

function assertMinArrayLength(value: unknown, minLength: number, label: string): void {
  if (!Array.isArray(value) || value.length < minLength) {
    throw new Error(`${label}: expected array length >= ${minLength}`);
  }
}

function assertArray(value: unknown, label: string): void {
  if (!Array.isArray(value)) {
    throw new Error(`${label}: expected array`);
  }
}

function assertNumberInRange(
  value: unknown,
  min: number,
  max: number,
  label: string
): void {
  if (typeof value !== "number" || value < min || value > max) {
    throw new Error(`${label}: expected number between ${min} and ${max}`);
  }
}

function assertNonEmptyString(value: unknown, label: string): void {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${label}: expected non-empty string`);
  }
}

function assertIncludes(value: unknown, expected: string, label: string): void {
  if (Array.isArray(value)) {
    if (!value.includes(expected)) {
      throw new Error(`${label}: expected ${JSON.stringify(value)} to include ${expected}`);
    }
    return;
  }

  if (typeof value !== "string" || !value.includes(expected)) {
    throw new Error(`${label}: expected ${String(value)} to include ${expected}`);
  }
}

function assertNotIncludes(value: unknown, expected: string, label: string): void {
  if (typeof value === "string" && value.includes(expected)) {
    throw new Error(`${label}: expected ${String(value)} not to include ${expected}`);
  }
}

function assertPersonaChatExperienceReply(value: unknown, label: string): void {
  if (!isRecord(value)) {
    throw new Error(`${label}: expected response data object`);
  }

  const reply = value.reply;
  const boundaryNotice = value.boundaryNotice;
  assertNonEmptyString(reply, `${label} reply`);
  assertNonEmptyString(boundaryNotice, `${label} boundaryNotice`);
  assertArray(value.sourceRefs, `${label} sourceRefs`);
  assertArray(value.suggestedQuestions, `${label} suggestedQuestions`);

  if (typeof reply === "string" && !reply.includes("我")) {
    throw new Error(`${label} reply must use first person`);
  }

  for (const fragment of PERSONA_REPLY_FORBIDDEN_FRAGMENTS) {
    assertNotIncludes(reply, fragment, `${label} reply forbidden fragment`);
  }

  assertNotIncludes(reply, String(boundaryNotice), `${label} reply repeats boundaryNotice`);
  if (
    boundaryNotice !== DEMO_PERSONA_BOUNDARY_NOTICE &&
    boundaryNotice !== PERSONA_CHAT_FALLBACK_BOUNDARY_NOTICE
  ) {
    throw new Error(`${label} boundaryNotice used unexpected copy`);
  }
}

function assertClarifyingCard(value: unknown, label: string): void {
  if (!isRecord(value)) {
    throw new Error(`${label}: expected clarifying card object`);
  }

  assertEqual(value.show, true, `${label}.show`);
  assertNonEmptyString(value.title, `${label}.title`);
  assertMinArrayLength(value.questions, 3, `${label}.questions`);

  const questions = value.questions as unknown[];
  if (questions.length > 3) {
    throw new Error(`${label}.questions: expected <= 3 questions`);
  }

  for (const [index, question] of questions.entries()) {
    if (!isRecord(question)) {
      throw new Error(`${label}.questions[${index}]: expected object`);
    }
    assertNonEmptyString(question.id, `${label}.questions[${index}].id`);
    assertNonEmptyString(question.label, `${label}.questions[${index}].label`);
    assertNonEmptyArray(question.options, `${label}.questions[${index}].options`);
    if (Array.isArray(question.options) && question.options.length > 6) {
      throw new Error(`${label}.questions[${index}].options: expected <= 6 options`);
    }
  }
}

function assertSimilarityClarifyingCard(card: unknown, debug: unknown, label: string): void {
  assertClarifyingCard(card, label);
  if (!isRecord(card) || !Array.isArray(card.questions)) {
    throw new Error(`${label}: expected card.questions`);
  }

  const labels = readClarifyingCardQuestionLabels(card).join("\n");
  assertNoForbiddenClarificationQuestion(labels, `${label}.labels`);

  for (const [index, question] of card.questions.entries()) {
    if (!isRecord(question)) {
      throw new Error(`${label}.questions[${index}]: expected object`);
    }

    assertNonEmptyString(question.slot, `${label}.questions[${index}].slot`);
    assertNonEmptyString(question.selectedReason, `${label}.questions[${index}].selectedReason`);
    assertNonEmptyArray(question.queryTokens, `${label}.questions[${index}].queryTokens`);
    assertNumberInRange(question.score, 0, 1, `${label}.questions[${index}].score`);
  }

  assertClarificationPlanDebug(debug, label);
}

async function assertSimilarityClarificationRegressionCases(baseUrl: string): Promise<void> {
  const cases = [
    "北大毕业，进银行还是去互联网大厂？",
    "985硕士毕业，去国企还是去外企？",
    "计算机应届生，去大厂还是去创业公司？",
    "三本毕业，想进互联网产品岗现实吗？",
    "机械专业毕业，不想进工厂还能做什么？",
    "28岁程序员不想继续写代码，转产品经理靠谱吗？",
    "体制内工作五年，想辞职做自媒体，会不会太冒险？",
    "施工单位正式工想离职，不知道还能做什么？",
    "30岁女教师想转行心理咨询，还有机会吗？",
    "北京工作十年，想回老家开店现实吗？",
    "异地恋三年，要不要去对方城市？",
    "35岁有一个孩子，要不要生二胎？",
    "县城公务员想去省会发展，值得吗？",
    "租房五年，要不要在杭州买房？",
    "自媒体做了一年没起色，要不要回去上班？"
  ];

  for (const query of cases) {
    const response = await requestJson(`${baseUrl}/api/demo/search`, {
      method: "POST",
      body: {
        query,
        count: 3,
        dataMode: "mock"
      }
    });

    assertEqual(response.status, 200, `${query}: clarification status`);
    assertEqual(response.body.success, true, `${query}: clarification success`);
    const card = response.body.data.clarifyingCard;
    assertSimilarityClarifyingCard(card, response.body.data.debug, `${query}: similarity clarification`);
    assertClarificationDoesNotRepeatKnownFacts(response.body.data.debug, query);

    const answers = buildFirstOptionAnswers(card);
    const clarifiedResponse = await requestJson(`${baseUrl}/api/demo/search`, {
      method: "POST",
      body: {
        query,
        count: 3,
        dataMode: "mock",
        clarificationAnswers: answers
      }
    });

    assertEqual(clarifiedResponse.status, 200, `${query}: clarified status`);
    assertEqual(clarifiedResponse.body.success, true, `${query}: clarified success`);
    assertEqual(
      clarifiedResponse.body.data.clarificationStage.needClarification,
      false,
      `${query}: clarified needClarification`
    );
    assertClarificationPlanDebug(clarifiedResponse.body.data.debug, `${query}: clarified debug`);
    assertClarifiedQueryPlanUsesAnswers(
      clarifiedResponse.body.data.debug,
      readSelectedAnswerLabels(card, answers),
      query
    );
  }
}

function assertNoForbiddenClarificationQuestion(labels: string, label: string): void {
  for (const forbidden of [
    "更想看",
    "真实经历",
    "最影响判断",
    "最需要先考虑",
    "能接受多久",
    "承受多久",
    "稳定工资",
    "稳定收入",
    "预期",
    "预计",
    "风险",
    "信心",
    "坚持",
    "适合",
    "值不值得",
    "怕不怕后悔",
    "未来",
    "最想要什么样的生活",
    "最大现实压力",
    "最大的现实压力",
    "最缺哪块准备",
    "考虑的方向是什么",
    "情况相似",
    "走通了",
    "失败复盘",
    "长期结果",
    "希望得到哪类建议"
  ]) {
    assertNotIncludes(labels, forbidden, label);
  }
}

function assertClarificationPlanDebug(value: unknown, label: string): void {
  if (!isRecord(value) || !isRecord(value.clarificationPlan)) {
    throw new Error(`${label}: expected debug.clarificationPlan`);
  }

  const plan = value.clarificationPlan;
  assertNonEmptyString(plan.intentCategory, `${label}: clarificationPlan.intentCategory`);
  assertNonEmptyArray(plan.knownFacts, `${label}: clarificationPlan.knownFacts`);
  if (!isRecord(plan.choiceFrame)) {
    throw new Error(`${label}: expected clarificationPlan.choiceFrame`);
  }
  assertNonEmptyArray(
    plan.missingSimilarityDimensions,
    `${label}: clarificationPlan.missingSimilarityDimensions`
  );
  assertMinArrayLength(
    plan.candidateQuestions,
    6,
    `${label}: clarificationPlan.candidateQuestions`
  );
  assertNonEmptyArray(plan.scoringDetails, `${label}: clarificationPlan.scoringDetails`);
  if (!isRecord(plan.knownSlots)) {
    throw new Error(`${label}: expected clarificationPlan.knownSlots`);
  }
  assertNonEmptyArray(plan.missingSimilaritySlots, `${label}: clarificationPlan.missingSimilaritySlots`);
  assertNonEmptyArray(plan.selectedQuestions, `${label}: clarificationPlan.selectedQuestions`);
  const selectedWithQueryUtility = (plan.selectedQuestions as unknown[]).filter((question) =>
    isRecord(question) && Array.isArray(question.queryTokens) && question.queryTokens.length > 0
  );
  if (selectedWithQueryUtility.length < 2) {
    throw new Error(`${label}: expected at least 2 selected questions with queryTokens`);
  }
  for (const [index, question] of (plan.selectedQuestions as unknown[]).entries()) {
    if (!isRecord(question)) {
      throw new Error(`${label}: clarificationPlan.selectedQuestions[${index}] expected object`);
    }
    assertNonEmptyString(question.slot, `${label}: selectedQuestions[${index}].slot`);
    assertNonEmptyString(question.question, `${label}: selectedQuestions[${index}].question`);
    assertNonEmptyString(question.selectedReason, `${label}: selectedQuestions[${index}].selectedReason`);
    assertNonEmptyArray(question.queryTokens, `${label}: selectedQuestions[${index}].queryTokens`);
    assertNumberInRange(question.score, 0, 1, `${label}: selectedQuestions[${index}].score`);
  }
  assertArray(plan.rejectedQuestions, `${label}: clarificationPlan.rejectedQuestions`);
  for (const [index, rejected] of (plan.rejectedQuestions as unknown[]).entries()) {
    if (!isRecord(rejected)) {
      throw new Error(`${label}: clarificationPlan.rejectedQuestions[${index}] expected object`);
    }
    assertNonEmptyString(rejected.question, `${label}: rejectedQuestions[${index}].question`);
    assertNonEmptyString(rejected.reason, `${label}: rejectedQuestions[${index}].reason`);
  }
  if (!isRecord(plan.queryPlan)) {
    throw new Error(`${label}: expected clarificationPlan.queryPlan`);
  }
  assertNonEmptyArray(plan.queryPlan.primary, `${label}: clarificationPlan.queryPlan.primary`);
  assertPrimaryQueryQuality(plan.queryPlan.primary as string[], `${label}: clarificationPlan.queryPlan.primary`);
}

function assertClarificationDoesNotRepeatKnownFacts(debug: unknown, label: string): void {
  if (!isRecord(debug) || !isRecord(debug.clarificationPlan)) {
    throw new Error(`${label}: expected clarificationPlan`);
  }

  const plan = debug.clarificationPlan;
  const knownSlots = new Set(
    Array.isArray(plan.knownFacts)
      ? plan.knownFacts.flatMap((fact) => isRecord(fact) ? [String(fact.slot)] : [])
      : []
  );
  for (const question of Array.isArray(plan.selectedQuestions) ? plan.selectedQuestions : []) {
    if (!isRecord(question)) {
      continue;
    }

    const slot = String(question.slot);
    if (knownSlots.has(slot)) {
      throw new Error(`${label}: selected question repeats known fact slot ${slot}`);
    }
  }
}

function buildFirstOptionAnswers(card: unknown): Record<string, string> {
  if (!isRecord(card) || !Array.isArray(card.questions)) {
    return {};
  }

  return Object.fromEntries(
    card.questions.flatMap((question) => {
      if (!isRecord(question) || !Array.isArray(question.options) || !isRecord(question.options[0])) {
        return [];
      }

      return [[String(question.id), String(question.options[0].id)]];
    })
  );
}

function readSelectedAnswerLabels(
  card: unknown,
  answers: Record<string, string>
): string[] {
  if (!isRecord(card) || !Array.isArray(card.questions)) {
    return [];
  }

  return card.questions.flatMap((question) => {
    if (!isRecord(question) || !Array.isArray(question.options)) {
      return [];
    }

    const selectedId = answers[String(question.id)];
    const option = question.options.find((item) => isRecord(item) && item.id === selectedId);
    return isRecord(option) ? [String(option.label)] : [];
  });
}

function assertClarifiedQueryPlanUsesAnswers(
  debug: unknown,
  answerLabels: string[],
  label: string
): void {
  if (!isRecord(debug) || !isRecord(debug.clarificationPlan) || !isRecord(debug.clarificationPlan.queryPlan)) {
    throw new Error(`${label}: expected clarified clarificationPlan.queryPlan`);
  }

  const primary = debug.clarificationPlan.queryPlan.primary;
  assertNonEmptyArray(primary, `${label}: clarified queryPlan.primary`);
  const primaryText = Array.isArray(primary) ? primary.join(" ") : "";
  const answerTokens = answerLabels.flatMap((answerLabel) =>
    answerLabel.split(/[\s/／、,，]+/).filter((token) => token.length >= 2)
  );
  if (!answerTokens.some((token) => primaryText.includes(token))) {
    throw new Error(
      `${label}: expected queryPlan.primary to include clarification answer tokens; got ${primaryText}`
    );
  }
}

async function assertClarifiedQueryExpansionUsesLegacyAnswers(): Promise<void> {
  const cases: Array<{
    query: string;
    answers: DemoClarificationAnswers;
    expectedTokens: string[];
  }> = [
    {
      query: "28岁程序员不想继续写代码，转产品经理靠谱吗？",
      answers: {
        techDirection: "backend",
        workYears: "5_to_8_years",
        productRelatedExperience: "requirement_review"
      },
      expectedTokens: ["后端", "5-8年", "需求评审"]
    },
    {
      query: "体制内工作五年，想辞职做自媒体，会不会太冒险？",
      answers: {
        institutionRoleType: "publicity_writing",
        contentDirection: "career_experience",
        contentFoundation: "writing_expression"
      },
      expectedTokens: ["宣传文字", "写作表达", "自媒体"]
    },
    {
      query: "施工单位正式工想离职，不知道还能做什么？",
      answers: {
        function: "site_engineering",
        workYears: "5_to_8_years",
        engineeringAbility: "site_coordination"
      },
      expectedTokens: ["现场工程", "5-8年", "项目管理"]
    },
    {
      query: "30岁女教师想转行心理咨询，还有机会吗？",
      answers: {
        teacherStage: "middle_high_school",
        counselingFoundation: "certificate_exam",
        counselingRelatedExperience: "student_comm"
      },
      expectedTokens: ["初中", "证书", "学生沟通"]
    },
    {
      query: "广州设计师裸辞后接私单，能养活自己吗？",
      answers: {
        skillDirection: "ui_ux",
        workYears: "3_to_5_years",
        resourceType: "client_communication"
      },
      expectedTokens: ["UI", "3-5年", "客户沟通"]
    },
    {
      query: "金融公司中后台想辞职考公，值不值得？",
      answers: {
        function: "risk_compliance",
        examStage: "started_prep",
        professionalBackground: "finance_3_to_5"
      },
      expectedTokens: ["风控", "合规", "3-5年"]
    }
  ];

  for (const [index, testCase] of cases.entries()) {
    const unclarified = await withStubbedOrchestrator({
      configuredTasks: new Set(),
      outputs: {},
      query: testCase.query,
      count: 1,
      searchItems: [createObjectiveSearchItem(index, testCase.query)]
    });
    const clarificationContext = createTestClarificationContext(
      testCase.query,
      testCase.answers
    );
    const clarified = await withStubbedOrchestrator({
      configuredTasks: new Set(),
      outputs: {},
      query: testCase.query,
      count: 1,
      searchItems: [createObjectiveSearchItem(index + 20, testCase.query)],
      clarificationContext
    });

    const answerLabelText = Object.values(clarificationContext.answerLabels).join(" ");
    for (const rawId of Object.values(testCase.answers)) {
      assertNotIncludes(answerLabelText, rawId, `${testCase.query}: answerLabels raw id`);
    }

    const queryPlanText = [
      ...(clarified.debug.intentStage.queryPlan?.primary ?? []),
      ...(clarified.debug.intentStage.queryPlan?.secondary ?? [])
    ].join(" ");
    const matchedPlanTokenCount = testCase.expectedTokens.filter((token) =>
      queryPlanText.includes(token)
    ).length;
    if (matchedPlanTokenCount < 2) {
      throw new Error(
        `${testCase.query}: expected clarified queryPlan to include at least 2 answer tokens; got ${queryPlanText}`
      );
    }

    const unclarifiedQueries = unclarified.debug.search?.queriesUsed ?? [];
    const clarifiedQueries = clarified.debug.search?.queriesUsed ?? [];
    assertNonEmptyArray(clarifiedQueries, `${testCase.query}: clarified queriesUsed`);
    assertPrimaryQueryQuality(
      clarifiedQueries.slice(0, 3),
      `${testCase.query}: clarified queriesUsed first3`
    );
    if (JSON.stringify(unclarifiedQueries) === JSON.stringify(clarifiedQueries)) {
      throw new Error(`${testCase.query}: clarified queriesUsed should differ from unclarified`);
    }

    const clarifiedQueryHitCount = clarifiedQueries.filter((query) =>
      testCase.expectedTokens.some((token) => query.includes(token))
    ).length;
    if (clarifiedQueryHitCount < 2) {
      throw new Error(
        `${testCase.query}: expected at least 2 clarified queriesUsed with answer tokens; got ${clarifiedQueries.join(" | ")}`
      );
    }
  }
}

function createTestClarificationContext(
  query: string,
  answers: DemoClarificationAnswers
): DemoDebugClarificationContext {
  const basePlan = createDeterministicSimilarityClarificationPlan(query);
  const resolution = readClarificationAnswerResolution(basePlan.card, answers);
  const answeredPlan = createDeterministicSimilarityClarificationPlan(
    query,
    resolution.answerLabels
  );
  const searchHints = [
    ...(answeredPlan.debug.queryPlan?.primary ?? []),
    ...(answeredPlan.debug.queryPlan?.secondary ?? [])
  ].slice(0, 8);

  return {
    originalQuery: query,
    answers,
    answerLabels: resolution.answerLabels,
    ...(Object.keys(resolution.unresolvedAnswers).length > 0
      ? { unresolvedAnswers: resolution.unresolvedAnswers }
      : {}),
    answerSummary: Object.entries(resolution.answerLabels)
      .map(([key, value]) => `${key}: ${value}`)
      .join("；"),
    searchHints,
    applied: true,
    searchHintCount: searchHints.length,
    queryPlan: answeredPlan.debug.queryPlan
  };
}

function readClarifyingCardQuestionLabels(value: unknown): string[] {
  if (!isRecord(value) || !Array.isArray(value.questions)) {
    return [];
  }

  return value.questions
    .map((question) => (isRecord(question) ? String(question.label ?? "") : ""))
    .filter(Boolean);
}

function readClarifyingCardOptionLabels(value: unknown): string[] {
  if (!isRecord(value) || !Array.isArray(value.questions)) {
    return [];
  }

  return value.questions.flatMap((question) => {
    if (!isRecord(question) || !Array.isArray(question.options)) {
      return [];
    }

    return question.options
      .map((option) => (isRecord(option) ? String(option.label ?? "") : ""))
      .filter(Boolean);
  });
}

function assertClarifiedIntentPlan(value: unknown): void {
  if (!isRecord(value)) {
    throw new Error("clarified intent plan: expected response data object");
  }

  assertNonEmptyString(value.intent, "clarified intent");
  assertNonEmptyString(value.intentSummary, "clarified intentSummary");
  assertMinArrayLength(value.focusTags, 3, "clarified focusTags");

  const searchPlan = value.searchPlan;
  if (!isRecord(searchPlan)) {
    throw new Error("clarified searchPlan: expected object");
  }

  assertMinArrayLength(searchPlan.coreQueries, 3, "clarified coreQueries");
  assertMinArrayLength(searchPlan.expandedQueries, 2, "clarified expandedQueries");
  assertMinArrayLength(searchPlan.exploratoryQueries, 1, "clarified exploratoryQueries");
  assertMinArrayLength(searchPlan.rankingSignals, 3, "clarified rankingSignals");

  const debug = value.debug;
  if (!isRecord(debug)) {
    throw new Error("clarified debug: expected object");
  }

  assertEqual(debug.stage, "intent_expand", "clarified debug.stage");
  if ("paths" in value || "people" in value || "personas" in value) {
    throw new Error("clarified intent plan must not return full demo result collections");
  }
}

async function assertQueryAwareDemoPaths(baseUrl: string): Promise<void> {
  const cases = [
    {
      query: "不工作了能去哪儿",
      expected: ["低成本地方", "存款", "回流接口"],
      forbidden: ["先确定", "算清楚", "保留回流"]
    },
    {
      query: "为了工作，异地恋值得吗",
      expected: ["接受异地", "见面规则", "异地周期"],
      forbidden: ["自由职业", "Gap", "不工作", "比较工作机会", "可逆周期"]
    },
    {
      query: "35岁转行还来得及吗",
      expected: ["35岁后", "旧经验", "项目试水"],
      forbidden: ["自由职业", "Gap", "不工作", "确认目标岗位", "小步试错"]
    }
  ];
  const titleSets: string[] = [];

  for (const item of cases) {
    const response = await requestJson(`${baseUrl}/api/demo/search`, {
      method: "POST",
      body: {
        query: item.query,
        count: 3,
        dataMode: "mock"
      }
    });
    assertEqual(response.status, 200, `${item.query} demo search status`);
    assertEqual(response.body.success, true, `${item.query} demo search success`);
    assertEqual(response.body.data.debug.originalQuery, item.query, `${item.query} originalQuery`);
    assertEqual(
      response.body.data.debug.normalizedQuery,
      item.query,
      `${item.query} normalizedQuery`
    );
    assertEqual(response.body.data.debug.pathSource, "fallback", `${item.query} pathSource`);
    assertEqual(
      typeof response.body.data.debug.cacheHit,
      "boolean",
      `${item.query} cacheHit`
    );
    assertPathExtractionFields(response.body.data.paths, response.body.data.debug, item.query);
    assertIncludes(
      response.body.data.debug.cacheKeyPreview,
      item.query,
      `${item.query} cacheKeyPreview`
    );

    const titles = response.body.data.paths.map((path: { title: string }) => path.title).join("|");
    titleSets.push(titles);

    for (const expected of item.expected) {
      assertIncludes(titles, expected, `${item.query} path titles`);
    }

    for (const forbidden of item.forbidden) {
      assertNotIncludes(titles, forbidden, `${item.query} unrelated path template`);
    }
  }

  assertEqual(new Set(titleSets).size, cases.length, "query-aware path title sets differ");
}

function assertPathExtractionFields(paths: unknown, debug: unknown, label: string): void {
  const pathItems = Array.isArray(paths) ? paths : [];
  if (pathItems.length < 3 || pathItems.length > 5) {
    throw new Error(`${label} paths expected 3-5 items, got ${pathItems.length}`);
  }

  for (const [index, rawPath] of pathItems.entries()) {
    const path = rawPath as Record<string, unknown>;
    assertNonEmptyString(path.summary, `${label} paths[${index}].summary`);
    assertNonEmptyString(path.whyRelevant, `${label} paths[${index}].whyRelevant`);
    assertNonEmptyString(path.tradeoff, `${label} paths[${index}].tradeoff`);
    assertNonEmptyArray(path.sourceRefs, `${label} paths[${index}].sourceRefs`);
    assertNonEmptyString(path.diversityKey, `${label} paths[${index}].diversityKey`);
  }

  const debugRecord = debug as Record<string, unknown>;
  assertEqual(
    typeof debugRecord.composerFallbackTriggered,
    "boolean",
    `${label} debug.composerFallbackTriggered type`
  );
  assertEqual(
    typeof debugRecord.pathDuplicateFound,
    "boolean",
    `${label} debug.pathDuplicateFound type`
  );
}

async function assertDisabledPersonaFallback(baseUrl: string): Promise<void> {
  const response = createMockDemoSearchResponse("禁用分身测试", 1, "mock");
  response.people[0].aiPersona.enabled = false;
  demoSessionCacheService.set(response);

  const personaChat = await requestJson(`${baseUrl}/api/personas/chat`, {
    method: "POST",
    body: {
      personaId: response.people[0].aiPersona.personaId,
      queryId: response.queryId,
      message: "这个分身禁用后还会调用 LLM 吗？"
    }
  });

  assertEqual(personaChat.status, 200, "disabled persona chat status");
  assertEqual(personaChat.body.success, true, "disabled persona chat success");
  assertPersonaChatExperienceReply(personaChat.body.data, "disabled persona chat");
  assertEqual(
    personaChat.body.data.boundaryNotice,
    PERSONA_CHAT_FALLBACK_BOUNDARY_NOTICE,
    "disabled persona chat fallback boundaryNotice"
  );
  assertEqual(
    personaChat.body.data.sourceRefs.length,
    0,
    "disabled persona chat fallback sourceRefs"
  );
  assertEqual(personaChat.body.data.meta.llmUsed, false, "disabled persona chat llmUsed");
  assertEqual(
    personaChat.body.data.debug.chatMode,
    "mock_fallback",
    "disabled persona chat fallback mode"
  );
  assertIncludes(
    personaChat.body.data.debug.fallbackReason,
    "PERSONA_DISABLED",
    "disabled persona fallback reason"
  );
}

async function assertDeepSeekResponseFormatFallback(): Promise<void> {
  const originalFetch = globalThis.fetch;
  const requestBodies: Array<Record<string, unknown>> = [];

  globalThis.fetch = (async (_url: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    requestBodies.push(body);

    if (requestBodies.length === 1) {
      return new Response(
        JSON.stringify({
          error: {
            message: "response_format json_object is not supported by this model"
          }
        }),
        {
          status: 400,
          headers: {
            "Content-Type": "application/json"
          }
        }
      );
    }

    return new Response(
      JSON.stringify({
        choices: [
          {
            message: {
              content: "{\"ok\":true}"
            }
          }
        ]
      }),
      {
        status: 200,
        headers: {
          "Content-Type": "application/json"
        }
      }
    );
  }) as typeof fetch;

  try {
    const content = await createOpenAICompatibleJsonCompletion(
      "deepseek",
      {
        apiKey: "test-key",
        baseUrl: "https://example.test/v1",
        model: "deepseek-v4-flash",
        timeoutMs: 1000,
        maxRetry: 0
      },
      {
        taskType: "intent_expand",
        responseFormat: { type: "json_object" },
        messages: [
          {
            role: "user",
            content: "只输出 JSON"
          }
        ]
      }
    );

    assertEqual(content, "{\"ok\":true}", "response_format fallback content");
    assertEqual(requestBodies.length, 2, "response_format fallback retry count");
    assertEqual(
      Boolean(requestBodies[0].response_format),
      true,
      "first DeepSeek request uses response_format"
    );
    assertEqual(
      Boolean(requestBodies[1].response_format),
      false,
      "second DeepSeek request drops response_format"
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
}

async function assertLoggedInUserContextInRealComposer(): Promise<void> {
  const userContext: UserContext = {
    provider: "zhihu",
    isLoggedIn: true,
    userId: "zhihu-test-user",
    displayName: "AI 产品经理",
    headline: "AI 产品经理，关注自由职业"
  };
  const response = await withStubbedOrchestrator({
    configuredTasks: new Set(),
    outputs: {},
    userContext
  });

  assertEqual(response.contextUsed?.loggedIn, true, "real context loggedIn");
  assertEqual(response.contextUsed?.zhihuProfileUsed, true, "real context profileUsed");
  assertIncludes(
    response.contextUsed?.profileSignals.join(","),
    "产品经理",
    "real context profileSignals"
  );
  assertNonEmptyString(response.paths[0].fitReason, "real path fitReason");
  assertNonEmptyString(response.people[0].fitReason, "real person fitReason");
  assertNonEmptyString(response.personas?.[0]?.fitReason, "real persona fitReason");
  assertEqual(
    JSON.stringify(response).includes("zhihu-test-user"),
    false,
    "real response does not expose userId"
  );
}

async function assertCandidateQualityPrefersExperience(): Promise<void> {
  const response = await withStubbedOrchestrator({
    configuredTasks: new Set(),
    outputs: {},
    query: "35岁转行还来得及吗",
    count: 2,
    searchItems: [
      createLowQualitySearchItem(),
      createHighQualityExperienceSearchItem()
    ]
  });

  assertEqual(response.people.length, 1, "quality filter returns only core evidence people");
  assertIncludes(
    response.people[0].articles[0].title,
    "35岁转行后",
    "quality filter keeps experience item"
  );
  assertNonEmptyArray(response.debug.candidateQuality, "candidate quality debug");
  const lowQuality = response.debug.candidateQuality?.find(
    (candidate) => candidate.candidateId === "low_quality_advice"
  );
  if (!lowQuality) {
    throw new Error("candidate quality debug missing low quality item");
  }
  assertEqual(lowQuality.usedAsEvidence, false, "low quality candidate not used as evidence");
  assertIncludes(lowQuality.filterReason, "too short", "low quality filter reason");
  const usedQuality = response.debug.candidateQuality?.find((candidate) => candidate.usedAsEvidence);
  if (!usedQuality) {
    throw new Error("candidate quality debug missing used item");
  }
  assertNonEmptyString(usedQuality.matchedQuery, "used candidate matchedQuery");
  assertNonEmptyString(usedQuality.queryType, "used candidate queryType");
  assertEqual(
    usedQuality.experienceSignalScore > lowQuality.experienceSignalScore,
    true,
    "experience candidate has stronger experience score"
  );
}

async function assertObjectiveQueryExpansionCases(): Promise<void> {
  const cases = [
    {
      query: "35岁从互联网大厂裸辞，要不要创业？",
      slots: { age: "35岁", industry: "互联网", companyType: "大厂", status: "裸辞", direction: "创业" },
      primaryIncludes: ["35岁 大厂 裸辞", "互联网大厂 裸辞 创业", "大厂 裸辞 创业"]
    },
    {
      query: "30岁女生从体制内辞职去做自媒体靠谱吗？",
      slots: { age: "30岁", companyType: "体制内", status: "辞职", direction: "自媒体" },
      primaryIncludes: ["30岁 体制内 辞职", "体制内 辞职 自媒体"]
    },
    {
      query: "产品经理被裁后，要不要转自由职业？",
      slots: { role: "产品经理", status: "被裁", direction: "自由职业" },
      primaryIncludes: ["产品经理 被裁 自由职业"]
    },
    {
      query: "在北京工作十年，想回老家开店现实吗？",
      slots: { city: "北京", status: "工作十年", direction: "回老家 开店" },
      primaryIncludes: ["北京 工作十年 回老家 开店"]
    },
    {
      query: "施工单位正式工辞职后，不知道能做什么？",
      slots: { industry: "施工单位", companyType: "正式工", role: "正式工", status: "辞职", direction: "出路" },
      primaryIncludes: ["施工单位正式工 辞职 出路", "施工单位 正式工 辞职"]
    }
  ];

  for (const [index, testCase] of cases.entries()) {
    const response = await withStubbedOrchestrator({
      configuredTasks: new Set(),
      outputs: {},
      query: testCase.query,
      count: 1,
      searchItems: [createObjectiveSearchItem(index, testCase.query)]
    });

    const intentStage = response.debug.intentStage;
    if (!intentStage.objectiveSlots || !intentStage.queryPlan) {
      throw new Error(`${testCase.query}: expected objective intent debug`);
    }

    for (const [slotName, expectedValue] of Object.entries(testCase.slots)) {
      assertEqual(
        intentStage.objectiveSlots[slotName as keyof typeof intentStage.objectiveSlots],
        expectedValue,
        `${testCase.query}: objectiveSlots.${slotName}`
      );
    }

    const primary = intentStage.queryPlan.primary;
    assertNonEmptyArray(primary, `${testCase.query}: queryPlan.primary`);
    for (const expectedQuery of testCase.primaryIncludes) {
      if (!primary.includes(expectedQuery)) {
        throw new Error(`${testCase.query}: primary query missing ${expectedQuery}; got ${primary.join(" | ")}`);
      }
    }

    assertPrimaryQueryQuality(primary, `${testCase.query}: queryPlan.primary`);
    const queriesUsed = response.debug.search?.queriesUsed ?? [];
    assertNonEmptyArray(queriesUsed, `${testCase.query}: debug.search.queriesUsed`);
    assertPrimaryQueryQuality(queriesUsed.slice(0, 3), `${testCase.query}: debug.search.queriesUsed first3`);
    const identityQueryCount = queriesUsed.filter(hasBackgroundIdentityWord).length;
    if (identityQueryCount < 2) {
      throw new Error(`${testCase.query}: expected at least 2 objective queriesUsed, got ${queriesUsed.join(" | ")}`);
    }
  }
}

function assertPrimaryQueryQuality(queries: string[], label: string): void {
  const genericWords = ["真实经历", "后悔吗", "怎么办", "值得吗", "迷茫"];
  const firstThree = queries.slice(0, 3).join(" | ");
  for (const word of genericWords) {
    assertNotIncludes(firstThree, word, label);
  }

  const objectiveCount = queries.filter(hasObjectiveIdentityWord).length;
  if (queries.length > 0 && objectiveCount / queries.length < 0.7) {
    throw new Error(`${label}: expected >=70% objective queries, got ${objectiveCount}/${queries.length}`);
  }
}

function hasObjectiveIdentityWord(query: string): boolean {
  return /[2-6]\d岁|北大|清华|985|211|三本|双非|专科|本科|硕士|博士|应届|毕业|计算机|软件|数据|机械|工厂|制造|互联网|教育|教师|老师|心理咨询|心理|医疗|金融|经管|法律|财会|中后台|施工单位|工程行业|工程|建筑|体制内|大厂|国企|外企|创业公司|银行|产品岗|产品经理|运营|程序员|技术|研发|设计|销售|市场|北京|上海|深圳|广州|杭州|成都|老家|县城|省会|一线城市|二线城市|正式工|裸辞|辞职|离职|被裁|待业|失业|不工作|在职|工作五年|工作十年|异地恋|对方城市|孩子|二胎|租房|买房|创业|自由职业|转行|转产品|回老家|开店|自媒体|内容创业|考公|读研|出路/.test(
    query
  );
}

function hasBackgroundIdentityWord(query: string): boolean {
  return /[2-6]\d岁|北大|清华|985|211|三本|双非|本科|硕士|应届|计算机|机械|互联网|教育|教师|老师|医疗|金融|经管|施工单位|工程行业|工程|建筑|体制内|大厂|国企|外企|创业公司|银行|产品经理|运营|程序员|技术|研发|设计|销售|市场|北京|上海|深圳|广州|杭州|成都|老家|县城|省会|一线城市|二线城市|正式工|异地恋|孩子|租房/.test(
    query
  );
}

async function assertNoLlmConfigFallbackKind(): Promise<void> {
  const response = await withStubbedOrchestrator({
    configuredTasks: new Set(),
    outputs: {}
  });

  assertEqual(response.debug.fallbackUsed, true, "no llm fallbackUsed");
  assertEqual(response.debug.fallbackKind, "no_llm_config", "no llm fallbackKind");
  assertIncludes(response.debug.fallbackReason, "no_llm_config", "no llm fallbackReason");
  assertSearchPlanDebug(response, "不工作了能去哪儿");
}

async function assertPartialLlmFallbackKind(): Promise<void> {
  const response = await withStubbedOrchestrator({
    configuredTasks: new Set(["intent_expand", "demo_response_compose", "grounding_guard"]),
    outputs: {
      intent_expand: JSON.stringify({
        searchQueries: ["不工作了能去哪儿"],
        intentTags: ["暂停工作"],
        userNeedSummary: "用户在寻找离开工作轨道后的路径。"
      }),
      demo_response_compose: JSON.stringify({
        analysis: {
          summary: "基于公开内容整理出几个过渡方向。",
          focusTags: ["暂停工作", "现金流"]
        },
        paths: [],
        people: [],
        personas: []
      }),
      grounding_guard: JSON.stringify({
        valid: true,
        warnings: [],
        disablePersonaPersonIds: [],
        disablePersonaIds: []
      })
    }
  });

  assertEqual(response.debug.fallbackUsed, true, "partial llm fallbackUsed");
  assertEqual(
    response.debug.fallbackKind,
    "partial_llm_fallback",
    "partial llm fallbackKind"
  );
  assertIncludes(response.debug.fallbackReason, "evidence_extract", "partial llm fallbackReason");
  assertSearchPlanDebug(response, "不工作了能去哪儿");
}

async function assertGroundingGuardInvalidFallback(): Promise<void> {
  const response = await withStubbedOrchestrator({
    configuredTasks: new Set(["grounding_guard"]),
    outputs: {
      grounding_guard: JSON.stringify({
        valid: false,
        warnings: [],
        disablePersonaPersonIds: [],
        disablePersonaIds: []
      })
    }
  });

  assertEqual(response.debug.fallbackUsed, true, "invalid guard fallbackUsed");
  assertEqual(response.debug.fallbackKind, "all_llm_failed", "invalid guard fallbackKind");
  assertIncludes(
    response.debug.guardWarnings.join("\n"),
    "grounding_guard invalid",
    "invalid guard warning"
  );
  assertEqual(
    response.people.every((person) => person.aiPersona.enabled === false),
    true,
    "invalid guard disables all personas"
  );
}

interface StubbedOrchestratorOptions {
  configuredTasks: Set<LlmTaskType>;
  outputs: Partial<Record<LlmTaskType, string>>;
  userContext?: UserContext;
  clarificationContext?: DemoDebugClarificationContext;
  query?: string;
  count?: number;
  searchItems?: SearchItem[];
}

async function withStubbedOrchestrator(options: StubbedOrchestratorOptions) {
  const originalSearch = searchService.search;
  const originalIsTaskConfigured = llmRouter.isTaskConfigured;
  const originalRunJsonTask = llmRouter.runJsonTask;

  searchService.search = async (query, count) => ({
    query,
    count,
    hasMore: false,
    searchHashId: "stub",
    items: options.searchItems ?? [createStubSearchItem()]
  });
  llmRouter.isTaskConfigured = ((taskType) =>
    options.configuredTasks.has(taskType)) as typeof llmRouter.isTaskConfigured;
  llmRouter.runJsonTask = (async (taskType) => {
    const output = options.outputs[taskType];
    if (!output) {
      throw new Error(`missing stub LLM output for ${taskType}`);
    }
    return output;
  }) as typeof llmRouter.runJsonTask;

  try {
    return await composeMultiLlmDemoSearchResponse({
      query: options.query ?? "不工作了能去哪儿",
      count: options.count ?? 1,
      dataMode: "real",
      startedAt: Date.now(),
      userContext: options.userContext,
      clarificationContext: options.clarificationContext
    });
  } finally {
    searchService.search = originalSearch;
    llmRouter.isTaskConfigured = originalIsTaskConfigured;
    llmRouter.runJsonTask = originalRunJsonTask;
  }
}

function createLoggedInSessionCookie(): string {
  const headers = new Map<string, string | string[]>();
  const res = {
    getHeader(name: string) {
      return headers.get(name.toLowerCase());
    },
    setHeader(name: string, value: string | string[]) {
      headers.set(name.toLowerCase(), value);
    }
  };

  createAuthSession(res as unknown as Response, {
    provider: "zhihu",
    userInfoLoaded: true,
    user: {
      id: "zhihu-test-user",
      provider: "zhihu",
      displayName: "AI 产品经理",
      avatar: "https://example.test/avatar.png",
      profileUrl: "https://www.zhihu.com/people/ai-product-manager",
      headline: "AI 产品经理，关注自由职业",
      isTemporary: false,
      userInfoLoaded: true,
      raw: {
        fixture: true
      }
    },
    token: {
      accessToken: "test-access-token",
      tokenType: "Bearer",
      expiresIn: 3600,
      expiresAt: new Date(Date.now() + 3600 * 1000).toISOString()
    }
  });

  const setCookieHeader = headers.get("set-cookie");
  const firstCookie = Array.isArray(setCookieHeader) ? setCookieHeader[0] : setCookieHeader;
  if (!firstCookie) {
    throw new Error("test auth session did not set a cookie");
  }

  return firstCookie.split(";")[0];
}

function assertSearchPlanDebug(response: Awaited<ReturnType<typeof withStubbedOrchestrator>>, query: string): void {
  if (!response.debug.intentStage.objectiveSlots || !response.debug.intentStage.queryPlan) {
    throw new Error("debug.intentStage must include objectiveSlots and queryPlan");
  }

  const searchQueries = response.debug.searchQueries;
  assertNonEmptyArray(searchQueries, "debug.searchQueries");
  if (!searchQueries || searchQueries.length < 8) {
    throw new Error(`debug.searchQueries expected at least 8 items, got ${searchQueries?.length ?? 0}`);
  }

  assertEqual(searchQueries[0].query, query, "debug.searchQueries[0].query");
  assertEqual(searchQueries[0].type, "original", "debug.searchQueries[0].type");
  const queryTypes = new Set(searchQueries.map((item) => item.type));
  if (queryTypes.size < 5) {
    throw new Error(`debug.searchQueries expected at least 5 query types, got ${Array.from(queryTypes).join(",")}`);
  }

  const searchQueryResults = response.debug.searchQueryResults;
  assertNonEmptyArray(searchQueryResults, "debug.searchQueryResults");
  const searchDebug = response.debug.search;
  if (!searchDebug) {
    throw new Error("debug.search missing");
  }
  assertNonEmptyArray(searchDebug.queriesUsed, "debug.search.queriesUsed");
  if (searchDebug.queriesUsed.length < 3 || searchDebug.queriesUsed.length > 6) {
    throw new Error(`debug.search.queriesUsed expected 3-6 items, got ${searchDebug.queriesUsed.length}`);
  }
  assertNonEmptyArray(searchDebug.searchRounds, "debug.search.searchRounds");
  assertEqual(
    searchDebug.searchRounds.length,
    searchDebug.queriesUsed.length,
    "debug.search.searchRounds length"
  );
  assertEqual(searchQueryResults?.length, searchDebug.searchRounds.length, "debug.searchQueryResults length");
  for (const result of searchQueryResults ?? []) {
    if (!Number.isFinite(result.returnedCount)) {
      throw new Error(`debug.searchQueryResults returnedCount missing for ${result.query}`);
    }
  }
  if (!Number.isFinite(searchDebug.totalRawResults) || searchDebug.totalRawResults <= 0) {
    throw new Error("debug.search.totalRawResults expected > 0");
  }
  if (!Number.isFinite(searchDebug.totalDedupedCandidates) || searchDebug.totalDedupedCandidates <= 0) {
    throw new Error("debug.search.totalDedupedCandidates expected > 0");
  }
  if (typeof searchDebug.degraded !== "boolean") {
    throw new Error("debug.search.degraded expected boolean");
  }
  assertNonEmptyArray(searchDebug.candidates, "debug.search.candidates");
  for (const candidate of searchDebug.candidates ?? []) {
    assertNonEmptyString(candidate.title, "debug.search.candidates.title");
    assertNonEmptyString(candidate.url, "debug.search.candidates.url");
    assertNonEmptyString(candidate.queryUsed, "debug.search.candidates.queryUsed");
  }

  if (
    !Number.isFinite(response.debug.rawCandidateCount) ||
    !Number.isFinite(response.debug.mergedCandidateCount) ||
    !Number.isFinite(response.debug.dedupedCandidateCount) ||
    !Number.isFinite(response.debug.validCandidateCount)
  ) {
    throw new Error("debug candidate counts must include raw/merged/deduped/valid counts");
  }

  assertNonEmptyArray(response.debug.topicSignals, "debug.topicSignals");
  assertNonEmptyArray(response.debug.finalCandidates, "debug.finalCandidates");
  if (!response.debug.finalCandidates?.every((candidate) => candidate.relationToUserIntent && candidate.summaryAngle)) {
    throw new Error("debug.finalCandidates must include relationToUserIntent and summaryAngle");
  }
  if (!response.debug.finalCandidates?.every((candidate) => candidate.diversityKey && candidate.sourceRefs?.length)) {
    throw new Error("debug.finalCandidates must include diversityKey and sourceRefs");
  }
}

function createStubSearchItem(): SearchItem {
  return {
    id: "stub_answer_1",
    type: "answer",
    title: "不工作以后怎么安排生活",
    text:
      "我裸辞以后先把每天的生活重新排好，先算存款能撑多久，再考虑要不要找小城市停靠。这个过程里最重要的是现金流和日常节奏。",
    url: "https://www.zhihu.com/question/stub/answer/1",
    author: {
      name: "知乎用户",
      avatar: "",
      badge: "",
      badgeText: ""
    },
    stats: {
      commentCount: 0,
      voteUpCount: 0,
      rankingScore: 0
    },
    comments: [],
    editTime: 0,
    authorityLevel: "",
    source: {
      provider: "zhihu",
      url: "https://www.zhihu.com/question/stub/answer/1"
    },
    evidence: {
      text: "先算存款能撑多久，再考虑要不要找小城市停靠",
      source: {
        provider: "zhihu",
        url: "https://www.zhihu.com/question/stub/answer/1"
      }
    }
  };
}

function createLowQualitySearchItem(): SearchItem {
  return {
    ...createStubSearchItem(),
    id: "low_quality_advice",
    title: "35岁转行还来得及吗",
    text: "建议努力学习，保持心态。",
    url: "https://www.zhihu.com/question/stub/answer/low",
    evidence: {
      text: "建议努力学习，保持心态。",
      source: {
        provider: "zhihu",
        url: "https://www.zhihu.com/question/stub/answer/low"
      }
    }
  };
}

function createHighQualityExperienceSearchItem(): SearchItem {
  return {
    ...createStubSearchItem(),
    id: "high_quality_experience",
    title: "35岁转行后，我先做项目再去面试",
    text:
      "我35岁那年决定从传统销售转到运营。刚开始没有直接辞职，而是用半年时间做了两个小项目，晚上补作品集，后来拿着项目去面试。结果第一份新工作薪资下降了一点，但三个月后我发现旧行业的客户沟通经验能迁移过来，后面才慢慢稳定。",
    url: "https://www.zhihu.com/question/stub/answer/high",
    evidence: {
      text: "我35岁那年决定从传统销售转到运营，先用半年时间做了两个小项目，后来拿着项目去面试。",
      source: {
        provider: "zhihu",
        url: "https://www.zhihu.com/question/stub/answer/high"
      }
    }
  };
}

function createObjectiveSearchItem(index: number, query: string): SearchItem {
  return {
    ...createStubSearchItem(),
    id: `objective_query_${index}`,
    title: `${query} 相似经历复盘`,
    text:
      `${query} 这类处境里，我先记录了自己的岗位、当前状态、选择方向和现金流约束，再去看相似背景的人如何处理。` +
      "后来我发现真正有参考价值的不是泛泛建议，而是年龄、行业、城市、离职状态和下一步方向都接近的公开经历。",
    url: `https://www.zhihu.com/question/stub/answer/objective-${index}`,
    evidence: {
      text: `${query} 需要优先对照年龄、行业、城市、状态和方向都接近的公开经历。`,
      source: {
        provider: "zhihu",
        url: `https://www.zhihu.com/question/stub/answer/objective-${index}`
      }
    },
    source: {
      provider: "zhihu",
      url: `https://www.zhihu.com/question/stub/answer/objective-${index}`
    }
  };
}
