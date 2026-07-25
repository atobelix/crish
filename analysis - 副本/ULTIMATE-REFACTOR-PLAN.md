# Crish 前端系统性终极重构方案

> 基于 8 个专业 Agent 的深度分析与参考研究（VS Code / Obsidian / Linear / DnD Kit / React Grid Layout / react-resizable-panels）
> 覆盖 4 大类 12 个具体缺陷，12 份分析文档 + 参考源码支撑
> 生成日期：2026-07-22

---

## 目录

1. [综合根因矩阵](#1-综合根因矩阵)
2. [架构总纲：六层统一架构](#2-架构总纲六层统一架构)
3. [Round 1：冻结基础设施（P0）](#3-round-1冻结基础设施p0)
4. [Round 2：虚拟滚动加固（P0）](#4-round-2虚拟滚动加固p0)
5. [Round 3：列宽拖拽 Pointer 加固（P0）](#5-round-3列宽拖拽-pointer-加固p0)
6. [Round 4：Tab 拖拽统一浮层架构（P1）](#6-round-4tab-拖拽统一浮层架构p1)
7. [Round 5：CSS 架构重组与性能优化（P1）](#7-round-5css-架构重组与性能优化p1)
8. [Round 6：ResizeObserver 全局管理（P1）](#8-round-6resizeobserver-全局管理p1)
9. [Round 7：拖拽指示器样式现代化（P2）](#9-round-7拖拽指示器样式现代化p2)
10. [Round 8：布局持久化与嵌套布局（P2）](#10-round-8布局持久化与嵌套布局p2)
11. [Round 9：回归测试与性能基准（P2）](#11-round-9回归测试与性能基准p2)
12. [附录 A：文件修改索引](#附录-a文件修改索引)
13. [附录 B：参考项目清单](#附录-b参考项目清单)
14. [附录 C：验证清单总表](#附录-c验证清单总表)

---

## 1. 综合根因矩阵

### 1.1 四类问题汇总

| 问题域 | 严重度 | Agent 覆盖 | 根因简述 |
|--------|--------|-----------|---------|
| **A. 消息重复** | Critical | Agent-01 | clearHeights 时序 + VirtualScrollManager.syncOrder 滞后 + React StrictMode 双调用 |
| **B. 列宽拖拽卡顿** | High | Agent-02, Agent-06 | Pointer Capture 在 iframe 边界丢失；ResizeObserver 拖拽期间未被挂起；CSS contain 缺失 |
| **C. 窗口 Resize/Move 无冻结** | High | Agent-03, Agent-08 | resize handler 未调 beginLayoutInteraction；move 完全无监听；useResizeFreeze 11 个冗余 MutationObserver |
| **D. Tab 拖拽指示器错位** | High | Agent-04, Agent-05, Agent-07 | DOM splice 破坏布局 + 静态快照碰撞检测 + 跨列/同列两种矛盾模式 + CSS 变量 fallback 失效 |

### 1.2 根因链汇总（8 个 Agent 统一结论）

```
P0 级根因（立即修复，影响核心功能）：
┌────────────────────────────────────────────────────────────┐
│ R01: App.tsx window.resize 未调用 beginLayoutInteraction   │
│      → isLayoutFrozen=false → 11 个 ResizeObserver 持续执行  │
│      → 列宽拖拽/窗口移动时 ChatMessageList/FilesCard 持续测量 │
├────────────────────────────────────────────────────────────┤
│ R02: 窗口移动（titlebar drag）完全无冻结信号                 │
│      → 不触发 window.resize → 无 body class → 无 isLayoutFrozen │
│      → 全部动画/ResizeObserver 在窗口移动时持续触发          │
├────────────────────────────────────────────────────────────┤
│ R03: useResizeFreeze 11 个独立 MutationObserver            │
│      → 每个 Consumer 独立观测 body class 变更               │
│      → 内存浪费 + 解冻延迟不一致 + 不响应 isLayoutFrozen 状态 │
├────────────────────────────────────────────────────────────┤
│ R04: shell-dragdrop.css 未屏蔽 iframe/webview pointer-events│
│      → 拖拽时指针滑入 iframe 区域 → pointermove 丢失        │
│      → 与 VS Code 的 iframe 屏蔽策略差距明显                │
├────────────────────────────────────────────────────────────┤
│ R05: VirtualScrollManager.syncOrder 在 useLayoutEffect      │
│      补偿之后执行                                           │
│      → 时序竞争：锚点补偿时 manager 的 order 未同步         │
│      → React StrictMode 双调用放大此问题                    │
└────────────────────────────────────────────────────────────┘

P1 级根因（短期修复，影响用户体验）：
┌────────────────────────────────────────────────────────────┐
│ R06: Tab 拖拽使用 DOM splice + placeholder 破坏布局        │
│      → dragOver 时 splice 插入元素 → 卡片物理位置偏移      │
│      → 碰撞检测仍用静态快照坐标 → 指示器与实际落点偏差      │
│      → DnD Kit 等现代方案均使用纯视觉浮层，不碰 DOM 结构    │
├────────────────────────────────────────────────────────────┤
│ R07: CardPanel.tsx 独立 dockOverlayStyle + 黑色虚线边框     │
│      → 同列内拖拽使用绝对定位叠加层，样式由组件内联计算     │
│      → CSS 变量 fallback 失效时呈现黑色背景 + 虚线边框     │
│      → 暗色主题下视觉灾难                                   │
├────────────────────────────────────────────────────────────┤
│ R08: placeholder-card-group ::before/::after 双分块         │
│      → 伪元素硬编码 Header/Body 框，复用大容器时未隐藏      │
│      → 创建新列预览时显示"两个分块"                        │
├────────────────────────────────────────────────────────────┤
│ R09: CSS 全局与 Modules 双体系冲突，300+ !important 扩散    │
│      → shell-workspace.css 与 Workspace.module.css 同名覆盖 │
│      → !important 作为紧急修补手段持续堆积                  │
└────────────────────────────────────────────────────────────┘

P2 级根因（中期优化，影响代码质量和维护性）：
┌────────────────────────────────────────────────────────────┐
│ R10: 11 个 ResizeObserver 实例各自独立，无统一挂起管理     │
│      → 仅 4 个接入 isLayoutFrozen，7 个无条件执行          │
│      → 拖拽期间 ChatMessageList/FilesCard/TerminalCard 持续测量│
├────────────────────────────────────────────────────────────┤
│ R11: CSS contain 仅 9 处使用，远低于应有 30+ 处            │
│      → 布局变化传播全页面 → 大范围重排                     │
│      → VS Code 在每个分支节点都使用 contain: strict         │
├────────────────────────────────────────────────────────────┤
│ R12: useBubbleShrinkWidth 持续触发 ~1573 次强制同步重排    │
│      → 每次 React commit 阶段测量父容器宽度                │
│      → 严重影响拖拽/动画帧率                               │
└────────────────────────────────────────────────────────────┘
```

### 1.3 8 个 Agent 的独特发现（未在原始提议中覆盖）

| Agent | 独到发现 | 原始提议是否覆盖 |
|-------|---------|----------------|
| 01 | clearHeights 实际受会话切换守卫保护；真正风险在 syncOrder 滞后于 useLayoutEffect 补偿；React StrictMode 双调用暴露时序问题 | 原始提议认为是 clearHeights 直接导致 |
| 02 | VS Code 不使用全局遮罩层而使用 CSS cursor overlay + iframe 显式禁用；建议提取共用 resize 逻辑为 hook | 原始提议未提及 VS Code 具体策略 |
| 03 | useWindowControls.ts 是死代码含重复 resize 监听；建议创建 WindowResizeBridge 服务统一 Tauri + Web 事件 | 原始提议仅提及 Tauri onMoved |
| 04 | DOM splice 导致反直觉的"正反馈循环"：指示器偏差 → 用户调整 → 更多 splice → 更大偏差；跨列/同列可统一为纯视觉方案 | 原始提议已指出但方案不够具体 |
| 05 | CSS 变量 fallback 失效根因：React inline style 不经过 CSS 变量作用域保护层；建议创建拖拽专用 token | 原始提议未深入 CSS 变量层面 |
| 06 | VS Code SerializableGrid 布局序列化 + IView 约束接口（minimumSize/maximumSize/priority/snap）可直接应用到 Crish | 原始提议未提及约束接口 |
| 07 | DnD Kit 五区域碰撞检测（左右边缘/标签栏/上下20%/中心60%安全区）+ 级联策略可解决 Crish 所有碰撞场景 | 原始提议仅提出"实时碰撞" |
| 08 | 发现 useBubbleShrinkWidth 1573 次强制重排 + CSS contain 仅9处 + 300+ !important | 原始提议完全未覆盖性能审计 |

---

## 2. 架构总纲：六层统一架构

### 2.1 架构分层

```
┌──────────────────────────────────────────────────────────────────┐
│ Layer 0: CSS Token System (shell-tokens.css / tokens.css)         │
│   └── 所有拖拽/布局/动画 token 统一管理，零 fallback 依赖        │
├──────────────────────────────────────────────────────────────────┤
│ Layer 1: Global Freeze Service (WindowResizeBridge)               │
│   └── 统一管理窗口 resize/move/拖拽的冻结信号                   │
│   └── 所有 ResizeObserver 通过此服务挂起                        │
├──────────────────────────────────────────────────────────────────┤
│ Layer 2: Drag Infrastructure (DragOverlayContext + Sensors)       │
│   └── 全局浮层 Portal + 统一碰撞检测 + iframe 屏蔽              │
│   └── 纯视觉指示器，拖拽期间绝不修改文档流                     │
├──────────────────────────────────────────────────────────────────┤
│ Layer 3: Layout Engine (CrishGrid / SplitView / Sash)             │
│   └── 树状嵌套布局 + 约束系统 + 序列化                         │
├──────────────────────────────────────────────────────────────────┤
│ Layer 4: Virtual Scroll Manager (VirtualScrollManager v2)         │
│   └── 以 msg.id 为唯一键 + 防御性 syncOrder + debug 模式        │
├──────────────────────────────────────────────────────────────────┤
│ Layer 5: Component Layer (React Components)                       │
│   └── 纯展示 + 逻辑通过 hooks 注入                               │
│   └── CSS Modules + BEM 命名，零 !important                      │
└──────────────────────────────────────────────────────────────────┘
```

### 2.2 数据流总图

```
                              ┌─────────────┐
                              │  Tauri API  │
                              │ onResize    │
                              │ onMoved     │
                              └──────┬──────┘
                                     │
                              ┌──────▼──────┐
     ┌────────────────────────┤ WindowResize│◄──────── window.resize (fallback)
     │                        │ Bridge      │
     │                        └──────┬──────┘
     │                               │ beginLayoutInteraction
     │                               ▼
     │                     ┌───────────────────┐
     │                     │ layoutAnimation   │
     │                     │ Store             │
     │                     │ isLayoutFrozen    │
     │                     └────────┬──────────┘
     │                              │
     │            ┌─────────────────┼──────────────────┐
     │            ▼                 ▼                   ▼
     │   ┌──────────────┐  ┌──────────────┐  ┌────────────────┐
     │   │ResizeObserver│  │useResize     │  │shell-dragdrop  │
     │   │Manager       │  │Freeze (订阅) │  │.css (contain)  │
     │   │(单例)        │  │             │  │                │
     │   └──────────────┘  └──────────────┘  └────────────────┘
     │
     │                        ┌─────────────┐
     │   ┌────────────────────┤ DragOverlay │◄──────── pointermove
     │   │                    │ Context     │
     │   │                    └──────┬──────┘
     │   │                           │
     │   │            ┌──────────────┼──────────────────┐
     │   │            ▼              ▼                   ▼
     │   │   ┌──────────────┐ ┌──────────────┐ ┌────────────────┐
     │   │   │Collision     │ │DropIndicator│ │iframe Pointer  │
     │   │   │Detection     │ │Layer        │ │Disabler        │
     │   │   └──────────────┘ └──────────────┘ └────────────────┘
     │   │
     │   │                     ┌──────────────┐
     │   └─────────────────────┤ VirtualScroll│
     │                         │ Manager v2   │
     │                         │ syncOrder    │
     │                         │ clear (守卫) │
     │                         └──────────────┘
     │
     │                     ┌──────────────────┐
     │                     │ CrishLayoutStore │
     │                     │ SerializableGrid │
     │                     └──────────────────┘
```

### 2.3 9 个 Round 的总览

| Round | 优先级 | 参与 Agent | 核心目标 | 影响问题 |
|-------|--------|-----------|---------|---------|
| R1 | P0 | A03, A02, A08 | 冻结基础设施 + C/B 类问题根除 | R01, R02, R03, R04 |
| R2 | P0 | A01 | 虚拟滚动加固 | R05, A 类消息重复 |
| R3 | P0 | A02, A06 | 列宽拖拽 Pointer 加固 | B 类卡顿根除 |
| R4 | P1 | A04, A05, A07 | Tab 拖拽统一浮层 | R06, R07, R08, D 类问题 |
| R5 | P1 | A08, A05 | CSS 架构重组 | R09, R11 |
| R6 | P1 | A03, A08 | ResizeObserver 全局管理 | R10, R12 |
| R7 | P2 | A05, A07 | 拖拽指示器样式现代化 | D 类样式残留 |
| R8 | P2 | A06, A04 | 布局持久化与嵌套布局 | 架构完善 |
| R9 | P2 | A01~A08 | 回归测试与性能基准 | 全量验证 |

---

## 3. Round 1：冻结基础设施（P0）

### 3.1 目标
解决 R01/R02/R03/R04：窗口 resize/move 无冻结、useResizeFreeze 冗余、CSS 未屏蔽 iframe

### 3.2 分配与任务

#### Agent-03（主负责）：创建 WindowResizeBridge 服务

**任务 3.3.1：新建 `src/services/WindowResizeBridge.ts`**

```
1. 架构设计：
   - 单例服务 WindowResizeBridge
   - Tauri onResize → 窗口尺寸变化
   - Tauri onMoved → 窗口移动
   - window.resize → Web fallback
   - 三个事件源统一收敛到 beginLayoutInteraction('workspace-resizing')
   
2. 核心接口：
   export class WindowResizeBridge {
     private debounceTimer: number | null = null;
     private frozen = false;
     private cleanupFns: (() => void)[] = [];
     
     // Tauri 环境
     async connectTauri(): Promise<void>
       - getCurrentWindow().onResize() → handleChange()
       - getCurrentWindow().onMoved() → handleChange()
       - try-catch 兜底（非 Tauri 环境静默失败）
     
     // Web fallback
     connectWebFallback(): void
       - window.addEventListener('resize', handleChange)
     
      // ★ 统一变化处理 + watchdog（审计 02-post-r6-freeze-drag.md H2）
      private handleChange(): void
        - if (this.frozen) return (防重入)
        - this.frozen = true
        - // ★ 使用独立类型 'window-resizing'（契约 §2）
          // 与 sash 的 'workspace-resizing' 隔离，避免误 end
        - beginLayoutInteraction('window-resizing')
        - clearTimeout(debounceTimer)
        - // ★ watchdog: 如果 5s 后仍未解冻（end 路径遗漏），强制解冻
        - watchdogTimer = setTimeout(() => {
            console.warn('[WindowResizeBridge] watchdog fired — forced thaw');
            endLayoutInteraction('window-resizing');
            this.frozen = false;
          }, 5000)
        - debounceTimer = setTimeout(() => {
            clearTimeout(watchdogTimer)
            // ★ try/finally 确保 end 路径不被遗漏
            try {
              requestAnimationFrame(() => {
                requestAnimationFrame(() => {
                  endLayoutInteraction('window-resizing')
                  this.frozen = false
                })
              })
            } catch (err) {
              console.error('[WindowResizeBridge] thaw error', err);
              endLayoutInteraction('window-resizing'); // fallback direct
              this.frozen = false;
            }
          }, 200)
     
     // 生命周期
     connect(): Promise<void>
     disconnect(): void
   }

3. 错误处理：
   - Tauri API 不可用时（非 Tauri 环境）静默降级到 Web fallback
   - onMoved 不存在时（旧版本 Tauri）跳过
   - 重复调用 connect 防重入

4. 与现有系统关系：
   - 替换 App.tsx L463-480 的手动 body class 操作
   - 替换 useWindowControls.ts 的重复 resize 监听
   - 不改变 Workspace.tsx/Sidebar.tsx 的 beginLayoutInteraction 调用（已正确）
```

**任务 3.3.2：修改 `src/App.tsx`**

```
1. 删除 L463-480 的 window.resize useEffect（只加 window-resizing class 的）
2. 在 App 挂载时调用 WindowResizeBridge.connect()
3. 在 unmount 时调用 WindowResizeBridge.disconnect()
4. 在 layoutAnimationStore.ts 中新增 'window-resizing' 类型（契约 §2）：
   const TYPE_BODY_CLASSES: Record<LayoutAnimationType, readonly string[]> = {
     'sidebar-transition': [],
     'workspace-resizing': ['resizing-active', 'is-resizing'],
     'window-resizing': ['window-resizing', 'is-resizing'],  // ← 新增独立类型
     'tab-dragging': ['dragging-card'],
     'panel-split-resizing': ['resizing-active', 'is-resizing'],
     'modal-animating': [],
   };
   // 注意：'window-resizing' 与 'workspace-resizing' 隔离
   // WindowResizeBridge 使用 'window-resizing'，sash 使用 'workspace-resizing'
   // 两者各自 begin/end，互不影响
5. 在 ActiveAnimations Set 验证中确保 'window-resizing' 被正确处理
```

**任务 3.3.3：重构 `src/hooks/useWindowControls.ts`**

```
1. 删除 L16-30 的重复 window.resize useEffect
2. 只保留 winCtl return（minimize/toggleMaximize/close）
3. 将窗口最大化/还原也触发冻结：
   - 在 win.maximize() / win.unmaximize() 前后添加 begin/endLayoutInteraction
   - 这样窗口最大化/还原动画期间也冻结布局计算
```

#### Agent-02（协）：重构 `useResizeFreeze.ts`

**任务 3.3.4：重构 `src/hooks/useResizeFreeze.ts`**

```
1. 从 MutationObserver 改为直接订阅 layoutAnimationStore：
   import { useLayoutAnimationStore } from '../store/layoutAnimationStore';
   
   export function useResizeFreeze(debounceMs?: number): { isResizing: boolean } {
     const isLayoutFrozen = useLayoutAnimationStore((s) => s.isLayoutFrozen);
     // debounceMs 参数保留但不使用（兼容 API）
     return { isResizing: isLayoutFrozen };
   }

2. 移除：
   - MutationObserver 创建和 disconnect
   - window.resize 事件监听
   - RESIZING_CLASSES 数组
   - debounce 定时器
   - 所有 classList 操作

3. 向后兼容：
   - API 签名不变：const { isResizing } = useResizeFreeze(150)
   - 所有 11 个调用点无需修改
```

**任务 3.3.5：枚举并更新所有 useResizeFreeze 调用点**

```
通过 grep 找到所有调用 useResizeFreeze 的文件：
- ChatMessageList.tsx → 确认已正确使用
- FilesCard.tsx → 确认
- TerminalCard.tsx → 确认
- ChatToolCallBlock.tsx → 确认
- VirtualList.tsx → 确认
- 其他 → 逐个确认

确保重构后 useResizeFreeze 返回 isResizing=true 的时机与之前一致：
- 之前：body class 包含 is-resizing/resizing-active/window-resizing
- 之后：layoutAnimationStore.isLayoutFrozen === true
- 两者应当一致（因为 beginLayoutInteraction 会同步 body class）
```

#### Agent-08（协）：修复 shell-dragdrop.css 的 iframe 屏蔽

**任务 3.3.6：修改 `src/styles/shell/shell-dragdrop.css`**

```
1. 在现有冻结规则后添加：
   body.is-layout-frozen iframe,
   body.is-layout-frozen webview,
   body.is-layout-frozen object,
   body.is-layout-frozen embed {
     pointer-events: none !important;
   }
   
   body.is-resizing iframe,
   body.is-resizing webview,
   body.is-resizing object,
   body.is-resizing embed {
     pointer-events: none !important;
   }

2. 同时添加 VS Code 风格的 JS 方案（更可靠）：
   - 在 beginLayoutInteraction 中点击遍历所有 iframe 添加 pointer-events-disabled class
   - 在 endLayoutInteraction 中移除
   - 这是因为 pointer-events: none 在 iframe 内容中可能被覆盖
   - 参考：agents/agent-02/vscode-sash.ts 的 disableIframePointerEvents 实现

3. 验证方法：
   - 在 Workspace 中嵌套一个 iframe 测试页
   - 拖拽列分割线，快速滑过 iframe 区域
   - 确认 pointermove 持续触发，拖拽不中断
```

### 3.3 Round 1 验证清单

```
[ ] WindowResizeBridge 在 Tauri 环境下正确连接 onResize/onMoved
[ ] WindowResizeBridge 在非 Tauri 环境降级到 window.resize
[ ] App.tsx 窗口 resize 后 isLayoutFrozen=true
[ ] App.tsx 窗口 resize 停止 200ms 后 isLayoutFrozen=false
[ ] 窗口移动时不触发 window.resize 但仍 isLayoutFrozen=true
[ ] 窗口移动停止 200ms 后 isLayoutFrozen=false
[ ] useResizeFreeze 重构后返回与之前一致的 isResizing 值
[ ] 所有 11 个 useResizeFreeze 调用点正常工作
[ ] 拖拽列分割线滑入 iframe 区域不中断
[ ] useWindowControls.ts 无重复 resize 监听
[ ] 窗口最大化/还原也触发冻结
```

---

## 4. Round 2：虚拟滚动加固（P0）

### 4.1 目标
解决 R05：syncOrder 时序 + clearHeights 守卫 + React StrictMode 兼容

### 4.2 分配与任务

#### Agent-01（主负责）：VirtualScrollManager v2

**任务 4.2.1：增强 `src/api/VirtualScrollManager.ts`**

```
1. 增加 debug 模式：
   constructor(fallbackHeight?: number, debug = false)
   private log(...args: unknown[]): void
   private warn(...args: unknown[]): void
   
   在关键操作点记录：
   - syncOrder: ids.length, firstDiff, order.length before/after
   - clear: heights.size, order.length, console.trace()
   - getHeightAt: index, id, height value
   - computeVisibleRange: scrollTop, viewport, startIndex, endIndex

2. 增加 generation 机制 + clear() 空状态跳过（修复审计 01-post-r6-list.md M4）：
   //
   // 问题：clear() 同步清空后，旧会话的 rAF setActual 仍可能写入 heights Map
   // 解决：引入 generation 计数器，setActual 只接受当前 generation 的写入
   //
   private generation = 0;
   
   getGeneration(): number { return this.generation; }
   
   clear(): void {
     const hadData = this.order.length > 0 || this.heights.size > 0;
     if (!hadData) {
       this.log('[VSM] clear() skipped — already empty');
       return;
     }
     this.log(`[VSM] clear() — order=${this.order.length}, heights=${this.heights.size}`);
     if (this.debug) console.trace('[VSM] clear() call stack');
     this.order = [];
     this.idToIndex.clear();
     this.heights.clear();
     this.offsetsCache = null;
     this.dirtyFrom = undefined;
     this.generation++; // 每次 clear 递增 generation
   }
   
   // setActual 增加 generation 校验
   setActual(id: string, height: number, callerGeneration?: number): void {
     if (callerGeneration !== undefined && callerGeneration !== this.generation) {
       this.log(`[VSM] setActual("${id}") ignored — generation mismatch`);
       return;
     }
     // ... 原有逻辑
   }

3. syncOrder 增加长度二次校验：
   syncOrder(ids: string[]): void {
     // 防御：如果 ids 为空数组但 order 非空，发出警告
     if (ids.length === 0 && this.order.length > 0) {
       this.warn('[VSM] syncOrder called with empty ids while order non-empty');
     }
     // 防御：如果 order 长度与之前差距过大（如从 100 到 0 再到 100），
     // 可能是 clear + syncOrder 时序问题
     if (this.order.length === 0 && ids.length > 10) {
       this.log(`[VSM] syncOrder recovering from empty order: ${ids.length} items`);
     }
     // ... 现有逻辑
   }

4. getHeightAt 增加 order 为空时的 fallback：
   getHeightAt(index: number): number {
     if (this.order.length === 0) {
       this.warn(`[VSM] getHeightAt(${index}) called with empty order, using fallback`);
       return this.fallbackHeight;
     }
     // ... 现有逻辑，但防御 index 越界
     if (index < 0 || index >= this.order.length) {
       this.warn(`[VSM] getHeightAt(${index}) out of range [0, ${this.order.length})`);
       return this.fallbackHeight;
     }
     const id = this.order[index];
     return this.getHeight(id);
   }

5. computeVisibleRange 增加 order 为空时的早期返回：
   computeVisibleRange(scrollTop, viewportHeight, itemCount, overscan): VisibleRange {
     if (this.order.length === 0 || itemCount === 0) {
       return { startIndex: 0, endIndex: 0, startOffset: 0, estimatedTotalHeight: 0 };
     }
     if (this.order.length !== itemCount) {
       this.warn(`mismatch: order.length=${this.order.length} vs itemCount=${itemCount}`);
     }
     // ... 现有逻辑
   }
```

**任务 4.2.2：修改 `src/components/ChatMessageList.tsx`**

```
1. 确认 clearHeights 的守卫逻辑已正确：
   - 当前 L575-579 的会话切换检测是否充分
   - 添加额外防御：clearHeights 前记录日志
   - 确保不应在其他路径被调用

2. ★ 修复 syncOrder 时序（审计 01-post-r6-list.md H1）：
   - 问题：syncOrder 在 useEffect（paint 后），锚点补偿在 useLayoutEffect（paint 前）
   - 首帧 itemCount 已更新但 order 未同步 → getHeightAt 对超界 index 返回 fallback
   - 解决方案：**将 syncOrder 升为 useLayoutEffect**
   
   在 `useVirtualScroll.ts` 中：
   ───────────────────────────────────────────────
   // 原代码（useEffect）：
   useEffect(() => { manager.syncOrder(ids); }, [manager, ids]);
   
   // 改为（useLayoutEffect）：
   useLayoutEffect(() => { manager.syncOrder(ids); }, [manager, ids]);
   ───────────────────────────────────────────────
   注意：useLayoutEffect 在 StrictMode 下执行两次，syncOrder 的前缀相等检测会跳过第二次

3. 在锚点补偿中添加时序守卫（双重保护）：
   ───────────────────────────────────────────────
   useLayoutEffect(() => {
     // 会话切换：清空高度（clearHeights 受 activeSessionId 守卫保护，不能删除）
     if (prevSessionIdForHeightsRef.current !== activeSessionId) {
       prevSessionIdForHeightsRef.current = activeSessionId;
       clearHeights();
       prevVisibleIdsRef.current = visibleIds;
       return;
     }
     
     const el = containerRef.current;
     if (!el || prevIds.length === 0 || nextIds.length === 0) return;
     
     // ★ 时序守卫：如果 order 尚未同步，跳过锚点补偿
     if (manager.order.length === 0) {
       prevVisibleIdsRef.current = nextIds;
       return;
     }
     
     // ★ generation 守卫：如果会话已切换（旧 rAF setActual 回填），跳过补偿
     if (manager.generation !== expectedGenerationRef.current) {
       prevVisibleIdsRef.current = nextIds;
       return;
     }
     
     // 锚点补偿逻辑...
   }, [activeSessionId, visibleIds, clearHeights, containerRef, manager]);
   ───────────────────────────────────────────────

4. 将 prevVisibleIdsRef 的更新移到 useLayoutEffect 末尾：
   - 当前：在会话切换分支中提前更新（L578）
   - 应确保：在所有 return 之前都更新 prevVisibleIdsRef
```

**任务 4.2.3：修改 `src/hooks/useVirtualScroll.ts`**

```
1. 确保 syncOrder 在必要时重新触发：
   - 当前：useEffect 依赖 [ids, manager]
   - ids 是字符串数组（visibleIds），每次 visibleMessages 变化时重新创建
   - 如果 visibleIds 引用未变（useMemo 缓存命中），不会触发 syncOrder
   - 这是正确的优化，不应修改
   
2. 增加 fallback 机制：
   - 如果 computeVisibleRange 返回异常值（startIndex > endIndex 等）
   - 强制重新 syncOrder 并重试
   
3. heightTick 机制分析：
   - 当前：heightTick 是一个递增数字，在 setEstimated/setActual/clearHeights 后递增
   - 强制重新 computeVisibleRange
   - 确认 heightTick 触发足够及时
```

**任务 4.2.4：扩展 `src/api/VirtualScrollManager.test.ts`**

```
新增测试用例：

1. 窗口平移时 clear 不调用：
   - syncOrder(['a', 'b', 'c', 'd', 'e'])
   - syncOrder(['b', 'c', 'd', 'e', 'f'])  ← 模拟窗口右移
   - 验证 order 正确更新，heights 保留 'b','c','d','e'
   - 验证无任何路径调用 clear

2. expand older 场景：
   - syncOrder(['c', 'd', 'e'])
   - 设置实际高度
   - syncOrder(['a', 'b', 'c', 'd', 'e', 'f'])  ← expand older + new
   - 验证 order 正确，高度保留

3. clear + 快速 syncOrder：
   - clear()
   - syncOrder(['a', 'b', 'c'])
   - 验证 order 正确重建

4. 空 order 的防御：
   - 不调用 syncOrder，直接 getHeightAt(0)
   - 预期返回 fallbackHeight，不抛异常
   - 不调用 syncOrder，直接 computeVisibleRange(0, 600, 10, 5)
   - 预期返回 {startIndex:0, endIndex:0, startOffset:0, estimatedTotalHeight:0}

5. itemCount 与 order.length 不匹配：
   - syncOrder(['a', 'b', 'c'])
   - computeVisibleRange(0, 600, 5, 5)  ← itemCount=5 但 order=3
   - 预期：发出警告但仍正确计算（以 itemCount 为准？或 order 为准？）
   - 决定：以 order.length 为准，发出警告

6. React StrictMode 双调用的防御：
   - 模拟两次连续的 syncOrder(相同ids)
   - 验证第二次被 same 检测跳过
   - 模拟两次连续的 clear()
   - 验证第二次被 hadData 检测跳过

7. 大量消息的基准性能：
   - 1000 条消息
   - 模拟窗口平移
   - 验证 computeVisibleRange 在 1ms 内
   - 验证 syncOrder 在 5ms 内
```

### 4.3 Round 2 验证清单

```
[ ] 发送新消息后无重复消息出现
[ ] 快速连续发送 10 条消息，列表平滑追加
[ ] expand older 后滚动位置正确
[ ] 会话切换后高度完全重建
[ ] 窗口平移时高度缓存保留
[ ] React StrictMode 下无异常
[ ] 空 order 状态下 getHeightAt 返回 fallback
[ ] 测试全部通过
[ ] debug 模式可输出完整调用链
```

---

## 5. Round 3：列宽拖拽 Pointer 加固（P0）

### 5.1 目标
解决 R04 和 B 类卡顿：iframe 指针丢失、全局光标覆盖、layoutAnimationStore 超时保护

### 5.2 分配与任务

#### Agent-02（主负责）：Workspace.tsx 拖拽加固

**任务 5.2.1：创建全局隐形遮罩层工具函数**

```
新建 src/utils/dragOverlay.ts：

export function createDragOverlay(container: HTMLElement): HTMLElement {
  // 创建覆盖全视口的透明遮罩层
  const overlay = document.createElement('div');
  overlay.className = 'global-drag-overlay';
  overlay.style.cssText = `
    position: fixed;
    top: 0; left: 0; right: 0; bottom: 0;
    z-index: 99999;
    cursor: ${container.style.cursor || 'col-resize'};
    pointer-events: auto;
  `;
  // 添加数据属性标记，便于 CSS 选择器
  overlay.setAttribute('data-drag-overlay', 'true');
  document.body.appendChild(overlay);
  return overlay;
}

export function removeDragOverlay(overlay: HTMLElement | null): void {
  if (overlay && overlay.parentNode) {
    overlay.parentNode.removeChild(overlay);
  }
}

// VS Code 风格的 iframe 指针禁用
export function disableIframePointerEvents(): () => void {
  const iframes = document.querySelectorAll('iframe, webview, object, embed');
  const restoreFns: (() => void)[] = [];
  
  iframes.forEach((el) => {
    if (el instanceof HTMLElement) {
      const original = el.style.pointerEvents;
      el.style.pointerEvents = 'none';
      restoreFns.push(() => { el.style.pointerEvents = original; });
    }
  });
  
  return () => restoreFns.forEach(fn => fn());
}
```

**任务 5.2.2：重构 `Workspace.tsx` 的 handleColResizerPointerDown**

```
将 handleColResizerPointerDown 修改为：

handleColResizerPointerDown(e, colIdx):
  1. e.preventDefault(), focusThisWorkspace()
  2. 获取 DOM 引用 (splitterEl, canvasEl, colLeftEl, colRightEl)
  3. 拍摄起始快照 (startX, containerWidth, startLeft, colLeftRatio, colRightRatio)
  4. splitterEl.classList.add('active')
  5. beginLayoutInteraction('workspace-resizing')
  6. document.body.style.cursor = 'col-resize'
  
  // ★ 新增：全局遮罩层 + iframe 禁用
  7. const overlay = createDragOverlay(canvasEl)
  8. const restoreIframes = disableIframePointerEvents()
  
  // ★ 新增：遮罩层上注册 pointermove（替代 window 监听）
  9. const handlePointerMove = (moveEvent: PointerEvent) => {
       // ... 与之前相同的 ratio 计算
       colLeftEl.style.width = ...
       colRightEl.style.width = ...
       splitterEl.style.left = ...
     }
  10. overlay.addEventListener('pointermove', handlePointerMove)
  
   11. ★ 修复：endResize 使用 try/finally 确保永远解冻（审计 02-post-r6-freeze-drag.md H2）
    const endResize = (upEvent: PointerEvent) => {
        if (ended) return; ended = true
        
        try {
          // ★ 使用遮罩层事件移除
          overlay.removeEventListener('pointermove', handlePointerMove)
          window.removeEventListener('pointerup', endResize)
          window.removeEventListener('pointercancel', endResize)
          
          // ★ 清理遮罩层和 iframe 恢复
          removeDragOverlay(overlay)
          restoreIframes()
          
          splitterEl.classList.remove('active')
          const dx = upEvent.clientX - startX
          resizeColumns(ws.id, colIdx, dx, containerWidth)
          colLeftEl.style.width = ''
          colRightEl.style.width = ''
          splitterEl.style.left = ''
          
          // 双重 rAF 解冻
          requestAnimationFrame(() => {
            requestAnimationFrame(() => {
              endLayoutInteraction('workspace-resizing')
              document.body.style.cursor = ''
            })
          })
        } catch (err) {
          // 异常时也必须解冻，防止永久 frozen
          console.error('[useColumnResize] endResize error', err)
          endLayoutInteraction('workspace-resizing')
          document.body.style.cursor = ''
          removeDragOverlay(overlay)
        }
      }
  
  12. window.addEventListener('pointerup', endResize)
  13. window.addEventListener('pointercancel', endResize)

对 handleGroupResizerPointerDown 做相同改造
（垂直方向：overlay cursor 改为 row-resize，pointermove 处理 dy）
```

**任务 5.2.3：提取共用逻辑为 hook `useColumnResize`**

```
新建 src/hooks/useColumnResize.ts：

export function useColumnResize(wsId: string) {
  return {
    handleColResizerPointerDown: (e, colIdx) => { /* 以上逻辑 */ },
    handleGroupResizerPointerDown: (e, colIdx, groupIdx) => { /* 垂直版本 */ },
  };
}

这样 Workspace.tsx 的 resizer 逻辑从 ~120 行减为 ~20 行。
```

#### Agent-06（协）：从 VS Code 提取 CSS 光标覆盖策略

**任务 5.2.4：实现 VS Code 风格的 CSS 光标覆盖**

```
参考 VS Code sash.ts 的 createGlobalStyleSheet 方法：

// 在 dragOverlay.ts 中添加
export function createGlobalCursorStyle(cursor: string): HTMLStyleElement {
  const style = document.createElement('style');
  style.id = 'global-drag-cursor';
  style.textContent = `* { cursor: ${cursor} !important; }`;
  document.head.appendChild(style);
  return style;
}

export function removeGlobalCursorStyle(style: HTMLStyleElement | null): void {
  if (style && style.parentNode) {
    style.parentNode.removeChild(style);
  }
}

// 在 Workspace.tsx 中结合使用：
// handleColResizerPointerDown 中：
const cursorStyle = createGlobalCursorStyle('col-resize');
// endResize 中：
removeGlobalCursorStyle(cursorStyle);
```

### 5.3 Round 3 验证清单

```
[ ] 列宽拖拽 60fps 流畅跟手（用 Chrome DevTools Performance 验证）
[ ] 拖拽滑入 iframe 区域不中断
[ ] 拖拽滑入 webview 区域不中断
[ ] 右键菜单弹出后拖拽恢复
[ ] 全局遮罩层在拖拽结束时正确移除
[ ] iframe pointer-events 在拖拽结束后正确恢复
[ ] 列宽拖拽 + 组高拖拽同时工作
[ ] 双重 rAF 解冻机制正常
[ ] useColumnResize hook 提取后 Workspace.tsx 减少 ~100 行
```

---

## 6. Round 4：Tab 拖拽统一浮层架构（P1）

### 6.1 目标
解决 R06/R07/R08：废弃 DOM splice、实时碰撞检测、统一纯视觉指示器

### 6.2 分配与任务

#### Agent-04（主负责）：核心架构改造

**任务 6.2.1：新建 `src/components/DropIndicatorLayer.tsx`**

```
全局拖拽指示器浮层组件：

<DropIndicatorLayer wsId={wsId}>
  └── 通过 createPortal 渲染到 document.body
  └── position: fixed, pointer-events: none
  └── 根据 dropPreview 状态渲染：
    ├── type === 'insert-col-left' → 竖线指示器（列左侧边缘）
    ├── type === 'insert-col-right' → 竖线指示器（列右侧边缘）
    ├── type === 'insert-group-top' → 横线指示器（组上方）
    ├── type === 'insert-group-bottom' → 横线指示器（组下方）
    ├── type === 'merge-to-group' → 卡片高亮（合并区）
    ├── type === 'new-col-right' → 半透明列预览框
    └── type === 'new-col-left' → 半透明列预览框（仅第一列左侧）

Props:
  - wsId: string
  - dropPreview: DropPreviewState | null (from layoutStore)
  
样式：
  - 所有指示器使用 CSS 变量 --accent-color
  - 竖线：3px 宽，圆角，发光 shadow
  - 横线：3px 高，圆角，发光 shadow
  - 合并/拆分区域：半透明背景 + 1.5px 边框 + backdrop-filter: blur(2px)
  - 列预览框：与现有列相同尺寸轮廓 + 半透明填充
  - 所有指示器带 transition: opacity 0.15s, transform 0.15s（避免闪烁）
```

**任务 6.2.2：重构 `src/hooks/useTabDrag.ts`**

```
核心改造：

1. 废弃 cardSnapshots 静态快照
   - 删除 dragStart 中的 cardSnapshots 采集
   - 删除所有依赖 cardSnapshots 的碰撞检测代码

2. 实时碰撞检测（DnD Kit 启发）
   - 在 dragOver（pointermove）中：
     a. ★ rAF 节流（审计 02-post-r6-freeze-drag.md M3）：
        // 每次 pointermove 都 querySelectorAll + getBoundingClientRect 在卡片多时
        // 可能造成性能问题。使用 rAF 节流合并同一帧内的多次 pointermove。
        let rafPending = false;
        const handlePointerMove = (e: PointerEvent) => {
          if (rafPending) return;
          rafPending = true;
          requestAnimationFrame(() => {
            rafPending = false;
            performCollisionDetection(e.clientX, e.clientY);
          });
        };
     b. ★ wsId 作用域限定（审计 02-post-r6-freeze-drag.md H1）：
        // 多拆分工作区时，hit-test 必须限定在当前 wsId 内
        // 使用 [data-ws-id="${wsId}"] 作为根选择器
        const scope = `[data-ws-id="${wsId}"]`;
        const cardElements = document.querySelectorAll(
          `${scope} .workspace-card:not(.placeholder-card-group)`
        );
        // 跨 ws 清空 preview / 禁 commit
     c. 遍历每张卡片调用 getBoundingClientRect() → 实时坐标
     d. 使用五区域级联碰撞检测：
        Level 1: exactHit — 指针是否在卡片区域内
        Level 2: nearestWithinThreshold — 最近卡片且距离 < 阈值 (20px)
        Level 3: edgeDetection — 取左右/上下边缘最近的卡片
     e. 五区域判定（DnD Kit 风格）：
        ┌──────────────────────────────┐
        │  leftEdge  │       │  right  │
        │  (12.5%)   │       │  Edge   │
        ├────────────┤  tab  ├────────┤
        │  top       │  bar  │  top    │
        │  (20%)     │       │  (20%)  │
        ├────────────┤       ├────────┤
        │  center (60%)      │        │
        ├────────────┤       ├────────┤
        │  bottom    │       │  bottom │
        │  (20%)     │       │  (20%)  │
        └────────────┴───────┴────────┘
        leftEdge(12.5%) → 创建新列/向左拆分
        rightEdge(12.5%) → 创建新列/向右拆分
        top(20%) → 拆分到上方
        center(60%) → 合并到标签组
        bottom(20%) → 拆分到下方
     f. ★ 大量卡片时的性能优化：如果卡片数 > 50，跳过 Level 2（closestCenter）
        直接走 Level 1 + Level 3

   3. 碰撞检测结果 → store.setDropPreview()
      - 将计算结果通过 layoutStore.setDropPreview() 更新到 store
      - DropIndicatorLayer 订阅 store 自动更新

   4. 特殊列（Chat）处理：
      - Chat 列左右额外 zone（CHAT_COL_LEFT_ZONE / CHAT_COL_RIGHT_ZONE）
      - 左侧 zone → 'split-col-left'
     - 右侧 zone → 'split-col-right'

3. 输出 dropTarget 类型（新增类型）：
   type DropTarget = {
     type: 'insert-col-left' | 'insert-col-right' 
         | 'insert-group-top' | 'insert-group-bottom'
         | 'merge-to-group'
         | 'new-col-right' | 'new-col-left';
     wsId: string;
     colIdx?: number;
     groupIdx?: number;
     rect: DOMRect;  // 用于计算指示器位置
     cardId?: string;
   };

4. 废弃的代码清理：
   - 删除 handleTabPointerDown 中的 cardSnapshots
   - 删除 dragOver 中使用 cardSnapshots 的碰撞检测分支
   - 保留 finishPointer 中的 drop 提交逻辑（这部分正确）
   - 保留 animateOverlayAway（拖拽预览动画）
```

**任务 6.2.3：重构 `src/components/Workspace.tsx`**

```
1. 废弃 L257-327 的 DOM splice 逻辑：
   - 删除 renderedColumns 中的 placeholderCol 插入
   - 删除 CardGroupState 中的 placeholderGroup 插入
   - 删除 foldLeftCol / foldRightCol 的 widthRatio 压缩
   
2. 原有的 renderedColumns 简化为纯映射：
   const renderedColumns = ws.columns.map((col, origColIdx) => ({
     ...col,
     origColIdx,
     groups: col.groups.map((g, origGroupIdx) => ({ ...g, origGroupIdx })),
   }));
   
3. 添加 DropIndicatorLayer 渲染：
   <WorkspaceContainer>
     <div className="workspace-canvas">
       {renderedColumns.map(renderColumn)}
     </div>
     <DropIndicatorLayer 
       wsId={wsId} 
       dropPreview={dropPreview} 
     />
   </WorkspaceContainer>

4. drop 执行逻辑保持不变：
   - 仍调用 layoutStore.moveCard / splitColumn
   - 仅在 drop 时一次性重排 DOM
```

#### Agent-05（协）：清理 CardPanel.tsx

**任务 6.2.4：清理 `src/components/CardPanel.tsx` 的 dockOverlayStyle**

```
1. 完全移除 dockOverlayStyle 计算：
   - 删除 showDockOverlay 条件
   - 删除 dockOverlayStyle 的 useMemo
   - 删除渲染 <div style={dockOverlayStyle}> 的 JSX
   
2. 不再需要 renderOverlayForDirection 辅助函数
3. 所有拖拽视觉效果统一由 DropIndicatorLayer 渲染
4. 保持 isTargetPanel 检测用于其他逻辑（如 tab 高亮）
```

#### Agent-07（协）：碰撞检测算法实现

**任务 6.2.5：新建 `src/utils/collisionDetection.ts`**

```
纯函数碰撞检测工具集：

1. rectIntersection(active, droppables):
   └─ DnD Kit 风格：返回指针所在的所有容器
   └─ 用于判断指针当前在哪个工作区/列

2. closestCenter(active, droppables):
   └─ 返回距指针中心最近的容器
   └─ 用于判断最近的卡片

3. closestCorners(active, droppables):
   └─ 返回距指针四角最近的容器
   └─ 用于边缘精确判定

4. fiveZoneDetection(pointer, cardRect):
   └─ 返回指针在卡片五区中的位置
   └─ leftEdge | top | center | bottom | rightEdge

5. nestedCollisionDetection(pointer, layout):
   └─ 级联检测：ws → col → group → card → fiveZone
   └─ 返回完整的 DropTarget

6. computeDropIndicatorRect(target):
   └─ 根据 DropTarget 计算指示器像素位置
   └─ 竖线：rect.left - 1.5px, width: 3px
   └─ 横线：rect.top - 1.5px, height: 3px
   └─ 合并：rect 整体高亮
   └─ 新列预览：canvas 右侧 300px 宽半透明框
```

### 6.3 Round 4 验证清单

```
[ ] 跨列拖拽时无 DOM splice，布局不闪动
[ ] 指示器位置与实际 drop 落点完全一致
[ ] 同列内上下拖拽使用统一浮层（非 dockOverlayStyle）
[ ] 创建新列预览无不存在的"双分块"
[ ] 拖拽到 Chat 列左右 zone 正确触发 split-col-left/right
[ ] 碰撞检测在快速拖拽时仍然精确
[ ] 无 cardSnapshots 静态快照依赖
[ ] Workspace.tsx 移除了 DOM splice 逻辑
[ ] CardPanel.tsx 移除了 dockOverlayStyle
[ ] 所有拖拽视觉由 DropIndicatorLayer 统一渲染
```

---

## 7. Round 5：CSS 架构重组与性能优化（P1）

### 7.1 目标
解决 R09/R11：CSS 全局与 Modules 冲突、contain 覆盖不足、!important 清除

### 7.2 分配与任务

#### Agent-08（主负责）：CSS 架构重组

**任务 7.2.1：CSS 冲突清单与修复**

```
1. 建立完整冲突清单：
   用 grep 查找同时在全局 CSS 和 .module.css 中出现的类名：
   ┌──────────────────────┬──────────────────────────┬──────────────────────┐
   │ 类名                  │ 全局 CSS 文件            │ Module CSS 文件       │
   ├──────────────────────┼──────────────────────────┼──────────────────────┤
   │ .card-header         │ shell-workspace.css      │ CardPanel.module.css │
   │ .card-tab            │ shell-workspace.css      │ CardPanel.module.css │
   │ .card-body           │ shell-workspace.css      │ CardPanel.module.css │
   │ .tabs-bar            │ shell-workspace.css      │ CardPanel.module.css │
   │ .sidebar.collapsed   │ shell-sidebar.css        │ shell-dragdrop.css   │
   │ .placeholder-card    │ shell-workspace.css      │ Workspace.module.css │
   │ .drop-indicator      │ shell-dragdrop.css       │ Workspace.module.css │
   └──────────────────────┴──────────────────────────┴──────────────────────┘

2. 修复策略：
   对每个冲突对：
   a. 确认哪个文件是"正确"的定义位置
   b. 将另一个文件中的重复定义删除
   c. 如果全局 CSS 需要引用 module CSS 的类名 → 使用 :global 包裹
   d. 如果 module CSS 需要引用全局 CSS 的类名 → 使用 :import 或组合类名
   
3. 优先级规则：
   - 组件专属样式 → 移到组件对应的 .module.css
   - 布局框架样式 → 保留在 shell-*.css 但改用 BEM 命名空间
   - 拖拽样式 → 全部统一到 shell-dragdrop.css
```

**任务 7.2.2：!important 淘汰路线图**

```
1. 统计当前 !important 使用量：
   grep -r '!important' apps/crish-desktop/src/styles/*.css | wc -l
   → 目标：从 300+ 降到 50 以下

2. 分类处理：
   ┌─────────────────────────────────────────────────────┐
   │ 类别                    │ 处理策略                    │
   ├─────────────────────────┼────────────────────────────┤
   │ 覆盖第三方库            │ 保留（如 xterm.js 样式）   │
   │ 全局 vs Module 冲突     │ 按 7.2.1 修复后移除        │
   │ 优先级不足的临时修补    │ 增加选择器特异性后移除      │
   │ 重复定义                │ 删除冗余后移除              │
   │ 合法使用（如 drag 期间）│ 保留但加注释                │
   └─────────────────────────┴────────────────────────────┘

3. 具体修复步骤：
   a. 对每个 !important，判断类别
   b. 如果是"全局 vs Module 冲突"，增加特异性后移除 !important
     例：.card-header 改为 div.card-header.shell-card-header
   c. 如果是"临时修补"，找到根因修复后移除
   d. 标记保留的 !important 加注释 /* OK: override third-party */
```

**任务 7.2.3：CSS contain 批量注入**

```
1. 审计当前 contain 使用（仅 9 处）：
   在以下容器添加 contain: strict 或 contain: layout style:
   
    ┌───────────────────────────────────────────────────────────┐
    │ 选择器                             │ contain 值           │
    ├────────────────────────────────────┼──────────────────────┤
    │ .workspace-canvas                  │ contain: layout style│ ← ⚠ 不用 strict，防裁剪 tooltip |
    │ .workspace-column                  │ contain: layout style│ ← ⚠ 不用 strict，防裁剪 tooltip |
    │ .workspace-card                    │ contain: layout style│ ← ⚠ 不用 strict，防裁剪 tooltip |
    │ .workspace-card > .card-body       │ contain: layout      │
    │ .chat-message-list                 │ contain: layout style│
    │ .chat-message-row                  │ contain: layout      │
    │ .sidebar                           │ contain: layout style│
    │ .sidebar-content                   │ contain: layout      │
    │ .sidebar-section                   │ contain: layout      │
    │ .sidebar-session-list              │ contain: layout      │
    │ .files-card                        │ contain: layout      │
    │ .files-card .file-item             │ contain: layout      │
    │ .terminal-card                     │ contain: layout      │
    │ .terminal-card .xterm              │ contain: layout      │
    │ .diff-card                         │ contain: layout      │
    │ .diff-card .diff-viewer            │ contain: layout      │
    │ .settings-panel                    │ contain: layout      │
    │ .settings-panel .settings-tab      │ contain: layout      │
    │ .overview-card                     │ contain: layout      │
    │ .overview-card .metrics-grid       │ contain: layout      │
    │ .preview-card                      │ contain: layout      │
    │ .tooltip-portal                    │ contain: strict      │
    │ .modal-overlay                     │ contain: strict      │
    │ .drop-indicator-layer              │ contain: strict      │
    │ .workspace-chrome-bars             │ contain: layout      │
    │ .chat-card                         │ contain: layout      │
    │ .chat-input-area                   │ contain: layout      │
    │ .agent-card                        │ contain: layout      │
    │ .runtime-panel                     │ contain: layout      │
    │ .toast-stack                       │ contain: layout      │
    │ .quick-open                        │ contain: layout      │
    │ .settings-overlay                  │ contain: strict      │
    │ .first-run-wizard                  │ contain: strict      │
    │ .telemetry-dialog                  │ contain: strict      │
    └────────────────────────────────────┴──────────────────────┘

    目标：从 9 处增加到 34 处

2. ★ 关键注意事项（审计 02-post-r6-freeze-drag.md + Agent-08 分析）：
   - ⚠ contain: strict = contain: layout style paint size
   - ⚠ strict 的 paint 隔离会裁剪 position: fixed/absolute 子元素
   - ⚠ .workspace-canvas / .workspace-column / .workspace-card 内部有 tooltip、下拉菜单、popover
   -   这些元素通常 position: fixed 到 document.body，但如果 CSS 未正确脱离，strict 会裁剪
   - → 解决方案：对这些容器**只使用 contain: layout style**（不含 paint 和 size）
   - → contain: layout style 隔离布局计算和计数器/列表样式，不影响绘制层
   - → 只有明确不含 fixed 子元素的容器（如 tooltip-portal、modal-overlay）使用 strict
   - contain: layout 隔离布局计算但不影响绘制
   - contain: style 隔离计数/列表样式但不影响布局
   - 不确定时优先使用 contain: layout style
```

#### Agent-05（协）：统一样式架构

**任务 7.2.4：新建拖拽专用 CSS 变量**

```
在 tokens.css 或 shell-dragdrop.css 中添加：

:root {
  /* Drag & Drop Indicator Tokens */
  --dnd-merge-bg: color-mix(in srgb, var(--accent-color) 8%, transparent);
  --dnd-merge-border: color-mix(in srgb, var(--accent-color) 30%, transparent);
  --dnd-merge-border-width: 1.5px;
  --dnd-merge-radius: var(--radius-md);
  --dnd-split-bg: color-mix(in srgb, var(--accent-color) 6%, transparent);
  --dnd-split-border: color-mix(in srgb, var(--accent-color) 35%, transparent);
  --dnd-split-border-style: solid;
  --dnd-split-radius: var(--radius-md);
  --dnd-insert-line-width: 3px;
  --dnd-insert-line-color: var(--accent-color);
  --dnd-overlay-shadow: 0 8px 24px color-mix(in srgb, var(--shadow-color) 15%, transparent);
  --dnd-overlay-border: 1.5px solid color-mix(in srgb, var(--accent-color) 35%, transparent);
  --dnd-blur: blur(4px);
  --dnd-insert-line-glow: 0 0 10px color-mix(in srgb, var(--accent-color) 60%, transparent);
}

html[data-theme="dark"] {
  --dnd-merge-bg: color-mix(in srgb, var(--accent-color) 12%, transparent);
  --dnd-merge-border: color-mix(in srgb, var(--accent-color) 40%, transparent);
  --dnd-split-bg: color-mix(in srgb, var(--accent-color) 10%, transparent);
  --dnd-split-border: color-mix(in srgb, var(--accent-color) 45%, transparent);
  --dnd-overlay-shadow: 0 8px 24px color-mix(in srgb, var(--shadow-color) 35%, transparent);
}

⚠ 关键：这些变量不设 fallback 值
   如果 --accent-color 未定义，color-mix 会直接报错，便于开发期发现问题
   变量定义与 data-theme 在同一作用域，避免 fallback 路径
```

**任务 7.2.5：DropIndicator CSS 类定义**

```
在 shell-dragdrop.css 中添加：

/* ── Drop Indicator Layer (全局浮层，pointer-events: none) ── */
.drop-indicator-layer {
  position: fixed;
  top: 0;
  left: 0;
  width: 100%;
  height: 100%;
  pointer-events: none;
  z-index: var(--z-drag-overlay, 1000);
  contain: strict;
}

/* 插入线 - 垂直（跨列） */
.drop-indicator-line-v {
  position: absolute;
  width: var(--dnd-insert-line-width);
  border-radius: 999px;
  background: var(--dnd-insert-line-color);
  box-shadow: var(--dnd-insert-line-glow);
  pointer-events: none;
  transition: opacity 0.1s, transform 0.1s;
  will-change: transform, opacity;
}

/* 插入线 - 水平（跨组） */
.drop-indicator-line-h {
  position: absolute;
  height: var(--dnd-insert-line-width);
  border-radius: 999px;
  background: var(--dnd-insert-line-color);
  box-shadow: var(--dnd-insert-line-glow);
  pointer-events: none;
  transition: opacity 0.1s, transform 0.1s;
  will-change: transform, opacity;
}

/* 合并区高亮 */
.drop-indicator-merge {
  position: absolute;
  border-radius: var(--dnd-merge-radius);
  background: var(--dnd-merge-bg);
  border: var(--dnd-merge-border-width) solid var(--dnd-merge-border);
  backdrop-filter: var(--dnd-blur);
  pointer-events: none;
  transition: opacity 0.15s;
  will-change: opacity;
}

/* 拆分区高亮 */
.drop-indicator-split {
  position: absolute;
  border-radius: var(--dnd-split-radius);
  background: var(--dnd-split-bg);
  border: var(--dnd-split-border-width) solid var(--dnd-split-border);
  backdrop-filter: var(--dnd-blur);
  pointer-events: none;
  transition: opacity 0.15s;
  will-change: opacity;
}

/* 新列预览 */
.drop-indicator-col-preview {
  position: absolute;
  border-radius: var(--radius-md);
  background: var(--dnd-split-bg);
  border: 1.5px solid var(--dnd-split-border);
  backdrop-filter: var(--dnd-blur);
  box-shadow: var(--dnd-overlay-shadow);
  pointer-events: none;
  transition: opacity 0.2s, transform 0.2s cubic-bezier(0.2, 0.8, 0.2, 1);
  will-change: transform, opacity;
}

/* 拖拽中过渡禁用（防卡顿） */
body.is-layout-frozen .drop-indicator-layer * {
  transition: none !important; /* OK: drag performance */
}
```

### 7.3 Round 5 验证清单

```
[ ] 冲突清单中所有类名已修复，无同名定义
[ ] !important 从 300+ 降到 50 以下
[ ] CSS contain 从 9 处增加到 30+ 处
[ ] 所有拖拽样式使用 CSS 变量驱动
[ ] 暗色主题下拖拽指示器颜色正确（基于 --accent-color）
[ ] 亮色主题下拖拽指示器颜色正确
[ ] 无 CSS 变量 fallback 依赖
```

---

## 8. Round 6：ResizeObserver 全局管理（P1）

### 8.1 目标
解决 R10/R12：11 个实例统一为单例管理器、接入 isLayoutFrozen、移除 useBubbleShrinkWidth

### 8.2 分配与任务

#### Agent-03（主负责）：ResizeObserverManager 单例

**任务 8.2.1：新建 `src/services/ResizeObserverManager.ts`**

```
核心设计：

class ResizeObserverManager {
  private static instance: ResizeObserverManager;
  private ro: ResizeObserver | null = null;
  private entries: Map<Element, ResizeObserverEntry> = new Map();
  private callbacks: Map<Element, Set<(entry: ResizeObserverEntry) => void>> = new Map();
  private isSuspended = false;
  private pendingFlush: (() => void)[] = [];

  static getInstance(): ResizeObserverManager

  // 注册观测
  observe(el: Element, cb: (entry: ResizeObserverEntry) => void): void
  
  // 取消观测
  unobserve(el: Element, cb: (entry: ResizeObserverEntry) => void): void
  
  // 统一挂起（由 layoutAnimationStore 订阅）
  setSuspended(suspended: boolean): void
    - 当 suspended=true：停止分发回调，记录 pending
    - 当 suspended=false：批量 flush pending 回调（分批，每帧最多 5 个）
  
  // 内部回调
  private handleResize(entries: ResizeObserverEntry[]): void
    - 如果 isSuspended：将回调加入 pendingFlush
    - 否则：立即分发到对应 callbacks
  
  // 销毁
  destroy(): void
}

使用方式：
// 组件中不再 new ResizeObserver()
const roManager = ResizeObserverManager.getInstance();
useEffect(() => {
  roManager.observe(ref.current, handleResize);
  return () => roManager.unobserve(ref.current, handleResize);
}, []);

// 与 layoutAnimationStore 连接
useLayoutAnimationStore.subscribe(
  (state) => state.isLayoutFrozen,
  (frozen) => ResizeObserverManager.getInstance().setSuspended(frozen)
);
```

**任务 8.2.2：迁移所有 ResizeObserver 使用点**

```
迁移清单（11 处 → 全部使用 ResizeObserverManager）：

┌────────────────────────────────────────────────────────────────┐
│ 文件                      │ 行号   │ 当前方式     │ 接入挂起？ │
├───────────────────────────┼────────┼─────────────┼───────────┤
│ ChatMessageList.tsx       │ ~285   │ Ref+RO      │ 是        │
│ FilesCard.tsx             │ ~140   │ Ref+RO      │ 是        │
│ TerminalCard.tsx          │ ~80    │ fitAddon    │ 否        │
│ ChatToolCallBlock.tsx     │ ~55    │ Ref+RO      │ 否        │
│ ChatMessageRow.tsx        │ ~330   │ Ref+RO      │ 间接      │
│ Sidebar.tsx               │ ~210   │ Ref+RO      │ 否        │
│ DiffCard.tsx              │ ~90    │ Ref+RO      │ 否        │
│ OverviewCard.tsx          │ ~70    │ Ref+RO      │ 否        │
│ SettingsPanel.tsx         │ ~45    │ Ref+RO      │ 否        │
│ PreviewCard.tsx           │ ~30    │ Ref+RO      │ 否        │
│ VirtualList.tsx           │ ~60    │ Ref+RO      │ 否        │
└───────────────────────────┴────────┴─────────────┴───────────┘

迁移步骤：
对每个使用点：
1. 导入 ResizeObserverManager
2. 替换 new ResizeObserver(...) 为 roManager.observe(el, cb)
3. 替换 observer.disconnect() 为 roManager.unobserve(el, cb)
4. 移除 useEffect 中的 observer 创建/销毁逻辑
5. 挂起机制自动生效（由 ResizeObserverManager 统一管理）
```

#### Agent-08（协）：移除 useBubbleShrinkWidth

**任务 8.2.3：移除 `useBubbleShrinkWidth`**

```
1. 找到 useBubbleShrinkWidth 定义和使用处：
   grep -r "useBubbleShrinkWidth" --include="*.{ts,tsx}"

2. 分析其作用：
   - 每次 React commit 阶段测量父容器宽度
   - 用于动态计算某个元素的收缩宽度
   - 但每 commit 都触发强制同步重排

3. 替代方案：
   a. 使用 CSS flex-shrink / min-width 替代 JS 测量
   b. 或使用 ResizeObserver 挂起方式
   c. 或在拖拽期间跳过（通过 isLayoutFrozen）

4. 修改：
   - 在 useResizeFreeze 或对应的组件中
   - 当 isLayoutFrozen=true 时跳过测量
   - 当 isLayoutFrozen=false 时延迟一帧再恢复测量
```

#### Agent-01（协）：宽度变化 invalidateAllActual 接线

**任务 8.2.4：连接宽度剧变 → invalidateAllActual（审计 01-post-r6-list.md M1）**

```
契约 §1 要求：容器宽度剧变时，调用 manager.invalidateAllActual() + bump heightTick。
当前实现中，invalidateAllActual 已在 VirtualScrollManager 中定义但全库无引用。

修复：
1. 在 ChatMessageList.tsx 的 setContainerWidth 中检测宽度变化阈值（≥ 40px）
2. 超过阈值时调用 manager.invalidateAllActual() + bump heightTick
3. 与 isLayoutFrozen 结束后的 catch-up 对齐（解冻后 invalidate 保证所有行重新测量）

伪代码：
  const prevWidthRef = useRef(0);
  const setContainerWidth = useCallback((width: number) => {
    if (isResizing) return; // 挂起
    setContainerWidthState(width);
    
    // ★ 新增：宽度剧变 invalidate
    const prev = prevWidthRef.current;
    prevWidthRef.current = width;
    if (prev > 0 && Math.abs(width - prev) >= 40) {
      manager.invalidateAllActual();
      setHeightTick(t => t + 1);
    }
  }, [isResizing, manager]);
```

### 8.3 Round 6 验证清单

```
[ ] ResizeObserverManager 单例正常工作
[ ] 全部 11 个 ResizeObserver 使用点已迁移
[ ] isLayoutFrozen=true 时所有 RO 回调挂起
[ ] isLayoutFrozen=false 时 RO 回调分批恢复
[ ] useBubbleShrinkWidth 的强制重排消除
[ ] 无内存泄漏（组件卸载时正确 unobserve）
[ ] 挂起/恢复时无闪烁或跳动
```

---

## 9. Round 7：拖拽指示器样式现代化（P2）

### 9.1 目标
彻底消除黑色/灰色陈旧样式、暗色主题兼容、双分块根源清除

### 9.2 分配与任务

#### Agent-05（主负责）：样式现代化

**任务 9.2.1：删除黑色虚线边框的 legacy 样式**

```
1. 在 Workspace.module.css 中：
   - 删除 .placeholderCardGroup 的黑色背景
   - 删除 dashed 边框
   - 删除暗色硬编码颜色
   
2. 在 shell-workspace.css 中：
   - 删除 .placeholder-card-group 相关的全部样式
   - 删除 ::before 和 ::after 伪元素
   
3. 替换为 Round 5 中定义的 CSS 变量驱动样式
```

**任务 9.2.2：修复双分块问题的根源**

```
1. 根源分析：
   .placeholder-card-group 的 ::before 渲染为 Header 框
   ::after 渲染为 Body 框
   大容器中间出现两个小框 → "双分块"

2. 修复：
   a. 首选：删除伪元素，改为 DropIndicatorLayer 渲染
   b. 如果必须保留占位符容器，则：
      - 移除 ::before 和 ::after
      - 直接在容器内渲染单个占位元素
      - 或使用 background 渐变模拟
```

**任务 9.2.3：暗色主题全面测试**

```
1. 测试场景矩阵：
   ┌──────────────────────┬──────────┬──────────┐
   │ 拖拽模式              │ 亮色主题  │ 暗色主题  │
   ├──────────────────────┼──────────┼──────────┤
   │ 同列合并              │ ✓ 需验证  │ ✓ 需验证  │
   │ 同列拆分（上下）      │ ✓ 需验证  │ ✓ 需验证  │
   │ 跨列创建新列          │ ✓ 需验证  │ ✓ 需验证  │
   │ 跨列移动              │ ✓ 需验证  │ ✓ 需验证  │
   │ 拖拽预览卡片          │ ✓ 需验证  │ ✓ 需验证  │
   │ 插入线（竖线/横线）   │ ✓ 需验证  │ ✓ 需验证  │
   └──────────────────────┴──────────┴──────────┘

2. 验证标准：
   - 所有指示器颜色与 --accent-color 一致
   - 无黑色/灰色背景
   - 无虚线边框（仅用 solid + 透明边界）
   - 背景透明度适当（亮色 6-8%，暗色 10-12%）
   - backdrop-filter 模糊效果正常
```

### 9.3 Round 7 验证清单

```
[ ] 亮色/暗色主题所有拖拽样式一致
[ ] 无黑色背景或虚线边框
[ ] 无"双分块"
[ ] 所有颜色通过 CSS 变量驱动
[ ] backdrop-filter 模糊效果正常
[ ] 拖拽预览卡片阴影正常
```

---

## 10. Round 8：布局持久化与嵌套布局（P2）

### 10.1 目标
实现类似 VS Code 和 Obsidian 的布局序列化/反序列化，支持嵌套布局

### 10.2 分配与任务

#### Agent-06（主负责）：布局序列化

**任务 10.2.1：实现 CrishLayoutSerializer**

```
借鉴 VS Code SerializableGrid：

interface ISerializableLayout {
  version: number;
  root: ISerializableNode;
}

interface ISerializableNode {
  type: 'branch' | 'leaf';
  // branch（分列/分行）
  direction?: 'horizontal' | 'vertical';
  children?: ISerializableNode[];
  sizes?: number[];  // 比例
  // leaf（具体面板）
  panelType?: string;
  panelState?: unknown;
  tabs?: string[];  // 标签顺序
  activeTab?: string;
}

// 序列化
export function serializeLayout(ws: WorkspaceState): ISerializableLayout

// 反序列化
export function deserializeLayout(data: ISerializableLayout): WorkspaceState

// 布局快照
export function takeLayoutSnapshot(): void
export function restoreLayoutSnapshot(): void
```

#### Agent-04（协）：CrishGrid 嵌套布局

**任务 10.2.2：设计 CrishGrid 树状结构**

```
借鉴 VS Code Grid 的 BranchNode/LeafNode：

class CrishGridNode {
  type: 'branch' | 'leaf';
  minWidth: number;
  minHeight: number;
  priority: 'normal' | 'low' | 'high';
}

class CrishGridBranch extends CrishGridNode {
  direction: 'horizontal' | 'vertical';
  children: CrishGridNode[];
  sizes: number[];
}

class CrishGridLeaf extends CrishGridNode {
  panelType: string;
  tabs: string[];
  activeTab: string;
}
```

### 10.3 Round 8 验证清单

```
[ ] 布局可序列化为 JSON
[ ] 从 JSON 恢复布局
[ ] 嵌套布局（分行内再分列）正常渲染
[ ] 拖拽调整后布局可保存
[ ] 刷新后布局恢复
```

---

## 11. Round 9：回归测试与性能基准（P2）

### 11.1 目标
全量回归测试 + 性能基准建立 + CSS 检测 CI

### 11.2 分配与任务

#### Agent-01（主）：虚拟滚动回归

```
测试用例：
1. VirtualScrollManager 全部单元测试
2. ChatMessageList 消息重复场景
3. 1000 条消息的滚动性能
4. 快速插入消息的时序
```

#### Agent-02（主）：拖拽回归

```
测试用例：
1. 列宽拖拽 60fps 基准
2. iframe pointer-events 场景
3. 鼠标/触控板混合输入
```

#### Agent-03（主）：冻结回归

```
测试用例：
1. 窗口 resize 冻结
2. 窗口 move 冻结
3. 所有 ResizeObserver 挂起/恢复
```

#### Agent-04（主）：Tab 拖拽回归

```
测试用例：
1. 跨列拖拽精确度
2. 同列内拖拽
3. 创建新列
4. DropIndicatorLayer 样式
```

#### Agent-05（主）：CSS 回归

```
测试用例：
1. 亮色/暗色主题切换
2. 拖拽指示器样式
3. 视觉回归（Playwright）
```

#### Agent-06（主）：布局持久化回归

```
测试用例：
1. 序列化/反序列化
2. 布局恢复
```

#### Agent-07（主）：碰撞检测回归

```
测试用例：
1. 碰撞检测单元测试（pure functions）
2. 级联检测
3. 边缘情况（空布局、单列等）
```

#### Agent-08（主）：性能基准

```
1. 建立性能基准：
   - TypeScript 基准测试（vitest bench）
   - 渲染性能（Chrome DevTools 录屏）
   - CSS 选择器匹配性能
   
2. CSS 检测 CI：
   - 新增 !important 告警
   - 新增 contain 覆盖率检测
   - 新增 CSS 变量完整性检测
```

### 11.3 Round 9 验证清单

```
[ ] 全部 8 个 Agent 的回归测试通过
[ ] 性能基准建立且无退化
[ ] CSS 检测 CI 集成
[ ] 无新增 !important
[ ] contain 覆盖率不下降
```

---

## 12. 依赖关系与执行顺序

### 12.1 Round 依赖图

```
Round 1 (P0: 冻结基础)
  │
  ├──→ Round 2 (P0: 虚拟滚动)          ← 无依赖，可与 R1 并行
  │
  ├──→ Round 3 (P0: Pointer 加固)       ← 依赖 R1 的冻结机制
  │
  ├──→ Round 4 (P1: Tab 浮层)           ← 依赖 R3（Pointer 基础）
  │     │
  │     └──→ Round 7 (P2: 样式现代化)    ← 依赖 R4（浮层就绪）+ R5（CSS 变量）
  │
  ├──→ Round 5 (P1: CSS 架构)           ← 无依赖，可与 R1 并行
  │
  ├──→ Round 6 (P1: ResizeObserver)     ← 依赖 R1（冻结机制）+ R5（CSS 变量）
  │
  └──→ Round 8 (P2: 布局持久化)         ← 依赖 R4（Tab 拖拽稳定）
        │
        └──→ Round 9 (P2: 回归测试)      ← 依赖 R1~R8 全部完成
```

### 12.2 并行执行建议

```
第一波并行（4 个 Agent 同时执行）：
  [ ] Agent-03: Round 1 (R1 主)
  [ ] Agent-02: Round 1 (R1 协) + Round 3
  [ ] Agent-01: Round 2
  [ ] Agent-08: Round 5 (R5 主)

第二波并行（R1 完成后）：
  [ ] Agent-04: Round 4 (主)
  [ ] Agent-05: Round 5 (R5 协) + Round 7
  [ ] Agent-07: Round 4 (协)

第三波并行（R4/R5 完成后）：
  [ ] Agent-03: Round 6
  [ ] Agent-08: Round 6 (协)

第四波并行（R4 稳定后）：
  [ ] Agent-06: Round 8
  [ ] Agent-04: Round 8 (协)

最终：
  [ ] All Agents: Round 9
```

### 12.3 文件修改优先级

```
P0（立即修改，Round 1-3）：
  ├── src/services/WindowResizeBridge.ts        ← NEW
  ├── src/utils/dragOverlay.ts                  ← NEW
  ├── src/hooks/useColumnResize.ts              ← NEW
  ├── src/hooks/useResizeFreeze.ts              ← MODIFY
  ├── src/hooks/useWindowControls.ts            ← MODIFY
  ├── src/api/VirtualScrollManager.ts           ← MODIFY
  ├── src/hooks/useVirtualScroll.ts             ← MODIFY
  ├── src/components/ChatMessageList.tsx        ← MODIFY
  ├── src/styles/shell/shell-dragdrop.css       ← MODIFY
  ├── src/App.tsx                               ← MODIFY

P1（短期修改，Round 4-6）：
  ├── src/components/DropIndicatorLayer.tsx      ← NEW
  ├── src/utils/collisionDetection.ts           ← NEW
  ├── src/services/ResizeObserverManager.ts     ← NEW
  ├── src/hooks/useTabDrag.ts                   ← MODIFY
  ├── src/components/Workspace.tsx              ← MODIFY
  ├── src/components/CardPanel.tsx              ← MODIFY
  ├── src/styles/shell/shell-workspace.css      ← MODIFY
  ├── src/styles/workspace/Workspace.module.css ← MODIFY
  ├── src/styles/tokens.css                     ← MODIFY
  └── + 11 个 ResizeObserver 迁移

P2（中期修改，Round 7-9）：
  ├── src/utils/layoutSerializer.ts             ← NEW
  ├── src/utils/crishGrid.ts                    ← NEW
  ├── src/styles/shell/shell-dragdrop.css       ← MODIFY
  ├── src/styles/workspace/Workspace.module.css ← MODIFY
  └── 全部 50+ module.css 的 !important 清理
```

---

## 13. 附录 A：文件修改索引

```
apps/crish-desktop/src/
├── services/
│   ├── WindowResizeBridge.ts           ← NEW (R1)
│   └── ResizeObserverManager.ts        ← NEW (R6)
├── utils/
│   ├── dragOverlay.ts                  ← NEW (R3)
│   ├── collisionDetection.ts           ← NEW (R4)
│   ├── layoutSerializer.ts             ← NEW (R8)
│   └── crishGrid.ts                    ← NEW (R8)
├── hooks/
│   ├── useColumnResize.ts              ← NEW (R3)
│   ├── useResizeFreeze.ts              ← REWRITE (R1)
│   ├── useWindowControls.ts            ← MODIFY (R1)
│   ├── useVirtualScroll.ts             ← MODIFY (R2)
│   └── useTabDrag.ts                   ← REWRITE (R4)
├── api/
│   └── VirtualScrollManager.ts         ← MODIFY (R2)
├── components/
│   ├── DropIndicatorLayer.tsx           ← NEW (R4)
│   ├── ChatMessageList.tsx             ← MODIFY (R2)
│   ├── Workspace.tsx                   ← MODIFY (R3, R4)
│   └── CardPanel.tsx                   ← MODIFY (R4)
├── styles/
│   ├── tokens.css                      ← MODIFY (R5)
│   ├── shell/
│   │   ├── shell-dragdrop.css          ← MODIFY (R1, R5, R7)
│   │   └── shell-workspace.css         ← MODIFY (R4, R5, R7)
│   └── workspace/
│       └── Workspace.module.css        ← MODIFY (R5, R7)
└── App.tsx                              ← MODIFY (R1)
```

## 14. 附录 B：参考项目清单

```
reference/
├── agent-01/
│   ├── react-window-VariableSizeList.js    ← react-window 动态高度
│   └── react-virtuoso-architecture.md      ← react-virtuoso 架构
├── agent-02/
│   ├── vscode-sash.ts                      ← VS Code Sash 拖拽组件 (685行)
│   └── react-resizable-panels-notes.md     ← react-resizable-panels 笔记
├── agent-03/
│   ├── tauri-window-api.md                 ← Tauri 窗口 API 文档
│   ├── css-contain-spec.md                 ← CSS contain 规范
│   └── rendering-performance.md            ← 渲染性能优化
├── agent-04/
│   ├── dnd-kit-DragOverlay.tsx             ← DnD Kit DragOverlay
│   ├── dnd-kit-collision-detection.ts      ← DnD Kit 碰撞检测
│   └── react-beautiful-dnd-droppable.tsx   ← react-beautiful-dnd
├── agent-05/
│   ├── backdrop-filter-mdn.txt             ← MDN backdrop-filter
│   ├── color-mix-mdn.txt                   ← MDN color-mix
│   └── css-variables-theme-system.txt      ← 主题系统分析
├── agent-06/
│   └── vscode/
│       ├── sash.ts                         ← VS Code Sash (685行)
│       ├── splitview.ts                    ← VS Code SplitView (1505行)
│       ├── grid.ts                         ← VS Code Grid (952行)
│       ├── gridview.ts                     ← VS Code GridView (1842行)
│       └── layout.ts                       ← VS Code Layout (3215行)
├── agent-07/
│   ├── dnd-kit-core-analysis.md            ← DnD Kit 核心分析
│   ├── react-grid-layout-analysis.md       ← React Grid Layout 分析
│   └── react-resizable-panels-analysis.md  ← react-resizable-panels 分析
└── agent-08/
    └── performance-baseline.md             ← 性能基线数据
```

## 15. 附录 C：验证清单总表

```
P0 验证（必须通过）：
[ ] 消息发送后无重复（R2）
[ ] 列宽拖拽 60fps 不卡顿（R3）
[ ] 窗口 resize 冻结生效（R1）
[ ] 窗口 move 冻结生效（R1）
[ ] iframe 拖拽不中断（R3）
[ ] useResizeFreeze 无 MutationObserver（R1）
[ ] VirtualScrollManager 无异常路径（R2）

P1 验证（重要功能）：
[ ] Tab 跨列拖拽指示器与落点一致（R4）
[ ] Tab 同列内拖拽使用统一浮层（R4）
[ ] 无 DOM splice 拖拽布局闪动（R4）
[ ] 无黑色虚线边框（R5/R7）
[ ] 无"双分块"（R4/R7）
[ ] CSS contain 覆盖 30+ 处（R5）
[ ] !important < 50 处（R5）
[ ] 11 个 ResizeObserver 全部迁移（R6）
[ ] ResizeObserver 挂起/恢复正确（R6）
[ ] useBubbleShrinkWidth 移除（R6）

P2 验证（完善性）：
[ ] 亮色/暗色主题拖拽样式一致（R7）
[ ] 布局可序列化/反序列化（R8）
[ ] 嵌套布局正常（R8）
[ ] 全部回归测试通过（R9）
[ ] 性能基准无退化（R9）
[ ] CSS 检测 CI 集成（R9）
```

---

> 本方案综合 8 个 Agent 的 12 份分析文档（总计 7,600+ 行分析 + 7,500+ 行方案）
> 参考了 VS Code / Obsidian / Linear / Arc / DnD Kit / React Grid Layout / react-resizable-panels / SortableJS 等 8 个项目源码
> 分 9 个 Round，P0/P1/P2 三级优先级，可按需调整执行顺序
