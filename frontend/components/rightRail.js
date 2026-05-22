(function () {
  const App = window.LifeSampleApp || (window.LifeSampleApp = {});
  App.components = App.components || {};

  App.components.renderRightRail = function renderRightRail(state) {
    const { escapeHtml, escapeAttribute } = App.utils;
    const icon = App.components.renderIcon;
    const bookItems = state.bookItems.slice(0, 4).map((item) => {
      const person = App.store.findPerson(item.personId);
      if (!person) {
        return "";
      }
      return `
        <div class="saved-item">
          ${escapeHtml(person.name)}：${escapeHtml(person.article?.title || person.experienceSummary)}
        </div>
      `;
    }).join("");

    const interactions = state.interactions.slice(0, 5).map((item) => {
      const person = App.store.findPerson(item.personId);
      if (!person) {
        return "";
      }
      return `
        <div class="connected-item">
          <div class="connected-name">${escapeHtml(person.name)}</div>
          <div class="connected-snippet">${escapeHtml(item.reply || item.content)}</div>
          <div class="connected-meta">${escapeHtml(item.type === "chat" ? "刚才问过" : "写给 TA 的话")} · ${escapeHtml(item.createdAt)}</div>
          <button class="btn-text" type="button" data-action="continue-interaction" data-person-id="${escapeAttribute(person.id)}">${icon("reply")}继续听听 →</button>
        </div>
      `;
    }).join("");

    return `
      <aside class="right-rail">
        <section class="rail-card">
          <h3 class="rail-title">我想留下的样本</h3>
          <div class="saved-list">${bookItems || `<p class="rail-text">留意过的人会出现在这里。</p>`}</div>
          ${bookItems ? `<button class="btn-s rail-book-btn" type="button" data-action="open-book">${icon("file-text")}整理成一页</button>` : ""}
        </section>
        <section class="rail-card">
          <h3 class="rail-title">刚才聊过的</h3>
          <div class="connected-list">${interactions || `<p class="rail-text">聊过或写过的话会保存在这里。</p>`}</div>
        </section>
      </aside>
    `;
  };
})();
