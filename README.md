# 知乎黑客松后端

最小可运行 Node.js + TypeScript 后端，使用 Express 提供健康检查和知乎搜索代理接口。

## 环境变量

服务会读取项目根目录或 `backend/` 目录下的 `.env.local`：

```env
ZH_ACCESS_SECRET=你的知乎 Access Secret
ZH_SEARCH_API_URL=https://developer.zhihu.com/api/v1/content/zhihu_search
ZH_API_TIMEOUT_MS=10000
HOST=127.0.0.1
PORT=3001
```

`.env.local` 已加入 `.gitignore`，不要提交真实 Secret。

## 启动

在项目根目录执行：

```bash
npm install
npm run dev
```

默认监听 `http://localhost:3001`。

## 测试

```bash
curl "http://localhost:3001/api/health"
```

```bash
curl "http://localhost:3001/api/zhihu/search?query=不工作了能去哪儿&count=5"
```

搜索接口会真实调用：

```text
GET https://developer.zhihu.com/api/v1/content/zhihu_search?Query=...&Count=...
```

并携带：

- `Authorization: Bearer ${ZH_ACCESS_SECRET}`
- `X-Request-Timestamp: 当前秒级 Unix 时间戳`
- `Content-Type: application/json`
