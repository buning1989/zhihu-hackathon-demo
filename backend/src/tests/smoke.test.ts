import { once } from "node:events";
import { app } from "../app.js";
import { DEMO_PERSONA_BOUNDARY_NOTICE } from "../types/demo.types.js";

const server = app.listen(0, "127.0.0.1");
await once(server, "listening");

try {
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Smoke server did not expose a TCP address");
  }

  const baseUrl = `http://127.0.0.1:${address.port}`;

  const health = await requestJson(`${baseUrl}/api/health`);
  assertEqual(health.status, 200, "GET /api/health status");
  assertEqual(health.body.success, true, "GET /api/health success");

  const demoSearch = await requestJson(`${baseUrl}/api/demo/search`, {
    method: "POST",
    body: {
      query: "不工作了能去哪儿",
      count: 3,
      dataMode: "mock"
    }
  });

  assertEqual(demoSearch.status, 200, "POST /api/demo/search status");
  assertEqual(demoSearch.body.success, true, "POST /api/demo/search success");
  assertEqual(demoSearch.body.data.schemaVersion, "demo.v1", "demo schemaVersion");
  assertNonEmptyArray(demoSearch.body.data.paths, "demo paths");
  assertNonEmptyArray(demoSearch.body.data.people, "demo people");
  assertNonEmptyArray(demoSearch.body.data.personas, "demo personas");

  const personaId = demoSearch.body.data.personas[0].id;
  const queryId = demoSearch.body.data.queryId;
  const personaChat = await requestJson(`${baseUrl}/api/personas/chat`, {
    method: "POST",
    body: {
      personaId,
      queryId,
      message: "这段公开内容里，第一步应该想清楚什么？"
    }
  });

  assertEqual(personaChat.status, 200, "POST /api/personas/chat status");
  assertEqual(personaChat.body.success, true, "POST /api/personas/chat success");
  assertEqual(
    personaChat.body.data.schemaVersion,
    "personaChat.v1",
    "persona chat schemaVersion"
  );
  assertEqual(
    personaChat.body.data.boundaryNotice,
    DEMO_PERSONA_BOUNDARY_NOTICE,
    "persona chat boundaryNotice"
  );
  assertNonEmptyArray(personaChat.body.data.sourceRefs, "persona chat sourceRefs");

  const missingPersonaId = await requestJson(`${baseUrl}/api/personas/chat`, {
    method: "POST",
    body: {
      queryId,
      message: "这段公开内容里，第一步应该想清楚什么？"
    }
  });
  assertEqual(missingPersonaId.status, 400, "missing personaId status");
  assertEqual(missingPersonaId.body.success, false, "missing personaId success");
  assertEqual(
    missingPersonaId.body.error.code,
    "PERSONA_ID_REQUIRED",
    "missing personaId error code"
  );

  const missingMessage = await requestJson(`${baseUrl}/api/personas/chat`, {
    method: "POST",
    body: {
      personaId,
      queryId
    }
  });
  assertEqual(missingMessage.status, 400, "missing message status");
  assertEqual(missingMessage.body.success, false, "missing message success");
  assertEqual(missingMessage.body.error.code, "MESSAGE_REQUIRED", "missing message error code");

  console.log("backend smoke ok");
} finally {
  server.close();
}

interface RequestOptions {
  method?: "GET" | "POST";
  body?: unknown;
}

async function requestJson(url: string, options: RequestOptions = {}) {
  const response = await fetch(url, {
    method: options.method ?? "GET",
    headers: {
      ...(options.body === undefined ? {} : { "Content-Type": "application/json" })
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body)
  });

  return {
    status: response.status,
    body: await response.json()
  };
}

function assertEqual(actual: unknown, expected: unknown, label: string): void {
  if (actual !== expected) {
    throw new Error(`${label}: expected ${String(expected)}, got ${String(actual)}`);
  }
}

function assertNonEmptyArray(value: unknown, label: string): void {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`${label}: expected non-empty array`);
  }
}
