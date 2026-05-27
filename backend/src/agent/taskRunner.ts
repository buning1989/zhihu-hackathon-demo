import { assertDemoSearchGrounding } from "../guards/demoEvidence.guard.js";
import { createMockDemoSearchResponse } from "../mocks/demoSearch.mock.js";
import { selectQualitySearchItems } from "../services/demoCandidateQuality.service.js";
import { projectDemoFeedResponse } from "../services/demoFeed.service.js";
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
import {
  applyAgentExperienceSummaryResult,
  buildExperienceSummaryCandidatesFromDemoResult,
  runAgentExperienceSummary
} from "../llm/agentExperienceSummary.js";
import {
  getAgentLlmTaskTimeoutMs,
  getLlmTaskTimeoutMs
} from "../llm/llmTimeout.js";
import {
  buildFallbackSearchQueryPlan,
  buildTargetedSupplementalSearchQueries
} from "../llm/searchQueryPlan.js";
import { getProfileSignals } from "../services/userContext.service.js";
import { agentTaskStore } from "./taskStoreFactory.js";
import type { AgentTaskStore } from "./taskStore.js";
import {
  type AgentIntentResult,
  type AgentStageName,
  type AgentStageStatus,
  type AgentTaskStatus,
  type AgentTaskSnapshot
} from "./taskTypes.js";

interface SearchRecallResult {
  items: SearchItem[];
  searchQueries: DemoSearchQueryPlan[];
  failedQueries: string[];
  emptyQueries: string[];
  supplementalSearchTriggered?: boolean;
  supplementalTriggerReason?: string;
  supplementalQueries?: DemoSearchQueryPlan[];
  supplementalCandidateCount?: number;
  supplementalFailedQueries?: string[];
  supplementalEmptyQueries?: string[];
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

  retryEvidenceExtract(taskId: string): AgentTaskSnapshot {
    if (this.runningTaskIds.has(taskId)) {
      throw new HttpError(409, "STAGE_RETRY_IN_PROGRESS", "Task already has a running background stage.");
    }

    const snapshot = this.requireTask(taskId);
    if (snapshot.partialResult === undefined) {
      throw new HttpError(409, "STAGE_RETRY_REQUIRES_PARTIAL_RESULT", "Cannot retry evidence_extract before partial result is ready.");
    }

    const stage = snapshot.stages.find((item) => item.name === "evidence_extract");
    if (!stage) {
      throw new HttpError(404, "STAGE_NOT_FOUND", "Stage not found: evidence_extract");
    }

    if (stage.status === "running") {
      throw new HttpError(409, "STAGE_RETRY_IN_PROGRESS", "evidence_extract is already running.");
    }

    const attempt = stage.attempt + 1;
    const partialResult = snapshot.partialResult;
    const candidates = this.beginEvidenceExtractStage(taskId, partialResult, {
      attempt,
      retry: true,
      previousStatus: stage.status,
      taskStatus: "partial_ready",
      clearFinishedAt: true
    });
    this.markEvidenceRetryStarted(taskId);

    this.runningTaskIds.add(taskId);
    setTimeout(() => {
      void this.completeEvidenceExtractRetry(taskId, partialResult, snapshot.task.intent, candidates)
        .finally(() => {
          this.runningTaskIds.delete(taskId);
        });
    }, 0);

    return this.requireTask(taskId);
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

      const evidenceResult = await this.runEvidenceExtractStage(taskId, partialResult, intent);
      const finalResult = await this.runExperienceSummaryStage(taskId, evidenceResult);
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
    projectDemoFeedResponse(result, { hidePaths: true });
    this.finishStage(taskId, "partial_compose", "succeeded", {
      outputSummary: {
        feedItemCount: result.feedItems?.length ?? 0,
        peopleCount: result.people.length
      }
    });
    this.store.setPartialResult(taskId, result);
    this.store.patchTask(taskId, {
      status: "partial_ready",
      progress: STAGE_PROGRESS.partial_compose,
      partialReadyAt: new Date().toISOString()
    });

    const evidenceResult = await this.runEvidenceExtractStage(taskId, result, snapshot.task.intent);
    const finalResult = await this.runExperienceSummaryStage(taskId, evidenceResult);
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
    const dataMode = this.requireTask(taskId).task.dataMode;
    const failedQueries: string[] = [];
    const emptyQueries: string[] = [];
    const items: SearchItem[] = [];

    for (const [index, plan] of executableQueries.entries()) {
      try {
        const result = await searchService.search(plan.query, searchCount, { dataMode });
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
        if (dataMode === "replay" && toErrorCode(error) === "ZHIHU_REPLAY_FIXTURE_MISSING") {
          throw error;
        }
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

    let workingRecalled = recalled;
    let selected = selectQualitySearchItems(
      snapshot.task.query,
      workingRecalled.items,
      Math.min(Math.max(snapshot.task.input.count, 3), 10),
      {
        userCoreQuestion: intent.userCoreQuestion,
        focusTags: intent.focusTags,
        topicSignals: intent.topicSignals,
        searchQueries: workingRecalled.searchQueries
      }
    );
    const initialProbe = probeSelectedAdmission(snapshot, selected);
    const supplementalTriggerReason = buildSupplementalTriggerReason(initialProbe, selected);

    if (supplementalTriggerReason) {
      const supplementalQueries = buildTargetedSupplementalSearchQueries({
        originalQuery: snapshot.task.query,
        intent,
        metadata: snapshot.task.input.metadata,
        profileSignals: getProfileSignals(snapshot.task.input.userContext),
        executedQueries: workingRecalled.searchQueries,
        maxQueries: 3
      });

      if (supplementalQueries.length > 0) {
        const supplemental = await this.searchSupplementalQueries(
          taskId,
          supplementalQueries,
          workingRecalled.searchQueries.length
        );
        const mergedItems = dedupeSearchItems([...workingRecalled.items, ...supplemental.items]);
        workingRecalled = {
          items: mergedItems,
          searchQueries: [...workingRecalled.searchQueries, ...supplementalQueries],
          failedQueries: [...workingRecalled.failedQueries, ...supplemental.failedQueries],
          emptyQueries: [...workingRecalled.emptyQueries, ...supplemental.emptyQueries],
          supplementalSearchTriggered: true,
          supplementalTriggerReason,
          supplementalQueries,
          supplementalCandidateCount: supplemental.items.length,
          supplementalFailedQueries: supplemental.failedQueries,
          supplementalEmptyQueries: supplemental.emptyQueries
        };
        selected = selectQualitySearchItems(
          snapshot.task.query,
          workingRecalled.items,
          Math.min(Math.max(snapshot.task.input.count, 3), 10),
          {
            userCoreQuestion: intent.userCoreQuestion,
            focusTags: intent.focusTags,
            topicSignals: intent.topicSignals,
            searchQueries: workingRecalled.searchQueries
          }
        );
      } else {
        workingRecalled = {
          ...workingRecalled,
          supplementalSearchTriggered: false,
          supplementalTriggerReason,
          supplementalQueries: []
        };
      }
    }

    const finalProbe = probeSelectedAdmission(snapshot, selected);

    const status = selected.items.length > 0 ? "succeeded" : "failed";
    this.finishStage(taskId, "candidate_select", status, {
      outputSummary: {
        selectedCount: selected.items.length,
        assessedCount: selected.assessments.length,
        initialExperiencePeopleCount: initialProbe.experiencePeopleCount,
        finalExperiencePeopleCount: finalProbe.experiencePeopleCount,
        initialExperiencePathCount: initialProbe.experiencePathCount,
        finalExperiencePathCount: finalProbe.experiencePathCount,
        supplementalSearchTriggered: workingRecalled.supplementalSearchTriggered === true,
        supplementalTriggerReason: workingRecalled.supplementalTriggerReason,
        supplementalQueryCount: workingRecalled.supplementalQueries?.length ?? 0,
        supplementalQueries: (workingRecalled.supplementalQueries ?? []).map((item) => ({
          query: item.query,
          purpose: item.purpose
        })),
        supplementalCandidateCount: workingRecalled.supplementalCandidateCount ?? 0
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
      recalled: workingRecalled,
      intent
    };
  }

  private async searchSupplementalQueries(
    taskId: string,
    queries: DemoSearchQueryPlan[],
    roundOffset: number
  ): Promise<{
    items: SearchItem[];
    failedQueries: string[];
    emptyQueries: string[];
  }> {
    const snapshot = this.requireTask(taskId);
    const searchCount = Math.min(Math.max(snapshot.task.input.count, 5), 10);
    const dataMode = snapshot.task.dataMode;
    const items: SearchItem[] = [];
    const failedQueries: string[] = [];
    const emptyQueries: string[] = [];

    for (const [index, plan] of queries.entries()) {
      try {
        const result = await searchService.search(plan.query, searchCount, { dataMode });
        if (result.items.length === 0) {
          emptyQueries.push(plan.query);
          continue;
        }

        items.push(
          ...result.items.map((item) =>
            attachSearchPlanMetadata(item, plan, roundOffset + index)
          )
        );
      } catch (error) {
        failedQueries.push(`${plan.query}: ${toErrorMessage(error)}`);
      }
    }

    return {
      items: dedupeSearchItems(items),
      failedQueries,
      emptyQueries
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
      refillTriggered: selected.recalled.supplementalSearchTriggered === true,
      refillReason: selected.recalled.supplementalTriggerReason ?? "",
      refillQueries: selected.recalled.supplementalQueries ?? [],
      refillCandidateCount: selected.recalled.supplementalCandidateCount ?? 0,
      search: {
        dataMode: snapshot.task.dataMode,
        queriesUsed: selected.recalled.searchQueries.map((item) => item.query),
        searchRounds: selected.recalled.searchQueries.map((item, index) => ({
          query: item.query,
          roundIndex: index,
          success: !selected.recalled.failedQueries.some((failed) =>
            failed.startsWith(`${item.query}:`)
          ),
          rawResultCount: selected.recalled.items.filter((candidate) =>
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
    projectDemoFeedResponse(result, { hidePaths: true });
    this.finishStage(taskId, "partial_compose", "succeeded", {
      outputSummary: {
        feedItemCount: result.feedItems?.length ?? 0,
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
    const candidates = this.beginEvidenceExtractStage(taskId, partialResult);
    return this.completeEvidenceExtractStage(taskId, partialResult, intent, candidates);
  }

  private beginEvidenceExtractStage(
    taskId: string,
    partialResult: unknown,
    options: {
      attempt?: number;
      retry?: boolean;
      previousStatus?: AgentStageStatus;
      taskStatus?: AgentTaskStatus;
      clearFinishedAt?: boolean;
    } = {}
  ): ReturnType<typeof buildEvidenceCandidatesFromDemoResult> {
    const candidates = buildEvidenceCandidatesFromDemoResult(partialResult, 3);
    this.startStage(taskId, "evidence_extract", {
      attempt: options.attempt,
      timeoutMs: getAgentLlmTaskTimeoutMs("evidence_extract"),
      taskStatus: options.taskStatus ?? "partial_ready",
      clearFinishedAt: options.clearFinishedAt,
      inputSummary: {
        candidateCount: candidates.length,
        maxCandidates: 3,
        sourceRefs: candidates.map((candidate) => candidate.sourceRefId),
        ...(options.retry
          ? {
              retry: true,
              previousStatus: options.previousStatus
            }
          : {})
      }
    });
    return candidates;
  }

  private async completeEvidenceExtractStage(
    taskId: string,
    partialResult: unknown,
    intent: unknown,
    candidates: ReturnType<typeof buildEvidenceCandidatesFromDemoResult>
  ): Promise<unknown> {
    const snapshot = this.requireTask(taskId);
    const extraction = await runAgentEvidenceExtract({
      query: snapshot.task.query,
      intent,
      candidates,
      maxCandidates: 3
    });

    const enhancedResult = isDemoSearchResponse(partialResult)
      ? projectDemoFeedResponse(applyAgentEvidenceExtractResult(partialResult, extraction), {
          hidePaths: true
        })
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

  private async completeEvidenceExtractRetry(
    taskId: string,
    partialResult: unknown,
    intent: unknown,
    candidates: ReturnType<typeof buildEvidenceCandidatesFromDemoResult>
  ): Promise<void> {
    try {
      const evidenceResult = await this.completeEvidenceExtractStage(taskId, partialResult, intent, candidates);
      const finalResult = await this.runExperienceSummaryStage(taskId, evidenceResult);
      this.finishWithResult(taskId, finalResult);
    } catch (error) {
      const message = toErrorMessage(error);
      this.finishStage(taskId, "evidence_extract", "failed", {
        errorCode: toErrorCode(error),
        errorMessage: message,
        fallbackUsed: true,
        fallbackReason: message,
        retryable: true
      });
      this.finishWithResult(taskId, partialResult);
    }
  }

  private async runExperienceSummaryStage(
    taskId: string,
    currentResult: unknown
  ): Promise<unknown> {
    if (!isDemoSearchResponse(currentResult)) {
      this.skipOptionalEnhancementStage(
        taskId,
        "experience_summary",
        "current result is not a demo search response"
      );
      return currentResult;
    }

    const candidates = buildExperienceSummaryCandidatesFromDemoResult(currentResult, 4);
    this.startStage(taskId, "experience_summary", {
      timeoutMs: getAgentLlmTaskTimeoutMs("experience_summary"),
      taskStatus: "partial_ready",
      inputSummary: {
        candidateCount: candidates.length,
        maxCandidates: 4,
        sourceRefs: candidates.map((candidate) => candidate.sourceRefId),
        evidenceFirst: candidates.some((candidate) => Boolean(candidate.evidenceText))
      }
    });

    try {
      const snapshot = this.requireTask(taskId);
      const summary = await runAgentExperienceSummary({
        query: snapshot.task.query,
        result: currentResult,
        maxCandidates: 4
      });

      const enhancedResult = applyAgentExperienceSummaryResult(currentResult, summary);
      projectDemoFeedResponse(enhancedResult, { hidePaths: true });
      this.store.setFinalResult(taskId, enhancedResult);
      this.finishStage(taskId, "experience_summary", summary.status, {
        provider: summary.provider,
        model: summary.model,
        outputSummary: {
          llmGenerated: summary.llmGenerated,
          acceptedSummaryCount: summary.acceptedSummaryCount,
          inputCandidateCount: summary.inputCandidateCount,
          promptCandidateCount: summary.promptCandidateCount
        },
        errorCode: summary.errorCode,
        errorMessage: summary.errorMessage,
        fallbackUsed: summary.status !== "succeeded",
        fallbackReason: summary.fallbackReason,
        retryable: summary.retryable
      });

      return enhancedResult;
    } catch (error) {
      const message = toErrorMessage(error);
      this.finishStage(taskId, "experience_summary", "degraded", {
        outputSummary: {
          llmGenerated: false,
          acceptedSummaryCount: 0,
          inputCandidateCount: candidates.length,
          promptCandidateCount: 0
        },
        errorCode: toErrorCode(error),
        errorMessage: message,
        fallbackUsed: true,
        fallbackReason: message,
        retryable: false
      });
      this.store.setFinalResult(taskId, currentResult);
      return currentResult;
    }
  }

  private markEvidenceRetryStarted(taskId: string): void {
    const snapshot = this.requireTask(taskId);
    const failedStages = snapshot.task.failedStages.filter((stage) => stage !== "evidence_extract");
    const retryableStages = snapshot.task.retryableStages.filter((stage) => stage !== "evidence_extract");
    this.store.patchTask(taskId, {
      failedStages,
      retryableStages,
      retryable: retryableStages.length > 0,
      degraded: snapshot.task.degraded,
      degradedReason: "正在重试证据提取，已保留基础结果",
      degradedReasons: unique([
        ...snapshot.task.degradedReasons,
        "正在重试证据提取，已保留基础结果"
      ]),
      error: undefined
    });
  }

  private startStage(
    taskId: string,
    stageName: AgentStageName,
    options: {
      attempt?: number;
      timeoutMs?: number;
      inputSummary?: Record<string, unknown>;
      taskStatus?: AgentTaskStatus;
      clearFinishedAt?: boolean;
    } = {}
  ): void {
    this.store.patchStage(taskId, stageName, {
      status: "running",
      attempt: options.attempt ?? 1,
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
      status: options.taskStatus ?? "running",
      currentStage: stageName,
      progress: Math.min(STAGE_PROGRESS[stageName], 0.98),
      ...(options.clearFinishedAt ? { finishedAt: null } : {})
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
        ((stage.name === "evidence_extract" || stage.name === "experience_summary") &&
          stage.status === "degraded")
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

interface AdmissionProbe {
  peopleCount: number;
  experiencePeopleCount: number;
  pathCount: number;
  experiencePathCount: number;
}

const MIN_TARGET_EXPERIENCE_PEOPLE = 5;
const MIN_TARGET_EXPERIENCE_PATHS = 2;

function probeSelectedAdmission(
  snapshot: AgentTaskSnapshot,
  selected: ReturnType<typeof selectQualitySearchItems>
): AdmissionProbe {
  try {
    const response = composeRealDemoSearchResponse({
      query: snapshot.task.query,
      count: snapshot.task.input.count,
      dataMode: snapshot.task.dataMode,
      items: selected.items,
      startedAt: Date.parse(snapshot.task.createdAt),
      userContext: snapshot.task.input.userContext,
      candidateQuality: selected.candidateQuality
    });

    return {
      peopleCount: response.people.length,
      experiencePeopleCount: response.people.filter((person) => person.sampleType === "experience_sample").length,
      pathCount: response.paths.length,
      experiencePathCount: response.paths.filter((path) =>
        path.stance !== "viewpoint" && path.contentRole !== "viewpoint"
      ).length
    };
  } catch {
    const experienceItems = selected.items.filter((item) =>
      ["real_experience", "life_path", "failure_review", "decision_conflict", "alternative_solution"].includes(
        String(item.contentRole || "")
      )
    ).length;

    return {
      peopleCount: selected.items.length,
      experiencePeopleCount: experienceItems,
      pathCount: 0,
      experiencePathCount: 0
    };
  }
}

function buildSupplementalTriggerReason(
  probe: AdmissionProbe,
  selected: ReturnType<typeof selectQualitySearchItems>
): string {
  if (selected.items.length === 0) {
    return "";
  }

  const hasRelevantContent = selected.assessments.some((assessment) =>
    assessment.roughTier !== "drop" ||
    assessment.relevanceScore >= 0.45 ||
    assessment.topicHitScore >= 10
  );
  if (!hasRelevantContent) {
    return "";
  }

  const reasons: string[] = [];
  if (probe.experiencePeopleCount < MIN_TARGET_EXPERIENCE_PEOPLE) {
    reasons.push(`experiencePeople=${probe.experiencePeopleCount}<${MIN_TARGET_EXPERIENCE_PEOPLE}`);
  }
  if (probe.experiencePathCount < MIN_TARGET_EXPERIENCE_PATHS) {
    reasons.push(`experiencePaths=${probe.experiencePathCount}<${MIN_TARGET_EXPERIENCE_PATHS}`);
  }

  return reasons.length > 0 ? `filtered admission still short: ${reasons.join(", ")}` : "";
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
