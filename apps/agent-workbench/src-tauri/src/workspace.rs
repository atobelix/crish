//! 工作区注册表（PE-07 T07.2：沙箱根真源化，P-01 修复）
//!
//! 信任锚迁移：工作区根不再由调用方以 `workspace_root` 参数传入，改由本注册表
//! 作为 Rust 侧唯一真源（B1 基线）。核心规则：
//! - 原生目录对话框（`select_folder`，用户手势）是唯一「新授权」入口（Dialog 源）；
//! - RecentList / DefaultAppRoot 仅能「复授权」历史根（path 必须存在于
//!   `config_dir()/recent-workspaces.json` 或等于 `host_paths::workspace_root`）；
//! - 启动时加载 recent 列表 + 注册默认应用根；`workbench_open_workspace` 授权成功
//!   后回写 recent（tmp + rename 落盘，webview 不可写）。
//!
//! 命令（需集成 agent 在 main.rs 注册 + `app.manage(WorkspaceRegistry)`）：
//! - `workbench_open_workspace(path)`：复授权（recent / 默认根），否则 `workspace_not_granted`
//! - `workbench_activate_default_workspace()`：激活已注册的默认应用根，不接收路径
//! - `workbench_list_workspaces()`：列出已授权根（供 UI 状态同步）
//!
//! 锁使用 `lock().map_err(...)` 恢复式模式（对齐 T07.6，禁用 expect 中毒路径）。
//! `resolve_guard` 先 canonicalize 再做前缀包含匹配，根不可达一律拒绝（P-02 关闭）。

use crate::fs_commands::types::{
    path_is_same_or_child, strip_verbatim_prefix, FileCommandError, WorkspaceFsGuard, ERR_INTERNAL,
    ERR_NOT_FOUND, ERR_OUTSIDE_WORKSPACE, ERR_READ_FILE,
};
use conex_run::core_error::CoreError;
use std::{
    path::{Path, PathBuf},
    sync::Mutex,
};
use tauri::Manager;
use tauri_plugin_dialog::{DialogExt, FilePath};
mod recent;
mod registration;
pub(crate) mod remote;

use recent::*;

/// `FileCommandError` → `CoreError`（detail 逐字保留旧 String 契约的
/// `"{code}: {message}"` 文案——前端 workspaceAccessApi 依赖
/// `message.includes('workspace_not_granted')` 匹配，前缀不得丢失）；
/// kind 按 code 语义映射：授权前置 → InvalidInput，资源缺失 → NotFound，
/// 其余（内部/越界等系统层）→ Internal 兜底。
fn map_registry_err(err: FileCommandError) -> CoreError {
    let detail = format!("{}: {}", err.code, err.message);
    match err.code.as_str() {
        ERR_WORKSPACE_NOT_GRANTED => CoreError::InvalidInput(detail),
        ERR_NOT_FOUND => CoreError::NotFound(detail),
        _ => CoreError::Internal(detail),
    }
}

/// 注册来源：决定该路径属于「新授权」还是「复授权」。
///
/// RecentList 变体仅用于已有 recent/default 根的复授权。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum RegisterSource {
    /// 原生目录对话框选中（唯一新授权入口）
    Dialog,
    /// recent-workspaces.json 历史列表（复授权）
    RecentList,
    /// 默认应用工作区根（host_paths::workspace_root，启动时内部注册）
    DefaultAppRoot,
}

/// 已授权根条目：路径 + 来源（历史结构与任务书一致）。
#[derive(Debug, Clone, PartialEq, Eq)]
struct WorkspaceRoot {
    path: PathBuf,
    source: RegisterSource,
}

/// 注册表内部状态。
struct RegistryInner {
    /// 全部已授权根（均为 canonical 绝对路径）
    roots: Vec<WorkspaceRoot>,
    /// 当前活动根下标（最近一次授权者；相对路径请求的解析基准）
    active: Option<usize>,
    /// recent 历史列表（Rust 侧持久化于 config_dir()/recent-workspaces.json）
    recent: Vec<PathBuf>,
    /// recent 文件所在目录（注册成功时回写）
    config_dir: PathBuf,
}

/// 工作区注册表（Rust 侧唯一真源）。由 main.rs `app.manage(...)` 托管，
/// 命令侧经 `tauri::AppHandle::try_state` 获取。
pub(crate) struct WorkspaceRegistry {
    inner: Mutex<RegistryInner>,
}

/// 本次 recent 批量复授权期间完成 canonicalize 与授权校验的结果。
#[derive(Debug)]
struct RegisteredWorkspaceBatch {
    primary: PathBuf,
    /// 规范化后的全部授权根（生产侧 sync_scope 已消费；测试断言批量授权结果）
    #[cfg_attr(not(test), allow(dead_code))]
    roots: Vec<PathBuf>,
}

/// recent 文件固定文件名（webview 不可写，防恶意仓库改写授权）
const RECENT_FILE_NAME: &str = "recent-workspaces.json";

/// 错误码：复授权被拒
pub(crate) const ERR_WORKSPACE_NOT_GRANTED: &str = "workspace_not_granted";

impl WorkspaceRegistry {
    /// 启动初始化：加载 recent-workspaces.json + 注册默认应用根（DefaultAppRoot）。
    /// recent 文件损坏/缺失 → 空列表，不 panic（T07.2 用例 7）。
    pub(crate) fn init() -> Result<Self, FileCommandError> {
        Self::init_with_config_dir(&workspace_config_dir())
    }

    /// 指定配置目录初始化（供测试注入临时目录；PS-04 T4.4 测试经
    /// `init_with_config_dir` 构造 mock 注册表，故对 crate 内测试可见）。
    pub(crate) fn init_with_config_dir(config_dir: &Path) -> Result<Self, FileCommandError> {
        let recent = load_recent_list(config_dir);
        let mut roots: Vec<WorkspaceRoot> = Vec::new();
        // 默认应用根（monorepo 根）作为基础授权；canonicalize 失败则跳过
        if let Ok(app_dir) = crate::host_paths::app_dir() {
            let default_root = crate::host_paths::workspace_root(&app_dir);
            if let Ok(canon) = canonicalize_root(&default_root) {
                roots.push(WorkspaceRoot {
                    path: canon,
                    source: RegisterSource::DefaultAppRoot,
                });
            }
        }
        let active = (!roots.is_empty()).then_some(0);
        Ok(Self {
            inner: Mutex::new(RegistryInner {
                roots,
                active,
                recent,
                config_dir: config_dir.to_path_buf(),
            }),
        })
    }

    /// 解析请求路径对应的沙箱守卫。
    /// - 请求路径为空或相对：以活动根为基准（`..`/绝对越界由守卫二次校验）；
    /// - 绝对路径：先 canonicalize 再与全部已授权根前缀匹配（T07.2 用例 11/12）。
    ///
    /// 越界 → `ERR_OUTSIDE_WORKSPACE`；不可达 → 明确错误（不退化裸用）。
    pub(crate) fn resolve_guard(
        &self,
        requested: &str,
    ) -> Result<WorkspaceFsGuard, FileCommandError> {
        let requested = requested.trim();

        // 先在锁内取出本次判定所需的快照（roots 克隆 + 活动根），随即释放锁：
        // `canonicalize()` 会触达文件系统，慢盘/网络盘上可达数百毫秒；持锁执行
        // 会让所有并发工作区查询串行排队。
        let (roots, active_root) = {
            let inner = self.inner.lock().map_err(|e| {
                FileCommandError::new(
                    ERR_INTERNAL,
                    format!("workspace registry lock poisoned: {e}"),
                )
            })?;
            if inner.roots.is_empty() {
                return Err(FileCommandError::new(
                    ERR_OUTSIDE_WORKSPACE,
                    "No authorized project root is registered.",
                ));
            }
            let roots: Vec<PathBuf> = inner.roots.iter().map(|r| r.path.clone()).collect();
            (roots, active_root_path(&inner)?)
        };

        if requested.is_empty() {
            return WorkspaceFsGuard::new(&active_root).map_err(|e| {
                FileCommandError::new(
                    ERR_INTERNAL,
                    format!("authorized project root is unreachable: {}", e.message),
                )
            });
        }

        let requested_path = Path::new(requested);
        if !requested_path.is_absolute() {
            // 相对路径以活动根为基准；守卫内部的 resolve_existing 再校验 `..`/符号链接
            return WorkspaceFsGuard::new(&active_root).map_err(|e| {
                FileCommandError::new(
                    ERR_INTERNAL,
                    format!("authorized project root is unreachable: {}", e.message),
                )
            });
        }

        // 绝对路径：锁外 canonicalize（剥离 \\?\ 前缀、解析符号链接），再前缀匹配
        let canonical = requested_path.canonicalize().map_err(|e| {
            if e.kind() == std::io::ErrorKind::NotFound {
                FileCommandError::new(ERR_NOT_FOUND, "Path does not exist.")
            } else {
                FileCommandError::new(ERR_READ_FILE, format!("Failed to resolve path: {e}"))
            }
        })?;
        // 与快照比对：授权根集合在 canonicalize 期间被并发修改时，本次判定基于
        // 旧快照，但对安全边界只会更保守（可能多拒、不会多放行）——被移除的根
        // 若仍在快照中，调用方拿到的是已失效守卫，其 `WorkspaceFsGuard::new`
        // 会因目录不可达而失败，不会越权。
        for root in &roots {
            if path_is_same_or_child(&canonical, root) {
                return WorkspaceFsGuard::new(root).map_err(|e| {
                    FileCommandError::new(
                        ERR_INTERNAL,
                        format!("authorized project root is unreachable: {}", e.message),
                    )
                });
            }
        }
        Err(FileCommandError::new(
            ERR_OUTSIDE_WORKSPACE,
            "Path is outside the allowed project root.",
        ))
    }

    /// 列出全部已授权根（供 `workbench_list_workspaces` 状态同步）。
    pub(crate) fn roots(&self) -> Vec<PathBuf> {
        self.inner
            .lock()
            .map(|inner| inner.roots.iter().map(|root| root.path.clone()).collect())
            .unwrap_or_default()
    }

    /// 获取当前活动工作区根（无显式活动根时回退到首个已授权根）
    pub(crate) fn active_root(&self) -> Option<PathBuf> {
        let inner = self.inner.lock().ok()?;
        active_root_path(&inner).ok()
    }
}

/// 活动根路径（无活动根时退回第一个已授权根）。
fn active_root_path(inner: &RegistryInner) -> Result<PathBuf, FileCommandError> {
    if let Some(index) = inner.active {
        if let Some(root) = inner.roots.get(index) {
            return Ok(root.path.clone());
        }
    }
    inner
        .roots
        .first()
        .map(|root| root.path.clone())
        .ok_or_else(|| {
            FileCommandError::new(
                ERR_OUTSIDE_WORKSPACE,
                "No authorized workspace root is registered.",
            )
        })
}

/// 严格 canonicalize：失败即拒绝（不退化裸用传入路径，P-02 关闭）；
/// Windows 下剥离 `\\?\` 前缀保证跨会话一致。
fn canonicalize_root(path: &Path) -> Result<PathBuf, FileCommandError> {
    let canonical = path.canonicalize().map_err(|e| {
        FileCommandError::new(
            ERR_INTERNAL,
            format!("failed to canonicalize `{}`: {e}", path.display()),
        )
    })?;
    Ok(strip_verbatim_prefix(&canonical))
}

/// 是否为默认应用工作区根（host_paths::workspace_root）。
fn is_default_app_root(path: &Path) -> bool {
    let Ok(app_dir) = crate::host_paths::app_dir() else {
        return false;
    };
    let default_root = crate::host_paths::workspace_root(&app_dir);
    match default_root.canonicalize() {
        Ok(canon) => paths_equal(path, &strip_verbatim_prefix(&canon)),
        Err(_) => paths_equal(path, &default_root),
    }
}

/// 路径等价比较（Windows 大小写不敏感 + 尾分隔符/`\\?\` 归一化，复用守卫语义）。
fn paths_equal(a: &Path, b: &Path) -> bool {
    path_is_same_or_child(a, b) && path_is_same_or_child(b, a)
}

/// 命令侧获取注册表状态（try_state，缺失时返回内部错误而非 panic）。
pub(crate) fn registry(
    app: &tauri::AppHandle,
) -> Result<tauri::State<'_, WorkspaceRegistry>, FileCommandError> {
    app.try_state::<WorkspaceRegistry>()
        .ok_or_else(|| {
            FileCommandError::new(
                ERR_INTERNAL,
                "WorkspaceRegistry is not managed; main.rs setup must call app.manage(WorkspaceRegistry::init()...)",
            )
        })
}

/// 命令侧解析守卫（fs_commands 各命令共用入口）。
pub(crate) fn resolve_guard(
    app: &tauri::AppHandle,
    requested: &str,
) -> Result<WorkspaceFsGuard, FileCommandError> {
    registry(app)?.resolve_guard(requested)
}

/// 只同步本次注册方法返回的 canonical 根；调用方不得传入原始 IPC 路径。
fn sync_asset_scope<R: tauri::Runtime, M: tauri::Manager<R>>(
    app: &M,
    roots: &[PathBuf],
) -> Result<(), FileCommandError> {
    crate::asset_scope::allow_registered_workspace_roots(app, roots.iter().cloned()).map_err(
        |error| FileCommandError::new(ERR_INTERNAL, format!("工作区资源协议授权同步失败：{error}")),
    )
}

/// 复授权命令：只接受 recent 列表或默认应用根；其 path 不产生新授权。
#[tauri::command]
pub(crate) fn workbench_open_workspace(
    app: tauri::AppHandle,
    path: String,
) -> Result<OpenWorkspaceResult, CoreError> {
    let reg = registry(&app).map_err(map_registry_err)?;
    let path = PathBuf::from(path);
    let registered = reg
        .register_recent_paths_with(std::slice::from_ref(&path), &path, true, |roots| {
            sync_asset_scope(&app, roots)
        })
        .map_err(map_registry_err)?;
    Ok(OpenWorkspaceResult {
        path: registered.primary.to_string_lossy().into_owned(),
    })
}

/// 多目录项目的 RecentList 原子复授权；所有路径验证成功后才更新 roots。
/// 任一 renderer 路径不在 recent/default 内时整批拒绝，不新增 Dialog 授权。
#[tauri::command]
pub(crate) fn workbench_open_workspaces(
    app: tauri::AppHandle,
    paths: Vec<String>,
    primary_path: String,
    activate_primary: bool,
) -> Result<OpenWorkspaceResult, CoreError> {
    let reg = registry(&app).map_err(map_registry_err)?;
    let paths: Vec<PathBuf> = paths.into_iter().map(PathBuf::from).collect();
    let registered = reg
        .register_recent_paths_with(
            &paths,
            Path::new(&primary_path),
            activate_primary,
            |roots| sync_asset_scope(&app, roots),
        )
        .map_err(map_registry_err)?;
    Ok(OpenWorkspaceResult {
        path: registered.primary.to_string_lossy().into_owned(),
    })
}

/// 切回 Rust 内部注册的默认应用工作区根；不接受 renderer 提供的路径。
#[tauri::command]
pub(crate) fn workbench_activate_default_workspace(
    app: tauri::AppHandle,
) -> Result<OpenWorkspaceResult, CoreError> {
    let reg = registry(&app).map_err(map_registry_err)?;
    let canonical = reg
        .activate_default_root_with(|roots| sync_asset_scope(&app, roots))
        .map_err(map_registry_err)?;
    Ok(OpenWorkspaceResult {
        path: canonical.to_string_lossy().into_owned(),
    })
}

/// 列出当前已授权根，供 UI 状态同步。
#[tauri::command]
pub(crate) fn workbench_list_workspaces(app: tauri::AppHandle) -> Result<Vec<String>, CoreError> {
    let reg = registry(&app).map_err(map_registry_err)?;
    Ok(reg
        .roots()
        .into_iter()
        .map(|p| p.to_string_lossy().into_owned())
        .collect())
}

/// 复授权成功返回体（camelCase 序列化）。
#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct OpenWorkspaceResult {
    pub(crate) path: String,
}

/// 打开 Tauri plugin-dialog 原生目录选择器并等待用户结果。
///
/// 调用端不提供路径；唯一输入来自插件回调的 FilePath。
async fn select_native_folder_paths(
    app: &tauri::AppHandle,
    title: &'static str,
    multiple: bool,
) -> Result<Option<Vec<PathBuf>>, FileCommandError> {
    let (tx, rx) = tokio::sync::oneshot::channel::<Option<Vec<FilePath>>>();
    if multiple {
        app.dialog()
            .file()
            .set_title(title)
            .pick_folders(move |paths| {
                let _ = tx.send(paths);
            });
    } else {
        app.dialog()
            .file()
            .set_title(title)
            .pick_folder(move |path| {
                let _ = tx.send(path.map(|path| vec![path]));
            });
    }

    let Some(selected) = rx
        .await
        .map_err(|_| FileCommandError::new(ERR_INTERNAL, "原生文件夹选择器未返回结果"))?
    else {
        return Ok(None);
    };

    selected
        .into_iter()
        .map(|path| {
            path.into_path().map_err(|e| {
                FileCommandError::new(ERR_INTERNAL, format!("无法读取原生选择的文件夹路径: {e}"))
            })
        })
        .collect::<Result<Vec<_>, _>>()
        .map(Some)
}

/// 只允许由原生 dialog 结果调用；None 代表取消且不改注册表。
#[cfg(test)]
fn register_native_dialog_selection(
    registry: &WorkspaceRegistry,
    selected: Option<Vec<PathBuf>>,
    activate_first: bool,
) -> Result<Option<Vec<PathBuf>>, FileCommandError> {
    let Some(selected) = selected else {
        return Ok(None);
    };
    registry
        .register_dialog_paths(&selected, activate_first)
        .map(Some)
}

fn register_native_dialog_selection_and_sync<R: tauri::Runtime, M: tauri::Manager<R>>(
    app: &M,
    registry: &WorkspaceRegistry,
    selected: Option<Vec<PathBuf>>,
    activate_first: bool,
) -> Result<Option<Vec<PathBuf>>, FileCommandError> {
    register_native_dialog_selection_and_sync_with(registry, selected, activate_first, |roots| {
        sync_asset_scope(app, roots)
    })
}

fn register_native_dialog_selection_and_sync_with<F>(
    registry: &WorkspaceRegistry,
    selected: Option<Vec<PathBuf>>,
    activate_first: bool,
    sync_scope: F,
) -> Result<Option<Vec<PathBuf>>, FileCommandError>
where
    F: FnOnce(&[PathBuf]) -> Result<(), FileCommandError>,
{
    let Some(selected) = selected else {
        return Ok(None);
    };
    registry
        .register_dialog_paths_with(&selected, activate_first, |roots| {
            sync_scope(roots).map_err(|error| {
                FileCommandError::new(
                    ERR_INTERNAL,
                    format!(
                        "{}；所选目录可能已有部分进入资源访问范围，注册表与近期列表未提交。请重试以完成授权。",
                        error.message
                    ),
                )
            })
        })
        .map(Some)
}

/// 用户在 Rust 侧原生目录选择器中选出的项目根；命令无 path 参数。
#[tauri::command]
pub(crate) async fn workbench_pick_workspace_folder(
    app: tauri::AppHandle,
) -> Result<Option<String>, CoreError> {
    let selected = select_native_folder_paths(&app, "选择项目文件夹", false)
        .await
        .map_err(map_registry_err)?;
    let registry = registry(&app).map_err(map_registry_err)?;
    let paths = register_native_dialog_selection_and_sync(&app, &registry, selected, true)
        .map_err(map_registry_err)?;
    Ok(paths
        .and_then(|mut paths| paths.pop())
        .map(|path| path.to_string_lossy().into_owned()))
}

/// 用户在 Rust 侧原生多选目录选择器中选出的项目根；命令只收是否激活首选根。
#[tauri::command]
pub(crate) async fn workbench_pick_workspace_folders(
    app: tauri::AppHandle,
    activate_first: bool,
) -> Result<Option<Vec<String>>, CoreError> {
    let selected = select_native_folder_paths(&app, "选择项目文件夹", true)
        .await
        .map_err(map_registry_err)?;
    let registry = registry(&app).map_err(map_registry_err)?;
    let paths =
        register_native_dialog_selection_and_sync(&app, &registry, selected, activate_first)
            .map_err(map_registry_err)?;
    Ok(paths.map(|paths| {
        paths
            .into_iter()
            .map(|path| path.to_string_lossy().into_owned())
            .collect()
    }))
}

#[cfg(test)]
mod tests;
