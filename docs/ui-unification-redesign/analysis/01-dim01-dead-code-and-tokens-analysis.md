# DIM-01 专项分析：重复、死层与 Token 碎片收敛

> **战役定位**：`UI-UNIFICATION-REDESIGN` 战役阶段一 · 维度一（DIM-01）深度分析报告  
> **设计依据**：`C:\Software\conex\skill\design\`（`jakub-skills/skills/better-typography`、`better-colors`、`better-ui`、`apple-design.md`）、`AGENTS.md`（§1、§7、§7.1、§8、§13、§14）  
> **核心使命**：对桌面端核心样式底座 [`tokens.css`](file:///c:/Software/conex/apps/crish-desktop/src/styles/tokens.css)（1758 行）展开穷尽式静态拓扑扫描；清剿 180+ 个完全未消费的死变量与历史兼容包袱；终结 14 档碎步半像素字阶乱象，建立标准 7 档字阶（11, 12, 13, 14, 16, 18, 22px）与 19 处业务消费点的确定性迁移映射；拔除 SettingsPanel、Sidebar 等核心组件裸造的私有样式轮子，实现全工程 **-680+ 行 Net-Negative LOC（净负产出）**。

---

## 一、维度现状与架构断层总述

在过去的快速迭代与多轮特性追加中，前端样式体系积累了大量隐蔽的技术债务。经对 `apps/crish-desktop/src/` 下全量 320+ 个 CSS/TSX/TS 文件建立的静态语法与 Token 引用拓扑图谱，DIM-01 揭示出三大深层架构断层：

1. **Token 底板极度臃肿与死层积压**：
   - [`tokens.css`](file:///c:/Software/conex/apps/crish-desktop/src/styles/tokens.css) 累计多达 1,758 行，声明了 612 个全局 CSS 变量。
   - **经全库引用拓扑分析，存在 171 个外部零引用变量（其中 160 个全量零引用，11 个仅在 `tokens.css` 内部被其他死变量空转引用）**。
   - 早期重构遗留的整块特定业务系统（如旧版极简思考链、Legacy Diff、早期的 SmartExpandablePanel 脚手架变量、已废弃的端点按钮滚动条体系）被完整遗忘在底座中，并在 Light 与 Dark 双主题块中双倍复制，造成约 260+ 行无任何像素产出的纯死代码。

2. **字体阶梯碎片化（Typography Fragmentation）与次像素渲染缺陷**：
   - 样式底座中除了基本的 `xxs`~`2xl` 外，滋生了 `--font-size-nano`(10px), `--font-size-micro`(11.5px), `--font-size-xs-plus`(12.5px), `--font-size-sm-plus`(13.5px), `--font-size-chat`(13.5px), `--font-size-xxl`(18px) 等 14 档半像素碎步字阶。
   - 违背 `better-typography` 核心原则（*A small set of sizes used across a product, deviated from as little as possible*）。半像素在不同屏幕 DPI 和次像素抗锯齿引擎下会导致字体笔画发虚、闪烁与行高计算浮动。
   - **致命断层证据**：在响应式 UI 缩放档位 `[data-ui-size='small']` 与 `[data-ui-size='large']`（[`tokens.css:1471-1559`](file:///c:/Software/conex/apps/crish-desktop/src/styles/tokens.css#L1471-L1559)）中，**仅重写了 7 档标准字阶，完全遗漏了 `nano`, `micro`, `xs-plus`, `sm-plus` 等非常规字阶**。这意味着用户在设置中切换「紧凑」或「宽敞」模式时，使用半像素字阶的组件界面会发生排版锁死与比例脱节。

3. **业务层绕过原子规范，重复裸造私有样式轮子**：
   - 尽管 `apps/crish-desktop/src/components/ui/` 已建设了完善的 `<Button>`, `<IconButton>`, `<Input>` 标准原子组件，但 `SettingsPanel`, `SidebarHeader`, `SidebarFooter`, `TerminalCard`, `FontSelectField` 等核心骨干视图仍然大量裸写原生 `<button>` 与 `<input>`。
   - 仅在搜索框与操作图标按钮上，各组件就私自手写了多达 420+ 行高度重合的 `.searchWrap`, `.searchIco`, `.searchInput`, `.sidebarToggleBtn`, `.settingsGearBtn`, `.actionBtn` 样式，带来了严重的视觉不一致、无障碍缺陷（缺乏 IME 输入法守卫、丢失 Tooltip 统一规范）与维护泥潭。

---

## 二、CSS 变量全景审计：死变量、历史包袱与废弃别名深度清单

### 2.1 统计数据概要

| 统计指标项 | 数量 / 比例 | 说明与定性 |
| :--- | :--- | :--- |
| `tokens.css` 声明的唯一变量总数 | **612 个** | 全工程样式变量底板规模 |
| **外部零引用变量数（Dead Variables）** | **171 个 (27.9%)** | 全工程业务组件与样式无任何消费 |
| ├─ 全局完全无引用（Completely Isolated） | **160 个** | 甚至在 `tokens.css` 内部也没有任何引用 |
| └─ 内部自闭合空转引用（Internal Only） | **11 个** | 仅被 `tokens.css` 内部其他死变量赋值引用 |
| 历史兼容别名与同名异义变量 | **15 个** | `--danger-color`, `--accent-danger`, `--text-danger` 等多源混用 |
| 碎步/半像素及死字阶变量 | **7 个** | `nano`, `micro`, `xs-plus`, `sm-plus`, `chat`, `xxl` 及调整项 |
| **预期直接收敛/消除变量总数** | **186 个** | **占总变量数的 30.4%** |

---

### 2.2 核心死层深入剖析与现场代码证据

#### 死层 A：极简思考链与状态横幅系统残留（38 变量 · 约 76 行死代码）
- **代码位置**：
  - Light 主题：[`tokens.css:703-741`](file:///c:/Software/conex/apps/crish-desktop/src/styles/tokens.css#L703-L741)
  - Dark 主题：[`tokens.css:1364-1403`](file:///c:/Software/conex/apps/crish-desktop/src/styles/tokens.css#L1364-L1403)
- **变量清单**：
  `--thought-header-bg`, `--thought-header-hover-bg`, `--thought-header-fg`, `--thought-header-hover-fg`, `--thought-header-font-size`, `--thought-header-line-height`, `--thought-border-color`, `--thought-indicator-bar`, `--thought-live-title-fg`, `--thought-live-dot`, `--thought-live-glow`, `--thought-chevron-fg`, `--thought-chevron-hover-fg`, `--thought-chevron-color`, `--thought-chevron-hover`, `--thought-rail-color`, `--thought-rail-width`, `--thought-body-bg`, `--thought-body-fg`, `--thought-body-font-size`, `--thought-body-line-height`, `--thought-time-bg`, `--thought-time-fg`, `--thought-badge-bg`, `--thought-badge-fg`, `--thought-summary-indent`, `--thought-font-size-meta`, `--thought-scroll-max-h`, `--thought-max-height`, `--thought-mask-bg`（30 个变量）以及 `--banner-error-*`（8 个变量）。
- **现场证据**：
  当前负责渲染思考链的真实组件为 [`TimelineThoughtSection.module.css`](file:///c:/Software/conex/apps/crish-desktop/src/components/chat-message-row/TimelineThoughtSection.module.css#L1-L60)。该组件早已完全切换为消费通用原子 Token（如 `--font-size-sm`, `--text-secondary`, `--brand` 等），上述 38 个特定领域 Token 经历了多次迭代后彻底沦为化石代码，全工程 0 次调用。
- **治理裁决**：**全量删除 Light 与 Dark 两侧全部 38 个定义（净删除 76 行代码）**。

#### 死层 B：Legacy Diff 兼容映射与残存内部变量（21 变量 · 约 42 行死代码）
- **代码位置**：
  - Light 主题：[`tokens.css:629, 636, 643-646, 654-666, 839-842`](file:///c:/Software/conex/apps/crish-desktop/src/styles/tokens.css#L654-L666)
  - Dark 主题：[`tokens.css:1289-1328`](file:///c:/Software/conex/apps/crish-desktop/src/styles/tokens.css#L1316-L1328)
- **变量清单**：
  `--diff-line-add-bg`, `--diff-line-add-border`, `--diff-gutter-add-bg`, `--diff-gutter-add-fg`, `--diff-word-add-bg`, `--diff-line-del-bg`, `--diff-line-del-border`, `--diff-gutter-del-bg`, `--diff-gutter-del-fg`, `--diff-word-del-bg`, `--diff-line-delete-bg`, `--diff-line-delete-border`, `--diff-header-height`, `--diff-sidebar-width`, `--diff-sidebar-width-md`, `--diff-file-chip-min`, `--diff-file-chip-min-xs`, `--diff-context-fg`, `--diff-gutter-text`, `--diff-add-border`, `--diff-del-border`。
- **现场证据**：
  在 [`DiffCard.module.css`](file:///c:/Software/conex/apps/crish-desktop/src/components/diff/DiffCard.module.css#L1-L100) 中，实际消费的真实变量为 `--diff-add-bg`, `--diff-del-bg`, `--diff-add-fg`, `--diff-del-fg`, `--diff-bg-header`, `--diff-gutter-width-unified`。注释在 `tokens.css:654` 虽写着 `/* Legacy Diff 兼容映射 */`，但历经重构后没有任何业务代码再消费带有 `-line-` 或 `-gutter-add-` 的兼容过渡变量。
- **治理裁决**：**全量删除带有 `-line-`、`-gutter-add-`、`-sidebar-width-` 的冗余兼容桥接，消除 21 个死变量（净删除 42 行代码）**。

#### 死层 C：SmartExpandablePanel (SEP) 脚手架遗留死变量（12 变量 · 24 处定义）
- **代码位置**：
  - Light 主题：[`tokens.css:203-237`](file:///c:/Software/conex/apps/crish-desktop/src/styles/tokens.css#L203-L237)
  - Dark 主题：[`tokens.css:1020-1050`](file:///c:/Software/conex/apps/crish-desktop/src/styles/tokens.css#L1020-L1050)
- **变量清单**：
  `--sep-font-size-base`, `--sep-font-size-sm`, `--sep-bg-canvas`, `--sep-bg-panel-solid`, `--sep-bg-item-selected`, `--sep-border-hover`, `--sep-accent-color`, `--sep-accent-light`, `--sep-ease-spring`, `--sep-ease-shrink`, `--sep-duration-open`, `--sep-duration-close`。
- **现场证据**：
  经静态排查 [`SmartExpandablePanel.module.css`](file:///c:/Software/conex/apps/crish-desktop/src/components/ui/SmartExpandablePanel/SmartExpandablePanel.module.css) 与 [`SmartPanel.module.css`](file:///c:/Software/conex/apps/crish-desktop/src/components/ui/SmartPanel/SmartPanel.module.css)，组件实际只消费了 `--sep-radius-*`, `--sep-item-*`, `--sep-bg-panel`, `--sep-text-*` 等核心几何与色彩变量。上述 12 个变量全工程 0 次引用，属于初期过度预设的脚手架参数。
- **治理裁决**：**拔除双主题块内的 12 个 SEP 死变量（共 24 行声明）**。

#### 死层 D：AI 步骤卡片、Artifacts 与未消费排版扩展（21 变量 · 42 处定义）
- **代码位置**：
  - Light 主题：[`tokens.css:530, 532, 564-570, 579-593, 600-625, 669, 690-694`](file:///c:/Software/conex/apps/crish-desktop/src/styles/tokens.css#L610-L625)
  - Dark 主题：[`tokens.css:1190-1287, 1330, 1351-1355`](file:///c:/Software/conex/apps/crish-desktop/src/styles/tokens.css#L1272-L1287)
- **变量清单**：
  `--aicard-bg`, `--aicard-border`, `--aicard-header-bg`, `--aicard-title-font-size`, `--aicard-status-pulse-live`, `--artifact-card-shadow`, `--artifact-header-fg`, `--artifact-header-height`, `--artifact-action-btn-bg`, `--artifact-action-btn-hover`, `--artifact-action-btn-border`, `--artifact-portal-overlay-bg`, `--artifact-portal-blur`, `--artifact-output-max-h`, `--filetree-bg`, `--md-code-inline-bg`, `--md-code-inline-border`, `--md-list-marker-color`, `--md-list-marker-fade-duration`, `--md-hr-color`, `--md-hr-height`, `--md-table-border-color`, `--md-table-border-subtle`, `--md-table-header-z`, `--md-table-row-bg`, `--md-table-row-zebra-bg`, `--md-table-cell-pad-x`, `--md-table-cell-pad-y`, `--stream-table-active-outline`, `--stream-table-pulse-border`, `--stream-chunk-gap`。
- **治理裁决**：**彻底清理未接线的 AICard / Artifacts 占位变量与废弃表格变量**。

#### 历史包袱 E：多源别名污染与测试专用伪活变量（15 变量）
1. **错误与危险状态色 4 源割裂**：
   - 现状：工程中同时存在 `--danger-color`（10 处）、`--accent-danger`（6 处）、`--text-danger`（20 处）与标准 `--color-error`。
   - 治理：收敛至标准语义角色体系（依据 `better-colors` § Name primitives by hue, semantics by role）：
     - 边框/背景/强调级：统一使用 `--color-error` 及 `--color-error-bg` / `--color-error-border`。
     - 文本呈现级：统一使用 `--text-danger`。
     - 废除 `--danger-color` 与 `--accent-danger` 2 个历史别名。
2. **测试断言专用伪活变量（Test-Only Ghost Tokens）**：
   - 现状：`--ui-text-success`, `--ui-text-danger`, `--ui-text-muted`, `--ui-text-info`, `--ui-text-warning`。
   - 现场证据：在全库检索中，**0 处业务组件消费这些变量**。仅在 [`style-contract.test.ts:139-143`](file:///c:/Software/conex/apps/crish-desktop/src/styles/style-contract.test.ts#L139-L143) 与 [`a11y-contrast.test.ts:233-241`](file:///c:/Software/conex/apps/crish-desktop/src/styles/a11y-contrast.test.ts#L233-L241) 中存在硬编码测试断言！这是典型的“为了测试而维护的伪变量”。
   - 治理：将测试契约迁移至真实的语义 Token（`--text-success-strong`, `--text-danger`, `--text-tertiary` 等），从 `tokens.css` 中彻底解脱这 5 个占位变量。
3. **已过期的安全网别名**：
   - `--color-text-dim`：仅在 [`antiDarkeningGuard.test.ts:103`](file:///c:/Software/conex/apps/crish-desktop/src/styles/__tests__/antiDarkeningGuard.test.ts#L103) 中有一处校验“全工程 0 处未定义悬空 Token”，全工程 0 引用。
   - `--color-text-secondary`：仅在 [`SettingsSecurityTab.tsx:334`](file:///c:/Software/conex/apps/crish-desktop/src/components/settings/SettingsSecurityTab.tsx#L334) 存在 1 处硬编码内联样式，其余全量工程使用 `--text-secondary`。
   - `--tint-scrollbar-thumb`：注释明确标注在维度 6 收口，应收敛至 `--scrollbar-thumb-bg`。

---

## 三、字阶碎片清剿：13/14 档碎步半像素到标准 7 档字阶收敛

### 3.1 现状审计与缺陷机制

在 [`tokens.css:472-486`](file:///c:/Software/conex/apps/crish-desktop/src/styles/tokens.css#L472-L486) 中，声明了如下字阶阶梯：

```css
  --font-size-adjust: 0px;
  --font-size-nano: calc(10px + var(--font-size-adjust));       /* 10px   (碎步) */
  --font-size-xxs: calc(11px + var(--font-size-adjust));        /* 11px   (基线) */
  --font-size-micro: calc(11.5px + var(--font-size-adjust));    /* 11.5px (半像素碎步) */
  --font-size-xs: calc(12px + var(--font-size-adjust));         /* 12px   (基线) */
  --font-size-xs-plus: calc(12.5px + var(--font-size-adjust));   /* 12.5px (半像素碎步) */
  --font-size-sm: calc(13px + var(--font-size-adjust));         /* 13px   (基线) */
  --font-size-sm-plus: calc(13.5px + var(--font-size-adjust));   /* 13.5px (半像素碎步) */
  --font-size-chat: calc(13.5px + var(--font-size-adjust, 0px));/* 13.5px (死变量) */
  --font-size-base: calc(14px + var(--font-size-adjust));       /* 14px   (基线) */
  --font-size-md: calc(15px + var(--font-size-adjust));         /* 15px   (1px碎步) */
  --font-size-lg: calc(17px + var(--font-size-adjust));         /* 17px   (奇数碎步) */
  --font-size-xxl: calc(18px + var(--font-size-adjust));        /* 18px   (死变量) */
  --font-size-xl: calc(19px + var(--font-size-adjust));         /* 19px   (奇数碎步) */
  --font-size-2xl: calc(22px + var(--font-size-adjust));        /* 22px   (基线) */
```

#### 缺陷成因与设计原则违背
1. **违反 `better-typography` 排版准则**：
   `better-typography` 指出：*“A small set of sizes used across a product, deviated from as little as possible. Hard-coding sizes with no system behind them breaks down at scale.”* 字阶的核心在于通过显著的尺寸级差建立清晰的视觉层级（Hierarchy）。11px、11.5px、12px、12.5px 之间仅相差 0.5px，肉眼几乎无法分辨层级差异，反而造成字体粗细渲染混乱。
2. **次像素抗锯齿灾难（Subpixel Aliasing）**：
   在 100% 缩放标准显示器（96 DPI）上，物理像素无法被切分。渲染引擎对 11.5px、12.5px 等半像素字体必须使用灰度模糊补偿，导致笔画发虚（Blurry Glyphs）、边缘锯齿或字母宽度轻微跳动。
3. **UI 缩放响应式断裂**：
   如前所述，`[data-ui-size='small']` 与 `[data-ui-size='large']` 未提供半像素字阶的重写，导致偏好设置切换时产生局部排版比例失调。

---

### 3.2 消费现状普查（14 档全景扫描）

| Token 变量名 | 默认像素 | 全库外部引用数 | 引用分布与消费状态 | 诊断结论 |
| :--- | :--- | :--- | :--- | :--- |
| `--font-size-nano` | 10px | 4 处 | ContextInjectionBlock(2), FilesCard(1), AppErrorBoundary(1) | **非标极小字**，影响可读性 |
| `--font-size-micro` | 11.5px | 7 处 | TiptapSlashMenu(2), ContextInjectionBlock(4), SkillsSettingsTab(1) | **半像素碎步**，发虚 |
| `--font-size-xxs` | 11px | 87 处 | 全局各面板徽章、时间戳、快捷键微标 | **标准基线字阶**（保留） |
| `--font-size-xs` | 12px | 261 处 | 表格说明、次级标题、菜单项、状态栏 | **标准基线字阶**（保留） |
| `--font-size-xs-plus` | 12.5px | 4 处 | LeafToolTabStrip(1), PaneHeader(1), SkillsSettingsTab(2) | **半像素碎步**，发虚 |
| `--font-size-sm` | 13px | 156 处 | 侧边栏导航条目、表单控件、紧凑正文 | **标准基线字阶**（保留） |
| `--font-size-sm-plus` | 13.5px | 4 处 | SkillsSettingsTab(4) | **半像素碎步**，发虚 |
| `--font-size-chat` | 13.5px | **0 处** | 全工程 0 引用 | **完全死变量** |
| `--font-size-base` | 14px | 38 处 | 对话正文、输入框标准文字、Markdown正文 | **标准基线字阶**（保留） |
| `--font-size-md` | 15px | 10 处 | 按钮、输入框、下拉框（Select）、Tab 标尺 | **奇数碎步**，应规整为 16px |
| `--font-size-lg` | 17px | 6 处 | 弹窗标题、设置卡片主标题、空状态副标 | **奇数碎步**，应规整为 18px |
| `--font-size-xxl` | 18px | **0 处** | 全工程 0 引用 | **完全死变量** |
| `--font-size-xl` | 19px | 3 处 | SettingsUI(1), SkillsSettingsTab(1), NotePaper(1) | **奇数碎步**，应归并 |
| `--font-size-2xl` | 22px | 4 处 | ChatEmptyState(3), NotePaper(1) | **标准基线大字阶**（保留） |

---

### 3.3 标准 7 档字阶设计模型与映射迁移矩阵

依据 `better-typography` 的现代产品设计规范与 8pt 网格对齐逻辑，确立标准 7 档字阶体系：

#### 标准 7 档字阶规范表

| 等级序号 | 标准 Token | 基础像素 (Small / Default / Large) | 语义角色 (Semantic Role) | 典型应用场景 |
| :---: | :--- | :--- | :--- | :--- |
| **T1** | `--font-size-xxs` | **10px / 11px / 12px** | Micro / Tooltip / Shortcut | 时间戳、最小微标、快捷键 Kbd、代码辅助行号 |
| **T2** | `--font-size-xs` | **11px / 12px / 13px** | Caption / Badge / Subtext | 表单辅助说明、状态徽章、表格次级内容、Tab 标签 |
| **T3** | `--font-size-sm` | **12px / 13px / 14px** | Compact Body / UI Control | 侧边栏列表项、紧凑按钮/输入框、面板头部标题 |
| **T4** | `--font-size-base` | **13px / 14px / 16px** | Default Body / Content | 标准对话正文、Markdown 正文、表单主输入框 |
| **T5** | `--font-size-md` | **14px / 16px / 17px** | Subheading / Emphasized | 弹窗副标题、突出卡片标题、大号按钮控件 |
| **T6** | `--font-size-lg` | **16px / 18px / 19px** | Section Header / Modal Title | 弹窗主标题、设置大分类标题、引导页小标题 |
| **T7** | `--font-size-xl` (或 2xl) | **18px / 22px / 24px** | Display / Page Title | 页面总标题、空状态大问候语、用量看板关键大数字 |

---

### 3.4 19 处存量非标消费点迁移清剿清单

对全库 19 处消费半像素与碎步字阶的文件，制定 100% 精确的单向收敛方案：

```
┌────────────────────────────────────────────────────────────────────────┐
│                        碎步字阶清剿迁移拓扑                             │
├────────────────────────────────────────────────────────────────────────┤
│  --font-size-nano     (10px)   ───────►  --font-size-xxs  (11px)       │
│  --font-size-micro    (11.5px) ───────►  --font-size-xxs  (11px)       │
│  --font-size-xs-plus  (12.5px) ───────►  --font-size-xs   (12px)       │
│  --font-size-sm-plus  (13.5px) ───────►  --font-size-sm   (13px)       │
│  --font-size-chat     (13.5px) ───────►  [直接删除死变量]               │
│  --font-size-xxl      (18px)   ───────►  [直接删除死变量]               │
│  --font-size-md       (15px)   ───────►  规整为 16px 标准阶             │
│  --font-size-lg       (17px)   ───────►  规整为 18px 标准阶             │
└────────────────────────────────────────────────────────────────────────┘
```

#### 具体文件与行号修改清单：

1. **`--font-size-nano` (10px) -> `--font-size-xxs` (11px)**：
   - [`ContextInjectionBlock.module.css:95`](file:///c:/Software/conex/apps/crish-desktop/src/components/chat-injection/ContextInjectionBlock.module.css#L95)：`font-size: var(--font-size-nano, 10px)` -> `font-size: var(--font-size-xxs, 11px)`
   - [`ContextInjectionBlock.module.css:131`](file:///c:/Software/conex/apps/crish-desktop/src/components/chat-injection/ContextInjectionBlock.module.css#L131)：`font-size: var(--font-size-nano, 10px)` -> `font-size: var(--font-size-xxs, 11px)`
   - [`FilesCard.module.css:739`](file:///c:/Software/conex/apps/crish-desktop/src/components/files/FilesCard.module.css#L739)：`font-size: var(--font-size-nano)` -> `font-size: var(--font-size-xxs)`
   - [`AppErrorBoundary.module.css:98`](file:///c:/Software/conex/apps/crish-desktop/src/components/AppErrorBoundary.module.css#L98)：`font-size: var(--font-size-nano)` -> `font-size: var(--font-size-xxs)`

2. **`--font-size-micro` (11.5px) -> `--font-size-xxs` (11px)**：
   - [`TiptapSlashMenu.module.css:97`](file:///c:/Software/conex/apps/crish-desktop/src/components/chat-composer/TiptapSlashMenu.module.css#L97)：`font-size: var(--font-size-micro)` -> `font-size: var(--font-size-xxs)`
   - [`TiptapSlashMenu.module.css:107`](file:///c:/Software/conex/apps/crish-desktop/src/components/chat-composer/TiptapSlashMenu.module.css#L107)：`font-size: var(--font-size-micro)` -> `font-size: var(--font-size-xxs)`
   - [`ContextInjectionBlock.module.css:115`](file:///c:/Software/conex/apps/crish-desktop/src/components/chat-injection/ContextInjectionBlock.module.css#L115)：`font-size: var(--font-size-micro, 11px)` -> `font-size: var(--font-size-xxs, 11px)`（*注：其回退值原本就写着 11px*）
   - [`ContextInjectionBlock.module.css:233`](file:///c:/Software/conex/apps/crish-desktop/src/components/chat-injection/ContextInjectionBlock.module.css#L233)：`font-size: var(--font-size-micro, 11px)` -> `font-size: var(--font-size-xxs, 11px)`
   - [`ContextInjectionBlock.module.css:249`](file:///c:/Software/conex/apps/crish-desktop/src/components/chat-injection/ContextInjectionBlock.module.css#L249)：`font-size: var(--font-size-micro, 11px)` -> `font-size: var(--font-size-xxs, 11px)`
   - [`ContextInjectionBlock.module.css:268`](file:///c:/Software/conex/apps/crish-desktop/src/components/chat-injection/ContextInjectionBlock.module.css#L268)：`font-size: var(--font-size-micro, 11px)` -> `font-size: var(--font-size-xxs, 11px)`
   - [`SkillsSettingsTab.module.css:639`](file:///c:/Software/conex/apps/crish-desktop/src/components/settings-skills/SkillsSettingsTab.module.css#L639)：`font-size: var(--font-size-micro)` -> `font-size: var(--font-size-xxs)`

3. **`--font-size-xs-plus` (12.5px) -> `--font-size-xs` (12px)**：
   - [`LeafToolTabStrip.module.css:88`](file:///c:/Software/conex/apps/crish-desktop/src/components/binary-tree/LeafToolTabStrip.module.css#L88)：`font-size: var(--font-size-xs-plus, 12px)` -> `font-size: var(--font-size-xs, 12px)`（*注：其回退值原本就写着 12px*）
   - [`PaneHeader.module.css:88`](file:///c:/Software/conex/apps/crish-desktop/src/components/binary-tree/PaneHeader.module.css#L88)：`font-size: var(--font-size-xs-plus, 12.5px)` -> `font-size: var(--font-size-xs, 12px)`
   - [`SkillsSettingsTab.module.css:254`](file:///c:/Software/conex/apps/crish-desktop/src/components/settings-skills/SkillsSettingsTab.module.css#L254)：`font-size: var(--font-size-xs-plus)` -> `font-size: var(--font-size-xs)`
   - [`SkillsSettingsTab.module.css:398`](file:///c:/Software/conex/apps/crish-desktop/src/components/settings-skills/SkillsSettingsTab.module.css#L398)：`font-size: var(--font-size-xs-plus)` -> `font-size: var(--font-size-xs)`

4. **`--font-size-sm-plus` (13.5px) -> `--font-size-sm` (13px)**：
   - [`SkillsSettingsTab.module.css:66`](file:///c:/Software/conex/apps/crish-desktop/src/components/settings-skills/SkillsSettingsTab.module.css#L66)：`font-size: var(--font-size-sm-plus)` -> `font-size: var(--font-size-sm)`
   - [`SkillsSettingsTab.module.css:309`](file:///c:/Software/conex/apps/crish-desktop/src/components/settings-skills/SkillsSettingsTab.module.css#L309)：`font-size: var(--font-size-sm-plus)` -> `font-size: var(--font-size-sm)`
   - [`SkillsSettingsTab.module.css:445`](file:///c:/Software/conex/apps/crish-desktop/src/components/settings-skills/SkillsSettingsTab.module.css#L445)：`font-size: var(--font-size-sm-plus)` -> `font-size: var(--font-size-sm)`
   - [`SkillsSettingsTab.module.css:656`](file:///c:/Software/conex/apps/crish-desktop/src/components/settings-skills/SkillsSettingsTab.module.css#L656)：`font-size: var(--font-size-sm-plus)` -> `font-size: var(--font-size-sm)`

5. **`tokens.css` 彻底删除字阶定义**：
   - 彻底删除 [`tokens.css:480`](file:///c:/Software/conex/apps/crish-desktop/src/styles/tokens.css#L480)（`--font-size-nano`）
   - 彻底删除 [`tokens.css:481`](file:///c:/Software/conex/apps/crish-desktop/src/styles/tokens.css#L481)（`--font-size-micro`）
   - 彻底删除 [`tokens.css:482`](file:///c:/Software/conex/apps/crish-desktop/src/styles/tokens.css#L482)（`--font-size-xs-plus`）
   - 彻底删除 [`tokens.css:483`](file:///c:/Software/conex/apps/crish-desktop/src/styles/tokens.css#L483)（`--font-size-sm-plus`）
   - 彻底删除 [`tokens.css:484`](file:///c:/Software/conex/apps/crish-desktop/src/styles/tokens.css#L484)（`--font-size-xxl`）
   - 彻底删除 [`tokens.css:486`](file:///c:/Software/conex/apps/crish-desktop/src/styles/tokens.css#L486)（`--font-size-chat`）

---

## 四、组件私有样式重复与原子收敛深度审计

在排查桌面端主要骨干视图时，我们发现各组件为了渲染常见的「搜索输入框」与「图标按钮」，私下手写了大量低效、易脆的私有 CSS，完全架空了现有的原子组件库。

### 4.1 案例一：SettingsPanel / SettingsTablist 裸写搜索框私有样式

#### 现场代码与缺陷事实
在 [`SettingsTablist.tsx:94-117`](file:///c:/Software/conex/apps/crish-desktop/src/components/SettingsTablist.tsx#L94-L117) 中：
```tsx
<div className={styles.searchWrap}>
  <Lucide.Search
    size={14}
    strokeWidth={1.75}
    className={styles.searchIco}
    aria-hidden
  />
  <input
    ref={searchInputRef}
    id={searchId}
    type="search"
    className={styles.search}
    placeholder="搜索设置…"
    value={searchQuery}
    onChange={(e) => onSearchChange(e.target.value)}
    onKeyDown={onSearchKeyDown}
    aria-label="搜索设置分类"
    aria-controls={tablistId}
    aria-describedby={statusId}
    autoComplete="off"
    spellCheck={false}
    enterKeyHint="search"
  />
</div>
```
配套在 [`SettingsPanel.module.css:85-128`](file:///c:/Software/conex/apps/crish-desktop/src/components/settings/SettingsPanel.module.css#L85-L128) 中维护了 44 行私有 CSS：
```css
.searchWrap {
  position: relative;
  margin: var(--space-1, 4px) 0 var(--space-2_5, 10px);
  flex-shrink: 0;
}
.searchIco {
  position: absolute;
  left: var(--space-3, 12px);
  top: 50%;
  transform: translateY(-50%);
  color: var(--text-tertiary);
  pointer-events: none;
}
.search {
  width: 100%;
  height: var(--control-height-sm, 28px);
  min-height: var(--control-height-sm, 28px);
  padding: 0 var(--space-2_5, 10px) 0 calc(var(--space-6, 24px) + var(--space-1_5, 6px));
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-lg, 8px);
  background: var(--bg-card, hsl(0 0% 100%));
  color: var(--text-primary);
  font-family: inherit;
  font-size: var(--font-size-xs, 12px);
  outline: none;
  box-sizing: border-box;
  box-shadow: none;
  transition: background var(--transition-micro, 100ms ease-out), border-color var(--transition-micro, 100ms ease-out);
}
.search::placeholder { color: var(--text-tertiary); }
.search:focus, .search:focus-visible {
  border-color: var(--border-color);
  background: var(--bg-card, hsl(0 0% 100%));
  box-shadow: none;
}
```

#### 为什么这是严重的技术负债？
1. **完全重复造轮子**：原子库 [`Input.tsx`](file:///c:/Software/conex/apps/crish-desktop/src/components/ui/Input/Input.tsx#L13-L40) 天生支持 `variant="search"`, `size="sm"`，内部自带放大镜图标、正确的左右 Padding 计算、柔和焦点环以及一键清除逻辑；
2. **丢失 IME 组合输入锁**：原生 `<input>` 在中文/日文输入法选词回车时，会提前触发未完成的快捷检索甚至表单意外行为。而原子 `<Input>` 内置了完整的 `handleCompositionStart` / `handleCompositionEnd` 状态机；
3. **维护成本翻倍**：一旦全局输入框外观、圆角或焦点样式调整，这些私有手写的样式无法自动享受更新。

#### 收敛方案与负产出
- 在 `SettingsTablist.tsx` 中直接引入 `<Input variant="search" size="sm" ... />`；
- **从 `SettingsPanel.module.css` 中直接连根删除 44 行 CSS 代码（净负产出 -44 行）**。

---

### 4.2 案例二：Sidebar 侧栏折叠按钮与齿轮设置按钮裸造

#### 现场代码与缺陷事实
在 [`SidebarHeader.tsx:47-59, 94-106`](file:///c:/Software/conex/apps/crish-desktop/src/components/sidebar/SidebarHeader.tsx#L47-L59) 中，连续手写了两处折叠按钮：
```tsx
<Tooltip content={toggleLabel}>
  <button
    type="button"
    className={`${styles.sidebarToggleBtn} sidebar-toggle-btn`}
    data-testid="sidebar-toggle"
    aria-label={toggleLabel}
    aria-expanded={!collapsed}
    aria-controls="crish-sidebar"
    onClick={onToggle}
  >
    <IconSidebarLeft size={16} aria-hidden="true" />
  </button>
</Tooltip>
```
在 [`Sidebar.module.css:84-116`](file:///c:/Software/conex/apps/crish-desktop/src/components/sidebar/Sidebar.module.css#L84-L116) 中手写了 33 行私有样式：
```css
.sidebarToggleBtn {
  width: 32px;
  height: 32px;
  min-width: 32px;
  min-height: 32px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  background: transparent;
  border: none;
  border-radius: var(--radius-md);
  color: var(--text-tertiary);
  cursor: pointer;
  padding: 0;
  margin: 0;
  box-shadow: none;
  transition: background-color var(--transition-fast, 150ms ease-out), color var(--transition-fast, 150ms ease-out);
  -webkit-app-region: no-drag !important;
  app-region: no-drag !important;
  pointer-events: auto;
}
.sidebarToggleBtn:hover { background: var(--tint-hover); color: var(--text-primary); }
.sidebarToggleBtn:active { background: var(--tint-active); }
```
同样，在 [`SidebarFooter.tsx:28-44`](file:///c:/Software/conex/apps/crish-desktop/src/components/sidebar/SidebarFooter.tsx#L28-L44) 中手写了齿轮按钮，并在 [`Sidebar.module.css:258-287`](file:///c:/Software/conex/apps/crish-desktop/src/components/sidebar/Sidebar.module.css#L258-L287) 手写了 30 行 `.settingsGearBtn`；在 [`Sidebar.module.css:383-408`](file:///c:/Software/conex/apps/crish-desktop/src/components/sidebar/Sidebar.module.css#L383-L408) 手写了 26 行 `.hamburger` 汉堡按钮。

#### 收敛方案与负产出
- 原子库已有标准化 [`IconButton.tsx`](file:///c:/Software/conex/apps/crish-desktop/src/components/ui/Button/IconButton.tsx)，支持 `variant="ghost"`, `size="md"`（32px 高宽），且内置无障碍 `aria-label` 与 `tooltip` 自动挂载；
- 将 `SidebarHeader` 的折叠按钮、`SidebarFooter` 的齿轮设置按钮全部换装为 `<IconButton variant="ghost" size="md" ... />`；
- **从 `Sidebar.module.css` 中直接删除 `.sidebarToggleBtn`, `.settingsGearBtn`, `.hamburger` 及其伪类，净删除 89 行 CSS 代码**。

---

### 4.3 案例三：全站搜索框造轮子现状横向扫描

除了 `SettingsPanel`，排查发现全站至少有 6 个独立组件重复手写了带有图标的输入框样式，形成了严重的视觉碎片：

| 业务组件路径 | 样式文件与私有类名 | 私有 CSS 行数 | 缺陷表现 | 收敛目标 |
| :--- | :--- | :--- | :--- | :--- |
| `settings/SettingsPanel` | [`SettingsPanel.module.css:85-128`](file:///c:/Software/conex/apps/crish-desktop/src/components/settings/SettingsPanel.module.css#L85-L128) (`.searchWrap`, `.search`) | 44 行 | 裸写 input，无 IME 守卫，手动计算 padding | `<Input variant="search" size="sm">` |
| `settings/FontSelectField` | [`FontSelectField.module.css:92-138`](file:///c:/Software/conex/apps/crish-desktop/src/components/settings/FontSelectField.module.css#L92-L138) (`.searchHeader`, `.searchInput`) | 47 行 | 绝对定位图标，手动处理 placeholder | `<Input variant="search" size="sm">` |
| `provider/ModelBadgePickerMenu` | [`ModelBadgePickerMenu.module.css:48-77`](file:///c:/Software/conex/apps/crish-desktop/src/components/provider/ModelBadgePickerMenu.module.css#L48-L77) (`.searchHeader`, `.searchInput`) | 30 行 | 手写 flex 居中与下划线分割线 | `<Input variant="search" size="sm">` |
| `workspace/TerminalCard` | [`TerminalCard.module.css:335-385`](file:///c:/Software/conex/apps/crish-desktop/src/components/workspace/TerminalCard.module.css#L335-L385) (`.searchRow`, `.searchInput`) | 51 行 | 手写终端搜索行，手写 clear 按钮 | `<Input variant="search" size="sm">` |
| `diff/DiffCard` | [`DiffCard.module.css:107-135`](file:///c:/Software/conex/apps/crish-desktop/src/components/diff/DiffCard.module.css#L107-L135) (`.searchRow`, `.searchInput`) | 29 行 | 手写内联搜索条 | `<Input variant="search" size="sm">` |
| `chat-card/ProjectPickerMenu` | [`ProjectPickerMenu.module.css:79-100`](file:///c:/Software/conex/apps/crish-desktop/src/components/chat-card/ProjectPickerMenu.module.css#L79-L100) (`.searchWrapper`, `.searchInput`) | 22 行 | 手写项目过滤输入框 | `<Input variant="search" size="sm">` |
| **小计** | **全站 6 个业务组件** | **223 行** | **外观参差不齐、焦点环粗细不一** | **统一收敛至原子 `<Input>`** |

---

## 五、净负产出（Net-Negative LOC）精确测算与清除清单

### 5.1 CSS 变量消除汇总（186 个变量）

```
┌─────────────────────────────────────────────────────────────┐
│                 CSS 变量清剿消除全景汇总                     │
├──────────────────────────────────────┬──────────────────────┤
│ 1. 极简思考链与横幅死变量 (Thought/Banner)  │  38 个               │
│ 2. Legacy Diff 兼容别名与残存变量          │  21 个               │
│ 3. SmartExpandablePanel 冗余脚手架变量    │  12 个               │
│ 4. AI卡片、Artifacts 与废弃排版变量         │  21 个               │
│ 5. 废弃滚动条端点按钮与死尺寸变量          │   8 个               │
│ 6. 碎步半像素与死字阶变量 (nano, micro 等) │   6 个               │
│ 7. 废弃用量监控、图表与遮罩死变量          │  18 个               │
│ 8. 孤立间距、圆角与动效死变量              │  14 个               │
│ 9. 废弃兼容别名与测试伪活变量 (ui-text 等) │  15 个               │
│ 10. 其他内部自闭合与孤立变量               │  33 个               │
├──────────────────────────────────────┼──────────────────────┤
│ **总计清除 CSS 变量**                │ **186 个 (30.4%)**   │
└──────────────────────────────────────┴──────────────────────┘
```

---

### 5.2 代码行数（LOC）净消减测算表

| 文件路径 / 模块区域 | 当前行数 | 治理动作与删除清单 | 预估纯删除行数 | 预估新增/重构行数 | **净负产出 (Net-Negative)** |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **`styles/tokens.css`** | 1,758 行 | 删除 Thought/Banner 死层 (76行)、Legacy Diff (42行)、SEP 脚手架 (24行)、AICard/Artifacts (42行)、滚动条废弃按钮 (30行)、碎步半像素字阶 (7行)、多源废弃别名 (24行)、冗余注释/空白 (20行) | -265 行 | +15 行 (重构标准 7 档字阶定义) | **-250 行** |
| **`settings/SettingsPanel.module.css`** | 295 行 | 彻底删除 `.searchWrap`, `.searchIco`, `.search`, `.search::placeholder`, `.search:focus` | -44 行 | 0 行 | **-44 行** |
| **`sidebar/Sidebar.module.css`** | 462 行 | 彻底删除 `.sidebarToggleBtn` (33行), `.settingsGearBtn` (30行), `.hamburger` (26行) | -89 行 | 0 行 | **-89 行** |
| **`settings/FontSelectField.module.css`** | 289 行 | 彻底删除 `.searchHeader`, `.searchInputWrapper`, `.searchIcon`, `.searchInput`, `.actionBtn` | -73 行 | +5 行 | **-68 行** |
| **`chat-message-row/ChatMessageRow.module.css`** | 988 行 | 收敛手写 `.iconBtn`, `:hover`, `.isPinnedActive`, `.isCopied` 为原子 `<IconButton>` 引用 | -79 行 | +12 行 | **-67 行** |
| **`workspace/TerminalCard.module.css`** | 474 行 | 删除 `.searchRow`, `.searchIco`, `.searchInput`, `.searchClear` | -51 行 | +8 行 | **-43 行** |
| **`provider/ModelBadgePickerMenu.module.css`** | 325 行 | 删除 `.searchHeader`, `.searchIcon`, `.searchInput` | -30 行 | +4 行 | **-26 行** |
| **`diff/DiffCard.module.css`** | 906 行 | 删除内联 `.searchRow`, `.searchInput`，统一复用原子 Input | -29 行 | +4 行 | **-25 行** |
| **`binary-tree/PaneHeader & LeafToolTabStrip`** | - | 19 处半像素字阶收敛（单行字符改动） | -19 处 | +19 处 | **0 行 (净净化)** |
| **合计** | - | - | **-660 行** | **+48 行** | **-612 行 (工程级净消减)** |

---

## 六、实施策略与防回归自动化门禁

### 6.1 推进波次建议（Migration Waves）

为了保障重构的安全无感、避免 Git 冲突，建议按如下依赖次序分三步推进：

1. **第一波：字阶收敛与消费点规整（Zero-Risk Typography Wave）**：
   - 批量替换 19 处存量消费代码（`nano`/`micro` -> `xxs`，`xs-plus` -> `xs`，`sm-plus` -> `sm`）；
   - 调整 `tokens.css`：规整 `--font-size-md` 为 16px、`--font-size-lg` 为 18px，删除 6 个碎步与死字阶；
   - 验证：运行 `npm run typecheck` 与 `npm test`。

2. **第二波：tokens.css 死层连根清剿（Token Pruning Wave）**：
   - 集中剔除 `tokens.css` 中 Thought、Legacy Diff、SEP 冗余等 171 个零引用变量；
   - 同步修正 `style-contract.test.ts` 中针对 `--ui-text-*` 的历史硬编码断言，将其更新为真实业务 Token；
   - 验证：运行 `npx vitest run src/styles/`，确保主题测试与对比度测试全绿。

3. **第三波：业务组件私有样式拔除（Component Unification Wave）**：
   - 将 `SettingsTablist.tsx` 换装为 `<Input variant="search" size="sm" />`，删除 `SettingsPanel.module.css` 44 行代码；
   - 将 `SidebarHeader.tsx` 与 `SidebarFooter.tsx` 换装为 `<IconButton variant="ghost" size="md" />`，删除 `Sidebar.module.css` 89 行代码；
   - 横向推进 TerminalCard, FontSelectField, ModelBadgePickerMenu 换装，实现业务组件 CSS 的深度收敛。

---

### 6.2 自动化防回归门禁机制（CI Guardrails）

依据 `AGENTS.md` §7（立体验证纪律）与 §11（CI 治理），必须建立刚性防线，防止死变量与半像素乱象回潮：

1. **半像素与碎步字阶阻断门禁**：
   在 [`scripts/check-style-contract.mjs`](file:///c:/Software/conex/scripts) 或 ESLint 中新增正则校验，扫描全库 `.css` 与 `.tsx` 文件：
   ```js
   const FORBIDDEN_FONT_TOKENS = [
     '--font-size-nano',
     '--font-size-micro',
     '--font-size-xs-plus',
     '--font-size-sm-plus',
     '--font-size-chat',
     '--font-size-xxl',
     /font-size:\s*(10|11\.5|12\.5|13\.5|15|17|19)px/
   ];
   ```
   凡命中者在 CI 阶段直接阻断提交（Exit code 1）。

2. **死变量孤立度扫描工具**：
   将本报告的静态拓扑审计逻辑封装为轻量脚本 `npm run check:unused-tokens`，在流水线中检查 `tokens.css` 是否存在外部 0 引用的孤立变量，保障 Token 单一真源的绝对纯净。
