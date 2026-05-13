import type { DemoSearchResponse } from "../types/demo.types.js";

const MAX_CACHED_DEMO_SESSIONS = 50;

interface CachedDemoSession {
  queryId: string;
  storedAt: number;
  response: DemoSearchResponse;
}

export class DemoSessionCacheService {
  private readonly sessions = new Map<string, CachedDemoSession>();

  set(response: DemoSearchResponse): void {
    if (!response.queryId) {
      return;
    }

    this.sessions.set(response.queryId, {
      queryId: response.queryId,
      storedAt: Date.now(),
      response: cloneResponse(response)
    });
    this.trim();
  }

  get(queryId: string): DemoSearchResponse | undefined {
    const cached = this.sessions.get(queryId);
    if (!cached) {
      return undefined;
    }

    this.sessions.delete(queryId);
    this.sessions.set(queryId, cached);
    return cloneResponse(cached.response);
  }

  private trim(): void {
    while (this.sessions.size > MAX_CACHED_DEMO_SESSIONS) {
      const oldestKey = this.sessions.keys().next().value;
      if (!oldestKey) {
        return;
      }

      this.sessions.delete(oldestKey);
    }
  }
}

export const demoSessionCacheService = new DemoSessionCacheService();

function cloneResponse(response: DemoSearchResponse): DemoSearchResponse {
  return JSON.parse(JSON.stringify(response)) as DemoSearchResponse;
}
