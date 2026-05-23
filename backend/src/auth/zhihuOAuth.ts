import { config } from "../config/env.js";
import { HttpError } from "../utils/httpError.js";

export interface ZhihuAccessToken {
  accessToken: string;
  tokenType: string;
  expiresIn: number;
  raw: unknown;
}

interface TokenExchangeLogContext {
  redirectUri: string;
  appId: string;
  grantType: "authorization_code";
  hasCode: boolean;
}

interface ZhihuJsonResponse {
  httpStatus: number;
  body: unknown;
}

export function buildZhihuAuthorizationUrl(
  state: string,
  redirectUri = config.zhihu.redirectUri
): string {
  assertZhihuOAuthConfigured();

  const url = new URL("/authorize", config.zhihu.openapiBase);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("app_id", config.zhihu.appId);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("state", state);

  return url.toString();
}

export async function exchangeCodeForToken(
  code: string,
  redirectUri = config.zhihu.redirectUri
): Promise<ZhihuAccessToken> {
  assertZhihuOAuthConfigured();

  const body = new URLSearchParams({
    app_id: config.zhihu.appId,
    app_key: config.zhihu.appKey,
    grant_type: "authorization_code",
    redirect_uri: redirectUri,
    code
  });

  const tokenExchangeLogContext: TokenExchangeLogContext = {
    redirectUri,
    appId: config.zhihu.appId,
    grantType: "authorization_code",
    hasCode: Boolean(code)
  };

  const tokenResponse = await requestZhihuTokenJson(
    new URL("/access_token", config.zhihu.openapiBase),
    {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded"
      },
      body
    },
    tokenExchangeLogContext
  );

  const responseBody = tokenResponse.body;
  const payload = unwrapData(responseBody);
  if (!isRecord(payload)) {
    logTokenExchangeFailure(tokenResponse.httpStatus, responseBody, tokenExchangeLogContext);
    throw new HttpError(502, "ZHIHU_OAUTH_BAD_RESPONSE", "知乎 OAuth token 响应格式异常");
  }

  const accessToken = readString(payload, "access_token", "accessToken");
  if (!accessToken) {
    logTokenExchangeFailure(tokenResponse.httpStatus, responseBody, tokenExchangeLogContext);
    throw new HttpError(502, "ZHIHU_OAUTH_BAD_RESPONSE", "知乎 OAuth token 响应缺少 access_token");
  }

  return {
    accessToken,
    tokenType: readString(payload, "token_type", "tokenType") || "Bearer",
    expiresIn: readNumber(payload, "expires_in", "expiresIn") ?? 0,
    raw: responseBody
  };
}

export async function fetchZhihuUserInfo(token: ZhihuAccessToken): Promise<unknown | null> {
  const userinfoPath = config.zhihu.userinfoPath.trim();
  if (!userinfoPath) {
    return null;
  }

  const responseBody = await requestZhihuJson(
    buildOpenApiUrl(userinfoPath),
    {
      method: "GET",
      headers: {
        Authorization: `${normalizeTokenType(token.tokenType)} ${token.accessToken}`
      }
    },
    "ZHIHU_USERINFO_FAILED",
    "知乎用户信息请求失败"
  );

  return unwrapData(responseBody);
}

export function assertZhihuOAuthConfigured(): void {
  const missing = [
    ["ZHIHU_APP_ID", config.zhihu.appId],
    ["ZHIHU_APP_KEY", config.zhihu.appKey],
    ["ZHIHU_REDIRECT_URI", config.zhihu.redirectUri]
  ]
    .filter(([, value]) => !value)
    .map(([name]) => name);

  if (missing.length > 0) {
    throw new HttpError(
      500,
      "ZHIHU_OAUTH_NOT_CONFIGURED",
      `知乎 OAuth 未配置：${missing.join(", ")}`
    );
  }
}

function buildOpenApiUrl(pathOrUrl: string): URL {
  if (/^https?:\/\//i.test(pathOrUrl)) {
    return new URL(pathOrUrl);
  }

  const normalizedPath = pathOrUrl.startsWith("/") ? pathOrUrl : `/${pathOrUrl}`;
  return new URL(normalizedPath, config.zhihu.openapiBase);
}

async function requestZhihuJson(
  url: URL,
  init: RequestInit,
  errorCode: string,
  fallbackMessage: string
): Promise<unknown> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.zhihu.timeoutMs);

  try {
    const response = await fetch(url, {
      ...init,
      signal: controller.signal
    });
    const body = parseJsonBody(await response.text());
    const apiCode = readApiCode(body);

    if (!response.ok || (apiCode !== null && apiCode >= 400)) {
      throw new HttpError(
        mapZhihuErrorStatus(response.status, apiCode),
        errorCode,
        readZhihuErrorMessage(body) || fallbackMessage
      );
    }

    return body;
  } catch (error) {
    if (error instanceof HttpError) {
      throw error;
    }

    if (error instanceof Error && error.name === "AbortError") {
      throw new HttpError(504, "ZHIHU_OAUTH_TIMEOUT", "知乎 OAuth 请求超时");
    }

    throw new HttpError(502, errorCode, fallbackMessage);
  } finally {
    clearTimeout(timeout);
  }
}

async function requestZhihuTokenJson(
  url: URL,
  init: RequestInit,
  tokenExchangeLogContext: TokenExchangeLogContext
): Promise<ZhihuJsonResponse> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.zhihu.timeoutMs);

  try {
    const response = await fetch(url, {
      ...init,
      signal: controller.signal
    });
    const body = parseJsonBody(await response.text());

    if (!response.ok) {
      logTokenExchangeFailure(response.status, body, tokenExchangeLogContext);

      throw new HttpError(
        mapZhihuErrorStatus(response.status, readApiCode(body)),
        "ZHIHU_OAUTH_TOKEN_FAILED",
        readZhihuErrorMessage(body) || "知乎 OAuth token 请求失败"
      );
    }

    return {
      httpStatus: response.status,
      body
    };
  } catch (error) {
    if (error instanceof HttpError) {
      throw error;
    }

    if (error instanceof Error && error.name === "AbortError") {
      logTokenExchangeFailure(null, null, tokenExchangeLogContext);
      throw new HttpError(504, "ZHIHU_OAUTH_TIMEOUT", "知乎 OAuth 请求超时");
    }

    logTokenExchangeFailure(null, null, tokenExchangeLogContext);
    throw new HttpError(502, "ZHIHU_OAUTH_TOKEN_FAILED", "知乎 OAuth token 请求失败");
  } finally {
    clearTimeout(timeout);
  }
}

function logTokenExchangeFailure(
  httpStatus: number | null,
  responseBody: unknown,
  context: TokenExchangeLogContext
): void {
  console.error("[ZhihuOAuth] token exchange failed", {
    httpStatus,
    hasAccessToken: hasAccessToken(responseBody),
    zhihuCode: readApiCode(responseBody),
    redirectUri: context.redirectUri,
    appId: context.appId,
    grantType: context.grantType,
    hasCode: context.hasCode
  });
}

function hasAccessToken(body: unknown): boolean {
  const payload = unwrapData(body);
  return isRecord(payload) && Boolean(readString(payload, "access_token", "accessToken"));
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

  const value = body.message ?? body.Message ?? body.data ?? body.Data;
  if (typeof value === "string" && value.trim()) {
    return value;
  }

  return null;
}

function mapZhihuErrorStatus(httpStatus: number, apiCode: number | null): number {
  const status = apiCode ?? httpStatus;
  if (status === 401 || status === 403) {
    return status;
  }

  if (httpStatus >= 400 && httpStatus < 500) {
    return httpStatus;
  }

  return 502;
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

function normalizeTokenType(tokenType: string): string {
  return tokenType.toLowerCase() === "bearer" ? "Bearer" : tokenType || "Bearer";
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

function readNumber(record: Record<string, unknown>, ...keys: string[]): number | null {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    }

    if (typeof value === "string" && value.trim()) {
      const parsed = Number.parseInt(value, 10);
      if (Number.isFinite(parsed)) {
        return parsed;
      }
    }
  }

  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
