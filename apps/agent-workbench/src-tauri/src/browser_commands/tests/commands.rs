use std::sync::Arc;
use crate::browser::panel_input::BrowserInputEvent;
use crate::core_run_commands::CoreRunState;
use serde_json::json;

use super::fixtures::mock_core_state;
use crate::browser_commands::{
    browser_frame_status, browser_input, browser_status, browser_stop, browser_stop_frames,
    start_payload,
};

/// G-5 补强：SensitiveCapabilities 剪贴板位默认关闭（红线语义，
/// 17 §2.3——未开启时任何权限模式直接 Deny，含 full-access）。
/// 口径注记（M-7 + U-8 裁决，17 §3.1/§3.3）：
/// - **纯文本粘贴不受影响**：文本经 `Input.insertText` 注入页面，
///   不经 evaluate——`insertText` 不需要 clipboard 能力位；
/// - **evaluate 兜底暂缓**：富文本/图片粘贴放 evaluate 路径，一期
///   不支持（工具返回「暂不支持，请手动粘贴」）；仅「文件路径粘贴」
///   场景保留受控 evaluate 兜底（需审批 + §3 三层校验），暂缓接线。
#[test]
fn g5_sensitive_capabilities_defaults_off() {
    let caps = conex_browser_tools::SensitiveCapabilities::default();
    assert!(!caps.evaluate, "evaluate 能力位默认关闭（红线语义）");
    assert!(!caps.upload, "upload 能力位默认关闭（红线语义）");
    assert!(!caps.clipboard, "clipboard 能力位默认关闭（G-5）");
}

/// 启动失败 → 契约载荷（state=error + reason；命令面代理语义）。
#[test]
fn start_payload_maps_error_and_ok() {
    let ok = start_payload(Ok("running"));
    assert_eq!(
        serde_json::to_value(&ok).unwrap(),
        json!({ "state": "running" })
    );
    let starting = start_payload(Ok("starting"));
    assert_eq!(
        serde_json::to_value(&starting).unwrap(),
        json!({ "state": "starting" })
    );
    let err = start_payload(Err("浏览器崩溃恢复中".to_string()));
    assert_eq!(
        serde_json::to_value(&err).unwrap(),
        json!({ "state": "error", "reason": "浏览器崩溃恢复中" })
    );
}

/// browser_status 契约：从未启动 → `{ state: "idle" }`（无 url 键）；
/// 未启动的 browser_stop 幂等返回 `{ state: "stopped" }`（manager.stop
/// 无驱动路径直接收敛，安全面）；force 参数缺省/显式均收敛。
#[tokio::test]
async fn status_and_stop_contract_on_idle_state() {
    use tauri::Manager as _;
    let temp = tempfile::tempdir().expect("临时目录");
    let state = mock_core_state(&temp);
    let app = tauri::test::mock_builder()
        .manage(Arc::clone(&state))
        .build(tauri::test::mock_context(tauri::test::noop_assets()))
        .expect("mock app");
    let state_ref = app.state::<Arc<CoreRunState>>();

    let status =
        browser_status(app.handle().clone(), state_ref.clone()).expect("status 不应失败");
    assert_eq!(status.state, "idle", "从未启动 = idle");
    assert_eq!(
        serde_json::to_value(&status).unwrap(),
        json!({ "state": "idle" }),
        "url 缺省不落键（契约形状）"
    );

    let stopped = browser_stop(None, state_ref.clone())
        .await
        .expect("未启动 stop 应幂等");
    assert_eq!(
        serde_json::to_value(&stopped).unwrap(),
        json!({ "state": "stopped" })
    );

    // 评审 F3：force 急停参数显式传递亦收敛（未启动幂等安全面）
    let stopped = browser_stop(Some(true), state_ref)
        .await
        .expect("force stop 应幂等");
    assert_eq!(
        serde_json::to_value(&stopped).unwrap(),
        json!({ "state": "stopped" })
    );
}

/// P1-B1：browser_input no-wait 语义——无会话/管线（P1-A 未接线）时
/// 返回 Ok（事件进入路由即返回，不等待 CDP）；payload 反序列化契约。
#[tokio::test]
async fn browser_input_returns_ok_without_session() {
    use tauri::Manager as _;
    let temp = tempfile::tempdir().expect("临时目录");
    let state = mock_core_state(&temp);
    let app = tauri::test::mock_builder()
        .manage(Arc::clone(&state))
        .build(tauri::test::mock_context(tauri::test::noop_assets()))
        .expect("mock app");
    let state_ref = app.state::<Arc<CoreRunState>>();

    let evt = serde_json::from_value(json!({
        "kind": "mouse",
        "action": "move",
        "x": 10.0,
        "y": 20.0,
        "buttons": 1,
        "modifiers": 0
    }))
    .expect("载荷反序列化");
    let result = browser_input(evt, state_ref.clone()).await;
    assert!(
        result.is_ok(),
        "no-wait：路由后立即返回 Ok，不得因会话缺失失败"
    );

    let key_evt = serde_json::from_value(json!({
        "kind": "key",
        "action": "down",
        "key": "a",
        "code": "KeyA",
        "text": "a",
        "windowsVirtualKeyCode": 65,
        "nativeVirtualKeyCode": 65,
        "autoRepeat": false,
        "modifiers": 2
    }))
    .expect("键盘载荷反序列化");
    assert!(browser_input(key_evt, state_ref).await.is_ok());
}

/// P1-B1：browser_input 载荷非法 kind → 反序列化失败（防御非法前端）。
#[test]
fn browser_input_rejects_unknown_kind() {
    let parsed: Result<BrowserInputEvent, _> =
        serde_json::from_value(json!({ "kind": "joystick" }));
    assert!(parsed.is_err(), "未知 kind 必须反序列化失败");
}

/// P1-B1：帧状态契约——未启动槽 stop_frames / frame_status 幂等收敛
/// （stopped，不触发启动链）。
#[tokio::test]
async fn frame_commands_idle_contract() {
    use tauri::Manager as _;
    let temp = tempfile::tempdir().expect("临时目录");
    let state = mock_core_state(&temp);
    let app = tauri::test::mock_builder()
        .manage(Arc::clone(&state))
        .build(tauri::test::mock_context(tauri::test::noop_assets()))
        .expect("mock app");
    let state_ref = app.state::<Arc<CoreRunState>>();

    let status = browser_frame_status(state_ref.clone()).expect("状态查询不应失败");
    assert_eq!(serde_json::to_value(status).unwrap(), json!("stopped"));

    let stopped = browser_stop_frames(state_ref).await.expect("退订不应失败");
    assert_eq!(serde_json::to_value(stopped).unwrap(), json!("stopped"));
}
