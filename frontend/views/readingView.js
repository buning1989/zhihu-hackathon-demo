(function () {
  const App = window.LifeSampleApp || (window.LifeSampleApp = {});
  App.views = App.views || {};

  App.views.renderReadingView = function renderReadingView(state) {
    const { escapeHtml, escapeAttribute } = App.utils;
    const icon = App.components.renderIcon;
    const person = App.store.findPerson(state.selectedPersonId);
    if (!person) {
      return `${App.components.renderTopBar(state)}<section class="empty-panel"><h2>没有找到这篇原文</h2><p>回到相似经历里重新选择一个人物样本。</p><button class="btn-s" type="button" data-action="open-feed">${icon("arrow-left")}返回</button></section>`;
    }

    const article = person.article || {};
    const paragraphs = Array.isArray(article.paragraphs) ? article.paragraphs : [];
    const sourceUrl = person.source?.url || article.sourceUrl || "";
    const evidenceText = person.source?.evidence || person.representativeQuote || article.lead || person.experienceSummary || "";
    const articleBody = paragraphs.length
      ? paragraphs.map((paragraph) => `<p>${escapeHtml(paragraph)}</p>`).join("")
      : `<p>${escapeHtml(evidenceText || "当前只有可追溯来源片段，暂无更完整原文。")}</p>`;
    const isProductionSample = Boolean(person.isProductionSample);
    const saved = App.store.isInBook(person.id);
    const canChat = Boolean(
      person.displayCanChat
      || person.aiPersona?.canChat
      || (person.aiPersona?.enabled && person.aiPersona?.personaId)
    );
    const chatOrSourceAction = canChat
      ? `<button class="btn-s" type="button" data-action="open-chat" data-person-id="${escapeAttribute(person.id)}">${icon("message-circle")}听听 TA 会怎么说</button>`
      : sourceUrl
        ? `<a class="btn-s" href="${escapeAttribute(sourceUrl)}" target="_blank" rel="noopener noreferrer">${icon("book-open")}查看来源</a>`
        : "";

    return `
      ${App.components.renderTopBar(state)}
      <main class="reading-main">
        <button class="btn-text" type="button" data-action="open-feed">${icon("arrow-left")}返回</button>
        <h1 class="article-title">${escapeHtml(isProductionSample ? "来源片段" : `${person.name}的原文`)}</h1>
        <p class="article-source">${escapeHtml(person.source?.title || "知乎公开内容")}</p>
        <div class="article-evidence quote">${escapeHtml(evidenceText)}</div>
        <article class="article-body">${articleBody}</article>
        <section class="reading-actions legacy-reading-actions" aria-label="原文操作">
          <button class="btn-text ${saved ? "is-active" : ""}" type="button" data-action="add-book" data-person-id="${escapeAttribute(person.id)}">${icon(saved ? "bookmark-check" : "bookmark")}${saved ? "已留下" : "留下样本"}</button>
          ${chatOrSourceAction}
          <form class="fixed-note-form" data-form="note" data-person-id="${escapeAttribute(person.id)}">
            <label class="sr-only" for="note-${escapeAttribute(person.id)}">给 TA 写一句话</label>
            <input class="message-input" id="note-${escapeAttribute(person.id)}" name="note" placeholder="先把这句话留在这里。" />
            <button class="btn-text note-save" type="submit">${icon("bookmark")}留下</button>
          </form>
        </section>
      </main>
    `;
  };
})();
