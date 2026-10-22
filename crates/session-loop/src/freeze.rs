//! 撤回边界冻结护栏（统一输入流收敛战役 R1 · 详案 §1.2-③ / 04A §3.4 / 04B §2.2）
//!
//! # 冻结协议（两阶段严格物理上界）
//!
//! 撤回 = 时间线的**逻辑截断**（只追加不变量保持）：
//! - 第一阶段（Freezing）：先停 run（L3 force_cancel 收敛 + 子代理 kill_all），
//!   收敛期内仅允许已在运行的 run 发送终态（run-terminal / agent-end）以安全收敛；
//! - 第二阶段（Frozen 严格物理上界锁死）：在稳定点读取会话 MAX(sequence) 得到 `frozen_seq`，
//!   确立严格单调上界，除携带合法 Token 的 `timeline-truncate` 写入 `frozen_seq + 1` 之外，
//!   **彻底拔除任何其它事件越界写入的白名单后门**（RunTerminal 与 AgentEnd 严禁越界追加）；
//! - 令牌式单会话互斥（`retraction_token`）：同一会话并发撤回 → 第二次
//!   进入前检查令牌，未释放则拒绝（FREEZE3 硬验收）。

use std::collections::HashMap;
use std::sync::Mutex;

/// 单个会话的两阶段冻结状态（04B §2.2）
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SessionFreezeState {
    /// 第一阶段：收敛拦截态（正在停 run，阻断除收口终态事件之外的所有新用户请求与普通事件）
    Freezing { token: String, deadline_ms: u64 },
    /// 第二阶段：物理上界锁死态（已确立严格单调上界 frozen_seq，除携带合法 Token 的 TimelineTruncate 写入 frozen_seq + 1 外，阻断任何其它事件越界写入）
    Frozen {
        token: String,
        frozen_seq: u64,
        truncate_reserved_seq: u64,
    },
}

/// 会话级撤回冻结注册表（写侧隔离的单一事实源）
#[derive(Debug, Default)]
pub struct SessionFreezeRegistry {
    inner: Mutex<HashMap<String, SessionFreezeState>>,
}

/// 单个会话的冻结态（向后兼容视图）
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FrozenSession {
    /// 冻结边界：本撤回事务内不会再被任何事件超过的序列
    pub frozen_seq: u64,
    /// 撤回事务令牌（释放凭据；单会话互斥）
    pub token: String,
    /// 为 TimelineTruncate 预留的序列号（frozen_seq + 1）
    pub truncate_reserved_seq: u64,
}

impl FrozenSession {
    /// 新建冻结会话快照
    pub fn new(frozen_seq: u64, token: impl Into<String>) -> Self {
        let token = token.into();
        Self {
            frozen_seq,
            truncate_reserved_seq: frozen_seq + 1,
            token,
        }
    }
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
    /// 放行（无冻结 / 序列 ≤ frozen_seq / 合法截断事件）
    Allow,
    /// 拒绝：冻结期内越过 frozen_seq 的越界写入
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

    fn lock(&self) -> std::sync::MutexGuard<'_, HashMap<String, SessionFreezeState>> {
        self.inner.lock().unwrap_or_else(|e| {
            tracing::error!(target: "session_loop", "freeze 注册表锁中毒，按恢复模式继续：{e}");
            e.into_inner()
        })
    }

    /// 第一阶段：申请进入收敛冻结态（正在停 run，阻断普通写入，仅允许收敛终态事件）
    pub fn begin_freezing(
        &self,
        session_id: &str,
        token: &str,
        timeout_ms: u64,
    ) -> Result<(), FreezeError> {
        let mut map = self.lock();
        match map.get(session_id) {
            None => {
                let deadline_ms = conex_shared::time::unix_millis() as u64 + timeout_ms;
                map.insert(
                    session_id.to_string(),
                    SessionFreezeState::Freezing {
                        token: token.to_string(),
                        deadline_ms,
                    },
                );
                Ok(())
            }
            Some(SessionFreezeState::Freezing { token: cur, .. })
            | Some(SessionFreezeState::Frozen { token: cur, .. }) => {
                Err(FreezeError::AlreadyFrozen { token: cur.clone() })
            }
        }
    }

    /// 第二阶段：收敛完成，确立硬性序号上界 frozen_seq，并锁定 TimelineTruncate 预留序号（frozen_seq + 1）
    pub fn lock_frozen_sequence(
        &self,
        session_id: &str,
        token: &str,
        frozen_seq: u64,
    ) -> Result<u64, FreezeError> {
        let mut map = self.lock();
        let current = map.get_mut(session_id).ok_or(FreezeError::NotFrozen)?;
        match current {
            SessionFreezeState::Freezing { token: cur, .. } if cur == token => {
                let truncate_seq = frozen_seq + 1;
                *current = SessionFreezeState::Frozen {
                    token: token.to_string(),
                    frozen_seq,
                    truncate_reserved_seq: truncate_seq,
                };
                Ok(truncate_seq)
            }
            SessionFreezeState::Frozen { token: cur, .. } if cur == token => Ok(frozen_seq + 1),
            _ => Err(FreezeError::TokenMismatch),
        }
    }

    /// 直接进入第二阶段冻结（兼容单步协议与既有调用）：
    /// 登记会话冻结，以 frozen_seq 为严格物理上界，预留 frozen_seq + 1 供 TimelineTruncate 使用。
    pub fn freeze(
        &self,
        session_id: &str,
        token: &str,
        frozen_seq: u64,
    ) -> Result<(), FreezeError> {
        let mut map = self.lock();
        let truncate_reserved_seq = frozen_seq + 1;
        match map.get(session_id) {
            None => {
                map.insert(
                    session_id.to_string(),
                    SessionFreezeState::Frozen {
                        token: token.to_string(),
                        frozen_seq,
                        truncate_reserved_seq,
                    },
                );
                Ok(())
            }
            Some(SessionFreezeState::Freezing { token: cur, .. }) if cur == token => {
                map.insert(
                    session_id.to_string(),
                    SessionFreezeState::Frozen {
                        token: token.to_string(),
                        frozen_seq,
                        truncate_reserved_seq,
                    },
                );
                Ok(())
            }
            Some(SessionFreezeState::Freezing { token: cur, .. })
            | Some(SessionFreezeState::Frozen { token: cur, .. }) => {
                Err(FreezeError::AlreadyFrozen { token: cur.clone() })
            }
        }
    }

    /// 会话是否处于冻结激活期（处于 Freezing 或 Frozen 状态均返回 true）
    pub fn is_frozen(&self, session_id: &str) -> bool {
        self.lock().contains_key(session_id)
    }

    /// 会话是否处于第一阶段收敛冻结态
    pub fn is_freezing(&self, session_id: &str) -> bool {
        matches!(
            self.lock().get(session_id),
            Some(SessionFreezeState::Freezing { .. })
        )
    }

    /// 会话是否处于第二阶段严格物理上界锁死态
    pub fn is_strictly_frozen(&self, session_id: &str) -> bool {
        matches!(
            self.lock().get(session_id),
            Some(SessionFreezeState::Frozen { .. })
        )
    }

    /// 获取会话两阶段状态
    pub fn get_state(&self, session_id: &str) -> Option<SessionFreezeState> {
        self.lock().get(session_id).cloned()
    }

    /// 会话当前冻结边界（None = 未进入第二阶段锁定）
    pub fn frozen_seq(&self, session_id: &str) -> Option<u64> {
        match self.lock().get(session_id) {
            Some(SessionFreezeState::Frozen { frozen_seq, .. }) => Some(*frozen_seq),
            _ => None,
        }
    }

    /// 获取为 TimelineTruncate 预留的合法序列号（None = 未进入第二阶段锁定）
    pub fn truncate_reserved_seq(&self, session_id: &str) -> Option<u64> {
        match self.lock().get(session_id) {
            Some(SessionFreezeState::Frozen {
                truncate_reserved_seq,
                ..
            }) => Some(*truncate_reserved_seq),
            _ => None,
        }
    }

    /// 获取冻结会话快照（向后兼容视图）
    pub fn frozen_session(&self, session_id: &str) -> Option<FrozenSession> {
        match self.lock().get(session_id) {
            Some(SessionFreezeState::Frozen {
                token,
                frozen_seq,
                truncate_reserved_seq,
            }) => Some(FrozenSession {
                frozen_seq: *frozen_seq,
                token: token.clone(),
                truncate_reserved_seq: *truncate_reserved_seq,
            }),
            _ => None,
        }
    }

    /// 写侧校验：冻结期内 `sequence > frozen_seq` 的写入返回 [WriteVerdict::Reject]
    pub fn check_write(&self, session_id: &str, sequence: u64) -> WriteVerdict {
        let map = self.lock();
        match map.get(session_id) {
            Some(SessionFreezeState::Frozen { frozen_seq, .. }) if sequence > *frozen_seq => {
                WriteVerdict::Reject {
                    frozen_seq: *frozen_seq,
                }
            }
            Some(SessionFreezeState::Freezing { .. }) => WriteVerdict::Reject { frozen_seq: 0 },
            _ => WriteVerdict::Allow,
        }
    }

    /// 严格事件写入门禁（04A §3.4 / 04B §2.2.2）：
    /// 1. 未冻结状态：全量放行；
    /// 2. Freezing 阶段（第一阶段）：仅放行收敛终态事件（RunTerminal / AgentEnd），阻断新请求；
    /// 3. Frozen 阶段（第二阶段严格物理上界）：
    ///    - 唯一允许 sequence > frozen_seq 的事件，必须且只能是携带合法 Token 且 sequence == frozen_seq + 1 的 TimelineTruncate 本身；
    ///    - 任何其它事件（包含 RunTerminal / AgentEnd），只要 sequence > frozen_seq，统统刚性阻断！
    pub fn check_event_write(
        &self,
        session_id: &str,
        event: &conex_types::events::AgentEvent,
        proposed_seq: u64,
        token: Option<&str>,
    ) -> WriteVerdict {
        let map = self.lock();
        let Some(state) = map.get(session_id) else {
            return WriteVerdict::Allow;
        };

        match state {
            SessionFreezeState::Freezing { .. } => {
                // 收敛期仅放行已在运行的 run 发送其自身终态（以使其能够安全收敛）
                if matches!(
                    event,
                    conex_types::events::AgentEvent::RunTerminal { .. }
                        | conex_types::events::AgentEvent::AgentEnd { .. }
                ) {
                    WriteVerdict::Allow
                } else {
                    WriteVerdict::Reject { frozen_seq: 0 }
                }
            }
            SessionFreezeState::Frozen {
                token: valid_token,
                frozen_seq,
                truncate_reserved_seq,
            } => {
                // 物理上界铁律：
                // 1. 唯一允许 sequence > frozen_seq 的事件，必须且只能是携带正确 token 的 TimelineTruncate 本身！
                if matches!(
                    event,
                    conex_types::events::AgentEvent::TimelineTruncate { .. }
                ) && token == Some(valid_token.as_str())
                    && proposed_seq == *truncate_reserved_seq
                {
                    return WriteVerdict::Allow;
                }
                // 2. 其它任何事件，如果序号大于 frozen_seq，无论是否叫 RunTerminal / AgentEnd，统统无条件硬性阻断！
                if proposed_seq > *frozen_seq {
                    return WriteVerdict::Reject {
                        frozen_seq: *frozen_seq,
                    };
                }
                WriteVerdict::Allow
            }
        }
    }

    /// 释放冻结（truncate 落库确认后；令牌校验防误释放）
    pub fn release(&self, session_id: &str, token: &str) -> Result<(), FreezeError> {
        let mut map = self.lock();
        match map.get(session_id) {
            None => Err(FreezeError::NotFrozen),
            Some(SessionFreezeState::Freezing { token: cur, .. })
            | Some(SessionFreezeState::Frozen { token: cur, .. })
                if cur != token =>
            {
                Err(FreezeError::TokenMismatch)
            }
            Some(_) => {
                map.remove(session_id);
                Ok(())
            }
        }
    }
}

/// 撤离事件判定（冻结护栏放行面）：
///
/// 【重构铁律（04A §3.4 / 04B §2.2）】：
/// 彻底拔除放行 RunTerminal / AgentEnd 越界写入的白名单后门！
/// 撤回的核心不变量是「事件流物理上界锁死」，所有 Run 的收敛终态事件（RunTerminal / AgentEnd）
/// 必须且只能在冻结读点前完成（其 sequence <= frozen_seq）。
/// 冻结生效后，【唯独放行 TimelineTruncate 自身】，任何其它事件越界写入统统阻断！
pub fn is_retraction_evacuation_event(event: &conex_types::events::AgentEvent) -> bool {
    matches!(
        event,
        conex_types::events::AgentEvent::TimelineTruncate { .. }
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use conex_types::events::{AgentEvent, RunTerminalStatus, TimelineTruncateReason};

    fn agent_start() -> AgentEvent {
        AgentEvent::AgentStart {
            session_id: "s1".into(),
            timestamp: "2026-08-16T00:00:00Z".into(),
        }
    }

    fn truncate_event(seq: u64) -> AgentEvent {
        AgentEvent::TimelineTruncate {
            session_id: "s1".into(),
            run_id: "r1".into(),
            boundary_seq: seq,
            reason: TimelineTruncateReason::UserRequested,
            target_message_id: "m1".into(),
            timestamp: "2026-08-16T00:00:00Z".into(),
        }
    }

    fn terminal_event() -> AgentEvent {
        AgentEvent::RunTerminal {
            session_id: "s1".into(),
            run_id: "r1".into(),
            timestamp: "2026-08-16T00:00:00Z".into(),
            terminal: RunTerminalStatus::Cancelled,
            error: None,
        }
    }

    fn agent_end_event() -> AgentEvent {
        AgentEvent::AgentEnd {
            session_id: "s1".into(),
            timestamp: "2026-08-16T00:00:00Z".into(),
            reason: conex_types::session::AgentEndReason::Stopped,
            error: None,
        }
    }

    /// 冻结登记 → 写侧拒绝越界 → 令牌释放全链路
    #[test]
    fn freeze_reject_release_roundtrip() {
        let reg = SessionFreezeRegistry::new();
        assert!(!reg.is_frozen("s1"));
        reg.freeze("s1", "tok-1", 42).unwrap();
        assert!(reg.is_frozen("s1"));
        assert!(reg.is_strictly_frozen("s1"));
        assert_eq!(reg.frozen_seq("s1"), Some(42));
        assert_eq!(reg.truncate_reserved_seq("s1"), Some(43));

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

    /// 两阶段状态机转移测试：begin_freezing -> lock_frozen_sequence -> release
    #[test]
    fn two_phase_freeze_transitions() {
        let reg = SessionFreezeRegistry::new();
        // 步骤 1：申请进入收敛拦截态
        reg.begin_freezing("s1", "tok-two-phase", 5000).unwrap();
        assert!(reg.is_frozen("s1"));
        assert!(reg.is_freezing("s1"));
        assert!(!reg.is_strictly_frozen("s1"));
        assert_eq!(reg.frozen_seq("s1"), None);

        // 重复申请被拒绝
        assert_eq!(
            reg.begin_freezing("s1", "tok-other", 5000),
            Err(FreezeError::AlreadyFrozen {
                token: "tok-two-phase".into()
            })
        );

        // 步骤 2：收敛完成，确立物理序号上界
        let reserved = reg
            .lock_frozen_sequence("s1", "tok-two-phase", 100)
            .unwrap();
        assert_eq!(reserved, 101);
        assert!(reg.is_strictly_frozen("s1"));
        assert_eq!(reg.frozen_seq("s1"), Some(100));
        assert_eq!(reg.truncate_reserved_seq("s1"), Some(101));

        // 释放
        reg.release("s1", "tok-two-phase").unwrap();
        assert!(!reg.is_frozen("s1"));
    }

    /// 严格物理上界与事件写门禁：彻底拔除 RunTerminal / AgentEnd 越界后门
    #[test]
    fn strict_physical_boundary_blocks_run_terminal_and_agent_end() {
        let reg = SessionFreezeRegistry::new();
        let frozen_seq = 50;
        let truncate_seq = 51;
        let token = "tok-strict";
        reg.freeze("s1", token, frozen_seq).unwrap();

        // 1. 历史序号（seq <= frozen_seq）放行
        assert_eq!(
            reg.check_event_write("s1", &agent_start(), 50, None),
            WriteVerdict::Allow
        );

        // 2. 越界写入（seq > frozen_seq）的 RunTerminal 必须被刚性阻断！彻底拔除白名单后门
        assert_eq!(
            reg.check_event_write("s1", &terminal_event(), 51, None),
            WriteVerdict::Reject { frozen_seq }
        );
        assert_eq!(
            reg.check_event_write("s1", &terminal_event(), 51, Some(token)),
            WriteVerdict::Reject { frozen_seq },
            "即使携带 Token，RunTerminal 也绝对不允许越过 frozen_seq"
        );

        // 3. 越界写入（seq > frozen_seq）的 AgentEnd 同样必须被刚性阻断！
        assert_eq!(
            reg.check_event_write("s1", &agent_end_event(), 51, Some(token)),
            WriteVerdict::Reject { frozen_seq }
        );

        // 4. 普通事件越界阻断
        assert_eq!(
            reg.check_event_write("s1", &agent_start(), 51, None),
            WriteVerdict::Reject { frozen_seq }
        );

        // 5. 唯一放行的越界写入：携带合法 Token 且 proposed_seq == frozen_seq + 1 的 TimelineTruncate
        assert_eq!(
            reg.check_event_write("s1", &truncate_event(frozen_seq), truncate_seq, Some(token)),
            WriteVerdict::Allow,
            "合法 Token 的 TimelineTruncate 允许写入 frozen_seq + 1"
        );

        // 6. TimelineTruncate 携带错误 Token 或错误序列号均被拒绝
        assert_eq!(
            reg.check_event_write(
                "s1",
                &truncate_event(frozen_seq),
                truncate_seq,
                Some("wrong-token")
            ),
            WriteVerdict::Reject { frozen_seq },
            "错误 Token 的 TimelineTruncate 必须被拒绝"
        );
        assert_eq!(
            reg.check_event_write("s1", &truncate_event(frozen_seq), truncate_seq, None),
            WriteVerdict::Reject { frozen_seq },
            "未携带 Token 的 TimelineTruncate 必须被拒绝"
        );
        assert_eq!(
            reg.check_event_write("s1", &truncate_event(frozen_seq), 52, Some(token)),
            WriteVerdict::Reject { frozen_seq },
            "序列号不等于 frozen_seq + 1 的 TimelineTruncate 必须被拒绝"
        );
    }

    /// 第一阶段 Freezing 状态下的事件门禁校验
    #[test]
    fn freezing_phase_allows_only_terminal_for_convergence() {
        let reg = SessionFreezeRegistry::new();
        reg.begin_freezing("s1", "tok-stage1", 5000).unwrap();

        // 终态事件在收敛期放行（以让正在运行的 run 安全收尾）
        assert_eq!(
            reg.check_event_write("s1", &terminal_event(), 10, None),
            WriteVerdict::Allow
        );
        assert_eq!(
            reg.check_event_write("s1", &agent_end_event(), 10, None),
            WriteVerdict::Allow
        );

        // 非终态事件在收敛期被阻断
        assert_eq!(
            reg.check_event_write("s1", &agent_start(), 10, None),
            WriteVerdict::Reject { frozen_seq: 0 }
        );
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

    /// 撤离事件判定：彻底拔除 RunTerminal 与 AgentEnd 白名单！
    /// 唯一撤离事件必须且只能是 TimelineTruncate
    #[test]
    fn evacuation_event_classification() {
        assert!(is_retraction_evacuation_event(&truncate_event(42)));
        // 拔除后门：RunTerminal 绝不再是撤离事件
        assert!(
            !is_retraction_evacuation_event(&terminal_event()),
            "RunTerminal 白名单后门必须已被拔除"
        );
        // 拔除后门：AgentEnd 绝不再是撤离事件
        assert!(
            !is_retraction_evacuation_event(&agent_end_event()),
            "AgentEnd 白名单后门必须已被拔除"
        );
        assert!(!is_retraction_evacuation_event(&agent_start()));
    }
}
