use crate::core_run_commands::CoreRunState;
use std::sync::Arc;

use super::fixtures::{
    cdp_cookie, err_detail, inject_local_storage_mock, inject_mock, mock_core_state, ChannelCall,
    MockLocalStorageChannel, MockStorageOps,
};
use crate::browser_commands::browser_export_storage_state;

/// J1b：导出返回形状——授权 + mock 实读 → 标准 storage_state JSON
/// （`{ cookies, origins }`，§5.1 字段面：会话 cookie expires=-1、
/// 持久 cookie 原值、sameSite/标志位透传）；内存传递不落盘。
/// origins 面（P1-3 接线）：cookie domain 推导 origin（通道预设空
/// localStorage → 标准形态空数组）。
#[tokio::test]
async fn export_returns_standard_json_with_authorization() {
    use tauri::Manager as _;
    let temp = tempfile::tempdir().expect("临时目录");
    let state = mock_core_state(&temp);
    let app = tauri::test::mock_builder()
        .manage(Arc::clone(&state))
        .build(tauri::test::mock_context(tauri::test::noop_assets()))
        .expect("mock app");
    let state_ref = app.state::<Arc<CoreRunState>>();

    let cookies = vec![
        cdp_cookie(|c| {
            c.name = "sessionid".to_string();
            c.expires = -1.0; // 会话 cookie
        }),
        cdp_cookie(|c| {
            c.name = "persist".to_string();
            c.value = "p".to_string();
            c.domain = "example.com".to_string();
            c.http_only = false;
            c.secure = false;
            c.same_site = None;
        }),
    ];
    inject_mock(&state, MockStorageOps::new(cookies));
    // 导出聚合（P1-3）：localStorage 通道 mock（预设空条目——空
    // localStorage 也须输出标准形态）
    inject_local_storage_mock(&state, MockLocalStorageChannel::default());

    let out = browser_export_storage_state(true, state_ref.clone())
        .await
        .expect("导出不应失败");
    let v: serde_json::Value = serde_json::from_str(&out).expect("标准 JSON");
    assert_eq!(v["cookies"].as_array().map(Vec::len), Some(2));
    assert_eq!(
        v["origins"].as_array().map(Vec::len),
        Some(1),
        "origins 面由 cookie domain 推导（同域去重）"
    );
    assert_eq!(
        v["origins"][0]["origin"], "https://example.com",
        "任一 secure cookie → https + 去前导点"
    );
    assert_eq!(
        v["origins"][0]["localStorage"].as_array().map(Vec::len),
        Some(0),
        "通道读取为空 → localStorage 空数组"
    );
    assert_eq!(v["cookies"][0]["name"], "sessionid");
    assert_eq!(v["cookies"][0]["value"], "abc123");
    assert_eq!(v["cookies"][0]["domain"], ".example.com");
    assert_eq!(v["cookies"][0]["path"], "/");
    assert_eq!(v["cookies"][0]["expires"], -1, "会话 cookie → expires=-1");
    assert_eq!(v["cookies"][0]["httpOnly"], true);
    assert_eq!(v["cookies"][0]["secure"], true);
    assert_eq!(v["cookies"][0]["sameSite"], "Lax");
    assert_eq!(
        v["cookies"][1]["expires"], 1_750_000_000,
        "持久 cookie 原值"
    );
    assert!(
        v["cookies"][1].get("sameSite").is_none(),
        "非法/缺失 sameSite 省略"
    );
}

/// J1b：导出需显式授权——authorized=false 直接拒绝（**不执行实读**，
/// 零副作用，§5.2 显式授权语义）；cookies 与 localStorage 通道均零调用。
#[tokio::test]
async fn export_requires_authorization_no_cdp_read() {
    use tauri::Manager as _;
    let temp = tempfile::tempdir().expect("临时目录");
    let state = mock_core_state(&temp);
    let app = tauri::test::mock_builder()
        .manage(Arc::clone(&state))
        .build(tauri::test::mock_context(tauri::test::noop_assets()))
        .expect("mock app");
    let state_ref = app.state::<Arc<CoreRunState>>();

    let mock = MockStorageOps::new(vec![cdp_cookie(|_| {})]);
    let get_calls = Arc::clone(&mock.get_calls);
    inject_mock(&state, mock);
    // localStorage 通道 mock（授权拒绝时不得有任何读取调用）
    let channel = MockLocalStorageChannel::default();
    let channel_calls = Arc::clone(&channel.calls);
    inject_local_storage_mock(&state, channel);

    let err = browser_export_storage_state(false, state_ref)
        .await
        .expect_err("未授权必须拒绝");
    let detail = err_detail(err);
    assert!(detail.contains("未获显式授权"), "拒绝文案：{detail}");
    assert_eq!(
        get_calls.load(std::sync::atomic::Ordering::SeqCst),
        0,
        "未授权不得执行实读（零副作用）"
    );
    assert!(
        channel_calls
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .is_empty(),
        "未授权不得经 localStorage 通道执行任何读取（零副作用）"
    );
}

/// J1b：未连接路径——未注入 mock（默认 Unwired 发送面）→
/// `tool.browser.not_ready` 结构化错误（storage 命令不触发惰性启动）。
#[tokio::test]
async fn export_not_ready_without_session() {
    use tauri::Manager as _;
    let temp = tempfile::tempdir().expect("临时目录");
    let state = mock_core_state(&temp);
    let app = tauri::test::mock_builder()
        .manage(Arc::clone(&state))
        .build(tauri::test::mock_context(tauri::test::noop_assets()))
        .expect("mock app");
    let state_ref = app.state::<Arc<CoreRunState>>();

    let err = browser_export_storage_state(true, state_ref)
        .await
        .expect_err("未连接必须失败");
    let detail = err_detail(err);
    assert!(
        detail.starts_with("tool.browser.not_ready:"),
        "not_ready 结构化码前缀：{detail}"
    );
}

/// P1-3：localStorage 通道不可用（cookie 实读面已 mock 成功但未注入
/// 会话通道）→ `tool.browser.not_ready`（导出聚合不触发惰性启动）。
#[tokio::test]
async fn export_local_storage_channel_unavailable_not_ready() {
    use tauri::Manager as _;
    let temp = tempfile::tempdir().expect("临时目录");
    let state = mock_core_state(&temp);
    let app = tauri::test::mock_builder()
        .manage(Arc::clone(&state))
        .build(tauri::test::mock_context(tauri::test::noop_assets()))
        .expect("mock app");
    let state_ref = app.state::<Arc<CoreRunState>>();

    // cookie 实读面成功（会话存储面 mock），但 localStorage 通道未注入
    inject_mock(
        &state,
        MockStorageOps::new(vec![cdp_cookie(|c| {
            c.domain = "example.com".to_string();
        })]),
    );

    let err = browser_export_storage_state(true, state_ref)
        .await
        .expect_err("通道不可用必须失败");
    let detail = err_detail(err);
    assert!(
        detail.starts_with("tool.browser.not_ready:"),
        "not_ready 结构化码前缀：{detail}"
    );
}

/// P1-3：导出聚合——origin 清单由 cookie domain 推导（secure → https、
/// 非 secure → http、去前导点、字典序），经通道逐 origin 实读并入
/// origins（标准 Playwright 形态 `{ origin, localStorage: [{ name, value }] }`）。
#[tokio::test]
async fn export_aggregates_local_storage_origins() {
    use tauri::Manager as _;
    let temp = tempfile::tempdir().expect("临时目录");
    let state = mock_core_state(&temp);
    let app = tauri::test::mock_builder()
        .manage(Arc::clone(&state))
        .build(tauri::test::mock_context(tauri::test::noop_assets()))
        .expect("mock app");
    let state_ref = app.state::<Arc<CoreRunState>>();

    inject_mock(
        &state,
        MockStorageOps::new(vec![
            cdp_cookie(|c| {
                c.domain = ".example.com".to_string();
                c.secure = true;
            }),
            cdp_cookie(|c| {
                c.domain = "example.org".to_string();
                c.secure = false;
            }),
        ]),
    );
    let channel = MockLocalStorageChannel::default()
        .with_items("https://example.com", vec![("theme", "dark")])
        .with_items("http://example.org", vec![("token", "abc")]);
    let channel_calls = Arc::clone(&channel.calls);
    inject_local_storage_mock(&state, channel);

    let out = browser_export_storage_state(true, state_ref)
        .await
        .expect("导出不应失败");
    let v: serde_json::Value = serde_json::from_str(&out).expect("标准 JSON");
    assert_eq!(v["cookies"].as_array().map(Vec::len), Some(2));
    let origins = v["origins"].as_array().expect("origins 数组");
    assert_eq!(origins.len(), 2);
    assert_eq!(
        origins[0]["origin"], "http://example.org",
        "字典序：http 在前"
    );
    assert_eq!(origins[0]["localStorage"][0]["name"], "token");
    assert_eq!(origins[0]["localStorage"][0]["value"], "abc");
    assert_eq!(
        origins[1]["origin"], "https://example.com",
        "secure cookie → https（前导点去除）"
    );
    assert_eq!(origins[1]["localStorage"][0]["name"], "theme");
    assert_eq!(origins[1]["localStorage"][0]["value"], "dark");
    // 读取命令按推导清单逐 origin 发出（无注入面调用）
    {
        let calls = channel_calls.lock().unwrap_or_else(|p| p.into_inner());
        assert_eq!(
            *calls,
            vec![
                ChannelCall::GetItems("http://example.org".to_string()),
                ChannelCall::GetItems("https://example.com".to_string()),
            ],
            "导出仅经 get_dom_storage_items 实读（无注入面调用）"
        );
    }
}
