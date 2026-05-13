import { Router } from "express";
import { demoSearchService, parseDemoSearchRequest } from "../services/demoSearch.service.js";
import type { ApiSuccessResponse } from "../types/api.types.js";
import type { DemoSearchResponse } from "../types/demo.types.js";

export const demoRoutes = Router();

demoRoutes.post("/search", async (req, res, next) => {
  try {
    const request = parseDemoSearchRequest(req.body);
    const data = await demoSearchService.search(request);

    res.json({
      success: true,
      data
    } satisfies ApiSuccessResponse<DemoSearchResponse>);
  } catch (error) {
    next(error);
  }
});
