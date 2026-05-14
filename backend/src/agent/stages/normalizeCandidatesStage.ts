import { createHash } from "node:crypto";
import {
  AGENT_ARTIFACT_CANDIDATES,
  type AgentStageOutput,
  type CandidateItem,
  type CandidatesArtifactData,
  type RawSourceItem,
  type RawSourcesArtifactData
} from "./stageTypes.js";

export function runNormalizeCandidatesStage(
  rawSources: RawSourcesArtifactData
): AgentStageOutput<CandidatesArtifactData> {
  const candidates = dedupeSources(rawSources.sources).map(mapRawSourceToCandidate);

  return {
    artifactType: AGENT_ARTIFACT_CANDIDATES,
    data: {
      candidates,
      candidateCount: candidates.length,
      strategy: "rule_based"
    }
  };
}

function dedupeSources(sources: RawSourceItem[]): RawSourceItem[] {
  const seen = new Set<string>();
  const result: RawSourceItem[] = [];

  for (const source of sources) {
    const key = buildDedupeKey(source);
    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    result.push(source);
  }

  return result;
}

function mapRawSourceToCandidate(source: RawSourceItem, index: number): CandidateItem {
  return {
    id: `candidate_${hashStableId(source.sourceId || source.url || `${source.title}:${index}`)}`,
    sourceId: source.sourceId,
    title: source.title || "未命名内容",
    author: source.author || "未知作者",
    excerpt: truncateText(source.excerpt, 500),
    url: source.url,
    score: normalizeScore(source.score, index),
    provider: source.provider
  };
}

function buildDedupeKey(source: RawSourceItem): string {
  if (source.url) {
    return `url:${source.url.trim().toLowerCase()}`;
  }

  if (source.sourceId) {
    return `source:${source.sourceId.trim().toLowerCase()}`;
  }

  return `title:${source.title.trim().toLowerCase()}:author:${source.author.trim().toLowerCase()}`;
}

function normalizeScore(score: number, index: number): number {
  if (Number.isFinite(score) && score > 0) {
    return clampScore(score > 1 ? score / 100 : score);
  }

  return clampScore(0.76 - index * 0.03);
}

function hashStableId(value: string): string {
  return createHash("sha1").update(value).digest("hex").slice(0, 16);
}

function truncateText(value: string, maxLength: number): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }

  return `${normalized.slice(0, Math.max(maxLength - 1, 0))}…`;
}

function clampScore(value: number): number {
  return Math.min(Math.max(Number(value.toFixed(2)), 0), 1);
}
