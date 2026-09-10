//! 缓存计量标量面与归一化派生（协议无关）。
//!
//! 本模块复刻 P2 `cache_breakdown`（真源：`crates/agent-provider/src/events.rs:93-106`）
//! 的纯函数口径，供遥测侧独立消费。调用方负责把 `ProviderUsage` / `CacheBreakdown`
//! 映射为 [`CacheUsageScalars`] 或直接传入标量。

/// 协议族口径标记（P2 `CacheAccounting` 的标量镜像）。
///
/// 语义（C9 口径唯一真源）：`input_total = miss + read + write`；
/// Included 系下 `input_total = prompt`，Excluded 系下 `input_total = prompt + read + write`。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum CacheAccountingKind {
    /// OpenAI 系（chat/responses）：prompt 已含缓存
    #[default]
    Included,
    /// Anthropic/Gemini 系：prompt 不含缓存
    Excluded,
}

/// 缓存计量标量面（由调用方从 ProviderUsage / CacheBreakdown 映射）。
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct CacheUsageScalars {
    /// promptTokens（Included 系已含缓存；Excluded 系不含）
    pub prompt: u64,
    /// cacheReadTokens
    pub read: u64,
    /// cacheWriteTokens
    pub write: u64,
    /// 服务端直报的 miss（DeepSeek 顶层 prompt_cache_miss_tokens）；None = 需推导
    pub miss: Option<u64>,
    /// Included / Excluded 口径标记
    pub accounting: CacheAccountingKind,
}

/// 归一化派生结果（唯一口径：input_total = miss + read + write）。
///
/// `hit_ratio` / `write_ratio` 在 `input_total == 0` 时为 `None`
/// （调用方应隐藏而非显示 0%，对齐 P6 的 null 语义）。
#[derive(Debug, Clone, Copy, Default, PartialEq)]
pub struct CacheBreakdownMath {
    /// 缓存命中读取
    pub read: u64,
    /// 缓存写入
    pub write: u64,
    /// 未缓存输入（= 计费输入；服务端直报存在时优先）
    pub miss: u64,
    /// 归一化后的输入总量 = miss + read + write
    pub input_total: u64,
    /// 命中率 = read / input_total（input_total == 0 → None）
    pub hit_ratio: Option<f64>,
    /// 写入占比 = write / input_total（观测"写缓存成本"，opencode 溢出判定同源口径）
    pub write_ratio: Option<f64>,
}

impl CacheBreakdownMath {
    /// 纯函数复刻 P2 `cache_breakdown` 的 miss 与输入总量推导。
    ///
    /// 真源：`crates/agent-provider/src/events.rs:93-106`。推导规则：
    ///
    /// - `miss` 有服务端直报 → 优先取直报值；
    /// - 否则 Included：`miss = prompt - read - write`（saturating，负值钳 0）；
    /// - 否则 Excluded：`miss = prompt`；
    /// - `input_total`：Included → `prompt`；Excluded → `prompt + read + write`。
    ///
    /// 返回 `(miss, input_total)`。
    pub fn derive(
        read: u64,
        write: u64,
        miss: Option<u64>,
        prompt: u64,
        accounting: CacheAccountingKind,
    ) -> (u64, u64) {
        let miss = miss.unwrap_or_else(|| match accounting {
            CacheAccountingKind::Included => prompt.saturating_sub(read.saturating_add(write)),
            CacheAccountingKind::Excluded => prompt,
        });
        let input_total = match accounting {
            CacheAccountingKind::Included => prompt,
            CacheAccountingKind::Excluded => prompt.saturating_add(read).saturating_add(write),
        };
        (miss, input_total)
    }

    /// 由标量面构造完整派生结果（含命中率 / 写入占比）。
    pub fn from_usage(usage: CacheUsageScalars) -> CacheBreakdownMath {
        let (miss, input_total) = Self::derive(
            usage.read,
            usage.write,
            usage.miss,
            usage.prompt,
            usage.accounting,
        );
        let hit_ratio = (input_total != 0).then(|| usage.read as f64 / input_total as f64);
        let write_ratio = (input_total != 0).then(|| usage.write as f64 / input_total as f64);
        CacheBreakdownMath {
            read: usage.read,
            write: usage.write,
            miss,
            input_total,
            hit_ratio,
            write_ratio,
        }
    }

    /// 运行级聚合（同一 run 多 turn 的 usage 相加；分片内 max 合并已在 P2 完成）。
    ///
    /// 相加后按聚合值重算命中率与写入占比（派生值不累加）。
    pub fn add_assign(&mut self, other: &CacheBreakdownMath) {
        self.read = self.read.saturating_add(other.read);
        self.write = self.write.saturating_add(other.write);
        self.miss = self.miss.saturating_add(other.miss);
        self.input_total = self.input_total.saturating_add(other.input_total);
        self.hit_ratio =
            (self.input_total != 0).then(|| self.read as f64 / self.input_total as f64);
        self.write_ratio =
            (self.input_total != 0).then(|| self.write as f64 / self.input_total as f64);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scalars(
        prompt: u64,
        read: u64,
        write: u64,
        accounting: CacheAccountingKind,
    ) -> CacheUsageScalars {
        CacheUsageScalars {
            prompt,
            read,
            write,
            miss: None,
            accounting,
        }
    }

    #[test]
    fn derive_included_deduces_miss_from_prompt() {
        // prompt 已含缓存：miss = 100 - 70 - 10 = 20；input_total = prompt = 100
        let (miss, input_total) =
            CacheBreakdownMath::derive(70, 10, None, 100, CacheAccountingKind::Included);
        assert_eq!((miss, input_total), (20, 100));
    }

    #[test]
    fn derive_excluded_counts_prompt_as_miss() {
        // prompt 不含缓存：miss = prompt = 100；input_total = 100 + 70 + 10 = 180
        let (miss, input_total) =
            CacheBreakdownMath::derive(70, 10, None, 100, CacheAccountingKind::Excluded);
        assert_eq!((miss, input_total), (100, 180));
    }

    #[test]
    fn derive_reported_miss_takes_priority() {
        // 服务端直报 miss 优先于两口径推导
        let (miss, input_total) =
            CacheBreakdownMath::derive(70, 10, Some(15), 100, CacheAccountingKind::Included);
        assert_eq!((miss, input_total), (15, 100));
        let (miss, input_total) =
            CacheBreakdownMath::derive(70, 10, Some(15), 100, CacheAccountingKind::Excluded);
        assert_eq!((miss, input_total), (15, 180));
    }

    #[test]
    fn derive_clamps_negative_miss_to_zero() {
        // read + write 超过 prompt：推导 miss 钳 0，不 panic
        let (miss, input_total) =
            CacheBreakdownMath::derive(15, 5, None, 10, CacheAccountingKind::Included);
        assert_eq!((miss, input_total), (0, 10));
    }

    #[test]
    fn derive_zero_read_write_keeps_prompt() {
        let (miss, input_total) =
            CacheBreakdownMath::derive(0, 0, None, 100, CacheAccountingKind::Included);
        assert_eq!((miss, input_total), (100, 100));
        let (miss, input_total) =
            CacheBreakdownMath::derive(0, 0, None, 100, CacheAccountingKind::Excluded);
        assert_eq!((miss, input_total), (100, 100));
    }

    #[test]
    fn from_usage_computes_ratios() {
        let b = CacheBreakdownMath::from_usage(scalars(100, 70, 10, CacheAccountingKind::Included));
        assert_eq!(b.miss, 20);
        assert_eq!(b.input_total, 100);
        assert_eq!(b.hit_ratio, Some(0.7));
        assert_eq!(b.write_ratio, Some(0.1));
    }

    #[test]
    fn from_usage_zero_input_hides_ratios_as_none() {
        // input_total == 0 → 命中率/写入占比为 None（调用方隐藏而非显示 0%）
        let b = CacheBreakdownMath::from_usage(scalars(0, 0, 0, CacheAccountingKind::Included));
        assert_eq!(b.miss, 0);
        assert_eq!(b.input_total, 0);
        assert_eq!(b.hit_ratio, None);
        assert_eq!(b.write_ratio, None);
    }

    #[test]
    fn add_assign_accumulates_multi_turn() {
        // 同一 run 两个 turn 的 usage 逐项累加，派生占比按聚合值重算
        let mut acc =
            CacheBreakdownMath::from_usage(scalars(100, 70, 10, CacheAccountingKind::Included));
        let turn2 =
            CacheBreakdownMath::from_usage(scalars(100, 80, 5, CacheAccountingKind::Included));
        acc.add_assign(&turn2);
        assert_eq!(acc.read, 150);
        assert_eq!(acc.write, 15);
        assert_eq!(acc.miss, 35);
        assert_eq!(acc.input_total, 200);
        assert_eq!(acc.hit_ratio, Some(0.75));
        assert_eq!(acc.write_ratio, Some(0.075));
    }

    #[test]
    fn add_assign_empty_turn_is_noop() {
        let mut acc =
            CacheBreakdownMath::from_usage(scalars(100, 70, 10, CacheAccountingKind::Included));
        let empty = CacheBreakdownMath::from_usage(scalars(0, 0, 0, CacheAccountingKind::Included));
        acc.add_assign(&empty);
        assert_eq!(acc.read, 70);
        assert_eq!(acc.miss, 20);
        assert_eq!(acc.input_total, 100);
    }
}
