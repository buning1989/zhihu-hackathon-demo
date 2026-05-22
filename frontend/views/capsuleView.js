(function () {
  const App = window.LifeSampleApp || (window.LifeSampleApp = {});
  App.views = App.views || {};

  App.views.renderCapsuleView = function renderCapsuleView(state) {
    const { escapeHtml, escapeAttribute } = App.utils;
    const prompts = App.mockData.capsulePrompts.map((prompt) => `
      <button class="capsule-option ${state.capsule.selectedPrompt === prompt ? "is-selected" : ""}" type="button" data-action="select-capsule-prompt" data-prompt="${escapeAttribute(prompt)}">${escapeHtml(prompt)}</button>
    `).join("");
    const entries = state.capsule.entries.map((entry) => `
      <article class="rail-item">
        <strong>${escapeHtml(entry.openAt)}</strong>
        <span>${escapeHtml(entry.message)}</span>
        <small>${escapeHtml(entry.status)}</small>
      </article>
    `).join("");

    return `
      ${App.components.renderTopBar(state)}
      <main class="page-shell">
        <div class="capsule-layout">
          <section class="capsule-panel">
            <h1>时间胶囊</h1>
            <p>把今天的判断存起来，之后再回来对照。</p>
            <div class="capsule-options">${prompts}</div>
            <form class="capsule-form" data-form="capsule">
              <label class="sr-only" for="capsule-message">写给未来的自己</label>
              <textarea id="capsule-message" name="message" placeholder="${escapeAttribute(state.capsule.selectedPrompt)}"></textarea>
              <div class="reading-actions">
                <select name="openAt" aria-label="开启时间">
                  <option value="2026-06-22">一个月后</option>
                  <option value="2026-08-22">三个月后</option>
                  <option value="2026-11-22">半年后</option>
                </select>
                <button class="app-button primary" type="submit">保存胶囊</button>
              </div>
            </form>
          </section>
          <section class="capsule-panel">
            <h2>等待开启</h2>
            <div class="capsule-list">${entries}</div>
          </section>
        </div>
      </main>
    `;
  };
})();
