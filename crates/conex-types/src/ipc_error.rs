//! Tauri 命令统一错误协议（对齐 Stream B 契约 5.2）。
//!
//! 使用 `#[serde(tag = "kind", content = "detail")]` 让 JS 侧可按 `error.kind`
//! 分类处理，`error.detail` 携带具体信息。Cancelled 无 detail。
//! 同时实现 Deserialize 以支持测试 roundtrip 与未来 IPC 双向传输。

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, thiserror::Error)]
#[serde(tag = "kind", content = "detail")]
pub enum CoreError {
    #[error("invalid input: {0}")]
    InvalidInput(String),
    #[error("encoding error: {0}")]
    Encoding(String),
    #[error("io error: {0}")]
    Io(String),
    #[error("not found: {0}")]
    NotFound(String),
    #[error("cancelled")]
    Cancelled,
    #[error("internal: {0}")]
    Internal(String),
}

impl CoreError {
    pub fn invalid_input(msg: impl Into<String>) -> Self {
        Self::InvalidInput(msg.into())
    }

    pub fn internal(msg: impl Into<String>) -> Self {
        Self::Internal(msg.into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn core_error_serializes_as_tagged_enum() {
        let err = CoreError::InvalidInput("bad id".into());
        let json = serde_json::to_value(&err).unwrap();
        assert_eq!(json["kind"], "InvalidInput");
        assert_eq!(json["detail"], "bad id");

        let cancelled = CoreError::Cancelled;
        let json2 = serde_json::to_value(&cancelled).unwrap();
        assert_eq!(json2["kind"], "Cancelled");
        // detail 字段对 unit variant 为 null
        assert!(json2.get("detail").is_none() || json2["detail"].is_null());
    }

    #[test]
    fn core_error_roundtrip() {
        let err = CoreError::Internal("db locked".into());
        let json = serde_json::to_string(&err).unwrap();
        let back: CoreError = serde_json::from_str(&json).unwrap();
        match back {
            CoreError::Internal(msg) => assert_eq!(msg, "db locked"),
            other => panic!("expected Internal, got {other:?}"),
        }
    }
}
