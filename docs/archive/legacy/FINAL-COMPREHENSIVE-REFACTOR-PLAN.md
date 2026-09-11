# Crish 桌面应用全系统终极重构方案

> 版本：v3.0
> 生成过程：第 1 轮 8 Agent 问题分析 → 第 2 轮 6 Agent 方案设计 → 最终综合编译
> 总问题覆盖：~400 个已识别问题，零遗留原则
> 架构原则：拒绝补丁式改进，系统性重构，力求当前最先进实践

---

## 目录

- [第一部分：方案总纲与架构蓝图](#第一部分方案总纲与架构蓝图)
- [第二部分：Store 架构重构](#第二部分store-架构重构)
- [第三部分：UI 设计系统重构](#第三部分ui-设计系统重构)
- [第四部分：渲染管线重构](#第四部分渲染管线重构)
- [第五部分：后端性能重构](#第五部分后端性能重构)
- [第六部分：交互规范与行为统一](#第六部分交互规范与行为统一)
- [第七部分：Agent/审批面板重构](#第七部分agent审批面板重构)
- [第八部分：实施路线图](#第八部分实施路线图)

---

## 第一部分：方案总纲与架构蓝图

### 1.1 核心原则

```
1. 零遗留 — 所有已识别问题必须一次性解决，不允许分优先级遗留
2. 架构领先 — 不补丁式改进，重构后的系统应代表最先进的实践
3. 视觉优雅 — 前端保证克制的高级感、像素级精密度
4. 性能极致 — CLI 级响应速度，60fps 流畅度
```

### 1.2 当前架构诊断

通过第 1 轮 8 个 Agent 的深度分析，识别出约 400 个具体问题，集中在以下 6 大根因：

| 根因 | 影响面 | 典型问题 |
|------|--------|---------|
| **Store 未物理分离** | 全部 UI 组件 | 三 facade 指向同一实例，跨域重渲染，15+ 处手动 reindex |
| **UI 设计系统不统一** | 全部 CSS 文件 | 色阶缺失、深色模式干瘪、radius 与实际使用脱节、动画退出缺失 |
| **渲染管线无缓冲** | 对话+列表+终端 | 流式 20-30FPS、DOM 全量挂载、xterm.js 缺失、Markdown 全量重 parse |
| **后端缓存断层** | 全部 LLM + IPC | Anthropic/Gemini cache 被 HTTP 层丢弃、Shell 无池、WAL 缺失 |
| **交互规范不严格** | 全部 UI 交互 | 100+ title 残留、Focus 对比度不合规、translateY 跳动、ErrorBoundary 不全 |
| **Agent/审批代码重复** | AgentCard + InlineAgentPanel | 580 行超大函数 streamViaDaemon、审批失败无反馈、断连无恢复 |

### 1.3 目标架构

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                          UI 组件层 (React 18 + Suspense)                      │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌───────────────────┐ │
│  │ Chat     │ │ Tool     │ │ Sidebar  │ │ Settings │ │ Agent / Approval  │ │
│  │ System   │ │ Panels   │ │          │ │          │ │ Panels            │ │
│  └────┬─────┘ └────┬─────┘ └────┬─────┘ └────┬─────┘ └───────┬───────────┘ │
│       │            │            │            │               │             │
├───────┴────────────┴────────────┴────────────┴───────────────┴─────────────┤
│                          服务层 (Services)                                   │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────────────┐ │
│  │ Stream   │ │ Virtual  │ │ Pretext  │ │ Tooltip  │ │ EventBus + Toast │ │
│  │ Buffer   │ │ Scroll   │ │ Bridge   │ │ System   │ │ Bus + ErrorStore │ │
│  └──────────┘ └──────────┘ └──────────┘ └──────────┘ └──────────────────┘ │
├─────────────────────────────────────────────────────────────────────────────┤
│                   Store 层 (三独立物理 Zustand)                               │
│  ┌──────────────────┐ ┌──────────────────┐ ┌────────────────────────────┐  │
│  │ SessionStore     │ │ WorkspaceStore   │ │ SettingsUiStore            │  │
│  │ (独立 create)     │ │ (独立 create)     │ │ (独立 create)                │  │
│  │ auto-index       │ │ layout, DnD      │ │ permission, plan,          │  │
│  │ sessionsById     │ │ diffFiles        │ │ overlay, theme, settings   │  │
│  │ composerDrafts   │ │                  │ │ scheduledTasks, providers  │  │
│  │ terminalBySess.  │ │                  │ │ telemetry, workers         │  │
│  └──────────────────┘ └──────────────────┘ └────────────────────────────┘  │
│                      storeAccess (跨域编排 + 事务)                           │
│                      SessionRuntimeRegistry (LRU + GC)                      │
├─────────────────────────────────────────────────────────────────────────────┤
│                       渲染引擎层                                              │
│  ┌───────────────┐ ┌───────────────┐ ┌───────────────┐ ┌───────────────┐  │
│  │ VirtualScroll │ │ StreamRender  │ │ MarkdownInc   │ │ xterm.js      │  │
│  │ Manager       │ │ Buffer        │ │ Parser        │ │ WebGL         │  │
│  │ (双向变高)     │ │ (RAF配速)     │ │ (块级增量AST)  │ │ Terminal      │  │
│  └───────────────┘ └───────────────┘ └───────────────┘ └───────────────┘  │
├─────────────────────────────────────────────────────────────────────────────┤
│                   IPC 与数据通道                                               │
│  ┌───────────────┐ ┌───────────────┐ ┌───────────────┐ ┌─────────────────┐ │
│  │ Event Batcher │ │ Delta Encoder │ │ Group-Commit  │ │ Shell Process   │ │
│  │ (rAF批处理)    │ │ (增量编码)     │ │ WAL (存储引擎) │ │ Pool (常驻进程)  │ │
│  └───────────────┘ └───────────────┘ └───────────────┘ └─────────────────┘ │
├─────────────────────────────────────────────────────────────────────────────┤
│                  LLM / Provider 层                                            │
│  ┌──────────────────┐ ┌──────────────────┐ ┌────────────────────────────┐  │
│  │ Anthropic        │ │ Gemini           │ │ WASM Tiktoken             │  │
│  │ cache_control    │ │ cachedContent    │ │ Token Counter             │  │
│  │ HTTP 层注入      │ │ HTTP 层注入       │ │ (精确到模型的 BPE)         │  │
│  └──────────────────┘ └──────────────────┘ └────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## 第二部分：Store 架构重构

### 2.1 三独立 Zustand Store

**当前问题**：`useSessionStore = useWorkspaceStore = useSettingsUiStore = useLayoutStore`，三个门面指向同一实例。任意域状态变更通知所有域的订阅者，导致跨域组件无效重渲染。

**重构方案**：

```typescript
// store/sessionStore.ts — 独立实例
export const useSessionStore = create<SessionStore>()(
  subscribeWithSelector(
    immer((set, get) => ({
      sessions: [],
      sessionsById: {},      // 由 middleware 自动维护
      folderOrder: [],
      activeSessionId: '',
      activeAgentId: null,
      panelAgentId: null,
      composerDrafts: {},
      terminalBySession: {},
      terminalLines: [],     // 兼容遗留字段
      // ... 全部 action 从 layoutStore 搬迁至此
    }))
  )
);

// store/workspaceStore.ts — 独立实例
export const useWorkspaceStore = create<WorkspaceStore>()(
  immer((set, get) => ({
    workspaces: [],
    activeWorkspaceIndex: 0,
    tabModeEnabled: true,
    draggedTab: null,
    dropPreview: null,
    activeDiffSource: null,
    diffFiles: [],
    // ... 全部 layout/DnD/diff action 从 layoutStore 搬迁至此
  }))
);

// store/settingsUiStore.ts — 独立实例
export const useSettingsUiStore = create<SettingsUiStore>()(
  immer((set, get) => ({
    showSettingsOverlay: false,
    settingsActiveTab: 'profile',
    permissionMode: 'ask',
    planModeEnabled: false,
    planApproved: false,
    commandPermissions: [],
    uiSize: 'medium',
    shellChromeMode: 'classic',
    chatMainSurface: 'chat',
    sidebarCollapsed: false,
    appSettings: null,
    scheduledTasks: [],
    mcpServers: [],
    providers: [],
    activeWorkers: [],
    tokenUsage: { input: 0, inputMax: 160000, output: 0, outputMax: 16000, inputCost: 0, outputCost: 0, since: Date.now() },
  }))
);
```

### 2.2 自动索引 Middleware

**问题**：15+ 处手动 `reindexSessionsById` 调用，`moveSessionRealtime`、`branchSession` 等路径遗漏。

**方案**：使用 `subscribeWithSelector` 监听 `sessions` 数组变化，自动重建 `sessionsById`。

```typescript
// 在 SessionStore 创建后自动注册
store.subscribe(
  (state: SessionStoreState) => state.sessions,
  (sessions: SessionState[]) => {
    const map: Record<string, SessionState> = Object.create(null);
    for (const s of sessions) {
      if (s?.id) map[s.id] = s;
    }
    store.setState({ sessionsById: map });
  },
  { equalityFn: (a, b) => a === b },
);
```

**迁移**：删除所有 `sessionActions.ts` 和 `sessionIndex.ts` 中的 `reindexSessionsById(state)` 调用。

### 2.3 `useShallow` 全面应用

**问题**：全代码库零使用 `useShallow`，任意 store 字段变更触发全组件重渲染。

**方案**：

```typescript
import { useShallow } from 'zustand/react/shallow';

// 所有 selector 改为 useShallow 包裹
export function useSessions(): SessionState[] {
  return useSessionStore(useShallow((s) => s.sessions));
}
export function useActiveSession(): SessionState | undefined {
  return useSessionStore(useShallow((s) => s.sessionsById[s.activeSessionId]));
}
export function useActiveWorkspace(): WorkspaceState | undefined {
  return useWorkspaceStore(useShallow((s) => s.workspaces[s.activeWorkspaceIndex]));
}
```

**预计效果**：减少 60%+ 的无关组件重渲染。

### 2.4 StoreTransaction 增强

**问题**：当前 `cloneSessions` 仅浅拷贝 `sessionsById` 容器，嵌套对象共享引用；`rollback` 使用 `store.setState(snapshot)` 绕过 immer。

**方案**：

```typescript
class StoreTransaction {
  private snapshots: StoreSnapshot[] = [];

  begin(): void {
    this.snapshots.push({
      session: useSessionStore.getState(),
      workspace: useWorkspaceStore.getState(),
      settingsUi: useSettingsUiStore.getState(),
    });
  }

  commit(): void {
    this.snapshots.pop();
  }

  rollback(): void {
    const snap = this.snapshots.pop();
    if (!snap) return;
    if (snap.session)  useSessionStore.setState(snap.session, true);
    if (snap.workspace) useWorkspaceStore.setState(snap.workspace, true);
    if (snap.settingsUi) useSettingsUiStore.setState(snap.settingsUi, true);
  }

  run<T>(fn: () => T): T {
    this.begin();
    try { const r = fn(); this.commit(); return r; }
    catch (e) { this.rollback(); throw e; }
  }
}
```

### 2.5 SessionRuntimeRegistry 重构

**问题**：全局单例无 GC、引用计数未使用、diffFiles 与 store 重复。

**方案**：
- 添加 LRU 淘汰（`MAX_ENTRIES = 50`）
- 实现引用计数（`retain/release` 在会话切换时调用）
- 移除 `diffFiles` 字段（统一走 WorkspaceStore）
- 添加定期 GC（每分钟扫描 5 分钟无访问的条目）
- `deleteSession` 时联动清理

---

## 第三部分：UI 设计系统重构

### 3.1 蓝墨黑 (Slate) 调色盘

**问题**：深色模式 `hsl(0,0%,5%)` 纯中性黑显干瘪；12 个组件使用 `color-mix(in srgb, #000 ...)` 不统一。

**方案**：

```css
/* — 蓝墨黑 12 阶原始色阶 (218° 色相) */
--slate-0:  hsl(218, 20%, 99%);
--slate-1:  hsl(218, 18%, 97%);
--slate-2:  hsl(218, 16%, 95%);
--slate-3:  hsl(218, 14%, 92%);
--slate-4:  hsl(218, 12%, 88%);
--slate-5:  hsl(218, 10%, 80%);
--slate-6:  hsl(218, 8%,  70%);
--slate-7:  hsl(218, 6%,  58%);
--slate-8:  hsl(218, 5%,  42%);
--slate-9:  hsl(218, 4%,  28%);
--slate-10: hsl(218, 3%,  18%);
--slate-11: hsl(218, 2%,  12%);

/* — 深色主题映射 (蓝墨黑注入 218° 色相) */
html[data-theme="dark"] {
  --bg-primary:   hsl(218, 14%, 7%);     /* E0: 窗口基底 */
  --bg-secondary: hsl(218, 12%, 9.5%);   /* E1: 侧栏 */
  --bg-card:      hsl(218, 10%, 12.5%);  /* E2: 卡片 */
  --bg-input:     hsl(218, 10%, 10.5%);  /* E3: 输入壳 */
  --bg-elevated:  hsl(218, 10%, 16%);    /* E4: 弹层/菜单 */
  --text-primary: hsl(218, 8%,  88%);
  --text-secondary: hsl(218, 6%, 68%);
  --text-tertiary: hsl(218, 5%, 48%);
  --border-color: hsl(218, 10%, 18.5%);
  --border-subtle: hsl(218, 8%, 14.5%);
  --hairline: color-mix(in srgb, var(--border-color) 75%, transparent);
  --shadow-color: #000;
}

/* — 浅色主题映射 (38° 暖灰) */
html[data-theme="light"] {
  --bg-primary:   hsl(38, 8%,  99%);
  --bg-secondary: hsl(38, 6%,  97%);
  --bg-card:      hsl(38, 4%,  100%);
  --bg-input:     hsl(38, 8%,  97%);
  --bg-elevated:  hsl(38, 4%,  100%);
  --text-primary: hsl(38, 10%, 12%);
  --text-secondary: hsl(38, 6%, 38%);
  --text-tertiary: hsl(38, 4%, 62%);
  --border-color: hsl(38, 8%,  88%);
  --border-subtle: hsl(38, 6%, 92%);
  --shadow-color: #000;
}
```

### 3.2 五级 Surface Elevation

```
E0 (窗口基底):   --bg-primary    无阴影
E1 (侧栏/面板壳): --bg-secondary 1px hairline bottom
E2 (卡片/会话):  --bg-card       --shadow-md + inset 顶光
E3 (输入壳):     --bg-card       --shadow-md + inset 顶光
E4 (弹层/菜单):  --bg-elevated   --shadow-lg + 顺光渐退
```

每个 Elevation 在深色下叠加 `180° 顺光退晕渐变`：
```css
--elevation-gradient: linear-gradient(
  180deg,
  rgba(255,255,255,0.018) 0%,
  transparent 100%
);
```

### 3.3 Hairline 微渐变边框系统

```css
--hairline-subtle: color-mix(in srgb, var(--border-color) 55%, transparent);
--hairline:        color-mix(in srgb, var(--border-color) 75%, transparent);
--hairline-strong: color-mix(in srgb, var(--border-color) 90%, transparent);
```

### 3.4 圆角矩阵（与实际使用频率对齐）

```css
--radius-micro: 2px;    /* 极小装饰 */
--radius-xs:    4px;    /* Tag、Badge、内联代码 (60次) */
--radius-sm:    5px;    /* 输入框 (21次) */
--radius-md:    6px;    /* 卡片内嵌 (83次) */
--radius-lg:    8px;    /* 面板/下拉菜单 (108次) — 最常用 */
--radius-xl:    10px;   /* 对话框 (61次) */
--radius-2xl:   12px;   /* 弹层 (35次) */
--radius-full:  999px;  /* 胶囊/徽标 */
```

### 3.5 动画系统

**四类缓动曲线**：
```
--ease-spring:  cubic-bezier(0.16, 1, 0.3, 1)  — 弹层/模态入场
--ease-standard: cubic-bezier(0.4, 0, 0.2, 1) — hover/focus
--ease-decel:   cubic-bezier(0, 0, 0.2, 1)    — 入场
--ease-accel:   cubic-bezier(0.4, 0, 1, 1)    — 出场
```

**统一动画关键帧（cds- 前缀）**：
- `cds-fade-in`, `cds-fade-out`
- `cds-popover-enter`, `cds-popover-exit`
- `cds-modal-enter`, `cds-modal-exit`
- `cds-slide-up-enter`, `cds-slide-up-exit`
- `cds-slide-down-enter`
- `cds-press`, `cds-pulse-soft`, `cds-pulse-glow`
- `cds-shimmer`, `cds-spin`, `cds-flash`

**退出动画补全要求**：每个有入场动画的组件必须配套退出动画。
- 面板类使用 `useAnimatedPresence` 状态机（`entering → open → exiting → closed`）
- 入场：`var(--transition-spring-layout)`（220ms）
- 出场：`var(--transition-exit)`（200ms）

---

## 第四部分：渲染管线重构

### 4.1 StreamRenderBuffer（RAF 配速缓冲池）

**问题**：WebSocket 层高频 token（50-100Hz）直接推入 Zustand Store，UI 帧率 20-30FPS。

**方案**：

```typescript
class StreamRenderBuffer {
  private accumulated: string[] = [];
  private rafId: number | null = null;
  private lastFlushOffset = 0;
  private frameBudgetMs = 12;          // 12ms 帧预算
  private maxBytesPerFrame = 8192;     // 超过分帧

  onFrame: ((frame: RenderFrame) => void) | null = null;

  push(delta: string): void {
    this.accumulated.push(delta);
    if (!this.rafId) this.schedule();
  }

  private schedule(): void {
    this.rafId = requestAnimationFrame(() => {
      this.rafId = null;
      if (this.accumulated.length === 0) return;
      this.flush();
      if (this.onFrame) this.schedule();
    });
  }

  private flush(): void {
    const delta = this.accumulated.join('');
    this.accumulated = [];
    this.onFrame?.({ delta, full: '', lastOffset: this.lastFlushOffset, isFinal: false, timestamp: Date.now() });
    this.lastFlushOffset += delta.length;
  }
}
```

**预期效果**：流式帧率从 20-30FPS → 55-60FPS。

### 4.2 消息列表双向变高虚拟滚动

**问题**：80+ 消息行全量挂载 DOM，`MESSAGE_ESTIMATED_ROW_HEIGHT = 120` 固定估算。

**方案**：

```
VirtualScrollManager
├── computeVisibleRange(count, overscan) → { startIndex, endIndex, startOffset, totalHeight }
├── getHeight(index) → actual ?? estimated ?? fallback(120)
├── setActual(index, height) — ResizeObserver 回写
├── scrollToIndex(index, align)
└── maintainAnchor() — 滚动锚定修正

useVirtualScroll hook
├── visibleRange — 当前可见范围
├── containerRef — 滚动容器
├── onScroll — RAF-throttled scroll handler
├── onItemResized — ResizeObserver 回调
├── scrollToIndex, scrollToBottom
└── totalHeight — spacer 总高度
```

React 渲染策略：
- 顶部 spacer：`height = startOffset`（已滚出视口的总高度）
- 中间：仅渲染 `visibleRange` 内的消息（`overscan=5`）
- 底部 spacer：`height = totalHeight - endOffset`
- 每个 `data-msg-id` 行由 ResizeObserver 测量实际高度，回写 cache

**预计效果**：DOM 节点减少 90%，滚动帧率从 45FPS → 60FPS。

### 4.3 TerminalCard xterm.js + WebGL

**问题**：纯 DOM `<div>` 逐行渲染，数千行时 DOM 爆炸。

**方案**：

```bash
npm install @xterm/xterm @xterm/addon-webgl @xterm/addon-fit @xterm/addon-search
```

```typescript
class XtermHostAdapter {
  private terminal: Terminal | null = null;
  private webglAddon: WebglAddon | null = null;
  private fitAddon: FitAddon | null = null;

  attach(container: HTMLElement): void {
    this.terminal = new Terminal({
      scrollback: 10000,
      fontSize: 13,
      fontFamily: "'JetBrains Mono', Consolas, monospace",
      allowTransparency: true,
    });
    try {
      this.webglAddon = new WebglAddon();
      this.terminal.loadAddon(this.webglAddon);
    } catch { /* 静默降级到 Canvas */ }
    this.fitAddon = new FitAddon();
    this.terminal.loadAddon(this.fitAddon);
    this.terminal.open(container);
    this.fitAddon.fit();
  }

  write(data: string): void { this.terminal?.writeln(data); }
  clear(): void { this.terminal?.clear(); }
}
```

**性能提升**：GPU 加速渲染，0 DOM 节点负担，万行日志无压力。

### 4.4 Markdown 增量块级解析器

**问题**：每次 token 全量重新 parse，流式过程中 cache miss 率 100%。

**方案**：

```
IncrementalMarkdownParser
├── push(fullText, changeOffset) → ChunkUpdate[]
├── getHtml() → string
├── _split(text, offset) → { chunks, invalidated[] }
└── _chunks: Chunk[]

Chunk: { id, type, offset, length, raw, html, version }
ChunkType: 'heading' | 'paragraph' | 'code_block' | 'list' | 'table'
```

增量策略：
1. 全文按 CommonMark 块级语法分割
2. 变更位置 `offset` 回溯到最近块边界
3. 仅重新解析受变更影响的块
4. 已闭合块（代码 fence、表格等）直接走缓存

**预期效果**：流式 parse 耗时减少 80%+。

### 4.5 Pretext 字体桥接 + whiteSpace Bug 修复

**问题**：`buildPretextFontForUiSize` 读 CSS 变量时临时修改 DOM `data-ui-size` 属性触发同步样式 recalc。

**修复**：使用 Canvas `measureText` 替代 DOM probe 来读取 font-size。同时修复 `whiteSpace: 'pre-wrap'` 未传入 `prepare()` 的 bug。

```typescript
class PretextFontBridge {
  build(role: FontRole, weight: FontWeight, sizePx?: number): string {
    const family = this.resolveFamily(role);
    const px = sizePx ?? this.resolveBaseSize();
    return `${WEIGHT_MAP[weight]} ${px}px ${family}`;
  }
  private resolveBaseSize(): number {
    // 使用 getComputedStyle(document.documentElement) 替代 DOM probe
    const size = getComputedStyle(document.documentElement).getPropertyValue('--font-size-base');
    return parseFloat(size) || 14;
  }
}

// 修复 whiteSpace 传递
// useTextMeasure.ts — 将 options 传递给 prepare()
const prepared = useMemo(() => {
  if (!text || !font) return null;
  try { return prepare(text, font, { whiteSpace: options.whiteSpace }); }
  catch { return null; }
}, [text, font, options.whiteSpace]);
```

### 4.6 DiffCard 变高虚拟滚动

**问题**：固定行高 22px，diff 行换行时低估高度。

**方案**：
- `DiffLineHeightCache` 使用 Canvas `measureText` 估算高度
- ResizeObserver 回写实际高度
- 二分查找偏移表替代固定步进
- 预计精度提升：±1px

---

## 第五部分：后端性能重构

### 5.1 Anthropic cache_control + Gemini cachedContent 注入

**问题**：`provider-cache-hints.ts` 正确生成了缓存计划，但 `OpenAICompatibleProvider.stream()` 的 HTTP 层从未消费这些计划。Anthropic 的 `cache_control` 和 Gemini 的 `cachedContent` 字段在实际发出的请求体中完全缺失。

**修复**：

```typescript
// provider-transport/anthropic-cache-injector.ts
export function injectAnthropicCacheControl(body, plan) {
  if (plan.providerFamily !== 'anthropic') return body;
  // 1. system 最后一块加 cache_control
  if (body.system?.length) {
    body.system[body.system.length - 1].cache_control = { type: 'ephemeral' };
  }
  // 2. messages 中 stable 断点
  for (const bp of plan.providerHints.explicitBreakpoints) {
    const lastUserMsg = body.messages.filter(m => m.role === 'user').pop();
    if (lastUserMsg?.content?.length) {
      lastUserMsg.content[lastUserMsg.content.length - 1].cache_control = { type: 'ephemeral' };
    }
  }
  // 3. tools 最后一块加 cache_control
  if (body.tools?.length) {
    body.tools[body.tools.length - 1].cache_control = { type: 'ephemeral' };
  }
  return body;
}

export function injectGeminiCachedContent(request, plan) {
  if (plan.providerFamily !== 'gemini' || !plan.providerHints.contextCacheCandidate) return request;
  request.cachedContent = plan.providerHints.contextCacheCandidate.cacheKey;
  return request;
}
```

**预期收益**：缓存命中率从 ~20% 提升到 ~70%，Token 成本降低 50%。

### 5.2 Shell 进程池（常驻 2 进程 + Sentinel 协议）

**问题**：每次工具调用冷启动 `powershell.exe`（150-300ms）。

**方案**：

```
ShellPool (Rust)
├── workers[2] — 常驻 2 个 PowerShell 进程
├── exec(cmd, timeout) → ShellResult
│   ├── 写入命令 + echo __SHELL_SENTINEL_END__
│   ├── 读取直到 sentinel
│   └── 超时则 kill + 恢复
├── fallback: 临时 spawn（池满时）
└── 闲置 60s 自动回收
```

Ts 侧 fallback：当 Rust 池不可用时使用 `process-executor.ts`，但增加 `CommandResultCache`（最近 5 条幂等命令缓存）。

**预期收益**：工具执行延迟从 150-300ms → < 5ms。

### 5.3 Group-Commit WAL 存储引擎

**问题**：`JsonlAppendBatcher` 串行追加 + 每次 `fsync`，写入吞吐受限。

**方案**：

```typescript
class GroupCommitWal {
  private queue: WalRecord[] = [];
  private readonly MAX_BATCH = 64;
  private readonly MAX_LATENCY_MS = 10;     // 10ms group-commit

  async append(records: WalRecord[]): Promise<void> {
    this.queue.push(...records);
    if (shouldCommitNow()) await this.commit();
    else if (!this.commitTimer) {
      this.commitTimer = setTimeout(() => this.commit(), this.MAX_LATENCY_MS);
    }
  }

  private async commit(): Promise<void> {
    const batch = this.queue.splice(0);
    // 原子写入：tmp + rename
    await writeFile(tmpPath, batch.map(encodeWalRecord).join(''));
    await fsync(tmpPath);
    await rename(tmpPath, finalPath);
  }
}
```

**预期收益**：写入吞吐提升 5-10x。

### 5.4 IPC Delta 编码 + MessagePack

**问题**：全量 `JSON.stringify` + WebSocket 协议膨胀。

**方案**：
- 键名压缩：`{ type: 'message-delta', sessionId: 'xxx' }` → `{ t: 'd', s: 'xxx' }`
- 后续同类型消息只发 delta：`{ __delta__: true, prompt: 'new text only' }`
- 可选 MessagePack 编码（体积减少 30-40%）

### 5.5 WASM Tiktoken 精确 Token 计数

**问题**：当前 `chars/4` 启发式估算，对代码密集 prompt 误差可达 ±40%。

**方案**：

```bash
npm install @dqbd/tiktoken
```

```typescript
import { Tiktoken, encodingForModel } from '@dqbd/tiktoken';

class WasmTokenEstimator implements TokenEstimator {
  private enc: Tiktoken;

  constructor(model: string) {
    this.enc = encodingForModel(model) ?? encodingForModel('gpt-4');
  }

  estimate(text: string): number {
    return this.enc.encode(text).length;
  }
}
```

**预期收益**：Token 计数精度从 ±40% 提升到 ±5%，压缩决策更精确。

### 5.6 子 Agent 稳定前缀污染修复

**问题**：`parentRunId`、`parentSessionId`、`subagentDepth` 被注入 `projectProgress`，污染 `stablePrefixHash`。

**修复**：
- 将动态 ID 移入 `volatileContext`（不参与缓存键计算）
- `renderStablePrefix` 仅保留 `baseSystemPrompt` + 静态 `policyPack`
- 对 `policyPack` 中的条目过滤所有包含 runId/sessionId 变体的内容

---

## 第六部分：交互规范与行为统一

### 6.1 Tooltip 系统统一

**问题**：100+ 原生 `title` 属性残留，自定义 Tooltip 定位闪烁、无退出动画、z-index 无效。

**修复方案**：

```typescript
// 新建 src/components/Tooltip/Tooltip.tsx
// 支持 side: 'top' | 'bottom' | 'left' | 'right'
// Portal 到 document.body（fixed 定位）
// 入场动画：cds-popover-enter (180ms spring)
// 退出动画：cds-popover-exit (120ms accel)
// 使用 useAnimatedPresence 状态机
// z-index: 9999
```

**搜索替换清单**：`App.tsx`（10 处）、`AgentCard.tsx`（13 处）、`AgentTeamBoard.tsx`（6 处）、`FilesCard.tsx`（22 处）、`ChatStatusRibbons.tsx`（11 处）、`McpSettingsTab.tsx`（11 处）等共计 100+ 处。

### 6.2 Focus Ring 对比度标准

**问题**：`focus-visible.css` 使用 `2px solid var(--accent-color)`。深色下 `--accent-color` 接近白色，对比度远超 10% 上限，过于刺眼。

**新标准**：

```css
/* tokens.css */
--focus-ring-color: color-mix(in srgb, var(--text-primary) 10%, transparent);
--focus-ring: 0 0 0 2px var(--focus-ring-color);

/* focus-visible.css */
:focus:not(:focus-visible) { outline: none; box-shadow: none; }
:focus-visible {
  outline: 2px solid var(--focus-ring-color);
  outline-offset: 2px;
}
button:focus-visible,
a:focus-visible,
[role="button"]:focus-visible {
  outline: none;
  box-shadow: var(--focus-ring);
}
```

**缺失覆盖清单**：SidebarSessionList 行内按钮、SettingsSelect 菜单项、FilesCard action btn、Dropdown item、Toast close btn、AgentCard btn 等。

### 6.3 Hover 禁止 translateY

**问题**：29 处 `translateY` 引用，含 hover 交互位移。

**规则**：
- hover/focus/active 禁止任何 `translateY` 位移
- 唯一允许的 transform 是 `scale(X)`，不超过 1.05
- 入场/出场 keyframe 中的 `translateY` 保留
- 垂直居中 `translateY(-50%)` 保留

### 6.4 ErrorBoundary 部署

**当前**：覆盖 Sidebar、Workspace、CardPanel、FilesCard。

**新增覆盖**：

| 区域 | 组件 | variant |
|------|------|---------|
| 消息列表 | ChatMessageList | compact |
| 单条消息 | ChatMessageRow | minimal |
| Composer | ChatComposer | compact |
| DiffCard | DiffCard 全部子组件 | compact |
| AgentCard | AgentCard | compact |
| 侧栏列表 | SidebarSessionList | compact |
| 设置各 Tab | SettingsPanel 内部 | compact |
| Toast | ToastStack | minimal |
| 状态横幅 | ChatStatusRibbons | minimal |

### 6.5 面板动画统一

- 所有面板使用 `useAnimatedPresence` 状态机
- 入场：spring easing，出场：standard easing
- 退出动画补全（当前 21 个面板缺少退出动画）
- 模态框背景遮罩统一：14% text-primary（light）/ 50% #000（dark）

---

## 第七部分：Agent/审批面板重构

### 7.1 AgentCard + InlineAgentPanel 统一

**问题**：两个组件各自独立维护了几乎相同的展开工具状态、ComposerField 渲染、停止按钮、审批 hook 调用。

**方案**：

```typescript
// hooks/useAgentPanel.ts — 统一 hook
interface UseAgentPanelOptions {
  parentSessionId: string;
  agentId: string;
  isRunning: boolean;
  useDaemonSync?: boolean;    // AgentCard=true, InlineAgentPanel=false
}

interface UseAgentPanelReturn {
  handleSend: (text: string) => Promise<void>;
  handleStop: (summary?: string) => void;
  incrementEpoch: () => void;
  sending: boolean;
  stopping: boolean;
  sendError: string;
  isStreaming: boolean;
  isComplete: boolean;
  startStatusSync: () => () => void;  // daemon 轮询
}
```

- 移除冗余导出：`buildPatchAsst`、`buildStreamCallbacks`、`finalizeInFlight` 变为 hook 内部闭包
- 状态轮询合并到 hook 内，通过 `useDaemonSync` flag 控制

### 7.2 审批流程增强

**状态机新增状态**：
```
idle → pending → inflight → pending_inflight → deferred
     → disconnected (新增) → reconnecting (新增) → recovered (新增)
     → timed_out (新增)
```

**超时机制**：
- 每个 `approval_pending` 设置本地 timer（从 daemon 的 `remainingMs` 获取）
- 超时自动 `deny` + UI 显示「审批超时，操作已跳过」

**断连恢复**：
- `connection_lost` → 标记所有 pending 为 `disconnected`
- `connection_restored` → 重发 pending 到 daemon + 对齐工具状态

### 7.3 `streamViaDaemon` 拆分

**当前**：580 行大函数，包含事件路由、连接、收口、审批、子 agent 广播。

**拆分为**：

| 函数 | 行数 | 职责 |
|------|------|------|
| `createStreamSession` | ~80 | 连接建立 + 消息订阅 |
| `createStreamCancel` | ~40 | 取消函数工厂 |
| `EventRouter` | ~200 | 事件路由分发 |
| `createFinishController` | ~80 | 收口控制 + 超时管理 |
| `surfaceStreamFailure` | ~30 | 错误展示 |
| `streamViaDaemon` (重组后) | ~80 | 编排以上组件 |

### 7.4 ApprovalAskCard 视觉增强

- 风险左边界：`2px → 4px`（critical 6px）
- 风险级别着色：背景 `color-mix(in srgb, var(--accent-*) X%, transparent)`
- 超时倒计时指示器：底部 2px 进度条
- `patchAgentTool` 绕过 store action 的修复 → 新增 `sessionActions.patchAgentTool` action

---

## 第八部分：实施路线图

### Phase 1 — 基础设施（无破坏性）

| 步骤 | 内容 | Agent 依赖 |
|------|------|-----------|
| 1.1 | 创建三独立 Zustand Store（sessionStore/workspaceStore/settingsUiStore） | Store Agent |
| 1.2 | 注册自动索引 subscribeWithSelector | Store Agent |
| 1.3 | 创建 `useShallowSelector` 工厂 + 批量替换 | Store Agent |
| 1.4 | 增强 `StoreTransaction`（深度拷贝 + 原子回滚） | Store Agent |
| 1.5 | 重构 `SessionRuntimeRegistry`（LRU + GC + 引用计数） | Store Agent |
| 1.6 | 创建 `design-system.css`（色阶、Elevation、Hairline、radius、动画） | UI Design Agent |
| 1.7 | 创建 `Tooltip` 统一组件 + Portal + 动画 | Interaction Agent |
| 1.8 | 创建 `StreamRenderBuffer` 类 | Render Agent |
| 1.9 | 创建 `VirtualScrollManager` 类 | Render Agent |
| 1.10 | 创建 `IncrementalMarkdownParser` 类 | Render Agent |
| 1.11 | 修复 Pretext font bridge（移除 DOM probe） | Render Agent |
| 1.12 | 创建 `GroupCommitWal` 类 | Backend Agent |
| 1.13 | 注入 `injectAnthropicCacheControl` + `injectGeminiCachedContent` | Backend Agent |
| 1.14 | 创建 `useAgentPanel` 统一 hook | Agent Agent |

### Phase 2 — 主体验证（影响面大）

| 步骤 | 内容 | 依赖 |
|------|------|------|
| 2.1 | 三 Store 播种 + 双向同步到 layoutStore（Phase 3a） | 1.1-1.4 |
| 2.2 | `StreamRenderBuffer` 集成到 `useChatStream` | 1.8 |
| 2.3 | `VirtualScrollManager` 集成到 `ChatMessageList` | 1.9 |
| 2.4 | `XtermHostAdapter` 集成到 `TerminalCard` | — |
| 2.5 | Token 替换：tokens.css 新值生效 + 全项目 radius/spacing/color 替换 | 1.6 |
| 2.6 | `design-system.css` 全项目引用替换 | 1.6 |
| 2.7 | Tooltip 100+ title 替换 | 1.7 |
| 2.8 | focus-visible + ErrorBoundary 全覆盖 | 1.7 |

### Phase 3 — 深度优化

| 步骤 | 内容 | 依赖 |
|------|------|------|
| 3.1 | 组件渐进迁移到三 Store + useShallow（Phase 3b） | 2.1 |
| 3.2 | `IncrementalMarkdownParser` 集成到 `StreamingRenderer2` | 1.10 |
| 3.3 | `GroupCommitWal` 集成到 `EventStore` | 1.12 |
| 3.4 | AgentCard + InlineAgentPanel 使用 `useAgentPanel` | 1.14 |
| 3.5 | `streamViaDaemon` 拆分 | 1.14 |
| 3.6 | 审批状态机增强 + ApprovalAskCard 视觉 | 1.14 |
| 3.7 | Shell 进程池 Rust 实现 + Ts fallback | — |

### Phase 4 — 遗留清理

| 步骤 | 内容 | 依赖 |
|------|------|------|
| 4.1 | 删除旧 facade 代码（Phase 3c） | 3.1 |
| 4.2 | 删除 `layoutStore.ts` 中被拆分出去的域（Phase 4） | 3.1 |
| 4.3 | 删除 `storeAccess.ts` 降级路径 | 3.1 |
| 4.4 | `initStoreAccess` + `bootstrapStores` 清理 | 3.1 |

---

## 附录：关键指标与预期收益

| 指标 | 当前 | 重构后 | 提升幅度 |
|------|------|--------|---------|
| Store 重渲染 | 跨域全部触发 | 仅本域窄 selector | 减少 60%+ |
| 流式渲染 FPS | 20-30 | 55-60 | 2-3x |
| 消息列表 DOM 节点 | 4000+ | ~200 | 20x |
| TerminalCard 行数上限 | 无限（DOM 爆炸） | 10000（xterm 缓冲区） | 无限可扩展 |
| Markdown parse 耗时 | 全量 10-20ms | 增量 1-3ms | 5-10x |
| Anthropic cache hit rate | ~20% | ~70% | 3.5x |
| Shell 工具执行延迟 | 150-300ms | <5ms | 30-60x |
| 存储写入吞吐 | 串行 1x | 批量 5-10x | 5-10x |
| Tooltip 系统 | 100+ title 残留 | 100% 统一组件 | 100% 覆盖 |
| Focus 对比度 | 超 10% | 严格 8-10% | 合规 |
| ErrorBoundary 覆盖 | 4 个区域 | 16 个区域 | 4x |
| 代码重复 | AgentCard 2 份 | 1 份 hook | 50% |
