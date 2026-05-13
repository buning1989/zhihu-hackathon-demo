import type { DemoPath } from "../types/demo.types.js";
import { normalizeDemoQuery } from "./demoQueryIdentity.service.js";

export interface DemoPathCandidate {
  id: string;
  title: string;
  text: string;
}

export interface DemoPathPlan {
  id: string;
  title: string;
  summary: string;
  keywords: string[];
  variables: string[];
  stance: DemoPath["stance"];
}

interface ScenarioPathTemplate {
  id: string;
  title: string;
  summary: string;
  keywords: string[];
  variables: string[];
  stance: DemoPath["stance"];
}

interface QueryScenario {
  id: string;
  intent: string;
  queryKeywords: string[];
  candidateKeywords: string[];
  paths: ScenarioPathTemplate[];
}

const DEFAULT_PATH_COUNT = 3;

const QUERY_SCENARIOS: QueryScenario[] = [
  {
    id: "relationship_work_tradeoff",
    intent: "relationship_work_tradeoff",
    queryKeywords: ["异地恋", "恋爱", "感情", "伴侣", "对象", "远距离", "为了工作"],
    candidateKeywords: ["异地", "感情", "恋爱", "伴侣", "对象", "见面", "沟通", "距离", "城市"],
    paths: [
      {
        id: "work_value",
        title: "有人为了工作接受异地，后来靠固定见面维持关系",
        summary: "这类样本通常把岗位成长、城市距离、见面频率和双方底线一起经历过一轮权衡。",
        keywords: ["工作", "机会", "职业", "岗位", "异地", "距离", "城市", "值得", "成本"],
        variables: ["工作机会", "关系成本", "城市距离"],
        stance: "mixed"
      },
      {
        id: "distance_rules",
        title: "有人在异地前把期限和见面规则谈清楚",
        summary: "这类样本的关键不只是异地本身，而是异地持续多久、多久见一次、谁承担成本。",
        keywords: ["异地", "见面", "沟通", "期限", "未来", "结婚", "安全感", "伴侣"],
        variables: ["异地期限", "见面成本", "沟通规则"],
        stance: "viewpoint"
      },
      {
        id: "reversible_trial",
        title: "有人先试了一段异地周期，再决定是否长期继续",
        summary: "这类样本把试用期、短期外派或远程磨合当成验证，没有一开始就押上长期关系。",
        keywords: ["试", "试用", "短期", "回撤", "选择", "取舍", "计划", "磨合"],
        variables: ["试运行", "回撤条件", "长期选择"],
        stance: "experience"
      }
    ]
  },
  {
    id: "career_transition_age",
    intent: "career_transition_age",
    queryKeywords: ["转行", "转岗", "换行业", "换职业", "35岁", "三十五", "中年", "来得及"],
    candidateKeywords: ["转行", "转岗", "行业", "职业", "年龄", "经验", "技能", "岗位", "薪资"],
    paths: [
      {
        id: "target_gap",
        title: "有人35岁后补齐目标岗位缺口，再转入新方向",
        summary: "这类样本先把想去的岗位、能力差距、学习周期和市场门槛查清楚，再进入切换。",
        keywords: ["目标", "岗位", "行业", "门槛", "技能", "要求", "招聘", "缺口"],
        variables: ["目标岗位", "能力差距", "市场门槛"],
        stance: "viewpoint"
      },
      {
        id: "transfer_experience",
        title: "有人把旧经验迁移成新岗位筹码",
        summary: "这类样本没有完全从零开始，而是把原行业经验里能迁移的部分转成新方向证明。",
        keywords: ["经验", "迁移", "优势", "项目", "管理", "资源", "履历", "作品"],
        variables: ["可迁移经验", "作品证明", "履历表达"],
        stance: "mixed"
      },
      {
        id: "small_trial",
        title: "有人先用项目试水，再决定是否正式转行",
        summary: "这类样本用课程、作品、兼职、内转或试岗验证方向，再决定是否大幅切换。",
        keywords: ["试错", "课程", "作品", "兼职", "内转", "试岗", "风险", "收入"],
        variables: ["试错成本", "收入波动", "回撤方案"],
        stance: "experience"
      }
    ]
  },
  {
    id: "work_pause_path",
    intent: "work_pause_path_exploration",
    queryKeywords: ["不工作", "不上班", "裸辞", "失业", "待业", "离职", "去哪", "哪里", "gap"],
    candidateKeywords: ["不工作", "不上班", "裸辞", "失业", "待业", "离职", "生活", "城市", "存款"],
    paths: [
      {
        id: "place_rhythm",
        title: "有人离开工作后先去低成本地方休整",
        summary: "这类样本先处理想去哪里、每天怎么过、低成本资源和身体状态，而不是立刻定终局。",
        keywords: ["去哪", "哪里", "城市", "回老家", "生活", "每天", "休息", "节奏"],
        variables: ["停靠地点", "日常节奏", "生活半径"],
        stance: "experience"
      },
      {
        id: "money_safety",
        title: "有人靠存款和副业撑过一段空窗期",
        summary: "这类样本的核心是存款能撑多久、必要开销多少、社保医保和家庭支持是否兜得住。",
        keywords: ["钱", "收入", "存款", "预算", "社保", "医保", "保障", "安全垫"],
        variables: ["现金流", "安全垫", "保障底线"],
        stance: "viewpoint"
      },
      {
        id: "return_or_trial",
        title: "有人保留面试和短期项目作为回流接口",
        summary: "这类样本把重新就业、短期项目、学习调整和低成本试错留在后面，避免选择变成单向门。",
        keywords: ["找工作", "就业", "项目", "学习", "试错", "回流", "面试", "岗位"],
        variables: ["工作回流", "低成本试错", "下一步接口"],
        stance: "mixed"
      }
    ]
  },
  {
    id: "city_home_choice",
    intent: "city_home_choice",
    queryKeywords: ["北京", "大城市", "回老家", "老家", "留在", "回去", "城市", "家乡"],
    candidateKeywords: ["北京", "上海", "深圳", "大城市", "老家", "家乡", "房租", "机会", "生活成本"],
    paths: [
      {
        id: "stay_for_density",
        title: "有人留在大城市，先保住机会密度",
        summary: "这类样本把城市里的岗位、信息、同伴和资源密度当成缓冲，而不是只看房租压力。",
        keywords: ["北京", "大城市", "机会", "岗位", "资源", "信息", "同伴", "平台"],
        variables: ["机会密度", "城市成本", "职业接口"],
        stance: "mixed"
      },
      {
        id: "return_for_cost",
        title: "有人回老家，用低成本换喘息空间",
        summary: "这类样本先把租金、通勤和情绪消耗降下来，但要重新面对机会减少和关系压力。",
        keywords: ["回老家", "低成本", "房租", "生活", "家人", "关系", "喘息"],
        variables: ["生活成本", "家庭关系", "机会减少"],
        stance: "experience"
      },
      {
        id: "trial_between_cities",
        title: "有人先试住一段，再决定城市去留",
        summary: "这类样本没有马上把城市选择定死，而是用短住、远程和面试结果验证回撤空间。",
        keywords: ["试住", "短期", "远程", "面试", "回撤", "迁移", "城市"],
        variables: ["短期试住", "回撤条件", "迁移成本"],
        stance: "experience"
      }
    ]
  },
  {
    id: "graduate_school_exit",
    intent: "graduate_school_exit",
    queryKeywords: ["读研", "研究生", "考研", "退学", "不想读研", "导师", "论文", "学校"],
    candidateKeywords: ["读研", "研究生", "导师", "论文", "课题", "退学", "就业", "转专业"],
    paths: [
      {
        id: "pause_and_diagnose",
        title: "有人先暂停，把不想读研拆清楚",
        summary: "这类样本先分清是导师课题、学术生活、就业焦虑还是身体状态在消耗自己。",
        keywords: ["不想读研", "导师", "课题", "论文", "焦虑", "状态", "原因"],
        variables: ["真实卡点", "导师课题", "身心状态"],
        stance: "viewpoint"
      },
      {
        id: "switch_track",
        title: "有人换课题或实习，把研究生变成过渡",
        summary: "这类样本没有立刻退出，而是用换方向、实习和作品把学籍变成下一步接口。",
        keywords: ["换课题", "实习", "转方向", "作品", "就业", "过渡", "学籍"],
        variables: ["方向调整", "就业接口", "时间成本"],
        stance: "mixed"
      },
      {
        id: "exit_school",
        title: "有人认真退场，重新进入工作或备考",
        summary: "这类样本把退学、延期、工作和重新申请都算作可选项，但要承受履历解释成本。",
        keywords: ["退学", "延期", "工作", "重新申请", "备考", "履历", "成本"],
        variables: ["退场成本", "履历解释", "重新开始"],
        stance: "experience"
      }
    ]
  },
  {
    id: "family_choice_conflict",
    intent: "family_choice_conflict",
    queryKeywords: ["父母不同意", "父母反对", "家里不同意", "家人反对", "我的选择", "不支持"],
    candidateKeywords: ["父母", "家人", "反对", "沟通", "经济独立", "边界", "选择", "支持"],
    paths: [
      {
        id: "earn_trust",
        title: "有人先把选择做小，用结果换信任",
        summary: "这类样本不是一次说服父母，而是先拿出可见计划、阶段结果和风险兜底。",
        keywords: ["计划", "结果", "信任", "风险", "沟通", "父母", "选择"],
        variables: ["阶段结果", "信任成本", "风险兜底"],
        stance: "mixed"
      },
      {
        id: "financial_boundary",
        title: "有人先经济独立，再谈边界",
        summary: "这类样本把是否能承担后果放在沟通前面，因为边界往往需要资源托底。",
        keywords: ["经济独立", "边界", "承担后果", "资源", "家人", "选择"],
        variables: ["经济独立", "家庭边界", "后果承担"],
        stance: "experience"
      },
      {
        id: "keep_relationship",
        title: "有人不硬碰硬，先保留关系出口",
        summary: "这类样本把沟通节奏放慢，不急着赢一场辩论，避免选择和亲密关系一起撕裂。",
        keywords: ["沟通", "关系", "节奏", "冲突", "妥协", "父母", "出口"],
        variables: ["沟通节奏", "关系出口", "情绪成本"],
        stance: "viewpoint"
      }
    ]
  },
  {
    id: "friendship_boundary",
    intent: "friendship_boundary",
    queryKeywords: ["朋友", "断联", "断绝", "消耗", "关系", "长期消耗", "边界"],
    candidateKeywords: ["朋友", "断联", "关系", "消耗", "边界", "疏远", "沟通", "情绪"],
    paths: [
      {
        id: "soft_distance",
        title: "有人先拉开距离，观察关系会不会恢复",
        summary: "这类样本不是立刻断掉，而是降低互动频率，看关系离开惯性后还剩什么。",
        keywords: ["拉开距离", "频率", "观察", "关系", "恢复", "消耗"],
        variables: ["互动频率", "关系惯性", "恢复空间"],
        stance: "experience"
      },
      {
        id: "clear_boundary",
        title: "有人把边界说清，再看对方是否尊重",
        summary: "这类样本把长期委屈变成一次明确表达，代价是冲突可能被提前引爆。",
        keywords: ["边界", "表达", "尊重", "冲突", "沟通", "朋友"],
        variables: ["边界表达", "冲突成本", "尊重程度"],
        stance: "mixed"
      },
      {
        id: "clean_break",
        title: "有人选择断联，把精力从消耗里撤出来",
        summary: "这类样本承认关系已经无法修复，用断联换回情绪空间，但也要承受失去和愧疚。",
        keywords: ["断联", "撤出", "情绪空间", "失去", "愧疚", "消耗"],
        variables: ["情绪空间", "失去成本", "关系修复"],
        stance: "experience"
      }
    ]
  },
  {
    id: "career_decision",
    intent: "career_decision",
    queryKeywords: ["工作", "跳槽", "offer", "职业", "岗位", "升职", "加班", "要不要"],
    candidateKeywords: ["工作", "跳槽", "offer", "职业", "岗位", "升职", "加班", "公司"],
    paths: [
      {
        id: "real_gain",
        title: "有人接下新工作后发现成长收益更明显",
        summary: "这类样本经历过成长、收入、平台、城市和长期简历收益之间的拆分比较。",
        keywords: ["成长", "收入", "平台", "简历", "机会", "长期", "收益"],
        variables: ["工作收益", "成长空间", "长期价值"],
        stance: "viewpoint"
      },
      {
        id: "life_cost",
        title: "有人为了生活关系放弃了更高强度机会",
        summary: "这类样本把通勤、城市、家庭、关系和休息成本算进去，没有只比较岗位本身。",
        keywords: ["生活", "关系", "家庭", "城市", "通勤", "休息", "代价"],
        variables: ["生活成本", "关系代价", "时间消耗"],
        stance: "mixed"
      },
      {
        id: "reversible_plan",
        title: "有人设了试用期限，再按结果回撤或继续",
        summary: "这类样本提前设过试用期限、退出条件和备选路径，让选择不变成单向门。",
        keywords: ["试用", "期限", "退出", "备选", "回撤", "计划", "风险"],
        variables: ["试用期限", "退出条件", "备选路径"],
        stance: "experience"
      }
    ]
  }
];

export function buildQueryAwarePathPlans(
  query: string,
  candidates: DemoPathCandidate[] = [],
  maxCount = DEFAULT_PATH_COUNT
): DemoPathPlan[] {
  const normalizedQuery = normalizeDemoQuery(query);
  const scenario = selectScenario(normalizedQuery, candidates);
  const templates = scenario?.paths ?? buildGenericPathTemplates(normalizedQuery, candidates);
  const queryKeywords = extractQueryKeywords(normalizedQuery);
  const scenarioKeywords = scenario ? [...scenario.queryKeywords, ...scenario.candidateKeywords] : [];
  const hash = hashId(normalizedQuery || "query");

  return templates.slice(0, Math.max(1, maxCount)).map((template) => ({
    id: `path_${scenario?.id ?? "generic"}_${template.id}_${hash.slice(0, 6)}`,
    title: template.title,
    summary: template.summary,
    keywords: unique([...template.keywords, ...template.variables, ...queryKeywords, ...scenarioKeywords]),
    variables: template.variables,
    stance: template.stance
  }));
}

export function inferQueryIntent(query: string, candidates: DemoPathCandidate[] = []): string {
  return selectScenario(normalizeDemoQuery(query), candidates)?.intent ?? "query_specific_decision";
}

export function describePathFallbackReason(query: string, candidateCount: number): string {
  const normalizedQuery = normalizeDemoQuery(query);
  return `query-aware fallback paths built from normalizedQuery="${truncateText(
    normalizedQuery,
    36
  )}" and ${candidateCount} candidate snippets`;
}

function selectScenario(query: string, candidates: DemoPathCandidate[]): QueryScenario | undefined {
  const candidateText = candidates.map((candidate) => `${candidate.title}\n${candidate.text}`).join("\n");
  const scored = QUERY_SCENARIOS.map((scenario) => ({
    scenario,
    score:
      countKeywordHits(query, scenario.queryKeywords) * 4 +
      countKeywordHits(candidateText, scenario.candidateKeywords)
  })).sort((left, right) => right.score - left.score);

  return scored[0]?.score > 0 ? scored[0].scenario : undefined;
}

function buildGenericPathTemplates(
  query: string,
  candidates: DemoPathCandidate[]
): ScenarioPathTemplate[] {
  const focus = extractFocusPhrase(query, candidates);
  const quotedFocus = `「${focus}」`;
  const candidateKeywords = extractCandidateKeywords(candidates);
  const evidenceFocus = candidateKeywords[0] ?? "公开样本";
  const riskFocus = candidateKeywords[1] ?? "代价和风险";

  return [
    {
      id: "variables",
      title: `有人把${quotedFocus}拆成现实约束后才行动`,
      summary: `这类样本围绕${quotedFocus}，把目标、约束、代价和不能接受的结果经历过一轮拆分。`,
      keywords: [focus, "目标", "约束", "代价", "变量", evidenceFocus],
      variables: [focus, "关键变量", evidenceFocus],
      stance: "viewpoint"
    },
    {
      id: "evidence_samples",
      title: `有人留下了和${quotedFocus}相近的公开经历`,
      summary: `这类样本的价值在于与${quotedFocus}相近的经历、判断依据和可迁移边界。`,
      keywords: [focus, "经历", "样本", "依据", "边界", evidenceFocus],
      variables: [focus, "公开样本", "可迁移边界"],
      stance: "mixed"
    },
    {
      id: "small_step",
      title: `有人先用一小段试错验证${quotedFocus}`,
      summary: `这类样本把下一步做成可观察、可回撤的小实验，先验证${riskFocus}再扩大投入。`,
      keywords: [focus, "验证", "试错", "回撤", "风险", riskFocus],
      variables: [focus, "小步验证", riskFocus],
      stance: "experience"
    }
  ];
}

function extractFocusPhrase(query: string, candidates: DemoPathCandidate[]): string {
  const normalized = normalizeDemoQuery(query)
    .replace(/[？?！!。,.，]/g, "")
    .replace(/^(我想知道|想问|请问|关于)/, "");
  if (normalized.length > 0 && normalized.length <= 14) {
    return normalized;
  }

  const knownKeyword = extractQueryKeywords(normalized)[0] ?? extractCandidateKeywords(candidates)[0];
  if (knownKeyword) {
    return knownKeyword;
  }

  return truncateText(normalized || "当前问题", 14);
}

function extractQueryKeywords(query: string): string[] {
  const keywordPool = [
    "异地恋",
    "工作",
    "关系",
    "转行",
    "35岁",
    "年龄",
    "不工作",
    "城市",
    "现金流",
    "风险",
    "学习",
    "收入",
    "家庭",
    "父母",
    "朋友",
    "断联",
    "读研",
    "北京",
    "老家",
    "选择",
    "值得"
  ];

  return keywordPool.filter((keyword) => query.includes(keyword));
}

function extractCandidateKeywords(candidates: DemoPathCandidate[]): string[] {
  const text = candidates.map((candidate) => `${candidate.title}\n${candidate.text}`).join("\n");
  const keywordPool = [
    "工作机会",
    "异地期限",
    "见面成本",
    "目标岗位",
    "可迁移经验",
    "试错成本",
    "停靠地点",
    "现金流",
    "保障底线",
    "生活成本",
    "退出条件",
    "机会密度",
    "家庭关系",
    "真实卡点",
    "经济独立",
    "边界表达"
  ];

  return keywordPool.filter((keyword) => text.includes(keyword)).slice(0, 4);
}

function countKeywordHits(text: string, keywords: string[]): number {
  return keywords.reduce((total, keyword) => total + (text.includes(keyword) ? 1 : 0), 0);
}

function truncateText(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }

  return `${value.slice(0, maxLength - 3)}...`;
}

function unique<T>(values: T[]): T[] {
  return Array.from(new Set(values.filter(Boolean)));
}

function hashId(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }

  return (hash >>> 0).toString(16);
}
