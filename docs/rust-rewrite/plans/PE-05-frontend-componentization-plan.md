# PE-05 前端组件化与样式规范化方案

> 计划日期：2026-08-01
> 输入：`26-frontend-observability-audit.md`（1.x 节）、`audits/AA-04-frontend-components-styles-review.md`（全篇）、代码抽查（components/ 结构、common/UnifiedSelectPopover.tsx、FocusTrap.tsx、Tooltip/Tooltip.tsx、styles/shell/shell-polish.css ui-btn、styles/tokens.css、styles/tokens/zindex.ts）
> 性质：**只读研究 + 方案文档**，本文件不包含任何代码改动；落地时逐任务执行并更新进度
> 范围：`apps/crish-desktop/src/`（前端 GUI 部分；store 拆分属 PE 其他计划，本方案仅涉及命名重叠时的顺序约束）

---

## 修订记录

> 版本 **v2**（2026-08-01）· 依据 **AU-04-interface-freeze-decisions.md**（§四 PE-05 修订清单 + C17/C18 + 认领表 #3）。

| 修订点 | 内容 |
|---|---|
| 行号过时修正（AU-03 偏差表） | ChatStatusRibbons 864→913、SettingsPanel 703→753、FirstRunWizard 776→834、Workspace 618→665、RuntimePanel 657→692、SettingsRulesTab 643→680、PreviewCard 637→664、ScheduledTasksPanel 626→656、SettingsScheduleTab 669→700、useTopBarDrag 718→786、UnifiedSelectPopover 242→262、SettingsSelect 170→180、AgentCard 401→420；css 引用路径补全（`styles/shell/`、`styles/settings/`）。未列于偏差表的子行号（如 ChatStatusRibbons:833、L637-669、TAB_META L115-217）已实测复核仍有效，开工前仍按 AU-03 P10 断言自检 |
| T05.4.1 串行声明（C18） | ChatStatusRibbons 拆分声明「在 PE-01 T02.2 之后执行」（SetupHintBanner 无 sync-engine 分支）；文件长度改 913 |
| T05.7 重命名时序（C17） | 声明与 PE-01 T04.3 / PE-06 T06.8 组 2 的时序：两书用旧名开发，本任务末轮统一改名；发布/订阅一致性单测由本任务负责 |
| 新增 T05.9 | 视觉回归门禁（认领表 #3）——**引用 PE-11 T11.2**（PE-11 已产出完整测试策略任务书 T11.1/T11.2），本任务只确认配合义务与 owner，不另建基线体系 |
| T05.8 删行 | LoggerService 行删除（PE-04 T04.4-1 接线，本域不回收） |
| T05.7 落地 v3（2026-08-02） | 执行 T05.7 文件清单冻结（清单落盘 `plans/T05.7-filelist.md`）：目录 `api/daemon-chat-bridge/` → `api/chat-bridge/`；8 个 daemon 命名文件改 engine/chat 名；事件名 `'daemon:connection:change'` → `'engine:connection:change'`（内部 eventBus，非 wire，发布/订阅两侧同改 + 一致性单测）；agent-workbench 侧核查为 wire 契约层（引擎 daemon 存活：`update_daemon_config`、`workbench_restart_daemon`、`DAEMON_DISCONNECTED_CODE`、`network.daemon_dead`），**豁免不改**（wire 层不动）；`daemonSynced`/`daemon-offline`/`daemon-error` 等非 wire 标识符随批替换；`DAEMON_WS_KEY` 死码删除 |

---

## 一、目标与分层规范

### 1.1 分层总则（三层结构）

建立严格的「ui 原子层 → 业务组件层 → 页面/编排层」三层，替代当前「无原子层 + 28 个域目录 + 60 个扁平文件并存」的现状。

```
components/
├── ui/            ← 第一层：ui 原子层（新增，唯一允许"通用"的层）
│   ├── Button/
│   ├── Input/
│   ├── Dialog/
│   ├── Menu/
│   ├── Tooltip/
│   ├── Select/
│   ├── Badge/              （可选，从 AgentStatusChip/AgentStatusDot 提炼）
│   ├── index.ts            （barrel，对外统一出口）
│   └── README.md           （分层契约文档）
├── (域目录 28 个 + 新增域)  ← 第二层：业务组件层
├── common/                 ← 废除：UnifiedSelectPopover 迁入 ui/Menu，目录删除
├── Tooltip/                ← 迁入 ui/Tooltip，目录删除
└── App.tsx / AppTopBar / AppGlobalDialogs …  ← 第三层：页面/编排层（保持扁平即可）
```

**依赖规则（写进 ui/README.md 并作为评审门禁）：**

| 层 | 允许依赖 | 禁止依赖 |
|---|---|---|
| ui/ 原子层 | react、react-dom、@radix-ui/*、`src/styles/tokens.css`（CSS 变量）、`src/styles/z-index.css` | 一切业务组件、一切 store（zustand）、`hooks/`、`api/`、`services/`、其他域目录 |
| 业务组件层 | ui/、共享 hooks（`hooks/`）、store facade（`api/storeAccess.ts` 编排入口）、api/、services/ | 跨业务域直接 import（如同一功能需复用，先下沉到 ui/ 或抽共享 hook） |
| 页面/编排层 | 全部上层 | —（编排职责不外泄） |

**门禁机制**：新增 `npm run check:ui-layer` 脚本——用 `rg` 扫描 `components/ui/` 下所有文件的 import，命中 `components/(?!ui)`、`store/`、`hooks/`、`api/` 任一模式即失败；并入 CI 与 `npm run typecheck` 同级的本地检查链。

### 1.2 样式规范（双轨合并后的唯一标准）

**规范 1 · tokens 唯一源**：所有颜色/圆角/间距/字号/字重/行高/z-index/过渡/阴影必须引用 `styles/tokens.css` 变量；组件 CSS 与 tsx 内联样式禁用裸 hex/rgba（迁移期内允许 `var(--x, #fallback)` 过渡形态，最终清零）。语义色走「语义名 → 单一变量」映射（见 T05.5.1 语义别名收敛表）。

**规范 2 · CSS Modules 命名约定**：
- 类名一律 camelCase（与现有 1526 个唯一类名中除 2 处外的现状一致），语义为「组件内部私有形态」，不得与全局类同名（现有 active/open/danger/disabled 等 20 个通用名与全局类同名的，在组件迁移时改为 `xxxActive` 前缀化）。
- `:global(...)` 引用全局类为**禁止项**：现状仅 3 处（`DiffCard.module.css:118`、`FirstRunWizard.module.css:123`、`ScheduledTasksPanel.module.css:202` 引用 `:global(.settings-select-trigger)`），在 T05.5.2 全部消除。
- module.css 必须与组件同目录、同名（`Button/Button.tsx` ↔ `Button/Button.module.css`）；禁止跨目录反向引用（现存 FilesCard/OverviewCard.module.css 反向引用在 T05.6 修正）。

**规范 3 · 双轨合并终点**：全局 css 只保留「跨组件基础设施」（reset、scrollbar、focus-visible、theme-dark、tokens、z-index、breakpoints、sr-only、reduced-motion、drag 视觉）。一切「组件形态」样式（按钮、弹窗、菜单、选择器、面板类）下沉到对应组件的 module.css；`[MIGRATED]` 标注的旧全局类物理删除，不允许只标不删（见 T05.5.2 清单）。

**规范 4 · z-index 单源**：以 `styles/z-index.css` 为唯一运行期定义（CSS 变量），`styles/tokens/zindex.ts` 保留 TS 侧常量但其值与 css 的**一致性由脚本保证**（`npm run check:zindex` 比对，见 T05.5.3），禁止手改一端。

### 1.3 目录规范

- 每个 tsx 组件与其 module.css、专属 hooks（`use*.ts`）、纯函数 lib（`*Lib.ts`）、测试文件**同目录**。
- 顶层扁平目录只允许出现「页面/编排层」组件（App*/TopBar/CardPanel 等）；业务组件必须归域。
- 删除一切 shim：不搞「新路径 + 旧路径 re-export」兼容期，消费方与迁移**同一 commit 完成**。

---

## 二、任务分解

> 编号规则：T05.x.y。每个任务含「输入 → 动作 → 验收」。任务间依赖见第四节依赖图。

### T05.1 ui 原子层建设（串行起点，其他任务的地基）

**T05.1.1 骨架与契约**

- 动作：创建 `components/ui/` 目录、`README.md`（写入 1.1 依赖规则与 1.2 样式规范）、`index.ts` barrel、`npm run check:ui-layer` 脚本（rg 规则见 1.1）。
- 输入事实：`common/` 仅 1 文件、`Tooltip/` 目录孤立——两个目录是原子层"现成资产"。
- 验收：目录存在、脚本在放首个业务 import 时失败。

**T05.1.2 ui/Button（从 ui-btn 全局体系提取）**

- 输入：`styles/shell/shell-polish.css:18-84` 的 `.ui-btn` base/sm/md/primary/secondary/ghost/block（31 个 tsx 使用，事实上的统一按钮体系）；`is-danger` 死类（ChatStatusRibbons.tsx:833 使用但无定义，已实测复核仍有效）；6 个 settings pane css 对 `ui-btn-*` 的覆写。
- 动作：
  1. 新建 `ui/Button/Button.tsx` + `Button.module.css`（module 化全局类定义，变量全部走 tokens，如 `--control-height`、`--radius-*`）。
  2. API 设计要点：`variant: 'primary'|'secondary'|'ghost'|'danger'`（danger 为新增变体，补齐审计指出的缺口）；`size: 'sm'|'md'`；`icon?: ReactNode`（图标位）；`loading?: boolean`（自动禁用+aria-busy）；其余透传 `React.ButtonHTMLAttributes<HTMLButtonElement>`。
  3. 先迁移**1 个样板消费者**（如 ToastStack 的按钮）跑通视觉，再批量迁移 31 个 tsx（机械替换 className 字符串 + 清掉 pane 级覆写）。
- 验收：31 个消费方全部换用 `Button`；`ui-btn-*` 全局类从 pane css 中删除；`is-danger` 类引用清零（配合 T05.8）。

**T05.1.3 ui/Dialog（弹窗基座）**

- 输入：`FocusTrap.tsx`（107 行，inert/aria-hidden 旁路已是最佳实践）、`useAnimatedPresence`、`useRestoreFocus` 三件套的现成组合（CheatsheetModal/TelemetryDialog 已示范）。
- API 设计要点：`open`、`onClose`、`title`、`description`（aria-describedby）、`role?: 'dialog'|'alertdialog'`（WithdrawConfirmDialog 需要 alertdialog）、`size?: 'sm'|'md'|'lg'`、`initialFocusRef`、`dismissible?: boolean`（Esc/backdrop 可控，FirstRunWizard 强制步进时需要 `dismissible={false}` 或 Esc 回调接管）、`portalTarget`；内部装配 = FocusTrap + Esc + backdrop + aria-modal + useRestoreFocus + useAnimatedPresence（退出动画由 `--duration-*` token 驱动）。
- 验收：基座含独立测试（Esc 关闭、焦点归还、Tab 循环、inert 旁路还原），供 T05.2 消费。

**T05.1.4 ui/Menu（菜单基座，含坐标统一）**

- 输入：`common/UnifiedSelectPopover.tsx`（262 行，Radix Popover + 防碰撞 + 键盘漫游 + 双模 open，已服务 3 套菜单）；`SelectOptionItem` 类型目前定义在 common/ 下。
- 动作：整体上移为 `ui/Menu/Menu.tsx`；`SelectOptionItem` 导出为 `ui/Menu/types.ts`（公共类型）；从 `SidebarContextMenus` 的 `clampContextMenuPosition` 提炼 `clampPosition` 纯函数进 `ui/Menu/position.ts`（T05.3 三套坐标实现合一的落点）。
- API 设计要点：`trigger`（cloneElement 注入，保留现有 stopPropagation 行为）、`options`/`renderItem`/`children` 三模、`onSelect`、`align`/`side`/`sideOffset`、受控 `open`/`onOpenChange`、`contentClassName`、`maxHeight`、`searchable`（为 SettingsSelect/ModelPicker 迁移预留，暂缓实现）。
- 验收：原 3 个已基于的消费者（ComposePlusMenu/ProjectPickerMenu/SidebarContextMenus）改 import 后全部行为不变（单测覆盖）。

**T05.1.5 ui/Tooltip**

- 输入：`Tooltip/Tooltip.tsx`（143 行，自管 portal + 定位，已修复 ref 透传坑——注释「UnifiedSelectPopover 通过 cloneElement 注入事件会被截断」是历史教训，迁移时必须保留 mergedRef 逻辑与单测）。
- 动作：整体迁入 `ui/Tooltip/`；API 保持 `{content, side, disabled, delayHide}` 不变，避免 20+ 消费点行为漂移。
- 验收：迁移后 diff 仅限路径；现有消费点全量 typecheck。

**T05.1.6 ui/Input 与 ui/Select**

- 输入：全局 `.settings-field-input`（styles/settings/settings-base.css）与私有输入类（firstRunInput 等）并存；`SettingsSelect.tsx`（180 行，portal + 自算坐标 + mousedown 外点关闭 + Esc）。
- 动作：先建 `ui/Input`（props：`size`、`prefixIcon`、`suffix`、`error`、`hint`、透传 input 属性），供 FirstRunWizard/SettingsRulesTab 等首批迁移；`ui/Select` 与 Menu 基座合并实现（listbox 语义 + 坐标/Esc 全部来自基座），在 T05.3.2 中随 SettingsSelect 迁移一并落地，不单开任务。
- 验收：`settings-field-input` 全局类零引用；`SettingsSelect` 不再自算坐标。

### T05.2 弹窗收敛（7 套核心 → ui/Dialog 单实现）

**T05.2.1 迁移顺序与逐套清单**（每套一步，独立 commit；差异点来自 AA-04 3.1 表）：

| # | 弹窗 | 文件 | 已知差异/迁移要点 |
|---|---|---|---|
| 1 | TelemetryDialog | components/TelemetryDialog.tsx | 内联 style 对象 → 迁移时样式入 Dialog 基座或自 module；FocusTrap/Esc/restoreFocus 全部由基座接管 |
| 2 | CheatsheetModal | components/CheatsheetModal.tsx | 已有完整三件套，直接换基座，保留搜索分组渲染 |
| 3 | WithdrawConfirmDialog | components/WithdrawConfirmDialog.tsx | 基座需支持 `role='alertdialog'`；`description` 语义（危险操作确认文案 aria 化） |
| 4 | SkillEditorModal | settings-skills/SkillEditorModal.tsx | 复用 SkillsSettingsTab.module.css + 全局 skills-discover-panel 混用 → 样式归属纠正为本组件 module，顺带把 `:global` 引用清零 |
| 5 | SettingsPanel | components/SettingsPanel.tsx | 753 行大组件，**无 FocusTrap**，自管 Esc 三层优先级 → 基座接管 Esc 后，把「Esc 三层」逻辑抽入 `useSettingsNav`（T05.4.3 联动）；此弹窗迁移须在 SettingsPanel 拆分后执行 |
| 6 | FirstRunWizard | components/FirstRunWizard.tsx | **无 FocusTrap**、手动 focus 首元素 → 基座 `initialFocusRef` 接管；`dismissible` 语义（中途不可任意关闭） |
| 7 | SettingsRulesTab 全文编辑器 | SettingsRulesTab.tsx L600-676 | 全局 settings-dialog 类 + 手动 focus → 基座 + 独立 RulesEditorDialog（T05.4.6 联动） |
| 可选 | QuickOpen | QuickOpen.tsx L192 | 键盘密集，如迁移需验证 / 快捷键焦点序；可延后到 T05.2.2 兜底 |
| 可选 | PreviewCard 历史面板 | PreviewCard.tsx L439-447 | 非模态面板语义（aria-haspopup），评估后可不接基座，仅统一视觉 |
| 可选 | ChatStatusRibbons 计划抽屉 | ChatStatusRibbons.tsx L637-669 | 随 T05.4.1 拆分时一并接入基座 |
| 可选 | AppGlobalDialogs settings-cover | app/AppGlobalDialogs.tsx L127-174 | 全局 settings-cover 类 → 随 SettingsPanel 治理 |

**T05.2.2 收尾验收**：`rg 'role="dialog"'` 在 src 中的命中数归零或全部指向 `ui/Dialog`；每套迁移前后跑其既有 a11y 单测（CheatsheetModal/TelemetryDialog 等均带测试）；人工检查 Esc/backdrop/焦点归还三行为。

### T05.3 菜单收敛（12 套 → ui/Menu 体系）

**T05.3.1 坐标计算统一**：把 3 套独立坐标实现（`clampContextMenuPosition`[SidebarContextMenus]、`SettingsSelect updateCoords`、`PermissionModeMenu updateCoords`）全部收敛到 `ui/Menu/position.ts` 的 `clampPosition`/`measureMenu`；写单测覆盖边界（视口右下角、折叠侧栏、预估高度溢出）。

**T05.3.2 逐套迁移清单**（AA-04 3.2 表）：

| 状态 | 菜单 | 动作 |
|---|---|---|
| 已基于基座 | ComposePlusMenu / ProjectPickerMenu / SidebarContextMenus 排序下拉 | 仅改 import 路径（common → ui/Menu），保留各自搜索/级联/flyout 增强 |
| 待迁移 | SettingsSelect | **保留 listbox/combobox 语义**（原生 select 替代场景），坐标/Esc/外点关闭逻辑并入基座；删除自算坐标 |
| 待迁移 | PermissionModeMenu | 删自算坐标（含预估高度 140 的 hack），改基座 side/align 能力 |
| 待迁移 | ModelPicker / ModelBadgePickerMenu | 删自管 open/close，改基座双模受控 |
| 待迁移 | SettingsQuickMenu | 保留 roving 增强，position/portal 改基座（注意其 btnRef 定位需求——Tooltip 已修 ref 透传，Menu 基座同规则） |
| 待迁移 | ComposerSlashMenu | 纯渲染 + 父级键盘 + aria-activedescendant，位置计算入基座 `position.ts`，键盘漫游保持父级（特殊约定写入注释） |
| 待迁移 | SkillsMoreMenu | 真实现，从 settings-tabs 移入 settings-skills/ 并接基座（随 T05.6 删目录一并做） |
| 待迁移 | ModelsSettingsTab「添加服务商」 | 用全局 sort-filter-menu 类（shell-menus.css）手写内联菜单 → 接基座，删全局类依赖 |
| 收尾 | 全局 `.settings-select-menu`/`.settings-select-item`（styles/shell/shell-polish.css:966-1079）| 全迁移后物理删除（归 T05.5.2） |

**T05.3.3 验收**：12 套菜单中 ≥11 套直接或间接基于 `ui/Menu`（ComposerSlashMenu 属约定例外）；`rg 'sort-filter-menu|settings-select-menu'` 命中归零；每套保留菜单单测。

### T05.4 大组件拆分（ChatStatusRibbons 913 + 其余 9 个 600+）

> 通用第一步（全部适用）：把每个大组件顶部的「文案/aria 纯函数」先行抽 `*Lib.ts`（成本最低、零行为风险、单测现成——ChatStatusRibbons/FirstRunWizard/RuntimePanel 已带导出纯函数与测试）。每组件拆分后运行其既有测试（大多已带 .test.tsx）。

**T05.4.1 ChatStatusRibbons.tsx（913）** — 拆 5 子件 + 1 hook + 1 lib：
- **串行前置（C18，AU-04）**：本任务在 **PE-01 T02.2 之后执行**（PE-01 先删除 sync-engine 分支；SetupHintBanner 按实测 913 行复核无 sync-engine 分支）。
- `SetupHintBanner`（engine/needs-key/needs-model/引导提示，props：`state: RibbonState`、`onAction(id)`）
- `PlanGoalRibbons`（plan/goal 双 ribbon，props：`plan`, `goal`, `onOpenPlan`）
- `RunNoticeBar`（run-notice 播报，props：`runState`, `live`；保留 polite/assertive 分级）
- `ApprovalDock`（审批 dock + 滚动定位，props：`pending`, `onApprove/onReject`）
- `useBackgroundTaskPolling`（3s 轮询 hook）
- `chatStatusRibbonsLib.ts`（前 290 行文案/aria 纯函数 + 6 种 ribbon 状态机常量）
- 计划抽屉（L637-669，已实测复核）随 T05.2.1 接入 Dialog 基座。

**T05.4.2 FirstRunWizard.tsx（834）** — 抽 `useFirstRunWizard`（步进状态机，7 个状态 + 步进逻辑收敛；`currentStep`、`goNext/goBack`、校验函数）+ `WizardKeyStep`/`WizardModelStep`/`WizardImportStep`/`WizardProjectStep` 四个子组件（props 各 2-3 个：值 + setter + 校验错误）+ `firstRunWizardLib.ts`（190 行校验/文案纯函数）；模块级副作用标记 `firstRunOverlayMounted`（L37）移入独立 module 级文件并注释。

**T05.4.3 SettingsPanel.tsx（753）** — 拆：
- `settingsTabsMeta.ts`（TAB_META L115-217 数据文件，10 tab 元数据）
- `SettingsTablist`（roving tablist，props：`activeId`, `onChange`, `items`）
- `useSettingsNav`（搜索过滤 + roving + Esc 三层优先级 + `/` 与 Ctrl+F 快捷键）
- `SettingsWindowControls`（窗口控制按钮组）
- 10 个懒加载 Suspense 分支保留在壳组件；弹窗基座接入随 T05.2.1。

**T05.4.4 SettingsScheduleTab.tsx（700）** — 与 T05.4.8 共享实现（AA-04 明确指出的收敛对）：
- `useWorkflowsState`（筛选/加载/启停/立即执行/持久化，含会话占位副作用 L92-111）
- `WorkflowFormDialog`（创建双入口 paths/form + 编辑表单）
- `WorkflowList`（筛选 + 列表渲染）
- 本文件只留 tab 外壳。

**T05.4.5 RuntimePanel.tsx（692）** — 拆：
- `useRuntimePanelData`（liveTasks 跨 sessions+activeRuns 合并、用量数据收拢）
- `RuntimeSection` 基座（section 头 + 内容插槽，props：`title`, `icon`, `count?`, `children`, `empty`）
- `LiveTasksSection` / `BgTasksSection` / `ApprovalSection` / `PlansSection`（各接 `useRuntimePanelData` 切片）
- 80 行文案纯函数 → `runtimePanelLib.ts`。

**T05.4.6 SettingsRulesTab.tsx（680）** — 拆：
- `useRulesState`（加载/持久化/引擎同步链路）
- `RulesEditorDialog`（复用 ui/Dialog 基座，替代 L600-676 全局类实现）
- 40 行纯函数 → `settingsRulesLib.ts`。

**T05.4.7 PreviewCard.tsx（664）** — 拆：
- `usePreviewNavigation`（导航栈 + 历史 + 书签状态）
- `PreviewToolbar`（地址栏 + 前进后退 + 安全 src 判定输入）
- `PreviewHistoryPanel`（历史/书签双列，随 T05.2.1 评估是否接基座）
- 20s 加载超时状态收进 hook。

**T05.4.8 ScheduledTasksPanel.tsx（656）** — 收敛（非新写）：复用 T05.4.4 的 `useWorkflowsState`/`WorkflowForm`/`WorkflowList`，仅保留外壳差异（run 历史列表 `RunHistoryList` 子件 + props：`open`, `onClose`）。

**T05.4.9 Workspace.tsx（665）** — 拆：
- `WorkspaceColumn`（列：列宽 resize + 折叠 + 组渲染编排，props：`column`, `width`, `onResize`, `collapsed`）
- `WorkspaceGroup`（组：组高 resize + 拖拽预览落点，props：`group`, `items`, `dragState`）
- `useWorkspaceLayout`（拖拽/折叠/宽度状态收拢）
- live region 播报保留在壳层。workspace/ 子目录已抽 Canvas/EmptyState/Resizer，本任务补齐其余。

**T05.4.10 binary-tree/useTopBarDrag.ts（786 hook）** — 按能力拆：
- `useSessionTabReorder`（条内重排状态机）
- `useCanvasDropPlanner`（画布 split 落点规划）
- `topBarDragTypes.ts` / `topBarDragConst.ts`（5 组状态 + 4 组 ref 的类型与常量）
- 功能标签拖拽保留在壳 hook；行为不变（拖拽单测已存在）。

### T05.5 样式规范化

**T05.5.1 tokens 迁移（488 处 hex）**

- 分布（来自审计 26 §1.3E，落地时以脚本复核）：
  - `api/themeStore.ts` **225 处**：调色板常量聚集，属合理，但建议转为 `--palette-*` token 组或保留为「调色板数据文件」并在文件头注释声明例外——**不逐处 token 化**，只做归属标注；
  - `components` **52 处**：全部改引用 tokens；
  - `utils` **48 处**、`services` **6 处**：同上；
  - CSS Modules **10 hex + 29 rgba**：改 tokens 变量；
  - 组件内联 `style` **3 处**：`chat-message/MessageContent.tsx`（`#ef4444` fallback 冗余，`--color-error` 已有→删 fallback）、`settings/SettingsSchemaRenderer.tsx`（`#000000/#888` → token）、`sidebar/SidebarContextMenus.tsx`（`#f85149` → **补定义 `--text-danger` 后删除 fallback**）；
  - `TerminalCard.xterm.tsx:142-178` **19 处**：新增 `--xterm-*` 16 色调色板 token 组（随主题切换），`useXtermTheme` 读取。
- 语义别名收敛表（AA-04 4.2，三套语义名并存）：定 `--color-success`/`--color-danger`/`--color-warning` 为唯一语义名，`--accent-green`、`--accent-orange`、`--danger-color`、`--accent-danger`、`--warning-color` 等 legacy alias 在 styles/tokens.css:73-89 处集中声明为映射并加「deprecated」注释，组件侧逐步换新名。
- 缺 token 清单补齐：`--text-danger`（被 SidebarContextMenus 引用但未定义）、`--z-modal`（见 1.3 单源）等。
- 脚本：提供 `rg -o --glob '*.{ts,tsx,css}' '#[0-9a-fA-F]{3,8}\b' src | ...` 计数复核；验收标准 = components/utils/services 中 hex 归零（themeStore 与 `--palette-*` 例外）。

**T05.5.2 双轨合并（全局类下沉 + 旧定义删除）**：

| 位置 | 现状 | 动作 |
|---|---|---|
| styles/settings/settings-base.css:2419-2430, 2609 | `[MIGRATED]` 标注但 `.settings-select` 旧定义未删 | 物理删除 |
| styles/shell/shell-polish.css:966-1079 | `.settings-select-menu`/`.settings-select-item` 与 SettingsSelect.module.css 功能重复 | 删除（SettingsSelect 迁移完成前置条件：T05.3.2） |
| styles/settings/settings-plugins.css:639-710, 846 | `.settings-select-trigger` 全局类 + 3 处 `:global()` 引用 | 并入 SettingsSelect.module.css；DiffCard/FirstRunWizard/ScheduledTasksPanel 的 `:global` 改 props/类名覆盖 |
| styles/settings/*.css（6 pane 文件） | `ui-btn-*`、pane 专属样式覆写 | 收敛到 ui/Button tokens + `--control-height`/`--radius-*`，pane 差异最小化 |
| 全仓 29 全局 css | 变量重复定义：`--models-green`/`--models-border`/`--models-green-soft` ×3、`--shell-inset-bg` ×2、`--ws-chrome-*` ×2 等 | 变量上收 styles/tokens.css 单处定义，文件内只留引用；`--clickable` 等 8 处疑似误匹配人工核对 |

**T05.5.3 z-index 双源统一**：确定 `styles/z-index.css` 为单源（CSS 变量运行期唯一真值）；`tokens/zindex.ts` 保留但改为由**一致性检查脚本**（`npm run check:zindex`：解析 styles/z-index.css 变量值，与 zindex.ts 常量比对，值不同即失败）约束；删除 styles/tokens.css:244-245 的 `--z-modal: 5000` 重复定义（与 z-index.css 冲突源）及注释中的 `--z-dropdown` 悬空项。

**T05.5.4 双命名修复**：`--space-0_5: 2px`（styles/tokens.css:272）与 `--space-0.5: 2px`（styles/tokens.css:289）——CSS 变量名不允许小数点语义歧义，保留 `--space-0_5`，删除 `--space-0.5` 并替换 `--dropdown-gap`/`--tab-gap` 等引用点（grep `var(--space-0\.5)` 全量替换）。

**T05.5.5 超大 module.css 拆分**：随组件拆分推进（DiffCard 1311、FilesCard 1056、ModelsSettingsTab 853、SkillsSettingsTab 750、ChatToolCallBlock 631）——拆分子组件时对应 css 块一并搬走；FilesCard 的 css 迁移随 T05.6。

### T05.6 目录化收尾（60 扁平 → 域目录 + shim 收口）

**T05.6.1 双轨同名合并**（同一域两个实现的收敛）：

| 顶层文件 | 域目录 | 动作 |
|---|---|---|
| AgentCard.tsx（420） | agent-card/ | 合并进域（AgentTimeline/AgentCardComposer 随 T05.4 拆分后归位） |
| ChatCard.tsx | chat-card/ | 合并进域 |
| ChatMessageList / ChatMessageRow / ChatToolCallBlock | chat-message-list/ / chat-message-row/ / chat-tool-call/ | 壳文件合并 |
| FilesCard.tsx（7 行 shim） | files/ | 消费方（CardPanelLayout.tsx lazy、TreeLeafPanel.tsx lazy）改 import `files/FilesCard`，删 shim |
| OverviewCard.tsx（9 行 shim） | overview/ | 同上 |

**T05.6.2 settings-tabs 整体删除**（7 文件）：`ModelFormDialog`→import `settings-models/ModelConfigEditor`；`ModelList`→`settings-models/ModelProfileList`；`useModelsSettings`→`settings-models/useModelProfilesState`；`SkillList`→`settings-skills/SkillCardList`；`useSkillsSettings`→`settings-skills/useSkillsSettingsState`；`SkillDetailPanel`→`settings-skills/SkillDetailPreview`；`SkillsMoreMenu`（真实现）→移入 `settings-skills/`。消费方 ModelsSettingsTab.tsx:12-15、SkillsSettingsTab.tsx:17-23 与迁移同一 commit。

**T05.6.3 遗留 redirect 删除**：`card-panel/PlanLegacyRedirect.tsx`、`SettingsLegacyRedirect.tsx`（各 12 行）——先 `rg 'focusOrOpenPanel.*overview|SettingsLegacyRedirect'` 确认无入口，无则直接删。

**T05.6.4 其余扁平组件归域**：SettingsSelect/ModelPicker/ModelBadgePickerMenu/PermissionModeMenu/SettingsQuickMenu 等菜单类随 T05.3 归入 `ui/` 或各自域；DiffCard 系 6 文件归 `diff/`（已有目录）；QuickOpen/ToastStack 等按职责归 `shell/` 或新建 `overlay/`；每个扁平组件迁移时其 module.css 同搬（FilesCard.module.css→files/、OverviewCard.module.css→overview/，修正 `'../FilesCard.module.css'` 反向引用）。
- 迁移后顶层剩余白名单：App 系、CardPanel 系、页面编排系。

**T05.6.5 验收**：`components/` 顶层扁平 tsx ≤ 20（编排层白名单）；`rg '\.\./[A-Z].*module\.css'` 零反向引用；`settings-tabs/`、`common/`、顶层 `Tooltip/` 目录不存在。

### T05.7 命名债务清理（daemon/WS 旧命名）

> 输入事实：全 src 约 99 个文件含 daemon/WebSocket/ws 字样（审计口径；执行时用脚本复核）；`api/daemon-chat-bridge/` 4 文件被 16 个非测试文件消费；`hooks/useDaemonState.ts` 被 2 组件使用；`services/ConnectionManager.ts:243-246` 广播 `'daemon:connection:change'`；`api/transport/index.ts:1-8` 注释已声明「WS 链路已删除，Tauri IPC 为唯一路径」——**运输层已切干净，仅命名与目录残留**。

**T05.7.1 文件清单生成方式**（机械、可复核）：
```powershell
# ① 含 daemon/WebSocket/ws:// 的文件全集（排除测试与非本目录）
rg -l --glob "!*.test.*" --glob "!tests/**" "daemon|WebSocket|ws://" src > T05.7-filelist.txt
# ② 目录重命名影响面（import 路径引用）
rg -l "daemon-chat-bridge" src
# ③ 标识符/事件名影响面
rg -l "useDaemonState|daemon:connection:change|streamViaDaemon"
# ④ 文案面（streamDiag /websocket|network/ 文案）
rg -l "网络|websocket|network" src/handlers src/api/daemon-chat-bridge
```
清单按三批落盘，每批独立 commit（批间可并行给不同执行者，见第四节冲突说明）。

**T05.7.2 机械重命名流程**（每批内按此序）：
1. `git mv` 目录/文件（`api/daemon-chat-bridge` → `api/engine-bridge`；`hooks/useDaemonState.ts` → `hooks/useEngineState.ts`；`api/daemon-chat-bridge/streamViaDaemon.ts` → `streamViaEngine.ts` 等，文件名保留语义前缀 `*Engine*`）；
2. 全量 import 路径替换（`rg "daemon-chat-bridge" -l | % { (Get-Content $_) -replace ... | Set-Content }` 或统一 sed 脚本）；
3. 标识符替换：`useDaemonState` → `useEngineState`；`ConnectionManager` 事件名 `'daemon:connection:change'` → `'engine:connection:change'`（**事件名修改须同时更新发布方 ConnectionManager.ts:243-246 与订阅方 grep `'daemon:connection'` 的 2-3 处**，保持字符串精确匹配，严禁模糊 replace）；
4. 文案替换：streamDiag 中 `/websocket|network/` 相关文案更新为「引擎连接中断」（IPC 语境），仅限 `handlers/streamState.ts` 等 3 个消费文件；
5. 每步后 `npm run typecheck`；批末 `rg "daemon|WebSocket" src --glob "!*.test.*"` 归零（允许历史注释豁免清单，写入文件头）。

> **重命名时序声明（C17，AU-04）**：`useDaemonState.ts → useEngineState.ts`、事件名 → `'engine:connection:change'` 由本任务**末轮统一**执行；**PE-01 T04.3 / PE-06 T06.8 组 2 在各自轮次内继续用旧名 `useDaemonState` 开发**（不得抢跑改名，避免并行文件冲突）。**发布/订阅一致性单测由本任务负责**（订阅方与 `ConnectionManager` 广播的事件名字符串逐对断言一致，T05.7.3 ③ 落地）。

**T05.7.3 风险控制**：① 每个文件同时只被一个执行者改（批粒度）；② 先改消费方 import 再删旧文件（或 `git mv` 一步到位保 history）；③ 事件名是运行时字符串，加单测断言订阅/发布一致；④ `api/transport/index.ts` 与 `bootstrap-full.ts` 等 16 消费文件的清单在开工前 `rg` 冻结，避免与其他任务（T05.4 拆分 RuntimePanel 等）重叠改同一文件——重叠时以本任务为文件 owner。

### T05.8 死代码清理

| 目标 | 位置 | 动作 |
|---|---|---|
| `is-danger` 死类 | ChatStatusRibbons.tsx:833（全仓无 CSS 定义，已实测复核） | ui/Button 提供 danger 变体后，删除该类引用（联动 T05.1.2） |
| `AgentContextMenuState` @deprecated | SidebarContextMenus.tsx:36-41 | 确认子 agent 不再进侧栏树后删除类型 + 4 个 @deprecated props（L76-83） |
| `onOpenRight`/`onOpenWindow` @deprecated props | AgentCard.tsx:52-56 | 删除，消费方（若存在）同步清理；随 T05.6.1 合并 agent-card 时执行 |
| `pickFolderNative` @deprecated 导出 | ProjectPickerMenu.tsx:43-45 | 删除 |

> 修订（AU-04）：原「`LoggerService`（109 行，0 调用）」行**删除**——LoggerService 接线归 **PE-04 T04.4-1**（日志域），本域不回收、不处置。

**验收**：`rg "@deprecated" src/components` 归零；`rg "is-danger" src` 归零；`npm run typecheck` 全绿。

### T05.9 迁移期视觉回归门禁（引用 PE-11，owner 确认）

> 新增（AU-04 认领表 #3，2026-08-01）：前端测试策略（e2e/visual 回归门禁）已由 **PE-11 产出完整任务书 T11.1/T11.2**（visual 基线与 diff 阈值、story 清单、`test:visual:update` 流程均归 PE-11）。本任务**只做引用与配合义务确认，不另建基线体系**。

- **owner 确认**：视觉回归门禁体系 = **PE-11 T11.2**（基线入库、阈值 `maxDiffPixelRatio: 0.01`、golden 变更显式审查）；e2e 场景 = PE-11 T11.1。本方案不重复实现。
- **本域配合义务（PE-11 T11.2 联动条款）**：每个 pane/组件迁移单元（T05.1.2 / T05.2 / T05.3 / T05.5 逐套）提交前跑 `npm --workspace @crish/crish-desktop run test:visual`——迁移前后各拍一次，diff 归零或人工确认（将本方案「视觉目检」要求升级为自动化基线）。
- **前置条件**：PE-11 T11.1 双 config 归一后 `test:visual` 只扫 `tests/visual`；T05.9 不阻塞 PE-05 开工（story 基线先立，PE-11 阶段 1 完成即可配合）。
- 验收：PE-05 每迁移单元在迁移日志或 PR 截图附件中留有 visual diff 记录（对齐 PE-11 T11.2 V3）；无「未跑 visual 即合入」的迁移单元。

---

## 三、风险

### R1 · 大规模重命名冲突面（高）
- 面：99 文件 daemon/WS 命名 × 16 个 daemon-chat-bridge 消费文件 × 事件名字符串 × T05.4/5/6 同时动 `RuntimePanel.tsx`、`OverviewCard.tsx`、`SettingsPanel.tsx` 等文件。
- 缓解：T05.7 清单开工前冻结（`rg` 落盘到 `docs/rust-rewrite/plans/T05.7-filelist.md`）；按批串行 + 批间独立执行者；事件名加发布/订阅一致性单测；每批以 `npm run typecheck` + `rg` 归零为通过线。

### R2 · 样式回归（高）
- 面：双轨合并（T05.5.2）与 ui-btn/Button 迁移（T05.1.2）动全仓 31 个按钮消费点 + 6 个 pane css；`:global(.settings-select-trigger)` 3 处引用链。
- 缓解：迁移遵循「先建等价 module 类 → 对照替换 → 视觉目检 → 删全局旧类」四步；每 pane 迁移前后跑 visual 测试（**T05.9 配合 PE-11 T11.2**：`npm --workspace @crish/crish-desktop run test:visual`，自动化基线 + diff 阈值替代人工目检）；对 `--space-0.5` 等变量改名执行「先 grep 全引用确认 ≤N 处再改」规则；is-danger 依赖链先补 danger 变体后删除，不产生视觉空洞。

### R3 · 大组件拆分行为漂移（中）
- 面：轮询/副作用时序（ChatStatusRibbons 3s 轮询、SettingsScheduleTab 会话占位副作用 L92-111）、焦点管理（SettingsPanel Esc 三层）拆进 hook 后时序变化。
- 缓解：拆分 = 「先抽 lib 纯函数（零行为风险）→ 再抽 hook（保行为测试）→ 最后拆渲染」三步；依赖既有测试（ChatStatusRibbons 2 个、FirstRunWizard、UnitSessionTabStrip 3 个等）；拆后跑全量 `npm run test` 相关用例 + `typecheck`。

### R4 · 弹窗收敛 a11y 回归（中）
- 面：FirstRunWizard/SettingsPanel 原本无 FocusTrap，接入基座后焦点行为改变（可能暴露原本被掩盖的缺陷）。
- 缓解：基座三件套独立单测先行（T05.1.3 验收强制）；每套迁移对比「Esc/backdrop/焦点归还/Tab 循环」四项人工清单；role=alertdialog 语义单测（WithdrawConfirmDialog）。

### R5 · 与 store/其他域计划的文件重叠（低-中）
- 面：`layout-tree/operations.ts`（1015）、`workspace-shell/adapterShape.ts`（729）在 store 域计划里也是拆分对象，本方案不触碰；但 T05.7 的 `bootstrap-full.ts` 与 store 域可能重叠。
- 缓解：本方案范围明确排除 store/ 目录一切文件；重叠文件（见 R1 冻结清单）以 T05.7 为 owner，执行顺序上 T05.7 排最后（见第四节）。

### R6 · 迁移中途双轨状态失控（中）
- 面：T05.2/3 迁移期「新旧并存」，新代码可能继续引用旧类/旧路径。
- 缓解：迁移 commit 粒度 = 「一个消费者 + 对应旧类删除」原子化；`check:ui-layer` 与 `rg` 归零脚本在 CI 前置；禁止新代码 import `common/`、`settings-tabs/`（在 ui/README 与 CR 规则中明示）。

---

## 四、执行顺序与并行性

### 4.1 依赖图（串行骨架）

```
T05.1 原子层 ──┬─> T05.2 弹窗收敛 ──┬─> T05.5 样式规范化（部分）
               ├─> T05.3 菜单收敛 ──┴─> T05.6 目录化收尾 ──> T05.7 命名清理（最后）
               └─> T05.4 大组件拆分（每组件独立，与 2/3 并行）
T05.8 死代码清理：is-danger 依赖 T05.1.2；deprecated 清理依赖 T05.4/6 相关文件稳定
T05.9 视觉回归门禁（引用 PE-11 T11.2，配合义务）：随 T05.1.2/5.2/5.3/5.5 各迁移单元并行执行
```

### 4.2 可并行组合

| 并行组 | 任务 | 冲突说明 |
|---|---|---|
| 组 A | T05.4 的**各个大组件拆分**（10 个互相独立） | 唯一例外：SettingsPanel（T05.4.3）与 T05.2 的 SettingsPanel 弹窗迁移同文件——约定 SettingsPanel 拆分先行，弹窗接入随后 |
| 组 B | T05.5.1（tokens 迁移）与 T05.4 各拆分 | 拆分子组件时顺带 token 化，减少二次遍历 |
| 组 C | T05.6.1/6.4（目录化）与 T05.4 | 目录迁移只动 import 路径，组件拆分开新文件，无文件级冲突；**CSS 归属**（FilesCard/OverviewCard module）以 T05.6 为 owner |
| 组 D | T05.3 菜单收敛与 T05.1.4 Menu 上移 | 严格串行：先上移基座再逐套迁移 |
| 组 E | T05.8 与 T05.1/5 | is-danger 依赖 Button danger 变体；其余 deprecated 清理可独立并行 |
| **不可并行** | T05.7（命名清理） | 与 T05.4/5/6 中 16 个重叠文件冲突——**排在全部任务之后**执行；且自身按 4 批内部串行 |
| **不可并行** | T05.5.2（双轨合并） | 依赖 T05.2/3 全部迁移完成（旧全局类才有资格删）——放 T05.2/3 之后 |

### 4.3 建议总序（最小化返工）

1. **T05.1**（原子层骨架 + Button/Dialog/Menu/Tooltip/Input）
2. **T05.4** 全部拆分（并行）＋ **T05.5.1** tokens 迁移（并行）
3. **T05.2** 弹窗收敛、**T05.3** 菜单收敛（可并行，二者文件域不重叠）
4. **T05.5.2/5.3/5.4** 双轨合并 + z-index 单源 + 双命名修复
5. **T05.6** 目录化收尾（含 settings-tabs 删除、CSS 迁移）
6. **T05.7** 命名债务清理（最后，冻结清单；C17 时序：PE-01 T04.3 / PE-06 T06.8 组 2 用旧名开发完成后本任务统一改名）
7. **T05.8** 死代码清理（is-danger 依赖 1 已满足；deprecated 随 2/5 已稳定）
8. **T05.9** 视觉回归门禁（引用 PE-11 T11.2）：全程随各迁移单元执行，story 基线由 PE-11 先立，不阻塞本方案开工

### 4.4 每任务通用 DoD（完成定义）

- `npm run typecheck` 全绿；
- 任务相关 `rg` 归零断言（每个任务头部写明的断言）通过；
- 相关单测通过（`npx vitest run <affected>`），迁移涉及弹窗/菜单/样式的按 **T05.9**（PE-11 T11.2 门禁）跑 visual：迁移前后各拍一次，diff 归零或人工确认；
- 无新 TODO/FIXME 引入（现状仅 6 处，维持纪律）；
- 变更 commit 粒度 = 任务粒度，commit message 前缀 `feat(ui)/refactor(components)/style(tokens)` 匹配仓库惯例。

---

## 五、验收总纲（全部任务完成后）

1. `components/ui/` 存在且仅含 6 原子组件（Button/Input/Dialog/Menu/Tooltip/Select）+ barrel + README；`common/`、顶层 `Tooltip/`、`settings-tabs/` 不存在。
2. `rg 'role="dialog"' src` 命中全部经 ui/Dialog；`rg 'UnifiedSelectPopover' src` 的 import 全部来自 ui/Menu。
3. 顶层扁平 tsx ≤ 20；无 `*.module.css` 反向引用；module.css 与组件同目录。
4. `src/components`、`src/utils`、`src/services` 中裸 hex 归零（themeStore 调色板例外已标注）；`:global(` 归零；`ui-btn-*`/`settings-select-*` 全局类定义不存在。
5. z-index 单源校验脚本 `npm run check:zindex` 通过；`--space-0.5` 不存在；`--text-danger` 已定义且无 fallback 依赖。
6. `rg 'daemon|WebSocket|ws://' src --glob "!*.test.*"` 归零（历史注释豁免清单除外）；`daemon:connection:change` 不存在。
7. `rg '@deprecated|is-danger' src/components` 归零。
8. 12 套菜单 ≥11 套基于 ui/Menu 体系；7 套核心弹窗 + 可选 4 处全部收敛（或明确豁免并记录理由）。
9. **T05.9**：每个迁移单元有 visual diff 记录（对齐 PE-11 T11.2 门禁与 V3 验收），无未跑 visual 即合入的迁移单元。
