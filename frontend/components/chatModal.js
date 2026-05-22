(function () {
  const App = window.LifeSampleApp || (window.LifeSampleApp = {});
  App.components = App.components || {};

  App.components.renderChatModal = function renderChatModal(state) {
    if (state.modal.type !== "chat") {
      return "";
    }

    const { escapeHtml, escapeAttribute } = App.utils;
    const person = App.store.findPerson(state.modal.personId);
    if (!person) {
      return "";
    }

    const thread = state.chatThreads[person.id] || [];
    const messages = thread.map((message) => `
      <div class="message ${escapeAttribute(message.role)}">${escapeHtml(message.text)}</div>
    `).join("");
    const suggestions = (person.aiPersona.suggestions || []).map((suggestion) => `
      <button class="option-button" type="button" data-action="chat-suggestion" data-person-id="${escapeAttribute(person.id)}" data-message="${escapeAttribute(suggestion)}">${escapeHtml(suggestion)}</button>
    `).join("");

    return `
      <div class="overlay" role="presentation" data-action="close-modal">
        <section class="modal" role="dialog" aria-modal="true" aria-labelledby="chat-modal-title" data-stop-close>
          <header class="modal-header">
            <div>
              <h2 id="chat-modal-title">${escapeHtml(person.name)}的经验回声</h2>
              <p>基于公开内容生成，不代表本人实时回应。</p>
            </div>
            <button class="icon-button" type="button" data-action="close-modal" aria-label="关闭">×</button>
          </header>
          <div class="modal-body">
            <div class="chat-boundary">${escapeHtml(person.aiPersona.boundary)}</div>
            <div class="chat-body">${messages}</div>
            <div class="suggestion-row">${suggestions}</div>
          </div>
          <footer class="modal-footer">
            <form class="chat-form" data-form="chat" data-person-id="${escapeAttribute(person.id)}">
              <label class="sr-only" for="chat-message">输入想追问的问题</label>
              <textarea id="chat-message" name="message" placeholder="继续问这段公开经历里的具体选择"></textarea>
              <button class="app-button primary" type="submit">发送</button>
            </form>
          </footer>
        </section>
      </div>
    `;
  };
})();
