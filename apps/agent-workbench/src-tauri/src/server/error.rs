//! 服务错误类型（D2 §8.1.2：错误协议复用 CoreError {kind, detail} →
//! 跨端 DeviceErrorCode 映射 + HTTP 状态）
//!
//! 映射规则（D2 §8.1 原则 2）：
//! - 配对域 pair.* → 403（带细分 kind）；
//! - 认证域 auth.* → 401；
//! - cmd.invalid → 400；cmd.not_found → 404；restore/engine 未就绪 → 409；
//! - cmd.too_many_requests → 429；其余 → 500（internal）。

use axum::{
    http::StatusCode,
    response::{IntoResponse, Response},
    Json,
};

use conex_types::device::{DeviceErrorCode, ErrorBody};

/// 服务错误（内部统一错误类型；HTTP 侧经 [ServerError::http_status] 与
/// [ServerError::error_body] 出网）
// R1-02 备注：Config / Protocol 变体与映射面由 R1-03/04 handler 消费
// （骨架期仅 Io 在线）——dead_code 静音（测试构建保持检查）
#[cfg_attr(not(test), allow(dead_code))]
#[derive(Debug, Clone, thiserror::Error)]
pub enum ServerError {
    /// IO / 系统层错误（映射 internal）
    #[error("服务 IO 错误：{0}")]
    Io(String),
    /// 配置 / 装配错误（映射 internal）
    #[error("配置错误：{0}")]
    Config(String),
    /// 协议错误（携带跨端错误码；映射按码域）
    #[error("{code:?}：{message}")]
    Protocol {
        /// 跨端错误码（wire `<域>.<子类>`）
        code: DeviceErrorCode,
        /// 人读信息（≤512 字符）
        message: String,
    },
}

impl ServerError {
    /// IO 错误（映射 internal）
    pub fn io(message: impl Into<String>) -> Self {
        Self::Io(message.into())
    }

    /// 配置错误（映射 internal）
    // R1-02 备注：R1-07 server.json 装配消费——dead_code 静音
    #[cfg_attr(not(test), allow(dead_code))]
    pub fn config(message: impl Into<String>) -> Self {
        Self::Config(message.into())
    }

    /// 未分类内部错误（internal 码）
    // R1-02 备注：R1-03/04 handler 消费——dead_code 静音
    #[cfg_attr(not(test), allow(dead_code))]
    pub fn internal(message: impl Into<String>) -> Self {
        Self::Protocol {
            code: DeviceErrorCode::Internal,
            message: message.into(),
        }
    }

    /// 协议错误（显式跨端码）
    // R1-02 备注：R1-03/04 handler 消费——dead_code 静音
    #[cfg_attr(not(test), allow(dead_code))]
    pub fn protocol(code: DeviceErrorCode, message: impl Into<String>) -> Self {
        Self::Protocol {
            code,
            message: message.into(),
        }
    }

    /// CoreError（桌面命令面错误协议）→ 服务错误
    ///
    /// 映射复用 conex-types `DeviceErrorCode::from_core_error` 单一真源
    /// （M6 §6.2.3：InvalidInput/NotFound/Cancelled/Encoding/Io/Internal
    /// 六 kind 细分；77 码不透传）
    // R1-02 备注：R1-03 CoreStateBackend 消费——dead_code 静音
    #[cfg_attr(not(test), allow(dead_code))]
    pub fn from_core_error(err: &conex_types::CoreError) -> Self {
        Self::Protocol {
            code: DeviceErrorCode::from_core_error(err),
            message: err.to_string(),
        }
    }

    /// 错误码（Protocol 自身码；其余统一 internal）
    // R1-02 备注：R1-03 handler 消费——dead_code 静音
    #[cfg_attr(not(test), allow(dead_code))]
    pub fn device_code(&self) -> DeviceErrorCode {
        match self {
            ServerError::Protocol { code, .. } => code.clone(),
            ServerError::Io(_) | ServerError::Config(_) => DeviceErrorCode::Internal,
        }
    }

    /// HTTP 状态码映射（D2 §8.1.2：InvalidInput→400 / NotFound→404 /
    /// RestorePending→409 / auth 失败→401 / 配对失败→403）
    // R1-02 备注：R1-03 handler 消费——dead_code 静音
    #[cfg_attr(not(test), allow(dead_code))]
    pub fn http_status(&self) -> u16 {
        match self {
            ServerError::Io(_) | ServerError::Config(_) => 500,
            ServerError::Protocol { code, .. } => match code {
                DeviceErrorCode::PairInvalidCode
                | DeviceErrorCode::PairExpired
                | DeviceErrorCode::PairUsed
                | DeviceErrorCode::PairTooManyAttempts
                | DeviceErrorCode::PairChallengeMismatch
                | DeviceErrorCode::PairNoChallenge
                | DeviceErrorCode::PairRegistryFull => 403,
                DeviceErrorCode::AuthBadSignature
                | DeviceErrorCode::AuthDeviceRevoked
                | DeviceErrorCode::AuthUnknownDevice
                | DeviceErrorCode::AuthUnknownDesktop
                | DeviceErrorCode::AuthExpired
                | DeviceErrorCode::AuthStale
                | DeviceErrorCode::AuthRotateConflict => 401,
                DeviceErrorCode::CmdInvalid => 400,
                // 白名单/门禁拒绝（R1-11 G-5 / D5 §4.5「403 cmd.denied」语义）
                DeviceErrorCode::CmdDenied => 403,
                DeviceErrorCode::CmdNotFound => 404,
                // 审批冲突（F2 §11.2：重复决策 / 已被其他设备处理 / 已过期）
                // → 409（与 session busy / engine 未就绪同档：请求方需收敛
                // 状态而非重试同一请求）
                DeviceErrorCode::CmdApprovalMismatch => 409,
                DeviceErrorCode::CmdRestoreInProgress
                | DeviceErrorCode::CmdEngineNotReady
                | DeviceErrorCode::CmdSessionBusy => 409,
                DeviceErrorCode::CmdTooManyRequests => 429,
                // R2-12c C22：命令未注册/未实现 → 501（资源代理占位端点
                // 语义；M6 C27「v1 返回 cmd.unknown」的 HTTP 形态——
                // 端点已登记但实现未接线，诚实降级而非 500）
                DeviceErrorCode::CmdUnknown => 501,
                _ => 500,
            },
        }
    }

    /// 出网错误载荷（ErrorBody；retryable 由错误码静态表推导）
    // R1-02 备注：R1-03 handler 消费——dead_code 静音
    #[cfg_attr(not(test), allow(dead_code))]
    pub fn error_body(&self) -> ErrorBody {
        match self {
            ServerError::Protocol { code, message } => {
                ErrorBody::new(code.clone(), message.clone())
            }
            ServerError::Io(message) | ServerError::Config(message) => {
                ErrorBody::new(DeviceErrorCode::Internal, message.clone())
            }
        }
    }
}

/// 服务错误 → axum 响应（HTTP 状态 + ErrorBody JSON；R1-03 handler 统一
/// 以 `Result<Json<T>, ServerError>` 返回，`?` 传播后由本实现出网）
impl IntoResponse for ServerError {
    fn into_response(self) -> Response {
        let status =
            StatusCode::from_u16(self.http_status()).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR);
        (status, Json(self.error_body())).into_response()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn http_status_mapping_by_domain() {
        assert_eq!(ServerError::internal("x").http_status(), 500);
        assert_eq!(ServerError::io("x").http_status(), 500);
        assert_eq!(ServerError::config("x").http_status(), 500);
        // 配对域 → 403
        assert_eq!(
            ServerError::protocol(DeviceErrorCode::PairExpired, "x").http_status(),
            403
        );
        // 认证域 → 401
        assert_eq!(
            ServerError::protocol(DeviceErrorCode::AuthBadSignature, "x").http_status(),
            401
        );
        // 命令域细分
        assert_eq!(
            ServerError::protocol(DeviceErrorCode::CmdInvalid, "x").http_status(),
            400
        );
        // R1-11 G-5：白名单拒绝 → 403（cmd.denied）
        assert_eq!(
            ServerError::protocol(DeviceErrorCode::CmdDenied, "x").http_status(),
            403
        );
        assert_eq!(
            ServerError::protocol(DeviceErrorCode::CmdNotFound, "x").http_status(),
            404
        );
        assert_eq!(
            ServerError::protocol(DeviceErrorCode::CmdRestoreInProgress, "x").http_status(),
            409
        );
        // R1-04：审批冲突 → 409（F2 §11.2 收敛语义）
        assert_eq!(
            ServerError::protocol(DeviceErrorCode::CmdApprovalMismatch, "x").http_status(),
            409
        );
        assert_eq!(
            ServerError::protocol(DeviceErrorCode::CmdTooManyRequests, "x").http_status(),
            429
        );
        // R2-12c C22：命令未注册/未实现 → 501（占位端点语义）
        assert_eq!(
            ServerError::protocol(DeviceErrorCode::CmdUnknown, "x").http_status(),
            501
        );
    }

    #[test]
    fn error_body_uses_registered_code_and_retryable_table() {
        let body = ServerError::protocol(DeviceErrorCode::CmdApprovalMismatch, "已被其他设备处理")
            .error_body();
        assert_eq!(body.code, DeviceErrorCode::CmdApprovalMismatch);
        assert_eq!(body.message, "已被其他设备处理");
        assert!(!body.retryable);
        // Io → internal + retryable
        let io = ServerError::io("磁盘错误").error_body();
        assert_eq!(io.code, DeviceErrorCode::Internal);
        assert!(io.retryable);
    }

    #[test]
    fn from_core_error_reuses_single_source_mapping() {
        use conex_types::CoreError;
        assert_eq!(
            ServerError::from_core_error(&CoreError::NotFound("run not found".into()))
                .device_code(),
            DeviceErrorCode::CmdNotFound
        );
        assert_eq!(
            ServerError::from_core_error(&CoreError::InvalidInput("bad id".into())).device_code(),
            DeviceErrorCode::CmdInvalid
        );
        assert_eq!(
            ServerError::from_core_error(&CoreError::Internal("engine not ready".into()))
                .device_code(),
            DeviceErrorCode::CmdEngineNotReady
        );
        assert_eq!(
            ServerError::from_core_error(&CoreError::Cancelled).device_code(),
            DeviceErrorCode::CmdCancelled
        );
    }

    /// R1-03：IntoResponse 出网（HTTP 状态 + ErrorBody JSON 载荷）
    #[tokio::test]
    async fn into_response_maps_status_and_error_body() {
        let response =
            ServerError::protocol(DeviceErrorCode::CmdNotFound, "run 不存在").into_response();
        assert_eq!(response.status(), StatusCode::NOT_FOUND);
        let bytes = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        let body: ErrorBody = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(body.code, DeviceErrorCode::CmdNotFound);
        assert_eq!(body.message, "run 不存在");
    }
}
