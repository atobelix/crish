# Crish Desktop — 综合性重构计划

## 设计原则

- **无优先级**：所有 issue 同等重要，仅按逻辑依赖排序。
- **无时间/人员分配**：只定义「做什么」和「前置条件」。
- **重构而非修补**：每个 issue 必须修正根因，不做最小改动。
- **多轮并行**：每轮 4–5 个 Agent，Agent 间无交叉依赖即可并行。

---

## 前置依赖图 (逻辑依赖概览)

```
Round 1: Foundation
  ┌─ EventBus → 所有服务依赖事件通信
  ├─ Store Middleware Infra → 所有 Store 增强
  ├─ ConfigService → 配置统一管理
  ├─ CSS Token Consolidation → 所有 UI 层依赖
  └─ CI/Test Infra → 所有后续验证依赖

Round 2: State & Data Integrity
  ├─ BootstrapSync Refactor ───┐
  ├─ LayoutStore Hydration     ├── 三者共享 layoutStore 改造
  ├─ ErrorStore + ToastBus ────┤
  ├─ Persist Middleware         ┘
  └─ UndoRedo Service

Round 3: Services & Integration
  ├─ ShortcutService Lifecycle ─────────────┐
  ├─ ErrorStore↔ToastBus Auto-Integration  ├── 依赖 EventBus
  ├─ FocusTrap + AppErrorBoundary           │
  ├─ Service Registry Health                ┘
  └─ CrossTab/SessionSync

Round 4: Rendering Pipeline (独立于 Services)
  ├─ IncrementalMarkdownParser Full Rework
  ├─ StreamingCodeHighlighter + XSS Fix
  ├─ Pretext/TextMeasure Isolation Fix
  ├─ VirtualScroll + StreamRenderBuffer Opt
  └─ Diff Split View Layout Fix

Round 5: UI Components
  ├─ ToolCallBlock Rewrite
  ├─ Sidebar Drag-Reorder
  ├─ Layout Responsive System
  ├─ FocusTrap A11Y + General A11Y
  └─ Plugin/Skill Infra Foundation

Round 6: Agent Orchestration & MCP
  ├─ Background SubAgent + Batch Spawn
  ├─ Tool Registry + Timeout + Backoff
  ├─ Provider Circuit Breaker + New Providers
  ├─ MCP SDK Integration
  └─ Event Store Reliability

Round 7: Verification & Testing
  ├─ Daemon↔Client IPC Integration Tests
  ├─ UI Snapshot Tests
  ├─ Race Condition / Concurrency Tests
  ├─ Performance Regression Benchmarks
  └─ End-to-End Workflow Tests

Round 8: Continuous Optimization & Bug Prevention
  ├─ Static Analysis / Lint Hardening
  ├─ Runtime Monitoring & Observability
  ├─ Architecture Documentation Audit
  ├─ Permissions & Security Audit
  └─ Cross-Browser / Polyfill Audit
```

---

# Round 1: Foundation & Infrastructure

**目的**：构建所有上层模块依赖的基础设施——事件总线、Store 中间件层、配置中心、设计 Token 体系、质量门槛。

### Agent 1.1 — EventBus 增强 + ServiceRegistry

| 项目 | 内容 |
|------|------|
| **文件** | `apps/crish-desktop/src/services/EventBus.ts`，新建 `apps/crish-desktop/src/services/ServiceRegistry.ts` |
| **改动** | **EventBus**: ① 添加 `maxListeners` 警告（per-pattern 超阈值 console.warn）；② `emitAsync(type, payload)` —— 返回 `Promise.allSettled`，handler 支持 async；③ `removeAllListeners(pattern?)` —— 无参清所有，有参清匹配；④ `onAny(handler)` —— 通配订阅所有事件。**ServiceRegistry**: ⑤ 新建 class `ServiceRegistry`，管理 `register(name, service, deps[])` / `resolve<T>(name)` / `healthCheck()` / `startAll()` / `stopAll()`；⑥ 生周期钩子 `onInit` / `onDestroy`；⑦ 现有 service 单例逐步迁移注册。 |
| **验证** | `EventBus` 单元测试覆盖 emitAsync、removeAllListeners、onAny、maxListeners；`ServiceRegistry` 单元测试覆盖依赖解析、循环依赖检测、healthCheck。 |

### Agent 1.2 — Store 事务原子化 + 中间件基础设施

| 项目 | 内容 |
|------|------|
| **文件** | `apps/crish-desktop/src/store/storeTransaction.ts`，新建 `apps/crish-desktop/src/store/middleware/` 目录含 `persistMiddleware.ts` / `devtoolsMiddleware.ts` / `loggerMiddleware.ts` |
| **改动** | **storeTransaction.ts**: ① 用 `structuredClone` 替代 `JSON.parse(JSON.stringify)` 保留函数（`deepClone` 函数重写为 `globalThis.structuredClone ?? ((obj) => JSON.parse(JSON.stringify(obj)))` 兜底但 preserve functions via explicit whitelist）；② `rollback()` 改为单次 `useStore.setState(combined)` —— 将三 store 的 setState 合并为一个 `React.startTransition` 或 `unstable_batchedUpdates` 调用；③ 支持任意数量 store（非硬编码三）。**中间件**: ④ `persistMiddleware` —— zustand `persist` 风格，支持 `localStorage` / `sessionStorage` / `IndexedDB` adapter；⑤ `devtoolsMiddleware` —— 对接 Redux DevTools（`window.__REDUX_DEVTOOLS_EXTENSION__`）；⑥ `loggerMiddleware` —— 记录 action type、prev/next state、duration。 |
| **验证** | 单元测试：`structuredClone` 下 rollback 正确还原含函数 state；`batchRollback` flag 预期为 true 时阻止递归同步；中间件独立测试 subscribe/unsubscribe/state shape。 |

### Agent 1.3 — ConfigService 统一配置管理

| 项目 | 内容 |
|------|------|
| **文件** | 新建 `apps/crish-desktop/src/services/ConfigService.ts` |
| **改动** | ① 设计 `ConfigSchema` 类型系统（key → default value + validator + storage adapter）；② 实现 `ConfigService` 单例，`get<T>(key)` / `set<T>(key, value)` / `reset(key)` / `getAll()` / `watch(key, cb)`；③ 迁移现有分散的 `localStorage` 调用（`crish_shortcut_overrides`、`SHELL_CHROME_STORAGE_KEY`、`crish_error_boundary_crash`、`permissionModes` 等）统一注册到 ConfigService；④ 内置 `'localStorage'` 和 `'memory'` adapter；⑤ 支持 schema 验证（Zod 校验 `ConfigSchema`）。 |
| **验证** | 单元测试：get/set/reset、watch 触发、adapter 切换、Zod schema reject invalid values；集成：确认原 localStorage keys 被 ConfigService 接管后读写一致。 |

### Agent 1.4 — CSS Design Token 体系整合

| 项目 | 内容 |
|------|------|
| **文件** | `apps/crish-desktop/src/styles/tokens.css`，`design-system.css`，`z-index.css`，`reduced-motion.css`，`theme-dark.css` |
| **改动** | ① **z-index 统一**：删除 `tokens.css:225` 的 `--z-dropdown: 2000`，统一使用 `z-index.css:24` 的 `--z-dropdown: 1010`；检查并消除其余 z-index 重复定义；② **dark theme 色相统一**：`design-system.css:20-28` 的 dark theme 背景从 `hsl(218°, ...)` 改为匹配 `tokens.css:345-358` 的 `neutral` 色相（`hsl(35°, ...)`）；③ **动画关键帧合并**：删除 `tokens.css` 中 `crish-*` 前缀的关键帧，统一使用 `design-system.css` 的 `cds-*` 前缀；④ **reduced-motion**：补充 `--duration-xl` 和 `--duration-spring` 定义（`tokens.css` 中缺少，`reduced-motion.css:42-43` 引用）；⑤ **shadow 系统**：全部硬编码 `rgba` 改为 `color-mix(in srgb, var(--shadow-color), <alpha>)` 表达式；⑥ **overlay 合并**：`design-system.css:52-58` 的 `--overlay-background` / `--overlay-blur` 标记 deprecated，统一使用 `tokens.css:148-149` 的 `--bg-glass` / `--backdrop-blur`；⑦ 新增 `--font-size-chat: 13.5px` 填补现存 gap；⑧ 添加 `prefers-color-scheme` 监听脚本入口。 |
| **验证** | 构建后 `stylelint` 无 custom property 引用错误；Chrome DevTools 检查 dark/light 切换时色相一致；z-index stacking contexts 无回归；`prefers-color-scheme` 切换正确触发 theme 变化。 |

### Agent 1.5 — CI/Testing 基础设施

| 项目 | 内容 |
|------|------|
| **文件** | `.github/workflows/`（现有扩展），新建 `.husky/`，`.lintstagedrc.mjs`，`vitest.config.ts` 修改 |
| **改动** | ① **pre-commit hooks**：安装 `husky` + `lint-staged`，配置 `pre-commit` 运行 `lint-staged`（eslint + prettier + stylelint + `tsc --noEmit` affected files）；② **coverage gate**：`vitest.config.ts` 添加 `coverage.thresholds`（branches ≥ 70%，functions ≥ 75%，lines ≥ 80%，statements ≥ 80%）；③ **multiplatform CI**：`.github/workflows` 添加 `windows-latest` 和 `macos-latest` runner 矩阵（当前仅 Linux）；④ **visual regression infra**：引入 `playwright` 或 `storybook` + `chromatic`，为基础组件（FocusTrap、AppErrorBoundary、ToolCallBlock、DiffCard）添加 story/snapshot 测试。 |
| **验证** | CI pipeline runs on all 3 OS; `git commit` triggers lint-staged; `vitest run --coverage` 报告覆盖率；visual regression 基线生成/对比流程可用。 |

---

# Round 2: State & Data Integrity

**目的**：根治数据层的一致性问题——三源同步、hydration 时序、错误分类、持久化。

### Agent 2.1 — bootstrapStores 重构（消除三源漂移）

| 项目 | 内容 |
|------|------|
| **文件** | `apps/crish-desktop/src/store/bootstrapStores.ts`，`storeTransaction.ts`，`index.ts` |
| **改动** | ① **确定单一 source of truth**：layoutStore 作为「写主」(write master)，sessionStore/workspaceStore/settingsUiStore 降级为「派生视图」(derived views)——UI 组件只读派生 store；写入全部走 layoutStore；② **syncDepth 升级为 ReentrantLock**：用 `Set<symbol>` 追踪递归调用 token，替代 flat counter（防止并发路径下 syncDepth 偏移）；③ **init 顺序修正**：`initStoreAccess`（line 118）移到所有 `subscribe()` 注册之后——当前 fires before subscriptions；添加 `whenReady: Promise` 暴露给调用方；④ **batchRollback 合入事务 API**：rollback 期间所有 sync callback 被 `transactionLock` 跳过，不再依赖全局 flag。 |
| **验证** | 单元测试验证：layoutStore 写入 → 3 个派生 store 同步更新；派生 store 写入 trigger 不反向回流；rollback 期间无同步事件发出；`whenReady` resolve 在所有 subscription 注册后。 |

### Agent 2.2 — LayoutStore Hydration 生命周期修复

| 项目 | 内容 |
|------|------|
| **文件** | `apps/crish-desktop/src/store/layoutStore.ts`，`layoutHelpers.ts` |
| **改动** | ① 添加显式 `hydrationStatus: 'idle' | 'hydrating' | 'ready'` 到 layoutStore state；② async restore（`restoreSessionsFromDiskMirror`）完成前不执行 cleanup/unsubscription——当前 line 761-853 的 async 路径可能 fire after cleanup；③ 所有消费 `layoutStore` 的 effect/component 检查 `hydrationStatus === 'ready'` 再使用 store；④ `workspaceStore` 和 `sessionStore` 添加等价的 hydration 信号；⑤ 持久化 workspace layout state（`bootstrapStores.ts` 中添加 persist middleware）。 |
| **验证** | 集成测试：模拟 slow disk restore → 组件 mount 不崩溃、cleanup 不提前触发；hydrationStatus 转换顺序 `idle → hydrating → ready`；re-hydration 后 state 正确。 |

### Agent 2.3 — ErrorStore 结构化分类 + ToastBus 类型统一

| 项目 | 内容 |
|------|------|
| **文件** | `apps/crish-desktop/src/services/ErrorStore.ts`，`ToastBus.ts`，`hooks/useToastQueue.ts`，新建 `stores/errorTypes.ts` |
| **改动** | ① **ErrorStore**：添加 `FailoverReason` 枚举（`auth` / `rate_limit` / `context_overflow` / `provider_unavailable` / `network` / `timeout` / `parse_error` / `internal`），`error.code` 改用此枚举；② `push()` 新增可选参数 `failoverReason`，存储在错误条目中；③ **Toast/ToastItem 类型统一**：`ToastBus.Toast` 和 `useToastQueue.ToastItem` 合并为单一 `AppToast` 类型（位于 `errorTypes.ts`），两处统一引用；④ `ToastBus.toastQueue` 改名为 `toastBus.subscribe` 对齐，消除概念混淆；⑤ 删除 `ToastBus.show()` 内部的 `maxVisible` 挤出逻辑（移至 `useToastQueue`），`ToastBus` 专注 emit/subscribe。 |
| **验证** | 类型编译检查通过（`tsc --noEmit`）；ErrorStore push 支持新的 failoverReason；`ToastBus` 和 `useToastQueue` 共用相同 `AppToast` 类型。 |

### Agent 2.4 — Store Persistence Middleware 实现

| 项目 | 内容 |
|------|------|
| **文件** | 新建 `apps/crish-desktop/src/store/middleware/persistMiddleware.ts`（接 Agent 1.2），修改 `bootstrapStores.ts`，`layoutStore.ts`，`sessionStore.ts` |
| **改动** | ① 完成 `persistMiddleware` 实现：支持 `partialize`（选择性持久化）、`merge`（反序列化合并）、`version`（数据迁移）、`onRehydrate` callback；② **workspace layout 持久化**：`layoutStore` 应用 persist middleware，`storageAdapter` 为 IndexedDB（避免 localStorage 5MB 限制），key 白名单 `['workspaces', 'activeWorkspaceIndex', 'sidebarCollapsed', 'uiSize']`；③ **session 轻量持久化**：`sessionStore` 用 localStorage adapter 持久化 `sessions` 元信息（不含消息全文——消息全文已在 `sessionPersistence.ts` 管理）；④ 数据迁移钩子避免旧版 JSON 格式崩溃。 |
| **验证** | 重启后 workspace layout 恢复；localStorage session 元信息恢复；IndexedDB Storage adapter 读/写/清空测试通过；无版本数据迁移路径测试。 |

### Agent 2.5 — UndoRedoService 重构

| 项目 | 内容 |
|------|------|
| **文件** | `apps/crish-desktop/src/services/UndoRedoService.ts`，`storeTransaction.ts` |
| **改动** | ① 当前 `UndoRedoService` 重构为依赖 `StoreTransaction`：`undo()` = `rollback()` + 压入 redo stack；② 支持 multi-step undo（`steps` 参数）；③ 支持 `group`（将连续操作合并为一个 undo step）；④ 添加 `onStateChange` 回调（更新 UI 中的 undo/redo 按钮状态）；⑤ 集成 `EventBus`：每次 undo/redo 操作 emit `'history:undo'` / `'history:redo'` 事件。 |
| **验证** | 单元测试：多步 undo、grouped undo、stack 溢出裁剪、undo 后 commit 清空 redo stack。 |

---

# Round 3: Services & Event Integration

**目的**：Service 层全面生命周期管理、事件流闭环（Error→Toast）、快捷键/焦点/错误边界加固。

### Agent 3.1 — ShortcutService Lifecycle + Context Scoping

| 项目 | 内容 |
|------|------|
| **文件** | `apps/crish-desktop/src/services/ShortcutService.ts`，`ShortcutRegistry.ts`，新建 `shortcutConfig.ts` |
| **改动** | ① 实现 `init(containerEl: HTMLElement)` / `destroy()` 生命周期：`init` 挂载键盘事件监听（`keydown`）；`destroy` 移除监听器并清空 buffer——当前在 constructor 中注册无 dispose；② **context scoping**：添加 `scope` 参数到 `register()`，scope 枚举 `global` / `composer` / `chat` / `settings` / `diff`；`handleKeyDown` 仅匹配当前 active scope 的快捷键；③ **priority 系统**：`register()` 可选 `priority` 数字（默认 0），高优先级 binding 优先匹配；④ **外部配置文件**：`shortcutConfig.ts` 导出 ShortcutConfigSchema（Zod），支持从 `ConfigService` 读取 YAML/JSON 格式的自定义 shortcut 配置；⑤ **reserved shortcut 检测**：预置浏览器保留组合键列表（`Ctrl+N`、`Ctrl+T`、`Ctrl+W` 等），`register()` 时 warn 用户。 |
| **验证** | 单元测试：scope 过滤（composer shortcut 不在 settings scope 触发）；priority 排序；destroy 后无内存泄漏；register reserved shortcut → console.warn。 |

### Agent 3.2 — ErrorStore↔ToastBus 自动集成

| 项目 | 内容 |
|------|------|
| **文件** | `apps/crish-desktop/src/services/ErrorStore.ts`，`ToastBus.ts`，`EventBus.ts` |
| **改动** | ① `ErrorStore.push()` 自动 publish `EventBus` 事件 `'error:pushed'`（payload: `UiError`）；② `ToastBus` 新添 `subscribeToErrors(errorStore: ErrorStore)` 方法：监听 `error:pushed` 事件，对 severity `'error'|'critical'` 的未解决错误自动调用 `toastBus.error(message)`；③ severity `'warning'` 错误 → `toastBus.warning()`；④ 去重：同 `error.code` 的活跃错误在 10 秒内不重复弹出 toast；⑤ `errorStore.resolve()` 自动 emit `'error:resolved'`事件（可被 toast 用于动画移除）。 |
| **验证** | 集成测试：`errorStore.push({severity:'error', code:'rate_limit', ...})` → toastBus 自动收到 toast；resolve 后 toast 消失；同 code 10s 内重复 push 只产生 1 个 toast。 |

### Agent 3.3 — FocusTrap A11Y + AppErrorBoundary 电路熔断

| 项目 | 内容 |
|------|------|
| **文件** | `apps/crish-desktop/src/components/FocusTrap.tsx`，`AppErrorBoundary.tsx`，`AppErrorBoundary.module.css` |
| **改动** | **FocusTrap**: ① 激活时给 trap 外部的 sibling 元素设置 `aria-hidden="true"`（非递归禁用所有，仅为直接兄弟）；② 使用 `inert` 属性（polyfill 支持）彻底禁用 trap 外交互；③ 退出时恢复原始 `aria-hidden`/`inert` 状态。**AppErrorBoundary**: ④ 添加 `retryLimit` props（默认 3）——`retryCount` 追踪；超出后不再尝试重渲染，显示「已达到最大重试次数」UI、调用 `onMaxRetriesReached` callback；⑤ 使用 `errorStore.push` 记录每次 retry 事件（code: `BOUNDARY_RETRY_EXCEEDED`）；⑥ 熔断期（retryLimit 后 30 秒冷却）忽略任何 reset 尝试。 |
| **验证** | 手动测试：FocusTrap active → Tab 键限制在 trap 内 + 外部 aria-hidden；AppErrorBoundary retry 3 次后显示熔断 UI + log error。 |

### Agent 3.4 — Service Registry Health-Check + Orchestration

| 项目 | 内容 |
|------|------|
| **文件** | 新建 `apps/crish-desktop/src/services/ServiceRegistry.ts`（接 Agent 1.1），修改现有 service 文件 |
| **改动** | ① 完成 `ServiceRegistry` 的 `healthCheck(): Promise<Map<string, {status:'ok'|'degraded'|'down', latency: number}>>`；② 实现 `startAll()` / `stopAll()`（遍历所有注册 service 调用 init/destroy）；③ 迁移现有 service 类（`ShortcutService`、`ToastBus`、`EventBus`、`ErrorStore`、`ConnectionManager`、`CrossTabCoordinator`、`SessionSyncService`）注册到 registry；④ 添加 `ServiceStatusBoard` —— devtools 面板展示所有 service 状态（用于开发/调试）；⑤ 注册销毁顺序按依赖图逆序（DAG topological sort）。 |
| **验证** | 集成测试：registry.register 后 startAll → 所有 service init 调用；healthCheck 返回预期 status；stopAll 后所有 service destroyed。 |

### Agent 3.5 — CrossTab/SessionSync Service 硬化

| 项目 | 内容 |
|------|------|
| **文件** | `apps/crish-desktop/src/services/CrossTabCoordinator.ts`，`SessionSyncService.ts`，`ConnectionManager.ts` |
| **改动** | ① `CrossTabCoordinator` 添加 BroadcastChannel 消息去重/超时（当前可能重复处理）；② `SessionSyncService` 使用 ConfigService 读取同步间隔配置；③ `ConnectionManager` 重连策略使用 jittered exponential backoff（`baseDelay: 1000ms`, `maxDelay: 30000ms`, `jitter: 0.1`）；④ 所有三项服务注册到 ServiceRegistry；⑤ 状态变更 emit EventBus 事件（`'connection:status'`、`'sync:completed'`、`'sync:failed'`）。 |
| **验证** | 集成测试：两个 tab 同时操作 → BroadcastChannel 消息正确；ConnectionManager 断网重连 backoff 时间间隔正确。 |

---

# Round 4: Rendering Pipeline

**目的**：Markdown 解析正确性、代码高亮完整性、Pretext 缓存隔离、虚拟滚动性能、Diff 渲染正确性。

### Agent 4.1 — IncrementalMarkdownParser 完整重写

| 项目 | 内容 |
|------|------|
| **文件** | `apps/crish-desktop/src/api/IncrementalMarkdownParser.ts`，`markdownRender.ts`，`markdownRenderAsync.ts` |
| **改动** | ① **Safari lookbehind**（line 279）：`(?<!\*)` 替换为 `(?:^|(?<=[\s\n]))\*(?![\s*])` 避免 Safari <16.4 失败；② **Ordered list**（line 176-208）：检测以 `\d+\.\s` 开头的 list → `renderList` 输出 `<ol>` 而非 `<ul>`；③ **Code fence close**（line 162-174）：`closeReq` 必须 >= open 长度而非 exact match（当前 `=== fenceLen`）→ 改为 `closeIdx = text.indexOf('\n' + fence[0].repeat(Math.max(3, fenceLen)), ...)`；④ **新增 block 类型**：blockquote（`^>\s`）→ `<blockquote>`；thematic break（`^---\s*$` / `^___\s*$` / `^***\s*$`）→ `<hr>`；indented code block（4 spaces）→ `<pre><code>`；task list（`- [x]` / `- [ ]`）→ `<li><input checked/disabled>`；HTML block 保留原样传递；⑤ 新增 `ChunkType` 枚举值。 |
| **验证** | 测试用例覆盖：Safari lookbehind 替代方案、ordered list `<ol>`、close fence ≥ open、blockquote、thematic break、task list、indented code。快照对比新旧输出。 |

### Agent 4.2 — 代码高亮激活 + XSS Fix + Diff 高亮

| 项目 | 内容 |
|------|------|
| **文件** | `apps/crish-desktop/src/api/streamingCodeHighlighter.ts`，`codeHighlight.ts`，`DiffCardUnifiedView.tsx`，`DiffCardSplitView.tsx` |
| **改动** | ① **streamingCodeHighlighter.ts**：删除所有 `escapeHtml` 调用，改为实际调用 `highlightCode(line, lang)`；当前 line 38-43 是 dead code（"Use basic escape-based highlighting for now"）——激活正确的 hljs 调用；② **codeHighlight.ts:150-156**：`escapeHtml` 添加 `'` 转义（`/'/g → '&#x27;'`）；③ **Diff 语法高亮**：`DiffCardUnifiedView`/`DiffCardSplitView` 中 diff 行调用 `highlightCode(line, 'diff')`（hljs 已注册 `diff` 语言）；diff 内容保持 `+`/`-` 前缀在 hljs diff grammar 中正确着色；④ 缓存增强：`highlightCache` 支持 diff sections（prefix-aware caching）。 |
| **验证** | 单元测试：XSS 的 `'` 注入被安全转义；StreamingCodeHighlighter 输出含 hljs token `<span class="hljs-...">`；Diff 行 `+` 绿色 / `-` 红色且 keywords 高亮。 |

### Agent 4.3 — Pretext/TextMeasure 缓存隔离

| 项目 | 内容 |
|------|------|
| **文件** | `apps/crish-desktop/src/hooks/useTextMeasure.ts`，`utils/pretextFontBridge.ts` |
| **改动** | **useTextMeasure.ts:36-39**: ① `useEffect` cleanup 中删除 `clearCache()`（当前在任一组件 unmount 时销毁全局 Pretext cache → 破坏其他组件）；② 改为仅在 `font`/`text`/`whiteSpace` 变更时 `prepare()` 新文本（`useMemo` 已做），cache 清理责任交给 Pretext 内部 LRU。**pretextFontBridge.ts:59-66**: ③ DOM probe 改为使用 `CanvasRenderingContext2D.measureText()` 替代 DOM 节点注入——避免同步 style recalculation；④ `fontSizeCache` 改为 WeakMap 键控的 instance-level 缓存，非全局 Map；⑤ `buildPretextFontForUiSize` 的 DOM probe 镜像修改（line 111-114）。 |
| **验证** | 单元测试：组件 A unmount → 组件 B 继续文本测量正常（以前会 0 height）；Font bridge DOM probe 被 Canvas API 替代后无 style recalc；测量结果前后一致（<0.5px 差异）。 |

### Agent 4.4 — VirtualScrollManager + StreamRenderBuffer 优化

| 项目 | 内容 |
|------|------|
| **文件** | `apps/crish-desktop/src/api/VirtualScrollManager.ts`，`StreamRenderBuffer.ts` |
| **改动** | **VirtualScrollManager.ts:209-220**: ① `setActual` 改为 LAZY 偏移重建——`dirty` 标记 true，`computeVisibleRange()` 中调用时才重建 offsets；② 增量更新：`setActual` 只 invalidate 从该 index 往后的缓存行，避免全量 O(n) 重建；③ 阈值优化：若 `setActual` 的 newHeight 与 old 差异 < 1px 跳过重建；④ 使用 `Float64Array` 替代 `number[]` 存储 offsets。**StreamRenderBuffer.ts:182-188**: ⑤ flush 函数添加 `chunkSize = Math.min(pendingLength, maxBytesPerFrame)` 分块输出（当前 single chunk >8KB 全量 flush）；⑥ 分割逻辑确保在换行符边界分割（避免切割中间行导致 markdown 解析错误）；⑦ 帧预算检查：每 chunk flush 后检查耗时 > budget/2 则排到下一帧。 |
| **验证** | 性能基准测试：50000 items setActual 耗时 < 5ms（之前 50k loop）；StreamRenderBuffer 12ms 帧预算不超（大 chunk 分多次 rAF 输出）。 |

### Agent 4.5 — Diff Split View 布局修复

| 项目 | 内容 |
|------|------|
| **文件** | `apps/crish-desktop/src/components/DiffCardSplitView.tsx`，`DiffCard.module.css` |
| **改动** | ① `DiffCardSplitView` 中去掉 `white-space: pre-wrap`（line 39+ CSS）——改用 `white-space: pre` + `overflow-x: auto`（保持列对齐）；② 左右列 `<td>` 使用 `display: grid` + `grid-template-columns: 1fr 1fr` + `font-variant-numeric: tabular-nums` 确保数字列对齐；③ 添加 `word-break: break-all` fallback 对超出列宽的极长行自动折行（但仍保留 pre 对齐结构）；④ 行号列使用 `min-width: 3ch` 固定字符宽度。 |
| **验证** | 视觉检查：split view 左右列 `+`/`-` 行对齐；长行滚动不折行；窄视口下行号不截断。 |

---

# Round 5: UI Components

**目的**：工具调用行 UX 增强、侧栏拖拽重排、响应式布局、无障碍、插件技能基础设施。

### Agent 5.1 — ToolCallBlock 重写

| 项目 | 内容 |
|------|------|
| **文件** | `apps/crish-desktop/src/components/ChatToolCallBlock.tsx`，`ChatToolCallBlock.module.css`，`api/toolPresentation.ts` |
| **改动** | ① **status 图标**：`success` → Lucide `CheckCircle`，`error` → Lucide `XCircle`，`running` → 旋转 `Loader2`，`pending_approval` → Lucide `Clock`；② **per-tool duration**：显示在行尾（`formatDuration(ms)` 从 `toolRowTone` 数据中读取 `startedAt`/`completedAt`）；③ **retry 按钮**：`error` 状态工具行尾添加重试按钮（调用 `onRetry(toolId)` prop）；④ **batch approve/deny**：`pending_approval` 状态且 `isBatchable` 时显示「全部批准」「全部拒绝」按钮；⑤ **parallel group**：同一批次并行执行的 tools 视觉分组（卡片边界 + 左侧竖线连接 + batch label）；⑥ **diff stats**：collapsed 行上显示 `+N -M` 简短 diff 统计（当前隐藏）；⑦ **collapse 动画**：`grid-template-rows: 0fr → 1fr` 改为 `max-height` + `opacity` 动画 + FLIP（`getBoundingClientRect`）确保流畅过渡。 |
| **验证** | 视觉检查所有状态图标；retry 按钮触发正确的 callback；batch approve 一次发出所有 pending；parallel group 视觉分组正确；collapse 动画流畅。 |

### Agent 5.2 — Sidebar Drag-Reorder

| 项目 | 内容 |
|------|------|
| **文件** | `apps/crish-desktop/src/components/sidebar/SidebarSessionList.tsx`，`Sidebar.tsx`，新建 `hooks/useDragReorder.ts`，`SidebarDragLayer.tsx` |
| **改动** | ① **ghost**：拖拽时原始位置半透明占位（`opacity: 0.3`）；② **drop zones**：每个 session/folder item 之间插入视觉 drop indicator（4px 横线 + accent 色）；③ **FLIP 动画**：`useDragReorder` hook 实现 FLIP（First/Last/Invert/Play）动画——drop 时记录所有元素 `getBoundingClientRect`，target 位置移动后 invert transform，再 transition 到 `transform: none`；④ 对接 `layoutStore.moveSession()` / `layoutStore.moveFolder()` actions（当前已存在 store action 但 UI 欠缺）。 |
| **验证** | 手动测试：拖拽 session 到不同 folder 或重排 → ghost 跟随；drop → 过渡动画播放；store state 正确更新；undo 操作回退成功。 |

### Agent 5.3 — Layout Responsive System

| 项目 | 内容 |
|------|------|
| **文件** | `apps/crish-desktop/src/styles/breakpoints.css`，`layoutStore.ts`，`Workspace.tsx`，`components/workspace/` |
| **改动** | ① **响应式断点**：`breakpoints.css` 扩展为三档 `--bp-sm: 640px` / `--bp-md: 960px` / `--bp-lg: 1280px`；② **layoutStore** 添加 `viewport: 'sm' | 'md' | 'lg'` 状态 + `ResizeObserver` auto-update；③ **Workspace.tsx** 根据 `viewport` 决定布局：`sm` → 单列堆叠（header + chat + tools + diff），`md` → 双列（chat | tools+diff），`lg` → 三列（sidebar | chat | tools+diff）；④ **panel layout**：低于 `md` 时工具栏自动折叠为 tabs；⑤ 断点变化时 persist 到 ConfigService。 |
| **验证** | 手动 resize 窗口：各断点正确切换布局；600px → 全屏 → 600px 往返无状态丢失；persisted viewport 值在重启后恢复。 |

### Agent 5.4 — 无障碍全局修复

| 项目 | 内容 |
|------|------|
| **文件** | `components/FocusTrap.tsx`（复用 Agent 3.3），`components/ChatMessageRow.tsx`，`components/Sidebar.tsx`，`components/ToastStack.tsx`，`components/panels/` |
| **改动** | ① **所有交互元素**添加 `aria-label` / `aria-describedby`（从 errorStore 读取错误描述）；② **ToastStack** 使用 `role="region"` + `aria-live="polite"` + `aria-relevant="additions removals"`；③ **FocusTrap**（复用 Agent 3.3 改动）外部的 sibling 全部 `aria-hidden`；④ **ChatMessageRow** 的 role 设为 `article` + `aria-labelledby` 引用 message id；⑤ **Sidebar** 的 folder expand/collapse 按钮 `aria-expanded`；⑥ **全应用** 添加 skip-to-content link（`#main-content` 定位）。 |
| **验证** | Lighthouse 无障碍评分 ≥ 90；axe-core 扫描零严重问题；屏幕阅读器 Tab 导航顺序合理。 |

### Agent 5.5 — Plugin/Skill 基础设施

| 项目 | 内容 |
|------|------|
| **文件** | 新建 `plugins/`、`apps/crish-desktop/src/plugin/PluginHost.ts`，`packages/agent-runtime/src/plugin-registry.ts`（修改） |
| **改动** | ① **filesystem plugin discovery**：`PluginHost.scanDirectory(path)` 读取 `*.yaml`/`*.json` manifest 文件——插件元信息（name、version、hooks、entry）；② **session-level lifecycle hooks**：`onSessionStart(sessionId)` / `onSessionEnd(sessionId)` —— EventBus 事件触发时调用；③ **Skill Curator**：`SkillCurator` 自动归档 30 天未使用的 skill，usage tracking（调用计数 + 最后使用时间）；④ 插件 manifest schema（Zod）验证；⑤ 插件支持 `hot-reload` 但通过 `deferred` 策略（当前 session 完成后 reload，避免 prompt cache 失效）。 |
| **验证** | 集成测试：`PluginHost.scanDirectory` 正确加载 manifest 文件；`onSessionStart` 被 EventBus 事件触发；Skill Curator 归档确实未使用的 skill。 |

---

# Round 6: Agent Orchestration & MCP

**目的**：Agent 运行时弹性、多 provider 支持、MCP 协议合规、事件存储可靠性。

### Agent 6.1 — Background Sub-Agent + Batch Parallel Spawn

| 项目 | 内容 |
|------|------|
| **文件** | `packages/agent-runtime/src/subagents.ts`，`subagent-skill-runner.ts`，`agent-orchestrator/src/orchestrator.ts` |
| **改动** | ① **background/fire-and-forget**：`spawnSubAgent(config)` 新增 `mode: 'foreground' | 'background'`。background 模式：不阻塞主 agent 循环、结果投递到 `EventBus`（`'subagent:completed'` / `'subagent:failed'`），不参与上下文窗口；② **batch parallel spawn**：`spawnBatchSubAgents(tasks[], options?)` —— 并发启动 N 个子 agent，所有完成后 emit `'subagent:batch-completed'` ；③ `Orchestrator` 集成：batch 子 agent 结果合并到主上下文中（`SubAgentContextPacker` 增强）。 |
| **验证** | 集成测试：background sub-agent 执行过程中主 agent 继续；batch spawn 5 个子 agent 并发执行，全部完成后收到 batch-completed 事件。 |

### Agent 6.2 — Central Tool Registry + Timeout + Backoff

| 项目 | 内容 |
|------|------|
| **文件** | `packages/agent-runtime/src/local-tools.ts`，新建 `packages/agent-runtime/src/tool-registry.ts`，`packages/agent-runtime/src/retry-backoff.ts` |
| **改动** | ① **Central ToolRegistry**：替代 `defineTool()` 分散注册，提供 `register(tool: ToolDefinition)` / `discover(): ToolDefinition[]` / `get(name)` / `list()`；支持 `category` 分组；② **tool-level timeout**：`ToolDefinition.timeoutMs` 字段（默认 30000ms），超时自动 abort 并返回 `ToolResult.error('timeout')`——非 `subagent-runtime.ts`（issue 54 指出的缺失）attach；③ **jittered exponential backoff**：`retryWithBackoff<T>(fn, options)`（`base: 1000`, `max: 60000`, `jitter: 0.1`, `maxRetries: 5`）替换当前硬编码 `setTimeout(retry, 1000)`（`openai-retry.ts`）；④ 集成到 ProviderGateway。 |
| **验证** | 单元测试：ToolRegistry list/discover 枚举正确；timeout 超时触发 abort；`retryWithBackoff` jittered 间隔分布统计 0.9x~1.1x base。 |

### Agent 6.3 — Provider Circuit Breaker + New Providers

| 项目 | 内容 |
|------|------|
| **文件** | `apps/crish-desktop/src/api/providerBreaker.ts`，`packages/agent-runtime/src/provider-openai-compatible.ts`，新建 `provider-anthropic.ts`，`provider-gemini.ts` |
| **改动** | ① **ProviderBreaker 增强**：`recordFailure(failoverReason)` 根据 FailoverReason 不同设置不同的熔断阈值（`auth` → 即时熔断，`rate_limit` → 半开状态，`network` → 3 次连续熔断）；半开状态每个探测请求 10 秒间隔；② **Anthropic provider**：实现 `Provider` 接口（`complete()` / `stream()` / `countTokens()`），使用 Anthropic SDK，支持 `x-api-key` auth +  `anthropic-version` header；③ **Gemini provider**：实现 `Provider` 接口，使用 Google AI SDK，支持 API key auth + safety settings；④ provider 选择路由：`ModelRouter` 根据 `modelProvider` 字段 dispatch 到对应 provider 实现。 |
| **验证** | 集成测试（mock server）：ProviderBreaker 3 次 failure → 熔断 → 半开 → 恢复；Anthropic provider mock 返回预期 completion；Gemini provider mock。 |

### Agent 6.4 — MCP SDK Integration

| 项目 | 内容 |
|------|------|
| **文件** | `apps/crish-desktop/src/api/mcpApi.ts`，`packages/agent-runtime/src/mcp-lifecycle.ts`，新建 `mcp-sdk-bridge.ts` |
| **改动** | ① **MCP SDK 集成**：实现 `initialize` 握手（`protocolVersion`, `capabilities`, `clientInfo`），当前直接通信无握手；② **notifications**：添加 `notifications/tools/list_changed` handler——当前手动 `refreshTools`，改为监听 notification 自动刷新缓存；③ **resources** / **prompts**：实现 MCP 资源读取（`resources/list`、`resources/read`）和 prompt 模板（`prompts/list`、`prompts/get`）；④ **listTools 分页**：支持 `cursor` 参数，自动拉取后续页（当前 page size 无限制）；⑤ 所有 MCP 操作通过 `CancellationToken` 支持超时（默认 30 秒）。 |
| **验证** | 集成测试（mcp-server mock）：initialize 握手协议 version 正确；`tools/list_changed` notification 触发本地缓存刷新；分页 `listTools` 返回完整列表。 |

### Agent 6.5 — Event Store Reliability

| 项目 | 内容 |
|------|------|
| **文件** | `packages/agent-orchestrator/src/event-store.ts`，`runtime-engine.ts`，新建 `wal-lock.ts` |
| **改动** | ① **Event store write retry**：`append()` 操作若因 `LockError` 或 `WriteConflict` 失败，进行最多 3 次重试（50ms/100ms/200ms 间隔）；② **cross-process file locking**：`wal-lock.ts` 实现基于 `fs.open`（`'wx'` flag）的文件锁 + `setTimeout` polling（100ms interval，5000ms timeout）；写事件前获取锁，写完后释放；③ WAL（Write-Ahead Log）同步模式：写入先写 WAL，再 apply 到 store；crash recovery 时回放 WAL；④ 添加 `--event-store-consistency` CLI flag（`eventual` / `strong` 控制同步策略）。 |
| **验证** | 压力测试：并发写事件 100 次无丢失（文件锁竞争正确）；模拟 crash 后 WAL 回放恢复 state。 |

---

# Round 7: Verification & Testing

**目的**：全面集成测试、快照测试、并发测试、性能基准、端到端工作流。

### Agent 7.1 — Daemon↔Client IPC 集成测试

| 项目 | 内容 |
|------|------|
| **文件** | 新建 `tests/integration/ipc/daemon-client-ipc.test.ts`，`packages/agent-daemon/src/index.ts`（添加 test hooks） |
| **改动** | ① 启动 daemon 子进程（`child_process.fork` 或 `spawn`），通过 WebSocket 连接；② 测试用例覆盖：session CRUD、chat send/receive、tool call approval flow、config sync、disconnect/reconnect；③ mock provider 返回固定响应确保确定性；④ 每个测试用例前后 reset daemon state。 |
| **验证** | 所有 IPC 测试通过；disconnect → auto-reconnect 序列正确；大消息体（>1MB）传输无误。 |

### Agent 7.2 — UI Snapshot Tests

| 项目 | 内容 |
|------|------|
| **文件** | 新建 `tests/snapshots/`，对应组件的 `.test.tsx` 文件 |
| **改动** | ① 使用 `vitest` + `@testing-library/react` + `vitest-dom` 为核心组件创建 snapshot 测试：`FocusTrap`（active/inactive）、`AppErrorBoundary`（fullscreen/compact/minimal 各变体）、`ChatToolCallBlock`（all statuses）、`DiffCardUnifiedView`、`DiffCardSplitView`、`ToastStack`（0/1/5 items）、`Sidebar`（folders expanded/collapsed）；② 每个 snapshot 文件附带 `__snapshots__` 目录；③ snapshot 更新命令 `npm run test:update-snapshots`。 |
| **验证** | `vitest run` 产生新 baseline snapshots；故意改 UI → snapshot diff 正确 catch。 |

### Agent 7.3 — Race Condition Tests

| 项目 | 内容 |
|------|------|
| **文件** | 新建 `tests/race-conditions/`，`tests/stress/race-store-transaction.ts`，`race-eventbus.ts` |
| **改动** | ① **Store transaction 竞争**：并发调用 `StoreTransaction.begin()` + async 操作 + `rollback()` / `commit()`，检查最终 state 一致性；② **EventBus 并发**：多个 subscriber 同时 on/off + emit，检查无遗漏/重复；③ **ShortcutService 并发**：同时 `register` / `unregister` 不同 actionId，检查 actions Map 最终完整性；④ **Bootstrap sync 竞争**：多个 store 同时 setState，检查 syncDepth 不偏移 + 派生 store 一致。 |
| **验证** | 用 `--pool=forks` 模式运行防止并行变串行；测试代码重复 100 次以确保竞争暴露。 |

### Agent 7.4 — Performance Regression Benchmarks

| 项目 | 内容 |
|------|------|
| **文件** | 新建 `tests/benchmarks/regression/`，`scripts/benchmark-compare.ts`（增强现有 `scripts/compare-benchmarks.ts`） |
| **改动** | ① **VirtualScrollManager 基准**：50000 items setActual 耗时 < 5ms；computeVisibleRange 耗时 < 1ms；② **IncrementalMarkdownParser 基准**：10KB markdown 文本解析 < 10ms；增量更新 < 2ms；③ **StreamRenderBuffer 基准**：100KB 文本分帧 flush 不超过 8 rAF（12ms budget）；④ **Store 事务基准**：1000 次 startTransaction/commit 耗时 < 200ms；⑤ 所有基准集成到 `npm run bench:ci` + github action 对比（FAIL if > 10% regression）。 |
| **验证** | CI 中基准通过；benchmark-compare 脚本正确识别回归。 |

### Agent 7.5 — End-to-End Workflow Tests

| 项目 | 内容 |
|------|------|
| **文件** | 新建 `tests/e2e/`（使用 playwright） |
| **改动** | ① 应用启动 → 侧栏创建 session → 发送 chat message → 接收流式响应 → tools 执行 → diff review → session 持久化 → 重启验证状态恢复；② MCP 工具发现 → 工具调用 → 结果展示；③ 多 session 切换 → workspace 布局持久化检查；④ 错误场景：provider failure → ErrorStore → ToastBus 联动 → AppErrorBoundary 展示；⑤ dark/light theme 切换检查。 |
| **验证** | 完整 e2e 流程通过（headless 模式）；失败时截图保存到 `test-results/`。 |

---

# Round 8: Continuous Optimization & Bug Prevention

**目的**：静态分析硬化、运行时可观测性、架构文档闭环、安全审查、兼容性加固。

### Agent 8.1 — Static Analysis Hardening

| 项目 | 内容 |
|------|------|
| **文件** | `eslint.config.js`，`tsconfig.base.json`，`scripts/check-no-as-any-store.mjs` |
| **改动** | ① eslint 规则新增：`@typescript-eslint/no-explicit-any`（error · store check 脚本迁移至此）、`@typescript-eslint/no-floating-promises`（error）、`@typescript-eslint/require-await`（warn）、`no-console`（warn · 仅 `console.error` 允许）；② tsconfig 新增 `strict: true` + `noUncheckedIndexedAccess` + `exactOptionalPropertyTypes`（逐步修复现有违例）；③ 自定义规则：`store-type-check` —— 禁止在 store/actions 中使用 `as any` 绕过类型（现有 `check-no-as-any-store.mjs` 迁移到 eslint plugin）；④ `tsc --noEmit` 限制为 `--pretty --noErrorTruncation` 方便排查。 |
| **验证** | `npm run lint` 无 error；`npm run check:desktop` 通过；`store-type-check` 规则 detect `as any` 在 store 文件。 |

### Agent 8.2 — Runtime Monitoring & Observability

| 项目 | 内容 |
|------|------|
| **文件** | 新建 `apps/crish-desktop/src/monitoring/`（`PerformanceObserver.ts`，`ErrorTracker.ts`，`CacheMonitor.ts`） |
| **改动** | ① **PerformanceObserver**：`PerformanceObserver` 注册 `largest-contentful-paint`、`layout-shift`、`longtask`、`first-input` 指标，超阈值写入 `ErrorStore`（code: `PERF_LONG_TASK` / `PERF_CLS` 等）；② **ErrorTracker**：`window.onerror` + `window.onunhandledrejection` 统一捕获并 `errorStore.push`；③ **CacheMonitor**：`highlightCache`、`LINE_CACHE` 的 hit rate / eviction count 定时采样（每 5 分钟），hit rate < 80% → warn；④ 所有监控指标可通过 devtools overlay 可视化。 |
| **验证** | PerformanceObserver 捕获 long task > 50ms → ErrorStore 记录；CacheMonitor hit rate 日志在控制台输出。 |

### Agent 8.3 — Architecture Documentation Audit

| 项目 | 内容 |
|------|------|
| **文件** | `ARCHITECTURE.md`，`ARCHITECTURE-IMPROVEMENT.md`，`docs/` 全部 `.md` 文件 |
| **改动** | ① **统一架构文档**：合并 `ARCHITECTURE.md` + `ARCHITECTURE-IMPROVEMENT.md` + `EVENT-SYSTEM-ARCHITECTURE.md` 为单一 `docs/architecture/` 规范目录；② **三层架构图**：Store Layer（store*.ts + bootstrapStores.ts + middleware）→ Service Layer（EventBus + ToastBus + ErrorStore + ShortcutService + ServiceRegistry）→ UI Layer（components + hooks + styles）；③ 记录每个 service 的生命周期和依赖关系（`ServiceRegistry` 最终依赖图）；④ 文档生成：TS docstring → TypeDoc → markdown 自动化（`npm run docs:generate`）。 |
| **验证** | `npm run docs:generate` 生成完整文档；架构图与实际代码匹配（交叉验证 store/service/component 引用）。 |

### Agent 8.4 — Permissions & Security Audit

| 项目 | 内容 |
|------|------|
| **文件** | `apps/crish-desktop/src/api/commandPermissions.ts`，`approvalFlowMachine.ts`，`permissionModes.ts`，`agentProfiles.ts` |
| **改动** | ① **CommandPermissions 审计**：检查所有注册的 tool/command 是否都有对应的 permission entry；缺失 → 添加；② **ApprovalFlowMachine 状态机**：添加 3 种新增状态 `'expired'`（审批超时）、`'escalated'`（升级审批）、`'bypassed'`（信任列表自动放行）；③ **profile isolation**：不同 profile 间的 permission/mode 配置隔离（当前全局共享）；④ **ApprovalAskCard** 添加 timeout 显示（pending 超过 30 秒显示「审批即将过期」警告）。 |
| **验证** | 集成测试：approval flow expired → 自动拒绝；escalation → 通知第二审批人；bypass 列表内的 tool 自动放行。 |

### Agent 8.5 — Cross-Browser / Polyfill Audit

| 项目 | 内容 |
|------|------|
| **文件** | `apps/crish-desktop/src/bootstrap-core.ts`（或新建 `polyfills.ts`） |
| **改动** | ① **Safari lookbehind**（已修复于 Agent 4.1，确认全部 regex 不含 `(?<!)` `(?<=)`）；② **structuredClone** fallback（已修复于 Agent 1.2，确认 `globalThis.structuredClone` fallback 含 custom replacer）；③ **ResizeObserver** polyfill（在 `bootstrap-core.ts` 条件加载 `resize-observer-polyfill`）；④ **BroadcastChannel** polyfill（`localStorage` event-based fallback）；⑤ **crypto.randomUUID** fallback（已确认  `ErrorStore.generateErrorId()` 有 fallback，检查其余调用点）。 |
| **验证** | 手动测试：Chrome / Firefox / Safari 三浏览器启动无控制台 error；Safari <16.4 无 RegExp 报错；polyfill 按需加载（`if (!('ResizeObserver' in window)) { ... }`）。 |

---

## 总结：跨轮依赖矩阵

| 依赖项 | 满足于 | 被依赖 |
|--------|--------|--------|
| EventBus 增强 | R1-A1 | R3-A2（Error→Toast）、R3-A4（Registry health）、R3-A5（CrossTab sync）|
| 中间件基础设施 | R1-A2 | R2-A4（Persist middleware 实现）|
| ConfigService | R1-A3 | R3-A1（Shortcut config）、R5-A3（Responsive persist）|
| CSS Token 体系 | R1-A4 | R5-A3（Responsive breakpoints）、R4-A5（Diff layout）|
| 测试基础设施 | R1-A5 | R7 全部 |
| bootstrapSync 修复 | R2-A1 | R2-A2（Hydration）、R2-A4（Persist order）|
| ErrorStore 重构 | R2-A3 | R3-A2（Auto-toast）、R8-A2（Monitoring）|
| Persist middleware | R2-A4 | R5-A3、R2-A2（Workspace persist）|
| IncrementalMarkdownParser | R4-A1 | R4-A2（Diff highlight content）|
| ToolCallBlock 重写 | R5-A1 | 无下游 |
| ServiceRegistry | R3-A4 | R6-A5（Event store 注册）|

---

*本计划共 8 轮、38 个 Agent 任务，按逻辑依赖严格排序。每轮内部 Agent 可完全并行执行。最后两轮专用于验证、持续优化和缺陷预防，确保重构质量闭环。*
