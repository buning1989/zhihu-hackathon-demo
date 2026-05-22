(function () {
  const App = window.LifeSampleApp || (window.LifeSampleApp = {});
  App.components = App.components || {};

  App.components.renderRightRail = function renderRightRail(state) {
    const { escapeHtml, escapeAttribute } = App.utils;
    const icon = App.components.renderIcon;
    const interactions = state.interactions.slice(0, 5).map((item) => {
      const person = App.store.findPerson(item.personId);
      if (!person) {
        return "";
      }
      return `
        <div class="connected-item">
          <div class="connected-name">${escapeHtml(person.name)}</div>
          <div class="connected-snippet">${escapeHtml(item.reply || item.content)}</div>
          <button class="btn-text" type="button" data-action="continue-interaction" data-person-id="${escapeAttribute(person.id)}">${icon("reply")}继续听听</button>
        </div>
      `;
    }).join("");

    return `
      <aside class="right-rail">
        <section class="rail-card">
          <h3 class="rail-title">刚才聊过的</h3>
          <div class="connected-list">${interactions || `<p class="rail-text">和某个人聊过后，会出现在这里。</p>`}</div>
        </section>
      </aside>
    `;
  };
})();
