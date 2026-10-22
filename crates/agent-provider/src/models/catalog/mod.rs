//! 模型目录（Model Catalog）：内置静态表 + 多级兜底查询（P3 §3.1）
//!
//! - [ModelCatalogEntry]：一个 provider 通道下一个模型的完整元数据，字段集 = v2
//!   Schema 59 字段（docs/cache-optimization/10-model-catalog-v2/03-catalog-v2-schema.md）；
//!   全字段可缺省（struct 级 `#[serde(default)]`），缺字段条目可正常反序列化
//!   （对齐 A3 P2-10 裁决）；v1 旧 JSON（含 `maxInputTokens`/`longContext*` 遗留键）
//!   由 serde 忽略未知键兼容解析。
//! - [ModelCatalog]：内置表 + 版本号。[ModelCatalog::lookup] 按 litellm
//!   `_get_model_info_helper` 顺序多级兜底：精确 → 去版本后缀 → vendor 默认 → None；
//!   v2 四价查询（`input_price_for` / `cache_write_price_for` 等）按 schema 语义
//!   提供 None/0 显式语义。
//!
//! 本模块不依赖 request/parse 层；行为矩阵（T-19）、TTL 表（T-21）等上层只通过
//! [ModelCatalog] 查询接口消费，禁止散落硬编码判定。
//!
//! SR-06e · 拆分 · ≠ EL：门面模块。实现域拆分如下（测试旁挂 catalog_tests.rs）：
//! - [catalog_price]：长度分档/峰谷定价类型与纯函数（TieredPriceTier /
//!   PriceDerivation / PeakPricingSchedule + tier_for_tokens / peak_pricing_2x_at）
//! - [catalog_override]：扫描合并与覆盖变更面（ScannedCapabilities / ScannedModel /
//!   OVERRIDE_WHITELIST + upsert_from_scan / with_overrides）
//! - [entry]：模型目录条目与档位映射（ModelCatalogEntry / TierEffortMap）
//! - [store]：静态内置表加载、生命周期与变更管理（ModelCatalog / ModelCatalogFile / CatalogError）
//! - [queries]：模型能力矩阵与四价查询接口
//! - [live]：运行时 Unified 配置树快照与投影（LiveModels）

#[path = "../catalog_override.rs"]
mod catalog_override;
#[path = "../catalog_price.rs"]
mod catalog_price;

mod entry;
mod live;
mod queries;
mod store;

pub use catalog_override::{ScannedCapabilities, ScannedModel};
pub(crate) use catalog_price::{peak_pricing_2x_at, tier_for_tokens};
pub use catalog_price::{PeakPricingSchedule, PriceDerivation, TieredPriceTier};

pub use self::entry::ModelCatalogEntry;
pub use self::live::LiveModels;
pub use self::store::{CatalogError, ModelCatalog, ModelCatalogFile};

#[cfg(test)]
use super::catalog_types::{ModelRef, ModelSpec, ProviderSpec, UnifiedModelsConfig};
#[cfg(test)]
use std::collections::BTreeMap;

#[cfg(test)]
#[path = "../catalog_tests/mod.rs"]
mod tests;
