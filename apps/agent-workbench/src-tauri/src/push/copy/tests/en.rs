use super::*;

/// S1 审批请求（英文）：Crish Needs Your Approval + detail: digest
#[test]
fn s1_approval_requested_copy_en() {
    assert_copy_en(
        SceneId::ApprovalRequested,
        Some("Deploy to production"),
        Some("bash"),
        "Crish Needs Your Approval",
        "bash: Deploy to production",
    );
}

/// S2 审批过期（英文）
#[test]
fn s2_approval_expired_copy_en() {
    let copy = render_copy_with_locale(
        SceneId::ApprovalExpired,
        &payload("tc-9f3a", None, None),
        Some("en-US"),
    );
    assert_eq!(copy.title, "Approval Request Expired");
    assert_eq!(
        copy.body,
        "Approval request (tc-9f3a) timed out and was automatically rejected"
    );
}

/// S3/S4/S5 run 终态（英文）
#[test]
fn s3_s4_s5_run_terminal_copy_en() {
    assert_copy_en(
        SceneId::RunCompleted,
        None,
        None,
        "Run Completed",
        "Run run-42 completed successfully",
    );
    assert_copy_en(
        SceneId::RunFailed,
        Some("provider returned 401, API key expired"),
        None,
        "Run Failed",
        "run-42: provider returned 401, API key expired",
    );
    assert_copy_en(
        SceneId::RunCancelled,
        None,
        None,
        "Run Cancelled",
        "Run run-42 has been cancelled",
    );
}

/// S6/S7 子代理终态（英文）
#[test]
fn s6_s7_subagent_copy_en() {
    let copy = render_copy_with_locale(
        SceneId::SubagentCompleted,
        &payload("sa-3", Some("5 pages gap analysis produced"), None),
        Some("en-US"),
    );
    assert_eq!(copy.title, "Subagent Completed");
    assert_eq!(
        copy.body,
        "Subagent (sa-3) completed successfully - 5 pages gap analysis produced"
    );

    let copy = render_copy_with_locale(
        SceneId::SubagentFailed,
        &payload("sa-4", Some("Tool execution timed out"), None),
        Some("en-US"),
    );
    assert_eq!(copy.title, "Subagent Failed");
    assert_eq!(
        copy.body,
        "Subagent (sa-4) failed - Tool execution timed out"
    );

    // summary 缺失
    let copy = render_copy_with_locale(
        SceneId::SubagentCompleted,
        &payload("sa-5", None, None),
        Some("en-US"),
    );
    assert_eq!(copy.body, "Subagent (sa-5) completed successfully");
}

/// S8 任务域（英文）
#[test]
fn s8_task_domain_copy_en() {
    assert_copy_en(
        SceneId::TaskStarted,
        Some("npm run build"),
        None,
        "Background Task Started",
        "npm run build",
    );
    assert_copy_en(
        SceneId::TaskCompleted,
        None,
        Some("exit code 0"),
        "Task Completed",
        "Task run-42 completed, exit code 0",
    );
    let copy = render_copy_with_locale(
        SceneId::TaskSuspicious,
        &payload("t-12", Some("120"), None),
        Some("en-US"),
    );
    assert_eq!(copy.title, "Task Suspected Stalled");
    assert_eq!(
        copy.body,
        "Task t-12 suspected stalled (no output for 120s)"
    );

    assert_copy_en(
        SceneId::TaskFailed,
        Some("build error"),
        Some("exit code 1"),
        "Background Task Failed",
        "Task run-42 exited abnormally (exit code 1)",
    );
    assert_copy_en(
        SceneId::TaskKilled,
        None,
        None,
        "Task Terminated",
        "Task run-42 has been terminated",
    );
}

/// S9 定时器/cron（英文）
#[test]
fn s9_timer_cron_copy_en() {
    let copy = render_copy_with_locale(
        SceneId::TimerFired,
        &payload("timer-1", Some("Please review PR"), None),
        Some("en-US"),
    );
    assert_eq!(copy.title, "Timer Reminder");
    assert_eq!(copy.body, "Please review PR (Timer timer-1 expired)");

    let copy = render_copy_with_locale(
        SceneId::CronFired,
        &payload("cron-2", Some("Daily digest"), Some("iteration 3")),
        Some("en-US"),
    );
    assert_eq!(copy.title, "Scheduled Reminder");
    assert_eq!(
        copy.body,
        "Daily digest (Cron cron-2 triggered iteration 3)"
    );

    // iteration 缺失
    let copy = render_copy_with_locale(
        SceneId::CronFired,
        &payload("cron-2", Some("Daily digest"), None),
        Some("en-US"),
    );
    assert_eq!(copy.body, "Daily digest (Cron cron-2 triggered)");
}

/// S10 异常域（英文）
#[test]
fn s10_runtime_copy_en() {
    assert_copy_en(
        SceneId::RuntimeError,
        Some("provider 5xx error"),
        None,
        "Runtime Error",
        "provider 5xx error",
    );
    assert_copy_en(
        SceneId::InterventionRequired,
        Some("Missing API key"),
        None,
        "Intervention Required",
        "Missing API key",
    );
}

/// S11 安全拦截（英文）：操作 wire → 英文映射
#[test]
fn s11_security_copy_operation_map_en() {
    let copy = render_copy_with_locale(
        SceneId::SecurityBlocked,
        &payload("tc-9f4b", Some("Delete"), None),
        Some("en-US"),
    );
    assert_eq!(copy.title, "Security Interception");
    assert_eq!(copy.body, "Blocked delete operation");
    for (wire, expected) in [
        ("TrashRestore", "trash restore"),
        ("TrashPurge", "trash purge"),
        ("GitRevert", "git revert"),
        ("CommandExec", "command execution"),
        ("UndeclaredWrite", "undeclared write"),
    ] {
        let copy = render_copy_with_locale(
            SceneId::SecurityBlocked,
            &payload("tc-1", Some(wire), None),
            Some("en-US"),
        );
        assert_eq!(
            copy.body,
            format!("Blocked {expected} operation"),
            "操作 {wire}"
        );
    }
    // 未知操作：保留原串
    let copy = render_copy_with_locale(
        SceneId::SecurityBlocked,
        &payload("tc-1", Some("FutureOp"), None),
        Some("en-US"),
    );
    assert_eq!(copy.body, "Blocked FutureOp operation");
}

/// S12 缓存告警（英文）
#[test]
fn s12_cache_waste_copy_en() {
    let copy = render_copy_with_locale(
        SceneId::CacheWasteAlert,
        &payload("run-42", Some("24000"), Some("0.12")),
        Some("en-US"),
    );
    assert_eq!(copy.title, "Cache Waste Alert");
    assert_eq!(
        copy.body,
        "Wasted approximately 24000 tokens in this run (approx. $0.12)"
    );
    let copy = render_copy_with_locale(
        SceneId::CacheWasteAlert,
        &payload("run-42", Some("24000"), None),
        Some("en-US"),
    );
    assert_eq!(copy.body, "Wasted approximately 24000 tokens in this run");
}

/// 18 场景全量扫掠（英文）：标题非空 + 无占位符残留
#[test]
fn all_scenes_render_english_without_placeholder_leak() {
    let cases: Vec<(SceneId, Option<&str>, Option<&str>)> = vec![
        (
            SceneId::ApprovalRequested,
            Some("Deploy to production"),
            Some("bash"),
        ),
        (SceneId::ApprovalExpired, None, None),
        (SceneId::RunCompleted, None, None),
        (SceneId::RunFailed, Some("provider 401"), None),
        (SceneId::RunCancelled, None, None),
        (
            SceneId::SubagentCompleted,
            Some("5 pages gap analysis produced"),
            None,
        ),
        (SceneId::SubagentFailed, Some("Tool timeout"), None),
        (SceneId::TaskStarted, Some("npm run build"), None),
        (SceneId::TaskCompleted, None, Some("exit code 0")),
        (SceneId::TaskSuspicious, Some("120"), None),
        (
            SceneId::TaskFailed,
            Some("build error"),
            Some("exit code 1"),
        ),
        (SceneId::TaskKilled, None, None),
        (SceneId::TimerFired, Some("Review PR"), None),
        (
            SceneId::CronFired,
            Some("Daily digest"),
            Some("iteration 3"),
        ),
        (SceneId::RuntimeError, Some("provider 5xx"), None),
        (SceneId::InterventionRequired, Some("Missing API key"), None),
        (SceneId::SecurityBlocked, Some("Delete"), None),
        (SceneId::CacheWasteAlert, Some("24000"), Some("0.12")),
    ];
    assert_eq!(cases.len(), 18, "18 个场景登记");
    for (scene, digest, detail) in cases {
        let copy =
            render_copy_with_locale(scene, &payload("run-42", digest, detail), Some("en-US"));
        assert!(!copy.title.is_empty(), "场景 {scene:?} 英文标题非空");
        assert!(
            !copy.title.contains('<') && !copy.body.contains('<'),
            "场景 {scene:?} 英文无占位符残留：title={} body={}",
            copy.title,
            copy.body
        );
    }
}

/// VendorDevice 设备语言感知测试
#[test]
fn render_copy_for_device_respects_device_preferred_language() {
    use crate::push::vendor::VendorPlatform;

    let en_device =
        VendorDevice::new("dev-en", "tok-1", VendorPlatform::Ios).with_language("en-US");
    let zh_device =
        VendorDevice::new("dev-zh", "tok-2", VendorPlatform::Android).with_language("zh-CN");
    let def_device = VendorDevice::new("dev-def", "tok-3", VendorPlatform::Ios);

    let p = payload("run-42", None, None);

    let copy_en = render_copy_for_device(SceneId::RunCompleted, &p, &en_device);
    assert_eq!(copy_en.title, "Run Completed");
    assert_eq!(copy_en.body, "Run run-42 completed successfully");

    let copy_zh = render_copy_for_device(SceneId::RunCompleted, &p, &zh_device);
    assert_eq!(copy_zh.title, "任务已完成");
    assert_eq!(copy_zh.body, "任务 run-42 已完成");

    let copy_def = render_copy_for_device(SceneId::RunCompleted, &p, &def_device);
    assert_eq!(copy_def.title, "任务已完成");
    assert_eq!(copy_def.body, "任务 run-42 已完成");
}
