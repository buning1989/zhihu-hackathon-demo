import { Router } from "express";
import { zhihuProvider } from "../providers/zhihu/zhihu.provider.js";
import { HttpError } from "../utils/httpError.js";

export const zhihuRoutes = Router();

const ALLOWED_RING_IDS = new Set([
  "2001009660925334090",
  "2015023739549529606",
  "2029619126742656657"
]);

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

zhihuRoutes.post("/ring/publish", async (req, res, next) => {
  try {
    const request = parseRingPublishBody(req.body);
    const result = await zhihuProvider.publishPinToRing(request);

    res.json({
      success: true,
      data: {
        contentToken: result.contentToken
      },
      meta: {
        ringId: request.ringId,
        logId: result.logId
      }
    });
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

interface RingPublishBody {
  ringId: string;
  title: string;
  content: string;
  imageUrls: string[];
}

function parseRingPublishBody(body: unknown): RingPublishBody {
  const record = isRecord(body) ? body : {};
  const ringId = parseRequiredBodyString(record.ringId, "ringId", "RING_ID_REQUIRED");
  const title = parseRequiredBodyString(record.title, "title", "TITLE_REQUIRED");
  const content = parseRequiredBodyString(record.content, "content", "CONTENT_REQUIRED");

  if (!ALLOWED_RING_IDS.has(ringId)) {
    throw new HttpError(400, "ZHIHU_RING_NOT_ALLOWED", "圈子 ID 不在允许发布的白名单内");
  }

  return {
    ringId,
    title,
    content,
    imageUrls: parseImageUrls(record.imageUrls)
  };
}

function parseRequiredBodyString(value: unknown, field: string, code: string): string {
  const parsed = typeof value === "string" ? value.trim() : "";

  if (!parsed) {
    throw new HttpError(400, code, `Missing required body field: ${field}`);
  }

  return parsed;
}

function parseImageUrls(value: unknown): string[] {
  if (value === undefined) {
    return [];
  }

  if (!Array.isArray(value)) {
    throw new HttpError(400, "IMAGE_URLS_INVALID", "imageUrls must be an array of URL strings");
  }

  return value.map((item) => parseImageUrl(item));
}

function parseImageUrl(value: unknown): string {
  const url = typeof value === "string" ? value.trim() : "";
  if (!url) {
    throw new HttpError(400, "IMAGE_URLS_INVALID", "imageUrls must be an array of URL strings");
  }

  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new Error("Unsupported protocol");
    }
  } catch {
    throw new HttpError(400, "IMAGE_URLS_INVALID", "imageUrls must be an array of URL strings");
  }

  return url;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
