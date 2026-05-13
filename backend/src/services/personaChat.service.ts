import { createMockPersonaChatResponse } from "../mocks/personaChat.mock.js";
import type { PersonaChatRequest, PersonaChatResponse } from "../types/persona.types.js";
import { HttpError } from "../utils/httpError.js";

export class PersonaChatService {
  chat(request: PersonaChatRequest): PersonaChatResponse {
    return createMockPersonaChatResponse(request);
  }
}

export const personaChatService = new PersonaChatService();

export function parsePersonaChatRequest(body: unknown): PersonaChatRequest {
  const record = isRecord(body) ? body : {};
  const personaId = readString(record.personaId).trim();
  const queryId = readString(record.queryId).trim();
  const message = readString(record.message).trim();

  if (!personaId) {
    throw new HttpError(400, "PERSONA_ID_REQUIRED", "Missing required body field: personaId");
  }

  if (!message) {
    throw new HttpError(400, "MESSAGE_REQUIRED", "Missing required body field: message");
  }

  return {
    personaId,
    queryId: queryId || "query_mock",
    message
  };
}

function readString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
