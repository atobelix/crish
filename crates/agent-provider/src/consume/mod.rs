//! 消费契约层（任务书 B2.8；02-provider-semantics.md §一.3、§五.12、§六.12；
//! 01-session-loop-semantics.md §2.4 步骤 5、§五.3）
//!
//! 对齐 TS 端 `core:runtime-components/provider-response-consumer.ts` 的消费聚合语义，
//! 并按 00 D5 / 01 D6 裁决取消「error 一票否决」：
//!
//! - [consume]：ProviderStreamEvent 序列 → [ConsumeResult]（ProviderOutput 分类 +
//!   diagnostics 透出 + metadata 标注）；
//! - text-delta 聚合为 text；thought-delta 聚合为 thought（redacted 逐段保留，
//!   产出 thought block 序列 + metadata.thought 聚合全文，02 §一.4）；
//! - tool-call 收集：低级契约的 tool-call 已是完整调用一次性产出（02 §六.9），
//!   等价于合同级 phase='end' 的事件——仅 end 阶段的 tool-call 收集（02 §一.3：86-99）；
//! - stopReason 生成（01 D6 裁决）：有文字/tool-call → 正常 Message，error 不作为
//!   stopReason 一票否决，降级为 metadata.providerError 标注；无内容且 error →
//!   StreamError{classified}；空响应 → Empty（02 §一.3：131-132）；
//! - abort 信号（finishAfterAbort 等价，02 §一.3：144-174）：仍完成聚合（flush 已收集
//!   内容），有内容时保留部分并标 stopReason=aborted，无内容时产出 StreamError；
//! - stop.reason=length → Message + metadata.stopReason=length（供上层 length 恢复阶梯，
//!   01 §2.6 步骤 1）。

mod aggregate;
mod engine;
mod types;

#[cfg(test)]
mod tests;

pub use self::aggregate::MAX_AGGREGATE_TEXT_BYTES;
pub use self::engine::consume;
pub use self::types::{ConsumeResult, ConsumeStopReason};
