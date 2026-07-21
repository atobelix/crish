# Crish Desktop — 终极重构路线图

> 综合 6 个独立方案 Agent 的最佳设计，覆盖 78 项审计发现 + 12 项参考对照差距。
> 7 轮 × 4-5 并行 Agent，严格按逻辑依赖排序。
> 最后 2 轮专注验证、持续优化和缺陷预防。

---

## 逻辑依赖总图

```
R1 (基础设施)
  ServiceRegistry · EventBus v2 · ConfigService · Store原子性 · CSS统一 · CI门槛
        │
R2 (状态/数据层)
  布局Store Hydration · 三源合一 · 响应式布局 · 中间件标准化 · 工作区持久化
        │
R3 (服务/渲染管线)
  ShortcutService生命周期 · FocusTrap a11y · ErrorBoundary断路器
  MarkdownParser v2 · 代码高亮集成 · Pretext/VirtualScroll/StreamBuffer优化 · Diff着色
        │
R4 (Agent/MCP/Provider)
  ToolRegistry · Provider抽象(Anthropic/Gemini) · MCP SDK集成 · 断路器·退避重试
  Agent生命周期 · 事件存储韧性 · 插件系统基础
        │
R5 (UI组件)
  ToolCall UI重构 · 侧栏拖拽排序 · 设计系统统一 · Plugin/Skill/Profile系统
        │
R6 (验证/测试)
  集成测试 · 快照测试 · CI矩阵 · 覆盖率门禁 · 竞态条件测试 · 视觉回归测试
        │
R7 (持续优化/缺陷预防)
  性能监控 · 安全审计 · 错误恢复审计 · 文档 · 开发体验
```

---

## Round 1 — 基础设施

### Agent 1.1: ServiceRegistry + ConfigService

**文件**: (新建) `src/services/ServiceRegistry.ts`, `src/services/ConfigService.ts`; (修改) `bootstrap-*.ts`, `main.tsx`, `App.tsx`

**ServiceRegistry**:
- `register(id, service, deps?)` — 注册服务，声明依赖
- `resolve<T>(id): T` — 按 ID 解析，未注册则抛 InvariantViolation
- `startAll()` / `stopAll()` — 拓扑排序初始化/销毁
- `healthCheck(): Map<string, HealthStatus>` — 遍历所有服务调用 `health()`
- 每个服务实现 `CrishService`: `{ id, init(), destroy(), health() }`

**ConfigService**:
- 唯一配置源，替代所有散落的 `localStorage.getItem()`
- `get<T>(key, default)`, `set(key, value)`, `watch(key, cb)`, `reset(key)`
- Zod schema 校验每个键；版本化迁移
- 存储后端：`localStorage` / `memory` / `remote(daemon)`
- 迁移 `ShortcutService.STORAGE_KEY`, `layoutStore` 持久化键, `permissionMode`, 等 → ConfigService

**Bootstrap**:
- 替换 bootstrap-services.ts 的手动 cleanup 模式 → ServiceRegistry.startAll()
- 统一进入 `bootstrap-orchestrator.ts`: ConfigService → ServiceRegistry → Store → Services → UI

### Agent 1.2: EventBus v2 + ErrorStore 结构化分类 + ToastBus 统一

**文件**: `EventBus.ts`, `ErrorStore.ts`, `ToastBus.ts`, `useToastQueue.ts`; (新建) `FailoverReason.ts`

**EventBus v2**:
- `maxListeners`: 每 pattern 超阈值时 console.warn (默认 10)
- `emitAsync(type, payload)`: 返回 `Promise.allSettled()`，用于保证 handler 顺序的场景
- `removeAllListeners(pattern?)`: 清空指定 pattern 或全部 handler
- `onAny(handler)`: 订阅所有事件
- handler 执行用 try/catch + EventBusError 通道上报

**ErrorStore 结构化**:
- `FailoverReason`: `'auth' | 'rate_limit' | 'context_overflow' | 'provider_unavailable' | 'timeout' | 'internal' | 'network' | 'quota'`
- 每个 `UiError` 添加 `reason: FailoverReason`, `retryable: boolean`, `recoverySuggestion: string`
- `push()` 自动通过 ToastBus 创建对应 toast (severity >= warning)
- `classifyError(code, message): FailoverReason` 方法

**ToastBus 统一**:
- 合并 `Toast`(ToastBus) 和 `ToastItem`(useToastQueue) → 单一 `AppToast` 类型
- useToastQueue 作为 React 适配器，订阅 ToastBus
- 新增 `dismissGroup(group)` 方法

**验证**: `EventBus.emitAsync` 所有 handler 按序完成；`ErrorStore.push()` 自动产生 toast

### Agent 1.3: Store 事务原子性 + 同步修复

**文件**: `storeTransaction.ts`, `bootstrapStores.ts`, `autoIndexMiddleware.ts`

**事务原子性**:
- 替换 `JSON.parse(JSON.stringify())` → `structuredClone()` (保留 Set/Map/Date/RegExp)
- 三个顺序 `setState` 改为 `ReactDOM.unstable_batchedUpdates` 包裹的单个批次调用
- 添加 `batchDepth` 计数器，支持嵌套事务

**同步修复**:
- 替换 `syncDepth++` 扁平计数器 → `Set<string>` 同步路径 token (如 `'layout→session'`)，每个同步方向独立跟踪
- 修复 `initStoreAccess` 调用时序：移到所有 subscriptions 注册之后
- 添加 `permissionMode` 到 `syncSessionToLayout()` — 当前缺失导致三源漂移

**中间件**:
- 添加 `withLogger`(dev 环境 state diff 日志), `withDevtools`(Redux DevTools), `withPersist`(selective)
- `autoIndexMiddleware.ts` 改为真正的 zustand 中间件形式

**验证**: 嵌套事务一致性；并发同步不丢失更新；`bootstrapStores` 无竞态

### Agent 1.4: CSS Design System 统一

**文件**: `tokens.css`, `design-system.css`, `z-index.css`, `reduced-motion.css`, `theme-dark.css`

- **`--z-dropdown` 冲突**：tokens.css:225=2000 vs z-index.css:24=1010 → 统一为 1010 (与图层系统一致)
- **深色主题色相冲突**：design-system.css 用 218°(蓝黑), tokens.css 用 0°(中灰) → 选中灰，删除 design-system.css 深色块
- **动画关键帧冲突**：`cds-*` 前缀 vs `crish-*` 前缀 → 统一为 `cds-*`，添加兼容别名
- **`reduced-motion.css:42-43`**：引用未定义的 `--duration-xl`和`--duration-spring` → 改为存在的 token
- **`--shadow-color` 未使用**：`tokens.css:87` 定义了但 shadows 硬编码 rgba → 改为 `color-mix(in srgb, var(--shadow-color) X%, transparent)`
- **添加 `--font-size-chat: 13.5px`** 填补 13px 和 14px 之间的空隙
- **系统主题检测**：`prefers-color-scheme` listener → `data-theme` 自动切换
- **`--overlay-background` 去重**：删除 design-system.css 的，保持 tokens.css 的 `--bg-glass`/`--backdrop-blur`

**验证**: `--z-dropdown` 解析为 1010；深色主题使用中灰色系；阴影动态响应 `--shadow-color`；系统主题自动跟随

### Agent 1.5: CI/Pre-commit + 测试基础设施

**文件**: (新建) `.husky/pre-commit`, `.husky/pre-push`, `.lintstagedrc.json`; (修改) `.github/workflows/ci.yml`, `vitest.config.ts`, `package.json`

- **`lint-staged`**: `*.{ts,tsx}`→eslint --fix, `*.css`→stylelint --fix
- **`husky`**: pre-commit(eslint+typecheck), pre-push(全量 vitest + tsc)
- **CI 矩阵**: `os: [ubuntu-latest, windows-latest, macos-latest]`
- **覆盖率门槛**: `vitest.config.ts` `coverage.thresholds: { lines: 70, branches: 60, functions: 65 }`
- **集成测试骨架**: 创建 `tests/integration/` + mock daemon
- **视觉回归测试**: `playwright` 配置 + 基线截图

**验证**: `git commit` 触发 lint-staged；CI 三平台通过；覆盖率低于门槛时 CI 失败

---

## Round 2 — 状态/数据层

### Agent 2.1: LayoutStore Hydration + 持久化

**文件**: `layoutStore.ts`, `layoutStore.test.ts`

- `hydrationComplete: boolean` / `Promise<void>` — 异步恢复完成后设置为 true
- 组件通过 `useLayoutStore(s => s.hydrated)` 判断数据是否就绪
- 异步 restore 添加 `abortSignal` 检查，防止 cleanup 后 setState
- `zustand/middleware/persist` 包裹：保存 workspace 列宽、面板可见性到 localStorage
- `onRehydrateStorage` 回调设置 `hydrated = true`

**验证**: 启动时 layoutStore.hydrated 从 false→true；快速 unmount 不报错

### Agent 2.2: 消除三源漂移

**文件**: `bootstrapStores.ts`, `layoutStore.ts`, `sessionStore.ts`, `workspaceStore.ts`, `settingsUiStore.ts`

- `permissionMode` 所有权归 `layoutStore`，从 `sessionStore` 删除
- 审计所有跨 store 同步调用，消除冗余写入
- 运行时 invariants: 开发模式下检测同一 key 是否存在两个 store 中
- 添加 `storeConsistencyCheck()` 可在 devtools 手动调用

**验证**: 修改 permissionMode → 所有 store 读到的值一致

### Agent 2.3: 响应式布局系统

**文件**: (新建) `useResponsiveLayout.ts`, `responsive.css`; (修改) `Workspace.tsx`, `Sidebar.tsx`

- `--breakpoint-sm/md/lg` token + CSS container queries
- `useResponsiveLayout` hook: `{ viewport, sidebarBehavior, chatColumnMax }`
- 窄屏(< 640px) → sidebar overlay 模式，单列布局
- 中屏(640-1024px) → sidebar 图标折叠
- 宽屏(> 1024px) → 正常三列布局
- 侧栏宽度拖拽通过 ConfigService 持久化

**验证**: 拖拽浏览器到 500px → sidebar 变为 overlay；800px → icon-only；>1024px → 正常

### Agent 2.4: Zustand 中间件标准化

**文件**: (新建) `store/middleware/withLogger.ts`, `withDevtools.ts`, `withPersist.ts`; (修改) 全部 4 个 store

- 所有 store 统一中间件链: logger → devtools → persist → immer
- `withLogger`: dev 环境打印 state diff + action name
- `withDevtools`: 连接 Redux DevTools
- `withPersist`: 选择性持久化 (布局/设置类 key)
- 中间件 emit `performance.mark` 用于耗时追踪

**验证**: Redux DevTools 显示全部 store 操作；localStorage 只保存预期 key

---

## Round 3 — 服务/渲染管线

### Agent 3.1: ShortcutService 生命周期 + 上下文作用域

**文件**: `ShortcutService.ts`, `ShortcutRegistry.ts`, `ShortcutPlatformAdapt.ts`; (新建) `ShortcutConfigSchema.ts`

- `init(container)`: 绑定 keydown/keyup 到 container (默认 document)
- `destroy()`: 卸载监听器，清空缓冲区
- 上下文作用域: `createScope(name, container)` → 返回作用域实例
- `ShortcutMeta.priority: 0-100` → 高优先级优先匹配
- 外部配置: 从 ConfigService 读取 override，Zod schema 校验
- 保留快捷键检测: 禁止覆盖 OS/Browser 预留组合
- `withKeyup` 支持一次性快捷键

**验证**: Composer 获得焦点时 `Ctrl+K` 打开插入菜单；Settings 获得焦点时 `Ctrl+S` 保存

### Agent 3.2: FocusTrap a11y + AppErrorBoundary 断路器

**文件**: `FocusTrap.tsx`, `AppErrorBoundary.tsx`

**FocusTrap**:
- 激活时对兄弟元素设置 `aria-hidden="true"` + `inert` 属性
- 支持嵌套 traps 的 stacking 系统
- 添加 `data-focus-trap` 属性供自动化测试

**AppErrorBoundary**:
- `maxRetries=3`, `retryWindow=30s` — 30s 内连续 3 次崩溃 → 显示"应用需要重新加载"
- `circuitBreakerState`: `{ count, windowStart, tripped }`
- 崩溃计数通过 sessionStorage 跨导航保持

**验证**: FocusTrap 激活后 NVDA 读屏只走 trap 内元素；AppErrorBoundary 第 4 次连续崩溃显示 reload 按钮

### Agent 3.3: IncrementalMarkdownParser v2

**文件**: `IncrementalMarkdownParser.ts`, `incrementalMarkdownBridge.ts`

- **不安全 lookbehind 修复**: 用 capture group 方案替代 `(?<!\*)` (Safari <16.4 不兼容)
- **有序列表修复**: 检测 `^\d+\.\s` → `<ol>`，否则 `<ul>`
- **代码围栏闭合**: 关闭标记 `>=` 开启长度 (当前只需恰好相等)
- **新增块类型**:
  - 引用块: `^> ` → `<blockquote>` (支持嵌套)
  - 主题分隔: `^---$`/`^***$` → `<hr>`
  - 缩进代码块: 4空格 → `<pre><code>`
  - 任务列表: `- [x]`/`- [ ]` → `<li><input type="checkbox">`
  - HTML 块: 通过原样输出 (可配置门控)
- **`wrappedCodeBlock` 配置**: 支持服务端渲染兼容模式

**验证**: Safari 上 markdown 渲染无 `SyntaxError`；有序列表渲染为 `<ol>`；`> hello` 渲染为 `<blockquote>`

### Agent 3.4: 代码高亮 + Diff 着色

**文件**: `streamingCodeHighlighter.ts`, `codeHighlight.ts`, `DiffCardSplitView.tsx`, `DiffCardUnifiedView.tsx`

- **`streamingCodeHighlighter.ts:38-43`**: 死代码修复 → 实际调用 `highlightCode`(codeHighlight.ts)，不是 escapeHtml 占位
- **`escapeHtml` 修复**: 添加 `'` → `&#39;` (XSS 漏洞)
- **Diff 语法着色**: `DiffCardSplitView.tsx` 行内容通过 `highlightCode(content, 'diff')` 渲染
- **分栏布局修复**: `white-space: pre-wrap` → `white-space: pre` + `overflow-x: auto`
- **`diff` 语言注册**: 确保 hljs 注册了 diff 语言

**验证**: Diff 行带语法颜色；`<span title='x' onclick='alert(1)'>` 被正确转义；分栏视图中左右列对齐

### Agent 3.5: 文本测量/VirtualScroll/StreamBuffer 性能

**文件**: `useTextMeasure.ts`, `pretextFontBridge.ts`, `VirtualScrollManager.ts`, `StreamRenderBuffer.ts`

- **`useTextMeasure.ts`**: 卸载时不调用 `clearCache()` (破坏全局 Pretext 缓存) → 只 null 掉 ref
- **`pretextFontBridge.ts`**: DOM probe 结果缓存 + fontMetricsCache 单例；避免每次调用创建/删除 DOM 节点
- **`VirtualScrollManager.rebuildOffsets`**: O(n) 全量重建 → 增量重建 (只从第一个 dirty index 往后)
- **`StreamRenderBuffer`**: 单块 >8KB 时分片 (按 `maxBytesPerFrame` 切分) + rAF 分帧

**验证**: 50000 项列表中单项目高度更新 < 1ms；Pretext 缓存不因 unmount 丢失；单次 50KB flush 不阻塞

---

## Round 4 — Agent/MCP/Provider

### Agent 4.1: ToolRegistry + Provider 抽象

**文件**: (新建) `tool-registry.ts`, `provider-anthropic.ts`, `provider-gemini.ts`; (修改) `provider-gateway.ts`, `subagent-runtime.ts`

**ToolRegistry**:
- `register(tool)`, `get(name)`, `list()`, `discover()`, `listByCategory()`
- 替代 `defineTool()` 散落注册 → 中心化注册表

**Provider 抽象**:
- `AgentProvider` 接口: `complete()`, `stream()`, `embed()`, `health()`
- `AnthropicProvider`: Anthropic Messages API
- `GeminiProvider`: Google Generative Language API
- `ProviderFactory`: 根据 `model.provider` 返回正确实现

**验证**: 添加 Anthropic/Gemini 配置后，chat 请求使用对应 API；ToolRegistry.list() 返回所有已注册工具

### Agent 4.2: MCP SDK 集成 + 动态工具列表

**文件**: `mcpApi.ts`, `mcp-lifecycle.ts`; (新建) `mcpClient.ts`

- 集成 `@modelcontextprotocol/sdk`: `initialize` 握手, `notifications/initialized`, `resources/*`, `prompts/*`
- `notifications/tools/list_changed` handler: 收到通知后自动刷新工具缓存
- `tools/list` 分页: `nextCursor` token 支持
- `McpTransport` 抽象: StdioTransport / SSETransport / WebSocketTransport
- 删除非标准 `prompt_cache_key`；添加标准 `cache_control` 支持

**验证**: MCP 服务器变更工具列表后 → 自动 re-list；100+ 工具的 MCP 服务器正确分页

### Agent 4.3: 断路器 + 退避重试 + 工具超时

**文件**: `provider-gateway.ts`, `event-store.ts`, `subagent-runtime.ts`; (新建) `backpressure.ts`

**指数退避 + 抖动**:
- `calculateBackoff(attempt, baseMs, maxMs)`: `min(baseMs * 2^attempt + random(0, jitterMs), maxMs)`
- 用于所有 provider API 调用和事件存储写入

**断路器**:
- `CircuitBreaker` 类: `CLOSED → OPEN → HALF_OPEN`
- 5 次连续失败 → OPEN (30s)；HALF_OPEN 允许 1 个探测请求
- 发射 `provider:circuit-breaker:open/closed/half-open` 事件

**工具超时**:
- `subagent-runtime.ts`: 每个工具调用带 `timeoutMs` (默认 60s)
- `AbortController.timeout(timeoutMs)` 包裹执行

**事件存储重试**:
- `event-store.ts append()`: 3 次重试 + jittered backoff
- 失败的写入缓存到内存队列，连接恢复后重试

**验证**: 断路器在 5 次 503 后 OPEN → 30s 后 HALF_OPEN；写入临时故障后自动重试；工具 60s 超时返回错误

### Agent 4.4: Agent 生命周期 + 子 Agent 模式 + 事件存储锁定

**文件**: `orchestrator.ts`, `state-machine.ts`, `event-store.ts`, `subagent-runtime.ts`

**生命周期扩展**:
- `['queued', 'initializing', 'running', 'awaiting-approval', 'completing', 'completed', 'failed', 'cancelled', 'paused']`
- 每个状态转换发射 EventBus 事件

**子 Agent 模式**:
- `SubagentMode: 'foreground' | 'background' | 'fire-and-forget'`
- `spawnBatch(tasks[], concurrency)`: 批量并行生成，返回 `Promise<BatchResult[]>`

**文件锁定**:
- `CrossProcessLock` 使用 `navigator.locks` / 文件级 `flock`
- `event-store.ts` append 前获取共享锁，checkpoint 获取排他锁

**验证**: daemon 重启后活跃运行状态正确恢复；10 个并行子 Agent 可配置并发度

### Agent 4.5: 插件系统基础

**文件**: (新建) `plugin-registry.ts`, `plugin-discovery-fs.ts`, `plugin-sdk/`(包)

- 文件系统发现: 扫描 `~/.crish/plugins/` + `./plugins/` 的 `plugin.json`/`package.json`
- `PluginManifest`: name, version, hooks, permissions, entry
- 会话级生命周期钩子: `onSessionStart(id)`, `onSessionEnd(id)`, `onToolCall(call)`
- 热重载策略: 文件变更检测但不立即加载 (保护 prompt 缓存)，标记"待更新"，下次会话执行
- `@crish/plugin-sdk` 包: `createPlugin()`, `PluginAPI`, `registerHook()`

**验证**: 插件放入 `plugins/` 目录 → 自动发现并注册；会话开始时 `onSessionStart` 被调用

---

## Round 5 — UI 组件

### Agent 5.1: Tool Call UI 重构

**文件**: `ChatToolCallBlock.tsx`, `ChatToolCallBlock.module.css`, `ApprovalAskCard.tsx`

- **状态图标**: success→`CheckCircle`(绿), error→`XCircle`(红), running→spinner(保持), pending→`Clock`(琥珀)
- **工具耗时**: 接收 `startedAt/completedAt` → 折叠行显示 `1.2s`
- **重试按钮**: error 状态行添加重试按钮 → 调用 `onRetryTool(tc.id)`
- **批量批准/拒绝**: 连续 2+ 个 pending_approval 时显示 "Approve all(N)" / "Deny all(N)" 批操作栏
- **并行分组**: 相同 turnId 的工具用边框分组容器 + "⟷ N parallel" 标签
- **Diff 统计**: 折叠行显示 `+12 -3` 徽标
- **折叠动画**: `grid-template-rows: 0fr→1fr` → `max-height` + opacity transition

**验证**: 工具状态有独特图标；折叠行显示耗时/重试/diff 统计；批处理栏出现；折叠动画平滑

### Agent 5.2: 侧栏拖拽排序 UI

**文件**: `SidebarSessionList.tsx`, `useTabDrag.ts`, `SidebarSessionList.module.css`

- **Ghost 元素**: 拖拽时半透明克隆跟随指针
- **放置指示器**: 项之间的水平高亮线；文件夹用展开效果
- **FLIP 动画**: `getBoundingClientRect` → `transform: translate()` → `transition 200ms`
- **键盘重排**: Alt+Up/Down 移动会话项

**验证**: 拖拽会话到文件夹间 → 指示器显示；放到文件夹 → 正确移动；Alt+Up 会话上移

### Agent 5.3: 设计系统 + 无障碍

**文件**: `tokens.css`, `design-system.css`, `theme-dark.css`, `focus-visible.css`, `useA11y.ts`

- **无障碍审计**: 所有交互元素添加 `aria-label`；`:focus-visible` 统一样式
- **Skip link**: App.tsx 首个可聚焦元素添加"跳转到内容"
- **Color contrast**: `oklchColorGuard` 验证所有文本/背景组合满足 WCAG AA

**验证**: Lighthouse 无障碍评分 ≥ 90；纯键盘操作所有功能

### Agent 5.4: Plugin/Skill/Profile 系统完善

**文件**: (新建) `skill-lifecycle.ts`, `curator.ts`, `profile-manager.ts`, `yaml-loader.ts`, `toml-loader.ts`

**Skill Curator**:
- 自动归档 60 天未使用的技能 → `.crish/skills/archive/`
- 跟踪使用统计: `invokeCount`, `lastUsed`, `avgLatency`
- 归档前 emit `skill:archive:warning` 事件

**YAML/TOML 配置**:
- ConfigService: `loadYaml()`, `loadToml()` 加载文件
- 优先级: env > CLI > localStorage > 文件 > 默认值

**Profile 系统**:
- `ProfileManager`: `createProfile(name)`, `switchProfile(id)`, `deleteProfile(id)`
- 每个 profile 完全隔离: 独立 store namespace, config, plugins, skills
- `~/.crish/profiles/<id>/` 存储

**验证**: 技能 60 天未使用 → 自动归档；`loadYaml` 正确解析；切换 profile 后配置完全隔离

---

## Round 6 — 验证/测试

### Agent 6.1: 集成测试 (Daemon ↔ Client IPC)

**文件**: (新建) `tests/integration/daemon-ipc.test.ts`, `tests/integration/store-persistence.test.ts`, `tests/integration/mockDaemon.ts`

- 创建会话 → 发送消息 → 接收流 → 批准工具 → 归档会话 (完整工作流)
- Store 持久化 round-trip: bootstrap → 创建数据 → 关闭 → 重启 → 验证恢复
- Store 事务 rollback 正确性
- EventBus emitAsync 多 subscriber

**验证**: `npm run test:integration` 全部通过；mock daemon 模拟断连/重连

### Agent 6.2: 快照 + 视觉回归测试

**文件**: (新建) `tests/snapshots/`, `playwright.config.ts`

- `@testing-library/react` snapshot: `ChatToolCallBlock`, `DiffCardSplitView`, `Sidebar`, `AppErrorBoundary`
- Playwright 视觉回归: 工作区、侧栏、设置面板截图对比
- CI 上 diff 图片作为 artifact 上传

**验证**: `npx vitest --update` 更新快照；`npx playwright test` 基线对比通过

### Agent 6.3: 竞态条件测试

**文件**: (新建) `tests/race/store-concurrent.test.ts`, `tests/race/event-bus-concurrent.test.ts`

- 10 个并发 store mutations → 验证最终状态一致
- 并发 begin/rollback → 验证无部分应用
- 并发 emit/subscribe → 验证 handler 精确触发一次
- 并发 VirtualScroll setEstimated/setActual → 验证偏移不漂移
- 每个测试跑 100 迭代，CI 上失败率 < 2%

**验证**: 竞态测试 100/100 通过；无 flaky 失败

### Agent 6.4: Fuzz + 错误恢复测试

**文件**: (新建) `tests/fuzz/markdown-parser.test.ts`, `tests/fuzz/config-service.test.ts`

- **Markdown fuzz**: 随机字符串、深度嵌套、Unicode、混合编码
- **ConfigService fuzz**: 损坏 JSON、缺失 key、类型不匹配
- **恢复测试**: 杀 daemon → 自动重连 → 验证 store 一致性
- **存储配额测试**: localStorage 满 → 验证优雅降级
- **状态不变量**: 每个操作后验证 `activeSessionId ∈ sessions`

**验证**: 所有 fuzz 测试不崩溃；存储满时显示"存储空间不足"提示

---

## Round 7 — 持续优化/缺陷预防

### Agent 7.1: 性能监控 + 预算

**文件**: (新建) `performanceEngine.ts`(扩展), `performance-budget.ts`

- `performance.mark/measure` 在关键路径: store updates, markdown parse, virtual scroll
- 每次 `computeVisibleRange` 验证 < 16ms；`StreamRenderBuffer` 每帧 < 12ms
- React Profiler 包裹主组件
- 性能预算: dev 模式控制台警告超预算；生产环境发送监控事件

### Agent 7.2: 安全审计

- `escapeHtml` 全量验证: `&<>"'` 全部转义
- 所有 `dangerouslySetInnerHTML` 通过 DOMPurify 净化
- 审计 `apiKey`, `password`, `token` 在源码中不被序列化/日志暴露
- CSP 头: `script-src 'self'`; `style-src 'self' 'unsafe-inline'`

### Agent 7.3: 错误恢复审计 + 运行时断言

- 每个 `catch` 块: 要么 `errorStore.push()` 要么 `EventBus` 发射
- 每个 `console.error`: 附带结构化错误数据
- 不恢复错误: 写 `death-certificate.json` → 下次启动显示"重启"/"报告"
- 运行时 `invariant()`: Store 操作前验证状态一致性

### Agent 7.4: 文档 + 开发者体验

**文件**: (新建/更新) `AGENTS.md`, `ARCHITECTURE.md`, `docs/store-architecture.md`, `docs/event-bus-conventions.md`

- AGENTS.md: 架构决策记录 (ADR)、组件关系图、lint/typecheck 命令
- ADR 列表: ServiceRegistry, EventBus v2, ConfigService, Store 原子性, Provider 抽象, MCP 集成, 热重载策略
- ESLint 自定义规则: `no-json-parse-stringify-clone`, `no-lookbehind-regex`, `no-clear-cache-in-effect`
- 移除 `any` 类型: `SafeAny` 渐进替代

---

## 每轮验证总命令

```bash
# R1-R5 每轮完成后
cd apps/crish-desktop && npx tsc --noEmit
cd ../.. && npx vitest run --coverage

# R6-R7
npx playwright test
npx vitest run --reporter=junit
npx eslint . --max-warnings 0

# 最终全面检查
npm run check:all
npm run test:race
npm run test:integration
npm run test:visual
npm run perf:compare
```
