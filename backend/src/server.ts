import { app } from "./app.js";
import { config } from "./config/env.js";

app.listen(config.port, config.host, () => {
  console.log(`Backend listening on http://${config.host}:${config.port}`);
});

startLocalOAuthCallbackBridge();

function startLocalOAuthCallbackBridge(): void {
  const bridge = readLocalCallbackBridge(config.zhihu.redirectUri);
  if (!bridge || bridge.port === config.port) {
    return;
  }

  const server = app.listen(bridge.port, bridge.host, () => {
    console.log(`Zhihu OAuth callback bridge listening on http://${bridge.host}:${bridge.port}`);
  });

  server.on("error", (error) => {
    console.warn("[ZhihuOAuth] callback bridge unavailable", {
      host: bridge.host,
      port: bridge.port,
      error: error instanceof Error ? error.message : String(error)
    });
  });
}

function readLocalCallbackBridge(value: string): { host: string; port: number } | null {
  if (config.nodeEnv === "production") {
    return null;
  }

  const candidates = [
    value,
    "http://127.0.0.1:3001/auth/zhihu/callback"
  ];

  for (const candidate of candidates) {
    const bridge = parseLocalCallbackBridge(candidate);
    if (bridge && bridge.port !== config.port) {
      return bridge;
    }
  }

  return null;
}

function parseLocalCallbackBridge(value: string): { host: string; port: number } | null {
  if (!value) {
    return null;
  }

  try {
    const url = new URL(value);
    const hostname = url.hostname.toLowerCase();
    const port = Number.parseInt(url.port || "80", 10);
    const isLocalHost = hostname === "127.0.0.1" || hostname === "localhost";
    if (
      url.protocol === "http:" &&
      isLocalHost &&
      Number.isFinite(port) &&
      url.pathname === "/auth/zhihu/callback"
    ) {
      return {
        host: url.hostname,
        port
      };
    }
  } catch {
    return null;
  }

  return null;
}
