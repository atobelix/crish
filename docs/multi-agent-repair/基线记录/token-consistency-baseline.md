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
