(function () {
  const App = window.LifeSampleApp || (window.LifeSampleApp = {});
  App.components = App.components || {};

  App.components.renderClarifyCard = function renderClarifyCard(state) {
    const { escapeHtml, escapeAttribute } = App.utils;
    const questions = state.search.clarifyQuestions || [];
    const answers = state.search.clarifyAnswers || {};
    const complete = questions.length > 0 && questions.every((question) => answers[question.id]);

    const questionHtml = questions.map((question) => {
      const options = question.options.map((option) => {
        const selected = answers[question.id] === option.id;
        return `
          <button
            class="option-button ${selected ? "is-selected" : ""}"
            type="button"
            data-action="answer-clarify"
            data-question-id="${escapeAttribute(question.id)}"
            data-option-id="${escapeAttribute(option.id)}"
          >${escapeHtml(option.label)}</button>
        `;
      }).join("");

      return `
        <section class="clarify-question">
          <strong>${escapeHtml(question.text)}</strong>
          <div class="option-row">${options}</div>
        </section>
      `;
    }).join("");

    return `
      <section class="clarify-card">
        <h2>再补三句关键信息</h2>
        <p>你的处境有几种可能走法，先选最符合的答案，再进入路径 Feed。</p>
        <div class="clarify-grid">${questionHtml}</div>
        <button class="app-button primary" type="button" data-action="continue-after-clarify" ${complete ? "" : "disabled"}>继续匹配</button>
      </section>
    `;
  };
})();
