// SR-06d · 拆分 · ≠ EL：recovery.rs 逻辑域拆模 3/3 —— 恢复域持久化抽象
// 与错误面（原 recovery.rs 623-787 区间原样迁入，公开面经 recovery.rs
// `pub use` 重导出，语义零改动）。

use std::fmt;

use conex_db::{LocalDb, RunStatus};
// RecoveryError 本文件 :135 定义（原 recovery.rs 迁入），无需自引用导入；
// 公开面经 recovery.rs `pub use` 重导出。SR-06d 拆分注记。

/// 恢复域持久化抽象（session_meta / events 表 / run 状态 / 子代理路径）。
///
/// 实现方职责：全部经 conex-db 既有接口（get_session_meta / set_session_meta /
/// append_event / reserve_sequence / update_run_status / update_session_agent_path），
/// 不新增表结构与库方法。
pub trait RecoveryStore: Send + Sync {
    /// 读 session_meta 键（None = 键不存在）
    fn get_meta(&self, key: &str) -> Result<Option<String>, RecoveryError>;
    /// 写 session_meta 键（幂等 upsert）
    fn set_meta(&self, key: &str, value: &str) -> Result<(), RecoveryError>;
    /// events 表留痕（恢复域事件类型，如 recovery-escalated）
    fn append_event(
        &self,
        session_id: &str,
        event_type: &str,
        payload: &str,
    ) -> Result<(), RecoveryError>;
    /// 更新 run 状态（阶梯 3 原 run 置 failed）
    fn update_run_status(
        &self,
        subagent_run_id: &str,
        status: &str,
        end_reason: &str,
    ) -> Result<(), RecoveryError>;
    /// 写入子代理行的工作流路径（subagent_path_json，阶梯 3 fork 路径落库）
    fn set_subagent_path(
        &self,
        session_id: &str,
        subagent_run_id: &str,
        path_json: &str,
    ) -> Result<(), RecoveryError>;
    /// 反查子代理行的父工具调用 id（LK-02：fork 传播原行键）。
    ///
    /// 行不存在返回 None；查询失败返回 Err（调用方降级 None 不阻断
    /// fork）——键是观测增强而非 fork 前置条件。
    fn get_subagent_parent_tool_call_id(
        &self,
        session_id: &str,
        subagent_run_id: &str,
    ) -> Result<Option<String>, RecoveryError>;
}

impl RecoveryStore for LocalDb {
    fn get_meta(&self, key: &str) -> Result<Option<String>, RecoveryError> {
        self.get_session_meta(key)
            .map_err(|e| RecoveryError::PersistFailed {
                message: e.to_string(),
            })
    }

    fn set_meta(&self, key: &str, value: &str) -> Result<(), RecoveryError> {
        self.set_session_meta(key, value)
            .map_err(|e| RecoveryError::PersistFailed {
                message: e.to_string(),
            })
    }

    fn append_event(
        &self,
        session_id: &str,
        event_type: &str,
        payload: &str,
    ) -> Result<(), RecoveryError> {
        // 会话级原子取号（与事件基座同机制，保序列唯一连续）
        let sequence =
            self.reserve_sequence(session_id)
                .map_err(|e| RecoveryError::PersistFailed {
                    message: e.to_string(),
                })?;
        // DM-05：conex-db append_event 签名已加 run_id 列参数（DM-02 落地）。
        // RecoveryStore trait 签名本波不变（DM-05 派单裁决：禁改 trait，
        // 主控协调合并）——此处恒传 None，recovery-* 行的 run_id 列暂不
        // 归属（读侧经 payload subagentRunId/type 路由；列级归属待主控
        // 合并时补 run_id 参数透传）
        conex_db::LocalDb::append_event(self, session_id, sequence, event_type, payload, None)
            .map_err(|e| RecoveryError::PersistFailed {
                message: e.to_string(),
            })
    }

    fn update_run_status(
        &self,
        subagent_run_id: &str,
        status: &str,
        end_reason: &str,
    ) -> Result<(), RecoveryError> {
        let run_status = match status {
            "failed" => RunStatus::Failed,
            "completed" => RunStatus::Completed,
            "cancelled" => RunStatus::Cancelled,
            other => {
                return Err(RecoveryError::InvalidState {
                    message: format!("recovery 不支持的 run 终态：{other}"),
                });
            }
        };
        conex_db::LocalDb::update_run_status(
            self,
            subagent_run_id,
            run_status,
            Some(end_reason),
            None,
        )
        .map_err(|e| RecoveryError::PersistFailed {
            message: e.to_string(),
        })
    }

    fn set_subagent_path(
        &self,
        session_id: &str,
        subagent_run_id: &str,
        path_json: &str,
    ) -> Result<(), RecoveryError> {
        // 单行定点写（11-T3）：只更新目标行路径列，不触碰其余行与
        // messages；缺行按 affected=0 判定 NotFound（与旧 load→find→save
        // 语义一致，且不再有全量覆写竞态）
        let affected = conex_db::LocalDb::update_session_agent_path(
            self,
            session_id,
            subagent_run_id,
            path_json,
        )
        .map_err(|e| RecoveryError::PersistFailed {
            message: e.to_string(),
        })?;
        if affected == 0 {
            return Err(RecoveryError::NotFound {
                message: format!("子代理行不存在：{subagent_run_id}"),
            });
        }
        Ok(())
    }

    fn get_subagent_parent_tool_call_id(
        &self,
        session_id: &str,
        subagent_run_id: &str,
    ) -> Result<Option<String>, RecoveryError> {
        // LK-02：经 conex-db 既有接口（load_session_agents）反查原行
        // parent_tool_call_id——不新增库方法（恢复域纪律）；行缺失按
        // None 返回（观测增强，不阻断 fork）
        let agents = conex_db::LocalDb::load_session_agents(self, session_id)
            .map_err(|e| RecoveryError::PersistFailed {
                message: e.to_string(),
            })?;
        Ok(agents
            .iter()
            .find(|a| a.subagent_run_id == subagent_run_id)
            .and_then(|a| a.parent_tool_call_id.clone()))
    }
}

/// 恢复域错误
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RecoveryError {
    /// 引用的 run / 叶子不存在
    NotFound {
        /// 详情
        message: String,
    },
    /// session_meta / 事件 / run 落库失败
    PersistFailed {
        /// 详情
        message: String,
    },
    /// 非法状态或参数
    InvalidState {
        /// 详情
        message: String,
    },
    /// Episode 预算耗尽（禁止自动恢复，直接阶梯 4）
    BudgetExceeded {
        /// 操作指纹
        fingerprint: String,
        /// 已消费恢复次数
        count: u32,
        /// 预算上限
        max: u32,
    },
}

impl fmt::Display for RecoveryError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::NotFound { message } => write!(f, "恢复目标不存在：{message}"),
            Self::PersistFailed { message } => write!(f, "恢复域持久化失败：{message}"),
            Self::InvalidState { message } => write!(f, "恢复域状态非法：{message}"),
            Self::BudgetExceeded {
                fingerprint,
                count,
                max,
            } => write!(
                f,
                "恢复预算耗尽（指纹 {fingerprint}，已 {count} 次 / 上限 {max}）"
            ),
        }
    }
}

impl std::error::Error for RecoveryError {}
