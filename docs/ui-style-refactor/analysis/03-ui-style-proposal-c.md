# Conex / Crish 界面视觉修复与差异面板重构战役方案（提案 C）

> **方案版本**：v1.0.0 · 独立编制架构提案 C
> **编制依据**：
> - `docs/ui-style-refactor/audits/01-theme-flash-and-fouc-audit.md` (首屏闪色与 FOUC 根因)
> - `docs/ui-style-refactor/audits/02-diff-panel-layout-and-style-audit.md` (差异面板 18 项全链路缺陷)
> - `docs/ui-style-refactor/audits/03-small-elements-darkening-and-borders-audit.md` (小元素发黑与重边框根因)
> - `docs/ui-style-refactor/audits/04-tokens-inheritance-and-conflicts-audit.md` (Token 继承链与双源冲突)
> - `docs/ui-style-refactor/audits/05-runtime-cascading-and-visual-compliance-audit.md` (级联污染与视觉合规性)
> - 《主控全流程调度 v3》§一.4、[`AGENTS.md`](file:///c:/Software/conex/AGENTS.md) §12/§13/§14、`ANTI_OVERENGINEERING_GUARDRAILS.md`
>
> **核心哲学**：**先删后改（Deletion First）、单一真源（SSOT）、0ms 零闪烁（Zero-FOUC）、柔和克制（Soft Elegance）**。

---

## 目录

1. [执行摘要与提案 C 架构定位](#一执行摘要与提案-c-架构定位)
2. [重构领域核心概念划分（5 大维度）](#二重构领域核心概念划分5-大维度)
   - [维度一：首屏 0ms 零闪烁平滑启动与主题/调色板单源化](#21-维度一首屏-0ms-零闪烁平滑启动与主题调色板单源化)
   - [维度二：全局活态 Token 纠偏与微小元素脱黑修整](#22-维度二全局活态-token-纠偏与微小元素脱黑修整)
   - [维度三：差异比对面板容器到原子元素全链路重构](#23-维度三差异比对面板容器到原子元素全链路重构)
   - [维度四：选择器级联污染清剿与 CSS Modules 边界绝缘](#24-维度四选择器级联污染清剿与-css-modules-边界绝缘)
   - [维度五：Token 继承链归一化、悬空/幽灵 Token 拔除与 Zero-Blue 铁律遵循](#25-维度五token-继承链归一化悬空幽灵-token-拔除与-zero-blue-铁律遵循)
3. [【核心】死层、硬编码与粗黑样式删除面清单（Deletion Surface Matrix）](#三核心死层硬编码与粗黑样式删除面清单deletion-surface-matrix)
   - [3.1 必须删除/清除的硬编码死黑底与实心黑填充（7 类）](#31-必须删除清除的硬编码死黑底与实心黑填充7-类)
   - [3.2 必须删除的超标粗黑边框、硬实线与刺目焦圈（6 类）](#32-必须删除的超标粗黑边框硬实线与刺目焦圈6-类)
   - [3.3 必须删除的厚重深黑 Box-Shadow 与微小浮层光晕（3 类）](#33-必须删除的厚重深黑-box-shadow-与微小浮层光晕3-类)
   - [3.4 必须删除的硬编码固定高度、过渡补间与滚动陷阱（4 类）](#34-必须删除的硬编码固定高度过渡补间与滚动陷阱4-类)
   - [3.5 必须删除的死代码、冗余样式与 `!important` 提权对抗（3 类）](#35-必须删除的死代码冗余样式与-important-提权对抗3-类)
   - [3.6 必须删除的私有选择器泄漏、模糊匹配与主题硬编码（4 类）](#36-必须删除的私有选择器泄漏模糊匹配与主题硬编码4-类)
   - [3.7 必须删除的悬空/幽灵 Token 与 Zero-Blue 违规色相（3 类）](#37-必须删除的悬空幽灵-token-与-zero-blue-违规色相3-类)
4. [先删后改：技术依赖拓扑与 DAG 执行路径](#四先删后改技术依赖拓扑与-dag-执行路径)
   - [4.1 DAG 拓扑图与阶段演进](#41-dag-拓扑图与阶段演进)
   - [4.2 阶段执行详规（Phase 0 ~ Phase 6）](#42-阶段执行详规phase-0--phase-6)
5. [重构实施映射表与代码文件修改面](#五重构实施映射表与代码文件修改面)
6. [战役硬性验收断言与防护门禁](#六战役硬性验收断言与防护门禁)

---

## 一、执行摘要与提案 C 架构定位

在过去多轮功能迭代与局部修补中，Conex / Crish 桌面端逐渐累积了严重的**视觉退化（Visual Degradation）、小元素发黑（Darkening）、首屏闪色（FOUC）、差异面板不可读（Diff Degradation）以及样式特异性军备竞赛（Cascade Pollution）**。

提案 C 从系统工程视角出发，拒绝“头痛医头”的局部覆盖，确立以**“先删后改、单源收敛、彻底绝缘”**为核心指导方针的彻底重构战役：

```
┌──────────────────────────────────────────────────────────────────────────────────────────────────┐
│                                   提案 C 核心架构治理拓扑                                        │
├──────────────────────────────────────────────────────────────────────────────────────────────────┤
│                                                                                                  │
│  [1. 删除面大清剿] ──> 剔除 380px 锁死、#111 裸黑、300ms 补间、55处暗色硬写、300+行死代码、26处穿透     │
│         │                                                                                        │
│         ▼                                                                                        │
│  [2. 单真源基座]   ──> tokens.css 与 themePresets.ts 100% 对齐，OKLCH 守卫改非侵入式，断点归一     │
│         │                                                                                        │
│         ▼                                                                                        │
│  [3. 0ms 零闪启动] ──> <head> 同步注入种子 + 初始 .preload 门闩冻结过渡 + main.tsx 同步 bootstrap   │
│         │                                                                                        │
│         ▼                                                                                        │
│  [4. 活态去黑纠偏] ──> --accent-color 归位翡翠绿/温和墨阶，按 AGENTS.md §13 严格约束边框 ≤10%    │
│         │                                                                                        │
│         ▼                                                                                        │
│  [5. 差异面板重塑] ──> 真实语言高亮 + 占位对齐 Split + 纯白卡片底板 + 弹性视口 + 滚轮穿透畅通     │
│         │                                                                                        │
│         ▼                                                                                        │
│  [6. 级联绝缘闭环] ──> 移除纯全局 :global，采用 Data Attribute 状态驱动，9 处原生 title 胶囊化     │
│                                                                                                  │
└──────────────────────────────────────────────────────────────────────────────────────────────────┘
```

---

## 二、重构领域核心概念划分（5 大维度）

根据五份专项审计报告所揭示的根本原因，将本次战役划分为 **5 个边界清晰、正交高内聚的核心重构领域**：

### 2.1 维度一：首屏 0ms 零闪烁平滑启动与主题/调色板单源化

*彻底根治 FOUC（Flash of Unstyled Color / Content）、消除多阶段阶梯式变色、实现首帧即终态。*

#### 核心治理任务：
1. **种子执行阻塞化与前置**：
   - 将 [`apps/crish-desktop/index.html`](file:///c:/Software/conex/apps/crish-desktop/index.html) 中的 `<script src="/loader.js" defer></script>` 移除 `defer`（或将核心种子内联至 `<head>` 最顶端）；
   - 在解析到 `<body>` 之前（T = 0ms），同步读取 `localStorage`（`crish_theme` 与 `crish_theme_skin`），并在 `documentElement` 上同步挂载 `data-theme` 属性与核心背景/文字 inline style；
2. **剔除 Loader 强制过渡动画与深浅反差**：
   - 清除 [`apps/crish-desktop/public/loader.css`](file:///c:/Software/conex/apps/crish-desktop/public/loader.css) 中 `.app-initial-loader` 的 `transition: background-color 0.3s ease;`；
   - 将 `:root` 变量从深色 `#0b0b0e` 重构为自适应中性安全色；
3. **冷启动 `.preload` 全局过渡门闩**：
   - 种子脚本在 `<html>` 默认打上 `class="preload"`（`transition: none !important; animation-duration: 0s !important;`）；
   - 在 [`apps/crish-desktop/src/main.tsx`](file:///c:/Software/conex/apps/crish-desktop/src/main.tsx) 首渲染完成打点（或首帧 `requestAnimationFrame`）后移除 `.preload`，解冻微交互过渡；
4. **生命周期前移与冗余调用剥离**：
   - 将 `bootstrapTheme()` 从 [`AppBootstrap.ts`](file:///c:/Software/conex/apps/crish-desktop/src/app/AppBootstrap.ts) 的异步 `useEffect` 移入 `main.tsx` 顶层同步执行区间；
   - 彻底删除 [`bootstrap-full.ts`](file:///c:/Software/conex/apps/crish-desktop/src/bootstrap-full.ts) 中 `requestIdleCallback` 重复调用的 `applyTheme()`；
5. **对比度守卫（OKLCH Color Guard）非侵入式改造**：
   - 重构 [`oklchColorGuard.ts`](file:///c:/Software/conex/apps/crish-desktop/src/api/oklchColorGuard.ts)，仅在预设配色对比度不足（CR < 4.5:1）或用户自定义极端色时介入微调，官方合规预设保持静默，严禁无差别碾碎皮肤文字色。

---

### 2.2 维度二：全局活态 Token 纠偏与微小元素脱黑修整

*纠偏 `--accent-color` 语义异化，全面清除小元素死黑，边框与焦点态 100% 对齐 `AGENTS.md` §13。*

#### 核心治理任务：
1. **`--accent-color` 活态语义纠偏**：
   - 将 [`tokens.css`](file:///c:/Software/conex/apps/crish-desktop/src/styles/tokens.css) 中的 `--accent-color: hsl(35, 16%, 15%)`（15% 近黑墨阶）修正为具有品牌活态特征的翡翠绿签名色 `hsl(160 84% 36%)`（深色态为 `hsl(160 70% 45%)`），或将活态控件重定向消费 `--brand`；
2. **全界面 6 大核心小控件脱黑**：
   - **Button / IconButton**：Primary 变体背景纠偏为 `--brand`（`#10b981`），文字为 `#ffffff`，消除 `#2c2824` 死黑块；
   - **Switch**：开启态轨道背景纠偏为 `--brand`，边框纠偏为 `--brand-deep`（`#059669`）；
   - **Badge / Chip**：Brand 徽标脱黑，背景使用 `color-mix(in srgb, var(--brand) 10%, transparent)`，文字为 `--brand-deep`；
   - **Slider**：填充轨道与滑块小圆点描边脱黑，使用 `--brand` 代替 `--accent-color`；
   - **Tooltip**：圆角采用胶囊型 `var(--radius-full, 9999px)`，阴影从 4 层 48px 巨型光晕 `var(--shadow-lg)` 减负为柔和单层 `var(--shadow-sm)`；
   - **Menu**：深色模式阴影剔除 `rgba(0, 0, 0, 0.70)` 浓黑污晕，收敛至标准 `--shadow-dropdown`；
3. **聊天消息流正文脱黑与底色归位**：
   - **行内代码（Inline Code）**：底色归位至卡片纯白基底 `color-mix(in srgb, var(--text-primary) 3.5%, var(--bg-card))`，消除外层暗灰导致的膏药补丁感；
   - **引用块（Blockquote）**：边框加深压低至 8%（`color-mix(in srgb, var(--border-color) 92%, var(--text-primary) 8%)`），宽度收敛为 2px，彻底废除 20% 加深与 3px 粗黑线；
   - **思考链导轨（Thought Rail）**：透明度降至 5%~6%，恢复通透空灵感；
4. **审批卡片与状态指示器脱黑**：
   - **审批允许按钮（Allow Action）**：废除裸写 `background: var(--text-primary)`（`#111111`），升级为醒目优雅的 `--brand-deep` 实色按钮；
   - **ToolGroup / Live Indicator**：竖线混入比例降至 40% `--brand`，呼吸脉冲点脱黑为 `--brand`；
   - **子代理状态徽标（Subagent Badge）**：废除非激活态倾倒 `--bg-tertiary`（`#e2e5e8`）泥斑，改用柔和微透明底色。

---

### 2.3 维度三：差异比对面板容器到原子元素全链路重构

*恢复 100% 语法高亮、对齐 Split 视图、弹性响应式容器、纯白卡片底板、打通三库合一。*

#### 核心治理任务：
1. **语法高亮（Syntax Highlighting）与词法比对（Intraline）全链路接通**：
   - 彻底废除 `highlightCode(line, 'diff')` 语言陷阱，引入 `langFromFilename(filePath)` 动态推导文件真实语言（TypeScript / Rust / Python 等）；
   - 重构 `renderTokens` 词法高亮合成器：对拆分后的 `DiffWordToken[]`，非变更 Token 经过语法高亮器处理，改动 Token 添加高亮底色背景，杜绝语法色彩坍塌为纯文本；
   - 为 `VirtualPlainCodeViewer` 源码模式补全语法高亮；
2. **Split 分栏视图对齐重构（消除伪分栏错位）**：
   - 彻底重构 [`WidgetDiff.tsx`](file:///c:/Software/conex/apps/crish-desktop/src/components/custom-tags/WidgetDiff.tsx)，废除左/右列独立 `filter` 逻辑，引入基于 Hunk 的对齐配对器（Line Pairing），增删不对称时自动插入占位空行（Empty Filler Rows），确保左右行号与代码逐行绝对对齐；
   - 消除 `DiffCardSplitView` 单行内部横向滚动破坏 50%/50% 分栏平衡问题；
3. **消除 380px 固定高度锁死与滚轮劫持**：
   - 移除 `.scrollParent` 上的 `height: 380px; max-height: 380px;` 硬编码，改造为智能弹性高度 `min-height: 44px; max-height: min(520px, 60vh); height: auto;`；
   - 移除内层嵌套容器的 `overscroll-behavior: contain;`，恢复外层文件列表顺畅的滚轮链；
4. **纯白卡片底板与清爽色阶重塑**：
   - `.linesContainer` 废除 `--bg-primary`（`#f4f5f7` 脏灰底），改用卡片白底 `--diff-bg-pane: var(--bg-card, #ffffff)`；
   - Gutter 行号底色微混 `2.5%`，正常代码行恢复主文字色 `--text-primary`；
   - Diff 增量（Add）与删减（Del）背景色阶在浅色下调整为 10%（词级 28%），对比度满足 WCAG AA（≥6.8:1）；
5. **紧凑工具栏与提交面板体验治理**：
   - `DiffHeaderControls` 引入溢出折叠菜单，侧栏 `< 400px` 时保证核心操作不被隐藏；
   - `DiffCardGitActions` 提交按钮升级为 `variant="primary"`，增加空消息禁用校验与 `Ctrl+Enter` 快捷键。

---

### 2.4 维度四：选择器级联污染清剿与 CSS Modules 边界绝缘

*拔除未限定 `:global` 泄漏、废除 `[class*='...']` 模糊穿透、消灭 55 处深色硬编码与 44 处 `!important`。*

#### 核心治理任务：
1. **纯全局 `:global` 规则封装与收敛**：
   - 将 `TiptapEditorField.module.css` 中的 `.mention-chip` 等 5 处未限定类名封装进 `.proseMirrorField`；
   - 将 `Menu.module.css` 中的 `:global(.sep-safe-aim-overlay)` 迁移至全局层；
   - 将 `NotePaperPanel.module.css` 的 `.np-paper-list-mount` 封装在 `.panel` 之下；
2. **彻底废除 `[class*='...']` 模糊匹配穿透**：
   - 移除 `Sidebar.module.css` 中 10 处穿透子组件的模糊选择器，改由顶层注入 `data-sidebar-collapsed`，各子组件在其私有 Module 中独立响应；
   - 移除 `ProjectPickerMenu.module.css` 与 `overlay-scrollbar.css` 中的模糊子串选择器；
3. **清剿 55 处 `:global(html[data-theme='dark'])` 硬编码覆写**：
   - 彻底删除 `ModelsSettingsTab`、`FontSelectField`、`Select`、`Menu` 等 9 个模块中的深色手动覆写，全部转由 `tokens.css` 原生 CSS 变量动态驱动；
4. **拔除组件级 `!important` 提权对抗**：
   - 移除多面板卡片（`AgentCard`, `DiffCard`, `FilesCard`, `PreviewCard`）中的 `border-top: none !important;`，由容器状态选择器统一管理；
   - 移除微型按钮与滚动条中的 `!important`；
5. **原生 HTML `title=` 属性 100% 胶囊化**：
   - 清理 9 处原生 `title="..."`，统一包装为项目标准 `<Tooltip>` 组件。

---

### 2.5 维度五：Token 继承链归一化、悬空/幽灵 Token 拔除与 Zero-Blue 铁律遵循

*解决断点随主题漂移、消除静态/运行时双源脱节、收敛 18 处幽灵变量、净化蓝光色相。*

#### 核心治理任务：
1. **响应式断点与分层优先级归一化**：
   - 将 `--breakpoint-*` 从 `responsive.css` 剥离，统一收敛至 `tokens.css` 的 `:root`，彻底根除深浅主题下断点在 640px 与 480px 之间漂移 160px 的致命缺陷；
   - 统一 `z-index.css` 为权威真源，消除与 `tokens.css` 的未分层遮蔽冲突；
2. **静态 CSS 与 TypeScript 预设基准 100% 对齐**：
   - 将 `themePresets.ts` 的 `dark-cozy` 基准色调校准为与 `tokens.css` 纯中性墨阶完全一致（`bgPrimary: hsl(0 0% 5%)`、`bgElevated: hsl(0 0% 15%)`），恢复浮层层次感；
   - 补齐 `themePersonalization.ts` 皮肤清理函数中遗漏的 `removeProperty` 属性；
3. **拔除组件级 Token 劫持与圆角分裂**：
   - 移除 `SettingsPanel.module.css` 中的 `--z-dropdown: 20` 恶意劫持；
   - 统一 5 处设置面板中私自硬编码的 6px/5px 分段控制器圆角，收敛至全局 `var(--button-radius, 7px)`；
4. **悬空与幽灵 Token 根治**：
   - 消除 `SettingsDevicesTab.module.css` 等 8 处无 Fallback 悬空 Token（替换为 `--text-tertiary` 等）；
   - 将 `GitStatusBadge.module.css` 中的 18 个私有 `--badge-git-*` 重构为消费全局标准 `--filetree-badge-*` Token；
5. **净化 Zero-Blue 蓝光污染**：
   - 清除 `GitStatusBadge.module.css` 与 `OverviewGitTree.module.css` 中残留的 `hsl(210 ...)` / `hsl(215 ...)` 蓝调灰阶；
   - 修正预设中 `mixColor` 的色相偏离，回归中性 Slate 规范。

---

## 三、【核心】死层、硬编码与粗黑样式删除面清单（Deletion Surface Matrix）

本节依据五份审计报告，列出在本次重构中**必须物理删除、拔除或彻底清除**的死层、硬编码色值、超标边框、固定尺寸与冗余代码。

> **执行纪律**：删除面清单中的每一项均已精确锚定至源码行号。重构执行时，必须严格执行“先物理删除脏污代码，再注入规范实现”的法则。

---

### 3.1 必须删除/清除的硬编码死黑底与实心黑填充（7 类）

| 编号 | 目标文件与代码坐标 | 现状违规代码 | 违规性质与视觉危害 | 删除与清除方案 |
| :--- | :--- | :--- | :--- | :--- |
| **DEL-01** | [`tokens.css:179`](file:///c:/Software/conex/apps/crish-desktop/src/styles/tokens.css#L179) | `--accent-color: hsl(35, 16%, 15%);` | **毒瘤一**：15% 近黑墨阶（`#2c2824`），导致全界面 Primary 按钮、Switch、Badge、Slider 全盘黑化 | **物理删除**原色值，纠偏为活态翡翠绿 `hsl(160 84% 36%)` |
| **DEL-02** | [`Button.module.css:127-129`](file:///c:/Software/conex/apps/crish-desktop/src/components/ui/Button/Button.module.css#L127-L129) | `--btn-bg: var(--accent-color);`<br>`--btn-border: color-mix(..., black 20%);` | **毒瘤一**：Primary 按钮为死黑块，且按钮边框混入真实纯黑 20% | **物理删除** `--accent-color` 绑定与 `black 20%`，改用 `--brand` 规范体系 |
| **DEL-03** | [`Switch.module.css:48-51`](file:///c:/Software/conex/apps/crish-desktop/src/components/ui/Switch/Switch.module.css#L48-L51) | `background: var(--accent-color);`<br>`border-color: var(--accent-color);` | **毒瘤一**：开关开启态变成焦黑轨道与黑边 | **物理删除** `--accent-color` 绑定，改用 `--brand` 与 `--brand-deep` |
| **DEL-04** | [`ApprovalAskCard.module.css:235-244`](file:///c:/Software/conex/apps/crish-desktop/src/components/agent-card/ApprovalAskCard.module.css#L235-L244) | `background: var(--text-primary);`<br>`border-color: transparent; color: var(--bg-primary);` | **毒瘤二**：审批允许按钮裸写 `#111111` 纯黑实体大方块，造成严重视觉压迫 | **物理删除** `var(--text-primary)` 背景填充，替换为 `--brand-deep` 主行动点 |
| **DEL-05** | [`ChatComposer.module.css:402-404`](file:///c:/Software/conex/apps/crish-desktop/src/components/chat-composer/ChatComposer.module.css#L402-L404) | `.planExpandedStep.completed .planStepDot { background: var(--text-primary); }` | **毒瘤二**：已完成步骤圆点渲染为硬纯黑斑点 | **物理删除** `var(--text-primary)` 填充，改用 `--brand` 翡翠绿打勾点 |
| **DEL-06** | [`tokens.css:476-480`](file:///c:/Software/conex/apps/crish-desktop/src/styles/tokens.css#L476-L480) | `--md-code-inline-bg: color-mix(in srgb, var(--text-primary) 5%, var(--bg-primary));` | **毒瘤三**：行内代码混入外层暗灰底色，在白色卡片正文中呈现发黑脏灰膏药感 | **物理删除** `var(--bg-primary)` 混色基底，归位为纯白卡底 `var(--bg-card)` |
| **DEL-07** | [`SubagentHeaderPanel.module.css:120-142`](file:///c:/Software/conex/apps/crish-desktop/src/components/chat-card/SubagentHeaderPanel.module.css#L120-L142) | `.statusBadge { background: var(--bg-tertiary); }` (含 completed, stopped) | **毒瘤四**：微小状态徽标被倾倒 `#e2e5e8` 污泥灰，呈现死沉泥块感 | **物理删除** 裸用 `--bg-tertiary`，改用 4%~8% 透明微底色 |

---

### 3.2 必须删除的超标粗黑边框、硬实线与刺目焦圈（6 类）

| 编号 | 目标文件与代码坐标 | 现状违规代码 | 违规性质与视觉危害 | 删除与清除方案 |
| :--- | :--- | :--- | :--- | :--- |
| **DEL-08** | [`tokens.css:503-509`](file:///c:/Software/conex/apps/crish-desktop/src/styles/tokens.css#L503-L509) | `--md-quote-border-color: color-mix(..., var(--text-primary) 20%, var(--border-color));`<br>`--md-quote-border-width: 3px;` | **违背 §13**：边框混入文本黑达 **20%**（超标 2 倍），且宽度 3px，左侧呈现厚重黑粗线 | **物理删除** `20%` 混色与 `3px` 宽度，收敛为 `8%` 加深与 `2px` 极简线 |
| **DEL-09** | [`PlanGoalRibbons.module.css:101, 118`](file:///c:/Software/conex/apps/crish-desktop/src/components/chat-card/PlanGoalRibbons.module.css#L101) | `border-color: color-mix(..., var(--accent-color) 35%, ...);`<br>`background: color-mix(..., var(--accent-color) 75%, var(--text-primary));` | **违背 §13**：边框加深 **35%**（超标 3.5 倍），填充条混入 75% 近黑 + 25% 纯黑，死黑无光 | **物理删除** 35% 与 75% 混入逻辑，改用柔和 `--brand` 18% 边框与翡翠绿填充 |
| **DEL-10** | [`ChatStatusRibbons.module.css:66-70`](file:///c:/Software/conex/apps/crish-desktop/src/components/chat-card/ChatStatusRibbons.module.css#L66-L70) | `border-color: color-mix(in srgb, var(--accent-color) 30%, var(--border-subtle));` | **违背 §13**：边框混入近黑 **30%**（超标 3 倍），动态状态胶囊呈现沉重黑框 | **物理删除** 30% 混入，降至合规的 ≤6% 柔和混入 |
| **DEL-11** | [`ChatMessageRow.module.css:925`](file:///c:/Software/conex/apps/crish-desktop/src/components/chat-message-row/ChatMessageRow.module.css#L925) | `border-color: color-mix(in srgb, var(--border-color) 80%, var(--text-primary));` | **违背 §13**：里程碑圆点边框混入 **20%** 纯黑 | **物理删除** 20% 混入，压降至 ≤6% |
| **DEL-12** | [`ChatToolCallBlock.module.css:263`](file:///c:/Software/conex/apps/crish-desktop/src/components/chat-tool-call/ChatToolCallBlock.module.css#L263) | `border-left: 2px solid var(--accent-color);` | **违背 §13**：工具调用折叠组左侧为 2px 实心深黑竖线 | **物理删除** 实心 `--accent-color`，改用柔和半透明翡翠绿边框 |
| **DEL-13** | [`tokens.css:902`](file:///c:/Software/conex/apps/crish-desktop/src/styles/tokens.css#L902) | `--focus-ring-color: color-mix(in srgb, var(--text-primary) 30%, transparent);` | **违背 §13**：深色焦点外环混入 **30%** 文本白，超出 10% 上限 3 倍，产生刺眼亮环 | **物理删除** 30% 声明，修改为合规的 8% 柔和焦点环 |

---

### 3.3 必须删除的厚重深黑 Box-Shadow 与微小浮层光晕（3 类）

| 编号 | 目标文件与代码坐标 | 现状违规代码 | 违规性质与视觉危害 | 删除与清除方案 |
| :--- | :--- | :--- | :--- | :--- |
| **DEL-14** | [`Tooltip.module.css:48-49`](file:///c:/Software/conex/apps/crish-desktop/src/components/ui/Tooltip/Tooltip.module.css#L48-L49) | `border-radius: 4px;`<br>`box-shadow: var(--shadow-lg);` | **违背 §12/§13**：极小气泡挂载 4 层 48px 巨型重阴影，四角方正，包裹沉重黑气团 | **物理删除** `var(--shadow-lg)` 与 4px 圆角，改用 `var(--radius-full)` 与 `var(--shadow-sm)` |
| **DEL-15** | [`Menu.module.css:45`](file:///c:/Software/conex/apps/crish-desktop/src/components/ui/Menu/Menu.module.css#L45) | `box-shadow: 0 24px 54px -10px rgba(0, 0, 0, 0.70);` | **违背 §13**：深色模式弹出菜单挂载 70% 极重黑晕，下坠感极强 | **物理删除** 裸写 `rgba(..., 0.70)`，收敛至标准 `--shadow-dropdown` |
| **DEL-16** | [`PreviewCard.module.css:229, 365`](file:///c:/Software/conex/apps/crish-desktop/src/components/workspace/PreviewCard.module.css#L229) | `box-shadow: 0 2px 8px color-mix(in srgb, var(--text-primary) 10%, transparent);` | **违背 §13**：阴影私自混入文本黑，脱离统一阴影 Token 体系 | **物理删除** 私有混色阴影，改用 `var(--shadow-sm)` |

---

### 3.4 必须删除的硬编码固定高度、过渡补间与滚动陷阱（4 类）

| 编号 | 目标文件与代码坐标 | 现状违规代码 | 违规性质与视觉危害 | 删除与清除方案 |
| :--- | :--- | :--- | :--- | :--- |
| **DEL-17** | [`loader.css:41-60`](file:///c:/Software/conex/apps/crish-desktop/public/loader.css#L41-L60) | `.app-initial-loader { transition: background-color 0.3s ease; }`<br>`:root { --loader-bg: #0b0b0e; }` | **首屏闪色根因**：冷启动时触发 300ms 补间，浅色模式必定肉眼可见从纯黑变浅灰 | **物理删除** 300ms `transition`；`:root` 移除纯黑 `#0b0b0e` |
| **DEL-18** | [`index.html:18-20`](file:///c:/Software/conex/apps/crish-desktop/index.html#L18-L20) | `<script src="/loader.js" defer></script>` | **FOUC 根因**：`defer` 导致脚本推迟到 DOM 解析后才执行，错失 0ms 首屏拦截窗口 | **物理删除** `defer` 属性，改为 `<head>` 最前端同步阻塞执行 |
| **DEL-19** | [`DiffCard.module.css:757-766`](file:///c:/Software/conex/apps/crish-desktop/src/components/diff/DiffCard.module.css#L757-L766) | `.scrollParent { height: 380px; max-height: 380px; }` | **Diff 布局硬伤**：小 Diff 撑出 300px 大片空白灰框，大 Diff 视野被强行挤压在 380px | **物理删除** `380px` 锁死，重构为智能弹性视口 `max-height: min(520px, 60vh)` |
| **DEL-20** | [`DiffCard.module.css:211, 760`](file:///c:/Software/conex/apps/crish-desktop/src/components/diff/DiffCard.module.css#L211) | `overscroll-behavior: contain;` | **交互锁死根因**：嵌套虚拟滚动拦截滚轮事件传递，鼠标滑过代码块导致列表滚动卡死 | **物理删除** `overscroll-behavior: contain`，恢复顺畅滚动链 |

---

### 3.5 必须删除的死代码、冗余样式与 `!important` 提权对抗（3 类）

| 编号 | 目标文件与代码坐标 | 现状违规代码 | 违规性质与视觉危害 | 删除与清除方案 |
| :--- | :--- | :--- | :--- | :--- |
| **DEL-21** | [`DiffCard.module.css:1076-1300, 1399-1558`](file:///c:/Software/conex/apps/crish-desktop/src/components/diff/DiffCard.module.css#L1076-L1300) | 超过 **300 行** 历史遗留的单文件 Tab 页与独立详情工具栏无主 CSS 类 | **死代码与臃肿**：已被手风琴架构淘汰，白白增加 34.6KB 文件体积与打包开销 | **全量物理删除** 300+ 行无主 CSS 规则 |
| **DEL-22** | `AgentCard`, `DiffCard`, `FilesCard`, `PreviewCard` | `border-top: none !important;` (共 8 处) | **特异性失控**：多面板嵌套时通过 `!important` 暴力消除顶边框，破坏层叠秩序 | **物理删除** 全部 8 处 `!important`，改由容器父级选择器统一控制边框 |
| **DEL-23** | [`PreviewCard.module.css:202-207`](file:///c:/Software/conex/apps/crish-desktop/src/components/workspace/PreviewCard.module.css#L202-L207) | `.miniButton` 内连发 **6 个 `!important`** 强行锁死尺寸与圆角 | **特异性失控**：对抗全局按钮基础样式，破坏组件库封装 | **物理删除** 全部 6 个 `!important`，定义独立 `.miniActionBtn` 变体 |

---

### 3.6 必须删除的私有选择器泄漏、模糊匹配与主题硬编码（4 类）

| 编号 | 目标文件与代码坐标 | 现状违规代码 | 违规性质与视觉危害 | 删除与清除方案 |
| :--- | :--- | :--- | :--- | :--- |
| **DEL-24** | [`TiptapEditorField.module.css:179-215`](file:///c:/Software/conex/apps/crish-desktop/src/components/chat-input/TiptapEditorField.module.css#L179-L215) | `:global(.mention-chip)`, `:global(.mention-icon-box)` 等 5 处未限定规则 | **全局污染**：脱离组件外层类名，原样编译为全局选择器，污染全局 DOM 树 | **物理删除** 裸 `:global`，将其强制封装在 `.proseMirrorField` 作用域内 |
| **DEL-25** | [`Sidebar.module.css:355-450`](file:///c:/Software/conex/apps/crish-desktop/src/components/sidebar/Sidebar.module.css#L355-L450) | `.iconCollapse :global([class*='sessionText'])` 等 **10 条** 模糊子串穿透规则 | **模块绝缘破壁**：父组件暴力穿透子组件内部 DOM，引发正则匹配开销与失效风险 | **全量物理删除** 10 条模糊匹配规则，改用 `[data-sidebar-collapsed]` 自治响应 |
| **DEL-26** | `ModelsSettingsTab`, `FontSelectField`, `Select`, `Menu` 等 9 模块 | `:global(html[data-theme='dark']) .localClass` (共 **55 处**) | **破坏 Token SSOT**：私自抬高特异性硬编码暗色底板与边框，使全局 Token 失控 | **全量物理删除** 55 处暗色手动覆写，全部转由 CSS 变量原生自动驱动 |
| **DEL-27** | `ModelBadgePickerMenu.tsx` 等 9 处组件 | 原生 DOM `title="..."` 属性 (共 **9 处**) | **违背 §12**：绕过自定义 `<Tooltip>` 胶囊，呈现浏览器陈旧黄色方块气泡 | **物理删除** 9 处原生 `title=`，统一替换为 `<Tooltip>` 组件包裹 |

---

### 3.7 必须删除的悬空/幽灵 Token 与 Zero-Blue 违规色相（3 类）

| 编号 | 目标文件与代码坐标 | 现状违规代码 | 违规性质与视觉危害 | 删除与清除方案 |
| :--- | :--- | :--- | :--- | :--- |
| **DEL-28** | [`SettingsDevicesTab.module.css:19-221`](file:///c:/Software/conex/apps/crish-desktop/src/components/settings/SettingsDevicesTab.module.css#L19-L221) | `color: var(--color-text-dim);` (共 8 处，无 fallback) | **悬空 Token**：变量从未定义，深色模式下属性直接失效回退为系统纯黑字 | **物理删除** 8 处悬空引用，替换为标准 `--text-tertiary` |
| **DEL-29** | [`GitStatusBadge.module.css:18-52`](file:///c:/Software/conex/apps/crish-desktop/src/components/overview/GitStatusBadge.module.css#L18-L52) | `--badge-git-m-fg` 等 **18 个** 幽灵变量 + 浅色硬编码 fallback | **幽灵 Token 孤立**：深色模式下回退到浅色深暗字，对比度 < 1.8:1 完全不可读 | **全量物理删除** 18 个私有变量，重构为消费全局标准 `--filetree-badge-*` |
| **DEL-30** | `GitStatusBadge.module.css`, `OverviewGitTree.module.css` | `hsl(215 16% ...)`, `hsl(210 10% ...)` 蓝调色阶 (共 7 处) | **违背 Zero-Blue**：公然在基础中性灰阶中混入 Hue 210°~215° 蓝光冷色 | **物理删除** 蓝调色阶，校准为纯中性墨阶（`hsl(0 0% ...)` 或标准 Token） |

---

## 四、先删后改：技术依赖拓扑与 DAG 执行路径

为了确保本次重构在多团队协作与自动化测试中**稳定推进、零回归、先破坏脏污层再固化新基座**，制定如下严密的 DAG 执行拓扑图与分阶段实施路线。

### 4.1 DAG 拓扑图与阶段演进

```mermaid
graph TD
    subgraph "Phase 0: 删除面大清剿 (Destructive Clean-up)"
        D1[P0.1: 删除 300+ 行死代码与 44 处 !important]
        D2[P0.2: 删除 55 处 :global 暗色硬编码与 10 处模糊穿透]
        D3[P0.3: 删除 380px 锁死与 300ms loader 过渡]
        D4[P0.4: 删除 18 处幽灵 Token 与 8 处悬空 Token]
    end

    subgraph "Phase 1: Token 真相源归一 (Tokens & Presets SSOT)"
        T1[P1.1: tokens.css 与 themePresets.ts 100% 对齐]
        T2[P1.2: --breakpoint-* 从 responsive.css 收敛至 tokens.css]
        T3[P1.3: z-index 体系与 @layer(base) 解耦归一]
        T4[P1.4: OKLCH 对比度守卫重构为非侵入式]
    end

    subgraph "Phase 2: 首屏 0ms 零闪烁流水线 (Zero-FOUC Pipeline)"
        F1[P2.1: index.html 移除 defer，loader.js 0ms 同步注入]
        F2[P2.2: tokens.css 声明 .preload 门闩冻结过渡]
        F3[P2.3: main.tsx 顶层同步 bootstrapTheme]
        F4[P2.4: 剥离 AppBootstrap 与 bootstrap-full 冗余调用]
    end

    subgraph "Phase 3: 活态去黑与微小元素修整 (Small Elements Polish)"
        S1[P3.1: --accent-color 语义纠偏为翡翠绿]
        S2[P3.2: Button/Switch/Badge/Slider 6 大控件全面脱黑]
        S3[P3.3: Inline Code 归位纯白卡底，Quote 边框降至 8%]
        S4[P3.4: 审批允许按钮升级 --brand-deep，清理 30% 焦点环]
    end

    subgraph "Phase 4: 差异比对面板全链路重构 (Diff Panel Modernization)"
        DP1[P4.1: 接通真实语言检测 langFromFilename]
        DP2[P4.2: renderTokens 词法与语法高亮无缝合成]
        DP3[P4.3: WidgetDiff 基于 Hunk 对齐占位重写]
        DP4[P4.4: DiffCard.module.css 白卡底板与弹性视口]
    end

    subgraph "Phase 5: 级联绝缘与规范闭环 (Cascade Isolation & Compliance)"
        C1[P5.1: TiptapEditor 等纯全局 :global 作用域封装]
        C2[P5.2: 侧边栏下发 data-sidebar-collapsed 状态自治]
        C3[P5.3: 9 处原生 title 替换为 Tooltip 胶囊]
        C4[P5.4: 统一 5 处 SettingsTabs 圆角至 7px]
    end

    subgraph "Phase 6: 自动化测试门禁与断言 (Guardrails & Verification)"
        G1[P6.1: style-contract.test.ts 注入去黑防回归断言]
        G2[P6.2: a11y-contrast.test.ts 100% WCAG AA 达标]
        G3[P6.3: 0ms 启动冷启动录屏无闪色验收]
    end

    D1 --> T1
    D2 --> T1
    D3 --> T1
    D4 --> T1

    T1 --> F1
    T2 --> F1
    T3 --> F1
    T4 --> F1

    F1 --> F2 --> F3 --> F4

    F4 --> S1 --> S2 --> S3 --> S4

    S4 --> DP1 --> DP2 --> DP3 --> DP4

    DP4 --> C1 --> C2 --> C3 --> C4

    C4 --> G1 --> G2 --> G3
```

---

### 4.2 阶段执行详规（Phase 0 ~ Phase 6）

#### 【Phase 0】删除面大清剿（Destructive Clean-up）——*先拔毒，后治病*
1. **清理死代码**：删除 `DiffCard.module.css` 中的 300+ 行死 Tab 样式；
2. **清除 55 处深色硬编码**：从 `ModelsSettingsTab` 等 9 个模块中剔除 `:global(html[data-theme='dark'])`；
3. **清除 10 处模糊穿透**：从 `Sidebar.module.css` 剔除全部 `[class*='...']`；
4. **清除 8 处卡片顶边框 `!important`** 与 6 处微型按钮 `!important`；
5. **清除 18 个幽灵 Token** 与 8 处 `--color-text-dim` 悬空引用；
6. **清除 380px 锁死** 与 `loader.css` 的 300ms `transition`。

#### 【Phase 1】Token 真相源归一（Tokens & Presets SSOT）——*固化唯一定义源*
1. **深色调色板对齐**：修改 `themePresets.ts` 中的 `dark-cozy`，使其 `bgPrimary`、`bgElevated`、`borderColor` 与 `tokens.css` 纯中性墨阶达到 100% 一致；
2. **断点单源化**：将 `--breakpoint-*` 从 `responsive.css` 移入 `tokens.css:root`，删除 `responsive.css` 中的断点定义；
3. **层叠解耦**：将 `z-index.css` 作为唯一真源，取消 `@layer(base)` 导入，消除遮蔽；
4. **守卫非侵入化**：改造 `oklchColorGuard.ts` 为“条件触发型”，官方预设达标时不篡改文字色彩。

#### 【Phase 2】首屏 0ms 零闪烁流水线（Zero-FOUC Pipeline）——*首帧即终态*
1. **0ms 种子注入**：改造 `index.html`，同步执行 `loader.js`；`loader.js` 解析 `crish_theme_skin` 并将核心色写入 `<html>` inline style；
2. **`.preload` 门闩生效**：`loader.js` 为 `<html>` 注入 `.preload` 类，`tokens.css` 声明全局过渡禁用；
3. **启动时序前移**：在 `main.tsx` 顶层（`createRoot` 前）同步调用 `bootstrapTheme()`；在首渲染 rAF 移除 `.preload`；
4. **剔除冗余**：移除 `AppBootstrap.ts` 异步 Effect 中的重复注入与 `bootstrap-full.ts` 中的闲时重复调用。

#### 【Phase 3】活态去黑与微小元素修整（Small Elements Polish）——*恢复翡翠绿与轻盈感*
1. **Token 纠偏**：`--accent-color` 修正为翡翠绿 `hsl(160 84% 36%)`；
2. **基础组件脱黑**：改造 `Button.module.css`（Primary 变翡翠绿）、`Switch.module.css`（开启态绿道）、`Badge.module.css`（Brand 变绿）、`Slider.module.css`（轨道与描边脱黑）；
3. **正文渲染归位**：`tokens.css` 中将行内代码微胶囊底色修正为 `var(--bg-card)` 白底，引用块边框混入降至 8%、线宽 2px；思考链透明度降至 5%；
4. **卡片与交互去黑**：`ApprovalAskCard.module.css` 允许按钮改为 `--brand-deep`；`tokens.css` 暗色焦点环混入降至 8%。

#### 【Phase 4】差异比对面板全链路重构（Diff Panel Modernization）——*专业级代码审查体验*
1. **真实语言推导**：各 Diff 查看器引入 `langFromFilename(filePath)`，彻底取代硬编码 `'diff'`；
2. **词法与语法结合**：重构 `renderTokens`，实现词法高亮与语法高亮的分段复合渲染；
3. **`<widget-diff>` 对齐重塑**：废除双侧 `filter`，实现基于 Hunk 的对齐配对与空白行填充；
4. **样式与布局重构**：`DiffCard.module.css` 采用弹性视口（移除 380px），底板改为纯白卡片底（`--diff-bg-pane`），行号字号与基线垂直对齐，解除 `overscroll-behavior: contain` 滚轮劫持。

#### 【Phase 5】级联绝缘与规范闭环（Cascade Isolation & Compliance）——*组件强绝缘*
1. **`:global` 作用域封装**：为 `TiptapEditorField`、`NotePaperPanel` 等补充父级类名约束；
2. **状态属性下发**：`Sidebar` 注入 `data-sidebar-collapsed`，子组件私有 Module 独立响应；
3. **原生 Tooltip 胶囊化**：将 9 处原生 `title="..."` 替换为项目标准 `<Tooltip>`；
4. **圆角规范收敛**：统一 5 处 `SettingsTabs` 分段控制器圆角为标准 7px。

#### 【Phase 6】自动化测试门禁与断言（Guardrails & Verification）——*防回归硬防线*
1. 固化 `small-elements-darkening-guard.test.ts`，断言 `--accent-color` 浅色明度 $\ge 35\%$、禁止组件裸写 `background: var(--text-primary)`、断言边框加深 $\le 10\%$；
2. 固化 `diff-syntax-highlight.test.ts`，断言 Diff 面板输出 HTML 中必须包含 `.hljs-keyword` / `.hljs-title` 等高亮 span；
3. 全量运行现有 `style-contract.test.ts` 与 `a11y-contrast.test.ts`，确保 100% 通过。

---

## 五、重构实施映射表与代码文件修改面

| 序号 | 目标物理文件路径 | 涉及核心任务与修改性质 | 对应重构维度 | 预期改动规模 |
| :--- | :--- | :--- | :--- | :--- |
| 1 | [`apps/crish-desktop/index.html`](file:///c:/Software/conex/apps/crish-desktop/index.html) | 去除 loader.js 的 `defer`；初始化 `<html>` class 注入 `preload` | 维度一 | 极小 (3 行) |
| 2 | [`apps/crish-desktop/public/loader.css`](file:///c:/Software/conex/apps/crish-desktop/public/loader.css) | 移除 300ms `transition`；`:root` 移除纯黑 `#0b0b0e`，采用安全浅灰 | 维度一 | 小 (15 行) |
| 3 | [`apps/crish-desktop/public/loader.js`](file:///c:/Software/conex/apps/crish-desktop/public/loader.js) | 同步解析 `crish_theme_skin`，0ms 同步注入背景与文字变量 | 维度一 | 中 (30 行) |
| 4 | [`apps/crish-desktop/src/main.tsx`](file:///c:/Software/conex/apps/crish-desktop/src/main.tsx) | 顶层同步调用 `bootstrapTheme()`；在首帧 rAF 中移除 `.preload` 门闩 | 维度一 | 小 (10 行) |
| 5 | [`apps/crish-desktop/src/styles/tokens.css`](file:///c:/Software/conex/apps/crish-desktop/src/styles/tokens.css) | 添加 `.preload` 规则；`--accent-color` 纠偏为翡翠绿；行内代码归位白底；引用块降至 8%；焦点环降至 8%；Diff 变量重构；收敛断点 | 维度一/二/三/五 | 较大 (120 行) |
| 6 | [`apps/crish-desktop/src/api/themePresets.ts`](file:///c:/Software/conex/apps/crish-desktop/src/api/themePresets.ts) | `dark-cozy` 预设完全对齐 `tokens.css` 纯中性墨阶，消除 112% 亮度漂移与卡片深度塌陷 | 维度一/五 | 中 (40 行) |
| 7 | [`apps/crish-desktop/src/api/oklchColorGuard.ts`](file:///c:/Software/conex/apps/crish-desktop/src/api/oklchColorGuard.ts) | 改造为按需守卫，官方预设达标时禁止暴力覆盖皮肤文字色 | 维度一/五 | 中 (35 行) |
| 8 | [`apps/crish-desktop/src/styles/responsive.css`](file:///c:/Software/conex/apps/crish-desktop/src/styles/responsive.css) | 剥离 `--breakpoint-*` 变量定义，交由 `tokens.css:root` 独占管辖 | 维度五 | 极小 (8 行) |
| 9 | [`apps/crish-desktop/src/styles/z-index.css`](file:///c:/Software/conex/apps/crish-desktop/src/styles/z-index.css) | 统一作为无分层顶层 Token 导入，消除与 `tokens.css` 的重复遮蔽 | 维度五 | 小 (15 行) |
| 10 | [`apps/crish-desktop/src/components/ui/Button/Button.module.css`](file:///c:/Software/conex/apps/crish-desktop/src/components/ui/Button/Button.module.css) | Primary 按钮脱黑，背景使用 `--brand`，文字使用 `#ffffff` | 维度二 | 小 (15 行) |
| 11 | [`apps/crish-desktop/src/components/ui/Switch/Switch.module.css`](file:///c:/Software/conex/apps/crish-desktop/src/components/ui/Switch/Switch.module.css) | 开启态脱黑，背景使用 `--brand`，边框使用 `--brand-deep` | 维度二 | 极小 (6 行) |
| 12 | [`apps/crish-desktop/src/components/ui/Badge/Badge.module.css`](file:///c:/Software/conex/apps/crish-desktop/src/components/ui/Badge/Badge.module.css) | Brand / Info 徽标脱黑，恢复翡翠绿与品牌辨识度 | 维度二 | 小 (12 行) |
| 13 | [`apps/crish-desktop/src/components/ui/Slider/Slider.module.css`](file:///c:/Software/conex/apps/crish-desktop/src/components/ui/Slider/Slider.module.css) | 填充轨道与滑块小圆点描边脱黑，改用 `--brand` | 维度二 | 极小 (8 行) |
| 14 | [`apps/crish-desktop/src/components/ui/Tooltip/Tooltip.module.css`](file:///c:/Software/conex/apps/crish-desktop/src/components/ui/Tooltip/Tooltip.module.css) | 改为 `var(--radius-full)` 胶囊圆角，阴影降为 `var(--shadow-sm)` | 维度二 | 极小 (6 行) |
| 15 | [`apps/crish-desktop/src/components/ui/Menu/Menu.module.css`](file:///c:/Software/conex/apps/crish-desktop/src/components/ui/Menu/Menu.module.css) | 移除 70% 极重黑阴影，收敛至 `--shadow-dropdown`；移除暗色手动覆写 | 维度二/四 | 小 (20 行) |
| 16 | [`apps/crish-desktop/src/components/agent-card/ApprovalAskCard.module.css`](file:///c:/Software/conex/apps/crish-desktop/src/components/agent-card/ApprovalAskCard.module.css) | 允许按钮移除 `#111111` 纯黑背景，升级为 `--brand-deep` 实色按钮 | 维度二 | 小 (10 行) |
| 17 | [`apps/crish-desktop/src/components/chat-tool-call/ChatToolCallBlock.module.css`](file:///c:/Software/conex/apps/crish-desktop/src/components/chat-tool-call/ChatToolCallBlock.module.css) | 脉冲运行点脱黑为 `--brand`，工具组左边框改为柔和半透明线 | 维度二 | 小 (15 行) |
| 18 | [`apps/crish-desktop/src/components/diff/DiffCard.module.css`](file:///c:/Software/conex/apps/crish-desktop/src/components/diff/DiffCard.module.css) | 移除 380px 锁死；代码底板改用纯白卡底；移除 300+ 行死代码；解除滚轮劫持 | 维度三 | 巨大 (删除 320 行，修改 60 行) |
| 19 | [`apps/crish-desktop/src/components/diff/DiffCardUnifiedView.tsx`](file:///c:/Software/conex/apps/crish-desktop/src/components/diff/DiffCardUnifiedView.tsx) | 引入 `langFromFilename`；重构 `renderTokens` 接通语法高亮 | 维度三 | 中 (45 行) |
| 20 | [`apps/crish-desktop/src/components/diff/DiffCardSplitView.tsx`](file:///c:/Software/conex/apps/crish-desktop/src/components/diff/DiffCardSplitView.tsx) | 引入 `langFromFilename`；重构 `renderTokens`；修复分栏比例失调 | 维度三 | 中 (45 行) |
| 21 | [`apps/crish-desktop/src/components/diff/VirtualPlainCodeViewer.tsx`](file:///c:/Software/conex/apps/crish-desktop/src/components/diff/VirtualPlainCodeViewer.tsx) | 补全纯源码模式的语法高亮 | 维度三 | 小 (15 行) |
| 22 | [`apps/crish-desktop/src/components/custom-tags/WidgetDiff.tsx`](file:///c:/Software/conex/apps/crish-desktop/src/components/custom-tags/WidgetDiff.tsx) | 重构 Split 视图对齐算法，消除左右列独立 filter 导致的严重错位 | 维度三 | 中 (50 行) |
| 23 | [`apps/crish-desktop/src/components/sidebar/Sidebar.module.css`](file:///c:/Software/conex/apps/crish-desktop/src/components/sidebar/Sidebar.module.css) | 移除 10 处 `[class*='...']` 模糊穿透规则，改由状态属性自治响应 | 维度四 | 中 (40 行) |
| 24 | [`apps/crish-desktop/src/components/chat-input/TiptapEditorField.module.css`](file:///c:/Software/conex/apps/crish-desktop/src/components/chat-input/TiptapEditorField.module.css) | 封装 5 处未限定 `:global(.mention-*)` 规则至 `.proseMirrorField` | 维度四 | 小 (15 行) |
| 25 | `ModelsSettingsTab`, `FontSelectField`, `Select` 等 9 模块 | 彻底删除全部 55 处 `:global(html[data-theme='dark'])` 规则 | 维度四 | 中 (80 行) |
| 26 | `SettingsDevicesTab.module.css` | 替换 8 处 `--color-text-dim` 悬空 Token 为 `--text-tertiary` | 维度五 | 极小 (8 行) |
| 27 | `GitStatusBadge.module.css` | 删除 18 个私有 `--badge-git-*` 幽灵变量，重构消费标准 Token | 维度五 | 中 (45 行) |
| 28 | `ModelBadgePickerMenu.tsx` 等 9 处组件 | 替换 9 处原生 `title="..."` 为 `<Tooltip>` 组件包裹 | 维度四 | 小 (25 行) |

---

## 六、战役硬性验收断言与防护门禁

在方案实施落盘后，必须通过以下 **7 大硬性验收断言** 方可宣布战役胜利收官：

1. **[断言 1] 0ms 零闪烁与零跳变（Zero FOUC & Zero Mutation）**：
   - 冷启动应用，在默认浅色、深色或任意自定义皮肤下，首帧绘制（T = 0ms）即为最终色值，首屏到完全可交互全程 **$\Delta E = 0$**（无肉眼可见的背景/文字突变）；
   - `.preload` 门闩生效，页面加载期间无任何组件发生 120ms~300ms 的蠕动补间动画。
2. **[断言 2] 全界面小元素 100% 脱黑（Zero Unintended Darkening）**：
   - Primary 按钮、Switch 开关、Brand 徽标、Slider 滑块、ToolCall 呼吸点完全脱离 `#2c2824` / `#111111` 死黑，呈现温润优雅的翡翠绿（`--brand`）；
   - 聊天正文中行内代码底板纯净白卡，引用块边框加深严格 $\le 8\%$，无 3px 粗黑竖线。
3. **[断言 3] 差异比对面板语法高亮 100% 恢复（100% Syntax Highlighting）**：
   - Unified、Split 与 Plain 模式下的 TypeScript / Rust / Python 等代码行，关键字、类型、字符串呈现清晰语法色彩，严禁全盘退化为黑灰纯文本；
   - 局部词法变更行（Intraline Diff）在保留增删背景色的同时，非改动单词语法高亮完整保留。
4. **[断言 4] Diff 视图布局弹性与分栏绝对对齐（Elastic Layout & Split Parity）**：
   - `.scrollParent` 高度根据代码行数自适应弹性收缩，彻底消除 380px 巨大空白框；
   - `<widget-diff>` 与 `DiffCardSplitView` 的左右行号与代码行逐行绝对对齐，空缺处使用占位行填充，绝无错行；
   - 鼠标滚轮在手风琴长列表中穿过展开的代码区时，外层滚动链顺畅无阻（无滚轮劫持）。
5. **[断言 5] 规范 100% 合规达标（Visual Compliance）**：
   - 深色焦点环混入比例降至 $\le 8\%$，全仓严格遵守 `AGENTS.md` §13（上限 10%）；
   - 9 处原生 HTML `title=` 违规清零，100% 胶囊化为自定义 `<Tooltip>`；
   - 散落的 244 处旧式 `rgba(...)` 清理收敛，严格遵循 §14 现代 CSS 色彩语法。
6. **[断言 6] 级联污染与死代码清零（Zero Cascade Leaks & Dead Code）**：
   - CSS Modules 中纯全局未限定选择器为 **0 处**；
   - 跨组件模糊匹配 `[class*='...']` 穿透规则为 **0 处**；
   - 组件内 `:global(html[data-theme='dark'])` 手动覆写为 **0 处**；
   - `DiffCard.module.css` 中 300+ 行死代码物理删除完毕。
7. **[断言 7] Token 体系单源化与测试套件全绿（SSOT & 100% Tests Pass）**：
   - 消除深浅主题下 `--breakpoint-sm` 漂移 160px 的缺陷；
   - 8 处悬空 Token、18 处幽灵 Token、7 处 Zero-Blue 蓝光污染彻底拔除；
   - 全仓自动化测试（`style-contract.test.ts`、`a11y-contrast.test.ts` 以及新增的 `small-elements-darkening-guard.test.ts`）100% 通过。

---
_方案编制完成 · 归档于 `docs/ui-style-refactor/analysis/03-ui-style-proposal-c.md`_
