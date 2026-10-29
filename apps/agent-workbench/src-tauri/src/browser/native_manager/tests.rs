//! 原生 WebView2 管理器：导航守卫 / Inspector 握手 / UDF 生命周期 / 载荷契约。

use super::*;

#[test]
fn takeover_navigation_requires_an_explicit_nonblank_url() {
    assert_eq!(explicit_takeover_navigation_target(None), None);
    assert_eq!(
        explicit_takeover_navigation_target(Some("about:blank")),
        None
    );
    assert_eq!(
        explicit_takeover_navigation_target(Some("https://example.com")),
        Some("https://example.com")
    );
}

#[test]
fn takeover_probe_registration_only_targets_future_documents() {
    let source = include_str!("native_inspector.rs");
    let registration_start = source
        .find("async fn register_inspector_runtime_for_future_documents")
        .expect("future-document registration helper is present");
    let registration_tail = &source[registration_start..];
    let registration_end = registration_tail
        .find("\n#[cfg(windows)]\npub(super) async fn current_document_is_complete")
        .expect("future-document registration helper has a following boundary");
    let registration = &registration_tail[..registration_end];
    assert!(registration.contains("AddScriptToExecuteOnDocumentCreated"));
    assert!(!registration.contains("ExecuteScript"));
}

#[test]
fn unavailable_inspector_rejects_enable_without_mutating_the_desired_state() {
    let enabled = AtomicBool::new(false);
    let result = apply_inspector_request_state(&enabled, false, true);

    assert!(result.is_err());
    assert!(!enabled.load(Ordering::Acquire));
}

#[test]
fn unavailable_inspector_can_be_closed_successfully() {
    let enabled = AtomicBool::new(true);
    let previous = apply_inspector_request_state(&enabled, false, false).unwrap();

    assert!(previous);
    assert!(!enabled.load(Ordering::Acquire));
}

#[test]
fn idle_inspector_messages_are_rejected_before_webview_message_read() {
    let pending = AtomicBool::new(false);
    assert_eq!(
        inspector_message_admission(false, false, &pending),
        InspectorMessageAdmission::Rejected
    );

    let source = include_str!("native_inspector.rs");
    let handler_start = source
        .find("let handler = WebMessageReceivedEventHandler::create(Box::new(")
        .expect("Inspector WebMessageReceived handler is present");
    let handler = &source[handler_start..];
    let admission = handler
        .find("let admission = inspector_message_admission(")
        .expect("message admission check is present");
    let rejected = handler
        .find("if admission == InspectorMessageAdmission::Rejected")
        .expect("rejected messages return before reading WebView2 data");
    let getter = handler
        .find("args.TryGetWebMessageAsString(&mut message)")
        .expect("WebView2 string getter is present");
    assert!(admission < rejected && rejected < getter);
}

#[test]
fn inspector_ready_handshake_admits_only_one_ready_message() {
    let pending = AtomicBool::new(true);
    let first = inspector_message_admission(false, false, &pending);

    assert_eq!(first, InspectorMessageAdmission::ReadyHandshake);
    assert!(inspector_message_admission_allows(first, true));
    assert!(!inspector_message_admission_allows(first, false));
    assert_eq!(
        inspector_message_admission(false, false, &pending),
        InspectorMessageAdmission::Rejected
    );
}

#[test]
fn invalid_handshake_message_consumes_window_without_enabling_inspector() {
    let pending = AtomicBool::new(true);
    let available = AtomicBool::new(false);
    let admission = inspector_message_admission(false, false, &pending);

    assert!(!inspector_message_admission_allows(admission, false));
    assert!(!pending.load(Ordering::Acquire));
    assert!(!available.load(Ordering::Acquire));
    assert_eq!(
        inspector_message_admission(false, false, &pending),
        InspectorMessageAdmission::Rejected
    );
}

#[test]
fn document_control_opens_handshake_before_post_and_closes_it_on_failure() {
    let pending = AtomicBool::new(false);
    let failure = post_inspector_control_for_document(
        &pending,
        || true,
        || {
            assert!(pending.load(Ordering::Acquire));
            Err("post failed".to_string())
        },
    );

    assert!(failure.is_err());
    assert!(!pending.load(Ordering::Acquire));

    post_inspector_control_for_document(
        &pending,
        || true,
        || {
            assert!(pending.load(Ordering::Acquire));
            Ok(())
        },
    )
    .unwrap();
    assert!(pending.load(Ordering::Acquire));

    let stale_post = post_inspector_control_for_document(
        &pending,
        || false,
        || panic!("stale document control must not be posted"),
    );
    assert!(stale_post.is_ok());
    assert!(!pending.load(Ordering::Acquire));
}

#[test]
fn only_new_document_control_paths_open_the_ready_handshake() {
    let source = include_str!("native_inspector.rs");
    let registration_start = source
        .find("async fn register_inspector_listener(")
        .expect("Inspector navigation listener is present");
    let registration_end = source[registration_start..]
        .find("\n#[cfg(windows)]\nfn post_inspector_control(")
        .expect("Inspector navigation listener has a following boundary")
        + registration_start;
    assert!(source[registration_start..registration_end]
        .contains("post_inspector_control_for_document("));

    let page_load_start = source
        .find("fn schedule_inspector_control_after_page_load(")
        .expect("page-load control path is present");
    let page_load_end = source[page_load_start..]
        .find("\n#[cfg(windows)]\npub(super) fn schedule_inspector_control(")
        .expect("page-load control path has a following boundary")
        + page_load_start;
    assert!(source[page_load_start..page_load_end].contains("post_inspector_control_for_document("));

    let current_document_start = source
        .find("async fn post_inspector_control_to_webview(")
        .expect("current-document control path is present");
    let current_document_end = source.len();
    assert!(source[current_document_start..current_document_end]
        .contains("post_inspector_control_for_document("));

    let toggle_start = source
        .find("fn schedule_inspector_control(")
        .expect("ordinary Inspector toggle path is present");
    let toggle_end = source[toggle_start..]
        .find("\n#[cfg(windows)]\npub(super) async fn register_inspector_runtime_for_future_documents(")
        .expect("ordinary toggle path has a following boundary")
        + toggle_start;
    assert!(!source[toggle_start..toggle_end].contains("post_inspector_control_for_document("));
}

#[test]
fn test_sanitize_and_validate_url() {
    // 放行标准协议（无 workspace_root：file: 一律拒绝）
    assert_eq!(
        NativeWebviewManager::sanitize_and_validate_url_with_root("https://example.com", None)
            .unwrap(),
        "https://example.com"
    );
    assert_eq!(
        NativeWebviewManager::sanitize_and_validate_url_with_root(
            "http://example.com/test?q=1",
            None
        )
        .unwrap(),
        "http://example.com/test?q=1"
    );
    assert_eq!(
        NativeWebviewManager::sanitize_and_validate_url_with_root("about:blank", None).unwrap(),
        "about:blank"
    );
    assert_eq!(
        NativeWebviewManager::sanitize_and_validate_url_with_root("   ", None).unwrap(),
        "about:blank"
    );
    assert_eq!(
        NativeWebviewManager::sanitize_and_validate_url_with_root("", None).unwrap(),
        "about:blank"
    );
    // 无协议自动补全 https
    assert_eq!(
        NativeWebviewManager::sanitize_and_validate_url_with_root("github.com", None).unwrap(),
        "https://github.com"
    );

    // 严格拦截非法协议
    assert!(
        NativeWebviewManager::sanitize_and_validate_url_with_root("javascript:alert(1)", None)
            .is_err()
    );
    assert!(NativeWebviewManager::sanitize_and_validate_url_with_root(
        "file:///C:/Windows/win.ini",
        None
    )
    .is_err());
    assert!(NativeWebviewManager::sanitize_and_validate_url_with_root(
        "data:text/html,<h1>test</h1>",
        None
    )
    .is_err());
    assert!(
        NativeWebviewManager::sanitize_and_validate_url_with_root("about:config", None).is_err()
    );
    assert!(
        NativeWebviewManager::sanitize_and_validate_url_with_root("about:flags", None).is_err()
    );
}

#[test]
#[allow(clippy::disallowed_methods)] // 测试临时目录清理
fn test_sanitize_with_workspace_root_gates_file_protocol() {
    // 03-分维 §7.3：提供 workspace_root 后，工作区内 file: 放行、越界仍拒绝
    let temp_root = std::env::temp_dir().join("conex-manager-root-gate-test");
    std::fs::create_dir_all(&temp_root).unwrap();
    let inside = temp_root.join("page.html");
    std::fs::write(&inside, "<html></html>").unwrap();
    let inside_url = url::Url::from_file_path(&inside).unwrap().to_string();

    assert!(NativeWebviewManager::sanitize_and_validate_url_with_root(
        &inside_url,
        Some(&temp_root)
    )
    .is_ok());

    let outside_url = if cfg!(windows) {
        "file:///C:/Windows/System32/drivers/etc/hosts"
    } else {
        "file:///etc/hosts"
    };
    assert!(NativeWebviewManager::sanitize_and_validate_url_with_root(
        outside_url,
        Some(&temp_root)
    )
    .is_err());

    let _ = std::fs::remove_dir_all(&temp_root);
}

#[test]
fn test_is_similar_bounds() {
    let b1 = WebviewBounds {
        x: 100.0,
        y: 50.0,
        width: 800.0,
        height: 600.0,
    };
    let b2 = WebviewBounds {
        x: 100.3,
        y: 49.8,
        width: 800.2,
        height: 599.9,
    };
    assert!(NativeWebviewManager::is_similar_bounds(&b1, &b2));

    let b3 = WebviewBounds {
        x: 100.6,
        y: 50.0,
        width: 800.0,
        height: 600.0,
    };
    assert!(!NativeWebviewManager::is_similar_bounds(&b1, &b3));
}

#[test]
fn test_navigation_state_payload_serde() {
    let payload = BrowserNavigationStatePayload::new("tab-1", "https://example.com")
        .with_title("Example Page")
        .with_loading(false)
        .with_history_caps(Some(true), Some(false))
        .with_favicon(Some("https://example.com/favicon.ico".to_string()));

    let json = serde_json::to_string(&payload).unwrap();
    assert!(json.contains("\"tabId\":\"tab-1\""));
    assert!(json.contains("\"url\":\"https://example.com\""));
    assert!(json.contains("\"title\":\"Example Page\""));
    assert!(json.contains("\"canGoBack\":true"));
    assert!(json.contains("\"canGoForward\":false"));
    assert!(json.contains("\"isLoading\":false"));
    assert!(json.contains("\"faviconUrl\":\"https://example.com/favicon.ico\""));

    let deserialized: BrowserNavigationStatePayload = serde_json::from_str(&json).unwrap();
    assert_eq!(deserialized.tab_id, "tab-1");
    assert_eq!(deserialized.url, "https://example.com");
    assert_eq!(deserialized.can_go_back, Some(true));
    assert_eq!(deserialized.can_go_forward, Some(false));
    assert_eq!(
        deserialized.favicon_url.as_deref(),
        Some("https://example.com/favicon.ico")
    );
}

#[cfg(windows)]
#[test]
fn download_state_label_matches_frontend_contract() {
    assert_eq!(
        download_state_label(COREWEBVIEW2_DOWNLOAD_STATE_IN_PROGRESS),
        "progress"
    );
    assert_eq!(
        download_state_label(COREWEBVIEW2_DOWNLOAD_STATE_COMPLETED),
        "completed"
    );
    assert_eq!(
        download_state_label(COREWEBVIEW2_DOWNLOAD_STATE_INTERRUPTED),
        "interrupted"
    );
}

#[test]
fn download_progress_payload_wire_shape_matches_frontend_contract() {
    let payload = DownloadProgressPayload {
        tab_id: "tab-1".to_string(),
        url: "https://example.com/a.zip".to_string(),
        filename: "a.zip".to_string(),
        total_bytes: None,
        received_bytes: 10,
        state: "progress".to_string(),
    };

    let json = serde_json::to_value(&payload).unwrap();
    assert_eq!(json["tabId"], "tab-1");
    assert_eq!(json["receivedBytes"], 10);
    assert!(
        json.get("totalBytes").is_none(),
        "未知总量必须省略字段而非下发 null"
    );
    assert!(json.get("downloadId").is_none(), "载荷不得包含 downloadId");
}

#[test]
fn custom_storage_dir_must_be_a_single_component() {
    let root = Path::new("app-root/browser-storage");
    assert_eq!(
        resolve_custom_storage_dir(root, "ephemeral-tab-1"),
        Some(root.join("ephemeral-tab-1"))
    );
    for escaped in ["", ".", "..", "../evil", "a/b", "/abs"] {
        assert!(
            resolve_custom_storage_dir(root, escaped).is_none(),
            "必须拒绝越界存储目录：{escaped:?}"
        );
    }
}

#[test]
fn close_path_removes_ephemeral_udf_but_keeps_persistent_udf() {
    let root = tempfile::tempdir().expect("临时存储根");
    let ephemeral = root.path().join("ephemeral-tab-close");
    let persistent = root.path().join("persistent-tab-close");
    std::fs::create_dir_all(&ephemeral).unwrap();
    std::fs::create_dir_all(&persistent).unwrap();

    remove_ephemeral_udf_if_needed(BrowserStorageMode::Ephemeral, &ephemeral);
    remove_ephemeral_udf_if_needed(BrowserStorageMode::Persistent, &persistent);

    assert!(!ephemeral.exists(), "Ephemeral Tab 关闭后 UDF 目录必须销毁");
    assert!(persistent.exists(), "Persistent 模式关闭不得删除 UDF 目录");
}

#[test]
fn purge_stale_ephemeral_dirs_removes_only_ephemeral_directories() {
    let root = tempfile::tempdir().expect("临时存储根");
    let ephemeral = root.path().join("ephemeral-tab-1");
    let persistent = root.path().join("persistent-tab");
    std::fs::create_dir_all(ephemeral.join("EBWebView")).unwrap();
    std::fs::create_dir_all(&persistent).unwrap();
    std::fs::write(root.path().join("ephemeral-file"), b"not a dir").unwrap();

    purge_stale_ephemeral_dirs(root.path());

    assert!(!ephemeral.exists(), "ephemeral 目录应被清除");
    assert!(persistent.exists(), "非 ephemeral 目录不得误删");
    assert!(
        root.path().join("ephemeral-file").exists(),
        "同名文件不在清理范围（只处理目录）"
    );
}

#[test]
fn native_manager_new_purges_stale_ephemeral_dirs_on_startup() {
    let app_dir = tempfile::tempdir().expect("临时应用根");
    let storage_root = app_dir.path().join("browser-storage");
    let stale = storage_root.join("ephemeral-crashed-tab");
    std::fs::create_dir_all(&stale).unwrap();

    let manager = NativeWebviewManager::new(app_dir.path().to_path_buf());

    assert!(storage_root.is_dir(), "构造函数仍应创建存储根");
    assert!(
        !stale.exists(),
        "启动 GC 应清除上次崩溃遗留的 ephemeral 目录"
    );
    assert!(manager.webviews.lock().unwrap().is_empty());
}

#[test]
fn navigation_state_history_capabilities_can_be_unknown() {
    let payload = BrowserNavigationStatePayload::new("tab-unknown", "about:blank");
    let json = serde_json::to_string(&payload).unwrap();
    assert!(!json.contains("canGoBack"));
    assert!(!json.contains("canGoForward"));

    let legacy_json = r#"{"tabId":"tab-legacy","url":"about:blank","title":"","isLoading":false}"#;
    let legacy: BrowserNavigationStatePayload =
        serde_json::from_str(legacy_json).expect("missing history fields mean unknown");
    assert_eq!(legacy.can_go_back, None);
    assert_eq!(legacy.can_go_forward, None);
}
