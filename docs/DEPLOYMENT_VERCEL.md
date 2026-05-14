# Vercel 部署说明

本文记录 `deploy/vercel-submit-ready` 分支的 Vercel 导入、配置、验收和预热步骤。当前目标是让评审或演示环境可独立部署，不改变后端主业务链路。

## 部署结构

- `frontend/index.html`：前端 demo 首页，`GET /` 由 Express 静态服务打开真实前端页面。
- `api/index.mjs`：Vercel Function 入口，导出构建后的 Express app。
- `backend/src/app.ts`：继续导出可复用 `app`，并静态服务 `frontend/`；`backend/src/server.ts` 只负责本地 `app.listen`。
- `vercel.json`：执行 `npm run build` 后，将所有非静态请求 rewrite 到 `/api`。

Vercel 官方 Express 指南要求 Express app 以默认导出或端口监听的形式进入运行时。本项目通过 `vercel.json` 将 `frontend/**` 打包进函数，保证 Vercel 和本地 `npm start` 都能从同一个 Express app 打开真实前端页面。

参考：

- [Express on Vercel](https://vercel.com/guides/using-express-with-vercel)
- [Rewrites on Vercel](https://vercel.com/docs/rewrites)
- [How can I use files in Vercel Functions?](https://examples.vercel.com/guides/how-can-i-use-files-in-serverless-functions)

## 导入 GitHub

1. 在 Vercel Dashboard 选择 Add New Project。
2. 导入 GitHub 仓库 `buning1989/zhihu-hackathon-demo`。
3. Root Directory 选择仓库根目录。
4. Framework Preset 选择 Other。
5. 先部署分支 `deploy/vercel-submit-ready`，验证通过后再决定是否合并到主线。

## Project Settings

| 项目 | 值 |
|---|---|
| Install Command | `npm install` |
| Build Command | `npm run build` |
| Output Directory | 留空 |
| Development Command | 留空或 `npm run dev` |
| Node.js Version | 22.x 或 Vercel 当前 LTS |

`vercel.json` 已写入同样的 Install Command 和 Build Command。Dashboard 如无特殊需要保持一致即可。

## 环境变量

最小可演示配置：

```env
NODE_ENV=production
DATA_MODE=mock
SESSION_SECRET=<generate-a-random-secret>
FRONTEND_URL=https://<your-vercel-domain>
```

接入真实知乎搜索或 OAuth 时再配置：

```env
ZH_ACCESS_SECRET=
ZHIHU_API_KEY=
ZH_SEARCH_API_URL=https://developer.zhihu.com/api/v1/content/zhihu_search
ZHIHU_APP_ID=
ZHIHU_APP_KEY=
ZHIHU_REDIRECT_URI=https://<your-vercel-domain>/auth/zhihu/callback
ZHIHU_OPENAPI_BASE_URL=https://openapi.zhihu.com
ZHIHU_OPENAPI_APP_KEY=
ZHIHU_OPENAPI_APP_SECRET=
ZHIHU_USERINFO_PATH=/user
```

接入真实 LLM 时再配置：

```env
KIMI_API_KEY=
KIMI_MODEL=moonshot-v1-8k
DEEPSEEK_API_KEY=
DEEPSEEK_MODEL=deepseek-chat
LLM_ENABLED=true
LLM_TIMEOUT_MS=15000
```

不要在仓库提交 `.env`、`.env.local`、真实 API Key、Token 或 Secret。Preview 和 Production 的变量可分开配置，评审环境建议先保持 `DATA_MODE=mock`。

## OAuth Callback

知乎 OAuth 回调地址必须和 Vercel 域名完全一致：

```text
https://<your-vercel-domain>/auth/zhihu/callback
```

配置步骤：

1. 在 Vercel 环境变量中设置 `ZHIHU_REDIRECT_URI`。
2. 在知乎开放平台应用后台登记同一个 callback。
3. Preview 域名和 Production 域名不同，分别验收时需要分别登记或使用固定自定义域名。
4. 本地开发仍可使用 `.env.local` 中的 `http://127.0.0.1:3001/auth/zhihu/callback`。

## 部署后验收

拿到 Vercel URL 后运行：

```bash
node scripts/smoke-vercel.mjs https://<your-vercel-domain>
```

也支持环境变量：

```bash
BASE_URL=https://<your-vercel-domain> node scripts/smoke-vercel.mjs
```

脚本会验证：

- `GET /health` 返回 `{ "status": "ok" }`。
- `GET /` 返回静态 demo 首页。
- `POST /api/demo/search` 在 `mock` 模式下返回成功结果。
- `POST /api/personas/chat` 返回 grounded mock 或真实分身回答。

手动验收命令：

```bash
curl -i https://<your-vercel-domain>/health
curl -i https://<your-vercel-domain>/
curl -i https://<your-vercel-domain>/api/demo/search \
  -H "Content-Type: application/json" \
  -d '{"query":"不工作了之后，我想换一种生活方式，可以从哪里开始？","count":3,"dataMode":"mock"}'
```

## 预热步骤

部署完成后建议按顺序预热：

1. 打开 `https://<your-vercel-domain>/`，确认静态首页可访问。
2. 请求一次 `GET /health`，确认函数冷启动成功。
3. 请求一次 `POST /api/demo/search`，生成 demo session cache。
4. 用返回的 `queryId` 和 `personaId` 请求一次 `POST /api/personas/chat`。
5. 再运行一次 `node scripts/smoke-vercel.mjs https://<your-vercel-domain>`，确认热路径稳定。

当前 demo session cache 是进程内缓存，Vercel 多实例或冷启动后可能丢失。`/api/personas/chat` 已有 mock fallback；正式生产前如需要跨实例稳定聊天上下文，应接入持久化存储。

## 回滚

如果 Preview 验收失败，不要提升为 Production。直接在 Vercel Dashboard 回滚到上一条可用部署，或修复后重新推送 `deploy/vercel-submit-ready`。
