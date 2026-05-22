(function () {
  const App = window.LifeSampleApp || (window.LifeSampleApp = {});
  App.components = App.components || {};

  App.components.renderPeopleModal = function renderPeopleModal(state) {
    if (state.modal.type !== "people") {
      return "";
    }

    const { escapeHtml, escapeAttribute } = App.utils;
    const path = App.store.findPath(state.modal.pathId);
    const people = App.store.getPeopleForPath(state.modal.pathId);
    const rows = people.map((person) => `
      <button class="drawer-person-item" type="button" data-action="open-reading" data-person-id="${escapeAttribute(person.id)}">
        <span class="avatar" aria-hidden="true"><img src="${escapeAttribute(person.avatar)}" alt="" /></span>
        <span>
          <span class="name">${escapeHtml(person.name)}</span>
          <span class="brief">${escapeHtml(person.article?.title || person.experienceSummary)}</span>
        </span>
      </button>
    `).join("");

    return `
      <div class="modal-overlay" role="presentation" data-action="close-modal"></div>
        <section class="people-modal" role="dialog" aria-modal="true" aria-labelledby="people-modal-title" data-stop-close>
          <header class="modal-header">
            <span id="people-modal-title">${escapeHtml(path ? path.title : "路径")} · ${people.length} 人</span>
            <button class="btn-text" type="button" data-action="close-modal">关闭</button>
          </header>
          <div class="drawer-list">
            ${rows}
          </div>
        </section>
    `;
  };
})();
