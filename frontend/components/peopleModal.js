(function () {
  const App = window.LifeSampleApp || (window.LifeSampleApp = {});
  App.components = App.components || {};

  App.components.renderPeopleModal = function renderPeopleModal(state) {
    if (state.modal.type !== "people") {
      return "";
    }

    const { escapeHtml, escapeAttribute, publicUiLabel } = App.utils;
    const icon = App.components.renderIcon;
    const path = App.store.findPath(state.modal.pathId);
    const people = App.store.getPeopleForPath(state.modal.pathId);
    const rows = people.map((person) => {
      const avatar = person.avatar
        ? `<img src="${escapeAttribute(person.avatar)}" alt="" />`
        : `<span class="avatar-fallback" aria-hidden="true">${escapeHtml((person.name || "样").slice(0, 1))}</span>`;
      return `
        <button class="drawer-person-item" type="button" data-action="open-original" data-person-id="${escapeAttribute(person.id)}">
          <span class="avatar" aria-hidden="true">${avatar}</span>
          <span>
            <span class="name">${escapeHtml(person.name)}</span>
            <span class="brief">${escapeHtml(publicUiLabel(person.article?.title || person.source?.title, "知乎公开内容"))}</span>
          </span>
        </button>
      `;
    }).join("");

    return `
      <div class="modal-overlay" role="presentation" data-action="close-modal"></div>
        <section class="people-modal" role="dialog" aria-modal="true" aria-labelledby="people-modal-title" data-stop-close>
          <header class="modal-header">
            <span id="people-modal-title">${escapeHtml(publicUiLabel(path?.title, "公开内容片段"))} · ${people.length} 条样本</span>
            <button class="btn-text" type="button" data-action="close-modal">${icon("x")}关闭</button>
          </header>
          <div class="drawer-list">
            ${rows}
          </div>
        </section>
    `;
  };
})();
