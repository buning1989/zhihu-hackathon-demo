(function () {
  const App = window.LifeSampleApp || (window.LifeSampleApp = {});
  App.components = App.components || {};

  App.components.renderClarifyCard = function renderClarifyCard(state, options = {}) {
    const { escapeHtml, escapeAttribute } = App.utils;
    const icon = App.components.renderIcon;
    const questions = state.search.clarifyQuestions || [];
    const answers = state.search.clarifyAnswers || {};
    const variant = options.variant || "feed";

    const questionHtml = questions.map((question) => {
      const options = question.options.map((option) => {
        const selected = answers[question.id] === option.id;
        return `
          <button
            class="option-chip ${selected ? "is-selected" : ""}"
            type="button"
            data-action="answer-clarify"
            data-question-id="${escapeAttribute(question.id)}"
            data-option-id="${escapeAttribute(option.id)}"
          >${escapeHtml(option.label)}</button>
        `;
      }).join("");

      return `
        <section class="question-block">
          <h3 class="question-title">${escapeHtml(question.text)}</h3>
          <div class="option-row">${options}</div>
        </section>
      `;
    }).join("");

    return `
      <section class="clarify-wrap clarify-${escapeAttribute(variant)}">
        <div class="clarify-card">
          <div class="clarify-panel">
            <h2 class="clarify-title">再补充一点你的处境</h2>
            <p class="clarify-desc">这些信息会帮你找到更像的人，选几项就好。</p>
            ${questionHtml}
            <div class="clarify-actions">
              <button class="btn-s" type="button" data-action="skip-clarify">${icon("book-open")}先直接看</button>
              <button class="btn-p" type="button" data-action="continue-after-clarify">${icon("search")}开始看看</button>
            </div>
          </div>
        </div>
      </section>
    `;
  };
})();
