import type { SearchResult } from "../../types/api.types.js";

export interface ZhihuSearchParams {
  query: string;
  count: number;
}

export interface ZhihuSearchRawResponse {
  Code?: number | string;
  Message?: string;
  Data?: unknown;
  [key: string]: unknown;
}

export interface ZhihuRawContentItem {
  Title?: unknown;
  ContentType?: unknown;
  ContentID?: unknown;
  ContentText?: unknown;
  Url?: unknown;
  CommentCount?: unknown;
  VoteUpCount?: unknown;
  AuthorName?: unknown;
  AuthorAvatar?: unknown;
  AuthorBadge?: unknown;
  AuthorBadgeText?: unknown;
  EditTime?: unknown;
  AuthorityLevel?: unknown;
  RankingScore?: unknown;
  Comments?: unknown;
  [key: string]: unknown;
}

export type ZhihuMappedSearchResult = SearchResult;
