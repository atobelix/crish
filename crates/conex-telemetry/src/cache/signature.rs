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
}
