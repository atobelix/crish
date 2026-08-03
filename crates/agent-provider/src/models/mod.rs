//! models：厂商/模型层数据目录（P3 方案 §3.1）
//!
//! 模块布局（R3 轮任务归属）：
//! - [catalog]（catalog.rs）：模型目录结构 + 内置表 + 多级兜底查询（T-18，本任务已实现）
//! - behavior.rs：厂商缓存行为矩阵（T-19 追加）
//! - cache_key.rs：缓存键推导与会话亲和 header（T-20 追加）
//! - ttl.rs：TTL 路由表（T-21 追加）
//!
//! 依赖方向：catalog.rs 不依赖 request/parse 层；上层（P2 注入框架、P5 成本计算）
//! 只依赖本模块的公共 re-export，禁止各 provider 分支直接读 catalog.json 之外的散落判定。
//!
//! 本文件由 T-18（A1）独占；T-19/T-20/T-21 追加各自文件后，经轮末汇总物声明
//! 导出需求，由主 Agent 统一合并到本文件（避免三写冲突）。

mod behavior;
mod cache_key;
mod catalog;
mod ttl;

pub use behavior::{cache_behavior_for, infer_vendor, CacheBehavior, CacheTtl, VendorId};
pub use cache_key::{derive_prompt_cache_key, session_affinity_headers};
pub use catalog::{CatalogError, ModelCatalog, ModelCatalogEntry, ScannedCapabilities, ScannedModel};
pub use ttl::cache_ttl_for_provider_model;
