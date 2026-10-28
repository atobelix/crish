//! 统一错误协议（PE-03 T03.3）：Tauri 命令面的 `CoreError {kind, detail}` + 77 码映射。
//!
//! `CoreError` 权威定义在 `conex-types`（serde tagged enum：
//! `{"kind": "InvalidInput"|"Encoding"|"Io"|"NotFound"|"Cancelled"|"Internal", "detail": ...}`），
//! 本模块是命令面的唯一 import 点，只做三件事：
//! 1. 重导出 `CoreError`（禁止各命令文件散落 `use conex_types::CoreError`）；
//! 2. `map_store_err` / `map_run_err`：把存储层 / run 生命周期错误无损映射为 CoreError
//!    （detail 保留操作名 + 人读消息，77 码侧按 PE-03 §2.4.2 映射表成文）；
//! 3. 77 码显式映射经 `conex_types::error::core_error_code` 展开（G11a：本层
//!    重导出已删，需求方直引 `conex-types` 单一真源，避免双重门面）。
//!
//! 约定（PE-03 §2.4.2 映射表）：
//! | CoreError kind | 77 码主码 | 说明 |
//! |---|---|---|
//! | InvalidInput | common.invalid_input | 参数校验失败 |
//! | Encoding | common.encoding | 编解码失败 |
//! | Io | store.io | 存储/IO 失败（detail 携带操作名） |
//! | NotFound | common.not_found | 资源缺失 |
//! | Cancelled | runtime.aborted | 取消 |
//! | Internal | common.unknown | 兜底（detail 必填原始错误） |

// 注：CoreError 只经下方 `pub use` 重导出（`use` + `pub use` 同项双导入会
// 触发 E0252），命令面统一从本模块 import（PE-03 T03.3 约定）。

/// 命令面唯一错误类型（serde `{kind, detail}` 协议，`conex-types` 权威定义）。
pub use conex_types::CoreError;

/// 内部 String 错误 → `CoreError::Internal` 兜底（历史 String 契约在命令
/// 边界的统一收口：宿主环境/内部辅助错误无更细 kind 可分时使用）。
pub fn map_internal_string(err: String) -> CoreError {
    CoreError::Internal(err)
}

/// 把 `orchestrator::persist::StoreError` 映射为 CoreError。
///
/// - kind 语义 = 存储操作名（append_event / query_events / lock ...），随 detail 保留
///   （`store.{kind}: {message}`），77 码映射时 Io → store.io；
/// - cause（DbFailure 链）不丢失：message 已含底层文案，需要时可用
///   `StoreError::to_crish()` 取完整 77 码 cause 链。
pub fn map_store_err(err: orchestrator::persist::StoreError) -> CoreError {
    CoreError::Io(format!("store.{}: {}", err.kind, err.message))
}

/// 把 `orchestrator::run::RunError` 映射为 CoreError。
///
/// - 状态机拒绝转移 / 终态不可变 → `InvalidInput`（调用方参数或时机问题，
///   前端可按 error.kind 分类处理，不复试也无需重启）；
/// - 存储层失败 → `Io`（委托 `map_store_err`，detail 保留操作名）。
pub fn map_run_err(err: orchestrator::run::RunError) -> CoreError {
    use orchestrator::run::RunError;
    match err {
        RunError::Transition(e) => CoreError::InvalidInput(format!("run 状态机拒绝转移：{e}")),
        RunError::TerminalImmutable => {
            CoreError::InvalidInput("run 已到终态，拒绝再转移".to_string())
        }
        RunError::Store(e) => map_store_err(e),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use conex_types::error::{codes, core_error_code};
    use orchestrator::persist::StoreError;

    #[test]
    fn map_store_err_preserves_kind_and_message() {
        let err = StoreError::new("append_event", "disk is read-only");
        match map_store_err(err) {
            CoreError::Io(detail) => {
                assert!(detail.contains("store.append_event"), "detail: {detail}");
                assert!(detail.contains("disk is read-only"), "detail: {detail}");
            }
            other => panic!("expected Io, got {other:?}"),
        }
    }

    #[test]
    fn map_store_err_with_cause_keeps_detail() {
        let err = StoreError::new("query_events", "db locked");
        let mapped = map_store_err(err);
        assert!(matches!(mapped, CoreError::Io(_)));
        // 77 码映射：Io → store.io（与 conex-types 映射表一致）
        assert_eq!(core_error_code(&mapped), codes::STORE_IO);
    }

    #[test]
    fn map_run_err_transition_is_invalid_input() {
        let err = orchestrator::run::RunError::TerminalImmutable;
        match map_run_err(err) {
            CoreError::InvalidInput(detail) => {
                assert!(detail.contains("终态"), "detail: {detail}");
            }
            other => panic!("expected InvalidInput, got {other:?}"),
        }
    }

    #[test]
    fn map_run_err_store_delegates_to_io() {
        let err =
            orchestrator::run::RunError::Store(StoreError::new("update_run_status", "run 不存在"));
        match map_run_err(err) {
            CoreError::Io(detail) => {
                assert!(
                    detail.contains("store.update_run_status"),
                    "detail: {detail}"
                );
            }
            other => panic!("expected Io, got {other:?}"),
        }
    }

    #[test]
    fn core_error_serializes_as_kind_detail_protocol() {
        let err = CoreError::InvalidInput("bad id".to_string());
        let json = serde_json::to_value(&err).unwrap();
        assert_eq!(json["kind"], "InvalidInput");
        assert_eq!(json["detail"], "bad id");
    }

    #[test]
    fn core_error_code_maps_all_kinds() {
        assert_eq!(
            core_error_code(&CoreError::InvalidInput("x".into())),
            codes::COMMON_INVALID_INPUT
        );
        assert_eq!(
            core_error_code(&CoreError::Encoding("x".into())),
            codes::COMMON_ENCODING
        );
        assert_eq!(core_error_code(&CoreError::Io("x".into())), codes::STORE_IO);
        assert_eq!(
            core_error_code(&CoreError::NotFound("x".into())),
            codes::COMMON_NOT_FOUND
        );
        assert_eq!(
            core_error_code(&CoreError::Cancelled),
            codes::RUNTIME_ABORTED
        );
        assert_eq!(
            core_error_code(&CoreError::Internal("x".into())),
            codes::COMMON_UNKNOWN
        );
    }
}
