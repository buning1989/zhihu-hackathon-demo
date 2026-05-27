(function () {
  const App = window.LifeSampleApp || (window.LifeSampleApp = {});
  App.components = App.components || {};

  function textOf(value) {
    if (typeof value === "string") {
      return value.trim();
    }
    if (value && typeof value === "object") {
      return String(value.event || value.text || value.content || value.value || "").trim();
    }
    return "";
  }

  function firstText(values) {
    return values.map(textOf).find(Boolean) || "";
  }

  function sourceParagraphs(person) {
    const article = person.article || {};
    const feedSnippet = textOf(person.snippet);
    if (feedSnippet) {
      return [feedSnippet];
    }

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

  function renderAvatar(person, escapeHtml, escapeAttribute) {
    if (person.avatar) {
      return `<img src="${escapeAttribute(person.avatar)}" alt="" />`;
    }
    return `<span class="avatar-fallback" aria-hidden="true">${escapeHtml((person.name || "样").slice(0, 1))}</span>`;
  }

  function buildMarkdownSummary(person, path, state) {
    const backendMarkdown = textOf(person.summaryPayload?.markdown);
    if (hasRequiredSummaryHeadings(backendMarkdown)) {
      return backendMarkdown;
    }

    const article = person.article || {};
    const paragraphs = sourceParagraphs(person);
    const evidenceText = firstText([
      person.source?.evidence,
      article.evidence?.[0]?.text,
      article.evidence?.[0]?.evidenceText,
      article.lead,
      article.summary,
      paragraphs[0]
    ]);
    const choiceText = firstText([
      person.timeline?.[0]?.event,
      paragraphs[1],
      paragraphs[0],
      person.representativeQuote
    ]);
    const title = firstText([person.sourceTitle, article.title, person.source?.title, "知乎公开内容"]);
    const pathLabel = App.utils.publicUiLabel(person.directionLabel || path?.shortTitle || path?.title, "公开内容方向");
    const query = firstText([state.query, state.pendingQuery, "当前问题"]);

    if (!evidenceText && !choiceText) {
      return [
        "### 这个样本讲了什么",
        "这条样本目前只保留了很短的来源信息，无法扩写成完整经历。",
        "### 这个人的关键选择或变化",
        "现有 source evidence 没有提供足够的选择、变化或后续结果线索。",
        "### 对当前问题有什么参考价值",
        `它暂时只能作为「${query}」下的来源入口，参考范围限于原文可核对内容。`
      ].join("\n\n");
    }

    return [
      "### 这个样本讲了什么",
      `这条样本来自「${title}」。原文片段显示：${evidenceText || choiceText}`,
      "### 这个人的关键选择或变化",
      choiceText
        ? `可确认的选择或变化是：${choiceText}`
        : "现有片段没有提供更明确的选择、变化或后续结果，因此不补写额外情节。",
      "### 对当前问题有什么参考价值",
      `它和「${query}」的关联在于同属「${pathLabel}」这一方向，能作为一个可回到原文核对的对照样本。`
    ].join("\n\n");
  }

  function hasRequiredSummaryHeadings(markdown) {
    return [
      "### 这个样本讲了什么",
      "### 这个人的关键选择或变化",
      "### 对当前问题有什么参考价值"
    ].every((heading) => markdown.includes(heading));
  }

  function renderMarkdown(markdown, escapeHtml) {
    return markdown.split(/\n{2,}/).map((block) => {
      const heading = block.match(/^###\s+(.+)$/);
      if (heading) {
        return `<h4>${escapeHtml(heading[1])}</h4>`;
      }
      return `<p>${escapeHtml(block)}</p>`;
    }).join("");
  }

  function renderExperience(person, path, state) {
    if (state.expandedExperiencePersonId !== person.id) {
      return "";
    }

    const { escapeHtml } = App.utils;
    const markdown = buildMarkdownSummary(person, path, state);

    return `
      <section class="experience-inline summary-inline" aria-label="内容总结">
        ${renderMarkdown(markdown, escapeHtml)}
      </section>
    `;
  }

  App.components.renderPersonCard = function renderPersonCard(person, state) {
    const { escapeHtml, escapeAttribute, publicUiLabel } = App.utils;
    const icon = App.components.renderIcon;
    const saved = App.store.isInBook(person.id);
    const experienceExpanded = state.expandedExperiencePersonId === person.id;
    const article = person.article || {};
    const brief = person.sourceTitle || article.title || person.source?.title || "知乎公开内容样本";
    const platform = publicUiLabel(person.sourcePlatform || article.sourceName || "知乎", "知乎");
    const path = App.store.findPath(person.pathId);
    const pathLabel = publicUiLabel(person.directionLabel || path?.shortTitle || path?.title || person.matchedPathTitle, "公开内容方向");
    const sourceUrl = person.sourceUrl || person.source?.url || article.sourceUrl || article.url || "";
    const meta = `${publicUiLabel(brief, "知乎公开内容样本")} · ${platform} · ${pathLabel}`;
    const snippet = keySnippet(person).map((paragraph) => escapeHtml(paragraph)).join("<br />");
    const avatar = renderAvatar(person, escapeHtml, escapeAttribute);
    const originalAction = sourceUrl
      ? `<a class="btn-text read-link" href="${escapeAttribute(sourceUrl)}" target="_blank" rel="noopener noreferrer">${icon("book-open")}查看原文</a>`
      : `<button class="btn-text read-link" type="button" disabled>${icon("book-open")}查看原文</button>`;

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
        <footer class="person-actions">
          <button class="btn-text" type="button" data-action="toggle-experience" data-person-id="${escapeAttribute(person.id)}" aria-expanded="${experienceExpanded ? "true" : "false"}">${icon(experienceExpanded ? "chevron-up" : "file-text")}${experienceExpanded ? "收起总结" : "内容总结"}</button>
          ${originalAction}
          <button class="btn-text ${saved ? "is-active" : ""} ml-auto" type="button" data-action="add-book" data-person-id="${escapeAttribute(person.id)}">${icon(saved ? "bookmark-check" : "bookmark")}${saved ? "已收藏" : "收藏样本"}</button>
        </footer>
      </article>
    `;
  };
})();
