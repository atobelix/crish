//! 笔记后端错误码（SD-32 从 `note_types` 切开）
//!
//! 稳定码字面量供工具 JSON / 日志；**≠ EL-05**；**≠ A-AGT 满表关闭**。

/// 笔记后端错误（工具层映射为 ok=false / ToolError）
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum NoteBackendError {
    /// 后端未接线（通常由工具在 Option=None 时直接返回，不经 trait）
    Unwired,
    /// 文档 / 块不存在
    NotFound(String),
    /// 入参非法
    Invalid(String),
    /// apply / 解析失败（零半树由实现方保证）
    ApplyFailed(String),
    /// 块 id 冲突
    IdConflict(String),
    /// batch token 非法（未占用 / 未知）
    BatchTokenInvalid(String),
    /// batch token 已过期
    BatchTokenExpired(String),
    /// 写中断 / 执行态未知（A-AGT-07 形状）：**禁止**半写；调用方**不得**盲目重试写
    ///
    /// 稳定码：`note.execution_unknown`（W4-F；**≠** W6-E 满关）。
    ExecutionUnknown(String),
}

impl NoteBackendError {
    /// 稳定错误码字面量（工具 JSON / 日志）
    pub fn code(&self) -> &'static str {
        match self {
            Self::Unwired => "note.unwired",
            Self::NotFound(_) => "note.not_found",
            Self::Invalid(_) => "note.invalid",
            Self::ApplyFailed(_) => "note.apply_failed",
            Self::IdConflict(_) => "note.id_conflict",
            Self::BatchTokenInvalid(_) => "note.batch_token_invalid",
            Self::BatchTokenExpired(_) => "note.batch_token_expired",
            Self::ExecutionUnknown(_) => "note.execution_unknown",
        }
    }

    /// 人读消息
    pub fn message(&self) -> String {
        match self {
            Self::Unwired => "note backend not wired".to_string(),
            Self::NotFound(m)
            | Self::Invalid(m)
            | Self::ApplyFailed(m)
            | Self::IdConflict(m)
            | Self::BatchTokenInvalid(m)
            | Self::BatchTokenExpired(m)
            | Self::ExecutionUnknown(m) => m.clone(),
        }
    }
}

impl std::fmt::Display for NoteBackendError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "[{}] {}", self.code(), self.message())
    }
}

impl std::error::Error for NoteBackendError {}
