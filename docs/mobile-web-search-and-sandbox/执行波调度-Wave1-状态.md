# Wave 1 执行波调度状态跟踪（基础底座与原生双轨）

> **工作区**：`docs/mobile-web-search-and-sandbox/`
> **批次编号**：`WAVE-01-INFRA-AND-NATIVE`
> **总体状态**：**已全部完成并通过 100% 单元测试（240+ Tests Passed）**

---

## 一、任务分工与交付矩阵

| 任务 ID | 子 Agent 角色 | 目标文件域 | 核心职责 | 测试通过数 | 状态 |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **W1-1** | Shared Core Architect | `packages/shared-types/src/web-search.ts`<br>`packages/shared-utils/src/network/ssrfGuard.ts`<br>`packages/shared-utils/src/citation/citationParser.ts` | 跨端搜索/引用契约下沉；纯 TS 位运算复刻 Rust `ip_class.rs` SSRF 门禁；引用角标无损解析 | 26/26 (全包417通过) | **已交付** |
| **W1-2** | Mobile Arbiter Architect | `apps/crish-mobile/src/domain/types/webSearch.ts`<br>`apps/crish-mobile/src/domain/pure/webSearch/dualTrackArbiter.ts` | 移动端专有搜索类型扩展；双轨路由仲裁器（原生优先 + 自动屏蔽客户端工具防冲突） | 36/36 | **已交付** |
| **W1-3** | Dialects Protocol Architect | `apps/crish-mobile/src/domain/pure/webSearch/dialects/*` | 11 种模型原生方言（OpenAI, Anthropic, Gemini, Grok, 智谱, 百炼等）请求注入器 | 44/44 | **已交付** |
| **W1-4** | Grounding Parser Architect | `apps/crish-mobile/src/domain/pure/webSearch/groundingParser.ts` | 模型原生流式推送的 Grounding 元数据、来源卡片与字符级引文定位归一化 | 24/24 | **已交付** |
| **W1-5** | Tool Call Stream Architect | `apps/crish-mobile/src/domain/pure/webSearch/streamingToolCallAccumulator.ts` | 流式 SSE 下细碎 `tool_calls` 分片聚合器与 JSON 容错提取 | 27/27 | **已交付** |
| **W1-6** | Database Migration Architect | `apps/crish-mobile/src/db/migrations/v6_web_search_and_tools.ts`<br>`apps/crish-mobile/src/db/migrations.ts`<br>`apps/crish-mobile/src/db/dao/localThreadsDao.ts` | SQLite v6 单表单行追加 5 个可空 JSON 列迁移与 DAO 健壮解码器 | 83/83 (DB全绿) | **已交付** |

---

## 二、验收结论
Wave 1 所有纯函数、契约类型、网络安全门禁、方言注入、流式 Grounding 解析、Tool Call 累加器与数据库迁移全部落地，且各自建立了独立的单元测试套件，零破坏、零退避、100% 绿灯。
