//! 帧流背压丢帧、去重、ack 会话与升降档测试（自 session.rs 平移）。

use super::*;

/// 背压丢帧（§2.4）：输出槽容量 2，注入 5 帧 → 丢旧保新（保 4/5 帧）。
#[tokio::test]
async fn frames_backpressure_drops_oldest_keeps_newest() {
    let (mock, session) = setup().await;
    let frames = ScreencastSession::new(
        session.clone(),
        ScreencastConfig {
            hold_override: Some(Duration::ZERO),
            frame_queue_capacity: 2,
            ..Default::default()
        },
    );
    frames.start().await.expect("启动失败");

    // 不消费输出槽：泵 5 帧 → 队列只保留最新 2 帧
    for frame in 1..=5u64 {
        inject_frame(&mock, frame);
    }
    let deadline = tokio::time::Instant::now() + Duration::from_secs(1);
    while frames.stats().frames_received < 5 && tokio::time::Instant::now() < deadline {
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    let stats = frames.stats();
    assert_eq!(stats.frames_received, 5);
    assert_eq!(stats.frames_dropped, 3, "前 3 帧被替换（丢帧判据）");

    let rx = frames.subscribe_frames();
    assert_eq!(rx.recv().await.map(|f| f.seq), Some(4), "保最新帧");
    assert_eq!(rx.recv().await.map(|f| f.seq), Some(5));
    assert!(rx.recv_timeout(Duration::from_millis(20)).await.is_none());

    frames.shutdown().await;
    session.shutdown().await;
}

/// 去重（§2.1）：同 (session, frame) 重复事件只 ack 一次。
#[tokio::test]
async fn frames_duplicate_event_acked_once() {
    let (mock, session) = setup().await;
    let frames = ScreencastSession::new(
        session.clone(),
        ScreencastConfig {
            hold_override: Some(Duration::ZERO),
            ..Default::default()
        },
    );
    let _rx = frames.subscribe_frames();
    frames.start().await.expect("启动失败");

    inject_frame(&mock, 42);
    inject_frame(&mock, 42); // 重放同帧（防 CDP 重放）
    let deadline = tokio::time::Instant::now() + Duration::from_secs(1);
    while frames.stats().acks_sent < 1 && tokio::time::Instant::now() < deadline {
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    tokio::time::sleep(Duration::from_millis(50)).await;
    let stats = frames.stats();
    assert_eq!(stats.frames_sent, 1, "重复帧不重复输出");
    assert_eq!(stats.acks_sent, 1, "重复帧不重复 ack");
    assert_eq!(stats.duplicates_skipped, 1, "重复事件计数");
    // 后续新帧不受影响
    inject_frame(&mock, 43);
    let deadline = tokio::time::Instant::now() + Duration::from_secs(1);
    while frames.stats().acks_sent < 2 && tokio::time::Instant::now() < deadline {
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    assert_eq!(frames.stats().acks_sent, 2);

    frames.shutdown().await;
    session.shutdown().await;
}

/// ack 会话标识（P1-A 遗留 1/2）：params.sessionId 独立于信封时，ack 的
/// params.sessionId 取帧内值（真实 Chrome 严格校验 ack 会话）；命令路由
/// 仍为信封会话。
#[tokio::test]
async fn frames_ack_uses_params_session_id() {
    let (mut mock, session) = setup().await;
    let frames = ScreencastSession::new(
        session.clone(),
        ScreencastConfig {
            hold_override: Some(Duration::ZERO),
            ..Default::default()
        },
    );
    let _rx = frames.subscribe_frames();
    frames.start().await.expect("启动失败");

    // params.sessionId = "ACK-S2" ≠ 信封 "S1"
    let data = base64::engine::general_purpose::STANDARD.encode(b"fake-jpeg-bytes");
    mock.send_event(
        "Page.screencastFrame",
        json!({
            "data": data,
            "metadata": {
                "pageScaleFactor": 1.0,
                "deviceWidth": 1280,
                "deviceHeight": 720,
                "timestamp": 1.0
            },
            "sessionId": "ACK-S2",
            "frameNumber": 1
        }),
        Some("S1"),
    );
    let deadline = tokio::time::Instant::now() + Duration::from_secs(1);
    while frames.stats().acks_sent < 1 && tokio::time::Instant::now() < deadline {
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    assert_eq!(frames.stats().acks_sent, 1);
    let ack = mock.expect_command("Page.screencastFrameAck").await;
    assert_eq!(
        ack["params"]["sessionId"], "ACK-S2",
        "ack 会话取 params.sessionId（修复前会错用信封 S1）"
    );
    assert_eq!(ack["sessionId"], "S1", "命令路由仍为信封会话");

    frames.shutdown().await;
    session.shutdown().await;
}

/// 升降档（§2.5）：Base 档 ack 持住 ≈125ms；mark_input 升 Interactive 后
/// 持住显著缩短（67ms vs 125ms 相对断言，真实时钟下仅做下界/相对断言
/// 保证确定性）；静止 2s 回落 Base。档位换算精确值见 fps.rs 单测。
#[tokio::test]
async fn frames_fps_level_switching_ack_timing() {
    let (mock, session) = setup().await;
    let frames = ScreencastSession::new(session.clone(), ScreencastConfig::default());
    frames.start().await.expect("启动失败");
    assert_eq!(frames.fps_level(), FpsLevel::Base);

    // Base 档：注入帧 → 泵出 + ack 持住 ≥125ms（真实 sleep 下界断言）
    inject_frame(&mock, 1);
    let t0 = std::time::Instant::now();
    let rx = frames.subscribe_frames();
    assert_eq!(rx.recv().await.map(|f| f.seq), Some(1));
    wait_acks(&frames, 1).await;
    let base_elapsed = t0.elapsed();
    assert!(
        base_elapsed >= Duration::from_millis(120),
        "Base 档 ack 持住应 ≥125ms（实际 {base_elapsed:?}）"
    );

    // 升 Interactive（前端 input_active 信号）：ack 持住显著缩短
    frames.mark_input();
    assert_eq!(frames.fps_level(), FpsLevel::Interactive);
    inject_frame(&mock, 2);
    let t1 = std::time::Instant::now();
    assert_eq!(rx.recv().await.map(|f| f.seq), Some(2));
    wait_acks(&frames, 2).await;
    let interactive_elapsed = t1.elapsed();
    assert!(
        interactive_elapsed < base_elapsed,
        "Interactive 档持住应短于 Base 档（{interactive_elapsed:?} vs {base_elapsed:?}）"
    );

    // 升 Burst（拖拽/连续滚动）：进一步缩短
    frames.mark_burst();
    assert_eq!(frames.fps_level(), FpsLevel::Burst);
    inject_frame(&mock, 3);
    let t2 = std::time::Instant::now();
    assert_eq!(rx.recv().await.map(|f| f.seq), Some(3));
    wait_acks(&frames, 3).await;
    assert!(
        t2.elapsed() < interactive_elapsed,
        "Burst 档持住应短于 Interactive 档（{:?} vs {interactive_elapsed:?}）",
        t2.elapsed()
    );

    // 静止回落：2s 无信号 → Base（轮询等待，确定性成立）
    let t3 = std::time::Instant::now();
    while frames.fps_level() != FpsLevel::Base && t3.elapsed() < Duration::from_secs(4) {
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    assert_eq!(
        frames.fps_level(),
        FpsLevel::Base,
        "静止 2s 回落 Base（§2.5）"
    );

    frames.shutdown().await;
    session.shutdown().await;
}
