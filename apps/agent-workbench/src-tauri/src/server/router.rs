//! axum 路由注册与 handler（D2 §8：REST /v1/**；WS /v1/events 留 R1-05）
//!
//! 骨架期路由（R1-02）：
//! - `GET /v1/info`：免鉴权服务自报（loopback-only 路由可达；D2 §5.1，
//!   ADR-05 L4 清单 1）；
//! - `GET /v1/hello`：鉴权握手（D2 §8.2 形状 {serverVersion,
//!   protocolVersion, serverTimeMs}）——同时充当 Bearer 鉴权中间件的
//!   验证载体（无令牌 401）；
//! - 兜底 404：统一 ErrorBody JSON（防幽灵路由，对齐幽灵命令排除纪律）。
//!
//! R1-03/04 在此追加 T1/T2 路由（状态 / 会话 / 事件分页 / run 控制 /
//! 审批 / 配置），全部 handler 只依赖 [ServerState] + [ApiBackend] +
//! conex-types（D2 §4.3 可测试性架构）。

use axum::{
    Json,
    extract::State,
    http::{StatusCode, Uri},
    middleware,
    response::{IntoResponse, Response},
    routing::get,
    Router,
};
use conex_types::device::{DeviceErrorCode, ErrorBody};
use serde::Serialize;

use crate::server::{ServerError, ServerState, now_ms};

/// 服务自报路由（免鉴权）
pub const INFO_PATH: &str = "/v1/info";
/// 鉴权握手路由（Bearer 校验）
pub const HELLO_PATH: &str = "/v1/hello";

/// 鉴权握手载荷（GET /v1/hello；D2 §8.2 形状）
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HelloInfo {
    /// 桌面应用版本（semver）
    pub server_version: String,
    /// 协商后的协议版本
    pub protocol_version: u32,
    /// 桌面时钟（epoch ms；时钟校准）
    pub server_time_ms: u64,
}

/// 构建服务路由（骨架期；R1-03/04 增补 T1/T2 面）
pub fn build_router(state: ServerState) -> Router {
    // 免鉴权面（/v1/info；/v1/pair 归 R1-07）
    let info = Router::new().route(INFO_PATH, get(handle_info));
    // 鉴权面（Bearer 中间件；R1-03/04 的全部 /v1/** 命令路由挂此组）
    let protected = Router::new()
        .route(HELLO_PATH, get(handle_hello))
        .layer(middleware::from_fn_with_state(
            state.clone(),
            crate::server::auth::require_bearer_token,
        ));
    Router::new()
        .merge(info)
        .merge(protected)
        .fallback(handle_not_found)
        .with_state(state)
}

/// GET /v1/info：服务自报（端口 / 绑定模式 / 配对开关 / 版本 / 能力位）
async fn handle_info(State(state): State<ServerState>) -> Json<ServerInfoWire> {
    Json(state.server_info())
}

/// GET /v1/hello：鉴权握手（中间件校验通过后才到达）
async fn handle_hello(State(state): State<ServerState>) -> Json<HelloInfo> {
    let info = state.server_info();
    Json(HelloInfo {
        server_version: info.version,
        protocol_version: info.protocol_version,
        server_time_ms: now_ms(),
    })
}

/// 兜底 404（统一 ErrorBody JSON；cmd.not_found）
async fn handle_not_found(uri: Uri) -> Response {
    let body = ErrorBody::new(DeviceErrorCode::CmdNotFound, format!("路径不存在：{uri}"));
    (StatusCode::NOT_FOUND, Json(body)).into_response()
}

/// 错误响应（HTTP 状态 + ErrorBody 载荷；R1-03/04 handler 共用）
// R1-02 备注：R1-03/04 handler 消费——dead_code 静音（测试构建保持检查）
#[cfg_attr(not(test), allow(dead_code))]
pub(crate) fn error_response(err: &ServerError) -> Response {
    let status =
        StatusCode::from_u16(err.http_status()).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR);
    (status, Json(err.error_body())).into_response()
}

/// /v1/info 载荷类型别名（wire 形状见 ServerInfo）
type ServerInfoWire = crate::server::ServerInfo;

#[cfg(test)]
mod tests {
    use super::*;
    use crate::server::auth::{TokenStore, sha256_hex};
    use crate::server::{ServerConfig, ServerHandle};
    use axum::body::Body;
    use conex_types::device::{RunTaskParams, RunTaskResult};
    use tower::ServiceExt;

    /// 测试路由状态（临时目录令牌库 + 空后端）
    fn test_state() -> ServerState {
        let config = ServerConfig::new(std::env::temp_dir());
        let handle = ServerHandle::new(config, "127.0.0.1:0".parse().expect("固定测试地址"));
        let tokens =
            TokenStore::new(std::env::temp_dir().join("pairing-router-test.json"));
        ServerState::new(&handle, tokens, None)
    }

    /// 内存后端（骨架验证：证明 ApiBackend trait 可实现；R1-03 以
    /// CoreStateBackend 替换）
    struct MockBackend;

    #[async_trait::async_trait]
    impl crate::server::backend::ApiBackend for MockBackend {
        async fn get_status(&self) -> Result<serde_json::Value, ServerError> {
            Ok(serde_json::json!({ "initialized": true }))
        }
        async fn run_task(
            &self,
            _params: RunTaskParams,
        ) -> Result<RunTaskResult, ServerError> {
            Err(ServerError::internal("未接线（R1-04）"))
        }
        async fn run_control(
            &self,
            _params: conex_types::device::RunControlParams,
        ) -> Result<conex_types::device::RunControlResult, ServerError> {
            Err(ServerError::internal("未接线（R1-04）"))
        }
        async fn cancel_run(
            &self,
            _params: conex_types::device::CancelRunParams,
        ) -> Result<conex_types::device::CancelRunResult, ServerError> {
            Err(ServerError::internal("未接线（R1-04）"))
        }
        async fn approve(
            &self,
            _params: conex_types::device::ApproveParams,
        ) -> Result<conex_types::device::ApproveResult, ServerError> {
            Err(ServerError::internal("未接线（R1-04）"))
        }
        async fn deny(
            &self,
            _params: conex_types::device::ApproveParams,
        ) -> Result<conex_types::device::ApproveResult, ServerError> {
            Err(ServerError::internal("未接线（R1-04）"))
        }
        async fn list_sessions(
            &self,
            _params: conex_types::device::ListSessionsParams,
        ) -> Result<conex_types::device::ListSessionsResult, ServerError> {
            Err(ServerError::internal("未接线（R1-03）"))
        }
        async fn read_session_events(
            &self,
            _params: conex_types::device::EventPageParams,
        ) -> Result<conex_types::device::EventPageResult, ServerError> {
            Err(ServerError::internal("未接线（R1-03）"))
        }
        async fn get_run_snapshot(
            &self,
            _params: conex_types::device::RunSnapshotParams,
        ) -> Result<conex_types::device::RunSnapshotResult, ServerError> {
            Err(ServerError::internal("未接线（R1-03）"))
        }
        async fn list_commands(
            &self,
        ) -> Result<conex_types::device::ListCommandsResult, ServerError> {
            Err(ServerError::internal("未接线（R1-03）"))
        }
    }

    #[test]
    fn backend_injectable_into_state() {
        let handle = ServerHandle::new(
            ServerConfig::new(std::env::temp_dir()),
            "127.0.0.1:0".parse().unwrap(),
        );
        let backend: Option<std::sync::Arc<dyn crate::server::backend::ApiBackend>> =
            Some(std::sync::Arc::new(MockBackend));
        let state = ServerState::new(
            &handle,
            TokenStore::new(std::env::temp_dir().join("pairing-router-test.json")),
            backend,
        );
        assert!(state.backend().is_some(), "backend 注入后应可读取");
    }

    #[tokio::test]
    async fn info_endpoint_shape() {
        let app = build_router(test_state());
        let response = app
            .oneshot(
                axum::http::Request::builder()
                    .uri(INFO_PATH)
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let bytes = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        let info: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(info["service"].as_str(), Some("crish-agent-workbench"));
        assert!(info["version"].is_string());
        assert_eq!(info["protocolVersion"].as_u64(), Some(1));
        assert_eq!(info["minProtocolVersion"].as_u64(), Some(1));
        assert_eq!(info["bindMode"].as_str(), Some("loopback"));
        assert_eq!(info["pairingActive"].as_bool(), Some(false));
        assert!(info["port"].is_u64(), "port 必须存在");
        assert!(info["serverTimeMs"].is_u64(), "serverTimeMs 必须存在");
        let caps = info["capabilities"].as_object().expect("capabilities 必须为对象");
        assert_eq!(caps.len(), 17, "能力位必须 17 位全表");
    }

    #[tokio::test]
    async fn hello_without_token_is_401() {
        let app = build_router(test_state());
        let response = app
            .oneshot(
                axum::http::Request::builder()
                    .uri(HELLO_PATH)
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
        let bytes = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        let body: ErrorBody = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(body.code, DeviceErrorCode::AuthBadSignature);
        assert!(!body.retryable);
    }

    #[tokio::test]
    async fn hello_with_valid_token_succeeds() {
        let state = test_state();
        let raw = state
            .tokens()
            .lock()
            .unwrap()
            .issue("test-device", now_ms())
            .expect("签发必须成功");
        let app = build_router(state);
        let response = app
            .oneshot(
                axum::http::Request::builder()
                    .uri(HELLO_PATH)
                    .header(axum::http::header::AUTHORIZATION, format!("Bearer {raw}"))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let bytes = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        let body: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(body["protocolVersion"].as_u64(), Some(1));
        assert!(body["serverVersion"].is_string());
        assert!(body["serverTimeMs"].is_u64());
    }

    #[tokio::test]
    async fn hello_with_revoked_token_is_401() {
        let state = test_state();
        let raw = state
            .tokens()
            .lock()
            .unwrap()
            .issue("test-device", now_ms())
            .expect("签发必须成功");
        let hash = sha256_hex(raw.as_bytes());
        assert!(state.tokens().lock().unwrap().revoke(&hash));
        let app = build_router(state);
        let response = app
            .oneshot(
                axum::http::Request::builder()
                    .uri(HELLO_PATH)
                    .header(axum::http::header::AUTHORIZATION, format!("Bearer {raw}"))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
        let bytes = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        let body: ErrorBody = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(body.code, DeviceErrorCode::AuthDeviceRevoked);
    }

    #[tokio::test]
    async fn malformed_auth_header_is_401() {
        let app = build_router(test_state());
        let response = app
            .oneshot(
                axum::http::Request::builder()
                    .uri(HELLO_PATH)
                    // 非 Bearer 前缀 / 空令牌
                    .header(axum::http::header::AUTHORIZATION, "Token abc")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
    }

    #[tokio::test]
    async fn unknown_path_returns_404_error_body() {
        let app = build_router(test_state());
        let response = app
            .oneshot(
                axum::http::Request::builder()
                    .uri("/v1/does-not-exist")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::NOT_FOUND);
        let bytes = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        let body: ErrorBody = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(body.code, DeviceErrorCode::CmdNotFound);
    }

    #[tokio::test]
    async fn error_response_maps_status_and_body() {
        let response = error_response(&ServerError::protocol(
            DeviceErrorCode::PairExpired,
            "配对码已过期",
        ));
        assert_eq!(response.status(), StatusCode::FORBIDDEN);
    }
}
