(function () {
  const App = window.LifeSampleApp || (window.LifeSampleApp = {});

  class AgentApiError extends Error {
    constructor(code, message, options = {}) {
      super(message || code || "Agent request failed");
      this.name = "AgentApiError";
      this.code = code || "AGENT_API_ERROR";
      this.status = options.status || 0;
      this.body = options.body || null;
      this.retriable = Boolean(options.retriable);
    }
  }

  const mockMode = resolveApiMode() === "mock";
  const apiBaseUrl = resolveApiBaseUrl();

  function resolveApiMode() {
    const params = new URLSearchParams(window.location.search);
    return String(
      params.get("api") ||
      window.LifeSampleAppConfig?.apiMode ||
      window.localStorage.getItem("lifeSampleApiMode") ||
      "backend"
    ).toLowerCase();
  }

  function resolveApiBaseUrl() {
    const configured =
      window.LifeSampleAppConfig?.apiBaseUrl ||
      window.localStorage.getItem("lifeSampleApiBaseUrl");
    if (configured) {
      return String(configured).replace(/\/+$/, "");
    }

    if (
      window.location.protocol === "file:" ||
      ["3000", "3001", "5173"].includes(window.location.port)
    ) {
      return "http://localhost:8000";
    }

    return "";
  }

  function buildUrl(path) {
    const normalizedPath = path.startsWith("/") ? path : `/${path}`;
    return `${apiBaseUrl}${normalizedPath}`;
  }

  async function requestJson(path, options = {}) {
    let response;
    let body;
    try {
      response = await window.fetch(buildUrl(path), {
        ...options,
        headers: {
          "Content-Type": "application/json",
          ...(options.headers || {})
        }
      });
    } catch (error) {
      if (error?.name === "AbortError") {
        throw error;
      }
      throw new AgentApiError(
        "BACKEND_UNAVAILABLE",
        "后端服务暂时不可用，请稍后再试。",
        { retriable: true, body: { cause: String(error?.message || error) } }
      );
    }

    try {
      const text = await response.text();
      body = text ? JSON.parse(text) : null;
    } catch {
      body = null;
    }

    if (response.status === 202) {
      throw new AgentApiError("RESULT_NOT_READY", "结果还在生成中。", {
        status: 202,
        body,
        retriable: true
      });
    }

    if (!response.ok || body?.success === false) {
      const apiError = body?.error || {};
      const code = String(apiError.code || apiError.errorCode || response.status || "AGENT_API_ERROR");
      const message = String(apiError.message || apiError.errorMessage || defaultErrorMessage(code, response.status));
      throw new AgentApiError(code, message, {
        status: response.status,
        body,
        retriable: response.status >= 500 || response.status === 0
      });
    }

    return body?.success === true && body.data !== undefined ? body.data : body;
  }

  function defaultErrorMessage(code, status) {
    if (code === "RATE_LIMITED" || status === 429) {
      return "今天创建的任务有点多了，稍后再试。";
    }

    if (status === 202) {
      return "结果还在生成中。";
    }

    return "后端处理失败，请稍后再试。";
  }

  function createTask({ query, metadata = {}, signal }) {
    return requestJson("/api/agent/tasks", {
      method: "POST",
      signal,
      body: JSON.stringify({
        query,
        metadata
      })
    });
  }

  function getTaskStatus(taskId, options = {}) {
    return requestJson(`/api/agent/tasks/${encodeURIComponent(taskId)}`, {
      method: "GET",
      signal: options.signal
    });
  }

  function getTaskView(taskId, options = {}) {
    return requestJson(`/api/agent/tasks/${encodeURIComponent(taskId)}/view`, {
      method: "GET",
      signal: options.signal
    });
  }

  async function getTaskResult(taskId, options = {}) {
    try {
      return await requestJson(`/api/agent/tasks/${encodeURIComponent(taskId)}/result`, {
        method: "GET",
        signal: options.signal
      });
    } catch (error) {
      if (error instanceof AgentApiError && error.status === 202) {
        throw new AgentApiError("RESULT_NOT_READY", "结果还在生成中。", {
          status: 202,
          body: error.body,
          retriable: true
        });
      }
      throw error;
    }
  }

  function refineTask(taskId, { answers = {}, refineQuery = "", metadata = {}, signal } = {}) {
    return requestJson(`/api/agent/tasks/${encodeURIComponent(taskId)}/refine`, {
      method: "POST",
      signal,
      body: JSON.stringify({
        answers,
        refineQuery,
        metadata
      })
    });
  }

  async function readAgentResult(taskId, taskStatus, options = {}) {
    let resultError = null;
    let normalizedResult = null;
    try {
      const result = await getTaskResult(taskId, options);
      normalizedResult = App.adapters.normalizeAgentResult(result, {
        task: taskStatus
      });
      if (App.adapters.isDisplayableAgentResult(normalizedResult)) {
        return normalizedResult;
      }
      resultError = new AgentApiError("RESULT_NOT_DISPLAYABLE", "结果缺少可展示证据。", {
        status: 200,
        body: result,
        retriable: false
      });
    } catch (error) {
      if (error?.code === "RESULT_NOT_READY") {
        throw error;
      }
      resultError = error;
    }

    let view;
    try {
      view = await getTaskView(taskId, options);
    } catch (error) {
      if (normalizedResult) {
        return normalizedResult;
      }
      throw resultError || error;
    }

    if (view?.result) {
      const normalizedView = App.adapters.normalizeAgentResult(view.result, {
        task: taskStatus,
        query: view.result?.query
      });
      if (App.adapters.isDisplayableAgentResult(normalizedView)) {
        return normalizedView;
      }
      return normalizedResult || normalizedView;
    }

    if (normalizedResult) {
      return normalizedResult;
    }

    throw resultError || new AgentApiError("RESULT_NOT_DISPLAYABLE", "结果缺少可展示证据。");
  }

  App.BackendApi = {
    createTask,
    getTaskStatus,
    getTaskView,
    getTaskResult,
    refineTask,
    readAgentResult
  };

  App.Api = {
    isMockMode: () => mockMode,
    login: (...args) => App.MockApi.login(...args),
    prepareSearch: (...args) => mockMode
      ? App.MockApi.prepareSearch(...args)
      : Promise.resolve({ status: "ready" }),
    search: (...args) => App.MockApi.search(...args),
    sendPersonaMessage: (...args) => App.MockApi.sendPersonaMessage(...args),
    createAgentTask: createTask,
    getAgentTaskStatus: getTaskStatus,
    getAgentTaskView: getTaskView,
    getAgentTaskResult: getTaskResult,
    refineAgentTask: refineTask,
    readAgentResult,
    AgentApiError
  };
})();
