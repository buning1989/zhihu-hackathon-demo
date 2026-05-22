(function () {
  const App = window.LifeSampleApp || (window.LifeSampleApp = {});
  const root = document.getElementById("app");
  let requestSeq = 0;
  let capsuleTypingTimer = null;
  let entryPlaceholderTimer = null;
  const mockMinimumLoadingMs = 3000;
  const defaultMinimumLoadingMs = 2000;
  const entryPlaceholderExamples = [
    "为了工作长期异地恋，真的值得吗？",
    "毕业后留在大城市，还是回老家？",
    "一份稳定但消耗人的工作，要不要离开？",
    "关系里一直是我让步，还要继续吗？"
  ];

  function render() {
    const state = App.store.getState();
    document.body.dataset.page = state.page;

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
      if (restingTicks < 14) {
        return;
      }

      exampleIndex = (exampleIndex + 1) % entryPlaceholderExamples.length;
      charIndex = 0;
      restingTicks = 0;
      input.placeholder = "";
    }, 80);
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

  async function submitSearch(query, options = {}) {
    const cleanQuery = String(query || "").trim();
    if (!cleanQuery) {
      return;
    }

    const state = App.store.getState();
    if (!state.auth.loggedIn) {
      App.store.update((draft) => {
        draft.page = "entry";
        draft.query = cleanQuery;
        draft.pendingQuery = cleanQuery;
        draft.auth.needsLogin = true;
        return draft;
      });
      return;
    }

    const pageBeforeSubmit = state.page;
    const requestId = currentRequestId();
    const clarifyAnswers = options.keepClarify ? state.search.clarifyAnswers : {};

    App.store.update((draft) => {
      draft.page = pageBeforeSubmit === "entry" ? "entry" : "feed";
      draft.query = cleanQuery;
      draft.pendingQuery = cleanQuery;
      draft.activePathId = "all";
      draft.modal = { type: null, pathId: null, personId: null };
      draft.search = {
        status: "preparing",
        message: "正在从真实经历里找相似的人",
        requestId,
        clarifyQuestions: [],
        clarifyAnswers,
        clarifyOpen: false,
        error: ""
      };
      return draft;
    });

    const preparation = await App.Api.prepareSearch({
      query: cleanQuery,
      answers: clarifyAnswers
    });

    if (!isCurrentRequest(requestId)) {
      return;
    }

    if (preparation.status === "needs_clarification") {
      App.store.update((draft) => {
        draft.page = pageBeforeSubmit === "entry" ? "entry" : "feed";
        draft.search.status = "clarify";
        draft.search.message = "";
        draft.search.clarifyQuestions = preparation.questions;
        draft.search.clarifyAnswers = {};
        draft.search.clarifyOpen = true;
        return draft;
      });
      return;
    }

    await loadResults(cleanQuery, requestId, clarifyAnswers);
  }

  async function loadResults(query, requestId, answers) {
    const loadingStartedAt = Date.now();
    App.store.update((draft) => {
      draft.page = "feed";
      draft.search.status = "loading";
      draft.search.message = "正在从真实经历里找相似的人";
      draft.search.requestId = requestId;
      draft.search.clarifyOpen = false;
      return draft;
    });

    const response = await App.Api.search({
      query,
      answers
    });

    if (!isCurrentRequest(requestId)) {
      return;
    }

    const minimumLoadingMs = response.data?.dataMode === "mock" ? mockMinimumLoadingMs : defaultMinimumLoadingMs;
    const remainingLoadingMs = minimumLoadingMs - (Date.now() - loadingStartedAt);
    if (remainingLoadingMs > 0) {
      await wait(remainingLoadingMs);
    }

    if (!isCurrentRequest(requestId)) {
      return;
    }

    App.store.update((draft) => {
      draft.result = response.data;
      draft.search.status = "loaded";
      draft.search.message = "";
      draft.search.error = "";
      draft.search.clarifyOpen = false;
      draft.activePathId = "all";
      return draft;
    });
  }

  async function continueAfterClarify(options = {}) {
    const state = App.store.getState();
    const questions = state.search.clarifyQuestions || [];
    const answers = state.search.clarifyAnswers || {};
    const nextAnswers = options.skip ? {} : answers;
    const requestId = currentRequestId();
    await loadResults(state.query || state.pendingQuery, requestId, nextAnswers);
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
      draft.auth.profile = response.profile;
      return draft;
    });

    const nextQuery = state.pendingQuery || state.query;
    if (nextQuery) {
      await submitSearch(nextQuery);
    }
  }

  function mockLogout() {
    App.store.update((draft) => {
      draft.page = "entry";
      draft.query = "";
      draft.pendingQuery = "";
      draft.auth.loggedIn = false;
      draft.auth.needsLogin = false;
      draft.auth.isLoggingIn = false;
      draft.auth.profile = null;
      draft.search.status = "idle";
      draft.search.message = "";
      draft.search.clarifyOpen = false;
      draft.modal = { type: null, pathId: null, personId: null };
      return draft;
    });
  }

  function answerClarify(questionId, optionId) {
    App.store.update((draft) => {
      draft.search.clarifyAnswers[questionId] = optionId;
      return draft;
    });
  }

  function setPath(pathId) {
    App.store.update((draft) => {
      draft.activePathId = pathId;
      draft.expandedPersonId = null;
      return draft;
    });
  }

  function openClarify() {
    App.store.update((draft) => {
      draft.search.clarifyQuestions = draft.search.clarifyQuestions.length
        ? draft.search.clarifyQuestions
        : App.mockData.clarifyQuestions.slice(0, 3);
      draft.search.clarifyOpen = true;
      return draft;
    });
  }

  function toggleExperience(personId) {
    App.store.update((draft) => {
      draft.expandedPersonId = draft.expandedPersonId === personId ? null : personId;
      return draft;
    });
  }

  function openPeople(pathId) {
    App.store.update((draft) => {
      draft.modal = { type: "people", pathId, personId: null };
      return draft;
    });
  }

  function closeModal() {
    App.store.update((draft) => {
      draft.modal = { type: null, pathId: null, personId: null };
      return draft;
    });
  }

  function openReading(personId) {
    App.store.addRecentView(personId);
    App.store.update((draft) => {
      draft.page = "reading";
      draft.selectedPersonId = personId;
      draft.expandedPersonId = null;
      draft.modal = { type: null, pathId: null, personId: null };
      return draft;
    });
  }

  function openChat(personId) {
    App.store.ensureChatThread(personId);
    App.store.update((draft) => {
      draft.modal = { type: "chat", pathId: null, personId };
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
    }

    if (formType === "capsule") {
      saveCapsule(formData.get("message"), formData.get("openAt"));
    }
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

    if (action === "open-login") {
      App.store.update((draft) => {
        draft.auth.needsLogin = true;
        return draft;
      });
    } else if (action === "mock-login") {
      await mockLogin();
    } else if (action === "mock-logout") {
      mockLogout();
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
    } else if (action === "open-reading") {
      openReading(target.dataset.personId);
    } else if (action === "open-chat" || action === "continue-interaction") {
      openChat(target.dataset.personId);
    } else if (action === "add-book") {
      addBook(target.dataset.personId);
    } else if (action === "open-book") {
      App.store.update((draft) => {
        draft.page = "book";
        draft.modal = { type: null, pathId: null, personId: null };
        return draft;
      });
    } else if (action === "open-capsule") {
      App.store.update((draft) => {
        draft.page = "capsule";
        draft.modal = { type: null, pathId: null, personId: null };
        draft.capsule.sealed = false;
        draft.capsule.typedText = "";
        draft.capsule.typingDone = false;
        return draft;
      });
    } else if (action === "open-feed") {
      App.store.update((draft) => {
        draft.page = draft.result ? "feed" : "entry";
        draft.modal = { type: null, pathId: null, personId: null };
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
  root.addEventListener("click", handleClick);
  render();
})();
