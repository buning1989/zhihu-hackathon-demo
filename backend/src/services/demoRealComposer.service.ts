import {
  DEMO_PERSONA_BOUNDARY_NOTICE,
  DEMO_SCHEMA_VERSION,
  type DemoArticle,
  type DemoCandidateQuality,
  type DemoContentRole,
  type DemoDataMode,
  type DemoEvidence,
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
  diversityKey: string;
  summaryAngle?: string;
  contentRole?: DemoContentRole;
  keywords: string[];
  variables: string[];
  stance: DemoPath["stance"];
  matchedItems: SearchItem[];
}

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
    sections: [
      {
        id: "section_paths",
        type: "paths",
        title: "真实内容聚合出的路径",
        itemRefs: paths.map((path) => path.id)
      },
      {
        id: "section_people",
        type: "people",
        title: "来自知乎公开内容的样本",
        itemRefs: people.map((person) => person.id)
      },
      {
        id: "section_personas",
        type: "personas",
        title: "可追问的经验回声",
        itemRefs: personas.map((persona) => persona.id)
      }
    ],
    meta: {
      sourceRefs: sourceRefsForReturnedPeople,
      evidenceCount: sourceRefsForReturnedPeople.reduce(
        (total, sourceRef) => total + sourceRef.evidenceIds.length,
        0
      ),
      generatedAt: new Date().toISOString(),
      latencyMs: Date.now() - input.startedAt,
      fallbackUsed: false
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
    const key = normalizeBucketKey(bucket.diversityKey || bucket.summaryAngle || bucket.title);
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

  return {
    id: `path_${hashId(`${normalizeBucketKey(diversityKey)}:${index}:${item.id || item.url}`)}`,
    title,
    summary: buildPathSummary(title, summaryAngle, variables, item),
    whyRelevant:
      quality?.relationToUserIntent ||
      item.relationToUserIntent ||
      `它回应的是「${truncateText(query, 28)}」里真正卡住的部分：${variables
        .slice(0, 2)
        .join("、") || "下一步怎么判断"}。`,
    tradeoff,
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

  return {
    id: bucket.id,
    title: bucket.title,
    summary: bucket.summary,
    whyRelevant,
    tradeoff,
    fitReason: buildContextFitReason(query, userContext, bucket.title),
    diversityKey: bucket.diversityKey,
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
  const article = toArticle(item, sourceRef);
  const personId = toPersonId(item, String(index));
  const personaId = `persona_${hashId(personId)}`;
  const displayName = item.author.name || "知乎用户";
  const variables = inferMatchedVariables(item, quality);
  const summary = buildPersonOneLine(path, item, quality);
  const roleLabel = toRole(sampleType, item.type, path);
  const relevanceReason = buildPersonRelevanceReason(query, path, item, quality);
  const contextFitReason = buildContextFitReason(
    query,
    userContext,
    variables.slice(0, 2).join("、") || path.title || item.title || "公开内容主题"
  );

  return {
    id: personId,
    name: displayName,
    sampleType,
    pathId,
    role: roleLabel,
    roleLabel,
    badge: toBadge(sampleType, path),
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
    match: {
      score: toMatchScore(quality, index),
      level: toMatchLevel(toMatchScore(quality, index)),
      reasons: toMatchReasons(item, sampleType, quality, path),
      matchedVariables: variables,
      riskNotes: ["该样本只代表知乎公开内容片段，不能代表作者完整人生或长期结果"],
      contentRelevance: quality.relevanceScore,
      experienceSimilarity: quality.experienceSignalScore,
      evidenceQuality: quality.qualityScore,
      personaReadiness: toPersonaReadiness(item, quality),
      evidenceIds: sourceRef.evidenceIds,
      sourceRefs: [sourceRef.id]
    },
    aiPersona: {
      enabled: shouldEnablePersona(item, quality),
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
    intro: person.aiPersona.openingLine,
    fitReason: person.fitReason,
    boundaryNotice: DEMO_PERSONA_BOUNDARY_NOTICE,
    sourceRefs: person.sourceRefs,
    suggestedQuestions: person.aiPersona.suggestedQuestions
  };
}

function toArticle(item: SearchItem, sourceRef: DemoSourceRef): DemoArticle {
  const evidence = toEvidence(item, sourceRef);

  return {
    id: `article_${hashId(item.id || item.url || item.title)}`,
    title: item.title || "未命名知乎内容",
    text: item.text,
    url: item.url,
    author: item.author.name || "知乎用户",
    avatar: item.author.avatar,
    sourceName: item.type || "知乎内容",
    sourceUrl: item.url,
    summary: toHumanSummary(item.text || item.title),
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

function toEvidence(item: SearchItem, sourceRef: DemoSourceRef): DemoEvidence[] {
  return [
    {
      id: sourceRef.evidenceIds[0],
      label: "公开内容片段",
      text: toEvidenceQuote(item.text || item.title),
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
    .filter((signal) => signal.length >= 2 && signal.length <= 12));

  return variables.length > 0 ? variables.slice(0, 6) : ["当前问题", "代价边界", "下一步"];
}

function buildPathTitle(
  role: DemoContentRole,
  diversityKey: string,
  variables: string[],
  query: string
): string {
  const first = variables[0] || truncateText(diversityKey || query, 8);
  const second = variables.find((variable) => variable !== first) ?? "现实代价";
  const titleByRole: Record<DemoContentRole, string> = {
    real_experience: `有人把${first}先过了一遍`,
    life_path: `有人把${first}变成一段过渡`,
    failure_review: `有人走过${first}后回头复盘`,
    decision_conflict: `有人在${first}和${second}之间拉扯`,
    alternative_solution: `有人绕开原路先试${first}`,
    viewpoint: `有人把${first}拆成现实账本`
  };

  return truncateText(titleByRole[role], 34);
}

function buildPathSummary(
  title: string,
  summaryAngle: string,
  variables: string[],
  item: SearchItem
): string {
  const first = variables[0] ?? "当前问题";
  const second = variables[1] ?? "现实约束";
  const sourceHint = item.title ? `来源内容的切口是「${truncateText(item.title, 18)}」` : "来源内容只提供片段";

  return truncateText(
    `${title}。这条路围绕${summaryAngle}，先处理${first}，同时把${second}摆到台面上；${sourceHint}。`,
    150
  );
}

function buildPathTradeoff(
  role: DemoContentRole,
  variables: string[],
  item: SearchItem,
  quality?: DemoCandidateQuality
): string {
  const first = variables[0] ?? "这条路";
  const second = variables[1] ?? "现实成本";
  const roleCost: Record<DemoContentRole, string> = {
    real_experience: `代价是${second}会变得更具体，公开内容也只支撑到这段经历片段`,
    life_path: `限制是${first}不能自动解决后续收入、关系或秩序问题`,
    failure_review: `风险是复盘能提醒坑在哪里，但不能保证换个人照做就得到同样结果`,
    decision_conflict: `代价是两个方向都要放弃一部分确定性，冲突不会因为命名成路径就消失`,
    alternative_solution: `风险是绕路会降低原有稳定性，也可能让试错成本被低估`,
    viewpoint: `限制是它更像变量拆解，不等同于作者亲历过完整过程`
  };
  const keepReason = quality?.keepReason || item.keepReason;

  return truncateText([roleCost[role], keepReason].filter(Boolean).join("；"), 150);
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
  quality: DemoCandidateQuality
): string {
  const variables = inferMatchedVariables(item, quality);
  const focus = variables[0] ?? path.diversityKey ?? "这条路";
  return truncateText(
    `这个人提供的是「${path.title}」的样本，价值在于把${focus}和${truncateText(
      path.tradeoff ?? "代价边界",
      24
    )}放在一起看。`,
    90
  );
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
  const pathLabel = path.diversityKey || path.title;
  if (sampleType === "experience_sample") {
    return truncateText(`代表「${pathLabel}」的经历样本`, 40);
  }

  if (sampleType === "viewpoint_author") {
    return truncateText(`代表「${pathLabel}」的观点样本`, 40);
  }

  return truncateText(`代表「${pathLabel}」的${contentType || "知乎内容"}样本`, 40);
}

function toBadge(sampleType: DemoPerson["sampleType"], path: DemoPath): string {
  const pathBadge = truncateText(path.diversityKey || path.title, 12);
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
    .filter((signal) => signal.length >= 2 && signal.length <= 12);

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
    quality.keepReason ?? "",
    prefix,
    `与当前问题共同涉及：${variables.join("、")}`,
    `候选质量判断：${quality.filterReason}，正文长度 ${quality.contentLength} 字`
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
  const focus = path.diversityKey || path.title;
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
  const focus = truncateText(path.diversityKey || path.title, 14);
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

function toEvidenceQuote(text: string): string {
  const normalized = normalizeText(text);
  if (normalized.length <= 160) {
    return normalized;
  }

  return `${normalized.slice(0, 158)}...`;
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
