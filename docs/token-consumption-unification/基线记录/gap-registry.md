# 缺口登记（gap-registry）

> **性质**：**必须清零**的违规清单。**不是可接受基线。**
> **纪律**：`scripts/check-token-ssot.mjs` 的硬失败指标**目标恒为 0，不读取基线值**——存量不得写入基线来"合法化"。本表是存量的唯一合法载体，每条带**清零条件**与**归属单元**。
> **载体**：`scripts/check-token-ssot.mjs` · 登记表 `scripts/token-registry.json`
> **生成**：2026-09-11（T1 单元）

---

## 一、门禁实测（2026-09-12 · 第十一次更新）

```
[check-token-ssot] A 类 token 548 个 · CSS 定义点 624 个 · JS 注入名 72 个
[check-token-ssot] 登记表 B 类 33 个 · 组件孤岛前缀 12 个 · 外部注入 2 个

multi_file_defs       当前    0   ✓ 硬失败清零（2026-09-12）
documented_api_defs   当前   26   @ratchet（已定性合法模式：主题化 API / Dialog 配置 / 尺寸分级 / md 变体 —— 见 token-registry.json）
js_inject_a_class     当前   23   硬失败（T7 第一批别名收敛 -17：40→23；余 23 = 皮肤派生核心参数，T7 后续批次待做）
a_class_multi_writer  当前    0   ✓ 硬失败清零（2026-09-12，含门禁写者检测误报修正）
b_class_no_default    当前    0   ✓ 硬失败清零（2026-09-12）
b_class_drift         当前    0   ✓ 硬失败清零（2026-09-11）
namespace_overlap     当前    5   硬失败（待 PaneHeader.module.css 释放后改名 --pane-tab-*）
whitelist_size        当前   15   棘轮（只降不升）
```

**另**：`check-token-consistency` 当前 **PASS 0/0/0**；`check-input-guardrails` **100% PASS**（D29）；`check-layout-tokens` PASS；`check-text-color-tokens` PASS（D34）；layout-contract + dual-source-values + input-three-patterns + style-contract 全量 **140/140 PASS**；`tsc --noEmit` 0 错误。

**清零战果（09-11 → 09-12）**：`b_class_drift 6→0` · `a_class_multi_writer 4→0` · `b_class_no_default 13→0` · `multi_file_defs 69→0（未文档化部分）` · `js_inject_a_class 40→23（T7 第一批）` · `namespace_overlap 6→5`——明细见台账 D29–D41；运行时证据：tauri-mcp 派生链验证 11/11、prefs 往返 19/19、应用日志 error 60→0。

---

## 二、逐项缺口与清零条件

### G1 · `multi_file_defs = 69` → 0　【归属 T8 / T9】

同一 token 在被 ≥2 个 CSS 文件定义。**主要族**：

| 族 | 文件 | 清零条件 |
|---|---|---|
| `--btn-*`（`--btn-fg/-hover-overlay/-active-overlay/-radius/-h/-fs/-px/-border/-bg/-shadow/-gap/--btn-icon-size`） | `ui/Button` + `diff/DiffCard` + `sidebar/SidebarNav` + `workspace/PreviewCard` | 归口 `ui/Button` 单源；其余文件改为**消费**或改用 `ui/Button` |
| `--md-*`（46 个） | `styles/tokens.css` **+** `styles/markdown-typography.css` | **删 `markdown-typography.css:12-81` 的 `:root` 与 `html[data-theme='dark']` 定义块**（只留消费规则）。因两文件**主题相关地互相覆盖**，必须先做视觉回归 |
| `--dialog-z` / `--dialog-width` | 5 / 3 个 dialog 文件 | 归口 `ui/Dialog`；`--dialog-z` 直接用 `--z-modal` |
| `--tab-duration` / `--tab-press-duration` / `--tab-spring-bezier` | `ui/Tabs` + `ui/SegmentedControl` | 归口 `ui/Tabs` |
| `--duration-*` / `--transition-*` | `styles/reduced-motion.css` + `styles/tokens.css` | **授权**（降动覆盖）；但 `reduced-motion.css:22-25` 的 4 个冗余选择器应收敛为单一 `:root` |
| 单点遮蔽 | `--scrollbar-width`(ScrollArea) · `--seg-inner/outer-radius`(SegmentedControl) · `--tab-gap`(Tabs) · `--sidebar-width`(responsive.css) · `--diff-gutter-bg`(FileViewerCard) · `--focus-ring-color`(focus-visible.css) | 逐个二选一：提升为全局语义 token，**或**改名为带前缀私有 token |

### G2 · `js_inject_a_class = 40` → 0　【归属 T7（关键）】

**这是「改 tokens.css 界面不变」的机械根因。** JS 内联样式覆写 A 类语义 token，优先级高于 `tokens.css` 选择器 → 静态真源被完全遮蔽。

| 写者 | 被写的 A 类 token | 清零条件 |
|---|---|---|
| **`services/TokenRuntimeController.ts:432-459` + `:485-510`** | **34 个**：`--surface-chrome/-paper/-card/-elevated` · `--bg-paper/-primary/-secondary/-tertiary/-card/-elevated/-workspace` · `--shell-chrome-bg` · `--shell-inset-bg` · `--text-primary/-secondary/-tertiary` · `--border-color/-subtle` · `--control-mix-color` · `--control-soft-bg/-hover/-active` · `--composer-bg` · `--terminal-bg/-fg/-cmd` · `--accent-green-light-adaptive` · `--accent-red-light-adaptive` · `--font-size-adjust` | **参数化**：JS 只写参数（`--user-accent-h/s/l`、`--user-surface-tint`、`--user-brightness`、`--ui-scale`、`--font-size-adjust`），语义 token 改由 `tokens.css` 用 `color-mix`/`calc` **内派生**；随后删除全部语义 token 的 `setProperty` |
| `api/fontStore.ts:149-158` | `--font-sans` `--font-mono` `--md-font-family` `--md-font-sans` `--md-text-font` `--md-font-mono` `--md-code-font` `--sep-font-sans` `--sep-font-mono` | 同上：字体族改为「参数 + 静态族声明组合」 |
| `api/codeBlockIndent.ts:51` | `--md-code-tab-size` | 改为参数 `--user-code-tab-size` + CSS 派生 |
| `components/binary-tree/PaneHeader.tsx:469` · `components/binary-tree/LeafToolTabStrip.tsx:327` | `--tab-gap` | 实为运行期/局部量 → 登记 B 类并补静态默认，**或**改名私有 |

> ⚠️ **严禁**把上表任一项登记为 B 类来"消除"违规。它们**是 A 类设计 Token**，正确出路是**参数化 + CSS 内派生**，不是"登记为运行期量"。判据见 `../02-分维-真源唯一化与多轨物理清退.md` §2.1。

### G3 · `a_class_multi_writer = 3` → 0　【归属 T7】

P2「两个 JS 写者争用同一 token」的探测器。争用必然顺序耦合、最终值不可预测。

| token | 写者 | 清零条件 |
|---|---|---|
| `--font-sans` | `api/fontStore.ts` + `utils/pretextFontBridge.ts` | 收敛为单一写者（字体族参数化后一并解决） |
| `--tab-gap` | `binary-tree/LeafToolTabStrip.tsx` + `binary-tree/PaneHeader.tsx` | 单一 writer，其余改为消费注入结果 |
| `--sidebar-width` | `components/sidebar/useSidebarResize.ts` + `main.tsx` | 收敛为单一写者（`main.tsx:119` 的常量注入应删除，改为读 `useSidebarResize` 的初值） |

> **已修复的历史实例（留档作为范式）**：`--text-primary` 曾由 `themePersonalization` 与 `oklchColorGuard` 双写；并行会话已把 `oklchColorGuard` 改为**纯函数** + `setTokenRuntimeSetter` 委托写入 → 争用消除。此范式应推广。

### G4 · `b_class_no_default = 13` → 0　【归属 T6】

B 类运行期量必须在 `tokens.css` 声明静态默认值（消除「静态不可知」与「靠兜底存活」）。缺声明者：

`--sidebar-visible-width`(260px) · `--leaf-dock-width`(320px) · `--anchor-width`(0px) · `--transform-origin`(top left) · `--font-mono-features`(normal) · `--tab-item-width`(120px) · `--tab-width-max`(240px) · `--tab-width-min` · `--tab-close-hit-pad` · `--tab-height` · `--tool-tab-width-max` · `--tree-level`(0) · `--files-list-ratio`(40%) · `--tooltip-translate`(translate(0))

**清零条件**：逐项在 `tokens.css` 补静态声明；消费点随即改为**裸 `var()` 去兜底**。

### G5 · `b_class_drift = 6` → 0　【归属 T6】

**未登记但被写入**（应登记 B 类 + 补静态默认）：

`--composer-max-lines` · `--composer-line-height` · `--toast-frontmost-height` · `--toast-height` · `--toast-swipe-movement-x` · `--toast-swipe-movement-y`

> 这些是**货真价实的运行期量**（Toast 栈高度/滑动位移、composer 行高），登记即可。

### G6 · `namespace_overlap = 6` → 0　【归属 T9】

同名 token 同时充当全局 B 类与组件孤岛（双重角色）：

`--tab-item-width` · `--tab-width-max` · `--tab-width-min` · `--tab-close-hit-pad` · `--tab-height` · `--scrubber-pinned-tint`

**成因**：登记表组件孤岛前缀 `--tab-`（属 `ui/Tabs`）与 B 类 `--tab-*`（属 `binary-tree/PaneHeader`）**前缀撞车**。
**清零条件**：二选一——① `ui/Tabs` 的孤岛改名为 `--tabs-*`；② `binary-tree` 的改名为 `--pane-tab-*`。改名后同步更新 `token-registry.json.componentIslands`。

---

## 三、其他必须清零的现状（非本门禁覆盖）

| 项 | 实测 | 清零条件 | 归属 |
|---|---|---|---|
| `--chat-stream-pad-x` 两处消费点仍带裸兜底 | `ChatMessageList.module.css:38` · `ChatScrollFloorSlot.module.css:20` 仍为 `var(--chat-stream-pad-x, 20px)` | 改为裸 `var(--chat-stream-pad-x)` | T2 残项 |
| **`--chat-stream-pad-x` 取值分叉** | token 定义为 `var(--space-5, 20px)`，而 `--space-5` = **20px(中)/20px(小)/24px(大)**；TS 侧 `chatScrollGeometry.ts:8` 的 `CHAT_SCROLL_PAD_X = 20` **固定** | **需裁决**：① 保持随密度缩放 → TS 常量应改为读计算值；② 固定 20px → token 改为 `20px` 不引用 `--space-5`。**二者不可并存** | 待用户裁决 |
| 矛盾兜底 token | **58 个**（裸 fallback 2,424 处宽口径） | 按四分法处置（去兜底，**不是**改兜底） | T3 |
| 几何裸 px | 3,662 | 迁至既有档位；棘轮下降 | T10 |
| `!important` | 152 | 棘轮下降（降动白名单除外） | T11 |
| 魔术数字补偿 | 14 | 改用布局原语 | T11 |
| 密度档层叠失效 | `--space-1` large 声明 6px，亮色实得 4px | 修选择器特异性 + 上线 `G-CASCADE` | T11 |
| 门禁接线缺口 | 15 个 token 门禁无自动触发点；6 脚本零引用 | `check:tokens-all` + 接入 pre-push/CI | T14 |
| 跨层未注册声明 | `#[tauri::command]` 166 vs 注册 142 | 逐个裁决（dev-only 登记 / 退役物理删除 / 误报修解析器） | T13 |
| 旧存储 key 双轨 | 11 个 | 收敛至唯一权威源 + 负向断言 | T12 |
| **本门禁自身尚未接线** | 仅可手动运行 | 接入 `check:tokens-all` 与 CI | T14 |

---

## 四、门禁使用说明

```powershell
# 全量判（有违规 exit 1）
node scripts/check-token-ssot.mjs

# 全量明细
node scripts/check-token-ssot.mjs --list

# 单个指标的正确做法（子 Agent 自纠用）
node scripts/check-token-ssot.mjs --guide js_inject_a_class
node scripts/check-token-ssot.mjs --guide multi_file_defs
node scripts/check-token-ssot.mjs --guide a_class_multi_writer
node scripts/check-token-ssot.mjs --guide b_class_no_default
node scripts/check-token-ssot.mjs --guide b_class_drift
node scripts/check-token-ssot.mjs --guide namespace_overlap
node scripts/check-token-ssot.mjs --guide whitelist_size
```

**可用 `--guide` 的指标**：`multi_file_defs` · `js_inject_a_class` · `a_class_multi_writer` · `b_class_no_default` · `b_class_drift` · `namespace_overlap` · `whitelist_size`

**设计要点（防「门禁绿、仓库脏」）**：6 个硬失败指标**一律与 0 比较，不读基线**。基线文件仅承载 `whitelist_size` 这一棘轮指标。因此门禁**当前必然为红**——这是正确状态：它如实反映存量，直到存量被清零。
