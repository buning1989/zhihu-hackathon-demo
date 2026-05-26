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
const RELATIONSHIP_WORK_CONTEXT_MARKERS = [
  "异地恋",
  "长期异地",
  "恋爱",
  "伴侣",
  "距离",
  "城市",
  "工作",
  "职业",
  "事业",
  "追求自己",
  "想做的事"
];
const RELATIONSHIP_EVIDENCE_MARKERS = [
  "异地恋",
  "长期",
  "见面",
  "城市",
  "距离",
  "伴侣",
  "男友",
  "女友",
  "恋爱",
  "团聚",
  "分开",
  "坚持",
  "未来",
  "时间表"
];
const CAREER_TRADEOFF_MARKERS = [
  "为了工作",
  "工作机会",
  "职业选择",
  "职业发展",
  "事业",
  "工作调动",
  "追求自己",
  "想做的事",
  "追求梦想",
  "梦想",
  "高薪",
  "裸辞",
  "辞掉",
  "稳定工作",
  "薪资",
  "城市选择"
];
const GENERIC_WORK_REVIEW_MARKERS = [
  "复盘",
  "效率",
  "方法",
  "目标",
  "成长",
  "管理",
  "提升",
  "曾国藩",
  "工作复盘"
];
const STABILITY_PASSION_CONTEXT_MARKERS = [
  "稳定",
  "安稳",
  "稳定工作",
  "稳定收入",
  "体制内",
  "铁饭碗",
  "放弃",
  "喜欢的事",
  "喜欢的事情",
  "热爱",
  "兴趣",
  "梦想",
  "理想",
  "想做的事",
  "追求"
];
const STABILITY_EVIDENCE_MARKERS = [
  "稳定",
  "安稳",
  "稳定工作",
  "稳定收入",
  "稳定的工作",
  "体制内",
  "铁饭碗",
  "生存问题",
  "安全感",
  "生活稳定"
];
const PASSION_EVIDENCE_MARKERS = [
  "喜欢的事",
  "喜欢的事情",
  "热爱",
  "兴趣",
  "梦想",
  "理想",
  "想做的事",
  "追求",
  "喜欢的事业",
  "不喜欢的事"
];
const TRADEOFF_EVIDENCE_MARKERS = [
  "放弃",
  "取舍",
  "要不要",
  "该不该",
  "值不值得",
  "值得吗",
  "后悔",
  "选择",
  "冲突",
  "现实",
  "一边",
  "同时"
];
const ROMANCE_DRIFT_MARKERS = [
  "喜欢的人",
  "喜欢一个人",
  "心动的人",
  "感情",
  "爱情",
  "恋爱",
  "男友",
  "女友",
  "前任",
  "分手"
];
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
  const contextText = [
    query,
    context.userCoreQuestion ?? "",
    ...(context.focusTags ?? []),
    ...(context.topicSignals ?? []),
    ...(context.searchQueries ?? []).flatMap((plan) => [plan.query, plan.purpose])
  ].join("\n");
  const scenarioText = [title, body].join("\n");
  const relationshipWork = scoreRelationshipWorkScenario(contextText, scenarioText);
  const stabilityPassion = scoreStabilityPassionScenario(contextText, scenarioText);
  const scenarioBoostScore = relationshipWork.boostScore + stabilityPassion.boostScore;
  const scenarioPenaltyScore = relationshipWork.penaltyScore + stabilityPassion.penaltyScore;
  const scenarioForceDrop = relationshipWork.forceDrop || stabilityPassion.forceDrop;
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
  const penaltyScore = Math.min(penalty.score + scenarioPenaltyScore, 65);
  const relevanceSignals = unique([
    ...topicAssessment.signals,
    ...relationshipWork.relevanceSignals,
    ...stabilityPassion.relevanceSignals
  ]);
  const penaltySignals = unique([
    ...penalty.signals,
    ...relationshipWork.penaltySignals,
    ...stabilityPassion.penaltySignals
  ]);
  const roughScore = clampPercent(
    scenarioForceDrop
      ? Math.min(
          35,
          topicAssessment.score +
            narrative.score +
            specificity.score +
            basicQuality.score +
            scenarioBoostScore -
            penaltyScore
        )
      : topicAssessment.score +
          narrative.score +
          specificity.score +
          basicQuality.score +
          scenarioBoostScore -
          penaltyScore
  );
  const roughTier = toRoughTier(roughScore);
  const hardFiltered = !item.url && !item.id;
  const relevanceScore = clamp01((topicAssessment.score + Math.min(scenarioBoostScore, 18)) / 45);
  const experienceSignalScore = clamp01(narrative.score / 25);
  const qualityScore = clamp01(
    (narrative.score + specificity.score + basicQuality.score + scenarioBoostScore - penaltyScore) / 65
  );
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
    penaltyScore,
    penaltySignals
  });
  const contentRole = inferContentRole(matchedQueries[0]?.type ?? item.queryType, narrative.score);

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
    penaltyScore,
    roughTier,
    relevanceSignals,
    narrativeSignals: narrative.signals,
    specificitySignals: specificity.signals,
    penaltySignals,
    roughReason: buildRoughReason({
      roughScore,
      roughTier,
      relevanceSignals,
      narrativeSignals: narrative.signals,
      specificitySignals: specificity.signals,
      penaltySignals
    }),
    contentRole,
    relationToUserIntent: buildRelationToUserIntent(query, relevanceSignals, contentRole),
    summaryAngle: buildSummaryAngle(relevanceSignals, narrative.signals, contentRole),
    diversityKey: buildDiversityKey(contentRole, relevanceSignals, matchedQueries, title),
    keepReason: roughTier === "drop" ? undefined : buildKeepReason(roughTier, relevanceSignals, narrative.signals),
    dropReason: roughTier === "drop" ? filterReason : undefined,
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
  const scenarioSignals = extractScenarioTopicSignals([
    context.originalQuery ?? "",
    context.userCoreQuestion ?? "",
    ...(context.focusTags ?? []),
    ...(context.topicSignals ?? []),
    ...(context.searchQueries ?? []).flatMap((plan) => [plan.query, plan.purpose])
  ].join("\n"));
  const querySignals = [context.originalQuery, context.userCoreQuestion]
    .filter((value): value is string => Boolean(value))
    .flatMap(splitSignalText);
  const focusSignals = (context.focusTags ?? []).flatMap(splitSignalText);
  const planSignals = (context.searchQueries ?? []).flatMap((plan) => splitSignalText(plan.query));
  const providedSignals = (context.topicSignals ?? []).flatMap(splitSignalText);

  return unique([...providedSignals, ...scenarioSignals, ...focusSignals, ...querySignals, ...planSignals])
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

function scoreRelationshipWorkScenario(contextText: string, candidateText: string): {
  boostScore: number;
  penaltyScore: number;
  relevanceSignals: string[];
  penaltySignals: string[];
  forceDrop: boolean;
} {
  const normalizedContext = normalizeText(contextText);
  const normalizedCandidate = normalizeText(candidateText);
  const contextHits = RELATIONSHIP_WORK_CONTEXT_MARKERS.filter((marker) =>
    includesLoose(normalizedContext, marker)
  );
  const relationshipContextHit = contextHits.some((marker) =>
    ["异地恋", "长期异地", "恋爱", "伴侣", "距离", "城市"].includes(marker)
  );
  const workContextHit = contextHits.some((marker) =>
    ["工作", "职业", "事业", "追求自己", "想做的事"].includes(marker)
  );

  if (!relationshipContextHit || !workContextHit) {
    return {
      boostScore: 0,
      penaltyScore: 0,
      relevanceSignals: [],
      penaltySignals: [],
      forceDrop: false
    };
  }

  const relationshipHits = RELATIONSHIP_EVIDENCE_MARKERS.filter((marker) =>
    includesLoose(normalizedCandidate, marker)
  );
  const strongRelationshipHits = relationshipHits.filter(
    (marker) => !["长期", "坚持", "未来", "时间表"].includes(marker)
  );
  const careerTradeoffHits = CAREER_TRADEOFF_MARKERS.filter((marker) =>
    includesLoose(normalizedCandidate, marker)
  );
  const genericWorkHits = GENERIC_WORK_REVIEW_MARKERS.filter((marker) =>
    includesLoose(normalizedCandidate, marker)
  );
  const hasScenarioEvidence = strongRelationshipHits.length > 0 || careerTradeoffHits.length > 0;
  const genericWorkOnly = genericWorkHits.length > 0 && !hasScenarioEvidence;
  const relevanceSignals = [
    ...(relationshipHits.length ? ["relationship_work_topic_boost"] : []),
    ...relationshipHits.slice(0, 4),
    ...careerTradeoffHits.slice(0, 4)
  ];
  const penaltySignals = [
    ...(!hasScenarioEvidence ? ["relationship_work_missing_relationship_or_career_signal"] : []),
    ...(genericWorkOnly ? ["relationship_work_generic_work_penalty"] : []),
    ...genericWorkHits.slice(0, 4)
  ];
  const boostScore = Math.min(
    24,
    strongRelationshipHits.length * 7 +
      (relationshipHits.length - strongRelationshipHits.length) * 2 +
      careerTradeoffHits.length * 5
  );
  const penaltyScore = (hasScenarioEvidence ? 0 : 22) + (genericWorkOnly ? 18 : 0);

  return {
    boostScore,
    penaltyScore,
    relevanceSignals,
    penaltySignals,
    forceDrop: !hasScenarioEvidence
  };
}

function scoreStabilityPassionScenario(contextText: string, candidateText: string): {
  boostScore: number;
  penaltyScore: number;
  relevanceSignals: string[];
  penaltySignals: string[];
  forceDrop: boolean;
} {
  const normalizedContext = normalizeText(contextText);
  const normalizedCandidate = normalizeText(candidateText);
  const contextHits = STABILITY_PASSION_CONTEXT_MARKERS.filter((marker) =>
    includesLoose(normalizedContext, marker)
  );
  const stabilityContextHit = contextHits.some((marker) =>
    ["稳定", "安稳", "稳定工作", "稳定收入", "体制内", "铁饭碗"].includes(marker)
  );
  const passionContextHit = contextHits.some((marker) =>
    ["喜欢的事", "喜欢的事情", "热爱", "兴趣", "梦想", "理想", "想做的事", "追求", "喜欢"].includes(marker)
  );

  if (!stabilityContextHit || !passionContextHit) {
    return {
      boostScore: 0,
      penaltyScore: 0,
      relevanceSignals: [],
      penaltySignals: [],
      forceDrop: false
    };
  }

  const stabilityHits = STABILITY_EVIDENCE_MARKERS.filter((marker) =>
    includesLoose(normalizedCandidate, marker)
  );
  const passionHits = PASSION_EVIDENCE_MARKERS.filter((marker) =>
    includesLoose(normalizedCandidate, marker)
  );
  const tradeoffHits = TRADEOFF_EVIDENCE_MARKERS.filter((marker) =>
    includesLoose(normalizedCandidate, marker)
  );
  const romanceHits = ROMANCE_DRIFT_MARKERS.filter((marker) =>
    includesLoose(normalizedCandidate, marker)
  );
  const hasScenarioEvidence = stabilityHits.length > 0 && (passionHits.length > 0 || tradeoffHits.length > 0);
  const romanceDrift =
    romanceHits.length > 0 &&
    stabilityHits.length === 0 &&
    !/工作|事业|职业|收入|体制内|梦想|理想|兴趣|热爱|喜欢的事|喜欢的事情/.test(normalizedCandidate);
  const relevanceSignals = [
    ...(hasScenarioEvidence ? ["stability_passion_topic_boost"] : []),
    ...stabilityHits.slice(0, 4),
    ...passionHits.slice(0, 4),
    ...tradeoffHits.slice(0, 3)
  ];
  const penaltySignals = [
    ...(!hasScenarioEvidence ? ["stability_passion_missing_tradeoff_signal"] : []),
    ...(romanceDrift ? ["stability_passion_romance_drift_penalty"] : []),
    ...romanceHits.slice(0, 3)
  ];
  const boostScore = Math.min(
    26,
    stabilityHits.length * 6 +
      passionHits.length * 6 +
      tradeoffHits.length * 4
  );
  const penaltyScore = (hasScenarioEvidence ? 0 : 16) + (romanceDrift ? 18 : 0);

  return {
    boostScore,
    penaltyScore,
    relevanceSignals,
    penaltySignals,
    forceDrop: false
  };
}

function buildFilterReason(input: {
  hardFiltered: boolean;
  contentLength: number;
  roughScore: number;
  roughTier: DemoRoughTier;
  topicHitScore: number;
  penaltyScore: number;
  penaltySignals: string[];
}): string {
  if (input.hardFiltered) {
    return "excluded: missing stable item id and source url";
  }

  if (input.penaltySignals.includes("relationship_work_missing_relationship_or_career_signal")) {
    return "downranked: relationship-work query but candidate lacks relationship or career tradeoff signals";
  }

  if (input.penaltySignals.includes("relationship_work_generic_work_penalty")) {
    return "downranked: generic work-review content is weak for relationship-work query";
  }

  if (input.penaltySignals.includes("stability_passion_romance_drift_penalty")) {
    return "downranked: relationship content drifted away from the stability-vs-passion question";
  }

  if (input.penaltySignals.includes("stability_passion_missing_tradeoff_signal")) {
    return "downranked: stability-vs-passion query but candidate lacks tradeoff signals";
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

function extractScenarioTopicSignals(text: string): string[] {
  const normalized = normalizeText(text);
  const signals: string[] = [];

  if (
    /稳定|安稳|体制内|铁饭碗|稳定工作|稳定收入/.test(normalized) &&
    /喜欢|热爱|兴趣|梦想|理想|想做的事|追求/.test(normalized)
  ) {
    signals.push(
      "稳定",
      "稳定工作",
      "稳定收入",
      "放弃",
      "喜欢的事",
      "热爱",
      "兴趣",
      "梦想",
      "选择",
      "取舍",
      "后悔",
      "现实"
    );
  }

  return signals;
}

function buildRelationToUserIntent(
  query: string,
  relevanceSignals: string[],
  contentRole: DemoContentRole
): string {
  const signals = relevanceSignals.slice(0, 3).join("、") || "来源片段";
  if (contentRole === "viewpoint") {
    return `它和「${truncateText(query, 24)}」的关系主要是变量拆解，不能当作完整亲历。`;
  }

  return `它和「${truncateText(query, 24)}」的关系在于：来源里出现了${signals}等可追溯线索。`;
}

function buildSummaryAngle(
  relevanceSignals: string[],
  narrativeSignals: string[],
  contentRole: DemoContentRole
): string {
  const signal = relevanceSignals[0] || narrativeSignals[0] || "选择过程";
  if (contentRole === "failure_review") {
    return `看${signal}之后的后悔、代价或回头复盘`;
  }
  if (contentRole === "decision_conflict") {
    return `看${signal}背后的取舍和摇摆`;
  }
  if (contentRole === "alternative_solution") {
    return `看${signal}之外的替代路径`;
  }
  if (contentRole === "viewpoint") {
    return `只提炼${signal}相关观点，不包装成亲历`;
  }
  return `看${signal}里的具体经历和结果`;
}

function buildDiversityKey(
  contentRole: DemoContentRole,
  relevanceSignals: string[],
  matchedQueries: SearchMatchedQuery[],
  title: string
): string {
  return truncateText(
    relevanceSignals[0] ||
      matchedQueries[0]?.query ||
      title ||
      contentRole,
    40
  );
}

function buildKeepReason(
  roughTier: DemoRoughTier,
  relevanceSignals: string[],
  narrativeSignals: string[]
): string {
  const signals = unique([...relevanceSignals.slice(0, 2), ...narrativeSignals.slice(0, 2)]).join("、");
  return signals
    ? `保留为 ${roughTier}：来源里有${signals}等信号。`
    : `保留为 ${roughTier}：来源结构和基础证据可追溯。`;
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
