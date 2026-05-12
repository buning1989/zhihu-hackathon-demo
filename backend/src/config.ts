import dotenv from "dotenv";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

for (const envPath of [
  resolve(process.cwd(), ".env.local"),
  resolve(process.cwd(), "..", ".env.local")
]) {
  if (existsSync(envPath)) {
    dotenv.config({ path: envPath });
  }
}

const DEFAULT_ZHIHU_SEARCH_API_URL =
  "https://developer.zhihu.com/api/v1/content/zhihu_search";

function parsePositiveInteger(value: string | undefined, fallback: number): number {
  if (!value) {
    return fallback;
  }

  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export const config = {
  host: process.env.HOST || "127.0.0.1",
  port: parsePositiveInteger(process.env.PORT, 3001),
  zhihu: {
    accessSecret: process.env.ZH_ACCESS_SECRET ?? "",
    searchApiUrl: process.env.ZH_SEARCH_API_URL || DEFAULT_ZHIHU_SEARCH_API_URL,
    timeoutMs: parsePositiveInteger(process.env.ZH_API_TIMEOUT_MS, 10000)
  }
};
