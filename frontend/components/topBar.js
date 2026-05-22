(function () {
  const App = window.LifeSampleApp || (window.LifeSampleApp = {});
  App.components = App.components || {};

  App.components.renderTopBar = function renderTopBar(state) {
    const { escapeHtml, escapeAttribute } = App.utils;
    const icon = App.components.renderIcon;
    const query = escapeAttribute(state.query || state.pendingQuery || App.mockData.defaultQuery);
    const profile = state.auth.profile;
    const isFeed = state.page === "feed";
    const isBook = state.page === "book";
    const isCapsule = state.page === "capsule";
    const result = state.result;
    const pathCount = result ? result.paths.length : 0;
    const peopleCount = result ? result.people.length : 0;
    const statusText = state.search.status === "loading" ? state.search.message : "";
    const loadedStatus = state.search.status === "loaded" && result ? `
      <div class="status-bar">
        <span class="status-text">整理出 <strong>${pathCount} 条走法</strong> · <strong>${peopleCount} 个样本</strong></span>
        <button class="btn-text status-clarify" type="button" data-action="open-clarify">${icon("message-circle")}再说一点你的处境</button>
      </div>
    ` : statusText ? `
      <div class="status-bar">
        <span class="status-text">${escapeHtml(statusText)}</span>
      </div>
    ` : "";

    return `
      <header class="top-bar">
        <div class="top-bar-inner">
        <button class="logo" type="button" data-action="open-feed">
          ${icon("book-open")}人生样本库
        </button>
        <form class="top-form" data-form="search">
          <label class="sr-only" for="top-query">输入处境</label>
          <textarea class="top-input" id="top-query" name="query" autocomplete="off">${query}</textarea>
          <button class="btn-text top-submit" type="submit">${icon("refresh-cw")}重新看看</button>
        </form>
        <nav class="top-actions" aria-label="主导航">
          <button class="btn-text ${isFeed ? "is-active" : ""}" type="button" data-action="open-feed">${icon("book-open")}相似经历</button>
          <button class="btn-text ${isBook ? "is-active" : ""}" type="button" data-action="open-book">${icon("bookmark")}留下的样本</button>
          <button class="btn-text ${isCapsule ? "is-active" : ""}" type="button" data-action="open-capsule">${icon("clock")}时间胶囊</button>
          <span class="user-area">
            <span class="user-avatar">${escapeHtml(profile ? profile.name.slice(0, 1) : "我")}</span>
          </span>
        </nav>
        </div>
        ${loadedStatus}
      </header>
    `;
  };
})();
