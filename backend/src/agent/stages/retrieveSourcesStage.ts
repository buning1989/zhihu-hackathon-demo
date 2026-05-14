import { config } from "../../config/env.js";
import { createMockDemoSearchResponse } from "../../mocks/demoSearch.mock.js";
import { searchService } from "../../services/search.service.js";
import type { SearchItem } from "../../types/api.types.js";
import { HttpError } from "../../utils/httpError.js";
import {
  AGENT_ARTIFACT_RAW_SOURCES,
  type AgentStageOutput,
  type IntentArtifactData,
  type RawSourceItem,
  type RawSourcesArtifactData
} from "./stageTypes.js";

const RETRIEVE_SOURCE_COUNT = 10;

export async function runRetrieveSourcesStage(
  intent: IntentArtifactData
): Promise<AgentStageOutput<RawSourcesArtifactData>> {
  const query = intent.expandedQueries[0] || intent.normalizedQuery || intent.originalQuery;

  if (!config.zhihu.accessSecret) {
    return buildFallbackRawSources(
      intent,
      "ZHIHU_AUTH_FAILED: missing ZH_ACCESS_SECRET/ZHIHU_API_KEY; mock sources used"
    );
  }

  try {
    const searchResult = await searchService.search(query, RETRIEVE_SOURCE_COUNT);
    const sources = searchResult.items.map(mapSearchItemToRawSource);

    return {
      artifactType: AGENT_ARTIFACT_RAW_SOURCES,
      data: {
        query,
        expandedQueries: intent.expandedQueries,
        sources,
        sourceCount: sources.length,
        provider: "zhihu",
        fallbackUsed: false,
        fallbackReason: null
      }
    };
  } catch (error) {
    return buildFallbackRawSources(intent, summarizeSearchFallbackReason(error));
  }
}

function buildFallbackRawSources(
  intent: IntentArtifactData,
  fallbackReason: string
): AgentStageOutput<RawSourcesArtifactData> {
  const resolvedDataMode = config.dataMode === "cache_first" ? "cache_first" : "mock";
  const mockResponse = createMockDemoSearchResponse(
    intent.normalizedQuery || intent.originalQuery,
    3,
    resolvedDataMode,
    {
      fallbackUsed: true,
      fallbackReason,
      requestedDataMode: config.dataMode,
      resolvedDataMode,
      notes: ["agent retrieve_sources used deterministic mock sources; no LLM invoked"]
    }
  );
  const articleBySourceRef = new Map<string, {
    text?: string;
    summary?: string;
  }>();

  for (const person of mockResponse.people) {
    for (const article of person.articles ?? []) {
      for (const sourceRef of article.sourceRefs ?? []) {
        if (!articleBySourceRef.has(sourceRef)) {
          articleBySourceRef.set(sourceRef, {
            text: article.text,
            summary: article.summary
          });
        }
      }
    }
  }

  const sources = mockResponse.meta.sourceRefs.map((sourceRef, index): RawSourceItem => {
    const article = articleBySourceRef.get(sourceRef.id);

    return {
      sourceId: sourceRef.id,
      provider: "mock",
      type: sourceRef.type,
      title: sourceRef.title,
      url: sourceRef.url,
      author: sourceRef.author,
      excerpt: truncateText(article?.summary || article?.text || sourceRef.title, 500),
      score: clampScore(0.86 - index * 0.04)
    };
  });

  return {
    artifactType: AGENT_ARTIFACT_RAW_SOURCES,
    status: "fallback",
    fallbackUsed: true,
    fallbackReason,
    data: {
      query: intent.normalizedQuery || intent.originalQuery,
      expandedQueries: intent.expandedQueries,
      sources,
      sourceCount: sources.length,
      provider: sources.length > 0 ? "mock" : "empty",
      fallbackUsed: true,
      fallbackReason
    }
  };
}

function mapSearchItemToRawSource(item: SearchItem, index: number): RawSourceItem {
  return {
    sourceId: item.id || `zhihu_source_${index + 1}`,
    provider: "zhihu",
    type: item.type || "zhihu_content",
    title: item.title || truncateText(item.text, 80) || `知乎内容 ${index + 1}`,
    url: item.url || item.source.url,
    author: item.author.name,
    excerpt: truncateText(item.evidence.text || item.text, 500),
    score: normalizeSearchScore(item, index),
    raw: {
      type: item.type,
      stats: item.stats,
      editTime: item.editTime,
      authorityLevel: item.authorityLevel,
      source: item.source
    }
  };
}

function normalizeSearchScore(item: SearchItem, index: number): number {
  const score = item.relevanceScore ?? item.roughScore ?? item.stats.rankingScore;
  if (Number.isFinite(score) && score > 0) {
    return clampScore(score > 1 ? score / 100 : score);
  }

  return clampScore(0.82 - index * 0.03);
}

function summarizeSearchFallbackReason(error: unknown): string {
  if (error instanceof HttpError) {
    return `${error.code}: ${error.message}`;
  }

  if (error instanceof Error) {
    return `SEARCH_SERVICE_FAILED: ${error.message}`;
  }

  return "SEARCH_SERVICE_FAILED: unknown error";
}

function truncateText(value: string, maxLength: number): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }

  return `${normalized.slice(0, Math.max(maxLength - 1, 0))}…`;
}

function clampScore(value: number): number {
  return Math.min(Math.max(Number(value.toFixed(2)), 0), 1);
}
