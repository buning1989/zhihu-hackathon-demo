import { Router } from "express";
import { parsePersonaChatRequest, personaChatService } from "../services/personaChat.service.js";
import type { ApiSuccessResponse } from "../types/api.types.js";
import type { PersonaChatResponse } from "../types/persona.types.js";

export const personasRoutes = Router();

personasRoutes.post("/chat", async (req, res, next) => {
  try {
    const request = parsePersonaChatRequest(req.body);
    const data = await personaChatService.chat(request);

    res.json({
      success: true,
      data
    } satisfies ApiSuccessResponse<PersonaChatResponse>);
  } catch (error) {
    next(error);
  }
});
