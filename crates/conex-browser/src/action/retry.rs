//! 重试状态机（维度 14 §5，retry.rs）
//!
//! - 错误分类 → 重试策略映射（§5.1 表逐行；R-8 额度口径、R-9 ConnectionLost/
//!   TargetRestarting 两行）：
//!   - `VersionInvalid`/`NodeStale`：重快照 → 重定位 → 重派发，**计入** 3 次总上限；
//!   - `TargetClosed`：延迟 300ms → 目标存活校验 → 重快照，计入；
//!   - `ContextGone`：延迟 300ms → 版本校验 → 重派发，计入；
//!   - `NotInteractive`：首轮等待可见（≤2s）→ 重试；再犯重快照，计入；
//!   - `Timeout`：等待就绪 → 重试 1 次 → 致命，计入；
//!   - `ConnectionLost`：等待 ConnectionRestored → 重试 ≤1 次，**不计入**（R-9）；
//!   - `Aborted`：立即中止，**不计入**（R-8 用户接管吊销）；
//!   - `TargetRestarting`/`GateDenied`/`ApprovalDenied`/`InvalidInput`/`Unsupported`：致命；
//! - NodeStale 3 次耗尽 → 「节点定位失败」升级提示（T-10：`ActionError::escalate`，
//!   用户确认后继续/中止，接口点维度 17 §2.2 审批链）。

use crate::action::{ActionError, ActionErrorKind};

/// 重试策略（§5.1 表「策略」列）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RetryStrategy {
    /// 重快照 → 按索引重定位 → 重派发（VersionInvalid/NodeStale）
    Retake,
    /// 延迟 300ms → 版本校验 → 原 backendNodeId 重派发（ContextGone）
    DelayThenRetry,
    /// 延迟 300ms → 目标存活校验 → 重快照（TargetClosed）
    DelayThenRetake,
    /// NotInteractive 首轮：wait_for 可见（≤2s）→ 重试；再犯重快照
    WaitVisible,
    /// Timeout 首轮：等待就绪 → 重试 1 次；再犯致命
    WaitThenRetry,
    /// ConnectionLost：等待 ConnectionRestored → 重试 ≤1 次（不计额度，R-9）
    AwaitConnection,
    /// 致命：门禁拒绝/审批拒绝/入参非法/目标不可支持/进程重启中
    Fatal,
    /// 中止：用户接管/令牌吊销（不计额度，R-8）
    Abort,
}

/// 策略映射产物（策略 + 是否计入 3 次总上限）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RetryPolicy {
    pub strategy: RetryStrategy,
    /// true = 计入 3 次总上限（R-8 口径）
    pub counts_toward_quota: bool,
}

/// 错误分类 → 重试策略映射（§5.1 表逐行；R-8/R-9）。
pub fn policy_for(kind: ActionErrorKind) -> RetryPolicy {
    match kind {
        ActionErrorKind::VersionInvalid | ActionErrorKind::NodeStale => RetryPolicy {
            strategy: RetryStrategy::Retake,
            counts_toward_quota: true,
        },
        ActionErrorKind::TargetClosed => RetryPolicy {
            strategy: RetryStrategy::DelayThenRetake,
            counts_toward_quota: true,
        },
        ActionErrorKind::ContextGone => RetryPolicy {
            strategy: RetryStrategy::DelayThenRetry,
            counts_toward_quota: true,
        },
        ActionErrorKind::NotInteractive => RetryPolicy {
            strategy: RetryStrategy::WaitVisible,
            counts_toward_quota: true,
        },
        ActionErrorKind::Timeout => RetryPolicy {
            strategy: RetryStrategy::WaitThenRetry,
            counts_toward_quota: true,
        },
        ActionErrorKind::ConnectionLost => RetryPolicy {
            strategy: RetryStrategy::AwaitConnection,
            counts_toward_quota: false,
        },
        ActionErrorKind::TargetRestarting
        | ActionErrorKind::GateDenied
        | ActionErrorKind::ApprovalDenied
        | ActionErrorKind::InvalidInput
        | ActionErrorKind::Unsupported => RetryPolicy {
            strategy: RetryStrategy::Fatal,
            counts_toward_quota: false,
        },
        ActionErrorKind::Aborted => RetryPolicy {
            strategy: RetryStrategy::Abort,
            counts_toward_quota: false,
        },
    }
}

/// 单次决策产物（execute_inner 消费）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RetryDecision {
    /// 终止并返回最终错误（致命/额度耗尽/中止）
    Stop(ActionError),
    /// 直接重派发（同参数，无重定位）
    Continue,
    /// 延迟 300ms → 版本校验 → 重派发（ContextGone）
    DelayThenRetry,
    /// 延迟 300ms → 目标存活校验 → 重快照（TargetClosed）
    DelayThenRetake,
    /// 重快照 → 按索引重定位 → 重派发（VersionInvalid/NodeStale/NotInteractive 再犯）
    Retake,
    /// NotInteractive 首轮：等待可见（≤2s）
    WaitVisible,
    /// Timeout 首轮：等待就绪
    WaitThenRetry,
    /// ConnectionLost：等待恢复事件
    AwaitConnection,
}

/// 动作执行三分类（§2.1：成功 / 可重试 / 致命；供重试状态机决策，不向工具面直接暴露）。
#[derive(Debug, Clone, PartialEq)]
pub enum ActionOutcome {
    /// 成功；payload 供工具面组织返回文本
    Success(crate::action::ActionSuccess),
    /// 可重试失败（按 §5.1 策略表）
    Retryable(ActionError),
    /// 致命失败（门禁拒绝/审批拒绝/入参非法/目标不可达）
    Fatal(ActionError),
}

/// 重试状态（额度、分阶段计数；单动作实例内自 execute 起有效）。
#[derive(Debug, Clone)]
pub struct RetryState {
    /// 计入额度的重试数（R-8：VersionInvalid/NodeStale 等）
    pub consumed: u32,
    /// 上限（默认 3，ActionOptions.max_attempts）
    pub max: u32,
    /// NotInteractive 阶段（0 = 未等待；1 = 已等待可见，再犯走重快照）
    not_interactive_stage: u8,
    /// Timeout 阶段（0 = 未等待；1 = 已等待，再犯致命）
    timeout_stage: u8,
    /// ConnectionLost 恢复后重试次数（≤1，不计额度，R-9）
    connection_retries: u32,
}

impl RetryState {
    pub fn new(max: u32) -> Self {
        RetryState {
            consumed: 0,
            max,
            not_interactive_stage: 0,
            timeout_stage: 0,
            connection_retries: 0,
        }
    }

    /// 下一次派发尝试编号（1 起）。
    pub fn next_attempt(&self) -> u32 {
        self.consumed + 1
    }

    /// 消耗一次额度；已达上限返回 false（应终止）。
    fn consume(&mut self) -> bool {
        if self.consumed >= self.max {
            return false;
        }
        self.consumed += 1;
        true
    }

    fn reset_stages(&mut self) {
        self.not_interactive_stage = 0;
        self.timeout_stage = 0;
    }

    /// 决策（§5.3 状态机核心；额度口径 R-8/R-9）。
    ///
    /// 派发尝试编号 1..=max（§5.3 图：attempt > 3 → Fatal(最后一次错误)）：
    /// 第 max 次尝试的错误到达时立即终止——重试次数 = max-1，错误携带 attempt=max。
    pub fn decide(&mut self, err: &ActionError) -> RetryDecision {
        // 已消耗 max-1 次（当前错误来自第 max 次尝试）→ 终止
        let exhausted = self.consumed >= self.max.saturating_sub(1);
        match policy_for(err.kind).strategy {
            RetryStrategy::Fatal => RetryDecision::Stop(err.clone()),
            RetryStrategy::Abort => RetryDecision::Stop(err.clone()),
            RetryStrategy::Retake => {
                if exhausted {
                    RetryDecision::Stop(exhaustion_error(err, self.max))
                } else {
                    self.consume();
                    self.reset_stages();
                    RetryDecision::Retake
                }
            }
            RetryStrategy::DelayThenRetry => {
                if exhausted {
                    RetryDecision::Stop(err.clone())
                } else {
                    self.consume();
                    RetryDecision::DelayThenRetry
                }
            }
            RetryStrategy::DelayThenRetake => {
                if exhausted {
                    RetryDecision::Stop(err.clone())
                } else {
                    self.consume();
                    RetryDecision::DelayThenRetake
                }
            }
            RetryStrategy::WaitVisible => match self.not_interactive_stage {
                0 => {
                    if exhausted {
                        RetryDecision::Stop(exhaustion_error(err, self.max))
                    } else {
                        self.consume();
                        self.not_interactive_stage = 1;
                        RetryDecision::WaitVisible
                    }
                }
                _ => {
                    // 已等待过：再犯 → 重快照（索引在新快照中可能已变化）
                    self.not_interactive_stage = 0;
                    if exhausted {
                        RetryDecision::Stop(exhaustion_error(err, self.max))
                    } else {
                        self.consume();
                        RetryDecision::Retake
                    }
                }
            },
            RetryStrategy::WaitThenRetry => match self.timeout_stage {
                0 => {
                    if exhausted {
                        RetryDecision::Stop(err.clone())
                    } else {
                        self.consume();
                        self.timeout_stage = 1;
                        RetryDecision::WaitThenRetry
                    }
                }
                _ => RetryDecision::Stop(err.clone()),
            },
            RetryStrategy::AwaitConnection => {
                // 不消耗额度（R-9）：恢复后重试 ≤1 次
                if self.connection_retries < 1 {
                    self.connection_retries += 1;
                    RetryDecision::AwaitConnection
                } else {
                    RetryDecision::Stop(err.clone())
                }
            }
        }
    }
}

/// 额度耗尽产物（§5.3/T-10）：
/// - NodeStale → 「节点定位失败」升级提示（escalate=true，用户确认后继续/中止）；
/// - 其余错误类别 → 原样致命（Fatal(最后一次错误)）。
fn exhaustion_error(err: &ActionError, max: u32) -> ActionError {
    if err.kind == ActionErrorKind::NodeStale {
        let mut escalated = err.clone();
        escalated.escalate = true;
        escalated.attempt = max.clamp(1, u8::MAX as u32) as u8;
        escalated.message = format!(
            "节点定位失败：目标元素反复失效（第 {max} 次尝试仍失败，T-10）。升级：用户确认后可携最新快照继续，或中止（接口点维度 17 §2.2 审批链）"
        );
        escalated
    } else {
        err.clone()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn err_of(kind: ActionErrorKind) -> ActionError {
        ActionError::new(kind, "测试错误")
    }

    /// 错误分类 → 策略映射穷举（§5.1 表全 13 类；R-8/R-9 额度口径断言）。
    #[test]
    fn policy_table_exhaustive() {
        let cases = [
            (ActionErrorKind::VersionInvalid, RetryStrategy::Retake, true),
            (ActionErrorKind::NodeStale, RetryStrategy::Retake, true),
            (
                ActionErrorKind::TargetClosed,
                RetryStrategy::DelayThenRetake,
                true,
            ),
            (
                ActionErrorKind::ContextGone,
                RetryStrategy::DelayThenRetry,
                true,
            ),
            (
                ActionErrorKind::NotInteractive,
                RetryStrategy::WaitVisible,
                true,
            ),
            (ActionErrorKind::Timeout, RetryStrategy::WaitThenRetry, true),
            // R-9：断连恢复后重试不计入额度
            (
                ActionErrorKind::ConnectionLost,
                RetryStrategy::AwaitConnection,
                false,
            ),
            // R-9：进程重启中由工具层 gating 拦截，原语层致命
            (
                ActionErrorKind::TargetRestarting,
                RetryStrategy::Fatal,
                false,
            ),
            // R-8：用户接管吊销不计入额度
            (ActionErrorKind::Aborted, RetryStrategy::Abort, false),
            (ActionErrorKind::GateDenied, RetryStrategy::Fatal, false),
            (ActionErrorKind::ApprovalDenied, RetryStrategy::Fatal, false),
            (ActionErrorKind::InvalidInput, RetryStrategy::Fatal, false),
            (ActionErrorKind::Unsupported, RetryStrategy::Fatal, false),
        ];
        assert_eq!(cases.len(), 13, "策略表必须覆盖全部错误类别");
        for (kind, strategy, counts) in cases {
            let policy = policy_for(kind);
            assert_eq!(policy.strategy, strategy, "{kind:?} 策略不符");
            assert_eq!(policy.counts_toward_quota, counts, "{kind:?} 额度口径不符");
        }
    }

    /// 3 次上限（R-8/E2E-18）：NodeStale 计入；第 3 次尝试（attempt=3）的错误到达即耗尽
    /// 升级（escalate），不再发起第 4 次尝试（§5.3 图：attempt > 3 → Fatal）。
    #[test]
    fn quota_exhaustion_node_stale_escalates() {
        let mut state = RetryState::new(3);
        let err = err_of(ActionErrorKind::NodeStale);
        let first = state.decide(&err);
        let second = state.decide(&err);
        assert!(
            matches!(first, RetryDecision::Retake),
            "第 1 次尝试失败 → 重试"
        );
        assert!(
            matches!(second, RetryDecision::Retake),
            "第 2 次尝试失败 → 重试"
        );
        assert_eq!(state.consumed, 2, "重试次数 = max-1");
        // 第 3 次尝试（attempt=3）的错误 → 耗尽升级
        let stop = state.decide(&err);
        match stop {
            RetryDecision::Stop(final_err) => {
                assert!(final_err.escalate, "NodeStale 耗尽应升级（T-10）");
                assert_eq!(final_err.attempt, 3, "错误携带 attempt=3（E2E-18）");
                assert!(final_err.message.contains("节点定位失败"));
            }
            other => panic!("应 Stop，实际 {other:?}"),
        }
    }

    /// 非 NodeStale 类别耗尽 → 原样致命（Fatal(最后一次错误)）。
    #[test]
    fn quota_exhaustion_other_kinds_fatal_as_is() {
        let mut state = RetryState::new(3);
        let err = err_of(ActionErrorKind::ContextGone);
        assert!(matches!(state.decide(&err), RetryDecision::DelayThenRetry));
        assert!(matches!(state.decide(&err), RetryDecision::DelayThenRetry));
        let stop = state.decide(&err);
        match stop {
            RetryDecision::Stop(final_err) => {
                assert_eq!(final_err.kind, ActionErrorKind::ContextGone);
                assert!(!final_err.escalate);
            }
            other => panic!("应 Stop，实际 {other:?}"),
        }
    }

    /// NotInteractive 两阶段（§5.1）：首轮等待可见 → 再犯重快照；额度内不超过 3 次尝试。
    #[test]
    fn not_interactive_two_stage() {
        let mut state = RetryState::new(3);
        let err = err_of(ActionErrorKind::NotInteractive);
        let first = state.decide(&err);
        assert!(matches!(first, RetryDecision::WaitVisible), "首轮等待可见");
        let second = state.decide(&err);
        assert!(matches!(second, RetryDecision::Retake), "再犯重快照");
        assert_eq!(state.consumed, 2, "两阶段各计入一次额度");
        // 第 3 次尝试的错误 → 耗尽（两阶段循环受 3 次尝试上限约束）
        let third = state.decide(&err);
        assert!(
            matches!(third, RetryDecision::Stop(_)),
            "3 次尝试后不再循环"
        );
    }

    /// Timeout 两阶段（§5.1）：首轮等待 → 重试 1 次 → 致命。
    #[test]
    fn timeout_two_stage_then_fatal() {
        let mut state = RetryState::new(3);
        let err = err_of(ActionErrorKind::Timeout);
        let first = state.decide(&err);
        assert!(matches!(first, RetryDecision::WaitThenRetry));
        let stop = state.decide(&err);
        match stop {
            RetryDecision::Stop(final_err) => {
                assert_eq!(final_err.kind, ActionErrorKind::Timeout)
            }
            other => panic!("应 Stop，实际 {other:?}"),
        }
    }

    /// ConnectionLost 不计入额度（R-9）：恢复后重试 ≤1 次，之后致命。
    #[test]
    fn connection_lost_no_quota() {
        let mut state = RetryState::new(3);
        let err = err_of(ActionErrorKind::ConnectionLost);
        let first = state.decide(&err);
        assert!(matches!(first, RetryDecision::AwaitConnection));
        assert_eq!(state.consumed, 0, "ConnectionLost 不得消耗额度");
        // 恢复后重试（第 2 次尝试）再遇断连 → 致命（恢复后重试 ≤1 次）
        let second = state.decide(&err);
        match second {
            RetryDecision::Stop(final_err) => {
                assert_eq!(final_err.kind, ActionErrorKind::ConnectionLost)
            }
            other => panic!("应 Stop，实际 {other:?}"),
        }
        assert_eq!(state.consumed, 0, "全程不消耗额度");
    }

    /// Aborted 不计入额度（R-8）且立即中止。
    #[test]
    fn aborted_immediate_stop() {
        let mut state = RetryState::new(3);
        let stop = state.decide(&err_of(ActionErrorKind::Aborted));
        match stop {
            RetryDecision::Stop(final_err) => assert_eq!(final_err.kind, ActionErrorKind::Aborted),
            other => panic!("应 Stop，实际 {other:?}"),
        }
        assert_eq!(state.consumed, 0);
    }

    /// 致命类别直接 Stop 且不消耗额度。
    #[test]
    fn fatal_kinds_stop_immediately() {
        for kind in [
            ActionErrorKind::GateDenied,
            ActionErrorKind::ApprovalDenied,
            ActionErrorKind::InvalidInput,
            ActionErrorKind::Unsupported,
            ActionErrorKind::TargetRestarting,
        ] {
            let mut state = RetryState::new(3);
            let stop = state.decide(&err_of(kind));
            match stop {
                RetryDecision::Stop(final_err) => assert_eq!(final_err.kind, kind),
                other => panic!("{kind:?} 应 Stop，实际 {other:?}"),
            }
            assert_eq!(state.consumed, 0, "{kind:?} 不消耗额度");
        }
    }

    /// 重试中注入 abort：状态机在任何决策点前都应中止（由 execute_inner 的检查承接）。
    #[test]
    fn aborted_after_consumption_keeps_quota() {
        let mut state = RetryState::new(3);
        // 已消耗 1 次（NodeStale），随后 Aborted → 不计入，剩余额度不变
        assert!(matches!(
            state.decide(&err_of(ActionErrorKind::NodeStale)),
            RetryDecision::Retake
        ));
        assert_eq!(state.consumed, 1);
        let stop = state.decide(&err_of(ActionErrorKind::Aborted));
        assert!(matches!(stop, RetryDecision::Stop(_)));
        assert_eq!(state.consumed, 1, "Aborted 不计入额度（R-8）");
        // 新一轮动作（新 RetryState）额度完好：第 1/2 次尝试失败可重试
        let mut fresh = RetryState::new(3);
        assert!(matches!(
            fresh.decide(&err_of(ActionErrorKind::NodeStale)),
            RetryDecision::Retake
        ));
        assert!(matches!(
            fresh.decide(&err_of(ActionErrorKind::NodeStale)),
            RetryDecision::Retake
        ));
        assert!(matches!(
            fresh.decide(&err_of(ActionErrorKind::NodeStale)),
            RetryDecision::Stop(_)
        ));
        assert_eq!(fresh.consumed, 2, "重试次数 = max-1");
    }
}
