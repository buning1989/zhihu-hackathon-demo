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
  buildObjectiveSearchContext
} from "../llm/searchQueryPlan.js";
import { llmRouter } from "../llm/llmRouter.js";
import {
  createDeterministicSimilarityClarificationPlan,
  readClarificationAnswerResolution,
  similarityClarificationPlanner
} from "../llm/similarityClarificationPlanner.js";
import {
  type DemoClarificationAnswers,
  type DemoClarificationQuestion,
  type DemoClarifyingCard,
  type DemoDataMode,
  type DemoDebugClarificationContext,
  type DemoDebugClarificationPlan,
  type DemoDebugTiming,
  type DemoObjectiveQueryPlan,
  type DemoObjectiveSlotName,
  type DemoObjectiveSlots,
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
const DEMO_SEARCH_BUDGET_MS = config.demoSearch.requestBudgetMs;
const REQUIRED_CLARIFICATION_QUESTIONS = 3;
const MAX_CLARIFICATION_OPTIONS = 6;
const OBJECTIVE_CLARIFICATION_SLOT_ORDER: DemoObjectiveSlotName[] = [
  "role",
  "status",
  "direction",
  "constraint"
];

type ObjectiveClarificationStage = "evaluation" | "execution" | "exploration";

interface DemoSearchCacheEntry {
  expiresAt: number;
  response: DemoSearchResponse;
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
            await applyDemoClarificationState(
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
            await applyDemoClarificationState(response, request, clarificationContext),
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
        await applyDemoClarificationState(response, request, clarificationContext),
        false
      )
    );
  }
}

export const demoSearchService = new DemoSearchService();

async function applyDemoClarificationState(
  response: DemoSearchResponse,
  request: DemoSearchRequest,
  clarificationContext: DemoDebugClarificationContext | null = null
): Promise<DemoSearchResponse> {
  const clarificationStartedAt = Date.now();

  if (request.clarificationAnswers) {
    const context =
      clarificationContext ?? buildClarificationContext(request.query, request.clarificationAnswers);
    const answeredPlan = createDeterministicSimilarityClarificationPlan(
      request.query,
      getSearchableAnswerLabels(context)
    );
    response.clarifyingCard = buildHiddenClarifyingCard();
    response.clarificationStage = {
      needClarification: false,
      ambiguityLevel: "low",
      llmUsed: false
    };
    response.debug.clarificationContext = context;
    response.debug.clarificationPlan = answeredPlan.debug;
    upsertClarificationTiming(response, {
      durationMs: Date.now() - clarificationStartedAt,
      llmUsed: false,
      fallbackUsed: true,
      fallbackReason: "clarificationAnswers supplied; similarity clarification planner LLM not invoked"
    });
    response.debug.notes = unique([
      ...response.debug.notes,
      "clarificationAnswers consumed by intent/search/path planning; full demo result response returned"
    ]);
    return response;
  }

  const clarification = await similarityClarificationPlanner.create({
    query: request.query,
    useLlm: request.dataMode === "real"
  });
  response.clarifyingCard = clarification.card;
  response.debug.clarificationPlan = clarification.debug;
  response.clarificationStage = {
    needClarification: clarification.card.show,
    ambiguityLevel: clarification.ambiguityLevel,
    llmUsed: clarification.llmUsed,
    ...(clarification.fallbackReason ? { fallbackReason: clarification.fallbackReason } : {})
  };
  upsertClarificationTiming(response, {
    durationMs: Date.now() - clarificationStartedAt,
    llmUsed: clarification.llmUsed,
    fallbackUsed: !clarification.llmUsed,
    fallbackReason:
      clarification.fallbackReason ||
      (clarification.llmUsed ? "" : "deterministic similarity clarification planner used")
  });
  response.debug.notes = unique([
    ...response.debug.notes,
    clarification.llmUsed
      ? "LLM similarity clarification planner attached to demo search response"
      : "deterministic similarity clarification planner attached to demo search response"
  ]);
  return response;
}

function upsertClarificationTiming(
  response: DemoSearchResponse,
  timing: Pick<DemoDebugTiming, "durationMs" | "llmUsed" | "fallbackUsed" | "fallbackReason">
): void {
  const stageName: DemoDebugTiming["stageName"] = "similarity_clarification_plan";
  const existingTimings = response.debug.timings ?? [];
  const withoutClarification = existingTimings.filter((item) => item.stageName !== stageName);

  response.debug.timings = [
    {
      stageName,
      provider: llmRouter.getProviderForTask(stageName),
      model: llmRouter.getModelForTask(stageName),
      ...timing
    },
    ...withoutClarification
  ];
}

function buildClarificationContext(
  query: string,
  answers: DemoClarificationAnswers
): DemoDebugClarificationContext {
  const basePlan = createDeterministicSimilarityClarificationPlan(query);
  const { answerLabels, unresolvedAnswers } = readClarificationAnswerResolution(
    basePlan.card,
    answers
  );
  const searchableAnswerLabels = Object.fromEntries(
    Object.entries(answerLabels).filter(([key]) => !unresolvedAnswers[key])
  );
  const answeredPlan = createDeterministicSimilarityClarificationPlan(
    query,
    searchableAnswerLabels
  );
  const questionLabels = new Map(
    basePlan.card.questions.map((question) => [question.id, question.label])
  );
  const answerParts = Object.entries(answerLabels).map(
    ([key, value]) => `${questionLabels.get(key) ?? key}: ${value}`
  );
  const compactAnswerText = Object.values(answerLabels).join(" ");
  const queryPlan = answeredPlan.debug.queryPlan;
  const searchHints = unique(
    [
      ...(queryPlan?.primary ?? []),
      ...(queryPlan?.secondary ?? []),
      `${query} ${compactAnswerText}`,
      ...Object.values(answerLabels).flatMap((label) => [
        `${query} ${label}`,
        `${label} 选择复盘`
      ]),
      ...answerParts.map((part) => `${query} ${part}`)
    ].map((item) => item.trim()).filter(Boolean)
  ).slice(0, 8);

  return {
    originalQuery: query,
    answers,
    answerLabels,
    ...(Object.keys(unresolvedAnswers).length > 0 ? { unresolvedAnswers } : {}),
    answerSummary: answerParts.join("；"),
    searchHints,
    applied: true,
    searchHintCount: searchHints.length,
    queryPlan
  };
}

function getSearchableAnswerLabels(
  context: DemoDebugClarificationContext
): DemoClarificationAnswers {
  return Object.fromEntries(
    Object.entries(context.answerLabels).filter(([key]) => !context.unresolvedAnswers?.[key])
  );
}

function buildRuleClarifyingCard(query: string): {
  card: DemoClarifyingCard;
  ambiguityLevel: "medium" | "high";
  debug?: DemoDebugClarificationPlan;
} {
  const clarification = createDeterministicSimilarityClarificationPlan(query);
  return {
    card: clarification.card,
    ambiguityLevel: clarification.ambiguityLevel,
    debug: clarification.debug
  };

  // Legacy template code below is unreachable and kept only until the old helper
  // block is fully removed from this large service file.
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

  if (isObjectiveSlotClarificationQuery(normalized)) {
    const clarification = createObjectiveSlotClarification(query);
    return {
      ambiguityLevel: "high",
      card: clarification.card,
      debug: clarification.debug
    };
  }

  if (/不工作|不上班|裸辞|失业|离职|辞职|被裁|裁员|gap/.test(normalized)) {
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

function isObjectiveSlotClarificationQuery(normalizedQuery: string): boolean {
  return /裸辞|离职|辞职|被裁|裁员|失业|待业|不工作|不上班|转行|转产品|产品经理|程序员|写代码|自由职业|创业|回老家|开店|读研|考研|升学|一线城市|二线城市|保险经纪人|职业咨询|心理咨询|心理行业|新能源|小红书|博主|接私单|私单|独立开发|个人开发者|indiehacker|体制内|教师|老师|大厂|施工单位|工地|工程|自媒体|工作十年|gap/.test(
    normalizedQuery
  );
}

function createObjectiveSlotClarification(query: string): {
  card: DemoClarifyingCard;
  debug: DemoDebugClarificationPlan;
} {
  const normalizedQuery = query.replace(/\s+/g, "").toLowerCase();
  const { objectiveSlots } = buildObjectiveSearchContext(query);
  const intentCategory = inferSimilarityIntentCategory(normalizedQuery);
  const knownSlots = buildKnownSimilaritySlots(objectiveSlots, query);
  const candidates = buildSimilarityQuestionCandidates(
    intentCategory,
    normalizedQuery,
    knownSlots
  );
  const questions = selectSimilarityQuestions(candidates, knownSlots);
  const selectedSlots = questions.map((question) => question.slot ?? question.id);
  const selectedQuestions = questions.map((question) => ({
    slot: question.slot ?? question.id,
    question: question.question ?? question.label,
    selectedReason:
      question.selectedReason ?? "补齐相似人匹配所需的身份、履历或资源槽位"
  }));
  const queryPlan = buildClarificationSimilarityQueryPlan(intentCategory, knownSlots);

  return {
    card: createClarifyingCard(
      "补充一点背景，帮你找到更像你的人",
      "我们不会直接替你判断，只是用这些信息去匹配相似处境下的真实经历。",
      questions
    ),
    debug: {
      intentCategory,
      knownSlots,
      missingSimilaritySlots: selectedSlots,
      selectedQuestions,
      selectedSlots,
      rejectedQuestions: buildRejectedClarificationQuestions(),
      queryPlan
    }
  };
}

type SimilarityIntentCategory =
  | "tech_to_product"
  | "institution_to_content_creator"
  | "construction_career_exit"
  | "teacher_to_counseling"
  | "exam_or_public_sector"
  | "freelance_or_self_employment"
  | "entrepreneurship"
  | "city_or_homecoming"
  | "generic_career_transition";

function inferSimilarityIntentCategory(normalizedQuery: string): SimilarityIntentCategory {
  if (
    /程序员|研发|技术|写代码/.test(normalizedQuery) &&
    /转产品|产品经理|产品岗|业务岗位/.test(normalizedQuery)
  ) {
    return "tech_to_product";
  }

  if (
    /教师|老师|教育/.test(normalizedQuery) &&
    /心理咨询|心理行业|咨询服务|咨询/.test(normalizedQuery)
  ) {
    return "teacher_to_counseling";
  }

  if (
    /体制内|事业单位|公务员|编制内/.test(normalizedQuery) &&
    /自媒体|内容创业|个人ip|个人IP|博主/.test(normalizedQuery)
  ) {
    return "institution_to_content_creator";
  }

  if (
    /施工单位|工地|工程|造价|项目现场/.test(normalizedQuery) &&
    /离职|辞职|转行|不想干|还能做什么|能做什么|出路/.test(normalizedQuery)
  ) {
    return "construction_career_exit";
  }

  if (/考公|考编|考研|读研|升学|全职备考|转去体制内/.test(normalizedQuery)) {
    return "exam_or_public_sector";
  }

  if (/回老家|一线城市|二线城市|小城市|大城市|换城市|离开北京|离开上海|去.*城市/.test(normalizedQuery)) {
    return "city_or_homecoming";
  }

  if (/创业|开店|咖啡店|做项目/.test(normalizedQuery)) {
    return "entrepreneurship";
  }

  if (/自由职业|接私单|私单|副业|自己干|自媒体|独立开发|个人开发者|indiehacker|小红书|博主/.test(normalizedQuery)) {
    return "freelance_or_self_employment";
  }

  return "generic_career_transition";
}

function buildKnownSimilaritySlots(
  objectiveSlots: DemoObjectiveSlots,
  query: string
): Record<string, string | null> {
  return {
    age: objectiveSlots.age,
    gender: extractKnownGender(query),
    city: objectiveSlots.city,
    industry: objectiveSlots.industry,
    companyType: objectiveSlots.companyType,
    role: objectiveSlots.role,
    currentRole: objectiveSlots.role,
    currentStatus: objectiveSlots.status,
    direction: objectiveSlots.direction,
    targetDirection: objectiveSlots.direction,
    workYears: extractKnownWorkYears(query),
    constraint: objectiveSlots.constraint
  };
}

function extractKnownGender(query: string): string | null {
  if (/女/.test(query)) {
    return "女";
  }

  if (/男/.test(query)) {
    return "男";
  }

  return null;
}

function extractKnownWorkYears(query: string): string | null {
  const match = query.match(/(?:工作|做了|从业)?\s*([一二三四五六七八九十\d]+)\s*年/);
  return match ? `${match[1]}年` : null;
}

function buildSimilarityQuestionCandidates(
  intentCategory: SimilarityIntentCategory,
  normalizedQuery: string,
  knownSlots: Record<string, string | null>
): DemoClarificationQuestion[] {
  switch (intentCategory) {
    case "tech_to_product":
      return buildTechToProductQuestions();
    case "institution_to_content_creator":
      return buildInstitutionContentCreatorQuestions();
    case "construction_career_exit":
      return buildConstructionCareerExitQuestions();
    case "teacher_to_counseling":
      return buildTeacherCounselingQuestions();
    case "exam_or_public_sector":
      return buildExamSimilarityQuestions(normalizedQuery);
    case "city_or_homecoming":
      return buildCityMigrationSimilarityQuestions(normalizedQuery, knownSlots);
    case "entrepreneurship":
      return buildEntrepreneurshipSimilarityQuestions(normalizedQuery, knownSlots);
    case "freelance_or_self_employment":
      return buildSelfEmploymentSimilarityQuestions(normalizedQuery, knownSlots);
    case "generic_career_transition":
    default:
      return buildGenericCareerTransitionQuestions(knownSlots);
  }
}

function buildTechToProductQuestions(): DemoClarificationQuestion[] {
  return [
    createTechDirectionQuestion(),
    createTechWorkYearsQuestion(),
    createProductRelatedExperienceQuestion()
  ];
}

function buildInstitutionContentCreatorQuestions(): DemoClarificationQuestion[] {
  return [
    createInstitutionRoleTypeQuestion(),
    createContentDirectionQuestion(),
    createContentFoundationQuestion()
  ];
}

function buildConstructionCareerExitQuestions(): DemoClarificationQuestion[] {
  return [
    createConstructionFunctionQuestion(),
    createWorkYearsQuestion(
      "你大概有几年施工或工程相关经验？",
      "补齐施工或工程经验年限，用于匹配同阶段离职转向样本"
    ),
    createConstructionAbilityQuestion()
  ];
}

function buildTeacherCounselingQuestions(): DemoClarificationQuestion[] {
  return [
    createTeacherStageQuestion(),
    createCounselingFoundationQuestion(),
    createCounselingRelatedExperienceQuestion()
  ];
}

function buildEntrepreneurshipSimilarityQuestions(
  normalizedQuery: string,
  knownSlots: Record<string, string | null>
): DemoClarificationQuestion[] {
  if (/开店|咖啡店/.test(normalizedQuery)) {
    return [
      knownSlots.role ? createProjectAssetQuestion("你过去主要做过哪类项目？") : createRoleQuestion(),
      createOperationExperienceQuestion(),
      createResourceTypeQuestion("你现在手里更接近哪类资源？"),
      createWorkYearsQuestion()
    ];
  }

  return [
    knownSlots.role ? createWorkYearsQuestion() : createRoleQuestion(),
    createProjectAssetQuestion("你过去主要做过哪类项目？"),
    createResourceTypeQuestion("你现在手里更接近哪类资源？"),
    createSkillDirectionQuestion("你目前积累最多的是哪类能力？")
  ];
}

function buildSelfEmploymentSimilarityQuestions(
  normalizedQuery: string,
  knownSlots: Record<string, string | null>
): DemoClarificationQuestion[] {
  if (/设计师|设计/.test(normalizedQuery) && /接私单|私单/.test(normalizedQuery)) {
    return [
      createDesignSkillQuestion(),
      createWorkYearsQuestion("你大概有几年设计经验？"),
      createResourceTypeQuestion("你目前积累最多的是哪类资源？"),
      createProjectAssetQuestion()
    ];
  }

  if (/独立开发|个人开发者|indiehacker/.test(normalizedQuery)) {
    return [
      createProjectAssetQuestion("独立开发现在已有哪类项目沉淀？"),
      createSkillDirectionQuestion("你目前积累最多的是哪类能力？"),
      createWorkYearsQuestion(),
      createResourceTypeQuestion("你现在手里更接近哪类资源？")
    ];
  }

  if (/开店|咖啡店/.test(normalizedQuery)) {
    return [
      knownSlots.role ? createProjectAssetQuestion("你过去主要做过哪类项目？") : createRoleQuestion(),
      createOperationExperienceQuestion(),
      createResourceTypeQuestion("你现在手里更接近哪类资源？"),
      createWorkYearsQuestion()
    ];
  }

  if (/自媒体|小红书|博主/.test(normalizedQuery)) {
    return [
      createContentAssetQuestion(),
      createSkillDirectionQuestion("你过去最常做哪类内容或项目？"),
      createWorkYearsQuestion(),
      createResourceTypeQuestion("你现在手里更接近哪类资源？")
    ];
  }

  return [
    knownSlots.role ? createWorkYearsQuestion() : createRoleQuestion(),
    createProjectAssetQuestion("你过去主要做过哪类项目？"),
    createResourceTypeQuestion("你现在手里更接近哪类资源？"),
    createSkillDirectionQuestion("你目前积累最多的是哪类能力？")
  ];
}

function buildExamSimilarityQuestions(normalizedQuery: string): DemoClarificationQuestion[] {
  if (/金融|中后台/.test(normalizedQuery)) {
    return [
      createFinancialFunctionQuestion(),
      createExamStageQuestion(/读研|考研|升学/.test(normalizedQuery) ? "读研目前准备到哪一步？" : "你目前考公准备到哪一步？"),
      createFinancialBackgroundQuestion(),
      createEducationBackgroundQuestion()
    ];
  }

  return [
    createEducationBackgroundQuestion(),
    createExamStageQuestion(/读研|考研|升学/.test(normalizedQuery) ? "读研目前准备到哪一步？" : "你目前考公准备到哪一步？"),
    createProfessionalBackgroundQuestion(),
    createWorkYearsQuestion()
  ];
}

function buildCityMigrationSimilarityQuestions(
  normalizedQuery: string,
  knownSlots: Record<string, string | null>
): DemoClarificationQuestion[] {
  if (/回老家/.test(normalizedQuery) && /开店|咖啡店/.test(normalizedQuery)) {
    return [
      knownSlots.role ? createLocalResourceQuestion("如果回老家，目前已有哪类当地资源？") : createRoleQuestion(),
      createOperationExperienceQuestion(),
      createProjectAssetQuestion("你过去主要做过哪类项目？"),
      createWorkYearsQuestion()
    ];
  }

  return [
    knownSlots.role ? createWorkYearsQuestion() : createRoleQuestion(),
    createTargetCityQuestion(),
    createLocalResourceQuestion("目标城市目前已有哪类资源？"),
    createIndustryQuestion()
  ];
}

function buildGenericCareerTransitionQuestions(
  knownSlots: Record<string, string | null>
): DemoClarificationQuestion[] {
  return [
    knownSlots.role ? createWorkYearsQuestion() : createRoleQuestion(),
    knownSlots.industry ? createCompanyTypeQuestion() : createIndustryQuestion(),
    createCurrentStatusQuestion(),
    createSkillDirectionQuestion("你目前积累最多的是哪类能力？")
  ];
}

function selectSimilarityQuestions(
  candidates: DemoClarificationQuestion[],
  knownSlots: Record<string, string | null>
): DemoClarificationQuestion[] {
  const selected: DemoClarificationQuestion[] = [];
  for (const question of candidates) {
    const slot = question.slot ?? question.id;
    if (knownSlots[slot] || !isAllowedSimilarityClarificationQuestion(question)) {
      continue;
    }

    appendClarificationQuestion(selected, question);
    if (selected.length >= REQUIRED_CLARIFICATION_QUESTIONS) {
      break;
    }
  }

  for (const fallback of [
    createWorkYearsQuestion(),
    createProjectAssetQuestion("你过去主要做过哪类项目？"),
    createResourceTypeQuestion("你现在手里更接近哪类资源？")
  ]) {
    if (selected.length >= REQUIRED_CLARIFICATION_QUESTIONS) {
      break;
    }
    if (isAllowedSimilarityClarificationQuestion(fallback)) {
      appendClarificationQuestion(selected, fallback);
    }
  }

  return selected.slice(0, REQUIRED_CLARIFICATION_QUESTIONS);
}

function isAllowedSimilarityClarificationQuestion(question: DemoClarificationQuestion): boolean {
  const text = [
    question.label,
    ...(question.options ?? []).map((option) => option.label)
  ].join(" ");
  return !/更想看|真实经历|最影响判断|最需要先考虑|最大现实压力|最大的现实压力|最缺哪块准备|考虑的方向是什么|能接受多久|承受多久|稳定工资|稳定收入|预期|预计|风险|冒险|信心|坚持|适合|值不值得|怕不怕后悔|未来|希望得到哪类建议|情况相似|走通了|失败复盘|长期结果/.test(
    text
  );
}

function buildRejectedClarificationQuestions(): DemoDebugClarificationPlan["rejectedQuestions"] {
  return [
    {
      question: "你能接受多久没有稳定收入？",
      reason: "future_judgment_or_risk_tolerance"
    },
    {
      question: "你预期未来月收入是多少？",
      reason: "future_income_prediction"
    },
    {
      question: "你觉得自己适合创业吗？",
      reason: "value_judgment_or_consulting_evaluation"
    },
    {
      question: "更想看哪类真实经历？",
      reason: "content_preference_not_similarity_slot"
    },
    {
      question: "最影响判断的约束是什么？",
      reason: "generic_constraint_not_user_background"
    }
  ];
}

function buildClarificationSimilarityQueryPlan(
  intentCategory: SimilarityIntentCategory,
  knownSlots: Record<string, string | null>
): DemoObjectiveQueryPlan {
  const primary: string[] = [];
  const secondary: string[] = [];
  const fallback: string[] = [];
  const age = knownSlots.age;
  const city = knownSlots.city;
  const industry = knownSlots.industry;
  const companyType = knownSlots.companyType;
  const role = normalizeSimilarityRole(knownSlots.role ?? knownSlots.currentRole);
  const status = knownSlots.currentStatus;
  const direction = knownSlots.direction ?? knownSlots.targetDirection;
  const workYears = knownSlots.workYears;
  const genderRole = knownSlots.gender && role ? `${knownSlots.gender}${role}` : role;

  switch (intentCategory) {
    case "tech_to_product":
      appendClarificationQuery(primary, age, role, direction ?? "产品经理");
      appendClarificationQuery(primary, role, "转产品经理");
      appendClarificationQuery(primary, "技术", "转产品经理");
      appendClarificationQuery(primary, age, role, "转产品");
      appendClarificationQuery(secondary, role, "不写代码", "转产品");
      appendClarificationQuery(secondary, "研发", "产品经理");
      appendClarificationQuery(fallback, "技术转产品", "复盘");
      appendClarificationQuery(fallback, role, "转行", "后悔");
      break;
    case "institution_to_content_creator":
      appendClarificationQuery(primary, companyType ?? "体制内", workYears, direction ?? "自媒体");
      appendClarificationQuery(primary, companyType ?? "体制内", "辞职", direction ?? "自媒体");
      appendClarificationQuery(primary, companyType ?? "体制内", "内容创业");
      appendClarificationQuery(primary, workYears, companyType ?? "体制内", "自媒体");
      appendClarificationQuery(secondary, "事业单位", "自媒体");
      appendClarificationQuery(secondary, "体制内", "个人IP");
      appendClarificationQuery(fallback, "体制内", "自媒体", "复盘");
      appendClarificationQuery(fallback, "辞职", "自媒体", "后悔");
      break;
    case "construction_career_exit":
      appendClarificationQuery(primary, industry ?? "施工单位", companyType, status ?? "辞职");
      appendClarificationQuery(primary, industry ?? "施工单位", "离职", direction ?? "出路");
      appendClarificationQuery(primary, "工程行业", "转行");
      appendClarificationQuery(primary, companyType, industry ?? "施工单位", "辞职");
      appendClarificationQuery(secondary, "施工单位", "转行", "方向");
      appendClarificationQuery(secondary, "工程人", "离职", "出路");
      appendClarificationQuery(fallback, "施工单位", "离职", "复盘");
      appendClarificationQuery(fallback, "工程行业", "转行", "后悔");
      break;
    case "teacher_to_counseling":
      appendClarificationQuery(primary, age, genderRole, direction ?? "心理咨询");
      appendClarificationQuery(primary, role ?? "教师", "转心理咨询");
      appendClarificationQuery(primary, "教育背景", "心理咨询");
      appendClarificationQuery(primary, age, role ?? "教师", "心理咨询");
      appendClarificationQuery(secondary, "教师", "心理行业");
      appendClarificationQuery(secondary, "老师", "咨询服务");
      appendClarificationQuery(fallback, "教师", "转心理咨询", "复盘");
      appendClarificationQuery(fallback, "心理咨询", "转行", "后悔");
      break;
    case "city_or_homecoming":
      appendClarificationQuery(primary, city, status, direction);
      appendClarificationQuery(primary, city, role, direction);
      appendClarificationQuery(primary, role, "回老家");
      appendClarificationQuery(secondary, city, "回老家", "生活");
      appendClarificationQuery(fallback, "回老家", "复盘");
      break;
    default:
      appendClarificationQuery(primary, age, companyType, status);
      appendClarificationQuery(primary, industry, role, direction);
      appendClarificationQuery(primary, role, status, direction);
      appendClarificationQuery(primary, city, role, direction);
      appendClarificationQuery(secondary, workYears, role, direction);
      appendClarificationQuery(secondary, companyType, status, direction);
      appendClarificationQuery(fallback, role, direction, "复盘");
      appendClarificationQuery(fallback, direction, "后悔");
      break;
  }

  return {
    primary: unique(primary).filter((query) => !isGenericProblemQuery(query)).slice(0, 5),
    secondary: unique(secondary).slice(0, 5),
    fallback: unique(fallback).slice(0, 4)
  };
}

function appendClarificationQuery(
  target: string[],
  ...keywords: Array<string | null | undefined>
): void {
  const tokens = keywords
    .flatMap((keyword) => (keyword ?? "").split(/\s+/))
    .map((token) => token.trim())
    .filter(Boolean);
  const query = unique(tokens).slice(0, 4).join(" ");
  if (query.split(/\s+/).filter(Boolean).length >= 2) {
    target.push(query);
  }
}

function normalizeSimilarityRole(role: string | null | undefined): string | null {
  if (role === "老师") {
    return "教师";
  }

  return role ?? null;
}

function isGenericProblemQuery(query: string): boolean {
  return /真实经历|后悔吗|怎么办|值得吗|值不值得|迷茫|能不能|靠谱吗|现实吗|可以吗/.test(query);
}

function createRoleQuestion(): DemoClarificationQuestion {
  return createClarificationQuestion("role", "你之前主要做什么岗位？", [
    ["product_operation", "产品 / 运营"],
    ["tech_rd", "技术 / 研发"],
    ["marketing_sales", "市场 / 销售"],
    ["design_content", "设计 / 内容"],
    ["functional_support", "职能 / 中后台"],
    ["other", "其他"]
  ]);
}

function createIndustryQuestion(): DemoClarificationQuestion {
  return createClarificationQuestion("industry", "你主要在哪个行业工作？", [
    ["internet", "互联网"],
    ["finance", "金融"],
    ["education", "教育"],
    ["construction", "建筑 / 施工"],
    ["manufacturing", "制造业"],
    ["consumer_service", "消费服务"]
  ]);
}

function createCompanyTypeQuestion(): DemoClarificationQuestion {
  return createClarificationQuestion("companyType", "你之前所在组织更接近哪类？", [
    ["big_tech", "互联网大厂"],
    ["state_owned", "国企"],
    ["foreign_company", "外企"],
    ["public_sector", "体制内"],
    ["startup_company", "创业公司"],
    ["traditional_company", "传统企业"]
  ]);
}

function createCurrentStatusQuestion(): DemoClarificationQuestion {
  return createClarificationQuestion("currentStatus", "你现在更接近哪种状态？", [
    ["employed", "还在职"],
    ["preparing_quit", "准备辞职"],
    ["already_quit", "已离职 / 裸辞"],
    ["laid_off", "被裁 / 待业"],
    ["started_trying", "已经开始尝试"],
    ["idea_only", "只是有想法"]
  ]);
}

function createWorkYearsQuestion(
  label = "你大概有几年相关经验？",
  selectedReason = "补齐工作年限，用于匹配同职业阶段的相似经历"
): DemoClarificationQuestion {
  return createClarificationQuestion("workYears", label, [
    ["under_1_year", "1年以内"],
    ["1_to_3_years", "1-3年"],
    ["3_to_5_years", "3-5年"],
    ["5_to_8_years", "5-8年"],
    ["over_8_years", "8年以上"]
  ], selectedReason);
}

function createTechDirectionQuestion(): DemoClarificationQuestion {
  return createClarificationQuestion(
    "techDirection",
    "你之前主要做哪类技术方向？",
    [
      ["frontend", "前端"],
      ["backend", "后端"],
      ["algorithm_data", "算法 / 数据"],
      ["test_qa", "测试 / QA"],
      ["full_stack", "全栈"],
      ["other", "其他"]
    ],
    "补齐技术细分方向，用于匹配技术转产品的相似经历"
  );
}

function createTechWorkYearsQuestion(): DemoClarificationQuestion {
  return createClarificationQuestion(
    "workYears",
    "你大概有几年开发或技术经验？",
    [
      ["under_1_year", "1年以内"],
      ["1_to_3_years", "1-3年"],
      ["3_to_5_years", "3-5年"],
      ["5_to_8_years", "5-8年"],
      ["over_8_years", "8年以上"]
    ],
    "补齐技术工作年限，用于匹配同阶段转产品样本"
  );
}

function createProductRelatedExperienceQuestion(): DemoClarificationQuestion {
  return createClarificationQuestion(
    "productRelatedExperience",
    "你过去更接近哪类产品相关经历？",
    [
      ["wrote_prd", "写过需求文档"],
      ["requirement_review", "参与过需求评审"],
      ["project_coordination", "做过项目协调"],
      ["business_user_comm", "和用户或业务方沟通过"],
      ["tech_only", "只负责技术实现"],
      ["not_sure", "还不确定"]
    ],
    "补齐产品相关经历，用于匹配技术背景向产品迁移的相似资源"
  );
}

function createInstitutionRoleTypeQuestion(): DemoClarificationQuestion {
  return createClarificationQuestion(
    "institutionRoleType",
    "你在体制内主要做哪类工作？",
    [
      ["admin_general", "行政 / 综合"],
      ["education_medical", "教育 / 医疗"],
      ["public_service", "政务 / 公共服务"],
      ["finance_audit", "财务 / 审计"],
      ["publicity_writing", "宣传 / 文字材料"],
      ["other", "其他"]
    ],
    "补齐体制内岗位类型，用于匹配相似履历的内容转向样本"
  );
}

function createContentDirectionQuestion(): DemoClarificationQuestion {
  return createClarificationQuestion(
    "contentDirection",
    "你想做哪类内容方向？",
    [
      ["career_experience", "职场经验"],
      ["education_family", "教育 / 家庭"],
      ["social_observation", "时事 / 社会观察"],
      ["knowledge", "知识科普"],
      ["lifestyle", "生活方式"],
      ["undecided", "还没确定"]
    ],
    "补齐内容方向，用于匹配体制内转自媒体的相似主题路径"
  );
}

function createContentFoundationQuestion(): DemoClarificationQuestion {
  return createClarificationQuestion(
    "contentFoundation",
    "你目前已有哪类内容基础？",
    [
      ["writing_expression", "写作表达"],
      ["video_editing", "视频拍摄 / 剪辑"],
      ["account_operation", "账号运营经验"],
      ["domain_expertise", "专业领域积累"],
      ["community", "朋友圈或社群资源"],
      ["none", "几乎没有"]
    ],
    "补齐内容基础，用于匹配已有资源相近的转自媒体经历"
  );
}

function createConstructionAbilityQuestion(): DemoClarificationQuestion {
  return createClarificationQuestion(
    "engineeringAbility",
    "你目前积累最多的是哪类工程能力？",
    [
      ["site_coordination", "现场协调 / 项目管理"],
      ["cost_budget", "造价预算 / 成本"],
      ["safety_quality_docs", "安全质量 / 资料"],
      ["materials_supply", "材料采购 / 供应链"],
      ["client_subcontractor", "甲方沟通 / 分包管理"],
      ["certificate", "证书 / 工程资质"]
    ],
    "补齐工程行业能力，用于匹配施工单位离职后的相似转向资源"
  );
}

function createTeacherStageQuestion(): DemoClarificationQuestion {
  return createClarificationQuestion(
    "teacherStage",
    "你之前主要是哪类教师？",
    [
      ["kindergarten", "幼儿园"],
      ["primary_school", "小学"],
      ["middle_high_school", "初中 / 高中"],
      ["vocational_college", "职校 / 高校"],
      ["training_center", "教培机构"],
      ["other", "其他"]
    ],
    "补齐教师学段，用于匹配教育背景转心理咨询的相似人群"
  );
}

function createCounselingFoundationQuestion(): DemoClarificationQuestion {
  return createClarificationQuestion(
    "counselingFoundation",
    "你是否有心理学或咨询相关基础？",
    [
      ["psychology_education_major", "心理学 / 教育学专业"],
      ["systematic_course", "上过系统课程"],
      ["certificate_exam", "有证书或考试基础"],
      ["student_psychology", "做过学生心理相关工作"],
      ["interest_only", "只有兴趣"],
      ["none", "还没有"]
    ],
    "补齐心理咨询基础，用于匹配教师转咨询服务的起点差异"
  );
}

function createCounselingRelatedExperienceQuestion(): DemoClarificationQuestion {
  return createClarificationQuestion(
    "counselingRelatedExperience",
    "你过去更接近哪类相关经验？",
    [
      ["student_comm", "学生沟通"],
      ["home_school_comm", "家校沟通"],
      ["case_counseling", "个案辅导"],
      ["class_management", "班级管理"],
      ["emotional_support", "情绪支持"],
      ["none", "暂时没有"]
    ],
    "补齐相关沟通和辅导经历，用于匹配咨询能力迁移样本"
  );
}

function createDesignSkillQuestion(): DemoClarificationQuestion {
  return createClarificationQuestion("skillDirection", "你主要是哪类设计师？", [
    ["ui_ux", "UI / UX"],
    ["brand_graphic", "平面 / 品牌"],
    ["ecommerce_design", "电商设计"],
    ["space_design", "室内 / 空间"],
    ["illustration_visual", "插画 / 视觉"],
    ["other", "其他"]
  ]);
}

function createSkillDirectionQuestion(label: string): DemoClarificationQuestion {
  return createClarificationQuestion("skillDirection", label, [
    ["product_planning", "产品 / 策划"],
    ["technical_delivery", "技术 / 交付"],
    ["content_creation", "内容 / 表达"],
    ["client_sales", "客户 / 销售"],
    ["operation_management", "运营 / 管理"],
    ["other", "其他"]
  ]);
}

function createProjectAssetQuestion(label = "你是否有作品集、案例或项目沉淀？"): DemoClarificationQuestion {
  return createClarificationQuestion("projectAsset", label, [
    ["portfolio", "完整作品集"],
    ["company_projects", "公司项目经验"],
    ["side_projects", "副业 / 个人项目"],
    ["public_cases", "公开案例"],
    ["client_cases", "客户案例"],
    ["not_sure", "还不确定"]
  ]);
}

function createResourceTypeQuestion(label: string): DemoClarificationQuestion {
  return createClarificationQuestion("resourceType", label, [
    ["portfolio", "作品 / 案例"],
    ["company_experience", "公司项目经验"],
    ["client_communication", "客户沟通经验"],
    ["friends_colleagues", "朋友 / 前同事资源"],
    ["platform_account", "平台账号或个人主页"],
    ["not_sure", "还不确定"]
  ]);
}

function createOperationExperienceQuestion(): DemoClarificationQuestion {
  return createClarificationQuestion("projectExperience", "你过去是否有经营或线下项目经验？", [
    ["store_operation", "门店 / 餐饮经验"],
    ["sales_customer", "销售 / 客户经验"],
    ["supply_chain", "供应链 / 采购"],
    ["team_management", "团队管理"],
    ["project_management", "项目管理"],
    ["none", "暂时没有"]
  ]);
}

function createContentAssetQuestion(): DemoClarificationQuestion {
  return createClarificationQuestion("contentAsset", "你现在已有哪类内容资产？", [
    ["published_posts", "已发布内容"],
    ["small_account", "平台账号"],
    ["stable_topic", "稳定选题方向"],
    ["community", "社群 / 私域"],
    ["commercial_case", "商业合作案例"],
    ["none", "暂时没有"]
  ]);
}

function createFinancialFunctionQuestion(): DemoClarificationQuestion {
  return createClarificationQuestion("function", "你之前主要做哪类中后台岗位？", [
    ["risk_compliance", "风控 / 合规"],
    ["finance_audit", "财务 / 审计"],
    ["ops_clearing", "运营 / 清算"],
    ["hr_admin", "人力 / 行政"],
    ["tech_data", "技术 / 数据"],
    ["other", "其他"]
  ]);
}

function createExamStageQuestion(label: string): DemoClarificationQuestion {
  return createClarificationQuestion("examStage", label, [
    ["idea_only", "只是初步想法"],
    ["chosen_region", "已确定地区"],
    ["chosen_role", "已确定岗位"],
    ["started_prep", "已经备考"],
    ["taken_exam", "考过一次"],
    ["unknown", "还不确定"]
  ]);
}

function createFinancialBackgroundQuestion(): DemoClarificationQuestion {
  return createClarificationQuestion("professionalBackground", "你的背景更接近哪类？", [
    ["finance_early", "金融行业应届或早期"],
    ["finance_3_to_5", "金融行业 3-5 年"],
    ["finance_over_5", "金融行业 5 年以上"],
    ["accounting_law_cs", "财会 / 法律 / 计算机背景"],
    ["other", "其他"]
  ]);
}

function createEducationBackgroundQuestion(): DemoClarificationQuestion {
  return createClarificationQuestion("educationBackground", "你的学历或专业背景更接近哪类？", [
    ["liberal_arts", "文科 / 社科"],
    ["business", "商科 / 经管"],
    ["engineering", "理工 / 计算机"],
    ["law_finance", "法律 / 财会"],
    ["education_medical", "教育 / 医学"],
    ["other", "其他"]
  ]);
}

function createProfessionalBackgroundQuestion(): DemoClarificationQuestion {
  return createClarificationQuestion("professionalBackground", "你的专业背景更接近哪类？", [
    ["current_major_related", "和当前工作相关"],
    ["target_related", "和目标方向相关"],
    ["certificate_or_exam", "有证书 / 考试基础"],
    ["cross_major", "跨专业背景"],
    ["not_sure", "还不确定"]
  ]);
}

function createTargetCityQuestion(): DemoClarificationQuestion {
  return createClarificationQuestion("targetCity", "目标城市目前更明确的是哪类？", [
    ["beijing_shanghai", "北京 / 上海"],
    ["first_tier", "一线城市"],
    ["new_first_tier", "新一线 / 省会"],
    ["second_tier", "二线城市"],
    ["hometown", "老家 / 县城"],
    ["unclear", "还没定"]
  ]);
}

function createLocalResourceQuestion(label: string): DemoClarificationQuestion {
  return createClarificationQuestion("localResource", label, [
    ["family_support", "家人支持"],
    ["housing", "住处"],
    ["friends_classmates", "朋友 / 同学"],
    ["local_network", "本地人脉"],
    ["job_or_project_leads", "工作 / 项目线索"],
    ["none", "暂时没有"]
  ]);
}

function createConstructionFunctionQuestion(): DemoClarificationQuestion {
  return createClarificationQuestion("function", "你在施工单位主要做哪类工作？", [
    ["site_engineering", "现场 / 工程"],
    ["cost_budget", "造价 / 预算"],
    ["safety_quality", "安全 / 质量"],
    ["materials_procurement", "材料 / 采购"],
    ["office_admin", "办公室 / 行政"],
    ["other", "其他"]
  ], "补齐施工岗位类型，用于匹配工程行业内相似履历");
}

function inferObjectiveClarificationStage(normalizedQuery: string): ObjectiveClarificationStage {
  if (/已经开始|已开始|正在做|已经在做|开始做|准备开|正在开|已经开|已开|已经决定|已决定|已接单|正在接单|开始接单/.test(normalizedQuery)) {
    return "execution";
  }

  if (/要不要|靠不靠谱|靠谱吗|现实吗|可行吗|可以吗|值不值得|值得吗|适合吗|能不能|能做吗|行不行/.test(normalizedQuery)) {
    return "evaluation";
  }

  return "exploration";
}

function shouldAskObjectiveSlotQuestion(
  slotName: DemoObjectiveSlotName,
  missingSlots: DemoObjectiveSlotName[],
  stage: ObjectiveClarificationStage
): boolean {
  if (!missingSlots.includes(slotName)) {
    return false;
  }

  if (stage === "evaluation" && slotName === "constraint") {
    return false;
  }

  return true;
}

function createObjectiveSlotQuestion(
  slotName: DemoObjectiveSlotName,
  normalizedQuery: string
): DemoClarificationQuestion | null {
  switch (slotName) {
    case "role":
      return createClarificationQuestion("role", "你之前主要做什么岗位？", [
        ["product_operation", "产品 / 运营"],
        ["tech_rd", "技术 / 研发"],
        ["marketing_sales", "市场 / 销售"],
        ["design_content", "设计 / 内容"],
        ["other", "其他"]
      ]);
    case "status":
      return createClarificationQuestion("status", "你现在是什么状态？", [
        ["already_quit", "已经裸辞"],
        ["preparing_quit", "正准备辞职"],
        ["laid_off_unemployed", "被裁 / 待业"],
        ["employed_switch", "还在职但想换方向"]
      ]);
    case "direction":
      return createDirectionClarificationQuestion(normalizedQuery);
    case "constraint":
      return createConstraintClarificationQuestion(normalizedQuery);
    default:
      return null;
  }
}

function createDirectionClarificationQuestion(normalizedQuery: string): DemoClarificationQuestion {
  if (/回老家/.test(normalizedQuery)) {
    return createClarificationQuestion("direction", "回老家后更想往哪个方向走？", [
      ["local_job", "找本地工作"],
      ["open_shop", "开店"],
      ["freelance", "自由职业"],
      ["civil_service", "考公 / 编制"],
      ["rest_first", "先休整"]
    ]);
  }

  if (/开店|咖啡店/.test(normalizedQuery)) {
    return createClarificationQuestion("direction", "你考虑的开店方向是什么？", [
      ["coffee_shop", "咖啡店"],
      ["food_drink", "餐饮小店"],
      ["retail_shop", "零售小店"],
      ["community_shop", "社区店"],
      ["unclear", "还没定"]
    ]);
  }

  return createClarificationQuestion("direction", "你考虑的方向是什么？", [
    ["startup", "创业"],
    ["freelance", "自由职业"],
    ["switch_career", "转行"],
    ["return_home", "回老家"],
    ["unclear", "还没想清楚"]
  ]);
}

function createConstraintClarificationQuestion(normalizedQuery: string): DemoClarificationQuestion {
  if (/开店|咖啡店/.test(normalizedQuery)) {
    return createClarificationQuestion("constraint", "开店前最缺的是哪块准备？", [
      ["startup_money", "启动资金"],
      ["shop_location", "店铺位置"],
      ["customer_source", "客源渠道"],
      ["shop_experience", "餐饮 / 经营经验"],
      ["partner_staff", "合伙人 / 人手"],
      ["trial_time", "试错时间"]
    ]);
  }

  if (/回老家/.test(normalizedQuery)) {
    return createClarificationQuestion("constraint", "回老家最大的现实约束是什么？", [
      ["local_jobs", "本地工作机会"],
      ["income_gap", "收入落差"],
      ["family_relation", "家庭关系"],
      ["housing_life", "住房 / 生活适应"],
      ["social_circle", "圈子变化"]
    ]);
  }

  if (/自媒体/.test(normalizedQuery)) {
    return createClarificationQuestion("constraint", "做自媒体最缺哪类准备？", [
      ["cashflow", "现金流"],
      ["content_direction", "内容方向"],
      ["growth_channel", "涨粉渠道"],
      ["execution_rhythm", "更新节奏"],
      ["family_support", "家人支持"]
    ]);
  }

  if (/自由职业/.test(normalizedQuery)) {
    return createClarificationQuestion("constraint", "自由职业最大的现实压力是什么？", [
      ["client_source", "客户来源"],
      ["unstable_income", "收入不稳定"],
      ["self_management", "自我管理"],
      ["social_security", "社保医保"],
      ["portfolio", "作品项目"]
    ]);
  }

  if (/创业/.test(normalizedQuery)) {
    return createClarificationQuestion("constraint", "创业前最大的现实约束是什么？", [
      ["limited_savings", "存款有限"],
      ["unclear_project", "项目不清晰"],
      ["no_partner", "缺少合伙人"],
      ["family_pressure", "家庭压力"],
      ["age_pressure", "年龄压力"]
    ]);
  }

  return createClarificationQuestion("constraint", "你最大的现实约束是什么？", [
    ["limited_savings", "存款有限"],
    ["mortgage_family", "房贷 / 家庭压力"],
    ["age_pressure", "年龄焦虑"],
    ["no_project_partner", "缺少项目或合伙人"],
    ["avoid_original_industry", "不想再回原行业"]
  ]);
}

function appendEvaluationObjectiveQuestions(
  questions: DemoClarificationQuestion[],
  normalizedQuery: string
): void {
  if (/独立开发|个人开发者|indiehacker/.test(normalizedQuery)) {
    appendClarificationQuestion(questions, createCashRunwayQuestion());
    appendClarificationQuestion(questions, createIndependentDeveloperBasisQuestion());
    appendClarificationQuestion(questions, createCashflowSourceQuestion());
    return;
  }

  if (/读研|考研|升学/.test(normalizedQuery)) {
    appendClarificationQuestion(questions, createStudyPreparationQuestion());
    appendClarificationQuestion(questions, createStudyFundingQuestion());
    appendClarificationQuestion(questions, createStudyTimeCostQuestion());
    return;
  }

  if (/一线城市|二线城市|大城市/.test(normalizedQuery) && /找工作|工作/.test(normalizedQuery)) {
    appendClarificationQuestion(questions, createCityJobBasisQuestion());
    appendClarificationQuestion(questions, createJobSearchRunwayQuestion());
    appendClarificationQuestion(questions, createCitySupportQuestion());
    return;
  }

  if (/回老家/.test(normalizedQuery)) {
    appendClarificationQuestion(questions, createReturnHomeResourceQuestion());
    appendClarificationQuestion(questions, createTrialBudgetQuestion("当前能承受的试错成本更接近哪种？"));
    appendClarificationQuestion(questions, createCashRunwayQuestion());
    return;
  }

  if (/开店|咖啡店/.test(normalizedQuery)) {
    appendClarificationQuestion(questions, createCashRunwayQuestion());
    appendClarificationQuestion(
      questions,
      createTrialBudgetQuestion("当前能承受的开店试错成本更接近哪种？")
    );
    appendClarificationQuestion(questions, createCurrentResourceQuestion());
    return;
  }

  if (/保险经纪人/.test(normalizedQuery)) {
    appendClarificationQuestion(questions, createBrokerBasisQuestion());
    appendClarificationQuestion(questions, createClientResourceQuestion());
    appendClarificationQuestion(questions, createCashRunwayQuestion());
    return;
  }

  if (/接私单|私单/.test(normalizedQuery)) {
    appendClarificationQuestion(questions, createFreelanceOrderBasisQuestion());
    appendClarificationQuestion(questions, createCashflowSourceQuestion());
    appendClarificationQuestion(questions, createCashRunwayQuestion());
    return;
  }

  if (/职业咨询/.test(normalizedQuery)) {
    appendClarificationQuestion(questions, createConsultingBasisQuestion());
    appendClarificationQuestion(questions, createClientResourceQuestion());
    appendClarificationQuestion(questions, createCashRunwayQuestion());
    return;
  }

  if (/新能源/.test(normalizedQuery)) {
    appendClarificationQuestion(questions, createTargetIndustryBasisQuestion("新能源行业目前已有的基础是什么？"));
    appendClarificationQuestion(questions, createSkillGapQuestion());
    appendClarificationQuestion(questions, createJobSearchRunwayQuestion());
    return;
  }

  if (/小红书|博主/.test(normalizedQuery)) {
    appendClarificationQuestion(questions, createContentBasisQuestion());
    appendClarificationQuestion(questions, createContentMonetizationQuestion());
    appendClarificationQuestion(questions, createCashRunwayQuestion());
    return;
  }

  if (/考公/.test(normalizedQuery)) {
    appendClarificationQuestion(questions, createCivilServicePreparationQuestion());
    appendClarificationQuestion(questions, createStudyTimeCostQuestion());
    appendClarificationQuestion(questions, createCashRunwayQuestion());
    return;
  }

  if (/自由职业/.test(normalizedQuery)) {
    appendClarificationQuestion(questions, createCashRunwayQuestion());
    appendClarificationQuestion(questions, createCashflowSourceQuestion());
    appendClarificationQuestion(questions, createMonetizableResourceQuestion());
    return;
  }

  if (/自媒体/.test(normalizedQuery)) {
    appendClarificationQuestion(questions, createCashRunwayQuestion());
    appendClarificationQuestion(questions, createContentBasisQuestion());
    appendClarificationQuestion(questions, createCashflowSourceQuestion());
    return;
  }

  appendClarificationQuestion(questions, createCashRunwayQuestion());
  appendClarificationQuestion(questions, createCashflowSourceQuestion());
  appendClarificationQuestion(questions, createMonetizableResourceQuestion());
}

function createCashRunwayQuestion(): DemoClarificationQuestion {
  return createClarificationQuestion("cash_runway", "目前可支撑多久没有稳定工资？", [
    ["under_1_month", "1个月以内"],
    ["1_to_3_months", "1-3个月"],
    ["3_to_6_months", "3-6个月"],
    ["6_to_12_months", "6-12个月"],
    ["over_12_months", "12个月以上"],
    ["unknown", "不确定"]
  ]);
}

function createCashflowSourceQuestion(): DemoClarificationQuestion {
  return createClarificationQuestion("cashflow_source", "现在是否有稳定现金流或项目来源？", [
    ["none", "还没有"],
    ["sporadic_projects", "有零散项目"],
    ["stable_side_income", "有稳定副业"],
    ["fixed_clients", "有固定客户"],
    ["passive_income", "有被动收入"],
    ["unknown", "不确定"]
  ]);
}

function createMonetizableResourceQuestion(): DemoClarificationQuestion {
  return createClarificationQuestion("monetizable_resource", "已有可变现资源更接近哪类？", [
    ["professional_skill", "专业技能"],
    ["portfolio", "作品案例"],
    ["client_network", "客户人脉"],
    ["content_account", "内容账号"],
    ["sellable_product", "可售产品"],
    ["none", "暂时没有"]
  ]);
}

function createIndependentDeveloperBasisQuestion(): DemoClarificationQuestion {
  return createClarificationQuestion("indie_basis", "独立开发现在已有的基础是什么？", [
    ["idea", "产品想法"],
    ["prototype", "可运行产品"],
    ["early_users", "早期用户"],
    ["paid_customers", "付费客户"],
    ["tech_skill", "技术能力"],
    ["none", "暂时没有"]
  ]);
}

function createStudyPreparationQuestion(): DemoClarificationQuestion {
  return createClarificationQuestion("study_preparation", "读研目前准备到哪一步了？", [
    ["idea_only", "只是初步想法"],
    ["chosen_major", "确定专业方向"],
    ["checked_schools", "了解过院校"],
    ["started_exam_prep", "已经开始备考"],
    ["has_offer", "已有录取机会"],
    ["unknown", "还不确定"]
  ]);
}

function createStudyFundingQuestion(): DemoClarificationQuestion {
  return createClarificationQuestion("study_funding", "读研期间主要经济来源更接近哪种？", [
    ["savings", "靠存款"],
    ["family_support", "家人支持"],
    ["part_time", "兼职 / 项目"],
    ["scholarship", "奖学金"],
    ["loan", "贷款"],
    ["unknown", "还不确定"]
  ]);
}

function createStudyTimeCostQuestion(): DemoClarificationQuestion {
  return createClarificationQuestion("study_time_cost", "能接受多长时间没有稳定收入？", [
    ["under_6_months", "6个月以内"],
    ["6_to_12_months", "6-12个月"],
    ["1_to_2_years", "1-2年"],
    ["2_to_3_years", "2-3年"],
    ["over_3_years", "3年以上"],
    ["unknown", "不确定"]
  ]);
}

function createCityJobBasisQuestion(): DemoClarificationQuestion {
  return createClarificationQuestion("city_job_basis", "去目标城市找工作，目前最明确的基础是什么？", [
    ["target_city", "目标城市"],
    ["target_role", "目标岗位"],
    ["interview_leads", "面试机会"],
    ["local_network", "当地人脉"],
    ["place_to_stay", "落脚住处"],
    ["none", "暂时没有"]
  ]);
}

function createJobSearchRunwayQuestion(): DemoClarificationQuestion {
  return createClarificationQuestion("job_search_runway", "能承受多久求职空窗？", [
    ["under_1_month", "1个月以内"],
    ["1_to_3_months", "1-3个月"],
    ["3_to_6_months", "3-6个月"],
    ["6_to_12_months", "6-12个月"],
    ["over_12_months", "12个月以上"],
    ["unknown", "不确定"]
  ]);
}

function createCitySupportQuestion(): DemoClarificationQuestion {
  return createClarificationQuestion("city_support", "目标城市现在有什么支持条件？", [
    ["friends", "朋友同学"],
    ["relatives", "亲戚家人"],
    ["housing", "可落脚住处"],
    ["job_leads", "工作机会"],
    ["savings", "可用存款"],
    ["none", "暂时没有"]
  ]);
}

function createBrokerBasisQuestion(): DemoClarificationQuestion {
  return createClarificationQuestion("broker_basis", "保险经纪人现在已有的基础是什么？", [
    ["sales_experience", "销售经验"],
    ["client_network", "客户人脉"],
    ["license_ready", "证书 / 资质"],
    ["mentor_team", "团队或师傅"],
    ["trial_order", "已试单"],
    ["none", "暂时没有"]
  ]);
}

function createClientResourceQuestion(): DemoClarificationQuestion {
  return createClarificationQuestion("client_resource", "目前客户或人脉资源更接近哪种？", [
    ["none", "基本没有"],
    ["friends_family", "亲友熟人"],
    ["old_clients", "旧客户"],
    ["industry_network", "行业人脉"],
    ["online_leads", "线上线索"],
    ["stable_clients", "稳定客户"]
  ]);
}

function createFreelanceOrderBasisQuestion(): DemoClarificationQuestion {
  return createClarificationQuestion("freelance_order_basis", "接私单目前已有的基础是什么？", [
    ["portfolio", "作品案例"],
    ["old_clients", "老客户"],
    ["platform_account", "平台账号"],
    ["stable_orders", "稳定单量"],
    ["partner_channel", "合作渠道"],
    ["none", "暂时没有"]
  ]);
}

function createConsultingBasisQuestion(): DemoClarificationQuestion {
  return createClarificationQuestion("consulting_basis", "职业咨询现在已有的基础是什么？", [
    ["hr_experience", "招聘 / HR经验"],
    ["industry_cases", "行业案例"],
    ["consulting_training", "咨询训练"],
    ["content_account", "内容账号"],
    ["paid_clients", "付费客户"],
    ["none", "暂时没有"]
  ]);
}

function createTargetIndustryBasisQuestion(label: string): DemoClarificationQuestion {
  return createClarificationQuestion("target_industry_basis", label, [
    ["related_experience", "相关经验"],
    ["transferable_skill", "可迁移技能"],
    ["industry_contact", "行业人脉"],
    ["interview_leads", "面试机会"],
    ["learning_started", "已经学习"],
    ["none", "暂时没有"]
  ]);
}

function createSkillGapQuestion(): DemoClarificationQuestion {
  return createClarificationQuestion("skill_gap", "目前最大的能力差距更像哪类？", [
    ["industry_knowledge", "行业知识"],
    ["technical_skill", "技术能力"],
    ["project_experience", "项目经验"],
    ["certificate", "证书资质"],
    ["network", "没人带路"],
    ["unknown", "不确定"]
  ]);
}

function createContentMonetizationQuestion(): DemoClarificationQuestion {
  return createClarificationQuestion("content_monetization", "小红书方向目前最明确的变现线索是什么？", [
    ["none", "还没有"],
    ["brand_ads", "品牌合作"],
    ["services", "服务咨询"],
    ["commerce", "带货"],
    ["course", "课程产品"],
    ["private_domain", "私域转化"]
  ]);
}

function createCivilServicePreparationQuestion(): DemoClarificationQuestion {
  return createClarificationQuestion("civil_service_preparation", "考公目前准备到哪一步了？", [
    ["idea_only", "只是初步想法"],
    ["chosen_region", "确定地区"],
    ["chosen_role", "确定岗位"],
    ["started_prep", "已经备考"],
    ["taken_exam", "考过一次"],
    ["unknown", "还不确定"]
  ]);
}

function createReturnHomeResourceQuestion(): DemoClarificationQuestion {
  return createClarificationQuestion("home_resource", "如果回老家，目前最明确的现实资源是什么？", [
    ["housing", "住处"],
    ["family_support", "家人支持"],
    ["local_network", "本地人脉"],
    ["available_money", "可用资金"],
    ["low_cost", "低生活成本"],
    ["none", "暂时没有"]
  ]);
}

function createTrialBudgetQuestion(label: string): DemoClarificationQuestion {
  return createClarificationQuestion("trial_budget", label, [
    ["light_trial_only", "只能轻量尝试"],
    ["1_to_3_months", "1-3个月"],
    ["3_to_6_months", "3-6个月"],
    ["6_to_12_months", "6-12个月"],
    ["over_12_months", "一年以上"],
    ["unknown", "不确定"]
  ]);
}

function createCurrentResourceQuestion(): DemoClarificationQuestion {
  return createClarificationQuestion("current_resource", "目前最明确的现实资源是什么？", [
    ["available_money", "可用资金"],
    ["industry_experience", "行业经验"],
    ["local_network", "本地人脉"],
    ["partner", "合伙人"],
    ["low_cost_trial", "低成本试错"],
    ["none", "暂时没有"]
  ]);
}

function createContentBasisQuestion(): DemoClarificationQuestion {
  return createClarificationQuestion("content_basis", "自媒体现在已有的基础是什么？", [
    ["topic_direction", "内容方向"],
    ["published_content", "已发内容"],
    ["small_account", "已有账号"],
    ["stable_rhythm", "稳定更新"],
    ["commercial_clue", "变现线索"],
    ["none", "暂时没有"]
  ]);
}

function appendContextualObjectiveQuestions(
  questions: DemoClarificationQuestion[],
  normalizedQuery: string
): void {
  if (/开店|咖啡店/.test(normalizedQuery)) {
    appendClarificationQuestion(
      questions,
      createClarificationQuestion("shop_preparation", "开店准备到哪一步了？", [
        ["idea_only", "还在想"],
        ["has_budget", "有预算"],
        ["checked_location", "看过铺位"],
        ["has_product", "有品类 / 菜单"],
        ["has_partner", "已有合伙人"],
        ["small_trial", "做过试水"]
      ])
    );
  }

  if (/回老家/.test(normalizedQuery)) {
    appendClarificationQuestion(
      questions,
      createClarificationQuestion("home_plan", "回老家后更想怎么安排？", [
        ["local_job", "找本地工作"],
        ["family_business", "帮家里 / 做小生意"],
        ["open_shop", "开店"],
        ["remote_work", "远程 / 自由职业"],
        ["rest_first", "先休整"]
      ])
    );
  }
}

function appendObjectiveSlotFillerQuestions(
  questions: DemoClarificationQuestion[],
  slots: DemoObjectiveSlots
): void {
  if (!slots.companyType) {
    appendClarificationQuestion(
      questions,
      createClarificationQuestion("companyType", "你之前所在组织更接近哪类？", [
        ["big_tech", "互联网大厂"],
        ["state_owned", "国企"],
        ["public_sector", "体制内"],
        ["startup_company", "创业公司"],
        ["traditional_company", "传统企业"],
        ["other", "其他"]
      ])
    );
  }

  if (!slots.industry) {
    appendClarificationQuestion(
      questions,
      createClarificationQuestion("industry", "你之前主要在哪个行业？", [
        ["internet", "互联网"],
        ["education", "教育"],
        ["healthcare", "医疗"],
        ["finance", "金融"],
        ["construction", "建筑 / 施工"],
        ["consumer_service", "消费服务"]
      ])
    );
  }

  if (!slots.city) {
    appendClarificationQuestion(
      questions,
      createClarificationQuestion("city", "你现在主要在哪类城市？", [
        ["beijing_shanghai", "北京 / 上海"],
        ["first_tier", "一线城市"],
        ["new_first_tier", "新一线 / 省会"],
        ["second_tier", "二线城市"],
        ["county_home", "县城 / 老家"]
      ])
    );
  }

  if (!slots.age) {
    appendClarificationQuestion(
      questions,
      createClarificationQuestion("age", "你现在更接近哪个阶段？", [
        ["under_25", "25岁以下"],
        ["around_30", "30岁左右"],
        ["around_35", "35岁左右"],
        ["middle_age", "中年阶段"],
        ["graduated_three_years", "毕业三年内"]
      ])
    );
  }
}

function appendClarificationQuestion(
  target: DemoClarificationQuestion[],
  question: DemoClarificationQuestion | null
): void {
  if (!question || target.some((item) => item.id === question.id)) {
    return;
  }

  target.push(question);
}

function readObjectiveClarifyingCardTitle(normalizedQuery: string): string {
  if (/独立开发|个人开发者|indiehacker/.test(normalizedQuery)) {
    return "补充独立开发背景，匹配更准";
  }

  if (/开店|咖啡店/.test(normalizedQuery)) {
    return "补充开店背景，匹配更准";
  }

  if (/回老家/.test(normalizedQuery)) {
    return "补充回老家背景，匹配更准";
  }

  if (/自媒体/.test(normalizedQuery)) {
    return "补充自媒体背景，匹配更准";
  }

  if (/自由职业/.test(normalizedQuery)) {
    return "补充自由职业背景，匹配更准";
  }

  return "补充客观背景，匹配更准";
}

function readObjectiveClarifyingCardDescription(
  normalizedQuery: string,
  stage: ObjectiveClarificationStage
): string {
  if (stage === "evaluation") {
    return "先补齐当前现金、现金流和已有资源，优先匹配相似的人和处境。";
  }

  if (/开店|咖啡店/.test(normalizedQuery)) {
    return "先补齐岗位、开店准备和现实约束，优先匹配相似的人和处境。";
  }

  if (/回老家/.test(normalizedQuery)) {
    return "先补齐岗位、回老家安排和现实约束，优先匹配相似的人和处境。";
  }

  return "先补齐岗位、状态、方向和现实约束，优先匹配相似的人和处境。";
}

function createClarifyingCard(
  title: string,
  description: string,
  questions: DemoClarificationQuestion[]
): DemoClarifyingCard {
  const safeTitle = title.includes("匹配更准")
    ? "补充一点背景，帮你找到更像你的人"
    : title;
  const safeDescription = description.includes("匹配更准")
    ? "我们不会直接替你判断，只是用这些信息去匹配相似处境下的真实经历。"
    : description;

  return {
    show: true,
    title: safeTitle,
    description: safeDescription,
    questions: questions.slice(0, REQUIRED_CLARIFICATION_QUESTIONS),
    primaryActionText: "用这些信息重新匹配",
    skipActionText: "先跳过"
  };
}

function createClarificationQuestion(
  id: string,
  label: string,
  options: Array<[string, string]>,
  selectedReason = "补齐相似人匹配所需的身份、履历或资源槽位"
): DemoClarificationQuestion {
  return {
    id,
    slot: id,
    selectedReason,
    label,
    question: label,
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
  omitDerivedTopLevelFields(response);
  demoSearchResponseCache.set(cacheKey, {
    expiresAt: Date.now() + DEMO_SEARCH_CACHE_TTL_MS,
    response: cloneDemoSearchResponse(response)
  });
  return response;
}

function omitDerivedTopLevelFields(response: DemoSearchResponse): DemoSearchResponse {
  response.debug.personaCount =
    response.debug.personaCount ??
    response.people.filter((person) => person.aiPersona.personaId).length;
  delete response.personas;
  delete response.sections;
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
