# AI Handoff

## 2026-05-22 - Agent production Phase 5 minimal clarify loop

本轮目标：只做 Phase 5 第一轮 clarify/refine 后端闭环；不做前端 UI、完整多轮 Agent 或长期用户画像。

已完成：

- `POST /api/agent/tasks` 在高模糊问题上进入 `need_input`，返回最多 3 个结构化 single-select clarification questions 和 optional freeText 入口；清晰问题继续直接入队执行。
- clarify 判断只覆盖高模糊短问法，例如“我要不要离职？”“要不要分手？”“要不要回老家？”“要不要考研？”“我现在很迷茫怎么办？”，避免误拦截已带场景的问题。
- 新增 `POST /api/agent/tasks/:taskId/refine`：不覆盖旧 task，创建新的 refined task，记录 `refinedFromTaskId`，合并原问题、结构化答案和 `refineQuery` 后重新走完整 Agent 链路。
- refined task 的 cache identity 纳入 refined metadata/answer hash，避免复用原始模糊 query 的结果；optional freeText 只保存 hash/length，不在 debug 中暴露明文。
- production smoke 增加 clear query 直跑、vague query `need_input`、refine 后成功、refined cache key 不同和 freeText debug 脱敏校验。

验证建议：

- `git diff --check`
- `npm run build -w backend`
- `FRONTEND_PORT=3001 npm run smoke`
- `EVAL_AGENT_PRODUCTION_FRESH=true AGENT_LLM_ENABLED=true AGENT_LLM_TEST_MODE=real npm run eval:agent-production -w backend`

## 2026-05-22 - Agent production Phase 4.2 grounding repair convergence

本轮目标：只修 Phase 4.2 的 `grounding_guard_repaired` 原因收敛；不进入 Phase 5，不做前端 UI、信息补充卡或后台。

已完成：

- `response_compose_llm` 改为更明确的“样本归纳”输出约束：path summary 必须围绕有人选择了什么、当时约束、后来代价/结果、不能推出什么；禁止泛建议、强建议语气和方法论式标题。
- 自我状态、低谷、焦虑、内耗类问题只整理公开经历样本；不输出心理治疗、诊断、药物、咨询师或医疗建议。证据弱时减少 paths/personas。
- `grounding_guard_llm` 区分 `hardRepairReasons` 和 `softWarningReasons`：只有删除 path/person、修复 evidenceIds/candidateIds/source refs、fallback/partial 等硬修复才进入 degraded；普通 warning 不再直接导致 `degraded=true`。
- debug/eval 输出并汇总 `groundingHardRepairReasonCounts`、`groundingSoftWarningReasonCounts`、`groundingRepairedReasonCounts`，可区分 `path_summary_overgeneralized`、`persona_evidence_insufficient`、`evidence_support_weak`、`source_refs_repaired`、`llm_guard_overconservative`、`self_state_lacks_experience_evidence` 等原因。
- grounding guard JSON 预算提高到 2600 tokens，并要求完整 JSON，降低 guard fallback 风险；不放松 sourceRefs、persona 真实经历 evidence 或 deterministic validator。
- Agent cache `promptVersion` 更新到 Phase 4.2 版本，避免复用 Phase 4.1 的 final result cache。

最新真实 LLM fresh eval 摘要：30/30 succeeded，`avgEvidence=3.9`、`avgPaths=2.2`、`avgPersonas=1.733`、`degradedRate=0.367`、`groundingPassedRate=0.967`、`badRefsCount=0`，evidence chunk failure/repair/retry 均为 0。自我状态类 surface 文案抽查未发现医疗/心理治疗或强建议表达。

剩余风险：`llmGuardStatus=fallback` 仍有 1/30，`deterministic_validator_repaired` 1/30；弱证据和自我状态类问题仍会因 `evidence_support_weak`、`path_summary_overgeneralized` 或 `source_refs_repaired` 保守降级。

## 2026-05-22 - Agent production Phase 4.1 LLM evidence stability

本轮目标：只修 Phase 4.1 的真实 LLM evidence 抽取稳定性；不进入 Phase 5，不做前端 UI、信息补充卡或后台。

已完成：

- `evidence_extract_llm` 改为按 2 个 candidate 一片分片调用，每片最多抽 2 条 evidence，最终仍受全局 evidence 上限约束。
- evidence prompt 改为极简 JSON，要求短 `evidenceText/excerpt/normalizedClaim`，不再要求 LLM 重复输出 title/author/sourceUrl/reason，后端按 candidate 补齐。
- LLM 成功但片内遗漏合格 candidate 时，后端会用该 candidate 的原始 excerpt 做保守 evidence backfill；仍只覆盖已 `selectedForEvidence`、quality/relevance 过线的候选，且不突破全局 evidence 上限。
- 片级 JSON parse/schema 失败时先尝试从 rawText 修复完整 evidence item；仍失败则该片重试一次。单片失败会落到该片 fallback evidence，不再导致整 stage fallback。
- evidence `qualityReport` 增加 `chunkCount/chunkSuccessCount/chunkFailureCount/repairCount/retryCount/chunkFailureReasons`，debug/eval 会输出这些指标。
- Agent cache identity 纳入 `AGENT_LLM_ENABLED`、`AGENT_LLM_TEST_MODE`、provider/model、promptVersion 和 evidence extraction version，避免 LLM off/on 或新旧 evidence prompt 复用旧结果。
- eval runner 增加 `EVAL_AGENT_PRODUCTION_FRESH=true`，可用唯一 metadata 绕开 task reuse；summary 增加 evidence chunk failure/repair/retry 和 grounding reason 分布。

验证建议：

- `git diff --check`
- `npm run build -w backend`
- `FRONTEND_PORT=3001 npm run smoke`
- `AGENT_LLM_ENABLED=true AGENT_LLM_TEST_MODE=real EVAL_AGENT_PRODUCTION_FRESH=true EVAL_AGENT_PRODUCTION_TIMEOUT_MS=240000 npm run eval:agent-production -w backend`

最新真实 LLM fresh eval 摘要：30/30 succeeded，`avgEvidence=3.867`、`avgPaths=2.2`、`avgPersonas=1.733`、`degradedRate=0.9`、`groundingPassedRate=0.933`、`badRefsCount=0`，evidence chunk failure/repair/retry 均为 0。剩余 degraded 主要来自 `grounding_guard_repaired`，尤其是自我低谷类问题的真实经历证据较弱。

## 2026-05-22 - Agent production Phase 4 observability eval debug loop

本轮目标：只执行 Phase 4 的观测、评估、debug 最小闭环；不做完整管理后台、图表页面、前端 UI 或 Phase 5 信息补充卡。

已完成：

- 新增 `GET /api/agent/tasks/:taskId/debug`，仅非 production 环境开放，返回 task、stages、events、artifacts summary、raw_sources/candidates/evidence/final_result summary、groundingReport、errorCode/errorMessage 和 failedStage。
- debug 输出只保留短 preview/计数/ID/分数，不返回大段 source/evidence 原文；metadata/event payload 会过滤 anonymousId/IP/token/cookie/authorization/secret/actorHash 等字段。
- task reuse 时写入 best-effort `task.reused` event；stage artifact cache hit 已可在 debug 的 cache summary 和 stage cacheHit 中定位。
- 新增 `backend/scripts/eval-agent-production.mjs`，默认跑 30 个固定问题，覆盖职业、学业、亲密关系、城市生活、婚育家庭、自我低谷，并输出每题质量指标与最终 summary。
- production smoke 增加 debug endpoint 结构和敏感 metadata 泄露检查。
- `shared/openapi.yaml` 补充 Phase 4 debug endpoint 和 Phase 3 create response 的 `cacheHit/reused` 字段。

验证建议：

- `git diff --check`
- `npm run build -w backend`
- `FRONTEND_PORT=3001 npm run smoke`
- 有真实知乎 key 时执行 `npm run eval:agent-production -w backend`

## 2026-05-22 - Agent production Phase 3 cost cache and limits

本轮目标：只执行 Phase 3 的成本、缓存、限流；不进入观测后台、信息补充卡或前端 UI。

已完成：

- task 创建时生成 `queryCacheKey`，key 包含 normalized query、metadata hash、dataMode/provider、cache schema、promptVersion、scoringVersion；不保存 anonymousId/IP 明文。
- 相同 `queryCacheKey` 若已有 running task，会直接返回 existing `taskId`；若有 TTL 内 succeeded task，会返回 existing result task，并标记 `cacheHit/reused`。
- stage workflow 会复用 TTL 内的 `raw_sources`、`candidates`、`evidence` artifacts；缓存 miss 或读取失败不影响主链路。
- 最小限流：anonymous 默认每小时 3 次、最多 1 个 active task；登录用户默认每天 20 次、最多 2 个 active task。可用环境变量 `AGENT_LIMIT_*` 放宽。
- 单任务预算写入 task metadata，并在现有链路约束 search query、source candidates、selected evidence 和 evidence source 数量。
- production smoke 增加 succeeded cache reuse、running task reuse 和 RATE_LIMITED 校验。

验证建议：

- `git diff --check`
- `npm run build -w backend`
- `FRONTEND_PORT=3001 npm run smoke`
- 有真实知乎 key 时执行 `node backend/scripts/spotcheck-agent-production-real.mjs`

## 2026-05-22 - Agent production Phase 2.1 real score normalization

本轮目标：修正真实知乎搜索返回 `score` 量级过低导致 `selectedForEvidence=0` 的问题；不进入 Phase 3，不做缓存限流、后台或前端 UI。

已完成：

- `normalize_candidates` 不再用 raw `source.score > 0.5` 作为前置硬门槛；真实 `Answer` 会先进入质量评分。
- candidate 增加 `normalizedSearchScore`，同一批候选按 rank 归一化，raw score 只作为 relevance 的弱辅助信号。
- `relevanceScore` 改为主要看 query 关键词在 title/excerpt 的命中和 rank-based score。
- `qualityScore` 综合 `relevanceScore / experienceScore / 内容长度 / normalizedSearchScore / 来源完整度 / 低质量惩罚`。
- `selectedForEvidence` 加入 evidence 预算上限，超出 Top N 的候选标记 `not_selected_budget_limit`，不扩大 evidence 抽取成本。
- 新增 `backend/scripts/spotcheck-agent-production-real.mjs`，用于真实搜索配置下创建 8 个 Agent task 并汇总 sources、selected、score、evidence、paths/personas、grounding 指标。

验证建议：

- `git diff --check`
- `npm run build -w backend`
- `FRONTEND_PORT=3001 npm run smoke`
- 在 compose 已读取真实 `ZH_ACCESS_SECRET` 时执行 `node backend/scripts/spotcheck-agent-production-real.mjs`

## 2026-05-22 - Agent production Phase 2 quality grounding

本轮目标：只执行 Phase 2 的质量和证据增强；不做缓存限流、观测后台、信息补充卡、前端 UI，也不新增数据库表。

已完成：

- `normalize_candidates` 为 candidate 增加 `relevanceScore / experienceScore / qualityScore / qualitySignals / selectedForEvidence / rejectReason`，低质量、营销导流、过短或无法绑定来源的候选不会进入 evidence 抽取。
- `evidence_extract_llm` 只处理 `selectedForEvidence=true` 的候选，并为每条 evidence 补齐稳定 `id`、`sourceCandidateId`、`supportType`、`isExperienceEvidence`、`excerpt`、`normalizedClaim` 和 confidence。
- `grounding_guard_llm` 增加 deterministic quality report，记录低质量 candidate、低置信 evidence、缺少真实经历 evidence 的 persona。
- `production_final_result` validator 增加硬规则：sourceRefs/evidence 归属必须一致，candidate 质量必须达标，persona 必须有真实经历 evidence；证据不足时移除 path/persona 并标记 degraded。
- `smoke-agent-production.mjs` 扩展质量校验：检查 candidate 分数、evidence 字段、persona 真实经历证据、deterministic quality report 和 bad refs。

验证建议：

- `git diff --check`
- `npm run build -w backend`
- 在 Postgres、Redis、backend、agent-worker、frontend 都运行时执行 `FRONTEND_PORT=3001 npm run smoke`

## 2026-05-22 - Agent production Phase 1 minimal loop

本轮目标：按 `codex-agent-production-phase1.md` 只执行 Phase 1，将持久化 Agent demo 链路补成生产链路最小闭环；不做 Phase 2-5，不新增 WebSocket/SSE、管理后台、长期用户画像或多平台内容源。

已完成：

- `POST /api/agent/tasks` 返回 `taskId/status/frontendStatus/pollAfterMs/resultUrl`，创建 task 后入 BullMQ，并把 task 标准化到 `created -> queued -> running/partial_ready -> succeeded/failed`。
- `GET /api/agent/tasks/:taskId` 返回产品化状态、阶段进度、partial/result 可用性、degraded 信息和结构化错误。
- 新增 `GET /api/agent/tasks/:taskId/result`，未完成返回 202，完成后返回 `final_result`。
- worker 在 grounding 后写入 `production_final_result` artifact，包含 `summary/paths/personas/sources/evidenceMap/groundingReport/degraded`。
- 新增 deterministic sourceRefs validator：无证据或引用不存在的 path/persona 会被移除，最终 succeeded 结果不保留无 `sourceRefs` 的 path/persona。
- `retrieve_sources` 真实搜索失败时最多尝试 3 次，再降级到 deterministic mock sources。
- 新增 `backend/scripts/smoke-agent-production.mjs`，root `npm run smoke` 会覆盖 5 个 Phase 1 固定问题的 task 创建、轮询、result schema 和 sourceRefs 校验。
- 更新 `shared/openapi.yaml` 和 README 中的 Agent Phase 1 契约/验收说明。

验证建议：

- `npm run build -w backend`
- 在 Postgres、Redis、backend、agent-worker、frontend 都运行时执行 `npm run smoke`

本地验证记录：

- `npm run build -w backend` 通过。
- `git diff --check` 通过。
- production final_result validator 的最小 Node 校验通过。
- `npm run smoke` 已运行到 Agent Phase 1 检查，因当前环境缺少 `DATABASE_URL` 且 Docker daemon 未运行，无法启动 Postgres/Redis，返回 `AGENT_DATABASE_UNCONFIGURED`。

## 2026-05-22 - Frontend v2 architecture constraints

本轮目标：执行 GitHub Issue #2，只更新前端 v2 架构约束和 Codex 执行说明，不开始前端实现，不修改后端代码。

已完成：

- 新增 `docs/frontend/frontend-v2-architecture.md`，明确前端 v2 验证版采用原生 HTML/CSS/JS 模块化，不继续堆单文件 `frontend/index.html`，暂不引入 React / Vue / Vite。
- 新增 `docs/tasks/frontend-v2-refactor-codex.md`，记录后续 Codex 执行前端 v2 重构时的目标、范围、推荐结构、产品主链路、架构约束、禁止事项和验收方式。
- 明确本阶段使用 mock 登录和 mock AI 分身回复，不接真实 OAuth、真实 LLM、`/api/demo/search` 或 `/api/personas/chat`。
- 明确本轮不修改 `backend/`，不重构 `frontend/` 实现代码。

验证记录：

- `git diff --check` 通过。
- `npm run build -w backend` 通过。

## 2026-05-14 - Visible persistent Agent product loop

本轮目标：把已完成的持久化 Agent Runtime 接到用户可见前端，让页面不再只跑旧内存 Agent 或快速搜索，而是创建 Postgres task、入 Redis 队列、由独立 worker 执行 7 阶段 workflow，并轮询展示最终结果。

已完成：

- 新增 `GET /api/agent/tasks/:taskId/view`，只读 Postgres snapshot，并把 `guarded_final_result + candidates + evidence` 适配为前端可渲染的 `analysis / paths / people / sections / meta`。
- 前端主体验收敛为 Agent 模式：发送问题时调用 `POST /api/agent/tasks`，轮询 `/api/agent/tasks/:taskId/view`，展示持久化 workflow 的 7 个阶段。
- Agent Runtime 未配置或 Postgres/Redis/worker 不可用时，前端显示明确不可用提示，不再把真实 Agent 链路静默伪装成本地 mock。
- Docker Compose 增加 `migrate` 和独立 `agent-worker` service，并为 Postgres/Redis 增加 healthcheck。
- 新增 `npm run smoke:agent-view -w backend`，通过 HTTP 创建持久化任务、等待完成、校验 view 中的 `analysis / paths / people / meta.guard`。

验证建议：

- `npm run build -w backend`
- `npm run smoke:llm-gateway -w backend`
- 在有 Postgres + Redis + backend + worker 的环境中运行 `npm run smoke:agent-view -w backend`
- 手动启动 `docker compose -f infra/docker-compose.yml up`，打开 `http://localhost:3000/` 输入问题，确认能看到阶段进度和最终路径/人物结果。

## 2026-05-14 - Agent search timeout profile and orchestration guardrails

本轮目标：优先修复 `/api/agent/search` 真实 Agent 链路的运转稳定性，让 Agent 模式获得更长、更可观测的大模型执行窗口，同时不放大全局 `/api/demo/search` 同步接口超时。

已完成：

- Agent 总预算提升到 300s，仅通过 Agent options 生效。
- Agent LLM stage 使用专用 max/min/reserve timeout profile，旧同步搜索仍保留既有短预算。
- `evidence_extract`、`demo_response_compose` 等核心阶段按动态剩余预算计算 effective timeout，预算不足时才跳过。
- Agent 模式下搜索 query 限制为 8 条，并发为 3，避免串行知乎搜索耗尽后续 LLM 时间。
- Agent 模式下 LLM stage 允许 1 次轻量 retry，仍受单 stage effective timeout 约束。
- `/api/agent/tasks/:taskId` 的 stage 增加可选 `budgetMs/effectiveTimeoutMs/provider/model/attempts`，debug 增加 `timeoutProfile/budgetTrace/providerTrace`。
- 前端 Agent 面板最小更新状态文案，区分“已兜底继续”“超时，已兜底继续”和执行预算信息。

验证建议：

- `npm run build -w backend`
- 手动 POST `/api/agent/search`，轮询 `/api/agent/tasks/:taskId`，确认核心 LLM 阶段获得更长 effective timeout。
- 手动确认 `/api/demo/search` 同步接口仍可用，且没有继承 Agent 的 300s profile。

## 2026-05-13 - Zhihu ring publish/pin backend integration

本轮目标：接入知乎 OpenAPI `POST /openapi/publish/pin`，让后端可以手动把内容发布到指定知乎圈子；不接入 `/api/demo/search` 主链路。

已完成：

- 新增 `zhihuProvider.publishPinToRing(params)`，请求 `ZHIHU_OPENAPI_BASE_URL/openapi/publish/pin`。
- 请求头包含 `X-App-Key`、秒级 `X-Timestamp`、自动生成的 `X-Log-Id`、`X-Sign`、空字符串 `X-Extra-Info` 和 `Content-Type: application/json`。
- `X-Sign` 使用 `app_key:${APP_KEY}|ts:${TIMESTAMP}|logid:${LOG_ID}|extra_info:` 做 HMAC-SHA256 后 base64。
- 新增手动发布接口 `POST /api/zhihu/ring/publish`，请求体字段为 `ringId/title/content/imageUrls`。
- 白名单圈子：
  - `2001009660925334090`：OpenClaw 人类观察员
  - `2015023739549529606`：A2A for Reconnect
  - `2029619126742656657`：黑客松脑洞补给站
- 本地进程内限流：同一小时最多 5 次真实发布。
- `imageUrls` 只接受 URL 字符串数组，不包含图片上传能力。
- 配置缺失返回 `ZHIHU_RING_PUBLISH_CONFIG_ERROR`；知乎业务失败返回 `ZHIHU_RING_PUBLISH_FAILED` 并透出上游 `msg`。

环境变量：

```env
ZHIHU_OPENAPI_BASE_URL=https://openapi.zhihu.com
ZHIHU_OPENAPI_APP_KEY=
ZHIHU_OPENAPI_APP_SECRET=
```

curl 测试示例：

```bash
curl -X POST "http://127.0.0.1:8000/api/zhihu/ring/publish" \
  -H "Content-Type: application/json" \
  -d '{
    "ringId":"2029619126742656657",
    "title":"错位人生测试",
    "content":"这是一条后端链路测试内容，请忽略。",
    "imageUrls":[]
  }'
```

## 2026-05-13 - real demo search performance guardrails

本轮目标：优化 `/api/demo/search` real 链路的首屏可控性，避免 Kimi / DeepSeek 慢响应拖垮主接口；不修改 paths 语义生成逻辑。

已完成：

- 为 real 链路四个 LLM stage 增加单 stage timeout：
  - `intent_expand`: 3s
  - `evidence_extract`: 9s
  - `demo_response_compose`: 7s
  - `grounding_guard`: 3s
- stage 超时、失败或未配置时继续使用 deterministic fallback，`/api/demo/search` 仍返回成功响应。
- `debug.timings[]` 新增 `stageName / durationMs / llmUsed / fallbackUsed / fallbackReason`。
- `debug.cacheHit` 新增请求级内存缓存命中标记。
- 增加简单内存缓存，key 包含 `normalizedQuery + dataMode`，并包含 `count` 和匿名/登录上下文摘要，TTL 为 15 分钟。
- 更新 `scripts/smoke-demo-real-key.mjs`，覆盖两个指定 query，并连续请求同一个 query 验证第二次 cache hit，同时打印总耗时和各 stage 耗时。

验证记录：

- `npm run build` 通过。
- `npm run smoke:demo-real` 通过。
- query「为了工作，异地恋值得吗」总耗时约 22.6s：
  - `intent_expand` 约 1.9s，LLM 成功。
  - `evidence_extract` 9.0s 超时 fallback。
  - `demo_response_compose` 7.0s 超时 fallback。
  - `grounding_guard` 约 1.4s，LLM 成功。
- query「不工作了能去哪儿」首次总耗时约 22.0s：
  - `intent_expand` 约 1.6s，LLM 成功。
  - `evidence_extract` 9.0s 超时 fallback。
  - `demo_response_compose` 7.0s 超时 fallback。
  - `grounding_guard` 约 1.3s，LLM 成功。
- query「不工作了能去哪儿」第二次总耗时约 4ms，`debug.cacheHit=true`。

处理边界：

- 未重写 `PATH_BUCKETS / groupItemsByPath / toPath` 等 paths 语义生成逻辑。
- 未删除既有 LLM 能力；只是为 demo search 调用增加更短的 stage-level 超时和零重试策略。

## 2026-05-13 - 后续待办：real demo search 展示文案优化

### 背景

`/api/demo/search` 已经可以返回 `dataMode: real`，并能拿到真实知乎内容。但当前 real 模式下的展示字段仍偏工程化和模板化。

### 待优化点

1. `paths.title` 需要更有区分度，避免“从相似回答里找下一步”这类模板表达。
2. `people.role` / `badge` 避免“Answer公开内容样本”等工程化表达。
3. `people.oneLine` 控制在 35-60 字，不要直接截原文。
4. `timeline.date` 不展示原始时间戳。
5. `match.reasons` 更像用户能理解的匹配理由。
6. `persona.suggestedQuestions` 结合每个样本内容生成，避免所有人一致。

### 处理约束

- 当前不要修改代码。
- 等后端主任务完成、工作区干净后，再单独开分支处理。

## 2026-05-13 - AI persona prompt assets

### 本轮目标

将前端新增 AI 分身能力需要的 Persona Composer 和 Persona Chat prompt 纳入后端 prompt 管理体系。本轮只做 prompt 文档与代码占位整理，不接真实 LLM，不开发复杂聊天，不改动既有 `GET /api/search` 主流程。

本轮主结论：

- AI 分身 prompt 采用固定 system prompt + 动态 `persona_context`。
- 核心原则是“表达拟人化，事实不拟人化”。
- `people[].aiPersona` 是分身入口，不是独立人物主数据。
- `POST /api/personas/chat` 后续应使用固定 `PERSONA_CHAT_SYSTEM_PROMPT` + 动态 `persona_context`。
- AI 分身不代表作者本人，不提供作者本人实时回应，不承诺还原作者真实意图。

### 新增/更新文件

新增：

- `backend/app/prompts/persona_composer_system.md`
- `backend/app/prompts/persona_chat_system.md`
- `backend/src/prompts/personaComposerPrompt.ts`
- `backend/src/prompts/personaChatPrompt.ts`
- `backend/src/prompts/personaPromptBuilder.ts`
- `docs/prompts/persona-composer.system.md`
- `docs/prompts/persona-chat.system.md`

更新：

- `docs/backend-ai-persona-integration-plan.md`
- `docs/frontend-field-guide.md`
- `docs/AI_HANDOFF.md`

### 已完成事项

- 纠正 prompt 资产落点：两份 system markdown 已补入既有 `backend/app/prompts/` 管理目录，可由 `backend/app/prompt_loader.py` 按文件名读取。
- 新增 Persona Composer system prompt，用于生成 `people[].aiPersona`。
- 新增 Persona Chat system prompt，用于后续 `POST /api/personas/chat`。
- 新增 `buildPersonaChatMessages(input)`，按固定 system prompt、动态 `persona_context`、`userMessage` 拼装消息。
- 明确不为每个作者生成独立 system prompt。
- 明确 evidence 不足时不能强行生成可聊分身，聊天回答应返回 `insufficient_evidence`。
- 明确禁止伪装作者本人、编造作者经历或将观点包装成亲历故事。

### 未完成事项

- 尚未实现 `POST /api/personas/chat` 路由。
- 尚未实现 Persona Composer 的真实运行链路。
- 尚未接入真实 LLM。
- 尚未实现复杂多轮聊天。
- 尚未把 `people[].aiPersona` 接入实际 demo search 返回生成流程。

### 下一步建议

1. 在不影响 `GET /api/search` 的前提下实现 `POST /api/demo/search` 的 mock/stub 产品层结构。
2. 用 Persona Composer stub 生成 `people[].aiPersona`，确保 `boundary`、`grounding.articleIds[]`、`personaReadiness` 完整。
3. 新增 `POST /api/personas/chat` 的 grounded mock answer，复用 `buildPersonaChatMessages(input)` 作为未来真实 LLM 接入点。
4. 为 Persona Chat 增加最小单元测试，覆盖 `persona_context` 字段完整性和固定 system prompt 复用。

## 2026-05-13 - AI persona product-layer docs

### 本轮目标

为后端进入“产品层接口 + AI 分身兼容层”开发做文档和契约准备。当前不做大范围业务实现，不切换技术栈，不重构已有接口，不删除现有 `GET /api/search`。

本轮主结论：

- 当前 P0 产品层主接口统一写为 `POST /api/demo/search`。
- `GET /api/search` 继续保留为已实现的知乎搜索映射/底层召回接口。
- `people[]` 是人物样本主数据。
- `people[].aiPersona` 是 AI 分身入口。
- 顶层 `personas[]` 只作为快捷索引，不重复完整人物数据。
- AI 不作为事实来源；AI 分身不代表作者本人；分身回答必须基于公开内容和 `evidence`。
- 无知乎 API Key、无 LLM Key 时，P0/P0.5 也必须用 mock/stub 完整跑通。

### 已更新文档

- `docs/backend-ai-persona-integration-plan.md`
  - 新增本轮后端规划。
  - 记录接口收敛、返回结构、people 主数据、aiPersona 挂载方式、personas 快捷索引、P0/P0.5/P1 切分和验收标准。

- `docs/backend-next-step-plan.md`
  - 保留上一轮 `GET /api/search` 链路说明。
  - 补充 2026-05-13 更新说明，避免把旧计划误读为 AI 分身产品层主接口。

- `shared/openapi.yaml`
  - 保留 `GET /api/search` 既有契约。
  - 修正 `POST /api/demo/search` 为 P0 产品层目标契约。
  - 新增 `POST /api/personas/chat` P0.5 目标契约。
  - 补充 `schemaVersion`、`queryId`、`features`、`analysis`、`paths`、`people`、`people[].articles`、`people[].match`、`people[].aiPersona`、`personas`、`sections`、`meta`、`debug` 等 schema。

- `shared/demo-response.sample.json`
  - 更新为完整 AI 分身版响应样例。
  - 包含 3 条 paths、3 个 people。
  - 每个 people 至少包含 1 条 article、match、aiPersona。
  - 顶层 `personas[]` 只引用 `people[].aiPersona`，不重复完整人物数据。
  - 保留 legacy `GET /api/search` 成功样例和无知乎 Key 错误样例。

- `docs/frontend-field-guide.md`
  - 更新前端读取优先级：产品层优先 `POST /api/demo/search`。
  - 明确 `people[]` 是主数据。
  - 明确 `people[].aiPersona` 是 AI 分身入口。
  - 明确顶层 `personas[]` 是快捷索引。
  - 补充 `articles[]` 的 `title/text/url/author/avatar/evidence` fallback。
  - 补充 `features` 使用方式。
  - 说明 P0 保存样本和完整多轮聊天可暂时 fallback/mock。

- `README.md`
  - 最小同步前后端协作说明，避免继续把 `GET /api/search` 描述为 AI 分身产品层 P0 主接口。
  - 明确 `GET /api/search` 仍是已实现的底层搜索映射和兼容接口。

- `docs/AI_HANDOFF.md`
  - 记录本轮目标、已更新文档、下一步建议、未完成事项、风险和检查结果。

### 下一步建议开发任务

1. 新增 `POST /api/demo/search` 路由。
2. 增加 demo search composer，将 `GET /api/search` 的 `items[]` 或 mock seed 转成 `analysis + paths + people + personas + sections`。
3. 增加 persona composer，生成 `people[].aiPersona`，并保证 `boundary` 和 `grounding.articleIds[]` 完整。
4. 增加无知乎 API Key 的 mock 成功模式，确保 `POST /api/demo/search` 能完整返回样例同形状结构。
5. 增加无 LLM Key 的 deterministic stub，确保分析、匹配理由和分身入口不依赖真实模型。
6. P0.5 再新增 `POST /api/personas/chat`，先返回 grounded mock answer。

### 未完成事项和风险

- `POST /api/demo/search` 尚未实现，当前只是目标契约和样例。
- `POST /api/personas/chat` 尚未实现，当前只是 P0.5 目标契约。
- `shared/openapi.yaml` 中 planned-p0 / planned-p0.5 接口代表下一步开发目标，不代表当前后端已可调用。
- 后续实现时必须避免让 `personas[]` 变成第二套人物主数据。
- 后续实现时必须避免无 evidence 的 AI 总结被前端展示成事实。
- 旧设计中的 `POST /api/v1/match/query` 可作为 future API，当前不要把前端主链路切过去。

### 检查结果

已执行：

```bash
node -e "JSON.parse(require('fs').readFileSync('shared/demo-response.sample.json','utf8')); console.log('sample json ok')"
ruby -e "require 'yaml'; YAML.load_file('shared/openapi.yaml'); puts 'openapi yaml ok'"
npm run build -w backend
```

结果：

- `shared/demo-response.sample.json` JSON 格式有效。
- `shared/openapi.yaml` YAML 格式有效。
- `npm run build -w backend` 通过。
