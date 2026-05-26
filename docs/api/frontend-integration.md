# 前端联调指南

本文面向前端接入 demo 页面，不要求阅读后端代码。主线只有一个：启动后端，调用 `POST /api/demo/search`，按 `analysis + paths + people + personas + sections + meta` 渲染。

## 1. 启动后端

项目根目录：

```bash
npm install
BACKEND_PORT=8000 npm run dev:backend
```

后端默认地址：

```text
http://127.0.0.1:8000
```

检查服务：

```bash
curl -s http://127.0.0.1:8000/health
curl -s http://127.0.0.1:8000/api/health
```

如果前端使用 Vite / Next.js / webpack dev server，建议配置代理：

```text
/api -> http://127.0.0.1:8000
```

页面代码里请求同源 `/api/demo/search` 即可。这样可以避开本地跨端口 CORS 问题，也方便之后切换部署地址。

## 2. 请求 Demo Search

接口：

```http
POST /api/demo/search
Content-Type: application/json
```

请求体：

```json
{
  "query": "不工作了能去哪儿",
  "count": 3,
  "dataMode": "mock"
}
```

字段说明：

| 字段 | 类型 | 必填 | 说明 |
|---|---|---:|---|
| `query` | string | 是 | 用户输入的问题，不能为空。 |
| `count` | number | 否 | 希望召回的数量，后端会限制在 1 到 20；不传默认 5。 |
| `dataMode` | string | 否 | `mock`、`cache_first`、`replay`、`real`；不传时读取环境变量，默认 `mock`。 |
| `clarificationAnswers` | object | 否 | 用户提交澄清卡后传入。存在非空答案时，接口返回 intent/searchPlan，不返回完整结果页数据。 |

注意：当前实际后端读取 `dataMode`。如果旧 mock 或 OpenAPI 草稿里写过 `mode`，前端联调时请改成 `dataMode`。

浏览器请求示例：

```ts
const response = await fetch("/api/demo/search", {
  method: "POST",
  headers: {
    "Content-Type": "application/json"
  },
  body: JSON.stringify({
    query: "不工作了能去哪儿",
    count: 3,
    dataMode: "mock"
  })
});

const payload = await response.json();

if (!response.ok || payload.success !== true) {
  throw new Error(payload.error?.message || "请求失败");
}

const data = payload.data;
```

`curl` 示例：

```bash
curl -s -X POST http://127.0.0.1:8000/api/demo/search \
  -H "Content-Type: application/json" \
  -d '{"query":"不工作了能去哪儿","count":3,"dataMode":"mock"}'
```

## 3. 成功响应

没有 `clarificationAnswers` 时，成功响应是完整 demo 结果：

成功外壳：

```json
{
  "success": true,
  "data": {
    "schemaVersion": "demo.v1",
    "queryId": "query_xxx",
    "query": "不工作了能去哪儿",
    "dataMode": "mock",
    "features": {},
    "analysis": {},
    "paths": [],
    "people": [],
    "personas": [],
    "sections": [],
    "meta": {},
    "debug": {}
  }
}
```

完整字段样例见 [demo-search.sample.json](./demo-search.sample.json)。前端联调优先以接口真实返回为准，样例用于 mock 和 UI 占位。

### 澄清卡后二次请求

当用户填写澄清卡后，请把答案放在 `clarificationAnswers`：

```json
{
  "query": "为了工作能追求自己想做的事，长期异地恋真的值得吗？",
  "clarificationAnswers": {
    "priority": "我更在意能不能追求自己想做的工作，但也不想轻易放弃关系",
    "duration": "可能异地 1-2 年",
    "relationshipStatus": "关系稳定，但对未来不确定",
    "wantedSamples": "想看真实经历，尤其是坚持下来和最后分开的两类人"
  }
}
```

该请求会返回：

```json
{
  "success": true,
  "data": {
    "intent": "relationship_career_tradeoff",
    "intentSummary": "用户正在权衡为了追求想做的工作而进入长期异地恋是否值得，希望参考真实经历，而不是获得单一建议。",
    "focusTags": ["事业选择与亲密关系冲突", "长期异地恋的现实成本", "坚持或分开的真实经历"],
    "searchPlan": {
      "coreQueries": ["异地恋 工作", "为了工作 异地恋", "职业发展 异地恋"],
      "expandedQueries": ["异地恋 分手 后悔", "异地恋 坚持下来"],
      "exploratoryQueries": ["为了事业选择异地恋"],
      "rankingSignals": ["真实经历", "长期异地", "坚持下来"],
      "negativeHints": ["不要优先使用纯鸡汤内容"],
      "expectedEvidenceTypes": ["亲身经历", "分手复盘"]
    },
    "debug": {
      "stage": "intent_expand",
      "llmUsed": false
    }
  }
}
```

这个阶段只准备“接下来去知乎搜什么”，不会返回 `paths`、`people`、`personas`。

## 4. 顶层字段解释

| 字段 | 说明 | 渲染建议 |
|---|---|---|
| `schemaVersion` | 契约版本，当前后端返回 `demo.v1`。 | 可用于兼容判断，不展示。 |
| `queryId` | 本次搜索 id。 | 后续保存、追问、埋点都带上。 |
| `query` | 后端实际处理的问题。 | 可展示在结果页标题或复盘区。 |
| `dataMode` | 请求或解析后的数据模式。 | dev 环境可显示，用户侧通常不展示。 |
| `features` | 功能开关。 | 决定 AI 分身、保存、正文和证据要求。 |
| `analysis` | 后端对问题的理解。 | 顶部摘要、焦点标签、loading 步骤。 |
| `paths[]` | 路径图。 | 渲染路径 tab、路径卡或 Sankey/flow 的节点。 |
| `people[]` | 人物样本主数据。 | 渲染人物卡、文章、匹配理由、AI 分身入口。 |
| `personas[]` | 可选兼容快捷索引，主响应默认省略。 | 从 `people[].aiPersona` 派生横向入口；点击后回查 `people[]`。 |
| `sections[]` | 可选页面分区辅助，主响应默认省略。 | 缺失时按默认顺序渲染，不替代主数据。 |
| `meta` | 来源、证据数量、生成时间、fallback 信息。 | dev 信息、来源统计、证据索引。 |
| `debug` | 联调调试信息。 | 只在 dev 面板展示。 |

## 5. analysis 渲染

当前 `analysis` 主要包含：

```json
{
  "summary": "已基于公开内容样本，将问题拆成几类路径。",
  "intent": "life_path_exploration",
  "focusTags": ["离开工作轨道", "生活节奏", "现金流"],
  "steps": [
    {
      "id": "step_understand_query",
      "label": "理解问题里的生活处境",
      "status": "done",
      "evidenceIds": ["ev_city_daily"],
      "sourceRefs": ["source_mock_city_walk"]
    }
  ]
}
```

渲染建议：

- `summary`：结果页顶部的一句话理解。
- `focusTags[]`：标签组。
- `steps[]`：loading 完成后的“系统如何分析”的轻量说明；`status` 目前多为 `done`。
- `steps[].evidenceIds/sourceRefs`：需要展示来源时可用，普通 UI 可不展示。

## 6. paths 渲染

`paths[]` 是路径图数据：

```json
{
  "id": "path_city_pause",
  "title": "先停靠，把日常重新排稳",
  "summary": "适合暂时不想立刻回到职场、需要先恢复生活秩序的人。",
  "stance": "experience",
  "evidenceIds": ["ev_city_daily", "ev_city_outdoor"],
  "sourceRefs": ["source_mock_city_walk"]
}
```

渲染建议：

- 使用 `path.id` 作为 React key。
- 展示 `title` 和 `summary`。
- `stance` 可映射为轻量标签：`experience` 经验、`viewpoint` 观点、`mixed` 混合。
- 按 `people[].pathId === path.id` 聚合人物样本，显示该路径下有多少人。
- 如果 `evidenceIds/sourceRefs` 为空，路径卡降级为普通建议，不展示“有证据支持”的视觉。

## 7. people 渲染

`people[]` 是唯一人物样本主数据。人物卡、文章入口、匹配理由和 AI 分身入口都从这里读。

关键结构：

```json
{
  "id": "person_city_pause",
  "name": "城市停靠样本",
  "pathId": "path_city_pause",
  "role": "基于公开回答整理的生活节奏样本",
  "badge": "先把日常排稳",
  "avatar": "",
  "oneLine": "这个样本提醒你，去哪里之前，可能先要知道一天怎么过。",
  "experienceSummary": null,
  "experienceSummarySource": "none",
  "experienceSummaryStatus": "pending",
  "who": "基于知乎公开回答整理出的前人样本，不等同于作者完整人生。",
  "overlaps": [],
  "timeline": [],
  "lesson": "地点能提供距离，但真正先稳住的是每天的生活节奏。",
  "articles": [],
  "match": {},
  "aiPersona": {},
  "evidenceIds": [],
  "sourceRefs": []
}
```

渲染建议：

- 主标题：`name`，缺失时显示“知乎用户”。
- 副信息：`role`、`badge`、所属 path 标题。
- 核心句：`oneLine`，只作为人物卡一句话钩子，不作为经历总结 fallback。
- 经历总结：只有 `experienceSummaryStatus === "ready"` 且 `experienceSummarySource === "llm"` 时展示 `experienceSummary`。
- 背景说明：`who`，注意它是公开内容整理，不是作者完整传记。
- 重叠点：`overlaps[]`。
- 时间线：`timeline[]`，每项都可通过 `evidenceIds/sourceRefs` 溯源。
- 谨慎启发：`lesson`，仅用于风险/提醒位置；不要把它当作“作者内容总结 / 前人经历总结”主字段，也不要默认和 `experienceSummary` 同屏。
- 原文入口：读 `articles[]`，优先使用 `sourceUrl`，再用 `url`。
- 匹配解释：读 `match.reasons[]`、`matchedVariables[]`、`riskNotes[]` 和分数字段。

不要把 `personas[]` 当人物列表，也不要在前端维护第二套完整人物对象。

`debug.experienceSummaryDebug[].fallbackSummary` 只用于联调排查。LLM 超时、内容不足或状态为 `pending/failed` 时，不要用 `oneLine`、`lesson`、`articles[].summary` 或 debug fallback 拼出经历总结。

## 8. articles / evidence / source

`people[].articles[]` 支撑原文入口和证据展示：

```json
{
  "id": "article_city_pause",
  "title": "失业不上班，你们都在干什么？",
  "text": "公开回答片段",
  "url": "https://www.zhihu.com/question/mock-city-walk/answer/mock-001",
  "author": "公开回答样本 A",
  "avatar": "",
  "sourceName": "知乎回答",
  "sourceUrl": "https://www.zhihu.com/question/mock-city-walk/answer/mock-001",
  "summary": "这条回答讨论了暂停上班后的日常节奏。",
  "evidence": [
    {
      "id": "ev_city_daily",
      "label": "日常节奏",
      "text": "公开回答提到，暂停上班后先把做饭、休息、散步和低成本生活重新排进每天。",
      "sourceRefId": "source_mock_city_walk",
      "sourceUrl": "https://www.zhihu.com/question/mock-city-walk/answer/mock-001"
    }
  ],
  "body": [],
  "sourceRefs": ["source_mock_city_walk"]
}
```

全局来源索引在 `meta.sourceRefs[]`：

```json
{
  "id": "source_mock_city_walk",
  "provider": "mock",
  "type": "mock_answer",
  "title": "失业不上班，你们都在干什么？",
  "url": "https://www.zhihu.com/question/mock-city-walk/answer/mock-001",
  "author": "公开回答样本 A",
  "evidenceIds": ["ev_city_daily", "ev_city_outdoor"]
}
```

使用规则：

- 展示事实、路径、人物总结、匹配理由前，尽量能找到对应 `evidenceIds` 或 `sourceRefs`。
- 证据片段优先读 `article.evidence[]`。
- 来源链接优先读 `article.sourceUrl`，其次 `article.url`，再按 `sourceRefId` 找 `meta.sourceRefs[].url`。
- `provider: "mock"` 说明是 demo 内置样本，不要包装成真实知乎生产数据。
- `provider: "zhihu"` 说明按知乎搜索契约映射；仍要结合 `dataMode` 判断是真实召回还是 replay fixture。
- 如果 evidence 为空，隐藏证据区或展示“来源不足”，不要补写事实。

## 9. match 渲染

`people[].match` 用来解释“为什么这个样本相关”：

```json
{
  "score": 0.88,
  "level": "high",
  "reasons": ["都在离开工作结构后寻找新的日常秩序"],
  "matchedVariables": ["生活节奏", "现金流"],
  "riskNotes": ["该样本只代表公开内容片段，不能代表作者完整人生"],
  "contentRelevance": 0.9,
  "experienceSimilarity": 0.8,
  "evidenceQuality": 0.78,
  "personaReadiness": 0.76,
  "evidenceIds": ["ev_city_daily"],
  "sourceRefs": ["source_mock_city_walk"]
}
```

渲染建议：

- `level` 比 `score` 更适合给用户看，可显示“高相关 / 中相关 / 低相关”。
- `reasons[]` 是匹配理由。
- `riskNotes[]` 是必须保留的风险边界，尤其是公开内容不足、不能代表完整人生。
- `personaReadiness` 可决定 AI 分身入口的视觉强弱，但最终还要看 `aiPersona.enabled`。

## 10. AI 分身入口

入口挂在 `people[].aiPersona`：

```json
{
  "enabled": true,
  "personaId": "persona_city_pause",
  "displayName": "城市停靠样本的经验回声",
  "label": "基于公开内容生成",
  "openingLine": "你可以继续问这段公开内容里的选择、代价和边界。",
  "suggestedQuestions": [
    "这段公开内容里，日常节奏是怎么重新建立的？"
  ],
  "boundary": "该 AI 分身基于公开内容生成，不代表作者本人。",
  "grounding": {
    "personId": "person_city_pause",
    "articleIds": ["article_city_pause"],
    "evidenceRequired": true,
    "sourceRefs": ["source_mock_city_walk"]
  }
}
```

展示入口前检查：

- `features.aiPersona === true`
- `features.personaChat !== "off"`
- `aiPersona.enabled === true`
- `aiPersona.personaId` 非空
- `aiPersona.boundary` 非空
- `aiPersona.grounding.articleIds[]` 能关联到 `people[].articles[].id`

边界文案必须在入口附近或聊天开始处可见：

```text
该 AI 分身基于公开内容生成，不代表作者本人。
```

推荐文案方向：

- “经验回声”
- “继续理解这段公开经历”
- “问问这段经历里真正发生了什么”

避免文案：

- “联系 TA”
- “和作者本人聊聊”
- “作者在线回复”
- “私信”
- “让 TA 回答你”

AI 分身可以有人味，但事实不能拟人化。它只能基于公开内容和 evidence 回答，不代表作者本人，也不是新的事实来源。

## 11. personas 快捷索引

顶层 `personas[]` 是兼容快捷入口，当前后端主响应默认不返回。缺失时前端应从 `people[].aiPersona` 派生入口：

```json
{
  "id": "persona_city_pause",
  "personId": "person_city_pause",
  "displayName": "城市停靠样本的经验回声",
  "avatar": "",
  "personaType": "experience_echo",
  "intro": "你可以继续问这段公开内容里的选择、代价和边界。",
  "boundaryNotice": "该 AI 分身基于公开内容生成，不代表作者本人。",
  "sourceRefs": ["source_mock_city_walk"],
  "suggestedQuestions": []
}
```

使用方式：

- 可渲染“可追问的经验回声”横向列表；默认从 `people[].aiPersona` 派生。
- `personas[]` 缺失或为空时，用 `people[].aiPersona.personaId / displayName / boundary / suggestedQuestions` 派生快捷索引。
- 点击后用 `personId` 回查 `people[]`，读取头像、文章、匹配理由、path 等完整数据。
- `personas[]` 不维护完整人物对象，不做人物主数据。

## 12. sections 布局辅助

`sections[]` 是兼容弱绑定布局层，当前后端主响应默认不返回：

```json
{
  "id": "section_people",
  "type": "people",
  "title": "前人样本",
  "itemRefs": ["person_city_pause", "person_side_income"]
}
```

使用方式：

- 如果后端返回 `sections[]`，可用它决定页面模块顺序和标题。
- `itemRefs[]` 只是引用 id，具体数据仍回到 `paths[]`、`people[]` 和从 `people[].aiPersona` 派生的 persona 入口。
- 如果缺少 `sections[]` 或某个引用找不到，前端可按固定顺序渲染：`analysis -> paths -> people -> personas`。

## 13. features 能力开关

示例：

```json
{
  "aiPersona": true,
  "personaChat": "mock",
  "saveSample": false,
  "articleBody": false,
  "sourceEvidenceRequired": true
}
```

处理建议：

- `aiPersona: false`：隐藏所有 AI 分身入口。
- `personaChat: "off"`：隐藏或置灰聊天入口。
- `personaChat: "mock"`：可以进入 demo 聊天体验，但 UI 可标记为 demo/stub。
- `personaChat: "real"`：可以走真实聊天链路。
- `saveSample: false`：保存样本先走前端 localStorage 或隐藏服务端保存。
- `articleBody: false`：不要期待完整正文阅读器，优先展示 `summary + evidence + sourceUrl`。
- `sourceEvidenceRequired: true`：无证据的事实性内容必须降级。

## 14. dataMode 区别

| 模式 | 什么时候用 | 当前行为 | 前端提示 |
|---|---|---|---|
| `mock` | 默认开发联调 | 使用后端内置 mock/stub，不依赖知乎 Key 或 LLM Key。 | 最稳定，推荐日常 UI 开发使用。 |
| `cache_first` | 缓存优先联调 | `/api/demo/search` 未命中请求级缓存时仍生成 deterministic mock；底层知乎搜索 provider 会先读 fixture，缺失时只有显式允许真实调用才请求知乎。 | 日常脚本默认可用，不应消耗真实知乎 API。 |
| `replay` | 固定 fixture 回放 | 走真实产品层组合链路，但知乎搜索只读 `backend/fixtures/zhihu-search`；缺少 fixture 直接报错。 | 推荐后端/LLM/eval 稳定验证。 |
| `real` | 验证真实知乎召回组合 | 先命中本地 fixture/cache；缺失时才尝试真实知乎 API，并受 `ZH_API_DAILY_DEV_BUDGET` 限制。失败或无结果默认返回错误。 | 只有请求显式传 `allowMockFallback: true` 才允许 mock 兜底。 |

无知乎 API Key、无 LLM Key 时，`mock` 必须完整可用；需要固定知乎召回时优先用 `replay`。真实链路联调请使用 `DATA_MODE=real` 或 `ALLOW_REAL_ZH_API=1` 明确打开，让失败显性暴露；演示兜底才显式传 `allowMockFallback: true`。

## 15. 常见错误码

错误响应格式：

```json
{
  "success": false,
  "error": {
    "code": "QUERY_REQUIRED",
    "message": "Missing required body field: query"
  }
}
```

| HTTP | `error.code` | 常见原因 | 前端建议 |
|---:|---|---|---|
| 400 | `QUERY_REQUIRED` | `query` 缺失、空字符串或请求体不是对象。 | 输入框提示“请输入问题”。 |
| 400 | `DATA_MODE_INVALID` | `dataMode` 不是 `mock`、`cache_first`、`replay`、`real`。 | 开发期报配置错误；生产可回退 `mock`。 |
| 404 | `ZHIHU_REPLAY_FIXTURE_MISSING` | `replay` 模式缺少对应 query fixture。 | 提示后端补 fixture，不要自动切到真实 API。 |
| 404 | `ROUTE_NOT_FOUND` | URL、base path 或方法错误。 | 检查是否是 `POST /api/demo/search`，以及代理是否生效。 |
| 500 | `INTERNAL_SERVER_ERROR` | 未预期服务端异常。 | 展示通用失败态，保留请求参数给后端排查。 |

底层兼容接口 `GET /api/search` 支持 `dataMode=replay/cache_first/real` 调试。前端 AI 分身页面不应直接依赖该接口；如需调试知乎召回，让后端同学使用它定位。

## 16. 前端兜底清单

- `paths[]` 为空：隐藏路径图，直接展示 `people[]`。
- `people[]` 为空：展示空状态，不要用 `personas[]` 伪造人物卡。
- `person.avatar` 为空：使用默认头像。
- `article.url/sourceUrl` 为空：隐藏“查看原文”按钮。
- `article.evidence[]` 为空：隐藏证据区或提示“来源片段不足”。
- `aiPersona.enabled` 为 false：隐藏聊天入口。
- `features.personaChat` 为 `off`：隐藏或置灰聊天入口。
- `meta.fallbackUsed` 为 true：dev 面板提示已降级，不影响用户主流程。

## 17. 最小联调验收

前端接入完成后，至少确认：

- 能在本地请求 `POST /api/demo/search` 并拿到 `success: true`。
- `mock` 模式无知乎 Key、无 LLM Key 也能完整渲染。
- 页面从 `people[]` 渲染人物卡，而不是从 `personas[]` 渲染人物主数据。
- 每个事实性模块能展示证据片段或原文入口。
- AI 分身入口显示边界文案，且没有“联系 TA / 本人回复 / 私信”等误导文案。
- 错误响应按 `success: false` 和 `error.code` 进入失败态。
