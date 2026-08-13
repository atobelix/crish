//! 缓存参数载体与键派生（P2 通用格式层，docs/cache-optimization/03-plans/P2-wire-cache-params.md §3.1）
//!
//! - [CacheRetention]：缓存保留档位（none/short/long，默认 short）
//! - [TtlBucket]：wire 层 TTL 桶（5m/1h，A2 C3：避免与 P3 models 层同名 `CacheTtl` 冲突）
//! - [CacheControl]：块级/消息级缓存控制标记（Anthropic 系 wire 值）
//! - [CacheKey]：OpenAI 系 prompt_cache_key 语义载体（会话 ID → 码点钳 64，
//!   A2 C4：请求构造面真源，P3 derive_prompt_cache_key 委托本实现）
//! - [CacheMechanism] / [CacheCapability]：缓存机制分类与厂商能力声明
//! - [BreakpointPlan] / [apply_cache_controls] / [text_to_parts_with_cc]：
//!   断点预算分配与 wire 施加（三锚点，载体字段由 messages.rs 提供）
//!
//! 全部为纯数据结构/纯函数（无 HTTP、无 IO），单测驱动。
//!
//! SR-06e · 拆分 · ≠ EL：门面文件。实现域拆分如下（测试旁挂 cache_tests.rs）：
//! - [cache_policy]：断点预算分配（allocate_breakpoints）、缓存策略组装
//!   （build_cache_policy）与厂商能力兜底表（infer_cache_capability / CACHE_CAPABILITY_TABLE）
//! - [cache_wire]：wire 施加面（apply_cache_controls / cache_control_for_ttl /
//!   text_to_parts_with_cc）

use serde_json::{json, Value};

/// 测试专用接线：旁挂测试（cache_tests.rs）经 `use super::*` 消费以下符号，
/// 门面自身不使用（pub(crate) 不扩大对外 API；非 test 构建下允许 unused）。
#[cfg_attr(not(test), allow(unused_imports))]
pub(crate) use crate::models::{
    cache_behavior_for, infer_vendor, session_affinity_headers, CacheBehavior, CacheTtl,
    ModelCatalog, VendorId,
};
#[cfg_attr(not(test), allow(unused_imports))]
pub(crate) use crate::request::messages::{ChatContent, ChatContentPart, ChatMessage};

#[path = "cache_policy.rs"]
mod cache_policy;
#[path = "cache_wire.rs"]
mod cache_wire;

pub use cache_policy::{
    affinity_header, allocate_breakpoints, build_cache_policy, infer_cache_capability,
    retention_wire_value, CachePolicy, PromptCacheMode, PromptCacheOptions, CACHE_CAPABILITY_TABLE,
};
pub use cache_wire::{
    apply_cache_controls, cache_control_for_ttl, text_to_parts_with_cc,
};

/// 缓存保留档位（对齐 pi 的 CacheRetention 三档，pi-cache-analysis.md:126-131）
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum CacheRetention {
    /// 完全不参与缓存（不发任何缓存参数；摘要请求强制此档，对齐 pi compaction.ts:562-581）
    None,
    /// 短档：Anthropic 5 分钟 TTL 桶 / OpenAI in_memory
    #[default]
    Short,
    /// 长档：Anthropic 1 小时 TTL 桶（写价 2x）/ OpenAI 24h extended
    Long,
}

/// wire 层 TTL 桶（对齐 opencode protocols/utils/cache.ts:12-16 的 5m/1h 双桶）
///
/// 命名按 A2 审计 C3 裁决：P3 在 models/ttl.rs 定义同名 `CacheTtl`（Short/Hour/Day
/// 三档路由语义），两者同处 agent-provider crate 必然冲突；本类型（wire 桶）更名
/// `TtlBucket`，`CacheTtl` 名称留给 P3 的模型级 TTL 路由档。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TtlBucket {
    /// `{"type":"ephemeral"}`（Anthropic 默认 5 分钟；命中刷新免费）
    FiveMinutes,
    /// `{"type":"ephemeral","ttl":"1h"}`（写价 2x，受模型开关 supportsLongCacheRetention 约束）
    OneHour,
}

/// 块级/消息级缓存控制标记（Anthropic 系 wire 值）
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CacheControl {
    /// `{"type":"ephemeral"}`
    Ephemeral,
    /// `{"type":"ephemeral","ttl":"1h"}`
    Ephemeral1h,
}

impl CacheControl {
    /// 序列化为 wire 值
    pub fn to_value(self) -> Value {
        match self {
            Self::Ephemeral => json!({ "type": "ephemeral" }),
            Self::Ephemeral1h => json!({ "type": "ephemeral", "ttl": "1h" }),
        }
    }
}

/// OpenAI prompt_cache_key 最大长度（码点）
pub const OPENAI_PROMPT_CACHE_KEY_MAX_LENGTH: usize = 64;

/// 统一缓存键（OpenAI 系 prompt_cache_key 的语义载体）
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CacheKey(pub String);

impl CacheKey {
    /// 会话 ID → 缓存键：按 Unicode 码点钳到 64（对齐 pi openai-prompt-cache.ts:1-8
    /// 的 OPENAI_PROMPT_CACHE_KEY_MAX_LENGTH=64；钳制真源见 pi-cache-analysis.md:169）
    ///
    /// 空串/全空白 → None（显式不参与缓存由调用方用 [CacheRetention::None] 表达）。
    /// 钳制按码点而非字节（`.chars().take(64)`），多字节 UTF-8 会话 ID
    /// （中文/emoji）不会截成半字符。
    pub fn from_session_id(session_id: &str) -> Option<Self> {
        let trimmed = session_id.trim();
        if trimmed.is_empty() {
            return None;
        }
        Some(Self(
            trimmed.chars().take(OPENAI_PROMPT_CACHE_KEY_MAX_LENGTH).collect(),
        ))
    }
}

/// 缓存机制分类（00-catalog 第 12.1 节 cache_type/cache_mechanism 的 Rust 形态）
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CacheMechanism {
    /// 自动缓存（DeepSeek/Kimi/GLM 隐式/Gemini 隐式）：客户端零参数，只保前缀稳定
    Auto,
    /// Anthropic 式显式断点（官方 Anthropic / MiniMax M2.x / 百炼显式 / GLM 待实测）
    Explicit,
    /// OpenAI 系键路由（prompt_cache_key + retention；GPT-5.6+ 可叠加 options）
    Key,
    /// 不支持缓存（本地模型等）
    None,
}

/// 缓存能力声明（对齐 pi types.ts:621 的 supportsCacheControlOnTools 等模型开关）
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CacheCapability {
    /// 机制分类（决定走哪条注入路径）
    pub mechanism: CacheMechanism,
    /// 是否支持块级/消息级 cache_control（Anthropic 系）
    pub supports_cache_control: bool,
    /// 工具定义上能否携带 cache_control（Fireworks 反例：拒绝未知字段，
    /// pi-cache-analysis.md:314；DeepSeek 忽略但强制省略）
    pub supports_cache_control_on_tools: bool,
    /// 断点预算上限（Anthropic/MiniMax/百炼 = 4）
    pub breakpoint_cap: usize,
    /// 可用的 TTL 桶（默认仅 5m；长档受 supports_long_retention 约束）
    pub ttl_buckets: &'static [TtlBucket],
    /// 是否发送 prompt_cache_key（OpenAI/Kimi/xAI/百炼 Responses）
    pub prompt_cache_key: bool,
    /// prompt_cache_retention 可用档（in_memory / 24h）
    pub retention: CacheRetention,
    /// 是否支持 GPT-5.6+ prompt_cache_options.mode（显式/隐式开关）
    pub supports_explicit_prompt_cache_mode: bool,
}

/// 写入断点上限（Anthropic 每请求最多 4 个显式 cache_control 断点；
/// 措辞按 A1-19 统一：写入断点上限 4，implicit 自动缓存占 1 槽位时显式最多 3）
pub const ANTHROPIC_BREAKPOINT_CAP: usize = 4;

/// 断点放置计划（三锚点布尔；对齐 opencode ANTHROPIC_BREAKPOINT_CAP=4 的
/// 层级分配输出，anthropic-messages.ts:511-514）
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct BreakpointPlan {
    /// 是否在最后一个工具上打断点（工具位于缓存层级最高处，优先保留）
    pub tools: bool,
    /// 是否在首条 system 消息上打断点（user-prefix 模式下为首条 user 消息）
    pub system: bool,
    /// 是否在最后一条 user/tool 消息末块打断点（工具循环内每轮锚点稳定）
    pub messages: bool,
}

impl BreakpointPlan {
    /// 任一断点开启（T-15 注入前快速短路；全 false = 请求字节与未施加时一致）
    pub fn has_any(&self) -> bool {
        self.tools || self.system || self.messages
    }
}

/// 断点放置摘要（供日志与未来 P5 归因消费，P5 §3.4.3 MissAttribution；
/// placed/dropped 记账在 T-14 载体字段落地后由 [apply_cache_controls] 完成）
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct BreakpointReport {
    /// 实际放置的断点数
    pub placed: usize,
    /// 因预算超限被丢弃的断点数（不报错，降级日志用）
    pub dropped: usize,
}

#[cfg(test)]
#[path = "cache_tests.rs"]
mod tests;
