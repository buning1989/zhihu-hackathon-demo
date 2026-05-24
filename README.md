# 知乎黑客松 Demo

这是一个前后端分开开发、但可以一键运行 demo 的 monorepo 骨架。当前仓库已经存在 Node.js + TypeScript 后端代码，前端仍是占位目录；本次初始化只补协作结构、接口契约、启动脚本和 CI，不迁移或重写既有业务代码。

## 项目目录结构

```text
.
├── backend/                 # 现有后端服务，当前为 Node.js + TypeScript + Express
├── frontend/                # 前端预留目录，当前只有可访问的静态占位首页
├── shared/
│   ├── openapi.yaml         # 前后端协作接口契约
│   └── demo-response.sample.json # 前端 P0 字段参考样例
├── infra/
│   └── docker-compose.yml   # 本地一键启动 demo 的预留编排
├── scripts/
│   └── smoke-test.sh        # demo 冒烟检查
├── docs/                    # 需求、设计、开发说明
├── .github/workflows/ci.yml # 最小 CI
├── .env.example             # 根目录环境变量示例
└── package.json             # npm workspace 入口
```

已有代码保留说明：

- `backend/src/` 下已有 Express 后端代码，当前接口包括 `/health`、`/api/health`、`/api/zhihu/search`、`/api/search` 和 `/auth/*`。
- `backend/dist/`、`backend/node_modules/`、`__pycache__/` 等是本地生成内容，已经由 `.gitignore` 忽略，不应提交。
- 早期 `docs/` 中有 FastAPI 方向设计，当前实际代码是 Node.js 后端。后续如需迁移，应先以 `shared/openapi.yaml` 为契约补齐兼容接口，再分 PR 替换实现。

## 本地启动方式

先复制环境变量模板：

```bash
cp .env.example .env.local
```

后端本地启动：

```bash
npm install
BACKEND_PORT=8000 npm run dev:backend
```

前端占位页本地启动：

```bash
python3 -m http.server 3000 --directory frontend
```

一键 demo 启动可以使用 Docker Compose：

```bash
docker compose -f infra/docker-compose.yml up
```

启动后默认地址：

- 后端健康检查：`http://localhost:8000/health`
- 知乎 OAuth 登录入口：本地 demo 已关闭，避免活动结束后跳转授权页
- 前端占位首页：`http://localhost:3000/`
- OpenAPI 契约：`shared/openapi.yaml`
- 前端字段样例：`shared/demo-response.sample.json`

## 前后端协作规则

- `shared/openapi.yaml` 是前后端协作的最小契约。当前已实现接口 `GET /api/search` 继续保留；AI 分身产品层 P0 目标契约统一为 `POST /api/demo/search`。
- `POST /api/demo/search` 在请求体包含 `clarificationAnswers` 时，会返回 `intent + focusTags + searchPlan + debug`，用于澄清卡后的知乎搜索计划生成；未包含澄清答案时继续返回完整 demo 结果结构。
- 北陆前端开发先以 `shared/demo-response.sample.json` 作为产品层字段样例，字段含义和兜底规则见 `docs/frontend-field-guide.md`。
- 后端响应优先保持 `sections / cards / blocks / actions / meta` 这类弱绑定结构，避免把接口锁死在某个页面实现上。
- 所有知乎内容卡片、详情、追问回答都必须绑定真实或 mock 的 `evidence/source`。
- 知乎 OAuth 用户资料只能作为轻量 `contextUsed/profileSignals/fitReason` 辅助信息，不得作为 evidence/source，也不得返回 token、cookie 或原始 userInfo。
- 不要把观点作者包装成亲历者，不实现“联系 TA”、私信、模拟作者本人回复等能力。
- 前端正式初始化后，可以在 `frontend/` 内建立独立工程；届时同步更新 `infra/docker-compose.yml` 的 frontend service。

## 分支规则

- `main` 保持可运行、可演示。
- 不直接推送 `main`。功能、骨架、修复都从明确命名的分支提交，例如 `init/scaffold`、`feature/demo-search`、`fix/health-check`。
- 每个分支尽量只做一类改动，避免把业务开发、格式化和基础设施调整混在一起。

## PR 合并规则

- PR 需要说明改动目的、影响范围和验证方式。
- CI 必须通过；如果某侧暂时没有 `package.json`，CI 会跳过对应 install/build/test。
- 涉及接口结构变化时，PR 必须包含 `shared/openapi.yaml` 和相关文档更新。
- 不提交 `.env`、`.env.local`、`node_modules/`、`dist/`、`.DS_Store` 或任何真实 API Key、Token、Secret。

## Demo 验收方式

启动前后端后运行：

```bash
npm run smoke
```

冒烟脚本至少检查：

- `GET /health` 可访问。
- `GET /api/health` 可访问。
- `GET /api/search?query=不工作了能去哪儿&count=1` 在没有真实知乎密钥时返回明确 JSON 错误，服务不能崩溃。
- 前端首页 `/` 可访问。

也可以手动检查：

```bash
curl -i "http://localhost:8000/health"
curl -i "http://localhost:8000/api/health"
curl -i "http://localhost:8000/api/search?query=不工作了能去哪儿&count=1"
curl -i "http://localhost:3000/"
```

后续业务 demo 沿着 `shared/openapi.yaml` 中的 `POST /api/demo/search` 产品层契约演进；`GET /api/search` 继续作为已实现的底层搜索映射和兼容接口。
