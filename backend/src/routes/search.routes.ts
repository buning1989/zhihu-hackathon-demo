import { Router } from "express";
import { searchService } from "../services/search.service.js";
import type { ApiSuccessResponse, SearchResult } from "../types/api.types.js";
import { HttpError } from "../utils/httpError.js";

export const searchRoutes = Router();

searchRoutes.get("/", async (req, res, next) => {
  try {
    const query = parseQuery(req.query.query);
    const count = parseCount(req.query.count);
    const data = await searchService.search(query, count);

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
