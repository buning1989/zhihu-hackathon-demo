# AI Handoff

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
