(function () {
  const App = window.LifeSampleApp || (window.LifeSampleApp = {});
  App.views = App.views || {};

  App.views.renderBookView = function renderBookView(state) {
    const { escapeHtml, escapeAttribute } = App.utils;
    const items = state.bookItems.map((item) => {
      const person = App.store.findPerson(item.personId);
      if (!person) {
        return "";
      }
      return `
        <article class="book-block">
          <h2 class="book-name">${escapeHtml(person.name)}</h2>
          <p class="book-text">${escapeHtml(person.article?.paragraphs?.[0] || person.experienceSummary)}</p>
          <button class="btn-text" type="button" data-action="open-reading" data-person-id="${escapeAttribute(person.id)}">读原文 →</button>
        </article>
      `;
    }).join("");

    return `
      ${App.components.renderTopBar(state)}
      <main class="book-main">
        <p class="book-kicker">我的路书</p>
        <h1 class="book-title">你不是在寻找一个标准答案，而是在确认哪些代价是你愿意承担的。</h1>
        <div class="quote" style="margin-bottom:24px;">${escapeHtml(state.query || state.pendingQuery || App.mockData.defaultQuery)}</div>
        ${items || "<p class=\"book-text\">还没有样本，回到路径 Feed 加入一个。</p>"}
        <div class="divider"></div>
        <div class="book-actions">
          <button class="btn-p" type="button" data-action="open-capsule">写给三年后的自己</button>
          <button class="btn-s" type="button" data-action="open-feed">继续找相似的人</button>
        </div>
      </main>
    `;
  };
})();
