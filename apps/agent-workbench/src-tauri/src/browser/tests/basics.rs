//! browser 槽测试 · 面板状态 / 生命周期 / 输入路由 / 暴露守卫 / storage。

use super::super::*;

use conex_browser::{CrashReason, NavStack};
use serde_json::json;

/// 测试发射器（转发任务断言：记录 channel:payload）。
struct TestEmitter(Arc<Mutex<Vec<String>>>);

impl Emitter for TestEmitter {
    fn emit(&self, channel: &str, payload: &str) {
        self.0
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .push(format!("{channel}:{payload}"));
    }
}

/// 面板状态映射全表（契约口径：idle/launching/running/stopping/stopped/
/// crashed/error；降级槽恒 error）。
#[test]
fn panel_state_mapping_table() {
    assert_eq!(
        panel_state_str(&BrowserState::Stopped, false, false),
        "idle"
    );
    assert_eq!(
        panel_state_str(&BrowserState::Stopped, true, false),
        "stopped"
    );
    assert_eq!(
        panel_state_str(&BrowserState::Launching { attempt: 1 }, false, false),
        "launching"
    );
    assert_eq!(
        panel_state_str(&BrowserState::Running, false, false),
        "running"
    );
    assert_eq!(
        panel_state_str(&BrowserState::Stopping { graceful: true }, false, false),
        "stopping"
    );
    assert_eq!(
        panel_state_str(
            &BrowserState::Crashed {
                reason: CrashReason::Unknown,
                restarts: 1
            },
            false,
            false
        ),
        "crashed"
    );
    // 降级槽：任何进程状态均 error
    assert_eq!(
        panel_state_str(&BrowserState::Running, false, true),
        "error"
    );
    assert_eq!(
        panel_state_str(&BrowserState::Stopped, false, true),
        "error"
    );
}

/// 降级槽（manager=None）：status/start/ensure_ready/readiness 全部
/// not_ready 语义（装配降级不 panic，27 §5 风险预案红线）。
#[tokio::test]
async fn degraded_slot_is_not_ready() {
    let slot = Arc::new(BrowserSlot::from_parts(None, LaunchConfig::default()));
    let status = slot.status();
    assert_eq!(status.state, "error");
    assert!(slot.status().url.is_none());

    let err = slot.start().await.unwrap_err();
    assert!(err.contains("未注入"), "降级文案：{err}");
    match slot.ensure_ready().await {
        Ok(_) => panic!("降级槽 ensure_ready 必须失败"),
        Err(err) => assert!(err.contains("未注入"), "降级文案：{err}"),
    }
    let err = slot.stop(false).await.unwrap_err();
    assert!(err.contains("未注入"), "降级文案：{err}");
    let err = slot.stop(true).await.unwrap_err();
    assert!(err.contains("未注入"), "降级文案：{err}");

    let ops = LazySessionOps::new(slot);
    assert!(ops.ensure_ready().await.is_err());
    let err = ops.readiness().unwrap_err();
    assert!(err.contains("未注入"), "降级文案：{err}");
    let err = ops.current_tab().unwrap_err();
    assert_eq!(err.code(), TOOL_BROWSER_NOT_READY);
    let err = ops
        .send_page("S1", "Page.navigate", json!({ "url": "https://e.com" }))
        .await
        .unwrap_err();
    assert_eq!(err.code(), TOOL_BROWSER_NOT_READY);
}

/// estop 周期（M-2 桥状态机）：初始干净 → cancel（令牌取消 + 急停旗
/// 置位）→ reset（令牌换新 + 急停旗复位，新周期不继承取消态）。
#[tokio::test]
async fn estop_epoch_reset_cancel_cycle() {
    let slot = Arc::new(BrowserSlot::from_parts(None, LaunchConfig::default()));
    // 初始周期
    assert!(!slot.policy.abort_token().is_cancelled());
    assert!(!slot.estop_flag.load(Ordering::SeqCst));
    // run 级 abort → cancel
    slot.cancel_estop();
    assert!(slot.policy.abort_token().is_cancelled());
    assert!(slot.estop_flag.load(Ordering::SeqCst));
    // 下一 run/启动周期 → reset
    slot.reset_estop();
    assert!(!slot.policy.abort_token().is_cancelled());
    assert!(!slot.estop_flag.load(Ordering::SeqCst));
}

/// 载荷契约形状（27 方案 S6 + 评审 F7）：url/reason 缺省时不落键
/// （skip_serializing_if），携带时按 `{ state, url? }` / `{ state, reason? }`
/// 序列化。
#[test]
fn payload_contract_shapes() {
    let idle = StatusPayload {
        state: "idle",
        url: None,
        reason: None,
    };
    assert_eq!(
        serde_json::to_value(&idle).unwrap(),
        json!({ "state": "idle" })
    );
    let running = StatusPayload {
        state: "running",
        url: Some("https://e.com/".to_string()),
        reason: None,
    };
    assert_eq!(
        serde_json::to_value(&running).unwrap(),
        json!({ "state": "running", "url": "https://e.com/" })
    );
    let crashed = StatusPayload {
        state: "crashed",
        url: None,
        reason: Some("ProcessExit(1)".to_string()),
    };
    assert_eq!(
        serde_json::to_value(&crashed).unwrap(),
        json!({ "state": "crashed", "reason": "ProcessExit(1)" })
    );
    let start_ok = StartPayload {
        state: "running",
        reason: None,
    };
    assert_eq!(
        serde_json::to_value(&start_ok).unwrap(),
        json!({ "state": "running" })
    );
    let start_err = StartPayload {
        state: "error",
        reason: Some("原因".to_string()),
    };
    assert_eq!(
        serde_json::to_value(&start_err).unwrap(),
        json!({ "state": "error", "reason": "原因" })
    );
}

/// 评审 F3：急停（force=true）不等待会话锁——预占锁（模拟 launching 中
/// start_and_connect_locked 持锁挂起）后 force stop 仍立即收敛（manager
/// 未启动路径幂等）；正常停止（force=false）会被锁阻塞至硬超时兜底。
#[tokio::test]
async fn force_stop_skips_session_lock() {
    let manager = Arc::new(BrowserManager::new(
        std::env::temp_dir().join("browser-slot-force-stop-test"),
    ));
    let slot = Arc::new(BrowserSlot::from_parts(
        Some(manager),
        LaunchConfig::default(),
    ));
    // 预占会话锁（并发启动/重连持锁窗口）
    let _guard = slot.session.lock().await;
    // 急停：不等锁，直接收敛（未启动 manager 停止幂等）
    slot.stop(true).await.expect("force stop 不得被会话锁阻塞");
}

/// 评审 F4：stop 硬超时——优雅停止被会话锁阻塞超时后，走强制杀树兜底
/// （未启动 manager 强制停止幂等收敛，不永久挂死）。
#[tokio::test]
async fn stop_hard_timeout_falls_back_to_force() {
    let manager = Arc::new(BrowserManager::new(
        std::env::temp_dir().join("browser-slot-stop-timeout-test"),
    ));
    let slot = Arc::new(
        BrowserSlot::from_parts(Some(manager), LaunchConfig::default())
            .with_stop_hard_timeout(Duration::from_millis(50)),
    );
    // 预占会话锁：优雅停止在 lock().await 阻塞 → 50ms 硬超时 → 强制兜底
    let _guard = slot.session.lock().await;
    let started = Instant::now();
    slot.stop(false).await.expect("超时兜底应收敛");
    assert!(
        started.elapsed() < Duration::from_secs(5),
        "硬超时兜底不得长期挂起：{:?}",
        started.elapsed()
    );
}

/// 评审 F9：启动失败冷却期——record_start_failure 后冷却期内 start /
/// ensure_ready 直接返回冷却错误（不触发真实启动链）；冷却期过后恢复。
#[tokio::test]
async fn start_failure_cooldown_gates() {
    let manager = Arc::new(BrowserManager::new(
        std::env::temp_dir().join("browser-slot-cooldown-test"),
    ));
    let slot = Arc::new(BrowserSlot::from_parts(
        Some(manager),
        LaunchConfig::default(),
    ));
    assert_eq!(slot.start_cooldown_remaining(), None, "初始无冷却");
    slot.record_start_failure();
    let err = slot.start().await.unwrap_err();
    assert!(err.contains("冷却"), "start 冷却 gating：{err}");
    match slot.ensure_ready().await {
        Ok(_) => panic!("冷却期内 ensure_ready 必须失败"),
        Err(err) => assert!(err.contains("冷却"), "ensure_ready 冷却 gating：{err}"),
    }
    // 冷却期过后恢复：注入 0 冷却 = 冷却门禁关闭（记录失败后亦不 gating，
    // 未启动语义可重新走启动链；不触发真实启动）
    let manager = Arc::new(BrowserManager::new(
        std::env::temp_dir().join("browser-slot-cooldown-expired-test"),
    ));
    let slot = Arc::new(
        BrowserSlot::from_parts(Some(manager), LaunchConfig::default())
            .with_start_fail_cooldown(Duration::ZERO),
    );
    slot.record_start_failure();
    assert_eq!(slot.start_cooldown_remaining(), None, "0 冷却 = 门禁关闭");
}

/// 评审 F7：导航栈变更经转发任务重发状态事件（URL 随导航推送，面板不陈旧）。
#[tokio::test]
async fn nav_change_forwards_state_event() {
    let manager = Arc::new(BrowserManager::new(
        std::env::temp_dir().join("browser-slot-nav-forward-test"),
    ));
    let slot = Arc::new(BrowserSlot::from_parts(
        Some(manager.clone()),
        LaunchConfig::default(),
    ));
    let logs = Arc::new(Mutex::new(Vec::new()));
    slot.attach_emitter(Arc::new(TestEmitter(Arc::clone(&logs))));
    // 注入导航栈变更（set_nav 发射 NavStackChanged）→ 转发任务重发状态
    let mut nav = NavStack::new();
    nav.push(
        url::Url::parse("https://a.example").expect("URL 解析"),
        true,
    );
    manager.set_nav(nav);
    // 等待转发任务异步处理
    tokio::time::sleep(Duration::from_millis(200)).await;
    let logs = logs.lock().unwrap_or_else(|p| p.into_inner());
    assert!(
        logs.iter()
            .any(|s| s.contains("browser://state-changed") && s.contains("a.example")),
        "导航变更必须推送含 url 的状态事件：{logs:?}"
    );
}

/// 评审 F7：崩溃事件携带原因（`{ state: "crashed", reason }`）。
#[test]
fn crash_event_carries_reason() {
    let slot = Arc::new(BrowserSlot::from_parts(None, LaunchConfig::default()));
    let logs = Arc::new(Mutex::new(Vec::new()));
    slot.attach_emitter(Arc::new(TestEmitter(Arc::clone(&logs))));
    slot.emit_crash(&CrashReason::ProcessExit(1));
    let logs = logs.lock().unwrap_or_else(|p| p.into_inner());
    assert_eq!(logs.len(), 1, "崩溃事件应发射一次：{logs:?}");
    assert!(
        logs[0].contains("browser://state-changed")
            && logs[0].contains("\"state\":\"crashed\"")
            && logs[0].contains("ProcessExit(1)"),
        "崩溃载荷含 state+reason：{}",
        logs[0]
    );
}

/// LazySessionOps 未启动语义（live manager 但从未 start）：readiness
/// Err（"未启动"）；同步消费面 not_ready。**不触发真实启动**：异步
/// ensure 路径会经 manager.start 拉起真实浏览器进程（本机 Chrome 存在
/// 时单测会产生副作用进程/临时 profile）——启动+连接路径属集成面，
/// conex-browser 假浏览器 harness 覆盖（S7 验收）；异步 not_ready 面
/// 由 degraded_slot_is_not_ready 覆盖（未注入路径）。
#[tokio::test]
async fn lazy_ops_readiness_before_start() {
    let manager = Arc::new(BrowserManager::new(
        std::env::temp_dir().join("browser-slot-unit-test"),
    ));
    let slot = Arc::new(BrowserSlot::from_parts(
        Some(manager),
        LaunchConfig::default(),
    ));
    let ops = LazySessionOps::new(slot);
    let err = ops.readiness().unwrap_err();
    assert!(err.contains("未启动"), "未启动语义：{err}");
    let err = ops.current_tab().unwrap_err();
    assert_eq!(err.code(), TOOL_BROWSER_NOT_READY);
}

/// P1-B1：降级槽（manager=None）start_frames 必须失败（不启帧流）；
/// stop_frames / 帧状态查询幂等收敛（stopped）。
#[tokio::test]
async fn frame_stream_degraded_slot_is_not_ready() {
    let slot = Arc::new(BrowserSlot::from_parts(None, LaunchConfig::default()));
    let channel = tauri::ipc::Channel::new(|_| Ok(()));
    let err = slot.start_frames(channel).await.unwrap_err();
    assert!(err.contains("未注入"), "降级文案：{err}");
    assert_eq!(slot.frames().state(), FrameStreamState::Stopped);
    assert_eq!(slot.stop_frames().await, FrameStreamState::Stopped);
}

/// P1-B1：输入路由接线——forward_input 无会话/管线时路由照常（不 panic、
/// 无副作用）；管线未接线判定。
#[tokio::test]
async fn forward_input_routes_without_session() {
    let slot = Arc::new(BrowserSlot::from_parts(None, LaunchConfig::default()));
    let evt = BrowserInputEvent {
        kind: panel_input::InputEventKind::Mouse,
        action: Some("down".to_string()),
        x: Some(1.0),
        y: Some(2.0),
        button: Some("left".to_string()),
        buttons: Some(1),
        click_count: Some(1),
        delta_x: None,
        delta_y: None,
        modifiers: Some(0),
        key: None,
        code: None,
        text: None,
        windows_virtual_key_code: None,
        native_virtual_key_code: None,
        auto_repeat: None,
        location: None,
    };
    // 无会话/管线：路由吞掉（debug 留痕），invoke 侧无感（no-wait 语义）
    slot.forward_input(&evt);
    assert!(!slot.input().pipeline_wired(), "未连接时管线未接线");
}

/// P1-B1：raw_session 生命周期——降级槽恒 None；stop_inner 清理路径
/// 不炸（会话槽空 + 帧流退订/释放幂等）。
#[tokio::test]
async fn raw_session_cleared_on_stop() {
    let manager = Arc::new(BrowserManager::new(
        std::env::temp_dir().join("browser-slot-raw-session-test"),
    ));
    let slot = Arc::new(BrowserSlot::from_parts(
        Some(manager),
        LaunchConfig::default(),
    ));
    assert!(slot.raw_session_sync().is_none(), "未连接前无底层会话");
    slot.frames().release_session(); // 幂等
    assert_eq!(slot.stop_frames().await, FrameStreamState::Stopped);
    slot.stop(false).await.expect("未启动停止幂等收敛");
    assert!(slot.raw_session_sync().is_none(), "停止后无底层会话");
    assert!(!slot.input().pipeline_wired(), "停止后管线清除");
}

/// E-1 端点暴露守卫（槽级，R-12 安全默认）：默认槽（attach 开关关闭）
/// 端点**零暴露**——无论 manager 注入与否，`mcp_attach_endpoint` 一律
/// 结构化拒绝 `tool.browser.capability_disabled`（判定序：开关先行，
/// 不触碰端点状态；未显式授权不向外部 MCP 暴露受管端点，34 §5.2 E-1）。
#[tokio::test]
async fn mcp_attach_guard_default_off_zero_exposure() {
    use conex_browser_tools::codes::TOOL_BROWSER_CAPABILITY_DISABLED;
    // 注入 manager 的槽：即便进程存在，开关关闭仍拒绝（零暴露）
    let manager = Arc::new(BrowserManager::new(
        std::env::temp_dir().join("browser-slot-mcp-attach-off-test"),
    ));
    let slot = Arc::new(BrowserSlot::from_parts(
        Some(manager),
        LaunchConfig::default(),
    ));
    let err = slot.mcp_attach_endpoint().unwrap_err();
    assert_eq!(err.code(), TOOL_BROWSER_CAPABILITY_DISABLED);
    // 降级槽（manager=None）：开关关闭同样拒绝（开关先行，与降级无关）
    let degraded = Arc::new(BrowserSlot::from_parts(None, LaunchConfig::default()));
    let err = degraded.mcp_attach_endpoint().unwrap_err();
    assert_eq!(err.code(), TOOL_BROWSER_CAPABILITY_DISABLED);
}

/// E-1 端点暴露守卫（槽级，开启面）：`with_mcp_attach_allowed(true)`
/// 装配后守卫进入放行判定——浏览器未启动（端点不可用）→ 结构化
/// `tool.browser.not_ready`（不开返回端点；就绪面由 mcp_attach.rs
/// 纯函数测试以样例端点覆盖——单测不触发真实浏览器启动）。
#[tokio::test]
async fn mcp_attach_guard_enabled_requires_running_endpoint() {
    let manager = Arc::new(BrowserManager::new(
        std::env::temp_dir().join("browser-slot-mcp-attach-on-test"),
    ));
    let slot = Arc::new(
        BrowserSlot::from_parts(Some(manager), LaunchConfig::default())
            .with_mcp_attach_allowed(true),
    );
    let err = slot.mcp_attach_endpoint().unwrap_err();
    assert_eq!(err.code(), TOOL_BROWSER_NOT_READY);
}

/// J1b：storage 发送面生命周期——未连接槽恒为未连接面（get/set 均
/// not_ready 语义）；注入 mock 后命令面取到 mock（测试替身注入点）；
/// drop_raw_session 换回未连接（陈旧会话不得滞留）。
#[tokio::test]
async fn storage_ops_lifecycle_unwired_then_injected() {
    use conex_browser::cdp::domains::{Cookie as CdpCookie, SetCookieParam};

    struct EchoOps;
    #[async_trait]
    impl StorageStateOps for EchoOps {
        async fn get_all_cookies(&self) -> Result<Vec<CdpCookie>, String> {
            Err("echo".to_string())
        }
        async fn set_cookies(&self, _cookies: Vec<SetCookieParam>) -> Result<(), String> {
            Err("echo".to_string())
        }
    }

    let slot = Arc::new(BrowserSlot::from_parts(None, LaunchConfig::default()));
    // 未连接面：错误文案指向 browser_start（辅助通道须显式启动）
    let err = slot.storage_ops().get_all_cookies().await.unwrap_err();
    assert!(err.contains("未连接"), "未连接文案：{err}");
    // 注入 mock → 取到注入实现
    slot.inject_storage_ops(Arc::new(EchoOps));
    let err = slot.storage_ops().get_all_cookies().await.unwrap_err();
    assert_eq!(err, "echo");
    // drop_raw_session（停止路径）→ 换回未连接面
    slot.drop_raw_session();
    let err = slot
        .storage_ops()
        .set_cookies(Vec::new())
        .await
        .unwrap_err();
    assert!(err.contains("未连接"), "换回未连接：{err}");
}
