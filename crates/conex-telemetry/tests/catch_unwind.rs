//! Integration tests for `conex_telemetry::catch_unwind`.
//!
//! These tests depend on `conex_types::CrishErrorPayload` being available
//! (Agent 10-A's `crates/conex-types/src/error.rs`). They compile once that
//! module lands; until then the failure is expected, as noted in
//! `src/crash.rs`.

use conex_telemetry::catch_unwind;

#[test]
fn catch_unwind_returns_ok_on_success() {
    let result = catch_unwind(|| 42);
    assert!(result.is_ok(), "expected Ok for non-panicking closure");
    assert_eq!(result.unwrap(), 42);
}

#[test]
fn catch_unwind_preserves_panic_message() {
    let result: Result<(), _> = catch_unwind(|| {
        panic!("custom panic message");
    });
    let payload = result.expect_err("expected the closure to panic");

    assert!(
        payload.message.contains("custom panic message"),
        "payload message did not contain the panic text; got: {}",
        payload.message
    );
    assert_eq!(payload.code, "common.panic");
    assert!(!payload.retryable, "panic must be non-retryable");
}
