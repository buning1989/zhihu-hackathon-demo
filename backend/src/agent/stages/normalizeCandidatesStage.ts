import { createHash } from "node:crypto";
import {
  AGENT_ARTIFACT_CANDIDATES,
  type AgentStageOutput,
  type CandidateItem,
  type CandidatesArtifactData,
  type RawSourceItem,
  type RawSourcesArtifactData
} from "./stageTypes.js";

const ACCEPTED_SOURCE_TYPES = ["answer", "mock_answer"] as const;
const MAX_SELECTED_FOR_EVIDENCE = 6;
const MIN_SELECTED_QUALITY_SCORE = 0.42;
const MIN_SELECTED_RELEVANCE_SCORE = 0.28;
const MIN_SELECTED_EXPERIENCE_SCORE = 0.22;
const MIN_RANK_FALLBACK_RELEVANCE_SCORE = 0.34;
const MIN_RANK_FALLBACK_EXPERIENCE_SCORE = 0.18;
const MIN_RANK_FALLBACK_SEARCH_SCORE = 0.82;
const MIN_MEANINGFUL_CONTENT_LENGTH = 30;

const TOPIC_KEYWORDS = [
  "裸辞",
  "异地恋",
  "考研",
  "读研",
  "老家",
  "大城市",
  "不结婚",
  "结婚",
  "工作",
  "工资",
  "痛苦",
  "离职",
  "失业",
  "职业",
  "大厂",
  "创业公司",
  "北上广",
  "伴侣",
  "恋爱",
  "家庭",
  "收入",
  "存款",
  "成本",
  "风险",
  "后悔",
  "选择"
];

const EXPERIENCE_SIGNAL_GROUPS = [
  {
    label: "first_person",
    markers: ["我", "本人", "自己", "亲身", "我的", "我们"]
  },
  {
    label: "timeline",
    markers: ["当时", "后来", "之后", "一开始", "最后", "前期", "中期", "那年", "那段时间"]
  },
  {
    label: "decision_point",
    markers: ["决定", "选择", "放弃", "坚持", "犹豫", "权衡", "要不要", "是否"]
  },
  {
    label: "constraint",
    markers: ["存款", "房租", "收入", "家庭", "父母", "城市", "时间", "成本", "压力", "现实"]
  },
  {
    label: "emotion_change",
    markers: ["焦虑", "后悔", "轻松", "崩溃", "迷茫", "害怕", "开心", "难受", "变化"]
  },
  {
    label: "outcome_feedback",
    markers: ["结果", "发现", "影响", "换来", "变成", "失败", "成功", "复盘", "反馈"]
  },
  {
    label: "cost",
    markers: ["代价", "损失", "花了", "撑了", "预算", "安全垫", "现金流", "回撤"]
  },
  {
    label: "non_template_expression",
    markers: ["踩坑", "绕路", "试过", "经历过", "尝试过", "真实", "具体", "细节"]
  }
];

const LOW_QUALITY_SIGNAL_GROUPS = [
  {
    label: "pure_opinion",
    markers: ["我认为", "我觉得", "观点", "看法", "本质上", "归根结底"]
  },
  {
    label: "generic_motivation",
    markers: ["努力", "坚持", "成长", "心态", "热爱", "相信自己", "人生"]
  },
  {
    label: "marketing",
    markers: ["私信", "加微信", "课程", "报名", "咨询", "训练营", "返利", "推广", "带货"]
  },
  {
    label: "template_advice",
    markers: ["建议", "应该", "最好", "方法", "技巧", "攻略", "清单", "步骤"]
  }
];

export function runNormalizeCandidatesStage(
  rawSources: RawSourcesArtifactData
): AgentStageOutput<CandidatesArtifactData> {
  const eligibleSources = rawSources.sources.filter(isAcceptedSourceType);
  const dedupeResult = dedupeSources(eligibleSources);
  const dedupedSources = dedupeResult.sources;
  const queryTerms = buildQueryTerms([rawSources.query, ...rawSources.expandedQueries]);
  const scoredCandidates = dedupedSources
    .map((source, index) =>
      mapRawSourceToCandidate(source, index, dedupedSources.length, queryTerms)
    )
    .sort(compareCandidates);
  const candidates = applyEvidenceSelectionBudget(scoredCandidates);
  const selectedForEvidenceCount = candidates.filter((candidate) => candidate.selectedForEvidence).length;
  const lowQualityCandidateIds = candidates
    .filter((candidate) => !candidate.selectedForEvidence)
    .map((candidate) => candidate.id);
  const rejectReasonCounts = countRejectReasons(candidates, dedupeResult.duplicateCount);

  return {
    artifactType: AGENT_ARTIFACT_CANDIDATES,
    data: {
      candidates,
      candidateCount: candidates.length,
      sourceCount: rawSources.sources.length,
      filteredOutCount: rawSources.sources.length - eligibleSources.length,
      dedupedSourceCount: dedupeResult.duplicateCount,
      filters: {
        acceptedTypes: [...ACCEPTED_SOURCE_TYPES],
        minSelectedQualityScore: MIN_SELECTED_QUALITY_SCORE,
        maxSelectedForEvidence: MAX_SELECTED_FOR_EVIDENCE
      },
      qualityReport: {
        selectedForEvidenceCount,
        rejectedCount: lowQualityCandidateIds.length,
        minSelectedQualityScore: MIN_SELECTED_QUALITY_SCORE,
        lowQualityCandidateIds,
        rejectReasonCounts
      },
      strategy: "rule_based"
    }
  };
}

function isAcceptedSourceType(source: RawSourceItem): boolean {
  const normalizedType = source.type.trim().toLowerCase();
  if (normalizedType === "answer") {
    return true;
  }

  return source.provider === "mock" && normalizedType === "mock_answer";
}

function dedupeSources(sources: RawSourceItem[]): {
  sources: RawSourceItem[];
  duplicateCount: number;
} {
  const seen = new Set<string>();
  const result: RawSourceItem[] = [];
  let duplicateCount = 0;

  for (const source of sources) {
    const key = buildDedupeKey(source);
    if (seen.has(key)) {
      duplicateCount += 1;
      continue;
    }

    seen.add(key);
    result.push(source);
  }

  return {
    sources: result,
    duplicateCount
  };
}

function mapRawSourceToCandidate(
  source: RawSourceItem,
  index: number,
  totalCount: number,
  queryTerms: string[]
): CandidateItem {
  const score = normalizeScore(source.score, index);
  const normalizedSearchScore = normalizeRankScore(index, totalCount);
  const title = source.title || "未命名内容";
  const author = source.author || "未知作者";
  const excerpt = truncateText(source.excerpt, 500);
  const quality = scoreCandidateQuality({
    source,
    title,
    author,
    excerpt,
    score,
    normalizedSearchScore,
    queryTerms
  });

  return {
    id: `candidate_${hashStableId(source.sourceId || source.url || `${source.title}:${index}`)}`,
    sourceId: source.sourceId,
    type: source.type,
    title,
    author,
    excerpt,
    url: source.url,
    score,
    provider: source.provider,
    normalizedSearchScore,
    relevanceScore: quality.relevanceScore,
    experienceScore: quality.experienceScore,
    qualityScore: quality.qualityScore,
    qualitySignals: quality.qualitySignals,
    rejectReason: quality.rejectReason,
    selectedForEvidence: quality.eligibleForEvidence
  };
}

function buildDedupeKey(source: RawSourceItem): string {
  if (source.url) {
    return `url:${source.url.trim().toLowerCase()}`;
  }

  if (source.sourceId) {
    return `source:${source.sourceId.trim().toLowerCase()}`;
  }

  return `title:${source.title.trim().toLowerCase()}:author:${source.author.trim().toLowerCase()}`;
}

function normalizeScore(score: number, index: number): number {
  if (Number.isFinite(score) && score > 0) {
    return clampScore(score > 1 ? score / 100 : score);
  }

  return clampScore(0.76 - index * 0.03);
}

function normalizeRankScore(index: number, totalCount: number): number {
  if (totalCount <= 1) {
    return 0.95;
  }

  const rankPosition = index / Math.max(totalCount - 1, 1);
  return clampScore(0.95 - rankPosition * 0.35);
}

function scoreCandidateQuality(input: {
  source: RawSourceItem;
  title: string;
  author: string;
  excerpt: string;
  score: number;
  normalizedSearchScore: number;
  queryTerms: string[];
}): {
  relevanceScore: number;
  experienceScore: number;
  qualityScore: number;
  qualitySignals: string[];
  rejectReason: string | null;
  eligibleForEvidence: boolean;
} {
  const text = normalizeText(`${input.title} ${input.author} ${input.excerpt}`);
  const titleText = normalizeText(input.title);
  const excerptText = normalizeText(input.excerpt);
  const relevance = scoreRelevance({
    titleText,
    excerptText,
    queryTerms: input.queryTerms,
    rawScore: input.score,
    normalizedSearchScore: input.normalizedSearchScore
  });
  const experience = scoreExperience(text);
  const lowQuality = scoreLowQuality(text, input.excerpt);
  const sourceCompletenessScore = scoreSourceCompleteness(input.source, input.excerpt);
  const contentLengthScore = scoreContentLength(input.excerpt);
  const qualityScore = clampScore(
    relevance.score * 0.34 +
      experience.score * 0.34 +
      contentLengthScore * 0.14 +
      input.normalizedSearchScore * 0.12 +
      sourceCompletenessScore * 0.06 -
      lowQuality.penalty
  );
  const rankFallbackEligible =
    input.normalizedSearchScore >= MIN_RANK_FALLBACK_SEARCH_SCORE &&
    relevance.score >= MIN_RANK_FALLBACK_RELEVANCE_SCORE &&
    experience.score >= MIN_RANK_FALLBACK_EXPERIENCE_SCORE;
  const eligibleForEvidence =
    !lowQuality.critical &&
    sourceCompletenessScore >= 0.6 &&
    normalizeText(input.excerpt).length >= MIN_MEANINGFUL_CONTENT_LENGTH &&
    ((qualityScore >= MIN_SELECTED_QUALITY_SCORE &&
      relevance.score >= MIN_SELECTED_RELEVANCE_SCORE &&
      experience.score >= MIN_SELECTED_EXPERIENCE_SCORE) ||
      rankFallbackEligible);
  const rejectReason = eligibleForEvidence
    ? null
    : buildRejectReason({
      qualityScore,
      relevanceScore: relevance.score,
        experienceScore: experience.score,
        contentLength: normalizeText(input.excerpt).length,
        sourceCompletenessScore,
        lowQuality
      });
  const qualitySignals = uniqueNonEmpty([
    ...relevance.signals,
    ...experience.signals,
    ...lowQuality.signals,
    `rank_normalized:${input.normalizedSearchScore.toFixed(2)}`,
    `content_length:${normalizeText(input.excerpt).length}`,
    `source_completeness:${sourceCompletenessScore.toFixed(2)}`
  ]);

  return {
    relevanceScore: relevance.score,
    experienceScore: experience.score,
    qualityScore,
    qualitySignals,
    rejectReason,
    eligibleForEvidence
  };
}

function scoreRelevance(input: {
  titleText: string;
  excerptText: string;
  queryTerms: string[];
  rawScore: number;
  normalizedSearchScore: number;
}): { score: number; signals: string[] } {
  const text = `${input.titleText} ${input.excerptText}`;
  if (input.queryTerms.length === 0) {
    return {
      score: clampScore(input.normalizedSearchScore),
      signals: [`relevance:rank:${input.normalizedSearchScore.toFixed(2)}`]
    };
  }

  const titleHits = input.queryTerms.filter((term) => input.titleText.includes(term));
  const excerptHits = input.queryTerms.filter((term) => input.excerptText.includes(term));
  const uniqueHits = uniqueNonEmpty([...titleHits, ...excerptHits]);
  const weightedHits = titleHits.length * 1.2 + excerptHits.length;
  const coverage = weightedHits / Math.min(Math.max(input.queryTerms.length, 1), 6);
  const score = clampScore(
    Math.min(coverage, 1) * 0.65 +
      input.normalizedSearchScore * 0.3 +
      input.rawScore * 0.05
  );

  return {
    score,
    signals: [
      ...uniqueHits.slice(0, 5).map((term) => `relevance:${term}`),
      `relevance:rank:${input.normalizedSearchScore.toFixed(2)}`
    ]
  };
}

function scoreExperience(text: string): { score: number; signals: string[] } {
  const signals: string[] = [];
  let score = 0;

  for (const group of EXPERIENCE_SIGNAL_GROUPS) {
    const marker = group.markers.find((item) => text.includes(item));
    if (marker) {
      signals.push(`experience:${group.label}:${marker}`);
      score += 1;
    }
  }

  if (/\d+/.test(text)) {
    signals.push("experience:specific_number");
    score += 0.5;
  }

  return {
    score: clampScore(score / 8),
    signals
  };
}

function scoreLowQuality(
  text: string,
  excerpt: string
): { penalty: number; signals: string[]; critical: boolean } {
  const signals: string[] = [];
  let penalty = 0;
  let critical = false;
  const normalizedExcerpt = normalizeText(excerpt);

  if (normalizedExcerpt.length < MIN_MEANINGFUL_CONTENT_LENGTH) {
    signals.push("low_quality:too_short");
    penalty += 0.18;
  }

  for (const group of LOW_QUALITY_SIGNAL_GROUPS) {
    const marker = group.markers.find((item) => text.includes(item));
    if (!marker) {
      continue;
    }

    signals.push(`low_quality:${group.label}:${marker}`);
    if (group.label === "marketing") {
      penalty += 0.35;
      critical = true;
    } else if (group.label === "template_advice") {
      penalty += 0.08;
    } else {
      penalty += 0.06;
    }
  }

  if (!EXPERIENCE_SIGNAL_GROUPS.some((group) => group.markers.some((marker) => text.includes(marker)))) {
    signals.push("low_quality:no_personal_experience_signal");
    penalty += 0.08;
  }

  return {
    penalty: Math.min(penalty, 0.45),
    signals,
    critical
  };
}

function scoreContentLength(excerpt: string): number {
  const length = normalizeText(excerpt).length;
  if (length < MIN_MEANINGFUL_CONTENT_LENGTH) {
    return 0;
  }

  if (length >= 240) {
    return 1;
  }

  return clampScore((length - MIN_MEANINGFUL_CONTENT_LENGTH) / 210);
}

function scoreSourceCompleteness(source: RawSourceItem, excerpt: string): number {
  const parts = [
    Boolean(source.sourceId),
    Boolean(source.url),
    Boolean(source.title),
    Boolean(source.author),
    normalizeText(excerpt).length >= 30
  ];
  const score = parts.filter(Boolean).length / parts.length;
  return clampScore(score);
}

function buildRejectReason(input: {
  qualityScore: number;
  relevanceScore: number;
  experienceScore: number;
  contentLength: number;
  sourceCompletenessScore: number;
  lowQuality: { critical: boolean; signals: string[] };
}): string {
  if (input.lowQuality.critical) {
    return "marketing_or_spam";
  }

  if (input.contentLength < MIN_MEANINGFUL_CONTENT_LENGTH) {
    return "too_short";
  }

  if (input.lowQuality.signals.includes("low_quality:too_short")) {
    return "too_short";
  }

  if (input.sourceCompletenessScore < 0.6 || input.relevanceScore < MIN_SELECTED_RELEVANCE_SCORE) {
    return "low_relevance";
  }

  if (input.experienceScore < MIN_SELECTED_EXPERIENCE_SCORE) {
    return "low_experience_signal";
  }

  return input.qualityScore < MIN_SELECTED_QUALITY_SCORE
    ? "low_experience_signal"
    : "not_selected_budget_limit";
}

function buildQueryTerms(values: string[]): string[] {
  const terms: string[] = [];
  const joined = values.join(" ");

  for (const keyword of TOPIC_KEYWORDS) {
    if (joined.includes(keyword)) {
      terms.push(keyword);
    }
  }

  for (const value of values) {
    const normalized = normalizeText(value);
    if (normalized.length >= 2 && normalized.length <= 24) {
      terms.push(normalized);
    }

    for (const token of normalized.split(/[^\p{Script=Han}a-zA-Z0-9]+/u)) {
      const trimmed = token.trim();
      if (trimmed.length >= 2 && trimmed.length <= 12) {
        terms.push(trimmed);
      }
    }
  }

  return uniqueNonEmpty(terms).slice(0, 12);
}

function compareCandidates(left: CandidateItem, right: CandidateItem): number {
  if (left.selectedForEvidence !== right.selectedForEvidence) {
    return left.selectedForEvidence ? -1 : 1;
  }

  return (
    right.qualityScore - left.qualityScore ||
    right.experienceScore - left.experienceScore ||
    right.relevanceScore - left.relevanceScore ||
    right.normalizedSearchScore - left.normalizedSearchScore
  );
}

function applyEvidenceSelectionBudget(candidates: CandidateItem[]): CandidateItem[] {
  let selectedCount = 0;
  return candidates.map((candidate) => {
    if (!candidate.selectedForEvidence) {
      return candidate;
    }

    selectedCount += 1;
    if (selectedCount <= MAX_SELECTED_FOR_EVIDENCE) {
      return candidate;
    }

    return {
      ...candidate,
      selectedForEvidence: false,
      rejectReason: "not_selected_budget_limit"
    };
  });
}

function countRejectReasons(
  candidates: CandidateItem[],
  duplicateCount: number
): Record<string, number> {
  const result: Record<string, number> = {};
  if (duplicateCount > 0) {
    result.duplicate = duplicateCount;
  }

  for (const candidate of candidates) {
    if (!candidate.rejectReason) {
      continue;
    }

    result[candidate.rejectReason] = (result[candidate.rejectReason] ?? 0) + 1;
  }

  return result;
}

function hashStableId(value: string): string {
  return createHash("sha1").update(value).digest("hex").slice(0, 16);
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

function uniqueNonEmpty(values: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];

  for (const value of values) {
    const normalized = value.trim();
    if (normalized && !seen.has(normalized)) {
      seen.add(normalized);
      result.push(normalized);
    }
  }

  return result;
}

function normalizeText(value: string): string {
  return value.replace(/\s+/g, " ").trim().toLowerCase();
}
