# 09 · Rust 侧内存扫描素材（原始走读摘录）

> 战役：性能审查 · 方向 09 · Rust 侧内存（驻留与泄漏）
> 方法：静态代码走读（read + rg）；未实测处统一标注「静态分析结论，待运行时验证」
> 范围锁：session-loop / orchestrator / conex-db / engine_channels / buffer / pty / conex-markdown / conex-search / conex-fs / 壳层 HashMap 驻留面
> 与 04 边界：04 展开 clone 链与热路径调度；本文补驻留（无界累积 / 缓存无淘汰 / 句柄与任务生命周期）；clone 热点交叉引用不重复

## 一、扫描命令与命中摘要

### 1.1 无界 / 超限接受的缓冲

- `apps/agent-workbench/src-tauri/src/buffer.rs:16-17,93-94,123-129`：Critical 永不丢；全 Critical 时「缓冲可超限（防御性接受）」——无字节上限。
- `apps/agent-workbench/src-tauri/src/run/run_core.rs:149,168-183`：`BridgeAuditSink.persist: UnboundedSender<AgentEvent>`——审计事件（含 ToolEnd 大载荷）clone 后入无界 mpsc。
- `apps/agent-workbench/src-tauri/src/run/run_launch.rs:562-568`：装配点 `mpsc::unbounded_channel()` + `spawn_audit_persistence`。
- `crates/agent-provider/src/sse/frame.rs:59,93-97`：SSE pending 有 4MiB 上限（正面）。

### 1.2 LoopState / 聚合态驻留

- `crates/session-loop/src/loop/handlers/mod.rs:74,173-179`：`events: Vec<AgentEvent>` 每次 `emit_event` clone 一份进 Vec；收口 `mem::take`（loop_exec.rs:335）。
- `crates/session-loop/src/stream.rs:270-290`：`Aggregate.thought_blocks: Vec<ThoughtBlock>` 每 ThoughtDelta 新增一块（不合并）。
- `crates/session-loop/src/loop/handlers/streaming.rs:712-726`：收口 `emit_message_deltas` 对 Text/Thought 块再 push 一遍 MessageDelta（块级 clone）。

### 1.3 全局 / 会话级 HashMap 无淘汰

- `crates/orchestrator/src/flow_graph_advance.rs:35-92`：`declaration_order_cache` OnceLock 全局 HashMap，按 session_id 插入，无 remove。
- `apps/agent-workbench/src-tauri/src/run/run_core.rs:239,1027-1076`：`next_sequences: Mutex<HashMap<String,u64>>` 只 insert，无会话删除清理。
- `apps/agent-workbench/src-tauri/src/engine_build.rs:110,824-862`：`EngineHandle.cache_sessions` 只 insert/覆盖，无淘汰。
- `apps/agent-workbench/src-tauri/src/run/run_core.rs:318; run_idle.rs:170-193`：`resume_empty_streak` 置 0 不 remove。
- `apps/agent-workbench/src-tauri/src/push/pusher.rs:118,258-278`：离线 pending `VecDeque` 无 store 时内存无界。

### 1.4 moka 缓存配置

- `crates/conex-markdown/src/cache.rs:10-16,29-53`：`max_capacity(CACHE_MAX_ENTRIES=2048)` + weigher；moka 语义：设 weigher 时 max_capacity = **总权重**，不是条目数；`CACHE_BUDGET_BYTES=32MiB` 常量定义后**未接线**。

### 1.5 tokio 任务 / 句柄

- `crates/session-loop/src/loop/loop_runner.rs:350-375`：`spawn_pending_input_save` fire-and-forget，无 JoinHandle。
- `apps/agent-workbench/src-tauri/src/run/run_core.rs:68-84`：driver JoinHandle drop 即 detach（30-P1 有意）；audit_persist 收口 take+await（正面）。
- `crates/session-loop/src/loop/summary_coordinator.rs:168-197`：摘要任务 run 收口不摧毁 + 单飞 + 全局上限（正面）。

### 1.6 PTY / 子进程

- `apps/agent-workbench/src-tauri/src/pty/session.rs:32-39,142-159,458-563`：MAX 16；Detached 2h 宽限 GC；reader 线程 EOF 后 wait + remove（正面）。Rust 侧无历史缓冲（历史在前端）。

### 1.7 Arc 环 / Weak

- `apps/agent-workbench/src-tauri/src/run/run_core.rs:1080-1089`：`CoreRunStateLauncher.state: Weak<CoreRunState>`——防 Arc 循环（正面）。
- 未发现 `Arc::new_cyclic` 生产路径；`BridgeLiveSink` 持 `Arc<BufferedRunEventBridge>`，无反向强引用。

### 1.8 正面有界结构（禁止回潮清单素材）

- SessionHistoryCache：token 预算 200_000 + 会话数 32 + FIFO（run/mod.rs:143-149; run_history.rs:18-85）。
- PendingMessageQueue：默认容量 100（steering_queue.rs:27-28,165-171）。
- TaskAuditAccumulator：1000 条 FIFO + commands 1000（task_events.rs:321-341,452-455）。
- StatusDiagnostics：环形 20（status_diagnostics.rs:98-126）。
- EventBuffer Soft 64 / Critical 256 水位（buffer.rs:194-199）。
- RoutingAuditSink：run 收口 unregister（engine_audit.rs:82-96; run_idle.rs:1446）。
- Audit worker 收口 await 排空（run_idle.rs:1451-1458）。

## 二、关键代码现场

### 2.1 EventBuffer Critical 超限接受

```
// buffer.rs:16-17
// - `critical_limit`（Critical 水位）：新 **Critical 事件永不丢**——先驱逐
//   现有 Soft 旧帧；无 Soft 可驱逐时缓冲可超限（防御性接受）。

// buffer.rs:92-94
} else {
    // 全 Critical：永不丢，接受超限（防御性）
    break;
}
```

无字节/条目硬上限；审计+工具风暴下 Critical 堆积直到 flush。

### 2.2 审计无界通道

```
// run_core.rs:149
pub(crate) persist: tokio::sync::mpsc::UnboundedSender<AgentEvent>,
// run_core.rs:172
if let Err(error) = self.persist.send(event.clone()) {
```

04-O1 已写吞吐；内存视角：慢 DB 时 AgentEvent（含 ToolEnd output 字符串）线性堆积。

### 2.3 LoopState.events 双轨 clone

```
// handlers/mod.rs:173-178
pub(crate) fn emit_event(&mut self, event: AgentEvent) {
    self.events.push(event.clone());
    if let Some(sink) = &self.options.hooks.live_sink {
        sink.push_live(event);
    }
}
```

每事件至少 1 次结构 clone 进驻留 Vec；收口前整个 run 的事件轨在内存。

### 2.4 moka max_capacity 语义错位

```
// cache.rs:10-16,29-33
pub const CACHE_MAX_ENTRIES: u64 = 2048;
pub const CACHE_BUDGET_BYTES: u32 = 32 * 1024 * 1024; // 未接线
static RENDER_CACHE: Lazy<RenderCache> = Lazy::new(|| {
    Cache::builder()
        .max_capacity(CACHE_MAX_ENTRIES) // weigher 下 = 总权重 2048
        .weigher(|k, v| estimate_size(k, v.as_ref()))
        .build()
});
```

moka 0.12 文档（sync/cache.rs:210-214,196-197）：设 weigher 时 max_capacity 为加权总大小。

### 2.5 declaration_order_cache 无会话清理

```
// flow_graph_advance.rs:35-37,85-91
fn declaration_order_cache() -> &'static Mutex<HashMap<String, CachedDeclarationOrder>> {
    static CACHE: OnceLock<Mutex<HashMap<String, CachedDeclarationOrder>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}
// insert 后无对应 remove；会话删除不触达此静态。
```

### 2.6 next_sequences / cache_sessions 只增不减

```
// run_core.rs:1044-1047
self.next_sequences
    .lock()...
    .insert(session_id.to_string(), next);
// session_commands delete_session 未清理 next_sequences / cache_sessions / resume_empty_streak
```

## 三、交叉引用锚点

| 04 项 | 本文补充 |
| ------ | -------- |
| O1 审计无界通道 | 内存堆积量化 + EventBuffer Critical 超限叠加 |
| S1 收口三连克隆 | 短生命周期；驻留主因是 events Vec 与 Aggregate |
| S2 thought 逐 delta 块 | thought_blocks Vec 驻留直到 message finish |
| O2 EventQueue 锁 | 本文不重复锁视角 |

| 05 项 | 本文补充 |
| ------ | -------- |
| 读持主锁 / 组提交 | 审计 worker 慢落库 → 上游无界通道堆积（09 与 05 批次同批设计） |

| 06 项 | 本文补充 |
| ------ | -------- |
| SR03 fuzzy 全量重建 | 临时 Vec 分配峰值；非长期驻留 |
| trash 列表 | list 全扫临时 Vec；无 Rust 侧常驻索引 |

| 10 项 | 本文补充 |
| ------ | -------- |
| S1 shell 全量 bytes | ToolEnd 载荷进 events Vec + 审计通道双份驻留 |
| M1 MCP stdout 行 | 同上经 ToolEnd 放大 |
