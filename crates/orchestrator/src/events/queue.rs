//! 事件队列：sequence 分配 + 持久化分流（B4.2，自 events.rs 纯搬迁）

use std::sync::Arc;

use conex_types::events::{AgentEvent, AgentEventEnvelope};
use session_loop::{is_retraction_evacuation_event, SessionFreezeRegistry};

use super::{event_type_name, is_non_persistent, PersistError, SequencedEvent};
use crate::normalize::normalize_envelope;
use crate::persist::{SessionSequencer, Store, StoreError};

/// 事件队列（B4.2：sequence 分配 + 持久化分流）
///
/// 每个事件入队分配连续 sequence（会话内由 store 端原子计数器取号，
/// T08.12 Q23：会话内全局单调、跨 run 不重置，防并发 run 冲突）；
/// 非持久化事件直接返回不落库（delta 不阻塞 drive loop）；持久化事件
/// 同步等待 store 落库（approval-requested 等中间态事件返回时已可观测）。
pub struct EventQueue {
    /// 会话级 sequence 分配器（T08.12：实际取号走 store 端原子计数器）
    sequencer: SessionSequencer,
    /// 最近一次已成功分配序列的本地镜像（仅供 `next_sequence` 观测）。
    /// 取号失败不推进——store 端 `reserve_sequence` 是唯一真源。
    last_reserved: u64,
    /// run 归属（构造期绑定，不可变；None = 会话域/空闲态事件，
    /// D-01 R-02：写面注入 = 构造期绑定，非 push 逐次传参）
    run_id: Option<String>,
    /// R1 撤回边界冻结护栏（会话级注册表；None = 未挂载，无冻结检查）。
    /// 冻结激活期内拒绝 `> frozen_seq` 的非撤离写入（详案 §1.2-③），
    /// 由壳层撤回命令在 stop 收敛后激活、truncate 落库后释放。
    freeze: Option<Arc<SessionFreezeRegistry>>,
}

impl EventQueue {
    /// 新建队列（base_sequence 为期望的首事件序列）。
    ///
    /// `run_id` 为构造期绑定的 run 归属（None = 会话域事件，如空闲态
    /// compact-now / task 域审计事件）：所有落库事件的信封 runId 与
    /// events.run_id 列均以该值为准（goal-* 轮次域事件特判除外）。
    ///
    /// T08.12 起**实际分配由 store 端会话级原子计数器决定**（防同会话
    /// 并发 run 取到相同序列），base 仅作本地镜像初值；events.rs 测试内
    /// `run.cursor + 1` 构造模式为**测试专用**（保留兼容，生产路径经
    /// base_sequence_for 预热后首事件仍命中该值）。
    pub fn new(store: Arc<dyn Store>, base_sequence: u64, run_id: Option<String>) -> Self {
        Self {
            sequencer: SessionSequencer::new(store),
            last_reserved: base_sequence.saturating_sub(1),
            run_id,
            freeze: None,
        }
    }

    /// 挂载撤回冻结护栏（R1：壳层撤回命令在组合根为会话内全部队列注入
    /// 同一注册表；默认不挂载，既有调用面零改动）
    pub fn with_freeze_registry(mut self, freeze: Arc<SessionFreezeRegistry>) -> Self {
        self.freeze = Some(freeze);
        self
    }

    /// 下一个待分配的序列号（本地镜像，仅供观测/断言；实际分配在 store 端）
    pub fn next_sequence(&self) -> u64 {
        self.last_reserved + 1
    }

    /// 共享 store
    pub fn store(&self) -> &dyn Store {
        self.sequencer.store()
    }

    /// 会话级分配器（T08.8 seed 预热 / 校准入口）
    pub fn sequencer(&self) -> &SessionSequencer {
        &self.sequencer
    }

    /// goal-* 三事件归**轮次域**（D-01 R-06，裁决 C-2 采纳 04 PC-07）：
    /// 不归任何 run，落库 run_id 列与信封 runId 均置 None，run 查询
    /// 天然不命中。
    fn is_round_domain_event(event: &AgentEvent) -> bool {
        matches!(
            event,
            AgentEvent::GoalRoundStarted { .. }
                | AgentEvent::GoalRoundCompleted { .. }
                | AgentEvent::GoalContinuationDecided { .. }
        )
    }

    /// 落库信封统一构造（D-01 DM-04：normalize_envelope 真接线点——
    /// 名义统一注入点 → 实际注入点，消灭与实现的漂移）。
    ///
    /// 返回（有效 run_id 列值，完整信封）：信封 runId/sequence 经
    /// normalize_envelope 注入（与广播 wire 同构扁平 JSON），goal-*
    /// 轮次域事件信封 runId 与列值均置 None。
    fn persist_envelope(
        &self,
        session_id: &str,
        sequence: u64,
        event: &AgentEvent,
    ) -> (Option<String>, AgentEventEnvelope) {
        let effective_run_id = if Self::is_round_domain_event(event) {
            None
        } else {
            self.run_id.as_deref()
        };
        let envelope = normalize_envelope(
            AgentEventEnvelope::new(
                event.clone(),
                effective_run_id.map(str::to_string),
                Some(sequence),
            ),
            effective_run_id,
            session_id,
        );
        (effective_run_id.map(str::to_string), envelope)
    }

    /// 从会话级原子计数器取号（T08.12）。store 是唯一真源：成功才回写
    /// 本地镜像；失败不推进、不本地瞎加（取号失败即持久化失败）。
    async fn reserve(&mut self, session_id: &str) -> Result<u64, StoreError> {
        let sequence = self.sequencer.reserve(session_id).await?;
        self.last_reserved = sequence;
        Ok(sequence)
    }

    /// 入队并分配 sequence；持久化事件同步等待落库（delta 不阻塞）
    ///
    /// **NoPersist-first（T-D1-A / U-NOPE / D1-E1 / INV-2）**：非持久化
    /// 事件在 `reserve` **之前**直接返回——不调用 `reserve` /
    /// `store.reserve_sequence`，不消耗会话计数器序列槽；`sequence` 字段
    /// 取本地镜像 `last_reserved`（不推进）。持久化事件仍走 store 端
    /// 原子取号 + 同步落库。
    pub async fn push(
        &mut self,
        session_id: &str,
        event: AgentEvent,
    ) -> Result<SequencedEvent, PersistError> {
        // NoPersist-first（T-D1-A）：delta 在取号前分流——0 次 reserve，
        // 不阻塞 drive loop（05 §2.8 语义不变；旧路径 reserve-then-NOPersist
        // 白付取号已删）。sequence = last_reserved（不推进计数器）；调用面
        // （drive_outcome）禁止因 NoPersist 把 run.cursor 改回更小值。
        if is_non_persistent(&event) {
            return Ok(SequencedEvent {
                sequence: self.last_reserved,
                event,
                persisted: false,
            });
        }
        // R1 边界冻结护栏（详案 §1.2-③ FREEZE1）：冻结激活期内拒绝
        // 非撤离写入——**取号前拦截**（冻结读点后计数器恒 > frozen_seq，
        // 不消耗序列槽：TimelineTruncate 恰好占 frozen_seq + 1，无空洞）。
        // 撤离事件（timeline-truncate 自身 / run 收口终态）放行；拒绝返回
        // 可判定的 [PersistError::is_retraction_freeze]（调用面按冻结拒绝
        // 语义处置，不标记 run failed）
        if let Some(registry) = &self.freeze {
            if registry.is_frozen(session_id) && !is_retraction_evacuation_event(&event) {
                if let Some(frozen_seq) = registry.frozen_seq(session_id) {
                    return Err(PersistError::retraction_freeze(
                        self.last_reserved + 1,
                        frozen_seq,
                        event_type_name(&event),
                    ));
                }
            }
        }
        // T08.12：sequence 由会话级原子计数器分配（store 端单语句自增，
        // 会话内全局单调，防同会话并发 run 冲突）——仅持久化事件走到此处
        let sequence = match self.reserve(session_id).await {
            Ok(sequence) => sequence,
            Err(error) => {
                // 取号失败：未消耗序列槽，错误携带上次成功号供观测
                return Err(PersistError {
                    sequence: self.last_reserved,
                    event_type: event_type_name(&event).to_string(),
                    error,
                });
            }
        };
        let event_type = event_type_name(&event);
        let (run_id, envelope) = self.persist_envelope(session_id, sequence, &event);
        let payload = serde_json::to_string(&envelope).map_err(|err| PersistError {
            sequence,
            event_type: event_type.to_string(),
            error: StoreError::new("serialize_event", err.to_string()),
        })?;
        self.store()
            .append_event(
                session_id,
                sequence,
                event_type,
                &payload,
                run_id.as_deref(),
            )
            .await
            .map_err(|error| PersistError {
                sequence,
                event_type: event_type.to_string(),
                error,
            })?;
        Ok(SequencedEvent {
            sequence,
            event,
            persisted: true,
        })
    }

    /// 终态事件尽力落库（store 已坏时不假装可回放；失败仍返回事件）。
    ///
    /// 取号只走 store `reserve_sequence`：首次失败再重试一次。重试仍失败
    /// 则不落库、不推进本地镜像（不是第二条序号生成器）。
    pub async fn push_terminal_best_effort(
        &mut self,
        session_id: &str,
        event: AgentEvent,
    ) -> SequencedEvent {
        let sequence = match self.reserve(session_id).await {
            Ok(sequence) => sequence,
            Err(_) => match self.store().reserve_sequence(session_id).await {
                Ok(sequence) => {
                    self.last_reserved = sequence;
                    sequence
                }
                Err(_) => {
                    return SequencedEvent {
                        sequence: self.last_reserved,
                        event,
                        persisted: false,
                    };
                }
            },
        };
        let event_type = event_type_name(&event);
        let (run_id, envelope) = self.persist_envelope(session_id, sequence, &event);
        let payload = serde_json::to_string(&envelope).ok();
        let persisted = match payload {
            Some(payload) => self
                .store()
                .append_event(
                    session_id,
                    sequence,
                    event_type,
                    &payload,
                    run_id.as_deref(),
                )
                .await
                .is_ok(),
            None => false,
        };
        SequencedEvent {
            sequence,
            event,
            persisted,
        }
    }

    /// 以指定序列号尽力落库（终态重发用：复用已失败的序列号，保持序列
    /// 连续性与终态唯一性；不重复取号）
    pub(super) async fn push_at_best_effort(
        &mut self,
        session_id: &str,
        event: AgentEvent,
        sequence: u64,
    ) -> SequencedEvent {
        let event_type = event_type_name(&event);
        let (run_id, envelope) = self.persist_envelope(session_id, sequence, &event);
        let payload = serde_json::to_string(&envelope).ok();
        let persisted = match payload {
            Some(payload) => self
                .store()
                .append_event(
                    session_id,
                    sequence,
                    event_type,
                    &payload,
                    run_id.as_deref(),
                )
                .await
                .is_ok(),
            None => false,
        };
        SequencedEvent {
            sequence,
            event,
            persisted,
        }
    }
}
