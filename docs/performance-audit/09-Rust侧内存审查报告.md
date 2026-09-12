# 09 · Rust 侧内存审查报告（驻留与泄漏）

> **战役**：全面性能审查（performance-audit）· 方向 09
> **创建**：2026-09-13
> **状态**：静态审查完成（运行时 V 项待回填）
> **范围锁**：`session-loop` / `orchestrator` / `conex-db` / `engine_channels`+`buffer` / 流缓冲·EventBuffer·PTY·audit 通道 / `conex-markdown` 缓存 / `conex-search`·`conex-fs` 路径分配 / Arc 环·Mutex 长驻 Vec·once_cell 全局结构 / tokio task·JoinHandle·child process / 与 04·05·10·06 交叉
> **方法**：静态代码走读（`read` + `rg`）+ 关键链路证据（`文件路径:行号`）+ 严重度分级 + 修复建议；未实测项标注「静态分析结论，待运行时验证」
> **与 04 的边界**：04 已展开 clone 链与热路径调度（S1/S2/O1/O2 等）；本文聚焦**驻留与泄漏**（无界累积、缓存无淘汰、句柄与任务生命周期），clone 热点交叉引用不重复展开。
> **素材**：`materials/09-Rust内存扫描素材.md`
> **报告标准**：对齐总纲 v2——高危发现八要素（位置/现场/调用链/根因/量化/修复/回归锚点/交叉）；中低危摘要八要素；正面发现禁止回潮。

---

## 一、执行摘要

**一句话结论**：Rust 侧内存骨架（SessionHistoryCache token 预算、EventBuffer Soft 水位、PTY 容量+GC、审计路由注销、Weak 断环）整体健康；主要风险集中在三处——① `conex-markdown` 全局 LRU 的 moka 容量语义错位导致预算常量成死代码（有效驻留预算仅 ~2KiB 量级，缓存近乎失效而非泄漏）、② 审计无界通道与 EventBuffer「Critical 永不丢」叠加形成可被慢 DB/工具风暴放大的驻留面（04-O1 的内存维度深化）、③ 会话生命周期结束后多张会话级 HashMap（`next_sequences` / `cache_sessions` / `declaration_order_cache` / `resume_empty_streak`）无清理钩子，长进程内缓慢爬升。

**发现计数**：共 **22** 项登记——**5 高** / **10 中** / **7 低** + **14 项正面发现**（禁止回潮清单）。

**严重度判定口径**（对齐 04 §严重度表，内存维度特化）：

| 级别 | 判定条件 |
| ---- | -------- |
| 高 | ① 无界增长面（无任何上界，可被用户/工具/DB 行为线性放大）；或 ② 预期有界结构因语义/接线错误实际失效（如 M1）；或 ③ run 内平台期驻留与正文/工具输出同数量级且位于每 turn 必经路径 |
| 中 | 有界但上界过大/按条不按字节/仅在异常路径放大；或峰值分配（非泄漏）可被 04-K1 类 O(N) 叠加成尖峰 |
| 低 | 有意设计驻留（只读 static、PTY 宽限）、已有界结构的防回潮登记、或静态未发现实际持有路径的纪律锚点 |

**TOP3 高危**：

| # | 发现 | 一句话 |
| - | ---- | ------ |
| 1 | **M1 moka 容量语义错位** | `max_capacity(2048)` + weigher 使缓存按**总权重 2048** 淘汰，`CACHE_BUDGET_BYTES=32MiB` 死代码——渲染/高亮缓存近乎常驻空转，而非 32MB 驻留 |
| 2 | **A1 审计无界通道 × Critical 超限** | `UnboundedSender<AgentEvent>`（含大 ToolEnd）+ EventBuffer 全 Critical 可超限接受；慢 DB / 工具风暴下 mpsc 与桥缓冲双份驻留（04-O1 内存深化） |
| 3 | **H1 会话级 HashMap 无清理** | `next_sequences` / `cache_sessions` / `declaration_order_cache` / `resume_empty_streak` 仅 insert 不随 `delete_session` 收口；长开进程 + 多会话生命周期下缓慢泄漏 |

---

## 一.5 架构快照（驻留面地图）

```
进程生命周期驻留（OnceLock / static）
  ├─ conex-markdown RENDER_CACHE / HIGHLIGHT_CACHE（moka）     【M1 语义错位】
  ├─ syntect SYNTAX_SET（数 MiB 语法表，有意）                 【N1】
  ├─ agent-provider BUNDLED ModelCatalog（有意）               【N1】
  ├─ orchestrator declaration_order_cache（会话键无清理）      【F1/H1】
  └─ engine_provider SESSION_ABORT_REGISTRY（生产未写）        【R1 正面】

run 生命周期驻留（ActiveRun / LoopState）
  ├─ LoopState.events: Vec<AgentEvent>（整 run 平台期）        【L1】
  ├─ Aggregate.text / thought / thought_blocks                 【L2】
  ├─ EventBuffer.runs[run_id]（Soft 64 / Critical 256 条）     【B1 字节层缺失】
  ├─ BridgeAuditSink → UnboundedSender<AgentEvent>             【A1】
  ├─ conversation: Vec<Arc<AgentMessage>>（mem::take 收口，正面）
  └─ driver JoinHandle（detach 有意）                          【J1】

会话生命周期驻留（CoreRunState / EngineHandle）
  ├─ SessionHistoryCache（200k token + 32 会话 FIFO，正面）
  ├─ next_sequences: HashMap<String,u64>（无 delete 清理）     【H1】
  ├─ cache_sessions: HashMap（无 delete 清理）                 【E1/H1】
  ├─ resume_empty_streak: HashMap（置 0 不 remove）            【H1】
  ├─ RoutingAuditSink.routes（收口 unregister，正面）
  └─ PendingMessageQueue（容量 100，正面）

进程外资源
  ├─ PTY registry ≤16 + Detached 2h GC（正面设计，P1 有意驻留）
  ├─ 后台任务日志落盘 30min 保留（磁盘非堆）
  └─ PushDispatcher.pending（无 store 时无界）                 【Q1】
```

**驻留生命周期分层原则**（本文判定基准）：

1. **进程级 static** 必须要么有界（LRU/预算）、要么只读不可变（SYNTAX_SET 类）、要么随会话删除可 evict；
2. **run 级** 结构必须在 converge/finalize 路径 `mem::take` 或 drop（对照 ✅ conversation）；
3. **会话级** HashMap 必须挂在会话删除命令的清理链上，或有 FIFO/容量上界；
4. **通道载荷** 优先 `Arc` 共享或截断后的轻量句柄，避免「同一事件 N 份 String 副本」。

---

## 二、发现总表

| ID | 严重度 | 域 | 标题 | 主文件 |
| -- | ------ | -- | ---- | ------ |
| M1 | 高 | markdown 缓存 | moka max_capacity 语义错位，32MiB 预算死代码 | `conex-markdown/src/cache.rs` |
| A1 | 高 | 审计/桥 | 审计无界通道 + Critical 超限接受叠加驻留 | `run/run_core.rs` + `buffer.rs` |
| H1 | 高 | 壳层/编排 | 会话级 HashMap 四件套无 delete 清理 | `run_core.rs` / `engine_build.rs` / `flow_graph_advance.rs` |
| L1 | 高 | session-loop | LoopState.events 整 run 驻留 + 双轨 clone | `handlers/mod.rs` |
| L2 | 高 | stream 聚合 | Aggregate.thought_blocks 逐 delta 独立成块驻留 | `stream.rs` |
| B1 | 中 | EventBuffer | Critical 路径无字节/条目硬上限 | `buffer.rs` |
| A2 | 中 | 审计 worker | 慢 `push_terminal_best_effort` 拉长通道堆积窗口 | `run_core.rs:194-216` |
| S1 | 中 | SessionHistoryCache | `get()` 全量 clone 读放大（峰值非泄漏） | `run_history.rs:53-60` |
| E1 | 中 | EngineHandle | `cache_sessions` 无会话删除/容量上限 | `engine_build.rs:110,844-862` |
| F1 | 中 | flow_graph | `declaration_order_cache` 进程级静态、无会话清理 | `flow_graph_advance.rs:35-92` |
| Q1 | 中 | push | 离线 pending `VecDeque` 无 store 注入时无界 | `push/pusher.rs:118,258-278` |
| T1 | 中 | tokio spawn | `spawn_pending_input_save` fire-and-forget 无句柄 | `loop_runner.rs:350-375` |
| G1 | 中 | 收口 delta | `emit_message_deltas` 收口对 Text/Thought 全块再 clone | `streaming.rs:712-726` |
| W1 | 中 | ws fanout | resume pending 队列有容量但事件体无大小钳制 | `server/ws.rs:331` + `fanout.rs:312` |
| D1 | 低 | diagnostics | 环形 20 已有界；`last_error` 单槽恒驻（可接受） | `status_diagnostics.rs` |
| P1 | 低 | PTY | Detached 2h 宽限内子进程+master 句柄驻留（有意设计） | `pty/session.rs` |
| N1 | 低 | once_cell | `SYNTAX_SET` / `BUNDLED` catalog 进程级大结构（有意） | `highlight.rs` / `catalog.rs` |
| C1 | 低 | Arc 环 | 未发现生产 Arc 强引用环；Launcher 已用 Weak | `run_core.rs:1080-1089` |
| R1 | 低 | abort 注册表 | `SESSION_ABORT_REGISTRY` 生产未接线，仅测试写入 | `engine_provider/stream.rs:29-53` |
| X1 | 低 | search/trash | 路径分配为调用期临时峰值，无常驻索引 | `conex-search` / `conex-fs` |
| J1 | 低 | JoinHandle | driver 收口 detach 有意；audit_persist 已 await（对照） | `run_core.rs:68-84` |
| V1 | 低 |事件轨 | `RunOutcome.events` 消费后是否及时 drop 依赖驱动方 | `loop_exec.rs:335` |

---

## 三、高危发现（八要素）

### M1【高 / P0】conex-markdown 全局 LRU：moka 容量语义错位，32MiB 预算死代码

**位置**：`crates/conex-markdown/src/cache.rs:10-16,29-34,48-53`；消费面 `renderer.rs:693-700`、`highlight.rs:87-102`

**代码现场**：

```rust
// cache.rs:10-16
pub const CACHE_MAX_ENTRIES: u64 = 2048;
pub const CACHE_BUDGET_BYTES: u32 = 32 * 1024 * 1024; // 定义后从未出现在 builder
pub const CACHE_ENTRY_MAX_BYTES: u32 = 1024 * 1024;

// cache.rs:29-34
static RENDER_CACHE: once_cell::sync::Lazy<RenderCache> = once_cell::sync::Lazy::new(|| {
    Cache::builder()
        .max_capacity(CACHE_MAX_ENTRIES) // 2048
        .weigher(|k: &String, v: &Arc<String>| -> u32 { estimate_size(k, v.as_ref()) })
        .build()
});
```

**调用链**：`renderer::render` → `render_cache().get` miss → 渲染 → `entry_within_budget` 预检（仅单条 1MiB）→ `insert` → moka 按 weigher 总权重 vs `max_capacity=2048` 淘汰。

**根因**：moka 0.12 语义——**设置 weigher 后 `max_capacity` 表示加权总大小，不再是条目数**（moka 文档 `sync/cache.rs:210-214`；示例 `:196-197` 用 `max_capacity(32*1024*1024)` 表示 32MiB）。本仓 weigher 返回 `(key.len+value.len)*2`（UTF-16 估算字节），有效总预算仅为 **2048** 权重单位 ≈ 1KiB UTF-8 内容量级。`CACHE_BUDGET_BYTES` 常量与注释「32MB 预算」均为**死代码**。

**影响量化**（静态推算，待运行时验证）：

- 单条典型 markdown HTML 数 KB 时，权重立即超过 2048 → 几乎 insert 即触发驱逐或无法共存；
- 缓存命中率趋近 0 → 每次渲染重跑 syntect/HTML 生成（CPU 放大，与 09「内存」主题互为表里：**预期驻留预算未生效**）；
- 反向风险：若后人「顺手」把 `max_capacity` 改成 `CACHE_BUDGET_BYTES` 却不统一与前端 `MARKDOWN_CACHE_BUDGET_BYTES=16MiB`（`packages/shared-utils/src/bounds.ts:29`）的口径，会出现 Rust/TS 双侧预算漂移。

**修复方案**：

1. 将 builder 改为 `.max_capacity(CACHE_BUDGET_BYTES as u64)`（weigher 语义下即 32MiB 加权预算）；条目数上限若仍需，moka 无「同时 cap 条目+权重」的单一 API——可接受仅权重上限，或用 `invalidate` 钩子外置条目计数；
2. `CACHE_MAX_ENTRIES` 要么删除要么改名为历史注释，避免误导；
3. 与前端预算表（16MiB markdown / 8MiB highlight）对齐评审：Rust 侧 render+highlight 双缓存各 32MiB 是否过大（双缓存分离见 1C-8 注释 `cache.rs:41-45`，分离本身是正面决策）。

**回归锚点**：

- 单测：插入总权重 > 预算后 `weighted_size() ≤ CACHE_BUDGET_BYTES`；
- 单测：中等文档（~8KiB HTML）连续渲染两次，第二次命中（当前实现必失败——修复前后对照）；
- 门禁：`rg "CACHE_BUDGET_BYTES" crates/conex-markdown` 断言出现在 builder 中。

**交叉**：与 07（启动静态图）、16（perf 资产）无直接耦合；与前端 08 方向的 markdown LRU 预算独立。修复时注意：`highlight_cache` 与 `render_cache` 分离（1C-8，`cache.rs:41-45`）是命中率正面决策，两处 builder 都须同步改 `max_capacity` 语义，禁止只修一处。

**附：moka 语义对照摘录**（仓库内依赖 moka 0.12.15，文档 `sync/cache.rs:210-214,196-197`）：

```
/// - If the `weigher` is _not_ set, the cache will treat each entry has the same
///   size of `1`. This means the cache will be bounded by the number of entries.
/// - If the `weigher` is set, ... the cache will be bounded by the total weighted
///   size of entries.
/// 示例：.weigher(|_key, value: &String| value.len()).max_capacity(32 * 1024 * 1024)
/// // This cache will hold up to 32MiB of values.
```

本仓把「条目数常量 2048」填进了「加权总大小」槽位，是典型的 API 语义误用。

修复时 `CACHE_MAX_ENTRIES` 的命名与注释须一并清理，避免后续 reviewer 再次按「条目数」理解。

---

### A1【高 / P0】审计无界通道 + EventBuffer Critical 超限接受：双份驻留放大

**位置**：

- `apps/agent-workbench/src-tauri/src/run/run_core.rs:141-216`（`BridgeAuditSink` / `spawn_audit_persistence`）
- `apps/agent-workbench/src-tauri/src/run/run_launch.rs:562-568`（装配）
- `apps/agent-workbench/src-tauri/src/buffer.rs:16-17,92-94,123-129`（Critical 超限）
- 04 交叉：`04-Rust引擎热路径审查报告.md` L4-O1/O2

**代码现场**：

```rust
// run_core.rs:149 — 无界 mpsc，载荷为完整 AgentEvent（可含 ToolEnd 大 output）
pub(crate) persist: tokio::sync::mpsc::UnboundedSender<AgentEvent>,
// run_core.rs:172
if let Err(error) = self.persist.send(event.clone()) { ... }

// buffer.rs:16-17 / :92-94
// Critical 永不丢——无 Soft 可驱逐时缓冲可超限（防御性接受）
} else {
    break; // 全 Critical：永不丢，接受超限
}
```

**调用链**：

1. 工具/逃逸审计 → `RoutingAuditSink`（engine_audit.rs:67-79 按 session_id 路由）→ `BridgeAuditSink.emit`（run_core.rs:168-183）：
   - `persist.send(event.clone())` —— **第一份**：完整 `AgentEvent` 进无界 mpsc；
   - `bridge.emit(&envelope) + bridge.flush()` —— **第二份**：序列化为 payload 字符串进 EventBuffer，随即 flush 发射；
2. 单 worker `rx.recv` → `queue.lock().await.push_terminal_best_effort`（run_core.rs:200-205，仍走 store 串行 append）；
3. 慢 DB / 05 组提交未接线导致 append 延迟时：mpsc 深度线性涨；同时桥内若积压大量 Critical（message-end / ToolStart/End / approval），EventBuffer 超出 `critical_limit=256` 仍继续堆积；
4. run 收口：`audit_sink().unregister` → sender drop → worker 排空 → `await handle`（run_idle.rs:1446-1458）——正确性闭环存在，但堆积窗口内的 RSS 峰值无设防。

**根因**：审计通道选 fire-and-forget「不阻断 run」但无水位/采样/有界背压（04-O1 已述）；内存维度上 **payload 是完整事件体而非轻量句柄**，且与桥 Critical 路径形成**同事件双份**（mpsc 一份 clone + 缓冲一份序列化字符串）。

**影响量化**（静态分析，待运行时验证）：

- 设单条 ToolEnd 序列化前 ~64KiB、工具风暴 200 条/s、DB 延迟 2s → mpsc 峰值 ~25MiB 仅审计面；
- 叠加 EventBuffer Critical 超限与实时轨 flush 竞争，收口 `await audit_worker` 会拉长终态完成时间（正确性有利、尾延迟不利）。

**修复方案**（与 04 批次 R 同批设计，本文补内存约束）：

1. Unbounded → 有界 `mpsc::channel(N)`（N 按字节预算而非条数：发送前 `estimate` 累计，超限丢弃最旧 Soft 审计或采样）；
2. 或审计通道只传 `Arc<AgentEvent>`，消除 clone 正文；
3. EventBuffer：为 Critical 增加 **字节水位**（如 8MiB）——超限时对「可序列化重复类」降级丢弃并计数告警，terminal/message-end 仍必达；
4. 05 组提交接线后重测堆积窗口。

**回归锚点**：

- 慢 DB 注入（05 persist delay 钩子）下断言审计队列深度 ≤ N；
- EventBuffer 全 Critical 灌入 10k 条大 payload，断言 total 字节 ≤ 字节水位 + 单条最大例外；
- 收口路径 audit await 超时告警可观测。

**交叉**：04-O1/O2、05 组提交、10-T3（批事件收口）、10-S1（shell 全量 bytes）——ToolEnd 越大，本项越尖锐。

---

### H1【高 / P1】会话级 HashMap 四件套：无 `delete_session` 清理钩子

**位置**：

| 结构 | 定义 | 写入点 | 缺失清理 |
| ---- | ---- | ------ | -------- |
| `next_sequences` | `run_core.rs:239` | `base_sequence_for` `:1044-1047`、`seed_sequences` `:1072-1075` | `session_commands.rs` delete 链未 remove |
| `cache_sessions` | `engine_build.rs:110` | `update_cache_session` `:850-861` | 同上 |
| `declaration_order_cache` | `flow_graph_advance.rs:35-37` | `cached_declaration_order` `:85-91` | 进程级静态，无任何 remove |
| `resume_empty_streak` | `run_core.rs:318` | `run_idle.rs:170-193` | 收口只置 0，不 remove 键 |

**代码现场**：

```rust
// flow_graph_advance.rs:35-37 — OnceLock 全局
static CACHE: OnceLock<Mutex<HashMap<String, CachedDeclarationOrder>>> = OnceLock::new();

// run_core.rs:1044-1047
self.next_sequences.lock()...insert(session_id.to_string(), next);
// delete_session_and_read_meta（session_commands.rs:178-193）只删 DB 行与产出目录
```

**调用链**：用户创建会话 → 首次 run 触发各缓存 insert → 用户删除会话 → DB/文件清理 → **四张表仍持 session_id 键** → 进程常驻直至退出。

**根因**：各缓存以「进程级单例 + 会话键」实现性能优化，但生命周期未挂到会话删除命令；`declaration_order_cache` 甚至不经过 `CoreRunState`，壳层无法触达。

**影响量化**（静态推算）：

- 单会话四键合计 ~数百字节～数 KiB（FlowNodeId 列表 + HashMap）；
- 长期桌面进程 + 高频建删会话（自动化/多 agent）→ 线性爬升；无上界；
- 与 08 前端内存方向对称：删除会话后 Rust 侧仍有影子状态。

**修复方案**：

1. 在 `CoreRunState` 增加 `pub(crate) fn on_session_deleted(&self, session_id: &str)`：remove 四表对应键（`declaration_order_cache` 需暴露 `pub(crate) fn evict_session`）；
2. `delete_session` 收口调用（成功路径）；
3. `declaration_order_cache` 改为挂在 `CoreRunState` 或 `FlowScheduler` 注册表上，消灭进程级静态（若跨 run 复用必须保留，则至少 LRU 上限 256 会话）；
4. 或统一引入「会话生命周期观察者」避免散落清理点。

**回归锚点**：

- 单测：创建会话 → 跑 run → delete → 断言四表 len 回到删除前；
- 压力：1k 次建删后四表 len ≤ 活跃会话数。

**交叉**：07 启动 restore 会 seed `next_sequences`——删除会话后再次 restore 同 id 应幂等；05 无耦合。

---

### L1【高 / P0·run 内】LoopState.events 整 run 驻留 + 双轨 clone

**位置**：`crates/session-loop/src/loop/handlers/mod.rs:73-74,173-179`；收口 `loop_exec.rs:330-335`；实时轨 `engine_channels.rs:714-721`；收口再 clone `streaming.rs:712-726`（G1）

**代码现场**：

```rust
// handlers/mod.rs:173-178
pub(crate) fn emit_event(&mut self, event: AgentEvent) {
    self.events.push(event.clone());          // 驻留副本（深克隆非 Arc 变体）
    if let Some(sink) = &self.options.hooks.live_sink {
        sink.push_live(event);                // 移交另一份（实时轨 emit+flush）
    }
}
```

**调用链**：任意 `emit_event`（含 MessageDelta 收口块、ToolStart/End、ControlIntent、SecurityAudit 转发…）→ events Vec 线性增长 → `converge` `mem::take` 移交 `RunOutcome.events` → 驱动方 `drive_outcome` 逐事件 push 落库/广播 → drop。

**根因**：事件轨需「收口后统一下发」契约；实现选择 run 内全量驻留。与 04-S1（收口三连克隆）不同——S1 是短峰，本项是 **O(事件数 × 平均事件大小)** 的平台期驻留。与 04-K2（emit_event 全变体深克隆）同函数不同视角：K2 讲每次 clone 的 CPU/分配税，本文讲 Vec 平台期字节占用。

**影响量化**：

- 长 turn 多工具 run：事件数百～数千；ToolEnd 携带 output 字符串时，events Vec 可达数十 MiB 平台驻留；
- 与 A1 审计通道、10-S1 shell 输出形成 **三副本**（events Vec + 审计 mpsc + DB/前端）；
- Soft（delta 类）若也进 Vec（取决于 emit 路径），万 delta 场景进一步放大——修复后 Soft 不进 Vec 可削去该分量。

**修复方案**：

1. 分级驻留：Soft（delta 类）不进 `events` Vec（实时轨已发；收口若需全文走 message-end 兜底——与 03 契约一致）；仅 Persist 类进 Vec；
2. 或 `events: Vec<SequencedEventRef>` 存 `Arc<AgentEvent>`，与 live_sink 共享同一 Arc；
3. 热路径大 ToolEnd 在入库前截断策略与 10-T4 同批。

**回归锚点**：

- 长 delta 流 run：断言 `state.events` 内 MessageDelta 条数 ≤ 收口块数（非逐 delta 数）；
- RSS/heap 采样：万 delta run 峰值 events 驻留 < 阈值；
- 既有 streaming_incremental_contract / prefix_stability 测试不回归。

**交叉**：03-R1（token 逐条 emit）、04-S1/S2/K2、10-T4——修复需与 emit 契约评审同批，避免破坏 message-end 全文兜底。

---

### L2【高 / run 内】Aggregate.thought_blocks 逐 delta 独立成块驻留

**位置**：`crates/session-loop/src/stream.rs:268-290,497-506`；交叉 04-S2

**代码现场**：

```rust
// stream.rs:288-290
ProviderStreamEvent::ThoughtDelta { text, redacted } => {
    self.thought.push_str(&text);
    self.thought_blocks.push(ThoughtBlock { text, redacted }); // 每 delta 一块
}
```

**调用链**：provider thought-delta 流 → `Aggregate` 同时持有 `thought: String`（拼接全文）**与** `thought_blocks: Vec`（逐块全文）→ finish 时 metadata 序列化两份 → Message 驻留。

**根因**：保真 thoughtBlocks 元数据契约（redacted 逐段）；未做「相邻非 redacted 合并」。

**影响量化**：

- 高频小 delta（数十字符/条）× 数千条 → Vec 元数开销 + 每块 String 堆分配；
- `thought` 字符串与 blocks 内文本之和 ≈ 2× 思考正文；长思考 run 平台期翻倍驻留。

**修复方案**：

1. 相邻 `redacted == None` 的 delta 合并进上一 ThoughtBlock（仅 new string push_str，不新开块）；
2. redacted 边界必须切块（契约）；
3. 与 04-S2「逐 delta 独立成块导致前端块爆炸」同一批修复。

**回归锚点**：纯思考流单测断言块数 = redacted 边界数+1，而非 delta 数；元数据字节不回归。

**交叉**：04-S2、03-R1（delta emit 频率）；修复合并块不影响实时轨（实时轨仍可逐 delta 发）。

---

## 四、中危发现（展开八要素）

### B1【中】EventBuffer Critical 无字节/条目硬上限

**位置**：`apps/agent-workbench/src-tauri/src/buffer.rs:13-17,42-60,84-131,194-199`；组装 `engine_channels.rs:567-588`

**代码现场**：

```rust
// buffer.rs:16-17 契约注释
// - critical_limit：新 Critical 事件永不丢——先驱逐现有 Soft 旧帧；
//   无 Soft 可驱逐时缓冲可超限（防御性接受）。
// buffer.rs:194-199 默认
Self::new(64, 256) // 仅条数水位
```

- **调用链**：`BufferedRunEventBridge.emit`（engine_channels.rs:618-658）序列化 payload → `buffer.lock().enqueue` → Critical 分支 `push_back` 永不丢；全 Critical 时 break 接受超限。
- **根因**：丢帧契约优先保 terminal/message-end/审批正确性；未定义「内存防御层」——条数水位在「全是 Critical」场景失效。
- **量化**（静态分析，待运行时验证）：256 条 × 单条 256KiB payload ≈ 64MiB 理论上界；若叠加 Critical 超限（break 后仍 push），上界进一步抬升为「直到 flush」。与 A1 mpsc 堆积同帧出现时双份。
- **修复**：增加 `byte_budget`（建议 8MiB 起）；超限对「非 terminal Critical」计数丢弃 + warn；`RunTerminal` / `MessageEnd` / `ApprovalResolved` 永不丢。字节估算复用已序列化 `payload.len()`。
- **回归锚点**：灌入大 payload Critical 断言 total 字节 ≤ 预算 + 单条最大例外；terminal 仍达；既有 20 万 delta 压测（buffer.rs stress_tests）不回归。
- **交叉**：04-O1、10-T3/S1——ToolEnd 越大本项越尖锐。

### A2【中】审计 worker 慢落库拉长堆积窗口

**位置**：`run_core.rs:186-216`；装配 `run_launch.rs:562-564`；交叉 04-O2、05 S1

**代码现场**：

```rust
// run_core.rs:199-215
while let Some(event) = rx.recv().await {
    let sequenced = queue.lock().await
        .push_terminal_best_effort(&session_id, event).await;
    // 失败仅 warn——不阻断 run
}
```

- **现场**：单 worker 串行 `push_terminal_best_effort`；无并发、无批量；与 drive_outcome 抢同一 `tokio::Mutex<EventQueue>`（04-O2）。
- **根因**：保发射序（会话内 sequence 单调）；05 组提交/批量写设施先进但生产写几乎旁路（05 结论）。
- **量化**：append P99 恶化时堆积时间线性放大（与 A1 乘积）；DB 单条写 ~1ms 时 worker 吞吐上限 ~1k 事件/s，审计风暴易超。
- **修复**：与 05 批量写/组提交同批；或审计专用 write batch（保持会话内序、批量 append）；短期可先给 mpsc 加深度采样告警。
- **回归锚点**：慢 DB 模拟下 worker 吞吐与队列深度曲线；发射序断言（sequence 单调）不回归。
- **交叉**：05-S1 组提交零接线、04-O1/O2。

### S1【中】SessionHistoryCache.get 全量 clone 读放大

**位置**：`run_history.rs:18-60`；预算 `run/mod.rs:139-149`；读取点 `run_launch.rs:806,1156`

**代码现场**：

```rust
// run_history.rs:53-60
pub(crate) fn get(&self, session_id: &str) -> Option<Vec<HistoryMessage>> {
    self.inner.lock()...sessions.get(session_id).cloned()
}
```

- **现场**：每次 run 启动 / compaction 对话源解析时 `cloned()` 整段历史（预算可达 200k token 估算正文）。
- **根因**：`Mutex` 内不可返回借用；存储形态 `Vec<HistoryMessage>` 未 `Arc` 化。
- **量化**：200k token ≈ 数百 KB～数 MB 瞬时分配（峰值，非泄漏）；与 04-K1 上下文估算、hydrate 映射叠加形成 run 启动分配尖峰。
- **修复**：存储 `Arc<Vec<HistoryMessage>>`，get 返回 `Arc` 克隆；写入时 `Arc::new` 原子替换（store 路径已原子替换语义，run_history.rs:71-85）。
- **回归锚点**：get 路径分配次数 bench；功能单测（锚点截断 / FIFO 淘汰）不回归。
- **正面叠加**：预算与截断本身是教科书级（✅1），本项只改读路径形态。

### E1【中】EngineHandle.cache_sessions 无上限/无删除

**位置**：`engine_build.rs:83-110,438,820-862`

**代码现场**：

```rust
// engine_build.rs:110
cache_sessions: Mutex<HashMap<String, SessionCacheState>>,
// :859-861 只 entry().or_default() 写回，无 remove
```

- **现场**：T-40 缓存测量状态 per-session 持久到进程退出；无容量上限；`delete_session` 未触达。
- **量化**：`SessionCacheState` 为小结构（stats + model String）；随会话数线性，量级远小于 H1 其它表，但同属「删除会话影子状态」。
- **修复**：挂 `on_session_deleted`；或 moka/LRU 上限 128。
- **交叉**：H1 合并治理批次 C。

### F1【中】declaration_order_cache 进程级静态、无会话清理

**位置**：`flow_graph_advance.rs:23-92`

**代码现场**：

```rust
// flow_graph_advance.rs:35-37
static CACHE: OnceLock<Mutex<HashMap<String, CachedDeclarationOrder>>> = OnceLock::new();
// :85-91 cache.insert(session_id.to_string(), ...) — 无对应 remove
```

- **现场**：多 agent FlowGraph 推进热路径的声明序索引缓存（性能正面：避免每轮重建 HashMap）；但键为 session_id，进程级静态永不淘汰。图声明变更时同键覆盖（:57-67 一致性检查），旧会话键仍驻留。
- **量化**：每会话 `Vec<FlowNodeId>` + `Arc<HashMap<FlowNodeId,usize>>`；单条目 KiB 级；高频建删会话的自动化场景线性累积。
- **修复**：迁出 static 挂 `CoreRunState` / FlowScheduler 注册表 + 会话删除 evict；或容量 LRU（如 256 会话）。
- **交叉**：H1 批次 C；07 restore 路径若重建 FlowGraph 应顺带 evict。

### Q1【中】PushDispatcher 离线 pending 无界（无 store 时）

**位置**：`push/pusher.rs:110-128,250-278`

**代码现场**：

```rust
// pusher.rs:118
pending: Mutex<VecDeque<PendingDelivery>>,
// :272-278 无 store 或 store 失败降级：push_back 无上限
queue.push_back(PendingDelivery { device_key, message, marked_at_ms: now_ms });
```

- **现场**：`pending_store: Option`；None 或落库失败时内存队列无上限；注释「宁可待发不丢」。
- **根因**：离线审批推送可靠性优先；未定义内存硬上限。
- **量化**：离线设备 + 审批风暴（每审批一条 PushMessage）→ 无界（静态分析结论，待运行时验证）。
- **修复**：内存路径硬上限（如 256 条）+ 丢最旧并 warn；生产装配必须注入 pending_store（main push_wiring 已注入时评估 None 分支是否仅测试）。
- **回归锚点**：无 store 灌入 10k 断言 `len ≤ 上限`；有 store 路径行为不变。

### T1【中】spawn_pending_input_save fire-and-forget

**位置**：`loop_runner.rs:342-375`；交叉 04 素材 §1.3

**代码现场**：

```rust
// loop_runner.rs:362-374
handle.spawn(async move {
    if let Err(err) = store.save_pending_input(...).await {
        tracing::warn!(...); // fail-open
    }
}); // JoinHandle 丢弃即 detach
```

- **现场**：每用户消息一次 `tokio::spawn`；不持 JoinHandle；DB 失败仅 warn。
- **根因**：EV-12 输入留痕 fail-open 语义——不阻断入队。
- **量化**：任务短命（单 INSERT + payload JSON 字符串 clone）；极端 DB 挂起时任务与 payload 堆积（与 05 连接池饱和相关）；正常路径影响可忽略。
- **修复**：每会话合并/去抖（同会话 N 条消息批量一次写）；或 `Semaphore` 限并发 pending 写；payload 可改写 Arc 序列化结果。
- **回归锚点**：快速注入 N 条输入断言运行中任务数 ≤ 并发上限；EV-12 落库语义单测不回归。

### G1【中】收口 emit_message_deltas 全块再 clone

**位置**：`streaming.rs:710-726`；调用面 `commit_message_with_deltas`（04-S5 交叉）

**代码现场**：

```rust
// streaming.rs:712-724
for block in &message.blocks {
    if matches!(block, AgentMessageBlock::Text { .. } | AgentMessageBlock::Thought { .. }) {
        state.events.push(AgentEvent::MessageDelta {
            ...
            block: block.clone(), // 全块深拷贝进 L1 驻留 Vec
        });
    }
}
```

- **现场**：收口轨对 Text/Thought 块级再 push 进 `state.events`（L1 驻留 Vec）；与实时轨 delta 并存时可能双份（取决于 `delta_sink_active`）。
- **根因**：收口 message-delta 契约（01 §五.6 序列）需要 events 轨含 delta 序列；实现未区分「实时轨已发过」的块。
- **量化**：正文全量再复制一次进 events Vec——L1 的直接放大系数；长回复 + 块级 clone = 正文字节 ×1 额外驻留。
- **修复**：与 L1 同批——收口轨仅在 `delta_sink_active==false` 时补发；或块改 `Arc<AgentMessageBlock>` 进事件（需 AgentEvent 契约评审）。
- **回归锚点**：实时轨激活时 events 内 MessageDelta 仅收口必要块；实时轨未激活时行为不变。

### W1【中】ws resume/fanout 队列有容量、载荷无大小钳制

**位置**：`server/ws.rs:331`（`RESUME_PENDING_CAPACITY`）、`server/fanout.rs:312`（`entry.capacity`）

- **现场**：条数有界（正面）；单条事件体可含全文 message-end / 大 ToolEnd——上界 = 容量 × 单条大小，可大。
- **根因**：容量按「条」设计，未按字节。
- **量化**：若 capacity=32、单条 1MiB → 32MiB 上界（示例量级，待读常量实测）。
- **修复**：入队前对 payload 字节钳制或只存事件引用/摘要；超限丢弃最旧非 terminal。
- **交叉**：03 IPC 大 payload 直传、08 前端侧对应队列。

---

## 五、低危发现（展开）

### D1【低】StatusDiagnostics 环形 20 + last_error 单槽

- **位置**：`status_diagnostics.rs:98-139`
- **判定**：环形丢弃最旧已有界；`last_error` 为 `AtomicSlot` 单槽覆盖。低危登记仅为「勿在 `record` 的 `message` 参数堆超大字符串」的防回潮备注。
- **修复**：可选——`message` 截断 1KiB；非必须。

### P1【低】PTY Detached 宽限内子进程 + master 句柄驻留

- **位置**：`pty/session.rs:32-39,60-88,142-159,458-563`；GC `pty/mod.rs:136-178`
- **设计语义**：MAX 16；Active>120s 无活动 → Detached 托管；Detached 超 2h 无 stdout+重连 → GC kill；reader 线程 EOF 后 wait + remove（正面，无句柄泄漏路径）。
- **判定**：Rust 侧**无** PTY 历史缓冲（历史在前端 xterm，02-X2 范围）——引擎侧驻留仅为会话对象 + 子进程 OS 资源，属有意设计。
- **修复方向（可选）**：缩短 Detached 宽限；提供「Detached 列表 + 手动 kill」命令面；非泄漏缺陷。

### N1【低】once_cell 大结构进程级常驻

- **位置**：`highlight.rs:17`（`SYNTAX_SET`）、`models/catalog.rs:361-372`（bundled catalog）、`sanitizer.rs` 多组 Regex Lazy、`conex-types/error.rs:212` 错误注册表
- **判定**：有意的进程级只读缓存；体积可观（syntect 默认语法表数 MiB）但 O(1) 驻留、无增长。低危登记 = RSS 基线记录项，禁止「清理」回潮。
- **修复**：无；运行时 V10 记录基线即可。

### C1【低】Arc 环审查：未发现生产强引用环

- **位置**：`run_core.rs:1080-1089`（`CoreRunStateLauncher.state: Weak<CoreRunState>`）；`BridgeLiveSink` 持 `Arc<BufferedRunEventBridge>` 无反向强引用；`RoutingAuditSink.routes: Arc<AuditSink>` 收口 remove
- **扫描面**：全 crates `Arc::new_cyclic` 零命中；`Weak` 使用集中在 launcher 与 watch flush 线程（conex-fs WeakSender 正面）。
- **判定**：当前无 Arc 环泄漏路径；低危作为「新增回调/注册表必须 Weak 先例」的纪律锚点。

### R1【低】SESSION_ABORT_REGISTRY 生产未接线

- **位置**：`engine_provider/stream.rs:29-53`；register/unregister 均为 `#[cfg(test)]`
- **判定**：生产路径**永不写入**该表——无泄漏；同时说明 abort 注册功能未在生产启用（仅登记）。
- **修复方向**：若未来生产接线，必须成对 register/unregister + 收口清理；禁止「只 insert」。

### X1【低】search/trash 路径分配为调用期临时峰值

- **位置**：`conex-search/src/lib.rs:128-150`、`conex-fs/trash.rs:418-437`、`path_normalizer.rs:22`
- **判定**：无 Rust 侧常驻搜索索引（06-SR03 为每调用重建，属 CPU/临时分配而非驻留泄漏）；trash list 为调用期 Vec，调用结束 drop。
- **交叉**：06 方向已展开 SR03/FS02；本文确认「非长期驻留」。

### J1【低】JoinHandle 生命周期：driver detach 有意 + audit await 正面对照

- **位置**：`run_core.rs:68-84,90-104`；收口 `run_idle.rs:1451-1458`；孤儿收割 `run_commands.rs:986-1027`
- **判定**：driver 收口不 await（JoinHandle drop 即 detach，30-P1 有意防挂起）+ `reap_orphan_runs_round` 去抖收割兜底——无句柄泄漏。audit_persist 为对照正面（take + await 排空）。
- **修复**：无；保持孤儿收割与 audit await 成对纪律。

### V1d【低】RunOutcome.events 消费后 drop 时机

（编号 V1d 避免与运行时验证表 V1 混淆）
- **位置**：`loop_exec.rs:330-335`（mem::take 移交）；消费面 orchestrator drive_outcome
- **判定**：`mem::take` 本身是正面（converge 清空）；`RunOutcome.events` 在 drive_outcome 逐事件处理后随局部 drop——依赖驱动方不长期持有 outcome。静态未见长期持有路径；低危作为「勿把 RunOutcome 存进全局结构」的纪律锚点。
- **修复**：无；若未来 outcome 入队缓存，必须消费后 drop 或 Arc 化 + 水位。

---

## 六、正面发现（禁止回潮，展开）

| # | 结构 | 位置 | 为何是正面 | 回潮禁令 |
| - | ---- | ---- | ---------- | -------- |
| ✅1 | SessionHistoryCache | `run_history.rs:18-85`、`run/mod.rs:143-149` | 每会话 200k token 预算 + 首 user 锚点截断 + 32 会话 FIFO | 禁止改回无预算全量驻留 |
| ✅2 | EventBuffer Soft 水位 | `buffer.rs:13-17,98-121` | delta 可丢、terminal 必达；默认 64/256 条 | 禁止 Critical 改为可丢；禁止拆除 Soft 丢帧 |
| ✅3 | PTY 容量+GC | `pty/session.rs:32-39,142-159`；`pty/mod.rs:136-178` | MAX 16；Detached 2h 宽限；30s GC 惰性拉起+空转自毁 | 禁止去掉 GC 或容量上限 |
| ✅4 | 审计路由注销 | `engine_audit.rs:82-96`；`run_idle.rs:1446` | run 收口强制 unregister，防桥泄漏 | 禁止注册后不注销 |
| ✅5 | 审计 worker 收口 await | `run_idle.rs:1451-1458` | 终态前排空落库；take 后 await 不跨 std 锁 | 禁止改为不 await 的纯 detach |
| ✅6 | PendingMessageQueue | `steering_queue.rs:27-28,165-171` | 默认 100 有界 + steering 优先挤占 | 禁止无界 push |
| ✅7 | TaskAuditAccumulator | `task_events.rs:321-341,452-455` | 1000 条 FIFO + 终态清 commands 映射 + 同 task+result 原位替换 | 禁止去掉容量 |
| ✅8 | Weak 断环 | `run_core.rs:1080-1089` | 子代理 launcher 用 Weak，防 CoreRunState Arc 环 | 新回调禁止改回强 Arc 自引用 |
| ✅9 | StatusDiagnostics 环形 20 | `status_diagnostics.rs:98-126` | 诊断面有界 | 禁止改无界 Vec |
| ✅10 | SSE 4MiB pending 上限 | `agent-provider/sse/frame.rs:59,93-97` | 流分帧器防单帧/累计膨胀 | 禁止拆除 MAX_PENDING_BYTES |
| ✅11 | 摘要任务单飞+全局上限 | `summary_coordinator.rs:168-197` | 防 spawn 风暴；ACTIVE 计数失败回滚 | 禁止绕过 MAX_CONCURRENT |
| ✅12 | markdown 单条 1MiB 预检 | `cache.rs:15-16,61-64` | 防一条巨物独占预算 | M1 修复后必须保留 |
| ✅13 | conversation Arc 共享 | `handlers/mod.rs:70-72`；`loop_exec.rs:334` | 记录路径 0 深克隆；mem::take 收口 | 禁止改回全量 clone |
| ✅14 | 孤儿 run 收割 | `run_commands.rs:986-1027` | driver detach 后去抖收割，防 ActiveRun 泄漏 | 禁止去掉 reaper |

---

## 七、修复路线图（不谈工期，仅逻辑批次）

| 批次 | 内容 | 依赖 | 触及发现 | 验收断言 |
| ---- | ---- | ---- | -------- | -------- |
| **A** | moka 预算接线（`max_capacity(CACHE_BUDGET_BYTES)`）+ 前后端预算表对齐评审 | 无 | M1 | weighted_size ≤ 预算；二次渲染命中 |
| **B** | 审计通道有界化（字节预算或 Arc 载荷）+ EventBuffer 字节水位 + 审计批量写评估 | 与 04-R / 05 批量写同批设计 | A1, B1, A2 | 慢 DB 下队列深度 ≤ N；terminal 必达 |
| **C** | 会话删除清理钩子：四表 evict + declaration_order_cache 迁出 static | 无 | H1, E1, F1 | 建删 1k 后四表 len ≤ 活跃会话数 |
| **D** | LoopState.events 分级驻留（Soft 不进 Vec / Arc 共享）+ 收口 delta 条件化 | 需 03 emit 契约确认 | L1, G1 | 万 delta run 的 events 峰值显著下降 |
| **E** | thought_blocks 相邻合并（redacted 边界切块） | 与 04-S2 同批 | L2 | 块数 = 边界数；元数据不回归 |
| **F** | SessionHistoryCache Arc 化读路径 | 无 | S1 | get 无全量 clone 分配 |
| **G** | Push pending 内存上限；pending_input 写并发信号量/去抖 | 无 | Q1, T1 | 无 store 灌入有界；任务数 ≤ 上限 |
| **H** | ws 载荷字节钳制 | 与 03 IPC 面协调 | W1 | 容量×单条上界可证明 |

**性价比排序建议**：A（单点、立即消除缓存失效）→ C（防长进程爬升，四表一次收口）→ B（与 04/05 收敛，内存+吞吐双收益）→ D/E（run 内峰值）→ F/G/H。

**明确不做**（反过度设计）：

- 不为 SYNTAX_SET / bundled catalog 引入按需卸载（收益低、复杂度高）；
- 不在 EventBuffer 引入完整 LRU 条目对象（字节水位足够）；
- 不为 declaration_order_cache 上 moka（HashMap + 会话 evict 足够）。

---

## 八、运行时验证建议（V 项，待回填）

| ID | 验证项 | 方法 | 关联发现 | 期望 |
| -- | ------ | ---- | -------- | ---- |
| V1 | markdown 缓存命中率 | 埋点 get hit/miss；连续渲染同文档两次 | M1 | 修复后第二次 hit；修复前≈0 |
| V2 | 缓存加权占用 | `cache.weighted_size()` 周期采样 | M1 | 修复后 ≤ 32MiB；当前≈0～2KiB |
| V3 | 审计队列深度 | 慢 DB 注入（05 persist delay 钩子）+ 工具风暴；采样 mpsc 深度 | A1 | 有界后 ≤ N；无界时线性涨 |
| V4 | EventBuffer 字节 | 全 Critical 大 payload 灌入 10k | B1 | ≤ 字节水位 + 单条例外；terminal 仍达 |
| V5 | 会话四表长度 | 建删 1k 会话；对比活跃会话数 | H1 | len ≤ 活跃数（修复后） |
| V6 | events Vec 峰值 | 万 delta + 多工具 run；heap 采样 / dhat | L1 | 分级后峰值显著下降 |
| V7 | thought 块数 | 高频 thought-delta 流 | L2 | 块数 = redacted 边界数 |
| V8 | 历史 get 分配 | bench：get 路径分配字节 | S1 | Arc 化后无全量 clone |
| V9 | push pending | 离线设备 + 审批风暴 10k | Q1 | 有上限（修复后） |
| V10 | RSS 长开基线 | 8h 空转 + 周期会话建删；记录 SYNTAX_SET 基线 | H1/N1 | 清理后斜率≈0；基线稳定 |

**采样通道**：优先 Tauri MCP（`127.0.0.1:4000`）对真宿主采样；禁止 5174 浏览器冒充（AGENTS §15）。heap 采样可用 `dhat` / `jemalloc` profiling 构建，或 Windows 工作集 + `!heap` 扩展；崩溃转储对比删除会话前后 `next_sequences` 键数。

**与 04 V 项衔接**：04-V4/V9（审计队列深度 vs 有界）与本文 V3/V4 同一实验面——04 看吞吐丢帧计数，09 看 RSS/队列字节。

---

## 九、交叉引用矩阵（展开）

| 方向 | 交叉点 | 本文补位 | 是否重复展开 |
| ---- | ------ | -------- | ------------ |
| 04 热路径 | O1 审计无界、O2 双生产者锁、S1 收口克隆、S2 thought 块、S5 收口 delta | 内存驻留量化、EventBuffer 字节层、L1 平台期驻留、H1 会话影子 | 否——04 为 CPU/锁视角 |
| 05 SQLite | 组提交零接线、读持主锁 → 审计 worker 慢 → A1 堆积 | 批次 B 同批设计；A2 吞吐窗口 | 否——05 为写路径视角 |
| 06 文件/搜索 | SR03 全量重建、trash list 全扫、FS02 二次分配 | X1 确认「临时峰值非驻留」 | 否 |
| 07 启动 | restore seed `next_sequences`；B1 CoreRunState 全量装配 | 删除会话后 seed 幂等；H1 清理钩子 | 否 |
| 08 前端内存 | 事件监听、消息全量驻留 | 对称：Rust 侧删除会话影子状态（H1）；历史缓存引擎侧权威 | 否——08 为 DOM/订阅视角 |
| 10 工具/MCP | T1 FS 阻塞、T3 批事件、T4 输出预算、S1 shell bytes、M1 MCP stdout | L1/A1 放大系数：大 ToolEnd 三副本 | 否——10 为执行吞吐视角 |
| 03 IPC | R1 token 逐条 emit、R4 收口串行、message-end 全文 | L1 修复需契约评审；B1 字节层与 03 丢帧契约对齐 | 否 |
| 02 长列表 | X2 PTY 零合批（前端） | P1 确认 Rust 侧无 PTY 历史缓冲 | 否 |
| 13 Compaction | 上下文压缩触发 | S1 Arc 化后对话源 clone 降低 | 否 |
| 16 可观测 | perf 资产 | V1–V10 采样通道；RSS 基线入 perf 门禁候选 | 否 |

---

## 十、与总纲状态同步建议

- 方向 09 置「已完成」；总纲 §一 表与 §三 进度日志已同步。
- 报告路径 `09-Rust侧内存审查报告.md`；素材 `materials/09-Rust内存扫描素材.md`。
- **TOP3 高危**：M1（moka 语义）/ A1（审计×Critical 叠加）/ H1（会话四表无清理）。
- 批次 A/C 可立即开工（无跨方向契约）；批次 B/D 需与 04-R、03 契约评审联动；批次 E 与 04-S2 同批。
- `90-发现清单索引.md` 登记时 M1 应升格为**跨方向**（同时影响渲染 CPU 与内存预算语义）；A1 与 04-O1 合并为「审计通道有界化」单票，本文贡献内存维度验收（V3/V4）。

---

## 附录 A · 扫描覆盖清单（证明范围锁履行）

| 范围锁条目 | 覆盖情况 | 主要产出 |
| ---------- | -------- | -------- |
| session-loop 事件 Vec / LoopState | ✅ | L1, L2, G1, V1d |
| orchestrator EventQueue / 审计分流 | ✅（内存视角） | A1, A2；锁视角引用 04-O2 |
| conex-db | ✅ 交叉 | 经 05 结论传导 A2；conn 缓存 PRAGMA 非堆驻留 |
| engine_channels + buffer | ✅ | A1, B1；BridgeLiveSink/Buffered 正面对照 |
| 流缓冲 / EventBuffer | ✅ | B1；SSE 4MiB 正面 ✅10 |
| PTY 历史 | ✅ | P1——Rust 侧无历史缓冲（结论） |
| audit 通道 | ✅ | A1（04-O1 内存深化） |
| conex-markdown 缓存 | ✅ | M1；单条预检正面 ✅12 |
| search 索引 | ✅ | X1——无常驻索引 |
| fs/trash 路径大分配 | ✅ | X1——调用期临时 |
| Arc 强引用环 | ✅ | C1——未发现；Weak 正面 ✅8 |
| Mutex 内部长驻 Vec | ✅ | SessionHistoryCache（正面）；EventBuffer（B1）；diagnostics（正面） |
| 全局 once_cell 大结构 | ✅ | N1, F1, R1 |
| tokio task 泄漏 | ✅ | T1；摘要单飞正面 ✅11 |
| JoinHandle 不 abort | ✅ | J1——driver detach 有意 + reaper 兜底 |
| child process 句柄 | ✅ | P1——PTY wait+remove 正面 |
| 与 04/05/10/06 交叉 | ✅ | §九矩阵；clone 热点不重复 |

---

_审查完成：静态 22 项发现（5 高 / 10 中 / 7 低）+ 14 正面；运行时 V1–V10 待 Tauri MCP 生产包回填。_
_产出：`docs/performance-audit/09-Rust侧内存审查报告.md` + `docs/performance-audit/materials/09-Rust内存扫描素材.md`_
