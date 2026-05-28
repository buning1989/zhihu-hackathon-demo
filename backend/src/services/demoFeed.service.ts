import type {
  DemoCandidateQuality,
  DemoDebug,
  DemoFeedItem,
  DemoFeedSummaryPayload,
  DemoPath,
  DemoPerson,
  DemoSearchResponse
} from "../types/demo.types.js";

interface ProjectDemoFeedOptions {
  hidePaths?: boolean;
}

export function projectDemoFeedResponse(
  response: DemoSearchResponse,
  options: ProjectDemoFeedOptions = {}
): DemoSearchResponse {
  const pathById = new Map(response.paths.map((path) => [path.id, path]));
  const originalPeople = response.people;
  let people = originalPeople
    .filter(isExperienceFeedPerson)
    .filter((person) => hasUsableSource(person))
    .filter((person) => !isMarketingSuspect(person));
  if (people.length === 0 && response.dataMode === "real") {
    people = selectRawSnippetFallbackPeople(response, originalPeople);
    if (people.length > 0) {
      markRawSnippetFeedFallback(response.debug, "public feed projection kept raw_snippet_only fallback people");
    }
  }

  response.people = people;
  response.feedItems = people.map((person) => {
    const path = pathById.get(person.pathId);
    const feedItem = toFeedItem(person, path);
    applyFeedFieldsToPerson(person, feedItem);
    return feedItem;
  });
  const feedSourceRefIds = new Set(response.feedItems.flatMap((item) => item.sourceRefs));
  response.meta.sourceRefs = response.meta.sourceRefs.filter((sourceRef) =>
    feedSourceRefIds.has(sourceRef.id)
  );
  response.meta.evidenceCount = response.meta.sourceRefs.reduce(
    (total, sourceRef) => total + sourceRef.evidenceIds.length,
    0
  );
  response.debug.itemCount = response.feedItems.length;
  response.debug.peopleCount = response.people.length;
  if (response.debug.candidateQuality) {
    response.debug.candidateQuality = response.debug.candidateQuality.map((candidate) => {
      if (!candidate.sourceRefId || feedSourceRefIds.has(candidate.sourceRefId)) {
        return candidate;
      }

      return {
        ...candidate,
        usedAsEvidence: false,
        filterReason: candidate.filterReason.startsWith("not_in_experience_feed")
          ? candidate.filterReason
          : `not_in_experience_feed: ${candidate.filterReason}`
      };
    });
  }
  response.debug.personaCount = response.people.filter((person) => person.aiPersona.personaId).length;
  response.analysis.summary = buildFeedAnalysisSummary(response);

  if (options.hidePaths) {
    response.paths = [];
    response.sections = response.sections?.filter((section) => section.type !== "paths");
    stripPublicPathDebug(response.debug, response.dataMode);
  }

  return response;
}

function isExperienceFeedPerson(person: DemoPerson): boolean {
  return (person.sampleType ?? "experience_sample") === "experience_sample";
}

function hasUsableSource(person: DemoPerson): boolean {
  const article = person.articles[0];
  return Boolean(
    article &&
      (article.sourceUrl || article.url) &&
      (person.sourceRefs.length > 0 || article.sourceRefs.length > 0) &&
      (person.evidenceIds.length > 0 || article.evidence.length > 0)
  );
}

function isMarketingSuspect(person: DemoPerson): boolean {
  const article = person.articles[0];
  const text = [
    person.name,
    person.oneLine,
    person.badge,
    article?.title,
    article?.summary,
    article?.text,
    article?.evidence.map((item) => item.text).join("\n")
  ].filter(Boolean).join("\n");

  return /(加微信|私信|课程|训练营|报名|推广|付费咨询|预约咨询|转行辅导|简历辅导|面试辅导|就业班|机构培训|培训机构|带过[几数百千\d]+人)/.test(text);
}

function selectRawSnippetFallbackPeople(
  response: DemoSearchResponse,
  people: DemoPerson[]
): DemoPerson[] {
  const qualityBySourceRef = new Map(
    (response.debug.candidateQuality ?? [])
      .filter((item): item is DemoCandidateQuality & { sourceRefId: string } =>
        Boolean(item.sourceRefId)
      )
      .map((item) => [item.sourceRefId, item])
  );

  return people
    .filter(isExperienceFeedPerson)
    .filter((person) => hasUsableSource(person))
    .filter((person) => !isMarketingSuspect(person))
    .filter((person) => {
      const sourceRefId = person.sourceRefs[0] || person.articles[0]?.sourceRefs[0] || "";
      const quality = sourceRefId ? qualityBySourceRef.get(sourceRefId) : undefined;
      return !quality || !isWeakOrUnsafeFeedQuality(quality);
    })
    .sort((left, right) =>
      scoreRawSnippetFallbackPerson(right, qualityBySourceRef) -
        scoreRawSnippetFallbackPerson(left, qualityBySourceRef)
    )
    .slice(0, 3)
    .map(markPersonRawSnippetOnly);
}

function isWeakOrUnsafeFeedQuality(
  quality: DemoCandidateQuality
): boolean {
  const text = [
    quality.title,
    quality.filterReason,
    quality.roughReason,
    ...(quality.penaltySignals ?? [])
  ].join("\n");
  const hasObviousWeakSignal =
    /广告营销|疑似机构|课程|训练营|加微信|私信|咨询|报名|推广|证书|法律|财会|招聘|指南\/教程型标题/.test(text);
  const scoreTooWeak =
    quality.relevanceScore < 0.1 &&
    quality.qualityScore < 0.55 &&
    quality.contentRole !== "real_experience";
  return (
    hasObviousWeakSignal ||
    quality.contentRole === "viewpoint" ||
    scoreTooWeak
  );
}

function scoreRawSnippetFallbackPerson(
  person: DemoPerson,
  qualityBySourceRef: Map<string, DemoCandidateQuality>
): number {
  const sourceRefId = person.sourceRefs[0] || person.articles[0]?.sourceRefs[0] || "";
  const quality = sourceRefId ? qualityBySourceRef.get(sourceRefId) : undefined;
  return (
    (quality?.roughScore ?? 0) +
    (quality?.relevanceScore ?? person.match.contentRelevance) * 80 +
    (quality?.qualityScore ?? person.match.evidenceQuality) * 30 +
    (quality?.experienceSignalScore ?? person.match.experienceSimilarity) * 40
  );
}

function markPersonRawSnippetOnly(person: DemoPerson): DemoPerson {
  person.evidenceStatus = "raw_snippet_only";
  person.canChat = false;
  person.aiPersona.enabled = false;
  person.aiPersona.canChat = false;
  person.aiPersona.evidenceStatus = "raw_snippet_only";
  person.aiPersona.displayLabel = "仅查看来源片段";
  person.aiPersona.openingLine = "这段公开内容目前只适合查看来源片段，暂不开放追问。";
  person.aiPersona.suggestedQuestions = ["这段公开内容里，哪些信息是确定的？"];

  for (const article of person.articles) {
    article.evidenceStatus = "raw_snippet_only";
    article.evidenceText = buildFallbackEvidenceText(article);
    if (article.evidence[0]) {
      article.evidence[0].label = "来源片段";
      article.evidence[0].text = article.evidenceText;
    }
  }

  return person;
}

function markRawSnippetFeedFallback(debug: DemoDebug, reason: string): void {
  if (debug.llmArtifactSources) {
    debug.llmArtifactSources.evidence_extract = {
      source: "rule_fallback",
      stageStatus: "fallback",
      fallbackReason: reason
    };
  }
  debug.guardWarnings = Array.from(new Set([...(debug.guardWarnings ?? []), reason]));
}

function toFeedItem(person: DemoPerson, path: DemoPath | undefined): DemoFeedItem {
  const article = person.articles[0];
  const sourceUrl = article?.sourceUrl || article?.url || "";
  const snippet = selectSnippet(person);
  const directionLabel = selectDirectionLabel(person, path);
  const summaryPayload = buildSummaryPayload(person, snippet);
  const sourceRefs = person.sourceRefs.length > 0 ? person.sourceRefs : article?.sourceRefs ?? [];
  const evidenceIds =
    person.evidenceIds.length > 0
      ? person.evidenceIds
      : article?.evidence.map((item) => item.id) ?? [];
  return {
    id: `feed_${person.id}`,
    personId: person.id,
    authorName: person.name || article?.author || "知乎用户",
    authorAvatar: person.avatar || article?.avatar || "",
    sourceTitle: article?.title || "知乎公开内容",
    sourcePlatform: article?.sourceName || "知乎",
    sourceUrl,
    directionLabel,
    snippet,
    summaryText: summaryPayload.markdown,
    summaryPayload,
    sampleType: "experience_sample",
    evidenceIds,
    sourceRefs,
    saveSampleId: person.id
  };
}

function applyFeedFieldsToPerson(person: DemoPerson, feedItem: DemoFeedItem): void {
  person.sampleType = "experience_sample";
  person.directionLabel = feedItem.directionLabel;
  person.sourceTitle = feedItem.sourceTitle;
  person.sourcePlatform = feedItem.sourcePlatform;
  person.sourceUrl = feedItem.sourceUrl;
  person.snippet = feedItem.snippet;
  person.summaryText = feedItem.summaryText;
  person.summaryPayload = feedItem.summaryPayload;
  person.saveSampleId = feedItem.saveSampleId;
}

function selectDirectionLabel(person: DemoPerson, path: DemoPath | undefined): string {
  const raw = firstNonEmpty(
    person.directionLabel,
    person.match.matchedVariables[0],
    person.badge,
    path?.displayLabel,
    path?.title,
    "真实经历"
  );
  const cleaned = raw
    .replace(/^(经历样本|复盘样本|取舍样本|行动路径|观点型参考|参考路径)[:：]?\s*/g, "")
    .replace(/路径/g, "")
    .trim();

  if (!cleaned || /观点|营销|教程|指南|方法/.test(cleaned)) {
    return "真实经历";
  }

  return truncateText(cleaned, 18);
}

function selectSnippet(person: DemoPerson): string {
  const article = person.articles[0];
  return truncateText(
    firstNonEmpty(
      article?.evidenceText,
      article?.evidence[0]?.text,
      article?.summary,
      article?.text,
      person.oneLine
    ),
    220
  );
}

function buildFallbackEvidenceText(article: DemoPerson["articles"][number]): string {
  return truncateText(
    firstNonEmpty(
      article.evidenceText,
      article.evidence[0]?.text,
      article.summary,
      article.text,
      article.title
    ),
    220
  );
}

function buildSummaryPayload(person: DemoPerson, snippet: string): DemoFeedSummaryPayload {
  const article = person.articles[0];
  const evidenceText = firstNonEmpty(
    article?.evidenceText,
    article?.evidence[0]?.text,
    article?.summary,
    article?.text,
    snippet
  );
  const whatHappened = truncateText(
    firstNonEmpty(person.experienceSummary, evidenceText, person.oneLine, snippet),
    140
  );
  const keyChoiceOrChange = truncateText(
    firstNonEmpty(person.timeline[0]?.event, article?.evidence[1]?.text, evidenceText),
    140
  );
  const referenceValue = truncateText(
    firstNonEmpty(person.relevanceReason, person.match.reasons[0], person.fitReason, evidenceText),
    140
  );
  const safeWhatHappened =
    whatHappened || "这条样本目前只有很短的来源片段，不能扩写成完整经历。";
  const safeKeyChoiceOrChange =
    keyChoiceOrChange || "现有 source evidence 没有提供足够的选择、变化或后续结果线索。";
  const safeReferenceValue =
    referenceValue || "它暂时只能作为可回到原文核对的来源入口。";

  return {
    whatHappened: safeWhatHappened,
    keyChoiceOrChange: safeKeyChoiceOrChange,
    referenceValue: safeReferenceValue,
    markdown: [
      "### 这个样本讲了什么",
      safeWhatHappened,
      "",
      "### 这个人的关键选择或变化",
      safeKeyChoiceOrChange,
      "",
      "### 对当前问题有什么参考价值",
      safeReferenceValue
    ].join("\n")
  };
}

function buildFeedAnalysisSummary(response: DemoSearchResponse): string {
  const query = response.query || response.debug.normalizedQuery || "当前问题";
  return `围绕「${truncateText(query, 40)}」，已整理出 ${response.feedItems?.length ?? 0} 条可追溯真实经历样本。`;
}

function stripPublicPathDebug(debug: DemoDebug, dataMode: DemoSearchResponse["dataMode"]): void {
  const publicDebug = debug as Partial<DemoDebug>;
  delete publicDebug.pathCount;
  if (dataMode !== "real") {
    delete publicDebug.enhancedPathCount;
  }
  delete publicDebug.pathSource;
  delete publicDebug.pathDuplicateFound;
  delete publicDebug.pathDiversityCheck;
}

function firstNonEmpty(...values: Array<string | null | undefined>): string {
  for (const value of values) {
    const text = String(value ?? "").trim();
    if (text) {
      return text;
    }
  }
  return "";
}

function truncateText(value: string, maxLength: number): string {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (text.length <= maxLength) {
    return text;
  }
  return `${text.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
}
