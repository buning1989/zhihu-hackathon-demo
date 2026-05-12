# 下发给 Codex 的后端开发指令

你是一名资深后端工程师。请根据以下要求实现一个知乎黑客松 demo 的后端框架。当前只开发后端，不开发前端。知乎搜索 API 和 AI 模型 API Key 暂时没有，需要预留环境变量，并保证没有 Key 时仍能通过 mock 数据完整跑通。

---

## 1. 项目目标

实现一个 FastAPI 后端，用于把用户输入的人生问题转化为“知乎真实内容中的人、内容、路径和可能性”。

用户输入示例：

```text
不工作了能去哪儿？
```

后端应返回：

- 可能性地图；
- 人物卡 / 观点作者卡 / 内容卡；
- 作者昵称、头像、一句话总结、标签；
- 匹配点；
- 原文证据句；
- 知乎原文链接；
- 详情页 blocks；
- 继续追问接口；
- 存档接口；
- 如果内容不足，返回构建态 build_prompt。

---

## 2. 技术栈要求

使用：

```text
Python 3.11+
FastAPI
Pydantic v2
httpx
python-dotenv
uvicorn
pytest
```

不要引入复杂数据库。P0 使用本地 JSON / 内存存储即可。可选 SQLite，但不是必须。

---

## 3. 必须支持的运行模式

通过环境变量 `DATA_MODE` 控制：

```text
mock：只读本地 mock 数据
cache_first：先读缓存，未命中再尝试真实 API
real：优先调真实 API，失败后降级缓存 / mock
```

通过 `ENABLE_LLM` 控制是否调用真实模型：

```text
ENABLE_LLM=false 时，所有 AI 节点必须使用 deterministic stub。
ENABLE_LLM=true 时，读取 LLM_API_KEY / LLM_BASE_URL / LLM_MODEL。
```

---

## 4. 环境变量

创建 `.env.example`：

```env
APP_ENV=dev
DATA_MODE=mock
ENABLE_LLM=false

ZHIHU_SEARCH_API_URL=
ZHIHU_API_KEY=
ZHIHU_APP_ID=
ZHIHU_API_TIMEOUT=10

LLM_API_KEY=
LLM_BASE_URL=
LLM_MODEL=
LLM_TIMEOUT=20

CACHE_DIR=app/data/cache
MOCK_DATA_PATH=app/data/mock/seed_contents.json

HOST=0.0.0.0
PORT=8000
```

不要在代码中硬编码任何 API Key。

---

## 5. 目录结构

请创建如下结构：

```text
backend/
  app/
    main.py
    config.py
    api/
      routes_health.py
      routes_match.py
      routes_cards.py
      routes_archive.py
    models/
      schemas.py
      domain.py
    services/
      router_service.py
      planner_service.py
      zhihu_adapter.py
      cache_service.py
      normalizer.py
      evidence_extractor.py
      possibility_gate.py
      repair_planner.py
      build_prompt_builder.py
      person_aggregator.py
      ranker.py
      card_composer.py
      detail_builder.py
      grounded_qa.py
      archive_service.py
    clients/
      llm_client.py
      zhihu_client.py
    data/
      mock/
        seed_contents.json
      cache/
    utils/
      hashing.py
      text.py
      time.py
  tests/
    test_match_query.py
    test_possibility_gate.py
    test_normalizer.py
  requirements.txt
  README.md
  .env.example
```

---

## 6. 需要实现的 API

### 6.1 健康检查

```http
GET /api/v1/health
```

返回：

```json
{
  "status": "ok",
  "version": "v0.1"
}
```

---

### 6.2 查询入口

```http
POST /api/v1/match/query
```

请求：

```json
{
  "query": "不工作了能去哪儿？",
  "session_id": "s_001",
  "mode": "cache_first"
}
```

返回必须包含：

```text
schema_version
match_id
query_view
possibility
sections
meta
debug
```

---

### 6.3 获取 match 结果

```http
GET /api/v1/match/{match_id}
```

返回之前生成的 match result。P0 可使用内存存储。

---

### 6.4 获取卡片详情

```http
GET /api/v1/cards/{card_id}/detail
```

返回详情页 blocks。

---

### 6.5 基于公开内容追问

```http
POST /api/v1/cards/{card_id}/ask
```

请求：

```json
{
  "question": "他最担心的是什么？"
}
```

返回必须基于该 card 的 evidence，不允许自由发挥。

---

### 6.6 存档

```http
POST /api/v1/archive
```

请求：

```json
{
  "card_id": "card_001",
  "match_id": "m_001",
  "note": "这个路径可以继续看"
}
```

返回：

```json
{
  "archive_id": "a_001",
  "status": "saved"
}
```

---

## 7. 模块职责

### 7.1 planner_service.py

实现：

```python
plan_query(raw_query: str) -> QueryPlan
```

无 LLM 时，使用规则 stub。

对于 `不工作了能去哪儿`，返回 5 个多样化 query：

```text
裸辞后去小城市生活 真实经历
离职后自由职业一年后怎么样
裸辞 gap year 后来怎么样
裸辞后后悔了 真实经历
不上班以后靠什么收入 亲身经历
```

---

### 7.2 zhihu_adapter.py / zhihu_client.py

实现：

```python
search_zhihu(query: str, limit: int = 10) -> list[RawZhihuContent]
```

如果没有 API Key 或 `DATA_MODE=mock`，读取 `seed_contents.json` 并根据 query 做简单过滤或直接返回。

真实 API 预留字段：

```text
ZHIHU_SEARCH_API_URL
ZHIHU_API_KEY
ZHIHU_APP_ID
```

---

### 7.3 normalizer.py

实现：

```python
normalize_content(raw: RawZhihuContent) -> ContentItem
```

功能：

- 清洗标题中的 ` - 知乎`；
- 从 URL 解析 question_id / answer_id；
- 生成 `person_key = sha256(AuthorName + AuthorAvatar)`；
- 标准化 stats。

---

### 7.4 evidence_extractor.py

实现：

```python
extract_evidence(content: ContentItem, query_plan: QueryPlan) -> EvidenceItem
```

无 LLM 时，使用规则 stub：

- 如果正文包含 `我`、`我的`、`亲身经历`、`我当时`，可判断为 `first_person_story`；
- 如果包含 `我跟不少`、`很多人`、`观察`，可判断为 `observational_advice`；
- 如果包含 `建议`、`成本`、`风险`，可判断为观点或分析；
- evidence_quotes 从包含关键词的句子中截取。

必须输出：

```text
experience_type
first_person_experience
path_type
matched_points
evidence_quotes
can_show_as_person_card
can_show_as_life_story
```

---

### 7.5 possibility_gate.py

实现：

```python
evaluate_possibility(evidence_items: list[EvidenceItem]) -> PossibilityResult
```

状态规则：

```text
rich:
- 有效内容 >= 12
- 有效作者 >= 5
- 路径类型 >= 4
- 第一人称经历 >= 2
- 证据句 >= 10

enough:
- 有效内容 >= 6
- 有效作者 >= 3
- 路径类型 >= 2
- 证据句 >= 5

narrow:
- 有效内容够，但路径类型 < 2
- 或结果集中在单一观点

scarce:
- 有效内容 < 5
- 或有效作者 < 2
- 或证据句很少
```

输出包含：

```text
status
valid_content_count
valid_person_count
path_type_count
first_person_story_count
evidence_quote_count
missing_path_types
action
```

---

### 7.6 repair_planner.py

仅在 `narrow` 状态触发，最多补搜一轮。

实现：

```python
build_repair_queries(possibility: PossibilityResult) -> list[str]
```

可用规则模板。

---

### 7.7 build_prompt_builder.py

当 `scarce` 时返回构建态选项。

实现：

```python
build_prompt(raw_query: str) -> BuildPromptSection
```

选项：

```text
真的裸辞过的人
去了小城市的人
靠自由职业活下来的人
后来后悔的人
失败后复盘的人
```

---

### 7.8 person_aggregator.py

实现：

```python
aggregate_by_person(contents: list[ContentItem], evidences: list[EvidenceItem]) -> list[PersonCandidate]
```

按 `person_key` 聚合。

---

### 7.9 ranker.py

实现规则排序。

优先级：

```text
证据数量
路径多样性
RankingScore
first_person_story 加分
AuthorityLevel
VoteUpCount / CommentCount
```

---

### 7.10 card_composer.py

实现：

```python
compose_cards(candidates: list[PersonCandidate]) -> list[Card]
```

卡片类型：

```text
person_story_card
insight_author_card
content_card
```

文案要求：

- 不要写“精准匹配”；
- 不要写“最适合你的人”；
- 不要写“联系 TA”；
- 使用“TA 走过一条相近的路”“TA 把这个问题拆得很清楚”“这条公开表达击中了一个担心”等表达。

---

### 7.11 detail_builder.py

实现：

```python
build_detail(card_id: str) -> CardDetail
```

返回 blocks：

```text
relation_summary
evidence_quote
source_content
suggested_questions
```

---

### 7.12 grounded_qa.py

实现：

```python
answer_with_evidence(card_id: str, question: str) -> GroundedAnswer
```

无 LLM 时，返回基于 evidence_quotes 的模板答案。

---

### 7.13 archive_service.py

实现内存或 JSON 存档：

```python
save_archive(card_id: str, match_id: str, note: str) -> ArchiveResult
```

---

## 8. Mock 数据

创建 `app/data/mock/seed_contents.json`，至少包含 10 条内容。每条内容结构模拟知乎 API：

```json
{
  "Title": "当下,你敢裸辞吗? - 知乎",
  "ContentType": "Answer",
  "ContentID": "4389112587059352534",
  "ContentText": "# 当下，你敢裸辞吗？\n\n裸辞这件事...",
  "Url": "https://www.zhihu.com/question/654477796/answer/2037475407650349864",
  "CommentCount": 1,
  "VoteUpCount": 0,
  "AuthorName": "XMarco",
  "AuthorAvatar": "https://picx.zhimg.com/50/v2-e9503bc0bd5787160b0949ed1e32277d_l.jpg",
  "AuthorBadge": "",
  "AuthorBadgeText": "",
  "EditTime": 1778551991,
  "AuthorityLevel": "1",
  "RankingScore": 2.1169436
}
```

Mock 内容需要覆盖几类 path_type：

```text
小城生活
自由职业
Gap 过渡
失败复盘
裸辞风险分析
收入来源
```

---

## 9. 返回 JSON 示例

`POST /api/v1/match/query` 返回示例必须类似：

```json
{
  "schema_version": "v0.1",
  "match_id": "m_001",
  "query_view": {
    "raw_query": "不工作了能去哪儿？",
    "display_query": "想看看那些离开工作轨道的人，后来去了哪里",
    "guide_text": "这些内容不一定给你标准答案，但它们来自真实的公开表达。"
  },
  "possibility": {
    "status": "rich",
    "path_count": 4,
    "message": "这个问题下面，找到了几种不同的真实走法。"
  },
  "sections": [
    {
      "section_id": "possibility_map",
      "section_type": "path_clusters",
      "title": "这个问题下面，有几种真实走法",
      "clusters": []
    }
  ],
  "meta": {
    "data_mode": "mock",
    "source": "zhihu"
  },
  "debug": {}
}
```

---

## 10. 测试要求

至少实现以下测试：

```text
test_health_ok
test_match_query_returns_sections
test_normalizer_generates_person_key
test_possibility_gate_rich
test_possibility_gate_scarce
test_card_detail_returns_blocks
test_archive_save
```

---

## 11. README 要包含

请写 README，包含：

```text
项目简介
运行方式
环境变量说明
DATA_MODE 说明
API 列表
Mock 数据说明
如何接入真实知乎 API
如何接入真实 LLM API
测试命令
```

运行命令示例：

```bash
cd backend
pip install -r requirements.txt
cp .env.example .env
uvicorn app.main:app --reload --host 0.0.0.0 --port 8000
```

测试：

```bash
pytest
```

---

## 12. 重要约束

必须遵守：

```text
1. 没有 API Key 也必须能完整跑通。
2. 不得硬编码任何 Key。
3. 所有 AI 节点必须有 stub。
4. 所有推荐必须绑定 evidence_quotes 或 source_contents。
5. 不得把观点作者写成亲历者。
6. 不得实现“联系 TA”或假装可以私信。
7. 前端字段必须支持 sections / cards / blocks / actions。
8. 代码要模块化，方便后续替换真实 API。
```

---

## 13. 最终交付

请交付：

```text
可运行 FastAPI 后端
完整目录结构
mock 数据
.env.example
README
pytest 测试
上述 API 全部可调用
```

验收标准：

```text
运行服务后，调用 POST /api/v1/match/query，传入“不工作了能去哪儿？”，能返回包含 possibility_map、cards、evidence、actions 的 JSON。
调用 card detail 能返回 blocks。
调用 ask 能返回基于证据的回答。
调用 archive 能保存成功。
```
