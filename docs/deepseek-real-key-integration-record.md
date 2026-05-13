# DeepSeek real key 联调记录

日期：2026-05-13

## 本轮配置

- 当前只配置 DeepSeek real key，不配置 Kimi。
- 不要求配置 `KIMI_API_KEY`。
- 本记录不包含、也不应补充任何真实 API key、token 或 secret。

## 验收问题

```text
不工作了能去哪儿
```

## 联调结果

- `POST /api/demo/search` 使用 `dataMode=real` 联调通过。
- `intent_expand` 已通过，`succeeded=1`。
- `demo_response_compose` 已通过，`succeeded=1`。
- `grounding_guard` 已通过，`succeeded=1`。
- `evidence_extract` 因 Kimi 未配置走规则 fallback；这是当前预期状态。
- `POST /api/personas/chat` 当前为 `mock_fallback`，不要标记为 real。

## 验收输出

- `paths` 返回，数量大于 0。
- `people` 返回，数量大于 0。
- `personas` 返回，数量大于 0。
- persona chat 响应中 `boundaryNotice` 存在。
- persona chat 响应中 `sourceRefs` 存在。
- persona chat 响应中 `suggestedQuestions` 存在。

## 本地 smoke test

新增脚本：

```bash
node scripts/smoke-demo-real-key.mjs
```

推荐验证顺序：

```bash
npm run build -w backend
npm run smoke:demo-real
```

脚本会启动构建后的本地 Express app，调用：

- `POST /api/demo/search`
- `POST /api/personas/chat`

脚本只校验响应结构和 debug 阶段结果，不读取、不打印任何真实 API key。
