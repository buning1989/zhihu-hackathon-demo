(function () {
  const App = window.LifeSampleApp || (window.LifeSampleApp = {});
  const root = document.getElementById("app");
  let requestSeq = 0;
  let capsuleTypingTimer = null;
  let entryPlaceholderTimer = null;
  let pollTimer = null;
  let pollController = null;
  let loadingStageTimer = null;
  const mockMinimumLoadingMs = 5200;
  const defaultMinimumLoadingMs = 5200;
  const defaultPollMs = 1500;
  const loadingStageIntervalMs = 900;
  const entryPlaceholderTypeMs = 90;
  const entryPlaceholderHoldTicks = 36;
  const requiredClarifyQuestions = 3;
  const maxClarifyOptions = 6;
  const entryPlaceholderExamples = [
    "为了工作长期异地恋，真的值得吗？",
    "毕业后留在大城市，还是回老家？",
    "一份稳定但消耗人的工作，要不要离开？",
    "关系里一直是我让步，还要继续吗？"
  ];
  const loadingStages = [
    {
      id: "understand",
      label: "理解处境",
      message: "正在理解你的处境"
    },
    {
      id: "search",
      label: "寻找样本",
      message: "正在寻找真实内容样本"
    },
    {
      id: "evidence",
      label: "整理片段",
      message: "正在整理公开内容片段"
    },
    {
      id: "paths",
      label: "整理样本",
      message: "正在整理样本方向"
    },
    {
      id: "people",
      label: "组织片段",
      message: "正在整理可展示内容样本"
    }
  ];

  App.loadingStages = loadingStages;

  function render() {
    const state = App.store.getState();
    document.body.dataset.page = state.page;
    document.body.dataset.phase = state.transitionPhase || state.page;

    const view = {
      entry: App.views.renderEntryView,
      feed: App.views.renderFeedView,
      reading: App.views.renderReadingView,
      book: App.views.renderBookView,
      capsule: App.views.renderCapsuleView
    }[state.page] || App.views.renderEntryView;

    root.innerHTML = [
      view(state),
      App.components.renderPeopleModal(state),
      App.components.renderReadingModal(state),
      App.components.renderChatModal(state)
    ].join("");

    syncEntryPlaceholder(state);
  }

  function syncEntryPlaceholder(state) {
    if (entryPlaceholderTimer) {
      window.clearInterval(entryPlaceholderTimer);
      entryPlaceholderTimer = null;
    }

    if (state.page !== "entry") {
      return;
    }

    const input = document.getElementById("entry-query");
    if (!input) {
      return;
    }

    let exampleIndex = 0;
    let charIndex = 0;
    let restingTicks = 0;
    input.placeholder = "";

    entryPlaceholderTimer = window.setInterval(() => {
      const example = entryPlaceholderExamples[exampleIndex];

      if (charIndex < example.length) {
        charIndex += 1;
        input.placeholder = example.slice(0, charIndex);
        return;
      }

      restingTicks += 1;
      if (restingTicks < entryPlaceholderHoldTicks) {
        return;
      }

      exampleIndex = (exampleIndex + 1) % entryPlaceholderExamples.length;
      charIndex = 0;
      restingTicks = 0;
      input.placeholder = "";
    }, entryPlaceholderTypeMs);
  }

  function currentRequestId() {
    requestSeq += 1;
    return `request-${Date.now()}-${requestSeq}`;
  }

  function isCurrentRequest(requestId) {
    return App.store.getState().search.requestId === requestId;
  }

  function wait(ms) {
    return new Promise((resolve) => {
      window.setTimeout(resolve, ms);
    });
  }

  function clampLoadingStageIndex(index) {
    const safeIndex = Number.isFinite(index) ? index : 0;
    return Math.min(Math.max(safeIndex, 0), loadingStages.length - 1);
  }

  function loadingStageAt(index) {
    return loadingStages[clampLoadingStageIndex(index)];
  }

  function applyLoadingStage(draft, index) {
    const stageIndex = clampLoadingStageIndex(index);
    draft.search.loadingStageIndex = stageIndex;
    draft.search.message = loadingStageAt(stageIndex).message;
  }

  function syncLoadingStageDom(index) {
    const stageIndex = clampLoadingStageIndex(index);
    const stage = loadingStageAt(stageIndex);
    const card = root.querySelector(".loading-card");
    if (!card) {
      return;
    }

    const title = card.querySelector(".loading-title");
    if (title) {
      title.textContent = stage.message;
    }

    card.querySelectorAll(".loading-node").forEach((node) => {
      const nodeIndex = Number(node.getAttribute("data-stage-index"));
      const isCompleted = nodeIndex < stageIndex;
      const isActive = nodeIndex === stageIndex;
      node.classList.toggle("is-completed", isCompleted);
      node.classList.toggle("is-active", isActive);
      node.classList.toggle("is-pending", nodeIndex > stageIndex);
      if (isActive) {
        node.setAttribute("aria-current", "step");
      } else {
        node.removeAttribute("aria-current");
      }
    });
  }

  function updateLoadingStageWithoutRender(index) {
    const stageIndex = clampLoadingStageIndex(index);
    App.store.updateSilent((draft) => {
      if (draft.search.status === "loading") {
        applyLoadingStage(draft, stageIndex);
      }
      return draft;
    });
    syncLoadingStageDom(stageIndex);
  }

  function normalizeLoadingStageIndex(value, fallback = 0) {
    const text = String(value || "").toLowerCase();
    if (!text) {
      return fallback < 0 ? -1 : clampLoadingStageIndex(fallback);
    }

    if (
      text.includes("grounding_guard")
      || text.includes("结果已准备好")
      || text.includes("代表人物")
      || text.includes("生成结果")
      || text.includes("succeeded")
      || text.includes("completed")
    ) {
      return 4;
    }

    if (
      text.includes("response_compose")
      || text.includes("整理路径")
      || text.includes("路径和样本")
      || text.includes("整理几种")
      || text.includes("走法")
    ) {
      return 3;
    }

    if (
      text.includes("evidence_extract")
      || text.includes("抽取证据")
      || text.includes("证据片段")
      || text.includes("检查证据")
      || text.includes("继续检查证据")
    ) {
      return 2;
    }

    if (
      text.includes("plan_search")
      || text.includes("retrieve_sources")
      || text.includes("normalize_candidates")
      || text.includes("规划检索")
      || text.includes("检索")
      || text.includes("查找")
      || text.includes("搜索")
      || text.includes("寻找")
      || text.includes("筛选")
      || text.includes("候选")
      || text.includes("相似经历")
      || text.includes("公开内容")
    ) {
      return 1;
    }

    if (
      text.includes("understand")
      || text.includes("理解")
      || text.includes("处境")
      || text.includes("问题")
      || text.includes("queued")
      || text.includes("created")
    ) {
      return 0;
    }

    return fallback < 0 ? -1 : clampLoadingStageIndex(fallback);
  }

  function loadingStageIndexFromTaskStage(stage, fallback = 0) {
    const name = stage?.name || stage?.stageName || stage?.id || "";
    return normalizeLoadingStageIndex(name || stage?.label || stage?.status, fallback);
  }

  function loadingStageIndexFromTaskStatus(taskStatus, fallback = 0) {
    if (!taskStatus) {
      return clampLoadingStageIndex(fallback);
    }

    const stages = Array.isArray(taskStatus.stages) ? taskStatus.stages : [];
    if (stages.length) {
      const sortedStages = [...stages].sort((a, b) => {
        const left = Number.isFinite(a?.stageOrder) ? a.stageOrder : 0;
        const right = Number.isFinite(b?.stageOrder) ? b.stageOrder : 0;
        return left - right;
      });
      const runningStage = sortedStages.find((stage) => ["running", "failed_retryable"].includes(stage?.status));
      if (runningStage) {
        return loadingStageIndexFromTaskStage(runningStage, fallback);
      }

      const latestTouchedStage = [...sortedStages].reverse().find((stage) =>
        !["waiting", "pending"].includes(stage?.status)
      );
      if (latestTouchedStage) {
        return loadingStageIndexFromTaskStage(latestTouchedStage, fallback);
      }
    }

    const statusStage = normalizeLoadingStageIndex(taskStatus.frontendStatus || taskStatus.status, -1);
    if (statusStage >= 0) {
      return statusStage;
    }

    const progress = Number.isFinite(taskStatus.progressPercent) ? taskStatus.progressPercent : 0;
    if (progress >= 85) {
      return 4;
    }
    if (progress >= 65) {
      return 3;
    }
    if (progress >= 42) {
      return 2;
    }
    if (progress >= 18) {
      return 1;
    }
    return clampLoadingStageIndex(fallback);
  }

  function stopLoadingStageTicker() {
    if (loadingStageTimer) {
      window.clearInterval(loadingStageTimer);
      loadingStageTimer = null;
    }
  }

  function setLoadingStage(requestId, index) {
    if (!isCurrentRequest(requestId)) {
      return;
    }

    updateLoadingStageWithoutRender(index);
  }

  function startLoadingStageTicker(requestId) {
    stopLoadingStageTicker();
    loadingStageTimer = window.setInterval(() => {
      if (!isCurrentRequest(requestId)) {
        stopLoadingStageTicker();
        return;
      }

      const state = App.store.getState();
      if (state.page !== "feed" || state.search.status !== "loading") {
        return;
      }

      const currentIndex = clampLoadingStageIndex(state.search.loadingStageIndex);
      if (currentIndex >= loadingStages.length - 1) {
        return;
      }

      updateLoadingStageWithoutRender(currentIndex + 1);
    }, loadingStageIntervalMs);
  }

  function getAnonymousId() {
    const key = "lifeSampleAnonymousId";
    const existing = window.localStorage.getItem(key);
    if (existing) {
      return existing;
    }

    const next = `frontend_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    window.localStorage.setItem(key, next);
    return next;
  }

  function buildTaskMetadata(extra = {}) {
    return {
      source: "frontend_agent_main",
      createdBy: "frontend",
      anonymousId: getAnonymousId(),
      ...extra
    };
  }

  function emptyTaskState() {
    return {
      taskId: "",
      readToken: "",
      status: "",
      frontendStatus: "",
      progressPercent: 0,
      stages: [],
      polling: false,
      error: null,
      needInput: null,
      cacheHit: false,
      reused: false,
      degraded: false,
      degradedReason: null,
      refinedFromTaskId: ""
    };
  }

  function cancelPolling() {
    if (pollTimer) {
      window.clearTimeout(pollTimer);
      pollTimer = null;
    }
    if (pollController) {
      pollController.abort();
      pollController = null;
    }
  }

  function normalizeTaskData(data) {
    return {
      taskId: data?.taskId || "",
      readToken: data?.readToken || "",
      status: data?.status || "",
      frontendStatus: data?.frontendStatus || "",
      progressPercent: Number.isFinite(data?.progressPercent) ? data.progressPercent : 0,
      stages: Array.isArray(data?.stages) ? data.stages : [],
      polling: ["queued", "running", "partial_ready"].includes(data?.status),
      error: data?.error || null,
      needInput: data?.needInput || null,
      cacheHit: Boolean(data?.cacheHit),
      reused: Boolean(data?.reused),
      degraded: Boolean(data?.degraded),
      degradedReason: data?.degradedReason || null,
      refinedFromTaskId: data?.refinedFromTaskId || ""
    };
  }

  function applyTaskState(draft, data, overrides = {}) {
    const normalized = normalizeTaskData(data);
    draft.task = {
      ...draft.task,
      ...normalized,
      readToken: normalized.readToken || draft.task.readToken || "",
      ...overrides
    };
  }

  function setTaskError(requestId, error) {
    if (!isCurrentRequest(requestId)) {
      return;
    }

    stopLoadingStageTicker();
    const code = error?.code || error?.errorCode || "AGENT_FRONTEND_ERROR";
    const message = error?.message || error?.errorMessage || "任务处理失败，请稍后再试。";
    App.store.update((draft) => {
      draft.page = "feed";
      draft.search.status = "error";
      draft.search.message = "";
      draft.search.error = message;
      draft.search.clarifyOpen = false;
      draft.search.clarifyCard = null;
      draft.search.clarificationStage = null;
      draft.task = {
        ...draft.task,
        polling: false,
        error: {
          errorCode: code,
          errorMessage: message
        }
      };
      draft.transitionPhase = "feed";
      return draft;
    });
  }

  function transitionTimings() {
    const reducedMotion = window.matchMedia
      && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reducedMotion) {
      return {
        clarifyEnter: 0,
        entryExit: 0,
        loadingEnter: 0,
        loadingExit: 0,
        feedEnter: 0
      };
    }
    return {
      clarifyEnter: 420,
      entryExit: 320,
      loadingEnter: 380,
      loadingExit: 320,
      feedEnter: 480
    };
  }

  function setTransitionPhase(phase) {
    App.store.update((draft) => {
      draft.transitionPhase = phase;
      return draft;
    });
  }

  async function finishClarifyEnter(requestId) {
    const timings = transitionTimings();
    if (timings.clarifyEnter > 0) {
      await wait(timings.clarifyEnter);
    }

    if (!isCurrentRequest(requestId)) {
      return;
    }

    const state = App.store.getState();
    if (state.page === "entry" && state.transitionPhase === "clarifyEntering") {
      setTransitionPhase("clarifying");
    }
  }

  function shouldUseMockFallback(error) {
    const fallbackCodes = new Set([
      "BACKEND_UNAVAILABLE",
      "404",
      "405",
      "501"
    ]);
    return Boolean(
      fallbackCodes.has(String(error?.code || error?.errorCode || ""))
      || [0, 404, 405, 501].includes(Number(error?.status || 0))
    );
  }

  function hasClarifyAnswers(answers) {
    return Object.values(answers || {}).some(Boolean);
  }

  function getLocalClarifyQuestions() {
    return App.mockData.clarifyQuestions.slice(0, requiredClarifyQuestions);
  }

  function normalizeClarifyingCard(card) {
    const raw = card && typeof card === "object" ? card : {};
    const questions = normalizeClarifyQuestions(raw.questions);
    return {
      show: Boolean(raw.show),
      title: String(raw.title || "补充条件，让样本更贴近"),
      description: String(raw.description || "这些补充条件只用于匹配更贴近的经历样本，选几项就好。"),
      questions,
      primaryActionText: String(raw.primaryActionText || "用补充条件匹配"),
      skipActionText: String(raw.skipActionText || "跳过，先看样本")
    };
  }

  function normalizeClarifyQuestions(questions) {
    const rawQuestions = Array.isArray(questions) ? questions : [];
    const normalizedQuestions = rawQuestions.map((question) => {
      const id = String(question.id || question.key || "").trim();
      const options = Array.isArray(question.options)
        ? question.options.map((option) => {
          const optionId = String(option.id || option.value || option.label || "").trim();
          return {
            id: optionId,
            label: String(option.label || option.text || optionId)
          };
        }).filter((option) => option.id && option.label)
        : [];
      return {
        id,
        text: String(question.text || question.label || question.title || id),
        type: String(question.type || "single_select"),
        required: question.required !== false,
        options: normalizeClarifyOptions(id, options)
      };
    }).filter((question) => question.id && question.text && question.options.length > 0);

    return uniqueClarifyQuestions([
      ...normalizedQuestions,
      ...defaultClarifyQuestions()
    ]).slice(0, requiredClarifyQuestions);
  }

  function uniqueClarifyQuestions(questions) {
    const seen = new Set();
    return questions.filter((question) => {
      if (!question.id || seen.has(question.id)) {
        return false;
      }
      seen.add(question.id);
      return true;
    });
  }

  function normalizeClarifyOptions(questionId, options) {
    const seen = new Set();
    const sourceOptions = options.length ? options : defaultClarifyOptions(questionId);
    const normalizedOptions = sourceOptions.filter((option) => {
      if (!option.id || !option.label || seen.has(option.id)) {
        return false;
      }
      seen.add(option.id);
      return true;
    });
    return normalizedOptions.slice(0, maxClarifyOptions);
  }

  function defaultClarifyOptions(questionId) {
    const defaults = {
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
    return defaults[questionId] || [
      { id: "similar", label: "相似经历" },
      { id: "resolved", label: "已经走出" },
      { id: "tradeoff", label: "代价边界" }
    ];
  }

  function defaultClarifyQuestions() {
    return [
      {
        id: "current_state",
        text: "你现在更接近哪种状态？",
        type: "single_select",
        required: true,
        options: defaultClarifyOptions("current_state")
      },
      {
        id: "main_constraint",
        text: "最需要先考虑什么？",
        type: "single_select",
        required: true,
        options: defaultClarifyOptions("main_constraint")
      },
      {
        id: "sample_preference",
        text: "更想先参考哪类样本？",
        type: "single_select",
        required: true,
        options: defaultClarifyOptions("sample_preference")
      }
    ];
  }

  function shouldShowDemoClarification(result) {
    const card = normalizeClarifyingCard(result?.clarifyingCard);
    return Boolean(
      card.questions.length > 0 &&
      (card.show || result?.clarificationStage?.needClarification)
    );
  }

  async function showClarifyQuestions({ questions, card = null, stage = null, requestId, pageBeforeSubmit, taskStatus = null, source = "backend" }) {
    if (!isCurrentRequest(requestId)) {
      return;
    }

    const normalizedCard = card ? normalizeClarifyingCard(card) : null;
    const normalizedQuestions = normalizeClarifyQuestions(
      questions || normalizedCard?.questions || []
    );
    const resolvedCard = normalizedCard
      ? {
        ...normalizedCard,
        questions: normalizedQuestions
      }
      : null;

    stopLoadingStageTicker();
    App.store.update((draft) => {
      draft.page = pageBeforeSubmit === "entry" ? "entry" : "feed";
      draft.search.status = "clarify";
      draft.search.message = "";
      draft.search.error = "";
      draft.search.clarifyQuestions = normalizedQuestions;
      draft.search.clarifyAnswers = {};
      draft.search.clarifyCard = resolvedCard;
      draft.search.clarificationStage = stage || null;
      draft.search.clarifyOpen = true;
      draft.search.clarifySource = source;
      if (source === "local") {
        draft.search.hasShownInitialClarify = true;
        draft.search.initialClarifySkipped = false;
      }
      if (taskStatus) {
        applyTaskState(draft, taskStatus, {
          polling: false,
          needInput: taskStatus.needInput || null
        });
      }
      draft.transitionPhase = draft.page === "entry" ? "clarifyEntering" : draft.transitionPhase;
      return draft;
    });

    if (pageBeforeSubmit === "entry") {
      await finishClarifyEnter(requestId);
    }
  }

  async function startLoadingView(requestId, message, taskStatus = null, taskOverrides = {}) {
    const timings = transitionTimings();
    const currentState = App.store.getState();
    if (currentState.page === "entry") {
      App.store.update((draft) => {
        draft.search.requestId = requestId;
        draft.transitionPhase = "entryExiting";
        return draft;
      });
      if (timings.entryExit > 0) {
        await wait(timings.entryExit);
      }
      if (!isCurrentRequest(requestId)) {
        return null;
      }
    }

    App.store.update((draft) => {
      draft.page = "feed";
      draft.search.status = "loading";
      applyLoadingStage(
        draft,
        taskStatus?.status === "succeeded"
          ? 0
          : loadingStageIndexFromTaskStatus(taskStatus, normalizeLoadingStageIndex(message, 0))
      );
      draft.search.requestId = requestId;
      draft.search.error = "";
      draft.search.clarifyOpen = false;
      draft.search.clarifyCard = null;
      draft.search.clarificationStage = null;
      if (taskStatus) {
        applyTaskState(draft, taskStatus, taskOverrides);
      }
      draft.transitionPhase = "loadingEntering";
      return draft;
    });

    const loadingStartedAt = Date.now();
    startLoadingStageTicker(requestId);
    if (timings.loadingEnter > 0) {
      await wait(timings.loadingEnter);
    }
    if (!isCurrentRequest(requestId)) {
      return null;
    }

    setTransitionPhase("loading");
    return loadingStartedAt;
  }

  async function finishLoadingWithResult({ requestId, loadingStartedAt, updateDraft }) {
    const timings = transitionTimings();
    const remainingLoadingMs = defaultMinimumLoadingMs - (Date.now() - loadingStartedAt);
    if (remainingLoadingMs > 0) {
      await wait(remainingLoadingMs);
    }
    if (!isCurrentRequest(requestId)) {
      return;
    }

    setLoadingStage(requestId, loadingStages.length - 1);
    stopLoadingStageTicker();
    setTransitionPhase("loadingExiting");
    if (timings.loadingExit > 0) {
      await wait(timings.loadingExit);
    }
    if (!isCurrentRequest(requestId)) {
      return;
    }

    App.store.update((draft) => {
      updateDraft(draft);
      draft.search.status = "loaded";
      draft.search.message = "";
      draft.search.error = "";
      draft.search.clarifyOpen = false;
      draft.search.clarifyCard = null;
      draft.search.clarificationStage = null;
      draft.activePathId = "all";
      draft.selectedPersonId = null;
      draft.expandedPersonId = null;
      draft.expandedExperiencePersonId = null;
      draft.expandedOriginalPersonId = null;
      draft.inlineChatPersonId = null;
      draft.inlineChatBlockedPersonId = null;
      draft.inlineMessagePersonId = null;
      draft.transitionPhase = "feedEntering";
      return draft;
    });

    if (timings.feedEnter > 0) {
      await wait(timings.feedEnter);
    }
    if (!isCurrentRequest(requestId)) {
      return;
    }

    setTransitionPhase("feed");
  }

  async function fallbackToMockSearch(query, requestId, answers = {}, options = {}) {
    if (!isCurrentRequest(requestId)) {
      return;
    }

    const pageBeforeSubmit = options.pageBeforeSubmit || App.store.getState().page;
    const shouldAskClarify = !options.skipClarify && Object.keys(answers || {}).length === 0;
    if (shouldAskClarify) {
      const preparation = await App.MockApi.prepareSearch({ query, answers });
      if (!isCurrentRequest(requestId)) {
        return;
      }
      if (preparation.status === "needs_clarification") {
        await showClarifyQuestions({
          questions: preparation.questions,
          requestId,
          pageBeforeSubmit
        });
        return;
      }
    }

    await loadResults(query, requestId, answers);
  }

  async function showInitialClarify(requestId, pageBeforeSubmit) {
    await showClarifyQuestions({
      questions: getLocalClarifyQuestions(),
      requestId,
      pageBeforeSubmit,
      source: "local"
    });
  }

  async function submitSearch(query, options = {}) {
    const cleanQuery = String(query || "").trim();
    if (!cleanQuery) {
      return;
    }
    cancelPolling();
    stopLoadingStageTicker();

    const state = App.store.getState();
    const pageBeforeSubmit = state.page;
    const requestId = currentRequestId();
    const clarifyAnswers = options.keepClarify ? state.search.clarifyAnswers : {};

    App.store.update((draft) => {
      draft.page = pageBeforeSubmit === "entry" ? "entry" : "feed";
      draft.query = cleanQuery;
      draft.pendingQuery = cleanQuery;
      draft.activePathId = "all";
      draft.modal = { type: null, pathId: null, personId: null, panel: null };
      draft.result = null;
      draft.selectedPersonId = null;
      draft.expandedPersonId = null;
      draft.expandedExperiencePersonId = null;
      draft.expandedOriginalPersonId = null;
      draft.inlineChatPersonId = null;
      draft.inlineChatBlockedPersonId = null;
      draft.inlineMessagePersonId = null;
      draft.search = {
        status: "preparing",
        message: "",
        loadingStageIndex: 0,
        requestId,
        clarifyQuestions: [],
        clarifyAnswers,
        clarifyCard: null,
        clarificationStage: null,
        clarifyOpen: false,
        hasShownInitialClarify: false,
        initialClarifySkipped: Boolean(options.skipClarify),
        clarifySource: "",
        error: ""
      };
      draft.transitionPhase = pageBeforeSubmit === "entry" ? "entry" : draft.transitionPhase;
      draft.task = emptyTaskState();
      return draft;
    });

    await loadResults(cleanQuery, requestId, clarifyAnswers, {
      pageBeforeSubmit,
      allowClarification: !options.skipClarify
    });
  }

  async function startBackendTask(query, requestId, options = {}) {
    try {
      const started = await App.Api.createAgentTask({
        query,
        metadata: buildTaskMetadata(options.metadata || {})
      });

      if (!isCurrentRequest(requestId)) {
        return;
      }

      await handleTaskUpdate(started, requestId, {
        pageBeforeSubmit: options.pageBeforeSubmit,
        query,
        answers: options.answers || {},
        skipClarify: Boolean(options.skipClarify || options.metadata?.skipNeedInput || options.metadata?.hasShownInitialClarify),
        start: started,
        readToken: started.readToken || ""
      });
    } catch (error) {
      if (shouldUseMockFallback(error)) {
        await fallbackToMockSearch(query, requestId, options.answers || {}, {
          pageBeforeSubmit: options.pageBeforeSubmit,
          skipClarify: Boolean(options.skipClarify || options.metadata?.skipNeedInput || options.metadata?.hasShownInitialClarify)
        });
        return;
      }
      setTaskError(requestId, error);
    }
  }

  async function handleTaskUpdate(taskData, requestId, context = {}) {
    const normalizedNeedInput = App.adapters.normalizeNeedInput(taskData.needInput);
    const taskStatus = {
      ...taskData,
      needInput: normalizedNeedInput || taskData.needInput
    };

    if (taskData.status === "need_input") {
      await showClarifyQuestions({
        questions: normalizedNeedInput?.questions || [],
        requestId,
        pageBeforeSubmit: context.pageBeforeSubmit,
        taskStatus
      });
      return;
    }

    if (taskData.status === "failed") {
      setTaskError(requestId, taskData.error || {
        code: "AGENT_TASK_FAILED",
        message: "任务失败，请稍后再试。"
      });
      return;
    }

    if (taskData.status === "succeeded") {
      await completeBackendTask(taskData.taskId, taskStatus, requestId, context);
      return;
    }

    if (!context.loadingStartedAt) {
      context.loadingStartedAt = await startLoadingView(
        requestId,
        taskData.frontendStatus || "正在从公开内容里找相关样本",
        taskStatus,
        {
          polling: true,
          cacheHit: Boolean(taskData.cacheHit || context.start?.cacheHit),
          reused: Boolean(taskData.reused || context.start?.reused)
        }
      );
      if (!context.loadingStartedAt) {
        return;
      }
    } else {
      App.store.updateSilent((draft) => {
        const nextStageIndex = loadingStageIndexFromTaskStatus(taskStatus, draft.search.loadingStageIndex);
        draft.search.status = "loading";
        applyLoadingStage(draft, Math.max(clampLoadingStageIndex(draft.search.loadingStageIndex), nextStageIndex));
        draft.search.error = "";
        draft.search.clarifyOpen = false;
        draft.search.clarifyCard = null;
        draft.search.clarificationStage = null;
        applyTaskState(draft, taskStatus, {
          polling: true,
          cacheHit: Boolean(taskData.cacheHit || context.start?.cacheHit),
          reused: Boolean(taskData.reused || context.start?.reused)
        });
        draft.transitionPhase = draft.transitionPhase === "feedEntering"
          ? draft.transitionPhase
          : "loading";
        return draft;
      });
      syncLoadingStageDom(App.store.getState().search.loadingStageIndex);
    }

    schedulePoll(taskData.taskId, requestId, taskData.pollAfterMs, context);
  }

  function schedulePoll(taskId, requestId, pollAfterMs, context = {}) {
    cancelPolling();
    const waitMs = Number.isFinite(pollAfterMs) && pollAfterMs > 0
      ? Math.min(Math.max(pollAfterMs, 500), 4000)
      : defaultPollMs;

    pollTimer = window.setTimeout(() => {
      pollTimer = null;
      pollBackendTask(taskId, requestId, context);
    }, waitMs);
  }

  async function pollBackendTask(taskId, requestId, context = {}) {
    if (!isCurrentRequest(requestId)) {
      return;
    }

    pollController = new AbortController();
    try {
      const status = await App.Api.getAgentTaskStatus(taskId, {
        signal: pollController.signal,
        readToken: context.readToken || App.store.getState().task.readToken
      });
      pollController = null;

      if (!isCurrentRequest(requestId)) {
        return;
      }

      await handleTaskUpdate(status, requestId, context);
    } catch (error) {
      pollController = null;
      if (error?.name === "AbortError") {
        return;
      }
      if (shouldUseMockFallback(error)) {
        await fallbackToMockSearch(context.query || App.store.getState().query, requestId, context.answers || {}, {
          pageBeforeSubmit: context.pageBeforeSubmit,
          skipClarify: true
        });
        return;
      }
      setTaskError(requestId, error);
    }
  }

  async function completeBackendTask(taskId, taskStatus, requestId, context = {}) {
    cancelPolling();
    try {
      if (!context.loadingStartedAt) {
        context.loadingStartedAt = await startLoadingView(
          requestId,
          taskStatus.frontendStatus || "正在从公开内容里找相关样本",
          taskStatus,
          {
            polling: false,
            cacheHit: Boolean(taskStatus.cacheHit || context.start?.cacheHit),
            reused: Boolean(taskStatus.reused || context.start?.reused)
          }
        );
        if (!context.loadingStartedAt) {
          return;
        }
      }

      const result = await App.Api.readAgentResult(taskId, {
        ...taskStatus,
        cacheHit: Boolean(taskStatus.cacheHit || context.start?.cacheHit),
        reused: Boolean(taskStatus.reused || context.start?.reused)
      }, {
        readToken: context.readToken || taskStatus.readToken || App.store.getState().task.readToken
      });

      if (!isCurrentRequest(requestId)) {
        return;
      }

      await finishLoadingWithResult({
        requestId,
        loadingStartedAt: context.loadingStartedAt,
        updateDraft: (draft) => {
          draft.page = "feed";
          draft.result = result;
          applyTaskState(draft, taskStatus, {
            polling: false,
            degraded: Boolean(result.degraded || result.meta?.degraded || taskStatus.degraded),
            degradedReason: result.degradedReason || result.meta?.degradedReason || taskStatus.degradedReason || null,
            cacheHit: Boolean(result.meta?.cacheHit || taskStatus.cacheHit || context.start?.cacheHit),
            reused: Boolean(result.meta?.reused || taskStatus.reused || context.start?.reused)
          });
        }
      });
    } catch (error) {
      if (error?.code === "RESULT_NOT_READY") {
        schedulePoll(taskId, requestId, defaultPollMs, context);
        return;
      }
      if (shouldUseMockFallback(error)) {
        await fallbackToMockSearch(context.query || App.store.getState().query, requestId, context.answers || {}, {
          pageBeforeSubmit: context.pageBeforeSubmit,
          skipClarify: true
        });
        return;
      }
      setTaskError(requestId, error);
    }
  }

  async function loadResults(query, requestId, answers, options = {}) {
    const timings = transitionTimings();
    const currentState = App.store.getState();
    const pageBeforeSubmit = options.pageBeforeSubmit || currentState.page;
    const shouldCheckClarificationBeforeLoading =
      pageBeforeSubmit === "entry" &&
      options.allowClarification !== false &&
      !hasClarifyAnswers(answers);
    let response = null;

    if (shouldCheckClarificationBeforeLoading) {
      try {
        response = await App.Api.search({
          query,
          answers
        });
      } catch (error) {
        setTaskError(requestId, error);
        return;
      }

      if (!isCurrentRequest(requestId)) {
        return;
      }

      const result = response.data;
      if (shouldShowDemoClarification(result)) {
        await showClarifyQuestions({
          card: result.clarifyingCard,
          stage: result.clarificationStage,
          requestId,
          pageBeforeSubmit,
          source: "backend_demo"
        });
        return;
      }
    }

    if (currentState.page === "entry") {
      App.store.update((draft) => {
        draft.search.requestId = requestId;
        draft.transitionPhase = "entryExiting";
        return draft;
      });
      if (timings.entryExit > 0) {
        await wait(timings.entryExit);
      }
      if (!isCurrentRequest(requestId)) {
        return;
      }
    }

    App.store.update((draft) => {
      draft.page = "feed";
      draft.search.status = "loading";
      applyLoadingStage(draft, 0);
      draft.search.requestId = requestId;
      draft.search.clarifyOpen = false;
      draft.search.clarifyCard = null;
      draft.search.clarificationStage = null;
      draft.transitionPhase = "loadingEntering";
      return draft;
    });

    const loadingStartedAt = Date.now();
    startLoadingStageTicker(requestId);
    const responsePromise = response
      ? Promise.resolve(response)
      : App.Api.search({
        query,
        answers
      });

    if (timings.loadingEnter > 0) {
      await wait(timings.loadingEnter);
    }

    if (!isCurrentRequest(requestId)) {
      return;
    }

    setTransitionPhase("loading");
    try {
      response = await responsePromise;
    } catch (error) {
      setTaskError(requestId, error);
      return;
    }

    if (!isCurrentRequest(requestId)) {
      return;
    }

    const result = response.data;
    if (options.allowClarification !== false && shouldShowDemoClarification(result)) {
      await showClarifyQuestions({
        card: result.clarifyingCard,
        stage: result.clarificationStage,
        requestId,
        pageBeforeSubmit,
        source: "backend_demo"
      });
      return;
    }

    const minimumLoadingMs = result?.dataMode === "mock" ? mockMinimumLoadingMs : defaultMinimumLoadingMs;
    const remainingLoadingMs = minimumLoadingMs - (Date.now() - loadingStartedAt);
    if (remainingLoadingMs > 0) {
      await wait(remainingLoadingMs);
    }

    if (!isCurrentRequest(requestId)) {
      return;
    }

    setLoadingStage(requestId, loadingStages.length - 1);
    stopLoadingStageTicker();
    setTransitionPhase("loadingExiting");
    if (timings.loadingExit > 0) {
      await wait(timings.loadingExit);
    }

    if (!isCurrentRequest(requestId)) {
      return;
    }

    App.store.update((draft) => {
      draft.page = "feed";
      draft.result = result;
      draft.search.status = "loaded";
      draft.search.message = "";
      draft.search.error = "";
      draft.search.clarifyOpen = false;
      draft.search.clarifyCard = result?.clarifyingCard || null;
      draft.search.clarificationStage = result?.clarificationStage || null;
      draft.activePathId = "all";
      draft.selectedPersonId = null;
      draft.expandedPersonId = null;
      draft.expandedExperiencePersonId = null;
      draft.expandedOriginalPersonId = null;
      draft.inlineChatPersonId = null;
      draft.inlineChatBlockedPersonId = null;
      draft.inlineMessagePersonId = null;
      draft.transitionPhase = "feedEntering";
      return draft;
    });

    if (timings.feedEnter > 0) {
      await wait(timings.feedEnter);
    }

    if (!isCurrentRequest(requestId)) {
      return;
    }

    setTransitionPhase("feed");
  }

  async function continueAfterClarify(options = {}) {
    const state = App.store.getState();
    const answers = state.search.clarifyAnswers || {};
    const nextAnswers = options.skip ? {} : answers;
    const requestId = currentRequestId();
    const clarifySource = state.search.clarifySource || "local";
    const isInitialClarify = clarifySource === "local";
    const clarifyMetadata = {
      clarifySource,
      initialClarifySkipped: isInitialClarify ? Boolean(options.skip) : Boolean(state.search.initialClarifySkipped),
      hasShownInitialClarify: Boolean(state.search.hasShownInitialClarify || isInitialClarify)
    };

    App.store.update((draft) => {
      draft.search.requestId = requestId;
      draft.search.error = "";
      draft.search.initialClarifySkipped = clarifyMetadata.initialClarifySkipped;
      draft.search.hasShownInitialClarify = clarifyMetadata.hasShownInitialClarify;
      if (draft.page !== "entry") {
        draft.search.status = "loading";
        applyLoadingStage(draft, 0);
        draft.search.clarifyOpen = false;
      }
      return draft;
    });
    if (state.page !== "entry") {
      startLoadingStageTicker(requestId);
    }

    await loadResults(state.query || state.pendingQuery, requestId, nextAnswers, {
      pageBeforeSubmit: state.page,
      allowClarification: !options.skip
    });
  }

  async function mockLogin() {
    const state = App.store.getState();
    if (state.auth.isLoggingIn) {
      return;
    }

    App.store.update((draft) => {
      draft.auth.isLoggingIn = true;
      return draft;
    });

    const response = await App.Api.login();
    App.store.update((draft) => {
      draft.auth.loggedIn = true;
      draft.auth.needsLogin = false;
      draft.auth.isLoggingIn = false;
      draft.auth.status = "ready";
      draft.auth.error = "";
      draft.auth.profile = response.profile;
      draft.auth.me = response.profile;
      return draft;
    });

    const nextQuery = state.pendingQuery || state.query;
    if (nextQuery) {
      await submitSearch(nextQuery);
    }
  }

  async function mockLogout() {
    cancelPolling();
    stopLoadingStageTicker();
    App.store.update((draft) => {
      draft.page = "entry";
      draft.query = "";
      draft.pendingQuery = "";
      draft.auth.loggedIn = false;
      draft.auth.needsLogin = false;
      draft.auth.isLoggingIn = false;
      draft.auth.status = "ready";
      draft.auth.error = "";
      draft.auth.profile = null;
      draft.auth.me = null;
      draft.search.status = "idle";
      draft.search.message = "";
      draft.search.loadingStageIndex = 0;
      draft.search.clarifyOpen = false;
      draft.search.hasShownInitialClarify = false;
      draft.search.initialClarifySkipped = false;
      draft.search.clarifyCard = null;
      draft.search.clarificationStage = null;
      draft.search.clarifySource = "";
      draft.search.error = "";
      draft.task = emptyTaskState();
      draft.transitionPhase = "entry";
      draft.railExpanded = {
        recentlyViewed: false,
        interactions: false
      };
      draft.selectedPersonId = null;
      draft.expandedPersonId = null;
      draft.expandedExperiencePersonId = null;
      draft.expandedOriginalPersonId = null;
      draft.inlineChatPersonId = null;
      draft.inlineChatBlockedPersonId = null;
      draft.inlineMessagePersonId = null;
      draft.modal = { type: null, pathId: null, personId: null, panel: null };
      return draft;
    });
  }

  function answerClarify(questionId, optionId) {
    App.store.update((draft) => {
      draft.search.clarifyAnswers[questionId] = optionId;
      return draft;
    });
  }

  function clearInlinePanels(draft) {
    draft.expandedPersonId = null;
    draft.expandedExperiencePersonId = null;
    draft.expandedOriginalPersonId = null;
    draft.inlineChatPersonId = null;
    draft.inlineChatBlockedPersonId = null;
    draft.inlineMessagePersonId = null;
    draft.modal = { type: null, pathId: null, personId: null, panel: null };
  }

  function ensurePersonVisible(draft, person) {
    if (draft.activePathId !== "all" && draft.activePathId !== person.pathId) {
      draft.activePathId = person.pathId || "all";
    }
  }

  function addRecentViewToDraft(draft, personId) {
    draft.recentlyViewed = [
      {
        personId,
        viewedAt: "刚刚"
      },
      ...(draft.recentlyViewed || []).filter((item) => item.personId !== personId)
    ].slice(0, 10);
  }

  function canChatWithPerson(person) {
    return !person?.isProductionSample && Boolean(
      person?.displayCanChat
      || person?.aiPersona?.canChat
      || (person?.aiPersona?.enabled && person?.aiPersona?.personaId)
    );
  }

  function initialChatMessage(person) {
    return {
      id: `assistant-${Date.now()}`,
      role: "assistant",
      text: `我只能沿着${person.name}留下的这段公开内容说说看。你可以问它是怎么开始、怎么收尾，或中间最难的地方。`
    };
  }

  function markInlineChatOpened(draft, personId) {
    draft.interactions.unshift({
      id: `interaction-${Date.now()}`,
      type: "chat",
      personId,
      content: "你打开了这段内容对话",
      reply: "可以继续问这段内容背后的细节。",
      createdAt: "刚刚"
    });
    draft.interactions = draft.interactions.slice(0, 10);
  }

  function setPath(pathId) {
    App.store.update((draft) => {
      draft.activePathId = pathId;
      clearInlinePanels(draft);
      return draft;
    });
  }

  function openClarify() {
    App.store.update((draft) => {
      draft.search.clarifyQuestions = draft.search.clarifyQuestions.length
        ? draft.search.clarifyQuestions
        : App.mockData.clarifyQuestions.slice(0, requiredClarifyQuestions);
      draft.search.clarifyOpen = true;
      draft.search.clarifySource = "local";
      draft.search.hasShownInitialClarify = true;
      return draft;
    });
  }

  function toggleExperience(personId) {
    App.store.update((draft) => {
      draft.expandedPersonId = null;
      draft.expandedExperiencePersonId = draft.expandedExperiencePersonId === personId ? null : personId;
      return draft;
    });
  }

  function openPeople(pathId) {
    App.store.update((draft) => {
      draft.modal = { type: "people", pathId, personId: null, panel: null };
      return draft;
    });
  }

  function closeModal() {
    App.store.update((draft) => {
      draft.modal = { type: null, pathId: null, personId: null, panel: null };
      return draft;
    });
  }

  function openReading(personId) {
    App.store.addRecentView(personId);
    App.store.update((draft) => {
      draft.page = "reading";
      draft.selectedPersonId = personId;
      draft.expandedPersonId = null;
      draft.modal = { type: null, pathId: null, personId: null, panel: null };
      return draft;
    });
  }

  function openReadingModal(personId, panel = null) {
    const person = App.store.findPerson(personId);
    if (!person) {
      return;
    }

    App.store.update((draft) => {
      draft.selectedPersonId = personId;
      if (draft.page === "feed") {
        ensurePersonVisible(draft, person);
      }
      draft.modal = { type: "reading", pathId: null, personId, panel };
      draft.expandedOriginalPersonId = null;
      draft.expandedExperiencePersonId = null;
      draft.inlineChatPersonId = null;
      draft.inlineChatBlockedPersonId = null;
      draft.inlineMessagePersonId = null;
      addRecentViewToDraft(draft, personId);
      return draft;
    });
  }

  function setInlineChat(personId, forceOpen = false) {
    const person = App.store.findPerson(personId);
    if (!person) {
      return;
    }

    App.store.update((draft) => {
      const panelOpen = draft.modal.type === "reading"
        && draft.modal.personId === personId
        && draft.modal.panel === "chat";
      const isOpening = forceOpen || !panelOpen;
      draft.selectedPersonId = personId;
      if (draft.page === "feed") {
        ensurePersonVisible(draft, person);
      }
      draft.modal = { type: "reading", pathId: null, personId, panel: null };
      draft.expandedOriginalPersonId = null;
      draft.expandedExperiencePersonId = null;
      draft.inlineChatPersonId = null;
      draft.inlineChatBlockedPersonId = null;
      draft.inlineMessagePersonId = null;

      if (!isOpening) {
        return draft;
      }

      if (!canChatWithPerson(person)) {
        draft.modal.panel = "chat-blocked";
        addRecentViewToDraft(draft, personId);
        return draft;
      }

      if (!draft.chatThreads[personId]) {
        draft.chatThreads[personId] = [initialChatMessage(person)];
      }
      draft.modal.panel = "chat";
      addRecentViewToDraft(draft, personId);
      markInlineChatOpened(draft, personId);
      return draft;
    });
  }

  function toggleInlineChat(personId) {
    setInlineChat(personId, false);
  }

  function openInlineChat(personId) {
    setInlineChat(personId, true);
  }

  function toggleInlineMessage(personId) {
    const person = App.store.findPerson(personId);
    if (!person) {
      return;
    }

    App.store.update((draft) => {
      const panelOpen = draft.modal.type === "reading"
        && draft.modal.personId === personId
        && draft.modal.panel === "message";
      const isOpening = !panelOpen;
      draft.selectedPersonId = personId;
      if (draft.page === "feed") {
        ensurePersonVisible(draft, person);
      }
      draft.modal = { type: "reading", pathId: null, personId, panel: isOpening ? "message" : null };
      draft.expandedOriginalPersonId = null;
      draft.expandedExperiencePersonId = null;
      draft.inlineChatPersonId = null;
      draft.inlineChatBlockedPersonId = null;
      draft.inlineMessagePersonId = null;
      if (isOpening) {
        addRecentViewToDraft(draft, personId);
      }
      return draft;
    });
  }

  function openChat(personId) {
    openInlineChat(personId);
  }

  function toggleRail(section) {
    if (!["recentlyViewed", "interactions"].includes(section)) {
      return;
    }
    App.store.update((draft) => {
      draft.railExpanded = draft.railExpanded || {};
      draft.railExpanded[section] = !draft.railExpanded[section];
      return draft;
    });
  }

  async function sendChatMessage(personId, message) {
    const cleanMessage = String(message || "").trim();
    if (!cleanMessage) {
      return;
    }

    App.store.update((draft) => {
      const thread = draft.chatThreads[personId] || [];
      thread.push({
        id: `user-${Date.now()}`,
        role: "user",
        text: cleanMessage
      });
      draft.chatThreads[personId] = thread;
      return draft;
    });

    const stateAfterUser = App.store.getState();
    const turn = (stateAfterUser.chatThreads[personId] || []).filter((messageItem) => messageItem.role === "user").length;
    const reply = await App.Api.sendPersonaMessage({
      personId,
      message: cleanMessage,
      turn
    });

    App.store.update((draft) => {
      draft.chatThreads[personId].push(reply);
      draft.interactions.unshift({
        id: `interaction-${Date.now()}`,
        type: "chat",
        personId,
        content: `你问：${cleanMessage}`,
        reply: `经验回声：${reply.text}`,
        createdAt: "刚刚"
      });
      draft.interactions = draft.interactions.slice(0, 10);
      return draft;
    });
  }

  function addBook(personId) {
    App.store.addToBook(personId);
  }

  function saveNote(personId, note) {
    const cleanNote = String(note || "").trim();
    if (!cleanNote) {
      return;
    }
    App.store.addInteraction({
      type: "note",
      personId,
      content: `留言：${cleanNote}`,
      reply: "",
      createdAt: "刚刚"
    });
  }

  function toggleBookStatus(personId) {
    App.store.update((draft) => {
      const item = draft.bookItems.find((bookItem) => bookItem.personId === personId);
      if (item) {
        item.status = item.status === "done" ? "reading" : "done";
      }
      return draft;
    });
  }

  function selectCapsulePrompt(prompt) {
    App.store.update((draft) => {
      draft.capsule.selectedPrompt = prompt;
      return draft;
    });
  }

  function startCapsuleTyping(message) {
    if (capsuleTypingTimer) {
      window.clearInterval(capsuleTypingTimer);
    }
    let index = 0;
    capsuleTypingTimer = window.setInterval(() => {
      index += 1;
      App.store.update((draft) => {
        draft.capsule.typedText = message.slice(0, index);
        if (index >= message.length) {
          draft.capsule.typingDone = true;
        }
        return draft;
      });
      if (index >= message.length) {
        window.clearInterval(capsuleTypingTimer);
        capsuleTypingTimer = null;
      }
    }, 30);
  }

  function saveCapsule(message, openAt) {
    const cleanMessage = String(message || "").trim();
    if (!cleanMessage) {
      return;
    }
    App.store.update((draft) => {
      draft.page = "capsule";
      draft.capsule.entries.unshift({
        id: `capsule-${Date.now()}`,
        message: cleanMessage,
        openAt,
        status: "等待开启"
      });
      draft.capsule.sealed = true;
      draft.capsule.message = cleanMessage;
      draft.capsule.typedText = "";
      draft.capsule.typingDone = false;
      draft.capsule.openAt = openAt;
      return draft;
    });
    startCapsuleTyping(cleanMessage);
  }

  async function handleSubmit(event) {
    const form = event.target.closest("form[data-form]");
    if (!form) {
      return;
    }
    event.preventDefault();
    const formData = new FormData(form);
    const formType = form.dataset.form;

    if (formType === "search") {
      await submitSearch(formData.get("query"));
    }

    if (formType === "chat") {
      await sendChatMessage(form.dataset.personId, formData.get("message"));
    }

    if (formType === "note") {
      saveNote(form.dataset.personId, formData.get("note"));
      form.reset();
    }

    if (formType === "capsule") {
      saveCapsule(formData.get("message"), formData.get("openAt"));
    }
  }

  function handleKeyDown(event) {
    if (event.key !== "Enter" || event.shiftKey || event.isComposing || event.keyCode === 229) {
      return;
    }

    const input = event.target.closest("textarea");
    if (!input) {
      return;
    }

    const form = input.closest('form[data-form="search"]');
    if (!form) {
      return;
    }

    event.preventDefault();
    if (typeof form.requestSubmit === "function") {
      form.requestSubmit();
      return;
    }

    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  }

  async function handleClick(event) {
    const target = event.target.closest("[data-action]");
    if (!target || target.disabled) {
      return;
    }

    const action = target.dataset.action;
    const clickedInsideModal = Boolean(event.target.closest("[data-stop-close]"));

    if (action === "close-modal") {
      if (target.classList.contains("overlay") && clickedInsideModal) {
        return;
      }
      closeModal();
      return;
    }

    if (action === "mock-login") {
      await mockLogin();
    } else if (action === "mock-logout") {
      await mockLogout();
    } else if (action === "answer-clarify") {
      answerClarify(target.dataset.questionId, target.dataset.optionId);
    } else if (action === "continue-after-clarify") {
      await continueAfterClarify();
    } else if (action === "skip-clarify") {
      await continueAfterClarify({ skip: true });
    } else if (action === "open-clarify") {
      openClarify();
    } else if (action === "set-path") {
      setPath(target.dataset.pathId);
    } else if (action === "toggle-experience") {
      toggleExperience(target.dataset.personId);
    } else if (action === "open-people") {
      openPeople(target.dataset.pathId);
    } else if (action === "toggle-original" || action === "open-original") {
      openReadingModal(target.dataset.personId);
    } else if (action === "open-reading") {
      openReading(target.dataset.personId);
    } else if (action === "toggle-inline-chat") {
      toggleInlineChat(target.dataset.personId);
    } else if (action === "toggle-inline-message") {
      toggleInlineMessage(target.dataset.personId);
    } else if (action === "open-chat" || action === "continue-interaction") {
      openInlineChat(target.dataset.personId);
    } else if (action === "toggle-rail") {
      toggleRail(target.dataset.section);
    } else if (action === "add-book") {
      addBook(target.dataset.personId);
    } else if (action === "open-book") {
      App.store.update((draft) => {
        draft.page = "book";
        draft.modal = { type: null, pathId: null, personId: null, panel: null };
        clearInlinePanels(draft);
        return draft;
      });
    } else if (action === "open-capsule") {
      App.store.update((draft) => {
        draft.page = "capsule";
        draft.modal = { type: null, pathId: null, personId: null, panel: null };
        clearInlinePanels(draft);
        draft.capsule.sealed = false;
        draft.capsule.typedText = "";
        draft.capsule.typingDone = false;
        return draft;
      });
    } else if (action === "open-feed") {
      App.store.update((draft) => {
        draft.page = draft.result ? "feed" : "entry";
        draft.modal = { type: null, pathId: null, personId: null, panel: null };
        return draft;
      });
    } else if (action === "toggle-book-status") {
      toggleBookStatus(target.dataset.personId);
    } else if (action === "select-capsule-prompt") {
      selectCapsulePrompt(target.dataset.prompt);
    } else if (action === "chat-suggestion") {
      await sendChatMessage(target.dataset.personId, target.dataset.message);
    }
  }

  App.store.subscribe(render);
  root.addEventListener("submit", handleSubmit);
  root.addEventListener("keydown", handleKeyDown);
  root.addEventListener("click", handleClick);
  render();
})();
