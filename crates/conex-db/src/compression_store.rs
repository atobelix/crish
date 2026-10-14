//! 生产级压缩块只读存储实现（BC11-4，02A 详案 §3.5）
//!
//! 实现 agent-tools 的 [CompressionContextStore] 契约：
//! - search_blocks: 基于 compression_blocks 表执行关键词与元数据匹配检索；
//! - decompress_block: 根据 block_id 查询块元数据，并从 events 表回放无损原始消息文本。

use std::sync::Arc;
use agent_tools::compression_store::{BlockContent, BlockHit, CompressionContextStore};
use crate::LocalDb;

/// 生产级 SQLite 压缩块存储（绑定 LocalDb）
#[derive(Clone)]
pub struct DbCompressionContextStore {
    db: Arc<LocalDb>,
}

impl std::fmt::Debug for DbCompressionContextStore {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("DbCompressionContextStore")
    }
}

impl DbCompressionContextStore {
    /// 通过 Arc<LocalDb> 构造
    pub fn new(db: Arc<LocalDb>) -> Self {
        Self { db }
    }

    /// 通过 LocalDb 构造
    pub fn from_db(db: LocalDb) -> Self {
        Self { db: Arc::new(db) }
    }
}

impl CompressionContextStore for DbCompressionContextStore {
    fn search_blocks(
        &self,
        session_id: &str,
        query: &str,
        limit: usize,
    ) -> Result<Vec<BlockHit>, String> {
        let rows = self
            .db
            .search_compression_blocks(session_id, query, limit)
            .map_err(|e| format!("search_blocks db failure: {e}"))?;

        Ok(rows
            .into_iter()
            .map(|r| BlockHit {
                block_id: r.block_id,
                generation: r.generation,
                height: r.height,
                summary: r.summary,
                dropped_count: r.dropped_message_ids.len(),
                state: r.state.as_str().to_string(),
            })
            .collect())
    }

    fn decompress_block(
        &self,
        session_id: &str,
        block_id: &str,
    ) -> Result<Option<BlockContent>, String> {
        let Some(block) = self
            .db
            .get_block(session_id, block_id)
            .map_err(|e| format!("get_block failure: {e}"))?
        else {
            return Ok(None);
        };

        if block.dropped_message_ids.is_empty() {
            return Ok(Some(BlockContent {
                block_id: block_id.to_string(),
                text: block.summary,
            }));
        }

        // 事件流回放重组原文（无损原始字节）
        let raw_text = self
            .db
            .reconstruct_dropped_messages_text(session_id, &block.dropped_message_ids)
            .map_err(|e| format!("reconstruct messages failure: {e}"))?;

        let text = if raw_text.trim().is_empty() {
            block.summary
        } else {
            raw_text
        };

        Ok(Some(BlockContent {
            block_id: block_id.to_string(),
            text,
        }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{BlockState, CompactionBlockRow, BLOCK_SCHEMA_VERSION};

    fn make_sample_block(
        session_id: &str,
        block_id: &str,
        generation: u32,
        summary: &str,
        dropped_ids: Vec<String>,
    ) -> CompactionBlockRow {
        CompactionBlockRow {
            session_id: session_id.to_string(),
            block_id: block_id.to_string(),
            sequence: 100 + generation as u64,
            generation,
            prev_block_id: None,
            dropped_message_ids: dropped_ids,
            first_kept_message_id: Some("msg_kept".to_string()),
            summary: summary.to_string(),
            summary_is_llm: true,
            tokens_before: 10_000,
            tokens_after: 2_000,
            dropped_at_ms: 1_752_000_000_000,
            state: BlockState::Committed,
            summary_json: Some(format!("{{\"summary\": \"{summary}\"}}")),
            schema_version: BLOCK_SCHEMA_VERSION,
            height: 1,
            tier: None,
            attempts: 1,
            created_at: 1_752_000_000_000,
            updated_at: 1_752_000_000_000,
        }
    }

    #[test]
    fn test_search_and_decompress_context() {
        let db = Arc::new(LocalDb::open_in_memory().unwrap());
        let session_id = "sess_comp_test_1";
        db.insert_session(session_id, "Test session").unwrap();

        // 1. 插入原始消息事件
        let user_payload = serde_json::json!({
            "sessionId": session_id,
            "type": "message-end",
            "message": {
                "id": "m1",
                "role": "user",
                "blocks": [
                    { "type": "text", "text": "Calculate 40 + 2" }
                ],
                "content": "Calculate 40 + 2"
            }
        });
        db.append_event(session_id, 1, "message-end", &user_payload.to_string(), None)
            .unwrap();

        let asst_payload = serde_json::json!({
            "sessionId": session_id,
            "type": "message-end",
            "message": {
                "id": "m2",
                "role": "assistant",
                "blocks": [
                    { "type": "text", "text": "The answer is 42." }
                ],
                "content": "The answer is 42."
            }
        });
        db.append_event(session_id, 2, "message-end", &asst_payload.to_string(), None)
            .unwrap();

        // 2. 插入压缩块
        let block1 = make_sample_block(
            session_id,
            "compacted-summary-1-1",
            1,
            "User asked for math calculation, assistant responded 42.",
            vec!["m1".to_string(), "m2".to_string()],
        );
        db.insert_block(&block1).unwrap();

        let store = DbCompressionContextStore::new(db.clone());

        // 3. 测试 search_blocks 匹配
        let hits = store.search_blocks(session_id, "math", 10).unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].block_id, "compacted-summary-1-1");
        assert_eq!(hits[0].generation, 1);
        assert_eq!(hits[0].dropped_count, 2);
        assert_eq!(hits[0].state, "committed");

        // 4. 测试 search_blocks 空匹配
        let empty_hits = store.search_blocks(session_id, "nonexistent_keyword", 10).unwrap();
        assert!(empty_hits.is_empty());

        // 5. 测试 search_blocks 空串匹配全部
        let all_hits = store.search_blocks(session_id, "", 10).unwrap();
        assert_eq!(all_hits.len(), 1);

        // 6. 测试跨会话隔离
        let other_hits = store.search_blocks("other_session", "math", 10).unwrap();
        assert!(other_hits.is_empty());

        // 7. 测试 decompress_block 还原原始文本
        let decomp = store.decompress_block(session_id, "compacted-summary-1-1").unwrap();
        assert!(decomp.is_some());
        let content = decomp.unwrap();
        assert_eq!(content.block_id, "compacted-summary-1-1");
        assert!(content.text.contains("[user] Calculate 40 + 2"));
        assert!(content.text.contains("[assistant] The answer is 42."));

        // 8. 测试不存在的 block_id
        let missing = store.decompress_block(session_id, "non_existent_block").unwrap();
        assert!(missing.is_none());
    }

    #[test]
    fn test_decompress_block_fallback_to_summary() {
        let db = Arc::new(LocalDb::open_in_memory().unwrap());
        let session_id = "sess_fallback_test";
        db.insert_session(session_id, "Fallback session").unwrap();

        let block = make_sample_block(
            session_id,
            "compacted-summary-2-1",
            2,
            "A fallback summary when dropped ids are empty.",
            vec![],
        );
        db.insert_block(&block).unwrap();

        let store = DbCompressionContextStore::new(db);
        let decomp = store.decompress_block(session_id, "compacted-summary-2-1").unwrap();
        assert!(decomp.is_some());
        assert_eq!(decomp.unwrap().text, "A fallback summary when dropped ids are empty.");
    }
}
