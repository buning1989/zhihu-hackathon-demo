# Frontend v2 Visual Alignment

## 原型基线

本轮视觉修复以本地原型文件作为唯一设计基线：

- `/Users/ning/Downloads/rensheng_yangbenku_html_wireframe_v_2.html`

已迁移并复用的主要设计 token：

- 色彩：白底、`#f7f6f3` 次级底色、`#e8e6e0` 细边框、`#c8c4bc` 强边框、`#1a1a1a` 主文字、`#666` 次级文字、`#999` 弱文字、`#f5a623` 强调色。
- 字体：系统中文字体栈，正文 `line-height: 1.8`。
- 宽度：顶栏和三栏主布局 `max-width: 1160px`，中间 feed `680px`，原文和路书主体 `640px`。
- 三栏：`200px minmax(0, 680px) 240px`，`gap: 32px`。
- 圆角：卡片和弹窗主要使用 `18px`，按钮和 chip 使用 pill 形态。
- 交互态：黑色主按钮、浅底次按钮、chip 选中态、fixed bottom bar、居中 modal overlay。

## 已对齐页面

- 首页输入态：恢复居中输入区、品牌行、主标题、线性 textarea、登录提示卡。
- 顶部输入状态：恢复 sticky top-bar、三列结构、顶部线性输入框、状态栏路径数/人数/补充入口。
- loading 态：输入框上移后保留顶部状态和中间 loading 提示。
- 信息补充卡：恢复 `clarify-wrap` / `clarify-panel` 层级、问题标题、chip 选中态和底部双按钮。
- feed 加载完成态：恢复左路径导航、中 feed、右路书记录的三栏结构和 sticky rail。
- 路径模块：恢复路径标题、代表原话、人数按钮、人物卡层级。
- 人物卡：恢复头像、昵称、brief、similar 标签、quote、preview 和三按钮动作。
- 人物经历展开：新增 inline timeline 视觉层级，含阶段文本、圆点和竖线。
- 人物列表弹窗：恢复居中 modal、overlay、header、滚动列表和点击进入原文。
- 原文页：恢复 `reading-main` 宽度、标题/source/body 和 fixed bottom action bar。
- AI 分身聊天：恢复居中聊天 modal、header、说明、bubble 和 input row。
- 路书页：恢复 `book-main`、kicker、标题、block 和 divider。
- 时间胶囊页：恢复极简居中写信态、封存后的 `capsule-card` 背景变化和逐字显示效果。

## 仍有差异

- 原型是单文件静态 HTML，当前实现保持模块化 v2 架构，因此 DOM 分布在 views/components 中，类名已尽量对齐，但不是逐行同构。
- 当前 mockData 的人物数量和内容沿用 v2 mock 产品链路，未为了视觉完全复制原型文案。
- 当前头像继续使用 `frontend/assets/mirofish-character-svgs/` 中的本地 SVG 资源，未新增图片资产。
- 在窄视口下，左侧路径导航和右侧路书按原型响应式规则隐藏；桌面三栏需要在宽视口手动验收。
- 右侧继续互动属于桌面右 rail 交互，窄视口浏览器验证时只能确认 DOM 和状态存在，最终视觉点击应在桌面宽度下复查。
- 时间胶囊日期固定使用当前浏览器日期展示，封存开启日期仍走 mock hidden input。

## 差异原因

- 本轮目标是视觉一致性修复，不新增功能、不接真实接口，因此保留现有 mock 状态流和数据结构。
- 为避免重写业务逻辑，主要通过 CSS token、布局类名和局部 DOM 层级调整完成对齐。
- 当前验证环境的内嵌浏览器宽度约为移动视口，无法覆盖桌面三栏所有可视交互，需要补充手动宽屏截图。

## 下一轮建议

- 在桌面宽度下补齐三栏、路径筛选和右 rail 继续互动的截图验收。
- 若后续要接真实 backend agent task 接口，可在 services 层增加字段 adapter，继续保持 view/component 只读渲染。
- 为 top-bar、clarify、modal、fixed bar 建立轻量视觉回归截图基准，避免后续接口接入时样式漂移。
- 统一 mockData 与后端契约中的 timeline 字段，减少人物经历展开的 fallback 逻辑。

## 手动验收截图清单

- 首页输入态：首次打开 `/`，居中品牌、标题和底部线性 textarea。
- 登录提示态：未登录提交输入后，输入框下方出现内嵌登录提示卡。
- loading 态：登录后输入框上移到顶部，中间显示 loading。
- 信息补充卡展开态：点击顶部“补充关键信息”，检查问题、chip、双按钮位置。
- feed 加载完成态：桌面宽度检查左路径导航、中 feed、右路书三栏。
- 路径筛选态：点击左侧任一路径，检查 active 状态和中间 feed 过滤结果。
- 人物经历展开态：点击人物卡“TA 的经历”，检查 timeline-inline。
- 人物列表弹窗：点击路径人数按钮，检查居中弹窗和滚动人物列表。
- 原文页：从弹窗或人物卡进入原文，检查 reading-main 和底部 fixed bar。
- AI 分身聊天弹窗：原文页点击“和 TA 的 AI 分身聊”，检查 overlay、bubble、input row。
- 右侧继续互动：桌面宽度点击右 rail 的“继续互动”，确认当前页打开聊天弹窗。
- 路书页：点击顶栏“路书”，检查 book-main、book-block 和返回动作。
- 时间胶囊页：点击“时间胶囊”，写入文字并封存，检查背景变化和逐字显示。
