# 后端下一步开发计划

本轮只梳理当前后端现状和下一步最小开发计划，不做业务实现、不新增复杂接口、不设计 session / 用户系统 / 多接口流程。

## A. 当前 GET /api/search 完整链路

1. `backend/src/app.ts`
   - Express app 挂载 `app.use("/api/search", searchRoutes)`。
   - 因为 `searchRoutes` 内部路由是 `GET /`，所以真实入口是 `GET /api/search`。
   - 末尾统一挂载 `notFoundMiddleware` 和 `errorMiddleware`。

2. `backend/src/routes/search.routes.ts`
   - 读取 query string：
     - `query`：必须是非空字符串，会 `trim()`。
     - `count`：可选，默认 `5`；非法值回退 `5`；最终限制在 `1` 到 `20`。
   - 调用 `searchService.search(query, count)`。
   - 成功时返回：
     ```json
     {
       "success": true,
       "data": {}
     }
     ```
   - 抛错时交给统一错误中间件。

3. `backend/src/services/search.service.ts`
   - 再次 `trim()` query，防止服务层被空 query 直接调用。
   - 调用 `zhihuProvider.searchRaw({ query, count })`。
   - 将知乎原始响应交给 `mapZhihuSearchResponse(query, count, rawResponse)`。

4. `backend/src/providers/zhihu/zhihu.provider.ts`
   - 如果没有 `config.zhihu.accessSecret`，直接抛出：
     ```json
     {
       "success": false,
       "error": {
         "code": "ZHIHU_AUTH_FAILED",
         "message": "知乎 API 鉴权失败"
       }
     }
     ```
   - 有密钥时请求 `ZH_SEARCH_API_URL`，参数为 `Query` 和 `Count`。
   - 请求头包含 `Authorization: Bearer <secret>`、`X-Request-Timestamp`、`Content-Type`。
   - 上游 401 / 403 映射为 `ZHIHU_AUTH_FAILED`。
   - 上游其他非 2xx 映射为 `ZHIHU_API_ERROR`。
   - 超时映射为 `ZHIHU_TIMEOUT`。
   - 其他请求失败映射为 `ZHIHU_REQUEST_FAILED`。

5. `backend/src/providers/zhihu/zhihu.mapper.ts`
   - 从 `rawResponse.Data` 中寻找结果数组，兼容 `Items / Results / SearchResults / Contents / List / Data` 等字段。
   - 将每条知乎内容映射成 `SearchItem`。
   - 缺失字符串归一为 `""`，缺失数字归一为 `0`，缺失数组归一为 `[]`。
   - 每条 item 都带 `source` 和 `evidence`，其中当前 `evidence.text` 等于映射出的 `text`。

6. 最终 response
   - 成功：
     ```json
     {
       "success": true,
       "data": {
         "query": "不工作了能去哪儿",
         "count": 1,
         "hasMore": false,
         "searchHashId": "",
         "items": []
       }
     }
     ```
   - 失败：由 `errorMiddleware` 统一返回 `success: false` 和 `error.code / error.message`。

## B. 当前 GET /api/search 已经能返回哪些字段

顶层字段：

- `success`
- `data`
- `error.code`
- `error.message`

成功时 `data` 字段：

- `query`
- `count`
- `hasMore`
- `searchHashId`
- `items`

每个 `items[]` 字段：

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

当前还没有返回：

- `intent`
- `cardTitle`
- `cardSummary`
- `matchedReasons`
- `tags`
- `sections / cards / blocks / actions / meta`

## C. sample json 与真实后端的一致性

`shared/demo-response.sample.json` 中已经和真实后端一致的部分：

- `success_response.success`
- `success_response.data.query`
- `success_response.data.count`
- `success_response.data.hasMore`
- `success_response.data.searchHashId`
- `success_response.data.items`
- `items[].id`
- `items[].type`
- `items[].title`
- `items[].text`
- `items[].url`
- `items[].author.name`
- `items[].author.avatar`
- `items[].author.badge`
- `items[].author.badgeText`
- `items[].stats.commentCount`
- `items[].stats.voteUpCount`
- `items[].stats.rankingScore`
- `items[].comments`
- `items[].editTime`
- `items[].authorityLevel`
- `items[].source.provider`
- `items[].source.url`
- `items[].evidence.text`
- `items[].evidence.source.provider`
- `items[].evidence.source.url`
- `error_response_without_zhihu_key.success`
- `error_response_without_zhihu_key.error.code`
- `error_response_without_zhihu_key.error.message`

需要注意：

- sample 里的具体内容是前端开发样例，不代表当前后端无密钥时会返回成功结果。
- 当前无真实知乎密钥时，`GET /api/search` 返回明确 JSON 错误，不返回 sample 里的 `success_response`。
- `future_optional_shape` 是未来预留，不是当前真实后端响应。

## D. 让 /api/search 成为前端可直接使用 demo 主接口的最小能力

下一步最少补这些能力即可，不需要新增复杂接口：

1. 无密钥可跑通的 mock / stub 成功模式
   - 当前无密钥返回 `ZHIHU_AUTH_FAILED`，适合暴露错误，但不能让前端直接演示结果页。
   - 最小改法：当 `ZHIHU_API_KEY` / `ZH_ACCESS_SECRET` 缺失时，`/api/search` 可以走本地 mock 数据，返回与真实成功响应同形状的数据。
   - mock 数据必须保留 `source` 和 `evidence`。

2. 稳定的 demo 数据种子
   - 为“不工作了能去哪儿”准备 3 到 5 条可追溯 mock 内容。
   - 每条内容至少包含 `title / text / url / author / source / evidence`。
   - 不把观点作者包装成亲历者。

3. 轻量卡片增强字段
   - 在当前 `SearchItem` 基础上补最少展示字段：`intent / cardTitle / cardSummary / matchedReasons / tags`。
   - 可以先由 deterministic stub 基于 `title / text / author / evidence` 生成，不必接真实大模型。

4. 保持单接口
   - 仍以 `GET /api/search` 作为 P0 主接口。
   - 不新增 session，不新增用户系统，不把前端引向 `/api/demo/*` planned 接口。

5. 更新契约和样例
   - 当真实后端新增字段后，同步更新 `shared/openapi.yaml`、`shared/demo-response.sample.json` 和 `docs/frontend-field-guide.md`。

## E. 大模型字段是否现在就需要接入

现在不需要接入真实大模型。

下一步更稳的做法是先接 deterministic stub，把输出形状固定下来，让前端可以直接开发和验收。等 mock / stub 跑通、字段稳定后，再把生成逻辑替换为真实 LLM。

如果要预留最小大模型字段，只保留：

- `intent`：这条内容匹配用户问题的意图类别。
- `cardTitle`：前端卡片标题，优先短、可扫读。
- `cardSummary`：前端卡片摘要，不编造原文没有的信息。
- `matchedReasons`：匹配理由数组，每条都应能回到 `evidence.text` 或原文内容。
- `tags`：短标签数组，用于前端筛选或视觉提示。

这些字段必须遵守：

- 不编造作者经历。
- 不推断作者真实身份。
- 不模拟作者本人回复。
- 每条卡片继续保留 `source` 和 `evidence`。

## F. 本阶段不做的事情

- 不设计复杂 session。
- 不设计用户系统。
- 不设计多接口流程。
- 不开发 `/api/demo/search` 或 `/api/demo/session/{sessionId}`。
- 不改动 `frontend/`。
- 不重构现有 backend 业务链路。
