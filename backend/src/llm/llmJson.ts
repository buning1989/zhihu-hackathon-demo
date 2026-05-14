export type LlmJsonParseResult =
  | {
      ok: true;
      data: unknown;
      repaired: boolean;
    }
  | {
      ok: false;
      error: string;
    };

export function parseLlmJson(text: string): LlmJsonParseResult {
  const trimmed = text.trim();
  if (!trimmed) {
    return {
      ok: false,
      error: "empty JSON response"
    };
  }

  const direct = tryParseJson(trimmed);
  if (direct.ok) {
    return {
      ok: true,
      data: direct.data,
      repaired: false
    };
  }

  const repairedText = repairJsonText(trimmed);
  if (repairedText !== trimmed) {
    const repaired = tryParseJson(repairedText);
    if (repaired.ok) {
      return {
        ok: true,
        data: repaired.data,
        repaired: true
      };
    }
  }

  return {
    ok: false,
    error: direct.error
  };
}

function repairJsonText(text: string): string {
  const unfenced = stripMarkdownFence(text);
  const sliced = sliceJsonCandidate(unfenced);

  return sliced
    .replace(/[\u201c\u201d]/g, "\"")
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/,\s*([}\]])/g, "$1")
    .trim();
}

function stripMarkdownFence(text: string): string {
  const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  return fenceMatch ? fenceMatch[1].trim() : text;
}

function sliceJsonCandidate(text: string): string {
  const objectStart = text.indexOf("{");
  const arrayStart = text.indexOf("[");
  const starts = [objectStart, arrayStart].filter((index) => index >= 0);
  if (starts.length === 0) {
    return text;
  }

  const start = Math.min(...starts);
  const objectEnd = text.lastIndexOf("}");
  const arrayEnd = text.lastIndexOf("]");
  const end = Math.max(objectEnd, arrayEnd);

  return end > start ? text.slice(start, end + 1) : text.slice(start);
}

function tryParseJson(text: string): { ok: true; data: unknown } | { ok: false; error: string } {
  try {
    return {
      ok: true,
      data: JSON.parse(text)
    };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : "invalid JSON"
    };
  }
}
