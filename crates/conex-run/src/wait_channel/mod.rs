//! 子代理等待通道（G4 / REQ-C05；T-CF-10，R-CF3）
//!
//! 职责（02-CF 方案 §4.2 / 7.4 T-CF-10）：
//! - [WaitChannel]：`SubagentWaitChannel` 契约五方法引擎侧实现——
//!   [SubagentWaitChannel::persist_declaration]（dispatch_* 声明落库）/
//!   [SubagentWaitChannel::persist_outputs]（dispatch_outputs 产出清单落库，
//!   T-EG-10 G02 完成通知字段的持久化副本）/
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
//! - [WaitStore]：dispatch 声明与产出清单持久化（conex-db session_meta
//!   `dispatch_*` / `dispatch_outputs` 键适配；默认内存实现
//!   [MemoryWaitStore]，conex-db 真适配需装配点提供 db 句柄——与
//!   TimerStore 同一接线缺口，登记遗留问题）；
//! - [SubagentStatusSource]：会话子代理状态行读取（session_agents 行适配；
//!   默认内存实现 [MemoryAgentSource]）；
//! - [EventStreamBroadcast]：subagent-ended 事件流广播（EventQueue 旁路
//!   适配：旁路点把事件 [EventStreamBroadcast::feed] 进广播，映射为
//!   [SubagentTerminalEvent] 灌入各订阅者的 mpsc；引擎持有的同一实例，
//!   事件收口旁路接线在 R-CF3 后续轮落地）；
//! - [ControlBusResolver]：subagent_id → 目标 run 的 [ControlBus] 解析；
//!   引擎先用 [crate::engine_channels::ContinuityChannelBoard] 占位装配，Arc 构造完成后由
//!   `CoreRunState::finalize_continuity_channels` 绑定活动 run 注册表解析器；
//!   未绑定窗口才返回 None 并产生结构化 InjectFailed。
//!
//! 共享数据面：dispatch 声明存储与 A7 watchdog（壳层 watchdog.rs）共用——引擎
//! 装配时同一 [MemoryWaitStore] 实例双 trait 注入（同文件 [DispatchStore]
//! 适配即 watchdog 读取面），wait 落库即 watchdog 可读，重启恢复数据面统一。

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

pub use agent_tools::tools::wait_subagents::SubagentWaitChannel;
use agent_tools::tools::wait_subagents::{DispatchDeclaration, SubagentOutput, SubagentWaitError};
use conex_types::SessionAgent;
use session_loop::control::ControlBus;

mod broadcast;
mod channel;
mod stores;
mod wait_registry;

pub use broadcast::{EventStreamBroadcast, NoopControlBusResolver};
pub use channel::WaitChannel;
pub use stores::{LocalDbWaitStore, MemoryAgentSource, MemoryWaitStore};
pub use wait_registry::{SubagentWaitRegistry, WaitScopeGuard};

/// 订阅通道容量（终端事件量级极小；防慢消费者阻塞旁路点）
const SUBSCRIBER_CAPACITY: usize = 64;
/// 声明保存条数上限（保留最近 N 条分发声明；防无界增长）
const DECLARATION_CAP: usize = 16;

/// 当前 epoch 毫秒（等待通道全域时间基准；实现复用
/// [crate::engine_assembly::unix_millis_now]，全 crate 单一时间源）
fn now_ms() -> u64 {
    crate::engine_assembly::unix_millis_now()
}

// ── 适配器契约（装配注入面）────────────────────────────────────────

/// dispatch 声明与产出清单持久化适配（conex-db session_meta
/// `dispatch_*` / `dispatch_outputs` 键；wait 落库 / watchdog 读取共用的
/// 数据面）
pub trait WaitStore: Send + Sync {
    /// 读取全部声明（重启恢复 / watchdog 扫描 / 分发基准时刻恢复用）
    fn load_all(&self) -> Vec<DispatchDeclaration>;
    /// 保存声明（幂等：同一分发时刻覆盖；保留最近若干条）
    fn save(&self, declaration: &DispatchDeclaration);
    /// 保存各子代理产出清单（`dispatch_outputs` 键；整表覆盖语义，
    /// 天然有界——不引入 [DECLARATION_CAP] 式条数上限）
    fn save_outputs(
        &self,
        outputs: &HashMap<String, Vec<SubagentOutput>>,
    ) -> Result<(), SubagentWaitError>;
    /// 读取各子代理产出清单（解析容错：缺失 / 损坏 → 空表，fail-open）
    fn load_outputs(&self) -> HashMap<String, Vec<SubagentOutput>>;
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

/// dispatch 声明读取适配（session_meta `dispatch_*` 键；A7 watchdog
/// 失联判定的声明源——wait 落库即 watchdog 可读）
pub trait DispatchStore: Send + Sync {
    /// 读取全部 dispatch 声明（watchdog 扫描 / 分发基准时刻恢复用）
    fn load_declarations(&self) -> Vec<DispatchDeclaration>;

    /// 清理/核销历史 dispatch 声明（消除虚假超时报警风暴）。
    ///
    /// 默认 no-op：扫描面已按子代理终态过滤，不清理也不会误报；无单键
    /// 删除持久化面的实现（LocalDb session_meta）保持默认即可。
    fn clear_declarations(&self) {}
}

impl DispatchStore for MemoryWaitStore {
    fn load_declarations(&self) -> Vec<DispatchDeclaration> {
        WaitStore::load_all(self)
    }

    fn clear_declarations(&self) {
        self.clear_all();
    }
}

impl DispatchStore for LocalDbWaitStore {
    fn load_declarations(&self) -> Vec<DispatchDeclaration> {
        WaitStore::load_all(self)
    }
}

/// T-CF-10/13 双 trait 合并面（[WaitStore] + [DispatchStore]；
/// D4 §8 D-6 最小 diff 定夺）：引擎持有的 dispatch 存储实例经本面稳定
/// 类型化——装配分支（内存/真适配）后访问器返回类型不漂移，双 trait
/// 消费面分别注入 WaitChannel 与 Watchdog。
pub trait WaitDispatchStore: WaitStore + DispatchStore {}
impl WaitDispatchStore for MemoryWaitStore {}
impl WaitDispatchStore for LocalDbWaitStore {}

// ── 测试 ───────────────────────────────────────────────────────────

#[cfg(test)]
mod tests;
