# 前端字段协作指南

版本：v0.2
日期：2026-05-13
适用阶段：产品层接口 + AI 分身兼容层 P0/P0.5

## 主接口

当前前端产品层应优先读取：

```http
POST /api/demo/search
Content-Type: application/json
```

请求示例：

```json
{
  "query": "不工作了之后，我想去新西兰生活",
  "count": 20,
  "mode": "mock"
}
```

如果用户已经填写澄清卡，前端把答案放入 `clarificationAnswers`。此时接口只返回 `intent / intentSummary / focusTags / searchPlan / debug`，用于下一步知乎搜索召回计划，不返回完整 `paths / people / personas` 结果页结构。

`GET /api/search?query=...&count=...` 已经实现并继续保留，但它的定位是知乎搜索结果映射接口，主要返回 `items[]`，用于调试、兼容和产品层接口的底层召回。前端 AI 分身页面不要把 `GET /api/search` 当成最终页面数据结构。

`/api/zhihu/search` 是后端调试用的知乎原始响应代理，前端不要直接依赖。

## 当前实现状态

截至 2026-05-13：

- `GET /api/search`：已实现，保留既有契约。
- `POST /api/demo/search`：P0 目标契约，前端字段应按 `shared/demo-response.sample.json` 对齐，后端实现是下一步开发任务。
- `POST /api/personas/chat`：P0.5 目标契约，可先 fallback/mock。
- `POST /api/v1/match/query`：长期 future API，可以保留在设计里，但当前 P0 不作为主接口。

## 产品层响应

`POST /api/demo/search` 的目标响应顶层字段：

```json
{
  "schemaVersion": "2026-05-13.ai-persona-v1",
  "queryId": "query_demo_001",
  "query": "不工作了之后，我想去新西兰生活",
  "dataMode": "mock",
  "contextUsed": {},
  "features": {},
  "analysis": {},
  "paths": [],
  "people": [],
  "personas": [],
  "sections": [],
  "meta": {},
  "debug": {}
}
```

前端 P0 推荐读取顺序：

1. 用 `analysis.steps` 和 `analysis.focusTags` 支撑 loading / 问题理解区域。
2. 联调或 preview 可读 `contextUsed` 展示是否使用了知乎登录上下文。
3. 用 `paths[]` 渲染路径图，优先展示 `title / summary / whyRelevant / tradeoff`，可辅助展示 `paths[].fitReason`。
4. 用 `people[]` 渲染人物样本卡，这是主数据，可展示 `people[].fitReason`。
5. 用 `people[].articles[]` 渲染原文入口和证据。
6. 用 `people[].match` 渲染匹配解释。
7. 用 `people[].aiPersona` 渲染 AI 分身入口。
8. 顶层 `personas[]` 是可选兼容快捷入口，主响应默认省略；从 `people[].aiPersona` 派生。
9. `sections[]` 是可选弱绑定布局辅助，主响应默认省略；缺失时按 `analysis -> paths -> people -> personas` 固定顺序渲染。

## 澄清卡可选字段

当前澄清卡由相似经历匹配 planner 生成，前端仍优先读取既有字段：

- `clarifyingCard.title`
- `clarifyingCard.description`
- `clarifyingCard.questions[].label`
- `clarifyingCard.questions[].options[]`

新增字段均为可选增强：

- `clarifyingCard.questions[].queryTokens`：该问题可进入搜索 query 的事实词。
- `clarifyingCard.questions[].selectedReason`：为什么这个事实有助于匹配相似人。
- `clarifyingCard.questions[].score`：validator/scorer 之后的排序分。
- `debug.clarificationPlan.knownFacts`
- `debug.clarificationPlan.choiceFrame`
- `debug.clarificationPlan.candidateQuestions`
- `debug.clarificationPlan.rejectedQuestions`
- `debug.clarificationPlan.selectedQuestions`
- `debug.clarificationPlan.scoringDetails`

前端不要把 `debug.clarificationPlan` 当用户可见内容；它只用于联调和质量审查。

## 用户上下文与 fitReason

`contextUsed` 是可选调试友好字段，用来说明本次是否读取了知乎授权用户的轻量上下文：

- `contextUsed.loggedIn`：是否有有效知乎登录 session。
- `contextUsed.zhihuProfileUsed`：是否实际使用了非敏感资料信号。
- `contextUsed.profileSignals[]`：后端从 `headline/displayName` 白名单提取出的职业或兴趣词。
- `contextUsed.usedFor[]`：可能包含 `intent_expand`、`search_query_expand`、`fit_reason`。

前端不要期待或展示 OAuth token、cookie、完整 userInfo、userId、头像原始对象。`contextUsed` 不是证据来源，也不能替代 `sourceRefs/evidenceIds`。

`fitReason` 可出现在 `paths[]`、`people[]`、`personas[]`。它只能解释“为什么这个公开内容可能与当前问题和轻量资料信号相关”，不能写成确定诊断、身份判断或夸张承诺。展示时建议放在“匹配说明”或调试区域旁边，并继续优先展示证据和原文入口。

## paths[] 路径图

`paths[]` 不是文章摘要列表，而是基于用户问题和候选内容提炼出的差异化人生路径。前端可以继续兼容旧字段，但新展示优先读取：

- `paths[].title`：具体路径标题，不是抽象标签。
- `paths[].summary`：这条路径是什么，解决了什么问题。
- `paths[].whyRelevant`：它和用户原问题的关系。
- `paths[].tradeoff`：代价、风险、限制或不确定性。
- `paths[].displayLabel / displayTradeoff`：展示层安全文案。前端可直接展示；不要把 `roughTier / roughScore / diversityKey / contentRole / keepReason` 等调试字段拼进用户可见标题、摘要或代价说明。
- `paths[].diversityKey`：调试或辅助展示用的差异化标签。
- `paths[].sourceRefs[]`：至少一条来源引用，用于回到 evidence/source。

## people[] 是主数据

`people[]` 是唯一人物主数据来源。每个 people 表示一个基于公开知乎内容整理出的前人样本。

前端不要把顶层 `personas[]` 当作人物列表，也不要在本地维护另一套完整人物对象。展示人物卡、文章、匹配理由、头像、路径归属时，都应回到 `people[]`。

关键字段：

- `people[].id`：人物样本 id。
- `people[].name`：展示名，可来自 `author.name`，缺失时展示“知乎用户”。
- `people[].pathId`：关联 `paths[].id`。
- `people[].avatar`：头像，缺失时用默认头像。
- `people[].displayTier`：`core | supplement`。`core` 表示匹配等级、证据质量和内容相关度都达到主展示门槛；其他样本继续展示为“补充参考样本”。
- `people[].evidenceStatus`：`llm_extracted | raw_snippet_only`。`raw_snippet_only` 时，前端文案显示“来源片段”，不要显示“AI 证据提炼”。
- `people[].canChat`：最终追问入口门控。`false` 时按钮显示“查看来源片段”，不要显示聊天入口。
- `people[].displayLabel / displayTradeoff`：展示分层和限制说明，优先用于卡片标签和 CTA 降级说明。
- `people[].oneLine`：人物卡核心句，只负责首屏钩子；不要作为 `experienceSummary` fallback。
- `people[].experienceSummary`：作者内容总结 / 前人经历总结。只有 `experienceSummarySource === "llm"` 且 `experienceSummaryStatus === "ready"` 时作为主展示。
- `people[].experienceSummarySource`：`llm | fallback | none`。前端主效果只展示 `llm`；`fallback`/`none` 不要当作正式总结。
- `people[].experienceSummaryStatus`：`ready | pending | failed`。`pending/failed` 时隐藏总结区或展示轻量占位，不要改读规则摘要。
- `people[].experienceSummaryConfidence`：可选置信度，可用于调试或排序，不建议直接作为用户文案。
- `people[].fitReason`：可选匹配说明，必须仍以公开内容证据为边界。
- `people[].who`：TA 是谁的说明。注意这是基于公开内容整理，不等同于作者完整人生。
- `people[].overlaps[]`：与当前用户问题的重叠点。
- `people[].timeline[]`：经历线索，P0 可是 mock/rule。
- `people[].lesson`：谨慎启发/风险提醒，必须基于 evidence；默认不在人物卡主摘要位展示。
- `people[].articles[]`：原文入口和证据。
- `people[].match`：匹配解释。
- `people[].aiPersona`：AI 分身入口。

## AI 分身入口

AI 分身挂在：

```text
people[].aiPersona
```

前端展示聊天入口前应检查：

- `people[].aiPersona.enabled === true`
- `people[].aiPersona.personaId` 存在
- `people[].aiPersona.boundary` 存在
- `people[].aiPersona.grounding.articleIds[]` 至少能关联到一条 `people[].articles[]`

`boundary` 必须对用户可见或在聊天开始处可见。标准含义是：

```text
这是基于知乎公开内容生成的经验回应，不代表作者本人。
```

AI 不作为事实来源。AI 分身不代表作者本人，不提供实时回应，不模拟作者本人回复。所有回答必须基于公开内容和 evidence。

## AI 分身前端展示建议

AI 分身入口建议写成“经验回声”或“继续理解这段公开经历”的感觉，不要写得像工具按钮，也不要暗示正在和作者本人对话。

不建议写：

```text
与 AI 分身对话
```

建议写：

```text
问问 TA 走到这里时，真正发生了什么
```

或：

```text
听 TA 把这段路讲清楚一点
```

聊天顶部建议使用：

```text
某某留下的经验回声
基于公开内容生成，不代表本人实时回应
```

展示注意：

- `boundary` 必须在入口附近或聊天开始处可见。
- 避免使用“本人回应”“作者在线”“和 TA 本人聊聊”等文案。
- 如果 `people[].canChat !== true` 或 `people[].aiPersona.canChat !== true`，不要展示可聊入口，只展示“查看来源片段”。
- 顶层 `personas[]` 仅是兼容快捷索引；前端应从 `people[].aiPersona` 派生，并按 `canChat` 分为“可追问的经验回声”和“仅查看来源片段”。

## 作者内容总结 / 前人经历总结

前端需要优先读取：

```text
people[].experienceSummary
```

展示条件：

- `people[].experienceSummaryStatus === "ready"`
- `people[].experienceSummarySource === "llm"`
- `people[].experienceSummary` 是非空字符串

该字段的目标不是普通搜索摘要，也不是建议清单，而是基于高质量候选内容、evidence、当前 query 和 candidateQuality 由 LLM 批量生成的经历总结。文案应呈现“作者/样本遇到的处境、做出的选择、代价/转折/结果、为什么和当前问题相关”。

不要把这些字段当作主展示：

- `people[].articles[].summary`：这是文章/回答摘要 fallback，更像内容片段。
- `people[].oneLine`：这是人物卡一句话，不等于完整经历总结。
- `people[].lesson`：这是谨慎启发/风险提醒，不是作者经历复盘，默认不和 `experienceSummary` 同屏。
- `debug.experienceSummaryDebug[].fallbackSummary`：只用于联调排查，不能展示给用户。

当 `experienceSummaryStatus` 是 `pending` 或 `failed` 时，前端应隐藏该区域或展示“总结暂不可用”的轻量状态；不要把规则生成的 `fallbackSummary`、`oneLine`、`lesson` 拼成“作者内容总结”。

## personas[] 是可选快捷索引

顶层 `personas[]` 只用于兼容快速入口，当前后端主响应默认不返回。前端应从 `people[].aiPersona` 派生同等入口：

```json
{
  "personaId": "persona_person_001",
  "personId": "person_001",
  "displayName": "阿禾的经验分身",
  "entryType": "chat"
}
```

使用方式：

- 渲染“可追问的经验分身”横向入口时，默认读 `people[].aiPersona` 派生数据。
- 如果 `personas[]` 缺失或为空，用 `people[].aiPersona.personaId / displayName / boundary / suggestedQuestions` 派生快捷入口。
- 需要头像、文章、匹配理由、路径等完整信息时，用 `personId` 回查 `people[]`。
- 不要把 `personas[]` 当成第二套人物主数据。

## articles[] 字段 fallback

每个 `people[].articles[]` 至少应能支撑原文入口和证据展示。

推荐字段：

- `title`：文章/回答标题。
- `text`：原文摘要或正文片段。
- `url`：原文链接。
- `author`：作者展示名。
- `avatar`：作者头像。
- `evidence[]`：证据片段数组。
- `summary`：更适合卡片展示的摘要。
- `sourceName`：例如“知乎回答”。
- `sourceUrl`：原文链接，通常等于 `url`。
- `body[]`：正文块，P0 可以为空数组。

兜底规则：

- `title` 为空：使用 `summary`；仍为空则使用 `text` 的前 24 个字符；再为空展示“未命名内容”。
- `text` 为空：使用 `summary`；仍为空则只展示标题和 evidence。
- `url` / `sourceUrl` 为空：隐藏“查看原文”按钮，但保留来源说明。
- `author` 为空：展示“知乎用户”。
- `avatar` 为空：使用默认头像。
- `evidence[]` 为空：优先用 `text` 作为证据展示；仍为空时隐藏证据区，但不要把无证据内容包装成事实。

## features 使用方式

`features` 是后端给前端的能力开关，不是页面文案。

建议字段：

```json
{
  "aiPersona": true,
  "personaChat": "mock",
  "saveSample": false,
  "articleBody": false,
  "sourceEvidenceRequired": true
}
```

前端建议：

- `features.aiPersona === true`：允许展示 AI 分身入口，但仍需检查 `people[].aiPersona.enabled`。
- `features.personaChat === "off"`：隐藏聊天入口或置灰。
- `features.personaChat === "mock"`：可以进入聊天，但以 mock/stub 体验展示。
- `features.personaChat === "real"`：允许真实后端聊天。
- `features.saveSample === false`：P0 保存样本可用本地 mock/localStorage，或隐藏跨端保存入口。
- `features.articleBody === false`：原文阅读器优先跳转 `sourceUrl`，不要期待后端返回完整正文。
- `features.sourceEvidenceRequired === true`：无 evidence 的事实性展示必须降级。

## debug.candidateQuality

real 模式下，`debug.intentStage.objectiveSlots` 会列出 intent_expand 抽取的客观槽位，例如年龄、行业、公司类型、岗位、城市、状态、方向和现实约束；`debug.intentStage.missingSlots` 表示更值得澄清的槽位；`debug.intentStage.queryPlan.primary / secondary / fallback` 展示分层后的搜索策略。前端可把这些字段放在联调面板，不应作为用户可见事实文案。

`debug.searchQueries[]` 会列出 intent_expand 生成的知乎搜索召回计划；每项包含 `query / type / priority / purpose`。`debug.searchQueryResults[]` 会按 query 展示本次真实搜索返回数量，`mergedCandidateCount / dedupedCandidateCount / validCandidateCount` 分别表示合并前候选数、去重后候选数和进入核心证据筛选后的有效候选数。

`debug.candidateQuality[]` 会列出本次召回候选的质量判断，方便联调筛选结果：

- `matchedQuery`：这条候选最先由哪条搜索 query 召回。
- `queryType`：对应搜索方向，例如 `real_experience`、`failure_review`。
- `queryPurpose`：该 query 的召回目的。
- `relevanceScore`：候选与 query 的规则相关度，0 到 1。
- `qualityScore`：综合正文长度、信息密度、具体变量和证据可用性的质量分。
- `experienceSignalScore`：第一人称、时间线、决策过程、结果反馈等亲历信号强度。
- `contentLength`：候选正文长度，不含标题。
- `filterReason`：说明被使用、降权或剔除的主要原因。
- `usedAsEvidence`：是否进入 `paths / people / personas` 的核心 evidence。

前端不要把这个 debug 字段当作正式展示文案；它主要用于确认低字数、低信息量、纯建议内容没有被放进核心样本。

## P0 可 fallback/mock 的能力

P0 阶段允许这些能力 fallback/mock：

- 保存样本：可先用前端 localStorage 或禁用。
- 完整多轮聊天：可先只支持一次 grounded mock answer。
- 原文正文阅读器：可先展示 `summary + evidence + sourceUrl`。
- 复杂人物聚合：可先“一条内容包装成一个 people”。
- LLM 生成：无 LLM Key 时必须用 deterministic stub。
- 知乎搜索：无知乎 API Key 时必须用 mock 数据完整跑通。

## 兼容 GET /api/search

旧接口仍然有效：

```http
GET /api/search?query=不工作了能去哪儿&count=1
```

成功时返回：

- `success`
- `data.query`
- `data.count`
- `data.hasMore`
- `data.searchHashId`
- `data.items[]`

`data.items[]` 字段：

- `id`
- `type`
- `title`
- `text`
- `url`
- `author.name`
- `author.avatar`
- `author.badge`
- `author.badgeText`
- `stats.commentCount`
- `stats.voteUpCount`
- `stats.rankingScore`
- `comments`
- `editTime`
- `authorityLevel`
- `source.provider`
- `source.url`
- `evidence.text`
- `evidence.source.provider`
- `evidence.source.url`

旧接口缺失字段归一规则仍然有效：

- 字符串缺失：返回 `""`。
- 数字缺失：返回 `0`。
- 数组缺失：返回 `[]`。
- `items` 无结果：返回 `[]`，不是 `null`。

## 与 OpenAPI 和样例的关系

- `shared/openapi.yaml` 是契约来源，既保留 `GET /api/search`，也定义 `POST /api/demo/search` 与 `POST /api/personas/chat` 的目标结构。
- `shared/demo-response.sample.json` 是前端 P0 字段样例，AI 分身页面优先看其中的 `demo_search_success_response`。
- OpenAPI 中标记为 planned / planned-p0 / planned-p0.5 的接口代表后续实现目标；当前没有实现时，前端开发可以先用 sample json 或 mock server。
