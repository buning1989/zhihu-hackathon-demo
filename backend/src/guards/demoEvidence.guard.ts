import {
  DEMO_PERSONA_BOUNDARY_NOTICE,
  type DemoArticle,
  type DemoPath,
  type DemoPerson,
  type DemoPersona,
  type DemoSearchResponse,
  type DemoSection,
  type DemoSourceRef
} from "../types/demo.types.js";
import { HttpError } from "../utils/httpError.js";

interface GroundingIndex {
  sourceById: Map<string, DemoSourceRef>;
  pathIds: Set<string>;
  personIds: Set<string>;
  personaIds: Set<string>;
}

export function assertDemoSearchGrounding(data: DemoSearchResponse): void {
  const index = buildIndex(data);

  for (const path of data.paths) {
    assertPathGrounding(path, index);
  }

  for (const person of data.people) {
    assertPersonGrounding(person, index);
  }

  for (const persona of data.personas ?? []) {
    assertPersonaGrounding(persona, index);
  }

  for (const section of data.sections ?? []) {
    assertSectionRefs(section, index);
  }
}

function buildIndex(data: DemoSearchResponse): GroundingIndex {
  return {
    sourceById: new Map(data.meta.sourceRefs.map((sourceRef) => [sourceRef.id, sourceRef])),
    pathIds: new Set(data.paths.map((path) => path.id)),
    personIds: new Set(data.people.map((person) => person.id)),
    personaIds: new Set(readPersonaIds(data))
  };
}

function readPersonaIds(data: DemoSearchResponse): string[] {
  if (data.personas?.length) {
    return data.personas.map((persona) => persona.id);
  }

  return data.people.map((person) => person.aiPersona.personaId).filter(Boolean);
}

function assertPathGrounding(path: DemoPath, index: GroundingIndex): void {
  assertHasRefs("path", path.id, path);
  assertSourceRefsExist("path", path.id, path.sourceRefs, index);
  assertEvidenceIdsResolvable("path", path.id, path.evidenceIds, path.sourceRefs, index);

  for (const personRef of path.personRefs ?? []) {
    if (!index.personIds.has(personRef)) {
      throwGroundingError(
        "DEMO_PATH_PERSON_REF_INVALID",
        `Path personRef not found: ${path.id} -> ${personRef}`
      );
    }
  }
}

function assertPersonGrounding(person: DemoPerson, index: GroundingIndex): void {
  assertHasRefs("person", person.id, person);
  assertSourceRefsExist("person", person.id, person.sourceRefs, index);

  if (!index.pathIds.has(person.pathId)) {
    throwGroundingError("DEMO_PERSON_PATH_REF_INVALID", `Person pathId not found: ${person.id}`);
  }

  if (person.articles.length === 0) {
    throwGroundingError("DEMO_PERSON_ARTICLES_REQUIRED", `Person has no articles: ${person.id}`);
  }

  const articleEvidenceIds = new Set<string>();
  const articleIds = new Set<string>();

  for (const article of person.articles) {
    assertArticleGrounding(article, index);
    articleIds.add(article.id);
    for (const evidence of article.evidence) {
      articleEvidenceIds.add(evidence.id);
    }
  }

  assertEvidenceIdsResolvable(
    "person",
    person.id,
    person.evidenceIds,
    person.sourceRefs,
    index,
    articleEvidenceIds
  );

  if (person.aiPersona.boundary !== DEMO_PERSONA_BOUNDARY_NOTICE) {
    throwGroundingError(
      "DEMO_PERSON_AI_PERSONA_BOUNDARY_REQUIRED",
      `Person aiPersona has invalid boundary: ${person.id}`
    );
  }

  assertSourceRefsExist(
    "person.aiPersona",
    person.id,
    person.aiPersona.grounding.sourceRefs,
    index
  );

  for (const articleId of person.aiPersona.grounding.articleIds) {
    if (!articleIds.has(articleId)) {
      throwGroundingError(
        "DEMO_PERSONA_ARTICLE_REF_INVALID",
        `Person aiPersona articleId not found: ${person.id} -> ${articleId}`
      );
    }
  }
}

function assertArticleGrounding(article: DemoArticle, index: GroundingIndex): void {
  if (article.evidence.length === 0 || article.sourceRefs.length === 0) {
    throwGroundingError(
      "DEMO_ARTICLE_GROUNDING_REQUIRED",
      `Article missing evidence/sourceRefs: ${article.id}`
    );
  }

  assertSourceRefsExist("article", article.id, article.sourceRefs, index);

  for (const evidence of article.evidence) {
    if (!index.sourceById.has(evidence.sourceRefId)) {
      throwGroundingError(
        "DEMO_EVIDENCE_SOURCE_REF_INVALID",
        `Evidence sourceRefId not found: ${article.id} -> ${evidence.id}`
      );
    }

    const sourceRef = index.sourceById.get(evidence.sourceRefId);
    if (!sourceRef?.evidenceIds.includes(evidence.id)) {
      throwGroundingError(
        "DEMO_EVIDENCE_ID_NOT_IN_SOURCE",
        `Evidence id not listed in sourceRef.evidenceIds: ${article.id} -> ${evidence.id}`
      );
    }
  }
}

function assertPersonaGrounding(persona: DemoPersona, index: GroundingIndex): void {
  if (persona.boundaryNotice !== DEMO_PERSONA_BOUNDARY_NOTICE) {
    throwGroundingError(
      "DEMO_PERSONA_BOUNDARY_REQUIRED",
      `Persona has invalid boundaryNotice: ${persona.id}`
    );
  }

  if (!index.personIds.has(persona.personId)) {
    throwGroundingError(
      "DEMO_PERSONA_PERSON_REF_INVALID",
      `Persona personId not found: ${persona.id}`
    );
  }

  if (!persona.sourceRefs.length) {
    throwGroundingError(
      "DEMO_PERSONA_SOURCE_REFS_REQUIRED",
      `Persona missing sourceRefs: ${persona.id}`
    );
  }

  assertSourceRefsExist("persona", persona.id, persona.sourceRefs, index);
}

function assertSectionRefs(section: DemoSection, index: GroundingIndex): void {
  const validIds = getSectionValidIds(section, index);

  for (const itemRef of section.itemRefs) {
    if (!validIds.has(itemRef)) {
      throwGroundingError(
        "DEMO_SECTION_ITEM_REF_INVALID",
        `Section itemRef not found: ${section.id} -> ${itemRef}`
      );
    }
  }
}

function getSectionValidIds(section: DemoSection, index: GroundingIndex): Set<string> {
  if (section.type === "paths") {
    return index.pathIds;
  }

  if (section.type === "people") {
    return index.personIds;
  }

  if (section.type === "personas") {
    return index.personaIds;
  }

  return new Set([section.id]);
}

function assertHasRefs(
  kind: "path" | "person",
  id: string,
  item: Pick<DemoPath | DemoPerson, "evidenceIds" | "sourceRefs">
): void {
  if (item.evidenceIds.length === 0 || item.sourceRefs.length === 0) {
    throwGroundingError(
      "DEMO_GROUNDING_REQUIRED",
      `${kind} missing evidenceIds/sourceRefs: ${id}`
    );
  }
}

function assertSourceRefsExist(
  kind: string,
  id: string,
  sourceRefs: string[],
  index: GroundingIndex
): void {
  if (sourceRefs.length === 0) {
    throwGroundingError("DEMO_SOURCE_REFS_REQUIRED", `${kind} missing sourceRefs: ${id}`);
  }

  for (const sourceRef of sourceRefs) {
    if (!index.sourceById.has(sourceRef)) {
      throwGroundingError(
        "DEMO_SOURCE_REF_INVALID",
        `${kind} sourceRef not found in meta.sourceRefs: ${id} -> ${sourceRef}`
      );
    }
  }
}

function assertEvidenceIdsResolvable(
  kind: string,
  id: string,
  evidenceIds: string[],
  sourceRefs: string[],
  index: GroundingIndex,
  articleEvidenceIds = new Set<string>()
): void {
  const sourceEvidenceIds = new Set<string>();
  for (const sourceRefId of sourceRefs) {
    const sourceRef = index.sourceById.get(sourceRefId);
    for (const evidenceId of sourceRef?.evidenceIds ?? []) {
      sourceEvidenceIds.add(evidenceId);
    }
  }

  for (const evidenceId of evidenceIds) {
    if (!sourceEvidenceIds.has(evidenceId) && !articleEvidenceIds.has(evidenceId)) {
      throwGroundingError(
        "DEMO_EVIDENCE_REF_INVALID",
        `${kind} evidenceId not found in source or article evidence: ${id} -> ${evidenceId}`
      );
    }
  }
}

function throwGroundingError(code: string, message: string): never {
  throw new HttpError(500, code, message);
}
