import { createHash } from "node:crypto";
import type {
  PersistentAgentArtifact,
  PersistentAgentEvent,
  PersistentAgentStageRun,
  PersistentAgentTaskSnapshot
} from "./agentModels.js";
import {
  AGENT_ARTIFACT_CANDIDATES,
  AGENT_ARTIFACT_EVIDENCE,
  AGENT_ARTIFACT_FINAL_RESULT,
  AGENT_ARTIFACT_GUARDED_FINAL_RESULT,
  AGENT_ARTIFACT_INTENT,
  AGENT_ARTIFACT_SEARCH_PLAN,
  AGENT_STAGE_EVIDENCE_EXTRACT_LLM,
  AGENT_STAGE_GROUNDING_GUARD_LLM,
  AGENT_STAGE_NORMALIZE_CANDIDATES,
  AGENT_STAGE_PLAN_SEARCH_LLM,
  AGENT_STAGE_RESPONSE_COMPOSE_LLM,
  AGENT_STAGE_RETRIEVE_SOURCES,
  AGENT_STAGE_UNDERSTAND_GOAL_RULE,
  type CandidateItem,
  type CandidatesArtifactData,
  type EvidenceArtifactData,
  type EvidenceItem,
  type FinalResultArtifactData,
  type GuardedFinalResultArtifactData,
  type GroundingGuardReport,
  type IntentArtifactData,
  type SearchPlanArtifactData
} from "./stages/stageTypes.js";

const STAGE_UI = [
  { name: AGENT_STAGE_UNDERSTAND_GOAL_RULE, label: "理解问题" },
  { name: AGENT_STAGE_PLAN_SEARCH_LLM, label: "规划检索" },
  { name: AGENT_STAGE_RETRIEVE_SOURCES, label: "检索来源" },
  { name: AGENT_STAGE_NORMALIZE_CANDIDATES, label: "整理候选" },
  { name: AGENT_STAGE_EVIDENCE_EXTRACT_LLM, label: "抽取证据" },
  { name: AGENT_STAGE_RESPONSE_COMPOSE_LLM, label: "生成结果" },
  { name: AGENT_STAGE_GROUNDING_GUARD_LLM, label: "边界检查" }
] as const;

interface ViewEvidenceItem extends EvidenceItem {
  id: string;
}

interface AgentTaskViewStage {
  name: string;
  label: string;
  status: "pending" | "running" | "completed" | "fallback" | "error" | "skipped";
  fallbackReason: string;
  durationMs: number;
  effectiveTimeoutMs: number;
  provider: string;
  model: string;
  attempts: number;
}

interface AgentTaskView {
  taskId: string;
  id: string;
  status: string;
  currentStage: string;
  progress: number;
  stages: AgentTaskViewStage[];
  partial: Record<string, unknown>;
  result: Record<string, unknown> | null;
  error: { message: string } | null;
  debug: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export function buildPersistentAgentTaskView(snapshot: PersistentAgentTaskSnapshot): AgentTaskView {
  const intent = readArtifactData(snapshot, AGENT_ARTIFACT_INTENT, isIntentArtifactData);
  const searchPlan = readArtifactData(snapshot, AGENT_ARTIFACT_SEARCH_PLAN, isSearchPlanArtifactData);
  const candidates =
    readArtifactData(snapshot, AGENT_ARTIFACT_CANDIDATES, isCandidatesArtifactData) ??
    emptyCandidates();
  const evidence =
    readArtifactData(snapshot, AGENT_ARTIFACT_EVIDENCE, isEvidenceArtifactData) ??
    emptyEvidence();
  const finalResult = readArtifactData(snapshot, AGENT_ARTIFACT_FINAL_RESULT, isFinalResultArtifactData);
  const guardedFinalResult = readArtifactData(
    snapshot,
    AGENT_ARTIFACT_GUARDED_FINAL_RESULT,
    isGuardedFinalResultArtifactData
  );
  const resultArtifact = getResultArtifact(snapshot);
  const viewEvidenceItems = evidence.evidenceItems.map(toViewEvidenceItem);
  const resultData = guardedFinalResult?.result ?? finalResult ?? null;
  const guard = guardedFinalResult?.guard ?? null;
  const demoResult = resultData
    ? buildDemoResult({
        snapshot,
        intent,
        searchPlan,
        candidates,
        evidenceItems: viewEvidenceItems,
        finalResult: resultData,
        guard,
        resultArtifactId: resultArtifact?.id ?? snapshot.task.resultArtifactId
      })
    : null;

  return {
    taskId: snapshot.task.id,
    id: snapshot.task.id,
    status: snapshot.task.status,
    currentStage: snapshot.task.currentStage === "completed" ? "" : snapshot.task.currentStage ?? "",
    progress: snapshot.task.progress,
    stages: buildViewStages(snapshot.stages, snapshot.events),
    partial: {
      expandedQueries: buildExpandedQueryItems(intent, searchPlan),
      searchStats: {
        finalCandidateCount: candidates.candidateCount,
        evidenceCount: viewEvidenceItems.length,
        stageCount: snapshot.stages.length,
        guardStatus: guard?.status ?? ""
      },
      candidates: candidates.candidates.slice(0, 5),
      evidence: viewEvidenceItems.slice(0, 5).map(toPartialEvidence),
      paths: demoResult?.paths ?? [],
      people: demoResult?.people ?? [],
      personas: [],
      guard
    },
    result: demoResult,
    error: snapshot.task.error ? { message: snapshot.task.error } : null,
    debug: {
      runtime: "persistent-agent",
      taskId: snapshot.task.id,
      resultArtifactId: resultArtifact?.id ?? snapshot.task.resultArtifactId,
      artifactTypes: snapshot.artifacts.map((artifact) => artifact.type),
      eventCount: snapshot.events.length
    },
    createdAt: snapshot.task.createdAt,
    updatedAt: snapshot.task.updatedAt
  };
}

function buildViewStages(
  stages: PersistentAgentStageRun[],
  events: PersistentAgentEvent[]
): AgentTaskViewStage[] {
  const latestStageByName = new Map<string, PersistentAgentStageRun>();
  for (const stage of stages) {
    latestStageByName.set(stage.stageName, stage);
  }

  return STAGE_UI.map((stageConfig) => {
    const stage = latestStageByName.get(stageConfig.name);
    const llmEvent = findLatestLlmEvent(events, stageConfig.name);

    return {
      name: stageConfig.name,
      label: stageConfig.label,
      status: mapStageStatus(stage?.status),
      fallbackReason: stage?.fallbackReason ?? readString(llmEvent?.fallbackReason),
      durationMs: stage?.durationMs ?? readNumber(llmEvent?.durationMs),
      effectiveTimeoutMs: stage?.timeoutMs ?? readNumber(llmEvent?.timeoutMs),
      provider: readString(llmEvent?.provider),
      model: stage?.model ?? readString(llmEvent?.model),
      attempts: stage?.attempt ?? readNumber(llmEvent?.attempts)
    };
  });
}

function buildDemoResult(input: {
  snapshot: PersistentAgentTaskSnapshot;
  intent?: IntentArtifactData;
  searchPlan?: SearchPlanArtifactData;
  candidates: CandidatesArtifactData;
  evidenceItems: ViewEvidenceItem[];
  finalResult: FinalResultArtifactData;
  guard: GroundingGuardReport | null;
  resultArtifactId: string | null;
}): Record<string, unknown> {
  const people = buildDemoPeople(input);
  const paths = buildDemoPaths(input.finalResult, input.candidates.candidates, people);
  const peopleWithPath = people.map((person, index) => ({
    ...person,
    pathId: readString(person.pathId) || readString(paths[index % Math.max(paths.length, 1)]?.id)
  }));

  return {
    schemaVersion: "2026-05-14.persistent-agent-view-v1",
    queryId: input.snapshot.task.id,
    query: input.snapshot.task.query,
    dataMode: "cache_first",
    features: {
      aiPersona: false,
      personaChat: "off",
      saveSample: false,
      articleBody: true,
      sourceEvidenceRequired: true
    },
    analysis: {
      steps: buildAnalysisSteps(input),
      focusTags: buildFocusTags(input.searchPlan, input.guard),
      summary: input.finalResult.summary,
      openQuestions: input.finalResult.suggestedQuestions
    },
    paths,
    people: peopleWithPath,
    personas: [],
    sections: buildDemoSections(input.snapshot.task.id, paths, peopleWithPath, input.finalResult),
    meta: {
      mode: "persistent-agent",
      runtime: "persistent-agent",
      generatedAt: new Date().toISOString(),
      traceId: input.snapshot.task.id,
      taskId: input.snapshot.task.id,
      resultArtifactId: input.resultArtifactId,
      guard: input.guard,
      sourcePolicy: "AI 只负责组织公开内容与证据，不作为事实来源。",
      peopleCount: peopleWithPath.length,
      pathCount: paths.length,
      llmEnabled: input.finalResult.llmUsed || Boolean(input.guard && input.guard.status !== "fallback"),
      zhihuKeyPresent: input.candidates.candidates.some((candidate) => candidate.provider === "zhihu")
    },
    debug: {
      runtime: "persistent-agent",
      stageCount: input.snapshot.stages.length,
      artifactTypes: input.snapshot.artifacts.map((artifact) => artifact.type),
      guard: input.guard,
      resultStrategy: input.finalResult.strategy
    }
  };
}

function buildDemoPeople(input: {
  snapshot: PersistentAgentTaskSnapshot;
  candidates: CandidatesArtifactData;
  evidenceItems: ViewEvidenceItem[];
  finalResult: FinalResultArtifactData;
}): Record<string, unknown>[] {
  const candidateById = new Map(input.candidates.candidates.map((candidate) => [candidate.id, candidate]));
  const resultPeople = input.finalResult.people.length
    ? input.finalResult.people
    : input.candidates.candidates.slice(0, 3).map((candidate) => ({
        name: candidate.author || "知乎用户",
        reason: candidate.excerpt || candidate.title,
        candidateId: candidate.id,
        evidenceIds: input.evidenceItems
          .filter((item) => item.candidateId === candidate.id)
          .map((item) => item.id)
      }));

  return resultPeople.map((person, index) => {
    const candidate = candidateById.get(person.candidateId) ?? input.candidates.candidates[index];
    const evidenceItems = selectEvidenceItems(input.evidenceItems, person.evidenceIds, candidate?.id);
    const personId = candidate?.id ? `person_${candidate.id}` : stableId("person", `${person.name}:${index}`);
    const sourceUrl = candidate?.url ?? evidenceItems[0]?.sourceUrl ?? "";
    const title = candidate?.title ?? evidenceItems[0]?.title ?? "知乎公开内容";
    const author = person.name || candidate?.author || evidenceItems[0]?.author || "知乎用户";
    const oneLine = person.reason || candidate?.excerpt || evidenceItems[0]?.evidenceText || title;
    const articleId = candidate?.id ? `article_${candidate.id}` : stableId("article", `${title}:${index}`);
    const sourceRefId = candidate?.sourceId || candidate?.id || articleId;

    return {
      id: personId,
      name: author,
      pathId: "",
      role: "知乎公开分享者",
      badge: title,
      displayTier: index < 3 ? "core" : "supplement",
      evidenceStatus: evidenceItems.length ? "llm_extracted" : "raw_snippet_only",
      canChat: false,
      displayLabel: index < 3 ? "较匹配的公开经历" : "补充参考样本",
      displayTradeoff: "当前结果只支持查看来源片段，暂未生成可追问分身。",
      oneLine,
      who: `TA 的公开内容与「${input.snapshot.task.query}」存在相关线索。`,
      overlaps: [
        person.reason,
        ...evidenceItems.slice(0, 2).map((item) => item.reason)
      ].filter(Boolean),
      timeline: [
        {
          date: "知乎公开内容",
          event: title
        }
      ],
      lesson: evidenceItems[0]?.evidenceText ?? candidate?.excerpt ?? oneLine,
      fitReason: person.reason,
      match: {
        level: index < 3 ? "high" : "medium",
        contentRelevance: candidate?.score ?? 0.5,
        evidenceQuality: evidenceItems.length ? 0.72 : 0.45,
        reasons: [
          person.reason,
          evidenceItems[0]?.reason
        ].filter(Boolean)
      },
      sourceRefs: [
        {
          id: sourceRefId,
          title,
          sourceName: "知乎公开内容",
          url: sourceUrl
        }
      ],
      evidenceIds: evidenceItems.map((item) => item.id),
      aiPersona: {
        enabled: false,
        canChat: false,
        displayLabel: "暂未生成经验回声",
        displayTradeoff: "Phase 8 只展示检索与证据组织结果，不包装成可聊天分身。",
        boundary: "基于知乎公开内容整理，不代表作者本人。"
      },
      articles: [
        {
          id: articleId,
          title,
          author,
          sourceName: "知乎公开内容",
          sourceUrl,
          summary: evidenceItems[0]?.evidenceText ?? candidate?.excerpt ?? "",
          evidenceStatus: evidenceItems.length ? "llm_extracted" : "raw_snippet_only",
          evidenceText: evidenceItems[0]?.evidenceText ?? candidate?.excerpt ?? "",
          evidence: evidenceItems.map((item) => ({
            id: item.id,
            label: item.reason,
            text: item.evidenceText,
            sourceRefId,
            sourceUrl: item.sourceUrl
          })),
          sourceRefs: [
            {
              id: sourceRefId,
              title,
              sourceName: "知乎公开内容",
              url: sourceUrl
            }
          ],
          body: evidenceItems.length
            ? evidenceItems.map((item) => item.evidenceText)
            : [candidate?.excerpt ?? oneLine].filter(Boolean)
        }
      ]
    };
  });
}

function buildDemoPaths(
  finalResult: FinalResultArtifactData,
  candidates: CandidateItem[],
  people: Record<string, unknown>[]
): Record<string, unknown>[] {
  const candidateToPersonId = new Map<string, string>();
  people.forEach((person) => {
    const rawPersonId = readString(person.id);
    const rawArticles = Array.isArray(person.articles) ? person.articles : [];
    const articleId = readString(asRecord(rawArticles[0])?.id).replace(/^article_/, "");
    if (articleId && rawPersonId) {
      candidateToPersonId.set(articleId, rawPersonId);
    }
  });

  const resultPaths = finalResult.paths.length
    ? finalResult.paths
    : [
        {
          title: "从相似经历里找到可比较路径",
          summary: finalResult.summary,
          evidenceIds: [],
          candidateIds: candidates.slice(0, 3).map((candidate) => candidate.id)
        }
      ];

  return resultPaths.map((path, index) => {
    const candidateIds = path.candidateIds.length
      ? path.candidateIds
      : candidates.slice(index, index + 3).map((candidate) => candidate.id);
    const personRefs = candidateIds
      .map((candidateId) => candidateToPersonId.get(candidateId) || `person_${candidateId}`)
      .filter(Boolean);

    return {
      id: stableId("path", `${path.title}:${index}`),
      name: path.title,
      title: path.title,
      count: personRefs.length,
      desc: path.summary,
      summary: path.summary,
      short: path.summary,
      coreChoice: path.coreChoice ?? "",
      suitableFor: path.suitableFor ?? [],
      prerequisites: path.prerequisites ?? [],
      benefits: path.benefits ?? [],
      costsOrRisks: path.costsOrRisks ?? [],
      fitReason: path.summary,
      personRefs,
      evidenceIds: path.evidenceIds,
      sourceRefs: candidateIds.map((candidateId) => {
        const candidate = candidates.find((item) => item.id === candidateId);
        return {
          id: candidate?.sourceId || candidateId,
          title: candidate?.title || "知乎公开内容",
          sourceName: "知乎公开内容",
          url: candidate?.url || ""
        };
      })
    };
  });
}

function buildAnalysisSteps(input: {
  snapshot: PersistentAgentTaskSnapshot;
  intent?: IntentArtifactData;
  searchPlan?: SearchPlanArtifactData;
  candidates: CandidatesArtifactData;
  evidenceItems: ViewEvidenceItem[];
  finalResult: FinalResultArtifactData;
  guard: GroundingGuardReport | null;
}): Array<{ title: string; text: string }> {
  return [
    {
      title: "读取问题",
      text: input.intent?.originalQuery || input.snapshot.task.query
    },
    {
      title: "规划检索方向",
      text: (input.searchPlan?.expandedQueries ?? input.intent?.expandedQueries ?? [input.snapshot.task.query])
        .slice(0, 4)
        .join(" / ")
    },
    {
      title: "整理候选与证据",
      text: `找到 ${input.candidates.candidateCount} 条候选内容，整理 ${input.evidenceItems.length} 条证据片段。`
    },
    {
      title: "生成可展示结果",
      text: input.guard?.warnings.length
        ? `已完成边界检查：${input.guard.warnings[0]}`
        : input.finalResult.summary
    }
  ];
}

function buildFocusTags(
  searchPlan: SearchPlanArtifactData | undefined,
  guard: GroundingGuardReport | null
): string[] {
  const tags = [
    ...(searchPlan?.searchAngles ?? []),
    ...(searchPlan?.targetPersonTypes ?? []),
    guard?.status ? `边界检查：${guard.status}` : ""
  ].filter(Boolean);

  return tags.slice(0, 6).length ? tags.slice(0, 6) : ["真实经历", "公开内容", "证据片段", "边界检查"];
}

function buildDemoSections(
  taskId: string,
  paths: Record<string, unknown>[],
  people: Record<string, unknown>[],
  finalResult: FinalResultArtifactData
): Array<Record<string, unknown>> {
  return [
    {
      id: `section_${taskId}_summary`,
      type: "analysis",
      title: "Agent 整理结果",
      description: finalResult.summary,
      cards: paths.slice(0, 3).map((path) => ({
        id: readString(path.id),
        type: "path",
        title: readString(path.title || path.name),
        summary: readString(path.summary || path.desc),
        targetId: readString(path.id)
      }))
    },
    {
      id: `section_${taskId}_people`,
      type: "people_samples",
      title: "相关样本",
      cards: people.slice(0, 6).map((person) => ({
        id: readString(person.id),
        type: "person",
        title: readString(person.name),
        summary: readString(person.oneLine),
        targetId: readString(person.id)
      }))
    }
  ];
}

function buildExpandedQueryItems(
  intent: IntentArtifactData | undefined,
  searchPlan: SearchPlanArtifactData | undefined
): Array<Record<string, unknown>> {
  const queries = searchPlan?.expandedQueries.length
    ? searchPlan.expandedQueries
    : intent?.expandedQueries ?? [];

  return queries.map((query, index) => ({
    query,
    type: index === 0 ? "original" : "expanded"
  }));
}

function selectEvidenceItems(
  evidenceItems: ViewEvidenceItem[],
  requestedIds: string[],
  candidateId: string | undefined
): ViewEvidenceItem[] {
  const byId = new Map(evidenceItems.map((item) => [item.id, item]));
  const requested = requestedIds.map((id) => byId.get(id)).filter(isDefined);
  if (requested.length) {
    return requested;
  }

  return evidenceItems.filter((item) => item.candidateId === candidateId).slice(0, 2);
}

function toPartialEvidence(item: ViewEvidenceItem): Record<string, unknown> {
  return {
    id: item.id,
    title: item.title,
    text: item.evidenceText,
    reason: item.reason,
    sourceUrl: item.sourceUrl
  };
}

function toViewEvidenceItem(item: EvidenceItem, index: number): ViewEvidenceItem {
  return {
    ...item,
    id: `evidence_${hashSafeId(item.candidateId || item.sourceUrl || item.title)}_${index + 1}`
  };
}

function getResultArtifact(snapshot: PersistentAgentTaskSnapshot): PersistentAgentArtifact | undefined {
  const byId = snapshot.task.resultArtifactId
    ? snapshot.artifacts.find((artifact) => artifact.id === snapshot.task.resultArtifactId)
    : undefined;
  return byId ?? findLatestArtifact(snapshot, AGENT_ARTIFACT_GUARDED_FINAL_RESULT);
}

function readArtifactData<TData>(
  snapshot: PersistentAgentTaskSnapshot,
  type: string,
  guard: (value: unknown) => value is TData
): TData | undefined {
  const artifact = findLatestArtifact(snapshot, type);
  return artifact && guard(artifact.data) ? artifact.data : undefined;
}

function findLatestArtifact(
  snapshot: PersistentAgentTaskSnapshot,
  type: string
): PersistentAgentArtifact | undefined {
  return [...snapshot.artifacts].reverse().find((artifact) => artifact.type === type);
}

function findLatestLlmEvent(
  events: PersistentAgentEvent[],
  stageName: string
): Record<string, unknown> | undefined {
  const event = [...events]
    .reverse()
    .find((item) => item.type.startsWith("llm.call.") && item.payload.stageName === stageName);
  return event?.payload;
}

function mapStageStatus(status: PersistentAgentStageRun["status"] | undefined): AgentTaskViewStage["status"] {
  if (!status || status === "pending" || status === "waiting") {
    return "pending";
  }

  if (status === "succeeded") {
    return "completed";
  }

  if (status === "failed" || status === "failed_final") {
    return "error";
  }

  if (status === "retrying" || status === "failed_retryable") {
    return "running";
  }

  if (status === "degraded" || status === "fallback") {
    return "fallback";
  }

  return status === "skipped" ? "skipped" : "pending";
}

function emptyCandidates(): CandidatesArtifactData {
  return {
    candidates: [],
    candidateCount: 0,
    strategy: "rule_based"
  };
}

function emptyEvidence(): EvidenceArtifactData {
  return {
    evidenceItems: [],
    strategy: "rule_fallback",
    llmUsed: false,
    fallbackReason: "not_available"
  };
}

function isIntentArtifactData(value: unknown): value is IntentArtifactData {
  const record = asRecord(value);
  return Boolean(
    record &&
      typeof record.originalQuery === "string" &&
      typeof record.normalizedQuery === "string" &&
      isStringArray(record.expandedQueries)
  );
}

function isSearchPlanArtifactData(value: unknown): value is SearchPlanArtifactData {
  const record = asRecord(value);
  return Boolean(
    record &&
      typeof record.originalQuery === "string" &&
      isStringArray(record.expandedQueries) &&
      isStringArray(record.searchAngles) &&
      isStringArray(record.negativeKeywords) &&
      isStringArray(record.targetPersonTypes)
  );
}

function isCandidatesArtifactData(value: unknown): value is CandidatesArtifactData {
  const record = asRecord(value);
  return Boolean(record && Array.isArray(record.candidates) && record.candidates.every(isCandidateItem));
}

function isCandidateItem(value: unknown): value is CandidateItem {
  const record = asRecord(value);
  return Boolean(
    record &&
      typeof record.id === "string" &&
      typeof record.sourceId === "string" &&
      typeof record.title === "string" &&
      typeof record.author === "string" &&
      typeof record.excerpt === "string" &&
      typeof record.url === "string" &&
      typeof record.score === "number" &&
      typeof record.provider === "string"
  );
}

function isEvidenceArtifactData(value: unknown): value is EvidenceArtifactData {
  const record = asRecord(value);
  return Boolean(record && Array.isArray(record.evidenceItems) && record.evidenceItems.every(isEvidenceItem));
}

function isEvidenceItem(value: unknown): value is EvidenceItem {
  const record = asRecord(value);
  return Boolean(
    record &&
      typeof record.candidateId === "string" &&
      typeof record.title === "string" &&
      typeof record.author === "string" &&
      typeof record.sourceUrl === "string" &&
      typeof record.evidenceText === "string" &&
      typeof record.reason === "string" &&
      typeof record.confidence === "number"
  );
}

function isFinalResultArtifactData(value: unknown): value is FinalResultArtifactData {
  const record = asRecord(value);
  return Boolean(
    record &&
      record.schemaVersion === "agent.final_result.v1" &&
      typeof record.summary === "string" &&
      Array.isArray(record.paths) &&
      Array.isArray(record.people) &&
      isStringArray(record.suggestedQuestions)
  );
}

function isGuardedFinalResultArtifactData(value: unknown): value is GuardedFinalResultArtifactData {
  const record = asRecord(value);
  return Boolean(
    record &&
      record.schemaVersion === "agent.guarded_final_result.v1" &&
      isFinalResultArtifactData(record.result) &&
      isGroundingGuardReport(record.guard)
  );
}

function isGroundingGuardReport(value: unknown): value is GroundingGuardReport {
  const record = asRecord(value);
  return Boolean(
    record &&
      typeof record.status === "string" &&
      Array.isArray(record.unsupportedClaims) &&
      Array.isArray(record.removedItems) &&
      Array.isArray(record.warnings) &&
      (record.evidenceCoverage === null || typeof record.evidenceCoverage === "number")
  );
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function readString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function readNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function isDefined<TValue>(value: TValue | undefined): value is TValue {
  return value !== undefined;
}

function stableId(prefix: string, value: string): string {
  return `${prefix}_${createHash("sha1").update(value).digest("hex").slice(0, 12)}`;
}

function hashSafeId(value: string): string {
  const normalized = value.replace(/[^a-zA-Z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  return normalized.slice(0, 48) || "item";
}
