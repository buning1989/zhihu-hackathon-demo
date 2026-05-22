(function () {
  const App = window.LifeSampleApp || (window.LifeSampleApp = {});
  App.components = App.components || {};

  App.components.renderPathModule = function renderPathModule(path, people, state) {
    const { escapeHtml, escapeAttribute } = App.utils;
    const cards = people.map((person) => App.components.renderPersonCard(person, state)).join("");
    const avatars = people.slice(0, 4).map((person) => `
      <span class="mini-avatar" aria-hidden="true"><img src="${escapeAttribute(person.avatar)}" alt="" /></span>
    `).join("");

    return `
      <section class="path-module">
        <header class="path-head">
          <div>
            <h2 class="path-title">${escapeHtml(path.title)}</h2>
            <div class="path-quote">${escapeHtml(path.representativeQuote || path.summary)}</div>
          </div>
          <button class="path-count-btn" type="button" data-action="open-people" data-path-id="${escapeAttribute(path.id)}">
            <span class="avatar-stack">${avatars}</span>
            <span>先看 ${people.length} 段代表经历</span>
          </button>
        </header>
        <div class="people-row">${cards}</div>
      </section>
    `;
  };
})();
