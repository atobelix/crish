# Crish 展开面板系统重构方案

> 基于 3 个 Agent 交叉分析：24 个面板的动画、样式、交互、焦点、Portal 全面审计

---

## 目录

1. [现状总览](#1-现状总览)
2. [面板分类体系](#2-面板分类体系)
3. [统一动画系统](#3-统一动画系统)
4. [统一交互规范](#4-统一交互规范)
5. [统一视觉规范](#5-统一视觉规范)
6. [Portal 策略](#6-portal-策略)
7. [实施步骤](#7-实施步骤)

---

## 1. 现状总览

### 1.1 24 个面板按类型分布

| 类型 | 数量 | 面板 |
|------|------|------|
| Simple Dropdown | 5 | SettingsSelect, ModelPicker, ProjectPickerMenu, PermissionModeMenu, ChromeAddMenu |
| Cascading Dropdown | 3 | ModelsCascadeSelect, ModelBadgePickerMenu, SidebarSortFilterDropdown |
| Context Menu | 1 | SidebarSessionContextMenu |
| Toolbar Menu | 6 | ChatHeaderMore, ComposePlusMenu, SettingsQuickMenu, CardPanel TabAddMenu, FilesCard MoreMenu, FilesCard OpenMenu |
| Flyout Panel | 2 | FilesCardBcFlyout, PreviewCardHistory |
| Modal Dialog | 4 | SettingsUsageModal, CheatsheetModal, SettingsRulesEditingDialog, SettingsSecurityClearConfirm |
| Fullscreen Overlay | 2 | SettingsPanel, FirstRunWizard |
| Sliding Drawer | 1 | ChatStatusRibbons PlanDrawer |

### 1.2 严重问题优先级

| 优先级 | 问题 | 影响面板 |
|--------|------|---------|
| **P0** | ModelBadgePickerMenu 点击闪烁打开/关闭 | #16 |
| **P0** | SidebarContextMenus 飞延子菜单悬停闪烁 | #10-12 |
| **P1** | 退出动画缺失（24 个中仅 3 个有完整退出动画） | 全部 |
| **P1** | Escape 键未统一处理 | 7+ 面板 |
| **P1** | 焦点还原缺失（仅 8/24 实现） | 16 个面板 |
| **P2** | Portal 使用不一致（仅 6/24 使用） | 多个 |
| **P2** | 阴影样式不一致 | 5 个面板 |
| **P2** | hover 子菜单无 debounce | ModelBadgePickerMenu, SidebarFlyouts |

---

## 2. 面板分类体系

### 2.1 新建面板组件层级

```
components/
├── panels/
│   ├── base/
│   │   ├── PanelPortal.tsx         ← Portal + 定位 + z-index
│   │   ├── usePanelToggle.ts       ← 统一 toggle hook（防抖、Escape、click-outside、焦点）
│   │   └── PanelTransition.css     ← 统一动画关键帧
│   ├── dropdown/
│   │   ├── DropdownPanel.tsx       ← Simple Dropdown
│   │   ├── CascadingDropdown.tsx   ← 级联下拉
│   │   └── ToolbarMenu.tsx         ← 工具栏「…」菜单
│   ├── flyout/
│   │   └── FlyoutPanel.tsx         ← 信息飞出面板
│   ├── modal/
│   │   ├── ModalDialog.tsx         ← 模态对话框
│   │   └── FullscreenOverlay.tsx   ← 全屏覆盖层
│   └── context/
│       └── ContextMenu.tsx         ← 右键菜单
```

### 2.2 核心 hook：`usePanelToggle`

```typescript
interface UsePanelToggleOptions {
  onOpen?: () => void;
  onClose?: () => void;
  /** 关闭方式 (默认 'all') */
  closeOnClickOutside?: boolean;
  closeOnEscape?: boolean;
  closeOnSelect?: boolean;
  /** 焦点管理 */
  restoreFocusOnClose?: boolean;
  focusFirstOnOpen?: boolean;
  /** Portal */
  usePortal?: boolean;
  /** z-index token */
  zIndex?: string;
}

interface UsePanelToggleReturn {
  open: boolean;
  setOpen: (v: boolean) => void;
  toggle: () => void;
  
  // Refs
  triggerRef: React.RefObject<HTMLElement>;
  panelRef: React.RefObject<HTMLElement>;
  
  // Portal
  portalRoot: HTMLElement | null;
  
  // 动画状态
  animationState: 'entering' | 'open' | 'exiting' | 'closed';
  onAnimationEnd: () => void;
}
```

#### 防抖/防闪烁设计

```typescript
// 核心：使用 useEffectEvent 和 RAF 防止闪烁
function usePanelToggle(options: UsePanelToggleOptions) {
  const [open, setOpen] = useState(false);
  const [animationState, setAnimationState] = useState<'closed'>('closed');
  const toggleLockRef = useRef(false);
  
  const toggle = useCallback(() => {
    // 防抖：连续快速点击不重置动画
    if (toggleLockRef.current) return;
    toggleLockRef.current = true;
    
    if (open) {
      setAnimationState('exiting');
    } else {
      setOpen(true);
      setAnimationState('entering');
    }
    
    // 50ms 后释放锁
    setTimeout(() => { toggleLockRef.current = false; }, 50);
  }, [open]);
}
```

---

## 3. 统一动画系统

### 3.1 动画时长与缓动

| 方向 | 动画名 | 时长 | 缓动函数 | 适用类型 |
|------|--------|------|---------|---------|
| 进入 | `panel-enter` | 150ms | `cubic-bezier(0.16,1,0.3,1)` | Simple Dropdown, Toolbar Menu |
| 退出 | `panel-exit` | 100ms | `cubic-bezier(0.4,0,1,1)` | Simple Dropdown, Toolbar Menu |
| 进入 | `popover-enter` | 180ms | `cubic-bezier(0.16,1,0.3,1)` | Cascading Dropdown, Flyout |
| 退出 | `popover-exit` | 120ms | `cubic-bezier(0.4,0,1,1)` | Cascading Dropdown, Flyout |
| 进入 | `modal-enter` | 220ms | `cubic-bezier(0.16,1,0.3,1)` | Modal Dialog, Drawer |
| 退出 | `modal-exit` | 180ms | `cubic-bezier(0.4,0,0.2,1)` | Modal Dialog, Drawer |
| 进入 | `overlay-enter` | 300ms | `cubic-bezier(0.16,1,0.3,1)` | Fullscreen Overlay |
| 退出 | `overlay-exit` | 200ms | `cubic-bezier(0.4,0,0.2,1)` | Fullscreen Overlay |

### 3.2 关键帧定义（新增到 `tokens.css`）

```css
/* ── 面板动画（新增）── */
@keyframes panel-enter {
  from { opacity: 0; transform: scale(0.96); }
  to   { opacity: 1; transform: scale(1); }
}
@keyframes panel-exit {
  from { opacity: 1; transform: scale(1); }
  to   { opacity: 0; transform: scale(0.96); }
}

/* ── 弹出层动画（已有 crish-popover-enter，补退出）── */
@keyframes crish-popover-exit {
  from { opacity: 1; transform: scale(1) translateY(0); }
  to   { opacity: 0; transform: scale(0.96) translateY(-4px); }
}

/* ── 模态框动画（已有 crish-modal-enter，补退出）── */
@keyframes crish-modal-exit {
  from { opacity: 1; transform: scale(1) translateY(0); }
  to   { opacity: 0; transform: scale(0.96) translateY(8px); }
}
```

### 3.3 动画应用策略

所有面板统一使用 `useAnimatedPresence`（已有此 hook），确保先播放退出动画再卸载 DOM：

```typescript
const { state, isMounted } = useAnimatedPresence({
  visible: open,
  enterDurationMs: 150,  // 或 180/220/300 视类型而定
  exitDurationMs: 100,   // 或 120/180/200 视类型而定
});

if (!isMounted) return null;
```

### 3.4 prefers-reduced-motion 处理

```css
@media (prefers-reduced-motion: reduce) {
  [data-panel] {
    animation: none !important;
    transition: none !important;
    opacity: 1 !important;
    transform: none !important;
  }
}
```

---

## 4. 统一交互规范

### 4.1 每个面板必须实现的行为

| 行为 | Simple Dropdown | Toolbar Menu | Cascading | Flyout | Modal | Overlay |
|------|----------------|-------------|-----------|--------|-------|---------|
| 点击外部关闭 | ✅ | ✅ | ✅ | ✅ | ✅ (backdrop) | ❌ |
| Escape 关闭 | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ (先清搜索) |
| 点击选项关闭 | ✅ | ✅ | ✅ | ✅ | ❌ | ❌ |
| Toggle 再次点击 | ✅ | ✅ | ✅ | ✅ | ❌ | ❌ |
| 打开自动聚焦 | ✅ 首项 | ✅ 首项 | ❌ | ✅ 搜索框 | ✅ | ✅ 搜索框 |
| 关闭焦点还原 | ✅ | ✅ | ❌ | ✅ | ❌ | ❌ |
| Portal 到 body | ✅ | ✅ | ✅ | ❌ | ✅ | ❌ |
| 退出动画 | ✅ 100ms | ✅ 100ms | ✅ 120ms | ✅ 120ms | ✅ 180ms | ✅ 200ms |

### 4.2 点击外部关闭的标准实现

```typescript
useEffect(() => {
  if (!open) return;
  
  const handleClickOutside = (e: MouseEvent) => {
    const target = e.target as Node;
    
    // 触发按钮 → 不关闭（由 toggle 处理）
    if (triggerRef.current?.contains(target)) return;
    
    // 面板自身 → 不关闭
    if (panelRef.current?.contains(target)) return;
    
    // 子菜单 → 不关闭（级联面板）
    if (subMenuRef.current?.contains(target)) return;
    
    onClose();
  };
  
  // 使用 mousedown 而非 click，确保在 click 事件之前执行
  document.addEventListener('mousedown', handleClickOutside);
  return () => document.removeEventListener('mousedown', handleClickOutside);
}, [open]);
```

### 4.3 Escape 统一处理

```typescript
useEffect(() => {
  if (!open) return;
  
  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      onClose();
      // 焦点还原到触发按钮
      triggerRef.current?.focus();
    }
  };
  
  window.addEventListener('keydown', handleKeyDown, true);
  return () => window.removeEventListener('keydown', handleKeyDown, true);
}, [open]);
```

### 4.4 飞延子菜单防闪烁

```typescript
// 替代直接的 onMouseEnter/onMouseLeave
const enterTimerRef = useRef<number>();
const leaveTimerRef = useRef<number>();

const handleSubMenuEnter = useCallback(() => {
  clearTimeout(leaveTimerRef.current);
  enterTimerRef.current = setTimeout(() => {
    setActiveSubMenu(id);
  }, 80);  // 80ms 进入延迟，防止快速划过
}, [id]);

const handleSubMenuLeave = useCallback(() => {
  clearTimeout(enterTimerRef.current);
  leaveTimerRef.current = setTimeout(() => {
    setActiveSubMenu(null);
  }, 150);  // 150ms 离开延迟，允许鼠标过渡到子菜单
}, []);
```

### 4.5 点击闪烁修复（ModelBadgePickerMenu #16）

```typescript
// 触发按钮上添加 stopPropagation
<div
  ref={modelSelectorRef}
  onClick={(e) => {
    e.stopPropagation();        // ← 新增：阻止 mousedown 关闭菜单
    setShowModelDropdown((v) => !v);
  }}
>
```

同时在 document mousedown 中添加触发按钮排除：
```typescript
// 在 ModelBadgePickerMenu 内部
useEffect(() => {
  const handleClickOutside = (e: MouseEvent) => {
    // 额外排除触发按钮
    if (triggerBtnRef.current?.contains(e.target as Node)) return;
    if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
      onClose();
    }
  };
  // ...
}, []);
```

---

## 5. 统一视觉规范

### 5.1 面板样式表

```css
/* 所有面板的基础样式 */
[data-panel] {
  /* 背景 */
  background: var(--bg-elevated);
  
  /* 圆角 */
  border-radius: var(--radius-lg);
  
  /* 阴影 */
  box-shadow: var(--shadow-lg);
  
  /* 间距 */
  padding: var(--space-1);
  
  /* 菜单项 */
  --panel-item-min-height: 28px;
  --panel-item-padding: var(--space-1_25) var(--space-2);
  --panel-item-radius: var(--radius-sm);
}

/* 模态对话框 */
[data-panel="modal"] {
  border-radius: var(--radius-xl);
  box-shadow: var(--shadow-2xl);
  padding: var(--space-3);
}

/* 全屏覆盖层 */
[data-panel="overlay"] {
  background: var(--bg-primary);
  border-radius: 0;
  box-shadow: none;
}
```

### 5.2 需要修改的面板样式

| 面板 | 当前值 | 改为 |
|------|--------|------|
| ComposePlusMenu `box-shadow` | `color-mix(...)` | `var(--shadow-lg)` |
| ModelBadgePickerMenu `box-shadow` | `color-mix(...)` | `var(--shadow-lg)` |
| SettingsSelectMenu `box-shadow` | `color-mix(...)` | `var(--shadow-lg)` |
| CardPanel TabAddMenu `box-shadow` | `color-mix(...)` | `var(--shadow-lg)` |
| ChatMoreMenu `box-shadow` | `color-mix(...)` | `var(--shadow-lg)` |
| FirstRunWizard `border-radius` | `16px`（硬编码） | `var(--radius-xl)` |
| FirstRunWizard `box-shadow` | 硬编码 | `var(--shadow-2xl)` |
| PanelDropdown `background` | `--bg-primary` | `--bg-elevated` |

---

## 6. Portal 策略

### 6.1 何时使用 Portal

| 面板类型 | Portal 到 body? | 原因 |
|---------|----------------|------|
| Simple Dropdown | ✅ 是 | 避免 6 层 overflow:hidden 裁剪 |
| Toolbar Menu | ✅ 是 | 同上 |
| Cascading Dropdown | ✅ 是 | 同上 + 级联定位不受父级限制 |
| Context Menu | ✅ 是 | fixed 定位已部分解决，但 portal 更可靠 |
| Flyout Panel | ❌ 否 | 内联定位已够用，且需要相对父级的位置 |
| Modal Dialog | ✅ 是 | 需要 escape 和 backdrop 独立层级 |
| Fullscreen Overlay | ❌ 否 | 全屏覆盖不需要 portal |
| Sliding Drawer | ❌ 否 | 通常内联在父容器中 |

### 6.2 `PanelPortal.tsx` 实现

```tsx
function PanelPortal({ children, zIndex }: { children: ReactNode; zIndex?: string }) {
  const [mounted, setMounted] = useState(false);
  
  useEffect(() => { setMounted(true); }, []);
  
  if (!mounted) return null;  // SSR safety
  
  return createPortal(
    <div style={{ zIndex: zIndex ? `var(${zIndex})` : undefined }} data-portal>
      {children}
    </div>,
    document.body
  );
}
```

---

## 7. 实施步骤

### Phase 1 — 基础设施（无破坏性）

| 步骤 | 内容 | 涉及文件 |
|------|------|---------|
| 1.1 | 在 `tokens.css` 新增 `crish-popover-exit`、`crish-modal-exit` 等关键帧 | `tokens.css` |
| 1.2 | 创建 `hooks/usePanelToggle.ts`（统一 toggle hook） | 新建 |
| 1.3 | 创建 `components/panels/base/PanelPortal.tsx` | 新建 |
| 1.4 | 在 `tokens.css` 中新增 `[data-panel]` 基准样式 | `tokens.css` |

### Phase 2 — 修复优先级最高的缺陷

| 步骤 | 内容 | 影响面板 |
|------|------|---------|
| 2.1 | 修复 ModelBadgePickerMenu 点击闪烁（加 stopPropagation） | #16 |
| 2.2 | 修复 SidebarContextMenus 飞延子菜单闪烁（加 debounce） | #10-12 |
| 2.3 | 修复 ModelBadgePickerMenu hover 子菜单闪烁 | #16 |
| 2.4 | 修复 ProjectPickerMenu 级联闪烁 | #18 |

### Phase 3 — 统一 Escape 和焦点管理

| 步骤 | 内容 | 影响面板 |
|------|------|---------|
| 3.1 | 为所有面板添加 Escape 处理 | 7+ 面板 |
| 3.2 | 为所有列表菜单添加打开自动聚焦 | 8+ 面板 |
| 3.3 | 为所有面板添加关闭焦点还原 | 16 个面板 |
| 3.4 | 为菜单型面板添加 Tab 焦点陷阱 | 6+ 面板 |

### Phase 4 — 统一视觉样式

| 步骤 | 内容 |
|------|------|
| 4.1 | 5 个面板的 `box-shadow` 改为 `var(--shadow-lg)` |
| 4.2 | FirstRunWizard 圆角和阴影改为 token |
| 4.3 | PanelDropdown 等背景色改为 `--bg-elevated` |

### Phase 5 — Portal 迁移

| 步骤 | 内容 |
|------|------|
| 5.1 | Simple Dropdown 类面板迁移到 Portal（SettingsSelect 已有，其余新建） |
| 5.2 | Toolbar Menu 类面板迁移到 Portal |
| 5.3 | Cascading Dropdown 类面板迁移到 Portal |

### Phase 6 — 动画补全

| 步骤 | 内容 |
|------|------|
| 6.1 | 为所有有进入动画的面板添加退出动画（引用 `crish-popover-exit` 等） |
| 6.2 | 为完全无动画的面板添加基本 `panel-enter`/`panel-exit` |
| 6.3 | 添加 `prefers-reduced-motion` 保护 |
