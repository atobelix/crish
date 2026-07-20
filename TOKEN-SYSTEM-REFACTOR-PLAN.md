# Crish 桌面应用 Token 体系系统性重构方案

> 基于 12 个 Agent 交叉分析：8 个审计 Agent + 4 个方案设计 Agent
> 覆盖 CSS/TSX 文件 92+ / 65+，503 条审计问题

---

## 目录

1. [架构总览](#1-架构总览)
2. [CSS Token 体系新增与调整](#2-css-token-体系新增与调整)
3. [JS 常量文件体系](#3-js-常量文件体系)
4. [迁移执行计划](#4-迁移执行计划)
5. [风险控制与校验](#5-风险控制与校验)

---

## 1. 架构总览

### 1.1 三层 Token 体系

```
                            Token 体系
                                │
           ┌────────────────────┼────────────────────┐
           ▼                    ▼                    ▼
    CSS Custom Properties    JS Constants        Z-Index 层级
    (tokens.css)             (src/constants/)     (z-index.css)
           │                    │                    │
           ▼                    ▼                    ▼
    所有 CSS 文件引用      所有 TSX 文件引用     所有 CSS/TSX 引用
    var(--space-*)         import { ICON_* }     var(--z-*)
    var(--radius-*)        import { SIDEBAR_* }  zIndex: var(--z-*)
    var(--color-*)         import { PANEL_* }
    var(--font-*)          import { STORAGE_* }
```

### 1.2 文件结构

```
src/
├── styles/
│   ├── tokens.css                   ← 修改：新增 ~50 个 CSS 变量
│   ├── z-index.css                  ← 新建：统一 z-index 层级
│   ├── breakpoints.css              ← 新建：统一 @media 断点
│   ├── focus-visible.css            ← 已有
│   ├── reduced-motion.css           ← 已有
│   └── sr-only.css                  ← 已有
├── constants/
│   ├── layout.ts                    ← 新建：布局数值常量
│   ├── componentDefaults.ts         ← 新建：组件默认值
│   └── index.ts                     ← 新建：统一 re-export
├── utils/
│   ├── storageKeys.ts               ← 新建：所有存储 key
│   ├── eventNames.ts                ← 新建：所有事件名
│   └── panelIds.ts                  ← 新建：面板 ID 常量
```

---

## 2. CSS Token 体系新增与调整

### 2.1 间距 Token (space) — 新增 6 个

```css
/* 定位：tokens.css :root 中 --space-1 之前 */

--space-0_5: 2px;      /* 152次 — 极窄间隙、标签间距 */
--space-1_25: 5px;     /* 65次  — 微紧凑 padding */
--space-1_5: 6px;      /* 367次 — 最常用 gap！最重要的缺失 */
--space-1_75: 7px;     /* 45次  — 稀疏间隙 */
--space-2_5: 10px;     /* 165次 — 次级 panel padding */
--space-3_5: 14px;     /* 80次  — 中等间距 */

/* [data-ui-size="small"] 中对应缩放 */
/* [data-ui-size="large"] 中对应缩放 */
```

### 2.2 Border-radius Token — 重映射 6 个

```css
/* 替换 tokens.css 中现有 radius 块 */

--radius-xs: 4px;       /* 原 3px，实际使用 4px(60次) − 按钮、控件 */
--radius-sm: 5px;       /* 原 5px 不变（21次，已匹配） */
--radius-md: 6px;       /* 原 7px，实际使用 6px(83次) − 输入框、卡片 */
--radius-lg: 8px;       /* 原 9px，实际使用 8px(108次) − 面板、下拉菜单(最常用) */
--radius-xl: 10px;      /* 原 11px，实际使用 10px(61次) − 对话框、模态框 */
--radius-2xl: 12px;     /* 原 14px，实际使用 12px(35次) − 弹出层、抽屉 */
--radius-full: 999px;   /* 不变 — 药丸、徽标 */
```

### 2.3 Z-index Token — 新建完整体系

位置：新建 `src/styles/z-index.css`，在 `index.css` 中导入

```css
/* ── 基础层 (0-9) ── */
--z-base: 0;              /* 默认文档流 */
--z-decorative: 1;        /* 装饰线、代码标签、占位卡片 */
--z-sticky-bar: 2;        /* sticky 过滤栏、激活 tab、代码复制按钮 */
--z-card-header: 3;       /* 卡片头部 */
--z-card-footer: 5;       /* 卡片底部 */
--z-pinned-bar: 10;       /* 置顶栏 */

/* ── 交互控件 (10-99) ── */
--z-scroll-fab: 12;       /* 回到顶部 FAB */
--z-sidebar: 100;         /* 侧栏主体 */
--z-sidebar-resizer: 100; /* 侧栏宽度拖拽器 */

/* ── 弹出层 (100-999) ── */
--z-popover: 20;          /* 斜杠命令弹出、文件更多菜单 */
--z-splitter: 30;         /* 列/行分割器 */
--z-dropdown-menu: 40;    /* 下拉菜单、添加菜单 */
--z-breadcrumb: 60;       /* 面包屑弹出 */

/* ── 浮层 (1000-4999) ── */
--z-dropdown: 1000;       /* 面板下拉菜单 */
--z-drag-highlight: 1000; /* 拖放目标高亮 */
--z-drag-card: 1010;      /* 拖拽中卡片 */
--z-floating-panel: 999;  /* 浮动面板 */

/* ── 模态与通知 (5000-29999) ── */
--z-context-menu: 9500;   /* 右键菜单 */
--z-modal-backdrop: 9000; /* 模态遮罩 */
--z-toast: 10000;         /* Toast 通知 */
--z-drag-overlay: 10010;  /* 拖拽覆盖层 */
--z-cheatsheet: 12000;    /* 快捷键帮助 */
--z-settings-panel: 13000; /* 设置面板 */

/* ── 弹层组 (20000-99999) ── */
--z-settings-dialog: 20000;   /* 设置二级弹层 */
--z-permission-menu: 20040;   /* 权限模式菜单 */
--z-settings-tooltip: 20060;  /* 设置 tooltip */
--z-usage-modal: 30000;       /* 用量模态 */

/* ── 顶层 (100000+) ── */
--z-first-run: 100000;    /* 首次运行向导 */
--z-model-flyout: 100000; /* 模型选择飞入 */
--z-skip-link: 100000;    /* 跳过导航链接 */
```

### 2.4 字体 Token — 新增 13 个

```css
/* font-size 补齐 — 在 --font-size-xl 之后 */
--font-size-nano: calc(10px + var(--font-size-adjust));       /* 9次 — 角标 */
--font-size-micro: calc(11.5px + var(--font-size-adjust));    /* 10次 — 状态条 */
--font-size-xs-plus: calc(12.5px + var(--font-size-adjust));  /* 10次 — 设置文本 */
--font-size-sm-plus: calc(13.5px + var(--font-size-adjust));  /* 13次 — 设置次级 */
--font-size-xxl: calc(18px + var(--font-size-adjust));        /* 2次 — 扩展标题 */
--font-size-2xl: calc(22px + var(--font-size-adjust));        /* 10次 — 设置大题 */

/* font-weight 补缺 */
--font-weight-heavy: 700;       /* 4次 - 极端强调 */

/* line-height 体系补齐 */
--line-height-none: 1;          /* 28次 — 图标/单行居中 */
--line-height-dense: 1.2;       /* 12次 — 按钮/角标 */
--line-height-compact: 1.3;     /* 31次 — 密集列表 */
--line-height-base: 1.4;        /* 35次 — 正文常见行高 */

/* letter-spacing 体系补齐 */
--letter-spacing-snug: 0.01em;       /* 6次 — 正文微调 */
--letter-spacing-wide: 0.02em;       /* 14次 — 标签/button */
--letter-spacing-tighter: -0.02em;   /* 11次 — 标题压缩 */
--letter-spacing-tightest: -0.025em; /* 9次 — 大标题展示 */
```

### 2.5 颜色 Token — 新增 13 个

```css
/* 阴影基础色 */
--shadow-color: #000;   /* 28处 color-mix(in srgb, #000 ...) 统一来源 */

/* 状态色 */
--color-active: #16a34a; /* 9处 settings-models 激活绿 */

/* 语法高亮 10 色 – light (default) */
--syntax-keyword: #7c6fdb;
--syntax-string: #0d9488;
--syntax-number: #c2410c;
--syntax-title: #2563eb;
--syntax-builtin: #ca8a04;
--syntax-attr: #db2777;
--syntax-comment: var(--text-tertiary);
--syntax-addition: #16a34a;
--syntax-deletion: #dc2626;
--syntax-meta: var(--text-secondary);

/* html[data-theme="dark"] 中覆盖暗色值（从 theme-dark.css 提取） */
/* --syntax-keyword: #c4b5fd; 等 */
```

### 2.6 动画 Token — 新增 2 个，删除 2 个

```css
/* 新增 */
--transition-skeleton: 1.5s ease-in-out;   /* 骨架屏动画 */
--transition-spin: 0.8s linear;            /* 旋转加载 */

/* 删除（从未使用） */
--transition-slide: 300ms ...;  /* 删除 */
--transition-hover: 120ms ...;  /* 删除 */
```

### 2.7 断点 Token（约束性方案）

CSS `@media` 不支持 `var()`，因此采用**注释约束 + lint 规则**方案：

```css
/* 在 tokens.css 中定义语义参考值（仅文档用途，非功能） */
--breakpoint-desktop: 720px;   /* 最常用 11处 @media(max-width) */
--breakpoint-tablet: 640px;   /* 7处 */
--breakpoint-tablet-sm: 560px; /* 6处 */
--breakpoint-phone: 420px;    /* 1处 */
--breakpoint-phone-sm: 360px; /* 2处 */
--breakpoint-wide: 1200px;    /* 1处 @media(min-width) */

/* 实际 @media 中使用注释标记 */
@media (max-width: 720px) { /* breakpoint-desktop */ ... }
```

配合 ESLint 插件 `@crish/lint-no-hardcoded-breakpoint` 强制约束。

---

## 3. JS 常量文件体系

### 3.1 `src/utils/storageKeys.ts` — 统一存储 Key

```typescript
// 全部 35+ 个 localStorage key、BroadcastChannel 名、IndexedDB 库名、Lock 名

// ── 窗口/UI 布局 ──
export const STORAGE_KEY_UI_SIZE = 'crish_ui_size';
export const STORAGE_KEY_SHELL_CHROME = 'crish_shell_chrome';
export const STORAGE_KEY_TAB_MODE = 'crish_tab_mode';
export const STORAGE_KEY_SIDEBAR_WIDTH = 'crish_sidebar_width';
export const STORAGE_KEY_SEND_SHORTCUT = 'crish_send_shortcut';

// ── 主题 ──
export const STORAGE_KEY_THEME = 'crish_theme';
export const STORAGE_KEY_THEME_SKIN = 'crish_theme_skin';

// ── 项目/工作区 ──
export const STORAGE_KEY_PROJECTS = 'crish_projects_v1';
export const STORAGE_KEY_ACTIVE_PROJECT = 'crish_active_project_id';
export const STORAGE_KEY_WORKSPACE_LAYOUT = 'crish_workspace_layout_v1';

// ── 会话/持久化 ──
export const STORAGE_KEY_SESSION_INDEX = 'crish_session_index_v1';
export const STORAGE_KEY_SESSION_BODY = 'crish_session_body_v1:';
// ... 全部 35+ 个

// ── 动态 key 工厂 ──
export function projectSettingsKey(normalizedCwd: string): string {
  return `crish_project_settings_${normalizedCwd}`;
}

// ── 非 localStorage ──
export const DB_NAME_SESSION_SYNC = 'crish-sync';
export const CHANNEL_NAME_CROSS_TAB = 'crish-cross-tab';
export const LOCK_NAME_SETTINGS_WRITE = 'crish-settings-write';
```

### 3.2 `src/utils/eventNames.ts` — 统一事件名

```typescript
// ── 已迁移到 UiEventMap 的事件（通过 emitUiEvent/onUiEvent 注册）──
export const EVENT_PROJECT_CHANGED = 'crish-project-changed';
export const EVENT_OPEN_CHAT = 'crish-open-chat';
// ... 15 个

// ── 尚为裸 CustomEvent 的事件（需逐步迁移）──
export const EVENT_OPEN_FILE = 'crish-open-file';
export const EVENT_TERMINAL_APPEND = 'crish-terminal-append';
// ... 14 个

// ── 分组导出 ──
export const MIGRATED_EVENT_NAMES = [EVENT_PROJECT_CHANGED, ...] as const;
export const LEGACY_EVENT_NAMES = [EVENT_OPEN_FILE, ...] as const;
export const ALL_EVENT_NAMES = [...MIGRATED_EVENT_NAMES, ...LEGACY_EVENT_NAMES] as const;
```

### 3.3 `src/utils/panelIds.ts` — 统一面板 ID

```typescript
export const PANEL_CHAT = 'chat';
export const PANEL_AGENT = 'agent';
export const PANEL_OVERVIEW = 'overview';
export const PANEL_FILES = 'files';
export const PANEL_PREVIEW = 'preview';
export const PANEL_DIFF = 'diff';
export const PANEL_TERMINAL = 'terminal';
export const PANEL_TASKS = 'tasks';
export const PANEL_RUNTIME = 'runtime';
export const PANEL_SETTINGS = 'settings';
export const PANEL_PLAN = 'plan';

export const WORKSPACE_PANEL_IDS = [PANEL_CHAT, PANEL_AGENT, PANEL_OVERVIEW, PANEL_FILES, PANEL_PREVIEW, PANEL_DIFF, PANEL_TERMINAL, PANEL_TASKS, PANEL_PLAN] as const;
export const ALL_PANEL_IDS = [...WORKSPACE_PANEL_IDS, PANEL_RUNTIME, PANEL_SETTINGS] as const;
export type KnownPanelCardId = typeof ALL_PANEL_IDS[number];
```

### 3.4 `src/constants/layout.ts` — 布局数值

```typescript
// ── 侧栏 ──
export const SIDEBAR_WIDTH_MIN = 220;
export const SIDEBAR_WIDTH_MAX = 360;
export const SIDEBAR_WIDTH_DEFAULT = 260;
export const SIDEBAR_RESIZE_STEP = 12;
export const SIDEBAR_RESIZE_STEP_LARGE = 24;

// ── 列宽比例 ──
export const COLUMN_RATIO_MIN = 0.13;
export const COLUMN_RATIO_TOOL_DEFAULT = 0.34;
export const COLUMN_RATIO_CHAT_DEFAULT = 0.66;
export const COLUMN_RATIO_TOOL_COLLAPSED_DETECT = 0.04;
export const COLUMN_RATIO_TOOL_EXPANDED_DETECT = 0.08;
export const COLUMN_RATIO_PERSIST_MIN = 0.15;
export const COLUMN_RATIO_PERSIST_MAX = 0.7;

// ── 布局尺寸 ──
export const TAB_BAR_HEIGHT_DEFAULT = 36;
export const DROPDOWN_HEIGHT_MAX = 360;
export const DROPDOWN_HEIGHT_MIN = 120;
export const DROPDOWN_WIDTH_MIN = 160;
export const DROPDOWN_WIDTH_MAX = 280;

// ── DnD ──
export const SPLIT_EDGE_PADDING_X = 48;
export const SPLIT_EDGE_PADDING_Y = 36;
export const CHAT_COL_LEFT_ZONE = 0.45;
export const CHAT_COL_RIGHT_ZONE = 0.55;

// ── 消息列表 ──
export const DEFAULT_RECENT_MESSAGE_COUNT = 80;
export const EXPAND_OLDER_STEP = 40;
export const MESSAGE_ESTIMATED_ROW_HEIGHT = 120;
export const MESSAGE_VIEWPORT_OVERSCAN = 6;
export const MESSAGE_VIEWPORT_THRESHOLD = 60;

// ── 侧栏会话列表 ──
export const SIDEBAR_SESSION_ROW_HEIGHT = 28;
export const SIDEBAR_WINDOW_THRESHOLD = 48;
export const SIDEBAR_WINDOW_OVERSCAN = 8;

// ── 终端 ──
export const TERMINAL_HARD_MAX = 800;
export const TERMINAL_TRIM_TO = 600;

// ── 上限 ──
export const MAX_OPEN_SESSION_TABS = 16;
export const MAX_MESSAGES_PER_SESSION = 500;
export const MAX_SNAPSHOTS_PER_SESSION = 20;
export const MAX_SIDEBAR_VISIBLE_SESSIONS = 6;
```

### 3.5 `src/constants/componentDefaults.ts` — 组件默认值

```typescript
// ── 图标尺寸（px）──
export const ICON_SIZE_SM = 12;
export const ICON_SIZE_MD = 14;       // 148 处使用，事实标准
export const ICON_SIZE_LG = 16;
export const ICON_SIZE_XL = 22;
export const ICON_SIZE_HEADER = 15;   // 顶栏专用
export const ICON_SIZE_BADGE = 11;    // Pin 图标

// ── 图标线宽 ──
export const ICON_STROKE_DEFAULT = 1.75;  // 95 处使用，事实标准
export const ICON_STROKE_EMPHASIS = 2;
export const ICON_STROKE_LIGHT = 1.5;

// ── Toast 时长（ms）──
export const TOAST_DURATION_INFO = 5000;
export const TOAST_DURATION_SUCCESS = 3000;
export const TOAST_DURATION_WARNING = 8000;
export const TOAST_DURATION_ERROR = 10000;

// ── UI 密度 ──
export const UI_SIZE_DEFAULT = 'medium' as const;
```

---

## 4. 迁移执行计划

### Phase 1 — 基础设施：新建常量文件 + 新 Token 定义

**无破坏性，可独立部署**

| 步骤 | 内容 | 涉及文件 |
|------|------|---------|
| 1.1 | 创建 `src/constants/layout.ts`、`componentDefaults.ts`、`index.ts` | 3 个新建 |
| 1.2 | 创建 `src/utils/storageKeys.ts`、`eventNames.ts`、`panelIds.ts` | 3 个新建 |
| 1.3 | 在 `tokens.css` 新增所有缺失 Token（space/radius/font/color/animation） | `tokens.css` 修改 |
| 1.4 | 创建 `src/styles/z-index.css`，在 `index.css` 中导入 | 2 个文件 |
| 1.5 | 删除 `--transition-slide`、`--transition-hover`（确认 0 引用后） | `tokens.css` 修改 |

### Phase 2 — 先导替换：z-index + 阴影颜色

**风险最高，优先执行以暴露冲突**

| 步骤 | 内容 | 工作量 |
|------|------|--------|
| 2.1 | 全部 90+ 处 z-index 裸值替换为 `var(--z-*)` | ~25 个 CSS 文件 |
| 2.2 | 28 处 `color-mix(in srgb, #000 ...)` → `var(--shadow-color)` | ~10 个 CSS 文件 |
| 2.3 | JS 内联 `zIndex` 替换（`App.tsx`, `CardPanel.tsx`, `SidebarContextMenus.tsx` 等） | ~5 个 TSX 文件 |

### Phase 3 — 密集替换：spacing + radius

**影响面最大，机械替换**

| 步骤 | 内容 | 正则模式 |
|------|------|---------|
| 3.1 | 367 处 `6px`(gap/padding/margin) → `var(--space-1_5)` | `(gap\|padding\|margin\|inset):\s*6px` |
| 3.2 | 108 处 `border-radius: 8px` → `var(--radius-8)` | `border-radius:\s*8px` |
| 3.3 | 422 处 `8px`(gap/padding/margin) → `var(--space-2)` | `(gap\|padding\|margin):\s*8px` |
| 3.4 | 291 处 `4px`(gap/padding/margin) → `var(--space-1)` | 同上 |
| 3.5 | 83 处 `border-radius: 6px` → `var(--radius-6)` | `border-radius:\s*6px` |
| 3.6 | 165 处 `10px`, 175 处 `12px`, 152 处 `2px` 间距替换 | 批量替换 |

### Phase 4 — 字体与颜色替换

**需逐处确认上下文**

| 步骤 | 内容 | 注意事项 |
|------|------|---------|
| 4.1 | 103 处 `font-weight: 500` → `var(--font-weight-medium)` | 纯替换 |
| 4.2 | 55 处 `font-weight: 600` → `var(--font-weight-content)` | 纯替换 |
| 4.3 | 25 处 `font-weight: 400` → 区分 `normal`/`code` | **需逐处判断** |
| 4.4 | 9 处 `#16a34a` → `var(--color-active)` | settings-models 等 |
| 4.5 | 语法高亮 8 色 → `var(--syntax-*)` | chat-markdown.css + theme-dark.css |
| 4.6 | 终端裸色 → 已有 `var(--terminal-*)` | panels.css |
| 4.7 | `line-height`/`letter-spacing` 全部替换 | 机替约 280 处 |

### Phase 5 — font-size + animation 替换

**少量逐处确认**

| 步骤 | 内容 | 涉及 |
|------|------|------|
| 5.1 | 68 处 font-size 硬编码替换 | 设置页为主 |
| 5.2 | 3 处硬编码 transition 修复（shell-menus/SidebarSessionList） | 3 个文件 |
| 5.3 | 3 处 TSX 内联 `animation: 'spin...'` 提取为 CSS class | ModelsSettingsTab.tsx |

### Phase 6 — Chat 层 radius 治理

**独立域，不影响其他功能**

| 步骤 | 内容 |
|------|------|
| 6.1 | ChatMessageRow 11 种 radius 统一为 5 种 |
| 6.2 | ChatComposer radius 标准化 |
| 6.3 | ChatToolCallBlock radius 标准化 |

---

## 5. 风险控制与校验

### 5.1 无破坏性保障

| 措施 | 说明 |
|------|------|
| **增量部署** | 所有 Token 先添加再替换，不存在"替换了但 Token 未定义"的情况 |
| **新旧并存** | 新旧 Token 值并线运行，CSS fallback 机制确保旧值存在时新值不破坏 |
| **JS 常量文件先行** | 常量文件先于替换创建，替换时可立即 import |
| **Chat 层最后治理** | radius 统一在全部基础 Token 就位后单独处理，不影响其他区域 |

### 5.2 视觉回归检查清单

| 检查点 | 方法 |
|--------|------|
| z-index 层级无遮挡 | 打开全部弹窗/菜单/Toast 检查重叠 |
| radius 变化 | 截图对比 Chat 层气泡圆角 |
| font-size 2xl 22px | 打开设置页面确认标题视觉 |

### 5.3 git 提交建议

- Phase 1（基础设施）可单独作为一个 commit
- Phase 2-5 按文件拆分，每步一个 commit
- 每个 commit 后运行 `npx tsc --noEmit` + `npm run lint`
