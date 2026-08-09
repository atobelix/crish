# 样式统一修复方案（01）——token 唯一真源、组件样式收敛、扩展性设计

> 方案类型：样式体系（tokens/全局类/module.css 归属分配、混色收敛、暗色收编、动效与卫生治理）。
> 输入：`docs/frontend-audit/10-analysis/01-style-consistency-audit.md`（主审计，P0×3/P1×8）、`docs/ui-style-audit/01-style-degradation-audit.md`（退化定位）、`docs/frontend-audit/00-cross-analysis.md`（交叉结论）、`docs/frontend-audit/10-analysis/02-component-architecture-audit.md`（组件面）、`08-a11y-ux-consistency-audit.md`（对比度与动效面）。
> 协同：`docs/frontend-audit/20-proposals/02-component-system-proposal.md`（组件体系方案）——本方案只管**样式层**（token/档位/归属/退役），组件 API 抽象以 02 为准；两方案共享依赖、互不重复实现。
> 性质：只读方案，无代码改动；所有数字基于 2026-08-09 工作区状态（423 处混色 31 档已复核复现）。
> 日期：2026-08-09。

---

## ① 目标态：token 唯一真源 + 样式归属三层收敛 + 可扩展

### 1.1 目标态总述

```
样式体系终态（与 02 组件方案的 ui/ 原子层对接）：
┌─ 第一真源：styles/tokens.css（纯 token）+ styles/z-index.css（纯 z 档位）
│     —— 静态 :root 定义 + [data-theme="dark"] 分支定义 + [data-ui-size] 档位
│     —— 运行时 themeStore 注入层与静态定义**同值同源**（消除双层漂移）
├─ 第二层：样式归属分配（本方案 S 表）
│     —— 组件形态 → ui/ 原子组件的 module.css（唯一）
│     —— 产品级全局形态 → 全局样式文件（菜单/面板/滚动条契约等，每语义单一实现）
│     —— 业务私有形态 → 业务 module.css，但只允许引用 token + 组件暴露的 CSS 变量
└─ 第三层：契约门禁（style-contract.test.ts 扩展，fs 断言）
     —— 禁新裸混色档位 / 禁新裸 999px / 禁新 scrollbar 块 / dark 分支覆盖校验 /
        !important 总量 ratchet / token 无悬空引用
```

**目标态验收特征（全部可量化）**：

| 特征 | 目标值 | 对应审计问题 |
|---|---|---|
| hover/激活淡染唯一语义源 | 423 处裸混色 → 0；档位收敛为 `--tint-*` 3 档 + 专用档 4 档 | P1-2 |
| 同效果动画时长 | spinner/脉冲/骨架各 1 档 token | P2-1 |
| 滚动条实现 | 31 个块 → 1 个全局契约（shell-scrollbar.css）+ 组件禁用开关 | P1-6 / P3-9 |
| 菜单壳层 | 10+ 种 → ui/Menu 唯一基座 + 3 档密度变体 | P1-5 |
| 输入 focus 反馈 | 全输入族统一 focus-ring 契约 | P1-7 |
| primary 语义 | 4 套 → 1 套 + 2 个受控变体 | P1-1 |
| 状态色 | 3 套（--color-* / --ui-* / GitHub rgba）→ --color-* 唯一 | P1-8 |
| diff 着色 | 2 套 → token 系唯一 | P1-4 |
| dark 适配 | 补丁式 theme-dark.css → 组件自适应 token（补丁残留 0） | P2-7 |
| !important | 673 → ≤100（预留 reduced-motion/快照白名单口径） | P3-1 |
| 硬编码 | 裸圆角 79 → 0；裸色值 48 → 0；裸动效时长 → 0 | P3-6/P3-7 |
| 悬空 token 引用 | 47 处基线 → 0（有 fallback 或已定义） | P0-3 |
| 编码卫生 | 5 个 GBK 文件 + chat.css 乱码 → UTF-8 无 BOM | P3-8 |

### 1.2 样式归属分配表（S 表：收敛进哪一层）

组件化原则（用户明确要求：常用功能写成组件、留足扩展点、避免过度封装）在样式侧落为以下分配规则，与 02 方案的组件 API 设计互补：

| 视觉语义 | 归属层 | 落点 | 扩展方式（见 ③） |
|---|---|---|---|
| 按钮 | ui/ 原子组件 | ui/Button/Button.module.css（02-B2 接管后 .ui-btn 退役删除） | variant/size union + `--btn-*` 变量 |
| 输入框 | ui/ 原子组件 | ui/Input/Input.module.css（02-B4） | size/tone + `--input-*` 变量 |
| Tab 条 | ui/ 原子组件 | ui/TabStrip/*.module.css（02-B6 新建） | variant（tabs/pill/segment）+ `--tab-*` 变量 |
| 菜单/下拉 | ui/ 原子组件 | ui/Menu/Menu.module.css（正主，扩展密度变体） | density + `--menu-*` 变量 |
| 弹窗 | ui/ 原子组件 | ui/Dialog/Dialog.module.css（已上岗） | size/role + `--dialog-*` 变量 |
| 徽标/状态 pill | ui/ 原子组件（新建 ui/Badge）或 状态色 token | `--color-*` 语义色 + 徽标基类收敛 | tone（neutral/success/warning/error/info） |
| 卡片/面板 | 全局类 + token | `[data-panel]` 基准迁出 tokens.css 后作为全局契约；圆角/底色走档位 token | `--panel-*` 变量 |
| 分隔线 | token 族 | `--hairline`/`--hairline-strong`/`--divider-strong` 三档 | 语义化选用，禁裸写法 |
| 滚动条 | 全局契约 | shell-scrollbar.css 唯一出口 | `--scrollbar-*` 变量覆盖 |
| hover/active 淡染 | token 族 | `--tint-hover/--tint-active/--tint-strong` + `--bg-hover/--bg-active` 保持 | 语义映射，禁裸混色 |
| 状态色/diff 色 | token 族 | `--color-*` + `--accent-*-light-adaptive`（补静态定义） | 语义映射 |
| 动画时长 | token 族 | `--transition-*`/`--duration-*` 全量引用 | 新档位先加 token 后引用 |
| 排版工具类（.text-*/.font-*） | 全局层 | shell-polish.css 排版段保留（剥离按钮/输入段后） | 继续全局类 |
| focus 环 | 全局层 | focus-visible.css 契约，组件不得背离 | 全局契约 + 组件内 `--focus-ring` 引用 |
| 业务私有形态 | 业务 module.css | DiffCard 行内操作、diff 行高亮等局部特殊性 | 只允许引用 token；局部差异用业务私有 CSS 变量（无全局类扩散） |
| 一次性场景 | 业务 module.css 内联 | 单消费点专用样式不升格 | 不做组件 |

**归属裁决原则**（防止过度封装与防止不封装两个方向的失控）：

1. **≥3 消费点或 ≥2 变体或承担关键 a11y 契约** → 进 ui/ 原子层（对齐 02 原则一）。
2. **产品级全局语义**（面板/菜单壳/滚动条/焦点环/减少动效）→ 全局样式文件单一实现，不做成 React 组件。
3. **单消费点专用形态**（如 DiffCard 的行内接受/拒绝按钮）→ 业务 module.css 私有，但样式值必须全部来自 token（含运行时注入 token），禁止硬编码；需要差异化时通过"业务私有 CSS 变量"在局部定义，不新造全局类。
4. **新代码红线**（01 审计 §7.5）：禁裸 `color-mix(--text-primary X%)`、禁裸 999px、禁裸 scrollbar 块、禁裸动画时长——全部以 style-contract 测试断言强制（见 S1）。

### 1.3 依赖与共享边界（与 02 方案、其他方案）

| 本方案步骤 | 依赖 | 共享边界 |
|---|---|---|
| S0 P0 兜底 | 无 | 独立可先行（快赢） |
| S3 按钮体系 | 02-B2（ui/Button 接管） | 02 管组件接管与 API，本方案管 primary 语义档位、`.ui-btn` 退役后的删段、icon-only 尺寸档位 |
| S4 Tab 族 | 02-B6（ui/TabStrip 新建） | 02 管 items 协议与键盘语义，本方案管圆角/高度/active 档位 token 与 inset 皮肤去 !important |
| S5 输入族 | 02-B4（ui/Input 接管） | 02 管组件 API，本方案管 focus 契约与全局类退役 |
| 对比度（tertiary/orange/绿） | 08-a11y 方案 | 本方案在 S6 落地 token 值调整，a11y 的对比度断言由 08 承接 |
| 快照联动 | 01 退化审计 E-03 | 任何 module.css 内容变更都触发哈希漂移 → 每次提交同步 `test:snapshots` |

---

## ② 分步方案（8 步，逻辑顺序；每步独立提交、独立验证）

### 总览与依赖链

```
S0 P0 兜底（悬空引用/死规则）        ← 无依赖，快赢，建立基线
 └→ S1 token 真源基线（tint 档位 + dark 补缺口 + 运行时注入层对齐 + 契约测试）
     └→ S2 混色 31 档批量收敛（423 处，视觉差异最大单一来源）
     └→ S3 按钮体系（primary 语义 + .ui-btn 退役）        [依赖 02-B2]
     └→ S4 Tab 族（档位 token + inset 去 !important）      [依赖 02-B6]
         └→ S5 表面族（菜单/输入/滚动条/徽标/卡片/分隔线）  [依赖 02-B4]
             └→ S6 暗色收编 + 状态色唯一真源
                 └→ S7 动效与卫生收尾（时长 token/纯 token 化/!important ratchet/编码）
```

每步产出即下一步输入：S1 的 tint 档位是 S2 的替换目标；S1 的 `--tab-*`/`--btn-*` 变量约定是 S3/S4 的档位来源；S3/S4 删段后 S7 的 shell-polish/shell-workspace 清理面缩小；S6 的 dark 自适应 token 是 S5 组件样式的前置收敛。

---

### S0：P0 兜底——悬空引用兜底、死规则删除、chart 色修正

| 项 | 内容 |
|---|---|
| 任务内容 | 1. **DiffCard 悬空兜底**：DiffCard.module.css:583/:880 补 fallback 并与 :740-754 同款（`var(--accent-green-light-adaptive, color-mix(in srgb, var(--accent-green) 10%, var(--bg-primary)))`），同时清理 9 处 `--hover-bg/--active-bg` 黑色 rgba fallback（:457/462/988/1032/1061/1125/1160/1184/1237 → `--bg-hover/--bg-active`，暗色 hover 恢复可见，即 01 退化审计 P1-02）；2. **Tooltip 静态兜底**：双份 Tooltip.module.css 的 `--tooltip-translate` 补 `var(--tooltip-translate, translate(0))`（静态层无兜底，防内联注入缺失时动画退化）；3. **死规则删除**：shell-workspace.css:869-872 `.card-tab.active` 第二声明（被 :843-846 bg-primary !important 压制，为死代码）删除，恢复 `--bg-active` 语义通道；4. **chart 色修正**：SettingsUsageTab.module.css:275/281/321/328 `--chart-color-1/2` → `var(--accent-chart-out/in)`（对照 chartBarStack 结构确认 in/out 对应，即 01 退化审计 P1-01）；5. **z 档位补全**：`--z-drag-overlay-max` 补定义（z-index.css 加档位或改引 `--z-drag-overlay`），BinaryTreeWorkspace.module.css:286 / UnitSessionTabStrip.module.css:340 的 99999 fallback 删除 |
| 涉及文件面 | DiffCard.module.css、components/Tooltip/Tooltip.module.css、ui/Tooltip/Tooltip.module.css、shell-workspace.css、SettingsUsageTab.module.css、z-index.css、BinaryTreeWorkspace.module.css、UnitSessionTabStrip.module.css（约 8 文件） |
| 验证方式 | `npm run typecheck`；`npm run test:snapshots`（值替换无哈希影响，删规则/补定义可能漂移，随批更新快照）；style-contract 新增 3 条断言（见下）；视觉抽查：DiffCard 暗色 hover、tooltip 入场动画、settings 用量页图表柱可见性 |
| 完成判据 | grep 无 fallback 悬空引用 = 0（`rg "var\(--(hover-bg|active-bg|chart-color)" ` 清零）；`.card-tab.active` 仅剩一条声明；style-contract 断言落地：①dark 下 DiffCard hover 计算样式非 rgba 黑系 ②SettingsUsageTab 无 chart-color 引用 ③tokens.css 无 `--chart-color` 定义残留 |

> 本步为纯值/删死规则修复，不改变任何 token 体系，风险最低；同时建立 style-contract 的断言模式，供 S1-S7 复用。

---

### S1：token 真源基线——tint 档位、dark 补缺口、运行时注入层对齐、契约门禁

| 项 | 内容 |
|---|---|
| 任务内容 | 1. **新增 tint 档位 token 族**（tokens.css :root 定义，dark 分支同值复用——淡染强度双主题一致）：`--tint-hover: color-mix(in srgb, var(--control-mix-color) 4%, transparent)`、`--tint-active: … 8% …`、`--tint-strong: … 14% …`；`--bg-hover/--bg-active` 改定义为 `var(--tint-hover)/var(--tint-active)` 的语义别名（值不变，防渲染漂移）；2. **专用档**：`--tint-focus-ring`（10%，对齐 focus-visible.css 现有 fallback 值）、`--tint-divider`（12%）、`--tint-scrollbar-thumb`（18%）、`--tint-overlay`（25%，遮罩用）；3. **dark 分支补缺口**：`[data-theme="dark"]` 分支补 `--sidebar-hover/--sidebar-active/--control-mix-color`（对齐 01 退化审计 P2-01 建议：`color-mix(in srgb, var(--text-primary) 5%/8%, var(--bg-secondary))`）；4. **运行时注入层对齐**（本方案新发现③）：themeStore.ts:706-742 的 18+ 处 setProperty 改为"静态 token 定义 + 运行时仅按主题微调"双层同源——`--bg-hover/--bg-active` 注入值与静态定义一致（现注入 3.5%/8% vs 静态 4%/8%），`--control-soft-*` 同理；静态 tokens.css 补一份与运行时等价的默认定义，注入失败时降级可用；5. **契约门禁**（style-contract.test.ts 扩展）：①色相关 token 必须在 dark 分支重新定义（泛化现有 F7-F27 断言：遍历 `--(bg|text|border|accent|color|tint|sidebar|control)-*` 前缀清单）②禁新裸 `color-mix(in srgb, var(--text-primary) X%,`（扫描 module.css，`-X` 按 S2 完成后清单）③禁新裸 `border-radius: 999`（应 `var(--radius-full)`）④禁新增 `::-webkit-scrollbar` 块 ⑤`!important` 总量 ratchet 断言（当前 673，每步减半递减） |
| 涉及文件面 | tokens.css（:root + dark 分支）、themeStore.ts、style-contract.test.ts（约 3 文件，纯真源层） |
| 验证方式 | `npm run test`（unit 全量，含 style-contract）；`npm run typecheck`；运行时验证：`applyTheme` 前后 `getComputedStyle(document.documentElement).getPropertyValue('--bg-hover')` 与静态值一致（可写一条 jsdom 契约测试读 tokens.css 文本比对）；themeStore 单测（若有） |
| 完成判据 | tint 6 档 + 语义别名齐备；dark 分支色 token 覆盖断言全绿；themeStore 注入值与静态定义同值（断言比对）；style-contract 5 条新契约全绿且能对"新增违规"红 |

> 本步是全部批量替换的地基：S2 的映射表、S3/S4 的档位、S6 的暗色收编都以本步 token 为唯一目标。`--bg-hover` 保持值不变，确保本步提交无任何视觉变化（纯新增 + 等价定义），可独立合入。

---

### S2：混色 31 档批量收敛（423 处基线，P1-2 主战场）

| 项 | 内容 |
|---|---|
| 任务内容 | 按语义映射表归位（S1 的 token 为目标）：`X ≤ 5% → var(--tint-hover)`（hover 淡染，主流 2/3/3.5/4/4.5/5%）、`6-9% → var(--tint-active)`（active/按下，主流 6/7/8/9%）、`10-16% → var(--tint-strong)`（强强调/高亮行）、`10% 的 focus-ring fallback → var(--tint-focus-ring)`、分隔线 12/14% → `var(--tint-divider)`、滚动条 18% → `var(--tint-scrollbar-thumb)`、遮罩 20/22/25% → `var(--tint-overlay)`；**仅两档映射需人工复核**：`1.2%/1.5%`（极淡，多为 md-code-bg 类特殊底色——改引用 `--md-code-bg` 语义而非 tint）与 `42%`（单点，多为按压态深浅控——人工看现场）。映射表先行落盘为文档（S2 执行时逐文件核对，不机械替换） |
| 涉及文件面 | 全仓 423 处：module.css 为主 + styles/ 全局层 + themeStore.ts 注入段（3.5%/8% 注入与静态同源后自然收敛）；按文件分批：每批 5-10 个 module.css，每批一个提交 |
| 验证方式 | 每批：`npm run typecheck` + `npm run test:snapshots`（哈希漂移随批更新，与 8e8c313c 教训一致——改内容与改快照同提交）+ 视觉抽查（playwright 采样 5 个代表组件：Tab hover、菜单项 hover、sort 行 hover、toast 按钮、滚动条拇指，比对替换前后 computed style 的混色值差异 ≤1.5%）；style-contract 断言 ② 对剩余裸混色计数递减 |
| 完成判据 | 裸 `color-mix(in srgb, var(--text-primary) X%,` 全仓 = 0（31 档清零）；视觉抽查 5 组件深浅观感与原设计意图一致（无肉眼可见突变） |

> 视觉差异最大单一来源（P1-2）。归位映射以"语义 → 档位"而非"数值 → 档位"，避免把 31 档压缩成 3 档导致 hover 深浅在个别组件明显变化——每个 ≥2 处同值档位的语义都在映射表注明。两档模糊场景（1.5%/42%）宁慢勿错，单独提交。

---

### S3：按钮体系收敛——primary 语义统一、.ui-btn 退役、icon-only 档位（P1-1/P2-9/P2-10）

| 项 | 内容 |
|---|---|
| 任务内容 | 1. **primary 语义唯一化**（01 审计 §1.1 四套 → 1 套 + 2 受控变体）：标准 primary = `--accent-color` 深炭（.ui-btn-primary/ui/Button.buttonPrimary 已有）；`TelemetryDialog.btnPrimary` 蓝色（全仓唯一蓝 primary）→ 标准 primary 或显式 `variant="accent"`（新增扩展点，语义为"品牌强调"而非主操作）；`WithdrawConfirmDialog.confirmBtn` 实心红 → `variant="danger"`（危险确认，与 ui/Button.buttonDanger 合并样式）；`FirstRunWizard.firstRunBtn.primary` 反相（dark 下观感翻转，P2-10）→ 保留"反相"观感但改为语义 token `--accent-inverted`（light=text-primary 底、dark=text-secondary 亮底，补 dark 分支定义，消除翻转）；2. **`.ui-btn` 全局类退役**（依赖 02-B2 完成 ui/Button 接管后）：shell-polish.css:18-86 按钮段删除；`:disabled` 态规则以 ui/Button.module.css:26-29 为准（P2-9 消歧）；3. **icon-only 尺寸档位**（P2-2）：六种尺寸 20/22/24/26/28px × 6/8/999px 圆角收敛为 `--control-height-xs/sm` 两档 + radius 档位（icon-only 按钮统一走 ui/Button `iconOnly` + size，02 方案 B2 承担 API，本方案管尺寸档位 token） |
| 涉及文件面 | TelemetryDialog.module.css、WithdrawConfirmDialog.module.css、FirstRunWizard.module.css、tokens.css（--accent-inverted 定义）、shell-polish.css（删段）、Button.module.css（icon-only 尺寸档）、约 30 个含私有按钮类的 module.css（危险/ghost 语义对齐）、02-B2 的消费点替换面 |
| 验证方式 | `npm run typecheck` + `npm run test` + `npm run test:snapshots`；grep `.ui-btn` 业务引用 = 0；视觉抽查：设置页/向导/确认弹窗三处 primary 对照截图（light + dark 各一张）；style-contract 断言 `--accent-inverted` 在 dark 分支定义 |
| 完成判据 | 全仓 `.ui-btn*` 类零引用；primary 观感唯一（深炭，蓝/反相/实心红仅剩显式变体）；icon-only 尺寸档位收敛到 2 档；dark 下 FirstRunWizard 无反相翻转 |

> 依赖 02-B2 的 ui/Button 接管完成（按钮组件形态的迁移节奏以 02 为准）。本步骤的"组件化扩展边界"见 ③-1：新增视觉语义 = 新增 variant union 成员 + 一个 module 类 + 语义 token，三者缺一不可。

---

### S4：Tab 族收敛——档位 token + inset 皮肤去 !important（P1-3/P2-8/P3-1 先行块）

| 项 | 内容 |
|---|---|
| 任务内容 | 1. **Tab 档位 token**（tokens.css 新增）：`--tab-radius-tabs: var(--radius-md)`、`--tab-radius-pill: var(--radius-full)`、`--tab-height: 26px`（24/26/28/30/32 五档收敛）、`--tab-active-bg: var(--bg-active)`、`--tab-hover-bg: var(--bg-hover)`、`--tab-active-border`、`--tab-close-radius`（radius-md/radius-xs/999px 三值收敛）；2. **消费点替换**（依赖 02-B6 的 ui/TabStrip 接管后）：GlobalSessionTabBar.module.css / UnitSessionTabStrip.module.css 逐行复制体删除（P2-8，~95% 重复），LeafToolTabStrip 药丸变体走 `variant="pill"`，`[data-panel]`/`.card-tab` 走 `variant="tabs"`；3. **inset 皮肤去 !important**（P3-1 最大单块，shell-workspace.css:366-499 ~130 行）：把 inset 皮肤从"全量 !important 重写"改为"CSS 变量覆盖"——在 `.app-container[data-shell-chrome="inset"]` 作用域内仅定义 `--tab-*`/`--ws-*` 变量（不重写规则），`.card-tab` 基础规则消费变量；4. `.card-tab` 死规则已在 S0 清除，此处不再留双声明 |
| 涉及文件面 | tokens.css、shell-workspace.css（inset 段重写 + .card-tab 段收敛）、GlobalSessionTabBar.module.css、UnitSessionTabStrip.module.css、LeafToolTabStrip.module.css、02-B6 的 ui/TabStrip 及其消费点 |
| 验证方式 | `npm run typecheck` + `npm run test:snapshots`；视觉抽查：classic/inset 两种 chrome 下 tab 的 hover/active/关闭钮（4 态截图对比）；style-contract 断言 shell-workspace.css inset 段 `!important` 计数 = 0；a11y 键盘漫游测试（02-B6 的 roving tabindex 单测）全绿 |
| 完成判据 | 全局 `!important` 计数下降 ≥130；Tab 圆角档位仅 2 档（tabs/pill）；tab 高度档位唯一；GlobalSessionTabBar 与 UnitSessionTabStrip 私有 module 规则归零（复制体删除）；inset/classic 观感切换无回归 |

> 本步同时是 P3-1（!important 673）的破题：inset 皮肤 130 行重写占全局 !important 近 1/4，先啃最大块，其余模块的 !important 治理在 S7 收尾。

---

### S5：表面族收敛——菜单/输入/滚动条/徽标/卡片/分隔线（P1-5/P1-6/P1-7/P2-3/P2-4/P2-5）

| 项 | 内容 |
|---|---|
| 任务内容 | 1. **菜单壳层**（P1-5）：ui/Menu 为唯一基座（02 已收敛 11 消费点），圆角档位统一 `var(--radius-xl)`（10px，弹层标准档；16px 硬编码 .context-menu、8px .addDropdownMenu 改档位引用），hover 淡染统一 `var(--bg-hover)`，阴影统一 `var(--shadow-lg)`；`.tabs-add-menu/.panel-dropdown/.sort-filter-menu/.chat-more-menu/.settingsSelectMenu/.sbQuickMenu` 等的"同观感私有壳"删除，消费点改 ui/Menu 变体；2. **输入 focus 契约**（P1-7）：`.ui-input:focus`（shell-polish.css:112-116）补 `box-shadow: var(--focus-ring)` + border-color 变深（对齐 ui/Input.module.css:45-50 的 focus-ring 形态）；`.settings-field-input`（settings-base.css:86-154）与 ui/Input 语义对齐；SidebarNav 搜索、ProjectPickerMenu searchBox 无独立 focus 的面补 focus-visible 兜底；3. **滚动条唯一出口**（P1-6/P3-9）：shell-scrollbar.css 为唯一契约（4px/10-14%/999px），31 个模块私有 `::-webkit-scrollbar` 块全部删除或改走 `--scrollbar-*` 变量覆盖（隐藏型滚动条如 tabs-bar/WorkspaceChromeBars 用 `--scrollbar-display: none` 档位）；4. **徽标/pill 状态色**（P2-5/P1-8 前置）：BgTaskCard .badge、McpSettingsTab 双 pill、ModelsSettingsTab 三 pill、Sidebar .modeChip、PermissionModeMenu .permPill、ChatMessageRow 双 chip 的状态色统一走 `--color-*` 语义（success/warning/error/info），底色淡染走 `--color-*-bg`；形状/尺寸档位走 `--radius-full` + 两档 padding token；5. **卡片与分隔线**（P2-3/P2-4）：卡片圆角档位收敛（5/6/10/12px → radius-md 或 radius-lg 二选一按层级）、底色 4 系收敛为 bg-card/bg-elevated 两档；分隔线 4 写法 → `--hairline`（细分隔）/`--hairline-strong`（结构分隔）/`--tint-divider`（色块区分）三档 |
| 涉及文件面 | ui/Menu/Menu.module.css、shell-menus.css、shell-polish.css（菜单段）、shell-scrollbar.css、settings-base.css、ui/Input/Input.module.css、约 25 个 module.css（菜单壳/输入/滚动条/徽标族消费点）、settings-models.css、settings-extensions.css |
| 验证方式 | 每批 `npm run typecheck` + `npm run test:snapshots`；grep 基线递减：私有 scrollbar 块 31→0、`border-radius: 16px` 菜单类 0、裸 `color-mix` 分隔线 0；视觉抽查：菜单 hover/阴影、输入 focus 环、三处滚动容器观感、徽标四态色；style-contract 断言 ④（scrollbar）全绿 |
| 完成判据 | 菜单圆角/阴影/hover 单一档位；全输入族 focus 有可见反馈；滚动条块 = 1；徽标状态色 100% `--color-*`；卡片圆角 2 档、分隔线 3 档 |

> 本步依赖 02-B4（Input 接管）与 02-B6（Menu 变体）的组件形态；样式档位在本方案先行定死，02 消费即可。

---

### S6：暗色收编 + 状态色唯一真源（P2-7/P1-4/P1-8/硬编码 48 处清零）

| 项 | 内容 |
|---|---|
| 任务内容 | 1. **diff 色收敛**（P1-4）：FileViewerCard.module.css:260-276 GitHub rgba 绿/红 → `var(--accent-green-light-adaptive, …)/var(--accent-red-light-adaptive, …)`（token 系，与 DiffCard :740-754 同款，含 dark 自适应）；2. **状态色唯一真源**（P1-8）：StatusDiagnosticsPanel.module.css 13 处 `--ui-bg-*` 遗留命名 + rgba(224,49,49)/(47,158,68)/(25,113,194)/(232,89,12) → `--color-error/--color-success/--color-info/--color-warning` 系（tokens.css 的 `--ui-text-*` 五连降级为 `--color-*` 别名，下一个大版本删除）；3. **theme-dark.css 补丁收编**（P2-7）：265 行逐条评估——①能落为 tokens.css dark 分支定义的（色值类，如 --md-code-*）迁移进 dark 分支；②选择器直接耦合全局类名的（.msg-*、.approval-*、.card-tab 等，重构即断裂）改为组件自适应 token（组件 module.css 内写 `[data-theme="dark"]` 局部或消费 dark 自适应 token）；③经 S3/S4/S5 已无对应类的死补丁（如 .cardSurface/.dropdownSurface 疑似）直接删除；目标：theme-dark.css 残留 ≤30 行（仅剩无法 token 化的特例）；4. **硬编码色清零**（01 审计 §3 的 48 处）：Sidebar overlayBackdrop rgba(0,0,0,0.3) → `var(--tint-overlay)`、WorkspaceChromeBars light-only fallback 补 dark 语义、TerminalCard fallback 语义化、App.module.css 兜底保留但注释说明；5. **对比度 token 值调整**（08-a11y 联动）：light `--text-tertiary` #888 → 更深档（≥4.5:1，#757575 档）、`--accent-orange` 文字用法改深橙（#c2410c 档）、`--color-active` 绿 #16a34a → 深档（≥3:1）——此三项值调整属样式方案落地，对比度断言测试由 08 方案承接 |
| 涉及文件面 | FileViewerCard.module.css、StatusDiagnosticsPanel.module.css、tokens.css（dark 分支扩展 + 对比度档）、theme-dark.css（收编）、Sidebar.module.css、WorkspaceChromeBars.module.css、TerminalCard.module.css、约 10 个 module.css（暗色缺口消费点） |
| 验证方式 | `npm run typecheck` + `npm run test:snapshots`；dark 视觉抽查（强制 data-theme=dark 截图 6 个代表组件：diff 面板、状态诊断、侧栏 hover、tooltip、菜单、badge）；style-contract 断言 ①（dark 分支覆盖）全绿；对比度复测（08 方案脚本）；grep 硬编码 rgba/hsl/hex 计数 48→0 |
| 完成判据 | FileViewerCard 与 DiffCard 同色系；--ui-* 业务引用 = 0；theme-dark.css ≤30 行；module.css 硬编码色值 0；text-tertiary/orange/active 对比度达标 |

> 暗色补丁式覆盖是"重构易断链"的根源（01 审计 §5.7）：本步把选择器耦合全局类的补丁转为 token 层定义，为后续组件重构扫清暗色侧地雷。对比度值调整会影响 S2 视觉基线，故排在其后。

---

### S7：动效与卫生收尾——时长 token 化、纯 token 化、!important ratchet、编码统一

| 项 | 内容 |
|---|---|
| 任务内容 | 1. **动效时长 token 化**（P2-1/P3-2）：散装时长 31 处（80ms×2/100ms×18/150ms×5/220ms×3/300ms×1/1s×4/1.2s×2/1.5s×5/1.6s×2/1.8s×1/2.2s×1）映射到 token——`--transition-press`（80ms）、`--transition-micro`（100ms）、`--transition-fast`（150ms）、`--transition-spring`/`--transition-popover-*`（180-220ms）、`--transition-smooth`（300ms）；同效果不同速收敛：spinner → `--transition-spin` 统一 0.8s、脉冲 → 新增 `--transition-pulse` 1.6s、骨架 → `--transition-skeleton` 1.5s；`[data-reduced-motion]` 属性接线（08-a11y 发现：lightweightMode.ts:56 写入该属性但无 CSS 消费——reduced-motion.css 补 `[data-reduced-motion]` 选择器，与 @media 同语义）；2. **Toast 死引用清理**（P2-6）：ToastStack.module.css 双重动画声明去重、未定义的 `@keyframes slideInUp` 删除（保留 :127 生效的 toast-slide-in）；3. **tokens.css 纯 token 化**（P3-3）：`[data-panel]` 基准（:750-765）、`.ui-popover-animate/.ui-modal-animate`（:739-747）、`::selection`、keyframes（:717-785）迁出到对应全局样式文件（panel 基准 → design-system.css 或 panels.css，keyframes → 消费方 module 或全局动画文件）；tokens.css 只留 token 定义；4. **死 token 清理**（P3-4）：`--slate-*`（design-system.css:5-17，零引用）删除；`--font-weight-semi` 8 处 → `--font-weight-semibold`；`--font-mono-features` 补定义或删引用；tokens.css:275 过时注释（引用已删的 zindex.ts/check:zindex）删除；5. **!important ratchet**（P3-1 收尾）：除 S4 的 inset 皮肤外，按"覆盖链依赖"治理：settings-base.css:969-989 的 settings-segment 全组 !important 改 token 覆盖、SettingsQuickMenu.module.css:75/84-85、InlineAgentPanel.module.css:321-332、ChatToolCallBlock.module.css:22 + chat.css:384/391 双重 border !important 去重；style-contract 断言 ⑤ 把总数 673 按 ratchet 递减（每轮 ≥-50），目标 ≤100（保留 reduced-motion 27 处 + 快照必需场景，白名单注明）；6. **编码统一**（P3-8，与快照同提交）：5 个 GBK 全局文件（panels.css、shell-dragdrop.css、shell-layout.css、shell-polish.css、shell-workspace.css）+ chat.css 注释双重损坏 → UTF-8 无 BOM 重写；**必须与 `test:snapshots` 更新同一提交完成**（8e8c313c 教训：字节序列变化 → CSS Modules 哈希漂移 → 快照红） |
| 涉及文件面 | 全部 31 处时长消费点、ToastStack.module.css、tokens.css、design-system.css、reduced-motion.css、lightweightMode.ts、settings-base.css、SettingsQuickMenu.module.css、InlineAgentPanel.module.css、ChatToolCallBlock.module.css、chat.css、5 个 GBK 全局文件 + 快照更新 |
| 验证方式 | `npm run typecheck` + `npm run test`（全量）+ `npm run test:snapshots`（编码统一与快照同提交）；style-contract 断言 ⑤ 全绿（!important 计数递减）；grep：裸时长（`animation: .*[0-9]+(ms|s)` 非 token）清零、`--slate-` 零引用、tokens.css 无选择器定义（`rg "^\s*(\.|\[data-panel]|@keyframes|::selection)" tokens.css` = 0）；编码验证：5 文件 UTF-8 无 BOM（`file`/字节检测）+ 注释可读 |
| 完成判据 | 动效时长 100% token；[data-reduced-motion] 接线；tokens.css 纯 token；!important ≤100；GBK/乱码清零且快照全绿 |

> 本步为收尾层，全部落在 S0-S6 的收敛结果上（!important 治理面已被 S4 缩小 130 处；编码统一在样式收敛完成后执行，避免中间态双重漂移）。

---

## ③ 扩展性设计说明

### 3.1 组件样式扩展点（样式侧与 02 组件 API 配套）

| 组件/族 | 扩展点（样式侧） | 扩展边界（明确"不做 X"） |
|---|---|---|
| Button | `variant`/`size` union 成员 + 对应 module 类；每实例可覆盖 `--btn-*` 变量（--btn-height/--btn-radius/--btn-pad-x）；icon 位插槽（children/icon 已有） | 不做自定义主题按钮（用 variant + 变量）；不做多标签按钮（组合 ButtonGroup 由业务层包）；新 variant 必须有 ≥2 真实消费点才进 union |
| TabStrip | `variant: 'tabs'\|'pill'\|'segment'` 三档（圆角档位 token 对应）；`--tab-*` 变量（--tab-height/--tab-radius/--tab-active-bg/--tab-close-radius）；`renderTab` 插槽（02 API）；items 协议（{id/label/icon/closable/badge}） | 不做溢出滚动条皮肤定制（滚动条走全局契约）；不做树形 Tab（用 Tree）；新 variant 先问"是需求还是设计癖好"（02 原则三） |
| Input | size/tone + `--input-*` 变量；focus 契约全局统一（focus-ring），组件不私改 | 不做搜索框专用组件（用 Input + prefixIcon）；不做富文本输入（tiptap 域） |
| Menu | density 变体（--menu-item-pad-y/--menu-radius 档位）；`--menu-*` 变量；items 协议（02 已有） | 不做右键菜单专用件（SidebarContextMenus 用 Menu 组合，键盘漫游以 ui/Menu 为准）；不做级联菜单（需求出现再建） |
| Badge（新建） | tone（neutral/success/warning/error/info）+ size（sm/md）；底色 `--color-*-bg` 自动跟随状态色 | 不做状态点（用 Badge size=sm 或专用状态色 token）；不做动态计数徽标（业务层组合） |
| 滚动条 | 全局契约 + `--scrollbar-*` 变量覆盖（宽/色/圆角/显示） | 不做每组件私有 scrollbar 块（契约红线）；隐藏型用 `--scrollbar-display: none` 档 |
| hover/active 淡染 | `--tint-*` 3 档 + 专用档；`--bg-hover/--bg-active` 语义别名保持 | 禁裸混色（契约红线）；新档位先加 token 后引用 |

### 3.2 token 体系的扩展协议

1. **新档位协议**：任何新的"同语义不同强度"需求 → 先在 tokens.css 加 token（含 dark 分支值），再消费；禁止先写裸值后补 token（S1 的契约断言强制）。
2. **语义别名协议**：`--bg-hover → var(--tint-hover)` 这类"语义名 → 档位名"映射只允许出现在 tokens.css 内部；消费方一律引用语义名，档位名变更不影响消费方。
3. **运行时注入协议**（新发现③的治理）：themeStore 注入的 token 全部在静态 tokens.css 有等价定义（同值），运行时仅做主题微调覆盖；新增注入变量必须同步静态定义 + 一条 style-contract 断言（静态文件中存在该名）。
4. **组件变量协议**：ui/ 组件用 `--<component>-*` 前缀暴露覆盖点；业务私有形态只覆盖变量，不复制规则。

### 3.3 防回潮机制

- style-contract.test.ts 为样式层唯一门禁（已有 fs 断言模式，扩展 5 条契约见 S1），进 vitest unit 门禁（45/70/65/45 覆盖率不含 CSS，契约测试为文本断言不受覆盖率约束）。
- 新代码评审红线（01 审计 §7.5 + 本方案 S 表）：禁裸混色档位/裸 999px/裸 scrollbar/裸时长/裸色值/悬空 token——契约测试兜底。
- 快照联动：module.css/全局 css 内容变更 → 哈希漂移 → `test:snapshots` 随批更新（S7-6 编码统一必须同提交）。

---

## ④ 新发现补充（代码复核新增/修正，2026-08-09）

以下为方案编写期间对主审计结论的代码级复核结果，供主控与其他子 Agent 校准：

1. **【P0-1 定性修正】** `--accent-green-light-adaptive` / `--accent-red-light-adaptive` **并非纯悬空引用**：`api/themeStore.ts:706-707` 在 applyTheme 时运行时注入（含暗色/微调补偿逻辑，:687-707）。真实的缺陷是：①静态层无定义无 fallback → 注入未发生（初始化失败/未来非注入环境）时渲染无效值；②DiffCard.module.css 内部不一致——:583/:880 无 fallback，同文件 :740/:743/:751/:754 有 fallback。修复 = 补静态等价定义 + 补 :583/:880 fallback（S0 已含），并借 themeStore 的对齐治理（S1）消解双层漂移。
2. **【P0-2 定性修正】** `--tooltip-translate` **运行时由 TSX 内联注入**（ui/Tooltip/Tooltip.tsx:302、旧 components/Tooltip/Tooltip.tsx:41-59，各按 side 计算 translate），**动画实际并未失效**。真实的缺陷是：静态 CSS 层（双份 Tooltip.module.css 各 4 处）无 fallback，注入缺失时 transform 退化；且双份实现各自注入、各自维护（重复面）。修复 = 静态 fallback 补齐（S0）+ 双份收敛为一份（02-B1 承接）。审计 P0 级别建议由"渲染无效"降为"静态无兜底依赖运行时注入"。
3. **【新发现·运行时注入层是事实第二真源】** themeStore.ts 运行时覆盖 18+ 个 token（--bg-primary/--bg-hover/--bg-active/--control-soft-*/--text-*/--border-*/--composer-bg/--accent-*-light-adaptive 等，:706-769），且部分与静态值不一致（如 `--bg-hover` 静态 4% vs 注入 3.5%、`--control-soft-*` 静态 4%/4%/8% vs 注入 6%/11%/17%）。**任何 token 修改必须静态定义 + 注入段双改**，否则"改了 tokens.css 没生效"。方案 S1 将其纳入真源管理并断言一致。
4. **【新发现·现有门禁抓手】** `src/styles/style-contract.test.ts` 已存在（fs 契约断言模式，F7-F14 z 硬编码 + F7-F27 --ui-text-* dark 覆盖），是现成的样式门禁载体——本方案全部契约断言扩展于此，无需新建测试框架；注意该测试位于 `src/styles/` 下，属 vitest unit 项目，加入断言不改变覆盖率口径。
5. **【新发现·编码损坏的具体样本】** shell-polish.css:53 注释为完整 GBK 乱码块（"婵炲棌鍓濈€垫粓…"），证明 5 个 GBK 文件内含有语义内容的中文注释（非仅 ASCII），统一编码时**注释内容会随解码恢复**，字节变化量大于预期，快照漂移面更大——更需与快照同提交（S7-6）。
6. **【与 02 方案共享依赖确认】** `docs/frontend-audit/20-proposals/02-component-system-proposal.md` 已存在且与本方案互补：02 管组件 API/接管节奏（B1-B6），本方案管样式档位/退役删段/契约（S1-S7）；两方案在 S3（按钮）、S4（Tab）、S5（输入/菜单）有显式依赖锚点，实施时需按依赖顺序串行推进（02-A 阶段可先行）。
7. **【复核确认】** 01 审计的 423 处/31 档混色（1.2%~42% 分布已复现）、`.card-tab.active` 双声明（shell-workspace.css:843 vs :869）、`.ui-input:focus` 无反馈（shell-polish.css:112-116 box-shadow:none + border 不变）均复核属实，作为方案基线有效。

---

## ⑤ 风险与回退

| # | 风险 | 影响 | 缓解/回退 |
|---|---|---|---|
| R1 | **CSS Modules 哈希漂移**（任何 module.css 内容变更 → 类名哈希变化 → 快照测试红） | 每步都可能红测试，若误判为"失败"而回滚会阻塞整轮 | 每步提交时同步 `test:snapshots` 更新（值与哈希同提交）；S7-6 编码统一为最大漂移面，单独立提交；失败即对照 diff 确认仅哈希变化（8e8c313c 教训复用） |
| R2 | **批量替换的视觉回归**（31 档→3 档，个别组件 hover 深浅突变） | 用户感知"样式变了" | 映射表按语义归位 + 两档模糊场景（1.5%/42%）人工复核单独提交；每批 5-10 文件粒度 + playwright 计算样式比对（混色值差异 ≤1.5%）；发现问题回退该批（git revert 单提交粒度） |
| R3 | **themeStore 运行时注入与静态层不一致**（双层漂移） | 改 token 不生效/部分生效，排查困难 | S1 强制静态定义等价 + 断言比对；注入段修改与静态定义同提交；style-contract 增加"注入 token 名 ∈ 静态 token 名"断言 |
| R4 | **组件接管依赖 02 方案节奏**（S3/S4/S5 依赖 02-B2/B6/B4） | 02 未完成时本方案相关步无法收尾 | 依赖步的**样式档位与契约先行落地**（tokens.css/契约测试不依赖组件）；02 完成接管后仅剩"删段"动作；两方案按 02-A → 01-S0/S1/S2 → 02-B → 01-S3~S7 的依赖链串行 |
| R5 | **!important 治理引发覆盖链回流**（删 !important 后底层规则生效，视觉意外） | 局部观感回归 | 优先拆 inset 皮肤（变量覆盖语义不变）；每删一个 !important 组做前后截图对比；ratchet 断言保证总量单调递减、不回涨 |
| R6 | **暗色收编误伤**（theme-dark.css 补丁删除后某组件 dark 观感丢失） | 暗色主题局部回归 | 逐条评估（S6 三分类）；dark 截图 6 代表组件对比；style-contract dark 覆盖断言全绿后才删补丁；保留"补丁残留 ≤30 行"的例外区 |
| R7 | **对比度调整牵动视觉基线**（text-tertiary/orange 加深） | 与 S2 视觉基线的相互影响 | 对比度调整排 S6（S2 之后），避免两批视觉变化叠加难定位；调值对照 08 方案断言脚本 |
| R8 | **过度封装**（组件化把一次性场景强行升格） | 灵活性下降、维护成本上升 | 归属裁决原则（S 表）：≥3 消费点/≥2 变体/a11y 契约三条件；每组件明示"不做 X"（③-1）；新 variant/新 token 必须 ≥2 真实消费点 |
| R9 | **编码统一的中途失败**（快照漂移后未同步，测试红） | 门禁阻塞 | 编码统一与快照更新单提交原子完成；CI 层补"css 文件编码 UTF-8 无 BOM"检查（字节检测脚本），防复发 |

**回退总原则**：每步独立提交、独立验证（typecheck + unit + snapshots + 视觉抽查四件套齐才提交）；单步失败仅回退该步（git revert），不跨步回滚；token 值等价替换步（S1）与视觉可变步（S2/S6 对比度）分离，保证"纯基建"提交可随时独立合入。

---

## 附：与主审计问题的映射

| 审计问题 | 本方案步骤 |
|---|---|
| P0-1（accent-adaptive 悬空）| S0（定性修正见 ④-1）|
| P0-2（tooltip-translate）| S0（定性修正见 ④-2）|
| P0-3（card-tab 死规则）| S0 |
| P1-1（primary 四套）| S3 |
| P1-2（423 处混色 31 档）| S1 + S2 |
| P1-3（Tab 4 套）| S4 |
| P1-4（diff 双色系）| S6 |
| P1-5（菜单 10+ 壳）| S5 |
| P1-6（滚动条 12 种）| S5 |
| P1-7（输入 focus 契约）| S5 |
| P1-8（状态色 3 套）| S6 |
| P2-1（动画时长散装）| S7 |
| P2-2（icon-only 尺寸）| S3 |
| P2-3（卡片/分隔线）| S5 |
| P2-4（徽标族）| S5 |
| P2-5（Toast 死引用）| S7 |
| P2-6（dark 补丁）| S6 |
| P2-7（Tab 复制粘贴）| S4 |
| P2-8（.ui-btn 无 disabled）| S3 |
| P2-9（FirstRunWizard 反相翻转）| S3 |
| P2-10（-）| — |
| P3-1（!important 673）| S4 + S7 |
| P3-2（ui/ 零消费）| 02 方案 B 阶段（本方案 S3/S4/S5 承接样式侧）|
| P3-3（tokens.css 不纯）| S7 |
| P3-4（死 token）| S7 |
| P3-5（shell-polish 职责混杂）| S3（删按钮段）+ S7（拆排版段）|
| P3-6（裸圆角）| S2/S5 中带出 |
| P3-7（裸 font-size）| S5 带出 |
| P3-8（编码卫生）| S7（快照同提交）|
| P3-9（scrollbar 31 块）| S5 |
| 01 退化 P1-01（chart-color）| S0 |
| 01 退化 P1-02（DiffCard hover）| S0 |
| 01 退化 P2-01（dark 侧栏 hover）| S1 |
| 01 退化 P2-04（--ui-bg-*）| S6 |
