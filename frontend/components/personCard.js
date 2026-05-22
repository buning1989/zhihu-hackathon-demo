(function () {
  const App = window.LifeSampleApp || (window.LifeSampleApp = {});
  App.components = App.components || {};

  const clueLabels = ["开始", "转折", "后来"];

  function textOf(value) {
    if (typeof value === "string") {
      return value.trim();
    }
    if (value && typeof value === "object") {
      return String(value.event || value.text || value.content || value.value || "").trim();
    }
    return "";
  }

  function sourceParagraphs(person) {
    const article = person.article || {};
    const paragraphs = Array.isArray(article.paragraphs)
      ? article.paragraphs.map(textOf).filter(Boolean)
      : [];
    if (paragraphs.length) {
      return paragraphs;
    }

    const evidence = Array.isArray(article.evidence)
      ? article.evidence.map((item) => textOf(item.text || item.evidenceText || item.excerpt)).filter(Boolean)
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

  function keySnippet(person) {
    const paragraphs = sourceParagraphs(person);
    if (!paragraphs.length) {
      return ["这条公开内容目前只有较短片段，展开后可以对照查看。"];
    }
    return paragraphs.slice(0, 2);
  }

  function readerParagraphs(person) {
    const paragraphs = sourceParagraphs(person);
    if (!paragraphs.length) {
      return [];
    }
    return paragraphs.slice(keySnippet(person).length, 6);
  }

  function experienceClues(person) {
    const timeline = Array.isArray(person.timeline) && person.timeline.length
      ? person.timeline
      : sourceParagraphs(person);
    return timeline.slice(0, 3).map((item, index) => ({
      label: clueLabels[index] || `线索 ${index + 1}`,
      text: textOf(item)
    })).filter((item) => item.text);
  }

  function renderAvatar(person, escapeHtml, escapeAttribute) {
    if (person.avatar) {
      return `<img src="${escapeAttribute(person.avatar)}" alt="" />`;
    }
    return `<span class="avatar-fallback" aria-hidden="true">${escapeHtml((person.name || "样").slice(0, 1))}</span>`;
  }

  function renderExperience(person, path, state) {
    if (state.expandedExperiencePersonId !== person.id) {
      return "";
    }

    const { escapeHtml } = App.utils;
    const reason = person.fitReason || person.match?.reason || path?.whyRelevant || "这段公开经历和你的问题有相近的约束，可以作为一个对照样本。";
    const clues = experienceClues(person);

    return `
      <section class="experience-inline" aria-label="TA 的经历">
        <div class="experience-block">
          <p class="experience-label">为什么和你相关</p>
          <p class="experience-text">${escapeHtml(reason)}</p>
        </div>
        ${clues.length ? `
          <div class="experience-block">
            <p class="experience-label">经历线索</p>
            <ol class="experience-clues">
              ${clues.map((item) => `
                <li>
                  <span>${escapeHtml(item.label)}</span>
                  <p>${escapeHtml(item.text)}</p>
                </li>
              `).join("")}
            </ol>
          </div>
        ` : ""}
      </section>
    `;
  }

  function renderInlineChat(person, state) {
    if (state.inlineChatPersonId !== person.id) {
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
      <section class="inline-chat" aria-label="经验回声">
        <p class="inline-boundary">${escapeHtml(boundary)}</p>
        <div class="chat-messages inline-chat-messages">
          ${messages}
        </div>
        <form class="chat-row inline-chat-row" data-form="chat" data-person-id="${escapeAttribute(person.id)}">
          <label class="sr-only" for="inline-chat-${escapeAttribute(person.id)}">继续追问这段经历</label>
          <input class="chat-input" id="inline-chat-${escapeAttribute(person.id)}" name="message" placeholder="继续问这个选择背后的细节……" />
          <button class="btn-text chat-send" type="submit">${icon("send")}送出</button>
        </form>
      </section>
    `;
  }

  function renderInlineMessage(person, state) {
    if (state.inlineMessagePersonId !== person.id) {
      return "";
    }

    const { escapeAttribute } = App.utils;
    const icon = App.components.renderIcon;

    return `
      <section class="inline-message" aria-label="写给 TA 一句话">
        <p class="inline-boundary">这只是你的私密记录，不会承诺发送给作者本人。</p>
        <form class="message-row" data-form="note" data-person-id="${escapeAttribute(person.id)}">
          <label class="sr-only" for="inline-note-${escapeAttribute(person.id)}">写给 TA 一句话</label>
          <input class="message-input" id="inline-note-${escapeAttribute(person.id)}" name="note" placeholder="先把这句话留在这里。" />
          <button class="btn-text note-save" type="submit">${icon("bookmark")}留下</button>
        </form>
      </section>
    `;
  }

  function renderInlineChatBlocked(person, state) {
    if (state.inlineChatBlockedPersonId !== person.id) {
      return "";
    }

    return `
      <section class="inline-chat-blocked" aria-label="暂不适合继续追问">
        这段公开内容太少，暂时不适合继续追问。
      </section>
    `;
  }

  function renderInlineReader(person, state, saved) {
    if (state.expandedOriginalPersonId !== person.id) {
      return "";
    }

    const { escapeHtml, escapeAttribute } = App.utils;
    const icon = App.components.renderIcon;
    const paragraphs = readerParagraphs(person);
    const body = paragraphs.map((paragraph) => `<p>${escapeHtml(paragraph)}</p>`).join("");

    return `
      <section class="inline-reader" aria-label="原文片段">
        ${body ? `<article class="inline-reader-body">${body}</article>` : ""}
        <p class="inline-reader-source">来自知乎公开内容</p>
        <footer class="inline-reader-actions">
          <button class="btn-text inline-primary" type="button" data-action="toggle-inline-chat" data-person-id="${escapeAttribute(person.id)}">${icon("message-circle")}听听 TA 会怎么说</button>
          <button class="btn-text" type="button" data-action="toggle-inline-message" data-person-id="${escapeAttribute(person.id)}">${icon("reply")}写给 TA 一句话</button>
          <button class="btn-text ${saved ? "is-active" : ""}" type="button" data-action="add-book" data-person-id="${escapeAttribute(person.id)}">${icon(saved ? "bookmark-check" : "bookmark")}${saved ? "已留下" : "留下样本"}</button>
          <button class="btn-text ml-auto" type="button" data-action="toggle-original" data-person-id="${escapeAttribute(person.id)}">${icon("chevron-up")}收起原文</button>
        </footer>
        ${renderInlineChatBlocked(person, state)}
        ${renderInlineChat(person, state)}
        ${renderInlineMessage(person, state)}
      </section>
    `;
  }

  App.components.renderPersonCard = function renderPersonCard(person, state) {
    const { escapeHtml, escapeAttribute, publicUiLabel } = App.utils;
    const icon = App.components.renderIcon;
    const saved = App.store.isInBook(person.id);
    const experienceExpanded = state.expandedExperiencePersonId === person.id;
    const originalExpanded = state.expandedOriginalPersonId === person.id;
    const brief = person.article?.title || person.source?.title || "知乎公开经历样本";
    const path = App.store.findPath(person.pathId);
    const pathLabel = publicUiLabel(path?.shortTitle || path?.title, "相似处境");
    const meta = `${publicUiLabel(brief, "知乎公开经历样本")} · ${pathLabel}`;
    const snippet = keySnippet(person).map((paragraph) => escapeHtml(paragraph)).join("<br />");
    const avatar = renderAvatar(person, escapeHtml, escapeAttribute);

    return `
      <article class="person-card">
        <header class="person-head">
          <span class="avatar" aria-hidden="true">${avatar}</span>
          <div>
            <h3 class="name">${escapeHtml(person.name)}</h3>
            <p class="person-meta">${escapeHtml(meta)}</p>
          </div>
        </header>
        <div class="original-snippet">${snippet}</div>
        ${renderExperience(person, path, state)}
        ${originalExpanded ? "" : `
        <footer class="person-actions">
          <button class="btn-text" type="button" data-action="toggle-experience" data-person-id="${escapeAttribute(person.id)}" aria-expanded="${experienceExpanded ? "true" : "false"}">${icon(experienceExpanded ? "chevron-up" : "chevron-down")}${experienceExpanded ? "收起经历" : "TA 的经历"}</button>
          <button class="btn-text ${saved ? "is-active" : ""}" type="button" data-action="add-book" data-person-id="${escapeAttribute(person.id)}">${icon(saved ? "bookmark-check" : "bookmark")}${saved ? "已留下" : "留下样本"}</button>
          <button class="btn-text read-link ml-auto" type="button" data-action="toggle-original" data-person-id="${escapeAttribute(person.id)}" aria-expanded="${originalExpanded ? "true" : "false"}">${icon(originalExpanded ? "chevron-up" : "book-open")}${originalExpanded ? "收起原文" : "展开原文"}</button>
        </footer>
        `}
        ${renderInlineReader(person, state, saved)}
      </article>
    `;
  };
})();
