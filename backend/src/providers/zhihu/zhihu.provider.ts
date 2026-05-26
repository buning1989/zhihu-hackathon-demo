import { createHmac, randomUUID } from "node:crypto";
import { config } from "../../config/env.js";
import { HttpError } from "../../utils/httpError.js";
import type {
  ZhihuPublishPinRawResponse,
  ZhihuPublishPinToRingParams,
  ZhihuPublishPinToRingResult,
  ZhihuSearchOptions,
  ZhihuSearchParams,
  ZhihuSearchRawResponse
} from "./zhihu.types.js";
import {
  consumeZhihuRealApiBudget,
  isRealZhihuApiAllowed,
  logZhihuSearchUsage,
  normalizeZhihuSearchQuery,
  readZhihuSearchFixture,
  resolveZhihuSearchDataMode,
  writeZhihuSearchFixture
} from "./zhihuSearchFixtures.js";

const RING_PUBLISH_RATE_LIMIT = 5;
const RING_PUBLISH_RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000;

let ringPublishWindowStartedAt = Date.now();
let ringPublishCount = 0;

export class ZhihuProvider {
  async searchRaw(
    params: ZhihuSearchParams,
    options?: ZhihuSearchOptions
  ): Promise<ZhihuSearchRawResponse> {
    const dataMode = resolveZhihuSearchDataMode(options);
    const normalizedQuery = normalizeZhihuSearchQuery(params.query);
    const fixture = readZhihuSearchFixture(params);

    if (fixture) {
      logZhihuSearchUsage({
        mode: dataMode,
        query: params.query,
        normalizedQuery,
        count: params.count,
        action: "fixture_hit",
        consumed: 0,
        fixtureId: fixture.id
      });
      return fixture.response;
    }

    if (dataMode === "replay") {
      logZhihuSearchUsage({
        mode: dataMode,
        query: params.query,
        normalizedQuery,
        count: params.count,
        action: "fixture_missing",
        consumed: 0,
        reason: "replay_fixture_missing"
      });
      throw new HttpError(
        404,
        "ZHIHU_REPLAY_FIXTURE_MISSING",
        `知乎搜索 replay fixture 缺失：query="${params.query}", count=${params.count}`
      );
    }

    if (!isRealZhihuApiAllowed(dataMode)) {
      logZhihuSearchUsage({
        mode: dataMode,
        query: params.query,
        normalizedQuery,
        count: params.count,
        action: "real_blocked",
        consumed: 0,
        reason: "real_api_not_allowed"
      });
      throw new HttpError(
        409,
        "ZHIHU_REAL_API_NOT_ALLOWED",
        "当前模式不允许真实调用知乎 API；请使用 replay fixture，或显式设置 DATA_MODE=real / ALLOW_REAL_ZH_API=1"
      );
    }

    if (!config.zhihu.accessSecret) {
      logZhihuSearchUsage({
        mode: dataMode,
        query: params.query,
        normalizedQuery,
        count: params.count,
        action: "real_blocked",
        consumed: 0,
        reason: "missing_access_secret"
      });
      throw new HttpError(
        500,
        "ZHIHU_AUTH_FAILED",
        "缺少 ZH_ACCESS_SECRET 或 ZHIHU_API_KEY，无法调用知乎 API"
      );
    }

    consumeZhihuRealApiBudget({
      mode: dataMode,
      query: params.query,
      count: params.count
    });

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), config.zhihu.timeoutMs);

    try {
      const url = new URL(config.zhihu.searchApiUrl);
      url.searchParams.set("Query", params.query);
      url.searchParams.set("Count", String(params.count));

      const response = await fetch(url, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${config.zhihu.accessSecret}`,
          "X-Request-Timestamp": Math.floor(Date.now() / 1000).toString(),
          "Content-Type": "application/json"
        },
        signal: controller.signal
      });

      const body = parseJsonBody(await response.text());
      const apiCode = readApiCode(body);

      if (!response.ok || (apiCode !== null && apiCode >= 400)) {
        const status = apiCode ?? response.status;
        const isAuthError = status === 401 || status === 403;
        throw new HttpError(
          isAuthError ? 401 : response.ok ? 502 : response.status,
          isAuthError ? "ZHIHU_AUTH_FAILED" : "ZHIHU_API_ERROR",
          readZhihuErrorMessage(body) ||
            (isAuthError ? "知乎 API 鉴权失败" : "知乎 API 请求失败")
        );
      }

      const rawResponse = isRecord(body)
        ? body
        : { Code: response.status, Message: "OK", Data: body };
      writeZhihuSearchFixture(params, rawResponse);
      return rawResponse;
    } catch (error) {
      if (error instanceof HttpError) {
        logZhihuSearchUsage({
          mode: dataMode,
          query: params.query,
          normalizedQuery,
          count: params.count,
          action: "real_failed",
          consumed: 0,
          reason: error.code
        });
        throw error;
      }

      if (error instanceof Error && error.name === "AbortError") {
        logZhihuSearchUsage({
          mode: dataMode,
          query: params.query,
          normalizedQuery,
          count: params.count,
          action: "real_failed",
          consumed: 0,
          reason: "ZHIHU_TIMEOUT"
        });
        throw new HttpError(504, "ZHIHU_TIMEOUT", "知乎 API 请求超时");
      }

      logZhihuSearchUsage({
        mode: dataMode,
        query: params.query,
        normalizedQuery,
        count: params.count,
        action: "real_failed",
        consumed: 0,
        reason: "ZHIHU_REQUEST_FAILED"
      });
      throw new HttpError(502, "ZHIHU_REQUEST_FAILED", buildRequestFailedMessage(error));
    } finally {
      clearTimeout(timeout);
    }
  }

  async publishPinToRing(
    params: ZhihuPublishPinToRingParams
  ): Promise<ZhihuPublishPinToRingResult> {
    assertZhihuRingPublishConfigured();
    consumeRingPublishRateLimitSlot();

    const timestamp = Math.floor(Date.now() / 1000).toString();
    const logId = randomUUID();
    const extraInfo = "";
    const sign = buildOpenapiSignature(timestamp, logId, extraInfo);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), config.zhihu.timeoutMs);
    const body = buildPublishPinRequestBody(params);

    try {
      const response = await fetch(new URL("/openapi/publish/pin", config.zhihu.openapiBase), {
        method: "POST",
        headers: {
          "X-App-Key": config.zhihu.openapiAppKey,
          "X-Timestamp": timestamp,
          "X-Log-Id": logId,
          "X-Sign": sign,
          "X-Extra-Info": extraInfo,
          "Content-Type": "application/json"
        },
        body: JSON.stringify(body),
        signal: controller.signal
      });

      const responseBody = parseJsonBody(await response.text());
      const apiStatus = readApiStatus(responseBody);
      const apiCode = readApiCode(responseBody);
      const failedByStatus = apiStatus !== null && apiStatus !== 0;
      const failedByCode = apiStatus === null && apiCode !== null && apiCode !== 0;

      if (!response.ok || failedByStatus || failedByCode) {
        throw new HttpError(
          mapZhihuPublishErrorStatus(response.status),
          "ZHIHU_RING_PUBLISH_FAILED",
          readZhihuErrorMessage(responseBody) || "知乎圈子想法发布失败"
        );
      }

      const contentToken = readContentToken(responseBody);
      if (!contentToken) {
        throw new HttpError(
          502,
          "ZHIHU_RING_PUBLISH_BAD_RESPONSE",
          "知乎圈子想法发布响应缺少 content_token"
        );
      }

      return {
        contentToken,
        logId,
        raw: isRecord(responseBody) ? responseBody : { status: response.status, data: responseBody }
      };
    } catch (error) {
      if (error instanceof HttpError) {
        throw error;
      }

      if (error instanceof Error && error.name === "AbortError") {
        throw new HttpError(504, "ZHIHU_RING_PUBLISH_TIMEOUT", "知乎圈子想法发布请求超时");
      }

      throw new HttpError(502, "ZHIHU_RING_PUBLISH_REQUEST_FAILED", "知乎圈子想法发布请求失败");
    } finally {
      clearTimeout(timeout);
    }
  }
}

export const zhihuProvider = new ZhihuProvider();

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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readApiCode(body: unknown): number | null {
  if (!isRecord(body)) {
    return null;
  }

  const code = body.code ?? body.Code;
  if (typeof code === "number") {
    return code;
  }

  if (typeof code === "string" && code.trim()) {
    const parsed = Number.parseInt(code, 10);
    return Number.isFinite(parsed) ? parsed : null;
  }

  return null;
}

function readApiStatus(body: unknown): number | null {
  if (!isRecord(body)) {
    return null;
  }

  return parseApiInteger(body.status);
}

function readZhihuErrorMessage(body: unknown): string | null {
  if (!isRecord(body)) {
    return null;
  }

  const message = body.msg ?? body.message ?? body.Message ?? body.data ?? body.Data;
  return typeof message === "string" && message.trim() ? message : null;
}

function buildRequestFailedMessage(error: unknown): string {
  if (error instanceof Error && error.message) {
    return `知乎 API 请求失败: ${error.message}`;
  }

  return "知乎 API 请求失败";
}

function assertZhihuRingPublishConfigured(): void {
  const missing = [
    ["ZHIHU_OPENAPI_APP_KEY", config.zhihu.openapiAppKey],
    ["ZHIHU_OPENAPI_APP_SECRET", config.zhihu.openapiAppSecret]
  ]
    .filter(([, value]) => !value)
    .map(([name]) => name);

  if (missing.length > 0) {
    throw new HttpError(
      500,
      "ZHIHU_RING_PUBLISH_CONFIG_ERROR",
      `知乎圈子发布 OpenAPI 配置缺失：${missing.join(", ")}`
    );
  }
}

function buildOpenapiSignature(timestamp: string, logId: string, extraInfo: string): string {
  const signString = `app_key:${config.zhihu.openapiAppKey}|ts:${timestamp}|logid:${logId}|extra_info:${extraInfo}`;

  return createHmac("sha256", config.zhihu.openapiAppSecret)
    .update(signString, "utf8")
    .digest("base64");
}

function buildPublishPinRequestBody(params: ZhihuPublishPinToRingParams): Record<string, unknown> {
  const body: Record<string, unknown> = {
    ring_id: params.ringId,
    title: params.title,
    content: params.content
  };

  if (params.imageUrls && params.imageUrls.length > 0) {
    body.image_urls = params.imageUrls;
  }

  return body;
}

function consumeRingPublishRateLimitSlot(): void {
  const now = Date.now();
  if (now - ringPublishWindowStartedAt >= RING_PUBLISH_RATE_LIMIT_WINDOW_MS) {
    ringPublishWindowStartedAt = now;
    ringPublishCount = 0;
  }

  if (ringPublishCount >= RING_PUBLISH_RATE_LIMIT) {
    throw new HttpError(
      429,
      "ZHIHU_RING_PUBLISH_RATE_LIMITED",
      "本地进程内圈子发布限流：同一小时最多 5 次真实发布"
    );
  }

  ringPublishCount += 1;
}

function readContentToken(body: unknown): string {
  const payload = unwrapData(body);
  if (isRecord(payload)) {
    return readString(payload, "content_token", "contentToken");
  }

  if (isRecord(body)) {
    return readString(body, "content_token", "contentToken");
  }

  return "";
}

function unwrapData(body: unknown): unknown {
  if (isRecord(body) && isRecord(body.data)) {
    return body.data;
  }

  if (isRecord(body) && isRecord(body.Data)) {
    return body.Data;
  }

  return body;
}

function readString(record: Record<string, unknown>, ...keys: string[]): string {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) {
      return value;
    }
  }

  return "";
}

function parseApiInteger(value: unknown): number | null {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }

  if (typeof value === "string" && value.trim()) {
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) ? parsed : null;
  }

  return null;
}

function mapZhihuPublishErrorStatus(httpStatus: number): number {
  if (httpStatus === 401 || httpStatus === 403 || httpStatus === 429) {
    return httpStatus;
  }

  if (httpStatus >= 400 && httpStatus < 500) {
    return httpStatus;
  }

  return 502;
}
