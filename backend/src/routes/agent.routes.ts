import { Router } from "express";
import { getCurrentUserContext } from "../auth/session.js";
import { agentTaskService } from "../agent/taskService.js";
import type { ApiSuccessResponse } from "../types/api.types.js";

export const agentRoutes = Router();

agentRoutes.post("/tasks", (req, res, next) => {
  try {
    const userContext = getCurrentUserContext(req);
    const data = agentTaskService.createTask(req.body, userContext);

    res.json({
      success: true,
      data
    } satisfies ApiSuccessResponse<typeof data>);
  } catch (error) {
    next(error);
  }
});

agentRoutes.get("/tasks/:taskId", (req, res, next) => {
  try {
    const data = agentTaskService.getTaskStatus(req.params.taskId);

    res.json({
      success: true,
      data
    } satisfies ApiSuccessResponse<typeof data>);
  } catch (error) {
    next(error);
  }
});

agentRoutes.get("/tasks/:taskId/view", (req, res, next) => {
  try {
    const data = agentTaskService.getTaskView(req.params.taskId);

    res.json({
      success: true,
      data
    } satisfies ApiSuccessResponse<typeof data>);
  } catch (error) {
    next(error);
  }
});

agentRoutes.get("/tasks/:taskId/result", (req, res, next) => {
  try {
    const data = agentTaskService.getTaskResult(req.params.taskId);

    res.json({
      success: true,
      data
    } satisfies ApiSuccessResponse<typeof data>);
  } catch (error) {
    next(error);
  }
});
