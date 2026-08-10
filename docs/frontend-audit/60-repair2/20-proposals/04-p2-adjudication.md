# 第二轮修复 · P2 挂账裁决维度 · 决策方案

> 产出：`docs/frontend-audit/60-repair2/20-proposals/04-p2-adjudication.md`
> 角色：方案设计子 Agent（只读 + 本方案文档产出，无代码改动）
> 输入：`50-reverify/02-convergence-thoroughness.md`（R4-R20 挂账清单）、`10-analysis/02-component-architecture-audit.md`（P2 项原定义）、`40-final-plan/90-final-report.md`（B-P2-5 挂账登记）
> 性质：10 类 P2 挂账的取舍裁决（收敛 / 保留 / 退役）；只读实证，全部行号与计数基于 2026-08-10 工作区实读复核（rg / 文件读取）
> 裁决标准（任务给定）：**消费点 ≥3 且观感差异明显 → 收敛；≤2 且语义独立 → 保留；死代码 → 退役**

---

## 0. 结论速览

10 类 P2 挂账终态裁决：**收敛 5（R4/R5/R6/R7/R10）、保留 4（R8/R9/R14/R18）、退役 1（R20）**。

| 轮次 | 动作 | 项 |
|---|---|---|
| **本轮** | 退役 1 + 收敛 1 + 轻量对齐 1 | R20（VirtualList 孤儿退役）、R5（滚动条 31 块契约化）、R9 命名对齐（handleStop 双轨改名，零行为变更） |
| **下轮** | 组件级收敛 4 | R4（badge/pill 状态色）、R6（通知横幅多渠道）、R7（空态三件套）、R10（菜单键盘漫游双套） |
| **保留** | 长期 / 条件触发 4 | R8（滚动锚定双套）、R9（流式双轨合并本体）、R14（theme-dark 补丁）、R18（!important 633） |

**一句话**：10 类挂账按「消费点 × 观感差异 × 死活代码」三问裁决——本轮只做零风险面（孤儿退役、滚动条纯 CSS 契约化、流式命名纯改名），组件级收敛 4 项排下轮并串行避让 01 方案同域改造，依赖视觉验证环境与流式管线稳定的 4 项永久保留或条件触发。

---

## 1. 裁决矩阵总表（①）

| # | 挂账项 | 消费点（实读） | 观感差异 | 死活 | 裁决 | 轮次 | 工作量 | 目标态 |
|---|---|---|---|---|---|---|---|---|
| R4 | badge/pill 状态色多套 | ≥8 组件 / 5+ 文件 | 明显（同语义 4+ 画法） | 活 | **收敛** | 下轮 L2 | 1-2 人日 | ui/Badge 基件 + 状态色档位 token |
| R5 | 滚动条 31 块 | 12 文件（ratchet 基线 31） | 明显（thumb 2/3/4px 混用） | 活 | **收敛** | 本轮 W2 | 0.5-1 人日 | shell-scrollbar 单契约 + token 档位 |
| R6 | 通知横幅多渠道 | 5 组件（1 组合枢纽） | 明显 | 活 | **收敛** | 下轮 L4 | 1.5-2 人日 | ui/NoticeBanner 展示基件 + slots |
| R7 | 空态三件套 | 3 组件 / 合并 5 消费 | 明显（同一图标源） | 活 | **收敛** | 下轮 L1+L2 | 0.5-1 人日 | ui/EmptyState 基件（variant） |
| R8 | 滚动锚定双套 | 2 实现 / 各 1-2 消费 | 无（容器语义独立） | 活 | **保留** | 远期候选 | — | 登记债务，远期统一候选 |
| R9 | 流式双轨 | 主轨 ≥3 + 副轨 2 | 无（行为内部，命名双轨） | 活 | **保留**（本轮做命名对齐） | 本轮 W3 | 0.5 人时 | 命名唯一；合并本体远期 |
| R10 | 菜单键盘漫游双套 | ui/Menu 11+ + sidebar 2 件 | 不明显（a11y 行为） | 活 | **收敛** | 下轮 L3 | 1 人日 | useMenuKeyboardRoam 共享 hook |
| R14 | theme-dark 补丁 265 行 | 全局 dark 面 | — | 活（补丁） | **保留** | 条件触发 | — | 视觉基线就绪后迁 tokens.css |
| R18 | !important 633 | 全仓 ≤633（ratchet） | — | 活（覆盖链） | **保留** | 条件触发 | — | 视觉验证后治理，ratchet 守门 |
| R20 | VirtualList 孤儿 | 0（仅自身测试） | — | **死** | **退役** | 本轮 W1 | 0.5 人时 | 物理删除 + git 提交删除 |

> 判据落位：R4/R5/R6/R7 满足「消费点 ≥3 且观感差异明显」；R8 满足「≤2 且语义独立」（锚定容器不同）；R9 双轨合计消费 ≥5 但观感差异不成立（行为内部、无用户可见差异），且合并动的是刚修复的流式管线（批次 8 P0-6 + 本轮 02 方案 stop 截断），风险收益比不支持本轮收敛 → 保留本体 + 摘命名对齐低垂果实；R10 满足「消费点 ≥3」但观感不明显，收敛收益在 a11y 一致性（算法单源防未来修复只覆盖一处），判收敛；R14/R18 非死代码且迁移依赖视觉验证环境（90-report §7.2 明示），判保留；R20 为唯一死代码，判退役。
>
> 口径说明：本裁决覆盖任务指定的 10 类（R4-R10 / R14 / R18 / R20）；02-E1「虚拟列表 4 套收敛」的其余面（WindowedSessionUl / MessageVirtualizer 与 useVirtualScroll 的关系）与 02-E2 之外的 CSP 收窄、mojibake 残余（R15/R16 由 03 方案承接）、半吊子项（R11/R12/R13/R17）不在本维度清单内，不重复裁决。

---

## 2. 逐类分析（②）

### 2.1 R4 badge/pill 状态色多套 → 收敛（下轮）

**现状（实读）**：同一「状态色」语义至少 4+ 种画法并存——

| 画法 | 证据 | 特性 |
|---|---|---|
| 实色 accent 系 | `bg-tasks/BgTaskCard.module.css:66,71,76,92,338-339`（`--accent-blue/green/danger/orange` 直用） | 实底纯色 |
| accent 低透明混色 | `chat-card/ChatStatusRibbons.module.css:65-66`（`color-mix(--accent-color 10%/30%)`）、`:74`（`--accent-green`） | 10%/30% 双档 |
| accent 30-35% 描边 | `settings-mcp/McpSettingsTab.module.css:44-59,165-175`（accent-green/orange/red 30-35% color-mix） | 描边档 |
| tint 系 + color-active 混色 | `settings-models/ModelsSettingsTab.module.css:44-124`（`--tint-*`）、`:207,275`（`color-mix(--color-active 12%/10%)`） | 第四套 |
| 独立小套 | `sidebar/PermissionModeMenu.module.css:1-24`（复审记录）；组件面 `AgentStatusChip.tsx`（规范）/ `CacheMetricsBadge.tsx:26`（裸全局类 `cache-metrics`）/ `AgentTeamBoard.tsx:13` 内联状态点 / `ApprovalAskCard.tsx:91-127` 审批 chips（02 §1.9） | 零散面 |

**判据**：消费点 ≥8（远大于 3）且观感差异明显（同「状态」语义 4+ 呈现）→ **收敛**。
**目标态**：新增 `ui/Badge`（或 StatusBadge）基件：variant 档位（solid/soft/border）+ 状态语义映射（info/success/warning/danger/neutral），内部统一消费 `--accent-*`/`--color-*` 语义 token（批次 9 S6 已建 `--color-*` 系，本项是 S6 状态色收编的 badge/pill 面延续，无新 token 依赖）；`CacheMetricsBadge` 裸全局类一并迁移。a11y：基件带 role 语义（如 `role="status"`），色档过 `a11y-contrast.test.ts` 67 断言。
**工作量**：1-2 人日（基件 + 5 文件规则迁移 + 8-10 消费点替换）。批次：下轮 L1（建基件）+ L2（迁移）。

### 2.2 R5 滚动条 31 块 → 收敛（本轮）

**现状（实读）**：12 文件 31 块 `::-webkit-scrollbar*`（`style-contract.test.ts:217` ratchet 基线 31 锁定）：`styles/shell/shell-scrollbar.css:32-47`（全局契约 4px/10%）、`binary-tree/LeafToolTabStrip.module.css:43-50`（3px/18%）、`chat-composer/TiptapSlashMenu.module.css:33-39`（2px）、`ChatQueuePanel.module.css:15-22`、`TiptapEditorField.module.css:196-205`、`FontSelectField.module.css`、`UnitSessionTabStrip.module.css`、`GlobalSessionTabBar.module.css`、`DiffCard.module.css`、`WorkspaceChromeBars.module.css`、`shell-workspace.css` 等。thumb 宽度 2/3/4px、轨道 10%/18% 混用——同界面内滚动条粗细不一的可见不一致。
**判据**：消费点 12 文件（≥3）且观感差异明显（thumb 宽度肉眼可辨）→ **收敛**。
**目标态**：`shell-scrollbar.css` 单契约化：定义 `--scrollbar-thumb-size/--scrollbar-thumb-radius/--scrollbar-track` token 档位，12 文件机械替换为 token 消费（允许每域覆盖尺寸档位，但档位来源唯一）；收敛后 `SCROLLBAR_BASELINE` 31 → 1（或按实现计数下调），ratchet 锁定成果。
**工作量**：0.5-1 人日（纯 CSS 机械替换，无组件/行为面）。批次：本轮 W2，与 03 方案 D 块（style-contract 基线下调）同文件串行协调。

### 2.3 R6 通知横幅多渠道 → 收敛（下轮）

**现状（实读）**：`ChatStatusRibbons.tsx:30-37` import 四条横幅轨、`:343-345` 组合渲染 `SetupHintBanner / PlanGoalRibbons / RunNoticeBar / ApprovalDock`（`ApprovalDock` 开关由 `ChatComposerWrapper.tsx:107` 的 `showApprovalDock` 控制）；另有 `agent-card/AgentCard.tsx:152` 的 daemon 状态兜底横幅。五者呈现同一「引擎状态通知」语义，样式/API/交互各自为政（02 §1.10 记录）。
**判据**：消费点 ≥5（同一组合枢纽承载 4+ 轨道）且观感差异明显（高度/色条/动画/关闭交互各异）→ **收敛**。
**目标态**：新增 `ui/NoticeBanner` 展示基件（variant：info/success/warning/daemon；props：dismissible/icon/actions 槽位），四条 chat-card 横幅 + AgentCard daemon 横幅改造为基件消费；交互面（ApprovalDock 批准/拒绝/倒计时、PlanGoalRibbons 进度条）保留为 slots/children，不做行为合并。
**工作量**：1.5-2 人日（5 组件改造 + 组合枢纽微调 + `RunNoticeBar.test.tsx` 等测试面回归）。批次：下轮 L4，**必须排在 01 方案 B 块（ChatStatusRibbons 接口 ribbons 聚合）之后**——同域文件串行。

### 2.4 R7 空态三件套 → 收敛（下轮）

**现状（实读）**：`chat-card/ChatEmptyState.tsx`（1 消费：`ChatCard.tsx:155`）、`workspace/WorkspaceEmptyState.tsx`（1 消费：`Workspace.tsx:159`）、`card-panel/PanelBodyEmpty.tsx`（3 消费：`CardPanelLayout.tsx:92,169,184`）。三者视觉同源（同一 Lucide.LayoutPanelLeft 图标源，02 §1.7），但 className/A11y/props 全不互通；能力梯度：完整三态版（358 行）/ 简约版 / CTA 版。
**判据**：合并消费 5（≥3）且观感差异明显（同语义三种长相）→ **收敛**。
**目标态**：新增 `ui/EmptyState` 基件（variant：default/compact/cta；props：title/description/icon/action 槽；统一 `role="status"`）；`WorkspaceEmptyState`/`PanelBodyEmpty` 直接消费基件；`ChatEmptyState` 保留业务包装层（三态 + 数据属性锚点 + 项目选择器是 chat-card 特有业务面），其展示壳改用基件。
**工作量**：0.5-1 人日。批次：下轮 L1（建基件）+ L2（迁移），与 R4 基件同批建。

### 2.5 R8 滚动锚定双套 → 保留（远期候选）

**现状（实读）**：`hooks/useChatAutoScroll.ts` → `chat-card/ChatScrollAnchor.ts`（消费：`useChatCardState.ts`，ChatCard 系）；`chat-message-list/useScrollAnchor.ts`（消费：`ChatMessageList.tsx:31` + `useChatMessageState.ts`）。两套都做「滚动到底 + 定位消息」，但锚定容器与机制不同：一套走 chatFlowRef（composer 合成滚动区），一套走 `[data-msg-id]` querySelector（虚拟滚动消息列表）。
**判据**：各实现消费点 1-2（≤2）且语义独立（锚定对象不同：合成滚动区 vs 虚拟消息列表）→ **保留**。
**处置**：本轮/下轮均不动；登记为维护性债务，远期候选统一为以 `useVirtualScroll` 窗口计算为底座的 ui/ScrollAnchor 基件（无用户可见收益，纯代码债，优先级最低）。

### 2.6 R9 流式双轨 → 保留本体 + 本轮轻量命名对齐

**现状（实读）**：主轨 `hooks/useChatStream.ts`（re-export `chat-stream/index.ts`，消费：ChatComposer/ChatQueuePanel/chat-card 链，≥3）；副轨 `hooks/useAgentStream.ts`（消费：`InlineAgentPanel`/`AgentCard`）。两者共享下游 `api/streamStop`（`useAgentStream.ts:26-28` import 自证），但各保留一套 finalize/partials 逻辑，停止生成命名双轨：`handleStopGeneration/handleForceCancelGeneration` vs `handleStop/handleForceStop`（`useAgentStream.ts:33-37` 注释自认命名不同步）。测试面：`useChatStream.test.ts` / `useAgentStream.stop.test.ts`。
**判据**：双轨合计消费 ≥5 但**观感差异不成立**（行为内部、无用户可见差异）→ 不触发「收敛」硬条件；且全量合并动的是批次 8 刚修复（P0-6 流式渲染管线）+ 本轮 02 方案正在修（stop 截断）的核心管线，合并风险收益比差 → **保留双实现本体**。
**处置（本轮摘低垂果实）**：命名对齐——`useAgentStream` 的 `handleStop/handleForceStop` 改名 `handleStopGeneration/handleForceCancelGeneration`（2 消费点 + `useAgentStream.stop.test.ts` 同步，纯改名零行为变更）；ui 层 `onSelect`（Menu.tsx:40）/`onChange`（Select.tsx:29）回调命名统一登记下轮 L3 小批次（SettingsSelect 已退役，回调双轨已减一）。
**远期**：useAgentStream 复用 chat-stream 内核的合并，待 02 方案 stop 截断修复稳定 + 并行域收敛后另行立项。

### 2.7 R10 菜单键盘漫游双套 → 收敛（下轮）

**现状（实读）**：`ui/Menu/Menu.tsx:151,160,207,215`（内置 ↑↓ 漫游）、`:304` onKeyDown 挂载；sidebar 域自研两件：`SessionContextMenu.tsx:24-60`（`focusMenuItem` 含 Home/End）+ `:140`（onMenuKeyDown）、`ContextMenuFlyout.tsx:173-199,226,240,250`（ArrowRight/ArrowLeft/Esc flyout 漫游）。注意：**坐标钳位已收敛**（`SidebarContextMenus.tsx:57-58` 注释自证「坐标钳位单源：ui/Menu/position.ts」，SidebarContextMenus 已从 02 审计时的 686 行缩至 123 行）——本项残余仅为「↑↓/Home/End 键盘漫游算法」双实现。
**判据**：ui/Menu 侧消费 11+（≥3）→ 收敛条件成立；观感差异虽不明显（键盘行为），但收敛收益在 a11y 一致性——漫游算法单源后，未来 a11y 修复（T6-3 键盘矩阵面）一次落地两处，避免只修一处的半吊子状态 → **收敛**。
**目标态**：抽取 `useMenuKeyboardRoam` 共享 hook（ui/ 原子层内），ui/Menu 内置改消费之，SessionContextMenu/ContextMenuFlyout 改消费之；flyout 的 ArrowRight/Left 子菜单语义作为 hook 扩展参数。回归面：`Menu.test.tsx` / `Menu.lowViewport.test.tsx` / `SidebarContextMenus.flyout.test.tsx`。
**工作量**：1 人日。批次：下轮 L3，**排在 01 方案 C 块（裸 button 清零触及 sidebar 域）之后**。

### 2.8 R14 theme-dark 补丁 265 行 → 保留（条件触发）

**现状（实读）**：`styles/theme-dark.css` 实读 262 行（任务口径 265 行，差异为统计口径）、44 规则块、23 处 color-mix、9-10 行 text-primary 直接混色（复审记录 :97,144,156,163-179,215,226）；文件为 style-contract 混色检查整体豁免（ratchet 白名单）。批次 9 已完成面：①全局色值类迁移（`--md-code-*` 入 tokens.css）、③死补丁删除（cardSurface/dropdownSurface）——**残余为 ② 选择器补丁（约 250 行），属活补丁**。
**判据**：非死代码（dark 主题全局服役面）且迁移依赖视觉验证环境（90-report §7.2 明示「无 Playwright 视觉基线环境下迁移风险高于收益」）→ **保留**。
**处置**：本轮/下轮零动作；登记条件触发——视觉基线（Playwright screenshot diff）就绪后，逐条迁移至 tokens.css dark 分支与组件 module 层，迁移后解除 ratchet 豁免并下调混色基线。**禁止在无视觉验收下迁移**。

### 2.9 R18 !important 633 → 保留（ratchet 守门 + 条件治理）

**现状（实读）**：`style-contract.test.ts:233` `IMPORTANT_BASELINE = 633`、`:234` `reduced-motion.css` 白名单（机制性 27 处豁免）；实读非 reduced-motion 计数约 630（测试范围口径内 ≤633 绿）。批次 9 S7-5 已摘低垂果实（settings-base segment 组 12 处 + chat.css 2 处，特异性优势面删除）；剩余为活覆盖链：SettingsQuickMenu 3 处 + InlineAgentPanel 8 处（依赖 module 加载顺序，同特异性覆盖链）。
**判据**：非死代码（活特异性覆盖）且无视觉环境不可冒险删 → **保留**；ratchet 只拦新增不反向治理存量（02 复审 §4 口径）。
**处置**：本轮零动作；条件触发——视觉验证环境就绪后与 R14 同批治理（此时可批量验证删除安全性与观感无漂移）；治理后 `IMPORTANT_BASELINE` 逐批下调锁定。未就绪期间维持 633 基线 + 注释登记，**严禁凭特异性推算盲删**（批次 9 已证明删除安全性必须靠实测）。

### 2.10 R20 VirtualList 孤儿 → 退役（本轮）

**现状（实读）**：`components/shell/VirtualList.tsx`（`:3` props 接口、`:28` 组件体、`:10-22` 自研 `computeVisibleRange`）全仓消费仅 `VirtualList.test.ts:2,49-65`（测试自身）；无 `shell/index.ts`、未进 ui barrel（`components/ui/index.ts` 九组件导出不含）；`computeVisibleRange` 与正主 `useVirtualScroll`（5 个消费者，02 §1.5）的窗口计算重复。02 审计已判定孤儿（§1.5 / P3-4），本裁决为执行落位。
**判据**：业务消费 0（仅自测）+ 功能被 useVirtualScroll 覆盖 → **死代码，退役**。
**处置**：删除 `VirtualList.tsx` + `VirtualList.test.ts`；删前 `rg -n "VirtualList" apps/crish-desktop/src`（排除测试自身）复核零命中（已实测成立）；按 AGENTS.md 测试资产铁律——若文件已入库则删除随 `git rm` 提交落地，不留未跟踪状态。**退役后 02-E1「虚拟列表 4 套收敛」缩为 3 套**（WindowedSessionUl / MessageVirtualizer 与 useVirtualScroll 的关系面另行立项）。
**工作量**：0.5 人时。批次：本轮 W1（可立即执行，无冲突面）。

---

## 3. 收敛项批次建议（③）

### 3.1 本轮批次（W1-W3，零风险面）

| 批次 | 项 | 内容 | 文件面 | 门禁联动 |
|---|---|---|---|---|
| W1 | R20 退役 | 删 VirtualList.tsx + 其测试；删前 rg 复核零消费；git rm 提交删除 | `components/shell/VirtualList.tsx`、`VirtualList.test.ts` | typecheck + 快层单测 |
| W2 | R5 收敛 | shell-scrollbar 单契约 + token 档位；12 文件机械替换；SCROLLBAR_BASELINE 31 → 1 | 12 个 module.css + `shell-scrollbar.css` + `style-contract.test.ts` | style-contract 23/23（与 03 方案 D 块同文件串行，最后统一提交） |
| W3 | R9 命名对齐 | useAgentStream handleStop/handleForceStop → handleStopGeneration/handleForceCancelGeneration（2 消费点 + 测试同步） | `hooks/useAgentStream.ts`、`InlineAgentPanel.tsx`、`AgentCard.tsx`、`useAgentStream.stop.test.ts` | typecheck + 中层流式测试 |

> W1 无依赖可先做；W2 与 03 方案 D 块存在 `style-contract.test.ts` 同文件冲突（01/03/R5 三处都要动基线），须串行执行且最后一笔统一跑 23/23；W3 与 02 方案（useStreamCallbacks 域）无文件交集，可并行。

### 3.2 下轮批次（L1-L4，组件级收敛）

| 批次 | 项 | 内容 | 依赖约束 |
|---|---|---|---|
| L1 | 基件先行 | 新建 `ui/EmptyState` + `ui/Badge`（同批建件，含 a11y 断言） | 无（ui 原子层独立） |
| L2 | R7 + R4 迁移 | 空态三件迁移 + badge/pill 5 文件 8-10 消费点迁移 | 依赖 L1；R6 前提不成立前可独立 |
| L3 | R10 收敛 | 抽取 useMenuKeyboardRoam；ui/Menu + SessionContextMenu + ContextMenuFlyout 三消费；顺带 ui 层 onSelect/onChange 回调命名统一（R9 遗留面） | **排在 01 方案 C 块（裸 button 清零触及 sidebar 域）之后** |
| L4 | R6 收敛 | 新建 `ui/NoticeBanner` + 四条 chat-card 横幅 + AgentCard daemon 横幅改造 | **排在 01 方案 B 块（ChatStatusRibbons 接口聚合）之后**；L1 基件建成后执行更佳 |

> 顺序原则：**先基件后迁移（L1→L2）、先补刀后收敛（01/02/03 → L3/L4）**；同域文件严格串行（chat-card 域 B 块与 L4、sidebar 域 C 块与 L3），派发子 Agent 前核对 01/02/03 的提交状态。

### 3.3 保留项登记（R8/R9 本体/R14/R18）

- R8：登记维护性债务（双锚定容器语义独立，远期统一候选，优先级最低）。
- R9 本体：登记「useAgentStream 内核并入 chat-stream」为待立项（触发条件：02 方案 stop 截断修复稳定 + 并行域收敛）。
- R14/R18：登记条件触发（触发条件：视觉基线/视觉验证环境就绪；治理时与 ratchet 基线下调联动）。

---

## 4. 风险（④）

| # | 风险 | 涉及项 | 缓解 |
|---|---|---|---|
| R-1 | **无视觉验收环境的观感漂移**：R5 统一尺寸（个别 2px 菜单条变 4px）、R4/R6 色相与布局变化无法自动验收 | R4/R5/R6（本轮与下轮） | 收敛后人工抽查清单（菜单/任务卡/设置 tab/横幅四条轨）；R5 允许按域保留尺寸档位避免观感突变 |
| R-2 | **style-contract 基线抖动**：01（删 .ui-btn 死 CSS）+ 03（基线下调）+ W2（滚动条基线下调）三处改同一测试文件 | W2 / 03 | 同文件严格串行，最后一笔统一跑 23/23 并提交；任何中间态禁止声称绿 |
| R-3 | **同域文件冲突**：L4 vs 01 B 块（ChatStatusRibbons 接口）、L3 vs 01 C 块（sidebar 裸 button） | R6/R10 | 下轮执行前确认 01/02/03 提交落库；同文件派发串行（AGENTS.md I4-M3 写路径互斥兜底） |
| R-4 | **流式管线回归叠加**：R9 全量合并若提前，会与批次 8（P0-6）修复 + 02 方案 stop 截断修复叠加回归面 | R9 | 本轮只做纯改名；合并立项必须等 02 修复稳定并跑通 useChatStream/useAgentStream 全部测试 |
| R-5 | **a11y 对比度回归**：新 Badge/EmptyState 基件色档若低于对比度要求 | R4/R7 | 基件色档过 `a11y-contrast.test.ts` 67 断言；Badge 文案用语义 token 不用硬编码色 |
| R-6 | **测试资产保护**：R20 删除测试文件，若未入库则删除即丢资产 | R20 | 删前确认已入库（AGENTS.md 铁律）；已入库则随 git rm 提交，不留悬空删除 |
| R-7 | **并行域中间态干扰**：browser-panel 等 M 状态文件与本维度文件邻接 | R4（McpSettingsTab 等） | 执行前 `git status` 核对并行域提交状态；邻接文件改动错峰 |

---

## 5. 总结论（⑤）

**终态裁决统计**：收敛 5（R4/R5/R6/R7/R10）、保留 4（R8/R9/R14/R18）、退役 1（R20）。

- **本轮 3 动作**：R20 退役（孤儿物理删除）、R5 收敛（滚动条 31 块契约化）、R9 命名对齐（handleStop 双轨纯改名）——全部为低风险机械面，不依赖视觉环境。
- **下轮 4 收敛**：R4（badge/pill 状态色）、R6（通知横幅多渠道）、R7（空态三件套）、R10（菜单键盘漫游）——组件级重构，L1 基件先行，L3/L4 严格排在 01 方案同域改造之后。
- **保留 4 项**：R8（滚动锚定，语义独立）、R9 本体（流式合并，管线稳定后立项）、R14（theme-dark 补丁）、R18（!important 633）——依赖视觉验证环境或流式管线稳定，登记条件触发，ratchet 门禁持续守门。

**验收前置**：本方案自身即任务书；执行时以 `rg` 实测为准（消费点计数口径见 §1 附注），W2 完成后 `SCROLLBAR_BASELINE` 与 03 基线同步下调，W1 完成后 `rg "VirtualList"` 业务代码零命中。

（本文档完——10 类 P2 挂账裁决落地：5 收敛 + 4 保留 + 1 退役，本轮 3 动作零风险，组件级收敛排下轮并串行避让）
