import dotenv from "dotenv";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

const envPaths = [
  resolve(process.cwd(), ".env.local"),
  resolve(process.cwd(), "..", ".env.local")
];

for (const envPath of envPaths) {
  if (existsSync(envPath)) {
    dotenv.config({ path: envPath, override: false });
  }
}

const DEFAULT_ZHIHU_SEARCH_API_URL =
  "https://developer.zhihu.com/api/v1/content/zhihu_search";
const DEFAULT_ZHIHU_OPENAPI_BASE = "https://openapi.zhihu.com";
const DEFAULT_KIMI_BASE_URL = "https://api.moonshot.cn/v1";
const DEFAULT_DEEPSEEK_BASE_URL = "https://api.deepseek.com";
const DATA_MODES = new Set(["mock", "cache_first", "real"]);
const LLM_PROVIDERS = new Set(["openai_compatible"]);
const AGENT_LLM_PROVIDERS = new Set(["deepseek", "kimi"]);
const AGENT_LLM_TEST_MODES = new Set(["mock", "real"]);
const zhihuAccessSecret = firstNonEmpty(process.env.ZH_ACCESS_SECRET, process.env.ZHIHU_API_KEY);
const zhihuOpenapiBase = firstNonEmpty(
  process.env.ZHIHU_OPENAPI_BASE_URL,
  process.env.ZHIHU_OPENAPI_BASE
);
const kimiApiKey = firstNonEmpty(process.env.KIMI_API_KEY);
const deepseekApiKey = firstNonEmpty(process.env.DEEPSEEK_API_KEY);
const legacyLlmApiKey = firstNonEmpty(process.env.LLM_API_KEY);

function parsePositiveInteger(value: string | undefined, fallback: number): number {
  if (!value) {
    return fallback;
  }

  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseNonNegativeInteger(value: string | undefined, fallback: number): number {
  if (!value) {
    return fallback;
  }

  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

export const config = {
  nodeEnv: process.env.NODE_ENV || process.env.APP_ENV || "development",
  dataMode: parseDataMode(process.env.DATA_MODE, zhihuAccessSecret ? "real" : "mock"),
  databaseUrl: firstNonEmpty(process.env.DATABASE_URL),
  redisUrl: firstNonEmpty(process.env.REDIS_URL),
  agent: {
    taskTtlHours: parsePositiveInteger(process.env.AGENT_TASK_TTL_HOURS, 24),
    queueName: firstNonEmpty(process.env.AGENT_QUEUE_NAME) || "agent-tasks",
    llm: {
      enabled: parseBoolean(process.env.AGENT_LLM_ENABLED, false),
      provider: parseAgentLlmProvider(process.env.AGENT_LLM_PROVIDER),
      model: firstNonEmpty(process.env.AGENT_LLM_MODEL),
      timeoutMs: parsePositiveInteger(process.env.AGENT_LLM_TIMEOUT_MS, 90000),
      retries: parseNonNegativeInteger(process.env.AGENT_LLM_RETRIES, 1),
      testMode: parseAgentLlmTestMode(process.env.AGENT_LLM_TEST_MODE)
    }
  },
  host: process.env.HOST || "127.0.0.1",
  port: parsePositiveInteger(process.env.PORT ?? process.env.BACKEND_PORT, 8000),
  frontendUrl: process.env.FRONTEND_URL || "http://127.0.0.1:5173",
  sessionSecret: process.env.SESSION_SECRET || "dev-session-secret",
  zhihu: {
    accessSecret: zhihuAccessSecret,
    appId: process.env.ZHIHU_APP_ID || "",
    appKey: process.env.ZHIHU_APP_KEY || "",
    redirectUri:
      process.env.ZHIHU_REDIRECT_URI || "http://127.0.0.1:3001/auth/zhihu/callback",
    openapiBase: zhihuOpenapiBase || DEFAULT_ZHIHU_OPENAPI_BASE,
    openapiAppKey: firstNonEmpty(process.env.ZHIHU_OPENAPI_APP_KEY),
    openapiAppSecret: firstNonEmpty(process.env.ZHIHU_OPENAPI_APP_SECRET),
    userinfoPath: process.env.ZHIHU_USERINFO_PATH || "",
    searchApiUrl: process.env.ZH_SEARCH_API_URL || DEFAULT_ZHIHU_SEARCH_API_URL,
    timeoutMs: parsePositiveInteger(
      process.env.ZH_API_TIMEOUT_MS ?? process.env.ZHIHU_API_TIMEOUT,
      10000
    )
  },
  llm: {
    enabled: parseBoolean(
      process.env.LLM_ENABLED,
      Boolean(kimiApiKey || deepseekApiKey || legacyLlmApiKey)
    ),
    maxRetry: parseNonNegativeInteger(process.env.LLM_MAX_RETRY, 1),
    provider: parseLlmProvider(process.env.LLM_PROVIDER),
    apiKey: legacyLlmApiKey,
    baseUrl: firstNonEmpty(process.env.LLM_BASE_URL),
    model: firstNonEmpty(process.env.LLM_MODEL),
    timeoutMs: parsePositiveInteger(process.env.LLM_TIMEOUT_MS, 15000),
    kimi: {
      apiKey: kimiApiKey,
      baseUrl: firstNonEmpty(process.env.KIMI_BASE_URL) || DEFAULT_KIMI_BASE_URL,
      model: firstNonEmpty(process.env.KIMI_MODEL) || "moonshot-v1-8k"
    },
    deepseek: {
      apiKey: deepseekApiKey,
      baseUrl: firstNonEmpty(process.env.DEEPSEEK_BASE_URL) || DEFAULT_DEEPSEEK_BASE_URL,
      model: firstNonEmpty(process.env.DEEPSEEK_MODEL) || "deepseek-chat",
      jsonMode: parseBoolean(process.env.DEEPSEEK_JSON_MODE, true)
    }
  }
};

function parseDataMode(
  value: string | undefined,
  fallback: "mock" | "cache_first" | "real"
): "mock" | "cache_first" | "real" {
  return value && DATA_MODES.has(value) ? (value as "mock" | "cache_first" | "real") : fallback;
}

function firstNonEmpty(...values: Array<string | undefined>): string {
  return values.find((value) => value?.trim())?.trim() ?? "";
}

function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  if (!value) {
    return fallback;
  }

  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) {
    return true;
  }

  if (["0", "false", "no", "off"].includes(normalized)) {
    return false;
  }

  return fallback;
}

function parseLlmProvider(value: string | undefined): "openai_compatible" {
  return value && LLM_PROVIDERS.has(value) ? (value as "openai_compatible") : "openai_compatible";
}

function parseAgentLlmProvider(value: string | undefined): "deepseek" | "kimi" {
  return value && AGENT_LLM_PROVIDERS.has(value) ? (value as "deepseek" | "kimi") : "deepseek";
}

function parseAgentLlmTestMode(value: string | undefined): "mock" | "real" {
  return value && AGENT_LLM_TEST_MODES.has(value) ? (value as "mock" | "real") : "real";
}
