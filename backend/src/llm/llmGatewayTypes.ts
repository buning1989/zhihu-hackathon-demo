import type { LlmMessage, LlmModelProvider } from "./clients/openaiCompatible.js";

export type LlmGatewayStatus = "success" | "fallback" | "timeout" | "error";

export type LlmGatewayErrorType =
  | "PROVIDER_UNAVAILABLE"
  | "TIMEOUT"
  | "REQUEST_FAILED"
  | "JSON_PARSE_FAILED"
  | "SCHEMA_VALIDATION_FAILED"
  | "UNKNOWN_ERROR";

export type LlmGatewayMockScenario =
  | "success"
  | "timeout"
  | "schema_invalid"
  | "malformed_json"
  | "error";

export interface LlmGatewayEventPayload {
  stageName: string;
  provider: LlmModelProvider;
  model: string;
  timeoutMs: number;
  durationMs?: number;
  status?: LlmGatewayStatus;
  attempts?: number;
  fallbackReason?: string;
  errorType?: LlmGatewayErrorType;
}

export interface LlmGatewayFallbackContext {
  status: LlmGatewayStatus;
  fallbackReason: string;
  errorType: LlmGatewayErrorType;
  attempts: number;
  durationMs: number;
}

export interface LlmGatewayInput<TData> {
  stageName: string;
  provider?: LlmModelProvider;
  model?: string;
  prompt?: string;
  messages?: LlmMessage[];
  timeoutMs?: number;
  retries?: number;
  schemaName: string;
  validate: (data: unknown) => boolean;
  fallback: (context: LlmGatewayFallbackContext) => TData;
  metadata?: Record<string, unknown>;
  temperature?: number;
  maxTokens?: number;
  responseFormat?: { type: "json_object" };
  onEvent?: (type: string, payload: LlmGatewayEventPayload) => Promise<void> | void;
}

export interface LlmGatewayOutput<TData> {
  status: LlmGatewayStatus;
  data: TData;
  rawText: string;
  model: string;
  provider: LlmModelProvider;
  attempts: number;
  durationMs: number;
  fallbackUsed: boolean;
  fallbackReason: string;
  errorType?: LlmGatewayErrorType;
}
