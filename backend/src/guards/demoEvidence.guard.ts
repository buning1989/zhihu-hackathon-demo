import {
  DEMO_PERSONA_BOUNDARY_NOTICE,
  type DemoPath,
  type DemoPerson,
  type DemoPersona,
  type DemoSearchResponse
} from "../types/demo.types.js";
import { HttpError } from "../utils/httpError.js";

export function assertDemoSearchGrounding(data: DemoSearchResponse): void {
  for (const path of data.paths) {
    assertHasRefs("path", path.id, path);
  }

  for (const person of data.people) {
    assertPersonGrounding(person);
  }

  for (const persona of data.personas) {
    assertPersonaGrounding(persona);
  }
}

function assertPersonGrounding(person: DemoPerson): void {
  assertHasRefs("person", person.id, person);

  if (person.articles.length === 0) {
    throwGroundingError("DEMO_PERSON_ARTICLES_REQUIRED", `Person has no articles: ${person.id}`);
  }

  for (const article of person.articles) {
    if (article.evidence.length === 0 || article.sourceRefs.length === 0) {
      throwGroundingError(
        "DEMO_ARTICLE_GROUNDING_REQUIRED",
        `Article missing evidence/sourceRefs: ${article.id}`
      );
    }
  }

  if (!person.aiPersona.grounding.sourceRefs.length) {
    throwGroundingError(
      "DEMO_PERSONA_GROUNDING_REQUIRED",
      `Person aiPersona missing grounding sourceRefs: ${person.id}`
    );
  }
}

function assertPersonaGrounding(persona: DemoPersona): void {
  if (persona.boundaryNotice !== DEMO_PERSONA_BOUNDARY_NOTICE) {
    throwGroundingError(
      "DEMO_PERSONA_BOUNDARY_REQUIRED",
      `Persona has invalid boundaryNotice: ${persona.id}`
    );
  }

  if (!persona.sourceRefs.length) {
    throwGroundingError(
      "DEMO_PERSONA_SOURCE_REFS_REQUIRED",
      `Persona missing sourceRefs: ${persona.id}`
    );
  }
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

function throwGroundingError(code: string, message: string): never {
  throw new HttpError(500, code, message);
}
