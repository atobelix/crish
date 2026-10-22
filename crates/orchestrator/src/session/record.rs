use std::fmt;

use conex_types::context::SessionContextMeta;
use serde::{Deserialize, Serialize};

use super::time::parse_iso8601_epoch_ms;

/// session-leaf-moved 事件类型名（叶子移动的持久化事件，05 §2.8
/// orchestrator.test.ts:813；载荷为 [session_leaf_moved_payload]）
pub const SESSION_LEAF_MOVED_EVENT: &str = "session-leaf-moved";

/// 会话树条目类型（对齐 session-tree.ts 的 node / branch_summary）
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum SessionTreeEntryKind {
    /// 会话节点（一次 append / fork 产生）
    Node {
        /// 节点载荷（消息摘要 / 边界标记等，由上层定义形状）
        payload: serde_json::Value,
    },
    /// 分支摘要（abandon_branch_with_summary 产生，被放弃分支的收口标记）
    BranchSummary {
        /// 摘要文案
        summary: String,
        /// 被放弃的叶子 id（无则为 None）
        #[serde(default, skip_serializing_if = "Option::is_none")]
        abandoned_leaf_id: Option<String>,
        /// 摘要附加详情（放弃原因等）
        #[serde(default, skip_serializing_if = "Option::is_none")]
        details: Option<serde_json::Value>,
    },
}

/// 会话树条目（对齐 session-tree.ts 的 SessionTreeEntry）
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionTreeEntry {
    /// 条目 id（会话内唯一）
    pub id: String,
    /// 父条目 id（None = 根节点）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parent_id: Option<String>,
    /// 创建时间（epoch ms）
    pub created_at: i64,
    /// 条目类型与载荷
    pub kind: SessionTreeEntryKind,
}

impl SessionTreeEntry {
    /// 构造节点条目
    pub fn node(
        id: impl Into<String>,
        parent_id: Option<String>,
        payload: serde_json::Value,
    ) -> Self {
        Self {
            id: id.into(),
            parent_id,
            created_at: crate::now_ms(),
            kind: SessionTreeEntryKind::Node { payload },
        }
    }

    /// 条目 id
    pub fn id(&self) -> &str {
        &self.id
    }
}

/// 会话树错误（对齐 session-tree.test.ts 的校验语义：
/// not_found / invalid_state / invalid_entry）
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SessionTreeError {
    /// 引用了不存在的条目（session.not_found）
    NotFound {
        /// 缺失的条目 id
        id: String,
    },
    /// 结构非法（父先于子顺序、环等，session.invalid_state）
    InvalidState {
        /// 非法原因
        message: String,
    },
    /// 条目 id 重复（session.invalid_entry）
    DuplicateId {
        /// 重复的条目 id
        id: String,
    },
    /// 叶子移动的期望当前叶子校验失败（乐观并发控制）
    ExpectedLeafMismatch {
        /// 期望的当前叶子 id
        expected: String,
        /// 实际的当前叶子 id（None = 无叶子）
        actual: Option<String>,
    },
    /// 分支路径环检测（防御性）
    Cycle {
        /// 环上的条目 id
        id: String,
    },
}

impl fmt::Display for SessionTreeError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::NotFound { id } => write!(f, "会话树条目不存在: {id}"),
            Self::InvalidState { message } => write!(f, "会话树结构非法: {message}"),
            Self::DuplicateId { id } => write!(f, "会话树条目 id 重复: {id}"),
            Self::ExpectedLeafMismatch { expected, actual } => {
                write!(
                    f,
                    "叶子移动期望校验失败：期望当前叶子 {expected}，实际 {actual:?}"
                )
            }
            Self::Cycle { id } => write!(f, "会话树分支路径存在环: {id}"),
        }
    }
}

impl std::error::Error for SessionTreeError {}

/// 会话记录（会话树序列化形状，供快照 / 重启恢复用）
///
/// 字段对齐任务书：session_id / 当前叶子 id / 分支列表（分支列表为全部
/// 分支历史条目，含节点与分支摘要）。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionRecord {
    /// 会话标识
    pub session_id: String,
    /// 当前叶子 id（None = 根前位置，尚未追加任何节点）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub current_leaf_id: Option<String>,
    /// 分支列表（全部分支历史条目，父先于子的插入序）
    pub branches: Vec<SessionTreeEntry>,
    /// 会话上下文元数据（P4 阶段 5-1 / §3.7）：压缩护栏状态
    /// （last_compaction_at / last_compaction_sequence /
    /// last_compaction_generation / compression_retries）随会话记录持久化；
    /// restore 时随 [crate::restore::RestoreOutcome::sessions] 返回，
    /// 供壳层重建 SessionHistoryCache 的护栏状态（跨重启不丢）。
    /// 旧快照无该字段（serde default → None = 无压缩边界，护栏从零开始）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub context_meta: Option<SessionContextMeta>,
}

/// 会话上下文压缩护栏更新事件类型（context-compression-end，落库事件流
/// 的 type；restore 重放重建护栏用，与 session-leaf-moved 的既有恢复机制
/// 同构，P4 阶段 5-1）
pub const CONTEXT_COMPRESSION_END_EVENT: &str = "context-compression-end";

impl SessionRecord {
    /// 应用 session-leaf-moved 事件的载荷（持久化叶子移动的重放；
    /// 05 §2.8 orchestrator.test.ts:813 语义）。
    ///
    /// 注意：持久化事件可引用运行时叶子（不要求存在于分支列表内，
    /// 与 orchestrator.moveSessionLeaf 一致），故不做存在性校验。
    pub fn apply_leaf_move_event(&mut self, payload: &str) -> Result<(), SessionTreeError> {
        let value: serde_json::Value =
            serde_json::from_str(payload).map_err(|e| SessionTreeError::InvalidState {
                message: format!("叶子移动事件载荷解析失败: {e}"),
            })?;
        let to_leaf_id = value
            .get("toLeafId")
            .and_then(serde_json::Value::as_str)
            .ok_or_else(|| SessionTreeError::InvalidState {
                message: "叶子移动事件载荷缺少 toLeafId".to_string(),
            })?;
        self.current_leaf_id = Some(to_leaf_id.to_string());
        Ok(())
    }

    /// 会话上下文元数据（None = 尚无压缩护栏状态，护栏从零开始）
    pub fn context_meta(&self) -> Option<&SessionContextMeta> {
        self.context_meta.as_ref()
    }

    /// 写入会话上下文元数据（压缩事件写点 / 恢复重建护栏状态用）
    pub fn set_context_meta(&mut self, meta: SessionContextMeta) {
        self.context_meta = Some(meta);
    }

    /// 压缩结束事件折叠（P4 阶段 5-1 写点）：压缩事件落库时更新护栏——
    /// `last_compaction_at` = 事件时间戳（epoch ms，时间戳护栏边界）、
    /// `last_compaction_sequence` = 事件序列（审计锚点）、
    /// `last_compaction_generation` +1（C13：压缩重置 P5 审计基线）、
    /// `compression_retries` 归零（溢出压缩已消费，fresh 起点）。
    ///
    /// R-K（00-plan §3）：`last_compaction_generation` 为**会话级代数唯一源**
    /// ——重放 N 个压缩事件最终值 = N，与块行写入面的事件计数取数
    /// （blocks.rs `count_compression_events`，含本次）严格一致（同一事实源：
    /// events 表），代数不漂移。cache_tracker 消费面在轮次 3/4（T-30/T-31）
    /// 接线，本域不自增第二套代数。
    ///
    /// 返回是否成功更新（事件时间戳不可解析时返回 false，不破坏既有状态；
    /// 不变量：非法输入绝不把护栏写坏）。
    pub fn apply_compression_end(&mut self, sequence: u64, timestamp_iso: &str) -> bool {
        let Some(boundary_ms) = parse_iso8601_epoch_ms(timestamp_iso) else {
            return false;
        };
        let meta = self
            .context_meta
            .get_or_insert_with(SessionContextMeta::default);
        meta.last_compaction_at = Some(boundary_ms);
        meta.last_compaction_sequence = Some(sequence);
        meta.last_compaction_generation = Some(meta.last_compaction_generation.unwrap_or(0) + 1);
        meta.compression_retries = 0;
        true
    }
}

/// session-leaf-moved 事件载荷（叶子移动持久化，05 §2.8:813）
pub fn session_leaf_moved_payload(to_leaf_id: &str) -> String {
    serde_json::json!({ "toLeafId": to_leaf_id }).to_string()
}
