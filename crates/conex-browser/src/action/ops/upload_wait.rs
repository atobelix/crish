//! 文件选择、上传与连接恢复等待实现。

use std::time::Duration;

use serde_json::json;

use super::error::{CDP_DOM_SET_FILE_INPUT_FILES, CMD_TIMEOUT};
use super::page_ops::BrowserPageOps;
use super::traits::PageOps;
use crate::action::{ActionError, ActionErrorKind};
use crate::cdp::bus::BrowserEvent;

impl BrowserPageOps {
    pub(crate) async fn set_file_input_files_impl(
        &self,
        backend_node_id: i64,
        files: &[String],
    ) -> Result<(), ActionError> {
        self.send(
            CDP_DOM_SET_FILE_INPUT_FILES,
            json!({ "backendNodeId": backend_node_id, "files": files }),
            CMD_TIMEOUT,
        )
        .await?;
        Ok(())
    }

    pub(crate) async fn is_file_input_impl(&self, node_id: i64) -> Result<bool, ActionError> {
        let object_id = self.resolve_node(node_id).await?;
        let value = self
            .call_function_on(
                &object_id,
                crate::action::upload::IS_FILE_INPUT_TEMPLATE,
                &[],
            )
            .await?;
        Ok(value.as_bool().unwrap_or(false))
    }

    pub(crate) async fn file_chooser_node_impl(
        &self,
        timeout: Duration,
    ) -> Result<i64, ActionError> {
        let mut rx = self.session.subscribe();
        let deadline = tokio::time::Instant::now() + timeout;
        loop {
            let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
            if remaining.is_zero() {
                return Err(ActionError::new(
                    ActionErrorKind::Timeout,
                    format!(
                        "等待 Page.fileChooserOpened 超时（{}ms）",
                        timeout.as_millis()
                    ),
                ));
            }
            match tokio::time::timeout(remaining, rx.recv()).await {
                Ok(Ok(BrowserEvent::FileChooserOpened {
                    backend_node_id, ..
                })) => return Ok(backend_node_id),
                Ok(Ok(_)) => {}
                Ok(Err(_)) => {
                    return Err(ActionError::new(
                        ActionErrorKind::TargetClosed,
                        "事件总线关闭（目标已销毁）",
                    ));
                }
                Err(_) => {
                    return Err(ActionError::new(
                        ActionErrorKind::Timeout,
                        format!(
                            "等待 Page.fileChooserOpened 超时（{}ms）",
                            timeout.as_millis()
                        ),
                    ));
                }
            }
        }
    }

    pub(crate) async fn await_connection_restored_impl(
        &self,
        timeout: Duration,
    ) -> Result<(), ActionError> {
        let mut rx = self.session.subscribe();
        let deadline = tokio::time::Instant::now() + timeout;
        loop {
            let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
            if remaining.is_zero() {
                return Err(ActionError::new(
                    ActionErrorKind::ConnectionLost,
                    format!(
                        "等待 ConnectionRestored 超时（{}s，恢复窗口 R-9）",
                        timeout.as_secs()
                    ),
                ));
            }
            match tokio::time::timeout(remaining, rx.recv()).await {
                Ok(Ok(BrowserEvent::ConnectionRestored { .. })) => return Ok(()),
                Ok(Ok(_)) => {}
                Ok(Err(_)) => {
                    return Err(ActionError::new(
                        ActionErrorKind::TargetClosed,
                        "事件总线关闭（目标已销毁）",
                    ));
                }
                Err(_) => {
                    return Err(ActionError::new(
                        ActionErrorKind::ConnectionLost,
                        format!(
                            "等待 ConnectionRestored 超时（{}s，恢复窗口 R-9）",
                            timeout.as_secs()
                        ),
                    ));
                }
            }
        }
    }
}
