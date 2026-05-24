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
  if (isRelationshipWorkQuery(query)) {
    return relationshipWorkFallbackPlans();
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
