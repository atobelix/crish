//! 协作子代理域：session_agents 表（含 session_agent_messages）的读与全量快照写。
//!
//! 写面约定（11-T3 单行定点写收束）：
//! - **全量保存 [Self::save_session_agents] 仅快照面**（session_commands.rs:238-247
//!   前端显式保存 / 导入 + 测试面）；先删后插会触发 session_agent_messages
//!   FK 级联清空，且与引擎并发写构成「后写者覆盖先写者新增行」竞态；
//! - **单行定点写与状态流转操作抽取至 [crate::agents_ops]**：[Self::upsert_session_agent]、
//!   [Self::update_session_agent_status]、[Self::update_session_agent_path]。

use super::{DbFailure, DbFailureKind, LocalDb};
use conex_types::{SessionAgent, SessionMessage};

/// session_agents 行 → SessionAgent 映射（全量加载与查询扩展共用，
/// 唯一真源，防两份查询口径漂移）
pub(crate) fn map_agent_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<SessionAgent> {
    // sub_session_id（v9 列；SELECT 自 agent_id 起 17 列，本列 = 位置索引 16；
    // 列定义 NOT NULL DEFAULT ''，空串归一为 None——与「无子会话映射」同义）
    let sub_session_id: Option<String> = row.get(16)?;
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
        sub_session_id: sub_session_id.filter(|s| !s.is_empty()),
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
                        task_type, display_label, allowed_write_paths_json,
                        sub_session_id
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
                        task_type, display_label, allowed_write_paths_json,
                        sub_session_id
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
    pub(crate) fn load_agent_messages(
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
                    task_type, display_label, allowed_write_paths_json,
                    sub_session_id
                ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18)",
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
                    agent.sub_session_id.clone().unwrap_or_default(),
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
    use super::*;
    use conex_types::SessionIndexEntry;

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
            sub_session_id: None,
        }
    }

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

    /// P18（AA-07）契约固化：Rust 侧 save_session_agents 无数量上限——
    /// 前端 SQLite 主路径全量保存（截断只发生在 LS 配额保护线），第 41 个
    /// 起的子代理及其消息不丢。防未来把前端 SESSION_AGENTS_SAVE_CAP 下沉
    /// 到 Rust 造成静默截断回归。
    #[test]
    fn save_session_agents_does_not_truncate_over_cap() {
        let db = LocalDb::open_in_memory().unwrap();
        db.upsert_session_entry(&session_entry("s1")).unwrap();

        // 45 条 > 前端软上限 40：Rust 侧应全量保存
        let agents: Vec<SessionAgent> = (0..45)
            .map(|i| {
                agent(
                    &format!("a{i}"),
                    &format!("run-{i}"),
                    "completed",
                    "s1",
                    Some(100 + i as i64),
                    None,
                    vec![msg(&format!("m{i}"), "user", i)],
                )
            })
            .collect();
        db.save_session_agents("s1", &agents).unwrap();

        let rows = db.load_session_agents("s1").unwrap();
        assert_eq!(rows.len(), 45, "第 41 个起的子代理不截断（全量保存）");
        let by_id = |id: &str| rows.iter().find(|a| a.id == id).unwrap();
        assert_eq!(by_id("a44").messages.len(), 1, "末位子代理消息不丢");
        assert_eq!(by_id("a44").messages[0].id, "m44");
        assert_eq!(by_id("a0").messages[0].id, "m0");
        assert_eq!(by_id("a40").messages[0].id, "m40", "第 41 个起的子代理消息随行");
    }
}
