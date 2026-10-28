use crate::browser::{BrowserSlot, StorageStateOps};
use async_trait::async_trait;
use conex_browser::cdp::domains::{Cookie as CdpCookie, SetCookieParam};
use conex_browser::import::storage_state::{build_import_plan, parse_storage_state};
use serde_json::json;
use std::sync::Arc;

use super::fixtures::{
    cdp_cookie, err_detail, inject_local_storage_mock, inject_mock, mock_browser_slot, ChannelCall,
    MockLocalStorageChannel, MockStorageOps,
};
use crate::browser_commands::{browser_import_storage_state, verify_cookie_injection};

/// J1b：导入注入参数断言——返回脱敏统计载荷（§5.3/§5.4：不含 value）；
/// wire 参数形状由 [import_wire_params_reach_sender] 断言 mock 记录面。
/// localStorage 注入已接线（K3 面）：注入 mock 通道 → injectedScripts/
/// injectedItems 反映实际执行。
#[tokio::test]
async fn import_injects_cdp_params_and_stats() {
    use tauri::Manager as _;
    let temp = tempfile::tempdir().expect("临时目录");
    let state = mock_browser_slot(&temp);
    let app = tauri::test::mock_builder()
        .manage(Arc::clone(&state))
        .build(tauri::test::mock_context(tauri::test::noop_assets()))
        .expect("mock app");
    let state_ref = app.state::<Arc<BrowserSlot>>();

    inject_mock(&state, MockStorageOps::new(Vec::new()));
    // localStorage 注入通道 mock（§5.3 注入执行面）
    inject_local_storage_mock(&state, MockLocalStorageChannel::default());

    let json = r#"{
        "cookies": [
            {
                "name": "sessionid", "value": "abc123", "domain": ".example.com",
                "path": "/", "expires": -1, "httpOnly": true, "secure": true,
                "sameSite": "lax"
            },
            {
                "name": "persist", "value": "p", "domain": "example.com",
                "path": "/", "expires": 1750000000, "httpOnly": false,
                "secure": false, "sameSite": "None"
            },
            {
                "name": "dup", "value": "first", "domain": "example.com", "path": "/"
            },
            {
                "name": "dup", "value": "last", "domain": "example.com", "path": "/"
            },
            {
                "name": "", "value": "no-name", "domain": "example.com", "path": "/"
            }
        ],
        "origins": [
            { "origin": "https://example.com", "localStorage": [
                { "name": "theme", "value": "dark" },
                { "name": "k2", "value": "v2" }
            ] }
        ]
    }"#;
    let payload = browser_import_storage_state(json.to_string(), state_ref)
        .await
        .expect("导入不应失败");
    // 脱敏统计载荷（§5.3/§5.4：不含 value）
    assert_eq!(
        serde_json::to_value(&payload).unwrap(),
        json!({
            "cookies": 3,
            "origins": 1,
            "localStorageItems": 2,
            "injectedScripts": 1,
            "injectedItems": 2,
            "droppedDupes": 1,
            "skippedEmptyName": 1
        }),
        "统计：同键去重 + 空名过滤后 3 条；localStorage 注入执行 1 脚本 + 2 直写"
    );
}

/// J1b：导入注入参数 wire 断言（mock 记录面版本）——验证命令确实把
/// `to_cdp_params` 结果传到了发送面（会话 cookie expires=None）。
#[tokio::test]
async fn import_wire_params_reach_sender() {
    use tauri::Manager as _;
    let temp = tempfile::tempdir().expect("临时目录");
    let state = mock_browser_slot(&temp);
    let app = tauri::test::mock_builder()
        .manage(Arc::clone(&state))
        .build(tauri::test::mock_context(tauri::test::noop_assets()))
        .expect("mock app");
    let state_ref = app.state::<Arc<BrowserSlot>>();

    let mock = MockStorageOps::new(Vec::new());
    // 保持句柄以读取注入记录
    let injected = Arc::clone(&mock.injected);
    let get_calls = Arc::clone(&mock.get_calls);
    inject_mock(&state, mock);

    let json = r#"{
        "cookies": [
            {
                "name": "sessionid", "value": "abc123", "domain": ".example.com",
                "path": "/", "expires": -1, "httpOnly": true, "secure": true,
                "sameSite": "lax"
            },
            {
                "name": "persist", "value": "p", "domain": "example.com",
                "path": "/", "expires": 1750000000, "httpOnly": false,
                "secure": false, "sameSite": "None"
            }
        ]
    }"#;
    browser_import_storage_state(json.to_string(), state_ref)
        .await
        .expect("导入不应失败");
    assert_eq!(
        get_calls.load(std::sync::atomic::Ordering::SeqCst),
        1,
        "N8：注入后必须发生一次回读比对"
    );
    {
        // 持锁断言注入记录（SetCookieParam 无 Clone，锁内读取字段）
        let params = injected.lock().unwrap_or_else(|p| p.into_inner());
        assert_eq!(params.len(), 2);
        // 会话 cookie：expires=None（§5.1 归一化移除 expires 字段）
        assert_eq!(params[0].name, "sessionid");
        assert_eq!(params[0].domain.as_deref(), Some(".example.com"));
        assert_eq!(params[0].path.as_deref(), Some("/"));
        assert!(params[0].expires.is_none(), "会话 cookie expires=None");
        assert_eq!(params[0].same_site.as_deref(), Some("Lax"), "小写归一化");
        // 持久 cookie：expires 保留
        assert_eq!(params[1].name, "persist");
        assert_eq!(params[1].expires, Some(1_750_000_000.0));
        assert_eq!(params[1].same_site.as_deref(), Some("None"));
    }
}

/// N8：回验比对纯函数——一致面（含域去点容差）→ 空缺失；不一致面
/// （value 被改写 / 整体缺失）→ 缺失键清单（`domain:name:path`）。
#[test]
fn verify_cookie_injection_matches_and_reports_missing() {
    let json = r#"{
        "cookies": [
            { "name": "a", "value": "1", "domain": ".example.com", "path": "/" },
            { "name": "b", "value": "2", "domain": "example.org", "path": "/x" }
        ]
    }"#;
    let plan = build_import_plan(&parse_storage_state(json).expect("解析"));
    // 一致面：回读含全部计划键（域有点/无点均匹配）+ value 相等
    let read_back = vec![
        cdp_cookie(|c| {
            c.name = "a".to_string();
            c.value = "1".to_string();
            c.domain = "example.com".to_string();
            c.path = "/".to_string();
        }),
        cdp_cookie(|c| {
            c.name = "b".to_string();
            c.value = "2".to_string();
            c.domain = ".example.org".to_string();
            c.path = "/x".to_string();
        }),
    ];
    assert!(
        verify_cookie_injection(&plan, &read_back).is_empty(),
        "全量命中（含去点容差）必须通过"
    );
    // 不一致面：a 的 value 被改写（浏览器拒绝/归一化）+ b 整体缺失
    let read_back = vec![cdp_cookie(|c| {
        c.name = "a".to_string();
        c.value = "9".to_string();
        c.domain = "example.com".to_string();
    })];
    let missing = verify_cookie_injection(&plan, &read_back);
    assert_eq!(missing.len(), 2, "value 改写 + 缺失均须报告：{missing:?}");
    assert!(
        missing
            .iter()
            .any(|k| k.contains("a") && k.contains("example.com")),
        "a 键须在缺失清单：{missing:?}"
    );
    assert!(
        missing
            .iter()
            .any(|k| k.contains("b") && k.contains("example.org")),
        "b 键须在缺失清单：{missing:?}"
    );
}

/// N8：注入后回读不一致——差异**仅记录不失败**（取舍注释见实现处）：
/// 命令仍返回脱敏统计载荷（cookie 已尽力注入，重导覆盖语义幂等自愈）。
#[tokio::test]
async fn import_verification_records_mismatch_without_failure() {
    use tauri::Manager as _;
    let temp = tempfile::tempdir().expect("临时目录");
    let state = mock_browser_slot(&temp);
    let app = tauri::test::mock_builder()
        .manage(Arc::clone(&state))
        .build(tauri::test::mock_context(tauri::test::noop_assets()))
        .expect("mock app");
    let state_ref = app.state::<Arc<BrowserSlot>>();

    // 模拟浏览器拒绝面：注入成功但回读恒空（cookie 被浏览器拒绝，
    // 如 SameSite=None 未配 Secure）——回验应检测到全部缺失
    struct PartialWriteOps {
        read_calls: Arc<std::sync::atomic::AtomicUsize>,
    }
    #[async_trait]
    impl StorageStateOps for PartialWriteOps {
        async fn get_all_cookies(&self) -> Result<Vec<CdpCookie>, String> {
            self.read_calls
                .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            Ok(Vec::new())
        }
        async fn set_cookies(&self, _cookies: Vec<SetCookieParam>) -> Result<(), String> {
            Ok(())
        }
    }

    let ops = PartialWriteOps {
        read_calls: Arc::new(std::sync::atomic::AtomicUsize::new(0)),
    };
    let read_calls = Arc::clone(&ops.read_calls);
    state_ref.inject_storage_ops(Arc::new(ops));

    let json = r#"{
        "cookies": [
            { "name": "a", "value": "1", "domain": "example.com", "path": "/" }
        ]
    }"#;
    let payload = browser_import_storage_state(json.to_string(), state_ref)
        .await
        .expect("回验差异仅记录，命令不失败");
    assert_eq!(payload.cookies, 1, "统计载荷仍反映注入计划");
    assert_eq!(
        read_calls.load(std::sync::atomic::Ordering::SeqCst),
        1,
        "N8：注入后必须发生一次回读比对"
    );
}

/// J1b：导入解析失败路径——非法 JSON → `tool.invalid_input` 结构化错误。
#[tokio::test]
async fn import_rejects_bad_json() {
    use tauri::Manager as _;
    let temp = tempfile::tempdir().expect("临时目录");
    let state = mock_browser_slot(&temp);
    let app = tauri::test::mock_builder()
        .manage(Arc::clone(&state))
        .build(tauri::test::mock_context(tauri::test::noop_assets()))
        .expect("mock app");
    let state_ref = app.state::<Arc<BrowserSlot>>();

    let err = browser_import_storage_state("{ not json !!".to_string(), state_ref)
        .await
        .expect_err("非法 JSON 必须失败");
    let detail = err_detail(err);
    assert!(
        detail.starts_with("tool.invalid_input:"),
        "invalid_input 结构化码前缀：{detail}"
    );
}

/// J1b：domain 守卫拒绝路径——非法 domain → `tool.invalid_input`
/// （§5.3 domain 守卫，注入前拦截）。
#[tokio::test]
async fn import_rejects_invalid_domain() {
    use tauri::Manager as _;
    let temp = tempfile::tempdir().expect("临时目录");
    let state = mock_browser_slot(&temp);
    let app = tauri::test::mock_builder()
        .manage(Arc::clone(&state))
        .build(tauri::test::mock_context(tauri::test::noop_assets()))
        .expect("mock app");
    let state_ref = app.state::<Arc<BrowserSlot>>();

    let json = r#"{"cookies":[{"name":"n","value":"v","domain":"javascript:"}]}"#;
    let err = browser_import_storage_state(json.to_string(), state_ref)
        .await
        .expect_err("domain 守卫必须拒绝");
    let detail = err_detail(err);
    assert!(
        detail.starts_with("tool.invalid_input:"),
        "invalid_input 结构化码前缀：{detail}"
    );
}

/// J1b：导入未连接路径——未注入 mock → `tool.browser.not_ready`
/// （解析通过但注入面未连接，§5.3 注入前置）。
#[tokio::test]
async fn import_not_ready_without_session() {
    use tauri::Manager as _;
    let temp = tempfile::tempdir().expect("临时目录");
    let state = mock_browser_slot(&temp);
    let app = tauri::test::mock_builder()
        .manage(Arc::clone(&state))
        .build(tauri::test::mock_context(tauri::test::noop_assets()))
        .expect("mock app");
    let state_ref = app.state::<Arc<BrowserSlot>>();

    let err = browser_import_storage_state(
        r#"{"cookies":[{"name":"n","value":"v","domain":"example.com"}]}"#.to_string(),
        state_ref,
    )
    .await
    .expect_err("未连接必须失败");
    let detail = err_detail(err);
    assert!(
        detail.starts_with("tool.browser.not_ready:"),
        "not_ready 结构化码前缀：{detail}"
    );
}

/// J1b 扩展面：localStorage 注入执行（§5.3）——mock 通道断言调用序
/// （每 origin 先注册守卫脚本，再逐条直写）+ 载荷 injectedScripts/
/// injectedItems 反映实际执行。
#[tokio::test]
async fn import_storage_state_injects_local_storage_channel() {
    use tauri::Manager as _;
    let temp = tempfile::tempdir().expect("临时目录");
    let state = mock_browser_slot(&temp);
    let app = tauri::test::mock_builder()
        .manage(Arc::clone(&state))
        .build(tauri::test::mock_context(tauri::test::noop_assets()))
        .expect("mock app");
    let state_ref = app.state::<Arc<BrowserSlot>>();

    inject_mock(&state, MockStorageOps::new(Vec::new()));
    let channel = MockLocalStorageChannel::default();
    let calls = Arc::clone(&channel.calls);
    inject_local_storage_mock(&state, channel);

    let json = r#"{
        "cookies": [],
        "origins": [
            { "origin": "https://example.com", "localStorage": [
                { "name": "theme", "value": "dark" },
                { "name": "token", "value": "abc" }
            ] },
            { "origin": "https://sub.example.org", "localStorage": [
                { "name": "k", "value": "v" }
            ] }
        ]
    }"#;
    let payload = browser_import_storage_state(json.to_string(), state_ref)
        .await
        .expect("导入不应失败");
    assert_eq!(payload.origins, 2);
    assert_eq!(payload.local_storage_items, 3);
    assert_eq!(payload.injected_scripts, 2, "每 origin 一条守卫脚本");
    assert_eq!(payload.injected_items, 3, "直写条目总数");
    // 调用序：每 origin 先注册守卫脚本，再逐条直写（§5.3 两机制互补）
    let calls = calls.lock().unwrap_or_else(|p| p.into_inner());
    assert_eq!(calls.len(), 5);
    assert!(
        matches!(&calls[0], ChannelCall::InitScript(s)
            if s.contains(r#"window.location.origin !== "https://example.com""#)),
        "脚本须含 origin 守卫（防跨站污染）且指向目标 origin"
    );
    assert!(
        matches!(&calls[1], ChannelCall::SetItem { origin, key, value }
            if origin == "https://example.com" && key == "theme" && value == "dark")
    );
    assert!(matches!(&calls[2], ChannelCall::SetItem { origin, key, .. }
            if origin == "https://example.com" && key == "token"));
    assert!(matches!(&calls[3], ChannelCall::InitScript(s) if s.contains("sub.example.org")));
    assert!(
        matches!(&calls[4], ChannelCall::SetItem { origin, key, value }
            if origin == "https://sub.example.org" && key == "k" && value == "v")
    );
}

/// J1b 扩展面：localStorage 注入前置——cookie 注入通过但未注入通道
/// （无会话）→ `tool.browser.not_ready`（辅助通道须先 browser_start）。
#[tokio::test]
async fn import_storage_state_local_storage_not_ready_without_channel() {
    use tauri::Manager as _;
    let temp = tempfile::tempdir().expect("临时目录");
    let state = mock_browser_slot(&temp);
    let app = tauri::test::mock_builder()
        .manage(Arc::clone(&state))
        .build(tauri::test::mock_context(tauri::test::noop_assets()))
        .expect("mock app");
    let state_ref = app.state::<Arc<BrowserSlot>>();

    // cookie 面注入 mock（通过），localStorage 通道未注入（未连接面）
    inject_mock(&state, MockStorageOps::new(Vec::new()));

    let json = r#"{
        "cookies": [],
        "origins": [
            { "origin": "https://example.com", "localStorage": [
                { "name": "theme", "value": "dark" }
            ] }
        ]
    }"#;
    let err = browser_import_storage_state(json.to_string(), state_ref)
        .await
        .expect_err("无通道必须失败");
    let detail = err_detail(err);
    assert!(
        detail.starts_with("tool.browser.not_ready:"),
        "not_ready 结构化码前缀：{detail}"
    );
}
