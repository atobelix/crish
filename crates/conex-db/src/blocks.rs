//! 压缩块域：compression_blocks 表读写访问面（T-16，00-plan §10 轮次 2）。
//!
//! 设计要点（评审 01 P0-4 两阶段写协议 + R12/P2-1 缺表降级）：
//! - 行创建 = `INSERT OR IGNORE`（幂等键 (session_id, block_id)，压缩事件
//!   重放天然幂等，冲突静默忽略返回 Ok）；
//! - 状态推进 = [Self::update_block_state]（awaiting → committed | retired，
//!   调度器成功回调面，UPDATE 幂等——行不存在返回 Ok 无操作）；
//! - 缺表降级（v6 库被新代码读）：所有读写面先查 sqlite_master 确认
//!   compression_blocks 表存在（每连接缓存一次），缺表时查询返回空集 /
//!   Ok(None)、写入返回 Ok，配 `tracing::warn!`——绝不 SQL 报错 latch 死库；
//! - 本 crate 保持不依赖 conex-compaction（叶子纪律）：行结构 [CompactionBlockRow]
//!   与引擎侧 CompactionBlockMeta 字段一一对应，由 orchestrator 负责转换。

use super::{DbFailure, DbFailureKind, LocalDb};

/// 压缩块 schema 版本（对齐 conex-compaction summary_document 的 V1；
/// 因 conex-db 不依赖 conex-compaction，常量在本域独立声明）。
pub const BLOCK_SCHEMA_VERSION: u32 = 1;

/// 块状态机字面量（00-plan §6.1：awaiting → committed | retired）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BlockState {
    /// 压缩时创建（同步失败/无注入）：对话内为中性 stub，后台可续试
    Awaiting,
    /// 摘要就绪（同步成功）：JSON 文档已写表
    Committed,
    /// 重试耗尽：stub 永驻（R-C）
    Retired,
}

impl BlockState {
    /// 状态 → 库内字面量（state 列）
    pub fn as_str(&self) -> &'static str {
        match self {
            BlockState::Awaiting => "awaiting",
            BlockState::Committed => "committed",
            BlockState::Retired => "retired",
        }
    }

    /// 库内字面量 → 状态。未知字面量（未来版本扩展）降级为 Awaiting 并
    /// 告警——对齐「旧代码读新库不炸」的兼容精神（不 latch、不丢行）。
    pub fn from_db_str(raw: &str) -> Self {
        match raw {
            "committed" => BlockState::Committed,
            "retired" => BlockState::Retired,
            unknown => {
                tracing::warn!(
                    state = %unknown,
                    "compression_blocks.state 未知字面量，降级为 awaiting（未来版本扩展？）"
                );
                BlockState::Awaiting
            }
        }
    }
}

/// compression_blocks 表行（与 conex-compaction 的 CompactionBlockMeta
/// 字段一一对应；类型独立，转换由 orchestrator 侧完成——本 crate 不
/// 引入 conex-compaction 依赖）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CompactionBlockRow {
    /// 会话 id（复合主键一半）
    pub session_id: String,
    /// 块 id（R-B：与链内摘要消息 id 同名）
    pub block_id: String,
    /// context-compression-end 事件序列号（定位事件行）
    pub sequence: u64,
    /// 会话级压缩代数（R-K 单源）
    pub generation: u32,
    /// 迭代合并上游块（null = 首块 / 未合并）
    pub prev_block_id: Option<String>,
    /// 被压缩（丢弃并进入摘要）的消息 id 清单
    pub dropped_message_ids: Vec<String>,
    /// 保留段首条消息 id（切割下界引用）
    pub first_kept_message_id: Option<String>,
    /// 链内文本（md 渲染投影或 stub）
    pub summary: String,
    /// 摘要是否来自 LLM（同步成功路径）
    pub summary_is_llm: bool,
    pub tokens_before: u64,
    pub tokens_after: u64,
    /// 压缩时刻 epoch 毫秒
    pub dropped_at_ms: i64,
    /// 摘要状态（awaiting / committed / retired）
    pub state: BlockState,
    /// 提交后的 JSON 规范文档（committed 时填充；stub 期为 None）
    pub summary_json: Option<String>,
    /// 摘要文档 Schema 版本
    pub schema_version: u32,
    /// 树高度（每次迭代合并 +1）
    pub height: u32,
    /// 分层标签（chunk / rolling / final）
    pub tier: Option<String>,
    /// 累计尝试次数（含同步那次）
    pub attempts: u32,
    pub created_at: i64,
    pub updated_at: i64,
}

impl LocalDb {
    /// compression_blocks 表是否存在（sqlite_master 探测，每连接缓存一次；
    /// None 初值在 open 时建立——首次访问后缓存，后续不再查询）。
    fn compression_blocks_present(&self) -> Result<bool, DbFailure> {
        if let Some(present) = *self
            .compression_blocks_present
            .lock()
            .map_err(|e| DbFailure {
                message: format!("lock poisoned: {e}"),
                kind: DbFailureKind::Lock,
            })?
        {
            return Ok(present);
        }
        let conn = self.conn.lock().map_err(|e| DbFailure {
            message: format!("lock poisoned: {e}"),
            kind: DbFailureKind::Lock,
        })?;
        let present: bool = conn
            .query_row(
                "SELECT EXISTS(
                    SELECT 1 FROM sqlite_master
                    WHERE type='table' AND name='compression_blocks'
                 )",
                [],
                |r| r.get::<_, i64>(0),
            )
            .map(|v| v != 0)
            .map_err(|e| self.latch_error("compression_blocks_present", e))?;
        if let Ok(mut cache) = self.compression_blocks_present.lock() {
            *cache = Some(present);
        }
        Ok(present)
    }

    /// 缺表降级告警（v6 库被新代码读，R12/P2-1：不 SQL 报错）。
    fn warn_missing_blocks_table(&self, operation: &str) {
        tracing::warn!(
            operation,
            "compression_blocks 表缺失（v6 库被新代码读？）：{operation} 降级返回空/Ok，不报错"
        );
    }

    /// 压缩块行创建（T-16 两阶段写协议阶段一）。
    ///
    /// `INSERT OR IGNORE`：幂等键 (session_id, block_id)——同键重放/重复
    /// 压缩静默忽略返回 Ok，不产生重复行。缺表（v6 库）降级返回 Ok。
    pub fn insert_block(&self, row: &CompactionBlockRow) -> Result<(), DbFailure> {
        if !self.compression_blocks_present()? {
            self.warn_missing_blocks_table("insert_block");
            return Ok(());
        }
        let conn = self.conn.lock().map_err(|e| DbFailure {
            message: format!("lock poisoned: {e}"),
            kind: DbFailureKind::Lock,
        })?;
        let dropped_json = serde_json::to_string(&row.dropped_message_ids).map_err(|e| {
            let failure = DbFailure {
                message: format!("insert_block_dropped_json: {e}"),
                kind: DbFailureKind::Other("insert_block_dropped_json".to_string()),
            };
            self.set_failure(failure.clone());
            failure
        })?;
        conn.execute(
            "INSERT OR IGNORE INTO compression_blocks (
                session_id, block_id, sequence, generation, prev_block_id,
                dropped_message_ids, first_kept_message_id, summary,
                summary_is_llm, tokens_before, tokens_after, dropped_at_ms,
                state, summary_json, schema_version, height, tier, attempts,
                created_at, updated_at
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13,
                ?14, ?15, ?16, ?17, ?18, ?19, ?20)",
            rusqlite::params![
                row.session_id,
                row.block_id,
                row.sequence as i64,
                row.generation as i64,
                row.prev_block_id,
                dropped_json,
                row.first_kept_message_id,
                row.summary,
                row.summary_is_llm as i64,
                row.tokens_before as i64,
                row.tokens_after as i64,
                row.dropped_at_ms,
                row.state.as_str(),
                row.summary_json,
                row.schema_version as i64,
                row.height as i64,
                row.tier,
                row.attempts as i64,
                row.created_at,
                row.updated_at,
            ],
        )
        .map_err(|e| self.latch_error("insert_block", e))?;
        Ok(())
    }

    /// 压缩块状态推进（T-16 两阶段写协议阶段二：调度器成功后调用）。
    ///
    /// UPDATE 幂等：行不存在（事件尚未落块或已删除）时返回 Ok 无操作；
    /// 已推进的行再次推进仍成功（不报错、不重算）。缺表降级返回 Ok。
    pub fn update_block_state(
        &self,
        session_id: &str,
        block_id: &str,
        state: BlockState,
        summary_json: Option<&str>,
        height: u32,
        attempts: u32,
    ) -> Result<(), DbFailure> {
        if !self.compression_blocks_present()? {
            self.warn_missing_blocks_table("update_block_state");
            return Ok(());
        }
        let conn = self.conn.lock().map_err(|e| DbFailure {
            message: format!("lock poisoned: {e}"),
            kind: DbFailureKind::Lock,
        })?;
        conn.execute(
            "UPDATE compression_blocks
             SET state = ?3, summary_json = ?4, height = ?5, attempts = ?6,
                 summary_is_llm = (CASE WHEN ?3 = 'committed' THEN 1 ELSE 0 END),
                 updated_at = ?7
             WHERE session_id = ?1 AND block_id = ?2",
            rusqlite::params![
                session_id,
                block_id,
                state.as_str(),
                summary_json,
                height as i64,
                attempts as i64,
                now_ms(),
            ],
        )
        .map_err(|e| self.latch_error("update_block_state", e))?;
        Ok(())
    }

    /// 按 (session_id, block_id) 读取单行（缺表返回 Ok(None)）。
    pub fn get_block(
        &self,
        session_id: &str,
        block_id: &str,
    ) -> Result<Option<CompactionBlockRow>, DbFailure> {
        if !self.compression_blocks_present()? {
            self.warn_missing_blocks_table("get_block");
            return Ok(None);
        }
        let conn = self.conn.lock().map_err(|e| DbFailure {
            message: format!("lock poisoned: {e}"),
            kind: DbFailureKind::Lock,
        })?;
        let mut stmt = conn
            .prepare(&format!(
                "{BLOCK_SELECT_SQL} AND block_id = ?2"
            ))
            .map_err(|e| self.latch_error("get_block_prepare", e))?;
        let mut rows = stmt
            .query_map(
                rusqlite::params![session_id, block_id],
                block_from_row,
            )
            .map_err(|e| self.latch_error("get_block_query", e))?;
        match rows.next() {
            Some(Ok(row)) => Ok(Some(row)),
            Some(Err(e)) => Err(self.latch_error("get_block_map", e)),
            None => Ok(None),
        }
    }

    /// 列出会话内块（generation DESC 排序——最新块在前；limit 钳制条数）。
    ///
    /// 链尾块 = 返回首条（list_blocks 取首即最新，T-18 prev_block_id 取数）。
    /// 缺表返回空集。
    pub fn list_blocks(
        &self,
        session_id: &str,
        limit: Option<u32>,
    ) -> Result<Vec<CompactionBlockRow>, DbFailure> {
        if !self.compression_blocks_present()? {
            self.warn_missing_blocks_table("list_blocks");
            return Ok(Vec::new());
        }
        let conn = self.conn.lock().map_err(|e| DbFailure {
            message: format!("lock poisoned: {e}"),
            kind: DbFailureKind::Lock,
        })?;
        let mut stmt = conn
            .prepare(&format!(
                "{BLOCK_SELECT_SQL}
                 ORDER BY generation DESC, sequence DESC
                 LIMIT ?2"
            ))
            .map_err(|e| self.latch_error("list_blocks_prepare", e))?;        let rows = stmt
            .query_map(
                rusqlite::params![session_id, limit.map(|l| l as i64).unwrap_or(i64::MAX)],
                block_from_row,
            )
            .map_err(|e| self.latch_error("list_blocks_query", e))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| self.latch_error("list_blocks_collect", e))?;
        Ok(rows)
    }

    /// 会话内块总数（缺表返回 0）。
    pub fn count_blocks(&self, session_id: &str) -> Result<u64, DbFailure> {
        if !self.compression_blocks_present()? {
            self.warn_missing_blocks_table("count_blocks");
            return Ok(0);
        }
        let conn = self.conn.lock().map_err(|e| DbFailure {
            message: format!("lock poisoned: {e}"),
            kind: DbFailureKind::Lock,
        })?;
        let count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM compression_blocks WHERE session_id = ?1",
                rusqlite::params![session_id],
                |r| r.get(0),
            )
            .map_err(|e| self.latch_error("count_blocks", e))?;
        Ok(count as u64)
    }

    /// 会话内 context-compression-end 事件计数（T-18 generation 取数）。
    ///
    /// 语义锚定：restore 重放时 [SessionRecord::apply_compression_end] 对每个
    /// 压缩事件 +1 代数，最终值 = 该会话库内压缩事件总数——本计数与该恢复
    /// 语义严格一致（同一事实源：events 表），R-K 单源不漂移。
    pub fn count_compression_events(&self, session_id: &str) -> Result<u64, DbFailure> {
        let conn = self.conn.lock().map_err(|e| DbFailure {
            message: format!("lock poisoned: {e}"),
            kind: DbFailureKind::Lock,
        })?;
        let count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM events
                 WHERE session_id = ?1 AND event_type = 'context-compression-end'",
                rusqlite::params![session_id],
                |r| r.get(0),
            )
            .map_err(|e| self.latch_error("count_compression_events", e))?;
        Ok(count as u64)
    }
}

/// 行读取 SQL 公共前缀（get_block / list_blocks 复用）。
const BLOCK_SELECT_SQL: &str = "SELECT
        session_id, block_id, sequence, generation, prev_block_id,
        dropped_message_ids, first_kept_message_id, summary,
        summary_is_llm, tokens_before, tokens_after, dropped_at_ms,
        state, summary_json, schema_version, height, tier, attempts,
        created_at, updated_at
     FROM compression_blocks WHERE session_id = ?1";

/// 当前 UTC 毫秒时间戳（epoch ms；块行时间列，对齐 runs.rs 既有模式）。
fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or_default()
}

/// 行 → 结构映射（dropped_message_ids JSON 反序列化；state 字面量宽松解析）。
fn block_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<CompactionBlockRow> {
    let dropped_json: String = row.get(5)?;
    let dropped_message_ids: Vec<String> = serde_json::from_str(&dropped_json)
        .unwrap_or_else(|_| Vec::new());
    Ok(CompactionBlockRow {
        session_id: row.get(0)?,
        block_id: row.get(1)?,
        sequence: row.get::<_, i64>(2)? as u64,
        generation: row.get::<_, i64>(3)? as u32,
        prev_block_id: row.get(4)?,
        dropped_message_ids,
        first_kept_message_id: row.get(6)?,
        summary: row.get(7)?,
        summary_is_llm: row.get::<_, i64>(8)? != 0,
        tokens_before: row.get::<_, i64>(9)? as u64,
        tokens_after: row.get::<_, i64>(10)? as u64,
        dropped_at_ms: row.get(11)?,
        state: BlockState::from_db_str(&row.get::<_, String>(12)?),
        summary_json: row.get(13)?,
        schema_version: row.get::<_, i64>(14)? as u32,
        height: row.get::<_, i64>(15)? as u32,
        tier: row.get(16)?,
        attempts: row.get::<_, i64>(17)? as u32,
        created_at: row.get(18)?,
        updated_at: row.get(19)?,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_row(session_id: &str, block_id: &str, generation: u32) -> CompactionBlockRow {
        CompactionBlockRow {
            session_id: session_id.to_string(),
            block_id: block_id.to_string(),
            sequence: 100 + generation as u64,
            generation,
            prev_block_id: if generation > 1 {
                Some(format!("compacted-summary-{}-{}", generation - 1, 1))
            } else {
                None
            },
            dropped_message_ids: vec!["u1".to_string(), "a1".to_string()],
            first_kept_message_id: Some("u2".to_string()),
            summary: format!("摘要 {generation}"),
            summary_is_llm: false,
            tokens_before: 10_000,
            tokens_after: 2_000,
            dropped_at_ms: 1_752_000_000_000 + generation as i64,
            state: BlockState::Awaiting,
            summary_json: None,
            schema_version: BLOCK_SCHEMA_VERSION,
            height: 1,
            tier: None,
            attempts: 0,
            created_at: 1_752_000_000_000,
            updated_at: 1_752_000_000_000,
        }
    }

    #[test]
    fn block_state_literal_roundtrip() {
        assert_eq!(BlockState::Awaiting.as_str(), "awaiting");
        assert_eq!(BlockState::Committed.as_str(), "committed");
        assert_eq!(BlockState::Retired.as_str(), "retired");
        assert_eq!(BlockState::from_db_str("awaiting"), BlockState::Awaiting);
        assert_eq!(BlockState::from_db_str("committed"), BlockState::Committed);
        assert_eq!(BlockState::from_db_str("retired"), BlockState::Retired);
        // 未知字面量宽松降级（旧代码读新库不炸）
        assert_eq!(BlockState::from_db_str("future-state"), BlockState::Awaiting);
    }

    #[test]
    fn insert_get_roundtrip_with_dropped_json() {
        let db = LocalDb::open_in_memory().unwrap();
        let row = sample_row("s1", "compacted-summary-1-1", 1);
        db.insert_block(&row).unwrap();

        let loaded = db.get_block("s1", "compacted-summary-1-1").unwrap().unwrap();
        assert_eq!(loaded, row);
        assert_eq!(loaded.dropped_message_ids, vec!["u1".to_string(), "a1".to_string()]);
        assert_eq!(loaded.generation, 1);
        assert_eq!(loaded.state, BlockState::Awaiting);
        assert_eq!(loaded.schema_version, BLOCK_SCHEMA_VERSION);
    }

    #[test]
    fn insert_ignore_idempotent_same_key_and_cross_session_isolation() {
        let db = LocalDb::open_in_memory().unwrap();
        // 同 (session_id, block_id) 重放：INSERT OR IGNORE 不产生重复行
        db.insert_block(&sample_row("s1", "b1", 1)).unwrap();
        db.insert_block(&sample_row("s1", "b1", 1)).unwrap();
        assert_eq!(db.count_blocks("s1").unwrap(), 1);
        // 复合主键：跨会话同 block_id 各自成行（R-B 会话内唯一语义）
        db.insert_block(&sample_row("s2", "b1", 1)).unwrap();
        assert_eq!(db.count_blocks("s2").unwrap(), 1);
        assert_eq!(db.count_blocks("s1").unwrap(), 1);
        // 同会话不同 block_id 成行
        db.insert_block(&sample_row("s1", "b2", 2)).unwrap();
        assert_eq!(db.count_blocks("s1").unwrap(), 2);
    }

    #[test]
    fn update_block_state_progresses_and_is_idempotent() {
        let db = LocalDb::open_in_memory().unwrap();
        db.insert_block(&sample_row("s1", "b1", 1)).unwrap();

        db.update_block_state(
            "s1",
            "b1",
            BlockState::Committed,
            Some(r#"{"schemaVersion":1}"#),
            2,
            3,
        )
        .unwrap();
        let loaded = db.get_block("s1", "b1").unwrap().unwrap();
        assert_eq!(loaded.state, BlockState::Committed);
        assert_eq!(
            loaded.summary_json.as_deref(),
            Some(r#"{"schemaVersion":1}"#)
        );
        assert_eq!(loaded.height, 2);
        assert_eq!(loaded.attempts, 3);
        // 再次推进幂等（不报错）
        db.update_block_state("s1", "b1", BlockState::Retired, None, 2, 4)
            .unwrap();
        let loaded = db.get_block("s1", "b1").unwrap().unwrap();
        assert_eq!(loaded.state, BlockState::Retired);
        assert_eq!(loaded.attempts, 4);
        // 行不存在：Ok 无操作（两阶段协议创建面与推进面解耦）
        db.update_block_state("s1", "ghost", BlockState::Committed, None, 1, 1)
            .unwrap();
    }

    #[test]
    fn list_blocks_orders_by_generation_desc() {
        let db = LocalDb::open_in_memory().unwrap();
        for gen in [3u32, 1, 2] {
            db.insert_block(&sample_row("s1", &format!("b{gen}"), gen)).unwrap();
        }
        let blocks = db.list_blocks("s1", None).unwrap();
        let gens: Vec<u32> = blocks.iter().map(|b| b.generation).collect();
        assert_eq!(gens, vec![3, 2, 1], "generation DESC 排序（链尾 = 首条）");
        // limit 钳制
        assert_eq!(db.list_blocks("s1", Some(2)).unwrap().len(), 2);
        // 会话隔离
        assert!(db.list_blocks("s2", None).unwrap().is_empty());
    }

    #[test]
    fn missing_table_degrades_to_empty_ok_without_latch() {
        // 模拟 v6 库被新代码读（R12/P2-1）：v7 库上删除块表 → 表缺失形态
        let db = LocalDb::open_in_memory().unwrap();
        let conn = db.conn.lock().unwrap();
        conn.execute_batch("DROP TABLE compression_blocks;").unwrap();
        drop(conn);

        // 查询面：空集 / Ok(None)，不 SQL 报错
        assert_eq!(db.list_blocks("s1", None).unwrap().len(), 0);
        assert!(db.get_block("s1", "b1").unwrap().is_none());
        assert_eq!(db.count_blocks("s1").unwrap(), 0);
        // 写面：Ok 无操作（不 latch 死库）
        db.insert_block(&sample_row("s1", "b1", 1)).unwrap();
        db.update_block_state("s1", "b1", BlockState::Committed, None, 1, 1)
            .unwrap();
        assert_eq!(db.get_failure(), None, "缺表降级不得 latch 死库");
        // 表存在性缓存：一旦探测为缺表，后续操作持续降级（不炸）
        assert_eq!(db.count_blocks("s1").unwrap(), 0);
    }

    #[test]
    fn count_compression_events_matches_events_table() {
        let db = LocalDb::open_in_memory().unwrap();
        db.insert_session("s1", "s1").unwrap();
        assert_eq!(db.count_compression_events("s1").unwrap(), 0);
        db.append_event("s1", 1, "context-compression-end", "{}").unwrap();
        db.append_event("s1", 2, "context-compression-end", "{}").unwrap();
        db.append_event("s1", 3, "message-end", "{}").unwrap();
        assert_eq!(db.count_compression_events("s1").unwrap(), 2);
        // 会话隔离
        assert_eq!(db.count_compression_events("s2").unwrap(), 0);
    }
}
