//! **W4-C** Strict 方向：扩展宿主 contribute points · View 轨 + 拒写句柄
//!
//! # 轨与包标识
//! - 包 ID：**W4-C**（Strict 方向子集；**不是** W6-E-S）
//! - 文件域：`crates/agent-tools/**` 扩展/contribute 相关
//! - TS 对齐：`packages/plugin-sdk/src/contribute/**`（View 轨 / FORBIDDEN_WRITE_KEYS）
//!
//! # 本包交付（产品向可点名路径）
//! 1. **View 轨注册表** [`ContributeViewRegistry`]：`register` / `list` / `unregister`
//! 2. **拒写句柄**：载荷夹带 `store` / `applyOp` / `sqlite` 等 →
//!    [`ContributeRegisterError::ForbiddenWriteHandle`]，**不**入表
//! 3. **投影-only**：`list()` 仅 [`ViewDescriptor`] 可序列化 UI 元数据；
//!    **永不**暴露写 store / applyOp
//! 4. **旁路写禁令**：[`try_mutate_via_contribute`] 恒拒写，权威树不变
//!
//! # 诚实边界（强制 · 禁止假关）
//! - **≠ EL-07** 满关（须 W4-C + **W6-E** + A-EXT 全表 + A-INV-01；见 `08` / EL-dashboard）
//! - **≠ A-EXT-01…06 全表**（本包仅 A-EXT-05 局部：View 无 applyOp / 拒写句柄方向）
//! - **≠** registerFlavour F1 后半–F3 / TrustGate 打包 / 恶意扩展零持久化端到端
//! - Memory 测绿 **禁关**生产 A-AGT / EL-05 / EL-07
//! - **不回退** W4-B 审批矩阵、W4-F batch token / move、W6-E-S 骨架
//!
//! # 与 plans
//! - `plans/06` §5：contribute 写句柄拒绝 = A-EXT-05 局部；**≠** EL-07 全关
//! - `plans/09` W4-C：投影-only；拒写句柄；A-EXT 方向
//! - `EL-dashboard` EL-07：禁止冒充「仅 contribute 拒写句柄」
//!
//! # 分模
//! - [`schema`]：View 轨类型 / 错误码 / 包锚常量
//! - [`validate`]：权限 / 载荷 / 拒写句柄校验
//! - [`execute`]：注册表 + 旁路写禁令 + 宿主复用入口
//! - `tests`（cfg）：W4-C / contribute 相关测（外置，主实现显著下降）

pub mod schema;
pub mod validate;
pub mod execute;

#[cfg(test)]
mod tests;

// ── 包锚（facade 稳定面）────────────────────────────────────────────

/// **W4-C** Strict 方向包标识（测 / 文档 / 调度对账）
pub const W4C_PACKAGE_ID: &str = "W4-C";

/// 稳定拒写码：contribute 载荷夹带写句柄（View 轨 · 投影-only）
pub const CONTRIBUTE_FORBIDDEN_WRITE: &str = "note.contribute_forbidden_write_handle";

/// 稳定拒写码：试图经 contribute / View 轨 mutate 权威树（旁路禁令）
pub const CONTRIBUTE_MUTATE_DENIED: &str = "note.contribute_mutate_denied";

/// 注册 contribute 的硬性权限（对齐 plugin-sdk `REQUIRED_CONTRIBUTE_PERMISSION`）
pub const REQUIRED_CONTRIBUTE_PERMISSION: &str = "ui:contribute";

/// 文档/测用：本包 **不** 关闭的项（假关检查清单）
///
/// 诚实：**≠ EL-07** 满关；拒写方向不回退。
pub const W4C_NOT_CLOSING: &[&str] = &[
    "EL-07",
    "A-EXT-01…06 全表",
    "TrustGate F3 打包",
    "registerFlavour F1 后半–F3",
    "恶意扩展零持久化端到端（W6-E）",
];

// ── 公开 API 扁平 re-export（保持 lib.rs / 外部路径不 break）────────

pub use schema::{
    ContributeKind, ContributeRegisterError, ContributeRegisterOk, ContributeRegistration,
    ViewDescriptor, CONTRIBUTE_KINDS,
};
pub use execute::{
    contribute_err_to_backend_err, contribute_payload_has_write_handle, make_registration_key,
    try_mutate_via_contribute, ContributeViewRegistry,
};
