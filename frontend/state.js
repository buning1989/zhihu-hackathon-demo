(function () {
  const App = window.LifeSampleApp || (window.LifeSampleApp = {});
  const data = App.mockData;
  const listeners = new Set();

  const clone = (value) => JSON.parse(JSON.stringify(value));

  const initialState = {
    page: "entry",
    query: "",
    pendingQuery: "",
    auth: {
      loggedIn: false,
      needsLogin: false,
      isLoggingIn: false,
      profile: null
    },
    search: {
      status: "idle",
      message: "",
      loadingStageIndex: 0,
      requestId: "",
      clarifyQuestions: [],
      clarifyAnswers: {},
      clarifyOpen: false,
      hasShownInitialClarify: false,
      initialClarifySkipped: false,
      clarifySource: "",
      error: ""
    },
    task: {
      taskId: "",
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
    },
    transitionPhase: "entry",
    result: null,
    activePathId: "all",
    selectedPersonId: null,
    expandedPersonId: null,
    expandedOriginalPersonId: null,
    expandedExperiencePersonId: null,
    inlineChatPersonId: null,
    inlineChatBlockedPersonId: null,
    inlineMessagePersonId: null,
    modal: {
      type: null,
      pathId: null,
      personId: null,
      panel: null
    },
    bookItems: clone(data.starterBook),
    recentlyViewed: [],
    interactions: clone(data.starterInteractions),
    railExpanded: {
      recentlyViewed: false,
      interactions: false
    },
    notes: {},
    chatThreads: {},
    capsule: {
      selectedPrompt: data.capsulePrompts[0],
      entries: clone(data.starterCapsules),
      sealed: false,
      message: "",
      typedText: "",
      typingDone: false,
      openAt: ""
    }
  };

  let state = clone(initialState);

  function emit() {
    listeners.forEach((listener) => listener(state));
  }

  function getState() {
    return state;
  }

  function update(updater) {
    const draft = clone(state);
    const next = updater(draft) || draft;
    state = next;
    emit();
  }

  function updateSilent(updater) {
    const draft = clone(state);
    const next = updater(draft) || draft;
    state = next;
  }

  function subscribe(listener) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  function getResult() {
    return state.result || {
      paths: data.paths,
      people: data.people,
      personas: data.personas
    };
  }

  function findPath(pathId) {
    return getResult().paths.find((path) => path.id === pathId) || null;
  }

  function findPerson(personId) {
    return getResult().people.find((person) => person.id === personId) || null;
  }

  function getPeopleForPath(pathId) {
    const result = getResult();
    return result.people.filter((person) => pathId === "all" || person.pathId === pathId);
  }

  function isInBook(personId) {
    return state.bookItems.some((item) => item.personId === personId);
  }

  function addToBook(personId) {
    update((draft) => {
      if (!draft.bookItems.some((item) => item.personId === personId)) {
        draft.bookItems.unshift({
          personId,
          status: "reading",
          addedAt: "刚刚"
        });
      }
      return draft;
    });
  }

  function addInteraction(interaction) {
    update((draft) => {
      draft.interactions.unshift({
        id: `interaction-${Date.now()}`,
        createdAt: "刚刚",
        ...interaction
      });
      draft.interactions = draft.interactions.slice(0, 10);
      return draft;
    });
  }

  function addRecentView(personId) {
    update((draft) => {
      draft.recentlyViewed = [
        {
          personId,
          viewedAt: "刚刚"
        },
        ...draft.recentlyViewed.filter((item) => item.personId !== personId)
      ].slice(0, 10);
      return draft;
    });
  }

  function ensureChatThread(personId) {
    const person = findPerson(personId);
    if (!person) {
      return;
    }
    update((draft) => {
      if (!draft.chatThreads[personId]) {
        draft.chatThreads[personId] = [
          {
            id: `assistant-${Date.now()}`,
            role: "assistant",
            text: `我只能沿着${person.name}留下的这段公开内容说说看。你可以问它是怎么开始、怎么收尾，或中间最难的地方。`
          }
        ];
      }
      return draft;
    });
  }

  const escapeHtml = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "\"": "&quot;",
    "'": "&#39;"
  })[char]);

  const escapeAttribute = (value) => escapeHtml(value).replace(/`/g, "&#96;");

  const byId = (items, id) => items.find((item) => item.id === id) || null;

  const statusLabelPattern = /(证据不足|证据有限|证据样本|证据路径|可追溯|结果已保守收敛|保守收敛|degraded|evidenceStatus|grounding status|grounding)/i;

  function publicUiLabel(value, fallback = "公开内容片段") {
    const text = String(value || "").trim();
    if (!text || statusLabelPattern.test(text)) {
      return fallback;
    }
    return text;
  }

  App.store = {
    getState,
    update,
    subscribe,
    getResult,
    findPath,
    findPerson,
    getPeopleForPath,
    isInBook,
    updateSilent,
    addToBook,
    addInteraction,
    addRecentView,
    ensureChatThread
  };

  App.utils = {
    escapeHtml,
    escapeAttribute,
    clone,
    byId,
    publicUiLabel
  };
})();
