# Agent 08：Crish 前端性能与 CSS 架构重构方案

> 基于 `agent-08-analysis.md` 的问题诊断，本方案按优先级排序、每项附验证方法
> 目标：消除 !important 扩散、补齐 contain 覆盖、统一 ResizeObserver、优化拖拽性能

---

## 目录

1. CSS 架构重组方案
   - 1.1 全局 CSS → CSS Modules 迁移策略
   - 1.2 特异性治理
   - 1.3 !important 淘汰路线图
   - 1.4 变量系统清理
   - 1.5 主题系统增强
2. 性能优化方案
   - 2.1 contain 批量注入
   - 2.2 will-change 策略
   - 2.3 动画属性规范
   - 2.4 GPU 合成层提升
3. ResizeObserver 优化
   - 3.1 全局单例管理器
   - 3.2 统一挂起接入
   - 3.3 useBubbleShrinkWidth 移除
4. 组件重渲染优化
   - 4.1 补充 React.memo
   - 4.2 选择器合并策略
   - 4.3 Context 优化
5. 拖拽性能方案
   - 5.1 CSS transition 禁用粒度优化
   - 5.2 DOM splice 批处理
   - 5.3 合成层动态管理
6. 监控与回归
   - 6.1 性能测试清单
   - 6.2 CI 中 CSS 检测
   - 6.3 人工验证步骤
7. 优先级排序
   - P0 立即
   - P1 短期
   - P2 中期
   - P3 长期

---

## 1. CSS 架构重组方案

### 1.1 全局 CSS → CSS Modules 迁移策略

**目标**：消除全局 CSS 与 CSS Modules 的命名冲突，实现样式完全隔离

**迁移路线**：

```
Phase 1（P0）：识别并修复冲突
  ├── 建立冲突清单：grep 查找同时在全局 CSS 和 .module.css 中出现的类名
  ├── 已知冲突对：
  │   ├── .card-header → shell-workspace.css + CardPanel.module.css
  │   ├── .card-tab → shell-workspace.css + CardPanel.module.css
  │   ├── .card-body → shell-workspace.css + CardPanel.module.css
  │   ├── .tabs-bar → shell-workspace.css + CardPanel.module.css
  │   ├── .sidebar.collapsed → shell-sidebar.css + shell-dragdrop.css
  │   └── iframe/webview pointer-events → shell-dragdrop.css + shell-workspace.css
  └── 修复：合并重复定义到对应 .module.css，全局 CSS 中删除

Phase 2（P1）：增量迁移
  ├── chat.css → Chat*.module.css 逐步迁移
  │   ├── 第一步：.chat-body、.chat-doc-flow → ChatCard.module.css
  │   ├── 第二步：.model-badge、.chat-breadcrumb-header → 对应 module
  │   └── 第三步：tool-stack、.msg-* 类 → ChatMessageRow.module.css
  ├── panels.css → DiffCard.module.css / FilesCard.module.css / RuntimePanel.module.css
  └── shell-layout.css → App.module.css 或 Layout.module.css

Phase 3（P2）：shell-*.css 重构
  ├── shell-sidebar.css → Sidebar.module.css（已存在）
  ├── shell-workspace.css → Workspace.module.css（已部分迁移）
  ├── shell-dragdrop.css → dragdrop.module.css 或内联
  ├── shell-polish.css → 拆分为工具类 + 具体组件 module
  └── shell-scrollbar.css → 全局 scrollbar 样式保留

Phase 4（P3）：新组件禁止写全局 CSS
  └── lint 规则：stylelint 禁止 .css 文件导入组件目录
```

**关键约束**：
- 每次迁移后运行 `npm run build` 确认无样式丢失
- 使用 visual regression 工具（如 Percy / Chromatic）对比迁移前后截图
- 迁移过程中保留全局 CSS 回退，逐步删除

### 1.2 特异性治理

**目标**：降低选择器特异性，消除长链选择器

**操作步骤**：

1. **使用 `@layer` 控制级联**（P1）：
   ```css
   @layer reset, tokens, shell, components, utilities;
   
   @layer utilities {
     .dropdown-item { ... } /* 不需要 !important */
   }
   ```

2. **缩短长链选择器**（P1）：
   ```css
   /* ❌ 当前：0-4-3 */
   .app-container[data-shell-chrome="inset"] .workspace-card:not(.workspace-card--no-chat-chrome) .card-tab.active
   
   /* ✅ 改为：使用 data 属性 + 短选择器 + CSS 变量 */
   .app-container.inset .card-tab.active { ... }
   ```

3. **`:where()` 降权规范**（P1）：
   ```css
   /* ❌ 当前：:where(html[data-theme="dark"]) .msg-user-bubble — 0-0-1 */
   /* ✅ 改为统一使用 `[data-theme="dark"]` 属性选择器配合 @layer */
   @layer themes {
     [data-theme="dark"] .msg-user-bubble { ... }
   }
   ```

4. **CSS Modules 的 `composes` 替代全局类**（P2）：
   ```css
   /* ✅ 使用 composes 组合样式，而非 !important 覆盖 */
   .myCard {
     composes: cardSurface from global;
   }
   ```

### 1.3 !important 淘汰路线图

**策略**：通过 `@layer` + 特异性治理 + CSS Modules 迁移，逐步消除 !important

| 阶段 | 范围 | 方法 | 预估减少 |
|------|------|------|---------|
| P1 | 模块 CSS 中的 !important | 迁移全局 CSS 后自然消除 | ~60% |
| P1 | shell-polish.css 工具类 | 改用 @layer utilities | ~20% |
| P2 | shell-dragdrop.css 冻结类 | 改用 CSS 变量覆盖 | ~10% |
| P2 | shell-workspace.css 覆盖类 | 通过 CSS Modules 隔离 | ~5% |
| P3 | 剩余不可消除的 !important | 逐案评审 | ~5% |

**具体操作**：

1. **模块 CSS 的 !important 来源分析**（P0）：
   - ChatCard.module.css L107-149：全部 !important，根源是全局 `.card-header`、`.card-body` 污染
   - 修复方法：删除全局 CSS 中的同名选择器，让 CSS Modules 自然生效

2. **冻结选择器优化**（P1）：
   ```css
   /* ❌ 当前 */
   body.is-resizing * { transition: none !important; }
   
   /* ✅ 改为 */
   body.is-resizing {
     --transition-micro: 0ms;
     --transition-fast: 0ms;
     --transition-smooth: 0ms;
   }
   /* 所有组件使用 var() 引用过渡，自动继承禁用 */
   ```

3. **工具类优化**（P1）：
   ```css
   /* ❌ 当前 */
   .m-0 { margin: 0 !important; }
   
   /* ✅ 改为 @layer 提升优先级 */
   @layer utilities {
     .m-0 { margin: 0; }
   }
   ```

### 1.4 变量系统清理

**目标**：消除冗余变量、统一命名

| 问题 | 修复 |
|------|------|
| `--space-0.5` 与 `--space-0_5` 重复（tokens.css L254, L271） | 删除 `.` 版本，统一使用 `_` |
| `--space-1.5` 与 `--space-1_5` 重复 | 删除 `.` 版本 |
| `--font-size-chat` 未复用 | 删除或改为实际使用 |
| `--accent-color, #1a73e8` fallback 多余 | 删除 fallback |
| `--chat-col-max` JS/CSS 双源 | 统一为 CSS 变量 + JS 修改变量值 |
| `--sidebar-width` JS/CSS 双源 | 同上 |

### 1.5 主题系统增强

**计划新增**：

1. **`prefers-color-scheme` 自动切换**（P2）：
   ```css
   @media (prefers-color-scheme: dark) {
     :root:not([data-theme="light"]) { /* 引用 dark 变量 */ }
   }
   ```

2. **高对比度主题**（P3）：
   ```css
   [data-theme="high-contrast"] {
     --text-primary: #000;
     --text-secondary: #1a1a1a;
     --border-color: #666;
     /* ... */
   }
   ```

3. **主题 token 完整性校验脚本**（P1）：
   ```bash
   # 检查 dark 主题是否定义了所有 light 中的变量
   diff <(grep '^  --' tokens.css | grep ':root' -A 300 | grep '^  --' | sort) \
        <(grep '^  --' tokens.css | grep 'data-theme="dark"' -A 120 | grep '^  --' | sort)
   ```

---

## 2. 性能优化方案

### 2.1 contain 批量注入

**目标**：从 9 处扩展到 30+ 处，覆盖所有滚动容器和高频更新区域

**P1 优先注入（10 处）**：

| 元素 | Contain 值 | 理由 |
|------|-----------|------|
| `.chat-doc-flow` | `paint layout` | 对话流主容器，滚动 + 内容变化 |
| `.card-body` | `paint layout style` | 卡片内容区，子元素高度不定 |
| `.chat-message-list` | `paint layout` | 虚拟列表宿主 |
| `.workspace-card` | `layout style` | 卡片容器，子元素 tab 切换 |
| `.diff-panel` | `paint layout` | Diff 面板，代码行高变化 |
| `.files-card-body` | `paint layout` | 文件列表滚动 |
| `.tool-stack` | `layout style` | 工具调用栈折叠/展开 |
| `.terminal-body` | `paint layout` | 终端内容行追加 |
| `.preview-body` | `paint` | 预览容器 |
| `.sidebar-scroll` | `paint layout` | 侧栏滚动区域 |

**P2 扩展注入（15 处）**：

| 元素 | Contain 值 | 理由 |
|------|-----------|------|
| 虚拟列表每行 | `layout style` | 行级隔离 |
| `.msg-row` | `layout style` | 消息行隔离 |
| `.card-tab` | `layout style` | Tab 切换隔离 |
| `.approval-card` | `content` | 审批卡片内容独立 |
| `.agent-card` | `layout style` | Agent 卡片内容独立 |
| `.md-code-block` | `layout` | 代码块隔离 |
| `.browser-viewport` | `paint` | 浏览器容器裁剪 |
| `.runtime-float-sheet` | `paint layout` | 浮层面板 |
| `.quick-open` | `paint layout` | 快速打开面板 |
| `.settings-panel` | `paint layout` | 设置面板 |

**注入方式**：

```css
/* ✅ 推荐：在全局 CSS 中批量添加（一次多元素） */
.chat-doc-flow,
.card-body,
.chat-message-list,
.diff-panel {
  contain: paint layout style;
}

/* ✅ 对于 CSS Modules：在 module.css 中对应类加 contain */
.myCardBody {
  contain: paint layout style;
}
```

### 2.2 will-change 策略

**规范**：
1. 禁止在静态 CSS 文件中声明 `will-change`
2. 仅在触发前 JS 动态设置，操作完成后重置为 `auto`
3. 只对 `transform`、`opacity` 使用 `will-change`

**P1 操作**：

1. **修复 `SidebarSessionList.module.css` L28**：
   ```css
   /* ❌ 移除静态声明 */
   .list {
     /* will-change: grid-template-rows; ← 删除 */
     contain: layout style;
   }
   ```

2. **拖拽系统动态 will-change**（useTabDrag.ts）：
   ```typescript
   // 拖拽开始时
   overlay.style.willChange = 'transform';
   // 拖拽结束后
   overlay.style.willChange = 'auto';
   ```

3. **候选应用元素**：
   - `.drag-overlay-preview-card` — 拖拽预览（JS 动态设置）
   - 侧栏动画 — 展开/折叠前设置 `will-change: transform`
   - 列分割器 — 拖拽前设置 `will-change: left`
   - 弹层 — 出现前设置 `will-change: opacity, transform`

**P2 扩展**：
- 创建 `useDynamicWillChange` hook 统一管理：
  ```typescript
  function useDynamicWillChange(
    ref: RefObject<HTMLElement>,
    property: string,
    shouldEnable: boolean
  ) {
    useEffect(() => {
      if (!ref.current) return;
      ref.current.style.willChange = shouldEnable ? property : 'auto';
    }, [ref, property, shouldEnable]);
  }
  ```

### 2.3 动画属性规范

**规则**：
- 过渡/动画仅使用 `transform` 和 `opacity`
- 禁止使用触发 layout 的属性做动画（`width`、`height`、`left`、`top`、`margin`、`padding`）

**P1 修复**：

| 位置 | 当前 | 修复 |
|------|------|------|
| `Workspace.module.css L117` | `.colSplitter { transition: left ... }` | 改为 `transform: translateX()` |
| `Workspace.module.css L164` | `.groupSplitter { transition: top ... }` | 改为 `transform: translateY()` |
| `shell-workspace.css L747` | `.workspace-card { transition: height ... }` | 改用 `transform: scaleY()` 或移除 |

**P3 排查**：
```bash
# 搜索所有触发 layout 的过渡属性
grep -rn 'transition.*width\|transition.*height\|transition.*left\|transition.*top\|transition.*margin\|transition.*padding' apps/crish-desktop/src --include="*.css"
```

### 2.4 GPU 合成层提升

**P1 操作**：

| 元素 | 方案 |
|------|------|
| `.drag-overlay-preview-card` | `will-change: transform`（JS） |
| `.agent-more-menu` | `transform: translateZ(0)` |
| `.panel-dropdown` | `transform: translateZ(0)` |
| `.chat-scroll-fab` | `transform: translateZ(0)` |
| `.ui-popover-animate` | 已在动画中（`transform: scale(0.96)`） |
| `.ui-modal-animate` | 已在动画中 |

**策略**：
- 弹层和浮层：主动提升为合成层（`transform: translateZ(0)`）
- 拖拽元素：JS 动态设置 `will-change: transform`
- 滚动容器：`contain: paint` 自动创建合成层
- 避免过度提升（太多合成层会耗尽 GPU 内存）

---

## 3. ResizeObserver 优化

### 3.1 全局单例管理器

**参考架构**（来自 `docs/rust-architecture-redesign/07-FRONTEND-DOM-LAYOUT-AND-PERFORMANCE-REFACTOR.md`）：

```typescript
// src/utils/ResizeObserverManager.ts
type ResizeCallback = (entry: ResizeObserverEntry) => void;

class ResizeObserverManager {
  private static instance: ResizeObserverManager;
  private observer: ResizeObserver;
  private callbacks = new Map<Element, Set<ResizeCallback>>();
  private pendingEntries = new Map<Element, ResizeObserverEntry>();
  private rafId: number | null = null;

  private constructor() {
    this.observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        this.pendingEntries.set(entry.target, entry);
      }
      this.scheduleFlush();
    });
  }

  static getInstance(): ResizeObserverManager {
    if (!ResizeObserverManager.instance) {
      ResizeObserverManager.instance = new ResizeObserverManager();
    }
    return ResizeObserverManager.instance;
  }

  observe(target: Element, callback: ResizeCallback): () => void {
    const cbs = this.callbacks.get(target) ?? new Set();
    cbs.add(callback);
    if (cbs.size === 1) {
      this.callbacks.set(target, cbs);
      this.observer.observe(target);
    }
    return () => this.unobserve(target, callback);
  }

  private unobserve(target: Element, callback: ResizeCallback): void {
    const cbs = this.callbacks.get(target);
    if (!cbs) return;
    cbs.delete(callback);
    if (cbs.size === 0) {
      this.callbacks.delete(target);
      this.observer.unobserve(target);
    }
  }

  private scheduleFlush(): void {
    if (this.rafId !== null) return;
    this.rafId = requestAnimationFrame(() => {
      this.rafId = null;
      // 批量处理：读取与写入分离
      const entries = Array.from(this.pendingEntries.entries());
      this.pendingEntries.clear();
      for (const [target, entry] of entries) {
        const cbs = this.callbacks.get(target);
        if (cbs) {
          for (const cb of cbs) {
            try { cb(entry); } catch (e) { /* ignore */ }
          }
        }
      }
    });
  }
}

export function useManagedResizeObserver(
  ref: RefObject<HTMLElement | null>,
  callback: ResizeCallback,
  disabled = false,
): void {
  useEffect(() => {
    if (disabled || !ref.current) return;
    const el = ref.current;
    const unobserve = ResizeObserverManager.getInstance().observe(el, callback);
    return () => unobserve();
  }, [ref, callback, disabled]);
}
```

**P0 操作**：
1. 创建 `src/utils/ResizeObserverManager.ts`
2. 替换 `useSuspendedResizeObserver` 内部实现使用管理器
3. 逐步替换所有独立 `new ResizeObserver` 调用

### 3.2 统一挂起接入

**P1 操作**：

| 文件 | 当前 | 修复 |
|------|------|------|
| `VirtualList.tsx` | 独立 new ResizeObserver | 改用 `useManagedResizeObserver` |
| `useAutoGrowTextarea.ts` | 独立 new ResizeObserver | 改用 `useManagedResizeObserver` |
| `SidebarSessionList.tsx` | 独立 new ResizeObserver | 改用 `useManagedResizeObserver` |
| `useVirtualScroll.ts` | 独立 new ResizeObserver | 改用 `useManagedResizeObserver` |
| `useVirtualDiffScroll.ts` | 独立 new ResizeObserver | 改用 `useManagedResizeObserver` |
| `ChatToolCallBlock.tsx` | 独立 new ResizeObserver | 改用 `useManagedResizeObserver` |

`useManagedResizeObserver` 内部集成 `isLayoutFrozen` 守卫 + catchup 队列。

### 3.3 useBubbleShrinkWidth 移除

**P0 操作**：
1. 删除 `useTextMeasure.ts` 中的 `useBubbleShrinkWidth` 函数
2. 替换为 CSS 原生方案：
   ```css
   .msg-user-bubble,
   .msg-assistant-bubble {
     /* 使用 fit-content + max-width 替代 JS 计算缩进 */
     max-width: calc(100% - 32px);
     width: fit-content;
   }
   ```
3. 移除 `ChatMessageRow.tsx` 中对 `useBubbleShrinkWidth` 的调用（L275, L520）
4. 清理 `useTextMeasure.ts` 中不再需要的导出

**验证**：
- 确认消息气泡在各种宽度下正确显示
- 确认 `clientWidth` 读取不再触发强制重排
- 比对该功能的移除消除了 ~1,573 次强制重排（参考性能 trace 数据）

---

## 4. 组件重渲染优化

### 4.1 补充 React.memo

**P1 操作**：

| 组件 | 文件 | 当前 | 修复 |
|------|------|------|------|
| `ChatToolCallBlock` | `ChatToolCallBlock.tsx` | 未 memo | 包裹 `React.memo` |
| `ChatStatusRibbons` | `ChatStatusRibbons.tsx` | 未 memo | 包裹 `React.memo` |
| `FilesCard` | `FilesCard.tsx` | 未 memo | 包裹 `React.memo` |
| `TerminalCard` | `TerminalCard.xterm.tsx` | 未 memo | 包裹 `React.memo` |
| `SettingsPanel` | `SettingsPanel.tsx` | 未 memo | 包裹 `React.memo` |

**注意事项**：
- `ChatToolCallBlock` 的 props 包含引用类型（`onToggle` 回调），需配合 `useCallback`
- `TerminalCard` 依赖 xterm 实例，memo 时需要深层比较

### 4.2 选择器合并策略

**P2 优化**：

对于选择 5+ 个同一 store 字段的组件（如 `ChatCard.tsx`、`Sidebar.tsx`）：

```tsx
// ❌ 当前：每个字段独立订阅
const permissionMode = useLayoutStore((s) => s.permissionMode);
const setPermissionMode = useLayoutStore((s) => s.setPermissionMode);
const planModeEnabled = useLayoutStore((s) => s.planModeEnabled);
const planApproved = useLayoutStore((s) => s.planApproved);
const setPlanApproved = useLayoutStore((s) => s.setPlanApproved);

// ✅ 改进：合并相关字段为对象选择器 + shallow 比较
import { shallow } from 'zustand/shallow';
const { permissionMode, planModeEnabled, planApproved } = useLayoutStore(
  (s) => ({
    permissionMode: s.permissionMode,
    planModeEnabled: s.planModeEnabled,
    planApproved: s.planApproved,
  }),
  shallow
);
const setPermissionMode = useLayoutStore((s) => s.setPermissionMode);
const setPlanApproved = useLayoutStore((s) => s.setPlanApproved);
```

**候选组件**（选择器数量 > 5）：
- `ChatCard.tsx` — 12 个选择器
- `ChatMessageList.tsx` — 9 个选择器
- `Sidebar.tsx` — 10 个选择器
- `DiffCard.tsx` — 5 个选择器
- `ChatComposer.tsx` — 5 个选择器
- `AgentCard.tsx` — 5 个选择器

### 4.3 Context 优化

**当前**：`NowTickContext` 仅用于侧栏会话列表的时间显示，范围可控。

**P3 建议**：
- 将 `NowTickContext.Provider` 上移至更靠近消费组件的位置，缩小重渲染影响范围
- 考虑使用 zustand 替代 Context（如果后续扩展更多时间相关功能）

---

## 5. 拖拽性能方案

### 5.1 CSS transition 禁用粒度优化

**P1 优化**：

```css
/* ❌ 当前：* 万能选择器影响所有元素 */
body.is-layout-frozen * {
  transition: none !important;
  animation: none !important;
}

/* ✅ 改为：CSS 变量覆盖 + .essential-animation 豁免 */
body.is-layout-frozen {
  --transition-micro: 0ms;
  --transition-fast: 0ms;
  --transition-smooth: 0ms;
  --transition-spring: 0ms;
  --animation-enabled: paused;
}
/* 关键动画使用 essential-animation 类豁免 */
.essential-animation {
  animation-play-state: var(--animation-enabled, running) !important;
}
```

**效果**：
- 从 10,000+ DOM 元素选择器降为 1 个 body 选择器
- CSS 变量传播由浏览器自动处理，无需计算样式
- 必要动画可豁免

**迁移步骤**：
1. 在 tokens.css `eco` 性能层的方案基础上扩展
2. 修改 `shell-dragdrop.css` L39-56 中的冻结选择器
3. 添加 `essential-animation` 类到必要的动画元素

### 5.2 DOM splice 批处理

**P2 优化**：

**Tab 拖拽 DOM 操作批处理**（`useTabDrag.ts`）：

```typescript
// ❌ 当前：每次拖拽重复 insertBefore/appendChild
function handleDrop(sources, targetGroup, targetIndex) {
  for (const tab of sources) {
    targetGroup.tabs.splice(targetIndex, 0, tab);
  }
}

// ✅ 改进：使用 requestAnimationFrame 批量提交
function handleDrop(sources, targetGroup, targetIndex) {
  requestAnimationFrame(() => {
    const nextTabs = [...targetGroup.tabs];
    for (const tab of sources) {
      nextTabs.splice(targetIndex, 0, tab);
    }
    // 一次 setState 触发一次 reconcile
    updateGroupTabs(targetGroup.id, nextTabs);
  });
}
```

**侧栏会话拖拽**（`SidebarSessionList.tsx`）：
- 当前使用 `transform: translate()` 做视觉拖拽，DOM 操作在松手后一次性提交 ✅
- 确认 `transition: transform 200ms ease` 配合正确

### 5.3 合成层动态管理

**P2 优化**：

创建 `useDragLayer` hook 统一管理拖拽覆盖层的合成层提升：

```typescript
function useDragLayer(dragOverlayRef: RefObject<HTMLElement>) {
  useEffect(() => {
    const el = dragOverlayRef.current;
    if (!el) return;
    // 拖拽开始时提升为合成层
    el.style.willChange = 'transform';
    el.style.backfaceVisibility = 'hidden';
    
    return () => {
      // 清理
      el.style.willChange = 'auto';
      el.style.backfaceVisibility = '';
    };
  }, [dragOverlayRef]);
}
```

---

## 6. 监控与回归

### 6.1 性能测试清单

**P1 实施**：

```typescript
// vitest 性能测试示例
describe('Layout Performance', () => {
  it('contain 属性覆盖达标', () => {
    const css = fs.readFileSync('src/styles/...', 'utf-8');
    const containCount = (css.match(/contain:/g) || []).length;
    expect(containCount).toBeGreaterThanOrEqual(30);
  });
  
  it('禁止静态 will-change 声明', () => {
    const css = fs.readFileSync('src/...', 'utf-8');
    expect(css).not.toMatch(/will-change:\s*(?!auto)/);
  });
  
  it('新组件使用 CSS Modules', () => {
    // 检查 src/components/ 中不直接导入 .css 文件
  });
});
```

### 6.2 CI 中 CSS 检测

**P2 实施**：

```yaml
# .github/workflows/css-audit.yml
name: CSS Audit
on: [pull_request]
jobs:
  audit:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Count !important
        run: |
          IMPORTANT_COUNT=$(grep -r '!important' apps/crish-desktop/src --include="*.css" | wc -l)
          echo "!important count: $IMPORTANT_COUNT"
          # 如果超过阈值则告警
      - name: Check contain coverage
        run: |
          CONTAIN_COUNT=$(grep -r 'contain:' apps/crish-desktop/src --include="*.css" | wc -l)
          echo "contain count: $CONTAIN_COUNT"
      - name: Check static will-change
        run: |
          STATIC_WILL_CHANGE=$(grep -r 'will-change:' apps/crish-desktop/src --include="*.css" | grep -v 'auto' | wc -l)
          echo "Static will-change: $STATIC_WILL_CHANGE"
```

### 6.3 人工验证步骤

| 步骤 | 操作 | 预期结果 |
|------|------|---------|
| 1 | 打开 DevTools Performance tab，录制拖拽操作 | 无强制重排（Forced Reflow） |
| 2 | 检查 Layers tab | 合理数量的合成层（非每元素一层） |
| 3 | 切换 light/dark 主题 | 瞬时切换，无闪烁 |
| 4 | 连续快速拖拽 tab 10 次 | 无卡顿，无白屏 |
| 5 | 调整窗口大小 | 无黑色间隙，过渡平滑 |
| 6 | 在低端设备（4x CPU slowdown）测试 | 保持 30fps+ |
| 7 | 虚拟列表滚动 1000 条消息 | 保持 60fps |
| 8 | 检查 Console 无 `ResizeObserver loop limit exceeded` 警告 | 无警告 |

---

## 7. 优先级排序

### P0 — 立即执行（1-2 天）

| # | 任务 | 文件 | 预期影响 |
|---|------|------|---------|
| 0.1 | 移除 `useBubbleShrinkWidth` | `useTextMeasure.ts`、`ChatMessageRow.tsx` | 消除 1,573 次强制重排 |
| 0.2 | 创建 `ResizeObserverManager` 单例 | `src/utils/ResizeObserverManager.ts` | 统一 10 个实例为 1 个 |
| 0.3 | 合并重复的 iframe pointer-events 规则 | `shell-dragdrop.css`、`shell-workspace.css` | 消除重复 CSS |

### P1 — 短期（1 周）

| # | 任务 | 预估工作量 |
|---|------|-----------|
| 1.1 | 批量注入 contain（10 个主要容器） | 0.5 天 |
| 1.2 | 修复静态 will-change、动态化 | 0.5 天 |
| 1.3 | 修复 layout 触发的动画属性（left→transform） | 0.5 天 |
| 1.4 | 拖拽系统 transition 禁用粒度优化 | 0.5 天 |
| 1.5 | 补充 React.memo 到 5 个组件 | 0.5 天 |
| 1.6 | 治理 `!important`（模块 CSS 部分） | 1 天 |
| 1.7 | 接入 ResizeObserver 管理器（4 个遗漏点） | 0.5 天 |
| 1.8 | 清理 tokens.css 重复变量 | 0.5 天 |

### P2 — 中期（2 周）

| # | 任务 | 预估工作量 |
|---|------|-----------|
| 2.1 | 迁移 chat.css 到 CSS Modules | 2 天 |
| 2.2 | 迁移 panels.css 到 CSS Modules | 1 天 |
| 2.3 | 使用 `@layer` 重构级联 | 1 天 |
| 2.4 | 15 个扩展 contain 注入 | 0.5 天 |
| 2.5 | Zustand 选择器合并优化 | 1 天 |
| 2.6 | GPU 合成层主动提升 | 0.5 天 |
| 2.7 | 建立 CI CSS 检测 | 1 天 |
| 2.8 | 拖拽 DOM splice 批处理 | 1 天 |

### P3 — 长期（1 个月）

| # | 任务 | 预估工作量 |
|---|------|-----------|
| 3.1 | 迁移 shell-*.css 全部到 CSS Modules | 3 天 |
| 3.2 | 高对比度主题支持 | 1 天 |
| 3.3 | `prefers-color-scheme` 自动切换 | 0.5 天 |
| 3.4 | 新组件禁止全局 CSS 的 lint 规则 | 0.5 天 |
| 3.5 | Context 上移 + 缩小影响范围 | 0.5 天 |
| 3.6 | 性能回归测试套件 | 2 天 |

---

## 附录：关键文件清单

| 文件路径 | 行数 | 角色 | 审计发现 |
|---------|------|------|---------|
| `apps/crish-desktop/src/styles/tokens.css` | 729 | CSS 变量主文件 | 重复变量、双源问题 |
| `apps/crish-desktop/src/styles/theme-dark.css` | 265 | 暗色组件覆盖 | 大量 :where() 降权 |
| `apps/crish-desktop/src/styles/shell/shell-dragdrop.css` | 132 | 拖拽样式 | 粗颗粒度冻结选择器 |
| `apps/crish-desktop/src/styles/shell/shell-workspace.css` | 761 | shell 工作区 | 乱码注释、长链选择器 |
| `apps/crish-desktop/src/styles/shell/shell-polish.css` | ~1200 | 全局工具类 | 大量 !important |
| `apps/crish-desktop/src/styles/shell/shell-sidebar.css` | 431 | 侧栏样式 | 重复定义 |
| `apps/crish-desktop/src/styles/shell/shell-layout.css` | 298 | 顶层布局 | 少量未使用 CSS |
| `apps/crish-desktop/src/styles/chat.css` | 1247 | 对话流样式 | 未模块化 |
| `apps/crish-desktop/src/styles/panels.css` | 748 | 面板样式 | 未模块化 |
| `apps/crish-desktop/src/hooks/useSuspendedResizeObserver.ts` | 67 | 可挂起观察器 | 设计良好 |
| `apps/crish-desktop/src/hooks/useResizeFreeze.ts` | 30 | 冻结状态钩子 | 设计良好 |
| `apps/crish-desktop/src/store/layoutAnimationStore.ts` | 297 | 动画状态管理 | 设计良好 |
| `apps/crish-desktop/src/components/VirtualList.tsx` | 112 | 通用虚拟列表 | 缺少挂起 |
| `apps/crish-desktop/src/components/ChatMessageList.tsx` | ~1000 | 消息列表 | 双重守卫正确 |

---

## 附录 A：代码修改清单（按优先级）

### P0 修改

```typescript
// 0.1: useTextMeasure.ts — 移除 useBubbleShrinkWidth
// 删除整个函数及其导出
// 影响文件: useTextMeasure.ts, ChatMessageRow.tsx (L275, L520)

// 0.2: 创建 ResizeObserverManager
// 新文件: src/utils/ResizeObserverManager.ts
// 修改: useSuspendedResizeObserver.ts — 替换内部实现
```

### P1 修改

```css
/* 1.1: 批量注入 contain */
.chat-doc-flow { contain: paint layout; }
.card-body { contain: paint layout style; }
.chat-message-list { contain: paint layout; }
.workspace-card { contain: layout style; }
.diff-panel { contain: paint layout; }

/* 1.2: 修复静态 will-change */
.sidebar-session-list { /* 删除 will-change */ }

/* 1.6: 冻结选择器优化 */
body.is-layout-frozen { /* 使用 CSS 变量替代 * 选择器 */ }
```

## 附录 B：性能预算

| 指标 | 当前 | 目标 | 测量方法 |
|------|------|------|---------|
| contain 覆盖数 | 9 处 | ≥30 处 | CSS 文件 grep |
| will-change 静态声明 | 1 处 | 0 处 | CSS 文件 grep |
| !important 总数 | 300+ | ≤50 处 | CSS 文件 grep |
| ResizeObserver 实例数 | 11 个 | 1 个 | Chrome DevTools Performance |
| 强制同步重排 | ~1,573 次 | 0 次 | Chrome DevTools Performance |
| 拖拽时 Layout Shift | 有 | 无 | Chrome DevTools Performance |
| 主题切换时间 | ≤16ms | ≤8ms | Performance API mark/measure |
| 虚拟列表 1000 条 FPS | - | ≥55fps | Chrome DevTools FPS meter |

## 附录 C：迁移风险与回退策略

### 风险 1：CSS Modules 迁移导致样式丢失

```typescript
// 回退策略：渐进式迁移
// 1. 修改前先截取当前页面的 DOM + 计算样式快照
// 2. 迁移后对比快照差异
// 3. 使用 stylelint 检测未使用的 CSS 类
// 4. 如果样式丢失，立即恢复全局 CSS 引用，排查后再执行
```

### 风险 2：contain 属性破坏布局

```css
/* 回退：contain 可能导致 width/height 计算异常（size containment） */
/* 方案：先从 paint layout 开始，确认稳定后再加 style */
/* 如果不加 size/inline-size，contain 不会影响尺寸计算，相对安全 */
```

### 风险 3：ResizeObserverManager 单例导致回调丢失

```typescript
// 回退：保留旧 useSuspendedResizeObserver 作为 fallback
// 通过 feature flag 控制切换：
const useObserver = featureFlags.useManager
  ? useManagedResizeObserver
  : useSuspendedResizeObserver;
```

## 附录 D：VS Code CSS Contain 策略参考（详细）

VS Code 在 Monaco Editor 中的 CSS contain 使用模式：

```css
/* 编辑器视图容器 — 隔离整个编辑器 */
.monaco-editor { contain: strict; }

/* 行容器 — 每行独立 containment */
.view-line { contain: layout style paint; }

/* 滚动条 — 独立层 */
.scrollbar { contain: layout style; contain: strict; /* 通过 JS 动态 */ }

/* Minimap — 完全隔离 */
.minimap { contain: strict; will-change: transform; }

/* 悬浮提示 — 不向外传播布局 */
.monaco-hover { contain: layout paint; }
```

**对照 Crish 的适配方案**：

| VS Code 组件 | Crish 对应 | Contain 方案 |
|-------------|-----------|-------------|
| .monaco-editor | .card-body | contain: paint layout style |
| .view-line | .msg-row | contain: layout style |
| .scrollbar | .custom-scrollbar | contain: paint |
| .minimap | .preview-minimap | contain: strict |
| .monaco-hover | .tooltip | contain: paint layout |

## 附录 E：DnD Kit 性能策略参考（详细）

```typescript
// DnD Kit 的核心优化模式：

// 1. 传感器批处理 — rAF 防抖
function useSensor() {
  const lastEvent = useRef<PointerEvent | null>(null);
  const rafId = useRef<number | null>(null);
  
  const handleMove = (event: PointerEvent) => {
    lastEvent.current = event;
    if (rafId.current == null) {
      rafId.current = requestAnimationFrame(() => {
        rafId.current = null;
        if (lastEvent.current) {
          // 处理最新的指针位置
          onMove(lastEvent.current);
        }
      });
    }
  };
}

// 2. 覆盖层独立合成
function DragOverlay({ children }) {
  return createPortal(
    <div style={{
      position: 'fixed',
      pointerEvents: 'none',
      zIndex: 9999,
      willChange: 'transform',  // 提前创建合成层
    }}>
      {children}
    </div>,
    document.body
  );
}
```

**Crish 的差异**：useTabDrag.ts 的拖拽传感器未使用 rAF 批处理，直接响应 pointermove 事件，在低帧率设备上可能造成每帧多次重排。

---

*本方案基于 Agent 08 前端性能与 CSS 架构审计结果产出，对应的审计详情请参见 `agent-08-analysis.md`。*
