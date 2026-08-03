//! provider 调用契约（B3.4 第 5 点：session-loop 不直接依赖 agent-provider）
//!
//! [ProviderCall] 是主循环与真实 provider 传输层之间的唯一接缝：
//! - 真实适配层（B4/B6 集成时实现）：把 agent-provider 的请求构建 / HTTP /
//!   SSE 解析包装为 [Self::stream]，传输错误**已分类**后上抛
//!   （[ClassifiedStreamError]，02 §4.2 分类表 13 行）；
//! - 测试替身（[crate::testing::TestProvider]）：脚本化事件序列直接产出。
//!
//! [ProviderRequest] 携带主循环侧的全部调用上下文：对话消息、工具定义
//! （来自 [agent_tools::registry::ToolRegistry]）、max_tokens（length 阶梯
//! 由主循环升级后透传，01 §2.6 步骤 1）。
//!
//! 流式契约（冻结 v1，AU-04 F1，SoT = `docs/rust-rewrite/plans/PE-02` §3.1，
//! 本轮 T02.1 已落地）：
//! - 流前 [Err]（[ProviderCall::stream] 的返回值）：传输层 / HTTP / 首帧
//!   错误，尚未产出任何事件（进重试阶梯，01 §2.5）；
//! - 流中 [Err]（流条目本身）：中途错误——已产出内容 → 内容保留收场
//!   （不重试，01 D6）；未产出 → 等同流前错误进重试阶梯；
//! - 每流恰好一个 Stop，Stop 后流立即结束；正常终止 = 事件序列结束（收口）；
//! - 取消协作：实现方按 [crate::safe_point::AbortSignal] 语义尽快终止，
//!   已产出事件全部保留（partial salvage，stream.rs:294-316）；
//! - 返回流为 `'static`，不得借用 request（请求体在返回流前完成序列化）。

use std::pin::Pin;
use std::sync::Arc;

use async_trait::async_trait;
use conex_types::events::AgentEvent;
use conex_types::message::AgentMessage;
use conex_types::response::ClassifiedStreamError;
use futures::Stream;

use crate::stream::ProviderStreamEvent;

/// 流条目别名（冻结 v1，AU-04 F1 / PE-02 §3.1.1）
///
/// 条目本身是 [Result]：`Ok` 携带单条事件，`Err` 为流中错误
/// （流前错误走 [ProviderCall::stream] 的返回值，不在此别名中出现）。
pub type ProviderStreamItem = Result<ProviderStreamEvent, ClassifiedStreamError>;

/// 增量流类型（冻结 v1，AU-04 F1 / PE-02 §3.1.1）
///
/// `'static`：事件携带自有数据，不得借用 [ProviderRequest]（请求体在返回流前
/// 完成序列化）；调用方取消 = drop 流。
pub type ProviderEventStream = Pin<Box<dyn Stream<Item = ProviderStreamItem> + Send + 'static>>;

/// 全量返回的旧形态别名（流式化前的契约形态；冻结后保留以兼容既有引用面，
/// 契约不要求删除，PE-09 落地后评估去留）
pub type StreamResult = Result<Vec<ProviderStreamEvent>, ClassifiedStreamError>;

/// 流式增量转发（T09.1 实时双轨的**实时轨**：delta 实时到前端）
///
/// - 只承载 `message-delta`（text-delta / thought-delta 增量，非持久化类，
///   PE-09 §0.3 契约点 2）；信封由实现方构造，**sequence=None**（不落库、
///   无序列号，前端按 messageId 累加，PE-09 §0.3 契约点 3）；
/// - 背压/丢帧复用事件桥的 [crate::buffer] Delta 类目（delta 可丢、
///   message-end 必达，03 §5.3-6）；
/// - 实现方无状态（[Send] + [Sync]），run 结束无清理需求。
pub trait DeltaSink: Send + Sync {
    /// 推送一条增量事件（message-delta；实现方负责信封构造与发射）
    fn push(&self, delta: AgentEvent);
}

/// provider 调用请求（对齐 01 §2.4 步骤 1 的 buildProviderCall 上下文）
///
/// `'a` 为消息借用期（冻结 v1，PE-02 §3.1.1）：请求只在 [ProviderCall::stream]
/// 调用期间有效，实现方必须在返回流之前完成请求体序列化（流为 `'static`，
/// 不得借用本请求）。
///
/// 载荷形态（PE-09 T09.3，与 T09.3.2 Arc 化联动，两者只允许一种最终形态）：
/// 消息为 `&'a [Arc<AgentMessage>]`——对话（`Vec<Arc<AgentMessage>>`）全链
/// 借用 0 深拷贝；实现方请求体构建时按 `Arc` 解引用序列化（wire 逐字节不变）。
#[derive(Debug, Clone, Default)]
pub struct ProviderRequest<'a> {
    /// 当前完整对话（用户 + 助手 + 工具结果 + steering 注入消息）
    pub messages: &'a [Arc<AgentMessage>],
    /// 可用工具定义（注册表按注册序导出）
    pub tools: Vec<ToolSchema>,
    /// 本次调用 max_tokens（length 阶梯升级后透传）
    pub max_tokens: Option<u32>,
    /// 系统提示词（P1 阶段 2：B1 四层通路的第三层，SessionLoopOptions.
    /// system_prompt 经 build_request 以 `as_deref()` 透传）。
    /// 属于请求静态前缀，run 内不可变；None = 不发送 system 消息，
    /// 向后兼容（既有调用方构造不破坏）。实现方负责在返回流前完成
    /// 序列化（与 messages 同生命周期，`'a` 借用期）。
    pub system_prompt: Option<&'a str>,
}

/// 工具定义的最小消费面（真实适配层据此构建 provider 请求体）
#[derive(Debug, Clone, PartialEq)]
pub struct ToolSchema {
    /// 工具名（注册表全局唯一键）
    pub name: String,
    /// 人读描述
    pub description: String,
    /// 入参 JSON Schema
    pub input_schema: serde_json::Value,
}

impl ToolSchema {
    /// 从 agent-tools 的工具定义构建
    pub fn from_definition(def: &agent_tools::definition::ToolDefinition) -> Self {
        Self {
            name: def.name.clone(),
            description: def.description.clone(),
            input_schema: def.effective_input_schema().clone(),
        }
    }
}

/// provider 调用契约（trait 解耦：session-loop 不依赖 agent-provider 的 HTTP 层）
///
/// 冻结签名（v1，AU-04 F1，SoT = PE-02 §3.1）。流式语义（实现方与消费方
/// 共同遵守）：
/// - 流前 [Err]：传输层 / HTTP / 首帧错误，尚未产出任何事件（进重试阶梯，
///   01 §2.5）；
/// - 流中 [Err]（条目）：中途错误——已产出内容 → 内容保留收场（不重试，
///   01 D6：有文字永不失败）；未产出 → 等同流前 [Err] 进重试阶梯；
/// - 每流恰好一个 Stop，Stop 后流立即结束；正常终止 = 事件序列结束（收口）；
/// - 取消协作：实现方按 [crate::safe_point::AbortSignal] 语义尽快终止流，
///   已产出事件全部保留（partial salvage，stream.rs:294-316）；
/// - 增量性硬约束：TextDelta / ThoughtDelta 按产出顺序**逐事件**流出，禁止
///   跨帧/跨块聚合后一次性 emit（P1 修复本质，PE-02 §3.1.2）；
/// - 返回流为 `'static`，不得借用 request（请求体在返回流前完成序列化）。
#[async_trait]
pub trait ProviderCall: Send + Sync {
    /// 执行一次 provider 调用并返回增量流。
    ///
    /// `'a` 为请求借用期：`stream` 返回前必须完成请求体序列化，返回的流
    /// 不依赖请求生命周期（`'static`）。
    async fn stream<'a>(
        &self,
        request: &ProviderRequest<'a>,
    ) -> Result<ProviderEventStream, ClassifiedStreamError>;
}
