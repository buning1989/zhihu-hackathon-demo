import type {
  DemoCandidateQuality,
  DemoDebug,
  DemoFeedItem,
  DemoFeedSummaryPayload,
  DemoPath,
  DemoPerson,
  DemoSearchCandidate,
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
  const query = response.query || response.debug.normalizedQuery || "";
  const basePeople = originalPeople
    .filter(isExperienceFeedPerson)
    .filter((person) => hasUsableSource(person))
    .filter((person) => !isMarketingSuspect(person));
  let people = basePeople;
  if (response.dataMode === "real") {
    const paragraphReadyPeople = basePeople.filter((person) => hasPotentialDisplayExcerpt(person, query));
    people = paragraphReadyPeople.length > 0 ? paragraphReadyPeople : basePeople;
  }
  if (people.length > 0 && people.length < 3 && response.dataMode === "real") {
    const existingIds = new Set(people.map((person) => person.id));
    people = [
      ...people,
      ...selectRawSnippetFallbackPeople(response, originalPeople, existingIds, { requireDisplayExcerpt: true })
        .slice(0, 3 - people.length)
    ];
  }
  if (people.length > 0 && people.length < 3 && response.dataMode === "real") {
    const existingSourceUrls = new Set(
      people.flatMap((person) => person.articles.map((article) => article.sourceUrl || article.url))
    );
    const supplemental = selectSearchCandidateDisplayExcerptFallbackPeople(response, existingSourceUrls)
      .slice(0, 3 - people.length);
    if (supplemental.length > 0) {
      attachSupplementalSourceRefs(response, supplemental);
      people = [...people, ...supplemental];
      markRawSnippetFeedFallback(response.debug, "raw_search_candidate_display_excerpt_fallback");
    }
  }
  if (people.length < 2 && basePeople.length > people.length && response.dataMode === "real") {
    const existingIds = new Set(people.map((person) => person.id));
    people = [
      ...people,
      ...basePeople.filter((person) => !existingIds.has(person.id)).slice(0, 2 - people.length)
    ];
  }
  if (people.length === 0 && response.dataMode === "real") {
    people = selectRawSnippetFallbackPeople(response, originalPeople);
    if (people.length > 0) {
      markRawSnippetFeedFallback(response.debug, "public feed projection kept raw_snippet_only fallback people");
    }
  }

  response.people = people;
  response.feedItems = people.map((person) => {
    const path = pathById.get(person.pathId);
    const feedItem = toFeedItem(person, path, query);
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

  return /(加微信|私信|课程|训练营|报名|推广|付费咨询|预约咨询|情感咨询|情感导师|咨询师|复合.{0,8}(步骤|技巧|咨询|挽回)|分手.{0,8}挽回|挽回.{0,8}(步骤|技巧|咨询|亲密感|前任)|转行辅导|简历辅导|面试辅导|就业班|机构培训|培训机构|带过[几数百千\d]+人)/.test(text);
}

function selectRawSnippetFallbackPeople(
  response: DemoSearchResponse,
  people: DemoPerson[],
  excludeIds: Set<string> = new Set(),
  options: { requireDisplayExcerpt?: boolean } = {}
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
    .filter((person) => !excludeIds.has(person.id))
    .filter((person) => hasUsableSource(person))
    .filter((person) => !options.requireDisplayExcerpt ||
      hasPotentialDisplayExcerpt(person, response.query || response.debug.normalizedQuery || ""))
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

function selectSearchCandidateDisplayExcerptFallbackPeople(
  response: DemoSearchResponse,
  existingSourceUrls: Set<string>
): DemoPerson[] {
  const query = response.query || response.debug.normalizedQuery || "";
  const qualityByCandidateId = new Map(
    (response.debug.candidateQuality ?? []).map((candidate) => [candidate.candidateId, candidate])
  );
  const seenUrls = new Set(existingSourceUrls);

  return (response.debug.search?.candidates ?? [])
    .filter((candidate) => candidate.url && !seenUrls.has(candidate.url))
    .map((candidate) => toSearchCandidateFallbackPerson(response, candidate, qualityByCandidateId.get(candidate.sourceId)))
    .filter((person): person is DemoPerson => Boolean(person))
    .filter((person) => !isMarketingSuspect(person))
    .filter((person) => hasPotentialDisplayExcerpt(person, query))
    .filter((person) => {
      const quality = qualityByCandidateId.get(person.sourceRefs[0] || "");
      return !quality || !isWeakOrUnsafeFeedQuality(quality);
    })
    .sort((left, right) =>
      scoreRawSnippetFallbackPerson(right, new Map()) - scoreRawSnippetFallbackPerson(left, new Map())
    )
    .filter((person) => {
      const url = person.articles[0]?.sourceUrl || person.articles[0]?.url || "";
      if (!url || seenUrls.has(url)) {
        return false;
      }
      seenUrls.add(url);
      return true;
    })
    .slice(0, 3)
    .map(markPersonRawSnippetOnly);
}

function toSearchCandidateFallbackPerson(
  response: DemoSearchResponse,
  candidate: DemoSearchCandidate,
  quality: DemoCandidateQuality | undefined
): DemoPerson | null {
  const sourceText = normalizeParagraphText(firstNonEmpty(
    candidate.rawContent,
    candidate.text,
    candidate.excerpt,
    candidate.snippet
  ));
  if (!sourceText || sourceText.length < 80 || !candidate.url) {
    return null;
  }

  const suffix = hashText(`${candidate.sourceId}:${candidate.url}:${candidate.title}`);
  const sourceRefId = candidate.sourceId || `source_raw_${suffix}`;
  const evidenceId = `ev_raw_${suffix}`;
  const articleId = `article_raw_${suffix}`;
  const personId = `person_raw_${suffix}`;
  const title = candidate.title || "知乎公开内容";
  const author = candidate.authorName || "知乎用户";
  const evidence = {
    id: evidenceId,
    label: "来源片段",
    text: truncateText(firstNonEmpty(candidate.excerpt, candidate.snippet, sourceText), 280),
    sourceRefId,
    sourceUrl: candidate.url
  };

  const score = quality?.relevanceScore ?? 0.62;
  return {
    id: personId,
    name: author,
    sampleType: "experience_sample",
    pathId: "path_raw_feed_fallback",
    role: "基于知乎公开内容整理的经历样本",
    badge: "真实经历",
    displayTier: "supplement",
    evidenceStatus: "raw_snippet_only",
    canChat: false,
    directionLabel: "真实经历",
    sourceTitle: title,
    sourcePlatform: "知乎",
    sourceUrl: candidate.url,
    snippet: truncateText(firstNonEmpty(candidate.snippet, candidate.excerpt, sourceText), 180),
    avatar: "",
    oneLine: truncateText(sourceText, 90),
    experienceSummary: null,
    experienceSummarySource: "none",
    experienceSummaryStatus: "pending",
    fitReason: "这条样本来自搜索候选池，用于补足可追溯的原文经历摘录。",
    who: "基于知乎公开内容整理出的经历样本，不等同于作者完整人生。",
    overlaps: ["都涉及当前问题下的真实经历判断"],
    timeline: [{
      date: "公开内容片段",
      event: truncateText(sourceText, 90),
      evidenceIds: [evidenceId],
      sourceRefs: [sourceRefId]
    }],
    lesson: "先回到原文段落核对，再判断这段经历是否能迁移到自己的处境。",
    articles: [{
      id: articleId,
      title,
      text: sourceText,
      url: candidate.url,
      author,
      avatar: "",
      sourceName: "知乎",
      sourceUrl: candidate.url,
      summary: truncateText(sourceText, 160),
      evidenceStatus: "raw_snippet_only",
      evidenceText: evidence.text,
      evidence: [evidence],
      body: splitParagraphs(sourceText).map((paragraph) => ({
        type: "paragraph" as const,
        text: paragraph,
        evidenceIds: [evidenceId],
        sourceRefs: [sourceRefId]
      })),
      sourceRefs: [sourceRefId]
    }],
    match: {
      score,
      level: score >= 0.82 ? "high" : score >= 0.58 ? "medium" : "low",
      reasons: ["搜索候选池中存在可独立展示的原文经历段落"],
      matchedVariables: ["真实经历", "阶段结果", "个人判断"],
      riskNotes: ["该卡片来自规则补足，只开放查看原文，不开放追问"],
      contentRelevance: score,
      experienceSimilarity: quality?.experienceSignalScore ?? 0.62,
      evidenceQuality: quality?.qualityScore ?? 0.62,
      personaReadiness: 0,
      evidenceIds: [evidenceId],
      sourceRefs: [sourceRefId]
    },
    aiPersona: {
      enabled: false,
      canChat: false,
      evidenceStatus: "raw_snippet_only",
      displayLabel: "仅查看来源片段",
      displayTradeoff: "这条样本来自规则补足，暂不开放追问。",
      personaId: "",
      displayName: `${author}的公开内容片段`,
      label: "基于公开内容生成",
      openingLine: "这段公开内容目前只适合查看来源片段，暂不开放追问。",
      suggestedQuestions: ["这段公开内容里，哪些信息是确定的？"],
      boundary: "基于知乎公开内容生成，不代表作者本人。",
      grounding: {
        personId,
        articleIds: [articleId],
        evidenceRequired: true,
        sourceRefs: [sourceRefId]
      }
    },
    evidenceIds: [evidenceId],
    sourceRefs: [sourceRefId]
  };
}

function attachSupplementalSourceRefs(response: DemoSearchResponse, people: DemoPerson[]): void {
  for (const person of people) {
    const article = person.articles[0];
    const sourceRefId = person.sourceRefs[0] || article?.sourceRefs[0];
    if (!article || !sourceRefId || response.meta.sourceRefs.some((item) => item.id === sourceRefId)) {
      continue;
    }
    response.meta.sourceRefs.push({
      id: sourceRefId,
      provider: "zhihu",
      type: "zhihu_answer",
      title: article.title,
      url: article.sourceUrl || article.url,
      author: article.author || person.name,
      evidenceIds: person.evidenceIds
    });
    response.meta.evidenceCount += person.evidenceIds.length;
  }
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

function toFeedItem(person: DemoPerson, path: DemoPath | undefined, query: string): DemoFeedItem {
  const article = person.articles[0];
  const sourceUrl = article?.sourceUrl || article?.url || "";
  const snippet = selectSnippet(person);
  const excerpt = selectDisplayExcerpt(person, query);
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
    displayExcerpt: excerpt.text,
    excerptSource: excerpt.source,
    excerptReason: excerpt.reason,
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
  person.displayExcerpt = feedItem.displayExcerpt;
  person.excerptSource = feedItem.excerptSource;
  person.excerptReason = feedItem.excerptReason;
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

interface DisplayExcerptSelection {
  text: string;
  source: NonNullable<DemoFeedItem["excerptSource"]>;
  reason: string;
}

interface ParagraphCandidate {
  text: string;
  index: number;
  fromBodyBlock: boolean;
}

function selectDisplayExcerpt(
  person: DemoPerson,
  query: string
): DisplayExcerptSelection {
  const article = person.articles[0];
  const candidates = collectParagraphCandidates(article);
  const keywords = buildExcerptKeywords(query, article?.title || person.sourceTitle || "");
  const scored = candidates
    .map((candidate) => ({
      candidate,
      score: scoreDisplayExcerpt(candidate.text, keywords, query),
      reason: explainDisplayExcerpt(candidate.text, keywords)
    }))
    .filter((item) => isQualifiedDisplayExcerpt(item.candidate.text, item.score, query))
    .sort((left, right) => right.score - left.score || left.candidate.index - right.candidate.index);
  const selected = scored[0];

  if (selected) {
    const text = fitDisplayExcerptLength(selected.candidate.text);
    return {
      text,
      source: isLlmAnchoredParagraph(text, article) ? "llm_selected_paragraph" : "paragraph_rule_selected",
      reason: selected.reason
    };
  }

  const fallback = fitDisplayExcerptLength(
    firstNonEmpty(
      person.experienceSummary,
      article?.summary,
      article?.evidenceText,
      article?.evidence[0]?.text,
      person.oneLine
    )
  );

  return {
    text: fallback || "这条样本目前没有可独立展示的完整原文段落，建议打开原文核对。",
    source: "summary_fallback",
    reason: "no qualified original paragraph met query-aware completeness gates"
  };
}

function hasPotentialDisplayExcerpt(person: DemoPerson, query: string): boolean {
  const article = person.articles[0];
  const candidates = collectParagraphCandidates(article);
  const keywords = buildExcerptKeywords(query, article?.title || person.sourceTitle || "");
  return candidates.some((candidate) => {
    const score = scoreDisplayExcerpt(candidate.text, keywords, query);
    return isQualifiedDisplayExcerpt(candidate.text, score, query);
  });
}

function collectParagraphCandidates(article: DemoPerson["articles"][number] | undefined): ParagraphCandidate[] {
  if (!article) {
    return [];
  }

  const rawBlocks = [
    article.text,
    ...article.body
      .filter((block) => block.type === "paragraph")
      .map((block) => block.text)
  ].map((text) => String(text || "").trim()).filter(Boolean);
  const seen = new Set<string>();
  const candidates: ParagraphCandidate[] = [];

  rawBlocks.forEach((block, blockIndex) => {
    const paragraphs = splitParagraphs(block);
    const paragraphCandidates = [
      ...paragraphs,
      ...combineAdjacentParagraphs(paragraphs)
    ];
    paragraphCandidates.forEach((paragraph) => {
      splitParagraphToExcerptCandidates(paragraph).forEach((text) => {
        const normalized = normalizeParagraphText(text);
        const key = normalized.slice(0, 80);
        if (normalized.length < 48 || seen.has(key)) {
          return;
        }
        seen.add(key);
        candidates.push({
          text: normalized,
          index: candidates.length,
          fromBodyBlock: blockIndex > 0
        });
      });
    });
  });

  return candidates;
}

function combineAdjacentParagraphs(paragraphs: string[]): string[] {
  const combined: string[] = [];
  for (let start = 0; start < paragraphs.length; start += 1) {
    let current = "";
    for (let end = start; end < paragraphs.length; end += 1) {
      current = appendExcerptText(current, paragraphs[end]);
      if (current.length >= 100) {
        combined.push(current);
      }
      if (current.length >= 260) {
        break;
      }
    }
  }
  return combined;
}

function splitParagraphs(text: string): string[] {
  const normalized = String(text || "")
    .replace(/\r/g, "\n")
    .replace(/[ \t]+/g, " ")
    .trim();
  if (!normalized) {
    return [];
  }

  const paragraphBreaks = normalized
    .split(/\n{2,}/)
    .map(normalizeParagraphText)
    .filter(Boolean);
  if (paragraphBreaks.length > 1) {
    return paragraphBreaks;
  }

  return normalized
    .split(/\n+/)
    .map(normalizeParagraphText)
    .filter(Boolean);
}

function splitParagraphToExcerptCandidates(paragraph: string): string[] {
  const normalized = normalizeParagraphText(paragraph);
  if (!normalized) {
    return [];
  }
  if (normalized.length <= 280) {
    return [normalized];
  }

  const sentences = splitExcerptSentences(normalized);
  const windows: string[] = [];
  for (let start = 0; start < sentences.length; start += 1) {
    let current = "";
    for (let end = start; end < sentences.length; end += 1) {
      current = appendExcerptText(current, sentences[end]);
      if (current.length >= 120) {
        windows.push(current);
      }
      if (current.length >= 260) {
        break;
      }
    }
  }

  return windows.length ? windows : [normalized];
}

function splitExcerptSentences(text: string): string[] {
  return (normalizeParagraphText(text).match(/[^。！？!?；;]+[。！？!?；;]?/g) ?? [text])
    .map(normalizeParagraphText)
    .filter((item) => item.length >= 8);
}

function scoreDisplayExcerpt(text: string, keywords: string[], query: string): number {
  const normalized = normalizeParagraphText(text);
  const queryScore = keywords.reduce((total, keyword) =>
    total + (normalized.includes(keyword) ? 8 : 0),
  0);
  const directTopicScore = /异地恋|异国恋|长期异地|距离|见面|同城|分手|结婚|在一起|裸辞|离职|大厂|自由职业|转行|不工作|失业|创业/.test(normalized)
    ? 18
    : 0;
  const personalScore = hasConcretePersonalStorySignal(normalized)
    ? 18
    : 0;
  const emotionScore = /难过|崩溃|焦虑|孤独|幸福|甜蜜|委屈|害怕|恐惧|开心|痛苦|心疼|失望|后悔|值得|不值得|煎熬|安全感|走不出来|累|苦|压力|虚无|欣喜/.test(normalized)
    ? 16
    : 0;
  const judgementScore = /我觉得|我感觉|我认为|才是|最难|值得|不值得|没想过分手|体谅|决定|选择|该不该|要不要|适合|不适合|靠谱|不靠谱/.test(normalized)
    ? 14
    : 0;
  const resultScore = /最后|最终|结果|后来|现在|终于|坚持|分手|结婚|同城|到一个城市|在一起|走出来|重返|回到|撑了|失败|成功|辞职|离职|转行/.test(normalized)
    ? 16
    : 0;
  const conditionScore = /如果|只有|只要|前提|情况下|因为|所以|但是|但|除非|当.*时候|一旦/.test(normalized)
    ? 8
    : 0;
  const lengthScore = normalized.length >= 120 && normalized.length <= 260
    ? 12
    : normalized.length >= 80 && normalized.length <= 300
      ? 5
      : -10;
  const methodPenalty = /^(\d+[、.．，,。]|[一二三四五六七八九十]+、|首先|其次|第一|第二)|方法|技巧|步骤|清单|建议你|你应该|可以试试|私信|课程|报名|咨询/.test(normalized)
    ? 18
    : 0;
  const quoteOrSloganPenalty = /^(韩寒曾经|有人说|都说|网上说|俗话说|有句话|电影里)/.test(normalized)
    ? 28
    : 0;
  const abruptPenalty = hasAbruptExcerptStart(normalized) ? 12 : 0;
  const backgroundPenalty = isBackgroundOnlyExcerpt(normalized, query) ? 20 : 0;

  return queryScore +
    directTopicScore +
    personalScore +
    emotionScore +
    judgementScore +
    resultScore +
    conditionScore +
    lengthScore -
    methodPenalty -
    quoteOrSloganPenalty -
    abruptPenalty -
    backgroundPenalty;
}

function isQualifiedDisplayExcerpt(text: string, score: number, query: string): boolean {
  const normalized = normalizeParagraphText(text);
  if (/异地恋|异地/.test(query) &&
    !/(异地恋|异国恋|异地|见面|同城|分手|结婚|订婚|在一起|安全感|距离|未来规划|修成正果)/.test(normalized)) {
    return false;
  }
  const hasStrongShortResult =
    normalized.length >= 38 &&
    hasConcretePersonalStorySignal(normalized) &&
    /异地恋|异国恋|同城|分手|结婚|订婚|在一起|上岸|结束了/.test(normalized) &&
    /终于|结果|结婚|订婚|同城|在一个城市|分手|走出来|修成正果|双丰收|结束了/.test(normalized);
  if (score < 40 || (normalized.length < 70 && !hasStrongShortResult)) {
    return false;
  }
  if (!hasConcretePersonalStorySignal(normalized)) {
    return false;
  }
  if (!/(难过|崩溃|焦虑|孤独|幸福|甜蜜|委屈|害怕|恐惧|开心|痛苦|心疼|失望|后悔|值得|不值得|煎熬|安全感|走不出来|累|苦|压力|虚无|欣喜|决定|选择|分手|结婚|同城|离职|转行|创业)/.test(normalized)) {
    return false;
  }
  if (hasAbruptExcerptStart(normalized)) {
    return false;
  }
  if (/^(\d+[、.．，,。]|[一二三四五六七八九十]+、|第一|第二|第三)/.test(normalized)) {
    return false;
  }
  if (isGeneralizedAdviceExcerpt(normalized)) {
    return false;
  }
  if (/^(韩寒曾经|有人说|都说|网上说|俗话说|有句话|电影里)/.test(normalized)) {
    return false;
  }
  return true;
}

function buildExcerptKeywords(query: string, title: string): string[] {
  const defaults = /异地恋|异地/.test(`${query}\n${title}`)
    ? ["异地恋", "异国恋", "距离", "见面", "同城", "分手", "结婚", "在一起", "坚持", "值得", "难过", "安全感", "结果"]
    : [];
  return Array.from(new Set([
    ...defaults,
    ...String(query || "").split(/[^\p{Script=Han}A-Za-z0-9]+/u),
    ...String(title || "").split(/[^\p{Script=Han}A-Za-z0-9]+/u)
  ]))
    .map((item) => item.trim())
    .filter((item) => item.length >= 2 && item.length <= 12)
    .slice(0, 20);
}

function explainDisplayExcerpt(text: string, keywords: string[]): string {
  const matchedKeywords = keywords.filter((keyword) => text.includes(keyword)).slice(0, 5);
  const signals = [
    matchedKeywords.length ? `matched=${matchedKeywords.join("/")}` : "",
    hasConcretePersonalStorySignal(text) ? "personal_experience" : "",
    /难过|崩溃|焦虑|孤独|幸福|甜蜜|值得|不值得|安全感|走不出来|累|苦/.test(text) ? "emotion_or_judgement" : "",
    /最后|最终|结果|后来|现在|终于|坚持|分手|结婚|同城|在一起|决定|选择/.test(text) ? "result_or_condition" : ""
  ].filter(Boolean);
  return signals.join("; ") || "paragraph selected by length and source quality";
}

function isLlmAnchoredParagraph(text: string, article: DemoPerson["articles"][number] | undefined): boolean {
  if (!article || article.evidenceStatus !== "llm_extracted") {
    return false;
  }
  const evidenceText = normalizeParagraphText(firstNonEmpty(article.evidenceText, article.evidence[0]?.text));
  if (!evidenceText) {
    return false;
  }
  return text.includes(evidenceText.slice(0, Math.min(40, evidenceText.length))) ||
    evidenceText.includes(text.slice(0, Math.min(40, text.length)));
}

function hasConcretePersonalStorySignal(text: string): boolean {
  const normalized = normalizeParagraphText(text);
  return /我和|我俩|我们.{0,24}(开始|在一起|见面|同城|分手|结婚|订婚|上岸|熬过|坚持|结束|走出来|吵架|异地)|我.{0,8}(老公|老婆|男友|女友|对象|伴侣|前任|女朋友|男朋友)|我.{0,18}(当时|去年|现在|开始|崩溃|难过|痛苦|后悔|选择|决定|哭|熬|坚持|受到了委屈)|我的.{0,8}(老公|老婆|男友|女友|对象|伴侣|前任|女朋友|男朋友|异地恋|经历)/.test(normalized);
}

function fitDisplayExcerptLength(value: string): string {
  const normalized = normalizeParagraphText(value);
  if (normalized.length <= 260) {
    return normalized;
  }
  const sentences = splitExcerptSentences(normalized);
  let current = "";
  for (const sentence of sentences) {
    const next = normalizeParagraphText(`${current}${sentence}`);
    if (next.length > 260 && current.length >= 120) {
      break;
    }
    if (next.length > 260 && !current) {
      return truncateText(next, 260);
    }
    current = next;
  }
  return current.length >= 80 ? current : truncateText(normalized, 260);
}

function hasAbruptExcerptStart(text: string): boolean {
  return /^(后来他|后来她|后来因为|然后|我听到之后|K 如果第二天|k 如果第二天|这时候|这时|于是|而且|但是|但如果|分手的第|其实分手后|他们在一起|也只有这样|好哥们)/.test(text);
}

function isBackgroundOnlyExcerpt(text: string, query: string): boolean {
  const normalized = normalizeParagraphText(text);
  const hasJudgementOrResult = /值得|不值得|难过|崩溃|焦虑|孤独|幸福|甜蜜|安全感|走不出来|分手|结婚|同城|在一起|最后|最终|结果|决定|选择|所以|但是|但/.test(normalized);
  const isLongDistanceBackground = /异地恋|异国恋/.test(query) &&
    /^我和.{0,12}(异地恋|异国恋).{0,20}(一年|两年|半年|多久|后来)/.test(normalized);
  return !hasJudgementOrResult || isLongDistanceBackground;
}

function isGeneralizedAdviceExcerpt(text: string): boolean {
  const normalized = normalizeParagraphText(text);
  const secondPersonCount = (normalized.match(/你们|你|Ta|TA|对方/g) ?? []).length;
  const hasHypotheticalMarker = /比如|如果|为什么不|是不是|应该|需要|要有|怎么结束|谁来迁就谁|走一步看一步/.test(normalized);
  const hasGenericEssayMarker = /爱情是一种|感情就是|我们可以发现|大多数情侣|空巢|留守儿童|情侣之间|如果一个人距离|两个人相爱|不是说你们|谁来迁就谁/.test(normalized);
  return (secondPersonCount >= 2 && hasHypotheticalMarker && !hasConcretePersonalStorySignal(normalized)) ||
    (hasGenericEssayMarker && !hasConcretePersonalStorySignal(normalized));
}

function normalizeParagraphText(value: string): string {
  return String(value || "")
    .replace(/\s+/g, " ")
    .replace(/^(\d+[、.．，,。]\s*|[一二三四五六七八九十]+、\s*)/, "")
    .replace(/([。！？!?；;])\s+/g, "$1")
    .replace(/[，,]。/g, "。")
    .replace(/。{2,}/g, "。")
    .trim();
}

function appendExcerptText(current: string, next: string): string {
  const left = normalizeParagraphText(current);
  const right = normalizeParagraphText(next);
  if (!left) {
    return right;
  }
  if (!right) {
    return left;
  }
  return /[。！？!?；;」”）)]$/.test(left)
    ? normalizeParagraphText(`${left}${right}`)
    : normalizeParagraphText(`${left}。${right}`);
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

function hashText(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16);
}
