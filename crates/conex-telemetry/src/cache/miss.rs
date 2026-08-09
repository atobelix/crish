//! miss 检测与归因分类（纯函数）。
//!
//! 算法来源：
//!
//! - miss 检测：pi `detectMiss = min(prev, cur) - cacheRead`，噪声地板 1024
//!   （pi-cache-analysis.md:269-278）；
//! - 断裂判定：Claude Code 两阶段 `cacheRead 下降 >5% 且 >2000 token`
//!   （claude-code-cache-analysis.md:395-410）；
//! - 归因分类：jcode `KvCacheMissReason` 收缩为 7 类
//!   （jcode-cache-analysis.md:102-117）。

use crate::cache::math::CacheBreakdownMath;
use crate::cache::signature::{CacheBaseline, RequestSignature};

// ── 阈值常量（单一真源，对齐参考实现）──

/// 噪声地板（pi cache-stats.ts:11 / jcode app.rs:1607）：断点粒度噪声以下不计
pub const NOISE_FLOOR_TOKENS: u64 = 1024;
/// 断裂判定的下降百分比阈值（Claude Code 两阶段：>5%）
pub const BREAK_PCT: f64 = 0.05;
/// 断裂判定的绝对下降阈值（Claude Code 两阶段：>2000 token）
pub const BREAK_MIN_TOKENS: u64 = 2000;
/// 浪费预警的 miss 量阈值（pi TUI：missed ≥ 20k 才发预警）
pub const WARN_MISSED_TOKENS: u64 = 20_000;
/// 浪费预警的估算金额阈值（pi TUI：missed_cost ≥ $0.1 才发预警）
pub const WARN_MISSED_COST_USD: f64 = 0.10;
/// 命中率合理下限（jcode 85% 阈值，LowRead 判定用）
pub const LOW_HIT_RATIO_PCT: f64 = 0.85;

/// miss 归因分类（7 类，对齐 jcode `KvCacheMissReason` 收缩版；
/// jcode-cache-analysis.md:104-116）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MissReason {
    /// 更换供应商
    ProviderSwitch,
    /// 更换模型（pi：模型切换不豁免，miss 仍计数）
    ModelSwitch,
    /// 缓存 TTL 过期（空闲超时）
    Expired,
    /// system prompt 中途变化（harness 自伤）
    HarnessSystemChanged,
    /// 工具集中途变化（harness 自伤）
    HarnessToolsChanged,
    /// 早期消息被修改（harness 自伤）
    HarnessPrefixChanged,
    /// 无法归类（兜底）
    Unknown,
}

/// 归因分类（纯函数）。
///
/// 判定序（任务书 T-35 口径）：
///
/// 1. `ttl_secs > 0` 且 `idle_ms >= ttl_secs × 1000` → [`MissReason::Expired`]
///    （TTL 超时优先——空闲超时是最常见的合法 miss 原因，对齐 pi TUI
///    "idleMs ≥ CACHE_TTL_MS" 判定，pi-cache-analysis.md:292-293）；
/// 2. `provider_changed` → [`MissReason::ProviderSwitch`]；
/// 3. `model_changed` → [`MissReason::ModelSwitch`]；
/// 4. 存在基线且前缀哈希变化 → [`MissReason::HarnessSystemChanged`] /
///    [`MissReason::HarnessToolsChanged`] / [`MissReason::HarnessPrefixChanged`]
///    （按 system / tools / 消息前缀顺序判）；
/// 5. 其余 → [`MissReason::Unknown`]。
///
/// `prev_signature` 为 None（无基线 / 跨会话 / 压缩后作废）时不判前缀类，
/// 不产生 harness 误报（"宁缺勿误报"）。
pub fn classify(
    prev_signature: Option<&RequestSignature>,
    cur_signature: &RequestSignature,
    idle_ms: u64,
    ttl_secs: u64,
    model_changed: bool,
    provider_changed: bool,
) -> MissReason {
    // 1. TTL 超时优先（ttl_secs == 0 表示 TTL 未知，跳过该判定）
    if ttl_secs > 0 && idle_ms >= ttl_secs.saturating_mul(1000) {
        return MissReason::Expired;
    }
    // 2. 供应商 / 模型切换
    if provider_changed {
        return MissReason::ProviderSwitch;
    }
    if model_changed {
        return MissReason::ModelSwitch;
    }
    // 3. 前缀哈希变化（无基线时不判）
    if let Some(prev) = prev_signature {
        if prev.system_hash != cur_signature.system_hash {
            return MissReason::HarnessSystemChanged;
        }
        if prev.tools_hash != cur_signature.tools_hash {
            return MissReason::HarnessToolsChanged;
        }
        if prev.messages_prefix_changed(cur_signature) {
            return MissReason::HarnessPrefixChanged;
        }
    }
    // 4. 兜底
    MissReason::Unknown
}

/// miss 判定（pi detectMiss 算法 + Claude Code 断裂判定的合并）。
pub struct MissDetector;

impl MissDetector {
    /// 断裂判定（Claude Code 两阶段）：`cacheRead` 较上次下降 `>5%` 且
    /// 绝对下降 `>2000 token`。
    ///
    /// - `prev_read == 0` 时无法计算百分比，按"100% 下降"处理但绝对下降
    ///   必然为 0，因此结果恒为 false（防除零且语义安全）；
    /// - 第三参数 `prev_input_total` 为签名对齐保留参数（任务书 T-35 的
    ///   `prev_prompt`：上次请求提示体积）；当前判定口径只消费 read 两值，
    ///   后续如需"按提示体积锚定百分比"可在此接入。
    pub fn is_break(prev_read: u64, cur_read: u64, _prev_input_total: u64) -> bool {
        let drop = prev_read.saturating_sub(cur_read);
        let pct = if prev_read > 0 {
            drop as f64 / prev_read as f64
        } else {
            1.0
        };
        drop > BREAK_MIN_TOKENS && pct > BREAK_PCT
    }

    /// miss 检测（pi detectMiss 算法，纯标量版）：
    /// `missed = min(prev_prompt, cur_prompt) - cur_cache_read`。
    ///
    /// - 取上一轮与本轮提示体积的较小值——上界语义是"上轮全量缓存了、
    ///   本轮本该全量命中却重新付费的部分"；提示本身变小（如压缩）时 miss 不虚高；
    /// - `missed <= noise_floor` 不计（噪声地板默认 [`NOISE_FLOOR_TOKENS`]）；
    /// - `cur_cache_read > min(prev, cur)`（负值）→ None；
    /// - 返回 None = 不告警。
    pub fn detect_miss(
        prev_prompt: u64,
        cur_prompt: u64,
        cur_cache_read: u64,
        noise_floor: u64,
    ) -> Option<u64> {
        let expected = prev_prompt.min(cur_prompt);
        let missed = expected.checked_sub(cur_cache_read)?; // 负值 → None
        (missed > noise_floor).then_some(missed)
    }

    /// 基线感知的 miss 检测（供跟踪器跨轮消费）。
    ///
    /// - 无基线（跨会话 / 压缩后作废）→ None（首轮属正常冷缓存，不计 miss）；
    /// - `reported_cache` 粘性（pi cache-stats.ts:37-48, 63-68）：本会话此前
    ///   从未报告过 cacheRead/cacheWrite > 0（如无缓存能力的本地服务器）→
    ///   None，避免把"根本不支持缓存"误报为"缓存全丢"；
    /// - 通过后按 [`Self::detect_miss`] 判定，噪声地板取 [`NOISE_FLOOR_TOKENS`]。
    ///
    /// 归因分类由调用方用 [`classify`] 组合（基线签名 + 当前签名 + 时间 + 切换标记）。
    pub fn detect(
        prev: Option<&CacheBaseline>,
        cur: &CacheBreakdownMath,
        reported_cache: bool,
    ) -> Option<u64> {
        let baseline = prev?;
        if !reported_cache {
            return None;
        }
        Self::detect_miss(
            baseline.input_total,
            cur.input_total,
            cur.read,
            NOISE_FLOOR_TOKENS,
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sig(system_hash: u64, tools_hash: u64, message_hashes: Vec<u64>) -> RequestSignature {
        let message_count = message_hashes.len();
        RequestSignature {
            system_hash,
            tools_hash,
            message_hashes,
            message_count,
            tool_count: 0,
            messages_hash: 0,
        }
    }

    #[test]
    fn miss_reason_has_exactly_seven_variants() {
        // 钉死 7 类枚举完整性（防未来缩减）；2026-08-09 遥测零消费清理
        // 删除 UpstreamSwitch（classify 无对应输入、上层无直构方、wire 层
        // MissAttribution 无对应类——纯冗余），其余 7 类均可由 classify 产生
        // （见各分类测试）
        let reasons = [
            MissReason::ProviderSwitch,
            MissReason::ModelSwitch,
            MissReason::Expired,
            MissReason::HarnessSystemChanged,
            MissReason::HarnessToolsChanged,
            MissReason::HarnessPrefixChanged,
            MissReason::Unknown,
        ];
        assert_eq!(reasons.len(), 7);
    }

    // ── detect_miss 各分支 ──

    #[test]
    fn detect_miss_above_floor_returns_missed() {
        // 上轮与本轮同为 10000，缓存读 8000 → miss 2000
        assert_eq!(MissDetector::detect_miss(10000, 10000, 8000, NOISE_FLOOR_TOKENS), Some(2000));
    }

    #[test]
    fn detect_miss_uses_min_of_prev_and_cur() {
        // 本轮提示变小（压缩）：取较小值 5000 - 3000 = 2000，miss 不虚高
        assert_eq!(MissDetector::detect_miss(10000, 5000, 3000, NOISE_FLOOR_TOKENS), Some(2000));
        // 反向：上轮小本轮大，同样取 5000 作上界
        assert_eq!(MissDetector::detect_miss(5000, 10000, 3000, NOISE_FLOOR_TOKENS), Some(2000));
    }

    #[test]
    fn detect_miss_at_noise_floor_is_ignored() {
        // missed 恰好等于地板 1024 → 不计（"以下不计"含等号）
        assert_eq!(MissDetector::detect_miss(10000, 10000, 8976, NOISE_FLOOR_TOKENS), None);
    }

    #[test]
    fn detect_miss_just_above_floor_counts() {
        // missed = 1025 > 1024 → 计
        assert_eq!(MissDetector::detect_miss(10000, 10000, 8975, NOISE_FLOOR_TOKENS), Some(1025));
    }

    #[test]
    fn detect_miss_zero_read_reports_full_prompt() {
        assert_eq!(MissDetector::detect_miss(10000, 10000, 0, NOISE_FLOOR_TOKENS), Some(10000));
    }

    #[test]
    fn detect_miss_negative_returns_none() {
        // 本轮 read 高于上界（异常上报）→ 负值 → None
        assert_eq!(MissDetector::detect_miss(10000, 10000, 12000, NOISE_FLOOR_TOKENS), None);
    }

    #[test]
    fn detect_miss_full_hit_is_zero_and_ignored() {
        // read 恰好等于上界 → missed 0 → 不计
        assert_eq!(MissDetector::detect_miss(10000, 10000, 10000, NOISE_FLOOR_TOKENS), None);
        assert_eq!(MissDetector::detect_miss(10000, 8000, 8000, NOISE_FLOOR_TOKENS), None);
    }

    #[test]
    fn detect_miss_zero_floor_still_hides_zero() {
        // 自定义地板 0：missed > 0 才计；missed == 0 不计
        assert_eq!(MissDetector::detect_miss(10000, 10000, 5000, 0), Some(5000));
        assert_eq!(MissDetector::detect_miss(10000, 10000, 10000, 0), None);
    }

    // ── is_break 边界 ──

    #[test]
    fn is_break_true_when_drop_exceeds_both_thresholds() {
        // 下降 2001 token（5.0025%）且 >2000 → true
        assert!(MissDetector::is_break(40000, 37999, 40000));
        // 下降 3000 token（6%）→ true
        assert!(MissDetector::is_break(50000, 47000, 50000));
    }

    #[test]
    fn is_break_false_when_pct_below_threshold() {
        // 下降 1500 token（3%）→ pct 不足 → false
        assert!(!MissDetector::is_break(50000, 48500, 50000));
    }

    #[test]
    fn is_break_false_when_tokens_below_threshold() {
        // 下降 2000 token 恰好等于下限（严格 >2000）→ false；
        // 下降 2001 但 pct 4.76% < 5% → false
        assert!(!MissDetector::is_break(40000, 38000, 40000));
        assert!(!MissDetector::is_break(42000, 39999, 42000));
    }

    #[test]
    fn is_break_false_when_prev_read_is_zero() {
        // 无缓存基线（prev_read == 0）：绝对下降 0 → false（防除零）
        assert!(!MissDetector::is_break(0, 0, 10000));
    }

    #[test]
    fn is_break_false_on_equal_read() {
        assert!(!MissDetector::is_break(50000, 50000, 50000));
    }

    // ── classify 判定序（TTL 优先 → 切换 → 前缀 → 兜底）──

    #[test]
    fn classify_expired_wins_over_switches() {
        // 任务书 T-35 口径：TTL 超时优先于一切切换标记
        let prev = sig(1, 1, vec![1, 2, 3]);
        let cur = sig(1, 1, vec![1, 2, 3]);
        assert_eq!(
            classify(Some(&prev), &cur, 60_000, 60, true, true),
            MissReason::Expired
        );
    }

    #[test]
    fn classify_expired_boundary_is_inclusive() {
        // idle 恰好等于 TTL（idle >= ttl × 1000）→ Expired
        let prev = sig(1, 1, vec![1]);
        let cur = sig(1, 1, vec![1]);
        assert_eq!(classify(Some(&prev), &cur, 60_000, 60, false, false), MissReason::Expired);
        // idle 差 1ms 未超 TTL → 继续向下判定（本场景无其他变化 → Unknown）
        assert_eq!(classify(Some(&prev), &cur, 59_999, 60, false, false), MissReason::Unknown);
    }

    #[test]
    fn classify_ttl_zero_skips_expired() {
        // ttl_secs == 0（TTL 未知）→ 不判 Expired
        let prev = sig(1, 1, vec![1]);
        let cur = sig(1, 1, vec![1]);
        assert_eq!(classify(Some(&prev), &cur, 10_000_000, 0, false, false), MissReason::Unknown);
    }

    #[test]
    fn classify_provider_switch() {
        let prev = sig(1, 1, vec![1, 2]);
        let cur = sig(1, 1, vec![1, 2]);
        assert_eq!(
            classify(Some(&prev), &cur, 1_000, 60, false, true),
            MissReason::ProviderSwitch
        );
    }

    #[test]
    fn classify_model_switch() {
        let prev = sig(1, 1, vec![1, 2]);
        let cur = sig(1, 1, vec![1, 2]);
        assert_eq!(
            classify(Some(&prev), &cur, 1_000, 60, true, false),
            MissReason::ModelSwitch
        );
    }

    #[test]
    fn classify_harness_system_changed() {
        let prev = sig(1, 1, vec![1, 2]);
        let cur = sig(9, 1, vec![1, 2]);
        assert_eq!(
            classify(Some(&prev), &cur, 1_000, 60, false, false),
            MissReason::HarnessSystemChanged
        );
    }

    #[test]
    fn classify_harness_tools_changed() {
        let prev = sig(1, 1, vec![1, 2]);
        let cur = sig(1, 9, vec![1, 2]);
        assert_eq!(
            classify(Some(&prev), &cur, 1_000, 60, false, false),
            MissReason::HarnessToolsChanged
        );
    }

    #[test]
    fn classify_harness_prefix_changed() {
        let prev = sig(1, 1, vec![1, 2, 3]);
        let cur = sig(1, 1, vec![1, 99, 3]);
        assert_eq!(
            classify(Some(&prev), &cur, 1_000, 60, false, false),
            MissReason::HarnessPrefixChanged
        );
    }

    #[test]
    fn classify_prefix_checks_ordered_system_then_tools_then_messages() {
        // system 变化优先于 tools/消息前缀
        let prev = sig(1, 1, vec![1, 2]);
        let cur = sig(9, 9, vec![9]);
        assert_eq!(
            classify(Some(&prev), &cur, 1_000, 60, false, false),
            MissReason::HarnessSystemChanged
        );
        // system 相同、tools 变化优先于消息前缀
        let prev = sig(1, 1, vec![1, 2]);
        let cur = sig(1, 9, vec![1, 99]);
        assert_eq!(
            classify(Some(&prev), &cur, 1_000, 60, false, false),
            MissReason::HarnessToolsChanged
        );
    }

    #[test]
    fn classify_unknown_when_unchanged() {
        let prev = sig(1, 1, vec![1, 2, 3]);
        let cur = sig(1, 1, vec![1, 2, 3, 4]); // 纯追加不算前缀被改
        assert_eq!(classify(Some(&prev), &cur, 1_000, 60, false, false), MissReason::Unknown);
    }

    #[test]
    fn classify_no_baseline_never_reports_harness() {
        // 无基线（跨会话/压缩后）：不判前缀类，只可能 Expired/切换/Unknown
        let cur = sig(1, 1, vec![1]);
        assert_eq!(classify(None, &cur, 1_000, 60, false, false), MissReason::Unknown);
        assert_eq!(classify(None, &cur, 1_000, 60, true, false), MissReason::ModelSwitch);
        assert_eq!(classify(None, &cur, 10_000_000, 60, false, false), MissReason::Expired);
    }

    // ── detect（基线 + 粘性）──

    fn baseline(input_total: u64, generation: u64) -> crate::cache::signature::CacheBaseline {
        crate::cache::signature::CacheBaseline {
            signature: sig(1, 1, vec![1, 2, 3]),
            input_total,
            read: 0,
            provider: "deepseek".to_string(),
            model: "deepseek-v4-flash".to_string(),
            completed_at_ms: 1000,
            generation,
        }
    }

    fn math(read: u64, input_total: u64) -> crate::cache::CacheBreakdownMath {
        crate::cache::CacheBreakdownMath {
            read,
            write: 0,
            miss: input_total.saturating_sub(read),
            input_total,
            hit_ratio: None,
            write_ratio: None,
        }
    }

    #[test]
    fn detect_with_no_baseline_returns_none() {
        // 压缩后基线作废 / 跨会话首轮 → 不计 miss
        assert_eq!(MissDetector::detect(None, &math(8000, 10000), true), None);
    }

    #[test]
    fn detect_respects_reported_cache_sticky_flag() {
        // 本会话从未报告过缓存活动（如无缓存能力的本地服务器）→ 不计
        assert_eq!(
            MissDetector::detect(Some(&baseline(10000, 0)), &math(0, 10000), false),
            None
        );
        // 报告过缓存 → 正常计
        assert_eq!(
            MissDetector::detect(Some(&baseline(10000, 0)), &math(8000, 10000), true),
            Some(2000)
        );
    }

    #[test]
    fn detect_respects_noise_floor_and_min_semantics() {
        // 地板以下 → None
        assert_eq!(
            MissDetector::detect(Some(&baseline(10000, 0)), &math(8976, 10000), true),
            None
        );
        // min(prev, cur) 语义：基线 10000、本轮 5000 → 上界 5000
        assert_eq!(
            MissDetector::detect(Some(&baseline(10000, 0)), &math(3000, 5000), true),
            Some(2000)
        );
    }
}
