//! C6 依赖图调度器（I5-M6：02 方案 §2 M6 / 04 方案 §2 C6）
//!
//! 主 agent 以依赖图编排子 agent 执行序列：after/parallel 声明、环检测、
//! gate 强制（全部前置 completed 才启动后置）、on_failed 三策略、并发预算
//! reserve/release、重启恢复、合成唤醒（不轮询）。本模块为调度核心，
//! session.rs 主写权归 C6（M6）保持（本模块独立成文件，不并写 SessionTree）。
//!
//! parallel 串行约束（裁决 D2 冻结：同级 = 同 depends_on 集合）：同波次
//! （depends_on 集合相同）的节点中，parallel=false 者须等待声明序在前、
//! 同样 parallel=false 的同级节点全部进入终态后才就绪；parallel=true 者
//! 不受约束（显式声明并发）。实现落点：is_ready + serial_predecessor_pending
//! 判定；advance 以 dirty 增量就绪集做不动点（状态变化标后继脏，dirty
//! 空则退出），终态事件驱动重推进。
//!
//! 本文件为门面：声明 model / scheduler / advance 三子模块并 re-export
//! 对外 API，保持 crate::flow_graph::FlowGraph 等路径不 break。三子模块
//! 为唯一真源，门面内无重复实现。

#[path = "flow_graph_advance.rs"]
pub mod advance;
#[path = "flow_graph_model.rs"]
pub mod model;
#[path = "flow_graph_scheduler.rs"]
pub mod scheduler;

pub use model::{
    FailStrategy, FlowDeclaration, FlowGraph, FlowGraphError, FlowNode, FlowNodeId,
    FlowNodeRuntime, FlowNodeState,
};
pub use scheduler::{
    BudgetExceededKind, ConcurrencyBudget, FlowAdvance, FlowError, FlowMetaStore, FlowReport,
    FlowReportKind, FlowScheduler, FlowStarted, FlowWakeup, MetaStore, FLOW_AUTO_COMPOSITE_KEY,
    FLOW_DECLARATION_KEY, FLOW_MAX_CONCURRENT_KEY, FLOW_MAX_SIBLINGS_KEY, FLOW_ON_FAILED_KEY,
    FLOW_RELEASED_KEY, FLOW_RESERVED_KEY, FLOW_STATE_KEY,
};
