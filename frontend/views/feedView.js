(function () {
  const App = window.LifeSampleApp || (window.LifeSampleApp = {});
  App.views = App.views || {};

  function renderLoading(state) {
    const { escapeHtml } = App.utils;
    return `
      <section class="card loading-card">
        <h2 class="loading-title">${escapeHtml(state.search.message || "正在整理路径")}</h2>
        <p class="loading-text">先找到几条不同的走法，再展开具体的人。</p>
        <div class="loading-lines" aria-hidden="true">
          <span class="line"></span>
          <span class="line"></span>
          <span class="line"></span>
        </div>
      </section>
    `;
  }

  function renderSideNav(state, result) {
    const { escapeHtml, escapeAttribute } = App.utils;
    const icon = App.components.renderIcon;
    const allActive = state.activePathId === "all";
    const buttons = result.paths.map((path) => {
      const peopleCount = App.store.getPeopleForPath(path.id).length;
      return `
        <button class="path-nav-item ${state.activePathId === path.id ? "is-active" : ""}" type="button" data-action="set-path" data-path-id="${escapeAttribute(path.id)}">
          ${icon("book-open")}
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
          ${icon("book-open")}<span class="path-nav-copy">全部</span>
        </button>
        ${buttons}
      </nav>
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
      <main class="layout">
          ${renderSideNav(state, result)}
          <section class="main-feed">${modules}</section>
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
