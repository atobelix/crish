//! models/catalog.rs 测试旁挂（SR-06e · 拆分 · ≠ EL；经 #[path] 接线，非直接 mod）
//!
//! 原 catalog.rs `mod tests` 整段搬入，零删除零合并；测试名与断言形状不变。
//!
//! 按被测功能拆分为子模块（逐字平移，零删改）：
//! - [lookup]：内置表解析 / lookup / find_model / 便捷查询
//! - [overrides_upsert]：T-24 覆盖白名单（with_overrides）与扫描合并（upsert_from_scan）
//! - [replace_models]：T1.5 / G3-d models 整体替换与全量快照
//! - [v2_serde_pricing]：v2 Schema serde 往返 / v1 兼容 / 四价查询 / tieredPricing 分档
//! - [peak_tiers]：peakPricing 峰谷消费 / 日期解析 / T1.1 档位映射载体
//! - [yaml_live]：空目录 / YAML 投影 / live models

use super::catalog_price::{beijing_minutes_of, parse_date_utc_epoch, window_contains};
use super::*;

mod lookup;
mod overrides_upsert;
mod peak_tiers;
mod replace_models;
mod v2_serde_pricing;
mod yaml_live;
