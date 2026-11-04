//! 通用后台执行注册表（工具调用超时转后台 · BG1）
//!
//! 工具执行满阈值（缺省 20s，工具定义 `background_after_ms` 声明）
//! 仍未完成时，执行器（BG2）把执行单元 detach 到本注册表托管，本
//! 调用以占位结果收口、对话继续；执行在后台落定后经 BG3 的事件 +
//! 唤醒双通道回注，模型也可凭 callId 经 `tool_task` 工具查询。
//!
//! 本批（BG1）落契约与数据结构：
//! - [registry::ToolBackgroundRegistry]：登记（幂等）/ 准入排队
//!   （每会话 4、全局 16、排队不计时）/ 落定 / 取消传播（条目子
//!   令牌 + 句柄 abort）/ 会话关闭收口 / OutcomeUnknown 合成入口 /
//!   两级查询（进程内有界留存 + 落盘回查）。**注册表对任务时长
//!   不设上限**（定案：终止只来自落定、取消、会话关闭、冷启动
//!   合成四条路径），内部不设任何定时器。
//! - [store]：落盘契约与实现（生产 = session_meta kv；测试 =
//!   内存替身）——终态结果按 callId 可查，未落定清单是冷启动
//!   合成的原料。
//!
//! BG3 在此之上落结果回注三面：[events]（发射接缝 + 结果同构
//! 转换）、[bridge_sink]（引擎 EventBridge 实时轨直发 + tool-wake
//! 扇出的生产 sink）、[registry::ToolBackgroundRegistry::
//! synthesize_outcome_unknown]（冷启动落盘合成）；唤醒消费者本体
//! 在 crate 根 [crate::tool_wake_consumer]（与 TaskEventConsumer
//! 并列）。
//!
//! 与 shell 的进程后台注册表（`agent_tools::background` +
//! 壳层 BackgroundTaskManager）并列、互不冒充：那边托管子进程，
//! 这边托管进程内工具执行 future；模型侧查询工具也相应分开
//! （`background_task` 对进程任务、`tool_task` 对本注册表）。

pub mod bridge_sink;
pub mod events;
pub mod host;
pub mod registry;
pub mod store;

pub use bridge_sink::ToolBackgroundBridgeSink;
pub use events::{
    cancelled_tool_batch_result, outcome_unknown_tool_batch_result, settled_status_of,
    tool_batch_result_from_classified, ToolBackgroundCallSummary, ToolBackgroundEventSink,
};
pub use host::RegistryBackgroundHost;

pub use registry::{
    NewToolBackgroundTask, RegisterOutcome, Registration, ToolBackgroundCounts,
    ToolBackgroundRegistry, ToolBackgroundWriteClaim, CANCELLED_NOTE, MAX_RUNNING_GLOBAL,
    MAX_RUNNING_PER_SESSION, MAX_SETTLED_RETAINED, OUTCOME_UNKNOWN_NOTE,
};
pub use store::{
    InMemoryToolBackgroundStore, SessionMetaToolBackgroundStore, ToolBackgroundRecord,
    ToolBackgroundStore, ToolBackgroundStoreError,
};
