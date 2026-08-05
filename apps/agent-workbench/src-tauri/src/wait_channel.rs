//! 子代理等待通道（G4 / REQ-C05；T-CF-10，R-CF3）
//!
//! 职责（02-CF 方案 §4.2 / 7.4 T-CF-10）：
//! - [WaitChannel]：`SubagentWaitChannel` 契约四方法引擎侧实现——
//!   [SubagentWaitChannel::persist_declaration]（dispatch_* 声明落库）/
//!   [SubagentWaitChannel::snapshot]（session_agents 行状态摘要）/
//!   [SubagentWaitChannel::wait_for_terminal]（事件驱动等待）/
//!   [SubagentWaitChannel::inject]（目标 run 的 L1 steer 环注入）；
//! - 事件流订阅生命周期：wait_for_terminal 期间订阅 subagent-ended 事件流、
//!   返回后取消（mpsc 接收端 drop 自动断流，对齐 wait_subagents.rs:686-739
//!   测试替身的通道生命周期）；
//! - 等待消费复用 [wait_for_terminal_events] 同构原语（wait_subagents.rs:
//!   233-305），不重造事件循环。
//!
//! 适配器契约（对齐 timers.rs 的 PendingSink/EventSink/TimerStore 注入范式，
//! 本模块为库目标模块，装配由 engine.rs 统一完成）：
//! - [WaitStore]：dispatch 声明持久化（conex-db session_meta `dispatch_*`
//!   键适配；默认内存实现 [MemoryWaitStore]，conex-db 真适配需装配点提供
//!   db 句柄——与 TimerStore 同一接线缺口，登记遗留问题）；
//! - [SubagentStatusSource]：会话子代理状态行读取（session_agents 行适配；
//!   默认内存实现 [MemoryAgentSource]）；
//! - [EventStreamBroadcast]：subagent-ended 事件流广播（EventQueue 旁路
//!   适配：旁路点把事件 [EventStreamBroadcast::feed] 进广播，映射为
//!   [SubagentTerminalEvent] 灌入各订阅者的 mpsc；引擎持有的同一实例，
//!   事件收口旁路接线在 R-CF3 后续轮落地）；
//! - [ControlBusResolver]：subagent_id → 目标 run 的 [ControlBus] 解析
//!   （活动 run 注册表在 core_run_commands.rs（A8 域），引擎装配点不可达；
//!   生产缺省 [NoopControlBusResolver] 恒 None——inject 返回结构化
//!   InjectFailed，装配失败降级不阻塞引擎）。
//!
//! 共享数据面：dispatch 声明存储与 A7 watchdog（watchdog.rs）共用——引擎
//! 装配时同一 [MemoryWaitStore] 实例双 trait 注入（WaitStore → watchdog 的
//! DispatchStore 桥接 impl 在 engine.rs，见该处注记），wait 落库即 watchdog
//! 可读，重启恢复数据面统一。

use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use agent_tools::tools::subagent::SubagentState;
use agent_tools::tools::wait_subagents::{
    wait_for_terminal_events, DispatchDeclaration, SubagentTerminalEvent, SubagentWaitChannel,
    SubagentWaitError, SubagentWaitResult, SubagentWaitStatus,
};
use async_trait::async_trait;
use conex_types::events::{AgentEvent, SubagentEndStatus};
use conex_types::SessionAgent;
use session_loop::control::ControlBus;
use tokio::sync::mpsc;

/// 订阅通道容量（终端事件量级极小；防慢消费者阻塞旁路点）
const SUBSCRIBER_CAPACITY: usize = 64;
/// 声明保存条数上限（保留最近 N 条分发声明；防无界增长）
const DECLARATION_CAP: usize = 16;

/// 当前 epoch 毫秒（等待通道全域时间基准；时钟异常时 0）
fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

// ── 适配器契约（装配注入面）────────────────────────────────────────

/// dispatch 声明持久化适配（conex-db session_meta `dispatch_*` 键；
/// wait 落库 / watchdog 读取共用的数据面）
pub trait WaitStore: Send + Sync {
    /// 读取全部声明（重启恢复 / watchdog 扫描 / 分发基准时刻恢复用）
    fn load_all(&self) -> Vec<DispatchDeclaration>;
    /// 保存声明（幂等：同一分发时刻覆盖；保留最近若干条）
    fn save(&self, declaration: &DispatchDeclaration);
}

/// 子代理状态行读取适配（session_agents 行；snapshot 数据源）
pub trait SubagentStatusSource: Send + Sync {
    /// 读取本会话全部子代理行（无行 → 空 Vec；fail-open 不 panic）
    fn load_agents(&self) -> Vec<SessionAgent>;
}

/// 目标 run 控制总线解析（inject 用：subagent_id → 该子代理 run 的
/// [ControlBus]；L1 steer 环经 [ControlBus::request_subagent_inject] 注入，
/// 不打断子代理执行）
pub trait ControlBusResolver: Send + Sync {
    /// 解析子代理所在 run 的控制总线（无活动 run / 未接线 → None）
    fn control_bus(&self, subagent_id: &str) -> Option<Arc<Mutex<ControlBus>>>;
}

// ── 默认生产适配器 ────────────────────────────────────────────────

/// 内存持久化适配（引擎默认装配；conex-db session_meta 真适配在 R-CF3
/// 后续轮接线——键形状已冻结为 wait_subagents.rs:83-89 的 dispatch_*，
/// 真适配用 [DispatchDeclaration::to_meta_pairs] / `from_meta_pairs` 落读）
#[derive(Default)]
pub struct MemoryWaitStore {
    /// 声明列表（保留最近 [DECLARATION_CAP] 条；watchdog 取最近分发时刻）
    declarations: Mutex<Vec<DispatchDeclaration>>,
}

impl MemoryWaitStore {
    /// 新建内存存储
    pub fn new() -> Self {
        Self::default()
    }
}

impl WaitStore for MemoryWaitStore {
    fn load_all(&self) -> Vec<DispatchDeclaration> {
        self.declarations.lock().unwrap_or_else(|e| e.into_inner()).clone()
    }

    fn save(&self, declaration: &DispatchDeclaration) {
        let mut list = self.declarations.lock().unwrap_or_else(|e| e.into_inner());
        // 幂等：同一分发时刻的声明覆盖（同一次 wait 调用重复持久化）
        if let Some(slot) = list.iter_mut().find(|d| d.dispatched_at_ms == declaration.dispatched_at_ms) {
            *slot = declaration.clone();
        } else {
            list.push(declaration.clone());
        }
        // 条数护栏：只保留最近 DECLARATION_CAP 条（按分发时刻取最新）
        if list.len() > DECLARATION_CAP {
            list.sort_by_key(|d| std::cmp::Reverse(d.dispatched_at_ms));
            list.truncate(DECLARATION_CAP);
        }
    }
}

/// 内存状态行源（引擎默认装配；conex-db session_agents 真适配在 R-CF3
/// 后续轮接线——表结构对齐 conex-db agents.rs 的
/// `load_session_agents` 行形状）
#[derive(Default)]
pub struct MemoryAgentSource {
    /// 会话子代理行（本会话；装配方 / 测试注入）
    agents: Mutex<Vec<SessionAgent>>,
}

impl MemoryAgentSource {
    /// 新建内存状态行源（空集合）
    pub fn new() -> Self {
        Self::default()
    }

    /// 注入子代理行（测试注入与引擎装配共用；幂等覆盖）
    pub fn set_agents(&self, agents: Vec<SessionAgent>) {
        *self.agents.lock().unwrap_or_else(|e| e.into_inner()) = agents;
    }
}

impl SubagentStatusSource for MemoryAgentSource {
    fn load_agents(&self) -> Vec<SessionAgent> {
        self.agents.lock().unwrap_or_else(|e| e.into_inner()).clone()
    }
}

/// subagent-ended 事件流广播（EventQueue 旁路适配）
///
/// 事件面接线（R-CF3 后续轮落地）：事件消费旁路点把到达的 [AgentEvent]
/// 经 [Self::feed] 灌入本广播，映射为 [SubagentTerminalEvent] 分发给
/// 全部当前订阅者；wait 期间的订阅经 [Self::subscribe] 建立、随接收端
/// drop 自动断流（订阅生命周期契约，T-CF-10 内容 2）。
///
/// 背压语义：`feed` 为同步旁路点调用（不阻塞事件流），满通道时丢弃
/// 并记日志——终端事件量大为 [SUBSCRIBER_CAPACITY] 所容，容量充足；
/// 超时兜底保证 wait 不会悬挂。
pub struct EventStreamBroadcast {
    /// 订阅者发送端（接收端 drop 后 `try_send` 失败，feed 时修剪）
    subscribers: Mutex<Vec<mpsc::Sender<SubagentTerminalEvent>>>,
}

impl Default for EventStreamBroadcast {
    fn default() -> Self {
        Self::new()
    }
}

impl EventStreamBroadcast {
    /// 新建事件流广播（无订阅者）
    pub fn new() -> Self {
        Self {
            subscribers: Mutex::new(Vec::new()),
        }
    }

    /// 订阅终态事件流（返回接收端；wait_for_terminal 期间持有，
    /// 返回后 drop 自动断流）
    pub fn subscribe(&self) -> mpsc::Receiver<SubagentTerminalEvent> {
        let (tx, rx) = mpsc::channel(SUBSCRIBER_CAPACITY);
        self.subscribers
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .push(tx);
        rx
    }

    /// 当前活跃订阅者数（订阅生命周期观测 / 测试同步用；
    /// 顺带修剪断流订阅者——接收端 drop 即 wait 已返回）
    pub fn subscriber_count(&self) -> usize {
        let mut subscribers = self.subscribers.lock().unwrap_or_else(|e| e.into_inner());
        subscribers.retain(|tx| !tx.is_closed());
        subscribers.len()
    }

    /// 旁路点调用：把一条 [AgentEvent] 灌入广播。
    ///
    /// 仅 `subagent-ended` 事件被映射转发（映射规则：Completed → Completed；
    /// Failed / Cancelled 归一 Failed——I0 裁决「cancelled 归一 failed」，
    /// 对齐 [SubagentTerminalEvent] 语义 wait_subagents.rs:207-216）；
    /// 其余事件忽略。同步段不跨 await 持有锁（AA-02 并发模型）。
    pub fn feed(&self, event: &AgentEvent) {
        let Some((subagent_id, status, summary)) = terminal_event_fields(event) else {
            return;
        };
        let terminal = SubagentTerminalEvent {
            subagent_id,
            status,
            summary,
            // 事件体 ended_at 为 ISO8601 文本；旁路点时刻即到达时刻，
            // 以 feed 时刻作为终止时刻（不引入时间解析依赖）
            ended_at_ms: now_ms(),
        };
        let mut subscribers = self.subscribers.lock().unwrap_or_else(|e| e.into_inner());
        // 修剪断流订阅者（接收端 drop = wait 已返回）并逐条投递
        subscribers.retain(|tx| match tx.try_send(terminal.clone()) {
            Ok(()) => true,
            Err(mpsc::error::TrySendError::Full(_)) => {
                tracing::warn!(
                    target: "wait_channel",
                    subagent_id = %terminal.subagent_id,
                    "终态事件通道已满（丢弃；wait 超时兜底，不悬挂）"
                );
                true
            }
            Err(mpsc::error::TrySendError::Closed(_)) => false,
        });
    }
}

/// 从 [AgentEvent] 提取终态事件字段（仅 SubagentEnded；其余返回 None）
fn terminal_event_fields(
    event: &AgentEvent,
) -> Option<(String, SubagentState, Option<String>)> {
    let AgentEvent::SubagentEnded {
        subagent_id,
        status,
        summary,
        ..
    } = event
    else {
        return None;
    };
    // cancelled 归一 failed（I0 裁决；对齐 wait_subagents 的
    // SubagentTerminalEvent.status 语义）
    let state = match status {
        SubagentEndStatus::Completed => SubagentState::Completed,
        SubagentEndStatus::Failed | SubagentEndStatus::Cancelled => SubagentState::Failed,
    };
    Some((subagent_id.clone(), state, summary.clone()))
}

/// 生产缺省控制总线解析器：活动 run 注册表（core_run_commands.rs，
/// A8 域）不可达 → 恒 None；inject 返回结构化 InjectFailed（装配失败
/// 降级语义，不阻塞引擎启动）
pub struct NoopControlBusResolver;

impl ControlBusResolver for NoopControlBusResolver {
    fn control_bus(&self, _subagent_id: &str) -> Option<Arc<Mutex<ControlBus>>> {
        None
    }
}

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
                    terminal: matches!(
                        state,
                        SubagentState::Completed | SubagentState::Failed
                    ),
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

// ── 测试 ───────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use agent_tools::tools::wait_subagents::WaitMode;
    use conex_types::events::AgentEvent;
    use session_loop::control::ControlKind;

    /// 测试通道（mock 适配器；返回通道与可断言适配器句柄）
    fn test_channel() -> (
        Arc<WaitChannel>,
        Arc<MemoryWaitStore>,
        Arc<MemoryAgentSource>,
        Arc<EventStreamBroadcast>,
    ) {
        let store = Arc::new(MemoryWaitStore::new());
        let agents = Arc::new(MemoryAgentSource::new());
        let stream = Arc::new(EventStreamBroadcast::new());
        let channel = Arc::new(WaitChannel::new(
            Arc::clone(&store) as Arc<dyn WaitStore>,
            Arc::clone(&agents) as Arc<dyn SubagentStatusSource>,
            Arc::clone(&stream),
            Arc::new(NoopControlBusResolver),
        ));
        (channel, store, agents, stream)
    }

    /// 等待订阅建立（wait_for_terminal 与 feed 之间的同步点；
    /// 避免订阅前 feed 丢事件）
    async fn wait_until_subscribed(stream: &EventStreamBroadcast) {
        let deadline = tokio::time::Instant::now() + Duration::from_secs(3);
        while tokio::time::Instant::now() < deadline {
            if stream.subscriber_count() > 0 {
                return;
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        panic!("订阅未在时限内建立（subscriber_count = 0）");
    }

    /// 子代理结束事件构造（feed 测试用；ended_at 形状对齐
    /// build_subagent_ended subagent_events.rs:153-162）
    fn subagent_ended(subagent_id: &str, status: SubagentEndStatus) -> AgentEvent {
        AgentEvent::SubagentEnded {
            session_id: "sess-test".to_string(),
            subagent_id: subagent_id.to_string(),
            subagent_run_id: format!("run-{subagent_id}"),
            status,
            summary: Some(format!("{subagent_id} 完成")),
            ended_at: "2026-08-05T00:00:00.000Z".to_string(),
        }
    }

    /// 状态行构造（snapshot 测试用；字段对齐 conex-types SessionAgent）
    fn agent_row(id: &str, status: &str, started_at_ms: i64) -> SessionAgent {
        SessionAgent {
            id: id.to_string(),
            subagent_run_id: format!("run-{id}"),
            parent_session_id: "sess-test".to_string(),
            parent_run_id: "run-main".to_string(),
            parent_tool_call_id: None,
            description: String::new(),
            mode: "research".to_string(),
            status: status.to_string(),
            summary: None,
            messages: Vec::new(),
            started_at: started_at_ms,
            ended_at: None,
            depth: Some(1),
            subagent_path_json: None,
            task_type: None,
            display_label: None,
            allowed_write_paths_json: None,
        }
    }

    // ── T-CF-10 验收断言 ─────────────────────────────────────────

    /// 声明落库后读回一致（dispatch_* 键数据面 roundtrip）
    #[tokio::test]
    async fn wait_channel_persist_declaration_roundtrip() {
        let (channel, store, _, _) = test_channel();
        let declaration = DispatchDeclaration {
            mode: WaitMode::Timer,
            wait_ms: Some(30_000),
            subagent_ids: vec!["sa-1".to_string(), "sa-2".to_string()],
            dispatched_at_ms: 1_000_000,
        };
        channel
            .persist_declaration(&declaration)
            .await
            .expect("声明落库应成功");
        let loaded = store.load_all();
        assert_eq!(loaded.len(), 1);
        assert_eq!(loaded[0], declaration, "读回应与写入一致");
        // 同一分发时刻重复持久化 → 幂等覆盖不新增
        channel
            .persist_declaration(&declaration)
            .await
            .expect("重复持久化应成功");
        assert_eq!(store.load_all().len(), 1, "同一分发时刻应幂等覆盖");
        // 新分发 → 追加；条数护栏生效（超过上限保留最近）
        for i in 0..DECLARATION_CAP {
            channel
                .persist_declaration(&DispatchDeclaration {
                    mode: WaitMode::ParallelWork,
                    wait_ms: None,
                    subagent_ids: vec![format!("sa-{i}")],
                    dispatched_at_ms: 2_000_000 + i as u64,
                })
                .await
                .expect("追加应成功");
        }
        assert_eq!(store.load_all().len(), DECLARATION_CAP, "条数上限应生效");
    }

    /// 注册两个 mock 子代理并发射 subagent-ended 事件流 →
    /// wait_for_terminal 提前返回且状态正确（elapsed = ended - dispatched）
    #[tokio::test]
    async fn wait_channel_wait_for_terminal_returns_on_terminal() {
        let (channel, store, _, stream) = test_channel();
        // 分发基准：预置声明（dispatched_at = 1_000）
        store.save(&DispatchDeclaration {
            mode: WaitMode::AwaitAll,
            wait_ms: None,
            subagent_ids: vec!["sa-1".to_string(), "sa-2".to_string()],
            dispatched_at_ms: 1_000,
        });
        let wait_task = tokio::spawn({
            let channel = Arc::clone(&channel);
            async move {
                channel
                    .wait_for_terminal(&["sa-1".to_string(), "sa-2".to_string()], Some(60_000))
                    .await
            }
        });
        wait_until_subscribed(stream.as_ref()).await;
        // 等待期间发射两个 mock 子代理的终态事件（subagent-ended 消费点）
        stream.feed(&subagent_ended("sa-1", SubagentEndStatus::Completed));
        stream.feed(&subagent_ended("sa-2", SubagentEndStatus::Cancelled));
        // 三层 Result：timeout(Elapsed) → JoinHandle(JoinError) → 通道结果
        // （JoinHandle<T> 的 Future Output 恒为 Result<T, JoinError>）
        let result = tokio::time::timeout(Duration::from_secs(5), wait_task)
            .await
            .expect("wait 任务应在超时窗口内返回")
            .expect("tokio 任务 join 失败（wait 任务 panic）")
            .expect("wait_for_terminal 不应报错");
        assert!(result.all_terminal, "全部终态 → all_terminal");
        assert!(!result.timed_out, "事件到达不应超时");
        assert_eq!(result.agents.len(), 2, "状态摘要按入参顺序");
        assert_eq!(result.agents[0].status, SubagentState::Completed);
        assert_eq!(result.agents[1].status, SubagentState::Failed, "cancelled 归一 failed");
        assert!(result.agents[0].terminal && result.agents[1].terminal);
        // 订阅生命周期：wait 返回后接收端 drop → 广播自动断流
        assert_eq!(
            stream.subscriber_count(),
            0,
            "wait 返回后订阅应已取消（mpsc drop 断流）"
        );
    }

    /// 不发射事件 → 超时返回 timed_out 与未完成列表（未完成保持 running）
    #[tokio::test]
    async fn wait_channel_wait_for_terminal_timeout() {
        let (channel, store, _, stream) = test_channel();
        store.save(&DispatchDeclaration {
            mode: WaitMode::Timer,
            wait_ms: Some(60),
            subagent_ids: vec!["sa-1".to_string()],
            dispatched_at_ms: 1_000,
        });
        let result = tokio::time::timeout(
            Duration::from_secs(5),
            channel.wait_for_terminal(&["sa-1".to_string()], Some(60)),
        )
        .await
        .expect("超时窗口内应返回")
        .expect("wait_for_terminal 不应报错");
        assert!(result.timed_out, "不发射事件 → timed_out");
        assert!(!result.all_terminal);
        assert_eq!(result.agents[0].status, SubagentState::Running, "未完成保持 running");
        assert!(!result.agents[0].terminal);
        // 订阅生命周期：超时返回后同样断流
        assert_eq!(stream.subscriber_count(), 0, "超时返回后订阅应已取消");
    }

    /// inject 经 request_subagent_inject 送达目标 run（mock 解析器 →
    /// 真实 ControlBus 断言 intent 形状）
    #[tokio::test]
    async fn wait_channel_inject_forwards() {
        // mock 解析器：sa-1 命中（真实 ControlBus），sa-2 不可达
        let bus = Arc::new(Mutex::new(ControlBus::new()));
        struct MapResolver {
            map: std::collections::HashMap<String, Arc<Mutex<ControlBus>>>,
        }
        impl ControlBusResolver for MapResolver {
            fn control_bus(&self, subagent_id: &str) -> Option<Arc<Mutex<ControlBus>>> {
                self.map.get(subagent_id).cloned()
            }
        }
        let resolver = Arc::new(MapResolver {
            map: std::collections::HashMap::from([("sa-1".to_string(), Arc::clone(&bus))]),
        });
        let channel = Arc::new(WaitChannel::new(
            Arc::new(MemoryWaitStore::new()) as Arc<dyn WaitStore>,
            Arc::new(MemoryAgentSource::new()) as Arc<dyn SubagentStatusSource>,
            Arc::new(EventStreamBroadcast::new()),
            resolver as Arc<dyn ControlBusResolver>,
        ));
        channel
            .inject("sa-1", "调整方向：优先低风险改动")
            .await
            .expect("注入应成功");
        // 断言 intent 已入目标 run 的 L1 steer 环（transfer 语义）
        let intents = bus.lock().unwrap_or_else(|e| e.into_inner()).drain();
        assert_eq!(intents.len(), 1, "应恰好一条控制意图");
        assert_eq!(intents[0].kind, ControlKind::Steer, "注入走 steer 环");
        assert_eq!(
            intents[0].reason.as_deref(),
            Some("subagent_inject:sa-1"),
            "reason 携带可观测标识"
        );
        let message = intents[0]
            .message
            .as_ref()
            .expect("注入意图必须携带消息");
        let text = message.blocks.iter().find_map(|b| match b {
            conex_types::message::AgentMessageBlock::Text { text } => Some(text.as_str()),
            _ => None,
        });
        assert_eq!(text, Some("调整方向：优先低风险改动"));
        // 不可达目标 → 结构化 InjectFailed（不 panic）
        let err = channel
            .inject("sa-2", "不应送达")
            .await
            .expect_err("不可达目标应报错");
        assert!(matches!(err, SubagentWaitError::InjectFailed(_)));
    }

    /// snapshot 读 session_agents 行映射状态摘要（stopped 归一 failed；
    /// 行缺失按运行中 fail-open）
    #[tokio::test]
    async fn wait_channel_snapshot_from_agent_rows() {
        let (channel, _, agents, _) = test_channel();
        agents.set_agents(vec![
            agent_row("sa-1", "completed", 1_000),
            agent_row("sa-2", "stopped", 2_000),
            agent_row("sa-3", "running", 3_000),
        ]);
        let statuses = channel
            .snapshot(&["sa-1".to_string(), "sa-2".to_string(), "sa-3".to_string(), "sa-9".to_string()])
            .await
            .expect("snapshot 不应报错");
        assert_eq!(statuses.len(), 4, "按入参顺序返回");
        assert_eq!(statuses[0].status, SubagentState::Completed);
        assert!(statuses[0].terminal);
        assert_eq!(statuses[1].status, SubagentState::Failed, "stopped 归一 failed");
        assert!(statuses[1].terminal);
        assert_eq!(statuses[2].status, SubagentState::Running);
        assert!(!statuses[2].terminal);
        assert_eq!(statuses[3].status, SubagentState::Running, "行缺失 fail-open");
        assert!(!statuses[3].terminal);
    }

    /// 广播映射与修剪：非 SubagentEnded 事件忽略；断流订阅者被修剪；
    /// 订阅后 feed 立即送达。
    #[tokio::test]
    async fn broadcast_feed_maps_and_prunes() {
        let stream = EventStreamBroadcast::new();
        // 非终态事件 → 忽略（无订阅者收到）
        let mut rx = stream.subscribe();
        stream.feed(&AgentEvent::AgentStart {
            session_id: "s1".to_string(),
            timestamp: "2026-08-05T00:00:00.000Z".to_string(),
        });
        assert!(rx.try_recv().is_err(), "非 SubagentEnded 事件不得转发");
        // 终态事件 → 送达
        stream.feed(&subagent_ended("sa-1", SubagentEndStatus::Failed));
        let event = rx.try_recv().expect("终态事件应送达");
        assert_eq!(event.subagent_id, "sa-1");
        assert_eq!(event.status, SubagentState::Failed);
        // 断流修剪：rx drop 后订阅者被清理
        drop(rx);
        stream.feed(&subagent_ended("sa-2", SubagentEndStatus::Completed));
        assert_eq!(stream.subscriber_count(), 0, "断流订阅者应被修剪");
    }

    /// 通道 Debug 形状（trait 要求 Debug；不 panic）
    #[test]
    fn wait_channel_debug_shape() {
        let (channel, _, _, _) = test_channel();
        let debug = format!("{channel:?}");
        assert!(debug.contains("WaitChannel"), "Debug 形状：{debug}");
    }
}
