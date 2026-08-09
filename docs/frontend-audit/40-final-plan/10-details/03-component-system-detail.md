# T-C 组件体系轨道 · 详细执行计划

> 产出：详细计划子 Agent（只读 + 本文档产出，无代码改动）。
> 输入：`40-final-plan/00-master-plan.md`（v1.0，批次 3/4/5/7/8、R-01~R-09 与主控裁决 C-4/C-5/C-7/C-8）+ `20-proposals/02-component-system-proposal.md`（A/B/D 段）+ `30-reviews/01~03`（R-01/05/07/09 及 P0/P1 修正）+ `30-reviews/01-batch-structure-review.md`（B-P0-2/B-P0-3/B-P0-5/B-P0-6）+ `10-analysis/02-component-architecture-audit.md`。
> 基线：2026-08-09+ 工作区实读（grep 清单与行号均经实读复核，行号执行前语义定位优先——03 评审"行号普遍偏大 3%~8%"教训）。
> 性质：可派发执行的详细计划；不改变 00-master-plan 的批次边界与串行纪律。
> 版本：v2（v1 修订：吸收阶段 6 评审与主控裁决 C-4/C-5/C-7/C-8，新增 T14~T17，见「修订日志」）。

---

## 修订日志（v1 → v2，2026-08-09）

| 版本 | 日期 | 修订要点 |
|---|---|---|
| v1 → v2 | 2026-08-09 | 吸收阶段 6 评审（`01-batch-structure-review.md` B-P0-2/B-P0-3/B-P0-5/B-P0-6）与主控裁决，任务编号与 master plan v1.0 引用一致：**C-7**——02-E3 由「删除」改语义为「**创建 ui/ConfirmDialog 基座**」（新增 **T15**，批次 4.0，先行于 04 轨道 window.confirm 替换消费；契约按 04-detail §2.1.1）；**C-8**——store 直引迁移 78 文件由 02 轨道承办（新增 **T14**，批次 7.4，消费点改走 store-access facade，与 05-detail「02 承办、03/05 只做门禁」口径一致）；**C-4**——裸 button 剩余批批次归属定案（新增 **T16**，批次 3.4 承接全部波次，含 T8 后续 ~100 文件，内拆 6 子波）；**C-5**——02-C1 props 治理（新增 **T17**，批次 8.0，ChatCard/ChatComposerWrapper/ChatAssistantMessageRow 聚合对象 spread）。**交叉核对**：R-03 门禁归 03/T-E（T1 的 check:store-facade 注释改为指向 T-E 轨道与 T14，确认本轨道无门禁脚本残留）；R-05 useExtensionMarket 归 02（§3.2 任务存在且唯一承办，无重复）。同步更新 ① 总任务表/执行链/依赖前置、⑤ 验证与提交、⑥ 风险、附 实读基线（78 文件域分布、裸 button 分布、C-5 三文件 props 实测口径） |

---

## ① 分批总览

### 1.1 总任务表（17 个可派发任务）

| 任务号 | 批次 | 来源步骤 | 内容 | 执行形态 | 单批上限 |
|---|---|---|---|---|---|
| T1 | 批次 3 | 02-A1 | ui barrel 补全 + Menu 10 处直引改道 + check:ui-barrel 门禁 | 基座（一个 Agent） | — |
| T2 | 批次 3 | 02-B1 | Tooltip 迁移批 1：chat-* 域（21 文件） | 机械 + 冒烟 | ≤21 |
| T3 | 批次 3 | 02-B1 | Tooltip 迁移批 2：agent-card/binary-tree/card-panel（9 文件） | 机械 + 冒烟 | ≤21 |
| T4 | 批次 3 | 02-B1 | Tooltip 迁移批 3：settings 全域（22 文件，内拆两子提交） | 机械 + 冒烟 | ≤22 |
| T5 | 批次 3 | 02-B1 | Tooltip 迁移批 4：diff/files/overview（16 文件） | 机械 + 冒烟 | ≤21 |
| T6 | 批次 3 | 02-B1 | Tooltip 迁移批 5：sidebar/shell/workspace（15 文件）+ **旧件退役** | 机械 + 退役 | ≤21 |
| T7 | 批次 3 | 02-B2 波 1 | ui/Button 接管波 1：.ui-btn 全局类 36 文件机械迁移 | 机械映射 | ≤36 |
| T8 | 批次 3 | 02-B2 波 2 | ui/Button 接管波 2 首批：settings 域裸 `<button>` 语义替换 | 语义 + 视觉抽样 | ≤30 |
| T9 | 批次 5 | 02-D1/D2 | 巨型拆分批 1：ModelConfigEditor（866 行）+ useExtensionMarket（623 行，R-05） | 只搬不写 | 2 文件 |
| T10 | 批次 5 | 02-D1/D3 | 巨型拆分批 2：ApprovalAskCard/SidebarContextMenus/ExternalSessionImport/SettingsUsageTab/useSidebarSessionList | 只搬不写 | 5 文件 |
| T11 | 批次 5 | 02-B3 | ui/Switch 新建 + settings 域开关替换（8 消费点） | 语义 + SR 降级验证 | ≤10 |
| T12 | 批次 5 | 02-B6 | ui/TabStrip 提炼 + 6 消费点收敛（能力盘点先行） | 半语义 | ≤8 |
| T13 | 批次 5 | 02-B5/B4 | Select 统一（SettingsSelect 11 消费方）+ Input 统一（settings 域输入面） | 语义 + 机械混合 | ≤15 |
| **T14** | **批次 7.4** | 02-A2（**C-8**） | **store 直引迁移：components/ 78 文件改走 store-access facade（5 批按域聚批，与 03/T-E 门禁基线交接）** | 机械 + 门禁递减 | ≤20 |
| **T15** | **批次 4.0** | 02-E3 改语义（**C-7**） | **ui/ConfirmDialog 基座新建（基于 ui/Dialog 封装确认语义）+ useConfirmGate Promise 桥（契约按 04-detail §2.1.1，供批次 4.1 的 9 文件 window.confirm 替换消费）** | 基座（一个 Agent） | — |
| **T16** | **批次 3.4** | 02-B2 波 2 后续（**C-4**） | **ui/Button 接管波 2 剩余批：128 文件裸 button 的剩余 ~100 文件（内拆 6 子波，按域聚批；目标态「业务层裸 button = 0」）** | 语义 + 视觉抽样 | ≤20/子波 |
| **T17** | **批次 8.0** | 02-C1（**C-5**） | **props 治理：ChatCard（ChatComposer 30 props 展开 → spread）/ChatComposerWrapper（30 props → ribbons 聚合对象）/ChatAssistantMessageRow（28 props 聚合 + 比较器联动）** | 语义（聚合对象） | 3 文件 |

### 1.2 批次内执行链（同文件串行纪律）

**批次 3（T-C-A）执行链**：`T1 → T2 → T3 → T4 → T5 → T6 → T7 → T8 → T16`（接力式，Agent 数 2~3；**C-4 裁决：批次 3.4 的裸 button 剩余批全部波次并入本链，T8 之后由 T16 承接**——不再悬空）。

不可并行理由（实读文件面重叠）：

| 重叠关系 | 证据 |
|---|---|
| T1 ↔ T2~T6 | ComposePlusMenu/ProjectPickerMenu/SkillsMoreMenu/SettingsQuickMenu/SettingsSelect/SidebarContextMenus 6 文件同时是 Menu 直引与旧 Tooltip 消费方（实读 import 双命中）；且 barrel 是迁移的 import 落点，必须先于迁移 |
| T2~T6 ↔ T7 | DiffCard/DiffCardGitActions/DiffCardFileList/ModelConfigEditor/WorkflowList 等文件既 import 旧 Tooltip 又使用 `.ui-btn`（grep 双命中） |
| T7 ↔ T8 | T7 在 settings 域（FontSettingsSection/ExternalSessionImport/Settings*Tab 等）做完 `.ui-btn` 迁移后，T8 的裸 button 语义判定才在"已无全局类"的基线上进行 |

**批次 5（T-C-B）执行链**：`T9 → T10`（巨型拆分）与 `T11 → T12 → T13`（原子件接管）**可并行**（文件面错开：settings-models/ 与 settings/ 域 vs ui/ 新建件与 settings 消费面——ModelConfigEditor 同时在 T9 拆分与 T11 Switch 替换中，**同文件串行：T11 的 Switch 基座先行，T9 拆分时消费已就绪的 ui/Switch**；T12 TabStrip 蓝本 UnitSessionTabStrip 亦在 T5 Tooltip 批中已迁移，无冲突）。

批次 3 与批次 4（T-D-A，08 方案）的关系：批次 4 的 4.3 无名称按钮 aria 补齐**必须在批次 3 的 T7/T8/T16 之后**（R-07 串行，见 ④）；批次 4 的 **4.0（ui/ConfirmDialog 基座，本轨道 T15）先行于 4.1**（08 轨道 9 文件 window.confirm 替换消费的基座前置，R-02/C-7；T15 文件面仅 ui/Dialog 同目录新建件 + barrel + useConfirmGate，与 4.2/4.3 错开）。

批次 3 与批次 2（T-B 样式基线）的关系：T-B 的 01-S0/S1/S2/S3-任务1（primary 定案 + --accent-inverted token）必须全部先行；**T7 的变体映射表以 01-S3 定案后的 primary 为基准**（R-08）。

**批次 7.4（T14，store 直引迁移，C-8）执行链**：依赖前置 = 05-detail（T-E）批次 5 已入库 `check-store-facade.mjs` + 基线（78 文件红基线可复现）；T14 按域分批（5 批 ≤20 文件/批）逐批迁移，每批 `npm run check:store-facade` 核对违规数递减；**迁移归零后同批由 T-E 完成 CI 接线**（05-detail 提交 G 阶段 3），不跨批悬挂。与批次 7.1~7.3（T-G 工程化）文件面错开（components/** vs .github/vite/tauri）可并行。

**批次 8.0（T17，props 治理，C-5）执行链**：T17 先行聚合 props → T-H（08 轨道）在其上做渲染优化（同文件串行：MessageContent.tsx / ChatMessageList.tsx 由 8.0 先行——master plan §1 T-C↔T-H 重叠点）；08-detail T4.3 的「比较器面在 02-C1 props 聚合后收窄」依赖本任务，T4.3 其余类型级穷尽/清单测试自成闭环不阻塞。

### 1.3 依赖前置清单（批次 3 开工前必须为真）

1. 工作区 `git status` 干净（R-10：messageSnapshotsBridge.ts 脏状态已由批次 0 清理；派单前复核无 M 标记）。
2. 01-S0 已完成：`--tooltip-translate` 静态 fallback 由 01-S0 承办（R-01 裁决），T2 基座就绪只做"确认已修复 + 双份合并时保留 fallback"，**不再重复修样式**。
3. 01-S3-任务1 已完成：primary 语义定案（深炭/蓝/反相/红四套收敛为 1 套 + accent/danger 变体）。
4. `npm run check:ui-layer` 现态通过（依赖门禁基线绿）。

**T14 前置（批次 7.4 开工前）**：① 05-detail 批次 5 已落地 `check-store-facade.mjs` 且 `--baseline` 基线（78 文件）已入库、红基线本地可复现；② 本任务各批涉面域的重构（T9/T10 拆分、T16 按钮接管）已合入（**纯读面 selector 替换可先行**，结构面等本域重构——同文件串行）。

**T15 前置（批次 4.0 开工前）**：① ui/Dialog 已具备契约能力（role:'alertdialog'、initialFocusRef、dismissible、showCloseButton、footer、description、Esc 栈 dialogStack——实读已有，无前置依赖）；② 04-detail §2.1.1 契约文本为验收基线；③ 01-S3 primary 定案已合入（danger 变体按钮色依赖）。

**T16 前置（T8 之后接力）**：① T8 已完成 settings 域首批并输出该域剩余清单（grep 实测）；② T7 的 .ui-btn 迁移已合入（裸 button 判定在"已无全局类"基线上进行）；③ 01-S3 已合入（同 T8）。

**T17 前置（批次 8.0 开工前）**：① 本任务三文件所在域的 T2~T6/T16 接管已合入（chat-* 域旧 Tooltip 已迁移、裸 button 已清零，props 聚合面干净）；② 08-detail T4.3 的类型级穷尽清单已登记（聚合前后字段一一核对用）。

---

## ② 各接管任务

### 2.1 T1：ui barrel 补全 + Menu 直引改道 + check:ui-barrel 门禁（批次 3，基座）

**现状（实读）**：`apps/crish-desktop/src/components/ui/index.ts` 共 12 行，仅导出 `Dialog` + `Tooltip`（含 props 类型）。ui/ 目录实际 6 组件：Button/Dialog/Input/Menu/Select/Tooltip。ui/Menu 自带目录出口 `ui/Menu/index.ts`（导 Menu + MenuProps + SelectOptionItem + position 类型），业务层绕过全量 barrel 直引该目录出口。

**改动 1：index.ts 补全导出（目标形态）**

```ts
export { Dialog } from './Dialog/Dialog';
export type { DialogProps, DialogSize, DialogRole } from './Dialog/Dialog';
export { Tooltip } from './Tooltip/Tooltip';
export type { TooltipProps, TooltipSide } from './Tooltip/Tooltip';
export { Button } from './Button/Button';
export type { ButtonProps, ButtonVariant, ButtonSize } from './Button/Button';
export { Input } from './Input/Input';
export type { InputProps, InputVariant, InputSize } from './Input/Input';
export { Menu } from './Menu/Menu';
export type { MenuProps } from './Menu/Menu';
export type { SelectOptionItem } from './Menu/types';
export { Select } from './Select/Select';
export type { SelectProps, SelectOption } from './Select/Select';
```

> 说明：`ui/Menu/index.ts` 目录出口保留（不删除，供 ui/Select 等目录内引用及类型直引）；业务层改走 `'../ui'` 全量 barrel。

**改动 2：Menu 直引改道（10 个生产文件，实读清单）**

| # | 文件 | import 行 | 改后 |
|---|---|---|---|
| 1 | `components/chat-card/ProjectPickerMenu.tsx` | :17 `import { Menu } from '../ui/Menu';` | `'../ui'` |
| 2 | `components/chat-card/ChatHeaderMore.tsx` | :4 | `'../ui'` |
| 3 | `components/chat-composer/ComposePlusMenu.tsx` | :12 | `'../ui'` |
| 4 | `components/chat-composer/PermissionModeMenu.tsx` | :5 | `'../ui'` |
| 5 | `components/provider/ModelBadgePickerMenu.tsx` | :7 | `'../ui'` |
| 6 | `components/settings-models/ModelsSettingsTab.tsx` | :8 | `'../ui'` |
| 7 | `components/settings-skills/SkillsMoreMenu.tsx` | :14 | `'../ui'` |
| 8 | `components/settings/SettingsQuickMenu.tsx` | :18 | `'../ui'` |
| 9 | `components/settings/SettingsSelect.tsx` | :5 | `'../ui'`（该文件在 T13 退役，届时随删） |
| 10 | `components/sidebar/SidebarContextMenus.tsx` | :12 | `'../ui'` |

类型直引 `import type { SelectOptionItem } from '../ui/Menu/types'`（SettingsSelect.tsx:6 等）与 `'../ui/Menu'` 同改 `'../ui'`（barrel 已导出该类型）。测试文件（ComposePlusMenu.test.tsx/PermissionModeMenu.test.tsx/ModelBadgePickerMenu.test.tsx/SettingsQuickMenu.test.tsx/SettingsSelect.test.tsx/AddProviderMenu.test.tsx/SkillsMoreMenu.test.tsx/SidebarContextMenus.test.ts）同步改，一并计入本任务完成判据 grep。

**改动 3：check:ui-barrel 门禁**

- 新建 `scripts/check-ui-barrel.mjs`（或扩展 `scripts/check-ui-layer.mjs` 为两个检查段——建议独立脚本保持职责单一，仿 `check-ui-layer.mjs` 模式：收集 `ui/` 下所有含组件文件名的子目录（排除 index.ts 自身、非组件文件），逐一断言 `ui/index.ts` 有对应 `export { X }`；新增 `ui/` 子目录未进 barrel 即红）。
- 接入 `package.json` 根 scripts：`"check:ui-barrel": "node scripts/check-ui-barrel.mjs"`，并并入 `check:ui-layer` 执行链（`"check:ui-layer": "node scripts/check-ui-layer.mjs && node scripts/check-ui-barrel.mjs"`）。
- 脚本入库（AGENTS.md 测试资产铁律：立即 git add 提交，不留未跟踪状态）。
- 注：check:store-facade 门禁**归 T-E 轨道（05-state-governance-detail，R-03/C-8 裁决：脚本 + 基线 + CI 接线由 03/T-E 承办）**，本任务（T1）不实现；其消费点迁移面由本轨道 **T14（批次 7.4）** 承办——本文件无门禁脚本残留。

**完成判据**：barrel 导出 6 组件 + 类型；`rg "from '.*ui/Menu['\"]"` 生产代码 = 0；`npm run check:ui-barrel` 对"漏导新组件"能红（负向用例：临时移除一行导出后断言退出码 1）；typecheck 绿。

### 2.2 T2~T6：Tooltip 迁移 5 批 + 旧件退役（批次 3，R-01 口径）

**消费面（实读基线）**：83 个直引文件（80 处 `import { Tooltip } from '../Tooltip'` + 3 处 `from '../../Tooltip'`：`sidebar/session-list/GeneralSection.tsx:8`、`ProjectsSection.tsx:7`、`SessionRow.tsx:20`）+ 4 个已走 barrel 的消费点（RunHistoryList/ScheduledTasksPanel/WorkflowList/WorkflowForm，不动）≈ **87 个消费文件**。方案口径 85（审计 88）差异为统计时点与口径（含 SettingsSelect.tsx 自身、测试），批次边界按实读清单执行。

**替换模式（机械，全批一致）**

```
components/<域>/<文件>.tsx:   import { Tooltip } from '../Tooltip';   →   import { Tooltip } from '../ui';
components/sidebar/session-list/<文件>.tsx:  from '../../Tooltip'  →  from '../../ui'
```

- 若消费文件同时 import 其他 ui 件（如后续 T7 后 import Button），统一合并到同一 `'../ui'` 语句。
- 类型 import（`TooltipProps`/`TooltipSide`）同步改道——新件同签名导出（ui/Tooltip/Tooltip.tsx:53-61）。

**新旧 Tooltip props 映射表（实读核对）**

| 维度 | 旧（components/Tooltip/Tooltip.tsx，150 行） | 新（ui/Tooltip/Tooltip.tsx，314 行） | 兼容性 |
|---|---|---|---|
| content | `React.ReactNode` 必填（:27） | `React.ReactNode` 必填（:56） | ✅ 签名一致 |
| children | `React.ReactElement` 必填（:28） | `React.ReactElement` 必填（:57） | ✅ 签名一致 |
| side | `'top'\|'bottom'\|'left'\|'right'`（:24） | 同（:53） | ✅ 联合类型一致 |
| disabled | `boolean` 默认 false（:69） | `boolean` 默认 false | ✅ 一致 |
| delayHide | `number` 默认 0（:70） | `number` 默认 0 | ✅ 一致 |
| ref | forwardRef + useMergeRefs 合并子元素 ref（:98） | forwardRef + useMergeRefs 合并（:43-51） | ✅ 一致 |
| restProps 透传 | cloneElement 透传 `...restProps` + onMouseEnter/onMouseLeave 手写转发（:106-130） | cloneElement 透传全部 restProps + focus/blur 触发（:284-292 附近） | ✅ 透传面相同（03 评审曾标注"旧版仅 ref"，实读旧版 :124-130 亦有 restProps 透传——两边一致，非机械点缩小） |
| 键盘触发 | 无（仅 hover） | focus/blur 触发（delayHide 尊重） | ⚠️ **行为收益**：可聚焦触发器（按钮/链接）Tab 聚焦即显示 |
| aria | 无 role/aria（全文无） | role="tooltip" + aria-describedby 关联触发元素 | ⚠️ 行为收益：SR 播报"按钮名 + 说明" |
| 定位 | 固定 gap 8 + translate（无钳位） | 视口钳位 computeClampedPosition + scroll/resize 跟随 | ⚠️ **潜在微移**：贴边触发器（视口边缘）的 tooltip 位置可能与旧版不同 |

**机械/语义判定**：90% 文件为纯 import 替换（零行为差异）。**两类需语义复核**：
1. **依赖子元素 props 注入的消费点**：cloneElement 透传 restProps 与子元素自身 onMouseEnter/onMouseLeave 合并逻辑两边相同，但新件的 restProps 处理需逐文件核对"子元素是否携带自定义 props 注入"（03 评审口径：预计个位数文件，如 SettingsQuickMenu 的 btnRef 场景——旧件 :91-93 注释自证该机制是"系统化修复"，新件文件头注释同样保留，行为同源）。
2. **disabled/content 早退**：旧件 :100 `if (disabled || !content) return children;`——新件同语义（基座注释自证 API 不变），无差异。

**分批清单（5 批，每批独立提交）**

| 批 | 域 | 文件清单（21/9/22/16/15） | 备注 |
|---|---|---|---|
| T2 批 1 | chat-*（21） | chat-card 10：ChatHeaderControls/ChatHeader/ChatEmptyState/UnitChromeActions/ApprovalDock/PlanGoalRibbons/ChatStatusRibbons/RunNoticeBar/ProjectPickerMenu/ChatMsgFilterBar；chat-composer 7：TiptapComposerField/ComposerField/ComposePlusMenu/ComposerAttachmentBar/ChatQueuePanel/ChatComposer/PermissionModeMenu；chat-message-list 1：MessageVirtualizer；chat-message-row 2：MessageActionsBar/ChatUserMessageRow；chat-tool-call 1：ToolCallHeader | 键盘冒烟抽样 2 处（MessageActionsBar、ChatHeaderControls 图标按钮） |
| T3 批 2 | agent-card/binary-tree/card-panel（9） | agent-card 6：AgentCard/AgentBrowsePad/AgentStatusChip/AgentTeamBoard/ApprovalAskCard/InlineAgentPanel；binary-tree 2：UnitSessionTabStrip/LeafToolTabStrip；card-panel 1：CardPanelHeader | 冒烟抽样 AgentCard（daemon 状态 tooltip） |
| T4 批 3 | settings 全域（22，两子提交） | 子提交 A（13）：settings/ 11（SettingsProfileTab/SettingsQuickMenu/SettingsRulesTab/SettingsSecurityTab/SettingsSelect/SettingsShortcutsTab/SettingsUsageTab/StatusDiagnosticsPanel/UserViewDebugPanel/ExternalSessionImport/FontSettingsSection）+ settings-models 2（ModelConfigEditor/ModelProfileList）；子提交 B（9）：settings-skills 5（SkillsSettingsTab/SkillsMoreMenu/SkillEditorModal/SkillDetailPreview/SkillCardList）+ settings-mcp 3（McpServerForm/McpServerList/McpSettingsTab）+ settings-extensions 1（ExtensionCard） | 冒烟抽样 SettingsSecurityTab 开关行 tooltip；ModelConfigEditor 行号按实测重定位（文件已 866 行） |
| T5 批 4 | diff/files/overview（16） | diff 5：ChangeOverviewCard/DiffCard/DiffHeaderControls/DiffCardGitActions/DiffCardFileList；files 6：FilePreview/FileViewerCard/FileTreeView/FileBreadcrumb/FileActions/FilesCard；overview 5：ProgressSection/OverviewQuickActions/OverviewHeader/ChangesSection/AgentSection | 冒烟抽样 DiffCard 行内操作按钮；该批与 T7 文件面重叠（DiffCard 系含 .ui-btn），**T5 先于 T7** |
| T6 批 5 | sidebar/shell/workspace（15）+ 退役 | sidebar 2：SidebarContextMenus/SidebarFooter；session-list 3：GeneralSection/ProjectsSection/SessionRow；shell 1：GlobalSessionTabBar；workspace 9：WorkspaceStrip/PreviewToolbar/PreviewHistoryPanel/PreviewCard/Workspace/TrashSection/SessionStrip/ApprovalSection/BgTasksSection | 本批完成后立即执行退役步骤 |

**退役步骤（T6 内收尾，批次 3 验收动作）**
1. grep 复核旧 import 清零：`rg "from '.*Tooltip'"` 仅命中 ui/ 自身与 barrel 消费（4 文件）与测试。
2. 删除 `components/Tooltip/` 整目录（Tooltip.tsx 150 行 + Tooltip.module.css）。
3. 删除 `hooks/useAnimatedPresence.ts`（唯一消费者为旧 Tooltip 的 :3/:77；ui/Dialog/useAnimatedPresence.ts 为独立实现，ui/Tooltip 引用后者——实读确认）。
4. 旧 Tooltip 内复制份 useMergeRefs/setRef 随旧件消亡；旧 Tooltip 单测（如有）同步移除（迁移不删测试——若存在"随组件迁移"的测试，移植为 ui/Tooltip 测试，实读 ui/Tooltip 已有测试则仅删旧件测试）。
5. `hooks/useAnimatedPresence` 删除后跑全量 vitest 确认无悬空引用。

**完成判据**：`rg "components/Tooltip"` 生产代码 = 0；目录不存在；`hooks/useAnimatedPresence.ts` 删除且 grep 无引用；每批键盘冒烟 100% 通过（Tab 聚焦 → tooltip 出现；Shift+Tab 离开 → 消失）；typecheck 绿。

### 2.3 T7：ui/Button 接管波 1 —— .ui-btn 全局类机械迁移（批次 3）

**现状（实读）**：`.ui-btn` 体系在 `styles/shell/shell-polish.css:18-86`（primary/secondary/ghost × sm/md + block，原 danger 死类已删）。grep 命中 **37 个文件**（含 ui/Button/Button.tsx 自身注释引用 1 个），业务消费 **36 个**。ui/Button（Button.tsx，95 行）`variant: 'primary'|'secondary'|'ghost'|'danger'`、`size: 'sm'|'md'`、`icon?`、`loading?`、`block?`，forwardRef，**当前零业务消费**。

**前置**：01-S3 primary 定案已完成（R-08 依赖）。`--tooltip-translate` 与 `.ui-btn` 段退役不在此任务（前者归 01-S0 已完成、后者归 01-S3 收尾，本任务只迁消费点）。

**类名 → 变体映射表（1:1 机械）**

| `.ui-btn` 类名组合 | Button props | 说明 |
|---|---|---|
| `ui-btn ui-btn-primary` | `<Button variant="primary">` | 无 size 类默认 md |
| `ui-btn ui-btn-secondary` | `<Button variant="secondary">` | |
| `ui-btn ui-btn-ghost` | `<Button variant="ghost">` | |
| `ui-btn ui-btn-primary ui-btn-sm` | `<Button variant="primary" size="sm">` | |
| `ui-btn ui-btn-sm`（无变体类） | `<Button size="sm">`（variant 默认 primary） | ⚠️ 需核对语义：裸 `ui-btn ui-btn-sm` 出现时确认原样式归属（shell-polish.css 默认态），映射表评审时逐处确认 |
| `ui-btn-block` | `block` | |
| `ui-btn ... disabled` | `disabled` | Button 内部处理 disabled；`.ui-btn` 无 disabled 规则 vs Button 有 opacity——**以 Button 为准**（01 P2-9），视觉微差入抽样 |
| `ui-btn` + 私有 module 类混用 | `className` 保留追加 | 替换时**只改 `className="ui-btn ..."` 段与标签名，其余属性行（aria-*/type/data-*/onClick）不动**（03 评审 ④.3 红线） |

**文件清单（36 个业务文件，实读）**

- chat-composer 1：ComposerAttachmentBar
- diff 2：DiffCard/DiffCardGitActions
- overview 1：ActiveTasksSection
- settings 15：ExternalSessionImport/FontSettingsSection/RulesEditorDialog/RunHistoryList/ScheduledTasksPanel/SettingsAppearanceTab/SettingsPersonalizeTab/SettingsProfileTab/SettingsRulesTab/SettingsScheduleTab/SettingsSecurityTab/SettingsUsageTab/StatusDiagnosticsPanel/UserViewDebugPanel/WorkflowForm
- settings-extensions 2：ExtensionCard/ExtensionList
- settings-mcp 1：McpServerForm
- settings-models 1：ModelConfigEditor
- settings-skills 3：SkillCardList/SkillDetailPreview/SkillEditorModal
- workspace 3：ApprovalSection/PlansSection/TrashSection
- 其他 4：AppErrorBoundary/WorkflowList/SettingsExtensionsTab/SkillsMoreMenu

> 注：`SettingsExtensionsTab`/`SkillsMoreMenu`/`WorkflowList` 与上表域归类按实读路径重排；清单以 grep 实测为准（03 评审口径 42 文件含 css/Button.tsx 自身，业务 36~38 个，执行时 `rg -l "ui-btn" --glob "*.tsx"` 复核）。

**完成判据**：业务层 `rg "ui-btn"` = 0（仅 shell-polish.css 定义段 + Button.tsx 注释命中）；每批视觉回归抽样 3~5 按钮无差异；typecheck 绿；`npm run check:ui-layer` 绿。

**扩展点说明（写进 Button.tsx 文件头注释）**：
- 新增形态：先扩 `ButtonVariant` 联合类型，再全量对齐映射表与 CSS Modules（穷举而非开放字符串）。
- 何时用 className 覆盖：**只允许改布局类（间距/尺寸微调）**，禁止覆盖颜色/背景语义（颜色归 tokens）；违背该纪律的消费点在评审中打回。
- icon 插槽承载图标；icon-only 形态（aria-label 强制）见 T8。

### 2.4 T8：ui/Button 接管波 2 首批 —— settings 域裸 `<button>` 语义替换（批次 3）

**现状**：全仓 128 个组件文件含裸 `<button>`；本批只做 settings 域首批（约 20~30 文件）。**剩余波次由 T16（批次 3.4）承接——C-4 裁决定案，执行缝隙关闭**（原 ⑥ 风险 5 撤销，见 2.10）。

**语义判定规则表（评审用，逐按钮对表）**

| 特征 | 判定 |
|---|---|
| 图标 × 无文字 × 无 aria-label | `iconOnly` 形态 + **aria-label 必填**（R-07：16 个无名称按钮中位于本批文件的先补） |
| 红/删除/清空/撤销危险语义（onClick 名含 delete/remove/clear/reset + Trash2 等 icon） | `variant="danger"` |
| hover 淡染、无边框低强调（class 含 ghost/link/icon-btn 且非危险） | `variant="ghost"` |
| 填充主色、表单主操作（onClick 名含 save/submit/apply/confirm） | `variant="primary"` |
| 其余（中性填充/描边） | `variant="secondary"` |
| 内含 spinner + 异步态 | 加 `loading`（文案「动词+中…」约定，08 P2-9 一并解决） |
| `role="tab"` 的 tabClose 按钮 | **保持原生按钮，不替换**（归 T12 TabStrip 收敛） |
| 图标-only 尺寸各异（6+ 种手写尺寸） | 统一 iconOnly 形态（新增 Button 形态，size 语义对齐 control-height-sm） |

**替换红线**：保留已有 aria-label/aria-pressed/type/data-*/role 属性（只改标签名与 className 段）；`type="button"` 由 Button 默认值保证（Button.tsx:58）。

**验证**：每批 3~5 按钮截图对比（tests/visual/ 基线，若 T-B 已建 8 组件基线则直接复用）；aria-label 补齐计入本批判据。

### 2.5 T11：ui/Switch 新建 + settings 域开关替换（批次 5）

**基座就绪（新建）**：`components/ui/Switch/Switch.tsx` + `Switch.module.css` + 进 barrel + 单测。
- API 契约（最小面，扩展点在下方）：

| prop | 类型 | 默认 | 说明 |
|---|---|---|---|
| checked / defaultChecked | boolean | — | 受控/非受控双模（对齐 ui/Menu 惯例） |
| onCheckedChange | (checked: boolean) => void | — | 选中变更回调 |
| label | ReactNode | — | 前缀说明文案（或 aria-label） |
| disabled | boolean | false | |
| size | 'sm' \| 'md' | 'md' | 对齐 control-height 系列 |
| className | string | — | 布局微调 |

- a11y 契约：`role="switch"` + `aria-checked` + 键盘 Space/Enter 切换 + label 关联；thumb 平移用 `--transition-*`、圆角 `--radius-full`（tokens，不写死）。
- **不做**：三段式/多态开关（用 Radio/Select）、开关组整体校验（表单层职责）、视觉皮肤变体（颜色归 tokens）。

**替换清单（8 消费点，实读）**

| # | 文件:行 | 现状 | 处理 |
|---|---|---|---|
| 1 | `settings/SettingsSchemaRenderer.tsx:81` | `settings-switch settings-switch--personalize` 全局类 | 机械映射 → `<Switch>` |
| 2 | `settings/SettingsSchemaRenderer.tsx:213` | aria-pressed button 变体 | 语义升级 → `<Switch>`（SR 播报从「按下」变「开关」） |
| 3 | `settings/SettingsSecurityTab.tsx:370` 附近 | aria-pressed button | 语义升级 |
| 4 | `settings/SettingsShortcutsTab.tsx:457` 附近 | aria-pressed button | 语义升级 |
| 5 | `settings/SettingsAppearanceTab.tsx` | aria-pressed button | 语义升级（行号执行时 grep 定位） |
| 6 | `settings-models/ModelConfigEditor.tsx:668` | 私有 toggleThumb 结构 | 结构重写 → `<Switch>`（随 T9 拆分同步，见 ③） |
| 7 | `settings-models/ModelConfigEditor.tsx:529` | cap 开关（`addDraft.caps[opt.key]`） | 结构重写 |
| 8 | `agent-card/InlineAgentPanel.tsx` | aria-pressed agent 开关 | 语义升级（**不在 settings 域，随 T3 或本批顺手完成，标注于行为变更点清单**） |

**退役**：`settings-switch` 全局类删除（settings-base.css）；各私有 thumb 样式删除。

**完成判据**：全仓 `role="switch"` 唯一来源 = ui/Switch（grep 复核）；`settings-switch` grep = 0；ui/Switch 单测全绿（键盘交互/受控非受控/aria 断言）；3 个代表性开关人工验证（SchemaRenderer 个性化开关、SecurityTab 开关、ModelConfigEditor cap 开关）——**SR 播报无 NVDA 环境时降级为 Playwright aria 快照断言 + 键盘走查**（03 评审 P1-1 降级路径）。

### 2.6 T12：ui/TabStrip 提炼 + 6 消费点收敛（批次 5）

**蓝本**：UnitSessionTabStrip（实读 505 行，能力最全：React.memo + 拖拽 + roving tabindex + Arrow/Home/End/Delete + aria-selected :433 + a11y 专项测试 3 套）。

**能力盘点表（迁移前必填，验收物之一）**

| 消费点 | 拖拽 | 关闭钮 | 溢出滚动 | memo | 上下文菜单 | 键盘漫游 | 差异格处置 |
|---|---|---|---|---|---|---|---|
| UnitSessionTabStrip（蓝本） | ✅ | ✅ | — | ✅ | — | ✅ | 能力并基座后删除 |
| LeafToolTabStrip | 同域轻量 | ✅ | — | — | — | ⚠️ 无 roving（08 P3-3） | 同域双件合一，顺手修 role=tab 无 roving |
| GlobalSessionTabBar | ✅ | ✅ | — | — | ✅ 全局上下文 | ✅ | 最复杂，最后接；全局上下文降级「TabStrip + 业务封装层」组合，不扩基座 props |
| SessionStrip | — | — | — | — | — | ⚠️ 无漫游 | 最小接入，补齐键盘漫游 |
| WorkspaceStrip | — | ✅ | — | — | — | — | 简单接入 |
| SettingsTablist | — | — | — | — | — | ⚠️ 导航语义 | 无关闭、静态项，renderTab 消化 |

**基座 API 契约（最小面）**：`tabs`（数据模型）、`activeId`、`onActiveChange`、`onClose?`；可选：`renderTab` 插槽（关闭钮/badge/拖拽手柄）、拖拽 `enabled` 开关、溢出滚动开关。
**不做**：垂直 tab/侧边导航（另行组件）、tab 内嵌复杂工具栏（组合而非扩 prop）、拖拽领域算法（域内 hook，基座只给插槽位）。

**迁移顺序（2 批，按复杂递增）**：批 A：SessionStrip + WorkspaceStrip + SettingsTablist → 批 B：UnitSessionTabStrip + LeafToolTabStrip（同域合一）→ GlobalSessionTabBar（最后）。每消费点视觉回归。

**完成判据**：全仓 `role="tab"` 来源 = ui/TabStrip 一处；6 个自研实现删除（含蓝本并入后删除）；能力盘点表完成；键盘漫游缺失面清零（SessionStrip/LeafToolTabStrip）；3 套 a11y 专项测试移植为 ui/TabStrip 测试（测试随组件迁移，AGENTS.md 铁律）。

### 2.7 T13：Select 统一 + Input 统一（批次 5，R-09 口径）

**13a：SettingsSelect → ui/Select（11 消费方，R-09 修正）**

现状（实读）：SettingsSelect.tsx（181 行）接口 = `{ value, options: SettingsSelectOption[], onChange(value), disabled?, placeholder?, maxHeight=280, className?, footer?, trailing?, onOpen?, valuePreviewFamily? }`；`SettingsSelectOption = { value, label, group?, previewFamily?, hint? }`。ui/Select（Select.tsx，202 行）接口 = `{ value?: string|null, onChange(value), options: SelectOption[], placeholder?, disabled?, error?, label?, size?, id?, className?, align?, side? }`；`SelectOption = { id, label, icon?, disabled? }`。

**差异映射表（逐项核对签字）**

| 维度 | SettingsSelect | ui/Select | 处置 |
|---|---|---|---|
| 选中值 | `value: string` 必填 | `value?: string \| null` | 兼容（受控传值） |
| 回调 | `onChange(value)` | `onChange(value)` | ✅ 一致（02 方案所称 onSelect 命名差异实读不存在） |
| 打开回调 | `onOpen()` | 无暴露（Menu 基座内部 onOpenChange） | ⚠️ 11 消费方 grep 无人用 onOpen → 直接忽略，登记"能力未消费不迁移" |
| 数据模型 | `value/label/group/previewFamily/hint` | `id/label/icon/disabled` | ⚠️ `value→id` 逐消费方转换；`group/previewFamily/hint` 为 SettingsSelect 独有能力 |
| 面板能力 | maxHeight/footer/trailing | 无 | ⚠️ 仅 FontSettingsSection 用 footer+maxHeight（:313/:349 附近），Diff 域只用基础面（实读 DiffHeaderControls:145-155、DiffCardFileList:206 均 value/options/onChange/disabled/className） |
| 独有 | — | error/label/size/align/side/id | 不强制用，空置 |

**能力差异处理决策**（需要评审或主控裁决的点，标注不确定）：
1. `group`（分组选项）：grep 11 消费方中 Diff 域的 branches 分组场景——若真实使用则 ui/Select 需补 group 支持（renderOption 插槽消化），否则仅做 value→id 映射。**执行前先 grep `group:` 在 11 文件的命中数**，≥2 处才扩基座（原则二），否则该字段在转换时丢弃并登记。
2. `previewFamily`（字体预览，FontSettingsSection 专属）：**不升格 ui/Select**（单消费点专属形态 → 业务封装层用 renderOption 或在 FontSettingsSection 内组合），登记"业务封装"。
3. `footer`/`trailing`（FontSettingsSection 自定义 header）：同 2，业务封装。
4. 按钮面板宽度贴合：SettingsSelect 有 `[140,220]` 钳制测量（:33-37 注释），ui/Select 由 Menu 基座决定——观感可能微变，FontSettingsSection 视觉回归重点项。

**消费方清单（11 个生产文件，实读）**

| # | 文件 | 使用处 | 备注 |
|---|---|---|---|
| 1 | `settings/FontSettingsSection.tsx` | :313 / :349 | footer+maxHeight+previewFamily，**语义最重** |
| 2 | `settings/WorkflowForm.tsx` | :102 | |
| 3 | `settings/SettingsSecurityTab.tsx` | :208 | |
| 4 | `settings/SettingsSchemaRenderer.tsx` | :91 / :193 | 两处 |
| 5 | `settings/SettingsRulesTab.tsx` | :147 | |
| 6 | `settings-skills/SkillsSettingsTab.tsx` | :172 | |
| 7 | `settings-mcp/McpServerForm.tsx` | :50 | |
| 8 | `diff/DiffHeaderControls.tsx` | :145 / :155 | 基础面 |
| 9 | `diff/DiffCardFileList.tsx` | :206 | 基础面 |
| 10 | `components/WizardModelStep.tsx` | :59 | 根 components/ 下（import 路径 `./settings/SettingsSelect`） |
| 11 | `components/WizardKeyStep.tsx` | :49 | 同上 |

**退役**：删除 `components/settings/SettingsSelect.tsx` + `SettingsSelect.module.css`（含 settingsSelectMenu 样式，01 菜单壳收敛面同步缩小）+ `SettingsSelect.test.tsx`（若断言迁移到 ui/Select 测试则保留——**测试资产铁律：迁移不删测试**，将既有断言移植进 ui/Select 测试）。

**完成判据**：`rg "SettingsSelect"` 生产代码 = 0；ui/Select 消费数 = 11；5 个代表点行为人工验证（打开/选择/关闭/Esc/外点关闭：FontSettingsSection 字体、McpServerForm、DiffHeaderControls 分支、WizardModelStep、SettingsRulesTab）；回调语义核对表签字。

**13b：Input 统一（settings 域输入面）**

现状：ui/Input（Input.tsx，204 行）`variant: 'text'|'search'|'password'`、`size`、`label`、`hint`、`error`、`clearable`、`prefixIcon`、`suffix`，forwardRef，零业务消费。目标：settings 域 `settings-field-input` 全局类（settings-base.css:86-154）与各 tab 私有输入改 ui/Input。
- 文件面：settings 域约 15~20 文件（SettingsSchemaRenderer 表单渲染、各 tab 表单），分 2 批，每批 ≤10。
- 机械/语义：全局类输入机械映射；私有输入逐点对齐 label/error/hint 结构（部分语义：表单校验展示结构不一，统一为 ui/Input 的 label+error 约定）。
- 退役：`settings-field-input` 全局类段删除。
- **边界**：textarea 场景明确保留 ComposerField 轨（textarea/tiptap 双轨收敛属编辑器专项，本任务不承接）。
- 完成判据：`settings-field-input` grep = 0；ui/Input 消费数 ≥ 15；每批 3 个表单聚焦视觉回归（focus-ring 一致性）。

### 2.8 T14：store 直引迁移（批次 7.4，02-A2，C-8）

**现状（实读）**：components/ 下 **78 个非测试文件直引 store/**（rg 实测 2026-08-09，`from '../store/...'` / `'../../store/...'` / `'@/store/...'` 命中 components/ 生产代码；口径与 05-detail §0-4 一致）。域分布（实测）：

| 域 | 文件数 | 域 | 文件数 |
|---|---|---|---|
| diff | 10 | card-panel | 4 |
| sidebar | 9 | chat-message-list | 4 |
| chat-card | 8 | binary-tree | 4 |
| agent-card | 7 | components/ 根 | 2 |
| chat-tool-call | 6 | chat-message | 2 |
| settings | 6 | files | 1 |
| workspace | 5 | settings-skills | 1 |
| overview | 5 | | |
| chat-message-row | 4 | **合计** | **78** |

**分批策略（5 批，每批 ≤20 文件，按域聚批）**：

| 批 | 域面 | 预算 | 备注 |
|---|---|---|---|
| 批 1 | diff 10 + files 1 + overview 5 | 16 | 读面最重（DiffCard 系） |
| 批 2 | sidebar 9 + card-panel 4 + binary-tree 4 | 17 | 与 T10 拆分（SidebarContextMenus）串行：**结构面等拆分合入** |
| 批 3 | chat-card 8 + chat-message-row 4 + chat-message-list 4 + chat-message 2 | 18 | |
| 批 4 | agent-card 7 + chat-tool-call 6 + components/ 根 2 | 15 | 与 T9 拆分（ApprovalAskCard/useSidebarSessionList）串行：等合入 |
| 批 5 | settings 6 + settings-skills 1 + workspace 5 | 12 | 与 T9/T13 面交叉，最后批 |

**每批文件清单原则**：
1. **按域聚批**：同域文件同批，域间无依赖可稳定并行；单域超过 20 时域内按「读面 → 结构面」拆子批。
2. **纯读面先行**：只读 selector/state 选择的消费点（`useXxxStore((s) => s.xxx)` 取值）首波替换，改走 `api/store-access` facade / `store/index` barrel / `store/types`（类型导入）——即 05-detail ④ 白名单三入口；**涉及组件结构变动的迁移显式等待本域重构落地**（T9/T10 拆分、T16 按钮接管后同文件串行）。
3. **只换道不重构**：import 路径与取值路径为唯一改动面，不借机改行为/样式/memo；回调语义、订阅粒度保持等价（组件级整表订阅的收窄属 05 轨道 C15 顺带项，不在本任务）。
4. 测试文件（若有直引）一并换道，计入每批判据。

**与 03 门禁脚本的交接（05-detail §4.3，口径一致：02 承办迁移、03/T-E 只做门禁）**：

| 阶段 | 责任方 | 内容 | 触发 |
|---|---|---|---|
| 1. 脚本就绪 | T-E（批次 5） | check-store-facade.mjs + 基线（78 文件）入库 | **本任务开工硬前置**（脚本是迁移的度量工具） |
| 2. 迁移执行 | **本任务（T14，批次 7.4）** | 5 批逐批换道；每批跑 `npm run check:store-facade` 核对违规数**单调递减**（78 → 62 → 45 → …） | 每批独立提交 |
| 3. 清零接线 | T-E（05-detail 提交 G 阶段 3） | 违规归零 → 基线置 0/删除 → **CI 快层接线**（master plan 7.4：迁移归零后同批完成） | T14 末批提交后主控触发 |

**每批验证**：`npm run check:store-facade` 违规数递减断言；typecheck 绿；该批域页面冒烟（打开对应页/交互主路径无异常）；行为等价核对表（换道前后取值源一致）签字。

**完成判据**：components/** 生产代码 store 直引 = 0（或全部命中白名单：store/index barrel / storeAccess / store/types）；check-store-facade 违规归零；CI 接线同批完成（与 05-detail 提交 G 阶段 3）；`rg "from '.*store/" components/**`（非白名单）零命中。

### 2.9 T15：ui/ConfirmDialog 基座 + useConfirmGate 桥（批次 4.0，02-E3 改语义，C-7）

**背景（R-02 修订，C-7 裁决）**：02-E3 由「删除」改语义为「**创建 ui/ConfirmDialog 基座**」——删除的仅为原迁移执行面（与 08 轨道的重复面）；基座由本任务实现，**排批次 4.0，先行于批次 4.1**（08 轨道 9 文件/10 调用 window.confirm 替换消费，不自造基座）。契约按 **04-detail §2.1.1**（04 声明、本任务照此实现与验收）。

**契约基线（04-detail §2.1.1，实读确认）**：基于 ui/Dialog（Dialog.tsx 已具备 `role:'alertdialog'`、`initialFocusRef`、`dismissible`、`showCloseButton`、`footer`、`description` prop，Esc 栈 dialogStack 已实现）；`role="alertdialog"` + title→aria-labelledby + description→aria-describedby；初始焦点落**取消钮**（Dialog 基座默认聚焦首个可交互元素）；danger 变体确认钮**不默认聚焦**；Esc 关闭并归还原焦点（继承 Dialog 三件套）；**无关闭按钮（showCloseButton=false）**。

**基座 props 表（受控组件，最小面）**：

| prop | 类型 | 默认 | 说明 |
|---|---|---|---|
| open | boolean | false | 受控开合（基座不管理 open 状态，不设内部状态机） |
| title | ReactNode | — | 标题，→ aria-labelledby |
| description | ReactNode | — | 正文，→ aria-describedby（原 confirm 全文入此，含「不可逆/永久丢失」后果说明） |
| confirmLabel | ReactNode | '确认' | 确认钮文案（2.1.5 文案模板：危险项「确认删除/确认放弃/确认清空/确认强制取消」…） |
| cancelLabel | ReactNode | '取消' | 取消钮文案 |
| danger | boolean | false | 危险变体：确认钮 variant="danger"，且**不默认聚焦**（初始焦点仍落取消钮） |
| onConfirm | () => void | — | 确认回调 |
| onCancel | () => void | — | 取消回调（Esc / 取消钮 / 遮罩统一归口） |
| disabled | boolean | false | 确认钮 disabled（异步进行中防重复提交，对齐 BgTaskActions busyAny 语义） |
| size | DialogSize | 'md' | 透传 ui/Dialog |

**Enter/Esc 语义**：Esc = 取消 + 归还焦点（Dialog 三件套）；**Enter = 浏览器原生激活当前聚焦钮，不劫持为确认**（初始焦点在取消钮 → Enter 即取消，防危险误触——04 §2.1.1 明确）。

**Promise 返回值（C-7 要求落点）**：主控裁决要求「返回值 Promise」。落点 = **`hooks/useConfirmGate.ts` Promise 桥**（04 §2.1.1 形态，本任务一并创建）：

```
const [confirmGate, renderConfirmGate] = useConfirmGate();
// 调用点：if (!(await confirmGate({ title, description, confirmLabel, danger }))) return;
// 渲染点：{renderConfirmGate(<ui/ConfirmDialog ... />)}
```

- confirmGate 返回 `Promise<boolean>`（确认 → true / 取消·Esc·遮罩 → false），挂起式调用语义 = window.confirm 的异步等价。
- 桥与基座解耦：基座只承诺确定回调语义（onConfirm/onCancel），桥负责 Promise 化——04 T1 的 9 个消费点只接触 confirmGate，不接触基座细节。
- 若 04 轨道已有同名实现则合并（04 仅有契约声明，无实现，实读确认）。

**扩展点**：
- **不扩 props**：多按钮（三选一确认）→ 业务组合层（footer 插槽消化）；动态确认中文案 → disabled + label 组合；遮罩样式/尺寸 → DialogSize 透传。
- 新增形态纪律：先扩联合类型（如 severity）再全量对齐，穷举而非开放字符串（同 Button 扩展点纪律，2.3）。
- **禁止**：各调用点自写状态机 / 各自渲染 Dialog（第四套实现）；新引入 `confirm`/`alert`/`prompt`（04 §2.1.1 禁止项，4.1 的 check:no-window-confirm 门禁兜底）。

**测试清单**：
1. ui/ConfirmDialog 单测：`role="alertdialog"` 断言；title→aria-labelledby / description→aria-describedby 关联断言；**初始焦点 = 取消钮**（含 danger 变体）；danger 时确认钮不可默认聚焦、tab 序确认钮在取消钮之后；Esc → onCancel 且焦点归还原触发元素（useRestoreFocus 断言）；无关闭按钮（无 X）；disabled 确认钮不可交互；size/className 透传。
2. useConfirmGate 单测：确认 → resolve(true)；取消/Esc/遮罩 → resolve(false)；挂起期间元素单例（重复 renderConfirmGate 不重复挂载）；两次并发调用语义（后调覆盖或排队——以 04 T1 消费面实测为准，登记）；卸载后不 resolve 泄漏。
3. 键盘走查（每验证轮）：Tab 循环圈定对话框内；Enter 激活聚焦钮；danger 下 Enter 不触发确认。
4. 交接验收（批次 4.1 侧）：9 文件替换后 `window.confirm` grep = 0（04 T1-6 门禁）。

**完成判据**：ui/ConfirmDialog + hooks/useConfirmGate 入库（进 barrel、测试随组件迁移）；契约表（04 §2.1.1）逐项签字；单测全绿；04 T1 派单前置确认基座可用。

### 2.10 T16：ui/Button 接管波 2 剩余批（批次 3.4，02-B2 波 2 后续，C-4）

**背景（C-4 裁决）**：批次 3 **承接全部裸 button 替换波次**——128 文件裸 button 中 T8 覆盖 settings 域首批后，剩余约 100 文件由本任务内拆 6 子波完成（原 ⑥ 风险 5 执行缝隙关闭）。目标态「**业务层裸 button = 0**」。语义判定规则表、替换红线、视觉抽样纪律全部沿用 T8（2.4）。

**实测分布（2026-08-09，rg `<button` 于 components/ 生产代码，不含测试与 ui/；128 全仓口径含测试与 ui/）**：settings 20、chat-card 11、workspace 9、chat-composer 8、sidebar 8、overview 8、files 6、root 5、settings-skills 5、diff 5、agent-card 5、overlay 4、settings-extensions 3、settings-models 3、chat-tool-call 3、settings-mcp 2、bg-tasks 2、card-panel 2、chat-message-row 2、binary-tree 2、shell 1、provider 1、chat-message-list 1（合计 116 业务文件）。

**子波划分（6 波，每波 ≤20 文件，按域聚批；执行时以 `rg -l "<button" --glob "*.tsx"` 实测清单裁剪，单域超上限时域内再拆）**：

| 子波 | 域面 | 预算 | 备注 |
|---|---|---|---|
| W1（波 2） | settings 系收尾（settings/skills/mcp/extensions/models 的 T8 后剩余） | ≤15 | settings 系零残留判据 |
| W2（波 3） | chat-card 11 + chat-message-row 2 + chat-message-list 1 | 14 | chat 域第一波 |
| W3（波 4） | chat-composer 8 + chat-tool-call 3 + provider 1 | 12 | chat 域第二波 |
| W4（波 5） | workspace 9 + overview 8 + bg-tasks 2 + shell 1 | 20 | 壳/状态区 |
| W5（波 6） | sidebar 8 + files 6 + diff 5 + overlay 4 | 23 → 拆：overlay 4 移 W6 | 超限域内再拆 |
| W6（波 7） | agent-card 5 + card-panel 2 + binary-tree 2 + root 5 + overlay 4 | 18 | 收尾波 + 清零扫描 |

**每波文件面原则**：
1. 按域聚批（同域同波），每波 ≤20 文件（master plan §3-3 规模控制），波间文件面不重叠；批次 3 接力式串行（T8 → W1 → … → W6，Agent 轮换）。
2. 复用 T8 语义判定规则表（2.4 表）逐按钮判定；有明确 class 语义（ghost/icon-btn/link 等）的机械映射，其余语义判定（danger/primary/secondary 归口）。
3. **替换红线**：只改标签名与 className 段，保留 aria-label/aria-pressed/type/data-*/role 属性行（03 评审 ④.3）；`type="button"` 由 Button 默认值保证。
4. **R-07 分工**（B-P2-3）：02 侧替换时顺带补其替换面的 aria-label；**未补齐项登记移交 08**（批次 4.3 grep 重扫补剩余 + 建门禁，本轨道不建门禁）。
5. **豁免面（登记在案，不计入清零判据）**：`role="tab"` 的 tabClose 按钮（归 T12 TabStrip 收敛）；编辑器域（tiptap/textarea 工具栏等第三方/专项组件内部 button，若存在）；ui/ 原子层自身。

**每波验证**：视觉回归抽样 3~5 按钮（tests/visual/ 基线，T-B 已建 8 组件基线则直接复用）；变体判定规则表逐按钮签字（评审物）；aria-label 补齐计入本批判据；键盘走查抽样（Tab 聚焦 + Enter 激活）；波末 grep 该域裸 button 清零；typecheck + `npm run check:ui-layer` 绿。

**完成判据**：业务层 `rg "<button"`（components/ 生产代码，排除豁免面）= 0；116 文件清零表 + 豁免登记表入最终提交说明；全波视觉抽样无差异。

### 2.11 T17：props 治理（批次 8.0，02-C1，C-5）

**背景（C-5 裁决）**：02-C1（P1-12 props drilling 治理）排批次 8.0，作为 T-H（08 轨道）渲染优化的 memo 面前置；本任务供批次 8 派发。目标：三个高 props 数消费面聚合为对象 spread，**只聚合不删减、不改变渲染行为**。

**目标文件与改造要点（实读）**：

| # | 文件（实读行号） | props 现状 | 改造要点 |
|---|---|---|---|
| 1 | `components/chat-card/ChatCard.tsx` | ChatCardProps 接口仅 6 字段（:19-30），但 `useChatCardState()` 返回的 composerProps 聚合对象在 `<ChatComposer>` 消费处被**逐属性展开约 30 个**（:43-75，chatInput/setChatInput/isComposing/setIsComposing/slashMenuOpen/…/onOpenSchedule，全部来自 `state.composerProps.*`） | **聚合对象 spread**：`<ChatComposer {...state.composerProps} isProcessing={state.isProcessing} permissionMode={state.permissionMode} onPermissionChange={...} onOpenSchedule={...} />`（仅非 composerProps 项显式保留：isProcessing :62、permissionMode :69、onPermissionChange :70、onOpenSchedule :73）；ChatHeader（:115-137）/ModelBadgePicker（:83-89）展开面若 useChatCardState 已聚合则同法收敛，否则不动 |
| 2 | `components/chat-card/ChatComposerWrapper.tsx` | ChatComposerWrapperProps 接口 **29 字段**（:11-41）；内部将字段逐项展开传给 `ChatStatusRibbons`（:82-90+，onOpenTerminal/onOpenDiff/diffCount/engineHint/needsKeySetup/needsModelSetup/onEmptySurface/localHasKey 等） | **ribbons 聚合对象**：接口内新增 `ribbons: ChatStatusRibbonsProps` 分组字段（30 props 中属于 ribbons 面的聚合为单一对象），ChatStatusRibbons 消费改 `{...ribbons}`；非 ribbons 字段（composerElement/mainSurface/runNotice/approval 族等）保持平铺；调用方（ChatCard）同步传聚合对象 |
| 3 | `components/chat-message-row/ChatAssistantMessageRow.tsx` | ChatAssistantMessageRowProps 接口 **24 字段**（:26-51，裁决口径 28 含消费展开差异，执行以实读为准）；消费方 MessageVirtualizer（:352+，约 25 个展开 prop）/AgentMessageRow（:55）逐项展开；**存在自定义 memo 比较器 `assistantRowPropsEqual`（:53-91+）逐字段比较** | **分组聚合 + 比较器联动**：将 msg 相关字段组 / ui 状态组 / 回调组聚合为 2~3 个分组对象；消费方同步 spread；**assistantRowPropsEqual 必须与聚合后结构同步更新**（逐组比较或等价断言），不得扩大重渲染面——08-detail T4.3 的「比较器面收窄」依赖此步 |

**共通纪律**：
1. 聚合后接口字段数不变（签名兼容，消费方零行为差异）；spread 是纯机械重构，禁止顺手重排 JSX / 改样式 / 动 memo 默认行为。
2. **比较器联动**（ChatAssistantMessageRow 特有）：props 结构变化必须同步 `assistantRowPropsEqual`，跑既有 memo 相关测试（MessageVirtualizer/流式渲染专项）确认重渲染面不扩大。
3. 与 T-H 同文件串行：本任务（8.0）先行聚合 → 08 轨道在其上优化渲染（master plan §1 T-C↔T-H）；08-detail T4.3 类型级穷尽/清单测试自成闭环不依赖本任务，其「比较器收窄」段依赖本任务完成后执行。
4. 类型级穷尽清单（08 T4.3）作为聚合前后字段一一核对的评审物。

**验证**：typecheck 绿；既有组件测试不破（ChatCard/ChatComposerWrapper/ChatMessageRow 相关单测）；聚合后 props 传递语义核对表签字（逐 prop 确认对象内字段一致）；ChatAssistantMessageRow 重渲染断言（比较器更新后不扩大）；性能采样对比与 08 T-H 共用基线。

**完成判据**：三文件聚合对象落地 + 消费方 spread 同步；assistantRowPropsEqual 与结构同步且单测绿；行为变更登记 = 0；typecheck + 快层单元测试全绿。

---

## ③ 巨型拆分（批次 5，T9/T10）

> 拆分原则（02-D）：**只搬不写**——拆出的子组件从原文件原样迁移（含注释/样式），不借机改行为；拆完行为测试全绿才进入下一步；每步输出「子组件清单 + 行数分布」作为拆分收据。行数以 03 评审实测（2026-08-09）为基线，执行前重定位。

### 3.1 ModelConfigEditor.tsx（实读 866 行，settings-models/ 域）

| 拆出子组件 | 来源区段（语义定位） | 职责 | props 边界（最小面） |
|---|---|---|---|
| `CapEditor` | cap 开关组（含 :529 区域） | cap 开关组编辑 | `caps`、`onCapChange`、`disabled`；内部用 ui/Switch（T11 基座先行） |
| `ModelList` | 模型列表（:575+ 区域） | 模型条目列表与选择 | `models`、`activeId`、`onSelect`、`onRename/onDelete` |
| `ProviderProfileForm` | profile 选择与编辑区 | provider profile 表单 | `profile`、`onChange`、`onSave` |
| `CapabilityEditor` | 能力矩阵区 | 能力矩阵编辑 | `value`、`onChange`、`readOnly` |
| `ToggleThumb` | :668 私有 thumb | **不拆，随 T11 的 ui/Switch 替换直接消亡** | — |

主文件保留组装职责 ≤300 行。跨域可复用件（CapEditor）**默认不升格 ui/**（遵循「2 个消费点才升格」原则），由评审决定。
完成判据：主件 ≤300 行；子件各 ≤300 行；设置-模型页人工回归（增删 profile/cap 开关/保存流程）全绿。

### 3.2 useExtensionMarket.tsx（实读 623 行，settings-extensions/ 域，R-05 归并）

**R-05 裁决**：与 05-步骤4 的重复拆分归 02 承办（02-D2）；05-步骤4 将该文件从其函数清单剔除。**本轨道唯一承办方**。

| 拆出 hook | 来源区段 | 职责 |
|---|---|---|
| `useSkillsCache` | 缓存读写（:37-72 语义段） | skills 缓存读写 |
| `useMcpCache` | MCP 缓存段 | mcp 缓存读写 |
| `useMarketQuery` | 市场数据获取 + 状态管理段 | 市场查询（分页/过滤） |

组合方式：三 hook 组合替代单巨型 hook（遵循 chat-stream/ 子目录化 + index 成功模式）。文件按 `settings-extensions/useSkillsCache.ts` 等平铺（或子目录化，执行时择一登记）。
完成判据：三 hook 各 ≤200 行；扩展市场页人工回归（分页/过滤/缓存刷新）全绿。

### 3.3 useSidebarSessionList.tsx（实读 588 行，sidebar/session-list/ 域）

| 拆出 hook | 职责 |
|---|---|
| `useWindowedList` | 列表窗口化（range 切片） |
| `useSessionDrag` | 拖拽状态与手柄事件 |
| `useSessionGrouping` | 分组/折叠状态 |

完成判据：三 hook 各 ≤200 行；会话列表页人工回归（分页/拖拽/分组）全绿。注意与 02-E1（虚拟列表定案）与 07-步骤4①（R-04）的 useVirtualScroll 同文件串行登记（C13）——本任务不触碰 useVirtualScroll 本身。

### 3.4 ApprovalAskCard.tsx（实读 777 行，agent-card/ 域）

| 拆出子组件 | 来源区段 | 职责 |
|---|---|---|
| `ApprovalRiskChips` | :91-127 内联 chip 生成（localizeRiskChips/dedupeChipLabels） | 风险 chip 渲染（兼收 badge 族，与 E3 联动） |
| `ApprovalCountdown` | 倒计时段 | 倒计时展示 |
| `ConfirmButton` 组 | 确认按钮组段 | 同意/拒绝按钮组（Button 基座，T7 后已有） |
| `ApprovalPayloadSection` | 既有内部件 :146-269 | 保持，不重复拆 |

> 注（C-7 一致性）：E3 的「确认对话框」族已由主控修订为 **T15（批次 4.0）创建 ui/ConfirmDialog 基座、迁移消费归 08**；E3 的 badge/空态/通知横幅/滚动锚定族仍为 P2 项（批次 9.3 登记入最终修复报告，B-P2-5）。ApprovalRiskChips 与 badge 族收敛的联动面保持原意；确认流程若涉及对话框语义按 T15 基座消费（同文件串行：T15 先行）。

### 3.5 SidebarContextMenus.tsx（实读 722 行，sidebar/ 域）

| 拆出 | 来源区段 | 职责 |
|---|---|---|
| `ContextMenuFlyout` 基件 | 自研键盘漫游（:87-130）+ flyout 状态机（:150-225） | 右键菜单浮层基件（含漫游，保留自研——与 ui/Menu 漫游的收敛决策登记 02-E3/08 后续） |

### 3.6 ExternalSessionImport.tsx（实读 580 行，settings/ 域）

按向导步骤拆 3~4 步组件：步骤容器 + 各步内容（文件选择/会话选择/确认导入）。props 边界 = 每步 `{ value, onChange, onNext/onBack }`。

### 3.7 SettingsUsageTab.tsx（实读 536 行，settings/ 域）

| 拆出 | 职责 |
|---|---|
| `UsageChart` | 用量图表 |
| `UsageTable` | 用量明细表格 |
| `UsageConfigSection` | 配置区 |

完成判据（3.4~3.7 共用）：全仓无 >500 行组件（次级 400~500 行清单留观）；行为回归全绿（审批流/右键菜单/导入向导/用量页）；拆分收据（子组件清单 + 行数分布）入提交说明。

---

## ④ R-07 交接（无名称按钮：02 结构迁移 → 08 aria 补齐）

### 4.1 裁决口径（00-master-plan R-07 + 03 评审 P0-5）

**02-B2 先改结构（批次 3，本轨道 T7/T8/T16）、08-步4 后补 aria（批次 4，T-D 轨道）**。两轮内分开，同文件串行。

### 4.2 02 侧（本轨道）交接产出清单

02 侧动作 = 替换裸 button / .ui-btn 为 ui/Button 时**顺带补齐 aria-label**（16 个无名称按钮中落在 T7/T8/T16 文件面的），并输出「迁移后仍无名称按钮清单」（08 步 1 的③ 与本轨道共同产出——Tooltip 迁移后仍无 aria-label 的图标按钮逐一登记；**T16 每子波输出增量清单，波末汇总移交 08 批次 4.3**）。

**16 个无名称按钮所在 5 文件（08 步4 清单，本轨道触碰面）**

| 文件 | 涉及按钮面 | 02 侧动作 |
|---|---|---|
| `diff/DiffCardFileList.tsx` | :152-278 行内操作按钮 | T5 替换 Tooltip import 时**保留已有 aria-label 不动**（03 评审红线：机械替换不重写属性行）；T7 若有 .ui-btn 迁移保留属性 |
| `files/FileActions.tsx` | 文件操作按钮 | 同 |
| `files/FilesCard.tsx` | 文件卡片按钮 | 同 |
| `files/FileViewerCard.tsx` | 查看器按钮 | 同 |
| `settings-models/ModelConfigEditor.tsx` | cap/模型列表按钮 | 同（T9 拆分时注意保留） |

**机械替换工具红线（03 评审 ④.3）**：替换 className/标签名时**禁止整段重写 button 标签**，aria-label/aria-pressed/type/data-*/role 属性行必须原样保留——这是"08 后置不丢名称"的前提。

### 4.3 交接给 08 侧的清单（批次 4 输入）

1. 16 个无名称按钮中**未在本轨道补齐**的剩余项（02 侧替换完成后 grep 重扫）。
2. 名称与 Tooltip 文案同源约定（aria-label 与 content 一致，08 验收断言）。
3. 触屏尺寸 ≥44px（08 断言，本轨道不碰样式）。
4. 门禁断言（08 渲染面扫描），本轨道不实现。

---

## ⑤ 验证与提交

### 5.1 每批统一门禁（全部批次强制）

| 门禁 | 命令 | 备注 |
|---|---|---|
| 类型检查 | `npm run typecheck`（根，含 4 个 tsconfig） | 每批提交前必绿 |
| 单元测试 | `npm run test:coverage -- --project=unit`（快层 45/70/65/45） | ui/ 组件测试保活 |
| 分层门禁 | `npm run check:ui-layer`（T1 后含 check:ui-barrel） | 新增 ui/ 件（Switch/TabStrip）进 barrel 自动校验 |
| 全量 vitest | `npm run test`（T6 退役步、T9~T13 收尾批、T16 收尾波、T17） | 退役/结构迁移后强制 |
| store facade | `npm run check:store-facade`（**T14 起强制**；脚本归 T-E 承办，C-8） | 违规数单调递减至 0；基线见 05-detail ④ |
| e2e 专项 | tests/e2e 5 个 markdown-editor 专项 spec（ast-block-tables/format-checker/ime-composition/keyboard-navigation/wysiwyg-interaction） | **禁止删除**，回归保留 |
| reference 门禁 | `npm test`（reference/markdown-editor） | 本轨道不触引擎，但改动后需跑通（AGENTS.md 铁律） |

### 5.2 分批专项验证

| 任务 | 专项验证 |
|---|---|---|
| T1 | barrel 负向用例（漏导即红）；grep Menu 直引清零 |
| T2~T6 | 每批键盘冒烟抽样（Tab 聚焦 icon 按钮 → tooltip 出现；Shift+Tab 离开 → 消失）；退役步 aria-describedby 关联断言 |
| T7/T8 | 每批视觉回归抽样 3~5 按钮（tests/visual/ 基线，T-B 批次若已建 8 组件基线直接复用）；变体判定规则表逐按钮签字 |
| T11 | ui/Switch 单测（键盘交互/受控非受控/aria 断言）；3 个代表性开关人工验证（SR 播报无环境时降级 aria 快照 + 键盘走查） |
| T12 | 能力盘点表验收物；ui/TabStrip 单测（移植蓝本 3 套 a11y 专项）；每消费点视觉回归 |
| T13 | 回调语义核对表签字；5 个代表消费点行为人工验证（打开/选择/关闭/Esc/外点关闭） |
| T9/T10 | 行为测试全绿 + 拆分收据（子组件清单 + 行数分布）入提交说明 |
| T14 | 每批 `npm run check:store-facade` 违规数递减断言（78 → 0 单调）；行为等价核对表签字；typecheck + 该批域页面冒烟 |
| T15 | ui/ConfirmDialog 单测（alertdialog/labelledby/describedby/初始焦点取消钮/danger 不默认聚焦/Esc 归还）；useConfirmGate 两路径断言（确认 true/取消 false）；键盘走查（Tab 圈定/Enter 不劫持） |
| T16 | 每子波视觉回归抽样 3~5 按钮 + 变体判定规则表逐按钮签字 + 波末该域裸 button 清零 grep + aria-label 补齐计数（R-07）；豁免面登记表 |
| T17 | 聚合后 props 传递语义核对表签字（逐 prop 字段一致）；assistantRowPropsEqual 联动断言（重渲染面不扩大）；性能采样与 08 T-H 共用基线 |

### 5.3 提交纪律

1. **每批一个提交**（T1 独立；T2~T6 每批独立；T4 内两子提交；T7/T8 每波独立；T9/T10/T11/T12/T13 各自独立；**T14 每批独立（含违规数递减快照）；T15 独立；T16 每子波独立（W1~W6 各一提交）；T17 独立**），提交信息带批次号（如 `feat(ui): T-C 批次3-2 Tooltip 迁移批1（chat 域 21 文件）`），遵循仓库风格。
2. **CSS 内容改动与 test:snapshots 更新同提交**（8e8c313c 教训）：任何批次若动到 module.css（T11 新建、T13 退役全局类），快照同步更新不分离。
3. 一次性工具脚本（check-ui-barrel.mjs 等）随 T1 入库，不留未跟踪状态（AGENTS.md 测试资产铁律）。
4. 禁止 `--no-verify`；任何门禁红即修复或整批回退，不携带黄灯提交（02 方案 4.3）。
5. 提交前 `git status` 检查并行域（conex-browser 域、markdown-editor R3 轮次）未触碰目标文件；若引用文件被并行域 M 标记，先读最新再改（master plan §3-6）。
6. 回退粒度 = 单批 git revert，不连锁；双轨窗口控制红线：过渡态期间新代码一律用新件，退役步骤排入同阶段验收（02 方案 4.3）。

---

## ⑥ 风险

| # | 风险 | 触发场景 | 缓解 |
|---|---|---|---|
| 1 | **Tooltip 行为差异**：新件键盘 focus 触发 + aria-describedby 是行为收益，但（a）可聚焦触发器聚焦即弹 tooltip，hover 场景下"聚焦残留"可能出现在非预期时机；（b）视口钳位使贴边触发器的提示位置微移（旧版可能溢出视口） | T2~T6 迁移后 SR/键盘用户行为变化 | 行为收益登记为预期变化（08 步1 契约同步）；每批键盘冒烟验收「收益真实发生」；贴边场景视觉抽样确认钳位不遮挡触发器；若出现"非预期聚焦触发"个案，逐点登记（新件 focus 触发与 hover 语义一致，delayHide 尊重——契约为准） |
| 2 | **按钮视觉差异**：变体映射误判或 `.ui-btn` 无 disabled 规则 vs Button 有 opacity 的观感差 | T7/T8 语义判定错误（danger/ghost 分错） | 变体判定规则表评审前置；每批视觉回归抽样 3~5 按钮；单批可整批回退 |
| 3 | **primary 语义未定案的残留风险**：若 01-S3-任务1 未完成即开工 T7 | 映射表以旧四套 primary 为基准 → 替换后观感错位（02 风险 6） | 前置条件清单（①1.3-3）显式检查；T7 派单前主控确认 01-S3 提交已合入 |
| 4 | **Select 迁移行为回归**：group/previewFamily/footer 能力差异处理不当 | FontSettingsSection 字体预览/分组选项渲染走样 | 执行前 grep `group:`/`footer=`/`previewFamily` 在 11 文件命中数（决策点 2 已登记）；FontSettingsSection 视觉回归重点项；逐点核对表签字 |
| 5 | **裸 button 剩余批的波次边界漂移（已裁决，转为执行注意）**：C-4 定案批次 3.4 承接全部波次（T16，6 子波），但实测清单（116 业务文件）随 T8 进度演进 | 子波域预算与实际不符（超 ≤20 上限） | T16 派单前以 `rg -l "<button" --glob "*.tsx"` 实测重扫定稿清单；单域超限域内再拆；豁免面（role="tab" tabClose、编辑器域、ui/）显式登记不计入清零判据 |
| 6 | **同文件串行遗漏**：T5（diff 域 Tooltip）与 T7（diff 域 .ui-btn）、T9（ModelConfigEditor 拆分）与 T11（其 cap 开关替换）、T13 退役（SettingsSelect）与 T1（其 Menu 直引）、**T16（chat-* 域裸 button）与 T2~T5（同域 Tooltip 迁移）、T17（chat-* 域 props 聚合）与 T16 清零面、T14（agent-card/settings 域直引）与 T9/T10 拆分** 多组同文件双任务 | 并行合并冲突 | 批次内执行链（①1.2）显式串行；派单时同文件清单核对表签字 |
| 7 | **a11y 升级的「假收益」**：Switch/Tooltip 替换后无人验证 SR 行为 | SR 环境缺失（NVDA 未装） | 降级路径（03 评审 P1-1）：Playwright aria 快照断言 + axe 扫描 + 人工键盘走查；SR 播报留待有环境补录 |
| 8 | **巨型拆分行为漂移**：拆分时顺手"改进"而非"只搬" | T9/T10 | 「只搬不写」原则 + 行为测试全绿才进入下一步；拆分收据入提交说明 |
| 9 | **TabStrip 能力对齐不足**：拖拽/溢出/上下文差异超出基座插槽可消化面 | T12 批 B（GlobalSessionTabBar） | 能力盘点表先行；差距大者标「暂缓」或降级业务封装层组合，不扩基座 props |
| 10 | **双轨扩大**：迁移中途新需求继续用旧件/旧全局类 | T2~T13 期间 | 红线 a（评审拦截）+ 门禁 + 退役步骤排入同阶段验收；`.ui-btn`/`settings-switch`/`settings-field-input`/旧 Tooltip 的 grep 清零判据为强制出口 |
| 11 | **T14 门禁交接时序**：check-store-facade 基线（T-E 批次 5）未就绪即开工 T14，或迁移归零后 CI 接线跨批悬挂 | 迁移失去度量工具；CI 长期红 | 开工硬前置（①1.3）；归零后主控触发 T-E 同批接线（master plan 7.4）；每批违规数递减快照入提交说明 |
| 12 | **T15 基座与 04 契约偏差**：实现细节（初始焦点/Enter 语义/danger 不默认聚焦）与 04-detail §2.1.1 或 04 T1 消费预期不一致 | 4.1 消费迁移返工 | 契约逐项签字（04 §2.1.1）；键盘走查含 danger 变体；04 T1 派单前主控确认基座已按契约验收 |
| 13 | **T17 聚合破坏 memo 比较器**：ChatAssistantMessageRow 的 assistantRowPropsEqual 未随聚合结构更新 → 重渲染面扩大/漏渲染 | 流式渲染性能回退 | 比较器与结构同步更新 + 既有 memo 测试不破断言；与 08 T4.3 比较器收窄交接 |
| 14 | **R-07 双补/漏补边界**（B-P2-3 落地面）：T16 顺带补 aria-label 与 08 批次 4.3 grep 重扫可能两边都补或都漏 | 名称重复或缺失 | 本轨道只补其替换面并输出「迁移后仍无名称按钮清单」；08 以重扫补剩余 + 建门禁；清单双向交接（见 ④ 4.2） |

---

## 附：实读基线说明（口径差异与不确定处标注）

1. **旧 Tooltip 消费数**：实测 83 直引（80 `../Tooltip` + 3 `../../Tooltip`）+ 4 barrel = 87 文件；方案/审计口径 85/88，差异 = 统计时点与含 SettingsSelect 自身。批次按 87 口径执行，退役判据 grep = 0 不变。
2. **Menu 直引**：实测 10 生产文件（方案口径 11，03 评审实测 10，差 1 为 AddProviderMenu.test.tsx 测试口径）。
3. **.ui-btn 消费**：grep 命中 37 文件（含 Button.tsx 自身 1 个），业务 36 个；03 评审口径 42 含 css 与全仓——执行时以 `rg -l "ui-btn" --glob "*.tsx"` 实测清单为准。
4. **SettingsSelect 消费方**：实测 11 生产文件（R-09 修正落地，含跨 4 域：diff/settings-skills/settings-mcp/Wizard）。
5. **行号漂移**：所有 `:行号` 基于 2026-08-09 实测（ModelConfigEditor 866、ApprovalAskCard 777、SidebarContextMenus 722、ExternalSessionImport 580、SettingsUsageTab 536、useExtensionMarket 623、useSidebarSessionList 588、UnitSessionTabStrip 505），执行前语义定位优先。
6. **待主控裁决项（v2 更新）**：①裸 button 剩余波次承接批次——**已由 C-4 裁决（批次 3.4，T16），销号**；②T13 的 group 能力决策（grep 命中数依赖，执行期判定）；③SR 验证环境缺失的正式降级路径——**已由 U-5/C 系列定案（Playwright aria 快照 + axe + 键盘走查），销号**。
7. **store 直引 78 文件域分布（T14 分批依据，2026-08-09 实测）**：diff 10 / sidebar 9 / chat-card 8 / agent-card 7 / chat-tool-call 6 / settings 6 / workspace 5 / overview 5 / chat-message-row 4 / card-panel 4 / chat-message-list 4 / binary-tree 4 / components 根 2 / chat-message 2 / files 1 / settings-skills 1。与 05-detail §0-4 口径一致（78 非测试文件）。
8. **裸 button 业务分布（T16 子波划分依据，2026-08-09 实测）**：116 业务文件（128 全仓口径含测试与 ui/）：settings 20 / chat-card 11 / workspace 9 / chat-composer 8 / sidebar 8 / overview 8 / files 6 / root 5 / settings-skills 5 / diff 5 / agent-card 5 / overlay 4 / settings-extensions 3 / settings-models 3 / chat-tool-call 3 / settings-mcp 2 / bg-tasks 2 / card-panel 2 / chat-message-row 2 / binary-tree 2 / shell 1 / provider 1 / chat-message-list 1；T8 首批约覆盖 settings 系 20~30 文件，T16 以 T8 完成后实测重扫定稿。
9. **C-5 props 实测口径**：ChatCard.tsx:43-75 的 `<ChatComposer>` 逐属性展开 30 个（全部来自 `state.composerProps.*`，另有 isProcessing/permissionMode/onPermissionChange/onOpenSchedule 独立传参）；ChatComposerWrapper.tsx:11-41 接口 29 字段；ChatAssistantMessageRow.tsx:26-51 接口 24 字段（主控裁决口径 28 含消费展开差异，执行以实读为准）+ 自定义比较器 assistantRowPropsEqual（:53+）。
10. **样式修复边界**：`--tooltip-translate` fallback 归 01-S0（R-01 裁决已办）；`.ui-btn` 段删除、`settings-switch`/`settings-field-input` 段删除的**样式侧**动作归 01-S3/S5 收尾（02 管消费点迁移、01 管删段，握手关系见 02 方案附）。
