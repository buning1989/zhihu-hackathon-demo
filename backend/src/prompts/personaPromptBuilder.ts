import { PERSONA_CHAT_SYSTEM_PROMPT } from "./personaChatPrompt.js";

export type PersonaPromptMessageRole = "system" | "user";

export interface PersonaPromptMessage {
  role: PersonaPromptMessageRole;
  content: string;
}

export interface PersonaChatBuilderInput {
  userQuery: string;
  person: unknown;
  articles: unknown[];
  evidence: unknown[];
  aiPersona: unknown;
  history?: unknown[];
  userMessage: string;
}

export interface PersonaContext {
  userQuery: string;
  person: unknown;
  articles: unknown[];
  evidence: unknown[];
  aiPersona: unknown;
  history: unknown[];
}

export function buildPersonaChatMessages(input: PersonaChatBuilderInput): PersonaPromptMessage[] {
  const personaContext: PersonaContext = {
    userQuery: input.userQuery,
    person: input.person,
    articles: input.articles,
    evidence: input.evidence,
    aiPersona: input.aiPersona,
    history: input.history ?? []
  };

  return [
    {
      role: "system",
      content: PERSONA_CHAT_SYSTEM_PROMPT
    },
    {
      role: "user",
      content: [
        "以下是本次回答允许使用的公开资料。",
        "你必须严格基于 persona_context 回答；不要为每个作者生成或假设独立 system prompt。",
        "",
        "<persona_context>",
        JSON.stringify(personaContext, null, 2),
        "</persona_context>",
        "",
        "用户当前追问：",
        input.userMessage
      ].join("\n")
    }
  ];
}
