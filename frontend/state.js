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
      requestId: "",
      clarifyQuestions: [],
      clarifyAnswers: {},
      error: ""
    },
    result: null,
    activePathId: "all",
    selectedPersonId: null,
    modal: {
      type: null,
      pathId: null,
      personId: null
    },
    bookItems: clone(data.starterBook),
    interactions: clone(data.starterInteractions),
    notes: {},
    chatThreads: {},
    capsule: {
      selectedPrompt: data.capsulePrompts[0],
      entries: clone(data.starterCapsules)
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
            text: `我是${person.name}这段公开经历的经验回声。你可以问我这段路是怎么开始、怎么收尾，或中间最难的地方。`
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

  App.store = {
    getState,
    update,
    subscribe,
    getResult,
    findPath,
    findPerson,
    getPeopleForPath,
    isInBook,
    addToBook,
    addInteraction,
    ensureChatThread
  };

  App.utils = {
    escapeHtml,
    escapeAttribute,
    clone,
    byId
  };
})();
