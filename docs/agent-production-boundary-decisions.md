# Agent 生产边界决策

> 范围：当前 `deploy/static-mock-demo` 分支和既有 Agent Runtime。本文只服务 P0 修复，不引入新架构。

| 问题 | 推荐决策 | 理由 | 后续代码影响 |
| --- | --- | --- | --- |
| 1. 当前阶段定位 | 当前分支推荐定位为：**基于 local demo runtime 的 public demo candidate**。可以对外说“基于公开内容证据的样本发现 demo / sample navigation demo”。不能宣称 pre-production Agent、production Agent、生产级隐私安全、私有任务历史、保证真实知乎召回、保证真实 LLM 推理、作者/分身聊天、作者本人实时回应。 | 现有链路已跑通 Postgres、Redis、worker、cache、clarify、debug 和 v2 result，但默认仍允许 mock source 和 mock LLM；task ownership 与 admin 边界还不满足生产要求。 | 在 API/UI 增加 demo/mock/degraded 标识；production 启动时强制校验真实 source/LLM 配置；确认定位后再同步 README/OpenAPI 文案。 |
| 2. Task 访问边界 | `POST /api/agent/tasks` 可公开，但必须配限流和滥用防护。`GET /api/agent/tasks` 只能 internal/admin。`GET /api/agent/tasks/:taskId`、`/result`、`/view`、`POST /refine` 必须要求 owner proof 或服务端签发的 read token。`/debug` 和 list 只能 internal/admin；仅靠非 production 开关不够。`taskId` 是敏感定位符，不是授权 secret。 | 当前读接口只要 taskId；跨用户返回 reused taskId 时，如果 id 泄露或复用，会暴露他人的状态、结果或生命周期。debug/list 是运维面，不是产品面。 | 为 status/result/view/refine 加 ownership middleware；为 list/debug 加 internal/admin guard；停止把 taskId-only access 当作足够授权；补跨 actor 拒绝测试。 |
| 3. 匿名用户与 task ownership | 前端 `localStorage` `anonymousId` 只能作为体验连续性 hint，不能作为授权依据。P0 推荐创建 task/refine 时签发 server-side per-task read token，只存 token hash，读 status/result/view/refine 时必须携带。后续若要匿名任务历史或稳定配额，再加 HttpOnly anonymous session。 | 前端生成的 anonymousId 可伪造，目前还会作为 client metadata 发送；它可辅助 demo 限流分组，但不能证明任务归属。 | create/refine 返回或设置 read credential；轮询、result、view、refine 校验该凭证；后续用 HttpOnly session 承载匿名历史、配额和同浏览器连续性。 |
| 4. Cache/reuse 策略 | 匿名 task 不允许跨用户复用原 taskId。跨用户返回 `running` 或 `succeeded` 原 taskId 只适合 local demo，不适合 public/prod。推荐 **copy result**：命中 succeeded cache 时为当前 actor 创建新 task/result，复制可复用 artifact；running task 只允许同 actor 复用。无 actor 私有信息的 stage artifact cache 可以继续共享。 | 当前复用能省成本，但会穿透 ownership 边界。copy result 保留成本收益，同时不暴露原任务事件、metadata 和状态生命周期；alias task 复杂度更高，纯 per-actor cache key 又损失更多复用。 | 将跨 actor task reuse 改成 copy-result flow；running reuse 增加 actorHash 校验；cache key 继续包含 source mode、LLM mode、prompt/scoring 版本和 refined answer hash。 |
| 5. 隐私与 metadata 存储 | P0 可暂时明文存 `task.query`，但必须有短保留期，且不能公开 list/debug；metadata 中不要重复存 raw query。结构化 clarify 选项可在 allowlist 内明文保存。free text、optional context、任意 `refineQuery` 默认只存 hash/length，除非产品/安全明确批准明文。metadata 必须用 allowlist，不用 blacklist。debug 只展示 id、状态、时间、计数、hash、分数、degraded reason 和短 internal preview；不得展示完整 query、原始 free text、token、cookie、IP、localStorage id、raw LLM text 或完整 source body。 | worker 当前需要 query 字符串，但任意 client metadata 和自由文本会带来不必要的隐私风险。blacklist 容易漏掉新敏感字段；debug 要保留诊断价值但必须是安全摘要。 | 将 metadata sanitize 从 blacklist 改为 allowlist；复查 `originalQuery`、`refineAnswers`、`refinedQuery` 存储；加 retention policy；加强 debug/list 脱敏和敏感字段回归测试。 |
| 6. Production fallback 策略 | production 不能把 mock source 结果当真实结果返回 `succeeded`。production 不能在 `AGENT_LLM_ENABLED=false` 时返回 production Agent 成功结果。demo/mock 成功只允许在 API 和 UI 明确标记 `dataMode/sourceMode=mock` 或 `llmMode=mock` 时出现。真实链路 fallback 必须标记 `degraded=true`、`degradedReason` 和 warnings；配置缺失应 fail fast，不要静默变成 demo 结果。 | smoke 通过 mock source/LLM 只能证明 demo path，不证明生产质量。用户和 reviewer 必须能区分真实证据、降级证据和演示数据。 | 增加 production config guard；在 final result/view 中显式传递 `sourceMode`、`llmMode`、`fallbackKind`、`degraded`、warning；更新 UI badge 与 smoke/eval 断言。 |

## P0 代码修改清单

执行备注：2026-05-23 第一轮已完成 task read token、list/debug guard、metadata allowlist、running reuse ownership、cross-actor succeeded copy-result 和 OpenAPI/smoke 更新；真实 source/LLM production guard 与 UI badge 留到后续轮次。

1. 确认本分支对外定位，并在 API/UI 中明确展示 demo/mock/degraded 文案。
2. 增加 task read credential：create/refine 签发 server-side read token，只存 hash，status/result/view/refine 必须校验。
3. 为 `GET /api/agent/tasks` 和 `/debug` 增加 internal/admin guard；production 禁用 `/debug` 作为第二道保护。
4. 将 client metadata sanitize 改为 allowlist；free text 和任意 refine text 默认只保留 hash/length。
5. 修改 cache reuse：跨 actor succeeded reuse 改为 copy result 到新 task；running reuse 仅同 actor 返回原 task。
6. 增加 production 启动/运行 guard：source mode 为 mock 或 `AGENT_LLM_ENABLED=false` 时不得返回 production success。
7. 将 `sourceMode`、`llmMode`、`fallbackKind`、`degraded`、`degradedReason`、warnings 传到 final result、view 和前端 badge。
8. 更新 OpenAPI、README、smoke/eval 和安全回归测试。

## 必须先由人确认

- 当前分支是否允许公开展示为 demo，以及精确对外话术。
- 用户 query 和结构化 clarify answers 是否可明文存储，以及保留多久。
- 任意 free text/refine text 是否允许明文存储。
- 谁算 internal/admin，如何发放 list/debug 访问权限。
- 匿名用户是否需要跨浏览器会话的任务历史，这决定 read-token-only 与 HttpOnly anonymous session 的先后。
- 叫作 production result 时，真实 source 和真实 LLM 的最低要求是什么。
