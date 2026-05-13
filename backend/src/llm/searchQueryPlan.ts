import {
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

interface RawSearchQueryPlan {
  query: string;
  type?: string;
  purpose?: string;
  priority?: number;
}

export function normalizeSearchQueryPlans(
  originalQuery: string,
  rawSearchQueries: unknown
): DemoSearchQueryPlan[] {
  const originalPlan = createOriginalPlan(originalQuery);
  const fallbackPlans = buildFallbackSearchQueryPlan(originalQuery);
  const plannedQueries = readRawSearchQueryPlans(rawSearchQueries)
    .map((item, index) => sanitizeSearchQueryPlan(item, index + 2))
    .filter((item): item is DemoSearchQueryPlan => Boolean(item));
  const sortedPlans = plannedQueries
    .filter((item) => normalizeText(item.query) !== normalizeText(originalPlan.query))
    .sort(compareSearchQueryPlans);

  return completeSearchQueryPlan(originalPlan, sortedPlans, fallbackPlans);
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
  if (isStudyQuery(query)) {
    return studyFallbackPlans();
  }

  if (isCityChoiceQuery(query)) {
    return cityChoiceFallbackPlans(query);
  }

  if (isWorkExitQuery(query)) {
    return workExitFallbackPlans(query);
  }

  return genericFallbackPlans(query);
}

function workExitFallbackPlans(query: string): DemoSearchQueryPlan[] {
  const destinationQueries = query.includes("去哪") || query.includes("哪里")
    ? [
        plan("辞职后回小城市生活", "life_path", "召回离开职场后的地点和生活路径", 3)
      ]
    : [];

  return [
    plan("裸辞后去了哪里", "real_experience", "召回裸辞后的真实去向", 2),
    plan("不上班以后怎么生活", "real_experience", "召回不上班后的生活状态", 2),
    plan("离开职场后的真实经历", "real_experience", "召回离开职场后的公开经历", 2),
    plan("自由职业真实经历", "life_path", "召回自由职业或副业过渡路径", 3),
    ...destinationQueries,
    plan("辞职后怎么生活", "life_path", "召回离职后的生活安排", 3),
    plan("裸辞失败复盘", "failure_review", "召回失败和代价", 4),
    plan("裸辞后悔吗", "failure_review", "召回后悔和风险讨论", 4),
    plan("不想上班怎么办", "decision_conflict", "召回行动前的决策困境", 5),
    plan("要不要裸辞", "decision_conflict", "召回是否行动的讨论", 5),
    plan("不工作怎么养活自己", "alternative_solution", "召回收入和替代方案", 6),
    plan("不上班还能做什么", "alternative_solution", "召回工作外的替代选择", 6)
  ];
}

function cityChoiceFallbackPlans(query: string): DemoSearchQueryPlan[] {
  const city = extractKnownCity(query);
  const cityLabel = city || "大城市";
  const returnHomeQuery = city ? `从${city}回老家后生活` : "从大城市回老家后生活";
  const stayOrReturnQuery = city ? `留在${city}还是回老家真实经历` : "留在大城市还是回老家真实经历";
  const decisionQuery = city ? `要不要离开${city}回老家` : "要不要离开大城市回老家";

  return [
    plan(stayOrReturnQuery, "real_experience", "召回去留选择的真实经历", 2),
    plan(returnHomeQuery, "real_experience", "召回回老家后的生活状态", 2),
    plan(`留在${cityLabel}还是回老家怎么选`, "decision_conflict", "召回去留之间的决策困境", 5),
    plan("离开大城市回老家后悔吗", "failure_review", "召回后悔和风险讨论", 4),
    plan("回老家发展失败复盘", "failure_review", "召回回流后的失败和代价", 4),
    plan("回老家后怎么生活", "life_path", "召回回老家的生活路径", 3),
    plan("不留大城市还有什么选择", "alternative_solution", "召回留城之外的替代选择", 6),
    plan("回老家以后怎么养活自己", "alternative_solution", "召回回流后的收入方案", 6),
    plan(decisionQuery, "decision_conflict", "召回是否离开的讨论", 5)
  ];
}

function studyFallbackPlans(): DemoSearchQueryPlan[] {
  return [
    plan("不想读研了真实经历", "real_experience", "召回不想继续读研的真实经历", 2),
    plan("不读研后来怎么样", "real_experience", "召回放弃读研后的后续状态", 2),
    plan("不读研还有什么出路", "life_path", "召回读研之外的路径", 3),
    plan("不读研怎么找工作", "alternative_solution", "召回就业替代方案", 6),
    plan("读研读不下去怎么办", "decision_conflict", "召回继续或停止的决策困境", 5),
    plan("要不要继续读研", "decision_conflict", "召回是否继续读研的讨论", 5),
    plan("放弃读研后悔吗", "failure_review", "召回后悔与风险讨论", 4),
    plan("读研失败复盘", "failure_review", "召回失败和代价复盘", 4),
    plan("不想读研的人后来怎么样", "life_path", "召回不同人生路径", 3)
  ];
}

function genericFallbackPlans(query: string): DemoSearchQueryPlan[] {
  const core = extractCorePhrase(query);

  return [
    plan(`${core}真实经历`, "real_experience", "召回真实经历", 2),
    plan(`${core}后来怎么样`, "real_experience", "召回后续状态", 2),
    plan(`${core}有哪些路径`, "life_path", "召回可行路径", 3),
    plan(`${core}怎么开始`, "life_path", "召回行动路径", 3),
    plan(`${core}失败复盘`, "failure_review", "召回失败和代价", 4),
    plan(`${core}后悔吗`, "failure_review", "召回后悔与风险讨论", 4),
    plan(`${core}怎么选`, "decision_conflict", "召回决策困境", 5),
    plan(`要不要${core}`, "decision_conflict", "召回是否行动的讨论", 5),
    plan(`${core}还有什么选择`, "alternative_solution", "召回替代方案", 6),
    plan(`${core}怎么办`, "alternative_solution", "召回可执行替代方案", 6)
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
  const query = truncateText(normalizeText(rawPlan.query), 40);
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

function isWorkExitQuery(query: string): boolean {
  return ["工作", "上班", "裸辞", "辞职", "离职", "职场", "自由职业", "gap"].some((keyword) =>
    query.toLowerCase().includes(keyword.toLowerCase())
  );
}

function isCityChoiceQuery(query: string): boolean {
  return ["北京", "上海", "深圳", "广州", "大城市", "老家", "回家", "回老家", "城市", "留下", "留在"].some(
    (keyword) => query.includes(keyword)
  );
}

function isStudyQuery(query: string): boolean {
  return ["读研", "研究生", "考研", "导师", "论文"].some((keyword) => query.includes(keyword));
}

function extractKnownCity(query: string): string {
  return ["北京", "上海", "深圳", "广州", "杭州", "成都", "武汉", "南京"].find((city) =>
    query.includes(city)
  ) ?? "";
}

function extractCorePhrase(query: string): string {
  const normalized = normalizeText(query).replace(/[？?。！!，,、]+$/g, "");
  if (!normalized) {
    return "这个选择";
  }

  return truncateText(normalized, 18);
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

function readString(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }

  if (typeof value === "number") {
    return String(value);
  }

  return "";
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
