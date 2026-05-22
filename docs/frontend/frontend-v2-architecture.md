# Frontend v2 Architecture Constraints

日期：2026-05-22
适用范围：前端 v2 产品形态验证阶段

本文是长期有效的前端架构约束文档，用来约束下一轮前端 v2 重构方向。当前阶段目标是验证产品主链路，不追求正式工程完备性，也不把架构约束写入 PRD 主体。

## 阶段结论

前端 v2 验证版采用原生 HTML/CSS/JS 模块化方案。

本阶段不继续堆单文件 Demo，也暂不直接引入 React / Vue / Vite。等产品形态稳定、交互边界清晰后，再评估是否升级到 React / Vue 或其他正式前端工程方案。

## 推荐结构

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

## 架构约束

1. 不允许继续写单文件巨型 `frontend/index.html`。
2. 前端验证版必须采用原生 HTML/CSS/JS 模块化，不引入 React / Vue / Vite。
3. 所有业务数据先从 `mockData.js` 读取，禁止写死在组件里。
4. 所有页面状态集中在 `state.js`，禁止状态散落在多个视图文件里。
5. 所有 UI 模块使用函数组件式写法，例如 `renderTopBar()`、`renderPathModule()`、`renderPersonCard()`、`renderPeopleModal()`、`renderChatModal()`。
6. 所有 API 调用预留在 `services/api.js` 和 `services/mockApi.js`。
7. CSS 统一放在 `styles.css`，使用 CSS 变量，避免在 JS 中写大量内联样式。
8. 视图文件只负责页面级组合，例如入口、Feed、原文阅读、路书、时间胶囊。
9. 组件文件只负责可复用 UI 模块，不维护业务主状态。
10. 当前阶段只验证产品主链路，不追求正式工程完备性。
11. 后续如果产品形态稳定，再评估升级 React / Vue。

## 产品主链路

前端 v2 必须围绕下面的主链路验证体验：

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

## 明确禁止事项

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

## 数据和接口策略

- `mockData.js` 是本阶段唯一业务数据源。
- `services/mockApi.js` 模拟登录、搜索、补充信息、路书、时间胶囊和 AI 分身回复。
- `services/api.js` 只保留未来真实接口适配占位，不在本阶段接入真实后端。
- 当前阶段不调用 `/api/demo/search`、`/api/personas/chat` 或真实 OAuth 接口。

## 验收口径

- 文档约束清晰，能直接指导前端 v2 重构。
- 架构约束留在本文件和任务说明中，不写入 PRD 主体。
- 后续实现只在 `frontend/` 下做原生模块拆分，不修改 `backend/`。
- 本阶段完成前不得开始真实 OAuth、真实 LLM、真实后端 API 接入。
