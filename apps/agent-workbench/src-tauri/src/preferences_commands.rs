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
use conex_db::DbFailure;

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
    // ── 语义键空间（2026-09-11 对齐前端 preferencesSchema.ts 的权威键）──
    // 前端 preferencesClient 以语义键（theme/fonts/files_list_ratio/…）为规范键调用
    // prefs_*；旧键（crish_theme/…）经前端 PREFERENCE_KEY_ALIASES 归一为语义键。
    // 此前后端白名单只含旧键，导致 prefs_get/prefs_set 对语义键全部返回
    // InvalidInput（运行时实测 60 条 error，主题/字体/换行/列表比例持久化失效）。
    // 后端白名单必须与前端权威键空间 1:1 对齐（幽灵契约零容忍）。
    "theme",
    "theme_skin",
    "theme_custom_bg",
    "theme_custom_fg",
    "font_size_adjust",
    "theme_brightness_adjust",
    "theme_brightness_vibrant",
    "theme_brightness_auto_time",
    "ui_size",
    "shell_chrome_mode",
    "sidebar_collapsed",
    "sidebar_width",
    "tab_mode_enabled",
    "files_list_ratio",
    "file_viewer_word_wrap",
    "fonts",
    "app_mode",
    "product_shell",
    "show_engine_settings",
];

/// 语义键 → 旧版存储键（读取回退链）。
/// 语义键尚无数据行时回读旧键行，避免既有用户偏好因键空间迁移而一次性丢失。
pub const SEMANTIC_TO_LEGACY: &[(&str, &str)] = &[
    ("theme", "crish_theme"),
    ("theme_skin", "crish_theme_skin"),
    ("theme_custom_bg", "crish_theme_custom_bg"),
    ("theme_custom_fg", "crish_theme_custom_fg"),
    ("font_size_adjust", "crish_font_size_adjust"),
    ("theme_brightness_adjust", "crish_theme_brightness_adjust"),
    ("theme_brightness_vibrant", "crish_theme_brightness_vibrant"),
    (
        "theme_brightness_auto_time",
        "crish_theme_brightness_auto_time",
    ),
    ("fonts", "crish_fonts"),
    ("files_list_ratio", "crish:files-list-ratio"),
    ("file_viewer_word_wrap", "crish:file-viewer-word-wrap"),
    ("app_mode", "crish_app_mode"),
    ("product_shell", "crish_product_shell"),
    ("show_engine_settings", "crish_show_engine_settings"),
    ("sidebar_width", "crish_sidebar_width"),
];

/// 语义键的旧版别名键（若存在则视为同一偏好的历史行）
fn legacy_alias_of(key: &str) -> Option<&'static str> {
    SEMANTIC_TO_LEGACY
        .iter()
        .find(|(s, _)| *s == key)
        .map(|(_, l)| *l)
}

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
        // 数值族：语义键与旧键共用同一宽容臂（数字或数字字符串）。
        // 范围校验由前端 preferencesSchema.validatePreferenceValue 在发送前执行——
        // 后端若再叠一层严格范围会拒绝前端真实载荷（实测 font_size_adjust /
        // theme_brightness_adjust / sidebar_width 三键 hydration 被拒，见台账 D26 复验）。
        "crish_font_size_adjust"
        | "crish_theme_brightness_adjust"
        | "crish_sidebar_width"
        | "font_size_adjust"
        | "theme_brightness_adjust"
        | "sidebar_width" => {
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
        // ── 语义键空间（与前端 preferencesSchema.ts 逐字段对齐）──
        "theme" => {
            if let Value::String(s) = value {
                if !s.trim().is_empty() {
                    return Ok(());
                }
            }
            Err(CoreError::invalid_input(
                "theme must be a non-empty string (default|dark|light|oled|sepia|cyberpunk|nord)",
            ))
        }
        "theme_skin" | "theme_custom_bg" | "theme_custom_fg" => {
            if value.is_string() {
                Ok(())
            } else {
                Err(CoreError::invalid_input(format!("{key} must be a string")))
            }
        }
        // font_size_adjust / theme_brightness_adjust / sidebar_width 的数值族校验
        // 已并入上方与旧键共用的宽容臂（数字或数字字符串，不做范围硬校验）。
        "theme_brightness_vibrant"
        | "theme_brightness_auto_time"
        | "sidebar_collapsed"
        | "tab_mode_enabled"
        | "file_viewer_word_wrap"
        | "product_shell"
        | "show_engine_settings" => {
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
        "ui_size" => match value {
            Value::String(s) if s == "compact" || s == "normal" || s == "spacious" => Ok(()),
            _ => Err(CoreError::invalid_input(
                "ui_size must be one of compact|normal|spacious",
            )),
        },
        "shell_chrome_mode" => match value {
            Value::String(s) if s == "frameless" || s == "native" || s == "bordered" => Ok(()),
            _ => Err(CoreError::invalid_input(
                "shell_chrome_mode must be one of frameless|native|bordered",
            )),
        },
        "files_list_ratio" => match value {
            Value::Number(n) => {
                let r = n.as_f64().unwrap_or(f64::NAN);
                if (0.05..=0.95).contains(&r) || (5.0..=95.0).contains(&r) {
                    Ok(())
                } else {
                    Err(CoreError::invalid_input(
                        "files_list_ratio must be within [0.05, 0.95] or [5, 95]",
                    ))
                }
            }
            _ => Err(CoreError::invalid_input(
                "files_list_ratio must be a number within [0.05, 0.95] or [5, 95]",
            )),
        },
        "fonts" => {
            if value.is_string() || value.is_object() {
                Ok(())
            } else {
                Err(CoreError::invalid_input(
                    "fonts must be a string or an object ({uiFont, monoFont, monoLigatures, v})",
                ))
            }
        }
        "app_mode" => match value {
            Value::String(s)
                if s == "developer"
                    || s == "minimal"
                    || s == "architect"
                    || s == "normal"
                    || s == "demo" =>
            {
                Ok(())
            }
            _ => Err(CoreError::invalid_input(
                "app_mode must be one of developer|minimal|architect|normal|demo",
            )),
        },
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
            let row = tokio::task::spawn_blocking(move || {
                // 读取回退：语义键尚无数据行时回读旧版别名键行，
                // 避免既有用户偏好因键空间迁移而一次性丢失（无损迁移读路径）。
                match db.get_preference(&k) {
                    Ok(Some(r)) => Ok(Some(r)),
                    Ok(None) => match legacy_alias_of(&k) {
                        Some(legacy) => db.get_preference(legacy),
                        None => Ok(None),
                    },
                    Err(e) => Err(e),
                }
            })
            .await
            .map_err(|e| CoreError::Internal(format!("prefs_get join: {e}")))?
            .map_err(|e| CoreError::Internal(format!("prefs_get db: {}: {}", e.kind, e.message)))?;

            match row {
                Some(r) => {
                    let val = serde_json::from_str::<Value>(&r.value)
                        .unwrap_or(Value::String(r.value));
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
                    .unwrap_or(Value::String(r.value));
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
        .map_err(|e| CoreError::Internal(format!("prefs_set db: {}: {}", e.kind, e.message)))?;

    Ok(())
}

/// 删除指定偏好 key。
#[tauri::command]
pub async fn prefs_delete(key: String, db_state: State<'_, SharedDb>) -> Result<bool, CoreError> {
    if key.trim().is_empty() {
        return Err(CoreError::invalid_input("preference key must not be empty"));
    }
    if !is_known_preference_key(&key) {
        return Err(CoreError::invalid_input(format!(
            "unknown preference key: {key}"
        )));
    }
    let db = db_state.inner().local_db();
    let deleted = tokio::task::spawn_blocking(move || -> Result<bool, DbFailure> {
        // 删除回退：同时清除语义键行与旧版别名键行，
        // 否则旧别名行残留会让「删除后读取」经回退链复活旧值（删除看似无效）。
        let mut deleted_any = db.delete_preference(&key)?;
        if let Some(legacy) = legacy_alias_of(&key) {
            if db.delete_preference(legacy)? {
                deleted_any = true;
            }
        }
        Ok(deleted_any)
    })
    .await
    .map_err(|e| CoreError::Internal(format!("prefs_delete join: {e}")))?
    .map_err(|e| CoreError::Internal(format!("prefs_delete db: {}: {}", e.kind, e.message)))?;

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
}
