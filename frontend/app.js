(function () {
  const App = window.LifeSampleApp || (window.LifeSampleApp = {});
  const root = document.getElementById("app");
  let requestSeq = 0;

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
  }

  function currentRequestId() {
    requestSeq += 1;
    return `request-${Date.now()}-${requestSeq}`;
  }

  function isCurrentRequest(requestId) {
    return App.store.getState().search.requestId === requestId;
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

    const requestId = currentRequestId();
    const clarifyAnswers = options.keepClarify ? state.search.clarifyAnswers : {};

    App.store.update((draft) => {
      draft.page = "feed";
      draft.query = cleanQuery;
      draft.pendingQuery = cleanQuery;
      draft.activePathId = "all";
      draft.modal = { type: null, pathId: null, personId: null };
      draft.search = {
        status: "loading",
        message: "正在整理公开经历里的路径",
        requestId,
        clarifyQuestions: [],
        clarifyAnswers,
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
        draft.search.status = "clarify";
        draft.search.message = "";
        draft.search.clarifyQuestions = preparation.questions;
        draft.search.clarifyAnswers = {};
        return draft;
      });
      return;
    }

    await loadResults(cleanQuery, requestId, clarifyAnswers);
  }

  async function loadResults(query, requestId, answers) {
    App.store.update((draft) => {
      draft.search.status = "loading";
      draft.search.message = "正在生成路径 Feed";
      draft.search.requestId = requestId;
      return draft;
    });

    const response = await App.Api.search({
      query,
      answers
    });

    if (!isCurrentRequest(requestId)) {
      return;
    }

    App.store.update((draft) => {
      draft.result = response.data;
      draft.search.status = "loaded";
      draft.search.message = "";
      draft.search.error = "";
      draft.activePathId = "all";
      return draft;
    });
  }

  async function continueAfterClarify() {
    const state = App.store.getState();
    const questions = state.search.clarifyQuestions || [];
    const answers = state.search.clarifyAnswers || {};
    const complete = questions.every((question) => answers[question.id]);
    if (!complete) {
      return;
    }
    const requestId = currentRequestId();
    await loadResults(state.query || state.pendingQuery, requestId, answers);
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

    await submitSearch(state.pendingQuery || state.query || App.mockData.defaultQuery);
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
    App.store.update((draft) => {
      draft.page = "reading";
      draft.selectedPersonId = personId;
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

  function saveCapsule(message, openAt) {
    const cleanMessage = String(message || "").trim();
    if (!cleanMessage) {
      return;
    }
    App.store.update((draft) => {
      draft.capsule.entries.unshift({
        id: `capsule-${Date.now()}`,
        message: cleanMessage,
        openAt,
        status: "等待开启"
      });
      return draft;
    });
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

    if (action === "mock-login") {
      await mockLogin();
    } else if (action === "answer-clarify") {
      answerClarify(target.dataset.questionId, target.dataset.optionId);
    } else if (action === "continue-after-clarify") {
      await continueAfterClarify();
    } else if (action === "set-path") {
      setPath(target.dataset.pathId);
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
