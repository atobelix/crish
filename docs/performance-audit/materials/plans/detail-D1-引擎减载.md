# detail-D1 · 引擎减载（NoPersist / 真缓冲 / 审计有界 / 工具输出 RS / moka 字节语义）

> **战役**：performance-fix  
> **创建**：2026-09-13  
> **依据**：`92-修复总方案.md` §4–§5/§6/§9/§10、`materials/plans/independent-01`（Layer-1 主轴）、`independent-02`（D5 执行侧边界）、`review-plans-01` CFL-03/04/06/15、主控亲读码  
> **地位**：D1 **唯一执行详案**。执行实现轮仅认 92 + 本文件。  
> **契约闸门**：本维全部任务标 **T0**（无契约变更）；禁止实现 PE-02 / 双发消除 / message-start 瘦身。

---

## 0. 本维效果锁（不缩水）

| ID | 锁定效果 | 来源 |
| -- | -------- | ---- |
| D1-E1 | NoPersist 事件 **0 次** `reserve` 取号 SQL（INV-2） | 92 §2 INV-2、CFL-03、F3 |
| D1-E2 | 实时轨 `push_live` 改为**条件 flush**（时间窗 / Critical 水位），与 PE-02 **解耦** | CFL-04、01 T-L4-C |
| D1-E3 | 审计落库通道有界；溢出可观测（丢弃计数），禁止无限涨 | 01 T-L1-C、OVL-10 |
| D1-E4 | 生产 `output_budget_bytes` 默认 Some（预算常量）；超限 `truncated` 透传；执行器出口 Arc | CFL-06 U-OUT-RS、02 D5 |
| D1-E5 | moka 渲染/高亮缓存 **字节容量语义**（`CACHE_BUDGET_BYTES` 进 builder），禁止仅改注释 | 92 §6 moka 修正、CFL-15、F5 |
| D1-E6 | 禁止：token N 合 1（PE-02）；本维不与 D3 同 PR；子 Agent 不 git commit | 用户派单 + 92 §5 反例 4 |

**一句话哲学**：先减载（少付 SQL / 少无界堆 / 少深 clone / 少 flush），再换轨（D3 组提交）——删除与条件化是完成形态，不是砍范围。

---

## 1. 主控已核实代码事实（决策锚点 · 2026-09-13）

| # | 事实 | 锚点 |
| - | ---- | ---- |
| A1 | `EventQueue::push` **先 `reserve` 后 `is_non_persistent`**——NoPersist 白付取号 | `crates/orchestrator/src/events.rs:246-263` |
| A2 | `SequencedEvent.sequence: u64`；`drive_outcome` 对每条 `push` 成功事件写 `run.cursor = sequenced.sequence` | `events.rs:54-60`、`events.rs:450-454` |
| A3 | `BridgeLiveSink::push_live`：`emit` 后**无条件** `flush()`（伪缓冲） | `apps/agent-workbench/src-tauri/src/engine_channels.rs:714-721` |
| A4 | 实时轨在流式消费热路径：`delta_sink.push` / `live_sink.push_live` 逐 delta 发射 | `crates/session-loop/src/loop/handlers/streaming.rs:155-172` |
| A5 | 审计落库：`mpsc::unbounded_channel` + `spawn_audit_persistence` 单 worker | `run_launch.rs:562-568`、`run_core.rs:168-216` |
| A6 | `ToolBatchOptions.output_budget_bytes` 默认 **None**；生产 `run_launch` 仅覆盖 approval/permission，经 `..Default::default()` 继承 None | `session-loop/src/tool_events.rs:316-343`、`run_launch.rs:752-759` |
| A7 | 执行器已在 `Some(budget)` 时 summarize 截断——缺的是生产默认接线 | `agent-tools/src/executor_run.rs`（`policy.output_budget_bytes` 分支） |
| A8 | moka：`CACHE_BUDGET_BYTES=32MB` **未进 builder**；`max_capacity(CACHE_MAX_ENTRIES=2048)` + `weigher` → 有效权重预算约 ~2KB 级 | `crates/conex-markdown/src/cache.rs:10-13,29-33,48-52` |
| A9 | 收口轨对 MessageDelta 已跳过二次 emit（`delta_sink_active`）；NoPersist 仍经 `EventQueue.push` 分配序号 | `run_idle.rs:1405-1411` |
| A10 | D0 `conex-shared/perf_budget` **尚未落盘**（本维取数依赖 D0；见 §2） | `conex-shared` grep 0 命中 |

---

## 2. 依赖与逻辑序

```text
D0 预算 SSOT（TOOL_OUTPUT_BUDGET… / 审计通道容量 / 真缓冲窗）
  │
  ├─ T-D1-A  NoPersist 跳取号        ← 零契约、可最先；必须先于 D3 组提交
  ├─ T-D1-B  审计通道有界            ← 可与 A 并行（不同文件）
  ├─ T-D1-C  moka 字节语义           ← 可与 A/B 并行（不同 crate）
  │
  ├─ T-D1-D  工具输出默认预算 + 执行器出口 Arc   ← 依赖 D0；CFL-06 主责票
  │            └─ U-OUT-FE / U-G8 不在本维（见 §5 互斥）
  │
  └─ T-D1-E  实时轨真缓冲（条件 flush） ← 与 PE-02 解耦；建议 A 绿后合入
               （同文件域 engine_channels；避免与 E 混轮）
```

### 2.1 硬性前置 / 禁止顺序

| 规则 | 内容 | 依据 |
| ---- | ---- | ---- |
| **NOP-EFORE-COMMIT** | **NoPersist 必须先于 D3 组提交接线**；组提交 PR 不得合入「批内仍含 NoPersist 白付取号」的事件路径 | CFL-03、92 §5 反例 1 |
| **≠PE-02** | 真缓冲只改 **flush 时机**；禁止在 `push_live` / Bridge 做 token 或事件体 N 合 1 拼接；合并窗常量若在 D0 预留，**PE-02 通过前禁止生产读取** | CFL-04、92 §5 反例 4 |
| **NO-D3-SAME-PR** | 本维任一任务 **不得与 D3（`conex-db/**` 写单轨）同 PR**；文件域天然互斥，但禁止「顺手」改 `conex-db` | 用户禁止项、92 §4 |
| **ARC-BOUNDARY** | 工具输出 Arc **只做到执行器出口**（ToolEnd / ToolResult）；IPC 全链 Arc / emit 全变体共享归 **D6（传输）/ D11（强契约）**，本维禁止扩面 | CFL-06、02 §D5 交叉说明 |
| **NO-TOKEN-MERGE** | 本维禁止实现/默许 PE-02 同 block 追加合并 | 用户禁止项 |
| **NO-COMMIT** | 子 Agent / 本维详案执行轮：**不 git commit**；改动留工作区交主控 | 92 §13 |

### 2.2 与 D0 的契约（取数点）

D0 落盘前，本维常量**临时**可在各任务内以 `// TODO(D0): migrate` 登记，但：

1. 合入实现 PR 前必须改为 re-export D0 常量（或 D0 同轮紧邻 PR 一次迁完）；
2. **禁止**三处以上各写各的字面量后「以后再统一」；
3. 建议常量名（D0 命名空间，本维只消费不定义真源）：

| 常量 | 语义 | 建议默认（实现时以 D0 表为准） |
| ---- | ---- | ------------------------------ |
| `TOOL_OUTPUT_BUDGET_BYTES_DEFAULT` | 执行器默认输出预算 | 64 KiB（02 §D5；shell 200KB 工具级覆盖保留） |
| `AUDIT_CHANNEL_CAPACITY` | 审计 mpsc 有界容量 | 与 EventBuffer Soft 同量级；满 → 丢弃计数 |
| `LIVE_FLUSH_WINDOW_MS` | 实时轨最小 flush 间隔 | 预留；Critical 立即 flush |
| （既有）`CACHE_BUDGET_BYTES` | markdown LRU 字节预算 | 已在 `conex-markdown`；D1 只修 builder 接线 |

---

## 3. 任务分解（四件套：做什么 / 不做什么 / 旧路径清单 / 完成自检）

> 路径 N→M 作答置于各任务首行。  
> 五端物证字段：触发 / 传输 / 介质 / 消费 / 负向。

---

### T-D1-A · NoPersist 跳取号（U-NOPE）

| 项 | 内容 |
| -- | ---- |
| **路径收敛** | 对 NoPersist：取号路径 **1→0**（仅持久化事件 reserve） |
| **映射 90 ID** | 03-R3、05-W3；92 F3 / INV-2；DEL-4（01） |
| **做什么** | ① `EventQueue::push`：将 `is_non_persistent(&event)` **前移**至 `reserve` 之前；② NoPersist 分支：不调用 `sequencer.reserve` / `store.reserve_sequence`；返回 `persisted: false`；③ **sequence 语义裁决（实现时必须写死并测）**：`SequencedEvent.sequence` 仍为 `u64` 时，NoPersist 使用 `self.last_reserved`（**不推进**计数器），且 `drive_outcome` / 任何 `run.cursor` 维护处 **禁止**因 NoPersist 把 cursor 改回更小值（建议：仅 `persisted==true` 时 `cursor = max(cursor, sequence)` 或等价单调保护）；或（更干净）将序列改为 `Option<u64>` 并改全消费方——**二选一，禁止半吊子**；④ 复核失败复用序列 Q25：未取号的 NoPersist 失败路径不得占用「失败序号空洞」语义（NoPersist 本就不落库）；⑤ 扩展 `events.rs` 单测：mock store 上 NoPersist **`reserve` 调用次数 = 0**；持久化事件 reserve 仍 =1/条。 |
| **不做什么** | ① 不改 `conex-db` / `reserve_sequence` SQL 实现（单语句化归 D3）；② 不实现组提交；③ 不改 PE-02 / 事件合并；④ 不改前端对 sequence 的消费；⑤ 不与 D3 同 PR；⑥ 不 git commit。 |
| **旧路径清单** | ① `events.rs:246-263`「先 reserve 后 `is_non_persistent`」控制流；② 依赖「NoPersist 也占号」的注释与测试假设（若有）必须同步改写为新契约。 |
| **唯一文件域** | `crates/orchestrator/src/events.rs`（+ 同文件测试 / `orchestrator` 内 cursor 相关最小触点）。**禁止**碰：`conex-db/**`、`engine_channels.rs`、`run_launch.rs`、`session-loop` 流式热路径（除非 `SequencedEvent` 类型变更的机械适配，且仅限签名适配）。 |
| **完成自检** | 单测：`NoPersist_push_does_not_reserve` 且 `Persist_push_reserves_once`；`cargo test -p orchestrator` 绿；`rg` 确认 `push` 内 `is_non_persistent` 出现在 `reserve` 之前；无 `TODO` 第二路径。 |
| **验收五端** | **触发**：普通 run 收口（含 message-delta 进 `drive_outcome`）；**传输**：实时轨 / 收口轨对 MessageDelta 既有跳过逻辑不回归；**介质**：events 表无 NoPersist 行（现状亦无，保持）；**消费**：`seed_sequences` / MAX+1 语义不变；**负向**：mock store `reserve_calls == 0`（NoPersist 批）。 |

**风险与实现注意（诚实边界）**

1. `run.cursor = sequenced.sequence` 若对 NoPersist 写入 `last_reserved` 且中间无持久化事件，cursor 不动——安全；若误用哨兵 `0`，cursor **回退**——验收必须覆盖「夹在两条持久化事件之间的 NoPersist 不拉低 cursor」。
2. 若改为 `Option<u64>`：全仓机械改消费方（含 tests）；波及面大于控制流重排——**默认优先控制流重排 + 单调 cursor**，除非主控裁决类型变更。

---

### T-D1-B · 审计通道有界化（U-AUDIT-BOUNDED）

| 项 | 内容 |
| -- | ---- |
| **路径收敛** | 审计 mpsc：**无界→有界**（1→1 形态替换） |
| **映射 90 ID** | 04-O1/O2、09-A1/B1；01 T-L1-C / DEL-12；OVL-10 |
| **做什么** | ① `run_launch.rs` 装配处将 `tokio::sync::mpsc::unbounded_channel` 改为 **有界** `channel(AUDIT_CHANNEL_CAPACITY)`（D0）；② `BridgeAuditSink::emit` 与 `spawn_audit_persistence` 签名适配 `Sender`/`Receiver`；③ 满时策略：**优先丢弃策略写死并可观测**——建议与 EventBuffer 哲学对齐：审计事件属 Critical 倾向，**更稳妥默认 = try_send 失败则丢弃 + 递增 drop 计数 + `tracing::warn`（限频）**；禁止静默无限阻塞 emit 线程（实时轨仍须先 `bridge.emit`）；④ drop 计数挂 `DeniedStats` / 桥 stats / 诊断槽（择一既有观测面，不新建平行 metrics 栈）；⑤ 单测：注入容量=1 的通道，溢出后计数=1 且 worker 仍能 drain 已入队项。 |
| **不做什么** | ① 不合并 EventBuffer 与审计通道为同一队列实现（策略对齐、通道分离——01 诚实边界 #4）；② 不改 security-audit 事件 schema；③ 不把 G8 / 工具输出预算卷入本任务；④ 不与 D3 同 PR；⑤ 不 git commit。 |
| **旧路径清单** | ① `unbounded_channel` 使用点（`run_launch.rs:562`）；② `UnboundedReceiver` / `UnboundedSender` 类型签名；③ 「通道关闭仅告警」语义保留（落库尽力而为不阻断 run）。 |
| **唯一文件域** | `apps/agent-workbench/src-tauri/src/run/run_launch.rs`、`run_core.rs`（`BridgeAuditSink` / `spawn_audit_persistence`）；stats 挂接若在 `engine_build` / `DeniedStats` 则**只读引用或最小字段追加**。**禁止**改 `engine_channels` 真缓冲（归 T-D1-E）、`orchestrator/events` NoPersist（归 T-D1-A）。 |
| **完成自检** | `rg 'unbounded_channel' apps/agent-workbench/src-tauri/src/run` 命中 = 0；溢出单测绿；收口 `audit_worker.await` 排空语义不回归。 |
| **验收五端** | **触发**：长 run 高频审计注入；**传输**：n/a（进程内）；**介质**：审计落库仍走 `push_terminal_best_effort`；**消费**：stats 丢弃计数可读；**负向**：有界类型编译期替代；压测 20 万条不 OOM（可降为集成冒烟 + 类型/单测）。 |

---

### T-D1-C · moka 字节容量语义（U-MOKA）

| 项 | 内容 |
| -- | ---- |
| **路径收敛** | 缓存容量语义：**条目权重误用 2048≈2KB 有效预算 → 字节 `CACHE_BUDGET_BYTES`（32MB）唯一语义** |
| **映射 90 ID** | 09-M1；92 §6 / §7「markdown LRU」；CFL-15；F5（禁只改注释） |
| **做什么** | ① `RENDER_CACHE` 与 `HIGHLIGHT_CACHE` builder：**字节容量**接线——`max_capacity(CACHE_BUDGET_BYTES as u64)`（moka weigher 语义下 max_capacity 为权重和上限）并保留 `weigher`；② 评估 `CACHE_MAX_ENTRIES`：若需条目上限，用 moka 支持的条目限制 API **显式**设置；**禁止**把 `max_capacity(2048)` 与字节 weigher 继续混用造成 ~2KB 假预算；③ `entry_within_budget` / `CACHE_ENTRY_MAX_BYTES` 单条目预检保留；④ 单测：插入多条使权重和逼近预算时发生驱逐；**有效预算数量级为 MB 非 KB**（构造 ≥ 数百 KB 条目集断言仍可多条共存，或对 `max_capacity` 配置做断言测试）。 |
| **不做什么** | ① 不把 moka 迁到 `conex-db`/引擎运行时缓存（域外）；② 不改前端 LruCache（若存在平行实现，仅注释交叉，不本维扩面）；③ 不删高亮/渲染双缓存分离（1C-8 正面设计）；④ 不 git commit。 |
| **旧路径清单** | ① `cache.rs:30-33` / `48-52` 的 `max_capacity(CACHE_MAX_ENTRIES)` + weigher 组合；② 「条目上限 2048 = 字节预算」的错误注释叙事。 |
| **唯一文件域** | `crates/conex-markdown/src/cache.rs`（+ 其测试）。 |
| **完成自检** | builder 中出现 `CACHE_BUDGET_BYTES`；`max_capacity(CACHE_MAX_ENTRIES)` 与 weigher 字节语义的混用删除；`cargo test -p conex-markdown` 绿。 |
| **验收五端** | **触发**：连续渲染/高亮多种代码块；**传输**：n/a；**介质**：进程内存缓存；**消费**：渲染命中率不因假 2KB 预算崩塌（回归视觉/单测）；**负向**：静态断言或配置单测证明容量语义为字节预算。 |

---

### T-D1-D · 工具输出默认预算 + 执行器出口 Arc（U-OUT-RS · 主责）

| 项 | 内容 |
| -- | ---- |
| **路径收敛** | 生产默认：`None → Some(预算常量)`（1 条真相）；出口表示：多份深 clone → **Arc 共享边界** |
| **映射 90 ID** | 10-T4、08-H3 交叉、03-C2 交叉；CFL-06 U-OUT-RS；02 D5；F3/F4 |
| **做什么** | ① `run_launch.rs` 装配 `ToolBatchOptions` 时显式 `output_budget_bytes: Some(TOOL_OUTPUT_BUDGET_BYTES_DEFAULT)`，**禁止**仅靠 `..Default::default()` 继承 None；② `ToolBatchOptions::default()` 同步改为 Some（防测试装配漏网）——测试若需无预算，**显式**传 `None`；③ 确认 `executor_run` / summarize / `truncated` 透传链在生产路径生效；④ **执行器出口 Arc**：`ToolEnd`（或 `ToolEvent`→AgentEvent 映射点）大 output 使用 `Arc<serde_json::Value>` / 等价共享，消除 `exec_batch`/`exec_single` 对同一 output 的重复深 clone；接口为后续 D6/D11 **预留透传**，本维不扩 IPC 全链；⑤ `ToolResult` 双表示（text/output）：至少保证不再被读后可释放，或惰性 stringify——**不破坏**上层依赖 `text` 的契约为前提；⑥ shell 工具级 200KB 覆盖保留（可大于/小于全局默认，以显式覆盖为准）。 |
| **不做什么** | ① **不做** IPC / emit 全链 Arc、fanout meta、双发回执（→ D6/D11）；② **不做** G8 `truncate_tool_output` 正常路径接线（→ U-G8 / D10 交叉，CFL-06 禁止冒充）；③ **不做** 前端 store hardCap（→ U-OUT-FE / D5）；④ **不做** PE-02；⑤ 不与 D3 同 PR；⑥ 不 git commit。 |
| **旧路径清单** | ① `tool_events.rs:343` `output_budget_bytes: None`；② `run_launch.rs:752-759` 未覆盖预算；③ 执行→事件链上与 Arc 等价的重复深 clone 点（以读码清单为准，删形态不删语义）。 |
| **唯一文件域** | `apps/agent-workbench/src-tauri/src/run/run_launch.rs`；`crates/session-loop/src/tool_events.rs`；`crates/session-loop/src/{exec_batch,exec_single,exec_verdict}.rs`；`crates/session-loop/src/loop/handlers/executing_tools.rs`（事件映射 / ToolEnd 构造）；`crates/agent-tools/src/executor_run.rs` 及 output 相关类型（若同票 Arc）。**禁止**改：前端 ToolCallOutput / streamCallbacksEvents（U-OUT-FE）、`conex-compaction` G8 主路径（U-G8）、D6 传输文件。 |
| **完成自检** | 生产装配点 `output_budget_bytes` 为 `Some`；`cargo test -p session-loop -p agent-tools` 含既有 `output_budget_bytes_truncates_large_output` 全绿；新增：默认 Some 时大输出 truncated=true；Arc：同一 output 在 ToolEnd 路径 clone 次数可测下降（计数探针或等价断言）。 |
| **验收五端** | **触发**：大 `read_file`/shell 输出；**传输**：tool-end 体积 ≤ 预算 + 结构 overhead；**介质**：events/内存 payload 有界；**消费**：卡片可显示 truncated 标记（前端已具备则只回归）；**负向**：`run_launch` 装配 `None` = 0；默认路径截断单测。 |

**与 CFL-06 三票边界（防假完成）**

| 票 | 主责维 | 本维？ |
| -- | ------ | ------ |
| U-OUT-RS | **D1** | 是（本任务） |
| U-OUT-FE | D5 | 否——只读对接常量 |
| U-G8 | D10 / 02-D6 | 否——本维完成不得宣称 G8 已修 |

---

### T-D1-E · 实时轨真缓冲（条件 flush）

| 项 | 内容 |
| -- | ---- |
| **路径收敛** | 伪缓冲：每事件立即 flush **1→1**（条件化形态；事件体仍逐条） |
| **映射 90 ID** | 03-R7/R8；01 T-L4-C；CFL-04 / OVL-18 |
| **做什么** | ① `BridgeLiveSink::push_live`：`emit` 后**不**无条件 `flush()`；② 触发 flush 条件：时间窗（`LIVE_FLUSH_WINDOW_MS`）到期，或缓冲 Critical 水位（复用 `EventBuffer` Soft/Critical 策略——Soft 可丢、Critical 必达）；③ run 收口 / 关键终态路径保留**强制 flush**（既有 `drive` 收口 flush、`finalize_*` flush 不得削弱）；④ 窗口最小化时放大 flush 周期（03-R8）——实现与单测覆盖「末尾必 flush」；⑤ **明确不做事件体合并**。 |
| **不做什么** | ① 禁止在 sink 内做 token/文本 N 合 1（PE-02）；② 不改 `streaming.rs` 双轨分支语义（除「无需每 delta flush」间接收益）；③ 不动 fanout/push meta（D6）；④ 不与 D3 同 PR；⑤ 不 git commit。 |
| **旧路径清单** | ① `engine_channels.rs:718-720` 无条件 `flush()`；② 任何复制该形态的 live/delta 包装。 |
| **唯一文件域** | `apps/agent-workbench/src-tauri/src/engine_channels.rs`（+ 可选 `buffer.rs` 只读复用 / 最小暴露水位 API）。 |
| **完成自检** | `push_live` 热路径无每调用必达的 `flush()`；收口强制 flush 测试绿；Soft 丢帧语义压测/单测不回归。 |
| **验收五端** | **触发**：高频率流式输出；**传输**：前端 batcher 兼容（事件仍逐条上 wire，可减 flush 次数）；**介质**：n/a；**消费**：末尾 delta 延迟 ≤ 窗 + 一次 flush；**负向**：单测「N 次 push_live + 1 次收口」flush 调用次数显著低于 N。 |

---

## 4. 唯一文件域与并行互斥表

| 任务 | 主责文件域 | 允许并行的 D1 任务 | 明确禁止同轮写 |
| ---- | ---------- | ------------------ | -------------- |
| T-D1-A | `orchestrator/src/events.rs` | B、C、D（无交集） | D3 `conex-db/**`、`engine_channels`、`run_launch` |
| T-D1-B | `run_launch.rs` + `run_core.rs` 审计段 | A、C | A 的 events.rs、E 的 flush 逻辑、D 的 ToolBatchOptions 字段 |
| T-D1-C | `conex-markdown/src/cache.rs` | A、B、D | 全部引擎侧 |
| T-D1-D | `run_launch` ToolBatch 装配 + `session-loop` tool/exec + agent-tools executor | A、B、C | 前端 FE cap、G8、D6 IPC Arc |
| T-D1-E | `engine_channels.rs` | A、C（建议 A 绿后） | B（同 run_launch 文件时 B 先合或拆行级互斥）、D3 |

**D1 × 他维**

| 他维 | 互斥说明 |
| ---- | -------- |
| D0 | 本维消费预算常量；D0 文件独立，可先/紧邻 |
| **D3** | **禁止同 PR**；NoPersist 绿是 U-DB-COMMIT 前置 |
| D5 | FE hardCap / 驱逐不进本维 |
| D6 | 传输 / meta / 双发 / IPC Arc 不进本维 |
| D10 | G8、同步摘要不进本维 |
| D11 | PE-02 / Progress / schema 票不进本维 |

---

## 5. 路径 N→M 总表

| 概念 | 现路径 | 目标 | 任务 |
| ---- | ------ | ---- | ---- |
| NoPersist 取号 | 1（恒 reserve） | 0 | A |
| 审计落库通道 | 1 无界 | 1 有界+计数 | B |
| markdown LRU 容量 | 权重误 2KB 语义 | 字节 32MB 语义 | C |
| 工具输出默认预算 | None（生产） | Some(常量) 唯一 | D |
| 工具出口大 output 所有权 | 多份深 clone | 出口 Arc | D |
| 实时轨 flush | 每事件 1 次 | 条件窗/水位 + 收口必达 | E |
| token 合并 / PE-02 | 未实现 | **保持未实现**（本维禁止） | — |
| IPC 全链 Arc | 多源 | 归 D6/D11，本维不扩 | — |

---

## 6. 负向断言清单（交付必附）

| ID | 断言 | 适用任务 |
| -- | ---- | -------- |
| N1 | NoPersist 路径 `reserve`/`reserve_sequence` 调用次数 **= 0**（单测 mock） | A |
| N2 | `run.cursor` 在 NoPersist 夹心批后 **不回退**（相对批内已见最大持久化 sequence） | A |
| N3 | `rg unbounded_channel` 在审计装配路径 **= 0** | B |
| N4 | 审计通道满时 drop 计数 **单调递增** 且实时广播路径仍发出 | B |
| N5 | `cache` builder 使用 `CACHE_BUDGET_BYTES`；`max_capacity(CACHE_MAX_ENTRIES)`+字节 weigher 混用 **= 0** | C |
| N6 | 生产 `ToolBatchOptions` 装配 `output_budget_bytes` **≠ None** | D |
| N7 | 默认预算下超限输出 `truncated == true` 且贯穿 tool-end | D |
| N8 | 执行器出口之外的 IPC 全链 Arc 改动 **= 0**（文件域 diff 白名单） | D |
| N9 | `push_live` 无「每事件必 flush」；收口/终态强制 flush 仍存在 | E |
| N10 | 全维 **无** PE-02 拼接/合并代码；D0 合并窗常量生产读取 **= 0** | A–E |
| N11 | 本维 PR **未**包含 `conex-db/**` 写轨变更 | A–E |
| N12 | 无 `--no-verify`；无 git commit（子 Agent） | A–E |

---

## 7. 防御脚本 / 守护测试增量

| 类型 | 内容 | 任务 |
| ---- | ---- | ---- |
| 单测 | `orchestrator`：NoPersist reserve=0；cursor 单调 | A |
| 单测 | 审计有界溢出策略 | B |
| 单测 | moka 容量配置/驱逐量级 | C |
| 单测 | 默认预算截断 + 显式 None 测试注入仍合法 | D |
| 单测 | 真缓冲窗 + 收口 flush | E |
| 门禁（建议，随 D0/D13） | `check-perf-budgets`：业务源预算字面量必须 re-export；审计 `unbounded_channel` 进 run 装配黑名单可后续挂 `check-store-islands` 同类脚本 | D0/D13 协作 |
| 集成探针（可选） | tracing SQL 计数：delta 批 `reserve` = 0；tool-end 字节 ≤ 预算 | A、D |

**本维不新建**第三预算真源脚本；脚本接线服从 D0 + D13。

---

## 8. 与首轮切片映射（92 §10）

| 切片 | 本维任务 | 备注 |
| ---- | -------- | ---- |
| U-NOPE | T-D1-A | **独立可派**；D3 前置 |
| （并入） | T-D1-B/C | 文件域不交，可与 U-NOPE/U-BUDGET 并行 |
| （第二波或同波不交集） | T-D1-D | 依赖 D0 常量名 |
| （建议 A 后） | T-D1-E | 与 B 若同改 `run_launch` 则串行 |

U-DB-COMMIT 验收前置勾选：**U-NOPE 绿**（N1）。

---

## 9. 评审检查单（detail 评审用）

1. 是否每任务四件套齐全且「不做什么」写明 PE-02 / D3 / IPC Arc？  
2. NoPersist sequence/cursor 是否有 N2 级断言？  
3. 工具输出是否只完成 U-OUT-RS，未偷带 FE/G8？  
4. moka 是否改 builder 而非只改注释？  
5. 真缓冲是否只动 flush 时机？  
6. 文件域是否与 D3/D5/D6/D10/D11 互斥表一致？  
7. 负向断言 N1–N12 是否可执行？

---

## 10. 汇报模板（子 Agent 完成后）

| 项 | 内容 |
| -- | ---- |
| **路径** | `materials/plans/detail-D1-引擎减载.md`（本文件）；实现 PR 路径由执行轮填写 |
| **前置依赖** | D0 预算 SSOT（常量名）；U-NOPE 先于 U-DB-COMMIT；无 PE-02 前置 |
| **负向断言清单** | §6 N1–N12（执行后勾选 + 测试命令输出摘要） |
| **未做 / 风险** | 如 `SequencedEvent` 类型是否 Option；审计满策略主控是否改阻塞；与 B/E 同改 `run_launch` 的拆分方式 |

---

## 11. 诚实边界（待执行前读码）

1. **moka API**：不同版本对 `max_capacity` 与 weigher 的交互（条目数 vs 权重）以当前 lockfile 文档为准；实现时核对 moka 版本，禁止凭记忆写错 API。  
2. **`SequencedEvent` 消费面**：cursor / Q25 / 前端是否读 NoPersist 的 sequence——实现 Agent 须 `rg` 全消费点后锁定 N2 方案。  
3. **审计有界后的阻塞语义**：若满时改 `send().await` 会拖死 emit 线程——默认 **不阻塞**；若产品要求审计必达，需主控改票并接受实时轨延迟。  
4. **ToolEnd Arc 类型选择**：`Arc<serde_json::Value>` vs `Arc<String>` vs 结构体字段 Arc——以最小 diff 且不破坏事件反序列化为准；schema 不升版（T0）。  
5. **真缓冲定时器载体**：无状态 `BridgeLiveSink` 上如何做时间窗（Instant 记忆 / 桥内 AtomicU64 / 每 emit 查 flush 调度）——实现选 O(1) 方案，禁止 per-event 线程。

---

_Detail-D1 定稿（分维详案层）。后续仅允许评审修订追加，不得静默削弱 §0 效果锁与 §6 负向断言。未 git commit。_
