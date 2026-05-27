(function () {
  const App = window.LifeSampleApp || (window.LifeSampleApp = {});
  App.components = App.components || {};

  function textOf(value) {
    if (typeof value === "string") {
      return value.trim();
    }
    if (value && typeof value === "object") {
      return String(value.text || value.evidenceText || value.excerpt || value.content || value.value || "").trim();
    }
    return "";
  }

  function articleParagraphs(person) {
    const article = person.article || {};
    const paragraphs = Array.isArray(article.paragraphs)
      ? article.paragraphs.map(textOf).filter(Boolean)
      : [];
    if (paragraphs.length) {
      return paragraphs;
    }

    const evidence = Array.isArray(article.evidence)
      ? article.evidence.map(textOf).filter(Boolean)
      : [];
    if (evidence.length) {
      return evidence;
    }

    return [
      person.representativeQuote,
      person.source?.evidence,
      article.lead
    ].map(textOf).filter(Boolean);
  }

  function canChatWithPerson(person) {
    return !person?.isProductionSample && Boolean(
      person?.displayCanChat
      || person?.aiPersona?.canChat
      || (person?.aiPersona?.enabled && person?.aiPersona?.personaId)
    );
  }

  function renderChat(person, state) {
    if (state.modal.panel !== "chat") {
      return "";
    }

    const { escapeHtml, escapeAttribute } = App.utils;
    const icon = App.components.renderIcon;
    const thread = state.chatThreads[person.id] || [];
    const messages = thread.map((message) => `
      <div class="bubble ${message.role === "user" ? "user" : "ai"}">${escapeHtml(message.text)}</div>
    `).join("");
    const boundary = person.aiPersona?.boundary || "基于知乎公开内容生成，不代表作者本人。";

    return `
      <section class="reading-modal-panel" aria-label="继续对话">
        <p class="inline-boundary">${escapeHtml(boundary)}</p>
        <div class="chat-messages reading-chat-messages">${messages}</div>
        <form class="chat-row reading-chat-row" data-form="chat" data-person-id="${escapeAttribute(person.id)}">
          <label class="sr-only" for="reading-chat-${escapeAttribute(person.id)}">继续追问这段内容</label>
          <input class="chat-input" id="reading-chat-${escapeAttribute(person.id)}" name="message" placeholder="继续问这段内容背后的细节……" />
          <button class="btn-text chat-send" type="submit">${icon("send")}送出</button>
        </form>
      </section>
    `;
  }

  function renderMessage(person, state) {
    if (state.modal.panel !== "message") {
      return "";
    }

    const { escapeAttribute } = App.utils;
    const icon = App.components.renderIcon;

    return `
      <section class="reading-modal-panel" aria-label="写一句备注">
        <p class="inline-boundary">先把这条样本留在这里。</p>
        <form class="message-row reading-message-row" data-form="note" data-person-id="${escapeAttribute(person.id)}">
          <label class="sr-only" for="reading-note-${escapeAttribute(person.id)}">给这条内容写一句备注</label>
          <input class="message-input" id="reading-note-${escapeAttribute(person.id)}" name="note" placeholder="先把这条样本留在这里。" />
          <button class="btn-text note-save" type="submit">${icon("bookmark")}留下</button>
        </form>
      </section>
    `;
  }

  function renderChatBlocked(state) {
    if (state.modal.panel !== "chat-blocked") {
      return "";
    }

    return `
      <section class="reading-modal-panel reading-chat-blocked" aria-label="暂不适合继续追问">
        这段公开内容太少，暂时不适合继续追问。
      </section>
    `;
  }

  App.components.renderReadingModal = function renderReadingModal(state) {
    if (state.modal.type !== "reading") {
      return "";
    }

    const { escapeHtml, escapeAttribute, publicUiLabel } = App.utils;
    const icon = App.components.renderIcon;
    const person = App.store.findPerson(state.modal.personId);
    if (!person) {
      return "";
    }

    const article = person.article || {};
    const sourceName = publicUiLabel(article.sourceName || "知乎公开内容", "知乎公开内容");
    const title = publicUiLabel(article.title || person.source?.title, "知乎公开内容");
    const paragraphs = articleParagraphs(person);
    const body = paragraphs.length
      ? paragraphs.map((paragraph) => `<p>${escapeHtml(paragraph)}</p>`).join("")
      : "<p>当前只展示可追溯公开内容片段。</p>";
    const sourceUrl = person.source?.url || article.sourceUrl || "";
    const isProductionSample = Boolean(person.isProductionSample);
    const saved = App.store.isInBook(person.id);
    const chatButtonClass = canChatWithPerson(person) ? "reading-primary" : "";
    const chatOrSourceButton = isProductionSample
      ? sourceUrl
        ? `<a class="btn-text" href="${escapeAttribute(sourceUrl)}" target="_blank" rel="noopener noreferrer">${icon("book-open")}查看来源</a>`
        : ""
      : `<button class="btn-text ${chatButtonClass}" type="button" data-action="toggle-inline-chat" data-person-id="${escapeAttribute(person.id)}">${icon("message-circle")}继续对话</button>`;

    return `
      <div class="modal-overlay reading-modal-overlay" role="presentation" data-action="close-modal"></div>
      <section class="reading-modal" role="dialog" aria-modal="true" aria-labelledby="reading-modal-title" data-stop-close>
        <header class="reading-modal-head">
          <div>
            <p>${escapeHtml(isProductionSample ? `来源片段 · ${sourceName}` : `${person.name} · ${sourceName}`)}</p>
            <h2 id="reading-modal-title">${escapeHtml(title)}</h2>
          </div>
          <button class="btn-text" type="button" data-action="close-modal" aria-label="关闭阅读浮层">${icon("x")}关闭</button>
        </header>
        <div class="reading-modal-scroll">
          <article class="article-body reading-modal-body">${body}</article>
        </div>
        <footer class="reading-modal-actions" aria-label="来源操作">
          ${chatOrSourceButton}
          <button class="btn-text" type="button" data-action="toggle-inline-message" data-person-id="${escapeAttribute(person.id)}">${icon("reply")}写一句备注</button>
          <button class="btn-text ${saved ? "is-active" : ""}" type="button" data-action="add-book" data-person-id="${escapeAttribute(person.id)}">${icon(saved ? "bookmark-check" : "bookmark")}${saved ? "已收藏" : "收藏样本"}</button>
        </footer>
        ${renderChatBlocked(state)}
        ${renderChat(person, state)}
        ${renderMessage(person, state)}
      </section>
    `;
  };
})();
