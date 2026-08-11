# A-PERF 性能基线（W6-C · 结构门 + 数值占位骨架）

> **权威**：`plans/specs/perf-governance.md` · `18-实现波前待决锁定-H1H2H3M1.md` §H3
> **断言索引**：`acceptance/A-assert-index.md`（`A-PERF-*` / `A-PERF-DEG-01` / `A-MEM-01`）
> **禁止**：「先标低标准再宣称通过」。数值列为 **TBD（未标定）** 时，**不得** 以数值门绿灯合入宣称 PERF 通过；结构门可独立验收。

| 元数据                | 值                                                                 |
| --------------------- | ------------------------------------------------------------------ |
| **perf_baseline_rev** | `0`                                                                |
| **状态**              | 结构门可验；数值门 **未标定**（初值占位）                          |
| **修订规则**          | 机器指纹或阈值变更 → **bump** `perf_baseline_rev` 并登记 diff 原因 |
| **入库 Wave**         | W6-C                                                               |

---

## 1. 机器指纹（基准机）

| 字段         | 值         | 备注                                                      |
| ------------ | ---------- | --------------------------------------------------------- |
| **OS**       | 待本机标定 | 含版本（例：Windows 11 23H2 / macOS 14.x / Ubuntu 22.04） |
| **CPU**      | 待本机标定 | 型号 + 逻辑核数                                           |
| **RAM**      | 待本机标定 | 物理内存总量                                              |
| **WebView**  | 待本机标定 | Tauri/WebView2 / WKWebView 版本字符串                     |
| **标定人**   | 待本机标定 | —                                                         |
| **标定日期** | 待本机标定 | ISO `YYYY-MM-DD`                                          |
| **标定提交** | 待本机标定 | git SHA（数值初值写入时）                                 |

> 未填齐指纹前，**数值门**一律视为未生效；结构门不受影响。

---

## 2. 结构门（可立即验收 · 无数值也可红/绿）

对齐 H3：**无数值也可合入**；下列项为硬门禁。

| ID                      | 结构断言                          | 默认/契约                                                                                                                              | 代码锚点（可执行）                                                                              | 状态        |
| ----------------------- | --------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- | ----------- |
| **S-HOT / A-MEM-01**    | 热集活动 YText 上界               | **默认 ≤ 512**（可配置）                                                                                                               | `crates/conex-doc-collab`：`DEFAULT_MAX_HOT`；`DocSession::text_max_hot()` / `text_hot_count()` | 常量 + 单测 |
| **S-DOM / A-PERF-01**   | 挂载 DOM 块数 ≤ 窗口上界          | 可见 + **overscan** + pin 并集；默认 overscan **12** 块（建议区间 8～20）；挂载硬上界 **`MAX_MOUNTED_DOM_BLOCKS = 256`**（≤ 热集 512） | `packages/editor-kit`：`DEFAULT_OVERSCAN_BLOCKS` / `MAX_MOUNTED_DOM_BLOCKS` + `queryViewport`   | 常量 + 单测 |
| **S-MERGE / A-PERF-06** | merge **不在** UI 主线程          | Agent/远端批合入走 RS/worker 侧；UI 仅消费投影 Diff                                                                                    | 架构契约（`01`/`04`/`08`）；实现波接线后加线程归属断言                                          | 契约门      |
| **S-REMONT / A-IME-07** | 默认路径 `fullRemountCount === 0` | 正常键入/增量 patch **禁止**整树 remount；`fullRebuild` 仅灾难逃逸                                                                     | `packages/editor-kit`：`applyProjectionDiff` + 既有单测                                         | 单测绿      |
| **S-SNAP / A-PERF-09**  | 击键写放大：只 APPEND update      | **禁止**每键全量 snapshot                                                                                                              | 文档心 persistence / text update 路径                                                           | 契约门      |

### 2.1 overscan 写清

| 参数                      | 默认                        | 建议区间           | 说明                                              |
| ------------------------- | --------------------------- | ------------------ | ------------------------------------------------- |
| `DEFAULT_OVERSCAN_BLOCKS` | **12**                      | 8～20（D5 §3.3.3） | 前后各扩展 N **块**（非像素）                     |
| 像素 overscan 等价        | —                           | 视口高度 0.5～1.0× | 产品层可换算；结构门以 **块数上界** 为准          |
| pin 并集                  | 焦点 + composing + 选区端点 | —                  | pin 可短暂使挂载 > 纯窗口；**不得**因此取消窗口化 |

### 2.2 结构门验收清单（合入 PR 可勾）

- [ ] `DEFAULT_MAX_HOT == 512` 且 `DocSession::new` 默认 `text_max_hot() == 512`
- [ ] 活动热实例在非「全 pin」路径下 `hot_count ≤ max_hot`（A-MEM-01）
- [ ] 典型视口 + 默认 overscan 的 `queryViewport(...).count ≤ MAX_MOUNTED_DOM_BLOCKS`
- [ ] 默认 diff 路径 `fullRemountCount === 0`（A-IME-07）
- [ ] 无「每键全量 snapshot」默认路径（A-PERF-09）
- [ ] merge/批 apply 不阻塞 UI 主线程（A-PERF-06；接线后测）

---

## 3. 数值门表格（初值 **TBD · 未标定**）

> 维度对齐 D7 §5.9 `A-PERF-01…11`；**维度不可删**。
> 单位：时间 ms；jank 代理见下表注释。全部 **TBD** 直至本机标定写入并 bump rev。

### 3.1 打开文档（可交互时间）

| 场景                                   | 指标           | p50 预算          | p95 预算          | 结构伴随断言                   | 标定状态 |
| -------------------------------------- | -------------- | ----------------- | ----------------- | ------------------------------ | -------- |
| 打开 **1k** 块                         | 至可交互 (TTI) | **TBD（未标定）** | **TBD（未标定）** | DOM ≤ 窗口上界；热 YText ≤ 512 | 未标定   |
| 打开 **10k** 块                        | 至可交互 (TTI) | **TBD（未标定）** | **TBD（未标定）** | 同上                           | 未标定   |
| 打开 **100k** 块（A-PERF-01 目标规模） | 至可交互 (TTI) | **TBD（未标定）** | **TBD（未标定）** | 同上；禁止全量 CE 同阶挂载     | 未标定   |

### 3.2 键入 / IME 延迟（A-PERF-03）

| 场景                       | 指标                 | p50 预算          | p95 预算          | 结构伴随断言           | 标定状态 |
| -------------------------- | -------------------- | ----------------- | ----------------- | ---------------------- | -------- |
| 稳态拉丁键入               | 击键→画面延迟        | **TBD（未标定）** | **TBD（未标定）** | `fullRemountCount===0` | 未标定   |
| IME 合成（中日韩矩阵抽样） | composition 路径延迟 | **TBD（未标定）** | **TBD（未标定）** | pin + A-IME 矩阵       | 未标定   |

### 3.3 滚动 jank 代理（A-PERF-02）

| 场景                    | 代理指标                                        | p50 预算          | p95 预算          | 结构伴随断言                        | 标定状态 |
| ----------------------- | ----------------------------------------------- | ----------------- | ----------------- | ----------------------------------- | -------- |
| 顶↔底连续滚动（1k 块）  | 长任务 (>50ms) 次数 / 10s **或** `rAF` 间隔 p95 | **TBD（未标定）** | **TBD（未标定）** | 窗口节点有界；index 误差 ≤ 1–2 块高 | 未标定   |
| 顶↔底连续滚动（10k 块） | 同上                                            | **TBD（未标定）** | **TBD（未标定）** | 同上                                | 未标定   |
| 合成中滚动（A-PERF-08） | 同上 + pin 不丢                                 | **TBD（未标定）** | **TBD（未标定）** | A-IME-03                            | 未标定   |

> **jank 代理选取说明**：在无稳定 FPS API 的 WebView 上，优先 **(1) Performance longtask 计数** 与 **(2) rAF 间隔分布**；两者写入本表时须注明采集脚本路径。禁止仅用主观「手感」合入数值门。

### 3.4 其他 A-PERF 维度（占位，维度不删）

| ID        | 维度                                 | 数值预算          | 标定状态 |
| --------- | ------------------------------------ | ----------------- | -------- |
| A-PERF-04 | 大纲/搜索跳转末块                    | **TBD（未标定）** | 未标定   |
| A-PERF-05 | N 远端选区 + 本地输入                | **TBD（未标定）** | 未标定   |
| A-PERF-06 | Agent 千次 patch（UI 收敛 / 可取消） | **TBD（未标定）** | 未标定   |
| A-PERF-07 | 内存稳态（堆与窗口相关）             | **TBD（未标定）** | 未标定   |
| A-PERF-09 | 击键写放大（update 字节/键）         | **TBD（未标定）** | 未标定   |
| A-PERF-10 | 搜索（索引计划，非默认全表 LIKE）    | **TBD（未标定）** | 未标定   |
| A-PERF-11 | 附件 blob 不进 snapshot 热路径       | **TBD（未标定）** | 未标定   |

---

## 4. 退化触发 · A-PERF-DEG-01

| 项           | 规则                                                                                           |
| ------------ | ---------------------------------------------------------------------------------------------- |
| **ID**       | **A-PERF-DEG-01**                                                                              |
| **比较基**   | 本文件已标定数值（同 `perf_baseline_rev` + 同机器指纹族）                                      |
| **触发条件** | 相对 baseline：**p95 恶化 ≥ 2×** **或** **p50 恶化 ≥ 1.5×**，且在主分支 **连续 3 次** 实测成立 |
| **动作**     | 强制 **A-SWAP 评估**（非仅「用例红」）；评估记录挂 PR / 治理文档，不得静默降预算蒙混           |
| **未标定期** | 数值全 TBD 时 **不** 触发 DEG 数值比较；结构门失败仍按普通红处理                               |
| **禁止**     | 为避免 DEG 而压低 baseline 初值；标定须真实机器指纹                                            |

### 4.1 退化观测字段（CI / 本地跑数落盘模板）

```text
metric_id: <e.g. open_10k_tti | type_latency | scroll_raf_p95>
baseline_rev: <perf_baseline_rev>
run_n: 1|2|3
p50_ms: ...
p95_ms: ...
ratio_p50: p50 / baseline_p50
ratio_p95: p95 / baseline_p95
machine_fingerprint: <os|cpu|ram|webview>
verdict: ok | watch | A-PERF-DEG-01
```

---

## 5. 与代码常量对照（结构门源）

| 常量                          | 值         | 包/crate                                    |
| ----------------------------- | ---------- | ------------------------------------------- |
| `DEFAULT_MAX_HOT`             | `512`      | `conex-doc-collab`（H1 / A-MEM-01）         |
| `DEFAULT_OVERSCAN_BLOCKS`     | `12`       | `@crish/editor-kit`                         |
| `OVERSCAN_BLOCKS_MIN` / `MAX` | `8` / `20` | `@crish/editor-kit`                         |
| `MAX_MOUNTED_DOM_BLOCKS`      | `256`      | `@crish/editor-kit`（A-PERF 结构 DOM 上界） |
| `fullRemountCount` 默认路径   | `0`        | `@crish/editor-kit` `applyProjectionDiff`   |

---

## 6. 修订历史

| rev   | 日期       | 说明                                                                             |
| ----- | ---------- | -------------------------------------------------------------------------------- |
| **0** | 2026-08-11 | W6-C：结构门骨架 + 数值 TBD 占位 + A-PERF-DEG-01 退化规则入库                    |
| **0** | 2026-08-11 | Round9：数值门测量脚手架（`#[ignore]` + `perf:block-workspace`）；数值仍 **TBD** |

---

## 7. 测量脚手架 · 如何跑 · 如何 **人工** 回填

> **铁律**：脚手架 **只打印** JSON 行；**禁止** 任何脚本自动把本文件的 `TBD（未标定）` 改成数字或宣称「数值门通过」。
> 标定 = 人在基准机上跑数 → 核对机器指纹 → 手写填表 → bump `perf_baseline_rev`（若指纹/阈值变更）。

### 7.1 入口（CI **默认不跑**）

| 路径                                          | 命令                                              | 默认是否进 CI                          |
| --------------------------------------------- | ------------------------------------------------- | -------------------------------------- |
| **HeightMap 查询**（轻量）                    | `npm run perf:block-workspace`                    | **否**（单独 npm script，未挂 ci.yml） |
| **DocSession 打开 N 块**（Rust，`#[ignore]`） | 见下；或 `npm run perf:block-workspace -- --rust` | **否**（`#[ignore]` + release 本机）   |

```bash
# A) HeightMap 1k 查询（默认 n=1000）
npm run perf:block-workspace

# B) HeightMap 10k
npm run perf:block-workspace -- --n 10000

# C) 同时跑 Rust open_nk_blocks（需本机 cargo；--release）
npm run perf:block-workspace -- --rust
# 或仅 Rust：
npm run perf:block-workspace -- --rust-only --n 1000

# D) 直接 cargo（等价于 C 的 Rust 段）
cargo test -p conex-doc-collab --test perf_open_nk_blocks --release -- --ignored --nocapture
# 10k（PowerShell）：
$env:PERF_N=10000; cargo test -p conex-doc-collab --test perf_open_nk_blocks --release -- --ignored --nocapture
```

| 环境变量 / CLI             | 默认    | 含义                     |
| -------------------------- | ------- | ------------------------ |
| `PERF_N` / `--n`           | `1000`  | 块数 / HeightMap 槽数    |
| `PERF_ITERS` / `--iters`   | `7`     | 计时样本数（算 p50/p95） |
| `PERF_WARMUP` / `--warmup` | `1`     | 热身轮（不计时）         |
| `--queries`                | `10000` | HeightMap 每轮查询次数   |

### 7.2 输出格式（JSON 行）

每指标 **一行** JSON（stdout），字段对齐 H3 / §4.1：

```json
{
  "metric": "open_nk_blocks",
  "n": 1000,
  "p50_ms": 12.345,
  "p95_ms": 15.678,
  "os": "windows",
  "arch": "x86_64",
  "cpu_logical": 16,
  "note": "manual backfill only; do not auto-rewrite TBD in perf-baseline.md"
}
```

| `metric`          | 含义                                                                       | 建议回填位置                                 |
| ----------------- | -------------------------------------------------------------------------- | -------------------------------------------- |
| `open_nk_blocks`  | DocSession 批量 insert N 根块 wall time（A-PERF-01 **数据层代理**，无 UI） | §3.1 打开 1k/10k                             |
| `heightmap_query` | HeightMap `offsetOf`+`indexAt` 查询墙钟（虚拟化路径代理）                  | §3.3 / 结构伴随备忘；**不是** 滚动 jank 终值 |

### 7.3 人工回填清单（数值门生效前必做）

1. 在 **基准机** 上用 **release** 跑 §7.1（至少 1k；自愿 10k）。
2. 把输出中的 `os` / CPU / RAM / WebView 写入 **§1 机器指纹**（未填齐则数值门不生效）。
3. 将 `p50_ms` / `p95_ms` **手写** 进 §3.x 对应单元格；标定状态改为「已标定」；登记 `标定日期` / `标定提交`（git SHA）。
4. 指纹或阈值变更 → **bump** `perf_baseline_rev` 并在 §6 写 diff 原因。
5. **禁止**：为「好看」压低预算；禁止未标定就勾选「数值门通过」；禁止脚本 PR 只改 TBD→假数字。
6. 标定后的退化比较走 **A-PERF-DEG-01**（§4）：p95≥2× 或 p50≥1.5× 连续 3 次 → 强制 A-SWAP 评估。

### 7.4 代码锚点

| 资产           | 路径                                                                            |
| -------------- | ------------------------------------------------------------------------------- |
| Rust ignore 测 | `crates/conex-doc-collab/tests/perf_open_nk_blocks.rs`（`perf_open_nk_blocks`） |
| Node/tsx 编排  | `scripts/block-workspace-perf.mjs`                                              |
| npm script     | `package.json` → `perf:block-workspace`                                         |
| HeightMap      | `packages/editor-kit/src/viewport/HeightMap.ts`                                 |
| 退化 ID        | `conex_doc_collab::a_perf::A_PERF_DEG_01`                                       |
