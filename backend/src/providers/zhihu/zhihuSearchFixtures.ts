import { createHash } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync
} from "node:fs";
import { join } from "node:path";
import { config } from "../../config/env.js";
import { HttpError } from "../../utils/httpError.js";
import type {
  ZhihuSearchDataMode,
  ZhihuSearchOptions,
  ZhihuSearchParams,
  ZhihuSearchRawResponse
} from "./zhihu.types.js";

interface ZhihuFixtureRecord {
  filePath: string;
  id: string;
  recordedAt: string;
  query: string;
  normalizedQueries: string[];
  params: {
    query: string;
    count: number;
  };
  response: ZhihuSearchRawResponse;
}

interface ZhihuUsageLogInput {
  mode: ZhihuSearchDataMode;
  query: string;
  normalizedQuery: string;
  count: number;
  action:
    | "fixture_hit"
    | "fixture_missing"
    | "real_request"
    | "real_blocked"
    | "real_failed";
  consumed: number;
  usedToday?: number;
  budget?: number;
  fixtureId?: string;
  reason?: string;
}

const FIXTURE_CATALOG_SCHEMA = "zhihu-search-fixture-catalog.v1";
const FIXTURE_RECORD_SCHEMA = "zhihu-search-fixture.v1";

export function resolveZhihuSearchDataMode(
  options?: ZhihuSearchOptions
): ZhihuSearchDataMode {
  const rawMode = options?.dataMode ?? config.dataMode;
  if (rawMode === "real" || rawMode === "replay") {
    return rawMode;
  }

  return "cache_first";
}

export function normalizeZhihuSearchQuery(query: string): string {
  return query.replace(/\s+/g, " ").trim();
}

export function readZhihuSearchFixture(
  params: ZhihuSearchParams
): ZhihuFixtureRecord | undefined {
  const normalizedQuery = normalizeZhihuSearchQuery(params.query);
  const matches = readFixtureRecords().filter((fixture) =>
    fixture.normalizedQueries.includes(normalizedQuery)
  );

  return (
    matches.find((fixture) => fixture.params.count === params.count) ??
    matches.find((fixture) => fixture.params.count >= params.count) ??
    matches[0]
  );
}

export function hasZhihuSearchFixture(query: string): boolean {
  const normalizedQuery = normalizeZhihuSearchQuery(query);
  return readFixtureRecords().some((fixture) =>
    fixture.normalizedQueries.includes(normalizedQuery)
  );
}

export function writeZhihuSearchFixture(
  params: ZhihuSearchParams,
  response: ZhihuSearchRawResponse
): void {
  mkdirSync(config.zhihu.fixtureDir, { recursive: true });

  const normalizedQuery = normalizeZhihuSearchQuery(params.query);
  const hash = hashText(`${normalizedQuery}|count=${params.count}`);
  const filePath = join(config.zhihu.fixtureDir, `recorded-${hash}.json`);

  if (existsSync(filePath)) {
    return;
  }

  const payload = {
    schemaVersion: FIXTURE_RECORD_SCHEMA,
    id: `recorded_${hash}`,
    recordedAt: new Date().toISOString(),
    query: params.query,
    normalizedQuery,
    aliases: [],
    params: {
      query: params.query,
      count: params.count
    },
    response
  };

  writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

export function logZhihuSearchUsage(input: ZhihuUsageLogInput): void {
  const usedToday = input.usedToday ?? readTodayRealUsageCount();
  const budget = input.budget ?? config.zhihu.dailyDevBudget;
  const payload = {
    timestamp: new Date().toISOString(),
    ...input,
    usedToday,
    budget
  };

  mkdirSync(config.zhihu.usageLogDir, { recursive: true });
  appendFileSync(todayUsageLogPath(), `${JSON.stringify(payload)}\n`, "utf8");

  const fields: Array<[string, string | number | undefined]> = [
    ["mode", payload.mode],
    ["action", payload.action],
    ["query", payload.query],
    ["normalizedQuery", payload.normalizedQuery],
    ["count", payload.count],
    ["consumed", payload.consumed],
    ["usedToday", payload.usedToday],
    ["budget", payload.budget],
    ["fixtureId", payload.fixtureId],
    ["reason", payload.reason]
  ];
  console.info(
    `[ZhihuSearch] ${fields
      .filter(([, value]) => value !== undefined && value !== "")
      .map(([key, value]) => `${key}=${formatLogValue(value)}`)
      .join(" ")}`
  );
}

export function consumeZhihuRealApiBudget(input: {
  mode: ZhihuSearchDataMode;
  query: string;
  count: number;
}): void {
  const normalizedQuery = normalizeZhihuSearchQuery(input.query);
  const budget = config.zhihu.dailyDevBudget;
  const usedToday = readTodayRealUsageCount();

  if (usedToday >= budget) {
    logZhihuSearchUsage({
      mode: input.mode,
      query: input.query,
      normalizedQuery,
      count: input.count,
      action: "real_blocked",
      consumed: 0,
      usedToday,
      budget,
      reason: "daily_budget_exceeded"
    });
    throw new HttpError(
      429,
      "ZHIHU_DAILY_BUDGET_EXCEEDED",
      `知乎 API 本地每日真实调用预算已用完：${usedToday}/${budget}`
    );
  }

  logZhihuSearchUsage({
    mode: input.mode,
    query: input.query,
    normalizedQuery,
    count: input.count,
    action: "real_request",
    consumed: 1,
    usedToday: usedToday + 1,
    budget
  });
}

export function isRealZhihuApiAllowed(mode: ZhihuSearchDataMode): boolean {
  return mode === "real" || config.dataMode === "real" || config.zhihu.allowRealApi;
}

function readFixtureRecords(): ZhihuFixtureRecord[] {
  if (!existsSync(config.zhihu.fixtureDir)) {
    return [];
  }

  return readdirSync(config.zhihu.fixtureDir)
    .filter((fileName) => fileName.endsWith(".json"))
    .flatMap((fileName) => readFixtureFile(join(config.zhihu.fixtureDir, fileName)));
}

function readFixtureFile(filePath: string): ZhihuFixtureRecord[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(filePath, "utf8"));
  } catch {
    return [];
  }

  if (!isRecord(parsed)) {
    return [];
  }

  if (parsed.schemaVersion === FIXTURE_CATALOG_SCHEMA && Array.isArray(parsed.fixtures)) {
    return parsed.fixtures.flatMap((item) => toFixtureRecord(item, filePath));
  }

  return toFixtureRecord(parsed, filePath);
}

function toFixtureRecord(value: unknown, filePath: string): ZhihuFixtureRecord[] {
  if (!isRecord(value) || !isRecord(value.response)) {
    return [];
  }

  const query = readString(value.query);
  const normalizedQuery = normalizeZhihuSearchQuery(
    readString(value.normalizedQuery) || query
  );
  const params = isRecord(value.params) ? value.params : {};
  const paramQuery = readString(params.query) || query;
  const paramCount = readPositiveInteger(params.count, 5);
  const aliases = Array.isArray(value.aliases)
    ? value.aliases.map(readString).filter(Boolean)
    : [];
  const normalizedQueries = unique(
    [query, normalizedQuery, paramQuery, ...aliases]
      .map(normalizeZhihuSearchQuery)
      .filter(Boolean)
  );

  if (normalizedQueries.length === 0) {
    return [];
  }

  return [
    {
      filePath,
      id: readString(value.id) || hashText(`${filePath}|${normalizedQueries[0]}`),
      recordedAt: readString(value.recordedAt) || "",
      query: query || normalizedQueries[0],
      normalizedQueries,
      params: {
        query: paramQuery || normalizedQueries[0],
        count: paramCount
      },
      response: value.response as ZhihuSearchRawResponse
    }
  ];
}

function readTodayRealUsageCount(): number {
  const filePath = todayUsageLogPath();
  if (!existsSync(filePath)) {
    return 0;
  }

  return readFileSync(filePath, "utf8")
    .split("\n")
    .filter(Boolean)
    .reduce((total, line) => {
      try {
        const record = JSON.parse(line) as { consumed?: unknown };
        return total + (record.consumed === 1 ? 1 : 0);
      } catch {
        return total;
      }
    }, 0);
}

function todayUsageLogPath(): string {
  const day = new Date().toISOString().slice(0, 10);
  return join(config.zhihu.usageLogDir, `${day}.jsonl`);
}

function readString(value: unknown): string {
  if (typeof value === "string") {
    return value.trim();
  }

  if (typeof value === "number") {
    return String(value);
  }

  return "";
}

function readPositiveInteger(value: unknown, fallback: number): number {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function hashText(value: string): string {
  return createHash("sha1").update(value, "utf8").digest("hex").slice(0, 12);
}

function unique<T>(items: T[]): T[] {
  return Array.from(new Set(items));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function formatLogValue(value: string | number | undefined): string {
  if (typeof value === "number") {
    return String(value);
  }

  const text = String(value ?? "");
  return /\s/.test(text) ? JSON.stringify(text) : text;
}
