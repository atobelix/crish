# detail-D0 · 预算 SSOT 与防御骨架

> **战役**：performance-fix  
> **维度**：D0（92 §4 表首行 · Layer-B 最前置）  
> **案底合并**：01 T-L0-A + 02 D0 + 03 D10 + 04 CONV-3/D-DF 交界（仅命名空间，不接门禁）+ 06 U-BUDGET  
> **裁决依据**：`92-修复总方案.md` §2 INV-8、§3 CFL-01、§5 依赖序、§9 模板；评审 01 CFL-01/OVL-01/M1/F6、评审 02 MUST-1/AC-1  
> **创建**：2026-09-13  
> **状态**：分维详案稿（执行前须 ≥1 份 `review-detail-*` 通过）  
> **禁止**：git commit；伪 SSOT；三源并行；本维改业务接线大文件行为  

---

## 0. 本维在 92 中的位置与硬边界

| 项 | 裁决 |
| -- | ---- |
| 效果锁 | INV-8：性能数字只出现在**单一预算源**；INV-5 前提「全链同预算常量」由本维供数 |
| SoT | **Rust**：`crates/conex-shared/src/perf_budget.rs`（全仓 re-export 语义） |
| TS 镜像 | `apps/crish-desktop/src/api/perfBudgets.ts`（手写镜像同一语义常量表；注释指向 Rust 为 SoT） |
| 门禁 | `scripts/check-perf-budgets.mjs`（扫描业务源；终态 fail 级并进主链） |
| 启动 JSON | **禁止**长期独立 `scripts/perf-budgets.json` 作第三真源；若启动图谱需 JSON，文件名 **`startup-graph-budget.json` 仅服务 startup 门禁命名空间**（主责 **D9**），数值须经迁移进入 `perf_budget` 后删除 JSON 分叉 |
| 不改业务接线 | 默认 `Some(output_budget)`、G8 正常路径、store hardCap 生效、moka builder 改容量语义、startup fail+CI —— **全部不属 D0**，归 D1/D2/D5/D9 等 |
| 本维允许的调用点改动 | **仅机械 re-export / import 替换**（数值与行为不变）；禁止「顺手」改默认值、阈值、控制流 |

**伪 SSOT 红线（评审 02 MUST-1 / F6）**：三脚本各绿、魔数仍散落 = 假完成；`perf_budget` / `perfBudgets.ts` / `perf-budgets.json` **不得**以「最终态」并存为三套权威。

---

## 1. 做什么

### 1.1 新建 Rust SoT：`perf_budget.rs`

路径：`crates/conex-shared/src/perf_budget.rs`（`lib.rs` 增 `pub mod perf_budget;` + 必要 `pub use`）。

**收录原则**：

1. **同名同语义**：迁入业务本地 `const` 定义，**默认保持现值**（本维不调阈值；改值走后续接线票 + 变更记录）。
2. **按命名空间分节**，每节有中文文档注释（语义 / 单位 / 现源锚点 / 接线主责维）。
3. **预留常量可建，但标注「解锁前禁止生产读取」**（对齐 01 delta 合并窗纪律）。
4. **不做行为逻辑**；纯 `pub const` + 可选文档用类型别名。

**D0 迁入表（第一批 · 定义位置收敛）**：

| 建议常量名 | 语义 | 现值（迁移时锁定） | 现定义锚点 | 后续接线主责（本维不接） |
| -- | -- | -- | -- | -- |
| `SHELL_PREVIEW_HEAD_BYTES` | shell 预览头 | `24 * 1024` | `agent-tools/…/shell_output.rs:17` | D2 |
| `SHELL_PREVIEW_TAIL_BYTES` | shell 预览尾 | `24 * 1024` | `shell_output.rs:19` | D2 |
| `TOOL_INLINE_BYTES_DEFAULT` | 工具 inline 正文默认 | `24_000` | `agent-tools/…/output.rs:17` `DEFAULT_INLINE_BYTES` | D1/D2 |
| `SHELL_MAX_OUTPUT_BYTES_DEFAULT` | shell 输出默认上限 | `200_000` | `agent-tools/…/tools/mod.rs:157` | D1/D2 |
| `READ_FILE_MAX_BYTES_DEFAULT` | read_file 默认 maxBytes | `256_000` | `agent-tools/…/tools/fs.rs:18` | D2 |
| `SEARCH_MAX_FILE_BYTES_DEFAULT` | search 单文件上限 | `512_000` | `agent-tools/…/tools/search.rs:21` | D2 |
| `G8_TOOL_OUTPUT_MAX_LINES_DEFAULT` | G8 行阈值 | `2_000` | `conex-compaction/…/tool_output.rs:25` | D10（U-G8） |
| `G8_TOOL_OUTPUT_MAX_BYTES_DEFAULT` | G8 字节阈值 | `50 * 1024` | `tool_output.rs:27` | D10 |
| `TOOL_OUTPUT_BUDGET_BYTES_DEFAULT` | 执行器默认输出预算 | **新建**（02 建议 64KiB；定稿值由实现轮对照 10-T4 与现有 `None` 行为写死并进变更表） | 新建（现默认 `None`） | **D1**（`run_launch` 默认 `Some`） |
| `TOOL_OUTPUT_STORE_HARD_CAP` | 前端 store 写入 hardCap | 与展示对齐量级（03：默认 256KB 量级；**数值与 FE 镜像同表**） | 新建 | D5 |
| `TOOL_OUTPUT_LINE_CAP` / `TOOL_OUTPUT_BYTE_CAP` | 前端展示裁切 | `2000` / `256 * 1024` | `ToolCallOutput.tsx:9-10` | D0 机械迁；展示逻辑不改 |
| `PTY_HISTORY_MAX_BYTES` | PTY 环形缓冲 | `256 * 1024` | `ptySessionApi.ts:52` | D0 机械迁 |
| `SESSION_HYDRATE_KEEP_K` | 常驻已水合会话数 | 03 建议默认 `3`（若现场已有 K 则以现场为准登记） | 新建 / 现场 | D5 |
| `MARKDOWN_CACHE_BUDGET_BYTES` 等前端缓存预算 | FE 内存缓存字节 | 见 `packages/shared-utils/src/bounds.ts:28-43` | bounds.ts | 见 §1.4 · **禁止在 apps 再写第二份数值** |
| `RUST_MARKDOWN_CACHE_BUDGET_BYTES` | Rust moka 字节预算常量 | `32 * 1024 * 1024` | `conex-markdown/…/cache.rs:13` `CACHE_BUDGET_BYTES` | **D1/06 U3** 仅接 builder；定义迁入 SoT |
| `RUST_MARKDOWN_CACHE_ENTRY_MAX_BYTES` | 单条目上限 | `1024 * 1024` | `cache.rs:16` | 同上 |
| `STARTUP_ENTRY_BUDGET_KB` | entry JS 软/过渡预算 | `520`（脚本现 `DEFAULT_BUDGET_KB`） | `check-startup-budget.mjs:44` | **D9** fail/冻结；D0 只登记数值进 SoT/镜像命名空间 |
| `STARTUP_STATIC_GRAPH_BUDGET_KB_TRANSITION` | 静态图过渡 fail 阈值 | 按 04/92：**1800**（过渡）→ 断边后 **900** 冻结（两个常量分列） | 04 D-GT；脚本尚未落地数值 | **D9** 实现 fail |
| `EVENT_BUFFER_SOFT_WATERMARK` / `EVENT_BUFFER_HARD_CAP` | 审计/事件缓冲水位 | 以 `buffer.rs` / 09 现场数为准实现轮登记 | `apps/agent-workbench/…/buffer.rs` 等 | D1（有界化） |
| `FS_LIST_DIRECTORY_DEFAULT_LIMIT` | list 分页默认 | 建议 `2000`（02；实现轮对照现网） | 新建 | D1/D2 |
| `PE02_MERGE_WINDOW_*`（预留） | delta 合并窗 | 占位常量 + `#[doc] 禁止生产读取` | 新建 | **T2 / PE-02 会签后**才允许消费 |

> 表内「现值」以实现轮 `rg` 复核为准；发现多处同语义不同值时：**同语义单常量 + 注明「历史分叉由接线票统一」**，禁止为迁就分叉在 SoT 造双常量冒充收敛（分列仅当语义真不同：如 G8 双阈值 vs `output_budget_bytes`）。

**第二层语义分列（禁止错误合并）**：

| 层 | 常量族 | 说明 |
| -- | -- | -- |
| 事件载荷预算 | `TOOL_OUTPUT_BUDGET_BYTES_DEFAULT` / `output_budget_bytes` | 进事件/上下文的工具输出大小 |
| G8 conversation 截断 | `G8_TOOL_OUTPUT_MAX_LINES/BYTES` | 行+字节双阈值 + 留痕（13-H3） |
| shell 累积/spill | `SHELL_*` + 后续 `SHELL_ACCUM_HARD_CAP_FACTOR` | 内存/spill 策略，非 G8 |
| 展示/PTY/store cap | `TOOL_OUTPUT_LINE/BYTE_CAP`、`PTY_HISTORY_*`、`TOOL_OUTPUT_STORE_HARD_CAP` | 前端展示与存储上限，可与引擎**同数值来源登记**，但**常量名分列** |
| 启动体积 | `STARTUP_*` | 仅 D9 门禁消费；不进业务 import |

### 1.2 新建 TS 镜像：`perfBudgets.ts`

路径：`apps/crish-desktop/src/api/perfBudgets.ts`。

1. 导出与前端相关的**同名**常量（及 FE 专属：LINE/BYTE_CAP、PTY、HARD_CAP、KEEP_K、缓存预算转口等）。
2. 文件头注释固定格式：

```text
// perfBudgets.ts — 前端预算镜像
// SoT: crates/conex-shared/src/perf_budget.rs（数值以 Rust 为准）
// 本文件禁止成为第三真源：改数值先改 perf_budget，再同步本镜像并跑 check-perf-budgets
```

3. **禁止**在业务 TS/TSX 再定义预算字面量（机械迁入后只 `import { … } from '@/api/perfBudgets'`）。
4. 布尔语义开关（如 03 `PTY_HIDDEN_WRITE_PAUSE = true`）可进本文件，仍受「唯一定义位置」约束。

### 1.3 新建防御脚本：`check-perf-budgets.mjs`

路径：`scripts/check-perf-budgets.mjs`。

| 规格 | 内容 |
| -- | ---- |
| 模式 | 对齐仓内 SSOT 门禁范式（参考 `check-token-ssot` / `check-color-ssot`：硬失败 + 可选棘轮） |
| 扫描根 | `crates/**`（排除 `target/`、`tests/fixture*`）、`apps/crish-desktop/src`、`apps/agent-workbench/src-tauri/src`（可配置） |
| 硬失败（终态） | ① 业务文件在扫描模式下出现**已登记预算魔数**且**未**从 SoT/镜像 re-export；② 同一语义常量在 SoT 之外出现**定义型** `const`（非 re-export）；③ 第三真源：存在活跃的 `scripts/perf-budgets.json` 被业务/门禁当权威读取（或文件名回潮） |
| 允许 | 单元测试 fixture 内字面量；`perf_budget.rs` / `perfBudgets.ts` 自身；`bounds.ts` 在完成 §1.4 收敛前的**短暂登记基线**（须 `--update` 基线且只降不升） |
| 输出契约 | 每条 FAIL：`违反项 · 路径:行号 · 当前值 · 应从何处 import · 正确做法` |
| 接入 | 增加根 `package.json` script：`"check:perf-budgets": "node scripts/check-perf-budgets.mjs"`；**加入 `check:desktop` 链**（在全量魔数迁完后保持 fail；若必须短暂 warn，须附**删除日期**与 issue 登记——评审 02 AC-1） |
| CLI | `--update` 基线；`--list`；`--guide <const>` 使用说明 |

### 1.4 `shared-utils/bounds.ts` 与 SoT 关系（防伪 SSOT）

现状：`packages/shared-utils/src/bounds.ts` 已是 **前端缓存字节预算的包内真源**（MARKDOWN/HIGHLIGHT/DIFF/…/TOTAL_MEMORY_BUDGET），被 `markdownCache` / `codeHighlight` 等消费。

D0 裁决（避免 apps 与 packages 双写）：

1. **包内缓存预算数值**继续由 `bounds.ts` 作为 **package 导出面**（包依赖方向：apps → shared-utils；**禁止** shared-utils 反向 import apps）。
2. `perfBudgets.ts` **re-export** `bounds.ts` 中缓存族常量（或薄封装转口），保证应用侧「只认 perfBudgets」的纪律。
3. `perf_budget.rs` 登记 **Rust 侧** cache 预算与「FE 缓存族语义对照表」注释；跨端**不要求**逐字节相等（引擎 32MiB vs FE 分域预算语义不同），但 **定义位置唯一**、同端禁止第二份。
4. D0 完成后：`rg` 不得在 `apps/crish-desktop/src/**` 再出现 `16 * 1024 * 1024` 等缓存预算字面量定义（须 import 自 perfBudgets/bounds）。

### 1.5 机械迁点清单（只改 import，不改行为）

**Rust（每迁一个：删本地 `const`，改为 `use conex_shared::perf_budget::…` 或 crate 内 re-export）**：

- `crates/agent-tools/src/tools/shell_output.rs`（PREVIEW_HEAD/TAIL）
- `crates/agent-tools/src/output.rs`（DEFAULT_INLINE_BYTES → `TOOL_INLINE_BYTES_DEFAULT`）
- `crates/agent-tools/src/tools/mod.rs`（shell max output 默认）
- `crates/agent-tools/src/tools/fs.rs`、`search.rs`
- `crates/conex-compaction/src/tool_output.rs`（G8 默认双阈值）
- `crates/conex-markdown/src/cache.rs`（CACHE_BUDGET_BYTES / ENTRY_MAX：**仅定义改 re-export**；`max_capacity(CACHE_MAX_ENTRIES)` 与 weigher 错位 **不动** → 归 09-M1 / 06 U3）

**前端（机械改 import）**：

- `ToolCallOutput.tsx`（LINE/BYTE_CAP）
- `ptySessionApi.ts`（PTY_HISTORY_MAX_BYTES）
- `bounds.ts` 消费点保持；`perfBudgets.ts` 转口后应用新 import 优先走 perfBudgets

**明确不在本维机械迁点内**（避免撞文件域）：

- `orchestrator/events.rs`、`run_launch`、`executing_tools`、`sessionStore`、`streaming` 大文件 —— 接线归 D1/D2/D4/D5；它们在接线票中 **import 本维常量**，不要求 D0 预先改这些大文件。

### 1.6 变更表与镜像同步纪律

- `perf_budget.rs` 与 `perfBudgets.ts` **同 PR 或紧邻 PR**（CFL-01：两侧互为镜像，禁止第三侧魔数）。
- 每个常量在 Rust 侧 `///` 注释含：`镜像: perfBudgets.NAME` 或 `FE: bounds.ts` 或 `门禁: D9 STARTUP_*`。
- 镜像 PR 必须跑：`cargo test -p conex-shared` + `node scripts/check-perf-budgets.mjs` + 前端 typecheck 相关工程。

---

## 2. 删什么 + 负向断言

| # | 删除/消灭物 | 位置/形态 | 负向断言（验收探针） |
| -- | -- | -- | -- |
| D0-DEL-1 | 阻塞/执行面本地预算 `const` 定义 | 02 DEL-11 全表 | 业务 `.rs` 中「定义型」预算 const 命中 = 0（fixture 除外）；脚本硬失败 |
| D0-DEL-2 | 前端 LINE/BYTE/PTY 本地定义 | `ToolCallOutput.tsx:9-10`、`ptySessionApi.ts:52` | 上述定义符号在组件内不再 `export const … = <字面量>`；仅 re-export 或 import |
| D0-DEL-3 | 「三源并行」路径本身 | 新建 `perf-budgets.json` 作全局 SoT 的方案路径 | 仓库**不存在**被业务读取的 `scripts/perf-budgets.json`；若临时存在则仅允许 `startup-graph-budget.json` 且标注 D9 命名空间 |
| D0-DEL-4 | 各案分叉的「各建各的预算脚本骨架」 | 01/03/04 重复 `check-perf-budgets` 草案 | 仅 **一份** `scripts/check-perf-budgets.mjs`；无 `check-perf-budgets-fe` / `check-budget-json` 并行物 |
| D0-DEL-5 | 语义相同魔数散落定义（机械迁后） | 实现轮 `rg` 清单登记 | 负产出表：迁移前后 `rg -n` 命中清单 diff，定义点归零 |
| D0-DEL-6 | （流程删除）「warn 永久化」口子 | 脚本默认模式 | 终态脚本在 `check:desktop` 为 **fail**；无「永远 warning」配置开关作为默认 |

**负产出最小集（执行轮 PR 必附）**：

1. 本地定义删除 ≥ 表 D0-DEL-1∪2 登记项；  
2. 路径：预算数字定义源 **N→1**（Rust SoT + FE 镜像/包内唯一转口）；  
3. 脚本存在且对**故意植入**的魔数夹具 **exit 1**（红灯演练记录）。

**本维不删**：`buffer.rs` 容量逻辑、moka builder 错位、G8 调用点、startup 脚本本身 —— 只保证其数字进入 SoT 登记或由后续维消费。

---

## 3. 依赖与逻辑序

```text
D0-A  perf_budget.rs + lib 导出 + 常量表（含预留标注）
D0-B  perfBudgets.ts 镜像 + bounds.ts 转口纪律
D0-C  check-perf-budgets.mjs + package.json script
D0-D  机械 re-export 迁点（Rust 子集 → FE 子集，可并行两队）
D0-E  接入 check:desktop（fail）+ 红灯演练
    ↓
D1 / D2 / D5 / D9 …  消费常量做行为接线（禁止再发明数字）
```

**序约束**：

1. **D0 整体为最前置**（92 §5；无 SSOT 则后续 hardCap/截断/门禁各自发明数字）。  
2. D0 **可与** D1(NoPersist)/D2(Gatekeeper) **并行**——文件域不相交；D1 等**不得**在 D0 落地前把新魔数写死在业务文件（应临时引用将存在路径或暂缓该常量）。  
3. **先定义后迁点**：先有 SoT/镜像/脚本，再机械迁；迁点 PR 不做行为变更。  
4. **startup 门禁 fail/CI**：D0 只供数与命名空间约定；**实现归 D9**（CFL-07）。  
5. **PE-02 合并窗常量**：可进 SoT 占位；**解锁前生产 0 引用**（门禁可检「PE02_* 被业务 import」= fail）。

---

## 4. 唯一文件域（与并行维互斥）

### 4.1 D0 写域（主责，同轮独占）

| 路径 | 说明 |
| -- | ---- |
| `crates/conex-shared/src/perf_budget.rs` | **新建** SoT |
| `crates/conex-shared/src/lib.rs` | `mod` / re-export |
| `apps/crish-desktop/src/api/perfBudgets.ts` | **新建** FE 镜像 |
| `scripts/check-perf-budgets.mjs` | **新建** 防御 |
| `package.json` | **仅**增加 `check:perf-budgets` script；`check:desktop` 串接点在 D0-E（最小 diff，不改 D9 的 startup 行） |
| `packages/shared-utils/src/bounds.ts` | **仅**允许：注释指向 SoT/镜像、必要的 re-export 整理；**不改数值**（数值变更须另票） |
| 机械迁点小文件 | 见 §1.5 列表；**仅** const→import |
| （可选）`docs/performance-audit/materials/plans/detail-D0-预算SSOT.md` 修订 | 本详案 |

### 4.2 禁止写域（并行维）

| 维 | 禁止 D0 触碰的原因 |
| -- | -- |
| D1 | `orchestrator/events.rs`、`run_launch`、`executing_tools`、默认 `Some` 接线 |
| D2 | `fs_commands`、`SharedGatekeeper`、`windowed_read`、browser/computer |
| D3/D4 | `conex-db/**`、`sessionStore` persist |
| D5 | 水合/驱逐、store hardCap **生效逻辑** |
| D6–D8 | 传输/渲染/终端 |
| D9 | `check-startup-budget.mjs`、`check-dist.mjs`、`ci.yml`、`startup-graph-budget.json`、静态图 fail |
| D10 | G8 调用点、`compaction_dispatch` |
| D11–D13 | 契约/relay/观测脚本族 |

### 4.3 与并行维冲突点（汇报用）

| 冲突点 | 维 | 消解 |
| -- | -- | -- |
| `package.json` / CI 串接 | D9、D13 | D0 只加 `check:perf-budgets` 一行 script + 可选 `check:desktop` 串联；**不改** `check:startup-budget` 与 ci.yml job |
| `cache.rs` 定义 | 09-M1 实现（D1 侧） | D0 只 re-export 常量；builder 与测试语义归 U3 |
| G8 常量 | D10 | D0 供数；U-G8 改调用点 |
| 启动阈值 520/1800/900 | D9 | 数值进 SoT/`startup-*` 命名空间；脚本语义 fail 化不属 D0 |
| `ToolCallOutput.tsx` | D5/D7 若改组件 | D0 仅 cap 符号来源；若同 PR 冲突，FE 机械迁改用独立小 PR 先合 |
| `bounds.ts` 分域预算 | D5 内存驱逐 | 不改数值与驱逐逻辑 |

---

## 5. 路径 N→M

| 概念 | 现 N | 目 M | 说明 |
| -- | -- | -- | -- |
| 预算数字定义源 | **≥3 权威叙事 + ≥10 本地 const**（Rust 本地 + FE 本地 + bounds + 脚本内 DEFAULT +（禁建）json） | **1 SoT（perf_budget）+ 1 FE 镜像面（perfBudgets ⊃ bounds 转口）+ 1 门禁脚本** | 06/02 CON-5：定义位置唯一，值可分列语义 |
| 执行/工具字节账 | shell 200KB / read 256KB / search 512KB / inline 24KB / G8 50KB / output_budget None 各自定义 | 全部 **import SoT**；行为接线分维 | D0 只完成定义收敛 |
| 前端输出 cap | 组件字面量 2000/256KB + PTY 256KB | `perfBudgets` 唯一 import | 展示逻辑不变 |
| 启动预算数字 | 脚本 `DEFAULT_BUDGET_KB=520` + （未来）1800/900 仅脚本/env | SoT `STARTUP_*` +（可选）`startup-graph-budget.json` **仅 D9 读** | 消灭「第三真源」 |
| 检查脚本 | 无统一 perf 魔数门禁 | `check-perf-budgets` **唯一** fail 门禁 | 与 startup-budget 职责表互不重复实现（D9 拥有图谱 fail） |

---

## 6. 验收

### 6.1 功能

- `cargo test -p conex-shared` 通过（模块编译 + 可选常量契约单测：如 `assert!(TOOL_OUTPUT_BUDGET_BYTES_DEFAULT > 0)` 或文档测试）。  
- 全仓 `cargo check --workspace` 不因 re-export 破坏。  
- 前端 typecheck：`@crish/crish-desktop` 及受影响 import。  
- **行为不变**：既有工具截断/PTY/展示单测全绿（数值未改）。

### 6.2 负产出

- [ ] `perf_budget.rs` 存在且为 Rust 预算定义唯一处（§1.5 迁点表勾选）。  
- [ ] `perfBudgets.ts` 存在且头部 SoT 注释完整。  
- [ ] `check-perf-budgets.mjs` 存在；对夹具魔数 **exit 1**；对干净树 **exit 0**。  
- [ ] 仓库无权威 `scripts/perf-budgets.json`；无第二套 check-perf-budgets 实现。  
- [ ] D0-DEL 表逐项勾选 + `rg` 清单附件。  
- [ ] PE02 预留常量若存在：业务 crate **0 引用**（脚本或单测断言）。

### 6.3 五端物证（D0 适配：触发/传输/介质/消费/负向）

| 端 | D0 物证 |
| -- | ---- |
| 触发 | `node scripts/check-perf-budgets.mjs` 可独立运行；植入魔数 → FAIL 输出含五元组 |
| 传输 | n/a（无 IPC 行为变更）→ 以「镜像与 SoT 同 PR/紧邻 PR」的 git 说明替代 |
| 介质 | 常量文件入库路径：`conex-shared/src/perf_budget.rs`、`perfBudgets.ts` |
| 消费 | D1/D2/D5 任务书约定 `use perf_budget::…` / `from '@/api/perfBudgets'`；本维 PR 附「消费方待接清单」不实现接线 |
| 负向 | `rg` 定义点=0；`check-perf-budgets` 红灯演练记录；无三源文件 |

### 6.4 与「接线完成」的切割声明

下列 **不得** 用 D0 完成冒充（假完成，评审 01 F6）：

- 工具输出默认仍 `None` 却宣称「输出预算已修」（→ D1）；  
- G8 仍仅 emergency（→ D10）；  
- startup 仍 warn 不 fail（→ D9）；  
- moka 仍 `max_capacity(2048)`（→ D1/U3）；  
- FE hardCap 未在 store 写入路径生效（→ D5）。

D0 完成定义 = **数字单一源 + 镜像 + 防御脚本 + 定义级迁移**，不是运行时收益关闭 10-T4/16-P1。

---

## 7. 防御脚本 / 守护测试增量

| 资产 | 动作 | 终态 |
| -- | -- | -- |
| `scripts/check-perf-budgets.mjs` | 新建 | fail 级；进 `check:desktop` |
| `package.json` `check:perf-budgets` | 新建 script | 文档与 FULL_CHECK 可引用 |
| （建议）`crates/conex-shared` 单测 | 常量互斥/分列冒烟（如 G8_BYTES ≠ STORE_HARD_CAP 若语义分列） | 防错误合并常量 |
| （建议）镜像漂移检 | 脚本解析 `perf_budget.rs` 与 `perfBudgets.ts` 同名导出数值一致性（允许 FE-only 子集） | 防「镜像只改一边」 |
| 夹具 | `tests` 或脚本 `fixtures/` 故意魔数 | 红灯演练 CI 步骤或本地记录 |
| **不新建** | 独立 `perf-budgets.json` 门禁 | 违反 CFL-01 |

与 D9 职责表：

| 脚本 | 拥有 | D0 不写 |
| -- | -- | -- |
| `check-perf-budgets.mjs` | D0 | — |
| `check-startup-budget.mjs` + CI strict | **D9** | 不改逻辑 |
| `startup-graph-budget.json` | **D9**（可选） | D0 只约定命名与「数值回迁 SoT 后删除」 |

---

## 8. 与 90 发现 ID 映射

| 90 ID | 本维关系 |
| -- | ---- |
| （根因簇）预算多源 / INV-8 | **D0 直接承载** |
| 10-T4 | **间接**：提供 `TOOL_OUTPUT_BUDGET_BYTES_DEFAULT`；默认 Some **不**在本维 |
| 03-R6 / 08-H3 | 间接：FE `TOOL_OUTPUT_STORE_HARD_CAP` / LINE/BYTE 进镜像；store 接线 D5 |
| 13-H3 | 间接：G8 默认双阈值进 SoT；正常路径接线 D10 |
| 09-M1 | 间接：Rust cache 预算常量进 SoT；builder **不**在本维 |
| 16-P1 / 16-P2 | 交界：`STARTUP_*` 数值登记；fail+CI **D9** |
| 11-B10 | 交界：CSS 预算若建常量进 SoT 命名空间；CSS 门禁实现 D9 |
| 08-H5 / 消息驱逐 K | 间接：`SESSION_HYDRATE_KEEP_K` 等进表；驱逐逻辑 D5 |
| EventBuffer 有界（09 正面 / 01 L1-C） | 间接：水位常量进 SoT；有界化 D1 |
| 全维「预算魔数 6+ 处 → SSOT」（92 §6 多路径行） | **D0 主责删除面** |

---

## 9. 任务拆分建议（执行轮四段式派发用）

| 任务 | 内容 | 不做什么 |
| -- | -- | -- |
| T-D0-1 SoT | 建 `perf_budget.rs` + lib + 单测 + 分节文档 | 不迁业务文件行为 |
| T-D0-2 镜像 | `perfBudgets.ts` + bounds 转口注释/导出 | 不改 bounds 数值 |
| T-D0-3 脚本 | `check-perf-budgets.mjs` + package.json script + 夹具红灯 | 不接 ci.yml（除非主控点名并避免与 D9 撞行） |
| T-D0-4 迁点-Rs | §1.5 Rust 列表 re-export | 不碰 events/run_launch/fs_commands 控制流 |
| T-D0-5 迁点-FE | ToolCallOutput / ptySessionApi | 不改截断 UI 逻辑 |
| T-D0-6 串接 | `check:desktop` 追加 + FULL_CHECK 文档句 | 不改 startup/CI job |

> 合并策略：T-D0-1→2 同 PR 优先；T-D0-3 可紧邻；迁点可 1–2 个子 Agent 并行（文件不相交）；T-D0-6 最后，避免脚本未绿卡死全链。

---

## 10. 明确不做（诚实边界）

| 项 | 原因 | 交接 |
| -- | -- | -- |
| `output_budget_bytes` 默认 Some | 行为变更 | D1 U-OUT-RS |
| G8 正常路径接线 | 调用点 | D10 |
| store hardCap 写入生效 | 行为 | D5 |
| moka `max_capacity(CACHE_BUDGET_BYTES)` | builder | D1/06 U3 |
| startup 静态图 fail + CI | 门禁语义 | **D9 唯一** |
| PE-02 合并 | T2 契约 | D11 会签后 |
| 阈值「优化调参」 | 效果锁/分维 | 另票 + SoT 改值记录 |
| 新建 `perf-budgets.json` 全局源 | **禁止** | — |

---

## 11. 验收检查单（主控打勾）

- [ ] SoT 路径 = `conex-shared/src/perf_budget.rs`  
- [ ] TS 镜像存在且注释指向 Rust  
- [ ] 无第三真源；无启动 JSON 全局化  
- [ ] `check-perf-budgets` fail + 演练  
- [ ] 机械迁点勾选；行为测试全绿  
- [ ] 未改 D1/D2/D5/D9/D10 业务接线文件行为  
- [ ] 与并行维冲突点已在 §4.3 登记  
- [ ] 未 git commit（主 Agent 统一提交）  

---

_分维详案 D0 · 唯一总案见 `docs/performance-audit/92-修复总方案.md` · 执行轮仅认 92 + 本详案（+评审修订）· 未 git commit_  
