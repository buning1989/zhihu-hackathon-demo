import { Router } from "express";
import type { ApiSuccessResponse, HealthResponse } from "../types/api.types.js";

export const healthRoutes = Router();

healthRoutes.get("/", (_req, res) => {
  const data: HealthResponse = {
    status: "ok",
    service: "zhihu-hackathon-backend"
  };

  res.json({
    success: true,
    data
  } satisfies ApiSuccessResponse<HealthResponse>);
});
