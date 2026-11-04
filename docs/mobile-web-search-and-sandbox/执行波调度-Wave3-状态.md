# Wave 3 执行波调度状态跟踪（QuickJS 沙箱、端侧网页提纯与本地多轮 Agent 循环）

> **工作区**：`docs/mobile-web-search-and-sandbox/`
> **批次编号**：`WAVE-03-QUICKJS-SANDBOX-AND-LOCAL-AGENT-LOOP`
> **调度规则**：单轮派发 5 个子 Agent，文件域严格正交，统一使用 pwsh7，子 Agent 严禁 git commit/reset，必须自测通过后汇报。
> **调度状态**：✅ 100% 验收通过（待主控收口提交）

---

## 一、任务分工与文件域矩阵

| 任务 ID | 子 Agent 角色 | 目标文件域 | 核心职责 | 状态 |
| :--- | :--- | :--- | :--- | :--- |
| **W3-1** | QuickJS Sandbox Module Architect | `apps/crish-mobile/modules/crish-js-sandbox/*` | 构建 `crish-js-sandbox` Expo 原生模块：QuickJS-NG C++ 核心接口、iOS/Android 桥接、5s/64MB 硬熔断与 Node/Hermes 双模 Fallback 运行时 | ✅ 交付完毕 (20/20 测试全绿) |
| **W3-2** | Page Extraction Pipeline Architect | `apps/crish-mobile/src/adapters/extraction/*` | 网页正文提纯引擎（`extractPageContent.ts`）：基于 LinkeDOM + Readability + Turndown 的纯文本/Markdown 转换流水线与 4K Token 截断 | ✅ 交付完毕 (23/23 测试全绿) |
| **W3-3** | Web Fetcher & Safe Downloader Architect | `apps/crish-mobile/src/adapters/webFetch/*` | 安全网页下载器（`downloadWebPage.ts`）：位运算 SSRF 刚性拦截、300KB 流式截断、全局单并发插槽 `AsyncSemaphore(1)`、防重定向环路 | ✅ 交付完毕 (79/79 测试全绿) |
| **W3-4** | Mobile Tool Registry Architect | `apps/crish-mobile/src/adapters/tools/*` | 通用端侧工具系统：`toolRegistry.ts`，内置 `web_search`、`web_fetch`（正文提取）与 `run_js_sandbox`（端侧脚本计算器）标准适配层 | ✅ 交付完毕 (33/33 测试全绿) |
| **W3-5** | Local Agent Loop Architect | `apps/crish-mobile/src/domain/pure/localChatProtocol.ts`<br>`apps/crish-mobile/src/adapters/localChat/localChatEngine.ts`<br>配套测试文件 | 解除本地协议锁（Prompt 赋能、Wire 出站保全、Tool Call 聚合）、构建本地多轮自主 Agent Loop（上限 6 轮、AbortSignal 级联、错误自愈回放） | ✅ 交付完毕 (98/98 测试全绿) |

---

## 二、验收门禁要求（DoD）
1. 每个子任务必须产出完整源码与高覆盖率单元测试；
2. 运行单元测试（`npm test`）确保 100% 绿色通过（9 套件 253 项测试 100% passed）；
3. 遵循反过度设计红线与反退避铁律，杜绝魔术数字与假实现；
4. 运行 `tsc --noEmit` 确保严格零类型错误（0 错误通过）；
5. 子 Agent 将改动完整保留在工作区，由主 Agent 验证后统一收口提交。
