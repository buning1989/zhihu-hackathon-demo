(function () {
  const App = window.LifeSampleApp || (window.LifeSampleApp = {});
  App.components = App.components || {};

  App.components.renderTopBar = function renderTopBar(state) {
    const { escapeHtml, escapeAttribute } = App.utils;
    const query = escapeAttribute(state.query || state.pendingQuery || App.mockData.defaultQuery);
    const profile = state.auth.profile;
    const isFeed = state.page === "feed";
    const isBook = state.page === "book";
    const isCapsule = state.page === "capsule";
    const statusText = state.search.status === "loading" ? state.search.message : "";

    return `
      <header class="topbar">
        <button class="topbar-brand" type="button" data-action="open-feed">
          <span class="brand-mark">人</span>
          <span>
            <strong>人生样本库</strong>
            <span>从公开经历里找下一步</span>
          </span>
        </button>
        <form class="top-search" data-form="search">
          <label class="sr-only" for="top-query">输入处境</label>
          <input id="top-query" name="query" value="${query}" autocomplete="off" />
          <button class="app-button primary" type="submit">重新匹配</button>
        </form>
        <nav class="topbar-actions" aria-label="主导航">
          <button class="app-button ${isFeed ? "primary" : "ghost"}" type="button" data-action="open-feed">路径</button>
          <button class="app-button ${isBook ? "primary" : "ghost"}" type="button" data-action="open-book">路书</button>
          <button class="app-button ${isCapsule ? "primary" : "ghost"}" type="button" data-action="open-capsule">时间胶囊</button>
          <span class="profile-chip">
            <span class="profile-dot">${escapeHtml(profile ? profile.name.slice(0, 1) : "知")}</span>
            <span>${escapeHtml(profile ? profile.name : "未登录")}</span>
          </span>
        </nav>
        <div class="topbar-state">${escapeHtml(statusText)}</div>
      </header>
    `;
  };
})();
