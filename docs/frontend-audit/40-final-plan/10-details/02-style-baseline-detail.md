# T-B 样式基线轨道 · 详细执行计划（批次 2）

> 产出：`docs/frontend-audit/40-final-plan/10-details/02-style-baseline-detail.md`
> 输入：`00-master-plan.md`（批次 2 = 2.1 P0 兜底 / 2.2 token 真源 / 2.3 混色收敛 / 2.4 增补登记）、`20-proposals/01-style-unification-proposal.md`（S0-S2）、`30-reviews/01~03`（R-08 定性修正、R-11 遗漏补充、工具策略建议）、阶段 6 评审 `30-reviews/01-batch-structure-review.md` / `02-detail-technical-review.md` 与主控裁决（C-1/C-2/C-3）、`10-analysis/01-style-consistency-audit.md`（P0-1/2/3 证据）。
> 性质：可派发执行的详细计划（任务粒度 = 单 Agent 单提交）；全部行号为 **2026-08-09 工作区实测**（行号漂移防护：语义定位优先，行号仅作定位提示）。
> 声明：本文档为只读调研产物；所有"修复内容"为计划建议，执行时以门禁与视觉抽查为准。

---

## 修订日志

| 版本 | 日期 | 修订要点 |
|---|---|---|
| v1 → v2 | 2026-08-09 | 吸收阶段 6 评审（`30-reviews/01-batch-structure-review.md` U-1~U-3 / `02-detail-technical-review.md` ②-9、③-P2-2）与主控裁决：**C-1** tint 基底定案 `text-primary`（否决 control-mix，2.2-1 基底决策 / R4）；**C-2** `--tint-strong` 取 12%（否决 14%，2.2-1 档位值决策）；**C-3** 28% 档 settings 高亮 5 处新增专用 `--tint-highlight: 28%`（不进三档；2.2-1 定义值 / 3.2 映射 / 3.3 人工组 / 3.5 工具 / 批 D / 5.3 抽查同步更新）；**数字修正**：混色档位 31→**32**（02 评审 ②-9/P2-2 复核，分布表 32 项每档处数全部精确）；mock 键 13→11 属 01-detail（B6）面，本文档无该数字，不涉及；其余吸收：混色基线 423/426 已按 426 口径（B-P2-2 与本表一致）、批次 2 增补子步 2.4 登记（B-P0-1，见 §0）、themeStore 串行登记对称性由 05 侧补声明（02 评审 ③-P1-3，本侧 C11 不变） |

---

## 0. 执行范围与批次边界（沿用 00-master-plan 批次 2）

| 项 | 值 |
|---|---|
| 归属轨道 | T-B 样式基线（与 T-C 组件体系串行：tokens/样式基线先于组件样式接管） |
| 子任务 | 2.1 P0 兜底（01-S0，R-08 口径）→ 2.2 token 真源 + 双层同源（01-S1）→ 2.3 混色 32 档收敛（01-S2）→ 2.4 01-S3-任务1 primary 定案（批次 2 增补，登记见下） |
| 文件面冲突 | tokens.css 本批独占（批次 2 起至批 12 不交他人）；themeStore.ts 与 T-E 03-步骤2-D3（persistTheme 写端）同文件串行登记（C11），本批只动注入段（applyTheme），不碰 persist 写端 |
| 提交纪律 | 每子任务独立提交；S1 的"静态新增"与"注入对齐"拆两提交（02 评审 P1-1）；CSS 内容改动与 `test:snapshots` 同提交（8e8c313c 教训） |
| 派单前置 | `git status` 确认目标文件无并行域脏改动；当前已知脏文件（2026-08-09）：`messageSnapshotsBridge.ts`（R-10 前置清理，不属本批）、`usePreviewNavigation.ts`、`layoutRestorePolicy.ts`、Rust 域文件（严禁触碰） |

**批次 2 增补登记（01 评审 B-P0-1，待 master plan v1.0 落地）**：批次 2 增补子步 **2.4「01-S3-任务1：primary 语义定案 + `--accent-inverted` token（仅定案与 token，不做 .ui-btn 退役删段）」**——与 S2 无文件面冲突（只动 tokens.css 与 Shell 变量段，tokens.css 本批独占成立）；任务明细见 `20-proposals/01-style-unification-proposal.md` S3-任务1，本 detail 不重复展开；T7 派单前主控确认该提交已合入。

---

## ① P0 兜底任务表（01-S0，R-08 口径）

> R-08 定性修正：`--accent-*-light-adaptive` 由 themeStore.ts:706-707 运行时注入、`--tooltip-translate` 由 TSX 内联注入——**非"渲染无效"而是"静态层无兜底"**。验收判据从"渲染恢复"改为"补静态兜底 + 双源一致性"。

### 任务 2.1-1：DiffCard 悬空 accent-adaptive 兜底（补 fallback）

| 项 | 内容 |
|---|---|
| 文件/行号 | `apps/crish-desktop/src/components/diff/DiffCard.module.css:583`（`.inlineActionAccept:hover:not(:disabled)` 的 `background: var(--accent-green-light-adaptive);`）、`:880`（`.hoverActBtn.danger:hover` 的 `background: var(--accent-red-light-adaptive);`） |
| 现状证据 | 两处无 fallback；同文件 :740/:743/:751/:754 有 fallback（`var(--accent-green-light-adaptive, var(--accent-green-light))` / `…, color-mix(in srgb, var(--accent-green) 10%, var(--bg-primary)))` 等）——文件内不一致 |
| 修复内容 | :583 → `background: var(--accent-green-light-adaptive, color-mix(in srgb, var(--accent-green) 10%, var(--bg-primary)));`；:880 → `background: var(--accent-red-light-adaptive, color-mix(in srgb, var(--accent-red) 10%, var(--bg-primary)));`（与 :743/:754 同款 fallback 形态） |
| 验收断言 | ①`rg "var\(--accent-green-light-adaptive\)"`（裸引用、无 fallback）= 0；②style-contract 新断言"`--accent-green/red-light-adaptive` 在 tokens.css 有静态定义"（见 ⑤-8） |

### 任务 2.1-2：DiffCard 9 处黑色 rgba hover fallback 清理（01 退化 P1-02）

| 项 | 内容 |
|---|---|
| 文件/行号 | DiffCard.module.css:457（`.accordionItem .fileItem:hover`）、:462（`.isActive`）、:988（`.backBtn:hover`）、:1032（`.tabButton:hover`）、:1061（`.tabClose:hover`）、:1125（`.detailIconBtn:hover`）、:1160（`.collapseBar:hover`）、:1184（`.commitTriggerBar:hover`）、:1237（`.commitCloseBtn:hover`） |
| 现状证据 | 全部为 `var(--hover-bg, rgba(0,0,0,…))` / `var(--active-bg, rgba(0,0,0,…))` 双参形式；`--hover-bg`/`--active-bg` 为已不存在的历史 token，fallback 黑系 rgba 在 dark 下 hover 不可见（01 审计 §3 实锤） |
| 修复内容 | 删除 `--hover-bg`/`--active-bg` 悬空引用与黑系 fallback，改引现有语义 token：:457/:988/:1032/:1125/:1160/:1184/:1237 → `var(--bg-hover)`；:462/:1061（0.03/0.08，激活态）→ `var(--bg-active)`。注意 :457/:462 带 `!important`，替换时保留 |
| 验收断言 | ①`rg "var\(--(hover-bg|active-bg)"` 全仓 = 0；②视觉抽查：DiffCard 暗色 hover 有可见淡染 |

### 任务 2.1-3：Tooltip 双份静态兜底（R-08：TSX 内联注入，补静态 fallback）

| 项 | 内容 |
|---|---|
| 文件/行号 | `src/components/ui/Tooltip/Tooltip.module.css:21/25/32/36`、`src/components/Tooltip/Tooltip.module.css:18/22/29/33`（共 8 处 `transform: var(--tooltip-translate) scale(…)`，均无 fallback） |
| 现状证据 | `--tooltip-translate` 由 ui/Tooltip/Tooltip.tsx:302、components/Tooltip/Tooltip.tsx:41-59 按 side 内联注入（R-08/02-评审实读证实）；注入缺失时 transform 退化为无效（scale 级联失效）。双份文件逐行重复（01 审计 §1.6） |
| 修复内容 | 8 处改为 `transform: var(--tooltip-translate, translate(0)) scale(…)`（fallback 必须为 `translate(0)` 形态，与 scale 组合不破坏变换链；勿用 translateY(0)）。注：双份收敛为一份由 02-B1 承办（R-01 裁决，本任务只补 fallback） |
| 验收断言 | ①`rg "var\(--tooltip-translate\)"`（无 fallback 裸引用）= 0；②style-contract 断言两文件至少 1 处 `var(--tooltip-translate, translate(0)`（见 ⑤-8） |

### 任务 2.1-4：chart 色修正（01 退化 P1-01）

| 项 | 内容 |
|---|---|
| 文件/行号 | `src/components/settings/SettingsUsageTab.module.css:275`（`.chartBarOut`）、`:281`（`.chartBarIn`）、`:321`（`.chartLegendDotIn`）、`:328`（`.chartLegendDotOut`） |
| 现状证据 | 4 处引用未定义 token `--chart-color-1/2`（`rg --chart-color` = 0 定义）；`.chartBarOut`/`.chartLegendDotOut` 用 1，`.chartBarIn`/`.chartLegendDotIn` 用 2——in/out 语义明确 |
| 修复内容 | 改用法（不补定义，防双源）：`--chart-color-1` → `var(--accent-chart-out)`（:275/:328）、`--chart-color-2` → `var(--accent-chart-in)`（:281/:321）。`--accent-chart-in/out` 已在 tokens.css:68-69（light）/441-442（dark）定义 |
| 验收断言 | ①`rg "chart-color"` 全仓 = 0（含 tokens.css 定义残留）；②视觉抽查：设置页用量图表柱可见 |

### 任务 2.1-5：z 档位补全 + 99999 fallback 清理（含 R-11 修正）

| 项 | 内容 |
|---|---|
| 文件/行号 | `src/styles/z-index.css`（补定义）；`src/components/binary-tree/BinaryTreeWorkspace.module.css:286`（`.ghost`）、`src/components/binary-tree/UnitSessionTabStrip.module.css:340`（`.dragGhost`）——均 `z-index: var(--z-drag-overlay-max, 99999);` |
| 现状证据 | z-index.css 无 `--z-drag-overlay-max` 定义（现有最高 `--z-first-run: 100000`，`--z-drag-overlay: 10010`）；两处靠 99999 fallback 生效 |
| 修复内容 | z-index.css 在"顶层"组补 `--z-drag-overlay-max: 99999;`（注释：tab 拖拽 ghost 浮层，需高于 settings-panel 20000 与 toast 10000；保持渲染值不变，无视觉变化）；两文件删 fallback → `z-index: var(--z-drag-overlay-max);` |
| R-11 澄清 | 03-评审 P1-5 称"第 3 个文件 ChatComposer.module.css 也有 99999"——**实读修正：ChatComposer.module.css:105 的 99999 是 `transition: background-color 99999s ease-out 0s`（autofill hack），非 z-index fallback**，处理见 ④-R11-1 |
| 验收断言 | ①`rg "99999" src` 仅剩 ChatComposer.module.css:105 一处（保留项）；②`rg "z-drag-overlay-max"` 全仓 = 3（z-index.css 定义 + 2 消费点）；③style-contract z 契约（F7-F14）全绿 |

### 任务 2.1-6：`.card-tab.active` 死规则删除（P0-3）

| 项 | 内容 |
|---|---|
| 文件/行号 | `src/styles/shell/shell-workspace.css:869-872`（第二条 `.card-tab.active { background-color: var(--bg-active); … }`） |
| 现状证据 | 同选择器双声明：:843-846 `background-color: var(--bg-primary) !important` 压制 :869-872 `var(--bg-active)`——后者为死规则，`--bg-active` 语义通道被堵（01 审计 P0-3 实锤） |
| 修复内容 | 删除 :869-872 整条（保留 :843-846）。**注意**：S4 的 inset 皮肤治理（shell-workspace.css:366-499 改变量覆盖）依赖本步清死规则，本步只删不重构 |
| 验收断言 | ①`rg "\.card-tab\.active"` shell-workspace.css 仅 1 条声明（另 :839/:847 为 `.card-tab.card-tab--tool.active` 等复合选择器，不受影响）；②style-contract 断言 `.card-tab.active` 声明数 = 1 |

**S0 完成判据汇总**：`rg "var\(--(hover-bg|active-bg|chart-color|z-drag-overlay-max)"` = 0；`--accent-*-light-adaptive` 裸引用 = 0；`--tooltip-translate` 全部带 fallback；`.card-tab.active` 仅 1 条；`npm run typecheck` + `npm run test:snapshots` + style-contract 全绿。

---

## ② token 真源 + 双层同源治理（01-S1）

### 2.1 双层漂移不一致清单（2026-08-09 实读）

themeStore.ts 共 23 处 `setProperty`（:455 字体 + :706-769 主题段）。主题注入 22 个 token 与静态定义比对：

| # | token | 静态 light（tokens.css） | 静态 dark（tokens.css） | 运行时注入 light（themeStore.ts） | 运行时注入 dark | 漂移类型 |
|---|---|---|---|---|---|---|
| 1 | `--bg-hover` | control-mix 4% (t:13) | text-primary 3.5% (t:396) | text-primary 3.5% (ts:732) | 同注入 | 基底+数值双漂移（light 静态 vs 注入） |
| 2 | `--bg-active` | control-mix 8% (t:14) | **text-primary 6.5% (t:397)** | text-primary 8.0% (ts:733) | 同注入 | dark 静态 6.5% vs 注入 8%（02 评审 P1-1 补充的第 3 处） |
| 3 | `--control-soft-bg` | control-mix 4% (t:35) | text-primary 5% (t:414) | vibrantTint 6.0% (ts:740) | mixColor 6.5% | 百分比+基底漂移 |
| 4 | `--control-soft-bg-hover` | control-mix 4% (t:36) | text-primary 6.5% (t:415) | vibrantTint 11.0% (ts:741) | mixColor 9.5% | 百分比漂移 |
| 5 | `--control-soft-bg-active` | control-mix 8% (t:37) | text-primary 9.5% (t:416) | vibrantTint 17.0% (ts:742) | mixColor 13.5% | 百分比漂移 |
| 6 | `--text-tertiary` | #888888 (t:22) | #737373 (t:403) | text-secondary 70% 混色 (ts:718-721) | text-secondary 62% | 值体系漂移（静态值仅无注入环境生效） |
| 7 | `--accent-green/red-light-adaptive` | **无定义** | **无定义** | 注入 (ts:706-707) | 注入 | 静态缺失（S0 已补 fallback，此处补定义） |
| 8 | `--shell-chrome-bg`/`--shell-inset-bg` | 定义在 **shell-workspace.css:46-47**（light）/63-64（dark），不在 tokens.css | — | 注入 (ts:714/:727) | 注入 | 定义归属漂移（"静态文件集合"须含 shell-workspace.css） |
| 9 | `--composer-bg` | control-mix 2% #fff (t:27) | var(--bg-tertiary) (t:408) | 皮肤计算 (ts:745-769) | 皮肤计算 | 值体系漂移 |

另：`--sidebar-hover/--sidebar-active/--control-mix-color` **dark 分支未定义**（tokens.css:391-517 无）——dark 下继承 light 暖棕值（01 审计 P2-01 缺口）。

### 2.2 单一真源方案（双层同源协议落地）

**协议**（01 方案 ③-2.3）：静态定义 = 唯一真源；运行时注入 = 皮肤引擎对"可调 token"的合法覆盖，且满足两个约束——①注入 token 名 ∈ 静态定义名（style-contract 断言 ⑥）；②**不随皮肤变化的固定混色 token（--bg-hover/--bg-active/--control-soft-*）注入值 == 静态值**（断言 ⑦）。

### 任务 2.2-1：tint 档位 token 族定义（S2 替换目标，先行）

| 项 | 内容 |
|---|---|
| 文件 | `src/styles/tokens.css`（:root 组 + `[data-theme="dark"]` 组） |
| 建议定义值 | `--tint-hover: color-mix(in srgb, var(--text-primary) 4%, transparent);` `--tint-active: … 8% …;` `--tint-strong: … 12% …;`（**12%——主控 C-2 已定案，否决 14%**）；专用档：`--tint-focus-ring: 10%`、`--tint-divider: 12%`、`--tint-scrollbar-thumb: 18%`、`--tint-overlay: 25%`、**`--tint-highlight: 28%`（C-3 新增：settings 选中/高亮强底专用，不进三档）**（全部 text-primary 基底、transparent 混合） |
| 基底决策（修正 S1 原文，**主控已裁决：text-primary（C-1，否决 control-mix）**） | S1 原文用 `--control-mix-color` 基底，实读修正后由主控定案 **`--text-primary` 基底**——理由：①426 处消费点混色基底全部是 `var(--text-primary)`，tint 同基底则 S2 替换零基底变化，视觉差异仅来自档位收敛；②dark 分支无 `--control-mix-color` 定义（t:391-517），若 tint 用 control-mix，dark 下继承 light 暖棕值，hover 观感突变且需额外补值；③text-primary 在 dark 为 #f0f0f0，天然双主题自适应。**C-1 定案后此修正正式生效，执行不再需要主控确认** |
| 档位值决策 | 依据 426 处实测分布（见 ③-1）：hover 档主流 2-5.5%（中位 4%）；active 档主流 6-9%（中位 8%，8% 占 60 处为众数）；strong 档 10/11/15/16%（**主控已裁决取 12%（C-2，否决 14%）**：14% 会使 105 处 10/11% 档变深 27%+；12% 时 10/11→12 微变、15/16→12 微变，梯度 4/8/12 更均匀） |
| dark 分支 | 8 档 token dark 分支**复用同一 text-primary 基底定义**（淡染强度双主题一致，S1 原文口径），即 dark 块内再写一遍同值定义 |
| 验收断言 | `rg "--tint-" tokens.css` = 16（8 档 × light/dark，含 C-3 新增 `--tint-highlight`）；`rg "--tint-" src` 消费点 = 0（S2 前无消费） |

### 任务 2.2-2：语义别名接线 + dark 缺口补齐

| 项 | 内容 |
|---|---|
| 文件 | `src/styles/tokens.css` |
| 修复内容 | ①`--bg-hover: var(--tint-hover);`、`--bg-active: var(--tint-active);`（语义别名，仅 tokens.css 内部允许"语义名 → 档位名"映射）；②dark 分支补 `--sidebar-hover: color-mix(in srgb, var(--text-primary) 5%, var(--bg-secondary));`、`--sidebar-active: … 8% …`（01 退化 P2-01 建议值）、`--control-mix-color`（建议 `var(--text-primary)`，供 dark 下依赖它的存量 token 如 --md-code-bg 解析；**具体值请执行时以 dark 视觉抽查为准**） |
| 视觉变化声明 | `--bg-hover` light 从 control-mix 4% → text-primary 4%（基底变：暖棕 → 黑灰，微变）；dark 从 3.5% → 4%（微加深）；`--bg-active` dark 从 6.5% → 8%（微加深）。**02 评审 P1-1 已确认此微变可接受**，独立提交 + 视觉抽查（light/dark 各 3 组件） |
| 验收断言 | 断言 ①（dark 分支覆盖，见 ⑤-1）全绿 |

### 任务 2.2-3：themeStore 注入段对齐（独立提交，与 2.2-2 分开）

| 项 | 内容 |
|---|---|
| 文件 | `src/api/themeStore.ts:732-742`（applyTheme 内） |
| 修复内容 | ①删除 `--bg-hover`（:732）、`--bg-active`（:733）两处 setProperty——静态真源已定义同值（含 dark），注入重复覆盖是漂移源；②`--control-soft-*` 三处百分比对齐静态：light 6.0/11.0/17.0% → 4/4/8%、dark 6.5/9.5/13.5% → 5/6.5/9.5%（保留 vibrantTint/mixColor 基底——这是皮肤引擎的合法特性，对齐仅收敛百分比）；③`else` 分支（:773-795）同步删除 `--bg-hover/--bg-active` 的 removeProperty 行（:788-789） |
| 不动范围 | `--bg-primary` 等 15 个皮肤引擎驱动 token（:709-729/:769）的注入逻辑**不改**（依赖 adjust/皮肤参数，属合法覆盖）；`--text-tertiary`/`--composer-bg` 注入保留（见 2.2-4 的静态等价补齐） |
| 视觉变化 | 运行时微变（hover/控件底色加深），独立提交可回退 |
| 验收断言 | 断言 ⑦（固定值同源，见 ⑤-7）；视觉抽查 light/dark 各 3 组件 hover 前后对比 |

### 任务 2.2-4：静态等价默认定义补齐（注入失败降级可用）

| 项 | 内容 |
|---|---|
| 文件 | `src/styles/tokens.css`（light + dark 块） |
| 修复内容 | ①`--accent-green-light-adaptive`/`--accent-red-light-adaptive` 补静态定义，取"默认皮肤（无 adjust）"的注入等价：light → `color-mix(in srgb, var(--accent-green, #16a34a) 15.5%, #ffffff)` / `…var(--accent-red, #dc2626) 12.5%…`（对齐 ts:693-694）；dark → `color-mix(in srgb, var(--accent-green, #22c55e) 8%, var(--bg-primary))` / `…var(--accent-red, #ef4444) 8%…`（对齐 ts:702-703）；②`--text-tertiary` 补与注入等价的默认定义（light: `color-mix(in srgb, var(--text-secondary) 70%, transparent)`、dark: 62%）——**注意此定义会改变"无注入环境"的 text-tertiary 取值**，仅影响注入缺失路径，正常运行时零变化；③`--composer-bg` 补默认皮肤等价（light: `color-mix(in srgb, var(--control-mix-color) 15%, var(--bg-primary))` 近似 ts:748 的 vibrantTint 默认、dark: var(--bg-secondary) 对齐 ts:766）；④`--shell-chrome-bg/--shell-inset-bg` 维持 shell-workspace.css:46-47/63-64 定义（归属正确，不动），仅列入断言静态集合 |
| 验收断言 | 断言 ⑥（注入名 ∈ 静态名，静态集合 = tokens.css + shell-workspace.css）全绿 |

### 2.3 style-contract.test.ts 门禁扩展点（S1 契约，与 2.2 同批落地）

扩展载体：`src/styles/style-contract.test.ts`（已存在，F7-F14 z 契约 + F7-F27 dark 覆盖，fs 断言模式，vitest unit 项目）。新增 6 条断言，详见 ⑤-1~⑤-8。

---

## ③ 混色 32 档收敛（01-S2，426 处基线）

### 3.1 档位分布实测（2026-08-09 全仓扫描，口径 = 全部 css/tsx/ts）

`color-mix(in srgb, var(--text-primary) X%, …)` 共 **426 处、32 个档位**（审计 423 处口径差 3，为 tsx/注入段差异；03-评审实测 426 一致；**02 评审 ②-9/P2-2 复核：分布表 32 项每档处数全部精确匹配，原「31 档」标签 off-by-one，已修正为 32 档**）。按 X 值分布（括号为处数）：

```
1.2(2) 1.5(4) 2(18) 2.5(15) 3(22) 3.2(1) 3.5(16) 4(23) 4.5(3) 5(25) 5.5(14)
6(33) 6.5(2) 7(13) 8(59) 8.0(1) 9(15) 9.5(1)
10(64) 11(41) 12(13) 14(6) 15(7) 16(4)
18(5) 20(3) 22(6) 25(1) 28(5) 30(1) 35(2) 42(1)
```

### 3.2 档位 → token 分组映射表（语义归位，非数值归位）

| 目标 token | 归入档位（X 值） | 处数 | 语义依据（01 审计 §1.11 例证） |
|---|---|---|---|
| `--tint-hover` | 2 / 2.5 / 3 / 3.2 / 3.5 / 4 / 4.5 / 5 / **5.5** | 137 | hover 淡染主流；5.5% 的 14 处为菜单 hover（shell-polish:536、ComposePlusMenu、chat-composer.css:40 等），按语义归 hover 而非区间字面 |
| `--tint-active` | 6 / 6.5 / 7 / 8 / 8.0 / 9 / 9.5 | 124 | active/按下/强 hover；8% 60 处为众数（含 token 定义 2 处见 3.4 排除表） |
| `--tint-strong` | 10 / 11 / 15 / 16 | 116 | 强强调/高亮行/按钮强调（ToastStack:68/87 按钮 16%、BinaryTreeWorkspace:135） |
| `--tint-focus-ring` | 10% 中 focus-ring 用途 | 个别 | focus-visible.css 及 module 内 `var(--focus-ring, color-mix(…10%…))` 形态；脚本无法判定，执行时人工挑选 |
| `--tint-divider` | 12 / 14 | 19 | 分隔线/描边语义（settings-models.css:2405 border、shell-scrollbar.css:46 thumb 14%、shell-sidebar.css:422/424 渐变 14%） |
| `--tint-scrollbar-thumb` | 18 | 5 | 滚动条拇指（SettingsSelect.module.css:129 等） |
| `--tint-overlay` | 20 / 22 / 25 | 10 | 遮罩/backdrop 语义 |
| `--tint-highlight` | 28 | 5（脚本面 4 + :1225 人工 1） | settings 域选中/高亮强底 5 处同语义；**主控 C-3 新增专用档（不进三档）**；settings-models.css:1225 为 white 基底不入脚本（见 3.3） |
| **人工复核组（不机械替换）** | 1.2(2) / 1.5(4) / 35(2) / 42(1) | 9 | 见 3.3 |
| **排除组（不替换）** | — | 若干 | 见 3.4 |

### 3.3 例外保留/人工复核清单（宁慢勿错，单独提交）

| 档位 | 位置（实读） | 语义判定 | 处理建议 |
|---|---|---|---|
| 1.2% | CheatsheetModal.module.css:62、shell-polish.css:1151 | 极淡，疑似键盘提示/幽灵底 | 人工看现场；若为"极淡装饰底"→ 不归 tint，改引 `--md-code-bg` 类语义 token 或**保留（登记例外）** |
| 1.5% | DiffCard.module.css:714、CheatsheetModal.module.css:123、ModelsSettingsTab.module.css:720、settings-base.css:1823 | 极淡，md-code-bg 类（tokens.css:41 `--md-code-bg` 即 1.5% control-mix） | 改引用语义 token（`--md-code-bg` 或等价）而非 tint 档位 |
| 28% | settings-base.css:1594、settings-models.css:1225（**white 基底**）、settings-plugins.css:84/173、settings-usage.css:67 | settings 域 5 处同语义（选中/高亮强底） | **主控已裁决（C-3）：新增专用档 `--tint-highlight: 28%`（不进三档，见 3.2）**——5 处全数归位：脚本面 4 处（transparent 基底）随批 D 替换，settings-models.css:1225 因 white 基底不入脚本，人工改引并确认基底变化观感 |
| 35% | settings-models.css:387（背景）、shell-polish.css:885（**border**） | border 用法非背景淡染 | 不入 tint 族；border 强调建议改 `--hairline-strong` 或语义色，人工看现场 |
| 42% | settings-models.css:1416（**color: 文字混 42% text-primary + text-tertiary**） | 文字色混合，非背景 | 不属于 tint 语义，保留或改 `--text-secondary` 强化，人工看现场 |
| 30% | tokens.css:417（`--focus-ring-color` 定义行） | **token 定义，非消费点** | 不替换 |
| 99999s | ChatComposer.module.css:105 | autofill hack（R-11） | 保留 + 注释（见 ④-R11-1） |
| 非 transparent 基底 | settings-models.css:1225（`…28%, white`） | 与 tint 全系 transparent 基底不同 | 语义同 28% 档（C-3 定案归 `--tint-highlight`），基底为 white 不入脚本——人工改引 `--tint-highlight` 并确认基底变化观感（改 transparent 后深浅微变） |

### 3.4 排除组（脚本红线：token 定义行与注入段）

以下位置含 `color-mix(in srgb, var(--text-primary) X%)` 但**属于 token 定义或注入**，替换脚本必须排除（否则破坏 token 体系）：

- `tokens.css`：:396/:397（dark bg-hover/active）、:414/:415/:416（dark control-soft）、:417/:419（focus-ring）、:490（terminal-bar-fill）、:675（::selection）
- `theme-dark.css`：9 处（:101/:148/:160/:167/:168/:176/:183/:219/:230）——均为主题补丁规则内的混色，属 S6 暗色收编面，**本批不替换**（避免与 S6 冲突）
- `themeStore.ts`：:732/:733（--bg-hover/--bg-active 注入字符串）——随任务 2.2-3 的注入对齐删除，不在此批
- 脚本排除规则：行首为 `--[\w-]+:` 的定义行不匹配；文件白名单排除 tokens.css/theme-dark.css/themeStore.ts

### 3.5 批量替换工具草案（03-评审 ④-4.1 落地）

**工具**：`scripts/replace-tint-mix.mjs`（一次性 Node 脚本，入库，`--dry-run` 先行）

| 项 | 内容 |
|---|---|
| 输入 | 映射表 JSON（`scripts/tint-map.json`）：`{"2":"--tint-hover", …, "8.0":"--tint-active", …, "28":"--tint-highlight", …}`（**8 与 8.0 归一为同一目标；28 入表 → `--tint-highlight`（C-3）**；1.2/1.5/35/42 不入表——28% 的 4 处 transparent 基底随批 D 自动命中，:1225 white 基底被主正则天然排除） |
| 主正则 | `color-mix\(in srgb, var\(--text-primary\) (\d+(?:\.\d+)?)%,(transparent|var\(--bg-primary\))\)` —— 只匹配 text-primary 基底；捕获组 1 查表得 token；捕获组 2 限 transparent 或 bg-primary 基底（settings-models.css:1225 的 `white` 基底不匹配，天然排除） |
| 排除 | ①行首匹配 `/^\s*--[\w-]+:/` 的定义行；②文件白名单：tokens.css、theme-dark.css、themeStore.ts（硬编码跳过） |
| 参数 | `--dry-run`（默认，输出 diff 到 `scripts/out/tint-replace-<批次>.diff` 留档）、`--only <相对路径/目录>`（单批应用）、`--apply`（写盘，须配合 --only） |
| 执行流（分阶段） | **阶段 1**：脚本 dry-run 全仓 → 输出全量 diff 留档（评审物）；**阶段 2**：按档位组 + 文件面分批（每批 5-10 文件，先大档后小档）：批 A `--tint-hover`（137 处）→ 批 B `--tint-active`（124）→ 批 C `--tint-strong`（116）→ 批 D 专用档（divider/scrollbar/overlay/focus-ring/highlight，39；highlight 的 :1225 white 基底处另随批 E 人工）→ 批 E 人工复核组（9 处逐处人工）；每批 `--only` 限定文件 → 人工扫 diff 上下文行（确认 hover/active 语义）→ 应用 + `test:snapshots` 同提交 → 下一批；**阶段 3**：全仓 grep 清零校验 |
| 红线 | 禁止整仓一次性 `--apply`（无 --only 不写盘）；替换只动 `color-mix(...)` 表达式本身，不动选择器/属性名/其他值；`!important` 等修饰保留 |

**分批提交粒度**：5 档位组 × 每批一个提交 + 人工复核组一个提交，共 ≤6 个提交；单批回退 = `git revert` 该提交。

### 3.6 S2 完成判据

`rg "color-mix\(in srgb, var\(--text-primary\) (\d+(\.\d+)?)%"` 消费点 = 0（排除组除外）；视觉抽查 5 代表组件深浅观感与原设计意图一致；style-contract 断言 ② 对剩余裸混色计数（排除组白名单外）递减至 0。

---

## ④ R-11 处理（03-评审遗漏补充）

### 任务 R11-1：ChatComposer.module.css:105 的 99999（定性修正）

| 项 | 内容 |
|---|---|
| 实读修正 | 03-评审 P1-5 与 R-11 称"99999 fallback 第 3 文件"——**实读：该处为 `transition: background-color 99999s ease-out 0s;`（:-webkit-autofill 防浏览器自动填充底色瞬变的 hack），并非 z-index fallback**。与任务 2.1-5 的 z 档位治理性质不同 |
| 处理 | 保留（浏览器 hack，业界通行），补一行中文注释说明用途与"不得删除"原因；纳入 style-contract 例外白名单（若断言 ③ 禁裸时长误伤，需豁免该行） |
| 验收断言 | 文件含 `99999s` 且带说明注释；`rg "99999"` 全仓 = 该行 + 测试文件（无新增） |

### 任务 R11-2：chat.css 第 6 个 GBK 编码文件（归属 S7-6 编码统一，本批登记）

| 项 | 内容 |
|---|---|
| 实读证据（2026-08-09 字节检测） | 6 个文件**全部 GBK 解码零替换符**（注释内容为 GBK 中文），分两类：**A 类（真 GBK 字节，严格 UTF-8 解码失败）**：`shell-dragdrop.css`（5 个非法字节）、`shell-polish.css`（25 个）；**B 类（乱码已固化为合法 UTF-8 文本）**：`panels.css`（26 个 U+FFFD）、`shell-layout.css`（12）、`shell-workspace.css`（1）、`chat.css`（合法 UTF-8 但注释为 GBK 乱码文本，如 0xE9 0x97 0x81 0x3F 序列） |
| 处理方案 | A 类：GBK 解码 → UTF-8 无 BOM 重写（无损恢复）；B 类：字节已损坏，**人工重写乱码注释**（无法自动恢复）；统一编码与 `test:snapshots` 更新**同一提交**（8e8c313c 教训）；建议补 `scripts/check-css-encoding.mjs`（字节检测：严格 UTF-8 解码 + BOM 检查 + U+FFFD 扫描）入库防复发 |
| 执行批次 | 归 S7-6（批次 9 卫生收尾），本批（批次 2）**不做编码改动**，仅登记清单与工具预置；若主控要求提前，必须单独提交 + 快照同提交 |
| 顺带项 | `themeStore.ts:40` 附近存在 1 处 GBK 乱码注释（乱码以 `?` 与乱码字符混合形态呈现，含已固化的 U+FFFD；本计划不复制原文），TS 文件无快照影响，可顺手修复 |

---

## ⑤ 测试与验证

### 5.1 style-contract.test.ts 新增断言清单（S1 契约，六条全绿为批 2 门禁）

| # | 断言 | 实现要点 |
|---|---|---|
| ① | **dark 分支覆盖**（泛化 F7-F27） | 读 tokens.css 的 `:root` 块（:3-383）提取 `--(bg\|text\|border\|accent\|color\|tint\|sidebar\|control)-[\w-]+` 前缀 token 名清单 → 对每个名断言 dark 块（:391-517，复用现有 `html\[data-theme="dark"\]\s*\{[\s\S]*?\n\}` 正则）含同名定义。**注意**：`--accent-chart-*` 等已在 dark 定义（:441-442）✓；排除 xterm/mac-dot/syntax 等不在前缀清单的 token |
| ② | **禁新裸混色**（S2 后清零） | 扫描全仓 css/tsx（排除 tokens.css/theme-dark.css/themeStore.ts + 白名单行 `^\s*--[\w-]+:`），断言 `color-mix\(in srgb, var\(--text-primary\) \d+(\.\d+)?%,` 计数 ≤ 当前基线（批 2 完成后 = 排除组处数，后续 ratchet 递减） |
| ③ | **禁裸 999px / 裸 99999** | `border-radius:\s*999` 与裸 99999 计数 ≤ 基线（当前 28 处 999px、1 处 99999s 白名单）；白名单：ChatComposer.module.css:105 |
| ④ | **scrollbar 块 ratchet** | `::-webkit-scrollbar` 计数 ≤ 31（当前基线），防新增 |
| ⑤ | **!important ratchet** | 全仓 `!important` 计数 ≤ 673（当前基线，S4 后每次递减） |
| ⑥ | **注入 token 名 ∈ 静态定义名** | 读 themeStore.ts 提取 `setProperty\('(--[\w-]+)'` 名清单（23 个）→ 断言每个名在静态集合（tokens.css + shell-workspace.css）有 `--name:` 定义 |
| ⑦ | **固定值双源同值** | 解析 themeStore.ts:732-742 注入文本中的百分比 → 与 tokens.css :13-14/:35-37/:396-397/:414-416 对应 token 的百分比比对相等（bg-hover 4、bg-active 8、control-soft 4/4/8 light、5/6.5/9.5 dark） |
| ⑧ | **悬空引用清零 + 静态兜底存在** | ①`var\(--(hover-bg\|active-bg\|chart-color\|z-drag-overlay-max)\)` 全仓 = 0；②两 Tooltip.module.css 含 `var(--tooltip-translate, translate(0)`；③tokens.css 含 `--accent-green-light-adaptive:` 与 `--accent-red-light-adaptive:`；④`.card-tab.active` 声明数 = 1 |

### 5.2 命令与回归面

| 命令 | 用途 |
|---|---|
| `npm run typecheck` | 每次提交前（themeStore.ts 改动必跑） |
| `npm run test`（unit，含 style-contract.test.ts） | 每次提交前；style-contract 为 fs 文本断言，不受覆盖率约束（45/70/65/45 口径不变） |
| `npm run test:snapshots` | 任何 css 内容改动（含编码）同提交更新；失败时先对照 diff 确认仅类名哈希变化（8e8c313c 教训） |
| `rg` 校验清单 | 见各任务验收断言 |

### 5.3 视觉抽查清单（需人工/Playwright 采样）

| 批次 | 抽查项 | 方式 |
|---|---|---|
| S0 | DiffCard 暗色 hover（.accordionItem .fileItem:hover / .inlineActionAccept:hover / .hoverActBtn.danger:hover）；tooltip 入场动画（scale 完整）；settings 用量页图表柱；binary-tree 拖拽 ghost 浮层盖过 settings 弹层；diff 面板新增/删除行底色 | light + dark 截图 |
| S1-静态 | tint token 定义后无任何消费（零视觉变化确认） | computed style 抽查 3 组件 |
| S1-注入对齐 | light/dark 各 3 组件 hover（侧栏、菜单项、tab）前后对比（控制-soft 百分比对齐的加深可接受性） | 截图对比 |
| S2 | 5 代表组件：Tab hover、菜单项 hover、sort 行 hover、toast 按钮、滚动条拇指——替换前后 computed style 混色值差异 ≤1.5% 档位变化；深浅观感与原设计意图一致 | Playwright 计算样式 + 截图 |
| S2-人工组 | 1.5% 极淡 4 处、35% border、42% 文字色、28%→`--tint-highlight` 观感（settings 5 处，含 :1225 基底变化） | 逐处看现场 |

---

## ⑥ 风险与回退

| # | 风险 | 影响 | 缓解 / 回退 |
|---|---|---|---|
| R1 | **CSS Modules 哈希漂移**（任何 module.css 改动 → 快照红） | 每步都可能红测试 | 每批 css 改动与 `test:snapshots` 同提交；失败先对照 diff 确认仅哈希（8e8c313c 复用） |
| R2 | **混色收敛视觉回归**（32 档→8 档，个别组件深浅突变） | 用户感知"样式变了" | 语义归位（非数值归位）+ 每批 5-10 文件 + playwright 计算样式比对 + 单批 `git revert`；1.2/1.5/35/42 人工组单独提交（28% 已定案入 `--tint-highlight` 档，仅 :1225 基底变化人工确认） |
| R3 | **双层漂移复发**（改 tokens.css 不生效） | 排查困难 | 断言 ⑥⑦ 强制"注入名 ∈ 静态名 + 固定值同值"；注入段修改与静态定义同批提交 |
| R4 | **tint 基底决策风险**（control-mix vs text-primary） | 决策错误 → S2 大范围视觉突变 | **已定案 text-primary 基底（C-1），风险消除**；dark `--control-mix-color` 缺口仍按 2.2-2 任务②补齐（供依赖它的存量 token 解析），与基底决策解耦 |
| R5 | **注入对齐微变被误判**（--bg-hover 3.5→4% 加深） | 与"无视觉变化"声明冲突 | 02 评审 P1-1 已裁定：注入对齐单列提交 + 明确"微变可接受" + 视觉抽查；与 2.2-2 的静态别名提交分离，可单独回退 |
| R6 | **编码重写中途失败**（B 类乱码无法自动恢复） | 注释内容损失 | A 类转码保真；B 类人工重写（先备份原文件）；与快照同提交原子完成；`check-css-encoding.mjs` 防复发 |
| R7 | **--z-drag-overlay-max 取值与后续批次冲突** | ghost 层被压 | 定义 99999 保持渲染值不变（零风险）；若 S4 inset 治理后层级重构，再评估档位 |
| R8 | **与 T-E 的 themeStore 冲突**（03-步骤2-D3 persistTheme 写端） | 同文件双改 | 本批只动 applyTheme 注入段（:706-742/:773-795），persist 写端留给 T-E，串行登记（C11） |

**回退总原则**：批次 2 内 4 子任务各自独立提交（2.2 再拆静态/注入两提交；2.4 随批次 2 独立提交）；单步失败仅 `git revert` 该提交，不跨步回滚；token 等价新增步（2.2-1/2.2-4）与视觉可变步（2.2-2 别名、2.2-3 注入对齐、S2 替换）分离，保证"纯基建"提交可随时独立合入。

---

## 附：任务清单汇总

| # | 任务 | 文件面 | 提交 |
|---|---|---|---|
| 2.1-1 | DiffCard accent-adaptive fallback | DiffCard.module.css | S0-A |
| 2.1-2 | DiffCard 9 处 hover/active fallback 清理 | DiffCard.module.css | S0-A |
| 2.1-3 | Tooltip 双份静态兜底（8 处） | Tooltip.module.css ×2 | S0-A |
| 2.1-4 | chart 色修正（改用法） | SettingsUsageTab.module.css | S0-B |
| 2.1-5 | z 档位补全 + 99999 清理 | z-index.css + 2 module | S0-B |
| 2.1-6 | .card-tab.active 死规则删除 | shell-workspace.css | S0-B |
| 2.2-1 | tint 8 档 token 定义（light+dark，含 `--tint-highlight`） | tokens.css | S1-静态 |
| 2.2-2 | 语义别名 + dark 缺口 | tokens.css | S1-静态 |
| 2.2-3 | themeStore 注入段对齐 | themeStore.ts | S1-注入（独立） |
| 2.2-4 | 静态等价默认定义补齐 | tokens.css | S1-静态 |
| 2.2-5 | style-contract 8 条断言扩展 | style-contract.test.ts | S1-门禁 |
| 2.3-1 | 混色替换脚本 + 映射表入库 | scripts/ 2 文件 | S2-工具 |
| 2.3-2 | 批 A tint-hover（137 处） | 分 5-10 文件/批 | S2-A |
| 2.3-3 | 批 B tint-active（124 处） | 同上 | S2-B |
| 2.3-4 | 批 C tint-strong（116 处） | 同上 | S2-C |
| 2.3-5 | 批 D 专用档（39 处，含 highlight） | 同上 | S2-D |
| 2.3-6 | 批 E 人工复核组（9 处） | 逐处人工 | S2-E |
| R11-1 | ChatComposer 99999 注释说明 | ChatComposer.module.css | S0-A 或 S2 收尾 |
| R11-2 | 6 文件编码清单登记 + check 脚本 | scripts/ 1 文件 | S7-6（批次 9，预置） |

**合计 19 个任务**（本批可执行 18 个，R11-2 为预置登记；批次 2 增补子步 2.4 的 01-S3-任务1 明细见 01 方案 S3，不列入本表）。
