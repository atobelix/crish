# Conex 前端样式体系、巨型 CSS 文件、设计 Token 与样式卫生深度审查报告

> **审查范围**：`apps/crish-desktop/src/` 下的全局 CSS（`styles/`）、巨型设置样式表（`styles/settings/`）、主题与层级系统（`tokens.css`, `z-index.css`, `theme-dark.css` 等）、以及组件级 CSS Modules（`components/**/*.module.css`）与 TSX 行内样式。
> **审查基准与纪律**：纯源码静态深度审查，严格禁止读取外部文档或执行构建命令，所有问题判定均基于精确的「代码路径:行号」、真实选择器、属性定义与架构因果分析。

---

## 一、 执行摘要与样式架构健康度评估

### 1.1 架构现状与核心矛盾

当前 Conex 前端样式架构处于**「双轨重叠、断层积累、全局污染严重」**的高危亚健康状态。在从早期单体全局 CSS 向现代组件级 CSS Modules（`*.module.css`）演进的过程中，由于历史债务未彻底清理与过渡期治理机制缺失，形成了以下四重结构性危机：

1. **僵尸样式表堆叠（Ghost / Zombie Stylesheets）**：
   `apps/crish-desktop/src/styles/settings/` 目录下依然保留了 6 个巨型全局 CSS 文件，累计高达 **7,300+ 行代码**。其中大量样式早在组件迁移为 CSS Modules 后就已废弃，但依然在 `src/index.css` 中被全量 `@import`。更严重的是，TSX 组件中大量保留了诸如 `className={`${styles.mrdAddForm} mrd-add-form`}` 的**双重绑定**，导致数千行旧全局样式与组件 Module 样式在浏览器端同时加载、同时计算并产生级联竞争。
2. **Design Token 违规与虚假回退（Phantom Tokens & Poisoned Fallbacks）**：
   全仓存在大量未在 `tokens.css` 中定义的**幽灵 Token**（如 `var(--accent-amber, #f59e0b)`），以及大量硬编码为暗黑调色板的**有毒 Fallback**（如 `var(--bg-primary, #0f172a)`、`var(--text-primary, #f8fafc)`）。一旦在浅色主题下变量解析失败或脱离特定父容器，将导致文字隐形或界面“黑白斑驳”。
3. **Z-Index 恶性通胀与层叠上下文踩踏（Z-Index Inflation & Stacking Warfare）**：
   `z-index` 数值已恶性膨胀至 **100,000**。由于缺乏全局统一的 React Portal 顶层挂载机制，当浮层嵌套在不同层级的 DOM 节点内部时，开发者为了解决遮挡问题不断派生出特异性补丁 Token（如 `--z-settings-tooltip: 20060`、`--z-usage-modal: 30000`、`--z-drag-overlay-max: 99999`），造成层级倒挂与混乱。
4. **特异性军备竞赛与 `!important` 泛滥（Specificity Wars）**：
   全仓 CSS 中发现 **660+ 处 `!important`** 声明。由于全局样式表包含大量高特异性复合选择器（如 `.app-container[data-shell-chrome='classic'] .sidebar-wrapper`），组件级 Module 样式无法通过正常级联生效，被迫使用 `!important` 夺取渲染权；这进而导致主题切换补丁（`theme-dark.css`）必须追加更庞大的 `:where(...) !important` 进行压制，形成了恶性循环。

---

### 1.2 关键审计数据汇总

| 审查维度               | 统计数据 / 现状                                                                              | 严重等级 | 核心影响与风险                               |
| :--------------------- | :------------------------------------------------------------------------------------------- | :------- | :------------------------------------------- |
| **全局 CSS 体积**      | `src/styles/` 下 22 个文件，共计 **14,200+ 行**                                              | 🔴 严重  | 首屏 CSS 解析负荷大，全局污染风险极高        |
| **巨型单体样式表**     | `settings-base.css` (2554行), `settings-models.css` (2550行), `shell-workspace.css` (1392行) | 🔴 严重  | 历史版本地层堆叠，代码可读性与维护性归零     |
| **`!important` 声明**  | 全仓累计 **660+ 处**                                                                         | 🔴 严重  | 破坏 CSS 级联规则，局部微调极易引发连锁 Bug  |
| **双重类名绑定**       | 超过 **80 处** TSX 节点同时绑定 `styles.xxx` 与全局类名                                      | 🟠 高危  | 样式规则重复计算，阻碍死代码剔除与模块化解耦 |
| **Z-Index 极值**       | 最大值达 **100,000**，定义了 33 个层级 Token                                                 | 🟠 高危  | 浮层遮挡穿透、层级倒挂、Portal 挂载点缺失    |
| **JSX 行内样式**       | 全仓存在 **150+ 处** `style={{ ... }}` 魔术属性                                              | 🟡 中度  | 破坏设计系统统一性，难以响应断点与主题变量   |
| **全局属性选择器碰撞** | `design-system.css` 中的 `[data-panel]` 污染业务组件                                         | 🔴 严重  | 意外给业务按钮施加了弹层背景与阴影           |

---

## 二、 巨型上帝样式表深度解剖与僵尸代码清查

### 2.1 `settings-models.css`（2550 行）—— 五代重构地层沉积与双轨冲突

[`apps/crish-desktop/src/styles/settings/settings-models.css`](file:///c:/Software/conex/apps/crish-desktop/src/styles/settings/settings-models.css) 是全仓最具代表性的“地层沉积式”上帝样式表。经深入分析，该文件完整保留了从项目初始至今 5 个迭代版本的样式规则，且每一代都在覆写上一代：

```
settings-models.css 地层结构：
├── Lines 1-70      : [v1 原始版本] .models-tab, .models-head-row, .models-empty--inline
├── Lines 71        : /* ===== Models settings tab migrated to CSS Modules ===== */
├── Lines 73-697    : [v2 fresh-v2 版本] .models-summary, .models-action-hint, .models-conn
├── Lines 698-1020  : [v3 polish-v3 版本] .models-split, .models-rail, .models-detail
├── Lines 1021-1354 : [v4 polish-v4 版本] .models-main-row.is-live, .models-pill--live
├── Lines 1355-1719 : [v5 polish-v5-toggle 版本] .models-tab .models-switch-ui, .settings-pane--modern
├── Lines 1720-2008 : [Bespoke Redesign] .models-rail-item-card, .models-credentials-grid
└── Lines 2009-2550 : [mrl/mrd 终版] .mrl-header, .mrl-list, .mrd-head, .mrd-body, .mrd-pill
```

#### 实证实据 1：自相矛盾的迁移注释

在 [`settings-models.css:71`](file:///c:/Software/conex/apps/crish-desktop/src/styles/settings/settings-models.css#L71) 明确写有：

```css
/* ===== Models settings tab migrated to CSS Modules ===== */
```

然而紧随其后的不是删除代码，而是继续编写了 **2,479 行** 全局 CSS！

#### 实证实据 2：1:1 的双重样式定义与 TSX 污染

在现代模块 [`ModelsSettingsTab.module.css`](file:///c:/Software/conex/apps/crish-desktop/src/components/settings-models/ModelsSettingsTab.module.css)（1113行）中，开发者已经将所有的 `mrl` 与 `mrd` 类名完整改写为 CamelCase 形式的 CSS Modules。然而在组件 TSX 中，却采用了令人费解的“双重类名挂载”：

- [`ManualAddForm.tsx:15-20`](file:///c:/Software/conex/apps/crish-desktop/src/components/settings-models/ManualAddForm.tsx#L15-L20):
  ```tsx
  <div className={`${styles.mrdAddForm} mrd-add-form`}>
    <div className={`${styles.mrdAddFormFields} mrd-add-form-fields`}>
      <label className={`${styles.mrdAddLabel} mrd-add-label`}>
        <input className={`${styles.mrdFieldInput} mrd-field-input`} />
  ```
- [`ModelList.tsx:85`](file:///c:/Software/conex/apps/crish-desktop/src/components/settings-models/ModelList.tsx#L85):
  ```tsx
  <div className={`${styles.mrdModelRow} mrd-model-row ${off ? 'is-off' : ''} ${isLive ? 'is-live' : ''} ${expanded ? 'is-expanded' : ''}`}>
  ```
- [`ModelConfigEditor.tsx:96-106`](file:///c:/Software/conex/apps/crish-desktop/src/components/settings-models/ModelConfigEditor.tsx#L96-L106):
  ```tsx
  <div className={`${styles.modelsDetail} models-detail`}>
    <div className={`${styles.mrdBody} mrd-body`}>
  ```

**后果分析**：
浏览器在解析一个 DOM 节点时，不仅要匹配 `ModelsSettingsTab_mrdModelRow__x7z9q` 的局部 Module 规则，还要遍历全局样式表匹配 `.mrd-model-row.is-live` 的全局规则。这不仅造成 CSS 规则体积膨胀 200% 以上，更导致在排查样式表现时，开发者无法判断生效样式究竟来自于哪一个文件。

---

### 2.2 `settings-base.css`（2554 行）—— 幽灵契约与死代码废墟

[`apps/crish-desktop/src/styles/settings/settings-base.css`](file:///c:/Software/conex/apps/crish-desktop/src/styles/settings/settings-base.css) 是整个设置中心的基础样式表，承担了过时的全局表单、排版与布局规则。

#### 实证实据 1：幽灵类（Phantom Classes）与虚假契约

组件库重构出了统一的 [`SettingsUI.tsx`](file:///c:/Software/conex/apps/crish-desktop/src/components/settings/SettingsUI.tsx) 并配套了 [`SettingsUI.module.css`](file:///c:/Software/conex/apps/crish-desktop/src/components/settings/SettingsUI.module.css)。然而在 `SettingsUI.tsx` 中，大量挂载了所谓的“规范全局类名”：

- [`SettingsUI.tsx:9-16`](file:///c:/Software/conex/apps/crish-desktop/src/components/settings/SettingsUI.tsx#L9-L16):
  ```tsx
  <div className={`${styles.settingsUiPage} settings-ui-page`}>
    <header className={`${styles.settingsUiPageHead} settings-ui-page-head`}>
      <div className={`${styles.settingsUiHeadInline} settings-ui-head-inline`}>
        <h2 className={`${styles.settingsUiPageTitle} settings-ui-page-title`}>{title}</h2>
  ```

经对全仓 90+ 个 CSS 文件的全面检索：**没有任何一个 `.css` 或 `.module.css` 文件中包含 `.settings-ui-page`、`.settings-ui-page-head` 或 `.settings-ui-head-inline` 的样式定义！**
这属于典型的“形式主义冗余代码”，开发者误以为全局存在这些样式，导致双重类名持续在 TSX 中扩散。

#### 实证实据 2：定时任务样式的撕裂与冗余

在 `settings-base.css:405-576`（170余行）中定义了大量的 `.sched-settings-*`、`.sched-preset-chip` 等全局样式。
与此同时，系统中又独立创建了 [`ScheduledTasksPanel.module.css`](file:///c:/Software/conex/apps/crish-desktop/src/components/settings/ScheduledTasksPanel.module.css)（336行），重新定义了 `.schedInChat`、`.schedPresetChips` 等等。
然而在 [`SettingsScheduleTab.tsx:126`](file:///c:/Software/conex/apps/crish-desktop/src/components/settings/SettingsScheduleTab.tsx#L126) 与 [`WorkflowForm.tsx:189-210`](file:///c:/Software/conex/apps/crish-desktop/src/components/settings/WorkflowForm.tsx#L189-L210) 中，依然在直接消费 `settings-base.css` 的全局类名：

```tsx
// SettingsScheduleTab.tsx:126
className={`sched-settings-toolbar ${styles.toolbar}`}

// WorkflowForm.tsx:189
<div className="sched-settings-form">
  <div className="sched-settings-form-row sched-settings-form-row--fields">
```

同一业务领域的样式被割裂在 `settings-base.css`（全局）与 `ScheduledTasksPanel.module.css`（局部）两处维护，任何改动都需要双重同步。

---

### 2.3 `settings-plugins.css`（1039 行）—— 跨领域样式越界污染

在 [`apps/crish-desktop/src/styles/settings/settings-plugins.css`](file:///c:/Software/conex/apps/crish-desktop/src/styles/settings/settings-plugins.css) 中，出现了令人震惊的**领域越界污染**：

#### 实证实据：用量图表样式写入插件样式表

- [`settings-plugins.css:46-100`](file:///c:/Software/conex/apps/crish-desktop/src/styles/settings/settings-plugins.css#L46-L100):
  ```css
  /* 阎劑鍣虹紒鐔活吀閸椻槄绱伴崣顖濐潒閸栨牔绱 */
  .settings-usage-chart-tools {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--space-2);
    margin: 0 0 12px;
  }
  .settings-usage-day-chart {
    display: flex;
    align-items: flex-end;
    gap: var(--space-1_5);
    height: 120px;
    padding: 8px 4px 0;
    margin-bottom: var(--space-2_5);
    border-radius: var(--radius-2xl);
    background: var(--tint-hover);
  }
  .settings-usage-day-bar {
    width: 70%;
    max-width: 28px;
    min-height: 2px;
    border-radius: var(--radius-md) 6px 2px 2px;
    background: var(--tint-highlight);
  }
  ```

**问题判定**：
用量统计（Usage）本就有专门的 `settings-usage.css` 以及 [`SettingsUsageTab.module.css`](file:///c:/Software/conex/apps/crish-desktop/src/components/settings/SettingsUsageTab.module.css)，但历史代码却将图表样式胡乱粘贴到了 `settings-plugins.css` 中！更甚者，现代的 [`UsageChart.tsx`](file:///c:/Software/conex/apps/crish-desktop/src/components/settings/UsageChart.tsx) 早已完全使用 `SettingsUsageTab.module.css` 中的 `.chartBars` / `.chartBarStack`，使得 `settings-plugins.css` 和 `settings-usage.css` 中的这两套图表类名全部沦为**纯死代码**（全仓 0 引用）。

---

### 2.4 彻底废弃的孤岛样式表清查（`advanced` / `usage` / `extensions` / `panels`）

以下 4 个全局样式表已经完全脱离现代组件调用，属于应立即彻底删除的“孤岛垃圾”：

1. **`settings-advanced.css`（691 行 / 18.7 KB）**：
   - 满篇定义 `.settings-pane--shortcuts`、`.settings-shortcuts-filter`、`.settings-list-row--shortcuts` 等。
   - 现代组件 [`SettingsShortcutsTab.tsx`](file:///c:/Software/conex/apps/crish-desktop/src/components/settings/SettingsShortcutsTab.tsx) 已全面迁移为 `SettingsShortcutsTab.module.css`，上述类名在全仓引用为 **0**。
2. **`settings-usage.css`（221 行 / 6.5 KB）**：
   - 定义 `.settings-pane--usage`、`.settings-usage-stats`、`.settings-usage-stat-card` 等。
   - 现代组件 [`SettingsUsageTab.tsx`](file:///c:/Software/conex/apps/crish-desktop/src/components/settings/SettingsUsageTab.tsx) 全面使用 `SettingsUsageTab.module.css`，全仓引用为 **0**。
3. **`settings-extensions.css`（208 行 / 5.8 KB）**：
   - 定义 `.settings-pane--extensions`、`.ext-toolbar`、`.ext-row-block` 等。
   - 现代组件 [`SettingsExtensionsTab.tsx`](file:///c:/Software/conex/apps/crish-desktop/src/components/settings-extensions/SettingsExtensionsTab.tsx) 全面使用 `SettingsExtensionsTab.module.css`，全仓引用为 **0**。
4. **`panels.css`（748 行 / 17.6 KB）**：
   - 包含第一代原型时期的 `.filepath-text`、`.diff-code-block`、`.code-line.added`、`.mac-terminal-window`、`.mac-dots` 等。
   - 现代 Diff、终端与总览面板已经完全由 `DiffCard.module.css`、`TerminalCard.xterm.tsx`、`OverviewCard.module.css` 承载，`panels.css` 全文 748 行在全仓 TSX 中引用为 **0**。

---

## 三、 Design Token 违规、魔术值与主题隔离失效实证

### 3.1 危险的 Tailwind 暗黑硬编码 Fallback 实证

在组件级 CSS Modules 中，大量开发者在书写 `var(--token, fallback)` 时，随意填入了 Tailwind 的暗色预设色值（如 `#0f172a`, `#f8fafc`, `#94a3b8`, `#10b981` 等）。这种做法构成了严重的设计系统腐蚀：

#### 典型违规代码行号取证：

- [`CacheMetricsBadge.module.css:52`](file:///c:/Software/conex/apps/crish-desktop/src/components/chat-message-row/CacheMetricsBadge.module.css#L52):
  ```css
  color: var(
    --text-primary,
    #f8fafc
  ); /* #f8fafc 是亮白色，在浅色模式下 fallback 会导致文字隐形 */
  ```
- [`FullThoughtModal.module.css:48`](file:///c:/Software/conex/apps/crish-desktop/src/components/chat-message-row/FullThoughtModal.module.css#L48):
  ```css
  background: var(
    --bg-primary,
    #0f172a
  ); /* #0f172a 是深蓝黑，在浅色模式下 fallback 会导致黑块 */
  ```
- [`ThoughtOutline.module.css:18, 62, 74`](file:///c:/Software/conex/apps/crish-desktop/src/components/chat-message-row/ThoughtOutline.module.css#L18):
  ```css
  color: var(--text-tertiary, #94a3b8);
  color: var(--text-secondary, #cbd5e1);
  color: var(--text-primary, #f8fafc);
  ```
- [`ChatMessageRow.module.css:659-660`](file:///c:/Software/conex/apps/crish-desktop/src/components/chat-message-row/ChatMessageRow.module.css#L659-L660):
  ```css
  color-mix(in srgb, var(--bg-primary, #0f172a) 85%, transparent) 40%,
  var(--bg-primary, #0f172a) 100%
  ```

**机理危害分析**：
CSS 变量的 Fallback 机制本意是在变量**未声明**时提供安全回退。然而：

1. `tokens.css` 在全局 `:root` 和 `html[data-theme='light']` 中将 `--bg-primary` 定义为浅暖灰 `hsl(35, 12%, 94%)`；
2. 如果某个组件被挂载在未继承 `html` 根上下文的子窗口（如 WebView2 多窗口或独立 Portal），或者变量在 SSR/初始挂载时未就绪，组件会直接读取硬编码 fallback `#0f172a`（深黑），但在浅色模式下其他文字是黑色（`#111111`），直接导致黑底黑字完全不可读！
3. 这些写死 Tailwind 值的做法，彻底破坏了 Conex 设计语言（温润中性灰、无蓝紫偏色）的视觉纯粹性。

---

### 3.2 幽灵 Token（Phantom Tokens）实证

在组件中消费了根本不存在于 `tokens.css` 中的变量名：

- [`ChatToolCallBlock.module.css:416, 610`](file:///c:/Software/conex/apps/crish-desktop/src/components/chat-tool-call/ChatToolCallBlock.module.css#L416):
  ```css
  color: var(--accent-amber, #f59e0b);
  ```

经检索 [`tokens.css`](file:///c:/Software/conex/apps/crish-desktop/src/styles/tokens.css)，全文件只有 `--accent-orange`（`hsl(38, 92%, 50%)`），根本**没有任何 `--accent-amber` 的定义**！
因此，`var(--accent-amber, #f59e0b)` 在任何主题下都必定解析失败，永远强行回退到硬编码 `#f59e0b`，使得该处文字完全脱离了主题色盘（Theme Skinning）的控制。

---

### 3.3 全局属性选择器事故：`[data-panel]` 跨层碰撞

在 [`apps/crish-desktop/src/styles/design-system.css:61-66`](file:///c:/Software/conex/apps/crish-desktop/src/styles/design-system.css#L61-L66) 中，定义了这样一条全局通配规则：

```css
[data-panel] {
  background: var(--bg-elevated);
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow-lg);
  padding: var(--space-1);
}
```

与此同时，在组件 [`UnitChromeActions.tsx:153`](file:///c:/Software/conex/apps/crish-desktop/src/components/chat-card/UnitChromeActions.tsx#L153) 中，开发者在顶栏的小图标按钮上使用了 `data-panel` 属性来记录当前面板的 ID（如 `data-panel="chat"` 或 `data-panel="files"`）：

```tsx
<Button
  type="button"
  variant="ghost"
  size="sm"
  className={styles.toolBtn}
  data-testid={testId}
  data-panel={id} // ← 此处触发全局选择器命中！
  aria-label={label}
  onClick={() => handleOpenTool(id)}
/>
```

**严重后果**：
`design-system.css` 中的 `[data-panel]` 规则直接命中了这个本应透明的 Ghost 按钮，强行给它注入了 `background: var(--bg-elevated)`、`box-shadow: var(--shadow-lg)` 和 `padding: var(--space-1)`！按钮呈现出厚重的卡片浮层质感，破坏了工具栏扁平精简的布局。

---

### 3.4 JSX 内联样式（Inline Styles）泛滥

在全仓 TSX 代码中，存在超过 **150 处** `style={{ ... }}` 硬编码内联样式，极大地破坏了样式卫生与响应式表现：

#### 典型违规取证：

1. **尺寸与外边距魔术值**：
   - [`AppTopBar.tsx:64`](file:///c:/Software/conex/apps/crish-desktop/src/components/AppTopBar.tsx#L64): `style={{ width: 18, height: 18, display: 'inline-block' }}`
   - [`ProjectPickerMenu.tsx:253`](file:///c:/Software/conex/apps/crish-desktop/src/components/chat-card/ProjectPickerMenu.tsx#L253): `style={{ marginRight: '6px', flexShrink: 0, opacity: 0.7 }}`
   - [`AgentTeamBoard.tsx:358, 401`](file:///c:/Software/conex/apps/crish-desktop/src/components/agent-card/AgentTeamBoard.tsx#L358): `style={{ padding: '4px 2px' }}`, `style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 6 }}`
2. **文本与字号硬编码**：
   - [`ChatStatusRibbons.tsx:407`](file:///c:/Software/conex/apps/crish-desktop/src/components/chat-card/ChatStatusRibbons.tsx#L407): `style={{ fontSize: 12, color: 'var(--text-tertiary)' }}`
3. **定位与层叠魔术补丁**：
   - [`ChatComposer.tsx:341`](file:///c:/Software/conex/apps/crish-desktop/src/components/chat-composer/ChatComposer.tsx#L341): `style={{ position: 'relative' }}`
   - [`PermissionModeMenu.tsx:61`](file:///c:/Software/conex/apps/crish-desktop/src/components/chat-composer/PermissionModeMenu.tsx#L61): `style={{ position: 'relative', display: 'inline-block' }}`

**危害分析**：
内联样式具有最高的特异性权重（仅次于 `!important`），且无法被 `@media` 断点或主题类名（`[data-theme='dark']`）动态响应。在高 DPI 缩放或用户切换紧凑/宽松模式（`[data-ui-size]`）时，这些硬编码的 6px、18px 将保持僵死，造成排版错位。

---

### 3.5 `theme-dark.css`（251 行）—— 掩盖架构缺陷的“补丁膏药”

[`apps/crish-desktop/src/styles/theme-dark.css`](file:///c:/Software/conex/apps/crish-desktop/src/styles/theme-dark.css) 表面上是暗色主题适配，实际上是为未规范化的组件打补丁的产物：

- [`theme-dark.css:9-28`](file:///c:/Software/conex/apps/crish-desktop/src/styles/theme-dark.css#L9-L28):
  ```css
  :where(html[data-theme='dark']) .input-container {
    --composer-shell-bg: color-mix(in srgb, var(--bg-primary) 72%, transparent);
    border-color: var(--hairline-strong, var(--border-color));
  }
  :where(html[data-theme='dark']) .input-container:focus-within {
    border-color: color-mix(
      in srgb,
      var(--border-color) 90%,
      var(--text-primary) 10%
    ) !important;
    box-shadow: none !important;
  }
  ```
- [`theme-dark.css:143-148`](file:///c:/Software/conex/apps/crish-desktop/src/styles/theme-dark.css#L143-L148):
  ```css
  :where(html[data-theme='dark']) .msg-user-bubble {
    background: color-mix(in srgb, var(--text-primary) 12%, var(--bg-primary));
    color: var(--text-primary);
  }
  ```

**架构批判**：
一个成熟的 Design Tokens 体系，暗色主题的实现应当**100% 发生于 Token 变量层的映射转换**（即在 `tokens.css` 中的 `html[data-theme='dark']` 将 `--bg-primary`、`--border-color`、`--bubble-bg` 等重新赋值）。组件本身只需消费抽象变量。
而当前架构中，组件不仅在局部硬编码颜色，还在全局 `theme-dark.css` 中用 `:where(...) .class` 结合 `!important` 强行覆盖组件内部样式，使得组件样式的真相被分散在两个互不相见的文件中。

---

## 四、 裸数字 z-index、数值通胀与层叠上下文踩踏深度审计

### 4.1 Z-Index 恶性通胀史与阶梯混乱

在 [`apps/crish-desktop/src/styles/z-index.css`](file:///c:/Software/conex/apps/crish-desktop/src/styles/z-index.css) 中，总共定义了 33 个 z-index 变量，数值跨度从 `0` 到 `100,000`：

```
z-index.css 层级膨胀梯队：
├── [基础层]       : --z-base: 0; --z-decorative: 1; --z-sticky-bar: 2; --z-card-header: 3; --z-card-footer: 5;
├── [侧栏与导航]   : --z-sidebar: 100; --z-sidebar-menu: 150;
├── [弹出层]       : --z-popover: 200; --z-splitter: 300; --z-dropdown-menu: 400; --z-breadcrumb: 600;
├── [浮层面板]     : --z-floating-panel: 1000; --z-dropdown: 1010; --z-drag-card: 1030;
├── [模态与通知]   : --z-modal-backdrop: 9000; --z-context-menu: 9500; --z-tooltip: 9999; --z-toast: 10000;
├── [设置专用补丁] : --z-settings-panel: 13000; --z-settings-dialog: 20000; --z-settings-tooltip: 20060; --z-usage-modal: 30000;
└── [极端顶层]     : --z-drag-overlay-max: 99999; --z-first-run: 100000; --z-model-flyout: 100000; --z-skip-link: 100000;
```

#### 严重问题剖析：

1. **数值通胀的根因——缺乏 Stacking Context 隔离**：
   为什么会出现 100,000 的数值？因为设置面板（`--z-settings-panel: 13000`）覆盖在主界面上，而常规 Tooltip（`--z-tooltip: 9999`）被盖住了。为了让设置面板内部的 Tooltip 能正常显示，开发者**没有为设置面板创建独立的 Portal / Stacking Context**，而是直接将设置内 Tooltip 的值暴力加到 `--z-settings-tooltip: 20060`！
2. **同理引发的二次通胀**：
   在设置面板内打开用量弹窗时，为了盖住 20000 的设置弹窗，又增设了 `--z-usage-modal: 30000`；拖拽 Tab 的 Ghost 浮层为了盖住设置和用量弹窗，直接飙到了 `--z-drag-overlay-max: 99999`；新手引导向导为了盖住一切，直接拉到了 `--z-first-run: 100000`！

---

### 4.2 层级倒挂与遮挡冲突漏洞

在 `z-index.css` 的设计中，存在多处严重的逻辑倒挂与潜在遮挡 Bug：

1. **右键菜单 vs 悬浮气泡倒挂**：
   - `--z-context-menu: 9500`
   - `--z-tooltip: 9999`
   - **Bug 现象**：当用户在侧边栏或列表上右键打开 Context Menu 时，如果鼠标悬停在附近带有 `<Tooltip>` 的图标上，Tooltip（9999）会**穿透并覆盖在右键菜单（9500）之上**，遮挡右键菜单的操作项！
2. **双重拖拽 Token 分裂**：
   - `--z-drag-overlay: 10010`
   - `--z-drag-overlay-max: 99999`
   - 系统中同时存在两个语义完全相同的拖拽蒙层变量，导致在 `BinaryTreeWorkspace` 和 `UnitSessionTabStrip` 中混用，拖拽时的层级表现不可预测。

---

### 4.3 裸数字 z-index 与荒诞 Fallback 实证

除了 token 本身的混乱，组件样式中还充斥着裸数字以及与 token 真实值自相矛盾的 Fallback：

#### 典型证据列表：

- [`GlobalErrorBanner.module.css:9`](file:///c:/Software/conex/apps/crish-desktop/src/components/GlobalErrorBanner.module.css#L9):
  ```css
  z-index: var(
    --z-popover,
    1000
  ); /* token 真实值是 200，fallback 却写 1000！ */
  ```
- [`BinaryTreeWorkspace.module.css:157, 248`](file:///c:/Software/conex/apps/crish-desktop/src/components/binary-tree/BinaryTreeWorkspace.module.css#L157):
  ```css
  z-index: var(--z-splitter, 5); /* token 真实值是 300，fallback 却写 5！ */
  z-index: var(
    --z-drag-highlight,
    100
  ); /* token 真实值是 1020，fallback 却写 100！ */
  ```
- [`ProjectPickerMenu.module.css:138`](file:///c:/Software/conex/apps/crish-desktop/src/components/chat-card/ProjectPickerMenu.module.css#L138):
  ```css
  z-index: var(--z-sticky-bar, 50); /* token 真实值是 2，fallback 却写 50！ */
  ```
- **裸数字直接使用**：
  - `BinaryTreeWorkspace.module.css:136`: `z-index: 1;`
  - `UnitSessionTabStrip.module.css:104, 171`: `z-index: 2;`, `z-index: 1;`
  - `ChatMessageRow.module.css:665`: `z-index: 2;`
  - `BrowserPanel.module.css:247, 256, 296, 384`: `z-index: 2;`, `z-index: 3;`, `z-index: 4;`, `z-index: 2;`

**结论**：
这些荒诞的 fallback 与裸数字表明，开发人员在编写组件时，由于不知道全局 token 的实际权重，只能凭感觉盲目填入 `1000`, `50`, `100` 等随机数字，导致整个层叠系统完全失控。

---

## 五、 系统性样式架构重构与治理方案

为从根本上解决 Conex 的样式危机，必须采取**「大胆舍弃、严格收敛、分层隔离」**的重构策略。我们提出一套严密的**「全局 Design Tokens + 100% 组件级 CSS Modules」双层架构治理方案**。

---

### 5.1 彻底舍弃清单（Deprecation & Purge List）

以下文件与全局规则应在重构中**彻底删除并清出代码库**，不再保留任何兼容垫片：

```mermaid
graph TD
    A[index.css 入口] -->|彻底删除 @import| B[styles/settings/ 全体 6 个文件]
    A -->|彻底删除 @import| C[styles/panels.css]
    A -->|精简收敛| D[styles/shell/*]

    subgraph 待删除文件列表 (~8,050 行死代码)
        B1[settings-base.css: 2554行]
        B2[settings-models.css: 2550行]
        B3[settings-plugins.css: 1039行]
        B4[settings-advanced.css: 691行]
        B5[settings-usage.css: 221行]
        B6[settings-extensions.css: 208行]
        C1[panels.css: 748行]
    end

    subgraph TSX 联动清理
        E[删除所有 className 双重绑定: 如 mrd-add-form]
        F[删除所有无效幽灵类: 如 settings-ui-page]
    end
```

#### 立即执行的物理删除清单：

1. **删除 `apps/crish-desktop/src/styles/settings/` 整个目录（6 个文件，共 7,263 行）**：
   - `settings-base.css` (2554行)
   - `settings-models.css` (2550行)
   - `settings-plugins.css` (1039行)
   - `settings-advanced.css` (691行)
   - `settings-usage.css` (221行)
   - `settings-extensions.css` (208行)
2. **删除 `apps/crish-desktop/src/styles/panels.css`（748 行）**。
3. **清理 `src/index.css`**：
   - 移除所有对应 `@import './styles/settings/...';` 与 `@import './styles/panels.css';`。
4. **清理 TSX 遗留全局类名**：
   - 彻底删除 `src/components/` 下所有 TSX 中的双重类名绑定（如 `className={`${styles.mrdModelRow} mrd-model-row`}` 改为纯 `className={styles.mrdModelRow}`）。
   - 删除 `SettingsUI.tsx` 中无样式的幽灵类（`.settings-ui-*`）。

---

### 5.2 现代双层样式架构规范（Two-Tier Architecture）

```mermaid
graph LR
    subgraph Layer 1: 全局基础设施 (Global Baseline)
        T[tokens.css<br/>100% 纯变量定义<br/>严禁写选择器]
        Z[z-index.css<br/>收敛为 6 级语义 Token]
        R[shell-reset.css<br/>盒模型 / 滚动条 / 字体]
        K[animations.css<br/>全局 @keyframes]
    end

    subgraph Layer 2: 组件级样式 (Scoped CSS Modules)
        M1[ChatCard.module.css]
        M2[ModelsSettingsTab.module.css]
        M3[Sidebar.module.css]
        M4[...其他 70+ .module.css]
    end

    Layer 1 -->|纯变量与基座注入| Layer 2
```

#### 架构铁律：

1. **Layer 1（全局层）职责纯粹化**：
   - `tokens.css` **只允许**存在 `:root`、`html[data-theme='...']`、`[data-ui-size='...']` 下的 CSS 自定义属性声明，**严禁**在其中书写任何类选择器或 DOM 样式。
   - 消除 `theme-dark.css` 的补丁定位：暗黑主题的所有色值必须在 `tokens.css` 的 `html[data-theme='dark']` 分支中完整闭环定义。
2. **Layer 2（组件层）100% 隔离**：
   - 业务组件**必须且只能**使用 `*.module.css`。
   - **严禁在组件中使用全局类名覆盖**；跨组件定制一律通过 Props 或 CSS 自定义属性通道传递。
   - **严禁在 `*.module.css` 中书写 `:global(...)` 来修改外部组件结构**。

---

### 5.3 Z-Index 与层叠上下文重构规范（Portal 治理）

#### 1. 废黜 100,000 通胀，重构 6 级极简 Stacking Scale：

```css
:root {
  /* Level 0: 页面内容与局部流动元素 */
  --z-base: 0;
  --z-sticky: 10; /* 吸顶表头、固定工具条 */
  --z-dock: 20; /* 侧边栏、底部停靠栏 */

  /* Level 1: 局域弹出层 (由本地相对定位控制) */
  --z-dropdown: 100; /* 下拉菜单、自动补全列表 */
  --z-popover: 200; /* 气泡卡片、Slash 菜单 */

  /* Level 2: 全屏模态与遮罩 (必须挂载至 #modal-root) */
  --z-modal-backdrop: 1000; /* 对话框遮罩 */
  --z-modal: 1010; /* 对话框实体、全屏设置面板 */

  /* Level 3: 瞬态交互与最高操作 (必须挂载至 #overlay-root) */
  --z-context-menu: 2000; /* 右键上下文菜单 (必须高于 Tooltip) */
  --z-tooltip: 2100; /* 悬浮提示 Tooltip */

  /* Level 4: 全局通知与反馈 (必须挂载至 #toast-root) */
  --z-toast: 3000; /* 消息吐司 Toast */
  --z-drag-ghost: 3100; /* 拖拽中的 Ghost 实体 */

  /* Level 5: 系统最高级拦截 (必须挂载至 #system-root) */
  --z-system-gate: 9000; /* 紧急全局错误 Banner、新手引导 */
}
```

#### 2. 强制实施 React Portal 挂载隔离：

- 在 `index.html` 根节点设置独立的 Portal 挂载容器：
  ```html
  <div id="root"></div>
  <div id="modal-root"></div>
  <div id="overlay-root"></div>
  <div id="tooltip-root"></div>
  <div id="toast-root"></div>
  <div id="system-root"></div>
  ```
- **消除特异性补丁 Token**：
  - 彻底废弃 `--z-settings-tooltip`、`--z-usage-modal`、`--z-drag-overlay-max` 等恶性补丁。
  - 由于 Settings 面板挂载在 `#modal-root`，而其内部触发的 Tooltip 会被 Portal 到更高层级的 `#tooltip-root`，天然在 DOM 树顶层形成正确的层叠顺序，完全无需增加 z-index 数值！

---

### 5.4 Design Token 治理与 Fallback 清理准则

1. **根除有毒 Fallback**：
   - 彻底清除所有 `var(--text-primary, #f8fafc)`、`var(--bg-primary, #0f172a)` 等硬编码暗黑 Tailwind 值。
   - 规范写法：`color: var(--text-primary);`（由设计系统确保变量在根节点必达）。
2. **收敛幽灵 Token**：
   - 将 `ChatToolCallBlock.module.css` 中的 `var(--accent-amber, #f59e0b)` 统一收敛为规范的 `var(--color-warning)` 或 `var(--accent-orange)`。
3. **修复 `[data-panel]` 全局属性碰撞**：
   - 将 `design-system.css:61` 的 `[data-panel]` 选择器重构为专用的组件类名 `.ui-surface-panel`，严禁使用通用的 HTML 数据属性作为全局组件选择器。
4. **消除 JSX 行内样式**：
   - 针对 150+ 处 `style={{ ... }}`，在对应的 `.module.css` 中提取为语义清晰的 Modifier 类名（如 `.inlineIcon`, `.subtleMutedText`, `.relativeAnchor`）。

---

### 5.5 治理实施三阶段路线图（Roadmap）

```
Phase 1: 止血与死代码物理剔除 (Quick Win & Pure Deletion)
  ├── 1. 物理删除 styles/settings/ 下 6 个文件及 panels.css (立即减负 ~8,000 行)
  ├── 2. 从 index.css 中移除废弃 import 链
  ├── 3. 全局重命名 design-system.css 中的 [data-panel] 为 .ui-surface-panel
  └── 4. 批量清理 TSX 中的双重类名绑定 (mrd-*, sched-*, settings-ui-*)

Phase 2: Token 纯净化与 z-index 体系重构
  ├── 1. 将 z-index.css 收敛为 6 级语义 Scale，废除所有 10000+ 畸形 Token
  ├── 2. 在根 DOM 部署 Portal 容器 (#modal-root, #tooltip-root, #toast-root)
  ├── 3. 清理全仓 module.css 中的 #0f172a, #f8fafc 等暗色 hardcoded fallback
  └── 4. 消除 --accent-amber 等未定义幽灵 Token

Phase 3: 模块化彻底封口与 CI 门禁守护
  ├── 1. 消除剩余的 150+ 处 JSX style={{ ... }} 行内魔术值
  ├── 2. 将 theme-dark.css 的补丁规则彻底吸纳进 tokens.css，清空 theme-dark.css
  └── 3. 接入 Stylelint 门禁：
       - 禁止在 .module.css 外书写组件选择器
       - 禁止使用未在 tokens.css 登记的 CSS 变量
       - 禁止使用裸数字 z-index
       - 限制 !important 的新增
```

---

_(报告终)_
