//! 协作子代理域：session_agents 表（含 session_agent_messages）的全量保存 /
//! 加载，以及 localStorage 导入用的宽容解析助手。

use super::{DbFailure, DbFailureKind, LocalDb};
use conex_types::{SessionAgent, SessionMessage};

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
                        started_at, ended_at, depth, subagent_path_json
                 FROM session_agents
                 WHERE session_id = ?1
                 ORDER BY started_at ASC, agent_id ASC",
            )
            .map_err(|e| self.latch_error("load_session_agents_prepare", e))?;

        let agent_rows: Vec<SessionAgent> = agent_stmt
            .query_map(rusqlite::params![session_id], |row| {
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
                    messages: Vec::new(),
                })
            })
            .map_err(|e| self.latch_error("load_session_agents_map", e))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| self.latch_error("load_session_agents_collect", e))?;

        // 为每个 agent 单独查询消息
        let mut msg_stmt = conn
            .prepare(
                "SELECT id, sender, text, thinking, timestamp, status,
                        stream_text_offset, thinking_time, tool_calls_json,
                        blocks_json, tool_call_results_json
                 FROM session_agent_messages
                 WHERE session_id = ?1 AND agent_id = ?2
                 ORDER BY seq ASC",
            )
            .map_err(|e| self.latch_error("load_session_agents_msg_prepare", e))?;

        let mut agents = agent_rows;
        for agent in &mut agents {
            let messages = msg_stmt
                .query_map(rusqlite::params![session_id, agent.id], |row| {
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
                    })
                })
                .map_err(|e| self.latch_error("load_session_agents_msg_map", e))?
                .collect::<Result<Vec<_>, _>>()
                .map_err(|e| self.latch_error("load_session_agents_msg_collect", e))?;
            agent.messages = messages;
        }

        Ok(agents)
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
                    started_at, ended_at, depth, subagent_path_json
                ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)",
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
