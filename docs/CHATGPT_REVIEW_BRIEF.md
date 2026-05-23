# ChatGPT Review Brief

Date: 2026-05-23
Branch: `deploy/static-mock-demo`
Repository: `https://github.com/buning1989/zhihu-hackathon-demo`

This note is for code review and product/architecture review. The goal is to help a reviewer understand the current Agent system, what already runs, and what is still missing before it can become a real production Agent product.

## Current Positioning

The current product has been narrowed from a broad "AI persona" concept to a safer Agent demo for public content discovery and evidence-based sample navigation.

The production Agent result contract is:

- `agent.production_final_result.v2`
- Stable display fields: `summary`, `paths`, `evidenceSamples`, `sources`, `evidenceMap`, `groundingReport`, `degraded`, `warnings`
- `paths[]` are search angles or sample directions, not complete life-path models.
- `evidenceSamples[]` are deterministic display cards derived from evidence items.
- AI organizes public content and evidence; it is not treated as a factual source.
- The frontend currently disables persona chat for production evidence samples.

## Current Running State

The local Docker Compose stack has been verified with:

```bash
docker compose -f infra/docker-compose.yml ps
npm run build -w backend
npm run smoke
```

Observed local services:

- `backend` on port `8000`
- `frontend` on port `3000`
- `agent-worker`
- `postgres`
- `redis`

`npm run smoke` passed on 2026-05-23. It covered:

- `GET /health`
- `GET /api/health`
- frontend homepage
- five Agent production task flows
- `need_input` clarification
- `POST /api/agent/tasks/:taskId/refine`
- `GET /api/agent/tasks/:taskId/result`
- `agent.production_final_result.v2`
- debug endpoint basics
- succeeded/running task reuse checks

Rate limit smoke was skipped because `AGENT_RATE_LIMIT_ENABLED=false`.

## Main Agent Flow

Primary user-facing flow:

1. Frontend calls `POST /api/agent/tasks`.
2. Backend creates a persistent task in Postgres.
3. Backend enqueues a BullMQ job in Redis.
4. `agent-worker` runs the staged workflow.
5. Frontend polls `GET /api/agent/tasks/:taskId`.
6. Frontend reads `GET /api/agent/tasks/:taskId/result`, with fallback to `/view` when needed.

Stage workflow:

1. `understand_goal_rule`
2. `plan_search_llm`
3. `retrieve_sources`
4. `normalize_candidates`
5. `evidence_extract_llm`
6. `response_compose_llm`
7. `grounding_guard_llm`
8. deterministic production result builder writes `production_final_result`

## Important Files For Review

Start with:

- `README.md`
- `docs/AI_HANDOFF.md`
- `shared/openapi.yaml`
- `.env.example`
- `infra/docker-compose.yml`

Backend Agent:

- `backend/src/routes/agent.routes.ts`
- `backend/src/agent/stages/agentStageExecutor.ts`
- `backend/src/agent/agentProductionResult.ts`
- `backend/src/agent/agentRepository.ts`
- `backend/src/agent/agentQueue.ts`
- `backend/src/agent/agentWorker.ts`
- `backend/src/agent/agentTaskDebug.ts`
- `backend/src/agent/agentTaskApi.ts`
- `backend/src/agent/agentClarification.ts`

Agent stages:

- `backend/src/agent/stages/understandGoalRuleStage.ts`
- `backend/src/agent/stages/planSearchLlmStage.ts`
- `backend/src/agent/stages/retrieveSourcesStage.ts`
- `backend/src/agent/stages/normalizeCandidatesStage.ts`
- `backend/src/agent/stages/evidenceExtractLlmStage.ts`
- `backend/src/agent/stages/responseComposeLlmStage.ts`
- `backend/src/agent/stages/groundingGuardLlmStage.ts`

Frontend Agent integration:

- `frontend/app.js`
- `frontend/services/api.js`
- `frontend/services/adapter.js`
- `frontend/components/clarifyCard.js`
- `frontend/debug/agent/index.html`

Validation scripts:

- `scripts/smoke-test.sh`
- `backend/scripts/smoke-agent-production.mjs`
- `backend/scripts/eval-agent-production.mjs`
- `backend/scripts/spotcheck-agent-production-real.mjs`

## Known Gaps Before A Real Production Agent

The main gap is not that the Agent chain is missing. The gap is that the current system is still a local/demo runtime and needs production hardening.

1. Deployment topology is not productionized.
   The Agent needs backend, worker, Postgres, Redis, migrations, health checks, restart policy, and log/metric collection as one deployable system.

2. Real LLM mode is not the default.
   `.env.example` defaults to `AGENT_LLM_ENABLED=false` and `AGENT_LLM_TEST_MODE=mock`. Real Agent intelligence requires consistent backend and worker config for DeepSeek or Kimi.

3. Real Zhihu retrieval depends on secret configuration.
   Without `ZH_ACCESS_SECRET` or `ZHIHU_API_KEY`, `retrieve_sources` falls back to deterministic mock sources. Passing smoke does not prove real retrieval quality.

4. Source retrieval is still narrow.
   `retrieve_sources` selects expanded queries but currently searches the first selected query. A production content discovery system needs multi-query retrieval, merge, dedupe, and quality ranking across all high-value search angles.

5. Worker reliability is minimal.
   BullMQ jobs currently use `attempts: 1`. There is no dead-letter queue, retry policy, worker crash recovery review, stuck-task repair, or admin re-run operation.

6. Observability is useful but local/debug-oriented.
   The code has `/debug`, stage events, artifact summaries, and eval scripts, but no production dashboard, alerting, durable metrics, or operational runbook.

7. Rate limiting is implemented but disabled by default.
   `AGENT_RATE_LIMIT_ENABLED=false` in the demo path. Production needs an explicit policy for anonymous and logged-in users.

8. The frontend is still a static demo.
   It uses polling and static JS. It does not yet provide a full product shell for task history, durable user state, streaming updates, admin debug views, or complete multi-turn clarification.

9. Persona chat is intentionally out of the production v2 surface.
   The current production result is evidence/sample navigation. It should not be reviewed as if it already delivers a full AI persona conversation product.

10. Documentation has some stale phrasing.
    For example, README still mentions rendering `guarded_final_result` in one place, while the current main contract is `agent.production_final_result.v2`.

## Recent Frontend Fallback Change

`frontend/services/api.js` now retries local backend requests when a configured API base returns:

- `AGENT_DATABASE_UNCONFIGURED`
- `AGENT_QUEUE_UNCONFIGURED`

For local demo ports (`3000`, `3001`, `5173`, or `file:`), it retries `http://localhost:8000` and clears `lifeSampleApiBaseUrl` from localStorage after a successful retry.

Please review this behavior for:

- whether clearing localStorage is too surprising;
- whether retry should be limited to task endpoints;
- whether CORS or credential behavior is correct for remote previews;
- whether the UI should show a clearer recovery message.

## Review Questions

Please focus the review on:

1. Does the Agent task lifecycle have correctness holes around queueing, task reuse, failures, and result availability?
2. Is the v2 result schema stable and frontend-friendly enough for the next iteration?
3. Are evidence grounding and deterministic validation strict enough to prevent unsupported claims?
4. What is the shortest path from the current local demo to a real deployed Agent runtime?
5. Which gaps should be fixed before adding more product surface area?
6. Are there security or privacy risks in task metadata, debug output, OAuth/session handling, or frontend localStorage behavior?
7. Which docs are stale or misleading enough to block a clean handoff?

## Out Of Scope For This Review

- Do not treat old FastAPI docs as the current implementation.
- Do not assume `/api/v1/match/query` is the current main product route.
- Do not review `backend/dist`, `node_modules`, `.env`, or local generated files.
- Do not expect committed real API keys or secrets.
