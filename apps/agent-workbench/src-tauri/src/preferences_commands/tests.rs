//! preferences_commands 测试（preferences_commands.rs 拆分）。

use super::*;

use conex_db::LocalDb;
use serde_json::json;
use tauri::Manager as _;

fn make_test_app() -> tauri::App<tauri::test::MockRuntime> {
    let db = LocalDb::open_in_memory().expect("open memory db");
    let shared = SharedDb::new(db);
    tauri::test::mock_builder()
        .manage(shared)
        .build(tauri::test::mock_context(tauri::test::noop_assets()))
        .expect("mock app")
}

#[tokio::test]
async fn test_unknown_key_returns_invalid_input() {
    let app = make_test_app();
    let state = app.state::<SharedDb>();

    let err_get = prefs_get(Some("unknown_foo_bar".to_string()), state.clone())
        .await
        .unwrap_err();
    assert!(matches!(err_get, CoreError::InvalidInput(_)));

    let err_set = prefs_set(
        "unknown_foo_bar".to_string(),
        json!("some_value"),
        state.clone(),
    )
    .await
    .unwrap_err();
    assert!(matches!(err_set, CoreError::InvalidInput(_)));

    let err_del = prefs_delete("unknown_foo_bar".to_string(), state.clone())
        .await
        .unwrap_err();
    assert!(matches!(err_del, CoreError::InvalidInput(_)));
}

#[tokio::test]
async fn test_empty_key_returns_invalid_input() {
    let app = make_test_app();
    let state = app.state::<SharedDb>();

    let err_get = prefs_get(Some("   ".to_string()), state.clone())
        .await
        .unwrap_err();
    assert!(matches!(err_get, CoreError::InvalidInput(_)));

    let err_set = prefs_set("   ".to_string(), json!("val"), state.clone())
        .await
        .unwrap_err();
    assert!(matches!(err_set, CoreError::InvalidInput(_)));

    let err_del = prefs_delete("".to_string(), state.clone())
        .await
        .unwrap_err();
    assert!(matches!(err_del, CoreError::InvalidInput(_)));
}

#[tokio::test]
async fn test_invalid_value_format_returns_invalid_input() {
    let app = make_test_app();
    let state = app.state::<SharedDb>();

    // crish_theme 必须是非空字符串
    let err1 = prefs_set("crish_theme".to_string(), json!(123), state.clone())
        .await
        .unwrap_err();
    assert!(matches!(err1, CoreError::InvalidInput(_)));

    let err1_empty = prefs_set("crish_theme".to_string(), json!("   "), state.clone())
        .await
        .unwrap_err();
    assert!(matches!(err1_empty, CoreError::InvalidInput(_)));

    // crish_sidebar_width 必须是数值
    let err2 = prefs_set(
        "crish_sidebar_width".to_string(),
        json!("not_a_number"),
        state.clone(),
    )
    .await
    .unwrap_err();
    assert!(matches!(err2, CoreError::InvalidInput(_)));

    // crish_theme_brightness_vibrant 必须是布尔值或合法的布尔字符串
    let err3 = prefs_set(
        "crish_theme_brightness_vibrant".to_string(),
        json!("maybe"),
        state.clone(),
    )
    .await
    .unwrap_err();
    assert!(matches!(err3, CoreError::InvalidInput(_)));

    // crish:files-list-ratio 必须在 0.0..=1.0 之间
    let err4 = prefs_set(
        "crish:files-list-ratio".to_string(),
        json!(2.5),
        state.clone(),
    )
    .await
    .unwrap_err();
    assert!(matches!(err4, CoreError::InvalidInput(_)));
}

#[tokio::test]
async fn test_prefs_crud_roundtrip_deepequal() {
    let app = make_test_app();
    let state = app.state::<SharedDb>();

    // 写入 theme 字符串
    prefs_set("crish_theme".to_string(), json!("dark"), state.clone())
        .await
        .expect("set crish_theme");
    let theme_val = prefs_get(Some("crish_theme".to_string()), state.clone())
        .await
        .expect("get crish_theme");
    assert_eq!(theme_val, json!("dark"));

    // 写入数值
    prefs_set("crish_sidebar_width".to_string(), json!(260), state.clone())
        .await
        .expect("set sidebar width");
    let width_val = prefs_get(Some("crish_sidebar_width".to_string()), state.clone())
        .await
        .expect("get sidebar width");
    assert_eq!(width_val, json!(260));

    // 写入布尔值
    prefs_set(
        "crish:file-viewer-word-wrap".to_string(),
        json!(true),
        state.clone(),
    )
    .await
    .expect("set word wrap");
    let wrap_val = prefs_get(
        Some("crish:file-viewer-word-wrap".to_string()),
        state.clone(),
    )
    .await
    .expect("get word wrap");
    assert_eq!(wrap_val, json!(true));

    // 写入复合对象
    let font_pref = json!({
        "codeFont": "JetBrains Mono",
        "uiFont": "Inter"
    });
    prefs_set("crish_fonts".to_string(), font_pref.clone(), state.clone())
        .await
        .expect("set crish_fonts");
    let fonts_val = prefs_get(Some("crish_fonts".to_string()), state.clone())
        .await
        .expect("get crish_fonts");
    assert_eq!(fonts_val, font_pref);

    // 全量读取
    let all_prefs = prefs_get(None, state.clone()).await.expect("get all prefs");
    let obj = all_prefs.as_object().expect("is object");
    assert_eq!(obj.get("crish_theme"), Some(&json!("dark")));
    assert_eq!(obj.get("crish_sidebar_width"), Some(&json!(260)));
    assert_eq!(obj.get("crish:file-viewer-word-wrap"), Some(&json!(true)));
    assert_eq!(obj.get("crish_fonts"), Some(&font_pref));

    // 删除已有 key
    let deleted = prefs_delete("crish_theme".to_string(), state.clone())
        .await
        .expect("delete crish_theme");
    assert!(deleted);

    // 再次 get 返回 Null
    let theme_after_delete = prefs_get(Some("crish_theme".to_string()), state.clone())
        .await
        .expect("get deleted crish_theme");
    assert_eq!(theme_after_delete, Value::Null);

    // 重复删除返回 false
    let deleted_again = prefs_delete("crish_theme".to_string(), state.clone())
        .await
        .expect("delete again");
    assert!(!deleted_again);
}
