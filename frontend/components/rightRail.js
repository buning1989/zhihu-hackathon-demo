(function () {
  const App = window.LifeSampleApp || (window.LifeSampleApp = {});
  App.components = App.components || {};

  App.components.renderRightRail = function renderRightRail(state) {
    const { escapeHtml, escapeAttribute } = App.utils;
    const bookItems = state.bookItems.slice(0, 4).map((item) => {
      const person = App.store.findPerson(item.personId);
      if (!person) {
        return "";
      }
      return `
        <div class="rail-item">
          <strong>${escapeHtml(person.name)}</strong>
          <span>${escapeHtml(person.experienceSummary)}</span>
          <small>${escapeHtml(item.status === "done" ? "已读完" : "路书中")} · ${escapeHtml(item.addedAt)}</small>
        </div>
      `;
    }).join("");

    const interactions = state.interactions.slice(0, 5).map((item) => {
      const person = App.store.findPerson(item.personId);
      if (!person) {
        return "";
      }
      return `
        <div class="rail-item">
          <strong>${escapeHtml(person.name)}</strong>
          <span>${escapeHtml(item.content)}</span>
          ${item.reply ? `<span>${escapeHtml(item.reply)}</span>` : ""}
          <small>${escapeHtml(item.createdAt)}</small>
          <div class="rail-actions">
            <button class="app-button" type="button" data-action="continue-interaction" data-person-id="${escapeAttribute(person.id)}">继续互动</button>
          </div>
        </div>
      `;
    }).join("");

    return `
      <aside class="right-rail">
        <section class="rail-section">
          <h2>我的路书</h2>
          ${bookItems || `<p class="muted">还没有加入样本。</p>`}
          <div class="rail-actions">
            <button class="app-button primary" type="button" data-action="open-book">打开路书</button>
          </div>
        </section>
        <section class="rail-section">
          <h2>互动记录</h2>
          ${interactions || `<p class="muted">聊天和留言会出现在这里。</p>`}
        </section>
      </aside>
    `;
  };
})();
