import { once } from "node:events";
import type { Response } from "express";
import { app } from "../app.js";
import { createAuthSession, type UserContext } from "../auth/session.js";
import { llmRouter, type LlmTaskType } from "../llm/llmRouter.js";
import { createOpenAICompatibleJsonCompletion } from "../llm/clients/openaiCompatible.js";
import { composeMultiLlmDemoSearchResponse } from "../llm/demoSearchOrchestrator.js";
import { createMockDemoSearchResponse } from "../mocks/demoSearch.mock.js";
import { demoSessionCacheService } from "../services/demoSessionCache.service.js";
import { searchService } from "../services/search.service.js";
import {
  DEMO_PERSONA_BOUNDARY_NOTICE,
  PERSONA_CHAT_FALLBACK_BOUNDARY_NOTICE
} from "../types/demo.types.js";
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
  assertNonEmptyArray(demoSearch.body.data.personas, "demo personas");
  assertClarifyingCard(demoSearch.body.data.clarifyingCard, "demo clarifyingCard");
  assertObjectiveClarifyingCard(demoSearch.body.data.clarifyingCard, "demo objective clarifyingCard");
  await assertContextualObjectiveClarifyingCards(baseUrl);
  await assertEvaluationStageClarifyingCards(baseUrl);
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
  assertNonEmptyArray(clarifiedDemoSearch.body.data.personas, "clarified demo personas");
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

  const personaId = demoSearch.body.data.personas[0].id;
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

function assertNonEmptyString(value: unknown, label: string): void {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${label}: expected non-empty string`);
  }
}

function assertIncludes(value: unknown, expected: string, label: string): void {
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

function assertObjectiveClarifyingCard(value: unknown, label: string): void {
  if (!isRecord(value)) {
    throw new Error(`${label}: expected clarifying card object`);
  }

  const questions = Array.isArray(value.questions) ? value.questions : [];
  const questionIds = questions
    .map((question) => (isRecord(question) ? question.id : ""))
    .filter(Boolean);
  const searchableQuestionIds = [
    "role",
    "status",
    "direction",
    "constraint",
    "industry",
    "companyType",
    "city",
    "age",
    "home_plan",
    "shop_preparation",
    "cash_runway",
    "cashflow_source",
    "monetizable_resource",
    "indie_basis",
    "home_resource",
    "trial_budget",
    "current_resource",
    "content_basis"
  ];
  const objectiveQuestionCount = questionIds.filter((id) =>
    searchableQuestionIds.includes(String(id))
  ).length;
  if (objectiveQuestionCount < 3) {
    throw new Error(`${label}: expected at least 3 searchable objective slot questions`);
  }

  const labels = questions
    .map((question) => (isRecord(question) ? String(question.label) : ""))
    .join("\n");
  for (const forbidden of ["最担心", "怕不怕后悔", "是不是很迷茫"]) {
    assertNotIncludes(labels, forbidden, `${label}.labels`);
  }
}

async function assertContextualObjectiveClarifyingCards(baseUrl: string): Promise<void> {
  const shanghaiResponse = await requestJson(`${baseUrl}/api/demo/search`, {
    method: "POST",
    body: {
      query: "在上海工作很多年，想辞职回老家生活可以吗？",
      count: 3,
      dataMode: "mock"
    }
  });
  const shopResponse = await requestJson(`${baseUrl}/api/demo/search`, {
    method: "POST",
    body: {
      query: "国企上班太压抑，辞职开咖啡店现实吗？",
      count: 3,
      dataMode: "mock"
    }
  });

  assertEqual(shanghaiResponse.status, 200, "contextual shanghai clarification status");
  assertEqual(shopResponse.status, 200, "contextual shop clarification status");
  const shanghaiCard = shanghaiResponse.body.data.clarifyingCard;
  const shopCard = shopResponse.body.data.clarifyingCard;
  assertEqual(
    shopResponse.body.data.debug.intentStage.objectiveSlots.direction,
    "开店",
    "contextual shop objectiveSlots.direction"
  );
  assertClarifyingCard(shanghaiCard, "contextual shanghai clarifyingCard");
  assertClarifyingCard(shopCard, "contextual shop clarifyingCard");
  assertObjectiveClarifyingCard(shanghaiCard, "contextual shanghai objective clarifyingCard");
  assertObjectiveClarifyingCard(shopCard, "contextual shop objective clarifyingCard");

  const shanghaiLabels = readClarifyingCardQuestionLabels(shanghaiCard).join("\n");
  const shopLabels = readClarifyingCardQuestionLabels(shopCard).join("\n");
  if (shanghaiLabels === shopLabels) {
    throw new Error("contextual objective clarifying cards should not reuse identical questions");
  }

  assertIncludes(shanghaiLabels, "回老家", "contextual shanghai labels");
  assertIncludes(shopLabels, "开店", "contextual shop labels");
  assertNoEvaluationStageMismatch(shanghaiLabels, "contextual shanghai labels");
  assertNoEvaluationStageMismatch(shopLabels, "contextual shop labels");
}

async function assertEvaluationStageClarifyingCards(baseUrl: string): Promise<void> {
  const cases = [
    {
      query: "产品经理被裁后，要不要转自由职业？",
      direction: "自由职业",
      expectedLabels: [
        "目前可支撑多久没有稳定工资？",
        "现在是否有稳定现金流或项目来源？",
        "已有可变现资源更接近哪类？"
      ]
    },
    {
      query: "在北京工作十年，想回老家开店现实吗？",
      direction: "回老家 开店",
      expectedLabels: [
        "你之前主要做什么岗位？",
        "如果回老家，目前最明确的现实资源是什么？",
        "当前能承受的试错成本更接近哪种？"
      ]
    },
    {
      query: "大厂程序员被裁后，去做独立开发靠谱吗？",
      direction: "独立开发",
      expectedLabels: [
        "目前可支撑多久没有稳定工资？",
        "独立开发现在已有的基础是什么？",
        "现在是否有稳定现金流或项目来源？"
      ]
    }
  ];

  for (const testCase of cases) {
    const response = await requestJson(`${baseUrl}/api/demo/search`, {
      method: "POST",
      body: {
        query: testCase.query,
        count: 3,
        dataMode: "mock"
      }
    });

    assertEqual(response.status, 200, `${testCase.query}: clarification status`);
    assertEqual(
      response.body.data.debug.intentStage.objectiveSlots.direction,
      testCase.direction,
      `${testCase.query}: objectiveSlots.direction`
    );
    const card = response.body.data.clarifyingCard;
    assertClarifyingCard(card, `${testCase.query}: clarifyingCard`);
    assertObjectiveClarifyingCard(card, `${testCase.query}: objective clarifyingCard`);
    const labels = readClarifyingCardQuestionLabels(card).join("\n");
    for (const expectedLabel of testCase.expectedLabels) {
      assertIncludes(labels, expectedLabel, `${testCase.query}: labels`);
    }
    assertNoEvaluationStageMismatch(labels, `${testCase.query}: labels`);
  }
}

function assertNoEvaluationStageMismatch(labels: string, label: string): void {
  for (const forbidden of ["最大现实压力", "最大的现实压力", "最缺哪块准备", "考虑的方向是什么"]) {
    assertNotIncludes(labels, forbidden, label);
  }
}

function readClarifyingCardQuestionLabels(value: unknown): string[] {
  if (!isRecord(value) || !Array.isArray(value.questions)) {
    return [];
  }

  return value.questions
    .map((question) => (isRecord(question) ? String(question.label ?? "") : ""))
    .filter(Boolean);
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
  assertNonEmptyString(response.personas[0].fitReason, "real persona fitReason");
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
  return /[2-6]\d岁|互联网|教育|医疗|施工单位|建筑|体制内|大厂|国企|外企|创业公司|产品经理|运营|程序员|技术|研发|设计|销售|市场|北京|上海|深圳|广州|杭州|成都|老家|县城|一线城市|二线城市|正式工|裸辞|辞职|离职|被裁|待业|失业|不工作|在职|工作十年|创业|自由职业|转行|回老家|开店|自媒体|出路/.test(
    query
  );
}

function hasBackgroundIdentityWord(query: string): boolean {
  return /[2-6]\d岁|互联网|教育|医疗|施工单位|建筑|体制内|大厂|国企|外企|创业公司|产品经理|运营|程序员|技术|研发|设计|销售|市场|北京|上海|深圳|广州|杭州|成都|老家|县城|一线城市|二线城市|正式工/.test(
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
      userContext: options.userContext
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
