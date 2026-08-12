//! W4-C View 轨 schema：kind / 描述符 / 注册载荷 / 错误码
//!
//! 诚实边界：**≠ EL-07** 满关；仅 A-EXT-05 局部方向的类型面。

use serde::{Deserialize, Serialize};
use serde_json::Value as JsonValue;
use std::collections::BTreeMap;

/// Contribute point 种类（View 轨；对齐 plugin-sdk `ContributeKind`）
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ContributeKind {
    SlashItem,
    BlockView,
    Widget,
    Keymap,
}

impl ContributeKind {
    /// 稳定字符串（注册键 / list 过滤）
    pub fn as_str(self) -> &'static str {
        match self {
            Self::SlashItem => "slash_item",
            Self::BlockView => "block_view",
            Self::Widget => "widget",
            Self::Keymap => "keymap",
        }
    }

    /// 解析 kind；未知 → None
    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "slash_item" => Some(Self::SlashItem),
            "block_view" => Some(Self::BlockView),
            "widget" => Some(Self::Widget),
            "keymap" => Some(Self::Keymap),
            _ => None,
        }
    }
}

/// 全部合法 View 轨 kind
pub const CONTRIBUTE_KINDS: &[ContributeKind] = &[
    ContributeKind::SlashItem,
    ContributeKind::BlockView,
    ContributeKind::Widget,
    ContributeKind::Keymap,
];

/// 投影-only 视图描述符（list 唯一对外形状）
///
/// 不变量（A-EXT-05 局部 / 恶意扩展方向）：
/// - 仅含可序列化 UI 元数据
/// - **永不**包含 store / applyOp / write / transaction 等写句柄
/// - 宿主据此渲染；写权威仍走 RS 工具面（NoteBackend / DocSession.apply）
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ViewDescriptor {
    pub id: String,
    pub plugin_id: String,
    pub kind: ContributeKind,
    /// 注册时声明的权限快照（只读；不含提升）
    pub permissions: Vec<String>,
    /// kind 特有字段（title / flavour / component / keys / commandId …）
    /// **禁止**写句柄键（注册时已剥离校验）
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub fields: BTreeMap<String, String>,
}

/// 插件侧注册载荷（View 轨）
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ContributeRegistration {
    pub id: String,
    pub plugin_id: String,
    pub kind: ContributeKind,
    /// 必须含 `ui:contribute`
    pub permissions: Vec<String>,
    /// kind 特有字段
    #[serde(default)]
    pub fields: BTreeMap<String, String>,
    /// 可选附加 JSON（如 slash action 意图数据）；扫描禁写键
    #[serde(default)]
    pub payload: Option<JsonValue>,
}

/// 注册错误码（对齐 plugin-sdk `RegisterErrorCode` 方向子集）
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ContributeRegisterError {
    MissingPermission { message: String },
    ForbiddenWriteHandle { key: String, message: String },
    DuplicateId { message: String },
    InvalidPayload { message: String },
}

impl ContributeRegisterError {
    pub fn code(&self) -> &'static str {
        match self {
            Self::MissingPermission { .. } => "missing_permission",
            Self::ForbiddenWriteHandle { .. } => "forbidden_write_handle",
            Self::DuplicateId { .. } => "duplicate_id",
            Self::InvalidPayload { .. } => "invalid_payload",
        }
    }

    pub fn message(&self) -> &str {
        match self {
            Self::MissingPermission { message }
            | Self::ForbiddenWriteHandle { message, .. }
            | Self::DuplicateId { message }
            | Self::InvalidPayload { message } => message,
        }
    }
}

impl std::fmt::Display for ContributeRegisterError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}: {}", self.code(), self.message())
    }
}

impl std::error::Error for ContributeRegisterError {}

/// 注册成功结果
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ContributeRegisterOk {
    pub registration_key: String,
}
