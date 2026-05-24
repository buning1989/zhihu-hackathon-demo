import { Router } from "express";
import { config } from "../config/env.js";
import { HttpError } from "../utils/httpError.js";
import { getRequiredAuthSession, requireAuth } from "./requireAuth.js";
import {
  createAuthSession,
  destroyAuthSession,
  randomId,
  toPublicAuthSession,
  validateOAuthState,
  type AuthSessionUser
} from "./session.js";
import {
  exchangeCodeForToken,
  fetchZhihuUserInfo
} from "./zhihuOAuth.js";

export const authRoutes = Router();

authRoutes.get("/zhihu/login", (_req, res) => {
  res.status(410).json({
    success: false,
    error: {
      code: "AUTH_DISABLED",
      message: "Zhihu OAuth login is disabled for the local demo."
    }
  });
});

authRoutes.get("/zhihu/callback", async (req, res, next) => {
  try {
    const code = parseAuthorizationCode(req.query.code, req.query.authorization_code);
    const state = readQueryString(req.query.state);

    // Zhihu's current callback does not echo state in this demo flow. For demo compatibility,
    // allow missing state; production should require provider state support or stricter login protection.
    if (state && !validateOAuthState(req, res, state)) {
      throw new HttpError(400, "INVALID_OAUTH_STATE", "知乎 OAuth state 校验失败");
    }

    const token = await exchangeCodeForToken(code);
    const userInfo = await fetchZhihuUserInfo(token);
    const userInfoLoaded = userInfo !== null;

    createAuthSession(res, {
      provider: "zhihu",
      userInfoLoaded,
      user: buildSessionUser(userInfo, userInfoLoaded),
      token: {
        accessToken: token.accessToken,
        tokenType: token.tokenType,
        expiresIn: token.expiresIn,
        expiresAt:
          token.expiresIn > 0
            ? new Date(Date.now() + token.expiresIn * 1000).toISOString()
            : null
      }
    });

    res.redirect(302, config.frontendUrl);
  } catch (error) {
    next(error);
  }
});

authRoutes.get("/me", requireAuth, (_req, res) => {
  const session = getRequiredAuthSession(res);
  res.json({
    success: true,
    data: toPublicAuthSession(session)
  });
});

authRoutes.post("/logout", (req, res) => {
  destroyAuthSession(req, res);
  res.json({
    success: true,
    data: {
      loggedOut: true
    }
  });
});

function parseAuthorizationCode(codeValue: unknown, authorizationCodeValue: unknown): string {
  const code = readQueryString(codeValue);
  if (code) {
    return code;
  }

  const authorizationCode = readQueryString(authorizationCodeValue);
  if (authorizationCode) {
    return authorizationCode;
  }

  throw new HttpError(400, "OAUTH_QUERY_REQUIRED", "Missing required query parameter: code");
}

function readQueryString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function buildSessionUser(userInfo: unknown, userInfoLoaded: boolean): AuthSessionUser {
  if (!userInfoLoaded) {
    return {
      id: `zhihu-temp-${randomId(12)}`,
      provider: "zhihu",
      displayName: "知乎临时用户",
      avatar: "",
      profileUrl: "",
      headline: "",
      isTemporary: true,
      userInfoLoaded: false,
      raw: null
    };
  }

  const record = isRecord(userInfo) ? userInfo : {};
  return {
    id: readString(record, "id", "uid", "user_id", "open_id", "union_id") || `zhihu-${randomId(12)}`,
    provider: "zhihu",
    displayName:
      readString(record, "fullname", "name", "nickname", "display_name", "username") ||
      "知乎用户",
    avatar: readString(record, "avatar_path", "avatar", "avatar_url", "image_url"),
    profileUrl: readProfileUrl(record),
    headline: readString(record, "headline", "description", "bio"),
    isTemporary: false,
    userInfoLoaded: true,
    raw: userInfo
  };
}

function readString(record: Record<string, unknown>, ...keys: string[]): string {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) {
      return value;
    }

    if (typeof value === "number" && Number.isFinite(value)) {
      return String(value);
    }
  }

  return "";
}

function readProfileUrl(record: Record<string, unknown>): string {
  const directUrl = readValidZhihuProfileUrl(
    readString(record, "profileUrl", "profile_url", "html_url", "user_url")
  );
  if (directUrl) {
    return directUrl;
  }

  const urlToken = readString(record, "urlToken", "url_token", "slug");
  return urlToken ? `https://www.zhihu.com/people/${encodeURIComponent(urlToken)}` : "";
}

function readValidZhihuProfileUrl(value: string): string {
  if (!value) {
    return "";
  }

  try {
    const url = new URL(value);
    const hostname = url.hostname.toLowerCase();
    const isZhihuWebHost = hostname === "zhihu.com" || hostname.endsWith(".zhihu.com");
    const isOpenApiHost = hostname === "openapi.zhihu.com";
    return isZhihuWebHost && !isOpenApiHost && url.pathname.startsWith("/people/") ? url.toString() : "";
  } catch {
    return "";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
