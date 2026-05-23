(function () {
  const App = window.LifeSampleApp || (window.LifeSampleApp = {});
  App.components = App.components || {};

  const structurePresets = {
    "path-city": {
      title: "决策拆解",
      labels: ["现实约束", "做出的选择", "承担的代价", "后来的变化"]
    },
    "path-skill": {
      title: "关键节点",
      labels: ["动作", "阻力", "调整", "结果"]
    },
    default: {
      title: "内容结构",
      labels: ["开始", "转折", "后来", "结果"]
    }
  };

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

  function normalizeStructureNodes(person) {
    const rawNodes = Array.isArray(person.experienceStructure?.nodes)
      ? person.experienceStructure.nodes
      : Array.isArray(person.structure?.nodes)
        ? person.structure.nodes
        : Array.isArray(person.steps)
          ? person.steps
          : Array.isArray(person.timeline)
            ? person.timeline
            : [];
    const preset = structurePresets[person.pathId] || structurePresets.default;
    const nodes = rawNodes.map((item, index) => ({
      title: textOf(item.title || item.label || item.stage || item.name) || preset.labels[index] || `节点 ${index + 1}`,
      text: textOf(item.text || item.content || item.body || item.desc || item.event || item)
    })).filter((item) => item.text);

    if (nodes.length) {
      return {
        title: textOf(person.experienceStructure?.title || person.structure?.title) || preset.title,
        nodes: nodes.slice(0, 4)
      };
    }

    const paragraphs = sourceParagraphs(person).slice(0, 4);
    return {
      title: preset.title,
      nodes: paragraphs.map((paragraph, index) => ({
        title: preset.labels[index] || `节点 ${index + 1}`,
        text: paragraph
      }))
    };
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
    const structure = normalizeStructureNodes(person);

    return `
      <section class="experience-inline" aria-label="内容结构">
        <p class="experience-structure-title">${escapeHtml(structure.title)}</p>
        <ol class="experience-structure-list">
          ${structure.nodes.map((item, index) => `
            <li>
              <span class="experience-structure-index">${String(index + 1).padStart(2, "0")}</span>
              <div>
                <h4>${escapeHtml(item.title)}</h4>
                <p>${escapeHtml(item.text)}</p>
              </div>
            </li>
          `).join("")}
        </ol>
      </section>
    `;
  }

  App.components.renderPersonCard = function renderPersonCard(person, state) {
    const { escapeHtml, escapeAttribute, publicUiLabel } = App.utils;
    const icon = App.components.renderIcon;
    const saved = App.store.isInBook(person.id);
    const experienceExpanded = state.expandedExperiencePersonId === person.id;
    const brief = person.article?.title || person.source?.title || "知乎公开内容样本";
    const path = App.store.findPath(person.pathId);
    const pathLabel = publicUiLabel(path?.shortTitle || path?.title, "样本方向");
    const meta = `${publicUiLabel(brief, "知乎公开内容样本")} · ${pathLabel}`;
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
        <footer class="person-actions">
          <button class="btn-text" type="button" data-action="toggle-experience" data-person-id="${escapeAttribute(person.id)}" aria-expanded="${experienceExpanded ? "true" : "false"}">${icon(experienceExpanded ? "chevron-up" : "file-text")}${experienceExpanded ? "收起结构" : "看内容结构"}</button>
          <button class="btn-text read-link" type="button" data-action="open-original" data-person-id="${escapeAttribute(person.id)}">${icon("book-open")}查看片段</button>
          <button class="btn-text ${saved ? "is-active" : ""} ml-auto" type="button" data-action="add-book" data-person-id="${escapeAttribute(person.id)}">${icon(saved ? "bookmark-check" : "bookmark")}${saved ? "已留下" : "留下样本"}</button>
        </footer>
      </article>
    `;
  };
})();
