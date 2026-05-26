import { assertDemoSearchGrounding } from "../guards/demoEvidence.guard.js";
import { createMockDemoSearchResponse } from "../mocks/demoSearch.mock.js";
import { selectQualitySearchItems } from "../services/demoCandidateQuality.service.js";
import { composeRealDemoSearchResponse } from "../services/demoRealComposer.service.js";
import { searchService } from "../services/search.service.js";
import type { SearchItem, SearchMatchedQuery } from "../types/api.types.js";
import {
  DEMO_SCHEMA_VERSION,
  type DemoDataMode,
  type DemoSearchResponse,
  type DemoSearchQueryPlan
} from "../types/demo.types.js";
import { HttpError } from "../utils/httpError.js";
import {
  applyAgentEvidenceExtractResult,
  buildEvidenceCandidatesFromDemoResult,
  runAgentEvidenceExtract
} from "../llm/agentEvidenceExtract.js";
import { getLlmTaskTimeoutMs } from "../llm/llmTimeout.js";
import { buildFallbackSearchQueryPlan } from "../llm/searchQueryPlan.js";
import { agentTaskStore } from "./taskStoreFactory.js";
import type { AgentTaskStore } from "./taskStore.js";
import {
  type AgentIntentResult,
  type AgentStageName,
  type AgentStageStatus,
  type AgentTaskSnapshot
} from "./taskTypes.js";

interface SearchRecallResult {
  items: SearchItem[];
  searchQueries: DemoSearchQueryPlan[];
  failedQueries: string[];
  emptyQueries: string[];
}

const STAGE_PROGRESS: Record<AgentStageName, number> = {
  intent_expand: 0.12,
  retrieve_search: 0.32,
  candidate_select: 0.48,
  partial_compose: 0.62,
  evidence_extract: 0.72,
  experience_summary: 0.82,
  grounding_guard: 0.9,
  persona_prepare: 1
};

export class AgentTaskRunner {
  private readonly runningTaskIds = new Set<string>();

  constructor(private readonly store: AgentTaskStore) {}

  start(taskId: string): void {
    if (this.runningTaskIds.has(taskId)) {
      return;
    }

    this.runningTaskIds.add(taskId);
    setTimeout(() => {
      void this.run(taskId).finally(() => {
        this.runningTaskIds.delete(taskId);
      });
    }, 0);
  }

  private async run(taskId: string): Promise<void> {
    const snapshot = this.store.getTask(taskId);
    if (!snapshot || snapshot.task.status !== "queued") {
      return;
    }

    try {
      this.store.patchTask(taskId, {
        status: "running",
        progress: 0.02
      });

      const task = snapshot.task;
      const intent = await this.runIntentStage(taskId, task.query);
      this.store.setIntent(taskId, intent);

      if (task.dataMode === "mock") {
        await this.runMockPipeline(taskId);
        return;
      }

      const recalled = await this.runRetrieveStage(taskId, intent, task.input.count);
      if (recalled.items.length === 0) {
        this.finishWithoutResults(taskId, {
          code: "AGENT_REAL_SEARCH_EMPTY",
          message: "真实搜索没有返回可展示结果",
          failedStage: "retrieve_search",
          retryable: true
        });
        return;
      }

      const selected = await this.runCandidateSelectStage(taskId, recalled, intent);
      if (selected.items.length === 0) {
        this.finishWithoutResults(taskId, {
          code: "AGENT_CANDIDATE_EMPTY",
          message: "真实搜索结果没有通过候选筛选",
          failedStage: "candidate_select",
          retryable: true
        });
        return;
      }

      const partialResult = await this.runPartialComposeStage(taskId, selected);
      this.store.setPartialResult(taskId, partialResult);
      this.store.patchTask(taskId, {
        status: "partial_ready",
        progress: STAGE_PROGRESS.partial_compose,
        partialReadyAt: new Date().toISOString()
      });

      const finalResult = await this.runEvidenceExtractStage(taskId, partialResult, intent);
      this.skipOptionalEnhancementStage(
        taskId,
        "experience_summary",
        "MVP keeps experience_summary as a background enhancement"
      );
      this.skipOptionalEnhancementStage(
        taskId,
        "grounding_guard",
        "MVP uses rule grounding from the composer; LLM grounding is deferred"
      );
      this.skipOptionalEnhancementStage(
        taskId,
        "persona_prepare",
        "MVP derives persona entries from rule-composed people; product persona preparation is deferred"
      );

      this.finishWithResult(taskId, finalResult);
    } catch (error) {
      this.failTask(taskId, error);
    }
  }

  private async runIntentStage(taskId: string, query: string): Promise<AgentIntentResult> {
    this.startStage(taskId, "intent_expand", {
      timeoutMs: getLlmTaskTimeoutMs("intent_expand"),
      inputSummary: { queryLength: query.length }
    });

    const searchQueries = buildFallbackSearchQueryPlan(query);
    const intent: AgentIntentResult = {
      intent: "life_path_exploration",
      userCoreQuestion: `用户在探索「${truncateText(query, 60)}」相关的公开经验。`,
      focusTags: buildFocusTags(query, searchQueries),
      topicSignals: buildTopicSignals(query, searchQueries),
      searchQueries
    };

    this.finishStage(taskId, "intent_expand", "succeeded", {
      outputSummary: {
        searchQueryCount: searchQueries.length,
        fallbackUsed: true
      },
      fallbackUsed: true,
      fallbackReason: "MVP uses deterministic query expansion before optional LLM intent planning"
    });

    return intent;
  }

  private async runMockPipeline(taskId: string): Promise<void> {
    const snapshot = this.requireTask(taskId);
    this.skipOptionalEnhancementStage(
      taskId,
      "retrieve_search",
      "explicit mock mode does not call Zhihu search"
    );
    this.skipOptionalEnhancementStage(
      taskId,
      "candidate_select",
      "explicit mock mode uses the mock dataset"
    );

    this.startStage(taskId, "partial_compose", {
      inputSummary: {
        dataMode: "mock"
      }
    });
    const result = createMockDemoSearchResponse(
      snapshot.task.query,
      snapshot.task.input.count,
      "mock",
      {
        requestedDataMode: snapshot.task.requestedDataMode,
        resolvedDataMode: "mock",
        notes: ["agent task explicit mock mode"]
      }
    );
    this.finishStage(taskId, "partial_compose", "succeeded", {
      outputSummary: {
        pathCount: result.paths.length,
        peopleCount: result.people.length
      }
    });
    this.store.setPartialResult(taskId, result);
    this.store.patchTask(taskId, {
      status: "partial_ready",
      progress: STAGE_PROGRESS.partial_compose,
      partialReadyAt: new Date().toISOString()
    });

    const finalResult = await this.runEvidenceExtractStage(taskId, result, snapshot.task.intent);
    this.skipOptionalEnhancementStage(
      taskId,
      "experience_summary",
      "explicit mock mode keeps LLM summary disabled"
    );
    this.skipOptionalEnhancementStage(
      taskId,
      "grounding_guard",
      "explicit mock mode keeps LLM grounding disabled"
    );
    this.skipOptionalEnhancementStage(
      taskId,
      "persona_prepare",
      "explicit mock mode uses mock persona entries"
    );
    this.finishWithResult(taskId, finalResult);
  }

  private async runRetrieveStage(
    taskId: string,
    intent: AgentIntentResult,
    requestedCount: number
  ): Promise<SearchRecallResult> {
    this.startStage(taskId, "retrieve_search", {
      inputSummary: {
        queryCount: intent.searchQueries.length,
        requestedCount
      }
    });

    const executableQueries = intent.searchQueries.slice(0, 4);
    const searchCount = Math.min(Math.max(requestedCount, 5), 10);
    const failedQueries: string[] = [];
    const emptyQueries: string[] = [];
    const items: SearchItem[] = [];

    for (const [index, plan] of executableQueries.entries()) {
      try {
        const result = await searchService.search(plan.query, searchCount);
        if (result.items.length === 0) {
          emptyQueries.push(plan.query);
          continue;
        }

        items.push(
          ...result.items.map((item) =>
            attachSearchPlanMetadata(item, plan, index)
          )
        );
      } catch (error) {
        failedQueries.push(`${plan.query}: ${toErrorMessage(error)}`);
      }
    }

    const dedupedItems = dedupeSearchItems(items);
    if (dedupedItems.length === 0) {
      this.finishStage(taskId, "retrieve_search", "failed", {
        outputSummary: {
          returnedCount: 0,
          failedQueries,
          emptyQueries
        },
        errorCode: "AGENT_RETRIEVE_EMPTY",
        errorMessage: failedQueries[0] || "real search returned no usable candidates",
        retryable: true
      });
      return {
        items: [],
        searchQueries: executableQueries,
        failedQueries,
        emptyQueries
      };
    }

    this.finishStage(
      taskId,
      "retrieve_search",
      failedQueries.length > 0 ? "degraded" : "succeeded",
      {
        outputSummary: {
          returnedCount: dedupedItems.length,
          failedQueryCount: failedQueries.length,
          emptyQueryCount: emptyQueries.length
        },
        fallbackUsed: failedQueries.length > 0,
        fallbackReason: failedQueries.length > 0 ? failedQueries.join("; ") : undefined,
        retryable: failedQueries.length > 0
      }
    );

    return {
      items: dedupedItems,
      searchQueries: executableQueries,
      failedQueries,
      emptyQueries
    };
  }

  private async runCandidateSelectStage(
    taskId: string,
    recalled: SearchRecallResult,
    intent: AgentIntentResult
  ): Promise<{
    items: SearchItem[];
    candidateQuality: ReturnType<typeof selectQualitySearchItems>["candidateQuality"];
    recalled: SearchRecallResult;
    intent: AgentIntentResult;
  }> {
    const snapshot = this.requireTask(taskId);
    this.startStage(taskId, "candidate_select", {
      inputSummary: {
        rawCandidateCount: recalled.items.length
      }
    });

    const selected = selectQualitySearchItems(
      snapshot.task.query,
      recalled.items,
      Math.min(Math.max(snapshot.task.input.count, 3), 10),
      {
        userCoreQuestion: intent.userCoreQuestion,
        focusTags: intent.focusTags,
        topicSignals: intent.topicSignals,
        searchQueries: recalled.searchQueries
      }
    );

    const status = selected.items.length > 0 ? "succeeded" : "failed";
    this.finishStage(taskId, "candidate_select", status, {
      outputSummary: {
        selectedCount: selected.items.length,
        assessedCount: selected.assessments.length
      },
      retryable: selected.items.length === 0,
      ...(selected.items.length === 0
        ? {
            errorCode: "AGENT_CANDIDATE_EMPTY",
            errorMessage: "no usable candidate after rule selection"
          }
        : {})
    });

    return {
      items: selected.items,
      candidateQuality: selected.candidateQuality,
      recalled,
      intent
    };
  }

  private async runPartialComposeStage(
    taskId: string,
    selected: {
      items: SearchItem[];
      candidateQuality: ReturnType<typeof selectQualitySearchItems>["candidateQuality"];
      recalled: SearchRecallResult;
      intent: AgentIntentResult;
    }
  ): Promise<unknown> {
    const snapshot = this.requireTask(taskId);
    this.startStage(taskId, "partial_compose", {
      inputSummary: {
        selectedCount: selected.items.length
      }
    });

    const result = composeRealDemoSearchResponse({
      query: snapshot.task.query,
      count: snapshot.task.input.count,
      dataMode: snapshot.task.dataMode,
      items: selected.items,
      startedAt: Date.parse(snapshot.task.createdAt),
      userContext: snapshot.task.input.userContext,
      candidateQuality: selected.candidateQuality
    });

    result.analysis = {
      ...result.analysis,
      intent: selected.intent.intent,
      focusTags: selected.intent.focusTags.length > 0
        ? selected.intent.focusTags
        : result.analysis.focusTags
    };
    result.meta = {
      ...result.meta,
      fallbackUsed: false,
      fallbackStages: [],
      llmStages: [],
      timedOutStages: []
    };
    result.debug = {
      ...result.debug,
      searchQueries: selected.recalled.searchQueries,
      search: {
        dataMode: snapshot.task.dataMode,
        queriesUsed: selected.recalled.searchQueries.map((item) => item.query),
        searchRounds: selected.recalled.searchQueries.map((item, index) => ({
          query: item.query,
          roundIndex: index,
          success: !selected.recalled.failedQueries.some((failed) =>
            failed.startsWith(`${item.query}:`)
          ),
          rawResultCount: selected.items.filter((candidate) =>
            candidate.matchedQuery === item.query
          ).length,
          isEmptyResult: selected.recalled.emptyQueries.includes(item.query)
        })),
        totalRawResults: selected.recalled.items.length,
        totalDedupedCandidates: selected.items.length,
        failedQueries: selected.recalled.failedQueries,
        emptyQueries: selected.recalled.emptyQueries,
        degraded: selected.recalled.failedQueries.length > 0,
        fallbackReason: selected.recalled.failedQueries[0],
        candidates: selected.items.map((item) => ({
          sourceId: item.id,
          title: item.title,
          url: item.url,
          authorName: item.author.name,
          snippet: item.evidence.text,
          text: item.text,
          sourceType: item.type,
          queryUsed: item.matchedQuery ?? snapshot.task.query,
          searchRound: item.searchRound ?? 0
        }))
      }
    };

    assertDemoSearchGrounding(result);
    this.finishStage(taskId, "partial_compose", "succeeded", {
      outputSummary: {
        pathCount: result.paths.length,
        peopleCount: result.people.length,
        sourceRefCount: result.meta.sourceRefs.length
      }
    });

    return result;
  }

  private async runEvidenceExtractStage(
    taskId: string,
    partialResult: unknown,
    intent: unknown
  ): Promise<unknown> {
    const snapshot = this.requireTask(taskId);
    const candidates = buildEvidenceCandidatesFromDemoResult(partialResult, 5);

    this.startStage(taskId, "evidence_extract", {
      timeoutMs: getLlmTaskTimeoutMs("evidence_extract"),
      inputSummary: {
        candidateCount: candidates.length,
        maxCandidates: 5,
        sourceRefs: candidates.map((candidate) => candidate.sourceRefId)
      }
    });

    const extraction = await runAgentEvidenceExtract({
      query: snapshot.task.query,
      intent,
      candidates,
      maxCandidates: 5
    });

    const enhancedResult = isDemoSearchResponse(partialResult)
      ? applyAgentEvidenceExtractResult(partialResult, extraction)
      : partialResult;

    this.store.setFinalResult(taskId, enhancedResult);
    this.finishStage(taskId, "evidence_extract", extraction.status, {
      provider: extraction.provider,
      model: extraction.model,
      outputSummary: {
        llmExtracted: extraction.llmExtracted,
        evidenceRefCount: extraction.output.evidenceRefs.length,
        inputCandidateCount: extraction.inputCandidateCount,
        promptCandidateCount: extraction.promptCandidateCount
      },
      errorCode: extraction.errorCode,
      errorMessage: extraction.errorMessage,
      fallbackUsed: extraction.status !== "succeeded",
      fallbackReason: extraction.fallbackReason,
      retryable: extraction.retryable
    });

    return enhancedResult;
  }

  private startStage(
    taskId: string,
    stageName: AgentStageName,
    options: {
      timeoutMs?: number;
      inputSummary?: Record<string, unknown>;
    } = {}
  ): void {
    this.store.patchStage(taskId, stageName, {
      status: "running",
      attempt: 1,
      timeoutMs: options.timeoutMs ?? 0,
      startedAt: new Date().toISOString(),
      finishedAt: null,
      inputSummary: options.inputSummary,
      errorCode: undefined,
      errorMessage: undefined,
      fallbackUsed: false,
      fallbackReason: undefined,
      retryable: false
    });
    this.store.patchTask(taskId, {
      status: "running",
      currentStage: stageName,
      progress: Math.min(STAGE_PROGRESS[stageName], 0.98)
    });
  }

  private finishStage(
    taskId: string,
    stageName: AgentStageName,
    status: AgentStageStatus,
    options: {
      outputSummary?: Record<string, unknown>;
      provider?: string;
      model?: string;
      errorCode?: string;
      errorMessage?: string;
      fallbackUsed?: boolean;
      fallbackReason?: string;
      retryable?: boolean;
    } = {}
  ): void {
    this.store.patchStage(taskId, stageName, {
      status,
      finishedAt: new Date().toISOString(),
      outputSummary: options.outputSummary,
      provider: options.provider,
      model: options.model,
      errorCode: options.errorCode,
      errorMessage: options.errorMessage,
      fallbackUsed: options.fallbackUsed ?? false,
      fallbackReason: options.fallbackReason,
      retryable: options.retryable ?? false
    });
  }

  private skipOptionalEnhancementStage(
    taskId: string,
    stageName: AgentStageName,
    reason: string
  ): void {
    const timeoutMs =
      stageName === "evidence_extract" ||
      stageName === "experience_summary" ||
      stageName === "grounding_guard"
        ? getLlmTaskTimeoutMs(stageName)
        : 0;

    this.store.patchStage(taskId, stageName, {
      status: "skipped",
      attempt: 0,
      timeoutMs,
      startedAt: null,
      finishedAt: new Date().toISOString(),
      outputSummary: {
        deferred: true
      },
      fallbackUsed: true,
      fallbackReason: reason,
      retryable: false
    });
  }

  private finishWithResult(taskId: string, result: unknown): void {
    const snapshot = this.store.setFinalResult(taskId, result);
    const degraded = snapshot.stages.some((stage) =>
      stage.status === "degraded" || stage.status === "timed_out"
    );
    const failedStages = snapshot.stages
      .filter((stage) =>
        stage.status === "failed" ||
        stage.status === "timed_out" ||
        (stage.name === "evidence_extract" && stage.status === "degraded")
      )
      .map((stage) => stage.name);
    const retryableStages = snapshot.stages
      .filter((stage) => stage.retryable)
      .map((stage) => stage.name);

    this.store.patchTask(taskId, {
      status: failedStages.length > 0 ? "degraded" : "succeeded",
      currentStage: null,
      progress: 1,
      degraded,
      degradedReasons: snapshot.stages.flatMap((stage) =>
        stage.status === "degraded" || stage.status === "timed_out"
          ? [stage.fallbackReason || stage.errorMessage || `${stage.name} degraded`]
          : []
      ),
      degradedReason: degraded
        ? snapshot.stages.find((stage) => stage.status === "degraded" || stage.status === "timed_out")
            ?.fallbackReason ?? "agent task completed with degraded stages"
        : null,
      failedStages,
      retryable: retryableStages.length > 0,
      retryableStages,
      finishedAt: new Date().toISOString()
    });
  }

  private finishWithoutResults(
    taskId: string,
    options: {
      code: string;
      message: string;
      failedStage: AgentStageName;
      retryable: boolean;
    }
  ): void {
    const snapshot = this.requireTask(taskId);
    const emptyResult = createEmptyAgentResult({
      taskId,
      query: snapshot.task.query,
      dataMode: snapshot.task.dataMode,
      message: options.message,
      failedStage: options.failedStage
    });
    this.store.setPartialResult(taskId, emptyResult);
    this.store.setFinalResult(taskId, emptyResult);
    this.store.patchTask(taskId, {
      status: "failed",
      currentStage: null,
      progress: 1,
      degraded: true,
      degradedReason: options.message,
      degradedReasons: [options.message],
      failedStages: [options.failedStage],
      retryable: options.retryable,
      retryableStages: options.retryable ? [options.failedStage] : [],
      error: {
        code: options.code,
        message: options.message
      },
      finishedAt: new Date().toISOString()
    });
  }

  private failTask(taskId: string, error: unknown): void {
    const message = toErrorMessage(error);
    const currentStage = this.store.getTask(taskId)?.task.currentStage;
    if (currentStage) {
      this.finishStage(taskId, currentStage, "failed", {
        errorCode: toErrorCode(error),
        errorMessage: message,
        retryable: true
      });
    }

    const snapshot = this.store.getTask(taskId);
    if (!snapshot) {
      return;
    }

    const failedStage = currentStage ?? "partial_compose";
    const emptyResult = createEmptyAgentResult({
      taskId,
      query: snapshot.task.query,
      dataMode: snapshot.task.dataMode,
      message,
      failedStage
    });
    this.store.setPartialResult(taskId, emptyResult);
    this.store.setFinalResult(taskId, emptyResult);
    this.store.patchTask(taskId, {
      status: "failed",
      currentStage: null,
      progress: 1,
      degraded: true,
      degradedReason: message,
      degradedReasons: [message],
      failedStages: [failedStage],
      retryable: true,
      retryableStages: [failedStage],
      error: {
        code: toErrorCode(error),
        message
      },
      finishedAt: new Date().toISOString()
    });
  }

  private requireTask(taskId: string): AgentTaskSnapshot {
    const snapshot = this.store.getTask(taskId);
    if (!snapshot) {
      throw new Error(`Agent task not found: ${taskId}`);
    }

    return snapshot;
  }
}

export const agentTaskRunner = new AgentTaskRunner(agentTaskStore);

function attachSearchPlanMetadata(
  item: SearchItem,
  plan: DemoSearchQueryPlan,
  roundIndex: number
): SearchItem {
  const matchedQuery: SearchMatchedQuery = {
    query: plan.query,
    type: plan.type,
    purpose: plan.purpose,
    roundIndex
  };

  return {
    ...item,
    matchedQuery: plan.query,
    queryType: plan.type,
    queryPurpose: plan.purpose,
    searchRound: roundIndex,
    matchedQueries: [matchedQuery, ...(item.matchedQueries ?? [])]
  };
}

function dedupeSearchItems(items: SearchItem[]): SearchItem[] {
  const seen = new Set<string>();
  const result: SearchItem[] = [];

  for (const item of items) {
    const key = item.url || item.id;
    if (!key || seen.has(key)) {
      continue;
    }

    seen.add(key);
    result.push(item);
  }

  return result;
}

function buildFocusTags(query: string, searchQueries: DemoSearchQueryPlan[]): string[] {
  return unique([
    ...splitSignals(query),
    ...searchQueries.flatMap((item) => splitSignals(item.query))
  ]).slice(0, 6);
}

function buildTopicSignals(query: string, searchQueries: DemoSearchQueryPlan[]): string[] {
  return unique([
    ...splitSignals(query),
    ...searchQueries.flatMap((item) => splitSignals(`${item.query} ${item.purpose}`))
  ]).slice(0, 12);
}

function splitSignals(value: string): string[] {
  return value
    .split(/[\s,，。？！?、/|]+/)
    .map((item) => item.trim())
    .filter((item) => item.length >= 2 && item.length <= 12);
}

function unique<T>(values: T[]): T[] {
  return Array.from(new Set(values));
}

function createEmptyAgentResult(input: {
  taskId: string;
  query: string;
  dataMode: DemoDataMode;
  message: string;
  failedStage: AgentStageName;
}): Record<string, unknown> {
  return {
    schemaVersion: DEMO_SCHEMA_VERSION,
    queryId: input.taskId,
    taskId: input.taskId,
    query: input.query,
    dataMode: input.dataMode,
    degraded: true,
    degradedReason: input.message,
    failedStages: [input.failedStage],
    retryable: true,
    analysis: {
      summary: input.message,
      intent: "life_path_exploration",
      focusTags: [],
      steps: [
        {
          id: `step_${input.failedStage}`,
          label: input.message,
          status: "pending",
          evidenceIds: [],
          sourceRefs: []
        }
      ]
    },
    paths: [],
    people: [],
    personas: [],
    sections: [],
    meta: {
      sourceRefs: [],
      evidenceCount: 0,
      generatedAt: new Date().toISOString(),
      latencyMs: 0,
      totalDurationMs: 0,
      fallbackUsed: true,
      fallbackStages: [input.failedStage],
      llmStages: [],
      timedOutStages: [],
      degraded: true,
      degradedReason: input.message,
      failedStages: [input.failedStage],
      retryable: true
    }
  };
}

function isDemoSearchResponse(value: unknown): value is DemoSearchResponse {
  return (
    typeof value === "object" &&
    value !== null &&
    Array.isArray((value as DemoSearchResponse).paths) &&
    Array.isArray((value as DemoSearchResponse).people) &&
    typeof (value as DemoSearchResponse).meta === "object" &&
    (value as DemoSearchResponse).meta !== null &&
    Array.isArray((value as DemoSearchResponse).meta.sourceRefs)
  );
}

function truncateText(value: string, maxLength: number): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }

  return `${normalized.slice(0, maxLength - 3)}...`;
}

function toErrorCode(error: unknown): string {
  if (error instanceof HttpError) {
    return error.code;
  }

  if (error instanceof Error && "code" in error && typeof error.code === "string") {
    return error.code;
  }

  return "AGENT_TASK_ERROR";
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message || error.name;
  }

  return String(error);
}
