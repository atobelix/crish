//! 模型配置 IPC 薄适配。原文和结构化提交均直接调用同一个核心事务。
use agent_provider::model_store::{ModelsSnapshot, ModelsStore, ModelsStoreError};
use agent_provider::models::{ModelCatalogEntry, UnifiedModelsConfig};
use serde::Serialize;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ValidateModelsYamlResult {
    valid: bool,
    message: Option<String>,
}

#[tauri::command]
pub(crate) async fn workbench_read_models_yaml(
    app: tauri::AppHandle,
) -> Result<ModelsSnapshot, ModelsStoreError> {
    let (mut snapshot, changed) = crate::config::blocking(|store| {
        let before = store.observed()?;
        let snapshot = store.read()?;
        let changed = before != store.observed()?;
        Ok((snapshot, changed))
    })
    .await?;
    if changed {
        crate::config::publish_snapshot(&app, &mut snapshot);
    }
    Ok(snapshot)
}

#[tauri::command]
pub(crate) fn workbench_validate_models_yaml(content: String) -> ValidateModelsYamlResult {
    match ModelsStore::validate_yaml(&content) {
        Ok(_) => ValidateModelsYamlResult {
            valid: true,
            message: None,
        },
        Err(error) => ValidateModelsYamlResult {
            valid: false,
            message: Some(error.message),
        },
    }
}

/// 内置模型目录快照（前端定价面消费）。
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct BundledCatalogSnapshot {
    version: u64,
    entries: Vec<ModelCatalogEntry>,
}

/// 出厂能力字典只读投影（前端定价 / 能力快照数据源，替代已退役 `catalog_get` 的读面）。
///
/// 命名口径：本命令是「出厂能力字典」的只读投影（wire 名 =
/// `workbench_read_capability_dictionary`），**不是**「bundled catalog」这个
/// 实现细节名——后者只是它的数据来源（`engine_provider::protocol::bundled_catalog`）。
///
/// `catalog_get` / `catalog_refresh` 退役时未提供等价读面，而前端定价快照
/// （fetchCatalogSnapshot → applyCatalogCacheSnapshot）依赖内置目录的定价面
/// 数据——统一树只有用户自配定价，无法替代（实证 2026-09-15，见
/// docs/provider-single-track-convergence/00-执行记录.md）。本命令**纯只读**，
/// 不做任何写盘或状态变更。
#[tauri::command]
pub(crate) fn workbench_read_capability_dictionary() -> BundledCatalogSnapshot {
    let bundled = conex_run::engine_provider::protocol::bundled_catalog();
    BundledCatalogSnapshot {
        version: bundled.version(),
        entries: bundled.iter_entries().map(|(_, e)| e.clone()).collect(),
    }
}

#[tauri::command]
pub(crate) async fn workbench_save_models_yaml(
    app: tauri::AppHandle,
    content: String,
    expected_revision: String,
) -> Result<ModelsSnapshot, ModelsStoreError> {
    let mut snapshot =
        crate::config::blocking(move |store| store.save_yaml(&content, &expected_revision)).await?;
    crate::config::publish_snapshot(&app, &mut snapshot);
    Ok(snapshot)
}

#[tauri::command]
pub(crate) async fn workbench_apply_models_config(
    app: tauri::AppHandle,
    tree: UnifiedModelsConfig,
    expected_revision: String,
) -> Result<ModelsSnapshot, ModelsStoreError> {
    let mut snapshot =
        crate::config::blocking(move |store| store.apply(tree, &expected_revision)).await?;
    crate::config::publish_snapshot(&app, &mut snapshot);
    Ok(snapshot)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn empty_template_has_no_supplier_and_null_selection() {
        let tree =
            ModelsStore::validate_yaml(agent_provider::model_store::EMPTY_MODELS_YAML).unwrap();
        assert!(tree.providers.is_empty());
        assert!(tree.active_model.is_none());
    }

    #[test]
    fn validate_rejects_unknown_and_inline_credentials() {
        assert!(
            !workbench_validate_models_yaml("version: 2\nproviders: {}\nunknown: true".into())
                .valid
        );
        assert!(
            !workbench_validate_models_yaml("version: 2\nproviders:\n  a: {apiKey: secret}".into())
                .valid
        );
    }

    #[test]
    fn registered_models_commands_have_one_structured_commit() {
        let source = include_str!("main.rs");
        for command in [
            "workbench_read_models_yaml",
            "workbench_validate_models_yaml",
            "workbench_save_models_yaml",
            "workbench_apply_models_config",
        ] {
            assert!(source.contains(&format!("\"{command}\"")));
        }
        for command in ["catalog_get", "catalog_refresh", "config_profile_apply"] {
            assert!(!source.contains(&format!("(\"{command}\"")));
        }
    }
}
