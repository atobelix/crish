//! provider 流事件与消费聚合（B3.4 本地等价层，对齐 02 §1.1 / §六.9、01 §2.4）
//!
//! session-loop 按任务书 B3.4 第 5 点约束**不直接依赖 agent-provider**
//! （provider 解耦用 trait，HTTP/传输层不进入本 crate）。本模块自建与
//! agent-provider::events / consume 等价的类型与聚合逻辑：
//! - [ProviderStreamEvent] / [StopReason] / [ProviderUsage]：wire 形状与
//!   agent-provider::events 逐字段一致（02 §1.1、§六.9-10），供 ProviderCall
//!   实现方（真实 provider 适配层 / TestProvider）产出一致的事件序列；
//! - [CacheAccounting] / [CacheBreakdown]：usage 归一化口径与派生结果的本地
//!   等价类型（对齐 agent-provider::events，P2 §3.3 D / C9 口径唯一真源）——
//!   [ConsumeBuilder] 携带口径提示，流收口处把派生出的 `cacheBreakdown`
//!   （camelCase）写入消息 metadata；
//! - [consume] / [ConsumeResult] / [ConsumeStopReason]：与
//!   agent-provider::consume 等价的响应分类聚合（01 D5/D6：模型输出与传输
//!   错误分离——有文字或有 tool-call 即 Message，纯文字永不失败）。
//!
//! 依赖方向说明：agent-provider 仅依赖 conex-types（无环），若后续任务允许
//! 引入该依赖，可将本层整体替换为 agent-provider::consume 复用；当前保持
//! 自建等价类型以遵守「不引入新依赖」约束（任务书 B3.4 第 5 点）。
//!
//! 事件序列合法性（每流恰好一个 stop、stop 之后无事件，02 §六.9）由
//! provider 实现方保证，本层不再重复校验（与 agent-provider 的 consume 同）。

mod aggregate;
mod events;

pub use aggregate::{consume, reannotate_aborted, ConsumeBuilder};
pub use events::{
    CacheAccounting, CacheBreakdown, ConsumeResult, ConsumeStopReason, ProviderStreamEvent,
    ProviderUsage, StopReason,
};

#[cfg(test)]
mod tests;
