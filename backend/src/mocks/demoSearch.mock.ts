import {
  DEMO_PERSONA_BOUNDARY_NOTICE,
  DEMO_SCHEMA_VERSION,
  type DemoDataMode,
  type DemoEvidence,
  type DemoSearchResponse,
  type DemoSourceRef
} from "../types/demo.types.js";

interface MockOptions {
  fallbackUsed?: boolean;
  fallbackReason?: string;
  guardWarnings?: string[];
  notes?: string[];
  requestedDataMode?: DemoDataMode;
  resolvedDataMode?: DemoDataMode;
}

const MOCK_SOURCES: DemoSourceRef[] = [
  {
    id: "source_mock_city_walk",
    provider: "mock",
    type: "mock_answer",
    title: "失业不上班，你们都在干什么？",
    url: "https://www.zhihu.com/question/mock-city-walk/answer/mock-001",
    author: "公开回答样本 A",
    evidenceIds: ["ev_city_daily", "ev_city_outdoor"]
  },
  {
    id: "source_mock_side_income",
    provider: "mock",
    type: "mock_answer",
    title: "不想工作，还有什么出路吗？",
    url: "https://www.zhihu.com/question/mock-side-income/answer/mock-002",
    author: "公开回答样本 B",
    evidenceIds: ["ev_side_cashflow", "ev_side_content"]
  },
  {
    id: "source_mock_safety_net",
    provider: "mock",
    type: "mock_answer",
    title: "如果失业到处找不到工作怎么办？",
    url: "https://www.zhihu.com/question/mock-safety-net/answer/mock-003",
    author: "公开回答样本 C",
    evidenceIds: ["ev_safety_budget", "ev_safety_support"]
  }
];

const MOCK_EVIDENCE: DemoEvidence[] = [
  {
    id: "ev_city_daily",
    label: "日常节奏",
    text: "公开回答提到，暂停上班后先把做饭、休息、散步和低成本生活重新排进每天。",
    sourceRefId: "source_mock_city_walk",
    sourceUrl: "https://www.zhihu.com/question/mock-city-walk/answer/mock-001"
  },
  {
    id: "ev_city_outdoor",
    label: "城市停靠",
    text: "公开回答提到，天气好时会去周边公园、绿道和海边，把城市资源当作恢复节奏的一部分。",
    sourceRefId: "source_mock_city_walk",
    sourceUrl: "https://www.zhihu.com/question/mock-city-walk/answer/mock-001"
  },
  {
    id: "ev_side_cashflow",
    label: "现金流",
    text: "公开回答强调先计算存款能覆盖几个月生活费，再决定要不要轻创业或自由职业。",
    sourceRefId: "source_mock_side_income",
    sourceUrl: "https://www.zhihu.com/question/mock-side-income/answer/mock-002"
  },
  {
    id: "ev_side_content",
    label: "副业试错",
    text: "公开回答列举内容创作、接单、小生意等低启动成本方向，但提醒先从副业试起。",
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
    text: "公开回答提到可咨询失业保险、公益性岗位和本地保障政策，把最坏情况先兜住。",
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
  const people = buildMockPeople().slice(0, Math.min(limitedCount, 3));
  const pathIds = new Set(people.map((person) => person.pathId));
  const paths = buildMockPaths().filter((path) => pathIds.has(path.id));
  const personas = people.map((person) => ({
    id: person.aiPersona.personaId,
    personId: person.id,
    displayName: person.aiPersona.displayName,
    avatar: person.avatar,
    personaType: "experience_echo" as const,
    intro: person.aiPersona.openingLine,
    boundaryNotice: DEMO_PERSONA_BOUNDARY_NOTICE,
    sourceRefs: person.sourceRefs,
    suggestedQuestions: person.aiPersona.suggestedQuestions
  }));

  return {
    schemaVersion: DEMO_SCHEMA_VERSION,
    queryId: `query_${hashId(query)}`,
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
      summary: `已基于公开内容样本，将「${query}」拆成可停靠、可试错、可兜底的三类路径。`,
      intent: "life_path_exploration",
      focusTags: ["离开工作轨道", "生活节奏", "现金流", "风险兜底"],
      steps: [
        {
          id: "step_understand_query",
          label: "理解问题里的生活处境",
          status: "done",
          evidenceIds: ["ev_city_daily", "ev_side_cashflow"],
          sourceRefs: ["source_mock_city_walk", "source_mock_side_income"]
        },
        {
          id: "step_group_paths",
          label: "把公开内容归入路径样本",
          status: "done",
          evidenceIds: ["ev_city_outdoor", "ev_side_content", "ev_safety_budget"],
          sourceRefs: [
            "source_mock_city_walk",
            "source_mock_side_income",
            "source_mock_safety_net"
          ]
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
      sourceRefs: MOCK_SOURCES,
      evidenceCount: MOCK_EVIDENCE.length,
      generatedAt: new Date().toISOString(),
      latencyMs: 0,
      fallbackUsed: options.fallbackUsed ?? false
    },
    debug: {
      composer: "mock",
      requestedDataMode: options.requestedDataMode ?? dataMode,
      resolvedDataMode: options.resolvedDataMode ?? dataMode,
      itemCount: people.length,
      llmUsed: false,
      llmComposerUsed: false,
      llmRepairUsed: false,
      llmRepairFailed: false,
      fallbackUsed: options.fallbackUsed ?? false,
      fallbackReason: options.fallbackReason ?? "",
      guardWarnings: options.guardWarnings ?? [],
      notes: options.notes ?? ["mock demo data; no LLM or Zhihu API required"]
    }
  };
}

function buildMockPaths() {
  return [
    {
      id: "path_city_pause",
      title: "先停靠，把日常重新排稳",
      summary: "适合暂时不想立刻回到职场、需要先恢复生活秩序的人。",
      stance: "experience" as const,
      evidenceIds: ["ev_city_daily", "ev_city_outdoor"],
      sourceRefs: ["source_mock_city_walk"]
    },
    {
      id: "path_side_income",
      title: "轻量试错，先验证收入可能",
      summary: "适合想离开固定工作，但还需要确认现金流和技能变现路径的人。",
      stance: "mixed" as const,
      evidenceIds: ["ev_side_cashflow", "ev_side_content"],
      sourceRefs: ["source_mock_side_income"]
    },
    {
      id: "path_safety_net",
      title: "先兜住底线，再谈下一步",
      summary: "适合焦虑最坏情况、需要把预算、保障和过渡工作先理清的人。",
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
      oneLine: "这个样本提醒你，去哪里之前，可能先要知道一天怎么过。",
      who: "基于知乎公开回答整理出的前人样本，不等同于作者完整人生。",
      overlaps: ["都在离开工作结构后寻找新的日常秩序", "都关心低成本生活和身体状态"],
      timeline: [
        {
          date: "公开内容片段",
          event: "把做饭、休息、散步和户外活动放回每日节奏。",
          evidenceIds: ["ev_city_daily", "ev_city_outdoor"],
          sourceRefs: ["source_mock_city_walk"]
        }
      ],
      lesson: "地点能提供距离，但真正先稳住的是每天的生活节奏。",
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
      who: "基于知乎公开回答整理出的观点与经验混合样本，不等同于作者完整人生。",
      overlaps: ["都在考虑不上班后的收入来源", "都需要判断试错成本和现金流"],
      timeline: [
        {
          date: "公开内容片段",
          event: "先算安全垫，再从轻创业、接单、内容创作等低成本方向试起。",
          evidenceIds: ["ev_side_cashflow", "ev_side_content"],
          sourceRefs: ["source_mock_side_income"]
        }
      ],
      lesson: "自由不是先辞职才出现，而是先有可验证的现金流选择。",
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
      oneLine: "这个样本不急着讲远方，而是先问：如果暂时没收入，基本盘怎么守住？",
      who: "基于知乎公开回答整理出的观点样本，不等同于作者完整人生。",
      overlaps: ["都担心不工作后的基本生活", "都需要把预算和保障政策先确认"],
      timeline: [
        {
          date: "公开内容片段",
          event: "先盘点现金流，咨询失业保险、本地保障和公益性岗位。",
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
        ["从这个公开样本看，最坏情况应该先算哪几项？", "这段公开内容里，找不到工作时怎么降低风险？"]
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
