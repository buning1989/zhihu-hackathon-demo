# 后端 AI 分身集成计划

版本：v0.2
日期：2026-05-13
范围：后端产品层接口与 AI 分身兼容层文档规划

## 1. 背景与边界

当前后端已经基于 Node.js + TypeScript + Express 实现了 `GET /api/search`，可以把知乎搜索结果映射为前端友好的 `items[]`。前端新增 AI 分身体验后，单纯的内容召回结果已经不足以支撑页面，需要新增一层产品结构：

```text
analysis + paths + people + personas + sections + meta
```

本轮只更新文档和契约，为后续开发做准备：

- 不切换技术栈。
- 不重构已有 `GET /api/search`。
- 不删除 `GET /api/search` 或 `/api/zhihu/search`。
- 不把 AI 分身做成独立主数据。
- 不实现“联系 TA”、私信、模拟作者本人回复等能力。

早期文档中的 `POST /api/v1/match/query` 可以保留为 future API。当前 P0 产品层主接口统一收敛到：

```http
POST /api/demo/search
```

## 2. 接口收敛

### 2.1 保留的既有接口

```http
GET /health
GET /api/health
GET /api/search?query=...&count=...
GET /api/zhihu/search?query=...&count=...
```

定位：

- `GET /api/search`：已实现的知乎搜索映射接口，继续用于调试、兼容和底层召回。
- `GET /api/zhihu/search`：已实现的知乎原始响应代理，前端不直接依赖。
- 健康检查接口保持现状。

### 2.2 新增产品层接口

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

`mode` 建议支持：

- `mock`：只用本地 mock / deterministic stub。
- `cache_first`：优先缓存，必要时尝试真实知乎 API。
- `real`：优先真实知乎 API，失败时按策略降级。

无知乎 API Key、无 LLM Key 时，`mock/stub` 也必须完整跑通，返回同形状产品结构，不能让前端主流程断掉。

### 2.3 新增 AI 分身聊天接口

```http
POST /api/personas/chat
Content-Type: application/json
```

P0.5 阶段可先返回 grounded mock answer。无 LLM Key 时必须走 stub，但响应仍必须包含 `boundary`、`citedArticleIds` 和 `evidence`。

## 3. 返回结构

`POST /api/demo/search` 的目标响应结构：

```json
{
  "schemaVersion": "2026-05-13.ai-persona-v1",
  "queryId": "query_demo_001",
  "query": "不工作了之后，我想去新西兰生活",
  "dataMode": "mock",
  "features": {
    "aiPersona": true,
    "personaChat": "mock",
    "saveSample": false,
    "articleBody": false,
    "sourceEvidenceRequired": true
  },
  "analysis": {
    "steps": [],
    "focusTags": []
  },
  "paths": [],
  "people": [],
  "personas": [],
  "sections": [],
  "meta": {},
  "debug": {}
}
```

字段职责：

| 字段 | 作用 | P0 要求 |
|---|---|---:|
| `schemaVersion` | 标记产品层契约版本 | 必须 |
| `queryId` | 串联搜索、保存、聊天和回看 | 必须 |
| `query` | 用户原始输入或服务端裁剪后的输入 | 必须 |
| `dataMode` | 标记 `mock/cache_first/real` | 必须 |
| `features` | 前端能力开关 | 必须 |
| `analysis` | 问题理解和 loading 过程 | 必须 |
| `paths` | 路径图 | 必须 |
| `people` | 前人样本主数据 | 必须 |
| `personas` | AI 分身快捷索引 | 建议 |
| `sections` | 弱绑定 UI 扩展层 | 建议 |
| `meta` | 来源、耗时、统计信息 | 建议 |
| `debug` | 联调排错信息，仅 dev 暴露 | 建议 |

## 4. people 是主数据

`people[]` 是本产品的主数据。每个 people 表示一个基于公开知乎内容构建的前人样本，可以来自一条内容，也可以在 P1 后由多条内容聚合而成。

P0 最小字段：

```json
{
  "id": "person_001",
  "name": "阿禾",
  "pathId": "return-home",
  "role": "前互联网运营",
  "badge": "离开工作轨道后短暂停靠",
  "avatar": "",
  "oneLine": "她把去远方当作暂停键，后来发现真正要处理的是工作边界。",
  "who": "基于公开回答整理出的前人样本，不等同于作者完整人生。",
  "overlaps": ["都在重新判断工作和生活的关系"],
  "timeline": [{ "date": "公开内容片段", "event": "离开高压工作后重新整理生活节奏" }],
  "lesson": "地点可以提供距离，但不能自动解决职业倦怠。",
  "articles": [],
  "match": {},
  "aiPersona": {}
}
```

要求：

- `people[].pathId` 必须能关联到 `paths[].id`。
- `people[].articles[]` 必须保留原文入口和 evidence。
- `people[].match` 解释为什么这个样本匹配当前问题。
- `people[].aiPersona` 是 AI 分身入口，不是另一套人物数据。
- 不要把观点作者包装成亲历者。公开内容不足时，应降级为“观点样本”或关闭分身入口。

## 5. articles 与 evidence

每个 `people[].articles[]` 至少包含：

```json
{
  "id": "article_001",
  "title": "裸辞以后可以去哪里",
  "text": "原文摘要或正文片段",
  "url": "https://www.zhihu.com/question/mock/answer/mock",
  "author": "知乎作者",
  "avatar": "",
  "sourceName": "知乎回答",
  "sourceUrl": "https://www.zhihu.com/question/mock/answer/mock",
  "summary": "这条回答讨论了离开工作结构后的方向感、收入和生活节奏问题。",
  "evidence": [
    {
      "label": "方向感",
      "text": "证据片段",
      "sourceUrl": "https://www.zhihu.com/question/mock/answer/mock"
    }
  ],
  "body": []
}
```

从 `GET /api/search` 到产品层的基础映射：

| 当前搜索字段 | 产品层字段 |
|---|---|
| `items[].id` | `people[].articles[].id` |
| `items[].title` | `people[].articles[].title` |
| `items[].text` | `people[].articles[].text` / `summary` / `evidence[].text` |
| `items[].url` | `people[].articles[].url` / `sourceUrl` |
| `items[].author.name` | `people[].articles[].author` / `people[].name` |
| `items[].author.avatar` | `people[].articles[].avatar` / `people[].avatar` |
| `items[].type` | `people[].articles[].sourceName` |
| `items[].evidence` | `people[].articles[].evidence[]` |

AI 不作为事实来源。人物卡、匹配理由、AI 分身回答都必须能回到 `articles[]` 或 `evidence[]`。

## 6. match 字段

`people[].match` 用来解释“为什么这个人和当前用户问题相关”：

```json
{
  "score": 0.86,
  "level": "high",
  "reasons": [
    "都在暂停工作后重新判断生活方向",
    "公开内容中提到了现金流和回流代价"
  ],
  "matchedVariables": ["暂停工作", "地点选择", "现金流"],
  "riskNotes": ["公开内容不足以代表完整人生和长期结果"],
  "contentRelevance": 0.9,
  "experienceSimilarity": 0.82,
  "evidenceQuality": 0.76,
  "personaReadiness": 0.7
}
```

P0 可规则生成，但每条 reason 必须能从公开内容或 mock evidence 中找到依据。

## 7. aiPersona 挂载方式

每个 `people[]` 下挂 `aiPersona`：

```json
{
  "enabled": true,
  "personaId": "persona_person_001",
  "displayName": "阿禾的经验分身",
  "label": "基于公开内容生成",
  "openingLine": "你可以问我：当时为什么离开，以及后来怎么判断要不要回来。",
  "suggestedQuestions": [
    "你当时最担心什么？",
    "这条路最大的代价是什么？"
  ],
  "boundary": "这是基于知乎公开内容生成的经验回应，不代表作者本人。",
  "grounding": {
    "personId": "person_001",
    "articleIds": ["article_001"],
    "evidenceRequired": true
  }
}
```

原则：

- `aiPersona.enabled = false` 时，前端只展示人物卡，不展示聊天入口。
- `aiPersona.boundary` 必须存在。
- `grounding.articleIds[]` 必须能关联到 `people[].articles[]`。
- AI 分身不代表作者本人，不提供实时回应，不承诺还原作者意图。
- 回答必须基于公开内容和 evidence。

### 7.1 AI 分身 prompt 方案

本轮补充两类 AI 分身 prompt，并纳入后端统一 prompt 管理：

- Persona Composer：生成 `people[].aiPersona`，用于判断分身入口是否可展示，并输出开场白、推荐追问、边界说明、grounding 和 `personaReadiness`。
- Persona Chat：支撑 `POST /api/personas/chat`，用于基于公开内容和 evidence 生成追问回答。

核心原则：

```text
表达拟人化，事实不拟人化。
```

要求：

- `people[].aiPersona` 是分身入口，不是另一套人物主数据。
- `POST /api/personas/chat` 使用固定 system prompt + 动态 `persona_context`。
- 每个分身的差异来自动态 `persona_context`，至少包含 `userQuery`、`person`、`articles`、`evidence`、`aiPersona`、`history`。
- 不为每个作者生成独立 system prompt。
- AI 分身不代表作者本人，不提供作者本人实时回应，不承诺还原作者真实意图。
- 允许表达层更有人味，但事实必须来自公开内容、`articles[]`、`evidence[]` 或 `ContentText`。
- evidence 不足时，不能强行生成可聊分身；追问回答应返回 `insufficient_evidence`。

落地文件：

- `backend/app/prompts/persona_composer_system.md`
- `backend/app/prompts/persona_chat_system.md`
- `docs/prompts/persona-composer.system.md`
- `docs/prompts/persona-chat.system.md`
- `backend/src/prompts/personaComposerPrompt.ts`
- `backend/src/prompts/personaChatPrompt.ts`
- `backend/src/prompts/personaPromptBuilder.ts`

## 8. personas 快捷索引

顶层 `personas[]` 只作为前端快捷索引：

```json
{
  "personaId": "persona_person_001",
  "personId": "person_001",
  "displayName": "阿禾的经验分身",
  "entryType": "chat"
}
```

要求：

- 不在 `personas[]` 里重复完整人物数据。
- 不让 `personas[]` 成为第二套主数据。
- 需要完整信息时，前端回到 `people[]` 读取。

## 9. sections 弱绑定层

`sections[]` 用于保留前端改版空间，不替代主数据：

```json
[
  {
    "id": "paths-section",
    "type": "path_map",
    "title": "几种可能的走法",
    "cards": []
  },
  {
    "id": "people-section",
    "type": "people_samples",
    "title": "和你处境相似的人",
    "cards": []
  },
  {
    "id": "persona-section",
    "type": "ai_personas",
    "title": "可以继续追问的经验分身",
    "cards": []
  }
]
```

前端 P0 优先读主数据字段，`sections[]` 只做布局辅助。

## 10. P0 / P0.5 / P1 切分

### P0 必须完成

- 新增 `POST /api/demo/search`。
- 返回 `schemaVersion`、`queryId`、`features`。
- 返回 `analysis.steps` 和 `analysis.focusTags`。
- 返回 2-5 条 `paths[]`。
- 返回 `people[]`，并保证每个 people 至少有一条 article、match、aiPersona。
- 返回顶层 `personas[]` 快捷索引。
- 无知乎 API Key 时 mock 跑通。
- 无 LLM Key 时 deterministic stub 跑通。
- 保留 `GET /api/search` 既有契约。

### P0.5 建议完成

- 新增 `POST /api/personas/chat`。
- 支持一次 grounded mock answer。
- 每次聊天响应带 `boundary`、`citedArticleIds`、`evidence`。
- 返回 `sections[]` 和 dev `debug`，方便联调。
- 保存样本可先由前端 localStorage 或 mock 完成。

### P1 暂缓

- 完整多轮 Grounded QA。
- 样本保存、已保存列表和跨设备同步。
- 多内容复杂人物聚合。
- 完整原文阅读器正文。
- `/api/v1/match/query` 等正式长期 API。

## 11. 验收标准

文档契约验收：

- `shared/openapi.yaml` 能被 YAML parser 读取。
- `shared/demo-response.sample.json` 能被 JSON parser 读取。
- OpenAPI 中保留 `GET /api/search`。
- OpenAPI 中新增或修正 `POST /api/demo/search` 和 `POST /api/personas/chat`。
- 样例中 `people[]` 是主数据，`personas[]` 只引用 `people[].aiPersona`。

后续实现验收：

- `npm run build -w backend` 通过。
- `GET /api/health` 不受影响。
- `GET /api/search?query=不工作了能去哪儿&count=5` 不受影响。
- `POST /api/demo/search` 在无知乎 API Key、无 LLM Key 时也返回完整产品结构。
- `POST /api/personas/chat` 在 stub 模式下也返回 grounded answer。
- 所有知乎内容卡片、详情、分身回答都绑定 `source/evidence`。
- AI 分身边界文案明确说明“不代表作者本人”。
