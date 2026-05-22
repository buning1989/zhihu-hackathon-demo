import dotenv from "dotenv";
import pg from "pg";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const backendDir = resolve(scriptDir, "..");
const rootDir = resolve(backendDir, "..");

dotenv.config({ path: resolve(rootDir, ".env.local"), override: false });
dotenv.config({ path: resolve(backendDir, ".env.local"), override: false });

const { Client } = pg;
const apiBaseUrl = normalizeApiBaseUrl(
  process.env.AGENT_API_BASE_URL || process.env.BACKEND_URL || "http://127.0.0.1:8000"
);
const databaseUrl =
  process.env.DATABASE_URL || "postgres://zhihu:zhihu@localhost:5432/zhihu_hackathon";
const timeoutMs = readPositiveInteger(process.env.SPOTCHECK_AGENT_REAL_TIMEOUT_MS, 120000);
const pollDelayMs = readPositiveInteger(process.env.SPOTCHECK_AGENT_REAL_POLL_MS, 500);
const queries = [
  "我要不要裸辞？",
  "异地恋到底值不值得坚持？",
  "考研失败后该怎么办？",
  "要不要从大城市回老家？",
  "不结婚以后会不会后悔？",
  "工作很痛苦但工资不错，要不要离职？",
  "要不要从大厂去创业公司？",
  "要不要离开北上广回老家？"
];

const taskRows = [];
let exitCode = 0;
const db = new Client({ connectionString: databaseUrl });

try {
  await db.connect();
  for (const [index, query] of queries.entries()) {
    const started = await createTask(query, index);
    const status = await waitForTerminalStatus(started.taskId, query);
    if (status.status !== "succeeded") {
      throw new Error(`${query}: task did not succeed: ${JSON.stringify(status.error ?? status)}`);
    }

    const metrics = await readTaskMetrics(started.taskId);
    taskRows.push({ query, taskId: started.taskId, ...metrics });
    console.log(formatRow(taskRows.at(-1)));
  }

  console.log("agent real production spotcheck ok");
} catch (error) {
  console.error("agent real production spotcheck failed");
  console.error(error);
  exitCode = 1;
} finally {
  await db.end().catch(() => undefined);
}

if (exitCode) {
  process.exit(exitCode);
}

async function createTask(query, index) {
  const response = await fetch(`${apiBaseUrl}/api/agent/tasks`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      query,
      metadata: {
        source: "phase2_1_real_quality_spotcheck",
        createdBy: "backend/scripts/spotcheck-agent-production-real.mjs",
        anonymousId: `agent_real_spotcheck_${index + 1}`
      }
    })
  });
  const body = await readJsonResponse(response);
  if (!response.ok || !body?.success) {
    throw new Error(`POST /api/agent/tasks failed for ${query}: ${response.status} ${JSON.stringify(body)}`);
  }

  return body.data;
}

async function waitForTerminalStatus(taskId, query) {
  const startedAt = Date.now();
  let lastStatus;

  while (Date.now() - startedAt < timeoutMs) {
    const response = await fetch(`${apiBaseUrl}/api/agent/tasks/${encodeURIComponent(taskId)}`);
    const body = await readJsonResponse(response);
    if (!response.ok || !body?.success) {
      throw new Error(`GET /api/agent/tasks/${taskId} failed: ${response.status} ${JSON.stringify(body)}`);
    }

    lastStatus = body.data;
    if (lastStatus.status === "succeeded" || lastStatus.status === "failed") {
      return lastStatus;
    }

    await delay(Math.min(lastStatus.pollAfterMs || pollDelayMs, pollDelayMs));
  }

  throw new Error(`${query}: timed out waiting for task; last=${lastStatus?.status ?? "missing"}`);
}

async function readTaskMetrics(taskId) {
  const { rows } = await db.query(
    `
      select type, data
      from agent_artifacts
      where task_id = $1
        and type in ('raw_sources', 'candidates', 'evidence', 'production_final_result')
      order by created_at asc
    `,
    [taskId]
  );
  const artifactByType = new Map(rows.map((row) => [row.type, row.data]));
  const rawSources = artifactByType.get("raw_sources") ?? {};
  const candidates = artifactByType.get("candidates") ?? {};
  const evidence = artifactByType.get("evidence") ?? {};
  const finalResult = artifactByType.get("production_final_result") ?? {};
  const candidateItems = Array.isArray(candidates.candidates) ? candidates.candidates : [];
  const evidenceItems = Array.isArray(evidence.evidenceItems) ? evidence.evidenceItems : [];
  const qualityReport =
    finalResult.groundingReport?.deterministicValidator?.qualityReport ?? {};

  return {
    provider: rawSources.provider ?? "missing",
    fallbackUsed: Boolean(rawSources.fallbackUsed),
    sources: Number(rawSources.sourceCount ?? 0),
    selectedForEvidence: candidateItems.filter((item) => item.selectedForEvidence).length,
    avgRelevanceScore: average(candidateItems.map((item) => item.relevanceScore)),
    avgExperienceScore: average(candidateItems.map((item) => item.experienceScore)),
    avgQualityScore: average(candidateItems.map((item) => item.qualityScore)),
    evidence: evidenceItems.length,
    experienceEvidence: evidenceItems.filter((item) => item.isExperienceEvidence).length,
    paths: Array.isArray(finalResult.paths) ? finalResult.paths.length : 0,
    personas: Array.isArray(finalResult.personas) ? finalResult.personas.length : 0,
    degraded: Boolean(finalResult.degraded),
    deterministicValidator:
      finalResult.groundingReport?.deterministicValidator?.status ?? "missing",
    lowQualityCandidateIds: qualityReport.lowQualityCandidateIds ?? [],
    lowConfidenceEvidenceIds: qualityReport.lowConfidenceEvidenceIds ?? [],
    personaWithoutExperienceEvidenceIds: qualityReport.personaWithoutExperienceEvidenceIds ?? []
  };
}

function formatRow(row) {
  return JSON.stringify({
    query: row.query,
    taskId: row.taskId,
    provider: row.provider,
    fallbackUsed: row.fallbackUsed,
    sources: row.sources,
    selectedForEvidence: row.selectedForEvidence,
    avgRelevanceScore: row.avgRelevanceScore,
    avgExperienceScore: row.avgExperienceScore,
    avgQualityScore: row.avgQualityScore,
    evidence: row.evidence,
    experienceEvidence: row.experienceEvidence,
    paths: row.paths,
    personas: row.personas,
    degraded: row.degraded,
    deterministicValidator: row.deterministicValidator,
    lowQualityCandidateIds: row.lowQualityCandidateIds,
    lowConfidenceEvidenceIds: row.lowConfidenceEvidenceIds,
    personaWithoutExperienceEvidenceIds: row.personaWithoutExperienceEvidenceIds
  });
}

function average(values) {
  const numbers = values.filter((value) => Number.isFinite(value));
  if (numbers.length === 0) {
    return 0;
  }

  return Number((numbers.reduce((sum, value) => sum + value, 0) / numbers.length).toFixed(2));
}

function delay(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function readPositiveInteger(value, fallback) {
  if (!value) {
    return fallback;
  }

  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function normalizeApiBaseUrl(value) {
  return String(value || "").trim().replace(/\/+$/, "");
}

async function readJsonResponse(response) {
  const text = await response.text();
  return text ? JSON.parse(text) : undefined;
}
