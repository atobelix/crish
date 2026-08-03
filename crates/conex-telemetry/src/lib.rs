//! conex-telemetry: structured logging, panic hooks, and crash recovery.
//!
//! This crate is the Rust-side counterpart of the TS-side `@crish/telemetry`
//! package (Round 2 output). It provides:
//!
//! - [`init_default`]: idempotent tracing subscriber initialization with an
//!   `EnvFilter` level directive, compact formatting to stderr, and an optional
//!   daily log file layer (dual channel, PE-04 T04.1).
//! - [`install_panic_hook`] / [`install_panic_hook_with_crash_dir`]:
//!   idempotent `std::panic::set_hook` that emits structured `tracing::error!`
//!   records, falls back to stderr, writes a crash file (optional), and chains
//!   the previously installed hook so host runtimes (e.g. Tauri) keep their
//!   default panic behaviour.
//! - [`catch_unwind`]: wraps `std::panic::catch_unwind` and converts the panic
//!   payload into a structured [`conex_types::CrishErrorPayload`].
//!
//! Dependency direction: this crate is leaf-level. It depends only on
//! `conex-types` (for `CrishErrorPayload`) and the workspace tracing/serde
//! crates; it must not depend on any higher-level crate (no tauri, no
//! agent-workbench).

pub mod cache;
pub mod crash;
pub mod file;
pub mod format;
pub mod panic_hook;
pub mod subscriber;

pub use crash::catch_unwind;
pub use file::{cleanup_logs, FileConfig, LogRetention};
pub use panic_hook::{install_panic_hook, install_panic_hook_with_crash_dir};
pub use subscriber::{current_level, init_default};
