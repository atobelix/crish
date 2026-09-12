# 10-工具执行与MCP桥审查报告

> **战役**：全面性能审查（performance-audit），方向 10 / 共 16 方向
> **总纲**：`docs/performance-audit/00-性能审查总纲.md`
> **日期**：2026-09-12
> **检查对象**：`crates/agent-tools/`（注册 / 执行 / 输出 / 幂等 / 中间件 / MCP）、`crates/session-loop/` 工具调度面（`tool_exec` / `exec_batch` / `exec_single` / `executing_tools` / `approval*`）、MCP stdio JSON-RPC 桥、shell / fs / search / replace / project_tree 输出与缓冲、`conex-browser-tools` / `conex-computer-tools` 与壳层 `browser/` `computer/` 重路径（简要）
> **方法**：静态代码走读 + 证据链（`文件路径:行号`）+ 与 02（工具卡片渲染）/ 03（tool-end IPC payload）交叉；全部结论为静态分析，运行时未实测项在 §9 单列
> **与 02/03 的关系**：02 覆盖前端工具卡片渲染热路径；03 覆盖 tool-end 上桥与 IPC 序列化；本方向覆盖**执行侧吞吐、阻塞、缓冲、MCP 往返**。tool-end 多重 clone 在 03 C1 已指出 IPC 侧未 Arc——本文补齐执行器到事件层的完整拷贝链证据。

---

## 0. 阅读指南

- 编号规则：**T**=工具执行器与内置工具域、**S**=shell 子系统、**M**=MCP stdio 桥、**B**=browser/computer（简要）。
- 严重度定义对齐 01/03：高=真实 run 中可系统性放大延迟/内存或阻塞 runtime；中=局部热点或边界放大；低=开销明确但量级小或防御性。
- 每条问题模板：**位置 → 现象 → 代码现场 → 调用链与触发时机 → 根因 → 影响量化 → 修复方案 → 回归风险**。
- 未标注处不臆测运行时数字；量化以代码结构与默认常量推导，标注「静态推导」。

## 1. 执行摘要

**一句话结论：工具执行层的编排纪律（并行信号量、审批竞速、shell 有界预览、tools 快照、computer spawn_blocking）明显优于平均水平，但存在三处结构性放大——① 多数文件/搜索工具在 `async` 内同步 `std::fs` 直接阻塞 tokio worker；② 工具事件与 Progress 在批收口一次性广播且 Progress 回调恒为 `None`，流式协议空转、长批零中间反馈；③ 执行器默认 `output_budget_bytes=None` 且同一输出经 text/Value 双表示 + 执行→事件→消息多级深 clone，与 03 的 tool-end IPC 未 Arc 叠加后，大输出工具的真实成本可达输出体积的 3–5 倍拷贝；MCP 桥另有 stdout 整行无界读入与 shell 全量字节完成前无界驻留两项内存风险。**

- **执行器（T）**：B4 默认并行 4 + FIFO permit 排队健康；但 `ToolBatchOptions.output_budget_bytes` 默认 `None`（`tool_events.rs:343`），生产 `run_launch.rs:752-759` 未覆盖该字段——除 shell 自带 200KB 外，其他工具输出在进入事件/DB/IPC 前不截断。`race_execution` 对 Progress 传 `None`，shell `execute_stream` 仍在构造 `ToolProgress` 后被丢弃。
- **内置 I/O 工具（T/S）**：`read_file`/`write_file`/`search`/`replace`/`diff`/`project_tree` 的 `async fn execute` 内直接 `std::fs::*`（无 `spawn_blocking`/`block_in_place`）——大文件与全仓搜索时阻塞 tokio worker，与并行工具组、事件 flush 抢线程。`read_file` 无视行窗口先 `std::fs::read` 整文件再 `lines().collect()`。
- **shell（S）**：T-AB-01 有界预览（头尾 24KB）+ spill 落盘是正面；但 `OutputAccumulator.bytes` 在命令完成前**无界增长**——`yes`/`cat` 超大文件可在截断语义生效前吃满内存。
- **事件时序（T）**：`emit_tool_events` 仅在 `execute_batch` 返回后调用；并行组 start/end 与审批事件全部积压到批结束——长批（含 120s 审批等待）期间前端无 tool 卡片实时更新（与 02 T2 卡片渲染成本叠加时，会话结束后出现「多卡片同时涌入」）。
- **MCP（M）**：stdio 行协议实现清晰（oneshot pending、EOF+try_wait 双崩溃检测、stderr 环形尾）；但 `lines().next_line()` 对 stdout **无行长上限**，恶意/失控 server 单行巨型 JSON 可驱动分配 OOM；崩溃监测固定 50ms 轮询 × N 会话；`adapt_call_result` / `tool_output_to_call_result` 对大结果做 text+structuredContent 双拷贝。

**发现计数**：6 高（T1 T2 T3 T4 S1 M1）/ 8 中（T5–T11 M2 B1）/ 5 低（T12–T15 B2 信息）+ 6 项正面防回潮。修复路线图批次 Q–U（§8），性价比最高为 **批次 Q（spawn_blocking 收口 + 输出默认预算）** 与 **批次 R（批事件实时化 / Progress 接线）**。

## 2. 检查范围与方法

### 2.1 对象与规模

| 维度 | 数值 / 说明 |
| ---- | ----------- |
| agent-tools src 顶层 | ~55 文件（executor / idempotency / middleware / mcp / tools/*） |
| 工具执行核心 | executor_run.rs / executor_idem.rs / output.rs / streaming.rs / registry.rs |
| session-loop 工具面 | tool_exec.rs（薄门面）+ exec_batch / exec_single / exec_verdict / exec_middleware + executing_tools.rs + tool_events.rs |
| MCP | bridge_session / bridge_protocol / bridge_registry / shell / servers |
| 内置重 IO 工具 | fs（read/write/list/stat）、search、replace、diff、project_tree、shell* |
| 简要覆盖 | conex-browser-tools（navigate/interact/sense）、conex-computer-tools（spawn_blocking）、壳 browser/mod.rs、computer/mod.rs |
| 既有 bench | `crates/session-loop/benches/tool_batch.rs`（5×50ms 并行批） |
| 生产装配 | engine_build.rs（registry + mcp_bridge）、run_launch.rs（ToolBatchOptions） |

### 2.2 端到端工具执行链路（现状）

```text
【调度】loop executing_tools.handle
  → 收集 assistant.tool_calls → ToolBatchCall[]（concurrency 恒 Parallel 登记）
  → executor.execute_batch(calls, ctx, approval, options, abort)
【分组】BatchPlanner：全部 Parallel 进一组；Sequential/Exclusive 顺序单元素组
【并行组】emit 全组 ToolStart（积压 events Vec）
  → 审批：全组 ApprovalRequested 先发 + 逐个 approval_wait
  → Semaphore(max_parallel=4) + join_all
      → execute_single_with_retry → execute_single
          → build_execution_contexts（多字段 String clone）
          → middleware before（input 逐层 clone）
          → tool.pre hook
          → race_execution：select(abort, timeout(60s, execute_stream))
              → progress = None（丢弃）
              → execute_stream_with_output_policy
                  → 幂等 check_and_record / Tool::execute_stream
                  → summarize(budget)  // 默认 budget=None 不截断
                  → stringify_tool_output → ToolResult{output, text, …}
          → middleware on_result / tool.post
  → collect_group_endings：ToolEnd{output: r.output.clone()} 入 events
【收口】execute_batch 返回
  → emit_tool_events：二次遍历 events → AgentEvent → state.emit_event
  → record_message(tool 角色) × N（再次组织 ToolOutput）
```

### 2.3 输出与缓冲面清单

| 缓冲点 | 有界？ | 证据 |
| ------ | ------ | ------ |
| shell OutputAccumulator.bytes | **否**（完成前） | shell_output.rs:125-149 |
| shell preview head/tail | 是 24KB | shell_output.rs:16-19 |
| shell spill 落盘 | 超预算时写盘 | shell_output.rs:259-286 |
| executor summarize | 仅 budget=Some | executor_run.rs:237-247 |
| MCP stdout 行 | **否** | bridge_session.rs:477-479 |
| MCP stderr_tail | 是 20 行 | bridge_session.rs:40,175-180 |
| MCP pending map | 有（超时 remove） | bridge_session.rs:314-315 |
| search 文件内容 | 单文件≤512KB × 最多 2000 文件串行 | search.rs:19-21,168-174 |
| read_file | 整文件 | fs.rs:105 |

## 3. 高危发现

### T1 · 核心 FS/搜索/编辑工具在 async 内同步 IO，阻塞 tokio worker

- **严重度**：高
- **位置**：`crates/agent-tools/src/tools/fs.rs:75,105,345,516,526,639`；`search.rs:164-174`；`replace.rs:110`；`diff.rs:115`；`project_tree.rs:266-321`
- **现象**：`async fn execute` 方法体直接调用 `std::fs::metadata` / `std::fs::read` / `std::fs::write` / `std::fs::read_dir` 等同步 API，**没有** `tokio::task::spawn_blocking` 或 `block_in_place`。
- **代码现场**（read_file 片段）：

```rust
// crates/agent-tools/src/tools/fs.rs:75-106
let metadata = std::fs::metadata(&file_path)…?;
…
let bytes = std::fs::read(&file_path)…?;   // 整文件
```

search 在同一 async 执行内对最多 `DEFAULT_MAX_FILES=2000` 个文件各 `std::fs::read`：

```rust
// crates/agent-tools/src/tools/search.rs:162-174
for file in walk_files(&root, …, max_files) {
    let metadata = match std::fs::metadata(&file) { … };
    if metadata.len() > max_file_bytes { continue; }
    let bytes = match std::fs::read(&file) { … };
```

- **调用链与触发时机**：`execute_single` → `execute_stream_with_output_policy` → `Tool::execute`（默认流包装）→ 上述同步 IO。每次模型发起 read_file / write_file / search / edit / diff / project_tree 即触发；并行组内多个此类工具同时进入时更糟。
- **根因**：工具 trait 的 `async fn execute` 只约束异步签名，未强制「阻塞 IO 必须 spawn_blocking」；shell/computer 已改造成 tokio process / spawn_blocking，**FS 族未跟进**。
- **影响量化（静态推导）**：
  - 单次 `std::fs::read` 大文件（MB 级）在 tokio 多线程 runtime 上占用一个 worker 直至完成；默认 worker 数 = CPU 核数。
  - 并行组默认 4：4 个大 read_file 可同时占满 4 个 worker → 同进程事件 flush、MCP reader、其他 async 工具排队，表现为「工具执行卡住 UI/事件」而非单纯工具慢。
  - 对照：`conex-computer-tools/src/session.rs:186-201` 已用 `spawn_blocking` 包 COM/截屏——证明工程上接受该模式，FS 族是缺口。
- **修复方案**：
  1. 在工具实现层对 `std::fs` 全路径改 `tokio::task::spawn_blocking(move || …)`，入参/出参用 `PathBuf`/`Vec<u8>`/`String` 移入闭包（`Tool` 已 `Send+Sync`）。
  2. 或在 `execute_stream_with_output_policy` 旁增加「阻塞工具标记 + 统一包装」的执行器策略（更集中，但需维护 dangerous/blocking 分类表）。
  3. search 的 walk 改为 `ignore`/`walkdir` + `spawn_blocking` 一次扫完返回匹配摘要，避免在 worker 上边走边读。
- **回归风险**：中低——spawn_blocking 闭包需避免再借 `ToolContext` 非 Send 部分；`AbortToken` 检查放在闭包外循环点。行为语义（错误码、输出形状）应零变化。

### T2 · read_file 整文件读入再切行窗口，IO/内存与窗口参数无关

- **严重度**：高
- **位置**：`crates/agent-tools/src/tools/fs.rs:90-135`
- **现象**：行窗口（`startLine`/`endLine`/`contentOffset`/`maxLines`/`maxBytes`）只影响**输出切片**，读取阶段仍 `std::fs::read` 整文件；随后 `decoded.text.lines().collect::<Vec<&str>>` 再 `chars().count()` 全文统计。
- **代码现场**：

```rust
// fs.rs:105-135
let bytes = std::fs::read(&file_path)?;
let decoded = decode_text(&bytes);
let lines: Vec<&str> = decoded.text.lines().collect();
let total_lines = lines.len();
let total_chars = decoded.text.chars().count();
```

- **调用链**：模型常用「读文件第 200–240 行」仍付全额读盘 + 解码 + 行索引。
- **根因**：行索引需要总行数才能生成 header / `nextContentOffset`；实现选择「先物化全文」而非流式计数或 seek。
- **影响量化（静态推导）**：对 50MB 日志文件的「读尾部 100 行」：磁盘/页缓存命中时仍 50MB 拷贝 + 解码 + lines 索引分配；峰值内存 ≈ 2× 文件（bytes + text）。
- **修复方案**：
  - 短路：`maxBytes` 较小时从文件尾/头反向读取只取窗口所需字节，再一次性行计数或接受 `totalLines` 为下界并在 header 标注。
  - 或 `spawn_blocking` + 分块读 + 仅保留窗口行环形缓冲，header 的 `lines` 改为「已扫描行数」语义需契约评审。
  - 至少：在 T1 落地 spawn_blocking 后，把 `lines().collect()` 换成迭代计数避免额外 Vec（分配常数级优化，次要）。
- **回归风险**：中——header 中 `lines`/`totalChars` 字段语义若改为估算会破坏测试与模型依赖；优先保持全文路径但移出 worker，并对「仅 maxLines 请求」提供可选快速路径且默认不改语义。

### T3 · 工具事件批收口一次性广播 + Progress 回调恒为 None

- **严重度**：高（交互延迟与流式协议空转；与 02 卡片涌入叠加）
- **位置**：
  - 收口广播：`crates/session-loop/src/loop/handlers/executing_tools.rs:89-98`
  - Progress 丢弃：`crates/session-loop/src/exec_single.rs:536-558`（`progress: None`）
  - 协议仍存：`crates/agent-tools/src/streaming.rs`；shell 实现 `shell.rs:414-425`
- **现象**：
  1. `execute_batch` 内部把全部 `ToolEvent` 收进 `Vec`，返回后才 `emit_tool_events` → 前端在整个批（含审批等待，默认可至 120s）期间收不到 tool-start / tool-end。
  2. 执行器调用流式接口时 progress 回调写死 `None`，shell 每块 stdout 仍 `ToolProgress::Text` 分配后被 drop。
- **代码现场**：

```rust
// exec_single.rs:539-557
execute_stream_with_output_policy(…, None /* progress */)
```

```rust
// executing_tools.rs:91-98
let outcome = executor.execute_batch(…).await;
emit_tool_events(state, &outcome.events);  // 批结束后一次性
```

- **调用链**：并行组「审批 → 执行 → 全部结束 → 前端同时看到 N 个卡片」；长命令 shell 流式对用户无增量输出（终值一次性）。
- **根因**：事件顺序契约要求批收口广播（tool_events / EV-09 注释明确「非实时轨」）；R1 战役删除了 tool-update 契约后，Progress 没有上桥通道，执行器直接传 None。
- **影响量化（静态推导）**：
  - 审批模式：批延迟 = 审批链 + max(工具耗时)；前端卡片延迟等于整段。
  - 与 02 T1/T3（卡片全量存活、流式文本注入）耦合：批结束瞬间同时挂载 N 个重卡片 → 掉帧峰。
  - shell 流式 CPU：每块构造 Progress 后立刻丢弃，纯浪费（有界 preview 仍在 Terminal 路径计算一次）。
- **修复方案**：
  1. **契约允许范围内**：对顺序路径与并行组，ToolStart 在进入执行前经独立 `LiveEventSink`/实时桥推送（不走持久化 events Vec）；ToolEnd 仍可收口持久化，或实时推送 + 收口去重（需 03 契约评审）。
  2. Progress：接回现有非持久事件通道（如 tool-progress 或复用 message-delta 通道的专用前缀），或明确删除 shell execute_stream 的 Progress 构造以省 CPU（诚实减功能需用户裁决，**不得静默砍**）。
  3. 最小可行：仅并行组 ToolStart 实时 emit，审批 requested 已有事件语义对齐前端。
- **回归风险**：中——事件顺序契约（01 §五.6）与前端 EventRouter 的 pendingToolEnds 缓冲假设需同步评审；禁止在未升 schema 前私自加事件类型。

### T4 · 工具输出默认无预算 + text/output 双表示 + 执行→事件→消息多级深 clone

- **严重度**：高
- **位置**：
  - 默认 None：`tool_events.rs:316-319,343`；生产未覆盖：`run_launch.rs:752-759`
  - 双表示：`executor_types.rs:39-49`；构建：`executor_run.rs:81-87,132-138,262-268`
  - 事件 clone：`exec_batch.rs:560-572`；`exec_single.rs:106-118`
  - 消息再转换：`executing_tools.rs:153-208,427-465`
- **现象**：成功路径同时持有 `ToolResult.output: Value` 与 `ToolResult.text: String`（stringify 结果）；随后 ToolEnd / tool 消息 / tool_output_from_parts 多次 `clone()` 与 `from_value`。
- **代码现场**：

```rust
// tool_events.rs:337-347
impl Default for ToolBatchOptions {
    fn default() -> Self {
        Self { timeout: Duration::from_secs(60), …,
               output_budget_bytes: None, … }
```

```rust
// exec_batch.rs:565
output: r.output.clone(),
```

- **调用链**：任意工具成功 → summarize（budget=None 时 output 原样）→ text 分配 → ClassifiedToolResult → ToolEvent::ToolEnd clone → emit_tool_events 再 from_value/clone → record_message 再组装 → LoopState 事件累积 → IPC（03 C1）。
- **根因**：预算字段 T06.4.2 补上后生产装配未设默认；text 字段为「供上层直接投喂」设计但当前链路大量使用 output.Value，text 与 output 生命周期重叠。
- **影响量化（静态推导）**：
  - 200KB 级输出（shell 上限）：执行器内 ≈1×Value + 1×String；事件层至少 +2× Value clone；消息层再 +1；上桥再序列化（03）——**累计拷贝/序列化 ≈ 3–5× 载荷**。
  - `output_budget_bytes` 若设为 24KB（对齐 DEFAULT_INLINE_BYTES），context 载荷与 IPC 可降一个数量级（shell 自有 200KB 除外）。
- **修复方案**：
  1. 生产 `ToolBatchOptions` 设置合理默认（如 24KB 或 64KB），与模型上下文预算对齐；shell 的 maxOutputBytes 保持工具级覆盖。
  2. `ToolResult`：去掉冗余 text 字段或改为 `OnceCell`/按需 stringify，避免双表示常驻。
  3. 事件/消息共用 `Arc<ToolOutput>`（或 Value 包 Arc）消除 clone——与 03 C1 同一主题，执行侧先落地。
  4. `tool_output_from_parts` 避免 `serde_json::from_value(output.clone())`，改为引用抽取字段。
- **回归风险**：中——截断会改变模型可见输出（有 contextBudget 标记）；需评估各工具是否已有自截断。Arc 化不改语义。

### S1 · shell 全量字节在命令完成前无界驻留内存

- **严重度**：高（内存）
- **位置**：`crates/agent-tools/src/tools/shell_output.rs:117-149,183-193`；调用 `shell_exec.rs:117-137`
- **现象**：`OutputAccumulator.bytes` 只 `extend_from_slice`，**没有**字节上限；有界的是 `preview`（头尾 24KB）。截断判定与 spill 发生在命令**结束后**的 `build_sync_result`。
- **代码现场**：

```rust
// shell_output.rs:141-149
pub(crate) fn append(&mut self, chunk: &[u8], now_ms: u64) {
    self.bytes.extend_from_slice(chunk);
    self.preview.append(chunk);
    …
}
```

注释承认：「`bytes`：全量字节——clamp 与截断落盘需要，命令完成后即释放」（:119-121）。
- **调用链**：sync 模式 `stream_until_deadline` 持续 `drain_available` → append；直到 EOF 或 timeout 窗口结束。
- **根因**：T-AB-01 优先保证「结果侧不驻留全量」，但**执行中**仍必须能 spill 全量，故先堆在内存。
- **影响量化（静态推导）**：`cat 2GB.log` 或误跑 `yes` 在 timeout 窗口内可把数 GB 写入 `bytes`；与并行组 4 个 shell 叠加可 OOM。timeout 默认 60s 放大窗口。
- **修复方案**：
  1. `append` 时若 `bytes.len() > max_output_bytes * K`（如 K=2）改为「写临时 spill 文件 + 预览继续」，避免内存持有全量。
  2. 或从一开始就边读边 spill（临时文件 + 仅 preview 在内存），结束时 rename。
  3. 保持结果 JSON 形状与 logPath 语义不变。
- **回归风险**：低——spill 路径已有失败降级；注意磁盘配额与临时目录清理。

### M1 · MCP stdout 整行读入，无行长上限

- **严重度**：高（恶意/失控 server 内存）
- **位置**：`crates/agent-tools/src/mcp/bridge_session.rs:471-482,486-506`
- **现象**：`BufReader::lines()` / `next_line()` 将一行完整读入 `String` 再 `serde_json::from_str`；协议假设「每条 JSON-RPC 消息独占一行」，**无** `max_line_bytes`。
- **代码现场**：

```rust
// bridge_session.rs:476-479
let mut lines = BufReader::new(stdout).lines();
while let Ok(Some(line)) = lines.next_line().await {
    handle_response_line(&session, &line);
}
```

- **调用链**：外部 MCP server（用户配置 command）stdout → reader task → 挂起表投递。
- **根因**：最小客户端未做反滥用限长；信任对端。
- **影响量化（静态推导）**：单行 500MB JSON → String + Value 双份峰值 GB 级；多 server 并行放大。属于「配置即信任边界」但仍应有界。
- **修复方案**：自研 `read_until(b'\n', max)` 或对 `next_line` 前 `fill_buf` 累计超限则 `mark_exited("stdout line too long")`；默认上限如 16–64MB 可配。
- **回归风险**：低——合法 MCP 消息极少超 MB 级；超限应转为 connection_failed 语义。

## 4. 中危发现

### T5 · search 同步扫盘并全文件读入（峰值 2000×512KB 串行）

- **严重度**：中
- **位置**：`search.rs:19-21,162-220,357-404`
- **现象**：`walk_files` 先物化 `Vec<PathBuf>`（受 max_files），再对每个文件 `metadata`+`read`；全程同步 + async 调用栈。
- **影响（静态推导）**：磁盘慢时单次 search 可达秒～十秒级，期间占用 tokio worker（见 T1）；峰值单文件 512KB 常驻 + 结果 Vec。
- **修复**：随 T1 spawn_blocking；walk 与读合一减少一次 Vec；可选 ignore crate 并行度在 blocking 池内控制。
- **回归**：glob/glob_match 语义与 SKIP_DIRS 剪枝已有测试，需保留。

### T6 · project_tree 每目录额外 `read_dir().count()` 做指纹

- **严重度**：中
- **位置**：`project_tree.rs:206-213,276-321`
- **现象**：遍历中对每个目录再开一次 `read_dir` 仅为了 count，与 walker 结果重复 IO。
- **影响（静态推导）**：深树目录数 D → 额外 D 次 open/read_dir；大 monorepo 可感。
- **修复**：walker 已访问子项时累计 count；或指纹改为 mtime+首子名。
- **回归**：指纹变更检测有测试，改计数来源需对齐。

### T7 · list_definitions 全量 clone + sort（非快照路径）

- **严重度**：中（局部）
- **位置**：`registry.rs:162-193`；消费方 MCP shell list、computer 清单、run 首次快照
- **现象**：每次调用 `list()` 克隆全部 Arc、克隆全部 definition、sort、跑 definition_transformers。
- **缓解**：`ensure_tools_snapshot`（streaming.rs:444-474）run 内只构建一次——**LLM 请求路径健康**。
- **残留热点**：MCP `list_tools`、`tools()` 查询、测试/装配路径若高频调用会重复付费。
- **修复**：registry 侧缓存 sorted defs，`register_runtime` 时失效；或 `list_definitions` 返回 Arc 切片。
- **回归**：E4 transformers 语义（每次构建改写）要求缓存失效正确。

### T8 · 并行批每任务深 clone call / exec_input / ctx

- **严重度**：中
- **位置**：`exec_batch.rs:423-425,506-513`；`exec_single.rs:301,536,319`
- **现象**：`execute_group` 对每项 `self.calls[idx].clone()`（含 input Value）；`race_execution` 为 timeout 竞速再 `exec_input.clone()`。
- **影响**：KB 级入参 × 并行 4 可忽略；MB 级入参（少见）或大 file 内容作参数时放大。
- **修复**：`Arc<ToolBatchCall>` 进并行 future；timeout 分支用 `tokio::time::timeout` 包共享 `&Value` 而非先 clone（需生命周期上可行——当前 execute 拥有 args）。
- **回归**：中低，注意 `execute` 签名消费 Value。

### T9 · 中间件 on_result 链逐层 clone 全量输出

- **严重度**：中
- **位置**：`exec_single.rs:724-752`
- **现象**：`m.on_result(tool, input, output.clone(), mw_ctx)` 每中间件 clone 一次全量。
- **影响**：生产中间件链常为空则 0；一旦挂记录/改写中间件，大输出 × N。
- **修复**：`&Value` 入参或 `Arc<Value>`；Replace 才消耗所有权。
- **回归**：trait 签名变更影响插件，需 minor 版本说明。

### T10 · MCP call 结果适配双拷贝（content + structuredContent）

- **严重度**：中
- **位置**：`bridge_protocol.rs:126-154`；`shell.rs:152-167`
- **现象**：`adapt_call_result` 把 text/json/content/isError 全塞进新 Map；shell `tool_output_to_call_result` 再 `to_string` + `structuredContent: output.clone()`。
- **影响**：MCP 大结果往返内存 ≈ 2–3×；再进入执行器 T4 链。
- **修复**：适配层借用/移动字段而非 clone；shell 面 structuredContent 与 content 二选一或 Arc。
- **回归**：MCP 客户端对形状有依赖，字段集保持。

### T11 · MCP stdin 写锁串行化并发 tools/call

- **严重度**：中（协议固有 + 无分片说明）
- **位置**：`bridge_session.rs:289-306,351-366`
- **现象**：所有请求写 stdin 共用 `Mutex<Option<ChildStdin>>`；JSON-RPC 多路复用本身允许并发，写锁使大 payload 互斥。
- **影响**：默认并行工具 4 且多为 MCP 时，写锁串行叠加 RTT；通常远小于工具执行时间。
- **修复**：单 writer task + mpsc 队列（写路径异步化），请求 future 只等 response；避免锁内 flush。
- **回归**：顺序保证与换行协议保持。

### M2 · 崩溃监测 50ms 轮询 × N 会话

- **严重度**：中低
- **位置**：`bridge_session.rs:38,523-554`
- **现象**：每会话独立 tokio task 每 50ms `try_wait`。
- **影响**：4 server → 20 次/s 系统调用级轮询，CPU 可忽略；任务调度噪声存在。
- **修复**：与 stdout EOF 双检测已存在，可将间隔放到 250–500ms 或 `Child::wait` 放入 blocking 池（需与 stop 语义协调）。
- **回归**：崩溃检测延迟略增，需保 EOF 路径即时。

### B1 · browser 重定向等待 100ms 轮询（简要）

- **严重度**：中低
- **位置**：`crates/conex-browser-tools/src/tools/navigate_common.rs:23`
- **现象**：`REDIRECT_POLL_INTERVAL = 100ms` 轮询导航完成。
- **影响**：平均 +50ms 导航尾巴；非 tokio 阻塞（async sleep）。
- **修复**：CDP 事件驱动（Page.frameNavigated）替代轮询；已有事件总线可挂。
- **回归**：兜底轮询宜保留作超时路径。

## 5. 低危与信息项

### T12 · stderr_tail `Vec::remove(0)` O(n)

- **位置**：`bridge_session.rs:176-180`；上限 20，单次 O(20) 可忽略。改 `VecDeque` 纯卫生。

### T13 · 每批 `format!("batch-{}")` + events Vec 无 capacity

- **位置**：`exec_batch.rs:154-159`。批数低频；`events` 可 `with_capacity(calls.len()*3)`。

### T14 · summarize 未截断时 `value.clone()`

- **位置**：`output.rs:194-202`。可改为返回 `Cow` 或截断布尔，避免未截断路径白 clone（与 T4 合并优化更佳）。

### T15 · MCP call 超时固定 30s

- **位置**：`bridge_protocol.rs:26`；`with_call_timeout` 可覆盖但生产未按工具细分。慢工具与快工具同窗。

### B2 · computer 全路径 spawn_blocking（正面信息项）

- **位置**：`conex-computer-tools/src/session.rs:104,186-201`。COM/注入/截屏已移出 worker——**禁止回潮到 async 内直接 COM**。

## 6. 正面发现（防回潮）

| ID | 发现 | 位置 |
| -- | ---- | ------ |
| OK1 | shell 有界预览头尾 24KB + 截断 spill 落盘 + 高输出建议 | shell_output.rs:16-19,219-238,259-314 |
| OK2 | shell 双管道 `select!` 持续排空，防子进程写满管道死锁 | shell_output.rs:60-89 |
| OK3 | tools schema per-run 快照锁定，请求前缀稳定利于 prompt cache | streaming.rs:444-474 |
| OK4 | B4 并行信号量默认 4、FIFO 排队、permit 随 future drop 释放 | exec_batch.rs:15,407-527 |
| OK5 | computer COM/注入/截屏 `spawn_blocking` | session.rs:186-201 |
| OK6 | MCP stderr 环形尾 + EOF 与 try_wait 双崩溃检测 + pending 超时清理 | bridge_session.rs:311-320,474-554 |

## 7. 与 01–04 / 其它方向交叉

| 交叉点 | 说明 |
| ------ | ---- |
| 02 T2/T3 工具卡片 | 本方向 T3 批收口导致卡片「批后涌入」，与卡片 memo 缺失叠加放大掉帧 |
| 03 C1 ToolEnd 未 Arc | 本方向 T4 给出执行侧完整 clone 链；IPC 侧修复应共用 Arc 化方案 |
| 03 R2/R1 事件双发 | 工具事件走收口广播 + 持久化，与 delta 双发不同轨；修复 T3 时避免再造双发 |
| 04 引擎热路径 | execute_batch 内锁（registry Mutex、审批门）与 LoopState.emit_event 交界；本方向不重复 04 状态机分析 |
| 09 Rust 内存 | S1 / M1 属执行期缓冲峰值，应在 09 全局内存图中打点 |
| 14 沙箱隔离 | FS 工具若未来包 sandbox，spawn_blocking 边界需与隔离进程模型一并设计 |

## 8. 修复路线图（不谈工期，仅逻辑批次）

### 批次 Q · 阻塞 IO 收口 + 输出默认预算（不动契约，可先行）

1. fs/search/replace/diff/project_tree 全面 `spawn_blocking`（T1）。
2. 生产 `ToolBatchOptions.output_budget_bytes` 设默认（T4-1）。
3. shell accumulator 边写边 spill 或内存上限（S1）。
4. MCP stdout 行长上限（M1）。

**验收**：并行 4×大 read_file 时其它 async 任务延迟不显著上升（运行时 V 项）；`cat` 大文件 RSS 有上界；MCP 超长行触发 connection_failed。

### 批次 R · 事件实时化与 Progress 诚实化（可能涉契约）

1. ToolStart（及可选 ToolEnd）实时桥推送（T3）。
2. Progress：接线或明确停止构造（需用户裁决，禁止静默砍功能）。
3. `ToolResult` 去双表示 / Arc 化 output（T4-2/3，与 03 C1 联动）。

**验收**：长批审批期间前端可见 tool-start；tool-end 单份载荷跨 IPC。

### 批次 S · MCP 与并行 clone 清理

1. 单 writer 队列写 stdin（T11）。
2. adapt_call_result / shell 双拷贝消除（T10）。
3. 并行批 `Arc<ToolBatchCall>`（T8）。
4. 崩溃轮询间隔调整（M2）。

### 批次 T · 局部算法与卫生

1. project_tree 指纹 IO 去重（T6）。
2. list_definitions 缓存（T7）。
3. summarize Cow / on_result 入参改引用（T9/T14）。

### 批次 U · browser 导航事件化（跨方向 14）

1. navigate 重定向改 CDP 事件驱动（B1），保留 100ms 兜底。

## 9. 运行时验证建议

> 静态审查无法给出真实毫秒/MB；下列 V 项须在 debug 桌面宿主（4000 Tauri MCP 唯一合法调试通道）或专用 bench 中实测回填。

| ID | 验证项 | 方法 |
| -- | ------ | ---- |
| V1 | 4 并行 read_file(大) 时 tokio worker 占用与事件延迟 | tracing span + 并行批 bench |
| V2 | read_file(50MB) 只读 10 行的墙钟与峰值 RSS | 命令面/工具直调 |
| V3 | 10 工具批 + 审批：前端首张卡片时刻 vs 批结束时刻 | 4000 MCP 截事件时序 |
| V4 | shell `cat` 大文件：完成前 RSS 曲线 | 内存采样 |
| V5 | MCP 假 server 发送 100MB 单行：是否 OOM / 是否可被行长上限挡住 | fixtures/mcp_fake_server |
| V6 | tool-end 200KB：执行侧 clone 次数（heaptrack/dhat）与 IPC 体积 | 对齐 03 C1 |
| V7 | tools 快照后 register_plugin_server 新工具是否出现在下一 run | 集成测试 |

已有资产：`crates/session-loop/benches/tool_batch.rs`（并行批延迟）；`agent-tools/tests/fixtures/mcp_fake_server.rs`。

## 10. 发现总表

| ID | 严重度 | 一句话 | 主路径 |
| -- | ------ | ------ | ------ |
| T1 | 高 | FS 族工具 async 内同步 IO 阻塞 worker | tools/*.rs |
| T2 | 高 | read_file 全文件读入无视行窗口 | fs.rs:105 |
| T3 | 高 | 批事件收口广播 + Progress 丢弃 | executing_tools / exec_single |
| T4 | 高 | 默认无输出预算 + 多级 clone 双表示 | tool_events / executor_run |
| S1 | 高 | shell 全量 bytes 完成前无界 | shell_output.rs |
| M1 | 高 | MCP stdout 行无界 | bridge_session.rs |
| T5 | 中 | search 同步大扫 | search.rs |
| T6 | 中 | project_tree 指纹双 read_dir | project_tree.rs |
| T7 | 中 | list_definitions 重复 clone+sort | registry.rs |
| T8 | 中 | 并行批 call/input clone | exec_batch / exec_single |
| T9 | 中 | on_result 链 clone 输出 | exec_single.rs |
| T10 | 中 | MCP 结果双拷贝 | bridge_protocol / shell |
| T11 | 中 | MCP stdin 写锁串行 | bridge_session.rs |
| M2 | 中低 | 50ms 崩溃轮询 | bridge_session.rs |
| B1 | 中低 | 导航 100ms 轮询 | navigate_common.rs |
| T12–T15 | 低 | 见 §5 | — |
| OK1–OK6 | 正面 | 见 §6 | — |

## 11. 一句话结论（供总纲回填）

工具执行与 MCP 桥：**编排与 shell/computer 边界纪律良好，但 FS 族阻塞 worker、事件批收口零实时反馈、输出默认无预算+多级拷贝、MCP/shell 两处无界缓冲是本方向四个主轴问题；优先批次 Q+R，不动模型契约即可拿下大部分收益。**

---

## 附录 A · 关键代码摘录（证据补强）

### A.1 ToolBatchOptions 默认（无输出预算）

```rust
// crates/session-loop/src/tool_events.rs:337-348
impl Default for ToolBatchOptions {
    fn default() -> Self {
        Self {
            timeout: Duration::from_secs(60),
            fail_strategy: FailStrategy::ContinueDrain,
            approval_enabled: false,
            output_budget_bytes: None,   // ← 执行器 summarize 不触发
            permission_mode: None,
            approval_timeout: None,      // None → 缺省 120s
            max_parallel: None,          // None → DEFAULT_MAX_PARALLEL=4
        }
    }
}
```

生产装配仅覆盖审批与权限模式：

```rust
// apps/agent-workbench/src-tauri/src/run/run_launch.rs:752-759
let tool_options = ToolBatchOptions {
    approval_enabled,
    permission_mode: permission_mode
        .as_deref()
        .map(|mode| PermissionMode::from_engine_str(Some(mode))),
    ..ToolBatchOptions::default()
};
```

### A.2 race_execution 丢弃 Progress

```rust
// crates/session-loop/src/exec_single.rs:536-558
let outcome = self.race_execution(
    tool.as_ref(),
    exec_input.clone(),
    &tool_ctx,
    &exec_ctx,
    guard.as_ref().map(|v| v.as_ref()),
    &policy,
    options.timeout,
    abort,
).await;

// 内部（同文件 537-560）：
execute_stream_with_output_policy(
    tool, exec_input_clone, tool_ctx, exec_ctx, Some(g), policy,
    None,   // ← progress callback 恒 None
).await
```

对照 shell 仍在实现侧构造 Progress：

```rust
// crates/agent-tools/src/tools/shell.rs:396-410（注释）
// 每块 ToolProgress::Text 推送 … 执行器侧 drop 流完成取消，已发 Progress 保留
```

### A.3 批事件收口

```rust
// crates/session-loop/src/loop/handlers/executing_tools.rs:89-105
let outcome = executor
    .execute_batch(&calls, ctx, approval, options, abort)
    .await;

// 2b. 工具事件 → AgentEvent（批收口一次性）
emit_tool_events(state, &outcome.events);

// 3. 工具结果消息 recordMessage（tool 角色）
for result in &outcome.results {
    record_message(state, tool_result_message(result));
}
```

### A.4 ToolResult 双表示

```rust
// crates/agent-tools/src/executor_types.rs:38-49
pub struct ToolResult {
    pub output: Value,
    pub text: String,      // stringify_tool_output(output) 结果
    pub truncated: bool,
    pub deduplicated: bool,
    pub duration_ms: u64,
}
```

```rust
// crates/agent-tools/src/executor_run.rs:81-87
Ok(ToolResult {
    text: stringify_tool_output(&output),
    output,
    truncated,
    deduplicated: false,
    duration_ms: started.elapsed().as_millis() as u64,
})
```

### A.5 事件层再 clone

```rust
// crates/session-loop/src/exec_batch.rs:560-572
events.push(ToolEvent::ToolEnd {
    call_id: call.id.clone(),
    tool_name: call.tool_name.clone(),
    is_error: r.error_kind.is_some(),
    duration_ms: r.duration_ms,
    output: r.output.clone(),          // ← 第 2 份
    error_code: r.error_kind.map(|k| k.error_code().to_string()),
    error_message: r.error_message.clone(),
    attempt: Some(r.attempt),
    deduplicated: Some(r.deduplicated),
    executed_input: r.executed_input.clone(),
    occurred_at_ms: r.occurred_at_ms,
});
```

```rust
// crates/session-loop/src/loop/handlers/executing_tools.rs:448-453
if has_known {
    return serde_json::from_value(output.clone()).unwrap_or_default(); // ← 第 3 份（重建）
}
```

### A.6 shell 累加器无界

```rust
// crates/agent-tools/src/tools/shell_output.rs:117-149
pub(crate) struct OutputAccumulator {
    bytes: Vec<u8>,          // 全量，完成前无上限
    preview: BoundedPreview, // 头尾各 24KB
    lines: u64,
    last_output_at_ms: u64,
}
impl OutputAccumulator {
    pub(crate) fn append(&mut self, chunk: &[u8], now_ms: u64) {
        self.bytes.extend_from_slice(chunk); // 无 max 检查
        self.preview.append(chunk);
        …
    }
}
```

### A.7 MCP reader 无行长上限

```rust
// crates/agent-tools/src/mcp/bridge_session.rs:471-506
fn spawn_reader(session: &Arc<McpServerSession>, stdout: …) {
    tokio::spawn(async move {
        let mut lines = BufReader::new(stdout).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            handle_response_line(&session, &line);
        }
        session.mark_exited("stdout 关闭（进程退出或通道中断）");
    });
}
```

### A.8 tools 快照（正面）

```rust
// crates/session-loop/src/loop/handlers/streaming.rs:444-474
/// 工具定义导出（P1：快照锁定——首次构建后缓存，不再每轮从注册表重建）
pub(crate) fn ensure_tools_snapshot(state: &mut LoopState) {
    if state.tools_snapshot.is_none() {
        state.tools_snapshot = Some(
            state.tool_registry.list_definitions()
                .iter().map(ToolSchema::from_definition).collect(),
        );
    }
}
```

## 附录 B · MCP 请求时序（现状）

```text
McpClientBridge.start(config)
  → validate
  → McpServerSession::spawn（stdin/stdout/stderr 管道 + reader/stderr/crash 三 task）
  → request("initialize", 10s)
  → send_notification("notifications/initialized")
  → request("tools/list", 30s)
  → adapt_tool_list → set_tools → READY
  → McpToolAdapter 注册进 ToolRegistry

tools/call（经统一执行器）:
  McpToolAdapter::execute
    → session.call_tool(name, args)
      → request("tools/call", params, call_timeout=30s)
        → 序列化一行 JSON + '\n'
        → stdin Mutex 写
        → oneshot 等待（超时 remove pending）
      → adapt_call_result
```

并发语义：同一 session 上多个 `tools/call` 的 **写路径互斥**，**读响应可并发**（pending map）；不同 session 完全并行。

## 附录 C · 工具阻塞 IO 对照表

| 工具名（注册） | 文件 | 同步 API | 读放大点 | spawn_blocking |
| -------------- | ---- | -------- | -------- | -------------- |
| read_file | tools/fs.rs | metadata + read | 整文件 + lines 全量 | 无 |
| write_file | tools/fs.rs | write | 整 content | 无 |
| list_dir | tools/fs.rs | metadata + read_dir | 目录项 | 无 |
| fs_stat | tools/fs.rs | metadata | — | 无 |
| search | tools/search.rs | walk + read×N | ≤512KB×2000 | 无 |
| replace / edit | tools/replace.rs | read + write + rename | 整文件 | 无 |
| diff | tools/diff.rs | read | 双文件 | 无 |
| project_tree | tools/project_tree.rs | metadata + read_dir×D | 树 | 无 |
| shell_command | tools/shell_exec.rs | tokio::process | 有界预览 | N/A（async 正确） |
| computer_* | conex-computer-tools | COM | — | **有** |
| browser_* | conex-browser-tools | CDP async | — | N/A |

## 附录 D · 输出拷贝次数估算（单次 200KB shell 成功输出）

| # | 阶段 | 动作 | 累计驻留 |
| - | ---- | ---- | -------- |
| 1 | OutputAccumulator.bytes | 全量字节 | 200KB |
| 2 | preview_text / decode | 结果 String | +200KB（峰值） |
| 3 | ToolResult.output Value | 结构化 | ~200KB |
| 4 | ToolResult.text | stringify | +200KB |
| 5 | ToolEvent::ToolEnd.output | clone Value | +200KB |
| 6 | tool_output_from_parts | from_value 重建 | +200KB |
| 7 | tool 消息 ToolOutput | 再组织 | +200KB |
| 8 | LoopState 事件累积 + 序列化 IPC | 03 域 | +序列化缓冲 |

> 静态推导：截断默认关闭时，执行→消息边界至少 3–4 份结构体拷贝；再加 03 的桥序列化与双发，端到端放大更明显。设置 `output_budget_bytes` 后第 3 步起体积被压到预算内。

## 附录 E · 审批与超时对吞吐的影响

| 配置 | 默认 | 对吞吐影响 |
| ---- | ---- | ---------- |
| 每工具 timeout | 60s | 单工具最长占用 permit 60s；并行组其余排队 |
| approval_timeout | 120s（None） | 审批链可阻塞整组执行阶段（先全组 requested 再逐个 wait） |
| max_parallel | 4 | 超过 4 的并行项 FIFO 等 permit |
| fail_strategy | ContinueDrain | 致命失败不取消兄弟（CancelSiblings 时会 mark_rest_cancelled） |
| MCP call | 30s | 工具级再套 60s；实际更短者先失败 |

审批路径性能要点（正面）：执行模型 A 已恢复「审批后 join_all 并行」（exec_batch.rs:290-309），bench `tool_batch.rs` 锁定该语义；**性能问题不在审批后串行，而在事件收口导致的 UI 感知延迟（T3）**。

## 附录 F · 推荐插入 tracing 埋点（服务 V 项）

1. `execute_single`：`tool_name` / `duration_ms` / `truncated` / `bytes(out)`。
2. `execute_batch`：`batch_id` / `n_calls` / `n_parallel` / `wall_ms` / `approval_ms`。
3. shell `append`：`total_bytes` 高水位。
4. MCP `request`：`method` / `wait_ms` / `payload_len`。
5. spawn_blocking 包装前后：`blocking_start` / `blocking_end`。

埋点须走 `tracing`，禁止在热路径 format 大字符串；与 16 可观测性方向对齐。

## 附录 G · 非目标与诚实边界

- 本报告**未**运行时实测帧率/内存/RSS；所有「影响量化」为静态推导。
- **未**修改任何代码；**未** git commit。
- browser/computer 壳层仅抽样（简要），完整 CDP 延迟归 14/15 后续轮次可扩。
- 幂等 store、idempotency 持久化 IO 不在本轮展开（内存 HashMap 主路径开销可忽略）。
- `approval.rs` / `approval_router.rs` 超时竞速语义已有 F1-02 修复文档，本轮只关注吞吐交界（T3/M2/E）。

## 附录 H · 文件触达清单（只读）

```
crates/agent-tools/src/executor_run.rs
crates/agent-tools/src/executor_types.rs
crates/agent-tools/src/output.rs
crates/agent-tools/src/streaming.rs
crates/agent-tools/src/definition.rs
crates/agent-tools/src/registry.rs
crates/agent-tools/src/middleware.rs
crates/agent-tools/src/mcp/mod.rs
crates/agent-tools/src/mcp/bridge.rs
crates/agent-tools/src/mcp/bridge_protocol.rs
crates/agent-tools/src/mcp/bridge_session.rs
crates/agent-tools/src/mcp/bridge_registry.rs
crates/agent-tools/src/mcp/shell.rs
crates/agent-tools/src/tools/fs.rs
crates/agent-tools/src/tools/search.rs
crates/agent-tools/src/tools/replace.rs
crates/agent-tools/src/tools/diff.rs
crates/agent-tools/src/tools/project_tree.rs
crates/agent-tools/src/tools/shell.rs
crates/agent-tools/src/tools/shell_exec.rs
crates/agent-tools/src/tools/shell_output.rs
crates/session-loop/src/tool_exec.rs
crates/session-loop/src/exec_batch.rs
crates/session-loop/src/exec_single.rs
crates/session-loop/src/tool_events.rs
crates/session-loop/src/loop/handlers/executing_tools.rs
crates/session-loop/src/loop/handlers/streaming.rs
crates/session-loop/benches/tool_batch.rs
crates/conex-computer-tools/src/session.rs
apps/agent-workbench/src-tauri/src/run/run_launch.rs
apps/agent-workbench/src-tauri/src/engine_build.rs
apps/agent-workbench/src-tauri/src/browser/mod.rs
apps/agent-workbench/src-tauri/src/computer/mod.rs
```

---

*报告完 · 方向 10 · 静态分析完成，运行时 V1–V7 待回填。*
