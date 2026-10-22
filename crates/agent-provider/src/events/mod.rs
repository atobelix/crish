//! 低级流事件与合同类型（任务书 B2.4；02-provider-semantics.md §1.1、§六.9-10）
//!
//! [ProviderStreamEvent] 5 种 + [ProviderUsage] + [StopReason]，对齐 TS 端
//! `shared:tool.ts:295-305`（唯一 wire 出口，三家 API 统一归一）。
//!
//! 类型约束（02 §六.9）：每流恰好一个 `stop`，且 stop 之后不得再有任何事件；
//! 由 [StreamParser] 状态机包装器保证——收到第二个 stop 返回错误。

mod stream;
mod types;

#[cfg(test)]
mod tests;

pub use self::stream::{
    stream_error_kind, ProviderStreamEvent, StreamParseError, StreamParser,
};
pub use self::types::{
    merge_usage_shards, CacheAccounting, CacheBreakdown, ModelRequestInfo,
    ModelRequestObserver, ModelResponseInfo, ProviderUsage, StopReason,
};
