(function () {
  const App = window.LifeSampleApp || (window.LifeSampleApp = {});
  App.views = App.views || {};

  App.views.renderReadingView = function renderReadingView(state) {
    const { escapeHtml, escapeAttribute } = App.utils;
    const person = App.store.findPerson(state.selectedPersonId);
    if (!person) {
      return `${App.components.renderTopBar(state)}<section class="empty-panel"><h2>没有找到这篇原文</h2><p>回到相似经历里重新选择一个人物样本。</p><button class="btn-s" type="button" data-action="open-feed">返回</button></section>`;
    }

    const paragraphs = person.article.paragraphs.map((paragraph) => `<p>${escapeHtml(paragraph)}</p>`).join("");
    const saved = App.store.isInBook(person.id);

    return `
      ${App.components.renderTopBar(state)}
      <main class="reading-main">
        <button class="btn-text" type="button" data-action="open-feed">← 返回</button>
        <h1 class="article-title">${escapeHtml(person.name)}的原文</h1>
        <p class="article-source">${escapeHtml(person.source.title)}</p>
        <div class="article-evidence quote">${escapeHtml(person.source.evidence)}</div>
        <article class="article-body">${paragraphs}</article>
      </main>
      <footer class="fixed-bar">
        <button class="btn-s" type="button" data-action="open-feed">← 返回</button>
        <div class="reading-actions">
          <button class="btn-text ${saved ? "is-active" : ""}" type="button" data-action="add-book" data-person-id="${escapeAttribute(person.id)}">${saved ? "已留下" : "留下样本"}</button>
          <button class="btn-s" type="button" data-action="open-chat" data-person-id="${escapeAttribute(person.id)}">听听 TA 会怎么说</button>
          <form class="fixed-note-form" data-form="note" data-person-id="${escapeAttribute(person.id)}">
            <label class="sr-only" for="note-${escapeAttribute(person.id)}">给 TA 写一句话</label>
            <input class="message-input" id="note-${escapeAttribute(person.id)}" name="note" placeholder="给 TA 写一句话……" />
            <button class="btn-text note-save" type="submit">留下</button>
          </form>
        </div>
      </footer>
    `;
  };
})();
