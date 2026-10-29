//! 推送决策引擎的常量与输出类型（engine.rs 拆分）。

use super::coalesce::CoalesceWindows;
use super::intent::PayloadDigest;
use super::quiet::QuietHoursConfig;
use super::scenes::SceneId;
use super::throttle::ThrottleLimits;
use super::{PushLevel, PushSeverity};

/// S10a 双推抑制窗口（D7 §3.3 S10a：run-terminal(failed) 到达后
/// 30 分钟内不再推 runtime-error）
pub const S10A_SUPPRESS_MS: u64 = 30 * 60_000;

/// S8e 任务归属映射最大容量（防常驻进程无界内存增长，ISSUE-14）
pub const MAX_TRACKED_TASK_OWNERS: usize = 1024;

/// S8e Run 终止来源映射最大容量（防常驻进程无界内存增长，ISSUE-14）
pub const MAX_TRACKED_RUN_SOURCES: usize = 1024;

/// S8e Run 终止来源最大保留时长（30 分钟，对齐 S10a 窗口）
pub const RUN_TERM_SOURCE_TTL_MS: u64 = S10A_SUPPRESS_MS;

/// S10a run-failed 抑制表最大容量（防 30min 窗口内高频失败风暴导致无界增长）
pub const MAX_TRACKED_RUN_FAILED: usize = 1024;

/// 静默时段夜间摘要折叠桶最大容量（防 9 小时静默窗口内高频事件无界累积）
pub const MAX_FOLDED_NIGHT_ITEMS: usize = 1024;

/// 极端高频广播防洪滑动窗口时长（1 秒，ISSUE-12）
pub const FLOOD_WINDOW_MS: u64 = 1_000;

/// 单滑动窗口（1 秒）内允许进入去重/合并/持久化的最大推送意图数（ISSUE-12）：
/// 超过该水位的瞬时洪峰在 $O(1)$ 时间内直接执行背压降级（`DecisionOutcome::Throttled`），
/// 防止高频事件风暴触发同步 SQLite 去重写入或无界合并桶膨胀而阻塞 Tokio 异步运行时。
/// 例外（推送丢失不可接受裁决）：P0 关键意图（`PushLevel::P0Critical`——审批
/// 请求/run 失败/安全拦截等 9 场景，见 [SceneId::level]）旁路防洪丢弃——
/// 防洪计数照常累加用于观测，但意图本身继续进入后续管线（审批是实时交互，
/// 必须立即送达，绝不静默丢弃或延迟到夜间）。
pub const FLOOD_MAX_INTENTS_PER_WINDOW: usize = 64;

/// 决策引擎配置（R3-01；R3-02/03 接线时从设置面装配）
#[derive(Debug, Clone)]
pub struct EngineConfig {
    /// 静默时段配置（默认 22:30-07:30）
    pub quiet: QuietHoursConfig,
    /// 节流护栏（每分钟 ≤2 / 每 10min ≤3 / 每日 ≤50）
    pub limits: ThrottleLimits,
    /// 合并窗口（60s / 10min）
    pub windows: CoalesceWindows,
    /// 去重 TTL（默认 24h）
    pub dedupe_ttl_ms: u64,
}

impl Default for EngineConfig {
    fn default() -> Self {
        Self {
            quiet: QuietHoursConfig::default(),
            limits: ThrottleLimits::default(),
            windows: CoalesceWindows::default(),
            dedupe_ttl_ms: super::dedupe::DEDUPE_TTL_MS,
        }
    }
}

/// 决策结果（管线输出；R3-02/03 的输入契约）
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PushDecision {
    /// 是否放行投递（false = 各环节抑制/折叠）
    pub deliver: bool,
    /// 命中场景（登记表行）
    pub scene: SceneId,
    /// 推送级别（P0/P1/P2）
    pub level: PushLevel,
    /// schema severity（critical/important/normal）
    pub severity: PushSeverity,
    /// 去重键（单条 = 场景键；合并 = merged 键）
    pub dedupe_key: String,
    /// 载荷摘要（copy 层输入）
    pub payload: PayloadDigest,
    /// 决策来源（intent/dedupe/quiet/throttle/coalesce 各环节）
    pub outcome: DecisionOutcome,
}

/// 决策来源标注（管线各环节产出；测试断言与审计用）
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DecisionOutcome {
    /// 正常放行（单条直发）
    Delivered,
    /// 合并/关闭信号产出（含单条 run 完成合并形态）
    Coalesced,
    /// 去重命中（TTL 内已推；含 S10a 双推抑制）
    DedupeSuppressed,
    /// 静默时段折叠进夜间摘要（P1）
    FoldedToNightSummary,
    /// 静默时段不推（P2）
    QuietSkipped,
    /// 节流超限折叠进摘要（含防洪滑窗背压限频）
    Throttled,
}
