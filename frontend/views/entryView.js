(function () {
  const App = window.LifeSampleApp || (window.LifeSampleApp = {});
  App.views = App.views || {};

  App.views.renderEntryView = function renderEntryView(state) {
    const { escapeAttribute } = App.utils;
    const query = escapeAttribute(state.query || "");
    const loginPrompt = state.auth.needsLogin ? `
      <div class="login-prompt">
        <p>要找到和你像的人，需要先用知乎账号登录。</p>
        <button class="btn-p" type="button" data-action="mock-login" ${state.auth.isLoggingIn ? "disabled" : ""}>${state.auth.isLoggingIn ? "登录中" : "用知乎账号登录"}</button>
      </div>
    ` : "";

    return `
      <main class="entry-view">
        <section class="entry-center">
          <p class="brand-line">人生样本库</p>
          <h1 class="entry-title">输入处境，找到走过相似路的人。</h1>
          <form data-form="search">
            <label class="sr-only" for="entry-query">输入你的处境</label>
            <textarea class="entry-input" id="entry-query" name="query" placeholder="说说你现在处在什么岔路口，不用组织成一个标准问题……">${query}</textarea>
            <div class="entry-actions">
              <p class="entry-hint">按按钮开始匹配，Shift + Enter 换行</p>
              <button class="btn-p" type="submit">开始匹配</button>
            </div>
          </form>
          ${loginPrompt}
        </section>
      </main>
    `;
  };
})();
