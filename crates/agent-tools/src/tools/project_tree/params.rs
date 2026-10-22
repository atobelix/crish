//! project_tree 工具入参结构（解析 + 校验 + 钳制后）

use std::path::PathBuf;

/// 工具入参（解析 + 校验 + 钳制后的结构化参数）
#[derive(Clone)]
pub(super) struct ProjectTreeParams {
    /// resolve_workspace_path 规范化后的树根（canonical）
    pub(super) root: PathBuf,
    /// 树根显示名（display_path 语义；与缓存无关，渲染期用）
    pub(super) root_display: String,
    /// 递归深度（已钳制 1..=MAX_WALK_DEPTH）
    pub(super) depth: usize,
    /// 是否列出文件（dirsOnly 已折叠进本字段：false = 只目录）
    pub(super) include_files: bool,
    /// 排除式 glob（已排序，参与缓存键）
    pub(super) exclude_globs: Vec<String>,
    /// 渲染期节点总数上限（不进缓存键）
    pub(super) max_items: usize,
    /// 渲染期超深目录折叠起点（不进缓存键）
    pub(super) max_depth_content: usize,
}
