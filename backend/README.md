# 知乎黑客松后端

Node.js + TypeScript + Express 后端服务，当前提供健康检查、知乎搜索调试接口和前端友好的标准搜索接口。

## 目录结构

```text
backend/
  src/
    server.ts
    app.ts
    config/
      env.ts
    routes/
      health.routes.ts
      zhihu.routes.ts
      search.routes.ts
    auth/
      routes.ts
      zhihuOAuth.ts
      session.ts
      requireAuth.ts
    providers/
      zhihu/
        zhihu.provider.ts
        zhihu.types.ts
        zhihu.mapper.ts
    services/
      search.service.ts
    middleware/
      error.middleware.ts
    types/
      api.types.ts
    utils/
      httpError.ts
```

## 环境变量

服务会读取项目根目录或 `backend/` 目录下的 `.env.local`：

```env
ZHIHU_API_KEY=你的知乎 API Key
ZH_ACCESS_SECRET=兼容旧变量，可留空
ZH_SEARCH_API_URL=https://developer.zhihu.com/api/v1/content/zhihu_search
ZH_API_TIMEOUT_MS=10000
ZHIHU_APP_ID=你的知乎 OAuth App ID
ZHIHU_APP_KEY=你的知乎 OAuth App Key
ZHIHU_REDIRECT_URI=http://127.0.0.1:3001/auth/zhihu/callback
ZHIHU_OPENAPI_BASE_URL=https://openapi.zhihu.com
ZHIHU_OPENAPI_APP_KEY=你的知乎 OpenAPI App Key
ZHIHU_OPENAPI_APP_SECRET=你的知乎 OpenAPI App Secret
ZHIHU_USERINFO_PATH=
FRONTEND_URL=http://127.0.0.1:5173
SESSION_SECRET=replace-with-random-string
HOST=127.0.0.1
BACKEND_PORT=8000
PORT=8000
```

`.env.local` 已加入 `.gitignore`，不要提交真实 Secret。

OAuth 相关配置只在访问 `/auth/zhihu/login` 和 callback 时需要；未配置
`ZHIHU_APP_ID` / `ZHIHU_APP_KEY` 时服务仍可启动，登录入口会返回清晰 JSON 错误。
`ZHIHU_USERINFO_PATH` 暂不猜测硬编码，配置后才会调用用户信息接口。
圈子发布接口使用独立的 `ZHIHU_OPENAPI_APP_KEY` / `ZHIHU_OPENAPI_APP_SECRET`，
缺失时只会让发布请求返回配置错误，不影响服务启动。

## 启动

在项目根目录执行：

```bash
npm install
npm run build
npm run dev
```

默认监听 `http://127.0.0.1:8000`。`PORT` 会优先于 `BACKEND_PORT`，用于兼容旧脚本。

## 接口

### GET /health

```bash
curl "http://127.0.0.1:8000/health"
```

根路径健康检查，用于 demo 冒烟测试。

### GET /api/health

```bash
curl "http://127.0.0.1:8000/api/health"
```

返回服务状态。

### GET /api/zhihu/search

```bash
curl "http://127.0.0.1:8000/api/zhihu/search?query=不工作了能去哪儿&count=10"
```

底层调试接口，会真实调用知乎搜索 API，并保留原始 `Code` / `Message` / `Data` 结构。

### POST /api/zhihu/ring/publish

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

手动发布一条想法到白名单圈子。当前允许的圈子 ID：

- `2001009660925334090`：OpenClaw 人类观察员
- `2015023739549529606`：A2A for Reconnect
- `2029619126742656657`：黑客松脑洞补给站

该接口不会接入 demo search 主链路；同一后端进程内每小时最多 5 次真实发布。
成功时返回 `contentToken` 和本次请求的 `logId`。

### GET /api/search

```bash
curl "http://127.0.0.1:8000/api/search?query=不工作了能去哪儿&count=10"
```

当前前端 P0 主接口。业务搜索接口会把知乎原始响应映射为前端更容易消费的标准结构：

```json
{
  "success": true,
  "data": {
    "query": "不工作了能去哪儿",
    "count": 10,
    "hasMore": false,
    "searchHashId": "",
    "items": []
  }
}
```

### GET /auth/zhihu/login

本地 demo 已关闭知乎 OAuth 登录入口，避免活动结束后继续跳转到知乎授权页。
该接口现在返回 `410 AUTH_DISABLED`。callback/token 交换代码仍保留，便于已有回调
或后续恢复时复用。

```bash
curl -i "http://127.0.0.1:8000/auth/zhihu/login"
```

### GET /auth/zhihu/callback

知乎回调入口。后端校验 `state`，使用固定的 `ZHIHU_REDIRECT_URI` 和
`application/x-www-form-urlencoded` 请求 `access_token`，再创建本系统内存 session，
通过 HttpOnly Cookie 维持登录态，最后重定向到 `FRONTEND_URL`。

如果未配置 `ZHIHU_USERINFO_PATH`，仍会创建 demo 登录态，`/auth/me` 中
`userInfoLoaded=false`。

### GET /auth/me

```bash
curl -i "http://127.0.0.1:8000/auth/me"
```

未登录返回 401。已登录返回当前 session 用户信息，但不会返回 `access_token`。
前端可直接读取 `success=true` 和 `data.id`、`data.name`、`data.avatar`、
`data.profileUrl`；响应中也保留 `data.user.displayName` 等兼容字段。

### POST /auth/logout

```bash
curl -i -X POST "http://127.0.0.1:8000/auth/logout"
```

清除内存 session，并清除登录 Cookie。

错误统一返回：

```json
{
  "success": false,
  "error": {
    "code": "ZHIHU_AUTH_FAILED",
    "message": "知乎 API 鉴权失败"
  }
}
```

## 验收

```bash
npm run build
npm run dev
curl "http://127.0.0.1:8000/health"
curl "http://127.0.0.1:8000/api/health"
curl "http://127.0.0.1:8000/api/zhihu/search?query=不工作了能去哪儿&count=10"
curl "http://127.0.0.1:8000/api/search?query=不工作了能去哪儿&count=10"
curl -i "http://127.0.0.1:8000/auth/zhihu/login"
```
