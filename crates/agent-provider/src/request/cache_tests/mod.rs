//! request/cache.rs 测试旁挂（SR-06e · 拆分 · ≠ EL；经 #[path] 接线，非直接 mod）
//!
//! 原 cache.rs `mod tests` 整段搬入，零删除零合并；测试名与断言形状不变。
//!
//! 按被测功能拆分为子模块（逐字平移；单节专用 helper 随所在节搬迁）：
//! - [keys_breakpoints]：CacheRetention / CacheKey / CacheControl / 断点预算 / 亲和头 / 能力表
//! - [build_policy]：build_cache_policy / prompt_cache_mode
//! - [apply_controls]：apply_cache_controls / text_to_parts_with_cc

use super::cache_policy::allocate_breakpoints_with_cap;
use super::*;
use crate::models::{cache_behavior_for, ModelCatalog, ModelCatalogEntry, VendorId};

mod apply_controls;
mod build_policy;
mod keys_breakpoints;
