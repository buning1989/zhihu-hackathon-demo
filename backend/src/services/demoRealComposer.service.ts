import {
  DEMO_PERSONA_BOUNDARY_NOTICE,
  DEMO_SCHEMA_VERSION,
  type DemoArticle,
  type DemoCandidateQuality,
  type DemoContentRole,
  type DemoDataMode,
  type DemoDisplayTier,
  type DemoEvidence,
  type DemoEvidenceStatus,
  type DemoPath,
  type DemoPerson,
  type DemoPersona,
  type DemoSearchResponse,
  type DemoSourceRef
} from "../types/demo.types.js";
import type { UserContext } from "../auth/session.js";
import type { SearchItem } from "../types/api.types.js";
import {
  buildQueryAwarePathPlans,
  inferQueryIntent,
  type DemoPathCandidate,
  type DemoPathPlan
} from "./demoPathBuilder.service.js";
import { scoreSearchCandidate, type CandidateAssessment } from "./demoCandidateQuality.service.js";
import { createDemoSearchIdentity } from "./demoQueryIdentity.service.js";
import { enforceDemoPathDiversity } from "./demoPathDiversity.service.js";
import { buildContextFitReason, createDemoContextUsed } from "./userContext.service.js";

interface ComposeRealInput {
  query: string;
  count: number;
  dataMode: DemoDataMode;
  items: SearchItem[];
  startedAt: number;
  userContext?: UserContext;
  candidateQuality?: DemoCandidateQuality[];
}

interface PathBucket {
  id: string;
  title: string;
  summary: string;
  whyRelevant: string;
  tradeoff: string;
  displayLabel?: string;
  displayTradeoff?: string;
  diversityKey: string;
  summaryAngle?: string;
  contentRole?: DemoContentRole;
  keywords: string[];
  variables: string[];
  stance: DemoPath["stance"];
  matchedItems: SearchItem[];
}

const PATH_DISPLAY_COPY: Record<DemoContentRole, {
  title: string;
  summary: string;
  tradeoff: string;
}> = {
  failure_review: {
    title: "辞职后复盘：后悔、回流与再选择",
    summary: "这类内容适合看离开工作之后的回头复盘：哪些选择后来显得草率，哪些回流接口还在，哪些问题需要重新选一次。",
    tradeoff: "它能提醒坑在哪里，但不能保证换个人照做就得到同样结果；尤其要把现金流、回流成本和情绪恢复分开判断。"
  },
  decision_conflict: {
    title: "待业中的拉扯：想走出去但没有确定路径",
    summary: "这类内容呈现的是待业或暂停工作时的摇摆：想离开原来的节奏，又还没有形成足够确定的下一步。",
    tradeoff: "它的价值在于暴露冲突，不在于给出答案；如果证据只到片段层面，就只能当作处境参考。"
  },
  life_path: {
    title: "过渡型路径：先解决现金流，再决定下一步",
    summary: "这类内容更像过渡方案：先把基本生活、收入来源和可回撤条件稳住，再判断要继续休整、找工作还是换一种生活半径。",
    tradeoff: "它能降低短期失控感，但不等于长期路径已经清楚；现金流一旦接不上，选择空间会很快变窄。"
  },
  real_experience: {
    title: "不上班后的真实日常：时间、成本和生活节奏",
    summary: "这类内容更接近日常经验：不上班之后时间如何被重新安排，钱、社交和自我认同怎样变成具体问题。",
    tradeoff: "它能提供生活质感和现实细节，但只代表公开内容里的那段经历，不能外推成普遍结论。"
  },
  alternative_solution: {
    title: "低成本备选方案：回老家、自由职业、远程/副业",
    summary: "这类内容提供的是低成本备选：用回老家、远程工作、自由职业或副业先换一段缓冲，而不是马上押上不可逆决定。",
    tradeoff: "它会降低一部分压力，也可能低估孤独、收入波动和机会变少；适合先看来源片段，再判断可迁移性。"
  },
  viewpoint: {
    title: "观点型参考：只能作为方向，不当作亲历",
    summary: "这类内容主要是观点和变量拆解，可以帮助梳理方向、成本和风险，但不能包装成作者亲历过完整过程。",
    tradeoff: "它只能作为方向参考；如果缺少明确经历和来源证据，就不开放追问，只建议查看来源片段。"
  }
};

export function composeRealDemoSearchResponse(input: ComposeRealInput): DemoSearchResponse {
  const limitedItems = input.items.slice(0, Math.min(Math.max(input.count, 10), 12));
  const identity = createDemoSearchIdentity(input.query, {
    count: input.count,
    dataMode: input.dataMode
  });
  const sourceRefs = limitedItems.map(toSourceRef);
  const sourceByItemId = new Map(limitedItems.map((item, index) => [item.id, sourceRefs[index]]));
  const candidateQuality = attachSourceRefsToCandidateQuality(
    input.query,
    limitedItems,
    input.candidateQuality,
    sourceByItemId
  );
  const qualityByItemId = new Map(candidateQuality.map((candidate) => [candidate.candidateId, candidate]));
  const pathCandidates = limitedItems.map((item) => toPathCandidate(item, qualityByItemId.get(item.id)));
  const buckets = groupItemsByPath(input.query, limitedItems, pathCandidates, candidateQuality);
  const paths = buckets.map((bucket) => toPath(bucket, sourceByItemId, input.query, input.userContext));
  const pathDiversityCheck = enforceDemoPathDiversity(paths, {
    mergeCount: buckets.reduce((total, bucket) => total + Math.max(0, bucket.matchedItems.length - 1), 0),
    notes: ["real composer clustered final candidates by contentRole, diversityKey, and summaryAngle"]
  });
  const pathByItemId = new Map<string, string>();

  for (const bucket of buckets) {
    for (const item of bucket.matchedItems) {
      if (!pathByItemId.has(item.id)) {
        pathByItemId.set(item.id, bucket.id);
      }
    }
  }

  const people = limitedItems.map((item, index) =>
    toPerson(
      item,
      index,
      pathByItemId.get(item.id) ?? paths[0].id,
      paths.find((path) => path.id === (pathByItemId.get(item.id) ?? paths[0].id)) ?? paths[0],
      sourceByItemId.get(item.id)!,
      input.query,
      input.userContext,
      candidateQuality.find((candidate) => candidate.candidateId === item.id)
    )
  );
  const personas = people.map(toPersona);
  const sourceRefsForReturnedPeople = people
    .map((person) => sourceRefs.find((sourceRef) => sourceRef.id === person.sourceRefs[0]))
    .filter((sourceRef): sourceRef is DemoSourceRef => Boolean(sourceRef));

  return {
    schemaVersion: DEMO_SCHEMA_VERSION,
    queryId: identity.queryId,
    query: input.query,
    dataMode: input.dataMode,
    contextUsed: createDemoContextUsed(input.userContext, [
      "intent_expand",
      "search_query_expand",
      "fit_reason"
    ]),
    features: {
      aiPersona: true,
      personaChat: "mock",
      saveSample: false,
      articleBody: false,
      sourceEvidenceRequired: true
    },
    analysis: {
      summary: `围绕「${identity.normalizedQuery}」，从 ${limitedItems.length} 条知乎公开内容中聚合出 ${paths.length} 条可探索路径和 ${people.length} 个可追溯样本。`,
      intent: inferQueryIntent(input.query, pathCandidates),
      focusTags: unique(buckets.flatMap((bucket) => bucket.variables)).slice(0, 8),
      steps: [
        {
          id: "step_fetch_real_zhihu",
          label: "召回真实知乎公开内容",
          status: "done",
          evidenceIds: sourceRefsForReturnedPeople.flatMap((sourceRef) => sourceRef.evidenceIds),
          sourceRefs: sourceRefsForReturnedPeople.map((sourceRef) => sourceRef.id)
        },
        {
          id: "step_rule_group_paths",
          label: "按内容关键词聚合人生路径",
          status: "done",
          evidenceIds: paths.flatMap((path) => path.evidenceIds),
          sourceRefs: paths.flatMap((path) => path.sourceRefs)
        }
      ]
    },
    paths,
    people,
    personas,
    sections: buildDisplaySections(paths, people, personas),
    meta: {
      sourceRefs: sourceRefsForReturnedPeople,
      evidenceCount: sourceRefsForReturnedPeople.reduce(
        (total, sourceRef) => total + sourceRef.evidenceIds.length,
        0
      ),
      generatedAt: new Date().toISOString(),
      latencyMs: Date.now() - input.startedAt,
      totalDurationMs: Date.now() - input.startedAt,
      fallbackUsed: false,
      fallbackStages: [],
      llmStages: [],
      timedOutStages: []
    },
    debug: {
      composer: "real_rule_composer",
      originalQuery: identity.originalQuery,
      normalizedQuery: identity.normalizedQuery,
      requestedDataMode: input.dataMode,
      resolvedDataMode: input.dataMode,
      cacheHit: false,
      cacheKeyPreview: identity.cacheKeyPreview,
      itemCount: people.length,
      sourceItemCount: limitedItems.length,
      pathCount: paths.length,
      peopleCount: people.length,
      personaCount: personas.length,
      llmUsed: false,
      llmComposerUsed: false,
      llmRepairUsed: false,
      llmRepairFailed: false,
      llmStageResults: [],
      enhancedPeopleCount: 0,
      enhancedPathCount: 0,
      partialFallbackUsed: false,
      pathSource: "rule",
      composerFallbackTriggered: false,
      pathDuplicateFound: pathDiversityCheck.duplicateFound,
      pathDiversityCheck,
      intentStage: {
        mode: "rule",
        llmUsed: false,
        fallbackReason:
          "real rule composer initialized analysis.intent and focusTags from deterministic path grouping",
        intentSource: "rule",
        focusTagsSource: "rule"
      },
      fallbackUsed: false,
      fallbackKind: "",
      fallbackReason: "",
      guardWarnings: [],
      candidateQuality,
      notes: [
        "real Zhihu items grouped by rule composer",
        "LLM provider reserved but not used in this run"
      ]
    }
  };
}

function groupItemsByPath(
  query: string,
  items: SearchItem[],
  candidates: DemoPathCandidate[],
  candidateQuality: DemoCandidateQuality[]
): PathBucket[] {
  const qualityByItemId = new Map(candidateQuality.map((candidate) => [candidate.candidateId, candidate]));
  const metadataBuckets = buildMetadataPathBuckets(query, items, qualityByItemId);

  if (metadataBuckets.length >= 3) {
    return metadataBuckets.slice(0, 5);
  }

  const pathPlans = buildQueryAwarePathPlans(query, candidates, 5);
  const buckets = pathPlans.map((plan) => toPathBucket(plan, query));

  let fallbackIndex = 0;
  for (const item of items) {
    if (metadataBuckets.some((bucket) => bucket.matchedItems.includes(item))) {
      continue;
    }

    const text = `${item.title}\n${item.text}`.toLowerCase();
    const scoredBuckets = buckets
      .map((bucket) => ({
        bucket,
        score: bucket.keywords.reduce((total, keyword) => total + countIncludes(text, keyword), 0)
      }))
      .sort((left, right) => right.score - left.score);

    const bestBucket =
      scoredBuckets[0]?.score > 0
        ? scoredBuckets[0].bucket
        : buckets[fallbackIndex++ % buckets.length];
    bestBucket.matchedItems.push(item);
  }

  const minimumPathCount = Math.min(3, buckets.length);
  for (let index = 0; index < minimumPathCount; index += 1) {
    if (buckets[index].matchedItems.length === 0 && items.length > 0) {
      buckets[index].matchedItems.push(items[index % items.length]);
    }
  }

  const combined = [...metadataBuckets, ...buckets]
    .filter((bucket) => bucket.matchedItems.length > 0)
    .reduce<PathBucket[]>((result, bucket) => {
      const existing = result.find(
        (item) => normalizeBucketKey(item.diversityKey) === normalizeBucketKey(bucket.diversityKey)
      );
      if (existing) {
        existing.matchedItems.push(...bucket.matchedItems);
        existing.keywords = unique([...existing.keywords, ...bucket.keywords]);
        existing.variables = unique([...existing.variables, ...bucket.variables]).slice(0, 6);
        return result;
      }

      result.push(bucket);
      return result;
    }, []);

  return ensureMinimumPathBuckets(combined, buckets, items).slice(0, 5);
}

function buildMetadataPathBuckets(
  query: string,
  items: SearchItem[],
  qualityByItemId: Map<string, DemoCandidateQuality>
): PathBucket[] {
  const buckets = new Map<string, PathBucket>();

  for (const [index, item] of items.entries()) {
    const quality = qualityByItemId.get(item.id);
    const hasTaskTwoSignals = Boolean(
      quality?.diversityKey ||
        quality?.summaryAngle ||
        quality?.relationToUserIntent ||
        quality?.keepReason ||
        item.diversityKey ||
        item.summaryAngle ||
        item.relationToUserIntent ||
        item.keepReason
    );
    if (!hasTaskTwoSignals) {
      continue;
    }

    const bucket = toMetadataPathBucket(query, item, index, quality);
    const key = normalizeBucketKey(bucket.contentRole || bucket.diversityKey || bucket.summaryAngle || bucket.title);
    const existing = buckets.get(key);
    if (existing) {
      existing.matchedItems.push(item);
      existing.keywords = unique([...existing.keywords, ...bucket.keywords]);
      existing.variables = unique([...existing.variables, ...bucket.variables]).slice(0, 6);
      continue;
    }

    buckets.set(key, bucket);
  }

  return Array.from(buckets.values()).sort(comparePathBuckets);
}

function toMetadataPathBucket(
  query: string,
  item: SearchItem,
  index: number,
  quality?: DemoCandidateQuality
): PathBucket {
  const role = readContentRole(quality?.contentRole ?? item.contentRole);
  const diversityKey =
    quality?.diversityKey ||
    item.diversityKey ||
    quality?.summaryAngle ||
    item.summaryAngle ||
    quality?.queryType ||
    item.queryType ||
    `candidate_${index + 1}`;
  const variables = inferPathVariables(item, quality, query);
  const summaryAngle = quality?.summaryAngle || item.summaryAngle || `提炼「${variables[0]}」里的选择和代价`;
  const title = buildPathTitle(role, diversityKey, variables, query);
  const tradeoff = buildPathTradeoff(role, variables, item, quality);
  const displayCopy = PATH_DISPLAY_COPY[role];

  return {
    id: `path_${hashId(`${normalizeBucketKey(diversityKey)}:${index}:${item.id || item.url}`)}`,
    title,
    summary: buildPathSummary(role, variables, query),
    whyRelevant:
      quality?.relationToUserIntent ||
      item.relationToUserIntent ||
      `它回应的是「${truncateText(query, 28)}」里真正卡住的部分：${variables
        .slice(0, 2)
        .join("、") || "下一步怎么判断"}。`,
    tradeoff,
    displayLabel: displayCopy.title,
    displayTradeoff: displayCopy.tradeoff,
    diversityKey,
    summaryAngle,
    contentRole: role,
    keywords: unique([diversityKey, summaryAngle, ...variables, item.title, item.matchedQuery ?? ""]),
    variables,
    stance: role === "viewpoint" ? "viewpoint" : role === "decision_conflict" ? "mixed" : "experience",
    matchedItems: [item]
  };
}

function toPathBucket(plan: DemoPathPlan, query: string): PathBucket {
  return {
    id: plan.id,
    title: plan.title,
    summary: plan.summary,
    whyRelevant: `它回应的是「${truncateText(query, 28)}」里关于${plan.variables
      .slice(0, 2)
      .join("、")}的困惑，而不是把一篇回答重新摘要一遍。`,
    tradeoff: buildPlanTradeoff(plan),
    diversityKey: plan.variables[0] ?? plan.id,
    summaryAngle: plan.summary,
    keywords: plan.keywords,
    variables: plan.variables,
    stance: plan.stance,
    matchedItems: []
  };
}

function toPath(
  bucket: PathBucket,
  sourceByItemId: Map<string, DemoSourceRef>,
  query: string,
  userContext?: UserContext
): DemoPath {
  const sourceItems = bucket.matchedItems.slice(0, 3);
  const sourceRefs = unique(
    sourceItems
      .map((item) => sourceByItemId.get(item.id)?.id)
      .filter((sourceRef): sourceRef is string => Boolean(sourceRef))
  );
  const evidenceIds = unique(
    sourceItems.flatMap((item) => sourceByItemId.get(item.id)?.evidenceIds ?? [])
  );
  const personRefs = sourceItems.map((item, index) =>
    toPersonId(item, `${bucket.id}_${index}`)
  );
  const whyRelevant = bucket.whyRelevant || buildContextFitReason(query, userContext, bucket.title);
  const tradeoff = bucket.tradeoff || buildFallbackTradeoff(bucket.variables);
  const role = bucket.contentRole ?? stanceToContentRole(bucket.stance);
  const displayCopy = PATH_DISPLAY_COPY[role];

  return {
    id: bucket.id,
    title: bucket.contentRole ? displayCopy.title : bucket.title,
    summary: bucket.contentRole ? displayCopy.summary : bucket.summary,
    whyRelevant,
    tradeoff: bucket.contentRole ? displayCopy.tradeoff : tradeoff,
    displayLabel: bucket.displayLabel ?? (bucket.contentRole ? displayCopy.title : bucket.title),
    displayTradeoff: bucket.displayTradeoff ?? (bucket.contentRole ? displayCopy.tradeoff : tradeoff),
    fitReason: buildContextFitReason(query, userContext, bucket.title),
    diversityKey: bucket.diversityKey,
    contentRole: role,
    stance: sourceItems.some((item) => classifySampleType(item) === "experience_sample")
      ? "mixed"
      : bucket.stance,
    personRefs,
    evidenceIds,
    sourceRefs
  };
}

function toPathCandidate(item: SearchItem, quality?: DemoCandidateQuality): DemoPathCandidate {
  return {
    id: item.id,
    title: item.title,
    text: [
      item.text || item.evidence.text || "",
      quality?.contentRole ?? item.contentRole ?? "",
      quality?.relationToUserIntent ?? item.relationToUserIntent ?? "",
      quality?.summaryAngle ?? item.summaryAngle ?? "",
      quality?.diversityKey ?? item.diversityKey ?? "",
      quality?.matchedQuery ?? item.matchedQuery ?? "",
      quality?.queryType ?? item.queryType ?? ""
    ].join("\n")
  };
}

function toPerson(
  item: SearchItem,
  index: number,
  pathId: string,
  path: DemoPath,
  sourceRef: DemoSourceRef,
  query: string,
  userContext?: UserContext,
  candidateQuality?: DemoCandidateQuality
): DemoPerson {
  const quality = candidateQuality ?? scoreSearchCandidate(query, item);
  const sampleType = classifySampleType(item, quality);
  const article = toArticle(item, sourceRef, query, quality);
  const personId = toPersonId(item, String(index));
  const personaId = `persona_${hashId(personId)}`;
  const displayName = item.author.name || "知乎用户";
  const variables = inferMatchedVariables(item, quality);
  const summary = buildPersonOneLine(path, item, quality, query);
  const roleLabel = toRole(sampleType, item.type, path);
  const relevanceReason = buildPersonRelevanceReason(query, path, item, quality);
  const contextFitReason = buildContextFitReason(
    query,
    userContext,
    variables.slice(0, 2).join("、") || path.title || item.title || "公开内容主题"
  );
  const matchScore = toMatchScore(quality, index);
  const match = {
    score: matchScore,
    level: toMatchLevel(matchScore),
    reasons: toMatchReasons(item, sampleType, quality, path),
    matchedVariables: variables,
    riskNotes: ["该样本只代表知乎公开内容片段，不能代表作者完整人生或长期结果"],
    contentRelevance: quality.relevanceScore,
    experienceSimilarity: quality.experienceSignalScore,
    evidenceQuality: quality.qualityScore,
    personaReadiness: toPersonaReadiness(item, quality),
    evidenceIds: sourceRef.evidenceIds,
    sourceRefs: [sourceRef.id]
  } satisfies DemoPerson["match"];
  const displayTier = toDisplayTier(match);
  const evidenceStatus: DemoEvidenceStatus = "raw_snippet_only";
  const basePersonaEnabled = shouldEnablePersona(item, quality);
  const canChat = canPersonChat(basePersonaEnabled, match, quality);

  return {
    id: personId,
    name: displayName,
    sampleType,
    pathId,
    role: roleLabel,
    roleLabel,
    badge: toBadge(sampleType, path),
    displayTier,
    evidenceStatus,
    canChat,
    displayLabel: toDisplayLabel(displayTier),
    displayTradeoff: toDisplayTradeoff(displayTier, canChat, evidenceStatus, quality),
    avatar: item.author.avatar,
    oneLine: summary,
    experienceSummary: null,
    experienceSummarySource: "none",
    experienceSummaryStatus: "pending",
    matchedPathTitle: path.title,
    relevanceReason,
    fitReason: `${relevanceReason} ${contextFitReason}`,
    who: toWho(sampleType),
    overlaps: toOverlaps(item, quality, path),
    timeline: [
      {
        date: item.editTime > 0 ? "知乎公开内容更新时间" : "公开内容片段",
        event: buildTimelineEvent(path, item, summary),
        evidenceIds: sourceRef.evidenceIds,
        sourceRefs: [sourceRef.id]
      }
    ],
    lesson: toLesson(sampleType, path),
    articles: [article],
    match,
    aiPersona: {
      enabled: basePersonaEnabled,
      canChat,
      evidenceStatus,
      displayLabel: canChat ? "可追问的经验回声" : "仅查看来源片段",
      displayTradeoff: toDisplayTradeoff(displayTier, canChat, evidenceStatus, quality),
      personaId,
      displayName: `${displayName}的经验回声`,
      label: "基于公开内容生成",
      openingLine: toPersonaOpeningLine(path, sampleType),
      suggestedQuestions: toSuggestedQuestions(sampleType, path),
      boundary: DEMO_PERSONA_BOUNDARY_NOTICE,
      grounding: {
        personId,
        articleIds: [article.id],
        evidenceRequired: true,
        sourceRefs: [sourceRef.id]
      }
    },
    evidenceIds: sourceRef.evidenceIds,
    sourceRefs: [sourceRef.id]
  };
}

function toPersona(person: DemoPerson): DemoPersona {
  return {
    id: person.aiPersona.personaId,
    personId: person.id,
    displayName: person.aiPersona.displayName,
    avatar: person.avatar,
    personaType: "experience_echo",
    canChat: person.canChat,
    displayTier: person.displayTier,
    evidenceStatus: person.evidenceStatus,
    displayLabel: person.canChat ? "可追问的经验回声" : "仅查看来源片段",
    displayTradeoff: person.displayTradeoff,
    intro: person.aiPersona.openingLine,
    fitReason: person.fitReason,
    boundaryNotice: DEMO_PERSONA_BOUNDARY_NOTICE,
    sourceRefs: person.sourceRefs,
    suggestedQuestions: person.aiPersona.suggestedQuestions
  };
}

function buildDisplaySections(
  paths: DemoPath[],
  people: DemoPerson[],
  personas: DemoPersona[]
): DemoSearchResponse["sections"] {
  const corePeople = people.filter((person) => person.displayTier === "core");
  const supplementPeople = people.filter((person) => person.displayTier !== "core");
  const chatPersonas = personas.filter((persona) => persona.canChat === true);
  const sourceOnlyPersonas = personas.filter((persona) => persona.canChat !== true);

  return [
    {
      id: "section_paths",
      type: "paths",
      title: "参考路径",
      itemRefs: paths.map((path) => path.id)
    },
    {
      id: "section_core_people",
      type: "people",
      title: "较匹配的公开经历",
      itemRefs: corePeople.map((person) => person.id)
    },
    {
      id: "section_supplement_people",
      type: "people",
      title: "补充参考样本",
      itemRefs: supplementPeople.map((person) => person.id)
    },
    {
      id: "section_chat_personas",
      type: "personas",
      title: "可追问的经验回声",
      itemRefs: chatPersonas.map((persona) => persona.id)
    },
    {
      id: "section_source_only_personas",
      type: "personas",
      title: "仅查看来源片段",
      itemRefs: sourceOnlyPersonas.map((persona) => persona.id)
    }
  ];
}

function toArticle(
  item: SearchItem,
  sourceRef: DemoSourceRef,
  query: string,
  quality?: DemoCandidateQuality
): DemoArticle {
  const evidence = toEvidence(item, sourceRef, query, quality);
  const sourceSnippet = selectSourceSnippet({
    query,
    title: item.title,
    text: item.text || item.evidence.text || item.title,
    quality,
    maxLength: 260
  });
  const evidenceText = buildRawEvidenceText({
    evidenceText: evidence[0]?.text,
    summary: toHumanSummary(sourceSnippet),
    text: sourceSnippet
  });

  return {
    id: `article_${hashId(item.id || item.url || item.title)}`,
    title: item.title || "未命名知乎内容",
    text: item.text,
    url: item.url,
    author: item.author.name || "知乎用户",
    avatar: item.author.avatar,
    sourceName: item.type || "知乎内容",
    sourceUrl: item.url,
    summary: toHumanSummary(sourceSnippet),
    evidenceStatus: "raw_snippet_only",
    evidenceText,
    evidence,
    body: evidence.map((itemEvidence) => ({
      type: "evidence",
      text: itemEvidence.text,
      evidenceIds: [itemEvidence.id],
      sourceRefs: [sourceRef.id]
    })),
    sourceRefs: [sourceRef.id]
  };
}

function toEvidence(
  item: SearchItem,
  sourceRef: DemoSourceRef,
  query: string,
  quality?: DemoCandidateQuality
): DemoEvidence[] {
  return [
    {
      id: sourceRef.evidenceIds[0],
      label: "来源片段",
      text: toEvidenceQuote(item.text || item.evidence.text || item.title, item.title, query, quality),
      sourceRefId: sourceRef.id,
      sourceUrl: item.url
    }
  ];
}

function toSourceRef(item: SearchItem, index: number): DemoSourceRef {
  const sourceId = `source_${hashId(item.id || item.url || String(index))}`;

  return {
    id: sourceId,
    provider: "zhihu",
    type: "zhihu_answer",
    title: item.title || "未命名知乎内容",
    url: item.url,
    author: item.author.name || "知乎用户",
    evidenceIds: [`ev_${hashId(`${sourceId}:${item.text || item.title}`)}`]
  };
}

function attachSourceRefsToCandidateQuality(
  query: string,
  items: SearchItem[],
  candidateQuality: DemoCandidateQuality[] | undefined,
  sourceByItemId: Map<string, DemoSourceRef>
): DemoCandidateQuality[] {
  const usedItemIds = new Set(items.map((item) => item.id));
  const fallbackQuality = items.map((item) => scoreSearchCandidate(query, item));

  return (candidateQuality ?? fallbackQuality).map((candidate) => {
    const sourceRef = sourceByItemId.get(candidate.candidateId);
    const usedAsEvidence = usedItemIds.has(candidate.candidateId);
    return {
      ...candidate,
      sourceRefId: sourceRef?.id ?? candidate.sourceRefId,
      usedAsEvidence,
      filterReason:
        usedAsEvidence && !candidate.filterReason.startsWith("used_as_core_evidence")
          ? `used_as_core_evidence: ${candidate.filterReason}`
          : candidate.filterReason
    };
  });
}

function comparePathBuckets(left: PathBucket, right: PathBucket): number {
  return right.matchedItems.length - left.matchedItems.length || left.title.localeCompare(right.title);
}

function ensureMinimumPathBuckets(
  buckets: PathBucket[],
  fallbackBuckets: PathBucket[],
  items: SearchItem[]
): PathBucket[] {
  const result = [...buckets];
  const seenIds = new Set(result.map((bucket) => bucket.id));

  for (const fallbackBucket of fallbackBuckets) {
    if (result.length >= 3 || seenIds.has(fallbackBucket.id)) {
      continue;
    }

    result.push({
      ...fallbackBucket,
      matchedItems:
        fallbackBucket.matchedItems.length > 0
          ? fallbackBucket.matchedItems
          : items.length > 0
            ? [items[result.length % items.length]]
            : []
    });
    seenIds.add(fallbackBucket.id);
  }

  return result.filter((bucket) => bucket.matchedItems.length > 0);
}

function readContentRole(value: unknown): DemoContentRole {
  if (
    value === "real_experience" ||
    value === "life_path" ||
    value === "failure_review" ||
    value === "decision_conflict" ||
    value === "alternative_solution" ||
    value === "viewpoint"
  ) {
    return value;
  }

  return "life_path";
}

function inferPathVariables(
  item: SearchItem,
  quality: DemoCandidateQuality | undefined,
  query: string
): string[] {
  const variables = unique([
    ...(quality?.relevanceSignals ?? []),
    ...(quality?.specificitySignals ?? []),
    ...(quality?.matchedQueries?.map((entry) => entry.query) ?? []),
    quality?.diversityKey ?? item.diversityKey ?? "",
    quality?.summaryAngle ?? item.summaryAngle ?? "",
    item.matchedQuery ?? "",
    query
  ]
    .flatMap(splitSignalText)
    .map((signal) => signal.replace(/(真实经历|失败复盘|怎么选|怎么办|后来怎么样)$/g, "").trim())
    .filter((signal) => signal.length >= 2 && signal.length <= 12 && isPublicDisplaySignal(signal)));

  return variables.length > 0 ? variables.slice(0, 6) : ["当前问题", "代价边界", "下一步"];
}

function buildPathTitle(
  role: DemoContentRole,
  _diversityKey: string,
  _variables: string[],
  _query: string
): string {
  return PATH_DISPLAY_COPY[role].title;
}

function buildPathSummary(
  role: DemoContentRole,
  variables: string[],
  query: string
): string {
  const first = variables[0] ?? "当前问题";
  const base = PATH_DISPLAY_COPY[role].summary;

  return truncateText(
    `${base} 它回应「${truncateText(query, 24)}」时，优先看${first}这类可被来源片段支撑的信息。`,
    150
  );
}

function buildPathTradeoff(
  role: DemoContentRole,
  variables: string[],
  item: SearchItem,
  quality?: DemoCandidateQuality
): string {
  void variables;
  void item;
  void quality;

  return truncateText(PATH_DISPLAY_COPY[role].tradeoff, 150);
}

function buildPlanTradeoff(plan: DemoPathPlan): string {
  const variables = plan.variables;
  return buildFallbackTradeoff(variables);
}

function buildFallbackTradeoff(variables: string[]): string {
  const first = variables[0] ?? "这条路";
  const second = variables[1] ?? "现实成本";
  return `代价是${first}不会单独给出答案，仍要面对${second}和证据不足带来的不确定性。`;
}

function buildPersonOneLine(
  path: DemoPath,
  item: SearchItem,
  quality: DemoCandidateQuality,
  query: string
): string {
  void path;
  return selectSourceSnippet({
    query,
    title: item.title,
    text: item.text || item.evidence.text || item.title,
    quality,
    maxLength: 92
  });
}

function buildPersonRelevanceReason(
  query: string,
  path: DemoPath,
  item: SearchItem,
  quality: DemoCandidateQuality
): string {
  return truncateText(
    quality.relationToUserIntent ||
      item.relationToUserIntent ||
      `这个样本适合出现在「${truncateText(query, 24)}」下，是因为它代表「${path.title}」这条路径里的一个可追溯片段。`,
    120
  );
}

function buildTimelineEvent(path: DemoPath, item: SearchItem, summary: string): string {
  return truncateText(
    `${summary} 原文入口是「${item.title || "知乎公开内容"}」，当前只把它用作「${path.title}」的证据片段。`,
    120
  );
}

function classifySampleType(
  item: SearchItem,
  quality?: Pick<DemoCandidateQuality, "experienceSignalScore"> &
    Partial<Pick<CandidateAssessment, "adviceSignalScore">>
): "experience_sample" | "viewpoint_author" | "content_sample" {
  const text = `${item.title}\n${item.text}`;
  const firstPersonScore = ["我", "本人", "我的", "我们", "我从", "我在", "我当"].reduce(
    (total, keyword) => total + countIncludes(text, keyword),
    0
  );
  const adviceScore = ["建议", "应该", "可以", "先", "方法", "策略", "出路"].reduce(
    (total, keyword) => total + countIncludes(text, keyword),
    0
  );

  if (quality && quality.experienceSignalScore >= 0.42) {
    return "experience_sample";
  }

  if (firstPersonScore >= 2) {
    return "experience_sample";
  }

  if (
    quality &&
    (quality.adviceSignalScore ?? 0) >= 0.36 &&
    quality.experienceSignalScore < 0.35
  ) {
    return "viewpoint_author";
  }

  if (adviceScore >= 2) {
    return "viewpoint_author";
  }

  return "content_sample";
}

function toRole(sampleType: DemoPerson["sampleType"], contentType: string, path: DemoPath): string {
  const pathLabel = path.displayLabel || path.title;
  if (sampleType === "experience_sample") {
    return truncateText(`代表「${pathLabel}」的经历样本`, 40);
  }

  if (sampleType === "viewpoint_author") {
    return truncateText(`代表「${pathLabel}」的观点样本`, 40);
  }

  return truncateText(`代表「${pathLabel}」的${contentType || "知乎内容"}样本`, 40);
}

function toBadge(sampleType: DemoPerson["sampleType"], path: DemoPath): string {
  const pathBadge = truncateText(path.displayLabel || path.title, 12);
  if (pathBadge) {
    return pathBadge;
  }

  if (sampleType === "experience_sample") {
    return "更像亲历经验";
  }

  if (sampleType === "viewpoint_author") {
    return "更像观点分析";
  }

  return "内容样本";
}

function toWho(sampleType: DemoPerson["sampleType"]): string {
  if (sampleType === "experience_sample") {
    return "基于知乎公开回答整理出的经历样本，不等同于作者完整人生。";
  }

  if (sampleType === "viewpoint_author") {
    return "基于知乎公开回答整理出的观点样本，不能包装成作者亲历。";
  }

  return "基于知乎公开内容整理出的内容样本，真实性只限于公开内容片段。";
}

function toOverlaps(item: SearchItem, quality: DemoCandidateQuality | undefined, path: DemoPath): string[] {
  const variables = inferMatchedVariables(item, quality).slice(0, 3);
  return unique([
    `都在回应「${path.title}」这条路径`,
    ...(path.whyRelevant ? [truncateText(path.whyRelevant, 42)] : []),
    ...variables.map((variable) => `都涉及「${variable}」这个选择变量`)
  ]).slice(0, 4);
}

function inferMatchedVariables(item: SearchItem, quality?: DemoCandidateQuality): string[] {
  const dynamicSignals = [
    ...(quality?.relevanceSignals ?? []),
    ...(quality?.specificitySignals ?? []),
    ...(quality?.matchedQueries?.map((query) => query.query) ?? []),
    item.matchedQuery ?? "",
    item.diversityKey ?? "",
    item.summaryAngle ?? ""
  ]
    .flatMap(splitSignalText)
    .map((signal) => signal.replace(/(真实经历|失败复盘|怎么选|怎么办|后来怎么样)$/g, "").trim())
    .filter((signal) => signal.length >= 2 && signal.length <= 12 && isPublicDisplaySignal(signal));

  return unique(dynamicSignals).slice(0, 6).length > 0
    ? unique(dynamicSignals).slice(0, 6)
    : ["公开内容主题"];
}

function toMatchReasons(
  item: SearchItem,
  sampleType: DemoPerson["sampleType"],
  quality: Pick<
    DemoCandidateQuality,
    "filterReason" | "contentLength" | "relationToUserIntent" | "keepReason"
  >,
  path: DemoPath
): string[] {
  const variables = inferMatchedVariables(item, quality as DemoCandidateQuality).slice(0, 2);
  const prefix =
    sampleType === "experience_sample"
      ? "公开内容中出现了第一人称经历线索"
      : sampleType === "viewpoint_author"
        ? "公开内容更像对选择路径的观点分析"
        : "公开内容提供了与问题相关的片段";

  return unique([
    `它被放入「${path.title}」，不是普通作者列表`,
    quality.relationToUserIntent ?? "",
    prefix,
    `与当前问题共同涉及：${variables.join("、")}`,
    quality.contentLength >= 180
      ? "来源片段相对完整，可以支持基础对照"
      : "来源片段较短，只适合先作为补充参考"
  ].filter(Boolean)).slice(0, 4);
}

function toMatchScore(
  quality: Pick<DemoCandidateQuality, "relevanceScore" | "qualityScore" | "experienceSignalScore">,
  index: number
): number {
  return clampScore(
    0.28 +
      quality.relevanceScore * 0.28 +
      quality.qualityScore * 0.26 +
      quality.experienceSignalScore * 0.22 -
      Math.min(index, 5) * 0.01
  );
}

function toMatchLevel(score: number): "low" | "medium" | "high" {
  if (score >= 0.72) {
    return "high";
  }

  return score >= 0.5 ? "medium" : "low";
}

function toPersonaReadiness(
  item: SearchItem,
  quality: Pick<DemoCandidateQuality, "qualityScore" | "experienceSignalScore">
): number {
  if (!item.text || !item.url) {
    return 0.28;
  }

  return clampScore(quality.qualityScore * 0.54 + quality.experienceSignalScore * 0.46);
}

function shouldEnablePersona(
  item: SearchItem,
  quality: Pick<DemoCandidateQuality, "qualityScore" | "experienceSignalScore" | "contentLength">
): boolean {
  return Boolean(
    item.text &&
      item.url &&
      quality.contentLength >= 50 &&
      quality.qualityScore >= 0.42 &&
      quality.experienceSignalScore >= 0.28
  );
}

function toLesson(sampleType: DemoPerson["sampleType"], path: DemoPath): string {
  const tradeoff = truncateText(path.tradeoff || "代价边界", 42);
  if (sampleType === "experience_sample") {
    return `真正有价值的不是选择本身，而是这段内容把「${tradeoff}」说了出来。`;
  }

  if (sampleType === "viewpoint_author") {
    return `它能提供变量拆解，但不能被包装成作者完整亲历；重点仍是「${tradeoff}」。`;
  }

  return `这条内容只能作为「${path.title}」的线索，仍需要更多证据才能形成稳定判断。`;
}

function toPersonaOpeningLine(path: DemoPath, sampleType: DemoPerson["sampleType"]): string {
  const focus = path.displayLabel || path.title;
  const cost = truncateText(path.tradeoff || "代价和边界", 30);

  if (sampleType === "experience_sample") {
    return truncateText(`我只能沿着这段公开内容聊：这条路先碰到的是${focus}，后来绕不开${cost}。`, 88);
  }

  if (sampleType === "viewpoint_author") {
    return truncateText(`我会把它当成公开观点样本来聊：它能拆开${focus}，但不能替代真实亲历。`, 88);
  }

  return truncateText(`我只能基于这段内容片段聊：先看${focus}能被证据支撑到哪里。`, 88);
}

function toSuggestedQuestions(sampleType: DemoPerson["sampleType"], path: DemoPath): string[] {
  const focus = truncateText(path.displayLabel || path.title, 14);
  const baseQuestions = [
    `这条路解决了什么问题？`,
    `它把什么代价放大了？`
  ];

  if (sampleType === "experience_sample") {
    return [`这段经历里，${focus}怎么发生的？`, ...baseQuestions].slice(0, 3);
  }

  if (sampleType === "viewpoint_author") {
    return [`这段观点里，${focus}有哪些证据？`, `哪些判断不能当成亲历？`, baseQuestions[1]];
  }

  return [`这段内容能支撑${focus}到哪一步？`, "还缺哪些关键证据？", baseQuestions[1]];
}

function toHumanSummary(text: string): string {
  const normalized = normalizeText(text);
  if (normalized.length <= 60) {
    return normalized;
  }

  return `${normalized.slice(0, 58)}...`;
}

function selectSourceSnippet(input: {
  query: string;
  title: string;
  text: string;
  quality?: DemoCandidateQuality;
  maxLength: number;
}): string {
  const normalized = normalizeText(input.text || input.title);
  if (normalized.length <= input.maxLength) {
    return normalized;
  }

  const sentences = splitSentences(normalized);
  const keywords = buildSnippetKeywords(input.query, input.title, input.quality);
  const scored = sentences
    .map((sentence, index) => ({
      sentence,
      index,
      score: scoreSnippetSentence(sentence, keywords)
    }))
    .sort((left, right) => right.score - left.score || left.index - right.index);
  const best = scored[0];

  if (!best || best.score <= 0) {
    return truncateText(normalized, input.maxLength);
  }

  const previous = sentences[best.index - 1] ?? "";
  const next = sentences[best.index + 1] ?? "";
  const candidates = [
    best.sentence,
    `${best.sentence}${next}`,
    `${previous}${best.sentence}`,
    `${previous}${best.sentence}${next}`
  ].map(normalizeText);
  const selected =
    candidates.find((candidate) => candidate.length >= 34 && candidate.length <= input.maxLength) ||
    best.sentence;

  return truncateText(selected, input.maxLength);
}

function splitSentences(text: string): string[] {
  const normalized = normalizeText(text);
  const matches = normalized.match(/[^。！？!?；;]+[。！？!?；;]?/g) ?? [normalized];
  const sentences = matches
    .map((item) => normalizeText(item))
    .filter((item) => item.length >= 8);

  if (sentences.length > 0) {
    return sentences;
  }

  const chunks: string[] = [];
  for (let index = 0; index < normalized.length; index += 120) {
    chunks.push(normalized.slice(index, index + 140));
  }
  return chunks.filter(Boolean);
}

function buildSnippetKeywords(
  query: string,
  title: string,
  quality?: DemoCandidateQuality
): string[] {
  const scenarioKeywords = /稳定|安稳|体制内|铁饭碗|稳定工作|稳定收入/.test(query) &&
    /喜欢|热爱|兴趣|梦想|理想|想做的事|追求/.test(query)
    ? ["稳定", "稳定工作", "放弃", "喜欢的事", "热爱", "兴趣", "梦想", "后悔", "现实", "选择"]
    : [];
  return unique([
    ...scenarioKeywords,
    ...splitSignalText(query),
    ...splitSignalText(title),
    ...(quality?.relevanceSignals ?? []),
    ...(quality?.narrativeSignals ?? []),
    ...(quality?.specificitySignals ?? []),
    ...(quality?.matchedQueries?.flatMap((item) => splitSignalText(item.query)) ?? [])
  ])
    .map((item) => item.replace(/(真实经历|失败复盘|后来怎么样|有哪些路径|怎么开始|怎么选|怎么办)$/g, ""))
    .map((item) => item.trim())
    .filter((item) => item.length >= 2 && item.length <= 12 && isPublicDisplaySignal(item))
    .slice(0, 18);
}

function scoreSnippetSentence(sentence: string, keywords: string[]): number {
  const keywordScore = keywords.reduce((total, keyword) => total + countIncludes(sentence, keyword) * 5, 0);
  const firstPersonScore = /我|本人|自己|我们/.test(sentence) ? 5 : 0;
  const processScore = /选择|决定|放弃|开始|后来|最后|结果|后悔|代价|现实|稳定|热爱|兴趣|梦想/.test(sentence)
    ? 4
    : 0;
  const advicePenalty = /建议|应该|最好|方法|技巧|私信|课程|报名|咨询/.test(sentence) ? 3 : 0;
  const lengthScore = sentence.length >= 28 && sentence.length <= 180 ? 2 : 0;

  return keywordScore + firstPersonScore + processScore + lengthScore - advicePenalty;
}

function toEvidenceQuote(
  text: string,
  title: string,
  query: string,
  quality?: DemoCandidateQuality
): string {
  return selectSourceSnippet({
    query,
    title,
    text,
    quality,
    maxLength: 180
  });
}

function buildRawEvidenceText(input: {
  evidenceText?: string;
  summary?: string;
  text?: string;
}): string {
  return truncateText(
    input.evidenceText || input.summary || normalizeText(input.text ?? "").slice(0, 260),
    260
  );
}

function toDisplayTier(match: DemoPerson["match"]): DemoDisplayTier {
  return (match.level === "high" || match.level === "medium") &&
    match.evidenceQuality >= 0.65 &&
    match.contentRelevance >= 0.25
    ? "core"
    : "supplement";
}

function canPersonChat(
  aiPersonaEnabled: boolean,
  match: DemoPerson["match"],
  quality?: Pick<
    DemoCandidateQuality,
    "penaltySignals" | "filterReason" | "penaltyScore" | "contentRole" | "queryType"
  >
): boolean {
  return Boolean(
    aiPersonaEnabled &&
      match.personaReadiness >= 0.65 &&
      match.evidenceQuality >= 0.65 &&
      match.contentRelevance >= 0.25 &&
      quality?.contentRole !== "viewpoint" &&
      quality?.queryType !== "original" &&
      !hasAdMarketingPenalty(quality, match)
  );
}

function hasAdMarketingPenalty(
  quality: Pick<DemoCandidateQuality, "penaltySignals" | "filterReason" | "penaltyScore"> | undefined,
  match?: Pick<DemoPerson["match"], "riskNotes">
): boolean {
  const text = [
    ...(quality?.penaltySignals ?? []),
    quality?.filterReason ?? "",
    ...(match?.riskNotes ?? [])
  ].join(" ");

  return /广告营销|加微信|私信|报名|课程|咨询|推广|带货/.test(text);
}

function toDisplayLabel(displayTier: DemoDisplayTier): string {
  return displayTier === "core" ? "较匹配的公开经历" : "补充参考样本";
}

function toDisplayTradeoff(
  displayTier: DemoDisplayTier,
  canChat: boolean,
  evidenceStatus: DemoEvidenceStatus,
  quality?: Pick<DemoCandidateQuality, "penaltySignals" | "filterReason" | "penaltyScore">
): string {
  if (canChat) {
    return "证据和相关度达到追问门槛，可基于来源片段继续理解这段公开经历。";
  }

  if (hasAdMarketingPenalty(quality)) {
    return "内容含广告或营销风险，只保留为补充参考，不开放追问。";
  }

  if (evidenceStatus === "raw_snippet_only") {
    return "当前只拿到来源片段，适合先看原文线索，不包装成完整经历。";
  }

  return displayTier === "core"
    ? "证据可用于展示，但追问门槛暂未达到，建议先查看来源片段。"
    : "相关度或证据质量不足，只作为补充参考展示。";
}

function stanceToContentRole(stance: DemoPath["stance"]): DemoContentRole {
  if (stance === "viewpoint") {
    return "viewpoint";
  }

  if (stance === "experience") {
    return "real_experience";
  }

  return "life_path";
}

function isPublicDisplaySignal(value: string): boolean {
  return !/roughTier|roughScore|diversityKey|contentRole|keepReason|used_as_core_evidence|ranked_|downranked|规则兜底|兜底保留|保留用户|保留候选|候选质量/i.test(value);
}

function normalizeText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function truncateText(text: string, maxLength: number): string {
  const normalized = normalizeText(text);
  if (normalized.length <= maxLength) {
    return normalized;
  }

  return `${normalized.slice(0, Math.max(0, maxLength - 3))}...`;
}

function normalizeBucketKey(text: string): string {
  return normalizeText(text)
    .replace(/[，。！？、,.!?\s/|:：；;（）()《》"“”]+/g, "")
    .toLowerCase();
}

function splitSignalText(value: string): string[] {
  const normalized = normalizeText(value).replace(/\s+/g, "");
  if (!normalized) {
    return [];
  }

  const parts = normalized
    .split(/[，。！？、,.!?\s/|:：；;（）()《》"“”]+/)
    .map((item) => item.trim())
    .filter(Boolean);

  return unique([normalized, ...parts]);
}

function countIncludes(text: string, keyword: string): number {
  return text.includes(keyword.toLowerCase()) || text.includes(keyword) ? 1 : 0;
}

function unique(values: string[]): string[] {
  return Array.from(new Set(values));
}

function toPersonId(item: SearchItem, fallback: string): string {
  return `person_${hashId(item.id || item.url || fallback)}`;
}

function clampScore(value: number): number {
  return Math.min(Math.max(Number(value.toFixed(2)), 0), 1);
}

function hashId(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }

  return (hash >>> 0).toString(16);
}
