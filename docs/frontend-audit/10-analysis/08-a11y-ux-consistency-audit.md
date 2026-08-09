# 前端可访问性（a11y）与 UX 一致性审计

- 审计对象：`apps/crish-desktop`（React 19）
- 审计时间：2026-08-09
- 审计范围：语义与 ARIA、键盘可达、对比度与视觉可达、动效偏好、文案与提示一致性、交互模式一致性、键盘/触屏/鼠标三态、严重度分级
- 方法：全量源码实读 + 正则扫描（按钮/aria-live/Tooltip 消费面）+ WCAG 2.1 对比度实测计算
- 结论概览：**P0 阻断 0 项；P1 明显缺失 8 项；P2 一般缺失 10 项；P3 轻微 5 项；合计 23 项**

---

## 0. 总览与资产盘点

代码库的 a11y 基建已相当成熟，值得先肯定：

| 资产 | 证据 |
| --- | --- |
| Dialog 三件套（focusTrap + Esc 栈 + 焦点还原） | `src/components/ui/Dialog/Dialog.tsx`（Esc 栈 30 行、aria-modal/labelledby/describedby 163-167 行）、`focusTrap.tsx`（inert/aria-hidden 旁路 45-74 行）、`useRestoreFocus.ts` |
| 7 套核心弹窗已收敛 ui/Dialog | WithdrawConfirmDialog / TelemetryDialog / CheatsheetModal / SkillEditorModal / SettingsPanel / RulesEditorDialog / FirstRunWizard（AppGlobalDialogs.tsx:115-168 装配） |
| aria-live 覆盖广泛（63 处） | 通知区（AppGlobalDialogs.tsx:107）、ToastStack、RunNoticeBar（polite/assertive 分级，chatStatusRibbonsLib.ts:254-264）、BgTaskActions、PlanGoalRibbons、ApprovalAskCard、DiffCard 等 |
| toast 文案策略（成功禁 toast、错误分级） | `src/hooks/useToastQueue.ts:75-144`（FORBIDDEN_SUCCESS_TOAST_PATTERNS）、`applyFileDiff.ts:179` |
| 全局焦点环与 reduced-motion | `styles/focus-visible.css`（:focus-visible 全局 outline）、`styles/reduced-motion.css`（全局 @media 覆盖，index.css:24 引入） |
| 键盘漫游标杆 | SessionRow（Enter/Space/F2/ContextMenu/方向键/Home/End/Alt+方向键重排，SessionRow.tsx:245-277）、UnitSessionTabStrip（S4.5 roving tabindex + Arrow/Home/End/Delete）、SettingsTablist、SidebarContextMenus（focusMenuItem 87-124 行） |
| focus-within 配对 hover 的成熟惯例 | 38 处（GlobalSessionTabBar.module.css:258、settings-base.css:1691、chat-markdown.css:149、chat.css:1204 等） |

**但存在三处「资产分裂」**，是本次审计的主线问题：
1. Tooltip 新旧两版实现并存，a11y 能力显著不均（见 ①-1）；
2. 确认对话框有三套实现并存（ui/Dialog / window.confirm / 内联两步确认，见 ⑥-2）；
3. 快捷键展示文案双源（ShortcutRegistry vs SettingsShortcutsTab 静态副本，见 ⑤-4）。

---

## 1. 语义与 ARIA

### 1.1 【P1】Tooltip 新旧两版分裂：a11y 修复版仅 3 处消费，旧版 88 处消费无 aria

- 新版 `src/components/ui/Tooltip/Tooltip.tsx`（F7-F8 修复）：focus/blur 触发（262-273 行）+ aria-describedby 关联（275-280 行）+ 视口钳位。
- 新版消费方仅 3 处：`WorkflowList.tsx:9`、`ScheduledTasksPanel.tsx:19`、`RunHistoryList.tsx:9`（均 `import { Tooltip } from '../ui'`）。
- 旧版 `src/components/Tooltip/Tooltip.tsx`：**仅 hover 触发（102-120 行），无 focus 触发、无 aria-describedby、无 aria 关联**；消费方 88 处（grep 全量统计，含 AppTopBar、AgentCard、DiffCard、ChatComposer、FileTreeView 等全部核心面）。
- 后果：① 键盘用户聚焦图标按钮时看不到 tooltip 说明；② 屏幕阅读器读不到 tooltip 内容；③ 同一产品的提示行为在「设置-定时任务」与其余 85 个界面不一致——直接命中用户痛点「同一效果不同呈现」。
- 修复方向：以 ui/Tooltip 为唯一实现，88 处消费方统一改 import（API 兼容，注释声明「API 保持 {content, side, disabled, delayHide} 不变」）。

### 1.2 【P1】纯图标按钮无可访问名 14 处（16 个按钮）

扫描方法：正则提取全部 `<button>` 块，剔除含 aria-label/aria-labelledby/title/aria-hidden/文本内容后逐一人工核对（已排除含 JSX 文本表达式者）。

| # | 位置 | 图标 | 语义 |
| --- | --- | --- | --- |
| 1-5 | `DiffCardFileList.tsx:152/166/178`（hoverActBtn）、`:264/278`（inlineActionBtn） | Minus/Plus/Undo2/Check/X | 取消暂存/暂存/放弃修改/接受/拒绝 |
| 6-7 | `FileActions.tsx:76`（filesOpenChev）、`:96`（filesNavBtn） | ChevronDown/MoreHorizontal | 选择打开方式/更多菜单 |
| 8-9 | `FilesCard.tsx:148/153`（filesNavBtn） | CornerLeftUp/RotateCw | 上级目录/刷新 |
| 10-12 | `FileViewerCard.tsx:249/307/319` | ChevronDown/Copy/MoreHorizontal | 打开方式/复制源码/更多 |
| 13-14 | `ModelConfigEditor.tsx:672/692` | SlidersHorizontal/Trash2 | 配置/删除 |

- 全部仅由旧版 Tooltip（无 aria）兜底 → 屏幕阅读器读出无名的 "button"。
- 同文件对比强烈的反例：`ModelConfigEditor.tsx:660-666` 相邻的启用开关有 `aria-label`；`DiffCardFileList.tsx:224/235/249` 上方三个 inlineIconBtn 有 aria-label，而下方 264/278 没有——同一行内标准不一。
- 修复方向：统一补齐 aria-label（内容与 Tooltip content 同源，或直接迁移 ui/Tooltip 并移除冗余 label 文案）。

### 1.3 【P1】BgTaskActions 内联确认行滥用 role="alertdialog"（非模态）

- `BgTaskActions.tsx:179`：`<div className={styles.confirmRow} role="alertdialog" aria-label="确认终止任务">`。
- alertdialog 语义要求模态性质与焦点管理（WAI-ARIA：alertdialog 必须位于 modal dialog 上下文中）。此处为卡片内联展开区：无焦点圈定、无初始焦点、无焦点归还、无 Esc 关闭。
- 同时它是**第三套确认交互**（与 ui/Dialog、window.confirm 并存，见 ⑥-2）。
- 修复方向：改用 ui/Dialog（role=alertdialog）+ 收敛到同一确认路径。

### 1.4 【P2】动态状态区域 aria-live 覆盖不均

缺失面：
- `ChatStatusRibbons.tsx`：动态状态条（快捷状态 chip、后台任务数、计划模式）只有 `role="region" aria-label`（257 行），**无 aria-live**——「正在思考/运行中/任务完成」等变化不播报。
- `chat-message-list/`（ChatMessageList.tsx、MessageVirtualizer.tsx）：整目录无 aria-live/role="log"/aria-busy（MessageVirtualizer 仅 196 行 `role="region" aria-label="会话消息"`）——流式新消息到达无播报。
- 对比已覆盖面：BgTaskActions:212/224、RunNoticeBar:34、PlanGoalRibbons:58/86、ApprovalAskCard:561/658、ChatEmptyState:265、ToastStack:45、Workspace:121 等 63 处——**覆盖极不均**。
- 修复方向：消息列表容器加 `role="log" aria-relevant="additions"`；ChatStatusRibbons 状态条加 `aria-live="polite" aria-atomic`。

### 1.5 【P3】DiffCardFileList listbox 语义与行为不符

- `DiffCardFileList.tsx:301`：`role="listbox" aria-label="变更文件列表"`，内部按钮（111 行）`role="option"`。
- 无 roving tabindex、无 Arrow/Home/End 键处理——所有 option 均为独立 Tab 停靠点，不满足 listbox 键盘交互模式（WAI-ARIA listbox 需方向键漫游）。
- 修复方向：要么补 roving tabindex + 方向键，要么降级为普通列表语义（role="list"）。

### 1.6 【P3】Select combobox aria 状态核查结论（验证通过，非问题）

- `Select.tsx:132-136`：`role="combobox" aria-haspopup="listbox" aria-controls={listboxId}`，注释称 aria-expanded 由 Radix Trigger 注入。
- 已核查 vite 缓存产物 `@radix-ui_react-popover.js`：Trigger 确实注入 `aria-expanded: context.open`（3042 行），且用户属性 spread 在后（Select 的 aria-haspopup="listbox" 覆盖 Radix 的 "dialog"，语义更准确）。**验证通过，无问题**。

---

## 2. 键盘可达

### 2.1 【P1】ChatHeaderMore：renderItem 无 role="menuitem"，键盘漫游完全失效

- `ChatHeaderMore.tsx:77-90`：renderItem 渲染的按钮**没有 role="menuitem"**。
- `ui/Menu/Menu.tsx` 的焦点漫游：焦点跟随查询 `[role="menuitem"], [role="option"]`（177-178 行）→ 查不到任何目标 → `target?.focus()` 落空。
- 又因 Radix Popover 不自动聚焦内容，菜单打开后焦点停留在 trigger；keydown 事件路径（trigger → body）**不经过 portal 中的 Popover.Content**，`handleKeyDown`（Menu.tsx:129-171）收不到任何 ↓/↑/Enter → 键盘用户打开「⋯」菜单后无任何键可操作。
- 对比：options 模式（默认渲染）与 SkillsMoreMenu（children + 双传 options）均因元素带 role 而正常。
- 修复方向：renderItem 模板补 `role="menuitem"`，或在 Menu 基座中将漫游查询改为「content 内全部可聚焦项」并给 renderItem 项设置 data 索引。

### 2.2 【P1】LeafToolTabStrip「添加功能面板」菜单：仅 onPointerDown 打开，键盘无响应

- `LeafToolTabStrip.tsx:129-140`：加号按钮只有 `onPointerDown` 打开/关闭菜单，**无 onClick、无 onKeyDown** → Enter/Space 完全无反应（键盘阻断）。
- 菜单本体（152-176 行）无 Esc 关闭、无焦点圈定、无方向键；backdrop 关闭也仅 pointerdown。
- 修复方向：补 onClick 开关 + Esc 关闭 + 打开时焦点移入菜单首项。

### 2.3 【P1】ModelBadgePickerMenu：模型切换 hover-only，键盘完全不可达（核心功能阻断）

- `ModelBadgePickerMenu.tsx:79-88`：profile 行按钮**无 onClick**（点击无效），仅 `onMouseEnter`（76 行）展开 `mbSubMenu`。
- 子菜单（90-115 行）由 `isHovered` 状态驱动渲染——键盘用户 Tab 到行按钮后，Enter 无反应，子菜单永不出现，**模型切换（对话核心功能）在聊天页键盘无路径**（仅能绕道设置-模型页）。
- 外层 `ui/Menu` 为 children 模式（未传 options）→ 无方向键漫游。
- 修复方向：行按钮补 onClick/Enter 展开（或改为标准 Menu 的 options 模式 + 嵌套菜单键盘路径）。

### 2.4 【P1】DiffCard hover 动作区 display:none 隐藏，暂存/放弃按钮键盘不可达

- `DiffCard.module.css:839-847`：`.hoverActions { display: none }` → `.accordionHeaderRow:hover .hoverActions { display: flex }`。
- 内含暂存/取消暂存/放弃修改三个操作（`DiffCardFileList.tsx:152/166/178`）——`display:none` 元素不进入 Tab 序，**键盘用户无法触达 diff 面板的核心暂存操作**（对比 GlobalSessionTabBar 用 `:focus-within` 正确处理的同类场景）。
- 修复方向：改为 `opacity/visibility + :focus-within` 揭示（对照 GlobalSessionTabBar.module.css:258 的既有成熟模式）。

### 2.5 【P2】ui/Menu children 模式（未传 options）无键盘漫游

- `Menu.tsx:133`：漫游逻辑仅在 `options.length > 0` 时生效；children 模式（ProjectPickerMenu.tsx:118、ModelBadgePickerMenu.tsx:50、SkillsMoreMenu 部分）→ 打开后 ↑↓/Home/End 全部空转。
- ProjectPickerMenu 因有 autoFocus 搜索框 + 原生按钮 Tab 序，键盘尚可「退而求其次」使用；SkillsMoreMenu 因双传 options 才获得漫游（依赖调用方自觉）。
- 修复方向：Menu 基座在 children 模式提供默认漫游（对 content 内可聚焦项轮询），或强制要求 children 模式自带键盘处理。

### 2.6 【P3】LeafToolTabStrip role="tab" 无 roving tabindex/方向键

- `LeafToolTabStrip.tsx:91-98`：role="tab" 但无 roving tabindex、无 Arrow/Home/End（对比 UnitSessionTabStrip.tsx:314-328 的 S4.5 完整实现）——两个 tab 条实现能力不一致。
- 注：tabClose 关闭钮（102-119 行）Enter/Space 已处理且带 aria-label，细节到位。

### 2.7 【P3】快捷键「Escape Escape」与全局关闭语义冲突（键盘危害）

- `ShortcutRegistry.ts:24`：`branch_session: 'Escape Escape'`（双击 Esc = 分叉会话）；`ShortcutService.ts:157-163`：序列超时窗 **500ms**。
- 冲突链：对话框打开中按 Esc 关闭 → 500ms 内再按一次 Esc → **静默分叉当前会话**（AppShortcuts.ts:143-161 触发 branchSession）。习惯性连按 Esc 的用户（及 SR 用户快速关闭）会意外复制会话。
- 缓解因素：有 toast + 撤销（AppShortcuts.ts:152-159），故定为 P1 之下的键盘冲突项——见 ⑥-3 的清单；本处归属键盘可达，评级 **P1**（用户无意识操作导致状态变化）。

---

## 3. 对比度与视觉可达

按 WCAG 2.1（AA：正文 4.5:1，大字/UI 组件 3:1）实测计算（sRGB 相对亮度）：

### 3.1 token 级对比度实测（light 主题）

| 组合 | 比值 | 判定 | 用途 |
| --- | --- | --- | --- |
| #111111 / #f0eee9（text-primary/bg-primary） | 16.29:1 | ✅ | 正文 |
| #555555 / #f0eee9（text-secondary） | 6.43:1 | ✅ | 次级正文 |
| **#888888 / #f0eee9（text-tertiary）** | **3.06:1** | ❌ 4.5:1 | 时间戳/提示/ghost 按钮文字 |
| #888888 / #e9e5de（bg-secondary 侧栏） | 2.82:1 | ❌ | 侧栏元信息 |
| **#f59e0b（accent-orange）/ #f0eee9** | **1.85:1** | ❌ 3:1 也不满足 | 警告/增减计数 |
| **#2f81f7（accent-blue）/ #f0eee9** | **3.23:1** | ❌ 4.5:1（大字 3:1 勉强） | 链接/强调文字 |
| #16a34a（color-active）/ #f0eee9 | 2.84:1 | ❌ 3:1 | 状态点/状态文字 |
| #e8590c（ui-text-warning）/ #f0eee9 | 3.09:1 | ❌ 4.5:1 | StatusDiagnosticsPanel WARN |

### 3.2 token 级对比度实测（dark 主题）

| 组合 | 比值 | 判定 |
| --- | --- | --- |
| #f0f0f0 / #0d0d0d | 16+:1 | ✅ |
| #a3a3a3 / #0d0d0d | 7.7:1 | ✅ |
| #737373（text-tertiary）/ #0d0d0d | 4.1:1 | ⚠️ 边缘（4.5 差 0.4） |
| #ffa94d（warning）/ #0d0d0d | 10.21:1 | ✅ |
| #4d94f8（blue）/ #0d0d0d | 6.39:1 | ✅ |

### 3.3 问题清单（P2）

- **P2-1 light text-tertiary 3.06:1 大面积不达标**：时间戳、ghost 按钮（`shell-polish.css:67` .ui-btn-ghost color: var(--text-tertiary)）、侧栏元信息（2.82:1 更低）等均为小字号正文用法。
- **P2-2 accent-orange 1.85:1 作为文字色**：`ChangesSection.tsx:128/139` 改动增减计数 `em`（+N −N）用 `var(--accent-orange)` 渲染小字——几乎不可读；`FileTreeView.tsx:213`、`ModelConfigEditor.tsx:799` 亦用橙色做状态。绿色 `+N`（#46724c，4.8:1）达标——**同列表红绿两色一达标一不达标**。
- **P2-3 color-active 绿 2.84:1 状态点/状态字**：`ModelProfileList.tsx:273` 状态点 + `--color-active`（tokens.css:114 #16a34a）在浅色底低于 3:1（UI 组件线）。
- **P2-4 dark text-tertiary 4.1:1 边缘**：接近但不达 4.5，元信息量大时可察觉。
- 积极项：dark 主题整体达标（F7-F27 已修复 dark 语义色，tokens.css:492-500）；danger 红 #c93a3a 文字 4.36:1 属大字场景可接受；禁用态（opacity 0.5）属 WCAG 豁免。

---

## 4. 动效与偏好

### 4.1 reduced-motion 覆盖：全局且正确

- `reduced-motion.css`（index.css:24 全局引入）：`prefers-reduced-motion: reduce` 下全局 `animation/transition-duration: 0.01ms !important` + token 变量清零（4-43 行）+ `.essential-animation` 白名单保留加载提示（45-50 行）。
- 组件级补充：ApprovalDock.module.css:78、PreviewCard.module.css:124、PlanGoalRibbons.module.css:113、panels.css:734 各有局部 @media 覆盖。
- `--transition-*` token 化程度高：全局扫描 transition 声明绝大多数走 `var(--transition-micro/fast/exit/accordion)`（settings-models.css、chat.css、panels.css 等），并有 eco 性能档整体清零（tokens.css:699-714）。

### 4.2 【P3】硬编码过渡残留（3 处）

- `ApprovalAskCard.module.css:297`：`transition: width 0.1s linear`（应为 --transition-press/--duration-micro 100ms）。
- `tab-drag.css:42/46`：`transition: all 0.28s cubic-bezier(0.19,1,0.22,1)` / `0.2s ease-out`（被全局 reduce 兜住，但非 token）。
- `InlineAgentPanel.module.css:193/203`：inline fallback（值与 token 一致，属冗余写法）。
- 均为 P3（全局 reduce 已覆盖，仅一致性瑕疵）。

### 4.3 【P2】lightweight 模式的 data-reduced-motion 死钩子

- `lightweightMode.ts:56`：`document.documentElement.setAttribute('data-reduced-motion', 'true')` 在轻量档写入，**全仓库无任何 CSS/JS 消费该属性**（grep 确认）——轻量档「disableAnimations」意图未接线（config.disableAnimations 只影响 highlight/markdown 缓存等，动画实际仍在跑）。
- 修复方向：在 reduced-motion.css 或全局层补 `[data-reduced-motion]` 选择器（与 @media 同语义）。

---

## 5. 文案与提示一致性

### 5.1 做得好的部分

- 空态文案高度统一：「暂无X」模式（暂无消息/暂无会话/暂无后台任务/暂无技能/暂无诊断记录/暂无书签……30+ 处全量抽查一致）。
- 错误重试文案统一：「X失败，请重试」（ApprovalSection:103/122、TrashSection:68/91）与「重试」按钮（AppErrorBoundary、SettingsRulesTab:119、PreviewCard:174 等）。
- toast 成功/错误策略统一收敛在 `useToastQueue.ts`（成功类禁 toast 白名单 75-144 行，防止成功刷屏回流；引擎未同步降级文案规则 224-247 行）。
- 按钮顺序统一：[取消] [确认]（WithdrawConfirmDialog.tsx:44-54、BgTaskActions:181-198、AppErrorBoundary Fix#19 注释 10 行）。

### 5.2 【P2】加载态按钮文案不齐（同一场景 3 种写法）

| 位置 | 文案 |
| --- | --- |
| `RulesEditorDialog.tsx:65` | 保存中… |
| `SettingsProfileTab.tsx:235/245/279` | 导出中… / 导入中… / 测试中… |
| `WorkflowForm.tsx:230` | **仅「…」**（无动词，语义空洞） |
| `FileViewerCard.tsx:386`、`DiffCodeViewer.tsx:41` | 正在加载源码**...**（ASCII 三点） |

- 同是「保存」类按钮：一个「保存中…」、一个「…」；省略号风格 .（半角三点）与 …（全角省略号）混用。
- 修复方向：统一「动词+中…」模式（建议 `保存中…`），省略号统一全角；ui/Button 的 loading 态可内建文案约定。

### 5.3 【P2】同一快捷键双源展示、文案漂移

- 数据源 A：`ShortcutRegistry.ts:19-35`（BUILTIN_SHORTCUTS，CheatsheetModal 消费）。
- 数据源 B：`SettingsShortcutsTab.ts:30-47`（独立静态副本）。
- 同名快捷键两处文案不一致：
  - `new_session`：注册表「**新建会话**」（Registry:21）vs 设置页「**新建对话**」（ShortcutsTab:38）
  - `branch_session`：「**分叉会话**」（Registry:24）vs「**分支对话**」（ShortcutsTab:40）
  - `toggle_settings`：「打开设置」vs「设置」；`cheatsheet`：「快捷键帮助」vs「速查」
- 而 UI 层（按钮/工具提示）全量使用「新建对话/新对话」（SidebarNav:46、SessionStrip:74-103、GlobalSessionTabBar:431-436、UnitSessionTabStrip:477-482）——即**产品口头语是「新建对话」，快捷键表一半写「新建会话」**。
- 修复方向：SettingsShortcutsTab 消费 BUILTIN_SHORTCUTS 单源渲染（现两份结构几乎同构）。

### 5.4 【P2】同事件多措辞（引擎文案归一化面）

- `applyFileDiff.ts:179` 与 `toolFeedback.ts:346` 用正则兼容「文件已更新|已写入|已保存|完成」等**多种成功措辞**（toolFeedback.ts:658 引擎侧按 diff 数返回 '文件已更新'/'完成'）——引擎与前端两套成功措辞并存，靠归一化容错。用户看到的成功提示在不同路径为「文件已更新」或「完成」或「已写入磁盘」。
- 修复方向：前端统一成功反馈模板（如「已应用 N 个文件」），引擎原文字段仅作兜底。

---

## 6. 交互模式一致性

### 6.1 同功能入口的三态差异（会话/文件操作）

- **会话操作**：右键菜单（SidebarContextMenus，含完整键盘）＋ 双击重命名/F2 ＋ 行内 hover 按钮（.session-actions-btn，opacity:0 hover-only 且无 focus-within，见 ⑦-2）＋ 顶栏「⋯」菜单（ChatHeaderMore，键盘失效见 ②-1）——**同一会话的四种入口，键盘支持从「全支持」到「零支持」不等**。
- **文件操作**：FileActions 顶部工具条（有标签）＋ DiffCardFileList 行内 hover 按钮（display:none 键盘不可达＋无名称）＋ 文件树行内按钮——同上，能力断层。
- **模型选择**：设置页（完整）vs 聊天页 ModelBadgePickerMenu（hover-only 键盘阻断）。

### 6.2 【P2】确认对话框三套实现并存

1. ui/Dialog 收敛版：WithdrawConfirmDialog（role=alertdialog + 焦点圈定）——唯一达到 a11y 标准的路径；
2. **原生 window.confirm ×8**：`ComposerField.tsx:136`、`TiptapComposerField.tsx:253`、`useDiffGitActions.ts:264`、`DiffCard.tsx:113`、`ProjectPickerMenu.tsx:111`、`useSidebarContextMenu.ts:215`、`useFilePreview.ts:135`、`useFileNavigation.ts:121`、`SettingsUsageTab.tsx:523-524`——原生浏览器对话框：样式/主题/圆角与产品割裂（用户痛点直击），不可自定义文案格式；
3. 内联两步确认：BgTaskActions:178-200（role=alertdialog 滥用，见 ①-3）。
- 修复方向：提供统一 `ConfirmDialog`（基于 ui/Dialog），8 处 window.confirm 全部迁入（删除会话/放弃修改/覆盖文件/强制取消均为危险操作，正适合 alertdialog）。

### 6.3 【P1】快捷键「Esc Esc」与弹窗关闭语义冲突（见 ②-7）

- 补充：AppShortcuts.ts:46-64 的 capture 阶段 Esc 处理与 Dialog 栈（Dialog.tsx:116-126）并存，Esc 的「关闭」含义被两处消费；再叠加 500ms 双击 = 分叉。建议：分叉改为其他组合键（如 Ctrl+Shift+F）或加显式确认，至少在对话框刚关闭的 500ms 窗口内抑制序列。

### 6.4 快捷键冲突检测仅 DEV

- `AppShortcuts.ts:192-199`：detectConflicts 仅在 `import.meta.env.DEV` 输出 console.warn——生产无兜底（数据面 OK，检测面提示即可，P3）。

---

## 7. 键盘/触屏/鼠标三态

### 7.1 积极面

- 全局 :focus-visible 焦点环（focus-visible.css:6-19）覆盖所有 button/a/[tabindex]/role=button。
- focus-within 配对 hover 揭示已有 38 处成熟先例（见总览表）。
- 触屏友好面：多数行高对齐 --control-height（32px），icon 按钮标准 24px（DiffCard inlineIconBtn 24×24，P3 级边缘）。

### 7.2 【P2】hover-only 揭示无 focus 对应（2 处）

1. `.hoverActions`（DiffCard.module.css:839-847）：display:none，见 ②-4（此条键盘阻断，已在 P1）。
2. `.session-actions-btn`（shell-sidebar.css:286-305）：opacity:0，仅 `.session-item:hover` 揭示（302 行），**无 :focus-within 对应**——键盘用户 Tab 到该按钮时按钮隐形，焦点环画在透明元素上不可见。对比同库 GlobalSessionTabBar.module.css:258 正确处理。
- 修复方向：两处统一补 `:focus-within`（或 :focus-visible 变体）揭示。

### 7.3 【P2】触屏目标尺寸 <24px（2 处）

- `.hoverActBtn`：22×22px（DiffCard.module.css:859-871）。
- `.session-actions-btn`：18×18px（shell-sidebar.css:286-300）——WCAG 2.5.5 最小 24×24 均不满足。
- 修复方向：控制面统一最小 24px（小档 ui-size 下建议不低于 22px 并给出豁免依据）。

### 7.4 【P3】font-size-nano 10px / xxs 11px 极密元信息

- tokens.css:244/251：--font-size-xxs 11px、nano 10px（「仅用于时间、角标等极密元信息，慎用」）。小档下 xxs 低至 10px（tokens.css:531）。
- 非阻断（元信息豁免讨论范畴），但建议角标类不低于 11px，并确保颜色用 text-secondary 而非 tertiary。

---

## 8. 严重度分级清单

### P0（无障碍阻断）：0 项

未发现完全阻断级（SR 完全不可达且无替代路径）问题。最接近的两项（模型切换键盘阻断、diff 暂存操作键盘不可达）均有设置页/其他面板的替代路径，定级 P1。

### P1（明显缺失）：8 项

| # | 问题 | 位置 |
| --- | --- | --- |
| P1-1 | 旧版 Tooltip（88 处，仅 hover、无 aria）与 a11y 修复版（3 处）实现分裂 | components/Tooltip/Tooltip.tsx:100-147 vs ui/Tooltip/Tooltip.tsx:262-291 |
| P1-2 | 纯图标按钮无可访问名 14 处（16 按钮） | DiffCardFileList:152/166/178/264/278、FileActions:76/96、FilesCard:148/153、FileViewerCard:249/307/319、ModelConfigEditor:672/692 |
| P1-3 | ChatHeaderMore renderItem 无 role="menuitem"，菜单键盘漫游完全失效 | ChatHeaderMore.tsx:77-90、ui/Menu/Menu.tsx:175-184 |
| P1-4 | 添加功能面板菜单仅 onPointerDown 打开，Enter/Space 无响应 | LeafToolTabStrip.tsx:129-140 |
| P1-5 | 模型切换 hover-only 子菜单、行无 onClick，键盘完全不可达 | ModelBadgePickerMenu.tsx:76-115 |
| P1-6 | diff 暂存/放弃按钮 display:none 隐藏，键盘不可达 | DiffCard.module.css:839-847、DiffCardFileList.tsx:152/166/178 |
| P1-7 | 内联 role="alertdialog" 语义滥用（非模态、无焦点管理） | BgTaskActions.tsx:178-200 |
| P1-8 | 「Esc Esc」500ms 双击序列在关闭弹窗路径上误触发分叉会话 | ShortcutRegistry.ts:24、ShortcutService.ts:157-163、AppShortcuts.ts:46-64/143-161 |

### P2（一般缺失）：10 项

| # | 问题 | 位置 |
| --- | --- | --- |
| P2-1 | light text-tertiary #888 对比度 3.06:1（侧栏 2.82:1）大面积不达标 | tokens.css:22、shell-polish.css:67 |
| P2-2 | accent-orange 1.85:1 作文字色（改动增减计数等） | ChangesSection.tsx:128/139、FileTreeView.tsx:213 |
| P2-3 | color-active 绿 2.84:1（状态点/状态文字 <3:1） | tokens.css:114、ModelProfileList.tsx:273 |
| P2-4 | dark text-tertiary 4.1:1 边缘不达标 | tokens.css:403 |
| P2-5 | 确认交互三套并存：window.confirm ×8 + 内联两步 + Dialog | 见 ⑥-2 清单 |
| P2-6 | 快捷键文案双源漂移（新建会话/新建对话、分叉/分支） | ShortcutRegistry.ts:19-35 vs SettingsShortcutsTab.ts:30-47 |
| P2-7 | ChatStatusRibbons 与消息列表无 aria-live/role=log 播报 | ChatStatusRibbons.tsx:257、chat-message-list/ 全目录 |
| P2-8 | Menu children 模式无键盘漫游 | ui/Menu/Menu.tsx:133 |
| P2-9 | 加载态按钮文案不齐（保存中… / 裸 … / ASCII 三点） | RulesEditorDialog.tsx:65、WorkflowForm.tsx:230、FileViewerCard.tsx:386 |
| P2-10 | data-reduced-motion 死钩子（轻量档动画未真正关闭） | lightweightMode.ts:56 |

### P3（轻微）：5 项

| # | 问题 | 位置 |
| --- | --- | --- |
| P3-1 | listbox 语义无 roving tabindex/方向键 | DiffCardFileList.tsx:301 |
| P3-2 | 硬编码过渡 0.1s/0.28s/0.2s（非 token） | ApprovalAskCard.module.css:297、tab-drag.css:42/46 |
| P3-3 | LeafToolTabStrip role="tab" 无方向键（对照 UnitSessionTabStrip S4.5） | LeafToolTabStrip.tsx:91-98 |
| P3-4 | hover-only 无 focus 对应（session-actions-btn opacity:0，18px） | shell-sidebar.css:286-305 |
| P3-5 | font-size-nano 10px 极密元信息 | tokens.css:244/251/531 |

---

## 9. 修复优先级建议（路线）

1. **第一梯队（收益/成本比最高）**：P1-1 迁移旧 Tooltip 至 ui/Tooltip（API 兼容，顺手消除 88 处无名称图标按钮的一半问题）；P1-8 改掉 Esc Esc 双击绑定。
2. **第二梯队（核心功能键盘闭环）**：P1-5 模型选择器、P1-6 diff 暂存、P1-3/P1-4 菜单键盘，P1-2 补 16 个 aria-label。
3. **第三梯队（一致性收敛）**：P2-5 统一确认对话框（8 处 window.confirm → ui/Dialog）、P2-6 快捷键单源、P2-9 按钮文案模板。
4. **第四梯队（对比度与细节）**：P2-1~P2-4 调整 token（tertiary 加深至 ≥4.5:1 的 #757575 档、橙色语义字换深橙 #c2410c 档）、P2-10 接线、P3 项随改随清。

---

## 附：审计方法与统计口径

- 按钮无名称扫描：正则提取全部 `<button>` 块（含多行），剔除含 aria-label/aria-labelledby/title/文本内容/JSX 文本表达式后逐条人工复核（二次扫描确认 disabled 变体），最终 14 处/16 按钮为实读确认。
- aria-live 盘点：全量 grep `aria-live` 63 处（含 role=status/alert 变体）。
- Tooltip 消费统计：旧版 import 88 处（components/Tooltip），新版 3 处（components/ui）。
- 对比度：sRGB 相对亮度公式按 WCAG 2.1 计算；hsl() token 先转 hex 再计算。
- 待运行时验证项：无（Radix Popover aria-expanded 注入已核查 vite 缓存产物确认）。
