// SR-06d · 拆分 · ≠ EL：restore.rs 逻辑域拆模 1/2 —— 快照数据形状与文件
// 存储面（原 restore.rs 57-60、164-533 区间原样迁入，公开面经 restore.rs
// `pub use` 重导出，语义零改动）。

use std::collections::HashMap;
use std::fmt;
use std::path::{Path, PathBuf};
use std::str::FromStr;

use conex_db::{PendingInput, RunStatus, StoredRun};
use serde::{Deserialize, Serialize};

use crate::now_ms;
use crate::session::SessionRecord;

/// 快照顶层 type（对齐 TS orchestrator-state-snapshot）
pub const SNAPSHOT_TYPE: &str = "orchestrator-state-snapshot";
/// 快照 schema 版本
pub const SNAPSHOT_SCHEMA_VERSION: u32 = 1;

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
        // 原子写：tmp + rename（对齐 TS writeStateSnapshotFile 语义）。
        // T3.5 D5（R2 §4 修复建议 2）：tmp 名带 generation 唯一化——旧
        // `{path}.{pid}.tmp` 在同进程内固定，三触发并发保存交叉写同一
        // tmp 文件（内容混合）且轮转 remove/rename 互扰（Windows rename
        // 目标存在即失败）；generation 在进程内单调、pid 跨进程区分，
        // 任何两路并发保存落不同 tmp，交叉写物理上不可能。
        let tmp_path = PathBuf::from(format!(
            "{}.{}.{}.tmp",
            self.path.display(),
            snapshot.generation,
            std::process::id()
        ));
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
