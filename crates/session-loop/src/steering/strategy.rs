//! RecoverySteeringStrategy（对齐 TS recovery-steering-strategy.ts）
//!
//! 唯一活跃策略：phases = `after-tools` / `empty-response`（01 §3.1）。
//!
//! - empty-response（D7）：`steering_count >= maxSteeringMessages`（默认 1）
//!   时返回 `intervention-required`——预算内重试注入，耗尽后 intervention
//!   事件照发但不以 error 收场（收场语义由 coordinator/主循环保证）；
//! - after-tools：扫描消息列表检测连续工具错误环
//!   （[detect_recent_tool_error_loop]，连续错误 ≥ maxConsecutiveToolErrors=2）
//!   与重复调用环（[detect_repeated_tool_call_loop]，重复 ≥
//!   maxRepeatedToolCalls=3）→ 预算内 `inject-message`、耗尽
//!   `intervention-required`。
//!
//! 检测函数语义对齐 TS runtime-helpers.ts：自消息尾部向前扫描，
//! 遇 user 消息停止；错误环检测中最近一条非失败的 tool-result 即判定无环。
//!
//! PE-09 T09.3.2：策略消费的对话消息为 Arc 共享形态（`&[Arc<AgentMessage>]`），
//! 读字段自动 deref，行为不变。

use std::collections::HashMap;
use std::sync::Arc;

use conex_types::message::{AgentMessage, AgentMessageBlock, AgentMessageRole};
use conex_types::tool::ToolOutput;

use crate::steering::nudge::build_steering_message;
use crate::steering::{
    DEFAULT_INTERVENTION_MESSAGE, SteeringAction, SteeringContext, SteeringPhase, SteeringReason,
    SteeringStrategy,
};

/// 最大连续工具错误数（默认 2，对齐 TS recovery-steering-strategy.ts:41）
pub const DEFAULT_MAX_CONSECUTIVE_TOOL_ERRORS: usize = 2;
/// 最大重复调用数（默认 3，对齐 TS :42）
pub const DEFAULT_MAX_REPEATED_TOOL_CALLS: usize = 3;
/// 策略层最大纠偏消息数（默认 1，对齐 TS :43；coordinator 预算默认 3 为全局上限）
pub const DEFAULT_MAX_STEERING_MESSAGES: usize = 1;

/// 策略配置（对齐 TS RecoverySteeringStrategyOptions）
#[derive(Debug, Clone, Copy, Default)]
pub struct RecoverySteeringStrategyOptions {
    /// 最大连续工具错误数（默认 [DEFAULT_MAX_CONSECUTIVE_TOOL_ERRORS] = 2）
    pub max_consecutive_tool_errors: Option<usize>,
    /// 最大重复调用数（默认 [DEFAULT_MAX_REPEATED_TOOL_CALLS] = 3）
    pub max_repeated_tool_calls: Option<usize>,
    /// 策略层最大纠偏消息数（默认 [DEFAULT_MAX_STEERING_MESSAGES] = 1）
    pub max_steering_messages: Option<usize>,
}

/// 恢复纠偏策略
#[derive(Debug, Clone, Copy)]
pub struct RecoverySteeringStrategy {
    max_consecutive_tool_errors: usize,
    max_repeated_tool_calls: usize,
    max_steering_messages: usize,
}

impl RecoverySteeringStrategy {
    /// 新建策略（选项缺省取默认值）
    pub fn new(options: RecoverySteeringStrategyOptions) -> Self {
        Self {
            max_consecutive_tool_errors: options
                .max_consecutive_tool_errors
                .unwrap_or(DEFAULT_MAX_CONSECUTIVE_TOOL_ERRORS),
            max_repeated_tool_calls: options
                .max_repeated_tool_calls
                .unwrap_or(DEFAULT_MAX_REPEATED_TOOL_CALLS),
            max_steering_messages: options
                .max_steering_messages
                .unwrap_or(DEFAULT_MAX_STEERING_MESSAGES),
        }
    }

    /// 从消息列表检测纠偏需求：错误环优先，其次重复调用环
    /// （Arc 共享形态，PE-09 T09.3.2：读字段自动 deref）
    pub fn detect_recovery_need(&self, messages: &[Arc<AgentMessage>]) -> Option<SteeringReason> {
        detect_recent_tool_error_loop(messages, self.max_consecutive_tool_errors)
            .or_else(|| detect_repeated_tool_call_loop(messages, self.max_repeated_tool_calls))
    }
}

impl Default for RecoverySteeringStrategy {
    fn default() -> Self {
        Self::new(RecoverySteeringStrategyOptions::default())
    }
}

impl SteeringStrategy for RecoverySteeringStrategy {
    fn name(&self) -> &'static str {
        "recovery"
    }

    fn phases(&self) -> &'static [SteeringPhase] {
        &[SteeringPhase::AfterTools, SteeringPhase::EmptyResponse]
    }

    fn evaluate(
        &self,
        phase: SteeringPhase,
        context: &SteeringContext<'_>,
    ) -> Option<SteeringAction> {
        match phase {
            SteeringPhase::EmptyResponse => {
                // D7：预算内重试注入；耗尽返回 intervention-required
                if context.steering_count >= self.max_steering_messages {
                    return Some(SteeringAction::InterventionRequired {
                        reason: SteeringReason::EmptyResponse,
                        message: Some(DEFAULT_INTERVENTION_MESSAGE.to_string()),
                    });
                }
                Some(SteeringAction::InjectMessage {
                    message: build_steering_message(
                        SteeringReason::EmptyResponse,
                        context.steering_count + 1,
                    ),
                    reason: SteeringReason::EmptyResponse,
                })
            }
            SteeringPhase::AfterTools => {
                let reason = self.detect_recovery_need(context.messages)?;
                if context.steering_count >= self.max_steering_messages {
                    return Some(SteeringAction::InterventionRequired {
                        reason,
                        message: Some(DEFAULT_INTERVENTION_MESSAGE.to_string()),
                    });
                }
                Some(SteeringAction::InjectMessage {
                    message: build_steering_message(reason, context.steering_count + 1),
                    reason,
                })
            }
            _ => None,
        }
    }
}

/// 检测最近连续工具错误环（对齐 TS detectRecentToolErrorLoop）
///
/// 自消息尾部向前扫描：跳过 system/assistant 消息，遇 user 消息停止；
/// 只统计 tool 消息的 `tool-result` 块。语义要点：
/// - 最近一条非失败的 tool-result 即判定无环（返回空）；
/// - `softDeny: true` 的失败结果不计（非真实失败）；
/// - 连续失败数达到 `min_errors` 即返回 `tool-errors`。
///
/// 载荷为 Arc 共享形态（PE-09 T09.3.2，读字段自动 deref）。
pub fn detect_recent_tool_error_loop(
    messages: &[Arc<AgentMessage>],
    min_errors: usize,
) -> Option<SteeringReason> {
    let mut errors = 0usize;
    for message in messages.iter().rev() {
        match message.role {
            AgentMessageRole::System | AgentMessageRole::Assistant => continue,
            AgentMessageRole::User => break,
            AgentMessageRole::Tool => {}
        }
        for block in &message.blocks {
            let AgentMessageBlock::ToolResult {
                output, is_error, ..
            } = block
            else {
                continue;
            };
            if !is_tool_result_failure(output, *is_error) {
                return None;
            }
            errors += 1;
            if errors >= min_errors {
                return Some(SteeringReason::ToolErrors);
            }
        }
    }
    None
}

/// 检测最近重复工具调用环（对齐 TS detectRepeatedToolCallLoop）
///
/// 自消息尾部向前扫描：遇 user 消息停止；统计 assistant 消息的
/// `tool-call` 块，签名 = `工具名:入参JSON`。同一签名出现次数达到
/// `min_repeats` 即返回 `tool-loop`。载荷为 Arc 共享形态（PE-09 T09.3.2）。
pub fn detect_repeated_tool_call_loop(
    messages: &[Arc<AgentMessage>],
    min_repeats: usize,
) -> Option<SteeringReason> {
    let mut counts: HashMap<String, usize> = HashMap::new();
    for message in messages.iter().rev() {
        if message.role == AgentMessageRole::User {
            break;
        }
        if message.role != AgentMessageRole::Assistant {
            continue;
        }
        for call in message.tool_calls() {
            let signature = format!(
                "{}:{}",
                call.tool_name,
                serde_json::to_string(&call.input).unwrap_or_default()
            );
            let next = counts.get(&signature).copied().unwrap_or(0) + 1;
            if next >= min_repeats {
                return Some(SteeringReason::ToolLoop);
            }
            counts.insert(signature, next);
        }
    }
    None
}

/// tool-result 是否真实失败（对齐 TS isToolResultFailure）
///
/// - `output.json.softDeny === true` → 非失败（审批软拒绝）；
/// - 块级 `is_error` → 失败；
/// - 输出中带非零退出码（json `exitCode`/`exit_code` 或文本
///   `Exit code: N`）→ 失败；退出码 0 → 非失败。
fn is_tool_result_failure(output: &ToolOutput, is_error: bool) -> bool {
    if let Some(json) = &output.json {
        if json
            .as_object()
            .and_then(|o| o.get("softDeny"))
            .and_then(|v| v.as_bool())
            == Some(true)
        {
            return false;
        }
    }
    if is_error {
        return true;
    }
    if let Some(json) = &output.json {
        for key in ["exitCode", "exit_code"] {
            if let Some(code) = json.get(key).and_then(|v| v.as_i64()) {
                return code != 0;
            }
        }
    }
    if let Some(text) = &output.text {
        if let Some(code) = exit_code_from_text(text) {
            return code != 0;
        }
    }
    false
}

/// 从文本中解析 `Exit code: N`（大小写不敏感，N 可为负）
fn exit_code_from_text(text: &str) -> Option<i64> {
    let needle = "exit code:";
    let lower = text.to_ascii_lowercase();
    let mut from = 0usize;
    while let Some(rel) = lower[from..].find(needle) {
        let start = from + rel + needle.len();
        let mut rest = lower[start..].trim_start().chars().peekable();
        let negative = rest.peek() == Some(&'-');
        if negative {
            rest.next();
        }
        let digits: String = rest.take_while(|c| c.is_ascii_digit()).collect();
        if !digits.is_empty() {
            // F3-01（P2 批 6）：非法数字段不得提前终止扫描——`?` 会把
            // "exit code: unknown\nexit code: 1" 误判为非失败；continue
            // 继续找后续合法段
            let Ok(magnitude) = digits.parse::<i64>() else {
                from = start;
                continue;
            };
            return Some(if negative { -magnitude } else { magnitude });
        }
        from = start;
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use crate::steering::testutil::{
        assistant_with_tool_calls, tool_result, tool_result_json, user,
    };

    fn context<'a>(
        messages: &'a [Arc<AgentMessage>],
        steering_count: usize,
    ) -> SteeringContext<'a> {
        SteeringContext {
            messages,
            turn_index: 0,
            steering_count,
            tool_call_count: 0,
            has_pending_input: false,
        }
    }

    /// 测试便捷层：owned 消息 → Arc 共享视图（PE-09 T09.3.2 后策略消费
    /// `&[Arc<AgentMessage>]`，测试构造统一经此转换）
    fn arc_messages(messages: Vec<AgentMessage>) -> Vec<Arc<AgentMessage>> {
        messages.into_iter().map(Arc::new).collect()
    }

    fn inject_of(action: SteeringAction) -> (AgentMessage, SteeringReason) {
        match action {
            SteeringAction::InjectMessage { message, reason } => (message, reason),
            other => panic!("应为 inject-message，实际 {other:?}"),
        }
    }

    /// 策略关注的阶段 = after-tools / empty-response（01 §3.1）
    #[test]
    fn phases_are_after_tools_and_empty_response() {
        let strategy = RecoverySteeringStrategy::default();
        assert_eq!(
            strategy.phases(),
            &[SteeringPhase::AfterTools, SteeringPhase::EmptyResponse]
        );
    }

    /// empty-response 第 1 次（计数 0 < 默认 1）：注入 system 消息（D7）
    #[test]
    fn empty_response_first_response_injects() {
        let strategy = RecoverySteeringStrategy::default();
        let (message, reason) = inject_of(
            strategy
                .evaluate(SteeringPhase::EmptyResponse, &context(&[], 0))
                .expect("第 1 次应注入"),
        );
        assert_eq!(reason, SteeringReason::EmptyResponse);
        assert_eq!(message.role, AgentMessageRole::System);
        assert!(!message.text().is_empty());
        let metadata = message.metadata.as_ref().expect("注入消息须带元数据");
        assert_eq!(metadata.get("kind").and_then(|k| k.as_str()), Some("runtime-steering"));
        assert_eq!(
            metadata.get("reason").and_then(|r| r.as_str()),
            Some("empty-response")
        );
        assert_eq!(
            metadata.get("steeringCount").and_then(|c| c.as_u64()),
            Some(1),
            "元数据 steeringCount = 注入后计数"
        );
    }

    /// empty-response 第 2 次（计数 1 >= 默认 1）：intervention-required（D7）
    #[test]
    fn empty_response_second_response_intervenes() {
        let strategy = RecoverySteeringStrategy::default();
        let action = strategy
            .evaluate(SteeringPhase::EmptyResponse, &context(&[], 1))
            .expect("第 2 次应返回干预");
        match action {
            SteeringAction::InterventionRequired { reason, message } => {
                assert_eq!(reason, SteeringReason::EmptyResponse);
                assert_eq!(message.as_deref(), Some(DEFAULT_INTERVENTION_MESSAGE));
            }
            other => panic!("应为 intervention-required，实际 {other:?}"),
        }
    }

    /// 边界 N-1/N：maxSteeringMessages=2 时第 1/2 次注入、第 3 次干预
    #[test]
    fn empty_response_custom_max_steering_messages_boundary() {
        let strategy = RecoverySteeringStrategy::new(RecoverySteeringStrategyOptions {
            max_steering_messages: Some(2),
            ..Default::default()
        });
        assert_eq!(
            strategy
                .evaluate(SteeringPhase::EmptyResponse, &context(&[], 0))
                .and_then(action_type),
            Some("inject")
        );
        assert_eq!(
            strategy
                .evaluate(SteeringPhase::EmptyResponse, &context(&[], 1))
                .and_then(action_type),
            Some("inject")
        );
        assert_eq!(
            strategy
                .evaluate(SteeringPhase::EmptyResponse, &context(&[], 2))
                .and_then(action_type),
            Some("intervention"),
            "计数达到 maxSteeringMessages 即干预"
        );
    }

    fn action_type(action: SteeringAction) -> Option<&'static str> {
        match action {
            SteeringAction::InjectMessage { .. } => Some("inject"),
            SteeringAction::EmitDiagnostic { .. } => Some("diagnostic"),
            SteeringAction::InterventionRequired { .. } => Some("intervention"),
        }
    }

    /// after-tools 无错误环、无重复调用：不产生动作
    #[test]
    fn after_tools_without_loop_returns_none() {
        let strategy = RecoverySteeringStrategy::default();
        let messages = arc_messages(vec![user("hi"), assistant_with_tool_calls(&[("read", json!({}))])]);
        assert!(strategy
            .evaluate(SteeringPhase::AfterTools, &context(&messages, 0))
            .is_none());
    }

    /// 错误环边界 N-1/N：连续 1 次错误不触发，2 次触发（默认阈值 2）
    #[test]
    fn tool_error_loop_threshold_n_minus_1_and_n() {
        let strategy = RecoverySteeringStrategy::default();
        let one_error = arc_messages(vec![tool_result("boom", true)]);
        assert!(
            strategy
                .evaluate(SteeringPhase::AfterTools, &context(&one_error, 0))
                .is_none(),
            "1 次错误 < 阈值 2 不触发"
        );

        let two_errors = arc_messages(vec![tool_result("boom-1", true), tool_result("boom-2", true)]);
        let (message, reason) = inject_of(
            strategy
                .evaluate(SteeringPhase::AfterTools, &context(&two_errors, 0))
                .expect("2 次连续错误应注入"),
        );
        assert_eq!(reason, SteeringReason::ToolErrors);
        assert_eq!(message.role, AgentMessageRole::System);
        assert!(
            message
                .metadata
                .as_ref()
                .and_then(|m| m.get("reason"))
                .and_then(|r| r.as_str())
                == Some("tool-errors")
        );
    }

    /// 错误环被成功结果打断：不触发（最近一条非失败即判定无环）
    #[test]
    fn tool_error_loop_interrupted_by_success() {
        let strategy = RecoverySteeringStrategy::default();
        // 最近是成功：即使之前有失败也不触发
        let success_last = arc_messages(vec![tool_result("boom", true), tool_result("ok", false)]);
        assert!(strategy
            .evaluate(SteeringPhase::AfterTools, &context(&success_last, 0))
            .is_none());
        // 最近是失败但前一条成功：不构成连续环
        let error_last = arc_messages(vec![tool_result("ok", false), tool_result("boom", true)]);
        assert!(strategy
            .evaluate(SteeringPhase::AfterTools, &context(&error_last, 0))
            .is_none());
    }

    /// softDeny 的失败结果不计入错误环
    #[test]
    fn soft_deny_is_not_a_failure() {
        let strategy = RecoverySteeringStrategy::default();
        let messages = arc_messages(vec![
            tool_result_json(true, serde_json::json!({"softDeny": true})),
            tool_result_json(true, serde_json::json!({"softDeny": true})),
        ]);
        assert!(strategy
            .evaluate(SteeringPhase::AfterTools, &context(&messages, 0))
            .is_none(), "softDeny 不构成错误环");
    }

    /// json 退出码判定失败：非零算失败、零不算
    #[test]
    fn exit_code_from_json_judges_failure() {
        let strategy = RecoverySteeringStrategy::default();
        let nonzero = arc_messages(vec![
            tool_result_json(false, serde_json::json!({"exitCode": 1})),
            tool_result_json(false, serde_json::json!({"exit_code": 2})),
        ]);
        let (_, reason) = inject_of(
            strategy
                .evaluate(SteeringPhase::AfterTools, &context(&nonzero, 0))
                .expect("非零退出码应触发"),
        );
        assert_eq!(reason, SteeringReason::ToolErrors);

        let zero = arc_messages(vec![
            tool_result_json(false, serde_json::json!({"exitCode": 0})),
            tool_result_json(false, serde_json::json!({"exitCode": 0})),
        ]);
        assert!(strategy
            .evaluate(SteeringPhase::AfterTools, &context(&zero, 0))
            .is_none(), "退出码 0 非失败");
    }

    /// 文本 `Exit code: N` 判定失败（大小写不敏感）
    #[test]
    fn exit_code_from_text_judges_failure() {
        let strategy = RecoverySteeringStrategy::default();
        let nonzero = arc_messages(vec![
            tool_result("exit code: 127", false),
            tool_result("EXIT CODE: -1", false),
        ]);
        let (_, reason) = inject_of(
            strategy
                .evaluate(SteeringPhase::AfterTools, &context(&nonzero, 0))
                .expect("文本非零退出码应触发"),
        );
        assert_eq!(reason, SteeringReason::ToolErrors);

        let zero = arc_messages(vec![
            tool_result("Exit code: 0", false),
            tool_result("exit code: 0", false),
        ]);
        assert!(strategy
            .evaluate(SteeringPhase::AfterTools, &context(&zero, 0))
            .is_none());
    }

    /// F1 盲区 9 / F3-01：非法数字段（`exit code: unknown`）之后跟合法段
    /// （`exit code: 1`）——扫描必须继续，不得提前 `?` 返回 None 误判为
    /// 成功（修复前：`digits.parse().ok()?` 遇非法段提前终止，漏判失败）
    #[test]
    fn exit_code_invalid_segment_continues_scanning() {
        let strategy = RecoverySteeringStrategy::default();
        // 连续失败阈值 2：两条消息均为「非法段 + 合法非零段」形态
        let invalid_then_valid = arc_messages(vec![
            tool_result("exit code: unknown\nexit code: 1", false),
            tool_result("exit code: n/a\nexit code: 127", false),
        ]);
        let (_, reason) = inject_of(
            strategy
                .evaluate(SteeringPhase::AfterTools, &context(&invalid_then_valid, 0))
                .expect("非法段后的合法非零退出码必须触发"),
        );
        assert_eq!(reason, SteeringReason::ToolErrors);

        // 反向：非法段后跟合法零 → 不触发（continue 后正确归零）
        let invalid_then_zero = arc_messages(vec![
            tool_result("exit code: unknown\nexit code: 0", false),
        ]);
        assert!(strategy
            .evaluate(SteeringPhase::AfterTools, &context(&invalid_then_zero, 0))
            .is_none(), "非法段后合法零退出码不触发");
    }

    /// 重复调用环边界 N-1/N：同签名 2 次不触发、3 次触发（默认阈值 3）
    #[test]
    fn repeated_tool_call_loop_threshold() {
        let strategy = RecoverySteeringStrategy::default();
        let input = serde_json::json!({"path": "a.txt"});
        // 同一 assistant 消息内 2 次
        let twice_same = arc_messages(vec![assistant_with_tool_calls(&[
            ("read", input.clone()),
            ("read", input.clone()),
        ])]);
        assert!(strategy
            .evaluate(SteeringPhase::AfterTools, &context(&twice_same, 0))
            .is_none(), "2 次 < 阈值 3 不触发");

        let three_same = arc_messages(vec![assistant_with_tool_calls(&[
            ("read", input.clone()),
            ("read", input.clone()),
            ("read", input),
        ])]);
        let (_, reason) = inject_of(
            strategy
                .evaluate(SteeringPhase::AfterTools, &context(&three_same, 0))
                .expect("3 次重复应触发"),
        );
        assert_eq!(reason, SteeringReason::ToolLoop);
    }

    /// 重复调用跨多条 assistant 消息累计
    #[test]
    fn repeated_loop_accumulates_across_messages() {
        let strategy = RecoverySteeringStrategy::default();
        let input = serde_json::json!({"query": "x"});
        let messages = arc_messages(vec![
            assistant_with_tool_calls(&[("search", input.clone())]),
            assistant_with_tool_calls(&[("search", input.clone())]),
            assistant_with_tool_calls(&[("search", input.clone())]),
        ]);
        let (_, reason) = inject_of(
            strategy
                .evaluate(SteeringPhase::AfterTools, &context(&messages, 0))
                .expect("跨消息累计 3 次应触发"),
        );
        assert_eq!(reason, SteeringReason::ToolLoop);
    }

    /// 重复调用统计在 user 消息处截止（之前的调用不算）
    #[test]
    fn repeated_loop_stops_at_user_boundary() {
        let strategy = RecoverySteeringStrategy::default();
        let input = serde_json::json!({"query": "x"});
        // user 之前的 1 次 + user 之后 2 次：不跨边界累计
        let messages = arc_messages(vec![
            user("first"),
            assistant_with_tool_calls(&[("search", input.clone())]),
            user("second"),
            assistant_with_tool_calls(&[("search", input.clone())]),
            assistant_with_tool_calls(&[("search", input.clone())]),
        ]);
        assert!(strategy
            .evaluate(SteeringPhase::AfterTools, &context(&messages, 0))
            .is_none(), "user 边界截断累计");

        // 去掉 user：3 次连续累计触发
        let messages = arc_messages(vec![
            assistant_with_tool_calls(&[("search", input.clone())]),
            assistant_with_tool_calls(&[("search", input.clone())]),
            assistant_with_tool_calls(&[("search", input)]),
        ]);
        assert!(strategy
            .evaluate(SteeringPhase::AfterTools, &context(&messages, 0))
            .is_some());
    }

    /// 错误环检测同样在 user 消息处截止
    #[test]
    fn tool_error_loop_stops_at_user_boundary() {
        let strategy = RecoverySteeringStrategy::default();
        let messages = arc_messages(vec![
            tool_result("boom-1", true),
            tool_result("boom-2", true),
            user("user again"),
            tool_result("boom-3", true),
        ]);
        assert!(strategy
            .evaluate(SteeringPhase::AfterTools, &context(&messages, 0))
            .is_none(), "user 边界截断错误环检测");
    }

    /// after-tools 预算耗尽：检测到环仍返回 intervention-required（D9）
    #[test]
    fn after_tools_budget_exhausted_intervenes_with_detected_reason() {
        let strategy = RecoverySteeringStrategy::default();
        let messages = arc_messages(vec![tool_result("boom-1", true), tool_result("boom-2", true)]);
        let action = strategy
            .evaluate(SteeringPhase::AfterTools, &context(&messages, 1))
            .expect("检测到环且预算耗尽应干预");
        match action {
            SteeringAction::InterventionRequired { reason, .. } => {
                assert_eq!(reason, SteeringReason::ToolErrors, "干预携带检测到的原因")
            }
            other => panic!("应为 intervention-required，实际 {other:?}"),
        }
    }

    /// after-tools 注入消息元数据带注入后计数
    #[test]
    fn after_tools_inject_metadata_steering_count() {
        // 自定义策略预算 3，当前计数 2 时仍在预算内注入
        let strategy = RecoverySteeringStrategy::new(RecoverySteeringStrategyOptions {
            max_steering_messages: Some(3),
            ..Default::default()
        });
        let messages = arc_messages(vec![tool_result("boom-1", true), tool_result("boom-2", true)]);
        let (message, _) = inject_of(
            strategy
                .evaluate(SteeringPhase::AfterTools, &context(&messages, 2))
                .expect("计数 2 < 预算 3，应注入"),
        );
        assert_eq!(
            message
                .metadata
                .as_ref()
                .and_then(|m| m.get("steeringCount"))
                .and_then(|c| c.as_u64()),
            Some(3),
            "元数据 steeringCount = 注入后计数（当前计数 + 1）"
        );
    }
}
