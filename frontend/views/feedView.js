(function () {
  const App = window.LifeSampleApp || (window.LifeSampleApp = {});
  App.views = App.views || {};

  function renderLoading(state) {
    const { escapeHtml } = App.utils;
    return `
      <section class="loading-panel">
        <h2>${escapeHtml(state.search.message || "正在整理路径")}</h2>
        <p>输入框已经回到顶部，稍后会进入路径话题 Feed。</p>
        <div class="loader-line" aria-hidden="true"></div>
      </section>
    `;
  }

  function renderSideNav(state, result) {
    const { escapeHtml, escapeAttribute } = App.utils;
    const allActive = state.activePathId === "all";
    const buttons = result.paths.map((path) => {
      const peopleCount = App.store.getPeopleForPath(path.id).length;
      return `
        <button class="path-nav-button ${state.activePathId === path.id ? "is-active" : ""}" type="button" data-action="set-path" data-path-id="${escapeAttribute(path.id)}">
          ${escapeHtml(path.shortTitle)}
          <span>${peopleCount} 个样本</span>
        </button>
      `;
    }).join("");

    return `
      <aside class="side-nav">
        <h2>路径导航</h2>
        <button class="path-nav-button ${allActive ? "is-active" : ""}" type="button" data-action="set-path" data-path-id="all">
          全部路径
          <span>${result.paths.length} 个话题中心</span>
        </button>
        ${buttons}
      </aside>
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
      <main class="page-shell">
        <div class="feed-grid">
          ${renderSideNav(state, result)}
          <section class="feed-stack">${modules}</section>
          ${App.components.renderRightRail(state)}
        </div>
      </main>
    `;
  }

  App.views.renderFeedView = function renderFeedView(state) {
    const topBar = App.components.renderTopBar(state);

    if (state.search.status === "clarify") {
      return `
        ${topBar}
        <div class="underbar">${App.components.renderClarifyCard(state)}</div>
      `;
    }

    if (state.search.status !== "loaded" || !state.result) {
      return `${topBar}${renderLoading(state)}`;
    }

    return `${topBar}${renderLoaded(state)}`;
  };
})();
