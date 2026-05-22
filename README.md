# 知乎黑客松 Demo

这是一个前后端分开开发、但可以一键运行 demo 的 monorepo。当前仓库已经存在 Node.js + TypeScript 后端代码、静态前端页面，以及可见的持久化 Agent Runtime 演示链路。

## 项目目录结构

```text
.
├── backend/                 # 现有后端服务，当前为 Node.js + TypeScript + Express
├── frontend/                # 静态前端页面，当前主体验为持久化 Agent 模式
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

- `backend/src/` 下已有 Express 后端代码，当前接口包括 `/health`、`/api/health`、`/api/demo/search`、`/api/agent/tasks`、`/api/agent/tasks/:taskId/refine`、`/api/agent/tasks/:taskId/view`、`/api/zhihu/search`、`/api/search` 和 `/auth/*`。
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

前端静态页本地启动：

```bash
python3 -m http.server 3000 --directory frontend
```

可见 Agent 成品演示使用 Docker Compose。它会启动 Postgres、Redis、数据库迁移、后端、独立 Agent worker 和静态前端：

```bash
docker compose -f infra/docker-compose.yml up
```

Phase 1 Agent smoke 依赖完整持久化运行环境：Postgres、Redis、后端、`agent-worker` 和前端都必须运行。推荐先启动 Docker Desktop，再用上面的 compose 命令启动整套环境。若不使用 compose，而是本机分别启动服务，需要为后端和 worker 设置：

```bash
DATABASE_URL=postgres://zhihu:zhihu@localhost:5432/zhihu_hackathon
REDIS_URL=redis://localhost:6379
```

并先执行数据库迁移：

```bash
npm run db:migrate -w backend
```

启动后默认地址：

- 后端健康检查：`http://localhost:8000/health`
- 知乎 OAuth 登录入口：`http://localhost:8000/auth/zhihu/login`
- 前端 Agent 演示页：`http://localhost:3000/`
- Agent 链路调试页：`http://localhost:3000/debug/agent/`
- OpenAPI 契约：`shared/openapi.yaml`
- 前端字段样例：`shared/demo-response.sample.json`

打开前端后直接输入问题并发送。当前页面主体验会创建持久化 Agent task，轮询 `/api/agent/tasks/:taskId/view`，展示 7 个阶段进度，并把最终 `guarded_final_result` 展示为路径和人物样本。若没有完整启动 Postgres、Redis 或 worker，页面会显示 Agent Runtime 不可用的明确提示。

如需单独验证可见 Agent view，可在 compose 环境或本地后端/worker 已启动时运行：

```bash
npm run smoke:agent-view -w backend
```

Phase 4 内部调试和评估工具：

```bash
curl -s "http://localhost:8000/api/agent/tasks/<taskId>/debug"
npm run eval:agent-production -w backend
```

`/debug` 只在非 production 环境开放，返回 task/stage/event/artifact 的安全摘要，不返回大段原文或敏感 metadata。评估脚本会跑 30 个固定问题并输出 success rate、平均耗时、证据量、degraded rate、grounding passed rate、cache/reuse 计数和 failed task list。
如果要绕开 Phase 3 task reuse 跑新一轮真实 LLM eval，可设置 `EVAL_AGENT_PRODUCTION_FRESH=true AGENT_LLM_ENABLED=true AGENT_LLM_TEST_MODE=real`。

## 前后端协作规则

- `shared/openapi.yaml` 是前后端协作的最小契约。当前已实现接口 `GET /api/search` 继续保留；AI 分身产品层 P0 目标契约统一为 `POST /api/demo/search`。
- 北陆前端开发先以 `shared/demo-response.sample.json` 作为产品层字段样例，字段含义和兜底规则见 `docs/frontend-field-guide.md`。
- 后端响应优先保持 `sections / cards / blocks / actions / meta` 这类弱绑定结构，避免把接口锁死在某个页面实现上。
- 所有知乎内容卡片、详情、追问回答都必须绑定真实或 mock 的 `evidence/source`。
- 知乎 OAuth 用户资料只能作为轻量 `contextUsed/profileSignals/fitReason` 辅助信息，不得作为 evidence/source，也不得返回 token、cookie 或原始 userInfo。
- 不要把观点作者包装成亲历者，不实现“联系 TA”、私信、模拟作者本人回复等能力。
- 当前 `frontend/` 是静态页面；如后续升级为独立前端工程，需要同步更新 `infra/docker-compose.yml` 的 frontend service。

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
- `POST /api/agent/tasks` 可创建持久化 Agent task，5 个固定问题能轮询到 `succeeded`，并通过 `/api/agent/tasks/:taskId/result` 读取带 `sourceRefs` 的 `final_result`。
- Agent production smoke 还会校验候选质量分、evidence 质量字段、persona 真实经历证据、deterministic quality report 和 bad refs。
- Agent production final_result 主契约为 `agent.production_final_result.v2`，以 `summary / paths / evidenceSamples / sources / evidenceMap / groundingReport / degraded` 为稳定展示字段；v1 结构化路径字段仍可兼容读取，但不再作为 LLM 必填输出。
- Agent production smoke 还会校验相同 query 的 succeeded/running task 复用、`cacheHit/reused` 标识；任务数量/并发限流默认关闭，只有设置 `AGENT_RATE_LIMIT_ENABLED=true` 时才校验 `RATE_LIMITED`。
- Agent production smoke 还会校验模糊问题进入 `need_input`、`POST /api/agent/tasks/:taskId/refine` 创建新 task、refined task 成功以及 refined cache key 不复用原始模糊 query。

如果 smoke 在 Agent 检查处返回 `AGENT_DATABASE_UNCONFIGURED` 或 `AGENT_QUEUE_UNCONFIGURED`，表示当前后端没有读取到 `DATABASE_URL` 或 `REDIS_URL`；请先启动 compose 环境，或按上面的本机变量补齐后重新启动 backend 和 worker。

也可以手动检查：

```bash
curl -i "http://localhost:8000/health"
curl -i "http://localhost:8000/api/health"
curl -i "http://localhost:8000/api/search?query=不工作了能去哪儿&count=1"
curl -i "http://localhost:3000/"
```

后续业务 demo 沿着 `shared/openapi.yaml` 中的 `POST /api/demo/search` 产品层契约演进；`GET /api/search` 继续作为已实现的底层搜索映射和兼容接口。
