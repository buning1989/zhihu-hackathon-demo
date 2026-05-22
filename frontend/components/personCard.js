(function () {
  const App = window.LifeSampleApp || (window.LifeSampleApp = {});
  App.components = App.components || {};

  App.components.renderPersonCard = function renderPersonCard(person, state) {
    const { escapeHtml, escapeAttribute } = App.utils;
    const saved = App.store.isInBook(person.id);

    return `
      <article class="person-card">
        <div class="avatar" aria-hidden="true">
          <img src="${escapeAttribute(person.avatar)}" alt="" />
        </div>
        <div class="person-main">
          <h3>${escapeHtml(person.name)}</h3>
          <p class="person-experience"><strong>TA 的经历：</strong>${escapeHtml(person.experienceSummary)}</p>
          <div class="card-actions">
            <button class="app-button" type="button" data-action="add-book" data-person-id="${escapeAttribute(person.id)}">${saved ? "已在路书" : "加入路书"}</button>
            <button class="app-button primary" type="button" data-action="open-reading" data-person-id="${escapeAttribute(person.id)}">读原文</button>
          </div>
        </div>
      </article>
    `;
  };
})();
