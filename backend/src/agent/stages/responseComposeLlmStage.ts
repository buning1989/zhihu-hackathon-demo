import { config } from "../../config/env.js";
import { llmGateway } from "../../llm/llmGateway.js";
import { agentRepository } from "../agentRepository.js";
import {
  AGENT_ARTIFACT_FINAL_RESULT,
  AGENT_STAGE_RESPONSE_COMPOSE_LLM,
  type AgentStageOutput,
  type CandidateItem,
  type CandidatesArtifactData,
  type EvidenceArtifactData,
  type EvidenceItem,
  type FinalResultArtifactData,
  type FinalResultPath,
  type FinalResultPerson,
  type IntentArtifactData,
  type SearchPlanArtifactData
} from "./stageTypes.js";

const MAX_LLM_CANDIDATES = 8;
const MAX_LLM_EVIDENCE_ITEMS = 12;
const MAX_EXCERPT_LENGTH = 360;
const MAX_EVIDENCE_TEXT_LENGTH = 280;

interface EvidenceInputItem extends EvidenceItem {
  id: string;
}

export async function runResponseComposeLlmStage(
  taskId: string,
  intent: IntentArtifactData,
  searchPlan: SearchPlanArtifactData,
  candidates: CandidatesArtifactData,
  evidence: EvidenceArtifactData
): Promise<AgentStageOutput<FinalResultArtifactData>> {
  const limitedCandidates = candidates.candidates.slice(0, MAX_LLM_CANDIDATES);
  const limitedEvidence = evidence.evidenceItems
    .slice(0, MAX_LLM_EVIDENCE_ITEMS)
    .map(toEvidenceInputItem);

  const result = await llmGateway.runJson<FinalResultArtifactData>({
    stageName: AGENT_STAGE_RESPONSE_COMPOSE_LLM,
    provider: config.agent.llm.provider,
    model: config.agent.llm.model,
    messages: buildResponseComposeMessages(intent, searchPlan, limitedCandidates, limitedEvidence),
    timeoutMs: config.agent.llm.timeoutMs,
    retries: config.agent.llm.retries,
    schemaName: "agent.final_result.v1",
    responseFormat: { type: "json_object" },
    validate: isFinalResultArtifactData,
    fallback: (context) =>
      buildFinalResultFallback(intent, limitedCandidates, limitedEvidence, context.fallbackReason),
    metadata: {
      originalQuery: intent.originalQuery,
      candidateCount: limitedCandidates.length,
      evidenceCount: limitedEvidence.length,
      candidates: limitedCandidates.map(toGatewayCandidateMetadata),
      evidenceItems: limitedEvidence.map(toGatewayEvidenceMetadata)
    },
    maxTokens: 1200,
    temperature: 0.2,
    onEvent: async (type, payload) => {
      await agentRepository.createEvent({
        taskId,
        type,
        payload: { ...payload }
      });
    }
  });
  const finalResult = repairFinalResultReferences(result.data, limitedCandidates, limitedEvidence);

  return {
    artifactType: AGENT_ARTIFACT_FINAL_RESULT,
    data: finalResult,
    status: result.status === "success" ? "succeeded" : "fallback",
    fallbackUsed: result.fallbackUsed,
    fallbackReason: result.fallbackReason || null
  };
}

function repairFinalResultReferences(
  finalResult: FinalResultArtifactData,
  candidates: CandidateItem[],
  evidenceItems: EvidenceInputItem[]
): FinalResultArtifactData {
  const candidateIds = new Set(candidates.map((candidate) => candidate.id));
  const evidenceById = new Map(evidenceItems.map((item) => [item.id, item]));
  const evidenceByCandidateId = new Map<string, EvidenceInputItem[]>();
  for (const item of evidenceItems) {
    const group = evidenceByCandidateId.get(item.candidateId) ?? [];
    group.push(item);
    evidenceByCandidateId.set(item.candidateId, group);
  }

  const paths = finalResult.paths.flatMap((path) => {
    const validEvidenceIds = path.evidenceIds.filter((id) => evidenceById.has(id));
    const validCandidateIds = uniqueNonEmpty([
      ...path.candidateIds.filter((id) => candidateIds.has(id)),
      ...validEvidenceIds
        .map((id) => evidenceById.get(id)?.candidateId ?? "")
        .filter((id) => candidateIds.has(id))
    ]);
    const repairedEvidenceIds = uniqueNonEmpty([
      ...validEvidenceIds,
      ...validCandidateIds.flatMap((candidateId) =>
        (evidenceByCandidateId.get(candidateId) ?? []).slice(0, 1).map((item) => item.id)
      )
    ]);

    if (validCandidateIds.length === 0 || repairedEvidenceIds.length === 0) {
      return [];
    }

    return [
      {
        ...path,
        evidenceIds: repairedEvidenceIds,
        candidateIds: validCandidateIds
      }
    ];
  });
  const people = finalResult.people.flatMap((person) => {
    if (!candidateIds.has(person.candidateId)) {
      return [];
    }
    const evidenceIds = person.evidenceIds.filter((id) => evidenceById.get(id)?.candidateId === person.candidateId);
    if (evidenceIds.length === 0) {
      return [];
    }
    return [
      {
        ...person,
        evidenceIds
      }
    ];
  });

  return {
    ...finalResult,
    paths,
    people
  };
}

function buildResponseComposeMessages(
  intent: IntentArtifactData,
  searchPlan: SearchPlanArtifactData,
  candidates: CandidateItem[],
  evidenceItems: EvidenceInputItem[]
) {
  return [
    {
      role: "system" as const,
      content:
        "你是结果组织器。只输出 JSON，不要输出解释。只能基于输入 candidates 和 evidence 做样本归纳，不要给建议，不要编造事实，不要做 grounding guard，不要构造 AI 分身。"
    },
    {
      role: "user" as const,
      content: JSON.stringify({
        task: "把检索候选和证据组织成最终可展示结果",
        outputShape: {
          schemaVersion: "agent.final_result.v1",
          summary: "string",
          paths: [
            {
              title: "string",
              summary: "string",
              angle: "string",
              evidenceIds: ["string"],
              candidateIds: ["string"]
            }
          ],
          people: [
            {
              name: "string",
              reason: "string",
              candidateId: "string",
              evidenceIds: ["string"]
            }
          ],
          suggestedQuestions: ["string"],
          strategy: "llm_composed",
          llmUsed: true
        },
        constraints: [
          "summary 必须基于输入 evidence/candidates",
          "summary 只做证据归纳：这些公开样本呈现了哪些差异，不要写建议或行动指南",
          "paths 只生成 3 条左右轻路径角度，每条只需要 title / summary / angle / evidenceIds / candidateIds",
          "paths[].summary 必须能被对应 evidenceIds 的短证据直接支撑，只写来源里出现的处境、选择、观点或结果",
          "angle 是这条路径的归纳角度，不是适合人群、前提、收益或风险清单",
          "不要输出 coreChoice、suitableFor、prerequisites、benefits、costsOrRisks",
          "不要生成泛泛建议式 path summary，不要写成行动指南",
          "禁止使用强建议语气和方法论词：你应该、最好、一定、只要、建议你、方法、策略、重要性、意志力",
          "path title 不要写成方法标题；优先写成“样本：某类选择/处境/观点”",
          "证据不足时可以少于 3 条 path，但不要把同一证据拆成重复路径",
          "自我状态、低谷、焦虑、内耗相关问题不得输出心理治疗、诊断、药物、咨询师或医疗建议；只整理公开内容里的真实经历样本",
          "证据弱或 experience evidence 少时，减少 paths/people 数量，可以返回空数组，不要为了凑数量泛化总结",
          "paths[].evidenceIds 只能引用输入 evidenceItems[].id",
          "paths[].candidateIds 只能引用输入 candidates[].id",
          "people[].candidateId 只能引用输入 candidates[].id",
          "people[].evidenceIds 只能引用输入 evidenceItems[].id",
          "people 只保留有 isExperienceEvidence=true evidence 的 candidate",
          "不要生成 AI 分身",
          "不要输出作者本人实时回应、联系方式或私信建议"
        ],
        intent: {
          originalQuery: intent.originalQuery,
          normalizedQuery: intent.normalizedQuery,
          expandedQueries: intent.expandedQueries
        },
        searchPlan: {
          originalQuery: searchPlan.originalQuery,
          expandedQueries: searchPlan.expandedQueries,
          searchAngles: searchPlan.searchAngles,
          targetPersonTypes: searchPlan.targetPersonTypes
        },
        candidates: candidates.map((candidate) => ({
          id: candidate.id,
          type: candidate.type,
          title: truncateText(candidate.title, 120),
          author: truncateText(candidate.author, 80),
          excerpt: truncateText(candidate.excerpt, MAX_EXCERPT_LENGTH),
          url: candidate.url,
          score: candidate.score
        })),
        evidenceItems: evidenceItems.map((item) => ({
          id: item.id,
          candidateId: item.candidateId,
          title: truncateText(item.title, 120),
          author: truncateText(item.author, 80),
          sourceUrl: item.sourceUrl,
          evidenceText: truncateText(item.evidenceText, MAX_EVIDENCE_TEXT_LENGTH),
          reason: truncateText(item.reason, 160),
          normalizedClaim: item.normalizedClaim,
          supportType: item.supportType,
          isExperienceEvidence: item.isExperienceEvidence,
          confidence: item.confidence
        }))
      })
    }
  ];
}

function buildFinalResultFallback(
  intent: IntentArtifactData,
  candidates: CandidateItem[],
  evidenceItems: EvidenceInputItem[],
  fallbackReason: string
): FinalResultArtifactData {
  const paths = buildFallbackPaths(intent, candidates, evidenceItems);

  return {
    schemaVersion: "agent.final_result.v1",
    summary: buildFallbackSummary(intent, paths, evidenceItems),
    paths,
    people: buildFallbackPeople(candidates, evidenceItems),
    suggestedQuestions: [
      "这些路径分别有哪些风险？",
      "哪些经历和我的问题最相似？",
      "如果先暂停工作，应该先准备什么？"
    ],
    strategy: "rule_fallback",
    llmUsed: false,
    fallbackReason
  };
}

function buildFallbackPaths(
  intent: IntentArtifactData,
  candidates: CandidateItem[],
  evidenceItems: EvidenceInputItem[]
): FinalResultPath[] {
  if (candidates.length === 0 || evidenceItems.length === 0) {
    return [];
  }

  const candidateById = new Map(candidates.map((candidate) => [candidate.id, candidate]));
  const grouped = new Map<string, EvidenceInputItem[]>();
  for (const item of evidenceItems) {
    const candidate = candidateById.get(item.candidateId);
    if (!candidate) {
      continue;
    }

    const key = classifyPathKey(intent.originalQuery, item, candidate);
    const group = grouped.get(key) ?? [];
    group.push(item);
    grouped.set(key, group);
  }

  const drafts = [...grouped.entries()]
    .map(([key, items]) => buildPathFromEvidenceGroup(key, items, candidateById))
    .filter((path): path is FinalResultPath => Boolean(path))
    .sort((left, right) => right.evidenceIds.length - left.evidenceIds.length);

  if (drafts.length >= 3) {
    return drafts.slice(0, 3);
  }

  const usedEvidenceIds = new Set(drafts.flatMap((path) => path.evidenceIds));
  const supplemental = evidenceItems
    .filter((item) => !usedEvidenceIds.has(item.id) && candidateById.has(item.candidateId))
    .map((item) => buildPathFromEvidenceGroup(`sample_${item.id}`, [item], candidateById))
    .filter((path): path is FinalResultPath => Boolean(path));

  return [...drafts, ...supplemental].slice(0, 3);
}

function buildFallbackSummary(
  intent: IntentArtifactData,
  paths: FinalResultPath[],
  evidenceItems: EvidenceInputItem[]
): string {
  if (paths.length === 0) {
    return "当前可用证据不足以整理出稳定路径；需要更多公开来源后才能继续归纳。";
  }

  const pathChoices = paths
    .map((path) => path.angle || path.coreChoice || path.title)
    .map(stripTrailingPunctuation)
    .filter(Boolean)
    .filter((value, index, array) => array.indexOf(value) === index)
    .slice(0, 3)
    .join("；");
  const evidenceCount = evidenceItems.length;
  const query = intent.originalQuery || intent.normalizedQuery || "这个问题";

  return `围绕「${truncateText(query, 40)}」，${evidenceCount} 条公开证据呈现出这些可能性：${pathChoices}。这些样本能帮助比较选择、收益和代价，但不能推出唯一答案。`;
}

function stripTrailingPunctuation(value: string): string {
  return value.replace(/[。；;,.，、\s]+$/g, "").trim();
}

function classifyPathKey(
  query: string,
  item: EvidenceInputItem,
  candidate: CandidateItem
): string {
  const queryText = query.toLowerCase();
  const itemText = `${candidate.title} ${item.evidenceText} ${item.normalizedClaim}`.toLowerCase();
  const text = `${queryText} ${itemText}`;

  if (/异地|恋爱|伴侣|女朋友|男朋友|夫妻/.test(text)) {
    if (/期限|见面|距离|成本|选择|没得选择|长相厮守|89天|坚持个/.test(itemText)) {
      return "relationship_boundary_cost";
    }
    if (/分手|讨厌异地|无能为力|给不到|难受|偏激|不算谈恋爱/.test(itemText)) {
      return "relationship_emotional_cost";
    }
    if (/工作|工资|事业|赚钱|职业|前途|机会/.test(itemText)) {
      return "relationship_work_priority";
    }
    return "relationship_emotional_cost";
  }

  if (/ai|人工智能|大模型|产品|转行|非科班|算法/.test(text)) {
    if (/之前|我就是|我今年|做软件|医学转|java|经验|摸爬滚打/.test(text)) {
      return "career_ai_adjacent_experience";
    }
    if (/学习|python|机器学习|深度学习|作品|项目|岗位|能力/.test(text)) {
      return "career_ai_skill_validation";
    }
    return "career_ai_capital_check";
  }

  if (/不上班|不工作|失业|裸辞|离职|自由职业/.test(text)) {
    if (/跑车|送货|摆摊|接项目|远程|自媒体|收入|现金流|挣钱/.test(text)) {
      return "no_work_income_substitute";
    }
    if (/家里|焦虑|着急|冬天|状态|生活|哪也不想去/.test(text)) {
      return "no_work_life_order";
    }
    return "no_work_safety_net";
  }

  if (item.supportType === "tradeoff" || /风险|代价|成本|压力|现实/.test(text)) {
    return "generic_tradeoff";
  }
  if (item.isExperienceEvidence || item.supportType === "experience_fact") {
    return "generic_experience_sample";
  }

  return `generic_${item.supportType || "context"}`;
}

function buildPathFromEvidenceGroup(
  key: string,
  items: EvidenceInputItem[],
  candidateById: Map<string, CandidateItem>
): FinalResultPath | null {
  const evidenceItems = items
    .filter((item) => candidateById.has(item.candidateId))
    .slice(0, 3);
  if (evidenceItems.length === 0) {
    return null;
  }

  const candidates = evidenceItems
    .map((item) => candidateById.get(item.candidateId))
    .filter((candidate): candidate is CandidateItem => Boolean(candidate));
  const descriptor =
    key.startsWith("generic_") || key.startsWith("sample_")
      ? describeEvidenceSpecificPath(evidenceItems[0], candidates[0])
      : describePathKey(key);
  const evidencePreview = truncateText(
    evidenceItems
      .map((item) => item.normalizedClaim || item.evidenceText)
      .filter(Boolean)
      .join("；"),
    120
  );
  const titleSeed = candidates[0]?.title ? `，可回到「${truncateText(candidates[0].title, 24)}」` : "";

  return {
    title: descriptor.title,
    summary: `${descriptor.summaryPrefix}${evidencePreview}${titleSeed}。这只是公开来源中的对照样本，不代表完整人生或唯一结论。`,
    angle: descriptor.coreChoice,
    evidenceIds: evidenceItems.map((item) => item.id),
    candidateIds: uniqueNonEmpty(evidenceItems.map((item) => item.candidateId))
  };
}

function describePathKey(key: string): {
  title: string;
  summaryPrefix: string;
  coreChoice: string;
  suitableFor: string[];
  prerequisites: string[];
  benefits: string[];
  costsOrRisks: string[];
} {
  if (key === "relationship_work_priority") {
    return {
      title: "样本路径：把工作机会放到优先级前面",
      summaryPrefix: "这组来源把职业机会、收入或前途放在关系距离之前，证据片段显示：",
      coreChoice: "优先追求工作机会，同时承认异地关系会承受不确定性。",
      suitableFor: ["正在比较职业机会和关系距离的人", "能接受关系结果存在不确定性的人"],
      prerequisites: ["工作机会本身有明确成长或收入价值", "双方能把异地期限、见面频率和底线说清楚"],
      benefits: ["保留职业机会或收入上升空间", "把关系选择放进更现实的约束里比较"],
      costsOrRisks: ["分手或关系变淡的风险会变高", "长期异地的沟通和见面成本需要实际承担"]
    };
  }

  if (key === "relationship_boundary_cost") {
    return {
      title: "样本路径：先把异地期限和成本说清楚",
      summaryPrefix: "这组来源关注异地持续多久、多久见一次、谁承担成本，证据片段显示：",
      coreChoice: "不先判断值不值得，而是先确认异地的期限、成本和可回撤条件。",
      suitableFor: ["关系仍想继续，但现实安排很模糊的人", "需要把距离成本量化的人"],
      prerequisites: ["双方愿意讨论期限、见面频率和城市安排", "有能力承担短期交通、时间和沟通成本"],
      benefits: ["把抽象的值得与否变成可比较的现实条件", "降低长期悬空带来的消耗"],
      costsOrRisks: ["讨论后可能发现条件不成立", "如果期限无限延长，消耗仍会累积"]
    };
  }

  if (key === "relationship_emotional_cost") {
    return {
      title: "样本路径：承认异地带来的情感消耗",
      summaryPrefix: "这组来源把异地带来的失落、分手风险或关系消耗放在前面，证据片段显示：",
      coreChoice: "继续关系前，先承认异地会带来情绪消耗和分手风险。",
      suitableFor: ["关系感受已经被距离明显影响的人", "想知道异地真实消耗而不是只看职业收益的人"],
      prerequisites: ["能诚实评估双方对异地的接受度", "愿意讨论分手风险和长期不确定性"],
      benefits: ["避免只用职业收益掩盖关系成本", "让情感代价进入同一张决策表"],
      costsOrRisks: ["关系可能因距离持续消耗", "如果双方预期不同，冲突会更早暴露"]
    };
  }

  if (key === "career_ai_adjacent_experience") {
    return {
      title: "样本路径：从相邻经验切入 AI",
      summaryPrefix: "这组来源出现了从既有背景转向 AI 的经历或判断，证据片段显示：",
      coreChoice: "把原有软件、医学、产品或行业经验转成 AI 相关岗位的切入点。",
      suitableFor: ["已有可迁移技能或行业经验的人", "想先验证 AI 岗位是否承接旧经验的人"],
      prerequisites: ["能说清自己已有经验和 AI 岗位之间的连接", "愿意补齐大模型、产品或技术基础"],
      benefits: ["不是从零开始，能利用已有业务或技术经验", "更容易形成可展示的转行叙事"],
      costsOrRisks: ["需要补课和作品验证", "来源片段不能证明所有人都能获得同样结果"]
    };
  }

  if (key === "career_ai_skill_validation") {
    return {
      title: "样本路径：先用学习和作品验证转行",
      summaryPrefix: "这组来源把学习路径、岗位能力或项目验证放在前面，证据片段显示：",
      coreChoice: "先用学习、项目或作品判断自己是否能进入 AI 产品/大模型方向。",
      suitableFor: ["还不确定是否能转 AI 的人", "愿意先做低成本验证的人"],
      prerequisites: ["能投入固定学习时间", "能产出可展示项目、案例或产品分析"],
      benefits: ["先暴露能力缺口，再决定是否全力转行", "降低盲目辞职或盲投岗位的风险"],
      costsOrRisks: ["学习成本和时间成本真实存在", "课程或资源型内容可能带有推广倾向，需要看证据质量"]
    };
  }

  if (key === "career_ai_capital_check") {
    return {
      title: "样本路径：先判断自己的转行资本",
      summaryPrefix: "这组来源强调年龄不是唯一变量，真正要看已有技能、行业经验和可投入资源，证据片段显示：",
      coreChoice: "先判断已有经验、学习时间和可承受成本，再决定是否转 AI 产品。",
      suitableFor: ["担心 30 岁是否太晚的人", "还没有确认自己转行资本的人"],
      prerequisites: ["能盘点可迁移经验、学习时间和作品产出能力", "能接受转行初期的不确定性"],
      benefits: ["避免只被年龄焦虑驱动", "更容易判断该全力转行还是先小步验证"],
      costsOrRisks: ["如果转行资本不足，投入成本可能被低估", "公开来源不能保证同样的岗位结果"]
    };
  }

  if (key === "no_work_income_substitute") {
    return {
      title: "样本路径：用替代收入先接住现金流",
      summaryPrefix: "这组来源讨论跑车、送货、摆摊、远程接活或自媒体等替代收入，证据片段显示：",
      coreChoice: "离开原工作结构后，先用临时收入、远程接活或小生意维持现金流。",
      suitableFor: ["短期不能完全没有收入的人", "愿意接受收入波动和工作形态变化的人"],
      prerequisites: ["有可立即变现的技能、体力或时间", "能接受收入不稳定和社会评价变化"],
      benefits: ["给生活留出周转空间", "把不工作后的去处从抽象想象变成具体试运行"],
      costsOrRisks: ["收入、体力和稳定性都可能不如原工作", "长期职业积累可能中断"]
    };
  }

  if (key === "no_work_life_order") {
    return {
      title: "样本路径：先修复失业后的生活秩序",
      summaryPrefix: "这组来源呈现失业或不上班后的状态变化，证据片段显示：",
      coreChoice: "先把生活节奏、情绪状态和基本行动力接回来，再决定下一站。",
      suitableFor: ["已经失业或停工，状态被打乱的人", "暂时没有清晰去处的人"],
      prerequisites: ["基本生活能被短期覆盖", "愿意先恢复日常节奏而不是立刻做大决定"],
      benefits: ["避免在低能量状态下仓促选择", "更容易看见真实约束和下一步选项"],
      costsOrRisks: ["如果现金流不足，停留时间会受到限制", "公开片段只能说明状态变化，不能替代专业帮助"]
    };
  }

  if (key === "no_work_safety_net") {
    return {
      title: "样本路径：先确认安全垫和回撤条件",
      summaryPrefix: "这组来源把不工作后的基本盘、预算和现实约束放在前面，证据片段显示：",
      coreChoice: "先确认存款、住处、家庭支持和回撤路径，再扩大停工时间。",
      suitableFor: ["想暂停工作但风险承受力有限的人", "需要先兜住基本生活的人"],
      prerequisites: ["有可计算的现金流或支持系统", "知道最坏情况下如何回到工作或其他收入来源"],
      benefits: ["降低停工后的失控感", "让探索有明确边界"],
      costsOrRisks: ["安全垫不足时选择空间会很小", "长期停工可能影响再就业"]
    };
  }

  return {
    title: "样本路径：围绕一条公开证据做对照",
    summaryPrefix: "这组来源提供了一个可对照的公开片段，证据显示：",
    coreChoice: "先把公开片段中的选择和约束拿来比较，而不是直接套用结论。",
    suitableFor: ["和来源处境有相似变量的人"],
    prerequisites: ["能确认来源片段与自己的问题确实相关"],
    benefits: ["获得一个有来源的参照点"],
    costsOrRisks: ["单条公开片段信息有限，不能推断完整经历"]
  };
}

function describeEvidenceSpecificPath(
  item: EvidenceInputItem,
  candidate: CandidateItem | undefined
): ReturnType<typeof describePathKey> {
  const text = `${candidate?.title ?? ""} ${item.evidenceText}`;

  if (/ai|人工智能|大模型|产品|转行|非科班|算法/i.test(text)) {
    return {
      title: "样本路径：参考已有转行者的实际结果",
      summaryPrefix: "这组来源出现了已经转向 AI 或人工智能方向的公开样本，证据片段显示：",
      coreChoice: "把已有转行者的路径和结果作为参照，再判断自己是否可复现。",
      suitableFor: ["想知道 30 岁后是否仍有转行样本的人", "需要对照真实转行结果的人"],
      prerequisites: ["能区分来源样本的原背景和自己的差异", "愿意回到原文核对岗位、学习成本和结果边界"],
      benefits: ["能看到不是只有年龄一个变量", "更容易比较背景、投入和结果之间的关系"],
      costsOrRisks: ["单个成功或失败样本不能代表普遍结果", "来源片段可能省略了投入成本和行业门槛"]
    };
  }

  if (/异地|恋爱|伴侣|女朋友|男朋友|夫妻/.test(text)) {
    return {
      title: "样本路径：用亲历片段校准关系选择",
      summaryPrefix: "这组来源出现了异地关系中的亲历或强情绪片段，证据显示：",
      coreChoice: "把异地中的真实感受和关系风险纳入选择，而不是只看工作收益。",
      suitableFor: ["想知道异地长期消耗的人", "关系和职业都放不下的人"],
      prerequisites: ["能承认关系感受本身也是决策变量", "愿意比较工作收益和关系损耗"],
      benefits: ["让情绪成本变得可见", "减少只用单一收益判断关系的偏差"],
      costsOrRisks: ["关系可能继续消耗", "公开片段不能代表双方完整互动"]
    };
  }

  if (/不上班|不工作|失业|裸辞|离职|自由职业/.test(text)) {
    return {
      title: "样本路径：看停工后的真实状态变化",
      summaryPrefix: "这组来源出现了失业、不上班或停工后的公开状态片段，证据显示：",
      coreChoice: "先看停工后的状态、现金流和行动力变化，再判断去哪里。",
      suitableFor: ["正在想象不工作后生活的人", "已经离开工作结构但方向不清的人"],
      prerequisites: ["能计算短期生活成本", "愿意面对收入和状态波动"],
      benefits: ["把不工作后的去处具体化", "提前看到停工后的现实代价"],
      costsOrRisks: ["现金流和再就业都可能承压", "状态低谷时容易低估恢复成本"]
    };
  }

  return describePathKey("generic_experience_sample");
}

function buildFallbackPeople(
  candidates: CandidateItem[],
  evidenceItems: EvidenceInputItem[]
): FinalResultPerson[] {
  return candidates
    .map((candidate) => {
      const candidateEvidence = evidenceItems
        .filter((item) => item.candidateId === candidate.id && item.isExperienceEvidence)
        .slice(0, 2);

      return {
        name: candidate.author || "知乎用户",
        reason: "这个公开样本包含可绑定的真实经历证据，只适合作为对照样本，不代表作者本人回应。",
        candidateId: candidate.id,
        evidenceIds: candidateEvidence.map((item) => item.id)
      };
    })
    .filter((person) => person.evidenceIds.length > 0)
    .slice(0, 3);
}

function toEvidenceInputItem(item: EvidenceItem, index: number): EvidenceInputItem {
  return {
    ...item,
    id: `evidence_${hashSafeId(item.candidateId || item.sourceUrl || item.title)}_${index + 1}`,
    evidenceText: truncateText(item.evidenceText, MAX_EVIDENCE_TEXT_LENGTH),
    reason: truncateText(item.reason, 160)
  };
}

function toGatewayCandidateMetadata(candidate: CandidateItem): Record<string, unknown> {
  return {
    id: candidate.id,
    type: candidate.type,
    title: candidate.title,
    author: candidate.author,
    excerpt: truncateText(candidate.excerpt, MAX_EXCERPT_LENGTH),
    url: candidate.url,
    score: candidate.score
  };
}

function toGatewayEvidenceMetadata(item: EvidenceInputItem): Record<string, unknown> {
  return {
    id: item.id,
    candidateId: item.candidateId,
    title: item.title,
    author: item.author,
    sourceUrl: item.sourceUrl,
    evidenceText: truncateText(item.evidenceText, MAX_EVIDENCE_TEXT_LENGTH),
    normalizedClaim: item.normalizedClaim,
    supportType: item.supportType,
    isExperienceEvidence: item.isExperienceEvidence,
    confidence: item.confidence
  };
}

function isFinalResultArtifactData(value: unknown): boolean {
  if (!isRecord(value)) {
    return false;
  }

  const strategy = value.strategy;
  return (
    value.schemaVersion === "agent.final_result.v1" &&
    typeof value.summary === "string" &&
    Array.isArray(value.paths) &&
    value.paths.every(isFinalResultPath) &&
    Array.isArray(value.people) &&
    value.people.every(isFinalResultPerson) &&
    Array.isArray(value.suggestedQuestions) &&
    value.suggestedQuestions.every((item) => typeof item === "string") &&
    (strategy === "llm_composed" || strategy === "rule_fallback") &&
    typeof value.llmUsed === "boolean" &&
    (value.fallbackReason === undefined || typeof value.fallbackReason === "string")
  );
}

function isFinalResultPath(value: unknown): boolean {
  if (!isRecord(value)) {
    return false;
  }

  return (
    typeof value.title === "string" &&
    typeof value.summary === "string" &&
    (value.angle === undefined || typeof value.angle === "string") &&
    isStringArray(value.evidenceIds) &&
    isStringArray(value.candidateIds) &&
    (value.coreChoice === undefined || typeof value.coreChoice === "string") &&
    (value.suitableFor === undefined || isStringArray(value.suitableFor)) &&
    (value.prerequisites === undefined || isStringArray(value.prerequisites)) &&
    (value.benefits === undefined || isStringArray(value.benefits)) &&
    (value.costsOrRisks === undefined || isStringArray(value.costsOrRisks))
  );
}

function isFinalResultPerson(value: unknown): boolean {
  if (!isRecord(value)) {
    return false;
  }

  return (
    typeof value.name === "string" &&
    typeof value.reason === "string" &&
    typeof value.candidateId === "string" &&
    isStringArray(value.evidenceIds)
  );
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function hashSafeId(value: string): string {
  const normalized = value.replace(/[^a-zA-Z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  return normalized.slice(0, 48) || "item";
}

function truncateText(value: string, maxLength: number): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }

  return `${normalized.slice(0, Math.max(maxLength - 1, 0))}…`;
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
