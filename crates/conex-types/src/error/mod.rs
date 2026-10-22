//! CrishError 错误系统（TS 端 shared-types/src/errors 同构）
//!
//! 权威定义：
//! - analysis/iterative-repair/v2/ROUND-10-rust.md §3
//! - packages/shared-types/src/errors/{codes,info,classes,serialize}.ts
//! - 03-ERROR-MIGRATION.md §2.2（码表）/ §6（IPC 序列化）
//!
//! 设计要点：
//! - CrishError 用 struct 而非 enum（102 码跨 20 域，enum 不可维护）
//! - 错误码通过 codes 模块常量 + CRISH_ERROR_REGISTRY 静态注册表表达
//! - CrishErrorPayload 是 IPC 序列化类型，字段与 TS 端 CrishErrorPayload 一一对应
//! - cause 链递归深度上限 8（CRISH_ERROR_CAUSE_MAX_DEPTH）

use serde::{Deserialize, Serialize};
use std::time::{SystemTime, UNIX_EPOCH};

mod core_map;
mod crish_error;
mod migrate;
mod provider_kind;
mod registry;
mod run_terminal;

pub use core_map::{core_error_code, from_core_error_with_context};
pub use crish_error::{CrishError, CrishErrorPayload};
pub use migrate::{migrate_error_code, MigrateErrorContext};
pub use provider_kind::ProviderErrorKind;
pub use run_terminal::{RunTerminal, RunTerminalError};

use registry::CRISH_ERROR_REGISTRY;

/// cause 链递归深度上限（TS 端 CRISH_ERROR_CAUSE_MAX_DEPTH = 8 同值）
pub const CRISH_ERROR_CAUSE_MAX_DEPTH: u8 = 8;

/// 故障类别（TS 端 CrishErrorCategory 同构，serde lowercase）
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum CrishErrorCategory {
    /// 可重试错误（网络、限流）
    Transient,
    /// 不可重试错误（非法输入、未找到）
    Permanent,
    /// 权限/鉴权错误
    Security,
    /// IPC/协议违规
    Protocol,
}

/// 错误码元信息（TS 端 CrishErrorInfo 同构）
#[derive(Debug, Clone, PartialEq)]
pub struct CrishErrorInfo {
    pub code: &'static str,
    pub title: &'static str,
    pub category: CrishErrorCategory,
    pub retryable: bool,
    pub is_public: bool,
    pub action: &'static str,
}

/// 错误码常量集（TS 端 CrishErrorCode 同构，102 码 / 20 域）
///
/// 来源：packages/shared-types/src/errors/codes.ts
/// 权威：03-ERROR-MIGRATION.md §2.2
pub mod codes;

/// 查询错误码元信息，未知码回退到 common.unknown（TS 端 getErrorInfo 同构）
pub fn info(code: &str) -> CrishErrorInfo {
    CRISH_ERROR_REGISTRY
        .get(code)
        .cloned()
        .unwrap_or(CrishErrorInfo {
            code: codes::COMMON_UNKNOWN,
            title: "未知错误",
            category: CrishErrorCategory::Permanent,
            retryable: false,
            is_public: true,
            action: "action.common.report_bug",
        })
}

fn now_millis() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

// ===== Tests =====

#[cfg(test)]
mod tests;
