import { config } from "../config/env.js";
import { assertDemoSearchGrounding } from "../guards/demoEvidence.guard.js";
import {
  composeMultiLlmDemoSearchResponse,
  hasPersonaChatLlm
} from "../llm/demoSearchOrchestrator.js";
import { createMockDemoSearchResponse } from "../mocks/demoSearch.mock.js";
import {
  createDemoSearchIdentity,
  type DemoSearchIdentity
} from "./demoQueryIdentity.service.js";
import { demoSessionCacheService } from "./demoSessionCache.service.js";
import { createDemoContextUsed } from "./userContext.service.js";
import type { UserContext } from "../auth/session.js";
import {
  type DemoClarificationAnswers,
  type DemoClarificationQuestion,
  type DemoClarifyingCard,
  type DemoDataMode,
  type DemoDebugClarificationContext,
  type DemoSearchDebug,
  type DemoSearchResponse
} from "../types/demo.types.js";
import { HttpError } from "../utils/httpError.js";
import {
  isRequestBudgetTimeoutError,
  withRequestBudget
} from "../utils/requestBudget.js";

export interface DemoSearchRequest {
  query: string;
  count: number;
  dataMode: DemoDataMode;
  clarificationAnswers?: DemoClarificationAnswers;
}

const DEFAULT_COUNT = 5;
const MAX_COUNT = 20;
const DATA_MODES = new Set<DemoDataMode>(["mock", "cache_first", "real"]);
const DEMO_SEARCH_CACHE_TTL_MS = 15 * 60 * 1000;
const DEMO_SEARCH_BUDGET_MS = 14000;
const REQUIRED_CLARIFICATION_QUESTIONS = 3;
const MAX_CLARIFICATION_OPTIONS = 6;

interface DemoSearchCacheEntry {
  expiresAt: number;
  response: DemoSearchResponse;
}

interface ClarificationLabelLookup {
  questionLabels: Map<string, string>;
  optionLabels: Map<string, Map<string, string>>;
}

const demoSearchResponseCache = new Map<string, DemoSearchCacheEntry>();

export class DemoSearchService {
  async search(
    request: DemoSearchRequest,
    userContext?: UserContext
  ): Promise<DemoSearchResponse> {
    const startedAt = Date.now();
    const clarificationContext = request.clarificationAnswers
      ? buildClarificationContext(request.query, request.clarificationAnswers)
      : null;
    const identity = createDemoSearchIdentity(request.query, {
      count: request.count,
      dataMode: request.dataMode
    });
    const cacheKey = buildDemoSearchCacheKey(request, identity, userContext);
    const cachedResponse = readCachedDemoResponse(cacheKey, identity, startedAt);

    if (cachedResponse) {
      return cacheDemoResponse(cachedResponse);
    }

    if (request.dataMode === "real") {
      try {
        const response = await withRequestBudget(
          composeMultiLlmDemoSearchResponse({
            query: request.query,
            count: request.count,
            dataMode: request.dataMode,
            startedAt,
            requestBudgetMs: DEMO_SEARCH_BUDGET_MS,
            userContext,
            clarificationContext: clarificationContext ?? undefined
          }),
          DEMO_SEARCH_BUDGET_MS,
          "DEMO_SEARCH_BUDGET_TIMEOUT",
          `/api/demo/search exceeded ${DEMO_SEARCH_BUDGET_MS}ms request budget`
        );
        assertDemoSearchGrounding(response);
        return cacheDemoResponse(
          writeCachedDemoResponse(
            cacheKey,
            applyDemoClarificationState(
              finalizeDemoMeta(response, startedAt),
              request,
              clarificationContext
            ),
            false
          )
        );
      } catch (error) {
        logRealSearchFallback(error, request, startedAt);

        const realSearchDebug = readSearchDebugFromError(error);
        const response = createMockDemoSearchResponse(request.query, request.count, "mock", {
          fallbackUsed: true,
          fallbackReason: formatErrorSummary(error),
          requestedDataMode: request.dataMode,
          resolvedDataMode: "mock",
          pathSource: "fallback",
          notes: [
            "real mode fallback to mock demo data",
            formatErrorSummary(error)
          ],
          clarificationContext: clarificationContext ?? undefined
        });
        if (realSearchDebug) {
          response.debug.search = realSearchDebug;
          response.debug.rawCandidateCount = realSearchDebug.totalRawResults;
          response.debug.mergedCandidateCount = realSearchDebug.totalDedupedCandidates;
          response.debug.dedupedCandidateCount = realSearchDebug.totalDedupedCandidates;
          response.debug.validCandidateCount = realSearchDebug.totalDedupedCandidates;
          response.debug.searchQueryResults = realSearchDebug.searchRounds.map((round) => ({
            query: round.query,
            type: "original",
            purpose: "real search degraded before product composition",
            priority: 1,
            roundIndex: round.roundIndex,
            returnedCount: round.rawResultCount,
            success: round.success,
            rawResultCount: round.rawResultCount,
            errorCode: round.errorCode,
            errorMessage: round.errorMessage,
            error: round.errorCode ? `${round.errorCode}: ${round.errorMessage ?? ""}` : undefined,
            isEmptyResult: round.isEmptyResult
          }));
          response.debug.notes = unique([
            ...response.debug.notes,
            "real Zhihu search degraded; mock product response kept the page shape while preserving debug.search"
          ]);
        }
        response.contextUsed = createDemoContextUsed(userContext, [
          "intent_expand",
          "search_query_expand",
          "fit_reason"
        ]);
        response.meta.latencyMs = Date.now() - startedAt;
        response.meta.totalDurationMs = response.meta.latencyMs;
        response.meta.fallbackStages = unique([
          ...(response.meta.fallbackStages ?? []),
          isRequestBudgetTimeoutError(error) ? "request_budget" : "real_demo_search"
        ]);
        response.meta.timedOutStages = unique([
          ...(response.meta.timedOutStages ?? []),
          ...(isRequestBudgetTimeoutError(error) ? ["request_budget"] : [])
        ]);
        response.meta.llmStages = response.meta.llmStages?.length
          ? response.meta.llmStages
          : [
              {
                taskType: isRequestBudgetTimeoutError(error) ? "request_budget" : "real_demo_search",
                status: isRequestBudgetTimeoutError(error) ? "timeout" : "fallback",
                durationMs: response.meta.latencyMs,
                fallbackReason: formatErrorSummary(error)
              }
            ];
        response.debug.timings = [];
        assertDemoSearchGrounding(response);
        return cacheDemoResponse(
          writeCachedDemoResponse(
            cacheKey,
            applyDemoClarificationState(response, request, clarificationContext),
            false
          )
        );
      }
    }

    const response = createMockDemoSearchResponse(request.query, request.count, request.dataMode, {
      notes:
        request.dataMode === "cache_first"
          ? ["cache_first miss; query-aware deterministic mock fallback generated"]
          : ["mock demo data; query-aware deterministic paths generated without LLM or Zhihu API"],
      pathSource: "fallback",
      clarificationContext: clarificationContext ?? undefined
    });
    response.contextUsed = createDemoContextUsed(userContext);
    finalizeDemoMeta(response, startedAt);
    assertDemoSearchGrounding(response);
    return cacheDemoResponse(
      writeCachedDemoResponse(
        cacheKey,
        applyDemoClarificationState(response, request, clarificationContext),
        false
      )
    );
  }
}

export const demoSearchService = new DemoSearchService();

function applyDemoClarificationState(
  response: DemoSearchResponse,
  request: DemoSearchRequest,
  clarificationContext: DemoDebugClarificationContext | null = null
): DemoSearchResponse {
  if (request.clarificationAnswers) {
    const context =
      clarificationContext ?? buildClarificationContext(request.query, request.clarificationAnswers);
    response.clarifyingCard = buildHiddenClarifyingCard();
    response.clarificationStage = {
      needClarification: false,
      ambiguityLevel: "low",
      llmUsed: false
    };
    response.debug.clarificationContext = context;
    response.debug.notes = unique([
      ...response.debug.notes,
      "clarificationAnswers consumed by intent/search/path planning; full demo result response returned"
    ]);
    return response;
  }

  const clarification = buildRuleClarifyingCard(request.query);
  response.clarifyingCard = clarification.card;
  response.clarificationStage = {
    needClarification: clarification.card.show,
    ambiguityLevel: clarification.ambiguityLevel,
    llmUsed: false,
    fallbackReason: "rule clarification planner used"
  };
  response.debug.notes = unique([
    ...response.debug.notes,
    "rule clarification card attached to demo search response"
  ]);
  return response;
}

function buildClarificationContext(
  query: string,
  answers: DemoClarificationAnswers
): DemoDebugClarificationContext {
  const labelLookup = buildClarificationLabelLookup(query);
  const answerLabels = Object.fromEntries(
    Object.entries(answers).map(([key, value]) => [
      key,
      readClarificationOptionLabel(labelLookup, key, value)
    ])
  );
  const answerParts = Object.entries(answerLabels).map(
    ([key, value]) => `${readClarificationQuestionLabel(labelLookup, key)}: ${value}`
  );
  const compactAnswerText = Object.values(answerLabels).join(" ");
  const searchHints = unique(
    [
      `${query} ${compactAnswerText}`,
      ...Object.values(answerLabels).flatMap((label) => [
        `${query} ${label} 真实经历`,
        `${label} 后来怎么样`,
        `${label} 选择复盘`
      ]),
      ...answerParts.map((part) => `${query} ${part}`)
    ].map((item) => item.trim())
  ).slice(0, 8);

  return {
    originalQuery: query,
    answers,
    answerLabels,
    answerSummary: answerParts.join("；"),
    searchHints,
    applied: true,
    searchHintCount: searchHints.length
  };
}

function buildClarificationLabelLookup(query: string): ClarificationLabelLookup {
  const card = buildRuleClarifyingCard(query).card;
  return {
    questionLabels: new Map(card.questions.map((question) => [question.id, question.label])),
    optionLabels: new Map(
      card.questions.map((question) => [
        question.id,
        new Map((question.options ?? []).map((option) => [option.id, option.label]))
      ])
    )
  };
}

function readClarificationQuestionLabel(
  labelLookup: ClarificationLabelLookup,
  questionId: string
): string {
  return labelLookup.questionLabels.get(questionId) ?? questionId;
}

function readClarificationOptionLabel(
  labelLookup: ClarificationLabelLookup,
  questionId: string,
  optionId: string
): string {
  return labelLookup.optionLabels.get(questionId)?.get(optionId) ?? optionId;
}

function buildRuleClarifyingCard(query: string): {
  card: DemoClarifyingCard;
  ambiguityLevel: "medium" | "high";
} {
  const normalized = query.replace(/\s+/g, "").toLowerCase();

  if (/异地恋|远距离|伴侣|恋爱/.test(normalized)) {
    return {
      ambiguityLevel: "medium",
      card: createClarifyingCard(
        "补充关系约束，匹配更准",
        "关系阶段、时间表和核心压力会影响你需要对照哪类经历。",
        [
          createClarificationQuestion("relationship_stage", "你们现在处在哪个阶段？", [
            ["early", "刚开始"],
            ["stable", "稳定关系"],
            ["marriage", "谈婚论嫁"],
            ["separated", "已经分开"]
          ]),
          createClarificationQuestion("core_constraint", "最核心的约束是什么？", [
            ["career", "工作机会"],
            ["city", "城市距离"],
            ["future", "未来时间表"],
            ["family", "家庭期待"],
            ["money", "经济压力"]
          ]),
          createClarificationQuestion("sample_preference", "更想先看哪类经历？", [
            ["similar", "情况相似"],
            ["continued", "坚持下来"],
            ["separated", "选择分开"],
            ["reunited", "后来团聚"],
            ["tradeoff", "代价复盘"]
          ])
        ]
      )
    };
  }

  if (/不工作|不上班|裸辞|失业|离职|gap/.test(normalized)) {
    return {
      ambiguityLevel: "high",
      card: createClarifyingCard(
        "补充当前约束，匹配更准",
        "不同现金流、城市和状态会对应很不同的真实经历。",
        [
          createClarificationQuestion("current_state", "你现在更接近哪种状态？", [
            ["burnout", "想休息"],
            ["unemployed", "已失业"],
            ["exploring", "找新方向"],
            ["employed", "在职观望"],
            ["already_gap", "已经空窗"]
          ]),
          createClarificationQuestion("main_constraint", "最需要先考虑什么？", [
            ["cashflow", "现金流"],
            ["place", "去哪生活"],
            ["career", "再就业"],
            ["health", "身体状态"],
            ["family", "家庭压力"],
            ["insurance", "社保医保"]
          ]),
          createClarificationQuestion("sample_preference", "更想先参考哪类样本？", [
            ["low_cost_place", "低成本停靠"],
            ["cashflow_plan", "空窗现金流"],
            ["career_return", "再就业回流"],
            ["remote_city", "换城市生活"],
            ["failure_review", "失败复盘"]
          ])
        ]
      )
    };
  }

  if (/毕业|大城市|回老家|留在|城市/.test(normalized)) {
    return {
      ambiguityLevel: "medium",
      card: createClarifyingCard(
        "补充城市选择条件，匹配更准",
        "城市选择通常要同时看职业机会、生活成本和支持系统。",
        [
          createClarificationQuestion("life_stage", "你现在处在哪个阶段？", [
            ["graduating", "刚毕业"],
            ["early_career", "工作不久"],
            ["settling", "准备稳定下来"],
            ["changing_city", "正想换城市"]
          ]),
          createClarificationQuestion("main_pull", "最吸引你留下或离开的因素是什么？", [
            ["career", "职业机会"],
            ["cost", "生活成本"],
            ["family", "离家近"],
            ["relationship", "关系牵引"],
            ["identity", "生活方式"]
          ]),
          createClarificationQuestion("sample_preference", "更想看哪类样本？", [
            ["stayed_big_city", "留下大城市"],
            ["returned_home", "回老家"],
            ["moved_second_tier", "换到二线"],
            ["regret", "后悔复盘"],
            ["long_term", "长期结果"]
          ])
        ]
      )
    };
  }

  if (/转行|换行业|没有经验|第一步/.test(normalized)) {
    return {
      ambiguityLevel: "high",
      card: createClarifyingCard(
        "补充转行约束，匹配更准",
        "转行样本要看旧经验、现金流和试错方式是否相似。",
        [
          createClarificationQuestion("career_stage", "你现在更接近哪种情况？", [
            ["no_experience", "完全没经验"],
            ["some_related", "有一点相关"],
            ["burnout", "想逃离原行业"],
            ["laid_off", "被动调整"]
          ]),
          createClarificationQuestion("main_constraint", "最卡你的是什么？", [
            ["skills", "技能差距"],
            ["money", "收入下滑"],
            ["age", "年龄压力"],
            ["portfolio", "作品项目"],
            ["network", "没人带路"]
          ]),
          createClarificationQuestion("sample_preference", "更想先看哪类经历？", [
            ["successful_switch", "转成了"],
            ["failed_switch", "失败复盘"],
            ["side_project", "副业试水"],
            ["training", "学习路径"],
            ["same_background", "背景相似"]
          ])
        ]
      )
    };
  }

  if (/父母|家里|家庭|沟通|观念/.test(normalized)) {
    return {
      ambiguityLevel: "medium",
      card: createClarifyingCard(
        "补充家庭沟通场景，匹配更准",
        "家庭议题需要分清冲突类型、边界和是否共同生活。",
        [
          createClarificationQuestion("conflict_type", "主要冲突集中在哪？", [
            ["career", "工作选择"],
            ["marriage", "婚恋"],
            ["money", "钱和支持"],
            ["lifestyle", "生活方式"],
            ["values", "价值观"]
          ]),
          createClarificationQuestion("living_distance", "你们现在的距离更像哪种？", [
            ["same_home", "住一起"],
            ["same_city", "同城分开住"],
            ["different_city", "异地"],
            ["financially_tied", "经济还绑定"]
          ]),
          createClarificationQuestion("sample_preference", "更想看哪类样本？", [
            ["reconciled", "后来缓和"],
            ["boundary", "建立边界"],
            ["cut_contact", "减少联系"],
            ["failed_talk", "沟通失败"],
            ["long_term", "长期变化"]
          ])
        ]
      )
    };
  }

  if (/读研|考公|就业|升学/.test(normalized)) {
    return {
      ambiguityLevel: "high",
      card: createClarifyingCard(
        "补充选择变量，匹配更准",
        "读研、考公和就业的样本差异主要来自风险偏好和时间成本。",
        [
          createClarificationQuestion("current_stage", "你现在处在哪个阶段？", [
            ["undergrad", "本科在读"],
            ["graduating", "即将毕业"],
            ["working", "已经工作"],
            ["gap", "空窗准备"]
          ]),
          createClarificationQuestion("main_goal", "最想优先满足什么？", [
            ["stability", "稳定"],
            ["income", "收入"],
            ["interest", "兴趣方向"],
            ["degree", "学历提升"],
            ["city", "城市落点"]
          ]),
          createClarificationQuestion("sample_preference", "更想看哪类经历？", [
            ["grad_school", "读研后"],
            ["civil_service", "考公后"],
            ["employment", "直接就业"],
            ["regret", "后悔复盘"],
            ["switch_later", "后来转向"]
          ])
        ]
      )
    };
  }

  if (/朋友|社交|孤独|越来越少/.test(normalized)) {
    return {
      ambiguityLevel: "medium",
      card: createClarifyingCard(
        "补充关系变化，匹配更准",
        "朋友变少可能来自阶段变化、城市变化或相处方式变化。",
        [
          createClarificationQuestion("change_stage", "这种变化从什么时候开始？", [
            ["graduation", "毕业后"],
            ["work", "工作后"],
            ["city_change", "换城市后"],
            ["relationship", "恋爱后"],
            ["recent", "最近突然"]
          ]),
          createClarificationQuestion("main_feeling", "最困扰你的是哪一点？", [
            ["lonely", "孤独"],
            ["self_doubt", "怀疑自己"],
            ["no_deep_talk", "没人深聊"],
            ["unequal_effort", "总是我主动"],
            ["different_values", "价值观变了"]
          ]),
          createClarificationQuestion("sample_preference", "更想看哪类样本？", [
            ["rebuilt_circle", "重建圈子"],
            ["accepted_less", "接受变少"],
            ["friendship_break", "关系断开"],
            ["social_method", "具体做法"],
            ["long_term", "长期变化"]
          ])
        ]
      )
    };
  }

  if (/钱|存款|存到钱|三十|30|财务/.test(normalized)) {
    return {
      ambiguityLevel: "medium",
      card: createClarifyingCard(
        "补充财务处境，匹配更准",
        "钱的问题要先区分收入、支出、负债和阶段压力。",
        [
          createClarificationQuestion("money_state", "你现在最接近哪种情况？", [
            ["no_savings", "没存款"],
            ["debt", "有负债"],
            ["low_income", "收入低"],
            ["high_spending", "支出高"],
            ["unstable_income", "收入不稳"]
          ]),
          createClarificationQuestion("main_pressure", "压力主要来自哪里？", [
            ["age", "年龄焦虑"],
            ["family", "家庭责任"],
            ["housing", "买房租房"],
            ["career", "职业停滞"],
            ["comparison", "同龄比较"]
          ]),
          createClarificationQuestion("sample_preference", "更想看哪类样本？", [
            ["started_late", "后来追上"],
            ["low_cost", "低成本生活"],
            ["income_growth", "收入增长"],
            ["debt_recovery", "还债恢复"],
            ["failed_plan", "失败复盘"]
          ])
        ]
      )
    };
  }

  return {
    ambiguityLevel: "medium",
    card: createClarifyingCard(
      "补充当前约束，匹配更准",
      "把状态、核心约束和想看的样本类型补齐后，结果会更贴近。",
      [
        createClarificationQuestion("current_state", "你现在更接近哪种状态？", [
          ["deciding", "正在犹豫"],
          ["stuck", "卡住很久"],
          ["already_started", "已经开始"],
          ["forced_change", "被动变化"],
          ["seeking_examples", "想找样本"]
        ]),
        createClarificationQuestion("main_constraint", "最影响判断的约束是什么？", [
          ["money", "钱"],
          ["time", "时间"],
          ["relationship", "关系"],
          ["career", "职业"],
          ["family", "家庭"],
          ["health", "状态"]
        ]),
        createClarificationQuestion("sample_preference", "更想看哪类真实经历？", [
          ["similar", "情况相似"],
          ["success", "走通了"],
          ["failure", "失败复盘"],
          ["long_term", "长期结果"],
          ["tradeoff", "代价边界"]
        ])
      ]
    )
  };
}

function createClarifyingCard(
  title: string,
  description: string,
  questions: DemoClarificationQuestion[]
): DemoClarifyingCard {
  return {
    show: true,
    title,
    description,
    questions: questions.slice(0, REQUIRED_CLARIFICATION_QUESTIONS),
    primaryActionText: "用这些信息重新匹配",
    skipActionText: "先跳过"
  };
}

function createClarificationQuestion(
  id: string,
  label: string,
  options: Array<[string, string]>
): DemoClarificationQuestion {
  return {
    id,
    label,
    type: "single_select",
    required: true,
    options: options
      .map(([optionId, optionLabel]) => ({
        id: optionId,
        label: optionLabel
      }))
      .slice(0, MAX_CLARIFICATION_OPTIONS)
  };
}

function buildHiddenClarifyingCard(): DemoClarifyingCard {
  return {
    show: false,
    title: "",
    description: "",
    questions: [],
    primaryActionText: "继续匹配",
    skipActionText: "跳过"
  };
}

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
    dataMode: parseDataMode(dataMode),
    clarificationAnswers: parseClarificationAnswers(record.clarificationAnswers)
  };
}

function parseClarificationAnswers(value: unknown): DemoClarificationAnswers | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const answers = Object.entries(value).reduce<DemoClarificationAnswers>(
    (result, [key, rawValue]) => {
      const normalizedKey = key.trim();
      const answer = readString(rawValue).trim();
      if (normalizedKey && answer) {
        result[normalizedKey] = answer;
      }

      return result;
    },
    {}
  );

  return Object.keys(answers).length > 0 ? answers : undefined;
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

function readSearchDebugFromError(error: unknown): DemoSearchDebug | undefined {
  if (!isRecord(error)) {
    return undefined;
  }

  const searchDebug = error.searchDebug;
  return isSearchDebug(searchDebug) ? searchDebug : undefined;
}

function isSearchDebug(value: unknown): value is DemoSearchDebug {
  if (!isRecord(value)) {
    return false;
  }

  return (
    typeof value.dataMode === "string" &&
    Array.isArray(value.queriesUsed) &&
    Array.isArray(value.searchRounds) &&
    typeof value.totalRawResults === "number" &&
    typeof value.totalDedupedCandidates === "number" &&
    Array.isArray(value.failedQueries) &&
    Array.isArray(value.emptyQueries) &&
    typeof value.degraded === "boolean"
  );
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
      code: "code" in error && typeof error.code === "string"
        ? error.code
        : error.name || "ERROR",
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

function finalizeDemoMeta(response: DemoSearchResponse, startedAt: number): DemoSearchResponse {
  response.meta.latencyMs = Date.now() - startedAt;
  response.meta.totalDurationMs = response.meta.latencyMs;
  response.meta.fallbackStages = response.meta.fallbackStages ?? [];
  response.meta.llmStages = response.meta.llmStages ?? [];
  response.meta.timedOutStages = response.meta.timedOutStages ?? [];
  return response;
}

function formatErrorSummary(error: unknown): string {
  const loggableError = toLoggableError(error);
  return `${loggableError.code}: ${loggableError.message}`;
}

function cacheDemoResponse(response: DemoSearchResponse): DemoSearchResponse {
  response.features.personaChat = hasPersonaChatLlm() ? "real" : "mock";
  demoSessionCacheService.set(response);
  return response;
}

function readCachedDemoResponse(
  cacheKey: string,
  identity: DemoSearchIdentity,
  startedAt: number
): DemoSearchResponse | undefined {
  const entry = demoSearchResponseCache.get(cacheKey);
  if (!entry) {
    return undefined;
  }

  if (entry.expiresAt <= Date.now()) {
    demoSearchResponseCache.delete(cacheKey);
    return undefined;
  }

  const response = cloneDemoSearchResponse(entry.response);
  response.meta.latencyMs = Date.now() - startedAt;
  response.meta.totalDurationMs = response.meta.latencyMs;
  response.meta.fallbackStages = response.meta.fallbackStages ?? [];
  response.meta.llmStages = response.meta.llmStages ?? [];
  response.meta.timedOutStages = response.meta.timedOutStages ?? [];
  response.debug.cacheHit = true;
  response.debug.originalQuery = identity.originalQuery;
  response.debug.normalizedQuery = identity.normalizedQuery;
  response.debug.cacheKeyPreview = identity.cacheKeyPreview;
  response.debug.notes = unique([
    ...response.debug.notes,
    "memory cache hit for normalizedQuery + dataMode"
  ]);
  return response;
}

function writeCachedDemoResponse(
  cacheKey: string,
  response: DemoSearchResponse,
  cacheHit: boolean
): DemoSearchResponse {
  pruneExpiredDemoSearchCache();
  response.debug.cacheHit = cacheHit;
  demoSearchResponseCache.set(cacheKey, {
    expiresAt: Date.now() + DEMO_SEARCH_CACHE_TTL_MS,
    response: cloneDemoSearchResponse(response)
  });
  return response;
}

function pruneExpiredDemoSearchCache(): void {
  const now = Date.now();
  for (const [cacheKey, entry] of demoSearchResponseCache) {
    if (entry.expiresAt <= now) {
      demoSearchResponseCache.delete(cacheKey);
    }
  }
}

function buildDemoSearchCacheKey(
  request: DemoSearchRequest,
  identity: DemoSearchIdentity,
  userContext?: UserContext
): string {
  return [
    "demo_search_v2",
    `dataMode=${request.dataMode}`,
    `normalizedQuery=${identity.normalizedQuery.toLowerCase()}`,
    `count=${request.count}`,
    `clarification=${hashString(JSON.stringify(request.clarificationAnswers ?? {}))}`,
    `context=${hashString(toUserContextCacheSeed(userContext))}`
  ].join("|");
}

function toUserContextCacheSeed(userContext?: UserContext): string {
  if (!userContext?.isLoggedIn) {
    return "anonymous";
  }

  return [
    userContext.provider,
    userContext.displayName ?? "",
    userContext.headline ?? ""
  ].join("|");
}

function hashString(value: string): string {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 31 + value.charCodeAt(index)) >>> 0;
  }
  return hash.toString(36);
}

function cloneDemoSearchResponse(response: DemoSearchResponse): DemoSearchResponse {
  return JSON.parse(JSON.stringify(response)) as DemoSearchResponse;
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}
