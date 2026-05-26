import { mapZhihuSearchResponse } from "../providers/zhihu/zhihu.mapper.js";
import { zhihuProvider } from "../providers/zhihu/zhihu.provider.js";
import type { ZhihuSearchOptions } from "../providers/zhihu/zhihu.types.js";
import type { SearchResult } from "../types/api.types.js";
import { HttpError } from "../utils/httpError.js";

export class SearchService {
  async search(
    query: string,
    count: number,
    options?: ZhihuSearchOptions
  ): Promise<SearchResult> {
    const normalizedQuery = query.trim();

    if (!normalizedQuery) {
      throw new HttpError(400, "QUERY_REQUIRED", "Missing required query parameter: query");
    }

    const rawResponse = await zhihuProvider.searchRaw({
      query: normalizedQuery,
      count
    }, options);

    return mapZhihuSearchResponse(normalizedQuery, count, rawResponse);
  }
}

export const searchService = new SearchService();
