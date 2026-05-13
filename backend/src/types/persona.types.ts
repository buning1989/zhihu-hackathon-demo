import type { DEMO_PERSONA_BOUNDARY_NOTICE } from "./demo.types.js";

export const PERSONA_CHAT_SCHEMA_VERSION = "personaChat.v1" as const;

export type PersonaChatSchemaVersion = typeof PERSONA_CHAT_SCHEMA_VERSION;
export type PersonaBoundaryNotice = typeof DEMO_PERSONA_BOUNDARY_NOTICE;

export interface PersonaChatRequestBody {
  personaId?: unknown;
  queryId?: unknown;
  message?: unknown;
}

export interface PersonaChatRequest {
  personaId: string;
  queryId: string;
  message: string;
}

export interface PersonaChatResponse {
  schemaVersion: PersonaChatSchemaVersion;
  personaId: string;
  reply: string;
  boundaryNotice: PersonaBoundaryNotice;
  sourceRefs: string[];
  suggestedQuestions: string[];
  meta: PersonaChatMeta;
}

export interface PersonaChatMeta {
  mode: "mock";
  queryId: string;
  generatedAt: string;
  grounded: true;
  llmUsed: false;
  safetyNotes: string[];
}
