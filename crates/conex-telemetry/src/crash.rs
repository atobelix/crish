//! Crash recovery: convert panics into structured `CrishErrorPayload`s.
//!
//! [`catch_unwind`] wraps [`std::panic::catch_unwind`] so that Tauri commands
//! and other entry points can turn a panic into a structured error payload
//! (code `common.panic`, category `Permanent`, non-retryable) instead of
//! letting the process unwind uncontrolled.
//!
//! # Dependency on Agent 10-A
//!
//! This module imports [`conex_types::error::CrishErrorPayload`] and
//! [`conex_types::error::CrishErrorCategory`], which are introduced by Agent 10-A in
//! `crates/conex-types/src/error.rs` (see `ROUND-10-rust.md` §3.2). Until that
//! module lands, `cargo check -p conex-telemetry` will fail on these imports
//! by design. The field layout used below matches the §3.2 contract:
//!
//! ```ignore
//! pub struct CrishErrorPayload {
//!     pub code: String,
//!     pub message: String,
//!     pub category: CrishErrorCategory,
//!     pub retryable: bool,
//!     pub is_public: bool,            // serde rename "public"
//!     pub action: String,
//!     pub metadata: Option<serde_json::Value>,
//!     pub cause: Option<Box<CrishErrorPayload>>,
//!     pub stack: Option<String>,
//!     pub timestamp: i64,
//! }
//! ```

use std::panic::{self, UnwindSafe};

use conex_shared::time::{Clock, SystemClock};
use conex_types::error::{
    codes, error_info, CrishErrorCategory, CrishErrorInfo, CrishErrorPayload,
};

/// Wrap `f` so that a panic inside it becomes a structured error payload.
///
/// `f` must be [`UnwindSafe`] (same requirement as [`std::panic::catch_unwind`]).
/// Callers with closures that do not satisfy `UnwindSafe` should wrap them in
/// [`std::panic::AssertUnwindSafe`] at the call site; this function does not
/// impose `AssertUnwindSafe` internally so that unwind-safety obligations stay
/// visible to the caller.
///
/// On `Ok`, the closure's return value is passed through. On panic, the panic
/// payload is extracted (supporting `&'static str` and `String`, the types
/// produced by `panic!`), wrapped in a `CrishErrorPayload` with
/// `code = "common.panic"`, `category = Permanent`, `retryable = false`, and
/// the originating thread name recorded in `metadata`.
//
// 豁免说明（clippy::result_large_err）：
// `CrishErrorPayload` 是命令层全域错误契约类型（conex-types::error），
// 在本函数与命令层返回处保持同一非 box 形态，避免公共 API 分裂；
// 且 panic 路径非常热路径，152 字节栈上返回无实际开销。
// 若后续全域改用 Box<CrishErrorPayload>，本豁免应随之取消。
#[allow(clippy::result_large_err)]
pub fn catch_unwind<F, R>(f: F) -> Result<R, CrishErrorPayload>
where
    F: FnOnce() -> R + UnwindSafe,
{
    match panic::catch_unwind(f) {
        Ok(value) => Ok(value),
        Err(payload) => Err(payload_to_panic_error(&payload)),
    }
}

/// Build a `CrishErrorPayload` from a caught panic payload.
fn payload_to_panic_error(payload: &Box<dyn std::any::Any + Send>) -> CrishErrorPayload {
    let message = extract_panic_message(payload);
    let thread = std::thread::current()
        .name()
        .map(str::to_string)
        .unwrap_or_else(|| "<unnamed>".to_string());

    let fallback = CrishErrorInfo {
        code: codes::COMMON_PANIC,
        title: "内部异常",
        category: CrishErrorCategory::Permanent,
        retryable: false,
        is_public: false,
        action: "action.common.report_bug",
    };
    let info = error_info(codes::COMMON_PANIC).unwrap_or(&fallback);
    CrishErrorPayload {
        code: info.code.to_string(),
        message: format!("panic: {}", message),
        category: info.category,
        retryable: info.retryable,
        is_public: info.is_public,
        action: info.action.to_string(),
        params: None,
        metadata: Some(serde_json::json!({ "thread": thread })),
        cause: None,
        stack: None,
        timestamp: SystemClock.now_ms(),
    }
}

/// Downcast a panic payload to a readable string.
///
/// `std::panic::catch_unwind` returns `Box<dyn Any + Send>`. The two concrete
/// types produced by `panic!` are `&'static str` (string-literal argument) and
/// `String` (formatted argument). Anything else degrades to a placeholder.
fn extract_panic_message(payload: &Box<dyn std::any::Any + Send>) -> String {
    if let Some(s) = payload.downcast_ref::<&'static str>() {
        return (*s).to_string();
    }
    if let Some(s) = payload.downcast_ref::<String>() {
        return s.clone();
    }
    "<unknown panic payload>".to_string()
}
