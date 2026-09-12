# detail-D2 · 阻塞 IO 与 Gatekeeper 分维详案

> **战役**：performance-fix
> **维**：D2 · 阻塞 IO 与 Gatekeeper
> **上游**：`92-修复总方案.md`（唯一执行总案 §4 D2 / §6 / §7 / §10 U-BLOCK+U-GATE）；`materials/plans/independent-02-阻塞与执行面.md`（D1/D2/D3/D4/D7）；`review-plans-01-冲突与重叠.md` **CFL-09**（Gatekeeper 与 DNS/UIA 拆任务）；`06`/`10`/`14` 报告与发现索引
> **创建**：2026-09-13
> **契约级**：T0（无契约变更；wire 键与响应结构向后兼容扩字段）
> **原则**：先删后改；每概念 N→M 必答；**无双读实现**；子 Agent 不 `git commit`。

---

## 0. 效果锁（不缩水）

| 发现 ID | 一句话 | 不可降级底线 |
| -- | -- | -- |
| 06-FS01 / 03-I3 | 壳 fs 三命令同步 `fn` | 三命令全部 `async` + 内部 `spawn_blocking`，**物理删除同步签名** |
| 06-FS02 | 壳 `read_file_content` 行限后仍可能读满字节 / 二次分配 | 窗口感知读 + 过程中维护行数（经 `windowed_read`） |
| 06-SR01 / 10-T1 | agent-tools 全部重 IO 工具 async 内同步 `std::fs` | 全部重 IO 工具包 `spawn_blocking`，**不留同步直调路径** |
| 06-SR02 / 10-T2 | `read_file` 整文件读入再切行窗口 | 窗口感受读；共享实现在 `conex-fs`，**禁止双轨** |
| 06-SR03 | `fuzzy_find` 每调用全量 `build_directory_index` | 会话级目录索引缓存（TTL/mtime），walk 仅 miss |
| 14-SB1 | 每次调用重编译 `CommandGatekeeper` RegexSet | 进程级共享实例；**删除全部生产 `new()` 站点** |
| 14-SB2 | shell prepare 语义分析三连 | 单次 `analyze`，Analysis 沿链传递；**删除重复 analyze 路径** |
| 14-BR1 | 域门禁同步 DNS 在 async 路径 | DNS 移出 tokio worker（`spawn_blocking`），fail-closed 语义不变 |
| 14-CP1 | computer snapshot UIA 同步在 async | 对齐已正确路径 `spawn_blocking` |
| 10-S1 | shell 全量字节完成前无界驻留 | 硬上限 + 边写边 spill；**内存峰值有界** |
| 10-M1 | MCP stdout 整行无上限 | 行长上限 + 超限 `mark_exited`（**非静默**） |

**架构锁**：

1. **SSOT**：窗口读实现唯一（`conex-fs::windowed_read`）；Gatekeeper 实例唯一（进程级共享）；`semantics::analyze` 每命令恰 1 次（prepare 路径）。
2. **物理切除**：旧同步签名、per-call `new()`、重复 `analyze`、整读再切中间 `Vec`、完成前无界 `bytes.extend`、无界 `next_line()`——**删除代码**，禁止注释隐藏 / 兼容 Shim / 双轨回退。
3. **无双读实现**：禁止「壳一份、工具一份」窗口读；壳与工具必须消费同一 `windowed_read`。
4. **CFL-09 拆票**：Gatekeeper 共享 + analyze 单次 = **U-GATE**；DNS spawn_blocking + UIA snapshot = **U-GATE-DNS**。同发现簇、**不同任务单元**，禁止捆成单票拉长串行。

**范围外（交出，禁止本维吞并）**：

| 项 | 交接 |
| -- | -- |
| 预算常量 SSOT 建设（`perf_budget` 模块本体） | **D0 / U-BUDGET**；本维只 re-export 消费，不新建第三真源 |
| PE-02 / Progress / 双发 / ToolStart 实时 | 强契约维 |
| 工具输出 `output_budget_bytes` 默认接线 + ToolEnd Arc | **D1 / U-OUT-RS**（10-T4） |
| compaction 同步摘要 / G8 正常路径 | **D10** |
| estimate 缓存、搜索 watch 失效、PowerShell 常驻 helper 深改 | 其它维 / 可选增强 |
| DNS 正负缓存（BR2 深化） | 默认不做；单列安全裁决 |
| 导航事件化全改（BR3 深改） | 本维**只修条件反转 bug**（顺带正确性） |

---

## 1. 任务单元总览与依赖拓扑

```text
D0 预算 SSOT（前置 · 只读依赖）
  │
  ├──────────────────┬──────────────────┐
  ▼                  ▼                  ▼
U-BLOCK          U-GATE            U-GATE-DNS
壳三命令 async     SharedGatekeeper    DNS spawn_blocking
tools spawn_      清零 new()          UIA snapshot
blocking          analyze×1          （全程并行）
  │                  │
  │  （串行）        │
  ▼                  │
U-READ               │
conex-fs             │
windowed_read        │
唯一 SSOT + 双消费    │
  │                  │
  └────────┬─────────┘
           ▼
        U-MEM
     shell spill 提前
     MCP 行上限
     （依赖 D0 常量；与 U-BLOCK/U-GATE 可并行）
```

| 单元 | 内容 | 92 首轮位 | CFL-09 |
| -- | -- | -- | -- |
| **U-BLOCK** | 壳三命令 async + tools spawn_blocking 骨架 | 首轮 U-BLOCK | — |
| **U-READ** | `windowed_read` 唯一 SSOT + 壳/工具双消费 + 删整读 | **串行于 U-BLOCK** | — |
| **U-GATE** | SharedGatekeeper 清零 `new()` + analyze 单次 | 首轮 U-GATE | 采纳 02：构造面独立 |
| **U-GATE-DNS** | browser DNS + computer UIA spawn_blocking + BR3 条件修复 | 与 U-GATE 并行 | 采纳 02：与 U-GATE 拆 |
| **U-MEM** | shell spill 触发前移 + MCP 行上限 | 可与 U-BLOCK 并行（常量先引 D0 草案） | — |

**禁止顺序反例**：

1. 未删 per-call `CommandGatekeeper::new()` → 不得宣称「门禁已优化」。
2. 未做 `windowed_read` SSOT → 不得在壳与工具各写一份窗口读「先跑起来」。
3. 未把 shell spill 触发点前移到 `append` → 不得宣称「shell 内存有界」（结束后 spill 不解决完成前 OOM）。
4. 未设 MCP 行长上限 → 不得只靠超时掩盖 100MB 单行。
5. DNS/UIA 与 Gatekeeper 捆同一 PR → 违反 CFL-09，禁止。
6. U-READ 与 U-BLOCK 同 PR 大改同一 `tools/fs.rs` → 文件域串行，禁止并行 Agent 双改。

---

## 2. 删除 / 收敛总清单

### 2.1 物理删除

| # | 孤岛 / 旧路径 | 入口 → 出口 | 替代 | 发现 |
| -- | -- | -- | -- | -- |
| DEL-1 | 壳 fs 三命令同步 `fn` 签名 | `fs_commands/mod.rs:30,41,56` 三个 `pub(crate) fn` | `async fn` + 内部 `spawn_blocking` | 06-FS01 |
| DEL-2 | 壳 `read.rs` 整读 → `from_utf8` → `lines().count()` 中间路径 | `fs_commands/read.rs` 主循环 + 二次扫行 | `conex-fs::windowed_read`（U-READ） | 06-FS02 |
| DEL-3 | agent-tools `read_file` 整文件 `std::fs::read` + `lines().collect()` | `tools/fs.rs:105` 起整读段 | `windowed_read` + `spawn_blocking` | 06-SR02、10-T2 |
| DEL-4 | 全部生产 `CommandGatekeeper::new()` 站点 | shell.rs:235、process.rs:77、host_openers/execute.rs:97/180/304、cli_bridge.rs:101、readonly.rs:182 | 进程级共享（`SHARED_GATEKEEPER` / `Arc` 注入） | 14-SB1 |
| DEL-5 | shell prepare 内第 2、3 次 `analyze` | shell.rs:242 显式 analyze + permission.rs:149 `decide_command_with_revert` 内 analyze | 单次 `analyze`，Analysis 沿链传递 | 14-SB2 |
| DEL-6 | `OutputAccumulator.bytes` 完成前无界 `extend_from_slice` 唯一路径 | `shell_output.rs:142-149` | 硬上限 + append 时 spill；内存只持 preview + 短窗 | 10-S1 |
| DEL-7 | MCP stdout `next_line()` 无行长上限路径 | `bridge_session.rs:477-479` | 有界 `read_until`/`fill_buf` + 超限 `mark_exited` | 10-M1 |
| DEL-8 | `fuzzy_find` 每调用无缓存全量 walk | `tools/search.rs:487-490` | 会话级索引缓存（TTL/mtime），miss 仅 walk | 06-SR03 |
| DEL-9 | async 工具路径裸 `std::fs::` 直调形态（read/write/list/stat/search/replace/diff/project_tree） | `tools/fs.rs`、`search.rs`、`replace.rs`、`diff.rs`、`project_tree.rs` 对应 execute 体 | 全路径 `spawn_blocking`（骨架 U-BLOCK） | 06-SR01、10-T1 |

> 测试代码内 `CommandGatekeeper::new()` **允许保留**（`conex-sandbox` 单测、`r1_redline_chain.rs` 等）；生产路径 = 0。

### 2.2 收敛（N→M）

| 概念 | 现路径 | 目标 | 单元 |
| -- | -- | -- | -- |
| 文件窗口读 | 壳 `read.rs` 循环 + 工具 `fs.rs` 整读 = **2** | **1**（`conex-fs::windowed_read`） | U-READ |
| CommandGatekeeper 实例 | Shared + 各处 `new()` = **2 类** | **1**（进程级共享） | U-GATE |
| shell prepare `analyze` | **3** 次/命令 | **1** 次/命令 | U-GATE |
| shell 完成前内存 | 无界 bytes + 结束后 spill | append 边写边 spill + 硬顶 | U-MEM |
| MCP stdout 行 | 无界 | ≤ `MCP_STDOUT_MAX_LINE_BYTES` | U-MEM |
| 壳 fs 命令线程模型 | 同步 `fn` 占命令面 | `async` + blocking 池 | U-BLOCK |

---

## 3. 分任务四件套

### 3.1 U-BLOCK · 壳三命令 async + tools spawn_blocking

#### 做什么

1. **壳 fs 三命令**（`list_directory` / `read_file_content` / `write_file_content`）：
   - `pub(crate) fn` → `pub(crate) async fn`；
   - 同步 IO 核心（`directory::list_directory` / `read::read_file_content` / `write::write_file_content` 或抽 `*_blocking`）包 `tokio::task::spawn_blocking`；
   - 模式对齐同仓已正确范例：`select_folder`（`mod.rs:20-23`）、`core_search_files`（`core_commands.rs:144-160`）；
   - **wire 键不变**：`workbench_list_directory` / `workbench_read_file_content` / `workbench_write_file_content`；
   - 响应结构向后兼容扩字段时（`truncated` / `cursor` / `total` 等），同步 `workspaceFsApi.ts` 与 tool schema 仅当需要；无契约变更时不强制前端改。
2. **agent-tools 重 IO 工具** `async fn execute` 内，同步 `std::fs` 全路径包 `spawn_blocking`：
   - 必改清单：`read_file` / `write_file` / `list_dir` / `file_stat`（`tools/fs.rs`）；`grep_search` / `fuzzy_find`（`tools/search.rs`）；`replace`（`tools/replace.rs`）；`diff`（`tools/diff.rs`）；`project_tree`（`tools/project_tree.rs`）。
   - 闭包入参用 `PathBuf` / `Vec<u8>` / `String` / 值语义参数 **move**；`ToolContext` 非 `Send` 部分在闭包外准备。
   - `AbortToken` 检查保留在闭包外循环点（或闭包内可安全轮询处）；行为语义（错误码、输出形状）零变化。
3. **正面对照推广**：`conex-computer-tools/src/session.rs:186-201`（dispatch/screenshot）、`core_search_files`——本单元把范式推广到上述缺口，**禁止回潮**。
4. `list_directory`：条目上限/分页参数（默认值 re-export 自 D0 `FS_LIST_DIRECTORY_DEFAULT_LIMIT`，建议 2000）；超限响应带 `truncated`/`cursor`。
5. `write_file_content`：小文件可评估接 `conex_fs::atomic_write`；大文件保持直写但文档化契约（与 G4 配置面 atomic 语义区分——工具写**不要求**强制 sync_all）。
6. `list_directory` 内部硬编码跳过目录与搜索 SKIP_DIRS 不一致（06-FS05）：本单元**不顺带改语义**；仅在删除面与路径收敛需要时登记，避免静默行为漂移。

#### 删什么

- **DEL-1**：壳三命令同步 `fn` 签名（含仍保留同步转发壳的路径）。
- **DEL-9**：`async fn execute` 内裸 `std::fs::` 直调形态（整文件读的**完整语义删除**在 U-READ 的 DEL-3；本单元先保证不阻塞 worker）。
- 禁止「先留同步兼容分支再改」。

#### 依赖与逻辑序

- 概念依赖 **D0**（list 上限等常量定义位置）；实现可先对齐 D0 草案路径，U-BUDGET 落地后改 re-export。
- 与 **U-GATE** / **U-GATE-DNS** 并行（文件域不相交）。
- **阻塞 U-READ**：先 async/spawn_blocking 骨架绿，再在 U-READ 把整读换成 `windowed_read`。

#### 文件域

| 层 | 路径 |
| -- | -- |
| 壳 | `apps/agent-workbench/src-tauri/src/fs_commands/{mod,read,directory,write,types}.rs` |
| 工具 | `crates/agent-tools/src/tools/{fs,search,replace,diff,project_tree}.rs` |
| 前端（仅扩字段） | `apps/crish-desktop/src/api/workspaceFsApi.ts`（只读消费面协调，非本单元主改） |

**与并行维互斥**：不碰 `conex-sandbox` / gatekeeper / browser / computer / shell_output / bridge_session / D0 `perf_budget` 本体。

#### 验收

| 类 | 内容 |
| -- | -- |
| 功能 | `fs_commands` 现有单测全绿；`tools/fs.rs` / `search.rs` 现有单测全绿；大目录 list 不显著阻塞其它 invoke（运行时 V 项，通道=4000 Tauri MCP） |
| 负产出 | `fs_commands` 下 `#[tauri::command]` 非 `async` 的业务 `fn`（白名单外）= 0；`async fn execute` 函数体 `std::fs::` 直调 = 0（AST/正则门禁） |
| 五端物证 | 触发：真实 UI list/read/write + 模型 read_file；传输：wire 键不变；介质：响应兼容；消费：tokio worker 不被同步 IO 占满；负向：门禁脚本绿 |
| 路径 N→M | 同步命令 3 → async 3；重 IO 工具裸 `std::fs` 站点 N → 0 |
| 防御 | 扩展或新建 `scripts/check-async-commands.mjs`（或并入 check-tool-blocking-io）：非 async 白名单外 fail |

---

### 3.2 U-READ · conex-fs windowed_read 唯一 SSOT

#### 做什么

1. 在 `crates/conex-fs` 新增 **唯一** 窗口感知读实现（建议 API，名称可微调但**只允许一份**）：

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

2. **实现要点（非伪连通）**：
   - 读前 `metadata.len()`；若请求窗口小且文件大，**只读前缀/所需窗口字节**（UTF-8 边界处理），禁止整文件进内存；
   - 行数在扫描过程中维护，禁止 `from_utf8` 后再 `lines().count()` 二次全文扫；
   - 二进制探测用前缀（对齐壳 G3：`BINARY_SCAN_BYTES=8KB` 量级），禁止整文件读入后才判 binary。
3. **双消费**：壳 `read_file_content` 与 agent-tools `read_file` **全部改调此函数**；各自只保留参数解析、workspace 路径 guard、响应/JSON 组装。
4. **字段语义**：`lines` / `totalChars` **默认保持现有精确语义**——若窗口读无法 O(1) 精确全文行数，允许扫行**迭代计数**（不物化 `Vec<&str>`）；改「估算」语义须契约评审，**本维默认不改**。
5. **`fuzzy_find` 缓存**：`ToolContext`（或等价会话级槽）挂 `Arc<RwLock<Arc<Vec<String>>>>` 目录索引 + mtime/TTL；miss 时 `spawn_blocking` walk；与壳 `SharedSearchState` 同进程可装配层共享为**可选第二步**。

#### 删什么

- **DEL-2**：壳 `read.rs` 整读中间路径。
- **DEL-3**：工具 `read_file` 整读 + `lines().collect()` 全文指针表路径。
- **DEL-8**：`fuzzy_find` 无缓存全量 walk 每调用路径。

#### 依赖与逻辑序

- **串行于 U-BLOCK**（先有 `spawn_blocking` 包裹层与 async 签名）。
- 依赖 D0（`READ_FILE_MAX_BYTES_DEFAULT` 等定义位置）。
- **先** conex-fs 单实现 + 单测 **→** 再改壳 **→** 再改工具 **→** 删旧路径。禁止壳/工具各留「临时」旧读法。

#### 文件域

| 层 | 路径 |
| -- | -- |
| SSOT | `crates/conex-fs/src/windowed_read.rs`（新）、`crates/conex-fs/src/lib.rs` |
| 壳消费 | `fs_commands/read.rs`（及 `mod.rs` 仅签名对齐，若 U-BLOCK 已改则本单元不重复动签名） |
| 工具消费 | `tools/fs.rs`（read_file）；`tools/search.rs`（fuzzy 缓存）；`ToolContext` 扩展（索引槽） |

**互斥**：U-BLOCK 未收口前不同 Agent 并行改 `tools/fs.rs` 同段；不碰 U-GATE / U-MEM 文件。

#### 验收

| 类 | 内容 |
| -- | -- |
| 功能 | 既有 `read_file` 往返 / 截断 / `content_offset` 续读测试全绿；新增：大文件只读窗口的字节上限断言（tempfile 大文件 + 读计数或墙钟探针） |
| 负产出 | 全仓「整文件 `read` 后 `lines().collect()`」模式 = 0；`windowed_read` **实现仅 1 处**、调用点 ≥ 2（壳 + 工具） |
| 五端物证 | 触发：UI 预览大文件 + 模型 `read_file(50MB, 窗口 10 行)`；传输：wire 不变；介质：响应 `text` 仅窗口；消费：峰值 RSS / 墙钟明显低于整读；负向：脚本禁 `std::fs::read(` 整文件形态于读工具与壳 read |
| 路径 N→M | 窗口读实现 2 → **1**；壳/工具双消费 |
| 防御 | 检查脚本：`tools/fs.rs` 与 `fs_commands/read.rs` 禁止整文件 `std::fs::read(` 形态（应调 `windowed_read`） |

**禁止**：双读实现——壳自写一版、工具再写一版、或前端第三份窗口协议冒充 SSOT。

---

### 3.3 U-GATE · SharedGatekeeper 清零 new() + analyze 单次（CFL-09 拆票 · 构造面）

#### 做什么

1. **进程级共享实例**：在 `conex-sandbox` 提供
   `pub static SHARED_GATEKEEPER: LazyLock<CommandGatekeeper>`
   （正则集固定、无运行时配置依赖——最简正确；与 14-OK1 SharedGatekeeper 方向一致）。
2. 壳层 `SharedGatekeeper`（`core_commands.rs:70-77`）改为包装该静态（或持 `Arc<CommandGatekeeper>` 指向同一实例）；`main.rs:805` `app.manage` 保持，**内部不再二次 `new()`**。
3. 工具侧：`BuiltinToolConfig` / shell 工具构造接收 `Arc<CommandGatekeeper>`（或直接读 `SHARED_GATEKEEPER`）；shell / readonly 消费同一实例。
4. host openers / process.rs / cli_bridge **全部改读共享实例**。
5. **analyze 单次传递**：
   - `CommandGatekeeper` 增加 `check_command_with_analysis(&self, analysis, cmd, args)`（或 `check_command` 接受 `Option<&SemanticAnalysis>`）；
   - `permission::decide_command_with_revert` 增加接受已算 analysis 的重载（`decide_analysis_with_revert`）；
   - shell `prepare`：**先** `analyze(&command)` **一次** → 传门禁 → 传 decide → 自用 DeleteShape / cd 判定。
6. `full_line` 与 `command` 在 shell 路径 args 恒空时语义一致——保留 host openers 带 args 的拼入口径；**分析共享不得改变红线/审批判定结果**（字节级回归锚点）。

#### 删什么

- **DEL-4**：生产 `CommandGatekeeper::new()` 全部站点：
  `shell.rs:235`、`process.rs:77`、`execute.rs:97/180/304`、`cli_bridge.rs:101`、`readonly.rs:182`。
- **DEL-5**：prepare 内第 2、3 次 `analyze` 调用路径（显式 `semantics::analyze` + `decide_command_with_revert` 内再 analyze）。
- 测试内 `new()` 不删。

#### 依赖与逻辑序

- 先加共享实例与 API 重载（新增）→ 逐站点替换 `new()`（删除）→ 删重复 analyze。
- 与 **U-BLOCK / U-READ / U-GATE-DNS** 文件域基本不相交，可并行。
- **CFL-09**：不与 DNS/UIA 同 PR。

#### 文件域

| 层 | 路径 |
| -- | -- |
| 权威源 | `crates/conex-sandbox/src/lib.rs`（`SHARED_GATEKEEPER` + API） |
| 壳 | `apps/agent-workbench/src-tauri/src/{core_commands,process,cli_bridge}.rs`、`host_openers/execute.rs`、`main.rs`（仅 manage 注入若需） |
| 工具 | `crates/agent-tools/src/tools/shell.rs`、`permission.rs`、`readonly.rs` |

**互斥**：不碰 `fs_commands` / `tools/fs|search` 窗口读段 / `browser` / `computer` / `shell_output` / `bridge_session`。

#### 验收

| 类 | 内容 |
| -- | -- |
| 功能 | `conex-sandbox` 全部 gatekeeper 测试；shell 红线/审批矩阵；`process.rs` eleven red-line 测试；判定结果字节级不变 |
| 负产出 | 生产路径 `CommandGatekeeper::new()` grep = 0（测试允许）；shell prepare 路径 `analyze(` 调用次数 = 1 |
| 五端物证 | 触发：真实 shell 短命令批 + opener + readonly 过滤；传输：N/A（进程内）；介质：判定结果与修前一致；消费：批 shell 门禁段耗时下降（BV5）；负向：门禁脚本 |
| 路径 N→M | Gatekeeper 实例 2 类 → **1**；prepare analyze 3 → **1** |
| 防御 | `scripts/check-gatekeeper-shared.mjs` 或扩展 check：生产 `.rs` 禁止 `CommandGatekeeper::new`（测试/`conex-sandbox` 单测白名单） |

---

### 3.4 U-GATE-DNS · DNS / UIA 阻塞面（CFL-09 拆票 · 与 U-GATE 并行）

#### 做什么

1. **浏览器域门禁 DNS（14-BR1）**：`gate.rs` `SystemResolver::resolve`（`to_socket_addrs`，`gate.rs:39-41`）在 async 调用栈——工具层 `spawn_blocking(|| gate.check(url))` 或增加 async 变体；**fail-closed 语义不变**。
2. **computer snapshot UIA（14-CP1）**：对齐 `session.rs:186-201` 已正确路径，`snapshot` 的 UIA 遍历移入 `spawn_blocking`（现 `session.rs:211-214` 直接在 async 调 `perception.0.snapshot()`）。
3. **14-BR3 顺带正确性**：稳定 URL 仍 5×100ms 轮询——**条件反转修复**；事件化全改**单列后续**，不假装完成。
4. **明确不做默认项**：DNS 正/负缓存（BR2）默认不纳入；若做须安全评审（负缓存 + rebinding 窗口），单列裁决。

#### 删什么

- 无大块文件删除；收敛的是「async 栈内同步 DNS/UIA」**调用形态**（同步直调点 → 0）。

#### 依赖与逻辑序

- 文件域独立，**全程并行**于 U-BLOCK / U-READ / U-GATE / U-MEM。
- **禁止**与 U-GATE 捆单票（CFL-09）。

#### 文件域

| 层 | 路径 |
| -- | -- |
| 浏览器 | `crates/conex-browser-tools/src/gate.rs`、`tools/navigate*.rs`（及 exec 调用点） |
| 电脑 | `crates/conex-computer-tools/src/session.rs`（snapshot 路径） |

**互斥**：不碰 sandbox lib / shell prepare / fs_commands / tools/fs / shell_output / mcp。

#### 验收

| 类 | 内容 |
| -- | -- |
| 功能 | gate 全部 SSRF/fail-closed 测试；navigate 重定向用例；computer snapshot 测试 |
| 负产出 | async 工具路径禁止 `ToSocketAddrs` 直调；snapshot 路径存在 `spawn_blocking` |
| 五端物证 | 触发：browser navigate + computer_snapshot；介质：行为/错误语义不变；消费：DNS 慢解析不占满 worker；负向：静态扫描 |
| 路径 N→M | async 内同步 DNS/UIA 站点 N → 0；BR3 稳定 URL 空转轮询 5 → 条件满足即停 |
| 防御 | 并入 check-async / check-tool-blocking-io：async 路径 `ToSocketAddrs` 白名单外 fail |

---

### 3.5 U-MEM · shell spill 提前 + MCP 行上限

#### 做什么

1. **shell `OutputAccumulator`（10-S1）**：
   - `append`（`shell_output.rs:142-149`）时若累计字节 > `SHELL_MAX_OUTPUT_BYTES_DEFAULT × SHELL_ACCUM_HARD_CAP_FACTOR`，**切换为边写边 spill**（临时文件 + 仅 preview 在内存），禁止继续 `bytes.extend` 无界涨；
   - 结束时 `build_sync_result` 语义不变：截断判定、spill 路径、`logPath`、preview 头尾 24KB（常量来自 D0）；
   - 失败降级：spill 打开失败时保持现有有界 preview + truncated 标记，**不得 OOM**；
   - 常量：`PREVIEW_HEAD_BYTES` / `PREVIEW_TAIL_BYTES`（现 `shell_output.rs:17-19`）、`SHELL_MAX_OUTPUT_BYTES_DEFAULT`（现 `tools/mod.rs:157` 的 200_000 语义）→ re-export D0。
2. **MCP stdout（10-M1）**：
   - 自研 `read_until(b'\n', max_line_bytes)` 或对 `fill_buf` 累计超限，替换 `lines().next_line()` 无界形态（`bridge_session.rs:477-479`）；
   - 超限 → `mark_exited("stdout line too long")`（connection_failed 语义，**非静默**）；
   - 默认上限 `MCP_STDOUT_MAX_LINE_BYTES`（D0；建议 16MiB 量级、可配）。
3. stderr 环形尾保持（10-S-OK6，正面，禁止回潮）。

#### 删什么

- **DEL-6**：完成前唯一无界 `bytes.extend` 路径。
- **DEL-7**：无界 `next_line()` 读路径。

#### 依赖与逻辑序

- 依赖 D0 常量（可先引用草案路径，U-BUDGET 落地后改 re-export）。
- 与 U-BLOCK / U-GATE 可并行（不同文件）。
- **spill 逻辑已有**（结束后 `spill_full_output`）——本单元是**把触发点提前到 append 时**，不是新写落盘协议。

#### 文件域

| 层 | 路径 |
| -- | -- |
| shell | `crates/agent-tools/src/tools/shell_output.rs`、`shell_exec.rs`（若需接线） |
| MCP | `crates/agent-tools/src/mcp/bridge_session.rs` |

**互斥**：不碰 `tools/fs.rs` / `fs_commands` / sandbox / browser / computer / D0 本体。

#### 验收

| 类 | 内容 |
| -- | -- |
| 功能 | shell 既有单测全绿；MCP 假 server 超长行 → connection_failed |
| 负产出 | `OutputAccumulator` 无「无上限 extend」路径；stdout reader 上 `next_line()` = 0 |
| 运行时 V | 10-V4：`cat` 大文件完成前 RSS 有上界；10-V5：100MB 单行被挡住（通道 4000） |
| 路径 N→M | shell 完成前内存：无界 → hard_cap 有界；MCP 行：无界 → 1 上限 |
| 防御 | shell/MCP 计数探针单测；并入 check-tool-blocking-io / 独立小脚本 |

---

## 4. 文件域总表与并行边界

| 单元 | 主要文件域 | 可并行 | 串行阻塞 |
| -- | -- | -- | -- |
| U-BLOCK | `fs_commands/**`、`tools/{fs,search,replace,diff,project_tree}.rs` | U-GATE、U-GATE-DNS、U-MEM | **阻 U-READ** |
| U-READ | `conex-fs/windowed_read`、`fs_commands/read`、`tools/fs`、`tools/search`（fuzzy）、`ToolContext` | — | **串行于 U-BLOCK** |
| U-GATE | `conex-sandbox/lib`、`shell.rs`（prepare/门禁）、`permission`、`readonly`、`host_openers`、`process`、`cli_bridge`、`SharedGatekeeper` | U-BLOCK、U-GATE-DNS、U-MEM | — |
| U-GATE-DNS | `conex-browser-tools/{gate,navigate*}`、`conex-computer-tools/session`（snapshot） | 全程 | — |
| U-MEM | `shell_output`、`shell_exec`、`mcp/bridge_session` | U-BLOCK、U-GATE、U-GATE-DNS | — |
| D0（非本维主责） | `conex-shared/perf_budget`、`perfBudgets.ts`、`check-perf-budgets` | 本维只读消费 | 概念前置 |
| D1/D5/D10（非本维） | `run_launch` 输出预算、`executing_tools` Arc、compaction/G8 | — | — |

**跨单元规则**：

1. 同一文件只允许一个 Agent 主责；跨域只读。
2. U-BLOCK 与 U-READ **先后**，禁止同文件并行双改 `tools/fs.rs` 读路径。
3. U-GATE 与 U-GATE-DNS **禁止同 PR**（CFL-09）。
4. 本维不碰 D3 组提交 / D4 persist / D6 传输 / D7 渲染 / D9 门禁 CI / D11 契约实现。

---

## 5. 路径 N→M 汇总（任务书必答）

| 概念 | 现 N | 目标 M | 单元 |
| -- | -- | -- | -- |
| 壳 fs 同步命令 | 3 | 0（全 async） | U-BLOCK |
| 重 IO 工具裸 `std::fs` | N 站点 | 0 | U-BLOCK |
| 窗口读实现 | 2 | **1**（conex-fs） | U-READ |
| 生产 `CommandGatekeeper::new` | 6+ 站点 | **0** | U-GATE |
| shell prepare analyze | 3 | **1** | U-GATE |
| async 内同步 DNS/UIA | N | 0 | U-GATE-DNS |
| shell 完成前字节 | 无界 | hard_cap + spill | U-MEM |
| MCP stdout 行 | 无界 | 1 上限 | U-MEM |

---

## 6. 验收总表（功能 + 负产出 + 五端）

### 6.1 不变量（修复后必须成立）

| ID | 不变量 | 单元 |
| -- | -- | -- |
| INV-B1 | 生产 `CommandGatekeeper::new()` = 0 | U-GATE |
| INV-B2 | shell prepare 路径 `analyze` = 1 次/命令 | U-GATE |
| INV-B3 | async 工具/壳命令路径：裸阻塞 syscall = 0（白名单外） | U-BLOCK / U-GATE-DNS |
| INV-B4 | 窗口读实现 = 1（conex-fs）；壳/工具双消费 | U-READ |
| INV-B5 | shell 完成前内存峰值 ≤ hard_cap × 常数；MCP 行 ≤ max_line_bytes | U-MEM |
| （对齐 92 INV-3） | async 工具/命令：裸阻塞 syscall 于 worker = 0 | 全维 |

### 6.2 五端物证（维级）

| 端 | 物证 |
| -- | -- |
| 触发端 | 真实 UI 发起 list/read/write/shell/read_file；browser navigate；computer_snapshot；非单测 mock |
| 传输端 | 壳 fs wire 键不变；响应向后兼容扩字段 |
| 介质端 | shell 超预算输出落 spill 文件；工具超长 MCP 行 connection_failed |
| 消费端 | tokio worker 不被同步 IO/DNS/UIA 占满；run 中 abort 在阻塞段外仍可生效 |
| 负向断言 | 生产 `CommandGatekeeper::new()`=0；async 内裸 `std::fs`/`ToSocketAddrs`=0；窗口读实现=1；MCP 无界行=0 |

### 6.3 防御脚本 / 守护测试增量

| 脚本 / 测试 | 断言 | 单元 |
| -- | -- | -- |
| `check-async-commands`（新建或扩展） | 壳命令/工具 async 纪律；非 async 白名单 | U-BLOCK |
| check-tool-blocking-io（可并入） | `async fn` 内禁裸 `std::fs`；禁整文件 `std::fs::read` 于读路径 | U-BLOCK / U-READ |
| `check-gatekeeper-shared` | 生产禁 `CommandGatekeeper::new` | U-GATE |
| windowed_read 单测 + 双消费断言 | 实现数=1；调用点≥2 | U-READ |
| shell/MCP 计数探针单测 | 无界累加 / 超长行 | U-MEM |
| shell prepare analyze 计数 | =1 | U-GATE |

---

## 7. 运行时验证建议（待 4000 Tauri MCP 回填；禁止 9222/5174 验收）

| ID | 场景 | 指标 | 单元 |
| -- | -- | -- | -- |
| BV1 | 并行 4×大 `read_file` | 其它 async 任务延迟不显著上升 | U-BLOCK |
| BV2 | `read_file(50MB)` 只读 10 行 | 墙钟与峰值 RSS | U-READ |
| BV3 | shell `cat` 大文件 | 完成前 RSS 有上界 | U-MEM |
| BV4 | MCP 假 server 100MB 单行 | 被行长上限挡住 | U-MEM |
| BV5 | 批 shell 短命令 | 门禁段耗时下降（共享 Gatekeeper） | U-GATE |
| BV6 | browser 慢 DNS / computer_snapshot | worker 不被长阻塞占满 | U-GATE-DNS |

通道纪律：唯一合法 UI 宿主调试口 = `127.0.0.1:4000` Tauri MCP。

---

## 8. 与 92 / independent-02 / CFL-09 对齐说明

| 来源 | 吸收点 |
| -- | -- |
| 92 §4 D2 | 文件域 `fs_commands`、`agent-tools/tools`、`conex-fs/windowed_read`、SharedGatekeeper、browser/computer |
| 92 §6 删除面 | 壳/工具双整读 → windowed_read；SharedGatekeeper 旁路 new() 清零；summary 阻塞不在本维（D10） |
| 92 §10 | U-BLOCK + U-GATE 首轮；本详案补 U-READ / U-GATE-DNS / U-MEM 粒度 |
| independent-02 D1–D4/D7 | 任务内容与 DEL 编号主源；92 合并为单维 D2 |
| CFL-09 / review-plans-01 S1 | **强制拆** U-GATE 与 U-GATE-DNS；不采用 06「同票」 |
| 06/10/14 报告 | 证据锚点与正面 G/OK 防回潮 |

**诚实边界**：本详案基于静态走读 + 上游报告锚点；实现轮须复核行号漂移与注入链路长度；未跑 cargo 全量与 4000 MCP 运行时（方案产出轮非实现轮）。`BuiltinToolConfig` 注入 `Arc<CommandGatekeeper>` 若构造分散，以 `SHARED_GATEKEEPER` 静态兜底，**禁止**退回 per-call `new()`。

---

## 9. 执行纪律（本维子 Agent）

1. 四段任务书：做什么 / 不做什么 / 旧路径清单 / 完成自检（无 TODO、无第二路径）。
2. **主 Agent 唯一提交权**；子 Agent **禁止 `git commit`**；改动留工作区。
3. 每轮负产出：删除/收敛至少一项（本维 DEL 表勾选 + 负向断言）。
4. 禁止 `--no-verify`；禁止双读实现；禁止捆 CFL-09 两票。
5. 诚实汇报；发现任务书未覆盖问题上报主控裁决。

---

*detail-D2 · 2026-09-13 · 未 git commit · 上游 92 + independent-02 + CFL-09 + 06/10/14。*
