import { createHash } from "node:crypto";

export interface AgentNeedInputQuestion {
  key: string;
  label: string;
  type: "single_select";
  options: string[];
  optional?: boolean;
  allowFreeText?: boolean;
}

export interface AgentNeedInputFreeText {
  key: string;
  label: string;
  placeholder?: string;
  optional: true;
  maxLength: number;
}

export interface AgentNeedInputPayload {
  reason: string;
  questions: AgentNeedInputQuestion[];
  optionalFreeText?: AgentNeedInputFreeText;
}

export interface AgentRefineAnswers {
  answers: Record<string, unknown>;
  refineQuery: string;
}

export interface AgentRefineContext {
  refinedQuery: string;
  sanitizedAnswers: Record<string, unknown>;
  answerHash: string;
  answerSummary: string[];
  refineQueryHash: string | null;
}

type AmbiguousProfile =
  | "career_exit"
  | "relationship_breakup"
  | "hometown"
  | "postgraduate_exam"
  | "self_state";

export function detectAgentNeedInput(input: {
  query: string;
  metadata?: Record<string, unknown>;
}): AgentNeedInputPayload | null {
  const metadata = input.metadata ?? {};
  if (
    metadata.refinedFromTaskId ||
    metadata.clarifyRefined === true ||
    metadata.skipNeedInput === true
  ) {
    return null;
  }

  const profile = matchAmbiguousProfile(normalizeQuestion(input.query));
  return profile ? buildNeedInput(profile) : null;
}

export function buildAgentRefineContext(input: {
  originalQuery: string;
  needInput: AgentNeedInputPayload | null;
  answers: Record<string, unknown>;
  refineQuery?: string;
}): AgentRefineContext {
  const answerContext = sanitizeRefineAnswers(input.answers, input.needInput);
  const refineQuery = trimText(input.refineQuery ?? "", 160);
  const refinedQueryParts = [`原问题：${trimText(input.originalQuery, 160)}`];

  if (answerContext.queryParts.length > 0) {
    refinedQueryParts.push(`补充信息：${answerContext.queryParts.join("；")}`);
  }

  if (refineQuery) {
    refinedQueryParts.push(`进一步关注：${refineQuery}`);
  }

  return {
    refinedQuery: refinedQueryParts.join("\n"),
    sanitizedAnswers: answerContext.sanitizedAnswers,
    answerHash: hashStableJson(answerContext.sanitizedAnswers),
    answerSummary: answerContext.queryParts,
    refineQueryHash: refineQuery ? hashString(refineQuery) : null
  };
}

export function isAgentNeedInputPayload(value: unknown): value is AgentNeedInputPayload {
  const record = asRecord(value);
  return Boolean(
    record &&
      typeof record.reason === "string" &&
      Array.isArray(record.questions) &&
      record.questions.every(isAgentNeedInputQuestion)
  );
}

function buildNeedInput(profile: AmbiguousProfile): AgentNeedInputPayload {
  const sharedFreeText: AgentNeedInputFreeText = {
    key: "additionalContext",
    label: "也可以补一句具体限制",
    placeholder: "例如时间、收入、家庭或城市约束",
    optional: true,
    maxLength: 80
  };

  if (profile === "career_exit") {
    return {
      reason: "问题里还缺少当前工作状态、时间压力和风险承受度，补充后能匹配更接近的真实经历样本。",
      questions: [
        {
          key: "currentSituation",
          label: "你现在最主要卡在哪里？",
          type: "single_select",
          options: ["工作痛苦", "收入压力", "没有成长", "人际/管理压力", "只是想换环境"],
          allowFreeText: true
        },
        {
          key: "timeline",
          label: "你大概什么时候需要做决定？",
          type: "single_select",
          options: ["马上要决定", "1 个月内", "3 个月内", "还没有时间表", "只是先了解"]
        },
        {
          key: "riskTolerance",
          label: "你最担心哪类代价？",
          type: "single_select",
          options: ["不能失去稳定收入", "能承受短期降薪", "有存款可缓冲", "更看重成长", "还不确定"]
        }
      ],
      optionalFreeText: sharedFreeText
    };
  }

  if (profile === "relationship_breakup") {
    return {
      reason: "分手类问题需要关系阶段、主要冲突和决策压力，否则容易召回到过泛的建议。",
      questions: [
        {
          key: "relationshipStage",
          label: "你们现在大概处在哪个阶段？",
          type: "single_select",
          options: ["刚开始不久", "稳定恋爱", "异地/长期拉扯", "谈婚论嫁", "已经分开过"]
        },
        {
          key: "mainConflict",
          label: "最主要的不确定来自哪里？",
          type: "single_select",
          options: ["价值观差异", "信任问题", "现实条件", "沟通消耗", "家人压力"]
        },
        {
          key: "decisionPressure",
          label: "你更想看哪类经历？",
          type: "single_select",
          options: ["坚持后的结果", "分开后的变化", "反复拉扯的代价", "谈婚论嫁前的判断", "还不确定"]
        }
      ],
      optionalFreeText: sharedFreeText
    };
  }

  if (profile === "hometown") {
    return {
      reason: "回老家选择需要城市阶段、牵引因素和风险偏好，才能匹配到更具体的迁移经历。",
      questions: [
        {
          key: "currentCityState",
          label: "你现在在大城市最主要的压力是什么？",
          type: "single_select",
          options: ["买房压力", "工作消耗", "收入不稳定", "孤独感", "发展到瓶颈"]
        },
        {
          key: "hometownPull",
          label: "老家最吸引你的点是什么？",
          type: "single_select",
          options: ["家人支持", "生活成本低", "稳定工作", "结婚/育儿", "只是想逃离"]
        },
        {
          key: "riskTolerance",
          label: "你更担心哪类损失？",
          type: "single_select",
          options: ["职业机会变少", "收入下降", "关系圈重建", "生活不适应", "还不确定"]
        }
      ],
      optionalFreeText: sharedFreeText
    };
  }

  if (profile === "postgraduate_exam") {
    return {
      reason: "考研选择需要阶段、约束和目标，否则很难区分一战、二战、在职或跨专业样本。",
      questions: [
        {
          key: "studyStage",
          label: "你现在处在哪个阶段？",
          type: "single_select",
          options: ["大三/大四", "已毕业", "在职", "一战失败", "跨专业考虑"]
        },
        {
          key: "mainConstraint",
          label: "最主要的限制是什么？",
          type: "single_select",
          options: ["时间不够", "基础薄弱", "经济压力", "家人压力", "目标不清楚"]
        },
        {
          key: "decisionGoal",
          label: "你最想参考哪类结果？",
          type: "single_select",
          options: ["上岸经历", "放弃后的路径", "二战代价", "就业对比", "还不确定"]
        }
      ],
      optionalFreeText: sharedFreeText
    };
  }

  return {
    reason: "问题目前比较开放，先补一个生活/职业/学业场景，能减少泛泛建议并优先匹配真实经历样本。",
    questions: [
      {
        key: "currentSituation",
        label: "你现在最主要卡在哪里？",
        type: "single_select",
        options: ["职业选择", "学业成长", "关系不确定", "城市生活", "不知道自己想要什么"],
        allowFreeText: true
      },
      {
        key: "phase",
        label: "这个状态大概持续多久了？",
        type: "single_select",
        options: ["刚开始", "1 个月内", "3 个月以上", "一年以上", "说不清"]
      },
      {
        key: "needSampleType",
        label: "你更想看哪类真实经历？",
        type: "single_select",
        options: ["做选择的过程", "试错后的结果", "低谷调整经历", "现实约束权衡", "还不确定"]
      }
    ],
    optionalFreeText: sharedFreeText
  };
}

function matchAmbiguousProfile(normalizedQuery: string): AmbiguousProfile | null {
  const exactProfiles: Record<string, AmbiguousProfile> = {
    "我要不要离职": "career_exit",
    "要不要离职": "career_exit",
    "我要不要辞职": "career_exit",
    "要不要辞职": "career_exit",
    "我要不要分手": "relationship_breakup",
    "要不要分手": "relationship_breakup",
    "我要不要回老家": "hometown",
    "要不要回老家": "hometown",
    "我要不要考研": "postgraduate_exam",
    "要不要考研": "postgraduate_exam",
    "我现在很迷茫怎么办": "self_state",
    "我很迷茫怎么办": "self_state",
    "很迷茫怎么办": "self_state",
    "迷茫怎么办": "self_state"
  };

  if (exactProfiles[normalizedQuery]) {
    return exactProfiles[normalizedQuery];
  }

  if (/^我?要不要(离职|辞职)$/.test(normalizedQuery)) {
    return "career_exit";
  }

  if (/^我?要不要分手$/.test(normalizedQuery)) {
    return "relationship_breakup";
  }

  if (/^我?要不要回老家$/.test(normalizedQuery)) {
    return "hometown";
  }

  if (/^我?要不要考研$/.test(normalizedQuery)) {
    return "postgraduate_exam";
  }

  if (normalizedQuery.length <= 10 && normalizedQuery.includes("迷茫")) {
    return "self_state";
  }

  return null;
}

function sanitizeRefineAnswers(
  answers: Record<string, unknown>,
  needInput: AgentNeedInputPayload | null
): {
  sanitizedAnswers: Record<string, unknown>;
  queryParts: string[];
} {
  const questionByKey = new Map(
    (needInput?.questions ?? []).map((question) => [question.key, question])
  );
  const optionalFreeTextKey = needInput?.optionalFreeText?.key ?? "additionalContext";
  const sanitizedAnswers: Record<string, unknown> = {};
  const queryParts: string[] = [];

  for (const [key, value] of Object.entries(answers)) {
    const question = questionByKey.get(key);
    const values = normalizeAnswerValues(value);
    if (values.length === 0) {
      continue;
    }

    if (key === optionalFreeTextKey || isLikelyFreeTextKey(key)) {
      const text = values.join("；");
      sanitizedAnswers[key] = {
        provided: true,
        length: text.length,
        hash: hashString(text)
      };
      continue;
    }

    const safeValues = values.map((item) => trimText(item, 80)).filter(Boolean);
    if (safeValues.length === 0) {
      continue;
    }

    sanitizedAnswers[key] = safeValues.length === 1 ? safeValues[0] : safeValues;
    const label = trimText(question?.label ?? key, 40);
    queryParts.push(`${label}=${safeValues.join("/")}`);
  }

  return {
    sanitizedAnswers,
    queryParts: queryParts.slice(0, 5)
  };
}

function normalizeAnswerValues(value: unknown): string[] {
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    const text = trimText(String(value), 120);
    return text ? [text] : [];
  }

  if (Array.isArray(value)) {
    return value.flatMap(normalizeAnswerValues).slice(0, 5);
  }

  return [];
}

function isAgentNeedInputQuestion(value: unknown): value is AgentNeedInputQuestion {
  const record = asRecord(value);
  return Boolean(
    record &&
      typeof record.key === "string" &&
      typeof record.label === "string" &&
      record.type === "single_select" &&
      Array.isArray(record.options) &&
      record.options.every((item) => typeof item === "string") &&
      record.options.length <= 5
  );
}

function normalizeQuestion(query: string): string {
  return query
    .replace(/[\s？?！!。.,，、：:；;"“”'‘’（）()【】\[\]]+/g, "")
    .trim();
}

function isLikelyFreeTextKey(key: string): boolean {
  const normalized = key.toLowerCase();
  return [
    "freetext",
    "free_text",
    "additional",
    "context",
    "detail",
    "description",
    "supplement",
    "其他",
    "补充",
    "文本"
  ].some((part) => normalized.includes(part));
}

function trimText(value: string, maxLength: number): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length > maxLength ? normalized.slice(0, maxLength) : normalized;
}

function hashStableJson(value: unknown): string {
  return hashString(JSON.stringify(sortJson(value)));
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortJson);
  }

  const record = asRecord(value);
  if (record) {
    return Object.fromEntries(
      Object.entries(record)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nestedValue]) => [key, sortJson(nestedValue)])
    );
  }

  return value;
}

function hashString(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}
