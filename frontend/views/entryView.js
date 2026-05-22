(function () {
  const App = window.LifeSampleApp || (window.LifeSampleApp = {});
  App.views = App.views || {};

  App.views.renderEntryView = function renderEntryView(state) {
    const { escapeAttribute } = App.utils;
    const query = escapeAttribute(state.query || "");
    const loginPrompt = state.auth.needsLogin ? `
      <div class="login-prompt">
        <p>登录后，会把这些经历临时放进你的这一页里。</p>
        <button class="btn-p" type="button" data-action="mock-login" ${state.auth.isLoggingIn ? "disabled" : ""}>${state.auth.isLoggingIn ? "登录中" : "用知乎账号登录"}</button>
      </div>
    ` : "";

    return `
      <main class="entry-view">
        <section class="entry-center">
          <p class="brand-line">人生样本库</p>
          <h1 class="entry-title">把现在的处境写下来。<br />看看有没有人，也走到过这里。</h1>
          <form data-form="search">
            <label class="sr-only" for="entry-query">输入你的处境</label>
            <textarea class="entry-input" id="entry-query" name="query" placeholder="说说你现在处在什么岔路口，不用组织成一个标准问题……">${query}</textarea>
            <div class="entry-actions">
              <p class="entry-hint">不用写成问题，像写给自己的一句话就好。</p>
              <button class="btn-p" type="submit">看看相似的人</button>
            </div>
          </form>
          ${loginPrompt}
        </section>
      </main>
    `;
  };
})();
