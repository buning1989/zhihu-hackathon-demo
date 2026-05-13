import { DEMO_COMPOSER_SYSTEM_PROMPT } from "../prompts/demoComposerPrompt.js";
import { llmClient } from "../providers/llm/openaiCompatible.client.js";
import {
  DEMO_PERSONA_BOUNDARY_NOTICE,
  DEMO_SCHEMA_VERSION,
  type DemoAnalysis,
  type DemoAnalysisStep,
  type DemoDataMode,
  type DemoMatch,
  type DemoPath,
  type DemoPerson,
  type DemoPersonPersona,
  type DemoPersona,
  type DemoSearchResponse,
  type DemoSourceRef,
  type DemoTimelineEvent
} from "../types/demo.types.js";
import type { SearchItem } from "../types/api.types.js";

interface ComposeLlmDemoInput {
  query: string;
  count: number;
  dataMode: DemoDataMode;
  items: SearchItem[];
  startedAt: number;
  deterministicResponse: DemoSearchResponse;
}

interface ComposerContext {
  query: string;
  maxPeople: number;
  outputLimits: {
    paths: "2-3";
    people: 3;
    timelinePerPerson: 1;
    suggestedQuestionsPerPerson: 2;
    analysisSteps: 2;
  };
  boundaryNotice: string;
  allowedPeople: AllowedPerson[];
}

interface AllowedPerson {
  personId: string;
  name: string;
  sampleType: string;
  articleIds: string[];
  sourceRefs: string[];
  evidenceIds: string[];
  title: string;
  author: string;
  url: string;
  text: string;
  evidence: Array<{
    id: string;
    label: string;
    text: string;
    sourceRefId: string;
  }>;
}

interface NormalizedPeopleSeed {
  records: Record<string, unknown>[];
  baselinesById: Map<string, DemoPerson>;
  selectedPersonIds: Set<string>;
}

export class DemoComposerLlmError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly guardWarnings: string[] = [],
    public readonly llmRepairUsed = false,
    public readonly llmRepairFailed = false
  ) {
    super(message);
    this.name = "DemoComposerLlmError";
  }
}

export async function composeLlmDemoSearchResponse(
  input: ComposeLlmDemoInput
): Promise<DemoSearchResponse> {
  const context = buildComposerContext(input);
  const content = await llmClient.createJsonCompletion({
    temperature: 0.2,
    maxTokens: 3000,
    messages: [
      {
        role: "system",
        content: DEMO_COMPOSER_SYSTEM_PROMPT
      },
      {
        role: "user",
        content: [
          "请基于下面的 composer_context 输出严格 JSON。",
          "只能使用 allowedPeople 里提供的 personId、articleIds、sourceRefs、evidenceIds 和证据文本。",
          "严格遵守 outputLimits：people 最多 3 个，paths 2-3 个，timeline 每人 1 条，suggestedQuestions 每人 2 条，analysis.steps 最多 2 条。",
          "不要输出 Markdown，不要解释，不要尾随逗号，不要注释，不要多余字段。",
          "",
          "<composer_context>",
          JSON.stringify(context, null, 2),
          "</composer_context>"
        ].join("\n")
      }
    ]
  });
  const parsed = await parseJsonObjectWithRepair(content, context);

  try {
    return buildResponseFromLlmOutput(parsed.output, input, {
      llmRepairUsed: parsed.repairUsed,
      llmRepairFailed: parsed.repairFailed
    });
  } catch (error) {
    if (parsed.repairUsed && error instanceof DemoComposerLlmError) {
      throw new DemoComposerLlmError(
        error.code,
        error.message,
        error.guardWarnings,
        true,
        parsed.repairFailed
      );
    }

    throw error;
  }
}

function buildComposerContext(input: ComposeLlmDemoInput): ComposerContext {
  const maxPeople = Math.min(Math.max(input.count, 1), input.deterministicResponse.people.length, 3);
  const people = input.deterministicResponse.people.slice(0, maxPeople);

  return {
    query: input.query,
    maxPeople,
    outputLimits: {
      paths: "2-3",
      people: 3,
      timelinePerPerson: 1,
      suggestedQuestionsPerPerson: 2,
      analysisSteps: 2
    },
    boundaryNotice: DEMO_PERSONA_BOUNDARY_NOTICE,
    allowedPeople: people.map((person) => {
      const article = person.articles[0];

      return {
        personId: person.id,
        name: person.name,
        sampleType: person.sampleType ?? "content_sample",
        articleIds: person.articles.map((item) => item.id),
        sourceRefs: person.sourceRefs,
        evidenceIds: person.evidenceIds,
        title: article?.title ?? "",
        author: article?.author ?? person.name,
        url: article?.url ?? "",
        text: truncateText(article?.text ?? "", 360),
        evidence:
          article?.evidence.map((evidence) => ({
            id: evidence.id,
            label: evidence.label,
            text: truncateText(evidence.text, 120),
            sourceRefId: evidence.sourceRefId
          })) ?? []
      };
    })
  };
}

function buildResponseFromLlmOutput(
  output: Record<string, unknown>,
  input: ComposeLlmDemoInput,
  llmParse: {
    llmRepairUsed: boolean;
    llmRepairFailed: boolean;
  }
): DemoSearchResponse {
  const guardWarnings: string[] = [];
  const peopleSeed = readPeopleSeed(output, input.deterministicResponse);
  const paths = normalizePaths(output, peopleSeed, guardWarnings);
  const pathIds = new Set(paths.map((path) => path.id));
  const people = normalizePeople(output, peopleSeed, pathIds, guardWarnings);
  const personas = normalizePersonas(output, people, guardWarnings);
  const analysis = normalizeAnalysis(output, paths, people, guardWarnings);
  const sourceRefs = collectUsedSourceRefs(
    input.deterministicResponse.meta.sourceRefs,
    analysis,
    paths,
    people,
    personas
  );

  if (sourceRefs.length === 0) {
    fail("LLM_GROUNDING_INVALID", "LLM response did not preserve sourceRefs", guardWarnings);
  }

  return {
    schemaVersion: DEMO_SCHEMA_VERSION,
    queryId: input.deterministicResponse.queryId,
    query: input.query,
    dataMode: input.dataMode,
    features: input.deterministicResponse.features,
    analysis,
    paths,
    people,
    personas,
    sections: [
      {
        id: "section_paths",
        type: "paths",
        title: "真实内容整理出的路径",
        itemRefs: paths.map((path) => path.id)
      },
      {
        id: "section_people",
        type: "people",
        title: "来自知乎公开内容的样本",
        itemRefs: people.map((person) => person.id)
      },
      {
        id: "section_personas",
        type: "personas",
        title: "可追问的经验回声",
        itemRefs: personas.map((persona) => persona.id)
      }
    ],
    meta: {
      sourceRefs,
      evidenceCount: sourceRefs.reduce((total, sourceRef) => total + sourceRef.evidenceIds.length, 0),
      generatedAt: new Date().toISOString(),
      latencyMs: Date.now() - input.startedAt,
      fallbackUsed: false
    },
    debug: {
      composer: "real_llm_composer",
      requestedDataMode: input.dataMode,
      resolvedDataMode: input.dataMode,
      itemCount: people.length,
      sourceItemCount: input.items.length,
      pathCount: paths.length,
      peopleCount: people.length,
      personaCount: personas.length,
      llmUsed: true,
      llmComposerUsed: true,
      llmRepairUsed: llmParse.llmRepairUsed,
      llmRepairFailed: llmParse.llmRepairFailed,
      fallbackUsed: false,
      fallbackReason: "",
      guardWarnings,
      notes: ["real Zhihu items composed by LLM with source/evidence guard"]
    }
  };
}

function readPeopleSeed(
  output: Record<string, unknown>,
  deterministicResponse: DemoSearchResponse
): NormalizedPeopleSeed {
  const records = readArray(output.people, "people");
  if (records.length === 0) {
    fail("LLM_SCHEMA_INVALID", "LLM response must include people");
  }

  const baselineById = new Map(
    deterministicResponse.people.slice(0, 3).map((person) => [person.id, person])
  );
  const selectedPersonIds = new Set<string>();
  const baselinesById = new Map<string, DemoPerson>();
  const limitedRecords = records.slice(0, 3);

  for (const record of limitedRecords) {
    const id = readRequiredString(record, "id", "people[].id");
    const baseline = baselineById.get(id);
    if (!baseline) {
      fail("LLM_GROUNDING_INVALID", `LLM referenced unknown person id: ${id}`);
    }

    if (selectedPersonIds.has(id)) {
      fail("LLM_GROUNDING_INVALID", `LLM duplicated person id: ${id}`);
    }

    selectedPersonIds.add(id);
    baselinesById.set(id, baseline);
  }

  return {
    records: limitedRecords,
    baselinesById,
    selectedPersonIds
  };
}

function normalizePaths(
  output: Record<string, unknown>,
  peopleSeed: NormalizedPeopleSeed,
  guardWarnings: string[]
): DemoPath[] {
  const records = readArray(output.paths, "paths");
  if (records.length === 0) {
    fail("LLM_SCHEMA_INVALID", "LLM response must include paths", guardWarnings);
  }

  if (records.length > 3) {
    guardWarnings.push("paths exceeded output limit; only first 3 paths were used");
  }

  const pathIds = new Set<string>();
  return records.slice(0, 3).map((record) => {
    const id = readRequiredString(record, "id", "paths[].id");
    if (pathIds.has(id)) {
      fail("LLM_GROUNDING_INVALID", `LLM duplicated path id: ${id}`, guardWarnings);
    }
    pathIds.add(id);

    const personRefs = readNonEmptyStringArray(record.personRefs, `paths[${id}].personRefs`);
    for (const personRef of personRefs) {
      if (!peopleSeed.selectedPersonIds.has(personRef)) {
        fail(
          "LLM_GROUNDING_INVALID",
          `Path referenced unknown person: ${id} -> ${personRef}`,
          guardWarnings
        );
      }
    }

    const allowedSourceRefs = unionForPeople(peopleSeed.baselinesById, personRefs, "sourceRefs");
    const allowedEvidenceIds = unionForPeople(peopleSeed.baselinesById, personRefs, "evidenceIds");
    const sourceRefs = readAllowedRefs(
      record.sourceRefs,
      allowedSourceRefs,
      `paths[${id}].sourceRefs`,
      guardWarnings
    );
    const evidenceIds = readAllowedRefs(
      record.evidenceIds,
      allowedEvidenceIds,
      `paths[${id}].evidenceIds`,
      guardWarnings
    );
    const title = readRequiredString(record, "title", `paths[${id}].title`);
    const summary = readRequiredString(record, "summary", `paths[${id}].summary`);

    assertNoForbiddenClaims([title, summary], `paths[${id}]`, guardWarnings);

    return {
      id,
      title,
      summary,
      stance: readStance(record.stance, `paths[${id}].stance`, guardWarnings),
      personRefs,
      evidenceIds,
      sourceRefs
    };
  });
}

function normalizePeople(
  output: Record<string, unknown>,
  peopleSeed: NormalizedPeopleSeed,
  pathIds: Set<string>,
  guardWarnings: string[]
): DemoPerson[] {
  return peopleSeed.records.map((record) => {
    const id = readRequiredString(record, "id", "people[].id");
    const baseline = peopleSeed.baselinesById.get(id);
    if (!baseline) {
      fail("LLM_GROUNDING_INVALID", `LLM referenced unknown person id: ${id}`, guardWarnings);
    }

    const sourceRefs = readAllowedRefs(
      record.sourceRefs,
      new Set(baseline.sourceRefs),
      `people[${id}].sourceRefs`,
      guardWarnings
    );
    const evidenceIds = readAllowedRefs(
      record.evidenceIds,
      new Set(baseline.evidenceIds),
      `people[${id}].evidenceIds`,
      guardWarnings
    );
    const pathId = readRequiredString(record, "pathId", `people[${id}].pathId`);
    if (!pathIds.has(pathId)) {
      fail("LLM_GROUNDING_INVALID", `Person referenced unknown path: ${id} -> ${pathId}`, guardWarnings);
    }

    const role = readRequiredString(record, "role", `people[${id}].role`);
    const badge = readRequiredString(record, "badge", `people[${id}].badge`);
    const oneLine = readRequiredString(record, "oneLine", `people[${id}].oneLine`);
    const who = readRequiredString(record, "who", `people[${id}].who`);
    const overlaps = readNonEmptyStringArray(record.overlaps, `people[${id}].overlaps`);
    const lesson = readRequiredString(record, "lesson", `people[${id}].lesson`);
    const timeline = normalizeTimeline(record.timeline, id, sourceRefs, evidenceIds, guardWarnings);
    const match = normalizeMatch(record.match, id, sourceRefs, evidenceIds, guardWarnings);
    const aiPersona = normalizePersonPersona(record.aiPersona, baseline, sourceRefs, guardWarnings);

    assertNoForbiddenClaims(
      [
        role,
        badge,
        oneLine,
        who,
        lesson,
        ...overlaps,
        ...timeline.map((item) => item.event),
        ...match.reasons,
        aiPersona.displayName,
        aiPersona.openingLine,
        ...aiPersona.suggestedQuestions
      ],
      `people[${id}]`,
      guardWarnings
    );

    return {
      ...baseline,
      pathId,
      role,
      badge,
      oneLine,
      who,
      overlaps,
      timeline,
      lesson,
      match,
      aiPersona,
      evidenceIds,
      sourceRefs
    };
  });
}

function normalizeTimeline(
  value: unknown,
  personId: string,
  allowedSourceRefs: string[],
  allowedEvidenceIds: string[],
  guardWarnings: string[]
): DemoTimelineEvent[] {
  const records = readArray(value, `people[${personId}].timeline`);
  if (records.length === 0) {
    fail("LLM_SCHEMA_INVALID", `Person timeline is required: ${personId}`, guardWarnings);
  }

  if (records.length > 1) {
    guardWarnings.push(`people[${personId}].timeline exceeded output limit; only first event was used`);
  }

  return records.slice(0, 1).map((record, index) => ({
    date: readRequiredString(record, "date", `people[${personId}].timeline[${index}].date`),
    event: readRequiredString(record, "event", `people[${personId}].timeline[${index}].event`),
    evidenceIds: readAllowedRefs(
      record.evidenceIds,
      new Set(allowedEvidenceIds),
      `people[${personId}].timeline[${index}].evidenceIds`,
      guardWarnings
    ),
    sourceRefs: readAllowedRefs(
      record.sourceRefs,
      new Set(allowedSourceRefs),
      `people[${personId}].timeline[${index}].sourceRefs`,
      guardWarnings
    )
  }));
}

function normalizeMatch(
  value: unknown,
  personId: string,
  allowedSourceRefs: string[],
  allowedEvidenceIds: string[],
  guardWarnings: string[]
): DemoMatch {
  const record = readRecord(value, `people[${personId}].match`);

  return {
    score: readScore(record.score, `people[${personId}].match.score`, guardWarnings),
    level: readLevel(record.level, `people[${personId}].match.level`, guardWarnings),
    reasons: readNonEmptyStringArray(record.reasons, `people[${personId}].match.reasons`),
    matchedVariables: readNonEmptyStringArray(
      record.matchedVariables,
      `people[${personId}].match.matchedVariables`
    ),
    riskNotes: readNonEmptyStringArray(record.riskNotes, `people[${personId}].match.riskNotes`),
    contentRelevance: readScore(
      record.contentRelevance,
      `people[${personId}].match.contentRelevance`,
      guardWarnings
    ),
    experienceSimilarity: readScore(
      record.experienceSimilarity,
      `people[${personId}].match.experienceSimilarity`,
      guardWarnings
    ),
    evidenceQuality: readScore(
      record.evidenceQuality,
      `people[${personId}].match.evidenceQuality`,
      guardWarnings
    ),
    personaReadiness: readScore(
      record.personaReadiness,
      `people[${personId}].match.personaReadiness`,
      guardWarnings
    ),
    evidenceIds: readAllowedRefs(
      record.evidenceIds,
      new Set(allowedEvidenceIds),
      `people[${personId}].match.evidenceIds`,
      guardWarnings
    ),
    sourceRefs: readAllowedRefs(
      record.sourceRefs,
      new Set(allowedSourceRefs),
      `people[${personId}].match.sourceRefs`,
      guardWarnings
    )
  };
}

function normalizePersonPersona(
  value: unknown,
  baseline: DemoPerson,
  allowedSourceRefs: string[],
  guardWarnings: string[]
): DemoPersonPersona {
  const record = readRecord(value, `people[${baseline.id}].aiPersona`);
  const grounding = readRecord(record.grounding, `people[${baseline.id}].aiPersona.grounding`);
  const groundingPersonId = readOptionalString(grounding.personId);
  if (groundingPersonId && groundingPersonId !== baseline.id) {
    fail(
      "LLM_GROUNDING_INVALID",
      `Persona grounding personId mismatch: ${baseline.id} -> ${groundingPersonId}`,
      guardWarnings
    );
  }

  if (grounding.evidenceRequired !== true) {
    fail(
      "LLM_GROUNDING_INVALID",
      `Persona grounding evidenceRequired must be true: ${baseline.id}`,
      guardWarnings
    );
  }

  const articleIds = readStringArray(grounding.articleIds);
  const allowedArticleIds = new Set(baseline.articles.map((article) => article.id));

  if (articleIds.length === 0) {
    guardWarnings.push(`people[${baseline.id}].aiPersona.grounding.articleIds was empty; baseline articleIds used`);
  }

  const normalizedArticleIds = articleIds.length > 0 ? articleIds : Array.from(allowedArticleIds);
  for (const articleId of normalizedArticleIds) {
    if (!allowedArticleIds.has(articleId)) {
      fail(
        "LLM_GROUNDING_INVALID",
        `Persona referenced unknown article: ${baseline.id} -> ${articleId}`,
        guardWarnings
      );
    }
  }

  const sourceRefs = readAllowedRefs(
    grounding.sourceRefs,
    new Set(allowedSourceRefs),
    `people[${baseline.id}].aiPersona.grounding.sourceRefs`,
    guardWarnings
  );
  const personaId =
    readOptionalString(record.personaId) || baseline.aiPersona.personaId || `persona_${baseline.id}`;
  const displayName = readRequiredString(
    record,
    "displayName",
    `people[${baseline.id}].aiPersona.displayName`
  );
  const openingLine = readRequiredString(
    record,
    "openingLine",
    `people[${baseline.id}].aiPersona.openingLine`
  );

  return {
    enabled: typeof record.enabled === "boolean" ? record.enabled : baseline.aiPersona.enabled,
    personaId,
    displayName,
    label: readOptionalString(record.label) || "基于公开内容生成",
    openingLine,
    suggestedQuestions: readStringArray(record.suggestedQuestions).slice(0, 2),
    boundary: DEMO_PERSONA_BOUNDARY_NOTICE,
    grounding: {
      personId: baseline.id,
      articleIds: normalizedArticleIds,
      evidenceRequired: true,
      sourceRefs
    }
  };
}

function normalizePersonas(
  output: Record<string, unknown>,
  people: DemoPerson[],
  guardWarnings: string[]
): DemoPersona[] {
  const records = readArray(output.personas, "personas");
  if (records.length === 0) {
    fail("LLM_SCHEMA_INVALID", "LLM response must include personas", guardWarnings);
  }

  const rawPersonaByPersonId = new Map<string, Record<string, unknown>>();
  for (const record of records) {
    const personId = readRequiredString(record, "personId", "personas[].personId");
    if (rawPersonaByPersonId.has(personId)) {
      fail("LLM_GROUNDING_INVALID", `LLM duplicated persona personId: ${personId}`, guardWarnings);
    }
    rawPersonaByPersonId.set(personId, record);
  }

  return people.map((person) => {
    const record = rawPersonaByPersonId.get(person.id);
    if (!record) {
      fail("LLM_GROUNDING_INVALID", `Missing top-level persona for person: ${person.id}`, guardWarnings);
    }

    const id = readRequiredString(record, "id", `personas[${person.id}].id`);
    if (id !== person.aiPersona.personaId) {
      fail(
        "LLM_GROUNDING_INVALID",
        `Persona id does not match people[].aiPersona: ${person.id}`,
        guardWarnings
      );
    }

    const sourceRefs = readAllowedRefs(
      record.sourceRefs,
      new Set(person.sourceRefs),
      `personas[${person.id}].sourceRefs`,
      guardWarnings
    );
    const displayName = readOptionalString(record.displayName) || person.aiPersona.displayName;
    const intro = readOptionalString(record.intro) || person.aiPersona.openingLine;
    const suggestedQuestions = readStringArray(record.suggestedQuestions);

    assertNoForbiddenClaims(
      [displayName, intro, ...suggestedQuestions],
      `personas[${person.id}]`,
      guardWarnings
    );

    return {
      id,
      personId: person.id,
      displayName,
      avatar: person.avatar,
      personaType: "experience_echo",
      intro,
      boundaryNotice: DEMO_PERSONA_BOUNDARY_NOTICE,
      sourceRefs,
      suggestedQuestions:
        suggestedQuestions.length > 0
          ? suggestedQuestions.slice(0, 2)
          : person.aiPersona.suggestedQuestions.slice(0, 2)
    };
  });
}

function normalizeAnalysis(
  output: Record<string, unknown>,
  paths: DemoPath[],
  people: DemoPerson[],
  guardWarnings: string[]
): DemoAnalysis {
  const record = readRecord(output.analysis, "analysis");
  const allowedSourceRefs = new Set(people.flatMap((person) => person.sourceRefs));
  const allowedEvidenceIds = new Set(people.flatMap((person) => person.evidenceIds));
  const steps = readArray(record.steps, "analysis.steps");

  return {
    summary: readRequiredString(record, "summary", "analysis.summary"),
    intent: readOptionalString(record.intent) || "life_path_exploration",
    focusTags: readStringArray(record.focusTags).slice(0, 8),
    steps:
      steps.length > 0
        ? steps.slice(0, 2).map((step, index) => normalizeAnalysisStep(
            step,
            index,
            allowedSourceRefs,
            allowedEvidenceIds,
            guardWarnings
          ))
        : buildFallbackAnalysisSteps(paths, guardWarnings)
  };
}

function normalizeAnalysisStep(
  record: Record<string, unknown>,
  index: number,
  allowedSourceRefs: Set<string>,
  allowedEvidenceIds: Set<string>,
  guardWarnings: string[]
): DemoAnalysisStep {
  return {
    id: readOptionalString(record.id) || `step_llm_${index + 1}`,
    label: readRequiredString(record, "label", `analysis.steps[${index}].label`),
    status: record.status === "pending" ? "pending" : "done",
    evidenceIds: readAllowedRefs(
      record.evidenceIds,
      allowedEvidenceIds,
      `analysis.steps[${index}].evidenceIds`,
      guardWarnings
    ),
    sourceRefs: readAllowedRefs(
      record.sourceRefs,
      allowedSourceRefs,
      `analysis.steps[${index}].sourceRefs`,
      guardWarnings
    )
  };
}

function buildFallbackAnalysisSteps(paths: DemoPath[], guardWarnings: string[]): DemoAnalysisStep[] {
  guardWarnings.push("analysis.steps was empty; generated a grounded fallback step");

  return [
    {
      id: "step_llm_group_real_zhihu",
      label: "基于真实知乎公开内容整理路径",
      status: "done",
      evidenceIds: unique(paths.flatMap((path) => path.evidenceIds)),
      sourceRefs: unique(paths.flatMap((path) => path.sourceRefs))
    }
  ];
}

function collectUsedSourceRefs(
  baselineSourceRefs: DemoSourceRef[],
  analysis: DemoAnalysis,
  paths: DemoPath[],
  people: DemoPerson[],
  personas: DemoPersona[]
): DemoSourceRef[] {
  const usedIds = new Set<string>();

  for (const step of analysis.steps) {
    step.sourceRefs.forEach((sourceRef) => usedIds.add(sourceRef));
  }

  for (const path of paths) {
    path.sourceRefs.forEach((sourceRef) => usedIds.add(sourceRef));
  }

  for (const person of people) {
    person.sourceRefs.forEach((sourceRef) => usedIds.add(sourceRef));
    person.match.sourceRefs.forEach((sourceRef) => usedIds.add(sourceRef));
    person.aiPersona.grounding.sourceRefs.forEach((sourceRef) => usedIds.add(sourceRef));
    for (const event of person.timeline) {
      event.sourceRefs.forEach((sourceRef) => usedIds.add(sourceRef));
    }
    for (const article of person.articles) {
      article.sourceRefs.forEach((sourceRef) => usedIds.add(sourceRef));
      for (const evidence of article.evidence) {
        usedIds.add(evidence.sourceRefId);
      }
    }
  }

  for (const persona of personas) {
    persona.sourceRefs.forEach((sourceRef) => usedIds.add(sourceRef));
  }

  return baselineSourceRefs.filter((sourceRef) => usedIds.has(sourceRef.id));
}

async function parseJsonObjectWithRepair(
  content: string,
  context: ComposerContext
): Promise<{
  output: Record<string, unknown>;
  repairUsed: boolean;
  repairFailed: boolean;
}> {
  try {
    return {
      output: parseJsonObject(content),
      repairUsed: false,
      repairFailed: false
    };
  } catch (error) {
    if (!(error instanceof DemoComposerLlmError) || error.code !== "LLM_JSON_PARSE_FAILED") {
      throw error;
    }

    try {
      const repairedContent = await repairLlmJson(content, error.message, context);
      return {
        output: parseJsonObject(repairedContent),
        repairUsed: true,
        repairFailed: false
      };
    } catch (repairError) {
      const repairWarnings =
        repairError instanceof DemoComposerLlmError ? repairError.guardWarnings : [];
      throw new DemoComposerLlmError(
        "LLM_JSON_REPAIR_FAILED",
        `LLM JSON repair failed after initial parse error: ${toErrorMessage(repairError)}`,
        [...error.guardWarnings, ...repairWarnings],
        true,
        true
      );
    }
  }
}

async function repairLlmJson(
  invalidJson: string,
  parseError: string,
  context: ComposerContext
): Promise<string> {
  return llmClient.createJsonCompletion({
    temperature: 0,
    maxTokens: 3000,
    messages: [
      {
        role: "system",
        content: [
          "你是 JSON 语法修复器。只修复格式，不改事实。",
          "只输出一个合法 JSON object，不要 Markdown，不要解释。",
          "禁止尾随逗号、注释、多余字段、未闭合字符串。",
          "不得新增、删除或替换任何 personId、articleIds、sourceRefs、evidenceIds。",
          "不得新增事实、作者经历、路径、人物或引用；只能修正引号、逗号、括号、转义和未闭合字符串。"
        ].join("\n")
      },
      {
        role: "user",
        content: [
          "下面是一次 Demo Composer 输出的非法 JSON。请只修复 JSON 格式。",
          `解析错误：${parseError}`,
          "",
          "允许引用的 ID 只包括：",
          JSON.stringify(buildRepairAllowedIds(context), null, 2),
          "",
          "<invalid_json>",
          truncateText(invalidJson, 12000),
          "</invalid_json>"
        ].join("\n")
      }
    ]
  });
}

function buildRepairAllowedIds(context: ComposerContext): Record<string, unknown> {
  return {
    people: context.allowedPeople.map((person) => ({
      personId: person.personId,
      articleIds: person.articleIds,
      sourceRefs: person.sourceRefs,
      evidenceIds: person.evidenceIds
    }))
  };
}

function parseJsonObject(content: string): Record<string, unknown> {
  const normalized = stripMarkdownFence(content.trim());
  const start = normalized.indexOf("{");
  const end = normalized.lastIndexOf("}");

  if (start < 0 || end < start) {
    fail("LLM_JSON_PARSE_FAILED", "LLM response did not contain a JSON object");
  }

  try {
    const parsed: unknown = JSON.parse(normalized.slice(start, end + 1));
    return readRecord(parsed, "LLM root");
  } catch (error) {
    fail("LLM_JSON_PARSE_FAILED", error instanceof Error ? error.message : "Invalid LLM JSON");
  }
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

function readArray(value: unknown, label: string): Record<string, unknown>[] {
  if (!Array.isArray(value)) {
    fail("LLM_SCHEMA_INVALID", `${label} must be an array`);
  }

  return value.map((item, index) => readRecord(item, `${label}[${index}]`));
}

function readRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) {
    fail("LLM_SCHEMA_INVALID", `${label} must be an object`);
  }

  return value;
}

function readRequiredString(record: Record<string, unknown>, key: string, label: string): string {
  const value = readOptionalString(record[key]).trim();
  if (!value) {
    fail("LLM_SCHEMA_INVALID", `${label || key} is required`);
  }

  return value;
}

function readOptionalString(value: unknown): string {
  if (typeof value === "string") {
    return value.trim();
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

  return unique(value.map(readOptionalString).filter(Boolean));
}

function readNonEmptyStringArray(value: unknown, label: string): string[] {
  const values = readStringArray(value);
  if (values.length === 0) {
    fail("LLM_SCHEMA_INVALID", `${label} must include at least one value`);
  }

  return values;
}

function readAllowedRefs(
  value: unknown,
  allowedRefs: Set<string>,
  label: string,
  guardWarnings: string[]
): string[] {
  const refs = readNonEmptyStringArray(value, label);

  for (const ref of refs) {
    if (!allowedRefs.has(ref)) {
      fail("LLM_GROUNDING_INVALID", `${label} referenced disallowed id: ${ref}`, guardWarnings);
    }
  }

  return refs;
}

function readScore(value: unknown, label: string, guardWarnings: string[]): number {
  const parsed = typeof value === "number" ? value : Number.parseFloat(readOptionalString(value));
  if (!Number.isFinite(parsed)) {
    fail("LLM_SCHEMA_INVALID", `${label} must be a number`, guardWarnings);
  }

  return Math.min(Math.max(Number(parsed.toFixed(2)), 0), 1);
}

function readLevel(value: unknown, label: string, guardWarnings: string[]): DemoMatch["level"] {
  if (value === "low" || value === "medium" || value === "high") {
    return value;
  }

  fail("LLM_SCHEMA_INVALID", `${label} must be low, medium, or high`, guardWarnings);
}

function readStance(value: unknown, label: string, guardWarnings: string[]): DemoPath["stance"] {
  if (value === "experience" || value === "viewpoint" || value === "mixed") {
    return value;
  }

  fail("LLM_SCHEMA_INVALID", `${label} must be experience, viewpoint, or mixed`, guardWarnings);
}

function unionForPeople(
  baselinesById: Map<string, DemoPerson>,
  personRefs: string[],
  field: "sourceRefs" | "evidenceIds"
): Set<string> {
  const values = new Set<string>();
  for (const personRef of personRefs) {
    baselinesById.get(personRef)?.[field].forEach((value) => values.add(value));
  }

  return values;
}

function assertNoForbiddenClaims(values: string[], label: string, guardWarnings: string[]): void {
  const forbiddenFragments = [
    "作者本人正在回答",
    "本人正在回答",
    "作者在线",
    "真人",
    "联系TA",
    "联系 TA",
    "私信",
    "和本人聊",
    "模拟作者本人"
  ];

  for (const value of values) {
    for (const fragment of forbiddenFragments) {
      if (value.includes(fragment)) {
        fail("LLM_GROUNDING_INVALID", `${label} contains forbidden claim: ${fragment}`, guardWarnings);
      }
    }
  }
}

function fail(code: string, message: string, guardWarnings: string[] = []): never {
  throw new DemoComposerLlmError(code, message, guardWarnings);
}

function truncateText(value: string, maxLength: number): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }

  return `${normalized.slice(0, maxLength - 3)}...`;
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message) {
    return error.message;
  }

  return "Unknown error";
}

function unique(values: string[]): string[] {
  return Array.from(new Set(values));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
