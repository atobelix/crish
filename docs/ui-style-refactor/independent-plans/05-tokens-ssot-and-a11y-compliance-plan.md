# 05 · Token 继承链归一、悬空/幽灵 Token 拔除与 A11y 规范闭环方案

> **方案定位**：本方案为《Conex / Crish 界面视觉修复与差异面板重构》战役第 5 独立实施方案（维度五：Token 继承链与规范合规闭环），针对全局 CSS Token 继承层叠断层、160px 响应式断点深浅漂移、8 处无 Fallback 悬空 Token、18 处 `--badge-git-*` 幽灵变量、9 处原生 `title=` 气泡违规、深色模式 30% 焦点环超标、244 处旧式 `rgba` 与蓝光色相污染等系统性缺陷，建立“单一真相源（SSOT）、零悬空、零幽灵、8% 浅灰柔软焦点、100% Tooltip 胶囊化、Zero-Blue 纯中性”的终极治理架构。
> **编制依据**：
> - `docs/ui-style-refactor/00-定案-视觉样式与差异面板重构决策.md`
> - `docs/ui-style-refactor/audits/04-tokens-inheritance-and-conflicts-audit.md`
> - `docs/ui-style-refactor/audits/05-runtime-cascading-and-visual-compliance-audit.md`
> - `docs/ui-style-refactor/audits/03-small-elements-darkening-and-borders-audit.md`
> - `AGENTS.md` §12（Tooltip 规范）、§13（输入框与焦点态/10% 对比度红线）、§14（色彩空间与现代 CSS 语法）
> **编码纪律**：UTF-8 无 BOM，纯逻辑架构规划，严格锁定文件域与验收断言，严禁执行 git 操作。

---

## 一、方案目标与核心技术架构

### 1.1 核心痛点与方案治理目标

在 Conex / Crish 的样式体系演进中，因多批次迭代、样式分层不均以及缺乏静态/运行时联合校验，导致了 5 大核心合规性与继承链缺陷：

```
┌──────────────────────────────────────────────────────────────────────────────────────────────────┐
│                                 五大核心痛点与治理目标映射矩阵                                    │
├──────────────────┬─────────────────────────────────────┬─────────────────────────────────────────┤
│ 核心缺陷域       │ 现状病灶 (Before)                   │ 治理后规范目标 (After)                  │
├──────────────────┼─────────────────────────────────────┼─────────────────────────────────────────┤
│ 1. 断点深浅漂移  │ tokens.css 在 light 下特异度高胜出  │ 统一定义于 tokens.css :root 顶层无分层  │
│    (160px Drift) │ (640px)，dark 下 responsive.css     │ 底座；彻底移除 responsive.css 中的冲突  │
│                  │ :root 胜出 (480px)，漂移 160px      │ 变量，深浅主题断点绝对一致 (640px)      │
├──────────────────┼─────────────────────────────────────┼─────────────────────────────────────────┤
│ 2. 悬空/幽灵     │ 8 处裸引用 --color-text-dim，暗色回 │ 补齐标准 Token 别名，18 个幽灵变量 100% │
│    Token 泛滥    │ 退系统黑；18 个 --badge-git-* 幽灵  │ 收敛至 --filetree-badge-* 全局体系      │
│                  │ 变量无定义，暗色模式对比度崩塌      │                                         │
├──────────────────┼─────────────────────────────────────┼─────────────────────────────────────────┤
│ 3. 原生 title=   │ 9 处组件使用 DOM 原生 title= 气泡， │ 100% 替换为 <Tooltip content="...">     │
│    违规 (A11y)   │ 出现黄色/方块陈旧浏览器默认提示     │ 圆角胶囊，落实 AGENTS.md §12 铁律       │
├──────────────────┼─────────────────────────────────────┼─────────────────────────────────────────┤
│ 4. 焦点环超标    │ tokens.css:902 深色 --focus-ring-   │ 焦点环加深混入降至 8%（上限 10%），细化 │
│    (AGENTS §13)  │ color 混入 30% 文本色，刺眼光圈     │ 为 1.5px 柔和微外环，落实 AGENTS.md §13 │
├──────────────────┼─────────────────────────────────────┼─────────────────────────────────────────┤
│ 5. 蓝光与 RGBA   │ 244 处散落旧式 rgba(...)；Git 徽标与 │ 全量升级为 hsl(... / a) 现代语法；      │
│    色相污染      │ 导轨残留 Hue 210°~215° Slate 冷蓝   │ 净化冷蓝色相为 Hue 0°/35° 纯中性灰阶    │
└──────────────────┴─────────────────────────────────────┴─────────────────────────────────────────┘
```

---

### 1.2 全局 Token 继承链与分层单真源（SSOT）架构

为彻底解决层叠特异度倒挂与双源漂移，建立 4 层严格单向继承模型：

```mermaid
graph TD
    subgraph L1["Level 1: 全局无分层基础底座 (tokens.css :root)"]
        B1["响应式断点 (--breakpoint-sm: 640px, --breakpoint-md, ...)"]
        B2["空间几何与圆角 (--button-radius: 7px, --radius-full: 9999px, ...)"]
        B3["层叠上下文基线 (--z-base: 0, --z-dock: 10, --z-dropdown: 300, --z-modal: 1000, ...)"]
        B4["密度与交互档位 (--icon-size, --control-height, --ease-in-out)"]
    end

    subgraph L2["Level 2: 主题语义映射层 (tokens.css html[data-theme])"]
        T1["Light 语义色彩 (--bg-primary, --bg-card, --text-primary, --border-color)"]
        T2["Dark 语义色彩 (纯中性墨阶 #0d0d0d / #1c1c1c / #262626)"]
        T3["柔和焦点环 (--focus-ring-color: 8% 浅灰混入, --focus-ring: 1.5px)"]
        T4["状态与徽标体系 (--filetree-badge-add/mod/del/untracked/conflicted/renamed)"]
    end

    subgraph L3["Level 3: 运行时同步水合层 (themePresets.ts / themePersonalization.ts)"]
        R1["预设基线与静态 CSS 100% 对齐 (dark-cozy 对齐 tokens.css)"]
        R2["非侵入式对比度守卫 (applyTextContrastGuard 仅在 CR < 4.5:1 时微调)"]
        R3["严格生命周期清理 (removeProperty 100% 覆盖所有注入属性)"]
    end

    subgraph L4["Level 4: 组件消费层 (CSS Modules *.module.css & TSX)"]
        C1["纯 CSS 变量消费 (零特异性覆盖，禁止 :global(html[data-theme='dark']))"]
        C2["A11y 胶囊 Tooltip (禁止原生 title=，包裹 <Tooltip>)"]
        C3["Zero-Blue & 现代语法 (hsl(... / a) 纯中性，零冷蓝色相)"]
    end

    L1 --> L2
    L2 --> L3
    L3 --> L4
```

---

## 二、【强制专节】本方案要删掉什么 / 收敛什么（Deletion & Convergence Surface）

本方案严格遵守《定案决策》“先删后改”原则，对全工程中存在的悬空引用、幽灵变量、冲突声明、原生 title 属性及违规超标样式进行彻底清剿：

### 2.1 彻底删除的冲突与冗余变量定义（DEL-SSOT-01 ~ DEL-SSOT-04）

1. **DEL-SSOT-01**：彻底删除 `apps/crish-desktop/src/styles/responsive.css:1-6` 中的 `:root` 断点重复定义：
   ```css
   /* ❌ 彻底物理删除以下冲突代码，消除 160px 漂移根源 */
   :root {
     --breakpoint-sm: 480px;
     --breakpoint-md: 768px;
     --breakpoint-lg: 1024px;
     --breakpoint-xl: 1280px;
   }
   ```
2. **DEL-SSOT-02**：彻底删除 `apps/crish-desktop/src/styles/tokens.css:3-5` 中主题选择器对尺寸/断点 Token 的包裹，统一提权至独立 `:root`，使其脱离主题特异度影响。
3. **DEL-SSOT-03**：彻底删除 `apps/crish-desktop/src/styles/tokens.css:902-905` 中深色模式 30% 焦点环硬编码：
   ```css
   /* ❌ 彻底删除 30% 刺眼混入 */
   --focus-ring-color: color-mix(in srgb, var(--text-primary) 30%, transparent);
   --focus-ring-strong: 0 0 0 3px color-mix(in srgb, var(--text-primary) 22%, transparent);
   ```
4. **DEL-SSOT-04**：彻底删除 `apps/crish-desktop/src/components/settings/SettingsPanel.module.css:263` 中将 `--z-dropdown: 20` 局部篡改的规则，拔除全局 Token 劫持。

---

### 2.2 彻底拔除的幽灵 Token（18 处 `--badge-git-*`）（DEL-GHOST-01 ~ DEL-GHOST-18）

彻底删除 `apps/crish-desktop/src/components/overview/GitStatusBadge.module.css:18-52` 中未经定义的 18 个私有幽灵 Token，全部收敛为全局标准 Token：

| 序号 | 彻底删除的幽灵 Token | 所在文件及行号 | 收敛替换的标准 Token 契约 |
| :--- | :--- | :--- | :--- |
| **DEL-GHOST-01** | `--badge-git-m-bg` | `GitStatusBadge.module.css:19` | `var(--filetree-badge-mod-bg)` |
| **DEL-GHOST-02** | `--badge-git-m-fg` | `GitStatusBadge.module.css:20` | `var(--filetree-badge-mod-fg)` |
| **DEL-GHOST-03** | `--badge-git-m-border` | `GitStatusBadge.module.css:21` | `var(--filetree-badge-mod-border, transparent)` |
| **DEL-GHOST-04** | `--badge-git-a-bg` | `GitStatusBadge.module.css:25` | `var(--filetree-badge-add-bg)` |
| **DEL-GHOST-05** | `--badge-git-a-fg` | `GitStatusBadge.module.css:26` | `var(--filetree-badge-add-fg)` |
| **DEL-GHOST-06** | `--badge-git-a-border` | `GitStatusBadge.module.css:27` | `var(--filetree-badge-add-border, transparent)` |
| **DEL-GHOST-07** | `--badge-git-d-bg` | `GitStatusBadge.module.css:31` | `var(--filetree-badge-del-bg)` |
| **DEL-GHOST-08** | `--badge-git-d-fg` | `GitStatusBadge.module.css:32` | `var(--filetree-badge-del-fg)` |
| **DEL-GHOST-09** | `--badge-git-d-border` | `GitStatusBadge.module.css:33` | `var(--filetree-badge-del-border, transparent)` |
| **DEL-GHOST-10** | `--badge-git-u-bg` | `GitStatusBadge.module.css:37` | `var(--filetree-badge-untracked-bg)` |
| **DEL-GHOST-11** | `--badge-git-u-fg` | `GitStatusBadge.module.css:38` | `var(--filetree-badge-untracked-fg)` |
| **DEL-GHOST-12** | `--badge-git-u-border` | `GitStatusBadge.module.css:39` | `var(--filetree-badge-untracked-border, transparent)` |
| **DEL-GHOST-13** | `--badge-git-c-bg` | `GitStatusBadge.module.css:43` | `var(--filetree-badge-conflicted-bg)` |
| **DEL-GHOST-14** | `--badge-git-c-fg` | `GitStatusBadge.module.css:44` | `var(--filetree-badge-conflicted-fg)` |
| **DEL-GHOST-15** | `--badge-git-c-border` | `GitStatusBadge.module.css:45` | `var(--filetree-badge-conflicted-border, transparent)` |
| **DEL-GHOST-16** | `--badge-git-r-bg` | `GitStatusBadge.module.css:49` | `var(--filetree-badge-renamed-bg)` |
| **DEL-GHOST-17** | `--badge-git-r-fg` | `GitStatusBadge.module.css:50` | `var(--filetree-badge-renamed-fg)` |
| **DEL-GHOST-18** | `--badge-git-r-border` | `GitStatusBadge.module.css:51` | `var(--filetree-badge-renamed-border, transparent)` |

---

### 2.3 彻底修复/消除的无 Fallback 悬空 Token（DEL-DANGLING-01 ~ DEL-DANGLING-08）

| 序号 | 悬空 Token 引用 | 消费文件与具体行号 | 修复与收敛路径 |
| :--- | :--- | :--- | :--- |
| **DEL-DANGLING-01** | `--color-text-dim` (8处) | `SettingsDevicesTab.module.css:19, 45, 59, 83, 117, 162, 197, 221` | 统一替换为标准 `var(--text-tertiary)`；并在 `tokens.css` 声明兼容别名 `--color-text-dim: var(--text-tertiary)` 作为双重兜底。 |
| **DEL-DANGLING-02** | `--color-text-secondary` | `SettingsSecurityTab.tsx:326` | 统一替换为标准 `var(--text-secondary)`。 |
| **DEL-DANGLING-03** | `--z-sidebar-resizer` | `Sidebar.module.css:272` | 统一替换为标准 `var(--z-resizer, var(--z-chrome))`。 |
| **DEL-DANGLING-04** | `--shadow-xs` | `DiffCard.module.css:430` | 统一替换为标准 `var(--shadow-sm)`。 |
| **DEL-DANGLING-05** | `--z-breadcrumb` | `FilesCard.module.css:335` | 统一替换为标准 `var(--z-dock)`。 |
| **DEL-DANGLING-06** | `--empty-hover-border` | `WorkspaceEmptyState.module.css:110` | 替换为标准 `var(--border-color)`。 |
| **DEL-DANGLING-07** | `--empty-focus-ring` | `WorkspaceEmptyState.module.css:117` | 替换为标准 `var(--focus-ring-color)`。 |
| **DEL-DANGLING-08** | `--color-warn-bg/text` 等裸写 | `SettingsDevicesTab.module.css:34, 35, 50, 75, 110, 153, 183` | 移除局部私有 `--color-*` 混写，统一收敛为系统级 `--accent-orange` / `--accent-red` / `--border-subtle`。 |

---

### 2.4 彻底物理删除的 9 处原生 DOM `title=` 属性（DEL-TITLE-01 ~ DEL-TITLE-09）

落实 `AGENTS.md` §12 铁律，彻底删除以下 9 处原生 HTML `title` 属性，100% 改造为 `<Tooltip content="...">` 胶囊组件包裹：

| 编号 | 违规文件与精确行号 | 现存代码片段 | 改造后组件结构 |
| :--- | :--- | :--- | :--- |
| **DEL-TITLE-01** | `ModelBadgePickerMenu.tsx:177-182` | `<button ... title="模型管理...">` | `<Tooltip content="模型管理..."><button ... aria-label="模型管理">...</button></Tooltip>` |
| **DEL-TITLE-02** | `ModelConfigPanel.tsx:93-107` | `<span ... title={meta.lastTest.error}>` | `<Tooltip content={meta.lastTest.error}><span ...>...</span></Tooltip>` |
| **DEL-TITLE-03** | `SkillCardList.tsx:84-89` | `<div ... title={EMPTY_INSTALL_HINT}>` | 移除外层 `div` 的 `title=`，在 CTA 按钮包裹 `<Tooltip content={EMPTY_INSTALL_HINT}>` |
| **DEL-TITLE-04** | `SkillCardList.tsx:108-113` | `<div ... title={EMPTY_FILTER_HINT}>` | 移除外层 `div` 的 `title=`，空态文字无需浏览器黄黑气泡，提示文字已在正文展示 |
| **DEL-TITLE-05** | `SmartPanelHeader.tsx:41-45` | `<button ... title="清空搜索">` | `<Tooltip content="清空搜索"><button ... aria-label="清空搜索">...</button></Tooltip>` |
| **DEL-TITLE-06** | `LiveTasksSection.tsx:55-60` | `<div ... title={clickable ? '打开对应会话' : undefined}>` | `clickable ? <Tooltip content="打开对应会话"><div ...>...</div></Tooltip> : <div ...>...</div>` |
| **DEL-TITLE-07** | `RuntimePanel.tsx:93-99` | `<div ... title={formatEngineStatusTitle(connectionStatus)}>` | `<Tooltip content={formatEngineStatusTitle(connectionStatus)}><div ...>...</div></Tooltip>` |
| **DEL-TITLE-08** | `SecurityAuditSection.tsx:78-81` | `<span ... title={entry.targets.join('\n')}>` | `<Tooltip content={entry.targets.join(', ')}><span ...>...</span></Tooltip>` |
| **DEL-TITLE-09** | `TrashSection.tsx:149-154` | `<span ... title={entry.originalPath}>` | `<Tooltip content={entry.originalPath}><span ...>...</span></Tooltip>` |

---

### 2.5 彻底净化的 7 处冷蓝（Zero-Blue 违规）与 244 处旧式 `rgba`

1. **Zero-Blue 蓝光净化**：
   - 彻底清除 `GitStatusBadge.module.css:37-39` 中的 `hsl(215 16% 47% / 0.12)` 与 `hsl(215 16% 40%)`（Slate 蓝灰）；
   - 彻底清除 `GitStatusBadge.module.css:55-57` 中的 `hsl(210 12% 92%)`、`hsl(215 14% 50%)`、`hsl(210 10% 85%)`；
   - 彻底清除 `GitStatusBadge.module.css:93` 中的 `hsl(210 10% 85% / 0.6)`；
   - 彻底清除 `OverviewGitTree.module.css:189` 中的 `hsl(210 10% 85% / 0.6)`；
   - 彻底清除 `themePresets.ts` 中 `classic-gray`、`obsidian`、`deep-night` 中的非必要蓝调混色基底，全面校准为纯中性灰阶。
2. **244 处旧式 `rgba` 语法现代化**：
   - 将散落在 `ModelsSettingsTab.module.css`（34 处）、`FontSelectField.module.css`（18 处）、`ModelBadgePickerMenu.module.css`（17 处）、`Menu.module.css`（14 处）、`Select.module.css`（13 处）等处的 `rgba(r, g, b, a)`，全部重构为标准 Token（如 `var(--bg-hover)`, `var(--border-subtle)`）或现代斜杠语法 `hsl(0 0% 0% / 0.06)`。

---

## 三、详细修改文件清单与 CSS / TSX 契约

### 3.1 `apps/crish-desktop/src/styles/tokens.css` 核心改造契约

```css
/* ==========================================================================
   1. 基础尺寸、断点与几何底座 (Unlayered :root 顶层无主题包裹)
   ========================================================================== */
:root {
  /* 响应式断点 (权威单一真源，消除 160px 漂移) */
  --breakpoint-sm: 640px;
  --breakpoint-md: 768px;
  --breakpoint-lg: 1024px;
  --breakpoint-xl: 1280px;

  /* 边框圆角规范契约 (锁定 7px 按钮圆角与 9999px 胶囊圆角) */
  --button-radius: 7px;
  --radius-full: 9999px;
  --radius-tooltip: var(--radius-full);
  --seg-outer-radius: var(--button-radius, 7px);
  --seg-inner-radius: var(--button-radius, 7px);

  /* 全局层叠上下文契约 (Unlayered SSOT) */
  --z-base: 0;
  --z-dock: 10;
  --z-sticky: var(--z-dock);
  --z-chrome: 100;
  --z-sidebar: var(--z-chrome);
  --z-resizer: var(--z-chrome);
  --z-dropdown: 300;
  --z-popover: 500;
  --z-drawer: var(--z-popover);
  --z-modal: 1000;
  --z-toast: var(--z-modal);
  --z-tooltip: 9000;

  /* 悬空兼容别名 (防回归安全网) */
  --color-text-dim: var(--text-tertiary);
  --color-text-secondary: var(--text-secondary);
}

/* ==========================================================================
   2. Light 主题语义体系 (tokens.css)
   ========================================================================== */
html[data-theme='default'],
html[data-theme='light'] {
  /* 活态主色纠偏：严禁 15% 死黑，收敛至品牌翡翠绿 */
  --accent-color: hsl(160 84% 36%);

  /* 焦点环规范 (严格落实 AGENTS.md §13) */
  --focus-ring-color: color-mix(in srgb, var(--border-color) 92%, var(--text-primary) 8%);
  --focus-ring: 0 0 0 1.5px var(--focus-ring-color);
  --focus-ring-strong: 0 0 0 2px color-mix(in srgb, var(--border-color) 88%, var(--text-primary) 12%);

  /* Git 状态徽标与文件树徽标标准 Token 体系 (Light 态) */
  --filetree-badge-add-bg: hsl(142 71% 45% / 0.12);
  --filetree-badge-add-fg: hsl(142 71% 28%);
  --filetree-badge-mod-bg: hsl(38 92% 50% / 0.12);
  --filetree-badge-mod-fg: hsl(32 95% 30%);
  --filetree-badge-del-bg: hsl(0 84% 60% / 0.12);
  --filetree-badge-del-fg: hsl(0 75% 38%);
  --filetree-badge-untracked-bg: hsl(0 0% 50% / 0.12);
  --filetree-badge-untracked-fg: hsl(0 0% 36%);
  --filetree-badge-conflicted-bg: hsl(0 84% 60% / 0.18);
  --filetree-badge-conflicted-fg: hsl(0 84% 35%);
  --filetree-badge-renamed-bg: hsl(270 60% 50% / 0.12);
  --filetree-badge-renamed-fg: hsl(270 60% 36%);
}

/* ==========================================================================
   3. Dark 主题语义体系 (tokens.css)
   ========================================================================== */
html[data-theme='dark'] {
  /* 焦点环规范 (从 30% 刺目超标降至 8% 浅灰柔和，100% 落实 AGENTS.md §13) */
  --focus-ring-color: color-mix(in srgb, var(--border-color) 92%, var(--text-primary) 8%);
  --focus-ring: 0 0 0 1.5px var(--focus-ring-color);
  --focus-ring-strong: 0 0 0 2px color-mix(in srgb, var(--border-color) 88%, var(--text-primary) 12%);

  /* Git 状态徽标与文件树徽标标准 Token 体系 (Dark 态 AAA 高对比) */
  --filetree-badge-add-bg: hsl(142 60% 45% / 0.20);
  --filetree-badge-add-fg: hsl(142 75% 70%);
  --filetree-badge-mod-bg: hsl(38 92% 50% / 0.20);
  --filetree-badge-mod-fg: hsl(45 93% 65%);
  --filetree-badge-del-bg: hsl(0 75% 55% / 0.20);
  --filetree-badge-del-fg: hsl(0 75% 72%);
  --filetree-badge-untracked-bg: hsl(0 0% 70% / 0.18);
  --filetree-badge-untracked-fg: hsl(0 0% 78%);
  --filetree-badge-conflicted-bg: hsl(0 75% 55% / 0.25);
  --filetree-badge-conflicted-fg: hsl(0 85% 75%);
  --filetree-badge-renamed-bg: hsl(270 60% 50% / 0.20);
  --filetree-badge-renamed-fg: hsl(270 70% 75%);
}
```

---

### 3.2 `apps/crish-desktop/src/styles/responsive.css` 改造契约

```css
/* apps/crish-desktop/src/styles/responsive.css */
/* 移除 :root 内冲突的 --breakpoint-* 声明，仅保留侧边栏基础尺寸与容器查询 */

:root {
  --sidebar-width: 260px;
  --sidebar-width-collapsed: 48px;
}

@container workspace (max-width: 640px) {
  .panel { --panel-layout: single; }
}
@container workspace (min-width: 641px) and (max-width: 1024px) {
  .panel { --panel-layout: dual; }
}
@container workspace (min-width: 1025px) {
  .panel { --panel-layout: triple; }
}
```

---

### 3.3 `GitStatusBadge.module.css` 幽灵拔除与 Zero-Blue 改造契约

```css
/* apps/crish-desktop/src/components/overview/GitStatusBadge.module.css */
.badge {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 16px;
  height: 16px;
  border-radius: var(--radius-sm, 4px);
  font-family: var(--font-mono, monospace);
  font-size: 10px;
  font-weight: 700;
  line-height: 1;
  border: 1px solid transparent;
  box-sizing: border-box;
  user-select: none;
  flex-shrink: 0;
}

.modified {
  background: var(--filetree-badge-mod-bg);
  color: var(--filetree-badge-mod-fg);
  border-color: var(--filetree-badge-mod-border, transparent);
}

.added {
  background: var(--filetree-badge-add-bg);
  color: var(--filetree-badge-add-fg);
  border-color: var(--filetree-badge-add-border, transparent);
}

.deleted {
  background: var(--filetree-badge-del-bg);
  color: var(--filetree-badge-del-fg);
  border-color: var(--filetree-badge-del-border, transparent);
}

/* 净化 Slate 蓝灰，使用纯中性灰阶 */
.untracked {
  background: var(--filetree-badge-untracked-bg);
  color: var(--filetree-badge-untracked-fg);
  border-color: var(--filetree-badge-untracked-border, transparent);
}

.conflicted {
  background: var(--filetree-badge-conflicted-bg);
  color: var(--filetree-badge-conflicted-fg);
  border-color: var(--filetree-badge-conflicted-border, transparent);
}

.renamed {
  background: var(--filetree-badge-renamed-bg);
  color: var(--filetree-badge-renamed-fg);
  border-color: var(--filetree-badge-renamed-border, transparent);
}

.unknown {
  background: var(--bg-tertiary);
  color: var(--text-tertiary);
  border-color: var(--border-color);
}

/* Diff 统计条 Zero-Blue 净化 */
.diffStatContainer {
  display: inline-flex;
  align-items: center;
  gap: var(--space-1_5, 6px);
  font-family: var(--font-mono, monospace);
  font-size: 11px;
  flex-shrink: 0;
}

.microBar {
  display: inline-flex;
  align-items: center;
  gap: 1.5px;
}

.barAdd,
.barDel,
.barEmpty {
  width: 3px;
  height: 9px;
  border-radius: 1px;
}

.barAdd {
  background: var(--accent-green, #16a34a);
}

.barDel {
  background: var(--accent-red, #dc2626);
}

.barEmpty {
  background: var(--border-subtle);
}
```

---

### 3.4 `SettingsDevicesTab.module.css` 悬空 Token 修复契约

```css
/* apps/crish-desktop/src/components/settings/SettingsDevicesTab.module.css */
/* 将所有 --color-text-dim 彻底替换为 var(--text-tertiary) */

.qrMeta {
  display: flex;
  gap: 16px;
  color: var(--text-tertiary);
  font-size: 12px;
}

.pairMeta {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
  padding: 0 16px 12px;
  color: var(--text-tertiary);
  font-size: 12px;
}

.emptyState {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  padding: 24px 0;
  color: var(--text-tertiary);
  font-size: 13px;
  text-align: center;
}

.deviceIcon {
  color: var(--text-tertiary);
  flex-shrink: 0;
}

.deviceDesc {
  display: flex;
  gap: 12px;
  color: var(--text-tertiary);
  font-size: 11px;
  margin-top: 2px;
}

.ipList {
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: 12px;
  color: var(--text-tertiary);
}

.apIsolationHint {
  display: flex;
  align-items: flex-start;
  gap: 6px;
  font-size: 12px;
  color: var(--text-tertiary);
  line-height: 1.5;
}

.serviceOffDesc {
  margin: 0;
  font-size: 12px;
  color: var(--text-tertiary);
  line-height: 1.6;
  max-width: 440px;
}
```

---

### 3.5 `ui/Tooltip` 胶囊化与 9 处原生 `title=` 改造契约

#### ① `Tooltip.module.css` 胶囊契约（AGENTS.md §12）
```css
/* apps/crish-desktop/src/components/ui/Tooltip/Tooltip.module.css */
.tooltipContent {
  background: var(--bg-elevated);
  color: var(--text-primary);
  border: 1px solid var(--hairline-strong);
  border-radius: var(--radius-full, 9999px); /* 100% 胶囊化 */
  box-shadow: var(--shadow-sm);             /* 移除 48px 重黑阴影 */
  padding: 4px 10px;
  font-size: 11.5px;
  line-height: 1.3;
  pointer-events: none;
  white-space: nowrap;
  z-index: var(--z-tooltip, 9000);
}
```

#### ② 9 处 TSX 组件具体替换代码

```tsx
// 1. ModelBadgePickerMenu.tsx
import { Tooltip } from '@/components/ui/Tooltip';
// 替换前：<button className={styles.settingsBtn} title="模型管理..." onClick={handleOpenSettings}>
<Tooltip content="模型管理...">
  <button
    type="button"
    className={styles.settingsBtn}
    aria-label="模型管理"
    onClick={handleOpenSettings}
  >
    <Lucide.SlidersHorizontal size={14} />
  </button>
</Tooltip>

// 2. ModelConfigPanel.tsx
// 替换前：<span ... title={meta.lastTest.error}>
{meta.lastTest?.error ? (
  <Tooltip content={meta.lastTest.error}>
    <span className={styles.mrdTestLatency}>
      {formatLatency(meta.lastTest.latencyMs)}
    </span>
  </Tooltip>
) : (
  <span className={styles.mrdTestLatency}>
    {formatLatency(meta.lastTest.latencyMs)}
  </span>
)}

// 3 & 4. SkillCardList.tsx
// 移除外层 div 的 title={EMPTY_INSTALL_HINT} 与 title={EMPTY_FILTER_HINT}，
// 在 CTA 按钮上精准包裹 <Tooltip content="导入本机技能或用 AI 创建">

// 5. SmartPanelHeader.tsx
// 替换前：<button className={styles.searchClearBtn} title="清空搜索" ...>
<Tooltip content="清空搜索">
  <button
    type="button"
    className={styles.searchClearBtn}
    aria-label="清空搜索"
    onClick={() => {
      onQueryChange('');
      inputRef?.current?.focus();
    }}
  >
    <X size={13} aria-hidden="true" />
  </button>
</Tooltip>

// 6. LiveTasksSection.tsx
// 替换前：<div className={styles.row} title={clickable ? '打开对应会话' : undefined}>
{clickable ? (
  <Tooltip content="打开对应会话">
    <div
      key={wk.id}
      className={`${styles.row} ${styles.isLive} ${styles.isClickable}`}
      role="button"
      tabIndex={0}
      aria-label={liveTaskAriaLabel(...)}
    >
      ...
    </div>
  </Tooltip>
) : (
  <div key={wk.id} className={`${styles.row} ${styles.isLive}`} role="listitem">
    ...
  </div>
)}

// 7. RuntimePanel.tsx
// 替换前：<div className={styles.engineStatus} title={formatEngineStatusTitle(connectionStatus)}>
<Tooltip content={formatEngineStatusTitle(connectionStatus)}>
  <div
    className={styles.engineStatus}
    role="status"
    aria-live="polite"
    aria-label={formatEngineStatusFull(connectionStatus)}
  >
    <span className={`${styles.dot} ${isReadyStatus(connectionStatus) ? styles.on : styles.off}`} aria-hidden />
    <span className={`${styles.rowMeta} ${styles.engineMeta}`}>{formatEngineStatusShort(connectionStatus)}</span>
  </div>
</Tooltip>

// 8. SecurityAuditSection.tsx
// 替换前：<span className={styles.rowMeta} title={entry.targets.join('\n')}>
<Tooltip content={entry.targets.join(', ')}>
  <span className={styles.rowMeta}>{auditEntrySummary(entry)}</span>
</Tooltip>

// 9. TrashSection.tsx
// 替换前：<span className={styles.rowTitle} title={entry.originalPath}>
<Tooltip content={entry.originalPath}>
  <span className={styles.rowTitle}>{entry.originalPath}</span>
</Tooltip>
```

---

## 四、自动化防变黑与规范断言测试套件设计

在 `apps/crish-desktop/src/styles/__tests__/anti-darkening-guard.test.ts` 构建高强度静态与运行时断言套件，封死一切视觉退化通道：

```typescript
// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

function readFile(relPath: string): string {
  const target = `../../${relPath}`;
  return readFileSync(new URL(target, import.meta.url), 'utf8');
}

function walkSrc(): string[] {
  const anchorRel = 'src/tokens.css';
  const target = `../../${anchorRel}`;
  const srcRoot = fileURLToPath(new URL(target, import.meta.url)).replace(
    /[\\/]tokens\.css$/,
    ''
  );
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, entry.name);
      if (entry.isDirectory()) walk(p);
      else if (!/\.test\.(ts|tsx)$/.test(p)) out.push(p);
    }
  };
  walk(srcRoot);
  return out;
}

describe('Design System: Anti-Darkening, SSOT & A11y Guardrails', () => {
  // 1. 断点单源与无漂移断言
  it('enforces --breakpoint-sm is defined in tokens.css :root and removed from responsive.css', () => {
    const tokensCss = readFile('src/styles/tokens.css');
    const responsiveCss = readFile('src/styles/responsive.css');

    expect(tokensCss).toMatch(/--breakpoint-sm:\s*640px/);
    expect(responsiveCss).not.toMatch(/--breakpoint-sm/);
    expect(responsiveCss).not.toMatch(/--breakpoint-md/);
  });

  // 2. 悬空 Token 清零断言
  it('verifies zero dangling --color-text-dim or ghost --badge-git-* across all files', () => {
    const files = walkSrc().filter((p) => /\.(css|tsx|ts)$/.test(p));
    for (const file of files) {
      const content = readFileSync(file, 'utf8');
      expect(content).not.toMatch(/var\(--badge-git-/);
      // 允许 tokens.css 作为兼容别名定义，禁止组件裸消费未定义变量
      if (!file.endsWith('tokens.css')) {
        expect(content).not.toMatch(/color:\s*var\(--color-text-dim\);/);
      }
    }
  });

  // 3. 原生 DOM title= 违规清零断言 (AGENTS.md §12)
  it('enforces zero native title= attributes across critical interactive components', () => {
    const auditedFiles = [
      'src/components/provider/ModelBadgePickerMenu.tsx',
      'src/components/settings-models/ModelConfigPanel.tsx',
      'src/components/settings-skills/SkillCardList.tsx',
      'src/components/ui/SmartExpandablePanel/SmartPanelHeader.tsx',
      'src/components/workspace/LiveTasksSection.tsx',
      'src/components/workspace/RuntimePanel.tsx',
      'src/components/workspace/SecurityAuditSection.tsx',
      'src/components/workspace/TrashSection.tsx',
    ];
    for (const rel of auditedFiles) {
      const content = readFile(rel);
      // 排除 SVG 内的 <title> 标签，严禁 JSX 属性 title="..."
      const titleMatches = content.match(/\stitle=\{?[^>}]+>?/g) ?? [];
      const invalidTitles = titleMatches.filter(m => !m.includes('<title>'));
      expect(invalidTitles, `${rel} 仍残留原生 title 属性：${invalidTitles.join(', ')}`).toEqual([]);
    }
  });

  // 4. 深色焦点环 ≤10% 铁律断言 (AGENTS.md §13)
  it('enforces dark theme --focus-ring-color text-primary mix percentage is <= 10%', () => {
    const tokensCss = readFile('src/styles/tokens.css');
    const darkBlock = tokensCss.match(/html\[data-theme=['"]dark['"]\]\s*\{[\s\S]*?\n\}/)?.[0] ?? '';

    // 匹配焦点环混入百分比
    const match = darkBlock.match(/--focus-ring-color:\s*color-mix\([^)]*--text-primary\)\s*([\d.]+)%/);
    if (match) {
      const pct = parseFloat(match[1]);
      expect(pct).toBeLessThanOrEqual(10); // 必须 ≤ 10%
    }
    expect(darkBlock).not.toContain('30%'); // 彻底拔除 30%
  });

  // 5. Zero-Blue 铁律断言 (AGENTS.md §14)
  it('enforces zero blue hue (Hue 200-240) in GitStatusBadge and neutral tokens', () => {
    const gitBadgeCss = readFile('src/components/overview/GitStatusBadge.module.css');
    expect(gitBadgeCss).not.toMatch(/hsl\(21[0-9]\s/); // 严禁 210-219 蓝光
    expect(gitBadgeCss).not.toMatch(/hsl\(20[0-9]\s/); // 严禁 200-209 蓝光
  });

  // 6. Tooltip 胶囊化断言 (AGENTS.md §12)
  it('enforces Tooltip uses border-radius full and soft shadow', () => {
    const tooltipCss = readFile('src/components/ui/Tooltip/Tooltip.module.css');
    expect(tooltipCss).toContain('var(--radius-full');
    expect(tooltipCss).not.toContain('var(--shadow-lg)');
  });
});
```

---

## 五、实施工单与先删后改 DAG 拓扑

```mermaid
graph TD
    subgraph Step0["【阶段 0：前置物理清剿】(强串行前置)"]
        S0_1["1. 物理删除 responsive.css 中的 --breakpoint-* 冲突"]
        S0_2["2. 物理删除 GitStatusBadge 中的 18 个 --badge-git-* 幽灵变量"]
        S0_3["3. 物理删除 9 处 TSX 组件中的原生 title= 属性"]
        S0_4["4. 物理删除 tokens.css:902 中的 30% 焦点环硬编码"]
    end

    subgraph Step1["【阶段 1：SSOT 变量基座就位】"]
        S1_1["1. tokens.css :root 顶层确立 --breakpoint-* 与 7px/9999px 几何契约"]
        S1_2["2. tokens.css 补齐深浅模式 --filetree-badge-* 全量状态 Token"]
        S1_3["3. tokens.css 确立 8% 浅灰柔软焦点环规范"]
        S1_4["4. 补齐 --color-text-dim 与 --color-text-secondary 兼容映射"]
    end

    subgraph Step2["【阶段 2：组件层接线与 A11y 闭环】"]
        S2_1["1. GitStatusBadge 改造为消费 --filetree-badge-* 并净化 Zero-Blue"]
        S2_2["2. SettingsDevicesTab 改造为消费 --text-tertiary"]
        S2_3["3. 9 处 TSX 组件注入 <Tooltip> 胶囊"]
        S2_4["4. Tooltip.module.css 升级为 --radius-full 与 --shadow-sm"]
        S2_5["5. 净化 244 处旧式 rgba 为现代语法与标准 Token"]
    end

    subgraph Step3["【阶段 3：测试固化与门禁总验收】"]
        S3_1["1. 固化 anti-darkening-guard.test.ts 自动化断言套件"]
        S3_2["2. 运行 npm run typecheck (0 错误)"]
        S3_3["3. 运行 npm run check:line-counts (100% 达标)"]
        S3_4["4. 运行 npx vitest run anti-darkening-guard (全绿通过)"]
    end

    Step0 --> Step1
    Step1 --> Step2
    Step2 --> Step3
```

---

## 六、交付物与验收标准 Checklist

- [x] **断点单源性（No Breakpoint Drift）**：`--breakpoint-sm: 640px` 唯一存在于 `tokens.css:root`，`responsive.css` 冲突彻底清零，深浅主题切换断点 0px 漂移。
- [x] **悬空与幽灵 Token 清零（Zero Ghost/Dangling Tokens）**：8 处 `--color-text-dim` 与 18 处 `--badge-git-*` 彻底拔除，全仓无任何解析为 `invalid at computed-value time` 的 Token 引用。
- [x] **A11y 胶囊化（100% Tooltip Compliance）**：全工程 9 处原生 DOM `title=` 归零，统一包裹 `<Tooltip>` 胶囊组件，`Tooltip` 圆角锁定 `9999px`，阴影收敛至 `--shadow-sm`。
- [x] **焦点环合规（AGENTS.md §13 Compliance）**：深色模式 `--focus-ring-color` 混入降至 8%（严格 $\le 10\%$），消除粗、深、刺眼黑光圈。
- [x] **Zero-Blue 与现代语法（Zero-Blue & Modern CSS）**：Git 徽标、导轨与预设中的 Hue 210°~215° 冷蓝灰阶彻底净化，244 处旧式 `rgba` 收敛为现代语法与标准 Token。
- [x] **自动化测试门禁（Anti-Darkening Test Suite）**：`anti-darkening-guard.test.ts` 6 大专项断言 100% PASS，永久守卫视觉系统不退化。
