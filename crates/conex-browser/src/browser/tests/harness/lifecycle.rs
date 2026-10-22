use super::*;

/// 完整生命周期：Stopped→Launching→Running→Stopping→Stopped（事件序断言）。
#[tokio::test]
async fn full_cycle_transitions() {
    let Some(h) = Harness::new() else { return };
    let cfg = h.config(&script_ok());
    let mgr = h.manager.clone();
    let mut rx = mgr.subscribe();
    let report = mgr.start(cfg).await.expect("启动");
    assert!(matches!(report.state, BrowserState::Running));
    assert!(report.profile_dir.exists());
    let states = collect_states(&mut rx, 2).await;
    assert!(matches!(states[0], BrowserState::Launching { attempt: 1 }));
    assert!(matches!(states[1], BrowserState::Running));
    // 端点私有通道可用（不进报告/事件）
    let ep = mgr.endpoint().expect("端点应就绪");
    assert_eq!(ep.port, 38689);
    // 停止
    let stop = mgr.stop(StopReason::Graceful).await.expect("停止");
    assert!(matches!(stop.state, BrowserState::Stopped));
    assert!(!report.profile_dir.exists(), "会话结束直删 profile");
    let tail = collect_states(&mut rx, 2).await;
    assert!(matches!(tail[0], BrowserState::Stopping { graceful: true }));
    assert!(matches!(tail[1], BrowserState::Stopped));
}

/// 启动重试耗尽 → GiveUp + LaunchEarlyExit（§6.2 第 4 行 + §6.5 诊断）。
#[tokio::test]
async fn launch_retry_then_fail() {
    let Some(h) = Harness::new() else { return };
    let cfg = h.config(&script_early_exit());
    let mgr = h.manager.clone();
    let mut rx = mgr.subscribe();
    let err = mgr.start(cfg).await.expect_err("3 次重试后必须失败");
    match err {
        ProcessError::LaunchEarlyExit { exit_code: 7, .. } => {}
        other => panic!("应为 LaunchEarlyExit(7)，实际：{other:?}"),
    }
    // 事件序：Launching{1} → Launching{2} → Launching{3} → Stopped
    let states = collect_states(&mut rx, 4).await;
    assert!(matches!(states[0], BrowserState::Launching { attempt: 1 }));
    assert!(matches!(states[1], BrowserState::Launching { attempt: 2 }));
    assert!(matches!(states[2], BrowserState::Launching { attempt: 3 }));
    assert!(matches!(states[3], BrowserState::Stopped));
    assert_eq!(mgr.status().state, BrowserState::Stopped);
}

/// 崩溃自愈：Running → 崩溃 → 重启 → Running（NavStack 保留，profile 未删）。
#[tokio::test]
async fn crash_restart_preserves_nav() {
    let Some(h) = Harness::new() else { return };
    let cfg = h.config(&script_crash());
    let mgr = h.manager.clone();
    let mut rx = mgr.subscribe();
    let report = mgr.start(cfg).await.expect("启动");
    let profile_dir = report.profile_dir.clone();
    // 注入导航栈（模拟维度 11 回写）
    let mut nav = NavStack::new();
    nav.push(url::Url::parse("https://a.example").unwrap(), false);
    nav.push(url::Url::parse("https://b.example").unwrap(), true);
    nav.set_active(1);
    mgr.set_nav(nav.clone());
    // 事件序：Launching{1} → Running → Launching{1}(重启) → Running(restarts=1)
    let states = collect_states(&mut rx, 4).await;
    assert!(
        matches!(states[2], BrowserState::Launching { attempt: 1 }),
        "{states:?}"
    );
    assert!(matches!(states[3], BrowserState::Running), "{states:?}");
    // 重启后导航栈保留（U-7：快照由本模块保留，恢复编排归维度 15）
    assert_eq!(mgr.nav_stack(), nav, "崩溃重启必须保留导航栈");
    assert_eq!(mgr.status().restarts, 1);
    assert!(profile_dir.exists(), "崩溃重启复用 profile，不删除");
    // 停止收尾
    mgr.stop(StopReason::Force).await.expect("停止");
    assert!(!profile_dir.exists(), "停止后直删");
}

/// 崩溃循环：30s 窗口内 3 次重启上限 → CrashLoopDetected 终态（保留 profile）。
#[tokio::test]
async fn crash_loop_aborts_after_3() {
    let Some(h) = Harness::new() else { return };
    let cfg = h.config(&script_crash());
    let mgr = h.manager.clone();
    let mut rx = mgr.subscribe();
    let report = mgr.start(cfg).await.expect("启动");
    let profile_dir = report.profile_dir.clone();
    // 等终态：4 次崩溃 → CrashAbort → Stopped + CrashLoopDetected
    let deadline = std::time::Instant::now() + Duration::from_secs(30);
    loop {
        let remaining = deadline.saturating_duration_since(std::time::Instant::now());
        let ev = tokio::time::timeout(remaining, rx.recv())
            .await
            .expect("等待终态超时")
            .expect("通道关闭");
        if let ProcessEvent::StateChanged {
            state: BrowserState::Stopped,
            error: Some(e),
            ..
        } = ev
        {
            assert!(e.contains("崩溃重启超限"), "{e}");
            break;
        }
    }
    assert_eq!(mgr.status().state, BrowserState::Stopped);
    assert!(
        profile_dir.exists(),
        "崩溃放弃保留导航栈数据（§6.2），停止时才清理"
    );
    // 停止（清理遗留 profile）
    mgr.stop(StopReason::Graceful).await.expect("停止");
    assert!(!profile_dir.exists(), "停止后清理");
}
