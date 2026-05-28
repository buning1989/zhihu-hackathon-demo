import { assertDemoSearchGrounding } from "../guards/demoEvidence.guard.js";
import { composeRealDemoSearchResponse } from "../services/demoRealComposer.service.js";
import { searchService } from "../services/search.service.js";
import {
  buildPromptUserContext,
  createDemoContextUsed
} from "../services/userContext.service.js";
import {
  MAX_REFILL_ROUNDS,
  MIN_EFFECTIVE_CANDIDATES,
  TARGET_EFFECTIVE_CANDIDATES,
  assessSearchCandidates,
  attachAssessmentMetadata,
  buildDynamicTopicSignals,
  buildRoughTierDistribution,
  selectRerankCandidateAssessments,
  selectRuleFallbackAssessments,
  toCandidateQualityDebug,
  type CandidateAssessment
} from "../services/demoCandidateQuality.service.js";
import {
  DEMO_PERSONA_BOUNDARY_NOTICE,
  type DemoDataMode,
  type DemoCandidateQuality,
  type DemoContentRole,
  type DemoDebugFallbackKind,
  type DemoDebugIntentStage,
  type DemoDebugClarificationContext,
  type DemoDebugLlmStageResult,
  type DemoDebugTiming,
  type DemoDisplayTier,
  type DemoEvidenceStatus,
  type DemoExperienceSummaryDebug,
  type DemoPerson,
  type DemoPersona,
  type DemoSearchCandidate,
  type DemoSearchDebug,
  type DemoSearchQueryPlan,
  type DemoSearchQueryResultDebug,
  type DemoSearchQueryType,
  type DemoSearchResponse,
  type DemoSourceRef
} from "../types/demo.types.js";
import type { UserContext } from "../auth/session.js";
import type { SearchItem } from "../types/api.types.js";
import { HttpError } from "../utils/httpError.js";
import { llmRouter, type LlmTaskType } from "./llmRouter.js";
import { kimiClient } from "./clients/kimiClient.js";
import type { JsonCompletionInput } from "./clients/openaiCompatible.js";
import { getLlmTaskTimeoutMs } from "./llmTimeout.js";
import { DEMO_RESPONSE_COMPOSE_SYSTEM_PROMPT } from "./prompts/demoResponseComposePrompt.js";
import { EVIDENCE_EXTRACT_SYSTEM_PROMPT } from "./prompts/evidenceExtractPrompt.js";
import { EXPERIENCE_SUMMARY_SYSTEM_PROMPT } from "./prompts/experienceSummaryPrompt.js";
import { GROUNDING_GUARD_SYSTEM_PROMPT } from "./prompts/groundingGuardPrompt.js";
import { INTENT_EXPAND_SYSTEM_PROMPT } from "./prompts/intentExpandPrompt.js";
import { CANDIDATE_RERANK_SYSTEM_PROMPT } from "./prompts/candidateRerankPrompt.js";
import {
  type CandidateRerankOutput,
  type DemoResponseComposeOutput,
  type EvidenceExtractOutput,
  type ExperienceSummaryOutput,
  type GroundingGuardOutput,
  type IntentExpandOutput,
  parseCandidateRerankOutput,
  parseDemoResponseComposeOutput,
  parseEvidenceExtractOutput,
  parseExperienceSummaryOutput,
  parseGroundingGuardOutput,
  parseIntentExpandOutput
} from "./schemas/taskSchemas.js";
import {
  buildFallbackSearchQueryPlan,
  buildObjectiveSearchContext,
  objectiveQueryPlanToSearchPlans,
  sortSearchQueryPlans
} from "./searchQueryPlan.js";
import { enforceDemoPathDiversity } from "../services/demoPathDiversity.service.js";
import { applyGroundedPathCopyToResponse } from "../services/demoPathGrounding.service.js";

interface ComposeMultiLlmDemoSearchInput {
  query: string;
  count: number;
  dataMode: DemoDataMode;
  startedAt: number;
  requestBudgetMs?: number;
  userContext?: UserContext;
  clarificationContext?: DemoDebugClarificationContext;
}

interface CleanedCandidate {
  candidateId: string;
  personId: string;
  articleId: string;
  sourceRefId: string;
  title: string;
  text: string;
  evidenceText: string;
  author: string;
  sourceUrl: string;
  sampleType: string;
  relevanceScore: number;
  qualityScore: number;
  experienceSignalScore: number;
  contentLength: number;
  filterReason: string;
  roughScore?: number;
  matchedQuery?: string;
  queryType?: string;
  queryPurpose?: string;
  contentRole?: string;
  relationToUserIntent?: string;
  summaryAngle?: string;
  diversityKey?: string;
  keepReason?: string;
}

interface ExperienceSummaryCandidate {
  personId: string;
  candidateId: string;
  articleId: string;
  sourceRefId: string;
  title: string;
  content: string;
  summary: string;
  evidence: Array<{
    id: string;
    label: string;
    text: string;
  }>;
  candidateQuality: {
    relevanceScore: number;
    qualityScore: number;
    experienceSignalScore: number;
    contentLength: number;
    filterReason: string;
  };
  contentHash: string;
  fallbackSummary: string;
  matchedQuery?: string;
  queryType?: string;
  queryPurpose?: string;
}

interface ExperienceSummaryStageOutput {
  summaries: ExperienceSummaryOutput;
  debug: DemoExperienceSummaryDebug[];
}

interface StageRunResult<T> {
  output: T;
  stageResult: DemoDebugLlmStageResult;
}

interface TimedStageRunResult<T> extends StageRunResult<T> {
  durationMs: number;
}

interface ComposeApplyStats {
  focusTagCount: number;
  pathCount: number;
  peopleCount: number;
  personaCount: number;
}

interface LlmFallbackSummary {
  used: boolean;
  kind: DemoDebugFallbackKind;
  reason: string;
}

interface SearchByExpandedQueriesResult {
  items: SearchItem[];
  searchQueries: DemoSearchQueryPlan[];
  searchQueryResults: DemoSearchQueryResultDebug[];
  searchDebug: DemoSearchDebug;
  rawCandidateCount: number;
  mergedCandidateCount: number;
  dedupedCandidateCount: number;
}

interface CandidatePipelineResult {
  items: SearchItem[];
  candidateQuality: DemoCandidateQuality[];
  stageResult: DemoDebugLlmStageResult;
  durationMs: number;
  rerankEnabled: boolean;
  rerankUsed: boolean;
  rerankFailedReason: string;
  rerankCandidatesCount: number;
  selectedCandidatesCount: number;
  droppedCandidatesCount: number;
  refillTriggered: boolean;
  refillReason: string;
  refillQueries: DemoSearchQueryPlan[];
  refillCandidateCount: number;
  finalCandidateCount: number;
  roughTierDistribution: ReturnType<typeof buildRoughTierDistribution>;
  finalCandidates: NonNullable<DemoSearchResponse["debug"]["finalCandidates"]>;
  droppedCandidates: NonNullable<DemoSearchResponse["debug"]["droppedCandidates"]>;
}

interface PipelineBudget {
  startedAt: number;
  budgetMs: number;
}

class RealSearchDegradedError extends HttpError {
  public readonly searchDebug: DemoSearchDebug;

  constructor(code: string, message: string, searchDebug: DemoSearchDebug) {
    super(502, code, message);
    this.name = "RealSearchDegradedError";
    this.searchDebug = searchDebug;
  }
}

const MAX_SEARCH_PLAN_QUERIES = 12;
const MIN_SEARCH_ROUNDS = 3;
const MAX_SEARCH_ROUNDS = 6;
const MAX_REAL_ITEMS = 12;
const MAX_RERANK_PROMPT_CANDIDATES = 2;
const MAX_DEMO_COMPOSE_PATHS = 1;
const MAX_DEMO_COMPOSE_PEOPLE = 1;
const MAX_EVIDENCE_EXTRACT_PROMPT_CANDIDATES = 1;
const EVIDENCE_EXTRACT_CONTEXT_CHAR_BUDGET = 650;
const MAX_EXPERIENCE_SUMMARY_PEOPLE = 3;
const MIN_CONTENT_LENGTH = 8;
const EXPERIENCE_SUMMARY_MIN_CONTENT_LENGTH = 60;
const EXPERIENCE_SUMMARY_MIN_QUALITY_SCORE = 0.38;
const EXPERIENCE_SUMMARY_MIN_EXPERIENCE_SIGNAL_SCORE = 0.26;
const EXPERIENCE_SUMMARY_CACHE_TTL_MS = 15 * 60 * 1000;

const PATH_DISPLAY_COPY: Record<DemoContentRole, {
  title: string;
  summary: string;
  tradeoff: string;
}> = {
  failure_review: {
    title: "辞职后复盘：后悔、回流与再选择",
    summary: "这类内容适合看离开工作之后的回头复盘：哪些选择后来显得草率，哪些回流接口还在，哪些问题需要重新选一次。",
    tradeoff: "它能提醒坑在哪里，但不能保证换个人照做就得到同样结果；尤其要把现金流、回流成本和情绪恢复分开判断。"
  },
  decision_conflict: {
    title: "待业中的拉扯：想走出去但没有确定路径",
    summary: "这类内容呈现的是待业或暂停工作时的摇摆：想离开原来的节奏，又还没有形成足够确定的下一步。",
    tradeoff: "它的价值在于暴露冲突，不在于给出答案；如果证据只到片段层面，就只能当作处境参考。"
  },
  life_path: {
    title: "过渡型路径：先解决现金流，再决定下一步",
    summary: "这类内容更像过渡方案：先把基本生活、收入来源和可回撤条件稳住，再判断要继续休整、找工作还是换一种生活半径。",
    tradeoff: "它能降低短期失控感，但不等于长期路径已经清楚；现金流一旦接不上，选择空间会很快变窄。"
  },
  real_experience: {
    title: "不上班后的真实日常：时间、成本和生活节奏",
    summary: "这类内容更接近日常经验：不上班之后时间如何被重新安排，钱、社交和自我认同怎样变成具体问题。",
    tradeoff: "它能提供生活质感和现实细节，但只代表公开内容里的那段经历，不能外推成普遍结论。"
  },
  alternative_solution: {
    title: "低成本备选方案：回老家、自由职业、远程/副业",
    summary: "这类内容提供的是低成本备选：用回老家、远程工作、自由职业或副业先换一段缓冲，而不是马上押上不可逆决定。",
    tradeoff: "它会降低一部分压力，也可能低估孤独、收入波动和机会变少；适合先看来源片段，再判断可迁移性。"
  },
  viewpoint: {
    title: "观点型参考：只能作为方向，不当作亲历",
    summary: "这类内容主要是观点和变量拆解，可以帮助梳理方向、成本和风险，但不能包装成作者亲历过完整过程。",
    tradeoff: "它只能作为方向参考；如果缺少明确经历和来源证据，就不开放追问，只建议查看来源片段。"
  }
};

const experienceSummaryCache = new Map<
  string,
  {
    expiresAt: number;
    summary: NonNullable<ExperienceSummaryOutput["summaries"][number]["experienceSummary"]>;
    confidence: number;
    reason: string;
  }
>();

export async function composeMultiLlmDemoSearchResponse(
  input: ComposeMultiLlmDemoSearchInput
): Promise<DemoSearchResponse> {
  const stageResults: DemoDebugLlmStageResult[] = [];
  const timings: DemoDebugTiming[] = [];
  const guardWarnings: string[] = [];
  const budget = createPipelineBudget(input.startedAt, input.requestBudgetMs);
  const pipelineQuery = buildClarifiedPipelineQuery(input.query, input.clarificationContext);

  const intentStage = await runTimedStage(() =>
    runIntentExpandStage(pipelineQuery, input.userContext, budget, input.clarificationContext)
  );
  stageResults.push(intentStage.stageResult);
  timings.push(createStageTiming(intentStage));
  const searchIntent = applyClarificationSearchQueries(
    intentStage.output,
    input.clarificationContext
  );

  const recalledSearch = await searchByExpandedQueries(
    pipelineQuery,
    searchIntent,
    input.count,
    input.dataMode,
    input.userContext
  );
  if (recalledSearch.items.length === 0) {
    const fallbackReason =
      recalledSearch.searchDebug.fallbackReason ?? "real search returned no usable candidates";
    throw new RealSearchDegradedError(
      "REAL_SEARCH_DEGRADED",
      fallbackReason,
      recalledSearch.searchDebug
    );
  }

  const candidatePipeline = await runCandidatePipeline(
    pipelineQuery,
    searchIntent,
    recalledSearch,
    input.count,
    input.dataMode,
    input.userContext,
    budget
  );
  stageResults.push(candidatePipeline.stageResult);
  timings.push(logAndCreateStageTiming({
    stageName: candidatePipeline.stageResult.stage,
    provider: candidatePipeline.stageResult.provider,
    model: candidatePipeline.stageResult.model,
    durationMs: candidatePipeline.durationMs,
    llmUsed: candidatePipeline.rerankUsed,
    fallbackUsed:
      candidatePipeline.stageResult.attempted === 0 || candidatePipeline.stageResult.failed > 0,
    fallbackReason: candidatePipeline.stageResult.fallbackReasons.join("; ")
  }));

  const cleanedSearchItems = candidatePipeline.items;
  if (cleanedSearchItems.length === 0) {
    const fallbackReason = "no_effective_candidates_after_candidate_pipeline";
    throw new RealSearchDegradedError(
      "REAL_SEARCH_EMPTY_AFTER_CLEANING",
      "real search returned no usable items after rule cleaning",
      markSearchDebugDegraded(recalledSearch.searchDebug, fallbackReason)
    );
  }

  const response = composeRealDemoSearchResponse({
    query: input.query,
    count: input.count,
    dataMode: input.dataMode,
    items: cleanedSearchItems,
    startedAt: input.startedAt,
    userContext: input.userContext,
    candidateQuality: candidatePipeline.candidateQuality
  });

  const candidates = buildCleanedCandidatesFromResponse(response);
  const evidenceStage = await runTimedStage(() =>
    runEvidenceExtractStage(pipelineQuery, searchIntent, candidates, budget)
  );
  stageResults.push(evidenceStage.stageResult);
  timings.push(createStageTiming(evidenceStage));
  applyEvidenceExtractDisplayStatus(
    response,
    evidenceStage.output,
    evidenceStage.stageResult.succeeded > 0
  );

  const composeStage = await runTimedStage(() =>
    runDemoResponseComposeStage(
      pipelineQuery,
      searchIntent,
      evidenceStage.output,
      response,
      candidates,
      input.userContext,
      budget
    )
  );
  stageResults.push(composeStage.stageResult);
  timings.push(createStageTiming(composeStage));

  const applyStats = applyDemoResponseComposeOutput(response, composeStage.output, guardWarnings);
  guardWarnings.push(...applyGroundedPathCopyToResponse(response, input.query));
  response.debug.pathDiversityCheck = enforceDemoPathDiversity(response.paths, {
    mergeCount: response.debug.pathDiversityCheck?.mergeCount,
    notes: [
      ...(response.debug.pathDiversityCheck?.notes ?? []),
      composeStage.stageResult.succeeded > 0
        ? "LLM composer output rechecked for path title/summary diversity"
        : "LLM composer fallback preserved deterministic path diversity"
    ]
  });
  response.debug.pathDuplicateFound = response.debug.pathDiversityCheck.duplicateFound;
  applyDisplayGateFields(response);
  syncTopLevelPersonas(response);

  const experienceSummaryStage = await runTimedStage(() =>
    runExperienceSummaryStage(input.query, response, budget)
  );
  stageResults.push(experienceSummaryStage.stageResult);
  timings.push(createStageTiming(experienceSummaryStage));
  applyExperienceSummaryOutput(response, experienceSummaryStage.output);

  const groundingStage = await runTimedStage(() => runGroundingGuardStage(response, budget));
  stageResults.push(groundingStage.stageResult);
  timings.push(createStageTiming(groundingStage));
  applyGroundingGuardOutput(response, groundingStage.output, guardWarnings);
  applyRuleGroundingGuard(response, guardWarnings);
  applyDisplayGateFields(response);
  syncTopLevelPersonas(response);
  assertDemoSearchGrounding(response);

  const successfulStages = stageResults.reduce((total, item) => total + item.succeeded, 0);
  const fallbackSummary = summarizeLlmFallback(stageResults);
  const llmStageMeta = buildLlmStageMeta(timings);

  response.meta.latencyMs = Date.now() - input.startedAt;
  response.meta.totalDurationMs = response.meta.latencyMs;
  response.meta.fallbackUsed = fallbackSummary.used;
  response.meta.fallbackStages = llmStageMeta.fallbackStages;
  response.meta.llmStages = llmStageMeta.llmStages;
  response.meta.timedOutStages = llmStageMeta.timedOutStages;
  response.contextUsed = createDemoContextUsed(input.userContext, [
    "intent_expand",
    "search_query_expand",
    "fit_reason"
  ]);
  response.debug = {
    ...response.debug,
    composer: successfulStages > 0 ? "real_llm_composer" : "real_rule_composer",
    requestedDataMode: input.dataMode,
    resolvedDataMode: input.dataMode,
    itemCount: response.people.length,
    sourceItemCount: cleanedSearchItems.length,
    pathCount: response.paths.length,
    peopleCount: response.people.length,
    personaCount: response.personas?.length ?? 0,
    llmUsed: successfulStages > 0,
    llmComposerUsed: composeStage.stageResult.succeeded > 0,
    llmRepairUsed: false,
    llmRepairFailed: false,
    llmStageResults: stageResults,
    llmArtifactSources: buildLlmArtifactSources(stageResults),
    timings,
    enhancedPeopleCount: applyStats.peopleCount + applyStats.personaCount,
    enhancedPathCount: applyStats.pathCount,
    partialFallbackUsed: fallbackSummary.kind === "partial_llm_fallback",
    pathSource: applyStats.pathCount > 0 ? "llm" : response.debug.pathSource,
    composerFallbackTriggered: composeStage.stageResult.succeeded === 0,
    pathDuplicateFound: response.debug.pathDiversityCheck?.duplicateFound ?? false,
    pathDiversityCheck: response.debug.pathDiversityCheck,
    intentStage: buildIntentStageDebug(
      intentStage.stageResult,
      composeStage.stageResult,
      applyStats.focusTagCount > 0,
      searchIntent
    ),
    fallbackUsed: fallbackSummary.used,
    fallbackKind: fallbackSummary.kind,
    fallbackReason: fallbackSummary.reason,
    guardWarnings,
    userCoreQuestion: searchIntent.userCoreQuestion,
    topicSignals: searchIntent.topicSignals,
    searchQueries: recalledSearch.searchQueries,
    searchQueryResults: recalledSearch.searchQueryResults,
    search: recalledSearch.searchDebug,
    rawCandidateCount: recalledSearch.rawCandidateCount,
    mergedCandidateCount: recalledSearch.mergedCandidateCount,
    dedupedCandidateCount: recalledSearch.dedupedCandidateCount,
    validCandidateCount: cleanedSearchItems.length,
    roughTierDistribution: candidatePipeline.roughTierDistribution,
    rerankEnabled: candidatePipeline.rerankEnabled,
    rerankUsed: candidatePipeline.rerankUsed,
    rerankDurationMs: candidatePipeline.durationMs,
    rerankFailedReason: candidatePipeline.rerankFailedReason,
    rerankCandidatesCount: candidatePipeline.rerankCandidatesCount,
    selectedCandidatesCount: candidatePipeline.selectedCandidatesCount,
    droppedCandidatesCount: candidatePipeline.droppedCandidatesCount,
    refillTriggered: candidatePipeline.refillTriggered,
    refillReason: candidatePipeline.refillReason,
    refillQueries: candidatePipeline.refillQueries,
    refillCandidateCount: candidatePipeline.refillCandidateCount,
    finalCandidateCount: candidatePipeline.finalCandidateCount,
    finalCandidates: attachFinalCandidateSourceRefs(
      candidatePipeline.finalCandidates,
      response.debug.candidateQuality
    ),
    droppedCandidates: candidatePipeline.droppedCandidates,
    candidateQuality: response.debug.candidateQuality,
    experienceSummaryDebug: experienceSummaryStage.output.debug,
    notes:
      successfulStages > 0
        ? [
            "real Zhihu items cleaned by rules",
            fallbackSummary.reason || "all configured LLM stages completed without fallback",
            "DeepSeek LLM stages enhanced safe display fields where available"
          ]
        : [
            "real Zhihu items cleaned by rules",
            fallbackSummary.reason || "all LLM stages used deterministic rules",
            "deterministic rule composer used; no successful LLM stage"
          ]
  };

  return response;
}

export function hasPersonaChatLlm(): boolean {
  return llmRouter.isTaskConfigured("persona_chat");
}

function buildClarifiedPipelineQuery(
  query: string,
  clarificationContext?: DemoDebugClarificationContext
): string {
  if (!clarificationContext?.answerSummary) {
    return query;
  }

  return truncateText(
    [
      query,
      `补充信息：${clarificationContext.answerSummary}`,
      `检索提示：${clarificationContext.searchHints.slice(0, 3).join("；")}`
    ].join("；"),
    220
  );
}

function applyClarificationSearchQueries(
  intent: IntentExpandOutput,
  clarificationContext?: DemoDebugClarificationContext
): IntentExpandOutput {
  const queryPlan = clarificationContext?.queryPlan;
  if (!queryPlan) {
    return intent;
  }

  const clarificationSearchQueries = objectiveQueryPlanToSearchPlans(queryPlan);
  if (clarificationSearchQueries.length === 0) {
    return intent;
  }

  return {
    ...intent,
    searchQueries: sortSearchQueryPlans([
      ...clarificationSearchQueries,
      ...intent.searchQueries
    ]),
    queryPlan: {
      primary: unique([...(queryPlan.primary ?? []), ...(intent.queryPlan?.primary ?? [])]).slice(0, 5),
      secondary: unique([
        ...(queryPlan.secondary ?? []),
        ...(intent.queryPlan?.secondary ?? [])
      ]).slice(0, 5),
      fallback: unique([...(queryPlan.fallback ?? []), ...(intent.queryPlan?.fallback ?? [])]).slice(0, 4)
    }
  };
}

async function runTimedStage<T>(
  task: () => Promise<StageRunResult<T>>
): Promise<TimedStageRunResult<T>> {
  const startedAt = Date.now();
  const result = await task();
  return {
    ...result,
    durationMs: Date.now() - startedAt
  };
}

function createStageTiming(result: TimedStageRunResult<unknown>): DemoDebugTiming {
  const fallbackUsed = result.stageResult.attempted === 0 || result.stageResult.failed > 0;
  const runtimeInfo = getLlmStageRuntimeInfo(result.stageResult.stage);
  return logAndCreateStageTiming({
    stageName: result.stageResult.stage,
    ...runtimeInfo,
    provider: result.stageResult.provider ?? runtimeInfo.provider,
    model: result.stageResult.model ?? runtimeInfo.model,
    durationMs: result.durationMs,
    llmUsed: result.stageResult.succeeded > 0,
    fallbackUsed,
    fallbackReason: fallbackUsed ? result.stageResult.fallbackReasons.join("; ") : ""
  });
}

function logAndCreateStageTiming(timing: DemoDebugTiming): DemoDebugTiming {
  const enrichedTiming = {
    ...getLlmStageRuntimeInfo(timing.stageName),
    ...timing
  };
  const status = enrichedTiming.llmUsed
    ? "success"
    : isTimeoutFallbackReason(enrichedTiming.fallbackReason)
      ? "timeout"
      : "fallback";
  const payload = {
    taskType: enrichedTiming.stageName,
    provider: enrichedTiming.provider,
    model: enrichedTiming.model,
    status,
    durationMs: enrichedTiming.durationMs,
    fallbackReason: enrichedTiming.fallbackReason
  };

  if (enrichedTiming.fallbackUsed) {
    console.warn(formatLlmStageLogLine(payload));
  } else {
    console.info(formatLlmStageLogLine(payload));
  }

  return enrichedTiming;
}

function buildLlmStageMeta(timings: DemoDebugTiming[]): {
  fallbackStages: string[];
  llmStages: NonNullable<DemoSearchResponse["meta"]["llmStages"]>;
  timedOutStages: string[];
} {
  const llmStages = timings.map((timing) => {
    const timedOut = isTimeoutFallbackReason(timing.fallbackReason);
    return {
      taskType: timing.stageName,
      provider: timing.provider,
      model: timing.model,
      status: timing.llmUsed ? "success" : timedOut ? "timeout" : "fallback",
      durationMs: timing.durationMs,
      fallbackReason: timing.fallbackReason
    } as const;
  });

  return {
    fallbackStages: unique(
      timings.filter((timing) => timing.fallbackUsed).map((timing) => timing.stageName)
    ),
    llmStages,
    timedOutStages: unique(
      timings
        .filter((timing) => isTimeoutFallbackReason(timing.fallbackReason))
        .map((timing) => timing.stageName)
    )
  };
}

function buildLlmArtifactSources(
  stageResults: DemoDebugLlmStageResult[]
): NonNullable<DemoSearchResponse["debug"]["llmArtifactSources"]> {
  const artifactStages = [
    "intent_expand",
    "candidate_rerank",
    "evidence_extract",
    "demo_response_compose",
    "experience_summary",
    "grounding_guard"
  ] as const;
  const result = {} as NonNullable<DemoSearchResponse["debug"]["llmArtifactSources"]>;

  for (const stageName of artifactStages) {
    const stage = stageResults.find((item) => item.stage === stageName);
    const fallbackReason = stage?.fallbackReasons.join("; ");
    if (!stage || stage.attempted === 0) {
      result[stageName] = {
        source: "skipped",
        stageStatus: "skipped",
        ...(fallbackReason ? { fallbackReason } : {})
      };
      continue;
    }

    if (stage.succeeded > 0) {
      result[stageName] = {
        source: "llm",
        stageStatus: "success",
        ...(fallbackReason ? { fallbackReason } : {})
      };
      continue;
    }

    result[stageName] = {
      source: "rule_fallback",
      stageStatus: "fallback",
      ...(fallbackReason ? { fallbackReason } : {})
    };
  }

  return result;
}

function isTimeoutFallbackReason(reason: string): boolean {
  return /timeout|timed out|exceeded|LLM_TASK_TIMEOUT|LLM_TIMEOUT/i.test(reason);
}

function getLlmStageRuntimeInfo(
  stageName: DemoDebugTiming["stageName"]
): Pick<DemoDebugTiming, "provider" | "model"> {
  if (!isRoutedLlmTask(stageName)) {
    return {};
  }

  return {
    provider: llmRouter.getProviderForTask(stageName),
    model: llmRouter.getModelForTask(stageName)
  };
}

function isRoutedLlmTask(stageName: DemoDebugTiming["stageName"]): stageName is LlmTaskType {
  return (
    stageName === "intent_expand" ||
    stageName === "candidate_rerank" ||
    stageName === "evidence_extract" ||
    stageName === "demo_response_compose" ||
    stageName === "experience_summary" ||
    stageName === "grounding_guard" ||
    stageName === "persona_chat"
  );
}

function formatLlmStageLogLine(payload: {
  taskType: string;
  provider?: string;
  model?: string;
  status: string;
  durationMs: number;
  fallbackReason: string;
}): string {
  const fields: Array<[string, string | number | undefined]> = [
    ["provider", payload.provider],
    ["model", payload.model],
    ["taskType", payload.taskType],
    ["durationMs", payload.durationMs],
    ["status", payload.status],
    ["fallbackReason", payload.fallbackReason]
  ];

  return `[LLMStage] ${fields
    .filter(([, value]) => value !== undefined && value !== "")
    .map(([key, value]) => `${key}=${formatLogValue(value)}`)
    .join(" ")}`;
}

function formatLogValue(value: string | number | undefined): string {
  if (typeof value === "number") {
    return String(value);
  }

  const text = String(value ?? "");
  return /\s/.test(text) ? JSON.stringify(text) : text;
}

function createPipelineBudget(
  startedAt: number,
  requestBudgetMs: number | undefined
): PipelineBudget {
  return {
    startedAt,
    budgetMs: requestBudgetMs ?? 15000
  };
}

function hasBudgetForLlmStage(taskType: LlmTaskType, budget?: PipelineBudget): boolean {
  if (!budget) {
    return true;
  }

  const remainingMs = budget.budgetMs - (Date.now() - budget.startedAt);
  return remainingMs > getLlmTaskTimeoutMs(taskType) + 350;
}

function createBudgetSkippedStage(stage: LlmTaskType): DemoDebugLlmStageResult {
  return createSkippedStage(
    stage,
    `request budget has insufficient remaining time for ${stage}; deterministic fallback used`
  );
}

async function runJsonTaskWithStageTimeout(
  taskType: LlmTaskType,
  input: Parameters<typeof llmRouter.runJsonTask>[1]
): Promise<string> {
  return llmRouter.runJsonTask(taskType, {
    ...input,
    timeoutMs: getLlmTaskTimeoutMs(taskType),
    maxRetry: taskType === "intent_expand" ? 1 : 0
  });
}

async function runPreferredJsonTaskWithStageTimeout(
  taskType: LlmTaskType,
  input: Omit<JsonCompletionInput, "taskType">
): Promise<{
  content: string;
  provider?: string;
  model?: string;
}> {
  if (!shouldPreferKimiForTask(taskType)) {
    return {
      content: await runJsonTaskWithStageTimeout(taskType, input)
    };
  }

  const startedAt = Date.now();
  try {
    const content = await kimiClient.createJsonCompletion({
      ...input,
      taskType,
      timeoutMs: getKimiTaskTimeoutMs(taskType, input),
      maxRetry: 0,
      responseFormat: input.responseFormat === null ? undefined : input.responseFormat
    });
    console.info(
      formatLlmStageLogLine({
        taskType,
        provider: kimiClient.provider,
        model: kimiClient.model,
        status: "success",
        durationMs: Date.now() - startedAt,
        fallbackReason: ""
      })
    );
    return {
      content,
      provider: kimiClient.provider,
      model: kimiClient.model
    };
  } catch (error) {
    console.warn(
      formatLlmStageLogLine({
        taskType,
        provider: kimiClient.provider,
        model: kimiClient.model,
        status: "fallback",
        durationMs: Date.now() - startedAt,
        fallbackReason: `Kimi preferred route failed; DeepSeek route will be tried: ${formatErrorSummary(error)}`
      })
    );
    return {
      content: await runJsonTaskWithStageTimeout(taskType, input)
    };
  }
}

function shouldPreferKimiForTask(taskType: LlmTaskType): boolean {
  if (!kimiClient.isConfigured()) {
    return false;
  }

  return (
    taskType === "candidate_rerank" ||
    taskType === "evidence_extract" ||
    taskType === "demo_response_compose" ||
    taskType === "experience_summary"
  );
}

function getKimiTaskTimeoutMs(
  taskType: LlmTaskType,
  input: Omit<JsonCompletionInput, "taskType">
): number {
  const timeoutMs = input.timeoutMs ?? getLlmTaskTimeoutMs(taskType);
  return taskType === "intent_expand" ? Math.min(timeoutMs, 15000) : timeoutMs;
}

async function runKimiFallbackJsonTask(
  taskType: LlmTaskType,
  input: Omit<JsonCompletionInput, "taskType">,
  originalError: unknown
): Promise<string | undefined> {
  if (!kimiClient.isConfigured() || !isKimiFallbackEligible(originalError)) {
    return undefined;
  }

  const startedAt = Date.now();
  try {
    const content = await kimiClient.createJsonCompletion({
      ...input,
      taskType,
      timeoutMs: getKimiTaskTimeoutMs(taskType, input),
      maxRetry: 0,
      responseFormat: input.responseFormat === null ? undefined : input.responseFormat
    });
    console.info(
      formatLlmStageLogLine({
        taskType,
        provider: kimiClient.provider,
        model: kimiClient.model,
        status: "success",
        durationMs: Date.now() - startedAt,
        fallbackReason: `DeepSeek retry fallback after ${formatErrorSummary(originalError)}`
      })
    );
    return content;
  } catch (fallbackError) {
    console.warn(
      formatLlmStageLogLine({
        taskType,
        provider: kimiClient.provider,
        model: kimiClient.model,
        status: "fallback",
        durationMs: Date.now() - startedAt,
        fallbackReason: `Kimi fallback failed after ${formatErrorSummary(originalError)}; ${formatErrorSummary(fallbackError)}`
      })
    );
    return undefined;
  }
}

function isKimiFallbackEligible(error: unknown): boolean {
  return /LLM_EMPTY_RESPONSE|LLM_TIMEOUT|LLM_TASK_TIMEOUT|LLM_JSON_PARSE_FAILED|timed out|empty response|did not include content|invalid json|did not contain a JSON object/i.test(
    formatErrorSummary(error)
  );
}

async function runIntentExpandStage(
  query: string,
  userContext?: UserContext,
  budget?: PipelineBudget,
  clarificationContext?: DemoDebugClarificationContext
): Promise<StageRunResult<IntentExpandOutput>> {
  const fallback = createFallbackIntent(query);
  if (!hasBudgetForLlmStage("intent_expand", budget)) {
    return {
      output: fallback,
      stageResult: createBudgetSkippedStage("intent_expand")
    };
  }

  if (!llmRouter.isTaskConfigured("intent_expand")) {
    return {
      output: fallback,
      stageResult: createSkippedStage("intent_expand", "DeepSeek not configured; original query used")
    };
  }

  const completionInput: Omit<JsonCompletionInput, "taskType"> = {
    temperature: 0.1,
    maxTokens: 1200,
    messages: [
      {
        role: "system",
        content: INTENT_EXPAND_SYSTEM_PROMPT
      },
      {
        role: "user",
        content: JSON.stringify({
          query: truncateText(query, 120),
          clarificationContext: clarificationContext
            ? {
                answerSummary: clarificationContext.answerSummary,
                searchHints: clarificationContext.searchHints
              }
            : null,
          userContext: buildPromptUserContext(userContext)
        })
      }
    ]
  };

  try {
    const content = await runJsonTaskWithStageTimeout("intent_expand", completionInput);
    return {
      output: parseIntentExpandOutput(content, query),
      stageResult: createSuccessStage("intent_expand")
    };
  } catch (error) {
    const fallbackContent = await runKimiFallbackJsonTask("intent_expand", completionInput, error);
    if (fallbackContent) {
      try {
        return {
          output: parseIntentExpandOutput(fallbackContent, query),
          stageResult: createSuccessStage("intent_expand", kimiClient.provider, kimiClient.model)
        };
      } catch {
        // Fall through to deterministic intent fallback below.
      }
    }

    return {
      output: fallback,
      stageResult: createFallbackStage("intent_expand", error)
    };
  }
}

async function runEvidenceExtractStage(
  query: string,
  intent: IntentExpandOutput,
  candidates: CleanedCandidate[],
  budget?: PipelineBudget
): Promise<StageRunResult<EvidenceExtractOutput>> {
  const fallback = createFallbackEvidenceExtract(candidates);
  if (candidates.length === 0) {
    return {
      output: fallback,
      stageResult: createSkippedStage("evidence_extract", "no cleaned candidates")
    };
  }

  if (!llmRouter.isTaskConfigured("evidence_extract")) {
    return {
      output: fallback,
      stageResult: createSkippedStage("evidence_extract", "DeepSeek not configured; rule evidence seeds used")
    };
  }

  if (!hasBudgetForLlmStage("evidence_extract", budget)) {
    return {
      output: fallback,
      stageResult: createBudgetSkippedStage("evidence_extract")
    };
  }

  let completionInput: Omit<JsonCompletionInput, "taskType"> | undefined;
  try {
    const promptCandidates = toEvidenceExtractPromptCandidates(candidates);
    completionInput = {
      temperature: 0.1,
      maxTokens: 500,
      messages: [
        {
          role: "system",
          content: EVIDENCE_EXTRACT_SYSTEM_PROMPT
        },
        {
          role: "user",
          content: JSON.stringify({
            query: truncateText(query, 120),
            intent,
            promptBudget: {
              model: llmRouter.getModelForTask("evidence_extract"),
              maxContextTokens: 3500,
              candidateCount: promptCandidates.length,
              evidenceCharBudget: EVIDENCE_EXTRACT_CONTEXT_CHAR_BUDGET
            },
            candidates: promptCandidates
          })
        }
      ]
    };
    let content: string;
    let completionProvider: string | undefined;
    let completionModel: string | undefined;
    try {
      const completion = await runPreferredJsonTaskWithStageTimeout(
        "evidence_extract",
        completionInput
      );
      content = completion.content;
      completionProvider = completion.provider;
      completionModel = completion.model;
    } catch (error) {
      const fallbackContent = await runKimiFallbackJsonTask("evidence_extract", completionInput, error);
      if (!fallbackContent) {
        throw error;
      }
      content = fallbackContent;
      completionProvider = kimiClient.provider;
      completionModel = kimiClient.model;
    }

    return {
      output: parseEvidenceExtractOutput(content, new Set(candidates.map((item) => item.sourceRefId))),
      stageResult: createSuccessStage("evidence_extract", completionProvider, completionModel)
    };
  } catch (error) {
    const fallbackContent = completionInput
      ? await runKimiFallbackJsonTask("evidence_extract", completionInput, error)
      : undefined;
    if (fallbackContent) {
      try {
        return {
          output: parseEvidenceExtractOutput(
            fallbackContent,
            new Set(candidates.map((item) => item.sourceRefId))
          ),
          stageResult: createSuccessStage("evidence_extract", kimiClient.provider, kimiClient.model)
        };
      } catch {
        // Fall through to raw snippet fallback below.
      }
    }

    return {
      output: fallback,
      stageResult: createFallbackStage("evidence_extract", error)
    };
  }
}

async function runDemoResponseComposeStage(
  query: string,
  intent: IntentExpandOutput,
  evidence: EvidenceExtractOutput,
  response: DemoSearchResponse,
  candidates: CleanedCandidate[],
  userContext?: UserContext,
  budget?: PipelineBudget
): Promise<StageRunResult<DemoResponseComposeOutput>> {
  const fallback = createEmptyDemoComposeOutput();
  if (!llmRouter.isTaskConfigured("demo_response_compose")) {
    return {
      output: fallback,
      stageResult: createSkippedStage(
        "demo_response_compose",
        "DeepSeek not configured; deterministic display fields preserved"
      )
    };
  }

  if (!hasBudgetForLlmStage("demo_response_compose", budget)) {
    return {
      output: fallback,
      stageResult: createBudgetSkippedStage("demo_response_compose")
    };
  }

  let composePathIds: string[] = [];
  let composePersonIds: string[] = [];
  let completionInput: Omit<JsonCompletionInput, "taskType"> | undefined;

  try {
    composePathIds = response.paths.slice(0, MAX_DEMO_COMPOSE_PATHS).map((path) => path.id);
    composePersonIds = response.people.slice(0, MAX_DEMO_COMPOSE_PEOPLE).map((person) => person.id);
    const finalCandidates = candidates
      .filter(
        (candidate) =>
          composePersonIds.includes(candidate.personId) ||
          response.paths
            .filter((path) => composePathIds.includes(path.id))
            .some((path) => path.sourceRefs.includes(candidate.sourceRefId))
      )
      .slice(0, Math.max(MAX_DEMO_COMPOSE_PEOPLE, MAX_DEMO_COMPOSE_PATHS))
      .map(toDemoResponseComposeFinalCandidate);
    completionInput = {
      temperature: 0.2,
      maxTokens: 700,
      messages: [
        {
          role: "system",
          content: DEMO_RESPONSE_COMPOSE_SYSTEM_PROMPT
        },
        {
          role: "user",
          content: JSON.stringify({
            originalQuery: truncateText(query, 120),
            query: truncateText(query, 120),
            userCoreQuestion: intent.userCoreQuestion,
            focusTags: intent.focusTags,
            topicSignals: intent.topicSignals,
            userContext: buildPromptUserContext(userContext),
            intent,
            evidenceExtract: evidence,
            allowedIds: {
              pathIds: composePathIds,
              personIds: composePersonIds,
              sourceRefs: response.meta.sourceRefs.map((sourceRef) => sourceRef.id)
            },
            promptBudget: {
              maxPaths: composePathIds.length,
              maxPeople: composePersonIds.length,
              finalCandidateCount: finalCandidates.length
            },
            baseResponse: toDemoComposeContext(response, {
              pathIds: new Set(composePathIds),
              personIds: new Set(composePersonIds)
            }),
            finalCandidates
          })
        }
      ]
    };
    let content: string;
    let completionProvider: string | undefined;
    let completionModel: string | undefined;
    try {
      const completion = await runPreferredJsonTaskWithStageTimeout(
        "demo_response_compose",
        completionInput
      );
      content = completion.content;
      completionProvider = completion.provider;
      completionModel = completion.model;
    } catch (error) {
      const fallbackContent = await runKimiFallbackJsonTask(
        "demo_response_compose",
        completionInput,
        error
      );
      if (!fallbackContent) {
        throw error;
      }
      content = fallbackContent;
      completionProvider = kimiClient.provider;
      completionModel = kimiClient.model;
    }

    return {
      output: parseDemoResponseComposeOutput(content, {
        pathIds: new Set(composePathIds),
        personIds: new Set(composePersonIds)
      }),
      stageResult: createSuccessStage(
        "demo_response_compose",
        completionProvider,
        completionModel
      )
    };
  } catch (error) {
    const fallbackContent = completionInput
      ? await runKimiFallbackJsonTask("demo_response_compose", completionInput, error)
      : undefined;
    if (fallbackContent) {
      try {
        return {
          output: parseDemoResponseComposeOutput(fallbackContent, {
            pathIds: new Set(composePathIds),
            personIds: new Set(composePersonIds)
          }),
          stageResult: createSuccessStage(
            "demo_response_compose",
            kimiClient.provider,
            kimiClient.model
          )
        };
      } catch {
        // Fall through to the deterministic compose fallback below.
      }
    }

    return {
      output: fallback,
      stageResult: createFallbackStage("demo_response_compose", error)
    };
  }
}

async function runExperienceSummaryStage(
  query: string,
  response: DemoSearchResponse,
  budget?: PipelineBudget
): Promise<StageRunResult<ExperienceSummaryStageOutput>> {
  const candidates = buildExperienceSummaryCandidates(query, response);
  const debug = initializeExperienceSummaryDebug(response, candidates);

  if (candidates.length === 0) {
    return {
      output: {
        summaries: { summaries: [] },
        debug
      },
      stageResult: createSkippedStage(
        "experience_summary",
        "no high-quality top people candidates for experienceSummary"
      )
    };
  }

  const cachedSummaries: ExperienceSummaryOutput["summaries"] = [];
  const uncachedCandidates: ExperienceSummaryCandidate[] = [];

  pruneExpiredExperienceSummaryCache();
  for (const candidate of candidates) {
    const cacheKey = buildExperienceSummaryCacheKey(query, candidate);
    const cached = experienceSummaryCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      cachedSummaries.push({
        personId: candidate.personId,
        experienceSummary: cached.summary,
        confidence: cached.confidence,
        reason: cached.reason
      });
      markExperienceSummaryDebug(debug, candidate.personId, {
        status: "ready",
        source: "llm",
        reason: "experienceSummary cache hit",
        cacheHit: true
      });
      continue;
    }

    uncachedCandidates.push(candidate);
  }

  if (uncachedCandidates.length === 0) {
    return {
      output: {
        summaries: { summaries: cachedSummaries },
        debug
      },
      stageResult: {
        stage: "experience_summary",
        attempted: 1,
        succeeded: cachedSummaries.length,
        failed: 0,
        repairUsed: 0,
        repairFailed: 0,
        fallbackReasons: []
      }
    };
  }

  if (!llmRouter.isTaskConfigured("experience_summary")) {
    for (const candidate of uncachedCandidates) {
      markExperienceSummaryDebug(debug, candidate.personId, {
        status: "failed",
        source: "none",
        reason: "DeepSeek not configured; experienceSummary not generated",
        cacheHit: false
      });
    }

    return {
      output: {
        summaries: { summaries: cachedSummaries },
        debug
      },
      stageResult: createSkippedStage("experience_summary", "DeepSeek not configured; experienceSummary not generated")
    };
  }

  if (!hasBudgetForLlmStage("experience_summary", budget)) {
    for (const candidate of uncachedCandidates) {
      markExperienceSummaryDebug(debug, candidate.personId, {
        status: "failed",
        source: "none",
        reason: "request budget had insufficient remaining time for experienceSummary",
        cacheHit: false
      });
    }

    return {
      output: {
        summaries: { summaries: cachedSummaries },
        debug
      },
      stageResult: createBudgetSkippedStage("experience_summary")
    };
  }

  try {
    const completionInput: Omit<JsonCompletionInput, "taskType"> = {
      temperature: 0.15,
      maxTokens: 1000,
      messages: [
        {
          role: "system",
          content: EXPERIENCE_SUMMARY_SYSTEM_PROMPT
        },
        {
          role: "user",
          content: JSON.stringify({
            query: truncateText(query, 120),
            people: uncachedCandidates.map(toExperienceSummaryPromptCandidate)
          })
        }
      ]
    };
    let content: string;
    let completionProvider: string | undefined;
    let completionModel: string | undefined;
    try {
      const completion = await runPreferredJsonTaskWithStageTimeout(
        "experience_summary",
        completionInput
      );
      content = completion.content;
      completionProvider = completion.provider;
      completionModel = completion.model;
    } catch (error) {
      const fallbackContent = await runKimiFallbackJsonTask(
        "experience_summary",
        completionInput,
        error
      );
      if (!fallbackContent) {
        throw error;
      }
      content = fallbackContent;
      completionProvider = kimiClient.provider;
      completionModel = kimiClient.model;
    }
    const parsed = parseExperienceSummaryOutput(
      content,
      new Set(uncachedCandidates.map((candidate) => candidate.personId))
    );
    const acceptedSummaries = filterAndCacheExperienceSummaries(
      query,
      parsed,
      uncachedCandidates,
      debug
    );
    const missingCount = uncachedCandidates.length - acceptedSummaries.length;

    return {
      output: {
        summaries: {
          summaries: [...cachedSummaries, ...acceptedSummaries]
        },
        debug
      },
      stageResult: {
        stage: "experience_summary",
        attempted: 1,
        succeeded: acceptedSummaries.length + cachedSummaries.length,
        failed: missingCount,
        repairUsed: 0,
        repairFailed: 0,
        ...(completionProvider ? { provider: completionProvider } : {}),
        ...(completionModel ? { model: completionModel } : {}),
        fallbackReasons:
          missingCount > 0
            ? ["some experienceSummary items were missing, null, or advice-style"]
            : []
      }
    };
  } catch (error) {
    const reason = formatErrorSummary(error);
    for (const candidate of uncachedCandidates) {
      markExperienceSummaryDebug(debug, candidate.personId, {
        status: "failed",
        source: "none",
        reason,
        cacheHit: false
      });
    }

    return {
      output: {
        summaries: { summaries: cachedSummaries },
        debug
      },
      stageResult: createFallbackStage("experience_summary", error)
    };
  }
}

async function runGroundingGuardStage(
  response: DemoSearchResponse,
  budget?: PipelineBudget
): Promise<StageRunResult<GroundingGuardOutput>> {
  const fallback = createPassingGroundingGuard();
  if (!llmRouter.isTaskConfigured("grounding_guard")) {
    return {
      output: fallback,
      stageResult: createSkippedStage("grounding_guard", "DeepSeek not configured; rule guard used")
    };
  }

  if (!hasBudgetForLlmStage("grounding_guard", budget)) {
    return {
      output: fallback,
      stageResult: createBudgetSkippedStage("grounding_guard")
    };
  }

  try {
    const completionInput: Omit<JsonCompletionInput, "taskType"> = {
      temperature: 0,
      maxTokens: 700,
      messages: [
        {
          role: "system",
          content: GROUNDING_GUARD_SYSTEM_PROMPT
        },
        {
          role: "user",
          content: JSON.stringify({
            allowedSourceRefs: response.meta.sourceRefs.map((sourceRef) => sourceRef.id),
            response: toGroundingGuardContext(response)
          })
        }
      ]
    };
    let content: string;
    let completionProvider: string | undefined;
    let completionModel: string | undefined;
    try {
      const completion = await runPreferredJsonTaskWithStageTimeout(
        "grounding_guard",
        completionInput
      );
      content = completion.content;
      completionProvider = completion.provider;
      completionModel = completion.model;
    } catch (error) {
      const fallbackContent = await runKimiFallbackJsonTask("grounding_guard", completionInput, error);
      if (!fallbackContent) {
        throw error;
      }
      content = fallbackContent;
      completionProvider = kimiClient.provider;
      completionModel = kimiClient.model;
    }

    const output = parseGroundingGuardOutput(content, {
      personIds: new Set(response.people.map((person) => person.id)),
      personaIds: new Set(readResponsePersonaIds(response))
    });

    return {
      output,
      stageResult: output.valid
        ? createSuccessStage("grounding_guard", completionProvider, completionModel)
        : createInvalidGroundingGuardStage(output)
    };
  } catch (error) {
    return {
      output: fallback,
      stageResult: createFallbackStage("grounding_guard", error)
    };
  }
}

async function searchByExpandedQueries(
  _originalQuery: string,
  intent: IntentExpandOutput,
  count: number,
  dataMode: DemoDataMode,
  _userContext?: UserContext
): Promise<SearchByExpandedQueriesResult> {
  const plannedQueries = sortSearchQueryPlans(intent.searchQueries).slice(0, MAX_SEARCH_PLAN_QUERIES);
  const searchRoundQueries = selectExecutableSearchQueries(plannedQueries);
  const perQueryCount = Math.min(Math.max(count, 3), 10);
  const items: SearchItem[] = [];
  const searchQueryResults: DemoSearchQueryResultDebug[] = [];
  const searchRounds: DemoSearchDebug["searchRounds"] = [];

  for (const [index, queryPlan] of searchRoundQueries.entries()) {
    const roundIndex = index + 1;
    try {
      const result = await searchService.search(queryPlan.query, perQueryCount, { dataMode });
      const rawResultCount = result.items.length;
      const queryItems = result.items
        .slice(0, perQueryCount)
        .map((item) => attachMatchedQuery(item, queryPlan, roundIndex));
      items.push(...queryItems);
      searchRounds.push({
        query: queryPlan.query,
        roundIndex,
        success: true,
        rawResultCount,
        isEmptyResult: rawResultCount === 0
      });
      searchQueryResults.push({
        ...queryPlan,
        roundIndex,
        returnedCount: queryItems.length,
        success: true,
        rawResultCount,
        isEmptyResult: rawResultCount === 0
      });
    } catch (error) {
      const errorCode = readSearchErrorCode(error);
      const errorMessage = readSearchErrorMessage(error);
      if (dataMode === "replay" && errorCode === "ZHIHU_REPLAY_FIXTURE_MISSING") {
        throw error;
      }
      searchRounds.push({
        query: queryPlan.query,
        roundIndex,
        success: false,
        rawResultCount: 0,
        errorCode,
        errorMessage,
        isEmptyResult: false
      });
      searchQueryResults.push({
        ...queryPlan,
        roundIndex,
        returnedCount: 0,
        success: false,
        rawResultCount: 0,
        errorCode,
        errorMessage,
        error: `${errorCode}: ${errorMessage}`,
        isEmptyResult: false
      });
    }
  }

  const validItems = items.filter(isUsableSearchItem);
  const dedupedItems = dedupeSearchItems(validItems);
  const totalRawResults = searchRounds.reduce((total, round) => total + round.rawResultCount, 0);
  const failedQueries = searchRounds
    .filter((round) => !round.success)
    .map((round) => round.query);
  const emptyQueries = searchRounds
    .filter((round) => round.success && round.rawResultCount === 0)
    .map((round) => round.query);
  const fallbackReason = buildSearchFallbackReason({
    searchRounds,
    totalRawResults,
    totalDedupedCandidates: dedupedItems.length
  });
  const searchDebug: DemoSearchDebug = {
    dataMode,
    queriesUsed: searchRoundQueries.map((plan) => plan.query),
    searchRounds,
    totalRawResults,
    totalDedupedCandidates: dedupedItems.length,
    failedQueries,
    emptyQueries,
    degraded: Boolean(fallbackReason),
    fallbackReason,
    candidates: dedupedItems.map(toSearchCandidate)
  };

  return {
    items: dedupedItems,
    searchQueries: plannedQueries,
    searchQueryResults,
    searchDebug,
    rawCandidateCount: totalRawResults,
    mergedCandidateCount: validItems.length,
    dedupedCandidateCount: dedupedItems.length
  };
}

function selectExecutableSearchQueries(plannedQueries: DemoSearchQueryPlan[]): DemoSearchQueryPlan[] {
  const result: DemoSearchQueryPlan[] = [];
  const originalPlan = plannedQueries.find((plan) => plan.type === "original");
  const nonOriginalPlans = plannedQueries.filter((plan) => plan.type !== "original");
  const shortPlans = nonOriginalPlans.filter((plan) => isShortSearchQuery(plan.query));

  for (const plan of shortPlans) {
    appendExecutableQuery(result, plan);
    if (result.length >= MAX_SEARCH_ROUNDS) {
      return result;
    }
  }

  for (const plan of nonOriginalPlans) {
    if (result.length >= MIN_SEARCH_ROUNDS) {
      break;
    }
    appendExecutableQuery(result, plan);
  }

  if (result.length < MIN_SEARCH_ROUNDS && originalPlan) {
    appendExecutableQuery(result, originalPlan);
  }

  for (const plan of plannedQueries) {
    if (result.length >= MAX_SEARCH_ROUNDS) {
      break;
    }
    appendExecutableQuery(result, plan);
  }

  return result.slice(0, MAX_SEARCH_ROUNDS);
}

function appendExecutableQuery(result: DemoSearchQueryPlan[], plan: DemoSearchQueryPlan): void {
  const normalized = normalizeText(plan.query);
  if (!normalized || normalized.length < 2) {
    return;
  }

  if (result.some((item) => normalizeText(item.query) === normalized)) {
    return;
  }

  result.push(plan);
}

function isShortSearchQuery(query: string): boolean {
  const normalized = normalizeText(query);
  return normalized.length >= 4 && normalized.length <= 28;
}

function isUsableSearchItem(item: SearchItem): boolean {
  return Boolean(
    normalizeText(item.title) &&
      normalizeText(readSearchItemUrl(item)) &&
      normalizeText(readSearchItemText(item)).length >= MIN_CONTENT_LENGTH
  );
}

function readSearchItemUrl(item: SearchItem): string {
  return item.url || item.source.url || "";
}

function readSearchItemText(item: SearchItem): string {
  return item.text || item.evidence.text || "";
}

function buildSearchFallbackReason(input: {
  searchRounds: DemoSearchDebug["searchRounds"];
  totalRawResults: number;
  totalDedupedCandidates: number;
}): string | undefined {
  if (input.searchRounds.length === 0) {
    return "no_search_queries_selected";
  }

  if (input.searchRounds.every((round) => !round.success)) {
    const errorSummary = input.searchRounds
      .slice(0, 2)
      .map((round) => `${round.query}: ${round.errorCode ?? "ERROR"}`)
      .join("; ");
    return `all_search_queries_failed${errorSummary ? `: ${errorSummary}` : ""}`;
  }

  if (input.totalRawResults === 0) {
    return "all_search_queries_returned_empty";
  }

  if (input.totalDedupedCandidates === 0) {
    return "no_usable_candidates_after_filtering";
  }

  return undefined;
}

function markSearchDebugDegraded(
  searchDebug: DemoSearchDebug,
  fallbackReason: string
): DemoSearchDebug {
  return {
    ...searchDebug,
    degraded: true,
    fallbackReason
  };
}

function toSearchCandidate(item: SearchItem): DemoSearchCandidate {
  const matchedQuery = findPrimaryMatchedQuery(item);
  const text = readSearchItemText(item);
  const url = readSearchItemUrl(item);

  return {
    sourceId: item.id || url || `candidate_${hashString(`${item.title}:${text}`)}`,
    title: item.title,
    url,
    authorName: item.author.name || undefined,
    snippet: text ? truncateText(text, 180) : undefined,
    excerpt: text ? truncateText(text, 180) : undefined,
    rawContent: text || undefined,
    text: text || undefined,
    sourceType: item.type || undefined,
    queryUsed: matchedQuery.query || item.matchedQuery || "",
    searchRound: matchedQuery.roundIndex ?? item.searchRound ?? 0
  };
}

function findPrimaryMatchedQuery(item: SearchItem): { query: string; roundIndex?: number } {
  const matched = item.matchedQueries?.[0];
  if (matched?.query) {
    return {
      query: matched.query,
      roundIndex: matched.roundIndex
    };
  }

  return {
    query: item.matchedQuery ?? "",
    roundIndex: item.searchRound
  };
}

function readSearchErrorCode(error: unknown): string {
  if (error instanceof HttpError) {
    return error.code;
  }

  if (error instanceof Error && "code" in error && typeof error.code === "string") {
    return error.code;
  }

  return error instanceof Error && error.name ? error.name : "UNKNOWN_ERROR";
}

function readSearchErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message) {
    return truncateText(error.message, 180);
  }

  return "Unknown search error";
}

async function runCandidatePipeline(
  query: string,
  intent: IntentExpandOutput,
  recalledSearch: SearchByExpandedQueriesResult,
  count: number,
  dataMode: DemoDataMode,
  userContext?: UserContext,
  budget?: PipelineBudget
): Promise<CandidatePipelineResult> {
  const startedAt = Date.now();
  const context = {
    originalQuery: query,
    userCoreQuestion: intent.userCoreQuestion,
    focusTags: intent.focusTags,
    topicSignals: intent.topicSignals,
    searchQueries: recalledSearch.searchQueries
  };
  let allItems = recalledSearch.items;
  let assessments = assessSearchCandidates(context, allItems);
  let rerankCandidates = selectRerankCandidateAssessments(assessments);
  let rerankOutput: CandidateRerankOutput | undefined;
  let stageResult: DemoDebugLlmStageResult;
  let rerankFailedReason = "";
  let rerankDropReasonById = new Map<string, string>();
  const rerankEnabled = llmRouter.isTaskConfigured("candidate_rerank");
  const rerankHasBudget = hasBudgetForLlmStage("candidate_rerank", budget);

  if (rerankCandidates.length === 0) {
    stageResult = createSkippedStage("candidate_rerank", "no rough-filtered candidates for rerank");
  } else if (!rerankEnabled) {
    stageResult = createSkippedStage("candidate_rerank", "DeepSeek not configured; rule rerank fallback used");
  } else if (!rerankHasBudget) {
    rerankFailedReason =
      "request budget has insufficient remaining time for candidate_rerank; rule rerank fallback used";
    stageResult = createBudgetSkippedStage("candidate_rerank");
  } else {
    let completionInput: Omit<JsonCompletionInput, "taskType"> | undefined;
    try {
      const promptCandidates = selectCompactRerankPromptCandidates(rerankCandidates)
        .map(toCandidateRerankPromptItem);
      completionInput = {
        temperature: 0.1,
        maxTokens: 420,
        messages: [
          {
            role: "system",
            content: CANDIDATE_RERANK_SYSTEM_PROMPT
          },
          {
            role: "user",
            content: JSON.stringify({
              originalQuery: truncateText(query, 120),
              userCoreQuestion: intent.userCoreQuestion,
              focusTags: intent.focusTags.slice(0, 5),
              topicSignals: intent.topicSignals.slice(0, 8),
              searchQueries: recalledSearch.searchQueries.slice(0, 4).map((item) => ({
                query: item.query,
                type: item.type,
                purpose: item.purpose
              })),
              promptBudget: {
                maxCandidates: promptCandidates.length,
                selectedTarget: "1-2",
                maxSelected: 2
              },
              candidates: promptCandidates
            })
          }
        ]
      };
      const completion = await runPreferredJsonTaskWithStageTimeout(
        "candidate_rerank",
        completionInput
      );
      rerankOutput = parseCandidateRerankOutput(
        completion.content,
        new Set(rerankCandidates.map((candidate) => candidate.candidateId))
      );
      stageResult = createSuccessStage(
        "candidate_rerank",
        completion.provider,
        completion.model
      );
    } catch (error) {
      const fallbackContent = completionInput
        ? await runKimiFallbackJsonTask("candidate_rerank", completionInput, error)
        : undefined;
      if (fallbackContent) {
        rerankOutput = parseCandidateRerankOutput(
          fallbackContent,
          new Set(rerankCandidates.map((candidate) => candidate.candidateId))
        );
        stageResult = createSuccessStage("candidate_rerank", kimiClient.provider, kimiClient.model);
      } else {
        rerankFailedReason = formatErrorSummary(error);
        stageResult = createFallbackStage("candidate_rerank", error);
      }
    }
  }

  let selectedAssessments = rerankOutput
    ? applyCandidateRerankOutput(assessments, rerankOutput)
    : selectRuleFallbackAssessments(assessments, TARGET_EFFECTIVE_CANDIDATES);
  if (rerankOutput) {
    rerankDropReasonById = markRerankDroppedCandidates(rerankCandidates, rerankOutput);
  }
  let refillTriggered = false;
  let refillReason = "";
  let refillQueries: DemoSearchQueryPlan[] = [];
  let refillCandidateCount = 0;

  if (!rerankOutput && selectedAssessments.length < MIN_EFFECTIVE_CANDIDATES && MAX_REFILL_ROUNDS > 0) {
    refillTriggered = true;
    refillReason = `selectedCandidates=${selectedAssessments.length} below MIN_EFFECTIVE_CANDIDATES=${MIN_EFFECTIVE_CANDIDATES}`;
    refillQueries = buildRefillQueries(intent, selectedAssessments, recalledSearch.searchQueries);

    if (refillQueries.length > 0) {
      const refillSearch = await searchByQueryPlans(refillQueries, 5, dataMode);
      refillCandidateCount = refillSearch.items.length;
      allItems = dedupeSearchItems([...allItems, ...refillSearch.items]);
      assessments = assessSearchCandidates(
        {
          ...context,
          searchQueries: [...recalledSearch.searchQueries, ...refillQueries]
        },
        allItems
      );
      restoreDropReasons(assessments, rerankDropReasonById);
      const selectedIds = new Set(selectedAssessments.map((assessment) => assessment.candidateId));
      const supplemental = selectRuleFallbackAssessments(
        assessments.filter((assessment) => !selectedIds.has(assessment.candidateId)),
        TARGET_EFFECTIVE_CANDIDATES - selectedAssessments.length
      );
      selectedAssessments = [
        ...selectedAssessments,
        ...supplemental
      ].slice(0, TARGET_EFFECTIVE_CANDIDATES);
      rerankCandidates = selectRerankCandidateAssessments(assessments);
    }
  }

  if (!rerankOutput && selectedAssessments.length < MIN_EFFECTIVE_CANDIDATES) {
    const selectedIds = new Set(selectedAssessments.map((assessment) => assessment.candidateId));
    const backup = selectRuleFallbackAssessments(
      assessments.filter((assessment) => !selectedIds.has(assessment.candidateId)),
      TARGET_EFFECTIVE_CANDIDATES - selectedAssessments.length
    );
    selectedAssessments = [...selectedAssessments, ...backup].slice(0, TARGET_EFFECTIVE_CANDIDATES);
  }

  if (selectedAssessments.length === 0) {
    selectedAssessments = selectTraceableNarrativeRecoveryAssessments(
      assessments,
      query,
      intent,
      Math.max(1, Math.min(count, TARGET_EFFECTIVE_CANDIDATES))
    );
  }

  selectedAssessments = enforceSelectedDiversity(selectedAssessments, assessments).slice(
    0,
    TARGET_EFFECTIVE_CANDIDATES
  );
  for (const assessment of selectedAssessments) {
    applyRuleKeepMetadata(assessment, intent);
  }

  const selectedIds = new Set(selectedAssessments.map((assessment) => assessment.candidateId));
  const droppedAssessments = assessments
    .filter((assessment) => !selectedIds.has(assessment.candidateId))
    .sort((left, right) => left.roughScore - right.roughScore);
  const droppedForDebug = sortDroppedCandidateExamples(droppedAssessments);
  const candidateQuality = assessments.map((assessment) =>
    toCandidateQualityDebug(assessment, selectedIds.has(assessment.candidateId))
  );
  const assessmentById = new Map(assessments.map((assessment) => [assessment.candidateId, assessment]));
  const selectedItems = selectedAssessments
    .map((assessment) =>
      attachAssessmentMetadata(assessment.item, assessmentById.get(assessment.candidateId) ?? assessment)
    )
    .slice(0, TARGET_EFFECTIVE_CANDIDATES);

  return {
    items: selectedItems,
    candidateQuality,
    stageResult,
    durationMs: Date.now() - startedAt,
    rerankEnabled,
    rerankUsed: stageResult.succeeded > 0,
    rerankFailedReason,
    rerankCandidatesCount: rerankCandidates.length,
    selectedCandidatesCount: selectedAssessments.length,
    droppedCandidatesCount: droppedAssessments.length,
    refillTriggered,
    refillReason,
    refillQueries,
    refillCandidateCount,
    finalCandidateCount: selectedItems.length,
    roughTierDistribution: buildRoughTierDistribution(assessments),
    finalCandidates: selectedAssessments.map(toFinalCandidateDebug),
    droppedCandidates: droppedForDebug.slice(0, 3).map(toDroppedCandidateDebug)
  };
}

async function searchByQueryPlans(
  queries: DemoSearchQueryPlan[],
  perQueryCount: number,
  dataMode: DemoDataMode
): Promise<{ items: SearchItem[]; results: DemoSearchQueryResultDebug[] }> {
  const items: SearchItem[] = [];
  const results: DemoSearchQueryResultDebug[] = [];

  for (const queryPlan of queries) {
    try {
      const result = await searchService.search(queryPlan.query, perQueryCount, { dataMode });
      const queryItems = result.items
        .slice(0, perQueryCount)
        .map((item) => attachMatchedQuery(item, queryPlan));
      items.push(...queryItems);
      results.push({
        ...queryPlan,
        returnedCount: queryItems.length
      });
    } catch (error) {
      if (
        dataMode === "replay" &&
        readSearchErrorCode(error) === "ZHIHU_REPLAY_FIXTURE_MISSING"
      ) {
        throw error;
      }
      results.push({
        ...queryPlan,
        returnedCount: 0,
        error: formatErrorSummary(error)
      });
    }
  }

  return {
    items,
    results
  };
}

function dedupeSearchItems(items: SearchItem[]): SearchItem[] {
  const groups = new Map<string, SearchItem>();

  for (const item of items) {
    const key = buildDedupeKey(item);
    if (!key) {
      continue;
    }

    const existing = groups.get(key);
    if (!existing) {
      groups.set(key, normalizeMatchedQueryList(item));
      continue;
    }

    groups.set(key, mergeDuplicateSearchItem(existing, item));
  }

  return Array.from(groups.values()).sort(compareDedupeItems);
}

function attachMatchedQuery(
  item: SearchItem,
  queryPlan: DemoSearchQueryPlan,
  roundIndex?: number
): SearchItem {
  const matchedQueries = [
    ...(item.matchedQueries ?? []),
    {
      query: queryPlan.query,
      type: queryPlan.type,
      purpose: queryPlan.purpose,
      roundIndex
    }
  ];

  return {
    ...item,
    matchedQuery: queryPlan.query,
    queryType: queryPlan.type,
    queryPurpose: queryPlan.purpose,
    searchRound: roundIndex,
    matchedQueries: uniqueMatchedQueries(matchedQueries)
  };
}

function selectCompactRerankPromptCandidates(
  candidates: CandidateAssessment[]
): CandidateAssessment[] {
  return [...candidates]
    .sort((left, right) => scoreRerankPromptCandidate(right) - scoreRerankPromptCandidate(left))
    .slice(0, MAX_RERANK_PROMPT_CANDIDATES);
}

function scoreRerankPromptCandidate(candidate: CandidateAssessment): number {
  const text = normalizeText([
    candidate.title,
    candidate.summary,
    candidate.item.text,
    candidate.item.evidence.text,
    candidate.matchedQuery,
    candidate.queryPurpose,
    ...(candidate.relevanceSignals ?? [])
  ].join("\n"));
  const hasBigTech = /互联网|大厂|字节|腾讯|阿里|百度|美团|京东/.test(text);
  const hasStartup = /创业|合伙|小生意|客户|现金流|投资|项目|商业|试错|验证/.test(text);
  const hasAgeOrExit = /35|三十五|裸辞|离职|辞职|被裁/.test(text);
  const penalties = candidate.penaltySignals.length * 18 +
    (/广告营销|疑似机构|课程|训练营|加微信|私信|咨询|报名|证书|招聘|法律|财会/.test(text) ? 35 : 0);

  return (
    candidate.roughScore +
    (hasBigTech ? 28 : 0) +
    (hasStartup ? 28 : 0) +
    (hasAgeOrExit ? 18 : 0) +
    candidate.topicHitScore * 2 +
    candidate.experienceSignalScore * 30 -
    penalties
  );
}

function toCandidateRerankPromptItem(candidate: CandidateAssessment): Record<string, unknown> {
  return {
    candidateId: candidate.candidateId,
    title: truncateText(candidate.title, 72),
    author: truncateText(candidate.author, 40),
    summary: truncateText(candidate.summary, 96),
    contentSnippet: truncateText(candidate.item.text || candidate.item.evidence.text || candidate.title, 180),
    matchedQuery: candidate.matchedQuery,
    queryType: candidate.queryType,
    queryPurpose: candidate.queryPurpose,
    roughScore: candidate.roughScore,
    roughTier: candidate.roughTier,
    roughReason: truncateText(candidate.roughReason, 100),
    signals: {
      relevance: candidate.relevanceSignals.slice(0, 3),
      narrative: candidate.narrativeSignals.slice(0, 3),
      penalties: candidate.penaltySignals.slice(0, 3)
    }
  };
}

function toEvidenceExtractPromptCandidates(
  candidates: CleanedCandidate[]
): Array<Record<string, unknown>> {
  const selected = candidates.slice(0, MAX_EVIDENCE_EXTRACT_PROMPT_CANDIDATES);
  const perCandidateEvidenceChars = Math.min(
    700,
    Math.max(480, Math.floor(EVIDENCE_EXTRACT_CONTEXT_CHAR_BUDGET / Math.max(selected.length, 1)))
  );

  return selected.map((candidate) => ({
    candidateId: candidate.candidateId,
    personId: candidate.personId,
    articleId: candidate.articleId,
    sourceRefId: candidate.sourceRefId,
    title: truncateText(candidate.title, 90),
    author: truncateText(candidate.author, 40),
    sourceUrl: candidate.sourceUrl,
    sampleType: candidate.sampleType,
    matchedQuery: candidate.matchedQuery,
    queryType: candidate.queryType,
    queryPurpose: candidate.queryPurpose,
    contentRole: candidate.contentRole,
    relationToUserIntent: truncateText(candidate.relationToUserIntent ?? "", 120),
    summaryAngle: truncateText(candidate.summaryAngle ?? "", 90),
    diversityKey: truncateText(candidate.diversityKey ?? "", 40),
    keepReason: truncateText(candidate.keepReason ?? candidate.filterReason, 120),
    relevanceScore: candidate.relevanceScore,
    qualityScore: candidate.qualityScore,
    experienceSignalScore: candidate.experienceSignalScore,
    contentLength: candidate.contentLength,
    filterReason: truncateText(candidate.filterReason, 120),
    text: truncateText(candidate.text, 120),
    evidenceText: truncateText(
      candidate.text || candidate.evidenceText || candidate.title,
      perCandidateEvidenceChars
    )
  }));
}

function toDemoResponseComposeFinalCandidate(candidate: CleanedCandidate): Record<string, unknown> {
  return {
    candidateId: candidate.candidateId,
    personId: candidate.personId,
    articleId: candidate.articleId,
    title: truncateText(candidate.title, 80),
    author: truncateText(candidate.author, 32),
    summary: truncateText(candidate.text, 140),
    contentSnippet: truncateText(candidate.text, 220),
    contentRole: candidate.contentRole,
    relationToUserIntent: truncateText(candidate.relationToUserIntent ?? "", 100),
    summaryAngle: truncateText(candidate.summaryAngle ?? "", 70),
    diversityKey: truncateText(candidate.diversityKey ?? "", 32),
    matchedQuery: candidate.matchedQuery,
    queryType: candidate.queryType,
    keepReason: truncateText(candidate.keepReason ?? "", 100),
    sourceRefs: [candidate.sourceRefId],
    evidenceText: truncateText(candidate.evidenceText, 150)
  };
}

function applyCandidateRerankOutput(
  assessments: CandidateAssessment[],
  output: CandidateRerankOutput
): CandidateAssessment[] {
  const assessmentById = new Map(assessments.map((assessment) => [assessment.candidateId, assessment]));
  const selected: CandidateAssessment[] = [];
  const seen = new Set<string>();

  for (const item of output.selected) {
    const assessment = assessmentById.get(item.candidateId);
    if (!assessment || seen.has(item.candidateId)) {
      continue;
    }

    assessment.relevanceScore = Math.max(
      assessment.relevanceScore,
      Number((item.relevanceScore / 100).toFixed(2)),
      0.36
    );
    assessment.contentRole = item.contentRole;
    assessment.relationToUserIntent = item.relationToUserIntent;
    assessment.summaryAngle = item.summaryAngle;
    assessment.diversityKey = item.diversityKey;
    assessment.keepReason = item.keepReason;
    selected.push(assessment);
    seen.add(item.candidateId);
  }

  for (const item of output.dropped) {
    const assessment = assessmentById.get(item.candidateId);
    if (assessment) {
      assessment.dropReason = item.dropReason;
    }
  }

  return selected.slice(0, TARGET_EFFECTIVE_CANDIDATES);
}

function markRerankDroppedCandidates(
  rerankCandidates: CandidateAssessment[],
  output: CandidateRerankOutput
): Map<string, string> {
  const selectedIds = new Set(output.selected.map((item) => item.candidateId));
  const explicitDropReasonById = new Map(
    output.dropped.map((item) => [item.candidateId, item.dropReason])
  );
  const dropReasonById = new Map<string, string>();

  for (const candidate of rerankCandidates) {
    if (selectedIds.has(candidate.candidateId)) {
      continue;
    }

    candidate.dropReason =
      explicitDropReasonById.has(candidate.candidateId)
        ? `LLM dropped: ${explicitDropReasonById.get(candidate.candidateId)}`
        : "LLM batch rerank did not keep this candidate for the final diverse set";
    dropReasonById.set(candidate.candidateId, candidate.dropReason);
  }

  return dropReasonById;
}

function restoreDropReasons(
  assessments: CandidateAssessment[],
  dropReasonById: Map<string, string>
): void {
  for (const assessment of assessments) {
    const dropReason = dropReasonById.get(assessment.candidateId);
    if (dropReason) {
      assessment.dropReason = dropReason;
    }
  }
}

function sortDroppedCandidateExamples(candidates: CandidateAssessment[]): CandidateAssessment[] {
  return [...candidates].sort((left, right) => {
    const leftLlm = left.dropReason?.startsWith("LLM") ? 1 : 0;
    const rightLlm = right.dropReason?.startsWith("LLM") ? 1 : 0;
    return rightLlm - leftLlm || left.roughScore - right.roughScore;
  });
}

function buildRefillQueries(
  intent: IntentExpandOutput,
  selectedAssessments: CandidateAssessment[],
  searchQueries: DemoSearchQueryPlan[]
): DemoSearchQueryPlan[] {
  const selectedTypeCounts = selectedAssessments.reduce((counts, assessment) => {
    if (assessment.queryType) {
      counts.set(assessment.queryType, (counts.get(assessment.queryType) ?? 0) + 1);
    }
    return counts;
  }, new Map<DemoSearchQueryType, number>());
  const existingQueries = new Set(searchQueries.map((plan) => normalizeText(plan.query)));
  const lowCoverageExisting = searchQueries
    .filter((plan) => plan.type !== "original" && (selectedTypeCounts.get(plan.type) ?? 0) === 0)
    .slice(0, 3);
  const dynamicPlans = intent.topicSignals
    .slice(0, 4)
    .flatMap((signal, index) => [
      createRefillPlan(`${signal} 真实经历`, "real_experience", "基于 topicSignals 补召回真实经历", index + 2),
      createRefillPlan(`${signal} 失败复盘`, "failure_review", "基于 topicSignals 补召回失败与代价", index + 4),
      createRefillPlan(`${signal} 怎么选`, "decision_conflict", "基于 topicSignals 补召回决策冲突", index + 5)
    ])
    .filter((plan) => {
      const key = normalizeText(plan.query);
      if (existingQueries.has(key)) {
        return false;
      }

      existingQueries.add(key);
      return true;
    });

  return [...lowCoverageExisting, ...dynamicPlans].slice(0, 5);
}

function createRefillPlan(
  query: string,
  type: DemoSearchQueryType,
  purpose: string,
  priority: number
): DemoSearchQueryPlan {
  return {
    query: truncateText(query, 40),
    type,
    purpose,
    priority: Math.min(Math.max(priority, 1), 6)
  };
}

function enforceSelectedDiversity(
  selectedAssessments: CandidateAssessment[],
  assessments: CandidateAssessment[]
): CandidateAssessment[] {
  const selectedTypes = new Set(selectedAssessments.map((assessment) => assessment.queryType).filter(Boolean));
  if (selectedTypes.size !== 1 || selectedAssessments.length < 2) {
    return selectedAssessments;
  }

  const selectedIds = new Set(selectedAssessments.map((assessment) => assessment.candidateId));
  const alternative = assessments
    .filter((assessment) => !selectedIds.has(assessment.candidateId) && assessment.queryType && !selectedTypes.has(assessment.queryType))
    .sort((left, right) => right.roughScore - left.roughScore)[0];
  if (!alternative) {
    return selectedAssessments;
  }

  return [...selectedAssessments.slice(0, -1), alternative];
}

function selectTraceableNarrativeRecoveryAssessments(
  assessments: CandidateAssessment[],
  query: string,
  intent: IntentExpandOutput,
  targetCount: number
): CandidateAssessment[] {
  const terms = buildRecoveryTerms([
    query,
    intent.userCoreQuestion,
    ...(intent.focusTags ?? []),
    ...(intent.topicSignals ?? []),
    ...(intent.searchQueries ?? []).flatMap((plan) => [plan.query, plan.purpose])
  ]);

  const strict = assessments
    .filter((assessment) => isTraceableNarrativeRecoveryCandidate(assessment, terms))
    .sort(
      (left, right) =>
        right.topicHitScore - left.topicHitScore ||
        right.narrativeScore - left.narrativeScore ||
        right.specificityScore - left.specificityScore ||
        right.roughScore - left.roughScore
    )
    .slice(0, targetCount);

  if (strict.length > 0) {
    return strict;
  }

  return assessments
    .filter(isRelaxedTraceableNarrativeRecoveryCandidate)
    .sort(
      (left, right) =>
        right.narrativeScore - left.narrativeScore ||
        right.specificityScore - left.specificityScore ||
        right.topicHitScore - left.topicHitScore ||
        right.roughScore - left.roughScore
    )
    .slice(0, targetCount);
}

function isTraceableNarrativeRecoveryCandidate(
  assessment: CandidateAssessment,
  terms: string[]
): boolean {
  if (assessment.hardFiltered) {
    return false;
  }

  const text = normalizeText([
    assessment.title,
    assessment.summary,
    assessment.author,
    assessment.item.text,
    assessment.item.evidence.text
  ].join("\n"));
  const hasSource = Boolean(assessment.item.url || assessment.item.source.url || assessment.item.id);
  const hasNarrative = /我|本人|当时|后来|决定|选择|结果|后悔|相似经历|公开经历|样本复盘/.test(text);
  const hasTopicTerm = terms.some((term) => text.includes(term));
  const blockedBySignal = assessment.penaltySignals.some((signal) =>
    [
      "relationship_work_missing_relationship_or_career_signal",
      "relationship_work_generic_work_penalty",
      "relationship_missing_relationship_signal",
      "relationship_work_pause_template_drift",
      "product_manager_missing_pm_signal",
      "product_manager_generic_transition_drift",
      "product_manager_guide_or_training_title",
      "city_home_holiday_travel_drift",
      "stability_passion_romance_drift_penalty",
      "指南/教程型标题",
      "广告营销",
      "疑似机构/营销作者"
    ].includes(signal)
  );
  const blockedByText = /指南|教程|攻略|训练营|加微信|报名|推广|返利|带货|工具准备|最快入门|零基础/.test(text);

  return hasSource && hasNarrative && hasTopicTerm && !blockedBySignal && !blockedByText;
}

function isRelaxedTraceableNarrativeRecoveryCandidate(assessment: CandidateAssessment): boolean {
  const text = normalizeText([
    assessment.title,
    assessment.summary,
    assessment.author,
    assessment.item.text,
    assessment.item.evidence.text
  ].join("\n"));
  const hasSource = Boolean(assessment.item.url || assessment.item.source.url || assessment.item.id);
  const hasNarrative = /我|本人|当时|后来|决定|选择|结果|后悔|相似经历|公开经历|样本复盘/.test(text);
  const blockedBySignal = assessment.penaltySignals.some((signal) =>
    [
      "relationship_work_missing_relationship_or_career_signal",
      "relationship_work_generic_work_penalty",
      "relationship_missing_relationship_signal",
      "relationship_work_pause_template_drift",
      "product_manager_missing_pm_signal",
      "product_manager_generic_transition_drift",
      "product_manager_guide_or_training_title",
      "city_home_holiday_travel_drift",
      "stability_passion_romance_drift_penalty",
      "指南/教程型标题",
      "广告营销",
      "疑似机构/营销作者"
    ].includes(signal)
  );
  const blockedByText = /指南|教程|攻略|训练营|加微信|报名|推广|返利|带货|工具准备|最快入门|零基础/.test(text);

  return hasSource && hasNarrative && !blockedBySignal && !blockedByText;
}

function buildRecoveryTerms(values: Array<string | undefined>): string[] {
  const stopTerms = new Set([
    "用户",
    "问题",
    "相关",
    "公开经验",
    "公开内容",
    "可行路径",
    "选择路径",
    "风险边界",
    "现实可行性",
    "代价边界",
    "下一步",
    "真实经历",
    "后来怎么样",
    "有哪些路径",
    "怎么开始",
    "后悔吗",
    "值得吗",
    "现实吗"
  ]);
  const terms = values
    .filter((value): value is string => Boolean(value))
    .flatMap((value) => normalizeText(value).split(/[，。！？、,.!?\s/|:：；;（）()《》"“”]+/))
    .map((value) => normalizeText(value))
    .filter((value) => value.length >= 2 && value.length <= 18 && !stopTerms.has(value));

  return unique(terms).slice(0, 18);
}

function applyRuleKeepMetadata(candidate: CandidateAssessment, intent: IntentExpandOutput): void {
  const topic = candidate.relevanceSignals?.[0] ?? intent.topicSignals[0] ?? candidate.matchedQuery ?? "当前问题";
  candidate.relationToUserIntent =
    candidate.relationToUserIntent ??
    `这条公开内容与用户问题共同涉及「${topic}」，可作为同类处境或决策变量的参照。`;
  candidate.summaryAngle =
    candidate.summaryAngle ??
    (candidate.narrativeSignals?.length
      ? `提炼这条内容中的${candidate.narrativeSignals.slice(0, 2).join("、")}线索`
      : `提炼围绕「${topic}」的具体信息和可验证边界`);
  candidate.diversityKey =
    candidate.diversityKey ?? candidate.queryType ?? candidate.relevanceSignals?.[0] ?? "public-content";
  candidate.keepReason =
    candidate.keepReason ??
    `规则兜底保留：${candidate.roughReason || candidate.filterReason}`;
}

function toFinalCandidateDebug(candidate: CandidateAssessment): NonNullable<DemoSearchResponse["debug"]["finalCandidates"]>[number] {
  return {
    candidateId: candidate.candidateId,
    title: truncateText(candidate.title, 80),
    author: truncateText(candidate.author, 40),
    matchedQuery: candidate.matchedQuery,
    queryType: candidate.queryType,
    roughScore: candidate.roughScore,
    relevanceScore: Math.round(candidate.relevanceScore * 100),
    contentRole: candidate.contentRole,
    relationToUserIntent: candidate.relationToUserIntent,
    summaryAngle: candidate.summaryAngle,
    diversityKey: candidate.diversityKey,
    keepReason: candidate.keepReason,
    sourceRefs: candidate.sourceRefId ? [candidate.sourceRefId] : []
  };
}

function attachFinalCandidateSourceRefs(
  finalCandidates: NonNullable<DemoSearchResponse["debug"]["finalCandidates"]>,
  candidateQuality: DemoCandidateQuality[] | undefined
): NonNullable<DemoSearchResponse["debug"]["finalCandidates"]> {
  const sourceRefByCandidateId = new Map(
    (candidateQuality ?? [])
      .filter((candidate): candidate is DemoCandidateQuality & { sourceRefId: string } =>
        Boolean(candidate.sourceRefId)
      )
      .map((candidate) => [candidate.candidateId, candidate.sourceRefId])
  );

  return finalCandidates.map((candidate) => ({
    ...candidate,
    sourceRefs:
      candidate.sourceRefs && candidate.sourceRefs.length > 0
        ? candidate.sourceRefs
        : sourceRefByCandidateId.has(candidate.candidateId)
          ? [sourceRefByCandidateId.get(candidate.candidateId)!]
          : []
  }));
}

function toDroppedCandidateDebug(candidate: CandidateAssessment): NonNullable<DemoSearchResponse["debug"]["droppedCandidates"]>[number] {
  return {
    candidateId: candidate.candidateId,
    title: truncateText(candidate.title, 80),
    roughScore: candidate.roughScore,
    dropReason: candidate.dropReason ?? candidate.filterReason
  };
}

function buildDedupeKey(item: SearchItem): string {
  const stableId = item.id && !item.id.startsWith("zhihu_item_") ? item.id : "";
  if (stableId) {
    return `id:${stableId}`;
  }

  if (item.url) {
    return `url:${item.url}`;
  }

  const normalizedTitle = normalizeTitle(item.title);
  if (normalizedTitle) {
    return `title:${normalizedTitle}`;
  }

  const author = normalizeText(item.author.name);
  return normalizedTitle || author ? `title_author:${normalizedTitle}:${author}` : "";
}

function normalizeMatchedQueryList(item: SearchItem): SearchItem {
  return {
    ...item,
    matchedQueries: uniqueMatchedQueries(item.matchedQueries ?? [])
  };
}

function mergeDuplicateSearchItem(existing: SearchItem, incoming: SearchItem): SearchItem {
  const preferred = compareDedupeItems(existing, incoming) <= 0 ? existing : incoming;
  const secondary = preferred === existing ? incoming : existing;
  const matchedQueries = uniqueMatchedQueries([
    ...(existing.matchedQueries ?? []),
    ...(incoming.matchedQueries ?? [])
  ]);

  return {
    ...preferred,
    text: preferred.text || secondary.text,
    evidence: preferred.evidence.text ? preferred.evidence : secondary.evidence,
    author: preferred.author.name ? preferred.author : secondary.author,
    matchedQuery: matchedQueries[0]?.query ?? preferred.matchedQuery,
    queryType: matchedQueries[0]?.type ?? preferred.queryType,
    queryPurpose: matchedQueries[0]?.purpose ?? preferred.queryPurpose,
    matchedQueries
  };
}

function compareDedupeItems(left: SearchItem, right: SearchItem): number {
  const leftScore = dedupePreferenceScore(left);
  const rightScore = dedupePreferenceScore(right);
  return rightScore - leftScore;
}

function dedupePreferenceScore(item: SearchItem): number {
  return (
    (item.matchedQueries?.length ?? (item.matchedQuery ? 1 : 0)) * 30 +
    normalizeText(item.text || item.evidence.text).length +
    (item.url ? 20 : 0) +
    (item.author.name ? 10 : 0) +
    Math.min(item.stats.voteUpCount, 100)
  );
}

function uniqueMatchedQueries(
  values: Array<{ query?: string; type?: string; purpose?: string; roundIndex?: number }>
): NonNullable<SearchItem["matchedQueries"]> {
  const seen = new Set<string>();
  const result: NonNullable<SearchItem["matchedQueries"]> = [];

  for (const value of values) {
    const query = normalizeText(value.query ?? "");
    if (!query) {
      continue;
    }

    const key = query.toLowerCase();
    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    result.push({
      query,
      type: value.type,
      purpose: value.purpose,
      roundIndex: value.roundIndex
    });
  }

  return result;
}

function normalizeTitle(title: string): string {
  return normalizeText(title)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\u4e00-\u9fa5]+/gu, "");
}

function buildCleanedCandidatesFromResponse(response: DemoSearchResponse): CleanedCandidate[] {
  const candidates: CleanedCandidate[] = [];
  const seen = new Set<string>();
  const qualityBySourceRefId = new Map(
    (response.debug.candidateQuality ?? [])
      .filter((item): item is DemoCandidateQuality & { sourceRefId: string } =>
        Boolean(item.sourceRefId)
      )
      .map((item) => [item.sourceRefId, item])
  );

  for (const person of response.people) {
    for (const article of person.articles) {
      const sourceRefId = article.sourceRefs[0] || person.sourceRefs[0];
      if (!sourceRefId || seen.has(sourceRefId)) {
        continue;
      }

      const sourceRef = response.meta.sourceRefs.find((item) => item.id === sourceRefId);
      const quality = qualityBySourceRefId.get(sourceRefId);
      const text = truncateText(article.text || article.summary || article.title, 850);
      const evidenceText = truncateText(
        article.evidence.map((item) => item.text).join("\n") || text,
        260
      );

      if (normalizeText(text).length < MIN_CONTENT_LENGTH) {
        continue;
      }

      seen.add(sourceRefId);
      candidates.push({
        candidateId: person.id,
        personId: person.id,
        articleId: article.id,
        sourceRefId,
        title: truncateText(article.title || sourceRef?.title || "未命名知乎内容", 80),
        text,
        evidenceText,
        author: truncateText(article.author || sourceRef?.author || "知乎用户", 40),
        sourceUrl: article.sourceUrl || article.url || sourceRef?.url || "",
        sampleType: person.sampleType ?? "content_sample",
        relevanceScore: quality?.relevanceScore ?? person.match.contentRelevance,
        qualityScore: quality?.qualityScore ?? person.match.evidenceQuality,
        experienceSignalScore: quality?.experienceSignalScore ?? person.match.experienceSimilarity,
        contentLength: quality?.contentLength ?? normalizeText(text).length,
        filterReason: quality?.filterReason ?? "used_as_core_evidence: selected by response composer",
        matchedQuery: quality?.matchedQuery,
        queryType: quality?.queryType,
        queryPurpose: quality?.queryPurpose,
        contentRole: quality?.contentRole,
        relationToUserIntent: quality?.relationToUserIntent,
        summaryAngle: quality?.summaryAngle,
        diversityKey: quality?.diversityKey,
        keepReason: quality?.keepReason
      });
    }
  }

  return candidates.slice(0, MAX_REAL_ITEMS);
}

function buildExperienceSummaryCandidates(
  query: string,
  response: DemoSearchResponse
): ExperienceSummaryCandidate[] {
  const qualityBySourceRefId = new Map(
    (response.debug.candidateQuality ?? [])
      .filter((item): item is DemoCandidateQuality & { sourceRefId: string } =>
        Boolean(item.sourceRefId)
      )
      .map((item) => [item.sourceRefId, item])
  );
  const result: ExperienceSummaryCandidate[] = [];

  for (const person of response.people.slice(0, MAX_EXPERIENCE_SUMMARY_PEOPLE)) {
    if (person.sampleType !== "experience_sample") {
      continue;
    }

    const article = person.articles[0];
    const sourceRefId = article?.sourceRefs[0] || person.sourceRefs[0] || "";
    const quality = qualityBySourceRefId.get(sourceRefId);
    const content = normalizeText(article?.text || article?.summary || article?.title || "");
    const contentLength = quality?.contentLength ?? content.length;
    const qualityScore = quality?.qualityScore ?? person.match.evidenceQuality;
    const experienceSignalScore = quality?.experienceSignalScore ?? person.match.experienceSimilarity;
    const fallbackSummary = buildExperienceFallbackSummary(person);

    if (
      !article ||
      !sourceRefId ||
      contentLength < EXPERIENCE_SUMMARY_MIN_CONTENT_LENGTH ||
      (qualityScore < EXPERIENCE_SUMMARY_MIN_QUALITY_SCORE &&
        experienceSignalScore < EXPERIENCE_SUMMARY_MIN_EXPERIENCE_SIGNAL_SCORE)
    ) {
      result.push({
        personId: person.id,
        candidateId: quality?.candidateId ?? article?.id ?? person.id,
        articleId: article?.id ?? "",
        sourceRefId,
        title: article?.title ?? "",
        content,
        summary: article?.summary ?? "",
        evidence:
          article?.evidence.map((evidence) => ({
            id: evidence.id,
            label: evidence.label,
            text: evidence.text
          })) ?? [],
        candidateQuality: {
          relevanceScore: quality?.relevanceScore ?? person.match.contentRelevance,
          qualityScore,
          experienceSignalScore,
          contentLength,
          filterReason:
            quality?.filterReason ?? "experienceSummary fallback quality derived from person.match"
        },
        contentHash: hashString(`${article?.title ?? ""}\n${content}\n${fallbackSummary}`),
        fallbackSummary,
        matchedQuery: quality?.matchedQuery,
        queryType: quality?.queryType,
        queryPurpose: quality?.queryPurpose
      });
      continue;
    }

    result.push({
      personId: person.id,
      candidateId: quality?.candidateId ?? article.id,
      articleId: article.id,
      sourceRefId,
      title: article.title,
      content,
      summary: article.summary,
      evidence: article.evidence.map((evidence) => ({
        id: evidence.id,
        label: evidence.label,
        text: evidence.text
      })),
      candidateQuality: {
        relevanceScore: quality?.relevanceScore ?? person.match.contentRelevance,
        qualityScore,
        experienceSignalScore,
        contentLength,
        filterReason: quality?.filterReason ?? "experienceSummary candidate selected from person.match"
      },
      contentHash: hashString(
        JSON.stringify({
          query: truncateText(query, 120),
          title: article.title,
          content,
          summary: article.summary,
          evidence: article.evidence.map((evidence) => evidence.text),
          qualityScore,
          experienceSignalScore
        })
      ),
      fallbackSummary,
      matchedQuery: quality?.matchedQuery,
      queryType: quality?.queryType,
      queryPurpose: quality?.queryPurpose
    });
  }

  return result.filter(isHighQualityExperienceSummaryCandidate);
}

function isHighQualityExperienceSummaryCandidate(candidate: ExperienceSummaryCandidate): boolean {
  return Boolean(
    candidate.articleId &&
      candidate.sourceRefId &&
      candidate.content.length >= EXPERIENCE_SUMMARY_MIN_CONTENT_LENGTH &&
      (candidate.candidateQuality.qualityScore >= EXPERIENCE_SUMMARY_MIN_QUALITY_SCORE ||
        candidate.candidateQuality.experienceSignalScore >=
          EXPERIENCE_SUMMARY_MIN_EXPERIENCE_SIGNAL_SCORE)
  );
}

function initializeExperienceSummaryDebug(
  response: DemoSearchResponse,
  candidates: ExperienceSummaryCandidate[]
): DemoExperienceSummaryDebug[] {
  const candidateIds = new Set(candidates.map((candidate) => candidate.personId));
  return response.people.slice(0, MAX_EXPERIENCE_SUMMARY_PEOPLE).map((person) => ({
    personId: person.id,
    status: candidateIds.has(person.id) ? "pending" : "failed",
    source: "none",
    reason: candidateIds.has(person.id)
      ? "waiting for LLM experienceSummary batch"
      : "content or candidate quality was insufficient for LLM experienceSummary",
    cacheHit: false,
    fallbackSummary: buildExperienceFallbackSummary(person)
  }));
}

function markExperienceSummaryDebug(
  debug: DemoExperienceSummaryDebug[],
  personId: string,
  updates: Omit<Partial<DemoExperienceSummaryDebug>, "personId" | "fallbackSummary">
): void {
  const entry = debug.find((item) => item.personId === personId);
  if (!entry) {
    return;
  }

  Object.assign(entry, updates);
}

function toExperienceSummaryPromptCandidate(
  candidate: ExperienceSummaryCandidate
): Record<string, unknown> {
  return {
    personId: candidate.personId,
    candidateId: candidate.candidateId,
    articleId: candidate.articleId,
    sourceRefId: candidate.sourceRefId,
    title: truncateText(candidate.title, 100),
    content: truncateText(candidate.content, 520),
    summary: truncateText(candidate.summary, 180),
    evidence: candidate.evidence.map((evidence) => ({
      id: evidence.id,
      label: evidence.label,
      text: truncateText(evidence.text, 140)
    })),
    candidateQuality: candidate.candidateQuality,
    matchedQuery: candidate.matchedQuery,
    queryType: candidate.queryType,
    queryPurpose: candidate.queryPurpose
  };
}

function filterAndCacheExperienceSummaries(
  query: string,
  output: ExperienceSummaryOutput,
  candidates: ExperienceSummaryCandidate[],
  debug: DemoExperienceSummaryDebug[]
): ExperienceSummaryOutput["summaries"] {
  const candidateByPersonId = new Map(candidates.map((candidate) => [candidate.personId, candidate]));
  const accepted: ExperienceSummaryOutput["summaries"] = [];

  for (const item of output.summaries) {
    const candidate = candidateByPersonId.get(item.personId);
    if (!candidate) {
      continue;
    }

    if (!item.experienceSummary || !isSafeExperienceSummary(item.experienceSummary)) {
      markExperienceSummaryDebug(debug, item.personId, {
        status: "failed",
        source: "none",
        reason: item.reason || "LLM experienceSummary was empty or advice-style",
        cacheHit: false
      });
      continue;
    }

    const cacheKey = buildExperienceSummaryCacheKey(query, candidate);
    experienceSummaryCache.set(cacheKey, {
      expiresAt: Date.now() + EXPERIENCE_SUMMARY_CACHE_TTL_MS,
      summary: item.experienceSummary,
      confidence: item.confidence,
      reason: item.reason
    });
    markExperienceSummaryDebug(debug, item.personId, {
      status: "ready",
      source: "llm",
      reason: item.reason || "LLM generated a grounded experienceSummary",
      cacheHit: false
    });
    accepted.push(item);
  }

  const acceptedIds = new Set(accepted.map((item) => item.personId));
  for (const candidate of candidates) {
    if (!acceptedIds.has(candidate.personId)) {
      markExperienceSummaryDebug(debug, candidate.personId, {
        status: "failed",
        source: "none",
        reason: "LLM did not return an acceptable experienceSummary for this person",
        cacheHit: false
      });
    }
  }

  return accepted;
}

function buildExperienceSummaryCacheKey(
  query: string,
  candidate: ExperienceSummaryCandidate
): string {
  return [
    "experience_summary_v1",
    `q=${normalizeText(query).toLowerCase()}`,
    `person=${candidate.personId}`,
    `candidate=${candidate.candidateId}`,
    `content=${candidate.contentHash}`
  ].join("|");
}

function pruneExpiredExperienceSummaryCache(): void {
  const now = Date.now();
  for (const [cacheKey, entry] of experienceSummaryCache) {
    if (entry.expiresAt <= now) {
      experienceSummaryCache.delete(cacheKey);
    }
  }
}

function buildExperienceFallbackSummary(person: DemoPerson): string {
  const article = person.articles[0];
  return truncateText(
    [person.oneLine, person.lesson, article?.summary, article?.evidence.map((item) => item.text).join(" ")]
      .filter(Boolean)
      .join(" "),
    220
  );
}

function createFallbackIntent(query: string): IntentExpandOutput {
  const intentTags = inferIntentTags(query);
  const userNeedSummary = `用户正在探索「${truncateText(query, 40)}」相关的公开经验与可行路径。`;
  const searchQueries = buildFallbackSearchQueryPlan(query);
  const objectiveContext = buildObjectiveSearchContext(query);
  const dynamicTopicSignals = buildDynamicTopicSignals({
    originalQuery: query,
    userCoreQuestion: userNeedSummary,
    focusTags: intentTags,
    searchQueries
  });
  const topicSignals = unique([
    ...dynamicTopicSignals,
    ...intentTags,
    ...inferFallbackIntentTagSeeds(query),
    "公开经验",
    "可行路径",
    "代价边界",
    "下一步"
  ]).slice(0, 8);

  return {
    intent: "life_path_exploration",
    userCoreQuestion: userNeedSummary,
    focusTags: intentTags,
    topicSignals,
    searchQueries,
    objectiveSlots: objectiveContext.objectiveSlots,
    missingSlots: objectiveContext.missingSlots,
    queryPlan: objectiveContext.queryPlan,
    intentTags,
    userNeedSummary
  };
}

function createFallbackEvidenceExtract(candidates: CleanedCandidate[]): EvidenceExtractOutput {
  return {
    evidenceRefs: candidates.slice(0, MAX_REAL_ITEMS).map((candidate) => ({
      sourceRefId: candidate.sourceRefId,
      label: "公开内容片段",
      evidenceText: truncateText(candidate.evidenceText || candidate.text, 180),
      relevanceScore: 0.68,
      reason: "规则兜底：保留可追溯的公开内容片段"
    })),
    peopleSeeds: candidates.slice(0, MAX_REAL_ITEMS).map((candidate) => ({
      personSeedId: candidate.personId,
      name: candidate.author || "知乎用户",
      sampleType:
        candidate.sampleType === "experience_sample" ||
        candidate.sampleType === "viewpoint_author" ||
        candidate.sampleType === "content_sample"
          ? candidate.sampleType
          : "content_sample",
      sourceRefs: [candidate.sourceRefId],
      oneLine: truncateText(candidate.text, 70),
      overlaps: ["都与当前问题共享公开内容线索"],
      lesson: "规则兜底只保留原文能支撑的谨慎启发"
    })),
    pathSignals: [],
    personaSeeds: candidates.slice(0, MAX_REAL_ITEMS).map((candidate) => ({
      personSeedId: candidate.personId,
      enabled: Boolean(candidate.sourceRefId && candidate.articleId),
      openingLine: "你可以继续问这段公开内容里的选择、代价和边界。",
      suggestedQuestions: ["这段公开内容里，最确定的信息是什么？", "哪些判断还缺少更多证据？"],
      sourceRefs: [candidate.sourceRefId]
    }))
  };
}

function createEmptyDemoComposeOutput(): DemoResponseComposeOutput {
  return {
    paths: [],
    people: []
  };
}

function createPassingGroundingGuard(): GroundingGuardOutput {
  return {
    valid: true,
    warnings: [],
    disablePersonaPersonIds: [],
    disablePersonaIds: []
  };
}

function applyExperienceSummaryOutput(
  response: DemoSearchResponse,
  output: ExperienceSummaryStageOutput
): void {
  const summaryByPersonId = new Map(output.summaries.summaries.map((item) => [item.personId, item]));

  for (const person of response.people) {
    const item = summaryByPersonId.get(person.id);
    if (!item?.experienceSummary) {
      const debug = output.debug.find((entry) => entry.personId === person.id);
      if (debug?.status === "failed") {
        person.experienceSummary = null;
        person.experienceSummarySource = "none";
        person.experienceSummaryStatus = "failed";
        delete person.experienceSummaryConfidence;
      }
      continue;
    }

    person.experienceSummary = item.experienceSummary;
    person.experienceSummarySource = "llm";
    person.experienceSummaryStatus = "ready";
    person.experienceSummaryConfidence = item.confidence;
  }
}

function applyEvidenceExtractDisplayStatus(
  response: DemoSearchResponse,
  output: EvidenceExtractOutput,
  llmExtracted: boolean
): void {
  const evidenceBySourceRef = new Map(output.evidenceRefs.map((item) => [item.sourceRefId, item]));
  const evidenceStatus: DemoEvidenceStatus = llmExtracted ? "llm_extracted" : "raw_snippet_only";

  for (const person of response.people) {
    person.evidenceStatus = evidenceStatus;

    for (const article of person.articles) {
      const sourceRefId = article.sourceRefs[0] || person.sourceRefs[0] || article.evidence[0]?.sourceRefId || "";
      const extracted = sourceRefId ? evidenceBySourceRef.get(sourceRefId) : undefined;
      const evidenceText = llmExtracted && extracted?.evidenceText
        ? extracted.evidenceText
        : buildFallbackEvidenceText(article);
      article.evidenceStatus = evidenceStatus;
      article.evidenceText = evidenceText;

      if (article.evidence[0]) {
        article.evidence[0].label = llmExtracted ? "AI 证据提炼" : "来源片段";
        article.evidence[0].text = evidenceText;
      }
    }
  }
}

function applyRoleBasedPathDisplayCopy(response: DemoSearchResponse, query: string): void {
  for (const path of response.paths) {
    const role = readContentRole(path.contentRole ?? inferPathRoleFromQuality(response, path));
    const copy = PATH_DISPLAY_COPY[role];
    path.contentRole = role;
    path.title = copy.title;
    path.summary = truncateText(
      `${copy.summary} 它回应「${truncateText(query, 24)}」时，只使用可追溯的来源片段做展示。`,
      150
    );
    path.tradeoff = copy.tradeoff;
    path.displayLabel = copy.title;
    path.displayTradeoff = copy.tradeoff;
  }
}

function applyDisplayGateFields(response: DemoSearchResponse): void {
  const qualityBySourceRef = new Map(
    (response.debug.candidateQuality ?? [])
      .filter((item): item is DemoCandidateQuality & { sourceRefId: string } => Boolean(item.sourceRefId))
      .map((item) => [item.sourceRefId, item])
  );

  for (const person of response.people) {
    const sourceRefId = person.sourceRefs[0] || person.match.sourceRefs[0] || "";
    const quality = sourceRefId ? qualityBySourceRef.get(sourceRefId) : undefined;
    const displayTier = toDisplayTier(person.match);
    const evidenceStatus = person.evidenceStatus ?? inferPersonEvidenceStatus(person);
    const canChat = canPersonChat(person.aiPersona.enabled, person.match, quality);

    person.displayTier = displayTier;
    person.evidenceStatus = evidenceStatus;
    person.canChat = canChat;
    person.displayLabel = toDisplayLabel(displayTier);
    person.displayTradeoff = toDisplayTradeoff(displayTier, canChat, evidenceStatus, quality);
    person.aiPersona.canChat = canChat;
    person.aiPersona.evidenceStatus = evidenceStatus;
    person.aiPersona.displayLabel = canChat ? "可追问的经验回声" : "仅查看来源片段";
    person.aiPersona.displayTradeoff = person.displayTradeoff;

    for (const article of person.articles) {
      const articleStatus = article.evidenceStatus ?? evidenceStatus;
      article.evidenceStatus = articleStatus;
      article.evidenceText = buildFallbackEvidenceText(article);
      if (article.evidence[0] && articleStatus === "raw_snippet_only") {
        article.evidence[0].label = "来源片段";
      }
    }

    if (!canChat) {
      person.aiPersona.openingLine = "这段公开内容目前只适合查看来源片段，暂不开放追问。";
      person.aiPersona.suggestedQuestions = ["这段公开内容里，哪些信息是确定的？"];
    }
  }
}

function applyDemoResponseComposeOutput(
  response: DemoSearchResponse,
  output: DemoResponseComposeOutput,
  guardWarnings: string[]
): ComposeApplyStats {
  const stats: ComposeApplyStats = {
    focusTagCount: 0,
    pathCount: 0,
    peopleCount: 0,
    personaCount: 0
  };

  const pathById = new Map(response.paths.map((path) => [path.id, path]));
  for (const item of output.paths) {
    const path = pathById.get(item.id);
    if (
      !path ||
      !areSafeTexts([
        item.title,
        item.summary,
        item.whyRelevant ?? "",
        item.tradeoff ?? "",
        item.fitReason ?? "",
        item.diversityKey ?? ""
      ]) ||
      !isExperiencePathTitle(item.title)
    ) {
      guardWarnings.push(`demo_response_compose path skipped: ${item.id}`);
      continue;
    }

    path.title = item.title;
    path.summary = item.summary;
    if (item.whyRelevant && isSafeFitReason(item.whyRelevant)) path.whyRelevant = item.whyRelevant;
    if (item.tradeoff && isSafeText(item.tradeoff)) path.tradeoff = item.tradeoff;
    if (item.fitReason && isSafeFitReason(item.fitReason)) path.fitReason = item.fitReason;
    if (item.diversityKey && isSafeText(item.diversityKey)) path.diversityKey = item.diversityKey;
    path.stance = item.stance;
    stats.pathCount += 1;
  }

  const personById = new Map(response.people.map((person) => [person.id, person]));
  for (const item of output.people) {
    const person = personById.get(item.id);
    if (!person) {
      guardWarnings.push(`demo_response_compose person skipped: ${item.id}`);
      continue;
    }

    const textValues = [
      item.role,
      item.badge,
      item.oneLine,
      item.who,
      item.fitReason,
      ...(item.overlaps ?? []),
      ...(item.matchReasons ?? []),
      ...(item.matchedVariables ?? [])
    ].filter((value): value is string => Boolean(value));

    if (!areSafeTexts(textValues)) {
      guardWarnings.push(`demo_response_compose unsafe person text skipped: ${item.id}`);
      continue;
    }

    if (item.role) person.role = item.role;
    if (item.badge) person.badge = item.badge;
    if (item.oneLine) person.oneLine = item.oneLine;
    if (item.fitReason && isSafeFitReason(item.fitReason)) person.fitReason = item.fitReason;
    if (item.who) person.who = ensurePublicContentBoundary(item.who);
    if (item.overlaps?.length) person.overlaps = item.overlaps;
    if (item.matchReasons?.length) person.match.reasons = item.matchReasons;
    if (item.matchedVariables?.length) person.match.matchedVariables = item.matchedVariables;
    person.aiPersona.boundary = DEMO_PERSONA_BOUNDARY_NOTICE;
    stats.peopleCount += 1;
  }

  return stats;
}

function applyGroundingGuardOutput(
  response: DemoSearchResponse,
  output: GroundingGuardOutput,
  guardWarnings: string[]
): void {
  if (!output.valid) {
    const warning =
      output.warnings[0] ??
      "grounding_guard invalid: valid=false; all personas disabled by conservative rule fallback";
    guardWarnings.push(warning);
    for (const person of response.people) {
      disablePersona(person, "grounding guard returned valid=false");
    }
    return;
  }

  guardWarnings.push(...output.warnings);

  const disabledPersonIds = new Set(output.disablePersonaPersonIds);
  const disabledPersonaIds = new Set(output.disablePersonaIds);
  for (const person of response.people) {
    if (disabledPersonIds.has(person.id) || disabledPersonaIds.has(person.aiPersona.personaId)) {
      disablePersona(person, "grounding guard disabled persona");
    }
  }
}

function applyRuleGroundingGuard(response: DemoSearchResponse, guardWarnings: string[]): void {
  const allowedSourceRefs = new Set(response.meta.sourceRefs.map((sourceRef) => sourceRef.id));

  for (const path of response.paths) {
    path.sourceRefs = filterAllowedRefs(path.sourceRefs, allowedSourceRefs);
    path.evidenceIds = filterEvidenceIds(path.evidenceIds, path.sourceRefs, response.meta.sourceRefs);
  }

  for (const person of response.people) {
    person.sourceRefs = filterAllowedRefs(person.sourceRefs, allowedSourceRefs);
    person.evidenceIds = filterEvidenceIds(person.evidenceIds, person.sourceRefs, response.meta.sourceRefs);
    person.aiPersona.boundary = DEMO_PERSONA_BOUNDARY_NOTICE;
    person.aiPersona.grounding.sourceRefs = filterAllowedRefs(
      person.aiPersona.grounding.sourceRefs,
      allowedSourceRefs
    );

    const articleIds = new Set(person.articles.map((article) => article.id));
    person.aiPersona.grounding.articleIds = person.aiPersona.grounding.articleIds.filter((articleId) =>
      articleIds.has(articleId)
    );

    for (const article of person.articles) {
      article.sourceRefs = filterAllowedRefs(article.sourceRefs, allowedSourceRefs);
      article.evidence = article.evidence.filter((evidence) => allowedSourceRefs.has(evidence.sourceRefId));
    }

    const personaHasEvidence =
      person.aiPersona.grounding.articleIds.length > 0 &&
      person.aiPersona.grounding.sourceRefs.length > 0 &&
      person.articles.some((article) => article.evidence.length > 0);
    if (!personaHasEvidence) {
      disablePersona(person, "rules disabled persona because evidence/sourceRefs are insufficient");
      guardWarnings.push(`persona disabled for insufficient evidence: ${person.id}`);
    }

    if (!areSafeTexts([
      person.role,
      person.badge,
      person.oneLine,
      person.who,
      person.lesson,
      person.aiPersona.openingLine,
      ...person.aiPersona.suggestedQuestions,
      ...person.match.reasons
    ])) {
      disablePersona(person, "rules disabled persona because text crossed safety boundary");
      guardWarnings.push(`persona disabled for unsafe text boundary: ${person.id}`);
    }
  }
}

function disablePersona(person: DemoPerson, reason: string): void {
  person.aiPersona.enabled = false;
  person.aiPersona.openingLine = "这段公开内容证据不足，暂时不能生成可追问的经验回声。";
  person.aiPersona.suggestedQuestions = ["这段公开内容里，哪些信息是确定的？"];
  person.match.riskNotes = unique([...person.match.riskNotes, reason]);
}

function syncTopLevelPersonas(response: DemoSearchResponse): void {
  response.personas = response.people.map(toPersona);
  response.sections = buildDisplaySections(response);
}

function readResponsePersonaIds(response: DemoSearchResponse): string[] {
  if (response.personas?.length) {
    return response.personas.map((persona) => persona.id);
  }

  return response.people.map((person) => person.aiPersona.personaId).filter(Boolean);
}

function toPersona(person: DemoPerson): DemoPersona {
  return {
    id: person.aiPersona.personaId,
    personId: person.id,
    displayName: person.aiPersona.displayName,
    avatar: person.avatar,
    personaType: "experience_echo",
    canChat: person.canChat,
    displayTier: person.displayTier,
    evidenceStatus: person.evidenceStatus,
    displayLabel: person.aiPersona.displayLabel ?? (person.canChat ? "可追问的经验回声" : "仅查看来源片段"),
    displayTradeoff: person.displayTradeoff,
    intro: person.aiPersona.openingLine,
    fitReason: person.fitReason,
    boundaryNotice: DEMO_PERSONA_BOUNDARY_NOTICE,
    sourceRefs: person.sourceRefs,
    suggestedQuestions: person.aiPersona.suggestedQuestions
  };
}

function buildDisplaySections(response: DemoSearchResponse): DemoSearchResponse["sections"] {
  const personas = response.personas ?? [];
  const corePeople = response.people.filter((person) => person.displayTier === "core");
  const supplementPeople = response.people.filter((person) => person.displayTier !== "core");
  const chatPersonas = personas.filter((persona) => persona.canChat === true);
  const sourceOnlyPersonas = personas.filter((persona) => persona.canChat !== true);

  return [
    {
      id: "section_paths",
      type: "paths",
      title: "参考路径",
      itemRefs: response.paths.map((path) => path.id)
    },
    {
      id: "section_core_people",
      type: "people",
      title: "较匹配的公开经历",
      itemRefs: corePeople.map((person) => person.id)
    },
    {
      id: "section_supplement_people",
      type: "people",
      title: "补充参考样本",
      itemRefs: supplementPeople.map((person) => person.id)
    },
    {
      id: "section_chat_personas",
      type: "personas",
      title: "可追问的经验回声",
      itemRefs: chatPersonas.map((persona) => persona.id)
    },
    {
      id: "section_source_only_personas",
      type: "personas",
      title: "仅查看来源片段",
      itemRefs: sourceOnlyPersonas.map((persona) => persona.id)
    }
  ];
}

function toDemoComposeContext(
  response: DemoSearchResponse,
  allowed: {
    pathIds: Set<string>;
    personIds: Set<string>;
  }
): Record<string, unknown> {
  return {
    analysis: {
      intent: response.analysis.intent,
      focusTags: response.analysis.focusTags
    },
    paths: response.paths.filter((path) => allowed.pathIds.has(path.id)).map((path) => ({
      id: path.id,
      title: path.title,
      summary: path.summary,
      whyRelevant: path.whyRelevant,
      tradeoff: path.tradeoff,
      diversityKey: path.diversityKey,
      stance: path.stance,
      sourceRefs: path.sourceRefs
    })),
    people: response.people.filter((person) => allowed.personIds.has(person.id)).map((person) => ({
      id: person.id,
      name: person.name,
      sampleType: person.sampleType,
      pathId: person.pathId,
      role: person.role,
      badge: person.badge,
      oneLine: person.oneLine,
      matchedPathTitle: person.matchedPathTitle,
      fitReason: person.fitReason,
      who: person.who,
      overlaps: person.overlaps,
      match: {
        reasons: person.match.reasons,
        matchedVariables: person.match.matchedVariables,
        sourceRefs: person.match.sourceRefs
      },
      articles: person.articles.map((article) => ({
        id: article.id,
        title: article.title,
        summary: article.summary,
        sourceRefs: article.sourceRefs,
        evidence: article.evidence.map((evidence) => ({
          id: evidence.id,
          text: truncateText(evidence.text, 120),
          sourceRefId: evidence.sourceRefId
        }))
      })),
      sourceRefs: person.sourceRefs
    }))
  };
}

function toGroundingGuardContext(response: DemoSearchResponse): Record<string, unknown> {
  return {
    paths: response.paths.map((path) => ({
      id: path.id,
      title: path.title,
      summary: path.summary,
      whyRelevant: path.whyRelevant,
      tradeoff: path.tradeoff,
      diversityKey: path.diversityKey,
      sourceRefs: path.sourceRefs,
      evidenceIds: path.evidenceIds
    })),
    people: response.people.map((person) => ({
      id: person.id,
      role: person.role,
      oneLine: person.oneLine,
      who: person.who,
      sourceRefs: person.sourceRefs,
      evidenceIds: person.evidenceIds,
      aiPersona: {
        personaId: person.aiPersona.personaId,
        enabled: person.aiPersona.enabled,
        boundary: person.aiPersona.boundary,
        grounding: {
          sourceRefs: person.aiPersona.grounding.sourceRefs,
          articleIds: person.aiPersona.grounding.articleIds
        }
      }
    })),
    personas: (response.personas ?? []).map((persona) => ({
      id: persona.id,
      personId: persona.personId,
      boundaryNotice: persona.boundaryNotice,
      sourceRefs: persona.sourceRefs
    }))
  };
}

function filterAllowedRefs(sourceRefs: string[], allowedSourceRefs: Set<string>): string[] {
  return unique(sourceRefs.filter((sourceRef) => allowedSourceRefs.has(sourceRef)));
}

function filterEvidenceIds(
  evidenceIds: string[],
  sourceRefs: string[],
  allSourceRefs: DemoSourceRef[]
): string[] {
  const allowedEvidenceIds = new Set(
    allSourceRefs
      .filter((sourceRef) => sourceRefs.includes(sourceRef.id))
      .flatMap((sourceRef) => sourceRef.evidenceIds)
  );

  return unique(evidenceIds.filter((evidenceId) => allowedEvidenceIds.has(evidenceId)));
}

function createSuccessStage(
  stage: LlmTaskType,
  provider?: string,
  model?: string
): DemoDebugLlmStageResult {
  return {
    stage,
    attempted: 1,
    succeeded: 1,
    failed: 0,
    repairUsed: 0,
    repairFailed: 0,
    fallbackReasons: [],
    ...(provider ? { provider } : {}),
    ...(model ? { model } : {})
  };
}

function createFallbackStage(stage: LlmTaskType, error: unknown): DemoDebugLlmStageResult {
  return {
    stage,
    attempted: 1,
    succeeded: 0,
    failed: 1,
    repairUsed: 0,
    repairFailed: 0,
    fallbackReasons: [formatErrorSummary(error)]
  };
}

function createInvalidGroundingGuardStage(output: GroundingGuardOutput): DemoDebugLlmStageResult {
  return {
    stage: "grounding_guard",
    attempted: 1,
    succeeded: 0,
    failed: 1,
    repairUsed: 0,
    repairFailed: 0,
    fallbackReasons: [
      output.warnings[0] ??
        "grounding_guard returned valid=false; conservative persona disable fallback applied"
    ]
  };
}

function createSkippedStage(stage: LlmTaskType, reason: string): DemoDebugLlmStageResult {
  return {
    stage,
    attempted: 0,
    succeeded: 0,
    failed: 0,
    repairUsed: 0,
    repairFailed: 0,
    fallbackReasons: [reason]
  };
}

function summarizeLlmFallback(stageResults: DemoDebugLlmStageResult[]): LlmFallbackSummary {
  const skippedStages = stageResults.filter((result) => result.attempted === 0);
  const failedStages = stageResults.filter((result) => result.failed > 0);
  const successfulStages = stageResults.filter((result) => result.succeeded > 0);

  if (skippedStages.length === 0 && failedStages.length === 0) {
    return {
      used: false,
      kind: "",
      reason: ""
    };
  }

  const details = summarizeFallbackDetails([...skippedStages, ...failedStages]);
  if (successfulStages.length === 0 && failedStages.length === 0) {
    return {
      used: true,
      kind: "no_llm_config",
      reason: `no_llm_config: rules used because no LLM stage was configured. ${details}`.trim()
    };
  }

  if (successfulStages.length === 0) {
    return {
      used: true,
      kind: "all_llm_failed",
      reason: `all_llm_failed: rules used because configured LLM stages failed. ${details}`.trim()
    };
  }

  return {
    used: true,
    kind: "partial_llm_fallback",
    reason: `partial_llm_fallback: rules used for skipped or failed LLM stages. ${details}`.trim()
  };
}

function summarizeFallbackDetails(stageResults: DemoDebugLlmStageResult[]): string {
  const details = stageResults
    .flatMap((result) =>
      (result.fallbackReasons.length > 0 ? result.fallbackReasons : ["fallback"]).map(
        (reason) => `${result.stage}: ${reason}`
      )
    )
    .slice(0, 4)
    .join("; ");

  return details ? `details=${details}` : "";
}

function buildIntentStageDebug(
  intentStageResult: DemoDebugLlmStageResult,
  composeStageResult: DemoDebugLlmStageResult,
  focusTagsUpdatedByLlm: boolean,
  intentOutput: IntentExpandOutput
): DemoDebugIntentStage {
  const intentExpandLlmUsed = intentStageResult.succeeded > 0;
  const focusTagsLlmUsed = focusTagsUpdatedByLlm && composeStageResult.succeeded > 0;
  const llmUsed = intentExpandLlmUsed || focusTagsLlmUsed;
  const mode: DemoDebugIntentStage["mode"] = llmUsed ? "hybrid" : "fallback";

  return {
    mode,
    llmUsed,
    provider: llmRouter.getProviderForTask("intent_expand"),
    model: llmRouter.getModelForTask("intent_expand"),
    fallbackReason: summarizeIntentStageReason(
      intentStageResult,
      composeStageResult,
      intentExpandLlmUsed,
      focusTagsLlmUsed
    ),
    intentSource: "rule",
    focusTagsSource: focusTagsLlmUsed ? "llm" : "rule",
    objectiveSlots: intentOutput.objectiveSlots,
    missingSlots: intentOutput.missingSlots,
    queryPlan: intentOutput.queryPlan
  };
}

function summarizeIntentStageReason(
  intentStageResult: DemoDebugLlmStageResult,
  composeStageResult: DemoDebugLlmStageResult,
  intentExpandLlmUsed: boolean,
  focusTagsLlmUsed: boolean
): string {
  const fallbackStages = [intentStageResult, composeStageResult].filter(
    (result) => result.attempted === 0 || result.failed > 0
  );
  const fallbackDetails = summarizeFallbackDetails(fallbackStages);

  if (intentExpandLlmUsed && focusTagsLlmUsed) {
    return "intent_expand LLM planned search queries and demo_response_compose LLM updated focusTags; analysis.intent remains rule-generated";
  }

  if (intentExpandLlmUsed) {
    return [
      "intent_expand LLM planned search queries; analysis.intent and focusTags remain rule-generated",
      fallbackDetails
    ]
      .filter(Boolean)
      .join(". ");
  }

  if (focusTagsLlmUsed) {
    return [
      "demo_response_compose LLM updated focusTags; analysis.intent remains rule-generated",
      fallbackDetails
    ]
      .filter(Boolean)
      .join(". ");
  }

  return [
    "deterministic rule analysis used for analysis.intent and focusTags",
    fallbackDetails
  ]
    .filter(Boolean)
    .join(". ");
}

function inferIntentTags(query: string): string[] {
  const tags = unique([
    ...buildDynamicTopicSignals({
      originalQuery: query
    }),
    ...inferFallbackIntentTagSeeds(query)
  ]).slice(0, 6);

  return tags.length > 0 ? tags : ["公开经验", "可行路径", "代价边界", "下一步"];
}

function inferFallbackIntentTagSeeds(query: string): string[] {
  const normalized = normalizeText(query);
  const seeds: string[] = [];
  const rules: Array<[string[], string[]]> = [
    [["不工作", "不上班", "裸辞", "失业", "待业"], ["暂停工作", "现金流", "生活节奏", "回流接口"]],
    [["35岁", "三十五", "裸辞", "转行"], ["年龄压力", "职业回流", "收入波动", "履历解释"]],
    [["北京", "老家", "大城市", "回家"], ["城市去留", "生活成本", "机会密度", "家庭关系"]],
    [["读研", "研究生", "考研"], ["读研卡点", "导师课题", "就业接口", "退场成本"]],
    [["父母", "家人", "不同意", "反对"], ["家庭沟通", "经济独立", "边界成本", "后果承担"]],
    [["朋友", "断联", "消耗"], ["关系消耗", "边界表达", "情绪空间", "失去成本"]]
  ];

  for (const [keywords, values] of rules) {
    if (keywords.some((keyword) => normalized.includes(keyword))) {
      seeds.push(...values);
    }
  }

  return seeds;
}

function ensurePublicContentBoundary(value: string): string {
  if (value.includes("公开内容") || value.includes("公开回答")) {
    return value;
  }

  return `${value}（基于知乎公开内容整理，不等同于作者完整人生。）`;
}

function areSafeTexts(values: string[]): boolean {
  return values.every(isSafeText);
}

function isSafeText(value: string): boolean {
  const forbiddenFragments = [
    "作者本人正在回答",
    "本人正在回答",
    "作为作者本人",
    "作为这位作者",
    "我是作者",
    "我当时",
    "我经历过",
    "作者在线",
    "联系TA",
    "联系 TA",
    "联系作者",
    "私信",
    "加微信",
    "和作者聊",
    "和本人聊",
    "模拟作者本人",
    "roughTier",
    "roughScore",
    "diversityKey",
    "contentRole",
    "keepReason",
    "used_as_core_evidence",
    "规则兜底保留"
  ];

  return !forbiddenFragments.some((fragment) => value.includes(fragment));
}

function isSafeFitReason(value: string): boolean {
  const overclaimFragments = [
    "一定适合",
    "绝对适合",
    "最适合",
    "完美匹配",
    "唯一答案",
    "保证",
    "必然",
    "注定"
  ];

  return isSafeText(value) && !overclaimFragments.some((fragment) => value.includes(fragment));
}

function isSafeExperienceSummary(value: string): boolean {
  const adviceFragments = [
    "你应该",
    "建议先",
    "建议你",
    "可以考虑",
    "你可以先",
    "你可以",
    "应该先",
    "最好先",
    "需要先"
  ];
  const experienceMarkers = ["这个样本", "这段经历", "作者", "TA", "ta"];

  return (
    isSafeText(value) &&
    experienceMarkers.some((marker) => value.includes(marker)) &&
    !adviceFragments.some((fragment) => value.includes(fragment))
  );
}

function isExperiencePathTitle(value: string): boolean {
  const adviceTitleFragments = [
    "比较工作机会",
    "确认目标岗位",
    "评估生活",
    "先拆清",
    "给异地设",
    "保留回流",
    "留一个可回撤",
    "把现金流",
    "目标岗位缺口",
    "可回撤方案"
  ];

  return (
    /有人|有些人|这个样本|这段经历|作者|裸辞|离职|创业|试错|验证/.test(value) &&
    !adviceTitleFragments.some((fragment) => value.includes(fragment))
  );
}

function buildFallbackEvidenceText(article: DemoPerson["articles"][number]): string {
  return truncateText(
    article.evidence[0]?.text || article.summary || normalizeText(article.text).slice(0, 260),
    260
  );
}

function inferPersonEvidenceStatus(person: DemoPerson): DemoEvidenceStatus {
  return person.articles.some((article) => article.evidenceStatus === "llm_extracted")
    ? "llm_extracted"
    : "raw_snippet_only";
}

function toDisplayTier(match: DemoPerson["match"]): DemoDisplayTier {
  return (match.level === "high" || match.level === "medium") &&
    match.evidenceQuality >= 0.65 &&
    match.contentRelevance >= 0.25
    ? "core"
    : "supplement";
}

function canPersonChat(
  aiPersonaEnabled: boolean,
  match: DemoPerson["match"],
  quality?: Pick<
    DemoCandidateQuality,
    "penaltySignals" | "filterReason" | "penaltyScore" | "contentRole" | "queryType"
  >
): boolean {
  return Boolean(
    aiPersonaEnabled &&
      match.personaReadiness >= 0.65 &&
      match.evidenceQuality >= 0.65 &&
      match.contentRelevance >= 0.25 &&
      quality?.contentRole !== "viewpoint" &&
      quality?.queryType !== "original" &&
      !hasAdMarketingPenalty(quality, match)
  );
}

function hasAdMarketingPenalty(
  quality: Pick<DemoCandidateQuality, "penaltySignals" | "filterReason" | "penaltyScore"> | undefined,
  match?: Pick<DemoPerson["match"], "riskNotes">
): boolean {
  const text = [
    ...(quality?.penaltySignals ?? []),
    quality?.filterReason ?? "",
    ...(match?.riskNotes ?? [])
  ].join(" ");

  return /广告营销|加微信|私信|报名|课程|咨询|推广|带货/.test(text);
}

function toDisplayLabel(displayTier: DemoDisplayTier): string {
  return displayTier === "core" ? "较匹配的公开经历" : "补充参考样本";
}

function toDisplayTradeoff(
  displayTier: DemoDisplayTier,
  canChat: boolean,
  evidenceStatus: DemoEvidenceStatus,
  quality?: Pick<DemoCandidateQuality, "penaltySignals" | "filterReason" | "penaltyScore">
): string {
  if (canChat) {
    return "证据和相关度达到追问门槛，可基于来源片段继续理解这段公开经历。";
  }

  if (hasAdMarketingPenalty(quality)) {
    return "内容含广告或营销风险，只保留为补充参考，不开放追问。";
  }

  if (evidenceStatus === "raw_snippet_only") {
    return "当前只拿到来源片段，适合先看原文线索，不包装成完整经历。";
  }

  return displayTier === "core"
    ? "证据可用于展示，但追问门槛暂未达到，建议先查看来源片段。"
    : "相关度或证据质量不足，只作为补充参考展示。";
}

function inferPathRoleFromQuality(response: DemoSearchResponse, path: DemoSearchResponse["paths"][number]): DemoContentRole {
  const sourceRefs = new Set(path.sourceRefs);
  const quality = (response.debug.candidateQuality ?? []).find((candidate) =>
    candidate.sourceRefId ? sourceRefs.has(candidate.sourceRefId) : false
  );

  return readContentRole(quality?.contentRole);
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

  return "viewpoint";
}

function formatErrorSummary(error: unknown): string {
  if (error instanceof HttpError) {
    return `${error.code}: ${error.message}`;
  }

  if (error instanceof Error && error.message) {
    const code = "code" in error && typeof error.code === "string" ? error.code : error.name;
    return `${code || "ERROR"}: ${truncateText(error.message, 160)}`;
  }

  return "UNKNOWN_ERROR: Unknown error";
}

function truncateText(value: string, maxLength: number): string {
  const normalized = normalizeText(value);
  if (normalized.length <= maxLength) {
    return normalized;
  }

  return `${normalized.slice(0, maxLength - 3)}...`;
}

function normalizeText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function unique(values: string[]): string[] {
  return Array.from(new Set(values));
}

function hashString(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }

  return (hash >>> 0).toString(16);
}
