(function () {
  const App = window.LifeSampleApp || (window.LifeSampleApp = {});
  App.views = App.views || {};

  function renderLoading(state) {
    const { escapeHtml, escapeAttribute } = App.utils;
    const result = state.result || App.store.getResult();
    const loadingStages = App.loadingStages || [
      { label: "理解处境", message: "正在理解你的处境" },
      { label: "寻找经历", message: "正在寻找相似经历" },
      { label: "抽取证据", message: "正在抽取证据片段" },
      { label: "整理走法", message: "正在整理几种走法" },
      { label: "生成结果", message: "正在挑出代表人物" }
    ];
    const currentStageIndex = Math.min(
      Math.max(Number(state.search.loadingStageIndex) || 0, 0),
      loadingStages.length - 1
    );
    const currentStage = loadingStages[currentStageIndex] || loadingStages[0];
    const phaseClass = state.transitionPhase === "loadingEntering"
      ? "loading-enter"
      : state.transitionPhase === "loadingExiting"
        ? "loading-exit"
        : "";
    const people = (result.people || App.mockData.people).slice(0, 6);
    const flowingPeople = people.concat(people);
    const lane = flowingPeople.map((person) => `
      <span class="loading-person">
        <span class="loading-avatar" aria-hidden="true"><img src="${escapeAttribute(person.avatar)}" alt="" /></span>
        <span>${escapeHtml(person.name)}</span>
      </span>
    `).join("");

    return `
      <section class="card loading-card ${phaseClass}">
        <h2 class="loading-title">${escapeHtml(currentStage.message)}</h2>
        <div class="people-flow" aria-hidden="true">
          <div class="marquee-track">${lane}</div>
          <div class="marquee-track reverse">${lane}</div>
        </div>
        <ol class="loading-flow" aria-label="匹配进度">
          ${loadingStages.map((stage, index) => {
            const nodeClass = index < currentStageIndex
              ? "is-done"
              : index === currentStageIndex
                ? "is-current"
                : "";
            return `
              <li class="loading-node ${nodeClass}" ${index === currentStageIndex ? "aria-current=\"step\"" : ""}>
                <span class="loading-node-dot" aria-hidden="true"></span>
                <span class="loading-node-label">${escapeHtml(stage.label)}</span>
              </li>
            `;
          }).join("")}
        </ol>
      </section>
    `;
  }

  function renderSideNav(state, result) {
    const { escapeHtml, escapeAttribute } = App.utils;
    const allActive = state.activePathId === "all";
    const buttons = result.paths.map((path) => {
      const peopleCount = App.store.getPeopleForPath(path.id).length;
      return `
        <button class="path-nav-item ${state.activePathId === path.id ? "is-active" : ""}" type="button" data-action="set-path" data-path-id="${escapeAttribute(path.id)}">
          <span class="path-nav-copy">
            ${escapeHtml(path.shortTitle)}
            <span class="path-nav-count">${peopleCount} 人</span>
          </span>
        </button>
      `;
    }).join("");

    return `
      <nav class="left-rail">
        <p class="rail-label">相似经历</p>
        <button class="path-nav-item ${allActive ? "is-active" : ""}" type="button" data-action="set-path" data-path-id="all">
          <span class="path-nav-copy">全部</span>
        </button>
        ${buttons}
      </nav>
    `;
  }

  function renderFeedSummary(result) {
    const { escapeHtml } = App.utils;
    const notices = [];
    if (result.meta?.cacheHit || result.meta?.reused) {
      notices.push("已使用近期相似结果");
    }
    if (result.degraded || result.meta?.degraded) {
      notices.push("证据有限，结果已保守收敛");
    }
    if (result.meta?.emptyResult) {
      notices.push("当前证据不足，暂时没有可展示样本");
    }

    return `
      <header class="feed-summary">
        <p class="feed-summary-text">${escapeHtml(`先从 ${result.paths.length} 种走法里，看几段最接近的经历。`)}</p>
        <button class="btn-text status-clarify" type="button" data-action="open-clarify">再说一点</button>
      </header>
      ${notices.length ? `<div class="result-notices">${notices.map((notice) => `<span>${escapeHtml(notice)}</span>`).join("")}</div>` : ""}
    `;
  }

  function renderError(state) {
    const { escapeHtml } = App.utils;
    const icon = App.components.renderIcon;
    const error = state.task.error || {};
    const code = error.errorCode || "";
    const message = state.search.error || error.errorMessage || "后端暂时不可用，请稍后再试。";
    const title = code === "RATE_LIMITED" ? "今天的任务有点多" : "暂时没能生成结果";

    return `
      <section class="empty-panel result-empty">
        <h2>${escapeHtml(title)}</h2>
        <p>${escapeHtml(message)}</p>
        <button class="btn-s" type="button" data-action="open-feed">${icon("arrow-left")}返回</button>
      </section>
    `;
  }

  function renderEmptyResult(result) {
    const { escapeHtml } = App.utils;
    return `
      <section class="empty-panel result-empty">
        <h2>证据有限，结果已保守收敛</h2>
        <p>${escapeHtml(result.degradedReason || result.meta?.degradedReason || "当前没有足够可绑定来源的 paths/personas，先不展示强结论。")}</p>
      </section>
    `;
  }

  function renderLoaded(state) {
    const result = state.result;
    const paths = state.activePathId === "all"
      ? result.paths
      : result.paths.filter((path) => path.id === state.activePathId);
    const modules = paths.map((path) => {
      const people = result.people.filter((person) => person.pathId === path.id);
      return App.components.renderPathModule(path, people, state);
    }).join("");
    const isEmpty = result.paths.length === 0 || result.people.length === 0;

    return `
      <main class="layout ${state.transitionPhase === "feedEntering" ? "feed-enter" : ""}">
          ${renderSideNav(state, result)}
          <section class="main-feed">
            ${renderFeedSummary(result)}
            ${isEmpty ? renderEmptyResult(result) : modules}
          </section>
          ${App.components.renderRightRail(state)}
      </main>
    `;
  }

  App.views.renderFeedView = function renderFeedView(state) {
    const topBar = App.components.renderTopBar(state);

    if (state.search.clarifyOpen || state.search.status === "clarify") {
      const content = state.result ? renderLoaded(state) : `<main class="layout"><aside></aside><section class="main-feed">${renderLoading(state)}</section><aside></aside></main>`;
      return `
        ${topBar}
        ${App.components.renderClarifyCard(state)}
        ${state.search.status === "clarify" && !state.result ? "" : content}
      `;
    }

    if (state.search.status === "error") {
      return `${topBar}<main class="layout"><aside></aside><section class="main-feed">${renderError(state)}</section><aside></aside></main>`;
    }

    if (state.search.status !== "loaded" || !state.result) {
      return `${topBar}<main class="layout"><aside></aside><section class="main-feed">${renderLoading(state)}</section><aside></aside></main>`;
    }

    return `${topBar}${renderLoaded(state)}`;
  };
})();
