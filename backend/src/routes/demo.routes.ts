import { Router } from "express";
import { getCurrentUserContext } from "../auth/session.js";
import { demoSearchService, parseDemoSearchRequest } from "../services/demoSearch.service.js";
import type { ApiSuccessResponse } from "../types/api.types.js";
import type {
  DemoIntentSearchPlanResponse,
  DemoSearchResponse
} from "../types/demo.types.js";

export const demoRoutes = Router();

demoRoutes.post("/search", async (req, res, next) => {
  try {
    const request = parseDemoSearchRequest(req.body);
    const userContext = getCurrentUserContext(req);
    const data = await demoSearchService.search(request, userContext);

    res.json({
      success: true,
      data
    } satisfies ApiSuccessResponse<DemoSearchResponse | DemoIntentSearchPlanResponse>);
  } catch (error) {
    next(error);
  }
});
