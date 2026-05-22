# Frontend v2 Refactor Task for Codex

日期：2026-05-22
来源：GitHub Issue #2
任务性质：约束信息更新后的前端 v2 重构执行说明

## 本轮目标

为下一轮前端 v2 重构建立清晰执行边界：用原生 HTML/CSS/JS 模块化方式验证产品主链路，替代继续堆单文件 Demo 的做法。

本轮任务说明只描述未来执行方式。本次 Issue #2 不开始前端实现。

## 修改范围

未来执行前端 v2 重构时，修改范围应限制在 `frontend/` 目录中的前端静态文件。

本轮文档更新范围仅包含：

- `docs/frontend/frontend-v2-architecture.md`
- `docs/tasks/frontend-v2-refactor-codex.md`
- `docs/AI_HANDOFF.md`

不得修改 `backend/` 代码，不得重构当前 `frontend/` 实现代码。

## 推荐文件结构

```text
frontend/
├── index.html
├── styles.css
├── mockData.js
├── state.js
├── app.js
├── views/
│   ├── entryView.js
│   ├── feedView.js
│   ├── readingView.js
│   ├── bookView.js
│   └── capsuleView.js
├── components/
│   ├── topBar.js
│   ├── clarifyCard.js
│   ├── pathModule.js
│   ├── personCard.js
│   ├── peopleModal.js
│   ├── chatModal.js
│   └── rightRail.js
└── services/
    ├── api.js
    └── mockApi.js
```

## 产品主链路

未来前端 v2 重构必须优先跑通下面的主链路：

```text
首次极简输入
→ 未登录时内嵌知乎登录提示
→ mock 登录成功后继续提交
→ 顶部输入框 + loading
→ 必要时补充关键信息
→ 三栏 Feed：左侧路径导航 / 中间路径话题 Feed / 右侧路书与互动记录
→ 路径模块下展示人物卡
→ 点击路径人数打开居中人物列表弹窗
→ 人物卡只保留：TA 的经历 / 加入路书 / 读原文
→ 原文页底部出现：加入路书 / 和 TA 的 AI 分身聊 / 给 TA 写一句话
→ 互动记录可展示具体内容，并可在当前页面用弹窗继续聊天
→ 路书页
→ 时间胶囊页
```

## 架构约束

1. 不允许继续写单文件巨型 `frontend/index.html`。
2. 前端验证版必须采用原生 HTML/CSS/JS 模块化，不引入 React / Vue / Vite。
3. 所有业务数据先从 `mockData.js` 读取，禁止写死在组件里。
4. 所有页面状态集中在 `state.js`，禁止状态散落在多个视图文件里。
5. 所有 UI 模块使用函数组件式写法，例如 `renderTopBar()`、`renderPathModule()`、`renderPersonCard()`、`renderPeopleModal()`、`renderChatModal()`。
6. 所有 API 调用预留在 `services/api.js` 和 `services/mockApi.js`。
7. CSS 统一放在 `styles.css`，使用 CSS 变量，避免在 JS 中写大量内联样式。
8. 当前阶段目标是验证产品主链路，不追求正式工程完备性。
9. 后续如果产品形态稳定，再评估升级 React / Vue。

## 禁止事项

- 不接真实 OAuth，使用 mock 登录。
- 不接真实 LLM，AI 分身使用 mock 回复。
- 不改后端。
- 不接真实 `/api/demo/search` 或 `/api/personas/chat`。
- 不引入组件库。
- 不显示评分、贴近度、风险等级、百分比。
- 不展示 AI 分析过程。
- Feed 人物卡不放 AI 分身入口。
- 补充信息入口从顶栏状态条触发，不插入 Feed 流。
- 路径人数列表使用居中弹窗，不使用右侧抽屉。
- 继续互动使用聊天弹窗，不跳转到原文页。

## 验收方式

文档约束更新完成后运行：

```bash
git diff --check
npm run build -w backend
```

并检查：

1. 新增/更新的 MD 文件结构清晰。
2. 架构约束没有写进 PRD 主体。
3. `docs/AI_HANDOFF.md` 顶部有本轮交接记录。
4. 本轮不修改 `backend/` 代码。
5. 本轮不重构 `frontend/` 实现代码，只更新约束文档。

## 执行提醒

这是一次约束信息更新和后续任务说明，不是正式开发任务。执行 Issue #2 时不要开始写前端实现。
