import { DEMO_PERSONA_BOUNDARY_NOTICE } from "../types/demo.types.js";
import {
  PERSONA_CHAT_SCHEMA_VERSION,
  type PersonaChatRequest,
  type PersonaChatResponse
} from "../types/persona.types.js";

interface PersonaMockProfile {
  personaId: string;
  sourceRefs: string[];
  replyFocus: string;
  suggestedQuestions: string[];
}

const MOCK_PERSONAS: PersonaMockProfile[] = [
  {
    personaId: "persona_city_pause",
    sourceRefs: ["source_mock_city_walk"],
    replyFocus:
      "我能先说清楚的是，那段内容里真正落下来的不是马上换到哪里，而是先把一天重新排稳：做饭、休息、散步和低成本活动先恢复。",
    suggestedQuestions: [
      "这段公开内容里，日常节奏为什么重要？",
      "从这个公开样本看，低成本停靠要先确认什么？"
    ]
  },
  {
    personaId: "persona_side_income",
    sourceRefs: ["source_mock_side_income"],
    replyFocus:
      "我在这段内容里更在意现金流这件事：先算安全垫，再用低成本方式验证技能、接单或内容创作到底能不能撑住。",
    suggestedQuestions: [
      "这段公开内容里，现金流应该怎么先算？",
      "从这个公开样本看，副业试错最容易忽略什么？"
    ]
  },
  {
    personaId: "persona_safety_net",
    sourceRefs: ["source_mock_safety_net"],
    replyFocus:
      "我能基于这段内容说的，是先把底线问题列出来：预算、失业保险、本地保障和过渡岗位，比只靠情绪硬撑更具体。",
    suggestedQuestions: [
      "这段公开内容里，最坏情况应该怎么拆？",
      "从这个公开样本看，保障路径要先查什么？"
    ]
  }
];

const DEFAULT_PROFILE: PersonaMockProfile = {
  personaId: "persona_mock_default",
  sourceRefs: ["source_mock_city_walk"],
  replyFocus:
    "我能说的不多，只能基于这段 mock 公开样本聊：先看证据片段，再把问题拆成生活节奏、现金流和风险兜底。",
  suggestedQuestions: [
    "这段公开内容里，哪些信息是确定的？",
    "从这个公开样本看，哪些结论还需要更多证据？"
  ]
};

export function createMockPersonaChatResponse(request: PersonaChatRequest): PersonaChatResponse {
  const profile = MOCK_PERSONAS.find((item) => item.personaId === request.personaId) ?? {
    ...DEFAULT_PROFILE,
    personaId: request.personaId
  };

  return {
    schemaVersion: PERSONA_CHAT_SCHEMA_VERSION,
    personaId: request.personaId,
    reply: [
      profile.replyFocus,
      `你问「${request.message}」。我只能沿着样本里已经写下来的行动、约束和风险往前说，不替你下决定，也不补出原文没有的经历。`
    ].join("\n"),
    boundaryNotice: DEMO_PERSONA_BOUNDARY_NOTICE,
    sourceRefs: profile.sourceRefs,
    suggestedQuestions: profile.suggestedQuestions,
    meta: {
      mode: "mock",
      queryId: request.queryId,
      generatedAt: new Date().toISOString(),
      grounded: true,
      llmUsed: false,
      safetyNotes: [
        "mock reply only",
        "no LLM used",
        "does not represent the Zhihu author",
        "no private contact or simulated author response"
      ]
    }
  };
}
