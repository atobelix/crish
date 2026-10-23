//! 路径校验与冲突判定域（SR-06a-5 拆分 · 由 write_paths 门面 `#[path]` 接线）
//!
//! - **路径校验**：[validate_write_path]——glob（`* ? [`）拒绝 / `..` 越界拒绝 /
//!   symlink 解析后比较 / 工作区外拒绝，复用 `resolve_workspace_path`；
//! - **冲突判定**：Overlaps 组件级前缀语义（[paths_overlap_normalized] 对外公开，
//!   T-ESC-02 脚本逃逸追踪判定面复用）+ 归一化底座（[normalize_for_compare]）；
//! - **白名单策略**：[WritePathPolicy] / [WriteAllowanceError] / [check_write_allowance]
//!   （T-D-08 run 级硬沙箱判定面，语义与 Overlaps 同源）。
//!
//! 诚实边界：仅结构拆分，校验与判定语义零改动（≠ EL / ≠ 打开完成 / ≠ 结构债清零）。

use crate::definition::ToolError;
use crate::tools::resolve_workspace_path;
use conex_types::error::codes;
use std::path::{Path, PathBuf};

// ==================== T-D-08：run 级硬沙箱（REQ-D04 越权拒绝） ====================

/// run 级硬性写入允许集（None = 不限制路径；implementation 默认 = 工作区根）
///
/// 权限沙箱（不是并发层）：`Allowed` 为白名单前缀集合，目标必须落在任一
/// 允许前缀下（组件边界语义 + Windows 大小写折叠，复用 [paths_overlap_normalized]
/// 的归一化底座）；`Unrestricted` 不做路径限制。引擎侧（T-D-13）把 spawn 的
/// `allowed_write_paths` 字段与 task_type 默认集合并后经 [WritePathPolicy::from_entries]
/// 构造，再装配进 [super::write_paths_state::WritePathRegistry]
/// （[super::write_paths_state::WritePathRegistry::with_write_policy]）。
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub enum WritePathPolicy {
    /// 白名单允许集：目标必须在任一允许前缀下（空列表 = 全部拒绝，fail-closed）
    Allowed(Vec<PathBuf>),
    /// 不限制路径（缺省；implementation 的默认集由引擎装配为工作区根）
    #[default]
    Unrestricted,
}

impl WritePathPolicy {
    /// 从原始路径条目构造策略（供引擎 T-D-13 装配与测试使用）
    ///
    /// - 空列表 → [WritePathPolicy::Unrestricted]（REQ-D04：`allowed_write_paths`
    ///   为空 = 不做路径限制，仅受工具面控制）；
    /// - 每条目经 [validate_write_path] 校验并解析为规范化绝对路径
    ///   （glob 拒绝 / `..` 越界拒绝 / 工作区外拒绝），保证白名单与写工具
    ///   执行期目标在同一坐标空间（绝对路径）比较。
    pub fn from_entries(workspace_root: &Path, entries: Vec<String>) -> Result<Self, ToolError> {
        if entries.is_empty() {
            return Ok(WritePathPolicy::Unrestricted);
        }
        let resolved: Vec<PathBuf> = entries
            .iter()
            .map(|e| validate_write_path(workspace_root, e))
            .collect::<Result<_, _>>()?;
        Ok(WritePathPolicy::Allowed(resolved))
    }
}

/// 写路径越权（结构化错误载荷：目标路径 + 允许范围提示）
///
/// 与 [super::write_paths_state::WritePathConflict]（并发冲突）语义区分：
/// 本错误属权限层——路径合法且未被占用，只是不在 run 级允许集内；
/// 文案指引调整目标或走权限申请通道。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WriteAllowanceError {
    /// 本次请求的目标路径（规范化绝对路径）
    pub requested_path: PathBuf,
    /// 当前允许范围（白名单前缀；提示用）
    pub allowed: Vec<PathBuf>,
}

impl std::fmt::Display for WriteAllowanceError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let allowed = if self.allowed.is_empty() {
            "无（写入被整体禁止）".to_string()
        } else {
            self.allowed
                .iter()
                .map(|p| p.display().to_string())
                .collect::<Vec<_>>()
                .join("、")
        };
        write!(
            f,
            "写入路径不在允许范围内：{}；当前允许范围：{}。如需写入，请调整目标路径或向主 agent 申请权限",
            self.requested_path.display(),
            allowed,
        )
    }
}

impl WriteAllowanceError {
    /// 转为工具错误（错误码 `tool.write_not_allowed`，conex-types 已登记，
    /// Permanent / 不可重试；消息含目标路径与允许范围提示）
    pub fn into_tool_error(self) -> ToolError {
        ToolError::new(codes::TOOL_WRITE_NOT_ALLOWED, format!("{self}"))
    }
}

impl From<WriteAllowanceError> for ToolError {
    fn from(e: WriteAllowanceError) -> Self {
        e.into_tool_error()
    }
}

/// 硬沙箱越权判定（纯函数，无副作用；T-D-08 核心）
///
/// - [WritePathPolicy::Unrestricted] → 放行（不限制路径）；
/// - [WritePathPolicy::Allowed] → 目标必须在任一允许前缀下（组件边界 +
///   Windows 大小写折叠），否则拒绝，返回 [WriteAllowanceError]（含目标与
///   允许范围提示，`?` 转换为 `tool.write_not_allowed`）。
pub fn check_write_allowance(
    policy: &WritePathPolicy,
    target: &Path,
) -> Result<(), WriteAllowanceError> {
    match policy {
        WritePathPolicy::Unrestricted => Ok(()),
        WritePathPolicy::Allowed(allowed) => {
            if allowed.iter().any(|p| is_within_allowed(target, p)) {
                return Ok(());
            }
            Err(WriteAllowanceError {
                requested_path: target.to_path_buf(),
                allowed: allowed.clone(),
            })
        }
    }
}

/// 写路径声明校验纯函数（M3 任务卡内容 1：校验）
///
/// - 拒绝 glob（`* ? [`——声明必须是确定性路径，通配符无法做互斥记账）；
/// - 复用 `resolve_workspace_path`：`..` 越界拒绝、symlink 解析后比较、
///   工作区外拒绝、Windows 大小写折叠由比较层承担；
/// - 返回规范化绝对路径（`\\?\` 前缀已剥离），供注册表记账与 Overlaps 比较。
pub fn validate_write_path(workspace_root: &Path, input: &str) -> Result<PathBuf, ToolError> {
    if input.chars().any(|c| matches!(c, '*' | '?' | '[')) {
        return Err(ToolError::invalid_input(format!(
            "声明路径不允许通配符（glob）：{input:?}"
        )));
    }
    resolve_workspace_path(workspace_root, input)
}

/// Overlaps 检测：路径前缀语义（组件级）
///
/// `a/b/c.txt` 与 `a/b/` 冲突、`a/b` 与 `a/b` 冲突（同路径双向命中），
/// `a/b` 与 `a/bc` 不冲突（组件边界）。比较基于 [normalize_for_compare]：
/// 统一分隔符 + Windows 小写 + 去尾部分隔符，跨平台确定性一致。
///
/// 可见性：T-ESC-02（脚本逃逸追踪判定面）——session-loop 判定器复用
/// 本语义做「声明路径 vs 监视事件路径」比对，按 REQ-逃逸追踪分析 §3.2
/// 对外公开（声明基准复用，语义单一来源不复制实现）。
pub fn paths_overlap_normalized(a: &Path, b: &Path) -> bool {
    let na = normalize_for_compare(a);
    let nb = normalize_for_compare(b);
    if na == nb {
        return true;
    }
    let sep = std::path::MAIN_SEPARATOR.to_string();
    na.starts_with(&format!("{nb}{sep}")) || nb.starts_with(&format!("{na}{sep}"))
}

/// 白名单前缀判定（T-D-08 硬沙箱：目标是否落在允许前缀下）
///
/// 语义与 [paths_overlap_normalized] 同源（组件级前缀 + Windows 大小写折叠）：
/// `a/b/c.txt` 命中白名单 `a/b/`、`a/b` 与 `a/b` 双向命中，`a/b` 与 `a/bc`
/// 不误匹配（组件边界）。方向性：只判「目标在允许前缀内」单侧——
/// 白名单是允许集，允许项之间互不影响。
fn is_within_allowed(target: &Path, allowed: &Path) -> bool {
    let nt = normalize_for_compare(target);
    let na = normalize_for_compare(allowed);
    if nt == na {
        return true;
    }
    let sep = std::path::MAIN_SEPARATOR.to_string();
    nt.starts_with(&format!("{na}{sep}"))
}

/// 归一化（用于 Overlaps 比较；与 tools/mod.rs 的内部归一化同语义）
fn normalize_for_compare(p: &Path) -> String {
    let sep = std::path::MAIN_SEPARATOR.to_string();
    let mut s = p.to_string_lossy().replace(['/', '\\'], &sep);
    #[cfg(windows)]
    {
        s = s.to_lowercase();
    }
    if s.len() > 1 {
        s = s.trim_end_matches(std::path::MAIN_SEPARATOR).to_string();
    }
    s
}
