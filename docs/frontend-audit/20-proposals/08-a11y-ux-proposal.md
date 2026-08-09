# 可访问性（a11y）与 UX 一致性修复方案（08）——a11y 契约、键盘闭环、单源收敛

> 方案类型：可访问性与 UX 一致性（键盘可达、语义/ARIA、对比度、文案与提示一致性、交互模式收敛）。
> 输入：`docs/frontend-audit/10-analysis/08-a11y-ux-consistency-audit.md`（主审计，P0×0/P1×8/P2×10/P3×5，合计 23 项）、`docs/frontend-audit/00-cross-analysis.md`（主控交叉结论）、`docs/error-notification-governance/00-cross-analysis.md`（提示面收敛关联）、`20-proposals/01-style-unification-proposal.md` 与 `02-component-system-proposal.md`（组件/样式衔接）。
> 性质：只读方案 + 一份文档，无代码改动；文中数字基于 2026-08-09 工作区状态（关键面已代码级复核，见 ⑤）。
> 日期：2026-08-09。

---

## ① 目标态：a11y 契约（终态验收标准）

### 1.1 契约总纲（一句话）

**「鼠标路径 = 键盘路径」**——任何交互元素都必须存在等价的键盘操作路径；任何 hover 揭示都必须有 focus 配对；任何浮层/对话框都必须完成「打开→聚焦→漫游→Esc→焦点归还」闭环；任何展示型文案都必须单一真源。

### 1.2 终态验收特征（全部可量化，与审计问题一一对应）

| # | 契约 | 目标值 | 对应审计项 |
| --- | --- | --- | --- |
| C1 | Tooltip 唯一实现 | ui/Tooltip 唯一；旧 `components/Tooltip/` 目录删除；88 处消费统一 | P1-1 |
| C2 | 全部交互元素键盘可达 | hover-only 揭示面全部补 focus-within/focus-visible 配对；无 `display:none` 阻断 Tab 序的交互元素；键盘可达性矩阵全绿（见 ④） | P1-4/P1-5/P1-6/P3-4/P2-8 |
| C3 | 菜单/对话框四模式符合 APG | menu/dialog/tablist/listbox 四模式键盘契约全达标（见 ④ 表） | P1-3/P3-1/P3-3 |
| C4 | 确认对话框唯一基座 | window.confirm 生产代码 = 0；全仓确认交互 = ui/ConfirmDialog 一处；role="alertdialog" 仅出现在真模态上下文 | P2-5/P1-7 |
| C5 | 快捷键单一真源 | 设置页无静态副本；展示 binding == 执行 binding（注册表+overrides）；无序列键误触分叉路径 | P2-6/P1-8 |
| C6 | 所有图标按钮有可访问名 | 无文本无 aria-label 的 button 扫描 = 0；名称与 Tooltip content 同源 | P1-2 |
| C7 | 对比度 AA 达标 | ③表全部组合 ≥ 阈值（正文 4.5:1、大字/UI 3:1）；断言测试进 vitest | P2-1~P2-4 |
| C8 | 动态状态播报覆盖 | 消息流 role="log"；状态条 aria-live="polite"；播报分级符合现有 63 处基线 | P2-7 |
| C9 | 文案一致性 | 加载态「动词+中…」全角省略号统一；快捷键文案/绑定无双源 | P2-9/P2-6 |
| C10 | 动效偏好双通道 | prefers-reduced-motion + data-reduced-motion 同语义接线 | P2-10/P3-2 |
| C11 | 防回潮门禁 | a11y 断言（对比度/无名称按钮/confirm 清零/单源一致）进 vitest unit；键盘 e2e 保留 5 个专项 spec | 全项 |

### 1.3 与 01/02 方案的职责边界（防重复设计）

| 本方案承接 | 其他方案承接 |
| --- | --- |
| a11y 契约定义：Tooltip 键盘触发/aria-describedby 验收标准；ConfirmDialog 的 ARIA 与焦点行为契约；对比度 token 值契约与断言 | 02-B1：ui/Tooltip 基座迁移与旧件退役（机械替换节奏） |
| ConfirmDialog 的 a11y 契约（alertdialog 语义/初始焦点/焦点归还/Esc 栈继承 ui/Dialog） | 02-E3：ui/ConfirmDialog 组件设计与 8~9 处迁移执行 |
| 对比度 token 目标值与断言测试（③表） | 01-S6：token 值调整落地（值改在样式方案，断言在本方案） |
| 键盘行为验收（走查矩阵/键盘 e2e） | 02-B6：ui/TabStrip 提炼（P3-3 roving tabindex 随收敛消失） |

**依赖链**：本方案步 1 ↔ 02-B1、步 2 ↔ 02-E3、步 6 ↔ 01-S6——依赖步只声明契约与验收，不重复组件/样式设计。

---

## ② 分步方案（7 步，逻辑顺序；每步独立提交、独立门禁）

### 覆盖映射总表（23 项全闭环）

| 步 | 名称 | 关闭的审计项 |
| --- | --- | --- |
| 步 1 | Tooltip 迁移联动 | P1-1 |
| 步 2 | 确认对话框统一 | P2-5、P1-7 |
| 步 3 | 快捷键单一真源 | P2-6、P1-8 |
| 步 4 | 图标按钮名称补齐 | P1-2、触屏尺寸（审计 7.3） |
| 步 5 | hover-only 键盘闭环 | P1-4、P1-5、P1-6、P2-8、P3-4、P3-1、P3-3（验收） |
| 步 6 | 对比度修复 | P2-1、P2-2、P2-3、P2-4、P3-5 |
| 步 7 | 键盘漫游与 SR 审计收尾 | P1-3、P2-7、P2-9、P2-10、P3-2 |

**每步输出即下一步输入**：步 1 产出「迁移后仍无名称按钮清单」→ 步 4 消费；步 2 产出确认交互清单 → 步 7 键盘矩阵消费；步 3 的 binding 定案 → 步 7 的快捷键走查基线；步 5 的键盘矩阵模板 → 步 7 全量展开。

---

### 步 1：Tooltip 迁移联动（P1-1，依赖 02-B1）

| 项 | 内容 |
| --- | --- |
| 任务内容 | 本步不重复 02-B1 的迁移执行（基座就绪/88 处分批迁移/旧件退役由 02-B1 承接），本步聚焦 **a11y 契约与验收**：① 制定 Tooltip a11y 契约并写入 ui/Tooltip 文件头注释——focus/blur 触发（键盘可达，与 hover 语义一致，delayHide 尊重）、aria-describedby 关联触发元素与 role="tooltip"、视口钳位（F7-F8 已实现，契约固化防回归）；② **批次验收**：02-B1 每批（约 20 文件）迁移完成后跑键盘冒烟——Tab 聚焦 icon 按钮 → tooltip 出现；Shift+Tab 离开 → 消失；③ 输出「迁移后仍无名称按钮清单」：ui/Tooltip 的 aria-describedby 是**补充说明，不替代名称**，88 处消费点中仍无 aria-label 的图标按钮逐一登记，交步 4；④ SR 抽查 3 个代表面（AppTopBar、DiffCard、ChatComposer），确认播报「按钮名 + 说明」 |
| 涉及文件面 | 验收侧不改代码：ui/Tooltip/Tooltip.tsx（契约注释）、02-B1 的 88 个消费文件（验收对象）、本步产出 1 份清单文档 |
| 验证方式 | 每批 `npm run typecheck` + `npm run test:coverage -- --project=unit`（ui/Tooltip 测试保活）；键盘冒烟脚本（playwright 或 testing-library：focus 触发/失焦隐藏/aria-describedby 存在断言）；SR 抽查 3 面；退役步跑全量 vitest |
| 完成判据 | grep 旧 Tooltip import = 0；`components/Tooltip/` 目录不存在；键盘触发抽样 100% 通过；aria-describedby 关联断言全绿；清单交付步 4 |

> 闭环输出：①清除 88 处 a11y 断层面；②为步 4 提供准确的无名称按钮清单（避免二次全量扫描）。

---

### 步 2：确认对话框统一（P2-5 + P1-7，依赖 02-E3 的 ui/ConfirmDialog）

| 项 | 内容 |
| --- | --- |
| 任务内容 | ① 声明 ConfirmDialog a11y 契约（02-E3 实现时照此验收）：role="alertdialog" + aria-labelledby（title）+ aria-describedby（message）、打开后初始焦点落取消钮、FocusTrap 圈定、Esc 关闭且归还原焦点（继承 ui/Dialog 三件套）、danger 变体不可默认聚焦确认钮；② **9 个 window.confirm 调用点迁移**（实测 9 个文件面，审计口径 ×8——见 ⑤-2）：`ComposerField.tsx:136`、`TiptapComposerField.tsx:253`（强制取消）、`useDiffGitActions.ts:264`（放弃修改）、`DiffCard.tsx:113`（大文件复制）、`ProjectPickerMenu.tsx:111`（移除项目）、`useSidebarContextMenu.ts:215`（删除会话）、`useFilePreview.ts:135`（覆盖文件）、`useFileNavigation.ts:121`（未保存切换）、`SettingsUsageTab.tsx:523-524`（清空用量）；③ **三个异步化难点**（同步布尔 → 流程挂起/继续）：useFileNavigation:121、useFilePreview:135、ComposerField 系强制取消——改造为「挂起流程 + ConfirmDialog onConfirm 回调继续」状态机，这是本步最大行为风险点，逐点列行为变更清单；④ BgTaskActions:178-200 内联确认行改走 ConfirmDialog（role="alertdialog" 滥用随之消失，P1-7）；⑤ 文案模板统一：危险操作「确定要…吗？」+ 不可逆后果说明，与 WithdrawConfirmDialog 风格一致；⑥ 门禁：grep `window.confirm` = 0 + 单测断言「无 confirm 调用」 |
| 涉及文件面 | 9 个调用点 + BgTaskActions.tsx + ui/ConfirmDialog（02-E3 新建）+ WithdrawConfirmDialog.tsx（风格对齐参考） |
| 验证方式 | 每个调用点交互回归（确认/取消两路径，含 Esc/遮罩/焦点还原）；3 个异步化点的流程级测试（挂起→确认→继续 / 取消→不继续）；键盘验证（初始焦点、焦点圈定、Esc 归还）；SR 抽查 alertdialog 播报；grep 清零 |
| 完成判据 | `window.confirm` 生产代码 = 0；全仓确认交互唯一基座（ui/ConfirmDialog）；异步化三点的行为变更清单签字通过；键盘/焦点逐点验证表全绿 |

> 闭环输出：确认交互清单（9+1 点）交步 7 键盘矩阵；消除第三套确认实现，UX 一致性直接回应「同一效果不同呈现」。

---

### 步 3：快捷键单一真源（P2-6 + P1-8）

| 项 | 内容 |
| --- | --- |
| 任务内容 | ① **数据层定源**：`BUILTIN_SHORTCUTS`（ShortcutRegistry.ts:19-35）为唯一默认源——ShortcutService constructor 已消费（:41-45）+ `shortcuts.overrides` 覆盖（loadCustomOverrides）；② **展示层收敛**：SettingsShortcutsTab 的 `DEFAULT_SHORTCUTS`（:20-27）与 `SHORTCUT_ITEMS`（:29-47）静态副本删除，改为从 BUILTIN_SHORTCUTS 派生（label/desc/group 并入 ShortcutMeta 或派生映射表，group 为设置页独有展示维度可保留派生表）；CheatsheetModal 已走 `getAllActions()`（真实执行源）保持不动；③ **绑定级漂移修复**（见 ⑤-1，比审计的文案漂移更严重）：`open_security` 设置页 Ctrl+Shift+E vs 注册表 Ctrl+Shift+S、`toggle_runtime` 设置页 Ctrl+` vs 注册表 Ctrl+Shift+R——以注册表（执行真源）为准统一；`export_logs`（注册表有、设置页无）与 `close_tab`（设置页有、注册表无）补入同一清单；④ **文案统一**：注册表 label 以产品口头语为准——「新建会话」→「新建对话」、「分叉会话」→「分支对话」（SidebarNav/SessionStrip/GlobalSessionTabBar 全量使用「新建对话」）；⑤ **Esc Esc 误触分叉封死（P1-8）**：二选一（推荐 A）——A. 分支会话改组合键（候选 Ctrl+Shift+F，需先在 detectConflicts 全量冲突检测后定案；审计 6.4 的冲突检测仅 DEV，本步顺带接生产兜底）；B. 保留序列但加抑制窗口（Dialog Esc 关闭后 1s 内序列不匹配）+ 弹显式二次确认。A 根除误触面（连按 Esc 不再产生任何副作用），B 为保守兜底；⑥ **单源断言测试**：新增单测断言「设置页派生数据 == 注册表（含 overrides 后）binding/label 全等」 |
| 涉及文件面 | ShortcutRegistry.ts、SettingsShortcutsTab.tsx、ShortcutService.ts（序列抑制或改键）、AppShortcuts.ts（Esc 消费面）、ShortcutService.test.ts（更新+新增）、CheatsheetModal.tsx（不动，验证） |
| 验证方式 | `npm run typecheck` + vitest（ShortcutService.test 全量，含新单源断言）；键盘走查：Esc Esc 场景（对话框开→关→再按 Esc 无副作用；新绑定触发分支会话）+ toast/撤销路径复验；改键后设置页展示与真实执行一致（人工改键→触发验证） |
| 完成判据 | 设置页无静态 binding/label 副本（grep DEFAULT_SHORTCUTS 移除或由注册表派生自证）；展示 binding == 执行 binding 断言全绿；Esc Esc 误触路径封死（无对话框刚关闭的 500ms 内触发分叉的路径）；label 与 UI 口头语一致 |

> 闭环输出：binding/label 定案表 → 步 7 快捷键走查基线；CheatsheetModal 数据面已同源，回归验证即可。

---

### 步 4：图标按钮名称补齐（P1-2 + 触屏尺寸）

| 项 | 内容 |
| --- | --- |
| 任务内容 | ① **16 个按钮补 aria-label**（消费步 1 清单 + 审计清单复核）：DiffCardFileList.tsx:152/166/178（取消暂存/暂存/放弃修改）、:264/278（接受/拒绝）、FileActions.tsx:76/96（选择打开方式/更多菜单）、FilesCard.tsx:148/153（上级目录/刷新）、FileViewerCard.tsx:249/307/319（打开方式/复制源码/更多）、ModelConfigEditor.tsx:672/692（配置/删除）；② **名称与 Tooltip content 同源防漂移**：为消费点提供约定——aria-label 文案与 Tooltip content 同一常量/同一声明（可借助 ui/Tooltip 组合「label+content 双绑定」的小型封装或直接常量复用），杜绝「按钮名与提示文案两处各写」；③ **触屏目标尺寸**（审计 7.3）：`.hoverActBtn` 22×22 → ≥24×24（DiffCard.module.css:859-871）、`.session-actions-btn` 18×18 → ≥24×24（shell-sidebar.css:286-300，与步 5 的 focus-within 揭示同文件处理）；小档 ui-size 下最低 22px 的豁免需在代码注释登记依据（WCAG 2.5.5 间距豁免）；④ **门禁**：新增扫描断言（无文本、无 aria-label/aria-labelledby/title 的 `<button>` = 0），接入 vitest unit 或 check 脚本，防回潮 |
| 涉及文件面 | 5 个组件文件（16 按钮）+ 2 处 CSS + 1 个门禁脚本/断言测试 |
| 验证方式 | 渲染面扫描断言全绿（该断言直接覆盖 16 个按钮）；axe 或等价扫描 5 文件无「无名称按钮」violation；SR 抽查 3 个代表按钮（DiffCard 接受/拒绝、FileViewer 复制源码）；尺寸计算样式断言（computed style ≥24px 或登记豁免） |
| 完成判据 | 无名称 button 扫描 = 0；名称与 Tooltip 文案同源（抽查无两处各写）；目标尺寸 ≥24px（豁免登记在案）；门禁对「新增无名称按钮」能红 |

> 闭环输出：名称清单入库 → 步 7 的 SR 抽查基线与键盘矩阵数据源。

---

### 步 5：hover-only 键盘闭环（P1-4/P1-5/P1-6 + P2-8/P3-4/P3-1/P3-3）

| 项 | 内容 |
| --- | --- |
| 任务内容 | ① **DiffCard hoverActions**（P1-6）：`.hoverActions { display: none }`（DiffCard.module.css:834）→ `.accordionHeaderRow:hover .hoverActions` 揭示（:847）——改 `opacity:0 + visibility:hidden` + `:hover, :focus-within` 揭示（对照 GlobalSessionTabBar.module.css:258 成熟模式），Tab 序与焦点环随 focus-within 进入；② **.session-actions-btn**（P3-4）：`opacity:0` 仅 hover 揭示（shell-sidebar.css:286-305）→ 补 `:focus-within` 揭示，焦点环可见；③ **LeafToolTabStrip 添加菜单**（P1-4）：加号按钮补 onClick 开关（onPointerDown 保留触屏路径）或整体迁 ui/Menu 基座（推荐后者，获得 Esc/方向键/焦点管理全包）；④ **ModelBadgePickerMenu**（P1-5，核心功能键盘阻断）：行按钮补 onClick/Enter 展开子菜单；子菜单展开后焦点移入首项、Esc 逐级关闭归还；hover 展开保留为增强路径（80/150ms 定时器不动）；行按钮 aria-expanded 改为与真实打开态绑定（消除 hover 驱动 ARIA 状态、见 ⑤-3）；⑤ **Menu children 模式默认漫游**（P2-8）：Menu.tsx:133 的 `options.length > 0` 门控改为「options 有值用索引漫游 / children 模式对 content 内可聚焦项轮询漫游」双通道；⑥ **listbox 语义降级**（P3-1）：DiffCardFileList.tsx:301 `role="listbox"` + option → `role="list"` + listitem（该列表不承担组合选择语义，降级优于补 roving——避免为一个静态列表引入全套 listbox 键盘模式）；⑦ **P3-3 验收**：LeafToolTabStrip role="tab" 方向键由 02-B6 TabStrip 收敛承接（6 消费点合一），本步只验收不重复实现 |
| 涉及文件面 | DiffCard.module.css + DiffCardFileList.tsx、shell-sidebar.css、LeafToolTabStrip.tsx（或其 ui/Menu 迁移）、ModelBadgePickerMenu.tsx + module.css、ui/Menu/Menu.tsx、DiffCardFileList.tsx:301 |
| 验证方式 | 键盘可达性矩阵（见 ④）：逐场景走查「目标元素是否进入 Tab 序 / 有无键盘操作路径」；playwright 键盘 e2e（参照 tests/e2e 键盘专项 spec 模式：keyboard-navigation）；菜单漫游单测（children 模式新增用例）；视觉回归（hover 揭示改为 focus-within 后鼠标路径观感不变） |
| 完成判据 | 键盘可达性矩阵全绿（矩阵中无「仅鼠标可达」项）；无 display:none 阻断 Tab 序的交互元素（grep 复核）；Menu children 模式 ↑↓/Home/End 可用；模型切换键盘路径全通（聊天页 Tab 可达→Enter 展开→方向键选模型）；listbox 滥用清零 |

> 闭环输出：键盘可达性矩阵模板 → 步 7 全量展开（复用同一走查工具与记录格式）。

---

### 步 6：对比度修复（P2-1~P2-4 + P3-5，依赖 01-S6）

| 项 | 内容 |
| --- | --- |
| 任务内容 | ① **token 值调整落地由 01-S6 执行**（值改一处、消费面自动跟随），本步承接：目标值契约（③表）交付 01-S6；② **消费面核对清单**（确保调值后语义不跑偏）：ghost 按钮文字（shell-polish.css:67）、时间戳/侧栏元信息、ChangesSection.tsx:128/139 增减计数、FileTreeView.tsx:213 状态字、ModelConfigEditor.tsx:799、ModelProfileList.tsx:273 状态点、StatusDiagnosticsPanel WARN（#e8590c）——其中「橙色/绿色作为文字色」的用法需改指文字专用 token（如 --text-warning-strong / --text-success-strong），accent 色保留作图标/装饰；③ **对比度断言测试**（本步新增，进 vitest unit，仿 style-contract 模式）：sRGB 相对亮度计算遍历 ③表全部组合 + 全部语义色 token × 主题背景（light #f0eee9 / #e9e5de、dark #0d0d0d），阈值 4.5:1 / 3:1 分类断言——01-S6 调值后此测试即红灯转绿的验收器，也是防回潮门禁；④ **P3-5 字号约定**：--font-size-nano 10px 仅限角标类且配 text-secondary 色；--font-size-xxs 11px 下限约定写入 tokens.css 注释 |
| 涉及文件面 | tokens.css（01-S6 执行，本步核对）、ChangesSection.tsx/FileTreeView.tsx/ModelConfigEditor.tsx/ModelProfileList.tsx/StatusDiagnosticsPanel 等消费面（改 token 引用）、新增 a11y-contrast.test.ts |
| 验证方式 | `npm run typecheck` + vitest（新断言测试先红后绿——01-S6 调值后转绿）；light/dark 双主题截图抽查 6 个代表面（时间戳/ghost 按钮/侧栏/增减计数/状态点/状态诊断 WARN）；对比度人工目测复核 |
| 完成判据 | ③表全部组合 ≥ 阈值（断言绿）；无 accent 色直接作小字正文的用法残留（grep 复核）；截图无肉眼突变；断言测试能对「新增不达标组合」红 |

> 闭环输出：对比度断言测试成为 01-S6 的验收器与全量防回潮门禁。

---

### 步 7：键盘漫游与 SR 审计收尾（P1-3 + P2-7/P2-9/P2-10/P3-2）

| 项 | 内容 |
| --- | --- |
| 任务内容 | ① **ChatHeaderMore renderItem 补 role="menuitem"**（P1-3）：Menu.tsx:175-184 漫游查询已覆盖 `[role="menuitem"]`，补 role 后焦点链路全通（renderItem 模板 ChatHeaderMore.tsx:77-90 加 `role="menuitem"` 即可，无需改基座）；② **动态播报补齐**（P2-7）：ChatStatusRibbons 状态条（:257 role="region"）补 `aria-live="polite" aria-atomic="true"`（状态 chip/后台任务数/计划模式变化播报）；chat-message-list/ 消息容器（ChatMessageList/MessageVirtualizer）补 `role="log" aria-relevant="additions"`（流式新消息到达播报，对照 ApprovalAskCard:561/658 既有模式）；③ **加载态文案统一**（P2-9）：WorkflowForm.tsx:230 裸「…」→「保存中…」；FileViewerCard.tsx:386、DiffCodeViewer.tsx:41 的 ASCII 三点「...」→ 全角「…」；统一「动词+中…」约定（ui/Button loading 态内建文案默认值，与 02-B2 衔接）；④ **data-reduced-motion 接线**（P2-10）：reduced-motion.css 补 `[data-reduced-motion]` 选择器（与 @media 同语义、同一规则块），lightweightMode.ts:56 的死钩子复活；⑤ **硬编码过渡 token 化**（P3-2）：ApprovalAskCard.module.css:297 `transition: width 0.1s linear` → `--transition-press`；tab-drag.css:42/46 两处 → `--transition-*` token；⑥ **全量键盘漫游审计**：四模式（menu/dialog/tablist/listbox）APG 对照矩阵（见 ④），结合步 2/4/5 的清单全量走查；现有 5 个 e2e 键盘专项 spec（ast-block-tables/format-checker/ime-composition/keyboard-navigation/wysiwyg-interaction）全量回归 |
| 涉及文件面 | ChatHeaderMore.tsx、ChatStatusRibbons.tsx、ChatMessageList.tsx、MessageVirtualizer.tsx、WorkflowForm.tsx、FileViewerCard.tsx、DiffCodeViewer.tsx、reduced-motion.css、lightweightMode.ts、ApprovalAskCard.module.css、tab-drag.css、ui/Button（loading 文案约定，与 02-B2 协同） |
| 验证方式 | `npm run typecheck` + vitest 全量 + `npm run test:coverage -- --project=unit`；playwright 键盘 e2e 全量（含 5 个专项 spec 回归）；SR 抽查（对话框/菜单/消息流三个代表性场景的播报）；axe 或等价扫描无新增 violation |
| 完成判据 | 键盘四模式矩阵全绿；role="log"/aria-live 断言存在且生效；加载态文案 grep 无裸「…」/ASCII 三点残留；[data-reduced-motion] 生效（轻量档动画停）；5 个 e2e 专项全绿 |

> 闭环输出：全量键盘矩阵 + a11y 断言测试成为 CI 常驻门禁，23 项审计全部关闭。

---

## ③ 对比度修复表（P2-1~P2-4 值契约，01-S6 落地）

> 按 WCAG 2.1（AA：正文 4.5:1、大字/UI 组件 3:1）sRGB 相对亮度。候选值为第一档，落地时以 a11y-contrast 断言测试复测为准（不达标则加深一档），**取值以断言绿为唯一判据**。

| # | 组合 | 现值 | 现状判定 | 目标阈值 | 候选值（第一档） | 落点 | 主要消费面 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | #888888 / #f0eee9（light text-tertiary） | 3.06:1 | ❌ 4.5 | ≥4.5:1 | #757575 档 | tokens.css `--text-tertiary`（light） | 时间戳、ghost 按钮文字（shell-polish.css:67）、提示性文字 |
| 2 | #888888 / #e9e5de（light 侧栏元信息） | 2.82:1 | ❌ | ≥4.5:1 | 随 tertiary 加深后复测；仍不足则侧栏元信息改 text-secondary | tokens.css + 侧栏消费面 | 侧栏元信息 |
| 3 | #f59e0b / #f0eee9（accent-orange 文字） | 1.85:1 | ❌ 3:1 也不足 | ≥4.5:1 | 文字专用 `--text-warning-strong`：#c2410c 档 | tokens.css 新增文字 token；ChangesSection.tsx:128/139、FileTreeView.tsx:213、ModelConfigEditor.tsx:799 改引用 | 改动增减计数（+N −N）、橙色状态字 |
| 4 | #2f81f7 / #f0eee9（accent-blue 文字） | 3.23:1 | ❌ 4.5 | ≥4.5:1 | #1e6fd9 档（复测） | tokens.css `--accent-blue` 或文字变体 | 链接/强调文字 |
| 5 | #16a34a / #f0eee9（color-active 绿） | 2.84:1 | ❌ 3:1 | 状态点 ≥3:1；状态文字 ≥4.5:1 | #15803d 档（复测） | tokens.css `--color-active` | ModelProfileList.tsx:273 状态点/状态字 |
| 6 | #e8590c / #f0eee9（ui-text-warning） | 3.09:1 | ❌ 4.5 | ≥4.5:1 | #c2410c 档（与 #3 同档，可共用 token） | tokens.css `--ui-text-warning`（或收敛入 --text-warning-strong） | StatusDiagnosticsPanel WARN |
| 7 | #737373 / #0d0d0d（dark text-tertiary） | 4.1:1 | ⚠️ 边缘 | ≥4.5:1 | #8f8f8f 档 | tokens.css `--text-tertiary`（dark 分支） | dark 元信息 |
| 8 | #a3a3a3 / #0d0d0d（dark text-secondary） | 7.7:1 | ✅ | 保持 | — | — | 达标项锁定，防回退 |

**语义约定**：accent 色（--accent-orange/--accent-blue/--color-active）保留作图标/装饰/非文字用途；**文字用途一律走文字专用 token**（--text-warning-strong / --text-success-strong / 加深的 --text-tertiary）——从消费面切断「装饰色当文字用」的通道。断言测试遍历本表组合 + 全语义色 token × 主题背景，测试文件 `a11y-contrast.test.ts` 进 vitest unit（值断言，不受覆盖率口径约束，同 style-contract 模式）。

---

## ④ 键盘闭环设计

### 4.1 总原则

1. **hover 揭示必须 focus 配对**：任何 `:hover` 揭示的交互元素必须有 `:focus-within`（或 `:focus-visible` 变体）等价揭示——键盘用户的焦点环不能画在透明/隐藏元素上；
2. **鼠标路径 = 键盘路径**：任何 onPointerDown/onMouseEnter 驱动的交互必须有 onClick/onKeyDown 等价路径；
3. **焦点闭环**：打开浮层 → 焦点移入首项 → 方向键漫游 → Enter 激活 → Esc 关闭 → 焦点归还 trigger——五个环节缺一不可；
4. **序列键不产生无意识副作用**：任何「双击/序列」绑定不得与既有关闭/取消语义冲突。

### 4.2 四模式 APG 契约表（步 7 验收标准）

| 模式 | 打开 | 初始焦点 | 漫游 | 激活 | 关闭与归还 | 本仓库参照/修复点 |
| --- | --- | --- | --- | --- | --- | --- |
| menu | trigger Enter/Space/↓ | 首个未禁用项（Menu.tsx:121-126 已实现） | ↑↓ 循环（已实现）；Home/End（补齐）；children 模式轮询漫游（步 5-⑤） | Enter（已实现） | Esc（Menu.tsx:165-168）+ 归还 trigger | SidebarContextMenus focusMenuItem（标杆）；ChatHeaderMore 补 role（步 7-①） |
| dialog | 任意 | 取消钮（ConfirmDialog 契约） | Tab 循环（FocusTrap） | Enter 激活默认钮 | Esc 栈（Dialog.tsx:116-126）+ 还原（useRestoreFocus） | ui/Dialog 已达标；ConfirmDialog 继承（步 2） |
| tablist | — | roving tabindex | →/← 或 ↑/↓ + Home/End | Enter/Space 激活 | — | UnitSessionTabStrip S4.5（蓝本）；02-B6 TabStrip 收敛（步 5-⑦ 验收） |
| listbox | — | roving tabindex | ↑↓ + Home/End | Enter 选择 | — | DiffCardFileList 降级 role="list"（步 5-⑥），不承担组合选择语义 |

### 4.3 hover 揭示修复矩阵（步 5 任务清单的可执行表）

| 场景 | 现态 | 目标态 | 对照先例 |
| --- | --- | --- | --- |
| DiffCard .hoverActions | display:none → 仅 :hover（Tab 序不可达） | opacity/visibility + :hover/:focus-within | GlobalSessionTabBar.module.css:258 |
| .session-actions-btn | opacity:0 → 仅 .session-item:hover | 补 :focus-within | 同左（38 处 focus-within 惯例） |
| LeafToolTabStrip 添加菜单 | 仅 onPointerDown 打开，无 Esc/焦点 | 迁 ui/Menu（onClick + Esc + 首项聚焦） | Menu 基座 |
| ModelBadgePickerMenu 子菜单 | 仅 hover 状态驱动 | onClick/Enter 展开 + 子菜单焦点管理；hover 保留为增强 | SidebarContextMenus 键盘漫游 |

### 4.4 Esc Esc 误触分叉的封死设计（P1-8）

```
现状：第一击 Esc 被 Dialog 关闭消费 → 500ms 内第二击 Esc 匹配序列 'Escape Escape' → 静默分叉（AppShortcuts.ts:143-161）
目标（推荐 A）：分支会话改组合键 Ctrl+Shift+F（ShortcutRegistry.ts:24 改 defaultBinding）
  ├─ 改键前：detectConflicts 全量冲突检测（AppShortcuts.ts:192-199 现仅 DEV → 接生产兜底）
  ├─ 改键后：Esc 单键语义唯一 =「关闭/取消」，无任何序列绑定残留（ShortcutService 序列引擎仅保留显式序列绑定）
  └─ 兜底（若 B 方案被裁决）：Dialog 关闭事件后 1s 抑制窗内序列不匹配 + 分叉前显式 ConfirmDialog 二次确认
```

### 4.5 键盘可达性矩阵（步 5 起步、步 7 全量展开的验收工具）

每轮输出一张表（记录格式固定，可复用多轮迭代）：

```
| 交互场景 | 触发元素 | 鼠标路径 | 键盘路径（Tab 序可达? / 操作键） | 焦点归还 | SR 播报 | 状态（🟢/🔴）|
```

矩阵数据源 = 步 2 确认交互清单 + 步 4 名称清单 + 步 5 走查结果 + 审计全部交互面；全量矩阵完成即步 7 判据。

---

## ⑤ 新发现补充（方案编写期间代码级复核，2026-08-09）

1. **【新发现·比审计更严重】快捷键双源存在绑定级漂移，不止文案漂移**：`SettingsShortcutsTab.tsx:20-27` 的 `DEFAULT_SHORTCUTS`（新装用户设置页展示值）与 `ShortcutRegistry.ts:19-35`（ShortcutService constructor 实际注册的执行值）有三处**绑定不一致**：`open_security`（设置页 Ctrl+Shift+E vs 注册表 Ctrl+Shift+S）、`toggle_runtime`（设置页 Ctrl+` vs 注册表 Ctrl+Shift+R）；且 `export_logs`（注册表有、设置页无）、`close_tab`（设置页有、注册表无）清单互缺。即用户按设置页显示的绑定不触发任何功能——「文案漂移」之外还有「绑定漂移」，步 3 一并修复（以注册表为执行真源）。
2. **【新发现·计数修正】window.confirm 实测 9 个文件面**（审计口径 ×8）：`SettingsUsageTab.tsx:523-524` 为条件调用（`window.confirm && !window.confirm(...)`）双行，其余 8 处单点——实际 9 个文件面、10 次调用。步 2 迁移基线以 grep 实测为准（10 次调用点逐一登记）。另注意其中 **3 处是同步布尔返回值驱动流程**（`useFileNavigation.ts:121` 未保存切换、`useFilePreview.ts:135` 外部修改覆盖、ComposerField/TiptapComposerField 强制取消）——不是纯 UI 替换，需异步化（挂起流程 + onConfirm 回调继续），这是步 2 行为风险最大的面。
3. **【新发现·ARIA 状态与能力不符】ModelBadgePickerMenu 行按钮 `aria-expanded={isHovered}`（:84）由 hover 状态驱动**：SR 播报「按钮，展开状态」但键盘无法改变该状态（无 onClick）——比「键盘不可达」更深一层：屏幕阅读器用户被播报引导尝试展开而必然失败。步 5-④ 修复时 aria-expanded 必须改绑真实打开态（onClick/Enter 路径共用状态），hover 仅作视觉增强。
4. **【新发现·单源方向确认】CheatsheetModal 已走执行真源**：`CheatsheetModal.tsx:32` 消费 `ShortcutService.getInstance().getAllActions()`（注册表 + overrides 的真实集合），而设置页是唯一失源方——步 3 只需修设置页，Cheatsheet 数据面已同源（回归验证即可），修复面比审计预估小。
5. **【新发现·文案缺口】`open_models` 无对应设置页项？已核对**：设置页 SHORTCUT_ITEMS 含 `open_models`（:31）但 DEFAULT_SHORTCUTS（:20-27）**未给 open_models 默认绑定**（注册表有 Ctrl+Shift+M）→ 新装用户设置页该行显示「未设置」而实际 Ctrl+Shift+M 生效——同属绑定级漂移清单，步 3 统一补上。

---

## ⑥ 风险

| # | 风险 | 触发场景 | 缓解 |
| --- | --- | --- | --- |
| R1 | **步 2 异步化改造行为回归**（最大风险）：同步布尔 confirm → 流程挂起/继续状态机，取消路径漏改导致「取消后仍执行」 | useFileNavigation/useFilePreview/ComposerField 三点 | 逐点行为变更清单 + 流程级测试（挂起→确认→继续 / 取消→不继续 两路径）；每点独立提交 |
| R2 | **步 3 改键冲突**：Ctrl+Shift+F 候选被其他绑定占用（现冲突检测仅 DEV） | 分支会话新绑定不生效或覆盖其他功能 | 冲突检测接生产兜底先行；定案后 keyboard e2e 全量回归；Esc 语义唯一化后无序列残留 |
| R3 | **步 5 改 hover 行为影响鼠标体验**：hover 揭示改 focus-within 后鼠标路径观感变化 | DiffCard hoverActions、session-actions-btn | hover 保留为主路径、focus-within 仅增补；视觉回归（鼠标路径前后截图对比） |
| R4 | **步 6 调值牵动视觉基线**：tertiary/orange/绿加深改变整体明暗观感 | 时间戳/ghost 按钮等大面积变深 | 与 01-S6 串行（01 先收混色基线、本步后调值，避免两批视觉变化叠加）；候选值以断言绿为唯一判据 + 截图对照 |
| R5 | **步 1/2/5 依赖 02 方案节奏**：02-B1/E3 未完成时本方案验收无法落地 | Tooltip 迁移、ConfirmDialog 缺基座 | 契约与断言先行（本方案文档即契约）；验收后置不阻塞；02 完成即刻执行 |
| R6 | **a11y 断言测试的覆盖率口径**：新增断言测试若被覆盖率门禁误伤 | vitest unit 45/70/65/45 口径 | 断言测试为值/文本断言（同 style-contract 模式），明确不受覆盖率约束；入 test 脚本时注明 |
| R7 | **键盘矩阵「纸面全绿、实际失效」**：走查记录与真实行为脱节 | 人工走查遗漏、e2e 覆盖不足 | 矩阵每项绑定自动化断言（playwright 键盘 spec）；5 个 e2e 专项 spec 为强制回归面（AGENTS.md 铁律：禁止删除） |
| R8 | **序列键抑制误伤正常双击 Esc 用户**（若走 B 方案） | 抑制窗内合法分叉被拦 | 抑制窗仅对「对话框关闭后」生效（有明确起点）；推荐 A 方案（改组合键）从根上消除该权衡 |

**回退总原则**：7 步各自独立提交、独立门禁（typecheck + vitest + 相关 e2e）；单步失败仅回退该步（git revert），不跨步回滚；行为变更面（步 2 异步化、步 3 改键、步 5 hover 改造）开工前先出变更清单，作为人工验收与回退判定依据。

---

## 附：与相邻方案的关系

- **02 组件体系方案**：本方案承接其 B1（Tooltip 迁移）与 E3（ConfirmDialog）的 a11y 契约与验收，不重复迁移执行；P3-3 由 02-B6 承接、本步验收。
- **01 样式统一方案**：对比度 token 值调整由 01-S6 落地（本方案③表为值契约 + 断言测试为验收器）；步 5 的 hoverActions/focus-within 修复消费 01 的 tint/focus-ring 契约。
- **error-notification-governance（提示收敛）**：本方案 P2-7 的 aria-live 播报分级与通知横幅收敛共享「播报面唯一性」原则；toast 文案策略（成功禁 toast、错误分级）已在 useToastQueue 收敛，本方案不重复，仅将加载态/确认文案纳入一致性口径。
- **测试资产**：遵守 AGENTS.md 铁律——5 个 markdown-editor e2e 专项 spec 与 tests/e2e 键盘 spec 为回归强制面，本方案所有步骤禁止删除；新增断言测试（a11y-contrast/无名称按钮/confirm 清零/单源一致）为增量资产，完成后 `git add` 提交入库。
