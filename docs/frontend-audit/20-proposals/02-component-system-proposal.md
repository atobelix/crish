# 组件体系修复方案（02）——原子层接管、扩展性设计、分步迁移

> 方案类型：组件体系（components/ 分层、复用出口、扩展性设计、迁移与退役）。
> 输入：`docs/frontend-audit/10-analysis/02-component-architecture-audit.md`（主审计，P0×2/P1×9）、`docs/frontend-audit/00-cross-analysis.md`（交叉结论）、`01-style-consistency-audit.md`（样式关联）、`08-a11y-ux-consistency-audit.md`（a11y 关联）。
> 性质：只读方案，无代码改动；所有数字基于 2026-08-09 工作区状态。
> 日期：2026-08-09。

---

## ① 目标态：原子层唯一基座 + 业务组合复用 + 扩展性设计

### 1.1 目标态三层结构（对审计「半落地」的终态描述）

```
components/
├── ui/                原子层（唯一「通用」层）—— 6 件套全部上岗 + 新增 Switch/TabStrip/VirtualList/ConfirmDialog
│   ├── Button / Input / Select / Menu / Dialog / Tooltip   （既有 6 件，全员进 barrel）
│   ├── Switch / TabStrip / VirtualList / ConfirmDialog      （本次新增，对应 P1-1/P1-3/08-P2-5）
│   └── index.ts       统一出口（barrel，6+4 全量导出）
├── (业务域目录 28+)    第二层：业务组件——只组合 ui/ 原子件 + 域内私有组件，无裸 button/裸 Tooltip/手写开关
└── App*/TopBar/       第三层：页面/编排
```

目标态验收特征（全部可量化）：

| 特征 | 目标值 | 对应审计问题 |
|---|---|---|
| ui/ 组件全员进 barrel，业务层从 `'../ui'` 引入 | 0 处 `'../ui/Menu'` 类直引 | P1-9 |
| 旧 Tooltip 消费归零，`components/Tooltip/` 删除 | grep 旧 import = 0 | P0-2 / P3-5 |
| 业务层裸 `<button>` 归零（icon-only 走 ui/Button iconOnly） | grep 目标面 = 0 | P0-1 |
| `.ui-btn` 全局类退役（shell-polish.css 按钮段删除） | 业务层 grep `.ui-btn` = 0 | P1-1 / 01-P3-5 |
| `role="switch"` 唯一来源 = ui/Switch | 全仓手写开关 = 0 | P1-3 |
| Tab 条唯一实现 = ui/TabStrip | 6 实现 → 1 | P1-1 |
| 输入唯一来源 = ui/Input | `settings-field-input` 等全局类清零 | P1-7 |
| Select 唯一来源 = ui/Select | SettingsSelect 删除 | P1-7 关联 / 03-3.1 |
| 无 props 平铺超 12 项（或强制聚合对象） | 3 条链路改造完毕 | P1-4 |
| 虚拟列表唯一引擎 = useVirtualScroll + ui/VirtualList 壳 | 4 套 → 1 引擎 | P1-2 |
| 无 >500 行组件 / >300 行 hook | 7 巨型 + 2 巨型 hook 清零 | P1-5 / P1-8 |
| barrel 完整性门禁 + store facade 门禁生效 | check 脚本进 npm scripts | P1-6 / P1-9 |
| 新代码红线：新交互一律从 ui/ barrel 组装 | 评审 + 门禁双重约束 | 根因 A 防回潮 |

### 1.2 组件化原则（本方案的设计宪法，用户明确要求）

**原则一：常用功能才做组件。** 组件化判据 =「消费点数量 × 变体数」：≥3 个消费点、或 ≥2 个呈现变体、或承担关键 a11y 契约（如 switch/tooltip）——三条件任一满足才进入 ui/ 层。单个场景专用的一次性 JSX 留在业务域内，不升格为通用组件。

**原则二：每个组件明示四类扩展点。** 新建或收敛的组件必须在文档与类型中明确扩展面：

| 扩展点类型 | 含义 | 示例 |
|---|---|---|
| 插槽 slot | children / ReactNode 位置，注入内容 | Button 的 icon、TabStrip 的 closeButton |
| render prop | 以函数形式定制渲染 | TabStrip 的 renderTab、Menu 的 renderItem |
| 变体 variant | 受控形态枚举（联合类型，穷举而非开放字符串） | Button.variant: 'primary'\|'secondary'\|'ghost'\|'danger' |
| 组合 composition | 组件作为子件被包一层 / 嵌套组装 | ConfirmDialog 包 Dialog；Select 包 Menu |

**原则三：每个组件明示「不支持的场景」。** 防止过度抽象——「万能组件」是第二病灶。组件文档头部必须写「不做 X：用 Y」：Tooltip 不做交互型浮层（用 Popover）、Switch 不做三段式（用 Radio）、VirtualList 不做网格（另行组件）。「加个 prop 就能支持」的诱惑一律先问：这是需求还是过度设计？新需求出现 2 个真实消费点之前不扩 prop。

**原则四：原子层只放通用，业务封装放业务层。** ui/README 分层契约（ui/ 禁止依赖 store/hooks/api/业务组件）延续为红线；业务域的「组合形态」（ChatStatusRibbons 五轨道、diff 行内操作组）是第二层职责，通过组合 ui/ 件实现，不下沉也不升格。

**原则五：回调命名与受控/非受控统一。** 同类语义单一命名：选项选择一律 `onChange(value)`（对齐 ui/Select）；打开态变化一律 `onOpenChange(open)`（对齐 ui/Menu）；数据查询回调一律 `onSelect(id)`。受控/非受控双模是 ui/ 组件默认要求（Menu/Select 已示范）。

---

## ② 分步方案（逻辑顺序；每步独立提交、独立门禁）

### 总览：15 步 × 五阶段

```
阶段 A 基座与契约（先建基座，杜绝「半途双轨扩大」）
  A1 barrel 契约补全（P1-9）
  A2 门禁扩展：store facade + barrel 完整性（P1-6）
阶段 B 原子件接管（每个组件走「建基座→迁移→退役」三段闭环）
  B1 Tooltip 统一（P0-2 / P3-5）
  B2 Button 统一（P0-1 / P1-1）
  B3 Switch 新建与替换（P1-3）
  B4 Input 统一（P1-7 输入面）
  B5 Select 统一：SettingsSelect → ui/Select（P1-7 关联）
  B6 TabStrip 提炼与 6 消费点收敛（P1-1）
阶段 C props 治理
  C1 ChatCard 系 props 聚合（P1-4）
阶段 D 巨型组件与巨型 hook 拆分
  D1 ModelConfigEditor 拆分（P1-5）
  D2 巨型 hook 两枚拆分（P1-8）
  D3 其余巨型组件拆分（P1-5 扩展）
阶段 E 死代码清理与复用出口收尾
  E1 虚拟列表收敛 + shell/VirtualList 处置（P1-2）
  E2 hooks barrel 建设 + useChatPanelSync 复核归档（P3-1 / P3-4 修正）
  E3 P2 族收敛（空态/通知横幅/滚动锚定/确认对话框）——复用三段式模板
```

**接管顺序逻辑（全方案主线）：先建基座（A）→ 再迁移消费点（B/C）→ 后退役旧件（B 内收尾 + E）**。任何组件迁移都不得跳过「基座就绪」直接改消费点——否则新旧双轨并存窗口被人为拉长（Tooltip 88:4 的教训：新件建成但无人接线，双轨持续至今）。每步的产出同时是下一步的输入：A1 的 barrel 唯一出口 → B 阶段所有迁移从 barrel 引；B1 退役删 `hooks/useAnimatedPresence` → E2 的删除面缩小；B2 退役 `.ui-btn` → 01 样式方案的 shell-polish.css 清理面缩小；D 拆分产出子组件 → E3 族收敛的取材面。

---

### 阶段 A：基座与契约

#### A1：ui barrel 契约补全（P1-9）

| 项 | 内容 |
|---|---|
| 任务内容 | 1. `ui/index.ts`（现 12 行，仅 Dialog+Tooltip）补全导出 6 件套：Button/Input/Select/Menu + 既有两件（含 props 类型导出）；2. 11 处 `'../ui/Menu'` 直引改走 barrel（ModelBadgePickerMenu/ProjectPickerMenu/ComposePlusMenu/SkillsMoreMenu/ChatHeaderMore/ModelsSettingsTab/SettingsQuickMenu/SettingsSelect/PermissionModeMenu/SidebarContextMenus 等，审计 §4.1 清单）；3. 新增「新 ui 组件必须进 barrel」门禁脚本 `check:ui-barrel`（比对 ui/ 子目录清单与 index.ts 导出，缺漏即红），并入 `check:ui-layer` 执行链 |
| 涉及文件面 | 约 14 个：`ui/index.ts` + 11 个 Menu 消费点 + 1 个门禁脚本（scripts/） |
| 验证方式 | `npm run typecheck`；`npm run check:ui-layer`（含新 barrel 检查）；`npm run test:coverage -- --project=unit`（ui/ 测试不回归）；grep 确认 `'../ui/Menu'` 直引清零 |
| 完成判据 | barrel 导出 6 组件；Menu 直引 0 处；门禁脚本对「漏导新组件」能红；`ui/index.ts` 成为唯一合法入口（评审红线） |

> 产出即 B 阶段全部迁移的基础：消费点 import 统一从 barrel 引入，迁移时只改「用什么组件」，不改「从哪里引」。

#### A2：门禁扩展：store facade（P1-6）

| 项 | 内容 |
|---|---|
| 任务内容 | 1. 仿照 `check:ui-layer` 新增 `check:store-facade`：扫描业务组件层 import `store/`（审计计数 58 处）→ 全部改走 `api/store-access/componentAccess.ts` / `store/storeAccess.ts` facade（chat-message-row/、agent-card/、settings/ 全域重点）；2. 评审红线：禁止新增 `store/` 直引；3. 纯 import 换道，不改变任何渲染行为 |
| 涉及文件面 | 58 个组件文件（grep 基线）+ 1 门禁脚本 |
| 验证方式 | `npm run typecheck`；check 脚本先红后绿；`npm run test:coverage -- --project=unit` |
| 完成判据 | 业务组件 `store/` 直引 = 0；门禁进 CI 快层；无行为变化 |

> 与代码质量审计（05）的行数门禁接线并列治理：D 阶段巨型组件拆分后的防回潮护栏是 05 方案的行数门禁，本方案不承接其实现，仅声明依赖——两者需在 CI 上同批生效。

---

### 阶段 B：原子件接管（核心阶段）

> 每个组件步骤统一三段闭环：**①基座就绪**（能力补缺、进 barrel）→ **②消费点迁移**（分批）→ **③旧件退役**（删除旧实现/旧样式/死依赖）。退役是步骤的验收动作，不允许「迁完但旧件还在」。

#### B1：Tooltip 统一（P0-2 / P3-5）——机械替换，第一批

| 项 | 内容 |
|---|---|
| 任务内容 | **①基座就绪**：确认 `ui/Tooltip` API 兼容面（content/side/disabled/delayHide 签名不变，ui/Tooltip/Tooltip.tsx:6-9 注释自证）；补齐 `--tooltip-translate` 悬空 token 修复（01 审计 P0-2：transform 入场动画失效，本步骤内直接修两处样式，避免双份 Tooltip 样式重复修复）；**②迁移**：88 处旧 import（grep 复核 85 文件，口径差含测试/自身）分批改 `'../ui'`；**③退役**：旧 import 清零后删除 `components/Tooltip/` 整目录 + `hooks/useAnimatedPresence.ts`（唯一消费者是旧 Tooltip，ui/Dialog/useAnimatedPresence 已独立，grep 复核确认） |
| 机械/语义判定 | **基本机械**：import 路径 + props 签名兼容。**两处非机械**：①旧 Tooltip 只透 ref（旧 :98），新 Tooltip 以 cloneElement 透传全部 restProps（新 :284-292）——依赖子元素 props 注入的消费点需复核；②a11y 升级（键盘 focus 触发 + aria-describedby）是行为收益，SR/键盘用户可见，无需消费点改动。批量期间**每批抽样 1 个键盘可达性冒烟**（Tab 聚焦 icon 按钮 → tooltip 出现） |
| 涉及文件面 | 88 个消费文件（4 个已走 barrel 的不动），分 4 批（每批约 20 个） |
| 批量边界 | 按业务域切批：批1=chat-*（聊天主域）、批2=agent-card/ + diff/、批3=settings/ + sidebar/、批4=其余（workspace/overlay/binary-tree 等）——每批独立提交，便于单批回退与评审 |
| 验证方式 | 每批 `npm run typecheck` + `npm run test:coverage -- --project=unit`（ui/Tooltip 测试保活，旧 Tooltip 测试随退役同步移除）+ 键盘冒烟抽查；退役步再跑一次全量 vitest |
| 完成判据 | grep 旧 Tooltip import = 0；`components/Tooltip/` 目录不存在；`hooks/useAnimatedPresence.ts` 删除且 grep 无引用；全仓 tooltip 行为单一来源 = ui/Tooltip；键盘可达性抽样 100% 通过 |

> 闭环输出：①清除 88 处 a11y 断层面（08 P1-1 同步解决）；②为 B2 提供「机械替换 → 批量边界 → 退役」节奏样板；③旧 Tooltip 内的 useMergeRefs 复制份随旧件删除消亡。

#### B2：Button 统一（P0-1 / P1-1）——机械 + 语义混合，最大工程量

| 项 | 内容 |
|---|---|
| 任务内容 | **①基座就绪**：ui/Button 变体对齐盘点——`.ui-btn` 全局类体系（shell-polish.css:18-86：primary/secondary/ghost/danger × sm/md）与 ui/Button 的 variant/size 映射表落地（1:1 对照，差异补齐：`.ui-btn` 无 disabled 规则 vs Button 有 opacity——以 Button 为准，01 P2-9）；新增 `iconOnly` 形态（icon + aria-label 强制，收敛 6+ 种手写 icon-only 尺寸）；loading 态内建文案约定「动词+中…」（08 P2-9 一并解决）；**②迁移**：第一波 `.ui-btn` 全局类消费（36 个文件，机械映射）；第二波 128 个文件裸 `<button>`（语义替换）；**③退役**：shell-polish.css 按钮段删除（与 01 方案协同确认无剩余引用） |
| 机械/语义判定 | **第一波（36 文件 .ui-btn）机械**：`className="ui-btn ui-btn-primary"` → `<Button variant="primary">`，类名→变体 1:1 映射表驱动。**第二波（128 文件裸 button）语义**：逐按钮读意图判定变体、补 aria-label（08 P1-2 的 16 个无名称按钮在 icon-only 替换中强制补名）、识别「其实不是按钮」的 DOM（如 role=tab 的 tabClose 按钮——保持原生按钮但走 B6 收敛）。**语义判定规则表**（评审用）：图标×无文字=iconOnly+aria-label 必填；红/危险语义=danger；hover 淡染=ghost；填充主色=primary；其余=secondary |
| 涉及文件面 | 36（.ui-btn）+ 128（裸 button）= 164 文件，分 6 批（每批 20~30） |
| 批量边界 | 按业务域切：批1=settings/（SchemaRenderer/各 tab）、批2=chat-*、批3=agent-card/、批4=shell/ + sidebar/、批5=diff/ + workspace/、批6=其余——每批独立提交；aria-label 补齐计入每批完成判据 |
| 验证方式 | 每批 typecheck + 单测；每批抽样 3~5 个按钮做**视觉回归**（替换前后截图对比，防「语义映射错误导致观感变化」）；`npm run check:ui-layer`；退役步 grep `.ui-btn` 清零 |
| 完成判据 | 业务层裸 `<button>` = 0（icon-only 全走 iconOnly）；`.ui-btn` 全局类引用 = 0 且 shell-polish.css 按钮段删除；16 个无名称按钮补齐 aria-label；抽样视觉回归无差异；ui/Button 消费数 ≥ 160 |

> 与 01 样式方案的顺序依赖：**primary 语义定案（01 P1-5）必须先于变体映射表定稿**——当前 primary 有四套长相（深炭/蓝/反相/实心红），映射表必须以 01 收敛后的唯一 primary 为基准，否则替换后观感错位。本步骤与 01 方案在「变体映射表」上握手对接。

#### B3：Switch 新建与替换（P1-3）——语义替换

| 项 | 内容 |
|---|---|
| 任务内容 | **①基座就绪**：新建 `ui/Switch`（role="switch" + aria-checked + 键盘 Space/Enter 切换 + 受控/非受控双模 + label 插槽 + disabled），CSS 走 tokens（thumb 平移用 `--transition-*`，圆角 `--radius-full`），进 barrel；**②迁移**：5+ 处手写开关替换——`SettingsSchemaRenderer.tsx:81`（settings-switch 全局类）与 `:213`（aria-pressed 变体）、`SettingsSecurityTab.tsx:370`、`SettingsShortcutsTab.tsx:457`、`SettingsAppearanceTab`、`ModelConfigEditor.tsx:668`（私有 toggleThumb）、`ModelConfigEditor.tsx:529`（cap 开关）、`InlineAgentPanel.tsx`（agent 开关）、AgentCard 内开关；**③退役**：`settings-switch` 全局类删除、各私有 thumb 样式删除 |
| 机械/语义判定 | **语义替换**：aria-pressed 按钮 → role="switch" 是 ARIA 语义升级（SR 播报从「按下」变为「开关」），逐点验证朗读结果；全局类开关是机械映射（类名→组件）；私有 thumb 是结构重写（逐点实现） |
| 涉及文件面 | 新建 1 + 迁移约 10 个文件（settings 全域为主），1 批完成 |
| 验证方式 | typecheck + 新增 ui/Switch 单测（键盘交互、受控/非受控、aria 断言）；人工验证 3 个代表性开关（SchemaRenderer 个性化开关、SecurityTab 开关、ModelConfigEditor cap 开关）的 SR 播报 + 键盘切换 |
| 完成判据 | 全仓 `role="switch"` 唯一来源 = ui/Switch；无 aria-pressed 手写开关残留（Menu 场景除外）；`settings-switch` 全局类 grep = 0；新组件单测全绿 |

> 闭环输出：为「语义替换类」步骤（B5/B6）提供样板——行为变更点列清单、逐点人工验证，不能只靠类型检查。

#### B4：Input 统一（P1-7 输入面）——机械 + 部分语义

| 项 | 内容 |
|---|---|
| 任务内容 | **①基座就绪**：ui/Input 能力对照 `settings-field-input` 全局类（settings-base.css:86-154）与各 tab 私有输入，确认覆盖 text/search/password + label/error/hint/prefix/suffix（README 已声明，逐项核对）；focus 反馈统一为 focus-ring（01 P1-7 的 `.ui-input:focus` 无反馈问题随全局类退役自然消失）；**②迁移**：settings 域全局类输入 + 私有输入改 ui/Input；**③退役**：`settings-field-input` 全局类段删除 |
| 机械/语义判定 | 全局类输入机械映射；私有输入逐点对齐 label/error/hint 结构（部分语义：表单校验展示结构不一，统一为 ui/Input 的 label+error 约定） |
| 涉及文件面 | settings 域约 15~20 文件（SchemaRenderer 表单渲染、各 tab 表单），分 2 批 |
| 验证方式 | typecheck + 单测；每批抽样 3 个表单做聚焦视觉回归（focus-ring 一致性）；grep `settings-field-input` 清零 |
| 完成判据 | `settings-field-input` = 0；ui/Input 消费数 ≥ 15；textarea 场景明确保留 ComposerField 轨（textarea/tiptap 双轨收敛属编辑器专项，本方案声明边界不承接） |

#### B5：Select 统一：SettingsSelect → ui/Select（P1-7 关联 / 03-3.1）——语义替换

| 项 | 内容 |
|---|---|
| 任务内容 | **①基座就绪**：ui/Select 头注释自证「SettingsSelect 迁移即以此为落点」（ui/Select/Select.tsx:3-9），确认回调签名对齐：SettingsSelect 的 `onSelect` 命名 → ui/Select 的 `onChange(value)`（03 审计 3.1），打开回调 `onOpen()` → `onOpenChange(open)`（对齐 ui/Menu 契约）；options 数据模型对齐（SettingsSelectOption → SelectOption 的 id/label/icon 结构，核对 icon 渲染差异）；**②迁移**：5 个消费方（FontSettingsSection/WorkflowForm/SettingsSecurityTab/SettingsSchemaRenderer/SettingsRulesTab，grep 复核）改 ui/Select；**③退役**：`components/settings/SettingsSelect.tsx` 删除（含其 module.css 的 settingsSelectMenu 样式，01 菜单壳层收敛面同步缩小） |
| 机械/语义判定 | **语义替换**：回调重命名是 API 行为变更，5 个消费点逐一核对 onSelect 参数语义（ui/Select 的 onChange(value: string) 与 SettingsSelect 的形参可能不同，逐点转换）；面板样式与键盘行为由基座统一（收益：SettingsSelect 独立实现消失） |
| 涉及文件面 | ui/Select（补缺）+ 5 个消费文件 + SettingsSelect 删除，1 批 |
| 验证方式 | typecheck + ui/Select 既有单测 + 5 消费点行为人工验证（打开/选择/关闭/Esc/外点关闭）；grep SettingsSelect = 0 |
| 完成判据 | SettingsSelect 删除；ui/Select 消费数 = 5；回调语义逐点核对表签字通过 |

> 新发现（详见⑤-1）：ui/Select 是为承接 SettingsSelect 而建的落点组件，0 消费挂账至今——本步骤是「落点组件接线」，不是新抽象。

#### B6：TabStrip 提炼与 6 消费点收敛（P1-1）——半语义，能力盘点先行

| 项 | 内容 |
|---|---|
| 任务内容 | **①基座就绪（能力盘点先行）**：以 UnitSessionTabStrip（478 行，最完整：React.memo + 拖拽 + roving tabindex + Arrow/Home/End/Delete，S4.5 a11y 完整，专项测试 3 套）为蓝本提炼 `ui/TabStrip`，先产出**能力盘点表**（见下），差距超过蓝本能力的消费点标记「暂缓接入」；基础能力 = role=tablist/tab + aria-selected + roving tabindex + Arrow/Home/End；可选能力 = 关闭按钮（renderTab 插槽）/ 拖拽（enabled 开关）/ 溢出滚动；**②迁移**：6 消费点收敛——SessionStrip、WorkspaceStrip（简单）→ SettingsTablist（导航语义，无关闭）→ UnitSessionTabStrip、LeafToolTabStrip（同域双件合一，顺带修 LeafTool 的 role=tab 无 roving 问题，08 P3-3）→ GlobalSessionTabBar（拖拽 + 全局上下文，最复杂，最后）——按复杂递增 2 批；**③退役**：6 个自研实现删除（UnitSessionTabStrip 能力并入基座后删除） |
| 能力盘点表（迁移前必填） | 消费点 × {拖拽, 关闭钮, 溢出滚动, memo, 上下文菜单, 键盘漫游}——六行六列，差异格标「差异说明 + 接入方案（插槽/变体/暂缓）」；盘点表是本步骤验收物之一 |
| 机械/语义判定 | **半语义**：各 tab 条数据模型不同（UnitSessionTabStrip 是 SessionTreeNode 序列、GlobalSessionTabBar 是全局会话、SettingsTablist 是静态项）——先以 renderTab/children 插槽消化差异；无法消化的（如 GlobalSessionTabBar 的全局上下文）降级为「TabStrip + 业务封装层」组合，不扩基座 props |
| 涉及文件面 | 新建 1 + 迁移 6 文件 + 退役 6 文件，2 批 |
| 验证方式 | typecheck + 新建 ui/TabStrip 单测（复用 UnitSessionTabStrip 既有 3 套 a11y 专项测试为蓝本：roving tabindex/键盘/关闭）；S4.5 tab 键盘标准逐项核对；每消费点视觉回归 |
| 完成判据 | 全仓 `role="tab"` 来源 = ui/TabStrip 一处；6 自研实现删除；能力盘点表完成；键盘漫游缺失面清零（SessionStrip/LeafToolTabStrip 补齐） |

---

### 阶段 C：props 治理

#### C1：ChatCard 系 props 聚合（P1-4）

| 项 | 内容 |
|---|---|
| 任务内容 | 1. `ChatCard.tsx:42-72`：`state.composerProps` 已是聚合对象，消费侧**拆包后逐 prop 传**是「对象化了一半又退回」——改为 JSX spread 直传 `<ChatComposer {...state.composerProps} />`；2. `ChatComposerWrapper.tsx:82-112` 向 ChatStatusRibbons 的 30 props 平铺 → ChatStatusRibbons 改收单一 `ribbons` 聚合对象（内部按字段消费）；3. `ChatCard.tsx:158-190` 向 ChatMessageList 的 30 props → 聚合为 `listProps` 对象（或将会话数据获取下沉到 ChatMessageList 内部 hook，减少中转层）；4. `ChatAssistantMessageRow.tsx:11-37` 28 props → 按「消息数据 / 行为回调 / 展示配置」三分组对象；5. 落地评审约束：**props > 12 必须聚合对象，新增组件 props ≤ 12 为默认红线**（写入 ui/README 与评审 checklist） |
| 涉及文件面 | chat-card/ + chat-message-list/ 约 10 个文件，1 批 |
| 验证方式 | typecheck + 既有 chat 域测试（含 keyboard-navigation 等 e2e spec）+ `npm run test:coverage -- --project=unit`；行为零变化（纯结构重构） |
| 完成判据 | 3 条 30 props 链路全部聚合；无单组件 props > 12（grep 校验接口定义）；评审约束入文档；行为测试全绿 |
| 备注 | 与 07 性能审计互补：聚合对象 + memo 边界配合是重渲染风险面的前提治理；本步骤只做结构不做性能调优 |

---

### 阶段 D：巨型组件与巨型 hook 拆分

> 拆分原则：**只搬不写**——拆出的子组件从原文件原样迁移（含注释/样式），不借机改行为；拆完行为测试全绿才进入下一步。每步输出「子组件清单 + 行数分布」作为拆分收据。

#### D1：ModelConfigEditor 拆分（P1-5，856 行）

| 项 | 内容 |
|---|---|
| 任务内容 | 按功能区拆 5 件：`CapEditor`（cap 开关组，含 :529 开关——B3 的 ui/Switch 已先行接管）、`ModelList`（模型列表 :575+）、`ProviderProfileForm`（profile 选择与编辑）、`CapabilityEditor`（能力矩阵）——主文件保留组装职责 ≤300 行；`ToggleThumb`（:668 私有 thumb）随 B3 退役直接消亡，不拆 |
| 涉及文件面 | 1 文件拆 4~5，settings-models/ 域内，1 批 |
| 验证方式 | typecheck + settings 域测试 + 设置-模型页人工回归（增删 profile/cap 开关/保存流程） |
| 完成判据 | ModelConfigEditor ≤ 300 行；子组件各自 ≤ 300 行；行为回归全绿；拆出的子组件中跨域可复用的（CapEditor）经评审决定是否升格 ui/（默认不升格，遵循「2 个消费点才升格」原则） |

#### D2：巨型 hook 两枚拆分（P1-8）

| 项 | 内容 |
|---|---|
| 任务内容 | `useExtensionMarket.tsx`（581 行）→ `useSkillsCache`（缓存读写 :37-72）/ `useMcpCache` / `useMarketQuery` 三 hook 组合；`useSidebarSessionList.tsx`（550 行）→ `useWindowedList`（窗口化）/ `useSessionDrag`（拖拽）/ `useSessionGrouping`（分组）三 hook 组合——两者都以「组合多个小 hook」替代「一个巨型 hook」，遵循仓库 hooks 最佳实践（chat-stream/ 子目录化 + index 的既有成功模式） |
| 涉及文件面 | 2 文件拆 6，settings-extensions/ 与 sidebar/session-list/ 域内，1 批 |
| 验证方式 | typecheck + 对应域测试 + 扩展市场页 / 会话列表页人工回归（分页/拖拽/分组） |
| 完成判据 | 两枚 hook 各 ≤ 300 行；拆出小 hook 各自 ≤ 200 行；行为回归全绿 |

#### D3：其余巨型组件拆分（P1-5 扩展）

| 项 | 内容 |
|---|---|
| 任务内容 | `ApprovalAskCard.tsx`（742 行）→ 拆 ApprovalRiskChips（:91-127 内联 chip 生成，兼收 badge 族）/ ApprovalCountdown / ConfirmButton 组 + 既有 ApprovalPayloadSection；`SidebarContextMenus.tsx`（686 行）→ 拆 ContextMenuFlyout 基件（自研键盘漫游 :87-130 与 flyout 状态机 :150-225 内聚）；`ExternalSessionImport.tsx`（551 行）→ 按向导步骤拆 3~4 步组件；`SettingsUsageTab.tsx`（508 行）→ 拆用量图表 / 用量表格 / 配置区 |
| 涉及文件面 | 4 文件拆 10+，各域内，2 批（approval/sidebar 批 + settings 批） |
| 验证方式 | typecheck + 各域测试 + 人工回归（审批流/右键菜单/导入向导/用量页） |
| 完成判据 | 全仓无 >500 行组件（次级 400~500 行清单留观）；行为回归全绿；拆出的「审批风险 chips」与「状态点」与 E3 的 badge 族收敛联动 |

---

### 阶段 E：死代码清理与复用出口收尾

#### E1：虚拟列表收敛 + shell/VirtualList 处置（P1-2）

| 项 | 内容 |
|---|---|
| 任务内容 | 1. 引擎定案：`useVirtualScroll` 为唯一引擎（5 消费方现役）；`shell/VirtualList.tsx` 的 `computeVisibleRange`（:10-22）与 useVirtualScroll 内部窗口计算重复——**决策分叉**：a) 若 VirtualList 能力（容器 + 计算 + 渲染封装）有价值 → 以 useVirtualScroll 为底重构为 `ui/VirtualList` 薄壳（核心 props：items/itemHeight/renderItem/overscan/height + 固定行高 + 后续可扩展 measure），WindowedSessionUl 与 MessageVirtualizer 统一壳；b) 若其能力与 useVirtualScroll 直接暴露重复 → 删除孤儿，WindowedSessionUl 改造为消费 useVirtualScroll；2. `WindowedSessionUl`（sidebar 第四方案，基于 api/sessionListWindow range 切片）评估后接入唯一引擎或标注「窗口化数据源特例」并在文档登记不支持场景；3. MessageVirtualizer（447 行，正确派生）仅剥离重复窗口计算，保留消息窗口特有逻辑 |
| 涉及文件面 | 决策面 5 个文件 + 新建/删除各 1，1 批（先出决策记录文档再动手） |
| 验证方式 | typecheck + 列表域测试（diff 列表/文件树/消息列表滚动回归）+ 长列表滚动性能抽样（帧率） |
| 完成判据 | 引擎引用唯一（useVirtualScroll 或 ui/VirtualList）；shell/VirtualList 不再以孤儿形态存在（删除或重构）；WindowedSessionUl 决策记录落档；滚动行为回归全绿 |

#### E2：hooks barrel 建设 + useChatPanelSync 复核归档（P3-1 / P3-4 修正）

| 项 | 内容 |
|---|---|
| 任务内容 | 1. 新增 `hooks/index.ts` 统一出口（40+ hooks 全量导出），消费方从相对路径散引改 barrel（分 2~3 批按域）；2. **useChatPanelSync 复核**（见⑤-2 新发现）：确认其**不是死代码**——`BinaryTreeWorkspace.tsx:26,141` 实引实调，审计 P3-4「疑似死代码」结论修正；处置：保留 + 进 barrel + 文件头补职责注释（当前 `hooks/useChatPanelSync.ts:57` 无注释）；3. 域 hook 归置约定成文：业务域专属 hook 与组件同目录（settings-*/ 现状为合理惯例），通用 hook 进 hooks/ 根，写入文档约定 |
| 涉及文件面 | hooks/ 根 40+ 文件 + 消费面（分 3 批）+ 1 文档更新 |
| 验证方式 | typecheck；grep 抽查无漏；`npm run test:coverage -- --project=unit` |
| 完成判据 | hooks/index.ts 存在且导出全量；useChatPanelSync 复核结论写入归档（有线非死代码）；散引清零；无行为变化 |

#### E3：P2 族收敛（复用三段式模板，多轮可迭代）

| 项 | 内容 |
|---|---|
| 任务内容 | 按 B 阶段的同一模板（基座→迁移→退役）逐族执行，每族一轮独立提交：**空态**（ChatEmptyState/WorkspaceEmptyState/PanelBodyEmpty 三合一，基座 ui/EmptyState：icon/title/description/action 插槽 + role="status"）；**通知横幅**（RunNoticeBar/SetupHintBanner/PlanGoalRibbons/ApprovalDock/AgentCard daemon 横幅 → ui/Banner 或域内 NotificationRibbon 组合件，与 08 §1.4 的 aria-live 分级对齐）；**滚动锚定**（useChatAutoScroll vs useScrollAnchor 双实现合一，基座 hooks/useScrollAnchor）；**badge/状态点族**（AgentStatusChip/CacheMetricsBadge/AgentStatusDot/审批 chips/diff 徽标 → ui/Badge + 状态色 token 单一来源）；**确认对话框**（08 P2-5：window.confirm ×8 + 内联两步 → 新建 `ui/ConfirmDialog` 包 ui/Dialog，role=alertdialog + 焦点圈定，8 处迁移；BgTaskActions 的 role=alertdialog 滥用随迁移消失，08 P1-7 同步解决） |
| 机械/语义判定 | 每族按模板自行区分：空态/横幅/确认对话框为半语义（结构差异大，先盘点再拆）；滚动锚定为语义（两套数据模型合一，行为验证重点）；badge 族为机械（类名/样式替换 + role 补齐） |
| 涉及文件面 | 每族 3~8 文件，共约 30 文件，分 5 轮（每轮 1 族） |
| 验证方式 | 每轮 typecheck + 单测 + 相关交互人工回归（确认对话框键盘/Esc/焦点；横幅 aria-live 播报）；08 审计 P2 级 a11y 项随族关闭 |
| 完成判据 | 每族实现数 = 1；无 role 缺失残留（CacheMetricsBadge 等补 role 或声明纯装饰豁免）；window.confirm 生产代码 = 0；各族完成记录进事件 changelog |

---

## ③ 扩展性设计说明（每组件：核心 props / 扩展点 / 不支持场景）

> 本表是 ui/ 层组件的「扩展性契约」（原则二/三的落点），随组件落地写入各组件 README 或文件头注释。

| 组件 | 核心 props（最小面） | 扩展点 | 不支持的场景（防过度抽象） |
|---|---|---|---|
| **Button** | `variant: 'primary'\|'secondary'\|'ghost'\|'danger'`、`size: 'sm'\|'md'`、`icon?: ReactNode`、`loading?: boolean`、`block?: boolean`、`disabled`、`onClick` | 变体 variant（联合类型穷举，新增形态先扩联合再全量对齐）；icon 插槽；loading 态文案插槽（默认「动词+中…」）；children 承载任意内容；组合 composition（业务按钮组包一层） | 不做 asChild 透传任意 DOM（保持原生 button 语义与 focus 契约）；不做拖拽手柄/列表行交互容器（原生 + 域私有结构）；不做多按钮组布局（域内组合） |
| **Tooltip** | `content: ReactNode`、`side`、`disabled`、`delayHide`（API 与旧版兼容） | side 联合扩展；content 插槽（ReactNode 支持富内容）；trigger 由 children 组合（包任意可聚焦元素）；restProps 透传子元素 | 不做交互型浮层（内容可点击/hover 停留面板 → Popover/Menu 组合）；不做强制显示模式（业务条件渲染实现）；不做自定义箭头（视觉细节归 tokens） |
| **Switch** | `checked`（受控）/`defaultChecked`（非受控）、`onCheckedChange`、`label`（或 aria-label）、`disabled`、`size` | 受控/非受控双模；label 插槽（前缀说明文案）；icon 插槽（自定义 thumb 内容）；组合 composition（行布局容器包 Switch + 说明） | 不做三段式/多态开关（Radio 组或 Select）；不做开关组整体校验（表单层职责）；不做视觉皮肤变体（颜色语义归 tokens） |
| **Input** | `type: 'text'\|'search'\|'password'`、`value`/`defaultValue`、`onChange`、`label`、`error`、`hint`、`disabled`、`prefixIcon`/`suffixIcon`、`clearable` | prefix/suffix 插槽（图标或轻量 ReactNode）；error/hint 文案插槽；size 扩展；组合 composition（搜索框 = Input + 按钮组） | 不做富文本/多行编辑器（textarea 属 ComposerField 轨、tiptap 属编辑器轨——双轨收敛是编辑器专项，本方案声明边界）；不做下拉联动（Select 组合） |
| **Select** | `value`/`onChange(value)`、`options: {id,label,icon?,disabled?}[]`、`placeholder`、`label`、`error`、`size`、`disabled` | 受控/非受控双模（既有）；option icon 插槽；renderOption（差异化渲染需求 ≥2 消费点才加）；组合 composition（Select + 校验 = 表单域组件） | 不做自由输入 combobox（Input + Menu 组合）；不做树形/多级选择（嵌套 Menu 场景，业务层组合）；不做分组 options（出现需求再以嵌套结构扩展） |
| **TabStrip** | `tabs`（数据模型）、`activeId`、`onActiveChange`、`onClose?` | renderTab 插槽（关闭钮/badge/拖拽手柄定制）；拖拽 enabled 开关；溢出滚动行为开关；组合 composition（业务封装层 = TabStrip + 域上下文，如 GlobalSessionTabBar） | 不做垂直 tab/侧边导航（另行组件）；不做 tab 内嵌复杂工具栏（组合而非扩 prop）；不做拖拽领域逻辑（拖拽算法在域内 hook，基座只提供插槽位） |
| **VirtualList** | `items`、`itemHeight`、`renderItem`、`overscan`、`height` | renderItem 渲染插槽；动态行高 measure（第二迭代，需求出现再扩）；窗口化数据源（与 WindowedSessionUl 的 range 切片组合） | 不做网格/多列（另行组件）；不做无限流式追加（数据层职责）；不做 item 复用的领域逻辑（域内封装） |
| **ConfirmDialog**（E3 新建） | `open`、`onOpenChange`、`title`、`message`、`confirmLabel`/`cancelLabel`、`variant: 'danger'\|'default'`、`onConfirm` | 基于 Dialog 组合（承接 FocusTrap/Esc/焦点还原全套）；内容插槽（ReactNode message 富内容）；按钮组定制 | 不做非确认用途弹窗（用 Dialog）；不做 window.confirm 语义兼容层（一次性迁移，不保留双轨）；不做多按钮自由编排（confirm/cancel 二键 + 插槽兜底） |

**通用扩展性纪律**：扩展点必须满足「新增消费场景 ≤2 个时用组合/插槽，≥2 个真实重复需求才进基座 props」；每个组件的「不支持场景」清单与 props 一样受评审约束，防止组件向万能方向膨胀。

---

## ④ 迁移与回退策略

### 4.1 机械替换与语义替换的判定框架

| 替换类型 | 特征 | 本方案中的应用 | 风险等级 |
|---|---|---|---|
| 纯机械 | import 路径 / 类名→prop 的 1:1 映射，无行为差异 | Tooltip import 替换；`.ui-btn` → Button 变体；Input 全局类 → ui/Input；badge 类名替换 | 低（类型检查 + 抽样视觉即覆盖） |
| 半语义 | 结构可映射，但存在能力差异需逐点决策 | TabStrip 6 消费点（能力盘点表）；空态/横幅/确认对话框族 | 中（盘点表 + 逐点人工验证） |
| 语义 | API 签名/ARIA 语义/数据模型变更，行为可感知 | Switch（aria-pressed→role=switch，SR 播报变）；Select（回调重命名）；滚动锚定（数据模型合一）；Button 裸 button（意图判定 + aria-label 补全） | 高（行为变更点清单 + 人工验证 + SR 抽查） |

**判定结论：88 处 Tooltip 替换基本机械但不是纯机械**——import 与 props 签名兼容让 90% 文件零改动成本，但①新 Tooltip 以 cloneElement 透传 restProps（旧版仅 ref），依赖子元素 props 注入的消费点需复核；②a11y 升级是行为收益，需每批抽查键盘可达性确认「收益真实发生」而非「替换后无感」。因此按「机械流程执行 + 行为抽样验收」处理，每批 20 文件、4 批完成。

### 4.2 批量规模与评审窗口

| 步骤 | 批次方案 | 单批最大文件数 | 单批评审面 |
|---|---|---|---|
| B1 Tooltip | 4 批按业务域 | ~22 | import 变化为主 + 抽样键盘冒烟 |
| B2 Button | 6 批按业务域 | ~30 | 变体映射表 + 视觉回归抽样 3~5 按钮 + aria-label 补全清单 |
| B4 Input | 2 批 | ~10 | 表单聚焦视觉 + label/error 结构 |
| B6 TabStrip | 2 批（简单→复杂） | 3~4 | 能力盘点表 + a11y 标准核对 |
| E2 hooks barrel | 3 批按域 | ~15 | 纯 import 变化 |

单批规模原则上限 20 文件、硬上限 30，保证一次 PR 内可完整评审、发现问题可整批回退。

### 4.3 回退策略

1. **每批独立提交**，禁止跨批混提；回退粒度 = 一个批次的 git revert，不连锁。
2. **双轨窗口控制**：任一组件迁移期间，旧件与新件并存是「受控过渡态」而非「平行事实」——过渡态期间执行两条红线：a) 新代码一律用新件（评审拦截旧件新消费）；b) 过渡态有明确终点（退役步骤排入同一阶段），禁止「迁移完但退役欠账」。
3. **语义替换的行为变更点清单**：Switch/Select/TabStrip 步骤开工前先产出变更点清单（逐条：变更内容/受影响页面/验证方式），作为人工验收与回退判定的依据。
4. **门禁为最低回退触发线**：每批提交前 typecheck + check:ui-layer + 单测必须全绿；任何一条失败即整批回退或修复后再提，不携带黄灯提交。

---

## ⑤ 新发现补充（审计之外 / 修正）

1. **ui/Select 是「建好未接线的落点组件」，不是新抽象**：`ui/Select/Select.tsx:3-9` 头注释自证「SettingsSelect 迁移即以此为落点」，且「T05.3.2 的 SettingsSelect 迁移即以此为落点」——即该组件是为承接 SettingsSelect 而建，5 个 SettingsSelect 消费方（FontSettingsSection/WorkflowForm/SettingsSecurityTab/SettingsSchemaRenderer/SettingsRulesTab，grep 复核）至今未迁移。B5 的定位是「落点组件接线 + 退役旧件」，成本显著低于「新建抽象」。
2. **useChatPanelSync 不是死代码——审计 P3-4 结论修正**：`BinaryTreeWorkspace.tsx:26` import、`:141` 实调 `useChatPanelSync()`；`store/layout-tree/conversationUnit.ts:165` 注释亦引用其语义（「用于 close/activate 后及 useChatPanelSync 的归一化」）。审计 §6.3 与 P3-4 的「无消费者？疑似死代码」存疑不成立。处置：保留 + 进 hooks barrel + 补文件头职责注释（当前 `hooks/useChatPanelSync.ts:57` 导出无注释）。
3. **旧 Tooltip 消费数复核**：grep 实际命中 85 个业务文件（审计口径 88，差异含测试与组件自身引用），结论不变（85:4 仍悬殊）；已按此数设定 B1 批次边界。
4. **useAnimatedPresence 双份的删除面确认**：grep 复核 `hooks/useAnimatedPresence.ts` 唯一消费者是旧 Tooltip（components/Tooltip/Tooltip.tsx:3,77），ui/Dialog/useAnimatedPresence 为独立实现（ui/Dialog/useAnimatedPresence.ts:4 注释自证从 hooks/ 提炼）——B1 退役步骤可安全删除 hooks/ 版本，删除面 = 1 文件。
5. **`.ui-btn` 全局类消费面复核**：grep 命中 36 个组件文件使用 `.ui-btn` 体系——B2 第一波机械映射的基线（审计未给此精确数）。
6. **ui/Select 回调命名与审计 03-3.1 的对应**：ui/Select 已用 `onChange(value)`（Select.tsx:29），SettingsSelect 用 `onOpen()` 自研接口（SettingsSelect.tsx:18）——B5 迁移后「同类回调命名混用」清单（审计 §3.1 的 onSelect/onChange/onOpen）自动消解两项。

---

## ⑥ 风险

| # | 风险 | 触发场景 | 缓解 |
|---|---|---|---|
| 1 | **语义替换误判导致视觉回归** | Button 裸 button 意图判定错误（危险/ghost 分错） | 变体判定规则表评审前置；每批视觉回归抽样 3~5 按钮；单批可整批回退 |
| 2 | **a11y 升级的「假收益」** | Tooltip/Switch 替换后无人验证 SR 行为，认为替换即完成 | 行为变更点清单 + SR 抽查作为批次验收项（B1 键盘冒烟 / B3 播报验证） |
| 3 | **TabStrip 能力对齐不足** | 拖拽/溢出/上下文差异超出基座插槽可消化面 | 能力盘点表先行；差距大者标「暂缓」或降级为业务封装层组合，不扩基座 props |
| 4 | **双轨扩大** | 迁移中途新需求继续用旧件 | 红线 a（评审拦截）+ 门禁 + 退役步骤排入同阶段验收 |
| 5 | **巨型组件拆分行为漂移** | 拆分时顺手「改进」而非「只搬」 | 「只搬不写」原则 + 行为测试全绿才进入下一步 |
| 6 | **与 01 样式方案交叉漂移** | primary 语义未定案时做 Button 变体映射 | 顺序依赖声明：01 P1-5 定案先于 B2 映射表；两方案在变体映射表握手；--tooltip-translate 修复并入 B1 |
| 7 | **批量过大评审失效** | 单批超 30 文件后评审流于形式 | 原则上限 20 文件/批；超限拆批 |
| 8 | **SettingsSelect 迁移行为回归** | 5 消费点的 onSelect 参数语义与 ui/Select 的 onChange 不匹配 | 逐点核对表签字 + 5 点行为人工验证（打开/选择/关闭/Esc/外点关闭） |
| 9 | **hooks barrel 全量导出引发命名冲突** | 40+ hooks 中存在同名导出或重名类型 | 建 barrel 时先做导出冲突清单；冲突项在 barrel 内显式别名并记录 |
| 10 | **窗口化列表引擎切换性能回归** | WindowedSessionUl 接入 useVirtualScroll 后滚动行为变化 | E1 先出决策记录文档；长列表滚动帧率抽样；回归不达标则回退决策分支 |

---

## 附：与相邻方案的关系

- **01 样式一致性方案**：本方案消费其「primary 语义定案」「--tooltip-translate 修复」；本方案的组件接管反过来缩小 01 的全局类清理面（.ui-btn/settings-field-input/settings-switch 退役即 01 的 shell-polish.css/settings-base.css 裁剪输入）。两方案在 B2 变体映射表上握手。
- **08 a11y 方案**：本方案承载其 P1-1（Tooltip 迁移）、P2-5（确认对话框）、P3-3（tab 键盘）及部分 P2-9（按钮文案）；08 的对比度/快捷键（P1-8 Esc Esc）属 a11y 方案独立推进。
- **03/04/05/07 方案**：状态、通信、代码质量、性能维度的修复与本方案并行不冲突；05 的行数门禁是本方案 D 阶段防回潮护栏（依赖声明）。
- **测试资产**：本方案所有步骤遵守 AGENTS.md 测试资产保护铁律——迁移不删测试（测试随组件迁移，如 UnitSessionTabStrip 的 3 套 a11y 测试移植为 ui/TabStrip 测试）；reference/markdown-editor 门禁与本方案无交集但改动后仍需跑通 `npm test`。
