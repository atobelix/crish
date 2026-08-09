# 前端组件架构与复用性审计报告

> 审计范围：`apps/crish-desktop/src/components/`（243 个 tsx 文件、28+ 业务子目录）与 `src/hooks/`（40+ hooks）的组件重复实现、分层边界、API 一致性、复用出口、巨型组件与 hooks 复用。
> 审计方式：只读，全部结论带 `文件:行号` 证据。
> 审计日期：2026-08-09。

## 0. 结论摘要

- **已建成的好基建**：`ui/` 原子层（PE-05）分层契约与门禁（`npm run check:ui-layer`）存在且被遵守（ui/README.md 依赖规则）；`ui/Menu` 已成为 11 处业务菜单的统一基座；`ui/Dialog` 已收敛 7 套核心弹窗；`useToastQueue` + `ToastStack` 是唯一 toast 通道；`useVirtualScroll` 是 5 个虚拟列表的正主。
- **核心病灶（对应"同一效果多种呈现"痛点）**：原子层落地了 6 个组件，但 **5 个（Button/Input/Select/Tooltip 新旧/useAnimatedPresence 新旧）处于"双轨并存"状态**——新件要么零消费者（Button 0 处、Input 0 处、Select 0 处）、要么只有零星消费者（ui/Tooltip 4 处），旧实现仍在 88 处服役（旧 Tooltip）。**128 个组件文件仍在裸写 `<button>`**，按钮体系实际是"全局类 + 各 module 私有类"三轨并行。
- **分类重复实现 13 类**（详见 §1）：Tooltip、useAnimatedPresence、按钮、Tab 条（6 实现）、虚拟列表（4 实现）、滚动锚定（2 实现）、空态（3 实现）、开关（5+ 实现）、badge/chip（4+ 实现）、通知横幅、菜单键盘漫游、resize 拖拽、流式 hook 双轨。
- **巨型组件**：>500 行 7 个（最大 `ModelConfigEditor.tsx` 856 行）；其中 2 个是"巨型 hook"（useExtensionMarket 581、useSidebarSessionList 550）。
- **props drilling 普遍且深**：`ChatCard → ChatMessageList` 30 props、`ChatComposerWrapper → ChatStatusRibbons` 30 props、`ChatAssistantMessageRow` 单组件 28 props、`ChatStatusRibbonsProps` 接口 27+ 字段。
- 严重度：**P0 × 2、P1 × 9、P2 × 7、P3 × 5**，见 §7。

---

## 1. 重复实现清单（同一效果多种实现）

### 1.1 Tooltip：新旧双实现并存（P0-2 的根源之一）

| 实现 | 位置 | 能力差异 |
|---|---|---|
| **旧 Tooltip（服役中）** | `components/Tooltip/Tooltip.tsx`（150 行） | 仅 hover 触发；**无** role/aria-describedby、**无** focus/blur 键盘触发、**无** 视口钳位、**无** 滚动跟随；依赖 `hooks/useAnimatedPresence` |
| **新 Tooltip（正主）** | `components/ui/Tooltip/Tooltip.tsx`（314 行） | 全量补齐：keyboard focus/blur 触发（:263-273）、aria-describedby 关联（:275-280）、按实测尺寸视口钳位 `computeClampedPosition`（:88-156）、scroll(capture)/resize 跟随（:206-220）；依赖 `ui/Dialog/useAnimatedPresence` |

- **消费分裂**：旧 Tooltip 被 **88 个业务文件** import（`import { Tooltip } from '../Tooltip'` / `'./Tooltip'`，如 ChatStatusRibbons.tsx:29、MessageActionsBar.tsx:4、AgentCard.tsx:9 等）；新 Tooltip 仅 4 个消费点（RunHistoryList.tsx、ScheduledTasksPanel.tsx、WorkflowList.tsx、WorkflowForm.tsx，均从 `'../ui'` barrel 引入）。
- **正主判定**：`ui/Tooltip`（文件头注释自证"从 components/Tooltip/Tooltip.tsx 整体迁入"），旧版为**滞迁孤儿**——但它是当前**事实正主**（88:4 的消费比）。双轨并存导致：同一界面内部分 tooltip 键盘可达、部分不可达；修复新版后旧版仍承担 95% 流量。
- 附带问题：`useMergeRefs`/`setRef` 两个私有工具函数在两个 Tooltip 内**逐字重复**（旧 :6-22 与新 :35-51）。

### 1.2 动画基元 useAnimatedPresence 双份

| 实现 | 位置 | 消费方 |
|---|---|---|
| 旧 | `hooks/useAnimatedPresence.ts:10` | 旧 Tooltip（components/Tooltip/Tooltip.tsx:3,77） |
| 新 | `components/ui/Dialog/useAnimatedPresence.ts:21`（目录内私有，原子层禁依赖 hooks/ 的产物） | ui/Dialog（Dialog.tsx:20,100）、ui/Tooltip（:32,178） |

两实现签名相同（`{visible, exitDurationMs}`），hooks/ 版本已无 ui 层之外消费者——旧版可作为删除候选（删除前需确认 hooks/ 根目录无其他引用，当前 grep 仅旧 Tooltip 一处）。

### 1.3 按钮体系：ui/Button 零消费 vs 128 文件裸 `<button>`（P0-1）

| 实现 | 位置 | 说明 |
|---|---|---|
| **ui/Button（正主，未上岗）** | `components/ui/Button/Button.tsx`（95 行） | forwardRef + variant/size/icon/loading/block，CSS Modules |
| 全局类按钮 | `styles/shell/shell-polish.css` 的 `.ui-btn` 体系（Button.tsx:4-7 注释自证对齐） | 业务层大量用 `className="ui-btn …"` |
| 裸 `<button>` | **128 个组件文件**直接写原生 button（含 icon-only 按钮、开关、菜单触发器） | 各自配 module 私有类，样式互不相同 |

- **ui/Button 全仓零消费者**：grep `ui/Button` 仅命中组件自身与测试（Button.tsx、Button.test.tsx），无任何业务 import。
- 同一"按钮"概念有三种呈现：原子组件（无人用）、全局类（部分用）、私有 module 类（多数用）。Icon-only 按钮（如 ×、…、⌄）无统一组件，全靠各文件手写 `aria-label` + 裸 button。

### 1.4 Tab 条家族：6 个自研实现，无公共基座（P1）

| 实现 | 位置 | 能力差异 |
|---|---|---|
| UnitSessionTabStrip | `components/binary-tree/UnitSessionTabStrip.tsx`（478 行） | 最完整：React.memo + 拖拽 + a11y 专项测试 3 套；aria-selected（:433） |
| LeafToolTabStrip | `components/binary-tree/LeafToolTabStrip.tsx` | 同域轻量变体 |
| GlobalSessionTabBar | `components/shell/GlobalSessionTabBar.tsx`（428 行） | 全局标签栏，拖拽 + 上下文 |
| SessionStrip | `components/workspace/SessionStrip.tsx` | role="tablist" + aria-selected（:19-30），最小实现 |
| WorkspaceStrip | `components/workspace/WorkspaceStrip.tsx`（203 行） | 工作区面板条 |
| SettingsTablist | `components/SettingsTablist.tsx` | role="tablist"/role="tab"（:101-127），设置导航 |

全仓 `role="tab"` 共 6 处来源，各自维护 `aria-selected`/激活态/关闭按钮，无一个共享 Tab/TabStrip 组件。键盘左右漫游在部分实现缺失（SessionStrip 无 keyboard 漫游逻辑，UnitSessionTabStrip 有）。

### 1.5 虚拟列表：4 套实现（1 正主 + 1 孤儿 + 2 分支）

| 实现 | 位置 | 状态 |
|---|---|---|
| **useVirtualScroll（正主）** | `hooks/useVirtualScroll.ts` | 5 个消费者：MessageVirtualizer.tsx:15,118、DiffCardSplitView.tsx:5,28、DiffCardUnifiedView.tsx:5,28、VirtualPlainCodeViewer.tsx:2,24、FileTreeView.tsx:7,61 |
| shell/VirtualList | `components/shell/VirtualList.tsx`（含自研 `computeVisibleRange` :10-22） | **孤儿**：全仓无业务消费者（grep 仅命中自身） |
| WindowedSessionUl | `components/sidebar/session-list/WindowedSessionUl.tsx` | 第四种方案：基于 `api/sessionListWindow` 的 range 切片 + spacer，未复用 useVirtualScroll |
| MessageVirtualizer | `components/chat-message-list/MessageVirtualizer.tsx`（447 行） | 基于 useVirtualScroll 的消息容器（正确派生），但含大量消息窗口特有逻辑 |

`computeVisibleRange`（shell/VirtualList.tsx:10-22）与 `useVirtualScroll` 内部的窗口计算重复。

### 1.6 滚动锚定：两套实现（P2）

| 实现 | 位置 | 消费方 |
|---|---|---|
| useChatAutoScroll | `hooks/useChatAutoScroll.ts` → `components/chat-card/ChatScrollAnchor.ts`（useChatScrollAnchor 包装 :8-15） | ChatCard 系 |
| useScrollAnchor | `components/chat-message-list/useScrollAnchor.ts`（自研 scrollToMessage/findMessageElement） | ChatMessageList.tsx:31 |

两套都做"滚动到底 + 定位消息"，实现互不共享（一个走 chatFlowRef 一个走 `[data-msg-id]` querySelector）。

### 1.7 空态组件：3 个独立实现（P2）

| 实现 | 位置 | 差异 |
|---|---|---|
| ChatEmptyState | `components/chat-card/ChatEmptyState.tsx`（358 行） | 最完整：三态 + 数据属性锚点 + 项目选择器 |
| WorkspaceEmptyState | `components/workspace/WorkspaceEmptyState.tsx` | 简约：图标 + 文案 + role=status |
| PanelBodyEmpty | `components/card-panel/PanelBodyEmpty.tsx` | 带 CTA 按钮，含 `panel-body-empty`/`card-action-btn` 全局类 |

三者视觉同源（同一个 Lucide.LayoutPanelLeft 图标），但 className/A11y/props 全不互通。

### 1.8 开关/切换控件：5+ 处手写，无统一 Toggle（P1）

| 实现 | 位置 |
|---|---|
| 全局类开关 | `components/settings/SettingsSchemaRenderer.tsx:81`（`settings-switch settings-switch--personalize`）+ :213 aria-pressed button 变体 |
| aria-pressed 按钮 | `SettingsSecurityTab.tsx:370`、`SettingsShortcutsTab.tsx:457`、`SettingsAppearanceTab` 等 |
| 手写 toggleThumb | `settings-models/ModelConfigEditor.tsx:668`（私有 thumb 结构） |
| agent 开关 | `agent-card/InlineAgentPanel.tsx` 等（aria-pressed） |

全仓**无 `role="switch"` 命中**、无统一 Switch 组件；同一"开关"效果有全局类、aria-pressed 按钮、私有 thumb 三种呈现。`ModelConfigEditor.tsx:529` 的 cap 开关（`const on = !!addDraft.caps[opt.key]`）也是同类。

### 1.9 badge/chip/状态点：4+ 种呈现（P2）

| 实现 | 位置 | 差异 |
|---|---|---|
| AgentStatusChip | `components/agent-card/AgentStatusChip.tsx` | module css + role="status" + aria-label + Tooltip，最规范 |
| CacheMetricsBadge | `components/chat-message-row/CacheMetricsBadge.tsx` | **裸全局类** `cache-metrics`（:26）、无 role |
| AgentStatusDot | `components/agent-card/AgentTeamBoard.tsx:13-` | 内联状态点（状态点又一种画法） |
| 审批风险 chips | `agent-card/ApprovalAskCard.tsx:91-127`（localizeRiskChips/dedupeChipLabels） | 内联 chip 生成 |
| diff 徽标 | `components/diff/DiffCardFileList.tsx` 等 | 再一种 |

### 1.10 通知/横幅条：多渠道并存（P2）

- toast 唯一通道：`hooks/useToastQueue.ts` + `components/overlay/ToastStack.tsx`（正确单例，30+ 消费点）。
- 但"通知"另有三套：`RunNoticeBar`（run 提示条）、`SetupHintBanner`/`PlanGoalRibbons`/`ApprovalDock`（ChatStatusRibbons.tsx 组合，均为独立组件，样式/API 互不共用）、`AgentCard` 内 daemon 状态横幅。四者呈现同一"引擎状态通知"语义但样式与交互各自为政（ChatStatusRibbons.tsx:30-37 组合五条轨道）。

### 1.11 菜单键盘漫游：两套实现（P2）

- `ui/Menu/Menu.tsx`：内置 ↑↓/Enter/Esc 漫游（:102-119）。
- `SidebarContextMenus.tsx`：自研 `focusMenuItem`（:87-106）与 `onMenuKeyDown`（:108-130）——与 ui/Menu 的漫游逻辑重复（右键菜单场景虽特殊，但键盘漫游算法是同一概念）。

### 1.12 流式发送/停止：两套 hook 双轨（P1，共享 wire）

- 主对话：`hooks/useChatStream.ts`（门面 re-export `chat-stream/index.ts`）+ `handleStopGeneration`/`handleForceCancelGeneration`。
- Agent 面板：`hooks/useAgentStream.ts`（useAgentPanel）+ `handleStop`/`handleForceStop`（文件头注释自认命名不同步）。
- 同一下游 `api/streamStop`（useAgentStream.ts:26-28 import 自证），但两个 hook 各保留一套 finalize/partials 逻辑。这是"同一效果（停止生成）两种命名与两种实现"的典型案例。

### 1.13 输入/编辑器：4 轨并存（P1）

| 实现 | 位置 | 状态 |
|---|---|---|
| **ui/Input（正主）** | `components/ui/Input/Input.tsx` | **零业务消费者**（grep 仅自身+测试） |
| 全局类输入 | `settings-field-input` 等（Input.tsx:4 注释自证收敛目标） | 设置页大量使用 |
| 私有输入 | 各 settings tab module 私有类 | 数量最多 |
| 编辑器双轨 | `ComposerField.tsx`（textarea + useAutoGrowTextarea）vs `TiptapComposerField.tsx`/`TiptapEditorField.tsx`（tiptap） | ChatComposer.tsx:131 注释自证"textarea 分支兼容复用"，tiptap 为接管方向，双轨共存 |

---

## 2. 组件分层与解耦问题

### 2.1 展示/容器边界：半解耦状态

- **好**：`ui/` 原子层契约明确（ui/README.md 分层规则 + `check:ui-layer` 门禁），ui 内组件零业务依赖（Button.tsx:8 注释"只依赖 react 与 tokens"）。
- **好**：store 访问有 facade 层（`api/store-access/componentAccess.ts`、`store/storeAccess.ts`），chat-card 状态被 `useChatCardState` 等 hooks 集中（ChatCard.tsx:34）。
- **问题**：分层渗透严重——
  - **58 个组件直接 `import 'store/…'`**（绕过 facade），含 chat-message-row/、agent-card/、settings/ 全域。
  - 130 个组件直接 import `api/`，组件内直接调 `getSessionById`（ChatStatusRibbons.tsx:19,186）、`anyProfileHasKey()`（ChatComposerWrapper.tsx:88）等非纯数据获取。
  - **坏味道**：组件内直接操作 DOM/API 副作用，如 SettingsProfileTab 手写 Blob 导出（:63-83）、手写 `<input type=file>` 注入（:91-95）——与 overlay/FirstRunWizard、ExternalSessionImport 的导入导出逻辑各有实现。

### 2.2 props drilling（>4 层转发实例）

| 链路 | 证据 | 深度 |
|---|---|---|
| ChatCard → ChatComposer | ChatCard.tsx:42-72 将 `state.composerProps` 的 20+ 字段**逐个拆包**再传 | 3 层以上（useChatCardState → ChatCard → ChatComposer → ComposerField/TiptapComposerField → TiptapEditorField） |
| ChatCard → ChatMessageList | ChatCard.tsx:158-190，**30+ props** | 2 层到 list，list 再下钻 row |
| ChatComposerWrapper → ChatStatusRibbons | ChatComposerWrapper.tsx:82-112，**30 props** 平铺 | ChatCard(useChatCardState) → ChatComposerWrapper → ChatStatusRibbons |
| ChatMessageList → row | ChatAssistantMessageRow 单组件 **28 props**（ChatAssistantMessageRow.tsx:11-37） | ChatCard → ChatMessageList → MessageVirtualizer(renderItem) → ChatAssistantMessageRow |
| ChatStatusRibbonsProps 接口 | ChatStatusRibbons.tsx:50-114，**27+ 字段** | 无聚合对象，全平铺 |

典型现象：`state.composerProps` 已经是聚合对象，但消费侧仍**拆包后逐 prop 传**（ChatCard.tsx:43-72），等于对象化了一半又退回去。

### 2.3 巨型状态 hooks 承担了容器职责

`useChatCardState.ts`、`useChatHandlers.ts`、`useChatApprovalHandlers.ts`、`useChatComposerProps.ts` 将 ChatCard 的容器逻辑拆到 hooks（正向），但与之对比，settings 全域没有等价拆分，各 tab 直接在组件体内写数据获取与副作用（如 SettingsProfileTab 导出/导入 :63-95、SettingsAppearanceTab 全组件手写）。

---

## 3. 组件 API 一致性

### 3.1 同类回调命名不一致

| 语义 | 命名 1 | 命名 2 | 证据 |
|---|---|---|---|
| 停止生成 | `handleStopGeneration`/`handleForceCancelGeneration` | `handleStop`/`handleForceStop` | useChatStream（chat-stream/index.ts:191-193）vs useAgentStream.ts:33-37（注释自认"不同 handler 名"） |
| 选中回调 | `onSelect(id, option)`（ui/Menu:40） | `onChange(value)`（ui/Select:29） | 同为选项选择，两套命名 |
| 打开回调 | `onOpenChange(open)`（ui/Menu:52） | `onOpen()`（SettingsSelect:18 自研接口） | 设置页 Select 自研 props 与 ui/Select 不一致 |

### 3.2 受控/非受控

- 双模实现得好：ui/Menu 受控/非受控互斥（Menu.tsx:96-97 注释 F7 F3）、ui/Select 双模（Select.tsx:80）。这是正例。
- 不统一：SettingsSelect（自研）仅受控（Props.value 必填 :14）；ui/Input 同时支持 value/defaultValue（Input.tsx:60-61，好）；旧 Tooltip 无 open 概念（hover 态内隐）。

### 3.3 ref / className / style 透传

| 组件 | forwardRef | className | style |
|---|---|---|---|
| ui/Button | ✅ :47 | ✅ :69 | 经 restProps（HTMLAttributes） |
| ui/Input | ✅ :47 | ✅ :58 | 经 restProps |
| ui/Menu | 无（非元素组件） | ✅ contentClassName :54 | ✅ contentStyle :56 |
| ui/Select | 无 | ✅ className :42 | 无 |
| 旧 Tooltip | ✅（但只透给子元素 ref 合并 :98） | 无（无根元素） | 无 |
| 新 Tooltip | ✅ + cloneElement 透传 restProps（:284-292） | 无 | 无 |

整体透传面较全，但"面板层组件（Menu/Select）无 ref 暴露"与"元素层组件有 ref"的约定未文档化。

### 3.4 无障碍（aria-*）覆盖度——新旧差异是最大不一致源

- 新 Tooltip：`role="tooltip"` + aria-describedby（ui/Tooltip/Tooltip.tsx:275-298）、键盘 focus 触发（:263）。
- 旧 Tooltip：**无 role、无 aria 关联**（components/Tooltip/Tooltip.tsx 全文无 role/aria 属性）——88 处消费点因此整体失去 tooltip 键盘可达性。
- 空态三件都有 role="status"（好）；CacheMetricsBadge 无 role（纯装饰文本，可接受但风格不统一）。
- 开关无 role="switch"（全仓 0 命中，见 §1.8）。
- 全仓 `role="dialog"` 仅 1 处生产代码（SkillEditorModal.tsx；Dialog 基座内部实现）；Modal 语义由 ui/Dialog 承担（收敛良好）。

---

## 4. 复用出口现状

### 4.1 ui barrel 只导出 2/6 组件

`components/ui/index.ts`（12 行）只导出 **Dialog + Tooltip**；Button/Input/Menu/Select 未进 barrel。而 ui/README.md 声明"新消费方一律从 `ui/index.ts` barrel 引入"——契约与实现不符。

| 组件 | 业务消费方式 | 消费数 | 是否走 barrel |
|---|---|---|---|
| Dialog | `'../ui'`（barrel） | 7+（CheatsheetModal/TelemetryDialog/WithdrawConfirmDialog/SkillEditorModal/SettingsPanel/RulesEditorDialog/FirstRunWizard） | ✅ |
| Tooltip（新） | `'../ui'`（barrel） | 4（RunHistoryList/ScheduledTasksPanel/WorkflowList/WorkflowForm） | ✅ |
| Menu | 直接 `'../ui/Menu'` | 11（ModelBadgePickerMenu/ProjectPickerMenu/ComposePlusMenu/SkillsMoreMenu/ChatHeaderMore/ModelsSettingsTab/SettingsQuickMenu/SettingsSelect/PermissionModeMenu/SidebarContextMenus/…） | ❌ 绕过 barrel |
| Button | — | **0** | — |
| Input | — | **0** | — |
| Select | — | **0**（SettingsSelect 基于 ui/Menu 自研，未用 ui/Select） | — |

### 4.2 底层库引用分散

- `lucide-react`：几乎所有组件直接 import（无 Icon 组件封装）。
- Radix：ui/Menu（Menu.tsx:14）内封装使用，业务层不直触（好）。
- tiptap：chat-composer 内直用；`@radix-ui/react-popover` 等依赖全在 ui 层（符合 ui/README 分层表）。
- hooks 目录：根目录 40+ hooks **无 barrel**（只有 chat-stream/、tab-drag/ 子目录有 index.ts）；组件间复用 hooks 靠相对路径散引。
- 全局 CSS 类与 CSS Modules 并存（`card-action-btn`、`settings-switch`、`cache-metrics`、`mrd-title`、`panel-body-empty` 等全局类仍在业务层使用，与 ui/README"CSS Modules 唯一标准"冲突）。

---

## 5. 巨型组件清单（>500 行）

| 行数 | 文件 | 域 | 拆分建议 |
|---|---|---|---|
| 856 | `settings-models/ModelConfigEditor.tsx` | settings-models | 单组件包含 profile 选择、cap 开关（:529）、模型列表（:575+）、toggleThumb（:668）等 ≥5 个功能区；建议拆 CapEditor/ModelList/ProviderProfileForm |
| 742 | `agent-card/ApprovalAskCard.tsx` | agent-card | 已含内部组件 ApprovalPayloadSection（:146-269）；建议继续拆 ApprovalRiskChips/ApprovalCountdown/ConfirmButton 组 |
| 686 | `sidebar/SidebarContextMenus.tsx` | sidebar | 自研键盘漫游（:87-130）+ flyout 状态机（:150-225）；拆 ContextMenuFlyout 基件 |
| 581 | `settings-extensions/useExtensionMarket.tsx` | settings-extensions | **巨型 hook**：缓存读写（:37-72）+ 市场数据获取 + 状态管理全在一个 hook；拆 useSkillsCache/useMcpCache/useMarketQuery |
| 551 | `settings/ExternalSessionImport.tsx` | settings | 导入向导全流程单文件 |
| 550 | `sidebar/session-list/useSidebarSessionList.tsx` | sidebar | **巨型 hook**：列表窗口化 + 拖拽 + 分组全量状态 |
| 508 | `settings/SettingsUsageTab.tsx` | settings | 用量图表 + 表格 + 配置混合 |

次级大型（400-500 行，均应关注）：AgentTeamBoard 495、McpServerList 496、UnitSessionTabStrip 478、InlineAgentPanel 467、ChangeOverviewCard 451、MessageVirtualizer 447、ExtensionCard 447、TiptapEditorField 444、SettingsShortcutsTab 442、SettingsAppearanceTab 427、GlobalSessionTabBar 428、AgentCard 398、SettingsSecurityTab 395。

注：任务书点名的 ChatMessageRow.tsx（59 行）实际是纯 re-export 转发器（无重复负担）；ChatStatusRibbons（351 行）与 SettingsPanel（320 行）属"组件内轨道多"而非单函数巨无霸——真正需要拆的是上面 7 个。

---

## 6. hooks 复用

### 6.1 总览

- 根目录 40+ hooks：流式（useChatStream/useAgentStream/useChatPanelSync）、队列（useToastQueue）、滚动（useChatAutoScroll/useIsVisible）、拖拽（useTabDrag 系列 7 件/useTreeDrag/useTreeResize/useColumnResize/usePointerDragBase）、虚拟滚动（useVirtualScroll）、工具（useAutoGrowTextarea/useTextMeasure/useResponsiveLayout）等。
- 无根 barrel；chat-stream/（7 模块：useStreamBatchers/useStreamCallbacks/useSlashSend/useGoalMode/multimodal/helpers）与 tab-drag/（useTabDragEvents/useTabDragReorder/tabDragGeometry 等）是仅有的两个子目录化成功案例——**子目录化 + index 是仓库 hooks 的最佳实践，应推广**。

### 6.2 重复 hook 逻辑

| 重复 | 位置 | 说明 |
|---|---|---|
| 流式双轨 | `hooks/useChatStream.ts`（re-export chat-stream/）vs `hooks/useAgentStream.ts` | 见 §1.12；文件头注释明确"两 UI hook 保留各自 finalize partials"——是刻意为之但有成本 |
| useAnimatedPresence | hooks/ 与 ui/Dialog/ 双份 | 见 §1.2 |
| 滚动锚定 | useChatAutoScroll vs chat-message-list/useScrollAnchor | 见 §1.6 |
| useMergeRefs | 旧/新 Tooltip 各一份 | 见 §1.1 |
| resize 家族 | useColumnResize（workspace）+ useTreeResize（binary-tree）+ usePointerDragBase（基件） | 基件抽象存在（usePointerDragBase 是 base），但 tree/column 两套 resize 计算未共用 |

### 6.3 命名与职责

- 命名总体规范（useXxx + 职责名）；反例：`useChatPanelSync.ts`（无消费者？疑似死代码）、`useTreePanelEvents.ts`（事件注册型 hook，无返回值）。
- 巨型 hook 两枚（useExtensionMarket 581 / useSidebarSessionList 550）越过"hook ≤300 行"惯例，见 §5。
- 业务域 hook 归置混乱：`settings-extensions/useExtensionMarket.tsx`、`settings-models/useModelProfilesState.ts`、`settings-skills/useSkillsSettingsState.ts` 在组件目录内（与组件同目录是合理惯例），但 `hooks/` 根目录与组件目录两处并存，无统一约定文档。

---

## 7. 严重度清单

### P0（架构缺陷）

| # | 问题 | 证据 |
|---|---|---|
| P0-1 | **ui/Button 零消费 + 128 文件裸 `<button>`**：原子层 6 件套中 5 件未上岗，按钮呈现三轨并行（ui/Button / `.ui-btn` 全局类 / 私有 module 类），"同一按钮多种样式"是组件层重复的直接源头 | ui/Button 无业务 import；128 文件 `<button>`（grep 计数）；ui/README 声明 barrel 唯一出口与实现不符 |
| P0-2 | **Tooltip 新旧双轨 + 无障碍断层**：88 处消费旧版（无 role/aria/focus 触发），新版（完整 a11y）仅 4 处；修复无法到达大部分 UI | components/Tooltip/Tooltip.tsx 全文无 aria；ui/Tooltip/Tooltip.tsx:263-298 全量能力；88 vs 4 消费比（grep 清单） |

### P1（明显重复/不一致）

| # | 问题 | 证据 |
|---|---|---|
| P1-1 | Tab 条 6 个自研实现，无公共基座，键盘语义不齐 | UnitSessionTabStrip/LeafToolTabStrip/GlobalSessionTabBar/SessionStrip/WorkspaceStrip/SettingsTablist |
| P1-2 | 虚拟列表 4 套实现，shell/VirtualList 为孤儿 | useVirtualScroll（5 消费）vs VirtualList（0 消费）vs WindowedSessionUl vs MessageVirtualizer |
| P1-3 | 开关控件 5+ 处手写，无 role="switch"，无统一组件 | SettingsSchemaRenderer:81,213 / SettingsSecurityTab:370 / ModelConfigEditor:668 / 各 tab aria-pressed |
| P1-4 | props drilling：30 props 级转发 ×3 链，聚合对象拆包回传 | ChatCard.tsx:42-72、158-190；ChatComposerWrapper.tsx:82-112；ChatAssistantMessageRow.tsx:11-37 |
| P1-5 | 巨型组件：ModelConfigEditor 856 行单组件 | §5 清单 |
| P1-6 | 58 个组件直连 store，绕过 store-access facade | grep `store/` 计数 58 |
| P1-7 | 输入/编辑器四轨并存（ui/Input 零消费、settings-field-input 全局类、私有类、textarea/tiptap 双轨） | §1.13 |
| P1-8 | 巨型 hook 两枚（581/550 行）未拆分 | useExtensionMarket.tsx / useSidebarSessionList.tsx |
| P1-9 | ui barrel 只含 2/6 组件，Menu 等绕过 barrel 直引 | ui/index.ts（12 行）vs 11 处 `'../ui/Menu'` |

### P2

| # | 问题 |
|---|---|
| P2-1 | 空态三件套独立实现（ChatEmptyState/WorkspaceEmptyState/PanelBodyEmpty） |
| P2-2 | badge/chip 四式（AgentStatusChip/CacheMetricsBadge/AgentStatusDot/审批 chips） |
| P2-3 | 通知横幅多渠道（RunNoticeBar/SetupHintBanner/PlanGoalRibbons/ApprovalDock/AgentCard daemon 横幅） |
| P2-4 | 滚动锚定双实现（useChatAutoScroll vs useScrollAnchor） |
| P2-5 | useAnimatedPresence 双份 + useMergeRefs 重复复制 |
| P2-6 | 菜单键盘漫游双实现（ui/Menu 内置 vs SidebarContextMenus 自研） |
| P2-7 | 停止生成 API 命名双轨（handleStopGeneration vs handleStop），同类回调 onSelect/onChange/onOpen 混用 |

### P3

| # | 问题 |
|---|---|
| P3-1 | hooks 根目录无 barrel；域 hook 归置无统一约定 |
| P3-2 | 组件内手写文件下载/上传副作用（SettingsProfileTab:63-95），应下沉 api/ 或公共 hook |
| P3-3 | 全局 CSS 类仍在业务层扩散（cache-metrics/settings-switch/card-action-btn/mrd-title），与 ui/README CSS Modules 唯一标准冲突 |
| P3-4 | 疑似死代码：shell/VirtualList、ui/Select（SettingsSelect 未迁移）、useChatPanelSync 需复核后删除或接线 |
| P3-5 | 旧 Tooltip 迁移完成后删除 components/Tooltip/ 与 hooks/useAnimatedPresence（需先确认无其他引用） |

---

## 8. 收敛建议（按 P0→P1 排序，供后续方案引用）

1. **P0-1/P0-2 合并为一轮"原子件接管行动"**：先让 ui/Button、ui/Tooltip 批量接管（88 处旧 Tooltip 机械替换 + 128 文件裸 button 分批），每批以 `npm run typecheck` + 现有单测为门禁；旧 Tooltip 替换完成后删除旧目录。
2. **P1-9 先行**：ui barrel 补全 6 组件导出，Menu 消费点从 `'../ui/Menu'` 改 `'../ui'`，恢复"barrel 唯一出口"契约。
3. **P1-4 治理**：建立"props ≤ 12 或必须聚合对象"的评审约束；ChatCard 系改为直接消费 `state.composerProps` 展开（JSX spread），ChatStatusRibbons 改为接收单一 `ribbons` 聚合对象。
4. **P1-1**：以 UnitSessionTabStrip（能力最全 + 3 套 a11y 测试）为蓝本提炼 `ui/TabStrip`，六个消费点收敛。
5. **P1-3**：新增 `ui/Switch`（role="switch"），settings 全域替换 5 处手写实现。
6. **P1-6**：门禁化——`check:ui-layer` 同款脚本扩展到"业务组件禁止直引 `store/`"，全部走 store-access facade。
7. **P1-5/P1-8**：ModelConfigEditor 与两枚巨型 hook 拆分为下一轮重构候选。

> 本审计为只读快照；所有行号基于 2026-08-09 工作区状态。重复实现类目数：**13 类**（§1.1-§1.13）。
