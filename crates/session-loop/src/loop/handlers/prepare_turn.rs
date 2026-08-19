//! handlePrepareTurn（01 §2.3）
//!
//! 触发：preparing-turn（含 NO_PROGRESS_CONTINUE 重进）。
//! 行为顺序：
//!   1. 安全点检查（abort / 控制意图）；
//!   2. 消费 hasRunnablePending（force/steer；**不消费 followUp**）——
//!      **E2 F3 hold → compact → append**：用户消息先入 hold 区（不
//!      record_message），边界压缩判定（[maybe_compact_user_boundary]，
//!      trigger=UserMessage）对「不含 hold 消息」的对话执行（估算不含
//!      hold 消息——更保守、更早触发；切割点恒在 hold 之前），压缩后
//!      recordMessage 追加——用户消息 100% 保留、必在发送序列尾部
//!      （kept_ids 中绝不在 dropped_ids）；边界同时是摘要重试的被动
//!      触发点（F2 关联，待重试块补摘要、不阻塞发送）；
//!   3. `turn-start` 事件；
//!   4. steering 评估（after-tools / before-turn 两相位，D3 预注入短路：
//!      输入队列有可运行输入即跳过评估；`steering_enabled=false` 时跳过
//!      评估，T06.2.1 Q03）；intervention-required 事件照发，但 run
//!      **不以 error 收场**（00 D6 / 01 §五.4 裁决：stop + 诊断）；
//!   5. 上下文压缩预检（P4 阶段 3-2 / §3.4.1 触发点 1：阈值触发——T-33
//!      恢复 T06.2.3 Q04 删除的触发点，真实压缩引擎接线；条件与动作见
//!      [maybe_compact_preflight]；边界压缩已消耗单 run 计数时自然跳过）；
//!   6. TURN_PREPARED → streaming。

use crate::steering::SteeringPhase;
use conex_types::events::AgentEvent;
use conex_types::message::AgentMessage;
use conex_types::session::AgentSessionEvent as E;

use super::super::end::EndDecision;
use super::super::handlers::{
    assert_timeline_injection_hygiene, check_control, dispatch, maybe_compact_preflight,
    maybe_compact_user_boundary, record_message, steering_context, HandlerOutcome, LoopState,
};
use super::super::LoopError;

/// preparing-turn handler（01 §2.3）
pub(crate) async fn handle(state: &mut LoopState) -> Result<HandlerOutcome, LoopError> {
    // 1. abort / 控制意图检查
    if let Some(end) = check_control(state)? {
        return Ok(HandlerOutcome::end(end));
    }

    // 2. 消费 hasRunnablePending（force/steer；不消费 followUp，01 §2.3 步骤 2）
    //    E2 F3（07 方案 §2.1）：hold → compact → append——用户消息先入
    //    hold 区（不 record_message），边界压缩判定对「不含 hold 消息」的
    //    对话执行（估算不含 hold 消息——更保守、更早触发；切割点恒在
    //    hold 之前），压缩后 record_message 追加——用户消息 100% 保留、
    //    必在发送序列尾部（kept_ids 中绝不在 dropped_ids）
    let held: Vec<AgentMessage> = {
        let mut messages = Vec::new();
        while let Some(message) = state.input_queue.dequeue() {
            messages.push(message);
        }
        messages
    };
    if !held.is_empty() {
        maybe_compact_user_boundary(state).await;
        for message in held {
            record_message(state, message);
        }
    }

    // 3. turn-start 事件（turn_index 以 TURN_PREPARED 递增后的值展示；
    //    F1-03：饱和加——u32::MAX 时事件载荷保持上限，不得溢出 panic）
    let session_id = state.machine.context().session_id.clone();
    let turn_index = state.machine.context().turn_index.saturating_add(1);
    // EV-11（D-03 EV-13）：新一轮 usage 槽位归零——streaming consume 后
    // 写入本 turn 真值，turn-complete 收口注入 TurnEnd.usage（防上一轮
    // usage 错位泄漏进本轮无请求的 turn）
    state.budget_state.turn_usage = None;
    let start_event = AgentEvent::TurnStart {
        session_id: session_id.clone(),
        turn_index,
        timestamp: conex_shared::time::now_iso_utc(),
    };
    state.emit_event(start_event);
    // EV-08：孤儿 turn-start 修复——记录已发射 turn-start 的轮次（收敛
    // 路径未走 turn_complete 时经 emit_missing_turn_end 补发 turn-end 闭合；
    // turn_complete 正常发射后清 None）
    state.current_turn_index = Some(turn_index);
    // I8-E1 第一批：turn.start 钩子广播（turn 编排起点；observe 默认，
    // 失败吞掉 + 计数，编排继续——03 §2.4 表）
    if let Some(hooks) = &state.options.tool_exec.hooks {
        let _ = hooks
            .dispatch(&crate::hooks::HookEvent::TurnStart {
                session_id,
                turn_index,
            })
            .await;
    }

    // 4. steering 评估（D3 预注入短路：有可运行输入即跳过策略评估，
    //    避免对已注入 nudge 重复 steering；T06.2.1 Q03：steering_enabled
    //    =false 时跳过 AfterTools/BeforeTurn 评估）
    if state.options.hooks.steering_enabled && !state.input_queue.has_runnable_pending() {
        for phase in [SteeringPhase::AfterTools, SteeringPhase::BeforeTurn] {
            let actions = state.steering.evaluate(phase, &steering_context(state));
            if actions.is_empty() {
                continue;
            }
            let session_id = state.machine.context().session_id.clone();
            let applied = state
                .steering
                .apply(&actions, &session_id, &mut state.conversation);
            for event in applied.events {
                state.emit_event(event);
            }
            if applied.intervention_required {
                // 裁决（00 D6 / 01 §五.4）：intervention 事件照发，
                // 但 run 以 stop + 诊断收场，不以 error 收场
                dispatch(state, E::InterventionRequired)?;
                return Ok(HandlerOutcome::end(EndDecision::stop_with_diagnostic(
                    state,
                    crate::steering::DEFAULT_INTERVENTION_MESSAGE,
                )));
            }
        }
    }

    // 5. 上下文压缩预检（P4 阶段 3-2 / §3.4.1 触发点 1：阈值触发）——
    //    estimate ≥ window - reserve 且本 run 压缩次数未达上限时同步压缩
    //    （对话替换 + 事件广播在预检函数内完成；压缩是唯一前缀重写点，
    //    I1 不变量，P1 追加点纪律的 P4 闸门例外）。
    //    T06.2.3 Q04 删除的触发点在 T-33 恢复：真实压缩引擎
    //    （conex-compaction AgentMessage 面）已接线，CompressionHook
    //    死配置由阈值预检替代。
    maybe_compact_preflight(state).await;
    // T-35 注入卫生（debug 面）：本 handler 是 steering 注入（InjectMessage
    // 直写对话）与 user 消息消费（record_message）的汇聚点——预检压缩
    // 后再做一次尾部卫生断言，覆盖 steering 注入路径
    assert_timeline_injection_hygiene(&state.conversation);

    // 6. TURN_PREPARED → streaming（turnIndex+1，toolCallCount 归零）
    dispatch(state, E::TurnPrepared)?;
    Ok(HandlerOutcome::continue_run())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::r#loop::handlers::LoopState;
    use crate::r#loop::SessionLoopOptions;
    use crate::steering::{
        RecoverySteeringStrategy, SteeringCoordinator, SteeringCoordinatorOptions,
    };
    use agent_tools::registry::ToolRegistry;
    use conex_types::events::AgentEvent;
    use conex_types::message::{AgentMessage, AgentMessageBlock, AgentMessageRole};
    use conex_types::session::{AgentSessionEvent as E, AgentSessionState as S};
    use std::sync::Arc;

    /// 构造处于 preparing-turn 状态的 LoopState（F1-03 单测驱动）
    fn preparing_state() -> LoopState {
        let steering = SteeringCoordinator::new(
            vec![Box::new(RecoverySteeringStrategy::default())],
            SteeringCoordinatorOptions::default(),
        );
        let mut state = LoopState::new(
            "sess-1",
            16,
            steering,
            SessionLoopOptions::default(),
            Arc::new(ToolRegistry::new()),
        );
        state.machine.dispatch(E::Initialized).unwrap();
        state.machine.dispatch(E::InputReady).unwrap();
        assert_eq!(state.machine.state(), S::PreparingTurn);
        state.input_queue.enqueue_force(AgentMessage {
            id: "user-1".to_string(),
            role: AgentMessageRole::User,
            created_at: "2026-08-03T10:00:00.000Z".to_string(),
            blocks: vec![AgentMessageBlock::Text {
                text: "hello".to_string(),
            }],
            metadata: None,
            client_message_id: None,
            content: None,
        });
        state
    }

    /// F1-03（红→绿）：turn-start 事件在 turn_index=u32::MAX 时不得溢出
    /// panic（修复前 prepare_turn.rs:43 `turn_index + 1` debug panic）；
    /// 饱和后事件载荷保持 u32::MAX，不产生回绕显示值
    #[tokio::test]
    async fn turn_start_event_saturates_at_u32_max() {
        let mut state = preparing_state();
        state.machine.context_mut().turn_index = u32::MAX;
        let outcome = handle(&mut state).await.expect("handler 不得 panic");
        assert!(outcome.end.is_none(), "正常轮次不应收场");
        let turn_index = state.events.iter().find_map(|e| match e {
            AgentEvent::TurnStart { turn_index, .. } => Some(*turn_index),
            _ => None,
        });
        assert_eq!(
            turn_index,
            Some(u32::MAX),
            "turn-start 事件必须饱和保持（修复前 `+1` 溢出 panic，红）"
        );
    }

    // ── E2 F3 用户消息边界（hold → compact → append）端到端 ──────────

    /// E2 F3 端到端（07 方案 §2.4 断言 1/2）：超阈值时 prepare_turn 先
    /// 边界压缩（trigger=UserMessage）再 append 用户消息——对话尾部恒为
    /// 用户消息原文（逐字节相等）、用户消息绝不在 dropped_ids；边界压缩
    /// 消耗单 run 计数后同 turn 预检自然跳过（压缩事件只有一对）
    #[tokio::test]
    async fn user_message_appended_after_boundary_compaction() {
        use conex_compaction::CompactionPolicy;
        use conex_types::context::ContextBudget;
        use conex_types::tool::ContextCompressionTrigger;

        let mut state = preparing_state();
        // 预算/策略注入（与 LoopState::new 派生同源；窗口 1 万、阈值 8000）
        state.budget_state.budget = Some(ContextBudget {
            context_window: 10_000,
            reserve_tokens: 2_000,
            safety_tokens: 100,
        });
        state.compaction.compaction_policy = Some(CompactionPolicy {
            keep_recent_tokens: 2_000,
            min_recent_turns: 1,
            ..Default::default()
        });
        state.options.compaction.max_auto_compactions_per_run = 1;
        // E2 F1 L1：LLM 摘要强制——注入可用 Summarizer（合法 Schema V1 输出）
        struct StubSummary;
        impl conex_compaction::Summarizer for StubSummary {
            fn summarize(
                &self,
                _dropped: &[AgentMessage],
                _existing: Option<&str>,
            ) -> Result<String, String> {
                Ok(serde_json::json!({
                    "schemaVersion": 1,
                    "blockId": "compacted-summary-1-1",
                    "generation": 1,
                    "droppedIds": [],
                    "height": 1,
                    "tier": "chunk",
                    "goal": "修复构建流程",
                    "constraints": [],
                    "progress": ["已定位编译错误"],
                    "decisions": [],
                    "nextSteps": ["运行全量测试"],
                    "criticalContext": ["cargo build --workspace"],
                })
                .to_string())
            }
        }
        state.compaction.summarizer = Some(Arc::new(StubSummary));
        // 超阈值对话：10 条 × 5000 字（CJK 逐字符 ≈ 5000 token）≈ 5 万 token
        state.conversation = (0..10)
            .map(|i| {
                Arc::new(AgentMessage {
                    id: format!("m{i}"),
                    role: if i % 2 == 0 {
                        AgentMessageRole::User
                    } else {
                        AgentMessageRole::Assistant
                    },
                    created_at: "2026-08-03T10:00:00.000Z".to_string(),
                    blocks: vec![AgentMessageBlock::Text {
                        text: "字".repeat(5_000),
                    }],
                    metadata: None,
                    client_message_id: None,
                    content: None,
                })
            })
            .collect();

        let outcome = handle(&mut state).await.expect("handler 不得 panic");
        assert!(outcome.end.is_none(), "正常轮次不应收场");
        // 用户消息 100% 保留：对话尾部 = user-1 原文（逐字节相等）
        let tail = state.conversation.last().expect("对话非空");
        assert_eq!(tail.id, "user-1", "用户消息必在发送序列尾部");
        assert_eq!(tail.role, AgentMessageRole::User);
        assert_eq!(tail.text(), "hello", "用户消息原文逐字节保留");
        // 压缩事件：trigger=UserMessage，用户消息绝不在 dropped_ids
        let record = state.events.iter().find_map(|e| match e {
            AgentEvent::ContextCompressionEnd {
                result: Some(record),
                ..
            } => Some(record.clone()),
            _ => None,
        });
        let record = record.expect("超阈值必须发生边界压缩");
        assert_eq!(record.trigger, ContextCompressionTrigger::UserMessage);
        assert!(
            !record
                .compressed_message_ids
                .contains(&"user-1".to_string()),
            "用户消息绝不在 dropped_ids"
        );
        assert!(
            state.conversation.len() < 11,
            "边界压缩后消息数必须减少（压缩 + 用户消息 append）"
        );
        // 同 turn 预检因计数封顶自然跳过：压缩事件只有一对
        let ends = state
            .events
            .iter()
            .filter(|e| matches!(e, AgentEvent::ContextCompressionEnd { .. }))
            .count();
        assert_eq!(ends, 1, "边界压缩消耗计数后预检跳过，只广播一对事件");
    }

    /// E2 F3 端到端（07 方案 §2.4 断言「未超阈值行为不变」）：小对话 +
    /// 无预算配置 → 不压缩、无压缩事件，用户消息直接 record（行为与
    /// 压缩前一致）
    #[tokio::test]
    async fn user_message_recorded_without_compaction_under_threshold() {
        let mut state = preparing_state();
        // 默认 options（无预算/策略）+ 小对话（队列仅 user-1）→ 不触发
        let outcome = handle(&mut state).await.expect("handler 不得 panic");
        assert!(outcome.end.is_none());
        assert!(
            state
                .events
                .iter()
                .all(|e| !matches!(e, AgentEvent::ContextCompressionEnd { .. })),
            "未超阈值不得广播压缩事件"
        );
        // 用户消息照常 record：对话尾部 = user-1
        let tail = state.conversation.last().expect("对话非空");
        assert_eq!(tail.id, "user-1");
        assert_eq!(tail.text(), "hello");
    }
}

