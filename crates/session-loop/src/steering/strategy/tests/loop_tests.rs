use super::*;

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

    let two_errors = arc_messages(vec![
        tool_result("boom-1", true),
        tool_result("boom-2", true),
    ]);
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
    assert!(
        strategy
            .evaluate(SteeringPhase::AfterTools, &context(&messages, 0))
            .is_none(),
        "softDeny 不构成错误环"
    );
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
    assert!(
        strategy
            .evaluate(SteeringPhase::AfterTools, &context(&zero, 0))
            .is_none(),
        "退出码 0 非失败"
    );
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
    let invalid_then_zero =
        arc_messages(vec![tool_result("exit code: unknown\nexit code: 0", false)]);
    assert!(
        strategy
            .evaluate(SteeringPhase::AfterTools, &context(&invalid_then_zero, 0))
            .is_none(),
        "非法段后合法零退出码不触发"
    );
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
    assert!(
        strategy
            .evaluate(SteeringPhase::AfterTools, &context(&twice_same, 0))
            .is_none(),
        "2 次 < 阈值 3 不触发"
    );

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
    assert!(
        strategy
            .evaluate(SteeringPhase::AfterTools, &context(&messages, 0))
            .is_none(),
        "user 边界截断累计"
    );

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
    assert!(
        strategy
            .evaluate(SteeringPhase::AfterTools, &context(&messages, 0))
            .is_none(),
        "user 边界截断错误环检测"
    );
}
