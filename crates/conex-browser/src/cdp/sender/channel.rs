//! 发送通道抽象（CommandChannel + 直连 client 实现）与统一发送层入参 Command 构造器。

use super::{IdKey, DEFAULT_TIMEOUT};
use crate::cdp::client::CdpClient;
use crate::cdp::error::CdpError;
use async_trait::async_trait;
use serde::Serialize;
use serde_json::Value;
use std::time::Duration;

/// 发送通道抽象：transport 实现（重连透明），测试可注入直连 client。
#[async_trait]
pub trait CommandChannel: Send + Sync {
    async fn send_command(
        &self,
        method: &str,
        params: Option<Value>,
        session_id: Option<&str>,
        timeout: Duration,
    ) -> Result<Value, CdpError>;
    async fn send_command_no_wait(
        &self,
        method: &str,
        params: Option<Value>,
        session_id: Option<&str>,
    ) -> Result<(), CdpError>;
    /// 恢复期门禁（R-9-4：false = 工具面不可用）。
    fn is_ready(&self) -> bool;
}

/// 直连 client 通道（恢复流程/测试用；is_ready 恒 true）。
#[async_trait]
impl CommandChannel for CdpClient {
    async fn send_command(
        &self,
        method: &str,
        params: Option<Value>,
        session_id: Option<&str>,
        timeout: Duration,
    ) -> Result<Value, CdpError> {
        self.send_command_with_timeout(method, params, session_id, timeout)
            .await
    }
    async fn send_command_no_wait(
        &self,
        method: &str,
        params: Option<Value>,
        session_id: Option<&str>,
    ) -> Result<(), CdpError> {
        self.send_command_no_wait(method, params, session_id).await
    }
    fn is_ready(&self) -> bool {
        true
    }
}

/// 命令（统一发送层入参；视图层标注危险语义与目标摘要）。
#[derive(Debug, Clone)]
pub struct Command {
    pub method: String,
    pub params: Value,
    pub session_id: Option<String>,
    pub dangerous: bool,
    pub timeout: Duration,
    /// 目标摘要（url/节点摘要；敏感字段由调用方自行 [REDACTED]）
    pub summary: String,
    pub idempotency_key: Option<IdKey>,
}

impl Command {
    pub fn new(method: impl Into<String>) -> Self {
        Command {
            method: method.into(),
            params: Value::Null,
            session_id: None,
            dangerous: false,
            timeout: DEFAULT_TIMEOUT,
            summary: String::new(),
            idempotency_key: None,
        }
    }

    pub fn params(mut self, params: impl Serialize) -> Self {
        self.params = serde_json::to_value(params).unwrap_or(Value::Null);
        self
    }

    pub fn with_session(mut self, session: impl Into<String>) -> Self {
        self.session_id = Some(session.into());
        self
    }

    pub fn dangerous(mut self) -> Self {
        self.dangerous = true;
        self
    }

    pub fn with_timeout(mut self, timeout: Duration) -> Self {
        self.timeout = timeout;
        self
    }

    pub fn idempotent(mut self, key: IdKey) -> Self {
        self.idempotency_key = Some(key);
        self
    }

    pub fn with_summary(mut self, summary: impl Into<String>) -> Self {
        self.summary = summary.into();
        self
    }
}
