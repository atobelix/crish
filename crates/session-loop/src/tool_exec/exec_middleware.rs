//! 中间件与钩子面（SR-03 拆分 · ≠ EL）：run_hook_with_timeout /
//! middleware_names（cfg(test) 观测面）
//!
//! 中间件链超时竞速助手（E4 收口）与中间件链名称快照（loop 装配测试
//! 观测面）随本模落位。语义与拆分前逐行一致（只搬移不改行为）。
//!
//! > 统一输入流收敛战役 R1（tool-update 事件契约删除）：`tool_progress_update`
//! > 映射随 `AgentEvent` 的 tool-update 变体删除——S1 流式进度无出站事件（前端零
//! > 消费），终值仍由 tool-end 承载；`ToolProgress`（agent-tools 流式协议
//! > 类型）保留供执行器内部使用。

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
