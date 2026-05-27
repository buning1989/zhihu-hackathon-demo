import {
  type DemoObjectiveQueryPlan,
  type DemoObjectiveSlotName,
  type DemoObjectiveSlots,
  type DemoSearchQueryPlan,
  type DemoSearchQueryType
} from "../types/demo.types.js";

const MIN_SEARCH_QUERY_COUNT = 8;
const MAX_SEARCH_QUERY_COUNT = 12;

const SEARCH_QUERY_TYPES: DemoSearchQueryType[] = [
  "original",
  "real_experience",
  "life_path",
  "failure_review",
  "decision_conflict",
  "alternative_solution"
];

const FALLBACK_TYPE_PRIORITY: Record<DemoSearchQueryType, number> = {
  original: 1,
  real_experience: 2,
  life_path: 3,
  failure_review: 4,
  decision_conflict: 5,
  alternative_solution: 6
};

const GENERIC_QUERY_BLOCKLIST = new Set([
  "人生选择",
  "职业规划",
  "生活方式",
  "个人成长",
  "情绪管理",
  "未来规划",
  "人生路径"
]);

const OBJECTIVE_SLOT_NAMES: DemoObjectiveSlotName[] = [
  "age",
  "industry",
  "companyType",
  "role",
  "city",
  "status",
  "direction",
  "constraint"
];

const IMPORTANT_MISSING_SLOT_NAMES: DemoObjectiveSlotName[] = [
  "role",
  "status",
  "direction",
  "constraint"
];

const GENERIC_PRIMARY_WORDS = [
  "真实经历",
  "后悔吗",
  "后悔",
  "怎么办",
  "值得吗",
  "值不值得",
  "迷茫",
  "真实",
  "经历"
];

interface RawSearchQueryPlan {
  query: string;
  type?: string;
  purpose?: string;
  priority?: number;
}

export interface ObjectiveSearchContext {
  objectiveSlots: DemoObjectiveSlots;
  missingSlots: DemoObjectiveSlotName[];
  queryPlan: DemoObjectiveQueryPlan;
}

export function buildObjectiveSearchContext(
  query: string,
  rawObjectiveSlots?: unknown
): ObjectiveSearchContext {
  const objectiveSlots = mergeObjectiveSlots(
    extractObjectiveSlots(query),
    readRawObjectiveSlots(rawObjectiveSlots)
  );
  const queryPlan = buildObjectiveQueryPlan(objectiveSlots, query);
  const missingSlots = IMPORTANT_MISSING_SLOT_NAMES.filter(
    (slotName) => !objectiveSlots[slotName]
  );

  return {
    objectiveSlots,
    missingSlots,
    queryPlan
  };
}

export function normalizeSearchQueryPlans(
  originalQuery: string,
  rawSearchQueries: unknown,
  rawObjectiveSlots?: unknown
): DemoSearchQueryPlan[] {
  const originalPlan = createOriginalPlan(originalQuery);
  const objectiveContext = buildObjectiveSearchContext(originalQuery, rawObjectiveSlots);
  const objectivePlans = objectiveQueryPlanToSearchPlans(objectiveContext.queryPlan);
  const fallbackPlans = buildFallbackSearchQueryPlan(originalQuery);
  const plannedQueries = readRawSearchQueryPlans(rawSearchQueries)
    .map((item, index) => sanitizeSearchQueryPlan(item, index + 2))
    .filter((item): item is DemoSearchQueryPlan => Boolean(item));
  const sortedPlans = plannedQueries
    .filter((item) => normalizeText(item.query) !== normalizeText(originalPlan.query))
    .sort(compareSearchQueryPlans);

  return completeSearchQueryPlan(originalPlan, [...objectivePlans, ...sortedPlans], fallbackPlans);
}

export function buildFallbackSearchQueryPlan(originalQuery: string): DemoSearchQueryPlan[] {
  const normalizedQuery = normalizeText(originalQuery);
  const categoryPlans = selectFallbackCategoryPlans(normalizedQuery);

  return completeSearchQueryPlan(
    createOriginalPlan(normalizedQuery),
    [],
    [createOriginalPlan(normalizedQuery), ...categoryPlans]
  );
}

export function sortSearchQueryPlans(plans: DemoSearchQueryPlan[]): DemoSearchQueryPlan[] {
  const [original, ...rest] = plans;
  return [original, ...rest.sort(compareSearchQueryPlans)];
}

export interface TargetedSupplementalSearchInput {
  originalQuery: string;
  intent?: {
    userCoreQuestion?: string;
    focusTags?: string[];
    topicSignals?: string[];
    searchQueries?: DemoSearchQueryPlan[];
  };
  metadata?: Record<string, unknown>;
  profileSignals?: string[];
  executedQueries?: DemoSearchQueryPlan[];
  maxQueries?: number;
}

interface SupplementalSignal {
  value: string;
  source: string;
}

const SUPPLEMENTAL_GENERIC_QUERY_FRAGMENTS = [
  "真实经历",
  "亲身经历",
  "人生复盘",
  "真实记录",
  "选择后",
  "我后来"
];

const CLARIFICATION_VALUE_LABELS: Record<string, string> = {
  under_1_month: "1个月以内",
  under_6_months: "6个月以内",
  "1_to_3_months": "1-3个月",
  "3_to_6_months": "3-6个月",
  "6_to_12_months": "6-12个月",
  over_12_months: "12个月以上",
  "1_to_2_years": "1-2年",
  "2_to_3_years": "2-3年",
  over_3_years: "3年以上",
  under_25: "25岁以下",
  around_30: "30岁",
  around_35: "35岁",
  middle_age: "中年",
  graduated_three_years: "毕业三年内",
  big_tech: "大厂",
  state_owned: "国企",
  public_sector: "体制内",
  startup_company: "创业公司",
  traditional_company: "传统企业",
  internet: "互联网",
  education: "教育",
  healthcare: "医疗",
  finance: "金融",
  construction: "施工单位",
  consumer_service: "消费服务",
  first_tier: "一线城市",
  new_first_tier: "新一线",
  second_tier: "二线城市",
  county_home: "老家",
  beijing_shanghai: "北京 上海",
  target_city: "目标城市",
  target_role: "目标岗位",
  interview_leads: "面试机会",
  local_network: "本地人脉",
  place_to_stay: "落脚住处",
  job_leads: "工作机会",
  family_support: "家人支持",
  housing: "住处",
  available_money: "可用资金",
  low_cost: "低生活成本",
  industry_experience: "行业经验",
  project_experience: "项目经验",
  transferable_skill: "可迁移技能",
  industry_knowledge: "行业知识",
  technical_skill: "技术能力",
  network: "没人带路",
  professional_skill: "专业技能",
  portfolio: "作品案例",
  client_network: "客户人脉",
  content_account: "内容账号",
  sellable_product: "可售产品",
  sporadic_projects: "零散项目",
  stable_side_income: "稳定副业",
  fixed_clients: "固定客户",
  passive_income: "被动收入",
  local_job: "本地工作",
  family_business: "家里生意",
  open_shop: "开店",
  remote_work: "远程 自由职业",
  rest_first: "先休整"
};

export function buildTargetedSupplementalSearchQueries(
  input: TargetedSupplementalSearchInput
): DemoSearchQueryPlan[] {
  const originalQuery = normalizeText(input.originalQuery);
  const metadataSignals = extractSupplementalMetadataSignals(input.metadata);
  const profileSignals = (input.profileSignals ?? [])
    .map((value) => normalizeText(value))
    .filter(isSupplementalToken)
    .map((value) => ({ value, source: "用户资料" }));
  const allSignals = uniqueSignals([...metadataSignals, ...profileSignals]);
  const combinedText = normalizeText([
    originalQuery,
    input.intent?.userCoreQuestion ?? "",
    ...(input.intent?.focusTags ?? []),
    ...(input.intent?.topicSignals ?? []),
    ...allSignals.map((signal) => signal.value)
  ].join(" "));
  const objectiveContext = buildObjectiveSearchContext(
    combinedText,
    readMetadataRecord(input.metadata, "objectiveSlots")
  );
  const slots = objectiveContext.objectiveSlots;
  const executedKeys = new Set([
    normalizeText(originalQuery),
    ...(input.executedQueries ?? []).map((item) => normalizeText(item.query))
  ]);
  const result: DemoSearchQueryPlan[] = [];
  const candidatePlans: DemoSearchQueryPlan[] = [];
  const maxQueries = Math.min(Math.max(input.maxQueries ?? 3, 1), 3);
  const purpose = buildSupplementalPurpose(originalQuery, allSignals);

  appendScenarioSupplementalCandidates(candidatePlans, combinedText, slots, allSignals, purpose);
  appendObjectiveSupplementalCandidates(candidatePlans, slots, purpose);
  appendPlannedSupplementalCandidates(candidatePlans, input.intent?.searchQueries ?? [], executedKeys, purpose);

  for (const item of candidatePlans) {
    const normalized = normalizeText(item.query);
    if (result.length >= maxQueries) {
      break;
    }
    if (executedKeys.has(normalized) || result.some((existing) => normalizeText(existing.query) === normalized)) {
      continue;
    }
    if (!isTargetedSupplementalQuery(item.query, combinedText)) {
      continue;
    }

    result.push({
      ...item,
      query: truncateSearchQuery(normalized, 24),
      purpose: truncateText(item.purpose || purpose, 80)
    });
  }

  return result;
}

function appendPlannedSupplementalCandidates(
  target: DemoSearchQueryPlan[],
  plans: DemoSearchQueryPlan[],
  executedKeys: Set<string>,
  purpose: string
): void {
  for (const item of plans) {
    const normalized = normalizeText(item.query);
    if (executedKeys.has(normalized) || SUPPLEMENTAL_GENERIC_QUERY_FRAGMENTS.some((fragment) => normalized.includes(fragment))) {
      continue;
    }
    if (item.type === "original") {
      continue;
    }

    target.push({
      ...item,
      purpose: `${purpose}；沿用未执行搜索计划「${truncateText(item.purpose, 18)}」`
    });
  }
}

function appendScenarioSupplementalCandidates(
  target: DemoSearchQueryPlan[],
  text: string,
  slots: DemoObjectiveSlots,
  signals: SupplementalSignal[],
  purpose: string
): void {
  const signalValues = signals.map((item) => item.value);
  const strongestContext = firstSupplementalToken([
    slots.age,
    slots.role,
    slots.industry,
    slots.companyType,
    ...signalValues
  ]);

  if (isRelationshipWorkQuery(text)) {
    appendSupplementalPlan(target, ["异地恋", "工作选择"], "decision_conflict", purpose, 2);
    appendSupplementalPlan(target, ["为了工作", "异地恋"], "decision_conflict", purpose, 2);
    appendSupplementalPlan(target, ["异地恋", slots.city || "职业发展"], "life_path", purpose, 3);
    return;
  }

  if (isRelationshipQuery(text)) {
    appendSupplementalPlan(target, ["长期异地恋", "未来规划"], "life_path", purpose, 2);
    appendSupplementalPlan(target, ["异地恋", "坚持下来"], "real_experience", purpose, 3);
    appendSupplementalPlan(target, ["异地恋", "分手后悔"], "failure_review", purpose, 3);
    return;
  }

  if (isProductManagerTransitionQuery(text)) {
    const pmContext = firstSupplementalToken([
      slots.age,
      slots.role && !/产品经理|产品岗|pm/i.test(slots.role) ? slots.role : null,
      slots.industry,
      slots.companyType,
      ...signalValues.filter((item) => !/产品经理|产品岗|项目经验|作品集|面试/.test(item))
    ]) || "转行";
    appendSupplementalPlan(
      target,
      pmContext === "转行" ? ["转行", "产品经理"] : [pmContext, "转产品经理"],
      "real_experience",
      purpose,
      2
    );
    const pmEvidenceToken =
      firstSupplementalToken(signalValues.filter((item) => /项目|作品|面试|能力|行业|技术|经验/.test(item))) ||
      firstSupplementalToken([slots.constraint, ...signalValues]);
    appendSupplementalPlan(target, ["转产品经理", pmEvidenceToken || "上岸"], "life_path", purpose, 2);
    appendSupplementalPlan(target, ["转产品经理", "后悔吗"], "failure_review", purpose, 3);
    return;
  }

  if (isCityHomeChoiceQuery(text)) {
    appendSupplementalPlan(target, [slots.age || "毕业", "回老家", "后悔"], "failure_review", purpose, 2);
    appendSupplementalPlan(target, [slots.age || "毕业", "去一线城市"], "real_experience", purpose, 2);
    appendSupplementalPlan(target, ["大城市", "回老家", "成本"], "decision_conflict", purpose, 3);
    return;
  }

  if (/裸辞/.test(text)) {
    appendSupplementalPlan(target, [strongestContext, "裸辞后"], "real_experience", purpose, 2);
    appendSupplementalPlan(target, ["裸辞", "空窗期"], "life_path", purpose, 2);
    appendSupplementalPlan(target, ["裸辞", "后悔吗"], "failure_review", purpose, 3);
    return;
  }

  if (/不工作|不上班|待业|失业/.test(text)) {
    appendSupplementalPlan(target, ["不工作后", "生活"], "real_experience", purpose, 2);
    appendSupplementalPlan(target, ["不上班之后", "生活"], "real_experience", purpose, 2);
    appendSupplementalPlan(target, ["长期不上班", "状态"], "life_path", purpose, 3);
    return;
  }

  if (isThirtyRestartQuery(text)) {
    appendSupplementalPlan(target, [slots.age || "30岁", "重新开始"], "real_experience", purpose, 2);
    appendSupplementalPlan(target, ["30岁", slots.direction || "转行"], "decision_conflict", purpose, 2);
    appendSupplementalPlan(target, ["30岁", "学新技能"], "life_path", purpose, 3);
    return;
  }

  if (isStabilityPassionQuery(text)) {
    appendSupplementalPlan(target, ["稳定工作", "放弃热爱"], "decision_conflict", purpose, 2);
    appendSupplementalPlan(target, ["稳定收入", "做喜欢的事"], "life_path", purpose, 2);
    appendSupplementalPlan(target, [slots.companyType || "体制内", "放弃梦想"], "failure_review", purpose, 3);
  }
}

function appendObjectiveSupplementalCandidates(
  target: DemoSearchQueryPlan[],
  slots: DemoObjectiveSlots,
  purpose: string
): void {
  appendSupplementalPlan(target, [slots.role, slots.direction], "real_experience", purpose, 4);
  appendSupplementalPlan(target, [slots.status, slots.direction], "decision_conflict", purpose, 4);
  appendSupplementalPlan(target, [slots.city, slots.direction], "life_path", purpose, 5);
  appendSupplementalPlan(target, [slots.companyType, slots.status, slots.direction], "failure_review", purpose, 5);
  appendSupplementalPlan(target, [slots.direction, slots.constraint], "alternative_solution", purpose, 5);
}

function appendSupplementalPlan(
  target: DemoSearchQueryPlan[],
  parts: Array<string | null | undefined>,
  type: DemoSearchQueryType,
  purpose: string,
  priority: number
): void {
  const query = formatSupplementalQuery(parts);
  if (!query) {
    return;
  }

  target.push(plan(query, type, purpose, priority));
}

function formatSupplementalQuery(parts: Array<string | null | undefined>): string {
  const tokens = unique(
    parts
      .flatMap((item) => normalizeText(item ?? "").split(/\s+/))
      .filter(isSupplementalToken)
  ).slice(0, 4);

  if (tokens.length < 2) {
    return "";
  }

  return tokens.join(" ");
}

function buildSupplementalPurpose(originalQuery: string, signals: SupplementalSignal[]): string {
  const core = extractCorePhrase(originalQuery);
  const clarificationSignals = signals
    .filter((item) => item.source === "澄清卡")
    .map((item) => item.value)
    .slice(0, 2);
  const profileSignals = signals
    .filter((item) => item.source === "用户资料")
    .map((item) => item.value)
    .slice(0, 1);
  const parts = [`原问题核心「${truncateText(core, 16)}」`];

  if (clarificationSignals.length > 0) {
    parts.push(`澄清卡「${clarificationSignals.join("、")}」`);
  }
  if (profileSignals.length > 0) {
    parts.push(`用户资料「${profileSignals.join("、")}」`);
  }

  return `补搜：来自${parts.join(" + ")}`;
}

function extractSupplementalMetadataSignals(metadata?: Record<string, unknown>): SupplementalSignal[] {
  const signals: SupplementalSignal[] = [];
  const clarificationSources = [
    readMetadataRecord(metadata, "clarificationAnswers"),
    readMetadataRecord(metadata, "answerLabels"),
    readMetadataRecord(metadata, "clarificationAnswerLabels"),
    readMetadataRecord(readMetadataRecord(metadata, "clarificationContext"), "answerLabels")
  ];

  for (const source of clarificationSources) {
    for (const [key, value] of Object.entries(source)) {
      const label = normalizeClarificationValue(key, value);
      if (label) {
        signals.push({ value: label, source: "澄清卡" });
      }
    }
  }

  for (const value of readStringArray(metadata?.searchHints)) {
    const hint = sanitizeSupplementalToken(value);
    if (hint) {
      signals.push({ value: hint, source: "澄清卡" });
    }
  }

  return uniqueSignals(signals);
}

function normalizeClarificationValue(key: string, value: unknown): string {
  const raw = readString(value);
  if (!raw) {
    return "";
  }

  const mapped = CLARIFICATION_VALUE_LABELS[raw] || CLARIFICATION_VALUE_LABELS[normalizeText(raw)] || raw;
  const normalized = sanitizeSupplementalToken(mapped);
  if (!normalized || /^(none|unknown|other|不确定|暂时没有|还不确定|没有|无|其他)$/i.test(normalized)) {
    return "";
  }

  if (/runway|cash|空窗/.test(key) && /\d|个月|年/.test(normalized)) {
    return normalized;
  }

  return normalized;
}

function sanitizeSupplementalToken(value: string): string {
  const normalized = normalizeText(value)
    .replace(/[|/／]+/g, " ")
    .replace(/[？?。！!；;：:，,、]+$/g, "");
  if (!normalized || SUPPLEMENTAL_GENERIC_QUERY_FRAGMENTS.some((fragment) => normalized === fragment)) {
    return "";
  }

  return normalized.length <= 14 ? normalized : "";
}

function firstSupplementalToken(values: Array<string | null | undefined>): string | null {
  for (const value of values) {
    const token = sanitizeSupplementalToken(value ?? "");
    if (token && isSupplementalToken(token)) {
      return token;
    }
  }

  return null;
}

function isSupplementalToken(value: string): boolean {
  const normalized = normalizeText(value);
  if (!normalized || normalized.length < 2 || normalized.length > 14) {
    return false;
  }

  return !SUPPLEMENTAL_GENERIC_QUERY_FRAGMENTS.some((fragment) => normalized === fragment);
}

function isTargetedSupplementalQuery(query: string, contextText: string): boolean {
  const normalized = normalizeText(query);
  if (!isUsableSearchQuery(normalized)) {
    return false;
  }
  if (SUPPLEMENTAL_GENERIC_QUERY_FRAGMENTS.some((fragment) => normalized === fragment || normalized.startsWith(`${fragment} `))) {
    return false;
  }

  const tokens = normalized.split(/\s+/).filter(Boolean);
  const contextHitCount = tokens.filter((token) => contextText.includes(token)).length;
  const synonymScenarioHit =
    (/不工作|不上班|待业|失业/.test(contextText) && /不工作|不上班|待业|现金流|出路/.test(normalized)) ||
    (/异地恋|长期异地|远距离恋爱/.test(contextText) && /异地恋|长期异地|见面|未来规划|坚持|分手|团聚/.test(normalized)) ||
    (/转行|转岗|转产品|产品经理|产品岗|pm/i.test(contextText) && /转产品经理|产品经理|产品岗|项目经验|作品集|面试/.test(normalized)) ||
    (/大城市|一线城市|回老家|老家|家乡/.test(contextText) && /大城市|一线城市|回老家|老家|毕业|成本/.test(normalized)) ||
    (/裸辞|辞职|离职/.test(contextText) && /裸辞|辞职|空窗|找工作|后悔/.test(normalized)) ||
    (/30岁|三十岁|重新开始/.test(contextText) && /30岁|三十岁|重新开始|转行|学新技能/.test(normalized)) ||
    (/稳定|热爱|喜欢的事|梦想/.test(contextText) && /稳定|热爱|喜欢的事|梦想|放弃/.test(normalized));
  const scenarioHit = [
    "异地恋",
    "工作",
    "职业",
    "产品经理",
    "转产品经理",
    "大城市",
    "回老家",
    "裸辞",
    "不工作",
    "不上班",
    "待业",
    "30岁",
    "三十岁",
    "稳定",
    "热爱",
    "喜欢的事"
  ].some((token) => normalized.includes(token) && contextText.includes(token));

  return synonymScenarioHit || scenarioHit || contextHitCount >= Math.min(2, tokens.length);
}

function readMetadataRecord(source: unknown, key: string): Record<string, unknown> {
  if (!isRecord(source)) {
    return {};
  }

  const value = source[key];
  return isRecord(value) ? value : {};
}

function uniqueSignals(signals: SupplementalSignal[]): SupplementalSignal[] {
  const seen = new Set<string>();
  const result: SupplementalSignal[] = [];

  for (const signal of signals) {
    const key = normalizeText(signal.value);
    if (!key || seen.has(key)) {
      continue;
    }

    seen.add(key);
    result.push({ ...signal, value: key });
  }

  return result;
}

function completeSearchQueryPlan(
  originalPlan: DemoSearchQueryPlan,
  plannedQueries: DemoSearchQueryPlan[],
  fallbackPlans: DemoSearchQueryPlan[]
): DemoSearchQueryPlan[] {
  const result: DemoSearchQueryPlan[] = [];
  appendUnique(result, originalPlan);
  for (const item of plannedQueries) {
    if (result.length >= MAX_SEARCH_QUERY_COUNT) {
      break;
    }

    appendUnique(result, item);
  }

  for (const type of SEARCH_QUERY_TYPES) {
    if (result.some((item) => item.type === type)) {
      continue;
    }

    const fallback = fallbackPlans.find((item) => item.type === type);
    if (fallback) {
      appendOrReplaceDuplicateType(result, fallback);
    }
  }

  for (const fallback of fallbackPlans) {
    if (result.length >= MIN_SEARCH_QUERY_COUNT && hasRequiredTypeCoverage(result)) {
      break;
    }

    appendUnique(result, fallback);
  }

  for (const fallback of fallbackPlans) {
    if (result.length >= MAX_SEARCH_QUERY_COUNT) {
      break;
    }

    appendUnique(result, fallback);
  }

  return sortSearchQueryPlans(result).slice(0, MAX_SEARCH_QUERY_COUNT);
}

function selectFallbackCategoryPlans(query: string): DemoSearchQueryPlan[] {
  if (isRelationshipWorkQuery(query)) {
    return relationshipWorkFallbackPlans();
  }

  if (isRelationshipQuery(query)) {
    return relationshipFallbackPlans();
  }

  if (isProductManagerTransitionQuery(query)) {
    return productManagerTransitionFallbackPlans();
  }

  if (isCityHomeChoiceQuery(query)) {
    return cityHomeChoiceFallbackPlans();
  }

  if (isThirtyRestartQuery(query)) {
    return thirtyRestartFallbackPlans();
  }

  if (isStabilityPassionQuery(query)) {
    return stabilityPassionFallbackPlans();
  }

  const objectivePlans = objectiveQueryPlanToSearchPlans(
    buildObjectiveSearchContext(query).queryPlan
  );
  if (objectivePlans.length > 0) {
    return [...objectivePlans, ...genericFallbackPlans(query)];
  }

  return genericFallbackPlans(query);
}

function relationshipWorkFallbackPlans(): DemoSearchQueryPlan[] {
  return [
    plan("长期异地恋 工作选择", "decision_conflict", "召回异地恋和工作取舍", 2),
    plan("异地恋 职业发展 后悔吗", "failure_review", "召回职业发展与关系代价复盘", 2),
    plan("异地恋 为了工作 分开", "failure_review", "召回为工作分开的经历", 3),
    plan("异地恋 追求梦想 真实经历", "real_experience", "召回追求自我与关系距离经历", 3),
    plan("异地恋 工作机会 怎么选", "decision_conflict", "召回工作机会和关系选择", 4),
    plan("异地恋 异地工作 坚持下来", "real_experience", "召回坚持异地的后续状态", 4),
    plan("异地恋 团聚 城市选择", "life_path", "召回团聚和城市路径", 5),
    plan("为了工作 异地恋 值得吗", "decision_conflict", "召回是否值得的讨论", 5),
    plan("异地恋 未来规划 沟通", "life_path", "召回未来时间表和沟通路径", 6),
    plan("异地恋 工作调动 代价", "alternative_solution", "召回工作调动与关系代价", 6)
  ];
}

function relationshipFallbackPlans(): DemoSearchQueryPlan[] {
  return [
    plan("长期异地恋真的值得吗", "original", "保留异地恋原始场景", 1),
    plan("长期异地恋 真实经历", "real_experience", "召回长期异地恋真实经历", 2),
    plan("异地恋 值得吗 后悔吗", "failure_review", "召回异地恋是否值得的复盘", 3),
    plan("长期异地恋 见面 未来规划", "life_path", "召回见面频率和未来规划", 3),
    plan("异地恋 坚持下来 后来", "real_experience", "召回坚持异地后的结果", 4),
    plan("异地恋 分手 复盘", "failure_review", "召回异地失败复盘", 4),
    plan("异地恋 沟通 安全感", "decision_conflict", "召回沟通和安全感冲突", 5),
    plan("异地恋 团聚 城市选择", "alternative_solution", "召回团聚和城市替代方案", 5)
  ];
}

function productManagerTransitionFallbackPlans(): DemoSearchQueryPlan[] {
  return [
    plan("转行做产品经理 真实经历", "real_experience", "召回转行做产品经理亲历", 2),
    plan("转行 产品经理 门槛", "life_path", "召回产品经理转行门槛", 2),
    plan("产品经理 转行 后悔吗", "failure_review", "召回产品经理转行后复盘", 3),
    plan("零基础 转产品经理 现实吗", "decision_conflict", "召回零基础转产品经理现实讨论", 4),
    plan("转产品经理 项目经验 作品集", "life_path", "召回项目经验和作品集路径", 4),
    plan("转行做产品经理 失败复盘", "failure_review", "召回转产品失败和代价", 5),
    plan("产品经理 入行 能力", "alternative_solution", "召回产品经理能力准备", 5)
  ];
}

function cityHomeChoiceFallbackPlans(): DemoSearchQueryPlan[] {
  return [
    plan("毕业后 大城市 回老家", "real_experience", "召回毕业后城市去留经历", 2),
    plan("毕业 去大城市 还是回老家", "decision_conflict", "召回毕业后城市选择冲突", 2),
    plan("留在大城市 回老家 后悔吗", "failure_review", "召回城市去留后悔复盘", 3),
    plan("大城市 机会 老家 成本", "life_path", "召回机会和生活成本对照", 3),
    plan("毕业回老家 真实经历", "real_experience", "召回毕业回老家经历", 4),
    plan("毕业去一线城市 真实经历", "real_experience", "召回毕业去一线城市经历", 4),
    plan("大城市 老家 怎么选", "decision_conflict", "召回城市去留判断", 5)
  ];
}

function thirtyRestartFallbackPlans(): DemoSearchQueryPlan[] {
  return [
    plan("三十岁 重新开始 真实经历", "real_experience", "召回三十岁重新开始经历", 2),
    plan("30岁 重新开始 来得及吗", "decision_conflict", "召回30岁重新开始讨论", 2),
    plan("三十岁 转行 后悔吗", "failure_review", "召回三十岁转行复盘", 3),
    plan("30岁 学新技能 现实吗", "life_path", "召回学习和现实路径", 3),
    plan("三十岁 重新开始 失败复盘", "failure_review", "召回重新开始失败复盘", 4),
    plan("30岁 重新开始 收入 压力", "alternative_solution", "召回收入和压力替代方案", 5)
  ];
}

function stabilityPassionFallbackPlans(): DemoSearchQueryPlan[] {
  return [
    plan("稳定工作 喜欢的事", "real_experience", "召回稳定工作和喜欢的事之间的取舍", 2),
    plan("为了稳定 放弃热爱", "decision_conflict", "召回为了稳定放弃热爱的讨论", 2),
    plan("稳定 放弃梦想 后悔吗", "failure_review", "召回稳定与梦想取舍后的复盘", 3),
    plan("稳定收入 做喜欢的事", "life_path", "召回稳定收入和兴趣并行的路径", 3),
    plan("稳定工作 不喜欢 要不要", "decision_conflict", "召回稳定但不喜欢的工作选择", 4),
    plan("热爱 现实 稳定 选择", "decision_conflict", "召回热爱和现实稳定的选择冲突", 4),
    plan("体制内 放弃热爱", "failure_review", "召回稳定体制和热爱之间的代价", 5),
    plan("兴趣 事业 稳定 取舍", "alternative_solution", "召回兴趣事业和稳定取舍的替代方案", 5),
    plan("喜欢的事 变成工作 后悔吗", "failure_review", "召回把喜欢的事变成工作的后续", 6),
    plan("稳定 追求梦想 真实经历", "real_experience", "召回稳定和追梦之间的真实经历", 6)
  ];
}

export function objectiveQueryPlanToSearchPlans(
  queryPlan: DemoObjectiveQueryPlan
): DemoSearchQueryPlan[] {
  const plans: DemoSearchQueryPlan[] = [];

  queryPlan.primary.forEach((query, index) => {
    plans.push(
      plan(
        query,
        index % 2 === 0 ? "real_experience" : "life_path",
        "优先召回客观背景相似的人和处境",
        1
      )
    );
  });

  queryPlan.secondary.forEach((query, index) => {
    plans.push(
      plan(
        query,
        index % 2 === 0 ? "life_path" : "decision_conflict",
        "补充召回选择方向相似的内容",
        2
      )
    );
  });

  queryPlan.fallback.forEach((query, index) => {
    plans.push(
      plan(
        query,
        index % 2 === 0 ? "failure_review" : "alternative_solution",
        "补充召回后果、复盘和替代方案",
        4 + Math.min(index, 2)
      )
    );
  });

  return dedupePlans(plans);
}

function buildObjectiveQueryPlan(
  slots: DemoObjectiveSlots,
  originalQuery: string
): DemoObjectiveQueryPlan {
  const primary: string[] = [];
  const secondary: string[] = [];
  const fallback: string[] = [];
  const status = slots.status;
  const direction = slots.direction;
  const companyPhrase = combineTight(slots.industry, slots.companyType);

  appendObjectiveQuery(primary, slots.age, slots.companyType, status);
  appendObjectiveQuery(primary, slots.industry, slots.companyType, status);
  appendObjectiveQuery(primary, companyPhrase, status, direction);
  appendObjectiveQuery(primary, slots.companyType, status, direction);
  appendObjectiveQuery(primary, slots.role, status, direction);
  appendObjectiveQuery(primary, slots.age, slots.role, direction);
  appendObjectiveQuery(primary, slots.role, direction);
  appendObjectiveQuery(primary, slots.city, status, direction);
  appendObjectiveQuery(primary, slots.industry, slots.role, status);
  appendObjectiveQuery(primary, slots.industry, slots.companyType, status);

  appendObjectiveQuery(secondary, slots.age, status, direction);
  appendObjectiveQuery(secondary, slots.industry, status, direction);
  appendObjectiveQuery(secondary, slots.role, slots.companyType, status);
  appendObjectiveQuery(secondary, slots.city, direction);
  appendObjectiveQuery(secondary, slots.role, direction);
  appendObjectiveQuery(secondary, slots.constraint, status, direction);

  appendFallbackQuery(fallback, status, direction, "后悔");
  appendFallbackQuery(fallback, combineTight(slots.companyType, status), "复盘");
  appendFallbackQuery(fallback, direction, "失败", "复盘");
  appendFallbackQuery(fallback, slots.role, status, "复盘");
  appendFallbackQuery(fallback, extractCorePhrase(originalQuery), "真实经历");

  const normalizedPrimary = primary
    .filter((query) => hasStatusOrDirection(query, slots))
    .filter((query) => !containsGenericPrimaryWord(query));
  const normalizedSecondary = secondary.filter((query) => hasStatusOrDirection(query, slots));

  return {
    primary: unique(normalizedPrimary).slice(0, 5),
    secondary: unique(normalizedSecondary).slice(0, 5),
    fallback: unique(fallback).slice(0, 4)
  };
}

function extractObjectiveSlots(query: string): DemoObjectiveSlots {
  const normalized = normalizeText(query);

  return {
    age: extractAge(normalized),
    industry: firstIncluded(normalized, [
      "互联网",
      "教育",
      "医疗",
      "施工单位",
      "建筑",
      "金融",
      "游戏",
      "广告",
      "制造业",
      "房地产"
    ]),
    companyType: firstIncluded(normalized, [
      "大厂",
      "体制内",
      "国企",
      "外企",
      "创业公司",
      "正式工"
    ]),
    role: extractRole(normalized),
    city: firstIncluded(normalized, [
      "北京",
      "上海",
      "深圳",
      "广州",
      "杭州",
      "成都",
      "老家",
      "县城",
      "一线城市",
      "二线城市"
    ]),
    status: extractStatus(normalized),
    direction: extractDirection(normalized),
    constraint: extractConstraint(normalized)
  };
}

function readRawObjectiveSlots(value: unknown): Partial<DemoObjectiveSlots> {
  if (!isRecord(value)) {
    return {};
  }

  return OBJECTIVE_SLOT_NAMES.reduce<Partial<DemoObjectiveSlots>>((slots, slotName) => {
    const slotValue = sanitizeSlotValue(readString(value[slotName]));
    if (slotValue) {
      slots[slotName] = slotValue;
    }

    return slots;
  }, {});
}

function mergeObjectiveSlots(
  extracted: DemoObjectiveSlots,
  rawSlots: Partial<DemoObjectiveSlots>
): DemoObjectiveSlots {
  return OBJECTIVE_SLOT_NAMES.reduce<DemoObjectiveSlots>((slots, slotName) => {
    slots[slotName] = extracted[slotName] || rawSlots[slotName] || null;
    return slots;
  }, createEmptyObjectiveSlots());
}

function createEmptyObjectiveSlots(): DemoObjectiveSlots {
  return {
    age: null,
    industry: null,
    companyType: null,
    role: null,
    city: null,
    status: null,
    direction: null,
    constraint: null
  };
}

function extractAge(query: string): string | null {
  const digitAge = query.match(/([2-6]\d)\s*岁/);
  if (digitAge) {
    return `${digitAge[1]}岁`;
  }

  const lifeStage = firstIncluded(query, ["中年", "毕业三年", "毕业两年", "毕业一年"]);
  return lifeStage;
}

function extractRole(query: string): string | null {
  if (/程序员|研发|技术|写代码/.test(query) && /转产品|产品经理|产品岗/.test(query)) {
    return "程序员";
  }

  const rolePairs: Array<[RegExp, string]> = [
    [/产品经理/, "产品经理"],
    [/产品\s*[/／]?\s*运营|产品运营/, "产品经理"],
    [/运营/, "运营"],
    [/程序员|研发|技术/, "程序员"],
    [/设计师|设计|内容/, query.includes("内容") ? "内容" : "设计师"],
    [/市场|销售/, query.includes("市场") ? "市场" : "销售"],
    [/老师|教师/, query.includes("教师") ? "教师" : "老师"],
    [/医生/, "医生"],
    [/公务员/, "公务员"],
    [/正式工/, "正式工"]
  ];

  return rolePairs.find(([pattern]) => pattern.test(query))?.[1] ?? null;
}

function extractStatus(query: string): string | null {
  if (/准备辞职|想辞职|打算辞职/.test(query)) {
    return "准备辞职";
  }

  const workYears = query.match(/工作\s*([一二三四五六七八九十\d]+)\s*年/);
  if (workYears) {
    return `工作${workYears[1]}年`;
  }

  const statusPairs: Array<[RegExp, string]> = [
    [/裸辞/, "裸辞"],
    [/被裁|裁员/, "被裁"],
    [/待业/, "待业"],
    [/失业/, "失业"],
    [/离职|辞职/, "辞职"],
    [/不工作|不上班/, "不工作"],
    [/在职/, "在职"],
    [/空窗|gap/i, "空窗"]
  ];

  return statusPairs.find(([pattern]) => pattern.test(query))?.[1] ?? null;
}

function extractDirection(query: string): string | null {
  const directions: string[] = [];
  const directionPairs: Array<[RegExp, string]> = [
    [/创业/, "创业"],
    [/自由职业/, "自由职业"],
    [/独立开发|个人开发者|indie\s*hacker/i, "独立开发"],
    [/转产品经理|转产品|技术转产品|研发转产品/, "产品经理"],
    [/心理咨询|心理行业|咨询服务/, "心理咨询"],
    [/读研|考研|升学/, "读研"],
    [/一线城市找工作|去一线城市|一线城市工作/, "一线城市工作"],
    [/二线城市工作|回二线城市|去二线城市/, "二线城市工作"],
    [/保险经纪人/, "保险经纪人"],
    [/职业咨询/, "职业咨询"],
    [/新能源行业|新能源/, "新能源行业"],
    [/小红书博主|小红书|博主/, "小红书博主"],
    [/接私单|私单/, "接私单"],
    [/转行|换行业/, "转行"],
    [/考公/, "考公"],
    [/回老家/, "回老家"],
    [/开店|咖啡店|开[^，。？！\s]{0,6}店/, "开店"],
    [/自媒体/, "自媒体"],
    [/新西兰/, "新西兰"],
    [/能做什么|不知道.*做什么|去哪儿|出路/, "出路"]
  ];

  for (const [pattern, value] of directionPairs) {
    if (pattern.test(query) && !directions.includes(value)) {
      directions.push(value);
    }
  }

  const specificDirections = directions.filter((item) => item !== "转行");
  const normalizedDirections = specificDirections.length > 0 ? specificDirections : directions;

  return normalizedDirections.length > 0 ? normalizedDirections.slice(0, 2).join(" ") : null;
}

function extractConstraint(query: string): string | null {
  const constraintPairs: Array<[RegExp, string]> = [
    [/存款|现金流|钱不多|存款有限/, "存款有限"],
    [/房贷|车贷|家庭压力|家里压力/, "房贷 家庭压力"],
    [/孩子|小孩/, "孩子"],
    [/年龄压力|年龄焦虑|年纪大/, "年龄压力"],
    [/合伙人|项目/, query.includes("合伙人") ? "合伙人" : "项目"],
    [/不想再回原行业|逃离原行业/, "不想回原行业"]
  ];

  return constraintPairs.find(([pattern]) => pattern.test(query))?.[1] ?? null;
}

function appendObjectiveQuery(target: string[], ...keywords: Array<string | null | undefined>): void {
  const query = formatKeywordQuery(keywords);
  if (query) {
    target.push(query);
  }
}

function appendFallbackQuery(target: string[], ...keywords: Array<string | null | undefined>): void {
  const query = formatKeywordQuery(keywords);
  if (query) {
    target.push(query);
  }
}

function formatKeywordQuery(keywords: Array<string | null | undefined>): string {
  const tokens = keywords
    .flatMap((keyword) => normalizeText(keyword ?? "").split(/\s+/))
    .filter(Boolean);
  const dedupedTokens = unique(tokens).slice(0, 4);
  if (dedupedTokens.length < 2) {
    return "";
  }

  return dedupedTokens.join(" ");
}

function hasStatusOrDirection(query: string, slots: DemoObjectiveSlots): boolean {
  return Boolean(
    (slots.status && query.includes(slots.status)) ||
      (slots.direction && slots.direction.split(/\s+/).some((item) => query.includes(item)))
  );
}

function containsGenericPrimaryWord(query: string): boolean {
  return GENERIC_PRIMARY_WORDS.some((word) => query.includes(word));
}

function combineTight(
  left: string | null | undefined,
  right: string | null | undefined
): string | null {
  if (!left || !right) {
    return left || right || null;
  }

  if (left === right || left.includes(right) || right.includes(left)) {
    return left.length >= right.length ? left : right;
  }

  return `${left}${right}`;
}

function firstIncluded(query: string, keywords: string[]): string | null {
  return keywords.find((keyword) => query.includes(keyword)) ?? null;
}

function isStabilityPassionQuery(query: string): boolean {
  const normalized = normalizeText(query);
  return (
    /稳定|安稳|体制内|铁饭碗|稳定工作|稳定收入/.test(normalized) &&
    /喜欢|热爱|兴趣|梦想|理想|想做的事|追求/.test(normalized)
  );
}

function isRelationshipQuery(query: string): boolean {
  const normalized = normalizeText(query);
  return /异地恋|长期异地|远距离恋爱/.test(normalized);
}

function isProductManagerTransitionQuery(query: string): boolean {
  const normalized = normalizeText(query);
  return /转行|转岗|换行业|转产品/.test(normalized) && /产品经理|产品岗|pm/i.test(normalized);
}

function isCityHomeChoiceQuery(query: string): boolean {
  const normalized = normalizeText(query);
  return (
    /大城市|一线城市|城市/.test(normalized) &&
    /回老家|老家|家乡|回家/.test(normalized)
  );
}

function isThirtyRestartQuery(query: string): boolean {
  const normalized = normalizeText(query);
  return /三十岁|30岁/.test(normalized) && /重新开始|开始|还适合|来得及/.test(normalized);
}

function sanitizeSlotValue(value: string): string | null {
  const normalized = normalizeText(value)
    .replace(/^未知$|^null$|^无$/i, "")
    .replace(/[？?。！!；;：:，,、]+$/g, "");
  if (!normalized || normalized.length > 16) {
    return null;
  }

  return normalized;
}

function dedupePlans(plans: DemoSearchQueryPlan[]): DemoSearchQueryPlan[] {
  const result: DemoSearchQueryPlan[] = [];
  for (const item of plans) {
    appendUnique(result, item);
  }

  return result;
}

function genericFallbackPlans(query: string): DemoSearchQueryPlan[] {
  const core = extractCorePhrase(query);

  return [
    plan(`${core} 真实经历`, "real_experience", "召回真实经历", 2),
    plan(`${core} 后来怎么样`, "real_experience", "召回后续状态", 2),
    plan(`${core} 有哪些路径`, "life_path", "召回可行路径", 3),
    plan(`${core} 怎么开始`, "life_path", "召回行动路径", 3),
    plan(`${core} 失败复盘`, "failure_review", "召回失败和代价", 4),
    plan(`${core} 后悔吗`, "failure_review", "召回后悔与风险讨论", 4),
    plan(`${core} 怎么选`, "decision_conflict", "召回决策困境", 5),
    plan(`要不要 ${core}`, "decision_conflict", "召回是否行动的讨论", 5),
    plan(`${core} 还有什么选择`, "alternative_solution", "召回替代方案", 6),
    plan(`${core} 怎么办`, "alternative_solution", "召回可执行替代方案", 6)
  ];
}

function createOriginalPlan(query: string): DemoSearchQueryPlan {
  return {
    query,
    type: "original",
    purpose: "保留用户原始表达",
    priority: 1
  };
}

function sanitizeSearchQueryPlan(
  rawPlan: RawSearchQueryPlan,
  fallbackPriority: number
): DemoSearchQueryPlan | undefined {
  const query = truncateSearchQuery(normalizeText(rawPlan.query), 40);
  if (!isUsableSearchQuery(query)) {
    return undefined;
  }

  const type = readSearchQueryType(rawPlan.type, query);
  const priority = clampPriority(rawPlan.priority ?? FALLBACK_TYPE_PRIORITY[type] ?? fallbackPriority);

  return {
    query,
    type,
    purpose: truncateText(
      normalizeText(rawPlan.purpose || fallbackPurposeForType(type)),
      36
    ),
    priority
  };
}

function readRawSearchQueryPlans(value: unknown): RawSearchQueryPlan[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.flatMap((item) => {
    if (typeof item === "string" || typeof item === "number") {
      return [{ query: String(item) }];
    }

    if (!isRecord(item)) {
      return [];
    }

    return [
      {
        query: readString(item.query),
        type: readString(item.type),
        purpose: readString(item.purpose),
        priority: readNumber(item.priority)
      }
    ];
  });
}

function readSearchQueryType(value: unknown, query: string): DemoSearchQueryType {
  if (SEARCH_QUERY_TYPES.includes(value as DemoSearchQueryType)) {
    return value as DemoSearchQueryType;
  }

  return inferSearchQueryType(query);
}

function inferSearchQueryType(query: string): DemoSearchQueryType {
  if (query.includes("真实") || query.includes("经历") || query.includes("后来") || query.includes("去了哪里")) {
    return "real_experience";
  }

  if (query.includes("失败") || query.includes("复盘") || query.includes("后悔") || query.includes("代价")) {
    return "failure_review";
  }

  if (query.includes("要不要") || query.includes("怎么办") || query.includes("怎么选") || query.includes("该不该")) {
    return "decision_conflict";
  }

  if (query.includes("养活") || query.includes("出路") || query.includes("还能") || query.includes("替代") || query.includes("还有什么选择")) {
    return "alternative_solution";
  }

  return "life_path";
}

function fallbackPurposeForType(type: DemoSearchQueryType): string {
  switch (type) {
    case "original":
      return "保留用户原始表达";
    case "real_experience":
      return "召回真实经历";
    case "life_path":
      return "召回人生路径";
    case "failure_review":
      return "召回失败和代价";
    case "decision_conflict":
      return "召回决策困境";
    case "alternative_solution":
      return "召回替代方案";
  }
}

function appendUnique(result: DemoSearchQueryPlan[], item: DemoSearchQueryPlan): void {
  if (item.type !== "original" && !isUsableSearchQuery(item.query)) {
    return;
  }

  const normalized = normalizeText(item.query);
  if (result.some((candidate) => normalizeText(candidate.query) === normalized)) {
    return;
  }

  result.push(item);
}

function appendOrReplaceDuplicateType(
  result: DemoSearchQueryPlan[],
  item: DemoSearchQueryPlan
): void {
  if (result.some((candidate) => normalizeText(candidate.query) === normalizeText(item.query))) {
    return;
  }

  if (result.length < MAX_SEARCH_QUERY_COUNT) {
    appendUnique(result, item);
    return;
  }

  const replacementIndex = findReplaceableDuplicateTypeIndex(result);
  if (replacementIndex > 0) {
    result[replacementIndex] = item;
  }
}

function findReplaceableDuplicateTypeIndex(result: DemoSearchQueryPlan[]): number {
  const typeCounts = result.reduce((counts, item) => {
    counts.set(item.type, (counts.get(item.type) ?? 0) + 1);
    return counts;
  }, new Map<DemoSearchQueryType, number>());

  for (let index = result.length - 1; index > 0; index -= 1) {
    const item = result[index];
    if (item.type !== "original" && (typeCounts.get(item.type) ?? 0) > 1) {
      return index;
    }
  }

  return -1;
}

function hasRequiredTypeCoverage(plans: DemoSearchQueryPlan[]): boolean {
  const types = new Set(plans.map((item) => item.type));
  return SEARCH_QUERY_TYPES.every((type) => types.has(type));
}

function compareSearchQueryPlans(left: DemoSearchQueryPlan, right: DemoSearchQueryPlan): number {
  return left.priority - right.priority || typeOrder(left.type) - typeOrder(right.type);
}

function typeOrder(type: DemoSearchQueryType): number {
  return SEARCH_QUERY_TYPES.indexOf(type);
}

function plan(
  query: string,
  type: DemoSearchQueryType,
  purpose: string,
  priority: number
): DemoSearchQueryPlan {
  return {
    query,
    type,
    purpose,
    priority
  };
}

function extractCorePhrase(query: string): string {
  const normalized = normalizeText(query).replace(/[？?。！!，,、]+$/g, "");
  if (!normalized) {
    return "这个选择";
  }

  const keywordPhrase = extractKeywordPhrase(normalized);
  if (keywordPhrase) {
    return keywordPhrase;
  }

  return truncateSearchQuery(normalized, 18);
}

function isRelationshipWorkQuery(query: string): boolean {
  const normalized = normalizeText(query);
  const hasRelationship = ["异地恋", "长期异地", "恋爱", "伴侣", "男友", "女友"].some((keyword) =>
    normalized.includes(keyword)
  );
  const hasWorkTradeoff = [
    "工作",
    "职业",
    "事业",
    "追求自己",
    "想做的事",
    "梦想",
    "城市",
    "距离",
    "机会"
  ].some((keyword) => normalized.includes(keyword));

  return hasRelationship && hasWorkTradeoff;
}

function isUsableSearchQuery(query: string): boolean {
  const normalized = normalizeText(query);
  if (!normalized || normalized.length < 4) {
    return false;
  }

  if (GENERIC_QUERY_BLOCKLIST.has(normalized)) {
    return false;
  }

  return true;
}

function clampPriority(value: number): number {
  if (!Number.isFinite(value)) {
    return 6;
  }

  return Math.min(Math.max(Math.round(value), 1), 6);
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

function truncateSearchQuery(value: string, maxLength: number): string {
  const normalized = normalizeText(value);
  if (normalized.length <= maxLength) {
    return normalized;
  }

  return normalized.slice(0, maxLength).trim();
}

function extractKeywordPhrase(query: string): string {
  const keywords = [
    "长期异地恋",
    "异地恋",
    "追求自己",
    "想做的事",
    "工作",
    "职业",
    "梦想",
    "裸辞",
    "不工作",
    "不上班",
    "转行",
    "读研",
    "回老家",
    "父母",
    "朋友",
    "断联",
    "新西兰",
    "北京",
    "上海",
    "深圳",
    "后悔",
    "值得"
  ].filter((keyword) => query.includes(keyword));
  const result: string[] = [];

  for (const keyword of keywords) {
    if (result.some((existing) => existing.includes(keyword))) {
      continue;
    }

    result.push(keyword);
  }

  return result.slice(0, 4).join(" ");
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

function readStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.map(readString).filter(Boolean);
}

function readNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === "string") {
    const parsed = Number.parseFloat(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }

  return undefined;
}

function unique(values: string[]): string[] {
  return Array.from(new Set(values));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
