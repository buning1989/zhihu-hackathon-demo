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
import {
  type DemoClarificationAnswers,
  type DemoClarificationQuestion,
  type DemoClarifyingCard,
  type DemoDataMode,
  type DemoDebugClarificationContext,
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
const DEMO_SEARCH_BUDGET_MS = 14000;
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
  const role = answerLabels.role;
  const status = answerLabels.status;
  const direction = answerLabels.direction;
  const constraint = answerLabels.constraint;
  const searchHints = unique(
    [
      [query, role, status, direction].filter(Boolean).join(" "),
      [role, status, direction].filter(Boolean).join(" "),
      [query, status, direction, constraint].filter(Boolean).join(" "),
      [status, direction, "复盘"].filter(Boolean).join(" "),
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

  if (isObjectiveSlotClarificationQuery(normalized)) {
    return {
      ambiguityLevel: "high",
      card: createObjectiveSlotClarifyingCard(query)
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
  return /裸辞|离职|辞职|被裁|裁员|失业|待业|不工作|不上班|转行|自由职业|创业|回老家|开店|读研|考研|升学|一线城市|二线城市|保险经纪人|职业咨询|新能源|小红书|博主|接私单|私单|独立开发|个人开发者|indiehacker|体制内|大厂|施工单位|自媒体|工作十年|gap/.test(
    normalizedQuery
  );
}

function createObjectiveSlotClarifyingCard(query: string): DemoClarifyingCard {
  const normalizedQuery = query.replace(/\s+/g, "").toLowerCase();
  const { objectiveSlots, missingSlots } = buildObjectiveSearchContext(query);
  const stage = inferObjectiveClarificationStage(normalizedQuery);
  const questions: DemoClarificationQuestion[] = [];

  for (const slotName of OBJECTIVE_CLARIFICATION_SLOT_ORDER) {
    if (!shouldAskObjectiveSlotQuestion(slotName, missingSlots, stage)) {
      continue;
    }

    appendClarificationQuestion(
      questions,
      createObjectiveSlotQuestion(slotName, normalizedQuery)
    );
  }

  if (stage === "evaluation") {
    appendEvaluationObjectiveQuestions(questions, normalizedQuery);
  } else {
    appendContextualObjectiveQuestions(questions, normalizedQuery);
  }

  appendObjectiveSlotFillerQuestions(questions, objectiveSlots);

  return createClarifyingCard(
    readObjectiveClarifyingCardTitle(normalizedQuery),
    readObjectiveClarifyingCardDescription(normalizedQuery, stage),
    questions
  );
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
