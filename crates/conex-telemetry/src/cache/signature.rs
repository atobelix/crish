//! 请求签名与缓存基线（请求前快照，纯数据 + 前缀对比纯函数）。
//!
//! 对齐 jcode `KvCacheRequestSignature` / `KvCacheBaseline` 与 Reasonix
//! `PrefixShape` 的收缩版（jcode-cache-analysis.md:85-149）。签名只做
//! "测量用的只读哈希投影"，不改请求字节（P5 §1.3 设计原则 1）。

/// 请求签名（请求前对可缓存部分做哈希投影，用于轮间对比）。
///
/// 投影剔除项（jcode-cache-analysis.md:159-168）：timestamp / tool_duration_ms /
/// reasoning_trace / cache_control 标记——这些字段每轮变化但与缓存前缀无关，
/// 不剔除会导致伪 miss。保留项：system / tools / 逐消息内容。
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct RequestSignature {
    /// system prompt 字节哈希（P1 透传后非 None 时）
    pub system_hash: u64,
    /// tools schema 整体序列化字节哈希（P1 排序后）
    pub tools_hash: u64,
    /// 消息前缀投影整体哈希
    pub messages_hash: u64,
    /// 逐消息哈希（前缀逐条对比用）
    pub message_hashes: Vec<u64>,
    /// 消息条数
    pub message_count: usize,
    /// 工具条数
    pub tool_count: usize,
}

impl RequestSignature {
    /// 消息前缀哈希是否发生变化。
    ///
    /// 会话是 append-only：消息只追加不修改，因此只比较两方**都存在的**
    /// 前 N 条（N = 较少一方的条数）；前 N 条一致即视为前缀未改，
    /// 后续纯追加不构成"前缀被改"（对齐 jcode CacheTracker 的前缀哈希链语义）。
    pub fn messages_prefix_changed(&self, other: &RequestSignature) -> bool {
        let n = self.message_hashes.len().min(other.message_hashes.len());
        self.message_hashes[..n] != other.message_hashes[..n]
    }
}

/// 前缀差异类型（T-25：压缩后签名比对的判定三态，不动 `classify` 枚举）。
///
/// - [`PrefixDiffKind::Identical`]：两哈希数组完全一致（正常路径）；
/// - [`PrefixDiffKind::TailAppend`]：cur 是 prev 的严格超集（纯追加，
///   append-only 正常路径——追加区豁免，不构成 harness 改写）；
/// - [`PrefixDiffKind::HeadRewrite`]：首个差异出现在 prev 范围之内或
///   cur 为 prev 截断（历史被改写——压缩后二次改写的诊断信号）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PrefixDiffKind {
    /// 完全一致（index = 公共长度）
    Identical,
    /// cur 在 prev 之后纯追加（index = prev.len()，首个新增位）
    TailAppend,
    /// 差异点在历史区（index = 首个差异位置；cur 为 prev 截断时 index = cur.len()）
    HeadRewrite,
}

/// 前缀差异定位结果（T-25）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PrefixDiff {
    /// 差异类型
    pub kind: PrefixDiffKind,
    /// 首个差异位置（Identical = 公共长度；TailAppend = prev.len()；
    /// HeadRewrite = 首个不等下标 / 截断处）
    pub index: usize,
}

/// 前缀差异定位（纯函数，v1.1 §5.1 T-30 / 02 分析 §五 E4 / 评审 02 P1-4）：
/// 逐位比较两签名哈希数组（消息前缀逐条哈希），返回首个差异位置与差异类型。
///
/// 语义：
/// - `prev == cur` → [`PrefixDiffKind::Identical`]（index = 公共长度）；
/// - cur 是 prev 的严格超集且公共前缀一致 → [`PrefixDiffKind::TailAppend`]
///   （index = prev.len()——追加区豁免：压缩后首请求前被追加的新消息
///   不构成 harness 改写）；
/// - 首个差异出现在 prev 范围内（或 cur 为 prev 的截断，即 prev 更长）→
///   [`PrefixDiffKind::HeadRewrite`]（index = 首个差异位置）。
pub fn prefix_diff_index(prev: &[u64], cur: &[u64]) -> PrefixDiff {
    let n = prev.len().min(cur.len());
    for i in 0..n {
        if prev[i] != cur[i] {
            return PrefixDiff {
                kind: PrefixDiffKind::HeadRewrite,
                index: i,
            };
        }
    }
    match prev.len().cmp(&cur.len()) {
        std::cmp::Ordering::Equal => PrefixDiff {
            kind: PrefixDiffKind::Identical,
            index: prev.len(),
        },
        std::cmp::Ordering::Less => PrefixDiff {
            kind: PrefixDiffKind::TailAppend,
            index: prev.len(),
        },
        std::cmp::Ordering::Greater => PrefixDiff {
            kind: PrefixDiffKind::HeadRewrite,
            index: cur.len(),
        },
    }
}

/// 缓存基线（上次请求的前快照，跨 run 由 engine 层维护）。
///
/// 双保险（对齐 jcode `KvCacheBaseline`）：跨会话 / 跨压缩代数（`generation`
/// 由 P4 压缩事件递增）视为不存在，避免把"换会话 / 已压缩"误报成前缀被改。
#[derive(Debug, Clone, Default)]
pub struct CacheBaseline {
    /// 上次请求的请求签名
    pub signature: RequestSignature,
    /// 上次请求的真实提示体积（冷缓存预警"重发 ~N tok"用）
    pub input_total: u64,
    /// 供应商标识（归因 ProviderSwitch 用）
    pub provider: String,
    /// 模型标识（归因 ModelSwitch 用）
    pub model: String,
    /// 上次请求完成时刻（毫秒时间戳；空闲超 TTL 判定用）
    pub completed_at_ms: u64,
    /// 压缩代数（P4 事件递增；代数变化 ⇒ 基线作废）
    pub generation: u64,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn messages_prefix_changed_detects_early_modification() {
        let prev = RequestSignature {
            message_hashes: vec![1, 2, 3],
            message_count: 3,
            ..Default::default()
        };
        // 第二条消息被改写（哈希 2 → 99）
        let cur = RequestSignature {
            message_hashes: vec![1, 99, 3],
            message_count: 3,
            ..Default::default()
        };
        assert!(prev.messages_prefix_changed(&cur));
    }

    #[test]
    fn messages_prefix_changed_ignores_append_only_growth() {
        let prev = RequestSignature {
            message_hashes: vec![1, 2, 3],
            message_count: 3,
            ..Default::default()
        };
        // 正常追加：前 3 条一致，不构成前缀被改
        let cur = RequestSignature {
            message_hashes: vec![1, 2, 3, 4, 5],
            message_count: 5,
            ..Default::default()
        };
        assert!(!prev.messages_prefix_changed(&cur));
    }

    #[test]
    fn messages_prefix_changed_truncated_history_counts() {
        // 历史被截断（压缩/删除旧消息）：前 N 条（2 条）不一致 → 判定前缀被改
        let prev = RequestSignature {
            message_hashes: vec![1, 2, 3],
            message_count: 3,
            ..Default::default()
        };
        let cur = RequestSignature {
            message_hashes: vec![3, 4],
            message_count: 2,
            ..Default::default()
        };
        assert!(prev.messages_prefix_changed(&cur));
    }

    #[test]
    fn messages_prefix_changed_both_empty_is_false() {
        let a = RequestSignature::default();
        let b = RequestSignature::default();
        assert!(!a.messages_prefix_changed(&b));
    }

    // ── prefix_diff_index（T-25：三态 + 边界）──

    /// 完全一致 → Identical，index = 公共长度
    #[test]
    fn prefix_diff_index_identical() {
        let d = prefix_diff_index(&[1, 2, 3], &[1, 2, 3]);
        assert_eq!(d.kind, PrefixDiffKind::Identical);
        assert_eq!(d.index, 3);
    }

    /// 纯追加（cur 是 prev 严格超集）→ TailAppend，index = prev.len()
    #[test]
    fn prefix_diff_index_tail_append() {
        let d = prefix_diff_index(&[1, 2, 3], &[1, 2, 3, 4, 5]);
        assert_eq!(d.kind, PrefixDiffKind::TailAppend);
        assert_eq!(d.index, 3);
    }

    /// 首个差异出现在历史区 → HeadRewrite，index = 首个不等下标
    #[test]
    fn prefix_diff_index_head_rewrite() {
        let d = prefix_diff_index(&[1, 2, 3], &[1, 99, 3]);
        assert_eq!(d.kind, PrefixDiffKind::HeadRewrite);
        assert_eq!(d.index, 1);
    }

    /// 空数组边界：两者皆空 → Identical，index = 0
    #[test]
    fn prefix_diff_index_both_empty() {
        let d = prefix_diff_index(&[], &[]);
        assert_eq!(d.kind, PrefixDiffKind::Identical);
        assert_eq!(d.index, 0);
    }

    /// prev 更长（cur 为 prev 截断）→ HeadRewrite，index = cur.len()
    #[test]
    fn prefix_diff_index_prev_longer_is_rewrite() {
        let d = prefix_diff_index(&[1, 2, 3], &[1, 2]);
        assert_eq!(d.kind, PrefixDiffKind::HeadRewrite);
        assert_eq!(d.index, 2);
    }

    /// 长度不同且首个差异在公共区内 → HeadRewrite 定位首个不等处
    #[test]
    fn prefix_diff_index_len_diff_with_inner_diff() {
        let d = prefix_diff_index(&[1, 2, 3], &[1, 99, 3, 4]);
        assert_eq!(d.kind, PrefixDiffKind::HeadRewrite);
        assert_eq!(d.index, 1);
    }
}
