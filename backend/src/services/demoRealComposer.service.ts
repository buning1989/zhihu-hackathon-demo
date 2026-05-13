import {
  DEMO_PERSONA_BOUNDARY_NOTICE,
  DEMO_SCHEMA_VERSION,
  type DemoArticle,
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
import { createDemoSearchIdentity } from "./demoQueryIdentity.service.js";
import { buildContextFitReason, createDemoContextUsed } from "./userContext.service.js";

interface ComposeRealInput {
  query: string;
  count: number;
  dataMode: DemoDataMode;
  items: SearchItem[];
  startedAt: number;
  userContext?: UserContext;
}

interface PathBucket {
  id: string;
  title: string;
  summary: string;
  keywords: string[];
  variables: string[];
  stance: DemoPath["stance"];
  matchedItems: SearchItem[];
}

export function composeRealDemoSearchResponse(input: ComposeRealInput): DemoSearchResponse {
  const limitedItems = input.items.slice(0, Math.min(Math.max(input.count, 1), 12));
  const identity = createDemoSearchIdentity(input.query, {
    count: input.count,
    dataMode: input.dataMode
  });
  const pathCandidates = limitedItems.map(toPathCandidate);
  const buckets = groupItemsByPath(input.query, limitedItems, pathCandidates);
  const sourceRefs = limitedItems.map(toSourceRef);
  const sourceByItemId = new Map(limitedItems.map((item, index) => [item.id, sourceRefs[index]]));
  const paths = buckets.map((bucket) => toPath(bucket, sourceByItemId, input.query, input.userContext));
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
      sourceByItemId.get(item.id)!,
      input.query,
      input.userContext
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
  candidates: DemoPathCandidate[]
): PathBucket[] {
  const pathPlans = buildQueryAwarePathPlans(query, candidates, 4);
  const buckets = pathPlans.map(toPathBucket);

  let fallbackIndex = 0;
  for (const item of items) {
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

  return buckets
    .filter((bucket) => bucket.matchedItems.length > 0)
    .slice(0, 4);
}

function toPathBucket(plan: DemoPathPlan): PathBucket {
  return {
    id: plan.id,
    title: plan.title,
    summary: plan.summary,
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
  const sourceRefs = unique(
    bucket.matchedItems
      .map((item) => sourceByItemId.get(item.id)?.id)
      .filter((sourceRef): sourceRef is string => Boolean(sourceRef))
  );
  const evidenceIds = unique(
    bucket.matchedItems.flatMap((item) => sourceByItemId.get(item.id)?.evidenceIds ?? [])
  );
  const personRefs = bucket.matchedItems.map((item, index) =>
    toPersonId(item, `${bucket.id}_${index}`)
  );

  return {
    id: bucket.id,
    title: bucket.title,
    summary: `${bucket.summary} 该路径来自 ${bucket.matchedItems.length} 条知乎公开内容的聚合。`,
    fitReason: buildContextFitReason(query, userContext, bucket.title),
    stance: bucket.matchedItems.some((item) => classifySampleType(item) === "experience_sample")
      ? "mixed"
      : bucket.stance,
    personRefs,
    evidenceIds,
    sourceRefs
  };
}

function toPathCandidate(item: SearchItem): DemoPathCandidate {
  return {
    id: item.id,
    title: item.title,
    text: item.text || item.evidence.text || ""
  };
}

function toPerson(
  item: SearchItem,
  index: number,
  pathId: string,
  sourceRef: DemoSourceRef,
  query: string,
  userContext?: UserContext
): DemoPerson {
  const sampleType = classifySampleType(item);
  const article = toArticle(item, sourceRef);
  const personId = toPersonId(item, String(index));
  const personaId = `persona_${hashId(personId)}`;
  const displayName = item.author.name || "知乎用户";
  const summary = toHumanSummary(item.text || item.title);

  return {
    id: personId,
    name: displayName,
    sampleType,
    pathId,
    role: toRole(sampleType, item.type),
    badge: toBadge(sampleType),
    avatar: item.author.avatar,
    oneLine: summary,
    fitReason: buildContextFitReason(
      query,
      userContext,
      inferMatchedVariables(item).slice(0, 2).join("、") || item.title || "公开内容主题"
    ),
    who: toWho(sampleType),
    overlaps: toOverlaps(item),
    timeline: [
      {
        date: item.editTime > 0 ? "知乎公开内容更新时间" : "公开内容片段",
        event: summary,
        evidenceIds: sourceRef.evidenceIds,
        sourceRefs: [sourceRef.id]
      }
    ],
    lesson: toLesson(sampleType),
    articles: [article],
    match: {
      score: clampScore(0.72 + Math.min(index, 5) * 0.03),
      level: index < 4 ? "high" : "medium",
      reasons: toMatchReasons(item, sampleType),
      matchedVariables: inferMatchedVariables(item),
      riskNotes: ["该样本只代表知乎公开内容片段，不能代表作者完整人生或长期结果"],
      contentRelevance: item.text ? 0.84 : 0.62,
      experienceSimilarity: sampleType === "experience_sample" ? 0.82 : 0.58,
      evidenceQuality: item.url && item.text ? 0.82 : 0.55,
      personaReadiness: item.text && item.url ? 0.78 : 0.48,
      evidenceIds: sourceRef.evidenceIds,
      sourceRefs: [sourceRef.id]
    },
    aiPersona: {
      enabled: Boolean(item.text && item.url),
      personaId,
      displayName: `${displayName}的经验回声`,
      label: "基于公开内容生成",
      openingLine: "你可以继续问这段公开内容里的选择、代价和边界。",
      suggestedQuestions: toSuggestedQuestions(sampleType),
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

function classifySampleType(item: SearchItem): "experience_sample" | "viewpoint_author" | "content_sample" {
  const text = `${item.title}\n${item.text}`;
  const firstPersonScore = ["我", "本人", "我的", "我们", "我从", "我在", "我当"].reduce(
    (total, keyword) => total + countIncludes(text, keyword),
    0
  );
  const adviceScore = ["建议", "应该", "可以", "先", "方法", "策略", "出路"].reduce(
    (total, keyword) => total + countIncludes(text, keyword),
    0
  );

  if (firstPersonScore >= 2) {
    return "experience_sample";
  }

  if (adviceScore >= 2) {
    return "viewpoint_author";
  }

  return "content_sample";
}

function toRole(sampleType: DemoPerson["sampleType"], contentType: string): string {
  if (sampleType === "experience_sample") {
    return "公开经历样本";
  }

  if (sampleType === "viewpoint_author") {
    return "公开观点作者";
  }

  return `${contentType || "知乎内容"}样本`;
}

function toBadge(sampleType: DemoPerson["sampleType"]): string {
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

function toOverlaps(item: SearchItem): string[] {
  const variables = inferMatchedVariables(item).slice(0, 3);
  return variables.map((variable) => `都涉及「${variable}」这个选择变量`);
}

function inferMatchedVariables(item: SearchItem): string[] {
  const text = `${item.title}\n${item.text}`;
  const variables = [
    ["生活节奏", ["生活", "每天", "做饭", "散步", "户外", "休息"]],
    ["现金流", ["收入", "副业", "赚钱", "存款", "现金流", "自由职业"]],
    ["地点选择", ["小城市", "回老家", "旅行", "城市", "县城", "海边"]],
    ["风险兜底", ["社保", "医保", "失业保险", "预算", "低保", "保障"]],
    ["工作回流", ["找工作", "面试", "上班", "就业", "考公", "岗位"]]
  ];
  const matched = variables
    .filter(([, keywords]) => (keywords as string[]).some((keyword) => text.includes(keyword)))
    .map(([label]) => label as string);

  return matched.length > 0 ? matched : ["公开内容主题"];
}

function toMatchReasons(item: SearchItem, sampleType: DemoPerson["sampleType"]): string[] {
  const variables = inferMatchedVariables(item).slice(0, 2);
  const prefix =
    sampleType === "experience_sample"
      ? "公开内容中出现了第一人称经历线索"
      : sampleType === "viewpoint_author"
        ? "公开内容更像对选择路径的观点分析"
        : "公开内容提供了与问题相关的片段";

  return [
    prefix,
    `与当前问题共同涉及：${variables.join("、")}`
  ];
}

function toLesson(sampleType: DemoPerson["sampleType"]): string {
  if (sampleType === "experience_sample") {
    return "可以先看这段公开经历里真实发生了什么，再判断是否可迁移。";
  }

  if (sampleType === "viewpoint_author") {
    return "可以参考观点中的变量，但不要把它当作作者亲历结果。";
  }

  return "这条内容只能作为线索，需要更多证据才能形成稳定判断。";
}

function toSuggestedQuestions(sampleType: DemoPerson["sampleType"]): string[] {
  if (sampleType === "experience_sample") {
    return ["这段公开内容里，最明确的行动是什么？", "从这个公开样本看，最大的代价可能是什么？"];
  }

  if (sampleType === "viewpoint_author") {
    return ["这段公开内容里，哪些判断有原文依据？", "从这个公开样本看，哪些建议需要谨慎？"];
  }

  return ["这段公开内容里，可以确定的信息有哪些？", "从这个公开样本看，还缺哪些证据？"];
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
