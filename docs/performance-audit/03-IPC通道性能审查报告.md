# 03-IPC通道性能审查报告：事件吞吐与序列化

> **战役**：全面性能审查（performance-audit），方向 03 / 共 12 方向
> **总纲**：`docs/performance-audit/00-性能审查总纲.md`
> **日期**：2026-09-12
> **检查对象**：Tauri IPC 全链路 —— Rust 事件源头（session-loop → 壳 emit）、invoke 命令面（145 条命令）、前端传输层（transport / EventRouter / fanout）、契约面（engine-events.json，57 事件）
> **方法**：4 路并行只读探查（Rust 事件源 / invoke 命令 / 前端传输 / 契约消费）+ 全仓扫描；全部结论带 `文件路径:行号`；运行时未实测项在 §8 单列。
> **与 01/02 的关系**：01 报告 M7（前端每事件同步 parse）已展开；02 报告 X2（PTY 零合批）属本方向同族问题，交叉互引不重复展开；01 报告 M9（持久化全量序列化）在本文 I1 得到 Rust 侧完整证据闭环。

---

## 0. 阅读指南

- 编号规则：**R**=Rust 事件源头域、**I**=invoke 命令域、**V**=前端传输域、**C**=契约域。
- 严重度定义同 01 报告 §0；本文额外采用 Rust 侧证据自带的 P0/P1/P2/P3 标注作为佐证（两套标尺映射：P0/P1≈高，P2≈中，P3≈低）。
- 每条问题统一模板：**位置 → 现象 → 代码现场 → 调用链与触发时机 → 根因 → 影响量化 → 修复方案 → 回归风险**。
- **契约变更警示**：R2/C1/C3 的修复涉及 `engine-events.json` 契约（57 事件，`registry_drift` 测试双端锁定），须升 schemaVersion 并同步生成 parser；文中逐条标注。

## 1. 执行摘要

**一句话结论：IPC 通道的工程纪律（spawn_blocking 覆盖、锁不跨 await、丢帧语义测试锁定、手写 parser 零 zod）明显优于平均水平，但存在三个结构性浪费——token 流逐条 emit 且契约明文禁止合并、非增量事件对 webview 双发、message-start 全文传输后前端零消费——三者叠加使一个普通 run 的 IPC 体积与事件数放大约 2–3 倍。**

- **Rust 源头（R）**：每条 LLM delta 一次全链 emit（2 次 String clone + 1 次时间戳格式化 + serde 序列化 + 2 次缓冲锁 + WebView IPC），中游零节流且**契约明文禁止聚合**（`provider.rs:191-193`）；实时轨 emit 后立即 flush 使缓冲层形同虚设；NoPersist 事件白付 3 条 SQL 取号；收口持久化逐条同步 await。
- **invoke 命令（I）**：145 条命令注册面三方一致；最大浪费点是 `save_session_body`——前端 350ms debounce 全量重发所有会话（含未变更的），Rust 侧先 `DELETE` 全表片段再逐条 `INSERT`，全局 DB 锁贯穿事务，且前端传的 `batch_version` CAS 参数**在 Rust 签名中被静默丢弃**；boot 水合对全部历史会话并行 2×N 次 IPC；fs 三命令是同步 `fn`（唯一违反 spawn_blocking 纪律的缺口）。
- **前端传输（V）**：事件 fanout 到 4 个订阅者，`resolveEventType` 每事件跑 3 次；**数据面事件（10 类）在 run 活跃期被完整解析两次**（dataPlaneRouter 解析后 EventRouter 再解析再丢弃——过滤前移即可消除）；`workbench_list_background_tasks` 被 4s 与 3s 两条轮询重复拉取；超时后底层 invoke 悬挂不取消。
- **契约（C）**：`message-start` 携带全文但前端 live/replay 双路径均零消费（空实现）——每条消息全文多传一遍、多落库一份、多严格解析一遍；`emit_event` 对每事件深 clone 一次，`ToolEnd.output`（可达 200KB）未 Arc 化，Rust 侧即付全量深拷贝；信封固定开销 135–195B/事件，对几十字节的 message-delta 占比可超 50%。

**发现计数**：10 高（R1 R2 R3 R4 R5 I1 V1 C1 等）/ 11 中 / 9 低或信息项。修复路线图批次 K–O（§7），其中批次 K（Rust 局部减负）与批次 N（前端传输收敛）不动契约、可先行。

## 2. 检查范围与方法

### 2.1 对象与规模

| 维度 | 数值 |
| ---- | ---- |
| emit 调用点（src-tauri 非测试） | ≈34 处；run-event 链核心 13 处 |
| 事件类型 | 57（registry 与 Rust enum 双端一致，`registry_drift` 锁定） |
| invoke 命令 | 145（注册面 = manifest = 前端清单三方一致，`command_manifest.rs:316-334` 测试锁定） |
| 前端 invoke 调用点 | ≈147（transport 通道 20 / invokeTyped 直调 ≈123 / daemonClient 裸 invoke 4） |
| 前端事件解析器 | `packages/shared-types/src/generated/engine/parser.ts`，2292 行手写校验（zod 命中 0） |
| Rust 侧缓存 | markdown 渲染 2048 条/32MB + 高亮 2048 条/32MB（`conex-markdown/src/cache.rs:10-16`） |

### 2.2 端到端事件链路全景（现状）

```text
【产生】provider SSE → session-loop stream.rs 消费聚合
  → streaming.rs consume_stream：每条 TextDelta/ThoughtDelta 即时转发
  → provider.rs DeltaSink/LiveEventSink trait（进程内直调，无 mpsc 队列）
  → 壳 engine_channels.rs BridgeLiveSink::push_live
      → AgentEventEnvelope::new(event, runId, sequence=None)
      → BufferedRunEventBridge::emit   [serde 序列化① + Mutex 入队]
      → flush（立即）                  [Mutex 出队]
      → EventBridge::emit_payload → PushAwareEmitter.emit（装配时：全量 JSON 反解析#A）
                                  → TauriEmitter → app.emit("workbench-run-event") → WebView IPC
                                  → FanOutEmitter（装配时：全量 JSON 反解析#B + Value 深拷贝）
【收口】LoopState.emit_event → events: Vec 累积（event.clone() 深拷贝）
  → orchestrator events.rs drive_outcome → EventQueue::push 逐条 await
      → reserve_sequence [3 条 SQL + 全局连接 Mutex]（含 NoPersist 事件！）
      → serde 序列化② → append_event [SQLite INSERT 同步等待]
  → run_idle.rs 第 3 步：非 delta 事件重新信封化（sequence=实际值）
      → bridge.emit [serde 序列化③] + flush → 第二次 WebView IPC 投递（双发）
【消费】tauriTransport listen 回调 → safeParseEventPayload(JSON.parse)
  → fanout ×4：dataPlaneRouter / subagentPlaneRouter / readiness / per-run EventRouter
  → resolveEventType ×3 → parseBridgeEvent（strict parser）→ handler → store
```

### 2.3 契约事件分类与 payload 量级（57 事件清单摘要）

| 分类 | 事件（wire 名） | 持久化 | 桥优先级 | payload 量级 |
| ---- | -------------- | ------ | -------- | ------------ |
| 消息域 | message-start / message-delta / message-end | start/end 持久，delta NoPersist | delta=Soft（唯一可丢） | **start/end=全文**（KB–数百 KB）；delta=增量 250–500B |
| 工具域 | tool-start / tool-end / tool-batch-start / tool-batch-end | start/end 持久，batch 持久 | critical（不可丢） | **tool-end=完整输出**（≤200KB shell / 其他无上限）；batch=摘要级 ~100–140B/条（EV-09） |
| 审批域 | approval-requested / -resolved / -cancelled | 持久 | critical | request.parameters=全量入参（KB–数十 KB），低频 |
| 运行域 | run-started / run-terminal / run-idle / run-failed 等 | 持久 | critical | 小（元数据） |
| steering | runtime-steering / steering-ack 等 | 部分 | critical | message 全文（未 Arc 化），低频 |
| 子代理 | agent-start / agent-progress / subagent-event / agent-end | progress=NoPersist | progress=Soft | event.payload（JsonValue 任意，未约束） |
| 数据面 | task-* ×7 / timer-* ×2 / cron-fired | task-output 等多数 NoPersist | Delta（可丢） | task-output 每条 ~KB；高频流 |
| 上下文 | context-compression-* | 持久 | critical | summary + 5 个 string[]（KB–数十 KB），低频 |
| 诊断 | engine-* / gateway-* | 少量 | — | 小 |

### 2.4 四路检查动作

| 路 | 主题 | 覆盖面 |
| -- | ---- | ------ |
| A | Rust 事件源头 | emit 全链走读（streaming.rs → provider.rs → engine_channels.rs → core_event_bridge.rs → run_idle.rs）；NoPersist 取号；序列化次数；背压策略；锁盘点 |
| B | invoke 命令面 | 145 命令清单；大返回/大参数命令 handler；轮询命令清单；spawn_blocking 普查（65+ 处）；core_md_render 缓存；config 读写频率 |
| C | 前端传输层 | tauriTransport 4 层抽象走读；超时/重试/并发；safeParseEventPayload（zod 排查）；fanout ×4 重复解析；invoke 调用点普查（147）；水合分页；三通道语义差异 |
| D | 契约消费面 | engine-events.json 57 事件全清单；大 payload 事件 TOP 排名；Arc 化程度；emit_event 深克隆；message-start/tool-batch 前端消费核实；信封开销；parser 结构抽查 |

## 3. 正面发现（已验证防线，禁止回潮）

| # | 设计 | 证据 |
| - | ---- | ---- |
| P1 | EventBuffer 丢帧语义完备：Soft/Critical 两级、丢旧保新、终态必达，**20 万条 delta 压测锁定** | `engine_channels/src/buffer.rs:79-146, 349-456` |
| P2 | message-start/end 载荷 Arc 化：`Arc<AgentMessage>` 共享，消除每消息 2 次全文深克隆，bench + 不变量测试三重锁定 | `conex-types/src/events.rs:390-393, 440/455`、`run_loop.rs:1195-1262` |
| P3 | spawn_blocking 纪律：65+ 处覆盖全部 async 数据面命令（session 13 命令、note 双引擎、core 工具组、pty、prefs/usage/browser 全合规）；「tokio worker 不执行同步 SQLite」抽检成立 | `session_commands.rs:119-531` 等 |
| P4 | markdown 渲染 Rust 侧双缓存（2048 条/32MB×2，巨物不入缓存）+ 5MB 输入截断 + 前端批量预热单 IPC（`core_md_render_batch`） | `conex-markdown/src/cache.rs:10-16`、`markdown_commands.rs:29-40` |
| P5 | 前端事件解析零 zod：2292 行手写守卫式 parser（`reqField` 一次 typeof + 256 层深度上限），对大 text payload 近零成本 | `shared-types/src/generated/engine/parser.ts:65-92` |
| P6 | 事件链引用透传无深拷贝：parsed 对象经 fanout 传递零 clone；去重集合 2000 条 FIFO 有界 | `tauriTransport.ts:498-507`、`EventRouter.ts:49-50, 250-259` |
| P7 | 事件分页下推 SQL：`core_read_session_events` limit 进查询（DM-07 修复原 O(n) 全量读），默认 200/上限 1000 | `core_query_commands.rs:40-45, 721-755` |
| P8 | useEngineState 轮询样板：hidden 跳过 + `_setState` 浅等 + `_normalizeBgTasks` 内容级比较 + refcount 生命周期 + 数据面事件驱动刷新 | `useEngineState.ts:79-109, 142-160, 204-239, 252-312` |
| P9 | 旁路背压完备：WS 扇出每订阅者有界队列（Critical 必达/Soft 丢旧/Delta 丢新）+ dropped_total 可观测；push 决策引擎合并桶 + 500ms flush | `fanout.rs:306-346`、`pusher.rs:335-346` |
| P10 | 锁纪律：全部锁不跨 await（AA-02），中毒恢复统一 `POISON_RECOVERIES` 计数，无 panic 传播路径 | `engine_channels.rs:40-46` 全链抽检 |
| P11 | EV-09 摘要化：tool-batch-start/end 的 input=Null/output=empty，全量数据只在 tool-start/tool-end 单事件承载 | `executing_tools.rs:240-266, 409-418` |
| P12 | 传输生命周期：全局单 listen（幂等双守卫）、per-run EventRouter 退订链异常安全幂等（测试锁定）、boot 握手先挂监听后 probe | `tauriTransport.ts:470-530`、`streamRunLifecycle.ts:36-88` |
| P13 | 收口 message-delta 不双发（T09.1 契约正确落地：实时轨已发 delta，收口轨跳过） | `run_idle.rs:1405-1411` |
| P14 | 三方一致的命令注册面（宏单源 → manifest → 前端清单），drift 测试锁定 | `command_manifest.rs:316-334` |

## 4. 问题清单

### 4.1 Rust 事件源头域（R）

---

#### R1.【高 / P0】流式 token 逐条 emit，中游零节流——且契约明文禁止合并

- **位置**：
  - 转发点：`crates/session-loop/src/loop/handlers/streaming.rs:155-173`
  - 契约约束：`crates/session-loop/src/provider.rs:191-193`
  - delta 事件构造：`streaming.rs:689-708`
  - 实时 sink：`apps/agent-workbench/src-tauri/src/engine_channels.rs:714-728`
- **现象**：每条 LLM delta 一次全链 emit，Rust 侧无任何时间窗合并（grep `throttle|coalesce|debounce` 在 session-loop 零命中）；且增量性硬约束**明文禁止跨帧聚合**。
- **代码现场**：

```rust
// provider.rs:191-193 —— 契约明文
/// - 增量性硬约束：TextDelta / ThoughtDelta 按产出顺序**逐事件**流出，禁止
///   跨帧/跨块聚合后一次性 emit（P1 修复本质，PE-02 §3.1.2）；

// streaming.rs:689-708 —— 每条 delta 的固定开销
fn delta_to_message_event(session_id: &str, message_id: &str, event: &ProviderStreamEvent) -> Option<AgentEvent> {
    let block = match event {
        ProviderStreamEvent::TextDelta { text } => AgentMessageBlock::Text { text: text.clone() },  // clone①
        ...
    };
    Some(AgentEvent::MessageDelta {
        session_id: session_id.to_string(),      // clone②
        timestamp: conex_shared::time::now_iso_utc(),   // 时间戳格式化
        message_id: message_id.to_string(),      // clone③
        block,
    })
}

// engine_channels.rs:714-728 —— emit 后立即 flush
fn push_live(&self, event: AgentEvent) {
    let envelope = AgentEventEnvelope::new(event, Some(self.run_id.clone()), None);
    self.bridge.emit(&envelope);   // serde 序列化 + Mutex 入队
    self.bridge.flush();           // 立即出队全发 —— 缓冲形同虚设
}
```

- **调用链与触发时机**：SSE 帧 → `delta_to_message_event` → `push_live` → 信封构造 → `emit`（序列化 + 入队）→ `flush`（出队）→ `emit_payload` → listeners → `app.emit` → WebView IPC。频率 = SSE delta 帧率（典型 20–80/秒/流；多子代理并行上限 16 时理论峰值 >1000/秒）。
- **根因**：设计契约（PE-02：逐事件流出保证前端增量语义简单）与性能目标冲突。注意前端已有 48ms batcher + rAF 帧预算兜底（01 报告 P1），所以 **Rust 侧合并不改变前端语义**，只改变 wire 上的事件数——契约禁止的是「跨帧聚合改变增量顺序」，而「同 message 同 block 的文本追加合并」是顺序保持的。
- **影响量化**：每帧固定成本 ≈ 3 次 String 分配 + 1 次时间戳格式化 + 1 次 serde 序列化 + 2 次缓冲锁 + 1 次 WebView IPC 序列化与派发。80 帧/秒 × 16 子代理峰值下仅 Rust 侧序列化即数十 ms/秒。**注意**：契约文件同时要求 `timestamp` 每条 delta 携带——合并后此项成本同步下降。
- **修复方案**：三档递进：
  1. **低风险档（不动契约）**：`BridgeLiveSink::push_live` 内加 8–16ms 时间窗微批（同 session+messageId 的 TextDelta 文本拼接后合并 emit），语义为「同一 block 的追加合并」，与前端 batcher 语义一致；契约修订（明确允许同 block 追加合并）同步文档。
  2. **中档**：放宽 `provider.rs` 契约注释为「允许同 messageId+block 类型的追加合并，禁止乱序/丢弃」，升 schemaVersion（信封无需变，delta 语义不变）。
  3. **验证**：`buffer.rs` 压测（20 万条）已有，补合并正确性测试（合并前后前端累计文本等价）。
- **回归风险**：前端 `eventDedupe`（delta 无 sequence 100% 直通，`eventDedupe.ts:86-96`）不受影响；01 报告 H1 修复后前端块切分依赖 delta 连续性——合并保持顺序即安全。**这是本方向收益最大单点**（与 01 批次 A 正交叠加）。

---

#### R2.【高 / P0】非增量事件对 webview 双发（实时轨 + 收口轨），message 全文随事件走两遍

- **位置**：
  - 单点发射（双轨）：`crates/session-loop/src/loop/handlers/mod.rs:173-179`
  - 收口第二次 emit：`apps/agent-workbench/src-tauri/src/run/run_idle.rs:1397-1428`
  - 全文载荷：`crates/conex-types/src/events.rs:436-460`
- **现象**：`emit_event` 同时推持久化轨与实时轨；run 收口时对全部非 delta 事件**重新信封化（注入 sequence）后再次 emit**——同一事件跨 IPC 两次。收口 message-delta 已正确跳过（P13），但 message-start/end、tool-start/end、approval-* 等全部双发。
- **代码现场**：

```rust
// mod.rs:173-179 —— 单点发射 = 双轨
pub(crate) fn emit_event(&mut self, event: AgentEvent) {
    self.events.push(event.clone());          // 持久化轨（深克隆，见 C2）
    if let Some(sink) = &self.options.hooks.live_sink {
        sink.push_live(event);                // 实时轨（move）
    }
}

// run_idle.rs:1397-1428 —— 收口第二轮 emit
for sequenced in driven.events {
    if active.delta_sink_active && matches!(sequenced.event, AgentEvent::MessageDelta { .. }) {
        continue;                             // 仅 delta 跳过
    }
    let envelope = AgentEventEnvelope::new(sequenced.event, Some(run_id.clone()), Some(sequenced.sequence));
    report.add(active.bridge.emit(&envelope));   // ← 非增量事件第二次全量 IPC
}
```

- **根因**：实时轨 sequence=None（DIM-01），收口轨注入真实 sequence——前端没有对账机制（V 域证据：F5-12 已删除游标死代码，前端不消费 sequence 对账，`EventRouter.ts:4-5`），因此**收口轨对 webview 的唯一增量价值是 sequence 字段，而前端不读它**。
- **影响量化**：K 轮工具 run 每轮 ≈6–12 条非 delta 事件双发；message-start/end 各携带全文（C1），长回复数百 KB 时双发即双倍传输 + 双次 serde 序列化 + 前端双次 JSON.parse + 双次 strict parser。普通 run 的 IPC 体积放大约 1.8–2.5×。
- **修复方案**：收口轨对 webview 降级为**轻量 sequence 回执**（`{type:"<event-type>", runId, sequence, eventId}` 摘要信封，不含 payload），前端按需对账（现状：无消费者，回执仅日志级）；或实时轨预分配 sequence（从 `reserve_sequence` 批量预取区间），收口轨 webview 完全免发。**涉及契约**：新增回执事件类型或信封加 `sequenceOnly` 标记，升 schemaVersion。
- **回归风险**：WS 扇出/push 旁路依赖收口轨事件做转发——需保留完整事件给旁路（可旁路走事件存储读取而非二次 emit）；`registry_drift` 同步。

---

#### R3.【高 / P1】NoPersist 事件白付 SQLite 取号：每条 3 条 SQL + 全局连接锁

- **位置**：`crates/orchestrator/src/events.rs:244-264`（取号先于落库判定）；`crates/conex-db/src/events.rs:201-227`（reserve_sequence 本体）
- **现象**：收口批次每条事件先 `reserve_sequence`（spawn_blocking + 3 条 SQL + conn Mutex），**然后** `is_non_persistent` 判定——delta 等不落库事件直接 `persisted: false` 返回，取号成本白付。这些事件的 emit 在 run_idle 又被跳过（P13），等于完整白走一遍。
- **代码现场**：

```rust
// events.rs:244-264 —— 顺序颠倒
let sequence = match self.reserve(session_id).await {   // ← 先取号（3 SQL + Mutex）
    Ok(sequence) => sequence, ...
};
if is_non_persistent(&event) {
    return Ok(SequencedEvent { sequence, event, persisted: false });   // ← 后判定不落库
}

// conex-db/src/events.rs:201-227 —— 取号 = INSERT OR IGNORE + SELECT + UPDATE
conn.execute("INSERT OR IGNORE INTO session_sequence ...", ...)?;
let sequence = conn.query_row("SELECT next_sequence FROM session_sequence ...", ...)?;
conn.execute("UPDATE session_sequence SET next_sequence = next_sequence + 1 ...", ...)?;
```

- **影响量化**：一轮含 N 个 thought/text block 的消息多付 N 次（spawn_blocking 调度 + 3 SQL + Mutex）；500 事件 run ≈ 全部 delta 类事件（数百条）× 3 SQL 纯浪费，同时加剧 R4 的串行化。策略函数 `event_policy`（`conex-types/src/events.rs:1318-1432`）已能**静态判定** NoPersist。
- **修复方案**：`is_non_persistent(&event)` 判定前移到 `reserve` 之前（零风险重排序，policy 是纯函数）；NoPersist 事件 sequence 填 `None`（前端本不消费）。附注：events 表序号将出现语义性空洞（现状已存在，因 NoPersist 也占号），消费方（`seed_sequences` 用 `MAX(sequence)+1` 预热）不受影响。
- **回归风险**：`Q25`（失败复用序列号不留空洞）逻辑需复核——失败重试路径依赖 reserve 已发生；测试 `events.rs:446-517` 有锚点。

---

#### R4.【高 / P1】收口持久化串行同步等待：逐条 await DB 写，全局锁贯穿

- **位置**：`crates/orchestrator/src/events.rs:444-485`（drive_outcome）；`conex-db/src/events.rs:13-34`（append_event）
- **现象**：收口批次逐条 `queue.push(&session_id, event).await`——每条 = serde 序列化② + INSERT 同步等待；中途失败即中断整批（Q25 语义）。
- **代码现场**：

```rust
// events.rs:444-485（节选）
for event in outcome.events {
    match queue.push(&run.session_id, event).await {    // ← 逐条同步 await
        Ok(sequenced) => {
            run.cursor = sequenced.sequence;
            pushed.push(sequenced);
        }
        Err(err) => { /* 失败即中断整个批次 */ }
    }
}
```

- **影响量化**：500 事件 run 收口 = 500×（3 SQL 取号 + 1 INSERT）≈ 2000 条 SQL 串行过同一把 `Arc<Mutex<Connection>>`；期间 run-terminal 快照保存与其他 DB 命令（list_sessions / load_session_body / I1 的持久化批次）全部排队。审批中间态事件也在 run 进行中走此同步路径（`events.rs:109-114`）。
- **修复方案**：① 整批单事务：一次 `BEGIN...COMMIT` 包裹全部 INSERT（取号可批量化为一条 UPDATE ... RETURNING 区间），事务数从 500 降到 1；② 失败语义保持：事务失败 = 整批复用首个失败序列号（Q25 兼容，需复核其「不留空洞」判定改为「批首序号」）。
- **回归风险**：Q25 测试锚点（`events.rs:446-517`）、崩溃恢复（快照 + 审计事件 + 游标调和）语义不变性——事务化后「部分落库」窗口消失，恢复逻辑更简单但需回归验证。

---

#### R5.【高 / P1】旁路（push / WS 扇出）每条 emit 全量 JSON 反解析

- **位置**：`apps/agent-workbench/src-tauri/src/push/pusher.rs:375-382, 349-366`（PushAwareEmitter）；`src-tauri/src/server/fanout.rs:281-293, 245-256`（FanOutEmitter）
- **现象**：旁路只需要 `type/sessionId/sequence` 三个元字段，却对整包 payload 做 1–2 次完整反解析；fanout 还多做一次 `serde_json::Value` 深拷贝（`from_value(value.clone())`）。
- **代码现场**：

```rust
// fanout.rs:281-293 —— 提取 3 个字段 = Value 全量 parse + Value 深拷贝 + AgentEvent parse
fn parse_event_meta(payload: &str) -> Result<EventMeta, serde_json::Error> {
    let value: serde_json::Value = serde_json::from_str(payload)?;
    let event: AgentEvent = serde_json::from_value(value.clone())?;   // ← 整树深拷贝
    Ok(EventMeta {
        event_type: event.type_name().to_string(),
        session_id: value.get("sessionId")...,
        sequence: value.get("sequence")...,
        level: event_backpressure(&event),
    })
}
```

- **影响量化**：对 500B delta 是 µs 级浪费；对 200KB tool-end / 数百 KB message-end 是毫秒级 ×2（双发后 ×2，R2 叠乘）。**仅在装配 push/WS 时发生**（fanout 槽 None 时零开销，`core_event_bridge.rs:228-233`）——web 端启用 WS 后成为热路径。
- **修复方案**：信封顶层已是扁平 JSON（`{type, runId, sequence, sessionId, ...}`，`core_event_bridge.rs:6-17`）——元字段提取改为前缀扫描或 `serde_json::from_slice` 部分解析（如先小缓冲找 `"type"` 键）；或序列化时同步产出轻量 meta 结构（emit 侧一次构造，旁路零解析）。
- **回归风险**：低（元字段语义不变）；`fail-closed` 行为（解析失败跳过下发）保持。

---

#### R6.【中】大 payload 事件层无截断：`output_budget_bytes` 默认 None

- **位置**：`crates/session-loop/src/tool_events.rs:315-319`（配置默认 None）、`:44-46`（ToolEnd 契约注释）、`loop/handlers/executing_tools.rs:380-391`（全量透传）
- **现象**：shell 工具有工具级 200KB 上限（`agent-tools/src/tools/mod.rs:157`），但**事件层**的 `output_budget_bytes` 默认 None——其余工具（文件读取/浏览器快照等）输出原文大小直达 tool-end 事件 + events 表 + 双发 ×2。
- **影响量化**：单事件最高 ~200KB（shell）/未定义上限（其他）；叠加 R2 双发与 C2 深克隆，一次大工具输出 ≈ wire 上 400KB+ + Rust 侧 3 次全量拷贝。tool-batch-end 已摘要化（P11），残余风险在 tool-end 本体。
- **修复方案**：`output_budget_bytes` 给出默认值（如 64KB，超限截断 + `truncated: true` 标记——tool 角色消息已有同款语义）；前端卡片展示层本就 max-height 裁剪（02 报告 M11），截断无功能损失。
- **回归风险**：依赖全文输出的消费点排查（diff 识别 `parseUnifiedDiffs`、文件预览）——截断后需 `truncated` 标记透传前端。

---

#### R7.【中】实时轨伪缓冲：emit 后立即 flush，白付缓冲层全套开销

- **位置**：`engine_channels.rs:714-728`（push_live = emit + 立即 flush）；`engine_channels/src/buffer.rs:79-132, 194-200`（水位判定 Soft 64 / Critical 256）
- **现象**：实时路径「先入缓冲再立即出队全发」——水位丢帧仅在多线程并发 emit/flush 窗口内可能触发；缓冲层对实时轨只贡献开销（2 次锁 + 拷贝）不贡献背压。缓冲真正生效场景只有收口批次与 timer/cron drain。
- **影响量化**：每 delta 多付 2 次 Mutex + 1 次 Vec 移动（亚 µs 级）；在 R1 合并落地后事件数下降，此项成本同步缩小。序列化时机本身最优（入队时即序列化，`buffer.rs:1-5` 注释 AA-06 P9）。
- **修复方案**：与 R1 合并方案一体——push_live 改为「入队 + 条件 flush（时间窗到期或 Critical 水位）」，缓冲层从伪缓冲变为真节流点，一举两得。
- **回归风险**：EventBuffer 丢帧压测已有（P1），补时间窗 flush 的及时性测试（末尾 delta 延迟 ≤ 窗口 + flush 周期）。

---

#### R8.【中】webview 侧无可见性/订阅感知：窗口隐藏时仍全量推送 delta

- **位置**：`core_event_bridge.rs:84-95`（发射失败仅 warn，无订阅者检测）；对照 P9（push/WS 侧策略完备）
- **现象**：webview 通道「尽力而为」，无 UI 空闲降频、无最小化窗口降频、无合并。前端虽有 `visibilityState==='hidden'` 跳过**轮询**（P8），但事件推送不受控——最小化时 delta 照常穿透 IPC + 前端 parse + batcher + store。
- **影响量化**：后台挂机 run 期间 CPU 持续消耗（Rust emit + IPC + 前端全链）；与 R1 合并叠加后可基本消除（合并窗口在 Rust 侧，前端隐藏时也可暂停 flush——需前端恢复信号）。
- **修复方案**：最小化档：Tauri 窗口焦点/最小化事件 → 桥层降频（flush 周期放大到 200ms）；完整档：前端可见性信号回传（invoke 注册），隐藏时 delta 走 EventBuffer 缓冲、可见时 flush——**依赖 R7 的真缓冲化**。
- **回归风险**：恢复可见时的文本完整性（缓冲未丢帧，P1 压测覆盖）。

---

#### R9.【低】emit 热路径锁盘点与序列化次数

- **位置**：锁——`engine_channels.rs:634/661-666`（每 emit ×2）、`core_event_bridge.rs:104-117`（×1）、装配后 fanout/push 各 ×1；序列化——持久化事件全生命周期 3 次（实时 emit① / 落库② / 收口 emit③）
- **说明**：每事件 2–5 把无争用锁（合计亚 µs 级）+ 3 次全量序列化（大 payload 时毫秒级）。②③可共享同一 payload 字符串（落库时序列化结果缓存，收口 emit 复用——需 R2 方案先落地才有意义）。慢序列化告警阈值 10ms（`engine_channels.rs:532-553`）是现成的自观测点。P3 级，随 R1/R2 收益顺带消化。

---

### 4.2 invoke 命令域（I）

---

#### I1.【高】save_session_body：无脏会话检测的全量重发 + 先删后插全量重写 + batch_version 静默丢弃

- **位置**：
  - 前端 debounce：`apps/crish-desktop/src/store/layout-helpers/store-persistence.ts:139-166`
  - 前端批处理：`src/api/session-persistence/sessionRustDbHydrate.ts:273-293`
  - Rust 接收：`apps/agent-workbench/src-tauri/src/session_commands.rs:140-153`
  - DB 写入：`crates/conex-db/src/messages.rs:52-104`
- **现象**：三方合谋的写入放大——前端 350ms debounce 后对**所有会话**（含未变更）全量发 body+agents；Rust 侧 spawn_blocking 内 `DELETE` 全表片段再逐条 `INSERT`（14 列/条，含 5 个大字符串字段）；且前端传的 `batchVersion` CAS 参数**不在 Rust 签名中，被静默丢弃**。
- **代码现场**：

```ts
// sessionRustDbHydrate.ts:273-293 —— 未变更会话也全量重发
for (const s of list) {
  if (!s?.id) continue;
  keepIds.add(s.id);
  const msgs = (s.messages || []).map((m) =>
    m.sender === 'assistant' ? normalizeAssistantTimeline(m) : m);   // ← 每次全量 normalize
  if (shouldSaveBody) {
    bodyJobs.push(saveSessionBody(s.id, msgs, batchVersion));        // ← batchVersion 传了
  }
  bodyJobs.push(saveSessionAgents(s.id, s.agents || []));
}
```

```rust
// session_commands.rs:140-153 —— 签名没有 batch_version
#[tauri::command]
pub async fn save_session_body(
    session_id: String,
    messages: Vec<SessionMessage>,     // ← 每条消息 5 个大 String 字段全量反序列化
    db_state: State<'_, SharedDb>,
) -> Result<(), CoreError> { ... }

// messages.rs:52-104 —— 先删后插，全局锁贯穿事务
tx.execute("DELETE FROM session_messages WHERE session_id = ?1", ...)?;
for (seq, msg) in messages.iter().enumerate() {
    tx.execute("INSERT INTO session_messages (...14列...) VALUES (?1..?14)", ...)?;   // ← 逐条
}
```

- **调用链与触发时机**：工具终态 commit / snapshot → sessions 引用变 → 350ms debounce → 全会话批次。工具密集 run 中每 350ms 一轮。
- **影响量化**：千条消息会话单轮 = 数 MB JSON 序列化 → IPC → serde 反序列化（每条 5 个大 String alloc）→ 千次 INSERT 过全局锁；期间所有 DB 命令排队。多会话线性放大。**这是 01 报告 M9 的 Rust 侧闭环**——两边都要修才有效。
- **修复方案**：三层递进：
  1. **前端**：dirty 会话集合（01 报告 M9 方案：immer 下 `sessionsById[key]` 引用比较），批次只发 dirty 会话；
  2. **Rust**：`save_session_body` 增加增量模式——按 `message` 数量/末条 id 比对后仅追加新消息（`INSERT OR REPLACE` 按 id），保留全量模式作兜底；`batch_version` 参数接上（CAS 校验 `updated_at`，前端注释 `sessionRustDbSql.ts:117` 本就预留了此语义）；
  3. **DB**：DELETE+INSERT 改为单事务 UPSERT（新消息 append + 已有消息按 id 幂等）。
- **回归风险**：CAS 版本语义（前端 `writtenBodyVersion`）、`isHydrateTruncated`/`isLazySessionShell` 的 shouldSaveBody 门控保留；崩溃恢复测试。

---

#### I2.【中高】boot 水合：对全部历史会话并行 2×N 次 IPC，消息历史全量进内存

- **位置**：`apps/crish-desktop/src/api/session-persistence/sessionRustDbHydrate.ts:134-141`
- **代码现场**：

```ts
// 并行加载每个会话的 body 与 agents
const sessions: SessionState[] = await Promise.all(
  ordered.map(async (e) => {
    const [messages, agents] = await Promise.all([
      loadSessionBody(e.id),          // ← 单会话全量消息
      loadSessionAgents(e.id),
    ]);
```

- **影响量化**：50 个历史会话 = 100 次并发 IPC + SQLite 全表读 + `sanitizeMessagesForHydrate`/`normalizeAssistantTimeline` 全量处理；首屏内存与 IPC 双高峰（属于 07 启动链路方向的主体问题，此处记录 IPC 侧证据）。
- **修复方案**：懒加载——boot 只拉活跃会话 body，其余会话惰性（切换时拉取；`isLazySessionShell` 门控已存在，说明骨架已备）。归方向 07 深查。
- **回归风险**：切换会话的加载态 UX（骨架屏）；`isHydrateTruncated` 熔断语义。

---

#### I3.【中高】fs 三命令同步 `fn`：同步文件 IO 跑在 Tauri 命令线程

- **位置**：`apps/agent-workbench/src-tauri/src/fs_commands/mod.rs:29-63`（`list_directory`/`read_file_content`/`write_file_content` 均非 async）
- **现象**：内部 `std::fs::read_dir` + 每条目 `symlink_metadata`（`directory.rs:29-58`）、分块读（`read.rs:45-104`）、整文件写——Tauri 2 非 async 命令在专用命令线程同步执行，有上限保护但大目录/接近上限文件时占住 IPC 派发路径。与同文件 `select_folder`（async + spawn_blocking）及项目「F2-27」纪律不一致，是 **65+ 处 spawn_blocking 覆盖面中唯一缺口**。
- **修复方案**：改 async + `spawn_blocking`（模式照抄 `session_commands.rs`），三处机械改动。
- **回归风险**：低（语义不变）；错误分类保持 `FileCommandError`。

---

#### I4.【中】core_get_run_snapshot：全表扫描 runs 后内存 find

- **位置**：`apps/agent-workbench/src-tauri/src/core_query_commands.rs:809-846`；`crates/orchestrator/src/persist.rs:1002-1005`
- **代码现场**：

```rust
let runs = store.query_runs().await.map_err(map_store_err)?;   // ← 全表读出
let run = runs.into_iter().find(|run| run.run_id == run_id)    // ← 内存 find
    .ok_or_else(|| CoreError::NotFound(...))?;
```

- **影响量化**：调用频率低（run 收口后一次，`streamCallbacksUsage.ts:36-38`），但随 runs 表线性恶化且占全局 DB 锁。
- **修复方案**：`query_run(run_id)` 单条查询下推 SQL（WHERE run_id = ?）；顺手处理 `parse_envelopes` 的 `value.clone()` 深拷贝（`core_query_commands.rs:583-625`）。
- **回归风险**：低。

---

#### I5.【中】轮询命令的双源与空转（与 V2 合并陈述）

- **位置**：`useEngineState.ts:204-239`（4s 双命令）+ `useBackgroundTaskPolling.ts:54-70`（3s 同命令，无 hidden 检查）；空转：`useAgentStream.ts:362`、`useAgentCardStatusPoll.ts:57`（`getSubagentStatus` 恒 null 零 IPC）；`FlowDagView.tsx:133-148`（3s，invokeTyped 直调**无超时**——卡顿时 invoke 堆积）
- **影响量化**：稳态每分钟 IPC：core_get_status ~15、list_background_tasks ~35（双源重复）、get_flow_snapshot 20/视图、设备页 40。绝对量低（进程内 IPC），浪费在语义而非吞吐；详见 V2。
- **修复方案**：V2 统一处理；空转定时器删除（死代码）；get_flow_snapshot 补超时。

---

#### I6.【低】其余命令面小项

- `render_markdown` 缓存键整段拷贝（`conex-markdown/src/renderer.rs:687-703`：命中路径也 `text.to_string()` + `(*cached).clone()` 两次全量拷贝；改 `Arc<str>` key / 返回 `Arc<str>`）；`render_markdown_batch` 串行无并行（阻塞线程池上执行，不卡 UI，可接受）。
- `config` 族低频全量读写 JSON 文件（tmp+rename 原子写），无热点。
- boot 期 250ms 就绪探测就绪即停（一次性成本）。

---

### 4.3 前端传输域（V）

---

#### V1.【高】数据面事件被完整解析两次；resolveEventType 每事件跑 3 次

- **位置**：
  - fanout：`src/api/transport/tauriTransport.ts:498-507`
  - 数据面路由：`src/api/chat-bridge/dataPlaneRouter.ts:121-148, 59-70`（10 类数据面事件清单）
  - per-run 路由：`src/api/chat-bridge/EventRouter.ts:217-248`（解析后丢弃）、`:150-152`（`isDataPlaneEventType` 过滤在解析之后）
  - 类型解析：`handlers/eventParser.ts:62-70`（resolveEventType）
- **现象**：同一 parsed 事件对象发给 4 个订阅者；数据面事件（task-* ×7、timer-* ×2、cron-fired）由 dataPlaneRouter 完整 `parseBridgeEvent` 消费后，per-run EventRouter **再次完整解析**（`messageBelongsToRun` 对无 runId 事件放行）然后 `handleAgentEvent` 里才丢弃。`resolveEventType`（String 提取 + 对象分配）每事件 3 次。
- **代码现场**：

```ts
// EventRouter.ts:217-248 —— 先解析后丢弃
onMsg = (msg: Record<string, unknown>): void => {
  const envelope = resolveEventType(msg);          // ← 每事件第 1 次（对 EventRouter 而言）
  if (!messageBelongsToRun(raw.runId, this.runId)) return;
  let parsed = parseBridgeEvent(raw);              // ← 数据面事件在这里完整解析
  ...
};
handleAgentEvent(envelope: BridgeEventEnvelope): void {
  if (isDataPlaneEventType(envelope.type)) return; // ← :152 到这里才丢弃
```

- **影响量化**：run 活跃 + 后台任务输出密集时（task-output 是高频 Delta 流），事件解析 CPU ×2；每事件处理链 ≈12–16 个调用层，重复热点集中在 `resolveEventType ×3 + parseBridgeEvent ×2`。generated parser 对大 text 近零成本（P5），重复解析的实际成本是「对象重建 + 深度校验遍历 ×2」——中低但纯浪费。
- **修复方案**：`isDataPlaneEventType(envelope.type)` 判定前移到 `parseBridgeEvent` 之前（EventRouter.onMsg 内 resolveEventType 后立即短路）——一行移动，解析直接减半；`resolveEventType` 结果随 parsed 对象复用（fanout 处解析一次，向订阅者传递 `{type, raw}` 已有结构）。
- **回归风险**：低（过滤语义不变）；`dataPlaneRouter` 测试锁定其消费路径。

---

#### V2.【中高】workbench_list_background_tasks 双轮询 + 三通道语义不一

- **位置**：双轮询——`useEngineState.ts:271`（4s，含 hidden 跳过）vs `useBackgroundTaskPolling.ts:70`（3s，无 hidden 检查）；三通道——`transport.request`（清单校验+重试+超时）/ `invokeTyped` 直调（三者全无，≈123 调用点）/ `daemonClient` 裸 invoke（连三态都没有，4 调用点）
- **影响量化**：同一命令 ~35 次/分钟（双源）；数据一致性问题：链 A 进 engineStore.bgTasks，链 B 结果独立消费——两份数据源并存。高频轮询（FlowDagView、backgroundTaskClient）恰好走在**无超时无重试**的直调通道上。
- **修复方案**：① 链 B 改订阅 engineStore.bgTasks（链 A 已拉取）或删除；② 通道收敛为「transport.request 唯一入口」（直调通道保留但补超时默认值）；③ `SettingsDevicesTab` 的 `load` 依赖稳定性复核（`loadRef.current` 每渲染重赋值，若 effect 依赖 `[load]` 不稳定则 3s interval 反复重建——待渲染轮确认）。
- **回归风险**：低；后台任务 chip 的数据新鲜度（订阅 store 后由链 A 周期保证）。

---

#### V3.【中】超时后底层 invoke 悬挂不取消；无分类 0 退避重试

- **位置**：`src/api/transport/tauriTransport.ts:445-467`（callWithTimeout：定时器清理正确，但底层 call 继续）；`:138-145, 199-200`（`isTransientInvokeResult` 把所有 error 一律重试）；`tauriInvoke.ts:73-104`（kind 分类信息已提取但未被消费）
- **影响量化**：正常路径零成本；引擎无响应窗口内，4s 轮询 + 8s 超时 + 1 次自动重试 = 每 4s 新增 2 个悬挂 invoke，Rust 侧排队加深（与 R4 的 DB 锁排队叠加放大）。
- **修复方案**：① kind 分类接入重试判定（`InvalidInput`/`NotFound` 不重试）；② 轮询 tick 加 in-flight 互斥（上一 tick 未返回则跳过）；③ 重试加微退避（50ms）。
- **回归风险**：低；超时语义（超时即整体拒绝）注释已文档化，保持。

---

#### V4.【中】会话水合：最多 50 页 × 800 事件串行拉取、全量驻留、不可取消

- **位置**：`src/api/sessionEventHydrate.ts:87-149`（`MAX_HYDRATE_PAGES=50`、`HYDRATE_PAGE_SIZE=800`、串行 for 循环、`allEvents.push(...res.events)` 全量堆入）
- **影响量化**：超长会话（40k 事件）打开 = 50 次串行 RTT + 40k 事件对象同时驻留 + 单遍投影；用户切走会话后循环继续跑完（无 abort）。有游标停滞检测与截断熔断（P 级防御）。
- **修复方案**：① 可取消（AbortSignal 贯穿 fetchSessionEvents）；② 增量投影（每页投影后丢弃原始事件，只保留消息投影——投影是单遍的，改流式即可）；③ 并发预取下一页（RTT 减半）。
- **回归风险**：截断标记与 persist 熔断语义；游标停滞检测保留。

---

#### V5.【信息】readiness 监听器永不退订 + SettingsDevicesTab 依赖待确认

- `readiness.ts:56-78`：模块级一次性订阅（监听体 2 次字符串比较，常驻是设计意图，建议注释注明）。
- `SettingsDevicesTab.tsx:143, 167-177`：effect 依赖 `[load]` 而 `load` 经 `loadRef.current` 每渲染重赋值——useCallback 稳定性待渲染轮（方向 02 批次 C）复核。

---

### 4.4 契约域（C）

---

#### C1.【高】message-start 携带全文，前端 live/replay 双路径均零消费

- **位置**：
  - Rust 成对发射：`crates/session-loop/src/loop/handlers/mod.rs:239-273`（record_message）、`streaming.rs:665-683`（commit_message_with_deltas）
  - 前端空实现：`apps/crish-desktop/src/api/chat-bridge/handlers/messageHandlers.ts:72-77`
  - replay 只消费 end：`src/api/sessionEventProjection.ts:241-244`
  - 契约自证：`engine-events.json:141`「水合投影以 message-end 为准」
- **代码现场**：

```rust
// mod.rs:239-273 —— 每条消息 start+end 成对，均携带 Arc<AgentMessage> 全文
state.emit_event(AgentEvent::MessageStart { session_id, message: message.clone() });
state.conversation.push(message.clone());
state.emit_event(AgentEvent::MessageEnd { session_id, message, turn_index: ... });
```

```ts
// messageHandlers.ts:72-77 —— 前端显式空实现
export function onMessageStart(_env: HandlerEnv, _envelope: EngineEnvelope<'message-start'>): void {
  // message-start 无 UI 语义：显式空实现，保证分派表全键覆盖
}
```

- **影响量化**：每条消息的 `AgentMessage` 全文在 wire 上传两遍、落库两遍（registry 中 start/end 均 `persist:true`）、前端严格解析两遍（`parseAgentMessage` 全量递归）。50KB 正文消息 ≈ 多付 ~50KB IPC + 一次 blocks 树校验 + 一份落库 JSON；**与 R2 双发叠乘后实际是 4 遍全文**（start 实时 + start 收口 + end 实时 + end 收口）。
- **修复方案**：message-start 载荷降为摘要 `{sessionId, messageId, role, turnIndex}`（消费方零改动——本就没人读全文）；契约升 schemaVersion，`registry_drift` + 生成 parser 同步；replay 投影不变（只读 end）。
- **回归风险**：低（消费面为空已由 `handlerBehavior.test.ts` 锚定）；`registry_drift` 与 golden 测试同步。

---

#### C2.【中】emit_event 深克隆：ToolEnd 大 output 未 Arc 化，Rust 侧即付全量拷贝

- **位置**：`crates/session-loop/src/loop/handlers/mod.rs:173-179`（`events.push(event.clone())`）；`executing_tools.rs:383-407`（ToolEnd 构造：`output` 为 `serde_json::Value` + `executed_input.clone()`）
- **现象**：持久化轨收 event.clone()——MessageStart/End 已 Arc 化免疫（P2），但 **ToolEnd.output（Value 深拷贝，可达 200KB）、ToolStart.input、ApprovalRequested.parameters、RuntimeSteering.message（AgentMessage 值，未 Arc）** 全按值深克隆。
- **影响量化**：200KB output 每次发射多付 ~200KB 分配+memcpy；与 R6（无截断）、R2（双发）叠乘。
- **修复方案**：`ToolBatchResult.output` 的 text 字段 `Arc<str>`（或 events 持久化轨改存 `Arc<AgentEvent>`——后者一劳永逸但波及面大，前者改动局部）。
- **回归风险**：serde 序列化输出不变（Arc<str> 序列化透明）；`run_loop.rs:1246-1262` 不变量测试扩展覆盖 ToolEnd。

---

#### C3.【中低】tool-batch-start/end 摘要化后的残余成本：落库 + IPC + 严格解析后丢弃

- **位置**：前端空实现 `toolHandlers.ts:42-54`；Rust 摘要化 `executing_tools.rs:240-266, 409-418`（EV-09）；前端仍完整解析 `parser.ts:1122-1140`；测试锚定 `handlerBehavior.test.ts:143`「携带 calls 也不消费」
- **影响量化**：EV-09 后每批 ≈1.2–1.5KB（摘要级，P11 已确认非全量）；残余 = 落库 1 份 + IPC 1 份 + strict parser 一遍，**全部产物被丢弃**。批次高频（多工具 run 每轮 1–2 批）下是小但纯的浪费。
- **修复方案**：两事件降为 NoPersist（registry `persist:false`）或从实时桥剔除只留落库审计；前端 `parseBridgeEvent` 前按类型短路跳过 strict 校验（与 V1 同一机制）。
- **回归风险**：落库语义变化需过 `registry_drift` + 水合投影确认（replay 本就不消费，安全）。

---

#### C4.【中】onMessageEnd 多轮聚合平方级重拼 + 4 套文本账本并存

- **位置**：`apps/crish-desktop/src/api/chat-bridge/handlers/messageHandlers.ts:141-229`（`turnAuthoritativeTexts`/`turnStreamedTexts`/`turnAuthoritativeThoughts`/`messageEndTurnSegments` 四账本 + 每次 end 全量重拼 `assistantText`）
- **现象**：每条 message-end 重建 `Set→Array→sort→join('\n\n')` 重写 `state.assistantText` 全量——N 轮 run 总成本 O(N × 累计正文)；50 轮 × 5KB ≈ 最多 6MB 级累计字符串搬运。**澄清**：live 路径不涉及 `blocks_json`/`tool_calls_json` 字符串解析（该成本只在重载/持久化路径，`historyMessages.ts:11-16`）——审查假设「end 全文触发 JSON.parse」不成立，实际成本在聚合重拼。
- **修复方案**：`assistantText` 改按轮 lazy 拼接（渲染层 join）或增量 append 新轮段（投影已按 turnIndex 排序）。
- **回归风险**：多轮正文拼接的展示正确性（`\n\n` 分隔语义）；`turnStreamedTexts` 与权威态的覆盖时序。

---

#### C5.【低】生成 parser 与 Rust enum 字段漂移：tool-end 的 attempt/deduplicated/executed_input 未解析

- **位置**：`parser.ts:1079-1097`（三字段未消费）；Rust `events.rs:479-491`（三字段存在）；`engine-events.json:268-297`（fields 未登记）
- **说明**：registry↔enum 由 `registry_drift` 锁定，但 registry fields 清单↔enum 变体字段**不完全一致**（漂移未被锁定）。前端拿不到 attempt 链/去重标记/实际执行入参（消费缺口）；意外省了 `executed_input` 的 `checkJsonValue` 递归。补齐时注意 executed_input 是大 payload（C2/R6 关联）。

#### C6.【信息】信封固定开销与注释漂移

- 信封 `runId(~50B)+sequence(~15B)+schemaVersion(~19B)` ≈ 80–90B，带 traceId ~135B；事件体 `sessionId` 另加 ~55–65B——合计 135–195B/事件，对几十字节的 message-delta **占比可超 50%**（量级可接受但值得知晓；R1 合并后占比自然下降）。
- Rust 内部消费信封时反序列化有一次 `Value.clone()` 深拷贝（`events.rs:1518-1551`，仅 Rust 读取面，前端不受影响）。
- 注释称 58 个事件、实体 57（`events.rs:386`、`engine-events.json:5` 注释文本漂移，订正即可）。
- dispatch 表 41 键全覆盖，≥9 个显式空实现（与 V1/C3 的短路机制联动后成本归零）。

## 5. 量化分析（核心问答）

### Q1. 一个典型 run 的 IPC 总账（现状 vs 修复后）

以「5 轮工具 run、单轮 assistant 正文 10KB、每轮 3 个工具、token 流 5000 delta」为例：

| 项 | 现状 | 批次 K+L 落地后 |
| -- | ---- | -------------- |
| delta 事件数（wire） | ~5000 | ~600（16ms 窗合并，R1） |
| 非增量事件跨 IPC 次数 | ~2×(5×8)=80 | ~40（收口改回执，R2） |
| message 全文传输遍数 | 4（start/end × 实时/收口） | 2（end × 2，C1+R2） |
| NoPersist 白付取号 | ~5000 × 3 SQL | 0（R3） |
| 持久化 SQL 语句总数 | ~2000+15000 | ~2000（事务化后 500 事务→约 10，R4） |
| 事件序列化总次数 | 3×持久化事件数 | ≈1.2×（payload 复用，R9） |
| 大 output 深拷贝 | 15 × 200KB | 0（Arc 化，C2） |

### Q2. 稳态轮询账单（无 run 时每分钟）

`core_get_status` ~15 次 + `workbench_list_background_tasks` ~35 次（双源，V2）+ `get_flow_snapshot` 20 次/视图 + 设备页 40 次（设置页打开时）。单次均为 KB 级——**绝对吞吐无压力，问题在语义冗余**（双源数据不一致风险 + 无超时通道的堆积风险）。V2 落地后减半。

### Q3. 一个 200KB tool-end 输出的完整旅程（现状）

Rust：工具执行产出 → `tool_output_from_parts` 构造 → `emit_event` 深克隆①（C2）→ serde 序列化① → 实时 IPC → 收口 `events.push` 时已克隆的在轨 → 落库序列化② → 收口 emit 序列化③ → 第二次 IPC（R2）→ 前端 JSON.parse（ms 级）→ strict parser 近零（P5）→ 卡片消费。**wire 上 400KB+，Rust 全量拷贝 3 次，序列化 3 次**。R6 截断 + C2 Arc 化 + R2 免双发后：wire 200KB→64KB（截断），拷贝 0，序列化 1。

### Q4. 大 payload 事件 wire 成本 TOP 排名（修复前 → 修复后）

| 排名 | 事件 | 大 payload 字段 | 现状单次 wire 成本 | 批次 K/L/O 落地后 |
| ---- | ---- | -------------- | ------------------ | ------------------ |
| 1 | tool-end | `result.output` + `executed_input` | 原文大小（≤200KB）× wire 2 遍（双发）× 拷贝 3 次 | 截断 64KB × 1 遍 × 0 拷贝（R6+R2+C2） |
| 2 | message-start + message-end | `message` 全文 ×2 事件 | 全文 ×4 遍（双事件 × 双发） | end 全文 ×2 遍（C1 摘要化 + R2 免双发） |
| 3 | tool-start | `call.input` 全量入参 | KB–数十 KB × 2 遍 | ×1 遍（R2） |
| 4 | approval-requested | `request.parameters` | KB–数十 KB × 2 遍（低频） | ×1 遍 |
| 5 | runtime-steering | `message` 全文（未 Arc 化） | 同消息量级，低频 | Arc 化随 C2 |
| 6 | tool-batch-start/end | `calls[]` 摘要数组 | ~1.2–1.5KB/批 10 条，纯浪费 | 降 NoPersist / 桥剔除（C3） |
| 7 | task-output（高频流） | 每条 ~KB | ×2 解析（V1） | ×1 解析 |

### Q5. 修复优先级矩阵（收益 / 风险 / 契约耦合）

| 批次 | 收益 | 契约耦合 | 建议顺序 |
| ---- | ---- | -------- | -------- |
| N 前端传输收敛（V1+V2+V3） | 中 | 无 | **1**（最低风险先做） |
| K Rust 局部减负（R3+R4+R7+C2） | 高 | 无 | **2** |
| M 命令面治理（I1+I3+I4） | 高（I1 与 01-M9 联动） | 无（I1 加参数是向后兼容） | **3** |
| L 双发与冗余事件（R2+C1+C3） | 高 | **有**（schemaVersion 升级） | 4（需契约评审） |
| O 节流与背压（R1+R8） | 最高 | **有**（放宽 PE-02 合并禁令） | 5（设计评审 + 压测） |

## 6. 修复路线图（按批次）

### 批次 N：前端传输收敛（V1 + V2 + V3 + V4）

- 文件：`EventRouter.ts`、`dataPlaneRouter.ts`、`tauriTransport.ts`、`useBackgroundTaskPolling.ts`、`sessionEventHydrate.ts`。
- 验收标准：① 事件解析计数断言（数据面事件 parseBridgeEvent 恰 1 次）；② list_background_tasks 单源（IPC 计数减半）；③ 引擎卡死模拟（延迟 handler）下无悬挂 invoke 堆积；④ 水合可取消（切会话后 0 新增 IPC）。

### 批次 K：Rust 局部减负（R3 + R4 + R7 + C2）

- 文件：`orchestrator/src/events.rs`、`conex-db/src/events.rs`、`engine_channels.rs`、`session-loop/handlers/mod.rs`、`executing_tools.rs`。
- 验收标准：① NoPersist 事件 0 次 reserve（SQL 计数断言）；② 500 事件收口 = 1 事务（trace 断言）；③ 实时轨走真缓冲（水位/时间窗测试）；④ ToolEnd 0 深克隆（不变量测试扩展）。**Q25 与崩溃恢复语义回归全绿为硬门禁。**

### 批次 M：命令面治理（I1 + I2 + I3 + I4）

- 文件：`store-persistence.ts`、`sessionRustDbHydrate.ts`、`session_commands.rs`、`conex-db/src/messages.rs`、`fs_commands/mod.rs`、`core_query_commands.rs`。
- 验收标准：① 工具密集 run 10s 内 save_session_body IPC 只含 dirty 会话；② batch_version CAS 生效（过期写入被拒测试）；③ fs 命令 async 化后错误分类不变；④ run_snapshot 单条查询（EXPLAIN 断言）。

### 批次 L：双发与冗余事件治理（R2 + C1 + C3）——需契约评审

- 契约变更：新增轻量 sequence 回执事件（或信封 `sequenceOnly`）；message-start 载荷降摘要；tool-batch 双事件降 NoPersist。
- 同步面：`engine-events.json` + `events.rs` + 生成 parser + `registry_drift` + golden 测试 + WS/push 旁路转发路径确认。
- 验收标准：① run 全周期 wire 抓包对比（体积下降 ≥40%）；② 前端全部 handler 回归；③ schemaVersion 升级后旧前端容忍（fail-open 测试已有）。

### 批次 O：节流与背压（R1 + R8）——需设计评审 + 压测

- 契约变更：放宽 PE-02 增量性禁令为「允许同 block 追加合并」；R7 真缓冲 + 可见性信号。
- 验收标准：① 合并正确性（合并前后前端累计文本逐字节等价）；② `buffer.rs` 20 万条压测全绿 + 末尾 delta 延迟 ≤ 窗口上限；③ 最小化窗口 CPU 对比（下降 ≥80%）。

## 7. 运行时验证计划（静态结论 → 实测确认）

| # | 场景 | 测量方式 | 验证结论 | 判定阈值 |
| -- | ---- | -------- | -------- | -------- |
| V1 | 5 轮工具 run（各轮 10KB 正文 + 3 工具） | tracing span 统计 emit 次数 + wire 体积（临时埋点） | R1/R2/R3 量级确认 | 非增量事件双发比 = 2.0 即确认 |
| V2 | 500 事件 run 收口 | DB 层 SQL 计数 + 收口耗时 | R4 串行成本 | 收口 >100ms 即确认 |
| V3 | 工具密集 run 10s | save_session_body 调用日志（会话 id 集合 + payload 大小） | I1 写放大 | 含 ≥1 个未变更会话即确认 |
| V4 | run 活跃 + 后台任务输出 | 前端 Performance：parseEngineEvent 调用计数 | V1 双重解析 | task-* 事件解析 ×2 即确认 |
| V5 | 引擎人为延迟（debug 注入 10s sleep） | 前端 invoke 队列深度 | V3 悬挂 | 悬挂 invoke ≥2 个即确认 |
| V6 | 40k 事件会话打开 | 水合耗时 + 内存峰值 | V4 | 首帧 >2s 即确认 |
| V7 | WS/push 装配场景 | 旁路 parse 耗时占比 | R5 | 大 payload 事件 >1ms/条即确认 |
| V8 | 最小化窗口挂机 run | CPU 占用对比 | R8 | 与前台无差异即确认 |

## 8. 交叉引用

| 发现 | 归入方向 | 说明 |
| ---- | -------- | ---- |
| 01-M9（持久化全量序列化） | 本文 I1 | Rust 侧证据闭环，批次 M 联动修复 |
| 02-X2（PTY 零合批） | 同族问题 | PTY 通道合批方案与 R1 同构（后端 64KB/2ms 窗） |
| 01-M7（前端同步 parse） | 本文 V1 | 合并修复（fanout 短路 + worker 化） |
| I2（boot 全量水合） | 07 启动链路 | 懒水合属于启动链路主体 |
| R6 截断的展示层影响 | 02 批次 F | `truncated` 标记透传与卡片 UI |

## 附录 A：检查覆盖面记录（检查过且无问题的区域）

| 区域 | 结论 | 证据点 |
| ---- | ---- | ------ |
| EventBuffer 丢帧语义 | Soft/Critical 两级 + 20 万条压测锁定终态必达 | `buffer.rs:79-146, 349-456` |
| EmitReport 可观测 | dropped/emitted 全链计数 + 慢序列化 10ms 告警 | `core_event_bridge.rs:23-45`、`engine_channels.rs:532-553` |
| 锁中毒恢复 | 统一 POISON_RECOVERIES 样板，无 panic 传播 | `engine_channels.rs:40-46` |
| Fanout fail-closed | 元信息解析失败跳过下发不越界 | `fanout.rs:232-243` |
| timer/cron drain | 500ms tick、Vec::take 幂等、伪 runId 契约 | `engine_channels.rs:471-528` |
| push 决策引擎 | 合并桶 + 500ms flush，移动端真实合并 | `pusher.rs:335-346` |
| PTY 输出事件 | 8KB 读缓冲 + UTF8 跨块解码（合批问题在 02-X2 单列） | `pty/session.rs:458-557` |
| 前端 zod 排查 | 事件链零 zod；2292 行手写 parser；zod 仅 ConfigService | `parser.ts` 全文 grep |
| 事件链深拷贝 | parsed 引用透传；`JSON.parse(JSON.stringify`/`structuredClone` 生产命中仅 2 处且不在事件链 | `tauriTransport.ts:498-507` |
| listen 生命周期 | 全局单次 + 幂等守卫 + stop teardown；per-run 退订异常安全测试锁定 | `tauriTransport.ts:470-530`、`streamRunLifecycle.test.ts:60-111` |
| boot 握手 | 先挂监听后 probe；10→50ms 封顶退避；双清理 | `tauriTransport.ts:272-439` |
| 命令清单校验 | WeakMap 缓存 Set 查询 O(1) | `commandManifest.ts:272-291` |
| dedupe 防御 | 2000 条 FIFO；delta 无 sequence 直通 | `EventRouter.ts:49-50, 250-259`、`eventDedupe.ts:86-96` |
| useEngineState 稳定性 | 浅等 + 内容级比较 + refcount + hidden 跳过 | `useEngineState.ts` 全链 |
| core_read_session_events 分页 | limit 下推 SQL + 上限 1000 有界 | `core_query_commands.rs:40-45, 721-755` |
| markdown Rust 缓存 | 双缓存 32MB×2 + 5MB 截断 + spawn_blocking | `conex-markdown/src/cache.rs`、`markdown_commands.rs:22-40` |
| spawn_blocking 纪律 | 65+ 处全覆盖（fs 三命令除外，I3 单列） | `session_commands.rs` 等全链抽检 |
| config 族 | 低频、原子写、短临界区 | `config/provider.rs:501-554` |
| schemaVersion 兼容层 | 恒 1、无版本分派、前端忽略（golden 锁定） | `events.rs:1492-1542`、`EventRouter.test.ts:66-67` |
| Arc 化 message 载荷 | start/end 共享 0 深克隆，bench + 不变量测试锁定 | `events.rs:390-393`、`run_loop.rs:1195-1262` |
| EV-09 摘要化 | batch 事件 input=Null/output=empty | `executing_tools.rs:240-266` |
| 多 transport 形态 | Tauri IPC 单通道；directFetchBridge 仅降级门控 | `transport/index.ts:1-28` |
| getSubagentStatus | 幽灵 stub 恒 null 零 IPC（死定时器记录） | `subagentApi.ts:28-34` |

## 附录 B：与本报告相关的文件清单

**批次 N**：`apps/crish-desktop/src/api/chat-bridge/EventRouter.ts`、`dataPlaneRouter.ts`、`src/api/transport/tauriTransport.ts`、`src/components/chat-card/useBackgroundTaskPolling.ts`、`src/api/sessionEventHydrate.ts`
**批次 K**：`crates/orchestrator/src/events.rs`、`crates/conex-db/src/events.rs`、`apps/agent-workbench/src-tauri/src/engine_channels.rs`、`crates/session-loop/src/loop/handlers/mod.rs`、`loop/handlers/executing_tools.rs`
**批次 M**：`apps/crish-desktop/src/store/layout-helpers/store-persistence.ts`、`src/api/session-persistence/sessionRustDbHydrate.ts`、`apps/agent-workbench/src-tauri/src/session_commands.rs`、`crates/conex-db/src/messages.rs`、`src-tauri/src/fs_commands/mod.rs`、`src-tauri/src/core_query_commands.rs`
**批次 L（契约评审）**：`crates/conex-types/contracts/engine-events.json`、`crates/conex-types/src/events.rs`、`apps/agent-workbench/src-tauri/src/run/run_idle.rs`、`crates/session-loop/src/loop/handlers/{mod,streaming}.rs`、`packages/shared-types/src/generated/engine/parser.ts`
**批次 O（设计评审）**：`crates/session-loop/src/provider.rs`（契约）、`loop/handlers/streaming.rs`、`engine_channels.rs`、`push/pusher.rs`、`server/fanout.rs`
**测试锚点**：`command_manifest.rs:316-334`、`buffer.rs:349-456`、`run_loop.rs:1195-1262`、`events.rs:446-517`（Q25）、`streamRunLifecycle.test.ts:60-111`、`handlerBehavior.test.ts:143`、`registry_drift`、`EventRouter.test.ts:66-67`

---

*本报告为静态审查；§7 实测完成后回填 V 项结论。下一方向：04（Rust 引擎热路径）。*
