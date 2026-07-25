# Agent 08：Crish 前端性能与 CSS 架构审计报告

> 审计日期：2026-07-22
> 审计范围：`apps/crish-desktop` 全量 CSS、ResizeObserver 使用、组件渲染模式、拖拽性能
> 项目路径：`C:\Software\conex`

---

## 目录

1. CSS 架构审计
   - 1.1 CSS 变量系统完整性
   - 1.2 主题系统
   - 1.3 选择器特异性分析
   - 1.4 !important 滥用
   - 1.5 CSS Modules vs 全局 CSS 冲突
   - 1.6 未使用的 CSS
2. 布局性能审计
   - 2.1 contain 属性使用
   - 2.2 will-change 使用
   - 2.3 transform/opacity vs 布局属性
   - 2.4 GPU 合成层
   - 2.5 重排 (reflow) 触发分析
3. ResizeObserver 审计
   - 3.1 所有使用点清单
   - 3.2 挂起机制分析
   - 3.3 不必要的观测
4. 组件重渲染审计
   - 4.1 Zustand 选择器粒度
   - 4.2 React.memo 使用
   - 4.3 useMemo/useCallback 使用
   - 4.4 Context 问题
5. 拖拽性能审计
   - 5.1 DOM splice 性能影响
   - 5.2 CSS transition 禁用范围
   - 5.3 pointer-events 控制
6. 参考项目性能策略对比
   - 6.1 VS Code 的 CSS contain 策略
   - 6.2 DnD Kit 的性能优化
7. 根因总结

---

## 1. CSS 架构审计

### 1.1 CSS 变量系统完整性

**文件分布**：

| 文件 | 行数 | 角色 |
|------|------|------|
| `src/styles/tokens.css` | 729 | 核心变量定义（:root + dark + ui-size） |
| `src/styles/theme-dark.css` | 265 | 暗色组件覆盖 |
| `src/styles/shell/shell-workspace.css` | 761 | Shell 层 layout + chrome 样式 |
| `src/styles/shell/shell-dragdrop.css` | 132 | 拖拽系统专用 |
| `src/styles/shell/shell-sidebar.css` | 431 | 侧栏样式 |
| `src/styles/shell/shell-layout.css` | 298 | 顶层布局 |
| `src/styles/shell/shell-polish.css` | ~1200 | 全局工具类 + 样式修正 |
| `src/styles/chat.css` | 1247 | 对话流主样式 |
| `src/styles/panels.css` | 748 | 面板系统（Diff/Terminal/Tasks） |
| `src/styles/design-system.css` | 42 | 设计系统补充 |
| 各 `*.module.css` | 50+ 个文件 | 组件级局部样式 |

**变量系统评估：优秀**

tokens.css 提供了极其完整的 CSS 变量体系，覆盖：

- 背景色阶梯（`--bg-primary` / `--bg-secondary` / `--bg-tertiary` / `--bg-card` / `--bg-elevated`）
- 文字色阶梯（`--text-primary` / `--text-secondary` / `--text-tertiary`）
- 边框色体系（`--border-color` / `--border-subtle` / `--hairline` / `--hairline-strong`）
- 圆角阶梯（`--radius-xs` ~ `--radius-full`）
- 阴影系统（`--shadow-sm` / `--shadow-md` / `--shadow-lg` / `--shadow-drag` / `--shadow-2xl`）
- 间距系统（`--space-0_5` ~ `--space-16`）
- 字号系统（`--font-size-xxs` ~ `--font-size-2xl`，支持 `--font-size-adjust` 整体缩放）
- 字重阶梯（`--font-weight-code` ~ `--font-weight-heavy`）
- 行高体系（`--line-height-tight` / `--line-height-body` / `--line-height-relaxed` 等）
- 控件尺寸（`--control-height` / `--control-height-sm` / `--control-height-lg`）
- 图标尺寸（`--icon-size` / `--icon-size-sm` / `--icon-size-lg`）
- 过渡曲线（`--transition-spring` / `--transition-micro` / `--transition-fast` / `--transition-smooth` 等 10+ 条）
- z-index 层级体系（`--z-sidebar` / `--z-popover` / `--z-drag-overlay` / `--z-modal` 等）
- 语义色（`--color-success` / `--color-warning` / `--color-error` / `--color-info`）

**优点**：
- 变量命名高度一致，均以 `--` 开头、kebab-case
- 几乎所有硬编码值都已替换为 CSS 变量引用
- 过渡时间、圆角、间距都有统一的 token 层

**问题**：
- tokens.css 中 `--space-0.5` 和 `--space-0_5` 重复定义（L254 和 L271），`--space-1.5` 和 `--space-1_5` 也重复
- `--chat-col-max` 标注 `overridden by JS constants at runtime`，表明 JS 运行时覆盖 CSS token，造成双源问题
- `--sidebar-width` 同标注，JS 运行时覆盖
- `shell-workspace.css` 中大量乱码中文注释（GBK 遗留），影响文件可维护性
- `--font-size-chat` 在 tokens.css L207 定义但在其他文件中未复用，各组件直接使用 `--font-size-sm` 或 `--font-size-base`
- 部分 token 使用了 `--accent-color, #1a73e8` fallback 但 `--accent-color` 已在 tokens.css 中定义，fallback 多余

### 1.2 主题系统

**审计内容**：light / dark 双主题 + 性能分层 + UI 尺寸缩放

**Light 主题**（`:root` / `html[data-theme="default"]` / `html[data-theme="light"]`）：
- 完整定义所有颜色变量在 `tokens.css:3-338`
- 使用暖灰中性调（hsl(35, ...)），避免蓝紫色调

**Dark 主题**（`html[data-theme="dark"]`）：
- 完整覆盖在 `tokens.css:346-461`
- 使用炭灰（hsl(0, 0%, 5%) ~ hsl(0, 0%, 18%)）
- 语义色同步调整（绿色/红色/橙色/蓝色的 dark 变种）
- 阴影在暗色下加浓（shadow-color 不透明度从 1.5% 提高到 15%+）
- `theme-dark.css` 提供组件级暗色修正（265 行），覆盖输入壳、代码块、表格、开关、弹层等

**性能分层**（`data-perf-tier`）：
- `high`：完整动画、backdrop-filter
- `balanced`：去掉 backdrop-filter（blur 归零），用 solid bg 替代
- `eco`：所有 transition 禁用（`0ms !important`），最高性能

**UI 尺寸缩放**（`data-ui-size`）：
- `small`：字号降 1px、控件高度降 2px、间距减半
- `large`：字号升 2px、控件高度升 2px、间距加 50%
- 所有 token 使用 `calc()` 相对基准计算，支持动态调整 `--font-size-adjust`

**问题**：
- `theme-dark.css` 大量使用 `:where(html[data-theme="dark"])` 包装，特异性为 0-0-0，但内部选择器（如 `.msg-user-bubble`）本身有较高特异性，依赖其他选择器优先级
- 暗色主题的 `--accent-color` 在 light 中为 `hsl(35, 16%, 15%)`（暖深炭色），在 dark 中为 `#f8fafc`（亮白），跳度过大
- 没有 `data-theme="high-contrast"` 支持，无障碍层面缺失
- `prefers-color-scheme` 媒体查询未使用，主题切换完全依赖 JS 控制 `data-theme` 属性

### 1.3 选择器特异性分析

**风险区域**：

1. **双层属性选择器 + 类名链**（shell-workspace.css）：
   `.app-container[data-shell-chrome="inset"] .workspace-card:not(.workspace-card--no-chat-chrome) .card-tab.active`
   → 特异性极高（0-4-3）
   → 任何覆盖都需要同等特异性，导致 `!important` 扩散

2. **`:where()` 降权滥用**（theme-dark.css）：
   所有规则使用 `:where(html[data-theme="dark"])` 包裹 → 特异性 0-0-0
   → 内部选择器须依赖自身特异性，容易与正常规则冲突
   → 例如 `.msg-user-bubble` 与 `:where(html[data-theme="dark"]) .msg-user-bubble` 特异性不同，导致覆盖困难

3. **长选择器链**（chat.css）：
   `.card-header-left.chat-breadcrumb-header`（0-2-0）
   `.chat-breadcrumb-header .breadcrumb-item`（0-1-1）
   → 非模块化，容易与相同类名冲突

4. **冲突案例**：
   - `shell-workspace.css L952` 和 L977 重复定义 `.card-tab.active`，一个在前一个在后，后者覆盖前者
   - `shell-sidebar.css L17` 和 `shell-dragdrop.css L2` 重复定义 `sidebar.collapsed`
   - 全局 `.card-header` 在 `shell-workspace.css` 和 `chat.css` 中均有定义，互相覆盖

### 1.4 !important 滥用

**统计结果**：

| 文件区域 | !important 计数 | 典型场景 |
|----------|----------------|----------|
| `shell-polish.css` | 100+ | 工具类（`.m-0`、`.mt-0-5`）、菜单、下拉面板全部属性 |
| `shell-workspace.css` | 80+ | 背景色覆盖、border-radius 归零、`background: transparent` |
| `shell-dragdrop.css` | 15+ | 拖拽期间 `transition: none !important`、`pointer-events: none !important` |
| `shell-sidebar.css` | 12+ | 搜索输入框全覆盖 |
| 各 `.module.css` 文件 | 100+ | 强制组件内样式覆盖外部全局样式 |
| `chat.css` | 30+ | 图标尺寸（`14px !important`）、工具行分隔线 |

**典型滥用案例**：

```css
/* shell-polish.css - 菜单每一项都 !important */
.dropdown-item {
  display: flex !important;
  align-items: center !important;
  justify-content: flex-start !important;
  gap: var(--space-2) !important;
  width: 100% !important;
  min-height: 28px !important;
  padding: 5px 8px !important;
  border-radius: var(--radius-sm) !important;
  font-size: var(--font-size-sm) !important;
  color: var(--text-primary) !important;
  border: none !important;
  background: transparent !important;
  cursor: pointer !important;
  box-sizing: border-box !important;
  transition: background var(--transition-micro), color var(--transition-micro) !important;
  text-align: left !important;
  white-space: nowrap !important;
  font-family: inherit !important;
  font-weight: var(--font-weight-normal) !important;
}
```

一个选择器 20 个 `!important`，说明特异性管理完全失效。

**根因**：
- CSS Modules 的局部作用域与全局 CSS 冲突，开发者用 `!important` 强制覆盖
- shell-polish.css 的全局工具类需要对抗更具体的选择器
- 长链选择器导致后继新组件需要 `!important` 来突破

### 1.5 CSS Modules vs 全局 CSS 冲突

该项目的 CSS 架构采用混用模式：
- 50+ 个 `.module.css` 文件（组件级）
- 15+ 个全局 `.css` 文件（shell/chat/panels/settings）
- 全局 CSS 在 `App.tsx` 中通过 `import './styles/...'` 引入

**冲突表现**：
1. **全局 CSS 污染组件**：`shell-workspace.css` 中的 `.card-header`、`.card-tab`、`.tabs-bar`、`.card-body` 等是全局类，而同名 CSS Modules 类通过 `composes` 或全局选择器引用，造成样式来源不明
2. **双侧重复定义**：`.card-tab.active` 同时在 `shell-workspace.css`（L952, L977）和 `CardPanel.module.css`（导入）中定义
3. **CSS Modules 使用 `:global` 逃逸**：`Workspace.module.css` L102-107 使用了 `:global(.is-resizing) .column` 逃逸到全局命名空间
4. **ChatCard.module.css 大量 !important**：整个组件样式几乎全部 `!important`（L107-149），说明 CSS Modules 的局部作用域被全局样式完全覆盖

**推荐方案**：
- 新组件优先使用 CSS Modules
- 全局 CSS 逐步迁移到 CSS Modules
- 建立命名空间约定（如全局工具类加 `cds-` 前缀）

### 1.6 未使用的 CSS

通过 grep 交叉引用类名使用情况，发现以下可能未使用的 CSS：

- `shell-layout.css` 中的 `.navigation-arrows`、`.header-btn:disabled`（L193-203）：未在组件中找到引用
- `panels.css` 中的 `.telemetry-title`、`.cron-panel-title` 等（L374-445）：legacy telemetry 类，标注 `Legacy telemetry class aliases`
- `shell-polish.css` 中的大段工具类如 `.mt-0-5`、`.mb-0` 等：部分使用，部分可能已冗余
- `design-system.css` 中的 `--slate-0` ~ `--slate-11`（L5-17）：定义了整套 slate 色板但未被 tokens.css 引用

---

## 2. 布局性能审计

### 2.1 contain 属性使用

**当前使用情况**（仅 9 处）：

| 文件 | 选择器 | contain 值 | 评估 |
|------|--------|-----------|------|
| `Workspace.module.css:96` | `.column` | `layout style` | 合理：列容器需要布局隔离 |
| `Sidebar.module.css:15` | `.sidebar` | `layout paint style` | 合理：侧栏独立滚动区域 |
| `ChatMessageRow.module.css:446` | `.row` | `layout style` | 合理：虚拟列表行需要隔离 |
| `ChatToolCallBlock.module.css:26` | `.shell` | `layout style` | 合理 |
| `ChatToolCallBlock.module.css:44` | `.expand` | `none` | 特殊：展开时需要解除 contain |
| `ChatToolCallBlock.module.css:52` | `.collapse` | `none` | 特殊：折叠时解除 |
| `ChatToolCallBlock.module.css:201` | `.spinner` | `content` | 合理：内容独立 |
| `SidebarSessionList.module.css:29` | `.list` | `layout style` | 合理 |
| `SidebarSessionList.module.css:39` | `.reorder` | `content` | 合理 |

**严重不足**：
- 整个项目中只有 9 处使用 `contain`，对于拥有数百个 DOM 节点的虚拟列表、对话流、diff 面板等高频更新区域，contain 覆盖严重不足
- `chat-doc-flow`、`.card-body`、`.workspace-card`、`.chat-message-list` 等关键滚动容器均未设置 `contain`
- `.workspaces-stack` 使用了 `transform: translateZ(0)`（L236）但没有 `contain: paint`，前者只是创建合成层，后者才能真正裁剪溢出

**建议注入 `contain: paint layout style` 的候选元素**：
- `.chat-doc-flow` — 对话流滚动容器
- `.card-body` — 面板内容区域
- `.workspace-card` — 卡片容器
- `.chat-message-list` — 消息列表
- `.diff-panel` — diff 面板
- `.msg-assistant-text` / `.msg-user-bubble` — 消息气泡
- 虚拟列表的所有行（VirtualList.tsx 中的行元素）

### 2.2 will-change 使用

**当前使用情况**（仅 2 处）：

| 位置 | 值 | 评估 |
|------|-----|------|
| `SidebarSessionList.module.css:28` | `grid-template-rows` | **不推荐**：在 CSS 文件中静态声明 will-change，会导致浏览器持续预留优化资源 |
| `useTabDrag.ts:1191`（内联） | `transform` | 合理：在拖拽开始时动态设置，拖拽结束后应清除 |

**问题**：
- `SidebarSessionList.module.css` 中的 `will-change: grid-template-rows` 是静态写在 CSS 文件中的，违反了 MDN 规范"不要静态声明 will-change"
- 动态操作（如 drag overlay）使用 `will-change: transform` 是正确做法
- 缺少其他关键动画属性的 will-change 声明：
  - 拖拽预览（`.drag-overlay-preview-card`）未设 `will-change: transform`
  - tab 的 `opacity` 过渡未设 `will-change: opacity`
  - 侧栏展开/折叠过渡未设 `will-change: transform`

### 2.3 transform/opacity vs 布局属性

**好的做法**：
- 侧栏动画使用 `transform: translateX(-100%)`（shell-dragdrop.css L29）→ 仅 composite
- tab 关闭按钮使用 `opacity` 过渡（shell-workspace.css L944, L1020）→ 仅 composite
- 列分割器使用 `left/top` + `transition`（Workspace.module.css L117, L164）→ **触发 layout**
- `VirtualList.tsx` 使用 `transform: translateY()` 定位虚拟行 → 仅 composite ✓
- 动画关键帧仅使用 `opacity` 和 `transform: scale()/translateY()` → 仅 composite ✓

**坏的做法**：
- `.workspace-card` 使用 `transition: height var(--transition-fast)`（shell-workspace.css L747）→ **触发 layout + paint + composite**，最昂贵
- `.card-header` 使用 `transition: background-color` → 触发 paint + composite，可接受但非最优
- `.search-bar` 使用 `transition: border-color var(--transition-micro)` → 触发 paint + composite
- `.section` 使用 `transition: opacity var(--transition-fast), outline var(--transition-fast)` → 合理（opacity 仅 composite）
- 列分割器 `transition: left var(--transition-fast)`（Workspace.module.css L117）→ **触发 layout**

### 2.4 GPU 合成层

**当前提升层的做法**：

```css
.workspaces-stack {
  transform: translateZ(0);           /* shell-workspace.css L236 */
  -webkit-backface-visibility: hidden;
  backface-visibility: hidden;
}
```

这强制 `.workspaces-stack` 创建 GPU 合成层。除此之外，项目中几乎没有其他的合成层提升策略。

**问题**：
- 大量悬浮/弹层（`.agent-more-menu`、`.panel-dropdown`、`.chat-scroll-fab`）未主动提升为合成层
- 拖拽叠层 `.drag-overlay-preview-card` 使用 `position: fixed` + `z-index: var(--z-drag-overlay)`，没有 `will-change: transform` 或 `transform: translateZ(0)` 触发 GPU 合成
- 没有使用 `contain: paint` 来创建合成层 + 裁剪边界

### 2.5 重排 (reflow) 触发分析

**检测到的强制重排风险点**：

1. **VirtualList.tsx L52**：`node.clientHeight` 在 callback ref 中读取 → 触发强制同步布局
2. **FilesCard.tsx L92**：`ResizeObserver` 回调中读取布局属性 → 潜在布局抖动
3. **ChatMessageList.tsx L639-652**：`useTextMeasure` 的 compute 中可能读取 `clientWidth`
4. **SidebarSessionList.tsx L669**：拖拽时设置 `transform: translate(dx, dy)` 后立刻读取 → 强制同步布局
5. **useTabDrag.ts**：大量内联样式操作可能导致布局抖动

**比较好的做法**：
- `useSuspendedResizeObserver` 使用 rAF 批处理回调
- `layoutAnimationStore` 的 `flushCatchupTasks` 使用 `flushSync` 批量执行
- `.window-resizing` 期间禁用所有过渡

---

## 3. ResizeObserver 审计

### 3.1 所有使用点清单

| # | 文件 | 行号 | 用途 | 必要？ |
|---|------|------|------|--------|
| 1 | `useVirtualScroll.ts` | L76 | 虚拟滚动容器高度测量 | 是 |
| 2 | `useVirtualDiffScroll.ts` | L12 | Diff 虚拟滚动 | 是 |
| 3 | `useTextMeasure.ts` | L127 | 文本宽度计算（BubbleShrinkWidth） | **可移除** |
| 4 | `useSuspendedResizeObserver.ts` | L41 | 通用可挂起观察器 | 是 |
| 5 | `useAutoGrowTextarea.ts` | L140 | Textarea 自动增高 | 是 |
| 6 | `VirtualList.tsx` | L54 | 通用虚拟列表容器高度 | 是 |
| 7 | `ChatMessageList.tsx` | L639, 722 | 虚拟消息行高度回写 | 是 |
| 8 | `FilesCard.tsx` | L92 | 文件卡片高度自适应 | 是 |
| 9 | `ChatToolCallBlock.tsx` | L232 | 工具调用块高度测量 | 是 |
| 10 | `SidebarSessionList.tsx` | L268 | 侧栏会话列表高度 | 是 |
| 11 | `TerminalCard.xterm.tsx` | L131 | Terminal fit 自适应 | 是 |

共 **11 个使用点**，其中 10 个为独立 `new ResizeObserver`，1 个封装为 `useSuspendedResizeObserver` 复用。

**问题**：
- **10 个独立 Observer 实例**，每个都独立创建 `new ResizeObserver`，违反了规划文档中"全局单例 ResizeObserverManager"的设计目标
- `useTextMeasure.ts` 的 ResizeObserver 属于历史遗留 `useBubbleShrinkWidth` 功能，应彻底移除（已在规划中但未执行）
- 没有统一的 observer 注册/注销管理，容易出现内存泄漏（`VirtualList.tsx L54` 返回的 cleanup 函数未正确处理）

### 3.2 挂起机制分析

**当前冻结挂起系统**：

```
layoutAnimationStore (zustand)
  ├── isLayoutFrozen: boolean
  ├── startAnimation(type) → activeAnimations.add(type) → isLayoutFrozen = true
  ├── endAnimation(type) → activeAnimations.delete(type) → isLayoutFrozen = false
  ├── catchupQueue: Map<key, task>
  ├── registerCatchupTask(key, task)
  └── flushCatchupTasks() → flushSync(catchupQueue.forEach(...))
```

**消费者**：

```
useSuspendedResizeObserver → 订阅 isLayoutFrozen → 冻结时跳过回调 → 注册 catchup
useResizeFreeze → 订阅 isLayoutFrozen → 返回 isResizing (带 debounce)
ChatMessageList → useResizeFreeze + 直接读取 isLayoutFrozen → 双重守卫
FilesCard → 直接读取 isLayoutFrozen → 冻结时跳过
TerminalCard.xterm → useSuspendedResizeObserver → 冻结时挂起
```

**评估：设计良好，执行有遗漏**

- ✅ `useSuspendedResizeObserver` 正确地在冻结时跳过回调、使用 catchup 队列
- ✅ `useResizeFreeze` 提供了 150ms debounce，防止解冻后立即抖动
- ✅ `ChatMessageList` 双重守卫（isResizing + isLayoutFrozen）
- ✅ `layoutAnimationStore` 使用 `flushSync` 批量执行 catchup

- ❌ `VirtualList.tsx` 中的 ResizeObserver **未使用挂起机制**
- ❌ `useAutoGrowTextarea.ts` 中的 ResizeObserver **未使用挂起机制**
- ❌ `SidebarSessionList.tsx` 中的 ResizeObserver **未使用挂起机制**
- ❌ `useTextMeasure.ts` 中的 ResizeObserver **未使用挂起机制**

### 3.3 不必要的观测

1. **`useTextMeasure.ts`** 中的 `useBubbleShrinkWidth`：
   - 这是一个已知的遗留问题，已在多个规划文件中标记为移除
   - 它为每个消息气泡绑定 ResizeObserver，读取 `clientWidth` 计算缩进
   - 应改为 CSS `fit-content` / `max-width` 方案
   - 参考：`docs/refactor-guides/01-CHAT-LIST-AND-PRETEXT-REFACTOR-GUIDE.md`

2. **`VirtualList.tsx`** 中的 ResizeObserver：
   - 用于监测容器高度变化
   - 替代方案：使用 `useSuspendedResizeObserver` 统一管理

3. **`SidebarSessionList.tsx`**：
   - 使用 ResizeObserver 更新布局
   - 替代方案：使用 `useSuspendedResizeObserver`

---

## 4. 组件重渲染审计

### 4.1 Zustand 选择器粒度

**当前模式**：几乎全部使用细粒度选择器

```tsx
// ✅ 好的：单个字段选择
const sidebarCollapsed = useLayoutStore((s) => s.sidebarCollapsed);
const setSidebarCollapsed = useLayoutStore((s) => s.setSidebarCollapsed);

// ⚠️ 中等：多个字段但仍有意义
const workspaceIdsStr = useLayoutStore((s) => ...);

// ❌ 坏的模式（未发现）：
// useLayoutStore((s) => s) // 全量订阅 — 未使用
```

**评估：优秀**
- 所有 100+ 个 selector 都是单字段或小计算
- 没有发现全量 store 订阅（`useStore(s => s)`）
- 多个 store 分离（`useLayoutStore` / `useWorkspaceStore` / `useSessionStore` / `useCapabilitiesStore` / `useSettingsUiStore` / `useLayoutAnimationStore`）

**问题**：
- 但 `CardPanel.tsx` 中有 `const draggedTab = useLayoutStore((s) => s.draggedTab)` 和 `const dropPreview = useLayoutStore((s) => s.dropPreview)` 分开选择，理论上可以合并为一个 selector 减少两次 store 订阅
- 一些组件（如 `ChatCard.tsx`、`Sidebar.tsx`）从 store 中选择了 10+ 个字段，每个字段独立 selector，虽然精细但 hook 调用次数多，可以考虑 zustand 的 `useStore` + 对象选择器

### 4.2 React.memo 使用

**已使用 React.memo 的组件（14 个）**：

```
ChatMessageRow (User + Assistant) → 正确：消息行是高频更新点
ChatMessageList → 正确：列表容器
ChatCard → 正确：卡片容器
AgentCard → 正确
AgentTeamBoard → 正确
CardPanel → 正确
ChatComposer (ComposerField) → 正确
DiffCard → 正确
OverviewCard → 正确
Sidebar → 正确
Workspace → 正确
SettingsSchemaRenderer → 正确
```

**评估：良好但可扩展**
- 关键高频渲染组件（消息行、列表、卡片）都已 memo
- 缺少 memo 的候选：
  - `ChatToolCallBlock` — 每个工具调用都重新渲染
  - `ChatStatusRibbons` — 高频状态更新
  - `FilesCard` — 文件列表更新
  - `Settings*Tab` 系列 — 虽然不是高频，但可以阻止无关更新

### 4.3 useMemo/useCallback 使用

**100+ 处使用**，覆盖：
- 派生数据（`useMemo`）
- 事件处理器（`useCallback`）
- 菜单/命令列表（`useMemo`）
- 样式计算（`useMemo` 返回 CSSProperties）

**典型良好实践**：
```tsx
// ✅ 派生数据缓存
const expandedTools = useMemo(() => new Set(expandToolIds), [expandToolIds]);

// ✅ 事件处理器稳定引用
const togglePin = useCallback((msgId: string) => { ... }, [deps]);
```

**问题**：
- 部分 `useCallback` 的依赖数组不完整（如 `ChatMessageList.tsx L459` 的 `onToggleExpandUser`）
- 部分 `useMemo` 计算过于简单（如 `ChatMessageList.tsx L553` 的 `visibleIds = visibleMessages.map(m => m.id)`），理论上 React 的 reconciliation 不需要此层缓存
- `ChatCard.tsx` 中有大量 `useCallback`（20+），部分处理器的依赖数组包含了整个 store 选择的值，导致 memo 失效

### 4.4 Context 问题

**唯一的 Context 使用**：

```
NowTickContext (SidebarSessionList.tsx L84)
  Provider in SidebarSessionList (L1296)
  Consumer in SidebarSessionListItem (L94)
```

这是一个用于"时间 tick"的 Context，目的是让侧栏会话列表中的时间显示自动更新。

**评估：安全**
- Context 只用于一个简单数字（`Date.now()` 的 tick）
- 作用域限于 `SidebarSessionList` 内部，不会引起全局重渲染
- 没有发现其他滥用 Context 的情况

**其他发现**：
- 没有发现 `createContext` 在全局状态中使用（zustand 已替代 Context 作为全局状态方案）
- `CardPanel.tsx` L82 注释提到"菜单挂 body 用 fixed 视口坐标"，使用 portal 绕过父级 transform，这是正确做法

---

## 5. 拖拽性能审计

### 5.1 DOM splice 性能影响

**当前拖拽实现**：
- Tab 拖拽：`useTabDrag.ts` 自定义拖拽实现
- 卡片拖拽：`shell-dragdrop.css` 配合 DnD
- 侧栏会话拖拽：`SidebarSessionList.tsx` 自定义实现

**DOM 操作模式**：
- Tab 拖拽使用 `insertBefore` / `appendChild` 进行 DOM splice
- 侧栏会话使用 `transform: translate(dx, dy)` 做视觉拖拽，松手后提交 DOM 变更

**问题**：
- 高频 DOM splice 操作（尤其是 DnD 场景）会触发 Layout Shift 和重排
- Tab 条 `overflow-x: auto` + DOM splice 会导致浏览器重新计算所有子元素尺寸
- 没有使用 `contain: layout style` 来隔离拖拽影响的范围

### 5.2 CSS transition 禁用范围

**当前禁用策略**（shell-dragdrop.css L39-56）：

```css
body.is-resizing *,
body.is-resizing *::before,
body.is-resizing *::after,
body.resizing-active *,
body.resizing-active *::before,
body.resizing-active *::after,
body.window-resizing *,
body.window-resizing *::before,
body.window-resizing *::after,
body.dragging-card *,
body.dragging-card *::before,
body.dragging-card *::after,
body.is-layout-frozen *,
body.is-layout-frozen *::before,
body.is-layout-frozen *::after {
  transition: none !important;
  animation: none !important;
}
```

**评估：全面但粗放**
- ✅ 覆盖了所有需要禁用过渡的场景（resize、drag、window-resize、frozen）
- ✅ 使用 `*` 万能选择器确保无遗漏
- ✅ 同时覆盖 `::before` 和 `::after` 伪元素
- ❌ 过于粗放：`*` 选择器会对 10,000+ DOM 元素造成样式重新计算
- ❌ `animation: none !important` 可能导致某些必要动画（如 loading spinner）也被禁用
- ❌ 多个 body class 可以合并，减少选择器数量

**建议优化**：
- 将 `*` 改为 `*:not(.essential-animation)` 允许关键动画继续
- 使用 CSS 变量禁用过渡（参考 `eco` 性能层的做法）
- 合并冗余的 body class 选择器

### 5.3 pointer-events 控制

**当前控制**（shell-dragdrop.css L114-125）：

```css
body.is-layout-frozen iframe,
body.is-layout-frozen webview,
body.dragging-card iframe,
body.dragging-card webview,
body.is-resizing iframe,
body.is-resizing webview {
  pointer-events: none !important;
}
```

同时 `shell-workspace.css` L718-729 重复定义了完全相同的规则，形成双保险。

**评估：设计正确但重复**
- ✅ 冻结期间禁用 iframe/webview 的指针事件，防止交互冲突
- ✅ `!important` 在此场景正确（需要覆盖内联样式或更高特异性规则）
- ❌ `shell-dragdrop.css` 和 `shell-workspace.css` 中的规则完全重复，应统一到一处
- ❌ 拖拽期间的 `cursor: grabbing !important` 覆盖了所有子元素，可能导致某些可交互元素（如输入框）光标不正常

---

## 6. 参考项目性能策略对比

### 6.1 VS Code 的 CSS contain 策略

VS Code（Monaco Editor）的核心性能策略：
- 每个编辑器视图使用 `contain: strict` 隔离
- 行元素使用 `contain: layout style paint` 防止重排影响外部
- 滚动容器使用 `will-change: scroll-position` 优化滚动性能
- Minimap 使用 `contain: strict` 和 `transform: translateZ(0)`

**与本项目的对比**：

| 策略 | VS Code | Crish 当前 |
|------|---------|-----------|
| contain 覆盖 | 广泛（所有视图/行/面板） | 极少（仅 9 处） |
| will-change 使用 | 动态添加到滚动/动画元素 | 仅 2 处（1 处静态滥用） |
| GPU 合成层 | 弹层/滚动容器主动提升 | 仅 1 处 translateZ(0) |
| 虚拟列表 | 每个视图独立 containment | 无 containment |

### 6.2 DnD Kit 的性能优化

DnD Kit（可参考的拖拽库）的关键优化：
- 拖拽使用 `transform` 而非 `top/left`
- 使用 `will-change: transform` 提前创建合成层
- 拖拽覆盖层使用 `position: fixed` 避免触发父级 layout
- 使用 `pointer-events: none` 在拖拽期间禁用目标交互
- 使用 `requestAnimationFrame` 批处理传感器更新

**本项目的匹配度**：
- ✅ 拖拽覆盖层使用 `position: fixed`（.drag-overlay-preview-card）
- ✅ 使用 `pointer-events: none` 控制交互
- ✅ 侧栏会话拖拽使用 `transform: translate()`
- ❌ 缺少 `will-change: transform` 动态管理
- ❌ Tab 拖拽未批处理 DOM 操作
- ❌ 没有使用 `requestAnimationFrame` 传感器批处理（除了 `useSuspendedResizeObserver`）

---

## 7. 根因总结

### 根本问题 1：CSS 架构两套体系互搏

全局 CSS（shell-*.css、chat.css、panels.css）与 CSS Modules（*.module.css）共用同一命名空间，导致：
- CSS Modules 需要 `!important` 对抗全局样式
- 相同的选择器在多个文件中重复定义
- 特异性螺旋上升，出现长链选择器

### 根本问题 2：contain 属性覆盖严重不足

仅有 9 处 `contain` 声明，对于包含虚拟列表、动态对话流、侧栏会话列表、拖拽 UI 的复杂应用，contain 覆盖不足导致：
- 任何布局变化都可能影响全页面
- 浏览器无法将子树渲染隔离
- 滚动/动画性能受限

### 根本问题 3：ResizeObserver 多实例 + 遗漏挂起

11 个使用点中 10 个为独立实例，且 4 个未接入 `isLayoutFrozen` 挂起机制：
- 拖拽/动画期间仍触发 ResizeObserver 回调
- 重建布局时可能触发强制同步重排
- 未统一管理容易内存泄漏

### 根本问题 4：拖拽系统粗颗粒度锁定

`body.* *` 选择器禁用全部过渡和动画，影响范围过大：
- 即使无关元素也被禁用动画
- `*` 万能选择器对 10K+ DOM 元素造成样式重新计算
- 必要加载指示器被意外禁用

### 根本问题 5：历史遗留代码未清除

- `useBubbleShrinkWidth` 仍在运行（ResizeObserver + clientWidth 强制重排）
- GBK 乱码注释充斥 `shell-workspace.css` 和 `shell-sidebar.css`
- Legacy telemetry 类未清理
- 重复的 CSS 定义（tokens.css 中的 space 重复、card-tab.active 重复、iframe pointer-events 重复）

---

## 第 8 章：CSS 动画与过渡性能深度分析

### 8.1 过渡属性清单

以下是项目中所有使用 `transition` 的属性分布：

| 过渡属性 | 出现次数 | Pipeline 路径 | 评估 |
|---------|---------|-------------|------|
| `background-color` | 40+ | Paint + Composite | 可接受，但可改用 `opacity` |
| `color` | 20+ | Paint + Composite | 可接受 |
| `opacity` | 15+ | Composite ✅ | 最佳 |
| `transform` | 5+ | Composite ✅ | 最佳 |
| `border-color` | 8 | Paint + Composite | 可接受 |
| `box-shadow` | 3 | Paint + Composite | 注意：box-shadow 动画昂贵 |
| `width` | 2 | Layout + Paint + Composite ❌ | **应改为 transform** |
| `height` | 1 | Layout + Paint + Composite ❌ | **应改为 transform** |
| `left` | 1 | Layout + Paint + Composite ❌ | **应改为 transform** |
| `top` | 1 | Layout + Paint + Composite ❌ | **应改为 transform** |
| `outline` | 2 | Paint + Composite | 可接受 |
| `filter` | 1 | Paint + Composite | 昂贵 |

### 8.2 动画关键帧分析

```css
/* ✅ 好的：仅 composite */
@keyframes crish-popover-enter {
  0% { opacity: 0; transform: scale(0.96) translateY(-4px); }
  100% { opacity: 1; transform: scale(1) translateY(0); }
}

/* ✅ 好的：仅 composite */
@keyframes spin { to { transform: rotate(360deg); } }

/* ✅ 好的：仅 opacity */
@keyframes daemon-pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.45; } }

/* ⚠️ 可优化：多个属性动画 */
@keyframes msg-pin-flash-dark {
  0% { background: ...; }     /* → paint */
  100% { background: transparent; }  /* → paint */
}
/* 建议改为使用 ::after 伪元素 + opacity 动画替代 background 动画 */
```

### 8.3 will-change 候选清单

以下元素建议在变化前动态添加 `will-change`：

| 元素 | 场景 | 建议值 |
|------|------|--------|
| `.sidebar` | 侧栏展开/折叠 | `transform` |
| `.col-splitter` | 列分割拖拽 | `left` → 改为 `transform` 后省略 |
| `.group-splitter` | 行分割拖拽 | `top` → 改为 `transform` 后省略 |
| `.drag-overlay-preview-card` | 拖拽预览 | `transform` |
| `.tab-insert-line` | 拖拽插入指示线 | `opacity, width` |
| `.ui-popover-animate` | 弹层动画 | `opacity, transform` |
| `.ui-modal-animate` | 模态框动画 | `opacity, transform` |

### 8.4 prefers-reduced-motion 兼容性

当前 `reduced-motion.css` 的禁用方案（`animation-duration: 0.01ms !important`）虽然有效，但更好的做法是：

```css
/* ✅ 推荐：保留最终状态 */
@media (prefers-reduced-motion: reduce) {
  .ui-popover-animate {
    animation: none;
    opacity: 1;
    transform: none;
  }
  .ui-modal-animate {
    animation: none;
    opacity: 1;
    transform: none;
  }
}
```

## 第 9 章：CSS 选择器性能分析

### 9.1 昂贵选择器

以下选择器因匹配过程复杂应尽量避免：

```css
/* ❌ 通用选择器 + 属性选择器嵌套 */
body.is-layout-frozen * { transition: none !important; }

/* ❌ 多重否定 + 属性选择器 */
.app-container[data-shell-chrome="inset"]
  .workspace-card:not(.workspace-card--no-chat-chrome)
  .card-tab.active

/* ❌ :has() 选择器在大型文档中较慢 */
.card-body:has(.agent-panel-shell) { overflow: hidden; }
.card-body:has(.diff-panel) { overflow: hidden; }

/* ⚠️ [attr*="xxx"] 子串匹配比具体类慢 */
[class*="cds-animate-"] { animation: none !important; }
```

### 9.2 选择器匹配性能对比

| 选择器类型 | 匹配速度 | 项目中用例 |
|-----------|---------|-----------|
| `.class` | 最快 | 大量使用 |
| `#id` | 最快 | 极少使用 |
| `[attr]` | 快 | shell-workspace.css 大量 |
| `[attr="value"]` | 快 | shell-workspace.css 大量 |
| `:hover` | 中等 | 普遍 |
| `.a .b` (后代) | 中等 | panel.css 中 |
| `.a > .b` (子代) | 较快 | 少量 |
| `*` | 慢 | dragdrop.css 冻结选择器 |
| `:has()` | 较慢 | card-body 中 5 处 |
| `[class*="..."]` | 慢 | reduced-motion.css |

### 9.3 优化建议

1. 将 `*` 通用选择器替换为 CSS 变量方案（已在 plan 中）
2. `:has()` 仅用于小型子树，不应用于大型列表容器
3. 避免选择器最右端为 `*`（如 `.sidebar *`）

## 附录 A：CSS 文件详细统计

| 统计指标 | 数值 |
|---------|------|
| 全局 CSS 文件数 | 17 个（shell 系列 7 个 + chat 系列 3 个 + panels + settings 5 个 + 其他 2 个） |
| CSS Modules 文件数 | 53 个 |
| 总 CSS 行数 | ~12,000+ 行 |
| contain 使用次数 | 9 处 |
| will-change 使用次数 | 2 处（1 处静态不应） |
| isolation: isolate 使用次数 | 7 处 |
| @container 使用次数 | 13 处 |
| !important 总计数 | 300+ 处 |
| CSS 变量总数 | ~200 个 |
| 动画帧 (@keyframes) 数 | 12 个 |

## 附录 B：GC 与内存泄漏风险

1. **ResizeObserver 未正确断开**：VirtualList.tsx L54 的 `return () => ro.disconnect()` 在 callback ref 中实现，但 React 18 的回调 ref cleanup 仅在组件卸载时触发，re-render 时可能重复创建 observer
2. **Event Listener 未清理**：useTabDrag.ts 中的全局 pointer/mouse/touch 事件监听器在组件卸载时可能未清理
3. **CSS 动画未暂停**：关闭的弹层/面板的 CSS 动画未暂停（`animation-play-state: paused`），仍在消耗 GPU

## 附录 C：性能分层（data-perf-tier）使用情况

当前 tokens.css 定义了 `high` / `balanced` / `eco` 三个性能层次，但：

- 未找到任何组件代码中显式设置 `data-perf-tier` 属性的逻辑
- 没有根据设备能力自动检测并设置性能层次的机制
- 建议在应用启动时检测：`navigator.hardwareConcurrency` < 4 或设备内存 < 4GB 时自动设为 `eco`
- eco 层的 `transition: 0ms !important` 与拖拽系统的冻结选择器功能重叠，可以统一

## 附录 D：已规划但未执行的优化（交叉引用）

以下优化已在项目文档中规划，但在本次审计中确认尚未执行：

| 规划来源 | 规划内容 | 状态 |
|---------|---------|------|
| `docs/rust-architecture-redesign/07-FRONTEND-DOM-LAYOUT-AND-PERFORMANCE-REFACTOR.md` | ResizeObserverManager 单例 | 未实现 |
| `docs/refactor-guides/01-CHAT-LIST-AND-PRETEXT-REFACTOR-GUIDE.md` | 移除 useBubbleShrinkWidth | 未执行 |
| `COMPREHENSIVE-REFACTOR-PLAN.md` | layoutStore 添加 viewport + ResizeObserver auto-update | 未执行 |
| `multi_agent_execution_guide.md` | body.resizing-active 期间 ResizeObserver 跳过行高写入 | 部分执行 |

## 附录 F：tailwind / stylelint / CSS 工具链审计

当前项目的 CSS 工具链：

- `eslint.config.js`：未配置 CSS lint 规则
- `.stylelintrc.cjs`：项目根目录存在该文件，应配置 CSS 规则检测
- 无 CSS 模块化构建的自定义 plugin（使用 Vite 默认 css.modules）
- 无 CSS 压缩 plugin（Vite 内置）
- 无 CSS 无用类检测（如 PurgeCSS / UnCSS）

**建议增强配置**：

```js
// stylelintrc.cjs 增强
module.exports = {
  rules: {
    'declaration-no-important': true,                    // 禁止 !important
    'selector-max-specificity': '0-3-3',                 // 限制特异性
    'selector-max-compound-selectors': 4,                // 限制复合选择器
    'max-nesting-depth': 3,                              // 限制嵌套深度
    'property-disallowed-list': ['width', 'height', 'left', 'top'], // 禁用动画中的布局属性
    'at-rule-allowed-list': ['import', 'media', 'container', 'keyframes', 'layer', 'supports'],
  }
};
```

## 附录 G：Chrome Performance Trace 关键指标解读

根据项目历史性能 trace 数据（567 MB real trace）：

| 指标 | 数值 | 目标 |
|------|------|------|
| 点击到响应的延迟 | 8.9 秒 | ≤100ms |
| 强制同步重排次数 | 1,573 次 | 0 次 |
| ResizeObserver 实例数 | 106 个 | 1 个 |
| 单帧 JS 执行时间 | 37.6ms | ≤10ms |
| 单帧 Layout 时间 | 21.8ms | 0ms (transform-only) |
| 单帧 Paint 时间 | 14.2ms | 0ms (composite-only) |
| 总 DOM 节点数 | 15,000+ | 优化 contain 后可减少到子树的 1/10 |
| FPS (低配设备 4x slowdown) | ~8fps | ≥30fps |

这些数据表明，最严重的性能瓶颈是**强制同步重排**和**漫无边际的 Layout 传播**，而这两个问题都可以通过本方案中的 contain 注入 + ResizeObserver 单例 + useBubbleShrinkWidth 移除来显著改善。

## 附录 H：已存在但未使用的 CSS 变量

通过 tokens.css 分析，以下变量定义但未被（其他 CSS 文件）引用：

| 变量 | 位置 | 备注 |
|------|------|------|
| `--font-size-chat` | L207 | 未在其他 CSS 中使用 |
| `--font-size-nano` | L202 | 仅 panels.css 引用 |
| `--font-size-micro` | L203 | 未找到引用 |
| `--font-size-xs-plus` | L204 | 未找到引用 |
| `--font-size-sm-plus` | L205 | 未找到引用 |
| `--transition-enter` | L154 | 未找到引用 |
| `--transition-exit` | L155 | 未找到引用 |
| `--transition-popover-enter` | L157 | tokens.css 内部引用 |
| `--transition-popover-exit` | L158 | tokens.css 内部引用 |
| `--easing-*` | L172-174 | 未在其他 CSS 中使用 |
| `--letter-spacing-*` | L218-223 | 少量引用 |
| `--opacity-disabled` | L234 | 未找到引用 |

这些冗余变量增加了 CSS 的维护成本，可以考虑在 P2 阶段清理。

## 附录 E：浏览器渲染 Pipeline 参考

根据 web.dev 的渲染性能指南和 CSS containment 规范，Crish 项目的优化应聚焦于：

1. **JS → Style → Layout → Paint → Composite**（完整 pipeline）：宽度/高度变化 → **避免**
2. **JS → Style → Paint → Composite**（跳过 Layout）：颜色/背景/阴影变化 → **尽量减少**
3. **JS → Style → Composite**（仅 Composite）：transform/opacity 变化 → **首选**

当前项目中：
- 对话流滚动、面板切换、虚拟列表 → 应走路径 3
- 主题切换（颜色变化）→ 路径 2（可接受）
- 拖拽 → 路径 3（已使用 transform）
- 列宽调整 → 路径 1（应改为 transform）

---

*本报告为 Agent 08 前端性能与 CSS 架构审计的完整分析部分，对应的重构方案请参见 `agent-08-plan.md`。*
