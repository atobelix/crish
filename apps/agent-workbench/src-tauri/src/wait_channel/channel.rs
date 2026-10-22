//! WaitChannel：SubagentWaitChannel 契约引擎侧实现（自 wait_channel.rs 原样搬迁）

use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use agent_tools::tools::subagent::SubagentState;
use agent_tools::tools::wait_subagents::{
    wait_for_terminal_events, DispatchDeclaration, SubagentOutput, SubagentWaitChannel,
    SubagentWaitError, SubagentWaitResult, SubagentWaitStatus,
};
use async_trait::async_trait;

use super::broadcast::EventStreamBroadcast;
use super::{now_ms, ControlBusResolver, SubagentStatusSource, WaitStore};

// ── WaitChannel（SubagentWaitChannel 契约实现）─────────────────────

/// 子代理等待通道（引擎侧实现 [SubagentWaitChannel] 四方法；
/// 适配器由引擎装配注入，见模块头注记）
pub struct WaitChannel {
    /// dispatch 声明持久化（wait 落库 / 分发基准恢复）
    store: Arc<dyn WaitStore>,
    /// 会话子代理状态行（snapshot 数据源）
    agents: Arc<dyn SubagentStatusSource>,
    /// subagent-ended 事件流广播（wait_for_terminal 订阅面）
    terminal_stream: Arc<EventStreamBroadcast>,
    /// 目标 run 控制总线解析（inject 面）
    control_bus: Arc<dyn ControlBusResolver>,
}

impl WaitChannel {
    /// 新建等待通道（适配器由装配方注入）
    pub fn new(
        store: Arc<dyn WaitStore>,
        agents: Arc<dyn SubagentStatusSource>,
        terminal_stream: Arc<EventStreamBroadcast>,
        control_bus: Arc<dyn ControlBusResolver>,
    ) -> Self {
        Self {
            store,
            agents,
            terminal_stream,
            control_bus,
        }
    }
}

impl std::fmt::Debug for WaitChannel {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("WaitChannel").finish_non_exhaustive()
    }
}

#[async_trait]
impl SubagentWaitChannel for WaitChannel {
    /// 持久化调度声明（dispatch_* session_meta 键；watchdog 与重启恢复
    /// 的共享数据面）
    async fn persist_declaration(
        &self,
        declaration: &DispatchDeclaration,
    ) -> Result<(), SubagentWaitError> {
        self.store.save(declaration);
        tracing::info!(
            target: "wait_channel",
            mode = declaration.mode.as_str(),
            subagent_ids = ?declaration.subagent_ids,
            dispatched_at_ms = declaration.dispatched_at_ms,
            "调度声明已持久化（dispatch_* 键）"
        );
        Ok(())
    }

    /// 持久化各子代理产出清单（`dispatch_outputs` 键；G02 完成通知字段
    /// 的持久化副本，重启后恢复「各子代理产出」）
    async fn persist_outputs(
        &self,
        outputs: &HashMap<String, Vec<SubagentOutput>>,
    ) -> Result<(), SubagentWaitError> {
        // 失败 → PersistFailed（内存实现不触发；未来 conex-db 适配面）
        self.store.save_outputs(outputs)?;
        tracing::info!(
            target: "wait_channel",
            count = outputs.len(),
            "各子代理产出清单已持久化（dispatch_outputs 键）"
        );
        Ok(())
    }

    /// 非阻塞快照：读会话子代理状态行（session_agents）返回
    /// [SubagentWaitStatus] 摘要列表（按入参顺序）。
    ///
    /// 行缺失的 id 按运行中返回（fail-open，对齐 EventStreamChannel 测试
    /// 替身语义 wait_subagents.rs:700-714）；状态经 `from_db_status` 读回
    /// 归一（stopped → failed）。
    async fn snapshot(
        &self,
        subagent_ids: &[String],
    ) -> Result<Vec<SubagentWaitStatus>, SubagentWaitError> {
        let now = now_ms();
        let rows = self.agents.load_agents();
        Ok(subagent_ids
            .iter()
            .map(|id| {
                let Some(row) = rows.iter().find(|row| &row.id == id) else {
                    return SubagentWaitStatus {
                        subagent_id: id.clone(),
                        status: SubagentState::Running,
                        summary: None,
                        elapsed_ms: 0,
                        terminal: false,
                    };
                };
                let state = SubagentState::from_db_status(&row.status);
                let elapsed_ms = now.saturating_sub(row.started_at.max(0) as u64);
                SubagentWaitStatus {
                    subagent_id: id.clone(),
                    status: state,
                    summary: row.summary.clone(),
                    elapsed_ms,
                    terminal: matches!(state, SubagentState::Completed | SubagentState::Failed),
                }
            })
            .collect())
    }

    /// 事件驱动阻塞等待：订阅 subagent-ended 事件流（EventQueue 旁路
    /// 适配），映射为 [SubagentTerminalEvent] 灌入 mpsc，复用
    /// [wait_for_terminal_events] 同构消费；超时返回 [SubagentWaitResult]
    /// （timed_out + 未完成列表）。
    ///
    /// 订阅生命周期：本次调用期间订阅、返回后取消——接收端随本函数
    /// 退出 drop，广播侧自动断流（T-CF-10 内容 2）。
    async fn wait_for_terminal(
        &self,
        subagent_ids: &[String],
        timeout_ms: Option<u64>,
    ) -> Result<SubagentWaitResult, SubagentWaitError> {
        // 分发基准时刻：从已持久化声明恢复（与 watchdog 同一数据面；
        // 缺失时以当前时刻兜底，elapsed 从 0 起算）
        let dispatched_at_ms = self
            .store
            .load_all()
            .iter()
            .filter(|d| d.subagent_ids.iter().any(|id| subagent_ids.contains(id)))
            .map(|d| d.dispatched_at_ms)
            .max()
            .unwrap_or_else(now_ms);
        let rx = self.terminal_stream.subscribe();
        Ok(wait_for_terminal_events(
            subagent_ids,
            rx,
            timeout_ms.map(Duration::from_millis),
            dispatched_at_ms,
        )
        .await)
    }

    /// 运行中注入：经目标 run 的 [ControlBus::request_subagent_inject]
    /// （L1 steer 环，transfer 语义，不打断子代理执行）。
    ///
    /// 目标 run 不可达（活动注册表未接线 / 无活动 run）→ 结构化
    /// InjectFailed（装配失败降级，不阻塞等待主流程）。
    async fn inject(&self, subagent_id: &str, prompt: &str) -> Result<(), SubagentWaitError> {
        let Some(bus) = self.control_bus.control_bus(subagent_id) else {
            return Err(SubagentWaitError::InjectFailed(format!(
                "目标子代理 {subagent_id} 的 run 控制总线不可达（活动 run 注册表未接线）"
            )));
        };
        // std Mutex 不跨 await 持有：注入为同步调用，锁在语句内释放
        bus.lock()
            .unwrap_or_else(|e| e.into_inner())
            .request_subagent_inject(subagent_id, prompt, Some("wait_channel"));
        tracing::info!(
            target: "wait_channel",
            subagent_id,
            "运行中注入已送达目标 run 的 L1 steer 环"
        );
        Ok(())
    }
}
