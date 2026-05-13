import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { Request, Response } from "express";
import { config } from "../config/env.js";

export const SESSION_COOKIE_NAME = "zhihu_demo_session";
export const OAUTH_STATE_COOKIE_NAME = "zhihu_oauth_state";

const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;

interface CookieOptions {
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: "lax" | "strict" | "none";
  maxAgeSeconds?: number;
  path?: string;
}

interface OAuthStateRecord {
  expiresAtMs: number;
}

export interface ZhihuSessionToken {
  accessToken: string;
  tokenType: string;
  expiresIn: number;
  expiresAt: string | null;
}

export interface AuthSessionUser {
  id: string;
  provider: "zhihu";
  displayName: string;
  avatar: string;
  headline: string;
  isTemporary: boolean;
  userInfoLoaded: boolean;
  raw: unknown | null;
}

export interface AuthSession {
  id: string;
  provider: "zhihu";
  userInfoLoaded: boolean;
  user: AuthSessionUser;
  token: ZhihuSessionToken;
  createdAt: string;
  expiresAt: string;
}

export interface PublicAuthSession {
  provider: "zhihu";
  userInfoLoaded: boolean;
  user: Omit<AuthSessionUser, "raw">;
  session: {
    createdAt: string;
    expiresAt: string;
  };
}

const sessions = new Map<string, AuthSession>();
const oauthStates = new Map<string, OAuthStateRecord>();

export function createOAuthState(res: Response): string {
  cleanupExpiredOAuthStates();

  const state = randomId(32);
  const expiresAtMs = Date.now() + OAUTH_STATE_TTL_MS;
  oauthStates.set(state, { expiresAtMs });
  setCookie(res, OAUTH_STATE_COOKIE_NAME, signCookieValue(state), {
    httpOnly: true,
    sameSite: "lax",
    secure: isProduction(),
    maxAgeSeconds: OAUTH_STATE_TTL_MS / 1000,
    path: "/auth/zhihu/callback"
  });

  return state;
}

export function validateOAuthState(req: Request, res: Response, state: string): boolean {
  cleanupExpiredOAuthStates();

  const cookieState = readSignedCookie(req, OAUTH_STATE_COOKIE_NAME);
  const stateRecord = oauthStates.get(state);
  oauthStates.delete(state);
  clearCookie(res, OAUTH_STATE_COOKIE_NAME, { path: "/auth/zhihu/callback" });

  if (!state || !cookieState || state !== cookieState || !stateRecord) {
    return false;
  }

  return stateRecord.expiresAtMs >= Date.now();
}

export function createAuthSession(
  res: Response,
  sessionInput: Omit<AuthSession, "id" | "createdAt" | "expiresAt">
): AuthSession {
  cleanupExpiredSessions();

  const sessionId = randomId(32);
  const nowMs = Date.now();
  const session: AuthSession = {
    ...sessionInput,
    id: sessionId,
    createdAt: new Date(nowMs).toISOString(),
    expiresAt: new Date(nowMs + SESSION_TTL_MS).toISOString()
  };

  sessions.set(sessionId, session);
  setCookie(res, SESSION_COOKIE_NAME, signCookieValue(sessionId), {
    httpOnly: true,
    sameSite: "lax",
    secure: isProduction(),
    maxAgeSeconds: SESSION_TTL_MS / 1000,
    path: "/"
  });

  return session;
}

export function getAuthSession(req: Request): AuthSession | null {
  cleanupExpiredSessions();

  const sessionId = readSignedCookie(req, SESSION_COOKIE_NAME);
  if (!sessionId) {
    return null;
  }

  const session = sessions.get(sessionId);
  if (!session || Date.parse(session.expiresAt) <= Date.now()) {
    sessions.delete(sessionId);
    return null;
  }

  return session;
}

export function destroyAuthSession(req: Request, res: Response): void {
  const sessionId = readSignedCookie(req, SESSION_COOKIE_NAME);
  if (sessionId) {
    sessions.delete(sessionId);
  }

  clearCookie(res, SESSION_COOKIE_NAME, { path: "/" });
}

export function toPublicAuthSession(session: AuthSession): PublicAuthSession {
  return {
    provider: session.provider,
    userInfoLoaded: session.userInfoLoaded,
    user: {
      id: session.user.id,
      provider: session.user.provider,
      displayName: session.user.displayName,
      avatar: session.user.avatar,
      headline: session.user.headline,
      isTemporary: session.user.isTemporary,
      userInfoLoaded: session.user.userInfoLoaded
    },
    session: {
      createdAt: session.createdAt,
      expiresAt: session.expiresAt
    }
  };
}

export function randomId(byteLength = 24): string {
  return randomBytes(byteLength).toString("base64url");
}

function readSignedCookie(req: Request, name: string): string | null {
  const rawValue = parseCookies(req)[name];
  if (!rawValue) {
    return null;
  }

  return verifyCookieValue(rawValue);
}

function parseCookies(req: Request): Record<string, string> {
  const header = req.headers.cookie;
  if (!header) {
    return {};
  }

  return header.split(";").reduce<Record<string, string>>((cookies, pair) => {
    const separatorIndex = pair.indexOf("=");
    if (separatorIndex === -1) {
      return cookies;
    }

    const name = pair.slice(0, separatorIndex).trim();
    const value = pair.slice(separatorIndex + 1).trim();
    if (!name) {
      return cookies;
    }

    cookies[name] = safeDecodeURIComponent(value);
    return cookies;
  }, {});
}

function safeDecodeURIComponent(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function setCookie(res: Response, name: string, value: string, options: CookieOptions): void {
  const serialized = serializeCookie(name, value, options);
  const existing = res.getHeader("Set-Cookie");

  if (!existing) {
    res.setHeader("Set-Cookie", serialized);
    return;
  }

  const values = Array.isArray(existing) ? existing.map(String) : [String(existing)];
  res.setHeader("Set-Cookie", [...values, serialized]);
}

function clearCookie(res: Response, name: string, options: Pick<CookieOptions, "path">): void {
  setCookie(res, name, "", {
    path: options.path,
    httpOnly: true,
    sameSite: "lax",
    secure: isProduction(),
    maxAgeSeconds: 0
  });
}

function serializeCookie(name: string, value: string, options: CookieOptions): string {
  const parts = [`${name}=${encodeURIComponent(value)}`];

  parts.push(`Path=${options.path ?? "/"}`);

  if (options.maxAgeSeconds !== undefined) {
    parts.push(`Max-Age=${Math.floor(options.maxAgeSeconds)}`);
  }

  if (options.httpOnly) {
    parts.push("HttpOnly");
  }

  if (options.secure) {
    parts.push("Secure");
  }

  if (options.sameSite) {
    parts.push(`SameSite=${options.sameSite}`);
  }

  return parts.join("; ");
}

function signCookieValue(value: string): string {
  return `${value}.${hmac(value)}`;
}

function verifyCookieValue(signedValue: string): string | null {
  const separatorIndex = signedValue.lastIndexOf(".");
  if (separatorIndex === -1) {
    return null;
  }

  const value = signedValue.slice(0, separatorIndex);
  const signature = signedValue.slice(separatorIndex + 1);
  const expected = hmac(value);

  const signatureBuffer = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expected);
  if (
    signatureBuffer.length !== expectedBuffer.length ||
    !timingSafeEqual(signatureBuffer, expectedBuffer)
  ) {
    return null;
  }

  return value;
}

function hmac(value: string): string {
  return createHmac("sha256", config.sessionSecret).update(value).digest("base64url");
}

function cleanupExpiredOAuthStates(): void {
  const now = Date.now();
  for (const [state, record] of oauthStates.entries()) {
    if (record.expiresAtMs <= now) {
      oauthStates.delete(state);
    }
  }
}

function cleanupExpiredSessions(): void {
  const now = Date.now();
  for (const [sessionId, session] of sessions.entries()) {
    if (Date.parse(session.expiresAt) <= now) {
      sessions.delete(sessionId);
    }
  }
}

function isProduction(): boolean {
  return config.nodeEnv === "production";
}
