import type { SearchItem } from "../types/api.types.js";
import type { DemoCandidateQuality } from "../types/demo.types.js";
import { normalizeDemoQuery } from "./demoQueryIdentity.service.js";

export interface CandidateAssessment extends DemoCandidateQuality {
  item: SearchItem;
  selectionScore: number;
  hardFiltered: boolean;
  relevanceHits: number;
  informationSignalScore: number;
  adviceSignalScore: number;
}

interface QualitySelection {
  items: SearchItem[];
  candidateQuality: DemoCandidateQuality[];
}

const MIN_EVIDENCE_CONTENT_LENGTH = 30;
const STRONG_EVIDENCE_CONTENT_LENGTH = 220;
const GOOD_SELECTION_SCORE = 0.42;

const QUERY_KEYWORDS = [
  "异地恋",
  "异地",
  "恋爱",
  "感情",
  "伴侣",
  "对象",
  "工作",
  "职业",
  "岗位",
  "转行",
  "转岗",
  "35岁",
  "年龄",
  "不工作",
  "不上班",
  "裸辞",
  "失业",
  "离职",
  "待业",
  "去哪",
  "哪里",
  "城市",
  "现金流",
  "存款",
  "收入",
  "风险",
  "家庭",
  "选择",
  "值得"
];

const FIRST_PERSON_MARKERS = ["我", "本人", "我的", "我们", "自己", "家里", "当时我", "我在"];
const TIMELINE_MARKERS = [
  "后来",
  "当时",
  "之前",
  "之后",
  "那年",
  "去年",
  "今年",
  "半年",
  "一年",
  "两年",
  "三年",
  "个月",
  "周",
  "天",
  "阶段",
  "期间"
];
const DECISION_MARKERS = [
  "决定",
  "选择",
  "取舍",
  "辞职",
  "离职",
  "转行",
  "搬",
  "去了",
  "留下",
  "放弃",
  "接受",
  "尝试",
  "试了",
  "面试",
  "复盘"
];
const RESULT_MARKERS = [
  "结果",
  "发现",
  "最后",
  "现在",
  "回来",
  "稳定",
  "分手",
  "结婚",
  "成功",
  "失败",
  "后悔",
  "不后悔",
  "撑了",
  "收入",
  "存款"
];
const INFORMATION_MARKERS = [
  "时间",
  "成本",
  "预算",
  "存款",
  "收入",
  "房租",
  "城市",
  "公司",
  "岗位",
  "行业",
  "项目",
  "面试",
  "家人",
  "社保",
  "医保",
  "见面",
  "频率",
  "周期",
  "结果",
  "原因",
  "过程"
];
const ADVICE_MARKERS = [
  "建议",
  "应该",
  "必须",
  "最好",
  "可以",
  "不要",
  "方法",
  "策略",
  "出路",
  "鸡汤",
  "心态",
  "努力",
  "坚持",
  "热爱",
  "焦虑",
  "迷茫"
];

const QUERY_EXPANSIONS = [
  {
    triggers: ["不工作", "不上班", "裸辞", "失业", "离职", "待业", "去哪", "哪里"],
    tokens: ["裸辞", "离职", "休整", "低成本", "现金流", "存款", "面试", "项目"]
  },
  {
    triggers: ["异地恋", "异地", "远距离", "恋爱", "为了工作"],
    tokens: ["异地", "伴侣", "见面", "期限", "同城", "城市", "沟通", "关系"]
  },
  {
    triggers: ["转行", "转岗", "35岁", "三十五", "来得及"],
    tokens: ["转行", "项目", "作品", "面试", "行业", "经验", "技能", "薪资"]
  }
];

export function selectQualitySearchItems(
  query: string,
  items: SearchItem[],
  maxCount: number
): QualitySelection {
  const assessments = items.map((item) => scoreSearchCandidate(query, item));
  const eligible = assessments.filter((assessment) => isCoreEvidenceCandidate(assessment));
  const fallbackPool = assessments.filter((assessment) => isFallbackEvidenceCandidate(assessment));
  const selected = (eligible.length > 0 ? eligible : fallbackPool)
    .sort(compareAssessments)
    .slice(0, Math.max(1, maxCount));
  const selectedIds = new Set(selected.map((assessment) => assessment.candidateId));

  return {
    items: selected.map((assessment) => assessment.item),
    candidateQuality: assessments.map((assessment) =>
      toCandidateQualityDebug(assessment, selectedIds.has(assessment.candidateId))
    )
  };
}

export function scoreSearchCandidate(query: string, item: SearchItem): CandidateAssessment {
  const title = normalizeText(item.title);
  const body = normalizeText(item.text || item.evidence.text);
  const textForRelevance = `${title}\n${body}`;
  const contentLength = body.length;
  const queryTokens = extractQueryTokens(query);
  const relevanceHits = queryTokens.reduce(
    (total, keyword) => total + countKeywordHits(textForRelevance, keyword),
    0
  );
  const relevanceScore = clampScore(
    queryTokens.length === 0 ? 0.5 : 0.34 + relevanceHits / Math.min(queryTokens.length + 2, 8)
  );
  const lengthScore = clampScore(contentLength / STRONG_EVIDENCE_CONTENT_LENGTH);
  const firstPersonScore = markerScore(body, FIRST_PERSON_MARKERS, 3);
  const timelineScore = markerScore(body, TIMELINE_MARKERS, 3);
  const decisionScore = markerScore(body, DECISION_MARKERS, 3);
  const resultScore = markerScore(body, RESULT_MARKERS, 3);
  const informationSignalScore = clampScore(
    markerScore(body, INFORMATION_MARKERS, 6) + (/\d|[一二三四五六七八九十]+[年月天周]/.test(body) ? 0.18 : 0)
  );
  const experienceSignalScore = clampScore(
    firstPersonScore * 0.34 + timelineScore * 0.22 + decisionScore * 0.24 + resultScore * 0.2
  );
  const adviceSignalScore = markerScore(body, ADVICE_MARKERS, 5);
  const lowExperienceAdvicePenalty =
    adviceSignalScore > 0.36 && experienceSignalScore < 0.35 ? 0.18 : 0;
  const lowInformationPenalty = informationSignalScore < 0.22 ? 0.14 : 0;
  const qualityScore = clampScore(
    lengthScore * 0.28 +
      informationSignalScore * 0.27 +
      experienceSignalScore * 0.34 +
      relevanceScore * 0.11 -
      lowExperienceAdvicePenalty -
      lowInformationPenalty
  );
  const hardFiltered = !item.url && !item.id;
  const selectionScore = clampScore(
    relevanceScore * 0.34 + qualityScore * 0.38 + experienceSignalScore * 0.28
  );

  return {
    item,
    candidateId: item.id,
    title: title || "未命名知乎内容",
    relevanceScore,
    qualityScore,
    experienceSignalScore,
    contentLength,
    filterReason: buildFilterReason({
      hardFiltered,
      contentLength,
      relevanceScore,
      qualityScore,
      experienceSignalScore,
      informationSignalScore,
      adviceSignalScore,
      selectionScore
    }),
    usedAsEvidence: false,
    selectionScore,
    hardFiltered,
    relevanceHits,
    informationSignalScore,
    adviceSignalScore
  };
}

function isCoreEvidenceCandidate(assessment: CandidateAssessment): boolean {
  if (assessment.hardFiltered) {
    return false;
  }

  if (assessment.contentLength < MIN_EVIDENCE_CONTENT_LENGTH) {
    return false;
  }

  if (assessment.selectionScore < GOOD_SELECTION_SCORE) {
    return false;
  }

  if (
    assessment.qualityScore < 0.36 &&
    assessment.experienceSignalScore < 0.28 &&
    assessment.contentLength < 100
  ) {
    return false;
  }

  return true;
}

function isFallbackEvidenceCandidate(assessment: CandidateAssessment): boolean {
  if (assessment.hardFiltered || assessment.contentLength < MIN_EVIDENCE_CONTENT_LENGTH) {
    return false;
  }

  if (assessment.relevanceScore < 0.45 || assessment.qualityScore < 0.32) {
    return false;
  }

  if (assessment.adviceSignalScore > 0.36 && assessment.experienceSignalScore < 0.35) {
    return false;
  }

  return true;
}

function compareAssessments(left: CandidateAssessment, right: CandidateAssessment): number {
  return (
    right.selectionScore - left.selectionScore ||
    right.experienceSignalScore - left.experienceSignalScore ||
    right.qualityScore - left.qualityScore ||
    right.contentLength - left.contentLength
  );
}

function toCandidateQualityDebug(
  assessment: CandidateAssessment,
  usedAsEvidence: boolean
): DemoCandidateQuality {
  return {
    candidateId: assessment.candidateId,
    sourceRefId: assessment.sourceRefId,
    title: assessment.title,
    relevanceScore: assessment.relevanceScore,
    qualityScore: assessment.qualityScore,
    experienceSignalScore: assessment.experienceSignalScore,
    contentLength: assessment.contentLength,
    filterReason: usedAsEvidence
      ? `used_as_core_evidence: ${assessment.filterReason}`
      : assessment.filterReason,
    usedAsEvidence
  };
}

function buildFilterReason(input: {
  hardFiltered: boolean;
  contentLength: number;
  relevanceScore: number;
  qualityScore: number;
  experienceSignalScore: number;
  informationSignalScore: number;
  adviceSignalScore: number;
  selectionScore: number;
}): string {
  if (input.hardFiltered) {
    return "excluded: missing stable item id and source url";
  }

  if (input.contentLength < MIN_EVIDENCE_CONTENT_LENGTH) {
    return `downranked: contentLength=${input.contentLength} is too short for core evidence`;
  }

  if (input.relevanceScore < 0.45) {
    return "downranked: weak relevance to the query";
  }

  if (input.informationSignalScore < 0.22) {
    return "downranked: low information density";
  }

  if (input.adviceSignalScore > 0.36 && input.experienceSignalScore < 0.35) {
    return "downranked: advice/viewpoint-heavy with weak personal experience signals";
  }

  if (input.experienceSignalScore < 0.28) {
    return "downranked: lacks first-person timeline, decision, or result signals";
  }

  if (input.qualityScore >= 0.62 && input.experienceSignalScore >= 0.42) {
    return "ranked_high: concrete experience, decision process, and outcome signals found";
  }

  if (input.selectionScore >= GOOD_SELECTION_SCORE) {
    return "ranked: usable public-content evidence with traceable signals";
  }

  return "downranked: overall candidate quality below core evidence threshold";
}

function extractQueryTokens(query: string): string[] {
  const normalizedQuery = normalizeDemoQuery(query);
  const directTokens = normalizedQuery
    .split(/[，。！？、,.!?\s]+/)
    .map((token) => token.trim())
    .filter((token) => token.length >= 2 && token.length <= 12);
  const keywordTokens = QUERY_KEYWORDS.filter((keyword) => normalizedQuery.includes(keyword));
  const expandedTokens = QUERY_EXPANSIONS.filter((group) =>
    group.triggers.some((trigger) => normalizedQuery.includes(trigger))
  ).flatMap((group) => group.tokens);

  return unique([...directTokens, ...keywordTokens, ...expandedTokens]);
}

function markerScore(text: string, markers: string[], maxHits: number): number {
  const hits = markers.reduce((total, marker) => total + countKeywordHits(text, marker), 0);
  return clampScore(hits / maxHits);
}

function countKeywordHits(text: string, keyword: string): number {
  if (!keyword) {
    return 0;
  }

  return text.toLowerCase().includes(keyword.toLowerCase()) || text.includes(keyword) ? 1 : 0;
}

function normalizeText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function unique<T>(values: T[]): T[] {
  return Array.from(new Set(values.filter(Boolean)));
}

function clampScore(value: number): number {
  return Math.min(Math.max(Number(value.toFixed(2)), 0), 1);
}
