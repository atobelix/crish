use super::*;
use base64::Engine;

/// 验收 9.1-12：注入 N 事件 → 订阅者按序收到（顺序断言）
#[tokio::test]
async fn bus_events_in_order() {
    let bus = BusHandle::new(16, 4);
    let mut rx = bus.subscribe();
    let events = vec![
        BrowserEvent::Console {
            session: "s".to_string(),
            level: ConsoleLevel::Log,
            text: "一".to_string(),
            url: None,
            line: None,
        },
        BrowserEvent::NetworkRequest {
            request_id: "r1".to_string(),
            url: "https://e.com".to_string(),
            method: "GET".to_string(),
            status: None,
        },
        BrowserEvent::PageError {
            session: "s".to_string(),
            text: "错误".to_string(),
            url: None,
            line: None,
        },
        BrowserEvent::DomChanged {
            session: "s".to_string(),
            kind: DomChangeKind::CharacterDataModified,
        },
        BrowserEvent::NetworkDone {
            request_id: "r1".to_string(),
            ok: true,
            size: None,
        },
    ];
    for e in &events {
        bus.publish(e.clone());
    }
    for expected in &events {
        let got = rx.recv().await.expect("订阅者应有事件");
        assert_eq!(&got, expected, "事件顺序必须与发布序一致");
    }
}

/// 验收 9.1-13：慢消费者 Lagged → 自愈路径（版本跟踪器重对齐）
#[tokio::test]
async fn bus_lagged_recovery() {
    // 小容量总线制造 Lagged
    let bus = BusHandle::new(2, 4);
    let mut slow = bus.subscribe();
    // 订阅者未消费，发布 4 个事件（容量 2：最早 2 个被挤出）
    for i in 0..4u64 {
        bus.publish(BrowserEvent::NetworkDone {
            request_id: format!("r{i}"),
            ok: true,
            size: None,
        });
    }
    // 慢消费者首个 recv 必为 Lagged（丢了 2 个）
    match slow.recv().await {
        Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => {}
        other => panic!("应收到 Lagged，实际 {other:?}"),
    }
    // 后续事件仍按序可得（自愈：不丢后续）
    let got = slow.recv().await.expect("重对齐后应能继续消费");
    assert_eq!(
        got,
        BrowserEvent::NetworkDone {
            request_id: "r2".to_string(),
            ok: true,
            size: None
        }
    );
    let got = slow.recv().await.expect("重对齐后应能继续消费");
    assert_eq!(
        got,
        BrowserEvent::NetworkDone {
            request_id: "r3".to_string(),
            ok: true,
            size: None
        }
    );

    // 版本跟踪器自愈（U-2）：Lagged 检测 → 全标签 +1000 + epoch+1 + VersionReset
    let bus2 = BusHandle::new(64, 4);
    let tracker = Arc::new(crate::cdp::version::VersionTracker::new(
        bus2.event_tx(),
        std::time::Duration::from_millis(50),
    ));
    let mut rx = bus2.subscribe();
    tracker.bump("tab-1", VersionReason::InputInjected);
    // 先消费 bump 的 VersionAdvanced，再验证 Lagged 自愈的 VersionReset
    let first = rx.recv().await.expect("应广播 VersionAdvanced");
    assert!(matches!(first, BrowserEvent::VersionAdvanced { .. }));
    tracker.on_lagged();
    assert_eq!(tracker.snapshot_version("tab-1"), 1001);
    assert_eq!(tracker.epoch(), 1);
    let got = rx.recv().await.expect("应广播 VersionReset");
    assert!(matches!(
        got,
        BrowserEvent::VersionReset {
            epoch: 1,
            reason: VersionReason::LaggedResync
        }
    ));
}

/// 验收 9.1-14：帧事件不进 typed 通道
#[tokio::test]
async fn bus_screencast_isolated() {
    let bus = BusHandle::new(16, 4);
    let mut rx = bus.subscribe();
    let mut frames = bus.subscribe_frames();

    // 帧事件：分类必须 Ignored + parse_frame 提取成功
    let chunk = base64::engine::general_purpose::STANDARD.encode(b"fake-jpeg-bytes");
    let frame_evt = raw(
        "Page.screencastFrame",
        json!({
            "data": chunk,
            "metadata": {
                "pageScaleFactor": 1.0,
                "deviceWidth": 1280,
                "deviceHeight": 720,
                "timestamp": 1234.567
            },
            "sessionId": "S1",
            "frameNumber": 42
        }),
        Some("S1"),
    );
    assert!(classify(&frame_evt).is_err(), "帧事件不得进入 typed 分类");
    let parsed = parse_frame(&frame_evt).expect("帧解析失败");
    assert_eq!(parsed.data, b"fake-jpeg-bytes");
    assert_eq!(parsed.session, "S1");
    assert_eq!(parsed.ack_session, "S1", "ack 会话回退信封（同值用例）");
    assert_eq!(parsed.frame, 42);
    assert_eq!(parsed.timestamp_ms, 1_234_567);
    assert_eq!(parsed.device_width, 1280);

    bus.send_frame(parsed);
    // typed 通道只收到普通事件
    bus.publish(BrowserEvent::Console {
        session: "s".to_string(),
        level: ConsoleLevel::Log,
        text: "x".to_string(),
        url: None,
        line: None,
    });
    let got = rx.recv().await.expect("typed 订阅者应有事件");
    assert!(
        matches!(got, BrowserEvent::Console { .. }),
        "typed 通道不应出现帧事件"
    );
    // 帧通道独立收到
    let frame = frames.recv().await.expect("帧通道应有帧");
    assert_eq!(frame.frame, 42);
}

/// ack 会话标识优先级（P1-A 遗留 1/2）：params.sessionId 独立于信封时
/// ack_session 取 params 值；缺省回退信封 session（向后兼容）。
#[test]
fn bus_frame_ack_session_precedence() {
    let chunk = base64::engine::general_purpose::STANDARD.encode(b"fake-jpeg-bytes");
    // params.sessionId = "ACK-S2" ≠ 信封 "S1"：ack_session 取 params 值
    let evt = raw(
        "Page.screencastFrame",
        json!({
            "data": chunk,
            "metadata": { "timestamp": 1.0 },
            "sessionId": "ACK-S2",
            "frameNumber": 7
        }),
        Some("S1"),
    );
    let parsed = parse_frame(&evt).expect("帧解析失败");
    assert_eq!(parsed.session, "S1", "路由 session 仍为信封");
    assert_eq!(parsed.ack_session, "ACK-S2", "ack 会话取 params.sessionId");
    // params 缺省 sessionId：回退信封 session（向后兼容）
    let evt = raw(
        "Page.screencastFrame",
        json!({
            "data": chunk,
            "metadata": { "timestamp": 1.0 },
            "frameNumber": 8
        }),
        Some("S1"),
    );
    let parsed = parse_frame(&evt).expect("帧解析失败");
    assert_eq!(parsed.ack_session, "S1", "缺省回退信封 session");
    // 信封也缺省：空串兜底（宽容解析）
    let evt = raw(
        "Page.screencastFrame",
        json!({
            "data": chunk,
            "metadata": { "timestamp": 1.0 },
            "frameNumber": 9
        }),
        None,
    );
    let parsed = parse_frame(&evt).expect("帧解析失败");
    assert_eq!(parsed.ack_session, "", "全部缺省空串兜底");
}

/// Chrome 151 真实形态（G-3 实测回归）：metadata 尺寸为浮点值
/// （deviceHeight: 633.6）、frameNumber 字段缺失——修复前尺寸落 0、
/// 帧序号恒 0 导致去重误杀后续帧（帧流停滞）。断言：尺寸取整解析、
/// 帧序号回退时间戳毫秒且唯一、时间戳毫秒正确。
#[test]
fn bus_frame_chrome151_float_metadata_missing_frame_number() {
    let chunk = base64::engine::general_purpose::STANDARD.encode(b"fake-jpeg-bytes");
    // Chrome 151 headed 实测形态：deviceWidth 整数、deviceHeight 浮点、无 frameNumber
    let evt = raw(
        "Page.screencastFrame",
        json!({
            "data": chunk,
            "metadata": {
                "pageScaleFactor": 1.0,
                "deviceWidth": 1280,
                "deviceHeight": 633.6000366210938,
                "timestamp": 1786338969.668515
            },
            "sessionId": "S1"
        }),
        Some("S1"),
    );
    let parsed = parse_frame(&evt).expect("帧解析失败");
    assert_eq!(parsed.device_width, 1280, "浮点宽度取整");
    assert_eq!(parsed.device_height, 634, "浮点高度取整（633.6 → 634）");
    assert_eq!(parsed.timestamp_ms, 1_786_338_969_668, "时间戳毫秒");
    assert_eq!(
        parsed.frame, 1_786_338_969_668,
        "无 frameNumber 回退时间戳毫秒"
    );

    // 同信封两帧：帧序号（时间戳回退）互异 → 帧泵去重不误杀
    let evt2 = raw(
        "Page.screencastFrame",
        json!({
            "data": chunk,
            "metadata": {
                "deviceWidth": 1280,
                "deviceHeight": 633.6,
                "timestamp": 1786338969.768515
            },
            "sessionId": "S1"
        }),
        Some("S1"),
    );
    let parsed2 = parse_frame(&evt2).expect("第二帧解析失败");
    assert_ne!(
        parsed.frame, parsed2.frame,
        "相邻帧序号必须互异（修复前恒 0，去重误杀）"
    );

    // frameNumber 存在时仍优先（旧协议向后兼容）
    let evt3 = raw(
        "Page.screencastFrame",
        json!({
            "data": chunk,
            "metadata": { "timestamp": 1.0 },
            "frameNumber": 42
        }),
        Some("S1"),
    );
    assert_eq!(parse_frame(&evt3).expect("解析失败").frame, 42);
}

/// Chrome 151 数字 sessionId 形态（G-3 实测回归）：params.sessionId 为
/// JSON 数字（1）而非字符串——ack 参数须保持数字原样回传（Chrome 对
/// ack 参数类型敏感：字符串化被拒 Invalid parameters → ack 全失败 →
/// 帧流停滞）。修复前 as_str 失败回退信封会话，同样被 Chrome 拒绝。
#[test]
fn bus_frame_numeric_session_id_parsed_for_ack() {
    let chunk = base64::engine::general_purpose::STANDARD.encode(b"fake-jpeg-bytes");
    let evt = raw(
        "Page.screencastFrame",
        json!({
            "data": chunk,
            "metadata": { "timestamp": 1.0 },
            "sessionId": 1
        }),
        Some("S1"),
    );
    let parsed = parse_frame(&evt).expect("帧解析失败");
    assert_eq!(parsed.session, "S1", "信封路由仍为信封会话");
    assert_eq!(
        parsed.ack_session,
        Value::from(1),
        "数字 sessionId 保持数字形态（修复前回退/字符串化均被 Chrome 拒绝）"
    );
}
