//! 撤回边界冻结护栏（统一输入流收敛战役 R1 · 详案 §1.2-③）
//!
//! # 冻结协议（引擎侧，评审 01 ②#2 硬项）
//!
//! 撤回 = 时间线的**逻辑截断**（只追加不变量保持）：先停 run（L3 force_cancel
//! 收敛 + 子代理 kill_all），在稳定点读取会话 MAX(sequence) 得到 `frozen_seq`，
//! 再发射 `timeline-truncate`（boundary_seq = frozen_seq，自身占
//! sequence = frozen_seq + 1）。冻结护栏保证「截断后无新事件越过 boundary」：
//!
//! - 冻结激活期（从「进入冻结协议」到「TimelineTruncate 落库确认」）内，
//!   任何 `sequence > frozen_seq` 的**非撤离事件**写入被拒绝（fail-closed，
//!   对齐 exec_single fail-closed 语义；冻结期为 stop 收敛级毫秒窗口）；
//! - 撤离事件（retraction 自身 / run 收口终态事件）放行——run-terminal /
//!   agent-end 属 run 收口路径内，truncate 后自然停写；
//! - 令牌式单会话互斥（`retraction_token`）：同一会话并发撤回 → 第二次
//!   进入前检查令牌，未释放则拒绝（FREEZE3 硬验收）。
//!
//! 冻结注册表为**会话级**共享状态（同会话所有 EventQueue 写侧经注入的
//! `Arc<SessionFreezeRegistry>` 挂检查点，见 orchestrator/events.rs），
//! 与 events 表 `session_sequence` 会话级原子计数器（MAX 语义只抬高不
//! 回退）配套：frozen_seq 是历史序列上限，不可能被回退覆盖。
//!
//! > 撤回逻辑 = 扩展点 D 承载，不进核心循环（核心模型 §4 D；07 审计 C1
//! > 主战场 handlers 不动）；本模块只提供状态与判定原语，协议编排见
//! > `retraction.rs`，写侧检查点挂载见 orchestrator/events.rs。

use std::collections::HashMap;
use std::sync::Mutex;

/// 会话级撤回冻结注册表（写侧隔离的单一事实源）
///
/// `freeze()` 登记（进入冻结）→ 写侧经 [Self::check_write] 校验 →
/// `release()` 释放（truncate 落库确认）。同会话重复冻结由令牌互斥
/// 拒绝（[FreezeError::AlreadyFrozen]）。
#[derive(Debug, Default)]
pub struct SessionFreezeRegistry {
    inner: Mutex<HashMap<String, FrozenSession>>,
}

/// 单个会话的冻结态
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FrozenSession {
    /// 冻结边界：本撤回事务内不会再被任何事件超过的序列
    pub frozen_seq: u64,
    /// 撤回事务令牌（释放凭据；单会话互斥）
    pub token: String,
}

/// 冻结操作错误
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum FreezeError {
    /// 同会话已有生效冻结（并发双重撤回，FREEZE3：第二个拒绝，不双写边界）
    AlreadyFrozen { token: String },
    /// 会话未在冻结态（释放/校验无对应登记）
    NotFrozen,
    /// 令牌不匹配（防误释放他人撤回事务）
    TokenMismatch,
}

/// 写侧校验结论
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WriteVerdict {
    /// 放行（无冻结 / 序列 ≤ frozen_seq / 撤离事件）
    Allow,
    /// 拒绝：冻结期内越过 frozen_seq 的非撤离写入
    Reject { frozen_seq: u64 },
}

impl std::fmt::Display for FreezeError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            FreezeError::AlreadyFrozen { token } => {
                write!(f, "会话已有生效冻结（token={token}），并发撤回被拒绝")
            }
            FreezeError::NotFrozen => write!(f, "会话未在冻结态"),
            FreezeError::TokenMismatch => write!(f, "撤回令牌不匹配，拒绝释放"),
        }
    }
}

impl std::error::Error for FreezeError {}

impl SessionFreezeRegistry {
    /// 新建空注册表
    pub fn new() -> Self {
        Self::default()
    }

    /// 进入冻结：登记会话冻结（幂等互斥——同会话已冻结返回
    /// [FreezeError::AlreadyFrozen]，令牌不覆盖，不双写边界）
    pub fn freeze(
        &self,
        session_id: &str,
        token: &str,
        frozen_seq: u64,
    ) -> Result<(), FreezeError> {
        let mut map = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(existing) = map.get(session_id) {
            return Err(FreezeError::AlreadyFrozen {
                token: existing.token.clone(),
            });
        }
        map.insert(
            session_id.to_string(),
            FrozenSession {
                frozen_seq,
                token: token.to_string(),
            },
        );
        Ok(())
    }

    /// 会话是否处于冻结激活期
    pub fn is_frozen(&self, session_id: &str) -> bool {
        self.inner
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .contains_key(session_id)
    }

    /// 会话当前冻结边界（None = 未冻结）
    pub fn frozen_seq(&self, session_id: &str) -> Option<u64> {
        self.inner
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(session_id)
            .map(|f| f.frozen_seq)
    }

    /// 写侧校验：冻结期内 `sequence > frozen_seq` 的写入返回
    /// [WriteVerdict::Reject]（撤离事件由调用方按
    /// [is_retraction_evacuation_event] 先行放行）
    pub fn check_write(&self, session_id: &str, sequence: u64) -> WriteVerdict {
        match self.frozen_seq(session_id) {
            Some(frozen) if sequence > frozen => WriteVerdict::Reject { frozen_seq: frozen },
            _ => WriteVerdict::Allow,
        }
    }

    /// 释放冻结（truncate 落库确认后；令牌校验防误释放）
    pub fn release(&self, session_id: &str, token: &str) -> Result<(), FreezeError> {
        let mut map = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        match map.get(session_id) {
            None => Err(FreezeError::NotFrozen),
            Some(existing) if existing.token != token => Err(FreezeError::TokenMismatch),
            Some(_) => {
                map.remove(session_id);
                Ok(())
            }
        }
    }
}

/// 撤离事件判定（冻结护栏放行面）：非撤离事件 = retraction 自身
/// （timeline-truncate）与 run 收口的终态事件（run-terminal / agent-end）。
///
/// 冻结期边界 = 从「进入冻结协议」到「TimelineTruncate 落库确认」；
/// 收口路径内的终态事件（agent-end → run-terminal）在 stop 收敛时已
/// 先于冻结读点落库，放行面仅为防御性兜底（残余并发写不误伤收口）。
pub fn is_retraction_evacuation_event(event: &conex_types::events::AgentEvent) -> bool {
    matches!(
        event,
        conex_types::events::AgentEvent::TimelineTruncate { .. }
            | conex_types::events::AgentEvent::RunTerminal { .. }
            | conex_types::events::AgentEvent::AgentEnd { .. }
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use conex_types::events::AgentEvent;

    fn agent_start() -> AgentEvent {
        AgentEvent::AgentStart {
            session_id: "s1".into(),
            timestamp: "2026-08-16T00:00:00Z".into(),
        }
    }

    /// 冻结登记 → 写侧拒绝越界 → 令牌释放全链路
    #[test]
    fn freeze_reject_release_roundtrip() {
        let reg = SessionFreezeRegistry::new();
        assert!(!reg.is_frozen("s1"));
        reg.freeze("s1", "tok-1", 42).unwrap();
        assert!(reg.is_frozen("s1"));
        assert_eq!(reg.frozen_seq("s1"), Some(42));
        // 冻结边界内放行（序列 ≤ frozen_seq）
        assert_eq!(reg.check_write("s1", 42), WriteVerdict::Allow);
        // 越过 frozen_seq 拒绝（FREEZE1 护栏语义）
        assert_eq!(
            reg.check_write("s1", 43),
            WriteVerdict::Reject { frozen_seq: 42 }
        );
        // 未冻结会话放行
        assert_eq!(reg.check_write("s2", 1), WriteVerdict::Allow);
        // 释放后放行
        reg.release("s1", "tok-1").unwrap();
        assert!(!reg.is_frozen("s1"));
        assert_eq!(reg.check_write("s1", 999), WriteVerdict::Allow);
    }

    /// FREEZE3：并发双重撤回互斥——同会话第二次 freeze 拒绝（令牌不覆盖，
    /// 不双写边界），释放后允许新冻结
    #[test]
    fn concurrent_double_freeze_is_rejected() {
        let reg = SessionFreezeRegistry::new();
        reg.freeze("s1", "tok-a", 10).unwrap();
        // 第二个撤回事务进入失败（fail-closed，不半冻结）
        assert_eq!(
            reg.freeze("s1", "tok-b", 11),
            Err(FreezeError::AlreadyFrozen {
                token: "tok-a".into()
            })
        );
        // 原冻结仍生效（边界未被覆盖）
        assert_eq!(reg.frozen_seq("s1"), Some(10));
        // 释放失败：令牌不匹配（防误释放他人事务）
        assert_eq!(reg.release("s1", "tok-b"), Err(FreezeError::TokenMismatch));
        // 正确令牌释放 → 新冻结可进入
        reg.release("s1", "tok-a").unwrap();
        reg.freeze("s1", "tok-c", 20).unwrap();
        assert_eq!(reg.frozen_seq("s1"), Some(20));
    }

    /// 撤离事件判定：timeline-truncate / run-terminal / agent-end 放行；
    /// 普通事件（agent-start 等）非撤离
    #[test]
    fn evacuation_event_classification() {
        use conex_types::events::{RunTerminalStatus, TimelineTruncateReason};
        assert!(is_retraction_evacuation_event(&AgentEvent::TimelineTruncate {
            session_id: "s1".into(),
            run_id: "r1".into(),
            boundary_seq: 42,
            reason: TimelineTruncateReason::UserRequested,
            target_message_id: "m1".into(),
            timestamp: "2026-08-16T00:00:00Z".into(),
        }));
        assert!(is_retraction_evacuation_event(&AgentEvent::RunTerminal {
            session_id: "s1".into(),
            run_id: "r1".into(),
            timestamp: "2026-08-16T00:00:00Z".into(),
            terminal: RunTerminalStatus::Cancelled,
            error: None,
        }));
        assert!(is_retraction_evacuation_event(&AgentEvent::AgentEnd {
            session_id: "s1".into(),
            timestamp: "2026-08-16T00:00:00Z".into(),
            reason: conex_types::session::AgentEndReason::Stopped,
            error: None,
        }));
        assert!(!is_retraction_evacuation_event(&agent_start()));
    }
}
