import type { UserContext } from "../auth/session.js";
import { llmRouter } from "../llm/llmRouter.js";
import { getLlmTaskTimeoutMs } from "../llm/llmTimeout.js";
import { CLARIFIED_INTENT_SEARCH_PLAN_SYSTEM_PROMPT } from "../llm/prompts/clarifiedIntentSearchPlanPrompt.js";
import {
  type DemoClarificationAnswers,
  type DemoContextUsed,
  type DemoIntentSearchPlan,
  type DemoIntentSearchPlanResponse
} from "../types/demo.types.js";
import {
  buildPromptUserContext,
  createDemoContextUsed
} from "./userContext.service.js";

interface CreateIntentSearchPlanInput {
  query: string;
  clarificationAnswers: DemoClarificationAnswers;
  userContext?: UserContext;
}

interface ParsedIntentSearchPlan {
  intent: string;
  intentSummary: string;
  focusTags: string[];
  searchPlan: DemoIntentSearchPlan;
}

const CORE_QUERY_MIN_COUNT = 3;
const CORE_QUERY_MAX_COUNT = 5;
const EXPANDED_QUERY_MIN_COUNT = 2;
const EXPANDED_QUERY_MAX_COUNT = 5;
const EXPLORATORY_QUERY_MIN_COUNT = 1;
const EXPLORATORY_QUERY_MAX_COUNT = 2;
const FOCUS_TAG_MIN_COUNT = 3;
const FOCUS_TAG_MAX_COUNT = 6;
const RANKING_SIGNAL_MIN_COUNT = 3;
const RANKING_SIGNAL_MAX_COUNT = 12;
const NEGATIVE_HINT_MIN_COUNT = 2;
const NEGATIVE_HINT_MAX_COUNT = 4;
const EXPECTED_EVIDENCE_MIN_COUNT = 3;
const EXPECTED_EVIDENCE_MAX_COUNT = 6;

const GENERIC_NEGATIVE_HINTS = [
  "不要优先使用纯鸡汤内容",
  "不要优先使用没有个人经历的空泛观点",
  "不要优先使用标题相关但内容无关的回答"
];

const GENERIC_EXPECTED_EVIDENCE_TYPES = [
  "亲身经历",
  "选择复盘",
  "后悔或不后悔的回答",
  "长期结果讨论"
];

export class IntentSearchPlanService {
  async create(
    input: CreateIntentSearchPlanInput
  ): Promise<DemoIntentSearchPlanResponse> {
    const startedAt = Date.now();
    const fallback = buildFallbackIntentSearchPlan(input);
    const provider = llmRouter.getProviderForTask("intent_expand");
    const model = llmRouter.getModelForTask("intent_expand");
    const contextUsed = createIntentContextUsed(input.userContext);

    if (!llmRouter.isTaskConfigured("intent_expand")) {
      return attachDebug(fallback, {
        startedAt,
        llmUsed: false,
        provider,
        model,
        contextUsed,
        clarificationAnswerKeys: Object.keys(input.clarificationAnswers),
        fallbackReason: "DeepSeek not configured; deterministic search plan fallback used"
      });
    }

    try {
      const content = await llmRouter.runJsonTask("intent_expand", {
        temperature: 0.1,
        maxTokens: 1800,
        timeoutMs: getLlmTaskTimeoutMs("intent_expand"),
        maxRetry: 0,
        messages: [
          {
            role: "system",
            content: CLARIFIED_INTENT_SEARCH_PLAN_SYSTEM_PROMPT
          },
          {
            role: "user",
            content: JSON.stringify({
              query: truncateText(input.query, 160),
              clarificationAnswers: input.clarificationAnswers,
              userContext: buildPromptUserContext(input.userContext)
            })
          }
        ]
      });
      const parsed = parseIntentSearchPlanOutput(content, fallback);

      return attachDebug(parsed, {
        startedAt,
        llmUsed: true,
        provider,
        model,
        contextUsed,
        clarificationAnswerKeys: Object.keys(input.clarificationAnswers)
      });
    } catch (error) {
      return attachDebug(fallback, {
        startedAt,
        llmUsed: false,
        provider,
        model,
        contextUsed,
        clarificationAnswerKeys: Object.keys(input.clarificationAnswers),
        fallbackReason: formatErrorSummary(error)
      });
    }
  }
}

export const intentSearchPlanService = new IntentSearchPlanService();

function attachDebug(
  response: ParsedIntentSearchPlan,
  options: {
    startedAt: number;
    llmUsed: boolean;
    provider: string;
    model: string;
    contextUsed: DemoContextUsed;
    clarificationAnswerKeys: string[];
    fallbackReason?: string;
  }
): DemoIntentSearchPlanResponse {
  return {
    ...response,
    contextUsed: options.contextUsed,
    debug: {
      stage: "intent_expand",
      llmUsed: options.llmUsed,
      provider: options.provider,
      model: options.model,
      ...(options.fallbackReason ? { fallbackReason: options.fallbackReason } : {}),
      clarificationAnswerKeys: options.clarificationAnswerKeys,
      latencyMs: Date.now() - options.startedAt,
      notes: [
        "clarificationAnswers detected; full demo result composition skipped",
        options.llmUsed
          ? "LLM generated structured intent and Zhihu search plan"
          : "deterministic fallback generated a usable Zhihu search plan"
      ]
    }
  };
}

function createIntentContextUsed(userContext?: UserContext): DemoContextUsed {
  return createDemoContextUsed(userContext, ["intent_expand", "search_query_expand"]);
}

function parseIntentSearchPlanOutput(
  content: string,
  fallback: ParsedIntentSearchPlan
): ParsedIntentSearchPlan {
  const record = parseJsonRecord(content);
  const searchPlanRecord = isRecord(record.searchPlan) ? record.searchPlan : {};

  return {
    intent: sanitizeIntent(readString(record.intent)) || fallback.intent,
    intentSummary:
      sanitizeText(readString(record.intentSummary), 180) || fallback.intentSummary,
    focusTags: completeStringList(
      readStringArray(record.focusTags).map((item) => sanitizeText(item, 24)),
      fallback.focusTags,
      FOCUS_TAG_MIN_COUNT,
      FOCUS_TAG_MAX_COUNT
    ),
    searchPlan: {
      coreQueries: completeQueryList(
        readStringArray(searchPlanRecord.coreQueries),
        fallback.searchPlan.coreQueries,
        CORE_QUERY_MIN_COUNT,
        CORE_QUERY_MAX_COUNT,
        18
      ),
      expandedQueries: completeQueryList(
        readStringArray(searchPlanRecord.expandedQueries),
        fallback.searchPlan.expandedQueries,
        EXPANDED_QUERY_MIN_COUNT,
        EXPANDED_QUERY_MAX_COUNT,
        22
      ),
      exploratoryQueries: completeQueryList(
        readStringArray(searchPlanRecord.exploratoryQueries),
        fallback.searchPlan.exploratoryQueries,
        EXPLORATORY_QUERY_MIN_COUNT,
        EXPLORATORY_QUERY_MAX_COUNT,
        30
      ),
      rankingSignals: completeStringList(
        readStringArray(searchPlanRecord.rankingSignals).map((item) => sanitizeText(item, 18)),
        fallback.searchPlan.rankingSignals,
        RANKING_SIGNAL_MIN_COUNT,
        RANKING_SIGNAL_MAX_COUNT
      ),
      negativeHints: completeStringList(
        readStringArray(searchPlanRecord.negativeHints).map((item) => sanitizeText(item, 34)),
        fallback.searchPlan.negativeHints,
        NEGATIVE_HINT_MIN_COUNT,
        NEGATIVE_HINT_MAX_COUNT
      ),
      expectedEvidenceTypes: completeStringList(
        readStringArray(searchPlanRecord.expectedEvidenceTypes).map((item) =>
          sanitizeText(item, 24)
        ),
        fallback.searchPlan.expectedEvidenceTypes,
        EXPECTED_EVIDENCE_MIN_COUNT,
        EXPECTED_EVIDENCE_MAX_COUNT
      )
    }
  };
}

function buildFallbackIntentSearchPlan(
  input: CreateIntentSearchPlanInput
): ParsedIntentSearchPlan {
  const combinedText = normalizeText([
    input.query,
    ...Object.values(input.clarificationAnswers)
  ].join(" "));

  if (isRelationshipCareerTradeoff(combinedText)) {
    return {
      intent: "relationship_career_tradeoff",
      intentSummary:
        "用户正在权衡为了追求想做的工作而进入长期异地恋是否值得，希望参考真实经历，而不是获得单一建议。",
      focusTags: [
        "事业选择与亲密关系冲突",
        "长期异地恋的现实成本",
        "坚持或分开的真实经历"
      ],
      searchPlan: {
        coreQueries: [
          "异地恋 工作",
          "为了工作 异地恋",
          "职业发展 异地恋",
          "异地恋 分手",
          "异地恋 坚持"
        ],
        expandedQueries: [
          "异地恋 分手 后悔",
          "异地恋 坚持下来",
          "异地恋 职业选择",
          "为了工作 异地 分手"
        ],
        exploratoryQueries: [
          "为了事业选择异地恋",
          "异地恋和职业发展如何平衡"
        ],
        rankingSignals: [
          "真实经历",
          "长期异地",
          "坚持下来",
          "最后分开",
          "后悔",
          "不后悔",
          "事业选择",
          "关系稳定性",
          "分手复盘"
        ],
        negativeHints: [
          "不要优先使用纯鸡汤内容",
          "不要优先使用恋爱技巧泛泛建议",
          "不要优先使用没有个人经历的空泛观点"
        ],
        expectedEvidenceTypes: [
          "亲身经历",
          "分手复盘",
          "异地坚持经验",
          "职业选择后悔或不后悔的回答",
          "关系与人生选择的长文讨论"
        ]
      }
    };
  }

  const corePhrase = extractGenericCorePhrase(input.query);
  const focusTags = inferGenericFocusTags(combinedText);

  return {
    intent: inferGenericIntent(combinedText),
    intentSummary: `用户想围绕「${corePhrase}」判断真实经历、选择代价和后续结果，需要先准备适合知乎召回的搜索计划。`,
    focusTags,
    searchPlan: {
      coreQueries: [
        `${corePhrase} 真实经历`,
        `${corePhrase} 后悔`,
        `${corePhrase} 怎么选`
      ],
      expandedQueries: [
        `${corePhrase} 后来怎么样`,
        `${corePhrase} 失败复盘`,
        `${corePhrase} 经验`
      ],
      exploratoryQueries: [`${corePhrase}到底值不值得`],
      rankingSignals: [
        "真实经历",
        "选择成本",
        "长期结果",
        "后悔",
        "不后悔",
        ...focusTags
      ],
      negativeHints: GENERIC_NEGATIVE_HINTS,
      expectedEvidenceTypes: GENERIC_EXPECTED_EVIDENCE_TYPES
    }
  };
}

function isRelationshipCareerTradeoff(value: string): boolean {
  return (
    includesAny(value, ["异地恋", "异地"]) &&
    includesAny(value, ["工作", "职业", "事业", "追求自己想做的事", "职业发展"]) &&
    includesAny(value, ["关系", "恋爱", "伴侣", "分开", "坚持", "值得"])
  );
}

function inferGenericIntent(value: string): string {
  if (includesAny(value, ["转行", "职业", "工作", "事业"])) {
    return "career_decision_tradeoff";
  }

  if (includesAny(value, ["恋爱", "关系", "伴侣", "结婚", "分手"])) {
    return "relationship_decision_tradeoff";
  }

  if (includesAny(value, ["不工作", "裸辞", "gap", "Gap", "待业"])) {
    return "life_path_exploration";
  }

  return "decision_experience_search";
}

function inferGenericFocusTags(value: string): string[] {
  const tags: string[] = [];

  if (includesAny(value, ["工作", "职业", "事业", "转行"])) {
    tags.push("职业选择");
  }

  if (includesAny(value, ["关系", "恋爱", "伴侣", "分手", "结婚"])) {
    tags.push("亲密关系");
  }

  if (includesAny(value, ["后悔", "值得", "不值得"])) {
    tags.push("后悔与收益");
  }

  if (includesAny(value, ["真实", "经历", "样本"])) {
    tags.push("真实经历");
  }

  return completeStringList(tags, ["真实经历", "选择代价", "长期结果"], 3, 5);
}

function extractGenericCorePhrase(query: string): string {
  const normalized = normalizeText(query).replace(/[？?。！!，,、；;：:]/g, " ");
  const compact = normalizeText(normalized);
  if (!compact) {
    return "人生选择";
  }

  if (compact.length <= 10) {
    return compact;
  }

  const spacedParts = compact.split(/\s+/).filter(Boolean);
  if (spacedParts.length >= 2) {
    return spacedParts.slice(0, 3).join(" ");
  }

  return compact.slice(0, 10);
}

function completeQueryList(
  values: string[],
  fallbackValues: string[],
  minCount: number,
  maxCount: number,
  maxLength: number
): string[] {
  const result = unique([
    ...values.map((item) => sanitizeSearchQuery(item, maxLength)),
    ...fallbackValues.map((item) => sanitizeSearchQuery(item, maxLength))
  ]);

  return result.slice(0, Math.max(minCount, Math.min(result.length, maxCount)));
}

function completeStringList(
  values: string[],
  fallbackValues: string[],
  minCount: number,
  maxCount: number
): string[] {
  const result = unique([...values, ...fallbackValues].map((item) => normalizeText(item)));
  return result.slice(0, Math.max(minCount, Math.min(result.length, maxCount)));
}

function sanitizeSearchQuery(value: string, maxLength: number): string {
  const normalized = normalizeText(
    value
      .replace(/[？?。！!；;：:]/g, " ")
      .replace(/[，,、/|]+/g, " ")
      .replace(/["“”'‘’]/g, "")
  );

  if (!normalized || normalized.length < 2 || normalized.length > maxLength) {
    return "";
  }

  return normalized;
}

function sanitizeIntent(value: string): string {
  const normalized = value.trim().toLowerCase().replace(/[^a-z0-9_]+/g, "_");
  return normalized.replace(/^_+|_+$/g, "").slice(0, 48);
}

function sanitizeText(value: string, maxLength: number): string {
  return truncateText(normalizeText(value), maxLength);
}

function parseJsonRecord(content: string): Record<string, unknown> {
  const jsonText = extractJsonObjectText(content);
  const parsed = JSON.parse(jsonText) as unknown;
  if (!isRecord(parsed)) {
    throw new Error("LLM intent search plan response must be a JSON object");
  }

  return parsed;
}

function extractJsonObjectText(content: string): string {
  const trimmed = content.trim();
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
    return trimmed;
  }

  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start >= 0 && end > start) {
    return trimmed.slice(start, end + 1);
  }

  return trimmed;
}

function readStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.flatMap((item) => {
    if (typeof item === "string" || typeof item === "number") {
      return String(item);
    }

    return [];
  });
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

function includesAny(value: string, keywords: string[]): boolean {
  return keywords.some((keyword) => value.includes(keyword));
}

function normalizeText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function truncateText(value: string, maxLength: number): string {
  const normalized = normalizeText(value);
  if (normalized.length <= maxLength) {
    return normalized;
  }

  return `${normalized.slice(0, maxLength - 3)}...`;
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function formatErrorSummary(error: unknown): string {
  if (error instanceof Error) {
    const code = "code" in error && typeof error.code === "string" ? error.code : error.name;
    return `${code || "ERROR"}: ${error.message || "Unknown error"}`;
  }

  return "UNKNOWN_ERROR: Unknown error";
}
