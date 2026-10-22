//! 时间戳格式、evaluate_traced 观测轨迹与 steering-evaluated 事件组装。

use super::*;
use conex_shared::time::{civil_from_days, now_iso_utc, unix_millis};
use conex_types::events::AgentEvent;

/// 时间戳格式：UTC ISO8601 毫秒精度
#[test]
fn now_iso_utc_formats_iso8601() {
    let ts = now_iso_utc();
    assert!(ts.len() >= 24, "含毫秒与 Z 后缀");
    assert!(ts.ends_with('Z'));
    let mid = &ts[..ts.len() - 1];
    let date_part = &mid[..10];
    assert_eq!(&date_part[4..5], "-");
    assert_eq!(&date_part[7..8], "-");
    let time_part = &mid[11..];
    assert_eq!(&time_part[2..3], ":");
    assert_eq!(&time_part[5..6], ":");
    assert_eq!(&time_part[8..9], ".");
}

/// 日期换算：Unix 天数 0 与已知基准（2026-07-31 = 20665）
#[test]
fn civil_from_days_known_dates() {
    assert_eq!(civil_from_days(0), (1970, 1, 1));
    assert_eq!(civil_from_days(1), (1970, 1, 2));
    assert_eq!(civil_from_days(20665), (2026, 7, 31));
}

/// EV-03（D-03）：evaluate_traced 命中轨迹——命中时 hit_strategies
/// 含策略名、计数前后 = 实际/潜在计数；无命中（阶段未注册）时为空且
/// 计数不变
#[test]
fn evaluate_traced_reports_hit_strategies_and_potential_count() {
    let mut coordinator = SteeringCoordinator::new(
        vec![Box::new(FixedStrategy {
            phases: &[SteeringPhase::EmptyResponse],
            action: SteeringAction::InjectMessage {
                message: fake_steering_message(),
                reason: SteeringReason::EmptyResponse,
            },
        })],
        SteeringCoordinatorOptions {
            max_steering_budget: Some(3),
        },
    );
    let mut conversation = Vec::new();

    // 命中：evaluate_traced 返回轨迹（命中名 + 潜在计数 0→1）
    let (actions, trace) =
        coordinator.evaluate_traced(SteeringPhase::EmptyResponse, &empty_context());
    assert_eq!(actions.len(), 1);
    assert_eq!(trace.hit_strategies, vec!["fixed".to_string()]);
    assert_eq!(trace.steering_count_before, 0);
    assert_eq!(trace.steering_count_after, 1, "潜在计数含本次注入预占");

    // apply 后实际计数 +1；预算剩余 = 3 − 1 = 2
    coordinator.apply(&actions, "sess-1", &mut conversation);
    assert_eq!(coordinator.get_steering_count(), 1);
    assert_eq!(coordinator.budget_remaining(), 2);

    // 未关注阶段：空命中轨迹（hit 空、计数不变）
    let (actions, trace) = coordinator.evaluate_traced(SteeringPhase::AfterTools, &empty_context());
    assert!(actions.is_empty());
    assert!(trace.hit_strategies.is_empty());
    assert_eq!(trace.steering_count_before, 1);
    assert_eq!(trace.steering_count_after, 1);
}

/// EV-03（D-03）：预算耗尽跳过 inject-message 时策略仍计入命中
/// （「命中但未注入」属观测对象——budget-exhausted 诊断路径）
#[test]
fn evaluate_traced_counts_hit_even_when_budget_skips() {
    let mut coordinator = SteeringCoordinator::new(
        vec![Box::new(FixedStrategy {
            phases: &[SteeringPhase::EmptyResponse],
            action: SteeringAction::InjectMessage {
                message: fake_steering_message(),
                reason: SteeringReason::EmptyResponse,
            },
        })],
        SteeringCoordinatorOptions {
            max_steering_budget: Some(1),
        },
    );
    let mut conversation = Vec::new();
    // 首轮注入（计数 0→1）
    let (actions, trace) =
        coordinator.evaluate_traced(SteeringPhase::EmptyResponse, &empty_context());
    assert_eq!(trace.hit_strategies, vec!["fixed".to_string()]);
    coordinator.apply(&actions, "sess-1", &mut conversation);
    assert_eq!(coordinator.get_steering_count(), 1);
    // 预算耗尽：策略命中但动作被跳过为 budget-exhausted 诊断——
    // hit_strategies 仍含策略名，潜在计数不再增长
    let (actions, trace) =
        coordinator.evaluate_traced(SteeringPhase::EmptyResponse, &empty_context());
    assert_eq!(trace.hit_strategies, vec!["fixed".to_string()]);
    assert_eq!(trace.steering_count_after, 1, "预算跳过不预占计数");
    assert!(matches!(
        actions.as_slice(),
        [SteeringAction::EmitDiagnostic { reason, .. }]
            if reason == "steering-budget-exhausted"
    ));
}

/// EV-03（D-03）：steering_evaluated_event 载荷组装——evaluate 变体
/// （reset=false）与 reset 变体（reset=true、计数清零）字段可 grep
#[test]
fn steering_evaluated_event_carries_trace_and_reset_flag() {
    let trace = SteeringEvaluationTrace {
        hit_strategies: vec!["recovery".to_string()],
        steering_count_before: 0,
        steering_count_after: 1,
    };
    let evaluate_event = steering_evaluated_event(
        "sess-1",
        SteeringPhase::EmptyResponse.as_str(),
        &trace,
        Some(2),
        false,
    );
    match evaluate_event {
        AgentEvent::SteeringEvaluated {
            session_id,
            phase,
            hit_strategies,
            steering_count_before,
            steering_count_after,
            budget_remaining,
            reset,
            ..
        } => {
            assert_eq!(session_id, "sess-1");
            assert_eq!(phase, "empty-response");
            assert_eq!(hit_strategies, vec!["recovery".to_string()]);
            assert_eq!(steering_count_before, 0);
            assert_eq!(steering_count_after, 1);
            assert_eq!(budget_remaining, Some(2));
            assert!(!reset);
        }
        other => panic!("应为 SteeringEvaluated，实际 {other:?}"),
    }
    // reset 变体：空命中 + before/0
    let reset_event = steering_evaluated_event(
        "sess-1",
        "no-tool-calls",
        &SteeringEvaluationTrace::reset(3),
        Some(3),
        true,
    );
    match reset_event {
        AgentEvent::SteeringEvaluated {
            phase,
            hit_strategies,
            steering_count_before,
            steering_count_after,
            reset,
            ..
        } => {
            assert_eq!(phase, "no-tool-calls");
            assert!(hit_strategies.is_empty());
            assert_eq!(steering_count_before, 3);
            assert_eq!(steering_count_after, 0);
            assert!(reset);
        }
        other => panic!("应为 SteeringEvaluated，实际 {other:?}"),
    }
}

/// EV-09（D-03）：iso_from_epoch_ms 与 now_iso_utc 同格式同精度
/// （YYYY-MM-DDTHH:MM:SS.mmmZ；occurred_at 打点回填 tool 域事件）
#[test]
fn iso_from_epoch_ms_matches_now_format() {
    // 格式形状（与 now_iso_utc 同布局，确定性断言不依赖墙钟跳动）
    let iso = iso_from_epoch_ms(unix_millis() as u64);
    assert_eq!(iso.len(), 24, "含毫秒与 Z 后缀");
    assert!(iso.ends_with('Z'));
    let mid = &iso[..iso.len() - 1];
    assert_eq!(&mid[4..5], "-");
    assert_eq!(&mid[7..8], "-");
    assert_eq!(&mid[10..11], "T");
    assert_eq!(&mid[13..14], ":");
    assert_eq!(&mid[16..17], ":");
    assert_eq!(&mid[19..20], ".");
    // 已知锚点：0 → 1970-01-01T00:00:00.000Z；2026-08-01 10:30:45.123
    assert_eq!(iso_from_epoch_ms(0), "1970-01-01T00:00:00.000Z");
    assert_eq!(
        iso_from_epoch_ms(20_666 * 86_400_000 + 10 * 3_600_000 + 30 * 60_000 + 45_123),
        "2026-08-01T10:30:45.123Z"
    );
}
