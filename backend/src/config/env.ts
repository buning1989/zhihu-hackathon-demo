import dotenv from "dotenv";
import { existsSync } from "node:fs";
import { basename, resolve } from "node:path";

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
const DEFAULT_DEEPSEEK_STAGE_MODEL = "deepseek-v4-flash";
const DATA_MODES = new Set(["mock", "cache_first", "replay", "real"]);
const LLM_PROVIDERS = new Set(["openai_compatible"]);
const AGENT_TASK_STORES = new Set(["sqlite", "memory"]);
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
  dataMode: parseDataMode(process.env.DATA_MODE, "mock"),
  host: process.env.HOST || "127.0.0.1",
  port: parsePositiveInteger(process.env.PORT ?? process.env.BACKEND_PORT, 8000),
  frontendUrl: process.env.FRONTEND_URL || "http://127.0.0.1:5173",
  sessionSecret: process.env.SESSION_SECRET || "dev-session-secret",
  demoSearch: {
    requestBudgetMs: parsePositiveInteger(process.env.DEMO_SEARCH_BUDGET_MS, 75000)
  },
  agentTask: {
    store: parseAgentTaskStore(process.env.AGENT_TASK_STORE),
    dbPath: firstNonEmpty(process.env.AGENT_TASK_DB_PATH) || defaultAgentTaskDbPath(),
    timeouts: {
      evidenceExtractMs: parsePositiveInteger(process.env.AGENT_EVIDENCE_TIMEOUT_MS, 18000),
      experienceSummaryMs: parsePositiveInteger(process.env.AGENT_EXPERIENCE_SUMMARY_TIMEOUT_MS, 18000)
    }
  },
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
    ),
    fixtureDir: firstNonEmpty(process.env.ZH_API_FIXTURE_DIR) || defaultZhihuFixtureDir(),
    usageLogDir: firstNonEmpty(process.env.ZH_API_USAGE_LOG_DIR) || defaultZhihuUsageLogDir(),
    dailyDevBudget: parseNonNegativeInteger(process.env.ZH_API_DAILY_DEV_BUDGET, 50),
    allowRealApi: parseBoolean(process.env.ALLOW_REAL_ZH_API, false)
  },
  llm: {
    enabled: parseBoolean(
      process.env.LLM_ENABLED,
      Boolean(deepseekApiKey || legacyLlmApiKey)
    ),
    maxRetry: parseNonNegativeInteger(process.env.LLM_MAX_RETRY, 1),
    provider: parseLlmProvider(process.env.LLM_PROVIDER),
    apiKey: legacyLlmApiKey,
    baseUrl: firstNonEmpty(process.env.LLM_BASE_URL),
    model: firstNonEmpty(process.env.LLM_MODEL),
    timeoutMs: parsePositiveInteger(process.env.LLM_TIMEOUT_MS, 15000),
    taskTimeouts: {
      similarityClarificationPlanMs: parsePositiveInteger(
        process.env.SIMILARITY_CLARIFICATION_TIMEOUT_MS,
        24000
      ),
      intentExpandMs: parsePositiveInteger(
        process.env.INTENT_EXPAND_TIMEOUT_MS,
        45000
      ),
      candidateRerankMs: parsePositiveInteger(
        process.env.CANDIDATE_RERANK_TIMEOUT_MS,
        12000
      ),
      evidenceExtractMs: parsePositiveInteger(
        process.env.EVIDENCE_EXTRACT_TIMEOUT_MS,
        12000
      ),
      demoResponseComposeMs: parsePositiveInteger(
        process.env.DEMO_RESPONSE_COMPOSE_TIMEOUT_MS,
        15000
      ),
      experienceSummaryMs: parsePositiveInteger(
        process.env.EXPERIENCE_SUMMARY_TIMEOUT_MS,
        12000
      ),
      groundingGuardMs: parsePositiveInteger(
        process.env.GROUNDING_GUARD_TIMEOUT_MS,
        8000
      ),
      personaChatMs: parsePositiveInteger(
        process.env.PERSONA_CHAT_TIMEOUT_MS,
        8000
      )
    },
    kimi: {
      apiKey: kimiApiKey,
      baseUrl: firstNonEmpty(process.env.KIMI_BASE_URL) || DEFAULT_KIMI_BASE_URL,
      model: firstNonEmpty(process.env.KIMI_MODEL) || "moonshot-v1-8k"
    },
    deepseek: {
      apiKey: deepseekApiKey,
      baseUrl: firstNonEmpty(process.env.DEEPSEEK_BASE_URL) || DEFAULT_DEEPSEEK_BASE_URL,
      defaultModel: DEFAULT_DEEPSEEK_STAGE_MODEL,
      models: {
        similarity_clarification_plan:
          firstNonEmpty(process.env.SIMILARITY_CLARIFICATION_PLAN_MODEL) ||
          DEFAULT_DEEPSEEK_STAGE_MODEL,
        intent_expand: firstNonEmpty(process.env.INTENT_EXPAND_MODEL) || DEFAULT_DEEPSEEK_STAGE_MODEL,
        candidate_rerank:
          firstNonEmpty(process.env.CANDIDATE_RERANK_MODEL) || DEFAULT_DEEPSEEK_STAGE_MODEL,
        evidence_extract:
          firstNonEmpty(process.env.EVIDENCE_EXTRACT_MODEL) || DEFAULT_DEEPSEEK_STAGE_MODEL,
        demo_response_compose:
          firstNonEmpty(process.env.DEMO_RESPONSE_COMPOSE_MODEL) || DEFAULT_DEEPSEEK_STAGE_MODEL,
        experience_summary:
          firstNonEmpty(process.env.EXPERIENCE_SUMMARY_MODEL) || DEFAULT_DEEPSEEK_STAGE_MODEL,
        grounding_guard:
          firstNonEmpty(process.env.GROUNDING_GUARD_MODEL) || DEFAULT_DEEPSEEK_STAGE_MODEL,
        persona_chat:
          firstNonEmpty(process.env.PERSONA_CHAT_MODEL) || DEFAULT_DEEPSEEK_STAGE_MODEL,
        json_repair: firstNonEmpty(process.env.JSON_REPAIR_MODEL) || DEFAULT_DEEPSEEK_STAGE_MODEL
      },
      jsonMode: parseBoolean(process.env.DEEPSEEK_JSON_MODE, true),
      intentExpandJsonMode: parseBoolean(process.env.INTENT_EXPAND_JSON_MODE, true)
    }
  }
};

function parseDataMode(
  value: string | undefined,
  fallback: "mock" | "cache_first" | "replay" | "real"
): "mock" | "cache_first" | "replay" | "real" {
  return value && DATA_MODES.has(value)
    ? (value as "mock" | "cache_first" | "replay" | "real")
    : fallback;
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

function parseAgentTaskStore(value: string | undefined): "sqlite" | "memory" {
  const normalized = value?.trim().toLowerCase();
  return normalized && AGENT_TASK_STORES.has(normalized) ? (normalized as "sqlite" | "memory") : "sqlite";
}

function defaultAgentTaskDbPath(): string {
  const cwd = process.cwd();
  const repoRoot = basename(cwd) === "backend" ? resolve(cwd, "..") : cwd;
  return resolve(repoRoot, "data", "agent-tasks.sqlite");
}

function defaultZhihuFixtureDir(): string {
  const cwd = process.cwd();
  const repoRoot = basename(cwd) === "backend" ? resolve(cwd, "..") : cwd;
  return resolve(repoRoot, "backend", "fixtures", "zhihu-search");
}

function defaultZhihuUsageLogDir(): string {
  const cwd = process.cwd();
  const repoRoot = basename(cwd) === "backend" ? resolve(cwd, "..") : cwd;
  return resolve(repoRoot, "data", "zhihu-api-usage");
}
