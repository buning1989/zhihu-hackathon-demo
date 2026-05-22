(function () {
  const App = window.LifeSampleApp || (window.LifeSampleApp = {});
  App.views = App.views || {};

  function renderLoading(state) {
    const { escapeHtml, escapeAttribute } = App.utils;
    const result = state.result || App.store.getResult();
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
    const steps = [
      "正在理解你的处境",
      "正在寻找相似经历",
      "正在整理几种走法",
      "正在挑出最接近的人"
    ];

    return `
      <section class="card loading-card ${phaseClass}">
        <h2 class="loading-title">${escapeHtml(state.search.message || "正在整理路径")}</h2>
        <div class="people-flow" aria-hidden="true">
          <div class="flow-lane">${lane}</div>
          <div class="flow-lane is-reverse">${lane}</div>
        </div>
        <div class="loading-progress">
          <span class="loading-dot"></span>
          <div class="loading-step-window">
            <div class="loading-step-strip">
              ${steps.map((step) => `<span>${escapeHtml(step)}</span>`).join("")}
              <span>${escapeHtml(steps[0])}</span>
            </div>
          </div>
        </div>
        <div class="loading-progress-track" aria-hidden="true"><span></span></div>
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
    return `
      <header class="feed-summary">
        <p class="feed-summary-text">${escapeHtml(`先从 ${result.paths.length} 种走法里，看几段最接近的经历。`)}</p>
        <button class="btn-text status-clarify" type="button" data-action="open-clarify">再说一点</button>
      </header>
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

    return `
      <main class="layout ${state.transitionPhase === "feedEntering" ? "feed-enter" : ""}">
          ${renderSideNav(state, result)}
          <section class="main-feed">
            ${renderFeedSummary(result)}
            ${modules}
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

    if (state.search.status !== "loaded" || !state.result) {
      return `${topBar}<main class="layout"><aside></aside><section class="main-feed">${renderLoading(state)}</section><aside></aside></main>`;
    }

    return `${topBar}${renderLoaded(state)}`;
  };
})();
