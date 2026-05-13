import type { DemoDataMode } from "../types/demo.types.js";

interface DemoSearchIdentityInput {
  count: number;
  dataMode: DemoDataMode;
}

export interface DemoSearchIdentity {
  originalQuery: string;
  normalizedQuery: string;
  cacheKey: string;
  cacheKeyPreview: string;
  queryId: string;
}

export function createDemoSearchIdentity(
  query: string,
  input: DemoSearchIdentityInput
): DemoSearchIdentity {
  const originalQuery = query;
  const normalizedQuery = normalizeDemoQuery(query);
  const cacheKey = [
    "demo_search",
    "v2",
    `mode=${input.dataMode}`,
    `count=${input.count}`,
    `normalizedQuery=${normalizedQuery}`
  ].join("|");
  const cacheHash = hashId(cacheKey);

  return {
    originalQuery,
    normalizedQuery,
    cacheKey,
    cacheKeyPreview: `demo_search:v2:${input.dataMode}:count=${input.count}:q=${truncateText(
      normalizedQuery,
      32
    )}:h=${cacheHash}`,
    queryId: `query_${cacheHash}`
  };
}

export function normalizeDemoQuery(query: string): string {
  return query.replace(/\s+/g, " ").trim();
}

function truncateText(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }

  return `${value.slice(0, maxLength - 3)}...`;
}

function hashId(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }

  return (hash >>> 0).toString(16);
}
