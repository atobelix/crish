//! 协作子代理域：session_agents 表（含 session_agent_messages）的读写。
//!
//! 写面约定（11-T3 单行定点写收束）：
//! - **全量保存 [Self::save_session_agents] 仅快照面**（session_commands.rs:238-247
//!   前端显式保存 / 导入 + 测试面）；先删后插会触发 session_agent_messages
//!   FK 级联清空，且与引擎并发写构成「后写者覆盖先写者新增行」竞态；
//! - **引擎侧并发写一律走单行 API**：[Self::upsert_session_agent]（spawn 落库，
//!   ON CONFLICT DO UPDATE 防级联清 messages）/ [Self::update_session_agent_status]
//!   （kill_all / resume / 启动失败兜底）/ [Self::update_session_agent_path]
//!   （恢复域路径写面）；
//! - 加载面（全量 / 按父状态过滤）与 localStorage 导入用的宽容解析助手不变。

use super::{DbFailure, DbFailureKind, LocalDb};
use conex_types::{SessionAgent, SessionMessage};

/// session_agents 行 → SessionAgent 映射（全量加载与查询扩展共用，
/// 唯一真源，防两份查询口径漂移）
fn map_agent_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<SessionAgent> {
    Ok(SessionAgent {
        id: row.get(0)?,
        subagent_run_id: row.get(1)?,
        parent_session_id: row.get(2)?,
        parent_run_id: row.get(3)?,
        parent_tool_call_id: row.get(4)?,
        description: row.get(5)?,
        mode: row.get(6)?,
        status: row.get(7)?,
        summary: row.get(8)?,
        started_at: row.get(9)?,
        ended_at: row.get(10)?,
        depth: row.get(11)?,
        subagent_path_json: row.get(12)?,
        // v6 新列（T-D-07 定义扩展）：task_type / display_label /
        // allowed_write_paths_json（model_override 不落库）
        task_type: row.get(13)?,
        display_label: row.get(14)?,
        allowed_write_paths_json: row.get(15)?,
        messages: Vec::new(),
    })
}

impl LocalDb {
    /// 加载会话下的协作子 agent（含每个 agent 的消息，按 seq 升序）。
    pub fn load_session_agents(&self, session_id: &str) -> Result<Vec<SessionAgent>, DbFailure> {
        let conn = self.conn.lock().map_err(|e| DbFailure {
            message: format!("lock poisoned: {e}"),
            kind: DbFailureKind::Lock,
        })?;

        let mut agent_stmt = conn
            .prepare(
                "SELECT agent_id, subagent_run_id, parent_session_id, parent_run_id,
                        parent_tool_call_id, description, mode, status, summary,
                        started_at, ended_at, depth, subagent_path_json,
                        task_type, display_label, allowed_write_paths_json
                 FROM session_agents
                 WHERE session_id = ?1
                 ORDER BY started_at ASC, agent_id ASC",
            )
            .map_err(|e| self.latch_error("load_session_agents_prepare", e))?;

        let agent_rows: Vec<SessionAgent> = agent_stmt
            .query_map(rusqlite::params![session_id], map_agent_row)
            .map_err(|e| self.latch_error("load_session_agents_map", e))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| self.latch_error("load_session_agents_collect", e))?;

        // 为每个 agent 单独查询消息
        let mut agents = agent_rows;
        for agent in &mut agents {
            agent.messages = self.load_agent_messages(&conn, session_id, &agent.id)?;
        }

        Ok(agents)
    }

    /// 加载全部 status='running' 的会话协作子代理行（PERSIST-02 P1-3：
    /// restore 崩溃归一用——子代理运行中崩溃后行残留 running，需归一为
    /// failed + ended_at，防 FlowScheduler 重建后节点永久 Running）。
    ///
    /// 轻量定位查询：只返回 (session_id, subagent_run_id) 键对，不加载
    /// 行内容与消息——归一写面（[Self::update_session_agent_status]）
    /// 不需要行内容；消息面由既有加载 API 承担。
    pub fn load_running_session_agents(&self) -> Result<Vec<(String, String)>, DbFailure> {
        let conn = self.conn.lock().map_err(|e| DbFailure {
            message: format!("lock poisoned: {e}"),
            kind: DbFailureKind::Lock,
        })?;

        let mut stmt = conn
            .prepare(
                "SELECT session_id, subagent_run_id
                 FROM session_agents
                 WHERE status = 'running'",
            )
            .map_err(|e| self.latch_error("load_running_session_agents_prepare", e))?;

        let rows = stmt
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
            .map_err(|e| self.latch_error("load_running_session_agents_map", e))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| self.latch_error("load_running_session_agents_collect", e))?;
        Ok(rows)
    }

    /// 查询扩展（T-D-09）：按父会话 + 状态过滤加载子代理行（kill_all
    /// 过滤面：parent_session_id = 主会话 且 status = running）。
    ///
    /// 与 [Self::load_session_agents] 的差异仅在 WHERE 条件；消息照常
    /// 逐个加载，行为与全量加载完全一致（messages 一并带回）。
    pub fn load_session_agents_by_parent_status(
        &self,
        parent_session_id: &str,
        status: &str,
    ) -> Result<Vec<SessionAgent>, DbFailure> {
        let conn = self.conn.lock().map_err(|e| DbFailure {
            message: format!("lock poisoned: {e}"),
            kind: DbFailureKind::Lock,
        })?;

        let mut agent_stmt = conn
            .prepare(
                "SELECT agent_id, subagent_run_id, parent_session_id, parent_run_id,
                        parent_tool_call_id, description, mode, status, summary,
                        started_at, ended_at, depth, subagent_path_json,
                        task_type, display_label, allowed_write_paths_json
                 FROM session_agents
                 WHERE parent_session_id = ?1 AND status = ?2
                 ORDER BY started_at ASC, agent_id ASC",
            )
            .map_err(|e| self.latch_error("load_session_agents_by_parent_status_prepare", e))?;

        let agent_rows: Vec<SessionAgent> = agent_stmt
            .query_map(rusqlite::params![parent_session_id, status], map_agent_row)
            .map_err(|e| self.latch_error("load_session_agents_by_parent_status_map", e))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| self.latch_error("load_session_agents_by_parent_status_collect", e))?;

        let mut agents = agent_rows;
        for agent in &mut agents {
            agent.messages = self.load_agent_messages(&conn, parent_session_id, &agent.id)?;
        }
        Ok(agents)
    }

    /// 加载单个子代理的消息（session_agent_messages，按 seq 升序）。
    ///
    /// 全量加载与查询扩展共用同一消息加载面（唯一真源，防两份查询
    /// 口径漂移）；调用方须已持有连接锁。
    fn load_agent_messages(
        &self,
        conn: &rusqlite::Connection,
        session_id: &str,
        agent_id: &str,
    ) -> Result<Vec<SessionMessage>, DbFailure> {
        let mut msg_stmt = conn
            .prepare(
                "SELECT id, sender, text, thinking, timestamp, status,
                        stream_text_offset, thinking_time, tool_calls_json,
                        blocks_json, tool_call_results_json
                 FROM session_agent_messages
                 WHERE session_id = ?1 AND agent_id = ?2
                 ORDER BY seq ASC",
            )
            .map_err(|e| self.latch_error("load_agent_messages_prepare", e))?;
        let messages = msg_stmt
            .query_map(rusqlite::params![session_id, agent_id], |row| {
                Ok(SessionMessage {
                    id: row.get(0)?,
                    sender: row.get(1)?,
                    text: row.get(2)?,
                    thinking: row.get(3)?,
                    timestamp: row.get(4)?,
                    status: row.get(5)?,
                    stream_text_offset: row.get(6)?,
                    thinking_time: row.get(7)?,
                    tool_calls_json: row.get(8)?,
                    blocks_json: row.get(9)?,
                    tool_call_results_json: row.get(10)?,
                    // session_agent_messages 无 usage_json 列（v5 仅
                    // session_messages 有），子 agent 消息不回放缓存指标
                    usage: None,
                })
            })
            .map_err(|e| self.latch_error("load_agent_messages_map", e))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| self.latch_error("load_agent_messages_collect", e))?;
        Ok(messages)
    }

    /// 全量保存会话的协作子 agent（先删后插，事务原子）。
    pub fn save_session_agents(
        &self,
        session_id: &str,
        agents: &[SessionAgent],
    ) -> Result<(), DbFailure> {
        let mut conn = self.conn.lock().map_err(|e| DbFailure {
            message: format!("lock poisoned: {e}"),
            kind: DbFailureKind::Lock,
        })?;

        let tx = conn
            .transaction()
            .map_err(|e| self.latch_error("save_session_agents_tx", e))?;

        // 级联 FK 会自动清理 session_agent_messages
        tx.execute(
            "DELETE FROM session_agents WHERE session_id = ?1",
            rusqlite::params![session_id],
        )
        .map_err(|e| self.latch_error("save_session_agents_delete", e))?;

        for agent in agents {
            tx.execute(
                "INSERT INTO session_agents (
                    session_id, agent_id, subagent_run_id, parent_session_id, parent_run_id,
                    parent_tool_call_id, description, mode, status, summary,
                    started_at, ended_at, depth, subagent_path_json,
                    task_type, display_label, allowed_write_paths_json
                ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17)",
                rusqlite::params![
                    session_id,
                    agent.id,
                    agent.subagent_run_id,
                    agent.parent_session_id,
                    agent.parent_run_id,
                    agent.parent_tool_call_id,
                    agent.description,
                    agent.mode,
                    agent.status,
                    agent.summary,
                    agent.started_at,
                    agent.ended_at,
                    agent.depth,
                    agent.subagent_path_json,
                    agent.task_type,
                    agent.display_label,
                    agent.allowed_write_paths_json,
                ],
            )
            .map_err(|e| self.latch_error("save_session_agents_insert", e))?;

            for (seq, msg) in agent.messages.iter().enumerate() {
                let seq_i64 = seq as i64;
                tx.execute(
                    "INSERT INTO session_agent_messages (
                        session_id, agent_id, seq, id, sender, text, thinking, timestamp, status,
                        stream_text_offset, thinking_time, tool_calls_json,
                        blocks_json, tool_call_results_json
                    ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)",
                    rusqlite::params![
                        session_id,
                        agent.id,
                        seq_i64,
                        msg.id,
                        msg.sender,
                        msg.text,
                        msg.thinking,
                        msg.timestamp,
                        msg.status,
                        msg.stream_text_offset,
                        msg.thinking_time,
                        msg.tool_calls_json,
                        msg.blocks_json,
                        msg.tool_call_results_json,
                    ],
                )
                .map_err(|e| self.latch_error("save_session_agents_msg_insert", e))?;
            }
        }

        tx.commit()
            .map_err(|e| self.latch_error("save_session_agents_commit", e))?;

        Ok(())
    }

    /// 单行更新 status / ended_at（kill_all 用）。只动目标行，不碰 messages。
    ///
    /// 缺行静默成功（返回受影响行数 0，不报错——与 save 面宽容语义一致）；
    /// 返回 1 = 目标行已更新。调用方按返回值自行判定 NotFound。
    ///
    /// ended_at 语义：仅当原值为 NULL 才写入（SQL:
    /// `ended_at = COALESCE(ended_at, ?4)`），保持「已结束行不覆盖」语义
    /// （对齐 lifecycle.rs 既有 is_none 判定）。
    pub fn update_session_agent_status(
        &self,
        session_id: &str,
        subagent_run_id: &str,
        status: &str,
        ended_at: Option<i64>,
    ) -> Result<usize, DbFailure> {
        let conn = self.conn.lock().map_err(|e| DbFailure {
            message: format!("lock poisoned: {e}"),
            kind: DbFailureKind::Lock,
        })?;
        conn.execute(
            "UPDATE session_agents
             SET status = ?3, ended_at = COALESCE(ended_at, ?4)
             WHERE session_id = ?1 AND subagent_run_id = ?2",
            rusqlite::params![session_id, subagent_run_id, status, ended_at],
        )
        .map_err(|e| self.latch_error("update_session_agent_status", e))
    }

    /// 单行更新 subagent_path_json（set_subagent_path 用）。
    ///
    /// 缺行静默成功（返回受影响行数 0）；返回 1 = 目标行已更新。
    /// 调用方（recovery）自行按返回值判定 NotFound。
    pub fn update_session_agent_path(
        &self,
        session_id: &str,
        subagent_run_id: &str,
        path_json: &str,
    ) -> Result<usize, DbFailure> {
        let conn = self.conn.lock().map_err(|e| DbFailure {
            message: format!("lock poisoned: {e}"),
            kind: DbFailureKind::Lock,
        })?;
        conn.execute(
            "UPDATE session_agents
             SET subagent_path_json = ?3
             WHERE session_id = ?1 AND subagent_run_id = ?2",
            rusqlite::params![session_id, subagent_run_id, path_json],
        )
        .map_err(|e| self.latch_error("update_session_agent_path", e))
    }

    /// 单行 upsert（spawn 落库用）。全 17 列 `INSERT ... ON CONFLICT(session_id,
    /// agent_id) DO UPDATE SET`（v6 三列 task_type / display_label /
    /// allowed_write_paths_json 随行），字段集与 [Self::save_session_agents]
    /// 列清单严格一致（map_agent_row 双向核对）。
    ///
    /// 关键：**禁止 INSERT OR REPLACE**——REPLACE 语义 = DELETE + INSERT，
    /// PK 冲突会删除旧行并触发 session_agent_messages 的 FK 级联清空该 agent
    /// 全部消息；ON CONFLICT DO UPDATE 保留旧行与 messages。
    pub fn upsert_session_agent(&self, row: &SessionAgent) -> Result<(), DbFailure> {
        let conn = self.conn.lock().map_err(|e| DbFailure {
            message: format!("lock poisoned: {e}"),
            kind: DbFailureKind::Lock,
        })?;
        conn.execute(
            "INSERT INTO session_agents (
                session_id, agent_id, subagent_run_id, parent_session_id, parent_run_id,
                parent_tool_call_id, description, mode, status, summary,
                started_at, ended_at, depth, subagent_path_json,
                task_type, display_label, allowed_write_paths_json
            ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17)
            ON CONFLICT(session_id, agent_id) DO UPDATE SET
                subagent_run_id = excluded.subagent_run_id,
                parent_session_id = excluded.parent_session_id,
                parent_run_id = excluded.parent_run_id,
                parent_tool_call_id = excluded.parent_tool_call_id,
                description = excluded.description,
                mode = excluded.mode,
                status = excluded.status,
                summary = excluded.summary,
                started_at = excluded.started_at,
                ended_at = excluded.ended_at,
                depth = excluded.depth,
                subagent_path_json = excluded.subagent_path_json,
                task_type = excluded.task_type,
                display_label = excluded.display_label,
                allowed_write_paths_json = excluded.allowed_write_paths_json",
            rusqlite::params![
                row.parent_session_id,
                row.id,
                row.subagent_run_id,
                row.parent_session_id,
                row.parent_run_id,
                row.parent_tool_call_id,
                row.description,
                row.mode,
                row.status,
                row.summary,
                row.started_at,
                row.ended_at,
                row.depth,
                row.subagent_path_json,
                row.task_type,
                row.display_label,
                row.allowed_write_paths_json,
            ],
        )
        .map_err(|e| self.latch_error("upsert_session_agent", e))?;
        Ok(())
    }
}

/// 宽容解析 agent 数组：坏元素跳过，整体不失败。
pub(crate) fn parse_session_agents_safe(raw: &str) -> Vec<SessionAgent> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Vec::new();
    }
    serde_json::from_str::<Vec<SessionAgent>>(trimmed).unwrap_or_default()
}

#[cfg(test)]
mod tests {
    //! 11-T3 单行定点 API 行为测试：真实 SQLite + 真实 LocalDb，无替身。

    use super::*;
    use conex_types::SessionIndexEntry;
    use std::sync::Arc;

    /// 会话索引条目（session_agents FK 指向 sessions，需先建会话）
    fn session_entry(id: &str) -> SessionIndexEntry {
        SessionIndexEntry {
            id: id.to_string(),
            title: format!("Title {id}"),
            folder: "常规会话".to_string(),
            is_pinned: false,
            is_archived: false,
            branch_parent_id: None,
            timestamp: "2026-08-06T00:00:00Z".to_string(),
            updated_at: 1000,
            message_count: 0,
            pinned_message_ids: None,
            engine_cursor: None,
            engine_last_run_id: None,
            hydrated_from_engine: None,
        }
    }

    /// 子代理行构造（消息与 v6 三列可选）
    fn agent(
        id: &str,
        run_id: &str,
        status: &str,
        session_id: &str,
        ended_at: Option<i64>,
        path: Option<&str>,
        messages: Vec<SessionMessage>,
    ) -> SessionAgent {
        SessionAgent {
            id: id.to_string(),
            subagent_run_id: run_id.to_string(),
            parent_session_id: session_id.to_string(),
            parent_run_id: format!("prun-{run_id}"),
            parent_tool_call_id: None,
            description: String::new(),
            mode: String::new(),
            status: status.to_string(),
            summary: None,
            messages,
            started_at: 100,
            ended_at,
            depth: Some(1),
            subagent_path_json: path.map(str::to_string),
            task_type: Some(format!("task-{id}")),
            display_label: Some(format!("标签-{id}")),
            allowed_write_paths_json: Some(r#"["docs/notes"]"#.to_string()),
        }
    }

    /// 子代理消息构造
    fn msg(id: &str, sender: &str, ts: i64) -> SessionMessage {
        SessionMessage {
            id: id.to_string(),
            sender: sender.to_string(),
            text: Some(format!("text-{id}")),
            thinking: None,
            timestamp: ts,
            status: Some("completed".to_string()),
            stream_text_offset: None,
            thinking_time: None,
            tool_calls_json: None,
            blocks_json: None,
            tool_call_results_json: None,
            usage: None,
        }
    }

    /// 预置两条子代理行（a1 running + 消息、a2 completed + 消息）
    fn seed_two_rows(db: &LocalDb, session_id: &str) {
        db.upsert_session_entry(&session_entry(session_id)).unwrap();
        db.save_session_agents(
            session_id,
            &[
                agent("a1", "run-1", "running", session_id, None, None, vec![msg("m1", "user", 1)]),
                agent(
                    "a2",
                    "run-2",
                    "completed",
                    session_id,
                    Some(200),
                    Some(r#"["root"]"#),
                    vec![msg("m2", "assistant", 2)],
                ),
            ],
        )
        .unwrap();
    }

    /// 预置两条 running 子代理行（交错场景测试的 kill 目标）
    fn seed_running_rows(db: &LocalDb, session_id: &str) {
        db.upsert_session_entry(&session_entry(session_id)).unwrap();
        db.save_session_agents(
            session_id,
            &[
                agent("a1", "run-1", "running", session_id, None, None, vec![msg("m1", "user", 1)]),
                agent("a2", "run-2", "running", session_id, None, None, vec![msg("m2", "assistant", 2)]),
            ],
        )
        .unwrap();
    }

    /// PERSIST-02 P1-3：全库 running 行定位（崩溃归一数据源）——只返回
    /// running 行键对，终态行不出现；跨会话全量
    #[test]
    fn load_running_rows_returns_running_pairs_across_sessions() {
        let db = LocalDb::open_in_memory().unwrap();
        db.upsert_session_entry(&session_entry("s1")).unwrap();
        db.upsert_session_entry(&session_entry("s2")).unwrap();
        db.save_session_agents(
            "s1",
            &[
                agent("a1", "run-1", "running", "s1", None, None, Vec::new()),
                agent("a2", "run-2", "completed", "s1", Some(200), None, Vec::new()),
            ],
        )
        .unwrap();
        db.save_session_agents(
            "s2",
            &[agent("a3", "run-3", "running", "s2", None, None, Vec::new())],
        )
        .unwrap();

        let running = db.load_running_session_agents().unwrap();
        assert_eq!(running.len(), 2, "仅 running 行（终态行不出现）");
        assert!(
            running.contains(&("s1".to_string(), "run-1".to_string())),
            "跨会话定位 s1/run-1"
        );
        assert!(
            running.contains(&("s2".to_string(), "run-3".to_string())),
            "跨会话定位 s2/run-3"
        );
    }

    /// PERSIST-02 P1-3：归一循环端到端——load_running →
    /// update_session_agent_status（failed + ended_at）→ 行进入终态
    /// （restore 崩溃归一的写面等价于 kill_all 逐行语义）
    #[test]
    fn running_rows_can_be_normalized_via_update_status() {
        let db = LocalDb::open_in_memory().unwrap();
        seed_running_rows(&db, "s1");

        let running = db.load_running_session_agents().unwrap();
        assert_eq!(running.len(), 2);
        for (session_id, run_id) in &running {
            db.update_session_agent_status(session_id, run_id, "failed", Some(999))
                .unwrap();
        }

        let rows = db.load_session_agents("s1").unwrap();
        assert!(rows.iter().all(|r| r.status == "failed"), "全部归一 failed");
        assert!(rows.iter().all(|r| r.ended_at == Some(999)), "ended_at 落库");
        assert!(
            db.load_running_session_agents().unwrap().is_empty(),
            "归一后无 running 残留（幂等，重复 restore 不再命中）"
        );
        // messages 原样保留（单行定点写，级联不触发）
        assert!(rows.iter().all(|r| r.messages.len() == 1));
    }

    /// 更新目标行 status/ended_at；非目标行与 messages 字节原样
    #[test]
    fn update_status_updates_only_target_row() {
        let db = LocalDb::open_in_memory().unwrap();
        seed_two_rows(&db, "s1");

        let affected = db
            .update_session_agent_status("s1", "run-1", "failed", Some(999))
            .unwrap();
        assert_eq!(affected, 1, "目标行应恰好更新一行");

        let rows = db.load_session_agents("s1").unwrap();
        assert_eq!(rows.len(), 2);
        let a1 = rows.iter().find(|a| a.id == "a1").unwrap();
        assert_eq!(a1.status, "failed");
        assert_eq!(a1.ended_at, Some(999));
        assert_eq!(a1.messages.len(), 1, "messages 原样保留");
        assert_eq!(a1.messages[0].id, "m1");
        // 非目标行不动
        let a2 = rows.iter().find(|a| a.id == "a2").unwrap();
        assert_eq!(a2.status, "completed", "非目标行 status 原样");
        assert_eq!(a2.ended_at, Some(200), "非目标行 ended_at 原样");
        assert_eq!(a2.subagent_path_json.as_deref(), Some(r#"["root"]"#));
        assert_eq!(a2.messages[0].id, "m2", "非目标行 messages 原样");
    }

    /// COALESCE 语义：已 ended 行的 ended_at 不被覆盖
    #[test]
    fn update_status_keeps_existing_ended_at() {
        let db = LocalDb::open_in_memory().unwrap();
        seed_two_rows(&db, "s1");

        // 目标行已 ended（Some(200)）：新 ended_at 不应覆盖
        let affected = db
            .update_session_agent_status("s1", "run-2", "failed", Some(999))
            .unwrap();
        assert_eq!(affected, 1);
        let rows = db.load_session_agents("s1").unwrap();
        let a2 = rows.iter().find(|a| a.id == "a2").unwrap();
        assert_eq!(a2.status, "failed");
        assert_eq!(a2.ended_at, Some(200), "已 ended 行 ended_at 保留（COALESCE）");

        // ended_at=None 也不覆盖既有值
        let affected = db
            .update_session_agent_status("s1", "run-2", "failed", None)
            .unwrap();
        assert_eq!(affected, 1);
        let rows = db.load_session_agents("s1").unwrap();
        let a2 = rows.iter().find(|a| a.id == "a2").unwrap();
        assert_eq!(a2.ended_at, Some(200), "None 不覆盖既有 ended_at");
    }

    /// 缺行静默成功：affected = 0，不报错
    #[test]
    fn update_status_missing_row_returns_zero() {
        let db = LocalDb::open_in_memory().unwrap();
        seed_two_rows(&db, "s1");

        let affected = db
            .update_session_agent_status("s1", "no-such-run", "failed", Some(1))
            .unwrap();
        assert_eq!(affected, 0, "缺行静默成功（affected=0）");
        assert!(db.get_failure().is_none(), "缺行不落失败闩");
    }

    /// 只更新路径列：其余字段（status/ended_at/messages）字节原样
    #[test]
    fn update_path_updates_only_path_column() {
        let db = LocalDb::open_in_memory().unwrap();
        seed_two_rows(&db, "s1");

        let affected = db
            .update_session_agent_path("s1", "run-1", r#"["root","leaf-1"]"#)
            .unwrap();
        assert_eq!(affected, 1);

        let rows = db.load_session_agents("s1").unwrap();
        let a1 = rows.iter().find(|a| a.id == "a1").unwrap();
        assert_eq!(a1.subagent_path_json.as_deref(), Some(r#"["root","leaf-1"]"#));
        assert_eq!(a1.status, "running", "路径更新不动 status");
        assert_eq!(a1.ended_at, None);
        assert_eq!(a1.messages[0].id, "m1", "路径更新不动 messages");
        // 非目标行路径原样
        let a2 = rows.iter().find(|a| a.id == "a2").unwrap();
        assert_eq!(a2.subagent_path_json.as_deref(), Some(r#"["root"]"#));
    }

    /// 缺行静默成功：affected = 0（recovery 按 0 判定 NotFound）
    #[test]
    fn update_path_missing_row_returns_zero() {
        let db = LocalDb::open_in_memory().unwrap();
        seed_two_rows(&db, "s1");

        let affected = db
            .update_session_agent_path("s1", "no-such-run", "[]")
            .unwrap();
        assert_eq!(affected, 0);
        assert!(db.get_failure().is_none(), "缺行不落失败闩");
    }

    /// upsert：插入新行；同 PK 二次 upsert 覆盖列值但 messages 保留
    /// （级联不触发）；v6 三列随行；幂等
    #[test]
    fn upsert_inserts_and_updates_preserving_messages() {
        let db = LocalDb::open_in_memory().unwrap();
        db.upsert_session_entry(&session_entry("s1")).unwrap();
        let row = agent("a1", "run-1", "running", "s1", None, None, vec![msg("m1", "user", 1)]);
        // 首写经 save（消息随行）；后续引擎写一律走 upsert
        db.save_session_agents("s1", &[row.clone()]).unwrap();

        // 同 PK 二次 upsert：列值更新（status → completed、路径写入），
        // 行数不变、messages 保留（ON CONFLICT DO UPDATE 不触发级联）
        let mut updated = row.clone();
        updated.status = "completed".to_string();
        updated.ended_at = Some(500);
        updated.subagent_path_json = Some(r#"["root","leaf-1"]"#.to_string());
        updated.task_type = Some("analysis".to_string());
        db.upsert_session_agent(&updated).unwrap();

        let rows = db.load_session_agents("s1").unwrap();
        assert_eq!(rows.len(), 1, "同 PK upsert 不新增行");
        assert_eq!(rows[0].status, "completed", "列值被覆盖");
        assert_eq!(rows[0].ended_at, Some(500));
        assert_eq!(rows[0].subagent_path_json.as_deref(), Some(r#"["root","leaf-1"]"#));
        assert_eq!(rows[0].task_type.as_deref(), Some("analysis"));
        assert_eq!(rows[0].messages.len(), 1, "messages 保留（级联未触发）");
        assert_eq!(rows[0].messages[0].id, "m1");

        // v6 三列随行（display_label / 写路径白名单读回）
        assert_eq!(rows[0].display_label.as_deref(), Some("标签-a1"));
        assert_eq!(rows[0].allowed_write_paths_json.as_deref(), Some(r#"["docs/notes"]"#));

        // 幂等：再次 upsert 同 PK 仍单行
        db.upsert_session_agent(&updated).unwrap();
        let rows = db.load_session_agents("s1").unwrap();
        assert_eq!(rows.len(), 1, "幂等：行数不变");

        // 新 PK：插入新行
        let new_row = agent("a2", "run-2", "running", "s1", None, None, Vec::new());
        db.upsert_session_agent(&new_row).unwrap();
        let rows = db.load_session_agents("s1").unwrap();
        assert_eq!(rows.len(), 2, "不同 PK 插入新行");
    }

    /// ON CONFLICT 显式防 REPLACE 回归：多消息行 upsert 后消息全量保留
    #[test]
    fn upsert_does_not_cascade_clear_messages() {
        let db = LocalDb::open_in_memory().unwrap();
        db.upsert_session_entry(&session_entry("s1")).unwrap();
        let row = agent(
            "a1",
            "run-1",
            "running",
            "s1",
            None,
            None,
            vec![msg("m1", "user", 1), msg("m2", "assistant", 2)],
        );
        db.save_session_agents("s1", &[row.clone()]).unwrap();

        // 同 PK upsert（等价 INSERT OR REPLACE 的触发面：PK 冲突）
        let mut updated = row.clone();
        updated.status = "failed".to_string();
        db.upsert_session_agent(&updated).unwrap();

        let rows = db.load_session_agents("s1").unwrap();
        assert_eq!(rows[0].messages.len(), 2, "级联清空不触发（禁止 REPLACE 回归）");
        assert_eq!(rows[0].messages[0].id, "m1");
        assert_eq!(rows[0].messages[1].id, "m2");
    }

    /// 交错场景不丢行（N05 根因回归）：kill_all 写面（查询面 → 逐行
    /// update_session_agent_status）与并发 spawn（upsert）交错时，
    /// spawn 新行必须保留——旧全量先删后插会把新行整批删掉
    #[test]
    fn kill_spawn_interleave_keeps_all_rows() {
        let db = Arc::new(LocalDb::open_in_memory().unwrap());
        seed_running_rows(&db, "s1");

        // 确定性交错：kill 侧先取目标快照（查询面），spawn 侧在其
        // 写面前 upsert 新行（屏障保证落点 = 「kill 中 spawn」）
        let barrier = Arc::new(std::sync::Barrier::new(2));
        let kill_db = db.clone();
        let barrier_kill = barrier.clone();
        let kill_thread = std::thread::spawn(move || {
            let targets = kill_db
                .load_session_agents_by_parent_status("s1", "running")
                .unwrap();
            barrier_kill.wait();
            for target in &targets {
                kill_db
                    .update_session_agent_status("s1", &target.subagent_run_id, "failed", Some(999))
                    .unwrap();
            }
        });
        let spawn_db = db.clone();
        let barrier_spawn = barrier.clone();
        let spawn_thread = std::thread::spawn(move || {
            barrier_spawn.wait();
            let new_row = agent("a3", "run-3", "running", "s1", None, None, Vec::new());
            spawn_db.upsert_session_agent(&new_row).unwrap();
        });
        kill_thread.join().unwrap();
        spawn_thread.join().unwrap();

        // 行数 = 两方行数之和（3）：spawn 新行不再被整批删除
        let rows = db.load_session_agents("s1").unwrap();
        assert_eq!(rows.len(), 3, "kill 中 spawn 不丢行");
        let by_id = |id: &str| rows.iter().find(|a| a.id == id).unwrap();
        assert_eq!(by_id("a1").status, "failed", "目标行归一 failed");
        assert_eq!(by_id("a2").status, "failed");
        assert_eq!(by_id("a3").status, "running", "并发 spawn 行未被误删未改");
        assert_eq!(by_id("a3").subagent_run_id, "run-3");
        assert_eq!(by_id("a3").depth, Some(1));
    }

    /// 先 spawn 后 kill：既有行与 spawn 行并存，目标行归一
    #[test]
    fn spawn_then_kill_keeps_all_rows() {
        let db = LocalDb::open_in_memory().unwrap();
        seed_running_rows(&db, "s1");

        // 先 spawn（upsert 新行）
        let new_row = agent("a3", "run-3", "running", "s1", None, None, Vec::new());
        db.upsert_session_agent(&new_row).unwrap();

        // 后 kill（对目标行逐条单行更新：a3 已是 running，一并命中）
        let targets = db.load_session_agents_by_parent_status("s1", "running").unwrap();
        assert_eq!(targets.len(), 3, "目标 = 三个 running 行（含 spawn 行）");
        for target in &targets {
            db.update_session_agent_status("s1", &target.subagent_run_id, "failed", Some(999))
                .unwrap();
        }

        let rows = db.load_session_agents("s1").unwrap();
        assert_eq!(rows.len(), 3, "spawn 行保留（不丢行）");
        let by_id = |id: &str| rows.iter().find(|a| a.id == id).unwrap();
        assert_eq!(by_id("a1").status, "failed");
        assert_eq!(by_id("a2").status, "failed");
        assert_eq!(by_id("a3").status, "failed", "spawn 行同样被归一");
        assert_eq!(by_id("a1").messages[0].id, "m1", "目标行 messages 原样");
    }
}
