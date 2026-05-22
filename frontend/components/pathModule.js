(function () {
  const App = window.LifeSampleApp || (window.LifeSampleApp = {});
  App.components = App.components || {};

  App.components.renderPathModule = function renderPathModule(path, people, state) {
    const { escapeHtml, escapeAttribute } = App.utils;
    const icon = App.components.renderIcon;
    const cards = people.map((person) => App.components.renderPersonCard(person, state)).join("");

    return `
      <section class="path-module">
        <header class="path-head">
          <div>
            <h2 class="path-title">${escapeHtml(path.title)}</h2>
            <div class="quote">${escapeHtml(path.representativeQuote || path.summary)}</div>
          </div>
          <button class="path-count-btn" type="button" data-action="open-people" data-path-id="${escapeAttribute(path.id)}">${icon("users")}${people.length} 人 ›</button>
        </header>
        <div class="people-row">${cards}</div>
      </section>
    `;
  };
})();
