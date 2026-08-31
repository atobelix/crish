# 01 · Token 体系与全局层审计（A1）

- **审计员**：A1（前端样式审计 · 全局样式层 + 全仓量化大盘）
- **日期**：2026-08-21
- **判据**：仅仓库根 `AGENTS.md` §12（Tooltip）/ §13（输入框焦点态）/ §14（色彩空间与现代 CSS 语法）；**未读取** docs/ 下任何历史文档（铁律遵守）
- **扫描面**：`apps/crish-desktop/src/**/*.module.css` ∪ `src/styles/**/*.css`（pwsh7 正则统计，剥离注释、支持多行选择器解析）；title= 归类经逐点上下文人工复核
- **局限声明**：静态代码审计，未做浏览器运行时验证；hex 计数含 `var(--x, #hex)` 形态的 fallback 字面量（下文已区分）；`--radix-popover-content-*` 为 Radix 运行时注入变量、`--tooltip-translate` 由 `Tooltip.tsx:407` 内联注入，均属运行时契约而非断链

---

## ① 全仓量化大盘

### 1.1 总量

| 指标 | 数值 | 说明 |
| --- | --- | --- |
| 扫描 CSS 文件 | 112 个 / 29,580 行 | module.css + styles/** |
| 扫描 TSX 文件 | 469 个 | 用于 title= 线索 |
| `var(--*)` 引用总数 | **6,484** | token 化程度的主口径 |
| 硬编码 hex 字面量 | **404** | 含 var() fallback 兜底值；其中 tokens.css 107 处为定义真源（合法） |
| 旧式 `rgba(r,g,b,a)` / `rgb(r,g,b)` | **256** | 全部为逗号旧式；现代空格语法 rgb 为 0 |
| `hsl(/hsla(` 总数 | 143 | 其中旧式逗号语法 **63**、现代斜杠语法 80 |
| `color-mix(` | 346 | 现代混色已广泛使用 |
| `oklch(/lch(/hwb(` | 0 | 未使用（§14 允许，不算违规） |
| 裸数字 `z-index`（非 `var(--z-)`） | **29** | 明细见 1.4 |
| tsx 中 `title=` 出现 | 188 | 绝大多数为组件 props / 测试；**原生 DOM 属性违规确认 9 处**（见 ③ R3） |

### 1.2 硬编码 hex TOP20 文件

| 文件 | 处数 |
| --- | --- |
| styles/tokens.css | 107（定义真源） |
| components/chat-message-row/ChatMessageRow.module.css | 44 |
| components/note-paper/NotePaperPanel.module.css | 36 |
| components/settings-models/ModelsSettingsTab.module.css | 22 |
| components/ui/SmartExpandablePanel/SmartExpandablePanel.module.css | 18 |
| components/chat-tool-call/ChatToolCallBlock.module.css | 15 |
| components/ui/Select/Select.module.css | 14 |
| components/settings/FontSelectField.module.css | 13 |
| components/chat-message-row/CacheMetricsBadge.module.css | 12 |
| components/agent-card/InlineAgentPanel.module.css | 12 |
| components/chat-card/SubagentHeaderPanel.module.css | 11 |
| components/chat-message-row/FullThoughtModal.module.css | 8 |
| components/settings/SettingsDevicesTab.module.css | 7 |
| components/chat-message-row/ThoughtOutline.module.css | 7 |
| components/chat-message-row/ThoughtSearchBar.module.css | 6 |
| components/workspace/PreviewCard.module.css | 5 |
| components/ui/Menu/Menu.module.css | 5 |
| components/chat-card/UnitChromeActions.module.css | 5 |
| components/settings/SettingsRulesTab.module.css | 4 |
| components/settings/SettingsSecurityTab.module.css | 4 |

> 抽样复核：组件层 hex 大量以 `var(--token, #fallback)` 兜底形态出现（如 App.module.css:24-25、InlineAgentPanel.module.css:73-74）。该模式把「断链」掩盖成「静默降级」，是 ②-3 悬空清单长期无人发现的原因之一。

### 1.3 旧式 rgba() TOP20 文件

| 文件 | 处数 |
| --- | --- |
| components/settings-models/ModelsSettingsTab.module.css | 34 |
| styles/tokens.css | 27 |
| components/settings/FontSelectField.module.css | 18 |
| components/provider/ModelBadgePickerMenu.module.css | 17 |
| components/ui/Menu/Menu.module.css | 14 |
| components/ui/Select/Select.module.css | 13 |
| components/chat-composer/PermissionModeMenu.module.css | 10 |
| components/ui/SmartExpandablePanel/SmartExpandablePanel.module.css | 9 |
| components/chat-message-row/ChatMessageRow.module.css | 8 |
| components/diff/DiffCard.module.css | 7 |
| components/chat-composer/ComposerFusedTrigger.module.css | 7 |
| components/settings/FontSettingsSection.module.css | 6 |
| components/settings/SettingsDevicesTab.module.css | 6 |
| components/settings/SettingsPanel.module.css | 5 |
| components/binary-tree/LeafToolTabStrip.module.css | 5 |
| components/chat-card/UnitChromeActions.module.css | 5 |
| components/binary-tree/BinaryTreeWorkspace.module.css | 4 |
| components/settings/StatusDiagnosticsPanel.module.css | 4 |
| components/chat-message-row/ThoughtOutline.module.css | 4 |
| components/chat-composer/ComposePlusMenu.module.css | 4 |

### 1.4 裸数字 z-index（29 处，非 `var(--z-)`）

```
components/binary-tree/BinaryTreeWorkspace.module.css:119  z-index: 120
components/binary-tree/BinaryTreeWorkspace.module.css:147  z-index: 1
components/binary-tree/BinaryTreeWorkspace.module.css:172  z-index: 1
components/binary-tree/LeafToolTabStrip.module.css:43      z-index: 5
components/chat-card/UnitChromeActions.module.css:173      z-index: 110   ← 超 --z-chrome(100)，逼近 dropdown(300)
components/chat-message-list/FlowScrubber.module.css:84    z-index: 1
components/chat-message-list/FlowScrubber.module.css:108   z-index: 10
components/chat-message-row/ChatMessageRow.module.css:686  z-index: 2
components/chat-message-row/ChatMessageRow.module.css:739  z-index: 2
components/chat-message-row/ChatMessageRow.module.css:795  z-index: 0
components/chat-message-row/ChatMessageRow.module.css:839  z-index: 1
components/note-paper/NotePaperPanel.module.css:353        z-index: 1
components/shell/GlobalSessionTabBar.module.css:60         z-index: auto
components/shell/GlobalSessionTabBar.module.css:114        z-index: 2
components/shell/GlobalSessionTabBar.module.css:141        z-index: 2
components/shell/GlobalSessionTabBar.module.css:206        z-index: 1
components/ui/SegmentedControl/SegmentedControl.module.css:75  z-index: 1
components/ui/SegmentedControl/SegmentedControl.module.css:85  z-index: 2
components/ui/Slider/Slider.module.css:26                  z-index: 0
components/ui/Slider/Slider.module.css:37                  z-index: 1
components/ui/Slider/Slider.module.css:56                  z-index: 2
components/ui/SmartExpandablePanel/SmartExpandablePanel.module.css:335  z-index: 2
components/workspace/BrowserPanel.module.css:247           z-index: 2
components/workspace/BrowserPanel.module.css:256           z-index: 3
components/workspace/BrowserPanel.module.css:296           z-index: 4
components/workspace/BrowserPanel.module.css:384           z-index: 2
components/workspace/WorkspaceEmptyState.module.css:96     z-index: 1
extensions/conversation-flow/narrative.module.css:259      z-index: 6
styles/design-system.css:122                               z-index: 5     ← 全局层文件内的裸值
```

多数为局部堆叠（1/2/3），风险可控；但 UnitChromeActions:173 的 110、design-system.css:122 的 5 属于跨组件语境取值，应入册（见 ③ B4）。

### 1.5 原生 title= 线索（188 处的归类结论）

- 组件 props（ConfirmDialog/Dialog/SettingsPage/SettingsSection/SettingsRow/RuntimeSection/AppErrorBoundary/NotePaperStrictPanel 等）：约 170 处，**不属违规**
- 测试文件与命令元数据（AiCommandSlashExtension 等）：不计
- **原生 DOM 属性违规：确认 9 处**，逐条见 ③ R3

---

## ② tokens.css 健康度

### 2.1 结构与内部一致性

| 项 | 结果 |
| --- | --- |
| light 块（`:root, html[data-theme='default'], html[data-theme='light']`，tokens.css:3-588） | 361 个定义 |
| dark 块（`html[data-theme='dark']`，tokens.css:596-875） | 174 个定义 |
| 全仓自定义属性定义名（含 z-index.css/responsive.css/reduced-motion.css 等） | 426 个 |
| **tokens.css 内部悬空引用** | **0** ✅ |

### 2.2 light/dark 分支覆盖差集

**dark 缺失、且 light 值为颜色类的 token 共 32 个**，甄别后分三类：

1. **真缺口（1 个）**
   - `--focus-ring-subtle`（tokens.css:111，light = border 94% + text 6% 混合）：dark 块只有 `--focus-ring-strong`（tokens.css:679），无 subtle 对应 → dark 下引用该名的样式将失效。🟡
2. **自动适配型（无需 dark 覆写，值为 var 引用主题 token）**
   - `--card-header-bg`(22)、`--chart-color-1/2`(208-209)、`--chat-footer-fade`(579)、`--danger-color`(231)、`--warning-color`(233)。这些在 dark 下经被引 token（--bg-secondary/--accent-chart-*/--color-error 等，dark 均有定义）自动换肤，属健康设计。
3. **固定品牌/装饰色（有意主题不变，建议补注释声明意图）**
   - `--mac-dot-red/yellow/green`(311-313)、`--window-close-bg/fg`(257-258)、`--xterm-*` 16 色 + selection(292-308)、`--shadow-color: #000`(261，dark 靠 color-mix 百分比拉高，设计自洽)。

**dark-only（2 个）——本次最重发现之一**：

- `--accent-green-light-adaptive`（tokens.css:747）、`--accent-red-light-adaptive`（tokens.css:752）**只在 dark 块定义**，却被 `components/files/FileViewerCard.module.css:263,268,272,277` 以**无 fallback** 形式引用 → **light 主题下 diff 增删行背景整体失效**（guaranteed-invalid → background 回落 initial）。同名的 DiffCard.module.css:662-665,989 因带 color-mix fallback 而幸免。🔴

### 2.3 全仓悬空引用（引用了从未定义的 token）：69 名

按簇分组（×N 为引用次数）：

| 簇 | 成员（×次数） | 影响 |
| --- | --- | --- |
| **z-index 族（10 名 / 28 处）** | `--z-dropdown-menu`×9、`--z-card-footer`×5、`--z-sticky-bar`×3、`--z-drag-overlay`×3、`--z-breadcrumb`、`--z-decorative`、`--z-drag-highlight`、`--z-pinned-bar`、`--z-scroll-fab`、`--z-sidebar-resizer` | z-index 声明整条失效 → auto，浮层层级失控风险。注意均为「形似」注册名（注册表里是 `--z-dropdown`/`--z-resizer`），系拼写漂移 |
| 语义色别名族 | `--sem-error`×9、`--sem-warn`×3、`--status-error`×3、`--status-success`×1（design-system.css:159 自身）、`--color-text-dim`×8、`--bg-surface`×8、`--color-warn-text`×5、`--color-danger-bg/text`×2+2、`--badge-git-{a,c,d,m,r,u}-{bg,fg,border}` 15 名、`--bg-surface-subtle`、`--bg-composer`、`--text-on-brand`×2、`--tint-subtle`×2、`--accent-amber`×2、`--color-bg-subtle`、`--color-border-subtle`×2、`--brand-line`、`--tree-guide-rail` | 多数带 hex fallback 静默降级；无 fallback 者（如 ChatComposer 的 --sem-error ×9）颜色回落继承值 |
| 版式/尺寸族 | `--flow-font-meta`×10、`--flow-meta`×6、`--flow-summary-indent`×4、`--flow-meta-soft`×4、`--flow-meta-hover`×3、`--flow-thinking-max-h`×2、`--flow-output-max`×2、`--line-height-normal`×5（含 GlobalErrorBanner.module.css:24）、`--flow-chevron-color/hover`、`--flow-font-plan-title`、`--font-sub`×2、`--radius-card`、`--radius-tooltip`、`--note-paper-col-max`、`--sidebar-visible-width`、`--tree-item-height`×2 | flow-* 是跨文件「约定俗成」却从未落册的伪 token |
| 运行时注入契约（合法） | `--radix-popover-content-available-height`×7、`--radix-popover-content-transform-origin`、`--tooltip-translate`×4 | Radix / Tooltip.tsx:407 注入；建议白名单登记并统一带 fallback |

### 2.4 条件定义陷阱（当前无消费者，latent）

`reduced-motion.css:26-47` 在 `@media (prefers-reduced-motion)` 与 `[data-reduced-motion]` 作用域内定义了基础 `:root` 不存在的 `--transition-normal / --transition-slow / --transition-spring-enter / --transition-spring-exit / --transition-modal-exit`。全仓 grep 确认**当前无任何引用**——一旦未来有人引用，非还原环境下将 unset。建议要么在 tokens.css 补基础定义，要么删除死定义。

### 2.5 跨组件变量耦合（module.css 之间的隐式契约）

- `TiptapEditorField.module.css` 引用 `--composer-min-lines / --composer-max-lines / --composer-line-height`，定义却在 `ChatComposer.module.css`
- `Dialog.module.css` 引用 `--dialog-width / --dialog-z`，定义散在 `CheatsheetModal.module.css / FirstRunWizard.module.css / FullThoughtModal.module.css`

CSS Modules 本就互不可见，这类引用依赖 DOM 继承巧合，属脆弱耦合。🟡

---

## ③ 全局层问题清单（🔴违规 / 🟡漂移 / 🔵建议）

### 🔴 违规 / 功能缺陷

- **R1 · light 主题 diff 背景失效**：`--accent-green/red-light-adaptive` 仅 dark 定义（tokens.css:747,752），FileViewerCard.module.css:263,268,272,277 无 fallback 引用 → light 下 `.diffAddition/.diffDeletion` 背景为空。
- **R2 · 悬空 z-index token 族 10 名 28 处**（详见 ②-3）：如 ChatComposer.module.css、PermissionModeMenu.module.css:114、TiptapSlashMenu.module.css:22、ModelBadgePickerMenu.module.css:18、FilesCard.module.css:332,696,48,95、ChatCard.module.css:57、ProjectPickerMenu.module.css:57、GlobalSessionTabBar.module.css:432、SidebarSessionList.module.css:549、Sidebar.module.css:272、BinaryTreeWorkspace.module.css:262、ChatStatusRibbons.module.css:6、ChatMsgFilterBar.module.css:12、GlobalSessionTabBar.module.css:37、SidebarContextMenus.module.css:153、ChatMessageList.module.css:42、ChatToolCallBlock.module.css:355。z-index.css 注册表（--z-base…--z-tooltip 共 12 名）与消费端命名脱节。
- **R3 · 原生 `title=` 违反 §12（9 处确认）**：
  1. `components/ui/SmartExpandablePanel/SmartPanelHeader.tsx:44`（button「清空搜索」，已有 aria-label，title 属双轨残留）
  2. `components/workspace/LiveTasksSection.tsx:60`（div[role=button]）
  3. `components/workspace/RuntimePanel.tsx:98`（div[role=status] 引擎状态）
  4. `components/workspace/SecurityAuditSection.tsx:80`（span 审计 targets）
  5. `components/workspace/TrashSection.tsx:151`（span originalPath）
  6. `components/provider/ModelBadgePickerMenu.tsx:180`（button「模型管理...」）
  7. `components/settings-skills/SkillCardList.tsx:88`（div[role=status]）
  8. `components/settings-skills/SkillCardList.tsx:112`（div[role=status]）
  9. `components/settings-models/ModelConfigPanel.tsx:107`（span 测试状态）
  > 反证参照：chat-composer 域已有测试明文锁定「无原生 title」（ComposerField.stop.test.tsx:84-91、ComposerAttachmentBar.test.tsx:35 等），上述 9 处在该防线覆盖之外。
- **R4 · 设计真源自破**：`styles/responsive.css:2` 定义 `--breakpoint-sm: 480px`，与 tokens.css:482 的 `--breakpoint-sm: 640px` 同挂 `:root`；index.css 导入顺序（tokens 第 1、responsive 第 3）使 480px 静默胜出。「tokens.css 唯一真源」约定被打破且无任何告警。
- **R5 · 全局层文件自身引用未定义 token**：design-system.css:159 `var(--status-success, #10b981)` —— 悬空引用靠旧式 hex 兜底（§14 口径亦不符）。

### 🟡 漂移

- **Y1 · 焦点环规格 vs §13**：focus-visible.css 双轨制——通用元素走 `outline: 2px solid var(--focus-ring-color)`（focus-visible.css:10），button/a/[role=button]/[tabindex] 走 `box-shadow: var(--focus-ring)`（focus-visible.css:24）。数值面：light `--focus-ring-color`= control-mix 8% transparent（✅ 极柔）、`--focus-ring-subtle` 6% / `--focus-ring-strong` 10%、`--tint-focus-ring` 10%（均 ≤10% 上限 ✅）；**dark `--focus-ring-color` = text-primary 30% 混入（tokens.css:677），超 §13 约 10% 的上限量级**（虽是 alpha 光环非硬实线，仍标漂移）。无硬黑边、无默认重阴影 ✅。
- **Y2 · outline 类型错位**：DevHealthOverlay.module.css:69 `outline: 1px solid var(--focus-ring, var(--border-subtle))` —— `--focus-ring` 是 box-shadow 值（`0 0 0 2px …`），被当 outline-color 消费 → 整条声明 computed-value 阶段失效，焦点环实际不生效。
- **Y3 · 旧式色彩语法存量**：rgba 旧式 256 处、hsl 逗号式 63 处（含 tokens.css 自身，如 tokens.css:57 `hsl(35, 10%, 86%)`），与斜杠新式 80 处并存；§14 口径未统一。oklch/lch/hwb 0 处（合规允许）。
- **Y4 · 条件定义陷阱**（②-4）与**跨组件耦合**（②-5）。
- **Y5 · breakpoints.css 是零规则死文件**：全文 11 行纯注释（记载 `--breakpoint-desktop/tablet/phone` 等从未存在的 token），误导后来者；与 R4 一并清理。
- **Y6 · 组件层硬编码重户**：ModelsSettingsTab.module.css（hex 22 + rgba 34 双冠）、ChatMessageRow.module.css（hex 44）、NotePaperPanel.module.css（hex 36）——三处应为下一波 token 收敛优先对象。

### 🔵 建议

- **B1**：建立「运行时注入变量白名单」（`--radix-popover-content-*`、`--tooltip-translate`），并在消费端统一携带 fallback（Menu.tsx:367 已是范本）。
- **B2**：z-index.css 补齐缺失层名或把消费端改名对齐现有 12 名注册表；同时给 UnitChromeActions.module.css:173（110）与 design-system.css:122（5）两处裸值入册。
- **B3**：局部堆叠裸 z-index（1/2/3 共 20 余处）可保留，但建议以 `--z-local-*` 或注释登记堆叠意图，防跨文件叠加失序。
- **B4**：`--mac-dot-*` / `--window-close-*` / `--xterm-*` 补一行「主题不变」意图注释（部分已有），避免被后续差集清洗误伤。
- **B5**：AppErrorBoundary.module.css:17 错误卡用 `--bg-secondary`，浮于 `--bg-primary` 之上对比偏弱，可升 `--bg-card`（背景链语义见 ④-5，整体健康）。
- **B6**：index.css 的 `layer(base)` 只包了 5 个文件（index.css:5-11），tokens/design-system/shell 未分层；当前无冲突但建议在总案明确分层策略，防止未来未分层规则压过 layered 基座。

### 背景层级链专项结论（任务二-4）

定义链清晰：`--bg-primary`(Shell 外层底板) → `--bg-secondary`(侧栏/辅助层) → `--bg-tertiary`(更深一层) → `--bg-card`(Paper 白卡) → `--bg-elevated`(浮起卡片)；派生 `--bg-workspace=primary`、`--shell-chrome-bg=secondary`、`--shell-inset-bg=workspace|primary`（tokens.css:10-23,598-608）。全局层消费点抽查：shell-reset.css:31 body 用 workspace→primary ✅；design-system.css:6-10 elevation-0..4 依 primary/secondary/card/card/elevated 递阶 ✅；design-system.css:61-76 `[data-panel]` 用 elevated/modal 加重 ✅；DevHealthOverlay.module.css:15 浮层条用 elevated ✅；GlobalErrorBanner.module.css:17-21 elevated 混 warning 色 ✅。**未发现语义错位**；唯一小瑕疵即 B5。

---

## ④ Top 问题小结

1. **悬空 token 断链是系统性病灶**（69 名 / 约 130 处引用）：z-index 族 28 处直接让层级声明失效，语义色/版式族靠 hex fallback 「静默降级」长期潜伏。根因是「先写 var 后补册」的流程没有收口工具，建议把 ②-3 清单转成 style-contract 类测试逐名清零。
2. **主题分支不对称造成真实功能 bug**：`--accent-*-light-adaptive` 只在 dark 定义（R1），`--focus-ring-subtle` 只在 light 定义（Y1 姊妹现象）——light/dark 差集应纳入 CI 断言。
3. **原生 title= 在防线外仍有 9 处**（R3）：chat-composer 已证明「测试锁死」有效，建议把同样断言推广到 workspace/settings-models/settings-skills 等域。
4. **唯一真源已出现第一道裂缝**：`--breakpoint-sm` 双源冲突（R4）+ breakpoints.css 死文件（Y5），若不处理，「tokens.css 为准」的约定会持续被 import 顺序暗改。
5. **现代语法收敛过半但未收官**：color-mix 346 处已成主力，rgba 旧式 256 + hsl 逗号 63 为剩余债务，且集中在 ModelsSettingsTab/FontSelectField/ModelBadgePickerMenu 等设置域文件，适合按文件批量替换一次性清偿。
