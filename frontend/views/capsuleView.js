(function () {
  const App = window.LifeSampleApp || (window.LifeSampleApp = {});
  App.views = App.views || {};

  App.views.renderCapsuleView = function renderCapsuleView(state) {
    const { escapeHtml, escapeAttribute } = App.utils;
    const icon = App.components.renderIcon;
    if (state.capsule.sealed) {
      return `
        <main class="capsule-view is-sealed">
          <section class="capsule-main">
            <div class="capsule-card">
              <p class="capsule-date">写于 ${escapeHtml(new Date().toLocaleDateString("zh-CN"))}</p>
              <p class="capsule-subtitle">一个站在岔路口的时刻</p>
              <div class="capsule-body">${escapeHtml(state.capsule.typedText)}</div>
              <div class="capsule-end ${state.capsule.typingDone ? "is-visible" : ""}">三年后再来看看。</div>
            </div>
            <div class="capsule-actions ${state.capsule.typingDone ? "is-visible" : ""}">
              <button class="btn-s" type="button" data-action="open-feed">${icon("arrow-left")}回到相关样本</button>
            </div>
          </section>
        </main>
      `;
    }

    return `
      <main class="capsule-view">
        <section class="capsule-main">
          <p class="capsule-prompt">如果三年后的你，<br />回来看今天——<br />你想留下些什么？</p>
          <form data-form="capsule">
            <label class="sr-only" for="capsule-message">写给未来的自己</label>
            <textarea class="capsule-input" id="capsule-message" name="message" placeholder="${escapeAttribute(state.capsule.selectedPrompt)}"></textarea>
            <input type="hidden" name="openAt" value="2029-05-22" />
            <button class="btn-p" type="submit">${icon("archive")}封存这封信</button>
            </form>
        </section>
      </main>
    `;
  };
})();
