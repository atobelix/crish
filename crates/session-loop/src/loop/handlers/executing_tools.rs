//! handleExecutingTools（01 §2.8）
//!
//! 行为顺序：
//!   1. abort 检查 → ABORT（安全点统一检查）；
//!   2. 取最后 assistant 消息的 tool-call blocks → executeToolBatch（批量/
//!      并行/超时/审批/失败策略，B3.5 ToolExecutor）；
//!   3. 工具结果消息 recordMessage（tool 角色，结果落盘后才进 turn-complete，
//!      01 §五.8 末）；
//!   4. 结果全非 error → resetSteeringCount（01 §3.3 ①）；
//!   5. findFatalToolError（fatalOnError 判定已排除 softDeny/timedOut/
//!      cancelled/approval_expired/user_denied，B3.5）→ runtime-error 事件 +
//!      ERROR → turn-complete（endReason=error，经 turn_complete 收敛）；
//!   6. 安全点 applySafePointControl（tool 批后，L1/L2/L3）；
//!   7. hasRunnablePending（force/steer，不消费 followUp）→ INPUT_AVAILABLE；
//!      否则 TOOLS_COMPLETE。

use conex_types::error::codes;
use conex_types::events::AgentEvent;
use conex_types::message::{AgentMessage, AgentMessageBlock, AgentMessageRole};
use conex_types::session::AgentSessionEvent as E;
use conex_types::tool::{
    ToolBatchCall, ToolBatchResult, ToolCategory, ToolConcurrency, ToolOutput,
};

use crate::safe_point::AbortSignal;
use crate::tool_events::{
    ApprovalDecision, ApprovalGate, ClassifiedToolResult, ToolBatchOptions, ToolEvent,
};
use crate::tool_exec::{ToolExecCtx, ToolExecutor};
use std::sync::Arc;

use super::super::end::EndDecision;
use super::super::handlers::{
    check_control, dispatch, last_assistant_with_tool_calls, record_message, HandlerOutcome,
    LoopState,
};
use super::super::LoopError;

/// executing-tools handler（01 §2.8）
pub(crate) async fn handle(
    state: &mut LoopState,
    executor: &ToolExecutor,
    ctx: &ToolExecCtx,
    options: &ToolBatchOptions,
    // T09.6/P8（AU-04 F9）：跨 async 边界一律 Arc 传递（审批模式并行组
    // 恢复并行；execute_batch 内部以 as_deref 单点消费）
    approval: Option<Arc<dyn ApprovalGate>>,
) -> Result<HandlerOutcome, LoopError> {
    // 1. abort / 控制意图检查（L3 强停可立即中断）
    if let Some(end) = check_control(state)? {
        return Ok(HandlerOutcome::end(end));
    }

    // 2. 取最后 assistant 消息的 tool-call blocks（01 §2.8 步骤 2）
    let Some(assistant) = last_assistant_with_tool_calls(state) else {
        // 无工具调用块却处于 executing-tools：内部不一致，防御性收敛
        return Ok(HandlerOutcome::end(EndDecision::error(
            state,
            "executing-tools 状态缺少携带工具调用的 assistant 消息",
        )));
    };
    let calls: Vec<ToolBatchCall> = assistant
        .tool_calls()
        .map(|call| ToolBatchCall {
            id: call.id.clone(),
            tool_name: call.tool_name.clone(),
            summary: format!("call {}", call.tool_name),
            input: call.input.clone(),
            // 并发/类别由注册表工具定义驱动；当前按可并行内部工具处理
            //（真实并发分区语义见 B3.5 验收与 05 §2.3）
            category: ToolCategory::Internal,
            concurrency: ToolConcurrency::Parallel,
        })
        .collect();
    if calls.is_empty() {
        return Ok(HandlerOutcome::end(EndDecision::error(
            state,
            "assistant 消息无工具调用块",
        )));
    }

    // 2b. 批量执行（B3.5：并行分区 / 超时 / 审批 / 失败策略 / abort 提前退出）
    let abort: Option<&AbortSignal> = Some(&state.abort_signal);
    let outcome = executor
        .execute_batch(&calls, ctx, approval, options, abort)
        .await;

    // 2c. 工具事件 → AgentEvent（tool-batch-start/end、tool-start/end、
    //     approval-requested、approval-resolved（超时 Expired），01 §五.6
    //     契约 + G-9 审批超时权威语义落库）
    emit_tool_events(state, &outcome.events);

    // 3. 工具结果消息 recordMessage（tool 角色；结果落盘后才进 turn-complete，
    //    01 §五.8 末）
    let all_ok = outcome.results.iter().all(|r| r.is_ok());
    for result in &outcome.results {
        record_message(state, tool_result_message(result));
    }

    // 4. 结果全非 error → resetSteeringCount（01 §2.8 步骤 4 / 01 §3.3 ①）
    if all_ok {
        state.steering.reset();
    }

    // 5. findFatalToolError（01 §2.8 步骤 6）：runtime-error + ERROR →
    //    turn-complete（endReason=error），由 turn_complete handler 收敛
    if let Some(fatal) = &outcome.fatal {
        state.terminal_error = Some(fatal.clone());
        // 错误日志（T04.3-3）：工具致命错误按类型化错误码记录（77 码
        // tool.execution_failed；run span 内携带会话/运行上下文）
        tracing::error!(
            target: "run",
            event = "runtime_error",
            error_code = %codes::TOOL_EXECUTION_FAILED,
            retryable = false,
            error = %fatal,
            "工具致命错误"
        );
        state.events.push(AgentEvent::RuntimeError {
            session_id: state.machine.context().session_id.clone(),
            timestamp: crate::steering::now_iso_utc(),
            error: format!("工具致命错误：{fatal}"),
            retryable: None,
        });
        dispatch(state, E::Error)?;
        return Ok(HandlerOutcome::continue_run());
    }

    // 6. 安全点（tool 批后，01 §2.10：L1/L2/L3）
    if let Some(end) = check_control(state)? {
        return Ok(HandlerOutcome::end(end));
    }

    // 7. hasRunnablePending（force/steer；不消费 followUp）→ INPUT_AVAILABLE；
    //    否则 TOOLS_COMPLETE（01 §2.8 步骤 7）
    if state.input_queue.has_runnable_pending() {
        dispatch(state, E::InputAvailable)?;
    } else {
        dispatch(state, E::ToolsComplete)?;
    }
    Ok(HandlerOutcome::continue_run())
}

/// 工具结果 → tool 角色消息（ToolResult 块，01 §2.8 步骤 5）
fn tool_result_message(result: &ClassifiedToolResult) -> AgentMessage {
    AgentMessage {
        id: format!("tool-result-{}", result.id),
        role: AgentMessageRole::Tool,
        created_at: crate::steering::now_iso_utc(),
        blocks: vec![AgentMessageBlock::ToolResult {
            tool_call_id: result.id.clone(),
            tool_name: result.tool_name.clone(),
            output: tool_output_from_result(result),
            is_error: result.error_kind.is_some(),
        }],
        metadata: None,
        client_message_id: None,
        content: None,
    }
}

/// 分类结果 → ToolOutput（成功：透传输出值；失败：文本 + 错误码结构）
fn tool_output_from_result(result: &ClassifiedToolResult) -> ToolOutput {
    if result.is_ok() {
        if result.output.is_null() {
            ToolOutput::empty()
        } else if let Some(text) = result.output.as_str() {
            ToolOutput::text(text.to_string())
        } else if let Some(obj) = result.output.as_object() {
            // 对象形态：仅当含 text/json/artifacts 已知键时按 ToolOutput
            // 结构解析，否则整体作为 json 输出承载（避免未知键被吞）
            let has_known = ["text", "json", "artifacts"]
                .iter()
                .any(|k| obj.contains_key(*k));
            if has_known {
                serde_json::from_value(result.output.clone()).unwrap_or_default()
            } else {
                ToolOutput {
                    text: None,
                    json: Some(result.output.clone()),
                    artifacts: None,
                }
            }
        } else {
            ToolOutput {
                text: None,
                json: Some(result.output.clone()),
                artifacts: None,
            }
        }
    } else {
        ToolOutput {
            text: result.error_message.clone(),
            json: Some(serde_json::json!({
                "code": result.error_kind.map(|k| k.error_code()).unwrap_or("tool.error"),
                "kind": format!("{:?}", result.error_kind),
            })),
            artifacts: None,
        }
    }
}

/// 工具事件 → AgentEvent（ToolBatchResult 组装，前端硬依赖 03 §5.1-7/8）
fn emit_tool_events(state: &mut LoopState, events: &[ToolEvent]) {
    let session_id = state.machine.context().session_id.clone();
    let mut batch_id = String::new();
    for event in events {
        match event {
            ToolEvent::BatchStart {
                batch_id: id,
                count,
            } => {
                batch_id = id.clone();
                state.events.push(AgentEvent::ToolBatchStart {
                    session_id: session_id.clone(),
                    batch_id: id.clone(),
                    timestamp: crate::steering::now_iso_utc(),
                    summary: format!("{count} 个工具调用"),
                    calls: Vec::new(),
                });
            }
            ToolEvent::ToolStart {
                call_id,
                tool_name,
                input,
                category,
                concurrency,
                summary,
            } => {
                state.events.push(AgentEvent::ToolStart {
                    session_id: session_id.clone(),
                    batch_id: batch_id.clone(),
                    call: ToolBatchCall {
                        id: call_id.clone(),
                        tool_name: tool_name.clone(),
                        summary: summary.clone(),
                        input: input.clone(),
                        category: *category,
                        concurrency: *concurrency,
                    },
                    timestamp: crate::steering::now_iso_utc(),
                });
            }
            ToolEvent::ApprovalRequested {
                call_id,
                tool_name,
                args,
                requester,
            } => {
                // approval-requested 事件先于等待发出（防死锁，01 §五.8）；
                // 真实 PermissionRequest 由 B4/B6 审批层补齐
                state.events.push(AgentEvent::ApprovalRequested {
                    session_id: session_id.clone(),
                    request: conex_types::events::PermissionRequest {
                        id: format!("approval-{call_id}"),
                        session_id: session_id.clone(),
                        cwd: state.options.cwd.clone().unwrap_or_default(),
                        tool_call_id: call_id.clone(),
                        tool_name: tool_name.clone(),
                        parameters: args.clone(),
                        summary: format!("call {tool_name}"),
                        tool_metadata: Default::default(),
                        metadata: None,
                        // T-D-14：请求方身份随事件落库（子代理 run 携带
                        // run id + 理由；主 agent run = None）
                        requester_run_id: requester.as_ref().map(|r| r.run_id.clone()),
                        reason: requester.as_ref().and_then(|r| r.reason.clone()),
                    },
                    timestamp: crate::steering::now_iso_utc(),
                });
            }
            ToolEvent::ApprovalResolved { call_id, decision } => {
                // G-9：审批超时权威语义——引擎把超时转移落为
                // approval-resolved(expired) 事件（复用既有
                // AgentEvent::ApprovalResolved 变体与 decision=expired
                // 规范值，协议不变；载荷与壳层 approve/deny 路径对齐：
                // request_id 缺省 None）。随会话事件流持久化，经同步面
                // 白名单（SYNC_ELIGIBLE_TYPES 含 approval-resolved）
                // 多端透传，手机端过期状态无需本地计时兜底。
                state.events.push(AgentEvent::ApprovalResolved {
                    session_id: session_id.clone(),
                    tool_call_id: call_id.clone(),
                    request_id: None,
                    decision: match decision {
                        ApprovalDecision::Approved => {
                            conex_types::events::ApprovalDecision::Approved
                        }
                        ApprovalDecision::Denied { .. } => {
                            conex_types::events::ApprovalDecision::Denied
                        }
                        ApprovalDecision::Expired => {
                            conex_types::events::ApprovalDecision::Expired
                        }
                    },
                    timestamp: crate::steering::now_iso_utc(),
                });
            }
            ToolEvent::ToolProgress { call_id, update } => {
                // S1 流式进度（TOOLS-01 §3.1.5）：ToolUpdate 出站（展示面，
                // 携带 batch_id/tool_call_id；不进消息历史——终值仍由
                // ToolEnd 承载，避免污染对话缓存前缀）
                state.events.push(AgentEvent::ToolUpdate {
                    session_id: session_id.clone(),
                    batch_id: batch_id.clone(),
                    tool_call_id: call_id.clone(),
                    update: update.clone(),
                    timestamp: crate::steering::now_iso_utc(),
                });
            }
            ToolEvent::ToolEnd {
                call_id,
                tool_name,
                is_error,
                duration_ms,
                output,
                error_code,
                error_message,
            } => {
                // 完整输出透传：成功带结构化 output；失败带错误码 + 文案
                // （tool_output_from_result 与 tool 角色消息共用同一转换，
                // 保证 tool-end 事件与消息落盘语义一致）
                state.events.push(AgentEvent::ToolEnd {
                    session_id: session_id.clone(),
                    batch_id: batch_id.clone(),
                    result: ToolBatchResult {
                        id: call_id.clone(),
                        tool_name: tool_name.clone(),
                        output: tool_output_from_parts(
                            output,
                            *is_error,
                            error_code.as_deref(),
                            error_message,
                        ),
                        is_error: *is_error,
                        duration_ms: *duration_ms,
                    },
                    timestamp: crate::steering::now_iso_utc(),
                });
            }
            ToolEvent::BatchEnd { batch_id: id } => {
                state.events.push(AgentEvent::ToolBatchEnd {
                    session_id: session_id.clone(),
                    batch_id: id.clone(),
                    timestamp: crate::steering::now_iso_utc(),
                    calls: Vec::new(),
                });
            }
        }
    }
}

/// 工具事件结束载荷 → ToolOutput（与 tool 角色消息共用语义：
/// 成功透传输出；失败 text=错误文案 + json={code,kind}）
fn tool_output_from_parts(
    output: &serde_json::Value,
    is_error: bool,
    error_code: Option<&str>,
    error_message: &Option<String>,
) -> ToolOutput {
    if is_error {
        return ToolOutput {
            text: error_message.clone(),
            json: Some(serde_json::json!({
                "code": error_code.unwrap_or("tool.error"),
            })),
            artifacts: None,
        };
    }
    if output.is_null() {
        return ToolOutput::empty();
    }
    if let Some(text) = output.as_str() {
        return ToolOutput::text(text.to_string());
    }
    if let Some(obj) = output.as_object() {
        let has_known = ["text", "json", "artifacts"]
            .iter()
            .any(|k| obj.contains_key(*k));
        if has_known {
            return serde_json::from_value(output.clone()).unwrap_or_default();
        }
        return ToolOutput {
            text: None,
            json: Some(output.clone()),
            artifacts: None,
        };
    }
    ToolOutput {
        text: None,
        json: Some(output.clone()),
        artifacts: None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use agent_tools::registry::ToolRegistry;
    use conex_types::tool::ToolProgressUpdate;
    use crate::r#loop::SessionLoopOptions;
    use crate::steering::{
        RecoverySteeringStrategy, SteeringCoordinator, SteeringCoordinatorOptions,
    };

    /// 构造最小 LoopState（emit_tool_events 单测驱动）
    fn state() -> LoopState {
        let steering = SteeringCoordinator::new(
            vec![Box::new(RecoverySteeringStrategy::default())],
            SteeringCoordinatorOptions::default(),
        );
        LoopState::new(
            "sess-1",
            16,
            steering,
            SessionLoopOptions::default(),
            Arc::new(ToolRegistry::new()),
        )
    }

    /// Text 形态出站映射（TOOLS-01 §3.1.5）：text 承载 + metadata.kind =
    /// tool-progress；batch_id/tool_call_id 透传；时序
    /// tool-start → tool-update → tool-end 保持；ToolUpdate 不进消息历史
    #[test]
    fn tool_progress_text_maps_to_tool_update() {
        let mut s = state();
        let events = vec![
            ToolEvent::BatchStart {
                batch_id: "batch-1".into(),
                count: 1,
            },
            ToolEvent::ToolStart {
                call_id: "c1".into(),
                tool_name: "shell_command".into(),
                input: serde_json::json!({}),
                category: ToolCategory::Internal,
                concurrency: ToolConcurrency::Sequential,
                summary: "call shell_command".into(),
            },
            ToolEvent::ToolProgress {
                call_id: "c1".into(),
                update: ToolProgressUpdate {
                    text: Some("第一块".into()),
                    json: None,
                    metadata: Some(serde_json::json!({ "kind": "tool-progress" })),
                },
            },
            ToolEvent::ToolEnd {
                call_id: "c1".into(),
                tool_name: "shell_command".into(),
                is_error: false,
                duration_ms: 10,
                output: serde_json::json!({ "out": "x" }),
                error_code: None,
                error_message: None,
            },
            ToolEvent::BatchEnd {
                batch_id: "batch-1".into(),
            },
        ];
        emit_tool_events(&mut s, &events);
        // 事件流时序：tool-batch-start → tool-start → tool-update →
        // tool-end → tool-batch-end
        let types: Vec<&str> = s.events.iter().map(|e| e.type_name()).collect();
        assert_eq!(
            types,
            vec![
                "tool-batch-start",
                "tool-start",
                "tool-update",
                "tool-end",
                "tool-batch-end"
            ],
            "tool-update 必须位于 tool-start 与 tool-end 之间"
        );
        match &s.events[2] {
            AgentEvent::ToolUpdate {
                batch_id,
                tool_call_id,
                update,
                ..
            } => {
                assert_eq!(batch_id, "batch-1", "batch_id 从批上下文透传");
                assert_eq!(tool_call_id, "c1", "tool_call_id 从执行上下文透传");
                assert_eq!(update.text.as_deref(), Some("第一块"));
                assert!(update.json.is_none());
                assert_eq!(
                    update.metadata.as_ref().unwrap()["kind"],
                    "tool-progress",
                    "Text 形态 metadata.kind 固定为 tool-progress"
                );
            }
            _ => panic!("ToolProgress 应映射为 AgentEvent::ToolUpdate"),
        }
        // ToolUpdate 是展示面事件：不进消息历史（终值仍由 ToolEnd 承载）
        assert!(
            s.conversation.is_empty(),
            "emit_tool_events 不得写消息历史（ToolUpdate 不进对话缓存前缀）"
        );
    }

    /// Custom 形态出站映射：json 承载 + metadata.kind = subkind（与前端
    /// tool-args-delta 预留消费面同槽位）
    #[test]
    fn tool_progress_custom_maps_to_tool_update() {
        let mut s = state();
        let events = vec![
            ToolEvent::BatchStart {
                batch_id: "batch-1".into(),
                count: 1,
            },
            ToolEvent::ToolProgress {
                call_id: "c2".into(),
                update: ToolProgressUpdate {
                    text: None,
                    json: Some(serde_json::json!({ "step": 1 })),
                    metadata: Some(serde_json::json!({ "kind": "tool-args-delta" })),
                },
            },
        ];
        emit_tool_events(&mut s, &events);
        match &s.events[1] {
            AgentEvent::ToolUpdate {
                tool_call_id,
                update,
                ..
            } => {
                assert_eq!(tool_call_id, "c2");
                assert!(update.text.is_none());
                assert_eq!(update.json.as_ref().unwrap()["step"], 1);
                assert_eq!(
                    update.metadata.as_ref().unwrap()["kind"],
                    "tool-args-delta",
                    "Custom 形态 metadata.kind = subkind"
                );
            }
            _ => panic!("ToolProgress 应映射为 AgentEvent::ToolUpdate"),
        }
    }

    /// G-9：审批超时权威语义落库——引擎记录 ApprovalResolved(Expired)
    /// 翻译为 AgentEvent::approval-resolved（复用既有变体与
    /// decision=expired 规范值，协议不变；载荷与壳层 approve/deny 路径
    /// 对齐：request_id 缺省 None）
    #[test]
    fn approval_resolved_expired_maps_to_agent_event() {
        let mut s = state();
        let events = vec![
            ToolEvent::BatchStart {
                batch_id: "batch-1".into(),
                count: 1,
            },
            ToolEvent::ApprovalRequested {
                call_id: "c1".into(),
                tool_name: "shell_command".into(),
                args: serde_json::json!({ "command": "git push" }),
                requester: None,
            },
            ToolEvent::ApprovalResolved {
                call_id: "c1".into(),
                decision: ApprovalDecision::Expired,
            },
            ToolEvent::ToolEnd {
                call_id: "c1".into(),
                tool_name: "shell_command".into(),
                is_error: true,
                duration_ms: 0,
                output: serde_json::Value::Null,
                error_code: Some("tool.approval_expired".into()),
                error_message: Some("approval expired".into()),
            },
            ToolEvent::BatchEnd {
                batch_id: "batch-1".into(),
            },
        ];
        emit_tool_events(&mut s, &events);
        match &s.events[2] {
            AgentEvent::ApprovalResolved {
                session_id,
                tool_call_id,
                request_id,
                decision,
                timestamp,
            } => {
                assert_eq!(session_id, "sess-1");
                assert_eq!(tool_call_id, "c1");
                assert_eq!(request_id, &None);
                assert_eq!(
                    decision,
                    &conex_types::events::ApprovalDecision::Expired
                );
                assert!(!timestamp.is_empty());
            }
            other => panic!("应映射为 AgentEvent::ApprovalResolved，实际 {other:?}"),
        }
    }

    /// F1 盲区 8 / F3-10：tool-result 消息 id 派生契约——不同 tool-call id
    /// 产出不同消息 id；**同一 tool-call id 复用（模型跨轮重发同 id 调用）
    /// 时消息 id 相同（已知冲突，F3-10 观察项）**——本测试钉住现状形态，
    /// 未来去重修复（按出现序消歧）时以此为回归锚点。
    #[test]
    fn tool_result_message_id_derivation_documented() {
        let ok = ClassifiedToolResult {
            id: "call_x".into(),
            tool_name: "echo".into(),
            error_kind: None,
            error_message: None,
            output: serde_json::json!({"ok": true}),
            duration_ms: 1,
        };
        let message = tool_result_message(&ok);
        assert_eq!(message.id, "tool-result-call_x");
        assert_eq!(message.role, AgentMessageRole::Tool);
        // tool_call_id 回指原调用 id（回放侧配对语义）
        let AgentMessageBlock::ToolResult { tool_call_id, .. } = &message.blocks[0] else {
            panic!("tool 角色消息应含 ToolResult 块");
        };
        assert_eq!(tool_call_id, "call_x");

        // 不同调用 id → 消息 id 互异
        let other = ClassifiedToolResult {
            id: "call_y".into(),
            tool_name: "echo".into(),
            error_kind: None,
            error_message: None,
            output: serde_json::json!({"ok": true}),
            duration_ms: 1,
        };
        assert_ne!(
            tool_result_message(&ok).id,
            tool_result_message(&other).id,
            "不同 tool-call id 不得共享消息 id"
        );
        // 同 id 复用（模型重发）→ 消息 id 相同（F3-10 已知形态：跨轮
        // 复用同 id 时消息 id 冲突，事件侧无重复检查）
        assert_eq!(
            tool_result_message(&ok).id,
            tool_result_message(&ClassifiedToolResult {
                id: "call_x".into(),
                ..ok
            })
            .id,
            "同 tool-call id 派生相同消息 id（F3-10 现状契约：冲突形态已知）"
        );
    }
}
