import { Router } from "express";
import { searchService } from "../services/search.service.js";
import type { ApiSuccessResponse, SearchResult } from "../types/api.types.js";
import { HttpError } from "../utils/httpError.js";

export const searchRoutes = Router();

searchRoutes.get("/", async (req, res, next) => {
  try {
    const query = parseQuery(req.query.query);
    const count = parseCount(req.query.count);
    const dataMode = parseDataMode(req.query.dataMode ?? req.query.mode);
    const data = await searchService.search(query, count, { dataMode });

    res.json({
      success: true,
      data
    } satisfies ApiSuccessResponse<SearchResult>);
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

function parseDataMode(value: unknown): "cache_first" | "replay" | "real" | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (value === "cache_first" || value === "replay" || value === "real") {
    return value;
  }

  throw new HttpError(400, "DATA_MODE_INVALID", "dataMode must be cache_first, replay, or real");
}

function parseCount(value: unknown): number {
  if (typeof value !== "string") {
    return 10;
  }

  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) {
    return 10;
  }

  return Math.min(Math.max(parsed, 1), 20);
}
