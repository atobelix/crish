# 02-分维：未定义引用与死 Token 清零（A4）

> 上级：`00-总方案-设计Token与偏好SSOT端到端重构.md`
> 口径：**纯逻辑执行顺序与依赖拓扑**，不含工期/人天/人员/优先级。所有条目**逻辑同权**；排序仅表示依赖关系。
> 禁止：临时补丁、无终期兼容、魔术数字补偿。**不得保留空壳 token**（注释掉、`/* reserved */`、只有定义无消费的"占位"）。

---

## 零、本文的输入与依赖位置

**输入**：`node scripts/check-token-consistency.mjs`（基线 **71 / 22 / 126**）

| 指标 | 当前 | 目标 |
|---|---|---|
| `undefined_refs`（被引用但 css 与 JS 均未定义） | **71** | 0 |
| `nofallback_refs`（上者中所有引用点都无兜底，高危） | **22** | 0 |
| `dead_tokens`（CSS 定义了但 0 消费） | **126** | 0 |

**依赖**：本文执行必须晚于 `01-分维` 的 **A1（定义真源唯一化）** 与 **A2（刻度重建）**。理由：大量"未定义引用"的正确处置不是"随便定义一个值"，而是**归并到 A2 新建的刻度档或语义族**；A2 未完成时定义出来的值会立刻成为新的魔术数字。同理，`dead_tokens` 的清理须在 A3（消费者改写）之后 —— 改写会决定哪些 token 重新被需要。

---

## 一、三种处置，不允许第四种

| 处置 | 适用 | 判据 |
|---|---|---|
| **DEFINE** | 该 token 表达的是**真实存在的设计角色**（层级、状态、对比安全前景、缺失的刻度档） | 能说清它服务哪个视觉角色，且该角色在 A2 刻度中有位置 |
| **DELETE-INDIRECTION** | 变量存在但**从来没有提供方**，所有引用点都在吃 fallback | 去掉变量、把 fallback 表达式内联；变量本身删除 |
| **DELETE-SYMBOL** | 与另一 token 语义重复，或所属体系已被物理切除 | 删除定义与全部引用；引用点改用 SSOT 那一侧 |

**不允许**：把未定义引用改成"定义成一个等价于 fallback 的值"就算完事。若 fallback 就是设计意图，则属 DELETE-INDIRECTION；若设计意图另有其物，则属 DEFINE 且必须给出刻度依据。

---

## 二、高危 22 条（`nofallback_refs`）逐条处置

### 2.1 crish-desktop（15 条）

| # | token | 引用点 | 处置 | 依据 |
|---|---|---|---|---|
| 1 | `--sem-error` | 11 处，`ChatComposer.module.css:151,196,285`、`AttachmentCard.module.css:280`、`PermissionModeMenu.module.css` 等 | **DELETE-SYMBOL** → 改用 `--color-error` | tokens.css 已有 `--color-*` 状态族；`--sem-*` 是平行命名族，属多轨 |
| 2 | `--sem-warn` | 3 处，`ChatComposer.module.css:187,191`、`PermissionModeMenu.module.css:77` | **DELETE-SYMBOL** → `--color-warning` | 同上 |
| 3 | `--sem-warn-soft`（带 fallback） | `ChatComposer.module.css:70` | **DELETE-SYMBOL** → A2 §2.7 的 `--color-warning-soft` | 同上；"soft" 档由 A2 新建 |
| 4 | `--error-color` | 5 处，`ComposerNoticeBar.module.css:50,51,55,56…` | **DELETE-SYMBOL** → `--color-error` | 第三个平行命名 |
| 5 | `--text-warning` | `OverviewChangesList.module.css:98`、`SettingsDevicesTab.module.css:63` | **DEFINE**（`--color-warning-text`） | "状态色作为文字"是独立角色（需满足对比度），不能直接用 base 色 |
| 6 | `--color-error-contrast`（带 fallback） | `NoteSidebarDrawer.module.css:461` | **DEFINE**（`--color-error-text-on`） | 与 A2 §2.7 的 `text-on` 角色同构 |
| 7 | `--text-faint` | 12 处，`ChatMessageRow.module.css:212,726`、`ReasoningRow.module.css:310`、`TimelineThoughtSection.module.css:86` 等 | **DEFINE** | tokens.css 只有 `primary/secondary/tertiary` 三级，实际使用存在第四级弱化；定义为 `--text-quaternary` 或保留 `--text-faint` 名但必须由 `--text-tertiary` 派生 |
| 8 | `--text-inverse` | `NoteSidebarDrawer.module.css:461` 附近 | **DEFINE** | 反色前景是独立角色；不得用 `--text-primary` 代替（暗色下语义反转） |
| 9 | `--text-on-overlay` | `AttachmentCard.module.css:308`、`ChatComposer.module.css:823` | **DEFINE** | 浮层上的前景需按浮层底色定对比，角色独立 |
| 10 | `--font-weight-regular` | `ReasoningRow.module.css:179` | **DEFINE**（别名 `var(--weight-regular)`） | 语义别名，数值已有档 |
| 11 | `--tint-subtle` | `Menu.module.css:175` | **DEFINE** 或 **DELETE-SYMBOL** | 已有 `--tint-highlight`；若 `subtle` 是另一档则 DEFINE 进 tint 族并给出两档语义差，否则归并 |
| 12 | `--shadow-dropdown` | 3 处，`ComposerFusedTrigger.module.css:201`、`FontSelectField.module.css:80`、`SettingsUI.module.css:309` | **DEFINE** | 正是 A2 §2.5 缺的高程档（`dropdown` 档） |
| 13 | `--shadow-popover`（带 fallback） | `UsageTrendChart.module.css:102` | **DEFINE**（`popover` 档） | 同上 |
| 14 | `--diff-bg-header` | `custom-tags.module.css:229,270` | **DEFINE**（diff 族） | diff 表头底色是真实角色；须归入统一 diff 族（与 `--diff-*` 死 token 一并重建） |
| 15 | `--sep-danger-bg-hover` | `SmartPanel.module.css:141` | **DELETE-SYMBOL** → 语义状态色 | `--sep-*` 是 27 个 token 的平行体系，总方案 §五已定"合并为语义层别名" |

### 2.2 `--z-*` 家族（8 条，跨高危与带兜底两组）

未定义：`--z-decorative`、`--z-pinned-bar`、`--z-sticky-bar`（高危）；`--z-context-menu`、`--z-drag-highlight`、`--z-drag-overlay`、`--z-dropdown-menu`、`--z-index-popover`、`--z-smart-panel`、`--z-smart-panel-sub`（带兜底）。

**处置：全部 DEFINE**，写入 `z-index.css` 的**单一标尺**（A2 §2.6）。
**为何高危**：`z-index: var(--z-pinned-bar)` 在未定义且无兜底时，整条声明失效 → `z-index` 退回 `auto` → 钉选栏/粘性栏的层叠关系失效。这是"样式假象"，且必须在 DEFINE 后按 A2 §2.6 的**祖先盒模型与 Stacking Context 穿透规范**复核一遍（`transform`/`filter`/`will-change`/`contain`/`opacity<1` 都会新建层叠上下文）。

### 2.3 avatar-studio（7 条）

`--accent`、`--accent-bg`、`--accent-border`、`--border`、`--shadow`、`--social-bg`、`--text-h`（全部在 `apps/avatar-studio/src/App.css`）。

**处置（二选一，必须显式决策）**：
- (a) **接入体系**：在 tokens.css 建立对应语义并改写 `App.css`；
- (b) **独立声明**：该应用自带 token 文件明确定义这 7 个，并在门禁中显式声明其扫描边界。

**不允许**：因为"这个应用依赖 vendored 库"就把它们留在门禁红名单里。当前 `App.css` 的多数样式依赖 `@oneworks/avatar-react` 的 180+ 个 token（`--primary-color` 319 次引用等），属**该应用独立于本 token 体系**——若选 (b)，须把"avatar-studio 不纳入本体系"作为显式架构决策记录，并把扫描根从默认集合中移除（而非让指标长期不为 0）。

---

## 三、带兜底的 49 条逐组处置

### 3.1 `--tooltip-*`（6 条）→ **DELETE-INDIRECTION**

`--tooltip-bg` / `--tooltip-border` / `--tooltip-padding` / `--tooltip-radius` / `--tooltip-shadow` / `--tooltip-white-space`，仅被 `components/ui/Tooltip/Tooltip.module.css:46-54` 引用，**全仓无任何提供方**（已核实：`grep --tooltip-bg` 只命中该 CSS 自身）。即所有引用点永久吃 fallback —— 这组变量是"预留但从未接线"的钩子。

处置：把 fallback 表达式内联进声明，**删除这 6 个变量**。
若产品确需"tooltip 可主题化"，则改为 DEFINE 并在 `TokenRuntimeController` 中真实注入（不得只定义不注入——那是功能伪连通）。

### 3.2 动画双前缀重复（8 条）→ **DELETE-SYMBOL（删一族）**

`streaming-animation.css` 同时存在两套同义前缀：`--sd-duration` / `--sd-delay` / `--sd-marker-duration` / `--sd-marker-delay`（`:33,35,54`）与 `--conex-duration` / `--conex-delay` / `--conex-marker-duration` / `--conex-marker-delay`（同处）。

同一概念两个前缀 = 多轨。处置：**保留一族、删除另一族**，保留族 DEFINE 进 A2 §2.8 的动效四族时长。

### 3.3 `--stream-table-*`（4 条）→ 与死 token `--stream-*`（3 条）合并

`--stream-table-active-border`、`--stream-table-active-glow`、`--stream-table-pulse-duration`、`--stream-table-pulse-timing`（`StreamingTableContainer.module.css:86,87,106`）与死 token `--stream-pulse-bg` / `--stream-pulse-duration` / `--stream-pulse-glow` 是同一组视觉的两种命名。处置：**归并为单一前缀**，DEFINE 需要的、DELETE 重复的。

### 3.4 diff 族（3 + 4 + 2 条）→ 统一重建

带兜底：`--diff-bg-pane`、`--diff-gutter-fg`、`--diff-gutter-marker-width`、`--diff-gutter-width-split`、`--diff-gutter-width-unified`、`--diff-text-normal`；
死 token：`--diff-add-word-bg`、`--diff-del-word-bg`、`--diff-mod-bg`、`--diff-mod-fg`；
高危：`--diff-bg-header`。
处置：建**单一 diff 族**（底色/前景/表头/行号槽/词级增删改），逐条 DEFINE 或 DELETE，禁止存在两个并行的 diff 命名。

### 3.5 `--aicard-*`（3 条）→ 组件域 DEFINE

`--aicard-badge-border`、`--aicard-chevron-fg`、`--aicard-pulse-color`（`custom-tags.module.css:14,434,440`）属 `custom-tags` 组件的域内变量。处置：在**该组件自身 CSS 的 L3 组件域**定义（值来自 semantic 派生），或 DELETE-INDIRECTION。

### 3.6 其余零散（须逐条 DEFINE/归并，不得留白）

| token | 处置方向 |
|---|---|
| `--spacing-sm` / `--spacing-md`（`AccountAuthCard.module.css:4,11`） | **DELETE-SYMBOL** → A2 §2.2 的 `--space-*` 刻度 |
| `--font-sub`（`ChatCard.module.css:129`） | **DELETE-SYMBOL** → A2 §2.3 字号档 |
| `--line-height-normal`（`ChatStatusRibbons.module.css:140`） | **DELETE-SYMBOL** → A2 §2.3 行高配对表 |
| `--bg-composer` / `--bg-popover` / `--bg-surface`（`ChatComposer:1175`、`NotePaperPanel:190`、`ChatCard:207`） | **DELETE-SYMBOL** → 现有 `--bg-*` 语义族（若确缺角色则 DEFINE 进该族） |
| `--composer-radius-single`（`ChatComposer.module.css:1174`） | **DELETE-SYMBOL** → A2 §2.1 的 `--r-*` |
| `--sep-font-size-header` / `--sep-submenu-radius` | 随 `--sep-*` 族整体并入语义层 |
| `--accent-orange-strong`（`PermissionModeMenu.module.css:81`） | **DEFINE** 进 primitive 色阶（A1-2），或归并到已有 orange 档 |
| `--note-paper-col-max` / `--flow-output-max` / `--diff-gutter-*-width` | **DEFINE** 为组件/布局域常量（非颜色），值须来自 A2 尺寸刻度或明确的比例依据 |
| `--z-index-popover` 等 | 见 §2.2 |
| `--toast-*`（6 条） | **已由脚本精度修复移出本清单**（`ToastCard.tsx:103-110` 真实注入，见基线文档"精度修复"节） |

---

## 四、死 token 126 条逐组处置

| 组 | 数量 | 处置 |
|---|---|---|
| `--accent-*` | 10 | A1-2 色阶重建时统一；无角色的 DELETE-SYMBOL（`--accent-inverted`、`--accent-light`、`--accent-secondary`、`--accent-soft`、`--accent-violet*`、`--accent-*-light-adaptive`、`--accent-green-hover/-soft` 需逐个判定是否有角色） |
| `--composer-*` | 9 | 归并到语义层或组件域；`--composer-pad-x/-y` → `--space-*`；`--composer-*-bg` → `--bg-*` |
| `--md-*` | 9 | 归并到 markdown 族；`--md-hr-margin`/`--md-paragraph-margin-bottom-chat` → `--space-*`；`--md-line-height-chat` → 行高配对表 |
| `--bg-*` | 8 | `--bg-glass`/`--bg-overlay`/`--bg-panel`/`--bg-paper` 与现有 `--bg-*` 语义族合并；`--bg-card-hover`/`--bg-item-active`/`--bg-item-hover` 若无角色则删 |
| `--scrollbar-button-*` + `--scrollbar-thumb-min-size` | 7 | 滚动条族整组判定：要么接入（当前 overlay 滚动条实现是否消费？）要么删 |
| `--transition-*` | 7 | 归并到 A2 §2.8 动效四族；`--transition-spring*` 若与弹簧档重复则删 |
| `--usage-*` | 6 | 图表/用量面板族，DEFINE 或删 |
| `--space-0/-12/-16/-1_25/-1_75` | 5 | **注意**：`--space-12/-16` 与 A2 新刻度同名冲突，须按 A2 目标刻度重定义；`-1_25/-1_75` 属非整数档，DELETE |
| `--breakpoint-*` | 4 | **全删**（桌面端无流式断点，0 消费；`tokens.css` 已有 8 个 breakpoint token 全部空闲） |
| `--diff-*` | 4 | 见 §3.4 |
| `--ui-text-*` | 4 | 与 `--text-*` 平行命名 → DELETE-SYMBOL |
| `--control-pad-*` | 3 | `--space-*` 或密度族 DEFINE |
| `--dropdown-gap/-padding/-radius` | 3 | → `--space-*` / `--r-*` |
| `--easing-*` | 3 | → A2 §2.8 缓动档；`--easing-emphasized` 与 `--ease-emphasized` 重复，删其一 |
| `--font-mono-features`/`--font-size-chat`/`--font-size-xxl` | 3 | 字号档归并；`--font-size-xxl` 与 `xl` 重复，删 |
| `--item-padding/-radius/-font-size` | 3 | → `--space-*`/`--r-*`/字号档 |
| `--mac-dot-*` | 3 | 若窗口按钮实现未用则删（当前 `WindowControls` 用的是 `--window-close-*`） |
| `--sep-*` | 3 | 随 `--sep-*` 族整体切除 |
| `--stream-pulse-*` | 3 | 见 §3.3 |
| `--tab-pad-x`/`--tab-tool-pad-*` | 3 | → `--space-*` |
| `--titlebar-*` | 3 | → 密度/尺寸族 DEFINE 或删 |
| `--chart-color-1/2` | 2 | 图表色族 DEFINE（现有 `--chart-color-*` 体系需统一） |
| `--duration-instant/-slow` | 2 | → 动效四族 |
| `--focus-ring-strong/-subtle` | 2 | → 焦点族；A2 §2.8 要求全覆盖 `:focus-visible` |
| `--panel-layout`/`--panel-sec-gap` | 2 | 语义化或删 |
| `--radius-switch-track`/`--radius-tooltip` | 2 | 均为 `var(--r-full)` 的重复 → **DELETE-SYMBOL** |
| `--row-height`/`--row-height-sm` | 2 | → 密度族 `row = ctrl` |
| `--shell-gutter`/`--shell-inset-bg` | 2 | shell 族 DEFINE 或删 |
| `--window-close-bg/-fg` | 2 | 与 `WindowControls.module.css` 的 `#e81123` 硬编码一体处置：DEFINE 并让组件改用 |
| 单条（`--backdrop-blur`、`--card-header-bg`、`--ease-in-out`、`--line-height-relaxed`、`--pill-radius`、`--shadow-drag`、`--z-drawer`） | 7 | 逐条 DEFINE 或 DELETE；`--backdrop-blur` 当前值为 `none` 属永久空转，删或真实现 |

**统一规则**：每一条的终态只有两种 —— **被真实消费** 或 **不存在**。中间态（定义了没人用）不作为可接受的稳定状态；门禁 `dead_tokens` 指标单调降为 0。

---

## 五、执行序列（依赖顺序）

| 步 | 内容 | 前置 |
|---|---|---|
| 1 | §2.2 `--z-*` 家族 DEFINE + A2 §2.6 的层叠穿透复核 | A2 §2.6 标尺定稿 |
| 2 | §2.1 的 DELETE-SYMBOL 类（`--sem-*` / `--error-color` / `--sep-danger-*`）→ 改写为 `--color-*` | A1 完成（`--color-*` 族为 SSOT） |
| 3 | §2.1 的 DEFINE 类（`--text-faint` / `--text-inverse` / `--text-on-overlay` / `--color-*-text` 等） | A2 §2.3 文字层级与 §2.7 状态六元组定稿 |
| 4 | 高程类 DEFINE（`--shadow-dropdown` / `--shadow-popover`） | A2 §2.5 九档定稿 |
| 5 | §3.1 `--tooltip-*` DELETE-INDIRECTION | 无（可独立执行） |
| 6 | §3.2 动画双前缀删一族 + §3.4 diff 族统一 + §3.3 stream 族统一 | A2 §2.8 动效定稿 |
| 7 | §3.6 零散归并 | A2 刻度定稿 |
| 8 | §2.3 avatar-studio 显式决策 | 无（可独立执行） |
| 9 | §四 死 token 清理 | **A3 消费者改写完成之后**（改写决定去留） |
| 10 | 每步后 `node scripts/check-token-consistency.mjs --update` 仅在指标下降时刷新基线 | 上一步完成 |

**门禁收敛纪律**：三项指标**只降不升**。`--update` 只在下降时使用；任何上升都必须先修问题，不得提升基线掩盖（脚本本身对上升直接 exit 1）。

---

## 六、负向断言（须与代码同时落地）

```
A4-V1   undefined_refs === 0
A4-V2   nofallback_refs === 0
A4-V3   dead_tokens === 0
A4-V4   全仓不存在标识符 --sem-error / --sem-warn / --sem-warn-soft
A4-V5   全仓不存在标识符 --error-color（统一为 --color-error）
A4-V6   全仓不存在 --sep-* 前缀（该族已并入语义层）
A4-V7   全仓不存在 --tooltip-bg / --tooltip-border / --tooltip-padding /
          --tooltip-radius / --tooltip-shadow / --tooltip-white-space
A4-V8   --sd-duration 与 --conex-duration 不同时存在（动画前缀唯一）
A4-V9   --easing-emphasized 与 --ease-emphasized 不同时存在
A4-V10  --radius-2xl / --font-size-2xl / --radius-tooltip / --radius-switch-track 不存在
A4-V11  全仓不存在 --breakpoint-*（若决策为删）
A4-V12  每个 --z-* 引用点对应的 token 均有定义（z-index: var() 不得落空）
A4-V13  avatar-studio 的扫描边界与决策一致（纳入 → 其 7 条为 0；排除 → 默认扫描根不含该路径）
A4-V14  token 一致性脚本在无 --update 时对任何指标上升 exit 1（脚本自测用例）
```

---

## 七、与门禁的接线关系

- 本文所有断言的**机械载体**是 `scripts/check-token-consistency.mjs` 的三项指标 + 未来分批落地的符号级断言（A4-V4~V13 属"符号不存在"类，应并入 G3/G5/G6 同族的正则门禁，而非塞进本脚本——本脚本只做"引用/定义集合完整性"）。
- 三项指标降到 0 后，脚本的基线应固化为 `0/0/0`，此后任何新增未定义引用或死 token 立即失败。

---

*本文清单由 `node scripts/check-token-consistency.mjs --list` 实测导出（基线 71/22/126）。所有位置锚点均经复核；脚本已修正三类假阳性（注释示例、计算键、按名读取），修正记录见 `docs/multi-agent-repair/基线记录/token-consistency-baseline.md`。*

---

## 八、执行记录（2026-09-10）

### 8.1 结果

| 指标 | 起始 | 终态 |
|---|---|---|
| `undefined_refs` | 71 | **0** |
| `nofallback_refs` | 22 | **0** |
| `dead_tokens` | 126 | **0** |

基线已冻结为 **0 / 0 / 0**（`docs/multi-agent-repair/基线记录/token-consistency-baseline.md`）：此后任何新增未定义引用或死 token 立即 fail。

### 8.2 处置统计

| 处置类型 | 数量 | 说明 |
|---|---|---|
| **DEFINE**（补真实定义，全部为派生或同值别名） | 11 | `--text-faint` / `--text-inverse` / `--text-on-overlay` / `--text-warning` / `--tint-subtle` / `--shadow-dropdown` / `--shadow-popover` / `--radius-btn` / `--diff-bg-header` / `--diff-gutter-*`(3) |
| **DELETE-SYMBOL**（归并到 SSOT 那一侧） | 24 | `--sem-error`(11) / `--sem-warn`(3) / `--sem-warn-soft`(1) / `--error-color`(5) / `--sep-danger-bg-hover`(1) / `--font-weight-regular`(1) / `--spacing-md`(2) / `--spacing-sm`(2) / `--sep-submenu-radius`(1) / `--sep-font-size-header`(1) / `--font-sub`(2) / `--line-height-normal`(4) |
| **DELETE-INDIRECTION**（摘掉从不生效的外层变量，保留内层表达式） | 32 | `--tooltip-*`(6) / `--aicard-*`(3) / `--diff-*`(4) / `--stream-table-*`(4) / `--sd-*`≡`--conex-*`(8) / `--bg-composer`·`--bg-popover`·`--bg-surface` / `--composer-radius-single` / `--accent-orange-strong` / `--note-paper-col-max` / `--color-error-contrast` 等 |
| **物理删除死 token 定义** | **253 处声明 / 6 个文件** | 主战场 `tokens.css`(227) + `reduced-motion.css`(16) + `markdown-typography.css`(5) + 组件 CSS(4) + `z-index.css`(1) |

### 8.3 关键动作

1. **`--sem-*` 平行命名族归并**：`--sem-error/--sem-warn` 全量改写为 `--color-error/--color-warning`；`--sem-warn-soft` → `--color-warning-bg`（同时消灭了硬编码 `hsl(38, 90%, 50%)` 兜底）。至此状态色只剩 `--color-*` 一族。
2. **`--tooltip-*` 6 个变量物理切除**：全仓无任何提供方（只有 `Tooltip.module.css` 引用且吃兜底）→ 判定为空转钩子，摘掉外层并内联兜底表达式。
3. **动画双前缀收敛**：`--sd-*` 与 `--conex-*` 是同义双前缀（同文件内互相嵌套 fallback）→ 收敛到既有的 `--stream-anim-word-fade` / `--stream-anim-marker-fade` / `--stream-anim-easing`。
4. **z-index 家族补全**：10 个未定义引用（`--z-pinned-bar` / `--z-sticky-bar` / `--z-context-menu` / `--z-drag-*` …）全部定义为**既有 7 级标尺的角色别名**，不新造数值。此前这些 `z-index: var(...)` 整条声明无效、退回 `auto`。
5. **死 token 级联清理**：删除 `--chart-color-*` 后其浮出 `--accent-chart-in/-out` 一并删除；`--panel-layout` 的三个专用 `@container` 块（唯一用途是写一个没人读的状态标志）整块删除。

### 8.4 诚实记录：一处误删与恢复

首次批量删除把 3 个**有引用**的定义误判为死 token 并删除：
`--radius-circle: 50%`（`ModelsSettingsTab.module.css:115`）、`--font-weight-code: 400`（`ChatMessageRow.module.css:376`）、`--scrollbar-track-safe-gap: 2px`（`ScrollArea.module.css:148`）。

发现方式：删除后 `undefined_refs` 由 0 反弹为 3。三者已按 `git diff` 中的原值**原样恢复**，指标回到 0。删除脚本的分类准确率为 250/253；删除前对每个被改文件做了仓库外备份（`%TEMP%/token-del-backup`）。

### 8.5 精度修复（门禁假阳性，共 3 类）

详见基线文件"精度修复"节：注释内示例、对象计算键（`['--toast-index' as string]:`）、按名读取（`readCssVar('--xterm-*')`）。若不修，门禁会指挥人去删 xterm 的 17 个在用主题 token。

### 8.6 与本次执行无关的外部变更（记录留痕）

执行期间，`apps/avatar-studio/src/` 整个目录被**外部进程**清除（我只对该目录下的 `App.css` 执行过单文件删除，`git rm <单文件>` 不可能删除整个目录；该目录的 `dist`/`node_modules` 修改时间为本次会话期间）。该应用原持有的 7 项未定义引用（`--accent` / `--accent-bg` / `--accent-border` / `--border` / `--shadow` / `--social-bg` / `--text-h`，均在 Vite 模板遗留的 `App.css`）随目录消失。**按仓库纪律 §3.2「严禁回撤」，本次未做任何恢复动作，也未触碰该路径。**

### 8.7 验证

| 验证项 | 结果 |
|---|---|
| `node scripts/check-token-consistency.mjs` | **0 / 0 / 0**，PASS |
| `tsc -b`（构建第一步，类型检查） | **通过** |
| Vite 构建（全模块 + 全 CSS 转换） | **通过转换**，在 `generateBundle` 阶段因既有 chunk 体积门禁失败 |
| 既有样式门禁 `check:text-color` / `check:color-ssot` / `check:markdown-style` | **PASS**（未被本轮改动破坏） |
| `check:token-consistency` / `check:icon-ssot` / `check:no-pseudo-dispatch` / `check:blocked-executable-ssot` / `check:no-nonvision-dataurl` / `check:line-counts` / `check:sec6-note-drain-entropy` | **PASS** |
| `check:ui-layer` / `check:swallowed-errors-frontend` | FAIL —— **本轮之前即存在的两项红**（`MarkdownDocumentView.tsx` 反向依赖、4 个文件的未注解空 catch） |

**关于 chunk 体积门禁失败的归属**：阈值 `CHUNK_SIZE_GATE_KB = 600`（`apps/crish-desktop/vite.config.ts:40`），失败项为 `chat-bridge` = 657.1 kB。本轮**未修改任何 JS/TSX**，`chat-bridge` chunk 的源码零改动；且本轮对 CSS 的净效果是**删除**（253 处声明）而非新增。故该失败与本轮改动无关，属工作区其它改动所致。
