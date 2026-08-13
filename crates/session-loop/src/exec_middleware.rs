//! 中间件与钩子面（SR-03 拆分 · ≠ EL）：run_hook_with_timeout /
//! tool_progress_update / middleware_names（cfg(test) 观测面）
//!
//! 中间件链超时竞速助手（E4 收口）、S1 进度出站映射与中间件链名称
//! 快照（loop 装配测试观测面）随本模落位。语义与拆分前逐行一致
//!（只搬移不改行为）。

use super::*;

impl ToolExecutor {
    /// 中间件链名称快照（#[cfg(test)] 观测面：loop 装配测试断言默认链
    /// 生效——T-EG-06 装配后链 = 写前自动备份中间件）
    #[cfg(test)]
    pub fn middleware_names(&self) -> Vec<String> {
        self.middleware
            .iter()
            .map(|m| m.name().to_string())
            .collect()
    }
}

/// 中间件钩子超时竞速助手（E4：06 遗留 :148-152 收口）
///
/// - 无 abort 信号：`tokio::time::timeout(timeout, fut)`；
/// - 有 abort 信号：竞速**偏置 abort**（`biased`，先触发先生效）——
///   abort 触发返回 None，调用方按取消收场（超时窗口内可取消）；
/// - 超时返回 `Err(Elapsed)`，由调用方按 06「中间件自身错误语义」表
///   处置（before_execute → Block；on_result → 降级透传；on_error → 日志）。
pub(crate) async fn run_hook_with_timeout<T>(
    timeout: Duration,
    abort: Option<&crate::safe_point::AbortSignal>,
    fut: impl std::future::Future<Output = T>,
) -> Option<Result<T, tokio::time::error::Elapsed>> {
    match abort {
        Some(sig) => tokio::select! {
            biased;
            _ = sig.wait_aborted() => None,
            result = tokio::time::timeout(timeout, fut) => Some(result),
        },
        None => Some(tokio::time::timeout(timeout, fut).await),
    }
}

///
/// - `Text` → `text` 承载 + `metadata.kind = "tool-progress"`；
/// - `Custom` → `json` 承载 + `metadata.kind = subkind`（与前端预留的
///   `metadata.kind === 'tool-args-delta'` 消费面同槽位扩展）；
/// - `Content` → 阶段 1 仅类型定义，返回 None（不发射，`content-blocks`
///   kind 字面量预留）。
pub(crate) fn tool_progress_update(p: &ToolProgress) -> Option<ToolProgressUpdate> {
    match p {
        ToolProgress::Text { text } => Some(ToolProgressUpdate {
            text: Some(text.clone()),
            json: None,
            metadata: Some(serde_json::json!({ "kind": "tool-progress" })),
        }),
        ToolProgress::Custom { subkind, payload } => Some(ToolProgressUpdate {
            text: None,
            json: Some(payload.clone()),
            metadata: Some(serde_json::json!({ "kind": subkind })),
        }),
        ToolProgress::Content { .. } => None,
    }
}