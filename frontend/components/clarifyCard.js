(function () {
  const App = window.LifeSampleApp || (window.LifeSampleApp = {});
  App.components = App.components || {};

  App.components.renderClarifyCard = function renderClarifyCard(state) {
    const { escapeHtml, escapeAttribute } = App.utils;
    const questions = state.search.clarifyQuestions || [];
    const answers = state.search.clarifyAnswers || {};

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
      <section class="clarify-wrap">
        <div class="clarify-card">
          <div class="clarify-panel">
            <h2 class="clarify-title">再说一点你的处境</h2>
            <p class="clarify-desc">不用解释太多，点选几个更接近现在的感受就好。</p>
            ${questionHtml}
            <div class="clarify-actions">
              <button class="btn-s" type="button" data-action="skip-clarify">先看这些经历</button>
              <button class="btn-s" type="button" data-action="continue-after-clarify">用这些信息重新看看</button>
            </div>
          </div>
        </div>
      </section>
    `;
  };
})();
