# API 协作说明

## 前端主入口

前端产品层主入口是：

```http
POST /api/demo/search
Content-Type: application/json
```

请求示例：

```json
{
  "query": "不工作了能去哪儿",
  "count": 3,
  "dataMode": "mock"
}
```

`dataMode` 支持：

- `mock`：只使用后端内置 mock/stub，默认模式，不依赖知乎 Key 或 LLM Key。
- `cache_first`：当前 demo 阶段使用内置 mock seed 保持前端闭环，后续可接缓存。
- `real`：尝试复用 `GET /api/search` 的知乎召回结果，失败时降级 mock。

响应统一为：

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

完整样例见 [demo-search.sample.json](./demo-search.sample.json)。

## 兼容接口

以下接口继续保留，但不是前端产品层主入口：

- `GET /api/search?query=xxx&count=5`：底层标准化知乎召回。
- `GET /api/zhihu/search?query=xxx&count=5`：知乎原始响应调试接口。
- `GET /api/health`：健康检查。

## 安全边界

- `schemaVersion` 固定为 `demo.v1`。
- `people[]` 是人物样本主数据。
- `personas[]` 只是 AI 分身入口索引，不是第二套人物数据。
- 每个 `path`、`person`、`persona` 必须带 `sourceRefs`，人物和路径还必须带 `evidenceIds`。
- `boundaryNotice` 固定为：`该 AI 分身基于公开内容生成，不代表作者本人。`
- 不实现“联系 TA”、私信、模拟作者本人回复。
- AI 不作为事实来源；所有展示内容必须回到 `evidence/source`。
