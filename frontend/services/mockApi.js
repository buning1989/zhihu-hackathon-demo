(function () {
  const App = window.LifeSampleApp || (window.LifeSampleApp = {});
  const data = App.mockData;
  const { clone } = App.utils;

  function delay(value, ms) {
    return new Promise((resolve) => {
      window.setTimeout(() => resolve(clone(value)), ms);
    });
  }

  function isVagueQuery(query) {
    const text = String(query || "").trim();
    if (text.length < 18) {
      return true;
    }
    return /(迷茫|怎么办|去哪|重新开始|不工作|辞职|换城市|焦虑)/.test(text);
  }

  function buildSearchResult(query, answers) {
    return {
      schemaVersion: "frontend-v2-mock",
      queryId: `mock-${Date.now()}`,
      query,
      dataMode: "mock",
      contextUsed: {
        loggedIn: true,
        zhihuProfileUsed: true,
        profileSignals: ["mock 登录", "轻量偏好"],
        clarifyAnswers: answers
      },
      analysis: {
        title: "已整理出 3 个可比较的样本方向"
      },
      paths: clone(data.paths),
      people: clone(data.people),
      personas: clone(data.personas),
      sections: [],
      meta: {
        generatedAt: new Date().toISOString()
      }
    };
  }

  App.MockApi = {
    login() {
      return delay({
        status: "ok",
        profile: clone(data.profile)
      }, 520);
    },

    prepareSearch({ query, answers }) {
      if (isVagueQuery(query) && Object.keys(answers || {}).length === 0) {
        return delay({
          status: "needs_clarification",
          questions: data.clarifyQuestions.slice(0, 3)
        }, 640);
      }
      return delay({
        status: "ready"
      }, 420);
    },

    search({ query, answers }) {
      return delay({
        status: "loaded",
        data: buildSearchResult(query, answers || {})
      }, 760);
    },

    sendPersonaMessage({ personId, message, turn }) {
      const person = data.people.find((item) => item.id === personId);
      const replies = person ? person.chatReplies : ["这段 mock 回应暂时只能基于已有公开片段回答。"];
      const text = replies[turn % replies.length];
      return delay({
        id: `assistant-${Date.now()}`,
        role: "assistant",
        text: `${text} 你的问题是「${message}」，我会把回答限制在这段公开内容能支持的范围里。`
      }, 520);
    }
  };
})();
