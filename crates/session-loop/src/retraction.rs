//! 撤回协议（统一输入流收敛战役 R1 · 详案 §1.2 六步 ②③）
//!
//! # 冻结协议（评审 01 ②#2 最大逻辑漏洞的落地）
//!
//! `prepare_retraction` 是「先停后截」的**原子**编排（一次串行事务）：
//!
//! ```
//! 1. [校验] 会话存在、target 可定位 → boundary_candidate = resolve_boundary_seq
//!    找不到 → Err(NotFound)，不进入冻结（fail-closed，不半冻结）
//! 2. [停 run] 对会话运行中 run 投 L3 force_cancel（reason="retraction:<seq>"）
//!    并行对会话 running 子代理 kill_all（同一撤回边界）
//! 3. [收敛] 等待 run 终态事件收敛（run-terminal / run-cancelled 确认）——
//!    稳定点后仍可写入的只剩 run 收口路径内事件（消息增量收口 / 工具批
//!    收口 / 终态事件），run-terminal 后自然停写
//! 4. [冻结读 max seq] 稳定点上读会话 events 表 MAX(sequence) = frozen_seq
//!    （本撤回事务内不会再被任何事件超过的边界）
//! 5. [发 truncate] push AgentEvent::TimelineTruncate { boundary_seq: frozen_seq }
//!    ——自身占 sequence = frozen_seq + 1（TimelineTruncate.sequence > boundary_seq，
//!    T1 §1.2a 不变量）
//! 6. [冻结完成] truncate 落库确认后释放冻结；此后新写入（若因并发残余
//!    产生）由冻结护栏拒绝或归新 run（新 run 天然从 boundary 后开始）
//! ```
//!
//! # 依赖注入（扩展点 D 承载，不进核心循环）
//!
//! 协议本体不持有 DB / 控制总线 / 事件队列——经 [RetractionBackend] 注入
//! （壳层组合根装配，见 apps/agent-workbench/src-tauri/src/retraction_commands.rs）。
//! 令牌互斥（FREEZE3）与冻结护栏（FREEZE1）由 [SessionFreezeRegistry] 承载。
//!
//! # 终态语义（决策 7 结论）
//!
//! 撤回投影/前端 UI 以事件流 `cancelled` 为准；`session_agents` 表 row
//! `failed` 为已知双写约定（lifecycle.rs kill_all 行归一），本协议不改
//! row 归一（避免与 P1/R2 争写 orchestrator），恢复/审计读 session_agents
//! 时以事件 cancelled 校准。

use async_trait::async_trait;

use crate::freeze::SessionFreezeRegistry;
use conex_types::events::{AgentEvent, TimelineTruncateReason};

/// 撤回协议后端依赖（由壳层组合根实现；测试用内存替身）
#[async_trait]
pub trait RetractionBackend: Send + Sync {
    /// 反查 user 消息起始 seq（events 表 `message-start` 最新一条，
    /// envelope payload 内 `message.id == target_message_id`）
    async fn resolve_boundary_seq(
        &self,
        session_id: &str,
        target_message_id: &str,
    ) -> Result<Option<u64>, RetractionError>;

    /// 会话当前已落库最大 sequence（冻结读点）
    async fn session_max_sequence(&self, session_id: &str) -> Result<u64, RetractionError>;

    /// 对会话运行中 run 投 L3 force_cancel（reason=`retraction:<boundary_seq>`）
    /// 并 kill_all running 子代理；返回被收场的 run_id（无运行中 run → None）
    async fn stop_run(
        &self,
        session_id: &str,
        boundary_seq: u64,
    ) -> Result<Option<String>, RetractionError>;

    /// 等待该 run 终态收敛（run-terminal cancelled 落库确认）；超时 Err
    async fn wait_converged(
        &self,
        session_id: &str,
        run_id: Option<&str>,
    ) -> Result<(), RetractionError>;

    /// 发射 TimelineTruncate（Critical + Persist 必达落库）；返回落库 sequence
    async fn push_timeline_truncate(
        &self,
        session_id: &str,
        run_id: Option<&str>,
        boundary_seq: u64,
        target_message_id: &str,
    ) -> Result<u64, RetractionError>;
}

/// 撤回协议错误（fail-closed：不进入冻结即返回，不半冻结）
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RetractionError {
    /// target 在会话事件流中不可定位（乐观 id 未水合为持久 id / 已不存在）
    NotFound,
    /// 会话已有生效撤回事务（FREEZE3 互斥）
    Busy,
    /// 后端依赖失败
    Backend(String),
    /// stop 收敛超时（终态事件未在窗口内确认）
    ConvergeTimeout,
    /// 冻结护栏拒绝（冻结激活期越界写入——协议自身不应触发，防御性兜底）
    Frozen,
}

impl std::fmt::Display for RetractionError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            RetractionError::NotFound => {
                write!(f, "撤回目标消息在会话事件流中不可定位")
            }
            RetractionError::Busy => write!(f, "会话已有生效撤回事务，并发撤回被拒绝"),
            RetractionError::Backend(msg) => write!(f, "撤回后端依赖失败：{msg}"),
            RetractionError::ConvergeTimeout => write!(f, "stop 收敛超时（终态事件未确认）"),
            RetractionError::Frozen => write!(f, "冻结护栏拒绝越界写入"),
        }
    }
}

impl std::error::Error for RetractionError {}

/// 撤回事务结果
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RetractionOutcome {
    /// 冻结边界 = 事件流停止写入点（== boundary user 节点起始 seq）
    pub boundary_seq: u64,
    /// TimelineTruncate 自身落库 sequence（== frozen_seq + 1）
    pub truncate_sequence: u64,
    /// 被撤回收场的 run id（无运行中 run 时为 None）
    pub run_id: Option<String>,
    /// 撤回目标 user 消息稳定 id
    pub target_message_id: String,
}

/// 撤回协议（无状态编排器；令牌互斥 + 冻结护栏经注册表注入）
pub struct RetractionProtocol {
    backend: Box<dyn RetractionBackend>,
    freeze: std::sync::Arc<SessionFreezeRegistry>,
}

/// 收敛等待窗口（stop 收敛级：L3 强停 ≤ 下一安全点；毫秒）
pub const CONVERGE_TIMEOUT_MS: u64 = 15_000;

impl RetractionProtocol {
    /// 装配协议（backend 由壳层注入；注册表为协议私有实例）
    pub fn new(backend: Box<dyn RetractionBackend>) -> Self {
        Self {
            backend,
            freeze: std::sync::Arc::new(SessionFreezeRegistry::new()),
        }
    }

    /// 装配协议并注入**共享**冻结注册表（壳层组合根：与 EventQueue 写侧
    /// 护栏同实例——冻结激活/释放与写侧拒绝走同一会话级状态）
    pub fn with_freeze_registry(
        backend: Box<dyn RetractionBackend>,
        freeze: std::sync::Arc<SessionFreezeRegistry>,
    ) -> Self {
        Self { backend, freeze }
    }

    /// 会话级冻结注册表（写侧护栏挂载面：orchestrator EventQueue 注入
    /// 同一实例；测试可直接断言冻结态）
    pub fn freeze_registry(&self) -> &SessionFreezeRegistry {
        &self.freeze
    }
    /// 撤回事务令牌（单会话互斥凭据；同会话并发撤回 → 第二次 Busy）
    fn token(session_id: &str) -> String {
        format!("retraction:{session_id}")
    }

    /// 执行撤回（六步 ②③：停 run → 收敛 → 冻结 → truncate → 释放）
    ///
    /// 原子性论证（详案 §1.2-③）：
    /// - 冻结登记与 truncate push 之间无 await 缺口可被同会话其它写入
    ///   利用（读 MAX 后先 freeze 再 push；push 经护栏校验自身为撤离
    ///   事件放行）；
    /// - events 表 reserve 用 MAX 语义只抬高不回退，boundary_seq 是历史
    ///   序列上限，不可能被回退覆盖；
    /// - 前端投影重放「只到 boundary_seq」与事件流只追加天然自洽。
    pub async fn prepare_retraction(
        &self,
        session_id: &str,
        target_message_id: &str,
    ) -> Result<RetractionOutcome, RetractionError> {
        // 1. 定位（fail-closed：找不到不进入冻结）
        let boundary = self
            .backend
            .resolve_boundary_seq(session_id, target_message_id)
            .await?
            .ok_or(RetractionError::NotFound)?;

        // 2. 令牌互斥（FREEZE3：并发双重撤回 → 第二个拒绝，不双写边界）
        let token = Self::token(session_id);
        if self.freeze.is_frozen(session_id) {
            return Err(RetractionError::Busy);
        }

        // 3. 停 run（L3 force_cancel reason=retraction:<seq>）+ kill_all 子代理
        let run_id = self.backend.stop_run(session_id, boundary).await?;

        // 4. 收敛等待（run-terminal cancelled 确认；L3 强停 ≤ 下一安全点）
        self.backend
            .wait_converged(session_id, run_id.as_deref())
            .await?;

        // 5. 冻结读点：稳定点 MAX(sequence)
        let frozen_seq = self.backend.session_max_sequence(session_id).await?;

        // 6. 激活冻结（同一会话锁区：登记 → push 无竞态缺口）
        self.freeze
            .freeze(session_id, &token, frozen_seq)
            .map_err(|_| RetractionError::Busy)?;

        // 7. 发 truncate（撤离事件放行；自身占 sequence = frozen_seq + 1）
        let truncate_sequence = self
            .backend
            .push_timeline_truncate(session_id, run_id.as_deref(), frozen_seq, target_message_id)
            .await
            .map_err(|err| {
                // truncate 落库失败：释放冻结（不残留半冻结态），返回后端错误
                let _ = self.freeze.release(session_id, &token);
                err
            })?;

        // 8. 冻结完成：truncate 落库确认后释放
        self.freeze
            .release(session_id, &token)
            .map_err(|_| RetractionError::Backend("冻结释放失败（令牌不匹配）".into()))?;

        Ok(RetractionOutcome {
            boundary_seq: frozen_seq,
            truncate_sequence,
            run_id,
            target_message_id: target_message_id.to_string(),
        })
    }

    /// 构造 TimelineTruncate 事件（协议与测试共用；`run_id` 与信封
    /// runId 同值——撤回收场的 run，无运行中 run 时为 None）
    pub fn build_truncate_event(
        session_id: &str,
        run_id: Option<&str>,
        boundary_seq: u64,
        target_message_id: &str,
        timestamp: &str,
    ) -> AgentEvent {
        AgentEvent::TimelineTruncate {
            session_id: session_id.to_string(),
            run_id: run_id.unwrap_or_default().to_string(),
            boundary_seq,
            reason: TimelineTruncateReason::UserRequested,
            target_message_id: target_message_id.to_string(),
            timestamp: timestamp.to_string(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::sync::{Arc, Mutex};

    /// 内存后端替身：记录协议调用序列，模拟边界定位 / MAX 读 / truncate
    struct FakeBackend {
        boundary: Option<u64>,
        max_seq: u64,
        calls: Mutex<Vec<String>>,
        truncate_seq: AtomicU64,
        converge_ok: bool,
    }

    impl FakeBackend {
        fn new(boundary: Option<u64>, max_seq: u64) -> Self {
            Self {
                boundary,
                max_seq,
                calls: Mutex::new(Vec::new()),
                truncate_seq: AtomicU64::new(0),
                converge_ok: true,
            }
        }
        fn calls(&self) -> Vec<String> {
            self.calls.lock().unwrap().clone()
        }
    }

    #[async_trait]
    impl RetractionBackend for Arc<FakeBackend> {
        async fn resolve_boundary_seq(
            &self,
            _session_id: &str,
            _target_message_id: &str,
        ) -> Result<Option<u64>, RetractionError> {
            self.calls.lock().unwrap().push("resolve".into());
            Ok(self.boundary)
        }
        async fn session_max_sequence(
            &self,
            _session_id: &str,
        ) -> Result<u64, RetractionError> {
            self.calls.lock().unwrap().push("max".into());
            Ok(self.max_seq)
        }
        async fn stop_run(
            &self,
            _session_id: &str,
            boundary_seq: u64,
        ) -> Result<Option<String>, RetractionError> {
            self.calls
                .lock()
                .unwrap()
                .push(format!("stop:{boundary_seq}"));
            Ok(Some("run-1".into()))
        }
        async fn wait_converged(
            &self,
            _session_id: &str,
            run_id: Option<&str>,
        ) -> Result<(), RetractionError> {
            self.calls
                .lock()
                .unwrap()
                .push(format!("converge:{}", run_id.unwrap_or_default()));
            if self.converge_ok {
                Ok(())
            } else {
                Err(RetractionError::ConvergeTimeout)
            }
        }
        async fn push_timeline_truncate(
            &self,
            _session_id: &str,
            run_id: Option<&str>,
            boundary_seq: u64,
            _target_message_id: &str,
        ) -> Result<u64, RetractionError> {
            self.calls
                .lock()
                .unwrap()
                .push(format!("truncate:{boundary_seq}:{run_id:?}"));
            // TimelineTruncate 自身占 sequence = frozen_seq + 1
            let seq = boundary_seq + 1;
            self.truncate_seq.store(seq, Ordering::SeqCst);
            Ok(seq)
        }
    }

    /// FREEZE2：冻结原子性——boundary_seq == 事件流停止写入点（稳定点
    /// MAX），TimelineTruncate.sequence == boundary_seq + 1；协议调用
    /// 顺序 = resolve → stop → converge → max → truncate
    #[tokio::test]
    async fn protocol_freezes_at_max_and_truncates_at_boundary_plus_one() {
        let backend = Arc::new(FakeBackend::new(Some(40), 99));
        let protocol = RetractionProtocol::new(Box::new(backend.clone()));
        let outcome = protocol
            .prepare_retraction("s1", "msg-1")
            .await
            .unwrap();
        assert_eq!(outcome.boundary_seq, 99, "冻结边界 = 稳定点 MAX(sequence)");
        assert_eq!(
            outcome.truncate_sequence, 100,
            "TimelineTruncate.sequence == frozen_seq + 1（T1 §1.2a 不变量）"
        );
        assert_eq!(
            backend.calls(),
            vec!["resolve", "stop:40", "converge:run-1", "max", "truncate:99:Some(\"run-1\")"],
            "协议调用顺序 = 定位 → 停 run → 收敛 → 冻结读 → truncate"
        );
        // 冻结已释放（truncate 落库确认后）
        assert!(!protocol.freeze_registry().is_frozen("s1"));
    }

    /// 定位失败 → 不进入冻结（fail-closed，不半冻结）
    #[tokio::test]
    async fn protocol_fails_closed_when_target_not_found() {
        let backend = Arc::new(FakeBackend::new(None, 99));
        let protocol = RetractionProtocol::new(Box::new(backend.clone()));
        let err = protocol.prepare_retraction("s1", "missing").await.unwrap_err();
        assert_eq!(err, RetractionError::NotFound);
        assert_eq!(backend.calls(), vec!["resolve"], "定位失败后不再进入停 run/冻结");
        assert!(!protocol.freeze_registry().is_frozen("s1"));
    }

    /// 收敛超时 → 错误返回且不残留冻结
    #[tokio::test]
    async fn protocol_converge_timeout_leaves_no_freeze() {
        let mut backend = FakeBackend::new(Some(1), 5);
        backend.converge_ok = false;
        let backend = Arc::new(backend);
        let protocol = RetractionProtocol::new(Box::new(backend));
        let err = protocol
            .prepare_retraction("s1", "msg-1")
            .await
            .unwrap_err();
        assert_eq!(err, RetractionError::ConvergeTimeout);
        assert!(!protocol.freeze_registry().is_frozen("s1"));
    }

    /// FREEZE3（协议级）：同会话并发双重撤回 → 第二个 Busy，不双写边界；
    /// 事务完成后可再次撤回
    #[tokio::test]
    async fn concurrent_retractions_are_mutually_exclusive() {
        let backend = Arc::new(FakeBackend::new(Some(40), 99));
        let protocol = RetractionProtocol::new(Box::new(backend.clone()));
        // 第一个事务成功
        protocol.prepare_retraction("s1", "msg-1").await.unwrap();
        // 模拟第二个事务与第一个重叠：冻结激活期进入 → Busy
        let token = "retraction:s1";
        protocol.freeze_registry().freeze("s1", token, 99).unwrap();
        let err = protocol.prepare_retraction("s1", "msg-2").await.unwrap_err();
        assert_eq!(err, RetractionError::Busy, "冻结期内并发撤回拒绝");
        protocol.freeze_registry().release("s1", token).unwrap();
        // 释放后新事务可进入（不残留互斥）
        let outcome = protocol.prepare_retraction("s1", "msg-2").await.unwrap();
        assert_eq!(outcome.target_message_id, "msg-2");
    }
}
