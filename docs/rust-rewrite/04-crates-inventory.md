# 04 — crates 资产盘点与缺口清单（A4）

> 状态：✅ 完成（Round 1 / Phase A）
> 范围：crates/conex-* 14 个 crate、packages/agent-provider-http、apps/agent-workbench/src-tauri/src、Cargo workspace
> 依据：所有结论均标注 `文件路径:行号`，可复核。
> 结论服务于 `docs/rust-rewrite/00-master-plan.md` 的 B1–B7 任务分解。

---

## 〇、Cargo workspace 混居现状（先说清）

- workspace members 共 15 项：app 1 + packages 1 + crates 13 —— `Cargo.toml:2-17`。
- **`crates/conex-telemetry` 不在 members 列表中**（`Cargo.toml:2-17` 无此项；`Cargo.lock` 也无 `conex-telemetry` 条目）。磁盘上有 14 个 crate，workspace 只收编 13 个，telemetry 是**孤儿 crate**（可独立 `cargo build -p conex-telemetry` 构建，但不参与 workspace 统一解析）。需决策：加入 members，或确认其被排除的原因。
- `packages/agent-provider-http` 是一个**二进制 crate**（`src/main.rs`，无 `lib.rs`），挂在 workspace 下（`Cargo.toml:4`），路径却在 `packages/`（TS 包混居目录）——是"TS 包与 Rust crate 混居"的典型例子。
- `workspace.dependencies` 中 `r2d2` / `r2d2_sqlite`（`Cargo.toml:46-47`）**没有任何 crate 使用**（conex-db 只用 `rusqlite`，见下），属于死依赖，可在重写时清理。
- 单 crate 直写依赖而非 workspace 的情况：`agent-provider-http`（reqwest 带 `stream` feature、tokio 精简 feature，`packages/agent-provider-http/Cargo.toml:16-17`）、`conex-sandbox`/`conex-markdown`（regex 直写 `crates/conex-sandbox/Cargo.toml:14`、`crates/conex-markdown/Cargo.toml:20`）。

---

## 一、crate 能力总表

### 1.1 总表

| crate | 职责（一句话） | 关键 API | 测试 | 可复用度 |
|---|---|---|---|---|
| conex-types | 全 workspace 共享类型 + 77 码错误体系（对齐 TS shared-types） | 见 1.2 | lib.rs 17 + error.rs 10（in-module） | ★★★★★ |
| conex-db | SQLite 会话/事件/子代理持久化（schema v3） | 见 1.3 | 25（in-module） | ★★★★★ |
| conex-net | reqwest 封装：超时/指数退避重试/NetError | 见 1.4 | 4（in-module） | ★★★☆（无流式/SSE） |
| conex-stream | 内存流会话 + 背压检测（同步缓冲） | 见 1.5 | 9（in-module） | ★★★☆（非 async 流） |
| conex-ipc | JSONL 行协议编解码 + 请求关联跟踪 | 见 1.6 | 7（in-module） | ★★☆（daemon 专用，直连方案下大部分弃用） |
| conex-compaction | 上下文压缩引擎 + 启发式 token 估算 | 见 1.7 | 10（in-module） | ★★★★（计数需评估精确化） |
| conex-sandbox | 命令门禁（正则黑/白名单 + workspace 上下文） | 见 1.8 | 9（in-module） | ★★★☆（仅门禁，非进程沙箱） |
| conex-search | 模糊匹配 + 文件索引（ignore crate） | 见 1.9 | 13（in-module） | ★★★★ |
| conex-fs | 路径安全 canonicalize / SHA-256 / 父目录创建 | 见 1.10 | 8（in-module） | ★★★★ |
| conex-diff | unified diff（similar crate，hunk 结构） | 见 1.11 | 8（in-module） | ★★★★ |
| conex-markdown | markdown → HTML 渲染（pulldown-cmark+syntect+ammonia+moka） | 见 1.12 | in-module 21 + tests/integration.rs 87 + tests/parity_fixtures.rs 4 | ★★★★★（UI 侧保留） |
| conex-telemetry | tracing 初始化 / panic hook / crash 兜底 | 见 1.13 | tests/catch_unwind.rs 2 | ★★★★（⚠️ 孤儿 crate，未入 workspace） |
| conex-test-utils | 测试基建：临时目录 / roundtrip 断言 / tracing 初始化 | 见 1.14 | 3（in-module） | ★★★★ |

测试说明：除 conex-markdown、conex-telemetry 外，所有 crate 均为 `#[cfg(test)]` in-module 测试，**无 `tests/` 目录**（已用 glob 核实 `crates/*/tests/**/*.rs` 仅上述两个 crate 有）。

### 1.2 conex-types（`crates/conex-types/src/lib.rs` 519 行 + `error.rs` 925 行）

职责：**单一类型源**，对齐 TS 端 `packages/shared-types` 与 crish-desktop store 类型，serde camelCase 序列化。

公开 API：
- Diff 域：`DiffResult` / `DiffHunk` / `DiffLine` / `DiffLineKind`（`lib.rs:5-35`）
- 搜索域：`FileHit`（`lib.rs:39-45`）
- 压缩域：`Message` / `CompactionResult`（`lib.rs:49-65`）
- IPC 域：`IpcEnvelope` / `IpcResponse`（`lib.rs:69-86`）
- 流域：`StreamChunk { data, is_final }`（`lib.rs:90-94`）
- 会话持久化域：`SessionMessage`（`lib.rs:99-123`）、`SessionAgent`（`lib.rs:126-153`）、`SessionIndexEntry`（`lib.rs:155-184`）、`ImportStats`（`lib.rs:191-200`）
- Tauri 命令错误：`CoreError`（serde tagged enum，`lib.rs:207-232`）
- 错误体系（`error.rs`）：`CrishErrorCategory`（`error.rs:26-35`）、`CrishErrorInfo`（`error.rs:39-46`）、`codes` 模块 **77 码 / 20 域**（`error.rs:53-151`，含 provider 17 码 `error.rs:75-91`、event_store 4 码 `error.rs:122-126`）、`CRISH_ERROR_REGISTRY`（`error.rs:154-562`）、`info(code)` 查询（`error.rs:565-574`）、`CrishError`（struct 非 enum，`error.rs:590-680`，builder 式 `with_category/with_retryable/with_metadata/with_cause`）、`CrishErrorPayload`（IPC 序列化类型，`error.rs:686-733`）、`from_unknown`（`error.rs:711-727`）、`From<CoreError>` 无损映射（`error.rs:738-780`）、cause 链深度上限 8（`error.rs:21`）。

缺口：**没有 AgentEvent / ToolCall / 会话状态机类型**——这是 B1 的明确任务（`00-master-plan.md:87`）。现有 SessionMessage 只有 `tool_calls_json: Option<String>` 这种字符串承载（`lib.rs:117-122`），没有结构化的工具调用/事件类型。

### 1.3 conex-db（`crates/conex-db/src/lib.rs` 1659 行）

职责：SQLite 会话与事件持久化，**schema_version=3**。

- **注意：不是 r2d2**。`LocalDb` 是 `Arc<Mutex<Connection>>` 单写者模型 + failure latch（`lib.rs:14-20`）。workspace 里的 r2d2/r2d2_sqlite 未使用。
- 打开：`open(path)` / `open_in_memory()`（`lib.rs:25-52`），迁移自动执行（`lib.rs:55-230`）。
- 表结构：`sessions`（含 `engine_cursor`/`engine_last_run_id`/`hydrated_from_engine`/`branch_parent_id`，`lib.rs:100-116`）、`events`（`(session_id, sequence)` UNIQUE，`lib.rs:118-129`，**可用作事件源**）、`metadata`（`lib.rs:131-134`）、`session_messages`（`lib.rs:136-154`）、`session_agents`（`lib.rs:156-172`）、`session_agent_messages`（`lib.rs:174-191`）、`session_meta`（KV，`lib.rs:193-196`）、message_count 触发器（`lib.rs:198-208`）。
- API 清单（全部 `pub fn`）：`insert_session`（`lib.rs:233`）、`append_event`（`lib.rs:249`）、`query_events(after_sequence, limit)`（`lib.rs:274`）、`upsert_session_entry`（`lib.rs:318`，ON CONFLICT DO UPDATE 防级联误删）、`list_sessions`（`lib.rs:367`）、`load_session_body`（`lib.rs:412`）、`save_session_body`（事务先删后插，`lib.rs:454`）、`append_session_messages`（`lib.rs:508`）、`delete_session`（级联，`lib.rs:568`）、`load_session_agents`（含消息，`lib.rs:584`）、`save_session_agents`（`lib.rs:664`）、`get_session_meta`/`set_session_meta`（`lib.rs:747/766`）、`cleanup_orphan_sessions`（`lib.rs:784`）、`import_from_localstorage`（localStorage 迁移，`lib.rs:836`）、`touch_session`（`lib.rs:1043`）、`get_failure`/`clear_failure`（`lib.rs:1059/1064`）。
- 辅助类型：`DbFailure { message, kind }`（`lib.rs:8-12`）、`StoredEvent`（`lib.rs:1126-1134`）。

评估：**能支撑会话与事件持久化**（events 表 + 事件查询游标语义已具备）。缺口：无 run/checkpoint/plan-document/artifact 表（这些现在由 daemon 内存或 TS 侧管理），无 provider 配置表。

### 1.4 conex-net（`crates/conex-net/src/lib.rs` 173 行）

职责：reqwest 薄封装，超时 + 指数退避重试。

- `NetClient::new()`（默认 30s 超时 / 2 次重试，`lib.rs:11-13`）、`with_config(timeout, max_retries)`（`lib.rs:16-27`）、`get(url, headers)`（`lib.rs:30`）、`post(url, headers, body: Option<String>)`（`lib.rs:35`），内部 `request_with_retry`（退避 100ms×2^n，`lib.rs:44-102`）。
- `NetResponse { status, headers, body: Vec<u8> }` + `body_as_string()`（`lib.rs:111-122`）。
- `NetError { ConnectionFailed, Timeout }`（`lib.rs:124-139`）。

局限：**只整包收 body（`response.bytes()`，`lib.rs:87`），无流式/SSE**；body 只能是 String；重试仅覆盖连接层错误；无代理/自定义 CA。provider 层需要流式时此 crate 须扩展（或直接在 agent-provider 内用 reqwest）。

### 1.5 conex-stream（`crates/conex-stream/src/lib.rs` 253 行）

职责：单流生命周期管理 + 背压检测。

- re-export `StreamChunk`（`lib.rs:4`）、`BackpressureSignal { buffered_bytes, threshold }`（`lib.rs:7-11`）、`StreamState { Open, Closed, Aborted }`（`lib.rs:14-19`）。
- `StreamSession::new(backpressure_threshold)`（`lib.rs:32`）、`push`（返回 `Result<Option<BackpressureSignal>, StreamError>`，`lib.rs:49`）、`drain`/`drain_all`（`lib.rs:76/83`）、`abort`/`close`（`lib.rs:90/97`）、`buffered_bytes`/`total_received`/`buffered_chunks`/`is_backpressured`（`lib.rs:104-121`）。
- `StreamError::NotOpen`（`lib.rs:124-127`）。

局限：**同步内存 VecDeque 缓冲，不是 tokio Stream，无异步取消/背压联动**。00-master-plan 说"背压"在删除清单里（`00-master-plan.md:39`）——本 crate 在 IPC 直连方案下基本退化为"无用"，除非 agent-core 的流式事件队列复用其状态语义。

### 1.6 conex-ipc（`crates/conex-ipc/src/lib.rs` 193 行）

职责：daemon 通信的 JSONL 行协议编解码 + 请求关联（correlation）。

- `encode`/`decode`（信封，`lib.rs:8-21`）、`encode_response`/`decode_response`（`lib.rs:24-37`）、`IpcError`（`lib.rs:39-45`）。
- `CorrelationTracker::new(timeout)` + `track/complete/is_pending/collect_expired/pending_count`（`lib.rs:61-108`）。

评估：为 **daemon stdio/WS 协议**服务。IPC 直连方案下（engine 进 Tauri 进程），stdio 信封协议弃用；仅当"工具执行走子进程"或"MCP 桥接"时才可能复用 correlation 思想。

### 1.7 conex-compaction（`crates/conex-compaction/src/lib.rs` 297 行）

- `CompactionEngine::new(max_tokens)` + `compact(&[Message]) -> CompactionResult`（策略：保 system + 最近 2 条，中间从新到旧装填，超预算合并为 summary 占位，`lib.rs:4-128`）。
- `count_tokens(text)` 启发式估算（ASCII≈4 字符/token，CJK≈1 token/字，`lib.rs:134-173`）。

评估：策略本身（system 保留/最近保留/中间压缩）可复用；**token 计数是启发式非 tiktoken 精确**，若 provider 预算需精确需评估 tiktoken-rs 或保持近似。

### 1.8 conex-sandbox（`crates/conex-sandbox/src/lib.rs` 201 行）

- `GatekeeperResult { Allowed, Blocked, RequiresApproval }`（`lib.rs:5-11`）。
- `CommandGatekeeper::new()`（内置 Unix/Windows 破坏性命令黑名单 + git push --force / publish / sudo 审批名单，`lib.rs:18-57`）、`check_command(cmd, args)`（`lib.rs:63-83`）、`check_command_with_context(cmd, args, cwd, workspace_root)`（越界升级 RequiresApproval，`lib.rs:87-109`）、`patterns()`（`lib.rs:59`）。

评估：**命令审批策略可复用**（agent-tools 的 shell 工具直接受益）；但它不是进程沙箱（无隔离、无资源限制），真正的沙箱不在现有资产内。

### 1.9 conex-search（`crates/conex-search/src/lib.rs` 358 行）

- `fuzzy::FuzzyMatcher::new(case_sensitive)` / `score_and_indices` / `score`（子序列打分 + 连续/词边界/大小写精确奖励，`lib.rs:4-96`）。
- `search::search_files(query, paths, limit, matcher)`（`lib.rs:108-144`）、`search_files_parallel`（thread::scope 并行，`lib.rs:147-179`）。
- `walker::build_directory_index(dir)`（ignore crate，跳过 .git/node_modules 等，`lib.rs:182-230`）。

评估：工具层 search 直接复用；`build_directory_index` 与 `core_rebuild_search_index` 命令对应（`apps/agent-workbench/src-tauri/src/core_commands.rs:93`）。

### 1.10 conex-fs（`crates/conex-fs/src/lib.rs` 167 行）

- `path_utils::safe_canonicalize(path, max_depth)`（拒绝 `..` 遍历、null 字节、深度上限，`lib.rs:7-59`）、`compute_file_hash`（SHA-256 hex，`lib.rs:62-72`）、`ensure_parent_dir`（`lib.rs:75-86`）。

评估：工具层 fs 工具（读/写/哈希/路径校验）直接复用；注意**没有文件读写的封装**（只有路径与哈希），读写逻辑在 Tauri 壳 fs_commands 或 TS 侧。

### 1.11 conex-diff（`crates/conex-diff/src/lib.rs` 263 行）

- `DiffEngine::new()` / `diff(old, new) -> DiffResult`（similar TextDiff 行级 + 3 行上下文 hunk 分组，`lib.rs:7-57`）、`compute_diff`（实例方法委托，`lib.rs:54-56`）、内部 `build_hunks`（`lib.rs:66-156`）。

评估：直接复用（对应 `core_compute_diff` 命令，`apps/agent-workbench/src-tauri/src/core_commands.rs:147`）。

### 1.12 conex-markdown（`crates/conex-markdown/src/lib.rs` 35 行 + 6 子模块）

- `render_markdown`（`src/renderer.rs:657`）、`render_markdown_batch`（`renderer.rs:676`）、`render_markdown_stream(text, stream_mode)`（跳过 syntect 高亮的流式模式，`renderer.rs:689`）、`strip_thought_placeholders`（`renderer.rs:729`）、`highlight_code`（`src/highlight.rs:82`）、`clear_cache`（`highlight.rs:126`）、`sanitize`（ammonia，`src/ammonia_config.rs:62`）、URL 安全系列（`src/sanitizer.rs:50-291`）、表格系列（`src/table.rs:11-109`）、`MAX_MARKDOWN_INPUT` 上限（`lib.rs:26`）。
- 测试完备度最高：in-module 21 + `tests/integration.rs` 87 + `tests/parity_fixtures.rs` 4。

评估：UI 渲染路径（md_render 等 5 个命令，`apps/agent-workbench/src-tauri/src/main.rs:132-136`）完全保留，与重写正交。

### 1.13 conex-telemetry（`crates/conex-telemetry/src/lib.rs` 27 行 + 4 子模块）

- `init_default(level)`（EnvFilter + 紧凑格式，`src/subscriber.rs:32`）、`install_panic_hook`（链式 panic hook，`src/panic_hook.rs:29`）、`catch_unwind`（→ `CrishErrorPayload`，`src/crash.rs:48`）、`format_error_chain`/`truncate_string`（`src/format.rs:20/42`）。
- 依赖方向声明为 leaf（只依赖 conex-types 的 CrishErrorPayload，`Cargo.toml:20-22` 注释）。
- ⚠️ **不在 workspace members**（`Cargo.toml:2-17`），`Cargo.lock` 无条目——重建 workspace 解析时需补入。

评估：引擎侧日志/panic/crash 兜底直接复用；`catch_unwind` 对 Tauri command 包装很有价值。

### 1.14 conex-test-utils（`crates/conex-test-utils/src/lib.rs` 104 行）

- `setup_test_env()`（幂等 tracing 初始化，`lib.rs:8-13`）、`TempWorkspace`（RAII 临时目录，`lib.rs:16-55`）、`assert_json_roundtrip<T>`（`lib.rs:58-65`）。

评估：新 crate（agent-core/agent-provider/agent-tools）的测试直接依赖。

---

## 二、packages/agent-provider-http 现状评估

文件：`packages/agent-provider-http/src/main.rs`（189 行，**二进制 crate，无 lib.rs**）+ `Cargo.toml`（18 行）。

**现状能力**（stdin/stdout 子进程 HTTP 代理）：
1. 请求协议：行分隔 JSON `HttpRequest { method, url, headers, body, timeoutMs, streamBody }`（`main.rs:4-16`）。
2. 响应协议：首行 JSON `HttpResponseHeader { status, statusText, headers, error, chunked }`（`main.rs:18-28`），`chunked=true` 后跟分块帧流——数据帧 `<十进制长度>\n<字节>`、结束帧 `0\n`、错误帧 `-1\n<错误信息>\n`（`main.rs:131-136`、`main.rs:146-176`）。
3. 方法支持 GET/POST/PUT/DELETE/PATCH/HEAD/OPTIONS（`main.rs:86-95`）；每请求可设 timeout（`main.rs:98-100`）。
4. 连接池跨请求复用（进程启动建一次 `reqwest::Client`，`main.rs:33-41`）；单线程 current_thread runtime（`main.rs:30-32`）。
5. 依赖：`reqwest 0.12 features=["stream","json"]`、`tokio rt+macros+io-std`、`tracing`（`Cargo.toml:16-17`）——**注意 reqwest 带 stream feature 且是直写非 workspace**（workspace 的 reqwest 无 stream feature，`Cargo.toml:38`）。

**评估**：
- 它是 **TS daemon 的 HTTP 出口子进程**（为绕过 Node 侧网络栈 / CORS 而生），协议面向子进程双向管道。
- 在 Rust 重写（engine 进 Tauri 进程）后，**它作为独立二进制失去存在意义**：其职责（reqwest client + 流式 body 转发）应吸收进新的 **agent-provider lib crate**，成为进程内模块（SSE 解析 + 流式读取直接走内存/通道，不再需要帧协议）。
- 它目前**没有任何 provider 语义**：无 openai/anthropic/gemini 协议层、无 SSE 事件解析、无错误分类/重试、无 token 计数。只能算"HTTP 传输层半成品"。
- 建议：`packages/agent-provider-http` 目录改造为 `crates/agent-provider`（或新建并删除本目录），chunked 帧协议文档化后弃用。

---

## 三、Tauri 壳（apps/agent-workbench/src-tauri）保留/删除清单

顶层结构：`src/main.rs`（setup + 命令注册）+ 15 个模块、56 个 rs 文件（实测文件清单，`src-tauri/src/` 下）。

### 3.1 main.rs 现状（`src/main.rs`）

- setup（`main.rs:192-280`）：`sidecar::init_state()`（`main.rs:194`）→ `config::init_api_config_store()`（`main.rs:195`）→ `SharedSearchState`（`main.rs:196`）→ **SharedDb：app_dir()/sessions.db，失败降级内存 DB**（`main.rs:201-234`）→ **sidecar 自启循环（无限重试，指数退避 300ms×2^n 封顶 5s）**（`main.rs:238-277`）。
- 命令注册：`make_handlers!` 宏（`main.rs:24-154`）——sidecar 转发命令约 60 个（`main.rs:27-80`）+ 本地命令（process/pty/fs/config/core/session/markdown/perf/power）。
- 退出钩子：kill 所有 PTY（`main.rs:289-291`）。

### 3.2 可保留（IPC 直连方案下原样或小改）

| 模块 | 文件 | 保留理由 |
|---|---|---|
| session_commands | `src/session_commands.rs`（11 个命令，SharedDb `:23-58`） | 会话持久化命令层，直接服务 UI；引擎侧写入同一 SQLite |
| core_commands | `src/core_commands.rs`（16 命令 + SharedSearchState `:34`） | search/compact/tokens/check_command/diff/hash/encoding 全部对应 agent 工具能力 |
| config | `src/config/`（ApiConfigStore `provider.rs:30-37`、CredentialStore（DPAPI）`credentials.rs:13-22`、4 个 profile secret 命令 `mod.rs:65-141`） | **provider 配置/凭据管理已经在 Rust 侧**，重写时抽取为可复用 crate |
| markdown_commands | `src/markdown_commands.rs` | UI 渲染 |
| fs_commands | `src/fs_commands/` | UI 文件操作 |
| perf | `src/perf/` | worker 池命令 |
| process（部分） | `src/process.rs` | `workbench_run_shell` 是 shell 工具执行的现成后端（937 行，含 Job Object 树管理） |
| pty | `src/pty/` | 交互终端保留 |
| power / host_openers / host_paths / error_bridge | `src/power.rs` 等 | 与引擎无关的壳能力 |

### 3.3 可删除（WS daemon 转发链，约 2.2 万行）

| 模块 | 文件 | 说明 |
|---|---|---|
| sidecar/connection | `src/sidecar/connection/{lifecycle,query,disconnect,process_mgmt,helpers}.rs` | WS 连接、握手（protocol v1，`lifecycle.rs:25`）、命令发送（`query.rs:62/309/357`）、重连退避（`lifecycle.rs:55-120`） |
| sidecar/supervisor | `src/sidecar/supervisor.rs` | daemon 状态机快照（Ready/Starting/Degraded…，`types.rs:95-103`） |
| sidecar/pending | `src/sidecar/pending.rs` | pending 响应关联（oneshot 匹配 `pending.rs:17-54`） |
| sidecar/run_stream | `src/sidecar/run_stream.rs` | 断线重放恢复（cursor `types.rs:148-157`） |
| sidecar/commands | `src/sidecar/commands/{status,session,run,config,plan,action}_commands.rs` + `tests.rs`（25KB） | 全部是"组装 daemon JSON 协议命令再 WS 转发"（如 `run-task` 组装 `commands/mod.rs:124-178`）；语义面（approve/deny/artifacts/checkpoints/rewind/subagent/memories/plan-docs/git）需在 IPC 直连下用新命令等价重实现 |
| daemon_discovery | `src/daemon_discovery.rs` | TS daemon 启动解析（entry=`packages/agent-daemon/src/index.ts`，`daemon_discovery.rs:26`；bun/npx/tsx 四种模式 `:31-37`）——整文件删除 |
| commands.rs 的 http | `src/commands.rs:31-85` | `workbench_http_request`（/models 探测）改由 agent-provider 提供 |
| main.rs 中 sidecar 部分 | `main.rs:27-80`（60 个 sidecar 命令注册）、`main.rs:238-277`（自启循环） | 删除 |
| cli_bridge | `src/cli_bridge.rs`（dev-only，`main.rs:159-167`） | 可选删除 |

依据：00-master-plan 删除清单（`00-master-plan.md:39-40`："删除 WS daemon 链路（sidecar、WS 协议、背压、StreamRecovery…）"、`00-master-plan.md:102`："删除 Tauri 壳内 sidecar/WS 转发层"）。

---

## 四、缺口清单（Rust 侧必须新建）

### 4.1 新建模块 + 建议归属

| # | 模块 | 内容 | 建议归属 | 依据/说明 |
|---|---|---|---|---|
| G1 | **Agent 事件与工具类型** | `AgentEvent`（消息/文字增量/thinking/tool-call/tool-result/run 状态…）、`ToolCall`/`ToolResult`、会话状态机枚举 | **conex-types 扩展**（B1） | 现无此类（`lib.rs:99-123` 只有 UI 对齐的 SessionMessage）；`00-master-plan.md:87` |
| G2 | **SSE 流解析** | `text/event-stream` 分帧：`data:`/`event:`/`[DONE]`/错误帧；与 reqwest `bytes_stream` 集成 | **新 crate agent-provider** | agent-provider-http 只有字节帧协议无 SSE 语义（`main.rs:146-176`）；workspace reqwest 无 stream feature（`Cargo.toml:38`） |
| G3 | **session-loop 状态机** | run 生命周期（queued→running→awaiting_tool→completed/error/aborted）、stop/abort 协作语义、max_rounds/停滞检测 | **新 crate agent-core** | `00-master-plan.md:88`（B3）；分歧点 D1/D2/D5/D6（`00-master-plan.md:121-128`） |
| G4 | **steering / control** | approve/deny 工具、steer 输入注入、intervention-required | **agent-core** | 现 Tauri 壳只有转发（`main.rs:53-54`） |
| G5 | **orchestrator** | 会话/run 注册、事件队列、事件→conex-db 持久化、恢复 | **新 crate agent-orchestrator**（或并入 agent-core） | `00-master-plan.md:89`（B4）；conex-db events 表可做事件源（`conex-db/src/lib.rs:118-129`） |
| G6 | **工具执行器** | 工具注册表 + fs/shell/search 执行 + 入参 JSON Schema 校验 + 输出结构化 | **新 crate agent-tools** | 复用 conex-fs/search/sandbox/compaction；`00-master-plan.md:91`（B5）；入参校验可用 lock 中已有的 schemars |
| G7 | **存储 schema 扩展** | run 表（run_id/session_id/状态/cursor）、checkpoint 表、provider 配置表 | **conex-db 扩展** | 现有 7 表无 run/checkpoint（`conex-db/src/lib.rs:100-196`）；checkpoint/rewind 命令现由 daemon 提供（`main.rs:74-78`） |
| G8 | **provider 配置/凭据 crate** | 从 Tauri 壳 `config/` 抽取：ApiConfigStore + CredentialStore（DPAPI/windows-sys）+ env 合并 | **新 crate agent-config**（或并入 agent-core） | 代码已存在（`config/provider.rs:30-37`、`config/credentials.rs:13-22`、`config/mod.rs:21-22`），重写时抽出而非重写 |
| G9 | **provider HTTP 协议层** | openai-compatible chat-completions 先行：请求构建（含 thinking 透传）、响应解析、错误分类（复用 `codes.provider.*` 与 retryable） | **agent-provider** | `00-master-plan.md:88`（B2）；错误码已齐备（`conex-types/src/error.rs:75-91`） |
| G10 | **token 计数精确化（可选）** | tiktoken 级精确预算 | conex-compaction 扩展或 agent-provider | 现有启发式（`conex-compaction/src/lib.rs:134-173`）；首轮可保持近似 |

### 4.2 OAuth 评估：本轮不必须

- 现凭证模型 = API key（环境变量 + DPAPI 落盘 + 内存降级），**无 OAuth 依赖**（`config/credentials.rs:13-66`）。
- 错误体系已为 OAuth 预留：`PROVIDER_NO_TOKEN`/`PROVIDER_REAUTH_REQUIRED`/`PROVIDER_REFRESH_FAILED`（`conex-types/src/error.rs:306-325`），但无对应运行时。
- TS 侧 OAuth 全套在 agent-model（`00-master-plan.md:14`），而 D3 决策默认 chat-completions + API key（`00-master-plan.md:125`）。
- 结论：**OAuth 推迟到 provider 层稳定后**（届时需新增 oauth2/open/keyring 依赖）。首轮以"API key 直连 + 环境变量 + DPAPI"为准。

---

## 五、Cargo 依赖现状与新增候选

### 5.1 workspace.dependencies 已有（`Cargo.toml:33-62`）

serde（derive）、serde_json、tauri 2（protocol-asset）、tauri-build、reqwest 0.12（default-features=false，json+rustls-tls，**无 stream**）、tracing（attributes）、tracing-subscriber、anyhow、thiserror 2、tokio（full）、async-trait、rusqlite 0.31（bundled）、**r2d2 + r2d2_sqlite（死依赖，无人用）**、notify 8、ignore 0.4、sha2、hex、bytes、futures-util、tokio-tungstenite 0.21、derive_builder 0.20、similar 2、pulldown-cmark 0.12（simd）、syntect 5、ammonia 4、moka 0.12（sync）、once_cell、url 2。

### 5.2 Cargo.lock 已有（传递依赖，可直接转直接依赖，**不重复新增**）

uuid、chrono、schemars（工具入参 JSON Schema 生成）、serde_with、json-patch、zeroize（凭据内存清零）、rand（重试抖动）、rayon、tokio-util、tempfile、indexmap、parking_lot、base64、urlpattern、shell-words、http、serde_urlencoded、async-trait、derive_more、bstr（已随 ignore）。

### 5.3 需要新增的依赖候选

| 依赖 | 用途 | 必要性 | 备注 |
|---|---|---|---|
| **tokio-stream** | SSE 分帧（`StreamReader` 按行拆 `\n\n`）、字节流工具 | 必须 | **lock 中无此 crate**，需新增 |
| **futures**（或继续 futures-util） | Stream/Sink trait 组合（workspace 已有 futures-util 0.3，`Cargo.toml:53`） | 建议 | lock 中只有 futures-util 等子 crate，无 `futures` 主 crate；若只需 futures-util 则不加 |
| **eventsource-stream / reqwest-eventsource**（或自研 ~100 行） | SSE 事件解析 | 可选 | 建议自研（协议简单，且要挂 CrishError 错误分类） |
| **tiktoken-rs** | 精确 token 预算 | 可选 | 首轮可保持 conex-compaction 启发式 |
| **uuid** | run/event id 生成 | 建议 | 已在 lock（传递），加为 workspace 直接依赖 |
| **chrono**（或保持 epoch ms） | 时间戳 | 可选 | 现有代码全用 epoch ms（`conex-types/src/lib.rs:110`），可不加 |
| **schemars** | 工具入参 JSON Schema | 建议 | 已在 lock，转直接依赖 |
| **zeroize** | 凭据内存安全 | 建议 | 已在 lock（zbus 带入） |
| oauth2 / open / keyring | OAuth 流 | **本轮不加** | 见 4.2 |
| r2d2 / r2d2_sqlite | 连接池 | **删除** | 死依赖（conex-db 用 `Arc<Mutex<Connection>>`） |

### 5.4 需要调整的现有依赖

- **reqwest 补 `stream` feature**：workspace 声明（`Cargo.toml:38`）需加 `stream`（agent-provider-http 已示范：`packages/agent-provider-http/Cargo.toml:16`），否则 SSE 无法 `bytes_stream()`。
- **conex-telemetry 补入 workspace members**（`Cargo.toml:2-17`），否则新 crate 无法用 `path` 依赖引用它（workspace 解析规则）。
- agent-provider-http 的 tokio 精简 feature（`Cargo.toml:17`）与 workspace `tokio full`（`Cargo.toml:43`）不一致，合并后统一走 workspace。

---

## 附：遗留问题（下轮消化）

1. conex-telemetry 为何被排除出 workspace？（`Cargo.toml:2-17` 与磁盘 14 crate 不一致）
2. conex-stream 在 IPC 直连下是否保留（作为 agent-core 事件队列的状态模型）还是删除。
3. agent-provider-http 目录是改造为 `crates/agent-provider` 还是新建后删除（`packages/` 下混居需清理）。
4. 会话存储：run/checkpoint 落库的 schema 版本（当前 `schema_version=3`，`conex-db/src/lib.rs:223-227`）何时升 4。
