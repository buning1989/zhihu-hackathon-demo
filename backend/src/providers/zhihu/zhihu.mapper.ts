import type { SearchItem, SearchResult } from "../../types/api.types.js";
import type { ZhihuRawContentItem, ZhihuSearchRawResponse } from "./zhihu.types.js";

export function mapZhihuSearchResponse(
  query: string,
  count: number,
  rawResponse: ZhihuSearchRawResponse
): SearchResult {
  const data = asRecord(rawResponse.Data);
  const rawItems = extractRawItems(rawResponse.Data);

  return {
    query,
    count,
    hasMore: toBoolean(readValue(data, ["HasMore", "hasMore"]), false),
    searchHashId: toStringValue(
      readValue(data, ["SearchHashId", "SearchHashID", "searchHashId", "search_hash_id"])
    ),
    items: rawItems.map(mapZhihuItem)
  };
}

function mapZhihuItem(item: ZhihuRawContentItem, index: number): SearchItem {
  const id = toStringValue(
    readValue(item, ["ContentID", "ContentId", "contentId", "content_id", "id"])
  );
  const url = toStringValue(readValue(item, ["Url", "URL", "url"]));
  const text = toStringValue(
    readValue(item, ["ContentText", "contentText", "content_text", "text", "excerpt"])
  );
  const comments = readValue(item, ["Comments", "comments", "CommentInfoList", "commentInfoList"]);
  const source = {
    provider: "zhihu" as const,
    url
  };

  return {
    id: id || `zhihu_item_${index + 1}`,
    type: toStringValue(readValue(item, ["ContentType", "contentType", "content_type", "type"])),
    title: toStringValue(readValue(item, ["Title", "title"])),
    text,
    url,
    author: {
      name: toStringValue(readValue(item, ["AuthorName", "authorName", "author_name"])),
      avatar: toStringValue(readValue(item, ["AuthorAvatar", "authorAvatar", "author_avatar"])),
      badge: toStringValue(readValue(item, ["AuthorBadge", "authorBadge", "author_badge"])),
      badgeText: toStringValue(
        readValue(item, ["AuthorBadgeText", "authorBadgeText", "author_badge_text"])
      )
    },
    stats: {
      commentCount: toNumber(readValue(item, ["CommentCount", "commentCount", "comment_count"])),
      voteUpCount: toNumber(readValue(item, ["VoteUpCount", "voteUpCount", "vote_up_count"])),
      rankingScore: toNumber(readValue(item, ["RankingScore", "rankingScore", "ranking_score"]))
    },
    comments: Array.isArray(comments) ? comments : [],
    editTime: toNumber(readValue(item, ["EditTime", "editTime", "edit_time"])),
    authorityLevel: toStringValue(
      readValue(item, ["AuthorityLevel", "authorityLevel", "authority_level"])
    ),
    source,
    evidence: {
      text,
      source
    }
  };
}

function extractRawItems(data: unknown): ZhihuRawContentItem[] {
  if (Array.isArray(data)) {
    return data.filter(isRecord);
  }

  const record = asRecord(data);
  if (!record) {
    return [];
  }

  for (const key of [
    "Items",
    "items",
    "Results",
    "results",
    "SearchResults",
    "searchResults",
    "SearchResult",
    "searchResult",
    "SearchResultList",
    "searchResultList",
    "Contents",
    "contents",
    "List",
    "list",
    "Data",
    "data"
  ]) {
    const value = record[key];
    if (Array.isArray(value)) {
      return value.filter(isRecord);
    }

    const nestedItems = extractRawItems(value);
    if (nestedItems.length > 0) {
      return nestedItems;
    }
  }

  const firstContentArray = Object.values(record).find(
    (value) => Array.isArray(value) && value.some(looksLikeZhihuItem)
  );

  return Array.isArray(firstContentArray) ? firstContentArray.filter(isRecord) : [];
}

function looksLikeZhihuItem(value: unknown): boolean {
  const record = asRecord(value);
  return Boolean(
    record &&
      (readValue(record, ["ContentID", "ContentId", "contentId", "id"]) ||
        readValue(record, ["ContentText", "contentText", "text", "excerpt"]) ||
        readValue(record, ["Title", "title"]))
  );
}

function readValue(record: Record<string, unknown> | undefined, keys: string[]): unknown {
  if (!record) {
    return undefined;
  }

  for (const key of keys) {
    if (key in record) {
      return record[key];
    }
  }

  return undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toStringValue(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }

  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }

  return "";
}

function toNumber(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === "string") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }

  return 0;
}

function toBoolean(value: unknown, fallback: boolean): boolean {
  if (typeof value === "boolean") {
    return value;
  }

  return fallback;
}
