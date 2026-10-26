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
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tauri::Manager;
use tauri_plugin_dialog::{DialogExt, FilePath};

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
    roots: Vec<PathBuf>,
}

/// recent 文件固定文件名（webview 不可写，防恶意仓库改写授权）
const RECENT_FILE_NAME: &str = "recent-workspaces.json";

/// 错误码：复授权被拒
pub(crate) const ERR_WORKSPACE_NOT_GRANTED: &str = "workspace_not_granted";

impl WorkspaceRegistry {
    /// 启动初始化：加载 recent-workspaces.json + 注册默认应用根（DefaultAppRoot）。
    /// recent 文件损坏/缺失 → 空列表，不 panic（T07.2 用例 7）。
    pub(crate) fn init() -> Result<Self, String> {
        Self::init_with_config_dir(&workspace_config_dir())
    }

    /// 指定配置目录初始化（供测试注入临时目录；PS-04 T4.4 测试经
    /// `init_with_config_dir` 构造 mock 注册表，故对 crate 内测试可见）。
    pub(crate) fn init_with_config_dir(config_dir: &Path) -> Result<Self, String> {
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

    /// 注册授权根。Dialog 为唯一新授权入口；RecentList/DefaultAppRoot 仅复授权
    /// （路径必须在 recent 列表内或等于默认应用根），否则 `workspace_not_granted`。
    pub(crate) fn register(&self, path: &Path, source: RegisterSource) -> Result<PathBuf, String> {
        if source == RegisterSource::Dialog {
            return self
                .register_dialog_paths(&[path.to_path_buf()], true)?
                .into_iter()
                .next()
                .ok_or_else(|| format!("{ERR_WORKSPACE_NOT_GRANTED}: no selected workspace"));
        }
        if source == RegisterSource::RecentList {
            return self
                .register_recent_paths(&[path.to_path_buf()], path, true)
                .map(|registered| registered.primary);
        }
        if path.as_os_str().is_empty() {
            return Err(format!("{ERR_WORKSPACE_NOT_GRANTED}: path is empty"));
        }
        let path_str = path.to_string_lossy();
        if path_str.contains('\0') {
            return Err(format!(
                "{ERR_WORKSPACE_NOT_GRANTED}: path contains NUL byte"
            ));
        }
        // 根不可达（盘符移除/无法解析）→ 明确拒绝，绝不裸用传入根（T07.2 用例 13）
        let canonical = canonicalize_root(path).map_err(|e| {
            format!("{ERR_WORKSPACE_NOT_GRANTED}: cannot resolve workspace root `{path_str}`: {e}")
        })?;
        if !canonical.is_dir() {
            return Err(format!(
                "{ERR_WORKSPACE_NOT_GRANTED}: not a directory: `{}`",
                canonical.display()
            ));
        }

        let mut inner = self
            .inner
            .lock()
            .map_err(|e| format!("{ERR_INTERNAL}: workspace registry lock poisoned: {e}"))?;

        match source {
            RegisterSource::Dialog => unreachable!("Dialog uses register_dialog_paths"),
            RegisterSource::RecentList => unreachable!("RecentList uses register_recent_paths"),
            RegisterSource::DefaultAppRoot => {
                // 复授权：仅默认应用根（启动内部注册使用）
                if !is_default_app_root(&canonical) {
                    return Err(format!(
                        "{ERR_WORKSPACE_NOT_GRANTED}: not the default app root: `{}`",
                        canonical.display()
                    ));
                }
            }
        }

        let mut next_recent = inner.recent.clone();
        if !next_recent.iter().any(|item| paths_equal(item, &canonical)) {
            next_recent.push(canonical.clone());
        }
        if next_recent != inner.recent {
            persist_recent_list(&inner.config_dir, &next_recent)?;
        }

        // 去重 + 置为活动根（最近授权者）
        inner
            .roots
            .retain(|root| !paths_equal(&root.path, &canonical));
        inner.roots.push(WorkspaceRoot {
            path: canonical.clone(),
            source,
        });
        inner.active = Some(inner.roots.len() - 1);
        inner.recent = next_recent;

        Ok(canonical)
    }

    /// RecentList 批量复授权：先验证全部路径与 primary，再一次更新 roots。
    /// 不接受任何 Dialog 来源的新授权；路径必须已经在 recent 或等于默认应用根。
    fn register_recent_paths(
        &self,
        paths: &[PathBuf],
        primary_path: &Path,
        activate_primary: bool,
    ) -> Result<RegisteredWorkspaceBatch, String> {
        if paths.is_empty() {
            return Err(format!("{ERR_WORKSPACE_NOT_GRANTED}: path list is empty"));
        }

        // 显式 PathBuf 标注：首个使用点是 .iter()（paths_equal 形参 &Path），
        // 无标注时推断会把元素类型统一成未加尺寸的 Path（编译错误）。
        let mut canonical_paths: Vec<PathBuf> = Vec::with_capacity(paths.len());
        for path in paths {
            if path.as_os_str().is_empty() {
                return Err(format!("{ERR_WORKSPACE_NOT_GRANTED}: path is empty"));
            }
            let path_str = path.to_string_lossy();
            if path_str.contains('\0') {
                return Err(format!(
                    "{ERR_WORKSPACE_NOT_GRANTED}: path contains NUL byte"
                ));
            }
            let canonical = canonicalize_root(path).map_err(|e| {
                format!(
                    "{ERR_WORKSPACE_NOT_GRANTED}: cannot resolve workspace root `{path_str}`: {e}"
                )
            })?;
            if !canonical.is_dir() {
                return Err(format!(
                    "{ERR_WORKSPACE_NOT_GRANTED}: not a directory: `{}`",
                    canonical.display()
                ));
            }
            if !canonical_paths
                .iter()
                .any(|item| paths_equal(item, &canonical))
            {
                canonical_paths.push(canonical);
            }
        }

        let primary_canonical = canonicalize_root(primary_path).map_err(|e| {
            format!(
                "{ERR_WORKSPACE_NOT_GRANTED}: cannot resolve primary workspace root `{}`: {e}",
                primary_path.display()
            )
        })?;
        if !canonical_paths
            .iter()
            .any(|path| paths_equal(path, &primary_canonical))
        {
            return Err(format!(
                "{ERR_WORKSPACE_NOT_GRANTED}: primary workspace is not in the path list: `{}`",
                primary_canonical.display()
            ));
        }

        let mut inner = self
            .inner
            .lock()
            .map_err(|e| format!("{ERR_INTERNAL}: workspace registry lock poisoned: {e}"))?;
        for canonical in &canonical_paths {
            let in_recent = inner.recent.iter().any(|item| paths_equal(item, canonical));
            if !in_recent && !is_default_app_root(canonical) {
                return Err(format!(
                    "{ERR_WORKSPACE_NOT_GRANTED}: workspace not in recent list: `{}`",
                    canonical.display()
                ));
            }
        }

        let previous_active = inner
            .active
            .and_then(|index| inner.roots.get(index))
            .map(|root| root.path.clone());

        let mut next_recent = inner.recent.clone();
        for canonical in &canonical_paths {
            if !next_recent.iter().any(|item| paths_equal(item, canonical)) {
                next_recent.push(canonical.clone());
            }
        }
        if next_recent != inner.recent {
            persist_recent_list(&inner.config_dir, &next_recent)?;
        }

        for canonical in &canonical_paths {
            inner
                .roots
                .retain(|root| !paths_equal(&root.path, canonical));
            inner.roots.push(WorkspaceRoot {
                path: canonical.clone(),
                source: RegisterSource::RecentList,
            });
        }
        inner.active = if activate_primary {
            inner
                .roots
                .iter()
                .position(|root| paths_equal(&root.path, &primary_canonical))
        } else {
            previous_active.and_then(|active_path| {
                inner
                    .roots
                    .iter()
                    .position(|root| paths_equal(&root.path, &active_path))
            })
        };
        inner.recent = next_recent;
        Ok(RegisteredWorkspaceBatch {
            primary: primary_canonical,
            roots: canonical_paths,
        })
    }

    /// 在 native dialog 回调已交付路径后批量登记；此方法不接受 IPC 参数。
    ///
    /// 多选先完整验证，再一次持锁更新根、recent 与活动根，避免部分注册。选择
    /// “添加文件夹”时 `activate_first=false`，保持当前活动根；创建项目时则激活首选根。
    fn register_dialog_paths(
        &self,
        paths: &[PathBuf],
        activate_first: bool,
    ) -> Result<Vec<PathBuf>, String> {
        // 显式 PathBuf 标注：首个使用点是 .iter()（paths_equal 形参 &Path），
        // 无标注时推断会把元素类型统一成未加尺寸的 Path（编译错误）。
        let mut canonical_paths: Vec<PathBuf> = Vec::with_capacity(paths.len());
        for path in paths {
            if path.as_os_str().is_empty() {
                return Err(format!("{ERR_WORKSPACE_NOT_GRANTED}: path is empty"));
            }
            let path_str = path.to_string_lossy();
            if path_str.contains('\0') {
                return Err(format!(
                    "{ERR_WORKSPACE_NOT_GRANTED}: path contains NUL byte"
                ));
            }
            let canonical = canonicalize_root(path).map_err(|e| {
                format!(
                    "{ERR_WORKSPACE_NOT_GRANTED}: cannot resolve workspace root `{path_str}`: {e}"
                )
            })?;
            if !canonical.is_dir() {
                return Err(format!(
                    "{ERR_WORKSPACE_NOT_GRANTED}: not a directory: `{}`",
                    canonical.display()
                ));
            }
            canonical_paths.push(canonical);
        }

        if canonical_paths.is_empty() {
            return Ok(canonical_paths);
        }

        let mut inner = self
            .inner
            .lock()
            .map_err(|e| format!("{ERR_INTERNAL}: workspace registry lock poisoned: {e}"))?;
        let previous_active = inner
            .active
            .and_then(|index| inner.roots.get(index))
            .map(|root| root.path.clone());
        let mut next_recent = inner.recent.clone();
        for canonical in &canonical_paths {
            if !next_recent.iter().any(|item| paths_equal(item, canonical)) {
                next_recent.push(canonical.clone());
            }
        }
        if next_recent != inner.recent {
            persist_recent_list(&inner.config_dir, &next_recent)?;
        }

        for canonical in &canonical_paths {
            inner
                .roots
                .retain(|root| !paths_equal(&root.path, canonical));
            inner.roots.push(WorkspaceRoot {
                path: canonical.clone(),
                source: RegisterSource::Dialog,
            });
        }
        inner.recent = next_recent;

        let target_active = if activate_first {
            canonical_paths.first()
        } else {
            previous_active.as_ref()
        };
        inner.active = target_active.and_then(|path| {
            inner
                .roots
                .iter()
                .position(|root| paths_equal(&root.path, path))
        });
        Ok(canonical_paths)
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
        let inner = self.inner.lock().map_err(|e| {
            FileCommandError::new(
                ERR_INTERNAL,
                format!("workspace registry lock poisoned: {e}"),
            )
        })?;
        if inner.roots.is_empty() {
            return Err(FileCommandError::new(
                ERR_OUTSIDE_WORKSPACE,
                "No authorized workspace root is registered.",
            ));
        }

        let requested = requested.trim();
        if requested.is_empty() {
            let root = active_root_path(&inner)?;
            return WorkspaceFsGuard::new(root).map_err(|e| {
                FileCommandError::new(
                    ERR_INTERNAL,
                    format!("authorized workspace root is unreachable: {}", e.message),
                )
            });
        }

        let requested_path = Path::new(requested);
        if !requested_path.is_absolute() {
            // 相对路径以活动根为基准；守卫内部的 resolve_existing 再校验 `..`/符号链接
            let root = active_root_path(&inner)?;
            return WorkspaceFsGuard::new(root).map_err(|e| {
                FileCommandError::new(
                    ERR_INTERNAL,
                    format!("authorized workspace root is unreachable: {}", e.message),
                )
            });
        }

        // 绝对路径：先 canonicalize（剥离 \\?\ 前缀、解析符号链接），再前缀匹配
        let canonical = requested_path.canonicalize().map_err(|e| {
            if e.kind() == std::io::ErrorKind::NotFound {
                FileCommandError::new(ERR_NOT_FOUND, "Path does not exist.")
            } else {
                FileCommandError::new(ERR_READ_FILE, format!("Failed to resolve path: {e}"))
            }
        })?;
        for root in &inner.roots {
            if path_is_same_or_child(&canonical, &root.path) {
                return WorkspaceFsGuard::new(&root.path).map_err(|e| {
                    FileCommandError::new(
                        ERR_INTERNAL,
                        format!("authorized workspace root is unreachable: {}", e.message),
                    )
                });
            }
        }
        Err(FileCommandError::new(
            ERR_OUTSIDE_WORKSPACE,
            "Path is outside the allowed workspace root.",
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

    /// 激活已登记的默认应用工作区根，不接收 renderer 路径，也不创建新授权。
    pub(crate) fn activate_default_root(&self) -> Result<PathBuf, String> {
        let app_dir = crate::host_paths::app_dir()?;
        let default_root = crate::host_paths::workspace_root(&app_dir);
        self.activate_registered_root(&default_root)
    }

    fn activate_registered_root(&self, path: &Path) -> Result<PathBuf, String> {
        let canonical = canonicalize_root(path).map_err(|e| {
            format!("{ERR_WORKSPACE_NOT_GRANTED}: cannot resolve default workspace root: {e}")
        })?;
        let mut inner = self
            .inner
            .lock()
            .map_err(|e| format!("{ERR_INTERNAL}: workspace registry lock poisoned: {e}"))?;
        let index = inner
            .roots
            .iter()
            .position(|root| paths_equal(&root.path, &canonical))
            .ok_or_else(|| {
                format!(
                    "{ERR_WORKSPACE_NOT_GRANTED}: default workspace root is not registered: `{}`",
                    canonical.display()
                )
            })?;
        inner.active = Some(index);
        Ok(inner.roots[index].path.clone())
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
fn canonicalize_root(path: &Path) -> Result<PathBuf, String> {
    let canonical = path
        .canonicalize()
        .map_err(|e| format!("failed to canonicalize `{}`: {e}", path.display()))?;
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

/// 工作区配置目录（对齐 config/persistence.rs 的 config_dir 语义）：
/// `CRISH_WORKBENCH_CONFIG_DIR` → `%APPDATA%\Crish\AgentWorkbench` → temp 兜底。
fn workspace_config_dir() -> PathBuf {
    if let Ok(path) = std::env::var("CRISH_WORKBENCH_CONFIG_DIR") {
        let trimmed = path.trim();
        if !trimmed.is_empty() {
            return PathBuf::from(trimmed);
        }
    }
    if let Ok(app_data) = std::env::var("APPDATA") {
        let trimmed = app_data.trim();
        if !trimmed.is_empty() {
            return PathBuf::from(trimmed).join("Crish").join("AgentWorkbench");
        }
    }
    std::env::temp_dir().join("crish-agent-workbench")
}

/// 加载 recent 列表：文件缺失/损坏 → 空列表，不 panic（T07.2 用例 7）。
fn load_recent_list(config_dir: &Path) -> Vec<PathBuf> {
    let path = config_dir.join(RECENT_FILE_NAME);
    let Ok(text) = std::fs::read_to_string(&path) else {
        return Vec::new();
    };
    let parsed: Result<Vec<String>, _> = serde_json::from_str(&text);
    let Ok(list) = parsed else {
        return Vec::new();
    };
    list.into_iter().map(PathBuf::from).collect()
}

/// recent 列表落盘：tmp + rename（原子替换，损坏不会留下半截文件）。
fn persist_recent_list(config_dir: &Path, recent: &[PathBuf]) -> Result<(), String> {
    std::fs::create_dir_all(config_dir).map_err(|e| {
        format!("{ERR_WORKSPACE_NOT_GRANTED}: cannot create workspace config directory: {e}")
    })?;
    let target = config_dir.join(RECENT_FILE_NAME);
    let tmp = target.with_extension("json.tmp");
    let list: Vec<String> = recent
        .iter()
        .map(|p| p.to_string_lossy().into_owned())
        .collect();
    let text = serde_json::to_string_pretty(&list).map_err(|e| {
        format!("{ERR_WORKSPACE_NOT_GRANTED}: cannot serialize workspace history: {e}")
    })?;
    std::fs::write(&tmp, text)
        .map_err(|e| format!("{ERR_WORKSPACE_NOT_GRANTED}: cannot write workspace history: {e}"))?;
    std::fs::rename(&tmp, &target).map_err(|e| {
        format!("{ERR_WORKSPACE_NOT_GRANTED}: cannot commit workspace history: {e}")
    })?;
    Ok(())
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
) -> Result<(), String> {
    crate::asset_scope::allow_registered_workspace_roots(app, roots.iter().cloned())
        .map_err(|error| format!("工作区已登记，但 asset 协议授权同步失败：{error}"))
}

/// 复授权命令：只接受 recent 列表或默认应用根；其 path 不产生新授权。
#[tauri::command]
pub(crate) fn workbench_open_workspace(
    app: tauri::AppHandle,
    path: String,
) -> Result<OpenWorkspaceResult, String> {
    let reg = registry(&app).map_err(|e| format!("{}: {}", e.code, e.message))?;
    let canonical = reg.register(Path::new(&path), RegisterSource::RecentList)?;
    sync_asset_scope(&app, std::slice::from_ref(&canonical))?;
    Ok(OpenWorkspaceResult {
        path: canonical.to_string_lossy().into_owned(),
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
) -> Result<OpenWorkspaceResult, String> {
    let reg = registry(&app).map_err(|e| format!("{}: {}", e.code, e.message))?;
    let paths: Vec<PathBuf> = paths.into_iter().map(PathBuf::from).collect();
    let registered =
        reg.register_recent_paths(&paths, Path::new(&primary_path), activate_primary)?;
    sync_asset_scope(&app, &registered.roots)?;
    Ok(OpenWorkspaceResult {
        path: registered.primary.to_string_lossy().into_owned(),
    })
}

/// 切回 Rust 内部注册的默认应用工作区根；不接受 renderer 提供的路径。
#[tauri::command]
pub(crate) fn workbench_activate_default_workspace(
    app: tauri::AppHandle,
) -> Result<OpenWorkspaceResult, String> {
    let reg = registry(&app).map_err(|e| format!("{}: {}", e.code, e.message))?;
    let canonical = reg.activate_default_root()?;
    sync_asset_scope(&app, std::slice::from_ref(&canonical))?;
    Ok(OpenWorkspaceResult {
        path: canonical.to_string_lossy().into_owned(),
    })
}

/// 列出当前已授权根，供 UI 状态同步。
#[tauri::command]
pub(crate) fn workbench_list_workspaces(app: tauri::AppHandle) -> Result<Vec<String>, String> {
    let reg = registry(&app).map_err(|e| format!("{}: {}", e.code, e.message))?;
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
) -> Result<Option<Vec<PathBuf>>, String> {
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
        .map_err(|_| "原生文件夹选择器未返回结果".to_string())?
    else {
        return Ok(None);
    };

    selected
        .into_iter()
        .map(|path| {
            path.into_path()
                .map_err(|e| format!("无法读取原生选择的文件夹路径: {e}"))
        })
        .collect::<Result<Vec<_>, _>>()
        .map(Some)
}

/// 只允许由原生 dialog 结果调用；None 代表取消且不改注册表。
fn register_native_dialog_selection(
    registry: &WorkspaceRegistry,
    selected: Option<Vec<PathBuf>>,
    activate_first: bool,
) -> Result<Option<Vec<PathBuf>>, String> {
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
) -> Result<Option<Vec<PathBuf>>, String> {
    let registered = register_native_dialog_selection(registry, selected, activate_first)?;
    if let Some(roots) = registered.as_ref().filter(|paths| !paths.is_empty()) {
        sync_asset_scope(app, roots)?;
    }
    Ok(registered)
}

/// 用户在 Rust 侧原生目录选择器中选出的项目根；命令无 path 参数。
#[tauri::command]
pub(crate) async fn workbench_pick_workspace_folder(
    app: tauri::AppHandle,
) -> Result<Option<String>, String> {
    let selected = select_native_folder_paths(&app, "选择项目文件夹", false).await?;
    let registry = registry(&app).map_err(|e| format!("{}: {}", e.code, e.message))?;
    let paths = register_native_dialog_selection_and_sync(&app, &registry, selected, true)?;
    Ok(paths
        .and_then(|mut paths| paths.pop())
        .map(|path| path.to_string_lossy().into_owned()))
}

/// 用户在 Rust 侧原生多选目录选择器中选出的项目根；命令只收是否激活首选根。
#[tauri::command]
pub(crate) async fn workbench_pick_workspace_folders(
    app: tauri::AppHandle,
    activate_first: bool,
) -> Result<Option<Vec<String>>, String> {
    let selected = select_native_folder_paths(&app, "选择项目文件夹", true).await?;
    let registry = registry(&app).map_err(|e| format!("{}: {}", e.code, e.message))?;
    register_native_dialog_selection_and_sync(&app, &registry, selected, activate_first).map(
        |paths| {
            paths.map(|paths| {
                paths
                    .into_iter()
                    .map(|path| path.to_string_lossy().into_owned())
                    .collect()
            })
        },
    )
}

#[cfg(test)]
mod tests {
    // G2 禁令豁免：测试临时目录清理（非产品删除路径，可恢复语义不适用）。
    #![allow(clippy::disallowed_methods)]

    use super::*;
    use std::fs;
    use std::time::{SystemTime, UNIX_EPOCH};

    /// 临时目录（测试后自动清理）
    struct TestDir {
        path: PathBuf,
    }

    impl TestDir {
        fn new() -> Self {
            let base = std::env::temp_dir();
            for attempt in 0..100 {
                let nanos = SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .expect("system time before UNIX_EPOCH")
                    .as_nanos();
                let path = base.join(format!(
                    "conex-workspace-registry-{}-{nanos}-{attempt}",
                    std::process::id()
                ));
                if fs::create_dir(&path).is_ok() {
                    return Self { path };
                }
            }
            panic!("failed to create temporary test directory");
        }

        fn path(&self) -> &Path {
            &self.path
        }
    }

    impl Drop for TestDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.path);
        }
    }

    /// 构造注册表：默认根指向临时目录（绕过 host_paths 默认根），
    /// 避免测试耦合真实仓库路径。
    fn make_root_registry(root: &Path, config_dir: &Path) -> WorkspaceRegistry {
        let reg = WorkspaceRegistry::init_with_config_dir(config_dir).expect("init registry");
        let _ = reg;
        // 通过 register(RecentList) 需要 recent 预置；这里直接构造含默认根的注册表
        let inner = RegistryInner {
            roots: vec![WorkspaceRoot {
                path: root.to_path_buf(),
                source: RegisterSource::DefaultAppRoot,
            }],
            active: Some(0),
            recent: Vec::new(),
            config_dir: config_dir.to_path_buf(),
        };
        WorkspaceRegistry {
            inner: Mutex::new(inner),
        }
    }

    #[test]
    fn activate_default_root_restores_registered_root_after_project_switch() {
        let temp = TestDir::new();
        let default_root = temp.path().join("default-root");
        let project_root = temp.path().join("active-project");
        fs::create_dir(&default_root).expect("create default root");
        fs::create_dir(&project_root).expect("create project root");
        let config_dir = temp.path().join("config");
        fs::create_dir(&config_dir).expect("create config dir");

        let reg = make_root_registry(&default_root, &config_dir);
        let project = reg
            .register_dialog_paths(std::slice::from_ref(&project_root), true)
            .expect("register selected project")
            .remove(0);
        assert_eq!(reg.active_root(), Some(project));

        let activated = reg
            .activate_registered_root(&default_root)
            .expect("registered default root should reactivate");
        let canonical_default =
            strip_verbatim_prefix(&default_root.canonicalize().expect("canonical default root"));
        assert_eq!(activated, canonical_default);
        assert_eq!(reg.active_root(), Some(canonical_default));
    }

    #[test]
    fn activate_default_root_rejects_unregistered_path_without_mutation() {
        let temp = TestDir::new();
        let active_root = temp.path().join("active-project");
        let unregistered_root = temp.path().join("unregistered-root");
        fs::create_dir(&active_root).expect("create active root");
        fs::create_dir(&unregistered_root).expect("create unregistered root");
        let config_dir = temp.path().join("config");
        fs::create_dir(&config_dir).expect("create config dir");

        let reg = make_root_registry(&active_root, &config_dir);
        let roots_before = reg.roots();
        let active_before = reg.active_root();

        let error = reg
            .activate_registered_root(&unregistered_root)
            .expect_err("unregistered root must not be activated");

        assert!(error.contains(ERR_WORKSPACE_NOT_GRANTED));
        assert_eq!(reg.roots(), roots_before);
        assert_eq!(reg.active_root(), active_before);
    }

    /// T07.2 用例 3：register(Dialog) 后根内读写成功（注册返回 canonical 路径）。
    #[test]
    fn register_dialog_returns_canonical_path() {
        let temp = TestDir::new();
        let root = temp.path().join("project");
        fs::create_dir(&root).expect("create root");
        let reg = WorkspaceRegistry::init_with_config_dir(temp.path()).expect("init");

        let canonical = reg
            .register(&root, RegisterSource::Dialog)
            .expect("dialog register should succeed");
        assert!(canonical.is_absolute());
        assert_eq!(
            canonical,
            strip_verbatim_prefix(&root.canonicalize().expect("canonical root"))
        );
    }

    /// 原生 picker 的回调路径进入注册表后可执行沙箱写入，未选路径仍被拒绝。
    #[test]
    fn native_dialog_selection_authorizes_guarded_write_only_for_selected_root() {
        let temp = TestDir::new();
        let selected_root = temp.path().join("selected-project");
        let unselected_root = temp.path().join("unselected-project");
        fs::create_dir(&selected_root).expect("create selected root");
        fs::create_dir(&unselected_root).expect("create unselected root");
        let reg = WorkspaceRegistry::init_with_config_dir(&temp.path().join("config"))
            .expect("init registry");

        let selected =
            register_native_dialog_selection(&reg, Some(vec![selected_root.clone()]), true)
                .expect("register selected root")
                .expect("selection result");
        let canonical = selected[0].clone();
        let guard = reg
            .resolve_guard(&canonical.to_string_lossy())
            .expect("selected root must resolve through the workspace guard");
        crate::fs_commands::write::write_file_content_with_guard(
            &guard,
            "authorized.txt",
            "selected by native dialog",
            false,
        )
        .expect("guarded write inside selected root");
        assert_eq!(
            fs::read_to_string(canonical.join("authorized.txt")).expect("read guarded file"),
            "selected by native dialog"
        );

        let err = reg
            .register(&unselected_root, RegisterSource::RecentList)
            .expect_err("arbitrary unselected root must not be reauthorized");
        assert!(err.starts_with(ERR_WORKSPACE_NOT_GRANTED), "err: {err}");
        assert_eq!(
            reg.resolve_guard(&unselected_root.to_string_lossy())
                .expect_err("unselected root must be outside the guard")
                .code,
            ERR_OUTSIDE_WORKSPACE
        );
    }

    /// 成功的原生 picker 注册会把且仅把注册表授权根同步到 asset 协议。
    #[test]
    fn native_dialog_selection_syncs_asset_scope_for_registered_root() {
        let temp = TestDir::new();
        let selected_root = temp.path().join("selected-project");
        let unselected_root = temp.path().join("unselected-project");
        fs::create_dir(&selected_root).expect("create selected root");
        fs::create_dir(&unselected_root).expect("create unselected root");
        let registry = WorkspaceRegistry::init_with_config_dir(&temp.path().join("config"))
            .expect("init registry");
        let app = tauri::test::mock_builder()
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .expect("build mock Tauri app");

        let result = register_native_dialog_selection_and_sync(
            app.handle(),
            &registry,
            Some(vec![selected_root.clone()]),
            true,
        )
        .expect("register and scope selected root");

        assert!(result.is_some());
        assert!(app
            .asset_protocol_scope()
            .is_allowed(selected_root.join("image.png")));
        assert!(!app
            .asset_protocol_scope()
            .is_allowed(unselected_root.join("secret.png")));
    }

    /// 失效的旧根不应阻止本次成功注册的新根同步到 asset scope。
    #[test]
    fn native_dialog_selection_syncs_new_root_when_old_registered_root_is_unavailable() {
        let temp = TestDir::new();
        let old_root = temp.path().join("old-project");
        let new_root = temp.path().join("new-project");
        fs::create_dir(&old_root).expect("create old root");
        fs::create_dir(&new_root).expect("create new root");
        let registry = WorkspaceRegistry::init_with_config_dir(&temp.path().join("config"))
            .expect("init registry");
        registry
            .register_dialog_paths(std::slice::from_ref(&old_root), true)
            .expect("register old root");
        fs::remove_dir_all(&old_root).expect("remove old root");
        let app = tauri::test::mock_builder()
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .expect("build mock Tauri app");

        register_native_dialog_selection_and_sync(
            app.handle(),
            &registry,
            Some(vec![new_root.clone()]),
            true,
        )
        .expect("register new root despite unavailable old root");

        assert!(app
            .asset_protocol_scope()
            .is_allowed(new_root.join("image.png")));
        assert!(!app
            .asset_protocol_scope()
            .is_allowed(old_root.join("secret.png")));
    }

    /// RecentList 复授权成功后同步 asset scope，不依赖旧进程内的授权状态。
    #[test]
    fn opening_recent_workspace_syncs_asset_scope() {
        let temp = TestDir::new();
        let root = temp.path().join("recent-project");
        fs::create_dir(&root).expect("create recent root");
        let config_dir = temp.path().join("config");
        fs::create_dir(&config_dir).expect("create config dir");
        fs::write(
            config_dir.join(RECENT_FILE_NAME),
            serde_json::to_string(&vec![root.to_string_lossy().to_string()]).expect("json"),
        )
        .expect("write recent workspace");
        let registry = WorkspaceRegistry::init_with_config_dir(&config_dir).expect("init registry");
        let app = tauri::test::mock_builder()
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .expect("build mock Tauri app");
        assert!(!app
            .asset_protocol_scope()
            .is_allowed(root.join("image.png")));
        let registered = registry
            .register(&root, RegisterSource::RecentList)
            .expect("recent workspace reauthorization");
        sync_asset_scope(app.handle(), std::slice::from_ref(&registered))
            .expect("sync recent workspace asset scope");

        assert!(app
            .asset_protocol_scope()
            .is_allowed(root.join("image.png")));
    }

    /// 原生 picker 取消不注册根、不更新 recent，也不创建持久化文件。
    #[test]
    fn native_dialog_cancel_has_no_registry_or_persistence_side_effects() {
        let temp = TestDir::new();
        let config_dir = temp.path().join("config");
        let reg = WorkspaceRegistry::init_with_config_dir(&config_dir).expect("init registry");
        let roots_before = reg.roots();
        let recent_before = reg.inner.lock().expect("lock registry").recent.clone();

        let app = tauri::test::mock_builder()
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .expect("build mock Tauri app");
        let asset_scope_before = app.asset_protocol_scope().allowed_patterns();
        let result = register_native_dialog_selection_and_sync(app.handle(), &reg, None, true)
            .expect("cancel should be a successful no-op");

        assert_eq!(result, None);
        assert_eq!(reg.roots(), roots_before);
        assert_eq!(
            reg.inner.lock().expect("lock registry").recent,
            recent_before
        );
        assert!(!config_dir.join(RECENT_FILE_NAME).exists());
        assert_eq!(
            app.asset_protocol_scope().allowed_patterns(),
            asset_scope_before
        );
    }

    /// 原生多选先校验全部路径；任一无效项都不得留下部分授权。
    #[test]
    fn native_dialog_multi_selection_validation_is_atomic() {
        let temp = TestDir::new();
        let valid_root = temp.path().join("valid-project");
        fs::create_dir(&valid_root).expect("create valid root");
        let invalid_root = temp.path().join("missing-project");
        let config_dir = temp.path().join("config");
        let reg = WorkspaceRegistry::init_with_config_dir(&config_dir).expect("init registry");
        let roots_before = reg.roots();

        let app = tauri::test::mock_builder()
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .expect("build mock Tauri app");
        let asset_scope_before = app.asset_protocol_scope().allowed_patterns();
        let err = register_native_dialog_selection_and_sync(
            app.handle(),
            &reg,
            Some(vec![valid_root.clone(), invalid_root]),
            true,
        )
        .expect_err("missing selected root must reject the batch");

        assert!(err.starts_with(ERR_WORKSPACE_NOT_GRANTED), "err: {err}");
        assert_eq!(reg.roots(), roots_before);
        assert!(!config_dir.join(RECENT_FILE_NAME).exists());
        assert_eq!(
            app.asset_protocol_scope().allowed_patterns(),
            asset_scope_before
        );
    }

    /// recent 持久化失败时注册失败，不能提前扩展 asset scope。
    #[test]
    fn native_dialog_persistence_failure_does_not_expand_asset_scope() {
        let temp = TestDir::new();
        let selected_root = temp.path().join("selected-project");
        fs::create_dir(&selected_root).expect("create selected root");
        let config_path_is_file = temp.path().join("config-file");
        fs::write(&config_path_is_file, "not a directory").expect("create config file");
        let registry =
            WorkspaceRegistry::init_with_config_dir(&config_path_is_file).expect("init registry");
        let roots_before = registry.roots();
        let app = tauri::test::mock_builder()
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .expect("build mock Tauri app");
        let asset_scope_before = app.asset_protocol_scope().allowed_patterns();

        let error = register_native_dialog_selection_and_sync(
            app.handle(),
            &registry,
            Some(vec![selected_root.clone()]),
            true,
        )
        .expect_err("failed recent persistence must reject registration");

        assert!(
            error.starts_with(ERR_WORKSPACE_NOT_GRANTED),
            "error: {error}"
        );
        assert_eq!(registry.roots(), roots_before);
        assert_eq!(
            app.asset_protocol_scope().allowed_patterns(),
            asset_scope_before
        );
    }

    /// T07.2 用例 5：workbench_open_workspace("C:\")（不在 recent，非默认根）→ workspace_not_granted。
    #[test]
    fn open_workspace_rejects_non_recent_absolute_path() {
        let temp = TestDir::new();
        let reg = WorkspaceRegistry::init_with_config_dir(temp.path()).expect("init");
        let err = reg
            .register(Path::new(r"C:\"), RegisterSource::RecentList)
            .expect_err("non-recent path must be rejected");
        assert!(err.starts_with(ERR_WORKSPACE_NOT_GRANTED), "err: {err}");
    }

    /// T07.2 用例 5 变体：恶意诱导路径（根盘符）不得授权。
    #[test]
    fn open_workspace_rejects_drive_root() {
        let temp = TestDir::new();
        let reg = WorkspaceRegistry::init_with_config_dir(temp.path()).expect("init");
        #[cfg(windows)]
        let evil = "C:\\";
        #[cfg(not(windows))]
        let evil = "/";
        let err = reg
            .register(Path::new(evil), RegisterSource::RecentList)
            .expect_err("drive root must be rejected");
        assert!(err.starts_with(ERR_WORKSPACE_NOT_GRANTED), "err: {err}");
    }

    /// T07.2 用例 6：workbench_open_workspace(recent 内路径) → 成功复授权。
    #[test]
    fn open_workspace_reauthorizes_recent_path() {
        let temp = TestDir::new();
        let root = temp.path().join("project");
        fs::create_dir(&root).expect("create root");
        let config_dir = temp.path().join("config");
        fs::create_dir(&config_dir).expect("create config dir");
        // 预置 recent 文件（模拟上次会话授权记录）
        let recent_path = config_dir.join(RECENT_FILE_NAME);
        fs::write(
            &recent_path,
            serde_json::to_string(&vec![root.to_string_lossy().to_string()]).expect("json"),
        )
        .expect("write recent file");

        let reg = WorkspaceRegistry::init_with_config_dir(&config_dir).expect("init");
        let canonical = reg
            .register(&root, RegisterSource::RecentList)
            .expect("recent path should be re-authorized");
        assert_eq!(
            canonical,
            strip_verbatim_prefix(&root.canonicalize().expect("canonical root"))
        );
        // 授权成功后回写 recent 文件仍存在且含该路径
        let persisted: Vec<String> =
            serde_json::from_str(&fs::read_to_string(&recent_path).expect("read recent"))
                .expect("parse recent");
        assert!(persisted.contains(&root.to_string_lossy().to_string()));
    }

    /// 重启后多目录项目的 recent 根可整批复授权，primary 成为活动根。
    #[test]
    fn recent_batch_reauthorizes_all_project_roots_and_activates_primary() {
        let temp = TestDir::new();
        let primary = temp.path().join("project-primary");
        let secondary = temp.path().join("project-secondary");
        fs::create_dir(&primary).expect("create primary root");
        fs::create_dir(&secondary).expect("create secondary root");
        let config_dir = temp.path().join("config");
        fs::create_dir(&config_dir).expect("create config dir");
        let recent_file = config_dir.join(RECENT_FILE_NAME);
        fs::write(
            &recent_file,
            serde_json::to_string(&vec![
                primary.to_string_lossy().into_owned(),
                secondary.to_string_lossy().into_owned(),
            ])
            .expect("serialize recent roots"),
        )
        .expect("write recent roots");

        let reg = WorkspaceRegistry::init_with_config_dir(&config_dir).expect("init registry");
        let registered = reg
            .register_recent_paths(&[primary.clone(), secondary.clone()], &primary, true)
            .expect("all recent roots should authorize together");
        let app = tauri::test::mock_builder()
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .expect("build mock Tauri app");
        sync_asset_scope(app.handle(), &registered.roots)
            .expect("sync every canonical recent root");
        assert!(app
            .asset_protocol_scope()
            .is_allowed(primary.join("image.png")));
        assert!(app
            .asset_protocol_scope()
            .is_allowed(secondary.join("image.png")));

        let canonical_primary = registered.primary;
        assert_eq!(registered.roots.len(), 2);

        assert_eq!(
            canonical_primary,
            strip_verbatim_prefix(&primary.canonicalize().expect("canonical primary"))
        );
        assert_eq!(reg.active_root(), Some(canonical_primary));
        assert_eq!(
            reg.resolve_guard(&secondary.to_string_lossy())
                .expect("secondary root must be registered")
                .root(),
            &strip_verbatim_prefix(&secondary.canonicalize().expect("canonical secondary"))
        );
    }

    /// 修改非活动项目时仍整批登记所有 recent 根，但不得改变当前活动根。
    #[test]
    fn recent_batch_can_preserve_active_root_for_inactive_project_edit() {
        let temp = TestDir::new();
        let active = temp.path().join("active-project");
        let primary = temp.path().join("inactive-primary");
        let secondary = temp.path().join("inactive-secondary");
        fs::create_dir(&active).expect("create active root");
        fs::create_dir(&primary).expect("create primary root");
        fs::create_dir(&secondary).expect("create secondary root");
        let config_dir = temp.path().join("config");
        fs::create_dir(&config_dir).expect("create config dir");

        let reg = WorkspaceRegistry::init_with_config_dir(&config_dir).expect("init registry");
        let active = reg
            .register_dialog_paths(&[active], true)
            .expect("register current native selection")
            .remove(0);
        reg.register_dialog_paths(&[primary.clone(), secondary.clone()], false)
            .expect("register inactive project roots without switching");
        assert_eq!(reg.active_root(), Some(active.clone()));

        let registered = reg
            .register_recent_paths(&[primary.clone(), secondary.clone()], &primary, false)
            .expect("reauthorize every inactive project root");
        let canonical_primary = registered.primary;
        assert_eq!(registered.roots.len(), 2);

        assert_eq!(
            canonical_primary,
            strip_verbatim_prefix(&primary.canonicalize().expect("canonical primary"))
        );
        assert_eq!(reg.active_root(), Some(active));
        assert!(reg.resolve_guard(&secondary.to_string_lossy()).is_ok());
    }

    /// 多目录复授权只要有一个未在 recent/default，整批不得改 registry 或 recent 文件。
    #[test]
    fn recent_batch_rejects_untrusted_root_without_partial_state_change() {
        let temp = TestDir::new();
        let trusted = temp.path().join("recent-root");
        let untrusted = temp.path().join("untrusted-root");
        fs::create_dir(&trusted).expect("create trusted root");
        fs::create_dir(&untrusted).expect("create untrusted root");
        let config_dir = temp.path().join("config");
        fs::create_dir(&config_dir).expect("create config dir");
        let recent_file = config_dir.join(RECENT_FILE_NAME);
        let recent_json = serde_json::to_string(&vec![trusted.to_string_lossy().into_owned()])
            .expect("serialize recent root");
        fs::write(&recent_file, &recent_json).expect("write recent root");

        let reg = WorkspaceRegistry::init_with_config_dir(&config_dir).expect("init registry");
        let roots_before = reg.roots();
        let active_before = reg.active_root();

        let err = reg
            .register_recent_paths(
                &[trusted, untrusted],
                &temp.path().join("recent-root"),
                true,
            )
            .expect_err("one untrusted root must reject the entire batch");

        assert!(err.starts_with(ERR_WORKSPACE_NOT_GRANTED), "err: {err}");
        assert_eq!(reg.roots(), roots_before);
        assert_eq!(reg.active_root(), active_before);
        assert_eq!(
            fs::read_to_string(recent_file).expect("read recent"),
            recent_json
        );
    }

    /// T07.2 用例 7：recent-workspaces.json 损坏/缺失 → 空列表 + 不 panic。
    #[test]
    fn corrupt_recent_file_yields_empty_list() {
        let temp = TestDir::new();
        let config_dir = temp.path().join("config");
        fs::create_dir(&config_dir).expect("create config dir");
        fs::write(config_dir.join(RECENT_FILE_NAME), "not-valid-json{{{{")
            .expect("write corrupt recent");
        let reg = WorkspaceRegistry::init_with_config_dir(&config_dir).expect("init");
        // 损坏的 recent 不应使注册表初始化失败
        let inner = reg.inner.lock().expect("lock");
        assert!(inner.recent.is_empty());
    }

    /// T07.2 用例 1：未授权根外绝对路径 → ERR_OUTSIDE_WORKSPACE。
    #[test]
    fn resolve_guard_rejects_absolute_path_outside_all_roots() {
        let temp = TestDir::new();
        let root = temp.path().join("workspace");
        fs::create_dir(&root).expect("create root");
        let outside = temp.path().join("outside");
        fs::create_dir(&outside).expect("create outside");
        let reg = make_root_registry(&root, temp.path());

        let err = reg
            .resolve_guard(&outside.to_string_lossy())
            .expect_err("outside path must be rejected");
        assert_eq!(err.code, ERR_OUTSIDE_WORKSPACE);
    }

    /// T07.2 用例 11：drive-relative 变体（`C:foo`）不得放行到系统盘。
    #[cfg(windows)]
    #[test]
    fn resolve_guard_handles_drive_relative_path() {
        let temp = TestDir::new();
        let root = temp.path().join("workspace");
        fs::create_dir(&root).expect("create root");
        let reg = make_root_registry(&root, temp.path());

        // drive-relative（`C:foo`）在 Rust 中非绝对路径 → 以活动根为基准，
        // 守卫内部包含性校验保证不越界（不得误放行到系统盘）。
        let guard = reg
            .resolve_guard("C:foo")
            .expect("drive-relative resolves against active root");
        // 注意：resolve_existing 对不存在的路径返回 ERR_NOT_FOUND（未越界）
        let err = guard.resolve_existing("C:foo").expect_err("not exists");
        assert_eq!(err.code, crate::fs_commands::types::ERR_NOT_FOUND);
    }

    /// T07.2 用例 12：UNC / `\\?\` 前缀路径 canonicalize 后越界判定一致（拒绝）。
    #[cfg(windows)]
    #[test]
    fn resolve_guard_rejects_unc_and_verbatim_prefix() {
        let temp = TestDir::new();
        let root = temp.path().join("workspace");
        fs::create_dir(&root).expect("create root");
        let reg = make_root_registry(&root, temp.path());

        // 不存在的 UNC 路径：canonicalize 失败 → 拒绝（not_found / read_file / outside 均可）
        let err = reg
            .resolve_guard(r"\\server\share\some\file.txt")
            .expect_err("UNC must not be granted");
        assert_ne!(err.code, ERR_INTERNAL, "err: {:?}", err.code);
        // `\\?\` 前缀路径同样拒绝
        let verbatim = format!(r"\\?\{}\\nested.txt", root.to_string_lossy());
        let err = reg
            .resolve_guard(&verbatim)
            .expect_err("verbatim path must not be granted");
        assert_ne!(err.code, ERR_INTERNAL, "err: {:?}", err.code);
    }

    /// T07.2 用例 13：根不可达（canonicalize 全失败）→ 拒绝 + 明确错误，不裸用传入根。
    #[test]
    fn register_rejects_unreachable_root() {
        let temp = TestDir::new();
        let reg = WorkspaceRegistry::init_with_config_dir(temp.path()).expect("init");
        let missing = temp.path().join("no-such-drive-root");
        let err = reg
            .register(&missing, RegisterSource::Dialog)
            .expect_err("unreachable root must be rejected");
        assert!(err.starts_with(ERR_WORKSPACE_NOT_GRANTED), "err: {err}");
        assert!(err.contains("cannot resolve"), "err: {err}");
    }

    /// 相对路径解析：以活动根为基准，`..` 越界由守卫二次校验拒绝。
    #[test]
    fn resolve_guard_relative_paths_join_active_root() {
        let temp = TestDir::new();
        let root = temp.path().join("workspace");
        fs::create_dir(&root).expect("create root");
        fs::create_dir(root.join("nested")).expect("create nested");
        let reg = make_root_registry(&root, temp.path());

        let guard = reg
            .resolve_guard("")
            .expect("empty path resolves to active root");
        assert_eq!(
            guard.root(),
            &strip_verbatim_prefix(&root.canonicalize().expect("canon"))
        );

        let guard = reg
            .resolve_guard("nested")
            .expect("relative path resolves to active root");
        assert_eq!(
            guard.root(),
            &strip_verbatim_prefix(&root.canonicalize().expect("canon"))
        );
    }

    /// 根内子目录绝对路径：前缀匹配授权。
    #[test]
    fn resolve_guard_allows_path_inside_root() {
        let temp = TestDir::new();
        let root = temp.path().join("workspace");
        fs::create_dir_all(root.join("src")).expect("create root");
        let inside = root.join("src").join("main.rs");
        fs::write(&inside, "fn main() {}").expect("write file");
        let reg = make_root_registry(&root, temp.path());

        let guard = reg
            .resolve_guard(&inside.to_string_lossy())
            .expect("path inside root must resolve");
        assert_eq!(
            guard.root(),
            &strip_verbatim_prefix(&root.canonicalize().expect("canon"))
        );
    }

    /// 根前缀相似但不包含（`/home/proj` vs `/home/proj2` 语义）→ 拒绝。
    #[test]
    fn resolve_guard_rejects_sibling_prefix_path() {
        let temp = TestDir::new();
        let root = temp.path().join("workspace");
        fs::create_dir(&root).expect("create root");
        let sibling = temp.path().join("workspace2");
        fs::create_dir(&sibling).expect("create sibling");
        let reg = make_root_registry(&root, temp.path());

        let err = reg
            .resolve_guard(&sibling.to_string_lossy())
            .expect_err("sibling prefix path must be rejected");
        assert_eq!(err.code, ERR_OUTSIDE_WORKSPACE);
    }

    /// 多根：任一已授权根内路径均可解析。
    #[test]
    fn resolve_guard_accepts_any_authorized_root() {
        let temp = TestDir::new();
        let root_a = temp.path().join("proj-a");
        let root_b = temp.path().join("proj-b");
        fs::create_dir_all(root_a.join("sub")).expect("create a");
        fs::create_dir_all(root_b.join("sub")).expect("create b");
        let file_b = root_b.join("sub").join("note.txt");
        fs::write(&file_b, "b").expect("write b");
        let reg = WorkspaceRegistry::init_with_config_dir(temp.path()).expect("init");
        reg.register(&root_a, RegisterSource::Dialog)
            .expect("register a");
        reg.register(&root_b, RegisterSource::Dialog)
            .expect("register b");

        let guard = reg
            .resolve_guard(&file_b.to_string_lossy())
            .expect("file under root_b must resolve");
        assert_eq!(
            guard.root(),
            &strip_verbatim_prefix(&root_b.canonicalize().expect("canon"))
        );
    }
}
