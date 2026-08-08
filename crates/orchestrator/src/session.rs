//! 会话树与 conversation-rewind 计划（任务书 B4.3）
//!
//! - [SessionTree]：会话树——追加（append 新分支）、分叉（fork：从某节点
//!   派生新叶子）、叶子移动（move_leaf：当前叶子指针迁移，含
//!   expected_current_leaf 乐观校验）、分支放弃摘要（abandon_branch_
//!   with_summary），并对齐 packages/agent-orchestrator/src/session-tree.ts
//!   的校验语义（重复 id / 父先于子 / 环检测防御）；
//! - [SessionRecord]：会话记录（session_id / 当前叶子 id / 分支列表），
//!   供快照与重启恢复使用；
//! - conversation-rewind 计划（05 §5.4 rewind::plan，
//!   conversation-rewind.test.ts:14 语义）：按「取消 run → 清审批 →
//!   恢复检查点 → 移动叶子」的顺序产出 [RewindPlan]，并提供
//!   [execute_rewind] 执行骨架（审批清理由上层配合，见 [RewindExecutor]）。
//!
//! 语义来源：05-test-mapping.md §5.4 session::tree / rewind::plan、
//! §2.8 orchestrator.test.ts:813（叶子移动经 session-leaf-moved 事件
//! 持久化）。

use std::collections::HashSet;
use std::fmt;

use conex_db::RunStatus;
use conex_types::checkpoint::{
    CHECKPOINT_PAYLOAD_KEY, CheckpointPayload, LeafCheckpointState,
};
use conex_types::context::SessionContextMeta;
use serde::{Deserialize, Serialize};

use crate::run::RunStateMachine;

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
    pub fn node(id: impl Into<String>, parent_id: Option<String>, payload: serde_json::Value) -> Self {
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
                write!(f, "叶子移动期望校验失败：期望当前叶子 {expected}，实际 {actual:?}")
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
        let value: serde_json::Value = serde_json::from_str(payload).map_err(|e| {
            SessionTreeError::InvalidState {
                message: format!("叶子移动事件载荷解析失败: {e}"),
            }
        })?;
        let to_leaf_id = value.get("toLeafId").and_then(serde_json::Value::as_str).ok_or_else(|| {
            SessionTreeError::InvalidState {
                message: "叶子移动事件载荷缺少 toLeafId".to_string(),
            }
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
        let meta = self.context_meta.get_or_insert_with(SessionContextMeta::default);
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

/// ISO8601 时间戳 → epoch 毫秒（无 chrono 依赖的手工解析；与 session-loop
/// `now_iso_utc` 产出形态对齐：`YYYY-MM-DDTHH:MM:SS[.mmm]Z`，仅接受 UTC）。
///
/// 供压缩事件时间戳（epoch ms 语义，与 session-loop 时间戳护栏 `unix_millis`
/// 同精度）与 [SessionRecord::apply_compression_end] 使用；解析失败返回
/// None（调用方保持既有护栏状态，绝不写坏）。
pub(crate) fn parse_iso8601_epoch_ms(value: &str) -> Option<i64> {
    let bytes = value.as_bytes();
    if bytes.len() < 20 {
        return None;
    }
    if bytes[4] != b'-' || bytes[7] != b'-' || bytes[10] != b'T' {
        return None;
    }
    if bytes[13] != b':' || bytes[16] != b':' {
        return None;
    }
    let num = |start: usize, len: usize| -> Option<i64> {
        value.get(start..start + len)?.parse().ok()
    };
    let year = num(0, 4)?;
    let month = num(5, 2)?;
    let day = num(8, 2)?;
    let hour = num(11, 2)?;
    let minute = num(14, 2)?;
    let second = num(17, 2)?;
    // 小数秒（可选；now_iso_utc 恒 3 位）
    let mut millis = 0i64;
    let mut idx = 19;
    if idx < bytes.len() && bytes[idx] == b'.' {
        idx += 1;
        let start = idx;
        while idx < bytes.len() && bytes[idx].is_ascii_digit() {
            idx += 1;
        }
        if idx == start {
            return None;
        }
        let fraction = &value[start..idx];
        // 不足 3 位补零、超 3 位截断（毫秒精度）
        let mut padded = String::with_capacity(3);
        padded.push_str(fraction);
        while padded.len() < 3 {
            padded.push('0');
        }
        padded.truncate(3);
        millis = padded.parse().ok()?;
    }
    if idx >= bytes.len() || bytes[idx] != b'Z' {
        return None;
    }
    // 基本范围校验（护栏判定用；不做逐月天数精确校验）
    if !(1..=12).contains(&month) || !(1..=31).contains(&day) {
        return None;
    }
    if hour > 23 || minute > 59 || second > 60 {
        return None;
    }
    let days = days_from_civil(year, month as u32, day as u32)?;
    Some(
        (days * 86_400 + hour * 3_600 + minute * 60 + second) * 1_000 + millis,
    )
}

/// 公历日期 → 1970-01-01 起天数（Howard Hinnant civil-from-days 逆运算，
/// 与 session-loop 同源算法）
fn days_from_civil(year: i64, month: u32, day: u32) -> Option<i64> {
    if month == 0 || day == 0 {
        return None;
    }
    let year = if month <= 2 { year - 1 } else { year };
    let era = (if year >= 0 { year } else { year - 399 }) / 400;
    let year_of_era = year - era * 400;
    let day_of_year: i64 =
        (153 * i64::from(if month > 2 { month - 3 } else { month + 9 }) + 2) / 5
            + i64::from(day)
            - 1;
    let day_of_era = year_of_era * 365 + year_of_era / 4 - year_of_era / 100 + day_of_year;
    Some(era * 146_097 + day_of_era - 719_468)
}

/// 会话树（追加 / 分叉 / 叶子移动 / 分支放弃摘要）
///
/// 结构对齐 packages/agent-orchestrator/src/session-tree.ts：
/// - entries 保持插入序（父必须先于子出现）；
/// - current_leaf_id 为当前活动叶子指针（append 自动推进）；
/// - last_inserted_id 供「无显式当前叶子时恢复到最后插入条目」使用。
///
/// 与 TS 的分歧说明：条目 id 由调用方显式提供（TS 自动生成随机 id），
/// 以便上层生成幂等 id 并与持久化事件对齐。
#[derive(Debug, Clone, PartialEq)]
pub struct SessionTree {
    /// 会话标识
    session_id: String,
    /// 分支历史条目（插入序）
    entries: Vec<SessionTreeEntry>,
    /// 当前活动叶子指针
    current_leaf_id: Option<String>,
    /// 最后插入的条目 id
    last_inserted_id: Option<String>,
}

impl SessionTree {
    /// 新建空会话树
    pub fn new(session_id: impl Into<String>) -> Self {
        Self {
            session_id: session_id.into(),
            entries: Vec::new(),
            current_leaf_id: None,
            last_inserted_id: None,
        }
    }

    /// 会话标识
    pub fn session_id(&self) -> &str {
        &self.session_id
    }

    /// 当前叶子 id（None = 根前位置）
    pub fn current_leaf_id(&self) -> Option<&str> {
        self.current_leaf_id.as_deref()
    }

    /// 全部分支历史条目（插入序，父先于子）
    pub fn entries(&self) -> &[SessionTreeEntry] {
        &self.entries
    }

    /// 按 id 查条目
    pub fn entry(&self, id: &str) -> Option<&SessionTreeEntry> {
        self.entries.iter().find(|e| e.id == id)
    }

    /// 追加新分支：新节点挂在当前叶子下，当前叶子指针推进到新节点
    /// （session-tree.test.ts:7 语义）
    pub fn append(&mut self, id: impl Into<String>, payload: serde_json::Value) -> Result<SessionTreeEntry, SessionTreeError> {
        let entry = self.create_node(id, self.current_leaf_id.clone(), payload)?;
        self.push_entry(entry.clone());
        Ok(entry)
    }

    /// 分叉：从指定节点派生新叶子（parent = from_leaf_id），当前叶子
    /// 指针推进到新叶子；原分支路径不被改写（session-tree.test.ts:19 语义）
    pub fn fork(&mut self, from_leaf_id: &str, id: impl Into<String>, payload: serde_json::Value) -> Result<SessionTreeEntry, SessionTreeError> {
        if !self.entries.iter().any(|e| e.id == from_leaf_id) {
            return Err(SessionTreeError::NotFound {
                id: from_leaf_id.to_string(),
            });
        }
        let entry = self.create_node(id, Some(from_leaf_id.to_string()), payload)?;
        self.push_entry(entry.clone());
        Ok(entry)
    }

    /// 叶子移动：当前叶子指针迁移到 target_leaf_id（None = 根前位置），
    /// 不新增条目（session-tree.test.ts:33 语义）。
    ///
    /// expected_current_leaf 为乐观并发校验：Some(期望值) 时若当前叶子
    /// 与期望不一致则失败（rewind 移动叶子步骤使用，防止并发分支改写）。
    pub fn move_leaf(
        &mut self,
        target_leaf_id: Option<&str>,
        expected_current_leaf: Option<&str>,
    ) -> Result<(), SessionTreeError> {
        if let Some(expected) = expected_current_leaf {
            if self.current_leaf_id.as_deref() != Some(expected) {
                return Err(SessionTreeError::ExpectedLeafMismatch {
                    expected: expected.to_string(),
                    actual: self.current_leaf_id.clone(),
                });
            }
        }
        if let Some(target) = target_leaf_id {
            if !self.entries.iter().any(|e| e.id == target) {
                return Err(SessionTreeError::NotFound {
                    id: target.to_string(),
                });
            }
        }
        self.current_leaf_id = target_leaf_id.map(str::to_string);
        Ok(())
    }

    /// 放弃当前分支：在 target 下挂一个分支摘要条目，当前叶子推进到
    /// 摘要条目（对齐 session-tree.test.ts:47 的回滚语义）
    pub fn abandon_branch_with_summary(
        &mut self,
        target_leaf_id: Option<&str>,
        id: impl Into<String>,
        summary: impl Into<String>,
        details: Option<serde_json::Value>,
    ) -> Result<SessionTreeEntry, SessionTreeError> {
        let target = target_leaf_id.map(str::to_string);
        if let Some(t) = &target {
            if !self.entries.iter().any(|e| e.id == *t) {
                return Err(SessionTreeError::NotFound { id: t.clone() });
            }
        }
        let id = id.into();
        if self.entries.iter().any(|e| e.id == id) {
            return Err(SessionTreeError::DuplicateId { id });
        }
        let entry = SessionTreeEntry {
            id,
            parent_id: target,
            created_at: crate::now_ms(),
            kind: SessionTreeEntryKind::BranchSummary {
                summary: summary.into(),
                abandoned_leaf_id: self.current_leaf_id.clone(),
                details,
            },
        };
        self.push_entry(entry.clone());
        Ok(entry)
    }

    /// 恢复当前叶子：source 为 None 时恢复到最后插入的条目（与 TS
    /// restoreLeaf(undefined) 语义一致）；显式叶子则校验存在性
    /// （session-tree.test.ts:86 / :110 语义）
    pub fn restore_leaf(&mut self, source: Option<&str>) -> Result<(), SessionTreeError> {
        let requested = match source {
            Some(id) => Some(id.to_string()),
            None => self.last_inserted_id.clone(),
        };
        if let Some(id) = &requested {
            if !self.entries.iter().any(|e| e.id == *id) {
                return Err(SessionTreeError::NotFound { id: id.clone() });
            }
        }
        self.current_leaf_id = requested;
        Ok(())
    }

    /// 读取从根到指定叶子的分支路径（None = 空路径；环检测防御，
    /// session-tree.test.ts:156 语义）
    pub fn read_branch_path(&self, leaf_id: Option<&str>) -> Result<Vec<SessionTreeEntry>, SessionTreeError> {
        let leaf_id = match leaf_id {
            Some(id) => id,
            None => return Ok(Vec::new()),
        };
        let mut path = Vec::new();
        let mut seen = HashSet::new();
        let mut current = self.entry(leaf_id).ok_or_else(|| SessionTreeError::NotFound {
            id: leaf_id.to_string(),
        })?;
        loop {
            if !seen.insert(current.id.clone()) {
                return Err(SessionTreeError::Cycle { id: current.id.clone() });
            }
            path.push(current.clone());
            current = match &current.parent_id {
                Some(parent) => match self.entry(parent) {
                    Some(entry) => entry,
                    None => {
                        return Err(SessionTreeError::InvalidState {
                            message: format!("条目 {} 的父节点 {} 缺失", current.id, parent),
                        });
                    }
                },
                None => break,
            };
        }
        path.reverse();
        Ok(path)
    }

    // ===== C1 checkpoint 叶子 payload（M5A 最小落库面） =====
    //
    // 会话树主写权归 C6（M6）；本面只读写叶子节点 payload 的
    // `checkpoint` 保留键（[CHECKPOINT_PAYLOAD_KEY]），不触碰 payload
    // 其它字段与树结构。采集端（session-loop safe_point.rs）产出
    // [CheckpointPayload]，经 [Self::set_leaf_checkpoint] 落库，
    // 恢复端（M5B）经 [Self::read_leaf_checkpoint] 判定优先恢复。

    /// 读取叶子 payload 中的检查点（C1 / M5A 最小读面）。
    ///
    /// 三态语义（fail-open，不 panic）：
    /// - leaf_id 为 None 时取当前叶子；条目不存在 / 非节点 / 无
    ///   `checkpoint` 键 / 值为 null → [LeafCheckpointState::Absent]
    ///   （无检查点，保持现状）；
    /// - 值存在且解析成功 → [LeafCheckpointState::Present]（恢复时
    ///   优先消费）；
    /// - 值存在但解析失败 → [LeafCheckpointState::Corrupt]（损坏降级
    ///   普通会话，message 供「检查点失效」通知）。
    pub fn read_leaf_checkpoint(&self, leaf_id: Option<&str>) -> LeafCheckpointState {
        let entry = match leaf_id {
            Some(id) => self.entry(id),
            None => self
                .current_leaf_id
                .as_deref()
                .and_then(|id| self.entry(id)),
        };
        let Some(entry) = entry else {
            return LeafCheckpointState::Absent;
        };
        let SessionTreeEntryKind::Node { payload } = &entry.kind else {
            return LeafCheckpointState::Absent;
        };
        let Some(value) = payload.get(CHECKPOINT_PAYLOAD_KEY) else {
            return LeafCheckpointState::Absent;
        };
        if value.is_null() {
            return LeafCheckpointState::Absent;
        }
        match serde_json::from_value::<CheckpointPayload>(value.clone()) {
            Ok(checkpoint) => LeafCheckpointState::Present(checkpoint),
            Err(err) => LeafCheckpointState::Corrupt(format!("检查点载荷解析失败: {err}")),
        }
    }

    /// 写入叶子 payload 的检查点字段（C1 / M5A 最小写面）。
    ///
    /// 只新增/更新 `checkpoint` 键，payload 其它字段原样保留（最小
    /// 落库面：checkpoint payload 字段）。条目不存在 → NotFound；
    /// 条目非节点或 payload 非 JSON 对象 → InvalidState。
    pub fn set_leaf_checkpoint(
        &mut self,
        leaf_id: &str,
        checkpoint: &CheckpointPayload,
    ) -> Result<(), SessionTreeError> {
        let entry = self
            .entries
            .iter_mut()
            .find(|entry| entry.id == leaf_id)
            .ok_or_else(|| SessionTreeError::NotFound {
                id: leaf_id.to_string(),
            })?;
        let SessionTreeEntryKind::Node { payload } = &mut entry.kind else {
            return Err(SessionTreeError::InvalidState {
                message: format!("条目 {leaf_id} 不是会话节点，不能写入检查点"),
            });
        };
        let object = payload.as_object_mut().ok_or_else(|| {
            SessionTreeError::InvalidState {
                message: format!("条目 {leaf_id} 的 payload 不是 JSON 对象，不能写入检查点"),
            }
        })?;
        let value = serde_json::to_value(checkpoint).map_err(|err| {
            SessionTreeError::InvalidState {
                message: format!("检查点序列化失败: {err}"),
            }
        })?;
        object.insert(CHECKPOINT_PAYLOAD_KEY.to_string(), value);
        Ok(())
    }

    /// 序列化为会话记录（快照 / 重启恢复用）
    pub fn to_session_record(&self) -> SessionRecord {
        SessionRecord {
            session_id: self.session_id.clone(),
            current_leaf_id: self.current_leaf_id.clone(),
            branches: self.entries.clone(),
            // 会话树本身不持有上下文元数据（压缩护栏由事件流/快照携带，
            // 恢复后经 SessionRecord.context_meta 重建）
            context_meta: None,
        }
    }

    /// 从会话记录还原会话树（含结构校验，见 [Self::from_entries]）
    pub fn from_session_record(record: SessionRecord) -> Result<Self, SessionTreeError> {
        Self::from_entries(record.session_id, record.branches, record.current_leaf_id)
    }

    /// 从条目列表 + 当前叶子构造会话树（重启恢复 / 快照还原路径）
    ///
    /// 结构校验对齐 session-tree.test.ts:121-227：
    /// - 重复 id → DuplicateId；
    /// - 父必须先于子出现 → InvalidState；
    /// - 分支摘要的 abandoned_leaf_id（非空时）必须已出现 → NotFound。
    pub fn from_entries(
        session_id: String,
        entries: Vec<SessionTreeEntry>,
        current_leaf_id: Option<String>,
    ) -> Result<Self, SessionTreeError> {
        // 两阶段校验（与 TS loadEntries 一致：容量淘汰与结构校验解耦）
        let mut seen = HashSet::new();
        for entry in &entries {
            if !seen.insert(entry.id.clone()) {
                return Err(SessionTreeError::DuplicateId { id: entry.id.clone() });
            }
            if let Some(parent) = &entry.parent_id {
                if !seen.contains(parent) {
                    return Err(SessionTreeError::InvalidState {
                        message: format!("条目 {} 的父节点 {} 必须先于子条目出现", entry.id, parent),
                    });
                }
            }
            if let SessionTreeEntryKind::BranchSummary {
                abandoned_leaf_id: Some(abandoned),
                ..
            } = &entry.kind
            {
                if !seen.contains(abandoned) {
                    return Err(SessionTreeError::NotFound { id: abandoned.clone() });
                }
            }
        }
        let last_inserted_id = entries.last().map(|e| e.id.clone());
        let mut tree = Self {
            session_id,
            entries,
            current_leaf_id: None,
            last_inserted_id,
        };
        tree.restore_leaf(current_leaf_id.as_deref())?;
        Ok(tree)
    }

    /// 构造节点条目（id 唯一性校验 + 父节点存在性由调用方保证）
    fn create_node(
        &mut self,
        id: impl Into<String>,
        parent_id: Option<String>,
        payload: serde_json::Value,
    ) -> Result<SessionTreeEntry, SessionTreeError> {
        let id = id.into();
        if self.entries.iter().any(|e| e.id == id) {
            return Err(SessionTreeError::DuplicateId { id });
        }
        Ok(SessionTreeEntry::node(id, parent_id, payload))
    }

    /// 追加条目并推进 last_inserted / current_leaf（appendEntry 语义）
    fn push_entry(&mut self, entry: SessionTreeEntry) {
        self.last_inserted_id = Some(entry.id.clone());
        self.current_leaf_id = Some(entry.id.clone());
        self.entries.push(entry);
    }
}

// ===== conversation-rewind 计划（05 §5.4 rewind::plan） =====

/// conversation-rewind 取消 / 清审批 reason（conversation-rewind.test.ts:17 语义）
pub const REWIND_CANCEL_REASON: &str = "conversation-rewind";

/// 被取消 run 的角色（conversation-rewind.ts ConversationRewindRunCancellation）
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RewindRunRole {
    /// 会话主 run
    SessionRun,
    /// 子 agent run
    SubagentRun,
}

/// 需取消的 run
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RewindRunCancellation {
    /// run id
    pub run_id: String,
    /// 角色（会话 run / 子 agent run）
    pub role: RewindRunRole,
}

/// 需清除的挂起审批（取消 run 后由上层配合发出 approval-resolved）
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RewindApprovalClearance {
    /// 审批对应的工具调用 id
    pub tool_call_id: String,
    /// 审批所属 run id
    pub run_id: String,
}

/// 工作区恢复来源
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RewindCheckpointSource {
    /// 无需恢复
    None,
    /// 运行时清单检查点
    RuntimeManifest,
    /// git 检查点
    GitCheckpoint,
}

/// 工作区恢复计划（conversation-rewind.ts ConversationRewindWorkspaceRestore）
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RewindWorkspaceRestore {
    /// 是否必须恢复
    pub required: bool,
    /// 恢复来源（None = 不恢复）
    pub source: RewindCheckpointSource,
    /// 运行时检查点 id（RuntimeManifest）
    pub checkpoint_id: Option<String>,
    /// 清单路径（RuntimeManifest）
    pub manifest_path: Option<String>,
    /// git 检查点引用（GitCheckpoint）
    pub checkpoint: Option<String>,
    /// 是否清理未跟踪文件（GitCheckpoint）
    pub clean_untracked: bool,
}

/// rewind 执行步骤（顺序：取消 run → 清审批 → 恢复检查点 → 移动叶子）
#[derive(Debug, Clone, PartialEq)]
pub enum RewindStep {
    /// 取消非终态 run
    CancelRuns(Vec<RewindRunCancellation>),
    /// 清除已取消 run 的挂起审批
    ClearApprovals(Vec<RewindApprovalClearance>),
    /// 恢复工作区检查点
    RestoreWorkspace(RewindWorkspaceRestore),
    /// 移动会话叶子到目标（持久化 session-leaf-moved 事件）
    MoveSessionLeaf {
        /// 会话 id
        session_id: String,
        /// 原叶子 id
        from_leaf_id: Option<String>,
        /// 目标叶子 id
        to_leaf_id: Option<String>,
    },
}

impl RewindStep {
    /// 步骤类型名（测试断言用）
    pub fn type_name(&self) -> &'static str {
        match self {
            Self::CancelRuns(_) => "cancel-runs",
            Self::ClearApprovals(_) => "clear-approvals",
            Self::RestoreWorkspace(_) => "restore-workspace",
            Self::MoveSessionLeaf { .. } => "move-session-leaf",
        }
    }
}

/// conversation-rewind 计划（conversation-rewind.ts ConversationRewindPlan）
#[derive(Debug, Clone, PartialEq)]
pub struct RewindPlan {
    /// 会话 id
    pub session_id: String,
    /// 当前（原）叶子 id
    pub from_leaf_id: Option<String>,
    /// 目标叶子 id
    pub target_leaf_id: Option<String>,
    /// 目标分支路径（根 → 目标叶子；目标为 None 时为空）
    pub target_path: Vec<SessionTreeEntry>,
    /// 按「取消 run → 清审批 → 恢复检查点 → 移动叶子」排序的执行步骤
    pub steps: Vec<RewindStep>,
}

/// 计划输入的 run 信息（供非终态判定）
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RewindRunInfo {
    /// run id
    pub run_id: String,
    /// 会话 id
    pub session_id: String,
    /// 当前状态
    pub status: RunStatus,
}

/// 计划输入的活动子 agent
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RewindActiveSubagent {
    /// 子 agent run id
    pub subagent_run_id: String,
    /// 父 run id
    pub parent_run_id: String,
}

/// 计划输入的挂起审批
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RewindPendingApproval {
    /// 工具调用 id
    pub tool_call_id: String,
    /// 所属 run id
    pub run_id: String,
}

/// 检查点目标（conversation-rewind.ts ConversationRewindCheckpointTarget）
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RewindCheckpointTarget {
    /// 运行时清单检查点
    RuntimeManifest {
        /// 检查点 id
        checkpoint_id: String,
        /// 清单路径
        manifest_path: Option<String>,
    },
    /// git 检查点
    GitCheckpoint {
        /// git 引用
        checkpoint: String,
        /// 是否清理未跟踪文件
        clean_untracked: bool,
    },
}

/// 工作区恢复策略（conversation-rewind.ts ConversationRewindRestorePolicy）
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RewindRestorePolicy {
    /// 有检查点就恢复，没有则跳过
    IfPresent,
    /// 必须有检查点（缺失时报错）
    Required,
    /// 跳过工作区恢复（纯树回退）
    Skip,
}

/// rewind 计划 / 执行错误
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RewindError {
    /// 错误类别（如 store.write_failed，对齐 R6 迁移码）
    pub kind: String,
    /// 错误详情
    pub message: String,
}

impl RewindError {
    /// 构造错误
    pub fn new(kind: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            kind: kind.into(),
            message: message.into(),
        }
    }
}

impl fmt::Display for RewindError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}: {}", self.kind, self.message)
    }
}

impl std::error::Error for RewindError {}

impl From<SessionTreeError> for RewindError {
    fn from(err: SessionTreeError) -> Self {
        Self::new("session.invalid_state", err.to_string())
    }
}

/// rewind 计划输入
pub struct PlanRewindInput<'a> {
    /// 当前会话树（提供会话 id、当前叶子与条目）
    pub session: &'a SessionTree,
    /// 目标叶子 id（None = 根前位置）
    pub target_leaf_id: Option<&'a str>,
    /// 全部 run 记录（跨会话，按会话过滤）
    pub runs: &'a [RewindRunInfo],
    /// 活动子 agent 列表
    pub active_subagents: &'a [RewindActiveSubagent],
    /// 挂起审批列表
    pub pending_approvals: &'a [RewindPendingApproval],
    /// 检查点目标（None = 无检查点）
    pub checkpoint: Option<&'a RewindCheckpointTarget>,
    /// 工作区恢复策略
    pub restore_policy: RewindRestorePolicy,
}

/// 编制 conversation-rewind 计划（05 §5.4 rewind::plan）
///
/// 步骤顺序固定：取消 run → 清审批 → 恢复检查点 → 移动叶子
/// （conversation-rewind.test.ts:52 语义）；空步骤省略；目标与当前
/// 叶子相同则省略移动步骤。
///
/// 语义对齐 conversation-rewind.ts planConversationRewind：
/// - 只取消本会话的非终态 run（含其活动子 agent run）；
/// - 审批清除只针对「被取消 run」的挂起审批；
/// - 恢复策略 required 且无检查点 → 报错（store.write_failed，R6 迁移码）。
pub fn plan_conversation_rewind(input: &PlanRewindInput) -> Result<RewindPlan, RewindError> {
    // 目标分支路径（None = 空路径）
    let target_path = input.session.read_branch_path(input.target_leaf_id)?;

    // 1. 取消计划：本会话非终态 run + 其活动子 agent run
    let active_session_run_ids: HashSet<String> = input
        .runs
        .iter()
        .filter(|run| {
            run.session_id == input.session.session_id
                && !RunStateMachine::new(run.status.clone()).is_terminal()
        })
        .map(|run| run.run_id.clone())
        .collect();
    let mut cancellations: Vec<RewindRunCancellation> = Vec::new();
    let mut cancelled_ids = HashSet::new();
    for run in input.runs {
        if run.session_id != input.session.session_id {
            continue;
        }
        if !RunStateMachine::new(run.status.clone()).is_terminal() {
            cancellations.push(RewindRunCancellation {
                run_id: run.run_id.clone(),
                role: RewindRunRole::SessionRun,
            });
            cancelled_ids.insert(run.run_id.clone());
        }
    }
    for subagent in input.active_subagents {
        if !active_session_run_ids.contains(&subagent.parent_run_id) {
            continue;
        }
        // 子 agent run 本身已终态则跳过（无 run 记录时仍按活动处理）
        let terminal = input
            .runs
            .iter()
            .find(|run| run.run_id == subagent.subagent_run_id)
            .map(|run| RunStateMachine::new(run.status.clone()).is_terminal())
            .unwrap_or(false);
        if terminal {
            continue;
        }
        if cancelled_ids.insert(subagent.subagent_run_id.clone()) {
            cancellations.push(RewindRunCancellation {
                run_id: subagent.subagent_run_id.clone(),
                role: RewindRunRole::SubagentRun,
            });
        }
    }

    // 2. 审批清除：只针对被取消 run 的挂起审批
    let approval_clearances: Vec<RewindApprovalClearance> = input
        .pending_approvals
        .iter()
        .filter(|approval| cancelled_ids.contains(&approval.run_id))
        .map(|approval| RewindApprovalClearance {
            tool_call_id: approval.tool_call_id.clone(),
            run_id: approval.run_id.clone(),
        })
        .collect();

    // 3. 工作区恢复计划
    let workspace_restore = plan_workspace_restore(input.checkpoint, input.restore_policy)?;

    // 4. 步骤排序（取消 → 清审批 → 恢复检查点 → 移动叶子）
    let from_leaf_id = input.session.current_leaf_id.clone();
    let target_leaf_id = input.target_leaf_id.map(str::to_string);
    let mut steps = Vec::new();
    if !cancellations.is_empty() {
        steps.push(RewindStep::CancelRuns(cancellations));
    }
    if !approval_clearances.is_empty() {
        steps.push(RewindStep::ClearApprovals(approval_clearances));
    }
    if workspace_restore.source != RewindCheckpointSource::None {
        steps.push(RewindStep::RestoreWorkspace(workspace_restore));
    }
    if from_leaf_id != target_leaf_id {
        steps.push(RewindStep::MoveSessionLeaf {
            session_id: input.session.session_id.clone(),
            from_leaf_id: from_leaf_id.clone(),
            to_leaf_id: target_leaf_id.clone(),
        });
    }

    Ok(RewindPlan {
        session_id: input.session.session_id.clone(),
        from_leaf_id,
        target_leaf_id,
        target_path,
        steps,
    })
}

/// 工作区恢复计划（conversation-rewind.ts planWorkspaceRestore 语义）
fn plan_workspace_restore(
    checkpoint: Option<&RewindCheckpointTarget>,
    policy: RewindRestorePolicy,
) -> Result<RewindWorkspaceRestore, RewindError> {
    if policy == RewindRestorePolicy::Skip {
        return Ok(RewindWorkspaceRestore {
            required: false,
            source: RewindCheckpointSource::None,
            checkpoint_id: None,
            manifest_path: None,
            checkpoint: None,
            clean_untracked: false,
        });
    }
    let checkpoint = match checkpoint {
        Some(target) => target,
        None if policy == RewindRestorePolicy::Required => {
            return Err(RewindError::new(
                "store.write_failed",
                "conversation-rewind 需要工作区检查点（restorePolicy=required）",
            ));
        }
        None => {
            return Ok(RewindWorkspaceRestore {
                required: false,
                source: RewindCheckpointSource::None,
                checkpoint_id: None,
                manifest_path: None,
                checkpoint: None,
                clean_untracked: false,
            });
        }
    };
    match checkpoint {
        RewindCheckpointTarget::RuntimeManifest {
            checkpoint_id,
            manifest_path,
        } => Ok(RewindWorkspaceRestore {
            required: true,
            source: RewindCheckpointSource::RuntimeManifest,
            checkpoint_id: Some(checkpoint_id.clone()),
            manifest_path: manifest_path.clone(),
            checkpoint: None,
            clean_untracked: false,
        }),
        RewindCheckpointTarget::GitCheckpoint {
            checkpoint,
            clean_untracked,
        } => Ok(RewindWorkspaceRestore {
            required: true,
            source: RewindCheckpointSource::GitCheckpoint,
            checkpoint_id: None,
            manifest_path: None,
            checkpoint: Some(checkpoint.clone()),
            clean_untracked: *clean_untracked,
        }),
    }
}

/// rewind 执行器（执行骨架的下层协作接口；审批清理由上层配合：
/// 由上层持有审批分发通道，clear_approval 实现发出 approval-resolved）
#[async_trait::async_trait]
pub trait RewindExecutor: Send + Sync {
    /// 取消一个 run（conversation-rewind reason）
    async fn cancel_run(&self, run_id: &str, role: RewindRunRole) -> Result<(), RewindError>;
    /// 清除一条挂起审批
    async fn clear_approval(&self, clearance: &RewindApprovalClearance) -> Result<(), RewindError>;
    /// 恢复工作区检查点
    async fn restore_workspace(&self, restore: &RewindWorkspaceRestore) -> Result<(), RewindError>;
    /// 移动会话叶子（上层持久化 session-leaf-moved 事件并更新会话树）
    async fn move_session_leaf(
        &self,
        session_id: &str,
        to_leaf_id: Option<&str>,
    ) -> Result<(), RewindError>;
}

/// 按计划顺序执行 rewind 步骤（执行骨架，05 §5.4 rewind::plan：
/// 取消 run → 清审批 → 恢复检查点 → 移动叶子）
///
/// 任一步骤失败立即返回，不继续后续步骤（顺序语义保证：审批清除
/// 必须发生在 run 取消之后，叶子移动发生在工作区恢复之后）。
pub async fn execute_rewind(
    plan: &RewindPlan,
    executor: &dyn RewindExecutor,
) -> Result<(), RewindError> {
    for step in &plan.steps {
        match step {
            RewindStep::CancelRuns(runs) => {
                for run in runs {
                    executor.cancel_run(&run.run_id, run.role).await?;
                }
            }
            RewindStep::ClearApprovals(approvals) => {
                for approval in approvals {
                    executor.clear_approval(approval).await?;
                }
            }
            RewindStep::RestoreWorkspace(restore) => {
                executor.restore_workspace(restore).await?;
            }
            RewindStep::MoveSessionLeaf {
                session_id,
                to_leaf_id,
                ..
            } => {
                executor
                    .move_session_leaf(session_id, to_leaf_id.as_deref())
                    .await?;
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn tree() -> SessionTree {
        SessionTree::new("session_a")
    }

    /// 追加根 → 子 → 孙 的链，返回三个节点
    fn chain(tree: &mut SessionTree) -> (SessionTreeEntry, SessionTreeEntry, SessionTreeEntry) {
        let root = tree.append("root", json!({ "text": "root" })).unwrap();
        let mid = tree.append("mid", json!({ "text": "mid" })).unwrap();
        let leaf = tree.append("leaf", json!({ "text": "leaf" })).unwrap();
        (root, mid, leaf)
    }

    // ── 追加 / 分叉 / 叶子移动 ──

    /// 追加：新节点挂在当前叶子下并推进叶子指针（session-tree.test.ts:7）
    #[test]
    fn append_chains_under_current_leaf_and_advances_pointer() {
        let mut t = tree();
        let first = t.append("first", json!({ "text": "first" })).unwrap();
        let second = t.append("second", json!({ "text": "second" })).unwrap();

        assert!(first.parent_id.is_none());
        assert_eq!(second.parent_id.as_deref(), Some("first"));
        assert_eq!(t.current_leaf_id(), Some("second"));
        // 当前叶子路径（None 入参 = 根前空路径，见 read_branch_path 文档）
        let branch = t.read_branch_path(t.current_leaf_id()).unwrap();
        let path: Vec<&str> = branch.iter().map(|e| e.id.as_str()).collect();
        assert_eq!(path, vec!["first", "second"]);
    }

    /// 分叉：从某节点派生新叶子，原分支路径不被改写（session-tree.test.ts:19）
    #[test]
    fn fork_derives_new_leaf_without_rewriting_original_path() {
        let mut t = tree();
        let (root, original, _leaf) = chain(&mut t);

        let branch = t.fork(&root.id, "branch", json!({ "text": "branch" })).unwrap();
        assert_eq!(branch.parent_id.as_deref(), Some("root"));
        assert_eq!(t.current_leaf_id(), Some("branch"));
        // 原叶子路径仍可回溯（original = mid，路径为 root → mid）
        let original_branch = t.read_branch_path(Some(&original.id)).unwrap();
        let original_path: Vec<&str> = original_branch.iter().map(|e| e.id.as_str()).collect();
        assert_eq!(original_path, vec!["root", "mid"]);
        let branch_branch = t.read_branch_path(Some(&branch.id)).unwrap();
        let branch_path: Vec<&str> = branch_branch.iter().map(|e| e.id.as_str()).collect();
        assert_eq!(branch_path, vec!["root", "branch"]);
    }

    /// 分叉：目标节点不存在 → NotFound（session-tree.test.ts:145）
    #[test]
    fn fork_rejects_missing_source() {
        let mut t = tree();
        t.append("root", json!({})).unwrap();
        let err = t.fork("missing", "x", json!({})).unwrap_err();
        assert!(matches!(err, SessionTreeError::NotFound { .. }));
    }

    /// 叶子移动：指针迁移不新增条目（session-tree.test.ts:33）
    #[test]
    fn move_leaf_migrates_pointer_without_appending() {
        let mut t = tree();
        let (root, _mid, _leaf) = chain(&mut t);
        let count_before = t.entries().len();

        t.move_leaf(Some(&root.id), None).unwrap();
        assert_eq!(t.entries().len(), count_before, "移动不新增条目");
        let new = t.append("new", json!({})).unwrap();
        assert_eq!(new.parent_id.as_deref(), Some("root"));
        // 旧分支路径仍可回溯
        assert!(t.read_branch_path(Some("leaf")).is_ok());
    }

    /// 叶子移动：目标不存在 → NotFound（session-tree.test.ts:145）
    #[test]
    fn move_leaf_rejects_missing_target() {
        let mut t = tree();
        t.append("root", json!({})).unwrap();
        let err = t.move_leaf(Some("missing"), None).unwrap_err();
        assert!(matches!(err, SessionTreeError::NotFound { .. }));
    }

    /// 叶子移动：expected_current_leaf 校验（乐观并发控制）
    #[test]
    fn move_leaf_validates_expected_current_leaf() {
        let mut t = tree();
        let (root, _mid, leaf) = chain(&mut t);

        // 期望与实际一致 → 成功
        t.move_leaf(Some(&root.id), Some(&leaf.id)).unwrap();
        assert_eq!(t.current_leaf_id(), Some("root"));

        // 期望与实际不一致 → ExpectedLeafMismatch（含实际值）
        let err = t.move_leaf(Some("leaf"), Some("mid")).unwrap_err();
        match err {
            SessionTreeError::ExpectedLeafMismatch { expected, actual } => {
                assert_eq!(expected, "mid");
                assert_eq!(actual.as_deref(), Some("root"), "实际叶子为当前 root");
            }
            other => panic!("期望 ExpectedLeafMismatch：{other:?}"),
        }
        // 失败后指针未被改写
        assert_eq!(t.current_leaf_id(), Some("root"));
    }

    /// 恢复叶子：无显式叶子时恢复到最后插入条目（session-tree.test.ts:86）
    #[test]
    fn restore_leaf_defaults_to_last_inserted() {
        let mut t = tree();
        chain(&mut t);
        t.move_leaf(Some("root"), None).unwrap();
        assert_eq!(t.current_leaf_id(), Some("root"));

        t.restore_leaf(None).unwrap();
        assert_eq!(t.current_leaf_id(), Some("leaf"), "无显式叶子时回最后插入条目");
    }

    /// 恢复叶子：根前位置（null）合法（session-tree.test.ts:110）
    #[test]
    fn restore_leaf_allows_root_before_first_position() {
        let mut t = tree();
        t.append("old_root", json!({})).unwrap();
        t.move_leaf(None, None).unwrap();
        let new_root = t.append("new_root", json!({})).unwrap();
        assert!(new_root.parent_id.is_none());
        let branch = t.read_branch_path(t.current_leaf_id()).unwrap();
        let path: Vec<&str> = branch.iter().map(|e| e.id.as_str()).collect();
        assert_eq!(path, vec!["new_root"]);
    }

    // ── 结构校验与防御 ──

    /// 重复 id → DuplicateId（session-tree.test.ts:180 / :215）
    #[test]
    fn from_entries_rejects_duplicate_ids() {
        let entries = vec![
            SessionTreeEntry::node("dup", None, json!({})),
            SessionTreeEntry::node("dup", Some("dup".to_string()), json!({})),
        ];
        let err = SessionTree::from_entries("s".into(), entries, None).unwrap_err();
        assert!(matches!(err, SessionTreeError::DuplicateId { .. }));
    }

    /// 父先于子校验（session-tree.test.ts:121）
    #[test]
    fn from_entries_rejects_parent_after_child() {
        let entries = vec![SessionTreeEntry::node("child", Some("missing".to_string()), json!({}))];
        let err = SessionTree::from_entries("s".into(), entries, None).unwrap_err();
        assert!(matches!(err, SessionTreeError::InvalidState { .. }));
    }

    /// 分支摘要引用缺失的被放弃叶子 → NotFound（session-tree.test.ts:195）
    #[test]
    fn from_entries_rejects_abandoned_leaf_not_found() {
        let entries = vec![
            SessionTreeEntry::node("root", None, json!({})),
            SessionTreeEntry {
                id: "summary_1".to_string(),
                parent_id: Some("root".to_string()),
                created_at: 1,
                kind: SessionTreeEntryKind::BranchSummary {
                    summary: "abandoned".to_string(),
                    abandoned_leaf_id: Some("ghost".to_string()),
                    details: None,
                },
            },
        ];
        let err = SessionTree::from_entries("s".into(), entries, None).unwrap_err();
        assert!(matches!(err, SessionTreeError::NotFound { .. }));
    }

    /// 分支路径环检测（防御，session-tree.test.ts:156）
    #[test]
    fn read_branch_path_detects_cycle() {
        // 手工构造非法树：a → b、b → a 成环
        let mut t = tree();
        t.append("a", json!({})).unwrap();
        t.append("b", json!({})).unwrap();
        let (a, b) = (t.entry("a").unwrap().clone(), t.entry("b").unwrap().clone());
        t.entries = vec![
            SessionTreeEntry { parent_id: Some(b.id.clone()), ..a.clone() },
            SessionTreeEntry { parent_id: Some(a.id.clone()), ..b.clone() },
        ];
        let err = t.read_branch_path(Some("b")).unwrap_err();
        assert!(matches!(err, SessionTreeError::Cycle { .. }));
    }

    /// 分支放弃摘要：挂到目标节点，记录被放弃叶子（session-tree.test.ts:47）
    #[test]
    fn abandon_branch_attaches_summary_at_target() {
        let mut t = tree();
        let (root, _mid, abandoned) = chain(&mut t);
        let summary = t
            .abandon_branch_with_summary(
                Some(&root.id),
                "summary_1",
                "Captured the abandoned work.",
                Some(json!({ "reason": "changed direction" })),
            )
            .unwrap();
        assert_eq!(summary.parent_id.as_deref(), Some("root"));
        match &summary.kind {
            SessionTreeEntryKind::BranchSummary {
                summary,
                abandoned_leaf_id,
                ..
            } => {
                assert_eq!(summary, "Captured the abandoned work.");
                assert_eq!(abandoned_leaf_id.as_deref(), Some(abandoned.id()));
            }
            other => panic!("期望 BranchSummary：{other:?}"),
        }
        assert_eq!(t.current_leaf_id(), Some("summary_1"));
        let branch = t.read_branch_path(t.current_leaf_id()).unwrap();
        let path: Vec<&str> = branch.iter().map(|e| e.id.as_str()).collect();
        assert_eq!(path, vec!["root", "summary_1"]);
    }

    /// 会话记录往返：to_session_record → from_session_record 保持结构与叶子
    #[test]
    fn session_record_roundtrip_preserves_tree() {
        let mut t = tree();
        chain(&mut t);
        t.move_leaf(Some("root"), None).unwrap();
        let record = t.to_session_record();
        assert_eq!(record.session_id, "session_a");
        assert_eq!(record.current_leaf_id.as_deref(), Some("root"));
        assert_eq!(record.branches.len(), 3, "分支列表 = 全部条目");

        let restored = SessionTree::from_session_record(record).unwrap();
        assert_eq!(restored.current_leaf_id(), Some("root"));
        assert_eq!(restored.entries().len(), 3);
        // 当前叶子为 root（移动后的指针保真）
        let branch = restored.read_branch_path(restored.current_leaf_id()).unwrap();
        let path: Vec<&str> = branch.iter().map(|e| e.id.as_str()).collect();
        assert_eq!(path, vec!["root"]);
        // 原分支路径仍可回溯（树结构完整）
        let branch = restored.read_branch_path(Some("leaf")).unwrap();
        let path: Vec<&str> = branch.iter().map(|e| e.id.as_str()).collect();
        assert_eq!(path, vec!["root", "mid", "leaf"]);
    }

    /// 叶子移动持久化事件：载荷构建 + 应用（orchestrator.test.ts:813）
    #[test]
    fn leaf_move_event_payload_roundtrip() {
        let mut record = tree().to_session_record();
        record.apply_leaf_move_event(&session_leaf_moved_payload("leaf_target")).unwrap();
        assert_eq!(record.current_leaf_id.as_deref(), Some("leaf_target"));

        let err = record.apply_leaf_move_event("{}").unwrap_err();
        assert!(matches!(err, SessionTreeError::InvalidState { .. }));
    }

    // ── T-34：会话上下文元数据（P4 阶段 5-1 护栏持久化） ──

    /// 会话记录上下文元数据：set / get + serde roundtrip（快照持久化形态）
    #[test]
    fn session_record_context_meta_roundtrip() {
        let meta = conex_types::context::SessionContextMeta {
            last_compaction_at: Some(1_700_000_000_000),
            last_compaction_sequence: Some(42),
            last_compaction_generation: Some(3),
            compression_retries: 1,
        };
        let mut record = tree().to_session_record();
        assert!(record.context_meta().is_none(), "新建会话记录无护栏");
        record.set_context_meta(meta.clone());
        assert_eq!(record.context_meta(), Some(&meta));

        // serde roundtrip：camelCase + skip_none（快照/会话记录持久化形态）
        let json = serde_json::to_string(&record).unwrap();
        let back: SessionRecord = serde_json::from_str(&json).unwrap();
        assert_eq!(back.context_meta(), Some(&meta));
        assert!(json.contains("contextMeta"), "camelCase 序列化：{json}");
        // 旧快照（无 contextMeta 字段）→ None（schema 兼容）
        let legacy = r#"{"sessionId":"s1","currentLeafId":null,"branches":[]}"#;
        let legacy_record: SessionRecord = serde_json::from_str(legacy).unwrap();
        assert!(legacy_record.context_meta().is_none(), "旧快照缺省 None");
    }

    /// 压缩结束事件折叠：last_compaction_at = 事件时间戳（epoch ms）、
    /// sequence = 事件序列、generation 逐条 +1、compression_retries 归零
    #[test]
    fn apply_compression_end_updates_guards() {
        let mut record = tree().to_session_record();
        let boundary = parse_iso8601_epoch_ms("2026-08-03T10:00:00.000Z").unwrap();
        // 首次压缩：从无护栏建立
        assert!(record.apply_compression_end(7, "2026-08-03T10:00:00.000Z"));
        let meta = record.context_meta().expect("首次压缩必须建立护栏");
        assert_eq!(meta.last_compaction_at, Some(boundary));
        assert_eq!(meta.last_compaction_sequence, Some(7));
        assert_eq!(meta.last_compaction_generation, Some(1), "首次压缩代数 = 1");
        assert_eq!(meta.compression_retries, 0);
        // 第二次压缩：边界推进、序列更新、代数 +1
        let boundary2 = parse_iso8601_epoch_ms("2026-08-03T12:30:00.000Z").unwrap();
        assert!(record.apply_compression_end(15, "2026-08-03T12:30:00.000Z"));
        let meta = record.context_meta().expect("护栏持续存在");
        assert_eq!(meta.last_compaction_at, Some(boundary2), "边界推进到最近压缩");
        assert_eq!(meta.last_compaction_sequence, Some(15));
        assert_eq!(meta.last_compaction_generation, Some(2), "代数按事件累计");
    }

    /// 时间戳不可解析：保持既有护栏状态（不写坏），返回 false
    #[test]
    fn apply_compression_end_ignores_unparseable_timestamp() {
        let mut record = tree().to_session_record();
        assert!(!record.apply_compression_end(1, "not-a-timestamp"));
        assert!(record.context_meta().is_none(), "非法输入不得建立护栏");
        // 既有护栏 + 非法输入：护栏不被破坏
        assert!(record.apply_compression_end(2, "2026-08-03T10:00:00.000Z"));
        assert!(!record.apply_compression_end(3, "2026-13-99T99:99:99.000Z"));
        let meta = record.context_meta().expect("既有护栏保留");
        assert_eq!(meta.last_compaction_sequence, Some(2), "非法输入不得推进序列");
        assert_eq!(meta.last_compaction_generation, Some(1));
    }

    /// ISO 时间戳解析精度：毫秒、缺毫秒、非法形态
    #[test]
    fn parse_iso8601_epoch_ms_precision() {
        assert_eq!(
            parse_iso8601_epoch_ms("1970-01-01T00:00:00.000Z"),
            Some(0)
        );
        assert_eq!(
            parse_iso8601_epoch_ms("1970-01-01T00:00:00.500Z"),
            Some(500)
        );
        assert_eq!(
            parse_iso8601_epoch_ms("1970-01-01T00:00:01Z"),
            Some(1_000),
            "缺毫秒按 0 处理"
        );
        assert_eq!(
            parse_iso8601_epoch_ms("2026-08-03T11:30:00.500Z"),
            parse_iso8601_epoch_ms("2026-08-03T11:30:00.5Z"),
            "毫秒补零一致"
        );
        for bad in [
            "2026-08-03T11:30:00",
            "2026-08-03 11:30:00.000Z",
            "2026-13-01T00:00:00.000Z",
            "2026-08-03T24:00:00.000Z",
            "garbage",
            "",
        ] {
            assert_eq!(parse_iso8601_epoch_ms(bad), None, "非法形态：{bad}");
        }
    }

    // ── conversation-rewind 计划 ──

    fn rewind_tree() -> SessionTree {
        let mut t = tree();
        t.append("root", json!({})).unwrap();
        t.append("leaf_target", json!({})).unwrap();
        t.move_leaf(Some("root"), None).unwrap();
        t.append("leaf_current", json!({})).unwrap();
        t
    }

    fn run(id: &str, session_id: &str, status: RunStatus) -> RewindRunInfo {
        RewindRunInfo {
            run_id: id.to_string(),
            session_id: session_id.to_string(),
            status,
        }
    }

    /// 计划步骤顺序：取消 run → 清审批 → 恢复检查点 → 移动叶子
    /// （conversation-rewind.test.ts:14 语义）
    #[test]
    fn rewind_plan_steps_in_documented_order() {
        let session = rewind_tree();
        let plan = plan_conversation_rewind(&PlanRewindInput {
            session: &session,
            target_leaf_id: Some("leaf_target"),
            runs: &[
                run("run_active", "session_a", RunStatus::AwaitingApproval),
                run("run_done", "session_a", RunStatus::Completed),
                run("run_other", "session_b", RunStatus::Running),
                run("run_sub", "session_sub", RunStatus::Running),
            ],
            active_subagents: &[RewindActiveSubagent {
                subagent_run_id: "run_sub".to_string(),
                parent_run_id: "run_active".to_string(),
            }],
            pending_approvals: &[
                RewindPendingApproval {
                    tool_call_id: "approval_active".to_string(),
                    run_id: "run_active".to_string(),
                },
                RewindPendingApproval {
                    tool_call_id: "approval_other".to_string(),
                    run_id: "run_other".to_string(),
                },
                RewindPendingApproval {
                    tool_call_id: "approval_sub".to_string(),
                    run_id: "run_sub".to_string(),
                },
            ],
            checkpoint: Some(&RewindCheckpointTarget::GitCheckpoint {
                checkpoint: "git_checkpoint_1".to_string(),
                clean_untracked: false,
            }),
            restore_policy: RewindRestorePolicy::IfPresent,
        })
        .unwrap();

        assert_eq!(plan.from_leaf_id.as_deref(), Some("leaf_current"));
        let path: Vec<&str> = plan.target_path.iter().map(|e| e.id.as_str()).collect();
        assert_eq!(path, vec!["root", "leaf_target"]);
        // 只取消本会话非终态 run 及其活动子 agent run
        let cancellations = match &plan.steps[0] {
            RewindStep::CancelRuns(runs) => runs,
            other => panic!("第一步应为 cancel-runs：{other:?}"),
        };
        let cancelled: Vec<&str> = cancellations.iter().map(|r| r.run_id.as_str()).collect();
        assert_eq!(cancelled, vec!["run_active", "run_sub"]);
        // 审批清除只针对被取消的 run（approval_other 属于 run_other，不在本会话）
        let clearances = match &plan.steps[1] {
            RewindStep::ClearApprovals(approvals) => approvals,
            other => panic!("第二步应为 clear-approvals：{other:?}"),
        };
        let cleared: Vec<&str> = clearances.iter().map(|a| a.tool_call_id.as_str()).collect();
        assert_eq!(cleared, vec!["approval_active", "approval_sub"]);
        // 步骤顺序断言
        let step_types: Vec<&str> = plan.steps.iter().map(|s| s.type_name()).collect();
        assert_eq!(
            step_types,
            vec!["cancel-runs", "clear-approvals", "restore-workspace", "move-session-leaf"]
        );
    }

    /// 纯树回退（skip 策略）：只保留移动叶子步骤
    /// （conversation-rewind.test.ts:87 语义）
    #[test]
    fn rewind_plan_skip_policy_keeps_only_leaf_move() {
        let session = rewind_tree();
        let plan = plan_conversation_rewind(&PlanRewindInput {
            session: &session,
            target_leaf_id: Some("leaf_target"),
            runs: &[],
            active_subagents: &[],
            pending_approvals: &[],
            checkpoint: None,
            restore_policy: RewindRestorePolicy::Skip,
        })
        .unwrap();
        let step_types: Vec<&str> = plan.steps.iter().map(|s| s.type_name()).collect();
        assert_eq!(step_types, vec!["move-session-leaf"]);
    }

    /// required 策略且无检查点 → store.write_failed
    /// （conversation-rewind.test.ts:133 语义）
    #[test]
    fn rewind_plan_required_policy_without_checkpoint_fails() {
        let session = rewind_tree();
        let err = plan_conversation_rewind(&PlanRewindInput {
            session: &session,
            target_leaf_id: Some("leaf_target"),
            runs: &[],
            active_subagents: &[],
            pending_approvals: &[],
            checkpoint: None,
            restore_policy: RewindRestorePolicy::Required,
        })
        .unwrap_err();
        assert_eq!(err.kind, "store.write_failed");
    }

    /// 目标叶子与当前叶子相同：省略移动步骤（tree-only 场景）
    #[test]
    fn rewind_plan_omits_move_step_when_target_is_current() {
        let session = rewind_tree();
        let plan = plan_conversation_rewind(&PlanRewindInput {
            session: &session,
            target_leaf_id: Some("leaf_current"),
            runs: &[],
            active_subagents: &[],
            pending_approvals: &[],
            checkpoint: None,
            restore_policy: RewindRestorePolicy::Skip,
        })
        .unwrap();
        assert!(plan.steps.is_empty(), "目标即当前叶子时不产生步骤");
    }

    /// 目标叶子不存在 → 计划失败（conversation-rewind.test.ts:153 语义）
    #[test]
    fn rewind_plan_rejects_missing_target() {
        let session = rewind_tree();
        let err = plan_conversation_rewind(&PlanRewindInput {
            session: &session,
            target_leaf_id: Some("missing"),
            runs: &[],
            active_subagents: &[],
            pending_approvals: &[],
            checkpoint: None,
            restore_policy: RewindRestorePolicy::IfPresent,
        })
        .unwrap_err();
        assert_eq!(err.kind, "session.invalid_state");
    }

    // ── 执行骨架 ──

    /// 记录调用顺序的执行器（测试替身）
    struct RecordingExecutor {
        calls: std::sync::Mutex<Vec<String>>,
    }

    impl RecordingExecutor {
        fn new() -> Self {
            Self {
                calls: std::sync::Mutex::new(Vec::new()),
            }
        }
    }

    #[async_trait::async_trait]
    impl RewindExecutor for RecordingExecutor {
        async fn cancel_run(&self, run_id: &str, role: RewindRunRole) -> Result<(), RewindError> {
            self.calls
                .lock()
                .unwrap()
                .push(format!("cancel:{run_id}:{role:?}"));
            Ok(())
        }

        async fn clear_approval(&self, clearance: &RewindApprovalClearance) -> Result<(), RewindError> {
            self.calls
                .lock()
                .unwrap()
                .push(format!("clear:{}", clearance.tool_call_id));
            Ok(())
        }

        async fn restore_workspace(&self, restore: &RewindWorkspaceRestore) -> Result<(), RewindError> {
            self.calls
                .lock()
                .unwrap()
                .push(format!("restore:{:?}", restore.source));
            Ok(())
        }

        async fn move_session_leaf(
            &self,
            session_id: &str,
            to_leaf_id: Option<&str>,
        ) -> Result<(), RewindError> {
            self.calls
                .lock()
                .unwrap()
                .push(format!("move:{session_id}:{to_leaf_id:?}"));
            Ok(())
        }
    }

    /// 执行骨架按计划顺序调用执行器
    #[tokio::test]
    async fn execute_rewind_calls_executor_in_step_order() {
        let session = rewind_tree();
        let plan = plan_conversation_rewind(&PlanRewindInput {
            session: &session,
            target_leaf_id: Some("leaf_target"),
            runs: &[run("run_active", "session_a", RunStatus::Running)],
            active_subagents: &[],
            pending_approvals: &[RewindPendingApproval {
                tool_call_id: "approval_active".to_string(),
                run_id: "run_active".to_string(),
            }],
            checkpoint: Some(&RewindCheckpointTarget::RuntimeManifest {
                checkpoint_id: "checkpoint_1".to_string(),
                manifest_path: Some("C:/repo/.agent-runtime/checkpoint.json".to_string()),
            }),
            restore_policy: RewindRestorePolicy::IfPresent,
        })
        .unwrap();

        let executor = RecordingExecutor::new();
        execute_rewind(&plan, &executor).await.unwrap();

        let calls = executor.calls.lock().unwrap().clone();
        assert_eq!(
            calls,
            vec![
                "cancel:run_active:SessionRun".to_string(),
                "clear:approval_active".to_string(),
                "restore:RuntimeManifest".to_string(),
                "move:session_a:Some(\"leaf_target\")".to_string(),
            ],
            "执行顺序 = 计划顺序（取消 → 清审批 → 恢复检查点 → 移动叶子）"
        );
    }

    /// 执行后按计划移动会话叶子（上层配合：持久化事件 + 树更新）
    #[tokio::test]
    async fn execute_rewind_then_move_session_leaf_on_tree() {
        let session = rewind_tree();
        let plan = plan_conversation_rewind(&PlanRewindInput {
            session: &session,
            target_leaf_id: Some("leaf_target"),
            runs: &[],
            active_subagents: &[],
            pending_approvals: &[],
            checkpoint: None,
            restore_policy: RewindRestorePolicy::Skip,
        })
        .unwrap();

        let mut tree = session;
        let executor = RecordingExecutor::new();
        execute_rewind(&plan, &executor).await.unwrap();
        // 移动叶子步骤：expected_current_leaf = 计划记录的 from_leaf_id
        tree.move_leaf(plan.target_leaf_id.as_deref(), plan.from_leaf_id.as_deref())
            .unwrap();
        assert_eq!(tree.current_leaf_id(), Some("leaf_target"));
    }

    // ── C1 checkpoint 叶子 payload（M5A 最小落库面） ──

    fn sample_checkpoint(target: &str) -> CheckpointPayload {
        CheckpointPayload {
            target: target.into(),
            summary: "基座完成".into(),
            timestamp: Some("2026-08-03T10:00:00.000Z".into()),
            completed: vec!["安装依赖".into()],
            files: vec!["crates/session-loop/src/safe_point.rs".into()],
            next: vec!["接线恢复注入".into()],
        }
    }

    /// 叶子 payload 读写往返：写入 checkpoint → 读回相等，payload
    /// 其它字段不被触碰（最小落库面）
    #[test]
    fn leaf_checkpoint_write_read_roundtrip_preserves_other_fields() {
        let mut t = tree();
        t.append("leaf1", json!({ "text": "运行记录" })).unwrap();
        let checkpoint = sample_checkpoint("实现采集");
        t.set_leaf_checkpoint("leaf1", &checkpoint).unwrap();

        match t.read_leaf_checkpoint(Some("leaf1")) {
            LeafCheckpointState::Present(back) => assert_eq!(back, checkpoint),
            other => panic!("应读回有效检查点：{other:?}"),
        }
        // payload 其它字段原样保留
        let entry = t.entry("leaf1").expect("叶子存在");
        let SessionTreeEntryKind::Node { payload } = &entry.kind else {
            panic!("应为节点条目");
        };
        assert_eq!(payload["text"], "运行记录");
    }

    /// 无检查点回归：普通叶子 / 分支摘要 / 缺失叶子 → Absent（现状）
    #[test]
    fn leaf_checkpoint_absent_cases() {
        let mut t = tree();
        let (root, _mid, _leaf) = chain(&mut t);
        assert_eq!(
            t.read_leaf_checkpoint(Some(&root.id)),
            LeafCheckpointState::Absent,
            "无 checkpoint 键 → Absent"
        );
        let summary = t
            .abandon_branch_with_summary(None, "summary_1", "abandoned", None)
            .unwrap();
        assert_eq!(
            t.read_leaf_checkpoint(Some(summary.id())),
            LeafCheckpointState::Absent,
            "分支摘要条目 → Absent"
        );
        assert_eq!(
            t.read_leaf_checkpoint(Some("missing")),
            LeafCheckpointState::Absent,
            "缺失叶子 → Absent"
        );
        assert_eq!(
            t.read_leaf_checkpoint(None),
            LeafCheckpointState::Absent,
            "当前叶子（摘要条目）→ Absent"
        );
        // 值为 null → Absent（不是损坏）
        t.append("null_leaf", json!({ "checkpoint": null })).unwrap();
        assert_eq!(
            t.read_leaf_checkpoint(Some("null_leaf")),
            LeafCheckpointState::Absent
        );
    }

    /// 损坏降级：checkpoint 值存在但解析失败 → Corrupt（不 panic）
    #[test]
    fn leaf_checkpoint_corrupt_degrades() {
        let mut t = tree();
        // 值类型错误（target 非字符串）
        t.append("bad1", json!({ "checkpoint": { "target": 123 } })).unwrap();
        // 值非对象（字符串）
        t.append("bad2", json!({ "checkpoint": "oops" })).unwrap();
        for leaf in ["bad1", "bad2"] {
            match t.read_leaf_checkpoint(Some(leaf)) {
                LeafCheckpointState::Corrupt(reason) => {
                    assert!(reason.contains("解析失败"), "损坏原因应可读：{reason}")
                }
                other => panic!("应降级为 Corrupt：{other:?}"),
            }
            assert_eq!(
                t.read_leaf_checkpoint(Some(leaf)).signal(),
                Some(conex_types::checkpoint::CHECKPOINT_CORRUPT_SIGNAL)
            );
        }
    }

    /// 写面校验：缺失叶子 → NotFound；分支摘要 / 非对象 payload →
    /// InvalidState（写不坏树）
    #[test]
    fn leaf_checkpoint_write_rejects_invalid_targets() {
        let mut t = tree();
        chain(&mut t);
        let checkpoint = sample_checkpoint("目标");
        let err = t.set_leaf_checkpoint("missing", &checkpoint).unwrap_err();
        assert!(matches!(err, SessionTreeError::NotFound { .. }));

        let summary = t
            .abandon_branch_with_summary(None, "summary_1", "abandoned", None)
            .unwrap();
        let err = t.set_leaf_checkpoint(summary.id(), &checkpoint).unwrap_err();
        assert!(matches!(err, SessionTreeError::InvalidState { .. }));

        t.append("text_payload", json!("just-a-string")).unwrap();
        let err = t.set_leaf_checkpoint("text_payload", &checkpoint).unwrap_err();
        assert!(matches!(err, SessionTreeError::InvalidState { .. }));
    }

    /// 会话记录往返：带 checkpoint 的叶子经快照 serde 持久化后可读回
    /// （叶子移动经 session-leaf-moved 事件重放的既有恢复面同构）
    #[test]
    fn leaf_checkpoint_survives_session_record_roundtrip() {
        let mut t = tree();
        t.append("leaf1", json!({ "text": "运行记录" })).unwrap();
        let checkpoint = sample_checkpoint("快照目标");
        t.set_leaf_checkpoint("leaf1", &checkpoint).unwrap();

        let json = serde_json::to_string(&t.to_session_record()).unwrap();
        let record: SessionRecord = serde_json::from_str(&json).unwrap();
        let restored = SessionTree::from_session_record(record).unwrap();
        match restored.read_leaf_checkpoint(Some("leaf1")) {
            LeafCheckpointState::Present(back) => assert_eq!(back, checkpoint),
            other => panic!("快照恢复后应读到检查点：{other:?}"),
        }
        assert_eq!(
            restored.read_leaf_checkpoint(None).signal(),
            Some(conex_types::checkpoint::CHECKPOINT_PRESENT_SIGNAL),
            "当前叶子即 checkpoint 叶子 → 优先恢复信号"
        );
    }
}
