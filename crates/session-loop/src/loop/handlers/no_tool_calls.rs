//! handleNoToolCalls（01 §2.6 / Tool-Promise 自愈状态机 RUL-02）
//!
//! 触发：streaming 中消息无 tool-call。
//! 行为：
//!   1. stopReason=length：length 恢复阶梯——max_tokens 翻倍升级
//!      （8192→16384→32768，上限 2 次）→ resetSteeringCount +
//!      NO_PROGRESS_CONTINUE；阶梯用尽后 continue-nudge 上限内再试一次
//!      （01 §2.6 步骤 1；nudge 文本按 D8 不注入当前 run，仅重试）；
//!   2. 非 length：重置 length 计数器（01 §2.6 步骤 2）；
//!   3. Tool-Promise 意图自愈状态机（RUL-02）：
//!      三层反向过滤 + 行动意图检测；未超 max_tool_promise_heals（默认 2）
//!      上限时合成 Steering Nudge 注入并以 NO_PROGRESS_CONTINUE 推进续轮；
//!   4. resetSteeringCount（01 §2.6 步骤 3 / 01 §3.3 ③）；
//!   5. NO_TOOL_CALLS → turn-complete（纯文字回复 = 正常结束，01 D6）。
//!
//! 期望语义：无 tool-call 的纯文字回复 = 正常收场（永不 error，本次 bug 锚点）。

use conex_types::message::{
    AgentMessage, AgentMessageBlock, AgentMessageMetadataKind, AgentMessageRole,
};
use conex_types::session::AgentSessionEvent as E;

use crate::steering::strategy::ToolPromiseDetector;
use crate::stream::ConsumeStopReason;

use super::super::handlers::{
    dispatch, last_assistant_message, new_message_id, HandlerOutcome, LoopState,
};
use super::super::LoopError;

/// 会话推导语言环境（避免跨语言 Steering 污染）
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SessionLanguage {
    Chinese,
    English,
}

/// 会话语言检测器（基于会话特征推导语言环境）
pub struct SessionLanguageDetector;

impl SessionLanguageDetector {
    /// 判定文本是否包含汉字字符（CJK 统一表意文字）
    pub fn contains_chinese(text: &str) -> bool {
        text.chars().any(|c| {
            ('\u{4e00}'..='\u{9fff}').contains(&c) || ('\u{3400}'..='\u{4dbf}').contains(&c)
        })
    }

    /// 基于助手文本与会话上下文推导语言环境
    pub fn detect(state: &LoopState, assistant_text: &str) -> SessionLanguage {
        // 1. 若助手当前回复直接包含中文，判定为中文
        if Self::contains_chinese(assistant_text) {
            return SessionLanguage::Chinese;
        }

        // 2. 检查会话历史中最近的 User 消息
        for msg in state.conversation.iter().rev() {
            if msg.role == AgentMessageRole::User {
                let user_text = msg.text();
                if Self::contains_chinese(&user_text) {
                    return SessionLanguage::Chinese;
                }
                if !user_text.trim().is_empty() {
                    return SessionLanguage::English;
                }
            }
        }

        // 3. 兜底：若助手文本非空且无中文，推导为英文，否则回退为中文
        if !assistant_text.trim().is_empty() && !Self::contains_chinese(assistant_text) {
            SessionLanguage::English
        } else {
            SessionLanguage::Chinese
        }
    }
}

/// no-tool-calls handler（01 §2.6 / RUL-02）
pub(crate) async fn handle(
    state: &mut LoopState,
    stop_reason: Option<ConsumeStopReason>,
) -> Result<HandlerOutcome, LoopError> {
    if stop_reason == Some(ConsumeStopReason::Length) {
        // length 恢复阶梯（01 §2.6 步骤 1；F2-01：配置超上限按
        // [super::stream_error::MAX_LENGTH_UPGRADES] 计——阶梯封顶 32768，
        // 配置放大不得触发翻倍溢出）
        let upgrade_limit = state
            .options
            .retry
            .length_upgrade_limit
            .min(super::stream_error::MAX_LENGTH_UPGRADES);
        if state.length_upgrades < upgrade_limit {
            state.length_upgrades += 1;
            let max_tokens_before = state.max_tokens;
            // F2-01：saturating 翻倍（防御纵深，常规路径封顶 32768）
            state.max_tokens = state.max_tokens.saturating_mul(2);
            // EV-03（D-03）：length 升级诊断——provider-diagnostic
            // kind=length-escalation（attempt/maxTokens 前后值随载荷，
            // 对齐 stream_error_retry.rs 的 phase=Retry 载荷先例）
            super::stream_error::emit_length_escalation_diagnostic(
                state,
                state.length_upgrades,
                upgrade_limit,
                max_tokens_before,
                state.max_tokens,
            );
            // 01 §3.3 ②：length 升级时重置 steering 计数（reset 前后计数
            // 进 steering-evaluated 事件，EV-03）
            super::super::handlers::emit_steering_reset_event(state, "length-escalation");
            // 重进 provider 循环（更高 max_tokens）
            dispatch(state, E::NoProgressContinue)?;
            return Ok(HandlerOutcome::continue_run());
        }
        // 阶梯用尽：continue nudge 上限内再试一次（D8：不注入 nudge 文本，
        // 仅重试；上限 1）
        if state.continue_nudges < state.options.retry.continue_nudge_limit {
            state.continue_nudges += 1;
            dispatch(state, E::NoProgressContinue)?;
            return Ok(HandlerOutcome::continue_run());
        }
        // 阶梯与 nudge 均用尽：正常收场（length 截断不视为错误）
    } else {
        // 非 length：重置 length 计数器（01 §2.6 步骤 2）
        state.length_upgrades = 0;
        state.continue_nudges = 0;

        // ── Tool-Promise 意图自愈状态机（RUL-02）──
        if state.options.tool_exec.tool_promise_recovery_enabled {
            if let Some(assistant) = last_assistant_message(state) {
                let text = assistant.text();
                if let Some(snippet) = ToolPromiseDetector::detect_action_promise(&text) {
                    if state.tool_promise_heals < state.options.tool_exec.max_tool_promise_heals {
                        state.tool_promise_heals += 1;
                        tracing::warn!(
                            session_id = %state.machine.context().session_id,
                            heal_count = state.tool_promise_heals,
                            snippet = %snippet,
                            "检测到 AI 行动宣誓但未调用工具，触发 Tool-Promise 自愈推进"
                        );

                        // 构造针对性的 Steering Nudge 注入下一轮（依据会话语言自适应）
                        let language = SessionLanguageDetector::detect(state, &text);
                        let nudge_prompt = match language {
                            SessionLanguage::English => format!(
                                "[System Auto-Steer]: You expressed an intent to execute an action (\"{}\"), but no structured tool call was detected in the current turn. Please immediately call the appropriate system tool (such as `shell_command`, `write_file`, etc.) to execute the action, or provide a definitive final conclusion for the user.",
                                snippet
                            ),
                            SessionLanguage::Chinese => format!(
                                "【系统自动推进】：你刚刚在回复中表达了执行动作的意图（“{}”），但当前轮次未检测到结构化的工具调用。请立即调用相应的系统工具（如 `shell_command`、`write_file` 等）执行操作，或者给出明确针对用户的最终结论。",
                                snippet
                            ),
                        };

                        let nudge_msg = AgentMessage {
                            id: new_message_id("nudge-promise"),
                            role: AgentMessageRole::User,
                            created_at: conex_shared::time::now_iso_utc(),
                            blocks: vec![AgentMessageBlock::Text { text: nudge_prompt }],
                            metadata: Some(serde_json::json!({
                                "kind": AgentMessageMetadataKind::ToolPromiseRecovery,
                                "actionSnippet": snippet,
                                "healCount": state.tool_promise_heals,
                                "thinking_budget": 0,
                                "thinkingBudget": 0,
                            })),
                            client_message_id: None,
                            content: None,
                        };

                        state.input_queue.enqueue_steer(nudge_msg);

                        // 重进 provider 循环
                        dispatch(state, E::NoProgressContinue)?;
                        return Ok(HandlerOutcome::continue_run());
                    } else {
                        tracing::info!(
                            session_id = %state.machine.context().session_id,
                            heal_count = state.tool_promise_heals,
                            "Tool-Promise 自愈已达到硬上限（2 次），安全收口退出"
                        );
                    }
                }
            }
        }
    }

    // 无 tool-call 正常结束：重置 steering 计数（01 §2.6 步骤 3 / 01 §3.3 ③；
    // EV-03：reset 前后计数进 steering-evaluated 事件）
    super::super::handlers::emit_steering_reset_event(state, "no-tool-calls");
    // NO_TOOL_CALLS → turn-complete（纯文字回复正常收场）
    dispatch(state, E::NoToolCalls)?;
    Ok(HandlerOutcome::continue_run())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::r#loop::handlers::LoopState;
    use crate::r#loop::{SessionLoopOptions, DEFAULT_MAX_TOKENS};
    use crate::steering::{
        RecoverySteeringStrategy, SteeringCoordinator, SteeringCoordinatorOptions,
    };
    use agent_tools::registry::ToolRegistry;
    use conex_types::session::{AgentSessionEvent as E, AgentSessionState as S};
    use std::sync::Arc;

    /// 构造处于 streaming 状态的 LoopState（length 阶梯单测驱动）
    fn streaming_state() -> LoopState {
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
        state.machine.dispatch(E::TurnPrepared).unwrap();
        assert_eq!(state.machine.state(), S::Streaming);
        state
    }

    /// 模拟 NO_PROGRESS_CONTINUE 后循环重进 streaming（生产路径由
    /// prepare_turn 的 TURN_PREPARED 转移完成；测试驱动多次 handle 调用前
    /// 必须回到 Streaming 状态——NoProgressContinue 仅 Streaming 态已定义）
    fn re_enter_streaming(state: &mut LoopState) {
        state.machine.dispatch(E::TurnPrepared).unwrap();
        assert_eq!(state.machine.state(), S::Streaming);
    }

    /// F2-01（红→绿）：stopReason=length 路径同样受阶梯上限 2 约束——
    /// length_upgrade_limit 配置放大（30）不得触发第 3 次升级
    /// （修复前 8192→16384→32768→65536 继续翻倍，红；第 19 次升级
    /// 8192×2^19 溢出 u32::MAX——debug panic / release 回绕成小值退化）
    #[tokio::test]
    async fn length_stop_caps_upgrades_even_with_huge_limit() {
        let mut state = streaming_state();
        state.options.retry.length_upgrade_limit = 30;
        // 第一次：升级（1/2）
        let o1 = handle(&mut state, Some(ConsumeStopReason::Length))
            .await
            .unwrap();
        assert!(o1.end.is_none());
        assert_eq!(state.length_upgrades, 1);
        assert_eq!(state.max_tokens, DEFAULT_MAX_TOKENS * 2);
        re_enter_streaming(&mut state);
        // 第二次：升级（2/2）
        let o2 = handle(&mut state, Some(ConsumeStopReason::Length))
            .await
            .unwrap();
        assert!(o2.end.is_none());
        assert_eq!(state.length_upgrades, 2);
        assert_eq!(state.max_tokens, DEFAULT_MAX_TOKENS * 4);
        re_enter_streaming(&mut state);
        // 第三次：配置 30 也按阶梯上限 2 计——不翻倍，走 continue-nudge 上限
        // （默认 1）再试一次后正常收场（length 截断不视为错误）
        let o3 = handle(&mut state, Some(ConsumeStopReason::Length))
            .await
            .unwrap();
        assert!(
            o3.end.is_none(),
            "第 3 次应进入 continue-nudge 重试（非第 3 次 length 升级，红）"
        );
        assert_eq!(state.continue_nudges, 1, "nudge 消耗一次");
        assert_eq!(state.length_upgrades, 2, "升级计数必须停在 2");
        assert_eq!(
            state.max_tokens,
            DEFAULT_MAX_TOKENS * 4,
            "max_tokens 不得超出 32768 阶梯上限"
        );
    }

    #[test]
    fn language_detector_classifies_correctly() {
        assert!(SessionLanguageDetector::contains_chinese("你好世界"));
        assert!(!SessionLanguageDetector::contains_chinese("Hello world"));

        let state = streaming_state();
        assert_eq!(
            SessionLanguageDetector::detect(&state, "Hello world, I will execute the command"),
            SessionLanguage::English
        );
        assert_eq!(
            SessionLanguageDetector::detect(&state, "我来调用 shell_command"),
            SessionLanguage::Chinese
        );
    }

    #[tokio::test]
    async fn english_action_promise_triggers_english_auto_steer_nudge() {
        let mut state = streaming_state();
        state.options.tool_exec.tool_promise_recovery_enabled = true;
        state.options.tool_exec.max_tool_promise_heals = 2;

        let assistant_msg = Arc::new(AgentMessage {
            id: "msg-asst-1".into(),
            role: AgentMessageRole::Assistant,
            created_at: conex_shared::time::now_iso_utc(),
            blocks: vec![AgentMessageBlock::Text {
                text: "I will now run `cargo test` to verify the build.".into(),
            }],
            metadata: None,
            client_message_id: None,
            content: None,
        });
        state.conversation.push(assistant_msg);

        let outcome = handle(&mut state, None).await.unwrap();
        assert!(outcome.end.is_none());
        assert_eq!(state.tool_promise_heals, 1);

        // 验证进入 steering 队列的消息为纯英文，无中文字符
        let steer_msg = state.input_queue.dequeue().expect("应有 steering 消息入队");
        let text = steer_msg.text();
        assert!(
            text.starts_with("[System Auto-Steer]: You expressed an intent to execute an action")
        );
        assert!(
            !SessionLanguageDetector::contains_chinese(&text),
            "英文会话自愈推进不得包含汉字"
        );
    }
}
