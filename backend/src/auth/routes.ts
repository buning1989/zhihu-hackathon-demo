import { Router } from "express";
import { config } from "../config/env.js";
import { HttpError } from "../utils/httpError.js";
import { getRequiredAuthSession, requireAuth } from "./requireAuth.js";
import {
  createAuthSession,
  createOAuthState,
  destroyAuthSession,
  randomId,
  toPublicAuthSession,
  validateOAuthState,
  type AuthSessionUser
} from "./session.js";
import {
  assertZhihuOAuthConfigured,
  buildZhihuAuthorizationUrl,
  exchangeCodeForToken,
  fetchZhihuUserInfo
} from "./zhihuOAuth.js";

export const authRoutes = Router();

authRoutes.get("/zhihu/login", (_req, res, next) => {
  try {
    assertZhihuOAuthConfigured();
    const state = createOAuthState(res);
    res.redirect(302, buildZhihuAuthorizationUrl(state));
  } catch (error) {
    next(error);
  }
});

authRoutes.get("/zhihu/callback", async (req, res, next) => {
  try {
    const code = parseQueryString(req.query.code, "code");
    const state = parseQueryString(req.query.state, "state");

    if (!validateOAuthState(req, res, state)) {
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

function parseQueryString(value: unknown, name: string): string {
  const parsed = typeof value === "string" ? value.trim() : "";

  if (!parsed) {
    throw new HttpError(400, "OAUTH_QUERY_REQUIRED", `Missing required query parameter: ${name}`);
  }

  return parsed;
}

function buildSessionUser(userInfo: unknown, userInfoLoaded: boolean): AuthSessionUser {
  if (!userInfoLoaded) {
    return {
      id: `zhihu-temp-${randomId(12)}`,
      provider: "zhihu",
      displayName: "知乎临时用户",
      avatar: "",
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
      readString(record, "name", "nickname", "display_name", "username") || "知乎用户",
    avatar: readString(record, "avatar", "avatar_url", "image_url"),
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
  }

  return "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
