# token 一致性门禁基线（G1/G2 · check-token-consistency）

> 归属：`docs/design-token-ssot/00-总方案-设计Token与偏好SSOT端到端重构.md` §6.5 G1/G2
> 建线日期：2026-09-10 · 维护：`node scripts/check-token-consistency.mjs [--update|--list|--check-format]`
>
> 语义：扫描 `apps/crish-desktop/src` 与 `apps/avatar-studio/src`（`--scan` 可覆盖），核算三项：
> - `undefined_refs`：`var(--x)` 被引用，但 CSS 定义集与 JS 运行时注入集都不含 `--x` 的条目数。
>   此类引用在浏览器中令整条声明成为 invalid at computed-value time，属性静默退回
>   `inherit`/`initial`，**不产生任何报错**（方案 §3 R4）。
> - `nofallback_refs`：上者中所有引用点都无 `var(--x, fallback)` 兜底的子集，属高危。
> - `dead_tokens`：CSS 中已定义、但全仓 `var()` 引用为 0 的条目数（方案 §3 R4）。
>
> 门禁：实测 > 登记 → exit 1（新增即拦，不得以提升基线掩盖）；实测 ≤ 登记 → 通过
> （存量按方案分维文档的顺序收敛）。提升基线必须显式 `--update` 且为有意决策。
>
> 本文件为量化数据文件，标记区由脚本维护；正文说明为建线时点口径，以标记区为准。
>
> 覆盖边界（明确划出，避免误解为已覆盖）：本门禁**不**检查裸 hex/rgb/hsl/oklch 与颜色
> 关键字（G3）、内联 `style` 硬编码（G4）、刻度合规（G5）、逃逸值（G6）。

## 建线时点说明（2026-09-10）

- 首次建线即按**现状**登记（存量豁免），不做任何"先清零再建线"的粉饰。存量收敛由
  `docs/design-token-ssot/` 的分维文档按依赖拓扑执行。
- 与 `analysis/2026-09-10-前端设计Token体系审查与扩充方案.md` 中「未定义 75 / 无 fallback 16 /
  死 token 146」的口径差异来自**检测精度提升**，非问题数量变化：
  1. 本脚本把 `apps/avatar-studio/src` 纳入扫描（其样式依赖 vendored 库 token，属真实缺口）；
  2. JS 运行时注入判定收紧为 `setProperty('--x'` 与两种对象键形态（字面键 `'--x':`、
     计算键 `['--x' as string]:`，后者覆盖 `ToastCard.tsx:103` 的 `--toast-index` 注入），
     不再用宽泛的 `'--x'` 后随逗号匹配（后者会把数组字面量误判为定义）；
  3. `var()` 的 fallback 判定改为**括号配平扫描**，替代逐行正则（避免嵌套 `var()` 与
     多行声明下的误判）。

## 建线当日精度修复（假阳性清零）

首轮扫描后即修掉三处假阳性来源，基线由 83/24/148 收敛为 **78/22/143**：

| 假阳性 | 来源 | 处置 |
|---|---|---|
| `--x` | `components/workspace/useXtermTerminal.ts:24` 的 JSDoc 示例 `var(--x, fallback)` | 新增**注释剥离**（CSS/JS 块注释 + JS 行注释，跳过 `https://` 分隔） |
| `--radius` | `styles/motion-concentric-contract.test.ts:75` 说明性注释里的示例写法 | 同上（块/行注释剥离） |
| `--unit-tab-active-bg` | `styles/style-contract.test.ts:184` 基线例外说明注释 | 同上 |
| `--toast-index` 等 | `components/overlay/ToastCard.tsx:103` 计算键 `['--toast-index' as string]:` | 定义集新增**计算键**匹配 |

外部注入白名单（`EXTERNALLY_INJECTED`）当前仅 2 项，均为 Radix 浮层在元素级注入：
`--radix-popover-content-available-height`、`--radix-popover-content-transform-origin`。
白名单不计入指标但**单独报数**，避免静默豁免；新增条目必须注明注入方。

## 高危清单（`nofallback_refs`）

高危条目的全量清单（含每个引用点）用 `node scripts/check-token-consistency.mjs --list` 打印。
处置顺序见方案 §3 R4 与分维文档（未定义引用必须**真实定义**或连同其消费者一并物理删除，
不得留下空壳 token）。

<!-- BASELINE_START -->
undefined_refs 0
nofallback_refs 0
dead_tokens 0
<!-- BASELINE_END -->

## 归零记录（2026-09-10 当日完成）

| 指标 | 建线值 | 终态 |
|---|---:|---:|
| undefined_refs | 78 → 71（精度修复后） | **0** |
| nofallback_refs | 22 | **0** |
| dead_tokens | 143 → 126（精度修复后） | **0** |

执行明细见 `docs/design-token-ssot/02-分维-未定义引用与死Token清零.md` §八。
基线自此固定为 **0 / 0 / 0**：任何新增未定义引用或死 token 立即 fail，不再接受提升基线。

## 门禁精度修复（2026-09-11 · 消费方识别加固）

归零后门禁仍会把**真实消费方**判成死 token，属检测口径缺口而非存量问题。已加固
`check-token-consistency.mjs`，新增两类"非 `var()` 形态"的消费识别（**只计入
`dead_tokens`，不并入 `refs`** —— 后者会因测试的 `not.toContain('--x')` 否定断言
凭空造出 `undefined_refs` 误报）：

1. **契约测试按名断言**：`.test.ts(x)` 内引号包裹的 token 字面量（`'--x'`）
   与正则字面量中的 token 名（`/--x:\s*[^;]+/`）。典型：`a11y-contrast` 的
   `parseBlock` 建表后按名比对对比度、`antiDarkeningGuard` 断言 `--breakpoint-*`
   定义位置、`style-contract` 断言 `--tint-scrollbar-track` 透明。
   被删则测试直接失败，属实消费。
2. **JS `setProperty` 写入**：CSS 给未初始化默认、JS 按用户偏好覆盖，属**有意的
   双源设计**（`--bg-paper` / `--shell-inset-bg` / `--accent-*-light-adaptive`）。
   只算定义不算消费会误判。此项与 `undefined_refs` 的 `defined` 口径对称。

反向验证（防"假门禁"）：造真死令牌 → 13→14 ✓；造未定义引用 → 0→1 ✓；
删 `--breakpoint-sm` 定义 → `antiDarkeningGuard` RULE-01 真红 ✓。

## 死码净清退（2026-09-11）

加固后清退 **8 项零消费方 token**（light + dark 各一份声明）：

| token | 判定 | 依据 |
|---|---|---|
| `--scrollbar-button-color` / `-hover-color` / `-hover-bg` / `-active-bg` / `-size` / `-arrow-size` | DELETE-SYMBOL | `ad3f4140` 统一双向滚动条重构后，旧"三段式端点按钮"令牌被弃用未清理；`ScrollArea` 实际只用 `--scrollbar-button-height` |
| `--scrollbar-thumb-min-size` | DELETE-SYMBOL | 同上，无任何消费方 |
| `--ui-text-primary` | DELETE-SYMBOL | 空壳（值 `inherit` ≡ 未定义）；且 `style-contract` / `a11y-contrast` 的断言清单为**五连不含 primary** |

## 未处置项与归属（2026-09-11 观测 · 不提升基线）

`dead_tokens` 实测 **4**，均为**并行战役进行中的中间态**，非设计缺陷，
**未删除**（会打断他人战役）、**未提升基线**（本节仅登记，标记区保持 0）：

| token | 归属战役 | 当前状态 |
|---|---|---|
| `--composer-radius-single` / `--composer-radius-multi` / `--chat-bubble-radius` | `docs/layout-token-system/00-总方案.md:95-97`（Composer/气泡语义层） | 已定义，消费方待接线 |
| `--space-7` | `docs/layout-token-system/01-三层Token体系与数学基准方案.md:101`（"补齐中段断崖"） | 刻度唯一零消费档位；同批 `--space-1..10` 已全部接线 |

**判定依据**：四者在归零点 `45512332` 与 `HEAD` 中**均不存在**，属纯工作区新增；
同批 `--radius-*` 全族（`sm/md/lg/2xl/3xl` + `button/seg-inner/seg-outer`）与
`--space-*`（除 7 外）**均已接线**，证明战役执行至末段，仅余接线未落。

**处置路径**（交由对应战役 owner）：接线消费方后门禁自然转绿；若确认某档位
不需保留，按 `02-分维` §一 的 DELETE-SYMBOL 处置。**不得**以 `--update` 提升基线掩盖。
