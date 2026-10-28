//! KV Cache 缓存绝对不变性保护 (KV Cache Invariance Guard)
//!
//! 依据 `03-context-and-resilience-improvement.md` §六（§6.1）与清退清单 PURGE-04：
//! 废除单回合运行时中途 In-Flight Hot-Swap，保卫 Slot 4 近期交互轮次 KV Cache 100% 命中。
//!
//! ## 缺陷机理与架构纠偏
//! - **原缺陷机理 (PURGE-04)**：原方案在当前 Run 的 `prepare_turn` 中途，将位于前置槽位 Slot 3
//!   的 Stub 消息原子替换为 Committed 摘要。这一改动直接改变了请求头部的字节哈希，
//!   导致处于尾部的 Slot 4（近期对话轮次）发生 **100% KV Cache Miss**；
//! - **平滑升级原则**：
//!   1. **Run 内部前缀绝对只读**：在一个已拉起的 Run 内部，Slot 0 至 Slot 3 的全部字节在首回合确定后**严格冻结**，
//!      严禁任何形式的动态热替换！无论中途后台摘要何时计算完成，当前 Run 的 Slot 3 均维持 Stub 文本不变，
//!      确保当前 Run 产生的所有后续轮次 100% 享受 KV Cache 命中加速；
//!   2. **后台异步写入温区**：后台 `SessionSummaryCoordinator` 生成 Committed 摘要后，立即原子更新
//!      SQLite `compression_blocks` 表，标记为 `committed`，并将产物写入会话级元数据；
//!   3. **跨 Episode / Run 边界平滑升级**：当前 Run 运行结束、会话收敛至终态或跨入下一个全新
//!      Episode / Run 时，水合加载器从 SQLite `compression_blocks` 重新构建消息流，此时正式载入 Committed 摘要。

use std::fmt;
use std::sync::atomic::{AtomicBool, Ordering};

/// 缓存绝对不变性策略断言器
#[derive(Debug, Default)]
pub struct CacheInvarianceGuard {
    /// 标记当前 Run 是否处于活跃生命周期中（活跃期内绝对禁止 Hot-Swap）
    run_active: AtomicBool,
}

impl CacheInvarianceGuard {
    /// 新建守卫实例
    pub fn new() -> Self {
        Self {
            run_active: AtomicBool::new(false),
        }
    }

    /// 标记 Run 启动，前缀进入绝对冻结期
    pub fn enter_run(&self) {
        self.run_active.store(true, Ordering::Release);
    }

    /// 标记 Run 结束，跨入 Episode 边界（此时允许水合升级）
    pub fn exit_run(&self) {
        self.run_active.store(false, Ordering::Release);
    }

    /// 是否处于 Run 执行活跃期
    pub fn is_run_active(&self) -> bool {
        self.run_active.load(Ordering::Acquire)
    }

    /// 校验是否允许对前缀摘要执行热替换
    ///
    /// 在 Run 运行中途调用本函数将返回 `Err`，刚性拦截任何击穿 KV Cache 的操作！
    pub fn check_swap_permission(&self) -> Result<(), InFlightSwapForbiddenError> {
        if self.is_run_active() {
            Err(InFlightSwapForbiddenError {
                reason: "PURGE-04 铁律拦截：当前 Run 执行中途严禁执行 In-Flight Hot-Swap！前缀必须维持恒定以保护 KV Cache。升级仅允许在跨 Run / Episode 边界进行。".to_string(),
            })
        } else {
            Ok(())
        }
    }
}

/// 试图在 Run 内部执行 Hot-Swap 时抛出的刚性安全错误
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InFlightSwapForbiddenError {
    pub reason: String,
}

impl fmt::Display for InFlightSwapForbiddenError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "In-Flight Hot-Swap 违规被拦截: {}", self.reason)
    }
}

impl std::error::Error for InFlightSwapForbiddenError {}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_in_flight_swap_prohibited_during_active_run() {
        let guard = CacheInvarianceGuard::new();
        // 初始未处于 Run 活跃期，允许边界平滑替换
        assert!(guard.check_swap_permission().is_ok());

        // 启动 Run
        guard.enter_run();
        assert!(guard.is_run_active());

        // 运行中途尝试 Hot-Swap：必须被 100% 刚性拦截！
        let err = guard.check_swap_permission().unwrap_err();
        assert!(err.reason.contains("PURGE-04"));

        // Run 结束收口
        guard.exit_run();
        assert!(!guard.is_run_active());
        assert!(guard.check_swap_permission().is_ok());
    }
}
