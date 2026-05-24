import {
  DEMO_PERSONA_BOUNDARY_NOTICE,
  DEMO_SCHEMA_VERSION,
  type DemoDataMode,
  type DemoDebugPathSource,
  type DemoDebugClarificationContext,
  type DemoEvidence,
  type DemoPath,
  type DemoPerson,
  type DemoSearchResponse,
  type DemoSourceRef
} from "../types/demo.types.js";
import {
  buildQueryAwarePathPlans,
  describePathFallbackReason,
  inferQueryIntent,
  type DemoPathPlan
} from "../services/demoPathBuilder.service.js";
import { enforceDemoPathDiversity } from "../services/demoPathDiversity.service.js";
import { createDemoSearchIdentity } from "../services/demoQueryIdentity.service.js";

interface MockOptions {
  fallbackUsed?: boolean;
  fallbackReason?: string;
  guardWarnings?: string[];
  notes?: string[];
  requestedDataMode?: DemoDataMode;
  resolvedDataMode?: DemoDataMode;
  pathSource?: DemoDebugPathSource;
  cacheHit?: boolean;
  clarificationContext?: DemoDebugClarificationContext;
}

const MOCK_SOURCES: DemoSourceRef[] = [
  {
    id: "source_mock_city_walk",
    provider: "mock",
    type: "mock_answer",
    title: "公开问题样本 A",
    url: "https://www.zhihu.com/question/mock-city-walk/answer/mock-001",
    author: "公开回答样本 A",
    evidenceIds: ["ev_city_daily", "ev_city_outdoor"]
  },
  {
    id: "source_mock_side_income",
    provider: "mock",
    type: "mock_answer",
    title: "公开问题样本 B",
    url: "https://www.zhihu.com/question/mock-side-income/answer/mock-002",
    author: "公开回答样本 B",
    evidenceIds: ["ev_side_cashflow", "ev_side_content"]
  },
  {
    id: "source_mock_safety_net",
    provider: "mock",
    type: "mock_answer",
    title: "公开问题样本 C",
    url: "https://www.zhihu.com/question/mock-safety-net/answer/mock-003",
    author: "公开回答样本 C",
    evidenceIds: ["ev_safety_budget", "ev_safety_support"]
  }
];

const MOCK_EVIDENCE: DemoEvidence[] = [
  {
    id: "ev_city_daily",
    label: "日常节奏",
    text: "公开回答样本提到，先把关键变量拆清楚，再决定下一步怎么验证。",
    sourceRefId: "source_mock_city_walk",
    sourceUrl: "https://www.zhihu.com/question/mock-city-walk/answer/mock-001"
  },
  {
    id: "ev_city_outdoor",
    label: "城市停靠",
    text: "公开回答样本提到，可以用低成本方式观察真实约束，而不是一次做满。",
    sourceRefId: "source_mock_city_walk",
    sourceUrl: "https://www.zhihu.com/question/mock-city-walk/answer/mock-001"
  },
  {
    id: "ev_side_cashflow",
    label: "现金流",
    text: "公开回答样本强调先确认资源、安全垫和可承受损失，再扩大投入。",
    sourceRefId: "source_mock_side_income",
    sourceUrl: "https://www.zhihu.com/question/mock-side-income/answer/mock-002"
  },
  {
    id: "ev_side_content",
    label: "副业试错",
    text: "公开回答样本列举了小步验证方式，但提醒要先限定试错成本。",
    sourceRefId: "source_mock_side_income",
    sourceUrl: "https://www.zhihu.com/question/mock-side-income/answer/mock-002"
  },
  {
    id: "ev_safety_budget",
    label: "基本盘",
    text: "公开回答建议先盘点现金流、砍掉非必要消费，保住基本生活。",
    sourceRefId: "source_mock_safety_net",
    sourceUrl: "https://www.zhihu.com/question/mock-safety-net/answer/mock-003"
  },
  {
    id: "ev_safety_support",
    label: "保障路径",
    text: "公开回答样本提到要提前确认可回撤条件，把最坏情况先兜住。",
    sourceRefId: "source_mock_safety_net",
    sourceUrl: "https://www.zhihu.com/question/mock-safety-net/answer/mock-003"
  }
];

export function createMockDemoSearchResponse(
  query: string,
  count: number,
  dataMode: DemoDataMode,
  options: MockOptions = {}
): DemoSearchResponse {
  const limitedCount = Math.min(Math.max(count, 1), 20);
  const identity = createDemoSearchIdentity(query, { count, dataMode });
  const clarificationPriorityTerms = buildClarificationPriorityTerms(options.clarificationContext);
  const pathPlans = buildQueryAwarePathPlans(query, [], 3, {
    priorityKeywords: clarificationPriorityTerms
  });
  const mockDataset = buildQueryAwareMockDataset(identity.normalizedQuery, pathPlans);
  const people = buildQueryAwareMockPeople(
    identity.normalizedQuery,
    mockDataset
  ).slice(0, Math.min(limitedCount, 3));
  const pathIds = new Set(people.map((person) => person.pathId));
  const paths = buildQueryAwareMockPaths(identity.normalizedQuery, mockDataset, people).filter(
    (path) => pathIds.has(path.id)
  );
  const pathDiversityCheck = enforceDemoPathDiversity(paths, {
    notes: ["mock fallback generated query-aware path variants without LLM"]
  });
  const personas = people.map((person) => ({
    id: person.aiPersona.personaId,
    personId: person.id,
    displayName: person.aiPersona.displayName,
    avatar: person.avatar,
    personaType: "experience_echo" as const,
    intro: person.aiPersona.openingLine,
    fitReason: person.fitReason,
    boundaryNotice: DEMO_PERSONA_BOUNDARY_NOTICE,
    sourceRefs: person.sourceRefs,
    suggestedQuestions: person.aiPersona.suggestedQuestions
  }));
  const sourceRefsForReturnedPeople = people
    .map((person) => mockDataset.sources.find((sourceRef) => sourceRef.id === person.sourceRefs[0]))
    .filter((sourceRef): sourceRef is DemoSourceRef => Boolean(sourceRef));
  const fallbackReason =
    options.fallbackReason || describePathFallbackReason(query, 0);

  return {
    schemaVersion: DEMO_SCHEMA_VERSION,
    queryId: identity.queryId,
    query,
    dataMode,
    features: {
      aiPersona: true,
      personaChat: "mock",
      saveSample: false,
      articleBody: false,
      sourceEvidenceRequired: true
    },
    analysis: {
      summary: `已基于公开内容样本，将「${identity.normalizedQuery}」拆成 ${paths.length} 条可对照路径。`,
      intent: inferQueryIntent(query, [], {
        priorityKeywords: clarificationPriorityTerms
      }),
      focusTags: Array.from(new Set(pathPlans.flatMap((path) => path.variables))).slice(0, 8),
      steps: [
        {
          id: "step_understand_query",
          label: "理解问题里的生活处境",
          status: "done",
          evidenceIds: paths.slice(0, 2).flatMap((path) => path.evidenceIds),
          sourceRefs: paths.slice(0, 2).flatMap((path) => path.sourceRefs)
        },
        {
          id: "step_group_paths",
          label: "把公开内容归入路径样本",
          status: "done",
          evidenceIds: paths.flatMap((path) => path.evidenceIds),
          sourceRefs: paths.flatMap((path) => path.sourceRefs)
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
      sourceRefs: sourceRefsForReturnedPeople,
      evidenceCount: sourceRefsForReturnedPeople.reduce(
        (total, sourceRef) => total + sourceRef.evidenceIds.length,
        0
      ),
      generatedAt: new Date().toISOString(),
      latencyMs: 0,
      totalDurationMs: 0,
      fallbackUsed: options.fallbackUsed ?? false,
      fallbackStages: options.fallbackUsed ? ["mock_demo_search"] : [],
      llmStages: [],
      timedOutStages: []
    },
    debug: {
      composer: "mock",
      originalQuery: identity.originalQuery,
      normalizedQuery: identity.normalizedQuery,
      requestedDataMode: options.requestedDataMode ?? dataMode,
      resolvedDataMode: options.resolvedDataMode ?? dataMode,
      cacheHit: options.cacheHit ?? false,
      cacheKeyPreview: identity.cacheKeyPreview,
      itemCount: people.length,
      sourceItemCount: sourceRefsForReturnedPeople.length,
      pathCount: paths.length,
      peopleCount: people.length,
      personaCount: personas.length,
      llmUsed: false,
      llmComposerUsed: false,
      llmRepairUsed: false,
      llmRepairFailed: false,
      llmStageResults: [],
      enhancedPeopleCount: 0,
      enhancedPathCount: 0,
      partialFallbackUsed: false,
      pathSource: options.pathSource ?? "fallback",
      composerFallbackTriggered: options.fallbackUsed ?? dataMode !== "real",
      pathDuplicateFound: pathDiversityCheck.duplicateFound,
      pathDiversityCheck,
      intentStage: buildMockIntentStageDebug(dataMode, options),
      fallbackUsed: options.fallbackUsed ?? false,
      fallbackKind: "",
      fallbackReason,
      guardWarnings: options.guardWarnings ?? [],
      notes: options.notes ?? ["mock demo data; no LLM or Zhihu API required"]
    }
  };
}

function buildClarificationPriorityTerms(
  clarificationContext: DemoDebugClarificationContext | undefined
): string[] {
  if (!clarificationContext) {
    return [];
  }

  return Array.from(
    new Set([
      ...Object.values(clarificationContext.answerLabels),
      clarificationContext.answerSummary
    ].filter(Boolean))
  );
}

function buildMockIntentStageDebug(dataMode: DemoDataMode, options: MockOptions) {
  const fallbackReason =
    options.fallbackReason ||
    (dataMode === "cache_first"
      ? "cache_first uses query-aware deterministic analysis on cache miss; no LLM intent planner invoked"
      : "mock mode uses query-aware deterministic analysis; no LLM intent planner invoked");

  return {
    mode: options.fallbackUsed ? "fallback" : "rule",
    llmUsed: false,
    fallbackReason,
    intentSource: "rule",
    focusTagsSource: "rule"
  } as const;
}

interface QueryAwareMockPathSeed {
  plan: DemoPathPlan;
  source: DemoSourceRef;
  evidenceIds: string[];
}

interface QueryAwareMockDataset {
  seeds: QueryAwareMockPathSeed[];
  sources: DemoSourceRef[];
  evidenceById: Map<string, DemoEvidence>;
}

function buildQueryAwareMockDataset(
  normalizedQuery: string,
  pathPlans: DemoPathPlan[]
): QueryAwareMockDataset {
  const evidenceById = new Map<string, DemoEvidence>();
  const seeds = pathPlans.map((plan, index) => {
    const sourceId = `source_mock_${hashId(`${normalizedQuery}:${plan.id}`)}`;
    const sourceUrl = `https://www.zhihu.com/question/mock-${hashId(normalizedQuery)}/answer/${index + 1}`;
    const evidenceIds = [
      `ev_mock_${hashId(`${sourceId}:primary`)}`,
      `ev_mock_${hashId(`${sourceId}:secondary`)}`
    ];
    const source: DemoSourceRef = {
      id: sourceId,
      provider: "mock",
      type: "mock_answer",
      title: `关于「${truncateText(normalizedQuery, 18)}」的公开回答样本`,
      url: sourceUrl,
      author: `公开回答样本 ${String.fromCharCode(65 + index)}`,
      evidenceIds
    };
    const primaryVariable = plan.variables[0] ?? plan.title;
    const secondaryVariable = plan.variables[1] ?? "下一步选择";
    const tertiaryVariable = plan.variables[2] ?? "风险边界";
    const evidenceItems: DemoEvidence[] = [
      {
        id: evidenceIds[0],
        label: truncateText(primaryVariable, 16),
        text: `公开回答样本把「${normalizedQuery}」放到「${primaryVariable}」里讨论，提醒先看${truncateText(
          plan.summary.replace(/[。.]$/, ""),
          46
        )}。`,
        sourceRefId: sourceId,
        sourceUrl
      },
      {
        id: evidenceIds[1],
        label: truncateText(secondaryVariable, 16),
        text: `同一组样本还关注「${secondaryVariable}」，适合继续对照「${tertiaryVariable}」这一层代价。`,
        sourceRefId: sourceId,
        sourceUrl
      }
    ];

    for (const evidence of evidenceItems) {
      evidenceById.set(evidence.id, evidence);
    }

    return {
      plan,
      source,
      evidenceIds
    };
  });

  return {
    seeds,
    sources: seeds.map((seed) => seed.source),
    evidenceById
  };
}

function buildQueryAwareMockPaths(
  normalizedQuery: string,
  dataset: QueryAwareMockDataset,
  people: DemoPerson[]
): DemoPath[] {
  return dataset.seeds.map((seed) => ({
    id: seed.plan.id,
    title: seed.plan.title,
    summary: `${seed.plan.summary} 它解决的是「${seed.plan.variables[0] ?? seed.plan.title}」如何先落地，新的问题是「${seed.plan.variables[1] ?? "代价边界"}」会被放大。`,
    whyRelevant: `它回应的是「${truncateText(
      normalizedQuery,
      24
    )}」里关于「${seed.plan.variables[0] ?? seed.plan.title}」的困惑，判断仍以 mock 来源片段为准。`,
    tradeoff: `代价是「${seed.plan.variables[0] ?? seed.plan.title}」不能单独给出答案，仍要面对「${seed.plan.variables[1] ?? "现实成本"}」和证据不足。`,
    fitReason: `结合你的问题「${truncateText(
      normalizedQuery,
      24
    )}」，这条路径只说明公开样本可用来对照「${seed.plan.variables[0] ?? seed.plan.title}」，判断仍以来源片段为准。`,
    diversityKey: seed.plan.variables[0] ?? seed.plan.id,
    stance: seed.plan.stance,
    personRefs: people.filter((person) => person.pathId === seed.plan.id).map((person) => person.id),
    evidenceIds: seed.evidenceIds,
    sourceRefs: [seed.source.id]
  }));
}

function buildQueryAwareMockPeople(
  normalizedQuery: string,
  dataset: QueryAwareMockDataset
): DemoPerson[] {
  return dataset.seeds.map((seed, index) => {
    const personId = `person_mock_${hashId(`${normalizedQuery}:${seed.plan.id}`)}`;
    const personaId = `persona_mock_${hashId(personId)}`;
    const articleId = `article_mock_${hashId(`${personId}:article`)}`;
    const primaryVariable = seed.plan.variables[0] ?? seed.plan.title;
    const secondaryVariable = seed.plan.variables[1] ?? "下一步选择";
    const evidence = seed.evidenceIds.map((evidenceId) =>
      getQueryAwareEvidence(dataset.evidenceById, evidenceId)
    );

    return {
      id: personId,
      name: `${truncateText(primaryVariable, 8)}样本`,
      pathId: seed.plan.id,
      role: `基于公开回答整理的${truncateText(primaryVariable, 12)}样本`,
      roleLabel: `代表「${seed.plan.title}」的公开样本`,
      badge: truncateText(primaryVariable, 12),
      avatar: "",
      oneLine: truncateText(
        `这个样本提供的是「${seed.plan.title}」这一路径，重点不是结论，而是${primaryVariable}和${secondaryVariable}怎么被放到一起看。`,
        90
      ),
      experienceSummary: null,
      experienceSummarySource: "none",
      experienceSummaryStatus: "pending",
      matchedPathTitle: seed.plan.title,
      relevanceReason: `它适合回应「${truncateText(
        normalizedQuery,
        18
      )}」，因为这条 mock 来源把问题落在「${primaryVariable}」上，而不是泛泛谈选择。`,
      fitReason: `结合你的问题「${truncateText(
        normalizedQuery,
        24
      )}」，这个样本只说明公开回答可用来对照「${primaryVariable}」，判断仍以来源片段为准。`,
      who: "基于知乎公开回答整理出的前人样本，不等同于作者完整人生。",
      overlaps: seed.plan.variables
        .slice(0, 3)
        .map((variable) => `都涉及「${variable}」这个选择变量`),
      timeline: [
        {
          date: "公开内容片段",
          event: evidence[0]?.text ?? seed.plan.summary,
          evidenceIds: seed.evidenceIds,
          sourceRefs: [seed.source.id]
        }
      ],
      lesson: `先把「${primaryVariable}」看清，再判断这条公开样本能否迁移到你的问题。`,
      articles: [
        buildQueryAwareArticle(articleId, seed.source, evidence)
      ],
      match: buildQueryAwareMatch(
        clampScore(0.86 - index * 0.03),
        seed.evidenceIds,
        [seed.source.id],
        seed.plan,
        normalizedQuery
      ),
      aiPersona: buildQueryAwarePersonPersona(
        personId,
        personaId,
        articleId,
        `${truncateText(primaryVariable, 10)}样本的经验回声`,
        [seed.source.id],
        [
          `这段公开内容里，「${primaryVariable}」怎么判断？`,
          `从这个公开样本看，「${secondaryVariable}」要注意什么？`
        ]
      ),
      evidenceIds: seed.evidenceIds,
      sourceRefs: [seed.source.id]
    };
  });
}

function buildQueryAwareArticle(
  id: string,
  source: DemoSourceRef,
  evidence: DemoEvidence[]
) {
  const text = evidence.map((item) => item.text).join("\n");

  return {
    id,
    title: source.title,
    text,
    url: source.url,
    author: source.author,
    avatar: "",
    sourceName: "知乎回答样本",
    sourceUrl: source.url,
    summary: evidence[0]?.text ?? "",
    evidence,
    body: evidence.map((item) => ({
      type: "evidence" as const,
      text: item.text,
      evidenceIds: [item.id],
      sourceRefs: [item.sourceRefId]
    })),
    sourceRefs: [source.id]
  };
}

function buildQueryAwareMatch(
  score: number,
  evidenceIds: string[],
  sourceRefs: string[],
  plan: DemoPathPlan,
  normalizedQuery: string
) {
  return {
    score,
    level: score >= 0.8 ? ("high" as const) : ("medium" as const),
    reasons: [
      `当前问题「${truncateText(normalizedQuery, 18)}」和样本都涉及「${plan.variables[0] ?? plan.title}」`,
      `这条路径围绕「${plan.title}」提供可追溯的 mock 证据`
    ],
    matchedVariables: plan.variables,
    riskNotes: ["公开内容只能说明片段经验，不能代表作者完整人生或长期结果"],
    contentRelevance: score,
    experienceSimilarity: clampScore(score - 0.04),
    evidenceQuality: clampScore(score - 0.08),
    personaReadiness: clampScore(score - 0.1),
    evidenceIds,
    sourceRefs
  };
}

function buildQueryAwarePersonPersona(
  personId: string,
  personaId: string,
  articleId: string,
  displayName: string,
  sourceRefs: string[],
  suggestedQuestions: string[]
) {
  return {
    enabled: true,
    personaId,
    displayName,
    label: "基于公开内容生成",
    openingLine: "我只能沿着这段公开内容聊：这里真正要拆的是选择、代价和下一步判断。",
    suggestedQuestions,
    boundary: DEMO_PERSONA_BOUNDARY_NOTICE,
    grounding: {
      personId,
      articleIds: [articleId],
      evidenceRequired: true as const,
      sourceRefs
    }
  };
}

function getQueryAwareEvidence(
  evidenceById: Map<string, DemoEvidence>,
  id: string
): DemoEvidence {
  const evidence = evidenceById.get(id);
  if (!evidence) {
    throw new Error(`Missing query-aware mock evidence: ${id}`);
  }

  return evidence;
}

function buildMockPaths() {
  return [
    {
      id: "path_city_pause",
      title: "先停靠，把日常重新排稳",
      summary: "适合需要先拆清当前问题、再恢复判断秩序的人。",
      fitReason: "结合你的问题，这条路径只说明公开内容可用来对照生活节奏，判断仍以来源片段为准。",
      stance: "experience" as const,
      evidenceIds: ["ev_city_daily", "ev_city_outdoor"],
      sourceRefs: ["source_mock_city_walk"]
    },
    {
      id: "path_side_income",
      title: "轻量试错，先验证收入可能",
      summary: "适合需要确认资源、安全垫和低成本试错路径的人。",
      fitReason: "结合你的问题，这条路径只说明公开内容可用来对照现金流试错，判断仍以来源片段为准。",
      stance: "mixed" as const,
      evidenceIds: ["ev_side_cashflow", "ev_side_content"],
      sourceRefs: ["source_mock_side_income"]
    },
    {
      id: "path_safety_net",
      title: "先兜住底线，再谈下一步",
      summary: "适合焦虑最坏情况、需要把预算、保障和过渡工作先理清的人。",
      fitReason: "结合你的问题，这条路径只说明公开内容可用来对照风险底线，判断仍以来源片段为准。",
      stance: "viewpoint" as const,
      evidenceIds: ["ev_safety_budget", "ev_safety_support"],
      sourceRefs: ["source_mock_safety_net"]
    }
  ];
}

function buildMockPeople() {
  return [
    {
      id: "person_city_pause",
      name: "城市停靠样本",
      pathId: "path_city_pause",
      role: "基于公开回答整理的生活节奏样本",
      badge: "先把日常排稳",
      avatar: "",
      oneLine: "这个样本提醒你，做决定之前，可能先要知道关键变量是什么。",
      experienceSummary: null,
      experienceSummarySource: "none",
      experienceSummaryStatus: "pending",
      fitReason: "结合你的问题，这个样本只说明公开回答可用来对照日常节奏，判断仍以来源片段为准。",
      who: "基于知乎公开回答整理出的前人样本，不等同于作者完整人生。",
      overlaps: ["都在重新整理选择变量", "都关心低成本验证和状态稳定"],
      timeline: [
        {
          date: "公开内容片段",
          event: "把做饭、休息、散步和户外活动放回每日节奏。",
          evidenceIds: ["ev_city_daily", "ev_city_outdoor"],
          sourceRefs: ["source_mock_city_walk"]
        }
      ],
      lesson: "外部选择能提供距离，但真正先稳住的是判断节奏。",
      articles: [
        buildArticle("article_city_pause", MOCK_SOURCES[0], ["ev_city_daily", "ev_city_outdoor"])
      ],
      match: buildMatch(0.88, ["ev_city_daily", "ev_city_outdoor"], ["source_mock_city_walk"]),
      aiPersona: buildPersonPersona(
        "person_city_pause",
        "persona_city_pause",
        "城市停靠样本的经验回声",
        ["source_mock_city_walk"],
        ["这段公开内容里，日常节奏是怎么重新建立的？", "从这个公开样本看，低成本生活最先要注意什么？"]
      ),
      evidenceIds: ["ev_city_daily", "ev_city_outdoor"],
      sourceRefs: ["source_mock_city_walk"]
    },
    {
      id: "person_side_income",
      name: "轻量试错样本",
      pathId: "path_side_income",
      role: "基于公开回答整理的副业试错样本",
      badge: "先验证现金流",
      avatar: "",
      oneLine: "这个样本更像一张检查表：安全垫、技能、试错成本，一个个算清楚。",
      experienceSummary: null,
      experienceSummarySource: "none",
      experienceSummaryStatus: "pending",
      fitReason: "结合你的问题，这个样本只说明公开回答可用来对照现金流试错，判断仍以来源片段为准。",
      who: "基于知乎公开回答整理出的观点与经验混合样本，不等同于作者完整人生。",
      overlaps: ["都需要判断资源余量", "都需要控制试错成本和现金流"],
      timeline: [
        {
          date: "公开内容片段",
          event: "先算安全垫，再从轻创业、接单、内容创作等低成本方向试起。",
          evidenceIds: ["ev_side_cashflow", "ev_side_content"],
          sourceRefs: ["source_mock_side_income"]
        }
      ],
      lesson: "更大的选择空间通常来自可验证的资源余量和回撤条件。",
      articles: [
        buildArticle("article_side_income", MOCK_SOURCES[1], ["ev_side_cashflow", "ev_side_content"])
      ],
      match: buildMatch(0.84, ["ev_side_cashflow", "ev_side_content"], ["source_mock_side_income"]),
      aiPersona: buildPersonPersona(
        "person_side_income",
        "persona_side_income",
        "轻量试错样本的经验回声",
        ["source_mock_side_income"],
        ["从这个公开样本看，怎么判断副业能不能全职？", "这段公开内容里，安全垫至少要准备多久？"]
      ),
      evidenceIds: ["ev_side_cashflow", "ev_side_content"],
      sourceRefs: ["source_mock_side_income"]
    },
    {
      id: "person_safety_net",
      name: "底线兜住样本",
      pathId: "path_safety_net",
      role: "基于公开回答整理的风险兜底样本",
      badge: "先处理最坏情况",
      avatar: "",
      oneLine: "这个样本不急着给结论，而是先问：如果判断失误，底线怎么守住？",
      experienceSummary: null,
      experienceSummarySource: "none",
      experienceSummaryStatus: "pending",
      fitReason: "结合你的问题，这个样本只说明公开回答可用来对照预算和保障，判断仍以来源片段为准。",
      who: "基于知乎公开回答整理出的观点样本，不等同于作者完整人生。",
      overlaps: ["都担心选择后的基本盘", "都需要把预算和保障先确认"],
      timeline: [
        {
          date: "公开内容片段",
          event: "先盘点现金流，确认已有资源、外部支持和回撤条件。",
          evidenceIds: ["ev_safety_budget", "ev_safety_support"],
          sourceRefs: ["source_mock_safety_net"]
        }
      ],
      lesson: "把底线算清楚，会让后面的选择不只是靠情绪硬撑。",
      articles: [
        buildArticle("article_safety_net", MOCK_SOURCES[2], [
          "ev_safety_budget",
          "ev_safety_support"
        ])
      ],
      match: buildMatch(0.8, ["ev_safety_budget", "ev_safety_support"], ["source_mock_safety_net"]),
      aiPersona: buildPersonPersona(
        "person_safety_net",
        "persona_safety_net",
        "底线兜住样本的经验回声",
        ["source_mock_safety_net"],
        ["从这个公开样本看，最坏情况应该先算哪几项？", "这段公开内容里，怎么降低选择风险？"]
      ),
      evidenceIds: ["ev_safety_budget", "ev_safety_support"],
      sourceRefs: ["source_mock_safety_net"]
    }
  ];
}

function buildArticle(id: string, source: DemoSourceRef, evidenceIds: string[]) {
  const evidence = evidenceIds.map((evidenceId) => getEvidence(evidenceId));
  const text = evidence.map((item) => item.text).join("\n");

  return {
    id,
    title: source.title,
    text,
    url: source.url,
    author: source.author,
    avatar: "",
    sourceName: source.type === "mock_answer" ? "知乎回答样本" : "知乎回答",
    sourceUrl: source.url,
    summary: evidence[0]?.text ?? "",
    evidence,
    body: evidence.map((item) => ({
      type: "evidence" as const,
      text: item.text,
      evidenceIds: [item.id],
      sourceRefs: [item.sourceRefId]
    })),
    sourceRefs: [source.id]
  };
}

function buildMatch(score: number, evidenceIds: string[], sourceRefs: string[]) {
  return {
    score,
    level: score >= 0.8 ? ("high" as const) : ("medium" as const),
    reasons: ["问题都指向离开工作结构后的生活安排", "公开内容提供了可追溯的具体做法"],
    matchedVariables: ["工作暂停", "生活节奏", "现金流", "风险兜底"],
    riskNotes: ["公开内容只能说明片段经验，不能代表作者完整人生或长期结果"],
    contentRelevance: score,
    experienceSimilarity: score - 0.04,
    evidenceQuality: score - 0.08,
    personaReadiness: score - 0.1,
    evidenceIds,
    sourceRefs
  };
}

function buildPersonPersona(
  personId: string,
  personaId: string,
  displayName: string,
  sourceRefs: string[],
  suggestedQuestions: string[]
) {
  return {
    enabled: true,
    personaId,
    displayName,
    label: "基于公开内容生成",
    openingLine: "你可以继续问这段公开内容里的选择、代价和下一步判断。",
    suggestedQuestions,
    boundary: DEMO_PERSONA_BOUNDARY_NOTICE,
    grounding: {
      personId,
      articleIds: [`article_${personId.replace("person_", "")}`],
      evidenceRequired: true as const,
      sourceRefs
    }
  };
}

function getEvidence(id: string): DemoEvidence {
  const evidence = MOCK_EVIDENCE.find((item) => item.id === id);
  if (!evidence) {
    throw new Error(`Missing mock evidence: ${id}`);
  }

  return evidence;
}

function hashId(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }

  return (hash >>> 0).toString(16);
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
