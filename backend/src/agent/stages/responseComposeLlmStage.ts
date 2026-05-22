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
        task: "把检索候选和证据组织成真实内容发现与样本导航结果",
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
          "paths 只生成 3 条左右搜索角度/样本方向，每条只需要 title / summary / angle / evidenceIds / candidateIds",
          "paths[].summary 必须能被对应 evidenceIds 的短证据直接支撑，只写来源里出现的处境、选择、观点或结果",
          "angle 是这组样本的归纳角度，不写适合人群、前提、收益或风险清单",
          "不要生成泛泛建议式 path summary，不要写成行动指南",
          "禁止使用强建议语气和方法论词：你应该、最好、一定、只要、建议你、方法、策略、重要性、意志力",
          "path title 不要写成方法标题；优先写成“样本方向：某类选择/处境/观点”",
          "证据不足时可以少于 3 条 path，但不要把同一证据拆成重复路径",
          "自我状态、低谷、焦虑、内耗相关问题不得输出心理治疗、诊断、药物、咨询师或医疗建议；只整理公开内容里的真实经历样本",
          "证据弱或 experience evidence 少时，减少 paths/people 数量，可以返回空数组，不要为了凑数量泛化总结",
          "paths[].evidenceIds 只能引用输入 evidenceItems[].id",
          "paths[].candidateIds 只能引用输入 candidates[].id",
          "people[].candidateId 只能引用输入 candidates[].id",
          "people[].evidenceIds 只能引用输入 evidenceItems[].id",
          "people 只保留有 isExperienceEvidence=true evidence 的 candidate",
          "suggestedQuestions 只围绕继续发现相似来源、比较样本差异或回看证据，不写行动建议",
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
      "哪些样本和我的问题最相似？",
      "这些样本分别来自哪些来源？",
      "还有哪些相关公开内容可以继续看？"
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
    return "当前可用证据不足以整理出稳定样本方向；需要更多公开来源后才能继续归纳。";
  }

  const pathChoices = paths
    .map((path) => path.angle || path.title)
    .map(stripTrailingPunctuation)
    .filter(Boolean)
    .filter((value, index, array) => array.indexOf(value) === index)
    .slice(0, 3)
    .join("；");
  const evidenceCount = evidenceItems.length;
  const query = intent.originalQuery || intent.normalizedQuery || "这个问题";

  return `围绕「${truncateText(query, 40)}」，${evidenceCount} 条公开证据呈现出这些样本方向：${pathChoices}。这里只做真实内容导航，不推出唯一答案。`;
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
    angle: descriptor.angle,
    evidenceIds: evidenceItems.map((item) => item.id),
    candidateIds: uniqueNonEmpty(evidenceItems.map((item) => item.candidateId))
  };
}

function describePathKey(key: string): {
  title: string;
  summaryPrefix: string;
  angle: string;
} {
  if (key === "relationship_work_priority") {
    return {
      title: "样本方向：工作机会与异地关系",
      summaryPrefix: "这组来源把职业机会、收入或前途放在关系距离之前，证据片段显示：",
      angle: "职业机会和关系距离同时出现的样本"
    };
  }

  if (key === "relationship_boundary_cost") {
    return {
      title: "样本方向：异地期限与见面成本",
      summaryPrefix: "这组来源关注异地持续多久、多久见一次、谁承担成本，证据片段显示：",
      angle: "期限、频率和成本被明确提到的样本"
    };
  }

  if (key === "relationship_emotional_cost") {
    return {
      title: "样本方向：异地中的情感消耗",
      summaryPrefix: "这组来源把异地带来的失落、分手风险或关系消耗放在前面，证据片段显示：",
      angle: "失落、关系消耗或分手风险相关样本"
    };
  }

  if (key === "career_ai_adjacent_experience") {
    return {
      title: "样本方向：相邻经验切入 AI",
      summaryPrefix: "这组来源出现了从既有背景转向 AI 的经历或判断，证据片段显示：",
      angle: "已有背景和 AI 方向连接的样本"
    };
  }

  if (key === "career_ai_skill_validation") {
    return {
      title: "样本方向：学习与项目验证",
      summaryPrefix: "这组来源把学习路径、岗位能力或项目验证放在前面，证据片段显示：",
      angle: "学习、项目或岗位能力被提到的样本"
    };
  }

  if (key === "career_ai_capital_check") {
    return {
      title: "样本方向：年龄与转行基础",
      summaryPrefix: "这组来源强调年龄不是唯一变量，真正要看已有技能、行业经验和可投入资源，证据片段显示：",
      angle: "年龄、经验和资源一起出现的样本"
    };
  }

  if (key === "no_work_income_substitute") {
    return {
      title: "样本方向：替代收入与现金流",
      summaryPrefix: "这组来源讨论跑车、送货、摆摊、远程接活或自媒体等替代收入，证据片段显示：",
      angle: "不上班之后仍提到收入来源的样本"
    };
  }

  if (key === "no_work_life_order") {
    return {
      title: "样本方向：停工后的生活状态",
      summaryPrefix: "这组来源呈现失业或不上班后的状态变化，证据片段显示：",
      angle: "失业、停工后状态变化相关样本"
    };
  }

  if (key === "no_work_safety_net") {
    return {
      title: "样本方向：安全垫与现实约束",
      summaryPrefix: "这组来源把不工作后的基本盘、预算和现实约束放在前面，证据片段显示：",
      angle: "存款、住处、支持系统或现实限制相关样本"
    };
  }

  return {
    title: "样本方向：围绕一条公开证据做对照",
    summaryPrefix: "这组来源提供了一个可对照的公开片段，证据显示：",
    angle: "单条公开证据样本"
  };
}

function describeEvidenceSpecificPath(
  item: EvidenceInputItem,
  candidate: CandidateItem | undefined
): ReturnType<typeof describePathKey> {
  const text = `${candidate?.title ?? ""} ${item.evidenceText}`;

  if (/ai|人工智能|大模型|产品|转行|非科班|算法/i.test(text)) {
    return {
      title: "样本方向：已有转向 AI 的公开样本",
      summaryPrefix: "这组来源出现了已经转向 AI 或人工智能方向的公开样本，证据片段显示：",
      angle: "已有转行结果或岗位经历样本"
    };
  }

  if (/异地|恋爱|伴侣|女朋友|男朋友|夫妻/.test(text)) {
    return {
      title: "样本方向：异地关系中的亲历片段",
      summaryPrefix: "这组来源出现了异地关系中的亲历或强情绪片段，证据显示：",
      angle: "异地关系感受或关系结果样本"
    };
  }

  if (/不上班|不工作|失业|裸辞|离职|自由职业/.test(text)) {
    return {
      title: "样本方向：停工后的真实状态变化",
      summaryPrefix: "这组来源出现了失业、不上班或停工后的公开状态片段，证据显示：",
      angle: "不上班后的生活状态或去向样本"
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
    isStringArray(value.candidateIds)
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
