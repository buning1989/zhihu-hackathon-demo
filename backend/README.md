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
HOST=127.0.0.1
BACKEND_PORT=8000
PORT=8000
```

`.env.local` 已加入 `.gitignore`，不要提交真实 Secret。

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
curl "http://127.0.0.1:8000/api/zhihu/search?query=不工作了能去哪儿&count=5"
```

底层调试接口，会真实调用知乎搜索 API，并保留原始 `Code` / `Message` / `Data` 结构。

### GET /api/search

```bash
curl "http://127.0.0.1:8000/api/search?query=不工作了能去哪儿&count=5"
```

当前前端 P0 主接口。业务搜索接口会把知乎原始响应映射为前端更容易消费的标准结构：

```json
{
  "success": true,
  "data": {
    "query": "不工作了能去哪儿",
    "count": 5,
    "hasMore": false,
    "searchHashId": "",
    "items": []
  }
}
```

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
curl "http://127.0.0.1:8000/api/zhihu/search?query=不工作了能去哪儿&count=5"
curl "http://127.0.0.1:8000/api/search?query=不工作了能去哪儿&count=5"
```
