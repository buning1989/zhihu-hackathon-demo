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
      <button class="people-row" type="button" data-action="open-reading" data-person-id="${escapeAttribute(person.id)}">
        <span class="avatar" aria-hidden="true"><img src="${escapeAttribute(person.avatar)}" alt="" /></span>
        <span>
          <strong>${escapeHtml(person.name)}</strong>
          <p>${escapeHtml(person.experienceSummary)}</p>
        </span>
        <span class="app-button">读原文</span>
      </button>
    `).join("");

    return `
      <div class="overlay" role="presentation" data-action="close-modal">
        <section class="modal" role="dialog" aria-modal="true" aria-labelledby="people-modal-title" data-stop-close>
          <header class="modal-header">
            <div>
              <h2 id="people-modal-title">${escapeHtml(path ? path.shortTitle : "路径")}下的人物样本</h2>
              <p>点击任一人物进入原文页，继续看公开经历和证据片段。</p>
            </div>
            <button class="icon-button" type="button" data-action="close-modal" aria-label="关闭">×</button>
          </header>
          <div class="modal-body">
            <div class="people-modal-list">${rows}</div>
          </div>
        </section>
      </div>
    `;
  };
})();
