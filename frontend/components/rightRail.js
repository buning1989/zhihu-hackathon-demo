(function () {
  const App = window.LifeSampleApp || (window.LifeSampleApp = {});
  App.components = App.components || {};

  App.components.renderRightRail = function renderRightRail(state) {
    const { escapeHtml, escapeAttribute, publicUiLabel } = App.utils;
    const icon = App.components.renderIcon;
    const expanded = state.railExpanded || {};
    const recentExpanded = Boolean(expanded.recentlyViewed);
    const interactionsExpanded = Boolean(expanded.interactions);
    const recentLimit = recentExpanded ? 10 : 3;
    const interactionLimit = interactionsExpanded ? 10 : 3;

    const recentItems = (state.recentlyViewed || []).slice(0, 10);
    const recentHtml = recentItems.slice(0, recentLimit).map((item) => {
      const person = App.store.findPerson(item.personId);
      if (!person) {
        return "";
      }
      const path = App.store.findPath(person.pathId);
      const meta = publicUiLabel(person.article?.title || path?.title, "刚看过的经历");
      return `
        <div class="activity-item">
          <div class="activity-name">${escapeHtml(person.name)}</div>
          <div class="activity-snippet">${escapeHtml(meta)}</div>
          <button class="btn-text" type="button" data-action="open-original" data-person-id="${escapeAttribute(person.id)}">${icon("book-open")}继续看</button>
        </div>
      `;
    }).join("");

    const seenInteractions = new Set();
    const interactionItems = (state.interactions || []).filter((item) => {
      if (item.type !== "chat") {
        return false;
      }
      if (seenInteractions.has(item.personId)) {
        return false;
      }
      seenInteractions.add(item.personId);
      return true;
    });
    const interactions = interactionItems.slice(0, 10);
    const interactionsHtml = interactions.slice(0, interactionLimit).map((item) => {
      const person = App.store.findPerson(item.personId);
      if (!person) {
        return "";
      }
      return `
        <div class="activity-item">
          <div class="activity-name">${escapeHtml(person.name)}</div>
          <div class="activity-snippet">${escapeHtml(item.reply || item.content)}</div>
          <button class="btn-text" type="button" data-action="continue-interaction" data-person-id="${escapeAttribute(person.id)}">${icon("reply")}继续听听</button>
        </div>
      `;
    }).join("");
    const hasRecent = Boolean(recentHtml);
    const hasInteractions = Boolean(interactionsHtml);

    if (!hasRecent && !hasInteractions) {
      return `
        <aside class="right-rail">
          <section class="rail-card rail-empty">
            <p class="rail-text">看过的人会留在这里，方便回头看。</p>
          </section>
        </aside>
      `;
    }

    return `
      <aside class="right-rail">
        ${hasRecent ? `
          <section class="rail-card">
            <h3 class="rail-title">刚看过</h3>
            <div class="activity-list ${recentExpanded ? "is-expanded" : ""}">${recentHtml}</div>
            ${recentItems.length > 3 ? `<button class="btn-text rail-more" type="button" data-action="toggle-rail" data-section="recentlyViewed">${recentExpanded ? "收起" : "查看更多"}</button>` : ""}
          </section>
        ` : ""}
        ${hasInteractions ? `
          <section class="rail-card">
            <h3 class="rail-title">刚聊过</h3>
            <div class="activity-list ${interactionsExpanded ? "is-expanded" : ""}">${interactionsHtml}</div>
            ${interactions.length > 3 ? `<button class="btn-text rail-more" type="button" data-action="toggle-rail" data-section="interactions">${interactionsExpanded ? "收起" : "查看更多"}</button>` : ""}
          </section>
        ` : ""}
      </aside>
    `;
  };
})();
