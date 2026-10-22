//! CrishError 与 IPC 负载 CrishErrorPayload（构造、序列化、std::error 互操作）

use super::{codes, info, now_millis, CrishErrorCategory, CRISH_ERROR_CAUSE_MAX_DEPTH};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

/// Crish 错误类型（struct，非 enum）
///
/// Crish 错误类型（struct，非 enum），与 TS 端 CrishError class 同构。
/// 102 码通过 code: String 表达，
/// category/retryable 由 info(code) 在构造时决定，可通过 with_* 覆盖。
/// cause 链在 to_error_payload 时按 depth 截断。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CrishError {
    pub code: String,
    pub message: String,
    pub category: CrishErrorCategory,
    pub retryable: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub params: Option<HashMap<String, serde_json::Value>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub metadata: Option<serde_json::Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cause: Option<Box<CrishError>>,
    pub timestamp: i64,
}

impl CrishError {
    /// 创建错误，category/retryable 由 info(code) 决定
    pub fn new(code: &str, message: impl Into<String>) -> Self {
        let info = info(code);
        Self {
            code: code.into(),
            message: message.into(),
            category: info.category,
            retryable: info.retryable,
            params: None,
            metadata: None,
            cause: None,
            timestamp: now_millis(),
        }
    }

    /// 附加单个动态参数（TS 端模板插值 {param} 消费）
    pub fn with_param(
        mut self,
        key: impl Into<String>,
        value: impl Into<serde_json::Value>,
    ) -> Self {
        let map = self.params.get_or_insert_with(HashMap::new);
        map.insert(key.into(), value.into());
        self
    }

    /// 附加多个动态参数
    pub fn with_params(mut self, params: HashMap<String, serde_json::Value>) -> Self {
        match self.params.as_mut() {
            Some(existing) => existing.extend(params),
            None => self.params = Some(params),
        }
        self
    }

    /// 覆盖 category（对齐 §2.1 设计原则 3：retryable 与 category 解耦）
    pub fn with_category(mut self, category: CrishErrorCategory) -> Self {
        self.category = category;
        self
    }

    /// 覆盖 retryable
    pub fn with_retryable(mut self, retryable: bool) -> Self {
        self.retryable = retryable;
        self
    }

    /// 附加 metadata
    pub fn with_metadata(mut self, metadata: serde_json::Value) -> Self {
        self.metadata = Some(metadata);
        self
    }

    /// 附加 cause（构建因果链）
    pub fn with_cause(mut self, cause: CrishError) -> Self {
        self.cause = Some(Box::new(cause));
        self
    }

    /// 是否可重试（直接返回字段值，不重新查询 registry）
    pub fn is_retryable(&self) -> bool {
        self.retryable
    }

    /// 序列化为 IPC 负载，cause 链在 depth >= 8 时截断
    /// （TS 端 toErrorPayload 同构，截断 payload 携带 metadata.truncated = true）
    pub fn to_error_payload(&self, depth: u8) -> CrishErrorPayload {
        if depth >= CRISH_ERROR_CAUSE_MAX_DEPTH {
            return CrishErrorPayload {
                code: codes::COMMON_UNKNOWN.to_string(),
                message: format!("cause chain truncated at depth {depth}"),
                category: CrishErrorCategory::Permanent,
                retryable: false,
                is_public: false,
                action: "action.runtime.none".to_string(),
                params: None,
                metadata: Some(serde_json::json!({ "truncated": true })),
                cause: None,
                stack: None,
                timestamp: now_millis(),
            };
        }
        let info_val = info(&self.code);
        CrishErrorPayload {
            code: self.code.clone(),
            message: self.message.clone(),
            category: self.category,
            retryable: self.retryable,
            is_public: info_val.is_public,
            action: info_val.action.to_string(),
            params: self.params.clone(),
            metadata: self.metadata.clone(),
            cause: self
                .cause
                .as_ref()
                .map(|c| Box::new(c.to_error_payload(depth + 1))),
            stack: None, // Rust 端无 JS stack，置 None；前端从 cause 链还原
            timestamp: self.timestamp,
        }
    }
}

/// 跨进程序列化错误负载（TS 端 CrishErrorPayload 同构）
///
/// 字段一一对应 packages/shared-types/src/errors/serialize.ts 的 CrishErrorPayload：
/// code / message / category / retryable / public / action / params / metadata / cause / stack / timestamp
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CrishErrorPayload {
    pub code: String,
    pub message: String,
    pub category: CrishErrorCategory,
    pub retryable: bool,
    /// 序列化为 "public"（TS 端字段名同值）
    #[serde(rename = "public")]
    pub is_public: bool,
    pub action: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub params: Option<HashMap<String, serde_json::Value>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub metadata: Option<serde_json::Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cause: Option<Box<CrishErrorPayload>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stack: Option<String>,
    pub timestamp: i64,
}

impl CrishErrorPayload {
    /// 附加单个动态参数
    pub fn with_param(
        mut self,
        key: impl Into<String>,
        value: impl Into<serde_json::Value>,
    ) -> Self {
        let map = self.params.get_or_insert_with(HashMap::new);
        map.insert(key.into(), value.into());
        self
    }

    /// 附加多个动态参数
    pub fn with_params(mut self, params: HashMap<String, serde_json::Value>) -> Self {
        match self.params.as_mut() {
            Some(existing) => existing.extend(params),
            None => self.params = Some(params),
        }
        self
    }

    /// 从任意 std::error::Error 构造兜底 payload（TS 端 fromUnknownError 同构）
    ///
    /// 若 e 已是 CrishError，直接 to_error_payload(0)；否则用 common.unknown 兜底。
    /// 要求 `'static` 是为了支持 downcast_ref（标准模式，与 anyhow/std 一致）。
    pub fn from_unknown(e: &(dyn std::error::Error + 'static)) -> Self {
        if let Some(c) = e.downcast_ref::<CrishError>() {
            return c.to_error_payload(0);
        }
        CrishErrorPayload {
            code: codes::COMMON_UNKNOWN.to_string(),
            message: e.to_string(),
            category: CrishErrorCategory::Permanent,
            retryable: false,
            is_public: true,
            action: "action.common.report_bug".to_string(),
            params: None,
            metadata: None,
            cause: None,
            stack: None,
            timestamp: now_millis(),
        }
    }

    /// 是否可重试
    pub fn is_retryable(&self) -> bool {
        self.retryable
    }
}

impl From<CrishError> for CrishErrorPayload {
    fn from(e: CrishError) -> Self {
        e.to_error_payload(0)
    }
}

impl std::fmt::Display for CrishError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}: {}", self.code, self.message)
    }
}

impl std::error::Error for CrishError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        self.cause
            .as_ref()
            .map(|c| c.as_ref() as &(dyn std::error::Error + 'static))
    }
}
