# 前端样式体系与跨组件一致性审计报告

> 审计范围：`apps/crish-desktop/src`（index.css + 30 全局样式文件 + 81 个 `.module.css`，token 体系见 `styles/tokens.css` 785 行 / `styles/theme-dark.css` 265 行 / `styles/z-index.css`）。
> 审计方式：只读静态分析；全部结论带 `文件:行号` 证据。
> 审计日期：2026-08-09。
> 关联文档：`docs/ui-style-audit/01-style-degradation-audit.md`（退化定位，本报告在其之上深入"同效果多实现"横切面，不重复其浅层发现）；`docs/frontend-audit/10-analysis/02-component-architecture-audit.md`（TSX 层重复实现，本报告聚焦 CSS 层）。

## 0. 结论摘要

- **核心病灶**：同一视觉效果的实现不是"token 化的单一来源"，而是"全局类 + ui 原子类 + 各 module 私有类"多轨并存，且各轨内部数值互不相同。最典型量化证据：**全仓 423 处 `color-mix(in srgb, var(--text-primary) X%, …)` 直接混色，X 取值多达 31 个档位（1.2% ~ 42%）**——同一种"hover/激活淡染"效果在代码里拥有 31 种强度。
- **新发现悬空引用（01 审计未覆盖）**：`--accent-green-light-adaptive`（DiffCard.module.css:583，无 fallback → 变更面板内联"接受"按钮 hover 背景渲染无效）、`--accent-red-light-adaptive`（DiffCard.module.css:880，同理）、`--tooltip-translate`（双份 Tooltip 各 4 处，无 fallback → tooltip 入场 scale 动画整体失效，仅剩 opacity）。
- **按钮体系三轨并行**：`.ui-btn-*` 全局类（shell-polish.css）服役中；`ui/Button` 原子组件（Button.module.css）**全仓零消费**；128 个组件文件裸 `<button>` 配私有类。三条轨道的 primary/secondary/ghost/danger 语义互不一致。
- **统计摘要**：`!important` 全仓 **673 处**（module.css 191 + 全局 482）；module.css 硬编码色值 48 处、硬编码 `Npx` 2440 处、硬编码圆角 79 处（其中 `999px` 药丸 28 处）；滚动条 `::-webkit-scrollbar` 31 个块、12+ 种不同实现；仅 3 个 module.css 自带 dark 分支，暗色适配主要靠 theme-dark.css 补丁式覆盖（265 行）。
- 严重度：**P0 × 3、P1 × 8、P2 × 10、P3 × 9**，见 §6。

---

## 1. 同效果多实现清单（核心）

### 1.1 按钮：三轨并行 + primary 语义分裂

| 实现轨道 | 位置 | 形态关键值 | 差异点 |
|---|---|---|---|
| `.ui-btn` 全局类 | shell-polish.css:18-30 | radius-md（6px）、无 disabled 态规则 | sm/md 硬编码 28px/12px/999px（:32-37）与 md 32px/14px（:39-43） |
| `ui/Button` 原子类（**零消费**） | Button.module.css:32-99 | 尺寸用 `--control-height-sm/--space-3/--radius-full` | 与 .ui-btn 数值等价但 token 化；**有** `:disabled` opacity（:26-29）；md 用 radius-md 而 sm 用 radius-full（与 .ui-btn 一致） |
| 裸 `<button>` + 私有类 | 128 个组件文件（02 审计 §1.3） | 各文件自定 | 见下方差异举证 |

**"primary"语义分裂（同叫 primary，四种长相）**：

| 实现 | 位置 | 背景 | 说明 |
|---|---|---|---|
| `.ui-btn-primary` / `.buttonPrimary` | shell-polish.css:45-51 / Button.module.css:46-53 | `--accent-color`（深炭古铜） | 全局标准 primary |
| `TelemetryDialog.btnPrimary` | TelemetryDialog.module.css:33-36 | `--accent-blue`（亮蓝 hsl(217,91%,60%)） | **全仓唯一蓝色 primary** |
| `FirstRunWizard.firstRunBtn.primary` | FirstRunWizard.module.css:218-221 | `--text-primary` 反相（dark 下为白底） | 反相 inverted primary |
| `WithdrawConfirmDialog.confirmBtn` | WithdrawConfirmDialog.module.css:69-76 | `--danger-color` 红底白字 | 危险确认用实心红 |

同效果差异证据：FirstRunWizard 圆角 `--radius-xl`（10px）而 .ui-btn 为 radius-md/999px（:209）；padding 9px 14px；ghost 带 1px border（:228-232）而 .ui-btn-ghost 无 border。TelemetryDialog btn padding `--space-2/--space-4`（:25）与 .ui-btn 的 28px/12px 不同。

**Icon-only 按钮**：ChatQueuePanel actionBtn 24×24/radius-sm（:81-85）、ChatHeader toolBtn 26×26/**radius 6px 硬编码**（:96）、GlobalSessionTabBar tabAdd 26×26/radius-md（:289-295）、LeafToolTabStrip addTabBtn 20×20/999px（:149-152）、DiffCard inlineActionBtn、ModelsSettingsTab modelsIconBtn——6 种以上尺寸与圆角。

**危险按钮**：BgTaskCard.btnDanger 实心红 radius-sm/3px 8px/font-xxs（:335-344）vs ChatQueuePanel.actionBtn.danger hover 淡红（:102-105）vs .ui-btn-ghost.danger hover（shell-polish:79-82）vs killBtn 描边红（BgTaskCard:264-285）——同一"危险操作"4 种呈现。

### 1.2 输入框 / 文本框：focus 反馈互不相同

| 实现 | 位置 | 默认 | focus 反馈 |
|---|---|---|---|
| `.ui-input` | shell-polish.css:100-119 | 7px 10px / border-color / radius-md | focus = **border-color 不变 + box-shadow none**（:112-116，聚焦无可见反馈） |
| `.settings-field-input` | settings-base.css:86-154 | control-height / 0 12px / border-subtle / radius-md | focus = border-color + bg-card + box-shadow none（:148-154） |
| `ui/Input .input`（零消费） | Input.module.css:21-50 | control-height / space-3 / border-subtle / radius-md | focus = border-color + bg-card + **focus-ring**（:45-50） |
| ChatMsgFilterBar `.input` | ChatMsgFilterBar.module.css:22-49 | 24px 高 / text-primary 4% 淡底 / radius-sm | focus = border-color-mix(94/6) + 底变透明（:45-49） |
| SidebarNav 搜索 | SidebarNav.module.css:63-78 | 内嵌 navItem 透明 | 无独立 focus（靠父级） |
| ProjectPickerMenu searchBox | ProjectPickerMenu.module.css:85-103 | bg-secondary 无边框 | 无 |

同一"聚焦"：有的给 focus-ring 阴影、有的改底、有的啥也不做（.ui-input）。

### 1.3 菜单 / 下拉：10+ 种壳层，圆角 6px~16px

| 实现 | 位置 | 圆角 | 边框 | hover 底 | 阴影 |
|---|---|---|---|---|---|
| ui/Menu（正主） | Menu.module.css:5-21 | `--dropdown-radius`(md) | hairline-strong | `--bg-hover` | shadow-lg |
| `.tabs-add-menu` | shell-polish.css:503-537 | radius-2xl | text-primary 6% | 5.5% 混色 | 自定义 8% |
| `.panel-dropdown` | shell-menus.css:3-15 | radius-2xl | border-color | `--bg-hover` | shadow-lg |
| `.context-menu` | shell-menus.css:245-258 | **16px 硬编码** | border-color | `--control-soft-bg-hover` | shadow-lg |
| `.sort-filter-menu` | shell-menus.css:317-328 | radius-2xl | border-subtle | 6% 混色 | shadow-lg |
| `.settingsSelectMenu` | SettingsSelect.module.css:101-113 | radius-2xl | border-color | `--bg-hover` | shadow-lg |
| `.addDropdownMenu` | LeafToolTabStrip.module.css:175-192 | **8px 硬编码** | border-subtle | `--bg-hover` | 自定义 8% + inset；**bg-primary 非 elevated** |
| ComposePlusMenu `.main` / `.slim` | ComposePlusMenu.module.css:14-26 / 95-107 | 2xl / xl | border-color / text-primary 10% | 5.5% | shadow-lg / 自定义 |
| `.sbQuickMenu` | SettingsQuickMenu.module.css:44-58 | radius-xl | border-color | `--bg-hover` | shadow-lg |
| `.chat-more-menu` | chat-composer.css:9-20 | radius-2xl | text-primary 6% | 5.5%（:40-42） | shadow-lg；**bg fallback `#fff`（light-only）** |
| TiptapSlashMenu | TiptapSlashMenu.module.css:18-31 | **radius-md（6px）** | border-color | 7% | **box-shadow: none !important** |
| SidebarContextMenus | SidebarContextMenus.module.css:4-8 | radius-2xl | — | `--bg-hover` | — |

不一致度：圆角 6/8/10/12/16px 五档；hover 淡染 5.5%/6%/7%/bg-hover/control-soft-bg-hover 五种；有的带阴影有的 `!important` 禁阴影；菜单项 padding 8px 10px / 9px 10px / 6px 8px / item-padding 各异。

### 1.4 Toast / 通知条

- Toast 唯一通道 `useToastQueue + ToastStack`（02 审计），但 ToastStack.module.css 自身双重动画声明：`:48` `animation: slideInUp var(--transition-popover-enter)` 与 `:127-129` `.toastAlert { animation: toast-slide-in var(--transition-enter) forwards }` 同选择器重复声明（后者胜出）；**`@keyframes slideInUp` 全仓未定义**（死引用）。
- 通知类呈现不统一：RunNoticeBar（RunNoticeBar.module.css）、SetupHintBanner（SetupHintBanner.module.css）、PlanGoalRibbons（PlanGoalRibbons.module.css）、ChatStatusRibbons 动态 chip（:27-77）、ApprovalDock（ApprovalDock.module.css）——五种"会话内提示"各写各的底色/圆角/动画，无公共通知组件。

### 1.5 徽标 / chip / pill：4+ 套，状态色系互相独立

| 实现 | 位置 | 关键值 |
|---|---|---|
| `.ui-badge` | shell-polish.css:88-98 | font-xxs / 1px 6px / 999px / bg-tertiary |
| BgTaskCard `.badge` | BgTaskCard.module.css:53-93 | font-nano(10px) / 1px 6px / 999px；状态色：running=accent-blue、succeeded=accent-green、failed=accent-danger、killed=bg-tertiary+border |
| ChatStatusRibbons `.dynamicChip` | ChatStatusRibbons.module.css:38-68 | 高 26px / 0 10px / 999px / 透明+border，active=accent 10% |
| McpSettingsTab `.mcpStatusPill/.mcpStateBadge` | McpSettingsTab.module.css:28-57 / 152-178 | 两套 pill+badge，状态色 kindOk/Warn/Err 各带色相 |
| ModelsSettingsTab `.mrlItemTag/.mrdPill/.mrdCapPill` | ModelsSettingsTab.module.css:113-123 / 199-211 / 848-878 | 三套 pill，on/off 态色互不同（on=text-primary 8% vs 5.5% 混色 vs accent-green） |
| Sidebar `.modeChip` | Sidebar.module.css:61-85 | border-color / bg-primary / 3px 8px / **999px 硬编码** |
| PermissionModeMenu `.permPill` | PermissionModeMenu.module.css:1-24 | 独立一套 |
| ChatMessageRow `.planApproveChip/.followupChip` | ChatMessageRow.module.css:126-220 | 独立一套 |

### 1.6 Tooltip：双份 + 第三种皮肤

- `components/Tooltip/Tooltip.module.css`（94 行，服役中，88 个业务文件 import）与 `ui/Tooltip/Tooltip.module.css`（97 行，**零消费**）内容逐行重复（仅多注释）；`--tooltip-translate` 均无 fallback（各自 :18-36）→ transform 失效。
- 第三种：`SettingsUI.module.css:195-204` `modernSelectTooltipInner` 自带 `:global(html[data-theme="dark"])` 分支，又一套 tooltip 观感（含内箭头）。

### 1.7 Tab 条：4 套 CSS + inset 皮肤

| 实现 | 位置 | 圆角 | 高 | hover | active |
|---|---|---|---|---|---|
| `.card-tab` | shell-workspace.css:778-930 | radius-lg(8px) | control-height-sm/30px | `--bg-hover` | **bg-primary !important**（:843-846）+ 另一条 active=bg-active（:869-872，被前者压制，死规则） |
| GlobalSessionTabBar `.tab` | GlobalSessionTabBar.module.css:127-184 | radius-md(6px) | 26px | text-primary 5% | bg-primary + border 55% + shadow 4% |
| UnitSessionTabStrip `.tab` | UnitSessionTabStrip.module.css:122-180 | radius-md | 24px | text-primary 5% | 同上 |
| LeafToolTabStrip `.tab` | LeafToolTabStrip.module.css:56-104 | **999px 药丸** | 24px | `--bg-hover` | bg-primary + border 85% + inset 高光 |
| inset 皮肤（覆盖 .card-tab） | shell-workspace.css:366-499 | `!important` 全量重写（~130 行） | ws-row2-tab-h | 3.5% | `--ws-chrome-merge` + `::after` 2px 底条 |

不一致度：圆角 6/8/999px；高 24/26/28/30/32px；关闭按钮 hover 圆角 radius-md / radius-xs / 999px 各异；GlobalSessionTabBar 与 UnitSessionTabStrip 为**逐行复制**（仅 `--global-*` vs `--unit-*` token 命名不同，~95% 相同规则）。

### 1.8 卡片 / 面板

| 实现 | 位置 | 圆角 | 底色 |
|---|---|---|---|
| BgTaskCard `.card` | BgTaskCard.module.css:3-14 | radius-md | bg-secondary + border-subtle |
| ChatQueuePanel `.item` | ChatQueuePanel.module.css:28-37 | radius-sm | bg-card |
| quickPromptCard | ChatEmptyState.module.css:188-204 | radius-2xl | transparent + border-color |
| `.elevation-2/3` | design-system.css:24-26 | — | bg-card + shadow-md |
| `[data-panel]` 基准 | tokens.css:750-765 | radius-lg / xl | bg-elevated + shadow-lg/md |
| ChatComposer footer | ChatComposer.module.css:312-325 | `0 0 12px 12px` 硬编码 | composer-footer-bg |

同是"卡片"，圆角 5/6/10/12px，底色 secondary/card/elevated/transparent 四系。

### 1.9 分隔线

- 结构分隔：`--hairline`（tokens.css:30）vs `border-bottom: 1px solid var(--border-color)`（settings-section-header settings-base.css:167）vs `border-subtle`（ChatQueuePanel item 底）vs `color-mix(text-primary 4%)`（models-catalog-row settings-base.css:1647）——同语义四种写法。
- 细分隔条：ChatHeader `.toolbarDivider`（:80-87）1px×14px 独立实现；`.dropdown-group +` border-top（shell-menus.css:141）。

### 1.10 滚动条：31 个块、12+ 种实现

| 实现 | 位置 | 宽 | 拇指色 | 圆角 |
|---|---|---|---|---|
| 全局 | shell-scrollbar.css:32-47 | 4px | text-primary 10%/14% | 999px |
| LeafToolTabStrip | :43-50 | **3px** | 18% | 999px |
| TiptapSlashMenu | :33-39 | 4px | **text-tertiary 20%** | **2px** |
| ChatQueuePanel | :15-22 | 4px | text-tertiary 20% | 2px |
| ChatComposer textarea | :116-122 | 4px | text-tertiary 20% | 2px |
| SettingsSelect | :124-131 | 4px | 18% | radius-xs |
| TiptapEditorField | :196-205 | 4px | 18% | 2px |
| tabs-bar | shell-workspace.css:767-776 | 隐藏 | — | — |
| GlobalSessionTabBar/UnitSessionTabStrip | 各自 :99-102 / :93-96 | 隐藏 | — | — |
| WorkspaceChromeBars | :110-112 | 隐藏 | — | — |
| DiffCard tabScrollWrap | :1002 | — | — | — |

全局标准 4px/10% 之外，模块层互不一致（3px vs 4px、10% vs 18% vs 20%、999px vs 2px），有的干脆隐藏——同一滚动场景观感不一。

### 1.11 hover 淡染：31 档混色 + 4 种 token 语义（全书最大一致性缺口）

- token 语义四种：`--bg-hover`（4%）、`--sidebar-hover`（control-mix 4%）、`--control-soft-bg-hover`、`--control-soft-bg`（.ui-btn-ghost:hover shell-polish.css:76）。
- 直接混色 `color-mix(in srgb, var(--text-primary) X%, transparent)` **423 处、31 个不同 X 值**（1.2 / 1.5 / 2 / 2.5 / 3 / 3.2 / 3.5 / 4 / 4.5 / 5 / 5.5 / 6 / 6.5 / 7 / 8 / 9 / 9.5 / 10 / 11 / 12 / 14 / 15 / 16 / 18 / 20 / 22 / 25 / 28 / 30 / 35 / 42%）。
- 例举：tab hover 5%（GlobalSessionTabBar:164）、菜单项 5.5%（shell-polish:536）、sort 行 6%（shell-menus:358）、slash 菜单 7%（TiptapSlashMenu:70）、filter 4%（ChatMsgFilterBar:29）、关闭钮 10%（GlobalSessionTabBar:265）、toast 按钮 16%（ToastStack:68）、滚动条 18%（SettingsSelect:129）。
- 同一"hover 变深"效果，用户看到的深浅差 10 倍以上（2% vs 22%）。

### 1.12 focus 反馈

- 全局契约：focus-visible.css:6-18（按钮/链接统一 `--focus-ring` 2px 阴影）。
- 背离点：`.ui-input:focus` 无变化（shell-polish:112-116）；多个 module 用 `outline: none; box-shadow: none` + 仅 border 变色（SettingsSelectCustomInput:230-233）；ComposePlusMenu slim item focus 用 `--bg-hover` + focus-ring fallback（:114-118）；SidebarNav 搜索无独立 focus。

### 1.13 过渡 / 动画时长

- token 契约：`--transition-micro/fast/smooth/enter/press/spring`（tokens.css:199-212）+ `--duration-*`。
- 硬编码时长分布（module.css 扫描）：80ms×2、100ms×18、150ms×5、220ms×3、300ms×1、1s×4、1.2s×2、1.5s×5、1.6s×2、1.8s×1、2.2s×1 —— 未走 token。
- **同效果不同速**：spinner 0.8s（Button.module:127、StatusDiagnosticsPanel:19、DiffCard:1248）vs 1s（FlowDagView:74、RuntimePanel:261、SidebarSessionList:477）vs 1.2s（AgentCard:417）；脉冲点 1.2s（ChatToolCallBlock:712）vs 1.6s（ChatStatusRibbons:76）vs 1.8s（ApprovalDock:42）vs 2.2s（SidebarSessionList:487）；骨架屏 1.5s（AgentCard:660）vs 1.6s（ChatMessageRow:530）。

### 1.14 diff 着色：两套色系并存

- DiffCard：token 系 `--accent-green-light/--accent-red-light`（:739-759），带 dark 分支覆盖（tokens.css:430/434）。
- FileViewerCard：**GitHub 硬编码色** `rgba(46,160,67,0.15/0.25)` / `rgba(248,81,73,0.15/0.25)`（FileViewerCard.module.css:260-276），无 dark 适配，色相饱和度与 token 系（hsl 142,35%）不同——同一"新增/删除行"两面板颜色不齐。

---

## 2. Token 贯彻度统计

| 指标 | 数值 | 口径 |
|---|---|---|
| var() 引用（module.css） | **5202 处** | 全量 var(--*) |
| --space-*/--radius-* 引用（module.css） | 999 处 | 间距+圆角 token |
| 硬编码 `Npx`（module.css） | **2440 处** | 裸 px 计数 |
| 硬编码 border-radius Npx（module.css） | 79 处（999px×28、6px×14、2px×8、1px×7、8px×7、7px×5、3px×5、20px×2、5/4/9px×1） | 含 0 不计 |
| 硬编码 font-size Npx（module.css） | 31 处 | 10/11/12/13px 散落（FileViewerCard 11 处、StatusDiagnosticsPanel 8 处） |
| 硬编码色值（module.css） | **48 处**（hex 3 + rgba/hsl 45） | 分布在 10 个文件 |
| 动效硬编码时长 | 31 处 module + 全局 | 未走 --transition-*/--duration-* |
| !important | **673 处**（module 191 / 全局 482；shell-polish 146、shell-workspace 170、settings-base 24、settings-models 21、tokens 11） | 见 §5 口径说明 |

- **贯彻度评价**：颜色层 token 化率高（48/5202 ≈ 0.9% 绕过），但**混色层完全失控**——`color-mix(... var(--text-primary) X% ...)` 既是 token 引用又是事实上的"硬编码强度值"（31 档）。尺寸层 2440 裸 px 中多数为图标/专用组件尺寸，但按钮/输入/菜单等可复用控件内也大量存在（.ui-btn-sm 28px/12px/999px、SettingsSelect 24px/28px、ChatHeader 26px、modeChip 999px）。
- **字体层最健康**：module.css 全部 `var(--font-sans/--font-mono)` 或 inherit，无裸字体栈。

## 3. 硬编码审计（模块层 48 处色值分布）

| 文件 | 数量 | 内容 | 风险 |
|---|---|---|---|
| DiffCard.module.css | 16 | 全部为 `var(--hover-bg/--active-bg, rgba(0,0,0,…))` 悬空引用 fallback + shadow rgba | **dark 下 hover 不可见**（01 审计 P1-02 复核属实，:457/462/988/1032/1061/1125/1160/1184/1237） |
| StatusDiagnosticsPanel.module.css | 13 | `--ui-*` 遗留命名 + rgba(224,49,49)/(47,158,68)/(25,113,194)/(232,89,12) 硬编码状态色 | 与 token 语义色（--color-success/error 等）双轨，暗色无适配 |
| FileViewerCard.module.css | 7 | GitHub diff 绿/红 rgba、shadow rgba | 见 1.14 |
| TerminalCard.module.css | 3 | terminal fallback hsl(0,0%,5%)、rgba(255,255,255,0.04) | fallback 语义正常 |
| Sidebar.module.css | 2 | overlayBackdrop `rgba(0,0,0,0.3)`（:169）等 | **硬编码遮罩，dark 下与浅色遮罩语义混用** |
| WorkspaceChromeBars.module.css | 2 | `--ws-session-strip` fallback `hsl(35,5%,94.5%)`（:48）等 | light-only fallback（token 定义时不可见） |
| App.module.css | 2 | `#fff`/`#111` fallback（:24-25） | 兜底可接受 |
| 其余 3 文件 | 3 | DevHealthOverlay、ChatStatusRibbons、FilesCard 各 1 | 低风险 |

**新增悬空引用（无 fallback → 渲染无效值）**：
- `--accent-green-light-adaptive` DiffCard.module.css:583（inlineActionAccept:hover 背景）——01 审计仅记 chart-color-1/2，此处于本报告独立发现。
- `--accent-red-light-adaptive` DiffCard.module.css:880（对应删除类 hover）。
- `--tooltip-translate` 双份 Tooltip 各 :18-36 共 8 处（transform 级联失效，动画退化为纯 opacity）。

## 4. 暗色模式一致性

- **覆盖结构**：81 个 module.css 中仅 3 个自带 dark 分支（components/Tooltip、ui/Tooltip、SettingsUI），其余依赖 tokens 的 `[data-theme="dark"]` 覆盖；组件级残余用 theme-dark.css **补丁式覆盖**（265 行、60+ 条规则，`:where(html[data-theme="dark"])` 前缀）——架构上"暗色靠外部补丁"而非"组件自身用自适应 token"，是暗色不一致的根源。
- **硬编码色组件暗色缺口**：FileViewerCard diff 色、StatusDiagnosticsPanel 状态色、Sidebar overlayBackdrop rgba(0,0,0,0.3)、DiffCard 黑色 rgba hover fallback——均在暗色下表现与同族 token 组件不同（DiffCard 已 P1-02 实锤）。
- **token 暗色缺口**（01 审计 P2-01 复核）：`--sidebar-hover/--sidebar-active/--control-mix-color` dark 未覆盖（tokens.css:391-517 无），侧栏 hover 暗色下为暖棕 4% 混色。
- **暗色下语义反向风险**：FirstRunWizard.primary 用 `--text-primary` 背景（dark 下为白底白字？：:218-221 `background: var(--text-primary); color: var(--text-on-accent)`，dark 中 text-on-accent=bg-primary≈黑 → 白底黑字，与 light 下黑底白字翻转）——反相 primary 在 dark 下观感反转。
- `.ui-btn-ghost.danger:hover` 用 `--accent-red-light`（dark 下 hsl(0,55%,16%) 深红底）与 ui/Button `.buttonDanger:hover` 用 `--color-error-bg`（同值）一致，无问题。
- 正向样本：theme-dark.css:31-35 为 `--md-code-*` 补 dark 值、:492-500 `--ui-text-*` dark 覆盖（01ef652b 建立）——说明"补丁式"可工作，但不规模化。

## 5. 样式组织问题

1. **双按钮体系未收敛**：`.ui-btn`（全局，服役）与 ui/Button（原子，零消费）并存；ui/Input、ui/Select 同样零消费；ui/Dialog、ui/Menu 已上岗（13/18 引用）。原子层"半落地"（02 审计 §1.3 一致）。
2. **同族 Tab 条复制粘贴**：GlobalSessionTabBar.module.css 与 UnitSessionTabStrip.module.css ~95% 规则相同，仅 token 前缀不同；inset chrome 皮肤再对 .card-tab 全量 `!important` 重写（shell-workspace.css:366-499）——三个维护点互相漂移。
3. **shell-polish.css 职责混杂**（1213 行）：排版工具类（:3-15）+ 按钮原语（:18-86）+ 输入原语（:100-119）+ 菜单（:503-537）+ ED polish 密度覆盖（:544+）+ 旧版别名（:207-242 size-selector 等），"polish"名不副实。
4. **tokens.css 混入组件层样式**：`[data-panel]` 基准（:750-765）、`.ui-popover-animate/.ui-modal-animate`（:739-747）、`::selection`（:674-677）、keyframes（:717-785）——token 文件非纯 token。
5. **死 token / 死规则**：design-system.css `--slate-0..10`（:5-17）全仓零引用；`.card-tab.active` 双声明（shell-workspace:843-846 bg-primary 压制 :869-872 bg-active，后者死）；ToastStack `slideInUp` 引用未定义 keyframes（:48）。
6. **滚动条样式 31 处重复**（§1.10），全局已有一份（shell-scrollbar.css）仍被逐处覆写。
7. **暗色补丁与组件样式分层不清**：theme-dark.css 选择器直接依赖全局类名（.msg-*、.approval-*、.card-tab），组件重构换类名即断裂（如 :259-264 的 .cardSurface/.dropdownSurface 疑似已无对应类）。
8. **编码卫生**：5 个全局样式文件 GBK + chat.css 注释双重损坏（01 审计 §1.5，本报告确认仍存在，未重复展开）。

## 6. 严重度清单

### P0（渲染无效 / 明确视觉错误）

| # | 问题 | 证据 |
|---|---|---|
| P0-1 | `--accent-green-light-adaptive` / `--accent-red-light-adaptive` 悬空无 fallback → DiffCard 内联接受/拒绝按钮 hover 背景无效 | DiffCard.module.css:583 / :880 |
| P0-2 | `--tooltip-translate` 未定义无 fallback → 双份 Tooltip 入场 scale 动画整体失效 | Tooltip.module.css:18-36（×2 文件） |
| P0-3 | `.card-tab.active` 双声明：bg-primary !important 压制 bg-active，active 语义规则为死代码，后续改 --bg-active 无效 | shell-workspace.css:843-846 vs :869-872 |

### P1（同效果明显不一致）

| # | 问题 | 证据 |
|---|---|---|
| P1-1 | "primary" 四套长相（深炭 / 蓝 / 反相 / 实心红），用户在设置、弹窗、向导中看到不同主按钮 | §1.1 表格 |
| P1-2 | 423 处 text-primary 混色 31 档 alpha，"hover 淡染"深浅差 10 倍 | §1.11 |
| P1-3 | Tab 条 4 套（6/8/999px 圆角 + 3 种 active 边框 + inset !important 皮肤），同一产品两种 tab 观感 | §1.7 |
| P1-4 | diff 双色系：DiffCard token 绿红 vs FileViewerCard GitHub 绿红 | §1.14 |
| P1-5 | 菜单 10+ 壳层：6/8/10/12/16px 圆角、5 种 hover、有/无阴影并存 | §1.3 |
| P1-6 | 滚动条 12+ 种实现：3px/4px、10%/18%/20%、999px/2px、有的隐藏 | §1.10 |
| P1-7 | `.ui-input:focus` 无可见反馈（border 不变 + box-shadow none），与输入族 focus 契约背离 | shell-polish.css:112-116 |
| P1-8 | 状态色三套并存：--color-* 语义（tokens）/ --ui-text-* 旧命名（StatusDiagnosticsPanel）/ GitHub rgba（FileViewerCard） | §3 |

### P2（轻微不一致 / 维护性）

| # | 问题 | 证据 |
|---|---|---|
| P2-1 | spinner 0.8/1/1.2s、脉冲 1.2/1.6/1.8/2.2s、骨架 1.5/1.6s 同效果不同速 | §1.13 |
| P2-2 | Icon-only 按钮 6+ 种尺寸圆角（20/22/24/26/28px × 6/8/999px） | §1.1 |
| P2-3 | 卡片圆角 5/6/10/12px、底色 4 系并存 | §1.8 |
| P2-4 | 分隔线 4 种写法（hairline/border-color/border-subtle/混色） | §1.9 |
| P2-5 | 徽标/pill 4+ 套、状态色各写各的 | §1.5 |
| P2-6 | Toast 双重动画声明 + 未定义 keyframes（维护陷阱） | §1.4 |
| P2-7 | dark 仅 3 个 module 自带分支，其余依赖 theme-dark.css 265 行补丁（重构易断链） | §4 |
| P2-8 | GlobalSessionTabBar / UnitSessionTabStrip 复制粘贴 ~95% 重复 | §1.7 / §5.2 |
| P2-9 | .ui-btn 无 :disabled 规则 vs ui/Button 有——同按钮族禁用态表现不一 | shell-polish.css:18-30 vs Button.module.css:26-29 |
| P2-10 | FirstRunWizard primary 反相在 dark 下观感翻转 | FirstRunWizard.module.css:218-221 + tokens.css:443 |

### P3（规范 / 卫生）

| # | 问题 | 证据 |
|---|---|---|
| P3-1 | !important 673 处（含 shell-workspace 170、shell-polish 146），覆盖链治理失控 | §2 统计 |
| P3-2 | ui/Button、ui/Input、ui/Select 原子组件零消费，形成双轨 | §1.1 / §5.1 |
| P3-3 | tokens.css 混入组件层样式（[data-panel]/.ui-*-animate/keyframes） | tokens.css:717-785 |
| P3-4 | --slate-* 死 token（零引用） | design-system.css:5-17 |
| P3-5 | shell-polish.css 职责混杂，含旧版别名 | §5.3 |
| P3-6 | 硬编码圆角 79 处（999px×28 未走 --radius-full） | §2 |
| P3-7 | 硬编码 font-size 31 处（10/11/12/13px，未走 --font-size-*，ui-size 缩放不生效） | §2 |
| P3-8 | 5 全局文件 GBK + chat.css 注释损坏未收敛（与 01 审计 P3-01 同源，需与快照协同） | §5.8 |
| P3-9 | 31 个 scrollbar 块无统一出口 | §1.10 |

## 7. 修复优先级建议（与 01 审计互补）

1. **P0-1/P0-2**：DiffCard :583/:880 补 fallback 或改用 `color-mix(in srgb, var(--accent-green) 10%, var(--bg-primary))`（与 :743 同款）；Tooltip 两文件 transform 改 `var(--tooltip-translate, translateY(0))` 或删变量。
2. **P1-2（混色收敛）**：建立 3 档混色 token（如 `--tint-hover/--tint-active/--tint-strong`），以 423 处为基线批量替换——这是"看起来不统一"的最大单一来源。
3. **P1-3/P1-8（Tab / primary / 状态色）**：以 ui/Menu、ui/Dialog 为样板，把按钮、Tab、状态色收敛进原子层或全局唯一类；删除 .card-tab.active 死声明。
4. **P3-1（!important）**：优先拆 inset 皮肤（shell-workspace:366-499 改非 !important 的 CSS 变量覆盖）。
5. 与新组件红线：新样式一律禁裸 `color-mix(--text-primary X%)`、禁裸 999px、禁裸 scrollbar 块；滚动条唯一出口建议收敛到 shell-scrollbar.css 的 `scrollbar-width/color` 契约。

## 附：口径与不确定性

- `!important` 673 处为全量 grep（含 tokens.css 11、reduced-motion 27 等合理场景）；01 审计"46 处"应为其当时 scoped 口径，本报告以全量为准并在修复时以本数做基线。
- `color-mix(text-primary)` 423 处含部分非 hover 用途（滚动条、分隔线、focus ring fallback 等），但 31 档的离散度结论不受影响。
- 硬编码 px 2440 处含行号容器/图标等固定尺寸，不能全部视为违规，但可复用控件内（按钮/输入/菜单/Tab）的硬编码已逐条举出。
- 视觉断言（hover 深浅观感、dark 观感）基于计算值推导，未做运行时像素采样；需要时可对 §1.11 抽样组件做 playwright 计算样式复核。
