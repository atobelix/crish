# F2 Rust 定稿保序 — 施工报告

日期：2026-11-05（EST 晚间）。范围：`crates/session-loop` 引擎侧定稿路径（嫌疑 S4）。
纪律执行：改前备份至 PC `C:\Users\Administrator\AppData\Local\Temp\muse-backup-20261105-fix-f2\`（6 个原文件）；分段编辑、推后逐文件回拉 diff 校验一致；未提交、未 push、未部署；未碰桌面 TS 与移动端文件。

## 结论

每轮定稿消息的 `blocks` 现在由 consume 阶段按**事件到达序**维护的保序段序列直接承载，[thought → 本轮全文一块 → tool-call] 的归拢组装已整体删除。分桶聚合（全文 String / tool_calls Vec）保留，但只供响应分类、metadata 标注与 provider 历史拼装，与定稿呈现正式分工、不再共用组装路径。协议形状（`ProviderOutput`、`AgentMessage`/`AgentMessageBlock`）零改动，无 shared-types 生成物需要再生成。定向自检 `cargo test -p session-loop`（orange 主体）全绿：669 passed / 0 failed。

## 逐项对账

### 1. 定稿保序（主项）

**`crates/session-loop/src/stream/aggregate.rs`**
- `Aggregate` 新增字段 `segments: Vec<AgentMessageBlock>`，与分桶字段并行维护；结构体注释写明分工（分桶 = 分类/metadata/平坦消费，segments = 定稿 blocks 唯一真源）。
- `Aggregate::push` 三臂改造：
  - `TextDelta`：在拼全文的同时并入尾部正文段，尾段非正文则新开一段（段边界独立于网络分块粒度；空增量不建段）。
  - `ThoughtDelta`：并入尾部思考段，**仅 redacted 取值相同才合并**（redacted 边界保留）；`thought_blocks` 的逐 delta 记录保持原样（metadata 口径不变）。
  - `ToolCall`：id 合成完成后，同一 `ToolCallBlock` 克隆一份进 segments，落在事件到达位置。
- `finish` / `finish_after_abort` 五处 `ConsumeResult` 构造：Message 结果携带 `segments: aggregate.segments`；Empty / StreamError 结果恒 `Vec::new()`。

**`crates/session-loop/src/stream/events.rs`**
- `ConsumeResult` 新增 `segments: Vec<AgentMessageBlock>` 字段，带 `#[serde(default, skip_serializing_if = "Vec::is_empty")]`（旧序列化数据可读、空段不落盘）；字段注释声明其为定稿 blocks 唯一真源、禁止按类型归拢重组。

**`crates/session-loop/src/loop/handlers/streaming.rs`**
- `build_assistant_message` 重写：签名删除 `text: String`、`tool_calls: Vec<ToolCallBlock>` 两个形参，blocks 直接取 `consumed.segments.clone()`；函数注释改写为保序口径并记录旧组装的删除原因。唯一生产调用点 `consume_classify` 同步改参，match 绑定改为 `ProviderOutput::Message { tool_calls, .. }`（tool_calls 仍供 has_tool_calls / 派发计数 / 中断合成，未受影响）。
- **删除清单**（按用户删除令，不留兼容）：
  - 从 `metadata["thoughtBlocks"]` 反解析回建 thought 块的整段代码；
  - `metadata["thought"]` 兜底回建 thought 块的分支；
  - [thought 块 → 全文一块 → tool-call 块] 的归拢组装逻辑及「按规格归拢」的文档注释；
  - streaming.rs 中随之无用的 `ToolCallBlock` 导入（测试文件改为显式导入）。

注：收口轨 message-delta（`emit_message_deltas`）由定稿 blocks 逐块派生，定稿保序后收口轨与实时轨逐块同序——集成测试已钉死此等式（见下）。

### 2. 连带面排查（直消费定稿 blocks 的消费方）

全仓 git grep 排查结论：**无任何生产消费方假设「text 恒为一块 / 恒在工具之前」**。

- `metadata["thoughtBlocks"]` 的消费方只有原 `build_assistant_message`（已删该用法）与 agent-provider 的测试；metadata 本身仍按原口径产出（逐 delta），标注用途不受影响。
- `crates/session-loop/src/hydrate/blocks.rs::synthesize_assistant_blocks`：旧行（无 blocks_json）回退合成仍是 [Text, Thought, ToolCalls] 归拢形态——这是**旧数据回退路径**，旧行只有平坦字段、没有交错真值可恢复，不属于定稿路径，**保留并在此登记**；正常行走 `resolve_assistant_blocks` 直读 blocks_json，保序透传。
- `crates/agent-provider` 有一套平行的 consume 实现——经核查它**不是** workbench 的定稿路径（定稿走 session-loop 的 consume），本批未动。其请求构建侧：`build_anthropic/messages.rs` 逐块按序转换（Text→text、Thought→thinking/redacted 透传、ToolCall→tool_use），天然保序；chat 系构建把 text+tool_calls 按协议拼装，属「provider 历史可以聚合」的正当侧。登记：若将来 agent-provider 独立产定稿消息，需按同一口径改造其 aggregate。
- `AgentMessage::text()` / `thought()` / `tool_calls()` 均为跨块 join/迭代型消费（润色、压缩、steering 判定在用），与块序无关。
- 全仓 `blocks.first()/last()/[0]` 命中仅测试夹具与 agent-tools 笔记域的同名异物，无关。

### 3. 类型与生成物

- blocks 本就是 `Vec<AgentMessageBlock>` 保序结构，`ProviderOutput` 形状未动——**无需改协议形状、无 shared-types 改动、无生成 parser 再生成事项**。
- `cargo test -p conex-types`：本批未触碰 conex-types，按任务书口径由收口统一跑（铁律项已在此点名登记，不冒充已跑）。

### 4. 测试

**新增**
- `crates/session-loop/src/stream/tests/ordering.rs`（新文件，tests/mod.rs 已注册 `mod ordering;`），4 测：
  - `segments_preserve_interleaved_event_order`：思考→正文→工具→正文→思考→工具→总结，断言 segments 逐段同序 + response 平坦聚合口径不变（全文拼接、工具到达序、stopReason）；
  - `consecutive_deltas_coalesce_and_redacted_boundary_splits`：连续增量合段 + redacted 边界分段；
  - `segments_empty_for_empty_and_error_outcomes`：Empty / StreamError 不带段；
  - `aborted_partial_stream_keeps_segment_order`：中止打捞的部分定稿仍保序。
- `crates/session-loop/src/loop/handlers/streaming/tests.rs` 新增 `build_assistant_message_preserves_interleaved_segment_order`：handler 层断言定稿 blocks 与交错事件序逐段一致、多段思考各自成块。

**口径变更（点名登记，钉旧归拢序的既有测试）**
- `crates/session-loop/tests/streaming_incremental_contract.rs::realtime_sink_receives_deltas_and_collected_sequence_stays_intact`：原断言收口 delta 为「thought 块 + 整段正文块（2 条）」——改后定稿 blocks 为 [正文「你」, 思考, 正文「好」] 3 块，收口 delta 3 条（positions 序列与 ids 计数 6→7 同步更新），并**加强**断言：收口轨 delta 块序列与实时轨逐块同序同内容。
- 同文件 `abort_during_thought_salvages_partial_thought`：原按逐 delta 成块断言 2 个 Thought 块——新口径下连续未脱敏思考合为 1 段（内容拼接不变，`thought()` 断言原样），已更新并在测试内注明口径变更原因。

**核查未受影响**（未改动且实测通过）：`thought_blocks_retained_when_redacted_is_none`、`pure_thought_stream_commits_assistant_message`、`mixed_thought_and_text_abort_salvages_both`、stream 层 `thought_and_errors`（钉的是 metadata.thoughtBlocks 逐 delta 口径，未变）、`stop_and_abort`、`metadata_cache`、streaming handler 分类/防火墙诸测。

## 自检结果

- 方式：计划任务以 orange 交互主体在 PC 执行 `cargo test -p session-loop`（日志 `C:\Users\Public\muse-f2\test.log`，任务已注销）。
- 首轮：新写的 ordering 测试有 2 处 API 误用编译错误（`ProviderOutput::tool_calls()` 不存在、`ProviderStreamEvent::error` 非本 crate 构造器），属自检捕获的自身测试代码问题，已修正重跑——非生产代码问题。
- 次轮全绿：lib 571 passed；各集成测试二进制 4+2+10+6+4+8+1+3+47+12+1，合计 **669 passed / 0 failed**（另 1 个二进制 4 ignored 为既有）；无新增编译警告。新增 5 测与口径变更 2 测均在通过名单内点名可见。

## 遗留风险

1. 本批只修 S4 源头（Rust 定稿）。桌面实时路径的乱序在 F1 范围（reconciler 补偿与流式台账）；**已落盘乱序的存量会话**需按 events 追加日志重放重建 blocks（O1 已证真值完好），属 P3 存量修复，不在本批。
2. 段合并口径变化：定稿块数不再等于 delta 条数，收口轨 message-delta 条数随段数走；前端按块消费（F1 按多块设计），收口联调时留意双轨条数对账口径。
3. hydrate 旧行回退的归拢形态（上文已登记）与 agent-provider 平行 consume（已登记）是全仓仅剩的两处「归拢」形态，均不在定稿路径上；前者无真值可恢复，后者若转正定稿需同口径改造。
4. 改动未提交未推送，按纪律由收口统一落地（同一收口流含引擎/中继部署）。
