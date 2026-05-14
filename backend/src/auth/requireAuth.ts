import type { RequestHandler, Response } from "express";
import { HttpError } from "../utils/httpError.js";
import type { AuthSession } from "./session.js";
import { getAuthSession } from "./session.js";

export const requireAuth: RequestHandler = (req, res, next) => {
  const session = getAuthSession(req);
  if (!session) {
    next(new HttpError(401, "UNAUTHENTICATED", "未登录或登录态已过期"));
    return;
  }

  res.locals.authSession = session;
  next();
};

export function getRequiredAuthSession(res: Response): AuthSession {
  return res.locals.authSession as AuthSession;
}
