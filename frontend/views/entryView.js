(function () {
  const App = window.LifeSampleApp || (window.LifeSampleApp = {});
  App.views = App.views || {};

  function renderEntryTop(state) {
    const { escapeHtml, escapeAttribute } = App.utils;
    const icon = App.components.renderIcon;
    const profile = state.auth.profile || App.mockData.profile;
    const avatar = profile.avatar
      ? `<img class="user-avatar-img" src="${escapeAttribute(profile.avatar)}" alt="" />`
      : `<span class="user-avatar">${escapeHtml(profile.name.slice(0, 1))}</span>`;
    const accountMenu = state.auth.loggedIn ? `
      <details class="account-menu">
        <summary class="account-trigger" aria-label="当前账号：${escapeAttribute(profile.name)}">
          ${avatar}
        </summary>
        <div class="account-popover">
          <div class="account-name">${escapeHtml(profile.name)}</div>
          <button class="account-menu-item" type="button" data-action="open-book">我的样本</button>
          <button class="account-menu-item" type="button" data-action="mock-logout">退出登录</button>
        </div>
      </details>
    ` : "";

    return `
      <header class="entry-top">
        <div class="entry-top-inner">
          <button class="logo" type="button" data-action="open-feed">
            ${icon("book-open")}真实内容样本库
          </button>
          <div class="entry-account">${accountMenu}</div>
        </div>
      </header>
    `;
  }

  App.views.renderEntryView = function renderEntryView(state) {
    const { escapeHtml, escapeAttribute } = App.utils;
    const icon = App.components.renderIcon;
    const query = escapeAttribute(state.query || "");
    const isClarifying = state.search.clarifyOpen || state.search.status === "clarify";
    const isPreparing = state.search.status === "preparing";
    const isClarifyEntering = state.transitionPhase === "clarifyEntering";
    const isExiting = state.transitionPhase === "entryExiting";
    const clarifyPanel = isClarifying
      ? App.components.renderClarifyCard(state, { variant: "entry" })
      : "";
    const stageClass = [
      isClarifying ? "is-clarifying" : "",
      isClarifyEntering ? "is-clarify-entering" : "",
      isExiting ? "view-exit-to-top" : ""
    ].filter(Boolean).join(" ");
    const shellClass = [
      isClarifying ? "is-expanded" : "",
      isClarifyEntering ? "is-entering" : "",
      isPreparing ? "is-preparing" : ""
    ].filter(Boolean).join(" ");
    const queryPreview = escapeHtml(state.query || state.pendingQuery || "");
    const intentLoading = isPreparing && !isClarifying
      ? `
        <div class="entry-intent-loading" role="status" aria-live="polite">
          <span class="entry-intent-dot" aria-hidden="true"></span>
          <span class="entry-intent-copy">
            <strong>正在识别你的意图</strong>
            <span>我们在判断需要补充哪些背景，方便找到更像你的人</span>
          </span>
        </div>
      `
      : "";

    return `
      <main class="entry-view">
        ${renderEntryTop(state)}
        <section class="entry-center ${stageClass}">
          <h1 class="entry-title ${isClarifyEntering ? "is-fading" : ""}">有什么让你纠结了很久的事？越具体越好</h1>
          <form data-form="search">
            <label class="sr-only" for="entry-query">输入你的处境</label>
            <div class="entry-input-shell ${shellClass}">
              ${isClarifying ? `
                <div class="query-preview">${queryPreview}</div>
                <div class="composer-divider" aria-hidden="true"></div>
                ${clarifyPanel}
              ` : `
                <textarea class="entry-input" id="entry-query" name="query" ${isPreparing ? "readonly aria-disabled=\"true\"" : ""}>${query}</textarea>
                <button class="btn-p entry-submit ${isPreparing ? "is-loading" : ""}" type="submit" aria-label="${isPreparing ? "正在识别你的意图" : "开始找样本"}" ${isPreparing ? "disabled aria-busy=\"true\"" : ""}>
                  ${isPreparing ? "<span class=\"entry-submit-spinner\" aria-hidden=\"true\"></span>" : icon("search")}
                </button>
                ${intentLoading}
              `}
            </div>
          </form>
        </section>
      </main>
    `;
  };
})();
