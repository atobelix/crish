# T-D UX/a11y 轨道 · 详细执行计划（04-a11y-ux-detail）

> 产出：详细计划子 Agent（只读 + 本文档）。输入：`40-final-plan/00-master-plan.md`（批次 4/6、R-02/R-04/R-07 裁决）+ `20-proposals/08-a11y-ux-proposal.md`（步 2-7）+ `30-reviews/01~03` + `10-analysis/08-a11y-ux-consistency-audit.md`。
> 全部文件清单与行号基于 2026-08-09 工作区**实读确认**（与审计同日基线；仓库仍在演进，执行时行号「语义定位优先」，漂移处已标注）。
> 日期：2026-08-09。性质：可派发执行的详细计划，无代码改动。

---

## 0. 轨道定位与边界（承接总计划裁决）

| 裁决 | 本轨道承接 | 本轨道不承接 |
|---|---|---|
| R-02 | window.confirm 迁移（**9 文件面/10 调用**，实测确认）+ BgTaskActions 内联确认 + grep 门禁 | ui/ConfirmDialog **组件设计**（归 02-E3；本轨道只出 a11y 契约与消费侧集成模式，见 §2.1） |
| R-04 | reduced-motion 的**验收断言**（`[data-reduced-motion]` 接线生效性） | reduced-motion.css 选择器接线、lightweightMode.ts 复活（归 01-S7） |
| R-07 | 无名称按钮 aria 补齐（**在 02-B2 结构迁移后执行**，同文件串行） | 02-B2 的按钮结构迁移本身 |
| 03-review P0-1 | 动效时长 token 化的**验收**（ApprovalAskCard.module.css:297、tab-drag.css:42/46） | token 化实现（归 01-S7） |
| 02-B6 | LeafToolTabStrip P3-3（tablist 方向键）**验收** | tab 条收敛实现（归 02-B6）；LeafToolTabStrip 添加菜单（P1-4）与 02-B6 同文件，**串行登记** |

**批次归属**：T1/T2/T3 → 批次 4（T-D-A）；T4/T5/T6 → 批次 6（T-D-B）；T5 的转绿验收与消费面改引用 → 批次 9（01-S6 后，见 §2.5 时序）。

---

## ① 任务清单（文件级）

### 批次 4（T-D-A）

| # | 任务 | 文件面（实读确认） | 关闭项 | 独立提交 |
|---|---|---|---|---|
| T1-1 | 未保存切换确认异步化（Promise 桥） | `src/components/files/hooks/useFileNavigation.ts:119-124`（`confirmNavigation(): Promise<boolean>`，签名已异步）+ `src/components/files/FilesCard.tsx`（5 个 `await` 消费点：:25/:33/:42/:68/:76） | P2-5 | ✓ |
| T1-2 | 外部修改覆盖确认异步化 | `src/components/files/hooks/useFilePreview.ts:132-138`（async 函数内条件触发） | P2-5 | ✓ |
| T1-3 | 强制取消确认异步化 ×2 | `src/components/chat-composer/ComposerField.tsx:133-141`（`FORCE_CANCEL_CONFIRM` 定义 :21-22）、`src/components/chat-composer/TiptapComposerField.tsx:250-258`（同步布尔返回值被 long-press 消费，见 §2.1 行为清单） | P2-5 | ✓ |
| T1-4 | 同步早退确认 ×5 | `useDiffGitActions.ts:262-264`、`DiffCard.tsx:110-118`、`ProjectPickerMenu.tsx:110-115`、`useSidebarContextMenu.ts:213-221`（宿主 `Sidebar.tsx`）、`SettingsUsageTab.tsx:520-529`（条件双行） | P2-5 | ✓ |
| T1-5 | BgTaskActions 内联确认收敛 | `src/components/bg-tasks/BgTaskActions.tsx:178-200`（`role="alertdialog"` 滥用 + 第三套确认实现） | P1-7、P2-5 | ✓ |
| T1-6 | confirm 清零门禁 | 新增 `scripts/check-no-window-confirm.mjs` + vitest fs 断言（§2.1.7） | P2-5 防回潮 | ✓ |
| T2-1 | 快捷键注册面修正 | `src/services/ShortcutRegistry.ts`（open_security/toggle_runtime 绑定、label 文案、补 open_extensions/open_schedule、branch_session 改键） | P2-6、P1-8 | ✓ |
| T2-2 | 冲突检测生产接线 | `src/app/AppShortcuts.ts:192-199`（现仅 DEV）+ `ShortcutService.ts:266-280`（detectConflicts 已实现） | P1-8 前置 | ✓ |
| T2-3 | 设置页派生化（删静态副本） | `src/components/settings/SettingsShortcutsTab.tsx:20-27`（DEFAULT_SHORTCUTS）、:29-47（SHORTCUT_ITEMS）、:90-119（loadShortcuts/isCustomized/restoreDefault 依赖链） | P2-6 | ✓ |
| T2-4 | 改键联动（forkTitle 文案 + 幽灵键裁决） | `src/app/AppShortcuts.ts:143-162`（branch 执行 + `:149` forkTitle「双击ESC分叉」）、toggle_runtime/close_tab 裁决 | P1-8、P2-6 | ✓ |
| T2-5 | 单源断言测试 | `src/services/ShortcutService.test.ts`（更新+新增） | P2-6 防回潮 | ✓ |
| T3-1 | DiffCardFileList 5 个无名称按钮补 aria-label | `src/components/diff/DiffCardFileList.tsx:152/166/178`（hoverActBtn）、:264/278（inlineActionBtn） | P1-2 | ✓ |
| T3-2 | FileActions/FilesCard/FileViewerCard 5 个无名称按钮补 aria-label | `FileActions.tsx:76/96`、`FilesCard.tsx:148/153`、`FileViewerCard.tsx:249`（打开方式）、~:307（复制源码）、~:319（更多）——行号比审计微偏，语义定位 | P1-2 | ✓ |
| T3-3 | ModelConfigEditor 2 个无名称按钮补 aria-label | `src/components/settings-models/ModelConfigEditor.tsx:672`（配置）、:692（删除） | P1-2 | ✓ |
| T3-4 | 触屏目标尺寸 ≥24px | `DiffCard.module.css:859-871`（.hoverActBtn 22×22） | 审计 7.3 | ✓ |
| T3-5 | 无名称按钮扫描门禁 | 新增 `scripts/check-icon-button-names.mjs` + package.json script + 快层接线 | P1-2 防回潮 | ✓ |
| T3-6 | Tooltip a11y 契约注释 + 迁移后清单重扫 | `src/components/ui/Tooltip/Tooltip.tsx`（头注释契约）+ 02-B1 完成后重扫（R-07） | P1-1 验收面 | ✓ |

### 批次 6（T-D-B）

| # | 任务 | 文件面（实读确认） | 关闭项 | 独立提交 |
|---|---|---|---|---|
| T4-1 | DiffCard hoverActions 键盘可达 | `DiffCard.module.css:834-847`（display:none → opacity/visibility + :hover/:focus-within） | P1-6、P3-4（行内） | ✓ |
| T4-2 | LeafToolTabStrip 添加菜单键盘化 | `src/components/binary-tree/LeafToolTabStrip.tsx:126-180`（加号仅 onPointerDown:132-135、菜单项仅 onPointerDown:161-170、无 Esc/焦点） | P1-4 | ✓ |
| T4-3 | ModelBadgePickerMenu 模型切换键盘路径 | `src/components/provider/ModelBadgePickerMenu.tsx:79-88`（行按钮无 onClick）、:90-115（hover-only 子菜单）、`:84`（aria-expanded={isHovered}） | P1-5 | ✓ |
| T4-4 | ui/Menu children 模式漫游 | `src/components/ui/Menu/Menu.tsx:133`（options 门控）、:175-184（焦点查询） | P2-8 | ✓ |
| T4-5 | ChatHeaderMore renderItem 补 role | `src/components/chat-card/ChatHeaderMore.tsx:77-90` | P1-3 | ✓ |
| T4-6 | DiffCardFileList listbox 语义降级 | `DiffCardFileList.tsx:301`（role="listbox"）→ role="list"；:111（role="option"）移除 | P3-1 | ✓ |
| T4-7 | 键盘可达性矩阵（起步版） | 走查文档 + 场景断言（§4.3） | P1-4/5/6 验收 | ✓ |
| T5-1 | 对比度断言测试（先红） | 新增 `src/styles/a11y-contrast.test.ts`（fs 契约模式，仿 style-contract.test.ts） | P2-1~P2-4、P3-5 | ✓ |
| T5-2 | 文字色消费面改引用 | `ChangesSection.tsx:128/139`、`FileTreeView.tsx:213`、`ModelConfigEditor.tsx:799`、`ModelProfileList.tsx:273`、`StatusDiagnosticsPanel` WARN（依赖 01-S6 token 就绪后，见 §2.5 时序） | P2-2/P2-3 | ✓ |
| T6-1 | 动态状态播报补齐 | `ChatStatusRibbons.tsx:257`（role="region" → + aria-live="polite" aria-atomic="true"）、`chat-message-list/`（MessageVirtualizer.tsx:196/212/256 role="region" → 容器 role="log" aria-relevant="additions"） | P2-7 | ✓ |
| T6-2 | 加载态文案统一 | `WorkflowForm.tsx:230/:269`（裸「…」→「保存中…」）、`FileViewerCard.tsx:386`、`DiffCodeViewer.tsx:41`（ASCII 三点 → 全角） | P2-9 | ✓ |
| T6-3 | 键盘矩阵全量 + e2e 回归 | 矩阵表 + 5 个键盘专项 spec（ast-block-tables/format-checker/ime-composition/keyboard-navigation/wysiwyg-interaction，**禁止删除**） | P1-3、P3-3 验收 | ✓ |
| T6-4 | reduced-motion 验收断言（R-04） | 新增断言（01-S7 接线后转绿）；`ApprovalAskCard.module.css:297`、`tab-drag.css:42/46` token 化验收 | P2-10、P3-2 | ✓ |

**任务数**：批次 4 共 16 项 + 批次 6 共 11 项 = **27 项文件级任务**（含 2 个门禁脚本、2 个新增断言测试）。

---

## ② 各任务实现要点

### 2.1 T1 window.confirm 统一（R-02，9 文件面/10 调用实读确认）

#### 2.1.0 调用点实读登记表（与审计 ×8 口径的差异已对齐）

| # | 位置 | 文案（实读原文） | 性质 | 返回值消费方式 |
|---|---|---|---|---|
| 1 | ComposerField.tsx:136 | 强制取消将立即中断模型与工具，未完成结果可能丢失。确定强制取消？ | 危险 | `invokeForceStop(): boolean` 同步布尔 |
| 2 | TiptapComposerField.tsx:253 | 同 FORCE_CANCEL_CONFIRM | 危险 | 同上 |
| 3 | useDiffGitActions.ts:264 | 确定要放弃对 "X" 的所有本地未暂存修改吗？此操作不可逆。 | 危险不可逆 | `if (!confirm) return;` 同步早退 |
| 4 | DiffCard.tsx:113 | 文件庞大 (X MB)，确定复制？ | 普通（条件：>3MB） | `if (大 && !confirm) return;` |
| 5 | ProjectPickerMenu.tsx:111 | 确定从列表移除项目「X」？ | 普通 | `if (!confirm) return;` |
| 6 | useSidebarContextMenu.ts:215 | 确定要彻底删除对话“X”吗？删除后数据将永久丢失。 | 危险不可逆 | `if (confirm) {...}` 后执行 deleteSession + toast |
| 7 | useFilePreview.ts:135 | 文件已被外部修改，是否覆盖？ | 普通（条件触发） | async 内 `if (!ok) return;` |
| 8 | useFileNavigation.ts:121 | 当前文件未保存，切换将丢失修改，是否继续？ | 普通（条件触发） | `confirmNavigation(): Promise<boolean>`，5 处消费全 await |
| 9 | SettingsUsageTab.tsx:523-524 | 确定清空本机用量历史？不可撤销。 | 危险不可逆 | `window.confirm && !window.confirm(...)` 条件双行 |

**实读修订**：审计口径 ×8、提案 ⑤-2 实测 9 文件面/10 调用——本表实读确认 **9 文件面/10 调用**成立（SettingsUsageTab 为双行条件调用）。

#### 2.1.1 统一集成模式（唯一模式，03-review P1-8 要求）

- **消费侧统一「Promise 桥」**：新增 `src/hooks/useConfirmGate.ts`（业务层 hook，不违反 ui/ 原子层依赖契约；≥3 消费点，满足新组件/hook 判据）。形态：

```
const [confirmGate, renderConfirmGate] = useConfirmGate();
// 调用点：
if (!(await confirmGate({ title, description, confirmLabel, danger }))) return;
// 渲染点（宿主组件根部）：
{renderConfirmGate(<ui/ConfirmDialog ... />)}
```

- **ui/ConfirmDialog 契约（本轨道声明，02-E3 照此实现与验收）**：基于 ui/Dialog（Dialog.tsx 已具备 `role: 'alertdialog'`、`initialFocusRef`、`dismissible`、`showCloseButton`、`footer`、`description` prop，Esc 栈 dialogStack 已实现）；`role="alertdialog"` + title→aria-labelledby + description→aria-describedby；初始焦点落**取消钮**（与 WithdrawConfirmDialog.tsx:44 同惯例，Dialog 基座默认聚焦首个可交互元素）；danger 变体确认钮不默认聚焦；Esc 关闭并归还原焦点（继承 Dialog 三件套）；无关闭按钮（showCloseButton=false）。
- **禁止**：各调用点各自手写状态机/各自渲染 Dialog（9 点 9 写法 = 第四套实现）；禁止 `confirm`/`alert`/`prompt` 新引入。
- 若执行中确认 02-E3 基座未就绪（依赖批次错位）：本轨道 T1 后置等待，不自行新造基座（R5 风险，验收先行、实现后置）。

#### 2.1.2 行为变更清单（3 个异步化点，逐点签字验收）

| 点 | 现行为 | 目标行为 | 两路径验收 |
|---|---|---|---|
| useFileNavigation:121 | confirmNavigation 同步弹窗返回布尔 | confirmGate await 挂起；确认→true 继续、取消→false 不继续（签名不变，5 个调用点零改动） | 挂起→确认→继续打开/刷新/上翻；取消→原文件保持 dirty |
| useFilePreview:135 | async 内条件 confirm | 同上；确认→覆盖写入 + setContent + 清 dirty；取消→保持编辑态 | 两路径 + 外部修改未触发时不弹窗（条件不变量） |
| ComposerField/TiptapComposerField:136/253 | invokeForceStop 同步返回布尔，long-press 确认后吞掉后续 click（:171/:288 `if (invokeForceStop()) longPressFiredRef.current = true`） | invokeForceStop 改 `Promise<boolean>`；Shift+click（:155/:272 返回值忽略）→ 弹窗异步；long-press 定时器回调 → `await confirmGate` 后置位 longPressFiredRef（**确认→true 吞 click；取消→false 不吞，单击仍走 L2 协作停止**——语义必须保持） | 长按→确认→释放无 L2；长按→取消→单击触发 L2；Shift+click 两路径 |

#### 2.1.3 同步早退 5 点迁移要点

- useDiffGitActions:264：`if (!(await confirmGate({...danger:true}))) return;` 后接原 `try/await discardGitPath`，确认文案保留（「此操作不可逆」进 description）。
- DiffCard:113：条件保持 `res.content.length > 3*1024*1024` 时弹窗；确认文案（含动态 MB 数）进 description。
- ProjectPickerMenu:111：移除项目属**可恢复操作（非危险）**，danger=false；确认后 `removeProject + refresh + onChanged` 原序。
- useSidebarContextMenu:215：**宿主迁移**——hook 不渲染 Dialog；hook 新增 `pendingDelete` state + `confirmDelete/cancelDelete` 回调，`Sidebar.tsx` 装配 renderConfirmGate；确认后 `deleteSession + toast`（保留现有 toast 文案）；取消不动作。注意上下文菜单点击后已关闭，Dialog 为独立浮层，焦点归还落 trigger 的可用性需人工走查（菜单关闭后 trigger 不可见属可接受，焦点归还 document.body）。
- SettingsUsageTab:523-524：`window.confirm && !window.confirm(...)` 双行 → 单次 confirmGate（danger=true）；确认后 `setHistory(clearUsageHistory())`。

#### 2.1.4 T1-5 BgTaskActions 收敛

- :178-200 内联 `role="alertdialog"` 确认行删除；`confirming` state 保留（控制弹窗开闭）；`buildKillConfirmPrompt(task)` 文案进 description；取消/确认按钮映射 ConfirmDialog footer；`confirmKill` async 流程与 `busy/killResult/killAttempted` 三态保持；确认钮 disabled={busyAny} 语义保留。

#### 2.1.5 文案模板统一（对齐 WithdrawConfirmDialog 风格）

- 标题：动词短语（「放弃修改」「删除对话」「清空用量」「强制取消」…）；description：原 confirm 全文（保留「不可逆/永久丢失」等后果说明）；按钮：[取消][确认]（危险项确认钮 danger 变体 + 文案「确认删除」「确认放弃」「确认清空」「确认强制取消」「确定复制」「移除项目」）。

#### 2.1.6 测试与验收

- 每点流程级测试：挂起→确认→继续 / 取消→不继续（两路径断言）；useFileNavigation.test.ts（已存在）补 confirmGate mock 用例；ComposerField/TiptapComposerField 长按吞 click 用例；BgTaskActions.test.ts（已存在）确认行改弹窗后更新。
- 键盘验证（每点）：初始焦点=取消钮、Tab 圈定、Esc 关闭+焦点归还、danger 变体确认钮不可默认聚焦。
- 手动走查清单：9 点 × （确认/取消/Esc/遮罩）4 路径。

#### 2.1.7 门禁（T1-6）

- `scripts/check-no-window-confirm.mjs`：递归扫描 `apps/crish-desktop/src` 下 ts/tsx，匹配 `window.confirm|window.alert|window.prompt` 字面量 → 命中即 exit 1 并列出文件:行号（仿 check-ui-layer.mjs 模式）；package.json script `check:no-window-confirm`。
- vitest fs 断言（仿 style-contract.test.ts 模式，值断言不受覆盖率口径约束）：对已知 9 文件断言不含 `window.confirm`。
- 完成判据：`rg "window.confirm" apps/crish-desktop/src` = 0；全仓确认交互唯一基座。

### 2.2 T2 快捷键单一真源

#### 2.2.0 双源漂移实测表（逐键对照，2026-08-09 工作区）

| id | 注册表 BUILTIN_SHORTCUTS（执行真源） | 设置页 DEFAULT_SHORTCUTS（展示） | 实测结论 |
|---|---|---|---|
| open_security | Ctrl + Shift + S（Registry:29） | Ctrl + Shift + E（Tab:23） | ❌ 绑定漂移 |
| toggle_runtime | Ctrl + Shift + R（Registry:34） | Ctrl + `（Tab:25） | ❌ 绑定漂移；且 AppShortcuts 无 handler（:80 白名单有、switch 无 case）→ 注册但无执行面 |
| export_logs | Ctrl + Shift + L（Registry:33） | 无 | 注册表有、设置页无 |
| close_tab | 无 | MiddleClick（Tab:26） | 设置页有、注册表无；AppShortcuts 无 close_tab case → **幽灵行** |
| open_extensions | 无 | Ctrl + Shift + X（Tab:24） | 设置页有、注册表无；**AppShortcuts:122-125 有 handler（openTab('plugins')）** → 应补注册 |
| open_schedule | 无 | Ctrl + Shift + J（Tab:24） | 同上，AppShortcuts:126-129 有 handler（openTab('schedule')） → 应补注册 |
| open_models | Ctrl + Shift + M（Registry:27） | Ctrl + Shift + M（Tab:23） | ✅ 一致（**提案 ⑤-5「缺默认绑定」已过时**，实测修订） |

label 漂移：new_session（新建会话/新建对话）、branch_session（分叉会话/分支对话）——产品口头语全量为「新建对话/分支对话」（SidebarNav/SessionStrip/GlobalSessionTabBar:431-436/UnitSessionTabStrip:477-482 等）；toggle_settings（打开设置/设置）、cheatsheet（快捷键帮助/速查）。

#### 2.2.1 数据层定源（T2-1 前半）

- **唯一默认源 = BUILTIN_SHORTCUTS**（ShortcutService constructor :41-45 已消费 + overrides 覆盖 :285-298——消费面不动，CheatsheetModal:32 getAllActions() 已同源不动，仅设置页是失源方，与提案 ⑤-4 一致）。
- 注册表修正（改注册表 = 改执行面，**必须与 T2-2 冲突检测接线同批**）：
  1. `open_security` defaultBinding 保持 Ctrl + Shift + S（**以注册表为真源，设置页迁就**）；
  2. `toggle_runtime` defaultBinding 保持 Ctrl + Shift + R；
  3. 新增 `open_extensions`（Ctrl + Shift + X，category: panel，label 参照设置页「扩展」→ 统一「扩展设置」）、`open_schedule`（Ctrl + Shift + J，label「定时任务」）两条注册——AppShortcuts handler 已存在，注册后即生效；
  4. `toggle_runtime` 与 `close_tab` 执行面无 handler：**默认建议**——toggle_runtime 从注册表移除（无执行面键比不展示更误导，Cheatsheet/设置页同步消失），close_tab 从设置页删除幽灵行；**若主控/用户裁定保留**，需另行实现执行面（出本轨道范围，登记裁决）；
  5. label 文案统一：new_session「新建对话」、branch_session「分支对话」、toggle_settings「打开设置」、cheatsheet「快捷键帮助」（注册表 label 为唯一文案源，设置页派生消费）。

#### 2.2.2 冲突检测生产接线（T2-2，**本任务第一子步**，02-review P1-4）

- AppShortcuts.ts:192-199 `if (import.meta.env.DEV)` 门拆除：生产也执行 `detectConflicts()`，冲突时 console.warn 输出 +（可选）toast 提示改键结果冲突；保留 DEV 分支的详细输出。
- 改键前用生产检测结果确认候选键空闲（含 resolvePlatformBinding 平台覆盖后）。

#### 2.2.3 Esc Esc 误触分叉裁决（P1-8，选 A 方案）

- **A（推荐，根除误触面）**：`branch_session` defaultBinding `'Escape Escape'` → `'Ctrl + Shift + F'`（Registry:24）。步骤：① T2-2 生产冲突检测先行 → ② 确认 Ctrl+Shift+F 未被占用（含平台覆盖）→ ③ 改注册表 → ④ AppShortcuts.ts:149 forkTitle 文案 `- 双击ESC分叉` 改 `- Ctrl+Shift+F 分叉`（与 formatShortcutLabel 展示一致）→ ⑤ 改后 ShortcutService 序列引擎无序列绑定残留（isSequenceBinding 不再命中），Esc 单键语义唯一 = 「关闭/取消」（Dialog 栈 + AppShortcuts capture）→ ⑥ 全量键盘 e2e + Esc 场景走查。
- **B（兜底，仅当 A 的候选键全被占用且无替代时才启用）**：Dialog 关闭事件后 1s 抑制窗内序列不匹配 + 分叉前显式二次确认。B 有误伤正常双击用户的权衡（提案 R8），需主控裁决记录。

#### 2.2.4 设置页派生化（T2-3）

- 删除 `DEFAULT_SHORTCUTS`（:20-27）与 `SHORTCUT_ITEMS`（:29-47）的静态结构；
- 保留「展示元表」：`id → { group, desc }`（group/desc 为设置页独有展示维度，label 改从注册表 meta.label 取）——允许在设置页文件内以注释声明该表仅展示不参与执行；
- 派生逻辑：`displayItems = BUILTIN_SHORTCUTS.map(meta => ({ id: meta.id, label: meta.label, binding: meta.defaultBinding, ...displayMeta[meta.id] }))`；行顺序 = 注册表顺序（分组展示按 group 聚合）；
- `loadShortcuts`（:90-102）：默认值改从注册表 defaultBinding 取；`isCustomized`（:115-119）与 `restoreDefault`（:189-205）比较基准改注册表 defaultBinding；`findConflict` 逻辑不变（基于 customShortcuts 实测值）；
- 展示键的 KEY_PART_ZH/formatShortcutLabel（:53-81）保持（纯展示层）；
- overrides 持久化链路（:170-187 persist → configService 'shortcuts.overrides' + saveSettingsEx）**不动**（ShortcutService.loadCustomOverrides 消费同一键）。
- 注意：设置页当前 `import { Tooltip } from '../Tooltip'`（:14）为**旧 Tooltip**——该 import 由 02-B1 迁移，本任务不重复处理，但执行 Agent 改本文件时注意 02-B1 可能已先行替换（R-07 串行精神）。

#### 2.2.5 单源断言测试（T2-5）

- 新增（ShortcutService.test.ts 内或独立文件）：
  1. **展示==执行断言**：对设置页派生 displayItems 每项：`binding === 注册表 defaultBinding`、`label === 注册表 label`（解析 overrides 后仍一致——用构造的 overrides 注入验证）；
  2. **清单互盖断言**：注册表每 id 在 displayItems 中存在（export_logs 必须出现）、displayItems 每 id 在注册表存在（close_tab 移除后无孤儿）；
  3. **无序列绑定残留**：`rg 'Escape Escape' src` = 0（或 fs 断言 BUILTIN_SHORTCUTS 无含空格的序列 binding）；
  4. **注册表↔执行处理覆盖**（fs 契约断言，仿 style-contract 模式读 AppShortcuts.ts）：switch case 的 actionId 集合 ⊆ 注册表 id 集合 ∪ 显式退役登记表——防「注册了没 handler / 有 handler 没注册」回潮。
- 键盘走查：Esc Esc 场景（开 Dialog→Esc 关→再 Esc 无副作用→Ctrl+Shift+F 触发分叉→toast/撤销路径复验）；改键后设置页展示=执行（人工改键→触发验证）。

### 2.3 T3 图标按钮名称补齐（R-07 串行：02-B2 结构迁移后执行）

#### 2.3.1 16 处清单与文案（全部实读确认，均包裹 Tooltip 且 content 即名称文案 → 同源）

| # | 位置（当前行号） | 图标 | aria-label（= Tooltip content 同源常量） |
|---|---|---|---|
| 1 | DiffCardFileList.tsx:152 | Minus | 取消暂存此文件 |
| 2 | DiffCardFileList.tsx:166 | Plus | 暂存此文件 |
| 3 | DiffCardFileList.tsx:178 | Undo2 | 放弃此文件的所有本地修改 |
| 4 | DiffCardFileList.tsx:264 | Check | 接受并写入磁盘 |
| 5 | DiffCardFileList.tsx:278 | X | 从列表拒绝（不回滚磁盘） |
| 6 | FileActions.tsx:76 | ChevronDown | 选择打开方式 |
| 7 | FileActions.tsx:96 | MoreHorizontal | 更多操作 |
| 8 | FilesCard.tsx:148 | CornerLeftUp | 上级目录 |
| 9 | FilesCard.tsx:153 | RotateCw | 刷新 |
| 10 | FileViewerCard.tsx:249 | ChevronDown | 选择打开方式 |
| 11 | FileViewerCard.tsx:~307 | Copy | 复制完整源码 |
| 12 | FileViewerCard.tsx:~319 | MoreHorizontal | 更多操作 |
| 13 | ModelConfigEditor.tsx:672 | SlidersHorizontal | 配置 |
| 14 | ModelConfigEditor.tsx:692 | Trash2 | 删除 |

（审计清单 14 处/16 按钮 = 本表 14 行；FileViewerCard 行号微偏，语义定位。）

- **名称与 Tooltip content 同源约定**（防两处各写）：同一组件内定义常量（如 `const UNSTAGE_LABEL = '取消暂存此文件'`），Tooltip `content={UNSTAGE_LABEL}` 与 `aria-label={UNSTAGE_LABEL}` 同引用；对 02-B2 迁移后改用 ui/Tooltip 的消费点，ui/Tooltip 的 aria-describedby 是补充说明**不替代名称**（08-步1 契约）。
- **R-07 串行纪律**：02-B2 先做结构迁移（机械替换工具**必须保留既有 aria-label 属性**——03-review ④.3 红线）；本任务开工前 grep 实测重扫「无文本 + 无 aria-label/aria-labelledby/title 的 <button>」，以重扫结果为准（清单可能因 02-B2 补名而变化）。

#### 2.3.2 触屏尺寸（T3-4）

- `.hoverActBtn` 22×22 → **24×24**（DiffCard.module.css:859-871 区域，width/height 两行）；图标 13px 可随行加大或保持（视觉回归抽查）。
- `.session-actions-btn` 18×18（shell-sidebar.css:286-300）——**实测漂移登记**：全仓无 tsx/ts 消费该全局类（SessionRow 已改用 `sessionActionsBtn` 模块类，SidebarSessionList.module.css:402，已 28×28 且 :427-429 已具备 :hover/:focus-within/:focus-visible 揭示）；shell-polish.css:829/899-900 有旧类 focus 兜底规则。执行 Agent **先 grep 复核消费方**：无消费 → 不动样式，登记为死规则建议归 01-S5/卫生删除（本轨道不做）；有消费 → 24×24 + 补 :focus-within。

#### 2.3.3 扫描门禁（T3-5）

- `scripts/check-icon-button-names.mjs`：扫描 `apps/crish-desktop/src/**/*.tsx` 的 `<button ...>` 多行块，判定「无 aria-label/aria-labelledby/title 且无文本内容/无 JSX 文本表达式」→ 输出 `文件:行号` 清单；>0 则 exit 1（与审计扫描口径一致：aria-hidden 图标不豁免）；package.json `check:icon-button-names` + 快层 CI 接线（02-B2 完成判据已含补名，本门禁为其防回潮）。
- 执行期间：脚本先跑一遍得基线清单（红）→ T3-1~3 逐文件补齐 → 转绿（黄绿开发，脚本先建）。

#### 2.3.4 Tooltip 契约注释（T3-6）

- ui/Tooltip.tsx 文件头补 a11y 契约注释（focus/blur 触发 262-273、aria-describedby 关联 175+、role="tooltip"、视口钳位——均已实现，契约固化防回归）：focus 进入显示、blur/延迟隐藏、aria-describedby 指向触发元素。
- 02-B1 完成后：重扫无名称按钮清单（供后续 02-B2/本轨道校验）+ SR 抽查 3 代表面（AppTopBar/DiffCard/ChatComposer）播报「按钮名 + 说明」——NVDA 不可用时降级为 Playwright aria 快照断言 + axe 扫描（03-review P1-1）。

### 2.4 T4 hover-only 键盘闭环

#### 2.4.1 DiffCard hoverActions（T4-1，P1-6）

- DiffCard.module.css:834-847：`.hoverActions { display: none }` → `opacity: 0; visibility: hidden; pointer-events: none`（保留 absolute 定位）；:847 揭示规则改双选择器：`.accordionHeaderRow:hover .hoverActions, .accordionHeaderRow:focus-within .hoverActions { opacity: 1; visibility: visible; pointer-events: auto; }`——对照 GlobalSessionTabBar.module.css:258（`.tab:focus-within .tabClose`）成熟模式；`.accordionHeaderRow:hover .fileStat { opacity: 0 }`（:851）同步补 `:focus-within` 变体，避免焦点时统计列仍显示叠加 hoverActions。
- 验收：Tab 序可达（display 不再拦截）；焦点环可见；视觉回归（鼠标路径观感不变）。

#### 2.4.2 LeafToolTabStrip 添加菜单（T4-2，P1-4）——与 02-B6 同文件串行（03-review C18）

- **推荐方案：整体迁 ui/Menu 基座**（获得 onClick/Esc/首项聚焦/焦点归还全包）：加号按钮作 trigger（保留 aria-label="添加功能面板" 与 aria-expanded，expanded 绑真实打开态）；菜单项 options 化（`openToolInSession`/`openToolInActiveTab` 为 onClick）。若 02-B6 已先接管该文件（tab 条收敛），本任务在 02-B6 后的结构上实施。
- 备选（不迁基座时）：加号补 `onClick` 开关（保留 onPointerDown 触屏路径）+ 打开后焦点移入菜单首项 + 菜单容器 onKeyDown Esc 关闭 + 菜单项补 onClick（当前仅 onPointerDown:161-170，键盘完全无响应）。
- 验收：Tab→加号→Enter 打开→方向键漫游→Enter 激活→Esc 关闭并归还。

#### 2.4.3 ModelBadgePickerMenu（T4-3，P1-5，核心功能键盘阻断）

- **打开态单一真源**：新增 `expandedProfileId` state 取代 `hoveredProfileId` 作为唯一打开态；`aria-expanded={expandedProfileId === p.id}`（消除 hover 驱动 ARIA——05-③/审查 ③ 实读确认 :84 现值 `aria-expanded={isHovered}`）；onMouseEnter/onMouseLeave 定时器（80/150ms）改为**仅驱动 setExpandedProfileId**（hover 保留为增强路径，视觉行为不变）。
- 行按钮补 `onClick={() => setExpandedProfileId(expandedProfileId === p.id ? null : p.id)}`（button 原生 Enter/Space 即触发 click，无需额外 onKeyDown）；有模型才可展开（无模型行点击无子菜单，aria-expanded 恒 false）。
- 子菜单（:90-115 现为 hover 条件渲染）改为 `expandedProfileId === p.id` 条件渲染；**展开后焦点移入子菜单首项**（模型选项按钮）；子菜单内 ↑↓ 漫游（复用 Menu 基座 children 漫游或子菜单自身实现，见 T4-4）；**Esc 逐级关闭**：子菜单开 → Esc 关子菜单并归还行按钮焦点；行层 → 外层 Menu 基座 Esc（:165-168）关闭整体并归还 trigger。
- 选中路径（:104-107 已有 onClick → activateProfileModel + onClose）保持。
- 模型管理按钮（:121-131）保持。
- 验收：聊天页 Tab 可达模型徽标 → Enter 展开菜单 → ↓ 至行按钮 → Enter 展开子菜单 → ↓ 选模型 → Enter 激活；全程 Esc 逐级可退。ModelBadgePickerMenu.test.tsx 更新（aria-expanded 断言改真实打开态；hover 用例保留为增强路径）。

#### 2.4.4 Menu children 模式漫游（T4-4，P2-8）

- Menu.tsx:133 门控 `options.length > 0` 改**双通道**：
  - options 模式（含 renderItem）：维持索引漫游（现实现）；
  - children 模式：漫游目标 = `contentRef.current.querySelectorAll<HTMLButtonElement>('[role="menuitem"], [role="option"]')` 轮询（:175-184 查询已存在，补齐索引递增/递减/Home/End 分支即可）；focusedIndex 与 children 项一一映射。
- 初始焦点：children 模式打开时若首项可聚焦则聚焦（F7-F2 同语义），ProjectPickerMenu 的 autoFocus 搜索框消费方不受影响（搜索框先聚焦，漫游索引从首项开始，键盘走查回归）。
- Home/End：两通道都补（现 options 模式也无 Home/End——对照 SidebarContextMenus focusMenuItem 标杆）。
- 验收单测：children 模式 ↑↓/Home/End/Enter 漫游用例新增（Menu.lowViewport.test.tsx 同目录模式）。

#### 2.4.5 ChatHeaderMore renderItem（T4-5，P1-3）

- ChatHeaderMore.tsx:77-90 renderItem 按钮补 `role="menuitem"`（其余不动；Menu.tsx:175-184 查询已覆盖该 role，补后焦点链路全通——Radix Popover 不自动聚焦内容的缺陷由 focusedIndex effect 的 `target?.focus()` 补上，前提是 role 存在）。
- 验收：打开「⋯」菜单后焦点移入首项、↑↓ 漫游、Enter 激活、Esc 关闭；playwright 键盘 spec 补场景。

#### 2.4.6 DiffCardFileList listbox 降级（T4-6，P3-1）

- :301 `role="listbox" aria-label="变更文件列表"` → `role="list"`（aria-label 保留）；:111 行按钮 `role="option"` 移除（保留 aria-selected? 降级后 aria-selected 无宿主语义，移除或保留由执行 Agent 按 SR 播报实测决定——默认移除，避免无宿主选中态误导）；列表不承担组合选择语义，降级优于补 roving（08 克制原则）。

#### 2.4.7 BgTaskActions 确认行 → ConfirmDialog（P1-7，并入 T1-5，见 §2.1.4）

### 2.5 T5 对比度验收（R-04 精神：值归 01-S6 落地，本轨道出断言 + 消费面）

#### 2.5.1 时序与串行红线（重要调度标注）

- **断言测试（T5-1）批次 6 先行入库，红态基线**（对照审计实测值必然红灯）——红灯 = 正确初始态；
- 01-S6（批次 9.1）调 token 值 → 断言转绿 = 验收器；
- **消费面改引用（T5-2）必须等 `--text-warning-strong`/`--text-success-strong` 等新 token 定义后落地**（tokens.css 由 01 独占批次，防悬空引用）；若 01-S6 未定义新 token 而仅调旧值，T5-2 需随 01-S6 批串行追加。
- **调度建议**：主控宜将 01-S6 的对比度调值段提前至批次 6 之后紧邻执行（对齐 08-步6「值改 01、断言 08」双向锚定），或将 T5-2 显式挂到批次 9 串行段；否则断言红态跨 3 批悬挂（不阻塞主链，但验收时序需明确）。

#### 2.5.2 a11y-contrast.test.ts 规格（T5-1）

- 位置 `src/styles/a11y-contrast.test.ts`，fs 契约模式（仿 style-contract.test.ts：`new URL(rel, import.meta.url)` + readFileSync 读 tokens.css，值断言不受覆盖率口径约束）；
- 实现：正则提取 tokens.css light/dark 两段主题块内的语义色 token 值（--text-primary/secondary/tertiary/muted、--color-{warning,success,active,danger}、--ui-text-*、--accent-{orange,blue} 等；hsl() 转 hex）；sRGB 相对亮度 + WCAG 对比度公式；组合 = ③表 8 行 + 全部语义色 token × 主题背景（light #f0eee9/#e9e5de、dark #0d0d0d）；
- 断言：正文组合 ≥ 4.5:1、UI/状态点组合 ≥ 3:1（分类阈值见 §③ 表）；新 token（--text-warning-strong 等）纳入遍历后 01-S6 落地自动转绿；
- 防回潮：对「达标项锁定」（dark text-secondary 7.7:1 等）同样断言，防调浅。

#### 2.5.3 消费面核对清单（T5-2，token 就绪后）

- ChangesSection.tsx:128/139（+N −N 增减计数 `em`）→ `--text-warning-strong`（增/减分色时绿色侧 `--text-success-strong`）；
- FileTreeView.tsx:213（橙色状态字）→ `--text-warning-strong`；
- ModelConfigEditor.tsx:799（橙色状态字）→ `--text-warning-strong`；
- ModelProfileList.tsx:273（状态点）→ 状态点可保留 `--color-active`（UI 组件 3:1 达标即可）或改文字 token 变体，状态**文字**必须文字 token；
- StatusDiagnosticsPanel WARN（#e8590c）→ `--text-warning-strong`（或与 01-S6 收敛后的 --ui-text-warning 同档）；
- 语义约定：accent 色保留作图标/装饰/非文字用途；文字用途一律走文字专用 token——从消费面切断「装饰色当文字用」通道；
- P3-5 字号约定：--font-size-nano 10px 仅限角标类且配 text-secondary（tokens.css 注释由 01-S7 写，本轨道断言「nano/xxs 消费面不配 text-tertiary」——可选验收项，登记）。

#### 2.5.4 验收

- ③表全部组合 ≥ 阈值（断言绿）；无 accent 色直接作小字正文的用法残留（grep 复核）；light/dark 双主题截图抽查 6 代表面（时间戳/ghost 按钮/侧栏/增减计数/状态点/状态诊断 WARN）；无肉眼突变；断言能对「新增不达标组合」红。

### 2.6 T6 步 7 残留 a11y 收尾

#### 2.6.1 动态状态播报（T6-1，P2-7）

- ChatStatusRibbons.tsx:257 `role="region" aria-label="快捷状态"` → 补 `aria-live="polite" aria-atomic="true"`（快捷状态 chip/后台任务数/计划模式变化播报）；
- chat-message-list/：MessageVirtualizer.tsx:196（`role="region" aria-label="会话消息"`）所在容器层补 `role="log" aria-relevant="additions"`（流式新消息到达播报；对照 ApprovalAskCard:561/658 既有模式）；:212/:256 内层 region 不重复加（保持单一 log 语义）；aria-busy 随流式态（可选，登记）。
- **同文件串行**：ChatMessageList.tsx 与 07-步骤3/02-C1 重叠（03-review 批次矩阵：07 先行、08 后置）；本任务在 07 批后执行。

#### 2.6.2 加载态文案统一（T6-2，P2-9）

- WorkflowForm.tsx:230/:269 裸「…」→「保存中…」（:230 创建态可「创建中…」保持动词+中…约定，统一用「保存中…」亦可——由执行 Agent 按按钮语境定，**省略号一律全角**）；
- FileViewerCard.tsx:386、DiffCodeViewer.tsx:41「正在加载源码...」→「正在加载源码…」（ASCII 三点 → 全角）；
- 约定固化：ui/Button loading 态内建文案默认值（与 02-B2 衔接，02 侧实现，本任务只验收：grep 无裸「…」/ASCII 三点残留）。

#### 2.6.3 键盘矩阵全量 + e2e 回归（T6-3）

- 矩阵模板（§4.3）全量展开：数据源 = T1 确认交互清单（9+1 点）+ T3 名称清单 + T4 走查结果 + 审计全部交互面；每项绑定自动化断言（playwright 键盘 spec 或 vitest 交互测试），防「纸面全绿、实际失效」（提案 R7）；
- 5 个 markdown-editor e2e 键盘专项（ast-block-tables/format-checker/ime-composition/keyboard-navigation/wysiwyg-interaction）+ tests/e2e 键盘面 spec 全量回归（AGENTS.md 铁律：禁止删除）；
- P3-3 tablist 验收（02-B6 完成后）：LeafToolTabStrip role="tab" 方向键随收敛自动获得，本轨道走查确认 + 矩阵标注。

#### 2.6.4 reduced-motion 验收断言（T6-4，R-04）

- 新增 fs 断言（可并入 a11y 断言文件）：reduced-motion.css 含 `[data-reduced-motion]` 选择器（与 @media 同语义块）；lightweightMode.ts:56 setAttribute 保留——**01-S7 接线后转绿**，本任务只验收不动样式文件；
- 动效 token 化验收：ApprovalAskCard.module.css:297、tab-drag.css:42/46 改指 `--transition-*`（01-S7 落地）后 fs 断言无裸时长字面量；
- 轻量档生效验证：lightweightMode 开 disableAnimations → 动画停（手动走查 + 断言挂属性存在）。

---

## ③ 对比度验收表（T5，值契约 → 01-S6；断言为唯一判据）

> WCAG 2.1 AA（正文 4.5:1、大字/UI 3:1），sRGB 相对亮度。现值为 2026-08-09 实测（tokens.css 实读）。

| # | 组合 | 现值 | 现状判定 | 目标阈值 | 候选值（第一档，01-S6 落地） | token 落点 | 主要消费面 | 本轨道断言 |
|---|---|---|---|---|---|---|---|---|
| 1 | #888888 / #f0eee9（light text-tertiary） | 3.06:1 | ❌ | ≥4.5:1 | #757575 档 | tokens.css --text-tertiary（light，tokens.css:22） | 时间戳、ghost 按钮（shell-polish.css:67）、提示文字 | ✓ |
| 2 | #888888 / #e9e5de（light 侧栏元信息） | 2.82:1 | ❌ | ≥4.5:1 | 随 tertiary 加深复测；不足则侧栏元信息改 text-secondary | tokens.css + 侧栏消费面 | 侧栏元信息 | ✓（组合遍历） |
| 3 | #f59e0b / #f0eee9（accent-orange 文字） | 1.85:1 | ❌ 3:1 也不足 | ≥4.5:1（文字） | 文字专用 `--text-warning-strong`：#c2410c 档 | tokens.css 新增文字 token | ChangesSection.tsx:128/139、FileTreeView.tsx:213、ModelConfigEditor.tsx:799 | ✓ |
| 4 | #2f81f7 / #f0eee9（accent-blue 文字） | 3.23:1 | ❌ | ≥4.5:1 | #1e6fd9 档（复测） | tokens.css --accent-blue 或文字变体 | 链接/强调文字 | ✓ |
| 5 | #16a34a / #f0eee9（color-active 绿） | 2.84:1 | ❌ 3:1 | 状态点 ≥3:1；状态文字 ≥4.5:1 | #15803d 档（复测）；文字走 `--text-success-strong` | tokens.css --color-active（:114） | ModelProfileList.tsx:273 状态点/字 | ✓ |
| 6 | #e8590c / #f0eee9（ui-text-warning） | 3.09:1 | ❌ | ≥4.5:1 | #c2410c 档（与 #3 同档可共用） | tokens.css --ui-text-warning（:101）或收敛入 --text-warning-strong | StatusDiagnosticsPanel WARN | ✓ |
| 7 | #737373 / #0d0d0d（dark text-tertiary） | 4.1:1 | ⚠️ 边缘 | ≥4.5:1 | #8f8f8f 档 | tokens.css --text-tertiary（dark，:403） | dark 元信息 | ✓ |
| 8 | #a3a3a3 / #0d0d0d（dark text-secondary） | 7.7:1 | ✅ 达标 | 保持（锁定防回退） | — | — | dark 元信息 | ✓（锁定断言） |

**语义约定**：accent 色（--accent-orange/--accent-blue/--color-active）保留作图标/装饰/非文字用途；**文字用途一律走文字专用 token**。断言测试遍历本表组合 + 全语义色 token × 主题背景，**取值以断言绿为唯一判据**（不达标则加深一档复测）。

---

## ④ 键盘闭环方案

### 4.1 总原则（继承 08 方案 ④.1）

1. hover 揭示必须 focus 配对（:hover → :focus-within/:focus-visible 等价揭示）；
2. 鼠标路径 = 键盘路径（onPointerDown/onMouseEnter 驱动 → onClick/onKeyDown 等价路径）；
3. 焦点闭环五环：打开浮层 → 焦点移入首项 → 方向键漫游 → Enter 激活 → Esc 关闭并归还 trigger；
4. 序列键不产生无意识副作用（Esc Esc 裁决 = 方案 A 改组合键）。

### 4.2 hover 揭示修复矩阵（T4 可执行表）

| 场景 | 现态（实读） | 目标态 | 对照先例 | 本轨道任务 |
|---|---|---|---|---|
| DiffCard .hoverActions | display:none → 仅 :hover（Tab 序不可达；DiffCard.module.css:834-847） | opacity/visibility + :hover/:focus-within 双揭示 | GlobalSessionTabBar.module.css:258（`.tab:focus-within .tabClose`） | T4-1 |
| LeafToolTabStrip 添加菜单 | 仅 onPointerDown（:132-135），菜单项仅 onPointerDown（:161-170），无 Esc/焦点 | 迁 ui/Menu（onClick + Esc + 首项聚焦 + 归还）或补齐 onClick/Esc/焦点 | Menu 基座 | T4-2 |
| ModelBadgePickerMenu 子菜单 | 仅 hover 状态驱动（:76-115），行按钮无 onClick，aria-expanded={isHovered}（:84） | 单一打开态 + onClick/Enter 展开 + 子菜单焦点管理 + aria 绑真实态；hover 保留增强 | SidebarContextMenus focusMenuItem（标杆） | T4-3 |
| Menu children 模式 | :133 options 门控，children 模式 ↑↓/Home/End 空转 | children 对 content 内可聚焦项轮询漫游（双通道） | SidebarContextMenus focusMenuItem | T4-4 |
| ChatHeaderMore 菜单 | renderItem 无 role="menuitem"（:77-90），漫游查询落空 | 补 role="menuitem" | Menu options 模式 | T4-5 |
| session-actions-btn（shell-sidebar.css:286-305） | opacity:0 仅 :hover（P3-4） | **实测疑似死规则**（无 tsx 消费；现 SessionRow 用 sessionActionsBtn 已 28×28 + focus-within）：先 grep 复核，无消费则登记归 01 卫生 | SidebarSessionList.module.css:427-429（已达标先例） | T4-1 附项 |

### 4.3 键盘可达性矩阵（T4-7 起步、T6-3 全量的验收工具）

记录格式（每轮输出一张，复用多轮）：

```
| 交互场景 | 触发元素 | 鼠标路径 | 键盘路径（Tab 序可达? / 操作键） | 焦点归还 | SR 播报 | 状态（通过/未通过） |
```

本轨道首批填充场景（矩阵数据源 = T1 确认清单 9+1 + T3 名称清单 + T4 走查结果）：
1. 删除会话（右键菜单 → 确认对话框）2. 放弃修改（diff 行内 hover 按钮）3. 暂存/取消暂存（diff 行内）4. 复制大文件（DiffCard）5. 移除项目（ProjectPickerMenu）6. 清空用量（SettingsUsageTab）7. 强制取消（ComposerField 长按/Shift+click）8. 未保存切换（FilesCard 5 入口）9. 覆盖外部修改（FilePreview）10. 终止后台任务（BgTaskActions）11. 模型切换（ModelBadgePickerMenu 两级菜单）12. 添加功能面板（LeafToolTabStrip）13. 打开方式/更多菜单（FileActions/FileViewerCard）14. 上级目录/刷新（FilesCard）15. 模型配置/删除（ModelConfigEditor）。

每项绑定自动化断言（playwright 键盘 spec 或 vitest 交互测试）；全量矩阵完成即步 7 判据。

### 4.4 四模式 APG 契约验收（T6-3 引用，02 承接面只验收）

| 模式 | 打开 | 初始焦点 | 漫游 | 激活 | 关闭与归还 | 状态 |
|---|---|---|---|---|---|---|
| menu | trigger Enter/Space/↓ | 首个未禁用项（Menu.tsx:121-126 已实现） | ↑↓ 循环（已实现）+ Home/End（T4-4 补齐）+ children 轮询（T4-4） | Enter（已实现） | Esc（Menu.tsx:165-168）+ 归还 | T4/T6 走查 |
| dialog | 任意 | 取消钮（ConfirmDialog 契约 §2.1.1） | Tab 循环（FocusTrap） | Enter 激活聚焦钮（浏览器原生，不劫持为确认——防危险误触） | Esc 栈（Dialog.tsx dialogStack）+ 归还（useRestoreFocus） | T1 验收 |
| tablist | — | roving tabindex | →/← + Home/End | Enter/Space | — | 02-B6 收敛后 T6-3 验收（P3-3） |
| listbox | — | 已降级 role="list"（T4-6），不承担组合选择语义 | — | — | — | T4-6 |

### 4.5 Esc Esc 误触分叉封死（P1-8，方案 A 定案）

```
现状：第一击 Esc 被 Dialog 关闭消费（Dialog.tsx dialogStack + AppShortcuts.ts:46-64）→ 500ms 内第二击 Esc 匹配序列 'Escape Escape'（ShortcutRegistry.ts:24，ShortcutService.SEQUENCE_TIMEOUT=500 :22）→ 静默分叉（AppShortcuts.ts:143-162，forkTitle 带「双击ESC分叉」:149）
目标（方案 A）：branch_session 改组合键 Ctrl+Shift+F
  ├─ 子步 1：T2-2 冲突检测接生产兜底（AppShortcuts.ts:192-199 去 DEV 门）
  ├─ 子步 2：检测确认 Ctrl+Shift+F 空闲（含平台覆盖）→ 定案记录
  ├─ 子步 3：改注册表 defaultBinding
  ├─ 子步 4：forkTitle 文案联动（:149）
  ├─ 子步 5：无序列绑定残留 → Esc 单键语义唯一 = 关闭/取消
  └─ 子步 6：键盘 e2e 全量 + Esc 场景走查（开 Dialog→Esc 关→再 Esc 无副作用）
兜底（B，仅 A 候选键全冲突时启用）：Dialog 关闭后 1s 抑制窗 + 分叉前显式二次确认——需主控裁决记录
```

---

## ⑤ 验证与提交

### 5.1 门禁命令（每任务提交前全量）

| 层 | 命令 | 说明 |
|---|---|---|
| 快层 | `npm run typecheck`（apps/crish-desktop 工作区或根 `npm run check:desktop`） | 强制，禁止 --no-verify |
| 快层 | `npm run test:coverage -- --project=unit`（或 CI vitest-fast 等价） | 45/70/65/45 口径；**新增断言测试为值/fs 断言，同 style-contract 模式不受覆盖率口径约束**（01 提案 R6 缓解，入库时注明） |
| 中层 | `npm run test`（vitest 全量）/ `npx vitest run --config vitest.integration.config.ts` | 相关批次后跑 |
| e2e | `npx playwright test tests/e2e/keyboard-navigation.spec.ts` + 5 个 markdown-editor 专项 | **禁止删除**；改动键盘面后全量回归 |
| 门禁脚本 | `npm run check:no-window-confirm`、`npm run check:icon-button-names`（T1-6/T3-5 新建后） | 黄绿开发：脚本先建（红基线）→ 修复 → 绿 |

### 5.2 专项测试清单

| 任务 | 测试 |
|---|---|
| T1 | 每点流程级两路径测试（挂起→确认→继续 / 取消→不继续）；useFileNavigation.test.ts 更新；ComposerField 长按吞 click 两路径；BgTaskActions.test.ts 更新；无 confirm 调用断言 |
| T2 | ShortcutService.test.ts 单源断言（展示==执行、清单互盖、无序列残留、注册表↔handler 覆盖）；改键键盘走查 |
| T3 | 扫描门禁绿；axe 或等价扫描 5 文件无「无名称按钮」violation；computed style ≥24px 断言；SR 抽查 3 代表按钮（NVDA 不可用 → Playwright aria 快照 + axe 降级） |
| T4 | 键盘矩阵场景自动化；Menu children 漫游单测；ModelBadgePickerMenu.test.tsx 更新；视觉回归（hover 改 focus-within 前后截图对比） |
| T5 | a11y-contrast.test.ts 先红后绿（01-S6 联动）；双主题截图抽查 6 面 |
| T6 | role="log"/aria-live 断言存在且生效；文案 grep（无裸「…」/ASCII 三点）；键盘矩阵全绿；5 个 e2e 专项全绿 |

### 5.3 提交纪律

1. **每任务独立提交**（27 项文件级任务粒度，T1 的 9 个调用点可再拆：每点独立提交，对应 03-review ⑤.3「confirm 迁移每点独立提交」）；
2. 提交信息带批次号（feat/fix/test/chore + 范围，仓库风格）；**禁止 --no-verify**；
3. 新脚本/断言测试（check-*.mjs、a11y-contrast.test.ts 等）**随批入库**（AGENTS.md 测试资产铁律，不留未跟踪）；
4. 开工前置 `git status`：目标文件若被并行域修改（现脏文件：messageSnapshotsBridge.ts、usePreviewNavigation.ts、layoutRestorePolicy.ts、Rust buffer.rs 等——均非本轨道文件面，但需先确认无重叠），M 标记先读最新再改；提交只 add 本域文件，不卷入 reference/markdown-editor 与 crates/conex-browser* 等并行域改动；
5. 改 CSS 内容批次与快照同提交（8e8c313c 教训；T3-4/T4-1 涉及）；
6. 行为变更面（T1 异步化、T2 改键、T4 hover 改造）开工前先出变更清单（§2.1.2 行为表 + 定案记录），作为人工验收与回退判定依据；单任务失败仅 revert 该任务。

### 5.4 与 01/02 的交接断言

| 交接方 | 断言（本轨道验收侧） | 时序 |
|---|---|---|
| 02-E3（ui/ConfirmDialog） | 基座满足 §2.1.1 契约（alertdialog/labelledby/describedby/初始焦点取消钮/FocusTrap/Esc 归还/danger 不默认聚焦确认）；本轨道 T1 按契约消费 | 02 先行，T1 后置（R5 风险缓解：契约先行、验收后置） |
| 02-B1（Tooltip 迁移） | ui/Tooltip 契约注释（T3-6）；迁移后无名称按钮重扫；键盘冒烟（Tab 聚焦→tooltip 出现，Shift+Tab→消失）；SR 抽查 3 面 | 02-B1 完成 → T3-6 |
| 02-B2（按钮迁移） | 机械替换工具保留已有 aria-label（红线）；16 按钮清单以 02 后 grep 重扫为准（R-07） | 02-B2 先结构、T3 后 aria，两轮分开 |
| 02-B6（TabStrip） | LeafToolTabStrip 同文件串行（添加菜单 T4-2 vs tab 条收敛）；P3-3 tablist 方向键验收（T6-3） | 02-B6 完成后验收 |
| 01-S6（对比度调值） | a11y-contrast.test.ts 先红后绿；③表为值契约；消费面改引用等 token 就绪（防悬空） | T5-1 批次 6 → 01-S6 批次 9 → T5-2 转绿 |
| 01-S7（动效/接线） | reduced-motion `[data-reduced-motion]` 接线断言 + 动效 token 化断言（T6-4，R-04 验收面） | 01-S7 后转绿 |

---

## ⑥ 风险

| # | 风险 | 触发场景 | 缓解 |
|---|---|---|---|
| R1 | **T1 异步化行为回归（最大风险）**：同步布尔 confirm → Promise 桥，取消路径漏改导致「取消后仍执行」 | useFileNavigation/useFilePreview/ComposerField 三点（useFileNavigation 签名已异步，风险最低；ComposerField 长按吞 click 语义最敏感） | §2.1.2 行为变更清单逐点签字；每点两路径测试 + 独立提交；回退粒度=单点 |
| R2 | **T2 改键冲突**：Ctrl+Shift+F 被占用（现冲突检测仅 DEV） | 分支会话新绑定不生效或覆盖其他功能 | 冲突检测生产接线为**第一子步**（T2-2）；定案记录；改键后全量键盘 e2e；Esc 语义唯一化后无序列残留 |
| R3 | **T4 hover 改造影响鼠标体验**：hover 揭示改 focus-within 后鼠标路径观感变化 | DiffCard hoverActions、ModelBadgePickerMenu hover 级联 | hover 保留为主路径、focus-within 仅增补；80/150ms 定时器不动；视觉回归（前后截图对比） |
| R4 | **T5 调值牵动视觉基线**：tertiary/orange/绿加深改变大面积观感 | 时间戳/ghost 按钮等 | 值改归 01-S6（本轨道不碰 tokens.css）；断言绿为唯一判据 + 截图对照；与 01 串行避免两批视觉变化叠加 |
| R5 | **依赖 02 节奏**：02-E3 基座/02-B1/B2 未完成时本轨道 T1/T3 无法落地 | 批次错位 | 契约与断言先行（本文档即契约）；02 完成即刻执行；R-07 串行已由总计划批次划分保障 |
| R6 | **a11y 断言测试被覆盖率门禁误伤** | vitest unit 45/70/65/45 口径 | 断言为值/fs 断言（同 style-contract 模式），明确不受覆盖率约束；入库注释注明 |
| R7 | **键盘矩阵「纸面全绿、实际失效」** | 人工走查遗漏、e2e 覆盖不足 | 矩阵每项绑定自动化断言（playwright 键盘 spec）；5 个 markdown-editor e2e 专项为强制回归面 |
| R8 | **序列键抑制误伤（仅 B 方案）** | B 方案抑制窗内合法分叉被拦 | 推荐 A 方案从根上消除该权衡；B 需主控裁决记录 |
| R9 | **幽灵键裁决悬置**：toggle_runtime（注册无 handler）、close_tab（展示无执行） | 单源断言「注册表↔handler 覆盖」红灯 | T2-1 默认建议（移除/删行）先行，主控裁决记录；断言测试同时防回潮 |
| R10 | **审计漂移**：`.session-actions-btn`（shell-sidebar.css:286-305）无 tsx 消费方（疑似死规则）、open_models「缺默认绑定」已过时（实测一致） | 按旧清单执行产生空操作/误改 | 本计划已按实读登记（§2.3.2/§2.2.0）；执行 Agent grep 复核后按漂移处理；死规则归 01 卫生 |
| R11 | **SR 播报验证无环境前提**：NVDA 未装 | 「SR 抽查」不可执行 | 降级路径：Playwright aria 快照断言（role/name/expanded）+ axe 扫描 + 人工键盘走查；SR 播报留待有环境补录（03-review P1-1） |
| R12 | **同文件串行遗漏**：ChatMessageList（07/02-C1/本轨道 T6-1）、LeafToolTabStrip（02-B6/本轨道 T4-2）、ChatHeaderMore（02-A1 Menu 直引/本轨道 T4-5）、DiffCard 系（01-S0/S2、02-B2、本轨道 T1/T3/T4 多面） | 并行合并冲突 | 按 03-review 批次矩阵串行：「01-S0 兜底 → 08-步5 hover → 02-B2 button → 08-步4 名称」；派单前 git status 确认 |

**回退总原则**：27 项任务各自独立提交、独立门禁；单任务失败仅 git revert 该任务，不跨任务回滚；行为变更面（T1 异步化、T2 改键、T4 hover 改造）以变更清单为回退判定依据。

---

## 附：与相邻方案的关系

- **08 方案步 2-7**：本文档为其实施级细化（步 1 由 02-B1 承接，本轨道仅 T3-6 契约注释与验收）；步 7 ④⑤ 已按 R-04/03-review P0-1 归 01，本轨道 T6-4 只验收。
- **02 组件体系**：ConfirmDialog（02-E3）/Tooltip（02-B1）/Button（02-B2）/TabStrip（02-B6）基座归 02；本轨道只消费与验收。
- **01 样式统一**：对比度 token 值（01-S6）、reduced-motion 接线与动效 token（01-S7）归 01；本轨道出断言与验收（R-04 精神）。
- **测试资产**：5 个 markdown-editor e2e 专项 spec 与 tests/e2e 键盘 spec 为强制回归面，禁止删除；本轨道新增断言（a11y-contrast / confirm 清零 / 无名称按钮 / 单源一致）为增量资产，完成后随批 `git add` 提交入库。
- **文档引用**：本计划行号以 2026-08-09 工作区实测为准；执行时行号「语义定位优先」（03-review 漂移清单口径：大文件行号普遍偏大 3%~8%）。

（完——27 项任务清单、实现要点、对比度验收表、键盘闭环方案、验证与提交、风险 12 项，可派发执行）
