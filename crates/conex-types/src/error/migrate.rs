use super::codes;

// ── 旧错误码迁移（对齐 TS migrateErrorCode，normalize.ts 全表 + 附录 B）──

/// 旧码迁移上下文（对齐 normalize.ts 的 context 参数）
#[derive(Debug, Clone, Copy, Default)]
pub struct MigrateErrorContext<'a> {
    /// TOOL_ERROR / ARTIFACT_ERROR / ADAPTER_ERROR 的拆分方向
    pub kind: Option<&'a str>,
    /// CLIENT_INVALID_INPUT 的 context_length_exceeded 判定
    pub sub_type: Option<&'a str>,
}

/// 旧错误码 → 新 CrishErrorCode 映射
///
/// 覆盖 SessionErrorCode、ProviderErrorKind、自由字符串码
/// （含 NO_PROVIDER→config.missing、RUN_ERROR→runtime.unexpected_state）、
/// TOOL_ERROR 拆分、ErrorDomain 枚举。未知名回退 common.unknown。
pub fn migrate_error_code(legacy_code: &str, context: MigrateErrorContext) -> &'static str {
    // ── SessionErrorCode（normalize.ts §3.1）──
    match legacy_code {
        "not_found" => return codes::SESSION_NOT_FOUND,
        "invalid_session" => return codes::SESSION_INVALID_SESSION,
        "invalid_entry" => return codes::SESSION_INVALID_ENTRY,
        "invalid_state" => return codes::SESSION_INVALID_STATE,
        "storage" => return codes::SESSION_STORAGE_FAILED,
        _ => {}
    }
    // ── ProviderErrorKind（normalize.ts §3.3）──
    match legacy_code {
        "network" => return codes::PROVIDER_NETWORK,
        "gateway-challenge" => return codes::PROVIDER_GATEWAY_CHALLENGE,
        "rate-limit" => return codes::PROVIDER_RATE_LIMIT,
        "auth" => return codes::PROVIDER_AUTH,
        "quota" => return codes::PROVIDER_QUOTA,
        "endpoint-unavailable" => return codes::PROVIDER_ENDPOINT_UNAVAILABLE,
        "schema" => return codes::PROVIDER_SCHEMA,
        "server" => return codes::PROVIDER_SERVER,
        "timeout" => return codes::PROVIDER_TIMEOUT,
        "cancelled" => return codes::PROVIDER_CANCELLED,
        "invalid-stream" => return codes::PROVIDER_STREAM_INTERRUPTED,
        "unknown" => return codes::PROVIDER_UNKNOWN,
        _ => {}
    }
    // ── 自由字符串码（normalize.ts §3.4 + 附录 B）──
    match legacy_code {
        "NO_PROVIDER" => return codes::CONFIG_MISSING,
        "RUN_ERROR" => return codes::RUNTIME_UNEXPECTED_STATE,
        "CONFIG_ERROR" => return codes::CONFIG_INVALID,
        "CHECKPOINT_ERROR" | "BOUNDARY_ERROR" | "SCOPED_CONTEXT_ERROR" => {
            return codes::STORE_CORRUPTED;
        }
        "ARTIFACT_ERROR" => {
            return if context.kind == Some("not_found") {
                codes::ARTIFACT_NOT_FOUND
            } else {
                codes::ARTIFACT_INVALID_URI
            };
        }
        "ADAPTER_ERROR" => {
            return if context.kind == Some("not_found") {
                codes::ARTIFACT_NOT_FOUND
            } else {
                codes::STORE_CORRUPTED
            };
        }
        "DAEMON_DEAD" | "DAEMON_ERROR" => return codes::NETWORK_DAEMON_DEAD,
        "NETWORK_ERROR" => return codes::PROVIDER_NETWORK,
        "INVALID_RUN_STATE" => return codes::RUN_INVALID_STATE,
        "NOT_A_GOAL_RUN" => return codes::RUN_NOT_GOAL_RUN,
        _ => {}
    }
    // ── TOOL_ERROR 按 context.kind 拆分（49 处 → 4 码）──
    if legacy_code == "TOOL_ERROR" {
        return match context.kind {
            Some("path") => codes::TOOL_PATH_ESCAPE,
            Some("input") => codes::TOOL_INVALID_INPUT,
            Some("not_found") => codes::TOOL_NOT_FOUND,
            _ => codes::TOOL_EXECUTION_FAILED,
        };
    }
    // ── ErrorDomain 枚举值（normalize.ts §3.2）──
    match legacy_code {
        "USER_ABORT" => codes::RUNTIME_ABORTED,
        "TRANSIENT_NETWORK" => codes::PROVIDER_NETWORK,
        "TRANSIENT_SERVER" => codes::PROVIDER_SERVER,
        "RATE_LIMIT" => codes::PROVIDER_RATE_LIMIT,
        "CLIENT_AUTH" => codes::PROVIDER_AUTH,
        "CLIENT_INVALID_INPUT" => {
            if context.sub_type == Some("context_length_exceeded") {
                codes::CONTEXT_LENGTH_EXCEEDED
            } else {
                codes::PROVIDER_SCHEMA
            }
        }
        "QUOTA_EXHAUSTED" => codes::PROVIDER_QUOTA,
        "STREAM_INTERRUPT" => codes::PROVIDER_STREAM_INTERRUPTED,
        "ENDPOINT_UNAVAILABLE" => codes::PROVIDER_ENDPOINT_UNAVAILABLE,
        "GATEWAY_CHALLENGE" => codes::PROVIDER_GATEWAY_CHALLENGE,
        "UNKNOWN" => codes::COMMON_UNKNOWN,
        _ => codes::COMMON_UNKNOWN,
    }
}
