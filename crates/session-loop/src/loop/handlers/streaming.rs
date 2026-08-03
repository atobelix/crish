//! handleStreaming（01 §2.4）
//!
//! 触发：streaming。
//! 行为顺序：
//!   1. 安全点检查（L3 force_cancel 可立即打断 / L2 / L1）；
//!   2. 构建 ProviderRequest（对话 + 工具定义 + max_tokens 透传）；
//!   3. 调用 provider（trait 解耦；传输层错误已分类上抛）；
//!   4. 消费聚合（复用本 crate 的 consume 等价层，01 D5/D6：模型输出与
//!      传输错误分离）；diagnostics → provider-diagnostic 事件；
//!   5. 响应分类（01 §2.4 步骤 5）：
//!      - StreamError（传输层）→ 分类重试阶梯（handleStreamError）；
//!      - 流中 abort（信号已置位）→ 安全点 ABORT 收场（aborted，内容保留）；
//!      - Empty → STEERING_NEEDED；
//!      - Message → commitAssistantMessage（落对话 + message-end）→
//!        tool-call → HAS_TOOL_CALLS，无 tool-call → handleNoToolCalls；
//!   6. 安全点（stream 结束且消息已落盘，不丢本轮输出，01 §2.4 步骤 6）；
//!   7. 分类分派（01 §2.4 步骤 7）。

use conex_types::events::AgentEvent;
use conex_types::message::{AgentMessage, AgentMessageBlock, AgentMessageRole, ToolCallBlock};
use conex_types::response::ProviderOutput;
use conex_types::session::AgentSessionEvent as E;
use futures::StreamExt;
use std::sync::Arc;

use crate::provider::{DeltaSink, ProviderCall, ProviderRequest, ToolSchema};
use crate::stream::{ConsumeBuilder, ConsumeResult, ConsumeStopReason, ProviderStreamEvent, StopReason};

use super::super::end::EndDecision;
use super::super::handlers::{
    check_control, dispatch, new_message_id, HandlerOutcome, LoopState,
};
use super::super::LoopError;
use super::{no_tool_calls, stream_error};

/// streaming handler（01 §2.4）
pub(crate) async fn handle(
    state: &mut LoopState,
    provider: &dyn ProviderCall,
    delta_sink: Option<&dyn DeltaSink>,
) -> Result<HandlerOutcome, LoopError> {
    // 1. 安全点检查（handler 起始：force_cancel 可立即打断，01 §2.4 步骤 3）
    if let Some(end) = check_control(state)? {
        return Ok(HandlerOutcome::end(end));
    }

    // 2-3. 构建请求并调用 provider（传输层错误已分类，走 retry 阶梯）
    // P1：build_request 前先确保工具快照已构建（借用顺序：先可变借用
    // ensure_tools_snapshot，再不可变借用 build_request——工具循环轮次间
    // 复用同一快照，保证 tools 前缀字节稳定）
    ensure_tools_snapshot(state);
    let request = build_request(state);
    // T09.1 双轨：预生成 assistant 消息 id——实时 delta 与最终收口消息共用
    // 同一 id，保证 message-delta / message-start / message-end 的
    // message_id 对齐（前端按 messageId 累加）
    let assistant_message_id = new_message_id("assistant");
    let result = provider.stream(&request).await;

    // 4. 增量消费（T09.1：逐事件边收边聚合 + delta 实时双轨发射）
    // 契约 v1（PE-02 §3.1）：流前 Err = 未产出任何事件（进重试阶梯）；
    // 流中 Err = 已产出内容 → 内容保留收场（不重试，01 D6），未产出 → 重试阶梯。
    let mut builder = ConsumeBuilder::new();
    let mut stream_error: Option<conex_types::response::ClassifiedStreamError> = None;
    // Q21（T09.9）：流中 abort 竞速标记——流式消费期间 abort 置位即停收
    // （语义：abort 优先于后续事件消费，partial salvage 判定输入）
    let mut aborted = false;
    match result {
        Ok(mut stream) => {
            // Q21（T09.9）：流式消费竞速——`stream.next()` 与 abort 监听
            // future 并置，abort 触发即停收并丢弃流（取消挂起的读取）：
            // 及时中断而非等流结束 / 传输层超时（AA-01 Q21 流式消费侧
            // 竞速语义，对齐 sse reader 的 biased abort 优先）
            loop {
                let item = tokio::select! {
                    biased;
                    _ = state.abort_signal.wait_aborted() => {
                        aborted = true;
                        break;
                    }
                    item = stream.next() => item,
                };
                let Some(item) = item else { break };
                // abort 与事件同时就绪时 abort 优先（对齐 sse reader 的
                // biased 语义）：abort 已置位则丢弃本条目，不消费 abort
                // 时刻之后的内容
                if state.abort_signal.is_aborted() {
                    aborted = true;
                    break;
                }
                match item {
                    Ok(event) => {
                        // 实时轨（T09.1 双轨）：text-delta / thought-delta
                        // 到达即发射（信封 sequence=None；丢帧类目 Delta——
                        // 丢帧不丢 message-end，03 §5.3-6）
                        if let Some(sink) = delta_sink {
                            if let Some(delta) =
                                delta_to_message_event(state, &assistant_message_id, &event)
                            {
                                sink.push(delta);
                            }
                        }
                        builder.push(event);
                    }
                    Err(classified) => {
                        if builder.is_empty() {
                            stream_error = Some(classified);
                        } else {
                            // 已产出内容 → 以 error-stop 收尾，consume 侧按
                            // Message 处理（内容保留，providerError 标注）
                            builder.push(ProviderStreamEvent::Stop {
                                reason: StopReason::Error,
                                error: Some(classified.message),
                                usage: None,
                            });
                        }
                        break;
                    }
                }
            }
        }
        Err(classified) => stream_error = Some(classified),
    }
    // Q33（T09.9）：流结束后重读 abort 信号——覆盖「流结束瞬间触发 abort」
    // 的竞速窗口（consume 前最后一次读取，AA-01 Q33 标注一致性）
    if !aborted && state.abort_signal.is_aborted() {
        aborted = true;
    }
    if let Some(classified) = stream_error {
        // 流前/流中无内容错误（未产出任何事件）：流中 abort → aborted 收场；
        // 否则进入分类重试阶梯（瞬态 / length / payload，01 §2.5）；
        // 重试入口自身的 abort 复查由 stream_error::handle 承担（Q40）
        if aborted {
            return streaming_aborted(state);
        }
        return stream_error::handle(state, classified).await;
    }
    let mut consumed = builder.finish(aborted);
    // Q33（T09.9）：consume 完成后重读 abort——consume 期间触发的 abort
    // 补标注（partial salvage 标注一致性：已 commit 消息带 aborted 标注，
    // 与正常终态区分）
    if !aborted && state.abort_signal.is_aborted() {
        consumed = crate::stream::reannotate_aborted(consumed);
        aborted = true;
    }

    // 4b. diagnostics → provider-diagnostic 事件（01 §2.4 步骤 4）
    emit_diagnostics(state, &consumed);

    // 5. 响应分类（01 §2.4 步骤 5）
    match &consumed.response {
        ProviderOutput::Message { text, tool_calls } => {
            // commitAssistantMessage：落对话 + message-end（01 §2.4 步骤 5）
            // clientMessageId 取 run-task 下发的 assistantClientMessageId
            // （经 SessionLoopOptions 透传，03 §5.3-4）
            let message = build_assistant_message(
                &consumed,
                &assistant_message_id,
                text.clone(),
                tool_calls.clone(),
                state.options.assistant_client_message_id.as_deref(),
            );
            // 收口轨（T09.1 双轨）：message-start → message-delta* →
            // message-end（01 §五.6 序列契约；实时轨已单独发射，此处保证
            // 收口序列完整——供持久化与序列记账，事件桥不再重发
            // message-delta，避免与实时 delta 双发）
            commit_message_with_deltas(state, message);

            if aborted || consumed.stop_reason() == Some(ConsumeStopReason::Aborted) {
                // abort 后 partial salvage：消息已 commit（stopReason=aborted
                // 标注）→ ABORT 收场，内容保留（01 §2.4 步骤 5 / 01 §五.9）
                return streaming_aborted(state);
            }

            // 6. 安全点（stream 结束且消息已落盘，不丢本轮输出，01 §2.4 步骤 6）
            if let Some(end) = check_control(state)? {
                return Ok(HandlerOutcome::end(end));
            }

            // 7. 分类分派（01 §2.4 步骤 7）
            if tool_calls.is_empty() {
                no_tool_calls::handle(state, consumed.stop_reason()).await
            } else {
                dispatch(state, E::HasToolCalls { count: tool_calls.len() as u32 })?;
                Ok(HandlerOutcome::continue_run())
            }
        }
        ProviderOutput::Empty => {
            // T06.2.1（Q03）：steering 禁用时 empty-response 不可恢复——
            // 直接 stop + 诊断收场，不进 steering-evaluation（避免注入循环）
            if !state.options.steering_enabled {
                return Ok(HandlerOutcome::end(EndDecision::stop_with_diagnostic(
                    state,
                    "steering 已禁用，空响应无法恢复",
                )));
            }
            // 空响应 → STEERING_NEEDED（01 §2.4 步骤 5）
            dispatch(state, E::SteeringNeeded)?;
            Ok(HandlerOutcome::continue_run())
        }
        ProviderOutput::StreamError { classified } => {
            // 流内 error stop 且无内容（consume 兜底分类）：进入分类重试阶梯；
            // 流中 abort 则直接 aborted 收场（无内容可抢救）
            if aborted {
                return streaming_aborted(state);
            }
            stream_error::handle(state, classified.clone()).await
        }
    }
}

/// abort 收场路径（endStreamingAborted 等价，01 §2.4 步骤 5）
///
/// 已 commit 的内容保留（partial salvage，01 §五.9）；AbortSignal 已置位
/// 等价 L3 强停 → ABORT 收场（aborted）。cooperative_stop 不 abort：
/// D1 驱动正常收场（stopped）。
///
/// T09.9 Q40：stream_error 重试阶梯入口的 abort 收场复用本路径
/// （「与正常收场共享决策路径」——收场决策单一化，不另起分支）。
pub(crate) fn streaming_aborted(state: &mut LoopState) -> Result<HandlerOutcome, LoopError> {
    let action = {
        let mut bus = state.control_bus.lock().unwrap_or_else(|e| e.into_inner());
        crate::safe_point::apply_safe_point_control(&mut bus, Some(&state.abort_signal))
    };
    match action {
        Some(crate::safe_point::ControlAction::ForceCancel { reason }) => {
            // T06.3 Q02：取消原因经 aborted_with_diagnostic 透出
            // （不再写 state.abort_reason，该字段已删除）
            dispatch(state, E::Abort)?;
            Ok(HandlerOutcome::end(EndDecision::aborted_with_diagnostic(
                state,
                reason,
            )))
        }
        Some(crate::safe_point::ControlAction::CooperativeStop { pending_messages, .. }) => {
            for message in pending_messages {
                state.input_queue.enqueue_steer(message);
            }
            // D1：协作停止推 SM 到 done、不 abort（stopped 收场）
            dispatch(state, E::NoToolCalls)?;
            dispatch(state, E::ShouldStop)?;
            Ok(HandlerOutcome::end(EndDecision::stopped(state)))
        }
        _ => {
            // 防御性兜底：aborted=true 时 apply_safe_point_control 必为
            // ForceCancel，其余情形按 ABORT 收场
            dispatch(state, E::Abort)?;
            Ok(HandlerOutcome::end(EndDecision::aborted(state)))
        }
    }
}

/// 构建 ProviderRequest（01 §2.4 步骤 1：对话 + 工具 + max_tokens 透传）
///
/// 冻结签名下消息字段为借用形态（`&'a [AgentMessage]`），直接借用
/// `state.conversation`（provider 调用期间对话不被修改，01 §2.4 步骤 5
/// 才 commit 新消息）。
///
/// P1：调用前必须已执行 [ensure_tools_snapshot]（快照锁定）；tools 经
/// 快照克隆填充 [ProviderRequest]（8 个内置工具，克隆成本可忽略；
/// [ProviderRequest.tools] 冻结为 owned 形态，AU-04 F1 契约不变）。
/// system_prompt 经 `as_deref()` 透传（P1 阶段 2 通路第三层），与 messages
/// 同生命周期（`'a` 借用期，实现方在返回流前完成序列化）。
/// session_id 暂填 None（P2 步骤 4a 契约字段，C5 合并登记）；会话 ID 的注入
/// 接线（engine.rs 适配层 / SessionLoopOptions 透传）归 T-17（P2 步骤 4b）。
fn build_request(state: &LoopState) -> ProviderRequest<'_> {
    ProviderRequest {
        messages: &state.conversation,
        tools: tools_schema(state).to_vec(),
        max_tokens: Some(state.max_tokens),
        system_prompt: state.options.system_prompt.as_deref(),
        session_id: None,
    }
}

/// 工具定义导出（P1：快照锁定——首次构建后缓存，不再每轮从注册表重建）
///
/// 注册表 run 内不可变（engine 级只读 `Arc<ToolRegistry>`，无运行时注册
/// 路径），快照生命周期天然 = run 生命周期；工具循环轮次间复用同一快照
/// 保证请求前缀字节稳定（对齐 jcode `locked_tools` / codex 固定流水线）。
fn tools_schema(state: &LoopState) -> &[ToolSchema] {
    state
        .tools_snapshot
        .as_deref()
        .expect("build_request 前必须已构建工具快照（ensure_tools_snapshot）")
}

/// 构建工具快照（run 内一次；入口：streaming handler 首次 build_request 前）
///
/// 幂等：快照已存在时直接返回（不重建、不覆盖——锁定语义）；清理时机：
/// run 收口不需要清理——每 run 重建 LoopState（engine 每 run new），测试
/// 路径跨 run 复用同一 loop 时快照仍有效（注册表未变），语义正确。
/// length 阶梯升级不影响 tools，快照无需重建。
fn ensure_tools_snapshot(state: &mut LoopState) {
    if state.tools_snapshot.is_none() {
        state.tools_snapshot = Some(
            state
                .tool_registry
                .list_definitions()
                .iter()
                .map(ToolSchema::from_definition)
                .collect(),
        );
    }
}

/// 诊断事件透出（01 §2.4 步骤 4：provider-diagnostic）
fn emit_diagnostics(state: &mut LoopState, consumed: &ConsumeResult) {
    let session_id = state.machine.context().session_id.clone();
    for diagnostic in &consumed.diagnostics {
        state.events.push(AgentEvent::ProviderDiagnostic {
            session_id: session_id.clone(),
            timestamp: crate::steering::now_iso_utc(),
            diagnostic: diagnostic.clone(),
        });
    }
}

/// 构建 assistant 消息（thought 块 → 正文块 → tool-call 块，01 §2.4 步骤 5）
///
/// `message_id` 为 T09.1 预生成 id（与实时 delta 共用，保证 message-delta /
/// message-start / message-end 的 message_id 对齐）。
/// metadata 透传 consume 聚合结果（stopReason / thought / usage /
/// providerError / aborted，01 D6：错误只作标注不决定收场）。
/// clientMessageId 透传 run-task 下发值（03 §5.3-4：message-end 稳定幂等键，
/// None = 不标注，向后兼容）。
fn build_assistant_message(
    consumed: &ConsumeResult,
    message_id: &str,
    text: String,
    tool_calls: Vec<ToolCallBlock>,
    client_message_id: Option<&str>,
) -> AgentMessage {
    let mut blocks: Vec<AgentMessageBlock> = Vec::new();
    // thought 块（metadata.thoughtBlocks，redacted 透传，02 §一.4）
    if let Some(blocks_value) = consumed.metadata.get("thoughtBlocks").and_then(|v| v.as_array()) {
        for block in blocks_value {
            if let (Some(text), Some(redacted)) = (
                block.get("text").and_then(|v| v.as_str()),
                block.get("redacted").and_then(|v| v.as_bool()),
            ) {
                blocks.push(AgentMessageBlock::Thought {
                    text: text.to_string(),
                    redacted: Some(redacted),
                });
            }
        }
    }
    if !text.is_empty() {
        blocks.push(AgentMessageBlock::Text { text });
    }
    for call in tool_calls {
        blocks.push(AgentMessageBlock::ToolCall(call));
    }
    AgentMessage {
        id: message_id.to_string(),
        role: AgentMessageRole::Assistant,
        created_at: crate::steering::now_iso_utc(),
        blocks,
        metadata: if consumed.metadata.is_null() {
            None
        } else {
            Some(consumed.metadata.clone())
        },
        client_message_id: client_message_id.map(str::to_string),
        content: None,
    }
}

/// 收口轨消息提交（T09.1 双轨）：message-start → message-delta* →
/// message-end（01 §五.6 序列契约）
///
/// 与 [record_message]（awaiting_input 的用户消息路径）的区别：消息定型后
/// 在 start 与 end 之间插入收口 message-delta（逐正文/思考块）——收口序列
/// 完整，供持久化与序列记账；实时轨（[DeltaSink]）已单独发射，事件桥不再
/// 重发 message-delta（避免双发）。
///
/// PE-09 T09.3.2：`Arc::new` 一次后对话与 start/end 事件共享同一份消息
/// 内存（0 深克隆；wire 逐字节不变）。
///
/// P1 不变量（append-only）：本函数是会话内 4 个追加点之一（assistant
/// 收口路径）——只允许把新消息**追加到对话尾部**；改写既有消息破坏请求
/// 前缀字节稳定性；压缩是唯一例外（P4 闸门）。
fn commit_message_with_deltas(state: &mut LoopState, message: AgentMessage) {
    let session_id = state.machine.context().session_id.clone();
    let message = Arc::new(message);
    state
        .events
        .push(AgentEvent::MessageStart { session_id: session_id.clone(), message: message.clone() });
    emit_message_deltas(state, &message);
    state.conversation.push(message.clone());
    state.events.push(AgentEvent::MessageEnd { session_id, message });
}

/// 实时轨 delta 事件构造（T09.1 双轨）：text-delta / thought-delta →
/// [AgentEvent::MessageDelta]；其余事件（ToolCall / ProviderDiagnostic /
/// Stop）不进实时轨——仍走收口批量 emit（增量通道只承载 delta，PE-09 §0.3
/// 契约点 2）
fn delta_to_message_event(
    state: &LoopState,
    message_id: &str,
    event: &ProviderStreamEvent,
) -> Option<AgentEvent> {
    let block = match event {
        ProviderStreamEvent::TextDelta { text } => AgentMessageBlock::Text {
            text: text.clone(),
        },
        ProviderStreamEvent::ThoughtDelta { text, redacted } => AgentMessageBlock::Thought {
            text: text.clone(),
            redacted: *redacted,
        },
        _ => return None,
    };
    Some(AgentEvent::MessageDelta {
        session_id: state.machine.context().session_id.clone(),
        timestamp: crate::steering::now_iso_utc(),
        message_id: message_id.to_string(),
        block,
    })
}

/// 收口 message-delta 构建（T09.1 收口轨：逐正文/思考块；start/end 由
/// [commit_message_with_deltas] 成对夹持，01 §五.6 序列契约）
fn emit_message_deltas(state: &mut LoopState, message: &AgentMessage) {
    let session_id = state.machine.context().session_id.clone();
    for block in &message.blocks {
        if matches!(block, AgentMessageBlock::Text { .. } | AgentMessageBlock::Thought { .. }) {
            state.events.push(AgentEvent::MessageDelta {
                session_id: session_id.clone(),
                timestamp: crate::steering::now_iso_utc(),
                message_id: message.id.clone(),
                block: block.clone(),
            });
        }
    }
}
