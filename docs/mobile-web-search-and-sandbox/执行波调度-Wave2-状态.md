# Wave 2 执行波调度状态跟踪（客户端多源瀑布流搜索与安全设置）

> **工作区**：`docs/mobile-web-search-and-sandbox/`
> **批次编号**：`WAVE-02-CLIENT-SEARCH-WATERFALL`
> **调度规则**：单轮派发 5 个子 Agent，文件域严格正交，统一使用 pwsh7，子 Agent 严禁 git commit/reset，必须自测通过后汇报。
> **最终状态**：✅ **100% 交付并通过立体验证，全量 140 项单元测试全绿**

---

## 一、任务分工与文件域矩阵

| 任务 ID | 子 Agent 角色 | 目标文件域 | 核心职责 | 测试通过数 | 状态 |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **W2-1** | BYOK Providers Architect | `apps/crish-mobile/src/adapters/webSearch/providers/*` | 统一 `SearchProviderAdapter`；Tavily、Jina（含大陆容灾）、Brave、Google CSE、Bocha 直连驱动 | 25 / 25 | ✅ 已完成 |
| **W2-2** | Zero-Key Free Engines Architect | `apps/crish-mobile/src/adapters/webSearch/freeEngines/*` | DuckDuckGo HTML（含 `uddg` 逆向解密）、百度移动版（含 302 跟随）、维基百科 API；反爬防污染熔断器 | 24 / 24 | ✅ 已完成 |
| **W2-3** | Waterfall Orchestrator Architect | `apps/crish-mobile/src/domain/pure/webSearch/searchWaterfall.ts`<br>`apps/crish-mobile/src/adapters/webSearch/searchWaterfallOrchestrator.ts` | 纯函数评分重排去重打分；3.5s 全局硬预算四级搜索瀑布流编排器与竞速对冲放行 | 43 / 43 | ✅ 已完成 |
| **W2-4** | KeyManager & Store Architect | `apps/crish-mobile/src/domain/store/searchKeyManager.ts`<br>`apps/crish-mobile/src/domain/store/searchSettingsStore.ts` | 基于 `expo-secure-store` 硬件隔离的 `WebSearchKeyManager`（多 Key 轮询与 429 自愈）与 Zustand 配置状态机 | 28 / 28 | ✅ 已完成 |
| **W2-5** | Settings UI & ViewModel Architect | `apps/crish-mobile/src/adapters/viewmodels/useWebSearchSettingsVm.ts`<br>`apps/crish-mobile/app/settings-web-search.tsx` | 移动端设置中心页面与 ViewModel：一键 `checkProvider` 连通性测试、毫秒延迟气泡、原生优先与免 Key 引擎排序 | 20 / 20 | ✅ 已完成 |

---

## 二、验收门禁验证结果（DoD）

1. **单元测试立体覆盖**：
   - 命令：`npm --prefix apps/crish-mobile test -- src/adapters/webSearch/ src/domain/pure/webSearch/searchWaterfall.test.ts src/domain/store/searchKeyManager.test.ts src/domain/store/searchSettingsStore.test.ts src/adapters/viewmodels/useWebSearchSettingsVm.test.ts`
   - 结果：**7 个测试套件，140 个测试用例全部 100% 绿色通过（0 失败、0 告警）**。
2. **样式 Token 守卫验证**：
   - 命令：`npm --prefix apps/crish-mobile test -- src/__tests__/styleTokens.guard.test.ts`
   - 结果：**15 项设计 Token 守卫 100% 绿色通过**，零裸 hex，零硬编码数字圆角。
3. **TypeScript 严格类型检查**：
   - 命令：`npm --prefix apps/crish-mobile run typecheck`
   - 结果：`tsc --noEmit` **0 错误退出（Exit Code 0）**。
4. **Git 收口提交**：
   - 由主 Agent 使用 `git commit --only <paths>` 收口，禁止 `--no-verify`。
