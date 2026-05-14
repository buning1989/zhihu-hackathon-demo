export interface ApiSuccessResponse<T> {
  success: true;
  data: T;
}

export interface ApiErrorResponse {
  success: false;
  error: {
    code: string;
    message: string;
  };
}

export type ApiResponse<T> = ApiSuccessResponse<T> | ApiErrorResponse;

export interface HealthResponse {
  status: "ok";
  service: "zhihu-hackathon-backend";
}

export interface SearchAuthor {
  name: string;
  avatar: string;
  badge: string;
  badgeText: string;
}

export interface SearchStats {
  commentCount: number;
  voteUpCount: number;
  rankingScore: number;
}

export interface SearchSource {
  provider: "zhihu";
  url: string;
}

export interface SearchEvidence {
  text: string;
  source: SearchSource;
}

export interface SearchMatchedQuery {
  query: string;
  type?: string;
  purpose?: string;
}

export interface SearchItem {
  id: string;
  type: string;
  title: string;
  text: string;
  url: string;
  matchedQuery?: string;
  queryType?: string;
  queryPurpose?: string;
  matchedQueries?: SearchMatchedQuery[];
  roughScore?: number;
  relevanceScore?: number;
  contentRole?: string;
  relationToUserIntent?: string;
  summaryAngle?: string;
  diversityKey?: string;
  keepReason?: string;
  author: SearchAuthor;
  stats: SearchStats;
  comments: unknown[];
  editTime: number;
  authorityLevel: string;
  source: SearchSource;
  evidence: SearchEvidence;
}

export interface SearchResult {
  query: string;
  count: number;
  hasMore: boolean;
  searchHashId: string;
  items: SearchItem[];
}
