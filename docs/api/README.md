# API 协作说明

本文是前后端联调入口。前端同学只需要看本目录，就能启动后端、调用 demo 主接口并理解返回字段。

- 详细联调指南：[frontend-integration.md](./frontend-integration.md)
- 完整响应样例：[demo-search.sample.json](./demo-search.sample.json)
- OpenAPI 契约：[shared/openapi.yaml](../../shared/openapi.yaml)

## 后端启动

在项目根目录执行：

```bash
npm install
BACKEND_PORT=8000 npm run dev:backend
```

健康检查：

```bash
curl -s http://127.0.0.1:8000/health
curl -s http://127.0.0.1:8000/api/health
```

前端本地开发建议把 `/api` 代理到 `http://127.0.0.1:8000`，然后在页面里请求同源路径 `/api/demo/search`。如果直接从浏览器跨端口请求 `http://127.0.0.1:8000`，需要另外确认 CORS 配置。

## 前端主接口

前端产品层主入口：

```http
POST /api/demo/search
Content-Type: application/json
```

最小请求：

```json
{
  "query": "不工作了能去哪儿",
  "count": 3,
  "dataMode": "mock"
}
```

当前后端读取的字段名是 `dataMode`，可选值是 `mock`、`cache_first`、`real`。早期文档里的 `mode` 只表示同一个概念，前端联调时请发送 `dataMode`。

`curl` 示例：

```bash
curl -s -X POST http://127.0.0.1:8000/api/demo/search \
  -H "Content-Type: application/json" \
  -d '{"query":"不工作了能去哪儿","count":3,"dataMode":"mock"}'
```

## 响应外壳

成功响应统一为：

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

错误响应统一为：

```json
{
  "success": false,
  "error": {
    "code": "QUERY_REQUIRED",
    "message": "Missing required body field: query"
  }
}
```

## 字段地图

| 字段 | 前端用途 |
|---|---|
| `schemaVersion` | 当前 demo 契约版本，现阶段是 `demo.v1`。 |
| `queryId` | 串联搜索结果、保存、AI 分身追问。 |
| `query` | 后端实际处理的用户问题。 |
| `dataMode` | 本次数据来源策略：`mock`、`cache_first` 或 `real`。 |
| `features` | 能力开关，例如 AI 分身、聊天模式、服务端保存和正文可用性。 |
| `analysis` | 问题理解、焦点标签、处理步骤，可用于顶部理解区或 loading 过程。 |
| `paths[]` | 路径图数据，按 `id` 被 `people[].pathId` 关联。 |
| `people[]` | 人物样本主数据，人物卡、文章、匹配理由和 AI 分身入口都从这里读。 |
| `personas[]` | AI 分身快捷索引，只做入口导航，不是第二套人物数据。 |
| `sections[]` | 弱绑定布局辅助，可决定页面分区和排序。 |
| `meta.sourceRefs[]` | 来源索引，配合 `sourceRefs` 和 `evidenceIds` 做溯源。 |
| `debug` | 联调用调试信息，线上 UI 不展示。 |

## 渲染关系

- `paths[]`：渲染路径图或路径 tab。每个 path 的 `evidenceIds` / `sourceRefs` 可用于显示“来自几条公开内容”。
- `people[]`：渲染人物样本卡。按 `person.pathId` 找到对应 path；按 `articles[]` 展示原文入口；按 `match` 展示匹配解释。
- `people[].aiPersona`：渲染单个人物卡上的 AI 分身入口。展示前检查 `enabled`、`personaId`、`boundary` 和 `grounding.articleIds[]`。
- `personas[]`：渲染“可追问的经验回声”快捷入口。点击后用 `personId` 回查 `people[]`，不要从 `personas[]` 补全人物信息。

## Evidence / Source

AI 不是事实来源。所有人物描述、路径总结、匹配理由和 AI 分身回答，都必须能回到 `evidence/source`。

前端展示事实性内容时建议：

- 优先展示 `people[].articles[].evidence[]` 中的证据片段。
- 用 `article.sourceUrl` / `article.url` 做“查看原文”链接。
- 用 `meta.sourceRefs[]` 作为全局来源索引，按 `sourceRefs` 或 `sourceRefId` 找来源标题、作者、URL。
- 如果某个事实没有 evidence，降级为弱提示、隐藏证据区或只展示原文入口，不要包装成确定结论。

## AI 分身边界

固定边界文案：

```text
该 AI 分身基于公开内容生成，不代表作者本人。
```

前端必须避免：

- 暗示作者本人在线、本人回复或可联系 TA。
- 展示“私信”“联系作者”“和本人聊聊”等动作。
- 把 AI 生成内容当作新的事实来源。

推荐把入口表达成“经验回声”“继续理解这段公开经历”。如果 `people[].aiPersona.enabled === false` 或 grounding 不完整，就隐藏聊天入口，只保留人物卡和原文入口。

## dataMode 区别

| `dataMode` | 适用场景 | 当前行为 |
|---|---|---|
| `mock` | 默认联调、无知乎 Key、无 LLM Key | 使用后端内置 mock/stub，稳定返回完整结构。 |
| `cache_first` | 预留缓存优先链路 | 当前仍用内置 mock seed 保持 demo 闭环，`debug.notes` 会标记。 |
| `real` | 尝试真实知乎召回 | 调用底层 `GET /api/search` 组合产品层结构；失败或无结果时降级 mock，`meta.fallbackUsed` 和 `debug.resolvedDataMode` 会说明。 |

## 常见错误码

| HTTP | `error.code` | 原因 | 前端处理 |
|---:|---|---|---|
| 400 | `QUERY_REQUIRED` | 请求体缺少非空 `query`。 | 提示用户输入问题，不要重试。 |
| 400 | `DATA_MODE_INVALID` | `dataMode` 不是 `mock/cache_first/real`。 | 回退为 `mock` 后重发，或提示配置错误。 |
| 404 | `ROUTE_NOT_FOUND` | 路径或方法写错，例如用了 `GET /api/demo/search`。 | 检查 base URL、代理和请求方法。 |
| 500 | `INTERNAL_SERVER_ERROR` | 未预期后端错误。 | 展示通用失败态，保留 `queryId` 或调试日志。 |

兼容搜索接口 `GET /api/search` 还可能返回 `ZHIHU_AUTH_FAILED` 等知乎侧错误；前端 AI 分身页面不要直接依赖它。
