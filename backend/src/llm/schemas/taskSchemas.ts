import type {
  DemoContentRole,
  DemoObjectiveQueryPlan,
  DemoObjectiveSlotName,
  DemoObjectiveSlots,
  DemoPath,
  DemoSearchQueryPlan
} from "../../types/demo.types.js";
import { buildObjectiveSearchContext, normalizeSearchQueryPlans } from "../searchQueryPlan.js";

export type LlmTaskSchemaName =
  | "intent_expand"
  | "candidate_rerank"
  | "evidence_extract"
  | "demo_response_compose"
  | "experience_summary"
  | "grounding_guard"
  | "persona_chat";

export type PersonaChatAnswerType =
  | "grounded_summary"
  | "insufficient_evidence"
  | "clarification"
  | "safety_boundary";

export interface IntentExpandOutput {
  intent: string;
  userCoreQuestion: string;
  focusTags: string[];
  topicSignals: string[];
  searchQueries: DemoSearchQueryPlan[];
  objectiveSlots: DemoObjectiveSlots;
  missingSlots: DemoObjectiveSlotName[];
  queryPlan: DemoObjectiveQueryPlan;
  intentTags: string[];
  userNeedSummary: string;
}

export interface CandidateRerankSelectedItem {
  candidateId: string;
  keep: true;
  relevanceScore: number;
  contentRole: DemoContentRole;
  relationToUserIntent: string;
  summaryAngle: string;
  diversityKey: string;
  keepReason: string;
}

export interface CandidateRerankDroppedItem {
  candidateId: string;
  keep: false;
  dropReason: string;
}

export interface CandidateRerankOutput {
  selected: CandidateRerankSelectedItem[];
  dropped: CandidateRerankDroppedItem[];
}

export interface EvidenceRefSeed {
  sourceRefId: string;
  label: string;
  evidenceText: string;
  relevanceScore: number;
  reason: string;
}

export interface PeopleSeed {
  personSeedId: string;
  name: string;
  sampleType: "experience_sample" | "viewpoint_author" | "content_sample";
  sourceRefs: string[];
  oneLine: string;
  overlaps: string[];
  lesson: string;
}

export interface PathSignal {
  title: string;
  summary: string;
  stance: DemoPath["stance"];
  sourceRefs: string[];
}

export interface PersonaSeed {
  personSeedId: string;
  enabled: boolean;
  openingLine: string;
  suggestedQuestions: string[];
  sourceRefs: string[];
}

export interface EvidenceExtractOutput {
  evidenceRefs: EvidenceRefSeed[];
  peopleSeeds: PeopleSeed[];
  pathSignals: PathSignal[];
  personaSeeds: PersonaSeed[];
}

export interface DemoComposePathOutput {
  id: string;
  title: string;
  summary: string;
  whyRelevant?: string;
  tradeoff?: string;
  fitReason?: string;
  diversityKey?: string;
  stance: DemoPath["stance"];
}

export interface DemoComposePersonOutput {
  id: string;
  role?: string;
  badge?: string;
  oneLine?: string;
  fitReason?: string;
  who?: string;
  overlaps?: string[];
  matchReasons?: string[];
  matchedVariables?: string[];
}

export interface DemoResponseComposeOutput {
  paths: DemoComposePathOutput[];
  people: DemoComposePersonOutput[];
}

export interface ExperienceSummaryItemOutput {
  personId: string;
  experienceSummary: string | null;
  confidence: number;
  reason: string;
}

export interface ExperienceSummaryOutput {
  summaries: ExperienceSummaryItemOutput[];
}

export interface GroundingGuardOutput {
  valid: boolean;
  warnings: string[];
  disablePersonaPersonIds: string[];
  disablePersonaIds: string[];
}

export interface PersonaChatLlmEvidence {
  articleId: string;
  text: string;
}

export interface PersonaChatTaskOutput {
  answer: string;
  answerType: PersonaChatAnswerType;
  citedArticleIds: string[];
  evidence: PersonaChatLlmEvidence[];
  followupQuestions: string[];
  boundary: string;
}

export class LlmSchemaError extends Error {
  constructor(
    public readonly code: string,
    message: string
  ) {
    super(message);
    this.name = "LlmSchemaError";
  }
}

export function parseIntentExpandOutput(content: string, fallbackQuery: string): IntentExpandOutput {
  const record = parseJsonObject(content);
  const objectiveContext = buildObjectiveSearchContext(fallbackQuery, record.objectiveSlots);
  const searchQueries = normalizeSearchQueryPlans(
    fallbackQuery,
    record.searchQueries,
    objectiveContext.objectiveSlots
  );
  const focusTags = unique([
    ...readStringArray(record.focusTags),
    ...readStringArray(record.intentTags)
  ])
    .map((item) => truncateText(item, 12))
    .slice(0, 8);
  const userCoreQuestion =
    truncateText(readString(record.userCoreQuestion) || readString(record.userNeedSummary), 120) ||
    `用户在探索「${truncateText(fallbackQuery, 30)}」相关的公开经验。`;
  const userNeedSummary =
    truncateText(readString(record.userNeedSummary) || userCoreQuestion, 120) ||
    userCoreQuestion;

  return {
    intent: truncateText(readString(record.intent) || "life_path_exploration", 48),
    userCoreQuestion,
    focusTags,
    topicSignals: buildTopicSignals({
      originalQuery: fallbackQuery,
      userCoreQuestion,
      focusTags,
      searchQueries,
      rawTopicSignals: readStringArray(record.topicSignals)
    }),
    searchQueries,
    objectiveSlots: objectiveContext.objectiveSlots,
    missingSlots: objectiveContext.missingSlots,
    queryPlan: objectiveContext.queryPlan,
    intentTags: focusTags,
    userNeedSummary
  };
}

export function parseCandidateRerankOutput(
  content: string,
  allowedCandidateIds: Set<string>
): CandidateRerankOutput {
  const record = parseJsonObject(content);
  const selected: CandidateRerankSelectedItem[] = [];
  const dropped: CandidateRerankDroppedItem[] = [];
  const seenSelected = new Set<string>();
  const seenDropped = new Set<string>();

  for (const item of readRecordArray(record.selected)) {
    const parsed = readCandidateRerankSelected(item, allowedCandidateIds);
    if (!parsed || seenSelected.has(parsed.candidateId)) {
      continue;
    }

    seenSelected.add(parsed.candidateId);
    selected.push(parsed);
  }

  for (const item of readRecordArray(record.dropped)) {
    const parsed = readCandidateRerankDropped(item, allowedCandidateIds);
    if (!parsed || seenDropped.has(parsed.candidateId) || seenSelected.has(parsed.candidateId)) {
      continue;
    }

    seenDropped.add(parsed.candidateId);
    dropped.push(parsed);
  }

  return {
    selected: selected.slice(0, 2),
    dropped: dropped.slice(0, allowedCandidateIds.size)
  };
}

export function parseEvidenceExtractOutput(
  content: string,
  allowedSourceRefs: Set<string>
): EvidenceExtractOutput {
  const record = parseJsonObject(content);

  return {
    evidenceRefs: readRecordArray(record.evidenceRefs)
      .map((item, index) => readEvidenceRefSeed(item, index, allowedSourceRefs))
      .filter((item): item is EvidenceRefSeed => Boolean(item))
      .slice(0, 12),
    peopleSeeds: readRecordArray(record.peopleSeeds)
      .map((item, index) => readPeopleSeed(item, index, allowedSourceRefs))
      .filter((item): item is PeopleSeed => Boolean(item))
      .slice(0, 12),
    pathSignals: readRecordArray(record.pathSignals)
      .map((item, index) => readPathSignal(item, index, allowedSourceRefs))
      .filter((item): item is PathSignal => Boolean(item))
      .slice(0, 8),
    personaSeeds: readRecordArray(record.personaSeeds)
      .map((item, index) => readPersonaSeed(item, index, allowedSourceRefs))
      .filter((item): item is PersonaSeed => Boolean(item))
      .slice(0, 12)
  };
}

export function parseDemoResponseComposeOutput(
  content: string,
  allowedIds: {
    pathIds: Set<string>;
    personIds: Set<string>;
  }
): DemoResponseComposeOutput {
  const record = parseJsonObject(content);

  return {
    paths: readRecordArray(record.paths)
      .map((item, index) => readDemoComposePath(item, index, allowedIds.pathIds))
      .filter((item): item is DemoComposePathOutput => Boolean(item))
      .slice(0, allowedIds.pathIds.size),
    people: readRecordArray(record.people)
      .map((item, index) => readDemoComposePerson(item, index, allowedIds.personIds))
      .filter((item): item is DemoComposePersonOutput => Boolean(item))
      .slice(0, allowedIds.personIds.size)
  };
}

export function parseExperienceSummaryOutput(
  content: string,
  allowedPersonIds: Set<string>
): ExperienceSummaryOutput {
  const record = parseJsonObject(content);

  return {
    summaries: readRecordArray(record.summaries)
      .map((item, index) => readExperienceSummaryItem(item, index, allowedPersonIds))
      .filter((item): item is ExperienceSummaryItemOutput => Boolean(item))
      .slice(0, allowedPersonIds.size)
  };
}

export function parseGroundingGuardOutput(
  content: string,
  allowedIds: {
    personIds: Set<string>;
    personaIds: Set<string>;
  }
): GroundingGuardOutput {
  const record = parseJsonObject(content);

  return {
    valid: typeof record.valid === "boolean" ? record.valid : false,
    warnings: readStringArray(record.warnings).map((item) => truncateText(item, 120)).slice(0, 10),
    disablePersonaPersonIds: readStringArray(record.disablePersonaPersonIds).filter((id) =>
      allowedIds.personIds.has(id)
    ),
    disablePersonaIds: readStringArray(record.disablePersonaIds).filter((id) =>
      allowedIds.personaIds.has(id)
    )
  };
}

export function parsePersonaChatTaskOutput(
  content: string,
  options: {
    allowedArticleIds: Set<string>;
    isAllowedEvidenceText: (articleId: string, text: string) => boolean;
  }
): PersonaChatTaskOutput {
  const record = parseJsonObject(content);
  const answerType = readAnswerType(record.answerType);
  const evidence = readRecordArray(record.evidence).map((item, index) =>
    readPersonaChatEvidence(item, index, options)
  );
  const citedArticleIds = unique([
    ...readStringArray(record.citedArticleIds),
    ...evidence.map((item) => item.articleId)
  ]);

  assertAllowedArticleIds(citedArticleIds, options.allowedArticleIds);
  if (answerType === "grounded_summary" && evidence.length === 0) {
    throw new LlmSchemaError(
      "LLM_SCHEMA_INVALID",
      "grounded_summary must include at least one grounded evidence item"
    );
  }

  return {
    answer: readRequiredString(record.answer, "answer"),
    answerType,
    citedArticleIds,
    evidence,
    followupQuestions: readStringArray(record.followupQuestions).slice(0, 3),
    boundary: readString(record.boundary)
  };
}

function readEvidenceRefSeed(
  record: Record<string, unknown>,
  index: number,
  allowedSourceRefs: Set<string>
): EvidenceRefSeed | undefined {
  const sourceRefId = readString(record.sourceRefId);
  if (!allowedSourceRefs.has(sourceRefId)) {
    return undefined;
  }

  return {
    sourceRefId,
    label: truncateText(readString(record.label) || "公开内容证据", 16),
    evidenceText: truncateText(readRequiredString(record.evidenceText, `evidenceRefs[${index}].evidenceText`), 180),
    relevanceScore: clampScore(readNumber(record.relevanceScore, 0.5)),
    reason: truncateText(readString(record.reason), 120)
  };
}

function readPeopleSeed(
  record: Record<string, unknown>,
  index: number,
  allowedSourceRefs: Set<string>
): PeopleSeed | undefined {
  const sourceRefs = filterAllowedRefs(readStringArray(record.sourceRefs), allowedSourceRefs);
  if (sourceRefs.length === 0) {
    return undefined;
  }

  return {
    personSeedId: truncateText(readString(record.personSeedId) || `seed_${index}`, 64),
    name: truncateText(readString(record.name) || "知乎用户", 24),
    sampleType: readSampleType(record.sampleType),
    sourceRefs,
    oneLine: truncateText(readString(record.oneLine), 80),
    overlaps: readStringArray(record.overlaps).map((item) => truncateText(item, 40)).slice(0, 4),
    lesson: truncateText(readString(record.lesson), 80)
  };
}

function readPathSignal(
  record: Record<string, unknown>,
  index: number,
  allowedSourceRefs: Set<string>
): PathSignal | undefined {
  const sourceRefs = filterAllowedRefs(readStringArray(record.sourceRefs), allowedSourceRefs);
  if (sourceRefs.length === 0) {
    return undefined;
  }

  return {
    title: truncateText(readString(record.title) || `路径${index + 1}`, 24),
    summary: truncateText(readString(record.summary), 100),
    stance: readStance(record.stance),
    sourceRefs
  };
}

function readPersonaSeed(
  record: Record<string, unknown>,
  index: number,
  allowedSourceRefs: Set<string>
): PersonaSeed | undefined {
  const sourceRefs = filterAllowedRefs(readStringArray(record.sourceRefs), allowedSourceRefs);
  if (sourceRefs.length === 0) {
    return undefined;
  }

  return {
    personSeedId: truncateText(readString(record.personSeedId) || `seed_${index}`, 64),
    enabled: typeof record.enabled === "boolean" ? record.enabled : true,
    openingLine: truncateText(readString(record.openingLine), 80),
    suggestedQuestions: readStringArray(record.suggestedQuestions).map((item) => truncateText(item, 50)).slice(0, 3),
    sourceRefs
  };
}

function readDemoComposePath(
  record: Record<string, unknown>,
  index: number,
  allowedPathIds: Set<string>
): DemoComposePathOutput | undefined {
  const id = readString(record.id);
  if (!allowedPathIds.has(id)) {
    return undefined;
  }

  return {
    id,
    title: truncateText(readRequiredString(record.title, `paths[${index}].title`), 42),
    summary: truncateText(readRequiredString(record.summary, `paths[${index}].summary`), 150),
    whyRelevant: truncateOptionalString(record.whyRelevant, 140),
    tradeoff: truncateOptionalString(record.tradeoff, 140),
    fitReason: truncateOptionalString(record.fitReason, 120),
    diversityKey: truncateOptionalString(record.diversityKey, 40),
    stance: readStance(record.stance)
  };
}

function readDemoComposePerson(
  record: Record<string, unknown>,
  _index: number,
  allowedPersonIds: Set<string>
): DemoComposePersonOutput | undefined {
  const id = readString(record.id);
  if (!allowedPersonIds.has(id)) {
    return undefined;
  }

  return {
    id,
    role: truncateOptionalString(record.role, 40),
    badge: truncateOptionalString(record.badge, 18),
    oneLine: truncateOptionalString(record.oneLine, 90),
    fitReason: truncateOptionalString(record.fitReason, 120),
    who: truncateOptionalString(record.who, 90),
    overlaps: readStringArray(record.overlaps).map((item) => truncateText(item, 50)).slice(0, 4),
    matchReasons: readStringArray(record.matchReasons).map((item) => truncateText(item, 60)).slice(0, 4),
    matchedVariables: readStringArray(record.matchedVariables).map((item) => truncateText(item, 16)).slice(0, 8)
  };
}

function readExperienceSummaryItem(
  record: Record<string, unknown>,
  index: number,
  allowedPersonIds: Set<string>
): ExperienceSummaryItemOutput | undefined {
  const personId = readString(record.personId);
  if (!allowedPersonIds.has(personId)) {
    return undefined;
  }

  const rawSummary = readString(record.experienceSummary);
  const experienceSummary = rawSummary ? truncateText(rawSummary, 180) : null;

  return {
    personId,
    experienceSummary,
    confidence: clampScore(readNumber(record.confidence, experienceSummary ? 0.5 : 0)),
    reason: truncateText(
      readString(record.reason) ||
        (experienceSummary
          ? "LLM returned an experience-style summary"
          : `summaries[${index}] did not include enough grounded experience detail`),
      120
    )
  };
}

function readPersonaChatEvidence(
  record: Record<string, unknown>,
  index: number,
  options: {
    allowedArticleIds: Set<string>;
    isAllowedEvidenceText: (articleId: string, text: string) => boolean;
  }
): PersonaChatLlmEvidence {
  const articleId = readRequiredString(record.articleId, `evidence[${index}].articleId`);
  const text = readRequiredString(record.text, `evidence[${index}].text`);

  assertAllowedArticleIds([articleId], options.allowedArticleIds);
  if (!options.isAllowedEvidenceText(articleId, text)) {
    throw new LlmSchemaError(
      "LLM_GROUNDING_INVALID",
      `evidence[${index}].text is not present in persona_context`
    );
  }

  return {
    articleId,
    text
  };
}

function readCandidateRerankSelected(
  record: Record<string, unknown>,
  allowedCandidateIds: Set<string>
): CandidateRerankSelectedItem | undefined {
  const candidateId = readString(record.candidateId);
  if (!allowedCandidateIds.has(candidateId)) {
    return undefined;
  }

  const relationToUserIntent = truncateText(readRequiredString(record.relationToUserIntent, "relationToUserIntent"), 120);
  const summaryAngle = truncateText(readRequiredString(record.summaryAngle, "summaryAngle"), 80);
  const keepReason = truncateText(readRequiredString(record.keepReason, "keepReason"), 120);

  return {
    candidateId,
    keep: true,
    relevanceScore: clampPercentScore(readNumber(record.relevanceScore, 60)),
    contentRole: readContentRole(record.contentRole),
    relationToUserIntent,
    summaryAngle,
    diversityKey: truncateText(readString(record.diversityKey) || summaryAngle, 40),
    keepReason
  };
}

function readCandidateRerankDropped(
  record: Record<string, unknown>,
  allowedCandidateIds: Set<string>
): CandidateRerankDroppedItem | undefined {
  const candidateId = readString(record.candidateId);
  if (!allowedCandidateIds.has(candidateId)) {
    return undefined;
  }

  return {
    candidateId,
    keep: false,
    dropReason: truncateText(readString(record.dropReason) || "LLM judged this candidate weakly related to the user intent", 120)
  };
}

function readContentRole(value: unknown): DemoContentRole {
  if (
    value === "real_experience" ||
    value === "life_path" ||
    value === "failure_review" ||
    value === "decision_conflict" ||
    value === "alternative_solution" ||
    value === "viewpoint"
  ) {
    return value;
  }

  return "viewpoint";
}

function buildTopicSignals(input: {
  originalQuery: string;
  userCoreQuestion: string;
  focusTags: string[];
  searchQueries: DemoSearchQueryPlan[];
  rawTopicSignals: string[];
}): string[] {
  const fromModel = input.rawTopicSignals
    .map((item) => normalizeSignal(item))
    .filter(isTopicSignal);
  const fromFocusTags = input.focusTags
    .flatMap(splitSignalText)
    .map(normalizeSignal)
    .filter(isTopicSignal);
  const fromQueries = input.searchQueries
    .map((item) => item.query)
    .flatMap(splitSignalText)
    .map(normalizeSignal)
    .filter(isTopicSignal);
  const fromCore = [input.originalQuery, input.userCoreQuestion]
    .flatMap(splitSignalText)
    .map(normalizeSignal)
    .filter(isTopicSignal);

  return unique([...fromModel, ...fromFocusTags, ...fromCore, ...fromQueries]).slice(0, 12);
}

function splitSignalText(value: string): string[] {
  const normalized = normalizeSignal(value);
  if (!normalized) {
    return [];
  }

  const fragments = normalized
    .split(/[，。！？、,.!?\s/|:：；;（）()《》"“”]+/)
    .map((item) => item.trim())
    .filter(Boolean);

  return unique([normalized, ...fragments]);
}

function normalizeSignal(value: string): string {
  return value.replace(/\s+/g, "").replace(/^关于|相关$|真实经历$|怎么办$/g, "").trim();
}

function isTopicSignal(value: string): boolean {
  if (value.length < 2 || value.length > 12) {
    return false;
  }

  if (/^(用户|问题|公开内容|真实经历|相关|如何|怎么|怎么办|要不要|是否)$/.test(value)) {
    return false;
  }

  if (/^(召回|保留用户|基于|当前选择|行动代价|替代路径)/.test(value)) {
    return false;
  }

  return true;
}

function parseJsonObject(content: string): Record<string, unknown> {
  const normalized = stripMarkdownFence(content.trim());
  const start = normalized.indexOf("{");
  const end = normalized.lastIndexOf("}");

  if (start < 0 || end < start) {
    throw new LlmSchemaError("LLM_JSON_PARSE_FAILED", "LLM response did not contain a JSON object");
  }

  const jsonText = normalized.slice(start, end + 1);

  try {
    const parsed: unknown = JSON.parse(jsonText);
    return readRecord(parsed, "LLM root");
  } catch (firstError) {
    const repairedJsonText = stripTrailingJsonCommas(jsonText);
    if (repairedJsonText !== jsonText) {
      try {
        const parsed: unknown = JSON.parse(repairedJsonText);
        return readRecord(parsed, "LLM root");
      } catch {
        // Fall through to the original parse error so debug output points at
        // the provider response rather than our repair attempt.
      }
    }

    const error = firstError;
    throw new LlmSchemaError(
      "LLM_JSON_PARSE_FAILED",
      error instanceof Error ? error.message : "Invalid LLM JSON"
    );
  }
}

function stripTrailingJsonCommas(value: string): string {
  return value.replace(/,\s*([}\]])/g, "$1");
}

function stripMarkdownFence(value: string): string {
  if (!value.startsWith("```")) {
    return value;
  }

  return value
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "")
    .trim();
}

function readRecordArray(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.filter(isRecord);
}

function readRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new LlmSchemaError("LLM_SCHEMA_INVALID", `${label} must be an object`);
  }

  return value;
}

function readRequiredString(value: unknown, label: string): string {
  const text = readString(value);
  if (!text) {
    throw new LlmSchemaError("LLM_SCHEMA_INVALID", `${label} is required`);
  }

  return text;
}

function truncateOptionalString(value: unknown, maxLength: number): string | undefined {
  const text = readString(value);
  return text ? truncateText(text, maxLength) : undefined;
}

function readString(value: unknown): string {
  if (typeof value === "string") {
    return value.replace(/\s+/g, " ").trim();
  }

  if (typeof value === "number") {
    return String(value);
  }

  return "";
}

function readStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return unique(value.map(readString).filter(Boolean));
}

function readNumber(value: unknown, fallback: number): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === "string") {
    const parsed = Number.parseFloat(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }

  return fallback;
}

function readStance(value: unknown): DemoPath["stance"] {
  if (value === "experience" || value === "viewpoint" || value === "mixed") {
    return value;
  }

  return "mixed";
}

function readSampleType(value: unknown): PeopleSeed["sampleType"] {
  if (value === "experience_sample" || value === "viewpoint_author" || value === "content_sample") {
    return value;
  }

  return "content_sample";
}

function readAnswerType(value: unknown): PersonaChatAnswerType {
  if (
    value === "grounded_summary" ||
    value === "insufficient_evidence" ||
    value === "clarification" ||
    value === "safety_boundary"
  ) {
    return value;
  }

  throw new LlmSchemaError(
    "LLM_SCHEMA_INVALID",
    "answerType must be grounded_summary, insufficient_evidence, clarification, or safety_boundary"
  );
}

function assertAllowedArticleIds(articleIds: string[], allowedArticleIds: Set<string>): void {
  for (const articleId of articleIds) {
    if (!allowedArticleIds.has(articleId)) {
      throw new LlmSchemaError("LLM_GROUNDING_INVALID", `LLM referenced unknown articleId: ${articleId}`);
    }
  }
}

function filterAllowedRefs(values: string[], allowedSourceRefs: Set<string>): string[] {
  return unique(values.filter((value) => allowedSourceRefs.has(value)));
}

function truncateText(value: string, maxLength: number): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }

  return `${normalized.slice(0, maxLength - 3)}...`;
}

function clampScore(value: number): number {
  return Math.min(Math.max(Number(value.toFixed(2)), 0), 1);
}

function clampPercentScore(value: number): number {
  return Math.min(Math.max(Math.round(value), 0), 100);
}

function unique(values: string[]): string[] {
  return Array.from(new Set(values));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
