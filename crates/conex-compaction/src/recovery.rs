//! 压缩块元数据与块引用行（T-11；可追溯 / 可恢复索引面）
//!
//! 职责（01 §2.1 / 00-plan §4.4）：一次压缩动作形成一个「压缩块」，本模块
//! 承载块元数据结构、块引用行（槽位内机器可读文本）与事件 details 载荷
//! 序列化。本 crate 保持纯算法无运行时依赖——只产决策与元数据，不落库；
//! 持久化与检索（compression_blocks 表 + decompress/search 工具）由后续
//! 轮次（conex-db / agent-tools）接线。

use crate::summary_document::SUMMARY_SCHEMA_VERSION;

/// 摘要状态机（00-plan §6.1：awaiting → committed | retired）
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SummaryState {
    /// 压缩时创建（同步失败/无注入）：对话内为中性 stub，后台可续试
    Awaiting,
    /// 摘要就绪（同步成功）：JSON 文档已写表，链文本 = md 渲染投影
    Committed,
    /// 重试耗尽：stub 永驻（R-C），下一轮压缩经 existing 通道续试
    Retired,
}

impl SummaryState {
    /// 状态 → 事件 details 载荷字面量（camelCase 对齐，01 §4.3）
    pub fn as_str(&self) -> &'static str {
        match self {
            SummaryState::Awaiting => "awaiting",
            SummaryState::Committed => "committed",
            SummaryState::Retired => "retired",
        }
    }
}

/// 压缩块元数据（00-plan §4.4；R-A 单表合并后的列全量）
///
/// 与 `compression_blocks` 表行一一对应：压缩时创建（INSERT OR IGNORE，
/// 幂等键 session_id+block_id），调度器成功后 UPDATE 推进状态。
/// 原文不重复落库——dropped 消息全文经 events 表 message-end 事件回放恢复。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CompactionBlockMeta {
    /// 会话 id（R-A 复合主键 (session_id, block_id) 的一半）
    pub session_id: String,
    /// 块 id（R-B：与链内摘要消息 id 同名 `compacted-summary-{gen}-{fold}`）
    pub block_id: String,
    /// context-compression-end 事件序列号（定位事件行）
    pub sequence: u64,
    /// 会话级压缩代数（R-K 单源：SessionContextMeta.last_compaction_generation）
    pub generation: u32,
    /// 迭代合并上游块（null = 首块 / 未合并）
    pub prev_block_id: Option<String>,
    /// 被压缩（丢弃并进入摘要）的消息 id 清单
    pub dropped_message_ids: Vec<String>,
    /// 保留段首条消息 id（切割下界引用，M2 断言用）
    pub first_kept_message_id: Option<String>,
    /// 链内文本（md 渲染投影或 stub；R-G 语源唯一）
    pub summary: String,
    /// 摘要是否来自 LLM（同步成功路径）
    pub summary_is_llm: bool,
    pub tokens_before: u64,
    pub tokens_after: u64,
    /// 压缩时刻 epoch 毫秒
    pub dropped_at_ms: i64,
    /// 摘要状态（awaiting / committed / retired）
    pub state: SummaryState,
    /// 提交后的 JSON 规范文档（committed 时填充；stub 期为 None）
    pub summary_json: Option<String>,
    /// 摘要文档 Schema 版本
    pub schema_version: u32,
    /// 树高度（每次迭代合并 +1）
    pub height: u32,
    /// 分层标签（chunk / rolling / final；本轮仅落 chunk/rolling 语义）
    pub tier: Option<String>,
    /// 累计尝试次数（含同步那次；00-plan §6.4 口径）
    pub attempts: u32,
    pub created_at: i64,
    pub updated_at: i64,
}

impl CompactionBlockMeta {
    /// 必要参数构造；派生字段取缺省：summary_json=None、
    /// schema_version=[SUMMARY_SCHEMA_VERSION]、height=1、tier=None、
    /// attempts=1、created_at/updated_at=dropped_at_ms。
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        session_id: impl Into<String>,
        block_id: impl Into<String>,
        sequence: u64,
        generation: u32,
        prev_block_id: Option<String>,
        dropped_message_ids: Vec<String>,
        first_kept_message_id: Option<String>,
        summary: impl Into<String>,
        summary_is_llm: bool,
        tokens_before: u64,
        tokens_after: u64,
        dropped_at_ms: i64,
        state: SummaryState,
    ) -> Self {
        Self {
            session_id: session_id.into(),
            block_id: block_id.into(),
            sequence,
            generation,
            prev_block_id,
            dropped_message_ids,
            first_kept_message_id,
            summary: summary.into(),
            summary_is_llm,
            tokens_before,
            tokens_after,
            dropped_at_ms,
            state,
            summary_json: None,
            schema_version: SUMMARY_SCHEMA_VERSION,
            height: 1,
            tier: None,
            attempts: 1,
            created_at: dropped_at_ms,
            updated_at: dropped_at_ms,
        }
    }
}

/// 块引用行（链内机器可读槽位文本；01 §2.2 / 00-plan §4.4）
///
/// 人读友好 + 机器可寻址：恢复指令指向 `decompress_context(blockId=...)`；
/// 该文本为确定性生成（同入参同输出），stub/渲染共用此引用行形态。
pub fn slot_text(block_id: &str, dropped_count: usize, generation: u32) -> String {
    format!(
        "[Compacted {dropped_count} earlier message(s) · block {block_id} · generation {generation} · 恢复: decompress_context(blockId=\"{block_id}\")]"
    )
}

impl CompactionBlockMeta {
    /// 事件 details 扩展载荷（camelCase：blockId / generation / prevBlockId /
    /// droppedAtMs / summaryState；对齐既有 coversUpToTurn / degraded /
    /// summaryAttempts 键，01 §4.3）
    pub fn to_details_json(&self) -> serde_json::Value {
        serde_json::json!({
            "blockId": self.block_id,
            "generation": self.generation,
            "prevBlockId": self.prev_block_id,
            "droppedAtMs": self.dropped_at_ms,
            "summaryState": self.state.as_str(),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::{slot_text, CompactionBlockMeta, SummaryState};

    fn sample_meta() -> CompactionBlockMeta {
        CompactionBlockMeta::new(
            "session-1",
            "compacted-summary-1-2",
            42,
            1,
            Some("compacted-summary-1-1".to_string()),
            vec!["u1".to_string(), "a1".to_string()],
            Some("u2".to_string()),
            "[Compacted 2 earlier message(s) · block compacted-summary-1-2 · generation 1 · 恢复: decompress_context(blockId=\"compacted-summary-1-2\")]",
            false,
            10_000,
            2_000,
            1_752_000_000_000,
            SummaryState::Awaiting,
        )
    }

    #[test]
    fn new_applies_defaults() {
        let meta = sample_meta();
        assert_eq!(meta.session_id, "session-1");
        assert_eq!(meta.block_id, "compacted-summary-1-2");
        assert_eq!(meta.sequence, 42);
        assert_eq!(meta.generation, 1);
        assert_eq!(meta.prev_block_id.as_deref(), Some("compacted-summary-1-1"));
        assert_eq!(
            meta.dropped_message_ids,
            vec!["u1".to_string(), "a1".to_string()]
        );
        assert_eq!(meta.first_kept_message_id.as_deref(), Some("u2"));
        assert!(!meta.summary_is_llm);
        assert_eq!(meta.tokens_before, 10_000);
        assert_eq!(meta.tokens_after, 2_000);
        assert_eq!(meta.dropped_at_ms, 1_752_000_000_000);
        assert_eq!(meta.state, SummaryState::Awaiting);
        // 派生缺省
        assert_eq!(meta.summary_json, None);
        assert_eq!(meta.schema_version, 1);
        assert_eq!(meta.height, 1);
        assert_eq!(meta.tier, None);
        assert_eq!(meta.attempts, 1);
        assert_eq!(meta.created_at, meta.dropped_at_ms);
        assert_eq!(meta.updated_at, meta.dropped_at_ms);
    }

    #[test]
    fn slot_text_is_machine_readable_and_deterministic() {
        let line = slot_text("compacted-summary-1-3", 7, 1);
        assert_eq!(
            line,
            "[Compacted 7 earlier message(s) · block compacted-summary-1-3 · generation 1 · 恢复: decompress_context(blockId=\"compacted-summary-1-3\")]"
        );
        // 确定性：同入参同输出
        assert_eq!(line, slot_text("compacted-summary-1-3", 7, 1));
        // 机器可寻址：恢复指令指向块 id
        assert!(line.contains("decompress_context(blockId=\"compacted-summary-1-3\")"));
    }

    #[test]
    fn details_json_uses_camel_case_shape() {
        let meta = sample_meta();
        let value = meta.to_details_json();
        assert_eq!(
            value.get("blockId"),
            Some(&serde_json::json!("compacted-summary-1-2"))
        );
        assert_eq!(value.get("generation"), Some(&serde_json::json!(1)));
        assert_eq!(
            value.get("prevBlockId"),
            Some(&serde_json::json!("compacted-summary-1-1"))
        );
        assert_eq!(
            value.get("droppedAtMs"),
            Some(&serde_json::json!(meta.dropped_at_ms))
        );
        assert_eq!(
            value.get("summaryState"),
            Some(&serde_json::json!("awaiting"))
        );
    }

    #[test]
    fn state_as_str_maps_all_variants() {
        assert_eq!(SummaryState::Awaiting.as_str(), "awaiting");
        assert_eq!(SummaryState::Committed.as_str(), "committed");
        assert_eq!(SummaryState::Retired.as_str(), "retired");
    }
}
