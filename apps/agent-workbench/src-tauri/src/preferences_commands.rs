//! 偏好契约命令（Token与偏好SSOT端到端重构 B2 / N3）
//!
//! 提供 `prefs_get` / `prefs_set` / `prefs_delete` 命令实现。
//! 契约规则：
//! - 未知 key 或非法格式返回 `CoreError::InvalidInput`（严禁静默忽略与破坏性容错）；
//! - 读全量与单 key 读写均保证字段级无损 deepEqual；
//! - 变更记录 updated_at 毫秒时间戳。

use conex_types::CoreError;
use serde_json::Value;
use tauri::State;

use crate::session_commands::SharedDb;

/// 已知合法偏好键白名单
pub const KNOWN_PREFERENCE_KEYS: &[&str] = &[
    "crish_theme",
    "crish_theme_skin",
    "crish_theme_custom_bg",
    "crish_theme_custom_fg",
    "crish_font_size_adjust",
    "crish_theme_brightness_adjust",
    "crish_theme_brightness_vibrant",
    "crish_theme_brightness_auto_time",
    "crish_fonts",
    "crish_sidebar_width",
    "crish:files-list-ratio",
    "crish:file-viewer-word-wrap",
    "crish_app_mode",
    "crish_product_shell",
    "crish_show_engine_settings",
    "conex_pi_settings",
    "crish_settings",
    "crish-layout-v1",
    "crish_session_store_v1",
    "crish_active_model_id",
    "crish_active_profile_id",
    "crish_workspace",
    "crish_restore_last_workspace",
    "crish_layout",
    "flow_dag_visible",
    "crish_ui_density",
    "crish_ui_scale",
    "crish_theme_brightness",
];

/// 检查是否为已知偏好 key
pub fn is_known_preference_key(key: &str) -> bool {
    KNOWN_PREFERENCE_KEYS.contains(&key)
}

/// 偏好值格式校验
pub fn validate_preference_value(key: &str, value: &Value) -> Result<(), CoreError> {
    match key {
        "crish_theme" => match value {
            Value::String(s) if !s.trim().is_empty() => Ok(()),
            _ => Err(CoreError::invalid_input(
                "crish_theme must be a non-empty string (e.g. 'dark', 'light', 'system')",
            )),
        },
        "crish_theme_skin"
        | "crish_theme_custom_bg"
        | "crish_theme_custom_fg"
        | "crish_app_mode"
        | "crish_product_shell"
        | "crish_active_model_id"
        | "crish_active_profile_id"
        | "crish_workspace" => {
            if value.is_string() {
                Ok(())
            } else {
                Err(CoreError::invalid_input(format!(
                    "{key} must be a string value"
                )))
            }
        }
        "crish_font_size_adjust" | "crish_theme_brightness_adjust" | "crish_sidebar_width" => {
            if value.is_number() {
                Ok(())
            } else if let Some(s) = value.as_str() {
                if s.trim().parse::<f64>().is_ok() {
                    Ok(())
                } else {
                    Err(CoreError::invalid_input(format!(
                        "{key} string value must be numeric"
                    )))
                }
            } else {
                Err(CoreError::invalid_input(format!(
                    "{key} must be a number or numeric string"
                )))
            }
        }
        "crish:files-list-ratio" => {
            let num = if let Some(n) = value.as_f64() {
                Some(n)
            } else if let Some(s) = value.as_str() {
                s.trim().parse::<f64>().ok()
            } else {
                None
            };
            match num {
                Some(r) if (0.0..=1.0).contains(&r) => Ok(()),
                Some(_) => Err(CoreError::invalid_input(
                    "crish:files-list-ratio must be between 0.0 and 1.0",
                )),
                None => Err(CoreError::invalid_input(
                    "crish:files-list-ratio must be numeric",
                )),
            }
        }
        "crish_theme_brightness_vibrant"
        | "crish_theme_brightness_auto_time"
        | "crish:file-viewer-word-wrap"
        | "crish_show_engine_settings"
        | "crish_restore_last_workspace"
        | "flow_dag_visible" => {
            if value.is_boolean() {
                Ok(())
            } else if let Some(s) = value.as_str() {
                if s == "true" || s == "false" || s == "1" || s == "0" {
                    Ok(())
                } else {
                    Err(CoreError::invalid_input(format!(
                        "{key} string value must be 'true' or 'false'"
                    )))
                }
            } else {
                Err(CoreError::invalid_input(format!(
                    "{key} must be a boolean or boolean string"
                )))
            }
        }
        "crish_fonts"
        | "conex_pi_settings"
        | "crish_settings"
        | "crish-layout-v1"
        | "crish_session_store_v1"
        | "crish_layout" => {
            if value.is_string() || value.is_object() || value.is_array() {
                Ok(())
            } else {
                Err(CoreError::invalid_input(format!(
                    "{key} must be a string, object, or array"
                )))
            }
        }
        _ => Ok(()),
    }
}

/// 读取偏好（支持读单 key 或全量偏好）。
#[tauri::command]
pub async fn prefs_get(
    key: Option<String>,
    db_state: State<'_, SharedDb>,
) -> Result<Value, CoreError> {
    let db = db_state.inner().local_db();
    match key {
        Some(k) => {
            if k.trim().is_empty() {
                return Err(CoreError::invalid_input("preference key must not be empty"));
            }
            if !is_known_preference_key(&k) {
                return Err(CoreError::invalid_input(format!(
                    "unknown preference key: {k}"
                )));
            }
            let row = tokio::task::spawn_blocking(move || db.get_preference(&k))
                .await
                .map_err(|e| CoreError::Internal(format!("prefs_get join: {e}")))?
                .map_err(|e| {
                    CoreError::Internal(format!("prefs_get db: {}: {}", e.kind, e.message))
                })?;

            match row {
                Some(r) => {
                    let val = serde_json::from_str::<Value>(&r.value)
                        .unwrap_or_else(|_| Value::String(r.value));
                    Ok(val)
                }
                None => Ok(Value::Null),
            }
        }
        None => {
            let rows = tokio::task::spawn_blocking(move || db.list_preferences())
                .await
                .map_err(|e| CoreError::Internal(format!("prefs_get join: {e}")))?
                .map_err(|e| {
                    CoreError::Internal(format!("prefs_get db: {}: {}", e.kind, e.message))
                })?;

            let mut map = serde_json::Map::new();
            for r in rows {
                let val = serde_json::from_str::<Value>(&r.value)
                    .unwrap_or_else(|_| Value::String(r.value));
                map.insert(r.key, val);
            }
            Ok(Value::Object(map))
        }
    }
}

/// 写入或更新偏好。
#[tauri::command]
pub async fn prefs_set(
    key: String,
    value: Value,
    db_state: State<'_, SharedDb>,
) -> Result<(), CoreError> {
    if key.trim().is_empty() {
        return Err(CoreError::invalid_input("preference key must not be empty"));
    }
    if !is_known_preference_key(&key) {
        return Err(CoreError::invalid_input(format!(
            "unknown preference key: {key}"
        )));
    }
    validate_preference_value(&key, &value)?;

    let db = db_state.inner().local_db();
    let serialized = serde_json::to_string(&value)
        .map_err(|e| CoreError::invalid_input(format!("cannot serialize preference value: {e}")))?;

    let now_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0);

    tokio::task::spawn_blocking(move || db.set_preference(&key, &serialized, now_ms))
        .await
        .map_err(|e| CoreError::Internal(format!("prefs_set join: {e}")))?
        .map_err(|e| {
            CoreError::Internal(format!("prefs_set db: {}: {}", e.kind, e.message))
        })?;

    Ok(())
}

/// 删除指定偏好 key。
#[tauri::command]
pub async fn prefs_delete(
    key: String,
    db_state: State<'_, SharedDb>,
) -> Result<bool, CoreError> {
    if key.trim().is_empty() {
        return Err(CoreError::invalid_input("preference key must not be empty"));
    }
    if !is_known_preference_key(&key) {
        return Err(CoreError::invalid_input(format!(
            "unknown preference key: {key}"
        )));
    }
    let db = db_state.inner().local_db();
    let deleted = tokio::task::spawn_blocking(move || db.delete_preference(&key))
        .await
        .map_err(|e| CoreError::Internal(format!("prefs_delete join: {e}")))?
        .map_err(|e| {
            CoreError::Internal(format!("prefs_delete db: {}: {}", e.kind, e.message))
        })?;

    Ok(deleted)
}

#[cfg(test)]
mod tests {
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
        prefs_set(
            "crish_sidebar_width".to_string(),
            json!(260),
            state.clone(),
        )
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
        let all_prefs = prefs_get(None, state.clone())
            .await
            .expect("get all prefs");
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
}
