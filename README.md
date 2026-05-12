# 知乎黑客松 Demo

Node.js + TypeScript 后端 demo，当前使用 Express 提供健康检查、知乎搜索代理和前端友好搜索入口。前端目录已预留，后端接口优先保持轻量、前端友好，并保留 mock / stub 扩展空间。

## 后端目录结构

```text
.
├── backend/
│   ├── src/
│   │   ├── app.ts                         # Express app 与路由挂载
│   │   ├── server.ts                      # 服务启动入口
│   │   ├── config/env.ts                  # .env.local 与运行配置
│   │   ├── middleware/error.middleware.ts # 统一错误与 404 响应
│   │   ├── providers/zhihu/               # 知乎 API provider、mapper、types
│   │   ├── routes/                        # health、zhihu、search 路由
│   │   ├── services/search.service.ts     # 前端搜索入口服务
│   │   ├── types/api.types.ts             # API 通用类型
│   │   └── utils/httpError.ts             # HTTP 错误封装
│   ├── .env.example                       # 示例环境变量，不包含真实 Secret
│   ├── package.json                       # 后端构建、启动脚本
│   ├── tsconfig.json                      # TypeScript 配置
│   └── README.md                          # 后端接口与验收说明
├── docs/                                  # 需求、设计、开发说明
├── frontend/                              # 前端预留目录
├── package.json                           # npm workspace 入口
└── README.md
```

`backend/dist/` 和 `node_modules/` 是本地生成内容，已由 `.gitignore` 忽略。

## 环境变量

服务会读取项目根目录或 `backend/` 目录下的 `.env.local`。真实 Secret 只放本地，不要提交。

```env
ZH_ACCESS_SECRET=你的知乎 Access Secret
ZH_SEARCH_API_URL=https://developer.zhihu.com/api/v1/content/zhihu_search
ZH_API_TIMEOUT_MS=10000
HOST=127.0.0.1
PORT=3001
```

变量说明：

- `ZH_ACCESS_SECRET`：调用真实知乎搜索 API 时必填。
- `ZH_SEARCH_API_URL`：知乎搜索接口地址，默认 `https://developer.zhihu.com/api/v1/content/zhihu_search`。
- `ZH_API_TIMEOUT_MS`：上游请求超时时间，默认 `10000`。
- `HOST`：后端监听地址，默认 `127.0.0.1`。
- `PORT`：后端监听端口，默认 `3001`。

已检查 `.gitignore` 包含 `.env.local`，根目录 `.env.local` 和 `backend/.env.local` 均会被忽略。

## 启动

在项目根目录执行：

```bash
npm install
npm run build
npm run dev
```

`npm run dev` 会先构建后端，再运行 `backend/dist/server.js`。默认监听 `http://localhost:3001`。

## 接口说明

### GET /api/health

健康检查接口。

```bash
curl -i "http://localhost:3001/api/health"
```

成功响应：

```json
{
  "success": true,
  "data": {
    "status": "ok",
    "service": "zhihu-hackathon-backend"
  }
}
```

### GET /api/zhihu/search

知乎搜索代理接口，保留用于直接透传知乎搜索 API。

```bash
curl -i "http://localhost:3001/api/zhihu/search?query=不工作了能去哪儿&count=5"
```

参数：

- `query`：必填，用户搜索问题或关键词。
- `count`：可选，默认 `5`，服务端限制在 `1` 到 `20`。

服务会调用：

```text
GET ${ZH_SEARCH_API_URL}?Query=...&Count=...
Authorization: Bearer ${ZH_ACCESS_SECRET}
X-Request-Timestamp: 当前秒级 Unix 时间戳
Content-Type: application/json
```

成功时透传知乎搜索原始响应。错误响应为 JSON，例如缺少 `query` 返回 `QUERY_REQUIRED`，缺少或无效鉴权返回 `ZHIHU_AUTH_FAILED`，上游失败返回 `ZHIHU_API_ERROR`、`ZHIHU_REQUEST_FAILED` 或 `ZHIHU_TIMEOUT`。

### GET /api/search

新增的前端友好搜索入口，参数与 `/api/zhihu/search` 保持兼容。

```bash
curl -i "http://localhost:3001/api/search?query=不工作了能去哪儿&count=5"
```

成功响应形态：

```json
{
  "success": true,
  "data": {
    "query": "不工作了能去哪儿",
    "count": 5,
    "hasMore": false,
    "searchHashId": "",
    "items": [
      {
        "id": "content_id",
        "type": "answer",
        "title": "标题",
        "text": "原文摘要或正文",
        "url": "https://www.zhihu.com/...",
        "author": {
          "name": "作者昵称",
          "avatar": "",
          "badge": "",
          "badgeText": ""
        },
        "stats": {
          "commentCount": 0,
          "voteUpCount": 0,
          "rankingScore": 0
        },
        "comments": [],
        "editTime": 0,
        "authorityLevel": "",
        "source": {
          "provider": "zhihu",
          "url": "https://www.zhihu.com/..."
        },
        "evidence": {
          "text": "原文摘要或正文",
          "source": {
            "provider": "zhihu",
            "url": "https://www.zhihu.com/..."
          }
        }
      }
    ]
  }
}
```

验收要求：

- 必须支持 `query` 和 `count`。
- 必须绑定真实或 mock 的 evidence / source，至少保留 `url`、`text`、`author` 等可追溯字段。
- 不把观点作者包装成亲历者。
- 不实现“联系 TA”、私信、模拟作者本人回复等能力。
- 后续可继续演进为 `sections / cards / blocks / actions / meta`。

## 验收清单

```bash
npm run build
```

期望：TypeScript 构建成功，生成或更新 `backend/dist/`。

```bash
npm run dev
```

期望：服务启动并监听 `http://127.0.0.1:3001` 或配置的 `HOST:PORT`。

```bash
curl -i "http://localhost:3001/api/health"
curl -i "http://localhost:3001/api/zhihu/search?query=不工作了能去哪儿&count=5"
curl -i "http://localhost:3001/api/search?query=不工作了能去哪儿&count=5"
```

期望：

- `/api/health` 返回 `200` 和 `success: true`。
- `/api/zhihu/search` 在配置 `ZH_ACCESS_SECRET` 后返回知乎搜索原始结果；未配置或鉴权失败时返回明确 JSON 错误。
- `/api/search` 返回前端可消费搜索结果，并保留可追溯来源字段。
