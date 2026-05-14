#!/usr/bin/env node

const baseUrl = normalizeBaseUrl(readBaseUrl());

console.log(`Smoke target: ${baseUrl}`);

try {
  await checkHealth();
  await checkHomepage();
  const demoData = await checkDemoSearch();
  await checkPersonaChat(demoData);
  console.log("Vercel smoke passed.");
} catch (error) {
  console.error("Vercel smoke failed.");
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}

function readBaseUrl() {
  const arg = process.argv[2];
  if (arg?.startsWith("BASE_URL=")) {
    return arg.slice("BASE_URL=".length);
  }

  return arg || process.env.BASE_URL || "http://127.0.0.1:8000";
}

function normalizeBaseUrl(value) {
  const normalized = String(value || "").trim().replace(/\/+$/, "");
  if (!normalized) {
    throw new Error("BASE_URL is required");
  }

  return normalized;
}

async function checkHealth() {
  const response = await requestJson("/health");
  assertStatus(response, 200, "GET /health");
  assertEqual(response.body.status, "ok", "GET /health body.status");
  logOk("GET /health");
}

async function checkHomepage() {
  const response = await requestText("/");
  assertStatus(response, 200, "GET /");

  if (!response.text.includes("人生样本库") && !response.text.includes("Zhihu Hackathon Demo")) {
    throw new Error("GET / did not return the demo homepage");
  }

  logOk("GET /");
}

async function checkDemoSearch() {
  const response = await requestJson("/api/demo/search", {
    method: "POST",
    body: {
      query: "不工作了之后，我想换一种生活方式，可以从哪里开始？",
      count: 3,
      dataMode: "mock"
    }
  });
  assertStatus(response, 200, "POST /api/demo/search");
  assertEqual(response.body.success, true, "POST /api/demo/search success");

  const data = response.body.data;
  assertRecord(data, "POST /api/demo/search data");
  assertNonEmptyString(data.queryId, "demo queryId");
  assertNonEmptyArray(data.paths, "demo paths");
  assertNonEmptyArray(data.people, "demo people");

  const personaId = data.personas?.[0]?.id || data.people?.[0]?.aiPersona?.personaId;
  assertNonEmptyString(personaId, "demo personaId");

  logOk("POST /api/demo/search");
  return {
    queryId: data.queryId,
    personaId
  };
}

async function checkPersonaChat({ queryId, personaId }) {
  const response = await requestJson("/api/personas/chat", {
    method: "POST",
    body: {
      queryId,
      personaId,
      message: "如果我也想这么做，第一步应该注意什么？"
    }
  });
  assertStatus(response, 200, "POST /api/personas/chat");
  assertEqual(response.body.success, true, "POST /api/personas/chat success");
  assertNonEmptyString(response.body.data?.reply, "persona chat reply");
  assertNonEmptyArray(response.body.data?.sourceRefs, "persona chat sourceRefs");
  logOk("POST /api/personas/chat");
}

async function requestJson(path, options = {}) {
  const response = await fetch(urlFor(path), {
    method: options.method || "GET",
    headers: {
      ...(options.headers || {}),
      ...(options.body === undefined ? {} : { "Content-Type": "application/json" })
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body)
  });
  const text = await response.text();

  let body;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    throw new Error(`${options.method || "GET"} ${path} did not return JSON: ${text.slice(0, 200)}`);
  }

  return {
    status: response.status,
    body
  };
}

async function requestText(path) {
  const response = await fetch(urlFor(path));
  return {
    status: response.status,
    text: await response.text()
  };
}

function urlFor(path) {
  return new URL(path, `${baseUrl}/`).toString();
}

function assertStatus(response, expected, label) {
  if (response.status !== expected) {
    throw new Error(`${label}: expected HTTP ${expected}, got ${response.status}`);
  }
}

function assertEqual(actual, expected, label) {
  if (actual !== expected) {
    throw new Error(`${label}: expected ${String(expected)}, got ${String(actual)}`);
  }
}

function assertRecord(value, label) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label}: expected object`);
  }
}

function assertNonEmptyArray(value, label) {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`${label}: expected non-empty array`);
  }
}

function assertNonEmptyString(value, label) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${label}: expected non-empty string`);
  }
}

function logOk(label) {
  console.log(`[ok] ${label}`);
}
