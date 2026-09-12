# 13-Compaction 与上下文压缩审查报告

> **战役**：全面性能审查（performance-audit）
> **方向**：13 · Compaction 与上下文压缩
> **创建**：2026-09-13
> **状态**：静态审查完成（运行时 V 项待回填）
> **范围**：`crates/conex-compaction/` 全量；`session-loop` 压缩编排（compaction_dispatch / 预检·边界·溢出触发）；`context-compression-start/end` 事件链路；摘要生成阻塞；摘要结果持久化与重放；压缩前后消息列表拷贝与大上下文序列化；与 04-K1 / 03 事件 payload / 05 读路径交叉
> **方法**：静态代码走读 + 证据链（`文件路径:行号`）；未实测项标注「静态分析结论，待运行时验证」
> **素材**：`materials/13-compaction走读素材.md`

---

## 一、一句话结论

**压缩算法面（切割点、折叠链不变量、工具配对闭包、usage 优先估算、后台摘要退避与单飞）架构纪律健康；但「预检/边界/溢出路径上的同步 LLM 摘要最多阻塞 async run loop 90 秒」与「estimate_context 每 turn 最多 3 次全量扫描 + tools JSON 每调用重建」「摘要提示词对丢弃段工具输出零预算全量渲染」三个结构性问题，使压缩从「上下文保险丝」退化为「长对话/大工具输出场景下的延迟与内存尖峰源」——再叠加压缩执行内部 4–6 次重复 token 扫描、事件载荷 id 列表双份、溢出 shape 修复二次完整 compact（可能二次 LLM），一次压缩的端到端成本远超其「单遍切割 + 单次摘要」的算法本体。**

---

## 二、发现总表

| ID | 严重度 | 标题 | 主位置 |
| -- | ------ | ---- | ------ |
| C13-H1 | **高** | 同步 LLM 摘要阻塞 async run loop（预检/边界/溢出路径未 spawn_blocking），最坏 60–90s 冻结会话并占用 tokio worker | engine.rs:370-371 · engine_channels.rs:205-210 · compaction_dispatch.rs:284-290 |
| C13-H2 | **高** | estimate_context 每 turn ≤3 次调用，tools_prefix_json 每调用全量克隆+序列化（04-K1 深挖确认 + tools 缓存缺口） | compaction_dispatch.rs:92-116 · streaming.rs:440 |
| C13-H3 | **高** | build_summarize_prompt 对丢弃段工具输出零预算全量渲染；G8 tool_output 截断未接线到正常路径，仅 emergency 截断 | ai_summary.rs:33-117 · engine.rs:363 · tool_output.rs |
| C13-M1 | 中 | compact 单次执行内部 4–6 次重复全量/分段 token 扫描（before/cut/dropped/emergency） | engine.rs:289-326,493-617 · cut_point.rs:147-150 |
| C13-M2 | 中 | apply_compaction 捕获 dropped_for_retry：O(D×N) find + 全量值克隆 | compaction_dispatch.rs:408-418 |
| C13-M3 | 中 | ContextCompressionEnd 载荷 summary 全文 + kept/dropped id 列表 + cache_boundary 再一份 id 列表（双份冗余） | compaction_dispatch.rs:583-626 · tool.rs:483-508 |
| C13-M4 | 中 | 溢出 shape 修复路径对同一对话二次完整 compact（含二次同步 LLM 调用） | stream_error_recover.rs:178-205 |
| C13-M5 | 中 | 公共 emergency_preflight 入口在超预算时可能二次 compact（含二次 LLM） | engine.rs:622-661 |
| C13-M6 | 中 | noop / 放弃压缩路径仍付出全量 tokens 扫描（tokens_before / noop_plan 再计） | plan.rs:109-113 · engine.rs:289-292 |
| C13-M7 | 中 | restore 对每会话分页拉全量事件后逐条反序列化找 compression-end（与 05 读放大交叉） | restore_manager.rs:252-283 |
| C13-M8 | 中 | count_compression_events 无 (session_id, event_type) 索引——块表 generation 兜底扫全会话事件（05-Q1 交叉确认） | conex-db blocks.rs:329-343 |
| C13-L1 | 低 | CompactionEngine::new(0) 每调用点新建（廉价但无意义） | compaction_dispatch.rs:93,182,228,283 · stream_error_recover.rs:143 |
| C13-L2 | 低 | tools_prefix_json 逐工具 clone name/description/input_schema 三字段再装 Value | compaction_dispatch.rs:106-115 |
| C13-L3 | 低 | enforce_tool_batch_closure 循环内 HashSet 每轮重建 | cut_point.rs:48-67 |
| C13-L4 | 低 | truncate_summary 逐字符 pop 收缩循环 | plan.rs:181-197 |
| C13-L5 | 低 | 溢出/预检多次路径各自构造 CompactionTriggerInfo 与 engine，无共享估算快照 | compaction_dispatch.rs · stream_error_recover.rs |
| C13-L6 | 低 | generation 引擎侧恒 1 占位（正确性备注；事件 details 与块表可能短暂不一致，非性能主路径） | engine.rs:353 · plan.rs:70-72 |

**统计**：高 3 · 中 8 · 低 6 = **17 项** + 正面 10 项。

---

## 三、架构与调用链速览

### 3.1 压缩全链路

```
prepare_turn
  ├─ (hold 非空) maybe_compact_user_boundary → estimate → compact_with_llm_guard
  └─ maybe_compact_preflight                → estimate → compact_with_llm_guard
        └─ compact_agent_messages_with_stub_policy
              ├─ tokens_before 全扫
              ├─ find_cut_point_inner（counts 全扫 + 闭包）
              ├─ dropped_slice 值克隆
              ├─ summarizer.summarize ←【同步 LLM，C13-H1】
              ├─ tokens_after 增量
              └─ apply_emergency_preflight（可选）
        └─ apply_compaction
              ├─ dropped_for_retry O(D×N) 捕获 ←【C13-M2】
              ├─ conversation = plan.messages.clone()
              ├─ ContextCompressionStart/End 广播 ←【C13-M3】
              └─ stub 时登记后台摘要（spawn_blocking，正确）

stream_error (ContextLengthExceeded / PayloadTooLarge)
  └─ length_ladder 用尽 → compression_ladder → 同步 compact + 可能二次 shape 修复 ←【C13-M4】

build_request (streaming)
  └─ clamp_request_max_tokens → estimate_context（tools_prefix 重建）←【C13-H2】
```

### 3.2 触发阈值与预算

| 项 | 默认 | 位置 |
| -- | ---- | ---- |
| 预检阈值 | `estimate ≥ window − reserve` | compaction_dispatch.rs:181-183 |
| 水位双阈值（classify 面） | 0.85 / 0.95（Critical 语义已废止） | thresholds.rs:10-12, 21-40 |
| keep_recent_tokens | 20_000 | cut_point.rs:11 · plan.rs:29 |
| min_recent_turns | 2 | cut_point.rs:13 |
| max_summary_tokens | 1_024 | plan.rs:11 |
| max_auto_compactions_per_run | 1（溢出绕开） | compaction_dispatch.rs:693-697 |
| overflow retries | 2；keep 阶梯 20K→12K→8K | stream_error_recover.rs:24-31 |
| 摘要 HTTP 超时 | 60s；recv 兜底 90s | engine_channels.rs:65-68 |
| 后台墙钟 | 60s；退避 1/3/9s；episode≤4；窗口 8 次/30min | summary_dispatch.rs:66-102 |
| ContextBudget 默认 | reserve 16384 / safety 4096 | run_history.rs:428-431 · core_run_commands_tests.rs:912-914 |

生产装配：`context_window` 入站 → `ContextBudget` → `SessionLoopOptions.assembly.context_budget`（run_launch.rs:521-541,723）——**预算层在目录可解析窗口的模型上默认启用**，故 estimate 三调用点是常态路径而非实验路径。

---

## 四、高危发现（八要素）

### C13-H1【高 / P0】同步 LLM 摘要阻塞 async run loop（预检 / 边界 / 溢出）

#### 4.1.1 位置

- 同步调用点：`crates/conex-compaction/src/engine.rs:370-371`（`summarizer.summarize`）
- 编排入口：`crates/session-loop/src/loop/compaction_dispatch.rs:284-290`（`compact_with_llm_guard`）
- 边界/预检/溢出均经此：compaction_dispatch.rs:190, 249；stream_error_recover.rs:154-160
- 生产实现：`apps/agent-workbench/src-tauri/src/engine_channels.rs:147-213`（`rx.recv_timeout(90s)`）
- run 宿主：`apps/agent-workbench/src-tauri/src/run/run_launch.rs:912`（`tauri::async_runtime::spawn(drive_run_loop)`）
- 正面对照（后台正确路径）：`crates/session-loop/src/loop/summary_dispatch.rs:780-793`（`spawn_blocking` + `timeout`）

#### 4.1.2 现场

`Summarizer` 是同步 trait（plan.rs:81-85）。生产 `ProviderSummarizer` 为避免嵌套 runtime，把 HTTP 放到专用线程 + 独立 current_thread runtime（engine_channels.rs:162-201），但**调用线程在 `rx.recv_timeout(SUMMARY_HTTP_RECV_TIMEOUT)` 上同步等待最多 90 秒**（engine_channels.rs:205-210）。

预检路径在 async 函数 `maybe_compact_preflight` / `compact_with_llm_guard` 内**直接**调用该同步 summarize——没有 `spawn_blocking`、没有 `tokio::time::timeout` 包裹。

#### 4.1.3 调用链

```
tauri async worker
  → drive_run_loop (spawn)
    → AgentSessionLoop::produce / handle
      → handlePrepareTurn
        → maybe_compact_preflight (async)
          → compact_with_llm_guard (async)
            → compact_agent_messages_with_stub_policy (sync)
              → ProviderSummarizer::summarize (sync, blocks ≤90s)
```

溢出阶梯 `compression_ladder`（stream_error_recover.rs:114-229）同样同步调用。

#### 4.1.4 根因

1. trait 为同步签名（crate 纯算法定位有意为之）；
2. 预检/边界/溢出是「必须在下一步请求前拿到摘要或 stub」的同步决策点，实现时把 LLM 尝试内联进引擎调用（R-F 同步单次尝试）；
3. 后台重试路径（T-33）正确用了 `spawn_blocking`，但**同步首次尝试路径没有对齐同一纪律**。

#### 4.1.5 影响量化（静态分析）

| 维度 | 估算 |
| ---- | ---- |
| 单次最坏阻塞 | recv 90s 兜底；HTTP 自身 60s 超时 → 正常失败 ≤60s，线程泄漏场景 ≤90s |
| 会话响应 | 该 run 完全冻结：abort 检查在 summarize 返回前不会执行；用户取消延迟到摘要结束 |
| 运行时占用 | 占用 1 个 tokio worker 整段；多会话同时触发预检压缩时可叠加（默认 worker≈CPU 核数） |
| 触发频率 | 每 run 上限 `max_auto_compactions_per_run`（默认 1）+ 溢出最多 2 次；长会话每 run 均可能触发 |
| UX | 用户在 85% 水位后发送消息，感知为「发送卡住数十秒」 |

#### 4.1.6 修复方案

1. **最小改动**：`compact_with_llm_guard` / `compression_ladder` 在调用引擎前，将「summarize 尝试」拆出——用 `tokio::task::spawn_blocking` + `tokio::time::timeout(max_wall_ms)` 执行 `summarizer.summarize`，把结果以 `Option<Result<…>>` 注入引擎（或引擎增加 `summarize_precomputed` 入参）。
2. **结构对齐**：与 `summary_dispatch::summarize_once` 共用同一 helper，杜绝双路径纪律漂移。
3. **可选增强**：预检改为「先 stub 压缩 + 后台补摘要」（已有 pending_summary_retry 机制），同步路径零 LLM——需评估 stub 永驻窗口对模型质量的影响（效果锁：不得默默降级为纯丢弃）。

#### 4.1.7 回归锚点

- 单测：预检路径注入慢 Summarizer（sleep 5s）时，同 task 内 abort 信号应在 ≤1s 生效（当前不可能）。
- 集成：`core_run_commands_tests` 既有预检压缩事件断言保持。
- 契约：R-F「同步单次尝试」语义若改为异步，需在方案层显式裁决（不属本报告静默变更）。

#### 4.1.8 严重度判定理由

处于**每长对话必经的准备路径**；最坏秒级到分钟级冻结；与「工具 async 内同步 IO」（方向 10 T1）同型的 async 纪律破口；多会话桌面场景可放大为全局卡顿。

---

### C13-H2【高 / P0】estimate_context 每 turn ≤3 次全量路径 + tools JSON 每调用重建

#### 4.2.1 位置

- 估算入口：`compaction_dispatch.rs:92-100`
- tools 前缀：`compaction_dispatch.rs:104-116`
- 三调用点：`compaction_dispatch.rs:226`（boundary）、`:180`（preflight）、`streaming.rs:440`（clamp）
- 引擎实现：`conex-compaction/src/engine.rs:163-171`；`thresholds.rs:125-218`
- 快照（已缓存但 JSON 未缓存）：`streaming.rs:464-475`

#### 4.2.2 现场

预算层默认启用后，每个 turn：

1. 用户消息进入时 `maybe_compact_user_boundary` → `estimate_context`；
2. `maybe_compact_preflight` → `estimate_context`；
3. 首次 `build_request` → `clamp_request_max_tokens` → `estimate_context`。

每次 `estimate_context`：

- 无条件 `CompactionEngine::new(0)`；
- `tools_prefix_json`：对快照中每个工具 `clone` name/description/input_schema，装入 `serde_json::Value` 数组，再 `to_string`——**工具集合 run 内不变，JSON 却每次重建**；
- `estimate_context_tokens`：usage 命中时 O(尾随)；usage 缺失/被护栏作废时全量块级扫描。

#### 4.2.3 调用链

```
prepare_turn → maybe_compact_* → estimate_context → tools_prefix_json + estimate_context_tokens
streaming build_request → clamp_request_max_tokens → estimate_context（同上）
```

#### 4.2.4 根因

估算结果无 turn 级缓存；tools 前缀串未随 `tools_snapshot` 一并预计算；三触发点各自独立调用（无共享「本 turn 估算快照」）。

#### 4.2.5 影响量化（静态分析）

设消息数 M、工具 JSON 体积 T 字节：

- 每 turn 至少 3×(T 序列化 + 消息扫描)；
- usage 未命中窗口（冷启动、压缩后护栏作废、provider 无 usage）时扫描成本 ~O(M)×3；
- 30 个 MCP 工具会话 T 可达数百 KB——序列化 ×3/turn 与 04-S3 tools to_vec 叠加。

04-K1 已登记「每请求 O(N)」；本方向**确认并加重点**：tools_prefix 缺缓存是独立于消息扫描的固定税，且 boundary+preflight 使「同 turn 双压缩判定」比 04 原文描述更常见（有 hold 时必双调）。

#### 4.2.6 修复方案

1. `ensure_tools_snapshot` 时预计算 `tools_prefix_json: Option<String>` 旁路缓存（与快照同生命周期）；
2. LoopState 增加 `estimate_cache: Option<(ConversationEpoch, EstimateContext)>`——`conversation` 变更（record_message / compact / steering 注入）时失效；`last_compaction_at` 变化同样失效；
3. boundary 与 preflight 共享同一次估算结果（边界压缩若已发生则 preflight 天然跳过计数——现状已部分去重，但未压缩时仍双扫）；
4. 引擎实例可复用（值类型无状态，`&'static` 或方法关联函数化均可，收益次要）。

#### 4.2.7 回归锚点

- 单测：缓存命中后 estimate 与全量重算一致；compact/steering/record 后强制失效；
- 04 运行时 V8 场景：500 消息 × 每 turn clamp——缓存后全扫次数 ≤1/turn。

#### 4.2.8 严重度判定理由

每 turn 必经 ×3；长对话与多工具会话双重恶化；修复面小、无契约风险；与 04-K1 合并性价比最高。

---

### C13-H3【高 / P0】摘要提示词对丢弃段零预算；G8 截断未接线到正常工具路径

#### 4.3.1 位置

- 提示词渲染：`conex-compaction/src/ai_summary.rs:33-69, 81-117`
- 丢弃段值克隆：`engine.rs:363`
- G8 截断算法：`conex-compaction/src/tool_output.rs:178-288`
- **唯一生产调用点**：`engine.rs:561-579`（emergency preflight 阶段 2）
- 工具侧独立预算（语义不同）：`agent-tools` shell 200KB / `output_budget_bytes`

#### 4.3.2 现场

`render_message_text` 对 ToolResult 的 `output.text` / `output.json` **无任何行数/字节/token 预算**，全量拼进提示词字符串。`build_summarize_prompt` 再对每条 dropped 消息包一层 role 前缀后追加。

`tool_output.rs` 模块头注释写明：「截断动作的注入时机（工具结果记录路径）与事件落库由调用方（session-loop）接线」——但 rg 全仓 `truncate_tool_output` 的非测试调用**仅 emergency preflight**。正常对话中工具输出进入 conversation 后，直到压缩触发前不受 G8 双阈值约束（shell 工具有自身 clamp，但 read_file/search/MCP 等族未必同限）。

#### 4.3.3 调用链

```
compact_agent_messages_with_stub_policy
  → dropped_slice = 全量 AgentMessage 值克隆
  → summarizer.summarize(dropped_slice, existing)
      → build_summarize_prompt → render_message_text（全量）
      → HTTP body = 单条 user 消息含全部渲染文本（C14：无 tools）
```

#### 4.3.4 根因

1. 摘要通道设计时假设「被丢弃消息已在 wire/工具面被预算约束」；
2. G8 算法完成但生产接线缺失（与 10-方向「默认输出预算」是不同层：工具返回层 vs 摘要提示词层）；
3. 提示词构建无第二道防线。

#### 4.3.5 影响量化（静态分析）

| 场景 | 估算 |
| ---- | ---- |
| 丢弃段含 10×200KB 工具输出 | dropped_slice 值克隆 ≈2MB 堆分配；提示词字符串 ≈2MB+；HTTP body 同量级 |
| LLM 延迟 | 输入 token 与成本随丢弃段线性涨；叠加 H1 同步阻塞 |
| 摘要质量 | 超长输入易截断/退化 → 触发 stub → 后台重试再付一次全量渲染 |

#### 4.3.6 修复方案

1. **接线 G8**：工具结果写入 conversation 前（session-loop tool 完成路径）调用 `truncate_tool_output`（默认 2000 行/50KB），留痕事件按 tool_output.rs 设计；
2. **提示词第二道防线**：`build_summarize_prompt` 对单条消息渲染结果施加 `max_chars_per_message` / `max_prompt_bytes`（与 `max_summary_tokens×4` 同源预算），超限 head+tail+标记；
3. `dropped_slice` 改为只借 `&[Arc<AgentMessage>]`（Summarizer trait 若必须 owned，可传 `Vec<Arc<_>>` 或渲染时零拷贝）——避免为 LLM 输入先付一遍全文克隆。

#### 4.3.7 回归锚点

- 单测：含 100KB ToolResult 的 dropped 段，提示词长度 ≤ 配置预算；
- G8 既有 tool_output 单测保持；
- emergency 截断路径行为不回归。

#### 4.3.8 严重度判定理由

大工具输出是本产品常态（方向 10 已证输出默认无预算问题）；压缩恰在上下文最肥时触发——「最肥时全量进 LLM」放大延迟与费用；与 H1 叠加为用户体验硬伤害。

---

## 五、中危发现（八要素摘要）

### C13-M1【中】compact 内部重复 token 扫描

#### 位置

- engine.rs:284-292（tokens_before 全量 sum）
- cut_point.rs:147-150（find_cut_point_inner 再建 counts 全量 Vec）
- engine.rs:323-326（dropped_tokens 分段 sum）
- engine.rs:546-549, 612-615（emergency 路径再全量 sum ×2）

#### 现场

```rust
// engine.rs:289-292 — 第一遍全量
let tokens_before: u64 = messages
    .iter()
    .map(|m| count_agent_message_tokens(m) as u64)
    .sum();

// cut_point.rs:147-150 — 第二遍全量（独立纯函数自带）
let counts: Vec<usize> = messages
    .iter()
    .map(|m| count_agent_message_tokens(m))
    .collect();
```

1C-9 已将 `tokens_after` 改为 `tokens_before - dropped_tokens + summary_tokens` 增量（engine.rs:441-448，正面）；但 before 与 cut 的 counts 仍是两遍独立遍历，emergency 再追加 1–2 遍。

#### 调用链

```
compact_agent_messages_with_stub_policy
  → count 全量（before）
  → find_cut_point_inner → count 全量（counts）
  → dropped_tokens 分段 count
  → [可选] apply_emergency_preflight → header sum + current_tokens 全量 sum + 截断后再 sum
```

#### 根因

find_cut_point 作为可独立单测的纯函数，签名不接受外部 counts；引擎层无法复用第一遍结果。

#### 影响量化（静态分析）

| 路径 | 全量/分段 count 遍数 |
| ---- | -------------------- |
| 真实压缩（无 emergency） | 2 全量 + 1 分段 |
| 真实压缩 + emergency | 4 全量级 + 1 分段 |
| noop（无 cut） | 2 全量（before + noop_plan） |

M=1000、平均 500 字节/消息时单遍 ~O(500KB 文本) 字符扫描；相对 LLM RTT 占比低，但本地 CPU/分配在高频溢出重试时可见。

#### 修复方案

1. `find_cut_point_inner` 增加可选 `counts: &[usize]` 参数，引擎注入第一遍结果；
2. emergency 复用最后一次 sum 作为基线，截断只对 changed 消息 delta 更新；
3. 与批次 Z 合并。

#### 回归锚点

cut_point 全部单测（自算路径与注入路径等价断言）；engine 紧急预检测试。

### C13-M2【中】dropped_for_retry O(D×N) 捕获

#### 位置

compaction_dispatch.rs:406-418（apply_compaction 内、对话替换前）

#### 现场

```rust
// compaction_dispatch.rs:408-418
let dropped_for_retry: Vec<conex_types::message::AgentMessage> = plan
    .dropped_ids
    .iter()
    .filter_map(|id| {
        state
            .conversation
            .iter()
            .find(|m| &m.id == id)
            .map(|m| (**m).clone())
    })
    .collect();
```

对每个 `dropped_id` 在全量 `conversation` 上线性 `.find`，命中后对 AgentMessage 做**值克隆**（blocks 深拷，含 ToolResult 全文）。

#### 调用链

```
apply_compaction
  → dropped_for_retry 捕获
  → conversation = plan.messages.clone()   // 替换发生于捕获之后（正确顺序）
  → pending_summary_retry / SummaryDispatchTask 持有 dropped Vec
```

#### 根因

`CompactionPlan` 只携带 `dropped_ids: Vec<String>`，不携带消息本体；后台重试需要与同步尝试同源的 `Vec<AgentMessage>`（trait 签名 owned）。捕获必须在前缀重写前完成，实现选了「按 id 逐条 find」。

#### 影响量化（静态分析）

| D（丢弃条数） | N（会话长） | find 比较次数 | 值克隆 |
| ------------- | ----------- | ------------- | ------ |
| 50 | 500 | 2.5×10⁴ | 50 条消息 |
| 200 | 1000 | 2×10⁵ | 200 条（可含大 ToolResult） |
| 500 | 2000 | 10⁶ | 500 条 |

叠加 H3：若丢弃段含大工具输出，#克隆 与后续 prompt 渲染各付一遍字节。

#### 修复方案

1. 引擎 `CompactionPlan` 增加 `dropped: Vec<Arc<AgentMessage>>`（与 `dropped_arcs` 同源 move，零额外扫描）；
2. 或 apply_compaction 在替换前建一次 `HashMap<&str, Arc<AgentMessage>>`（O(N)+O(D)）；
3. `PendingSummaryRetry.dropped` / `SummaryDispatchTask.dropped` 可改为 `Vec<Arc<AgentMessage>>` 以避免值拆 Arc。

#### 回归锚点

- pending_summary_retry 快照与 SummaryDispatch 入参一致性测试；
- apply_compaction 既有事件/计数/护栏测试（handlers/mod.rs）。

### C13-M3【中】compression-end 载荷 id 列表双份 + summary 全文

#### 位置

compaction_dispatch.rs:583-626（record 构造）；conex-types/src/tool.rs:483-508（结构定义）

#### 现场

```rust
// compaction_dispatch.rs:594-617（节选）
summary: plan.summary.clone(),
compressed_message_ids: plan.dropped_ids.clone(),
kept_message_ids: plan.kept_ids.clone(),
...
cache_boundary: Some(ContextCompressionCacheBoundaryMetadata {
    kind: "context-compression-cache-boundary".to_string(),
    ...
    compressed_message_ids: plan.dropped_ids.clone(),  // 第二份
    kept_message_ids: plan.kept_ids.clone(),           // 第二份
    ...
}),
```

`summary` 最长约 `max_summary_tokens`（默认 1024 token ≈ 4KB 文本）；kept/dropped id 在顶层与 cache_boundary 各存一份 `Vec<String>`。

#### 调用链

```
apply_compaction → ContextCompressionEnd emit
  → events 轨序列化 + live IPC
  → orchestrator 落库（宽 payload 行）
  → persist_compression_block 读 record 字段写块行
```

#### 根因

T-31 缓存边界元数据按「自包含快照」设计，重复携带 id 列表以便 cache 审计独立消费——未做存储/序列化层共享。

#### 影响量化（静态分析）

- N_kept=400、N_dropped=80、id 均 20 字节：仅 id 列表 ≈ 2×(400+80)×22B ≈ 21KB，其中一半为冗余；
- 叠加 summary 4KB + details + policy：单事件 25KB+ 量级；
- 03 已标低频——单次可接受，但宽行加重 05-Q1 类扫描与 restore 页内存。

#### 修复方案

1. 序列化层共享：`cache_boundary` 与 record 指向同一 `Arc<Vec<String>>`，serde 只写一次（或 boundary 只存 hash/count）；
2. 契约评审：cache 审计是否真需要全量 id，还是 `stable_prefix_hash + first_kept + counts` 足够；
3. 保持事件类型不变（R-H 字段级扩展纪律）。

#### 回归锚点

event_hook_mapping、events_schema_version、orchestrator persist_compression_block 字段读取测试。

### C13-M4【中】溢出 shape 修复二次完整 compact（可能二次 LLM）

- **位置**：stream_error_recover.rs:178-205
- **现场**：`compaction_shape_ok` 失败时用更紧 `keep_recent_tokens` **再跑一遍** `compact_agent_messages_with_stub_policy`（含 summarize）。
- **根因**：形状修复在 plan 产出后做，无法只调整 cut 而不重走摘要。
- **影响**：最坏 2× 同步 LLM（叠加 H1：单次溢出恢复可阻塞 2×60s）；第二次若仍 stub 语义相同则摘要内容可能不一致。
- **修复**：shape 修复只重算 cut + 复用已生成 summary（或失败则放弃并 fatal）；或将两次尝试纳入同一「摘要预算」。
- **回归**：stream_error_tests_ladder / e2 形状护栏用例。

### C13-M5【中】emergency_preflight 公共入口二次 compact

- **位置**：engine.rs:622-661
- **现场**：先完整 `compact_agent_messages_with_stub_policy`（含 LLM），若 `tokens_after > budget` 再 `apply_emergency_preflight`；`apply_emergency_preflight` 内部不再调 LLM（好），但公共入口若被外部用于「再压一次」语义，第一次已付 LLM。
- **影响**：当前主路径已通过引擎内嵌 emergency（engine.rs:452-462）覆盖；公共入口多付一次完整 compact 的风险在误用面。静态分析。
- **修复**：文档标注「仅测试/外围」；或拆分为 `compact_once` + `force_emergency` 两 API。
- **回归**：emergency 相关引擎测试。

### C13-M6【中】noop / 放弃路径仍全量 tokens 扫描

- **位置**：plan.rs:109-113（noop_plan 再 sum）；engine.rs:289-292（入口先 sum 再判 empty/cut）
- **现场**：空输入 early-return 前已 sum；无 cut 时 noop_plan 再 sum 一遍填 tokens_before/after。
- **影响**：放弃路径多付 1–2 遍全扫；长对话频繁触发「该压但压不了」时（LLM 不可用 + LlmRequired）浪费放大。
- **修复**：入口 sum 结果传入 noop_plan；empty 时直接零值返回不 sum。
- **回归**：noop/llm_blocked 计划字段断言。

### C13-M7【中】restore 全量事件扫描中做压缩护栏重放

#### 位置

orchestrator/src/restore_manager.rs:250-283（分页拉取 + 过滤循环）

#### 现场

```rust
// restore_manager.rs:254-267（分页拉全量）
loop {
    let page = store
        .query_events(&session.session_id, page_after, Some(RESTORE_PAGE_SIZE))
        .await?;
    if page.is_empty() { break; }
    page_after = page.last().map(|e| e.sequence).unwrap_or(page_after);
    let exhausted = page.len() < RESTORE_PAGE_SIZE as usize;
    events.extend(page);
    if exhausted { break; }
}
// :268-282 逐条过滤
for event in &events {
    if event.event_type == SESSION_LEAF_MOVED_EVENT { ... }
    else if event.event_type == CONTEXT_COMPRESSION_END_EVENT {
        let _ = serde_json::from_str::<AgentEvent>(&event.payload).map(|e| {
            if let AgentEvent::ContextCompressionEnd { timestamp, .. } = e {
                session.apply_compression_end(event.sequence, &timestamp);
            }
        });
    }
}
```

每会话把**全部**事件（含 message-end 宽 payload）分页读入 `Vec`，再在线性扫描里反序列化压缩事件取 timestamp。

#### 调用链

```
应用启动 / 会话恢复
  → RestoreManager::restore
    → query_events 分页（500/页）全量
    → 压缩护栏重放 apply_compression_end
    → （同循环）叶子移动重放
```

#### 根因

压缩护栏（`last_compaction_at` 语义）以事件流为唯一事实源；尚未把「最新压缩边界」落到 session_meta / compression_blocks 的 O(1) 读面供 restore 直读。

#### 影响量化（静态分析）

| 会话事件数 | 页数 | 峰值内存（若均值 2KB/事件） | 压缩分支 |
| ---------- | ---- | -------------------------- | -------- |
| 1,000 | 2 | ~2MB | 全量 for 中 O(压缩次数) |
| 10,000 | 20 | ~20MB | 同上 |
| 50,000 | 100 | ~100MB | 同上 |

与 05「恢复链路读放大」同型：即使只有 1 次压缩事件，也要付全量扫描。

#### 修复方案

1. 会话恢复时读 `compression_blocks` 最新行或 `session_meta` 的压缩边界字段 → O(1) 应用护栏；
2. 事件扫描保留作一致性校验（可选、异步、失败仅 warn）；
3. 若必须扫事件：按 event_type 窄查询（需索引，与 M8 一并）。

#### 回归锚点

restore 快照/增量续接测试；`apply_compression_end` 语义测试；crash_consistency 中 compression-end 相关用例。

### C13-M8【中】count_compression_events 无窄索引（05-Q1 交叉）

- **位置**：`crates/conex-db/src/blocks.rs:329-343`（05 报告 Q1 已述）
- **现场**：`WHERE session_id=? AND event_type='context-compression-end'` 扫会话全部事件行（含宽 payload）。
- **调用链**：compress 块写入 generation 兜底 → build_block_row → count_compression_events。
- **影响**：与 M3 宽行叠加；details 缺失的旧事件路径更常走兜底。静态分析。
- **修复**：见 05-Q1（(session_id,event_type) 索引或块表 MAX(generation)）。
- **回归**：blocks 单测 + 迁移测试。

---

## 六、低危发现（摘要）

| ID | 位置 | 要点 | 修复方向 |
| -- | ---- | ---- | -------- |
| C13-L1 | compaction_dispatch.rs:93,182,228,283 · stream_error_recover.rs:143 | 每路径 `CompactionEngine::new(0)` | 关联函数 / 单元常量 |
| C13-L2 | compaction_dispatch.rs:106-115 | tools 三字段 clone 再装 Value | 预计算串（并入 H2） |
| C13-L3 | cut_point.rs:48-67 | 闭包循环每轮重建 HashSet | 循环外复用 + clear |
| C13-L4 | plan.rs:181-197 | truncate_summary 逐字符 pop | 二分 / 按字节预算截断 |
| C13-L5 | 多触发点 | 各自 engine/info/estimate，无 turn 级编排对象 | 与 H2 缓存一并收口 |
| C13-L6 | engine.rs:353 · plan.rs:70-72 | generation 恒 1 占位 | 会话代数注入（既有 V2 计划） |

---

## 七、正面发现（禁止回潮）

1. **tokens_after 增量推导（1C-9）**：engine.rs:441-448——result 不再二次全量 count；同类优化应扩展到 before/cut（M1）。
2. **usage 优先 + 尾随补算**：thresholds.rs:181-197——命中时 O(尾随)；时间戳护栏正确作废旧 usage。
3. **后台摘要全链路纪律**：spawn_blocking + 墙钟 + 退避 jitter + 单飞 + 窗口护栏（summary_dispatch.rs）——**同步路径应对齐此模式（H1）**。
4. **C14 摘要缓存隔离**：无 system/tools/缓存断点/亲和键（engine_channels.rs:73-84）——摘要请求不污染主对话 KV 缓存。
5. **ProviderSummarizer 线程模型**：专用线程 + 独立 runtime，避免嵌套 block_on panic（engine_channels.rs:86-93）——线程模型正确，缺的是调用侧非阻塞化。
6. **折叠链与 tool 闭包不变量**：fold_start 下界、双向闭包、cut≤fold_start 放弃（cut_point.rs）——宁可不压不破语义。
7. **防死循环计数**：预检/边界共享 run 上限；溢出自有 retries + keep 阶梯（compaction_dispatch.rs:693-703 · stream_error_recover.rs:24-31）。
8. **Arc 消息共享**：对话替换与 result 组装以 Arc 浅拷贝为主；system/链过滤 O(cut)。
9. **stub 中性句柄永不改写（R-C）**：避免链文本反复重写带来的前缀漂移。
10. **工具快照 run 内锁定**：ensure_tools_snapshot 幂等，保证请求前缀字节稳定（streaming.rs:464-475）——H2 修复应把 JSON 缓存挂到同一生命周期。

---

## 八、随规模恶化矩阵

| 恶化轴 | 命中问题 | 说明 |
| ------ | -------- | ---- |
| 丢弃段工具输出字节 B | H3, M2, M4 | 提示词/克隆/HTTP body 线性放大；同步阻塞时间上升 |
| 对话消息数 M | H2, M1, M2, M6, M7 | 每 turn 估算×3；压缩扫描×k；恢复全量事件 |
| 工具数量 / schema 体积 T | H2, L2 | tools_prefix 每 estimate 重建 |
| 并发会话数 S | H1 | S 个同步摘要可同时占 S 个 tokio worker |
| 压缩事件宽度 | M3, M7, M8 | IPC/DB 行宽；恢复与 count 扫描变贵 |
| 溢出重试次数 | H1, M4 | 最坏 2×同步 LLM |

---

## 九、修复路线图

> 批次字母接 07 报告 S–V、10 报告 Q–U 之后从 **W** 起；问题同权，批次内无业务优先级排序，批次间仅表示依赖/性价比备注。

### 批次 W —— 同步摘要非阻塞化（对齐 H1 + M4）

1. 抽取 `summarize_blocking_spawn(summarizer, dropped, existing, wall_ms)` 共享 helper（与 summary_dispatch::summarize_once 同源）。
2. compact_with_llm_guard / compression_ladder 改经 helper 调用；超时/失败降级语义不变（LlmRequired / StubAllowed 按现策略）。
3. 溢出 shape 修复禁止第二次 summarize（复用 summary 或放弃）。
4. 回归：abort 延迟单测 + 既有压缩事件集成测试。

### 批次 X —— estimate 缓存与 tools 前缀预计算（H2 + L1 + L2 + L5）

1. tools_prefix_json 随 snapshot 预计算。
2. turn 级 estimate 缓存（失效：conversation 变更 / last_compaction_at / budget 变更）。
3. boundary 与 preflight 共享一次估算。
4. 回归：04-K1/V8 场景计数断言。

### 批次 Y —— 工具输出截断接线与提示词预算（H3 + 与 10 交叉）

1. conversation 工具结果路径接 G8 truncate_tool_output（留痕事件）。
2. build_summarize_prompt 单消息与总长预算。
3. dropped 借 Arc 减少值克隆（与 M2 一并）。
4. 回归：G8 单测 + 摘要 prompt 长度断言。

### 批次 Z —— 压缩内部扫描合并与 noop 减负（M1 + M6 + L3 + L4）

1. counts 单遍注入 find_cut_point。
2. noop_plan 复用入口 sum。
3. 闭 HashSet 复用；truncate_summary 按字节二分。

### 批次 AA —— 事件载荷与恢复捷径（M3 + M7 + M8）

1. cache_boundary 与 record 共享 id 列表存储/序列化去重（契约评审）。
2. restore 压缩护栏改读 session_meta / compression_blocks。
3. (session_id, event_type) 索引或块表 generation 单源（对齐 05-Q1）。

### 批次 AB —— 结构收口（M2 + M5 + L6）

1. CompactionPlan 携带 dropped Arc 列表，消灭 O(D×N)。
2. emergency_preflight API 边界文档/拆分。
3. generation 会话代数注入（既有 V2 路线）。

**性价比备注**：X（estimate 缓存）与 W（同步摘要非阻塞）改动面清晰、无契约破坏，可先行；Y 与方向 10 输出预算同批评审更顺；AA 需 03/05 契约协同。

---

## 十、与既往方向交叉引用

| 对象 | 关系 |
| ---- | ---- |
| **04-K1** | 本方向确认 estimate 每请求 O(N)；补充 tools_prefix 无缓存、boundary+preflight 双调用常态、引擎重复新建。修复并入批次 X。 |
| **04-S6** | 同 turn ≤3 次 estimate——本方向以 prepare_turn/streaming 源码坐实三调用点。 |
| **03 事件表** | context-compression-* 低频宽载荷；本方向补充 cache_boundary 双份 id 列表（M3）。 |
| **05-Q1** | count_compression_events 无索引——块表 generation 兜底与恢复路径的读放大（M8）。 |
| **05 恢复读放大** | restore_manager 分页全量事件中重放压缩护栏（M7）。 |
| **10 工具输出** | shell 200KB / output_budget_bytes 在工具返回层；G8 在压缩/wire 层未接线（H3）——两层互补，不互相替代。 |
| **02/01 前端** | 压缩事件注入对话时间线的 UI 成本不在本方向展开；stub 消息体积极小（正面）。 |

---

## 十一、运行时验证建议（静态分析 → 待回填）

| ID | 场景 | 指标 | 关联 |
| -- | ---- | ---- | ---- |
| V1 | 长对话（≥300 消息）跨过 85% 阈值后发消息 | 用户可感延迟（发送→首 token）；是否包含完整摘要 RTT | H1 |
| V2 | 注入慢 Summarizer（2s）时按取消 | abort 生效延迟 | H1 |
| V3 | 30 工具会话 × 20 turn | tools_prefix_json 耗时与分配（每 estimate） | H2 |
| V4 | 500 消息无 usage 前缀 | estimate_context 耗时 × 每 turn 调用次数 | H2 |
| V5 | 丢弃段含 5×200KB ToolResult 触发压缩 | 提示词字节数、HTTP body 大小、摘要成功率、峰值 RSS | H3 |
| V6 | G8 接线后同 V5 | 提示词是否收敛到预算内 | H3 |
| V7 | 压缩一次完整过程 | tokens 扫描次数（计数插桩）、CPU 时间、分配字节 | M1 |
| V8 | 两会话同时触发预检压缩 | tokio worker 占用、第三会话事件延迟 | H1 |
| V9 | 含 20 次压缩事件的会话冷启动恢复 | restore 耗时中压缩重放占比 | M7 |
| V10 | compression-end 事件 | 序列化字节数分布（kept_ids 贡献） | M3 |

验证通道：按总纲纪律走 **4000 Tauri MCP** / 生产包内 tracing 埋点；禁止 9222 CDP。

---

## 十二、压缩前后消息列表拷贝与大上下文序列化（专项）

> 任务书点名的「压缩前后消息列表拷贝、大上下文序列化」在此集中展开，避免散落各发现。

### 12.1 压缩执行期拷贝清单（单次真实压缩）

| # | 拷贝点 | 形态 | 量级 |
| - | ------ | ---- | ---- |
| 1 | tokens_before 扫描 | 只读遍历，无拷贝 | O(M) CPU |
| 2 | find_cut_point counts | `Vec<usize>` 长度 M | 8B×M |
| 3 | dropped_arcs | `Vec<Arc<AgentMessage>>` 浅克隆 | O(D) 指针 |
| 4 | dropped_tokens | 只读遍历 | O(D) CPU |
| 5 | dropped_ids | String 克隆 ×D | id 长度×D |
| 6 | **dropped_slice** | **`Vec<AgentMessage>` 值克隆（深拷 blocks）** | **正文+工具输出字节** |
| 7 | build_summarize_prompt | 渲染 String 全量拼接 | ≈丢弃段文本字节 |
| 8 | HTTP body | serde 序列化 prompt | ≈同上 |
| 9 | summary 校验/渲染 | JSON parse + md String | ≤ max_summary_tokens×4 字节 |
| 10 | result 组装 | Arc 浅克隆 system/链/保留段 | O(N−D) 指针 |
| 11 | 新摘要消息 | Arc::new 新 AgentMessage | summary 字节 |
| 12 | tokens_after | 增量，无全量拷贝 | O(1) |
| 13 | emergency（可选） | header sum + 保留段 ToolResult 重建 | 视截断量 |
| 14 | apply_compaction 对话替换 | `plan.messages.clone()` Arc Vec | O(N) 指针 |
| 15 | dropped_for_retry | 值克隆 ×D + O(D×N) find | 见 M2 |
| 16 | ContextCompressionEnd | record 全量序列化 → events + IPC | 见 M3 |
| 17 | cache_tracker capture_post_compaction | 全量签名哈希（压缩后强制全量） | O(N) 哈希 |

**峰值内存关注点**：#6+#7+#8 在最坏场景（丢弃段含大量工具输出）可同时驻留 ≈3×丢弃段字节；叠加 H1 同步阻塞期间无法被 GC 触发回收的压力（仍可达 Drop，但分配尖峰真实存在）。

### 12.2 与 wire 序列化的边界

- 压缩后下一次 `build_request` 以 `&state.conversation`（Arc 列表）为源——压缩本身不直接产生 provider wire 拷贝，但 conversation 替换后 cache_tracker 强制全量重算签名（cache_tracker.rs:209-211，正确性优先，性能可接受）。
- `ContextCompressionRecord` 进入 `AgentEvent::ContextCompressionEnd` 后经 emit 轨（events Vec + live sink）与 SQLite append——与 03 双轨结构一致；压缩事件无「双发」问题（单次广播），但载荷宽（M3）。
- 旧 `Message` 面 `CompactionEngine::compact`（engine.rs:33-143）仍保留 `messages.to_vec()` 全量克隆，但主路径已迁移 AgentMessage 面；旧面仅 `core_compact_messages` IPC 兼容——低频，不列高危。

### 12.3 恢复期序列化

- restore：`query_events` 返回 `PersistedEvent { payload: String }`——压缩事件 payload 为完整 AgentEvent JSON；`from_str` 再 parse 一次只取 timestamp（restore_manager.rs:277-281）。同一页内非压缩事件 payload 也被完整读入内存。
- 块表：`insert_block` 携带 summary 全文 + dropped_message_ids（Vec 序列化进列）——与事件双写（blocks.rs:32-55 有意为之：索引面 + 事件原文）。

---

## 十三、摘要结果持久化与重放（专项）

### 13.1 写路径

```
同步成功（summary_is_llm）
  → apply_compaction 织入 details.summaryState="committed"
  → ContextCompressionEnd 落库
  → drive_outcome → persist_compression_block（INSERT OR IGNORE）
同步失败（stub）
  → details.summaryState="awaiting"
  → 块行 awaiting
  → SummaryDispatch/Coordinator 后台成功
      → update_compression_block_summary（state=committed + summary_json）
```

接线位置：orchestrator/blocks.rs:36-55（落库后写块）、:70-90（后台推进）；session-loop 侧调度 summary_dispatch.rs / summary_coordinator.rs。

### 13.2 重放路径

| 路径 | 行为 | 成本 |
| ---- | ---- | ---- |
| restore 事件扫描 | 全量事件 + compression-end 分支 apply_compression_end | M7 |
| 块表不重写 | restore 不重建 compression_blocks（注释明确） | 正面 |
| generation 兜底 | count_compression_events 扫事件 | M8 |
| 前端/工具 decompress | slot_text 指向 decompress_context(blockId) | 工具面，非本方向展开 |

### 13.3 持久化性能评价（静态）

- 同步路径一次事件 + 一次块行：与 turn 级事件写相比低频，可接受。
- 后台推进 `get_block` + `update_block_state`：单行主锁短持有（05 口径），可接受。
- 主要风险不在写放大，而在 **restore 为更新护栏而全量扫描**（M7）与 **count 兜底无索引**（M8）——修复应让「压缩状态」有 O(1) 读源（session_meta 或块表 MAX），事件扫描只作审计。

---

## 十四、低危发现详述

### C13-L1【低】CompactionEngine::new 每调用点新建

- **位置**：compaction_dispatch.rs:93,182,228,283；stream_error_recover.rs:143
- **现场**：`let engine = CompactionEngine::new(0);` 出现在 estimate、preflight、boundary、guard、overflow 五处；引擎仅持有 `max_tokens: usize` 且 AgentMessage 面主路径不用该字段（budget_tokens 由调用方传入）。
- **调用链**：各触发函数入口。
- **根因**：旧 Message 面构造习惯迁移到新面。
- **影响**：栈上一次 usize 构造，可忽略；与 H2「无共享编排对象」同根。
- **修复**：`CompactionEngine::estimate(...)` 关联函数，或 `const ENGINE: CompactionEngine` 若无状态。
- **回归**：无行为变化；编译期保证。

### C13-L2【低】tools_prefix_json 三字段 clone

- **位置**：compaction_dispatch.rs:106-115
- **现场**：对每个 ToolSchema `name.clone() + description.clone() + input_schema.clone()` 装入 `json!` 宏再序列化。
- **影响**：并入 H2 后消失；单独存在时每次 estimate 多 3K 次 String 分配（K=工具数）。
- **修复**：`serde_json::to_string` 直接对借用结构，或预计算缓存（H2）。
- **回归**：tools 前缀参与启发式估算的单测。

### C13-L3【低】enforce_tool_batch_closure 每轮重建 HashSet

- **位置**：cut_point.rs:48-67
- **现场**：`loop { let mut declared_call_ids = HashSet::new(); ... }`——向前/向后闭包触发时 `continue` 重新分配两个 HashSet 并全段重扫。
- **影响**：正常对话闭包 1 轮通过；异常配对时多轮。轮数通常 ≤ 孤儿批次数，有界但常数差。
- **修复**：HashSet 在循环外 `clear()` 复用；或单遍扫描记录 call/result 索引表。
- **回归**：cut_point 全部闭包测试。

### C13-L4【低】truncate_summary 逐字符 pop

- **位置**：plan.rs:181-197
- **现场**：`while count_tokens(&truncated) > content_budget && !truncated.is_empty() { truncated.pop(); }`——每次 pop 后全串再 count_tokens，最坏 O(chars²)。
- **影响**：仅当摘要超 max_summary_tokens（1024）时触发；LLM 正常输出受 max_tokens=1024 约束，触发面窄。异常超长时最坏 ~4k 字符 × 4k 扫描。
- **修复**：按 `content_budget*4` 字节一次 take 后单次 count 微调；或二分字符数。
- **回归**：truncate_summary 单测（若有）与 stub 长度断言。

### C13-L5【低】多路径无共享估算/编排快照

- **位置**：compaction_dispatch.rs 各 fn · stream_error_recover.rs
- **现场**：boundary 与 preflight 各自 estimate；溢出路径完全绕过 estimate 直接 compact；无 turn 级 CompactionOrchestrator 对象。
- **影响**：与 H2/M1 同根；单独不构成热点。
- **修复**：批次 X/Z 收口时一并引入 turn 级编排上下文（estimate + counts + engine 单点）。
- **回归**：触发条件矩阵测试（handlers/mod.rs 压缩相关测试组）。

### C13-L6【低】generation 恒 1 占位

- **位置**：engine.rs:345-353；plan.rs:70-72；注释指向 SessionContextMeta.last_compaction_generation（V2）
- **现场**：`let generation: u32 = 1;`——R-K 单源尚未注入引擎。
- **影响**：非性能主路径；多次压缩后 details.generation 与块表 count 兜底可能出现短暂语义分叉（有 details 时 details 优先）。正确性债登记。
- **修复**：按既有 V2 路线从会话代数注入。
- **回归**：blocks.rs generation 兜底测试 + session-loop details 织入测试。

---

## 十五、执行记录与方法边界

- **走读范围**：conex-compaction 12 个源文件全量（lib/engine/cut_point/thresholds/tokens/plan/ai_summary/summary_document/recovery/tool_output/clean_output/template）；compaction_dispatch.rs 全量 791 行；prepare_turn / streaming clamp / stream_error_recover / summary_dispatch 关键段；ProviderSummarizer（engine_channels.rs:98-256）；orchestrator blocks + restore_manager 压缩分支；conex-db blocks 计数；与 03/04/05/10 报告交叉。
- **未做**：cargo bench / 真实 LLM 调用 / Tauri MCP 运行时采样（见 §十一）；前端压缩事件 UI 渲染成本（归 01/02）；decompress_context 工具读路径细节（归 10/工具面）。
- **未改代码**：本方向为审查报告，零生产文件变更；禁止 git commit（按任务书）。
- **效果锁声明**：
  1. H1 修复若采用「预检仅 stub + 后台补摘要」变体，须显式裁决摘要空窗期语义，不得静默削弱 E2「禁止纯丢弃」与 R-F 语义；
  2. H3 的 G8 接线不得改变「原文落库/事件 raw、仅注入与摘要面截断」的既有分层（tool_output.rs:11-12）；
  3. 任何 estimate 缓存不得绕过 `last_compaction_at` 时间戳护栏与 steering 注入失效点。

---

## 十六、总结表（验收用）

| 项 | 值 |
| -- | -- |
| 发现总数 | 17（高 3 / 中 8 / 低 6） |
| 正面发现 | 10 |
| TOP3 高危 | ① C13-H1 同步 LLM 摘要阻塞 async loop ② C13-H2 estimate×3 + tools JSON 无缓存 ③ C13-H3 摘要提示词零预算 + G8 未接线 |
| 路线图批次 | W–AB（7 批） |
| 运行时 V 项 | V1–V10 待回填 |
| 素材 | `materials/13-compaction走读素材.md` |
| 一句话结论 | 算法面健康，编排面在「同步 LLM、重复估算、无预算提示词」三点上把压缩变成了长会话的延迟与内存尖峰源；对齐后台 spawn_blocking 纪律 + estimate 缓存 + G8 接线即可显著收敛。 |

### 16.1 交付物清单

| 路径 | 说明 |
| ---- | ---- |
| `docs/performance-audit/13-Compaction与上下文压缩审查报告.md` | 本报告（主交付） |
| `docs/performance-audit/materials/13-compaction走读素材.md` | 原始走读摘录与命令命中 |

### 16.2 汇报摘要（供主控粘贴）

- **路径**：`docs/performance-audit/13-Compaction与上下文压缩审查报告.md` + `materials/13-compaction走读素材.md`
- **发现计数**：17 项（高 3 / 中 8 / 低 6）+ 正面 10 + 运行时 V1–V10
- **一句话结论**：压缩算法面健康，但同步 LLM 摘要阻塞、每 turn 多次无缓存估算、摘要提示词零预算三个编排层问题，使压缩在长会话/大工具输出下成为延迟与内存尖峰源。
- **TOP3 高危**：
  1. **C13-H1** 预检/边界/溢出路径同步 `summarize` 阻塞 async run loop（最坏 60–90s），与后台 `spawn_blocking` 纪律双标；
  2. **C13-H2** `estimate_context` 每 turn ≤3 次且 `tools_prefix_json` 无缓存全量序列化（04-K1 深挖）；
  3. **C13-H3** `build_summarize_prompt` 对丢弃段工具输出零预算，G8 截断未接线到正常工具结果路径。
