import { config } from "../../config/env.js";
import { HttpError } from "../../utils/httpError.js";
import type { ZhihuSearchParams, ZhihuSearchRawResponse } from "./zhihu.types.js";

export class ZhihuProvider {
  async searchRaw(params: ZhihuSearchParams): Promise<ZhihuSearchRawResponse> {
    if (!config.zhihu.accessSecret) {
      throw new HttpError(500, "ZHIHU_AUTH_FAILED", "知乎 API 鉴权失败");
    }

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

      return isRecord(body) ? body : { Code: response.status, Message: "OK", Data: body };
    } catch (error) {
      if (error instanceof HttpError) {
        throw error;
      }

      if (error instanceof Error && error.name === "AbortError") {
        throw new HttpError(504, "ZHIHU_TIMEOUT", "知乎 API 请求超时");
      }

      throw new HttpError(502, "ZHIHU_REQUEST_FAILED", "知乎 API 请求失败");
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

function isRecord(value: unknown): value is ZhihuSearchRawResponse {
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

function readZhihuErrorMessage(body: unknown): string | null {
  if (!isRecord(body)) {
    return null;
  }

  const message = body.message ?? body.Message ?? body.data ?? body.Data;
  return typeof message === "string" && message.trim() ? message : null;
}
