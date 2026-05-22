(function () {
  const App = window.LifeSampleApp || (window.LifeSampleApp = {});
  App.views = App.views || {};

  App.views.renderReadingView = function renderReadingView(state) {
    const { escapeHtml, escapeAttribute } = App.utils;
    const person = App.store.findPerson(state.selectedPersonId);
    if (!person) {
      return `${App.components.renderTopBar(state)}<section class="empty-panel"><h2>没有找到这篇原文</h2><p>回到路径 Feed 重新选择一个人物样本。</p><button class="app-button primary" type="button" data-action="open-feed">返回路径</button></section>`;
    }

    const paragraphs = person.article.paragraphs.map((paragraph) => `<p>${escapeHtml(paragraph)}</p>`).join("");
    const saved = App.store.isInBook(person.id);

    return `
      ${App.components.renderTopBar(state)}
      <main class="page-shell">
        <div class="reading-layout">
          <article class="reading-card">
            <button class="app-button ghost" type="button" data-action="open-feed">返回路径 Feed</button>
            <p class="reading-kicker">${escapeHtml(person.name)}的公开经历</p>
            <h1>${escapeHtml(person.article.title)}</h1>
            <p>${escapeHtml(person.article.lead)}</p>
            <div class="source-box">
              <strong>来源与证据</strong><br />
              ${escapeHtml(person.source.title)}<br />
              ${escapeHtml(person.source.evidence)}
            </div>
            <div class="article-body">${paragraphs}</div>
            <section class="bottom-actions">
              <div class="reading-actions">
                <button class="app-button" type="button" data-action="add-book" data-person-id="${escapeAttribute(person.id)}">${saved ? "已加入路书" : "加入路书"}</button>
                <button class="app-button primary" type="button" data-action="open-chat" data-person-id="${escapeAttribute(person.id)}">和 TA 的 AI 分身聊</button>
              </div>
              <form class="note-form" data-form="note" data-person-id="${escapeAttribute(person.id)}">
                <label for="note-${escapeAttribute(person.id)}"><strong>给 TA 写一句话</strong></label>
                <textarea id="note-${escapeAttribute(person.id)}" name="note" placeholder="写给这段公开经历的一句话"></textarea>
                <button class="app-button" type="submit">保存到互动记录</button>
              </form>
            </section>
          </article>
          ${App.components.renderRightRail(state)}
        </div>
      </main>
    `;
  };
})();
