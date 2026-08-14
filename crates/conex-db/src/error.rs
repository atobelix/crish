//! 失败类型域：`DbFailureKind` / `DbFailure` / `DbFailure → CrishError` 接线。
//! 与库的锁 / IO / 迁移 / 打开 / 导入等失败类别定义（R6 目标形状，Display 保持
//! 操作名语义——session_commands 的 `format!("{}: {}", e.kind, ...)` 兼容）。

use conex_types::{codes, CrishError};

/// 失败类别（R6 目标形状；`kind` 由 String 收敛为枚举，Display 保持
/// 操作名语义——session_commands 的 `format!("{}: {}", e.kind, ...)` 兼容）。
///
/// ⚠️ 临时验证垫片（R6 落地后删除）：仅为打通 orchestrator/persist.rs 的
/// 编译与测试而补，最终形状以 R6 产出为准。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DbFailureKind {
    /// 锁竞争 / 锁中毒
    Lock,
    /// 底层 IO 错误
    Io,
    /// 数据损坏
    Corrupt,
    /// 迁移失败
    Migration,
    /// 打开数据库失败
    Open,
    /// 导入 folder 序列化失败
    ImportFolderSerialize,
    /// 导入索引解析失败
    ImportIndexParse,
    /// 其它操作名（保留 String 兼容）
    Other(String),
}

impl DbFailureKind {
    /// 操作名字面量（诊断 / metadata 用）
    pub fn as_str(&self) -> &str {
        match self {
            DbFailureKind::Lock => "lock",
            DbFailureKind::Io => "io",
            DbFailureKind::Corrupt => "corrupt",
            DbFailureKind::Migration => "migration",
            DbFailureKind::Open => "open",
            DbFailureKind::ImportFolderSerialize => "import_folder_serialize",
            DbFailureKind::ImportIndexParse => "import_index_parse",
            DbFailureKind::Other(name) => name.as_str(),
        }
    }
}

impl std::fmt::Display for DbFailureKind {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.as_str())
    }
}

/// Failure latch: once set, remains set until explicitly cleared.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DbFailure {
    pub message: String,
    pub kind: DbFailureKind,
}

impl std::fmt::Display for DbFailure {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}: {}", self.kind, self.message)
    }
}

/// DbFailure → CrishError（R6 接线点：77 码 store.write_failed + dbKind metadata，
/// cause 链保留底层分类）。
impl From<DbFailure> for CrishError {
    fn from(failure: DbFailure) -> Self {
        CrishError::new(codes::STORE_WRITE_FAILED, failure.message.clone())
            .with_metadata(serde_json::json!({ "dbKind": failure.kind.as_str() }))
    }
}
