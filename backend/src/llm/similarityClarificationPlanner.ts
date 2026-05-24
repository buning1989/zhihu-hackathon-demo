import { getLlmTaskTimeoutMs } from "./llmTimeout.js";
import { llmRouter } from "./llmRouter.js";
import {
  scoreClarificationQuestions,
  validateClarificationQuestions
} from "./clarificationQuestionValidator.js";
import { SIMILARITY_CLARIFICATION_PLANNER_SYSTEM_PROMPT } from "./prompts/similarityClarificationPlannerPrompt.js";
import type {
  DemoClarificationAnswers,
  DemoClarificationCandidateQuestion,
  DemoClarificationChoiceFrame,
  DemoClarificationKnownFact,
  DemoClarificationMissingSimilarityDimension,
  DemoClarificationQuestion,
  DemoClarifyingCard,
  DemoDebugClarificationPlan,
  DemoDebugSelectedClarificationQuestion,
  DemoObjectiveQueryPlan
} from "../types/demo.types.js";

interface CreateSimilarityClarificationPlanInput {
  query: string;
  useLlm?: boolean;
}

interface RawPlannerOutput {
  knownFacts: DemoClarificationKnownFact[];
  choiceFrame: DemoClarificationChoiceFrame;
  missingSimilarityDimensions: DemoClarificationMissingSimilarityDimension[];
  candidateQuestions: DemoClarificationCandidateQuestion[];
}

export interface SimilarityClarificationPlanResult {
  card: DemoClarifyingCard;
  debug: DemoDebugClarificationPlan;
  ambiguityLevel: "medium" | "high";
  llmUsed: boolean;
  fallbackReason?: string;
}

const SELECTED_QUESTION_LIMIT = 3;
const MIN_LLM_CANDIDATES = 6;
const MAX_CLARIFICATION_OPTIONS = 6;

const KEYWORD_DICTIONARY = [
  "北大",
  "清华",
  "985",
  "211",
  "三本",
  "双非",
  "专科",
  "研究生",
  "本科",
  "硕士",
  "博士",
  "应届",
  "毕业",
  "计算机",
  "软件",
  "数据",
  "金融",
  "经管",
  "法律",
  "财会",
  "机械",
  "工科",
  "制造",
  "教育",
  "心理",
  "文科",
  "社科",
  "银行",
  "互联网大厂",
  "互联网",
  "新能源汽车",
  "新能源",
  "主机厂",
  "供应商",
  "大厂",
  "国企",
  "外企",
  "创业公司",
  "体制内",
  "公务员",
  "省会",
  "县城",
  "北京",
  "上海",
  "杭州",
  "老家",
  "工厂",
  "产品经理",
  "产品",
  "程序员",
  "教师",
  "老师",
  "施工单位",
  "工程",
  "正式工",
  "自媒体",
  "心理咨询",
  "开店",
  "买房",
  "租房",
  "二胎",
  "孩子",
  "异地恋",
  "对方城市",
  "在职",
  "离职",
  "辞职",
  "裸辞",
  "转行",
  "已开始",
  "做了一年",
  "工作五年",
  "工作十年"
];

export class SimilarityClarificationPlanner {
  async create(
    input: CreateSimilarityClarificationPlanInput
  ): Promise<SimilarityClarificationPlanResult> {
    if (!input.useLlm || !llmRouter.isTaskConfigured("similarity_clarification_plan")) {
      return buildPlanResult(input.query, buildDeterministicPlannerOutput(input.query), {
        llmUsed: false,
        fallbackReason: input.useLlm
          ? "similarity_clarification_plan LLM not configured; deterministic planner used"
          : "deterministic planner used for non-real data mode"
      });
    }

    const fallbackOutput = buildDeterministicPlannerOutput(input.query);

    try {
      const firstAttempt = await runPlannerLlm(input.query);
      const firstResult = buildPlanResult(input.query, firstAttempt, { llmUsed: true });
      if (firstResult.debug.selectedQuestions.length >= 2) {
        return firstResult;
      }

      const retryAttempt = await runPlannerLlm(input.query, firstResult.debug.rejectedQuestions);
      const retryResult = buildPlanResult(input.query, retryAttempt, { llmUsed: true });
      if (retryResult.debug.selectedQuestions.length >= 2) {
        return retryResult;
      }

      return retryResult;
    } catch (error) {
      return buildPlanResult(input.query, fallbackOutput, {
        llmUsed: false,
        fallbackReason: formatErrorSummary(error)
      });
    }
  }
}

export const similarityClarificationPlanner = new SimilarityClarificationPlanner();

export function createDeterministicSimilarityClarificationPlan(
  query: string,
  answers?: DemoClarificationAnswers
): SimilarityClarificationPlanResult {
  return buildPlanResult(query, buildDeterministicPlannerOutput(query), {
    llmUsed: false,
    answers
  });
}

export function buildSimilarityQueryPlan(input: {
  originalQuery: string;
  knownFacts: DemoClarificationKnownFact[];
  choiceFrame: DemoClarificationChoiceFrame;
  selectedQuestions: DemoDebugSelectedClarificationQuestion[];
  answerLabels?: DemoClarificationAnswers;
}): DemoObjectiveQueryPlan {
  const knownTokens = unique(
    input.knownFacts.flatMap((fact) => [
      ...extractQueryTokensFromText(fact.value),
      ...(fact.queryTokens ?? [])
    ])
  );
  const pathTokens = unique([
    ...(input.choiceFrame.queryTokens ?? []),
    ...(input.choiceFrame.currentPath ? extractQueryTokensFromText(input.choiceFrame.currentPath) : []),
    ...(input.choiceFrame.avoidPath ? extractQueryTokensFromText(input.choiceFrame.avoidPath) : []),
    ...input.choiceFrame.targetOptions.flatMap(extractQueryTokensFromText)
  ]);
  const selectedTokens = unique(
    input.selectedQuestions.flatMap((question) => question.queryTokens ?? [])
  );
  const answerTokens = unique(
    Object.values(input.answerLabels ?? {}).flatMap(extractQueryTokensFromText)
  );
  const originalTokens = extractQueryTokensFromText(input.originalQuery);
  const primary: string[] = [];
  const secondary: string[] = [];
  const fallback: string[] = [];
  const pathCore = pathTokens.length > 0 ? pathTokens : originalTokens.slice(0, 2);
  const identityCore = preferTokens([...knownTokens, ...answerTokens], [
    "新能源汽车",
    "新能源",
    "研究生",
    "硕士",
    "北大",
    "清华",
    "985",
    "211",
    "三本",
    "本科",
    "应届",
    "计算机",
    "机械",
    "程序员",
    "教师",
    "施工单位",
    "体制内",
    "北京",
    "杭州",
    "县城",
    "异地恋",
    "孩子",
    "租房"
  ]);

  appendQuery(primary, [...identityCore.slice(0, 2), ...pathCore.slice(0, 3)]);
  appendQuery(primary, [...answerTokens.slice(0, 3), ...pathCore.slice(0, 2)]);
  for (const answer of Object.values(input.answerLabels ?? {})) {
    appendQuery(primary, [...extractQueryTokensFromText(answer).slice(0, 2), ...pathCore.slice(0, 3)]);
  }
  appendQuery(primary, [...knownTokens.slice(0, 3), ...answerTokens.slice(0, 2)]);
  appendQuery(primary, [...knownTokens.slice(0, 2), ...selectedTokens.slice(0, 2), ...pathCore.slice(0, 2)]);

  appendQuery(secondary, [...knownTokens.slice(0, 2), ...selectedTokens.slice(0, 3)]);
  appendQuery(secondary, [...selectedTokens.slice(0, 3), ...pathCore.slice(0, 2)]);
  appendQuery(secondary, [...originalTokens.slice(0, 2), ...pathCore.slice(0, 2)]);
  for (const question of input.selectedQuestions) {
    appendQuery(secondary, [...(question.queryTokens ?? []).slice(0, 2), ...pathCore.slice(0, 2)]);
  }

  appendQuery(fallback, [...pathCore.slice(0, 2), "复盘"]);
  appendQuery(fallback, [...pathCore.slice(0, 2), "经历"]);
  appendQuery(fallback, [...originalTokens.slice(0, 3), "经验"]);

  return {
    primary: unique(primary).filter((query) => !isGenericPrimaryQuery(query)).slice(0, 5),
    secondary: unique(secondary).slice(0, 5),
    fallback: unique(fallback).slice(0, 4)
  };
}

function buildPlanResult(
  originalQuery: string,
  output: RawPlannerOutput,
  options: {
    llmUsed: boolean;
    fallbackReason?: string;
    answers?: DemoClarificationAnswers;
  }
): SimilarityClarificationPlanResult {
  const normalizedOutput = normalizePlannerOutput(output);
  const validation = validateClarificationQuestions(
    normalizedOutput.candidateQuestions,
    normalizedOutput.knownFacts
  );
  const scoring = scoreClarificationQuestions(
    validation.accepted,
    normalizedOutput.knownFacts,
    SELECTED_QUESTION_LIMIT
  );
  const selectedQuestions = attachAnswersToSelectedQuestions(
    scoring.selectedQuestions,
    options.answers
  );
  const queryPlan = buildSimilarityQueryPlan({
    originalQuery,
    knownFacts: normalizedOutput.knownFacts,
    choiceFrame: normalizedOutput.choiceFrame,
    selectedQuestions,
    answerLabels: options.answers
  });
  const debug: DemoDebugClarificationPlan = {
    intentCategory: "similarity_clarification_planner",
    knownFacts: normalizedOutput.knownFacts,
    choiceFrame: normalizedOutput.choiceFrame,
    missingSimilarityDimensions: normalizedOutput.missingSimilarityDimensions,
    candidateQuestions: normalizedOutput.candidateQuestions,
    scoringDetails: scoring.scoringDetails,
    knownSlots: knownFactsToSlots(normalizedOutput.knownFacts),
    missingSimilaritySlots: normalizedOutput.missingSimilarityDimensions.map((item) => item.slot),
    selectedQuestions,
    rejectedQuestions: validation.rejected,
    selectedSlots: selectedQuestions.map((question) => question.slot),
    queryPlan
  };

  return {
    card: createClarifyingCard(
      selectedQuestions.map((selected) =>
        toDemoClarificationQuestion(
          selected,
          validation.accepted.find((candidate) => candidate.slot === selected.slot)
        )
      )
    ),
    debug,
    ambiguityLevel: selectedQuestions.length >= 3 ? "high" : "medium",
    llmUsed: options.llmUsed,
    fallbackReason: options.fallbackReason
  };
}

function attachAnswersToSelectedQuestions(
  questions: DemoDebugSelectedClarificationQuestion[],
  answers: DemoClarificationAnswers | undefined
): DemoDebugSelectedClarificationQuestion[] {
  if (!answers) {
    return questions;
  }

  return questions.map((question) => ({
    ...question,
    answer: answers[question.slot]
  }));
}

async function runPlannerLlm(
  query: string,
  rejectedQuestions?: DemoDebugClarificationPlan["rejectedQuestions"]
): Promise<RawPlannerOutput> {
  const content = await llmRouter.runJsonTask("similarity_clarification_plan", {
    temperature: 0.1,
    maxTokens: 4000,
    timeoutMs: getLlmTaskTimeoutMs("similarity_clarification_plan"),
    maxRetry: 0,
    messages: [
      {
        role: "system",
        content: SIMILARITY_CLARIFICATION_PLANNER_SYSTEM_PROMPT
      },
      {
        role: "user",
        content: JSON.stringify({
          query: truncateText(query, 180),
          ...(rejectedQuestions?.length
            ? {
                previousRejectedQuestions: rejectedQuestions,
                retryInstruction:
                  "上一次通过 validator 的问题不足 2 个。请只生成已存在事实类问题，避开 rejectedQuestions 的原因。"
              }
            : {})
        })
      }
    ]
  });
  const parsed = parsePlannerOutput(content);
  if (parsed.candidateQuestions.length < MIN_LLM_CANDIDATES) {
    throw new Error("LLM planner returned fewer than 6 candidateQuestions");
  }

  return parsed;
}

function parsePlannerOutput(content: string): RawPlannerOutput {
  const record = parseJsonRecord(content);
  const knownFacts = readRecordArray(record.knownFacts)
    .map(readKnownFact)
    .filter(isPresent);
  const choiceFrame = readChoiceFrame(record.choiceFrame);
  const missingSimilarityDimensions = readRecordArray(record.missingSimilarityDimensions)
    .map(readMissingDimension)
    .filter(isPresent);
  const candidateQuestions = readRecordArray(record.candidateQuestions)
    .map(readCandidateQuestion)
    .filter(isPresent);

  return {
    knownFacts,
    choiceFrame,
    missingSimilarityDimensions,
    candidateQuestions
  };
}

function buildDeterministicPlannerOutput(query: string): RawPlannerOutput {
  const normalized = normalizeText(query);
  const knownFacts = extractKnownFacts(normalized);
  const choiceFrame = extractChoiceFrame(normalized);
  const candidates = buildCandidateQuestions(normalized, choiceFrame);
  const missingSimilarityDimensions = candidates
    .filter((candidate) => !knownFacts.some((fact) => fact.slot === candidate.slot))
    .map((candidate) => ({
      slot: candidate.slot,
      reason: candidate.whyUseful,
      queryUtility: candidate.queryUtility,
      similarityPower: candidate.similarityPower
    }));

  return {
    knownFacts,
    choiceFrame,
    missingSimilarityDimensions,
    candidateQuestions: candidates
  };
}

function extractKnownFacts(query: string): DemoClarificationKnownFact[] {
  const facts: DemoClarificationKnownFact[] = [];
  const add = (
    slot: string,
    value: string | null,
    evidence: string,
    confidence = 0.9,
    queryTokens = extractQueryTokensFromText(value ?? "")
  ) => {
    if (!value || facts.some((fact) => fact.slot === slot && fact.value === value)) {
      return;
    }

    facts.push({
      slot,
      value,
      evidence,
      confidence,
      queryTokens
    });
  };

  add("schoolTier", firstIncluded(query, ["北大", "清华", "985", "211", "三本", "双非", "专科"]), query);
  add("degreeStage", firstIncluded(query, ["博士", "研究生", "硕士", "本科"]), query);
  add("graduationStatus", firstIncluded(query, ["应届生", "应届", "毕业", "在读"]), query);
  add("major", firstIncluded(query, ["计算机", "软件", "数据", "机械", "金融", "经管", "法律", "财会", "教育", "心理"]), query);
  add("age", extractAge(query), query);
  add("gender", query.includes("女") ? "女" : query.includes("男") ? "男" : null, query);
  add("city", firstIncluded(query, ["北京", "上海", "深圳", "广州", "杭州", "老家", "县城", "省会", "对方城市"]), query);
  add("industry", firstIncluded(query, ["新能源汽车", "新能源", "互联网", "金融", "教育", "施工单位", "建筑", "制造业", "自媒体"]), query);
  add("companyType", firstIncluded(query, ["互联网大厂", "主机厂", "供应商", "大厂", "国企", "外企", "创业公司", "体制内", "公务员", "正式工"]), query);
  add("currentRole", extractRole(query), query);
  add("workYears", extractDuration(query), query);
  add("currentStatus", firstIncluded(query, ["应届生", "应届", "在职", "离职", "辞职", "裸辞", "转行", "已开始", "待业", "不工作"]), query);
  add("relationshipStage", query.includes("异地恋") ? extractDuration(query) ? `异地恋${extractDuration(query)}` : "异地恋" : null, query, 0.9, ["异地恋"]);
  add("familyStatus", query.includes("一个孩子") ? "一个孩子" : query.includes("二胎") ? "考虑二胎" : null, query);
  add("housingStatus", query.includes("租房") ? extractDuration(query) ? `租房${extractDuration(query)}` : "租房" : null, query, 0.9, ["租房"]);

  return facts;
}

function extractChoiceFrame(query: string): DemoClarificationChoiceFrame {
  const targetOptions = extractTargetOptions(query);
  const avoidPath = query.match(/不想(?:继续)?([^，。？！?]+?)(?:，|,|还|能|转|$)/)?.[1] ?? null;
  const currentPath = extractCurrentPath(query);
  const type = targetOptions.length >= 2
    ? "choose_between_paths"
    : avoidPath
      ? "avoid_current_path"
      : /要不要|值不值得|值得吗|现实吗|靠谱吗|还有机会吗|会不会/.test(query)
        ? "evaluate_known_path"
        : "find_similar_path";

  return {
    type,
    currentPath,
    targetOptions,
    avoidPath: avoidPath ? sanitizeShortText(avoidPath, 12) : null,
    action: type === "choose_between_paths" ? "choose" : type === "avoid_current_path" ? "switch" : "evaluate",
    queryTokens: unique([...targetOptions, ...(currentPath ? [currentPath] : []), ...(avoidPath ? [avoidPath] : [])].flatMap(extractQueryTokensFromText))
  };
}

function extractTargetOptions(query: string): string[] {
  const dictionaryMatches = [
    "互联网大厂",
    "银行",
    "国企",
    "外企",
    "大厂",
    "创业公司",
    "互联网产品岗",
    "主机厂",
    "供应商",
    "产品经理",
    "心理咨询",
    "自媒体",
    "工厂",
    "开店",
    "对方城市",
    "省会发展",
    "杭州买房",
    "二胎",
    "回去上班",
    "老家开店"
  ].filter((item) => query.includes(item));

  const betweenMatch = query.match(/(?:进|去)?([^，。？！?]{1,12}?)(?:还是|或)(?:去|进)?([^，。？！?]{1,12})/);
  const betweenOptions = betweenMatch
    ? [betweenMatch[1], betweenMatch[2]].map((item) => sanitizePathOption(item))
    : [];
  const actionTargets: string[] = [];
  const actionPatterns: Array<[RegExp, string]> = [
    [/转产品经理|转产品/, "产品经理"],
    [/进互联网产品岗/, "互联网产品岗"],
    [/转行心理咨询|心理咨询/, "心理咨询"],
    [/做自媒体|自媒体/, "自媒体"],
    [/回老家开店|老家开店/, "老家开店"],
    [/回老家/, "回老家"],
    [/去对方城市/, "对方城市"],
    [/生二胎|二胎/, "二胎"],
    [/杭州买房|买房/, query.includes("杭州") ? "杭州买房" : "买房"],
    [/回去上班/, "回去上班"],
    [/去省会|省会发展/, "省会发展"]
  ];

  for (const [pattern, value] of actionPatterns) {
    if (pattern.test(query)) {
      actionTargets.push(value);
    }
  }

  return unique([...betweenOptions, ...dictionaryMatches, ...actionTargets])
    .filter((item) => item.length >= 2)
    .slice(0, 4);
}

function extractCurrentPath(query: string): string | null {
  if (query.includes("体制内")) {
    return "体制内";
  }

  if (query.includes("程序员") || query.includes("写代码")) {
    return "程序员";
  }

  if (query.includes("施工单位")) {
    return "施工单位";
  }

  if (query.includes("教师") || query.includes("老师")) {
    return "教师";
  }

  if (query.includes("自媒体")) {
    return "自媒体";
  }

  return null;
}

function buildCandidateQuestions(
  query: string,
  choiceFrame: DemoClarificationChoiceFrame
): DemoClarificationCandidateQuestion[] {
  const education = /毕业|应届|学校|专业|北大|清华|985|211|三本|硕士|本科|银行|大厂|国企|外企|产品岗/.test(query);
  const career = /工作|岗位|程序员|写代码|教师|老师|施工|公务员|体制内|国企|外企|大厂|创业|产品|转行|离职|辞职|自媒体/.test(query);
  const city = /城市|北京|上海|杭州|老家|县城|省会|异地|对方城市|回老家/.test(query);
  const relationship = /异地恋|恋爱|对方城市|伴侣/.test(query);
  const family = /孩子|二胎|家庭|父母/.test(query);
  const housing = /租房|买房|房贷|杭州/.test(query);
  const content = /自媒体|内容|账号|博主/.test(query);
  const business = /开店|咖啡店|门店|经营/.test(query);

  return [
    candidate("degreeStage", "你的学历层次和毕业状态更接近哪类？", [
      "本科应届",
      "硕士应届",
      "本科毕业 1-3 年",
      "硕士毕业 1-3 年",
      "在读学生",
      "其他"
    ], "学历层次和毕业状态能匹配同起点求职、升学或转向经历", education ? 0.92 : 0.55),
    candidate("major", "你的专业背景更接近哪类？", [
      "计算机 / 软件 / 数据",
      "金融 / 经管",
      "法律 / 财会",
      "工科 / 制造",
      "教育 / 心理",
      "文科 / 社科"
    ], "专业背景会显著影响可召回的相似经历和路径关键词", education ? 0.94 : career && !content ? 0.86 : content ? 0.65 : 0.58),
    candidate("schoolTier", "你的学校背景更接近哪类？", [
      "985 / 211",
      "双非本科",
      "三本",
      "专科",
      "海外院校",
      "其他"
    ], "学校层级会影响求职、升学和城市选择样本的可比性", education ? 0.88 : 0.5),
    candidate("currentRole", "当前或上一段主要岗位类型是哪类？", [
      "技术 / 研发",
      "产品 / 运营",
      "市场 / 销售",
      "教师 / 教育",
      "工程 / 施工",
      "职能 / 中后台"
    ], "岗位类型能匹配同职业起点的人，而不是泛泛匹配同问题的人", career && !content ? 0.9 : content ? 0.74 : 0.56),
    candidate("workYears", "这段工作或尝试大约持续了多久？", [
      "应届 / 1 年以内",
      "1-3 年",
      "3-5 年",
      "5-8 年",
      "8-10 年",
      "10 年以上"
    ], "经历年限能区分应届、早期和中后期样本", career || content ? 0.9 : 0.56),
    candidate("organizationType", "当前或上一段组织类型是哪类？", [
      "互联网大厂",
      "国企",
      "外企",
      "创业公司",
      "体制内",
      "学校 / 医院"
    ], "组织类型能帮助匹配同环境下离开、留下或转向的人", career || education ? 0.86 : 0.42),
    candidate("targetFunction", "已明确的目标岗位类型更接近哪类？", [
      "管培 / 综合岗",
      "技术 / 研发",
      "产品 / 运营",
      "市场 / 销售",
      "教育 / 咨询",
      "线下经营"
    ], "目标岗位类型可以直接进入搜索词，匹配同目标路径的人", career || education ? 0.84 : 0.5),
    candidate("relatedExperience", "你已有的相关尝试更接近哪类？", [
      "实习经历",
      "项目 / 作品",
      "副业试水",
      "课程 / 证书",
      "面试 / offer",
      "暂时没有"
    ], "已有尝试能匹配起步资源相近的人", career || education || business || content ? 0.86 : 0.6),
    candidate("resourceAsset", "你已经有的可迁移资源更接近哪类？", [
      "专业技能",
      "项目作品",
      "证书资质",
      "客户 / 人脉",
      "本地资源",
      "账号 / 内容资产"
    ], "已有资源能把搜索从泛选择收敛到相似起点", career || business || content ? 0.84 : 0.62),
    candidate("cityContext", "当前和目标城市事实更接近哪类？", [
      "北京 / 上海",
      "一线 / 新一线",
      "省会城市",
      "县城 / 老家",
      "异地两城",
      "目标城市未定"
    ], "城市层级和迁移方向会显著影响可对照经历", city || relationship || housing ? 0.9 : 0.52),
    candidate("localSupport", "目标城市或老家已有支持条件是哪类？", [
      "可落脚住处",
      "家人支持",
      "朋友 / 同学",
      "本地人脉",
      "工作线索",
      "暂时没有"
    ], "已存在支持系统能匹配城市迁移和回流样本", city ? 0.82 : 0.48),
    candidate("relationshipStatus", "你们目前的关系事实更接近哪类？", [
      "同城恋爱",
      "异地恋",
      "长期稳定关系",
      "谈婚论嫁",
      "已婚",
      "已经分开"
    ], "关系事实状态能匹配相似关系阶段下的选择经历", relationship ? 0.92 : 0.42),
    candidate("cityDistance", "你们目前的城市距离事实更接近哪类？", [
      "同城",
      "同省异地",
      "跨省异地",
      "一方已在目标城市",
      "双方都可能迁移",
      "距离暂不明确"
    ], "城市距离可以直接进入异地恋和迁移选择的搜索词", relationship ? 0.88 : 0.45),
    candidate("familyStatus", "当前家庭结构更接近哪类？", [
      "未婚",
      "已婚无孩",
      "一个孩子",
      "两个孩子",
      "与父母同住",
      "有照护责任"
    ], "家庭结构是匹配生育、迁移和职业选择样本的关键事实", family ? 0.92 : 0.45),
    candidate("careSupport", "现有照护支持更接近哪类？", [
      "伴侣共同照护",
      "父母可帮忙",
      "托育 / 保姆",
      "主要自己带",
      "异地家庭支持",
      "暂时没有"
    ], "照护支持能匹配家庭阶段相似的人", family ? 0.84 : 0.42),
    candidate("housingCondition", "当前住房和购房条件更接近哪类？", [
      "长期租房",
      "首套资格",
      "已有房贷",
      "本地户籍 / 社保",
      "公积金记录",
      "已有住处"
    ], "住房事实能匹配买房、城市留下、迁移或家庭阶段相似的人", housing || family ? 0.9 : 0.42),
    candidate("contentAsset", "自媒体目前已有内容资产是哪类？", [
      "已发布内容",
      "固定账号",
      "稳定选题",
      "粉丝 / 私域",
      "商业合作",
      "暂时没有"
    ], "内容资产能匹配同阶段自媒体样本", content ? 0.97 : 0.4),
    candidate("monetizationStatus", "自媒体目前变现线索是哪类？", [
      "还没有",
      "品牌合作",
      "服务咨询",
      "带货 / 店铺",
      "课程产品",
      "固定客户"
    ], "变现线索能区分内容尝试所处的事实阶段", content ? 0.9 : 0.38),
    candidate("businessBasis", "线下经营已有基础是哪类？", [
      "门店经验",
      "产品 / 菜单",
      "看过铺位",
      "供应链",
      "合伙人",
      "小规模试水"
    ], "线下经营基础能匹配开店或回乡经营样本", business ? 0.88 : 0.38),
    candidate("certificateTraining", "相关证书或训练基础是哪类？", [
      "职业证书",
      "系统课程",
      "考试准备",
      "实操案例",
      "督导 / 师傅",
      "暂时没有"
    ], "证书和训练基础能匹配专业转向的起点", /心理咨询|考公|教师|咨询|证书/.test(query) ? 0.86 : 0.44)
  ].sort((left, right) => (right.targetRelevance ?? 0) - (left.targetRelevance ?? 0));
}

function candidate(
  slot: string,
  question: string,
  options: string[],
  whyUseful: string,
  targetRelevance: number
): DemoClarificationCandidateQuestion {
  const queryTokens = unique(options.flatMap(extractQueryTokensFromText)).slice(0, 12);
  const relevance = clampScore(targetRelevance);
  return {
    slot,
    question,
    type: "single_choice",
    options,
    whyUseful,
    queryTokens,
    similarityPower: clampScore(0.72 + relevance * 0.22),
    queryUtility: clampScore(0.7 + Math.min(queryTokens.length, 8) * 0.03),
    answerability: 0.9,
    targetRelevance: relevance,
    riskFlags: []
  };
}

function normalizePlannerOutput(output: RawPlannerOutput): RawPlannerOutput {
  const choiceFrame = {
    ...output.choiceFrame,
    currentPath: output.choiceFrame.currentPath ?? null,
    targetOptions: unique((output.choiceFrame.targetOptions ?? []).map((item) => sanitizeShortText(item, 16))),
    avoidPath: output.choiceFrame.avoidPath ?? null,
    queryTokens: unique([
      ...(output.choiceFrame.queryTokens ?? []),
      ...(output.choiceFrame.targetOptions ?? []).flatMap(extractQueryTokensFromText)
    ])
  };

  return {
    knownFacts: output.knownFacts.map((fact) => ({
      slot: sanitizeSlot(fact.slot),
      value: sanitizeShortText(fact.value, 18),
      evidence: sanitizeShortText(fact.evidence, 40),
      confidence: clampScore(fact.confidence),
      queryTokens: unique([...(fact.queryTokens ?? []), ...extractQueryTokensFromText(fact.value)]).slice(0, 6)
    })).filter((fact) => fact.slot && fact.value),
    choiceFrame,
    missingSimilarityDimensions: output.missingSimilarityDimensions.map((dimension) => ({
      slot: sanitizeSlot(dimension.slot),
      reason: sanitizeShortText(dimension.reason, 80),
      queryUtility: clampScore(dimension.queryUtility),
      similarityPower: clampScore(dimension.similarityPower)
    })).filter((dimension) => dimension.slot && dimension.reason),
    candidateQuestions: output.candidateQuestions.map((candidateQuestion) => ({
      ...candidateQuestion,
      slot: sanitizeSlot(candidateQuestion.slot),
      question: sanitizeShortText(candidateQuestion.question, 40),
      options: unique(candidateQuestion.options.map((option) => sanitizeShortText(option, 18))).slice(0, MAX_CLARIFICATION_OPTIONS),
      whyUseful: sanitizeShortText(candidateQuestion.whyUseful, 90),
      queryTokens: unique(candidateQuestion.queryTokens.map((token) => sanitizeShortText(token, 12))).slice(0, 12),
      similarityPower: clampScore(candidateQuestion.similarityPower),
      queryUtility: clampScore(candidateQuestion.queryUtility),
      answerability: clampScore(candidateQuestion.answerability),
      targetRelevance: clampScore(candidateQuestion.targetRelevance ?? 0.65),
      riskFlags: unique((candidateQuestion.riskFlags ?? []).map((flag) => sanitizeShortText(flag, 32)))
    })).filter((candidateQuestion) => candidateQuestion.slot && candidateQuestion.question)
  };
}

function toDemoClarificationQuestion(
  selected: DemoDebugSelectedClarificationQuestion,
  candidateQuestion: DemoClarificationCandidateQuestion | undefined
): DemoClarificationQuestion {
  const options = candidateQuestion?.options ?? [];
  return {
    id: selected.slot,
    slot: selected.slot,
    selectedReason: selected.selectedReason,
    queryTokens: selected.queryTokens,
    score: selected.score,
    label: selected.question,
    question: selected.question,
    type: "single_select",
    required: true,
    options: options.slice(0, MAX_CLARIFICATION_OPTIONS).map((option, index) => ({
      id: `${selected.slot}_${index + 1}`,
      label: option,
      queryTokens: extractQueryTokensFromText(option)
    }))
  };
}

function createClarifyingCard(questions: DemoClarificationQuestion[]): DemoClarifyingCard {
  return {
    show: questions.length > 0,
    title: "补充一点背景，帮你找到更像你的人",
    description: "我们不会直接替你判断，只是用这些信息去匹配相似处境下的真实经历。",
    questions,
    primaryActionText: "用这些信息重新匹配",
    skipActionText: "先跳过"
  };
}

function knownFactsToSlots(
  knownFacts: DemoClarificationKnownFact[]
): Record<string, string | null> {
  return knownFacts.reduce<Record<string, string | null>>((result, fact) => {
    result[fact.slot] = fact.value;
    return result;
  }, {});
}

export function readClarificationAnswerLabels(
  card: DemoClarifyingCard,
  answers: DemoClarificationAnswers
): DemoClarificationAnswers {
  const questionMap = new Map(card.questions.map((question) => [question.id, question]));
  return Object.fromEntries(
    Object.entries(answers).map(([questionId, answer]) => {
      const question = questionMap.get(questionId);
      const option = question?.options?.find((item) => item.id === answer);
      return [questionId, option?.label ?? answer];
    })
  );
}

function readKnownFact(value: Record<string, unknown>): DemoClarificationKnownFact | null {
  const slot = sanitizeSlot(readString(value.slot));
  const factValue = sanitizeShortText(readString(value.value), 18);
  if (!slot || !factValue) {
    return null;
  }

  return {
    slot,
    value: factValue,
    evidence: sanitizeShortText(readString(value.evidence), 40) || factValue,
    confidence: clampScore(readNumber(value.confidence, 0.75)),
    queryTokens: readStringArray(value.queryTokens).flatMap(extractQueryTokensFromText)
  };
}

function readChoiceFrame(value: unknown): DemoClarificationChoiceFrame {
  const record = isRecord(value) ? value : {};
  const targetOptions = readStringArray(record.targetOptions).map((item) => sanitizeShortText(item, 16));
  return {
    type: sanitizeSlot(readString(record.type)) || "find_similar_path",
    currentPath: sanitizeNullableText(record.currentPath, 16),
    targetOptions,
    avoidPath: sanitizeNullableText(record.avoidPath, 16),
    action: sanitizeSlot(readString(record.action)) || "evaluate",
    queryTokens: readStringArray(record.queryTokens).flatMap(extractQueryTokensFromText)
  };
}

function readMissingDimension(
  value: Record<string, unknown>
): DemoClarificationMissingSimilarityDimension | null {
  const slot = sanitizeSlot(readString(value.slot));
  const reason = sanitizeShortText(readString(value.reason), 80);
  if (!slot || !reason) {
    return null;
  }

  return {
    slot,
    reason,
    queryUtility: clampScore(readNumber(value.queryUtility, 0.7)),
    similarityPower: clampScore(readNumber(value.similarityPower, 0.7))
  };
}

function readCandidateQuestion(
  value: Record<string, unknown>
): DemoClarificationCandidateQuestion | null {
  const slot = sanitizeSlot(readString(value.slot));
  const question = sanitizeShortText(readString(value.question), 40);
  const options = readStringArray(value.options).map((item) => sanitizeShortText(item, 18));
  const whyUseful = sanitizeShortText(readString(value.whyUseful), 90);
  const queryTokens = readStringArray(value.queryTokens).flatMap(extractQueryTokensFromText);

  if (!slot || !question || options.length < 2) {
    return null;
  }

  return {
    slot,
    question,
    type: readString(value.type) || "single_choice",
    options,
    whyUseful,
    queryTokens,
    similarityPower: clampScore(readNumber(value.similarityPower, 0.7)),
    queryUtility: clampScore(readNumber(value.queryUtility, 0.7)),
    answerability: clampScore(readNumber(value.answerability, 0.8)),
    targetRelevance: clampScore(readNumber(value.targetRelevance, 0.65)),
    riskFlags: readStringArray(value.riskFlags)
  };
}

function extractQueryTokensFromText(value: string): string[] {
  const normalized = normalizeText(value);
  if (!normalized) {
    return [];
  }

  const dictionaryTokens = KEYWORD_DICTIONARY.filter((keyword) => normalized.includes(keyword));
  const splitTokens = normalized
    .replace(/[（）()[\]{}]/g, " ")
    .split(/[\s/／、,，;；|]+/)
    .map((item) => item.trim())
    .filter((item) => item.length >= 2 && item.length <= 8)
    .filter((item) => !["其他", "暂时没有", "还不确定", "目标城市未定"].includes(item));

  return unique([...dictionaryTokens, ...splitTokens]).slice(0, 8);
}

function appendQuery(target: string[], tokens: string[]): void {
  const query = unique(tokens.map((token) => sanitizeShortText(token, 10)).filter(Boolean))
    .slice(0, 5)
    .join(" ");
  if (query.split(/\s+/).filter(Boolean).length >= 2) {
    target.push(query);
  }
}

function preferTokens(tokens: string[], preferredOrder: string[]): string[] {
  const tokenSet = new Set(tokens);
  return unique([
    ...preferredOrder.filter((token) => tokenSet.has(token)),
    ...tokens
  ]);
}

function isGenericPrimaryQuery(query: string): boolean {
  return /值不值得|值得吗|靠谱吗|后悔吗|怎么办|真实经历/.test(query);
}

function sanitizePathOption(value: string): string {
  return sanitizeShortText(
    value.replace(/^(要不要|该不该|想|选|去|进|留在|还是|或者)+/g, ""),
    16
  );
}

function sanitizeNullableText(value: unknown, maxLength: number): string | null {
  const text = sanitizeShortText(readString(value), maxLength);
  return text || null;
}

function sanitizeShortText(value: string, maxLength: number): string {
  const normalized = normalizeText(value)
    .replace(/[？?。！!；;：:]+$/g, "")
    .replace(/^null$|^undefined$|^无$/i, "");
  if (!normalized) {
    return "";
  }

  return normalized.length > maxLength ? normalized.slice(0, maxLength) : normalized;
}

function sanitizeSlot(value: string): string {
  return value.trim().replace(/[^a-zA-Z0-9_]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 40);
}

function extractAge(query: string): string | null {
  const match = query.match(/([2-6]\d)\s*岁/);
  return match ? `${match[1]}岁` : null;
}

function extractRole(query: string): string | null {
  if (/程序员|写代码|研发/.test(query)) {
    return "程序员";
  }
  if (/教师|老师/.test(query)) {
    return "教师";
  }
  if (/公务员/.test(query)) {
    return "公务员";
  }
  if (/施工单位|工程/.test(query)) {
    return "工程施工";
  }
  if (/产品经理|产品岗/.test(query)) {
    return "产品";
  }
  return null;
}

function extractDuration(query: string): string | null {
  const match = query.match(/([一二三四五六七八九十\d]+)\s*年/);
  return match ? `${match[1]}年` : null;
}

function firstIncluded(query: string, keywords: string[]): string | null {
  return keywords.find((keyword) => query.includes(keyword)) ?? null;
}

function parseJsonRecord(content: string): Record<string, unknown> {
  const jsonText = extractJsonObjectText(content);
  const parsed = JSON.parse(jsonText) as unknown;
  if (!isRecord(parsed)) {
    throw new Error("LLM similarity clarification response must be a JSON object");
  }

  return parsed;
}

function extractJsonObjectText(content: string): string {
  const trimmed = content.trim();
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
    return trimmed;
  }

  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start >= 0 && end > start) {
    return trimmed.slice(start, end + 1);
  }

  return trimmed;
}

function readRecordArray(value: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.filter(isRecord);
}

function readStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.flatMap((item) => {
    if (typeof item === "string" || typeof item === "number") {
      return String(item);
    }

    return [];
  });
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

function readNumber(value: unknown, fallback: number): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === "string") {
    const parsed = Number.parseFloat(value);
    return Number.isFinite(parsed) ? parsed : fallback;
  }

  return fallback;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function truncateText(value: string, maxLength: number): string {
  const normalized = normalizeText(value);
  if (normalized.length <= maxLength) {
    return normalized;
  }

  return `${normalized.slice(0, maxLength - 3)}...`;
}

function clampScore(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }

  return Math.round(Math.min(Math.max(value, 0), 1) * 1000) / 1000;
}

function unique(values: string[]): string[] {
  return [...new Set(values.map(normalizeText).filter(Boolean))];
}

function isPresent<T>(value: T | null | undefined): value is T {
  return value !== null && value !== undefined;
}

function formatErrorSummary(error: unknown): string {
  if (error instanceof Error) {
    const code = "code" in error && typeof error.code === "string" ? error.code : error.name;
    return `${code || "ERROR"}: ${error.message || "Unknown error"}`;
  }

  return "UNKNOWN_ERROR: Unknown error";
}
