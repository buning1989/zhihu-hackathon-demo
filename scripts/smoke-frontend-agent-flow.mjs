#!/usr/bin/env node

const DEFAULT_FRONTEND_URL = "http://127.0.0.1:5173";
const DEFAULT_QUERY = "35岁裸辞以后还能去哪儿";
const DEFAULT_TIMEOUT_MS = 90000;

await main().catch((error) => {
  console.error(`FAIL ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});

async function main() {
  const config = readConfig();
  await assertReachable(config.frontendUrl, "frontend");
  await assertBackendReachable(config.apiBaseUrl);

  const { chromium } = await loadPlaywright();
  const browser = await launchBrowser(chromium);
  const context = await browser.newContext();
  const page = await context.newPage();

  const requests = [];
  const consoleWarnings = [];
  const pageErrors = [];

  page.on("request", (request) => {
    const kind = classifyRequest(request.method(), request.url());
    if (!kind) {
      return;
    }
    requests.push({
      phase: "request",
      kind,
      method: request.method(),
      url: request.url(),
      at: Date.now()
    });
  });

  page.on("response", async (response) => {
    const request = response.request();
    const kind = classifyRequest(request.method(), response.url());
    if (!kind) {
      return;
    }

    const event = {
      phase: "response",
      kind,
      method: request.method(),
      status: response.status(),
      url: response.url(),
      at: Date.now()
    };
    requests.push(event);

    const body = await readJsonResponse(response);
    if (body) {
      if (kind === "agentCreate" && body?.data?.taskId) {
        event.taskId = body.data.taskId;
      }
      if (kind === "agentStatus" && body?.data?.status) {
        event.taskStatus = body.data.status;
      }
    }
  });

  page.on("console", (message) => {
    const text = message.text();
    if (message.type() === "warning" || text.includes("/api/demo/search") || text.includes("[AgentTask]")) {
      consoleWarnings.push({ type: message.type(), text });
    }
  });

  page.on("pageerror", (error) => {
    pageErrors.push(String(error?.message || error));
  });

  try {
    await page.goto(config.pageUrl, {
      waitUntil: "domcontentloaded",
      timeout: config.timeoutMs
    });
    await page.waitForSelector("#entry-query", { timeout: 10000 });

    await page.fill("#entry-query", config.query);
    await page.click('button[type="submit"]');

    await waitFor(() => hasRequest(requests, "agentCreate", "request"), {
      timeoutMs: 15000,
      message: "No POST /api/agent/tasks request observed. Check that the frontend submit path uses Agent Task."
    });

    await waitFor(() => hasRequest(requests, "agentCreate", "response"), {
      timeoutMs: 15000,
      message: "POST /api/agent/tasks was sent but no response was observed. Check backend/CORS availability."
    });

    const createResponse = latestEvent(requests, "agentCreate", "response");
    if (createResponse.status < 200 || createResponse.status >= 300) {
      await sleep(500);
      if (hasRequest(requests, "demoSearch", "request")) {
        throw new Error(describeDemoFallback(requests, consoleWarnings));
      }
      throw new Error(
        `POST /api/agent/tasks returned HTTP ${createResponse.status}. Check that the backend includes the Agent Task routes.`
      );
    }

    await waitFor(() => hasRequest(requests, "agentStatus", "request"), {
      timeoutMs: config.timeoutMs,
      message: "No GET /api/agent/tasks/:taskId polling request observed."
    });

    await waitFor(() => hasRequest(requests, "agentView", "request"), {
      timeoutMs: config.timeoutMs,
      message: "No GET /api/agent/tasks/:taskId/view request observed."
    });

    await waitForDisplayableResult(page, config.timeoutMs);

    await waitFor(() => hasRequest(requests, "agentResult", "request"), {
      timeoutMs: config.timeoutMs,
      message: "No GET /api/agent/tasks/:taskId/result request observed."
    });

    const demoRequests = requests.filter((event) => event.kind === "demoSearch" && event.phase === "request");
    if (demoRequests.length > 0) {
      throw new Error(describeDemoFallback(requests, consoleWarnings));
    }

    const taskId = latestValue(
      requests.filter((event) => event.kind === "agentCreate" && event.taskId),
      "taskId"
    );
    const resultSummary = await readResultSummary(page);
    const retrySummary = await assertEvidenceRetryUi(page, requests);

    console.log("PASS frontend agent task smoke");
    console.log(`frontend=${config.frontendUrl}`);
    console.log(`apiBase=${config.apiBaseUrl || "(same origin)"}`);
    console.log(`query="${config.query}"`);
    console.log(`taskId=${taskId || "(not parsed)"}`);
    console.log(
      `requests agentCreate=${countRequests(requests, "agentCreate")} agentStatus=${countRequests(requests, "agentStatus")} agentView=${countRequests(requests, "agentView")} agentResult=${countRequests(requests, "agentResult")} demoSearch=${countRequests(requests, "demoSearch")}`
    );
    console.log(
      `display paths=${resultSummary.pathCount} people=${resultSummary.peopleCount} cards=${resultSummary.cardCount} snippets=${resultSummary.snippetCount}`
    );
    console.log(
      `evidence degraded=${retrySummary.hasIssue} retryable=${retrySummary.retryable} retryClicked=${retrySummary.retryClicked} retryRequests=${countRequests(requests, "agentStageRetry")}`
    );
  } finally {
    await browser.close();
  }

  if (pageErrors.length > 0) {
    console.warn(`WARN page errors observed: ${pageErrors.slice(0, 3).join(" | ")}`);
  }
}

function readConfig() {
  const frontendUrl = normalizeUrl(process.env.FRONTEND_URL || DEFAULT_FRONTEND_URL, "FRONTEND_URL");
  const frontendApiBase = new URL(frontendUrl).searchParams.get("apiBaseUrl");
  const apiBaseUrl = normalizeApiBaseUrl(
    process.env.API_BASE_URL || frontendApiBase || inferApiBaseUrl(frontendUrl)
  );
  const query = String(process.env.TEST_QUERY || DEFAULT_QUERY).trim();
  const timeoutMs = Number.parseInt(process.env.SMOKE_TIMEOUT_MS || "", 10) || DEFAULT_TIMEOUT_MS;
  const dataMode = String(process.env.DATA_MODE || "").trim();

  if (!query) {
    throw new Error("TEST_QUERY must not be empty.");
  }

  return {
    frontendUrl,
    apiBaseUrl,
    query,
    timeoutMs,
    pageUrl: buildPageUrl(frontendUrl, {
      apiBaseUrl: process.env.API_BASE_URL ? apiBaseUrl : "",
      dataMode
    })
  };
}

function buildPageUrl(frontendUrl, options = {}) {
  const url = new URL(frontendUrl);
  url.searchParams.set("smokeFrontendAgent", String(Date.now()));
  if (options.apiBaseUrl) {
    url.searchParams.set("apiBaseUrl", options.apiBaseUrl);
  }
  if (options.dataMode) {
    url.searchParams.set("dataMode", options.dataMode);
  }
  return url.href;
}

function inferApiBaseUrl(frontendUrl) {
  const url = new URL(frontendUrl);
  if (url.searchParams.get("apiBaseUrl")) {
    return url.searchParams.get("apiBaseUrl");
  }
  if (url.protocol === "file:" || ["3000", "3001", "5173"].includes(url.port)) {
    return "http://localhost:8000";
  }
  return url.origin;
}

function normalizeUrl(value, label) {
  try {
    return new URL(value).href;
  } catch {
    throw new Error(`${label} must be a valid URL; got ${value}`);
  }
}

function normalizeApiBaseUrl(value) {
  if (!value) {
    return "";
  }
  return String(value).replace(/\/+$/, "");
}

async function assertReachable(url, label) {
  const response = await fetchWithTimeout(url, 5000).catch((error) => {
    throw new Error(`${label} is not reachable at ${url}: ${String(error?.message || error)}`);
  });
  if (!response.ok) {
    throw new Error(`${label} returned HTTP ${response.status} at ${url}`);
  }
}

async function assertBackendReachable(apiBaseUrl) {
  if (!apiBaseUrl) {
    return;
  }

  const healthUrls = [`${apiBaseUrl}/health`, `${apiBaseUrl}/api/health`];
  const failures = [];
  for (const url of healthUrls) {
    try {
      const response = await fetchWithTimeout(url, 5000);
      if (response.ok) {
        return;
      }
      failures.push(`${url} -> HTTP ${response.status}`);
    } catch (error) {
      failures.push(`${url} -> ${String(error?.message || error)}`);
    }
  }

  throw new Error(
    `backend is not reachable. Tried ${failures.join("; ")}. Start the backend or set API_BASE_URL.`
  );
}

async function fetchWithTimeout(url, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function loadPlaywright() {
  try {
    return await import("playwright");
  } catch (error) {
    throw new Error(
      `Playwright is not installed. Run \`npm install\` first. Original error: ${String(error?.message || error)}`
    );
  }
}

async function launchBrowser(chromium) {
  try {
    return await chromium.launch({
      headless: process.env.HEADLESS !== "0"
    });
  } catch (error) {
    throw new Error(
      `Unable to launch Chromium. If browsers are missing, run \`npx playwright install chromium\`. Original error: ${String(error?.message || error)}`
    );
  }
}

function classifyRequest(method, url) {
  let pathname = "";
  try {
    pathname = new URL(url).pathname;
  } catch {
    return "";
  }

  const normalizedMethod = String(method || "GET").toUpperCase();
  if (pathname === "/api/agent/tasks" && normalizedMethod === "POST") {
    return "agentCreate";
  }
  if (/^\/api\/agent\/tasks\/[^/]+$/.test(pathname) && normalizedMethod === "GET") {
    return "agentStatus";
  }
  if (/^\/api\/agent\/tasks\/[^/]+\/view$/.test(pathname) && normalizedMethod === "GET") {
    return "agentView";
  }
  if (/^\/api\/agent\/tasks\/[^/]+\/result$/.test(pathname) && normalizedMethod === "GET") {
    return "agentResult";
  }
  if (/^\/api\/agent\/tasks\/[^/]+\/stages\/[^/]+\/retry$/.test(pathname) && normalizedMethod === "POST") {
    return "agentStageRetry";
  }
  if (pathname === "/api/demo/search") {
    return "demoSearch";
  }

  return "";
}

async function readJsonResponse(response) {
  const contentType = response.headers()["content-type"] || "";
  if (!contentType.includes("application/json")) {
    return null;
  }
  try {
    return await response.json();
  } catch {
    return null;
  }
}

function hasRequest(requests, kind, phase) {
  return requests.some((event) => event.kind === kind && event.phase === phase);
}

function countRequests(requests, kind) {
  return requests.filter((event) => event.kind === kind && event.phase === "request").length;
}

async function waitForDisplayableResult(page, timeoutMs) {
  try {
    await page.waitForFunction(
      () => {
        const pathModules = document.querySelectorAll(".path-module, .path-count-btn").length;
        const cards = document.querySelectorAll(".person-card").length;
        const snippets = document.querySelectorAll(".original-snippet, .person-meta").length;
        const state = window.LifeSampleApp?.store?.getState?.();
        const result = state?.result || null;
        const storeHasResult = Boolean(
          result
          && (
            (Array.isArray(result.paths) && result.paths.length > 0)
            || (Array.isArray(result.people) && result.people.length > 0)
            || result.meta?.emptyResult
          )
        );
        return pathModules > 0 || cards > 0 || snippets > 0 || storeHasResult;
      },
      null,
      { timeout: timeoutMs }
    );
  } catch {
    const bodyText = await page.textContent("body").catch(() => "");
    throw new Error(
      `No displayable partial result appeared before timeout. Page text: ${String(bodyText || "").slice(0, 500)}`
    );
  }
}

async function readResultSummary(page) {
  return await page.evaluate(() => {
    const state = window.LifeSampleApp?.store?.getState?.();
    const result = state?.result || {};
    return {
      pathCount: Array.isArray(result.paths) ? result.paths.length : 0,
      peopleCount: Array.isArray(result.people) ? result.people.length : 0,
      cardCount: document.querySelectorAll(".person-card").length,
      snippetCount: document.querySelectorAll(".original-snippet, .person-meta").length
    };
  });
}

async function assertEvidenceRetryUi(page, requests) {
  const state = await readEvidenceRetryState(page);
  if (!state.hasIssue) {
    if (state.retryButtonVisible) {
      throw new Error("Retry evidence button is visible even though evidence_extract did not degrade.");
    }
    return {
      ...state,
      retryClicked: false
    };
  }

  if (!state.bannerVisible) {
    throw new Error("evidence_extract degraded but no degraded banner is visible.");
  }

  if (!state.retryable) {
    return {
      ...state,
      retryClicked: false
    };
  }

  if (!state.retryButtonVisible) {
    throw new Error("evidence_extract is retryable but no retry button is visible.");
  }

  const before = await readResultSummary(page);
  await page.click('[data-action="retry-evidence"]');
  await waitFor(() => hasRequest(requests, "agentStageRetry", "request"), {
    timeoutMs: 15000,
    message: "Retry button was clicked but POST /api/agent/tasks/:taskId/stages/evidence_extract/retry was not observed."
  });
  await waitForDisplayableResult(page, 15000);
  const after = await readResultSummary(page);
  if (before.peopleCount > 0 && after.peopleCount === 0) {
    throw new Error("Evidence retry cleared the existing partial result.");
  }

  return {
    ...await readEvidenceRetryState(page),
    retryClicked: true
  };
}

async function readEvidenceRetryState(page) {
  return await page.evaluate(() => {
    const state = window.LifeSampleApp?.store?.getState?.() || {};
    const task = state.task || {};
    const result = state.result || {};
    const failedStages = new Set([
      ...(Array.isArray(task.failedStages) ? task.failedStages : []),
      ...(Array.isArray(result.meta?.failedStages) ? result.meta.failedStages : [])
    ]);
    const fallbackStages = new Set(Array.isArray(result.meta?.fallbackStages) ? result.meta.fallbackStages : []);
    const timedOutStages = new Set(Array.isArray(result.meta?.timedOutStages) ? result.meta.timedOutStages : []);
    const evidenceRunning = Array.isArray(task.stages)
      ? task.stages.some((stage) => stage?.name === "evidence_extract" && stage?.status === "running")
      : false;
    const hasIssue = failedStages.has("evidence_extract") ||
      fallbackStages.has("evidence_extract") ||
      timedOutStages.has("evidence_extract");
    return {
      hasIssue,
      retryable: Boolean(task.retryable && hasIssue && !evidenceRunning),
      bannerVisible: Boolean(document.querySelector(".agent-degraded-banner")),
      retryButtonVisible: Boolean(document.querySelector('[data-action="retry-evidence"]')),
      taskStatus: task.status || "",
      failedStages: Array.from(failedStages),
      fallbackStages: Array.from(fallbackStages),
      timedOutStages: Array.from(timedOutStages)
    };
  });
}

function latestValue(events, key) {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    if (events[index][key]) {
      return events[index][key];
    }
  }
  return "";
}

function latestEvent(requests, kind, phase) {
  const matches = requests.filter((event) => event.kind === kind && event.phase === phase);
  return matches[matches.length - 1] || null;
}

function describeDemoFallback(requests, consoleWarnings) {
  const createResponses = requests.filter((event) => event.kind === "agentCreate" && event.phase === "response");
  const failedCreate = createResponses.find((event) => event.status < 200 || event.status >= 300);
  const warning = consoleWarnings.find((event) => event.text.includes("falling back") || event.text.includes("/api/demo/search"));
  if (failedCreate || warning) {
    return [
      "/api/demo/search was called as fallback.",
      failedCreate ? `Agent create status=${failedCreate.status}.` : "",
      warning ? `Console warning="${warning.text}".` : "",
      "This smoke expects the normal Agent Task path; inspect the Agent create failure before accepting fallback."
    ].filter(Boolean).join(" ");
  }

  return "/api/demo/search was called without an observed Agent Task fallback signal. The frontend may have regressed to the synchronous demo search path.";
}

async function waitFor(predicate, options) {
  const startedAt = Date.now();
  const timeoutMs = options.timeoutMs || DEFAULT_TIMEOUT_MS;
  while (Date.now() - startedAt <= timeoutMs) {
    if (predicate()) {
      return;
    }
    await sleep(100);
  }

  throw new Error(options.message || "Timed out waiting for condition.");
}

async function sleep(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}
