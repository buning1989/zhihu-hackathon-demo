import { config } from "../config/env.js";
import { createMockPersonaChatResponse } from "../mocks/personaChat.mock.js";
import { buildPersonaChatMessages } from "../prompts/personaPromptBuilder.js";
import { llmClient } from "../providers/llm/openaiCompatible.client.js";
import {
  DEMO_PERSONA_BOUNDARY_NOTICE,
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

const INSUFFICIENT_PUBLIC_CONTENT_REPLY = "公开内容不足以回答这个问题";
const MAX_HISTORY_MESSAGES = 6;

type PersonaChatAnswerType =
  | "grounded_summary"
  | "insufficient_evidence"
  | "clarification"
  | "safety_boundary";

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

interface PersonaChatLlmEvidence {
  articleId: string;
  text: string;
}

interface PersonaChatLlmPayload {
  answer: string;
  answerType: PersonaChatAnswerType;
  citedArticleIds: string[];
  evidence: PersonaChatLlmEvidence[];
  followupQuestions: string[];
  boundary: string;
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

    const grounding = buildChatGrounding(cachedResponse, person);
    if (!config.llm.apiKey) {
      return createMockFallback(
        request,
        "LLM_API_KEY not configured; mock persona chat fallback used",
        grounding,
        person
      );
    }

    try {
      const content = await llmClient.createJsonCompletion({
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
      const payload = parsePersonaChatLlmPayload(content, grounding);

      return toRealPersonaChatResponse(request, person, grounding, payload);
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

function parsePersonaChatLlmPayload(
  content: string,
  grounding: ChatGroundingContext
): PersonaChatLlmPayload {
  const record = parseJsonObject(content);
  const answerType = readAnswerType(record.answerType);
  const citedArticleIds = readStringArray(record.citedArticleIds);
  const evidence = readLlmEvidence(record.evidence, grounding);
  const normalizedCitedArticleIds = unique([
    ...citedArticleIds,
    ...evidence.map((item) => item.articleId)
  ]);
  const answer = normalizeAnswer(readRequiredString(record.answer, "answer"), answerType);
  const followupQuestions = readStringArray(record.followupQuestions).slice(0, 3);
  const boundary = readRequiredString(record.boundary, "boundary");

  assertAllowedArticleIds(normalizedCitedArticleIds, grounding);
  if (answerType === "grounded_summary" && evidence.length === 0) {
    throw new Error("grounded_summary must include at least one grounded evidence item");
  }
  assertNoForbiddenClaims([answer, boundary, ...followupQuestions]);

  return {
    answer,
    answerType,
    citedArticleIds: normalizedCitedArticleIds,
    evidence,
    followupQuestions,
    boundary
  };
}

function readLlmEvidence(
  value: unknown,
  grounding: ChatGroundingContext
): PersonaChatLlmEvidence[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.map((item, index) => {
    const record = readRecord(item, `evidence[${index}]`);
    const articleId = readRequiredString(record.articleId, `evidence[${index}].articleId`);
    const text = readRequiredString(record.text, `evidence[${index}].text`);

    assertAllowedArticleIds([articleId], grounding);
    if (!isAllowedEvidenceText(articleId, text, grounding)) {
      throw new Error(`evidence[${index}].text is not present in persona_context`);
    }

    return {
      articleId,
      text
    };
  });
}

function toRealPersonaChatResponse(
  request: PersonaChatRequest,
  person: DemoPerson,
  grounding: ChatGroundingContext,
  payload: PersonaChatLlmPayload
): PersonaChatResponse {
  return {
    schemaVersion: PERSONA_CHAT_SCHEMA_VERSION,
    personaId: person.aiPersona.personaId,
    reply: payload.answer,
    boundaryNotice: DEMO_PERSONA_BOUNDARY_NOTICE,
    sourceRefs: deriveSourceRefs(payload, grounding),
    suggestedQuestions: chooseSuggestedQuestions(payload.followupQuestions, person),
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
  const response = createMockPersonaChatResponse(request);

  if (grounding?.sourceRefs.length) {
    response.sourceRefs = grounding.sourceRefs;
  }

  if (person?.aiPersona.suggestedQuestions.length) {
    response.suggestedQuestions = person.aiPersona.suggestedQuestions.slice(0, 3);
  }

  return {
    ...response,
    meta: {
      ...response.meta,
      mode: "mock",
      llmUsed: false,
      safetyNotes: unique([...response.meta.safetyNotes, fallbackReason])
    },
    debug: {
      chatMode: "mock_fallback",
      fallbackReason,
      evidenceCount: grounding?.evidence.length ?? 0
    }
  };
}

function deriveSourceRefs(
  payload: PersonaChatLlmPayload,
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

function chooseSuggestedQuestions(
  followupQuestions: string[],
  person: DemoPerson
): string[] {
  const questions = followupQuestions.length > 0 ? followupQuestions : person.aiPersona.suggestedQuestions;
  const safeQuestions = questions.filter((question) => !containsForbiddenClaim(question)).slice(0, 3);

  return safeQuestions.length > 0
    ? safeQuestions
    : [
        "这段公开内容里最确定的信息是什么？",
        "哪些判断还缺少公开证据？"
      ];
}

function normalizeAnswer(answer: string, answerType: PersonaChatAnswerType): string {
  if (answerType !== "insufficient_evidence") {
    return answer;
  }

  if (answer.includes(INSUFFICIENT_PUBLIC_CONTENT_REPLY)) {
    return answer;
  }

  return `${INSUFFICIENT_PUBLIC_CONTENT_REPLY}。${answer}`;
}

function parseJsonObject(content: string): Record<string, unknown> {
  const normalized = stripMarkdownFence(content.trim());
  const start = normalized.indexOf("{");
  const end = normalized.lastIndexOf("}");

  if (start < 0 || end < start) {
    throw new Error("LLM response did not contain a JSON object");
  }

  const parsed: unknown = JSON.parse(normalized.slice(start, end + 1));
  return readRecord(parsed, "LLM root");
}

function stripMarkdownFence(value: string): string {
  if (!value.startsWith("```")) {
    return value;
  }

  return value
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "")
    .trim();
}

function readAnswerType(value: unknown): PersonaChatAnswerType {
  if (
    value === "grounded_summary" ||
    value === "insufficient_evidence" ||
    value === "clarification" ||
    value === "safety_boundary"
  ) {
    return value;
  }

  throw new Error("answerType must be grounded_summary, insufficient_evidence, clarification, or safety_boundary");
}

function assertAllowedArticleIds(articleIds: string[], grounding: ChatGroundingContext): void {
  const allowedArticleIds = new Set(grounding.articles.map((article) => article.id));
  for (const articleId of articleIds) {
    if (!allowedArticleIds.has(articleId)) {
      throw new Error(`LLM referenced unknown articleId: ${articleId}`);
    }
  }
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
    "作为作者本人",
    "作为这位作者",
    "我当时",
    "我经历过",
    "我的真实想法",
    "本人正在回答",
    "作者本人正在回答",
    "代表作者发言",
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

function readRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new Error(`${label} must be an object`);
  }

  return value;
}

function readRequiredString(value: unknown, label: string): string {
  const text = readString(value).trim();
  if (!text) {
    throw new Error(`${label} is required`);
  }

  return text;
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

function readStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return unique(value.map(readString).map((item) => item.trim()).filter(Boolean));
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

function normalizeEvidenceText(value: string): string {
  return value.replace(/\s+/g, "").trim();
}

function unique(values: string[]): string[] {
  return Array.from(new Set(values));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
