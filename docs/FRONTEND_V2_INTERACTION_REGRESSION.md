# Frontend V2 Interaction Regression

## 背景

后端最小集成后，`frontend/` 开始通过 `services/api.js` 创建并轮询 agent task。这个变化应该只改变数据来源，不应该改变 v2 原型已经确认的首页、补充信息、loading、feed 转场和右侧轨迹栏体验。

## 回归点

- 真实接口分支在 task running/succeeded 时会直接写入 `feed/loading/loaded`，绕过 `entryExiting`、`loadingEntering`、`loadingExiting`、`feedEntering`。
- 接口快速返回时可能直接进入结果页，loading 的人来人往和阶段文案看不清。
- 后端不可用时会直接进入 error，而不是保留本地静态 mock demo 的可演示能力。
- backend `need_input` 分支需要继续走首页 composer 内展开，而不是恢复成独立页面、弹窗或横向状态条。

## 已恢复

- 未登录提交仍只弹登录 modal，登录后沿用原 query 继续流程。
- 补充信息仍在首页输入 composer 内展开：标题渐隐、composer 上移、query 置顶、轻分割线、clarify panel 向下展开。
- mock 和真实接口的 running/succeeded 都复用同一条纵向时间线：entry 向上淡出，loading 从下方进入，loading 向上淡出，feed 从下方进入。
- loading 最短展示时间统一为 3 秒，真实接口快速返回也等待最短展示时间。
- feed 保持三栏布局，feed header 不重复“相似经历”，右侧栏继续只承担「刚看过」「刚聊过」会话轨迹。
- 右侧栏默认各展示 3 条，超过 3 条显示“查看更多”，展开后最多 10 条并在卡片内滚动。

## 保留的真实接口能力

- `services/api.js` 仍负责 agent task 创建、状态轮询、结果读取和 refine。
- `services/adapter.js` 仍负责把后端 task/result/need_input 标准化成前端 view 可用字段。
- `app.js` 只消费 adapter 后的 `paths / people / personas / meta / needInput`，不让 view 直接依赖后端原始字段。
- 非 fallback 的后端错误仍进入轻 error 状态，避免把失败伪装成真实结果。

## Mock Fallback

- `?api=mock` 或 `localStorage.lifeSampleApiMode = "mock"` 时完全走本地 mock。
- 默认 backend 模式下，如果静态前端无法访问后端、后端路由不存在、或本地静态服务返回 `404 / 405 / 501`，会回落到 `MockApi`。
- fallback 仍保留模糊输入补充信息流程；如果用户已经点击“先直接看”或已提交补充信息，则直接进入 loading 和 mock feed。
- mockData 继续作为本地演示数据和后端不可用兜底，不改变 UI 结构。

## 仍待确认

- 真实 agent task 的 `need_input.questions` 字段需持续通过 adapter 映射到 `{ id, text, options[] }`。
- 后端 `frontendStatus` 文案如果过长，需要在 adapter 或服务层收敛，避免污染 loading 层级。
- 当前 fallback 只覆盖本地不可用/路由缺失类错误；限流、鉴权、服务端明确失败仍展示 error。
