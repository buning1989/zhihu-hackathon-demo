export const DEMO_SCHEMA_VERSION = "demo.v1" as const;
export const DEMO_PERSONA_BOUNDARY_NOTICE = "该 AI 分身基于公开内容生成，不代表作者本人。";

export type DemoSchemaVersion = typeof DEMO_SCHEMA_VERSION;
export type DemoDataMode = "mock" | "cache_first" | "real";
export type DemoPersonaChatMode = "off" | "mock" | "real";

export interface DemoSearchRequestBody {
  query?: unknown;
  count?: unknown;
  mode?: unknown;
  dataMode?: unknown;
}

export interface DemoSearchResponse {
  schemaVersion: DemoSchemaVersion;
  queryId: string;
  query: string;
  dataMode: DemoDataMode;
  features: DemoFeatures;
  analysis: DemoAnalysis;
  paths: DemoPath[];
  people: DemoPerson[];
  personas: DemoPersona[];
  sections: DemoSection[];
  meta: DemoMeta;
  debug: DemoDebug;
}

export interface DemoFeatures {
  aiPersona: boolean;
  personaChat: DemoPersonaChatMode;
  saveSample: boolean;
  articleBody: boolean;
  sourceEvidenceRequired: true;
}

export interface DemoAnalysis {
  summary: string;
  intent: string;
  focusTags: string[];
  steps: DemoAnalysisStep[];
}

export interface DemoAnalysisStep {
  id: string;
  label: string;
  status: "done" | "pending";
  evidenceIds: string[];
  sourceRefs: string[];
}

export interface DemoPath {
  id: string;
  title: string;
  summary: string;
  stance: "experience" | "viewpoint" | "mixed";
  personRefs?: string[];
  evidenceIds: string[];
  sourceRefs: string[];
}

export interface DemoPerson {
  id: string;
  name: string;
  sampleType?: "experience_sample" | "viewpoint_author" | "content_sample";
  pathId: string;
  role: string;
  badge: string;
  avatar: string;
  oneLine: string;
  who: string;
  overlaps: string[];
  timeline: DemoTimelineEvent[];
  lesson: string;
  articles: DemoArticle[];
  match: DemoMatch;
  aiPersona: DemoPersonPersona;
  evidenceIds: string[];
  sourceRefs: string[];
}

export interface DemoTimelineEvent {
  date: string;
  event: string;
  evidenceIds: string[];
  sourceRefs: string[];
}

export interface DemoArticle {
  id: string;
  title: string;
  text: string;
  url: string;
  author: string;
  avatar: string;
  sourceName: string;
  sourceUrl: string;
  summary: string;
  evidence: DemoEvidence[];
  body: DemoBlock[];
  sourceRefs: string[];
}

export interface DemoEvidence {
  id: string;
  label: string;
  text: string;
  sourceRefId: string;
  sourceUrl: string;
}

export interface DemoBlock {
  type: "paragraph" | "evidence";
  text: string;
  evidenceIds: string[];
  sourceRefs: string[];
}

export interface DemoMatch {
  score: number;
  level: "low" | "medium" | "high";
  reasons: string[];
  matchedVariables: string[];
  riskNotes: string[];
  contentRelevance: number;
  experienceSimilarity: number;
  evidenceQuality: number;
  personaReadiness: number;
  evidenceIds: string[];
  sourceRefs: string[];
}

export interface DemoPersonPersona {
  enabled: boolean;
  personaId: string;
  displayName: string;
  label: string;
  openingLine: string;
  suggestedQuestions: string[];
  boundary: string;
  grounding: {
    personId: string;
    articleIds: string[];
    evidenceRequired: true;
    sourceRefs: string[];
  };
}

export interface DemoPersona {
  id: string;
  personId: string;
  displayName: string;
  avatar: string;
  personaType: "experience_echo";
  intro: string;
  boundaryNotice: string;
  sourceRefs: string[];
  suggestedQuestions: string[];
}

export interface DemoSection {
  id: string;
  type: "analysis" | "paths" | "people" | "personas";
  title: string;
  itemRefs: string[];
}

export interface DemoSourceRef {
  id: string;
  provider: "zhihu" | "mock";
  type: "zhihu_answer" | "mock_answer";
  title: string;
  url: string;
  author: string;
  evidenceIds: string[];
}

export interface DemoMeta {
  sourceRefs: DemoSourceRef[];
  evidenceCount: number;
  generatedAt: string;
  latencyMs: number;
  fallbackUsed: boolean;
}

export interface DemoDebug {
  composer: "mock" | "real_rule_composer" | "real_llm_composer";
  requestedDataMode: DemoDataMode;
  resolvedDataMode: DemoDataMode;
  itemCount: number;
  sourceItemCount?: number;
  pathCount?: number;
  peopleCount?: number;
  personaCount?: number;
  llmUsed?: boolean;
  fallbackUsed: boolean;
  llmComposerUsed: boolean;
  llmRepairUsed?: boolean;
  llmRepairFailed?: boolean;
  fallbackReason: string;
  guardWarnings: string[];
  notes: string[];
}
