# Crish 桌面应用 — R4 多 Agent 并行执行方案

> 本方案是 FINAL-COMPREHENSIVE-REFACTOR-PLAN.md 的执行映射。
> 所有 R3 审计问题 + R3-A1~A6 方案 + 历史 Agent 输出已汇总。
> 逻辑依赖顺序驱动，无优先级/时间/人员安排。

---

## 总则

1. **零遗留**：清单中所有条目必须全部完成，不能跳过
2. **每个 Agent 输出必须包含**：修改文件清单 + 具体 diff 代码 + 验证命令及预期结果
3. **代码改动后必须运行 TypeScript 编译检查**（对应包的 `npx tsc --noEmit`）
4. **CSS 改动后必须运行** `grep` 验证残留值
5. **测试文件中的 TS 错误允许**（预先存在），但源代码文件必须零错误

---

## 已实施（直接执行，不再分配 Agent）

以下已在本次会话中直接手工完成，R4 所有 Agent 以其为前提：

| 范围 | 改动文件 | 内容 |
|------|----------|------|
| Store 同步 | `bootstrapStores.ts` | `syncLayoutToSession()` + `syncSessionToLayout()` + subscribe 注册 |
| 渲染空转 | `StreamRenderBuffer.ts` | `flushFrame()` 删除 idle rAF 重调度 |
| Panel 竞态 | `usePanelToggle.ts` | `closeSeqRef` 防过期 + `hasOpenedRef` 防初始聚焦 + `queueMicrotask` |
| 死代码 | `anthropic-cache-injector.ts` | 删除整个文件 |
| Gemini 缓存 | `provider-openai-compatible.ts` | `withCacheHint` 添加 `gemini-style` 分支，导入 `GeminiStyleCacheHints` |
| WAL 拒绝路径 | `wal.ts` | 提取 `scheduleCommit()` 方法，`commit()` finally 中重入调度 |
| 进程执行器 | `process-executor.ts` | stdio handler 变量化 + finally 清理 + `scheduleKillEscalation` 防重复 |
| 超时默认值 | `daemonChatBridge.ts` | `createFinishController` 默认 1200→8000ms |
| rAF 清理 | `useVirtualScroll.ts` | unmount 时 `cancelAnimationFrame` |
| 深色色值 | `theme-dark.css` | `#2a2a2a`→`var(--bg-tertiary)`，`#f0f0f0`→`var(--text-primary)`，`#4ade80`→`var(--color-success)`，`#d0d0d0`→`var(--text-secondary)`，`#242424`→`var(--bg-secondary)`，`#333333`→`var(--bg-hover)`，`#f2f2f2`→`var(--text-primary)` |
| 焦点对比度 | `ChatStatusRibbons.module.css` | 3 处 `55%`→`10%` focus-visible 透明值 |
| GC + LRU | `SessionRuntimeRegistry.ts` | 最大容量 50，LRU 淘汰，retain 时间戳，`startGC()`/`stopGC()`/`garbageCollect()`，remove 中释放引用 |

---

## 逻辑依赖图

```
Round 1 (Foundation)
  ├── Agent 1.1: Store 基础设施完善
  ├── Agent 1.2: 服务层 (EventStore/ErrorStore/ErrorBoundary)
  ├── Agent 1.3: 内存管理 (memoryManager + CacheProvider)
  └── Agent 1.4: Token 系统 (CSS tokens + JS constants)
        │
        ▼
Round 2 (Core Pipeline)
  ├── Agent 2.1: 渲染管线 (IncrementalMarkdownParser + DOM patch)
  ├── Agent 2.2: Provider 缓存层 (cache injection fixes)
  ├── Agent 2.3: 子 Agent/IPC/EventStore (daemon lifecycle)
  └── Agent 2.4: Daemon Bridge (timeout/error handling)
        │
        ▼
Round 3 (UI & Interaction)
  ├── Agent 3.1: CSS Token 替换 (radius/spacing/color/animation)
  ├── Agent 3.2: Title→Tooltip 111+ 替换
  ├── Agent 3.3: !important 治理 + theme-dark.css 清理
  ├── Agent 3.4: Focus 对比度 + ErrorBoundary 补全 + ErrorStore 改进
  └── Agent 3.5: DiffCard 性能 (useMemo + 去重遍历)
        │
        ▼
Round 4 (Quality & Cross-cutting)
  ├── Agent 4.1: 代码高亮 (流式高亮 + 缓存去重)
  ├── Agent 4.2: Token 估算 (WASM Tiktoken + context-compression)
  ├── Agent 4.3: Buffer/crypto→Web API (agent-runtime)
  ├── Agent 4.4: 全局验证 (tsc --noEmit + lint + grep 合规)
  └── Agent 4.5: 跨包一致性 (版本标签 + 导出清理 + 死文件审计)
```

---

## Round 1 — 基础设施层

### Agent 1.1: Store 基础设施完善

**依赖**：无（独立工作）
**输入端**：`sessionStore.ts`, `workspaceStore.ts`, `settingsUiStore.ts`, `storeTransaction.ts`, `autoIndexMiddleware.ts`, `useShallowSelector.ts`, `storeAccess.ts`, `layoutStore.ts`
**输出端**：`sessionStore.ts`, `storeTransaction.ts`, `autoIndexMiddleware.ts`, `bootstrapStores.ts`, `storeAccess.ts`

**任务清单**：

1. **清除 inline autoIndex**：删除 `sessionStore.ts` 第 59-74 行的 `unsubAutoIndex`，改为在 `bootstrapStores.ts` 中调用 `withAutoIndex(useSessionStore)`（通过 `import { withAutoIndex } from './autoIndexMiddleware'`）
2. **StoreTransaction rollback 兼容 immer**：`storeTransaction.ts` 的 `rollback()` 方法 `setState` 改为 `Object.assign(state, snap.xxx)` 模式（函数式更新），避免 immer Proxy 与 plain object 冲突
3. **useShallow 优化**：`sessionStore.ts` 的 `useSessions()` / `useActiveSession()`、`workspaceStore.ts` 的 `useWorkspaces()` / `useActiveWorkspace()` 使用 `useShallow` 包裹
4. **VirtualScrollManager 缓存 maxIndex**：`VirtualScrollManager.ts` 维护 `maxTrackedIndex` 替代 `Math.max(...this.heights.keys())`
5. **StoreTransaction rollback 触发 bootstrap sync cascade**：在 `bootstrapStores.ts` 添加 `batchRollback` flag，`storeTransaction.rollback()` 调用时设置/清除，防止三家 store setState 触发三次 layoutStore 同步

**验证**：
```
cd apps/crish-desktop && npx tsc --noEmit
# 确认 sessionStore.ts 无 unsubAutoIndex 引用
grep -n "unsubAutoIndex" src/store/sessionStore.ts
# 确认 withAutoIndex 在 bootstrapStores.ts 中被调用
grep -n "withAutoIndex" src/store/bootstrapStores.ts
```

---

### Agent 1.2: 服务层 (EventStore/ErrorStore/ErrorBoundary)

**依赖**：无
**输入端**：`App.tsx`, `AppErrorBoundary.tsx`, `ErrorStore.ts`, `event-store.ts`, `server-event-store.ts`
**输出端**：`AppErrorBoundary.tsx`, `ErrorStore.ts`, `event-store.ts`, `server-event-store.ts`, `App.tsx`

**任务清单**：

1. **AppErrorBoundary componentDidCatch 推送到 ErrorStore**：`AppErrorBoundary.tsx:85` 添加 `errorStore.push()` 调用（import from `../services/ErrorStore`）
2. **AppErrorBoundary crash 持久化**：崩溃时写 `sessionStorage`（key: `crish_error_boundary_crash`），挂载时读取 30s 内崩溃，dismiss 时清除
3. **ErrorStore 旧错误自动清理**：`ErrorStore.ts:102` 添加 `compactHistory()`，在每次 push 前清除超过 1 小时的已解决错误
4. **ErrorStore crypto.randomUUID 回退**：`ErrorStore.ts:89` `crypto.randomUUID()` 添加 try/catch 回退 `Date.now() + Math.random()`
5. **EventStore close() 异常隔离**：`event-store.ts:1024-1040` 的 `flush`/`flushIndex`/`batcher.close` 分别用独立 try/catch 保护
6. **DaemonEventStore installSignalHandlers 代理**：`server-event-store.ts` 增加 `installSignalHandlers()` 代理到 delegate
7. **App.tsx ErrorBoundary 覆盖**：`<FirstRunWizard>`（行 597）、`<ToastStack>`（行 827）、`<CheatsheetModal>`（行 832）分别包裹 `<AppErrorBoundary>`

**验证**：
```
cd apps/crish-desktop && npx tsc --noEmit
cd ../../packages/agent-orchestrator && npx tsc --noEmit
```

---

### Agent 1.3: 内存管理 (memoryManager + CacheProvider)

**依赖**：无
**输入端**：`memory-manager.ts`, `cache.ts`, `useTextHeightCache.ts`, `main.tsx`
**输出端**：`memory-manager.ts`, `cache.ts`, `useTextHeightCache.ts`, `main.tsx`

**任务清单**：

1. **memoryManager.start() 在 main.tsx 调用**：`main.tsx` 的 ReactDOM.createRoot 前添加 `memoryManager.start()`
2. **CacheProvider 接口 + TextHeightCache 实现**：`useTextHeightCache.ts` 的 `TextHeightCache` 实现 `CacheProvider` 接口（`shrink`, `emergencyClear`, `budget`），注册到 `memoryManager`
3. **memoryManager handlePressure 降级逻辑**：`memory-manager.ts:89` 添加 level≥2 时调用 `globalThis.gc()` 的逻辑 + 5s 去抖
4. **memoryManager memory-pressure 事件守卫**：`memory-manager.ts:48` 使用 `(process as any).on` + 注释
5. **LruCache emergencyClear 修复**：`cache.ts:107` 确认 emergencyClear 正确移除最旧 90% 条目（保留最新 10%）

**验证**：
```
cd packages/shared-utils && npx tsc --noEmit
cd apps/crish-desktop && npx tsc --noEmit
```

---

### Agent 1.4: Token 系统 (CSS tokens + JS constants)

**依赖**：无
**输入端**：`tokens.css`, `FINAL-COMPREHENSIVE-REFACTOR-PLAN.md` Part 2, `TOKEN-SYSTEM-REFACTOR-PLAN.md`
**输出端**：`tokens.css`, `z-index.css`（新建）, `constants/layout.ts`（新建）, `constants/componentDefaults.ts`（新建）

**任务清单**：

1. **tokens.css 新增缺失 token**：radius 语义命名（`--radius-xs`/`sm`/`md`/`lg`/`xl`/`2xl`）、space 步进（`--space-0`~`--space-12`）、color 语义色、animation 时长/easing
2. **z-index.css 新建**：按层级顺序定义 `--z-sidebar: 100`, `--z-popover: 200`, `--z-dropdown-menu: 400`, `--z-floating-panel: 1000`, `--z-modal-backdrop: 9000`, `--z-toast: 10000`, `--z-settings-panel: 13000` 等
3. **JS 常量文件创建**：`constants/layout.ts`（`SIDEBAR_WIDTH_DEFAULT`, `CHAT_COL_MAX`, `SETTINGS_CONTENT_MAX`）、`constants/componentDefaults.ts`（`MESSAGE_ESTIMATED_ROW_HEIGHT`, `MESSAGE_VIEWPORT_OVERSCAN`）
4. **CSS-JS 权威来源决策**：选择方案 A（JS 为权威，CSS fallback 注明"this value is overridden by JS at runtime"），在 `bootstrapStores.ts` 或 `main.tsx` 中注入 `document.documentElement.style.setProperty()`

**验证**：
```
cd apps/crish-desktop && npx tsc --noEmit
# 确认 tokens.css radius 无 --radius-<数字> 命名
grep -n "\-\-radius-[0-9]" src/styles/tokens.css
# 新文件确认
Test-Path src/constants/layout.ts
Test-Path src/constants/componentDefaults.ts
```

---

## Round 2 — 核心管线层

### Agent 2.1: 渲染管线 (IncrementalMarkdownParser + DOM patch)

**依赖**：Round 1 完成（Store 稳定）
**输入端**：`IncrementalMarkdownParser.ts`, `StreamRenderBuffer.ts`, `render-worker.ts`, `markdownCache.ts`, `codeHighlight.ts`, `ChatMessageRow.tsx`, `ChatMessageList.tsx`
**输出端**：`IncrementalMarkdownBridge.ts`（新建）, `domPatch.ts`（新建）, `StreamRenderBuffer.ts`, `ChatMessageRow.tsx`, `render-worker.ts`, `markdownRenderAsync.ts`, `StreamRenderBuffer.ts`

**任务清单**：

1. **IncrementalMarkdownBridge 桥接层**：新建 `src/api/incrementalMarkdownBridge.ts`，包装 `IncrementalMarkdownParser`，暴露 `push(fullText)→{ html, updates }` 接口
2. **StreamRenderBuffer 集成桥接**：`RenderFrame` 添加 `html` 和 `chunkUpdates` 字段，`flushFrame` 中调用桥接层
3. **DOM patch 工具**：新建 `src/api/domPatch.ts`，`chunkUpdatesToDomPatches()` 将 `ChunkUpdate[]` 转为 DOM patch 操作，`applyDomPatches()` 执行替换/追加
4. **ChatMessageRow 增量渲染**：将 `dangerouslySetInnerHTML` 改为 `containerRef` + `applyDomPatches`，优先消费增量 html
5. **Worker 端缓存去重**：`render-worker.ts` 移除 `renderCache` 和 `highlightCache`（重复），完全依赖主线程 cache
6. **markdownRenderAsync write-back**：Worker 返回后写回主线程 cache（`setMarkdownHtmlCache`），不等到终态
7. **computePatch 简化**：`streaming-renderer.ts:109` 移除 `computePatch` 方法，直接返回全量 html

**验证**：
```
cd apps/crish-desktop && npx tsc --noEmit
# 确认新文件存在
Test-Path src/api/incrementalMarkdownBridge.ts
Test-Path src/api/domPatch.ts
# 确认 computePatch 已移除
grep -n "computePatch" src/workers/streaming-renderer.ts
```

---

### Agent 2.2: Provider 缓存层

**依赖**：无（仅 agent-runtime 包）
**输入端**：`provider-cache-hints.ts`, `provider-openai-compatible.ts`, `prompt-assembly.ts`, `context-compression.ts`
**输出端**：`provider-cache-hints.ts`, `provider-openai-compatible.ts`, `prompt-assembly.ts`, `context-compression.ts`

**任务清单**：

1. **provider-openai-compatible.ts 的 `buildRequestBody` 区分响应端点**：Responses API 不使用 `prompt_cache_key`，Chat Completions 使用；`withCacheHint` 根据 `context.endpoint` 决定是否注入
2. **fnv1a 64 位升级**：`prompt-assembly.ts:521-528` 的 `fnv1a` 从 32 位扩展为 64 位（`h1`/`h2` 双字），返回 16 hex 字符
3. **RegExp 预编译**：`prompt-assembly.ts:328-347` 将正则字面量提取为模块级命名常量
4. **context-compression.ts 版本常量**：第 57 行提取 `CONTEXT_COMPRESSION_VERSION = 1`，第 255 行 `"v1"`→`v${CONTEXT_COMPRESSION_VERSION}`
5. **context-compression.ts Map→LruMap**：第 465 行 `tokenCache` 替换为 `LruMap<string, number>(5000)`
6. **provider-cache-hints.ts 断点计算修正**：`explicitBreakpoints` 循环改为按 `bp.afterBlockId` 定位目标，而非全指向 `lastUserMsg`

**验证**：
```
cd packages/agent-runtime && npx tsc --noEmit
# 确认 fnv1a 改为 64 位（输出长度 16）
grep -n "fnv1a" src/prompt-assembly.ts
# 确认版本常量
grep -n "CONTEXT_COMPRESSION_VERSION" src/context-compression.ts
```

---

### Agent 2.3: 子 Agent/IPC/EventStore

**依赖**：Round 1 的 EventStore 修复（Agent 1.2）
**输入端**：`subagent-runtime.ts`, `server.ts`, `daemon-client-registry.ts`, `event-store.ts`, `orchestrator.ts`
**输出端**：`subagent-runtime.ts`, `server.ts`, `daemon-client-registry.ts`, `event-store.ts`, `orchestrator.ts`

**任务清单**：

1. **subagent-runtime startRun 异常保护**：`emitBridge("started")` 移入 try 块内，只有在 started 已发出后才在 catch 中 emit ended
2. **buildCompletionSummary + emitBridge("ended") 移到 finally**：确保无论 `consumeSubagentEvents` 还是 summary 构建抛异常，ended 都发出
3. **WebSocket 断连后子 Agent 状态恢复**：`server.ts handleHello` 中推送活跃子 agent 的 `subagent-started` 给重连客户端
4. **Daemon 重启重建活跃子 Agent**：`server.ts start()` 中 `rebuildActiveSubagentsFromEventStore()`，从 EventStore replay `phase: "started"` 事件
5. **WebSocket disconnect 事件监听器清理**：`server.ts` 的 `ws.on("close")` 中添加 `removeAllListeners("message"/"ping"/"pong")`
6. **daemon-client-registry disconnect 清除 failedTransports**：`disconnect()` 中添加 `this.failedTransports.delete(ws)`
7. **orchestrator.ts startRun 移除 `void`**：行 317 `void driveRun()` 改为直接调用，使 promise rejection 可被 unhandledRejection 捕获

**验证**：
```
cd packages/agent-daemon && npx tsc --noEmit
cd packages/agent-orchestrator && npx tsc --noEmit
cd packages/agent-runtime && npx tsc --noEmit
```

---

### Agent 2.4: Daemon Bridge (timeout/error handling)

**依赖**：Round 1 的 ErrorStore 改进（Agent 1.2）
**输入端**：`daemonChatBridge.ts`, `ChatCard.tsx`, `approvalFlowMachine.ts`
**输出端**：`daemonChatBridge.ts`, `ChatCard.tsx`, `approvalFlowMachine.ts`

**任务清单**：

1. **messageBelongsToRun 空白字符串保护**：`daemonChatBridge.ts:75` 添加 `if (!msgRunId.trim()) return false;`，空白/空字符串视为不匹配（仅 null/undefined 为广播）
2. **daemonApproveTool catch 路径**：`ChatCard.tsx:657` 的 `daemonApproveTool(tid)` 添加 `.catch()`，设置 tool call 状态为 `'error'` + 显示 toast
3. **approvalFlowMachine 超时自动 deny**：添加 `timed_out` 状态 + 本地 timer（从 daemon 的 `remainingMs` 获取），超时自动 deny + 显示"审批超时，操作已跳过"
4. **async tool timeout 传播到 cancelRun**：`subagent-runtime.ts execute()` 添加显式 `timeoutMs` 参数 + 超时时调用 `options.cancelRun()`

**验证**：
```
cd apps/crish-desktop && npx tsc --noEmit
cd packages/agent-runtime && npx tsc --noEmit
```

---

## Round 3 — UI & Interaction

### Agent 3.1: CSS Token 替换

**依赖**：Agent 1.4（Token 定义完成）
**输入端**：`tokens.css`, `z-index.css`, `constants/layout.ts`, `constants/componentDefaults.ts`
**输出端**：所有 `*.module.css`, `*.css`, `*.tsx` 含硬编码值

**任务清单**：

1. **z-index 替换**：全项目 `z-index:<数字>` 替换为 `var(--z-*)` 对应 token，按 `z-index.css` 层级表逐个映射
2. **radius 替换**：硬编码 `border-radius: Npx`（N=4,5,6,8,10,12）替换为语义 token `var(--radius-xs/sm/md/lg/xl/2xl)`；多值 shorthand 人工审查
3. **space 替换**：`gap/padding/margin: Npx`（N=2,4,6,8,12,16,20,24,32,48,64）替换为 `var(--space-N)`；多值 shorthand 人工审查
4. **color 替换**：硬编码色值替换为语义色 token（`--text-primary`/`--bg-primary`/`--accent-*`）
5. **animation 替换**：`transition: all Xms`、`animation-duration: Xms` 替换为 `var(--transition-*)`/`var(--duration-*)`

**验证**：
```
cd apps/crish-desktop
# z-index 无裸值残留（内部函数参数 of calc() 等合理例外注明）
grep -rn "z-index:\s*[0-9]" src/ --include="*.css"
# radius 无裸值残留
grep -rn "border-radius:\s*[0-9]" src/ --include="*.css"
# space 残留统计
grep -rn "^\s*gap:\s*[0-9]" src/ --include="*.css"
npx tsc --noEmit
```

---

### Agent 3.2: Title→Tooltip 111+ 替换

**依赖**：Agent 1.4（Tooltip 组件已存在）
**输入端**：所有 `*.tsx` 文件含 `title=` 属性
**输出端**：所有含 `title` 的 `*.tsx` 文件

**任务清单**：

1. **交互元素优先替换**：`<button>`, `<a>`, `[role="button"]` 上的 `title` 全部替换为 `<Tooltip content="..."><button .../></Tooltip>`
2. **信息性 title 保留判断**：纯文本 `<span>`/`<div>` 上的 `title`（如状态 pill）可保留 native tooltip（对非交互元素是合理方案）
3. **文件列表**：
   - `McpSettingsTab.tsx` — 26 处（行 406, 430, 452, 477, 605, 625, 651, 656, 665, 675, 707, 718, 723, 728, 748, 759, 796, 801, 807, 810, 814, 824, 842, 854, 867）
   - `AgentCard.tsx` — 13 处（行 107, 158, 169, 179, 189, 250, 264, 469, 483, 500, 508, 520, 531）
   - `FilesCard.tsx` — 11 处（行 766, 786, 899, 930, 1031, 1110, 1177, 1336, 1350, 1507, 1541）
   - `App.tsx` — 8 处（行 627, 642, 655, 673, 685, 697, 720）
   - `ChatStatusRibbons.tsx` — 7 处（行 591, 780, 811, 819, 869, 890）
   - `SettingsRulesTab.tsx` — 2 处（行 500, 523）
   - 及其余文件（`CardPanel.tsx`, `ChangeOverviewCard.tsx`, `OverviewCard.tsx`, `ScheduledTasksPanel.tsx`, `SkillsSettingsTab.tsx` 等）

**验证**：
```
cd apps/crish-desktop
# 统计残留 title 属性（排除 Tooltip component 自身的 content prop 和 React 组件 prop）
grep -rn '\stitle="' src/ --include="*.tsx" --include="*.ts" | grep -v 'Tooltip' | grep -v 'SettingsSection\|SettingsRow\|SettingsPage' | grep -v 'titleBits\|titleBits\|countTitle\|zoneTitle\|planTitle'
npx tsc --noEmit
```

---

### Agent 3.3: !important 治理 + theme-dark.css 清理

**依赖**：Agent 1.4（Token 定义完成）
**输入端**：所有 `*.css` 含 `!important`，`theme-dark.css`
**输出端**：全项目 CSS 文件

**任务清单**：

1. **!important 清单生成**：`rg '!important' --include='*.css' apps/crish-desktop/src/` 统计总数
2. **高频安全移除**：
   - `background: xxx !important` → `background: xxx`（上下文已唯一）
   - `color: xxx !important` → `color: xxx`
   - `box-shadow: none !important` → `box-shadow: none`
   - `border-color: xxx !important` → `border-color: xxx`
3. **需保留的类型**：
   - `display: none !important`（阻止类使用）
   - `.isOpen .isActive` 等状态覆盖
   - `resets`（textarea `background: transparent !important`）
   - `shell-*.css` 中提升优先级的
4. **theme-dark.css 剩余硬编码修复**：
   - 行 42 `color: #f0f0f0` → `var(--md-code-fg)`（已改）
   - 行 74 `border-color: #4ade80` → `var(--color-success)`（已改）
   - 行 87 `color: #d0d0d0` → `var(--text-secondary)`（已改）
   - 行 90-91 后备值保留（可接受）
   - 检查行 100+ 剩余硬编码值

**验证**：
```
cd apps/crish-desktop
# 统计 !important 总次数
$imp = Select-String -Path src/**/*.css -Pattern '!important' | Measure-Object | Select-Object -ExpandProperty Count
Write-Output "Remaining !important: $imp"
# 确认无裸色值在 theme-dark.css
Select-String -Path src/styles/theme-dark.css -Pattern '#[0-9a-fA-F]{6}' | ForEach-Object { Write-Output $_.LineNumber $_.Line }
npx tsc --noEmit
```

---

### Agent 3.4: Focus 对比度 + ErrorBoundary 补全 + ErrorStore 改进

**依赖**：Agent 1.2（ErrorBoundary/ErrorStore 改进）
**输入端**：`focus-visible.css`, 所有 `*.module.css`, `useErrorBoundary.ts`, `ChatMessageList.tsx`, `ToastStack.tsx`
**输出端**：`focus-visible.css`, `ChatMessageList.tsx`, `ToastStack.tsx`, `useErrorBoundary.ts`, `App.tsx`

**任务清单**：

1. **focus-visible.css 全局提升**：`outline-offset: 2px`→`1px`（防裁切），深色主题 `--focus-ring-color` 从 15% 提升到 30%
2. **SettingsSelect 焦点对比度**：`SettingsSelect.module.css` 焦点 `border-color` 从 `6%` 混合改为 `30%` 混合
3. **ChatMessageList 每条消息 ErrorBoundary**：在渲染循环（行 738-792）每条消息外包 `<AppErrorBoundary variant="minimal">`
4. **ToastStack aria-live**：将 `<div role="status" aria-live="polite">` 改为每条 toast 动态 `aria-live`（错误 toast → `assertive`，普通 → `polite`）
5. **Toast 关闭按钮**：每条 toast 添加关闭按钮 `<button aria-label="关闭通知">`
6. **useErrorBoundary autoReset 定时器清理**：修正 `autoResetTimeout` 变化时旧定时器未清除的问题

**验证**：
```
cd apps/crish-desktop && npx tsc --noEmit
```

---

### Agent 3.5: DiffCard 性能

**依赖**：无
**输入端**：`DiffCard.tsx`, `DiffCardUnifiedView.tsx`, `DiffCardSplitView.tsx`
**输出端**：`DiffCard.tsx`, `DiffCardUnifiedView.tsx`, `DiffCardSplitView.tsx`

**任务清单**：

1. **getComputedChanges useMemo**：`DiffCard.tsx` 将 `getComputedChanges(f)` 改为 `useMemo` 缓存，以 `fileList` 为依赖
2. **getUnifiedRenderItems/getSplitRenderItems useMemo**：分别缓存计算结果
3. **mergeSessionDiffFiles 去重**：`DiffCardInner` 中两次调用 `mergeSessionDiffFiles(aiTurns)` 合并为顶层 `useMemo`
4. **StreamTextBatcher maxBufferedChars 上限**：`useChatStream.ts` 实例化时传入 `maxBufferedChars: 8000`，`StreamTextBatcher` 默认值设为 8000
5. **VirtualScrollManager invalidateActual 方法**：添加 `invalidateActual(index)` + 版本号防止 stale setActual；`ChatMessageRow.tsx` 内容变化时调用
6. **DiffCard split view 行高对齐**：`DiffCardSplitView.tsx` 固定 `rowHeight: 22` 改为 `minHeight` 允许增长

**验证**：
```
cd apps/crish-desktop && npx tsc --noEmit
```

---

## Round 4 — 质量与横切

### Agent 4.1: 代码高亮 (流式高亮 + 缓存去重)

**依赖**：Agent 2.1（渲染管线稳定）
**输入端**：`render-worker.ts`, `codeHighlight.ts`, `ChatMessageRow.tsx`, `IncrementalMarkdownParser.ts`
**输出端**：`streamingCodeHighlighter.ts`（新建）, `render-worker.ts`, `codeHighlight.ts`

**任务清单**：

1. **StreamingCodeHighlighter**：新建 `src/api/streamingCodeHighlighter.ts`，按行缓存高亮结果，增量拼接 HTML
2. **Worker 流式高亮模式**：`render-worker.ts` 新增 `highlight.code.stream` 和 `highlight.code.stream.reset` 消息类型
3. **Worker 端 highlightCache 去重**：缩小或删除 Worker 端 `highlightCache`，完全依赖主线程 `codeHighlight.ts` 的 LRU cache
4. **缺失语言注册**：`codeHighlight.ts` 注册 `diff`、`ruby`、`php`、`swift`、`kotlin`、`dart` 等常用语言
5. **IncrementalMarkdownParser renderCodeBlock 高亮修复**：行 305 的 `escapeHtml(body)` 改为 `highlightCode(body, lang)`

**验证**：
```
cd apps/crish-desktop && npx tsc --noEmit
Test-Path src/api/streamingCodeHighlighter.ts
```

---

### Agent 4.2: Token 估算 (WASM Tiktoken + context-compression)

**依赖**：无
**输入端**：`wasm-tiktoken.ts`, `context-compression.ts`, `cache.ts`, `memory-manager.ts`
**输出端**：`context-compression.ts`, `wasm-tiktoken.ts`, `cache.ts`

**任务清单**：

1. **context-compression WeakMap 泄漏修复**：`context-manager.ts:75` 添加 `clearProjectionCacheFor()` 在 compression 后清理
2. **WASM Tiktoken 兜底路径**：`wasm-tiktoken.ts` 添加加载失败时的 `chars/4` 回退
3. **context-compression 版本常量统一**：第 255 行 `"v1"`→`v${CONTEXT_COMPRESSION_VERSION}`
4. **tokenCache 容量限制**：第 465 行 `Map`→`LruMap(5000)`

**验证**：
```
cd packages/agent-runtime && npx tsc --noEmit
cd packages/shared-utils && npx tsc --noEmit
```

---

### Agent 4.3: Buffer/crypto→Web API

**依赖**：无
**输入端**：`encoding.ts`, `prompt-assembly.ts`, `blob-externalization.ts`, `checkpoints.ts`, `subagent-context-pack.ts` 等
**输出端**：上述文件中所有 `Buffer`/`createHash` 用法

**任务清单**：

1. **encoding.ts 移除 node:util**：`TextDecoder`/`TextEncoder` 改为全局对象（Node 18+）；`Buffer.from` → `new TextEncoder().encode()` / `new Uint8Array()`；`Buffer.concat` → 手写 `concatBytes()`；`buffer.swap16` → 手写 `swapUint16()`
2. **prompt-assembly.ts 替换 Buffer.byteLength**：第 1 行删除 `import { Buffer }`，第 497 行 `Buffer.byteLength` → `new TextEncoder().encode().byteLength`
3. **blob-externalization.ts 替换 createHash + Buffer**：`createHash("sha256")` → `crypto.subtle.digest("SHA-256", bytes)`（`sha256Hex` 异步辅助函数）；`Buffer.from(base64, "base64")` → `atob` + `Uint8Array`；类型 `Buffer` → `Uint8Array`（`DataUrlParts.bytes`）
4. **checkpoints.ts, local-tools/shared.ts, prompt-context.ts, resource-uri.ts, runtime-metrics.ts, context-manager.ts, scoped-context.ts, snapshots.ts, structured-summary.ts, subagent-context-pack.ts**：全部 `createHash` → `crypto.subtle.digest`；`randomUUID`（来自 crypto 包）→ `crypto.randomUUID()`（全局 Web API）

**验证**：
```
cd packages/agent-runtime && npx tsc --noEmit
# 确认无 node:buffer/node:crypto import
grep -rn "from.*node:buffer\|from.*node:crypto" src/ --include="*.ts"
```

---

### Agent 4.4: 全局验证

**依赖**：所有 Round 1-4 Agent 完成
**输入端**：全部代码
**输出端**：验证报告

**任务清单**：

1. **所有包 tsc --noEmit**：
   - `apps/crish-desktop`
   - `packages/shared-utils`
   - `packages/agent-runtime`
   - `packages/agent-daemon`
   - `packages/agent-orchestrator`
2. **CSS 合规 grep**：
   - `z-index: <数字>` 无裸值残留
   - `border-radius: <数字>px` 无裸值（合理例外注明）
   - `gap/padding/margin: <数字>px` 统计
   - `!important` 统计
   - `title=` 统计
3. **死文件审计**：检查是否有类似 `anthropic-cache-injector.ts` 的孤立导出
4. **版本标签一致性**：`SUBAGENT_CONTEXT_PACK_VERSION`, `PROMPT_ASSEMBLY_VERSION`, `CONTEXT_COMPRESSION_VERSION`, `STRUCTURED_SUMMARY_VERSION` 值匹配

**验证**：
```
# 全部汇总
```

---

### Agent 4.5: 跨包一致性

**依赖**：所有 Round 1-4 Agent 完成
**输入端**：全部代码
**输出端**：修复报告

**任务清单**：

1. **导出清理**：检查所有 `packages/` 中未被外部导入的 export，标记或删除
2. **JsonlAppendBatcher 导出修复**：`packages/shared-utils/src/index.ts` 添加 `JsonlAppendBatcher` 导出（当前 agent-runtime 4 个文件引用但无法导入 — TS error）
3. **import 路径统一**：检查跨包 import 使用 `@crish/*` 别名而非相对路径
4. **AGENTS.md 更新**：将全部验证命令写入 `AGENTS.md`，确保下次会话可一键执行

**验证**：
```
cd packages/agent-runtime && npx tsc --noEmit  # 确认 JsonlAppendBatcher 错误修复
```
