# Demo 演示验收 Checklist

目标：3 分钟内确认后端 mock demo、preview 页面和 AI 分身边界可演示。

默认问题：

```text
不工作了能去哪儿
```

## 1. 启动服务

在项目根目录启动后端：

```bash
BACKEND_PORT=8000 npm run dev:backend
```

另开一个终端启动 preview 页面：

```bash
python3 -m http.server 3000 --directory frontend
```

验收：

- [ ] `http://127.0.0.1:8000/api/health` 返回 `success: true`。
- [ ] `http://127.0.0.1:3000/` 可以打开 preview 页面。

## 2. 走一遍页面演示

打开：

```text
http://127.0.0.1:3000/
```

在 preview 搜索框输入默认问题并提交：

```text
不工作了能去哪儿
```

验收：

- [ ] 页面能展示问题理解或分析区。
- [ ] 页面能展示至少 3 条 `paths`。
- [ ] 页面能展示至少 3 个 `people` 人物样本。
- [ ] 页面能展示 `personas` / AI 分身入口。
- [ ] 如果当前 preview 仍是静态占位页，跳过页面字段检查，继续使用第 3、4 步接口检查完成演示验收。

## 3. 验证 demo search 数据

调用产品层主接口：

```bash
curl -s -X POST "http://127.0.0.1:8000/api/demo/search" \
  -H "Content-Type: application/json" \
  -d '{"query":"不工作了能去哪儿","count":3,"dataMode":"mock"}'
```

验收：

- [ ] 顶层返回 `success: true`。
- [ ] `data.schemaVersion` 是 `demo.v1`。
- [ ] `data.features.personaChat` 是 `mock`。
- [ ] `data.paths` 非空，且每条 path 有 `evidenceIds` 和 `sourceRefs`。
- [ ] `data.people` 非空，且每个人物有 `articles`、`match`、`aiPersona`。
- [ ] `data.personas` 非空，且每个 persona 可用 `personId` 回查到 `people[]`。
- [ ] `data.meta.sourceRefs` 非空，且每个 source 有 `url`、`title`、`author`、`evidenceIds`。
- [ ] 所有事实性展示都能回到 `evidenceIds` / `sourceRefs`，没有把 AI 回答当成事实来源。

有 `jq` 时可快速看摘要：

```bash
curl -s -X POST "http://127.0.0.1:8000/api/demo/search" \
  -H "Content-Type: application/json" \
  -d '{"query":"不工作了能去哪儿","count":3,"dataMode":"mock"}' \
  | jq '.data | {
      schemaVersion,
      queryId,
      personaChat: .features.personaChat,
      paths: (.paths | length),
      people: (.people | length),
      personas: (.personas | length),
      sources: (.meta.sourceRefs | length)
    }'
```

## 4. 验证 AI 分身边界和 mock chat

先从 demo search 响应里取第一条 persona 的 `id` 和 `queryId`。mock 数据常见第一条是：

```text
persona_city_pause
```

调用 persona chat：

```bash
curl -s -X POST "http://127.0.0.1:8000/api/personas/chat" \
  -H "Content-Type: application/json" \
  -d '{"personaId":"persona_city_pause","queryId":"query_mock","message":"这段公开内容里，第一步应该想清楚什么？"}'
```

验收：

- [ ] 顶层返回 `success: true`。
- [ ] `data.schemaVersion` 是 `personaChat.v1`。
- [ ] `data.meta.mode` 是 `mock`。
- [ ] `data.meta.llmUsed` 是 `false`。
- [ ] `data.sourceRefs` 非空。
- [ ] `data.boundaryNotice` 固定为：`该 AI 分身基于公开内容生成，不代表作者本人。`
- [ ] 回复中没有“作者本人在线”“联系 TA”“私信 TA”“我就是作者本人”等表达。
- [ ] 页面入口或聊天顶部也能看到同等含义的 boundary notice。

## 5. 异常排查

- 后端启动失败：先跑 `npm install`，再跑 `npm run build -w backend` 看 TypeScript 错误。
- 端口被占用：换端口启动，例如 `BACKEND_PORT=8001 npm run dev:backend`，页面或 curl 地址同步改成 `8001`。
- `/api/demo/search` 返回 404：确认启动的是最新构建；停止后端进程后重新执行 `BACKEND_PORT=8000 npm run dev:backend`。
- preview 打不开：确认 `python3 -m http.server 3000 --directory frontend` 仍在运行；如端口占用，改用 `python3 -m http.server 3001 --directory frontend`。
- 页面没有搜索交互：当前可能仍是静态占位页，用第 3、4 步接口验收替代页面输入。
- 没有 `jq`：直接看完整 JSON；核心只需确认 `success`、`paths`、`people`、`personas`、`sourceRefs`、`boundaryNotice`。
- evidence/source 缺失：优先检查 `docs/api/demo-search.sample.json` 与 `backend/src/guards/demoEvidence.guard.ts` 的字段要求。
