import type { ErrorRequestHandler, RequestHandler } from "express";
import { HttpError } from "../utils/httpError.js";

export const notFoundMiddleware: RequestHandler = (req, _res, next) => {
  next(new HttpError(404, "ROUTE_NOT_FOUND", `Route not found: ${req.method} ${req.path}`));
};

export const errorMiddleware: ErrorRequestHandler = (error, _req, res, _next) => {
  if (error instanceof HttpError) {
    res.status(error.statusCode).json({
      success: false,
      error: {
        code: error.code,
        message: error.message
      }
    });
    return;
  }

  console.error(error);

  res.status(500).json({
    success: false,
    error: {
      code: "INTERNAL_SERVER_ERROR",
      message: "Internal server error"
    }
  });
};
