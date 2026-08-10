# 第二轮修复 · 收敛补刀维度 · 修复方案（60-repair2）

> 产出：方案设计子 Agent（只读 + 本文档产出，无代码改动）。
> 输入：`50-reverify/01-signoff-verification.md`（P1-1 退役不实 + mojibake 残留）、`50-reverify/02-convergence-thoroughness.md`（H1 props 三链 / H2 裸 button / H3 CapEditor；R11-R17 死代码清单）、`40-final-plan/10-details/03-component-system-detail.md`（v2，T16/T17 波次与纪律）、`00-cross-analysis.md`（P1-1/P1-12 原定义）。
> 性质：收敛补刀（「清零/聚合」声称与代码不符 3 处的收尾方案）；目标态「业务层裸 button = 0、.ui-btn 全局 CSS = 0、props 三链聚合、开关唯一来源」。
> 基线：2026-08-10 工作区实读（全部行号与计数均经 grep/读文件复核；行号执行前语义定位优先）。
> 验收前置：本文档自身即任务书；执行时以 `rg` 实测清单为准（口径见 §附）。
> 修订日志 v2（2026-08-10，吸收评审 `30-reviews/02-technical-correctness.md`）：
> 1. **A 块补登 3 处漏登**：A5 扩段补 settings-base.css:1186-1192 独立 `.settings-list-stack-actions` 块（评审 §1.1 A5「漏登 1」）；新增 A13/A14 = settings-plugins.css:1016/:1038 混合块内 `.settings-preset-chip` 死成员拆行删（评审 §1.1「漏登 2」）；A7 按 03 方案 N4 修正为删 3 个选择器行（models-btn 一并删，原「14 处消费」实为 settings-btn-rect）；
> 2. **B 块补 ribbons 构造点设计**：ChatStatusRibbons 传参 3 类 ChatComposerWrapper 内部派生（localHasKey 模块级函数 / openSidePanel 闭包 / goalMode 派生）上移决策 + 两案裁决（评审 §1.1「B 块构造点缺口」、R-3）；
> 3. **修正 memo 风险机制描述**：B1/B2 spread 面内联新建不破 memo（字段浅比较，与平铺等价），真敏感面是 B3 的 `ribbons` 单 prop 字段；且现状 composerElement（ChatCard:41-93）内联新建已破 ChatComposerWrapper memo，B3 不引入额外成本（评审 §1.1「B 风险 1」）；
> 4. **批次引用**：与总方案 v1.0 映射 A→R2-2 / B→R2-5 / C→R2-6 / D→R2-8（见 §5）；
> 5. C 块域分布差异（sidebar 9→5、session-list 4 文件未列等）登记为目录归类口径差，总数恒 101，波次派单前 `rg` 实测重扫定稿（评审 §4 ④）。

---

## 0. 结论速览

| 块 | 复审判定 | 本轮动作 | 规模（实读） | 分步 |
|---|---|---|---|---|
| A | P1-1 退役不实 / R11-R12 | `.ui-btn` 与 `settings-switch` 死 CSS 物理删除 | 6 文件、约 28 条规则/选择器（v2 补 3 处：:1186-1192 / :1016 / :1038） | 2 步 |
| B | H1 / P1-12 声称 ✅ 不实 | props 三链聚合对象 spread（不删减、不改行为） | 3 链、4 文件接口 + 2 文件消费点 | 3 步 |
| C | H2 / P1-1 清零不实 | 裸 `<button>` 业务层清零（复用 T16 波次表重排） | 实测 **101 业务文件**（2026-08-10） | 6 波 |
| D | H3 / P1-4 部分落地 | CapEditor checkbox → ui/Switch | 1 文件（CapEditor.tsx，2 消费点） | 1 步 |

**一句话**：CSS 死代码物理删除（A）、props 三链聚合（B）、裸 button 六波清零（C）、CapEditor 开关归位（D），共 4 块 12 步，收尾后「清零/聚合」四类声称全部可机器验证。

---

## 1. A 块：`.ui-btn` / `settings-switch` 死 CSS 物理删除

### 1.1 现状清单（2026-08-10 实读）

**tsx 消费面已清零（前置成立）**：全仓 tsx 中 `ui-btn` 仅存于 `components/ui/Button/Button.tsx:4,25` 注释；`settings-switch` 仅存于 `ui/Switch/Switch.tsx:4` 与 `Switch.module.css:2` 注释。**无任何生产选择器消费**（含 ui/Button 自身——Button.module.css 全用私有类）。scripts/ 与 `style-contract.test.ts` 均无 `ui-btn`/`settings-switch` 引用（rg 实测）→ 删除不触发任何既有门禁，也无需同步门禁。

**待删规则清单（逐条实读）**：

| # | 文件:行 | 规则 | 死因（判据） |
|---|---|---|---|
| A1 | `styles/shell/shell-polish.css:17-86` | `.ui-btn` 全局体系 11 条（:18 / :32 -sm / :39 -md / :45 -primary / :49 -primary:hover / :54 -secondary / :60 -secondary:hover / :65 -ghost / :75 -ghost:hover / :79 -ghost.danger:hover / :84 -block）+ 段注释 :17 | tsx 零消费；**删段边界按评审修正**：规则体 :18-86（:86 为 .ui-btn-block 闭合 `}`，删至 :85 会遗留悬空 `}`），整段删 :17-86 |
| A2 | `components/diff/DiffCard.module.css:368` | `.applyActions :global(.ui-btn),` 与 `.applyBtn` 共用声明块（:368-378） | **applyActions/applyBtn 均全仓 tsx 零命中**（rg 实测）→ 整块 :368-378 删除，非只删选择器行 |
| A3 | `styles/settings/settings-base.css:555` | `.sched-settings-row .ui-btn { flex-shrink: 0; }` | 前置类 sched-settings-row 仅剩 -name/-schedule 子类消费（WorkflowList.tsx:71,76），`.ui-btn` 零消费 |
| A4 | `styles/settings/settings-base.css:816` | `.settings-security-icon-btn.ui-btn { … }` | settings-security-icon-btn tsx 零命中 |
| A5 | `styles/settings/settings-base.css:1186-1192,1194-1210` | 独立块 `.settings-list-stack-actions`（:1186-1192，display/flex 布局 5 声明）+ `.settings-preset-chips, .settings-list-stack-actions` 块（:1194-1197）+ `.settings-list-stack-actions .ui-btn.settings-preset-chip, .settings-preset-chip, .settings-list-stack-actions .ui-btn` 块（:1198-1210） | settings-preset-chip(s)/settings-list-stack-actions **均 tsx 零命中**（整块死，不只 .ui-btn 行）；**:1186-1192 为 v2 扩段**（评审漏登 1，同选择器同死） |
| A6 | `styles/settings/settings-base.css:367-368` | 「按钮统一说明（T05.5.2）」注释段 | 历史说明失效（体系已删），顺带清理；可保留若作历史注记——**默认删**，评审可留 |
| A7 | `styles/settings/settings-plugins.css:986-991` | `.settings-pane .ui-btn, .settings-pane .ui-btn-sm, .settings-pane .models-btn, .settings-btn-rect { border-radius: var(--radius-xl) !important; }` | ⚠️ **混合块**：`.settings-pane .ui-btn` / `.ui-btn-sm` / `.models-btn` **三个选择器死**（models-btn 全仓 tsx 零消费，03 方案 N4 修正；原「14 处消费」实为 settings-btn-rect），仅 `.settings-btn-rect` 活（3 文件 14 处）→ **删 3 个选择器行，保留 settings-btn-rect 行与块体**（v2 按 03 N4 口径修正） |
| A8 | `styles/settings/settings-plugins.css:998-1005` | `.settings-pane .ui-btn-ghost` + `:hover` 两条 | 死 |
| A9 | `styles/settings/settings-advanced.css:472` | `.settings-pane--rules .ui-btn.danger:hover { … }` | 前置类 `.settings-pane--rules` 仍消费（SettingsRulesTab.tsx:94 实读），但 `.ui-btn` 零消费 → 规则死 |
| A10 | `styles/settings/settings-base.css:552,723,2362-2416` | `settings-switch` 死规则 4 段：:552（.sched-settings-row .settings-switch）、:723（.settings-switch--personalize）、:2362-2416（主定义块 + dark 分支，含 :2392:checked / :2401:focus-visible / :2411-2416 dark） | tsx 零消费（R12）；执行时读上下文，若块内混有活规则则拆行（:2362 区域以 `rg -l settings-switch` 复核） |
| A11 | `styles/settings/settings-plugins.css:715` | `.settings-switch:focus-visible`（混入某块，执行时读上下文拆行） | 死 |
| A12 | `styles/theme-dark.css:126-134` | `:where(html[data-theme="dark"]) .settings-switch` 三条（:126/:130/:134） | 死（R12） |
| A13 | `styles/settings/settings-plugins.css:1016` | 混合块 :1011-1025 内 `.settings-preset-chip` 死成员 | ⚠️ **混合块**：块内含活成员 settings-chip-btn（3 消费）/settings-rule-preset/sched-preset-chip → **拆行删 :1016**（v2 新增，评审漏登 2） |
| A14 | `styles/settings/settings-plugins.css:1038` | hover 混合块 :1034-1040 内 `.settings-preset-chip:hover` 死成员 | 同上，块内含活成员 sched-preset-chip/settings-chip/settings-chip-btn hover → **拆行删 :1038**（v2 新增，评审漏登 2） |

### 1.2 目标态

- `rg -n "\.ui-btn|settings-switch" apps/crish-desktop/src/styles`（排除注释）**零命中**；
- `rg "applyBtn|applyActions" apps/crish-desktop/src --glob "*.tsx"` 零命中维持；
- `rg -n "settings-preset-chip|settings-list-stack-actions" apps/crish-desktop/src/styles`（排除注释）**零命中**（v2 新增面：A5 扩段 + A13/A14）；
- 保留活面不动：settings-plugins.css:989 的 settings-btn-rect 行与块体（models-btn 与 ui-btn 族一并删）、settings-base.css 其它非 settings-switch 段。

### 1.3 分步

**A-1 步（全局体系 + diff 面，1 提交）**：删 shell-polish.css:17-86 整段（A1，含段头注释 :17 至规则体闭合 `}` :86）+ DiffCard.module.css:368-378 整块（A2）。
**A-2 步（settings 面，1 提交）**：A3-A14 全部；A7/A13/A14 拆行删（settings-plugins.css :986/:1011/:1034 三处混合块逐块读上下文）；A5 两段（:1186-1192 与 :1194-1210）一并删；执行时逐块读上下文，确认无活规则混入（尤其 :1194-1210、:2362-2416、:715 所在块）。

### 1.4 验证 / 判据

| 验证 | 方式 |
|---|---|
| 删除判据 | `rg -n "\.ui-btn" apps/crish-desktop/src --glob "*.css" --glob "*.tsx"` = 仅 Button.tsx/Button.module.css 注释命中（登记放行）；`rg "settings-switch"` = 仅 tokens.css:40 / Switch.tsx:4 / Switch.module.css:2 注释命中；`rg -n "settings-preset-chip|settings-list-stack-actions" apps/crish-desktop/src/styles`（排除注释）= 0（v2 新增面） |
| 零消费复核（前置） | `rg -l "ui-btn" --glob "*.tsx"` 生产代码 = 0（实读已成立，删前再跑一遍确认工作区未变） |
| 门禁联动 | `style-contract.test.ts` 无引用（已确认）→ 无需同步；删后跑 `npx vitest run src/styles/style-contract.test.ts` 23/23 绿 |
| 回归 | `npm run typecheck` + 快层单元测试 + `npm run check:ui-layer`；settings-规则页 / 任务计划页视觉抽查（WorkflowList 行） |

**完成判据**：A1-A14 全部物理删除；上表 grep 判据绿；style-contract 23/23；行为变更登记 = 0（纯死代码删除）。

---

## 2. B 块：props drilling 三链聚合（P1-12 补刀）

### 2.1 现状清单（实读）

| 链 | 消费点 | 接口面 | 现状 |
|---|---|---|---|
| B1 | ChatCard.tsx:41-92 → `<ChatComposer>` | ChatComposer 接口平铺 | `state.composerProps.xxx` 逐字段拆包 30 处（chatInput/setChatInput/isComposing/…/attachments 等），另有 isProcessing（:62）/permissionMode（:69）/onPermissionChange（:70-72）/onOpenSchedule（:73-75）/rightActions（:81-91）独立传参 |
| B2 | ChatCard.tsx:172-197 → `<ChatMessageList>` | ChatMessageListProps 25 字段（ChatMessageList.tsx:38-70） | 25 个平铺 prop（messages/allMessages/agents/activeSessionId/…/onBatchDeny） |
| B3 | ChatComposerWrapper.tsx:82-113 → `<ChatStatusRibbons>` | ChatComposerWrapperProps 29 字段（ChatComposerWrapper.tsx:11-41）；ChatStatusRibbonsProps 31 字段（ChatStatusRibbons.tsx:50-114） | ChatComposerWrapper 内部逐项展开 30 个（onOpenTerminal/…/onShowToast），另夹 **3 类内部派生**：① `localHasKey={anyProfileHasKey()}`（:90，模块级函数调用）② `onOpenTerminal/onOpenDiff` 闭包包装 `openSidePanel`（:83-84）③ goalText/goalIteration/goalTasksDone/goalTasksTotal 从 goalMode 派生（:97-100）——**构造点裁决见 §2.2** |

**关键 memo 面（实读，v2 修正机制分层）**：`ChatMessageList = React.memo(ChatMessageListInner)`（ChatMessageList.tsx:368）；`ChatComposerWrapper = React.memo(...)`（ChatComposerWrapper.tsx:43）；ChatCard 自身 React.memo（ChatCard.tsx:32）；ChatStatusRibbons **非 memo**（ChatStatusRibbons.tsx:121 直接导出函数组件）。→ **B1/B2（spread 展开面）内联新建聚合对象不破 memo**：spread 后 React 按字段浅比较，与现状平铺语义等价；**真敏感面是 B3 的 `ribbons` 作为单 prop 字段传入 memo 的 ChatComposerWrapper**——内联新建即引用变化触发重渲染。且现状 `composerElement`（ChatCard:41-93 内联新建 ReactElement）**已破** ChatComposerWrapper memo——B3 不引入额外成本（详见 §2.4 风险 1）。

**既有测试面（回归资产）**：ChatStatusRibbons.ribbon.test.ts / .setupHint.test.ts、ChatMessageList.windowScan.test.tsx、MessageVirtualizer.memo.test.tsx、useChatCardState.scoped.test.tsx（rg 实测）。

### 2.2 目标态

- B1：`<ChatComposer {...state.composerProps} isProcessing={state.isProcessing} permissionMode={state.permissionMode} onPermissionChange={...} onOpenSchedule={...} />`（03-detail T17 已定改造要点；rightActions 不变）；
- B2：ChatCard 调用点改 `{...messageListProps}` 聚合对象 spread（对象由 useChatCardState 返回或 useMemo 提供稳定引用）；
- B3：ChatComposerWrapperProps 新增 `ribbons: ChatStatusRibbonsProps` 分组字段，内部消费改 `{...ribbons}`；非 ribbons 字段（mainSurface/composerElement/runNotice/onDismissRunNotice/approval 族等）保持平铺；调用方 ChatCard.tsx:201-241 同步传聚合对象。
- **ribbons 构造点（v2 补，评审 B 块构造点缺口，派单前裁决）**：ChatStatusRibbons 传参含 3 类 ChatComposerWrapper 内部派生（§2.1 B3），构造点两案：
  - **案甲（推荐，ChatCard 层构造）**：3 类派生全部上移——① `anyProfileHasKey()` 上移 ChatCard 调用点或 useChatCardState（模块级函数，调用稳定）；② `onOpenTerminal/onOpenDiff` 闭包在 ChatCard 调用点以 `state.openSidePanel` 包装（:239 已有 openSidePanel prop）；③ goalMode 四派生值在 useChatCardState 内计算（goalMode 已在该处，纯函数派生）。ribbons 对象以 useMemo 稳定引用（依赖数组 = 全部字段来源）。符合「聚合对象由调用方传」目标态。
  - **案乙（ChatComposerWrapper 内 useMemo 拼装）**：ribbons 分组字段保留为接口契约、内部 useMemo 构造——与「聚合对象由调用方传」目标矛盾、分组字段形同虚设，仅当案甲导致 ChatCard 重渲染面失控时退守。
  - 缓冲面：ChatStatusRibbons 非 memo，构造点选择不影响其自身重渲染成本；决定权在 ChatComposerWrapper 的 memo 面（见 §2.4 风险 1）。
- 三链均为**聚合对象 spread，零删减、零行为变更**；接口字段总数不增不减（签名兼容）。

### 2.3 分步（3 步，每步独立提交）

| 步 | 内容 | 文件面 | 冲突面 |
|---|---|---|---|
| B-1（基座先行） | ChatComposerWrapper 接口加 `ribbons` 分组 + 内部 ChatStatusRibbons 消费改 spread；ChatStatusRibbons 接口不动（31 字段已是 ribbons 组的形状）；按 §2.2 裁决的构造点执行——案甲：派生上移 + ribbons useMemo，案乙：内部 useMemo 拼装 | ChatComposerWrapper.tsx（案甲另触 useChatCardState.ts） | 与 C 块 W2（chat-card 域）同文件 → 串行 |
| B-2 | ChatCard 三处调用点改造：composerElement（B1 spread）、ChatMessageList（B2 spread）、ChatComposerWrapper（传 ribbons 对象）；聚合对象稳定引用处理（useChatCardState 返回或 useMemo） | ChatCard.tsx + useChatCardState.ts | 同上 |
| B-3 | 收尾验证批：行为核对表签字 + memo 回归 + typecheck | 无新代码面 | — |

> 顺序依据：B-1 先行（接口面独立，ChatCard 调用点是三条链汇聚点最后改）；B-2 一步改完三处（避免中间态半聚合）；B-3 收尾。

### 2.4 风险（本块专属）

1. **memo 失效**（v2 修正口径，评审 §1.1 B 风险 1——分面论）：**B1/B2（spread 面）无敏感**：聚合对象 spread 展开后 React 按字段浅比较，与现状平铺语义等价，内联新建对象本身不破 memo；仅要求字段引用稳定（handler 来自 hook/useCallback，现状已满足）。**B3（单 prop 字段面）真敏感**：`ribbons` 作为单个 prop 字段传入 memo 的 ChatComposerWrapper（:43），内联新建 → 引用变化 → ChatComposerWrapper 重渲染（连带 ChatStatusRibbons）——ribbons 必须稳定引用（案甲 useMemo / 案乙内部 useMemo）。**既有成本已存在**：composerElement（ChatCard:41-93 内联新建 ReactElement）已破 ChatComposerWrapper memo，B3 不引入额外成本；B-3 步可顺手将 composerElement 稳定化（useMemo）顺带修复既有失效。B1 的 `state.composerProps` 来自 useChatComposerProps（useChatCardState.ts:305），执行时确认其返回对象是否 useMemo 稳定，若否登记。验收 = `MessageVirtualizer.memo.test.tsx` + 既有流式渲染 memo 测试不破。
2. **exactOptionalPropertyTypes**：spread 后可选字段（B2 的 onSendFollowUp/onBatchApprove 等 7 个可选、B3 的 needsModelSetup 等）类型收窄差异 → 以 typecheck 为准逐字段调（聚合对象内显式 `undefined` 或改接口，登记差异）。
3. **调用方测试同步**：ChatCard/useChatCardState/ChatComposerWrapper/ChatStatusRibbons 相关测试若直接断言 props 展开形态（实读为行为断言为主，风险低），改后跑全量 vitest 确认；测试文件不删（AGENTS.md 铁律）。
4. **接口与解构漂移**：ChatComposerWrapperProps 现已有 2 个声明未解构的死字段（见 §6 新发现 N1），聚合时顺带清理并登记。

### 2.5 验证 / 判据

- typecheck 绿；`npm run test:coverage -- --project=unit` 快层全绿；`npm run test` 全量 vitest 绿（B-3 收尾批）；
- 聚合后 props 传递语义核对表签字（逐 prop：对象内字段与平铺时一一对应）；
- memo 回归：MessageVirtualizer.memo.test.tsx 绿 + 重渲染面不扩大（性能采样与 08 T-H 共用基线口径）；
- 行为变更登记 = 0。

---

## 3. C 块：裸 `<button>` 业务层清零（H2，复用 T16 波次框架）

### 3.1 现状清单（2026-08-10 实读）

- 全仓 `rg -l "<button" --glob "*.tsx"` components/ 下（排除 ui/ 原子层与测试）实测 **101 个业务文件**（02 复审口径 102、03 计划基线 116——差异 = T7 与部分 T8 已合入的时点差；**T16 的 6 子波整体未执行**）。
- ui/Button 已接管 42 业务文件（`import { Button, … } from '../ui'` 实读 42 命中）；ui/Button 能力面：variant 4 种（primary/secondary/ghost/danger）、size 2 种（sm/md）、icon/loading/block（Button.tsx:13-27 实读）。

**域分布（实读重扫，101 文件）**：

| 域 | 文件数 | 域 | 文件数 |
|---|---|---|---|
| chat-card | 11 | chat-tool-call | 3 |
| settings | 10 | settings-models | 3 |
| sidebar | 9 | binary-tree | 2 |
| overview | 8 | card-panel | 2 |
| workspace | 8 | chat-message-row | 2 |
| chat-composer | 7 | bg-tasks | 2 |
| files | 6 | settings-mcp | 1 |
| diff | 5 | settings-extensions | 1 |
| agent-card | 5 | provider | 1 |
| root（components/） | 5 | chat-message-list | 1 |
| settings-skills | 4 | shell | 1 |
| overlay | 4 | **合计** | **101** |

### 3.2 目标态

- 业务层（components/ 生产代码，排除豁免面）`rg "<button"` = **0**；
- 所有裸按钮按语义判定规则表归入 ui/Button 四变体；私有 module 类仅保留布局微调（颜色/背景语义归 tokens）。

### 3.3 分步（6 波，按域聚批，≤20 文件/波）

| 波 | 域面（文件数） | 预算 | 备注 |
|---|---|---|---|
| C-W1 | settings 10 + settings-models 3 + settings-skills 4 + settings-mcp 1 + settings-extensions 1 | 19 | settings 系零残留判据；T8 未完成面在此收尾 |
| C-W2 | chat-card 11 + chat-message-row 2 + chat-message-list 1 | 14 | chat 域第一波；**与 B 块同文件串行（B 先行）** |
| C-W3 | chat-composer 7 + chat-tool-call 3 + provider 1 | 11 | chat 域第二波 |
| C-W4 | workspace 8 + overview 8 + bg-tasks 2 + shell 1 | 19 | 壳/状态区 |
| C-W5 | sidebar 9 + files 6 + diff 5 | 20 | 超 T16 原计划域内拆（overlay 移 W6） |
| C-W6 | agent-card 5 + card-panel 2 + binary-tree 2 + overlay 4 + root 5 | 18 | 收尾波 + 清零扫描 |

**每波文件清单原则**（沿用 03-detail T16，实读口径重排）：
1. 派单前以 `rg -l "<button" --glob "*.tsx"` 实测重扫定稿；单域超 20 域内再拆；波间文件面不重叠。
2. 复用 T8 语义判定规则表（03-detail 2.4 表）：danger（delete/remove/clear/reset）/ ghost（淡染低强调）/ primary（save/submit/apply/confirm）/ secondary（其余）；`role="tab"` tabClose 不替换。
3. 替换红线：只改标签名与 className 段，保留 aria-label/aria-pressed/type/data-*/role 属性行；`type="button"` 由 Button 默认值保证。
4. R-07 交接：替换面顺带补 aria-label（16 个无名称按钮清单在案的先补），输出「迁移后仍无名称按钮清单」移交 08 批次 4.3 口径。
5. 每波独立提交。

### 3.4 豁免面登记（不计入清零判据）

| 豁免类别 | 判定特征 | 归属 |
|---|---|---|
| `role="tab"` 的 tabClose | 归 T12 TabStrip 收敛（UnitSessionTabStrip/LeafToolTabStrip/GlobalSessionTabBar/SessionStrip/WorkspaceStrip 内） | 既有豁免 |
| 编辑器域内部 button | tiptap 工具栏（TiptapComposerField/TiptapSlashMenu 内第三方/工具栏按钮） | 既有豁免 |
| ui/ 原子层自身 | Button/Switch/Menu/Dialog/Select/Input 内部原生 button | 原子层不替换 |
| **自定义形态控件族（新增登记面）** | **segment/chip/pill 选择态控件**：PermissionModeMenu 权限 segment、SettingsSchemaRenderer.tsx:219 segment 单选组、SettingsSecurityTab.tsx:371 白名单快添 chip、UnitSessionTabStrip tab 本体、mrdCapPill（CapEditor 归 D 块）等「选择态」而非「动作态」按钮 | **保持私有，不迁移 ui/Button**；它们不是按钮语义，是单选/切换语义（部分已 role=switch / aria-pressed） |

### 3.5 与 ui/Button 扩展点关系（扩展性决策）

| 形态 | 决策 | 理由 |
|---|---|---|
| icon-only（图标×无文字×aria-label） | **现有能力覆盖**（icon 插槽 + children 空，aria-label 必填）——不新增 variant | Button.tsx 已支持；R-07 补名即可 |
| 危险操作 | danger variant 已有 | — |
| loading 异步态 | loading prop 已有（文案「动词+中…」约定） | — |
| 通栏 | block 已有 | — |
| 新 variant（含颜色语义） | **不新增**；穷举面 = 现 4 变体 | 「2 个消费点才升格」+ 颜色归 tokens |
| 尺寸变体（现 sm/md） | 不新增；icon-only 统一 size 语义对齐 control-height-sm | T8 口径 |
| 布局微调 | 走 className（仅间距/尺寸类，禁颜色覆盖） | Button.tsx 扩展点纪律 |
| segment/chip/pill 选择态 | **不升格 ui/Button、不扩 variant**——保持业务私有类 | 语义不是按钮；过度抽象违背扩展性红线 |

### 3.6 验证 / 判据

- 每波：视觉回归抽样 3~5 按钮；变体判定规则表逐按钮签字（评审物）；波末该域 `rg "<button"` 清零；aria-label 补齐计数；键盘走查抽样（Tab 聚焦 + Enter 激活）；
- 每波门禁：typecheck + `npm run check:ui-layer` + 快层单元测试；
- 总判据：业务层 `rg "<button"`（components/ 生产代码，排除豁免面）= **0**；101 文件清零表 + 豁免登记表入最终提交说明；全波视觉抽样无差异。

---

## 4. D 块：CapEditor checkbox → ui/Switch（H3）

### 4.1 现状（实读）

- `settings-models/CapEditor.tsx:28-34`：`<input type="checkbox" style={{display:'none'}}>` + 私有 mrdCapPill pill 样式（ModelsSettingsTab.module.css），注释 :12 自认「T11 ui/Switch 基座合入后，此处结构重写为 <Switch>（当前保持 checkbox-pill 原状）」；
- 消费 2 处：ModelConfigPanel.tsx:72（T9 拆分产物，03-detail 时点未存在）、ManualAddForm.tsx:60；接口 `{ caps, onCapChange, disabled }`；
- ui/Switch 能力面（Switch.tsx 实读）：受控/非受控、aria-label、disabled、size sm/md、label、id、className；**无 pill/胶囊形态**（track+thumb 轨道样式，thumb 走 --radius-full）。

### 4.2 目标态

- CapEditor 内部改 ui/Switch；caps/onCapChange 回调签名不变（消费方零改动）；
- 全仓 `role="switch"` 唯一来源 = ui/Switch（含 CapEditor 面）；mrdCapPill 的 checkbox 私有结构删除（样式随用随清）。

### 4.3 分步（1 步 1 提交）

**D-1**：CapEditor.tsx 结构重写为 `<Switch size="sm" checked={on} disabled={disabled} onCheckedChange={(c) => onCapChange(opt.key, c)} aria-label={opt.label} />`（label 文案与 pill 文本关联：用 Switch 的 label prop 或 aria-label + 外部文本，执行时择一并登记）；ModelsSettingsTab.module.css 的 mrdCapPill 样式删除或保留为布局壳（视觉从 pill 变开关轨道，**视觉变化登记为预期**）。

> 形态决策点（供主控/评审裁决，不扩 ui/Switch variant）：cap 是布尔能力开关，role="switch" 语义正确 → 轨道形态替换 pill；若评审认为 pill 观感应保留，降级路径 = CapEditor 内组合（ui/Switch + 私有布局类 className 布局微调），仍满足「结构归 ui/Switch」。

### 4.4 验证 / 判据

- `rg "mrdCapPill"` 与 `rg "type=\"checkbox\"" apps/crish-desktop/src/components/settings-models` 清零；
- `rg "role=\"switch\""` 全仓来源唯一（ui/Switch）；
- ModelsSettingsTab / ManualAddForm cap 区人工回归（勾选/取消/禁用态）；SR 降级路径 = Playwright aria 快照 + 键盘走查（Space/Enter 切换）；
- typecheck + 快层测试绿。

---

## 5. 执行顺序与依赖

```
A（CSS 死代码删除）── 前置：tsx 消费清零（已成立，A-1 开工前再 grep 复核）
   │
   ├── C（裸 button 6 波）── 逻辑依赖 A 完成（裸 button 判定在「已无全局类」基线上，
   │        与 03-detail T7 前置口径一致）；C-W2/W3 与 B 同文件串行
   │
   B（props 三链聚合）── 独立；但 B-2 的 ChatCard.tsx 与 C-W2 的 chat-card 域重叠
        → 建议 **B 先行、C-W2/W3 后行**（T17 前置口径「聚合在清零面上做」反序，因
          B 改接口面、C 只改标签/类名段，先聚合则 C 波内 diff 更小；同文件串行纪律
          以主控派单核对表为准）
   │
   D（CapEditor → Switch）── 独立小任务，与 C-W1（settings-models 域）文件面不重叠
        （ModelConfigPanel/ManualAddForm 无裸 button），可穿插任意空档
```

**建议总序**：A-1 → A-2 → B-1 → B-2 → B-3 → C-W1 → C-W2 … C-W6 → D-1（D 可提前至 C 前或与任一波间并行——无文件面冲突）。
**与总方案 v1.0 批次映射（master plan 00，v2 标注）**：A 块 = 批次 **R2-2**（与 03 方案 D 块基线联动同提交原子化，见 03 §4.3；并同步清理 03 白名单对应行号）；B 块 = 批次 **R2-5**（依赖 R2-4 完成——useStreamCallbacks 稳定后动 ChatCard 面；与 R2-6 串行，R2-5 先）；C 块 = 批次 **R2-6**（与 R2-5 同文件面串行）；D 块 = 批次 **R2-8**（与收尾批合并）。本方案内部序号即批次内执行序。
**可并行组合**（多 Agent 时）：A ↔ B 文件面全错开可并行；D ↔ C-W1 可并行；B ↔ C-W1 可并行。
**同文件串行登记**：ChatCard.tsx（B-2 与 C-W2）、ChatStatusRibbons.tsx / ChatComposerWrapper.tsx（B-1/B-2 与 C-W2）、ChatComposer.tsx / ChatMessageList.tsx（B 与 C-W2/C-W3）——同文件双任务必须串行，派单核对表签字。

每步输出即下步输入（闭环）：A 的 grep 判据 → C 的「无全局类基线」；B 的聚合后接口 → C 波内替换的红线属性行清单；C 的每波清零表 → 波末汇总清零总表；D 的 role="switch" 唯一来源 → 与 C 豁免面登记表共同构成开关/按钮语义总账。

---

## 6. 新发现补充（本方案实读时新增，标注「新发现」）

| # | 位置 | 内容 | 处置 |
|---|---|---|---|
| N1（新发现） | `ChatComposerWrapper.tsx:12,40` | **ChatComposerWrapperProps 中 `emptyKind`（:12）与 `handleGlobalTabClick`（:40）声明但从未解构、从未使用**（实读 :43-71 解构列表无此二字段）；ChatCard.tsx:203/240 仍在传 | B-1 聚合 ribbons 字段时顺带删除（声明+传参+调用方三处，登记为死 props 清理；删除后 ChatComposerWrapperProps 27 字段） |
| N2（新发现） | `styles/settings/settings-base.css:1186-1210` | 死代码范围比复审登记更大：`settings-preset-chips`/`settings-preset-chip`/`settings-list-stack-actions` **全部 tsx 零消费**（不只 .ui-btn 行）；含独立块 :1186-1192（v2 扩段） | A-5 整块删除（已入 A 清单） |
| N3（新发现，v2 修正） | `styles/settings/settings-plugins.css:986-991` | `.settings-pane .ui-btn` 删行时**不能整块删**——同块 settings-btn-rect 仍 14 处消费（复审未标注该混合块）；**models-btn 全仓零消费**（03 方案 N4），三个死选择器行一并删 | A-7 拆行删除（已入 A 清单） |
| N4（新发现） | `styles/settings/settings-plugins.css:253` | mojibake 注释（乱码 + 提及 .ui-btn） | A-2 步顺带重写/删除（R-11 补扫面外的新点；门禁升级见 01 复审 §3.3，不属本方案范围，登记移交） |
| N5（新发现） | 裸 button 实测 101 vs 02 复审 102 / 03 计划 116 | 数量差异 = T7 + 部分 T8 已合入（settings 域仍有 10 文件裸 button，T8 未完成面明确） | C 波次按 101 实测重排（W1 承接 settings 收尾） |
| N6（新发现，v2 修正） | `ChatMessageList.tsx:368` / `ChatComposerWrapper.tsx:43` | 两处 React.memo 均以 props 逐字段比较为默认行为——**spread 面（B1/B2）内联新建不失效（字段级浅比较）**；仅单 prop 字段面（B3 ribbons）内联新建失效；且 composerElement 现状内联新建已破 ChatComposerWrapper memo | B 风险 1 v2 口径：ribbons 稳定引用为强制（B3），B1/B2 为保守要求；composerElement 稳定化列为 B-3 可选收尾 |

---

## 7. 风险与回退

| # | 风险 | 触发场景 | 缓解 / 回退 |
|---|---|---|---|
| 1 | **CSS 删错活规则**（A7 混合块 / :2362 主块内混规则） | 块内含活选择器未识别 | 执行时逐块读上下文 + `rg -l` 前置类复核；删除后 settings 页视觉回归；回退 = 单提交 git revert |
| 2 | **memo 失效重渲染面扩大**（v2 修正：仅 B3 单 prop 字段面敏感） | B3 ribbons 对象内联创建 → ChatComposerWrapper memo 失效（连带 ChatStatusRibbons 重渲染）；B1/B2 spread 面内联不破 memo | ribbons 稳定引用强制（案甲 useMemo / 案乙内部 useMemo，§2.2）；composerElement 稳定化可选（B-3）；MessageVirtualizer.memo.test.tsx 回归；性能采样比对 |
| 3 | **exactOptionalPropertyTypes 类型收窄** | spread 后可选 prop 语义变化 | typecheck 逐字段调，登记差异；聚合接口字段数不变（签名兼容） |
| 4 | **变体判定误判**（danger/ghost/primary 分错） | 语义判定规则表签字走查不严 | 复用 T8 规则表；每波 3~5 按钮视觉抽样；单波可整波回退 |
| 5 | **R-07 aria 双补/漏补** | T16 顺带补名与 08 重扫边界 | 本方案只补替换面 + 输出「仍无名称清单」移交；禁止双向重复 |
| 6 | **同文件串行遗漏**（B×C、A×C 前置类复核） | 并行合并冲突 | 派单核对表签字（§5 登记面）；批次内显式串行 |
| 7 | **D 观感变化**（pill → 开关轨道） | CapEditor 视觉回归超预期 | 视觉变化登记为预期；评审可降级为「ui/Switch + 私有布局组合」路径 |
| 8 | **mojibake 补扫范围膨胀**（N4 等） | 顺手清理超出本方案边界 | 只清触碰文件内的乱码注释（A 面）；其余移交 R-11 门禁升级任务 |

**回退粒度**：每步一个 git revert，不连锁；门禁红（typecheck/快层/style-contract/check:ui-layer）即修复或整批回退，禁止 `--no-verify`。

---

## 附：口径与执行注意

1. 计数口径：`rg -l "<button" --glob "*.tsx" apps/crish-desktop/src/components --glob "!**/ui/**" --glob "!**/*.test.*"` = 101（2026-08-10）；02 复审 102 / 03 计划 116 为不同时点，以执行时实测重扫为准。
2. `.ui-btn` 规则条数：shell-polish.css:17-86 共 11 条规则 + 1 条段头注释（01 复审口径 12 条含注释），执行以删段（:17 注释起至 :86 规则体闭合 `}` 为止，评审修正口径）为准。
3. 所有 `:行号` 基于 2026-08-10 工作区，执行前语义定位优先；props 聚合的字段一一核对以 03-detail T17 类型级穷尽清单口径为准（B 块执行时可复用）。
4. 测试资产铁律：B 的调用方测试只改断言不删文件；C 波内无测试删除；新增校验脚本（如 style-contract 负向断言，可选增强）随步入库。
5. 本方案产出文档归属 60-repair2 轨道；评审人建议：30-reviews 复用既有评审纪律（变体判定表 / 行为核对表 / memo 回归为必审物）。

（本文档完——4 块 12 步：A 2 步 / B 3 步 / C 6 波 / D 1 步）
