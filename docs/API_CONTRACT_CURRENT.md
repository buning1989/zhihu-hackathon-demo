# Current Backend API Contract

日期：2026-05-13
范围：基于当前 `backend/src` 实现整理，仅记录现有真实输出，不引入新字段设计。

本文面向前后端联调，覆盖：

- `POST /api/demo/search`
- `POST /api/personas/chat`

成功响应统一包在：

```json
{
  "success": true,
  "data": {}
}
```

错误响应统一包在：

```json
{
  "success": false,
  "error": {
    "code": "ERROR_CODE",
    "message": "Error message"
  }
}
```

## 稳定性标记

| 标记 | 含义 |
| --- | --- |
| 稳定 | 前端可以作为当前联调契约依赖。 |
| 半稳定 | 字段会返回，但值、数量或文案会随 query、环境变量、mock/real 模式变化。 |
| 调试 | 仅建议联调、排障使用，后续可能调整。 |
| 易变 | 时间、耗时、缓存、hash id、LLM 文案等运行时结果，不应写死。 |

## POST /api/demo/search

### 请求

路径：

```http
POST /api/demo/search
Content-Type: application/json
```

请求体字段：

| 字段 | 类型 | 必填 | 当前行为 | 稳定性 |
| --- | --- | --- | --- | --- |
| `query` | string/number | 是 | 会转成字符串并 `trim`；为空返回 `QUERY_REQUIRED`。 | 稳定 |
| `count` | string/number | 否 | 默认 `5`；无法解析时用默认值；最终 clamp 到 `1..20`。 | 稳定 |
| `dataMode` | string | 否 | `mock`、`cache_first`、`replay`、`real`；缺省使用后端 `DATA_MODE` 配置。 | 稳定 |
| `mode` | string | 否 | `dataMode` 的兼容别名；当 `dataMode` 为空时读取。 | 半稳定 |
| `clarificationAnswers` | object | 否 | 非空对象表示用户已提交澄清卡答案；后端进入 `intent_expand` 搜索计划阶段，不生成完整 `paths/people/personas`。 | 稳定 |

常见错误：

| HTTP | code | 触发条件 |
| --- | --- | --- |
| 400 | `QUERY_REQUIRED` | 缺少 `query` 或为空字符串。 |
| 400 | `DATA_MODE_INVALID` | `dataMode/mode` 不是 `mock`、`cache_first`、`replay`、`real`。 |
| 404 | `ZHIHU_REPLAY_FIXTURE_MISSING` | `replay` 模式缺少本地知乎搜索 fixture。 |

### 返回字段

当没有 `clarificationAnswers` 时，`data` 仍返回完整 demo 结果结构。

`data` 顶层字段：

| 字段 | 类型 | 说明 | 稳定性 |
| --- | --- | --- | --- |
| `schemaVersion` | string | 当前固定为 `demo.v1`。 | 稳定 |
| `queryId` | string | 本次查询 id，也用于后续 persona chat。 | 易变 |
| `query` | string | 原始 query。 | 稳定 |
| `dataMode` | string | 当前响应实际数据模式。`real` 失败 fallback 时可能变为 `mock`。 | 稳定 |
| `contextUsed` | object | 是否使用知乎登录上下文及使用位置。 | 半稳定 |
| `features` | object | 前端能力开关。 | 稳定 |
| `analysis` | object | 问题理解和步骤说明。 | 半稳定 |
| `paths` | array | 路径聚合结果。 | 稳定 |
| `people` | array | 人物/内容样本主数据。 | 稳定 |
| `personas` | array | 可选兼容字段；主响应默认省略，前端从 `people[].aiPersona` 派生。 | 半稳定 |
| `sections` | array | 可选兼容字段；主响应默认省略，前端按默认顺序渲染。 | 半稳定 |
| `meta` | object | 来源、证据数量、生成时间、耗时和 fallback 状态。 | 半稳定 |
| `debug` | object | composer、缓存、LLM stage、候选质量等调试信息。 | 调试 |

`features`：

| 字段 | 类型 | 说明 | 稳定性 |
| --- | --- | --- | --- |
| `aiPersona` | boolean | 是否允许展示 AI 分身入口。 | 稳定 |
| `personaChat` | `off`/`mock`/`real` | 当前聊天能力。注意它取决于 persona chat LLM 配置，不完全等同于 search 的 `dataMode`。 | 半稳定 |
| `saveSample` | boolean | 当前为 `false`。 | 稳定 |
| `articleBody` | boolean | 当前为 `false`。 | 稳定 |
| `sourceEvidenceRequired` | boolean | 当前固定为 `true`。 | 稳定 |

`feedItems[]`：

主结果结构。每个 item 对应一张真实经历样本卡，前端优先读取这里渲染 Feed。

| 字段 | 类型 | 说明 | 稳定性 |
| --- | --- | --- | --- |
| `id` | string | Feed item id。 | 稳定 |
| `personId` | string | 关联 `people[].id`。 | 稳定 |
| `authorName` | string | 作者/样本展示名。 | 半稳定 |
| `authorAvatar` | string | 头像，可为空。 | 半稳定 |
| `sourceTitle` | string | 原文标题。 | 稳定 |
| `sourcePlatform` | string | 来源平台，当前主要为知乎。 | 稳定 |
| `sourceUrl` | string | 查看原文链接。 | 稳定 |
| `directionLabel` | string | 卡片弱标签，不作为导航分类。 | 半稳定 |
| `displayExcerpt` | string | Feed 卡片主文案，优先是能独立回应当前问题的完整原文段落摘录。 | 稳定 |
| `excerptSource` | `llm_selected_paragraph`/`paragraph_rule_selected`/`summary_fallback` | `displayExcerpt` 的选择来源。 | 半稳定 |
| `excerptReason` | string | 摘录选择原因，仅 debug 使用，普通用户界面不展示。 | 易变 |
| `snippet` | string | 兼容字段，保留来源片段摘要；有 `displayExcerpt` 时不要作为主文案。 | 稳定 |
| `summaryPayload` | object | 内容总结三段所需数据和 markdown。 | 稳定 |
| `sampleType` | `experience_sample` | 主 Feed 只接收真实经历样本。 | 稳定 |
| `evidenceIds/sourceRefs` | string[] | 关联证据和来源。 | 稳定 |
| `saveSampleId` | string | 收藏样本所需 id。 | 稳定 |

`paths[]`：

兼容字段。当前公开主响应返回空数组，不再渲染路径 tab、路径卡、分类计数或导航；服务端内部仍可能用 pathId 做排序/聚类兼容。

| 字段 | 类型 | 说明 | 稳定性 |
| --- | --- | --- | --- |
| `id` | string | 路径 id。 | 易变 |
| `title` | string | 路径标题。 | 半稳定 |
| `summary` | string | 路径摘要。 | 半稳定 |
| `fitReason` | string | 与当前 query/上下文的匹配说明。 | 半稳定 |
| `stance` | `experience`/`viewpoint`/`mixed` | 路径内容类型。 | 稳定 |
| `personRefs` | string[] | 关联 `people[].id`。 | 稳定 |
| `evidenceIds` | string[] | 关联证据 id。 | 稳定 |
| `sourceRefs` | string[] | 关联 `meta.sourceRefs[].id`。 | 稳定 |

`people[]`：

| 字段 | 类型 | 说明 | 稳定性 |
| --- | --- | --- | --- |
| `id` | string | 人物/样本 id。 | 易变 |
| `name` | string | 展示名。mock 为样本名，real 可来自知乎作者名。 | 半稳定 |
| `sampleType` | string | real 模式可能返回：`experience_sample`、`viewpoint_author`、`content_sample`。mock 当前可能不返回。 | 半稳定 |
| `pathId` | string | 内部兼容 id；前端卡片展示请用 `directionLabel`。 | 半稳定 |
| `directionLabel` | string | Feed 卡片弱标签，不作为导航分类。 | 半稳定 |
| `sourceTitle/sourcePlatform/sourceUrl` | string | Feed 卡片来源信息和原文链接。 | 稳定 |
| `snippet` | string | 原文片段摘要。 | 稳定 |
| `summaryPayload` | object | 内容总结三段数据。 | 稳定 |
| `saveSampleId` | string | 收藏样本所需 id。 | 稳定 |
| `role` | string | 样本角色说明。 | 半稳定 |
| `badge` | string | 短标签。 | 半稳定 |
| `avatar` | string | 作者头像或空字符串。 | 半稳定 |
| `oneLine` | string | 人物卡一句话钩子；不作为 `experienceSummary` fallback。 | 半稳定 |
| `experienceSummary` | string/null | LLM 生成的经历总结；mock/未生成时为 `null`。 | 半稳定 |
| `experienceSummarySource` | `llm`/`fallback`/`none` | 总结来源。 | 稳定 |
| `experienceSummaryStatus` | `ready`/`pending`/`failed` | 总结状态。 | 稳定 |
| `experienceSummaryConfidence` | number | LLM 总结置信度；仅有 ready 总结时可能出现。 | 半稳定 |
| `fitReason` | string | 匹配说明。 | 半稳定 |
| `who` | string | 样本边界说明。 | 半稳定 |
| `overlaps` | string[] | 与当前 query 的重叠变量。 | 半稳定 |
| `timeline` | array | 公开内容里的时间/经历线索。 | 半稳定 |
| `lesson` | string | 谨慎启发/风险提醒；默认不和 `experienceSummary` 同屏展示。 | 半稳定 |
| `articles` | array | 原文入口和证据。 | 稳定 |
| `match` | object | 匹配分数、理由、风险和证据引用。 | 稳定 |
| `aiPersona` | object | AI 分身入口。 | 稳定 |
| `evidenceIds` | string[] | 关联证据 id。 | 稳定 |
| `sourceRefs` | string[] | 关联 `meta.sourceRefs[].id`。 | 稳定 |

`people[].articles[]`：

| 字段 | 类型 | 说明 | 稳定性 |
| --- | --- | --- | --- |
| `id` | string | 文章/回答 id。 | 易变 |
| `title` | string | 标题。 | 半稳定 |
| `text` | string | 摘要/正文片段。 | 半稳定 |
| `url` | string | 原文链接。 | 稳定 |
| `author` | string | 作者展示名。 | 半稳定 |
| `avatar` | string | 作者头像或空字符串。 | 半稳定 |
| `sourceName` | string | 来源名称。 | 半稳定 |
| `sourceUrl` | string | 来源 URL。 | 稳定 |
| `summary` | string | 卡片摘要。 | 半稳定 |
| `evidence` | array | 证据片段。 | 稳定 |
| `body` | array | 正文块，当前主要是 `type: "evidence"`。 | 半稳定 |
| `sourceRefs` | string[] | 来源引用 id。 | 稳定 |

`people[].match`：

| 字段 | 类型 | 说明 | 稳定性 |
| --- | --- | --- | --- |
| `score` | number | 综合匹配分。 | 半稳定 |
| `level` | `low`/`medium`/`high` | 匹配等级。 | 稳定 |
| `reasons` | string[] | 匹配理由。 | 半稳定 |
| `matchedVariables` | string[] | 匹配变量。 | 半稳定 |
| `riskNotes` | string[] | 风险和边界说明。 | 半稳定 |
| `contentRelevance` | number | 内容相关性。 | 半稳定 |
| `experienceSimilarity` | number | 经历相似度。 | 半稳定 |
| `evidenceQuality` | number | 证据质量。 | 半稳定 |
| `personaReadiness` | number | 分身可用度。 | 半稳定 |
| `evidenceIds` | string[] | 证据 id。 | 稳定 |
| `sourceRefs` | string[] | 来源引用 id。 | 稳定 |

`people[].aiPersona`：

| 字段 | 类型 | 说明 | 稳定性 |
| --- | --- | --- | --- |
| `enabled` | boolean | 是否可进入聊天。 | 稳定 |
| `personaId` | string | 聊天接口使用的 persona id。 | 稳定 |
| `displayName` | string | 分身展示名。 | 半稳定 |
| `label` | string | 分身标签。 | 半稳定 |
| `openingLine` | string | 入口引导语。 | 半稳定 |
| `suggestedQuestions` | string[] | 建议追问。 | 半稳定 |
| `boundary` | string | 边界说明。 | 稳定 |
| `grounding.personId` | string | 关联 `people[].id`。 | 稳定 |
| `grounding.articleIds` | string[] | 关联 `people[].articles[].id`。 | 稳定 |
| `grounding.evidenceRequired` | boolean | 当前固定为 `true`。 | 稳定 |
| `grounding.sourceRefs` | string[] | 来源引用 id。 | 稳定 |

`personas[]`（兼容字段，主响应默认不返回）：

| 字段 | 类型 | 说明 | 稳定性 |
| --- | --- | --- | --- |
| `id` | string | 等于对应 `people[].aiPersona.personaId`。 | 稳定 |
| `personId` | string | 回查 `people[]` 的 id。 | 稳定 |
| `displayName` | string | 展示名。 | 半稳定 |
| `avatar` | string | 头像或空字符串。 | 半稳定 |
| `personaType` | string | 当前为 `experience_echo`。 | 稳定 |
| `intro` | string | 入口介绍。 | 半稳定 |
| `fitReason` | string | 匹配说明。 | 半稳定 |
| `boundaryNotice` | string | 边界说明。 | 稳定 |
| `sourceRefs` | string[] | 来源引用 id。 | 稳定 |
| `suggestedQuestions` | string[] | 建议追问。 | 半稳定 |

`meta`：

| 字段 | 类型 | 说明 | 稳定性 |
| --- | --- | --- | --- |
| `sourceRefs` | array | 来源列表。每项含 `id/provider/type/title/url/author/evidenceIds`。 | 稳定 |
| `evidenceCount` | number | 当前响应证据数量。 | 半稳定 |
| `generatedAt` | ISO string | 生成时间。 | 易变 |
| `latencyMs` | number | 处理耗时。 | 易变 |
| `fallbackUsed` | boolean | 是否使用 fallback。 | 半稳定 |

`debug` 仅建议联调用，当前常见字段包括：

- `composer`
- `originalQuery`
- `normalizedQuery`
- `requestedDataMode`
- `resolvedDataMode`
- `cacheHit`
- `cacheKeyPreview`
- `itemCount/sourceItemCount/peopleCount/personaCount`；`pathCount` 仅内部调试兼容，不在公开主响应 debug 暴露
- `llmUsed/llmComposerUsed/llmRepairUsed/llmRepairFailed`
- `llmStageResults`
- `timings`
- `searchQueries`
- `searchQueryResults`
- `mergedCandidateCount/dedupedCandidateCount/validCandidateCount`
- `candidateQuality`
- `experienceSummaryDebug`
- `pathSource`
- `intentStage`
- `fallbackUsed/fallbackKind/fallbackReason`
- `guardWarnings`
- `notes`

### 澄清卡后二次请求响应

当请求体包含非空 `clarificationAnswers` 时，`POST /api/demo/search` 只返回意图展开和知乎搜索计划，不返回完整结果页集合：

| 字段 | 类型 | 说明 | 稳定性 |
| --- | --- | --- | --- |
| `intent` | string | 结构化意图类别，例如 `relationship_career_tradeoff`。 | 稳定 |
| `intentSummary` | string | 对用户真实问题的一句话概括。 | 半稳定 |
| `focusTags` | string[] | 用户关注点，至少 3 个。 | 半稳定 |
| `searchPlan.coreQueries` | string[] | 主召回 query，至少 3 条，短关键词为主。 | 稳定 |
| `searchPlan.expandedQueries` | string[] | 补充召回 query，至少 2 条。 | 稳定 |
| `searchPlan.exploratoryQueries` | string[] | 少量长尾探索 query，至少 1 条。 | 稳定 |
| `searchPlan.rankingSignals` | string[] | 后续筛选、重排、证据抽取信号，至少 3 个。 | 稳定 |
| `searchPlan.negativeHints` | string[] | 后续过滤低质量内容的提示。 | 半稳定 |
| `searchPlan.expectedEvidenceTypes` | string[] | 后续希望召回的证据类型。 | 半稳定 |
| `debug.stage` | string | 固定为 `intent_expand`。 | 稳定 |
| `debug.llmUsed` | boolean | 是否成功使用 LLM。LLM 不可用时为 `false` 并使用规则兜底。 | 稳定 |
| `debug.fallbackReason` | string | 兜底原因；仅在未成功使用 LLM 时出现。 | 调试 |

该响应不会包含 `paths`、`people` 或 `personas`，避免澄清后二次请求误进入完整结果生成链路。

## POST /api/personas/chat

### 请求

路径：

```http
POST /api/personas/chat
Content-Type: application/json
```

请求体字段：

| 字段 | 类型 | 必填 | 当前行为 | 稳定性 |
| --- | --- | --- | --- | --- |
| `personaId` | string/number | 是 | 可传 `people[].aiPersona.personaId`、顶层 `personas[].id`，或部分场景下传 `people[].id`。为空返回 `PERSONA_ID_REQUIRED`。 | 稳定 |
| `queryId` | string/number | 否 | 用于读取 `POST /api/demo/search` 写入的进程内 session cache；为空默认 `query_mock`。 | 稳定 |
| `message` | string/number | 是 | 用户追问；为空返回 `MESSAGE_REQUIRED`。 | 稳定 |
| `history` | array | 否 | 仅保留合法 `{ role: "user" | "assistant", content }`，最多最后 6 条，单条 content 截到 1000 字。 | 半稳定 |

常见错误：

| HTTP | code | 触发条件 |
| --- | --- | --- |
| 400 | `PERSONA_ID_REQUIRED` | 缺少 `personaId` 或为空字符串。 |
| 400 | `MESSAGE_REQUIRED` | 缺少 `message` 或为空字符串。 |

注意：`queryId` 找不到、`personaId` 找不到、分身关闭、证据不足、LLM 未配置或失败时，当前实现返回 `success: true` 的 mock fallback，不返回 4xx。

### 返回字段

`data` 顶层字段：

| 字段 | 类型 | 说明 | 稳定性 |
| --- | --- | --- | --- |
| `schemaVersion` | string | 当前固定为 `personaChat.v1`。 | 稳定 |
| `personaId` | string | 实际回答归属的 persona id。 | 稳定 |
| `reply` | string | 回答正文。real 为 LLM 生成，mock 为 deterministic/fallback 文案。 | 半稳定 |
| `boundaryNotice` | string | 固定边界：基于公开内容生成，不代表作者本人。 | 稳定 |
| `sourceRefs` | string[] | 回答引用的来源 id。 | 稳定 |
| `suggestedQuestions` | string[] | 后续追问建议。 | 半稳定 |
| `meta` | object | 模式、queryId、生成时间、grounded、LLM 使用情况和安全说明。 | 稳定 |
| `debug` | object | `chatMode/fallbackReason/evidenceCount`。 | 调试 |

`meta`：

| 字段 | 类型 | 说明 | 稳定性 |
| --- | --- | --- | --- |
| `mode` | `mock`/`real` | 本次聊天实际模式。 | 稳定 |
| `queryId` | string | 请求传入或默认的 query id。 | 稳定 |
| `generatedAt` | ISO string | 生成时间。 | 易变 |
| `grounded` | boolean | 当前固定为 `true`。 | 稳定 |
| `llmUsed` | boolean | 是否使用 LLM。 | 稳定 |
| `safetyNotes` | string[] | 安全/边界/回退说明。 | 半稳定 |

`debug`：

| 字段 | 类型 | 说明 | 稳定性 |
| --- | --- | --- | --- |
| `chatMode` | `real_llm_chat`/`mock_fallback` | 实际聊天路径。 | 调试 |
| `fallbackReason` | string | fallback 原因；real 成功为空字符串。 | 调试 |
| `evidenceCount` | number | 进入聊天 grounding 的证据数量。 | 调试 |

## 当前 mock / real 模式差异

### `/api/demo/search`

| 模式 | 当前行为 |
| --- | --- |
| `dataMode: "mock"` | 不调用知乎搜索和 demo search LLM；返回 query-aware deterministic mock 数据。`meta.sourceRefs[].provider` 为 `mock`，`debug.composer` 为 `mock`，`debug.llmUsed` 为 `false`，`debug.llmStageResults` 为空数组。 |
| `dataMode: "cache_first"` | 当前 `/api/demo/search` 先查请求级内存缓存；未命中时生成 deterministic mock fallback，`dataMode` 仍为 `cache_first`。底层知乎 provider 的 cache_first 会先读 fixture，只有 `DATA_MODE=real` 或 `ALLOW_REAL_ZH_API=1` 时才允许真实请求。 |
| `dataMode: "replay"` | 走真实搜索组合和多阶段 orchestration，但知乎搜索只读 `backend/fixtures/zhihu-search`。任一执行 query 缺 fixture 时返回 `ZHIHU_REPLAY_FIXTURE_MISSING`，不静默 fallback。 |
| `dataMode: "real"` | 先查本地 fixture/cache；缺失时调用真实搜索并写入 fixture，同时记录真实调用日志，不做本地每日预算拦截。成功时来源为 `provider: "zhihu"`、`type: "zhihu_answer"`，并返回 `debug.llmStageResults`、`debug.timings`、`debug.searchQueries`、`debug.searchQueryResults`、`debug.candidateQuality`、`debug.experienceSummaryDebug`。任一关键 real 链路抛错时默认返回错误，不再静默 fallback 到 mock；只有请求显式传 `allowMockFallback: true` 才允许返回 mock 兜底。 |

补充：

- demo search 响应会写入进程内 session cache，供 `/api/personas/chat` 按 `queryId` 读取。
- 请求级内存缓存 TTL 当前为 15 分钟，key 包含 normalized query、dataMode、count、登录上下文摘要。
- 知乎搜索 fixture 目录默认是 `backend/fixtures/zhihu-search`；真实调用日志默认写入 `data/zhihu-api-usage/YYYY-MM-DD.jsonl`，仅用于审计，不再控制每日真实调用上限。
- 当前 real smoke 中，`intent_expand`、`experience_summary`、`grounding_guard` 可成功；`evidence_extract` 和 `demo_response_compose` 可能按 stage timeout fallback，但接口仍成功返回。
- `features.personaChat` 由 persona chat LLM 是否配置决定。即使 search 使用 `dataMode: "mock"`，只要 persona chat LLM 可用，也可能返回 `"real"`。

### `/api/personas/chat`

| 模式 | 当前行为 |
| --- | --- |
| real chat | 需要先有 `/api/demo/search` 写入的 `queryId` cache、匹配到 persona、`aiPersona.enabled === true`、有 source/evidence，且 `persona_chat` LLM 已配置。成功时 `meta.mode` 为 `real`，`meta.llmUsed` 为 `true`，`debug.chatMode` 为 `real_llm_chat`。 |
| mock fallback | cache 缺失、persona 不存在、分身关闭、证据不足、LLM 未配置或 LLM 失败都会返回 mock fallback。HTTP 仍为 200，`success: true`，`meta.mode` 为 `mock`，`meta.llmUsed` 为 `false`，`debug.chatMode` 为 `mock_fallback`，`debug.fallbackReason` 记录原因。 |

## 实际返回样例

生成方式：

- 先执行 `npm run build -w backend`。
- 使用当前 `backend/dist/app.js` 临时启动本地 app。
- 请求 `POST /api/demo/search`，body 为 `{"query":"不工作了能去哪儿","count":1,"dataMode":"mock"}`。
- 使用上一步响应里的 `data.queryId` 和 `data.people[0].aiPersona.personaId` 请求 `POST /api/personas/chat`。
- 当前本机环境中 persona chat LLM 可用，因此聊天样例为 `meta.mode: "real"`。

### `POST /api/demo/search` 样例

请求：

```json
{
  "query": "不工作了能去哪儿",
  "count": 1,
  "dataMode": "mock"
}
```

响应：

```json
{
  "success": true,
  "data": {
    "schemaVersion": "demo.v1",
    "queryId": "query_f398b7fd",
    "query": "不工作了能去哪儿",
    "dataMode": "mock",
    "features": {
      "aiPersona": true,
      "personaChat": "real",
      "saveSample": false,
      "articleBody": false,
      "sourceEvidenceRequired": true
    },
    "analysis": {
      "summary": "已基于公开内容样本，将「不工作了能去哪儿」拆成 1 条可对照路径。",
      "intent": "work_pause_path_exploration",
      "focusTags": [
        "停靠地点",
        "日常节奏",
        "生活半径",
        "现金流",
        "安全垫",
        "保障底线",
        "工作回流",
        "低成本试错"
      ],
      "steps": [
        {
          "id": "step_understand_query",
          "label": "理解问题里的生活处境",
          "status": "done",
          "evidenceIds": [
            "ev_mock_5c32f86b",
            "ev_mock_17a546f"
          ],
          "sourceRefs": [
            "source_mock_efa1b945"
          ]
        },
        {
          "id": "step_group_paths",
          "label": "把公开内容归入路径样本",
          "status": "done",
          "evidenceIds": [
            "ev_mock_5c32f86b",
            "ev_mock_17a546f"
          ],
          "sourceRefs": [
            "source_mock_efa1b945"
          ]
        }
      ]
    },
    "paths": [
      {
        "id": "path_work_pause_path_place_rhythm_66aeef",
        "title": "有人离开工作后先去低成本地方休整",
        "summary": "这类样本先处理想去哪里、每天怎么过、低成本资源和身体状态，而不是立刻定终局。 该路径来自 deterministic mock 样本，用于无真实召回时对齐当前问题。",
        "fitReason": "结合你的问题「不工作了能去哪儿」，这条路径只说明公开样本可用来对照「停靠地点」，判断仍以来源片段为准。",
        "stance": "experience",
        "personRefs": [
          "person_mock_efa1b945"
        ],
        "evidenceIds": [
          "ev_mock_5c32f86b",
          "ev_mock_17a546f"
        ],
        "sourceRefs": [
          "source_mock_efa1b945"
        ]
      }
    ],
    "people": [
      {
        "id": "person_mock_efa1b945",
        "name": "停靠地点样本",
        "pathId": "path_work_pause_path_place_rhythm_66aeef",
        "role": "基于公开回答整理的停靠地点样本",
        "badge": "停靠地点",
        "avatar": "",
        "oneLine": "这个样本提醒你，判断「不工作了能去哪儿」时先看停靠地点和日常节奏。",
        "experienceSummary": null,
        "experienceSummarySource": "none",
        "experienceSummaryStatus": "pending",
        "fitReason": "结合你的问题「不工作了能去哪儿」，这个样本只说明公开回答可用来对照「停靠地点」，判断仍以来源片段为准。",
        "who": "基于知乎公开回答整理出的前人样本，不等同于作者完整人生。",
        "overlaps": [
          "都涉及「停靠地点」这个选择变量",
          "都涉及「日常节奏」这个选择变量",
          "都涉及「生活半径」这个选择变量"
        ],
        "timeline": [
          {
            "date": "公开内容片段",
            "event": "公开回答样本把「不工作了能去哪儿」放到「停靠地点」里讨论，提醒先看这类样本先处理想去哪里、每天怎么过、低成本资源和身体状态，而不是立刻定终局。",
            "evidenceIds": [
              "ev_mock_5c32f86b",
              "ev_mock_17a546f"
            ],
            "sourceRefs": [
              "source_mock_efa1b945"
            ]
          }
        ],
        "lesson": "先把「停靠地点」看清，再判断这条公开样本能否迁移到你的问题。",
        "articles": [
          {
            "id": "article_mock_54072023",
            "title": "关于「不工作了能去哪儿」的公开回答样本",
            "text": "公开回答样本把「不工作了能去哪儿」放到「停靠地点」里讨论，提醒先看这类样本先处理想去哪里、每天怎么过、低成本资源和身体状态，而不是立刻定终局。\n同一组样本还关注「日常节奏」，适合继续对照「生活半径」这一层代价。",
            "url": "https://www.zhihu.com/question/mock-66aeeff2/answer/1",
            "author": "公开回答样本 A",
            "avatar": "",
            "sourceName": "知乎回答样本",
            "sourceUrl": "https://www.zhihu.com/question/mock-66aeeff2/answer/1",
            "summary": "公开回答样本把「不工作了能去哪儿」放到「停靠地点」里讨论，提醒先看这类样本先处理想去哪里、每天怎么过、低成本资源和身体状态，而不是立刻定终局。",
            "evidence": [
              {
                "id": "ev_mock_5c32f86b",
                "label": "停靠地点",
                "text": "公开回答样本把「不工作了能去哪儿」放到「停靠地点」里讨论，提醒先看这类样本先处理想去哪里、每天怎么过、低成本资源和身体状态，而不是立刻定终局。",
                "sourceRefId": "source_mock_efa1b945",
                "sourceUrl": "https://www.zhihu.com/question/mock-66aeeff2/answer/1"
              },
              {
                "id": "ev_mock_17a546f",
                "label": "日常节奏",
                "text": "同一组样本还关注「日常节奏」，适合继续对照「生活半径」这一层代价。",
                "sourceRefId": "source_mock_efa1b945",
                "sourceUrl": "https://www.zhihu.com/question/mock-66aeeff2/answer/1"
              }
            ],
            "body": [
              {
                "type": "evidence",
                "text": "公开回答样本把「不工作了能去哪儿」放到「停靠地点」里讨论，提醒先看这类样本先处理想去哪里、每天怎么过、低成本资源和身体状态，而不是立刻定终局。",
                "evidenceIds": [
                  "ev_mock_5c32f86b"
                ],
                "sourceRefs": [
                  "source_mock_efa1b945"
                ]
              },
              {
                "type": "evidence",
                "text": "同一组样本还关注「日常节奏」，适合继续对照「生活半径」这一层代价。",
                "evidenceIds": [
                  "ev_mock_17a546f"
                ],
                "sourceRefs": [
                  "source_mock_efa1b945"
                ]
              }
            ],
            "sourceRefs": [
              "source_mock_efa1b945"
            ]
          }
        ],
        "match": {
          "score": 0.86,
          "level": "high",
          "reasons": [
            "当前问题「不工作了能去哪儿」和样本都涉及「停靠地点」",
            "这条路径围绕「有人离开工作后先去低成本地方休整」提供可追溯的 mock 证据"
          ],
          "matchedVariables": [
            "停靠地点",
            "日常节奏",
            "生活半径"
          ],
          "riskNotes": [
            "公开内容只能说明片段经验，不能代表作者完整人生或长期结果"
          ],
          "contentRelevance": 0.86,
          "experienceSimilarity": 0.82,
          "evidenceQuality": 0.78,
          "personaReadiness": 0.76,
          "evidenceIds": [
            "ev_mock_5c32f86b",
            "ev_mock_17a546f"
          ],
          "sourceRefs": [
            "source_mock_efa1b945"
          ]
        },
        "aiPersona": {
          "enabled": true,
          "personaId": "persona_mock_29130f5b",
          "displayName": "停靠地点样本的经验回声",
          "label": "基于公开内容生成",
          "openingLine": "你可以继续问这段公开内容里的选择、代价和下一步判断。",
          "suggestedQuestions": [
            "这段公开内容里，「停靠地点」怎么判断？",
            "从这个公开样本看，「日常节奏」要注意什么？"
          ],
          "boundary": "该 AI 分身基于公开内容生成，不代表作者本人。",
          "grounding": {
            "personId": "person_mock_efa1b945",
            "articleIds": [
              "article_mock_54072023"
            ],
            "evidenceRequired": true,
            "sourceRefs": [
              "source_mock_efa1b945"
            ]
          }
        },
        "evidenceIds": [
          "ev_mock_5c32f86b",
          "ev_mock_17a546f"
        ],
        "sourceRefs": [
          "source_mock_efa1b945"
        ]
      }
    ],
    "personas": [
      {
        "id": "persona_mock_29130f5b",
        "personId": "person_mock_efa1b945",
        "displayName": "停靠地点样本的经验回声",
        "avatar": "",
        "personaType": "experience_echo",
        "intro": "你可以继续问这段公开内容里的选择、代价和下一步判断。",
        "fitReason": "结合你的问题「不工作了能去哪儿」，这个样本只说明公开回答可用来对照「停靠地点」，判断仍以来源片段为准。",
        "boundaryNotice": "该 AI 分身基于公开内容生成，不代表作者本人。",
        "sourceRefs": [
          "source_mock_efa1b945"
        ],
        "suggestedQuestions": [
          "这段公开内容里，「停靠地点」怎么判断？",
          "从这个公开样本看，「日常节奏」要注意什么？"
        ]
      }
    ],
    "sections": [
      {
        "id": "section_paths",
        "type": "paths",
        "title": "可能路径",
        "itemRefs": [
          "path_work_pause_path_place_rhythm_66aeef"
        ]
      },
      {
        "id": "section_people",
        "type": "people",
        "title": "前人样本",
        "itemRefs": [
          "person_mock_efa1b945"
        ]
      },
      {
        "id": "section_personas",
        "type": "personas",
        "title": "可追问的经验回声",
        "itemRefs": [
          "persona_mock_29130f5b"
        ]
      }
    ],
    "meta": {
      "sourceRefs": [
        {
          "id": "source_mock_efa1b945",
          "provider": "mock",
          "type": "mock_answer",
          "title": "关于「不工作了能去哪儿」的公开回答样本",
          "url": "https://www.zhihu.com/question/mock-66aeeff2/answer/1",
          "author": "公开回答样本 A",
          "evidenceIds": [
            "ev_mock_5c32f86b",
            "ev_mock_17a546f"
          ]
        }
      ],
      "evidenceCount": 2,
      "generatedAt": "2026-05-13T15:27:50.418Z",
      "latencyMs": 3,
      "fallbackUsed": false
    },
    "debug": {
      "composer": "mock",
      "originalQuery": "不工作了能去哪儿",
      "normalizedQuery": "不工作了能去哪儿",
      "requestedDataMode": "mock",
      "resolvedDataMode": "mock",
      "cacheHit": false,
      "cacheKeyPreview": "demo_search:v2:mock:count=1:q=不工作了能去哪儿:h=f398b7fd",
      "itemCount": 1,
      "sourceItemCount": 1,
      "pathCount": 1,
      "peopleCount": 1,
      "personaCount": 1,
      "llmUsed": false,
      "llmComposerUsed": false,
      "llmRepairUsed": false,
      "llmRepairFailed": false,
      "llmStageResults": [],
      "enhancedPeopleCount": 0,
      "enhancedPathCount": 0,
      "partialFallbackUsed": false,
      "pathSource": "fallback",
      "intentStage": {
        "mode": "rule",
        "llmUsed": false,
        "fallbackReason": "mock mode uses query-aware deterministic analysis; no LLM intent planner invoked",
        "intentSource": "rule",
        "focusTagsSource": "rule"
      },
      "fallbackUsed": false,
      "fallbackKind": "",
      "fallbackReason": "query-aware fallback paths built from normalizedQuery=\"不工作了能去哪儿\" and 0 candidate snippets",
      "guardWarnings": [],
      "notes": [
        "mock demo data; query-aware deterministic paths generated without LLM or Zhihu API"
      ]
    },
    "contextUsed": {
      "provider": "zhihu",
      "loggedIn": false,
      "zhihuProfileUsed": false,
      "profileSignals": [],
      "usedFor": []
    }
  }
}
```

### `POST /api/personas/chat` 样例

请求：

```json
{
  "personaId": "persona_mock_29130f5b",
  "queryId": "query_f398b7fd",
  "message": "这段公开内容里，第一步应该想清楚什么？"
}
```

响应：

```json
{
  "success": true,
  "data": {
    "schemaVersion": "personaChat.v1",
    "personaId": "persona_mock_29130f5b",
    "reply": "根据这段公开内容，第一步应该想清楚的是「停靠地点」。这个样本提醒你，在考虑「不工作了能去哪儿」时，首先要处理的是想去哪里、每天怎么过、低成本资源和身体状态，而不是立刻定下终局。这涉及到对个人生活半径和日常节奏的考量，以及如何利用低成本资源和评估自身身体状态。",
    "boundaryNotice": "该 AI 分身基于公开内容生成，不代表作者本人。",
    "sourceRefs": [
      "source_mock_efa1b945"
    ],
    "suggestedQuestions": [
      "你如何理解「低成本资源」在决定「不工作了能去哪儿」时的作用？",
      "在考虑「日常节奏」时，你认为哪些因素是最重要的？"
    ],
    "meta": {
      "mode": "real",
      "queryId": "query_f398b7fd",
      "generatedAt": "2026-05-13T15:27:56.806Z",
      "grounded": true,
      "llmUsed": true,
      "safetyNotes": [
        "grounded LLM reply",
        "answerType: grounded_summary",
        "based only on cached demo person public content",
        "does not represent the Zhihu author"
      ]
    },
    "debug": {
      "chatMode": "real_llm_chat",
      "fallbackReason": "",
      "evidenceCount": 2
    }
  }
}
```

## 验证记录

已执行：

```bash
npm run build -w backend
npm run smoke:demo-real
```

结果：

- `npm run build -w backend` 通过。
- `npm run smoke:demo-real` 通过。
- real smoke 记录到 4 次 demo search 调用：两条不同 query、一次 cache warm、一次 cache hit。
- cache hit query 的 `debug.cacheHit=true`，总耗时约 `5ms`。
- persona chat 记录为 `debug.chatMode=real_llm_chat`。
- real demo search 当前有部分 stage timeout fallback：`evidence_extract`、`demo_response_compose` fallback，但接口整体成功，`intent_expand`、`experience_summary`、`grounding_guard` recorded。
