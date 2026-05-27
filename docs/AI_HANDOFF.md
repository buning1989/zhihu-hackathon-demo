# AI Handoff

## 2026-05-27 - Experience feed output and path navigation slimming

本轮目标：前台结果页从 path 分类导航收敛为真实经历 Feed，后端公开输出不再提供 path list、path count、重复 path 标题或 viewpoint path 给前端导航。

已完成：

- `/api/demo/search` 和 Agent Task 结果新增 `feedItems[]` 主列表，每个 item 绑定 `sourceUrl / sourceRefs / evidenceIds / saveSampleId`，且只允许 `experience_sample` 进入主 Feed。
- 公开响应保留 `paths: []` 作为兼容空字段，删除公开 debug 中的 `pathCount / pathSource / pathDuplicateFound / pathDiversityCheck / enhancedPathCount`。
- `people[]` 同步补齐 `directionLabel / sourceTitle / sourcePlatform / sourceUrl / snippet / summaryPayload / saveSampleId`，前端可直接渲染卡片。
- Agent Task 仍保留 retrieve、定向补搜、candidate quality、experience_sample 准入、evidence_extract 和 experience_summary；只在写入 partial/final 前投影为 Feed 输出。
- 前端结果页直接渲染经历样本卡，不再加载 `pathModule.js`，frontend smoke 会检查没有 path nav/module 回退。

验证记录：

- `npm run build -w backend` 通过。

## 2026-05-26 - Zhihu search replay fixtures and API budget guardrails

本轮目标：降低知乎真实搜索 API 消耗，让本地 smoke/eval 默认通过 fixture 回放跑通。

已完成：

- 新增 `dataMode=replay`：`/api/demo/search` 和 Agent 任务会走真实产品层组合链路，但知乎搜索只读 `backend/fixtures/zhihu-search`，缺 fixture 返回 `ZHIHU_REPLAY_FIXTURE_MISSING`。
- `ZhihuProvider.searchRaw` 增加 fixture-first 保护：real/cache_first 命中本地 fixture 时不请求知乎；真实请求成功后自动写入 `recorded-*.json` fixture。
- 增加真实调用日志和预算：默认写入 `data/zhihu-api-usage/YYYY-MM-DD.jsonl`，日志包含 query、normalizedQuery、fixture hit/real request、consumed、usedToday、budget；`ZH_API_DAILY_DEV_BUDGET` 默认 50。
- 默认脚本防护：
  - `npm run smoke:demo-replay` / `npm run smoke:demo-real` 默认 `replay`。
  - `smoke-agent-tasks` 和 `agent-task-real-eval` 默认不消耗真实知乎 API。
  - 只有 `DATA_MODE=real` 或 `ALLOW_REAL_ZH_API=1` 才允许真实请求，脚本会先打印风险提示和预计搜索轮数。
- 固化 10+ 个核心中文 query fixture，并覆盖 deterministic expanded query aliases。

验证记录：

- `npm run build -w backend` 通过。
- `npm run smoke:demo-replay` 通过，日志中所有 `[ZhihuSearch]` 均为 `action=fixture_hit consumed=0`。

## 2026-05-25 - display copy responsibility cleanup

本轮目标：收敛 `analysis / people[].oneLine / people[].lesson / people[].experienceSummary` 的展示职责，避免前端把不同字段拼成重复的人物卡总结。

已完成：

- 前端 adapter 不再把 `oneLine`、`lesson`、`articles[].summary` 或原文片段兜底成 `experienceSummary`。
- `experienceSummary` 只有在 `experienceSummarySource=llm` 且 `experienceSummaryStatus=ready` 时进入主展示字段，否则保持 `null`。
- 旧 production final result 兼容路径只保留 `oneLine` 和来源片段，不再生成伪 `experienceSummary`。
- debug preview 不再把 `lesson` 当候选主文案 fallback。
- 文档和 OpenAPI 明确：
  - `analysis` 负责问题理解/整体步骤。
  - `oneLine` 只负责人物卡一句话钩子。
  - `lesson` 只负责风险/谨慎提醒，默认不和经历总结同屏。
  - `experienceSummary` 是唯一的主经历总结字段。

验证记录：

- adapter 轻量断言通过：pending 样本不会把 `oneLine/lesson` 变成 `experienceSummary`，ready LLM 总结仍保留。

## 2026-05-25 - demo personas/sections default omitted

本轮目标：在不切 LLM 主链路、不新增 feedCard 的前提下，把 `/api/demo/search` 顶层 `personas[]` 和 `sections[]` 从默认主响应中省略，降低重复派生字段维护成本。

已完成：

- `DemoSearchService` 在写入响应缓存前删除顶层 `personas` 和 `sections`。
- `people[].aiPersona` 继续保留，作为 AI 分身入口和 persona chat 的主来源。
- `debug.personaCount` 继续保留计数，内部 composer / grounding guard 仍可临时使用派生 personas。
- smoke 和 real LLM/persona 脚本改为从 `people[].aiPersona.personaId` 发起 `/api/personas/chat`。
- OpenAPI、sample 和前端字段文档同步说明：`personas[] / sections[]` 是可选兼容字段，主响应默认省略，前端从 `people + paths` 派生。

验证记录：

- `npm run build -w backend` 通过。
- `npm run smoke -w backend` 通过。
- `npm run smoke:demo-real:search` 通过。
- adapter 兜底验证通过：省略 `personas/sections` 后仍可派生快捷入口和布局分组。

## 2026-05-24 - real smoke split and relationship-work candidate quality

本轮目标：把 `smoke:demo-real` 拆成稳定的搜索召回 smoke 和单独的 LLM/persona smoke，并优化“长期异地恋 + 工作/追求自己想做的事”场景的候选质量。

已完成：

- 新增 `scripts/smoke-demo-real-search.mjs`，只验证 `/api/demo/search` real 搜索召回：
  - `debug.search.queriesUsed`
  - `debug.search.searchRounds`
  - `debug.search.totalRawResults`
  - `debug.search.totalDedupedCandidates`
  - `debug.search.candidates[]`
  - top 3 candidates 至少 2 条命中异地恋/恋爱/距离/伴侣/城市/分开/团聚等关系信号。
- `package.json` 脚本拆分：
  - `npm run smoke:demo-real`：默认搜索召回 smoke。
  - `npm run smoke:demo-real:search`：同上。
  - `npm run smoke:demo-real:llm-persona`：保留原 LLM/persona 全链路验收。
  - `npm run smoke:demo-real:full`：顺序跑 search + llm/persona。
- `demoCandidateQuality.service.ts` 增加 relationship-work 场景规则：
  - query/topic/searchQueries 同时命中异地恋/恋爱/伴侣/距离/城市与工作/职业/追求自己/想做的事时启用。
  - 关系信号、城市距离、职业取舍信号加权。
  - 只命中复盘/效率/方法/目标/成长/管理/提升/曾国藩/工作复盘，且缺少关系或职业取舍信号的候选会被降权到 drop。
  - debug 中可见 `relationship_work_topic_boost`、`relationship_work_generic_work_penalty`、`relationship_work_missing_relationship_or_career_signal`。
- `searchQueryPlan` 的 fallback 在 relationship-work 场景下优先生成短 query，例如：
  - `长期异地恋 工作选择`
  - `异地恋 职业发展 后悔吗`
  - `异地恋 为了工作 分开`
  - `异地恋 追求梦想 真实经历`

验证记录：

- `npm run build -w backend` 通过。
- `npm run smoke:demo-real:search` 通过。
- 测试 query「为了工作能追求自己想做的事，长期异地恋真的值得吗？」返回：
  - `queriesUsed=6`
  - `searchRounds=6`
  - `totalRawResults=18`
  - `totalDedupedCandidates=15`
  - `degraded=false`
  - top 3 candidates 均为异地恋/异地工作/就业机会相关内容。

注意：

- LLM/persona smoke 仍单独依赖 DeepSeek/Kimi 稳定性；如果失败，应看是否落在 LLM timeout 或 persona chat 断言，不再代表搜索召回失败。

## 2026-05-24 - demo real multi-round Zhihu search candidates

本轮目标：在 `/api/demo/search` real 链路中，把 intent/search query 计划真正执行为多轮知乎搜索，并产出可供 `evidence_extract` / `demo_response_compose` 消费的标准候选内容。

已完成：

- real 链路从完整搜索计划中默认选择 3-6 条更适合知乎站内搜索的短 query 执行。
- 每条 query 独立调用知乎搜索；单条失败会记录在 debug 中，不中断其他 query。
- 搜索结果在进入候选质量/证据链路前会按标题、链接、可读文本过滤，并按 `url/sourceId/title` 轻量去重。
- 新增 `debug.search`：
  - `dataMode`
  - `queriesUsed`
  - `searchRounds`
  - `totalRawResults`
  - `totalDedupedCandidates`
  - `failedQueries`
  - `emptyQueries`
  - `degraded`
  - `fallbackReason`
  - `candidates[]` 调试预览，含 `sourceId/title/url/authorName/snippet/text/sourceType/queryUsed/searchRound`
- 所有 query 失败、所有 query 为空、或候选管线清洗为空时，保留 `debug.search.degraded=true` 和原因；产品层仍可 fallback 到 mock 形状，避免前端页面崩掉。
- `scripts/smoke-demo-real-key.mjs` 已补充 `debug.search` 断言和输出字段。
- `shared/openapi.yaml` 和 `shared/demo-response.sample.json` 已同步 `debug.search` 结构。

验证记录：

- `npm run build -w backend` 通过。
- 指定 query「为了工作能追求自己想做的事，长期异地恋真的值得吗？」在 real 模式下返回：
  - `queriesUsed=6`
  - `searchRounds=6`
  - `totalRawResults=30`
  - `totalDedupedCandidates=25`
  - `failedQueries=[]`
  - `emptyQueries=[]`
  - `degraded=false`
- 本地 stub 验证：
  - 全部 query 失败时返回 `debug.search.degraded=true`，`fallbackReason=all_search_queries_failed...`
  - 全部 query 空结果时返回 `debug.search.degraded=true`，`fallbackReason=all_search_queries_returned_empty`

已知限制：

- `npm run smoke:demo-real` 仍会因为既有脚本要求至少一个 LLM `experienceSummary` ready 而失败；失败来自 DeepSeek/Kimi 超时后的旧断言，不是本轮搜索召回字段缺失。
- 当前不做复杂 ranking；候选质量和最终路径仍沿用既有规则/LLM fallback。

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
