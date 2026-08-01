# AA-04 前端大组件与样式系统审查

- 审查日期：2026-08-01
- 审查范围：`apps/crish-desktop/src/components/`（全部 336 文件）、`apps/crish-desktop/src/styles/`（30 文件）、`apps/crish-desktop/src/assets/`（空）
- 审查性质：只读审查（未改任何代码）
- 重点：>400 行组件、弹窗/菜单/基础件重复、全局样式与 CSS Modules 双轨、可访问性、shim 层、目录迁移进度

---

## 一、总览

### 1.1 规模统计

| 目录/类型 | 文件数 | 总行数 | 说明 |
| --- | --- | --- | --- |
| components/ ts+tsx | 258 | 48,944 | 组件与 hooks |
| components/ *.module.css | 78 | 18,504 | CSS Modules（与 tsx 1:0.3，大量组件无独立 module） |
| styles/ *.css | 29 | 14,685 | 全局样式 |
| styles/ tokens/zindex.ts | 1 | 31 | TS 侧 z-index 常量 |
| assets/ | 0 | 0 | 目录存在但为空 |
| **合计** | **366** | **82,164** | |

### 1.2 行数分布（ts/tsx）

| 区间 | 文件数 |
| --- | --- |
| > 800 行 | 2（ChatStatusRibbons 864、FirstRunWizard 776+1 拖拽 hook 718） |
| 500–800 行 | 13 |
| 400–500 行 | 17 |
| 200–400 行 | 约 40 |
| < 200 行 | 约 186 |

>400 行组件/hook 共 **32 个**，占 ts/tsx 文件数的 12.4%，却贡献约 18,000 行（约 37% 代码量）。

### 1.3 目录化迁移进度（结构）

- 顶层扁平 ts/tsx：**79 个**（31%）
- 域子目录：**179 个**（69%），共 26 个子目录（accounts / agent-card / binary-tree / card-panel / chat-card / chat-composer / chat-image / chat-message / chat-message-list / chat-message-row / chat-tool-call / common / diff / files / overview / provider / right-tool-dock / settings / settings-extensions / settings-mcp / settings-models / settings-skills / settings-tabs / shell / sidebar / Tooltip / workspace）
- 突出问题：**CSS Module 未随组件迁移**——FilesCard.module.css（1056 行）、OverviewCard.module.css（549 行）仍留在顶层，`files/*`、`overview/*` 通过 `'../FilesCard.module.css'` 反向引用；`settings-tabs/` 是纯 shim 目录（见第五节）。

---

## 二、大组件清单（>400 行）

### 2.1 组件类（tsx）

| 文件 | 行数 | 职责构成分析 | 拆分建议 |
| --- | --- | --- | --- |
| ChatStatusRibbons.tsx | 864 | 6 种 ribbon（engine/needs-key/needs-model/sync-engine/plan/goal）+ run-notice + 审批 dock + 计划抽屉 + 后台任务 3s 轮询 + 审批滚动定位；**前 290 行是文案/aria 纯函数**，渲染区 480 行 | 拆 `SetupHintBanner`、`PlanGoalRibbons`、`RunNoticeBar`、`ApprovalDock`、`useBackgroundTaskPolling`；文案纯函数迁到 `chatStatusRibbonsLib.ts` |
| FirstRunWizard.tsx | 776 | 5 步向导（密钥/模型/导入/项目/开始）+ **模块级副作用标记** `firstRunOverlayMounted`（L37）+ 约 190 行校验/文案纯函数；状态 7 个 + 步进逻辑全在组件内 | 抽 `useFirstRunWizard`（步进状态机）+ `WizardKeyStep` / `WizardModelStep` / `WizardImportStep` / `WizardProjectStep` 子组件；纯函数抽 lib |
| useTopBarDrag.ts | 718 | 会话标签拖拽控制器（条内重排 + 画布 split 落点规划 + 功能标签拖拽），单一职责但状态机庞大（5 组状态 + 4 组 ref） | 按能力拆 `useSessionTabReorder` / `useCanvasDropPlanner`；常量与类型抽文件 |
| SettingsPanel.tsx | 703 | 设置壳：10 tab 元数据（TAB_META L115-217）+ 搜索过滤 + roving tablist + Esc 三层优先级 + / 与 Ctrl+F 快捷键 + 10 个懒加载 Suspense 分支 + 窗口控制 | 拆 `SettingsTablist`、`useSettingsNav`（搜索+roving+Esc）、`SettingsWindowControls`；TAB_META 抽数据文件 |
| SettingsScheduleTab.tsx | 669 | 定时任务：筛选 + 创建双入口（paths/form）+ 编辑 + 启停 + 立即执行 + 会话占位副作用（L92-111 与 ScheduledTasksPanel 重复）；约 60 行纯函数 | 拆 `WorkflowFormDialog`、`WorkflowList`、`useWorkflowsState`；**与 ScheduledTasksPanel 共享 workflow 表单/列表实现** |
| RuntimePanel.tsx | 657 | 6 个 section（引擎/用量/活动任务/后台常驻/待确认/计划），每个 section 独立渲染 + 数据合并（liveTasks 跨 sessions+activeRuns 合并）+ 审批 allow/deny 副作用；约 80 行文案纯函数 | 拆 `RuntimeSection` 基座 + `LiveTasksSection` / `BgTasksSection` / `ApprovalSection` / `PlansSection`；`useRuntimePanelData` 收拢数据合并 |
| SidebarContextMenus.tsx | 656 | 会话右键菜单（portal + 坐标钳位）+ 排序下拉（Radix UnifiedSelectPopover）+ 3 组 flyout 悬浮（80ms/150ms 定时器）+ 焦点保存/还原；约 60 行纯函数 | 拆 `SessionContextMenu` / `SortFilterMenu` / `useFlyoutMenu`；坐标钳位纯函数可复用给其它 portal 菜单 |
| SettingsRulesTab.tsx | 643 | 规则 CRUD + 作用域切换 + 全文编辑器 dialog（L600-676 全局类实现）+ 引擎同步链路；约 40 行纯函数 | 拆 `useRulesState`（加载/持久化/同步）+ `RulesEditorDialog`（复用通用 Modal 基座） |
| PreviewCard.tsx | 637 | 内置浏览器：地址栏 + iframe 安全 src 判定 + 导航栈 + 历史/书签双列面板 + 20s 加载超时 + 书签/历史状态同步 | 拆 `PreviewToolbar`、`PreviewHistoryPanel`、`usePreviewNavigation`（栈/历史/书签） |
| ScheduledTasksPanel.tsx | 626 | **SettingsScheduleTab 的对话内第二实现**（同源 workflowApi，但列表/表单/筛选/占位逻辑重复编写）；另带 run 历史列表 | 收敛：`useWorkflowsState` + 共享 `WorkflowForm`/`WorkflowList`，两处仅保留外壳差异 |
| Workspace.tsx | 618 | 工作区布局：列/组渲染 + 列宽/组高 resize + 折叠 + 拖拽预览 + live region 播报；workspace/ 子目录已抽 Canvas/EmptyState/Resizer，但主组件仍含大量编排 | 拆 `WorkspaceColumn` / `WorkspaceGroup`；拖拽/折叠逻辑收进 `useWorkspaceLayout` |
| ApprovalAskCard.tsx | 579 | 审批卡：风险 chips 本地化 + 二次确认武装（armed 状态机）+ 超时倒计时 + 手动 FocusTrap + Enter/Esc 快捷键 + 自动聚焦；约 100 行映射/本地化纯函数 | 拆 `RiskChips`、`CountdownTimer`、`useDoubleConfirm`；本地化函数抽 lib |
| InlineAgentPanel.tsx | 467 | 内联 agent 块：折叠头 + 思考折叠（details/summary）+ 工具栈 + 内联 Composer + 流订阅（useAgentStream/useAgentToolApproval 已抽） | 拆 `SubagentThinkingFold`（已内联 L43-66）/ `AgentStreamBody`；主组件保留编排 |
| ChangeOverviewCard.tsx | 451 | 改动总览：diff 汇总纯函数（L57-84）+ 展开列表 + 接受/拒绝落盘 + 跳转 Diff 面板；约 60 行纯函数 | 拆 `DiffSummaryList`、`useChangeOverviewActions`；汇总纯函数抽 lib |
| UnitSessionTabStrip.tsx | 458 | 会话标签条：roving tabindex + 拖拽入口 + 溢出 fade + Delete 关标签；复用 GlobalSessionTabBar 的 openTabsStripRelevantEqual | 拆 `StripTab`；溢出检测与窄相等逻辑与 GlobalSessionTabBar 共享（已部分 re-export） |
| TerminalCard.xterm.tsx | 484 | xterm 集成：PTY 生命周期（registry/take）+ fit/WebGL + 主题色读取（19 处硬编码 hex）+ 状态机（idle/connecting/ready…） | 拆 `useXtermLifecycle` / `useXtermTheme`（读 tokens，删硬编码）/ `TerminalStatusBar` |
| AgentTeamBoard.tsx | 486 | agent 切换列表（compact/strip 两形态）+ 状态点内联组件 + 空态 | 拆 `AgentStatusDot`（已内联 L13-51）/ `AgentRow`；props 收敛 |
| AgentCard.tsx | 401 | agent 侧栏聊天卡：时间线 + ComposerField + AgentTeamBoard 编排 + 4 个 @deprecated props（L52-56） | 拆 `AgentTimeline` / `AgentCardComposer`；删除 deprecated props |
| SettingsUsageTab.tsx | 457 | 用量统计 + 图表 + 单价编辑行（EditablePriceRow 内联 L53-）+ portal | 拆 `UsageChart`、`EditablePriceRow`、`useUsageStats` |
| SettingsShortcutsTab.tsx | 442 | 快捷键设置：常量表（DEFAULT_SHORTCUTS/SHORTCUT_ITEMS/KEY_PART_ZH 共约 100 行）+ 改键交互 | 拆 `ShortcutRow`、`useShortcutBinding`；常量抽数据文件 |
| SettingsAppearanceTab.tsx | 421 | 外观：主题/密度/字体/缩进 + 皮肤 ID 双列表（L43-44，与 theme-dark.css 皮肤需核对）+ SettingsSchemaRenderer 渲染 | 拆 `ThemeSection` / `DensitySection`（FontSettingsSection 已抽）；皮肤 ID 抽常量 |
| shell/GlobalSessionTabBar.tsx | 421 | 全局会话标签行：等宽 tab + +/pin/x + 拖拽入口 + 溢出检测 | 拆 `GlobalTab`、`useGlobalTabBar`；与 UnitSessionTabStrip 共享 strip 工具已部分完成 |
| MessageVirtualizer.tsx | 444 | 虚拟化消息列表：**props 约 45 个**（L28-70）+ 置顶条 + 搜索高亮 + 窗口控制 | 拆 `PinnedBar` / `WindowControls` / `VirtualRow`；props 用 context 或组合收拢 |
| ScheduledTasksPanel（同 L626 条目） | | | |
| settings-mcp/McpServerList.tsx | 496 | MCP 服务器列表：**props 约 30 个**（L19-49）+ 演示/真实双列表 + 启停/展开/排序 | 拆 `McpServerRow` / `McpDemoSection` / `McpFilterBar`；props 分组收敛 |
| settings/ExternalSessionImport.tsx | 542 | 外部会话导入：扫描（Claude/Codex）+ 勾选 + 导入 + 自定义根目录；settings/wizard 双 variant | 拆 `useExternalImport` + `SourceSection` / `ImportList` |
| settings-models/ModelConfigEditor.tsx | 538 | 模型配置编辑器：**props 约 40 个**（L166-206 展开）+ 密钥/模型表/测试/扫描 | 拆 `KeySection` / `ModelsTable` / `ConfigDialog` / `TestPanel`；props 收拢 |
| chat-card/useChatComposerProps.ts | 485 | composer 编排 hook：**返回值 50+**（ChatCard.tsx L42-76 逐个展开） | 拆 `useComposerDraft` / `useComposerSend` / `useComposerAttachments` / `useComposerSlash` |

### 2.2 Hook 类（ts/tsx，>400 行）

| 文件 | 行数 | 职责构成分析 | 拆分建议 |
| --- | --- | --- | --- |
| binary-tree/useTopBarDrag.ts | 718 | 见上（拖拽状态机） | 见上 |
| settings-skills/useSkillsSettingsState.ts | 639 | 技能设置大 hook：30+ 状态、目录发现、批量启停/删除（BatchConfirm）、新建（manual/paths/AI）、引擎同步 | 拆 `useSkillDiscovery` / `useSkillBatchOps` / `useSkillCreate` / `useSkillSync` |
| settings-extensions/useExtensionMarket.tsx | 530 | 扩展市场大 hook：MCP + 技能 + 插件三数据源 + 两级 localStorage 缓存（L31-66）+ 批量安装 | 拆 `useMcpMarket` / `useSkillMarket` / `usePluginMarket` |
| settings-models/useModelProfilesState.ts | 479 | 模型 profile 大 hook：CRUD + 扫描 + 测试 + 价格；**含 100+ 行 PRESETS 常量（L43-）** | PRESETS 抽数据文件；拆 `useProfileCrud` / `useModelScan` / `useModelTest` |
| sidebar/session-list/useSidebarSessionList.tsx | 560 | 侧栏会话列表编排：搜索 + 分组 + 虚拟化窗口 + 拖拽 + 重命名 + 置顶 | 拆 `useSidebarSearch` / `useSidebarGrouping` / `useSidebarWindow`（useSessionListWindow 已存在） |
| sidebar/session-list/useSessionListDrag.ts | 425 | 会话行拖拽：预览重排 + 置顶区判定 + 落点计算 | 可保持；预览重排纯函数抽 lib |
| chat-card/useChatComposerProps.ts | 485 | 见上 | 见上 |

### 2.3 共性结论

- **混在一起的位置**：几乎所有大组件都把「文案/aria 纯函数」（0-120 行）与「副作用状态」（轮询、快捷键、focus 管理）与「渲染」写在同一文件；纯函数先行抽 lib 是成本最低的一步（ChatStatusRibbons 已示范）。
- **跨组件重复**：SettingsScheduleTab 与 ScheduledTasksPanel（workflow 全链路）、GlobalSessionTabBar 与 UnitSessionTabStrip（strip 工具）是两对最明显的收敛机会。
- **props 爆炸**：McpServerList（30）、ModelConfigEditor（40）、MessageVirtualizer（45）已到必须用组合/context 收敛的程度。

---

## 三、重复实现清单

### 3.1 弹窗类（实际 11 处 role=dialog，核心 7 套）

| 实现 | 文件 | 差异摘要 | 收敛方案 |
| --- | --- | --- | --- |
| TelemetryDialog | components/TelemetryDialog.tsx（141） | **内联 style 对象** + FocusTrap + useAnimatedPresence + useRestoreFocus | 全部收敛到一个 `Modal` 基座（FocusTrap + useAnimatedPresence + Esc + backdrop + aria-modal + useRestoreFocus），7 处消费 |
| CheatsheetModal | components/CheatsheetModal.tsx（136） | module css + FocusTrap + 搜索分组 | 同上 |
| WithdrawConfirmDialog | components/WithdrawConfirmDialog.tsx（105） | module css + FocusTrap + role=alertdialog | 同上 |
| SkillEditorModal | settings-skills/SkillEditorModal.tsx（215） | 复用 SkillsSettingsTab.module.css + 全局类混用（skills-discover-panel） | 同上 + 样式归属纠正 |
| FirstRunWizard | components/FirstRunWizard.tsx | module css，**无 FocusTrap**，手动 focus 首元素 | 接入基座 |
| SettingsPanel | components/SettingsPanel.tsx | module css，**无 FocusTrap**，自管 Esc 三层 | 接入基座 |
| SettingsRulesTab 全文编辑器 | SettingsRulesTab.tsx L600-676 | 全局 settings-dialog 类 + 手动 focus | 接入基座 |
| （附加）QuickOpen | QuickOpen.tsx L192 | module css + 自管键盘 | 可选接入 |
| （附加）PreviewCard 历史面板 | PreviewCard.tsx L439-447 | module css + aria-haspopup | 可选接入 |
| （附加）ChatStatusRibbons 计划抽屉 | ChatStatusRibbons.tsx L637-669 | module css + 手动 Esc | 可选接入 |
| （附加）AppGlobalDialogs settings-cover | app/AppGlobalDialogs.tsx L127-174 | 全局 settings-cover 类包装 | 与 SettingsPanel 一并治理 |

### 3.2 菜单/下拉类（12 套，仅 3 套基于统一基座）

| 实现 | 文件 | 与统一基座差异 |
| --- | --- | --- |
| UnifiedSelectPopover（**基座候选**） | common/UnifiedSelectPopover.tsx（242） | Radix Popover + 自动防碰撞 + 键盘漫游 + 双模 open |
| ComposePlusMenu | ComposePlusMenu.tsx（141） | **已基于** UnifiedSelectPopover |
| ProjectPickerMenu | ProjectPickerMenu.tsx（275） | **已基于** UnifiedSelectPopover + 自管搜索/添加级联 |
| SidebarContextMenus 排序下拉 | SidebarContextMenus.tsx L482-690 | **已基于** UnifiedSelectPopover + 自管 flyout 定时器 |
| SettingsSelect | SettingsSelect.tsx（170） | portal + 自算坐标 + mousedown 外点关闭 + Esc（与 UnifiedSelectPopover 功能重叠） |
| PermissionModeMenu | PermissionModeMenu.tsx（123） | portal + 自算坐标（含预估高度 140）+ mousedown/Esc/resize |
| ModelPicker | ModelPicker.tsx（283） | 自管理 open/close + 模块样式 |
| ModelBadgePickerMenu | ModelBadgePickerMenu.tsx（117） | 自管理 |
| SettingsQuickMenu | SettingsQuickMenu.tsx（291） | 自管理 roving + Arrow 漫游 |
| ComposerSlashMenu | chat-composer/ComposerSlashMenu.tsx（121） | 纯渲染（键盘在父级 useChatComposerProps）+ aria-activedescendant |
| SkillsMoreMenu | settings-tabs/skills/SkillsMoreMenu.tsx（164） | 自管理（真实现，非 shim） |
| ModelsSettingsTab「添加服务商」 | ModelsSettingsTab.tsx L82-132 | **用全局 sort-filter-menu 类**（shell-menus.css）手写内联菜单 |

- 坐标计算 3 套独立实现：clampContextMenuPosition（SidebarContextMenus）、SettingsSelect updateCoords、PermissionModeMenu updateCoords。
- **收敛路径**：以 UnifiedSelectPopover 为唯一菜单基座；SettingsSelect 若保留原生 select 语义（listbox）可保留，但坐标/Esc 逻辑并入基座；ModelsSettingsTab 内联菜单迁移到基座并删全局类依赖。

### 3.3 按钮

- 全局 `ui-btn` 系列（shell-polish.css L18-84 定义 base/sm/md/primary/secondary/ghost/block），被 **31 个 tsx** 使用 —— 这是事实上的统一按钮体系。
- 但同时每个 module.css 又各自定义同义按钮类（firstRunBtn、planModeRibbonIconBtn、chatSoftHintAction、navBack、dynamicChip 等），且各 settings-*.css 还有 pane 级 `ui-btn-*` 覆写（settings-plugins.css:987-1002、settings-models.css:1599、settings-usage.css:132、settings-advanced.css:301 等 6 文件）。
- **差异**：全局按钮无 danger 变体（`is-danger` 类在 ChatStatusRibbons.tsx:833 使用但**全仓无定义**，属死类）；模块按钮是视觉私有化，无法统一改主题。
- **收敛**：danger 变体补进 ui-btn 体系；模块按钮若只是尺寸/圆角差异，用 tokens（--control-height、--radius-*）替代私有类。

### 3.4 选择器/输入

- 三轨并存：SettingsSelect（组件 + module）、UnifiedSelectPopover options 模式（menuitem）、全局 `.settings-select` 旧类（settings-base.css:2419 有 `[MIGRATED]` 注释但旧样式未删，L2430/2609 仍定义；shell-polish.css:966-1079 仍定义 settings-select-menu/item 全局类与 SettingsSelect.module.css 功能重复）。
- 输入框：无统一 Input 组件，各组件手写 `<input className={styles.xxx}>`（FirstRunWizard firstRunInput、SettingsRulesTab 用全局 settings-field-input 等）。settings-field-input 全局类（settings-base.css）与私有输入类并存。

---

## 四、样式系统问题

### 4.1 全局 29 文件与 CSS Modules 双轨重叠

| 文件:行号 | 描述 | 建议 |
| --- | --- | --- |
| settings-base.css:2419-2430, 2609 | 标注 `[MIGRATED] .settings-select styles migrated to SettingsSelect.module.css`，但旧 `.settings-select` 定义**未删除**，与组件 module 类并存 | 迁移完成后物理删除旧定义 |
| shell-polish.css:966-1079 | 仍定义 `.settings-select-menu` / `.settings-select-item` 全局类，与 SettingsSelect.module.css 的 settingsSelectMenu/settingsSelectItem 同名功能 | 删除全局版本 |
| settings-plugins.css:639-710, 846 | 仍定义 `.settings-select-trigger` 全局类，SettingsSelect 已用 module 的 settingsSelectTrigger；DiffCard.module.css:118、FirstRunWizard.module.css:123、ScheduledTasksPanel.module.css:202 用 `:global(.settings-select-trigger)` 反向挂钩 | 全局类并入 SettingsSelect.module.css，`:global` 引用改为 props/类名覆盖 |
| settings-models.css / settings-plugins.css / settings-usage.css / settings-advanced.css / settings-extensions.css | 6 个 pane 文件各自覆写 `ui-btn-*`、`.settings-select`、pane 专属样式，与 settings-base.css、shell-polish.css 交叉 | 收敛到 ui-btn tokens + pane 级差异最小化 |
| 全仓 29 个全局 css | 自身变量重复定义：--models-green 3 次、--models-border 3 次、--models-green-soft 3 次、--shell-inset-bg 2 次、--ws-chrome-* 多文件 2 次等（见 grep 统计，另有 --clickable 等 8 次疑似误匹配待人工核对） | 变量上收 tokens.css，文件内只留引用 |
| tokens.css:289-290 | `--space-0_5: 2px` 与 `--space-0.5: 2px` 同时存在（下划线/点两种命名），后者仅在 `--dropdown-gap` 等处引用 | 统一一种命名，删除冗余 |
| tokens.css:244 注释 | `--z-dropdown: 2000 — see z-index.css for canonical value`，即 z-index 双源：z-index.css（CSS）与 tokens/zindex.ts（TS） | 确定单源（建议 CSS tokens），zindex.ts 改为从 CSS 读取或废弃 |
| z-index.css | `--z-modal: 5000`（tokens.css:245 也定义 --z-modal） | 删除 tokens.css 中的重复定义 |
| SettingsAppearanceTab.tsx:43-44 | DARK_SKIN_IDS / LIGHT_SKIN_IDS 字符串数组与 theme-dark.css 的皮肤实现**无编译期校验** | 抽为共享常量并由主题注册表生成 |

### 4.2 tokens.css 设计令牌覆盖度

- tokens.css 共约 200 个令牌（颜色/圆角/间距/字号/字重/行高/z-index/过渡/阴影/性能档/密度档），覆盖面良好。
- 硬编码 hex 残留（未走 tokens）：
  - TerminalCard.xterm.tsx:142-178 —— **19 处**（xterm 16 色调色板 + fallback）；建议加 `--xterm-*` 令牌组，随主题切换。
  - SidebarContextMenus.tsx:458 —— `#f85149` fallback（`var(--text-danger, #f85149)`，而 --text-danger 本身 tokens 未定义，属**缺 token**）。
  - MessageContent.tsx:88 —— `#ef4444` fallback（`--color-error` 已有，fallback 冗余）。
  - SettingsSchemaRenderer.tsx:153/173/183 —— `#000000`/`#888` fallback。
  - DiffCard.module.css（6 处）、WithdrawConfirmDialog.module.css（3 处）直接硬编码 hex。
- 语义别名混乱：`--accent-green`、`--color-success`、`--danger-color`、`--accent-danger`、`--warning-color` 等多套语义名并存（tokens.css:73-89 注释自认「legacy aliases」），组件侧 ChatStatusRibbons 用 `var(--accent-green)`、MessageActions 用 `var(--accent-orange)`、RuntimePanel 用 `var(--color-error)`——同一种语义三种写法。
- tokens.css 中 `--text-danger` 未定义但被 SidebarContextMenus 引用（只有 fallback 兜底）——**缺失 token 清单**：--text-danger、--window-close-*（有定义）、--usage-modal 等。

### 4.3 CSS Modules 命名约定

- 总体一致：78 个 module.css 中 1526 个唯一类名，几乎全为 camelCase（`settingsSelectTrigger`、`chatSoftHint`），与 `styles.xxx` 访问方式匹配；仅 2 处 kebab：`is-entering`（某 module）与 `:global(.settings-select-trigger)`（DiffCard/FirstRunWizard/ScheduledTasksPanel 引用全局类）。
- 与全局类同名（module 内安全但易混淆）：active/open/on/primary/ghost/warn/danger/dot/close/collapsed/disabled/subtle 等 20 个通用名同时出现在全局与 module。
- 部分 module.css 超大（DiffCard 1311、FilesCard 1056、ModelsSettingsTab 853、SkillsSettingsTab 750、ChatToolCallBlock 631），说明组件内部结构也庞大，建议随组件拆分一并拆 css。

---

## 五、shim 与遗留

| 文件 | 行数 | 消费方 | 建议 |
| --- | --- | --- | --- |
| components/FilesCard.tsx | 7 | CardPanelLayout.tsx（lazy）、TreeLeafPanel.tsx（lazy） | 消费方直接改 import `files/FilesCard`，删除 shim；FilesCard.module.css 移入 files/ |
| components/OverviewCard.tsx | 9 | CardPanelLayout.tsx（lazy）、TreeLeafPanel.tsx（lazy） | 同上；OverviewCard.module.css 移入 overview/ |
| components/settings-tabs/models/useModelsSettings.ts | 13 | ModelsSettingsTab.tsx:12（**顶层组件反从 shim 导入**） | 改 import settings-models/useModelProfilesState，删除 shim |
| components/settings-tabs/models/ModelList.tsx | 31 | ModelsSettingsTab.tsx:14 | 同上，import settings-models/ModelProfileList |
| components/settings-tabs/models/ModelFormDialog.tsx | 7 | ModelsSettingsTab.tsx:15 | 同上，import settings-models/ModelConfigEditor |
| components/settings-tabs/skills/useSkillsSettings.ts | 23 | SkillsSettingsTab.tsx:17 | 改 import settings-skills/useSkillsSettingsState |
| components/settings-tabs/skills/SkillList.tsx | 7 | SkillsSettingsTab.tsx:18 | 改 import settings-skills/SkillCardList |
| components/settings-tabs/skills/SkillDetailPanel.tsx | 12 | SkillsSettingsTab.tsx:22 | 改 import settings-skills/SkillDetailPreview |
| components/settings-tabs/skills/SkillsMoreMenu.tsx | 164 | SkillsSettingsTab.tsx:23 | **真实现**（非 shim）；建议移入 settings-skills/ 与其它统一 |
| card-panel/PlanLegacyRedirect.tsx | 12 | 历史遗留跳转（focusOrOpenPanel 'overview'） | 确认无入口后删除 |
| card-panel/SettingsLegacyRedirect.tsx | 12 | 历史遗留跳转 | 同上 |
| SidebarContextMenus.tsx:36-41 | — | `AgentContextMenuState` 标注 @deprecated（子 agent 不再进侧栏树） | 删除类型与 4 个 @deprecated props（L76-83） |
| AgentCard.tsx:52-56 | — | `onOpenRight`/`onOpenWindow` @deprecated props | 删除 |
| ProjectPickerMenu.tsx:43-45 | — | `pickFolderNative` @deprecated 导出 | 删除 |
| ChatStatusRibbons.tsx:833 | — | `is-danger` 类**全仓无 CSS 定义**（死类） | 删除或补定义 |
| settings-tabs/ 目录整体 | 7 文件 | 见上 | 整体删除（迁移后） |

---

## 六、正面发现

1. **a11y 整体质量高（抽样）**：
   - 统一复用 `FocusTrap`（FocusTrap.tsx，含 inert/aria-hidden 旁路）+ `useAnimatedPresence` + `useRestoreFocus` 三件套（CheatsheetModal/TelemetryDialog/WithdrawConfirmDialog）。
   - ApprovalAskCard.tsx 是全仓 a11y 模范：自动聚焦、自实现 FocusTrap、Enter 触发允许（textarea 内不拦截）、Esc 解除武装、超时倒计时播报。
   - 键盘漫游实现完备：SettingsPanel roving tablist（方向键/Home/End）、SidebarContextMenus menu 漫游、UnifiedSelectPopover ↑↓/Enter/Esc、ComposerSlashMenu aria-activedescendant。
   - aria-live/role=status 播报密集（filterStatusText 视觉隐藏、run-notice polite/assertive 分级、动态 chip 区 role=region）。
2. **纯函数与组件分离已成惯例**：ChatStatusRibbons / FirstRunWizard / RuntimePanel / ChangeOverviewCard 顶部大量导出纯函数（文案/aria/校验），且带单测（unitChromeLabel.test.ts、MessageVirtualizer.perf.test.tsx 等），是后续抽 lib 的现成基础。
3. **懒加载已铺开**：SettingsPanel 10 tab 全部 React.lazy + 每页独立 ErrorBoundary/Suspense；AppGlobalDialogs 对 Toast/Cheatsheet/FirstRun/Settings 全懒加载。
4. **统一基座已出现**：UnifiedSelectPopover（Radix）已服务 ComposePlusMenu/ProjectPickerMenu/SidebarContextMenus 三处，是菜单收敛的自然锚点。
5. **样式 token 体系完备**：tokens.css 覆盖颜色/圆角/间距/字号/密度/性能档（high/balanced/eco），`--space-*`/`--control-*`/`--radius-*` 阶梯完整，且 ui-size 档位统一缩放在 tokens 层完成。
6. **注释与契约质量高**：中文契约注释（「成功静默、仅失败 toast」等）贯穿大组件，组件间语义对齐可溯源；`[MIGRATED]` 标记说明团队已有迁移意识。
7. **测试覆盖健康**：>400 行组件大多带 .test.tsx（ChatStatusRibbons 2 个、FirstRunWizard、UnitSessionTabStrip 3 个（a11y/drag/subscribe）、VirtualList、useMcpSettings 等），便于安全重构。
