import { config } from "../config/env.js";
import { assertDemoSearchGrounding } from "../guards/demoEvidence.guard.js";
import { createMockDemoSearchResponse } from "../mocks/demoSearch.mock.js";
import { searchService } from "./search.service.js";
import {
  DEMO_PERSONA_BOUNDARY_NOTICE,
  DEMO_SCHEMA_VERSION,
  type DemoArticle,
  type DemoDataMode,
  type DemoEvidence,
  type DemoPath,
  type DemoPerson,
  type DemoPersona,
  type DemoSearchResponse,
  type DemoSourceRef
} from "../types/demo.types.js";
import type { SearchItem } from "../types/api.types.js";
import { HttpError } from "../utils/httpError.js";

export interface DemoSearchRequest {
  query: string;
  count: number;
  dataMode: DemoDataMode;
}

const DEFAULT_COUNT = 5;
const MAX_COUNT = 20;
const DATA_MODES = new Set<DemoDataMode>(["mock", "cache_first", "real"]);

export class DemoSearchService {
  async search(request: DemoSearchRequest): Promise<DemoSearchResponse> {
    const startedAt = Date.now();

    if (request.dataMode === "real") {
      try {
        const searchResult = await searchService.search(request.query, request.count);
        const response = composeFromSearchItems(request, searchResult.items, startedAt);
        assertDemoSearchGrounding(response);
        return response;
      } catch (error) {
        logRealSearchFallback(error, request, startedAt);

        const response = createMockDemoSearchResponse(request.query, request.count, "mock", {
          fallbackUsed: true,
          requestedDataMode: request.dataMode,
          resolvedDataMode: "mock",
          notes: [
            "real mode fallback to mock demo data",
            formatErrorSummary(error)
          ]
        });
        response.meta.latencyMs = Date.now() - startedAt;
        assertDemoSearchGrounding(response);
        return response;
      }
    }

    const response = createMockDemoSearchResponse(request.query, request.count, request.dataMode, {
      notes:
        request.dataMode === "cache_first"
          ? ["cache_first currently uses bundled mock seed for demo continuity"]
          : ["mock demo data; no LLM or Zhihu API required"]
    });
    response.meta.latencyMs = Date.now() - startedAt;
    assertDemoSearchGrounding(response);
    return response;
  }
}

export const demoSearchService = new DemoSearchService();

export function parseDemoSearchRequest(body: unknown): DemoSearchRequest {
  const record = isRecord(body) ? body : {};
  const query = readString(record.query).trim();
  const dataMode = readString(record.dataMode) || readString(record.mode);

  if (!query) {
    throw new HttpError(400, "QUERY_REQUIRED", "Missing required body field: query");
  }

  return {
    query,
    count: parseCount(record.count),
    dataMode: parseDataMode(dataMode)
  };
}

function composeFromSearchItems(
  request: DemoSearchRequest,
  items: SearchItem[],
  startedAt: number
): DemoSearchResponse {
  if (items.length === 0) {
    return createMockDemoSearchResponse(request.query, request.count, "mock", {
      fallbackUsed: true,
      requestedDataMode: request.dataMode,
      resolvedDataMode: "mock",
      notes: ["real search returned no items; fallback to mock demo data"]
    });
  }

  const limitedItems = items.slice(0, Math.min(request.count, 3));
  const sourceRefs = limitedItems.map(toSourceRef);
  const paths = buildPathsFromSourceRefs(sourceRefs);
  const people = limitedItems.map((item, index) => toPerson(item, index, paths[index % paths.length]));
  const personas = people.map(toPersona);

  return {
    schemaVersion: DEMO_SCHEMA_VERSION,
    queryId: `query_${hashId(request.query)}`,
    query: request.query,
    dataMode: request.dataMode,
    features: {
      aiPersona: true,
      personaChat: "mock",
      saveSample: false,
      articleBody: false,
      sourceEvidenceRequired: true
    },
    analysis: {
      summary: `已从知乎搜索结果中整理出 ${people.length} 个可追溯样本，供前端展示路径、人物卡和经验回声入口。`,
      intent: "life_path_exploration",
      focusTags: ["公开内容", "路径样本", "证据绑定"],
      steps: [
        {
          id: "step_fetch_zhihu",
          label: "召回知乎公开内容",
          status: "done",
          evidenceIds: sourceRefs.flatMap((sourceRef) => sourceRef.evidenceIds),
          sourceRefs: sourceRefs.map((sourceRef) => sourceRef.id)
        },
        {
          id: "step_compose_people",
          label: "按内容生成前端人物卡和 AI 分身入口",
          status: "done",
          evidenceIds: sourceRefs.flatMap((sourceRef) => sourceRef.evidenceIds),
          sourceRefs: sourceRefs.map((sourceRef) => sourceRef.id)
        }
      ]
    },
    paths,
    people,
    personas,
    sections: [
      {
        id: "section_paths",
        type: "paths",
        title: "可能路径",
        itemRefs: paths.map((path) => path.id)
      },
      {
        id: "section_people",
        type: "people",
        title: "前人样本",
        itemRefs: people.map((person) => person.id)
      },
      {
        id: "section_personas",
        type: "personas",
        title: "可追问的经验回声",
        itemRefs: personas.map((persona) => persona.id)
      }
    ],
    meta: {
      sourceRefs,
      evidenceCount: sourceRefs.reduce((total, sourceRef) => total + sourceRef.evidenceIds.length, 0),
      generatedAt: new Date().toISOString(),
      latencyMs: Date.now() - startedAt,
      fallbackUsed: false
    },
    debug: {
      composer: "search_items",
      requestedDataMode: request.dataMode,
      resolvedDataMode: request.dataMode,
      itemCount: people.length,
      notes: ["real search items mapped by deterministic demo composer; no LLM used"]
    }
  };
}

function buildPathsFromSourceRefs(sourceRefs: DemoSourceRef[]): DemoPath[] {
  return sourceRefs.map((sourceRef, index) => ({
    id: `path_${index + 1}_${hashId(sourceRef.id)}`,
    title: index === 0 ? "从公开经历里找停靠点" : "从相似回答里找下一步",
    summary: "这条路径由知乎公开内容映射而来，只表达内容片段中的可能方向。",
    stance: "mixed",
    evidenceIds: sourceRef.evidenceIds,
    sourceRefs: [sourceRef.id]
  }));
}

function toPerson(item: SearchItem, index: number, path: DemoPath): DemoPerson {
  const sourceRef = toSourceRef(item, index);
  const article = toArticle(item, sourceRef);
  const personId = `person_${hashId(item.id || item.url || String(index))}`;
  const personaId = `persona_${hashId(personId)}`;

  return {
    id: personId,
    name: item.author.name || "知乎用户",
    pathId: path.id,
    role: `${item.type || "知乎内容"}公开内容样本`,
    badge: "基于公开内容整理",
    avatar: item.author.avatar,
    oneLine: toSummary(item.text || item.title),
    who: "基于知乎公开内容整理出的前人样本，不等同于作者完整人生。",
    overlaps: ["都和当前问题存在主题重叠", "都提供了可回溯到原文的片段信息"],
    timeline: [
      {
        date: item.editTime > 0 ? String(item.editTime) : "公开内容片段",
        event: toSummary(item.text || item.title),
        evidenceIds: sourceRef.evidenceIds,
        sourceRefs: [sourceRef.id]
      }
    ],
    lesson: "先把公开内容里的具体做法和限制看清楚，再决定是否适合自己。",
    articles: [article],
    match: {
      score: clampScore(0.72 + index * 0.03),
      level: index < 2 ? "high" : "medium",
      reasons: ["标题或正文与当前问题相关", "内容保留了可追溯原文入口"],
      matchedVariables: ["公开回答", "生活选择", "风险判断"],
      riskNotes: ["该样本只代表公开内容片段，不能代表作者完整人生"],
      contentRelevance: clampScore(0.78 + index * 0.02),
      experienceSimilarity: clampScore(0.7 + index * 0.02),
      evidenceQuality: item.text ? 0.78 : 0.55,
      personaReadiness: item.text && item.url ? 0.76 : 0.5,
      evidenceIds: sourceRef.evidenceIds,
      sourceRefs: [sourceRef.id]
    },
    aiPersona: {
      enabled: Boolean(item.text && item.url),
      personaId,
      displayName: `${item.author.name || "知乎用户"}的经验回声`,
      label: "基于公开内容生成",
      openingLine: "你可以继续问这段公开内容里的选择、代价和边界。",
      suggestedQuestions: ["这段公开内容里最关键的转折是什么？", "从这个公开样本看，这条路径可能有什么代价？"],
      boundary: DEMO_PERSONA_BOUNDARY_NOTICE,
      grounding: {
        personId,
        articleIds: [article.id],
        evidenceRequired: true,
        sourceRefs: [sourceRef.id]
      }
    },
    evidenceIds: sourceRef.evidenceIds,
    sourceRefs: [sourceRef.id]
  };
}

function toPersona(person: DemoPerson): DemoPersona {
  return {
    id: person.aiPersona.personaId,
    personId: person.id,
    displayName: person.aiPersona.displayName,
    avatar: person.avatar,
    personaType: "experience_echo",
    intro: person.aiPersona.openingLine,
    boundaryNotice: DEMO_PERSONA_BOUNDARY_NOTICE,
    sourceRefs: person.sourceRefs,
    suggestedQuestions: person.aiPersona.suggestedQuestions
  };
}

function toArticle(item: SearchItem, sourceRef: DemoSourceRef): DemoArticle {
  const evidence = toEvidence(item, sourceRef);

  return {
    id: `article_${hashId(item.id || item.url || item.title)}`,
    title: item.title || "未命名知乎内容",
    text: item.text,
    url: item.url,
    author: item.author.name || "知乎用户",
    avatar: item.author.avatar,
    sourceName: item.type || "知乎内容",
    sourceUrl: item.url,
    summary: toSummary(item.text || item.title),
    evidence,
    body: evidence.map((itemEvidence) => ({
      type: "evidence",
      text: itemEvidence.text,
      evidenceIds: [itemEvidence.id],
      sourceRefs: [sourceRef.id]
    })),
    sourceRefs: [sourceRef.id]
  };
}

function toEvidence(item: SearchItem, sourceRef: DemoSourceRef): DemoEvidence[] {
  return [
    {
      id: sourceRef.evidenceIds[0],
      label: "公开内容片段",
      text: toSummary(item.text || item.title),
      sourceRefId: sourceRef.id,
      sourceUrl: item.url
    }
  ];
}

function toSourceRef(item: SearchItem, index = 0): DemoSourceRef {
  const sourceId = `source_${hashId(item.id || item.url || String(index))}`;

  return {
    id: sourceId,
    provider: "zhihu",
    type: "zhihu_answer",
    title: item.title || "未命名知乎内容",
    url: item.url,
    author: item.author.name || "知乎用户",
    evidenceIds: [`ev_${hashId(`${sourceId}:${item.text || item.title}`)}`]
  };
}

function parseDataMode(value: unknown): DemoDataMode {
  const mode = readString(value) || config.dataMode;
  if (DATA_MODES.has(mode as DemoDataMode)) {
    return mode as DemoDataMode;
  }

  throw new HttpError(400, "DATA_MODE_INVALID", "dataMode must be mock, cache_first, or real");
}

function parseCount(value: unknown): number {
  const raw = readString(value);
  if (!raw) {
    return DEFAULT_COUNT;
  }

  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) {
    return DEFAULT_COUNT;
  }

  return Math.min(Math.max(parsed, 1), MAX_COUNT);
}

function readString(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }

  if (typeof value === "number") {
    return String(value);
  }

  return "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toSummary(text: string): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length <= 96) {
    return normalized;
  }

  return `${normalized.slice(0, 95)}...`;
}

function clampScore(value: number): number {
  return Math.min(Math.max(Number(value.toFixed(2)), 0), 1);
}

function hashId(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }

  return (hash >>> 0).toString(16);
}

function logRealSearchFallback(
  error: unknown,
  request: DemoSearchRequest,
  startedAt: number
): void {
  console.error("[DemoSearch] real Zhihu search failed; falling back to mock", {
    query: request.query,
    count: request.count,
    requestedDataMode: request.dataMode,
    elapsedMs: Date.now() - startedAt,
    ...toLoggableError(error)
  });
}

function toLoggableError(error: unknown): {
  code: string;
  statusCode: number | null;
  message: string;
} {
  if (error instanceof HttpError) {
    return {
      code: error.code,
      statusCode: error.statusCode,
      message: error.message
    };
  }

  if (error instanceof Error) {
    return {
      code: error.name || "ERROR",
      statusCode: null,
      message: error.message || "Unknown error"
    };
  }

  return {
    code: "UNKNOWN_ERROR",
    statusCode: null,
    message: "Unknown error"
  };
}

function formatErrorSummary(error: unknown): string {
  const loggableError = toLoggableError(error);
  return `${loggableError.code}: ${loggableError.message}`;
}
