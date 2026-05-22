(function () {
  const App = window.LifeSampleApp || (window.LifeSampleApp = {});
  App.components = App.components || {};

  App.components.renderTopBar = function renderTopBar(state) {
    const { escapeHtml, escapeAttribute } = App.utils;
    const icon = App.components.renderIcon;
    const query = escapeAttribute(state.query || state.pendingQuery || App.mockData.defaultQuery);
    const profile = state.auth.profile || App.mockData.profile;
    const isBook = state.page === "book";
    const isCapsule = state.page === "capsule";
    const accountMenu = state.auth.loggedIn ? `
      <details class="account-menu">
        <summary class="account-trigger" aria-label="当前账号：${escapeAttribute(profile.name)}">
          <span class="user-avatar">${escapeHtml(profile.name.slice(0, 1))}</span>
        </summary>
        <div class="account-popover">
          <div class="account-name">${escapeHtml(profile.name)}</div>
          <button class="account-menu-item" type="button" data-action="open-book">我的样本</button>
          <button class="account-menu-item" type="button" data-action="mock-logout">退出登录</button>
        </div>
      </details>
    ` : "";

    return `
      <header class="top-bar">
        <div class="top-bar-inner">
        <button class="logo" type="button" data-action="open-feed">
          ${icon("book-open")}人生样本库
        </button>
        <form class="top-form" data-form="search">
          <label class="sr-only" for="top-query">输入处境</label>
          <div class="top-input-shell">
            <textarea class="top-input" id="top-query" name="query" autocomplete="off">${query}</textarea>
            <button class="btn-text top-submit" type="submit" aria-label="重新看看">${icon("refresh-cw")}</button>
          </div>
        </form>
        <nav class="top-actions" aria-label="辅助入口">
          <button class="btn-text ${isBook ? "is-active" : ""}" type="button" data-action="open-book">${icon("bookmark")}留下的样本</button>
          <button class="btn-text ${isCapsule ? "is-active" : ""}" type="button" data-action="open-capsule">${icon("clock")}时间胶囊</button>
          ${accountMenu}
        </nav>
        </div>
      </header>
    `;
  };
})();
