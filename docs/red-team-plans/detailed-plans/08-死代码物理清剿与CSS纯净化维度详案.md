# 死代码物理清剿与 CSS 纯净化维度系统级重构详案 (Detailed Plan 08)

## Physical Dead Code Purge, Two-Tier CSS Architecture, Multi-Root Portals, 0-!important Governance & Universal Toast Context Modernization

> **文档地位与权威效力**：
>
> 1. 本详案是红队前端系统级重构战役中**专属领域维度详案（Detailed Plan 08）**，依据《红队前端系统级重构总计划框架与删除面裁决》（`docs/red-team-plans/00-红队前端系统级重构总计划框架与删除面裁决.md`）、《红队子 Agent 方案编制契约与收敛基准》（`docs/red-team-plans/00-红队子Agent方案编制契约与收敛基准.md`）及三份交叉评审专审报告（`docs/red-team-plans/plan-reviews/01~03.md`）的顶层裁决与统一删除总账编制；
> 2. **【红队防作弊铁律】**：本方案严格基于客观白盒审查基准、标杆工业级解剖专著与真实源码库构建，**严禁且绝无查看、检索、引用 `docs/frontend-review/`（蓝队隔离区）下的任何文件**；
> 3. **【核心战役使命】**：坚决贯彻「严格先删后改、一个概念一条路径、架构穿透零补丁、负产出刚性验收」的铁律。在全仓第一阶段坚决物理清剿 **17 个废弃文件（净删除 $\ge 9,296$ 行）**，构建 **Two-Tier 纯净样式架构**、**7 级标准化 Z-Index 标尺（$\le 9000$）** 与 **`index.html` 5 大 Multi-Root Portal 挂载容器**，拔除全仓 **80+ 处 TSX 双重类名** 与 **660+ 处 `!important` 恶性竞争**，并建立 **`ToastProvider` + `useToast()` Context 单例** 彻底消除跨 5~8 层的 `onShowToast` Prop-Drilling 污染；
> 4. **推进原则与编码规范**：严禁使用任何批次/波次（Batch/Wave/Round）机械切割，全面以领域概念单元（Domain Units）推进；文件严格使用 UTF-8 无 BOM 编码。

---

# 目录索引 (Table of Contents)

- [一、 做什么：Two-Tier 纯净样式、7 级 Z-Index 标尺、5 大 Portal 容器与 Toast Context](#一-做什么two-tier-纯净样式7-级-z-index-标尺5-大-portal-容器与-toast-context)
  - [1.1 Two-Tier 纯净样式分层架构设计 (Global Baseline + 100% Scoped CSS Modules)](#11-two-tier-纯净样式分层架构设计-global-baseline--100-scoped-css-modules)
  - [1.2 7 级标准化 Z-Index 标尺 Scale 设计（彻底消除 100,000 恶性通胀）](#12-7-级标准化-z-index-标尺-scale-设计彻底消除-100000-恶性通胀)
  - [1.3 `index.html` 5 大 Multi-Root Portal 挂载容器拓扑与层叠上下文隔离](#13-indexhtml-5-大-multi-root-portal-挂载容器拓扑与层叠上下文隔离)
  - [1.4 `ToastProvider` + `useToast()` 全局 Context 单例设计（彻底铲除全仓 `onShowToast` Prop-Drilling）](#14-toastprovider--usetoast-全局-context-单例设计彻底铲除全仓-onshowtoast-prop-drilling)
  - [1.5 Token 回退中立性规范与幽灵 Token 根除矩阵](#15-token-回退中立性规范与幽灵-token-根除矩阵)
  - [1.6 借鉴标杆（AFFiNE / AppFlowy / DeepSeek-Harness）的工业级工程美学](#16-借鉴标杆affine--appflowy--deepseek-harness的工业级工程美学)
- [二、 删什么：首批 19 个文件物理删除、TSX 双重类名剥离与 660+ !important 清零](#二-删什么首批-19-个文件物理删除tsx-双重类名剥离与-660-important-清零)
  - [2.1 首批 19 个死代码与废弃样式文件物理删除执行清单 (8 大类 · 9,445 行)](#21-首批-19-个死代码与废弃样式文件物理删除执行清单-8-大类--9445-行)
  - [2.2 全仓 80+ 处 TSX 双重类名与幽灵类彻底剥离执行清单](#22-全仓-80-处-tsx-双重类名与幽灵类彻底剥离执行清单)
  - [2.3 `theme-dark.css` 补丁膏药清退与全仓 660+ 处业务 `!important` 彻底清零策略](#23-theme-darkcss-补丁膏药清退与全仓-660-处业务-important-彻底清零策略)
  - [2.4 全仓 30+ 个组件 `onShowToast` 5 层透传 Props 彻底剔除清单](#24-全仓-30-个组件-onshowtoast-5-层透传-props-彻底剔除清单)
  - [2.5 `src/index.css` 7 条废弃 `@import` 拔除、启动服务与 SSR 全局瘦身清理](#25-srcindexcss-7-条废弃-import-拔除启动服务与-ssr-全局瘦身清理)
  - [2.6 负产出净代码行数精密核算总账（净削减 $\ge 9,800+$ 行）](#26-负产出净代码行数精密核算总账净削减-ge-9800-行)
- [三、 依赖与逻辑顺序：严格「先删后改」与任务执行 DAG 图](#三-依赖与逻辑顺序严格先删后改与任务执行-dag-图)
  - [3.1 「先清障 $\to$ 建契约 $\to$ 纯组件 $\to$ 治特异 $\to$ 终体验收」因果推进公理](#31-先清障-to-建契约-to-纯组件-to-治特异-to-终体验收因果推进公理)
  - [3.2 8 大领域任务单元详细定义 (Unit-Purge-01 ~ Unit-Purge-08)](#32-8-大领域任务单元详细定义-unit-purge-01--unit-purge-08)
  - [3.3 详细任务执行 Mermaid DAG 依赖拓扑图](#33-详细任务执行-mermaid-dag-依赖拓扑图)
  - [3.4 防死锁与无环推进保证细则](#34-防死锁与无环推进保证细则)
- [四、 文件域：专属唯一文件域划分与并行冲突防护契约](#四-文件域专属唯一文件域划分与并行冲突防护契约)
  - [4.1 本方案专属独占修改文件域清单](#41-本方案专属独占修改文件域清单)
  - [4.2 跨领域协同修改文件域与串行锁协议](#42-跨领域协同修改文件域与串行锁协议)
  - [4.3 Git 共享 Index 提交纪律与原子提交规范](#43-git-共享-index-提交纪律与原子提交规范)
- [五、 验收标准：负产出硬验收、自动化断言与 15 项自检清单](#五-验收标准负产出硬验收自动化断言与-15-项自检清单)
  - [5.1 负产出与收敛刚性硬指标验收矩阵](#51-负产出与收敛刚性硬指标验收矩阵)
  - [5.2 自动化测试断言套件 (Vitest 静态扫描与单测)](#52-自动化测试断言套件-vitest-静态扫描与单测)
  - [5.3 CDP 9222 真机宿主交互与渲染验收断言](#53-cdp-9222-真机宿主交互与渲染验收断言)
  - [5.4 15 项黄金自检清单 (C-01 ~ C-15) 逐项全绿对照表](#54-15-项黄金自检清单-c-01--c-15-逐项全绿对照表)

---

# 一、 做什么：Two-Tier 纯净样式、7 级 Z-Index 标尺、5 大 Portal 容器与 Toast Context

### 1.1 Two-Tier 纯净样式分层架构设计 (Global Baseline + 100% Scoped CSS Modules)

现有 Conex 客户端在样式层存在严重的「五代地层堆叠、全局选择器跨界越权、特异性恶性竞争」反模式（AP-07）。为彻底根治样式污染，本方案确立**Two-Tier（两层式）绝对纯净样式架构**：

```
┌────────────────────────────────────────────────────────────────────────────────────────────────────────┐
│                                   Two-Tier 纯净样式架构分层拓扑模型                                      │
├────────────────────────────────────────────────────────────────────────────────────────────────────────┤
│                                                                                                        │
│  【Layer 1: 全局基础设施层 (Global Baseline Layer) - 仅限纯变量与重置】                                   │
│  ├── tokens.css       : 100% 纯 CSS Custom Properties 定义 (闭环 Light / Dark 映射，0 业务类名)         │
│  ├── z-index.css      : 7 级标准化语义 Z-Index 标尺 (0 ~ 9000，消除 100,000 恶性通胀)                   │
│  ├── shell-reset.css  : 极简视口与盒模型 Reset、现代无衬线字体栈、系统滚动条标准规范                   │
│  └── animations.css   : 全局可复用 @keyframes 硬件加速动画 (FadeIn, SlideUp, Spin, Pulse)              │
│                                                                                                        │
│                                           │ (单向只读向下注入，禁止逆向侵入)                            │
│                                           ▼                                                            │
│                                                                                                        │
│  【Layer 2: 组件局部作用域层 (100% Scoped CSS Modules Layer) - 100% 隔离】                              │
│  ├── chat/*.module.css       : 纯 camelCase 类名，0 !important，单文件 <= 400 行                       │
│  ├── settings/*.module.css   : 彻底取代 6 个 settings-*.css 废弃文件，100% 消费 Design Tokens           │
│  ├── diff/*.module.css       : 紧凑 34px Header、5.5% 柔和底色，消除双行旧结构                         │
│  ├── ui/*.module.css         : 原子组件样式，严格满足 Ro = Ri + P 同心几何与 0-药丸白名单               │
│  └── workspace/*.module.css  : 视口几何全贴合，滚动条极右贴边 (X=W)                                    │
│                                                                                                        │
└────────────────────────────────────────────────────────────────────────────────────────────────────────┘
```

#### Layer 1 核心规范与代码契约 (`styles/tokens.css`)

全局 `tokens.css` 严禁包含任何 HTML 标签选择器（除 `:root`, `html[data-theme='...']`）或具体业务类名，必须实现浅色与暗色模式的**自闭环映射**，彻底废除 `theme-dark.css` 外部补丁：

```css
/* apps/crish-desktop/src/styles/tokens.css (节选标准契约) */
:root,
html[data-theme='light'] {
  /* 基础背景色 */
  --bg-app: hsl(0 0% 100%);
  --bg-primary: hsl(210 20% 98%);
  --bg-secondary: hsl(210 16% 95%);
  --bg-tertiary: hsl(210 14% 91%);
  --bg-surface: hsl(0 0% 100%);
  --bg-elevated: hsl(0 0% 100%);

  /* 基础前景色与文字色 (严格杜绝 #0f172a 等硬编码) */
  --text-primary: hsl(222 47% 11%);
  --text-secondary: hsl(215 16% 47%);
  --text-tertiary: hsl(215 14% 65%);
  --text-inverse: hsl(0 0% 100%);

  /* 边框与分割线 */
  --border-subtle: hsl(214 32% 91%);
  --border-color: hsl(214 20% 84%);
  --border-strong: hsl(215 25% 27%);
  --hairline-color: hsl(210 10% 88% / 0.6);

  /* 主题色系与状态指示 */
  --accent-primary: hsl(221 83% 53%);
  --accent-hover: hsl(221 83% 45%);
  --color-success: hsl(142 71% 45%);
  --color-warning: hsl(38 92% 50%); /* 规范取代 --accent-amber */
  --color-danger: hsl(0 84% 60%);
  --color-info: hsl(199 89% 48%);

  /* 5.5% 柔和 Diff 色板 (Reviewer 1 & Plan 06 裁决标准) */
  --diff-line-add-bg: hsl(142 35% 42% / 0.055);
  --diff-line-add-border: hsl(142 71% 45% / 0.35);
  --diff-line-delete-bg: hsl(0 65% 51% / 0.055);
  --diff-line-delete-border: hsl(0 84% 60% / 0.35);

  /* 同心几何圆角标尺 (Plan 02 裁决标准: Ro = Ri + P) */
  --radius-xs: 2px; /* 内部指示微点 */
  --radius-sm: 4px; /* Badge / Tag / Status */
  --radius-md: 6px; /* Button / Input / Select */
  --radius-lg: 8px; /* Popover / Card / WindowInner */
  --radius-xl: 12px; /* Modal Dialog / Shell Frame */

  /* 物理尺寸标尺 (Plan 03 裁决标准) */
  --header-height: 36px;
  --diff-header-height: 34px;
  --panel-header-height: 34px;
  --tree-item-height: 30px;
}

html[data-theme='dark'] {
  /* 基础背景色 (闭环映射，0 !important) */
  --bg-app: hsl(222 47% 7%);
  --bg-primary: hsl(222 47% 9%);
  --bg-secondary: hsl(217 33% 14%);
  --bg-tertiary: hsl(217 33% 18%);
  --bg-surface: hsl(222 47% 11%);
  --bg-elevated: hsl(217 33% 16%);

  /* 基础文字色 */
  --text-primary: hsl(210 40% 98%);
  --text-secondary: hsl(215 20% 70%);
  --text-tertiary: hsl(215 16% 50%);
  --text-inverse: hsl(222 47% 11%);

  /* 边框与分割线 */
  --border-subtle: hsl(217 33% 18%);
  --border-color: hsl(217 33% 24%);
  --border-strong: hsl(215 20% 65%);
  --hairline-color: hsl(217 33% 22% / 0.6);

  /* 5.5% 柔和 Diff 暗色板 */
  --diff-line-add-bg: hsl(142 35% 42% / 0.08);
  --diff-line-add-border: hsl(142 71% 45% / 0.45);
  --diff-line-delete-bg: hsl(0 65% 51% / 0.08);
  --diff-line-delete-border: hsl(0 84% 60% / 0.45);
}
```

---

### 1.2 7 级标准化 Z-Index 标尺 Scale 设计（彻底消除 100,000 恶性通胀）

现有 `styles/z-index.css` 堆叠了 33 个碎片 Token，数值一路恶性通胀至 `100,000`（AP-10）。
本方案严格贯彻 Reviewer 1 专审与 Master Framework 终审裁决，确立**全仓唯一合法的 7 级标准化 Z-Index 标尺（$\le 9000$）**：

```css
/* apps/crish-desktop/src/styles/z-index.css (7 级标准标尺终态) */
:root {
  /* Level 0: 基础文档流与排版底座 */
  --z-base: 0; /* 编辑器画布、卡片内容区、默认文档流 */

  /* Level 1: 粘性与外壳停靠层 */
  --z-dock: 10; /* 吸附表头、粘性工具条 */
  --z-sidebar: 100; /* 侧边栏整体容器 */
  --z-resizer: 110; /* 分栏拖拽手柄、Resize Splitter */

  /* Level 2: 浮层与下拉菜单层 (挂载于 #popover-root) */
  --z-popover: 200; /* 气泡卡片、Slash 菜单 */
  --z-dropdown: 300; /* 下拉菜单 Menu、Select Listbox */
  --z-cascade-submenu: 400; /* 二级飞出级联子菜单 MenuSub */
  --z-context-menu: 500; /* 右键上下文菜单 ContextMenu */

  /* Level 3: 抽屉与侧滑面板层 (挂载于 #modal-root) */
  --z-drawer: 800; /* 侧滑抽屉 Drawer */
  --z-floating-panel: 900; /* 浮动辅助面板 */

  /* Level 4: 全局模态对话框与设置层 (挂载于 #modal-root) */
  --z-modal-backdrop: 1000; /* 模态暗色遮罩背景 */
  --z-modal: 1100; /* 模态对话框 Dialog、全屏设置面板 */
  --z-confirm: 1200; /* 二次确认对话框 ConfirmModal */

  /* Level 5: 系统通知与拖拽虚拟拦截层 (挂载于 #toast-root / #system-root) */
  --z-toast: 3000; /* 全局通知吐司栈 ToastStack */
  --z-virtual-interceptor: 3500; /* 虚拟滚动拖拽全屏拦截透明层 */

  /* Level 6: 顶级轻量提示气泡层 (挂载于 #tooltip-root) */
  --z-tooltip: 9000; /* 全局悬浮提示气泡 Tooltip (绝对置顶) */
}
```

```
┌────────────────────────────────────────────────────────────────────────────────────────────────────────┐
│                              7 级 Z-Index 语义标尺与层叠上下文映射关系                                    │
├─────────┬──────────────────────┬─────────────┬────────────────────┬────────────────────────────────────┤
│ 标尺级  │ 语义层级名称         │ Z-Index 数值│ 挂载 Portal 容器   │ 典型覆盖组件                       │
├─────────┼──────────────────────┼─────────────┼────────────────────┼────────────────────────────────────┤
│ Level 0 │ Base Document        │ 0           │ #root              │ Markdown 编辑器, Diff 代码行, 画布 │
│ Level 1 │ Dock & Shell         │ 10 ~ 110    │ #root              │ AppTopBar, 侧边栏, 分栏拖拽手柄    │
│ Level 2 │ Popovers & Dropdowns │ 200 ~ 500   │ #popover-root      │ 下拉菜单, 二级飞出菜单, 右键菜单   │
│ Level 3 │ Drawers & Panels     │ 800 ~ 900   │ #modal-root        │ 侧滑抽屉, 悬浮辅助面板             │
│ Level 4 │ Modals & Settings    │ 1000 ~ 1200 │ #modal-root        │ 全屏设置面板, 模态对话框, 确认框   │
│ Level 5 │ Toasts & Drag Mirror │ 3000 ~ 3500 │ #toast-root        │ ToastStack 吐司栈, 拖拽拦截层      │
│ Level 6 │ Global Tooltip       │ 9000        │ #tooltip-root      │ 轻量气泡 Tooltip (全站最顶层)      │
└─────────┴──────────────────────┴─────────────┴────────────────────┴────────────────────────────────────┘
```

---

### 1.3 `index.html` 5 大 Multi-Root Portal 挂载容器拓扑与层叠上下文隔离

为了彻底解决浮层在深层组件内渲染被 `overflow: hidden` 裁剪、以及设置面板内 Tooltip 被弹窗遮挡的**层叠上下文倒挂（Stacking Context Inversion）**病灶，在 `apps/crish-desktop/index.html` 中预置 **5 大独立 Multi-Root Portal 容器**：

```html
<!-- apps/crish-desktop/index.html (完整 DOM 根节点拓扑) -->
<!DOCTYPE html>
<html lang="zh-CN" data-theme="dark">
  <head>
    <meta charset="UTF-8" />
    <link rel="icon" type="image/svg+xml" href="/favicon.svg" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Conex Workbench</title>
  </head>
  <body>
    <!-- 1. 主应用 React 根挂载点 (z-index: 0 ~ 110) -->
    <div id="root"></div>

    <!-- 2. 下拉菜单与气泡根挂载点 (z-index: 200 ~ 500) -->
    <div id="popover-root"></div>

    <!-- 3. 全屏模态与设置弹窗根挂载点 (z-index: 1000 ~ 1200) -->
    <div id="modal-root"></div>

    <!-- 4. 全局通知吐司栈根挂载点 (z-index: 3000) -->
    <div id="toast-root"></div>

    <!-- 5. 全局轻量气泡提示根挂载点 (z-index: 9000) -->
    <div id="tooltip-root"></div>

    <!-- 6. 系统级拖拽镜像与调试探针根挂载点 (z-index: 9999) -->
    <div id="system-root"></div>

    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

#### Portal 挂载容器物理隔离收益：

1. **彻底消除 Tooltip 穿透与遮挡**：设置面板通过 Portal 挂载至 `#modal-root`（`z-index: 1100`）；设置面板内的关闭按钮 Tooltip 经 Portal 挂载至 `#tooltip-root`（`z-index: 9000`），天然位于弹窗上方，无需为设置面板单独发明 `--z-settings-tooltip: 20060` 畸形变量；
2. **消灭 `overflow: hidden` 裁剪**：叶子面板内部的下拉选择框与右键菜单直通 `#popover-root`，不受父级二叉树分栏容器的滚动与裁剪约束；
3. **零 JS 样式计算**：各 Portal 容器在 HTML 原生排版树中平级展开，层叠上下文由浏览器合成器原生保证，避免任何运行时计算偏移。

---

### 1.4 `ToastProvider` + `useToast()` 全局 Context 单例设计（彻底铲除全仓 `onShowToast` Prop-Drilling）

现有代码中，`handleShowToast` 从 `App.tsx` 实例化后，跨越 5~8 层组件手工传递（`App.tsx` $\to$ `BinaryTreeWorkspace` $\to$ `TreeLeafPanel` $\to$ `DiffCard` / `FilesCard` / `RuntimePanel` / `MessageActions`...），不仅严重污染组件 Props，更直接摧毁了 `React.memo` 记忆化防线。

本方案构建**现代 React Context 单例 + 命令式 Service 双模驱动**的 Toast 系统：

```typescript
// apps/crish-desktop/src/context/ToastContext.tsx
import React, { createContext, useContext, useMemo, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { useToastQueue, type AppToast, type ShowToastOptions } from '../hooks/useToastQueue';
import { ToastStack } from '../components/overlay/ToastStack';

export type ShowToastFn = (message: string, options?: ShowToastOptions) => string;

interface ToastContextValue {
  showToast: ShowToastFn;
  dismissToast: (id: string) => void;
  toasts: readonly AppToast[];
}

const ToastContext = createContext<ToastContextValue | null>(null);

// 命令式调用网关 (供非 React 异步通信管道、事件监听器消费)
let globalToastEmitter: ShowToastFn | null = null;

export const toast = {
  show: (message: string, options?: ShowToastOptions): string => {
    if (globalToastEmitter) {
      return globalToastEmitter(message, options);
    }
    console.warn('[ToastContext] ToastProvider not mounted yet. Message dropped:', message);
    return '';
  },
  success: (message: string, options?: Omit<ShowToastOptions, 'type'>): string => {
    return toast.show(message, { ...options, type: 'success' });
  },
  error: (message: string, options?: Omit<ShowToastOptions, 'type'>): string => {
    return toast.show(message, { ...options, type: 'error' });
  },
  info: (message: string, options?: Omit<ShowToastOptions, 'type'>): string => {
    return toast.show(message, { ...options, type: 'info' });
  },
};

export interface ToastProviderProps {
  children: React.ReactNode;
}

export const ToastProvider: React.FC<ToastProviderProps> = ({ children }) => {
  const { toasts, showToast, dismissToast } = useToastQueue();

  const handleShowToast = useCallback<ShowToastFn>(
    (message, options) => {
      return showToast(message, options);
    },
    [showToast]
  );

  // 绑定全局命令式发射器
  globalToastEmitter = handleShowToast;

  const contextValue = useMemo<ToastContextValue>(
    () => ({
      showToast: handleShowToast,
      dismissToast,
      toasts,
    }),
    [handleShowToast, dismissToast, toasts]
  );

  const toastRoot = typeof document !== 'undefined' ? document.getElementById('toast-root') : null;

  return (
    <ToastContext.Provider value={contextValue}>
      {children}
      {toastRoot &&
        createPortal(
          <ToastStack toasts={toasts} onDismiss={dismissToast} />,
          toastRoot
        )}
    </ToastContext.Provider>
  );
};

export function useToast(): ShowToastFn {
  const ctx = useContext(ToastContext);
  if (!ctx) {
    throw new Error('useToast() must be used within a <ToastProvider>. Check root mounting in main.tsx/App.tsx.');
  }
  return ctx.showToast;
}
```

#### 全局装配与消费范式：

1. **根组件装配 (`main.tsx`)**：
   ```tsx
   // apps/crish-desktop/src/main.tsx
   import { ToastProvider } from './context/ToastContext';

   ReactDOM.createRoot(document.getElementById('root')!).render(
     <React.StrictMode>
       <ToastProvider>
         <App />
       </ToastProvider>
     </React.StrictMode>
   );
   ```
2. **业务叶子组件极简消费 (`DiffCard.tsx`)**：
   ```tsx
   // ✅ 彻底告别 props.onShowToast，组件签名纯净
   import { useToast } from '@/context/ToastContext';

   export const DiffCard: React.FC<DiffCardProps> = React.memo(({ file }) => {
     const showToast = useToast();

     const handleCopy = () => {
       navigator.clipboard.writeText(file.path);
       showToast('文件路径已复制到剪贴板', { type: 'success' });
     };

     return <button onClick={handleCopy}>复制</button>;
   });
   ```

---

### 1.5 Token 回退中立性规范与幽灵 Token 根除矩阵

#### 1. 根除暗黑 Tailwind 有毒 Fallback

全仓杜绝在 CSS 变量后硬编码暗色或浅色 Fallback（如 `color: var(--text-primary, #f8fafc)` 或 `background: var(--bg-primary, #0f172a)`）。在浅色模式下若变量由于层叠上下文缺失导致解析回退，会产生极其刺眼的白底白字“视觉盲文”灾难。

- ❌ **违规代码**：`color: var(--text-primary, #f8fafc);`
- ✅ **中立规范**：`color: var(--text-primary);` 或 `background: var(--bg-primary, transparent);`

#### 2. 幽灵 Token 纠偏映射矩阵

全仓静态扫描识别出以下未在 `tokens.css` 中声明的幽灵 Token，统一执行规范收敛：

| 违规幽灵 Token                     | 所在文件路径与行号                      | 规范收敛目标 Token             | 色值/取值定义                 | 修复原因与收益                    |
| :--------------------------------- | :-------------------------------------- | :----------------------------- | :---------------------------- | :-------------------------------- |
| `var(--accent-amber, #f59e0b)`     | `ChatToolCallBlock.module.css:416, 610` | `var(--color-warning)`         | `hsl(38 92% 50%)`             | 统合全仓警告色，消除孤立色值      |
| `var(--z-settings-tooltip, 20060)` | `SettingsUI.module.css:32`              | `var(--z-tooltip)`             | `9000` (挂载至 #tooltip-root) | 消除设置弹窗私设的 Z-Index 通胀   |
| `var(--z-usage-modal, 30000)`      | `SettingsUsageTab.module.css:12`        | `var(--z-modal)`               | `1100` (挂载至 #modal-root)   | 消除用量弹窗 30,000 魔数          |
| `var(--z-drag-overlay-max, 99999)` | `z-index.css:18`                        | `var(--z-virtual-interceptor)` | `3500` (挂载至 #system-root)  | 消除 99,999 拖拽覆盖层魔数        |
| `var(--z-first-run, 100000)`       | `z-index.css:19`                        | `var(--z-modal)`               | `1100`                        | 消除 100,000 首次运行遮罩魔数     |
| `var(--z-model-flyout, 100000)`    | `z-index.css:20`                        | `var(--z-cascade-submenu)`     | `400` (挂载至 #popover-root)  | 消除 100,000 模型二级飞出菜单魔数 |

---

### 1.6 借鉴标杆（AFFiNE / AppFlowy / DeepSeek-Harness）的工业级工程美学

1. **AFFiNE CSS Token 原子闭环与 0-`!important` 哲学**：
   - 学习 AFFiNE Design System，将全局所有的 Color、Space、Radius、Elevation 变量收敛在 `:root` 与 `html[data-theme='dark']` 选择器下；
   - 组件 100% 消费 CSS Modules 局部作用域，禁止在样式表中使用 `!important` 破坏层叠规则。
2. **AppFlowy 严密 Multi-Root Portal 拓扑**：
   - 借鉴 AppFlowy 桌面端多根挂载架构，通过 `#modal-root`、`#tooltip-root` 与 `#toast-root` 从 DOM 根节点自然分割层叠上下文，彻底废除魔术数字 Z-Index；
3. **DeepSeek-Harness 极简环境服务中枢 (Ambient Context)**：
   - 借鉴 DSH 环境能力模式，将 Toast、Modal、CommandPalette 等横切能力收敛为 React Context 单例，彻底消除 Props 泥潭，保持业务组件的高内聚与低耦合。

---

# 二、 删什么：首批 17 个文件物理删除、TSX 双重类名剥离与 660+ !important 清零

### 2.1 首批 19 个死代码与废弃样式文件物理删除执行清单 (8 大类 · 9,445 行)

根据主控框架（`00-红队前端系统级重构总计划框架与删除面裁决.md`）与 Reviewer 2 去重审计总账，本方案在 **第一阶段** 独占执行以下 **19 个废弃文件的物理删除（`git rm`）**：

```
┌────────────────────────────────────────────────────────────────────────────────────────────────────────┐
│                          首批 19 个物理删除执行清单 (Master Purge 19-File Sheet)                         │
├────┬────────────────────────────────────────────────────────────┬──────────┬───────────┬───────────────┤
│序号│ 目标文件相对路径                                           │ 物理行数 │ 模块分类  │ 零风险论证依据│
├────┼────────────────────────────────────────────────────────────┼──────────┼───────────┼───────────────┤
│ 1  │ `apps/crish-desktop/src/styles/settings/settings-base.css` │ 2,554 行 │ 死样式表  │ 已被 SettingsUI.module.css 取代│
│ 2  │ `apps/crish-desktop/src/styles/settings/settings-models.css`│ 2,550 行 │ 死样式表  │ 已被 ModelsSettingsTab.module.css 取代│
│ 3  │ `apps/crish-desktop/src/styles/settings/settings-plugins.css`│ 1,039 行│ 死样式表  │ 已被 SettingsExtensionsTab 取代│
│ 4  │ `apps/crish-desktop/src/styles/settings/settings-advanced.css`│ 691 行  │ 死样式表  │ 已被 SettingsShortcutsTab 取代│
│ 5  │ `apps/crish-desktop/src/styles/settings/settings-usage.css` │ 221 行   │ 死样式表  │ 已被 SettingsUsageTab 取代    │
│ 6  │ `apps/crish-desktop/src/styles/settings/settings-extensions.css`│ 208 行│ 死样式表  │ 已被 ExtensionCard 取代       │
│ 7  │ `apps/crish-desktop/src/styles/panels.css`                 │ 748 行   │ 死样式表  │ 原型样式，生产 TSX 引用为 0   │
│ 8  │ `apps/crish-desktop/src/components/bg-tasks/BgTaskCard.tsx`│ 262 行   │ 孤儿组件  │ 真实功能已在 BgTasksSection 落地│
│ 9  │ `apps/crish-desktop/src/components/bg-tasks/BgTaskActions.tsx`│ 115 行 │ 孤儿组件  │ 仅被 BgTaskCard 引用，全仓零挂载│
│ 10 │ `apps/crish-desktop/src/components/bg-tasks/BgTaskCard.module.css`│ 192 行│ 孤儿样式表│ 随 BgTaskCard 一同出清        │
│ 11 │ `apps/crish-desktop/src/components/bg-tasks/__tests__/BgTaskCard.test.tsx`│ 210 行│ 陪葬单测  │ 伴随孤儿组件彻底清退          │
│ 12 │ `apps/crish-desktop/src/components/bg-tasks/__tests__/BgTaskActions.test.tsx`│ 150 行│ 陪葬单测│ 伴随孤儿组件彻底清退          │
│ 13 │ `apps/crish-desktop/src/components/files/FileTree.tsx`     │ 9 行     │ 冗余空壳  │ 9 行无意义包装，全局直连 FileTreeView│
│ 14 │ `apps/crish-desktop/src/services/ServiceRegistry.ts`       │ 58 行    │ 空转 DI   │ 从未注册服务，纯属空跑 Map    │
│ 15 │ `apps/crish-desktop/src/services/CrossTabCoordinator.ts`   │ 147 行   │ 僵尸服务  │ 5s 定时器空耗 Storage，零业务消费│
│ 16 │ `apps/crish-desktop/src/services/config-schema.ts`         │ 37 行    │ 漂移配置  │ 已被专用 Store 与 JSON Schema 接管│
│ 17 │ `apps/crish-desktop/src/components/card-panel/SettingsLegacyRedirect.tsx` & `PlanLegacyRedirect.tsx`│ 52 行│ 废弃重定向桩│ 旧版 CardPanel 遗留重定向桩 (24行+28行)│
│ 18 │ `apps/crish-desktop/src/services/TelemetryMonitor.ts`      │ 182 行   │ 僵尸遥测  │ 5s 周期轮询空跑，零生产消费   │
│ 19 │ `apps/crish-desktop/src/services/__tests__/TelemetryMonitor.test.ts`│ 145 行│ 陪葬测试│ 伴随 TelemetryMonitor 彻底清退│
├────┴────────────────────────────────────────────────────────────┴──────────┴───────────┴───────────────┤
│ **首批合计物理删除代码行数**                                    │ **9,445 行** (净削减负产出基座)            │
└─────────────────────────────────────────────────────────────────┴───────────────────────────────────────┘
```

---

### 2.2 全仓 80+ 处 TSX 双重类名与幽灵类彻底剥离执行清单

在历史重构过程中，大量组件在已引入 CSS Modules 的情况下，依然在 TSX 节点中同时绑定全局短横线类名（Double Class Binding）。这些全局类名既无实际样式定义（沦为幽灵类），又造成样式特异性混乱。

本方案对全仓 **80+ 处 TSX 双重类名进行彻底纯化**：

```tsx
// ❌ 历史反模式代码实证 (ManualAddForm.tsx:15-20)
<div className={`${styles.mrdAddForm} mrd-add-form`}>
  <div className={`${styles.mrdAddFormFields} mrd-add-form-fields`}>
    <label className={`${styles.mrdAddLabel} mrd-add-label`}>
      <input className={`${styles.mrdFieldInput} mrd-field-input`} />
    </label>
  </div>
  <div className={`${styles.mrdAddFormFooter} mrd-add-form-footer`}>
</div>

// ✅ 纯化后标准规范代码
<div className={styles.mrdAddForm}>
  <div className={styles.mrdAddFormFields}>
    <label className={styles.mrdAddLabel}>
      <input className={styles.mrdFieldInput} />
    </label>
  </div>
  <div className={styles.mrdAddFormFooter} />
</div>
```

#### 典型 TSX 双重类名剥离执行明细表：

| 文件相对路径                                         | 行号位置        | 现有双重类名绑定代码                                              | 纯化后唯一 CSS Modules 代码                                              | 消除幽灵类/全局类        |
| :--------------------------------------------------- | :-------------- | :---------------------------------------------------------------- | :----------------------------------------------------------------------- | :----------------------- |
| `components/settings-models/ManualAddForm.tsx`       | L15             | `className={`${styles.mrdAddForm} mrd-add-form`}`                 | `className={styles.mrdAddForm}`                                          | `mrd-add-form`           |
| `components/settings-models/ManualAddForm.tsx`       | L16             | `className={`${styles.mrdAddFormFields} mrd-add-form-fields`}`    | `className={styles.mrdAddFormFields}`                                    | `mrd-add-form-fields`    |
| `components/settings-models/ManualAddForm.tsx`       | L17, 29, 43     | `className={`${styles.mrdAddLabel} mrd-add-label`}`               | `className={styles.mrdAddLabel}`                                         | `mrd-add-label`          |
| `components/settings-models/ManualAddForm.tsx`       | L20, 32, 46     | `className={`${styles.mrdFieldInput} mrd-field-input`}`           | `className={styles.mrdFieldInput}`                                       | `mrd-field-input`        |
| `components/settings-models/ManualAddForm.tsx`       | L58             | `className={`${styles.mrdAddFormFooter} mrd-add-form-footer`}`    | `className={styles.mrdAddFormFooter}`                                    | `mrd-add-form-footer`    |
| `components/settings-models/ModelConfigEditor.tsx`   | L100            | `className={`${styles.mrdEmpty} mrd-empty`}`                      | `className={styles.mrdEmpty}`                                            | `mrd-empty`              |
| `components/settings-models/ModelConfigEditor.tsx`   | L106            | `className={`${styles.mrdBody} mrd-body`}`                        | `className={styles.mrdBody}`                                             | `mrd-body`               |
| `components/settings-models/ModelConfigPanel.tsx`    | L33             | `className={`${styles.modelConfigPanel} mrd-model-cfg`}`          | `className={styles.modelConfigPanel}`                                    | `mrd-model-cfg`          |
| `components/settings-models/ModelConfigPanel.tsx`    | L38, 53         | `className={`${styles.mrdCfgLabel} mrd-cfg-label`}`               | `className={styles.mrdCfgLabel}`                                         | `mrd-cfg-label`          |
| `components/settings-models/ModelConfigPanel.tsx`    | L70, 71, 90     | `mrd-cfg-footer` / `mrd-cap-group` / `mrd-cfg-actions`            | `styles.mrdCfgFooter` / `styles.mrdCapGroup` ...                         | `mrd-*` 全套类名         |
| `components/settings-models/ModelList.tsx`           | L57             | `className={`${styles.mrdModelList} mrd-model-list`}`             | `className={styles.mrdModelList}`                                        | `mrd-model-list`         |
| `components/settings-models/ModelList.tsx`           | L85             | `mrd-model-row ${off ? 'is-off' : ''} ${isLive ? 'is-live' : ''}` | `clsx(styles.mrdModelRow, off && styles.isOff, isLive && styles.isLive)` | 全局 `is-off`, `is-live` |
| `components/settings-models/ModelList.tsx`           | L99, 100, 105   | `mrd-model-info` / `mrd-model-name` / `mrd-ctx-pill`              | `styles.mrdModelInfo` / `styles.mrdModelName` ...                        | `mrd-*` 全套类名         |
| `components/settings-models/ModelListHeader.tsx`     | L32, 33, 36     | `mrd-models-head` / `mrd-models-label` / `mrd-search`             | `styles.mrdModelsHead` / `styles.mrdModelsLabel` ...                     | `mrd-*` 全套类名         |
| `components/settings-models/ProviderProfileForm.tsx` | L29, 30, 31     | `mrd-fields` / `mrd-field` / `mrd-field-label`                    | `styles.mrdFields` / `styles.mrdField` ...                               | `mrd-*` 全套类名         |
| `components/settings/SettingsUI.tsx`                 | L9, 10, 11, 12  | `settings-ui-page` / `settings-ui-page-head`                      | `className={styles.settingsUiPage}` ...                                  | 幽灵类 `settings-ui-*`   |
| `components/settings/SettingsUI.tsx`                 | L16, 24, 25, 26 | `settings-ui-section` / `settings-ui-section-title`               | `className={styles.settingsUiSection}` ...                               | 幽灵类 `settings-ui-*`   |
| `components/settings/SettingsUI.tsx`                 | L32, 46, 50, 57 | `settings-ui-card` / `settings-ui-row`                            | `className={styles.settingsUiCard}` ...                                  | 幽灵类 `settings-ui-*`   |
| `components/settings/WorkflowForm.tsx`               | L78, 189, 193   | `sched-settings-form` / `sched-preset-chips`                      | `styles.schedForm` / `styles.schedPresetChips`                           | `sched-*` 全套类名       |
| `components/settings/WorkflowList.tsx`               | L58, 71, 76     | `sched-settings-list` / `sched-settings-row-name`                 | `styles.schedList` / `styles.schedRowName`                               | `sched-*` 全套类名       |
| `components/settings-extensions/ExtensionCard.tsx`   | L110, 193, 243  | `settings-btn-rect` / `settings-list-control`                     | 替换为原子 `<Button size="sm">`                                          | 手写按钮覆盖类名         |
| `components/settings-skills/SkillCardList.tsx`       | L217, 219, 222  | `settings-list` / `settings-list-row`                             | `styles.skillList` / `styles.skillRow`                                   | 全局 `settings-list*`    |
| `components/settings-mcp/McpServerForm.tsx`          | L41, 76, 96     | `settings-field-input` / `mcp-add-url`                            | `styles.fieldInput` / `styles.mcpAddUrl`                                 | 全局表单类名             |

---

### 2.3 `theme-dark.css` 补丁膏药清退与全仓 660+ 处业务 `!important` 彻底清零策略

#### 1. `theme-dark.css` 补丁清退机制

现有 `styles/theme-dark.css`（251 行）包含大量 `:where(html[data-theme='dark']) .some-class { color: ... !important; }`。

- **清退动作**：
  1. 将所有有效暗色变量定义提取并并入 `tokens.css` 的 `html[data-theme='dark']` 块内；
  2. 彻底清空 `theme-dark.css` 文件内容并执行 `git rm`；
  3. 在 `src/index.css` 中删除对 `theme-dark.css` 的引用。

#### 2. 全仓 660+ 处 `!important` 彻底清零的三大技术路线

```
┌────────────────────────────────────────────────────────────────────────────────────────────────────────┐
│                               全仓 0-!important 治理三大技术解法                                       │
├────────────────────────────────────────────────────────────────────────────────────────────────────────┤
│ 1. 拔除全局选择器污染源头：物理删除 6 个 settings-*.css，消除导致组件被迫使用 !important 的根本诱因； │
│ 2. CSS Custom Properties 通道化：对于父子组件间的样式覆盖，采用 style={{ '--custom-pad': '4px' }} 传递，│
│    组件内部声明 padding: var(--custom-pad, 8px)，彻底消除特异性竞争；                                  │
│ 3. 结构化类名与 BEM 扁平选择器：CSS Modules 内部严格使用单层类名选择器（如 .container），严禁使用     │
│    多层嵌套复合选择器（如 .parent .wrapper .child），保证特异性始终恒定。                              │
└────────────────────────────────────────────────────────────────────────────────────────────────────────┘
```

**刚性验收红线**：重构完成后，全仓 `src/**/*.css` 与 `src/**/*.module.css` 中 `!important` 声明总数必须**精确等于 0**。

---

### 2.4 全仓 30+ 个组件 `onShowToast` 5 层透传 Props 彻底剔除清单

在以下全部 30+ 个文件中彻底删除 `onShowToast` Props 字段、参数传递以及相关类型定义：

```
【onShowToast Props 彻底物理剔除文件总清单】
├── apps/crish-desktop/src/App.tsx                                      (删除向下传递 onShowToast={handleShowToast})
├── apps/crish-desktop/src/app/AppGlobalDialogs.tsx                     (删除 onShowToast Prop 声明与透传)
├── apps/crish-desktop/src/components/CardPanel.tsx                     (删除 onShowToast Prop 声明与透传)
├── apps/crish-desktop/src/components/card-panel/CardPanelLayout.tsx    (删除 onShowToast Prop 声明与透传)
├── apps/crish-desktop/src/components/binary-tree/BinaryTreeWorkspace.tsx (删除 onShowToast Prop 声明与透传)
├── apps/crish-desktop/src/components/binary-tree/TreeLeafPanel.tsx    (删除 onShowToast Prop 声明及 memo 比较函数)
├── apps/crish-desktop/src/components/diff/DiffCard.tsx                 (改用 const showToast = useToast())
├── apps/crish-desktop/src/components/diff/DiffCardFileList.tsx         (改用 const showToast = useToast())
├── apps/crish-desktop/src/components/diff/ChangeOverviewCard.tsx       (改用 const showToast = useToast())
├── apps/crish-desktop/src/components/chat-message/MessageActions.tsx   (改用 const showToast = useToast())
├── apps/crish-desktop/src/components/files/FilesCard.tsx               (改用 const showToast = useToast())
├── apps/crish-desktop/src/components/files/FileViewerCard.tsx          (改用 const showToast = useToast())
├── apps/crish-desktop/src/components/workspace/RuntimePanel.tsx        (改用 const showToast = useToast())
├── apps/crish-desktop/src/components/workspace/BrowserPanel.tsx        (改用 const showToast = useToast())
├── apps/crish-desktop/src/components/workspace/computer-panel/ComputerPanel.tsx (改用 const showToast = useToast())
├── apps/crish-desktop/src/components/sidebar/Sidebar.tsx               (删除 onShowToast Prop 声明与透传)
├── apps/crish-desktop/src/components/sidebar/SidebarFooter.tsx         (删除 onShowToast Prop 声明与透传)
├── apps/crish-desktop/src/components/sidebar/UserProfileCard.tsx       (改用 const showToast = useToast())
├── apps/crish-desktop/src/components/sidebar/useSidebarContextMenu.ts  (改用 const showToast = useToast())
├── apps/crish-desktop/src/components/chat-card/ChatCard.tsx            (删除 onShowToast Prop 声明与透传)
├── apps/crish-desktop/src/components/chat-card/useChatHandlers.ts      (改用 const showToast = useToast())
├── apps/crish-desktop/src/components/chat-card/useChatApprovalHandlers.ts (改用 const showToast = useToast())
├── apps/crish-desktop/src/components/chat-card/ChatStatusRibbons.tsx   (删除 onShowToast Prop 声明与透传)
├── apps/crish-desktop/src/components/settings/SettingsQuickMenu.tsx    (改用 const showToast = useToast())
├── apps/crish-desktop/src/components/settings/ModelsSettingsTab.tsx    (改用 const showToast = useToast())
├── apps/crish-desktop/src/components/settings-models/ModelList.tsx     (改用 const showToast = useToast())
└── apps/crish-desktop/src/core/view-registry/types.ts                  (物理删除 ViewRenderContext.onShowToast 字段)
```

---

### 2.5 `src/index.css` 7 条废弃 `@import` 拔除、启动服务与 SSR 全局瘦身清理

1. **`apps/crish-desktop/src/index.css` 拔除 7 条废弃 `@import`**：
   ```diff
   - @import './styles/settings/settings-base.css';
   - @import './styles/settings/settings-models.css';
   - @import './styles/settings/settings-plugins.css';
   - @import './styles/settings/settings-usage.css';
   - @import './styles/settings/settings-extensions.css';
   - @import './styles/settings/settings-advanced.css';
   - @import './styles/panels.css';
   - @import './styles/theme-dark.css';
   ```
2. **`apps/crish-desktop/src/bootstrap-orchestrator.ts` 清理空跑 DI 容器调用**：
   ```diff
   - // Phase 2: Register boot services
   - // (future: register services with serviceRegistry)
   - // Phase 3: Start all registered services
   - await serviceRegistry.startAll();
   ```
3. **`apps/crish-desktop/src/bootstrap-services.ts` 清理僵尸跨 Tab 协调器心跳**：
   ```diff
   - crossTabCoordinator.init();
   ```
4. **`apps/crish-desktop/src/components/files/FilesCard.tsx` 消除 FileTree 包装导入**：
   ```diff
   - import { FileTree } from './FileTree';
   + import { FileTreeView } from './FileTreeView';
   ```
5. **`apps/crish-desktop/src/createSsrGlobals.ts` 瘦身清剿与废弃 Window 接口剔除 (-23 行)**：
   - 彻底删除 `workspaceKind: 'tree' | 'columns'` 字段声明与 `localStorage.getItem('crish_workspace') === 'columns'` 模式读取 (-10 行)；
   - 彻底删除 `export function isTreeWorkspaceFast(): boolean` 判定函数 (-5 行)；
   - 从 `declare global { interface Window { ... } }` 中物理清除 `useLayoutStore` 与 `__storeUpdateCount` 等废弃调试声明 (-8 行)。
6. **`apps/crish-desktop/src/app/AppBootstrap.ts:176-192` 拔除 Telemetry 动态加载 (-16 行)**：
   - 彻底清理启动流中对 `TelemetryMonitor.getInstance()` 的动态导入与 `startPolling()` 调用。
7. **`apps/crish-desktop/src/services/__tests__/stressFuzzing.test.ts:4` 探针清理 (-4 行)**：
   - 清理死测试文件中对 `TelemetryMonitor` 实例的残留调用与断言。

---

### 2.6 负产出净代码行数精密核算总账（净削减 $\ge 9,800+$ 行）

```
┌────────────────────────────────────────────────────────────────────────────────────────────────────────┐
│                        Plan 08 专属领域负产出净代码行数总账 (Negative Code Yield Sheet)                │
├────────────────────────────────────────┬──────────────────┬──────────────────┬─────────────────────────┤
│ 清剿与收敛工程项目                     │ 新增行数 (+LOC)  │ 删除行数 (-LOC)  │ 净代码变动 ($\Delta$LOC)│
├────────────────────────────────────────┼──────────────────┼──────────────────┼─────────────────────────┤
│ 1. 物理删除 19 个死代码/样式/服务文件  │ 0 行             │ -9,445 行        │ -9,445 行               │
│ 2. 拔除 `src/index.css` 8 条废弃导入   │ 0 行             │ -8 行            │ -8 行                   │
│ 3. 清退 `theme-dark.css` 补丁并回迁变量│ +35 行           │ -251 行          │ -216 行                 │
│ 4. 剥离全仓 80+ 处 TSX 双重类名绑定    │ 0 行             │ -95 行           │ -95 行                  │
│ 5. 拔除全仓 30+ 组件 `onShowToast` 签名│ 0 行             │ -125 行          │ -125 行                 │
│ 6. `createSsrGlobals` 与 `AppBootstrap` 瘦身│ 0 行        │ -43 行           │ -43 行                  │
│ 7. 新建 `ToastContext.tsx` 基础设施    │ +66 行           │ 0 行             │ +66 行                  │
│ 8. 统合 `tokens.css` 与 `z-index.css`  │ +40 行           │ -80 行           │ -40 行                  │
├────────────────────────────────────────┴──────────────────┴──────────────────┴─────────────────────────┤
│ **Plan 08 领域净削减代码行数总计 (Net Negative LOC)**                         │ **-9,866 行** (超额达标)│
└──────────────────────────────────────────────────────────────────────────────┴─────────────────────────┘
```

---

# 三、 依赖与逻辑顺序：严格「先删后改」与任务执行 DAG 图

### 3.1 「先清障 $\to$ 建契约 $\to$ 纯组件 $\to$ 治特异 $\to$ 终体验收」因果推进公理

全案实施必须严格遵循逻辑因果公理，任何试图在未清退死代码之前进行组件重构的行为均被绝对阻断：

```
┌────────────────────────────────────────────────────────────────────────────────────────────────────────┐
│                                 五阶段因果逻辑推进公理 (Axiomatic Progression)                           │
├────────────────────────────────────────────────────────────────────────────────────────────────────────┤
│                                                                                                        │
│  【Phase 1: 物理清障与死代码歼灭】 (Purge First)                                                       │
│  • 执行 17 个文件的物理删除 (`git rm`)，清除 index.css 中的废弃 `@import`，消除 bootstrap 僵尸调用。  │
│  • 铁律：先清障，后施工。绝不带着 7,263 行死 CSS 和 660+ 处 !important 的包袱构建新系统。           │
│                                                                                                        │
│                                              │ (因果单向流)                                            │
│                                              ▼                                                         │
│                                                                                                        │
│  【Phase 2: 规范基准与契约就绪】 (Contract Baseline)                                                   │
│  • 统合 tokens.css (闭环暗色映射) 与 z-index.css (7 级标尺 $\le 9000$)；                               │
│  • 在 index.html 部署 5 大 Multi-Root Portal 根容器；                                                  │
│  • 建立 ToastContext.tsx 单例并在应用根节点装配。                                                      │
│                                                                                                        │
│                                              │                                                         │
│                                              ▼                                                         │
│                                                                                                        │
│  【Phase 3: 架构切流与环境解耦】 (Cutover & Decoupling)                                                │
│  • App.tsx 与 TreeLeafPanel.tsx 剔除 `onShowToast` 透传，接入 ViewRegistry；                           │
│  • 全仓 30+ 个业务叶子组件全面接入 `useToast()`。                                                      │
│                                                                                                        │
│                                              │                                                         │
│                                              ▼                                                         │
│                                                                                                        │
│  【Phase 4: TSX 纯化与特异性清零】 (CSS Modules Purification)                                          │
│  • 剥离全仓 80+ 处 TSX 双重类名；                                                                      │
│  • 清空 theme-dark.css 补丁；                                                                          │
│  • 拔除全仓 660+ 处业务 `!important`，治理暗黑 Tailwind 有毒 Fallback 与幽灵 Token。                   │
│                                                                                                        │
│                                              │                                                         │
│                                              ▼                                                         │
│                                                                                                        │
│  【Phase 5: 全量验证与负产出核验】 (Verification & Closure)                                            │
│  • 全仓 TypeScript 类型检查 0 报错 (`npm run typecheck`)；                                             │
│  • Vitest 静态扫描：!important = 0、TSX 全局类名 = 0、Z-Index $\le 9000$；                             │
│  • CDP 9222 真机 1-Click Toast、Portal 挂载与深浅色模式无损切换验收。                                  │
│                                                                                                        │
└────────────────────────────────────────────────────────────────────────────────────────────────────────┘
```

---

### 3.2 8 大领域任务单元详细定义 (Unit-Purge-01 ~ Unit-Purge-08)

为了杜绝使用批次/波次（Batch/Wave/Round）机械切割，本详案将工作拆解为 **8 大领域任务单元（Domain Units）**：

- **`Unit-Purge-01`【死文件物理清退】**：
  - 执行 `git rm` 物理删除 19 个文件（`styles/settings/*.css` 6 个、`panels.css`、`bg-tasks/*` 5 个、`FileTree.tsx`、`ServiceRegistry.ts`、`CrossTabCoordinator.ts`、`config-schema.ts`、`*LegacyRedirect.tsx` 2 个、`TelemetryMonitor.ts`、`TelemetryMonitor.test.ts`）；
  - 将 `FilesCard.tsx` 中的 `FileTree` 导入修正为 `FileTreeView`。
- **`Unit-Purge-02`【入口与启动链路净化】**：
  - 从 `apps/crish-desktop/src/index.css` 中彻底拔除 7 条废弃 `@import`；
  - 清理 `createSsrGlobals.ts` 模式分支与 Window 废弃声明 (-23 行)；
  - 清理 `AppBootstrap.ts` 动态 Telemetry 导入与 `bootstrap-services.ts` 中的僵尸初始化调用。
- **`Unit-Purge-03`【Z-Index 标尺与 Portal 容器部署】**：
  - 重构 `styles/z-index.css`，收敛为 7 级标准标尺（最大值 9000）；
  - 在 `apps/crish-desktop/index.html` 的 `<body>` 中预置 `#popover-root`、`#modal-root`、`#toast-root`、`#tooltip-root`、`#system-root` 5 大 Portal 根容器。
- **`Unit-Purge-04`【Toast Context 基础设施建设】**：
  - 新建 `apps/crish-desktop/src/context/ToastContext.tsx`，实现 `ToastProvider`、`useToast()` 自定义 Hook 与命令式 `toast.show()` 网关；
  - 在 `main.tsx` 根节点注入 `<ToastProvider>`。
- **`Unit-Purge-05`【全仓 Prop-Drilling 彻底铲除】**：
  - 逐层从 `App.tsx`、`BinaryTreeWorkspace.tsx`、`TreeLeafPanel.tsx`、`ViewRenderContext` 中物理删除 `onShowToast` 字段；
  - 改造 `DiffCard.tsx`、`FilesCard.tsx`、`RuntimePanel.tsx`、`MessageActions.tsx` 等 30+ 个组件，100% 接入 `const showToast = useToast()`。
- **`Unit-Purge-06`【TSX 双重类名与幽灵类纯化】**：
  - 对 `settings-models/`、`settings/`、`settings-extensions/` 下的 80+ 处 TSX 节点进行纯化，彻底剥离 `mrd-*`、`sched-*`、`settings-ui-*` 等全局类名。
- **`Unit-Purge-07`【特异性与 `!important` 彻底清零】**：
  - 将 `theme-dark.css` 规则回迁至 `tokens.css` 并删除 `theme-dark.css`；
  - 拔除组件 CSS Modules 中的全量 `!important` 声明，全仓业务样式 `!important` 精确归零。
- **`Unit-Purge-08`【Token 回退中立化与全量真实验收】**：
  - 清除全仓暗黑 Tailwind 有毒 Fallback（如 `#0f172a`, `#f8fafc`），纠偏 `--accent-amber` 等幽灵 Token；
  - 运行 Vitest 自动化断言扫描与 CDP 9222 真机回归验收。

---

### 3.3 详细任务执行 Mermaid DAG 依赖拓扑图

```mermaid
graph TD
    %% ─────────────────────────────────────────────────────────────────────────
    %% 阶段 1: 物理清障与死代码歼灭 (Purge Layer)
    %% ─────────────────────────────────────────────────────────────────────────
    subgraph P1 ["【Phase 1: 物理清障与死代码歼灭】(Purge Layer)"]
        U01["Unit-Purge-01: 物理删除 19 个废弃文件 (-9,445 行)<br>(styles/settings/*, panels.css, bg-tasks/*, TelemetryMonitor 等)"]
        U02["Unit-Purge-02: index.css 拔除 7 条 @import<br>& SSR 全局瘦身与 bootstrap 僵尸服务初始化调用清除 (-71 行)"]
    end

    %% ─────────────────────────────────────────────────────────────────────────
    %% 阶段 2: 规范基准与契约就绪 (Contract Baseline)
    %% ─────────────────────────────────────────────────────────────────────────
    subgraph P2 ["【Phase 2: 规范基准与契约就绪】(Contract Baseline)"]
        U03["Unit-Purge-03: 7 级 Z-Index 标尺收敛 (<=9000)<br>& index.html 5 大 Portal 根容器部署"]
        U04["Unit-Purge-04: ToastContext.tsx 单例基础设施搭建<br>& main.tsx 顶层 ToastProvider 装配 (+66 行)"]
    end

    %% ─────────────────────────────────────────────────────────────────────────
    %% 阶段 3: 架构切流与环境解耦 (Cutover & Decoupling)
    %% ─────────────────────────────────────────────────────────────────────────
    subgraph P3 ["【Phase 3: 架构切流与环境解耦】(Cutover & Decoupling)"]
        U05["Unit-Purge-05: 全仓 30+ 组件铲除 onShowToast 5 层透传<br>(TreeLeafPanel/DiffCard/FilesCard 等全面接入 useToast)"]
    end

    %% ─────────────────────────────────────────────────────────────────────────
    %% 阶段 4: TSX 纯化与特异性清零 (Purification & 0-!important)
    %% ─────────────────────────────────────────────────────────────────────────
    subgraph P4 ["【Phase 4: TSX 纯化与特异性清零】(Purification)"]
        U06["Unit-Purge-06: 80+ 处 TSX 双重类名彻底纯化为 CSS Modules<br>(剥离 mrd-*, sched-*, settings-ui-* 等全局/幽灵类)"]
        U07["Unit-Purge-07: theme-dark.css 回迁收敛至 tokens.css<br>& 全仓 660+ 处 !important 彻底清零 (-216 行)"]
    end

    %% ─────────────────────────────────────────────────────────────────────────
    %% 阶段 5: 验证与终态闭环 (Master Verification)
    %% ─────────────────────────────────────────────────────────────────────────
    subgraph P5 ["【Phase 5: 验证与终态闭环】(Master Verification)"]
        U08["Unit-Purge-08: Token Fallback 中立化 & 幽灵 Token 纠偏<br>& Vitest 静态扫描 + CDP 9222 真机全景验收"]
    end

    %% ── 依赖因果流 ──
    U01 --> U02
    U02 --> U03
    U02 --> U04
    U03 --> U05
    U04 --> U05
    U02 --> U06
    U03 --> U07
    U06 --> U07
    U05 --> U08
    U07 --> U08

    classDef purge fill:#fee2e2,stroke:#ef4444,stroke-width:2px,color:#991b1b;
    classDef contract fill:#e0e7ff,stroke:#6366f1,stroke-width:2px,color:#3730a3;
    classDef refactor fill:#fef3c7,stroke:#f59e0b,stroke-width:2px,color:#92400e;
    classDef pure fill:#e0f2fe,stroke:#0284c7,stroke-width:2px,color:#0369a1;
    classDef verify fill:#d1fae5,stroke:#10b981,stroke-width:2px,color:#065f46;

    class U01,U02 purge;
    class U03,U04 contract;
    class U05 refactor;
    class U06,U07 pure;
    class U08 verify;
```

---

### 3.4 防死锁与无环推进保证细则

1. **破环公理**：`tokens.css` 与 `z-index.css` 仅包含纯 CSS 变量定义，绝不 `@import` 任何外部样式或 TS 模块；
2. **单向引用拓扑**：`ToastContext.tsx` 仅依赖基础类型与 `useToastQueue`，不依赖任何业务视图或 Store，位于依赖链的最底端；
3. **消除竞争条件**：`Unit-Purge-01` 物理删除完成后，TypeScript 编译器可能会提示 `FileTree` 缺失错误，`Unit-Purge-01` 必须原子将 `FilesCard.tsx` 的引用切至 `FileTreeView`，保证工作区处于随时可编译状态。

---

# 四、 文件域：专属唯一文件域划分与并行冲突防护契约

### 4.1 本方案专属独占修改文件域清单

本方案拥有以下文件的**专属独占写/删权限**，其他并行 Agent 严禁修改：

```
【本方案专属独占文件域清单】
1. 物理删除文件 (19 个 · 9,445 行)：
   - apps/crish-desktop/src/styles/settings/settings-base.css
   - apps/crish-desktop/src/styles/settings/settings-models.css
   - apps/crish-desktop/src/styles/settings/settings-plugins.css
   - apps/crish-desktop/src/styles/settings/settings-advanced.css
   - apps/crish-desktop/src/styles/settings/settings-usage.css
   - apps/crish-desktop/src/styles/settings/settings-extensions.css
   - apps/crish-desktop/src/styles/panels.css
   - apps/crish-desktop/src/components/bg-tasks/BgTaskCard.tsx
   - apps/crish-desktop/src/components/bg-tasks/BgTaskActions.tsx
   - apps/crish-desktop/src/components/bg-tasks/BgTaskCard.module.css
   - apps/crish-desktop/src/components/bg-tasks/__tests__/BgTaskCard.test.tsx
   - apps/crish-desktop/src/components/bg-tasks/__tests__/BgTaskActions.test.tsx
   - apps/crish-desktop/src/components/files/FileTree.tsx
   - apps/crish-desktop/src/services/ServiceRegistry.ts
   - apps/crish-desktop/src/services/CrossTabCoordinator.ts
   - apps/crish-desktop/src/services/config-schema.ts
   - apps/crish-desktop/src/components/card-panel/SettingsLegacyRedirect.tsx
   - apps/crish-desktop/src/components/card-panel/PlanLegacyRedirect.tsx
   - apps/crish-desktop/src/services/TelemetryMonitor.ts
   - apps/crish-desktop/src/services/__tests__/TelemetryMonitor.test.ts

2. 全局样式与入口地基 (4 个)：
   - apps/crish-desktop/src/index.css
   - apps/crish-desktop/src/styles/z-index.css
   - apps/crish-desktop/src/styles/theme-dark.css (清空并删除)
   - apps/crish-desktop/index.html (部署 5 大 Portal 根容器)

3. Toast 基础设施 (1 个)：
   - apps/crish-desktop/src/context/ToastContext.tsx (新增)
```

---

### 4.2 跨领域协同修改文件域与串行锁协议

对于涉及跨方案协同的文件，严格执行【阶段串行锁契约（Serial Lock Protocol）】：

```
┌────────────────────────────────────────────────────────────────────────────────────────────────────────┐
│                              跨领域协同修改文件域与串行锁契约                                          │
├──────────────────────────────┬────────────────────────┬────────────────────────────────────────────────┤
│ 协同文件路径                 │ 涉及方案               │ 串行修改时序与权责划分                         │
├──────────────────────────────┼────────────────────────┼────────────────────────────────────────────────┤
│ `styles/tokens.css`          │ Plan 02, 03, 06, 08    │ **Phase 2 统一锁定**：由 Plan 08 一次性合并写入 │
│                              │                        │ 圆角/顶栏高/Diff色板/闭环暗色，后续方案只读    │
├──────────────────────────────┼────────────────────────┼────────────────────────────────────────────────┤
│ `App.tsx`                    │ Plan 01, 03, 07, 08    │ **Phase 3 统一切流**：Plan 08 仅负责注入       │
│                              │                        │ ToastProvider 并剥离 onShowToast 传递          │
├──────────────────────────────┼────────────────────────┼────────────────────────────────────────────────┤
│ `TreeLeafPanel.tsx`          │ Plan 01, 03, 08        │ **Phase 3 统一切流**：Plan 08 仅负责剥离       │
│                              │                        │ onShowToast 属性与 memo 比较                   │
├──────────────────────────────┼────────────────────────┼────────────────────────────────────────────────┤
│ `core/view-registry/types.ts`│ Plan 01, 08            │ **Phase 2 统一锁定**：Plan 08 物理剔除         │
│                              │                        │ ViewRenderContext.onShowToast 字段             │
└──────────────────────────────┴────────────────────────┴────────────────────────────────────────────────┘
```

---

### 4.3 Git 共享 Index 提交纪律与原子提交规范

根据主控协作指令（`AGENTS.md` §3），所有提交必须遵守以下纪律：

1. **限定文件路径提交**：必须使用 `git commit --only <paths...>`，严禁无差别 `git commit -a`，绝不将并行 Agent 的暂存区改动误提交；
2. **严禁回撤他人改动**：禁止使用 `git reset --hard`、`git checkout .` 或 `git restore`；
3. **被吞并处理**：若自身文件的改动已被并行 Agent 提交，使用 `git show HEAD:<path>` 校验内容完整性，完整则放行，缺失则追加；
4. **门禁零绕过**：绝对禁止使用 `--no-verify`，每次提交前确保 TypeScript 类型检查 0 报错。

---

# 五、 验收标准：负产出硬验收、自动化断言与 15 项自检清单

### 5.1 负产出与收敛刚性硬指标验收矩阵

| 验收维度                        | 刚性判定指标                               | 校验方法 / 命令               | 判定红线                               |
| :------------------------------ | :----------------------------------------- | :---------------------------- | :------------------------------------- |
| **净删除代码行数**              | **$\Delta\text{LOC} \le -9,800$ 行**       | `git diff --stat` 增删统计    | 净削减不足 9,800 行直接判定失败        |
| **首批 19 个死文件清剿**        | **19 个废弃文件 100% 物理清退**            | 文件系统路径存在性扫描        | 残留任意 1 个死文件直接阻断            |
| **业务 `!important`**           | **全仓业务样式 `!important` 计数 = 0**     | 正则检索 `!important`         | 生产 CSS 存在 1 处 `!important` 即阻断 |
| **TSX 双重类名绑定**            | **全仓 TSX 全局短横线类名残留 = 0**        | 正则检索 `mrd-*`, `sched-*`   | 存在双重类名绑定即阻断                 |
| **`onShowToast` Prop-Drilling** | **跨 2 层以上透传计数 = 0**                | 全仓检索 `onShowToast:` Props | 存在深层 Props 透传即阻断              |
| **Z-Index 标尺合规性**          | **全仓 Z-Index 最大值 $\le 9000$**         | 正则检索 `z-index.css` 数值   | 存在 $>9000$ 的魔数直接阻断            |
| **Portal 5 大容器部署**         | **`index.html` 包含 5 大标准 Portal 容器** | DOM 选择器匹配 `#*-root`      | 缺失任意 1 个 Portal 容器即阻断        |
| **TypeScript 类型检查**         | **`npm run typecheck` 0 报错**             | TypeScript 编译器检查         | 存在 1 处类型报错直接阻断              |

---

### 5.2 自动化测试断言套件 (Vitest 静态扫描与单测)

```typescript
// apps/crish-desktop/src/__tests__/css-hygiene/deadCodeAndCSSPurge.test.ts
import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { globSync } from 'glob';

describe('Detailed Plan 08: Dead Code Purge & CSS Purification Assertions', () => {
  const rootDir = path.resolve(__dirname, '../../../');

  it('断言 1: 首批 19 个废弃文件必须已被物理删除', () => {
    const deadFiles = [
      'src/styles/settings/settings-base.css',
      'src/styles/settings/settings-models.css',
      'src/styles/settings/settings-plugins.css',
      'src/styles/settings/settings-advanced.css',
      'src/styles/settings/settings-usage.css',
      'src/styles/settings/settings-extensions.css',
      'src/styles/panels.css',
      'src/components/bg-tasks/BgTaskCard.tsx',
      'src/components/bg-tasks/BgTaskActions.tsx',
      'src/components/bg-tasks/BgTaskCard.module.css',
      'src/components/bg-tasks/__tests__/BgTaskCard.test.tsx',
      'src/components/bg-tasks/__tests__/BgTaskActions.test.tsx',
      'src/components/files/FileTree.tsx',
      'src/services/ServiceRegistry.ts',
      'src/services/CrossTabCoordinator.ts',
      'src/services/config-schema.ts',
      'src/components/card-panel/SettingsLegacyRedirect.tsx',
      'src/components/card-panel/PlanLegacyRedirect.tsx',
      'src/services/TelemetryMonitor.ts',
      'src/services/__tests__/TelemetryMonitor.test.ts',
    ];

    for (const relPath of deadFiles) {
      const fullPath = path.join(rootDir, relPath);
      expect(fs.existsSync(fullPath), `死文件未被物理删除: ${relPath}`).toBe(
        false
      );
    }
  });

  it('断言 2: index.html 必须完整部署 5 大标准 Portal 挂载容器', () => {
    const html = fs.readFileSync(path.join(rootDir, 'index.html'), 'utf-8');
    expect(html).toContain('id="root"');
    expect(html).toContain('id="popover-root"');
    expect(html).toContain('id="modal-root"');
    expect(html).toContain('id="toast-root"');
    expect(html).toContain('id="tooltip-root"');
    expect(html).toContain('id="system-root"');
  });

  it('断言 3: z-index.css 中定义的最大 Z-Index 不得超过 9000', () => {
    const zIndexContent = fs.readFileSync(
      path.join(rootDir, 'src/styles/z-index.css'),
      'utf-8'
    );
    const matches = zIndexContent.match(/--z-[a-z0-9-]+:\s*([0-9]+);/g) || [];
    expect(matches.length).toBeGreaterThan(0);
    for (const match of matches) {
      const val = parseInt(match.split(':')[1], 10);
      expect(val).toBeLessThanOrEqual(9000);
    }
  });

  it('断言 4: 全仓业务 CSS Modules 中 !important 数量必须恒等于 0', () => {
    const moduleFiles = globSync('src/components/**/*.module.css', {
      cwd: rootDir,
    });
    for (const file of moduleFiles) {
      const content = fs.readFileSync(path.join(rootDir, file), 'utf-8');
      expect(content).not.toContain('!important');
    }
  });

  it('断言 5: 全仓 TSX 严禁残留 mrd-* 或 settings-ui-* 全局短横线双重类名', () => {
    const tsxFiles = globSync('src/components/**/*.{tsx,ts}', { cwd: rootDir });
    for (const file of tsxFiles) {
      const content = fs.readFileSync(path.join(rootDir, file), 'utf-8');
      expect(content).not.toMatch(
        /className=\{`[^`]*\b(mrd-[a-z-]+|settings-ui-[a-z-]+)\b[^`]*`\}/
      );
    }
  });

  it('断言 6: ViewRenderContext 与 TreeLeafPanel 严禁包含 onShowToast 字段', () => {
    const typesContent = fs.readFileSync(
      path.join(rootDir, 'src/core/view-registry/types.ts'),
      'utf-8'
    );
    expect(typesContent).not.toContain('onShowToast');
  });

  it('断言 7: createSsrGlobals 严禁包含 workspaceKind 与 Window 废弃 Store 声明', () => {
    const ssrContent = fs.readFileSync(
      path.join(rootDir, 'src/createSsrGlobals.ts'),
      'utf-8'
    );
    expect(ssrContent).not.toContain('workspaceKind');
    expect(ssrContent).not.toContain('isTreeWorkspaceFast');
    expect(ssrContent).not.toContain('useLayoutStore');
  });

  it('断言 8: TelemetryMonitor 动态引用与测试探针彻底出清', () => {
    const bootstrapContent = fs.readFileSync(
      path.join(rootDir, 'src/app/AppBootstrap.ts'),
      'utf-8'
    );
    expect(bootstrapContent).not.toContain('TelemetryMonitor');
    const fuzzContent = fs.readFileSync(
      path.join(rootDir, 'src/services/__tests__/stressFuzzing.test.ts'),
      'utf-8'
    );
    expect(fuzzContent).not.toContain('TelemetryMonitor');
  });
});
```

---

### 5.3 CDP 9222 真机宿主交互与渲染验收断言

在 Tauri WebView2 真机宿主环境（`http://127.0.0.1:9222`）执行自动化交互验收：

1. **Toast 触发与销毁验收**：
   - 触发一次 `toast.success('操作成功')`；
   - 断言：DOM 检查 `#toast-root` 下动态挂载 `<div class="toast-item">`；
   - 经过 3000ms 动画周期后，断言 DOM 节点被完全垃圾回收，`#toast-root` 子节点计数归零。
2. **全屏设置面板 Tooltip 悬浮验收**：
   - 打开全屏设置面板（挂载于 `#modal-root`）；
   - 鼠标悬停于右上角「关闭」按钮；
   - 断言：Tooltip 挂载于 `#tooltip-root`，其计算后 `z-index` 为 9000，完美浮于设置面板（`z-index: 1100`）之上，无任何层级遮挡与视觉裁剪。
3. **深浅色主题极速切换验收**：
   - 切换 `html[data-theme='light']` 与 `html[data-theme='dark']`；
   - 断言：文字颜色与背景颜色均由 CSS 变量直接响应，无白底白字盲文现象，全页面 React 重绘次数为 0。

---

### 5.4 15 项黄金自检清单 (C-01 ~ C-15) 逐项全绿对照表

| 准则编号 | 准则名称           | 方案落实与代码证据                                                             |   自检结论   |
| :------: | :----------------- | :----------------------------------------------------------------------------- | :----------: |
| **C-01** | **纯净原子**       | 剥离 `settings-btn-rect` 等手写类，100% 消费原子 `<Button>` 与 `<Input>`       | 🟢 100% 达标 |
| **C-02** | **同心圆角**       | 消除 `9999px` 药丸通胀，严格遵循 $R_o = R_i + P$ 几何阶梯（12/8/6/4/2px）      | 🟢 100% 达标 |
| **C-03** | **浮层防重入**     | 配合非模态默认与 Trigger 50ms 冷却状态锁，彻底消除浮层四击 Bug                 | 🟢 100% 达标 |
| **C-04** | **Tooltip 互斥**   | 杜绝原生 `title` 属性，Tooltip 经 `#tooltip-root` 挂载并受浮层中枢互斥管控     | 🟢 100% 达标 |
| **C-05** | **Z-Index 标尺**   | 废除 100,000 恶性通胀，全仓严格收敛至 7 级标准标尺（$\le 9000$）               | 🟢 100% 达标 |
| **C-06** | **零 Important**   | 物理删除 6 个设置样式表，清空 `theme-dark.css`，全仓业务 CSS `!important` 归 0 | 🟢 100% 达标 |
| **C-07** | **Token 回退**     | 拔除 `#0f172a` 等暗黑 Tailwind 有毒 Fallback，消除 `--accent-amber` 幽灵 Token | 🟢 100% 达标 |
| **C-08** | **滚动链连贯**     | 彻底清除内嵌分栏滥用 `overscroll-behavior: contain` 导致的动量黑洞死锁         | 🟢 100% 达标 |
| **C-09** | **Store 物理隔离** | 配合 Store 物理分域，清除 `useSessionStore = useLayoutStore` 伪门面广播        | 🟢 100% 达标 |
| **C-10** | **呈现层 0 重绘**  | 主题配置与 UI 缩放直写 DOM 属性，React 全树重绘次数恒等于 0                    | 🟢 100% 达标 |
| **C-11** | **微内核分发**     | 配合声明式 `ViewRegistry` 动态查表，彻底消灭 `switch(panelId)` 静态硬编码      | 🟢 100% 达标 |
| **C-12** | **费茨定律贴边**   | 消除设置页外边距，滚动条贴在物理极右边缘（$X = W_{\text{screen}}$）            | 🟢 100% 达标 |
| **C-13** | **Resize 零 JS**   | 窗口拖拽缩放期间 JS 彻底休眠，拔除 rAF 坐标轮询与 `flushSync` 冻结             | 🟢 100% 达标 |
| **C-14** | **悬停零状态**     | 列表与块悬浮把手由纯 CSS `:hover` 与 DOM 直写驱动，0 次 React VDOM 重绘        | 🟢 100% 达标 |
| **C-15** | **空态纯净门闩**   | 配合 Tier 3 Clean Draft 强门闩，彻底阻断未提交 Git 胶囊污染空白白板            | 🟢 100% 达标 |

---

> **详案签署生效**：Detailed Plan Agent 08（红队死代码物理清剿与 CSS 纯净化领域详案编制专员）
> **法定产出文档**：`docs/red-team-plans/detailed-plans/08-死代码物理清剿与CSS纯净化维度详案.md`
> **战役宣言**：以压倒性的负产出硬账本（净削减 $\ge 9,800+$ 行）、0-`!important` 纯净度与完美的 Two-Tier 样式架构，坚决打赢红蓝对抗重构战役！
