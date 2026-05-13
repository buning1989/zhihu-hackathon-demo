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
      "这段公开内容先强调把一天重新排稳：做饭、休息、散步和低成本活动先恢复，再判断下一站在哪里。",
    suggestedQuestions: [
      "这段公开内容里，日常节奏为什么重要？",
      "从这个公开样本看，低成本停靠要先确认什么？"
    ]
  },
  {
    personaId: "persona_side_income",
    sourceRefs: ["source_mock_side_income"],
    replyFocus:
      "这段公开内容更像一张现金流检查表：先算安全垫，再用低成本方式验证技能、接单或内容创作是否真的可持续。",
    suggestedQuestions: [
      "这段公开内容里，现金流应该怎么先算？",
      "从这个公开样本看，副业试错最容易忽略什么？"
    ]
  },
  {
    personaId: "persona_safety_net",
    sourceRefs: ["source_mock_safety_net"],
    replyFocus:
      "这段公开内容先处理底线问题：预算、失业保险、本地保障和过渡岗位都应先列出来，避免只靠情绪硬撑。",
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
    "目前只有 mock 公开样本可用，所以回复会停留在公开内容能支持的层面：先看证据片段，再把问题拆成生活节奏、现金流和风险兜底。",
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
      `针对你的问题「${request.message}」，mock 回复只能基于这些公开样本给出整理：先确认原文里明确出现的行动、约束和风险，再决定它是否适合你的处境。`,
      "这不是作者本人回应，也不补充公开内容之外的新事实。"
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
