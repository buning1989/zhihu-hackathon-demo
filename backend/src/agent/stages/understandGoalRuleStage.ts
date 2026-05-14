import type { PersistentAgentTask } from "../agentModels.js";
import {
  AGENT_ARTIFACT_INTENT,
  type AgentStageOutput,
  type IntentArtifactData
} from "./stageTypes.js";

export function runUnderstandGoalRuleStage(
  task: PersistentAgentTask
): AgentStageOutput<IntentArtifactData> {
  const originalQuery = task.query;
  const normalizedQuery = normalizeQuery(originalQuery);

  return {
    artifactType: AGENT_ARTIFACT_INTENT,
    data: {
      originalQuery,
      normalizedQuery,
      expandedQueries: uniqueNonEmpty([originalQuery, normalizedQuery]),
      strategy: "rule_based",
      llmUsed: false
    }
  };
}

function normalizeQuery(query: string): string {
  return query.replace(/\s+/g, " ").trim();
}

function uniqueNonEmpty(values: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];

  for (const value of values) {
    const normalized = value.trim();
    if (normalized && !seen.has(normalized)) {
      seen.add(normalized);
      result.push(normalized);
    }
  }

  return result;
}
