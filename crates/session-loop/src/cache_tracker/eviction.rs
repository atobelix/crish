//! 缓存 miss 归因与断裂/驱逐判定（P5 §3.4.2 / §3.4.3）

use conex_telemetry::cache::{
    classify, CacheBaseline, CacheBreakdownMath, MissDetector, MissReason, RequestSignature,
    LOW_HIT_RATIO_PCT,
};
use conex_types::events::MissAttribution;

use super::tracker::CacheStatsTracker;

impl CacheStatsTracker {
    /// 归因组合（P5 §3.4.3 分类序 + T-35 `classify` 判定序的映射层）：
    ///
    /// 1. 压缩代数变化 → `Compaction`（C13 防御路径：`on_compaction` 已作废
    ///    基线，正常不可达；此归因用于历史事件解释）；
    /// 2. `classify`（TTL 超时优先 → 供应商 / 模型切换 → 前缀哈希变化，
    ///    任务书 T-35 口径）映射为 7 类；
    /// 3. `Unknown` 兜底细化：read == 0 且报告过缓存 → `ZeroRead`；
    ///    断裂判定（cacheRead 骤降 >5% 且 >2000 token）或命中率低于 85%
    ///    → `LowRead`；其余 `Unknown`（`Cold` 只在无基线时出现——此时
    ///    detect 不计 miss，故不产出）。
    pub(super) fn classify_miss(
        &self,
        breakdown: &CacheBreakdownMath,
        completed_at_ms: u64,
    ) -> MissAttribution {
        let baseline = self.baseline.as_ref();
        // 1. 压缩代数变化（正常不可达的防御分支）
        if let Some(b) = baseline {
            if b.generation != self.generation {
                return MissAttribution::Compaction;
            }
        }
        let model_changed =
            self.model_switch_pending || baseline.is_some_and(|b| b.model != self.model);
        let provider_changed = baseline.is_some_and(|b| b.provider != self.provider);
        let idle_ms = baseline.map_or(0, |b| completed_at_ms.saturating_sub(b.completed_at_ms));
        // 模型切换待归因 / 无捕获签名时跳过前缀类判定（宁缺勿误报）
        let prev_signature = if self.model_switch_pending {
            None
        } else {
            baseline.map(|b| &b.signature)
        };
        let default_signature = RequestSignature::default();
        let cur_signature = self
            .pending_signature
            .as_ref()
            .unwrap_or(&default_signature);
        let reason = classify(
            prev_signature,
            cur_signature,
            idle_ms,
            self.ttl_seconds,
            model_changed,
            provider_changed,
        );
        match reason {
            MissReason::Expired => MissAttribution::IdleTtlExpired,
            MissReason::ProviderSwitch | MissReason::ModelSwitch => MissAttribution::ModelSwitch,
            MissReason::HarnessSystemChanged
            | MissReason::HarnessToolsChanged
            | MissReason::HarnessPrefixChanged => MissAttribution::PrefixChanged,
            MissReason::Unknown => {
                // 兜底细化（P5 §3.4.3 第 7-8 类；detect 已保证 reported_cache）
                if breakdown.read == 0 {
                    MissAttribution::ZeroRead
                } else if self.is_break_signal(baseline, breakdown)
                    || breakdown.hit_ratio.is_none_or(|r| r < LOW_HIT_RATIO_PCT)
                {
                    MissAttribution::LowRead
                } else {
                    MissAttribution::Unknown
                }
            }
        }
    }

    /// 断裂判定信号（P5 §3.4.2 / DEEPCHECK-05 #5 接线点）：`cacheRead` 较
    /// 上次骤降 >5% 且绝对下降 >2000 token → 缓存条目被驱逐 / 断裂的强
    /// 信号，兜底归因 LowRead（签名未变、未过期、未切换时仍低命中的最
    /// 可能解释；Claude Code 两阶段口径，[`MissDetector::is_break`]）。
    ///
    /// 无基线（首轮 / 压缩后）→ false（无 prev_read 可比较）。
    pub(super) fn is_break_signal(
        &self,
        baseline: Option<&CacheBaseline>,
        cur: &CacheBreakdownMath,
    ) -> bool {
        let Some(b) = baseline else {
            return false;
        };
        MissDetector::is_break(b.read, cur.read, b.input_total)
    }
}
