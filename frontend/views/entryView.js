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
    ` : `<button class="btn-s entry-login-link" type="button" data-action="zhihu-login">使用知乎登录</button>`;

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

  function renderAuthStatusPanel(state) {
    const { escapeHtml, escapeAttribute } = App.utils;
    const auth = state.auth || {};
    const profile = auth.profile || {};
    const me = auth.me || {};

    if (auth.status === "loading") {
      return `
        <section class="auth-status-panel" aria-label="知乎登录状态">
          <div class="auth-status-title">正在检查登录态</div>
          <p class="auth-status-copy">稍等一下，正在读取 /auth/me。</p>
        </section>
      `;
    }

    if (!auth.loggedIn) {
      return `
        <section class="auth-status-panel" aria-label="知乎登录状态">
          <div class="auth-status-title">当前未登录</div>
          <p class="auth-status-copy">点击按钮进行知乎授权。</p>
          ${auth.error ? `<p class="auth-status-error">${escapeHtml(auth.error)}</p>` : ""}
          <button class="btn-p auth-login-button" type="button" data-action="zhihu-login">
            ${App.components.renderIcon("log-in")}使用知乎登录
          </button>
        </section>
      `;
    }

    const avatarUrl = profile.avatar || me.avatar || "";
    const displayName = me.displayName || profile.name || "知乎用户";
    const headline = me.headline || profile.headline || "";
    const rows = [
      ["displayName", displayName],
      ["avatar", avatarUrl],
      ["headline", headline],
      ["id", me.id || ""],
      ["userInfoLoaded", formatBoolean(me.userInfoLoaded)],
      ["isTemporary", formatBoolean(me.isTemporary)]
    ];

    return `
      <section class="auth-status-panel is-logged-in" aria-label="知乎登录状态">
        <div class="auth-status-head">
          ${avatarUrl
            ? `<img class="auth-avatar" src="${escapeAttribute(avatarUrl)}" alt="" />`
            : `<div class="auth-avatar auth-avatar-fallback">${escapeHtml(displayName.slice(0, 1))}</div>`}
          <div>
            <div class="auth-status-title">已登录</div>
            <p class="auth-status-copy">当前知乎授权信息已从 /auth/me 读取。</p>
          </div>
        </div>
        <dl class="auth-field-list">
          ${rows.map(([label, value]) => `
            <div class="auth-field-row">
              <dt>${escapeHtml(label)}</dt>
              <dd>${escapeHtml(value || "-")}</dd>
            </div>
          `).join("")}
        </dl>
      </section>
    `;
  }

  function formatBoolean(value) {
    return value ? "true" : "false";
  }

  function renderLoginModal(state) {
    const icon = App.components.renderIcon;

    if (!state.auth.needsLogin) {
      return "";
    }

    return `
      <section class="entry-modal-overlay" role="presentation">
        <div class="login-modal" role="dialog" aria-modal="true" aria-labelledby="login-modal-title">
          <h2 id="login-modal-title" class="login-modal-title">先登录一下</h2>
          <p class="login-modal-body">登录后，继续为你寻找相关样本。</p>
          <button class="btn-p login-modal-action" type="button" data-action="zhihu-login" ${state.auth.isLoggingIn ? "disabled" : ""}>
            ${icon("log-in")}使用知乎登录
          </button>
        </div>
      </section>
    `;
  }

  App.views.renderEntryView = function renderEntryView(state) {
    const { escapeHtml, escapeAttribute } = App.utils;
    const icon = App.components.renderIcon;
    const query = escapeAttribute(state.query || "");
    const isClarifying = state.search.clarifyOpen || state.search.status === "clarify";
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
      isClarifyEntering ? "is-entering" : ""
    ].filter(Boolean).join(" ");
    const queryPreview = escapeHtml(state.query || state.pendingQuery || "");

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
                <textarea class="entry-input" id="entry-query" name="query">${query}</textarea>
                <button class="btn-p entry-submit" type="submit" aria-label="开始找样本">${icon("search")}</button>
              `}
            </div>
          </form>
          ${renderAuthStatusPanel(state)}
        </section>
        ${renderLoginModal(state)}
      </main>
    `;
  };
})();
