import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync
} from "node:fs";
import { join } from "node:path";
import { config } from "../config/env.js";
import type { IntentExpandOutput } from "./schemas/taskSchemas.js";

interface IntentExpandFixtureRecord {
  filePath: string;
  id: string;
  recordedAt: string;
  query: string;
  normalizedQuery: string;
  output: IntentExpandOutput;
  provider?: string;
  model?: string;
}

const INTENT_FIXTURE_SCHEMA = "intent-expand-fixture.v1";

export function normalizeIntentExpandFixtureQuery(query: string): string {
  return query.replace(/\s+/g, " ").trim();
}

export function readIntentExpandFixture(query: string): IntentExpandFixtureRecord | undefined {
  const normalizedQuery = normalizeIntentExpandFixtureQuery(query);
  return readFixtureRecords().find((fixture) => fixture.normalizedQuery === normalizedQuery);
}

export function writeIntentExpandFixture(input: {
  query: string;
  output: IntentExpandOutput;
  provider?: string;
  model?: string;
}): IntentExpandFixtureRecord {
  mkdirSync(config.intentExpand.fixtureDir, { recursive: true });

  const normalizedQuery = normalizeIntentExpandFixtureQuery(input.query);
  const hash = hashText(`${normalizedQuery}|intent-expand|v1`);
  const filePath = join(config.intentExpand.fixtureDir, `recorded-${hash}.json`);
  const id = `intent_${hash}`;

  if (!existsSync(filePath)) {
    const payload = {
      schemaVersion: INTENT_FIXTURE_SCHEMA,
      id,
      recordedAt: new Date().toISOString(),
      query: input.query,
      normalizedQuery,
      provider: input.provider,
      model: input.model,
      output: input.output
    };
    writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  }

  return (
    readIntentExpandFixture(input.query) ?? {
      filePath,
      id,
      recordedAt: "",
      query: input.query,
      normalizedQuery,
      output: input.output,
      provider: input.provider,
      model: input.model
    }
  );
}

function readFixtureRecords(): IntentExpandFixtureRecord[] {
  if (!existsSync(config.intentExpand.fixtureDir)) {
    return [];
  }

  return readdirSync(config.intentExpand.fixtureDir)
    .filter((fileName) => fileName.endsWith(".json"))
    .flatMap((fileName) => readFixtureFile(join(config.intentExpand.fixtureDir, fileName)));
}

function readFixtureFile(filePath: string): IntentExpandFixtureRecord[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(filePath, "utf8"));
  } catch {
    return [];
  }

  const fixture = toFixtureRecord(parsed, filePath);
  return fixture ? [fixture] : [];
}

function toFixtureRecord(value: unknown, filePath: string): IntentExpandFixtureRecord | null {
  if (!isRecord(value) || value.schemaVersion !== INTENT_FIXTURE_SCHEMA) {
    return null;
  }

  const output = value.output;
  if (!isIntentExpandOutput(output)) {
    return null;
  }

  const query = readString(value.query);
  const normalizedQuery = normalizeIntentExpandFixtureQuery(
    readString(value.normalizedQuery) || query
  );
  if (!normalizedQuery) {
    return null;
  }

  return {
    filePath,
    id: readString(value.id) || hashText(`${filePath}|${normalizedQuery}`),
    recordedAt: readString(value.recordedAt),
    query: query || normalizedQuery,
    normalizedQuery,
    output,
    provider: readString(value.provider) || undefined,
    model: readString(value.model) || undefined
  };
}

function isIntentExpandOutput(value: unknown): value is IntentExpandOutput {
  return (
    isRecord(value) &&
    typeof value.intent === "string" &&
    typeof value.userCoreQuestion === "string" &&
    Array.isArray(value.focusTags) &&
    Array.isArray(value.topicSignals) &&
    Array.isArray(value.searchQueries) &&
    value.searchQueries.every(isSearchQueryPlan) &&
    isRecord(value.objectiveSlots) &&
    Array.isArray(value.missingSlots) &&
    isRecord(value.queryPlan) &&
    Array.isArray(value.intentTags) &&
    typeof value.userNeedSummary === "string"
  );
}

function isSearchQueryPlan(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.query === "string" &&
    typeof value.type === "string" &&
    typeof value.purpose === "string" &&
    typeof value.priority === "number"
  );
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

function hashText(value: string): string {
  return createHash("sha1").update(value, "utf8").digest("hex").slice(0, 12);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
