//! 帧流生命周期、启动/停止、恢复重启与状态事件测试（自 session.rs 平移）。

use super::*;

/// 验收 E1/E13（帧泵）：start → Active；注入帧 → 输出 + 每帧一 ack；
/// stop → 清理（后续帧丢弃，不输出不 ack）。
#[tokio::test]
async fn frames_start_ack_pacing_each_frame_once_stop_cleans() {
    let (mut mock, session) = setup().await;
    let frames = ScreencastSession::new(
        session.clone(),
        ScreencastConfig {
            hold_override: Some(Duration::ZERO),
            ..Default::default()
        },
    );
    let rx = frames.subscribe_frames();

    assert_eq!(frames.status(), ScreencastStatus::Idle);
    frames.start().await.expect("启动失败");
    assert_eq!(frames.status(), ScreencastStatus::Active);

    // 注入 3 帧 → 泵出 3 帧（seq 1..3，宽高/字节透传）+ 每帧恰一 ack
    for frame in 1..=3u64 {
        inject_frame(&mock, frame);
    }
    for seq in 1..=3u64 {
        let out = rx
            .recv_timeout(Duration::from_secs(1))
            .await
            .unwrap_or_else(|| panic!("缺帧 seq={seq}"));
        assert_eq!(out.seq, seq);
        assert_eq!(out.width, 1280);
        assert_eq!(out.height, 720);
        assert_eq!(out.data, b"fake-jpeg-bytes");
    }
    let deadline = tokio::time::Instant::now() + Duration::from_secs(1);
    while frames.stats().acks_sent < 3 && tokio::time::Instant::now() < deadline {
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    let stats = frames.stats();
    assert_eq!(stats.frames_sent, 3);
    assert_eq!(stats.acks_sent, 3, "每帧恰一 ack");
    assert_eq!(stats.frames_dropped, 0);
    assert_eq!(stats.duplicates_skipped, 0);

    // ack 参数（sessionId 为帧会话标识）逐条断言
    for _ in 0..3 {
        let ack = mock.expect_command("Page.screencastFrameAck").await;
        assert_eq!(ack["params"]["sessionId"], "S1");
    }

    // stop → 清理：后续帧直接丢弃（不输出不 ack）
    frames.stop().await;
    assert_eq!(frames.status(), ScreencastStatus::Idle);
    frames.stop().await; // 幂等
    assert_eq!(frames.status(), ScreencastStatus::Idle);
    inject_frame(&mock, 99);
    tokio::time::sleep(Duration::from_millis(50)).await;
    assert_eq!(frames.stats().frames_sent, 3, "停止后不再输出");
    assert_eq!(frames.stats().acks_sent, 3, "停止后不再 ack");
    assert!(rx.recv_timeout(Duration::from_millis(20)).await.is_none());

    frames.shutdown().await;
    session.shutdown().await;
}

/// 状态机（§5 投影）：重复 start 拒绝；start 命令失败 → 回 Idle + StartFailed
/// （显式关闭静态降级保留旧口径——U-3 降级路径见下方静态降级测试组）。
#[tokio::test]
async fn frames_state_machine_start_failures() {
    let (mock, session) = setup().await;
    let frames = ScreencastSession::new(
        session.clone(),
        ScreencastConfig {
            hold_override: Some(Duration::ZERO),
            static_fallback_enabled: false,
            ..Default::default()
        },
    );
    frames.start().await.expect("启动失败");
    assert!(matches!(
        frames.start().await,
        Err(ScreencastError::AlreadyActive)
    ));
    frames.stop().await;
    assert_eq!(frames.status(), ScreencastStatus::Idle);

    // startScreencast 命令失败 → Idle + StartFailed 事件
    mock.set_auto_reply(
        "Page.startScreencast",
        MockReply::Error {
            code: -32000,
            message: "screencast not supported".to_string(),
        },
    );
    let mut events = frames.subscribe_events();
    assert!(frames.start().await.is_err());
    assert_eq!(frames.status(), ScreencastStatus::Idle, "失败回 Idle");
    let deadline = tokio::time::Instant::now() + Duration::from_secs(1);
    loop {
        if let Ok(ScreencastEvent::StartFailed { .. }) = events.try_recv() {
            break;
        }
        assert!(tokio::time::Instant::now() < deadline, "应广播 StartFailed");
        tokio::time::sleep(Duration::from_millis(10)).await;
    }

    frames.shutdown().await;
    session.shutdown().await;
}

/// 恢复重启（R-9-3）：断线重连 → ConnectionRestored → 自动重启
/// （重新 startScreencast + 泵代数重置，旧序列作废）+ Restarted 事件。
#[tokio::test]
async fn frames_restart_after_connection_restored() {
    let (mock, session) = setup().await;
    let frames = ScreencastSession::new(
        session.clone(),
        ScreencastConfig {
            hold_override: Some(Duration::ZERO),
            start_retry_delay: Duration::ZERO,
            ..Default::default()
        },
    );
    let rx = frames.subscribe_frames();
    let mut events = frames.subscribe_events();
    frames.start().await.expect("启动失败");

    // 断线前：一帧正常泵出（seq=1），且 ack 已完成（断线不能吞在途 ack）
    inject_frame(&mock, 1);
    assert_eq!(rx.recv().await.map(|f| f.seq), Some(1));
    let deadline = tokio::time::Instant::now() + Duration::from_secs(1);
    while frames.stats().acks_sent < 1 && tokio::time::Instant::now() < deadline {
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    assert_eq!(frames.stats().acks_sent, 1, "断线前 ack 应完成");

    // 断线 → 重连（退避 1s）→ ConnectionRestored → 自动重启
    mock.close_connection();
    let deadline = tokio::time::Instant::now() + Duration::from_secs(8);
    let mut saw_restarted = false;
    while !saw_restarted {
        if let Ok(ScreencastEvent::Restarted { .. }) = events.try_recv() {
            saw_restarted = true;
        } else {
            assert!(tokio::time::Instant::now() < deadline, "等待自动重启超时");
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    }
    assert!(saw_restarted);
    assert_eq!(
        frames.status(),
        ScreencastStatus::Active,
        "重启后保持 Active"
    );
    assert_eq!(frames.stats().restarts, 1);
    assert_eq!(mock.connection_count(), 2, "断线才重连");

    // 重启后：新帧序列 seq 从 1 重新起算（旧 sessionId 序列作废）
    inject_frame(&mock, 100);
    assert_eq!(
        rx.recv().await.map(|f| f.seq),
        Some(1),
        "泵代数重置：seq 归零重计"
    );
    let deadline = tokio::time::Instant::now() + Duration::from_secs(1);
    while frames.stats().acks_sent < 2 && tokio::time::Instant::now() < deadline {
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    assert_eq!(frames.stats().acks_sent, 2, "重启后 ack 继续");

    frames.shutdown().await;
    session.shutdown().await;
}

/// 事件面：订阅方收到状态迁移（Idle → Starting → Active）。
#[tokio::test]
async fn frames_status_events_broadcast() {
    let (_mock, session) = setup().await;
    let frames = ScreencastSession::new(
        session.clone(),
        ScreencastConfig {
            hold_override: Some(Duration::ZERO),
            ..Default::default()
        },
    );
    let status_rx = frames.subscribe_status();
    assert_eq!(*status_rx.borrow(), ScreencastStatus::Idle);
    frames.start().await.expect("启动失败");
    assert_eq!(*status_rx.borrow(), ScreencastStatus::Active);
    frames.stop().await;
    assert_eq!(*status_rx.borrow(), ScreencastStatus::Idle);

    // 版本面不因帧流推进（帧不 bump；验证无副作用）
    assert_eq!(session.snapshot_version(&"T1".to_string()), 0);
    session.bump(&"T1".to_string(), VersionReason::InputInjected);
    assert_eq!(session.snapshot_version(&"T1".to_string()), 1);

    frames.shutdown().await;
    session.shutdown().await;
}
