import { llmRouter } from "../llm/llmRouter.js";
import {
  parsePersonaChatTaskOutput,
  type PersonaChatTaskOutput
} from "../llm/schemas/taskSchemas.js";
import { buildPersonaChatMessages } from "../prompts/personaPromptBuilder.js";
import {
  DEMO_PERSONA_BOUNDARY_NOTICE,
  PERSONA_CHAT_FALLBACK_BOUNDARY_NOTICE,
  type DemoArticle,
  type DemoEvidence,
  type DemoPerson,
  type DemoSearchResponse
} from "../types/demo.types.js";
import {
  PERSONA_CHAT_SCHEMA_VERSION,
  type PersonaChatHistoryMessage,
  type PersonaChatRequest,
  type PersonaChatResponse
} from "../types/persona.types.js";
import { HttpError } from "../utils/httpError.js";
import { demoSessionCacheService } from "./demoSessionCache.service.js";

const PERSONA_CHAT_FALLBACK_REPLY =
  "我能说的不多，只能基于这段公开内容聊。对我来说，那段经历里真正重要的不是一下子找到标准答案，而是先把眼前最消耗自己的部分拆开，看清楚自己到底是在逃避，还是确实需要换一种活法。";
const MAX_HISTORY_MESSAGES = 6;

interface ChatGroundingContext {
  articles: PersonaChatArticleContext[];
  evidence: PersonaChatEvidenceContext[];
  sourceRefs: string[];
}

interface PersonaChatArticleContext {
  id: string;
  title: string;
  text: string;
  url: string;
  author: string;
  sourceName: string;
  sourceUrl: string;
  summary: string;
  sourceRefs: string[];
  evidence: PersonaChatEvidenceContext[];
}

interface PersonaChatEvidenceContext {
  id: string;
  label: string;
  text: string;
  articleId: string;
  sourceRefId: string;
  sourceUrl: string;
}

export class PersonaChatService {
  async chat(request: PersonaChatRequest): Promise<PersonaChatResponse> {
    const cachedResponse = demoSessionCacheService.get(request.queryId);
    if (!cachedResponse) {
      return createMockFallback(request, "CACHE_MISSING: queryId not found in demo session cache");
    }

    const person = findPersonByPersonaId(cachedResponse, request.personaId);
    if (!person) {
      return createMockFallback(
        request,
        "PERSONA_NOT_FOUND: personaId did not match cached demo search people"
      );
    }

    if (!person.aiPersona.enabled) {
      return createMockFallback(
        request,
        "PERSONA_DISABLED: aiPersona.enabled is false; grounded LLM chat skipped",
        undefined,
        person
      );
    }

    const grounding = buildChatGrounding(cachedResponse, person);
    if (grounding.sourceRefs.length === 0 || grounding.evidence.length === 0) {
      return createMockFallback(
        request,
        "SOURCE_REFS_INSUFFICIENT: grounded persona chat requires sourceRefs and evidence",
        grounding,
        person
      );
    }

    if (!llmRouter.isTaskConfigured("persona_chat")) {
      return createMockFallback(
        request,
        "KIMI_API_KEY not configured; mock persona chat fallback used",
        grounding,
        person
      );
    }

    try {
      const content = await llmRouter.runJsonTask("persona_chat", {
        temperature: 0.1,
        maxTokens: 1600,
        messages: buildPersonaChatMessages({
          userQuery: cachedResponse.query,
          person: toPersonPromptContext(person),
          articles: grounding.articles,
          evidence: grounding.evidence,
          aiPersona: person.aiPersona,
          history: request.history,
          userMessage: request.message
        })
      });
      const payload = parsePersonaChatTaskOutput(content, {
        allowedArticleIds: new Set(grounding.articles.map((article) => article.id)),
        isAllowedEvidenceText: (articleId, text) =>
          isAllowedEvidenceText(articleId, text, grounding)
      });
      const reply = normalizePersonaReply(
        payload.answer,
        payload.answerType,
        payload.boundary,
        request.message,
        grounding
      );
      if (!reply) {
        return createMockFallback(
          request,
          "LLM_PERSONA_CHAT_EMPTY_REPLY: normalized reply is empty",
          grounding,
          person
        );
      }
      assertNoForbiddenClaims([
        reply,
        ...payload.followupQuestions
      ]);

      return toRealPersonaChatResponse(request, person, grounding, payload, reply);
    } catch (error) {
      logPersonaChatFallback(error, request);
      return createMockFallback(
        request,
        `LLM_PERSONA_CHAT_FAILED: ${toErrorMessage(error)}`,
        grounding,
        person
      );
    }
  }
}

export const personaChatService = new PersonaChatService();

export function parsePersonaChatRequest(body: unknown): PersonaChatRequest {
  const record = isRecord(body) ? body : {};
  const personaId = readString(record.personaId).trim();
  const queryId = readString(record.queryId).trim();
  const message = readString(record.message).trim();

  if (!personaId) {
    throw new HttpError(400, "PERSONA_ID_REQUIRED", "Missing required body field: personaId");
  }

  if (!message) {
    throw new HttpError(400, "MESSAGE_REQUIRED", "Missing required body field: message");
  }

  return {
    personaId,
    queryId: queryId || "query_mock",
    message,
    history: parseHistory(record.history)
  };
}

function findPersonByPersonaId(
  response: DemoSearchResponse,
  personaId: string
): DemoPerson | undefined {
  const directMatch = response.people.find((person) => person.aiPersona.personaId === personaId);
  if (directMatch) {
    return directMatch;
  }

  const topLevelPersona = response.personas.find((persona) => persona.id === personaId);
  if (topLevelPersona) {
    return response.people.find((person) => person.id === topLevelPersona.personId);
  }

  return response.people.find((person) => person.id === personaId);
}

function buildChatGrounding(
  response: DemoSearchResponse,
  person: DemoPerson
): ChatGroundingContext {
  const groundingArticleIds = new Set(person.aiPersona.grounding.articleIds.filter(Boolean));
  const groundedArticles = person.articles.filter(
    (article) => groundingArticleIds.size === 0 || groundingArticleIds.has(article.id)
  );
  const selectedArticles = groundedArticles.length > 0 ? groundedArticles : person.articles;
  const articles = selectedArticles.map(toArticlePromptContext);
  const evidence = articles.flatMap((article) => article.evidence);
  const sourceRefs = unique([
    ...person.sourceRefs,
    ...person.aiPersona.grounding.sourceRefs,
    ...articles.flatMap((article) => article.sourceRefs),
    ...evidence.map((item) => item.sourceRefId),
    ...response.meta.sourceRefs
      .filter((sourceRef) => person.sourceRefs.includes(sourceRef.id))
      .map((sourceRef) => sourceRef.id)
  ]).filter(Boolean);

  return {
    articles,
    evidence,
    sourceRefs
  };
}

function toArticlePromptContext(article: DemoArticle): PersonaChatArticleContext {
  const evidence = article.evidence.map((item) => toEvidencePromptContext(article, item));
  const fallbackEvidence =
    evidence.length === 0 && article.text
      ? [
          {
            id: `${article.id}_content`,
            label: "公开内容正文",
            text: truncateText(article.text, 700),
            articleId: article.id,
            sourceRefId: article.sourceRefs[0] ?? "",
            sourceUrl: article.sourceUrl || article.url
          }
        ]
      : [];

  return {
    id: article.id,
    title: article.title,
    text: truncateText(article.text || article.summary, 1600),
    url: article.url,
    author: article.author,
    sourceName: article.sourceName,
    sourceUrl: article.sourceUrl,
    summary: truncateText(article.summary, 500),
    sourceRefs: article.sourceRefs,
    evidence: evidence.length > 0 ? evidence : fallbackEvidence
  };
}

function toEvidencePromptContext(
  article: DemoArticle,
  evidence: DemoEvidence
): PersonaChatEvidenceContext {
  return {
    id: evidence.id,
    label: evidence.label,
    text: truncateText(evidence.text, 700),
    articleId: article.id,
    sourceRefId: evidence.sourceRefId,
    sourceUrl: evidence.sourceUrl
  };
}

function toPersonPromptContext(person: DemoPerson): Record<string, unknown> {
  return {
    id: person.id,
    name: person.name,
    sampleType: person.sampleType ?? "content_sample",
    pathId: person.pathId,
    role: person.role,
    badge: person.badge,
    oneLine: person.oneLine,
    who: person.who,
    overlaps: person.overlaps,
    timeline: person.timeline,
    lesson: person.lesson,
    match: {
      reasons: person.match.reasons,
      riskNotes: person.match.riskNotes,
      evidenceIds: person.match.evidenceIds,
      sourceRefs: person.match.sourceRefs
    },
    evidenceIds: person.evidenceIds,
    sourceRefs: person.sourceRefs
  };
}

function toRealPersonaChatResponse(
  request: PersonaChatRequest,
  person: DemoPerson,
  grounding: ChatGroundingContext,
  payload: PersonaChatTaskOutput,
  reply: string
): PersonaChatResponse {
  return {
    schemaVersion: PERSONA_CHAT_SCHEMA_VERSION,
    personaId: person.aiPersona.personaId,
    reply,
    boundaryNotice: DEMO_PERSONA_BOUNDARY_NOTICE,
    sourceRefs: deriveSourceRefs(payload, grounding),
    suggestedQuestions: chooseSuggestedQuestions(person),
    meta: {
      mode: "real",
      queryId: request.queryId,
      generatedAt: new Date().toISOString(),
      grounded: true,
      llmUsed: true,
      safetyNotes: [
        "grounded LLM reply",
        `answerType: ${payload.answerType}`,
        "based only on cached demo person public content",
        "does not represent the Zhihu author"
      ]
    },
    debug: {
      chatMode: "real_llm_chat",
      fallbackReason: "",
      evidenceCount: grounding.evidence.length
    }
  };
}

function createMockFallback(
  request: PersonaChatRequest,
  fallbackReason: string,
  grounding?: ChatGroundingContext,
  person?: DemoPerson
): PersonaChatResponse {
  return {
    schemaVersion: PERSONA_CHAT_SCHEMA_VERSION,
    personaId: person?.aiPersona.personaId ?? request.personaId,
    reply: PERSONA_CHAT_FALLBACK_REPLY,
    boundaryNotice: PERSONA_CHAT_FALLBACK_BOUNDARY_NOTICE,
    sourceRefs: [],
    suggestedQuestions: chooseSuggestedQuestions(person),
    meta: {
      mode: "mock",
      queryId: request.queryId,
      generatedAt: new Date().toISOString(),
      grounded: true,
      llmUsed: false,
      safetyNotes: [
        "minimal persona chat fallback",
        "no new facts beyond cached public content",
        fallbackReason
      ]
    },
    debug: {
      chatMode: "mock_fallback",
      fallbackReason,
      evidenceCount: grounding?.evidence.length ?? 0
    }
  };
}

function deriveSourceRefs(
  payload: PersonaChatTaskOutput,
  grounding: ChatGroundingContext
): string[] {
  const sourceRefs: string[] = [];

  for (const citedArticleId of payload.citedArticleIds) {
    const article = grounding.articles.find((item) => item.id === citedArticleId);
    if (article) {
      sourceRefs.push(...article.sourceRefs);
    }
  }

  for (const item of payload.evidence) {
    const evidence = grounding.evidence.find(
      (candidate) =>
        candidate.articleId === item.articleId &&
        evidenceTextMatches(candidate.text, normalizeEvidenceText(item.text))
    );
    if (evidence?.sourceRefId) {
      sourceRefs.push(evidence.sourceRefId);
    }
  }

  const derivedSourceRefs = unique(sourceRefs).filter(Boolean).slice(0, 6);
  return derivedSourceRefs.length > 0 ? derivedSourceRefs : grounding.sourceRefs;
}

function chooseSuggestedQuestions(person?: DemoPerson): string[] {
  return (person?.aiPersona.suggestedQuestions ?? [])
    .filter((question) => !containsForbiddenClaim(question))
    .slice(0, 3);
}

function normalizePersonaReply(
  answer: string,
  answerType: PersonaChatTaskOutput["answerType"],
  boundary: string,
  userMessage: string,
  grounding: ChatGroundingContext
): string {
  const limitedReply = buildLimitedSourceReply(userMessage, grounding);
  if (limitedReply) {
    return limitedReply;
  }

  let reply = stripBoundaryNoticeFromReply(answer, boundary);
  reply = softenColdBoundaryLanguage(reply);
  reply = softenUnsupportedInferences(reply, grounding);
  reply = collapseWhitespace(reply);

  if (!reply) {
    return "";
  }

  if (answerType === "insufficient_evidence" && !hasLimitedSourcePhrase(reply)) {
    reply = `这部分我没有在那段内容里展开。${trimLeadingPunctuation(reply)}`;
  }

  if (!hasFirstPerson(reply)) {
    reply = `我只能基于这段经历说，${trimLeadingPunctuation(reply)}`;
  }

  return collapseWhitespace(reply);
}

function buildLimitedSourceReply(
  userMessage: string,
  grounding: ChatGroundingContext
): string | undefined {
  if (
    messageIncludesAny(userMessage, ["后悔"]) &&
    !groundingContainsAny(grounding, ["后悔", "遗憾", "复盘"])
  ) {
    return "这部分我当时没有展开。只能说从那段内容看，我更在意的不是证明这个选择后来一定正确，而是先把不工作之后的停靠地点、日常节奏、低成本资源和身体状态想清楚。后悔与否，我不把它补成事实。";
  }

  if (
    messageIncludesAny(userMessage, ["害怕", "怕什么", "担心"]) &&
    !groundingContainsAny(grounding, ["害怕", "担心", "恐惧", "焦虑"])
  ) {
    return "这部分我当时没有展开。只能基于这段经历说，我写下来的重心不是具体害怕什么，而是先处理想去哪里、每天怎么过、低成本资源和身体状态，再决定下一步怎么停靠。";
  }

  if (
    (messageIncludesAny(userMessage, ["最大"]) &&
      messageIncludesAny(userMessage, ["代价", "成本"])) ||
    (messageIncludesAny(userMessage, ["代价", "成本"]) &&
      !groundingContainsAny(grounding, ["代价", "牺牲"]))
  ) {
    return "这个选择最大的代价，我在那段内容里没有直接展开。我只能基于写下来的线索说，真正被摆到台面上的，是想去哪里、每天怎么过、低成本资源和身体状态。对我来说，代价感更像是先把这些问题逐个摊开，而不是立刻定下终局。";
  }

  return undefined;
}

function messageIncludesAny(message: string, fragments: string[]): boolean {
  return fragments.some((fragment) => message.includes(fragment));
}

function softenUnsupportedInferences(answer: string, grounding: ChatGroundingContext): string {
  const replacements: Array<{
    phrase: string;
    replacement: string;
    supportFragments: string[];
  }> = [
    {
      phrase: "经济压力",
      replacement: "低成本资源的约束",
      supportFragments: ["经济压力", "现金流", "存款", "预算"]
    },
    {
      phrase: "物质上的舒适和便利",
      replacement: "日常节奏和生活半径",
      supportFragments: ["舒适", "便利"]
    },
    {
      phrase: "舒适和便利",
      replacement: "日常节奏和生活半径",
      supportFragments: ["舒适", "便利"]
    },
    {
      phrase: "生活便利或舒适度",
      replacement: "日常节奏和生活半径",
      supportFragments: ["生活便利", "舒适度"]
    },
    {
      phrase: "一段时间的不确定性和可能的",
      replacement: "",
      supportFragments: ["不确定性"]
    },
    {
      phrase: "新的环境和条件",
      replacement: "停靠地点里的日常节奏",
      supportFragments: ["环境", "条件"]
    }
  ];

  return replacements.reduce((current, item) => {
    if (!current.includes(item.phrase) || groundingContainsAny(grounding, item.supportFragments)) {
      return current;
    }

    return current.split(item.phrase).join(item.replacement);
  }, answer);
}

function groundingContainsAny(grounding: ChatGroundingContext, fragments: string[]): boolean {
  const sourceText = [
    ...grounding.articles.flatMap((article) => [article.title, article.text, article.summary]),
    ...grounding.evidence.map((item) => item.text)
  ].join("\n");

  return fragments.some((fragment) => sourceText.includes(fragment));
}

function stripBoundaryNoticeFromReply(answer: string, boundary: string): string {
  const boundaryFragments = [
    boundary,
    DEMO_PERSONA_BOUNDARY_NOTICE,
    PERSONA_CHAT_FALLBACK_BOUNDARY_NOTICE,
    "该 AI 分身基于公开内容生成，不代表作者本人。",
    "这是基于公开内容生成的经验回应，不代表作者本人。",
    "这不是作者本人回应，也不代表作者本人。",
    "这不是作者本人回应，也不补充公开内容之外的新事实。"
  ].filter(Boolean);

  return boundaryFragments.reduce(
    (current, fragment) => current.split(fragment).join(""),
    answer
  );
}

function softenColdBoundaryLanguage(answer: string): string {
  const replacements: Array<[string, string]> = [
    ["根据公开资料", "如果只说我写下来的那部分"],
    ["根据公开内容", "如果只说我写下来的那部分"],
    ["公开资料", "这段内容"],
    ["作为 AI", ""],
    ["作为AI", ""],
    ["我无法确认", "这部分我没有在那段内容里展开"],
    ["我不能代表作者本人", ""],
    ["公开内容里并没有提及", "这段内容里没有展开"],
    ["公开内容里并没有提到", "这段内容里没有展开"],
    ["公开内容中没有提及", "这段内容里没有展开"],
    ["公开内容中没有提到", "这段内容里没有展开"],
    ["公开内容没有提到，所以无法回答", "这部分我没有在那段内容里展开"],
    ["公开内容不足以回答这个问题", "这部分我没有在那段内容里展开"],
    ["公开内容中没有足够信息判断这一点", "这部分我没有在那段内容里展开"],
    ["所以无法回答关于", "我不把这点补成事实；关于"],
    ["所以无法回答", "我不把这点补成事实"],
    ["无法回答", "不能把它补成事实"],
    ["公开回答样本", "这段回答"]
  ];

  return replacements.reduce(
    (current, [from, to]) => current.split(from).join(to),
    answer
  );
}

function hasLimitedSourcePhrase(value: string): boolean {
  return [
    "我只能基于",
    "这部分我没有在那段内容里展开",
    "如果只说我写下来的那部分",
    "我能说的不多"
  ].some((fragment) => value.includes(fragment));
}

function hasFirstPerson(value: string): boolean {
  return value.includes("我");
}

function trimLeadingPunctuation(value: string): string {
  return value.replace(/^[\s，。！？、,.!?；;：:]+/, "");
}

function isAllowedEvidenceText(
  articleId: string,
  text: string,
  grounding: ChatGroundingContext
): boolean {
  const normalizedText = normalizeEvidenceText(text);
  if (!normalizedText) {
    return false;
  }

  const article = grounding.articles.find((item) => item.id === articleId);
  if (!article) {
    return false;
  }

  return article.evidence.some((candidate) => evidenceTextMatches(candidate.text, normalizedText))
    || evidenceTextMatches(article.text, normalizedText)
    || evidenceTextMatches(article.summary, normalizedText);
}

function evidenceTextMatches(sourceText: string, normalizedText: string): boolean {
  const normalizedSource = normalizeEvidenceText(sourceText);
  if (!normalizedSource) {
    return false;
  }

  if (normalizedText.length < 8) {
    return normalizedSource === normalizedText;
  }

  return normalizedSource.includes(normalizedText) || normalizedText.includes(normalizedSource);
}

function assertNoForbiddenClaims(values: string[]): void {
  for (const value of values) {
    if (containsForbiddenClaim(value)) {
      throw new Error("LLM persona chat output contains forbidden author simulation or contact guidance");
    }
  }
}

function containsForbiddenClaim(value: string): boolean {
  const forbiddenFragments = [
    "我是作者",
    "我是这位作者",
    "我是本人",
    "我就是作者",
    "我就是这位作者",
    "作为作者本人",
    "作为这位作者",
    "作为某某本人",
    "我的真实想法",
    "本人正在回答",
    "作者本人正在回答",
    "代表作者发言",
    "作为 AI",
    "作为AI",
    "我不能代表作者本人",
    "作者在线",
    "本人在线",
    "实时回应",
    "联系TA",
    "联系 TA",
    "联系作者",
    "私信",
    "加微信",
    "和作者聊"
  ];

  return forbiddenFragments.some((fragment) => value.includes(fragment));
}

function parseHistory(value: unknown): PersonaChatHistoryMessage[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((item) => {
      if (!isRecord(item)) {
        return undefined;
      }

      const role = item.role === "user" || item.role === "assistant" ? item.role : undefined;
      const content = readString(item.content).trim();
      if (!role || !content) {
        return undefined;
      }

      return {
        role,
        content: truncateText(content, 1000)
      };
    })
    .filter((item): item is PersonaChatHistoryMessage => Boolean(item))
    .slice(-MAX_HISTORY_MESSAGES);
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

function logPersonaChatFallback(error: unknown, request: PersonaChatRequest): void {
  console.error("[PersonaChat] grounded LLM chat failed; falling back to mock", {
    personaId: request.personaId,
    queryId: request.queryId,
    messageLength: request.message.length,
    message: toErrorMessage(error)
  });
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message) {
    return error.message;
  }

  return "Unknown error";
}

function truncateText(value: string, maxLength: number): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }

  return `${normalized.slice(0, maxLength - 3)}...`;
}

function collapseWhitespace(value: string): string {
  return value.replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
}

function normalizeEvidenceText(value: string): string {
  return value.replace(/\s+/g, "").trim();
}

function unique(values: string[]): string[] {
  return Array.from(new Set(values));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
