(function () {
  const App = window.LifeSampleApp || (window.LifeSampleApp = {});
  App.views = App.views || {};

  App.views.renderReadingView = function renderReadingView(state) {
    const { escapeHtml, escapeAttribute } = App.utils;
    const icon = App.components.renderIcon;
    const person = App.store.findPerson(state.selectedPersonId);
    if (!person) {
      return `${App.components.renderTopBar(state)}<section class="empty-panel"><h2>没有找到这条来源片段</h2><p>回到样本列表里重新选择一条公开内容。</p><button class="btn-s" type="button" data-action="open-feed">${icon("arrow-left")}返回</button></section>`;
    }

    const article = person.article || {};
    const paragraphs = Array.isArray(article.paragraphs) ? article.paragraphs : [];
    const sourceUrl = person.source?.url || article.sourceUrl || "";
    const evidenceText = person.source?.evidence || person.representativeQuote || article.lead || person.oneLine || person.experienceSummary || "";
    const articleBody = paragraphs.length
      ? paragraphs
        .map((paragraph) => App.utils.publicUiLabel(paragraph, "当前只展示可追溯公开内容片段。"))
        .map((paragraph) => `<p>${escapeHtml(paragraph)}</p>`)
        .join("")
      : `<p>${escapeHtml(App.utils.publicUiLabel(evidenceText, "当前只展示可追溯片段。"))}</p>`;
    const isProductionSample = Boolean(person.isProductionSample);
    const saved = App.store.isInBook(person.id);
    const hasLlmEvidence = String(person.evidenceStatus || person.aiPersona?.evidenceStatus || "llm_extracted") === "llm_extracted";
    const canChat = !isProductionSample && hasLlmEvidence && Boolean(
      person.displayCanChat
      || person.aiPersona?.canChat
      || (person.aiPersona?.enabled && person.aiPersona?.personaId)
    );
    const chatOrSourceAction = canChat
      ? `<button class="btn-s" type="button" data-action="open-chat" data-person-id="${escapeAttribute(person.id)}">${icon("message-circle")}继续对话</button>`
      : sourceUrl
        ? `<a class="btn-s" href="${escapeAttribute(sourceUrl)}" target="_blank" rel="noopener noreferrer">${icon("book-open")}查看来源</a>`
        : "";

    return `
      ${App.components.renderTopBar(state)}
      <main class="reading-main">
        <button class="btn-text" type="button" data-action="open-feed">${icon("arrow-left")}返回</button>
        <h1 class="article-title">${escapeHtml(isProductionSample ? "来源片段" : `${person.name}的公开内容`)}</h1>
        <p class="article-source">${escapeHtml(person.source?.title || "知乎公开内容")}</p>
        <div class="article-evidence quote">${escapeHtml(evidenceText)}</div>
        <article class="article-body">${articleBody}</article>
        <section class="reading-actions legacy-reading-actions" aria-label="来源操作">
          <button class="btn-text ${saved ? "is-active" : ""}" type="button" data-action="add-book" data-person-id="${escapeAttribute(person.id)}">${icon(saved ? "bookmark-check" : "bookmark")}${saved ? "已收藏" : "收藏样本"}</button>
          ${chatOrSourceAction}
          <form class="fixed-note-form" data-form="note" data-person-id="${escapeAttribute(person.id)}">
            <label class="sr-only" for="note-${escapeAttribute(person.id)}">给这条内容写一句备注</label>
            <input class="message-input" id="note-${escapeAttribute(person.id)}" name="note" placeholder="先把这条样本留在这里。" />
            <button class="btn-text note-save" type="submit">${icon("bookmark")}留下</button>
          </form>
        </section>
      </main>
    `;
  };
})();
