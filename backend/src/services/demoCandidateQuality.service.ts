import type { SearchItem, SearchMatchedQuery } from "../types/api.types.js";
import type {
  DemoCandidateQuality,
  DemoContentRole,
  DemoMatchedQueryDebug,
  DemoRoughTier,
  DemoRoughTierDistribution,
  DemoSearchQueryPlan,
  DemoSearchQueryType
} from "../types/demo.types.js";
import { normalizeDemoQuery } from "./demoQueryIdentity.service.js";

export interface CandidateAssessment extends DemoCandidateQuality {
  item: SearchItem;
  author: string;
  summary: string;
  roughScore: number;
  topicHitScore: number;
  narrativeScore: number;
  specificityScore: number;
  basicQualityScore: number;
  penaltyScore: number;
  roughTier: DemoRoughTier;
  relevanceSignals: string[];
  narrativeSignals: string[];
  specificitySignals: string[];
  penaltySignals: string[];
  roughReason: string;
  contentRole: DemoContentRole;
  selectionScore: number;
  hardFiltered: boolean;
  relevanceHits: number;
  informationSignalScore: number;
  adviceSignalScore: number;
}

export interface CandidateSelectionContext {
  originalQuery: string;
  userCoreQuestion?: string;
  focusTags?: string[];
  topicSignals?: string[];
  searchQueries?: DemoSearchQueryPlan[];
}

interface QualitySelection {
  items: SearchItem[];
  candidateQuality: DemoCandidateQuality[];
  assessments: CandidateAssessment[];
}

export const MIN_EFFECTIVE_CANDIDATES = 8;
export const TARGET_EFFECTIVE_CANDIDATES = 10;
export const MAX_REFILL_ROUNDS = 1;
export const MAX_RERANK_CANDIDATES = 20;
export const MIN_RERANK_CANDIDATES = 15;

const MIN_EVIDENCE_CONTENT_LENGTH = 30;
const STRONG_EVIDENCE_CONTENT_LENGTH = 220;

const NARRATIVE_MARKERS = [
  "我",
  "本人",
  "亲身经历",
  "当时",
  "后来",
  "一开始",
  "最后",
  "经历过",
  "尝试过",
  "踩过坑",
  "后悔",
  "失败",
  "转折",
  "决定",
  "结果",
  "代价",
  "花了多久"
];

const SPECIFICITY_MARKERS = [
  "时间",
  "地点",
  "人物",
  "角色",
  "动作",
  "选择",
  "结果",
  "代价",
  "转折",
  "数字",
  "阶段",
  "成本",
  "原因",
  "过程",
  "变化"
];

const ACTION_MARKERS = ["开始", "停止", "尝试", "决定", "选择", "放弃", "坚持", "沟通", "准备", "申请"];
const RESULT_MARKERS = ["结果", "最后", "后来", "发现", "导致", "影响", "换来", "变成"];
const ROLE_MARKERS = ["我", "本人", "朋友", "父母", "家人", "同事", "老板", "同学", "老师", "伴侣"];
const STAGE_MARKERS = ["一开始", "后来", "之后", "前期", "中期", "阶段", "当时"];
const VAGUE_WORDS = ["人生", "选择", "成长", "努力", "心态", "热爱", "坚持", "焦虑", "迷茫", "未来"];
const ADVICE_MARKERS = ["建议", "应该", "最好", "可以", "不要", "方法", "策略", "技巧", "心态"];
const CLICKBAIT_MARKERS = ["震惊", "必看", "后悔死", "稳赚", "躺赚", "秘籍", "速成", "真相"];
const AD_MARKERS = ["课程", "私信", "加微信", "报名", "咨询", "训练营", "返利", "带货", "推广"];
const STOP_TOPIC_SIGNALS = new Set([
  "用户",
  "问题",
  "公开内容",
  "真实经历",
  "相关",
  "召回",
  "怎么",
  "怎么办",
  "要不要",
  "是否",
  "如何"
]);

export function selectQualitySearchItems(
  query: string,
  items: SearchItem[],
  maxCount: number,
  context: Partial<CandidateSelectionContext> = {}
): QualitySelection {
  const assessments = assessSearchCandidates(
    {
      originalQuery: query,
      ...context
    },
    items
  );
  const selected = selectRuleFallbackAssessments(assessments, Math.max(1, maxCount));
  const selectedIds = new Set(selected.map((assessment) => assessment.candidateId));

  return {
    items: selected.map((assessment) => attachAssessmentMetadata(assessment.item, assessment)),
    candidateQuality: assessments.map((assessment) =>
      toCandidateQualityDebug(assessment, selectedIds.has(assessment.candidateId))
    ),
    assessments
  };
}

export function assessSearchCandidates(
  context: CandidateSelectionContext,
  items: SearchItem[]
): CandidateAssessment[] {
  const topicSignals = buildDynamicTopicSignals(context);
  return items.map((item) => scoreSearchCandidate(context.originalQuery, item, {
    ...context,
    topicSignals
  }));
}

export function scoreSearchCandidate(
  query: string,
  item: SearchItem,
  context: Partial<CandidateSelectionContext> = {}
): CandidateAssessment {
  const title = normalizeText(item.title);
  const body = normalizeText(item.text || item.evidence.text);
  const author = normalizeText(item.author.name) || "知乎用户";
  const contentLength = body.length;
  const matchedQueries = normalizeMatchedQueries(item);
  const topicSignals = buildDynamicTopicSignals({
    originalQuery: query,
    ...context
  });
  const textForScoring = [title, body, author, ...matchedQueries.flatMap((entry) => [entry.query, entry.purpose ?? ""])]
    .join("\n")
    .toLowerCase();
  const topicAssessment = scoreTopicHit(textForScoring, topicSignals);
  const narrative = scoreNarrative(body);
  const specificity = scoreSpecificity(body);
  const basicQuality = scoreBasicQuality(item, body);
  const penalty = scorePenalty({
    title,
    body,
    topicHitScore: topicAssessment.score,
    contentLength,
    matchedQueryCount: matchedQueries.length
  });
  const roughScore = clampPercent(
    topicAssessment.score + narrative.score + specificity.score + basicQuality.score - penalty.score
  );
  const roughTier = toRoughTier(roughScore);
  const hardFiltered = !item.url && !item.id;
  const relevanceScore = clamp01(topicAssessment.score / 35);
  const experienceSignalScore = clamp01(narrative.score / 25);
  const qualityScore = clamp01((narrative.score + specificity.score + basicQuality.score - penalty.score) / 65);
  const adviceSignalScore = markerScore(body, ADVICE_MARKERS, 5);
  const selectionScore = clamp01(
    roughScore / 100 +
      (roughTier === "strong" ? 0.08 : 0) +
      Math.min(matchedQueries.length, 4) * 0.02
  );
  const filterReason = buildFilterReason({
    hardFiltered,
    contentLength,
    roughScore,
    roughTier,
    topicHitScore: topicAssessment.score,
    penaltyScore: penalty.score
  });

  return {
    item,
    candidateId: item.id,
    title: title || "未命名知乎内容",
    author,
    summary: truncateText(body || title, 220),
    matchedQuery: matchedQueries[0]?.query ?? item.matchedQuery,
    matchedQueries: matchedQueries.map(toMatchedQueryDebug),
    queryType: readSearchQueryType(matchedQueries[0]?.type ?? item.queryType),
    queryPurpose: matchedQueries[0]?.purpose ?? item.queryPurpose,
    relevanceScore,
    qualityScore,
    experienceSignalScore,
    contentLength,
    filterReason,
    usedAsEvidence: false,
    roughScore,
    topicHitScore: topicAssessment.score,
    narrativeScore: narrative.score,
    specificityScore: specificity.score,
    basicQualityScore: basicQuality.score,
    penaltyScore: penalty.score,
    roughTier,
    relevanceSignals: topicAssessment.signals,
    narrativeSignals: narrative.signals,
    specificitySignals: specificity.signals,
    penaltySignals: penalty.signals,
    roughReason: buildRoughReason({
      roughScore,
      roughTier,
      relevanceSignals: topicAssessment.signals,
      narrativeSignals: narrative.signals,
      specificitySignals: specificity.signals,
      penaltySignals: penalty.signals
    }),
    contentRole: inferContentRole(matchedQueries[0]?.type ?? item.queryType, narrative.score),
    selectionScore,
    hardFiltered,
    relevanceHits: topicAssessment.hitCount,
    informationSignalScore: clamp01((specificity.score + basicQuality.score) / 40),
    adviceSignalScore
  };
}

export function selectRerankCandidateAssessments(
  assessments: CandidateAssessment[]
): CandidateAssessment[] {
  const usablePool = assessments
    .filter((assessment) => assessment.roughTier === "strong" || assessment.roughTier === "usable")
    .sort(compareAssessments);
  const backupPool = assessments
    .filter((assessment) => assessment.roughTier === "backup")
    .sort(compareAssessments);
  const result = [...usablePool, ...backupPool].slice(0, MAX_RERANK_CANDIDATES);

  if (result.length >= MIN_RERANK_CANDIDATES) {
    return result;
  }

  return result.slice(0, MAX_RERANK_CANDIDATES);
}

export function selectRuleFallbackAssessments(
  assessments: CandidateAssessment[],
  targetCount = TARGET_EFFECTIVE_CANDIDATES
): CandidateAssessment[] {
  const pool = assessments
    .filter((assessment) => !assessment.hardFiltered && assessment.roughTier !== "drop")
    .sort(compareAssessments);
  const diverse = selectDiverseByQueryType(pool, targetCount);

  if (diverse.length >= Math.min(targetCount, pool.length)) {
    return diverse;
  }

  const selectedIds = new Set(diverse.map((assessment) => assessment.candidateId));
  return [
    ...diverse,
    ...pool.filter((assessment) => !selectedIds.has(assessment.candidateId))
  ].slice(0, targetCount);
}

export function buildRoughTierDistribution(
  assessments: CandidateAssessment[]
): DemoRoughTierDistribution {
  return assessments.reduce<DemoRoughTierDistribution>(
    (distribution, assessment) => {
      distribution[assessment.roughTier] += 1;
      return distribution;
    },
    {
      strong: 0,
      usable: 0,
      backup: 0,
      drop: 0
    }
  );
}

export function toCandidateQualityDebug(
  assessment: CandidateAssessment,
  usedAsEvidence: boolean
): DemoCandidateQuality {
  return {
    candidateId: assessment.candidateId,
    sourceRefId: assessment.sourceRefId,
    title: assessment.title,
    matchedQuery: assessment.matchedQuery,
    matchedQueries: assessment.matchedQueries,
    queryType: assessment.queryType,
    queryPurpose: assessment.queryPurpose,
    relevanceScore: assessment.relevanceScore,
    qualityScore: assessment.qualityScore,
    experienceSignalScore: assessment.experienceSignalScore,
    contentLength: assessment.contentLength,
    filterReason: usedAsEvidence
      ? `used_as_core_evidence: ${assessment.filterReason}`
      : assessment.filterReason,
    usedAsEvidence,
    roughScore: assessment.roughScore,
    topicHitScore: assessment.topicHitScore,
    narrativeScore: assessment.narrativeScore,
    specificityScore: assessment.specificityScore,
    basicQualityScore: assessment.basicQualityScore,
    penaltyScore: assessment.penaltyScore,
    roughTier: assessment.roughTier,
    relevanceSignals: assessment.relevanceSignals,
    narrativeSignals: assessment.narrativeSignals,
    specificitySignals: assessment.specificitySignals,
    penaltySignals: assessment.penaltySignals,
    roughReason: assessment.roughReason,
    contentRole: assessment.contentRole,
    relationToUserIntent: assessment.relationToUserIntent,
    summaryAngle: assessment.summaryAngle,
    diversityKey: assessment.diversityKey,
    keepReason: assessment.keepReason,
    dropReason: assessment.dropReason
  };
}

export function attachAssessmentMetadata(
  item: SearchItem,
  assessment: Pick<
    CandidateAssessment,
    | "roughScore"
    | "relevanceScore"
    | "contentRole"
    | "relationToUserIntent"
    | "summaryAngle"
    | "diversityKey"
    | "keepReason"
  >
): SearchItem {
  return {
    ...item,
    roughScore: assessment.roughScore,
    relevanceScore: assessment.relevanceScore,
    contentRole: assessment.contentRole,
    relationToUserIntent: assessment.relationToUserIntent,
    summaryAngle: assessment.summaryAngle,
    diversityKey: assessment.diversityKey,
    keepReason: assessment.keepReason
  };
}

export function buildDynamicTopicSignals(context: Partial<CandidateSelectionContext>): string[] {
  const querySignals = [context.originalQuery, context.userCoreQuestion]
    .filter((value): value is string => Boolean(value))
    .flatMap(splitSignalText);
  const focusSignals = (context.focusTags ?? []).flatMap(splitSignalText);
  const planSignals = (context.searchQueries ?? []).flatMap((plan) => splitSignalText(plan.query));
  const providedSignals = (context.topicSignals ?? []).flatMap(splitSignalText);

  return unique([...providedSignals, ...focusSignals, ...querySignals, ...planSignals])
    .map(normalizeSignal)
    .filter(isTopicSignal)
    .slice(0, 12);
}

function scoreTopicHit(text: string, topicSignals: string[]): {
  score: number;
  signals: string[];
  hitCount: number;
} {
  const weightedSignals = topicSignals.map((signal, index) => ({
    signal,
    weight: index < 4 ? 1.35 : index < 8 ? 1.1 : 0.9
  }));
  const hits = weightedSignals.filter((item) => includesLoose(text, item.signal));
  const weightedHitScore = hits.reduce((total, item) => total + item.weight, 0);
  const coverage = topicSignals.length === 0 ? 0.45 : weightedHitScore / Math.max(topicSignals.length, 4);
  const score = clampPercent(Math.round(Math.min(1, coverage) * 35));

  return {
    score,
    signals: hits.map((item) => item.signal).slice(0, 8),
    hitCount: hits.length
  };
}

function scoreNarrative(body: string): { score: number; signals: string[] } {
  const signals = NARRATIVE_MARKERS.filter((marker) => includesLoose(body, marker));
  const firstPersonBoost = /我|本人|自己/.test(body) ? 4 : 0;
  const sequenceBoost = signals.some((signal) => ["当时", "后来", "一开始", "最后"].includes(signal))
    ? 3
    : 0;
  const score = clampPercent(Math.round(Math.min(1, signals.length / 8) * 18 + firstPersonBoost + sequenceBoost));

  return {
    score: Math.min(score, 25),
    signals: signals.slice(0, 8)
  };
}

function scoreSpecificity(body: string): { score: number; signals: string[] } {
  const signals = new Set<string>();
  for (const marker of SPECIFICITY_MARKERS) {
    if (includesLoose(body, marker)) signals.add(marker);
  }
  if (/\d|[一二三四五六七八九十]+[年月天周]|个月/.test(body)) signals.add("时间/数字");
  if (/城市|地方|学校|公司|地区|县|省|国|家/.test(body)) signals.add("地点");
  if (ROLE_MARKERS.some((marker) => includesLoose(body, marker))) signals.add("人物/角色");
  if (ACTION_MARKERS.some((marker) => includesLoose(body, marker))) signals.add("动作");
  if (RESULT_MARKERS.some((marker) => includesLoose(body, marker))) signals.add("结果");
  if (STAGE_MARKERS.some((marker) => includesLoose(body, marker))) signals.add("阶段变化");

  return {
    score: clampPercent(Math.round(Math.min(1, signals.size / 7) * 20)),
    signals: Array.from(signals).slice(0, 8)
  };
}

function scoreBasicQuality(item: SearchItem, body: string): { score: number; signals: string[] } {
  const signals: string[] = [];
  let score = 0;

  if (normalizeText(item.title)) {
    score += 4;
    signals.push("title");
  }

  if (body.length >= MIN_EVIDENCE_CONTENT_LENGTH) {
    score += 5;
    signals.push("contentSnippet");
  }

  if (body.length >= STRONG_EVIDENCE_CONTENT_LENGTH) {
    score += 3;
    signals.push("contentLength");
  }

  if (normalizeText(item.author.name)) {
    score += 3;
    signals.push("author");
  }

  if (item.url || item.source.url) {
    score += 3;
    signals.push("sourceUrl");
  }

  if (normalizeText(item.evidence.text)) {
    score += 2;
    signals.push("sourceRefs");
  }

  return {
    score: Math.min(score, 20),
    signals
  };
}

function scorePenalty(input: {
  title: string;
  body: string;
  topicHitScore: number;
  contentLength: number;
  matchedQueryCount: number;
}): { score: number; signals: string[] } {
  const signals: string[] = [];
  let score = 0;

  if (input.contentLength < MIN_EVIDENCE_CONTENT_LENGTH) {
    score += 18;
    signals.push("内容极短");
  }

  if (CLICKBAIT_MARKERS.some((marker) => includesLoose(input.title, marker))) {
    score += 10;
    signals.push("标题党");
  }

  if (AD_MARKERS.some((marker) => includesLoose(input.body, marker))) {
    score += 14;
    signals.push("广告营销");
  }

  const vagueHits = VAGUE_WORDS.filter((word) => includesLoose(input.body, word)).length;
  if (vagueHits >= 3 && input.topicHitScore < 12) {
    score += 10;
    signals.push("只命中空泛词");
  }

  if (markerScore(input.body, ADVICE_MARKERS, 5) > 0.48 && markerScore(input.body, NARRATIVE_MARKERS, 8) < 0.25) {
    score += 8;
    signals.push("泛泛观点/建议");
  }

  if (input.topicHitScore < 6 && input.matchedQueryCount <= 1) {
    score += 12;
    signals.push("弱相关");
  }

  return {
    score: Math.min(score, 35),
    signals
  };
}

function buildFilterReason(input: {
  hardFiltered: boolean;
  contentLength: number;
  roughScore: number;
  roughTier: DemoRoughTier;
  topicHitScore: number;
  penaltyScore: number;
}): string {
  if (input.hardFiltered) {
    return "excluded: missing stable item id and source url";
  }

  if (input.contentLength < MIN_EVIDENCE_CONTENT_LENGTH) {
    return `downranked: contentLength=${input.contentLength} is too short for core evidence`;
  }

  if (input.roughTier === "drop") {
    return `downranked: roughScore=${input.roughScore} below backup threshold`;
  }

  if (input.topicHitScore < 10) {
    return "downranked: weak dynamic topic signal coverage";
  }

  if (input.penaltyScore >= 14) {
    return "downranked: generic quality penalties outweighed content signals";
  }

  if (input.roughTier === "strong") {
    return "ranked_high: dynamic topic, narrative, specificity, and source quality signals found";
  }

  return `ranked_${input.roughTier}: usable public-content evidence with traceable signals`;
}

function buildRoughReason(input: {
  roughScore: number;
  roughTier: DemoRoughTier;
  relevanceSignals: string[];
  narrativeSignals: string[];
  specificitySignals: string[];
  penaltySignals: string[];
}): string {
  const positives = [
    input.relevanceSignals.length ? `topic=${input.relevanceSignals.slice(0, 4).join("/")}` : "",
    input.narrativeSignals.length ? `narrative=${input.narrativeSignals.slice(0, 3).join("/")}` : "",
    input.specificitySignals.length ? `specific=${input.specificitySignals.slice(0, 3).join("/")}` : ""
  ].filter(Boolean);
  const penalties = input.penaltySignals.length
    ? ` penalty=${input.penaltySignals.slice(0, 3).join("/")}`
    : "";

  return `roughTier=${input.roughTier} roughScore=${input.roughScore}; ${positives.join("; ")}${penalties}`.trim();
}

function selectDiverseByQueryType(
  pool: CandidateAssessment[],
  targetCount: number
): CandidateAssessment[] {
  const selected: CandidateAssessment[] = [];
  const perTypeCount = new Map<string, number>();
  const firstPassLimit = Math.max(2, Math.ceil(targetCount / 3));

  for (const assessment of pool) {
    const key = assessment.queryType ?? "unknown";
    if ((perTypeCount.get(key) ?? 0) >= firstPassLimit) {
      continue;
    }

    selected.push(assessment);
    perTypeCount.set(key, (perTypeCount.get(key) ?? 0) + 1);
    if (selected.length >= targetCount) {
      return selected;
    }
  }

  const selectedIds = new Set(selected.map((assessment) => assessment.candidateId));
  for (const assessment of pool) {
    if (selectedIds.has(assessment.candidateId)) {
      continue;
    }

    selected.push(assessment);
    if (selected.length >= targetCount) {
      break;
    }
  }

  return selected;
}

function compareAssessments(left: CandidateAssessment, right: CandidateAssessment): number {
  return (
    right.roughScore - left.roughScore ||
    right.selectionScore - left.selectionScore ||
    right.experienceSignalScore - left.experienceSignalScore ||
    right.qualityScore - left.qualityScore ||
    right.contentLength - left.contentLength
  );
}

function normalizeMatchedQueries(item: SearchItem): SearchMatchedQuery[] {
  const entries = [
    ...(item.matchedQueries ?? []),
    item.matchedQuery
      ? {
          query: item.matchedQuery,
          type: item.queryType,
          purpose: item.queryPurpose
        }
      : undefined
  ].filter((entry): entry is SearchMatchedQuery => Boolean(entry?.query));

  const seen = new Set<string>();
  const result: SearchMatchedQuery[] = [];
  for (const entry of entries) {
    const key = normalizeText(entry.query).toLowerCase();
    if (!key || seen.has(key)) {
      continue;
    }

    seen.add(key);
    result.push({
      query: entry.query,
      type: entry.type,
      purpose: entry.purpose
    });
  }

  return result;
}

function toMatchedQueryDebug(entry: SearchMatchedQuery): DemoMatchedQueryDebug {
  return {
    query: entry.query,
    type: readSearchQueryType(entry.type),
    purpose: entry.purpose
  };
}

function inferContentRole(value: unknown, narrativeScore: number): DemoContentRole {
  const queryType = readSearchQueryType(value);
  if (queryType && queryType !== "original") {
    return queryType;
  }

  return narrativeScore >= 10 ? "real_experience" : "viewpoint";
}

function toRoughTier(score: number): DemoRoughTier {
  if (score >= 70) return "strong";
  if (score >= 55) return "usable";
  if (score >= 40) return "backup";
  return "drop";
}

function splitSignalText(value: string): string[] {
  const normalized = normalizeSignal(value);
  if (!normalized) {
    return [];
  }

  const parts = normalized
    .split(/[，。！？、,.!?\s/|:：；;（）()《》"“”]+/)
    .map(normalizeSignal)
    .filter(Boolean);

  return unique([normalized, ...parts]);
}

function normalizeSignal(value: string): string {
  return normalizeDemoQuery(value)
    .replace(/^关于/, "")
    .replace(/(真实经历|公开经验|相关|怎么办|怎么选|怎么开始|有哪些路径|还有什么选择|后来怎么样)$/g, "")
    .trim();
}

function isTopicSignal(value: string): boolean {
  return (
    value.length >= 2 &&
    value.length <= 12 &&
    !STOP_TOPIC_SIGNALS.has(value) &&
    !/^(召回|保留用户|基于|当前选择|行动代价|替代路径)/.test(value)
  );
}

function markerScore(text: string, markers: string[], maxHits: number): number {
  const hits = markers.reduce((total, marker) => total + (includesLoose(text, marker) ? 1 : 0), 0);
  return clamp01(hits / maxHits);
}

function includesLoose(text: string, keyword: string): boolean {
  if (!keyword) {
    return false;
  }

  return text.toLowerCase().includes(keyword.toLowerCase()) || text.includes(keyword);
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

function readSearchQueryType(value: unknown): DemoSearchQueryType | undefined {
  if (
    value === "original" ||
    value === "real_experience" ||
    value === "life_path" ||
    value === "failure_review" ||
    value === "decision_conflict" ||
    value === "alternative_solution"
  ) {
    return value;
  }

  return undefined;
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }

  return Math.min(Math.max(Number(value.toFixed(2)), 0), 1);
}

function clampPercent(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }

  return Math.min(Math.max(Math.round(value), 0), 100);
}

function unique<T>(values: T[]): T[] {
  return Array.from(new Set(values.filter(Boolean)));
}
