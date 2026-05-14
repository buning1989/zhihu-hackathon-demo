import type {
  DEMO_PERSONA_BOUNDARY_NOTICE,
  PERSONA_CHAT_FALLBACK_BOUNDARY_NOTICE
} from "./demo.types.js";

export const PERSONA_CHAT_SCHEMA_VERSION = "personaChat.v1" as const;

export type PersonaChatSchemaVersion = typeof PERSONA_CHAT_SCHEMA_VERSION;
export type PersonaBoundaryNotice =
  | typeof DEMO_PERSONA_BOUNDARY_NOTICE
  | typeof PERSONA_CHAT_FALLBACK_BOUNDARY_NOTICE;

export interface PersonaChatRequestBody {
  personaId?: unknown;
  queryId?: unknown;
  message?: unknown;
  history?: unknown;
}

export interface PersonaChatRequest {
  personaId: string;
  queryId: string;
  message: string;
  history: PersonaChatHistoryMessage[];
}

export interface PersonaChatHistoryMessage {
  role: "user" | "assistant";
  content: string;
}

export interface PersonaChatResponse {
  schemaVersion: PersonaChatSchemaVersion;
  personaId: string;
  reply: string;
  boundaryNotice: PersonaBoundaryNotice;
  sourceRefs: string[];
  suggestedQuestions: string[];
  meta: PersonaChatMeta;
  debug?: PersonaChatDebug;
}

export interface PersonaChatMeta {
  mode: "mock" | "real";
  queryId: string;
  generatedAt: string;
  grounded: true;
  llmUsed: boolean;
  totalDurationMs?: number;
  fallbackReason?: string;
  fallbackStages?: string[];
  llmStages?: Array<{
    taskType: "persona_chat";
    status: "success" | "fallback" | "timeout" | "skipped";
    durationMs: number;
    fallbackReason: string;
  }>;
  timedOutStages?: string[];
  safetyNotes: string[];
}

export interface PersonaChatDebug {
  chatMode: "real_llm_chat" | "mock_fallback";
  fallbackReason: string;
  evidenceCount: number;
}
