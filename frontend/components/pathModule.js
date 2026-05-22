(function () {
  const App = window.LifeSampleApp || (window.LifeSampleApp = {});
  App.components = App.components || {};

  App.components.renderPathModule = function renderPathModule(path, people, state) {
    const { escapeHtml, escapeAttribute } = App.utils;
    const cards = people.map((person) => App.components.renderPersonCard(person, state)).join("");

    return `
      <section class="path-module">
        <header class="path-header">
          <div>
            <h2>${escapeHtml(path.title)}</h2>
            <p>${escapeHtml(path.summary)}</p>
            <div class="quote-line">${escapeHtml(path.representativeQuote)}</div>
          </div>
          <button class="app-button people-count" type="button" data-action="open-people" data-path-id="${escapeAttribute(path.id)}">${people.length} 人</button>
        </header>
        <div class="path-body">
          <div class="path-topic">
            <strong>这条路径为什么相关</strong>
            <span>${escapeHtml(path.whyRelevant)}</span>
          </div>
          <div class="person-list">${cards}</div>
        </div>
      </section>
    `;
  };
})();
