(function () {
  const App = window.LifeSampleApp || (window.LifeSampleApp = {});
  App.components = App.components || {};

  App.components.renderPersonCard = function renderPersonCard(person, state) {
    const { escapeHtml, escapeAttribute } = App.utils;
    const icon = App.components.renderIcon;
    const saved = App.store.isInBook(person.id);
    const expanded = state.expandedPersonId === person.id;
    const quote = person.article?.paragraphs?.[0] || person.experienceSummary;
    const preview = person.experienceSummary;
    const brief = person.article?.title || person.source?.title || "知乎公开经历样本";
    const similarLabels = {
      "path-reset": "也经历过长期消耗",
      "path-city": "也试着换个环境",
      "path-skill": "也在慢慢攒底气"
    };
    const similar = similarLabels[person.pathId] || "相似处境";
    const meta = `${brief} · ${similar}`;
    const timelineItems = person.timeline || [
      { date: "开始", event: person.article?.paragraphs?.[0] || person.experienceSummary },
      { date: "中段", event: person.article?.paragraphs?.[1] || person.source?.evidence || person.experienceSummary },
      { date: "复盘", event: person.article?.paragraphs?.[2] || person.article?.lead || person.experienceSummary }
    ];
    const timeline = expanded ? `
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
      </section>
    ` : "";

    return `
      <article class="person-card">
        <header class="person-head">
          <span class="avatar" aria-hidden="true"><img src="${escapeAttribute(person.avatar)}" alt="" /></span>
          <div>
            <h3 class="name">${escapeHtml(person.name)}</h3>
            <p class="person-meta">${escapeHtml(meta)}</p>
          </div>
        </header>
        <div class="person-quote">${escapeHtml(quote)}</div>
        <p class="person-preview">${escapeHtml(preview)}</p>
        ${timeline}
        <footer class="person-actions">
          <button class="btn-text" type="button" data-action="toggle-experience" data-person-id="${escapeAttribute(person.id)}">${icon(expanded ? "chevron-up" : "chevron-down")}${expanded ? "收起" : "TA 的经历"}</button>
          <button class="btn-text ${saved ? "is-active" : ""}" type="button" data-action="add-book" data-person-id="${escapeAttribute(person.id)}">${icon(saved ? "bookmark-check" : "bookmark")}${saved ? "已留下" : "留下样本"}</button>
          <button class="btn-text read-link ml-auto" type="button" data-action="open-reading" data-person-id="${escapeAttribute(person.id)}">${icon("book-open")}读原文 →</button>
        </footer>
      </article>
    `;
  };
})();
