# AGENTS.md

本文件是给 Codex / 开发助手看的项目协作规则。进入本仓库工作时，请优先遵守这里的约定。

## 项目信息

- 项目根目录：`/Users/ning/Documents/Codex/知乎黑客松/zhihu-hackathon-demo`
- 兼容旧路径：`/Users/ning/Documents/Codex/知乎黑客松/后端服务搭建`
- GitHub 远端：`https://github.com/buning1989/zhihu-hackathon-demo`
- 当前仓库结构：
  - `backend/`：后端服务
  - `frontend/`：前端预留目录
  - `docs/`：需求、设计、开发说明文档

## 开发流程

1. 开始开发前，先阅读 `README.md` 和 `docs/` 下相关文档。
2. 修改前查看 `git status --short --branch`，确认是否存在用户未提交改动。
3. 优先保持改动范围小而清晰，不做无关重构。
4. 开发完成后运行可用的构建、测试或接口检查。
5. 确认无敏感信息后，提交代码并 push 到 GitHub。

## Git 约定

- 默认在 `main` 分支开发，除非用户要求新建分支。
- 提交信息使用简洁英文，例如 `Add backend mock query flow`。
- 开发完成后需要执行：

```bash
git status --short --branch
git add .
git commit -m "<message>"
git push
```

- 不要提交：
  - `.env`
  - `.env.local`
  - `node_modules/`
  - `dist/`
  - `.DS_Store`
  - 任何真实 API Key、Token、Secret

## 后端约定

- 当前后端位于 `backend/`。
- 后端需要支持无真实 API Key 的 mock / stub 跑通模式。
- 任何知乎内容相关卡片、详情、追问回答都必须绑定真实或 mock 的 evidence/source。
- 不要把观点作者包装成亲历者。
- 不要实现“联系 TA”、私信、模拟作者本人回复等能力。

## 前端约定

- 前端尚未正式接入，预留在 `frontend/`。
- 后端接口字段应保持对前端友好，优先使用 `sections / cards / blocks / actions / meta` 这类弱绑定结构。
- 如果改动接口结构，需要同步更新 README 或 docs 中的接口说明。

## 安全与配置

- 真实配置只放本地 `.env` 或 `.env.local`，不得提交。
- 示例配置使用 `.env.example`。
- 接入真实知乎 API 或 LLM API 时，必须通过环境变量读取 Key，不要硬编码。

## 沟通规则

- 如果用户只是要求阅读、评估、规划，不要擅自开始开发。
- 如果用户明确要求开发，则完成实现、验证、提交和推送。
- 遇到需要登录、授权、购买、删除、覆盖远端历史等高影响操作时，先向用户确认。
