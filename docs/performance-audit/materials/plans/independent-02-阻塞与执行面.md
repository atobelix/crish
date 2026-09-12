# independent-02 · 阻塞与执行面修复总计划（独立完整）

> **战役**：performance-audit → performance-fix  
> **创建**：2026-09-13  
> **视角**：阻塞与执行面——spawn_blocking 治理、Gatekeeper 共享、工具输出预算 Arc、compaction 同步摘要、shell/MCP 内存上界  
> **上游只读**：`00-性能审查总纲`、`90-发现清单索引`（396 项）、`01–16` 报告、`91-系统性修复总方案`（对照草稿，可推翻）、`docs/agent-roles/prompts/主控-全流程调度-v3.md`  
> **性质**：独立完整全局计划；**不与其它并行总案对齐、不抄 91 草稿**。91 仅作对照面，分歧见 §9。  
> **明确不谈**：工期、人天、人员安排、业务优先级。下列顺序 = 依赖拓扑序；列出的问题**逻辑同权**。

---

## 0. 效果锁（不可降级）

### 0.1 范围锁

本方案覆盖以下**高危 + 相关中危**发现，**不得缩水、不得降级为「简化版 / MVP」**：

| 发现 ID | 一句话 | 不可降级底线 |
| -- | -- | -- |
| 06-FS01 / 03-I3 | 壳 fs 三命令同步 `fn` | 三命令全部 `async` + `spawn_blocking`，**删除同步签名** |
| 06-FS02 | `read_file_content` 行限后仍可能读到字节上限 / 二次分配 | 窗口感知读 + 过程中维护行数 |
| 06-SR01 / 10-T1 | agent-tools 全部 fs/search 工具 async 内同步 `std::fs` | 全部重 IO 工具包 `spawn_blocking`，**不留同步直调路径** |
| 06-SR02 / 10-T2 | `read_file` 整文件读入再切行窗口 | 窗口感知读；共享实现在 `conex-fs`，**禁止双轨** |
| 06-SR03 | `fuzzy_find` 每调用全量 `build_directory_index` | 会话级目录索引缓存（TTL/mtime），walk 仅 miss |
| 10-T4 | 工具输出默认无预算 + text/output 双表示 + 多级深 clone | 生产 `output_budget_bytes` 设默认；执行侧 Arc 边界 |
| 10-S1 | shell 全量字节完成前无界驻留 | 硬上限 + 边写边 spill；**内存峰值有界** |
| 10-M1 | MCP stdout 整行无上限 | 行长上限 + 超限 `mark_exited`（非静默） |
| 14-SB1 | 每次调用重编译 `CommandGatekeeper` RegexSet | 进程级共享实例；**删除全部生产 `new()` 站点** |
| 14-SB2 | shell prepare 语义分析三连 | 单次 `analyze`，Analysis 沿链传递；**删除重复 analyze 路径** |
| 14-BR1 | 域门禁同步 DNS 在 async 路径 | DNS 移出 tokio worker（`spawn_blocking` 或异步 resolver） |
| 14-CP1 | computer snapshot UIA 同步在 async | 对齐已正确路径 `spawn_blocking` |
| 13-C13-H1 | 同步 LLM 摘要阻塞 async run loop | 与 `summary_dispatch` 共用 helper；**删除 run loop 内同步 summarize 路径** |
| 13-C13-H3 | G8 截断未接线到正常工具路径 | G8 接入正常工具结果记录路径；提示词第二道防线 |

### 0.2 架构锁

1. **SSOT**：每个概念只有一个权威源——预算常量、窗口读实现、Gatekeeper 实例、摘要阻塞 helper 均如此。
2. **物理切除**：旧同步路径、per-call `new()`、重复 `analyze`、无界累加字节、整读再切中间 `Vec`——**删除代码**，禁止注释隐藏、禁止「兼容 Shim」、禁止双轨回退。
3. **无伪连通**：禁止只写纯函数/空转包装而不接入真实调用链；禁止在真实调用处传 `None`/`Default`/空配置假装完成；禁止 `#[allow(dead_code)]` 死快照充当完成。
4. **无双读实现**：窗口感知读只允许 `conex-fs` 一份实现；壳命令与 agent-tools 必须消费同一函数，**禁止「壳一份、工具一份、前端再一份」**。
5. **预算常量单源**：阻塞/执行面全部字节/行数/超时常量迁入 `conex-shared::perf_budget`（或等价单一模块），业务代码只 re-export；门禁脚本断言。

### 0.3 验收五端物证

| 端 | 本方案物证 |
| -- | -- |
| 触发端 | 真实 UI 发起 list/read/write/shell/read_file 工具；非单测 mock |
| 传输端 | 壳 fs 命令 wire 键不变（`workbench_list_directory` 等）；响应结构向后兼容扩字段 |
| 介质端 | shell 超预算输出落 spill 文件；工具超预算输出截断标记透传 |
| 消费端 | run loop 内 abort 在摘要期间可生效；tokio worker 不被同步 IO 占满 |
| 负向断言 | 生产代码 `CommandGatekeeper::new()` 0 命中；`async fn` 内裸 `std::fs::` 0 命中（白名单外）；`output_budget_bytes` 生产装配不再为 `None` |

---

## 1. 维度划分与依赖拓扑

### 1.1 本方案维度总览

| 维 | 名称 | 核心问题 | 主要 ID |
| -- | -- | -- | -- |
| **D0** | 预算常量 SSOT | 阻塞/执行面字节预算散落 8+ 处，无单一源 | 全维前提 |
| **D1** | Gatekeeper 共享与 analyze 单次传递 | per-call 重编译 RegexSet + 同命令 analyze ×3 | 14-SB1、14-SB2 |
| **D2** | spawn_blocking 全面治理 | 壳 fs 同步命令 + agent-tools async 内同步 IO | 06-FS01/03-I3、06-SR01、10-T1 |
| **D3** | 窗口感知读 SSOT | 整读再切行窗口 ×2 实现（壳 + 工具） | 06-FS02、06-SR02、10-T2 |
| **D4** | shell/MCP 内存上界 | 完成前无界驻留 + MCP 行无界 | 10-S1、10-M1 |
| **D5** | 工具输出预算与 Arc 执行侧边界 | 生产 `output_budget_bytes=None` + 双表示 + clone | 10-T4、03-C2 交叉 |
| **D6** | compaction 同步摘要 + G8 接线 | run loop 内同步 summarize + G8 仅 emergency | 13-C13-H1、13-C13-H3 |
| **D7** | DNS / UIA 阻塞面 | 同步 DNS / UIA 在 async 栈 | 14-BR1、14-CP1 |
| **D8** | 防御脚本与负向断言 | 无门禁则回潮 | 全维 |

### 1.2 依赖拓扑（为何是这个顺序）

```text
D0 预算常量 SSOT
 │   （无 SSOT 则 D3/D4/D5/D6 各写各的数字，二次分叉）
 ├──────────────────────────────┐
 ▼                              ▼
D1 Gatekeeper 共享        D2 spawn_blocking 治理
 │   （纯构造面，文件域      │   （async 纪律底座）
 │    与 D2 大体不相交）     │
 │                              ▼
 │                     D3 窗口感知读 SSOT
 │                     （依赖 D2 骨架 + D0 预算）
 │                              │
 ├──────────────────────────────┤
 ▼                              ▼
D4 shell/MCP 上界        D5 输出预算 + Arc
 │                              │
 └──────────┬───────────────────┘
            ▼
     D6 同步摘要 + G8
     （依赖 D0 预算；D5 接线后 G8 语义与工具预算同源）
            │
            ▼
     D7 DNS/UIA（可与 D1–D6 并行，文件域独立）
            │
            ▼
     D8 防御脚本（各维落地时同步扩展，非独立收尾轮）
```

**并行规则**（v3 §4.2）：同一 Layer 内、文件域不相交的单元可并行；收敛/删除类任务串行；跨域只读依赖。

**禁止顺序反例**：

- 未删 per-call `CommandGatekeeper::new()` 前，不得声称「门禁已优化」  
- 未做 D3 SSOT 前，不得在壳与工具各写一份窗口读「先跑起来」  
- 未设生产 `output_budget_bytes` 默认前，不得只改前端 hardCap 掩盖执行侧无界  
- 未把 summarize 移出 run loop 前，不得只加 estimate 缓存宣称「压缩已优化」  
- 未接 G8 到正常工具路径前，不得只在 `build_summarize_prompt` 加防线就宣称 H3 完成（提示词是第二道，不是唯一）

---

## 2. 删除收敛面（本方案要删掉什么 / 收敛什么）

> 删除是完成方式，不是砍范围（v3 §8.1）。下列每项须在任务书中写明入口/出口，由主控验证后执行。

### 2.1 物理删除清单

| # | 孤岛 / 旧路径 | 入口 → 出口 | 替代路径 | 对应发现 |
| -- | -- | -- | -- | -- |
| DEL-1 | 壳 fs 三命令同步 `fn` 签名 | `fs_commands/mod.rs:30,41,56` 三个 `pub(crate) fn` | `async fn` + 内部 `spawn_blocking` | 06-FS01 |
| DEL-2 | `read_file_content` 整读 → `from_utf8` → `lines().count()` 中间路径 | `fs_commands/read.rs` 主循环 + 二次扫描 | 窗口感知读（D3），行数过程中维护 | 06-FS02 |
| DEL-3 | agent-tools `read_file` 整文件 `std::fs::read` 再 `lines().collect()` | `tools/fs.rs:105-135` | 窗口感知读（D3）+ `spawn_blocking`（D2） | 06-SR02、10-T2 |
| DEL-4 | 全部生产 `CommandGatekeeper::new()` 站点 | shell.rs:235、process.rs:77、host_openers/execute.rs:97/180/304、cli_bridge.rs:101、readonly.rs:182 | 进程级共享实例（`LazyLock`/`Arc` 注入） | 14-SB1 |
| DEL-5 | shell prepare 内重复 `analyze` 路径 | `shell.rs:236-242`（check 内 1 次 + 显式 1 次）+ `permission.rs:141-157`（再 1 次） | 单次 `analyze`，`SemanticAnalysis` 沿链传入门禁与 decide | 14-SB2 |
| DEL-6 | `OutputAccumulator.bytes` 完成前无界 `extend_from_slice` 唯一路径 | `shell_output.rs:141-149` | 硬上限 + 超限即 spill 到盘；内存只持 preview + 短窗缓冲 | 10-S1 |
| DEL-7 | MCP stdout `next_line()` 无行长上限路径 | `bridge_session.rs:477-479` | 有界 `read_until` + 超限 `mark_exited` | 10-M1 |
| DEL-8 | 生产 `ToolBatchOptions` 继承 `output_budget_bytes: None` 的装配 | `run_launch.rs:752-759` `..Default::default()` | 显式设置默认（来自 D0 常量） | 10-T4 |
| DEL-9 | run loop 内同步 `summarizer.summarize` 调用路径 | `compaction_dispatch.rs:284-290` → `engine.rs:370-371` | 共享 helper（对齐 `summary_dispatch.rs:780-793`）；引擎收 precomputed 或经 helper | 13-C13-H1 |
| DEL-10 | G8 仅 emergency 唯一生产调用形态 | `engine.rs:561-579`（emergency preflight） | 正常工具结果记录路径也调 `truncate_tool_output`；emergency 保留 | 13-C13-H3 |
| DEL-11 | 散落的阻塞/执行面预算常量本地定义 | `shell_output.rs:17-19`（24KB）、`output.rs:17`（`DEFAULT_INLINE_BYTES`）、`tools/mod.rs:157`（200_000）、`fs.rs:18`（256_000）、`search.rs:21`（512_000）、`tool_output.rs:25-27`（50KB/2000 行） | 全部 re-export 自 `conex-shared::perf_budget` | 全维前提 |
| DEL-12 | `fuzzy_find` 每调用 `build_directory_index` 无缓存路径 | `tools/search.rs:487-490` | 会话级索引缓存（TTL/mtime），walk 仅 miss | 06-SR03 |

### 2.2 收敛清单（合并为单路径）

| # | 概念 | 现状路径数 | 收敛到 | 说明 |
| -- | -- | -- | -- | -- |
| CON-1 | 窗口感知文件读 | 2（壳 `read.rs` 循环 + 工具 `fs.rs` 整读） | **1**（`conex-fs::windowed_read`） | 壳与工具消费同一函数；禁止第三份 |
| CON-2 | CommandGatekeeper 实例 | 2 类（SharedGatekeeper State + 各处 `new()`） | **1**（进程级共享；Tauri State 与工具侧共 Arc） | SharedGatekeeper 扩展为权威源，工具 crate 经注入 |
| CON-3 | `semantics::analyze` 调用 | shell prepare 路径 3 次 | **1** 次/命令 | Analysis 作为值传递，非重算 |
| CON-4 | 摘要阻塞承接 | 2（summary_dispatch 已正确 + compaction 同步错误） | **1** helper | `summarize_via_blocking` 唯一实现 |
| CON-5 | 工具输出字节预算常量 | 8+ 散落 | **1**（perf_budget 源） | 值可不同，**定义位置唯一** |
| CON-6 | G8 截断注入点 | 1（emergency） | **2**（正常工具记录 + emergency） | 同一算法、两处调用；非双实现 |

### 2.3 明确不做（诚实边界内的范围外）

| 项 | 原因 | 交接 |
| -- | -- | -- |
| PE-02 token N 合 1 / delta 合并 | 契约禁令，需 Layer 8 评审 | 强契约维 |
| 工具事件批收口实时化 / Progress 接线（10-T3） | 事件语义 + 契约，非阻塞面根因 | 事件维 / 用户裁决 |
| emit_event 全链 Arc 至 IPC | 执行侧只做到 ToolResult/ToolEnd Arc 边界；IPC 双发是另一维 | IPC 维 |
| estimate_context 每 turn 缓存（13-H2） | CPU 优化为主，非阻塞；本方案只处理其调用路径上的同步摘要 | 引擎/压缩维 |
| 搜索索引 watch 失效（06-SC03） | 生命周期维，可与 D3 后续并行 | 搜索维 |
| PowerShell 常驻 helper 进程（14-SH1 深改） | 架构级，本方案只做 `OnceLock` 解析缓存（低风险子项） | 可选增强 |

---

## 3. 任务四件套（按维度）

> 每维固定：做什么 / 删什么 / 依赖与逻辑顺序 / 文件域与验收。  
> **先删后改**：删除必须先于依赖它的新增（v3 §二.4）。

---

### D0 · 预算常量 SSOT

#### 做什么

1. 新建 `crates/conex-shared/src/perf_budget.rs`，收录阻塞/执行面常量（语义名 + 值 + 文档）：

| 常量（建议名） | 语义 | 现散落位置（现值） |
| -- | -- | -- |
| `SHELL_PREVIEW_HEAD_BYTES` / `SHELL_PREVIEW_TAIL_BYTES` | shell 预览头/尾 | shell_output.rs:17-19（24KiB） |
| `SHELL_MAX_OUTPUT_BYTES_DEFAULT` | shell 输出默认上限 | tools/mod.rs:157（200_000） |
| `TOOL_OUTPUT_BUDGET_BYTES_DEFAULT` | 执行器 summarize 默认预算 | 新建（建议 64KiB，对齐 10-T4 方案） |
| `READ_FILE_MAX_BYTES_DEFAULT` | read_file 默认 maxBytes | fs.rs:18（256_000） |
| `SEARCH_MAX_FILE_BYTES_DEFAULT` | search 单文件上限 | search.rs:21（512_000） |
| `MCP_STDOUT_MAX_LINE_BYTES` | MCP 行长上限 | 新建（建议 16MiB，可配） |
| `SHELL_ACCUM_HARD_CAP_FACTOR` | spill 触发相对预算倍数 | 新建（建议 2.0） |
| `G8_TOOL_OUTPUT_MAX_LINES` / `G8_TOOL_OUTPUT_MAX_BYTES` | G8 双阈值 | tool_output.rs:25-27（2000 / 50KiB） |
| `FS_LIST_DIRECTORY_DEFAULT_LIMIT` | list 分页默认上限 | 新建（建议 2000） |
| `GATEKEEPER_SHARED`（标记常量） | 共享门禁接线位 | — |

2. 前端若后续消费（本方案不强制前端接线），预留 `apps/crish-desktop/src/api/perfBudgets.ts` 同名 re-export；本方案**先落 Rust 单源**。
3. 各业务文件改为 `use conex_shared::perf_budget::*` 或本地 `use … as` re-export；**删除本地 `const` 定义**。

#### 删什么

- DEL-11：各文件本地预算 `const`（见 §2.1）。

#### 依赖与逻辑顺序

- **最前置**。无 SSOT 则 D3/D4/D5/D6 会各自发明数字。
- 可与 D1 并行（文件域不相交）。

#### 文件域与验收

| 项 | 内容 |
| -- | -- |
| 文件域 | `crates/conex-shared/src/perf_budget.rs`（新）、`crates/conex-shared/src/lib.rs`（mod 导出）；消费点见 DEL-11 各文件（**串行迁移**，每迁一个删一个本地 const） |
| 功能验收 | `cargo test -p conex-shared`；全仓编译通过；各工具行为值不变（仅定义位置变） |
| 负产出验收 | 本地预算 const 命中数 → 0（除测试 fixture） |
| 防御 | `scripts/check-perf-budgets.mjs`：业务代码出现未从 perf_budget re-export 的字面量预算 → fail |

---

### D1 · Gatekeeper 共享与 analyze 单次传递

#### 做什么

1. **进程级共享实例**：在 `conex-sandbox` 提供 `pub static SHARED_GATEKEEPER: LazyLock<CommandGatekeeper>`（正则集编译期固定、无运行时配置依赖——最简正确）。
2. 壳层 `SharedGatekeeper` 改为包装该静态（或持有 `Arc<CommandGatekeeper>` 指向同一实例）；`main.rs:805` `manage` 保持，**内部不再二次 `new()`**。
3. 工具侧注入：`BuiltinToolConfig` / shell 工具构造接收 `Arc<CommandGatekeeper>`（或直接读 `SHARED_GATEKEEPER`）；shell/readonly 消费同一实例。
4. host openers / process.rs / cli_bridge 全部改读共享实例。
5. **analyze 单次传递**：
   - `CommandGatekeeper` 增加 `check_command_with_analysis(&self, analysis: &SemanticAnalysis, cmd, args)`（或让 `check_command` 接受 `Option<&SemanticAnalysis>`）；
   - `permission::decide_command_with_revert` 增加接受已算 analysis 的重载（`decide_analysis_with_revert`）；
   - shell `prepare`：**先** `analyze(&command)` **一次** → 传门禁 → 传 decide → 自用 DeleteShape/cd 判定。
6. `full_line` 与 `command` 在 shell 路径 args 恒空时语义一致——保留 host openers 带 args 的拼入口径。

#### 删什么

- DEL-4：生产 `CommandGatekeeper::new()` 全部站点（shell.rs:235、process.rs:77、execute.rs:97/180/304、cli_bridge.rs:101、readonly.rs:182）。
- DEL-5：prepare 内第 2、3 次 `analyze` 调用路径。

#### 依赖与逻辑顺序

- 先加共享实例与 API 重载（新增）→ 再逐站点替换 `new()`（删除）→ 最后删重复 analyze。
- 与 D2/D3 文件域基本不相交，可并行。

#### 文件域与验收

| 项 | 内容 |
| -- | -- |
| 文件域 | `crates/conex-sandbox/src/lib.rs`、`crates/agent-tools/src/tools/shell.rs`、`crates/agent-tools/src/permission.rs`、`crates/agent-tools/src/readonly.rs`、`apps/agent-workbench/src-tauri/src/{core_commands,process,cli_bridge}.rs`、`host_openers/execute.rs`、`main.rs` |
| 功能验收 | `conex-sandbox` 全部 gatekeeper 测试；shell 红线/审批矩阵；`process.rs` eleven red-line 测试；判定结果字节级不变 |
| 负产出验收 | 生产路径 `CommandGatekeeper::new()` grep = 0（测试内允许）；shell prepare 路径 `analyze(` 调用次数 = 1 |
| 防御 | `scripts/check-gatekeeper-shared.mjs` 或扩展 check-async-commands：生产 `.rs` 禁止 `CommandGatekeeper::new` |

---

### D2 · spawn_blocking 全面治理（壳 fs + agent-tools）

#### 做什么

1. **壳 fs 三命令**：`list_directory` / `read_file_content` / `write_file_content` 改 `async fn`，内部 `tokio::task::spawn_blocking` 包裹同步 IO 核心（模式照抄 `core_commands` / `session_commands`）。
2. **agent-tools 重 IO 工具**：`read_file` / `write_file` / `list_dir` / `file_stat` / `grep_search` / `fuzzy_find` / `replace` / `diff` / `project_tree` 的 `async fn execute` 内，同步 `std::fs` 全路径包 `spawn_blocking`。
   - 闭包入参用 `PathBuf`/`Vec<u8>`/`String` 移入；`ToolContext` 非 Send 部分在闭包外准备。
   - `AbortToken` 检查放在闭包外循环点。
3. **正面对照已存在，禁止回潮**：`conex-computer-tools/src/session.rs:186-201`、`core_search_files`——本维把这些范式推广到缺口。
4. `list_directory` 增加条目上限/分页参数（默认值来自 D0）；响应结构向后兼容扩字段（`truncated`/`cursor`），同步前端 `workspaceFsApi` 与 manifest。
5. `write_file_content` 小文件评估接 `conex_fs::atomic_write`；大文件保持直写但文档化契约。

#### 删什么

- DEL-1：壳三命令同步 `fn` 签名。
- DEL-3 中「async 内裸 `std::fs`」部分（整读路径的完整删除在 D3）。

#### 依赖与逻辑顺序

- 依赖 D0（list 上限等常量）。
- 与 D1 并行；D3 依赖本维的 `spawn_blocking` 骨架。
- **先删同步签名，再接窗口读**——禁止「先留同步兼容分支再改」。

#### 文件域与验收

| 项 | 内容 |
| -- | -- |
| 文件域 | `apps/agent-workbench/src-tauri/src/fs_commands/{mod,read,directory,write}.rs`；`crates/agent-tools/src/tools/{fs,search,replace,diff,project_tree}.rs`；前端 `workspaceFsApi.ts`（仅当扩字段） |
| 功能验收 | `fs_commands` 现有单测全绿；`tools/fs.rs` / `search.rs` 现有单测全绿；大目录 list 不阻塞其它 invoke（运行时 V 项） |
| 负产出验收 | `fs_commands` 下 `#[tauri::command]` 非 `async` 的 `fn` = 0；`async fn execute` 函数体禁止出现 `std::fs::` 直调（AST/正则门禁） |
| 防御 | `scripts/check-async-commands.mjs`（新建或扩展）：非 async 白名单外 fail |

---

### D3 · 窗口感知读 SSOT（conex-fs）

#### 做什么

1. 在 `crates/conex-fs` 新增 **唯一** 窗口感知读实现（建议 API）：

```text
windowed_read(path, WindowReadOptions {
    start_line, end_line / content_offset,
    max_lines, max_bytes,
    binary_probe_bytes,
}) -> WindowReadResult {
    text_window, total_lines_hint / exact?,
    truncated, content_truncated, next_content_offset,
    encoding, is_binary, file_bytes
}
```

2. **实现要点**（非伪连通）：
   - 读前 `metadata.len()`；若请求窗口小且文件大，**只读前缀/所需窗口字节**（UTF-8 边界处理），禁止整文件进内存；
   - 行数在扫描过程中维护，禁止 `from_utf8` 后再 `lines().count()` 二次全文扫；
   - 二进制探测用前缀（如 8KB），禁止整文件读入后才判 binary。
3. **壳 `read_file_content` 与 agent-tools `read_file` 全部改调此函数**；各自只保留参数解析、workspace 路径 guard、响应 JSON 组装。
4. 头部元数据字段（`lines`/`totalChars`）语义：若窗口读无法给出精确全文行数，**保持现有字段语义**（精确值）时需扫行计数但不物化全文 `Vec<&str>`——用迭代计数；若引入「估算」语义须契约评审，本方案**默认不改语义**。
5. `fuzzy_find`：会话 `ToolContext` 挂 `Arc<RwLock<Arc<Vec<String>>>>` 目录索引 + mtime/TTL；miss 时 `spawn_blocking` walk；与壳 `SharedSearchState` 若同进程可装配层共享（可选，第二步）。

#### 删什么

- DEL-2：壳 `read.rs` 整读 → from_utf8 → lines().count() 中间路径。
- DEL-3：工具 `read_file` 整读 + `lines().collect()` 全文指针表路径。
- DEL-12：`fuzzy_find` 无缓存全量 walk 每调用路径。

#### 依赖与逻辑顺序

- 依赖 D2（`spawn_blocking` 包裹层）与 D0（预算常量）。
- **先写 conex-fs 单实现 + 单测 → 再改壳 → 再改工具 → 删旧路径**。禁止壳/工具各留一份「临时」旧读法。

#### 文件域与验收

| 项 | 内容 |
| -- | -- |
| 文件域 | `crates/conex-fs/src/windowed_read.rs`（新）、`lib.rs`；`fs_commands/read.rs`；`tools/fs.rs`；`tools/search.rs`（fuzzy 缓存）；`ToolContext` 扩展（索引槽） |
| 功能验收 | `read_file_roundtrip` / `truncates_oversize_content` / `content_offset_resumes` 等既有测试全绿；新增：大文件只读窗口的字节上限断言（可用 tempfile 大文件 + 自定义计数） |
| 负产出验收 | 全仓「整文件 read 后 lines().collect()」模式 = 0；`windowed_read` 调用点 ≥ 2（壳 + 工具）且实现仅 1 处 |
| 防御 | 检查脚本：`tools/fs.rs` 与 `fs_commands/read.rs` 禁止出现 `std::fs::read(` 整文件形态（应调 windowed_read） |

---

### D4 · shell / MCP 内存上界

#### 做什么

1. **shell OutputAccumulator**：
   - `append` 时若累计字节 > `SHELL_MAX_OUTPUT_BYTES_DEFAULT × SHELL_ACCUM_HARD_CAP_FACTOR`，**切换为边写边 spill**（临时文件 + 仅 preview 在内存），禁止继续 `bytes.extend` 无界涨；
   - 结束时 `build_sync_result` 语义不变：截断判定、spill 路径、`logPath`、preview 头尾 24KB（常量来自 D0）；
   - 失败降级：spill 打开失败时保持现有有界 preview + truncated 标记，**不得 OOM**。
2. **MCP stdout**：
   - 自研 `read_until(b'\n', max_line_bytes)` 或对 `fill_buf` 累计超限；
   - 超限 → `mark_exited("stdout line too long")`（connection_failed 语义，**非静默**）；
   - 默认上限 `MCP_STDOUT_MAX_LINE_BYTES`（D0）。
3. stderr 环形尾保持（正面，10-OK6）。

#### 删什么

- DEL-6：完成前唯一无界 `bytes.extend` 路径。
- DEL-7：无界 `next_line()` 读路径。

#### 依赖与逻辑顺序

- 依赖 D0（常量）。与 D5 可并行（同 crate 但不同文件：shell_output / mcp vs tool_events / executor）。
- spill 逻辑已有（`spill_full_output` 在结束后）——本维是**把触发点提前到 append 时**，不是新写落盘协议。

#### 文件域与验收

| 项 | 内容 |
| -- | -- |
| 文件域 | `crates/agent-tools/src/tools/shell_output.rs`、`shell_exec.rs`；`crates/agent-tools/src/mcp/bridge_session.rs` |
| 功能验收 | shell 既有单测全绿；新增：超大输出时 RSS 有界（bench/手动采样）；MCP 假 server 发超长行 → connection_failed |
| 负产出验收 | `OutputAccumulator` 无「无上限 extend」路径；`next_line()` 在 stdout reader = 0 |
| 运行时 V | 10-V4：`cat` 大文件完成前 RSS 曲线有上界；10-V5：100MB 单行被挡住 |

---

### D5 · 工具输出预算接线与 Arc 执行侧边界

#### 做什么

1. **生产默认预算**：`run_launch.rs` 装配 `ToolBatchOptions` 时显式 `output_budget_bytes: Some(TOOL_OUTPUT_BUDGET_BYTES_DEFAULT)`（D0）；工具级覆盖（shell 200KB）保持。
2. **执行器 summarize**：`executor_run.rs` 已在 `Some(budget)` 时截断——接线后真实生效；`truncated` 标记透传。
3. **Arc 执行侧边界**（本方案只做到执行器出口，不扩 IPC 全链）：
   - `ToolEnd` 事件中大 output 使用 `Arc<serde_json::Value>`（或等价）共享，消除 `exec_batch`/`exec_single` 对同一 output 的多次深 clone；
   - `ToolResult` 双表示：`text` 改为按需 stringify（`OnceCell`/惰性）或与 `output` 生命周期解耦，避免双份常驻——**以不破坏上层直接投喂 text 的契约为前提**，若契约占优则至少保证 text 在不再被读后释放。
4. **G8 与执行器预算的关系**：执行器 `output_budget_bytes` 管「进事件/上下文的载荷大小」；G8 管「conversation 内工具结果行/字节双阈值 + 留痕」。两层互补，**不互相替代**；数值同源（D0）。

#### 删什么

- DEL-8：生产装配继承 `None` 的路径。

#### 依赖与逻辑顺序

- 依赖 D0。与 D4 并行。D6 的 G8 接线依赖本维概念边界清晰（预算语义）。

#### 文件域与验收

| 项 | 内容 |
| -- | -- |
| 文件域 | `apps/agent-workbench/src-tauri/src/run/run_launch.rs`；`crates/session-loop/src/tool_events.rs`（Default）；`crates/agent-tools/src/{executor_run,executor_types,exec_batch,exec_single}.rs`；`crates/session-loop/src/exec_single.rs`（options 透传） |
| 功能验收 | 既有 `output_budget_bytes_truncates_large_output` 等测试全绿；生产路径集成测试：未显式覆盖时预算生效 |
| 负产出验收 | 生产 `ToolBatchOptions` 装配点 `output_budget_bytes` 非 None；ToolEnd 路径对同一 output 的 clone 次数下降（计数探针或 dhat） |
| 交叉说明 | 03-C2（emit_event 深克隆）的**全变体 Arc** 属 IPC 维；本维只锁执行器出口的 ToolEnd Arc 边界，接口预留 `Arc` 透传 |

---

### D6 · compaction 同步摘要非阻塞化 + G8 接线

#### 做什么

1. **共享 helper**（与 `summary_dispatch.rs:780-793` 同源）：

```text
async fn summarize_via_blocking(
    summarizer: Arc<dyn Summarizer + Send + Sync>,
    dropped: Vec<AgentMessage>,   // 或 Vec<Arc<AgentMessage>> 见下
    existing: Option<String>,
    wall_ms: u64,
) -> Result<String, String>
```

2. **引擎 API 拆分**：
   - `compact_agent_messages_with_stub_policy` 增加接受「已算摘要结果」的入口（`summarize_precomputed: Option<Result<String, String>>`），或引擎改为在 dispatch 层先 `summarize_via_blocking` 再调纯计划引擎；
   - **删除** `compaction_dispatch::compact_with_llm_guard` / `compression_ladder` / 预检路径中对同步 `summarize` 的直接调用（DEL-9）。
3. **溢出 shape 修复（13-M4）**：禁止第二次 summarize——复用已生成 summary 或放弃；与 H1 同票。
4. **G8 正常路径接线（13-H3）**：
   - session-loop 工具结果写入 conversation 前调用 `truncate_tool_output`（限额来自 D0 / 与 G8 同源）；
   - 留痕事件按 `tool_output.rs` 设计落库；
   - `build_summarize_prompt` 第二道防线：单消息渲染 + 总长预算（与 `max_summary_tokens×4` 同源），超限 head+tail+标记；
   - `dropped_slice` 优先 `Vec<Arc<AgentMessage>>` / 借引用渲染，避免为 LLM 输入先付全文值克隆（`engine.rs:363`）。
5. **R-F 语义裁决**：同步单次尝试改为「阻塞池内单次尝试 + 墙钟」——**不改变 StubPolicy / LlmRequired 决策树**，只改变「在哪条线程等」。效果锁：不得默默降级为纯丢弃。

#### 删什么

- DEL-9：run loop 内同步 summarize 调用路径。
- DEL-10：G8「仅 emergency」唯一生产形态（emergency 保留，新增正常路径）。

#### 依赖与逻辑顺序

- 依赖 D0（预算）；概念上依赖 D5（工具输出预算边界）——D5 未完成时 G8 仍可接线，但两层语义需在任务书写清。
- **先抽 helper + 引擎 API → 改 dispatch 调用点 → 删同步路径 → 再接 G8**。

#### 文件域与验收

| 项 | 内容 |
| -- | -- |
| 文件域 | `crates/session-loop/src/loop/{compaction_dispatch,stream_error_recover,summary_dispatch}.rs`；`crates/conex-compaction/src/{engine,ai_summary,tool_output,plan}.rs`；工具完成记录路径（`executing_tools.rs` 或 tool 收口点） |
| 功能验收 | 预检/边界/溢出既有集成测试全绿；注入慢 Summarizer（sleep 5s）时同 task 内 abort ≤1s 生效；G8 截断单测 + emergency 路径不回归 |
| 负产出验收 | `engine.rs` 内直接 `summarizer.summarize` 在非测试路径 = 0（经 helper / precomputed）；`truncate_tool_output` 生产调用点 ≥ 2（正常 + emergency） |
| 运行时 V | 13-V1：发送→首 token 不含完整摘要 RTT；13-V2：慢摘要下 abort 延迟 |

---

### D7 · DNS / UIA 阻塞面

#### 做什么

1. **浏览器域门禁 DNS**：`gate.rs` `SystemResolver::resolve`（`to_socket_addrs`）在 async 调用栈——工具层 `spawn_blocking(|| gate.check(url))` 或增加 async 变体；**fail-closed 语义不变**。
2. **DNS 缓存**：`HostResolver` 短 TTL 正/负缓存为**可选增强**；若做，须安全评审（负缓存 + rebinding 窗口）；**默认本方案先做 spawn_blocking，缓存单列裁决**。
3. **computer snapshot**：对齐 `session.rs:186-201` 已正确路径，snapshot UIA 遍历移入 `spawn_blocking`（CP1）。
4. **14-BR3 轮询条件 bug**（已稳定 URL 仍 5×100ms）：条件反转修复——属本维顺带正确性修复（中→高登记）。

#### 删什么

- 无大块文件删除；收敛的是「async 栈内同步 DNS/UIA」调用形态。

#### 依赖与逻辑顺序

- 文件域独立，可与 D1–D6 并行。

#### 文件域与验收

| 项 | 内容 |
| -- | -- |
| 文件域 | `crates/conex-browser-tools/src/gate.rs`、`tools/navigate*.rs`；`crates/conex-computer-tools/src/session.rs`（snapshot 路径） |
| 功能验收 | gate 全部 SSRF/fail-closed 测试；navigate 重定向用例；computer snapshot 测试 |
| 负产出验收 | async 工具路径禁止 `ToSocketAddrs` 直调；snapshot 路径存在 `spawn_blocking` |
| 诚实边界 | 14-BR3 事件驱动全改（CDP lifecycle）工作量大——本维**先修轮询条件 bug**；事件化单列后续，不假装完成 |

---

### D8 · 防御脚本与负向断言（贯穿）

> 非独立收尾轮——各维落地时**同步**扩展对应脚本。

| 脚本 | 断言 | 依赖维 |
| -- | -- | -- |
| `check-perf-budgets.mjs` | 魔数预算仅允许 perf_budget 源 | D0 |
| `check-async-commands.mjs` | 命令/工具 async 纪律；非 async 白名单 | D2 |
| `check-tool-blocking-io`（可并入上者） | `async fn` 内禁裸 `std::fs` | D2/D3 |
| `check-gatekeeper-shared` | 生产禁 `CommandGatekeeper::new` | D1 |
| shell/MCP 计数探针（单测） | 无界累加 / 超长行 | D4 |
| G8 调用点存在性断言 | 正常工具路径有 truncate | D6 |

---

## 4. 文件域总表（防并行冲突）

| 单元 | 主要文件域 | 可并行伙伴（本方案内） |
| -- | -- | -- |
| U-BUDGET | `conex-shared/perf_budget`、消费点 const 迁移 | 与 U-GATE 并行 |
| U-GATE | sandbox lib、shell prepare、permission、readonly、host_openers、process、cli_bridge、SharedGatekeeper | 与 U-BLOCK/U-BUDGET 并行 |
| U-BLOCK | fs_commands/*、agent-tools tools/{fs,search,replace,diff,project_tree} | 与 U-GATE 并行；**阻 U-READ** |
| U-READ | conex-fs windowed_read、fs_commands/read、tools/fs、fuzzy 缓存 | **串行于 U-BLOCK** |
| U-MEM | shell_output、mcp/bridge_session | 与 U-BUDGET 后并行 |
| U-BUDGET-EXEC | run_launch、tool_events Default、executor_*、ToolEnd Arc | 与 U-MEM 并行 |
| U-COMPACT | compaction_dispatch、engine、summary helper、G8 接线点 | 串行于 U-BUDGET（概念）；文件域独立可早启动 helper 抽取 |
| U-GATE-DNS | browser gate、computer snapshot | 全程并行 |
| U-GUARD | scripts/check-* | 随各单元 |

**跨单元规则**：同一文件只允许一个 Agent 主责；跨域只读依赖或主控协调串行。

---

## 5. 逻辑里程碑（非工期）

| 里程碑 | 完成定义 |
| -- | -- |
| **m0** | D0 perf_budget 落地 + 迁移清单打勾 + check-perf-budgets 骨架 |
| **m1** | D1 共享 Gatekeeper + analyze 单次 + 生产 `new()` = 0 |
| **m2** | D2 壳/工具 spawn_blocking 全覆盖 + INV-3 静态断言绿 |
| **m3** | D3 windowed_read 唯一实现 + 壳/工具双消费 + 整读路径删除 |
| **m4** | D4 shell spill 提前 + MCP 行长上限 + 运行时 RSS 有界 |
| **m5** | D5 生产预算接线 + ToolEnd Arc 边界 |
| **m6** | D6 summarize_via_blocking 接管 + G8 正常路径 + abort 可打断 |
| **m7** | D7 DNS/UIA spawn_blocking + BR3 条件修复 |
| **m8** | D8 防御脚本全接入 + 负向断言全绿 |

**目标不变量（修复后必须成立）：**

| ID | 不变量 |
| -- | -- |
| INV-B1 | 生产 `CommandGatekeeper::new()` = 0 |
| INV-B2 | shell prepare 路径 `analyze` = 1 次/命令 |
| INV-B3 | async 工具/壳命令路径：裸阻塞 syscall = 0（白名单外） |
| INV-B4 | 窗口读实现 = 1（conex-fs）；壳/工具双消费 |
| INV-B5 | shell 完成前内存峰值 ≤ hard_cap × 常数；MCP 行 ≤ max_line_bytes |
| INV-B6 | 生产 `output_budget_bytes` ≠ None；超限 truncated 透传 |
| INV-B7 | run loop async 栈禁止同步 `summarize`；G8 正常路径存在调用点 |

---

## 6. 与审计发现 ID 映射（90 前缀）

| 本方案维度 | 90 ID | 处置 |
| -- | -- | -- |
| D0 | （前提） | 常量单源 |
| D1 | 14-SB1、14-SB2 | 修复 + 删除 new()/重复 analyze |
| D2 | 06-FS01、03-I3、06-SR01、10-T1 | 修复；03-I3 以 06-FS01 为主票 |
| D3 | 06-FS02、06-SR02、10-T2、06-SR03 | SSOT 窗口读 + fuzzy 缓存 |
| D4 | 10-S1、10-M1 | 修复 |
| D5 | 10-T4；03-C2（交叉，IPC 侧交出） | 执行侧预算 + Arc 边界 |
| D6 | 13-C13-H1、13-C13-H3、13-C13-M4（顺带）、13-C13-H3 提示词 | 修复 |
| D7 | 14-BR1、14-CP1、14-BR3（条件 bug） | 修复；缓存/事件化单列 |
| 防回潮 | 10-OK1–OK6、14-OK1、06-G1–G9、13 正面 3/5/10 | **禁止回退** |
| 不在本方案 | 10-T3、03-R1/R2、13-C13-H2 全缓存、06-FE01 预览协议 | 交接（见 §2.3） |

---

## 7. 运行时验证建议（待 4000 Tauri MCP 回填）

| ID | 场景 | 指标 | 关联 |
| -- | -- | -- | -- |
| BV1 | 并行 4×大 read_file | 其它 async 任务延迟不显著上升 | D2 |
| BV2 | read_file(50MB) 只读 10 行 | 墙钟与峰值 RSS | D3 |
| BV3 | shell `cat` 大文件 | 完成前 RSS 有上界 | D4 |
| BV4 | MCP 假 server 100MB 单行 | 被行长上限挡住 | D4 |
| BV5 | 批 shell 短命令 | 门禁段耗时下降（共享 Gatekeeper） | D1 |
| BV6 | 长对话 85% 阈值后发消息 | 发送→首 token 不含完整摘要 RTT；abort 可打断 | D6 |
| BV7 | tool-end 200KB | 执行侧 clone 次数 / IPC 体积 | D5 |

通道纪律：唯一合法 UI 宿主调试口 = `127.0.0.1:4000` Tauri MCP；禁止 9222/浏览器插件/单独 5174。

---

## 8. 与 91 草稿的分歧（可推翻 91 的点）

| # | 点 | 91 草稿立场 | 本方案立场 | 理由 |
| -- | -- | -- | --- | -- |
| 1 | Gatekeeper 归属 | W1.3 与 DNS/UIA 混在一节 | **独立 D1 维**，删除面强化为「生产 `new()` 物理清零」 | SB1 是构造浪费 + 架构债（SharedGatekeeper 已建未推广）；与 DNS 阻塞不同根因、不同文件域，混装会稀释删除验收 |
| 2 | 窗口读 SSOT | W1.2 一句「共享实现放 conex-fs 避免双轨」 | **独立 D3 维**，先删后改、实现仅 1、双消费断言 | 壳与工具已是两套读法；不升维则容易各改各的「临时兼容」——违反无双读锁 |
| 3 | 预算 SSOT 范围 | L0-B 全仓预算（含前端 persist、PTY 合批、启动 KiB） | **本方案先锁阻塞/执行面子集**，前端/KiB 交其它维 | 独立总案可切片；全仓 L0 若并入会与前端/资产维文件域冲突；值迁移清单以本维 8+ 常量为强制最小集 |
| 4 | 同步摘要位置 | W2.2 与 estimate 缓存、G8 混在「estimate/compaction 编排」 | **D6 独立**，只做阻塞面 + G8；estimate 缓存明确交出 | H1 是阻塞纪律问题（与 T1 同型）；H2 是 CPU 缓存问题——混票导致「改了缓存宣称修了阻塞」 |
| 5 | shell 无界内存 | W1.2 一笔「OutputAccumulator 接硬上限 + spill 已有逻辑确认」 | **D4 强化**：spill 触发点前移到 append 时，完成前内存有硬顶 | 「结束后 spill」不解决完成前 OOM；10-S1 的根因是执行中无界，不是结束后 |
| 6 | MCP 行上限 | W1.2 提及 | 同 D4，明确 connection_failed 语义 + 单测锚点 | 对齐 10-M1「非静默」 |
| 7 | ToolEnd Arc | 91 放 Layer 2 引擎事件模型（与 stream 收口、thought 合并混装） | **D5 只做执行侧出口 Arc 边界**；emit 全链/IPC 归 IPC 维 | 执行侧可无契约落地；全链 Arc 触及 PE-02/双发交叉，独立案不吞并 |
| 8 | BR3 | 91 归 14-Y「轮询事件化」 | 本方案 D7 **先修条件反转 bug**（稳定 URL 仍空转 5 次）；事件化单列 | 条件 bug 是正确性级低成本修复；完整事件化属浏览器协议演进 |
| 9 | readonly.rs:182 | 91 W1.3 未显式列出 | **纳入 D1 删除清单** | 代码坐实：每次 `CommandGatekeeper::new()`——漏网站点 |
| 10 | 防御脚本命名 | 91 `check-tool-blocking-io` 等 | 沿用语义，接入点写明「各维同步扩展、非收尾轮」 | 避免「先改完再补门禁」导致回潮窗口 |

**对 91 的一致处**（不展开）：spawn_blocking 总原则、SharedGatekeeper 方向、G8 接线必要性、生产 output_budget 默认、无契约先行——本方案独立推导后与 91 同向，但删除面与 SSOT 锁更硬。

---

## 9. 诚实边界

1. **全部结论基于静态代码走读**（本会话已核对关键文件：`conex-sandbox/lib.rs`、`shell.rs`、`fs.rs`、`shell_output.rs`、`fs_commands/mod.rs`、`engine.rs`、`compaction_dispatch.rs`、`summary_dispatch.rs`、`bridge_session.rs`、`run_launch.rs`、`gate.rs` 等）。**未跑**运行时 RSS / tokio-console / MCP 端到端——BV1–BV7 待回填。
2. **未验证** `BuiltinToolConfig` 注入 `Arc<CommandGatekeeper>` 的全部构造链路长度——实现时若发现工具构造分散，以 `SHARED_GATEKEEPER` 静态为兜底权威源，**禁止**因此退回 per-call `new()`。
3. **`full_line` 与 args 拼接**在 host openers 带 args 路径与 shell 空 args 路径语义需在 D1 实现时逐调用点核对——分析共享不得改变红线/审批判定结果（字节级回归锚点强制）。
4. **windowed_read 的 totalLines 精确语义**：若窗口读无法 O(1) 得精确全文行数，要么扫行计数（不物化 Vec）要么改语义走契约评审——本方案默认**保持精确 + 迭代计数**，不承诺「永不扫行」。
5. **Arc 执行侧边界**不解决 03 双发 / emit 全变体 clone——那是 IPC 维票；本方案交付的是「执行器出口不深 clone 同一 output」。
6. **G8 与执行器预算两层**：接线后模型可见输出可能变短（有 truncated 标记）——属效果锁内预期行为，不是回归；但**禁止**把 shell 工具级 200KB 覆盖误删。
7. **D7 DNS 缓存未默认纳入**——安全 vs 性能需裁决；本方案只锁 spawn_blocking，不假装缓存已做。
8. **10-T3 Progress / 批收口实时化**明确不在本方案——涉事件契约与用户裁决，禁止静默砍。
9. **未做** `cargo test --workspace` 全量（本任务为方案产出，非实现轮）；实现轮每单元必须带功能 + 负产出双验收。
10. **文档不出现**「参考某某软件」措辞；G8 对齐语义已在上游报告，此处只锁接线。

---

## 10. 立即执行指令（本方案启动时的首轮并行切片）

按依赖拓扑，**首轮可并行**（文件域不相交、无强契约）：

1. **U-BUDGET** — perf_budget 模块 + 迁移清单起步  
2. **U-GATE** — SharedGatekeeper/静态单例 + analyze 单次传递 + 删 new() 站点  
3. **U-BLOCK** — 壳 fs 三命令 async + agent-tools spawn_blocking 骨架  
4. **U-MEM** — shell spill 提前 + MCP 行长上限（常量先引用 D0 草案路径）  
5. **U-GATE-DNS** — browser DNS spawn_blocking + computer snapshot + BR3 条件修复  
6. **U-COMPACT-prep** — `summarize_via_blocking` helper 抽取 + 引擎 precomputed 入参（先并行准备，接线串行于 U-BLOCK 无关）

**次轮**：U-READ（串行于 U-BLOCK）、U-BUDGET-EXEC、D6 G8 接线、D8 门禁扩展收口。

Layer 契约项（PE-02、双发、Progress）**不在首轮实现**。

---

## 附录 A · 证据锚点速查（本会话亲读）

| 证据 | 位置 |
| -- | -- |
| 壳三命令同步 `fn` | `fs_commands/mod.rs:30,41,56` |
| 工具 read_file 整读 | `tools/fs.rs:75-106,105-149` |
| shell prepare new+三连 analyze | `shell.rs:235-242` + `lib.rs:85` + `permission.rs:141-157` |
| SharedGatekeeper 已建 | `core_commands.rs:70-77`、`main.rs:805`；消费仅 `core_check_command` |
| 生产 new() 站点 | shell.rs:235、process.rs:77、execute.rs:97/180/304、cli_bridge.rs:101、readonly.rs:182 |
| OutputAccumulator 无界 | `shell_output.rs:141-149` |
| MCP next_line 无界 | `bridge_session.rs:477-479` |
| output_budget 默认 None | `tool_events.rs:343`；生产 `run_launch.rs:752-759` 未覆盖 |
| 同步 summarize | `engine.rs:370-371`；`compaction_dispatch.rs:284-290` |
| 正面对照 spawn_blocking 摘要 | `summary_dispatch.rs:780-793` |
| G8 仅 emergency | `engine.rs:561-579`；算法 `tool_output.rs:178+` |
| tools_prefix 每次重建 | `compaction_dispatch.rs:92-116` |
| DNS sync | `gate.rs:39-41` |
| computer spawn_blocking 正面 | `conex-computer-tools/src/session.rs:186-201` |
| 预算常量散落 | shell_output 24KB、output.rs DEFAULT_INLINE_BYTES、mod.rs 200_000、fs.rs 256_000、search.rs 512_000、tool_output 50KB |

---

_独立总案 · 阻塞与执行面 · 2026-09-13。未执行 git commit；未与其它并行总案对齐；91 为对照草稿非绑定结论。_
