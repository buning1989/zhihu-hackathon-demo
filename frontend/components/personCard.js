(function () {
  const App = window.LifeSampleApp || (window.LifeSampleApp = {});
  App.components = App.components || {};

  App.components.renderPersonCard = function renderPersonCard(person, state) {
    const { escapeHtml, escapeAttribute } = App.utils;
    const icon = App.components.renderIcon;
    const saved = App.store.isInBook(person.id);
    const expanded = state.expandedPersonId === person.id;
    const isProductionSample = Boolean(person.isProductionSample);
    const quote = person.representativeQuote || person.source?.evidence || person.article?.paragraphs?.[0] || person.experienceSummary;
    const preview = person.experienceSummary;
    const brief = person.article?.title || person.source?.title || "知乎公开经历样本";
    const path = App.store.findPath(person.pathId);
    const similarLabels = {
      "path-reset": "也经历过长期消耗",
      "path-city": "也试着换个环境",
      "path-skill": "也在慢慢攒底气"
    };
    const similar = isProductionSample ? "证据样本" : similarLabels[person.pathId] || "相似处境";
    const meta = `${brief} · ${similar}`;
    const relevanceReason = path?.whyRelevant || person.source?.evidence || "";
    const timelineItems = Array.isArray(person.timeline) && person.timeline.length
      ? person.timeline
      : isProductionSample
        ? []
        : [
          { date: "开始", event: person.article?.paragraphs?.[0] || person.experienceSummary },
          { date: "中段", event: person.article?.paragraphs?.[1] || person.source?.evidence || person.experienceSummary },
          { date: "复盘", event: person.article?.paragraphs?.[2] || person.article?.lead || person.experienceSummary }
        ];
    const details = expanded ? `
      <section class="timeline-inline">
        ${timelineItems.map((item, index) => `
          <div class="timeline-item">
            <div class="timeline-date">${escapeHtml(item.date)}</div>
            <div class="timeline-rail">
              <span class="timeline-dot"></span>
              ${index === timelineItems.length - 1 ? "" : "<span class=\"timeline-line\"></span>"}
            </div>
            <div class="timeline-event">${escapeHtml(item.event)}</div>
          </div>
        `).join("")}
        ${relevanceReason ? `<p class="relevance-note">为什么相关：${escapeHtml(relevanceReason)}</p>` : ""}
      </section>
    ` : "";
    const avatar = person.avatar
      ? `<img src="${escapeAttribute(person.avatar)}" alt="" />`
      : `<span class="avatar-fallback" aria-hidden="true">${escapeHtml((person.name || "样").slice(0, 1))}</span>`;
    const detailLabel = isProductionSample ? "证据片段" : "TA 的经历";
    const readLabel = isProductionSample ? "查看来源" : "读原文 →";

    return `
      <article class="person-card">
        <header class="person-head">
          <span class="avatar" aria-hidden="true">${avatar}</span>
          <div>
            <h3 class="name">${escapeHtml(person.name)}</h3>
            <p class="person-meta">${escapeHtml(meta)}</p>
          </div>
        </header>
        <div class="person-quote">${escapeHtml(quote)}</div>
        <p class="person-preview">${escapeHtml(preview)}</p>
        ${details}
        <footer class="person-actions">
          <button class="btn-text" type="button" data-action="toggle-experience" data-person-id="${escapeAttribute(person.id)}">${icon(expanded ? "chevron-up" : "chevron-down")}${expanded ? "收起" : detailLabel}</button>
          <button class="btn-text ${saved ? "is-active" : ""}" type="button" data-action="add-book" data-person-id="${escapeAttribute(person.id)}">${icon(saved ? "bookmark-check" : "bookmark")}${saved ? "已留下" : "留下样本"}</button>
          <button class="btn-text read-link ml-auto" type="button" data-action="open-reading" data-person-id="${escapeAttribute(person.id)}">${icon("book-open")}${readLabel}</button>
        </footer>
      </article>
    `;
  };
})();
