(function () {
  const App = window.LifeSampleApp || (window.LifeSampleApp = {});
  App.views = App.views || {};

  App.views.renderBookView = function renderBookView(state) {
    const { escapeHtml, escapeAttribute } = App.utils;
    const icon = App.components.renderIcon;
    const items = state.bookItems.map((item) => {
      const person = App.store.findPerson(item.personId);
      if (!person) {
        return "";
      }
      return `
        <article class="book-block">
          <h2 class="book-name">${escapeHtml(person.name)}</h2>
          <p class="book-text">${escapeHtml(person.representativeQuote || person.article?.paragraphs?.[0] || person.experienceSummary)}</p>
          <button class="btn-text" type="button" data-action="open-original" data-person-id="${escapeAttribute(person.id)}">${icon("book-open")}展开原文</button>
        </article>
      `;
    }).join("");

    return `
      ${App.components.renderTopBar(state)}
      <main class="book-main">
        <p class="book-kicker">我想留下的样本</p>
        <h1 class="book-title">你不是在寻找一个标准答案，而是在确认哪些代价是你愿意承担的。</h1>
        <div class="book-query quote">${escapeHtml(state.query || state.pendingQuery || App.mockData.defaultQuery)}</div>
        ${items || "<p class=\"book-text\">还没有样本，回到相似经历里留下一位。</p>"}
        <div class="divider"></div>
        <div class="book-actions">
          <button class="btn-s" type="button" data-action="open-capsule">${icon("clock")}写给三年后的自己</button>
          <button class="btn-s" type="button" data-action="open-feed">${icon("arrow-left")}继续找相似的人</button>
        </div>
      </main>
    `;
  };
})();
