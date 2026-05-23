import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const backendDir = resolve(scriptDir, "..");
const guardModulePath = resolve(backendDir, "dist/routes/agent.routes.js");

if (!existsSync(guardModulePath)) {
  console.error("Built agent routes not found. Run `npm run build -w backend` before this smoke.");
  process.exit(1);
}

const { canAccessAgentInternalAdmin, isLocalRequest } = await import(guardModulePath);

assert(!isLocalRequest(mockRequest({
  ip: "203.0.113.10",
  remoteAddress: "203.0.113.10",
  headers: {
    host: "localhost:8000",
    "x-forwarded-for": "127.0.0.1"
  }
})), "forged Host/X-Forwarded-For must not be treated as local");

assert(!canAccessAgentInternalAdmin(mockRequest({
  ip: "203.0.113.10",
  remoteAddress: "203.0.113.10",
  headers: {
    host: "localhost:8000"
  }
}), {
  debugToken: "",
  nodeEnv: "development"
}), "non-local list/debug access without token must be denied");

assert(canAccessAgentInternalAdmin(mockRequest({
  ip: "127.0.0.1",
  remoteAddress: "127.0.0.1"
}), {
  debugToken: "",
  nodeEnv: "development"
}), "local list/debug access without configured token should be allowed in development");

assert(canAccessAgentInternalAdmin(mockRequest({
  ip: "203.0.113.10",
  remoteAddress: "203.0.113.10",
  headers: {
    "x-agent-debug-token": "secret-debug-token"
  }
}), {
  debugToken: "secret-debug-token",
  nodeEnv: "development"
}), "correct debug token should allow list/debug access");

assert(!canAccessAgentInternalAdmin(mockRequest({
  ip: "127.0.0.1",
  remoteAddress: "127.0.0.1",
  headers: {
    "x-agent-debug-token": "wrong-token"
  }
}), {
  debugToken: "secret-debug-token",
  nodeEnv: "development"
}), "wrong debug token must be denied even from localhost when token is configured");

assert(canAccessAgentInternalAdmin(mockRequest({
  ip: "203.0.113.10",
  remoteAddress: "203.0.113.10",
  headers: {
    authorization: "Bearer secret-debug-token"
  }
}), {
  debugToken: "secret-debug-token",
  nodeEnv: "development"
}), "Bearer debug token should allow list/debug access");

console.log("agent admin guard smoke ok");

function mockRequest({
  ip = "",
  remoteAddress = "",
  headers = {}
} = {}) {
  return {
    ip,
    headers,
    socket: {
      remoteAddress
    }
  };
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}
