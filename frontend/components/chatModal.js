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
      <div class="bubble ${message.role === "user" ? "user" : "ai"}">${escapeHtml(message.text)}</div>
    `).join("");

    return `
      <div class="modal-overlay" role="presentation" data-action="close-modal"></div>
        <section class="chat-modal" role="dialog" aria-modal="true" aria-labelledby="chat-modal-title" data-stop-close>
          <header class="chat-header">
            <span id="chat-modal-title">和 ${escapeHtml(person.name)} 的 AI 分身聊</span>
            <button class="btn-text" type="button" data-action="close-modal">收起</button>
          </header>
          <div class="chat-intro">${escapeHtml(person.aiPersona.boundary)}</div>
          <div class="chat-messages">${messages}</div>
          <footer>
            <form class="chat-row" data-form="chat" data-person-id="${escapeAttribute(person.id)}">
              <label class="sr-only" for="chat-message">输入想追问的问题</label>
              <input class="chat-input" id="chat-message" name="message" placeholder="继续问 TA 一个问题……" />
              <button class="btn-p" type="submit">发送</button>
            </form>
          </footer>
        </section>
    `;
  };
})();
