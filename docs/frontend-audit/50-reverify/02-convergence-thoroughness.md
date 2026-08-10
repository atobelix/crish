# 前端收敛彻底性复审报告

> 复审性质：只读 + 实读代码（grep / 抽样 / 测试运行），全部结论带 `文件:行号` 证据。
> 复审日期：2026-08-10。
> 基线文档：`10-analysis/01-style-consistency-audit.md`（14 类同效果多实现）、`10-analysis/02-component-architecture-audit.md`（13 类组件重复）、`40-final-plan/90-final-report.md`（批次 9 宣称的收敛成果）。
> 复核方式：`rg` 全仓计数 + 关键文件逐行实读 + `style-contract.test.ts` 实际运行（23/23 绿）。

## 0. 结论摘要

- **样式 token 层收敛彻底**：用户可见的最大不一致源——text-primary 裸混色（423 处 / 31 档）已收敛至 module.css 仅 1 处登记例外；tab 四条复制粘贴实现、primary 四套长相、tooltip 双轨、菜单 10+ 壳层、useAnimatedPresence 双份、SettingsSelect 自研——全部实读确认收敛。
- **组件层部分收敛**：Tooltip / Switch / TabStrip / Select / Dialog 全量接管；Button 半量接管（42 文件用 ui/Button，但 102 文件仍裸 `<button>` + 私有类，未"清零"）；Input 建成但 0 消费。
- **"清零"类声称与代码不符（3 处）**：①P1-12 props drilling 聚合未落地（三条链仍平铺 25~30 props）；②"业务层裸 button 清零"不实（102 文件仍裸写）；③`.ui-btn` 退役删段未完成（CSS 死代码仍在）。
- **诚实挂账面确认**：滚动条 31 块、VirtualList 孤儿、通知多渠道、空态三件套等 8 类残留，报告均如实登记为 P2 挂账（B-P2-5），非隐瞒。
- **门禁真实拦截**：`style-contract.test.ts` 23 项（裸混色 ≤3 / 裸 999px ≤66 / scrollbar ≤31 / !important ≤633 / z-index / dark 覆盖 / 双层同源）实测全绿且为静态 ratchet，新增裸混色/新 scrollbar 块会直接变红。

---

## 1. 各收敛项现状统计（基线数 → 现状数）

| # | 收敛项 | 基线（01/02 审计） | 现状（2026-08-10 实读） | 判定 |
|---|---|---|---|---|
| 1 | text-primary 裸混色（module.css） | 423 处 / 31 档 | **1 处**（UnitSessionTabStrip.module.css:333，6% 登记例外） | ✅ 彻底 |
| 2 | text-primary 裸混色（全局 css） | —（含在 423 内） | 28 处：theme-dark.css 10（挂账补丁）、settings-models.css 15（域内 `--models-*` 变量定义）、settings-base.css:2370 + shell-polish.css:885（登记例外）、design-system.css:23（ratchet 白名单） | ⚠️ 模块层已清，全局层残余已登记 |
| 3 | `.ui-btn` 全局类消费（tsx） | 36 文件 | **0 处**（仅 Button.tsx:4,25 注释提及） | ✅ 业务层清零 |
| 4 | `.ui-btn` 全局类 CSS 规则 | shell-polish.css:18-86 服役 | **仍在**（12 条规则：.ui-btn/.ui-btn-sm/-md/-primary/-secondary/-ghost/-block 等） | ⚠️ 半吊子（"退役删段…后收尾"未完成） |
| 5 | ui/Button 消费 | 0 | **42 文件**（`from '../ui'` barrel） | ✅ 上岗 |
| 6 | 裸 `<button>`（非 ui/ 非测试） | 128 文件 | **102 文件**（MessageActionsBar / FileActions / GeneralSection / AppTopBar / DiffCard 系等） | ⚠️ 仍为主轨道，"清零"不实 |
| 7 | Tooltip | 旧 88 消费 / 新 4 | 旧目录已删（Test-Path False）；新 ui/Tooltip **95 消费**（barrel） | ✅ 全量接管 |
| 8 | useAnimatedPresence | hooks/ + ui/Dialog 双份 | hooks/ 版已删，仅 ui/Dialog 1 份 | ✅ |
| 9 | role="tab" 来源 | 6 处 | **1 处**（ui/TabStrip/TabStrip.tsx:291-292），5 消费点均 renderTab 自定义（UnitSessionTabStrip:257 / LeafToolTabStrip:159 / GlobalSessionTabBar:238 / SessionStrip:31 / WorkspaceStrip:54） | ✅ 唯一基座 |
| 10 | role="switch" | 全仓 0（无组件，5+ 手写） | ui/Switch 唯一来源（Switch.tsx:105 + aria-checked:106），6 文件消费（ModelList / DiffCard / ExtensionCard / McpServerList / SettingsSchemaRenderer / WorkflowList）；残余 aria-pressed 均为瞬时钮语义（SettingsSecurityTab:371 白名单快添 chip、SettingsShortcutsTab:483 录音钮、SettingsSchemaRenderer:219 segment 单选组） | ✅（含 CapEditor 残留，见 §3） |
| 11 | 菜单圆角 / hover | 6/8/10/12/16px 五档、5 种 hover 混色 | ui/Menu：`--dropdown-radius`/`--item-radius`/`--bg-hover`（Menu.module.css:14,45,55）；抽查 5 菜单全 token 化：PermissionModeMenu:105 `--bg-hover`、SettingsQuickMenu:119 `--bg-hover`、ComposePlusMenu:47 `--tint-hover`、TiptapSlashMenu:70 `--tint-active` | ✅ 基本收敛 |
| 12 | 滚动条 | 31 块 / 12+ 实现 | **仍 31 块**（12 文件，ratchet 基线 31 未动） | ⚠️ P2 挂账（报告如实登记 §7.3） |
| 13 | 徽标 / pill 状态色 | 4+ 套 | 仍多套：BgTaskCard `--accent-blue/green/danger/orange`（:64-92）、ChatStatusRibbons `color-mix(--accent-color 10%/30%)`（:65-66）、ModelsSettingsTab tint 系 + `color-mix(--color-active 12%)`（:207,275）、McpSettingsTab 独立一套 | ⚠️ P2-5 挂账（报告如实登记） |
| 14 | props drilling | 3 条链 30 props | **3 条链仍平铺**（详见 §3） | ❌ 声称 ✅ 与代码不符 |
| 15 | SettingsSelect | 自研组件 | **已删**；ui/Select **8 消费**（McpServerForm / SkillsSettingsTab / DiffHeaderControls / DiffCardFileList / SettingsRulesTab / SettingsSchemaRenderer / SettingsSecurityTab / WorkflowForm） | ✅ |
| 16 | ui barrel | 2/6 组件 | **8 组件全导出**（Dialog/Tooltip/Button/Input/Menu/Select/ConfirmDialog/Switch/TabStrip） | ✅ |
| 17 | ui/Input 消费 | 0 | **仍 0**；`settings-field-input` 全局类仍 12 文件服役 | ⚠️ 半吊子（报告未声称，02 P1-7 未入销号面） |
| 18 | P0 渲染无效面 | --accent-*-light-adaptive 悬空、--tooltip-translate 悬空、.card-tab.active 双声明 | DiffCard.module.css:583/740/743 已带 fallback + tokens.css:82-83/:506-507 定义；ui/Tooltip/Tooltip.module.css:21-36 `var(--tooltip-translate, translate(0))`；shell-workspace.css:219/419 `.card-tab.active` 单声明 | ✅ 实读确认修复 |
| 19 | 菜单键盘漫游 | ui/Menu 内置 + SidebarContextMenus 自研双实现 | SidebarContextMenus 仍在（P2-6 挂账） | ⚠️ 如实挂账 |
| 20 | VirtualList 孤儿 | 存在 | 仍存在（P2 挂账） | ⚠️ 如实挂账 |

---

## 2. 残留多实现清单（文件:行号）

### 2.1 用户可见层（影响"同一效果多种呈现"痛点）

| # | 残留多实现 | 证据 | 性质 |
|---|---|---|---|
| R1 | 裸按钮轨 vs ui/Button 轨并存 | 裸 `<button>` 102 文件（MessageActionsBar.tsx:44,55,67,112… / FileActions.tsx:72-90 / GeneralSection.tsx:59,76,92 / AppTopBar.tsx:49-121 / FileViewerCard / DiffCard 系…）；ui/Button 42 文件 | ⚠️ 声称清零不实 |
| R2 | 开关双实现 | ui/Switch（Switch.tsx:105）vs CapEditor checkbox-pill（CapEditor.tsx:26-29 `<input type="checkbox">` + mrdCapPill，注释 :12 自认"结构重写为 <Switch>（当前保持 checkbox-pill 原状）"） | ⚠️ 半吊子 |
| R3 | 输入三轨 | ui/Input（0 消费）+ `settings-field-input` 全局类（12 文件）+ 各 tab 私有类 | ⚠️ 半吊子 |
| R4 | badge/pill 多套状态色 | BgTaskCard.module.css:64-92 / ChatStatusRibbons.module.css:38-74 / ModelsSettingsTab.module.css:113-123,199-212 / McpSettingsTab.module.css:28-57 / PermissionModeMenu.module.css:1-24 | ⚠️ P2-5 挂账 |
| R5 | 滚动条 12+ 实现 | 31 块：LeafToolTabStrip.module.css:43-50（3px/18%）、TiptapSlashMenu.module.css:33-39（2px）、ChatQueuePanel.module.css:15-22、TiptapEditorField.module.css:196-205、SettingsSelect 已删但其文件…、shell-scrollbar.css:32-47（全局 4px/10%）等 | ⚠️ P2 挂账 |
| R6 | 通知横幅多渠道 | RunNoticeBar / SetupHintBanner / PlanGoalRibbons / ApprovalDock / AgentCard daemon 横幅 | ⚠️ 02-E2 挂账 |
| R7 | 空态三件套 | ChatEmptyState / WorkspaceEmptyState / PanelBodyEmpty | ⚠️ P2-1 挂账 |
| R8 | 滚动锚定双套 | hooks/useChatAutoScroll vs chat-message-list/useScrollAnchor（ChatMessageList.tsx:33 仍直用） | ⚠️ P2-4 挂账 |
| R9 | 流式双轨 | useChatStream（chat-stream/index.ts）vs useAgentStream（handleStop/handleForceStop 命名自认不同步） | ⚠️ P2-7 挂账 |
| R10 | 菜单键盘漫游双套 | ui/Menu/Menu.tsx:102-119 内置 vs SidebarContextMenus 自研（ContextMenuFlyout.tsx 在） | ⚠️ P2-6 挂账 |

### 2.2 死代码 / 半退役层（不影响观感，影响维护）

| # | 残留 | 证据 | 性质 |
|---|---|---|---|
| R11 | `.ui-btn` 全局类 CSS 死代码 | shell-polish.css:18-86（12 条规则，tsx 零消费） | ⚠️ "退役删段…后收尾"未完成 |
| R12 | `settings-switch` 全局 CSS 死规则 | settings-base.css:552,723、theme-dark.css:126-134（tsx 零消费，Switch.tsx 注释仅提及） | ⚠️ 半吊子 |
| R13 | ui/Input 建成未上岗 | components/ui/Input/Input.tsx 存在，barrel 已导出，业务 0 消费 | ⚠️ 半吊子 |
| R14 | theme-dark.css 补丁式混色 | theme-dark.css:97,144,156,163-179,215,226（10 处 text-primary 直接混色，ratchet 豁免文件） | ⚠️ 挂账（§7.2，迁移需视觉环境） |
| R15 | settings-models.css 域内局部混色变量 | settings-models.css:1012-1015,1320-1324,1428,1465-1467,1602-1603（`--models-*` 15 个变量，3.5%~11% 非标准档） | ⚠️ 未登记（非 text-primary 消费点口径外，但同属"非 tint 派生"） |
| R16 | 菜单硬编码圆角残余 | ComposePlusMenu.module.css:111（7px）、SettingsQuickMenu.module.css:80（999px pill）、TiptapSlashMenu.module.css:38（2px 滚动条拇指）、PermissionModeMenu.module.css:47（50% 圆点） | ⚠️ 零星，可接受 |
| R17 | TabStrip 消费点呈现差异 | 5 消费点各自 renderTab 自绘 tabMain/tabClose（GlobalSessionTabBar.tsx:238-260 自绘关闭钮 + tabClassName 私有样式 GlobalSessionTabBar.module.css:127-186） | ⚠️ 结构已收敛，观感仍各写各的（renderTab 契约允许） |

---

## 3. 半吊子状态清单（声称销号但实读未落）

| # | 项 | 报告声称 | 实读结论 | 证据 |
|---|---|---|---|---|
| H1 | **props drilling 治理（P1-12）** | ✅ "ChatMessageList 聚合（批次 8 前置面）" | **未聚合**。三条链全部仍平铺：①ChatCard → ChatComposer 逐字段拆包 `state.composerProps.xxx` 25+ 个 prop（ChatCard.tsx:41-92）；②ChatCard → ChatMessageList 25 个平铺 prop（ChatCard.tsx:172-197，接口仍 30+ 字段 ChatMessageList.tsx:38-70）；③ChatComposerWrapper → ChatStatusRibbons 27 个平铺 prop（ChatComposerWrapper.tsx:82-113，接口 ChatStatusRibbons.tsx:50-114 仍 27+ 字段）。02 审计 §2.2 点名的"聚合对象拆包回传"模式逐字仍在 | ❌ 未落地 |
| H2 | **按钮三轨收敛（P1-1）** | ✅ "业务层裸 button 清零面由 02 域批次 3 提交" | 裸 `<button>` 仍有 102 文件（非 ui/ 非测试），且 `.ui-btn` CSS 删段未执行 | ❌ 部分落地 |
| H3 | **开关收敛（P1-4）** | ✅ "ui/Switch 接管（T11）" | ui/Switch 已上岗，但 CapEditor.tsx:12 注释自认"当前保持 checkbox-pill 原状"——自研 checkbox 开关未迁移 | ⚠️ 部分落地 |
| H4 | 菜单/滚动条/卡片族收敛（P1-11） | ✅ 销号 | 菜单半径/hover 已 token 化属实；但**滚动条 31 块未动**（同一销号条目内的滚动条面实际转挂 §7.3 P2） | ⚠️ 部分落地（已登记） |
| H5 | 输入四轨（02 P1-7） | 未声称 | ui/Input 0 消费 + settings-field-input 12 文件并存 | ⚠️ 未处理（未声称，不构成虚报） |

---

## 4. 门禁拦截性验证

- **测试存在且运行绿**：`npx vitest run src/styles/style-contract.test.ts` → **23/23 passed**（2026-08-10 实测）。
- **静态 ratchet 真实拦截**：
  - ② 裸混色 `BARE_MIX_BASELINE = 3`（style-contract.test.ts:166）：新加一处 `color-mix(in srgb, var(--text-primary) X%` 消费即超基线变红；白名单仅 tokens.css / theme-dark.css / themeStore.ts / design-system.css（:68，注释说明 design-system 为 S7-3 迁入的 ::selection 全局规则）。
  - ④ scrollbar `SCROLLBAR_BASELINE = 31`（:217）：新增滚动条块即红。
  - ③ 裸 999px `RADIUS_999_BASELINE = 66`（:188）；⑤ `IMPORTANT_BASELINE = 633`（:233）。
  - 另有 z-index 硬编码残留（:73-108）、dark 分支覆盖（:110-157）、双层同源（:248-273）。
- **拦截边界说明**：基线 ratchet 只拦"新增"，不反向治理存量（滚动条 31 块 / !important 633 / 999px 66 均为当前存量上限）；theme-dark.css 与 design-system.css 整体豁免混色检查——theme-dark 补丁内的 10 处直接混色不受门禁约束（依赖 §7.2 挂账的人工迁移）。

---

## 5. 总结论

**收敛彻底性分级：**

- **彻底收敛（实读证实）**：混色（423→1 登记例外）、Tooltip（88 旧→95 新，旧件删除）、role="tab"（6 来源→1 基座）、role="switch"（0→ui/Switch 唯一）、useAnimatedPresence（双份→单份）、SettingsSelect（自研→ui/Select 8 消费）、ui barrel（2/6→8/8）、primary 四套、菜单 radius/hover token 化、P0 渲染无效面（tooltip-translate / card-tab.active / DiffCard 悬空引用）——**用户核心痛点"同一效果多种呈现"的主要来源已消除**。
- **部分收敛（声称与实读有出入）**：按钮（.ui-btn 消费清零 ✅，但 CSS 删段未做、裸 button 102 文件未清零）、props drilling（三条链零聚合，P1-12 声称 ✅ 不实）、开关（ui/Switch 上岗 ✅，CapEditor 自留 checkbox-pill）。
- **如实挂账（不构成虚报，但需持续关注）**：滚动条 31 块、VirtualList、通知多渠道、空态三件套、流式双轨、菜单键盘漫游双套、滚动锚定双套、theme-dark 补丁 265 行、!important 633、badge/pill 多套——报告 §7.3 与 §7.2 均逐条登记，与实读一致。

**一句话总结**：样式 token 层收敛彻底、组件层 5/7 件全量接管，"同效果多呈现"主病灶（混色 31 档 / tab 复制 / tooltip 双轨）已消除；但 3 处"清零/聚合"声称与代码不符（props 平铺三链未动、裸 button 102 文件、.ui-btn 死 CSS 未删），加 8 类 P2 如实挂账，**属"大头已收、尾欠三刀"的收敛状态**，非彻底清零。

---

## 附：复核口径与不确定性

- 计数口径：`rg` 全仓扫描 `apps/crish-desktop/src`；裸 `<button>` 排除 `components/ui/**` 与 `*.test.*`；混色正则与 style-contract ② 一致（`color-mix(in srgb, var(--text-primary) \d+(?:\.\d+)?%,`）。
- "42 文件 ui/Button 消费"含 `import { Button, … } from '../ui'` 的 barrel 引入文件数；个别文件可能引入未实际渲染（未逐一核对渲染点）。
- 报告所附行号均基于 2026-08-10 工作区状态；全局 css 层的 28 处直接混色未逐一判读语义（含部分 `--models-*` 变量定义行，ratchet 以 DEF_LINE_RE 放行），如需精确清点可对 settings-models.css 域单独做一轮。
