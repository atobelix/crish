//! 压缩块持久化面（T-18，00-plan §10 轮次 2）：压缩事件落地 → 块行入库。
//!
//! 接线点：`drive_outcome` 在 `context-compression-end` 事件落库成功后调用
//! [persist_compression_block]——块行与事件同源同序（sequence = 事件序列号），
//! `INSERT OR IGNORE` 幂等（同 (session_id, block_id) 重放不重复行）。
//!
//! 字段取数规则（向后兼容 + 轮次 4 自动升级）：
//! - **details 优先**：事件 `result.details`（camelCase）携带
//!   blockId / generation / prevBlockId / droppedAtMs / summaryState 时直接
//!   采用（session-loop 轮次 4 织入后自动生效）；缺省时兜底推导；
//! - **generation 兜底**：`count_compression_events`（events 表
//!   context-compression-end 计数，含本次）——与 restore 重放
//!   `apply_compression_end` 的 +1 语义严格一致（同一事实源），R-K 单源；
//! - **block_id 兜底**：`record.id`（既有唯一 id，01 §2.1 合一语义）；
//! - **prev_block_id 兜底**：块表链尾（list_blocks 首条 = generation DESC 最新）；
//! - **state 兜底**：awaiting（同步成功路径由 details.summaryState=committed
//!   表达，本轮 session-loop 未织入 details 时恒 awaiting）。
//!
//! 失败语义：块行写入失败仅告警不阻断 drive（块表是索引面，原文仍在事件流
//! 可回放；V2 backfill 可重建）。restore 重放**不重写块**（表由实时写入产生，
//! 重放只恢复代数状态——见 restore.rs CONTEXT_COMPRESSION_END_EVENT 分支）。
//!
//! cache_tracker 消费面在轮次 3/4（T-25~T-31）：本模块只落块表，不触碰测量面。

use conex_db::{BlockState, CompactionBlockRow, DbFailure, LocalDb};
use conex_types::events::AgentEvent;
use conex_types::tool::ContextCompressionRecord;

use crate::now_ms;
use crate::persist::StoreError;

/// 压缩事件（context-compression-end）落库成功后写入块行。
///
/// 非压缩事件 / result 为 None / store 无底层 LocalDb（内存测试替身）→
/// Ok 跳过。返回 Err 仅当真实 DB 写失败（调用方告警不阻断）。
pub async fn persist_compression_block(
    store: &dyn crate::persist::Store,
    session_id: &str,
    event: &AgentEvent,
    sequence: u64,
) -> Result<(), StoreError> {
    let AgentEvent::ContextCompressionEnd {
        result: Some(record),
        ..
    } = event
    else {
        return Ok(());
    };
    // 块写入仅生产路径（SQLite）；InMemoryStore 等测试替身无连接 → 跳过
    let Some(db) = store.as_local_db() else {
        return Ok(());
    };
    // insert_block / count_compression_events 走 write_blocking/读锁：
    // 必须从 spawn_blocking 调用，禁止在 async worker 上直接 blocking_send。
    let db2 = db.clone();
    let session_id = session_id.to_string();
    let record = record.clone();
    tokio::task::spawn_blocking(move || {
        let row = build_block_row(&db2, &session_id, &record, sequence)?;
        db2.insert_block(&row).map_err(db_store_error)
    })
    .await
    .map_err(|e| StoreError::new("insert_block", format!("spawn_blocking join: {e}")))?
}

/// 摘要任务完成回调落库面（T-42；两阶段写协议阶段二——会话级协调器
/// 后台任务完成后推进块行 state / summary_json / attempts）。
///
/// - **幂等**：行不存在（事件尚未落块 / 已删除）→ Ok 无操作；
///   [LocalDb::update_block_state] 可重复调用不报错；
/// - **height 保持**：V1 后台任务不读表（session-loop 叶子纪律，无
///   existing 迭代合并语义）——推进时保留块行既有 height（同步路径
///   创建时=1），避免误覆盖未来合并高度；
/// - **语源**：summary_json 为 Schema V1 规范文档（R-G 表面），链文本
///   形态由 outcome.rendered_markdown 承载（会话元数据 / 前端展示挂账）；
/// - 失败语义：写失败告警不阻断（块表是索引面，原文仍在事件流可回放）。
/// - 同步函数：conex-db 为同步 API，回调（FnOnce，壳层默认回调）内直接
///   调用（单连接锁短持有；V1 简化，长库面演进留 V2）。
pub fn update_compression_block_summary(
    store: &dyn crate::persist::Store,
    session_id: &str,
    block_id: &str,
    state: BlockState,
    summary_json: Option<&str>,
    attempts: u32,
) -> Result<(), StoreError> {
    // 仅生产路径（SQLite）；测试替身无连接 → Ok 跳过
    let Some(db) = store.as_local_db() else {
        return Ok(());
    };
    // height 保持既有值（V1 不读表合并 → 不推进高度；缺行时兜底 1）
    let height = db
        .get_block(session_id, block_id)
        .ok()
        .flatten()
        .map(|row| row.height)
        .unwrap_or(1);
    db.update_block_state(session_id, block_id, state, summary_json, height, attempts)
        .map_err(db_store_error)
}

/// 事件 record + 会话上下文 → 块行（details 优先，兜底推导；见模块注释）。
fn build_block_row(
    db: &LocalDb,
    session_id: &str,
    record: &ContextCompressionRecord,
    sequence: u64,
) -> Result<CompactionBlockRow, StoreError> {
    let details = record.details.as_ref();
    let str_field = |key: &str| {
        details
            .and_then(|d| d.get(key))
            .and_then(serde_json::Value::as_str)
            .map(str::to_string)
    };
    let u64_field = |key: &str| {
        details
            .and_then(|d| d.get(key))
            .and_then(serde_json::Value::as_u64)
    };

    let block_id = str_field("blockId").unwrap_or_else(|| record.id.clone());
    // generation：details 优先；兜底 = events 表压缩事件计数（含本次），
    // 与 restore 重放 apply_compression_end 的 +1 语义一致（R-K 单源）
    let generation = u64_field("generation")
        .map(|g| g as u32)
        .or_else(|| {
            db.count_compression_events(session_id)
                .ok()
                .map(|c| c as u32)
        })
        .unwrap_or(1);
    // prev_block_id：details 优先；兜底 = 块表链尾（list 首条即最新）
    let prev_block_id = str_field("prevBlockId").or_else(|| {
        db.list_blocks(session_id, Some(1))
            .ok()
            .and_then(|mut blocks| {
                if blocks.is_empty() {
                    None
                } else {
                    Some(blocks.remove(0).block_id)
                }
            })
    });
    let dropped_at_ms = u64_field("droppedAtMs")
        .map(|v| v as i64)
        .unwrap_or_else(now_ms);
    // state：details 优先；缺省 awaiting（本轮同步路径未织入时恒 awaiting）
    let state = match str_field("summaryState").as_deref() {
        Some("committed") => BlockState::Committed,
        Some("retired") => BlockState::Retired,
        _ => BlockState::Awaiting,
    };

    let now = now_ms();
    Ok(CompactionBlockRow {
        session_id: session_id.to_string(),
        block_id,
        sequence,
        generation,
        prev_block_id,
        dropped_message_ids: record.compressed_message_ids.clone(),
        first_kept_message_id: record.first_kept_message_id.clone(),
        summary: record.summary.clone(),
        // committed ⇒ LLM 摘要（R-F 同步成功路径语义）；awaiting/retired 为 stub
        summary_is_llm: state == BlockState::Committed,
        tokens_before: record.tokens_before,
        tokens_after: record.tokens_after,
        dropped_at_ms,
        state,
        // 事件载荷不携带 JSON 文档原文（同步成功路径轮次 4 织入 details 后
        // 可扩展）；摘要 JSON 规范面由调度器 UPDATE 推进（两阶段写协议阶段二）
        summary_json: None,
        schema_version: conex_db::BLOCK_SCHEMA_VERSION,
        height: 1,
        tier: None,
        // 同步成功 = 1 次有效尝试；awaiting 期为 0（调度器续试后累计）
        attempts: if state == BlockState::Committed { 1 } else { 0 },
        created_at: now,
        updated_at: now,
    })
}

/// DbFailure → StoreError（操作名保留，cause 链携带底层分类码，对齐 persist.rs）
fn db_store_error(failure: DbFailure) -> StoreError {
    crate::persist::StoreError::with_cause("insert_block", failure.message.clone(), failure)
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use conex_db::{BlockState, LocalDb};
    use conex_types::tool::{ContextCompressionRecord, ContextCompressionTrigger};

    use super::*;
    use crate::persist::{InMemoryStore, LocalDbStore, Store};

    fn compression_event(record: ContextCompressionRecord) -> AgentEvent {
        AgentEvent::ContextCompressionEnd {
            session_id: "s1".to_string(),
            timestamp: "2026-08-08T00:00:00.000Z".to_string(),
            result: Some(record),
            aborted: false,
            error: None,
        }
    }

    fn plain_record(id: &str, dropped: Vec<&str>) -> ContextCompressionRecord {
        ContextCompressionRecord {
            id: id.to_string(),
            trigger: ContextCompressionTrigger::Threshold,
            reason: None,
            policy: None,
            summary: "摘要文本".to_string(),
            first_kept_message_id: Some("u2".to_string()),
            compressed_message_ids: dropped.into_iter().map(str::to_string).collect(),
            kept_message_ids: vec!["u2".to_string(), "a2".to_string()],
            tokens_before: 10_000,
            tokens_after: 2_000,
            threshold_tokens: None,
            created_at: "2026-08-08T00:00:00.000Z".to_string(),
            handoff: None,
            cache_boundary: None,
            details: None,
        }
    }

    /// 构造带压缩事件的 LocalDb（events 表 FK：先建会话；压缩事件落库使
    /// count_compression_events 生效，模拟 drive 路径已落库形态）。
    fn seeded_db(session_id: &str, compression_events: u64) -> LocalDb {
        let db = LocalDb::open_in_memory().unwrap();
        db.insert_session(session_id, session_id).unwrap();
        for seq in 1..=compression_events {
            db.append_event(
                session_id,
                seq as i64,
                "context-compression-end",
                "{}",
                None,
            )
            .unwrap();
        }
        db
    }

    #[tokio::test]
    async fn persist_block_creates_row_from_event_fields() {
        let db = seeded_db("s1", 1);
        let store: Arc<dyn Store> = Arc::new(LocalDbStore::new(db.clone()));
        let record = plain_record("compacted-summary-1-1", vec!["u1", "a1"]);
        let event = compression_event(record.clone());

        persist_compression_block(store.as_ref(), "s1", &event, 42)
            .await
            .unwrap();

        let block = db
            .get_block("s1", "compacted-summary-1-1")
            .unwrap()
            .unwrap();
        assert_eq!(block.block_id, "compacted-summary-1-1");
        assert_eq!(block.sequence, 42, "sequence = 事件序列号");
        assert_eq!(block.generation, 1, "首次压缩代数 = 1（事件计数兜底）");
        assert_eq!(block.prev_block_id, None, "首块无上游");
        assert_eq!(
            block.dropped_message_ids,
            vec!["u1".to_string(), "a1".to_string()]
        );
        assert_eq!(block.first_kept_message_id.as_deref(), Some("u2"));
        assert_eq!(block.summary, "摘要文本");
        assert!(!block.summary_is_llm);
        assert_eq!(block.tokens_before, 10_000);
        assert_eq!(block.tokens_after, 2_000);
        assert_eq!(block.state, BlockState::Awaiting);
        assert_eq!(block.attempts, 0);
        assert_eq!(block.schema_version, conex_db::BLOCK_SCHEMA_VERSION);
        assert_eq!(block.height, 1);
    }

    #[tokio::test]
    async fn persist_block_replay_is_idempotent() {
        let db = seeded_db("s1", 1);
        let store: Arc<dyn Store> = Arc::new(LocalDbStore::new(db.clone()));
        let event = compression_event(plain_record("b1", vec!["u1"]));

        persist_compression_block(store.as_ref(), "s1", &event, 42)
            .await
            .unwrap();
        // 同事件重放（INSERT OR IGNORE）：不产生重复行
        persist_compression_block(store.as_ref(), "s1", &event, 42)
            .await
            .unwrap();
        assert_eq!(db.count_blocks("s1").unwrap(), 1);
    }

    #[tokio::test]
    async fn persist_block_generation_increments_and_prev_links_chain() {
        let db = seeded_db("s1", 1);
        let store: Arc<dyn Store> = Arc::new(LocalDbStore::new(db.clone()));

        let first = compression_event(plain_record("compacted-summary-1-1", vec!["u1"]));
        persist_compression_block(store.as_ref(), "s1", &first, 10)
            .await
            .unwrap();
        assert_eq!(
            db.get_block("s1", "compacted-summary-1-1")
                .unwrap()
                .unwrap()
                .generation,
            1,
            "第一次压缩代数 = 1（事件计数，含本次）"
        );

        // 第二次压缩事件落库（drive 路径语义：事件先落库再写块）
        db.append_event("s1", 2, "context-compression-end", "{}", None)
            .unwrap();
        let second = compression_event(plain_record("compacted-summary-1-2", vec!["u2"]));
        persist_compression_block(store.as_ref(), "s1", &second, 20)
            .await
            .unwrap();

        let b2 = db
            .get_block("s1", "compacted-summary-1-2")
            .unwrap()
            .unwrap();
        assert_eq!(b2.generation, 2, "第二次压缩代数 = 2（事件计数，含本次）");
        assert_eq!(
            b2.prev_block_id.as_deref(),
            Some("compacted-summary-1-1"),
            "prev_block_id = 链尾块（list 首条）"
        );
    }

    #[tokio::test]
    async fn persist_block_details_fields_take_priority() {
        let db = seeded_db("s1", 1);
        let store: Arc<dyn Store> = Arc::new(LocalDbStore::new(db.clone()));
        let mut record = plain_record("record-id", vec!["u1"]);
        // 轮次 4 织入形态：details 携带块语义键（camelCase）
        record.details = Some(conex_types::tool::compaction_block_details(
            "compacted-summary-3-5",
            3,
            Some("compacted-summary-2-4"),
            1_752_000_000_000,
            "committed",
        ));
        let event = compression_event(record);

        persist_compression_block(store.as_ref(), "s1", &event, 7)
            .await
            .unwrap();

        let block = db
            .get_block("s1", "compacted-summary-3-5")
            .unwrap()
            .unwrap();
        assert_eq!(
            block.block_id, "compacted-summary-3-5",
            "details.blockId 优先于 record.id"
        );
        assert_eq!(block.generation, 3, "details.generation 优先于事件计数");
        assert_eq!(
            block.prev_block_id.as_deref(),
            Some("compacted-summary-2-4")
        );
        assert_eq!(block.dropped_at_ms, 1_752_000_000_000);
        assert_eq!(block.state, BlockState::Committed, "details.summaryState");
        assert!(block.summary_is_llm, "committed ⇒ LLM 摘要");
        assert_eq!(block.attempts, 1, "同步成功 = 1 次尝试");
    }

    #[tokio::test]
    async fn persist_block_skips_without_local_db_or_non_compression_event() {
        // InMemoryStore（测试替身）无 LocalDb → Ok 跳过
        let mem: Arc<dyn Store> = Arc::new(InMemoryStore::new());
        let event = compression_event(plain_record("b1", vec!["u1"]));
        persist_compression_block(mem.as_ref(), "s1", &event, 1)
            .await
            .unwrap();
        assert!(mem.as_local_db().is_none());

        // 非压缩事件 → Ok 跳过（不误写块）
        let db = seeded_db("s1", 0);
        let store: Arc<dyn Store> = Arc::new(LocalDbStore::new(db.clone()));
        let other = AgentEvent::AgentStart {
            session_id: "s1".to_string(),
            timestamp: "2026-08-08T00:00:00.000Z".to_string(),
        };
        persist_compression_block(store.as_ref(), "s1", &other, 1)
            .await
            .unwrap();
        assert_eq!(db.count_blocks("s1").unwrap(), 0);
    }

    #[tokio::test]
    async fn persist_block_cross_session_same_block_id_isolated() {
        let db = seeded_db("s1", 1);
        db.insert_session("s2", "s2").unwrap();
        let store: Arc<dyn Store> = Arc::new(LocalDbStore::new(db.clone()));
        let event = compression_event(plain_record("b1", vec!["u1"]));

        // 会话 s1 写块（事件已落库）；s2 事件流无压缩事件 → 兜底代数 1
        persist_compression_block(store.as_ref(), "s1", &event, 42)
            .await
            .unwrap();
        persist_compression_block(store.as_ref(), "s2", &event, 43)
            .await
            .unwrap();
        assert_eq!(db.count_blocks("s1").unwrap(), 1);
        assert_eq!(
            db.count_blocks("s2").unwrap(),
            1,
            "跨会话同 block_id 各自成行"
        );
    }

    // ── T-42：摘要任务完成回调落库面（两阶段写协议阶段二）─────────────

    /// 先插行（压缩时创建，state=awaiting）→ 调度器成功后推进：
    /// summary_json / state=committed / attempts 更新、height 保持
    #[tokio::test]
    async fn update_block_summary_advances_row() {
        let db = seeded_db("s1", 1);
        let store: Arc<dyn Store> = Arc::new(LocalDbStore::new(db.clone()));
        persist_compression_block(
            store.as_ref(),
            "s1",
            &compression_event(plain_record("compacted-summary-1-1", vec!["u1"])),
            42,
        )
        .await
        .unwrap();
        assert_eq!(
            db.get_block("s1", "compacted-summary-1-1")
                .unwrap()
                .unwrap()
                .state,
            BlockState::Awaiting
        );

        let json = r#"{"schemaVersion":1,"blockId":"compacted-summary-1-1","generation":1}"#;
        update_compression_block_summary(
            store.as_ref(),
            "s1",
            "compacted-summary-1-1",
            BlockState::Committed,
            Some(json),
            2,
        )
        .unwrap();

        let row = db
            .get_block("s1", "compacted-summary-1-1")
            .unwrap()
            .unwrap();
        assert_eq!(row.state, BlockState::Committed, "调度器成功后 state 推进");
        assert_eq!(row.summary_json.as_deref(), Some(json), "JSON 规范面落库");
        assert_eq!(row.attempts, 2, "累计尝试（同步 1 + 后台 1）");
        assert_eq!(row.height, 1, "height 保持（V1 后台不读表合并）");
        assert!(row.summary_is_llm, "committed ⇒ LLM 摘要");
    }

    /// retired 推进：重试耗尽 → state=retired + attempts 累计（stub 永驻，
    /// R-C：summary_json 保持 None）
    #[tokio::test]
    async fn update_block_summary_retires_after_exhaustion() {
        let db = seeded_db("s1", 1);
        let store: Arc<dyn Store> = Arc::new(LocalDbStore::new(db.clone()));
        persist_compression_block(
            store.as_ref(),
            "s1",
            &compression_event(plain_record("b-retired", vec!["u1"])),
            42,
        )
        .await
        .unwrap();

        update_compression_block_summary(
            store.as_ref(),
            "s1",
            "b-retired",
            BlockState::Retired,
            None,
            4,
        )
        .unwrap();

        let row = db.get_block("s1", "b-retired").unwrap().unwrap();
        assert_eq!(row.state, BlockState::Retired);
        assert_eq!(row.attempts, 4, "retired 阈值 = 4（含同步那次）");
        assert_eq!(row.summary_json, None, "失败不写 JSON");
    }

    /// 幂等：行不存在 → Ok 无操作（不报错）；重复推进成功
    #[tokio::test]
    async fn update_block_summary_idempotent_and_missing_row_noop() {
        let db = seeded_db("s1", 1);
        let store: Arc<dyn Store> = Arc::new(LocalDbStore::new(db.clone()));

        // 行不存在 → Ok 无操作（两阶段写协议阶段一缺失时的防御）
        update_compression_block_summary(
            store.as_ref(),
            "s1",
            "never-created",
            BlockState::Committed,
            Some("{}"),
            1,
        )
        .unwrap();
        assert_eq!(db.count_blocks("s1").unwrap(), 0, "不误建行");

        // 正常推进两次 → 第二次仍成功（UPDATE 幂等）
        persist_compression_block(
            store.as_ref(),
            "s1",
            &compression_event(plain_record("b-again", vec!["u1"])),
            42,
        )
        .await
        .unwrap();
        update_compression_block_summary(
            store.as_ref(),
            "s1",
            "b-again",
            BlockState::Committed,
            Some("{}"),
            1,
        )
        .unwrap();
        update_compression_block_summary(
            store.as_ref(),
            "s1",
            "b-again",
            BlockState::Committed,
            Some("{}"),
            1,
        )
        .unwrap();
        assert_eq!(db.count_blocks("s1").unwrap(), 1, "重复推进不重复行");
    }

    /// 测试替身（InMemoryStore 无 LocalDb）→ Ok 跳过（不 panic）
    #[tokio::test]
    async fn update_block_summary_skips_without_local_db() {
        let mem: Arc<dyn Store> = Arc::new(InMemoryStore::new());
        update_compression_block_summary(mem.as_ref(), "s1", "b1", BlockState::Committed, None, 1)
            .unwrap();
        assert!(mem.as_local_db().is_none());
    }
}
