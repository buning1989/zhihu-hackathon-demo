(function () {
  const App = window.LifeSampleApp || (window.LifeSampleApp = {});
  App.views = App.views || {};

  App.views.renderEntryView = function renderEntryView(state) {
    const { escapeAttribute } = App.utils;
    const query = escapeAttribute(state.query || "");
    const loginPrompt = state.auth.needsLogin ? `
      <div class="login-inline">
        <strong>需要先完成知乎账号登录</strong>
        <p>这里使用 mock 登录，只模拟“已授权”的状态，不会跳转真实 OAuth。</p>
        <button class="app-button primary" type="button" data-action="mock-login" ${state.auth.isLoggingIn ? "disabled" : ""}>${state.auth.isLoggingIn ? "登录中" : "用知乎账号登录"}</button>
      </div>
    ` : "";

    return `
      <main class="entry-page">
        <section class="entry-panel">
          <div class="entry-brand">
            <span class="brand-mark">人</span>
            <span>
              <strong>人生样本库</strong>
              <span>v2 mock prototype</span>
            </span>
          </div>
          <h1 class="entry-title">先写下你现在卡住的处境。</h1>
          <p class="entry-subtitle">系统会把公开经历整理成几条可比较的人生路径。人物样本只作为路径下的内容单元，原文会放在信任之后继续阅读。</p>
          <form class="search-box" data-form="search">
            <label class="sr-only" for="entry-query">输入你的处境</label>
            <textarea id="entry-query" name="query" placeholder="例如：不工作了以后，我能去哪儿重新开始？">${query}</textarea>
            <div class="search-actions">
              <span class="search-hint">先用 mockData 跑通产品主链路</span>
              <button class="app-button primary" type="submit">开始匹配</button>
            </div>
          </form>
          ${loginPrompt}
        </section>
      </main>
    `;
  };
})();
