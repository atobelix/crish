//! 缓存跟踪数据模型与配置定义

use conex_types::events::MissAttribution;

/// FNV-1a 64 位偏移基值
pub(super) const FNV_OFFSET_BASIS: u64 = 0xcbf2_9ce4_8422_2325;
/// FNV-1a 64 位素数
pub(super) const FNV_PRIME: u64 = 0x0000_0100_0000_01b3;

/// 缓存跟踪配置（经 SessionLoopOptions 注入 LoopState；T-40 engine 接线点——
/// provider / model 由 engine 装配、TTL 走 P3 路由表查询，None 语义 = 未知）
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CacheTrackingConfig {
    /// 供应商标识（基线标识与归因 ProviderSwitch 用）
    pub provider: String,
    /// 模型标识（基线标识与归因 ModelSwitch 用）
    pub model: String,
    /// 缓存 TTL 秒数（P3 路由表；0 = 未知 / 无缓存——跳过 TTL 归因与
    /// 温暖截止计算，对齐 P5 §3.4.4「TTL 查询失败不提示」）
    pub ttl_seconds: u64,
}

/// 单次 miss 审计结果（`record_usage` 产出；T-40 按告警阈值转
/// `cache-waste-alert` 事件，阈值常量在 conex-telemetry）
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct CacheMiss {
    /// 浪费量（detectMiss 结果，已过噪声地板）
    pub missed_tokens: u64,
    /// 距上次请求完成时刻的空闲时长（毫秒）
    pub idle_ms: u64,
    /// 归因分类（conex-types MissAttribution，wire kebab-case）
    pub attribution: MissAttribution,
    /// 模型是否发生了变化（pi：模型切换不豁免，miss 仍计数）
    pub model_changed: bool,
}
