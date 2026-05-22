(function () {
  const App = window.LifeSampleApp || (window.LifeSampleApp = {});
  App.views = App.views || {};

  App.views.renderBookView = function renderBookView(state) {
    const { escapeHtml, escapeAttribute } = App.utils;
    const items = state.bookItems.map((item) => {
      const person = App.store.findPerson(item.personId);
      if (!person) {
        return "";
      }
      return `
        <article class="rail-item">
          <strong>${escapeHtml(person.name)}</strong>
          <span>${escapeHtml(person.experienceSummary)}</span>
          <small>${escapeHtml(item.status === "done" ? "已读完" : "路书中")} · ${escapeHtml(item.addedAt)}</small>
          <div class="book-actions">
            <button class="app-button" type="button" data-action="open-reading" data-person-id="${escapeAttribute(person.id)}">读原文</button>
            <button class="app-button" type="button" data-action="toggle-book-status" data-person-id="${escapeAttribute(person.id)}">${item.status === "done" ? "标记路书中" : "标记已读"}</button>
            <button class="app-button" type="button" data-action="open-chat" data-person-id="${escapeAttribute(person.id)}">继续互动</button>
          </div>
        </article>
      `;
    }).join("");

    return `
      ${App.components.renderTopBar(state)}
      <main class="page-shell">
        <div class="book-layout">
          <section class="book-panel">
            <h1>我的路书</h1>
            <p>这里保留已加入的人物样本、阅读状态和下一步动作。</p>
            <div class="book-list">${items || "<p>还没有样本，回到路径 Feed 加入一个。</p>"}</div>
          </section>
          <section class="book-panel">
            <h2>下一步 mock 清单</h2>
            <div class="rail-item">
              <strong>本周只做一个小实验</strong>
              <span>选一条路径，写下期限、退出条件和最小行动。</span>
            </div>
            <div class="rail-item">
              <strong>把一句话放进时间胶囊</strong>
              <span>把当前判断保存下来，未来打开时再看它是否仍成立。</span>
              <div class="rail-actions">
                <button class="app-button primary" type="button" data-action="open-capsule">写时间胶囊</button>
              </div>
            </div>
          </section>
        </div>
      </main>
    `;
  };
})();
