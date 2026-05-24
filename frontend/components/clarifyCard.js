(function () {
  const App = window.LifeSampleApp || (window.LifeSampleApp = {});
  App.components = App.components || {};

  App.components.renderClarifyCard = function renderClarifyCard(state, options = {}) {
    const { escapeHtml, escapeAttribute } = App.utils;
    const icon = App.components.renderIcon;
    const questions = state.search.clarifyQuestions || [];
    const answers = state.search.clarifyAnswers || {};
    const card = state.search.clarifyCard || {};
    const variant = options.variant || "feed";
    const title = card.title || "补充条件，让样本更贴近";
    const description = card.description || state.task?.needInput?.reason || "这些补充条件只用于匹配更贴近的经历样本，选几项就好。";
    const primaryActionText = card.primaryActionText || "用补充条件匹配";
    const skipActionText = card.skipActionText || "跳过，先看样本";

    const questionHtml = questions.map((question) => {
      const questionOptions = Array.isArray(question.options) ? question.options : [];
      const options = questionOptions.map((option) => {
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
          <h3 class="question-title">${escapeHtml(question.text || question.label || question.title)}</h3>
          <div class="option-row">${options}</div>
        </section>
      `;
    }).join("");

    return `
      <section class="clarify-wrap clarify-${escapeAttribute(variant)}">
        <div class="clarify-card">
          <div class="clarify-panel">
            <h2 class="clarify-title">${escapeHtml(title)}</h2>
            <p class="clarify-desc">${escapeHtml(description)}</p>
            ${questionHtml}
            <div class="clarify-actions">
              <button class="btn-s" type="button" data-action="skip-clarify">${icon("book-open")}${escapeHtml(skipActionText)}</button>
              <button class="btn-p" type="button" data-action="continue-after-clarify">${icon("search")}${escapeHtml(primaryActionText)}</button>
            </div>
          </div>
        </div>
      </section>
    `;
  };
})();
