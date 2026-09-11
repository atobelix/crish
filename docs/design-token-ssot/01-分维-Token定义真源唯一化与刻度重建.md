# 01-分维：Token 定义真源唯一化与刻度重建（A1 + A2）

> 上级：`00-总方案-设计Token与偏好SSOT端到端重构.md`
> 口径：**纯逻辑执行顺序与依赖拓扑**，不含工期/人天/人员/优先级。本分维内所有病灶**逻辑同权**；排列顺序仅表示"谁必须在谁之前"，不表示重要性。
> 禁止：临时补丁、无日落期兼容、魔术数字补偿。所有旧结构均**物理删除**。

---

## 零、本文覆盖的节点与在总方案中的位置

| 节点 | 内容 | 上游依赖 | 下游被依赖 |
|---|---|---|---|
| **A1** | Token 定义真源唯一化 | 无（自闭环起点） | A2、C（运行时注入唯一化） |
| **A2** | 刻度重建 | A1 | A3（消费者改写）、A4（清零） |

A3（消费者改写：去裸 hex / 去内联 / 去 primitive 引用）与 A4（未定义与死 token 清零）另见 `02-分维-未定义引用与死Token清零.md` 与后续文档。**A2 未完成前不得开始 A3**：否则消费者会从一个魔术数字迁到另一个（例如把 `7px` 换成 `--radius-btn` 而刻度中并无该档）。

---

## 一、A1：Token 定义真源唯一化

### 1.1 现状：四源并存（均为已核实的锚点）

| # | 源 | 位置 | 性质 |
|---|---|---|---|
| 1 | `tokens.css` | `apps/crish-desktop/src/styles/tokens.css`（浅 569 / 暗 449 成对） | 名义真源 |
| 2 | 平行硬编码色板 | `api/themePresets.ts` — **209** 处颜色字面量，经 `themePersonalization` 用 `setProperty` 覆盖同名 token | 运行时盖过源 1 |
| 3 | 文字层级写死 | `api/oklchColorGuard.ts:120-127` 写死 4 个 hsl 给 `--text-secondary/tertiary`；`:118` 用 `textPrimary === 'hsl(0, 0%, 94%)'` **字符串反推明暗** | 运行时盖过源 1 |
| 4 | 裸 hex 默认值 | `api/themeStore.ts:103-104` `'#f4f3f0'` / `'#1a1a1a'` | 真实调用处传 Default |

另有**混合色彩空间**：`tokens.css` 内 66 个 oklch 与 99 个 hex、123 个 hsl 并存；OKLCH 色相散落 15 个值且同 H 的 L 无刻度规律（逐 token 手填）。

### 1.2 目标形态：两级分层，各自唯一

```
primitive（原始值；**全仓唯一硬编码处**）
  ├─ 色阶：--p-<hue>-<step>（oklch，L/C/H 成刻度）
  └─ 基础量：--p-space-* / --p-radius-* / --p-font-* / --p-dur-* / --p-shadow-*
        │  var()
semantic（语义命名；**全部由 primitive 派生**，自身不含字面量）
  ├─ --text-* / --bg-* / --border-* / --color-*（状态六元组）
  └─ --z-* / --focus-* / --ctrl-* / --icon-*
        │  var()
component（组件只允许引用 semantic）
```

**唯一性规则（可被 G 门禁机械校验）**

| 规则 | 校验方式 |
|---|---|
| primitive 层之外不得出现颜色字面量 | 扩 G3（`oklch/rgb/hsl/hex` + 颜色关键字，全属性） |
| semantic 层的值必须整条为 `var()` 或 `color-mix(...var(--p-*))` | G3 子规则：semantic 段内不得含字面量 |
| 组件 CSS/TSX 引用集与 primitive 集合交集为空 | 新增 G10（新方案 §6.5 的补项，见 §1.5） |
| 运行时 `setProperty` 只允许出现在单一控制器 | G7 |

### 1.3 A1 执行序列（严格按依赖）

**A1-1 `tokens.css` 内部划段**
在文件内划定 `/* == L1 primitive == */` / `/* == L2 semantic == */` / `/* == L3 组件域 == */` 三段；`z-index.css` 与 `markdown-typography.css` 等既有 token 文件归入对应层（`z-index.css` → L2）。
前置意义：后续所有机械校验都以"段"为边界，无分段则无法判定某行是否允许字面量。

**A1-2 建立 primitive 色阶，收敛 OKLCH**
- 为现有 15 个散落色相建立色阶：每色相给出统一的 L 序列（例如 6 档）与受限的 C 序列；**同色相的 L 必须构成等差或等比序列**，逐 token 手填的独立值全部替换为刻度取值。
- 混合色彩空间统一为 `oklch`。
- **值不变性校验（强制）**：转换前后对每个 token 做 computed 值等价断言（在真实 DOM 上 `getComputedStyle` 对比），差异超出感知阈值（ΔE OK 阈值需显式写入测试常量）即视为改坏了视觉，必须回退该值而非放宽阈值。

**A1-3 `themePresets.ts` 降级为 primitive-only**
- 该文件**只允许**输出 `--p-*` 键。
- 其现有的 semantic 键（`--bg-*` / `--text-*` / `--border-*` / `--composer-bg` / `--terminal-*` 等）**物理删除**，改由 `tokens.css` 的 semantic 段以 `var(--p-*)` 派生。
- 皮肤（skin）的差异表达方式改为"选择一组 primitive 色阶赋值"，而非"覆盖 semantic 值"。
- 前置意义：这是"改 tokens.css 但界面不变"的根因；不先执行，A2 的刻度调整会被色板盖掉。

**A1-4 `oklchColorGuard` 职责并入运行时控制器**
- `getContrastGuardedText` 改为返回 `{ value: string; isDark: boolean }`。
- 删除 `:118` 的字符串相等反推 —— 明暗判定必须来自**布尔返回值**，不得来自结果字符串比对。
- 删除 `:120-127` 写死的 4 个 hsl；`--text-secondary` / `--text-tertiary` 改为由 `--text-primary` 与背景以 `color-mix()` 派生（派生方向由 `isDark` 布尔决定）。
- 该文件作为独立模块**物理删除**，逻辑并入 A1-5 的控制器（总方案 N7）。

**A1-5 建立唯一运行时注入点**
- 新建 `TokenRuntimeController`（总方案 N7），成为**全仓唯一** `setProperty` 调用点。
- 输入 = 偏好（来自 B 组偏好通道）+ primitive 定义；输出 = semantic 派生。
- 现有的 `themeStore.applyTheme`（写 `data-theme`）、`visualThemeController`（写 `data-ui-size`/`--ui-scale`/`data-density`/`data-shell-chrome`）、`themePersonalization`（写 ~30 个 token）三处注入职责全部并入，原模块**物理删除**。
- 注意：属性（`data-*`）与变量（`--*`）的写入顺序必须由控制器内部固定，不得依赖模块加载顺序。

**A1-6 `themeStore` 裸 hex 默认值改为 token 引用**
`api/themeStore.ts:103-104` 的 `'#f4f3f0'` / `'#1a1a1a'` 替换为对应 semantic token 表达式；"真实调用处传 Default"的模式清零。

### 1.4 A1 负向断言（须与代码同时落地）

```
A1-V1  全仓（primitive 段之外）不存在颜色字面量：hex / rgb() / rgba() / hsl() / oklch() / 颜色关键字
A1-V2  tokens.css 的 L2 semantic 段内每一条声明的值均为 var()/color-mix()，无字面量
A1-V3  themePresets.ts 输出的键集合 ⊆ { --p-* }
A1-V4  全仓 `setProperty('--` 调用点数量 === 1（仅在 TokenRuntimeController 内）
A1-V5  模块 api/oklchColorGuard.ts 不存在（import 抛错）
A1-V6  全仓不存在标识符 themePersonalization / visualThemeController（职责已并入）
A1-V7  全仓不存在字符串 '#f4f3f0' / '#1a1a1a'
A1-V8  同色相 primitive 的 L 值序列满足声明的刻度（数据驱动断言，非硬编码期望值）
A1-V9  真实 DOM 上每个 token 的 computed 值在"色彩空间统一"前后 ΔE 在阈值内
```

### 1.5 需新增的门禁

| 门禁 | 内容 | 依赖 |
|---|---|---|
| **G10** | 组件引用集 ∩ primitive 集 === ∅（当前组件直引 primitive 约 400 次：`--brand` 86 / `--accent-color` 70 / `--accent-orange` 44 / `--accent-red` 41 / `--accent-green` 35 / `--brand-deep` 27 / `--surface-paper` 18 / `--accent-primary` 15 …） | A1-1 分段完成后才可建线 |
| **G11** | `setProperty('--` 调用点计数 === 1 | A1-5 完成后建线 |

---

## 二、A2：刻度重建

### 2.1 圆角（用户明确点名）

**现状**：基准刻度 `2 / 4 / 6 / 8 / 12 / 12(=xl 的重复) / 9999`；组件实际出现 **14 个离群值**：`1, 3, 5, 7, 9, 10, 13, 14, 16, 18, 20, 22, 24, 999`；**25.8%（118/458）**落在刻度之外。`tokens.css:474` 已写「设置/按钮圆角锁：默认档 8px」，但组件里 `border-radius: 7px` 仍有 **23 处**。

**目标刻度（每档必须有可陈述的语义归属，不得凭空）**

| 档 | 值 | 语义归属（据现状频次与组件类型归并） |
|---|---|---|
| `--r-xs` | 2px | 极小内联标记（badge 内角） |
| `--r-sm` | 4px | 输入框、小按钮 |
| `--r-md` | 6px | 下拉项、标签页 |
| `--r-btn` | **7px** | **设置/按钮圆角锁**（替换 `tokens.css:474` 的 8px 口径与 23 处硬编码） |
| `--r-lg` | 8px | 卡片内层容器 |
| `--r-pop` | **10px** | 浮层（菜单/下拉/气泡） |
| `--r-xl` | 12px | 卡片、面板 |
| `--r-full` | 9999px | 药丸 |

**动作**：物理删除 `--radius-2xl`（与 `--radius-xl` 三档全等：`:373-374`、`:1471-1472`、`:1547-1548`）；`[data-ui-size='small'|'large']` 的覆盖需**逐档重建**为新刻度对应的收缩/放大值（不是简单 ±1px），且必须保证"小/大档也落在刻度上"。
**离群值处置**：`1/3/5/9/13/14/16/18/20/22/24/999` 逐处归并到最近档位；归并方向必须由**组件语义**决定，不得按数值就近机械吸附。每处归并记入 §2.9 的改写清单。

### 2.2 间距

**现状**：17 档 `0/2/4/5/6/7/8/10/12/14/16/20/24/32/40/48/64`；其中 `2/4/5/6/7/8` 六档挤在 8px 内，同时缺 3 与 9；**155 处**不在刻度上。
**目标刻度（13 档）**：`0/2/4/6/8/12/16/20/24/32/40/48/64`。
**动作**：`5/7/14` 三档归并（`5→4` 或 `6`、`7→6` 或 `8`、`14→12` 或 `16`，逐处按组件语义判定）；离群 `1/3/9/18/22/28` 逐处归并；`--space-0/12/16/1_25/1_75` 等死 token 一并处置（见 02 文档）。

### 2.3 字号 / 行高

**现状**：7 档 `11/12/13/14/16/18/22`；`--font-size-2xl` 与 `xl` 重复；`--md-code-font-size:12.5px` 越界；9 个 line-height 各自散用，**字号与行高未配对**。
**动作**：
- 字号收敛为 `12/14/16/18/20/24`，删除重复档。
- 建立**字号→行高配对表**（正文/紧凑 UI/代码/标题四类各自成对），行高以 `--lh-*` 表达并绑定到字号族，组件不得单独写 `line-height` 数值。
- `12.5px` 归并，并确认归并后代码块行数不被改变（代码块行高变化会直接影响虚拟滚动的几何与 `DIFF_FIXED_ROW_HEIGHT=22` 假设）。

### 2.4 字重 / 字距

现状**唯一健康维度**：`400/500/600/700` 全部落在档内。**动作**：仅补 `--weight-regular` 等语义别名（`--font-weight-regular` 当前被引用但未定义，见 02 文档），不新增数值档。

### 2.5 高程（阴影）

**现状**：5 档服务 7 类场景；**约 300 处 `box-shadow` 不走 token**；`--shadow-dropdown` 被引用但未定义。
**目标 9 档**：`flat(无) / subtle / card / pop(浮层) / menu(菜单) / dropdown(下拉) / drawer(抽屉) / toast(浮层提示) / drag(拖拽中)`。
**动作**：逐档给出可陈述的"高度差 + 模糊半径 + 透明度"三元组，且**透明度不得用 `rgba(0,0,0,α)` 硬编码**（暗色下不可见，当前有 29 处），改用 `--overlay-*` 派生。

### 2.6 z-index 标尺与层叠穿透规范（对应红线 4）

**现状**：`z-index.css` 13 档，但组件裸写 `1/2/5/6/8/20/25/30/50/150/160/2010/` **`100000`**；且 `--z-pinned-bar` / `--z-sticky-bar` / `--z-decorative` / `--z-context-menu` / `--z-dropdown-menu` / `--z-smart-panel(-sub)` / `--z-index-popover` / `--z-drag-*` **未定义** → `z-index: var(...)` 整条声明无效、退回 `auto`。
**动作**：
- 建立**单一标尺**并把上述缺档真实定义；删除全部裸数值（含 `100000` 逃逸）。
- 新增**层叠穿透检查规范**（不是新增门禁即可了事）：涉及滚动/粘性/浮层的层，必须检查**祖先盒模型与 Stacking Context**——触发条件包括 `transform`/`filter`/`will-change`/`contain`/`opacity<1`/`position`+`z-index`。当前 `overflowAnchor:'none'` 散布 11+ 处、且无任何滚动视口使用 `contain: strict`，属"用补偿替代原生几何稳定"，须在改写时一并评估。

### 2.7 状态色

**现状**：4 语义（danger/success/warning/info）× 3 元（base/bg/border）；缺 hover/active/soft/text-on → 组件自行 `color-mix` 造 hover（12 次）。
**目标**：每色 6 元组 `base / hover / active / soft / border / text-on`，全部由 primitive 色阶派生；组件禁止自行混色。

### 2.8 其余维度

| 维度 | 现状 | 目标 |
|---|---|---|
| 混色 | 0 档；29 处 `rgba(0,0,0,α)` | `--overlay-1..4`（4/8/12/16%）+ `--scrim-*` |
| 动效 | ~35 档但含大量死 token；69 处内联 `cubic-bezier`（33 处重写 `--ease-emphasized`）、34 处内联时长 | 时长四族 `enter/exit/emphasis/layout` × 定值 + 2 缓动 + 2 弹簧；禁用内联 `cubic-bezier` |
| 密度 | control-height 4 档 + icon 3 档，各面板各引一套 | `--ctrl-24/28/32/36` + `--icon-14/16/18` + `row = ctrl`，面板只能引用 |
| 焦点 | 仅 18 处引 `--focus-ring`，60 个文件自写 `:focus-visible` | 全局 `:focus-visible { box-shadow: var(--focus-ring) }`；补 `--motion-reduced` |
| 断点 / 玻璃 | 断点 8 档、玻璃 2 档**全部 0 消费**；`--backdrop-blur: none` 永久空转 | 桌面端无流式断点 → **物理删除**；玻璃要么真实现要么删除 |

### 2.9 A2 交付物（改写清单）

A2 的产出不是"新增了刻度"，而是**刻度 + 逐处改写清单**：
1. 新刻度定义（写入 `tokens.css` L1/L2）；
2. **离群值归并清单**：118 处圆角 / 155 处间距 / 约 300 处阴影 / 69 处缓动 / 34 处时长 / 全部裸 z-index，逐条给出 `文件:行号 → 原值 → 新 token → 归并依据`；
3. 面板级密度映射表（侧栏/工具栏/列表各自引用哪组 `--ctrl-*`/`--icon-*`）。

### 2.10 A2 负向断言

```
A2-V1  tokens.css 内 border-radius 取值集合 === 目标刻度集合
A2-V2  全仓 border-radius 取值 ∈ 刻度（放行 var()/calc()）
A2-V3  全仓 padding/margin/gap 数值 ∈ --space-* 刻度
A2-V4  全仓 box-shadow 均为 var(--shadow-*)
A2-V5  全仓 z-index 均为 var(--z-*)
A2-V6  全仓 transition/animation 时长与缓动均为 token（无内联 cubic-bezier）
A2-V7  --radius-2xl / --font-size-2xl 不存在
A2-V8  --breakpoint-* 不存在（若确认为桌面端无消费）
A2-V9  全仓 !important 出现次数 === 0
A2-V10 每个状态色存在 6 元组（数据驱动断言）
```

---

## 三、A2 完成后必须同时成立的联动条件

A2 只改刻度而不改消费者，等于把魔术数字留在原地并新增一套无人使用的刻度 —— 这是"功能伪连通"的一种。因此 A2 的完成判定包含：

1. 新刻度的每一档**至少有一个真实消费者**（否则该档属凭空定义，必须删除）；
2. §2.9 的归并清单**逐处执行完毕**（不是"登记待办"）；
3. A3 的消费者改写与 A2 的归并清单**是同一份清单的两个视角**，不得拆成两轮造成双写。

---

*本文所有现状数字均来自 `node scripts/check-token-consistency.mjs`（基线 78/22/143）与 `analysis/2026-09-10-前端设计Token体系审查与扩充方案.md` 的复算结果；所有位置均附 `文件:行号`。*

---

## 四、执行记录（2026-09-10）

### 4.1 已完成

| 节 | 动作 | 依据 |
|---|---|---|
| §2.1 圆角 | 新增 `--radius-btn: 7px`，写入半径刻度区；`--button-radius` **反转为派生自 `--radius-btn`**（原为持值的死"锁"）；`ui/Button.module.css` 的 3 处兜底 `8px` → `7px` | 项目自己的调研锁：`docs/desktop-ui-repair/survey/04-设置按钮圆角7px与曲率混乱.md`「用户锁：设置界面的按钮圆角半径 = 7px」；并修正 `tokens.css` 里与之矛盾的「默认档 8px」注释 |
| §2.1 删冗余 | 物理删除 `--radius-2xl`（3 处定义，与 `--radius-xl` 三档全等） | 复算证实 |
| §2.3 文字层级 | 补 `--text-faint`（`color-mix` 向背景侧派生，无裸 hex）、`--text-inverse`、`--text-on-overlay`；补 `--text-warning`（沿用既有 `--text-<state>` 别名 pattern） | 家族缺口（`--text-danger/-success` 在，`warning` 缺） |
| §2.5 高程 | 补 `--shadow-dropdown` / `--shadow-popover`，**归一到既有高程刻度**（不新造字面量） | A4 处置 |
| §2.8 tint | 补 `--tint-subtle`（族内最轻一档） | 家族缺口 |
| §2.6 z-index | 补 10 个缺档，全部为既有 7 级标尺的角色别名 | 此前 `z-index: var(--z-*)` 整条失效 |
| diff 布局 | 补 `--diff-gutter-width-unified/-marker-width/-width-split`（原仅以 fallback 存在） | A4 处置 |

### 4.2 未完成（下一轮范围）

| 节 | 未完成内容 |
|---|---|
| **§一 A1 全部** | 定义真源唯一化：`themePresets.ts`（209 处硬编码色板）降级为 primitive-only、`oklchColorGuard.ts:118` 字符串反推明暗改布尔返回、`themeStore.ts:103-104` 裸 hex 默认值、4 个运行时注入点合并为单一 `TokenRuntimeController`。**这是"改 tokens.css 但界面不变"的根因，优先级不低于本次已做部分。** |
| §2.2 间距 | 17 档 → 13 档收敛，以及 155 处越界值的逐处归并 |
| §2.7 状态色 | 六元组（hover/active/soft/border/text-on）补齐 |
| §2.8 动效 / 密度 | 四族时长 + 密度令牌 |
| **A3 消费者改写** | 117 处硬编码颜色、118 处越界圆角（含 7px 相关的 23 处）、155 处越界间距、约 300 处裸 `box-shadow`、69 处内联 `cubic-bezier`、352 处内联 `style`（143 处硬编码）—— 逐处改写清单尚未产出 |
| **G3–G6 / G10 / G11 门禁** | 仅 G1/G2 已落成；其余六道未建 |
