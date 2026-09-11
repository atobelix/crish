# 05 · 真实 UI 运行态、CSS Modules 级联污染与视觉规范合规性严苛审计

- **战役任务**：真实 UI 运行态、CSS Modules 级联污染与视觉规范合规性严苛审计
- **审计范围**：
  - `apps/crish-desktop/src/components/`（各主要 UI 面板）
  - `apps/crish-desktop/src/styles/`（全局样式层与设计 Token）
  - `ANTI_OVERENGINEERING_GUARDRAILS.md`（反过度设计硬性红线）
  - `AGENTS.md` §12（Tooltip）/ §13（输入框焦点态）/ §14（色彩空间与现代 CSS 语法）
- **审计原则**：严苛挑刺、穿透表象深挖根因、列出详实代码坐标证据，严禁执行 git 操作，禁止打补丁与妥协。
- **输出文件**：`docs/ui-style-refactor/audits/05-runtime-cascading-and-visual-compliance-audit.md`（UTF-8 无 BOM）

---

## 一、全仓样式与运行态选择器量化大盘

对 `apps/crish-desktop/src/` 下全部 112 个 CSS/CSS Module 文件及 469 个 TSX 组件进行全量 AST 与选择器静态扫描，量化指标如下：

| 指标项 | 统计数值 | 状态与诊断说明 |
| :--- | :--- | :--- |
| **扫描 CSS 文件总数** | 112 个 (29,580 行) | 包含 101 个 `.module.css` 与 11 个全局 `.css` |
| **CSS Module 中 `:global(...)` 规则数** | **287 处** (分布于 30 个模块) | 存在严重作用域破壁、未限定作用域泄漏及反向主题硬编码 |
| **纯全局未限定 `:global` 规则** | **11 处** | 无任何本地哈希 Class 约束，直接污染全局 DOM 树 |
| **跨组件模糊匹配 `[class*='...']`** | **26 处** | 依靠类名子串做跨组件穿透注入，破坏 CSS Modules 绝缘性 |
| **主题硬编码 `:global(html[data-theme='dark'])`** | **55 处** (分布于 9 个模块) | 绕过 Design Tokens 单一真相源，私自抬高特异性覆写样式 |
| **`!important` 强制提权声明** | **94 处** (组件层 44 处) | 边框消除对抗、尺寸硬覆盖、滚动条强行抹除 |
| **原生 DOM `title=` 违规使用** | **9 处** (TSX 原生元素) | 违背 `AGENTS.md` §12，绕过自定义 `<Tooltip>` 胶囊 |
| **旧式逗号分隔 `rgba(...)` / `rgb(...)`** | **244 处** | 违背 `AGENTS.md` §14，散落于组件层而非 Token 定义 |
| **组件内硬编码 Hex 颜色字面量** | **442 处** | 逃逸 Token 体系，深色模式无法自适应或产生脏黑 |
| **暗色焦点环 `--focus-ring-color` 混入超标** | **30% (Token 定义违规)** | `tokens.css:902` 明确写死 30%，直接违反 `AGENTS.md` §13（上限 10%） |

---

## 二、`:global(...)` 泄漏与选择器污染严苛审查

### 2.1 纯全局泄漏规则（无本地作用域约束，直接污染全局 DOM）

在 CSS Modules 中，若选择器整条链路**没有任何本地未带 `:global` 的 Class**，Webpack / Vite CSS Modules 插件会将该选择器原样输出到全局构建产物中，产生静默的全局样式污染。

| 源码位置 | 违规选择器声明 | 污染后果与严重性评估 |
| :--- | :--- | :--- |
| `TiptapEditorField.module.css:179` | `:global(.mention-chip)` | **高危**：全局任何包含 `.mention-chip` 类名的元素均会被注入特定 padding、display、line-height 与字体颜色，破坏非聊天组件（如文档、标签页）的 Mention 独立渲染。 |
| `TiptapEditorField.module.css:195` | `:global(.mention-chip-file)` | **高危**：强制全局 `.mention-chip-file` 使用固定背景与内边距。 |
| `TiptapEditorField.module.css:199` | `:global(.mention-chip-skill)` | **高危**：强制全局 `.mention-chip-skill` 设定样式。 |
| `TiptapEditorField.module.css:203` | `:global(.mention-icon-box)` | **高危**：设定全局尺寸 `width: 14px; height: 14px`，污染其他模块中同名图标容器。 |
| `TiptapEditorField.module.css:215` | `:global(.mention-icon-box svg)` | **中危**：全局强制 svg 尺寸为 11px。 |
| `Menu.module.css:151` | `:global(.sep-safe-aim-overlay)` | **高危**：在 UI 基础组件 `Menu.module.css` 中直接声明全屏固定定位浮层 `position: fixed; width: 100vw; height: 100vh`，属于未命名空间的全局污染。 |
| `Menu.module.css:163` | `:global(.sep-safe-aim-overlay.sep-debug-visible)` | **中危**：全局调试绿色半透明填充层。 |
| `Menu.module.css:170` | `:global(.sep-safe-aim-overlay polygon)` | **低危**：全局 SVG polygon 样式。 |
| `sessionTabDrag.module.css:54` | `:global([data-global-session-tab-bar] [role='tab'].is-dragging)` | **中危**：拖拽辅助样式未通过本模块类名引导，直接挂载到顶层属性选择器上。 |
| `NotePaperPanel.module.css:255` | `:global(.np-paper-list-mount)` | **高危**：直接以全局类名设置 `width: 100%`、`flex: 1 1 auto`，未包裹在 `.panel` 之下。 |
| `NotePaperPanel.module.css:266` | `:global(.np-paper-list-mount[data-scroll-host='1'])` | **高危**：直接暴露全局滚动容器属性规则。 |

```css
/* --- 典型违规代码示例 (TiptapEditorField.module.css:179-204) --- */
/* 开发者本意为 Tiptap 编辑器内的 Mention 标签写样式，却脱离了 .proseMirrorField 作用域 */
:global(.mention-chip) {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  /* 此规则被原样编译为全局 `.mention-chip`，造成全局污染 */
}

:global(.mention-icon-box) {
  display: inline-flex;
  width: 14px;
  height: 14px;
}
```

---

### 2.2 跨组件模糊类名穿透破壁（`[class*='...']` 反模式）

使用属性子串选择器（如 `[class*='sessionText']`）强行穿透子组件的 CSS Module 哈希隔离，是导致代码强耦合与渲染抖动的重大毒点。

#### 1. 侧边栏折叠穿透 (`Sidebar.module.css:355-450`)
`Sidebar` 组件在 `.iconCollapse` 状态下，为了强制隐藏子组件（`SidebarNav`、`SessionList`、`UserProfileCard`）内部的文本和图标，编写了多达 10 条模糊匹配选择器：

```css
/* apps/crish-desktop/src/components/sidebar/Sidebar.module.css:378-387 */
.iconCollapse .sidebarScroll :global([class*='sectionLabel']) > :not(svg),
.iconCollapse .sidebarScroll :global([class*='folderHeader']) > :not(svg),
.iconCollapse .sidebarScroll :global([class*='folderName']),
.iconCollapse .sidebarScroll :global([class*='folderCount']),
.iconCollapse .sidebarScroll :global([class*='sessionText']),
.iconCollapse .sidebarScroll :global([class*='sessionSearchSnippet']),
.iconCollapse .sidebarScroll :global([class*='sessionTime']),
.iconCollapse .sidebarScroll :global([class*='sessionActionsBtn']),
.iconCollapse .sidebarScroll :global([class*='emptyHint']),
.iconCollapse .sidebarScroll :global([class*='sessionItemFoldBtn']) {
  display: none !important; /* 甚至加剧了 !important 滥用 */
}

.iconCollapse .sidebarScroll :global([class*='sessionItem']) {
  width: 36px;
  min-width: 36px;
  padding: 0;
  justify-content: center;
}
```

**深度根因**：
1. **模块职责倒置**：父容器越俎代庖，直接决定子组件数十个内部 DOM 节点的 `display` 与 `width`，而非向子组件下发 `collapsed={true}` 属性或在容器上标记 `data-collapsed="true"` 由子组件自身响应；
2. **性能与稳定性隐患**：CSS 引擎进行 `[class*='...']` 全文正则匹配，每次 DOM 变更均会触发深层级联重算；若子组件重命名 Class（如 `sessionText` 改为 `sessionTitle`），样式将瞬间静默失效。

#### 2. 删除按钮悬浮回退穿透 (`ProjectPickerMenu.module.css:68`)
```css
/* apps/crish-desktop/src/components/chat-card/ProjectPickerMenu.module.css:68 */
div:hover > button > div > .rowDeleteBtn,
div:hover > .rowDeleteBtn,
:global(.sep-item-wrapper):hover .rowDeleteBtn,
[class*="itemWrapper"]:hover .rowDeleteBtn {
  opacity: 1;
}
```
**深度根因**：为了在各种嵌套层级下点亮删除按钮，开发者堆叠了 4 种猜测性选择器，包含 4 级标签子代选择器 `div > button > div > ...` 和子串模糊匹配 `[class*="itemWrapper"]`，属于典型的打补丁与特异性失控。

#### 3. 全局滚动条子串截获 (`overlay-scrollbar.css:42-46`)
```css
/* apps/crish-desktop/src/styles/overlay-scrollbar.css:42-46 */
[class*='sidebarScroll'],
[class*='menuContent'],
[class*='coverContent'],
[class*='navScroll'],
[class*='dialogBody'] {
  scrollbar-width: thin;
  scrollbar-gutter: stable;
}
```
**深度根因**：全局样式表通过类名子串试图一网打尽所有滚动区域，侵入各个模块的盒模型，一旦某个非滚动容器包含 `dialogBody` 子串即产生非预期滚动占位。

---

### 2.3 主题暗色硬编码覆写（破坏 Token 单一真相源 SSOT）

在全仓 9 个 CSS Module 文件中，存在 **55 处** `:global(html[data-theme='dark']) .localClass` 规则。这些规则完全违背了 CSS Variables（Token）的驱动模型，导致暗色模式维护分裂。

| 模块文件 | 违规规则数 | 典型硬编码属性与值 |
| :--- | :--- | :--- |
| `ModelsSettingsTab.module.css` | **17 处** | `background: rgba(245, 244, 240, 0.06)`, `border-color: #2b2926`, `box-shadow: 0 24px 54px -10px rgba(0, 0, 0, 0.70)`, `color: #10b981` |
| `FontSelectField.module.css` | **14 处** | `background: var(--sep-bg-panel, rgba(24, 23, 21, 0.96))`, `border-color: #2b2926` |
| `Select.module.css` | **8 处** | `background: var(--bg-card, #181715)`, `border-color: var(--border-color, #2b2926)` |
| `Menu.module.css` | **4 处** | `background: rgba(245, 244, 240, 0.06)`, `border-bottom-color: rgba(255, 255, 255, 0.07)` |
| `FontSettingsSection.module.css` | **4 处** | `background: rgba(245, 244, 240, 0.06)`, `.customApplyBtn:hover` 颜色覆写 |
| `SettingsRulesTab.module.css` | **2 处** | `.presetChip` 暗色边框与背景硬写 |
| `SettingsSecurityTab.module.css` | **2 处** | `.presetChip` 暗色边框与背景硬写 |
| `SettingsUI.module.css` | **2 处** | `.modernSelectTooltipInner` 浮层暗色覆写 |
| `StatusDiagnosticsPanel.module.css` | **2 处** | `.monoBadge`, `.diagLevel_debug` 颜色覆写 |

```css
/* --- 典型反模式代码 (Select.module.css:52-64, 113-175) --- */
/* 亮色模式定义 */
.trigger {
  border: 1px solid var(--border-color, #e2dfd9);
  background: var(--bg-card, #ffffff);
}
.option:hover {
  background: rgba(29, 28, 26, 0.045);
}

/* ❌ 违规反模式：深色模式未通过 var() 自动解析，而是手动抬高特异性硬编码覆盖 */
:global(html[data-theme='dark']) .trigger {
  border-color: var(--border-color, #2b2926);
  background: var(--bg-card, #181715);
}
:global(html[data-theme='dark']) .option:hover {
  background: rgba(245, 244, 240, 0.06);
}
```

**危害分析**：
1. **Token 失去控制力**：即便在 `tokens.css` 中统一调优暗色背景为中性灰 `hsl(0 0% 11%)`，上述组件依然被 `:global(html[data-theme='dark']) .trigger` 中的 `#181715` 强行覆盖；
2. **特异性攀升 (Specificity Inflation)**：`.option:hover` 特异性为 `(0, 1, 1)`，而 `:global(html[data-theme='dark']) .option:hover` 特异性攀升为 `(0, 2, 2)`。一旦后续有其他状态类（如 `.isActive`）试图覆盖它，必须被迫写出更高特异性或使用 `!important`，形成特异性军备竞赛。

---

### 2.4 `!important` 升级战与边框消除对抗清单

组件层中共有 **44 处** 非动画类的 `!important`，其根本原因主要集中在三大场景：

#### 场景 1：多面板嵌套时的“顶边框消除对抗”（8 处）
- `AgentCard.module.css:34`: `border-top: none !important;`
- `DiffCard.module.css:379`: `border-top: none !important;`
- `FileViewerCard.module.css:21`: `border-top: none !important;`
- `FilesCard.module.css:43`: `border-top: none !important;`
- `PreviewCard.module.css:21`: `border-top: none !important;`
- `LeafToolTabStrip.module.css:21, 37`: `border-bottom: none !important;`

**根因**：工作区二叉树（`BinaryTreeWorkspace`）将各个 Leaf 卡片挂载到 Tab 页签下方时，卡片自带的 1px 上边框与 TabStrip 的下边框重叠，开发者未在容器层通过 `:first-child` 或状态属性控制边框，而是在每个卡片模块中无差别添加 `!important` 强行抹除。

#### 场景 2：尺寸与微型按钮强行锁死（6 处）
- `PreviewCard.module.css:202-207`:
  ```css
  .miniButton {
    height: 22px !important;
    min-height: 22px !important;
    padding: 0 6px !important;
    font-size: 11px !important;
    border-radius: var(--radius-sm, 4px) !important;
    gap: 4px !important;
  }
  ```
**根因**：全局 `design-system.css` 或基础 Button 组件设置了默认 `min-height: 28px`，`PreviewCard` 无法通过常规 Class 覆盖，被迫连发 6 个 `!important` 强力镇压。

#### 场景 3：滚动条样式强制清空（7 处）
- `ModelBadgePickerMenu.module.css:115-130`:
  ```css
  &::-webkit-scrollbar {
    display: none !important;
    width: 0 !important;
    height: 0 !important;
  }
  &::-webkit-scrollbar-track {
    background: transparent !important;
  }
  &::-webkit-scrollbar-thumb {
    background: rgba(0, 0, 0, 0.18) !important;
    border-radius: 4px !important;
  }
  ```
**根因**：与全局 `overlay-scrollbar.css` 冲突，导致组件内部必须用 `!important` 抢夺伪元素控制权。

---

## 三、视觉层级、节奏与微交互感知深度审计

### 3.1 背景层级链（Elevation Rhythm）与色相断层审计

Conex / Crish 定义的基线视觉韵律应为柔和递进的四层阶梯：
$$\text{Canvas / Shell} \longrightarrow \text{Sidebar / Chrome} \longrightarrow \text{Card / Paper} \longrightarrow \text{Control / Composer} \longrightarrow \text{Popover / Floating}$$

#### 浅色模式（Light Mode）节奏诊断

| 层级名称 | 对应 Token | 实际渲染色值 | 视觉感知与问题诊断 |
| :--- | :--- | :--- | :--- |
| **0阶：画布/外壳** | `--bg-primary` / `--bg-canvas` | `#f4f5f7` (冷灰) / `#f6f5f3` (暖灰) | **色温分裂**：Shell 底板与工作区底板存在冷暖色相漂移（ΔE ≈ 2.1）。 |
| **1阶：侧边栏/顶栏** | `--bg-secondary` | `#eaecee` (灰度 93%) | 边界清晰，对比自然。 |
| **2阶：主卡片底** | `--bg-card` | `#ffffff` (纯白 100%) | 洁净扁平，符合 Paper 设计语言。 |
| **3阶：输入框/控件** | `--composer-bg` | `color-mix(var(--control-mix-color) 15%, var(--bg-primary))` | **严重浑浊**：混入 15% 的 `hsl(35 40% 30%)` 导致浅色模式输入框底色呈现脏黄暗沉（明度仅约 87%），与纯白卡片底（100%）形成过大的生硬凹陷感。 |
| **4阶：悬浮气泡/菜单** | `--sep-bg-panel` | `rgba(255, 254, 252, 0.96)` | 暖米白磨砂玻璃，与 2 阶纯白卡片重叠时轻微发黄。 |

#### 深色模式（Dark Mode）节奏与“脏黑”诊断

| 层级名称 | 对应 Token | 实际渲染色值 | 视觉感知与问题诊断 |
| :--- | :--- | :--- | :--- |
| **0阶：画布/外壳** | `--bg-primary` | `hsl(0, 0%, 5%)` (`#0d0d0d`) | 纯中性极深灰底。 |
| **1阶：侧边栏/顶栏** | `--bg-secondary` | `hsl(0, 0%, 8%)` (`#141414`) | 纯中性二级底。 |
| **2阶：主卡片底** | `--bg-card` | `hsl(0, 0%, 11%)` (`#1c1c1c`) | 纯中性卡片底。 |
| **3阶：嵌套/输入** | `--bg-elevated` / `--composer-bg` | `hsl(0, 0%, 15%)` / `hsl(0, 0%, 8%)` | **层级倒置**：Dark 模式下 `--composer-bg` 被赋予 `--bg-secondary` (8%)，导致输入框比卡片底 (11%) **更深/更黑**（本应微浮起或保持平齐），打破了正向明度递增规律。 |
| **4阶：悬浮气泡/菜单** | `--sep-bg-panel-solid` | `#181715` (hsl: 40°, 9%, 9%) | **脏黑根源**：SEP 浮层使用了暖黄色相（Hue 40°）的暗灰，悬浮在 Hue 0° 的中性卡片上，边缘呈现浑浊发黄的暗色斑块。 |

```
【深色模式色相与明度断层拓扑图】
Standard Token (Hue 0° 纯中性):
  [Shell #0d0d0d] -> [Sidebar #141414] -> [Card #1c1c1c]
                                              │
                                              ▼ (叠加色相漂移!)
SEP & Hardcoded Token (Hue 36°~40° 暖脏黑):
                                  [Menu/Flyout #181715]
                                  [Border #2b2926]
                                  [Hover rgba(245,244,240,0.06)]
```

---

### 3.2 规范合规性深度审查

#### 1. `AGENTS.md` §13 输入框与焦点态（Focus Ring）合规性

- **铁律要求**：
  > 边框禁止粗、深、实心黑边；焦点/激活态灰色加深混入文本色上限不超过约 **10%**（常规元素优先约 **3%–6%**）；全页空态落地输入至多约 **5%**；默认不要厚重 `box-shadow`。
- **违规实证 1：Token 真源定义违规**：
  ```css
  /* apps/crish-desktop/src/styles/tokens.css:902 */
  html[data-theme='dark'] {
    --focus-ring-color: color-mix(in srgb, var(--text-primary) 30%, transparent); /* ❌ 30% 严重超标！*/
    --focus-ring: 0 0 0 2px var(--focus-ring-color);
  }
  ```
  `tokens.css` 在深色模式下将 `--focus-ring-color` 定义为 **30% 的文本色混入**（高达 `rgba(240, 240, 240, 0.30)`），直接超出了 10% 的铁律红线 3 倍，导致聚焦元素产生刺目亮环。
- **违规实证 2：硬编码 30% 注释与样式残留**：
  - `NotePaperPanel.module.css:5` 与 `NotePaperPanel.module.css:148` 仍赫然标注 `/* --focus-ring 30% */`；
  - `PreviewCard.module.css` (8处)、`TerminalCard.module.css` (2处) 均直接挂载 `box-shadow: var(--focus-ring, 0 0 0 2px var(--tint-focus-ring))`。

#### 2. `AGENTS.md` §12 Tooltip 原生属性合规性

- **铁律要求**：
  > 始终使用项目自定义 `<Tooltip>` 组件，**不要**用原生 HTML `title` 作为主悬停提示，避免浏览器默认黄色/矩形陈旧气泡。
- **存量 9 处原生 DOM `title=` 违规坐标清单**：
  1. [`ModelBadgePickerMenu.tsx:177`](file:///c:/Software/conex/apps/crish-desktop/src/components/provider/ModelBadgePickerMenu.tsx#L177): `<button ... title="模型管理...">`
  2. [`ModelConfigPanel.tsx:93`](file:///c:/Software/conex/apps/crish-desktop/src/components/settings-models/ModelConfigPanel.tsx#L93): `<span ... title={meta.lastTest.error}>`
  3. [`SkillCardList.tsx:84`](file:///c:/Software/conex/apps/crish-desktop/src/components/settings-skills/SkillCardList.tsx#L84): `<div ... title="...">`
  4. [`SkillCardList.tsx:108`](file:///c:/Software/conex/apps/crish-desktop/src/components/settings-skills/SkillCardList.tsx#L108): `<div ... title={EMPTY_FILTER_HINT}>`
  5. [`SmartPanelHeader.tsx:41`](file:///c:/Software/conex/apps/crish-desktop/src/components/ui/SmartExpandablePanel/SmartPanelHeader.tsx#L41): `<button ... title="清空搜索">`
  6. [`LiveTasksSection.tsx:55`](file:///c:/Software/conex/apps/crish-desktop/src/components/workspace/LiveTasksSection.tsx#L55): `<div ... title="...">`
  7. [`RuntimePanel.tsx:93`](file:///c:/Software/conex/apps/crish-desktop/src/components/workspace/RuntimePanel.tsx#L93): `<div ... title="...">`
  8. [`SecurityAuditSection.tsx:78`](file:///c:/Software/conex/apps/crish-desktop/src/components/workspace/SecurityAuditSection.tsx#L78): `<span ... title={entry.targets.join('\n')}>`
  9. [`TrashSection.tsx:149`](file:///c:/Software/conex/apps/crish-desktop/src/components/workspace/TrashSection.tsx#L149): `<span ... title={entry.originalPath}>`

#### 3. `AGENTS.md` §14 色彩空间与语法合规性

- **铁律要求**：优先 `hsl(h s l / a)` 或 `hsla(...)` 斜杠语法；避免散落旧式 `rgba(r,g,b,a)`。
- **违规情况**：全仓仍有 **244 处** 旧式 `rgba(r, g, b, a)` 散落，尤其高发于：
  - `ModelsSettingsTab.module.css` (34 处)
  - `FontSelectField.module.css` (18 处)
  - `ModelBadgePickerMenu.module.css` (17 处)
  - `Menu.module.css` (14 处)
  - `Select.module.css` (13 处)

---

## 四、反过度设计防线（Anti-Overengineering Guardrails）遵从性审查

对照 `ANTI_OVERENGINEERING_GUARDRAILS.md`：

| 禁令条款 | 审计判定 | 详细情况说明 |
| :--- | :--- | :--- |
| **禁令 11：严禁同进程微服务套娃与虚假 Facade** | **合规** | CSS 模块未引入复杂的运行时 CSS-in-JS 样式生成引擎或样式分发中间件，保持原生 CSS Modules 架构。 |
| **禁令 12：严禁流式状态穿透全局 Store 与盲目包裹 memo** | **大部分合规，存在 1 处高特异性修补** | `StreamingTableContainer.module.css` 与 `streaming-animation.css` 实现了流式文本与 Markdown 表格的原生渲染优化，但其在性能降级（`[data-perf-tier='eco']`）时使用了 `!important`（`animation: none !important; will-change: auto !important;`），需收敛为基于 CSS 自定义属性切换。 |

---

## 五、级联污染治理与视觉层级规范化重构方案

### 5.1 `:global` 泄漏与穿透根除方案

#### 1. 纯全局规则封装化
- 将 `TiptapEditorField.module.css` 中的 `.mention-chip`、`.mention-icon-box` 强制包裹在 `.proseMirrorField` 作用域内：
  ```css
  /* 改造后 */
  .proseMirrorField :global(.mention-chip) { ... }
  .proseMirrorField :global(.mention-icon-box) { ... }
  ```
- 将 `Menu.module.css` 中的 `:global(.sep-safe-aim-overlay)` 移入全局遮罩样式层 `design-system.css` 或 `overlay.css`，并添加模块专有前缀与命名空间。

#### 2. 废除 `[class*='...']` 模糊穿透，推行统一 Data Attribute 状态下发
- 彻底移除 `Sidebar.module.css:355-450` 的全部 `[class*='...']` 选择器；
- 在 `Sidebar` 顶层容器注入 `data-sidebar-collapsed={isCollapsed ? 'true' : 'false'}`；
- 子组件（`SidebarNav`, `SessionList`, `Folder`, `UserProfileCard`）在其自身的 `.module.css` 中基于 `:global([data-sidebar-collapsed='true']) .selfItem` 声明自己的折叠行为，实现关注点分离与强绝缘。

```css
/* SessionList.module.css 内部自治响应折叠状态 */
:global([data-sidebar-collapsed='true']) .sessionText {
  display: none;
}
:global([data-sidebar-collapsed='true']) .sessionItem {
  width: 36px;
  justify-content: center;
}
```

---

### 5.2 剔除 `:global(html[data-theme='dark'])`，统一收敛至 Token 驱动

1. 彻底删除 `ModelsSettingsTab.module.css`、`FontSelectField.module.css`、`Select.module.css`、`Menu.module.css` 等 9 个文件中的全部 55 处 `:global(html[data-theme='dark']) .className` 规则；
2. 组件中所有 `background`、`border-color`、`box-shadow`、`color` 一律引用统一的 Token 变量：
   - 背景色：`var(--bg-card)` / `var(--bg-elevated)` / `var(--bg-hover)`
   - 边框色：`var(--border-color)` / `var(--border-subtle)`
   - 阴影：`var(--shadow-dropdown)` / `var(--shadow-popover)`
3. 在 `tokens.css` 中，将亮暗两态的变量真源定义完善，让浏览器原生依据 `html[data-theme]` 自动切换，组件 Module 零额外特异性负担。

---

### 5.3 `!important` 消除与边框重构方案

1. **消除卡片上边框对抗**：
   - 移除 `AgentCard`, `DiffCard`, `FilesCard`, `PreviewCard` 中的 `border-top: none !important;`；
   - 在 `BinaryTreeWorkspace` 的容器样式中，采用标准的相邻兄弟或父级状态选择器管理边框：
     ```css
     .leafHeader + .leafContent {
       border-top: 1px solid var(--border-color);
     }
     .leaf[data-has-strip='true'] .leafCard {
       border-top: none;
     }
     ```
2. **微型按钮样式解耦**：
   - 在 `PreviewCard` 中移除 6 个 `!important`，将微型按钮定义为专用变体 `.miniActionBtn`，设置合理的 CSS 优先级与特异性。

---

### 5.4 Token 融合与单色温阶梯规范化（消除“脏黑”与色相漂移）

1. **统一中性灰底（Pure Neutral Palette）**：
   - 将 SmartExpandablePanel (SEP) 的暖黄底色（`#181715`, `#2b2926`, `rgba(24, 23, 21, 0.96)`）全面校准为与 Conex 主体一致的纯中性阶梯（`hsl(0 0% 11%)` 卡片底、`hsl(0 0% 15%)` 浮层底、`hsl(0 0% 18%)` 边框底）；
   - 消除暗色模式下 hover 时泛黄的 `rgba(245, 244, 240, 0.06)`，统一使用基于主文本色混入的标准 Token：
     $$\text{--bg-hover: color-mix(in srgb, var(--text-primary) 4%, transparent)}$$
     $$\text{--bg-active: color-mix(in srgb, var(--text-primary) 8%, transparent)}$$

2. **矫正 Light Mode Composer 背景**：
   - 将 `--composer-bg` 的混入比例从过于深沉沉重的 15% 调整为柔和轻盈的 **3%~5%**：
     ```css
     --composer-bg: color-mix(in srgb, var(--control-mix-color) 4%, var(--bg-card));
     ```
   - 保证输入框在卡片内呈现极其轻微、干净、扁平的微凹陷，消除脏黄感。

3. **修复 Dark Mode 焦点环 Token 违规**：
   - 修改 `tokens.css:902`，将 `--focus-ring-color` 从 30% 降至合规的 **5%~8%**：
     ```css
     html[data-theme='dark'] {
       --focus-ring-color: color-mix(in srgb, var(--border-color) 92%, var(--text-primary) 8%);
       --focus-ring: 0 0 0 1.5px var(--focus-ring-color);
     }
     ```

4. **清理 9 处原生 DOM `title=`**：
   - 将 `ModelBadgePickerMenu.tsx` 等 9 处组件中的原生 `title="..."` 替换为项目标准 `<Tooltip content="...">` 组件包裹。

---

## 六、审计结论与落地验收断言

1. **级联污染归零**：重构后 CSS Modules 中纯全局未限定选择器必须为 **0 处**，模糊匹配 `[class*='...']` 穿透必须为 **0 处**；
2. **Token SSOT 归一**：组件内 `:global(html[data-theme='dark'])` 手动覆写必须为 **0 处**，暗色模式切换 100% 经由 CSS Variables 驱动；
3. **特异性与权重健康**：非媒体查询/无障碍降级类的组件级 `!important` 必须清零；
4. **规范 100% 合规**：焦点环暗色透明度不超过 **10%**，原生 DOM `title=` 违规归零，旧式 `rgba` 语法收敛为标准 `hsl(... / a)`。
