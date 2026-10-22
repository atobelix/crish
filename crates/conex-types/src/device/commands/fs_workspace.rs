use serde::{Deserialize, Serialize};

use super::enums::AssetKind;

// ── F4 文件与资产域：参数与响应 ──

/// C16 参数（path 相对路径或空串 = 工作区根）
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ListDirParams {
    /// 相对路径（缺省/空串 = 工作区根）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    /// 工作区根（缺省 = 当前活动根）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workspace_root: Option<String>,
}

/// 目录条目（C16 响应元素）
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DirectoryItem {
    /// 条目名
    pub name: String,
    /// 是否目录
    pub is_dir: bool,
    /// 字节大小（目录为 None）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub size: Option<u64>,
    /// 修改时间（字符串透传）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub modified: Option<String>,
}

/// C16 响应
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ListDirResult {
    /// 目录条目（桌面保证排序：目录优先 + 字母序）
    pub entries: Vec<DirectoryItem>,
}

/// C17 参数（分块读文件）
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReadFileParams {
    /// 相对路径
    pub path: String,
    /// 工作区根
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workspace_root: Option<String>,
    /// 行数上限（缺省 400，硬顶 5000）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_lines: Option<u32>,
    /// 起始行（0 基）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub start_line: Option<u64>,
}

/// C17 响应
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReadFileResult {
    /// 文件内容（≤1MB）
    pub content: String,
    /// 文件总行数
    pub line_count: u64,
    /// 是否截断
    pub truncated: bool,
    /// 敏感文件标记（移动端渲染横幅且不缓存）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sensitive: Option<bool>,
}

/// C18 参数（受控写文件；本域唯一写命令）
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WriteFileParams {
    /// 相对路径
    pub path: String,
    /// 文件内容（≤1MB）
    pub content: String,
    /// 覆盖已存在文件（缺省 false；file.exists → 确认后重发）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub overwrite: Option<bool>,
    /// 工作区根
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workspace_root: Option<String>,
}

/// C18 响应
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WriteFileResult {
    /// 是否成功
    pub ok: bool,
    /// 写入路径
    pub path: String,
}

/// C19 参数（空）
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ListWorkspacesParams {}

/// 工作区条目（C19 响应元素）
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceEntry {
    /// 根路径
    pub root: String,
    /// 名称
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    /// 是否活动根
    pub active: bool,
    /// 是否可达（canonicalize 探测）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reachable: Option<bool>,
}

/// C19 响应
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ListWorkspacesResult {
    /// 工作区列表
    pub workspaces: Vec<WorkspaceEntry>,
}

/// C20 参数（切换活动根；需在 recent 授权列表内）
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SwitchWorkspaceParams {
    /// 目标根路径
    pub path: String,
}

/// C20 响应
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SwitchWorkspaceResult {
    /// 是否成功
    pub ok: bool,
    /// 当前活动根
    pub active_root: String,
}

/// C21 参数（递归文件名搜索）
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchFilesParams {
    /// 查询词（1-256 字符）
    pub query: String,
    /// 搜索根（相对路径）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub root: Option<String>,
    /// 结果上限（缺省 100，桌面端钳制）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_results: Option<u32>,
}

/// 文件搜索命中（C21 响应元素；只返回 relPath + kind + size）
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileSearchHit {
    /// 相对路径
    pub rel_path: String,
    /// 文件类别（text 等）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub kind: Option<String>,
    /// 字节大小
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub size: Option<u64>,
}

/// C21 响应
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchFilesResult {
    /// 命中列表
    pub results: Vec<FileSearchHit>,
}

/// C22 参数（资源 URL）
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AssetUrlParams {
    /// 相对路径（仅已授权根内）
    pub path: String,
    /// 资源类别
    pub kind: AssetKind,
}

/// C22 响应（令牌 10 分钟有效；URL 只在内存态）
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AssetUrlResult {
    /// 资源 URL（HTTP 代理形态，带短期令牌）
    pub url: String,
    /// 过期时刻（epoch ms）
    pub expires_at: u64,
}

/// C23 参数
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileStatParams {
    /// 相对路径
    pub path: String,
    /// 工作区根
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workspace_root: Option<String>,
}

/// C23 响应
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileStatResult {
    /// 字节大小
    pub size: u64,
    /// 修改时间（字符串透传）
    pub modified: String,
    /// 只读标记
    pub readonly: bool,
    /// 文件类别（text 等）
    pub kind: String,
}
