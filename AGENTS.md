# AGENTS.md

本文件是给 Codex / 开发助手看的项目协作规则。进入本仓库工作时，请优先遵守这里的约定。

## 项目信息

- 项目根目录：`/Users/ning/Documents/Codex/知乎黑客松/zhihu-hackathon-demo`
- 兼容旧路径：`/Users/ning/Documents/Codex/知乎黑客松/后端服务搭建`
- GitHub 远端：`https://github.com/buning1989/zhihu-hackathon-demo`
- 当前仓库结构：
  - `backend/`：Node.js + TypeScript + Express 后端服务。
  - `frontend/`：前端预留目录，当前是静态占位页。
  - `shared/`：OpenAPI 契约和 demo 响应样例。
  - `docs/`：需求、设计、开发说明和 AI 分身 prompt 文档。

## 开始前必读

1. 先阅读 `README.md`，确认当前技术栈、启动方式和分支规则。
2. 再按任务阅读相关文档：
   - 当前状态和交接：`docs/AI_HANDOFF.md`
   - AI 分身产品层：`docs/backend-ai-persona-integration-plan.md`
   - 前端字段协作：`docs/frontend-field-guide.md`
   - 既有搜索链路：`docs/backend-next-step-plan.md`
   - 早期 FastAPI 设计：`docs/zhihu_hackathon_backend_design.md` 和 `docs/codex_backend_dev_instruction.md` 仅作历史参考，不要直接覆盖当前 Node.js 实现。
3. 修改前执行 `git status --short --branch`，确认分支和未提交改动。

## 工作方式

- 先想清楚再动手。需求有多个解释时，先说明假设和取舍；关键上下文缺失且无法从仓库确认时，先问用户。
- 多步骤任务先给简短计划，并为每一步定义验证方式。
- 优先最小实现。只做用户要求的功能，不增加未被要求的抽象、配置项或“顺手功能”。
- 外科手术式修改。只碰完成任务必须修改的文件和行；不顺手重构、格式化或清理无关代码。
- 匹配现有风格。即使有更喜欢的写法，也优先保持当前项目结构、命名、错误处理和测试风格。
- 如果发现无关问题，记录或告诉用户；除非它阻塞当前任务，不要擅自修。
- 删除只删除本次改动造成的无用代码、导入、变量或文件；不要清理历史遗留死代码。

## 目标与验证

- 把任务转成可验证目标，例如“新增接口”要能通过构建、单测或 curl 检查确认。
- 行为变更优先补测试；窄小文档变更至少检查 diff 和敏感信息。
- 常用验证命令：

```bash
npm run build -w backend
npm run smoke
```

- `npm run smoke` 依赖前后端服务可访问；如果当前环境未启动服务，说明未运行原因，不要假装通过。
- 改动接口契约时，同步检查或更新 `shared/openapi.yaml`、`shared/demo-response.sample.json`、`README.md` 和相关 `docs/`。

## Git 约定

- `main` 必须保持可运行、可演示；不要直接推送 `main`。
- 功能、修复、文档更新应在明确命名的分支上提交；如果当前就在用户指定分支，继续使用当前分支。
- 提交信息使用简洁英文，例如 `Add backend mock query flow`。
- 提交前执行：

```bash
git status --short --branch
git diff --check
```

- 只 stage 本次任务产生的文件。若工作区存在用户或他人的无关改动，不要使用 `git add .`，改为精确 `git add <file>`。
- 用户明确要求开发或修改时，完成实现、验证、确认无敏感信息后提交并 push。若用户只是要求阅读、评估或规划，不要擅自提交。
- 不要提交：
  - `.env`
  - `.env.local`
  - `node_modules/`
  - `dist/`
  - `.DS_Store`
  - 任何真实 API Key、Token、Secret

## 后端约定

- 当前后端位于 `backend/`，实际技术栈是 Node.js + TypeScript + Express。
- 已实现并保留的接口：
  - `GET /health`
  - `GET /api/health`
  - `GET /api/search?query=...&count=...`
  - `GET /api/zhihu/search?query=...&count=...`
- AI 分身产品层 P0 主接口目标是 `POST /api/demo/search`，不要把早期 `POST /api/v1/match/query` 当作当前主链路。
- `GET /api/search` 是底层知乎搜索映射和兼容接口，不要为了产品层改造破坏它的既有契约。
- 无知乎 API Key、无 LLM Key 时，产品层接口必须支持 mock / deterministic stub 跑通。
- 任何知乎内容相关卡片、详情、匹配理由、AI 分身回答都必须绑定真实或 mock 的 `evidence/source`。
- AI 不作为事实来源；不要编造作者经历、推断真实身份、把观点作者包装成亲历者。
- 不要实现“联系 TA”、私信、模拟作者本人回复、作者在线或作者本人实时回应等能力。

## AI 分身约定

- `people[]` 是人物样本主数据。
- `people[].aiPersona` 是 AI 分身入口，不是独立人物数据。
- 顶层 `personas[]` 只做快捷索引，不要重复维护完整人物对象。
- AI 分身表达可以有人味，但事实不能拟人化；固定原则是“表达拟人化，事实不拟人化”。
- 聊天回答必须明确边界：基于知乎公开内容生成，不代表作者本人。
- evidence 不足时，关闭或降级分身入口；聊天回答应返回证据不足，而不是补写剧情。
- prompt 资产优先复用：
  - `docs/prompts/persona-composer.system.md`
  - `docs/prompts/persona-chat.system.md`
  - `backend/src/prompts/`
  - `backend/app/prompts/`

## 前端与接口约定

- 前端产品层优先读取 `POST /api/demo/search` 的目标结构：
  - `analysis`
  - `paths`
  - `people`
  - `personas`
  - `sections`
  - `meta`
- 后端接口字段保持前端友好，优先使用 `sections / cards / blocks / actions / meta` 这类弱绑定结构。
- 前端不要直接依赖 `/api/zhihu/search`；它主要用于后端调试和原始响应代理。
- 如果字段缺失，遵守 `docs/frontend-field-guide.md` 中的 fallback 规则。

## 安全与配置

- 真实配置只放本地 `.env` 或 `.env.local`，不得提交。
- 示例配置使用 `.env.example`。
- 接入真实知乎 API 或 LLM API 时，必须通过环境变量读取 Key，不要硬编码。
- 遇到需要登录、授权、购买、删除、覆盖远端历史、修改生产配置等高影响操作时，先向用户确认。

## 沟通规则

- 如果用户只是要求阅读、评估、规划，不要擅自开始开发。
- 如果用户明确要求开发，则完成实现、验证、提交和推送。
- 不确定时不要隐藏困惑；说清楚卡点、可选方案和推荐路径。
- 对明显过度复杂的需求，可以提出更简单的替代方案，并说明代价。
