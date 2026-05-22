(function () {
  const App = window.LifeSampleApp || (window.LifeSampleApp = {});
  App.components = App.components || {};

  App.components.renderPathModule = function renderPathModule(path, people, state) {
    const { escapeHtml, escapeAttribute } = App.utils;
    const cards = people.map((person) => App.components.renderPersonCard(person, state)).join("");
    const sampleLabel = path.isEvidenceFallbackPath || people.some((person) => person.isProductionSample)
      ? "段证据样本"
      : "段代表经历";
    const avatars = people.slice(0, 4).map((person) => `
      <span class="mini-avatar" aria-hidden="true">${person.avatar ? `<img src="${escapeAttribute(person.avatar)}" alt="" />` : `<span class="avatar-fallback">${escapeHtml((person.name || "样").slice(0, 1))}</span>`}</span>
    `).join("");

    return `
      <section class="path-module">
        <header class="path-head">
          <div>
            <h2 class="path-title">${escapeHtml(path.title)}</h2>
          </div>
          <button class="path-count-btn" type="button" data-action="open-people" data-path-id="${escapeAttribute(path.id)}">
            <span class="avatar-stack">${avatars}</span>
            <span>先看 ${people.length} ${sampleLabel}</span>
          </button>
        </header>
        <div class="people-row">${cards}</div>
      </section>
    `;
  };
})();
