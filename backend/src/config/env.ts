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

function parsePositiveInteger(value: string | undefined, fallback: number): number {
  if (!value) {
    return fallback;
  }

  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export const config = {
  nodeEnv: process.env.NODE_ENV || process.env.APP_ENV || "development",
  host: process.env.HOST || "127.0.0.1",
  port: parsePositiveInteger(process.env.PORT ?? process.env.BACKEND_PORT, 8000),
  frontendUrl: process.env.FRONTEND_URL || "http://127.0.0.1:5173",
  sessionSecret: process.env.SESSION_SECRET || "dev-session-secret",
  zhihu: {
    accessSecret: process.env.ZH_ACCESS_SECRET ?? process.env.ZHIHU_API_KEY ?? "",
    appId: process.env.ZHIHU_APP_ID || "",
    appKey: process.env.ZHIHU_APP_KEY || "",
    redirectUri:
      process.env.ZHIHU_REDIRECT_URI || "http://127.0.0.1:3001/auth/zhihu/callback",
    openapiBase: process.env.ZHIHU_OPENAPI_BASE || DEFAULT_ZHIHU_OPENAPI_BASE,
    userinfoPath: process.env.ZHIHU_USERINFO_PATH || "",
    searchApiUrl: process.env.ZH_SEARCH_API_URL || DEFAULT_ZHIHU_SEARCH_API_URL,
    timeoutMs: parsePositiveInteger(
      process.env.ZH_API_TIMEOUT_MS ?? process.env.ZHIHU_API_TIMEOUT,
      10000
    )
  }
};
