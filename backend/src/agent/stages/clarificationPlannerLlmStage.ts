import { buildPromptUserContext } from "../../services/userContext.service.js";
import type { UserContext } from "../../auth/session.js";
import {
  type ClarificationAmbiguityLevel,
  type ClarificationAnswer,
  type ClarificationContext,
  type ClarificationQuestion,
  type ClarificationQuestionType,
  type ClarificationStage,
  type ClarifyingCard
} from "../../types/demo.types.js";
import { llmRouter } from "../../llm/llmRouter.js";
import { CLARIFICATION_PLANNER_SYSTEM_PROMPT } from "../../llm/prompts/clarificationPlannerPrompt.js";
import type { IntentExpandOutput } from "../../llm/schemas/taskSchemas.js";

const REQUIRED_QUESTIONS = 3;
const MAX_QUESTIONS = REQUIRED_QUESTIONS;
const MAX_OPTIONS = 6;
const MAX_HINTS = 6;

export interface ClarificationPlannerOutput {
  card: ClarifyingCard;
  stage: ClarificationStage;
  context: ClarificationContext | null;
  searchHints: string[];
}

export async function runClarificationPlannerLlmStage(input: {
  query: string;
  intent: IntentExpandOutput;
  clarificationAnswers?: Record<string, ClarificationAnswer>;
  userContext?: UserContext;
  timeoutMs?: number;
  maxRetry?: number;
}): Promise<ClarificationPlannerOutput> {
  const fallback = buildRuleClarificationOutput(input);

  if (!llmRouter.isTaskConfigured("clarification_planner")) {
    return {
      ...fallback,
      stage: {
        ...fallback.stage,
        fallbackReason: "LLM clarification planner not configured; rule planner used"
      }
    };
  }

  try {
    const raw = await llmRouter.runJsonTask("clarification_planner", {
      temperature: 0.1,
      maxTokens: 1200,
      timeoutMs: input.timeoutMs,
      maxRetry: input.maxRetry ?? 0,
      messages: [
        {
          role: "system",
          content: CLARIFICATION_PLANNER_SYSTEM_PROMPT
        },
        {
          role: "user",
          content: JSON.stringify({
            query: truncateText(input.query, 160),
            intent: {
              userCoreQuestion: input.intent.userCoreQuestion,
              focusTags: input.intent.focusTags,
              topicSignals: input.intent.topicSignals,
              searchQueries: input.intent.searchQueries.slice(0, 8)
            },
            clarificationAnswers: input.clarificationAnswers ?? null,
            userContext: buildPromptUserContext(input.userContext)
          })
        }
      ]
    });
    const parsed = parseClarificationPlannerOutput(raw, input);
    return {
      ...parsed,
      stage: {
        ...parsed.stage,
        llmUsed: true,
        provider: llmRouter.getProviderForTask("clarification_planner"),
        model: llmRouter.getModelForTask("clarification_planner")
      }
    };
  } catch (error) {
    return {
      ...fallback,
      stage: {
        ...fallback.stage,
        fallbackReason: formatErrorSummary(error)
      }
    };
  }
}

export function buildRuleClarificationOutput(input: {
  query: string;
  clarificationAnswers?: Record<string, ClarificationAnswer>;
}): ClarificationPlannerOutput {
  const answers = normalizeClarificationAnswers(input.clarificationAnswers);
  const context = buildClarificationContext(input.query, answers);
  const ruleCard = buildRuleClarifyingCard(input.query);
  const hasAnswers = Object.keys(answers).length > 0;
  const card: ClarifyingCard = hasAnswers
    ? buildHiddenClarifyingCard()
    : ruleCard.card;

  return {
    card,
    stage: {
      needClarification: card.show,
      ambiguityLevel: hasAnswers ? "low" : ruleCard.ambiguityLevel,
      llmUsed: false
    },
    context,
    searchHints: context?.searchHints ?? []
  };
}

export function normalizeClarificationAnswers(
  value: unknown
): Record<string, ClarificationAnswer> {
  if (!isRecord(value)) {
    return {};
  }

  const result: Record<string, ClarificationAnswer> = {};
  for (const [key, rawValue] of Object.entries(value)) {
    const normalizedKey = normalizeId(key);
    if (!normalizedKey) {
      continue;
    }

    if (Array.isArray(rawValue)) {
      const items = rawValue.map(readString).filter(Boolean).slice(0, 5);
      if (items.length > 0) {
        result[normalizedKey] = items;
      }
      continue;
    }

    if (
      typeof rawValue === "string" ||
      typeof rawValue === "number" ||
      typeof rawValue === "boolean" ||
      rawValue === null
    ) {
      const answer = rawValue === null ? null : readString(rawValue);
      if (answer !== "") {
        result[normalizedKey] = answer;
      }
    }
  }

  return result;
}

export function buildClarificationContext(
  query: string,
  answers: Record<string, ClarificationAnswer>
): ClarificationContext | null {
  const entries = Object.entries(answers).filter(([, value]) => hasAnswerValue(value));
  if (entries.length === 0) {
    return null;
  }

  const answerParts = entries.map(([key, value]) => `${key}: ${formatAnswerValue(value)}`);
  const searchHints = uniqueNonEmpty(
    answerParts.flatMap((part) => [
      `${query} ${part}`,
      `${part} 真实经历`,
      `${part} 后来怎么样`
    ])
  ).slice(0, MAX_HINTS);

  return {
    originalQuery: query,
    answers,
    answerSummary: answerParts.join("；"),
    searchHints,
    applied: true
  };
}

function parseClarificationPlannerOutput(
  raw: string,
  input: {
    query: string;
    clarificationAnswers?: Record<string, ClarificationAnswer>;
  }
): ClarificationPlannerOutput {
  const parsed = JSON.parse(raw) as unknown;
  if (!isRecord(parsed)) {
    return buildRuleClarificationOutput(input);
  }

  const fallback = buildRuleClarificationOutput(input);
  const answers = normalizeClarificationAnswers(input.clarificationAnswers);
  const context = buildClarificationContext(input.query, answers);
  const needClarification = readBoolean(parsed.needClarification, fallback.card.show);
  const ambiguityLevel = readAmbiguityLevel(parsed.ambiguityLevel, fallback.stage.ambiguityLevel);
  const questions = ensureMinimumClarificationQuestions(
    readQuestions(parsed.questions),
    fallback.card.questions
  );
  const searchHints = readStringArray(parsed.searchHints).slice(0, MAX_HINTS);
  const show = needClarification && questions.length > 0 && Object.keys(answers).length === 0;
  const card: ClarifyingCard = show
    ? {
        show: true,
        title: readString(parsed.title) || fallback.card.title,
        description: readString(parsed.description) || fallback.card.description,
        questions,
        primaryActionText: readString(parsed.primaryActionText) || "用这些信息重新匹配",
        skipActionText: readString(parsed.skipActionText) || "先跳过"
      }
    : buildHiddenClarifyingCard();

  return {
    card,
    stage: {
      needClarification: card.show,
      ambiguityLevel,
      llmUsed: false
    },
    context,
    searchHints: context?.searchHints.length ? context.searchHints : searchHints
  };
}

function buildRuleClarifyingCard(query: string): {
  card: ClarifyingCard;
  ambiguityLevel: ClarificationAmbiguityLevel;
} {
  const normalized = query.replace(/\s+/g, "");
  if (/异地恋|远距离|长期异地|伴侣|恋爱/.test(normalized)) {
    return {
      ambiguityLevel: "medium",
      card: {
        show: true,
        title: "补充关系约束，匹配更准",
        description: "这些信息只用于调整检索方向。",
        questions: [
          {
            id: "relationship_stage",
            label: "你们现在处在哪个阶段？",
            type: "single_select",
            required: true,
            options: [
              { id: "early", label: "刚开始" },
              { id: "stable", label: "稳定关系" },
              { id: "marriage", label: "谈婚论嫁" },
              { id: "separated", label: "已经分开" }
            ]
          },
          {
            id: "core_constraint",
            label: "最核心的约束是什么？",
            type: "single_select",
            required: true,
            options: [
              { id: "career", label: "工作机会" },
              { id: "city", label: "城市距离" },
              { id: "future", label: "未来时间表" },
              { id: "family", label: "家庭期待" },
              { id: "money", label: "经济压力" }
            ]
          },
          {
            id: "sample_preference",
            label: "更想先看哪类经历？",
            type: "single_select",
            required: true,
            options: [
              { id: "similar", label: "情况相似" },
              { id: "continued", label: "坚持下来" },
              { id: "separated", label: "选择分开" },
              { id: "reunited", label: "后来团聚" },
              { id: "tradeoff", label: "代价复盘" }
            ]
          }
        ],
        primaryActionText: "用这些信息重新匹配",
        skipActionText: "先跳过"
      }
    };
  }

  if (/不工作|不上班|裸辞|失业|离职|gap/i.test(normalized)) {
    return {
      ambiguityLevel: "high",
      card: {
        show: true,
        title: "补充当前约束，匹配更准",
        description: "不同现金流、城市和状态会对应很不同的真实经历。",
        questions: [
          {
            id: "current_state",
            label: "你现在更接近哪种状态？",
            type: "single_select",
            required: true,
            options: [
              { id: "burnout", label: "想休息" },
              { id: "unemployed", label: "已失业" },
              { id: "exploring", label: "找新方向" },
              { id: "employed", label: "在职观望" },
              { id: "already_gap", label: "已经空窗" }
            ]
          },
          {
            id: "main_constraint",
            label: "最需要先考虑什么？",
            type: "single_select",
            required: true,
            options: [
              { id: "cashflow", label: "现金流" },
              { id: "place", label: "去哪生活" },
              { id: "career", label: "再就业" },
              { id: "health", label: "身体状态" },
              { id: "family", label: "家庭压力" },
              { id: "insurance", label: "社保医保" }
            ]
          },
          {
            id: "sample_preference",
            label: "更想先参考哪类样本？",
            type: "single_select",
            required: true,
            options: [
              { id: "low_cost_place", label: "低成本停靠" },
              { id: "cashflow_plan", label: "空窗现金流" },
              { id: "career_return", label: "再就业回流" },
              { id: "remote_city", label: "换城市生活" },
              { id: "failure_review", label: "失败复盘" }
            ]
          }
        ],
        primaryActionText: "用这些信息重新匹配",
        skipActionText: "先跳过"
      }
    };
  }

  return {
    ambiguityLevel: "low",
    card: buildHiddenClarifyingCard()
  };
}

function buildHiddenClarifyingCard(): ClarifyingCard {
  return {
    show: false,
    title: "",
    description: "",
    questions: [],
    primaryActionText: "继续匹配",
    skipActionText: "跳过"
  };
}

function readQuestions(value: unknown): ClarificationQuestion[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map(readQuestion)
    .filter((question): question is ClarificationQuestion => Boolean(question))
    .slice(0, MAX_QUESTIONS);
}

function ensureMinimumClarificationQuestions(
  questions: ClarificationQuestion[],
  fallbackQuestions: ClarificationQuestion[]
): ClarificationQuestion[] {
  const mergedQuestions = uniqueQuestions([
    ...questions,
    ...fallbackQuestions,
    ...defaultClarificationQuestions()
  ]).slice(0, MAX_QUESTIONS);

  return mergedQuestions
    .map((question, index) => {
      const fallbackQuestion =
        fallbackQuestions.find((item) => item.id === question.id) ?? fallbackQuestions[index];
      const options = uniqueOptions([
        ...(question.options ?? []),
        ...((question.options?.length ?? 0) > 0 ? [] : fallbackQuestion?.options ?? []),
        ...((question.options?.length ?? 0) > 0 ? [] : defaultClarificationOptions(question.id))
      ]).slice(0, MAX_OPTIONS);

      return {
        ...question,
        type: question.type === "free_text" ? "single_select" : question.type,
        options
      };
    })
    .filter((question) => (question.options?.length ?? 0) > 0)
    .slice(0, REQUIRED_QUESTIONS);
}

function uniqueQuestions(questions: ClarificationQuestion[]): ClarificationQuestion[] {
  const seen = new Set<string>();
  const result: ClarificationQuestion[] = [];
  for (const question of questions) {
    if (!question.id || seen.has(question.id)) {
      continue;
    }
    seen.add(question.id);
    result.push(question);
  }
  return result;
}

function uniqueOptions(options: Array<{ id: string; label: string }>): Array<{
  id: string;
  label: string;
}> {
  const seen = new Set<string>();
  const result: Array<{ id: string; label: string }> = [];
  for (const option of options) {
    const id = normalizeId(option.id);
    const label = truncateText(readString(option.label), 20);
    if (!id || !label || seen.has(id)) {
      continue;
    }
    seen.add(id);
    result.push({ id, label });
  }
  return result;
}

function defaultClarificationOptions(questionId: string): Array<{ id: string; label: string }> {
  const defaultsByQuestionId: Record<string, Array<{ id: string; label: string }>> = {
    current_state: [
      { id: "burnout", label: "想休息" },
      { id: "unemployed", label: "已失业" },
      { id: "exploring", label: "找新方向" },
      { id: "employed", label: "在职观望" },
      { id: "already_gap", label: "已经空窗" }
    ],
    main_constraint: [
      { id: "cashflow", label: "现金流" },
      { id: "place", label: "去哪生活" },
      { id: "career", label: "再就业" },
      { id: "health", label: "身体状态" },
      { id: "family", label: "家庭压力" },
      { id: "insurance", label: "社保医保" }
    ],
    sample_preference: [
      { id: "low_cost_place", label: "低成本停靠" },
      { id: "cashflow_plan", label: "空窗现金流" },
      { id: "career_return", label: "再就业回流" },
      { id: "remote_city", label: "换城市生活" },
      { id: "failure_review", label: "失败复盘" }
    ],
    relationship_stage: [
      { id: "early", label: "刚开始" },
      { id: "stable", label: "稳定关系" },
      { id: "marriage", label: "谈婚论嫁" },
      { id: "separated", label: "已经分开" }
    ],
    core_constraint: [
      { id: "career", label: "工作机会" },
      { id: "city", label: "城市距离" },
      { id: "future", label: "未来时间表" },
      { id: "family", label: "家庭期待" },
      { id: "money", label: "经济压力" }
    ]
  };

  return defaultsByQuestionId[questionId] ?? [
    { id: "similar", label: "相似经历" },
    { id: "resolved", label: "已经走出" },
    { id: "tradeoff", label: "代价边界" }
  ];
}

function defaultClarificationQuestions(): ClarificationQuestion[] {
  return [
    {
      id: "current_state",
      label: "你现在更接近哪种状态？",
      type: "single_select",
      required: true,
      options: defaultClarificationOptions("current_state")
    },
    {
      id: "main_constraint",
      label: "最需要先考虑什么？",
      type: "single_select",
      required: true,
      options: defaultClarificationOptions("main_constraint")
    },
    {
      id: "sample_preference",
      label: "更想先参考哪类样本？",
      type: "single_select",
      required: true,
      options: defaultClarificationOptions("sample_preference")
    }
  ];
}

function readQuestion(value: unknown): ClarificationQuestion | null {
  if (!isRecord(value)) {
    return null;
  }

  const id = normalizeId(readString(value.id));
  const label = truncateText(readString(value.label), 40);
  const type = readQuestionType(value.type);
  if (!id || !label) {
    return null;
  }

  const options = readOptions(value.options);
  return {
    id,
    label,
    type,
    required: readBoolean(value.required, true),
    ...(type === "free_text" ? {} : { options })
  };
}

function readOptions(value: unknown) {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((item) => {
      if (!isRecord(item)) {
        return null;
      }
      const id = normalizeId(readString(item.id));
      const label = truncateText(readString(item.label), 20);
      return id && label ? { id, label } : null;
    })
    .filter((item): item is { id: string; label: string } => Boolean(item))
    .slice(0, MAX_OPTIONS);
}

function readQuestionType(value: unknown): ClarificationQuestionType {
  const type = readString(value);
  return type === "multi_select" || type === "free_text" ? type : "single_select";
}

function readAmbiguityLevel(
  value: unknown,
  fallback: ClarificationAmbiguityLevel
): ClarificationAmbiguityLevel {
  const level = readString(value);
  return level === "low" || level === "medium" || level === "high" ? level : fallback;
}

function hasAnswerValue(value: ClarificationAnswer): boolean {
  return Array.isArray(value) ? value.length > 0 : value !== null && String(value).trim() !== "";
}

function formatAnswerValue(value: ClarificationAnswer): string {
  return Array.isArray(value) ? value.join(",") : String(value ?? "");
}

function formatErrorSummary(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

function readStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    const single = readString(value);
    return single ? [single] : [];
  }

  return uniqueNonEmpty(value.map(readString));
}

function readString(value: unknown): string {
  if (typeof value === "string") {
    return value.replace(/\s+/g, " ").trim();
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return "";
}

function readBoolean(value: unknown, fallback: boolean): boolean {
  if (typeof value === "boolean") {
    return value;
  }
  const normalized = readString(value).toLowerCase();
  if (["true", "1", "yes", "on"].includes(normalized)) {
    return true;
  }
  if (["false", "0", "no", "off"].includes(normalized)) {
    return false;
  }
  return fallback;
}

function normalizeId(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 48);
}

function truncateText(value: string, maxLength: number): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length <= maxLength ? normalized : `${normalized.slice(0, maxLength - 1)}…`;
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
