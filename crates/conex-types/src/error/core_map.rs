use super::{codes, CrishError};
use crate::CoreError;

// ── CoreError → 78 码显式映射（PE-03 T03.3 动作 1，AU-04 D8 边界）──
//
// IPC 面唯一协议为 CoreError `{kind, detail}`；web 网关 HTTP 层需要 78 码时，
// 一律经本函数显式映射（单一真源，禁止散落 map_err）。映射表见
// PE-03 §2.4.2（Q30：`From<CoreError> for CrishError` 类型删除归 PE-06 T06.5.4，
// 本函数只做显式映射，不落类型删除）。

/// 把 `CoreError` 映射为 78 码体系主码（PE-03 §2.4.2 映射表成文）。
///
/// | CoreError kind | 78 码主码 | 说明 |
/// |---|---|---|
/// | InvalidInput | common.invalid_input | 参数校验失败 |
/// | Encoding | common.encoding | 编解码失败 |
/// | Io | store.io | 存储/IO 失败（detail 携带操作名） |
/// | NotFound | common.not_found | 资源缺失 |
/// | Cancelled | runtime.aborted | 取消 |
/// | Internal | common.unknown | 兜底（detail 必填原始错误） |
pub fn core_error_code(err: &CoreError) -> &'static str {
    match err {
        CoreError::InvalidInput(_) => codes::COMMON_INVALID_INPUT,
        CoreError::Encoding(_) => codes::COMMON_ENCODING,
        CoreError::Io(_) => codes::STORE_IO,
        CoreError::NotFound(_) => codes::COMMON_NOT_FOUND,
        CoreError::Cancelled => codes::RUNTIME_ABORTED,
        CoreError::Internal(_) => codes::COMMON_UNKNOWN,
    }
}

// ── From 转换（共存阶段，禁令 23：CoreError 保留，添加无损映射）──
// 对齐 03-ERROR-MIGRATION.md §3.5 Rust CoreError → CrishErrorCode 映射表。

/// Q30 显式工厂：从 CoreError 显式构造 CrishError（AA-01 Q30 修复——
/// 删除 `From<CoreError> for CrishError` 的隐式兜底映射，改由调用方按
/// 码表选码）。
///
/// `invalid_input_code` 由调用方按上下文选择精确码（如 `tool.invalid_input`、
/// `session.invalid_session` 等），不再有语义存疑的 `InvalidInput →
/// common.unsupported` 猜测映射。
pub fn from_core_error_with_context(
    err: CoreError,
    invalid_input_code: &'static str,
) -> CrishError {
    // 主码一律经 core_error_code 单一真源（PE-03 §2.4.2 映射表，12-T-PD-07）：
    // 双入口（core_error_code / from_core_error_with_context）共用同一映射，
    // 禁止散落 map_err 猜测映射（AU-04 D8 边界）。
    //
    // 语义备案（32 文档 DD3-T7）：Encoding 从 store.corrupted 切至
    // common.encoding——未来调用方如需「编码损坏」语义须显式走
    // STORE_CORRUPTED；Io 从 store.write_failed 切至 store.io——无方向
    // 信息时主码兜底，方向性分流仍由 map_io_err 承担。码值均已注册，
    // conex-types 与 TS 共享码表无双端同步需求。
    let code = core_error_code(&err);
    match err {
        // Q30 契约：InvalidInput 由调用方按上下文选精确码（如
        // tool.invalid_input、session.invalid_session），不走主码兜底
        CoreError::InvalidInput(msg) => CrishError::new(invalid_input_code, msg),
        CoreError::Encoding(msg) => CrishError::new(code, msg),
        CoreError::Io(msg) => CrishError::new(code, msg),
        CoreError::NotFound(msg) => {
            // 主码 common.not_found（单一真源）+ legacyKind 标记保留：
            // 兼容旧 IPC 消费方按 kind 分支的路径
            CrishError::new(code, msg)
                .with_metadata(serde_json::json!({ "legacyKind": "NotFound" }))
        }
        CoreError::Cancelled => CrishError::new(code, "cancelled"),
        CoreError::Internal(msg) => CrishError::new(code, msg),
    }
}
