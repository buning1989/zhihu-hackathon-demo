# 前端字段协作指南

## 主接口

当前 P0 主接口是：

```http
GET /api/search?query=不工作了能去哪儿&count=1
```

它是已经实现的前端友好搜索接口。`/api/zhihu/search` 是后端调试用的知乎原始响应代理，前端不要直接依赖它。`/api/demo/search` 和 `/api/demo/session/{sessionId}` 仍是 planned / future，不是当前可调用接口。

## 前端开发样例

北陆前端开发先以 `shared/demo-response.sample.json` 作为唯一参考样例。这个样例基于当前 `/api/search` 字段，同时预留了后续 `sections / cards / blocks / actions / meta` 的扩展位置。

## 字段分级

P0 必须字段：

- `success`：请求是否成功。
- `data.query`：服务端裁剪后的用户 query。
- `data.count`：服务端归一化后的结果数量，范围是 1 到 20。
- `data.hasMore`：上游是否还有更多结果。
- `data.searchHashId`：上游搜索游标，可能为空字符串。
- `data.items`：搜索结果数组，可能为空。
- `data.items[].id`：卡片稳定 id；上游缺失时后端会生成 `zhihu_item_1` 这类 id。
- `data.items[].type`：知乎内容类型，可能为空字符串。
- `data.items[].title`：标题，可能为空字符串。
- `data.items[].text`：正文摘要或正文片段，可能为空字符串。
- `data.items[].url`：知乎原文链接，可能为空字符串。
- `data.items[].source.provider`：来源供应方，当前固定为 `zhihu`。
- `data.items[].source.url`：来源链接，可能为空字符串。
- `data.items[].evidence.text`：证据文本，当前等于 `text`，可能为空字符串。
- `data.items[].evidence.source`：证据来源，必须随卡片一起传递。

P1 体验字段：

- `data.items[].author.name`：作者昵称，可能为空字符串。
- `data.items[].author.avatar`：作者头像 URL，可能为空字符串。
- `data.items[].stats.voteUpCount`：赞同数，缺失时为 `0`。
- `data.items[].stats.commentCount`：评论数，缺失时为 `0`。
- `data.items[].comments`：评论数组，P0 通常为空数组。
- `future.sections / future.cards / future.actions`：后续大模型编排后的结构化展示字段。

P2 装饰字段：

- `data.items[].author.badge`：作者徽章原始值，可能为空字符串。
- `data.items[].author.badgeText`：作者徽章展示文案，可能为空字符串。
- `data.items[].stats.rankingScore`：上游排序分，缺失时为 `0`。
- `data.items[].editTime`：上游编辑时间，缺失时为 `0`。
- `data.items[].authorityLevel`：上游权威等级，可能为空字符串。
- `future.blocks / future.meta.traceId`：后续详情页与调试增强字段。

## 可能为空的字段

当前后端为了让前端少做类型判断，会把缺失字段归一成稳定空值：

- 字符串缺失：返回 `""`。
- 数字缺失：返回 `0`。
- 数组缺失：返回 `[]`。
- `items` 无结果：返回 `[]`，不是 `null`。

需要特别注意：`url`、`title`、`text`、`author.name` 都可能为空。前端不能因为这些字段为空而崩溃。

## 字段缺失兜底

- 如果 `success === false`，展示 `error.message`；如果 `message` 缺失，展示“服务暂时不可用，请稍后再试”。
- 如果 `data.items` 为空，展示空态，不要渲染空卡片。
- 如果 `title` 为空，使用 `text` 的前 24 个字符作为标题；如果 `text` 也为空，使用“未命名内容”。
- 如果 `author.name` 为空，展示“知乎用户”。
- 如果 `url` 为空，隐藏“查看原文”按钮。
- 如果 `evidence.text` 为空，优先使用 `text`；仍为空时隐藏证据区，但保留卡片来源字段。
- 如果统计数字为 `0`，可以隐藏对应统计项，避免误导为真实 0 热度。

## 与 OpenAPI 的关系

`shared/openapi.yaml` 现在以当前真实接口为准，P0 集成看 `GET /api/search`。OpenAPI 中标记 `x-implementation-status: planned` 的接口只代表未来方向，不作为当前前端联调依据。
