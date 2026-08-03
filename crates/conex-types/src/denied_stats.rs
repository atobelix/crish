//! 审批拒绝统计收集点（G10：运行时门禁反哺月度报告）
//!
//! 目标：把「审批拒绝 → 事件 → 月度统计」闭环的计数面收敛到单一收集点。
//! 两个生产接线位：
//! - `security-audit` 事件的 denied 决策：agent-tools 经 `CountingAuditSink`
//!   （`agent-tools/src/audit.rs`）转发时计数；
//! - 恢复预算 denied（`recovery-budget-denied`）：orchestrator recovery
//!   预算耗尽分支经 [`global_denied_stats`] 计数。
//!
//! 输出接口：月度报告脚本直接拉取 [`global_denied_stats`] 的
//! [`DeniedStats::summary`]（serde JSON 序列化口径），无需查询事件表；
//! 计数为进程级累计（原子计数，跨线程安全，重启归零——持久化由事件表承载，
//! 月度汇总以「本统计 + 事件表留痕」双口径校验）。
//!
//! 注意：本模块只做计数，不做决策；放行/拒绝逻辑见权限与恢复域。

use serde::{Deserialize, Serialize};
use std::sync::OnceLock;
use std::sync::atomic::{AtomicU64, Ordering};

/// 拒绝统计快照（月度报告数据口径，JSON 可直接序列化）
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeniedStatsSummary {
    /// `security-audit` 事件中 decision = denied 的累计次数
    pub security_audit_denied: u64,
    /// 恢复预算耗尽拒绝（recovery-budget-denied）的累计次数
    pub recovery_budget_denied: u64,
}

/// 拒绝统计收集点（原子计数，跨线程安全；可 Arc 共享或经全局实例访问）
#[derive(Debug, Default)]
pub struct DeniedStats {
    security_audit_denied: AtomicU64,
    recovery_budget_denied: AtomicU64,
}

impl DeniedStats {
    /// 新建空统计
    pub fn new() -> Self {
        Self::default()
    }

    /// 记录一次 security-audit denied 决策（agent-tools CountingAuditSink 调用）
    pub fn record_security_audit_denied(&self) {
        self.security_audit_denied.fetch_add(1, Ordering::Relaxed);
    }

    /// 记录一次恢复预算 denied（orchestrator recovery 预算耗尽分支调用）
    pub fn record_recovery_budget_denied(&self) {
        self.recovery_budget_denied.fetch_add(1, Ordering::Relaxed);
    }

    /// 当前统计快照（月度报告拉取口径）
    pub fn summary(&self) -> DeniedStatsSummary {
        DeniedStatsSummary {
            security_audit_denied: self.security_audit_denied.load(Ordering::Relaxed),
            recovery_budget_denied: self.recovery_budget_denied.load(Ordering::Relaxed),
        }
    }
}

/// 进程级全局拒绝统计实例（引擎侧接线收集点；月度统计端直接拉取）
pub fn global_denied_stats() -> &'static DeniedStats {
    static GLOBAL: OnceLock<DeniedStats> = OnceLock::new();
    GLOBAL.get_or_init(DeniedStats::new)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn counter_records_and_summarizes() {
        let stats = DeniedStats::new();
        assert_eq!(stats.summary(), DeniedStatsSummary::default());
        stats.record_security_audit_denied();
        stats.record_security_audit_denied();
        stats.record_recovery_budget_denied();
        let s = stats.summary();
        assert_eq!(s.security_audit_denied, 2);
        assert_eq!(s.recovery_budget_denied, 1);
    }

    #[test]
    fn summary_serializes_as_json_for_monthly_report() {
        let stats = DeniedStats::new();
        stats.record_security_audit_denied();
        stats.record_recovery_budget_denied();
        let json = serde_json::to_value(stats.summary()).unwrap();
        assert_eq!(json["securityAuditDenied"], 1);
        assert_eq!(json["recoveryBudgetDenied"], 1);
        // 月度报告消费端反序列化 roundtrip
        let back: DeniedStatsSummary = serde_json::from_value(json).unwrap();
        assert_eq!(back.security_audit_denied, 1);
    }

    #[test]
    fn global_instance_is_singleton_and_shared() {
        // 全局实例恒为同一对象（进程级共享收集点）
        assert!(std::ptr::eq(global_denied_stats(), global_denied_stats()));
        // 全局实例计数可跨模块累计（勿在断言后保留副作用：本测试只读）
        let _ = global_denied_stats().summary();
    }
}
