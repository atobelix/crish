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

use conex_types::error::codes;
use conex_types::events::{AgentEvent, TurnUsage};
use conex_types::message::{
    AgentMessage, AgentMessageBlock, AgentMessageMetadataKind, AgentMessageRole, ToolCallBlock,
};
use conex_types::response::{ClassifiedStreamError, ProviderOutput};
use conex_types::session::AgentSessionEvent as E;
use futures::StreamExt;
use std::sync::Arc;

use crate::provider::{DeltaSink, ProviderCall, ProviderEventStream, ProviderRequest, ToolSchema};
use crate::steering::metadata_kind_wire;
use crate::stream::{
    ConsumeBuilder, ConsumeResult, ConsumeStopReason, ProviderStreamEvent, StopReason,
};

use super::super::end::EndDecision;
use super::super::handlers::{
    check_control, clamp_max_tokens, dispatch, emit_missing_turn_end, estimate_context,
    last_assistant_with_tool_calls, new_message_id, synthesize_and_record_interrupted_calls,
    HandlerOutcome, LoopState,
};
use super::super::LoopError;
use super::{no_tool_calls, stream_error};

/// 工具在派发执行前因流式以错误截断终止而被阻断（BC02-2 防火墙）
pub(crate) const TOOL_STREAM_ERROR_BEFORE_DISPATCH: &str = "tool.stream_error_before_dispatch";

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
    // P5 S2 / T-36：请求发送前捕获缓存审计签名（P5 §3.4.1「BEFORE sending」；
    // tools 取 P1 排序后快照的克隆（与 build_request 的 tools 同源）、system
    // 取透传后非 None 值、messages 取对话投影；剔除 created_at / metadata——
    // 只读哈希，不改请求字节）
    let tools = tools_schema(state).to_vec();
    let system = state.options.assembly.system_prompt.clone();
    if let Some(tracker) = &mut state.compaction.cache_tracker {
        tracker.capture_signature(system.as_deref(), &tools, &state.conversation);
    }
    // EV-11（D-03 EV-13）：provider 请求锚点（Delta 可丢）——请求发出
    // 时刻捕获 + 发射；支撑「provider 请求总等待 / 首字节延迟」可测
    // （turn-start 是会话循环侧时间，请求构造 / 排队 / 连接无锚点，
    // 09 §4.1 缺口）。request 携带 &LoopState 整体不可变借用，期间无法
    // &mut state 推事件（E0502 字段级拆分不可达——借用经生命周期参数
    // 绑定到整体），故时点取在 stream 调用前一刻、发射紧跟调用返回后
    // （request 最后使用点 = stream 调用，NLL 允许此后 &mut state；
    // 消费循环尚未开始，锚点必然先于任何 message-delta）。
    let request = build_request(state);
    let request_started_at_ms = conex_shared::time::unix_millis() as u64;
    let result = provider.stream(&request).await;
    emit_provider_request_anchored(state, request_started_at_ms);
    // T09.1 双轨：预生成 assistant 消息 id——实时 delta 与最终收口消息共用
    // 同一 id，保证 message-delta / message-start / message-end 的
    // message_id 对齐（前端按 messageId 累加）
    let assistant_message_id = new_message_id("assistant");

    // 4. 增量消费（T09.1：逐事件边收边聚合 + delta 实时双轨发射）＋
    //    消费后分类（diagnostics / usage / 响应分类分派，01 §2.4 步骤 4-7）。
    //    契约 v1（PE-02 §3.1）：流前 Err = 未产出任何事件（进重试阶梯）；
    //    流中 Err = 已产出内容 → 内容保留收场（不重试，01 D6），未产出 → 重试阶梯。
    let outcome = consume_stream(state, delta_sink, &assistant_message_id, result).await;
    // 流前/流中无内容错误（未产出任何事件）：流中 abort → aborted 收场；
    // 否则进入分类重试阶梯（瞬态 / length / payload，01 §2.5）；
    // 重试入口自身的 abort 复查由 stream_error::handle 承担（Q40）
    if let Some(classified) = outcome.stream_error {
        if outcome.aborted {
            return streaming_aborted(state);
        }
        return stream_error::handle(state, classified).await;
    }
    let consumed = outcome
        .consumed
        .expect("consume_stream：无流错误时必有收口结果");
    consume_classify(state, &consumed, &assistant_message_id, outcome.aborted).await
}

/// 流消费收束状态（[consume_stream] 返回）：收口结果 / abort 竞速标记 /
/// 流前或流中无内容的流错误（分类重试阶梯入口）。`consumed` 与
/// `stream_error` 互斥：有错误时无收口结果。
struct ConsumeOutcome {
    consumed: Option<ConsumeResult>,
    aborted: bool,
    stream_error: Option<conex_types::response::ClassifiedStreamError>,
}

/// 4. 增量消费（T09.1：逐事件边收边聚合 + delta 实时双轨发射；C1d 从
///    [handle] 拆出的流消费段，语义与原地逐行一致）
///
/// 契约 v1（PE-02 §3.1）：流前 Err = 未产出任何事件（进重试阶梯）；流中
/// Err = 已产出内容 → 内容保留收场（不重试，01 D6），未产出 → 重试阶梯。
async fn consume_stream(
    state: &mut LoopState,
    delta_sink: Option<&dyn DeltaSink>,
    assistant_message_id: &str,
    result: Result<ProviderEventStream, conex_types::response::ClassifiedStreamError>,
) -> ConsumeOutcome {
    let mut builder = ConsumeBuilder::new();
    let mut stream_error: Option<conex_types::response::ClassifiedStreamError> = None;
    // Q21（T09.9）：流中 abort 竞速标记——流式消费期间 abort 置位即停收
    // （语义：abort 优先于后续事件消费，partial salvage 判定输入）
    let mut aborted = false;
    match result {
        Ok(mut stream) => {
            // 3-1：session_id 在流消费入口缓存一次；热路径按帧借用，构造
            // MessageDelta 时再 to_string（事件字段契约要求 owned String）。
            let session_id = state.machine.context().session_id.clone();
            // SL-PERF-01：流消费单次基准时间戳，消除高频流式热路径每帧 now_iso_utc() 完整日历与堆分配
            let base_timestamp = conex_shared::time::now_iso_utc();
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
                        let is_stop = matches!(event, ProviderStreamEvent::Stop { .. });
                        // 实时轨（T09.1 双轨）：text-delta / thought-delta
                        // 到达即发射（信封 sequence=None；丢帧类目 Delta——
                        // 丢帧不丢 message-end，03 §5.3-6）
                        if let Some(sink) = delta_sink {
                            if let Some(delta) = delta_to_message_event(
                                &session_id,
                                assistant_message_id,
                                &base_timestamp,
                                &event,
                            ) {
                                sink.push(delta);
                            }
                        } else if let Some(sink) = &state.options.hooks.live_sink {
                            if let Some(delta) = delta_to_message_event(
                                &session_id,
                                assistant_message_id,
                                &base_timestamp,
                                &event,
                            ) {
                                sink.push_live(delta);
                            }
                        }
                        builder.push(event);
                        // BC02-6：流解析器发出 Stop 事件后即刻终结消费循环，不再盲目空转挂起等待底层 EOF 超时。
                        // 仅做非阻塞一次性探查以捕获流收口边界立即可用的信号（零挂起等待），随后立即终结。
                        if is_stop {
                            use futures::FutureExt;
                            // BC02-6：显式丢弃非阻塞探查结果（stop 后的缓冲尾帧，
                            // 消费循环随即终结，尾帧内容不再有意义）
                            drop(stream.next().now_or_never());
                            break;
                        }
                    }
                    Err(classified) => {
                        // BC02-3：只有真实正文载荷（text/thought/tool-call）才算已有内容；
                        // SseFirstByte 等网络诊断事件绝不能破坏空流判定
                        if !builder.has_salvageable_content() {
                            stream_error = Some(classified);
                        } else {
                            // 已产出正文内容 → 以 error-stop 收尾，consume 侧按
                            // Message 处理（内容保留，providerError 标注；
                            // D7 §3.7：透传 classified.kind → metadata 结构化
                            // 标注 providerErrorKind/providerErrorRetryable）
                            builder.push(ProviderStreamEvent::Stop {
                                reason: StopReason::Error,
                                error: Some(classified.message),
                                error_kind: Some(classified.kind),
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
        return ConsumeOutcome {
            consumed: None,
            aborted,
            stream_error: Some(classified),
        };
    }
    let mut consumed = builder.finish(aborted);
    // Q33（T09.9）：consume 完成后重读 abort——consume 期间触发的 abort
    // 补标注（partial salvage 标注一致性：已 commit 消息带 aborted 标注，
    // 与正常终态区分）
    if !aborted && state.abort_signal.is_aborted() {
        consumed = crate::stream::reannotate_aborted(consumed);
        aborted = true;
    }
    ConsumeOutcome {
        consumed: Some(consumed),
        aborted,
        stream_error: None,
    }
}

/// 5. 消费后分类（C1d 从 [handle] 拆出的分类段，语义与原地逐行一致）
///
/// 4b. diagnostics → provider-diagnostic（01 §2.4 步骤 4）；4c. 缓存审计
/// （P5 S2 / T-36）与每 turn usage 槽位（EV-11/D-03 EV-13）；5. 响应分类
/// 分派（01 §2.4 步骤 5-7）。abort / 空响应 / 流错误分支收场与原地一致。
async fn consume_classify(
    state: &mut LoopState,
    consumed: &ConsumeResult,
    assistant_message_id: &str,
    aborted: bool,
) -> Result<HandlerOutcome, LoopError> {
    // 4b. diagnostics → provider-diagnostic 事件（01 §2.4 步骤 4）
    emit_diagnostics(state, consumed);

    // 4c. 缓存审计（P5 S2 / T-36）：turn 后消费 usage——metadata.usage →
    // 标量面 → tracker.record_usage（run 聚合 + detectMiss 归因）；产出的
    // CacheMiss 由 T-40 按告警阈值转 cache-waste-alert 事件（本层只记录日志，
    // 不越界发事件；aborted / error 回合的实测 usage 照记，pi 语义）
    consume_cache_usage(state, consumed);
    // EV-11（D-03 EV-13）：每 turn usage 槽位——turn-complete 收口注入
    // TurnEnd.usage（六字段真值）；provider 未报告 usage（对象缺失）时
    // 保持 None（诚实留空，不猜前端估算）
    state.budget_state.turn_usage = turn_usage_from_metadata(&consumed.metadata);

    // 5. 响应分类（01 §2.4 步骤 5）
    match &consumed.response {
        ProviderOutput::Message { text, tool_calls } => {
            // commitAssistantMessage：落对话 + message-end（01 §2.4 步骤 5）
            // clientMessageId 取 run-task 下发的 assistantClientMessageId
            // （经 SessionLoopOptions 透传，03 §5.3-4）
            let message = build_assistant_message(
                consumed,
                assistant_message_id,
                text.clone(),
                tool_calls.clone(),
                state
                    .options
                    .tool_exec
                    .assistant_client_message_id
                    .as_deref(),
            );
            // 收口轨（T09.1 双轨）：message-start → message-delta* →
            // message-end（01 §五.6 序列契约；实时轨已单独发射，此处保证
            // 收口序列完整——供持久化与序列记账，事件桥不再重发
            // message-delta，避免与实时 delta 双发）
            commit_message_with_deltas(state, message);

            // Tier-1（02 §3.1.2 DEL-02/03）：commit 后中断不得裸退——
            // 携带 tool_calls 的已落盘 assistant 必须就地合成 ToolResult
            // 再退出，消除流末尾孤儿泄漏。
            let has_tool_calls = !tool_calls.is_empty();

            if aborted || consumed.stop_reason() == Some(ConsumeStopReason::Aborted) {
                // abort 后 partial salvage：消息已 commit（stopReason=aborted
                // 标注）→ ABORT 收场，内容保留（01 §2.4 步骤 5 / 01 §五.9）
                if has_tool_calls {
                    if let Some(assistant) = last_assistant_with_tool_calls(state) {
                        let assistant = assistant.clone();
                        synthesize_and_record_interrupted_calls(
                            state,
                            &assistant,
                            codes::TOOL_ABORTED_BEFORE_DISPATCH,
                            "streaming aborted by user or provider before tool execution",
                        );
                    }
                }
                return streaming_aborted(state);
            }

            // 【截断工具强隔离防火墙与 Error 终态处理（BC02-2）】
            if let Some(ConsumeStopReason::Error {
                kind,
                message,
                retryable,
            }) = consumed.stop_reason()
            {
                if has_tool_calls {
                    tracing::warn!(
                        assistant_id = %assistant_message_id,
                        tool_count = tool_calls.len(),
                        "流式以错误截断终止，物理阻断所有未决工具调用执行！"
                    );
                    if let Some(assistant) = last_assistant_with_tool_calls(state) {
                        let assistant = assistant.clone();
                        synthesize_and_record_interrupted_calls(
                            state,
                            &assistant,
                            TOOL_STREAM_ERROR_BEFORE_DISPATCH,
                            "streaming terminated with provider error; tool calls discarded to prevent partial/corrupted execution",
                        );
                    }
                    let classified = ClassifiedStreamError {
                        kind,
                        message,
                        retryable,
                        retry_after_ms: None,
                    };
                    // 物理阻断后直接以 provider_error 错误收场
                    return stream_error::fatal_provider_error(state, &classified);
                }
            }

            // 6. 安全点（stream 结束且消息已落盘，不丢本轮输出，01 §2.4 步骤 6）
            if let Some(end) = check_control(state)? {
                if has_tool_calls {
                    if let Some(assistant) = last_assistant_with_tool_calls(state) {
                        let assistant = assistant.clone();
                        synthesize_and_record_interrupted_calls(
                            state,
                            &assistant,
                            codes::TOOL_ABORTED_BEFORE_DISPATCH,
                            "run control triggered termination at stream completion",
                        );
                    }
                }
                return Ok(HandlerOutcome::end(end));
            }

            // 7. 分类分派（01 §2.4 步骤 7）
            if tool_calls.is_empty() {
                no_tool_calls::handle(state, consumed.stop_reason()).await
            } else {
                dispatch(
                    state,
                    E::HasToolCalls {
                        count: tool_calls.len() as u32,
                    },
                )?;
                Ok(HandlerOutcome::continue_run())
            }
        }
        ProviderOutput::Empty => {
            // T06.2.1（Q03）：steering 禁用时 empty-response 不可恢复——
            // 直接 stop + 诊断收场，不进 steering-evaluation（避免注入循环）
            if !state.options.hooks.steering_enabled {
                return Ok(HandlerOutcome::end(EndDecision::stop_with_diagnostic(
                    state,
                    "steering 已禁用，空响应无法恢复",
                )));
            }
            // F2-04（P2 批 6）：分类后、steering 注入前复查 abort（对齐
            // StreamError 分支）——abort 在 Q33 复查之后、本分支分派之前
            // 到达时，不得执行策略评估并把 steering 注入消息写入对话
            // （abort 后副作用）；命中直接 aborted 收场
            if aborted || state.abort_signal.is_aborted() {
                return streaming_aborted(state);
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
    // EV-08：孤儿 turn-start 兜底——abort 收场路径不经 turn_complete
    //（turn-end 正常发射点），补发闭合（current_turn_index 为 None 时
    // 幂等无操作；stream_error 阶梯复用本路径同样覆盖）
    emit_missing_turn_end(state);
    let action = {
        let mut bus = state.control_bus.lock().unwrap_or_else(|e| {
            tracing::error!(target: "session_loop", "control_bus 锁中毒，按恢复模式继续：{e}");
            e.into_inner()
        });
        crate::safe_point::apply_safe_point_control(&mut bus, Some(&state.abort_signal))
    };
    match action {
        Some(crate::safe_point::ControlAction::ForceCancel { reason }) => {
            // T06.3 Q02：取消原因经 aborted_with_diagnostic 透出
            // （不再写 state.abort_reason，该字段已删除）
            dispatch(state, E::Abort)?;
            Ok(HandlerOutcome::end(EndDecision::aborted_with_diagnostic(
                state, reason,
            )))
        }
        Some(crate::safe_point::ControlAction::CooperativeStop {
            pending_messages, ..
        }) => {
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
/// session_id 注入真实会话 ID（P2 步骤 4b 接线完成，数据源
/// `state.machine.context().session_id`，与事件面 :360/:496/:541 同源）。
/// 已注入真实值，缓存键含会话维度——engine.rs:452 消费链已就位
/// （`build_cache_policy(..., request.session_id.as_deref(), ...)`，
/// provider.rs:83-89 键来源契约）。
///
/// P4（预算钳制）：max_tokens 发请求前经 [clamp_max_tokens] 钳制
/// （window - estimate - safety，估算 = [estimate_context] 双源，
/// C9 口径 input_total）；预算未配置（None）时透传现状值，向后兼容。
fn build_request(state: &LoopState) -> ProviderRequest<'_> {
    // DEC-01 裁决：当最后一条消息是 Tool-Promise 自愈或显式设 thinking_budget 为 0 时，
    // 强制将思考档位设为 Off（thinking_budget = 0）
    let is_zero_thinking_budget = state
        .conversation
        .last()
        .and_then(|m| m.metadata.as_ref())
        .map(|meta| {
            meta.get("kind").and_then(|k| k.as_str())
                == Some(metadata_kind_wire(AgentMessageMetadataKind::ToolPromiseRecovery).as_str())
                || meta
                    .get("thinking_budget")
                    .or_else(|| meta.get("thinkingBudget"))
                    .and_then(|v| v.as_u64())
                    == Some(0)
        })
        .unwrap_or(false);

    let reasoning_effort = if is_zero_thinking_budget {
        // 零思考预算（tool-promise 自愈 / thinking_budget=0）仍强制 Off，
        // 覆盖用户档位（既有语义，I1-β 保留）
        Some(crate::provider::ReasoningEffort::Off)
    } else {
        // I1-β：非零思考预算用**用户档位**（SessionLoopOptions 装配面
        // 注入；None = 提供方默认，wire 与现状逐字节一致）
        state.options.hooks.reasoning_effort
    };

    ProviderRequest {
        messages: &state.conversation,
        tools: tools_schema(state).to_vec(),
        max_tokens: Some(clamp_request_max_tokens(state)),
        system_prompt: state.options.assembly.system_prompt.as_deref(),
        session_id: Some(state.machine.context().session_id.clone()),
        reasoning_effort,
    }
}

/// 预算钳制挂载点（P4 阶段 2-2/2-3，§3.3.2）：`state.max_tokens`
/// （length 阶梯值）经 [clamp_max_tokens] 钳到 `window - estimate - safety`；
/// 预算缺省 None = 不钳制（向后兼容现状）
fn clamp_request_max_tokens(state: &LoopState) -> u32 {
    let Some(budget) = state.budget_state.budget else {
        return state.max_tokens;
    };
    let estimate = estimate_context(state);
    clamp_max_tokens(state.max_tokens, estimate.tokens, &budget)
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

/// 构建工具快照（run 内一次；入口：streaming handler 首次 build_request 前；
/// P4 预检压缩 [crate::r#loop::handlers::maybe_compact_preflight] 复用——
/// 快照必须已构建才能折算 tools 前缀）
///
/// 幂等：快照已存在时直接返回（不重建、不覆盖——锁定语义）；清理时机：
/// run 收口不需要清理——每 run 重建 LoopState（engine 每 run new），测试
/// 路径跨 run 复用同一 loop 时快照仍有效（注册表未变），语义正确。
/// length 阶梯升级不影响 tools，快照无需重建。
pub(crate) fn ensure_tools_snapshot(state: &mut LoopState) {
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

/// provider 请求锚点发射（EV-11/D-03：请求发出点，Delta 可丢）
///
/// 载荷：request_started_at_ms（请求发出时刻，epoch 毫秒——调用方在
/// provider.stream 前一刻捕获）、model（当前模型名，经 cache_tracker
/// 装配面——未配置缓存测量时 None，契约 Option）、turn_index（当前
/// 轮次，与 turn-start 同值口径——TURN_PREPARED 递增后）。
fn emit_provider_request_anchored(state: &mut LoopState, request_started_at_ms: u64) {
    let session_id = state.machine.context().session_id.clone();
    let turn_index = state.machine.context().turn_index;
    let model = state
        .compaction
        .cache_tracker
        .as_ref()
        .map(|t| t.model().to_string());
    state.emit_event(AgentEvent::ProviderRequestAnchored {
        session_id,
        timestamp: conex_shared::time::now_iso_utc(),
        turn_index,
        model,
        request_started_at_ms,
    });
}

/// 诊断事件透出（01 §2.4 步骤 4：provider-diagnostic）
fn emit_diagnostics(state: &mut LoopState, consumed: &ConsumeResult) {
    let session_id = state.machine.context().session_id.clone();
    for diagnostic in &consumed.diagnostics {
        state.emit_event(AgentEvent::ProviderDiagnostic {
            session_id: session_id.clone(),
            timestamp: conex_shared::time::now_iso_utc(),
            diagnostic: diagnostic.clone(),
        });
    }
}

/// 每 turn usage 提取（EV-11/D-03）：`consumed.metadata.usage`（ProviderUsage
/// camelCase 六键：promptTokens/completionTokens/totalTokens/cacheReadTokens/
/// cacheWriteTokens/cacheMissTokens，consume 收口处原样写入，stream.rs:469）
/// → [TurnUsage]；usage 对象缺失 = provider 未报告 → None（诚实留空，
/// 与 TurnEnd.usage 的 Option 契约一致，旧帧缺省读 None 兼容）
fn turn_usage_from_metadata(metadata: &serde_json::Value) -> Option<TurnUsage> {
    let usage = metadata.get("usage")?.as_object()?;
    let get = |key: &str| usage.get(key).and_then(|v| v.as_u64()).unwrap_or(0);
    Some(TurnUsage {
        prompt_tokens: get("promptTokens"),
        completion_tokens: get("completionTokens"),
        total_tokens: get("totalTokens"),
        cache_read_tokens: get("cacheReadTokens"),
        cache_write_tokens: get("cacheWriteTokens"),
        cache_miss_tokens: get("cacheMissTokens"),
    })
}

/// 缓存 usage 消费（P5 S2 / T-36）：`metadata.usage`（ProviderUsage camelCase
/// 形状）→ `CacheUsageScalars`（含 completion / total 标量）→
/// `tracker.record_usage`；产出的 [CacheMiss] 只做日志观测——cache-waste-alert
/// 事件发射（阈值 + DeltaSink 实时轨）归 T-40 engine 接线。
fn consume_cache_usage(state: &mut LoopState, consumed: &ConsumeResult) {
    let Some(tracker) = &mut state.compaction.cache_tracker else {
        return;
    };
    let Some(usage) = consumed.metadata.get("usage").and_then(|v| v.as_object()) else {
        return;
    };
    let get = |key: &str| usage.get(key).and_then(|v| v.as_u64());
    let scalars = conex_telemetry::cache::CacheUsageScalars {
        prompt: get("promptTokens").unwrap_or(0),
        read: get("cacheReadTokens").unwrap_or(0),
        write: get("cacheWriteTokens").unwrap_or(0),
        miss: get("cacheMissTokens"),
        accounting: cache_accounting_kind(consumed),
    };
    let completion = get("completionTokens").unwrap_or(0);
    let total = get("totalTokens").unwrap_or(0);
    let completed_at_ms = conex_shared::time::unix_millis() as u64;
    if let Some(miss) = tracker.record_usage(scalars, completion, total, completed_at_ms) {
        tracing::debug!(
            missed_tokens = miss.missed_tokens,
            idle_ms = miss.idle_ms,
            attribution = ?miss.attribution,
            model_changed = miss.model_changed,
            "缓存 miss 审计命中（cache-waste-alert 发射归 T-40）"
        );
    }
}

/// 口径判定（C9）：与 `metadata.cacheBreakdown`（consume 收口处按有效口径
/// 派生）比对——`inputTotal == prompt` 即 Included（Excluded 系
/// `input_total = prompt + read + write`）；cacheBreakdown 缺失（无 prompt
/// 数据）时按默认 Included——两口径在无 read/write 时推导结果等价，无歧义。
fn cache_accounting_kind(consumed: &ConsumeResult) -> conex_telemetry::cache::CacheAccountingKind {
    let prompt = consumed
        .metadata
        .get("usage")
        .and_then(|u| u.get("promptTokens"))
        .and_then(|v| v.as_u64())
        .unwrap_or(0);
    let breakdown_total = consumed
        .metadata
        .get("cacheBreakdown")
        .and_then(|b| b.get("inputTotal"))
        .and_then(|v| v.as_u64());
    match breakdown_total {
        Some(total) if total == prompt => conex_telemetry::cache::CacheAccountingKind::Included,
        Some(_) => conex_telemetry::cache::CacheAccountingKind::Excluded,
        None => conex_telemetry::cache::CacheAccountingKind::Included,
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
    let mut has_thought_block = false;
    // thought 块（metadata.thoughtBlocks，redacted 透传，02 §一.4）
    if let Some(blocks_value) = consumed
        .metadata
        .get("thoughtBlocks")
        .and_then(|v| v.as_array())
    {
        for block in blocks_value {
            if let Some(text) = block.get("text").and_then(|v| v.as_str()) {
                blocks.push(AgentMessageBlock::Thought {
                    text: text.to_string(),
                    redacted: block.get("redacted").and_then(|v| v.as_bool()),
                });
                has_thought_block = true;
            }
        }
    }
    // 兜底：若 thoughtBlocks 为空或未产出 thought 块，但 metadata.thought 存在非空文本
    if !has_thought_block {
        if let Some(thought_text) = consumed.metadata.get("thought").and_then(|v| v.as_str()) {
            if !thought_text.is_empty() {
                blocks.push(AgentMessageBlock::Thought {
                    text: thought_text.to_string(),
                    redacted: None,
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
        created_at: conex_shared::time::now_iso_utc(),
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
    let start_event = AgentEvent::MessageStart {
        session_id: session_id.clone(),
        message: message.clone(),
    };
    state.emit_event(start_event);
    emit_message_deltas(state, &message);
    state.conversation.push(message.clone());
    let end_event = AgentEvent::MessageEnd {
        session_id,
        message,
        // G4 / 04 §5.2-5：assistant 收口消息带当前轮次（与 turn-start/turn-end
        // 同值——TURN_PREPARED 递增后），前端据此按 turn 分段合并
        turn_index: Some(state.machine.context().turn_index),
    };
    state.emit_event(end_event);
}

/// 实时轨 delta 事件构造（T09.1 双轨）：text-delta / thought-delta →
/// [AgentEvent::MessageDelta]；其余事件（ToolCall / ProviderDiagnostic /
/// Stop）不进实时轨——仍走收口批量 emit（增量通道只承载 delta，PE-09 §0.3
/// 契约点 2）
///
/// SL-PERF-01：timestamp 采用单次基准时间戳透传，移除高频流式热路径每帧无意义的
/// [conex_shared::time::now_iso_utc] 完整公历换算与 `format!` 堆分配。
fn delta_to_message_event(
    session_id: &str,
    message_id: &str,
    timestamp: &str,
    event: &ProviderStreamEvent,
) -> Option<AgentEvent> {
    let block = match event {
        ProviderStreamEvent::TextDelta { text } => AgentMessageBlock::Text { text: text.clone() },
        ProviderStreamEvent::ThoughtDelta { text, redacted } => AgentMessageBlock::Thought {
            text: text.clone(),
            redacted: *redacted,
        },
        _ => return None,
    };
    Some(AgentEvent::MessageDelta {
        session_id: session_id.to_string(),
        timestamp: timestamp.to_string(),
        message_id: message_id.to_string(),
        block,
    })
}

/// 收口 message-delta 构建（T09.1 收口轨：逐正文/思考块；start/end 由
/// [commit_message_with_deltas] 成对夹持，01 §五.6 序列契约）
///
/// SL-PERF-01：同条消息的收口 deltas 共享单次时间戳，避免逐块日历格式化。
fn emit_message_deltas(state: &mut LoopState, message: &AgentMessage) {
    let session_id = state.machine.context().session_id.clone();
    let timestamp = conex_shared::time::now_iso_utc();
    for block in &message.blocks {
        if matches!(
            block,
            AgentMessageBlock::Text { .. } | AgentMessageBlock::Thought { .. }
        ) {
            state.events.push(AgentEvent::MessageDelta {
                session_id: session_id.clone(),
                timestamp: timestamp.clone(),
                message_id: message.id.clone(),
                block: block.clone(),
            });
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::r#loop::SessionLoopOptions;
    use crate::steering::{
        RecoverySteeringStrategy, SteeringCoordinator, SteeringCoordinatorOptions,
    };
    use agent_tools::registry::ToolRegistry;
    use conex_types::session::AgentSessionState as S;

    fn test_state() -> LoopState {
        let steering = SteeringCoordinator::new(
            vec![Box::new(RecoverySteeringStrategy::default())],
            SteeringCoordinatorOptions::default(),
        );
        let mut state = LoopState::new(
            "s1",
            16,
            steering,
            SessionLoopOptions::default(),
            Arc::new(ToolRegistry::new()),
        );
        let _ = state
            .machine
            .dispatch(conex_types::session::AgentSessionEvent::Initialized);
        let _ = state
            .machine
            .dispatch(conex_types::session::AgentSessionEvent::InputReady);
        let _ = state
            .machine
            .dispatch(conex_types::session::AgentSessionEvent::TurnPrepared);
        state
    }

    /// BC02-2：流以 Error 终止且存在未决 tool_calls 时，严禁派发真实工具执行！
    /// 必须合成 TOOL_STREAM_ERROR_BEFORE_DISPATCH 拦截记录，并以 fatal_provider_error 收场。
    #[tokio::test]
    async fn test_error_stop_with_tool_calls_triggers_isolation_firewall() {
        let mut state = test_state();
        let tool_call = ToolCallBlock {
            id: "call_hazard_1".into(),
            tool_name: "dangerous_rm".into(),
            input: serde_json::json!({ "path": "/etc" }),
        };
        let consumed = crate::stream::consume(
            vec![
                ProviderStreamEvent::text("准备执行危险操作"),
                ProviderStreamEvent::tool_call(
                    Some("call_hazard_1".into()),
                    "dangerous_rm",
                    serde_json::json!({ "path": "/etc" }),
                ),
                ProviderStreamEvent::Stop {
                    reason: StopReason::Error,
                    error: Some("网络连接突然重置".into()),
                    error_kind: Some(conex_types::error::ProviderErrorKind::Network),
                    usage: None,
                },
            ],
            false,
        );
        assert_eq!(
            consumed.stop_reason(),
            Some(ConsumeStopReason::Error {
                kind: conex_types::error::ProviderErrorKind::Network,
                message: "网络连接突然重置".into(),
                retryable: true,
            })
        );

        let outcome = consume_classify(&mut state, &consumed, "a1", false)
            .await
            .expect("consume_classify 应处理并返回结果");

        // 验证 1：坚决以错误收场，绝不伪装为成功
        assert!(outcome.end.is_some(), "必须产生终止决策");
        assert_eq!(state.machine.state(), S::TurnComplete);

        // 验证 2：状态机绝对未进入 ExecutingTools（工具派发被物理阻断）
        assert_ne!(
            state.machine.state(),
            S::ExecutingTools,
            "严禁进入 ExecutingTools 状态！"
        );

        // 验证 3：就地合成带有 TOOL_STREAM_ERROR_BEFORE_DISPATCH 的 ToolResult
        let last_tool_msg = state
            .conversation
            .iter()
            .find(|m| m.role == AgentMessageRole::Tool)
            .expect("必须合成 Tool 角色消息");
        assert_eq!(last_tool_msg.role, AgentMessageRole::Tool);
        let metadata = last_tool_msg.metadata.as_ref().expect("必须有 metadata");
        assert_eq!(
            metadata.get("errorCode").and_then(|v| v.as_str()),
            Some(TOOL_STREAM_ERROR_BEFORE_DISPATCH),
            "错误码必须为 TOOL_STREAM_ERROR_BEFORE_DISPATCH"
        );
        if let Some(AgentMessageBlock::ToolResult {
            tool_call_id,
            is_error,
            ..
        }) = last_tool_msg.blocks.first()
        {
            assert_eq!(tool_call_id, &tool_call.id);
            assert!(is_error);
        } else {
            panic!("缺少 ToolResult 块");
        }
    }

    /// BC02-2：流以 Error 终止且无 tool_calls 时，保留正文内容并进入 TurnComplete（以便外层触发 E1 content-resume 续写）
    #[tokio::test]
    async fn test_error_stop_without_tool_calls_salvages_and_completes_turn_for_resume() {
        let mut state = test_state();
        let consumed = crate::stream::consume(
            vec![
                ProviderStreamEvent::text("吐了部分正文后断网"),
                ProviderStreamEvent::Stop {
                    reason: StopReason::Error,
                    error: Some("500 Internal Server Error".into()),
                    error_kind: Some(conex_types::error::ProviderErrorKind::ServerError),
                    usage: None,
                },
            ],
            false,
        );

        let outcome = consume_classify(&mut state, &consumed, "a1", false)
            .await
            .expect("consume_classify 应处理并返回结果");

        // 验证：无 tool_calls 时内容被部分保留，回合正常收工进入 TurnComplete（由外层触发 content-resume 续写）
        assert!(
            outcome.end.is_none(),
            "无工具调用的断流不直接 fatal 终止，而放行由外层触发续写"
        );
        assert_eq!(state.machine.state(), S::TurnComplete);
    }

    /// BC02-6：流解析器发出 Stop 事件后即刻终结消费循环，不再消费 Stop 之后的任何条目
    #[tokio::test]
    async fn test_consume_stream_breaks_immediately_on_stop() {
        let stream = futures::stream::iter(vec![
            Ok(ProviderStreamEvent::text("正文1")),
            Ok(ProviderStreamEvent::stop(StopReason::Stop)),
            Ok(ProviderStreamEvent::text(
                "Stop 之后的脏数据（绝不应被推入）",
            )),
        ]);
        let mut state = test_state();
        let outcome = consume_stream(&mut state, None, "a1", Ok(Box::pin(stream))).await;

        let consumed = outcome.consumed.expect("应成功聚合");
        assert_eq!(consumed.response.text(), "正文1");
    }
}
