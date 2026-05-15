# 人生样本库 60s 产品介绍视频

这是基于 `/Users/ning/Desktop/frontend-handoff/frontend/index.html` 和仓库当前 `frontend/index.html` 制作的 HyperFrames composition。

## 内容结构

- 0-7s：用户写下真实困惑
- 7-14s：产品边界，不给标准答案
- 14-22s：Agent 读取、识别、生成问题、匹配公开经历
- 22-31s：五条前人路径橱窗
- 31-40s：人物样本与匹配理由
- 40-48s：公开原文与 evidence/source
- 48-55s：经验分身与边界提醒
- 55-60s：收束为产品主张

## 预期渲染

```bash
npx hyperframes lint
npx hyperframes validate
npx hyperframes inspect --samples 15
npx hyperframes render --output renders/life-sample-library-intro.mp4 --quality standard --fps 30
```

## 本次产物

- MP4: `renders/life-sample-library-intro.mp4`
- 普通交互 HTML: `interactive.html`
- Contact sheet: `renders/life-sample-library-intro-contact-sheet.jpg`
- 抽查帧: `renders/frame-52s.jpg`, `renders/frame-58s.jpg`

`index.html` 是 HyperFrames 视频源文件，直接用 `file://` 打开不会播放 timeline。需要预览动画时用 HyperFrames Studio；需要普通浏览器交互演示时打开 `interactive.html`。

`interactive.html` 默认是大屏放映模式，不显示底部控制条：空格播放/暂停，点击空白处播放/暂停，左右方向键切换场景，`F` 或双击进入/退出全屏。

## 本次验证

- `npx --yes hyperframes lint .`: 0 errors，1 warning（单文件较大，当前作为单 composition 交付保留）。
- `npx --yes hyperframes validate .`: No console errors，68 text elements pass WCAG AA。
- `npx --yes hyperframes inspect . --samples 15`: 0 layout issues。
- `/opt/homebrew/bin/ffprobe`: 输出为 60.000s、1800 frames、1920x1080、30fps。

备注：本机 `ffprobe` 位于 `/opt/homebrew/bin/ffprobe`，渲染时需要把 `/opt/homebrew/bin` 放入 `PATH`。
