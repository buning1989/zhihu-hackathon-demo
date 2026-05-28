(function () {
  const App = window.LifeSampleApp || (window.LifeSampleApp = {});
  App.views = App.views || {};

  function renderLoading(state) {
    const { escapeHtml, escapeAttribute } = App.utils;
    const result = state.result || App.store.getResult();
    const loadingStages = App.loadingStages || [
      { label: "理解处境", message: "正在理解你的处境" },
      { label: "寻找样本", message: "正在寻找真实内容样本" },
      { label: "整理片段", message: "正在整理公开内容片段" },
      { label: "整理样本", message: "正在整理真实样本" },
      { label: "组织片段", message: "正在整理可展示内容样本" }
    ];
    const currentStageIndex = Math.min(
      Math.max(Number(state.search.loadingStageIndex) || 0, 0),
      loadingStages.length - 1
    );
    const currentStage = loadingStages[currentStageIndex] || loadingStages[0];
    const phaseClass = state.transitionPhase === "loadingEntering"
      ? "loading-enter"
      : state.transitionPhase === "loadingExiting"
        ? "loading-exit"
        : "";
    const people = (result.people || App.mockData.people).slice(0, 6);
    const marqueeItems = people.map((person) => `
      <span class="loading-person">
        <span class="loading-avatar" aria-hidden="true"><img src="${escapeAttribute(person.avatar)}" alt="" /></span>
        <span>${escapeHtml(person.name)}</span>
      </span>
    `).join("");
    const marqueeGroup = `<div class="marquee-group">${marqueeItems}</div>`;

    return `
      <section class="card loading-card ${phaseClass}">
        <h2 class="loading-title">${escapeHtml(currentStage.message)}</h2>
        <div class="people-flow" aria-hidden="true">
          <div class="marquee-viewport">
            <div class="marquee-track">${marqueeGroup}${marqueeGroup}</div>
          </div>
          <div class="marquee-viewport">
            <div class="marquee-track is-reverse">${marqueeGroup}${marqueeGroup}</div>
          </div>
        </div>
        <ol class="loading-flow" aria-label="匹配进度">
          ${loadingStages.map((stage, index) => {
            const nodeClass = index < currentStageIndex
              ? "is-completed"
              : index === currentStageIndex
                ? "is-active"
                : "is-pending";
            return `
              <li class="loading-node ${nodeClass}" data-stage-index="${index}" ${index === currentStageIndex ? "aria-current=\"step\"" : ""}>
                <span class="loading-node-dot" aria-hidden="true">
                  <span class="loading-node-check">✓</span>
                </span>
                <span class="loading-node-label">${escapeHtml(stage.label)}</span>
              </li>
            `;
          }).join("")}
        </ol>
      </section>
    `;
  }

  function isMainFeedPerson(person) {
    const sampleType = String(person.sampleType || "").trim();
    if (sampleType === "viewpoint_author" || sampleType === "content_sample") {
      return false;
    }

    const article = person.article || {};
    const evidenceText = Array.isArray(article.evidence)
      ? article.evidence.map((item) => item?.text || item?.evidenceText || item?.excerpt || "").join("\n")
      : "";
    const marketingText = [
      person.name,
      person.oneLine,
      person.source?.title,
      person.source?.evidence,
      article.title,
      article.summary,
      article.lead,
      evidenceText
    ].filter(Boolean).join("\n");

    return !/(加微信|私信|课程|训练营|报名|推广|付费咨询|预约咨询|转行辅导|简历辅导|面试辅导|就业班|机构培训|培训机构|带过[几数百千\d]+人)/.test(marketingText);
  }

  function mainFeedPeople(result) {
    const people = Array.isArray(result.people) ? result.people : [];
    const feedItems = Array.isArray(result.feedItems) ? result.feedItems : [];
    const peopleById = new Map(people.map((person) => [person.id, person]));

    if (!feedItems.length) {
      return people.filter(isMainFeedPerson);
    }

    return feedItems.map((feedItem, index) => {
      const person = peopleById.get(feedItem.personId) || null;
      const fallbackId = feedItem.personId || feedItem.saveSampleId || feedItem.id || `feed_person_${index + 1}`;
      return {
        ...(person || {}),
        id: person?.id || fallbackId,
        name: feedItem.authorName || person?.name || "知乎用户",
        avatar: feedItem.authorAvatar || person?.avatar || "",
        sampleType: "experience_sample",
        directionLabel: feedItem.directionLabel || person?.directionLabel || "真实经历",
        sourceTitle: feedItem.sourceTitle || person?.sourceTitle || person?.article?.title || "知乎公开内容",
        sourcePlatform: feedItem.sourcePlatform || person?.sourcePlatform || person?.article?.sourceName || "知乎",
        sourceUrl: feedItem.sourceUrl || person?.sourceUrl || person?.source?.url || person?.article?.sourceUrl || "",
        snippet: feedItem.snippet || person?.snippet || person?.source?.evidence || person?.article?.lead || "",
        summaryText: feedItem.summaryText || person?.summaryText || "",
        summaryPayload: feedItem.summaryPayload || person?.summaryPayload || null,
        evidenceStatus: feedItem.evidenceStatus || person?.evidenceStatus || "llm_extracted",
        saveSampleId: feedItem.saveSampleId || person?.saveSampleId || fallbackId,
        article: person?.article || {
          title: feedItem.sourceTitle || "知乎公开内容",
          author: feedItem.authorName || "知乎用户",
          avatar: feedItem.authorAvatar || "",
          sourceName: feedItem.sourcePlatform || "知乎",
          sourceUrl: feedItem.sourceUrl || "",
          lead: feedItem.snippet || "",
          paragraphs: feedItem.snippet ? [feedItem.snippet] : [],
          evidence: []
        },
        source: person?.source || {
          title: feedItem.sourceTitle || "知乎公开内容",
          evidence: feedItem.snippet || "",
          url: feedItem.sourceUrl || ""
        },
        canChat: feedItem.evidenceStatus === "raw_snippet_only" ? false : person?.canChat,
        displayCanChat: feedItem.evidenceStatus === "raw_snippet_only" ? false : person?.displayCanChat,
        aiPersona: feedItem.evidenceStatus === "raw_snippet_only"
          ? { ...(person?.aiPersona || {}), enabled: false, canChat: false }
          : person?.aiPersona
      };
    }).filter(isMainFeedPerson);
  }

  function renderFeedSummary(state, result) {
    const { escapeHtml } = App.utils;
    const notices = [];
    const people = mainFeedPeople(result);
    const summaryText = result.meta?.evidenceOnly
      ? `先看 ${people.length} 条贴近的公开内容片段。`
      : `先看 ${people.length} 条真实经历样本。`;
    if (result.meta?.cacheHit || result.meta?.reused) {
      notices.push("已使用近期相似结果");
    }
    if (result.meta?.emptyResult) {
      notices.push("暂时没有可展示样本");
    }
    const evidenceNotice = renderEvidenceNotice(state, result);

    return `
      <header class="feed-summary">
        <p class="feed-summary-text">${escapeHtml(summaryText)}</p>
        <button class="btn-text status-clarify" type="button" data-action="open-clarify">再说一点</button>
      </header>
      ${notices.length ? `<div class="result-notices">${notices.map((notice) => `<span>${escapeHtml(notice)}</span>`).join("")}</div>` : ""}
      ${evidenceNotice}
    `;
  }

  function renderEvidenceNotice(state, result) {
    const { escapeHtml } = App.utils;
    const task = state.task || {};
    const failedStages = new Set([
      ...(Array.isArray(task.failedStages) ? task.failedStages : []),
      ...(Array.isArray(result.meta?.failedStages) ? result.meta.failedStages : [])
    ]);
    const fallbackStages = new Set(Array.isArray(result.meta?.fallbackStages) ? result.meta.fallbackStages : []);
    const timedOutStages = new Set(Array.isArray(result.meta?.timedOutStages) ? result.meta.timedOutStages : []);
    const evidenceRunning = Array.isArray(task.stages)
      ? task.stages.some((stage) => stage?.name === "evidence_extract" && stage?.status === "running")
      : false;
    const hasEvidenceIssue = failedStages.has("evidence_extract") ||
      fallbackStages.has("evidence_extract") ||
      timedOutStages.has("evidence_extract");

    if (!hasEvidenceIssue && !evidenceRunning) {
      return "";
    }

    const canRetry = Boolean(task.retryable && hasEvidenceIssue && !evidenceRunning);
    const message = evidenceRunning
      ? "正在重试证据提取，基础结果会保留。"
      : canRetry
        ? "证据提取暂时失败，已先展示基础结果。可重试补全证据。"
        : "证据提取暂时失败，已先展示基础结果。";
    const retryButton = canRetry
      ? `<button class="btn-text result-notice-action" type="button" data-action="retry-evidence">重试证据提取</button>`
      : "";

    return `
      <div class="agent-degraded-banner" data-agent-degraded="evidence_extract" role="status">
        <span>${escapeHtml(message)}</span>
        ${retryButton}
      </div>
    `;
  }

  function renderError(state) {
    const { escapeHtml } = App.utils;
    const icon = App.components.renderIcon;
    const error = state.task.error || {};
    const code = error.errorCode || "";
    const message = state.search.error || error.errorMessage || "后端暂时不可用，请稍后再试。";
    const title = code === "RATE_LIMITED" ? "今天的任务有点多" : "暂时没能整理出样本";

    return `
      <section class="empty-panel result-empty">
        <h2>${escapeHtml(title)}</h2>
        <p>${escapeHtml(message)}</p>
        <button class="btn-s" type="button" data-action="open-feed">${icon("arrow-left")}返回</button>
      </section>
    `;
  }

  function renderEmptyResult(result) {
    const { escapeHtml } = App.utils;
    return `
      <section class="empty-panel result-empty">
        <h2>暂时没找到足够贴近的真实经历样本</h2>
        <p>${escapeHtml("可以补充一点处境，再重新看看。")}</p>
      </section>
    `;
  }

  function renderLoaded(state) {
    const result = state.result;
    const people = mainFeedPeople(result);
    const cards = people.map((person) => App.components.renderPersonCard(person, state)).join("");
    const isEmpty = people.length === 0;

    return `
      <main class="layout layout-results ${state.transitionPhase === "feedEntering" ? "feed-enter" : ""}">
          <section class="main-feed">
            ${renderFeedSummary(state, result)}
          </section>
          <section class="feed-card-list">
            ${isEmpty ? renderEmptyResult(result) : cards}
          </section>
          ${App.components.renderRightRail(state)}
      </main>
    `;
  }

  App.views.renderFeedView = function renderFeedView(state) {
    const topBar = App.components.renderTopBar(state);

    if (state.search.clarifyOpen || state.search.status === "clarify") {
      const content = state.result ? renderLoaded(state) : `<main class="layout"><aside></aside><section class="main-feed">${renderLoading(state)}</section><aside></aside></main>`;
      return `
        ${topBar}
        ${App.components.renderClarifyCard(state)}
        ${state.search.status === "clarify" && !state.result ? "" : content}
      `;
    }

    if (state.search.status === "error") {
      return `${topBar}<main class="layout"><aside></aside><section class="main-feed">${renderError(state)}</section><aside></aside></main>`;
    }

    if (state.search.status !== "loaded" || !state.result) {
      return `${topBar}<main class="layout"><aside></aside><section class="main-feed">${renderLoading(state)}</section><aside></aside></main>`;
    }

    return `${topBar}${renderLoaded(state)}`;
  };
})();
