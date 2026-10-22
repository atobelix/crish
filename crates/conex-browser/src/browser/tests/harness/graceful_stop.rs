use super::*;

/// 假浏览器脚本：写 DevToolsActivePort 后约 1s 自行退出（退出码 0）。
/// 用于回归：优雅停止窗口内进程自然退出（wait_task 分支先到）。
fn script_self_exit() -> String {
    "@echo off\r\n\
         setlocal enabledelayedexpansion\r\n\
         set PROFILE=\r\n\
         set NEXT=0\r\n\
         for %%a in (%*) do (\r\n\
         \x20 set \"A=%%~a\"\r\n\
         \x20 if \"!NEXT!\"==\"1\" (\r\n\
         \x20\x20 if not \"!A!\"==\"--user-data-dir\" set \"PROFILE=!A!\"\r\n\
         \x20\x20 set \"NEXT=0\"\r\n\
         \x20 )\r\n\
         \x20 if \"!A:~0,16!\"==\"--user-data-dir=\" set \"PROFILE=!A:~16!\"\r\n\
         \x20 if \"!A!\"==\"--user-data-dir\" set \"NEXT=1\"\r\n\
         )\r\n\
         if not defined PROFILE exit /b 9\r\n\
         > \"!PROFILE!\\DevToolsActivePort\" echo 38689\r\n\
         >> \"!PROFILE!\\DevToolsActivePort\" echo /devtools/browser/fake-session-uuid\r\n\
         ping -n 2 127.0.0.1 >nul\r\n\
         exit /b 0\r\n"
        .to_string()
}

/// 假浏览器脚本：写 DevToolsActivePort 后循环检查 close 标志文件，出现
/// 即退出（退出码 0）。G-9 回归：Browser.close 发送后进程自然退出的
/// 可观测路径（.bat 轮询粒度 ~1s，等待窗口须大于一轮轮询）。
fn script_close_exit() -> String {
    "@echo off\r\n\
         setlocal enabledelayedexpansion\r\n\
         set PROFILE=\r\n\
         set NEXT=0\r\n\
         for %%a in (%*) do (\r\n\
         \x20 set \"A=%%~a\"\r\n\
         \x20 if \"!NEXT!\"==\"1\" (\r\n\
         \x20\x20 if not \"!A!\"==\"--user-data-dir\" set \"PROFILE=!A!\"\r\n\
         \x20\x20 set \"NEXT=0\"\r\n\
         \x20 )\r\n\
         \x20 if \"!A:~0,16!\"==\"--user-data-dir=\" set \"PROFILE=!A:~16!\"\r\n\
         \x20 if \"!A!\"==\"--user-data-dir\" set \"NEXT=1\"\r\n\
         )\r\n\
         if not defined PROFILE exit /b 9\r\n\
         > \"!PROFILE!\\DevToolsActivePort\" echo 38689\r\n\
         >> \"!PROFILE!\\DevToolsActivePort\" echo /devtools/browser/fake-session-uuid\r\n\
         :loop\r\n\
         if exist \"!PROFILE!\\close-flag\" exit /b 0\r\n\
         ping -n 2 127.0.0.1 >nul\r\n\
         goto loop\r\n"
        .to_string()
}

/// 回归（联调 E5 根因）：优雅停止窗口内进程**自行退出**（wait_task 分支先到）
/// 时不得二次 poll 已完成的 JoinHandle——tokio 对已完成句柄的再次 poll 直接
/// panic「JoinHandle polled after completion」，旧实现导致驱动任务崩溃、
/// 状态卡在 Stopping。wait_or_kill 放大到 5s 确保 wait_task（~1s）先到。
#[tokio::test]
async fn graceful_stop_waits_natural_exit_without_double_poll() {
    let Some(h) = Harness::new() else { return };
    let root = tempfile::tempdir().expect("临时目录");
    // CfT 缓存假二进制（discover 命中，root 与管理器同源）
    let cache_dir = root.path().join("browsers").join("chrome-151.0.7922.77");
    std::fs::create_dir_all(&cache_dir).expect("缓存目录");
    let rel = crate::browser::cft::binary_rel_path().expect("平台路径");
    let bin = cache_dir.join(rel);
    std::fs::create_dir_all(bin.parent().expect("父目录")).expect("目录");
    std::fs::write(bin, b"placeholder").expect("写入占位");
    let tuning = LaunchTuning {
        wait_or_kill: Duration::from_secs(5),
        ..fast_tuning()
    };
    let mgr = BrowserManager::with_tuning(root.path().to_path_buf(), tuning);
    let cfg = LaunchConfig {
        binary_override: Some(h.fake_browser(&script_self_exit())),
        ..Default::default()
    };
    let report = mgr.start(cfg).await.expect("启动");
    // 立即优雅停止：进程在 wait_or_kill(5s) 窗口内自行退出（~1s）
    let stop = mgr.stop(StopReason::Graceful).await.expect("停止");
    assert!(
        matches!(stop.state, BrowserState::Stopped),
        "进程自然退出后应收敛 Stopped（不得卡 Stopping）：{:?}",
        stop.state
    );
    assert!(!stop.force_killed, "自然退出不应走杀树兜底");
    assert!(!report.profile_dir.exists(), "停止后直删");
}

/// 优雅停止超时 → 杀树（wait_or_kill 注入 300ms；§6.3 第 2 步）。
#[tokio::test]
async fn graceful_stop_timeout_force_kills() {
    let Some(h) = Harness::new() else { return };
    let cfg = h.config(&script_ok());
    let mgr = h.manager.clone();
    let report = mgr.start(cfg).await.expect("启动");
    let stop = mgr.stop(StopReason::Graceful).await.expect("停止");
    // 假浏览器永不退出 → wait_or_kill 超时 → 杀树兜底
    assert!(stop.force_killed, "优雅等待超时必须走杀树：{stop:?}");
    assert!(matches!(stop.state, BrowserState::Stopped));
    assert!(stop.profile_removed);
    assert!(!report.profile_dir.exists(), "停止后直删");
}

// —— G-9：优雅停止先发 Browser.close 的完整停止路径（.bat harness）——

/// G-9：Graceful 停止先发 `Browser.close` → 假浏览器收到标志后自然退出 →
/// 不杀树。wait_or_kill 放大到 5s：.bat 轮询粒度 ~1s，等待窗口须覆盖
/// 一轮以上轮询。
#[tokio::test]
async fn graceful_stop_sends_close_then_natural_exit() {
    let Some(h) = Harness::new() else { return };
    let root = tempfile::tempdir().expect("临时目录");
    // CfT 缓存假二进制（discover 命中，root 与管理器同源）
    let cache_dir = root.path().join("browsers").join("chrome-151.0.7922.77");
    std::fs::create_dir_all(&cache_dir).expect("缓存目录");
    let rel = crate::browser::cft::binary_rel_path().expect("平台路径");
    let bin = cache_dir.join(rel);
    std::fs::create_dir_all(bin.parent().expect("父目录")).expect("目录");
    std::fs::write(bin, b"placeholder").expect("写入占位");
    let tuning = LaunchTuning {
        wait_or_kill: Duration::from_secs(5),
        ..fast_tuning()
    };
    let mgr = BrowserManager::with_tuning(root.path().to_path_buf(), tuning);
    let cfg = LaunchConfig {
        binary_override: Some(h.fake_browser(&script_close_exit())),
        ..Default::default()
    };
    let report = mgr.start(cfg).await.expect("启动");
    // 登记发送面：发送 Browser.close 时写 close 标志（触发假浏览器自然退出）
    let recorder = Arc::new(RecordingClose {
        exit_flag: Some(report.profile_dir.join("close-flag")),
        ..Default::default()
    });
    mgr.register_close_sender(recorder.clone());
    let stop = mgr.stop(StopReason::Graceful).await.expect("停止");
    assert_eq!(
        recorder.recorded(),
        vec![crate::cdp::domains::names::BROWSER_CLOSE],
        "Graceful 停止必须先发 Browser.close"
    );
    assert!(
        matches!(stop.state, BrowserState::Stopped),
        "自然退出后应收敛 Stopped：{:?}",
        stop.state
    );
    assert!(!stop.force_killed, "Browser.close 后自然退出不应杀树");
    assert!(!report.profile_dir.exists(), "停止后直删");
}

/// G-9：`Browser.close` 发出后进程不退出 → wait_or_kill 超时仍杀树兜底。
#[tokio::test]
async fn graceful_stop_close_timeout_still_force_kills() {
    let Some(h) = Harness::new() else { return };
    let cfg = h.config(&script_close_exit());
    let mgr = h.manager.clone();
    let report = mgr.start(cfg).await.expect("启动");
    // 只记录不写标志：close 发出后假浏览器仍常驻 → 超时杀树
    let recorder = Arc::new(RecordingClose::default());
    mgr.register_close_sender(recorder.clone());
    let stop = mgr.stop(StopReason::Graceful).await.expect("停止");
    assert_eq!(
        recorder.recorded(),
        vec![crate::cdp::domains::names::BROWSER_CLOSE],
        "必须先发 Browser.close 再进入等待窗口"
    );
    assert!(stop.force_killed, "close 后超时仍须杀树兜底：{stop:?}");
    assert!(matches!(stop.state, BrowserState::Stopped));
    assert!(!report.profile_dir.exists(), "停止后直删");
}

/// G-9：无会话登记 → 保持既有语义——不发 Browser.close，wait_or_kill
/// 超时杀树（graceful_stop_timeout_force_kills 的无会话显式化）。
#[tokio::test]
async fn graceful_stop_no_session_falls_back_to_kill() {
    let Some(h) = Harness::new() else { return };
    let cfg = h.config(&script_ok());
    let mgr = h.manager.clone();
    let report = mgr.start(cfg).await.expect("启动");
    let stop = mgr.stop(StopReason::Graceful).await.expect("停止");
    assert!(stop.force_killed, "无会话：wait_or_kill 超时杀树：{stop:?}");
    assert!(matches!(stop.state, BrowserState::Stopped));
    assert!(!report.profile_dir.exists(), "停止后直删");
}

/// G-9：`Browser.close` 发送失败（无连接/拒绝）→ 不 panic，直接走既有
/// wait_or_kill 超时杀树兜底。
#[tokio::test]
async fn graceful_stop_close_send_failure_falls_back() {
    let Some(h) = Harness::new() else { return };
    let cfg = h.config(&script_ok());
    let mgr = h.manager.clone();
    let report = mgr.start(cfg).await.expect("启动");
    let recorder = Arc::new(RecordingClose {
        fail: true,
        ..Default::default()
    });
    mgr.register_close_sender(recorder.clone());
    let stop = mgr
        .stop(StopReason::Graceful)
        .await
        .expect("发送失败不得 panic/挂死");
    assert_eq!(
        recorder.recorded(),
        vec![crate::cdp::domains::names::BROWSER_CLOSE]
    );
    assert!(stop.force_killed, "发送失败走既有超时杀树兜底：{stop:?}");
    assert!(matches!(stop.state, BrowserState::Stopped));
    assert!(!report.profile_dir.exists(), "停止后直删");
}

/// G-9：强制停止不发 `Browser.close`（直接杀树语义不变）。
#[tokio::test]
async fn force_stop_does_not_send_browser_close() {
    let Some(h) = Harness::new() else { return };
    let cfg = h.config(&script_ok());
    let mgr = h.manager.clone();
    let _ = mgr.start(cfg).await.expect("启动");
    let recorder = Arc::new(RecordingClose::default());
    mgr.register_close_sender(recorder.clone());
    let stop = mgr.stop(StopReason::Force).await.expect("停止");
    assert!(stop.force_killed);
    assert!(
        recorder.recorded().is_empty(),
        "强制停止不得发 Browser.close"
    );
}

/// start 幂等（§4.5）：Running 中重复 start 返回当前快照，不重复 spawn。
#[tokio::test]
async fn start_idempotent() {
    let Some(h) = Harness::new() else { return };
    let cfg = h.config(&script_ok());
    let mgr = h.manager.clone();
    let first = mgr.start(cfg.clone()).await.expect("首次启动");
    let second = mgr.start(cfg).await.expect("幂等启动");
    assert_eq!(second.profile_dir, first.profile_dir);
    assert!(matches!(second.state, BrowserState::Running));
    mgr.stop(StopReason::Force).await.expect("停止");
}

/// 停止报告与状态一致性。
#[tokio::test]
async fn stop_report_consistent() {
    let Some(h) = Harness::new() else { return };
    let cfg = h.config(&script_ok());
    let mgr = h.manager.clone();
    let _ = mgr.start(cfg).await.expect("启动");
    let stop = mgr.stop(StopReason::Force).await.expect("停止");
    assert!(matches!(stop.state, BrowserState::Stopped));
    assert_eq!(mgr.status().state, BrowserState::Stopped);
}

/// 受管 profile：启动后停止不删除（用户资产保留；删除经 trash，维度 16）。
#[tokio::test]
async fn managed_profile_kept_on_stop() {
    let Some(h) = Harness::new() else { return };
    // 源 profile fixture
    let src_root = h.dir.path().join("src-user-data");
    std::fs::create_dir_all(src_root.join("Default")).expect("目录");
    std::fs::write(src_root.join("Local State"), b"{}").expect("写入");
    std::fs::write(src_root.join("Default").join("Preferences"), b"pref").expect("写入");
    let cfg = LaunchConfig {
        profile: ProfileSpec::Imported {
            source_user_data: src_root,
            source_profile: "Default".to_string(),
            profile_name: "我的Profile".to_string(),
        },
        binary_override: Some(h.fake_browser(&script_ok())),
        ..Default::default()
    };
    h.fake_cft_binary();
    let mgr = h.manager.clone();
    let report = mgr.start(cfg).await.expect("启动");
    assert!(report.profile_dir.exists());
    assert!(report.profile_dir.join("Preferences").is_file());
    let managed = report.profile_dir.clone();
    let stop = mgr.stop(StopReason::Force).await.expect("停止");
    assert!(!stop.profile_removed, "受管 profile 不随会话直删");
    assert!(
        managed.exists(),
        "受管 profile 停止后保留（删除经 trash，维度 16）"
    );
    // trash 清理验证（模拟维度 16 流程）
    let trash = h.dir.path().join("trash");
    crate::browser::profile::trash_managed(&managed, &trash).expect("入回收站");
    assert!(!managed.exists());
}
