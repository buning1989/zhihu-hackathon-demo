# docs 导航

这个目录保存项目需求、后端规划、前端字段协作、AI 分身 prompt 和接口样例。新同学或开发助手接手时，先从这里判断“当前真实状态”和“历史设计参考”的区别。

## 推荐阅读顺序

1. [AI_HANDOFF.md](./AI_HANDOFF.md)：最近一轮交接记录，先看这里了解当前完成了什么、还缺什么。
2. [codex-reporting-standard.md](./codex-reporting-standard.md)：Codex 每次开发任务结束后的汇报与验收证据格式，开发任务完成后必须按此格式输出。
3. [backend-ai-persona-integration-plan.md](./backend-ai-persona-integration-plan.md)：AI 分身产品层接口规划，当前 P0 主接口目标是 `POST /api/demo/search`。
4. [frontend-field-guide.md](./frontend-field-guide.md)：前端读取字段、fallback 规则和 AI 分身展示边界。
5. [backend-next-step-plan.md](./backend-next-step-plan.md)：既有 `GET /api/search` 链路说明，适合理解当前 Node.js 后端搜索能力。
6. [prompts/](./prompts/)：真实接入或调整 AI 分身前，阅读两份固定 system prompt。

## 当前契约与协作资料

| 文件 | 作用 | 什么时候看 |
|---|---|---|
| [AI_HANDOFF.md](./AI_HANDOFF.md) | 项目交接记录，记录最近更新、未完成事项、风险和检查结果。 | 每次接手开发或判断下一步优先级时。 |
| [codex-reporting-standard.md](./codex-reporting-standard.md) | Codex 开发汇报与验收规范，定义目标、修改摘要、验收表、证据、阻塞点和下一步格式。 | 每次开发任务完成、准备给用户或 ChatGPT 审查时。 |
| [backend-ai-persona-integration-plan.md](./backend-ai-persona-integration-plan.md) | 后端 AI 分身产品层规划，定义 `analysis + paths + people + personas + sections + meta` 的目标结构。 | 开发 `POST /api/demo/search`、`POST /api/personas/chat` 或调整 AI 分身字段时。 |
| [frontend-field-guide.md](./frontend-field-guide.md) | 前端字段协作指南，说明 `people[]` 主数据、`personas[]` 快捷索引、文章和 evidence fallback。 | 前端接接口、后端改返回字段、对齐 UI 状态时。 |
| [backend-next-step-plan.md](./backend-next-step-plan.md) | 当前 `GET /api/search` 的实现链路、返回字段和最小补强计划。 | 修搜索映射、查接口兼容性、确认不要破坏旧接口时。 |
| [api/README.md](./api/README.md) | API 协作说明，聚焦 demo search 主入口、兼容接口和安全边界。 | 本地存在 `docs/api/` 时，用于快速确认接口调用和边界。 |
| [api/demo-search.sample.json](./api/demo-search.sample.json) | `POST /api/demo/search` 的示例响应，包含 paths、people、personas、evidence/sourceRefs。 | 做前端 mock、接口联调、响应结构检查时。 |

## AI Prompt 资产

| 文件 | 作用 | 关键边界 |
|---|---|---|
| [prompts/persona-composer.system.md](./prompts/persona-composer.system.md) | 生成 `people[].aiPersona` 的固定 system prompt。 | evidence 不足时不能强行生成可聊分身。 |
| [prompts/persona-chat.system.md](./prompts/persona-chat.system.md) | `POST /api/personas/chat` 后续使用的固定 system prompt。 | 回答必须基于公开内容和 evidence，不代表作者本人。 |

## 历史设计与早期指令

| 文件 | 作用 | 注意事项 |
|---|---|---|
| [zhihu_hackathon_backend_design.md](./zhihu_hackathon_backend_design.md) | 早期后端总体设计，包含模块链路、接口草案、48 小时计划。 | 偏 Python/FastAPI 方案；当前实际后端是 Node.js + TypeScript + Express。 |
| [codex_backend_dev_instruction.md](./codex_backend_dev_instruction.md) | 早期下发给 Codex 的后端开发指令，写了 FastAPI 目录结构、接口和测试要求。 | 只作历史参考，不要直接用它覆盖当前 Node.js 后端。 |

## 目录结构

```text
docs/
  README.md
  AI_HANDOFF.md
  codex-reporting-standard.md
  backend-ai-persona-integration-plan.md
  backend-next-step-plan.md
  frontend-field-guide.md
  zhihu_hackathon_backend_design.md
  codex_backend_dev_instruction.md
  api/
    README.md
    demo-search.sample.json
  prompts/
    persona-composer.system.md
    persona-chat.system.md
```

## 维护规则

- 新增文档时，同步更新本导航。
- 每次 Codex 开发任务完成后，必须按 `docs/codex-reporting-standard.md` 输出验收报告。
- 接口结构变化时，同步检查 `shared/openapi.yaml`、`shared/demo-response.sample.json`、`docs/frontend-field-guide.md` 和相关 API 样例。
- `GET /api/search` 是已实现的底层搜索映射接口；AI 分身产品层不要把它当最终页面数据结构。
- 早期 `POST /api/v1/match/query` 保留为 future API，不作为当前 P0 主链路。
- 所有知乎内容相关展示、匹配理由、详情和 AI 分身回答都必须回到真实或 mock 的 `evidence/source`。
- 不提交 `.DS_Store`、真实 API Key、Token、Secret 或本地环境配置。
