import express, { type Request, type Response } from "express";
import { config } from "./config.js";

const app = express();

app.use(express.json());

app.get("/api/health", (_req: Request, res: Response) => {
  res.json({
    status: "ok",
    service: "zhihu-hackathon-backend"
  });
});

app.get("/api/zhihu/search", async (req: Request, res: Response) => {
  const query = typeof req.query.query === "string" ? req.query.query.trim() : "";
  const count = parseCount(req.query.count);

  if (!query) {
    return res.status(400).json({
      error: "query_required",
      message: "Missing required query parameter: query"
    });
  }

  if (!config.zhihu.accessSecret) {
    return res.status(500).json({
      error: "missing_zhihu_access_secret",
      message: "ZH_ACCESS_SECRET is required in .env.local"
    });
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.zhihu.timeoutMs);

  try {
    const url = new URL(config.zhihu.searchApiUrl);
    url.searchParams.set("Query", query);
    url.searchParams.set("Count", String(count));

    const response = await fetch(url, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${config.zhihu.accessSecret}`,
        "X-Request-Timestamp": Math.floor(Date.now() / 1000).toString(),
        "Content-Type": "application/json"
      },
      signal: controller.signal
    });

    const bodyText = await response.text();
    const body = parseJsonBody(bodyText);

    if (!response.ok) {
      return res.status(response.status).json({
        error: "zhihu_search_api_error",
        status: response.status,
        body
      });
    }

    return res.json(body);
  } catch (error) {
    const isTimeout = error instanceof Error && error.name === "AbortError";
    return res.status(isTimeout ? 504 : 502).json({
      error: isTimeout ? "zhihu_search_timeout" : "zhihu_search_request_failed",
      message: error instanceof Error ? error.message : "Unknown error"
    });
  } finally {
    clearTimeout(timeout);
  }
});

app.listen(config.port, config.host, () => {
  console.log(`Backend listening on http://${config.host}:${config.port}`);
});

function parseCount(value: unknown): number {
  if (typeof value !== "string") {
    return 5;
  }

  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) {
    return 5;
  }

  return Math.min(Math.max(parsed, 1), 20);
}

function parseJsonBody(bodyText: string): unknown {
  if (!bodyText) {
    return null;
  }

  try {
    return JSON.parse(bodyText);
  } catch {
    return bodyText;
  }
}
