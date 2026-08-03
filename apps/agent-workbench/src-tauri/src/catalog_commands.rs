//! 模型目录命令（P3 步骤 5：catalog_get / catalog_refresh）—— T-24。
//!
//! - `catalog_get`：返回当前模型目录快照（版本号 + 全量条目，serde camelCase wire）；
//! - `catalog_refresh`：接收前端 `scanProviderModels` 上送结果（provider + 扫描模型
//!   列表），经 [ModelCatalog::upsert_from_scan] 合并（仅窗口 / 输出上限 / 能力位，
//!   **不覆盖价格**），返回合并后快照。
//!
//! 状态：`Arc<RwLock<ModelCatalog>>`（main.rs setup 以 `ModelCatalog::bundled()`
//! 初始化 manage），与 `SharedDb` / `StatusDiagnostics` 同模式；变更仅经命令入口
//! 进行，版本号作为下游 memoize 失效键（对齐 litellm `_model_cost_mutation_generation`）。

use std::sync::{Arc, RwLock};

use agent_provider::models::{ModelCatalog, ModelCatalogEntry, ScannedModel};
use serde::Serialize;
use tauri::State;

use crate::core_error::CoreError;

/// 目录快照（catalog_get / catalog_refresh 返回体，serde camelCase）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CatalogSnapshot {
    /// 变更版本号（任何合并 +1；下游 memoize 失效键）
    pub version: u64,
    /// 全量条目（按 vendor::model 字典序）
    pub entries: Vec<ModelCatalogEntry>,
}

/// 组装快照（纯数据，与 Tauri 解耦，可单测）。
fn snapshot(catalog: &ModelCatalog) -> CatalogSnapshot {
    CatalogSnapshot {
        version: catalog.version(),
        entries: catalog.entries_snapshot(),
    }
}

/// catalog_get：返回当前模型目录快照（版本号 + 全量条目）。
///
/// 消费面（P5 成本计算 / 前端展示）：先比对 version 决定是否失效 memoize，
/// 再按 vendor/model 查条目字段。
#[tauri::command]
pub fn catalog_get(
    catalog: State<'_, Arc<RwLock<ModelCatalog>>>,
) -> Result<CatalogSnapshot, CoreError> {
    let catalog = catalog
        .read()
        .map_err(|poisoned| CoreError::Internal(format!("catalog 读锁中毒：{poisoned}")))?;
    Ok(snapshot(&catalog))
}

/// catalog_refresh：前端扫描结果上送合并（T-25 消费面）。
///
/// 入参：`provider`（通道 / profile 标识）+ `scan`（扫描模型列表，见
/// [ScannedModel]）。合并语义见 [ModelCatalog::upsert_from_scan]：仅窗口 /
/// 输出上限 / 能力位，**不覆盖价格**；至少一项变更版本号 +1。
#[tauri::command]
pub fn catalog_refresh(
    provider: String,
    scan: Vec<ScannedModel>,
    catalog: State<'_, Arc<RwLock<ModelCatalog>>>,
) -> Result<CatalogSnapshot, CoreError> {
    if provider.trim().is_empty() {
        return Err(CoreError::invalid_input("provider must not be empty"));
    }
    let mut catalog = catalog
        .write()
        .map_err(|poisoned| CoreError::Internal(format!("catalog 写锁中毒：{poisoned}")))?;
    catalog.upsert_from_scan(&provider, &scan);
    Ok(snapshot(&catalog))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 快照组装：版本号 + 全量条目（含内置价格真源字段）
    #[test]
    fn snapshot_carries_version_and_bundled_entries() {
        let catalog = ModelCatalog::bundled();
        let snap = snapshot(&catalog);
        assert_eq!(snap.version, 0);
        assert!(snap.entries.len() >= 27, "内置条目 = {}", snap.entries.len());
        let flash = snap
            .entries
            .iter()
            .find(|e| e.model == "deepseek-v4-flash")
            .expect("内置 deepseek-v4-flash 必须存在");
        assert_eq!(flash.input_price, Some(0.14));
        assert!(flash.supports_prompt_caching);
    }

    /// 合并后快照版本号反映变更（upsert_from_scan 路径经命令入口暴露）
    #[test]
    fn snapshot_reflects_scan_merge_version() {
        let mut catalog = ModelCatalog::bundled();
        let scan = vec![ScannedModel {
            model: "gateway-7b".to_string(),
            vendor: None,
            context_window: Some(32_000),
            max_output_tokens: None,
            capabilities: None,
        }];
        let version = catalog.upsert_from_scan("my-gateway", &scan);
        let snap = snapshot(&catalog);
        assert_eq!(snap.version, version);
        assert!(snap.entries.iter().any(|e| e.model == "gateway-7b"));
    }
}
