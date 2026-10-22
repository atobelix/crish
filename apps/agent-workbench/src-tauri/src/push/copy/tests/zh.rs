use super::*;
use crate::push::engine::DecisionOutcome;

/// S1 审批请求：样例「Crish 需要你的批准」+「bash：执行部署脚本…」
#[test]
fn s1_approval_requested_copy() {
    assert_copy(
        SceneId::ApprovalRequested,
        Some("执行部署脚本"),
        Some("bash"),
        "Crish 需要你的批准",
        "bash：执行部署脚本",
    );
}

/// S2 审批过期：样例「审批已过期」+「bash 调用（tc-9f3a）等待超时…」——
/// toolName 不在载荷，按 toolCallId 降级
#[test]
fn s2_approval_expired_copy() {
    let copy = render_copy(SceneId::ApprovalExpired, &payload("tc-9f3a", None, None));
    assert_eq!(copy.title, "审批已过期");
    assert_eq!(copy.body, "审批（tc-9f3a）等待超时，已自动拒绝");
}

/// S3/S4/S5 run 终态：样例对齐（S4 正文 = `{runId}：{error}`）
#[test]
fn s3_s4_s5_run_terminal_copy() {
    assert_copy(
        SceneId::RunCompleted,
        None,
        None,
        "任务已完成",
        "任务 run-42 已完成",
    );
    assert_copy(
        SceneId::RunFailed,
        Some("provider 返回 401，API 密钥可能已失效"),
        None,
        "任务运行失败",
        "run-42：provider 返回 401，API 密钥可能已失效",
    );
    assert_copy(
        SceneId::RunCancelled,
        None,
        None,
        "任务已取消",
        "任务 run-42 已被取消",
    );
}

/// S6/S7 子代理终态：样例对齐（role 不在载荷降级省略；summary 存在追加）
#[test]
fn s6_s7_subagent_copy() {
    let copy = render_copy(
        SceneId::SubagentCompleted,
        &payload("sa-3", Some("已产出缺口分析 5 页"), None),
    );
    assert_eq!(copy.title, "子代理已完成");
    assert_eq!(copy.body, "子代理（sa-3）已完成：成功——已产出缺口分析 5 页");

    let copy = render_copy(
        SceneId::SubagentFailed,
        &payload("sa-4", Some("工具执行超时"), None),
    );
    assert_eq!(copy.title, "子代理失败");
    assert_eq!(copy.body, "子代理（sa-4）失败——工具执行超时");

    // summary 缺失：不残留空拼接
    let copy = render_copy(SceneId::SubagentCompleted, &payload("sa-5", None, None));
    assert_eq!(copy.body, "子代理（sa-5）已完成：成功");
}

/// S8 任务域：S8c 样例逐字对齐（「任务 t-12 疑似卡死（120 秒无输出）」）
#[test]
fn s8_task_domain_copy() {
    assert_copy(
        SceneId::TaskStarted,
        Some("npm run build"),
        None,
        "后台任务已启动",
        "npm run build",
    );
    assert_copy(
        SceneId::TaskCompleted,
        None,
        Some("exit code 0"),
        "任务已完成",
        "任务 run-42 已完成，exit code 0",
    );
    let copy = render_copy(SceneId::TaskSuspicious, &payload("t-12", Some("120"), None));
    assert_eq!(copy.title, "任务疑似卡死");
    assert_eq!(
        copy.body, "任务 t-12 疑似卡死（120 秒无输出）",
        "D7 §3.3.13 S8c 样例逐字对齐"
    );
    assert_copy(
        SceneId::TaskFailed,
        Some("构建报错"),
        Some("exit code 1"),
        "后台任务异常退出",
        "任务 run-42 异常退出（exit code 1）",
    );
    assert_copy(
        SceneId::TaskKilled,
        None,
        None,
        "任务已终止",
        "任务 run-42 已被终止",
    );
}

/// S9 定时器/cron：样例对齐（S9a 逐字；S9b 第 n 次触发取自 iteration）
#[test]
fn s9_timer_cron_copy() {
    let copy = render_copy(
        SceneId::TimerFired,
        &payload("timer-1", Some("请检查任务进度"), None),
    );
    assert_eq!(copy.title, "定时器提醒");
    assert_eq!(
        copy.body, "请检查任务进度（定时器 timer-1 已到期）",
        "D7 §3.3.13 S9a 样例逐字对齐"
    );

    let copy = render_copy(
        SceneId::CronFired,
        &payload("cron-2", Some("日报"), Some("iteration 3")),
    );
    assert_eq!(copy.body, "日报（cron cron-2 第 3 次触发）");

    // iteration 缺失：不残留占位
    let copy = render_copy(SceneId::CronFired, &payload("cron-2", Some("日报"), None));
    assert_eq!(copy.body, "日报（cron cron-2 已触发）");
}

/// S10 异常域：标题承载场景语义，正文 = error/reason
#[test]
fn s10_runtime_copy() {
    assert_copy(
        SceneId::RuntimeError,
        Some("provider 5xx"),
        None,
        "运行异常",
        "provider 5xx",
    );
    assert_copy(
        SceneId::InterventionRequired,
        Some("缺少 API 密钥"),
        None,
        "需要你介入",
        "缺少 API 密钥",
    );
}

/// S11 安全拦截：样例「拦截删除操作」——操作 wire → 中文映射
#[test]
fn s11_security_copy_operation_map() {
    let copy = render_copy(
        SceneId::SecurityBlocked,
        &payload("tc-9f4b", Some("Delete"), None),
    );
    assert_eq!(copy.title, "安全拦截");
    assert_eq!(copy.body, "拦截删除操作", "D7 §3.3.13 S11 样例对齐");
    for (wire, expected) in [
        ("TrashRestore", "恢复"),
        ("TrashPurge", "彻底清除"),
        ("GitRevert", "Git 回退"),
        ("CommandExec", "命令执行"),
        ("UndeclaredWrite", "未声明写入"),
    ] {
        let copy = render_copy(SceneId::SecurityBlocked, &payload("tc-1", Some(wire), None));
        assert_eq!(copy.body, format!("拦截{expected}操作"), "操作 {wire}");
    }
    // 未知操作：保留原串（枚举冻结护栏）
    let copy = render_copy(
        SceneId::SecurityBlocked,
        &payload("tc-1", Some("FutureOp"), None),
    );
    assert_eq!(copy.body, "拦截FutureOp操作");
}

/// S12 缓存告警：样例「本次运行浪费约 24,000 token（约 $0.12）」——
/// 千分位为示意，按载荷原值渲染；cost 缺失降级
#[test]
fn s12_cache_waste_copy() {
    let copy = render_copy(
        SceneId::CacheWasteAlert,
        &payload("run-42", Some("24000"), Some("0.12")),
    );
    assert_eq!(copy.title, "缓存浪费告警");
    assert_eq!(copy.body, "本次运行浪费约 24000 token（约 $0.12）");
    let copy = render_copy(
        SceneId::CacheWasteAlert,
        &payload("run-42", Some("24000"), None),
    );
    assert_eq!(copy.body, "本次运行浪费约 24000 token");
}

/// 18 场景全量扫掠：标题非空 + 无占位符残留（`<...>` 模板泄漏护栏，
/// 对齐 wakeup_summary.rs 的断言模式）
#[test]
fn all_scenes_render_without_placeholder_leak() {
    let cases: Vec<(SceneId, Option<&str>, Option<&str>)> = vec![
        (
            SceneId::ApprovalRequested,
            Some("执行部署脚本"),
            Some("bash"),
        ),
        (SceneId::ApprovalExpired, None, None),
        (SceneId::RunCompleted, None, None),
        (SceneId::RunFailed, Some("provider 401"), None),
        (SceneId::RunCancelled, None, None),
        (
            SceneId::SubagentCompleted,
            Some("已产出缺口分析 5 页"),
            None,
        ),
        (SceneId::SubagentFailed, Some("工具执行超时"), None),
        (SceneId::TaskStarted, Some("npm run build"), None),
        (SceneId::TaskCompleted, None, Some("exit code 0")),
        (SceneId::TaskSuspicious, Some("120"), None),
        (SceneId::TaskFailed, Some("构建报错"), Some("exit code 1")),
        (SceneId::TaskKilled, None, None),
        (SceneId::TimerFired, Some("请检查任务进度"), None),
        (SceneId::CronFired, Some("日报"), Some("iteration 3")),
        (SceneId::RuntimeError, Some("provider 5xx"), None),
        (SceneId::InterventionRequired, Some("缺少 API 密钥"), None),
        (SceneId::SecurityBlocked, Some("Delete"), None),
        (SceneId::CacheWasteAlert, Some("24000"), Some("0.12")),
    ];
    assert_eq!(cases.len(), 18, "M8 §3.2.3 18 行登记");
    for (scene, digest, detail) in cases {
        let copy = render_copy(scene, &payload("run-42", digest, detail));
        assert!(!copy.title.is_empty(), "场景 {scene:?} 标题非空");
        assert!(
            !copy.title.contains('<') && !copy.body.contains('<'),
            "场景 {scene:?} 无占位符残留：title={} body={}",
            copy.title,
            copy.body
        );
    }
}

/// message_with_copy 组装：title/body 填充 + 其余 schema 字段保持
/// （with_copy 接线入口验证）
#[test]
fn message_with_copy_fills_title_body_keeps_fields() {
    let decision = PushDecision {
        deliver: true,
        scene: SceneId::RunFailed,
        level: SceneId::RunFailed.level(),
        severity: SceneId::RunFailed.level().severity(),
        dedupe_key: "run-terminal:run-42:failed".to_string(),
        payload: payload("run-42", Some("provider 401"), None),
        outcome: DecisionOutcome::Delivered,
    };
    let message = message_with_copy(&decision, "push-000001".to_string(), 1, T0);
    assert_eq!(message.title.as_deref(), Some("任务运行失败"));
    assert_eq!(message.body.as_deref(), Some("run-42：provider 401"));
    assert_eq!(message.event_type, "run-terminal", "其余字段不变");
    assert_eq!(message.dedupe_key, "run-terminal:run-42:failed");
    assert_eq!(message.target.params["runId"], "run-42");
    // serde wire：title/body 出现（不再缺省跳过）
    let json = serde_json::to_value(&message).expect("可序列化");
    assert_eq!(json["title"], "任务运行失败");
    assert_eq!(json["body"], "run-42：provider 401");
}
