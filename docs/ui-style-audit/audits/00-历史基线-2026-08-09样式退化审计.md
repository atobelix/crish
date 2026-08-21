# 前端样式退化深度审计

- 审计日期：2026-08-09
- 审计对象：`apps/crish-desktop`（React + Vite + CSS Modules + 设计 token 体系）
- 范围：设计 token 体系 / 组件样式退化 / 历史回归定位 / 运行时验证
- 审计方式：只读静态分析 + playwright 运行时验证（本地临时 vite dev server :5199，原 :5175 在审计期间不可用）

---

## 一、设计 Token 体系审计结论

### 1.1 总体结论

Token 体系总体健康（tokens.css 785 行 + z-index.css 47 行 + theme-dark.css 265 行），**多数问题属于"迁移未完成"与"历史残留"，真正的视觉退化点集中在少量确定位置**。审计发现：402 个 token 定义、9366 处 `var()` 引用、111 个 CSS 文件 + 81 个 module.css。

### 1.2 Token 命名一致性

| 问题类型 | 数量 | 示例 | 证据 |
|---|---|---|---|
| **引用未定义 token（悬空引用）** | 47 处引用 / 21 个 token 名 | `--chart-color-1`、`--tooltip-translate`、`--hover-bg`、`--font-weight-semi`、`--z-drag-overlay-max`、`--ui-bg-soft` 系列 | 脚本扫描结果 |
| 有 fallback 的悬空引用（降级可用） | 大部分 | `--hover-bg, rgba(0,0,0,0.02)` | DiffCard.module.css:457 等 |
| **无 fallback 的悬空引用（渲染无效值）** | 4 处 | `--chart-color-1/2`（SettingsUsageTab.module.css:275/281/321/328） | 见 §2 P1-01 |
| 遗留旧 token 名 | 若干 | `--font-weight-semi`（正确名 `--font-weight-semibold`）、`--hover-bg/--active-bg`（正确名 `--bg-hover/--bg-active`） | CheatsheetModal.module.css:105、DiffCard.module.css:457 |

### 1.3 暗色主题支持

- 主题切换方式：`html[data-theme="dark"]` 分支 + themeStore 运行时 JS 注入（非 `prefers-color-scheme`，符合 Tauri 桌面场景）。
- **dark 分支 token 覆盖不完整**：`:root`（light）定义 263 个 token，`[data-theme="dark"]` 分支仅覆盖 89 个。未覆盖项中**与颜色相关的关键缺口**：
  - `--sidebar-hover` / `--sidebar-active`（dark 下继承 light 的 `color-mix(in srgb, var(--control-mix-color) 4%, var(--bg-secondary))`，其中 `--control-mix-color` 在 dark 分支同样未定义 → dark 下侧栏 hover 依赖 `hsl(35,40%,30%)` 深棕 4% 混色，视觉上近乎不可见/偏色）。
  - `--control-mix-color` 本身 dark 下未覆盖（themeStore 运行时注入兜底，但静态 CSS 无定义）。
  - `--md-code-bg` 等：tokens.css 未覆盖，但 theme-dark.css:32-34 有 `:where(html[data-theme="dark"])` 覆盖 → 实际可用。
  - 大多数尺寸/圆角/间距 token（`--space-*`/`--radius-*`/`--font-*`）dark 分支不覆盖属正常（双主题共用）。
- 运行时验证（模拟 data-theme=dark + 清 JS 注入）：暗色分支核心 token 生效（bg-primary `hsl(0,0%,5%)`、text-primary `#f0f0f0`），但 `--sidebar-hover` 计算值为 `color-mix(in srgb, hsl(35, 40%, 30%) 4%, hsl(0, 0%, 8%))` —— 暖棕 4% 混 8% 黑，侧栏 hover 反馈微弱且色相与暗色中性灰体系冲突。

### 1.4 语义完整度

- bg/text/accent/border/radius/shadow/space/line-height/font 家族基本齐全。
- **z-index 族**：`styles/z-index.css` 为唯一真源（0–100000 共 27 档），TSX 侧全部通过 `var(--z-*)` 引用（grep 无裸数字 zIndex），fecdd439 删除 `tokens/zindex.ts` 后无退化。**残留问题**：
  - `--z-drag-overlay-max` 未定义，BinaryTreeWorkspace.module.css:286 与 UnitSessionTabStrip.module.css:340 用 `var(--z-drag-overlay-max, 99999)` fallback → 硬编码 99999 兜底（z 大战信号）。
  - tokens.css:275 注释声称 "TS 侧 tokens/zindex.ts 由 check:zindex 校验" —— **过时注释**：zindex.ts 已被 fecdd439 删除，`check:zindex` 脚本在 package.json 中不存在（仅 `test:snapshots`/`test:visual` 等），z 值一致性校验已断链。

### 1.5 编码卫生（新增发现）

- **5 个全局样式文件为 GBK 编码**：`styles/panels.css`、`styles/shell/shell-dragdrop.css`、`styles/shell/shell-layout.css`、`styles/shell/shell-polish.css`、`styles/shell/shell-workspace.css`（UTF-8 解码含 U+FFFD，GBK 可完整解码）。
- `styles/chat.css` 注释为双重编码损坏（GBK→Latin-1→UTF-8 mojibake，无 BOM，UTF-8 可解码但注释乱码）。
- 违反 AGENTS.md "中文注释 UTF-8 无 BOM" 约定；**与快照哈希漂移同源**（见 §3）：文件字节序列 ≠ 语义内容，任何"统一编码"批量改写都会造成 CSS Module 哈希变化，必须与快照更新协同。

---

## 二、退化点清单

### P1 真退化（视觉可见）

| # | 现象 | 证据（文件:行号） | 根因 | 严重度 |
|---|---|---|---|---|
| P1-01 | **设置→用量页图表柱/图例完全透明不可见**（`--chart-color-1/2` 未定义且无 fallback → background 无效值） | SettingsUsageTab.module.css:275/281/321/328 | 5017cae7 样式系统化重构时把图表的 `--accent-chart-in/out`（tokens.css:68-69 已定义）误写成不存在的 `--chart-color-1/2`；`git log -S` 确认 tokens.css 历史上从未定义过该名 | **P1** |
| P1-02 | **DiffCard 文件列表 hover/active 反馈在暗色主题下消失**（fallback 为 `rgba(0,0,0,…)` 黑色系，暗色背景上不可见；且未用 `--bg-hover/--bg-active` 系统 token） | DiffCard.module.css:457/462/988/1032/1061/1125/1160/1184/1237 | 遗留旧 token 名 `--hover-bg/--active-bg`（正确名 `--bg-hover/--bg-active`），且 fallback 是 light-only 硬编码 | **P1**（dark） |

### P2 视觉退化/明显偏差

| # | 现象 | 证据（文件:行号） | 根因 | 严重度 |
|---|---|---|---|---|
| P2-01 | 暗色主题下侧栏 hover 反馈微弱、色相偏暖（深棕混色） | tokens.css:38-39（dark 分支 391-517 无覆盖）；运行时验证 `--sidebar-hover` dark = color-mix(hsl(35,40%,30%) 4%, bg-secondary) | dark 分支未定义 `--sidebar-hover/--sidebar-active/--control-mix-color`；themeStore 注入兜底但静态 CSS 缺口 | P2 |
| P2-02 | `!important` 滥用 46 处（settings-segment 壳、input 壳、diff 行、快捷菜单等），形成"覆盖链"——后续改 token 无效 | settings-base.css:969-989（segment 全组 !important）；SettingsQuickMenu.module.css:75/84-85；theme-dark.css:19-25；InlineAgentPanel.module.css:321-332 | 组件样式战争：ui-segment 原子层与 settings 壳层各自声明、互相 !important 压制 | P2（维护性→视觉间接） |
| P2-03 | 顶栏/标题栏高度被系统性压缩（44px→36px→28px 链） | tokens.css:170-172（--titlebar-row-h:28px）、:236（--header-height:36px）；59db5695 提交将 38px→28px、top-gap 6px→0px | 59db5695 "visual styles" 优化对视觉密度的大幅收紧，无 UI size 分档补偿（对比 [data-ui-size] 分支仅调 control-height，未调 titlebar） | P2（视觉密度） |
| P2-04 | StatusDiagnosticsPanel 用遗留 `--ui-*` 命名 + 硬编码 rgba fallback，绕过语义 token | StatusDiagnosticsPanel.module.css:35/37/82/86/96/107/109/119/138/168/180/210 | 旧命名体系残留，tokens.css 实际提供 `--ui-text-*` 而非 `--ui-bg-*` 系列 | P2 |

### P3 未完成迁移/残留（不直接产生视觉问题，但破坏体系一致性）

| # | 现象 | 证据 | 根因 |
|---|---|---|---|
| P3-01 | 5 个全局样式文件 GBK 编码 + chat.css 注释双重损坏 | styles/panels.css、shell-*×4、chat.css | 历史编码混乱未收敛（§1.5） |
| P3-02 | `--z-drag-overlay-max` 未定义 + 99999 硬编码 fallback | BinaryTreeWorkspace.module.css:286、UnitSessionTabStrip.module.css:340 | z 档位迁移遗漏 |
| P3-03 | tokens.css:275 过时注释（引用已删除的 zindex.ts / check:zindex） | tokens.css:275 | fecdd439 删资产未同步注释 |
| P3-04 | `--font-weight-semi` 旧名（8 处，fallback 600 与 semibold 一致，无视觉差异） | CheatsheetModal.module.css:105、TelemetryDialog.module.css:53 等 | 改名迁移遗漏 |
| P3-05 | `--font-mono-features` 未定义（fallback 兜底） | settings-plugins.css:448 | 同上 |
| P3-06 | e7a2e90c 删除 5 处 `.ui-btn-secondary/.ui-btn-ghost` 的 border-color 覆写——注释声称"基础定义 border:none，覆写不产生渲染效果"，**核实属实**（shell-polish.css:57 `.ui-btn-secondary{border:none}`）→ 无退化，仅需清理残留注释 | settings-advanced/base/extensions/models/usage.css 删除记录 | 已核实无视觉影响 |
| P3-07 | ChatToolCallBlock 与 agent-tool-stack 双重 `border:none !important` 互锁（CSS 与全局各写一份） | ChatToolCallBlock.module.css:22 + chat.css:384/391 | 模块化迁移后全局类残留 |

### 环境噪音（非退化，说明区分）

| # | 现象 | 判定 |
|---|---|---|
| E-01 | console "No available adapters." ×4 | 浏览器（非 Tauri）环境下 `@tauri-apps` 某插件探测 adapter 失败；源码与 node_modules 均搜不到该字符串（疑似运行时拼接）；与样式无关 |
| E-02 | `[persist-degraded-meta]` / "模型目录快照拉取跳过" / tauri-plugin-mcp 报错 | 无 Tauri invoke 的浏览器环境必然现象 |
| E-03 | 快照哈希漂移（`_toolStack_3f3761 → _toolStack_7dc568`） | **不是视觉退化**，是文件编码从 UTF-16（BOM FF FE）转 UTF-8 无 BOM 后字节序列变化 → CSS Modules 哈希变化 → 快照未更新（详见 §3-03） |
| E-04 | 页面无横向溢出 / 无 z 大战 / 无高 z 值堆叠（运行时 highZ 检测为空） | 当前运行态健康 |

---

## 三、历史回归定位

### 3-01 `5017cae7` 样式系统化重构（2026-07-20）——引入 P1-01

- 内容：统一聊天列宽与设置面板宽度 token 体系（`--chat-col-max` 等），96 文件 9739+/2184-。
- 回归：**P1-01 由此引入** —— `git blame` 显示 SettingsUsageTab.module.css:275 的 `background: var(--chart-color-1)` 是 5017cae7 写入；`--accent-chart-in/out` 同批在 tokens.css 定义（git log -S 确认该名在此提交出现），图表引用名写错。
- 次要：该提交同时删除大量旧组件模块，是后续 8e8c313c 目录迁移的基础。

### 3-02 `48f6f3e5` / `f28ff720` 设计令牌重构（2026-07-20/21）——迁移不完整

- 内容：统一 UI 设计令牌、暗色主题、组件模块层 CSS。
- 回归：P2-01（dark 分支 token 覆盖不全）源于此阶段暗色主题成体系时**未为 `--sidebar-hover/--sidebar-active/--control-mix-color` 建立 dark 值**；P2-02 !important 覆盖链在设置壳层同期成型；f28ff720 引入的 `--transition-hover` token 已被 48f6f3e5 移除且无残留引用（验证无退化）。

### 3-03 `8e8c313c` 组件目录化迁移（2026-08-02）——快照哈希漂移

- 内容：组件目录化（T05.4/T05.6）+ ui 原子层 + 弹窗收敛 + 死代码清理。
- 回归：**ChatToolCallBlock.module.css 由 `src/components/` 移至 `src/components/chat-tool-call/` 时编码从 UTF-16（BOM FF FE）转为 UTF-8 无 BOM**。内容逐字符完全一致（已验证 old/new 解码后 identical），但字节序列变化 → CSS Modules 哈希 `_toolStack_3f3761 → _toolStack_7dc568` → 7-29 生成的快照（ef3da5b2）未更新 → 快照测试红。这是**测试资产问题**，不是视觉退化，但暴露"迁移工具链未统一编码"的系统性风险（与 §1.5 编码卫生相关）。
- 同样引入：P1-02 的 `--hover-bg` 悬空引用在 DiffCard.module.css 的传播路径被目录化带过（该文件 8e8c313c 期间被重写）。

### 3-04 `e7a2e90c` 样式规范化（2026-08-02）——已核实无退化

- 内容：settings/shell/tokens/zindex 规范化 + `tokens/zindex.ts` 新建。
- 核验：删除的 5 处 `.ui-btn-secondary/.ui-btn-ghost` border-color 覆写**不产生渲染效果**（基础定义 border:none，shell-polish.css:57），注释说明属实 → 无退化。
- 遗留：shell-polish.css 中 `.settings-select-menu/.settings-select-item` 选择器移除 —— 已核实 SettingsSelect.module.css 完整承接（new 类名 `settingsSelect*`），无空引用。

### 3-05 `db6880ef` eslint 清理 51+2（2026-08-09）——无 CSS 删除

- 内容：40 文件 380+/1304-，全部为 TS/TSX 死代码（requestIdleCallback 封装、未用 import、lazy 包装）。
- 核验：`git show --stat` 无任何 .css 文件；ChatMessageRow/CompactToolRow/useScrollAnchor 的删除均为 JS 逻辑（样式类引用未动）。**eslint 清理未误删样式**，排除该嫌疑。

### 3-06 `fecdd439` 删除 zindex.ts（2026-08-06）——承载正常

- 内容：孤儿资产移除（含 `apps/crish-desktop/src/styles/tokens/zindex.ts` 38 行）。
- 核验：z 值由 `styles/z-index.css` 完整承载（27 档）；TSX 侧全部 `var(--z-*)` 引用；01ef652b 已提前将 LeafToolTabStrip/FileViewerCard 的裸 999/1000 迁移为 token。**无退化**，但 `check:zindex` 校验脚本与 tokens.css 注释未同步（P3-03）。

### 3-07 `59db5695` visual styles 优化（2026-07-29）——顶栏压缩（P2-03）

- 内容：149 文件 14132+/3933-，含大量布局/视觉 token 化。
- 回归：`--titlebar-row-h 38px→28px`、`--titlebar-top-gap 6px→0px`、`--card-header-pad-y 4px→0px`；header 从 44px 硬编码统一到 36px token。视觉密度整体收紧，**未在 [data-ui-size] 档位中补偿 titlebar 尺寸**（small/large 分支只调 control-height，不调 --titlebar-*）→ 三档 UI size 下顶栏高度恒 28px，与 36px header 的视觉比例在 large 档偏矮。

### 3-08 `01ef652b` UI 交互无障碍修复（2026-08-09）——z 与暗色文本正迁移

- 内容：15 项修复（Dialog Esc/focusTrap/Menu/Tooltip/Input/z-index token 化/dark 文本色）。
- 核验：`--ui-text-*` 的 dark 覆盖（tokens.css:495-500）由本提交正确建立，属**正向修复**，未发现新回归；Tooltip 双份（components/Tooltip + ui/Tooltip）存在样式冗余（P3 维护项）。

---

## 四、运行时验证结果（playwright, 1440×900, 浏览器环境）

| 检查项 | 结果 | 说明 |
|---|---|---|
| 横向溢出 | **无**（docScrollW 1440 = clientW 1440） | 页面健康 |
| 纵向溢出 | 无 | 正常 |
| body 背景/文字 | rgb(237,235,232) / rgb(31,29,25)，theme-light | light 主题正常渲染 |
| token 运行时值 | `--bg-primary: hsl(35,12%,95%)`、`--text-primary: hsl(35,12%,11%)`、`--space-3: 12px` 等均解析正常 | themeStore 注入生效 |
| **`--chart-color-1/2`** | **UNSET（运行时确认）** | → 用量页图表柱背景无效（P1-01 实锤） |
| dark 分支（强制 data-theme=dark + 清 JS 注入） | bg-primary `hsl(0,0%,5%)` 等核心 token 正确；**`--sidebar-hover` 为 light 遗留值混色** | P2-01 实锤 |
| 按钮 hover | 「新对话」等透明背景按钮（_navItem），hover 无背景变化（浏览器 env 下无 session 数据，侧栏为空态） | 部分功能组件因无 Tauri invoke 不可用，属环境限制 |
| z-index 大战 | 无 >1000 的堆叠冲突（highZ 检测为空） | 健康 |
| console 警告 | "No available adapters." ×4（E-01）；persist-degraded-meta/invoke 缺失（E-02） | 均属浏览器环境噪音 |

### 运行时采样（关键组件计算样式）

- 顶栏按钮：28px 高、透明底、无边框（_navItem）—— 与 P2-03 密度收紧一致。
- 设置面板可打开（settingsDialog=true），但"外观/深色"切换按钮在浏览器环境未渲染数据（依赖 invoke）。

---

## 五、修复优先级建议

### P0（本周内，1 项）
1. **P1-01 `--chart-color-1/2`**：SettingsUsageTab.module.css 4 处改为 `var(--accent-chart-out)` / `var(--accent-chart-in)`（注意 in/out 对应关系以原意为准：out=外柱=深色=accent-chart-out，in=内柱=accent-chart-in），或补 token 别名。改后必须跑 `test:snapshots` 全量（哈希不变则快照不受影响，纯值替换无哈希影响——值替换不改类名/文件，安全）。

### P1（1-2 周内，2 项）
2. **P1-02 DiffCard hover 体系**：`--hover-bg/--active-bg` 8 处替换为 `--bg-hover/--bg-active`（删除黑色 rgba fallback），暗色 hover 恢复可见；顺带删除 457/462 行的 `!important`（若来源是覆盖链则一并解决）。
3. **P2-01 dark 侧栏 hover**：tokens.css dark 分支补 `--sidebar-hover/--sidebar-active/--control-mix-color`（建议 `color-mix(in srgb, var(--text-primary) 5%/8%, var(--bg-secondary))` 与 `--bg-hover/--bg-active` 对齐），并补一条 `style-contract.test.ts` 风格的结构性校验（dark 分支必须覆盖色相关 token）。

### P2（后续批次）
4. **P2-03 顶栏密度**：将 `--titlebar-row-h` 纳入 [data-ui-size] 三档（small 26px / 默认 28px / large 32px），消除 44→28 无补偿压缩；或回退 top-gap 6px。
5. **P2-02 !important 收敛**：优先处理 settings-segment 壳（settings-base.css:969-989）与 SettingsQuickMenu，改为 token 覆盖不依赖 !important。
6. **P2-04 StatusDiagnosticsPanel**：`--ui-bg-*` 系列迁移到 `--color-*-bg` 语义 token。

### P3（体系卫生，与并行域协调）
7. **编码统一**：5 个 GBK 文件 + chat.css 注释转 UTF-8 无 BOM —— **必须与快照更新同一提交完成**（否则哈希漂移再次红测试），参考 8e8c313c 教训。
8. `--z-drag-overlay-max` 补定义（z-index.css 增加档位或改引用 `--z-drag-overlay`）；tokens.css:275 注释删除或改写；`--font-weight-semi`→`--font-weight-semibold`；`--font-mono-features` 补 token。
9. 双份 Tooltip（components/Tooltip 与 ui/Tooltip）收敛为一份；ChatToolCallBlock 与 chat.css 的双重 border !important 去重。
10. 恢复 z 值一致性校验（原 `check:zindex` 断链，可做成 style-contract 测试）。

### 治理建议（跨域）
- 建立"样式文件变更 → 快照哈希漂移 → 快照更新"联动检查（CI 或脚本），从机制上防止 8e8c313c 式编码漂移复发。
- 新组件一律禁裸数字 z-index / 禁 light-only rgba fallback；`var()` 无 fallback 引用纳入 typecheck 或 lint 检查（本次 47 处悬空引用可作基线）。

---

## 附：审计统计

- token 定义：402（:root light 263 / dark 89 / ui-size 档位）
- var() 引用：9366 处 / 111 css 文件
- 悬空引用：47 处（其中无 fallback 4 处 → P1-01）
- !important：46 处
- 硬编码 hex/rgba（module.css）：44 处（绝大多数为 dev/诊断组件，非问题）
- 硬编码 px（module.css）：约 120 处（多数为固定图标/专用组件尺寸，需逐一确认）
- 运行时：无溢出、无 z 冲突、4 条环境噪音警告

## 不确定性标注

- `--chart-color-1/2` 的 in/out 语义对应（外柱/内柱与 accent-chart-in/out 的映射）未在 TSX 中读图逻辑确认，修复时需对照 chartBarStack 结构。
- "No available adapters." 字符串未能定位源码出处（node_modules 全量搜索无果），按环境噪音处理，若在 Tauri 运行时重现需另查。
- SettingsUsageTab 图表实际渲染需要 Tauri invoke 数据，浏览器环境无法目视确认柱体不可见，但 CSS 无效值是静态可证的。
