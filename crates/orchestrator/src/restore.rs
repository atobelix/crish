//! 重启恢复与状态快照（任务书 B4.3）
//!
//! [RestoreManager::restore] 为冷启动恢复主流程（05 §5.4 run::restore /
//! store::pending）：
//! - **重启扫描**：从 [Store] 恢复全部 runs；in-flight run（queued /
//!   initializing / running / awaiting-approval / cancelling / **completing**）
//!   → 终态 interrupted（previousStatus 审计字段落库为 `run-interrupted`
//!   审计事件，终态变化可追溯；05 §2.8 orchestrator.test.ts:404 语义）；
//! - **blocked 终态保真**：blocked 类状态（Failed + goal-blocked 等 reason）
//!   与其它终态记录（completed / failed / cancelled）**原样保留不打断**
//!   （05 §2.8 orchestrator.test.ts:640 / :702 语义）；
//! - **未知字面量保真**：DB 行 / 快照中的未知状态字面量（裁决 D3，
//!   11-T1）以 `RunStatus::Unknown` 透传——既不打断也不改写，
//!   [RestoreOutcome::unknown_status_runs] 显式上报（诚实滞留取舍）；
//! - **pending 输入恢复**：从 conex-db load_pending_inputs 恢复（FIFO：
//!   创建时间升序，含 id 决胜；05 §2.8 orchestrator.test.ts:360 语义）；
//! - **快照**：全量快照（[StateSnapshot]）+ 增量恢复（lastSequence 后
//!   增量事件流）+ 损坏回退（checksum 校验，损坏时回退到上一完好备份
//!   快照，05 §2.8 orchestrator.test.ts:885 语义；无快照 → 全量重放）。
//! - **逐会话锚点**（PERSIST-02 P1-1）：快照携带每会话已重放的最大
//!   sequence（[StateSnapshot::session_last_sequence]），增量恢复按
//!   会话自身锚点取增量——不再用全会话 max 一刀切（事件序列为会话内
//!   独立，全局 max 作会话级 base 会永久跳过落后会话的快照后事件）；
//!   旧快照无逐会话锚点 → serde default 回退全局 last_sequence（兼容）。
//! - **session_agents 归一**（PERSIST-02 P1-3）：子代理运行中崩溃 →
//!   session_agents 行残留 running；restore 时对 running 行执行
//!   kill_all 语义归一（failed + ended_at），防 FlowScheduler 重建后
//!   节点永久 Running、流程卡死。
//!
//! 快照文件存储为「主文件 + .prev 备份」双文件模型：每次保存先轮转
//! （主文件 → 备份）再原子写入（tmp + rename），主文件损坏时回退备份。

use std::collections::HashMap;
use std::fmt;
use std::path::{Path, PathBuf};
use std::str::FromStr;

use conex_db::{PendingInput, RunStatus, StoredRun};
use conex_types::events::AgentEvent;
use serde::{Deserialize, Serialize};

use crate::persist::{Store, StoreError};
use crate::session::{
    CONTEXT_COMPRESSION_END_EVENT, SESSION_LEAF_MOVED_EVENT, SessionRecord, SessionTreeError,
};
use crate::now_ms;

/// in-flight → interrupted 的终态 reason（05 §2.8 orchestrator.test.ts:404）
pub const INTERRUPTED_REASON: &str = "daemon-restarted";
/// run 被打断的终态错误文案（非 cancelling 路径）
pub const INTERRUPTED_ERROR: &str = "Run was interrupted by daemon restart.";
/// 取消被打断的终态错误文案（cancelling 路径）
pub const CANCEL_INTERRUPTED_ERROR: &str = "Run cancellation was interrupted by daemon restart.";
/// 恢复审计事件类型名（previousStatus 审计字段落库）
pub const RUN_INTERRUPTED_EVENT: &str = "run-interrupted";

/// 快照顶层 type（对齐 TS orchestrator-state-snapshot）
pub const SNAPSHOT_TYPE: &str = "orchestrator-state-snapshot";
/// 快照 schema 版本
pub const SNAPSHOT_SCHEMA_VERSION: u32 = 1;

/// 恢复模式（05 §2.8 orchestrator.test.ts:1008 / :1066）
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RestoreMode {
    /// 无可用快照：从事件全量重放
    FullReplay,
    /// 快照有效：从 lastSequence 后增量流
    SnapshotIncremental,
}

/// interrupted 恢复审计记录（previousStatus 审计字段，终态变化可追溯）
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InterruptedRun {
    /// run id
    pub run_id: String,
    /// 会话 id
    pub session_id: String,
    /// 原（in-flight）状态
    pub previous_status: String,
    /// 终态（failed / cancelled）
    pub status: String,
    /// 终态 reason（daemon-restarted）
    pub reason: String,
    /// 终态错误文案
    pub error: String,
    /// 审计时间戳（epoch ms）
    pub timestamp: i64,
}

/// 恢复结果
///
/// 说明：不派生 PartialEq/Eq——库内 [StoredRun] / [PendingInput] /
/// [SessionRecord] 未实现 Eq（字段比对用逐项断言）。
#[derive(Debug, Clone)]
pub struct RestoreOutcome {
    /// 恢复模式（全量重放 / 快照增量）
    pub mode: RestoreMode,
    /// 恢复的会话记录（快照会话 ∪ run 派生会话）
    pub sessions: Vec<SessionRecord>,
    /// 恢复的 run 记录（in-flight 已标记 interrupted）
    pub runs: Vec<StoredRun>,
    /// 恢复的待处理输入（FIFO）
    pub pending_inputs: Vec<PendingInput>,
    /// 本次恢复打断的 run（previousStatus 审计）
    pub interrupted: Vec<InterruptedRun>,
    /// 未知状态字面量保留的 run（run_id + 原字面量；裁决 D3，11-T1——
    /// 不打断、不改写，显式上报对冲「诚实滞留」）
    pub unknown_status_runs: Vec<(String, String)>,
    /// 事件流锚点（lastSequence：其后事件为增量流）
    pub last_sequence: u64,
    /// 快照回退说明（None = 未回退；快照损坏/缺失回退时含原因）
    pub snapshot_note: Option<String>,
    /// 已加载快照的代数（无快照 = 0；T08.6：恢复成功后立即保存快照时
    /// 以 generation+1 续接）
    pub snapshot_generation: u64,
}

/// 恢复错误
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RestoreError {
    /// 错误类别（操作名）
    pub kind: String,
    /// 错误详情
    pub message: String,
}

impl RestoreError {
    /// 构造恢复错误
    pub fn new(kind: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            kind: kind.into(),
            message: message.into(),
        }
    }
}

impl fmt::Display for RestoreError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}: {}", self.kind, self.message)
    }
}

impl std::error::Error for RestoreError {}

impl From<StoreError> for RestoreError {
    fn from(err: StoreError) -> Self {
        Self::new(err.kind, err.message)
    }
}

impl From<SnapshotError> for RestoreError {
    fn from(err: SnapshotError) -> Self {
        Self::new(err.kind, err.message)
    }
}

impl From<SessionTreeError> for RestoreError {
    fn from(err: SessionTreeError) -> Self {
        Self::new("session.invalid_state", err.to_string())
    }
}

/// 快照错误
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SnapshotError {
    /// 错误类别（操作名）
    pub kind: String,
    /// 错误详情
    pub message: String,
}

impl SnapshotError {
    /// 构造快照错误
    pub fn new(kind: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            kind: kind.into(),
            message: message.into(),
        }
    }
}

impl fmt::Display for SnapshotError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}: {}", self.kind, self.message)
    }
}

impl std::error::Error for SnapshotError {}

/// 快照中的 run 记录（serde 形状；status 以字符串存储，恢复时解析）
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SnapshotRun {
    /// run id
    pub run_id: String,
    /// 会话 id
    pub session_id: String,
    /// 状态字面量（queued / running / ...）
    pub status: String,
    /// 终态 reason
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub end_reason: Option<String>,
    /// 事件序列游标
    pub cursor: i64,
    /// 创建时间（epoch ms）
    pub created_at: i64,
    /// 最近更新时间（epoch ms）
    pub updated_at: i64,
}

impl From<&StoredRun> for SnapshotRun {
    fn from(run: &StoredRun) -> Self {
        Self {
            run_id: run.run_id.clone(),
            session_id: run.session_id.clone(),
            status: run.status.as_str().to_string(),
            end_reason: run.end_reason.clone(),
            cursor: run.cursor,
            created_at: run.created_at,
            updated_at: run.updated_at,
        }
    }
}

impl SnapshotRun {
    /// 还原为库内 run 记录（裁决 D3：未知字面量放宽为 Unknown 透传，
    /// 与 DB 行路径一致——fail-closed → fail-open 保真，快照不再拒绝加载）
    pub fn to_stored_run(&self) -> Result<StoredRun, SnapshotError> {
        let status = match RunStatus::from_str(&self.status) {
            Ok(status) => status,
            // 未知字面量原样保留（快照往返一致，as_str 原样读回）
            Err(_) => RunStatus::Unknown(self.status.clone()),
        };
        Ok(StoredRun {
            run_id: self.run_id.clone(),
            session_id: self.session_id.clone(),
            status,
            end_reason: self.end_reason.clone(),
            cursor: self.cursor,
            created_at: self.created_at,
            updated_at: self.updated_at,
        })
    }
}

/// 快照中的待处理输入（serde 形状，与 conex-db PendingInput 同构）
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SnapshotPendingInput {
    /// 输入 id
    pub id: String,
    /// 会话 id
    pub session_id: String,
    /// 绑定 run id（None = 不绑定，如 after-current-run 模式）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub run_id: Option<String>,
    /// 载荷 JSON
    pub payload: String,
    /// 创建时间（epoch ms）
    pub created_at: i64,
}

impl From<&PendingInput> for SnapshotPendingInput {
    fn from(input: &PendingInput) -> Self {
        Self {
            id: input.id.clone(),
            session_id: input.session_id.clone(),
            run_id: input.run_id.clone(),
            payload: input.payload.clone(),
            created_at: input.created_at,
        }
    }
}

impl SnapshotPendingInput {
    /// 还原为库内待处理输入
    pub fn to_pending_input(&self) -> PendingInput {
        PendingInput {
            id: self.id.clone(),
            session_id: self.session_id.clone(),
            run_id: self.run_id.clone(),
            payload: self.payload.clone(),
            created_at: self.created_at,
        }
    }
}

/// 全量状态快照（05 §2.8 orchestrator.test.ts:885 语义）
///
/// checksum 为除自身外全部字段的规范化 JSON 的 FNV-1a 64 校验和
/// （十六进制）；恢复加载时校验，损坏则回退到上一完好备份快照。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct StateSnapshot {
    /// 顶层 type（orchestrator-state-snapshot）
    #[serde(rename = "type")]
    pub snapshot_type: String,
    /// schema 版本（当前 1）
    pub schema_version: u32,
    /// 快照代数（每次保存 +1；恢复时校验）
    pub generation: u64,
    /// 快照覆盖的最后事件序列号（lastSequence 增量流锚点，全会话 max）
    pub last_sequence: u64,
    /// 逐会话锚点（PERSIST-02 P1-1）：session_id → 快照时该会话事件
    /// max。事件序列为会话内独立，全会话 max 作会话级 base 会跳过
    /// 落后会话的快照后事件（永久粘性）；恢复按本表取每会话增量起点。
    /// 旧快照无该字段 → serde default 空表，恢复回退全局 last_sequence。
    #[serde(default, skip_serializing_if = "HashMap::is_empty")]
    pub session_last_sequence: HashMap<String, u64>,
    /// 写入时间（epoch ms）
    pub written_at: i64,
    /// 会话记录（含会话树）
    pub sessions: Vec<SessionRecord>,
    /// run 记录
    pub runs: Vec<SnapshotRun>,
    /// 待处理输入
    pub pending_inputs: Vec<SnapshotPendingInput>,
    /// 内容校验和（FNV-1a 64，十六进制）
    pub checksum: String,
}

impl StateSnapshot {
    /// 构造快照并计算校验和
    pub fn build(
        generation: u64,
        last_sequence: u64,
        sessions: Vec<SessionRecord>,
        runs: Vec<StoredRun>,
        pending_inputs: Vec<PendingInput>,
        session_last_sequence: HashMap<String, u64>,
    ) -> Self {
        let mut snapshot = Self {
            snapshot_type: SNAPSHOT_TYPE.to_string(),
            schema_version: SNAPSHOT_SCHEMA_VERSION,
            generation,
            last_sequence,
            session_last_sequence,
            written_at: now_ms(),
            sessions,
            runs: runs.iter().map(SnapshotRun::from).collect(),
            pending_inputs: pending_inputs.iter().map(SnapshotPendingInput::from).collect(),
            checksum: String::new(),
        };
        snapshot.checksum = snapshot.compute_checksum();
        snapshot
    }

    /// 校验和校验（type / schema 版本 / 代数 / checksum 全通过才视为完好）
    pub fn valid(&self) -> bool {
        if self.snapshot_type != SNAPSHOT_TYPE
            || self.schema_version != SNAPSHOT_SCHEMA_VERSION
            || self.generation == 0
        {
            return false;
        }
        self.checksum == self.compute_checksum()
    }

    /// 还原库内 run 记录
    pub fn to_stored_runs(&self) -> Result<Vec<StoredRun>, SnapshotError> {
        self.runs.iter().map(SnapshotRun::to_stored_run).collect()
    }

    /// 还原库内待处理输入
    pub fn to_pending_inputs(&self) -> Vec<PendingInput> {
        self.pending_inputs
            .iter()
            .map(SnapshotPendingInput::to_pending_input)
            .collect()
    }

    /// 计算除 checksum 字段外规范化 JSON 的 FNV-1a 64 校验和（十六进制）
    fn compute_checksum(&self) -> String {
        let mut value = serde_json::to_value(self).unwrap_or_default();
        if let Some(map) = value.as_object_mut() {
            map.remove("checksum");
        }
        let bytes = serde_json::to_vec(&value).unwrap_or_default();
        hex_fnv1a64(&bytes)
    }
}

/// FNV-1a 64 位校验和（十六进制小写；不引入外部依赖）
fn hex_fnv1a64(bytes: &[u8]) -> String {
    const OFFSET: u64 = 0xcbf2_9ce4_8422_2325;
    const PRIME: u64 = 0x0000_0100_0000_01b3;
    let mut hash = OFFSET;
    for &byte in bytes {
        hash ^= u64::from(byte);
        hash = hash.wrapping_mul(PRIME);
    }
    format!("{hash:016x}")
}

/// 快照存储抽象（加载 / 保存）
pub trait SnapshotStore: Send + Sync {
    /// 加载快照：校验 checksum，损坏时回退到上一完好备份。
    ///
    /// 返回 (快照, 回退说明)：快照为 None 表示无可用快照（调用方
    /// 全量重放）；回退说明为 Some 表示主快照损坏/缺失、已回退或
    /// 彻底不可用。
    fn load_snapshot(&self) -> Result<(Option<StateSnapshot>, Option<String>), SnapshotError>;
    /// 保存快照（原子写；旧快照轮转为备份）
    fn save_snapshot(&self, snapshot: &StateSnapshot) -> Result<(), SnapshotError>;
}

/// 快照文件读取结果
enum SnapshotFileState {
    /// 文件不存在
    Missing,
    /// 文件存在但损坏（JSON 解析失败 / 校验和不符）
    Corrupt,
    /// 完好快照
    Loaded(StateSnapshot),
}

/// 快照文件存储（主文件 + `.prev` 备份双文件模型）
///
/// 保存：tmp + rename 原子写；保存前把当前主快照轮转为备份。
/// 加载：主快照校验失败（损坏）→ 回退备份快照；主快照缺失但有备份
/// → 回退备份；两者皆不可用 → None（全量重放）。
pub struct SnapshotFileStore {
    /// 主快照路径
    path: PathBuf,
    /// 备份快照路径（上一完好快照）
    backup_path: PathBuf,
}

impl SnapshotFileStore {
    /// 新建文件快照存储（backup = `{path}.prev`）
    pub fn new(path: impl Into<PathBuf>) -> Self {
        let path = path.into();
        let backup_path = PathBuf::from(format!("{}.prev", path.display()));
        Self { path, backup_path }
    }
}

impl SnapshotStore for SnapshotFileStore {
    fn load_snapshot(&self) -> Result<(Option<StateSnapshot>, Option<String>), SnapshotError> {
        match read_snapshot_file(&self.path)? {
            SnapshotFileState::Loaded(snapshot) => Ok((Some(snapshot), None)),
            SnapshotFileState::Corrupt => {
                self.load_backup("主快照校验失败（checksum 不符），已回退到上一完好备份快照")
            }
            SnapshotFileState::Missing => {
                if self.backup_path.exists() {
                    self.load_backup("主快照缺失，已回退到上一完好备份快照")
                } else {
                    Ok((None, None))
                }
            }
        }
    }

    // G2 禁令豁免（clippy.toml 文件头「豁免面」）：快照轮转——删除对象是
    // 本库自管的上一份备份快照（马上被当前主快照取代），非用户文件；
    // 保留旧版反而让恢复可能回退到旧状态，物理删除更正确。
    #[allow(clippy::disallowed_methods)]
    fn save_snapshot(&self, snapshot: &StateSnapshot) -> Result<(), SnapshotError> {
        if !snapshot.valid() {
            return Err(SnapshotError::new("save_snapshot", "快照内容校验失败，拒绝写入"));
        }
        if let Some(parent) = self.path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| io_err("snapshot_mkdir", e))?;
        }
        // 原子写：tmp + rename（对齐 TS writeStateSnapshotFile 语义）
        let tmp_path = PathBuf::from(format!("{}.{}.tmp", self.path.display(), std::process::id()));
        let body = format!(
            "{}\n",
            serde_json::to_string(snapshot).map_err(|e| {
                SnapshotError::new("serialize_snapshot", e.to_string())
            })?
        );
        std::fs::write(&tmp_path, body).map_err(|e| io_err("snapshot_write_tmp", e))?;
        // 轮转：当前主快照 → 备份（Windows rename 不覆盖，先删旧备份）
        if self.path.exists() {
            let _ = std::fs::remove_file(&self.backup_path);
            std::fs::rename(&self.path, &self.backup_path)
                .map_err(|e| io_err("snapshot_rotate", e))?;
        }
        std::fs::rename(&tmp_path, &self.path).map_err(|e| io_err("snapshot_rename", e))?;
        Ok(())
    }
}

impl SnapshotFileStore {
    /// 尝试加载备份快照（上一完好快照）；不可用则全量重放
    fn load_backup(
        &self,
        note: &str,
    ) -> Result<(Option<StateSnapshot>, Option<String>), SnapshotError> {
        match read_snapshot_file(&self.backup_path)? {
            SnapshotFileState::Loaded(snapshot) => Ok((Some(snapshot), Some(note.to_string()))),
            _ => Ok((
                None,
                Some("快照不可用（主快照损坏且无完好备份），回退全量重放".to_string()),
            )),
        }
    }
}

/// 读取并校验快照文件（缺失 / 损坏 / 完好三态）
fn read_snapshot_file(path: &Path) -> Result<SnapshotFileState, SnapshotError> {
    let raw = match std::fs::read_to_string(path) {
        Ok(raw) => raw,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
            return Ok(SnapshotFileState::Missing);
        }
        Err(err) => return Err(io_err("snapshot_read", err)),
    };
    if raw.trim().is_empty() {
        return Ok(SnapshotFileState::Corrupt);
    }
    match serde_json::from_str::<StateSnapshot>(&raw) {
        Ok(snapshot) if snapshot.valid() => Ok(SnapshotFileState::Loaded(snapshot)),
        _ => Ok(SnapshotFileState::Corrupt),
    }
}

/// IO 错误 → 快照错误
fn io_err(kind: &str, err: std::io::Error) -> SnapshotError {
    SnapshotError::new(kind, err.to_string())
}

/// 重启恢复管理器（B4.3）
pub struct RestoreManager;

impl RestoreManager {
    /// 新建恢复管理器
    pub fn new() -> Self {
        Self
    }

    /// 重启恢复主流程（05 §5.4 run::restore / store::pending）
    ///
    /// 流程：
    /// 1. 快照加载（checksum 校验；损坏回退备份快照；无快照 → 全量重放）；
    /// 2. 从 Store 全量扫描 runs；
    /// 3. in-flight run → 终态 interrupted（update_run_status +
    ///    `run-interrupted` 审计事件，previousStatus 可追溯）；
    ///    blocked 与其它终态记录原样保留不打断；
    /// 4. 会话记录组装（快照会话 ∪ run 派生会话）；
    /// 5. 增量流：lastSequence 后事件重放（session-leaf-moved 重放叶子
    ///    移动；last_sequence 推进到最大序列，作为后续增量流锚点）；
    /// 6. pending 输入恢复（load_pending_inputs，FIFO）。
    ///
    /// 快照保存由调用方在恢复成功后执行（恢复本身只读；对齐 TS
    /// 「After successful restore (full or incremental)」写策略）。
    pub async fn restore(
        &self,
        store: &dyn Store,
        snapshots: &dyn SnapshotStore,
    ) -> Result<RestoreOutcome, RestoreError> {
        // 1. 快照加载（损坏 → 回退上一完好备份）
        let (snapshot, snapshot_note) = snapshots.load_snapshot()?;
        let mode = if snapshot.is_some() {
            RestoreMode::SnapshotIncremental
        } else {
            RestoreMode::FullReplay
        };

        // 2. runs 全量扫描（run 表为权威数据源）
        let mut runs = store.query_runs().await?;

        // 3. in-flight → interrupted（previousStatus 审计）；未知字面量
        //    保真保留（is_inflight 已滤）并显式上报
        let mut interrupted = Vec::new();
        let mut unknown_status_runs = Vec::new();
        for run in runs.iter_mut() {
            if !is_inflight(run.status.clone()) {
                // 未知字面量：不打断、不改写，显式上报（裁决 D3 诚实滞留）
                if let RunStatus::Unknown(literal) = &run.status {
                    tracing::warn!(
                        target: "restore",
                        run_id = %run.run_id,
                        status = %literal,
                        "未知状态字面量保留（不打断、不改写）"
                    );
                    unknown_status_runs.push((run.run_id.clone(), literal.clone()));
                }
                continue;
            }
            let previous_status = run.status.clone();
            let (db_status, error) = match previous_status {
                // 取消流程被打断 → cancelled；其余 in-flight → failed
                RunStatus::Cancelling => (RunStatus::Cancelled, CANCEL_INTERRUPTED_ERROR),
                _ => (RunStatus::Failed, INTERRUPTED_ERROR),
            };

            // 审计事件：previousStatus 落库，终态变化可追溯
            let record = InterruptedRun {
                run_id: run.run_id.clone(),
                session_id: run.session_id.clone(),
                previous_status: previous_status.as_str().to_string(),
                status: db_status.as_str().to_string(),
                reason: INTERRUPTED_REASON.to_string(),
                error: error.to_string(),
                timestamp: now_ms(),
            };
            let payload = serde_json::to_string(&record).map_err(|e| {
                RestoreError::new("serialize_interrupted", e.to_string())
            })?;
            let sequence = next_sequence(store, &run.session_id).await?;
            // T08.4：打断路径写 cursor = 审计事件前会话最大已落库序列
            // （sequence-1，T08.8 的 sequence 口径）
            let cursor = sequence.saturating_sub(1);
            store
                .update_run_status(
                    &run.run_id,
                    db_status.clone(),
                    Some(INTERRUPTED_REASON),
                    Some(cursor as i64),
                )
                .await?;
            store
                .append_event(&run.session_id, sequence, RUN_INTERRUPTED_EVENT, &payload)
                .await?;
            run.status = db_status;
            run.end_reason = Some(INTERRUPTED_REASON.to_string());
            run.cursor = cursor as i64;
            run.updated_at = now_ms();
            interrupted.push(record);
        }

        // 3b. session_agents 残留 running 归一（PERSIST-02 P1-3）：子代理
        // 运行中崩溃 → 行 status 残留 running；不归一则 FlowScheduler::load
        // 重建为 Running 节点，is_ready 要求 Pending → 永不重派发、流程
        // 永久卡死（flow_graph.rs:1473-1476）。与主 run 打断对称（kill_all
        // 语义）：running → failed + ended_at 落库。仅 LocalDb 路径可用
        // （as_local_db 下转；InMemoryStore 等测试替身无 session_agents 面，
        // 跳过——生产恒为 LocalDbStore）
        if let Some(db) = store.as_local_db() {
            let running_rows = db.load_running_session_agents().map_err(|e| {
                RestoreError::new("load_running_session_agents", e.to_string())
            })?;
            if !running_rows.is_empty() {
                let ended_at = now_ms();
                for (session_id, subagent_run_id) in &running_rows {
                    let affected = db
                        .update_session_agent_status(
                            session_id,
                            subagent_run_id,
                            "failed",
                            Some(ended_at),
                        )
                        .map_err(|e| {
                            RestoreError::new("normalize_session_agent", e.to_string())
                        })?;
                    if affected == 0 {
                        tracing::warn!(
                            target: "restore",
                            session_id,
                            subagent_run_id,
                            "归一目标行已消失，跳过"
                        );
                    } else {
                        tracing::info!(
                            target: "restore",
                            session_id,
                            subagent_run_id,
                            "session_agents running 行归一 failed（崩溃恢复）"
                        );
                    }
                }
            }
        }

        // 4. 会话记录组装（快照会话 ∪ run 派生会话）
        let mut sessions: Vec<SessionRecord> = snapshot
            .as_ref()
            .map(|snap| snap.sessions.clone())
            .unwrap_or_default();
        for run in &runs {
            if !sessions.iter().any(|s| s.session_id == run.session_id) {
                sessions.push(SessionRecord {
                    session_id: run.session_id.clone(),
                    current_leaf_id: None,
                    branches: Vec::new(),
                    // 新派生会话无压缩护栏（None）；其护栏经第 5 步事件重放
                    // 从 0 全量重建（快照会话则从快照 meta 续接增量）
                    context_meta: None,
                });
            }
        }

        // 5. 增量流：lastSequence 后事件重放（会话树叶子移动 + 压缩护栏
        //    重建）+ 锚点推进
        // P1-1：snapshot_session_ids 取**快照自身**会话集合（派生会话不在
        // 内 → 从 0 全量，不再被全局 max 误伤）
        let snapshot_session_ids: std::collections::HashSet<&str> = snapshot
            .as_ref()
            .map(|snap| {
                snap.sessions
                    .iter()
                    .map(|s| s.session_id.as_str())
                    .collect()
            })
            .unwrap_or_default();
        let base_sequence = snapshot.as_ref().map(|snap| snap.last_sequence).unwrap_or(0);
        let mut last_sequence = base_sequence;
        for session in &mut sessions {
            // P1-1：会话级 base = 该会话自身已重放的最大序列（快照逐会话
            // 锚点 session_last_sequence）——事件序列为会话内独立，全局
            // max 作会话级 base 会永久跳过落后会话的快照后事件；旧快照无
            // 逐会话锚点 → serde default 空表 → 回退全局 last_sequence
            // （兼容旧语义）；派生会话（快照后出现）从 0 全量
            let base = if snapshot_session_ids.contains(session.session_id.as_str()) {
                snapshot
                    .as_ref()
                    .and_then(|snap| {
                        snap.session_last_sequence.get(&session.session_id)
                    })
                    .copied()
                    .unwrap_or(base_sequence)
            } else {
                0
            };
            let events = store.query_events(&session.session_id, base).await?;
            for event in &events {
                last_sequence = last_sequence.max(event.sequence);
                if event.event_type == SESSION_LEAF_MOVED_EVENT {
                    // 叶子移动重放（载荷损坏时跳过，不中断恢复）
                    let _ = session.apply_leaf_move_event(&event.payload);
                } else if event.event_type == CONTEXT_COMPRESSION_END_EVENT {
                    // 压缩护栏重放（P4 阶段 5-1）：context-compression-end
                    // 事件折叠进会话上下文元数据——快照会话增量续接、
                    // 派生会话全量重建（事件时间戳不可解析时保持既有状态）
                    let _ = serde_json::from_str::<AgentEvent>(&event.payload).map(|e| {
                        if let AgentEvent::ContextCompressionEnd { timestamp, .. } = e {
                            session.apply_compression_end(event.sequence, &timestamp);
                        }
                    });
                }
            }
        }

        // 6. pending 输入恢复（FIFO：创建时间升序，含 id 决胜）
        let mut pending_inputs = Vec::new();
        for session in &sessions {
            pending_inputs.extend(store.load_pending_inputs(&session.session_id).await?);
        }

        Ok(RestoreOutcome {
            mode,
            sessions,
            runs,
            pending_inputs,
            interrupted,
            unknown_status_runs,
            last_sequence,
            snapshot_note,
            snapshot_generation: snapshot
                .as_ref()
                .map(|snap| snap.generation)
                .unwrap_or(0),
        })
    }
}

impl Default for RestoreManager {
    fn default() -> Self {
        Self::new()
    }
}

/// 是否 in-flight 状态（重启时需打断为 interrupted；05 §2.8:404；
/// 11-T4：completing 收口被打断 → failed，不再永久卡 completing；
/// 裁决 D3：Unknown 保真不打断——未知字面量无法区分中间态与终态，
/// 打断=改写对可能已完成的 run 是破坏性操作）
fn is_inflight(status: RunStatus) -> bool {
    match status {
        // 五态 + completing（11-T4）→ in-flight
        RunStatus::Queued
        | RunStatus::Initializing
        | RunStatus::Running
        | RunStatus::AwaitingApproval
        | RunStatus::Cancelling
        | RunStatus::Completing => true,
        // 未知字面量保真保留、不打断（裁决 D3，显式列出防默认臂误命中）
        RunStatus::Unknown(_) => false,
        // 终态不打断
        RunStatus::Completed | RunStatus::Failed | RunStatus::Cancelled => false,
    }
}

/// 会话内下一个可用序列号（恢复审计事件续接用）
async fn next_sequence(store: &dyn Store, session_id: &str) -> Result<u64, StoreError> {
    let events = store.query_events(session_id, 0).await?;
    Ok(events
        .iter()
        .map(|event| event.sequence)
        .max()
        .unwrap_or(0)
        + 1)
}

/// blocked 类终态 reason（B4.5 goal 语义：goal-blocked / goal-max-rounds /
/// goal-stalled）。
///
/// blocked 以 Failed 终态 + 上述 reason 落库，属终态记录；恢复时
/// 「原样保留不打断」由终态保真路径保证（本函数供审计/断言使用）。
pub fn is_blocked_reason(reason: Option<&str>) -> bool {
    matches!(
        reason,
        Some("goal-blocked") | Some("goal-max-rounds") | Some("goal-stalled")
    )
}

#[cfg(test)]
mod tests {
    // G2 禁令豁免：测试临时目录清理（非产品删除路径，可恢复语义不适用）。
    #![allow(clippy::disallowed_methods)]

    use std::sync::Arc;

    use conex_db::RunStatus;

    use super::*;
    use crate::persist::{InMemoryStore, LocalDbStore};
    use crate::session::{
        parse_iso8601_epoch_ms, SessionTree, session_leaf_moved_payload,
    };
    use conex_db::LocalDb;

    /// 内存 store 测试环境（具体句柄 + 共享 trait 对象）
    fn setup() -> (Arc<InMemoryStore>, Arc<dyn Store>) {
        let mem = Arc::new(InMemoryStore::new());
        let store: Arc<dyn Store> = mem.clone();
        (mem, store)
    }

    /// 无快照的恢复器（全量重放路径）
    struct NoSnapshots;

    impl SnapshotStore for NoSnapshots {
        fn load_snapshot(&self) -> Result<(Option<StateSnapshot>, Option<String>), SnapshotError> {
            Ok((None, None))
        }

        fn save_snapshot(&self, _snapshot: &StateSnapshot) -> Result<(), SnapshotError> {
            Ok(())
        }
    }

    /// 内存持有快照的恢复器（增量恢复路径）
    struct SnapshotHolder(Option<StateSnapshot>);

    impl SnapshotStore for SnapshotHolder {
        fn load_snapshot(&self) -> Result<(Option<StateSnapshot>, Option<String>), SnapshotError> {
            Ok((self.0.clone(), None))
        }

        fn save_snapshot(&self, _snapshot: &StateSnapshot) -> Result<(), SnapshotError> {
            Ok(())
        }
    }

    fn snapshot_store_holder(snapshot: &StateSnapshot) -> SnapshotHolder {
        SnapshotHolder(Some(snapshot.clone()))
    }

    /// 临时快照目录（测试后清理）
    fn temp_snapshot_store(name: &str) -> (SnapshotFileStore, PathBuf) {
        let dir = std::env::temp_dir().join(format!(
            "conex_orch_snapshot_{}_{}_{}",
            std::process::id(),
            name,
            crate::now_ms()
        ));
        let _ = std::fs::create_dir_all(&dir);
        let path = dir.join("snapshot.json");
        (SnapshotFileStore::new(path), dir)
    }

    fn pending(id: &str, session_id: &str, run_id: Option<&str>, created_at: i64) -> PendingInput {
        PendingInput {
            id: id.to_string(),
            session_id: session_id.to_string(),
            run_id: run_id.map(str::to_string),
            payload: format!(r#"{{"text":"{id}"}}"#),
            created_at,
        }
    }

    // ── in-flight → interrupted（previousStatus 审计） ──

    #[tokio::test]
    async fn restore_marks_in_flight_runs_interrupted_with_previous_status() {
        let (mem, store) = setup();
        // 六个 in-flight 状态（含 completing，11-T4）+ 一个终态（保真）
        for (run_id, status) in [
            ("r_queued", RunStatus::Queued),
            ("r_init", RunStatus::Initializing),
            ("r_running", RunStatus::Running),
            ("r_approval", RunStatus::AwaitingApproval),
            ("r_cancelling", RunStatus::Cancelling),
            ("r_completing", RunStatus::Completing),
            ("r_done", RunStatus::Completed),
        ] {
            store
                .insert_run(run_id, "s1", status, None, 0)
                .await
                .unwrap();
        }
        store
            .update_run_status("r_done", RunStatus::Completed, Some("stop"), None)
            .await
            .unwrap();

        let outcome = RestoreManager::new()
            .restore(store.as_ref(), &NoSnapshots)
            .await
            .unwrap();

        assert_eq!(outcome.mode, RestoreMode::FullReplay);
        // in-flight → interrupted（queued/init/running/approval/completing
        // → failed；cancelling → cancelled）
        let by_id: std::collections::HashMap<&str, &conex_db::StoredRun> = outcome
            .runs
            .iter()
            .map(|r| (r.run_id.as_str(), r))
            .collect();
        for id in ["r_queued", "r_init", "r_running", "r_approval", "r_completing"] {
            assert_eq!(by_id[id].status, RunStatus::Failed, "{id} → failed");
            assert_eq!(by_id[id].end_reason.as_deref(), Some(INTERRUPTED_REASON));
        }
        assert_eq!(by_id["r_cancelling"].status, RunStatus::Cancelled);
        assert_eq!(
            by_id["r_cancelling"].end_reason.as_deref(),
            Some(INTERRUPTED_REASON)
        );
        // 终态记录原样保留
        assert_eq!(by_id["r_done"].status, RunStatus::Completed);
        assert_eq!(by_id["r_done"].end_reason.as_deref(), Some("stop"));

        // 审计记录：previousStatus 可追溯，终态映射正确
        assert_eq!(outcome.interrupted.len(), 6);
        let prev: Vec<&str> = outcome
            .interrupted
            .iter()
            .map(|i| i.previous_status.as_str())
            .collect();
        assert_eq!(
            prev,
            vec![
                "queued",
                "initializing",
                "running",
                "awaiting-approval",
                "cancelling",
                "completing"
            ]
        );
        let statuses: Vec<&str> = outcome
            .interrupted
            .iter()
            .map(|i| i.status.as_str())
            .collect();
        assert_eq!(
            statuses,
            vec!["failed", "failed", "failed", "failed", "cancelled", "failed"],
            "cancelling → cancelled，其余（含 completing）→ failed"
        );
        assert!(outcome
            .interrupted
            .iter()
            .all(|i| i.reason == INTERRUPTED_REASON));

        // 审计事件落库（run-interrupted，previousStatus 字段）
        let events = mem.events();
        let audit: Vec<&str> = events
            .iter()
            .filter(|e| e.event_type == RUN_INTERRUPTED_EVENT)
            .map(|e| e.event_type.as_str())
            .collect();
        assert_eq!(audit.len(), 6, "每个被打断的 run 一条审计事件");
        // T08.4：打断路径 cursor = 审计事件前会话最大已落库序列（逐条递增）
        assert_eq!(by_id["r_queued"].cursor, 0, "首个打断前无事件");
        assert_eq!(by_id["r_init"].cursor, 1);
        assert_eq!(by_id["r_running"].cursor, 2);
        assert_eq!(by_id["r_approval"].cursor, 3);
        assert_eq!(by_id["r_cancelling"].cursor, 4, "取消打断前会话最大序列=4");
        assert_eq!(by_id["r_completing"].cursor, 5, "completing 打断前会话最大序列=5");
        // 审计事件序列连续 1..=6（与 cursor 口径一致）
        let audit_seqs: Vec<u64> = events
            .iter()
            .filter(|e| e.event_type == RUN_INTERRUPTED_EVENT)
            .map(|e| e.sequence)
            .collect();
        assert_eq!(audit_seqs, vec![1, 2, 3, 4, 5, 6]);
        let payload = &events[0].payload;
        let value: serde_json::Value = serde_json::from_str(payload).unwrap();
        assert_eq!(value["previousStatus"], "queued");
        assert_eq!(value["reason"], "daemon-restarted");
        assert_eq!(value["status"], "failed");
    }

    // ── blocked 终态保真 / 终态记录原样保留 ──

    /// 11-T1（N04，裁决 D3）：未知状态字面量恢复保真——不打断（无
    /// run-interrupted 事件）、不改写（as_str 原样）、RestoreOutcome
    /// 显式上报（unknown_status_runs 含 run_id + 原字面量）。
    #[tokio::test]
    async fn restore_preserves_unknown_status_runs_with_reporting() {
        let (mem, store) = setup();
        // 未知字面量 run + 对照：终态 run（保真不打断）+ in-flight run（正常打断）
        store
            .insert_run("r_unknown", "s1", RunStatus::Unknown("sneaky".into()), None, 0)
            .await
            .unwrap();
        store
            .insert_run("r_done", "s1", RunStatus::Completed, Some("stop"), 0)
            .await
            .unwrap();
        store
            .insert_run("r_running", "s1", RunStatus::Running, None, 0)
            .await
            .unwrap();

        let outcome = RestoreManager::new()
            .restore(store.as_ref(), &NoSnapshots)
            .await
            .unwrap();

        // 未知 run：原样保留（保真），as_str 往返一致
        let by_id: std::collections::HashMap<&str, &conex_db::StoredRun> = outcome
            .runs
            .iter()
            .map(|r| (r.run_id.as_str(), r))
            .collect();
        assert_eq!(
            by_id["r_unknown"].status,
            RunStatus::Unknown("sneaky".to_string()),
            "未知字面量透传保真"
        );
        assert_eq!(by_id["r_unknown"].status.as_str(), "sneaky");
        assert_eq!(by_id["r_unknown"].end_reason, None, "未知 run 不被改写");
        // 显式上报：run_id + 原字面量（诚实滞留）
        assert_eq!(
            outcome.unknown_status_runs,
            vec![("r_unknown".to_string(), "sneaky".to_string())]
        );
        // 不打断：未知 run 不在 interrupted 审计中；终态 run 亦不受影响
        assert_eq!(outcome.interrupted.len(), 1, "仅 in-flight run 被打断");
        assert_eq!(outcome.interrupted[0].run_id, "r_running");
        // 事件表无未知 run 的 run-interrupted 审计事件（仅 in-flight 一条）
        let events = mem.events();
        let audit: Vec<&str> = events
            .iter()
            .filter(|e| e.event_type == RUN_INTERRUPTED_EVENT)
            .map(|e| e.event_type.as_str())
            .collect();
        assert_eq!(audit.len(), 1);
        // 终态保真不受影响
        assert_eq!(by_id["r_done"].status, RunStatus::Completed);
    }

    #[tokio::test]
    async fn restore_preserves_blocked_and_terminal_records() {
        let (mem, store) = setup();
        // blocked：Failed 终态 + goal-blocked reason（B4.5 语义）
        store
            .insert_run("r_blocked", "s1", RunStatus::Failed, Some("goal-blocked"), 10)
            .await
            .unwrap();
        // 其它终态：completed / failed / cancelled
        store
            .insert_run("r_completed", "s1", RunStatus::Completed, Some("stop"), 20)
            .await
            .unwrap();
        store
            .insert_run("r_failed", "s1", RunStatus::Failed, Some("error"), 30)
            .await
            .unwrap();
        store
            .insert_run("r_cancelled", "s1", RunStatus::Cancelled, Some("aborted"), 40)
            .await
            .unwrap();

        let outcome = RestoreManager::new()
            .restore(store.as_ref(), &NoSnapshots)
            .await
            .unwrap();

        // blocked 类状态原样保留不打断
        assert!(outcome.interrupted.is_empty(), "终态记录不被打断");
        let by_id: std::collections::HashMap<&str, &conex_db::StoredRun> = outcome
            .runs
            .iter()
            .map(|r| (r.run_id.as_str(), r))
            .collect();
        assert_eq!(by_id["r_blocked"].status, RunStatus::Failed);
        assert_eq!(by_id["r_blocked"].end_reason.as_deref(), Some("goal-blocked"));
        assert!(is_blocked_reason(by_id["r_blocked"].end_reason.as_deref()));
        assert_eq!(by_id["r_completed"].status, RunStatus::Completed);
        assert_eq!(by_id["r_completed"].end_reason.as_deref(), Some("stop"));
        assert_eq!(by_id["r_failed"].status, RunStatus::Failed);
        assert_eq!(by_id["r_failed"].end_reason.as_deref(), Some("error"));
        assert_eq!(by_id["r_cancelled"].status, RunStatus::Cancelled);
        assert_eq!(by_id["r_cancelled"].end_reason.as_deref(), Some("aborted"));
        // 终态记录不产生审计事件
        assert!(mem.events().is_empty(), "终态保真不追加审计事件");
    }

    // ── pending 输入 FIFO 恢复 ──

    #[tokio::test]
    async fn restore_replays_pending_inputs_in_fifo_order() {
        let (mem, store) = setup();
        store.insert_run("r1", "s1", RunStatus::Running, None, 0).await.unwrap();
        store
            .insert_run("r2", "s2", RunStatus::Completed, Some("stop"), 0)
            .await
            .unwrap();
        // 会话 s1：乱序注入（p3 创建时间最早）；s2 一条
        mem.seed_pending_inputs(vec![
            pending("p3", "s1", Some("r1"), 300),
            pending("p1", "s1", None, 100),
            pending("p2", "s1", Some("r1"), 200),
            pending("q1", "s2", None, 50),
        ]);

        let outcome = RestoreManager::new()
            .restore(store.as_ref(), &NoSnapshots)
            .await
            .unwrap();

        // FIFO：创建时间升序（p1 → p2 → p3）
        let ids: Vec<&str> = outcome.pending_inputs.iter().map(|p| p.id.as_str()).collect();
        assert_eq!(ids, vec!["p1", "p2", "p3", "q1"]);
        // run_id 保真（None 表示 after-current-run 模式）
        let p1 = &outcome.pending_inputs[0];
        assert!(p1.run_id.is_none());
        let p2 = &outcome.pending_inputs[1];
        assert_eq!(p2.run_id.as_deref(), Some("r1"));
        assert!(p2.payload.contains("p2"));
    }

    // ── 快照：全量 / 增量 / 损坏回退 ──

    #[tokio::test]
    async fn snapshot_full_roundtrip_and_incremental_restore() {
        let (_mem, store) = setup();
        // 构造会话树 + run
        let mut tree = SessionTree::new("s1");
        tree.append("root", serde_json::json!({})).unwrap();
        tree.append("leaf", serde_json::json!({})).unwrap();
        let mut sessions = vec![tree.to_session_record()];
        sessions[0].current_leaf_id = Some("root".to_string());
        let runs = vec![conex_db::StoredRun {
            run_id: "r_snap".to_string(),
            session_id: "s1".to_string(),
            status: RunStatus::Completed,
            end_reason: Some("stop".to_string()),
            cursor: 1,
            created_at: 100,
            updated_at: 200,
        }];
        // run 表为权威数据源：快照之外还需落库（快照 runs 为冷启动旁路信息）
        store
            .insert_run("r_snap", "s1", RunStatus::Completed, Some("stop"), 1)
            .await
            .unwrap();
        // 11-T1：快照含未知字面量不再拒绝加载（fail-open 保真）——
        // 存（StoredRun → SnapshotRun）→ 读（to_stored_run）往返 as_str 原样
        let unknown_snapshot_run = SnapshotRun {
            run_id: "r_unknown_snap".to_string(),
            session_id: "s1".to_string(),
            status: "sneaky".to_string(),
            end_reason: None,
            cursor: 0,
            created_at: 100,
            updated_at: 200,
        };
        let back = unknown_snapshot_run.to_stored_run().unwrap();
        assert_eq!(
            back.status,
            RunStatus::Unknown("sneaky".to_string()),
            "快照未知字面量透传为 Unknown"
        );
        assert_eq!(back.status.as_str(), "sneaky", "快照往返 as_str 原样");
        // 已知字面量快照仍正常解析
        assert_eq!(
            SnapshotRun {
                status: "completing".to_string(),
                ..unknown_snapshot_run
            }
            .to_stored_run()
            .unwrap()
            .status,
            RunStatus::Completing
        );
        let snapshot = StateSnapshot::build(1, 0, sessions, runs, Vec::new(), HashMap::new());
        assert!(snapshot.valid(), "构造的快照应通过 checksum 校验");

        // 快照后追加的叶子移动事件（模拟快照后崩溃）
        store
            .append_event(
                "s1",
                1,
                SESSION_LEAF_MOVED_EVENT,
                &session_leaf_moved_payload("leaf_after"),
            )
            .await
            .unwrap();

        // 增量恢复：快照 + lastSequence 后事件流
        let outcome = RestoreManager::new()
            .restore(store.as_ref(), &snapshot_store_holder(&snapshot))
            .await
            .unwrap();

        assert_eq!(outcome.mode, RestoreMode::SnapshotIncremental);
        assert_eq!(outcome.last_sequence, 1, "lastSequence 锚点推进到增量事件");
        // 增量流重放：叶子移动事件更新会话树
        assert_eq!(
            outcome.sessions[0].current_leaf_id.as_deref(),
            Some("leaf_after")
        );
        assert_eq!(outcome.sessions[0].branches.len(), 2, "快照会话树保留");
        assert_eq!(outcome.runs[0].status, RunStatus::Completed);
    }

    /// T3.5 D5 补充用例（F2-39）：同一进程（同 pid）并发 save_snapshot——
    /// tmp 文件名带 generation 唯一化后，主快照始终是某次完整写入的产物
    /// （存在且校验和通过）；旧实现 `{path}.{pid}.tmp` 同进程同名，并发
    /// 保存交叉写同一 tmp + 轮转 remove/rename 互扰，主快照可损坏/缺失
    /// （R2 §4）。并发竞态下个别保存可能因轮转 rename 碰撞返回 Err（允许），
    /// 断言面是「主快照文件完整可校验」而非「全部保存成功」。
    #[test]
    fn concurrent_snapshot_saves_keep_main_file_intact() {
        let (store_file, dir) = temp_snapshot_store("concurrent");
        let store: Arc<dyn SnapshotStore> = Arc::new(store_file);
        let barrier = Arc::new(std::sync::Barrier::new(4));
        let mut handles = Vec::new();
        for thread in 0..4usize {
            let store = Arc::clone(&store);
            let barrier = Arc::clone(&barrier);
            handles.push(std::thread::spawn(move || {
                barrier.wait();
                for round in 0..8 {
                    let generation = (thread * 8 + round + 1) as u64;
                    let snapshot = StateSnapshot::build(
                        generation,
                        generation,
                        Vec::new(),
                        Vec::new(),
                        Vec::new(),
                        HashMap::new(),
                    );
                    let _ = store.save_snapshot(&snapshot);
                }
            }));
        }
        for handle in handles {
            handle.join().unwrap();
        }
        let main_path = dir.join("snapshot.json");
        let raw = std::fs::read_to_string(&main_path)
            .unwrap_or_else(|err| panic!("主快照必须存在（并发保存不得丢失主文件）：{err}"));
        let snapshot: StateSnapshot = serde_json::from_str(&raw)
            .unwrap_or_else(|err| panic!("主快照必须可解析：{err}"));
        assert!(snapshot.valid(), "主快照校验和必须通过（无交叉写混合内容）");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn snapshot_corrupt_falls_back_to_previous_intact_snapshot() {
        let (store_file, dir) = temp_snapshot_store("fallback");
        let snapshots: Arc<dyn SnapshotStore> = Arc::new(store_file);
        let (_mem, store) = setup();
        store
            .insert_run("r1", "s1", RunStatus::Running, None, 0)
            .await
            .unwrap();

        // 第一次保存（v1）→ 主快照；第二次保存（v2）→ v1 轮转为备份
        let v1 = StateSnapshot::build(
            1,
            0,
            vec![SessionRecord {
                session_id: "s1".to_string(),
                current_leaf_id: Some("leaf_v1".to_string()),
                branches: vec![],
                context_meta: None,
            }],
            Vec::new(),
            Vec::new(),
            HashMap::new(),
        );
        snapshots.save_snapshot(&v1).unwrap();
        let v2 = StateSnapshot::build(
            2,
            5,
            vec![SessionRecord {
                session_id: "s1".to_string(),
                current_leaf_id: Some("leaf_v2".to_string()),
                branches: vec![],
                context_meta: None,
            }],
            Vec::new(),
            Vec::new(),
            HashMap::new(),
        );
        snapshots.save_snapshot(&v2).unwrap();

        // 损坏主快照（改写内容，checksum 必失效）
        let main_path = dir.join("snapshot.json");
        let raw = std::fs::read_to_string(&main_path).unwrap();
        let corrupted = raw.replace("leaf_v2", "leaf_v2_X");
        std::fs::write(&main_path, corrupted).unwrap();

        let outcome = RestoreManager::new()
            .restore(store.as_ref(), snapshots.as_ref())
            .await
            .unwrap();

        // 回退到上一完好快照（v1）
        assert_eq!(outcome.mode, RestoreMode::SnapshotIncremental);
        let note = outcome.snapshot_note.as_deref().unwrap_or_default();
        assert!(note.contains("回退"), "应有回退说明：{note}");
        assert_eq!(
            outcome.sessions[0].current_leaf_id.as_deref(),
            Some("leaf_v1"),
            "回退后使用上一完好快照（v1）"
        );
        // v1 的 lastSequence = 0，恢复时被打断 run 的审计事件推进锚点到 1
        assert_eq!(outcome.last_sequence, 1, "审计事件后锚点推进");
        // 被打断的 run 仍被标记 interrupted（in-flight → failed）
        assert_eq!(outcome.runs[0].status, RunStatus::Failed);
        assert_eq!(outcome.interrupted.len(), 1);

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn snapshot_corrupt_without_backup_falls_back_to_full_replay() {
        let (store_file, dir) = temp_snapshot_store("corrupt");
        let snapshots: Arc<dyn SnapshotStore> = Arc::new(store_file);
        let (_mem, store) = setup();
        store
            .insert_run("r1", "s1", RunStatus::Queued, None, 0)
            .await
            .unwrap();

        // 只保存一次（无备份），随后主快照彻底损坏（非法 JSON）
        let v1 = StateSnapshot::build(
            1,
            0,
            vec![SessionRecord {
                session_id: "s1".to_string(),
                current_leaf_id: None,
                branches: vec![],
                context_meta: None,
            }],
            Vec::new(),
            Vec::new(),
            HashMap::new(),
        );
        snapshots.save_snapshot(&v1).unwrap();
        std::fs::write(dir.join("snapshot.json"), r#"{"type":"nope"}"#).unwrap();

        let outcome = RestoreManager::new()
            .restore(store.as_ref(), snapshots.as_ref())
            .await
            .unwrap();

        // 无备份可用 → 全量重放（runs 仍从 store 恢复，in-flight 打断）
        assert_eq!(outcome.mode, RestoreMode::FullReplay);
        let note = outcome.snapshot_note.as_deref().unwrap_or_default();
        assert!(note.contains("全量重放"), "应有全量重放说明：{note}");
        assert_eq!(outcome.runs.len(), 1);
        assert_eq!(outcome.runs[0].status, RunStatus::Failed);
        assert_eq!(outcome.runs[0].end_reason.as_deref(), Some(INTERRUPTED_REASON));
        assert_eq!(outcome.interrupted.len(), 1);
        assert_eq!(outcome.interrupted[0].previous_status, "queued");

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn snapshot_full_replay_without_snapshot_derives_sessions_from_runs() {
        let (_mem, store) = setup();
        store
            .insert_run("r1", "s1", RunStatus::Completed, Some("stop"), 0)
            .await
            .unwrap();
        store
            .insert_run("r2", "s2", RunStatus::Cancelled, Some("aborted"), 0)
            .await
            .unwrap();

        let outcome = RestoreManager::new()
            .restore(store.as_ref(), &NoSnapshots)
            .await
            .unwrap();

        assert_eq!(outcome.mode, RestoreMode::FullReplay);
        let session_ids: Vec<&str> = outcome
            .sessions
            .iter()
            .map(|s| s.session_id.as_str())
            .collect();
        assert_eq!(session_ids, vec!["s1", "s2"], "会话从 run 记录派生");
        assert!(outcome.interrupted.is_empty());
        assert_eq!(outcome.last_sequence, 0);
    }

    // ── LocalDb（SQLite 生产路径）roundtrip ──

    #[tokio::test]
    async fn local_db_store_query_runs_and_pending_inputs() {
        let db = LocalDb::open_in_memory().unwrap();
        // v4 起 runs/pending 带 FK：先建会话（T08.7 语义）
        db.insert_session("s1", "s1").unwrap();
        db.insert_session("s2", "s2").unwrap();
        let store = LocalDbStore::new(db);
        store
            .insert_run("r1", "s1", RunStatus::Running, None, 0)
            .await
            .unwrap();
        store
            .insert_run("r2", "s2", RunStatus::Completed, Some("stop"), 5)
            .await
            .unwrap();
        store
            .save_pending_input("p1", "s1", Some("r1"), r#"{"text":"hi"}"#)
            .await
            .unwrap();
        store
            .save_pending_input("p2", "s1", None, r#"{"text":"follow-up"}"#)
            .await
            .unwrap();

        let runs = store.query_runs().await.unwrap();
        assert_eq!(runs.len(), 2);
        assert_eq!(runs[1].end_reason.as_deref(), Some("stop"));

        let inputs = store.load_pending_inputs("s1").await.unwrap();
        assert_eq!(inputs.len(), 2, "FIFO 顺序");
        assert_eq!(inputs[0].id, "p1");
        assert_eq!(inputs[1].run_id, None);
        assert!(store.delete_pending_input("p1").await.unwrap());
        assert_eq!(store.load_pending_inputs("s1").await.unwrap().len(), 1);
    }

    // ── T08.8 Q24：恢复后新 run 的 sequence 续接（不重置） ──

    fn ts() -> String {
        crate::now_iso_utc()
    }

    fn agent_start(session_id: &str) -> conex_types::events::AgentEvent {
        conex_types::events::AgentEvent::AgentStart {
            session_id: session_id.to_string(),
            timestamp: ts(),
        }
    }

    fn agent_end(session_id: &str, reason: conex_types::session::AgentEndReason) -> conex_types::events::AgentEvent {
        conex_types::events::AgentEvent::AgentEnd {
            session_id: session_id.to_string(),
            timestamp: ts(),
            reason,
            error: None,
        }
    }

    fn run_outcome(
        reason: conex_types::session::AgentEndReason,
        events: Vec<conex_types::events::AgentEvent>,
    ) -> session_loop::RunOutcome {
        session_loop::RunOutcome {
            reason,
            error: None,
            diagnostic: None,
            messages: Vec::new(),
            events,
            turn_index: 0,
            tool_call_count: 0,
            steering_count: 0,
            // T-36：缓存统计字段（本构造点无样本 → None，缺省向后兼容）
            cache_stats: None,
        }
    }

    /// T08.8 关键验收：R1 跑至 seq=5 → 恢复（审计事件 seq=6，cursor 回填 5）
    /// → seed 预热 → R2 首事件 = 7（恢复后 max+1，不等于 1）→ 全事件连续
    /// 无冲突（Q24）
    #[tokio::test]
    async fn restore_then_new_run_continues_sequence_without_conflict() {
        use crate::events::{EventQueue, drive_outcome};
        use crate::persist::SessionSequencer;
        use crate::run::RunManager;
        use conex_types::events::RunTerminalStatus;
        use conex_types::session::AgentEndReason;

        let (mem, store) = setup();
        // R1 历史事件 1..=5（模拟崩溃前已落库）
        for seq in 1..=5 {
            store
                .append_event("s1", seq, "agent-start", "{}")
                .await
                .unwrap();
        }
        store
            .insert_run("r1", "s1", RunStatus::Running, None, 5)
            .await
            .unwrap();

        // 恢复：R1 → interrupted，审计事件 seq=6，cursor 回填 5（T08.4）
        let outcome = RestoreManager::new()
            .restore(store.as_ref(), &NoSnapshots)
            .await
            .unwrap();
        assert_eq!(outcome.interrupted.len(), 1);
        assert_eq!(outcome.runs[0].status, RunStatus::Failed);
        assert_eq!(outcome.runs[0].cursor, 5, "打断路径 cursor 回填（T08.4）");

        // seed 预热（生产由 CoreRunState::seed_sequences 执行：按库内
        // max+1 对齐，审计事件已落库口径自然含之——T08.8）
        SessionSequencer::new(store.clone())
            .seed("s1", 7)
            .await
            .unwrap();

        // R2：首事件 sequence == 7（恢复后 max+1，不等于 1），无冲突
        let manager = RunManager::new(store.clone());
        let mut run = manager.start_run("s1", "r2").await.unwrap();
        let mut queue = EventQueue::new(store.clone(), run.cursor + 1);
        let result = drive_outcome(
            &mut run,
            &mut queue,
            run_outcome(
                AgentEndReason::Stop,
                vec![agent_start("s1"), agent_end("s1", AgentEndReason::Stop)],
            ),
        )
        .await
        .unwrap();

        let seqs: Vec<u64> = result.events.iter().map(|e| e.sequence).collect();
        assert_eq!(seqs.first(), Some(&7), "R2 首个事件 = 恢复后 max+1（不等于 1）");
        assert_eq!(result.terminal_status, RunTerminalStatus::Completed);
        assert!(result.persist_failure.is_none(), "无 UNIQUE 冲突");
        // 全事件唯一连续 1..=9（5 条历史 + 1 条审计 + 3 条 R2）
        let stored = mem.events();
        let mut all: Vec<u64> = stored.iter().map(|e| e.sequence).collect();
        all.sort_unstable();
        assert_eq!(all, (1..=9).collect::<Vec<_>>(), "恢复后全事件连续无冲突（Q24）");
    }

    // ── T-34：会话上下文元数据护栏持久化（P4 阶段 5-1） ──

    /// 压缩结束事件构造（context-compression-end 落库载荷；与
    /// session-loop 的 apply_compaction 事件形态同构）
    fn compression_end_event(session_id: &str, timestamp: &str) -> AgentEvent {
        AgentEvent::ContextCompressionEnd {
            session_id: session_id.to_string(),
            timestamp: timestamp.to_string(),
            result: Some(conex_types::tool::ContextCompressionRecord {
                id: "compaction-1".to_string(),
                trigger: conex_types::tool::ContextCompressionTrigger::Overflow,
                reason: None,
                policy: None,
                summary: "[Compacted 8 earlier message(s) to fit context window]".to_string(),
                first_kept_message_id: None,
                compressed_message_ids: Vec::new(),
                kept_message_ids: Vec::new(),
                tokens_before: 50_000,
                tokens_after: 9_000,
                threshold_tokens: None,
                created_at: timestamp.to_string(),
                handoff: None,
                cache_boundary: None,
                details: None,
            }),
            aborted: false,
            error: None,
        }
    }

    /// 全量重放路径：无快照时从事件流重放 context-compression-end 事件，
    /// 重建会话压缩护栏（last_compaction_at / sequence / generation /
    /// compression_retries）——restore 时护栏状态跨重启不丢（P4 阶段 5-1）
    #[tokio::test]
    async fn restore_replays_compression_events_to_rebuild_session_guards() {
        let (_mem, store) = setup();
        // 两条压缩事件（模拟压缩发生两次：generation 应累计到 2）
        store
            .append_event(
                "s1",
                1,
                CONTEXT_COMPRESSION_END_EVENT,
                &serde_json::to_string(&compression_end_event(
                    "s1",
                    "2026-08-03T10:00:00.000Z",
                ))
                .unwrap(),
            )
            .await
            .unwrap();
        store
            .append_event(
                "s1",
                2,
                CONTEXT_COMPRESSION_END_EVENT,
                &serde_json::to_string(&compression_end_event(
                    "s1",
                    "2026-08-03T11:30:00.500Z",
                ))
                .unwrap(),
            )
            .await
            .unwrap();
        store
            .insert_run("r1", "s1", RunStatus::Completed, Some("stop"), 2)
            .await
            .unwrap();

        let outcome = RestoreManager::new()
            .restore(store.as_ref(), &NoSnapshots)
            .await
            .unwrap();

        let session = outcome
            .sessions
            .iter()
            .find(|s| s.session_id == "s1")
            .expect("会话必须恢复");
        let meta = session
            .context_meta()
            .expect("压缩事件重放后必须有上下文元数据");
        // 时间戳护栏 = 最近一次压缩边界（epoch ms）
        let expected_boundary = parse_iso8601_epoch_ms("2026-08-03T11:30:00.500Z").unwrap();
        assert_eq!(meta.last_compaction_at, Some(expected_boundary));
        assert_eq!(meta.last_compaction_sequence, Some(2), "审计锚点 = 最近压缩事件序列");
        assert_eq!(
            meta.last_compaction_generation,
            Some(2),
            "压缩代数按事件逐条累计（C13 基线重置锚点）"
        );
        assert_eq!(meta.compression_retries, 0, "压缩后重试计数归零");
    }

    /// 快照增量路径：快照携带 context_meta + 快照后新增压缩事件 →
    /// 恢复从快照 meta 续接增量（不重复累计快照已含的代数）
    #[tokio::test]
    async fn snapshot_context_meta_survives_and_continues_incrementally() {
        let (_mem, store) = setup();
        let mut record = SessionRecord {
            session_id: "s1".to_string(),
            current_leaf_id: None,
            branches: Vec::new(),
            context_meta: Some(conex_types::context::SessionContextMeta {
                last_compaction_at: Some(parse_iso8601_epoch_ms("2026-08-03T09:00:00.000Z").unwrap()),
                last_compaction_sequence: Some(3),
                last_compaction_generation: Some(1),
                compression_retries: 0,
            }),
        };
        record.current_leaf_id = Some("root".to_string());
        let snapshot = StateSnapshot::build(1, 3, vec![record], Vec::new(), Vec::new(), HashMap::new());
        assert!(snapshot.valid(), "带 context_meta 的快照应通过 checksum 校验");
        // 快照后（sequence 4）新增一条压缩事件
        store
            .append_event(
                "s1",
                4,
                CONTEXT_COMPRESSION_END_EVENT,
                &serde_json::to_string(&compression_end_event(
                    "s1",
                    "2026-08-03T12:00:00.000Z",
                ))
                .unwrap(),
            )
            .await
            .unwrap();
        store
            .insert_run("r1", "s1", RunStatus::Completed, Some("stop"), 4)
            .await
            .unwrap();

        let outcome = RestoreManager::new()
            .restore(store.as_ref(), &snapshot_store_holder(&snapshot))
            .await
            .unwrap();

        assert_eq!(outcome.mode, RestoreMode::SnapshotIncremental);
        let session = outcome
            .sessions
            .iter()
            .find(|s| s.session_id == "s1")
            .expect("会话必须恢复");
        let meta = session.context_meta().expect("快照 meta 必须保留");
        // 快照 meta 续接增量：边界推进到快照后事件，代数 1 → 2（不重复累计）
        assert_eq!(
            meta.last_compaction_at,
            Some(parse_iso8601_epoch_ms("2026-08-03T12:00:00.000Z").unwrap())
        );
        assert_eq!(meta.last_compaction_sequence, Some(4));
        assert_eq!(meta.last_compaction_generation, Some(2));
    }

    /// 损坏载荷容错：压缩事件时间戳不可解析 / 载荷非压缩事件 → 保持既有
    /// 护栏状态，不写坏、不中断恢复（与叶子移动重放的容错语义一致）
    #[tokio::test]
    async fn restore_ignores_corrupt_compression_event_payloads() {
        let (_mem, store) = setup();
        // 载荷损坏（非法 JSON）与时间戳损坏（非法时间串）各一条
        store
            .append_event("s1", 1, CONTEXT_COMPRESSION_END_EVENT, "{not-json")
            .await
            .unwrap();
        store
            .append_event(
                "s1",
                2,
                CONTEXT_COMPRESSION_END_EVENT,
                &serde_json::to_string(&compression_end_event("s1", "not-a-timestamp")).unwrap(),
            )
            .await
            .unwrap();
        store
            .insert_run("r1", "s1", RunStatus::Completed, Some("stop"), 2)
            .await
            .unwrap();

        let outcome = RestoreManager::new()
            .restore(store.as_ref(), &NoSnapshots)
            .await
            .unwrap();
        let session = outcome
            .sessions
            .iter()
            .find(|s| s.session_id == "s1")
            .expect("会话必须恢复");
        assert!(
            session.context_meta().is_none(),
            "损坏载荷不得写入护栏状态（保持 None）"
        );
    }

    // ── PERSIST-02 P1-1：增量重放锚点修复（多会话） ──

    /// 快照记录辅助：构造带指定会话的 SessionRecord
    fn snap_session(session_id: &str, leaf: Option<&str>) -> SessionRecord {
        SessionRecord {
            session_id: session_id.to_string(),
            current_leaf_id: leaf.map(str::to_string),
            branches: Vec::new(),
            context_meta: None,
        }
    }

    /// P1-1 核心场景：会话 A 序列领先（快照 max=100）、会话 B 落后
    /// （B=30）；快照后 B 追加 leaf-move（seq 31-32）→ 恢复必须按 B 的
    /// **自身锚点 30** 重放，而非全局 max 100（旧实现永久跳过）。
    /// 同时断言边界：seq 30（≤ 锚点）的事件不得重放。
    #[tokio::test]
    async fn restore_multi_session_incremental_replays_each_session_from_own_anchor() {
        let (_mem, store) = setup();
        let mut anchors = HashMap::new();
        anchors.insert("A".to_string(), 100u64);
        anchors.insert("B".to_string(), 30u64);
        let snapshot = StateSnapshot::build(
            1,
            100,
            vec![
                snap_session("A", Some("leaf_a1")),
                snap_session("B", Some("leaf_b1")),
            ],
            Vec::new(),
            Vec::new(),
            anchors,
        );
        // 快照后事件：A 追加 1 条（seq 101）；B 追加 2 条（seq 31、32）；
        // 另在 B 的锚点内（seq 30）放一条「不应重放」的叶子事件
        store
            .append_event("A", 101, SESSION_LEAF_MOVED_EVENT, &session_leaf_moved_payload("leaf_a2"))
            .await
            .unwrap();
        store
            .append_event("B", 30, SESSION_LEAF_MOVED_EVENT, &session_leaf_moved_payload("leaf_b_wrong"))
            .await
            .unwrap();
        store
            .append_event("B", 31, SESSION_LEAF_MOVED_EVENT, &session_leaf_moved_payload("leaf_b2"))
            .await
            .unwrap();
        store
            .append_event("B", 32, SESSION_LEAF_MOVED_EVENT, &session_leaf_moved_payload("leaf_b3"))
            .await
            .unwrap();

        let outcome = RestoreManager::new()
            .restore(store.as_ref(), &snapshot_store_holder(&snapshot))
            .await
            .unwrap();

        assert_eq!(outcome.mode, RestoreMode::SnapshotIncremental);
        // A 从自身锚点 100 增量重放
        let a = outcome.sessions.iter().find(|s| s.session_id == "A").unwrap();
        assert_eq!(a.current_leaf_id.as_deref(), Some("leaf_a2"), "A 增量重放");
        // B 从自身锚点 30 增量重放（seq 31、32 生效，seq 30 被锚点排除）
        let b = outcome.sessions.iter().find(|s| s.session_id == "B").unwrap();
        assert_eq!(
            b.current_leaf_id.as_deref(),
            Some("leaf_b3"),
            "B 按自身锚点 30 增量重放（旧实现全局 max=100 会永久跳过）"
        );
        // 全局锚点推进到真实 max
        assert_eq!(outcome.last_sequence, 101);
    }

    /// P1-1 第二缺陷：snapshot_session_ids 必须取**快照自身**会话集合。
    /// 快照后新建的派生会话（仅 runs 表可见）其历史事件全在全局 max
    /// 之前——旧实现命中全局 base 被全部跳过；修复后从 0 全量重放。
    #[tokio::test]
    async fn restore_derived_session_replays_full_history_before_global_max() {
        let (_mem, store) = setup();
        let mut anchors = HashMap::new();
        anchors.insert("A".to_string(), 100u64);
        let snapshot = StateSnapshot::build(
            1,
            100,
            vec![snap_session("A", Some("leaf_a1"))],
            Vec::new(),
            Vec::new(),
            anchors,
        );
        // 派生会话 C（快照后出现，runs 表可见）：历史事件 seq 1..=5 全在
        // 全局 max 100 之前
        store
            .insert_run("r_c", "C", RunStatus::Completed, Some("stop"), 0)
            .await
            .unwrap();
        for seq in 1..=5 {
            store
                .append_event(
                    "C",
                    seq,
                    SESSION_LEAF_MOVED_EVENT,
                    &session_leaf_moved_payload(&format!("leaf_c{seq}")),
                )
                .await
                .unwrap();
        }

        let outcome = RestoreManager::new()
            .restore(store.as_ref(), &snapshot_store_holder(&snapshot))
            .await
            .unwrap();

        let c = outcome.sessions.iter().find(|s| s.session_id == "C").unwrap();
        assert_eq!(
            c.current_leaf_id.as_deref(),
            Some("leaf_c5"),
            "派生会话从 0 全量重放（不被全局 max 误伤）"
        );
        assert_eq!(outcome.last_sequence, 100, "全局锚点取 max（100 > C 的 5）");
    }

    /// 旧快照兼容：无 session_last_sequence（serde default 空表）→ 会话级
    /// base 回退全局 last_sequence（旧语义，无更优锚点可用）
    #[tokio::test]
    async fn restore_legacy_snapshot_without_session_anchors_falls_back_to_global_max() {
        let (_mem, store) = setup();
        let snapshot = StateSnapshot::build(
            1,
            100,
            vec![
                snap_session("A", Some("leaf_a1")),
                snap_session("B", Some("leaf_b1")),
            ],
            Vec::new(),
            Vec::new(),
            HashMap::new(),
        );
        store
            .append_event("B", 31, SESSION_LEAF_MOVED_EVENT, &session_leaf_moved_payload("leaf_b_after"))
            .await
            .unwrap();

        let outcome = RestoreManager::new()
            .restore(store.as_ref(), &snapshot_store_holder(&snapshot))
            .await
            .unwrap();

        let b = outcome.sessions.iter().find(|s| s.session_id == "B").unwrap();
        assert_eq!(
            b.current_leaf_id.as_deref(),
            Some("leaf_b1"),
            "旧快照回退全局锚点 100（B 的 seq 31 不重放——兼容语义）"
        );
    }

    /// P1-1 对压缩护栏续接的影响：会话 B 落后于全局 max，快照后新增
    /// 压缩事件（seq 31）必须按 B 自身锚点 30 重放、代数续接 1→2；
    /// 旧实现（全局 base 100）会跳过 → 护栏永久落后
    #[tokio::test]
    async fn restore_multi_session_compression_guard_continues_from_own_anchor() {
        let (_mem, store) = setup();
        let mut anchors = HashMap::new();
        anchors.insert("A".to_string(), 100u64);
        anchors.insert("B".to_string(), 30u64);
        let mut b_record = snap_session("B", Some("leaf_b1"));
        b_record.context_meta = Some(conex_types::context::SessionContextMeta {
            last_compaction_at: Some(
                parse_iso8601_epoch_ms("2026-08-03T09:00:00.000Z").unwrap(),
            ),
            last_compaction_sequence: Some(30),
            last_compaction_generation: Some(1),
            compression_retries: 0,
        });
        let snapshot = StateSnapshot::build(
            1,
            100,
            vec![snap_session("A", Some("leaf_a1")), b_record],
            Vec::new(),
            Vec::new(),
            anchors,
        );
        // 快照后 B 新增压缩事件（seq 31）
        store
            .append_event(
                "B",
                31,
                CONTEXT_COMPRESSION_END_EVENT,
                &serde_json::to_string(&compression_end_event(
                    "B",
                    "2026-08-03T12:00:00.000Z",
                ))
                .unwrap(),
            )
            .await
            .unwrap();

        let outcome = RestoreManager::new()
            .restore(store.as_ref(), &snapshot_store_holder(&snapshot))
            .await
            .unwrap();

        let b = outcome.sessions.iter().find(|s| s.session_id == "B").unwrap();
        let meta = b.context_meta().expect("快照 meta 必须保留");
        assert_eq!(meta.last_compaction_sequence, Some(31), "压缩事件按 B 自身锚点重放");
        assert_eq!(meta.last_compaction_generation, Some(2), "代数增量续接 1→2");
        let a = outcome.sessions.iter().find(|s| s.session_id == "A").unwrap();
        assert!(a.context_meta().is_none(), "A 无压缩事件不受影响");
    }

    // ── PERSIST-02 P1-3：session_agents running 行归一 ──

    /// 子代理行构造（restore 归一测试用，最小字段集）
    fn agent_row(id: &str, run_id: &str, status: &str, session_id: &str) -> conex_types::SessionAgent {
        conex_types::SessionAgent {
            id: id.to_string(),
            subagent_run_id: run_id.to_string(),
            parent_session_id: session_id.to_string(),
            parent_run_id: format!("parent-{run_id}"),
            parent_tool_call_id: None,
            description: String::new(),
            mode: String::new(),
            status: status.to_string(),
            summary: None,
            messages: Vec::new(),
            started_at: 100,
            ended_at: None,
            depth: Some(1),
            subagent_path_json: None,
            task_type: None,
            display_label: None,
            allowed_write_paths_json: None,
        }
    }

    /// P1-3：子代理运行中崩溃 → session_agents 行残留 running；restore
    /// 归一为 failed + ended_at（kill_all 语义），终态行原样保留。
    /// 不归一 → FlowScheduler 重建后节点永久 Running，流程卡死。
    #[tokio::test]
    async fn restore_normalizes_running_session_agents_to_failed() {
        let db = LocalDb::open_in_memory().unwrap();
        db.insert_session("s1", "s1").unwrap();
        db.insert_session("s2", "s2").unwrap();
        db.save_session_agents(
            "s1",
            &[
                agent_row("a1", "run-a1", "running", "s1"),
                agent_row("a2", "run-a2", "completed", "s1"),
            ],
        )
        .unwrap();
        db.save_session_agents("s2", &[agent_row("a3", "run-a3", "running", "s2")]).unwrap();
        let store = LocalDbStore::new(db);

        let outcome = RestoreManager::new()
            .restore(&store, &NoSnapshots)
            .await
            .unwrap();

        // running 行归一 failed + ended_at 落库
        let db = store.as_local_db().expect("LocalDbStore 必须可下转");
        let s1_rows = db.load_session_agents("s1").unwrap();
        let a1 = s1_rows.iter().find(|a| a.id == "a1").unwrap();
        assert_eq!(a1.status, "failed", "running 行归一 failed");
        assert!(a1.ended_at.is_some(), "ended_at 落库");
        let a2 = s1_rows.iter().find(|a| a.id == "a2").unwrap();
        assert_eq!(a2.status, "completed", "终态行原样保留");
        assert_eq!(a2.ended_at, None, "终态行 ended_at 不被改写");
        let s2_rows = db.load_session_agents("s2").unwrap();
        assert_eq!(s2_rows[0].status, "failed", "跨会话全部 running 行归一");
        assert!(s2_rows[0].ended_at.is_some());
        assert!(outcome.runs.is_empty(), "runs 表无 run 不受影响");
    }
}
