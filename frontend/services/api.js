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
  const localApiBaseUrl = resolveLocalApiBaseUrl();

  function resolveApiMode() {
    const params = new URLSearchParams(window.location.search);
    return String(
      params.get("api") ||
      window.LifeSampleAppConfig?.apiMode ||
      "backend"
    ).toLowerCase();
  }

  function resolveApiBaseUrl() {
    const params = new URLSearchParams(window.location.search);
    const configured =
      params.get("apiBaseUrl") ||
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

  function resolveLocalApiBaseUrl() {
    if (
      window.location.protocol === "file:" ||
      ["3000", "3001", "5173"].includes(window.location.port)
    ) {
      return "http://localhost:8000";
    }

    return "";
  }

  function buildUrl(path, baseUrl = apiBaseUrl) {
    const normalizedPath = path.startsWith("/") ? path : `/${path}`;
    return `${baseUrl}${normalizedPath}`;
  }

  async function requestJson(path, options = {}) {
    try {
      return await requestJsonOnce(path, options, apiBaseUrl);
    } catch (error) {
      if (!shouldRetryLocalApi(error)) {
        throw error;
      }

      const data = await requestJsonOnce(path, options, localApiBaseUrl);
      window.localStorage.removeItem("lifeSampleApiBaseUrl");
      return data;
    }
  }

  function shouldRetryLocalApi(error) {
    const code = String(error?.code || error?.errorCode || "");
    return Boolean(
      localApiBaseUrl &&
      apiBaseUrl &&
      localApiBaseUrl !== apiBaseUrl &&
      (code === "AGENT_DATABASE_UNCONFIGURED" || code === "AGENT_QUEUE_UNCONFIGURED")
    );
  }

  async function requestJsonOnce(path, options = {}, baseUrl = apiBaseUrl) {
    let response;
    let body;
    try {
      const requestBody = options.body === undefined
        ? undefined
        : typeof options.body === "string"
          ? options.body
          : JSON.stringify(options.body);

      response = await window.fetch(buildUrl(path, baseUrl), {
        ...options,
        credentials: "include",
        headers: {
          "Content-Type": "application/json",
          ...(options.headers || {})
        },
        body: requestBody
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

  function createTask({ query, count = 5, dataMode = resolveDemoDataMode(), metadata = {}, signal } = {}) {
    return requestJson("/api/agent/tasks", {
      method: "POST",
      signal,
      body: {
        query,
        count,
        dataMode,
        metadata
      }
    });
  }

  function getTaskStatus(taskId, options = {}) {
    return requestJson(`/api/agent/tasks/${encodeURIComponent(taskId)}`, {
      method: "GET",
      signal: options.signal,
      headers: agentReadTokenHeaders(options.readToken)
    });
  }

  function getTaskView(taskId, options = {}) {
    return requestJson(`/api/agent/tasks/${encodeURIComponent(taskId)}/view`, {
      method: "GET",
      signal: options.signal,
      headers: agentReadTokenHeaders(options.readToken)
    });
  }

  async function getTaskResult(taskId, options = {}) {
    try {
      return await requestJson(`/api/agent/tasks/${encodeURIComponent(taskId)}/result`, {
        method: "GET",
        signal: options.signal,
        headers: agentReadTokenHeaders(options.readToken)
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

  function refineTask(taskId, { answers = {}, refineQuery = "", metadata = {}, readToken = "", signal } = {}) {
    return requestJson(`/api/agent/tasks/${encodeURIComponent(taskId)}/refine`, {
      method: "POST",
      signal,
      headers: agentReadTokenHeaders(readToken),
      body: {
        answers,
        refineQuery,
        metadata
      }
    });
  }

  async function demoSearch({ query, answers = {}, count = 5, signal } = {}) {
    const body = {
      query,
      count,
      dataMode: resolveDemoDataMode()
    };
    if (hasAnswers(answers)) {
      body.clarificationAnswers = answers;
    }

    const data = await requestJson("/api/demo/search", {
      method: "POST",
      signal,
      body
    });

    return {
      status: "loaded",
      data: App.adapters.normalizeDemoResult
        ? App.adapters.normalizeDemoResult(data)
        : data,
      rawData: data
    };
  }

  function resolveDemoDataMode() {
    const params = new URLSearchParams(window.location.search);
    const configured =
      params.get("dataMode") ||
      params.get("demoDataMode") ||
      window.LifeSampleAppConfig?.demoDataMode ||
      "real";
    return ["mock", "cache_first", "real"].includes(configured) ? configured : "real";
  }

  function hasAnswers(answers) {
    return Object.values(answers || {}).some((value) =>
      Array.isArray(value) ? value.length > 0 : value !== undefined && value !== null && String(value).trim() !== ""
    );
  }

  function agentReadTokenHeaders(readToken) {
    const token = String(readToken || "").trim();
    return token ? { "X-Agent-Read-Token": token } : {};
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
    demoSearch,
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
    search: (...args) => mockMode
      ? App.MockApi.search(...args)
      : demoSearch(...args),
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
