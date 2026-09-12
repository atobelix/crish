# 13 · Compaction 与上下文压缩扫描素材（原始走读摘录）

> 战役：性能审查 · 方向 13 · Compaction 与上下文压缩
> 方法：静态代码走读（read + rg）；未实测处统一标注「静态分析，待运行时验证」
> 范围锁：conex-compaction 全量 / session-loop compaction_dispatch + context-compression-* 事件 / 触发阈值 / 摘要阻塞 / 持久化与重放 / 拷贝与序列化 / 与 04-K1、03 事件 payload、05 读路径交叉

## 一、扫描命令与命中摘要

### 1.1 模块清单

```
crates/conex-compaction/src/
  lib.rs engine.rs cut_point.rs thresholds.rs tokens.rs
  plan.rs ai_summary.rs summary_document.rs recovery.rs
  tool_output.rs clean_output.rs template.rs
crates/session-loop/src/loop/compaction_dispatch.rs (791 行)
crates/session-loop/src/loop/summary_dispatch.rs / summary_coordinator.rs
crates/session-loop/src/loop/handlers/{prepare_turn,streaming,stream_error_recover}.rs
apps/agent-workbench/src-tauri/src/engine_channels.rs (ProviderSummarizer)
crates/orchestrator/src/{blocks.rs,restore_manager.rs}
```

### 1.2 同步/阻塞面

- `Summarizer::summarize`：同步 trait（plan.rs:81-85）。
- 生产实现 `ProviderSummarizer::summarize`：专用 std 线程 + current_thread runtime + `rx.recv_timeout(90s)`（engine_channels.rs:147-213）——HTTP 不嵌套调用方 runtime，但**调用方线程仍阻塞等待**。
- 预检/边界/溢出路径在 async run loop 内直接调用 `compact_agent_messages_with_stub_policy` → `summarizer.summarize`（同步）。
- 后台路径 `summarize_once` 正确使用 `tokio::task::spawn_blocking`（summary_dispatch.rs:780-793）。
- `drive_run_loop` 经 `tauri::async_runtime::spawn`（run_launch.rs:912）——共享 tokio 多线程 runtime。

### 1.3 estimate_context 调用点（04-K1 交叉）

- `maybe_compact_user_boundary`（compaction_dispatch.rs:226）— prepare_turn 有 hold 时
- `maybe_compact_preflight`（compaction_dispatch.rs:180）— prepare_turn 步骤 5
- `clamp_request_max_tokens`（streaming.rs:440）— 每 build_request
- 每次调用：`tools_prefix_json` 全量克隆+序列化工具 schema（compaction_dispatch.rs:104-116）+ `estimate_context_tokens` 双源扫描（engine.rs:163-171 / thresholds.rs:125-218）

### 1.4 压缩执行内部扫描（compact_agent_messages_with_stub_policy）

| 步骤 | 位置 | 扫描/拷贝 |
| ---- | ---- | ---- |
| tokens_before | engine.rs:289-292 | 全量 count_agent_message_tokens |
| find_cut_point_inner | cut_point.rs:147-150 | 再全量 counts Vec |
| enforce_tool_batch_closure | cut_point.rs:40-126 | 保留段扫描，循环可重入 |
| dropped_arcs | engine.rs:310-316 | Arc 浅克隆 + filter |
| dropped_tokens | engine.rs:323-326 | 对 dropped 再扫 |
| existing / chain_count | engine.rs:332-354 | messages[..cut] 两遍 |
| dropped_slice | engine.rs:363 | **全量 AgentMessage 值克隆** |
| summarize | engine.rs:371 | 同步 LLM（见 1.2） |
| build_summarize_prompt | ai_summary.rs:81-117 | 全量渲染丢弃段为 String |
| tokens_after | engine.rs:447-448 | 增量（1C-9 正面） |
| emergency（可选） | engine.rs:452-461, 493-617 | header+全量 sum+可能重建保留段+再全量 sum |

### 1.5 事件与持久化

- Start/End 广播：compaction_dispatch.rs:427-434, 628-634
- Record 载荷：summary 全文 + compressed_message_ids + kept_message_ids + cache_boundary（**再一份** id 列表）+ details（tool.rs:483-508）
- 落库后写 compression_blocks：orchestrator/blocks.rs:36-55
- restore：分页拉全量事件后逐条找 context-compression-end（restore_manager.rs:252-283）
- count_compression_events：无 (session_id, event_type) 索引（05 Q1 交叉，conex-db blocks.rs:329-343）

## 二、关键代码现场

### 2.1 同步摘要阻塞链（H1 证据链）

```
// prepare_turn.rs:127
maybe_compact_preflight(state).await;

// compaction_dispatch.rs:284-290
let plan = engine.compact_agent_messages_with_stub_policy(
    &state.conversation, budget_tokens as usize, policy,
    state.compaction.summarizer.as_deref(), stub_policy,
);

// engine.rs:370-371
let (summary, summary_is_llm, llm_unavailable) = if let Some(summarizer) = summarizer {
    match summarizer.summarize(&dropped_slice, existing.as_deref()) {

// engine_channels.rs:205-210（调用方阻塞点）
let inner = rx.recv_timeout(SUMMARY_HTTP_RECV_TIMEOUT).map_err(|_| { ... })?;
```

对比后台正确路径：

```
// summary_dispatch.rs:786-788
let call = tokio::task::spawn_blocking(move || summarizer.summarize(&dropped, existing.as_deref()));
match tokio::time::timeout(Duration::from_millis(max_wall_ms), call).await {
```

### 2.2 tools_prefix_json 每调用重建（H2 证据）

```
// compaction_dispatch.rs:104-116
fn tools_prefix_json(state: &LoopState) -> Option<String> {
    let tools = state.tools_snapshot.as_deref()?;
    let value: Vec<serde_json::Value> = tools.iter().map(|t| {
        serde_json::json!({
            "name": t.name.clone(),
            "description": t.description.clone(),
            "input_schema": t.input_schema.clone(),
        })
    }).collect();
    serde_json::to_string(&value).ok()
}
```

tools_snapshot run 内锁定（streaming.rs:464-475 幂等），但 JSON 串未随快照缓存——每 estimate 重建。

### 2.3 摘要提示词无预算（H3 证据）

```
// ai_summary.rs:45-66 render_message_text — 工具结果全量拼入
AgentMessageBlock::ToolResult { tool_name, output, is_error, .. } => {
    let mut body = String::new();
    if let Some(text) = &output.text { body.push_str(text); }
    if let Some(json) = &output.json { body.push_str(&json.to_string()); }
    ...
}

// engine.rs:363
let dropped_slice: Vec<AgentMessage> = dropped_arcs.iter().map(|m| (**m).clone()).collect();
```

truncate_tool_output 仅在 emergency preflight（engine.rs:561-579）使用；tool_output.rs 模块注释声明的「工具结果记录路径接线」在 session-loop/agent-tools 中**未找到生产调用**（agent-tools 有独立 shell 200KB clamp 与 output_budget_bytes，与 G8 head+tail 语义不同）。

### 2.4 apply_compaction O(D×N) 捕获（M2 证据）

```
// compaction_dispatch.rs:408-418
let dropped_for_retry: Vec<AgentMessage> = plan.dropped_ids.iter()
    .filter_map(|id| {
        state.conversation.iter().find(|m| &m.id == id).map(|m| (**m).clone())
    }).collect();
```

每个 dropped_id 线性扫 conversation，再值克隆整条消息（含全部 blocks）。

### 2.5 事件载荷双份 id 列表（M3 证据）

```
// compaction_dispatch.rs:583-626
let record = ContextCompressionRecord {
    compressed_message_ids: plan.dropped_ids.clone(),
    kept_message_ids: plan.kept_ids.clone(),
    cache_boundary: Some(ContextCompressionCacheBoundaryMetadata {
        compressed_message_ids: plan.dropped_ids.clone(),
        kept_message_ids: plan.kept_ids.clone(),
        ...
    }),
    ...
};
```

03 报告已登记：「context-compression-* | 持久 | summary + 5 个 string[]（KB–数十 KB），低频」（03:78）。

### 2.6 溢出阶梯二次 compact（M4 证据）

```
// stream_error_recover.rs:192-198
let tighter_plan = engine.compact_agent_messages_with_stub_policy(
    &state.conversation, budget_tokens as usize, &tighter_policy,
    state.compaction.summarizer.as_deref(), stub_policy,
);
```

shape 违规时对同一对话再跑一遍完整 compact（含第二次同步 summarize）。

### 2.7 恢复重放成本（M7 证据）

```
// restore_manager.rs:254-283
loop {
    let page = store.query_events(&session.session_id, page_after, Some(RESTORE_PAGE_SIZE)).await?;
    ...
    events.extend(page);
}
for event in &events {
    ...
    } else if event.event_type == CONTEXT_COMPRESSION_END_EVENT {
        let _ = serde_json::from_str::<AgentEvent>(&event.payload).map(|e| { ... });
    }
}
```

每会话全量事件分页进内存后逐条反序列化找压缩事件；与 05 恢复链路读放大交叉。

## 三、正面发现（走读确认）

1. tokens_after 增量推导（engine.rs:441-448，1C-9）避免 result 二次全量 count。
2. usage 优先估算命中时只扫尾随消息（thresholds.rs:188-197）。
3. 后台摘要：spawn_blocking + 60s 墙钟 + 1/3/9s 退避 + 单飞 + 8 次/30min 窗口护栏（summary_dispatch.rs）。
4. C14 摘要请求缓存隔离：无 system/tools/缓存断点/亲和键（engine_channels.rs:73-84）。
5. ProviderSummarizer 专用线程 + 独立 runtime，避免嵌套 runtime panic（engine_channels.rs:86-93）。
6. 折叠链 B1/B2 不变量 + tool 配对闭包保护语义正确（cut_point.rs）。
7. max_auto_compactions_per_run 与 overflow 自有计数防死循环（compaction_dispatch.rs:693-703）。
8. Arc<AgentMessage> 共享：对话替换与 result 组装以 Arc 浅克隆为主。
9. 溢出 keep_recent 阶梯 20K→12K→8K 机制化（stream_error_recover.rs:31,136-140）。
10. 工具快照 run 内锁定（ensure_tools_snapshot 幂等）。

## 四、交叉引用登记

| 交叉对象 | 条目 | 关系 |
| -------- | ---- | ---- |
| 04-K1 | estimate_context O(N) + tools 重序列化 | 本方向深挖确认并扩展 tools_prefix 无缓存、每 turn ≤3 次 |
| 04-S6 | 同 turn 多次 estimate | 本方向确认 boundary+preflight+clamp 三调用点 |
| 03 事件表 | context-compression 载荷 | 本方向补充 cache_boundary 双份 id 列表 |
| 05-Q1 | count_compression_events 无索引 | 块表 generation 兜底路径的读放大 |
| 05 恢复读放大 | restore 分页全量事件 | 压缩护栏重放随全量扫描完成 |
| 10 工具输出预算 | shell 200KB / output_budget_bytes | 与 G8 tool_output 截断语义不同、未接线到 compact 提示词 |

## 五、未覆盖 / 待运行时

- 真实 LLM 摘要延迟分布（P50/P99）与阻塞 worker 时长。
- 500+ 消息对话 estimate 耗时、压缩一次 CPU/分配。
- 多会话并发压缩时 tokio worker 饥饿。
- compression-end 事件实际序列化体积分布。
- restore 大事件会话的压缩重放占比。
