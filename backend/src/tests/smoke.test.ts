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
        model: "deepseek-chat",
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
  assertEqual(searchQueryResults?.length, searchQueries.length, "debug.searchQueryResults length");
  for (const result of searchQueryResults ?? []) {
    if (!Number.isFinite(result.returnedCount)) {
      throw new Error(`debug.searchQueryResults returnedCount missing for ${result.query}`);
    }
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
