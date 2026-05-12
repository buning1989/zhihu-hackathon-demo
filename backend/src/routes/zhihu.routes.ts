import { Router } from "express";
import { zhihuProvider } from "../providers/zhihu/zhihu.provider.js";
import { HttpError } from "../utils/httpError.js";

export const zhihuRoutes = Router();

zhihuRoutes.get("/search", async (req, res, next) => {
  try {
    const query = parseQuery(req.query.query);
    const count = parseCount(req.query.count);
    const rawResponse = await zhihuProvider.searchRaw({ query, count });

    res.json(rawResponse);
  } catch (error) {
    next(error);
  }
});

function parseQuery(value: unknown): string {
  const query = typeof value === "string" ? value.trim() : "";

  if (!query) {
    throw new HttpError(400, "QUERY_REQUIRED", "Missing required query parameter: query");
  }

  return query;
}

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
