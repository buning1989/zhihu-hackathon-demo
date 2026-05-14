import dotenv from "dotenv";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const backendDir = resolve(scriptDir, "..");
const rootDir = resolve(backendDir, "..");

dotenv.config({ path: resolve(rootDir, ".env.local"), override: false });
dotenv.config({ path: resolve(backendDir, ".env.local"), override: false });

process.env.AGENT_LLM_ENABLED = "true";
process.env.AGENT_LLM_PROVIDER = "deepseek";
process.env.AGENT_LLM_MODEL = "mock-agent-model";
process.env.AGENT_LLM_TEST_MODE = "mock";
process.env.AGENT_LLM_TIMEOUT_MS = "1000";
process.env.AGENT_LLM_RETRIES = "1";

const gatewayPath = resolve(backendDir, "dist/llm/llmGateway.js");
if (!existsSync(gatewayPath)) {
  console.error("Built LLM Gateway not found. Run `npm run build -w backend` before smoke:llm-gateway.");
  process.exit(1);
}

let exitCode = 0;
try {
  const { llmGateway } = await import(gatewayPath);
  const originalQuery = "不工作了能去哪儿";

  const success = await llmGateway.runJson({
    stageName: "smoke_llm_gateway_success",
    schemaName: "agent.search_plan.v1",
    messages: [{ role: "user", content: "return a valid search plan JSON" }],
    timeoutMs: 1000,
    retries: 0,
    validate: isSearchPlanArtifactData,
    fallback: (context) => buildFallback(originalQuery, context.fallbackReason),
    metadata: {
      originalQuery,
      mockScenario: "success"
    }
  });
  assert(success.status === "success", "mock success did not return success");
  assert(success.data.llmUsed === true, "mock success should mark llmUsed=true");
  assert(
    success.data.expandedQueries.includes(originalQuery),
    "mock success expandedQueries should include original query"
  );

  const timeout = await llmGateway.runJson({
    stageName: "smoke_llm_gateway_timeout",
    schemaName: "agent.search_plan.v1",
    messages: [{ role: "user", content: "simulate timeout" }],
    timeoutMs: 10,
    retries: 0,
    validate: isSearchPlanArtifactData,
    fallback: (context) => buildFallback(originalQuery, context.fallbackReason),
    metadata: {
      originalQuery,
      mockScenario: "timeout"
    }
  });
  assert(timeout.status === "timeout", "mock timeout did not return timeout status");
  assert(timeout.fallbackUsed === true, "mock timeout did not use fallback");
  assert(timeout.data.strategy === "rule_fallback", "mock timeout did not return rule fallback");

  const schemaInvalid = await llmGateway.runJson({
    stageName: "smoke_llm_gateway_schema_invalid",
    schemaName: "agent.search_plan.v1",
    messages: [{ role: "user", content: "simulate invalid schema" }],
    timeoutMs: 1000,
    retries: 0,
    validate: isSearchPlanArtifactData,
    fallback: (context) => buildFallback(originalQuery, context.fallbackReason),
    metadata: {
      originalQuery,
      mockScenario: "schema_invalid"
    }
  });
  assert(schemaInvalid.status === "fallback", "schema invalid did not return fallback status");
  assert(schemaInvalid.fallbackUsed === true, "schema invalid did not use fallback");
  assert(
    schemaInvalid.errorType === "SCHEMA_VALIDATION_FAILED",
    "schema invalid did not expose SCHEMA_VALIDATION_FAILED"
  );

  const evidenceSuccess = await llmGateway.runJson({
    stageName: "smoke_llm_gateway_evidence_success",
    schemaName: "agent.evidence.v1",
    messages: [{ role: "user", content: "return valid evidence JSON" }],
    timeoutMs: 1000,
    retries: 0,
    validate: isEvidenceArtifactData,
    fallback: (context) => buildEvidenceFallback(context.fallbackReason),
    metadata: {
      originalQuery,
      mockScenario: "success",
      candidates: [
        {
          id: "candidate_smoke_1",
          title: "裸辞后去小城市生活",
          author: "知乎用户",
          sourceUrl: "https://www.zhihu.com/question/mock/answer/1",
          excerpt: "我离开原来的工作后，先在小城市住了三个月，重新整理生活节奏。"
        }
      ]
    }
  });
  assert(evidenceSuccess.status === "success", "mock evidence success did not return success");
  assert(
    Array.isArray(evidenceSuccess.data.evidenceItems) &&
      evidenceSuccess.data.evidenceItems.length > 0,
    "mock evidence success did not return evidenceItems"
  );
  assert(
    evidenceSuccess.data.strategy === "llm_extracted" && evidenceSuccess.data.llmUsed === true,
    "mock evidence success did not mark llm extraction"
  );

  const finalResultSuccess = await llmGateway.runJson({
    stageName: "smoke_llm_gateway_final_result_success",
    schemaName: "agent.final_result.v1",
    messages: [{ role: "user", content: "return valid final result JSON" }],
    timeoutMs: 1000,
    retries: 0,
    validate: isFinalResultArtifactData,
    fallback: (context) => buildFinalResultFallback(context.fallbackReason),
    metadata: {
      originalQuery,
      mockScenario: "success",
      candidates: [
        {
          id: "candidate_smoke_1",
          title: "裸辞后去小城市生活",
          author: "知乎用户",
          url: "https://www.zhihu.com/question/mock/answer/1",
          excerpt: "我离开原来的工作后，先在小城市住了三个月。"
        }
      ],
      evidenceItems: [
        {
          id: "evidence_candidate_smoke_1_1",
          candidateId: "candidate_smoke_1",
          evidenceText: "我离开原来的工作后，先在小城市住了三个月。"
        }
      ]
    }
  });
  assert(finalResultSuccess.status === "success", "mock final result success did not return success");
  assert(
    finalResultSuccess.data.schemaVersion === "agent.final_result.v1",
    "mock final result success did not return final result schema"
  );
  assert(
    finalResultSuccess.data.strategy === "llm_composed" && finalResultSuccess.data.llmUsed === true,
    "mock final result success did not mark llm composition"
  );

  const finalResultSchemaInvalid = await llmGateway.runJson({
    stageName: "smoke_llm_gateway_final_result_schema_invalid",
    schemaName: "agent.final_result.v1",
    messages: [{ role: "user", content: "simulate invalid final result schema" }],
    timeoutMs: 1000,
    retries: 0,
    validate: isFinalResultArtifactData,
    fallback: (context) => buildFinalResultFallback(context.fallbackReason),
    metadata: {
      originalQuery,
      mockScenario: "schema_invalid"
    }
  });
  assert(
    finalResultSchemaInvalid.status === "fallback",
    "final result schema invalid did not return fallback status"
  );
  assert(
    finalResultSchemaInvalid.errorType === "SCHEMA_VALIDATION_FAILED",
    "final result schema invalid did not expose SCHEMA_VALIDATION_FAILED"
  );

  console.log("llm gateway smoke ok");
  console.log(`successAttempts=${success.attempts}`);
  console.log(`timeoutStatus=${timeout.status}`);
  console.log(`schemaInvalidErrorType=${schemaInvalid.errorType}`);
  console.log(`evidenceItemCount=${evidenceSuccess.data.evidenceItems.length}`);
  console.log(`finalResultStrategy=${finalResultSuccess.data.strategy}`);
} catch (error) {
  console.error("llm gateway smoke failed");
  console.error(error);
  exitCode = 1;
}

if (exitCode) {
  process.exit(exitCode);
}

function buildFallback(originalQuery, fallbackReason) {
  return {
    originalQuery,
    expandedQueries: [originalQuery],
    searchAngles: [],
    negativeKeywords: [],
    targetPersonTypes: [],
    strategy: "rule_fallback",
    llmUsed: false,
    fallbackReason
  };
}

function buildEvidenceFallback(fallbackReason) {
  return {
    evidenceItems: [],
    strategy: "rule_fallback",
    llmUsed: false,
    fallbackReason
  };
}

function buildFinalResultFallback(fallbackReason) {
  return {
    schemaVersion: "agent.final_result.v1",
    summary: "已根据候选内容和证据整理出初步结果。",
    paths: [],
    people: [],
    suggestedQuestions: [],
    strategy: "rule_fallback",
    llmUsed: false,
    fallbackReason
  };
}

function isSearchPlanArtifactData(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }

  return (
    typeof value.originalQuery === "string" &&
    Array.isArray(value.expandedQueries) &&
    value.expandedQueries.every((item) => typeof item === "string") &&
    Array.isArray(value.searchAngles) &&
    value.searchAngles.every((item) => typeof item === "string") &&
    (value.negativeKeywords === undefined ||
      (Array.isArray(value.negativeKeywords) &&
        value.negativeKeywords.every((item) => typeof item === "string"))) &&
    Array.isArray(value.targetPersonTypes) &&
    value.targetPersonTypes.every((item) => typeof item === "string") &&
    ["llm_planned", "rule_fallback"].includes(value.strategy) &&
    typeof value.llmUsed === "boolean"
  );
}

function isEvidenceArtifactData(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }

  return (
    Array.isArray(value.evidenceItems) &&
    value.evidenceItems.every(isEvidenceItem) &&
    ["llm_extracted", "rule_fallback"].includes(value.strategy) &&
    typeof value.llmUsed === "boolean" &&
    (value.fallbackReason === undefined || typeof value.fallbackReason === "string")
  );
}

function isEvidenceItem(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }

  return (
    typeof value.candidateId === "string" &&
    typeof value.title === "string" &&
    typeof value.author === "string" &&
    typeof value.sourceUrl === "string" &&
    typeof value.evidenceText === "string" &&
    typeof value.reason === "string" &&
    typeof value.confidence === "number" &&
    Number.isFinite(value.confidence) &&
    value.confidence >= 0 &&
    value.confidence <= 1
  );
}

function isFinalResultArtifactData(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }

  return (
    value.schemaVersion === "agent.final_result.v1" &&
    typeof value.summary === "string" &&
    Array.isArray(value.paths) &&
    value.paths.every(isFinalResultPath) &&
    Array.isArray(value.people) &&
    value.people.every(isFinalResultPerson) &&
    Array.isArray(value.suggestedQuestions) &&
    value.suggestedQuestions.every((item) => typeof item === "string") &&
    ["llm_composed", "rule_fallback"].includes(value.strategy) &&
    typeof value.llmUsed === "boolean" &&
    (value.fallbackReason === undefined || typeof value.fallbackReason === "string")
  );
}

function isFinalResultPath(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }

  return (
    typeof value.title === "string" &&
    typeof value.summary === "string" &&
    Array.isArray(value.evidenceIds) &&
    value.evidenceIds.every((item) => typeof item === "string") &&
    Array.isArray(value.candidateIds) &&
    value.candidateIds.every((item) => typeof item === "string")
  );
}

function isFinalResultPerson(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }

  return (
    typeof value.name === "string" &&
    typeof value.reason === "string" &&
    typeof value.candidateId === "string" &&
    Array.isArray(value.evidenceIds) &&
    value.evidenceIds.every((item) => typeof item === "string")
  );
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}
