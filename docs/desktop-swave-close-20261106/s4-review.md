# S4「退场基础设施」复核报告（只读复核，不改文件、不提交、不跑测试）

- 复核员：S 波收口 S4 复核员（只读）
- 复核时间：2026-11-06 08:30–09:00 EST 左右
- 复核对象：`~/workspace/swave-20261106/S4-退场基础设施.md`（S4 完成报告）vs PC 磁盘实况
- 环境：DESKTOP-J31MN6T（100.83.127.119），SSH Administrator；仓库 `C:\Software\conex`，分支 `chore/settings-rework-20261101`，HEAD `ffdb17792`（docs 提交）
- 方法：读 S4 报告全文；`git status/diff/diff --cached/grep`（只读）；`rscp-get.sh` 拉回 36 个 S4 文件 + `SettingsQuickMenu.module.css` 到 VM `/tmp/s4verify/` 逐项比对；`node_modules/@base-ui/react` 的 d.ts 原文核对；VM `s4-work/edit/` 副本做 SHA-256 交叉比对。**未跑任何测试、未跑 tsc**（任务限定只读复核），下文凡涉「通过/全绿」均为报告自述，复核只核对了可静态验证的部分（文件存在、内容、计数）。

## 结论：需修补后提交

代码本体核实无功能性缺陷，报告所述机制与接线基本属实；但发现 **1 处 S4 §六横扫遗漏的死选择器残留（SettingsQuickMenu）**、**1 处提交纠缠硬性风险（3 文件暂存区混有他线改动）**，另有 2 处注释措辞与 1 处备份缺口、1 处报告清单小出入。修补点见 §七，全部是小修补；修补后可按用户 2026-11-06 08:16 的提交勤快裁决尽快提交（提交无需用户批准，但必须用 §七 P1 的分离程序，绝不能 `git commit -a`）。

---

## 一、基础层逐文件核对（6 文件，全部通过）

| 文件 | 核对结果 |
|---|---|
| `components/chat-tool-call/toolRevealState.ts`（decideExit） | ✅ 通过。`decideExit`（:180）与报告 §一逐条件一致：空键/`disabled`/`inVirtualWindow` → false；`isRevealDegraded()` → false；`entered ?? hasEntered(key)` 为 false → false；否则 true。`markEntered` 在 `useEntranceReveal.ts:155` 判定通过时即登记（非动画结束）✅。基础层 unstaged diff 为**纯新增 123 行、0 删除**（5 文件合计），无他线 hunk 混入 |
| `utils/motionTokens.ts` | ✅ 通过。`DURATION_EXIT_MS = 150`（:54）、`DURATION_POPOVER_EXIT_MS = 120`（:61）、`EXIT_SETTLE_BUFFER_MS = 50`（:68）；`MOTION_DURATION` 含 `EXIT_MS` / `POPOVER_EXIT_MS`。CSS 侧变量在 `styles/tokens-base.css:33/49`（`--duration-exit: 150ms` / `--transition-popover-exit: 120ms var(--ease-accelerate)`），减动效归零在同文件 :216/:227 ✅ |
| `styles/design-system.css` | ✅ 通过。`@keyframes crish-row-exit`（opacity 1→0 + translateY 0→−4px，:259）、`.crish-exit-fade`（:270，`var(--duration-exit)` + accelerate + `pointer-events: none`）、`.crish-exit-popover`（:275，`var(--transition-popover-exit)` + `pointer-events: none`）**均在 design-system.css 文件内定义**；减动效段 `animation: none`（:281–284）✅ |
| `components/motion/useExitReveal.ts`（新建，323 行） | ✅ 通过。323 行与报告一致；导出 `useExitReveal` / `useClosingFlag` / `useClosingValue`（`useClosingFlag` 内调 `decideExit`，卸载定时器 `durationMs + EXIT_SETTLE_BUFFER_MS`；`useExitReveal` 置 `el.dataset.exiting = 'true'` 后做尺寸收敛）。`DURATION_EXIT_MS` / `DURATION_POPOVER_EXIT_MS` 自本文件再导出，`EXIT_SETTLE_BUFFER_MS` 未再导出，与报告 §4.2 一致 ✅ |
| `components/motion/index.ts` | ✅ 通过。已导出三件套及 `ExitAxis` / `ExitRevealInput` / `ExitRevealResult` / `ClosingHostInput` / `ClosingFlagResult` / `ClosingValueResult` ✅ |
| `components/motion/useEntranceReveal.ts` | ✅ 通过。三处 `dataset.exiting === 'true'` 让位（:196/:204/:228），与报告 §4.3 一致；`motion/index.ts` 外其余改动无 ✅ |

交叉哈希：拉回的 33 个文件与 VM `s4-work/edit/` 副本**逐字节一致**（SHA-256 前 12 位全等；另 2 个测试文件 `entranceChannel.contract.test.ts`、`MessageContent.waitingReason.source.test.ts` 存放于 `s4-work/` 根目录而非 `edit/`，未纳入本次比对）。报告点名的 3 个 SHA 前缀复核一致：`Menu.module.css E2362D3FC0BE…`、`ComposePlusMenu.tsx C1BC8469C1B0…`、`exitChannel.contract.test.ts BBB1E3170D93…`。报告称「36/36」，本次独立比对覆盖 33/33（其余 3 个应为 edit/ 之外的文件，未逐一复原——不构成疑点，仅说明复核口径）。

## 二、11 项集成 + ComposePlusMenu 逐项核对（全部接线存在）

核对方式：PC 工作树 `git grep`（钩子名/关键标识）+ 拉回文件细读关键行。27 个集成/测试文件的 unstaged diff 合计 **764 行新增、126 行删除**，规模与 S4 所述相符；其中抽查全文阅读的三份 unstaged diff（MessageContent、CompactToolRow、Menu.tsx）均为纯 S4 hunk（见 §六）。

| # | 面 | 核对结果 |
|---|---|---|
| 1 | ApprovalAskCard 决策后退场 | ✅ `closing?: boolean` prop（:96）、`useExitReveal({ closing })`（:173）、宿主 CompactToolRow `useClosingFlag(tc.status === 'pending_approval', …)`（:226）均在。决策回调立即发出、不被退场延迟——代码层面卡片内 `if (closing) return;`（:345）为退场期锁死，回调本身在 closing 置位前发出；时序细节未做动态验证，采信报告 §九.4 实机记录 |
| 2 | ApprovalDock 清空退场 | ✅ `closing` prop（:44）+ 内部 `useClosingValue` 自宿主（:71）+ `useExitReveal`（:83）；ChatStatusRibbons 内 `useClosingValue` 保活（:250，`entered: dockShownRef.current`，仅真正渲染过才播退场）✅ |
| 3 | 附件 chip 移除退场 | ✅ `closingEntries` 快照 Map（:114）、`ClosingAttachWrap`（:78，horizontal + gapPx 8）、`onRemoveAttachment` 立即调用（:145，不等退场）、空判断改为实况与退场槽均空才 `return null`（:162）、退场清槽定时器 `DURATION_EXIT_MS + EXIT_SETTLE_BUFFER_MS` ✅ |
| 4 | ComposerErrorBar 退场 | ✅ `closing` prop（:36）+ 内部 `useClosingValue(failedStatus)`（:52）+ 渲染取快照（:58）；ChatStatusRibbons 内 `useClosingFlag(activeRibbon === 'runtime-error', …)`（:268）✅ |
| 5 | InFlowStatusLine 卸载退场 | ✅ `closing` prop（:25）+ `useExitReveal`（:40）；MessageContent 内 `useClosingValue(inFlowRetry, …)`（:232），三处渲染点（:776/810/927 附近，diff hunk 确认）统一改走 `closingRetry.value` + `closing` ✅ |
| 6 | PermissionModeMenu 退场 | ✅ TSX 内 `{open &&` 仅存于注释（:117，说明已删条件渲染）；`Menu.tsx` 的 anchor 早退已删（见 §三）；`.permMenu` 的死 `animation: crish-popover-enter` 行已删，模块内已无 `animation:` 声明，注释（:118）说明入/退场由 menuContent 规则承载 ✅ |
| 7 | SEP 主面板 + 级联子菜单 | ✅ 主面板本地 `@keyframes crish-popover-enter/exit` + `.cascadeSubmenu[data-state='closed']` 规则（SmartExpandablePanel.module.css :318/:329/:373）；级联 `useClosingValue({parent, style, side})`（SmartExpandablePanel.tsx:58）+ `closing` prop → 子菜单根 `data-state={closing ? 'closed' : 'open'}`（SmartPanelCascadeSubmenu.tsx:74）。级联早退专项见 §四 ✅ |
| 8 | NewTabLauncherPopover 退场 | ✅ 本地 `@keyframes launcherExit`（:54）+ `.popoverContent[data-state='closed']`（:65）+ reduced-motion 段（:72）；Radix Presence 保活（注释 :53）✅ |
| 9 | SlashMenuOverlay 退场 | ✅ `useClosingValue(snap.open ? snap : null, …)`（:94）+ 渲染取快照 + 根挂全局 `.crish-exit-popover`（:137）；`file` 命令确认仍为 **CRLF 换行**，184 行（报告 161→184 一致）✅ |
| 10 | FileAnnotationPopover / AnnotationChipItem 退场 | ✅ Popover `useClosingValue`（FileAnnotationPopover.tsx:41）；CSS 本地 `@keyframes popoverFadeOut` + `.popover[data-closing='true']`（FileAnnotationPopover.module.css :59/:70）；Chip `closing` prop（AnnotationChipItem.tsx:35）+ `useExitReveal({ closing, axis: 'horizontal', gapPx: 8 })`（:75）+ popover `useClosingFlag(isOpen, …)`（:67）；Chip CSS 本地 `@keyframes annPopoverFadeOut` + `[data-closing='true']` ✅ |
| 11 | DraftUndoToast 退场 | ✅ `dismissed` 状态（:41）+ `useClosingFlag(show && !dismissed, …)`（:54，`shownRef` 规避幻影 closing :53）；CSS 本地 `@keyframes undoToastOut`（:114）+ 退场规则（:126）✅ |
| 12 | ComposePlusMenu 父级早退（实机发现） | ✅ `useClosingFlag(open, { key: 'compose-plus', durationMs: DURATION_POPOVER_EXIT_MS, entered: shownRef.current })`（:44）；`if (!plusClosing.visible) return null;`（:157）；原 `if (!open) return null` 已无；关闭期仍向 SEP 传实况 `open`（false）（:160）✅ |

## 三、重点复核 (a)：Base UI 不写 data-state

**发现本身属实，已在源码/依赖双重验证：**

- `C:\Software\conex\node_modules\@base-ui\react\menu\popup\MenuPopupDataAttributes.d.ts` 全文枚举的属性只有：`data-open`、`data-closed`、`data-starting-style`、`data-ending-style`、`data-side`、`data-align`、`data-instant`——**无 `data-state`**。包版本 `1.9.0`（`package.json`），与报告一致。
- `Menu.module.css` 并集选择器在磁盘上与报告逐字一致：`.menuContent[data-state='closed'], .menuContent[data-ending-style], .popup[data-state='closed'], .popup[data-ending-style]`（:126–129）及 top 变体四条（:134–137）。
- `Menu.tsx` 的 `if (anchor && !isOpen) return null;` 已删（unstaged diff 仅此一处删除 + 注释，9 行）；契约测试钉住 `not.toContain('if (anchor && !isOpen)')`（exitChannel :283–286）。
- 入场 `[data-state='open']`：**仍在代码中（Menu.module.css:105–113），是死的，未被悄悄修掉**；同文件注释（:115–125）与 S4 报告 §六/§十.2 均明确登记为 **S5b 待修项**（可选路线：无修饰挂载动画或 @starting-style）。登记链完整：S5a 报告 §五已把退场缺失面登记为 S4/S5b 地盘；S4 报告 §六、§十.2 两处登记入场项。**无遗漏登记。**

**全仓 `[data-state]` 残留清单**（`git grep -n "data-state"`：desktop src 共 118 处；`*.css` 全仓 13 文件、71 处；mobile 0 处）：

| 文件 | 性质 | 结论 |
|---|---|---|
| `components/ui/Menu/Menu.module.css` | 退场已修为并集；入场 `[data-state='open']` 仍死 | ✅ 已修退场；入场已登记 S5b |
| **`components/settings/SettingsQuickMenu.module.css`（:99–113）** | **残留死选择器，S4 横扫遗漏（见 §七 P2）** | ❌ 需修补/登记 |
| `components/chat-composer/TiptapSlashMenu.module.css`（:43–58） | Radix Popover（TSX :19 `import * as Popover from '@radix-ui/react-popover'`），`data-state` 真实存在 | ✅ 活的，无需动 |
| `components/binary-tree/NewTabLauncherPopover.module.css`（:65） | Radix，活的 | ✅ |
| `components/ui/SmartExpandablePanel/SmartExpandablePanel.module.css`（:373） | Radix + 手写 `data-state`（子菜单 TSX :74 自写），活的 | ✅ |
| `components/chat-composer/PermissionModeMenu.module.css`（:118） | 仅注释提及 `[data-state]`，无选择器 | 措辞见 §七 P3 |
| `components/ui/Select/*`、`Switch`、`accountControls`、`ToastStackModern`、`CacheMetricsBadge`、`FlowDagView` 等 | 各自 TSX 自写 `data-state`（如 `SelectContent.tsx:135`、`Switch.tsx:266`），选择器与写值一一对应 | ✅ 活的，与 Base UI 无关 |
| `components/ui/internal/presence/*`（`useModernPresence` 自写 `data-state`） | 自研 presence，与 Base UI 无关 | ✅ |

**新发现——SettingsQuickMenu 死选择器残留（本次复核最主要的增量发现）：**

- `SettingsQuickMenu.module.css:99–113`：`.sbQuickMenu[data-state='open']`（入场动画）与 `.sbQuickMenu[data-state='closed']`（退场动画，`crish-popover-exit-top` + `pointer-events: none`）及配套 reduced-motion 块，三条规则全死。
- 注释（:99–100）原文：「使用 data-state='open'/'closed' 属性（@base-ui/react/menu 菜单 Popup 自动注入）」——**该事实主张是错的**（d.ts 已证伪），注释须纠正。
- 归属已核实：`SettingsQuickMenu.tsx:24` 用共享 `Menu`（`import { Button, Menu, Tooltip } from '@/components/ui'`，即 Base UI 封装）；`:382` 以 `panel={{ contentClassName: styles.sbQuickMenu }}` 把该类挂到 popup 上；`Menu.tsx:448` 的 `contentClasses = [styles.menuContent, contentClassName]` 使 popup 同时带 `menuContent` 与 `sbQuickMenu` 两类。
- **影响定级为低**：因 popup 同时带已修复的共享 `menuContent` 类，退场实际由并集选择器接管，视觉上无缺口；残留是冗余死代码 + 错误注释。且同一文件的子菜单已正确使用 `[data-ending-style]`（:332，`@starting-style` 机制），说明主菜单规则是在那次修正中被漏掉的。
- 处置：见 §七 P2（删或改写为 `[data-ending-style]`/`@starting-style` + 纠正注释；建议并入 S5b，与入场死选择器同批处理，但必须在提交说明/登记中写明，不得悄悄带过）。

## 四、重点复核 (b)：SEP 父级早退与级联子菜单

- **ComposePlusMenu 主面板**：已修复（§二 #12），`if (!open) return null` 无残留。
- **其余三家 SEP 消费方**：`ChatHeaderMore.tsx:153`、`ProjectPickerMenu.tsx:276`、`SubagentHeaderPanel.tsx:122` 均为无条件渲染（`return (<SmartExpandablePanel …` / fragment 内直接渲染），前 6 行上下文无 `{open &&` 门控、无提前 return——与报告 §七「只有 ComposePlusMenu 早退」一致 ✅。
- **级联子菜单无同类父级早退**：
  - 渲染点由保活值驱动：`SmartExpandablePanel.tsx:488 {closingSubmenu.value != null && (<SmartPanelCascadeSubmenu … closing={closingSubmenu.closing} />)}`，不是实况 `activeSubmenu`；`closingSubmenu = useClosingValue(…)`（:58，`key: 'sep-cascade'`，`durationMs: 120`，`entered: submenuShownRef.current`）。
  - 关闭路径会启动退场窗：`handleOpenChange(false)` 内 `setActiveSubmenu(null); setSubmenuStyle(null);`（:127），使保活值变 null → `closing=true`、子菜单根 `data-state` 翻 `closed` 播本地 120ms 退场；悬停离开/安全区超时同样经 `setActiveSubmenu(null)`（:339/:350/:369）走同一宿主。
  - **时序耦合说明（非缺陷，记录在案）**：级联子菜单 JSX 位于 Radix `<Popover.Content>` 内部（渲染点在 `</Popover.Content>` 之前），其 120ms 退场窗嵌套在主面板自身的 120ms 退场窗内并行播放，而非独立延长；减动效档下两者同归零。机制自洽，无需改动；但「级联子菜单退场」仍属报告 §十.1 仅代码+契约、未实机验证的面，收口实机环节应打开一次级联再关闭验证。

## 五、契约测试计数（只读文件计数，未执行）

| 文件 | 计数方法 | 结果 |
|---|---|---|
| `exitChannel.contract.test.ts`（新建，379 行） | `it(` 34 个 + `it.each` 7 例 = **41** | ✅ 与报告 41 一致 |
| `entranceChannel.contract.test.ts`（92 行） | `it(` 7 个 + `it.each` 9 例 = **16** | ✅ 与报告 16 一致 |
| 合计 | 41 + 16 = **57** | ✅ 与报告「57/57」计数一致（通过状态未重跑，不复核） |
| `tabStripMotionContract.test.ts` | 退场同步断言在 :117–123（`--duration-exit: 150ms`、`--transition-popover-exit: 120ms var(--ease-accelerate)` 与三 TS 常量） | ✅ |
| `entranceChannel` 的 data-exiting 断言 | 统计 `dataset.exiting === 'true'` ≥ 3 处 + `useExitReveal` 置标志 | ✅（源码实测 3 处） |
| `MessageContent.waitingReason.source.test.ts` | 已改为 closingRetry 形态（`useClosingValue(inFlowRetry,` 断言） | ✅ |
| 契约对并集选择器的钉点 | exitChannel :288–296 断言四条选择器全在（两 `[data-ending-style]` + 两 `[data-state='closed']`） | ✅ |

**未独立复核项（只读任务不跑测试）**：报告的 tsc 0、57/57 全绿、相关套件 49/49、Menu/SEP/Approval 三面实机时序（含 ApprovalAskCard 第二轮完整退场与第一轮 ~119ms 竞态）——均采信报告，未重跑、未重测。Menu 并集版淡出复验仍待收口实机环节（报告 §九.2/§十.1 已登记）。

## 六、git 状态与纠缠分析

- **未提交属实**：全部 S4 文件均为 unstaged `M` 或 untracked `??`（`useExitReveal.ts`、`exitChannel.contract.test.ts` 为 `??`）；工作树共 492 条 status 记录、52 个 untracked——S4 只是其中一小岛。
- **S4 批量级**：基础层 unstaged diff 纯新增 123 行；集成/测试 27 文件 unstaged diff 764+/126−；另 2 个新文件未计入 diff 行数。
- **暂存区混有他线改动（硬性纠缠，提交前必须分离）**：
  - `CompactToolRow.tsx`（MM）：staged 202 行 = **P4 方案纯化重构**（文件头注释「彻底切除 500ms 定时器、liveNow 轮询…」，删 `isEditToolName` 等 import）；S4 的 unstaged 部分仅 18 行（`useClosingFlag` + `renderApprovalCard` + `closing` prop），已全文读过 diff，纯 S4。
  - `Menu.tsx`（MM）：staged 20 行 = **`id` prop 新增 + 解构重构**（他线）；S4 unstaged 仅 9 行（删 anchor 早退 + 注释），已全文读过 diff，纯 S4。
  - `SmartExpandablePanel.tsx`（MM）：staged 30 行 = **props 解构重排**（他线）；S4 unstaged 37 行，已核对为 S4 接线。
  - `s4-work/staged-*.diff`（S4  agent 当时存档）与当前暂存区 blob 哈希一致（CompactToolRow `90eb4ca2e..ea953b4d7`、Menu `550570cdc..3ec2d7a1f`），即暂存区自 S4 推送后未变——S4 agent 知晓暂存纠缠但报告未作披露分析。
  - 另：`motionTokens.test.ts` staged 24 行（`calcAccordionDuration` 期望值改动，他线）与 `motionTokens.guard.test.ts`（mobile）unstaged 改动**均非 S4**，S4 报告未提及它们是正确的；收口披露时不要把它们算进 S4。
- **复合披露基底写法（建议）**：S4 提交的基底 = `HEAD` + 对 3 个 MM 文件的 **unstaged diff（`git diff`，以 index 为基准）** + 2 个新文件；**不是 `git diff HEAD`**（后者会把他线 staged hunk 一并算进 S4）。披露时逐文件列：基础层 5 改 + 2 新、集成 23 改、测试 3 改，并单列「暂存区他线改动（不属于 S4，提交时不得带入）」。
- **报告 §十一清单小出入**：`ComposerAttachmentBar.tsx（+ CSS）`中的 CSS 不成立——`ComposerAttachmentBar.module.css` 在 `git status` 中完全无记录（worktree/index/HEAD 三者一致），`edit/` 副本与 PC 文件逐字节相同，说明 S4 未改动该 CSS（仅作参考拉取）。其余 §十一文件均与磁盘一致。
- **备份**：`C:\Users\Administrator\AppData\Local\Temp\muse-backup-20261106-s4\` 存在，实测 **29 个文件**，不是报告所称「28 + 后补 2 = 30」。与 31 个已改 tracked 文件对照，缺 **2 个测试文件**：`entranceChannel.contract.test.ts`、`MessageContent.waitingReason.source.test.ts`（均为小改动，+8/+7 行级）。低风险但备份不完整，提交前应补齐；报告的算术亦应更正。

## 七、修补点（按优先级）

1. **P1——提交分离程序（硬性，不做不得提交）**：3 个 MM 文件的 index 已含他线改动，`git add <file>` / `git commit -a` / `git commit --only` 都会把他线 hunk 扫进 S4 提交。建议程序：先 `git diff --cached -- <3 文件> > foreign-staged.patch` 备份暂存态；`git reset <3 文件>` 卸掉暂存；再对这 3 文件逐 hunk 甄别、只 stage S4 的 hunk（S4 hunk 特征唯一：CompactToolRow 的 `useClosingFlag`/`renderApprovalCard`、`Menu.tsx` 的 anchor 早退删除、SEP 的 `closingSubmenu` 接线）；提交前 `git diff --cached` 复核 index 只含 S4 内容；提交后用 `git apply --cached foreign-staged.patch` 恢复他线暂存态（或由收口按他线主题另行处理）。其余 S4 文件无暂存纠缠，可正常 `git add`。**另注意用户 2026-11-06 08:16 新裁决：提交要勤快、无需用户批准——修补落地后即按此程序提交，不必等用户发话。**
2. **P2——SettingsQuickMenu 死选择器残留（登记 S5b，或随 S4 补丁同行）**：`components/settings/SettingsQuickMenu.module.css:99–113` 的 `.sbQuickMenu[data-state='open'/'closed']` 及 reduced-motion 块：删除，或改写为 `[data-ending-style]` / `@starting-style`（与同文件 :332 子菜单机制一致）；同时纠正 :99–100 的错误注释（Base UI 不注入 `data-state`）。建议并入 S5b（入场死选择器同批），但须在 S4 提交说明或收口登记中明确写出这一项；影响低，不阻塞 S4 提交——但「S4 已横扫 Menu 族死选择器」的说法须以此项为例外收窄。
3. **P3——两处注释措辞（一并修，纯注释）**：`Menu.tsx:458–460` 把关闭接管说成「menuContent 的 `[data-state='closed']` 规则」——对 Base UI popup 而言接管者是 `[data-ending-style]`，`[data-state='closed']` 只覆盖 Radix 面；改为「并集选择器」表述。`PermissionModeMenu.module.css:118`「menuContent[data-state] 规则承载」同理改为并集表述。
4. **P4——备份与报告订正**：向 PC 备份目录补 `entranceChannel.contract.test.ts` 与 `MessageContent.waitingReason.source.test.ts` 两文件；S4 报告 §十一删除 `ComposerAttachmentBar` 的「+ CSS」，§「备份」一节更正文件数为实测值。

## 八、登记项复核（报告 §十）

- ApprovalAskCard 第一轮快完成竞态（~119ms 提前移除，根因未钉住）：报告如实登记为跟进项，未夸大；磁盘上无反证。补充信息：用户同日另有「审批/提问卡改到输入区 + 同心圆角」设计需求且设计稿已交付（`reference\muse-approval-card-design-20261106\`），该卡未来可能整体改版——竞态调查与改版的关系由父级裁决，复核不作主张。
- SEP 级联子菜单 / DraftUndoToast / SlashMenuOverlay / FileAnnotationPopover / NewTabLauncherPopover 仅代码+契约、未逐项实机验证：属实（本次只读复核同样未实机验证）；Menu 并集版淡出复验亦待收口实机环节。
- 边缘情形清单（§五末尾 6 项：无 id 附件键碰撞、AttachmentCard 重挂重置 imgError、useExitReveal 换分支不收敛、幻影 closing、dock 新审批提前结束旧退场、FileAnnotationPopover 退场窗内键盘可达）：均为报告内登记，未在磁盘上发现与之矛盾的内容；未逐项深挖（只读复核范围）。

## 九、复核方法与证据索引

- PC 侧：`git status --short`（492 行，见 `/tmp/s4-git-status.txt`）、`git diff --stat`（基础层 123+/0−；集成 27 文件 764+/126−）、`git diff --cached --stat`（4 文件 90+/186−，均为他线）、`git grep data-state`（desktop 118 处；`*.css` 全仓 71 处；mobile 0 处）、`git grep data-ending-style`、`git show HEAD` 对照。
- 拉回 VM 比对：`/tmp/s4verify/`（36 个 S4 文件 + `SettingsQuickMenu.module.css`，另 `SettingsQuickMenu.module.css` 单独拉回），与 `~/workspace/swave-20261106/s4-work/edit/` 逐字节比对 33/33 一致。
- 依赖原文：`node_modules/@base-ui/react@1.9.0/menu/popup/MenuPopupDataAttributes.d.ts`（无 `data-state`）。
- 本次复核未修改 PC 或 VM 上的任何仓库文件；未动 stash（stash 列表只读查看：`stash@{0..4}` 均为 lint-staged 自动备份 + 另一分支 WIP，与 S4 无关）；未跑测试。
