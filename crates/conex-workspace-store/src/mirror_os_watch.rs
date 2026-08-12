//! W2-E · OS 级 mirror 路径监视（notify 封装 / A-INV-02 事件方向）。
//!
//! # 模块内聚（SD-19 · 黄带体积切开）
//! - **本文件**：OS 事件模型 / `MirrorOsWatcher` / Fake / detect·poll 胶水
//! - [`tests`]（`mirror_os_watch_tests.rs`）：单元测外置
//! - 接线：`#[path]` 子模，无孤儿；公开 API 路径不变（`crate::mirror_os_watch::*` / `lib` `pub use`）
//!
//! # 与 poll 子集的关系（并存，不互抹，≠ 默认双开）
//! - 既有 [`crate::MirrorWatchHandle`] / [`crate::MirrorWatcher`] / [`crate::poll_mirror_once`]
//!   是 **进程内指纹轮询**（上层 timer 驱动）。
//! - **本模块**交付 **OS FS 事件订阅入口**（`notify::RecommendedWatcher` → 通道事件）。
//! - 二者 **可组合**：OS 事件作「唤醒 hint」→ 再调 `detect_mirror_drift` / poll 分类。
//! - **禁止**默认双开 poll+OS：本模块不自动同时启动 poll watcher；上层按需择一或显式组合。
//! - **禁止**用「有 poll」冒充「inotify 满关」，也 **禁止**用「有本模块」冒充产品三路 UI / EL-03。
//!
//! # 诚实边界（不可冒充）
//! - **SD-19** · **≠ EL-03** · **≠ inotify 产品满关** · poll 并存但 **≠** 默认双开
//! - **交付**：可点名的 OS 事件 watcher 封装（notify trait/API + 可测通道）。
//! - **≠ poll API 已等于 inotify 满关**——poll 仍是独立子集；本模块是 **另一路径**。
//! - **≠ A-INV-02 产品 UI**：不弹三路对话框、不接线桌面订阅层。
//! - **≠ EL-03**（恢复/打开/PERF 数值叙事属 G-HYD / W3 / W6-C，不在本模块）。
//! - **≠ 产品全链路**：无 IPC、无 timer 产品装配、无静默 import；事件仅 hint。
//! - **≠** 整文件拷贝 `conex-fs::WorkspaceWatcher`（逃逸追踪职责）；本模块窄面向 mirror 路径。
//!
//! # 不变量
//! 1. mirror **非**权威；OS 事件 **不**授权读 exports 当 get_md。
//! 2. 事件后分类/提案仍走 [`WorkspaceStore::detect_mirror_drift`] /
//!    [`WorkspaceStore::import_mirror_proposal`]；本模块 **从不** apply。
//! 3. X-05 仍由 import 侧强制；本模块不绕过 unpushed 门禁。

use super::mirror::{MirrorDriftReport, MirrorWatchPollResult};
use super::{StoreError, WorkspaceStore};
use notify::event::{ModifyKind, RemoveKind, RenameMode};
use notify::{EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::mpsc;
use std::time::Duration;
use thiserror::Error;

// ─── 事件模型 ──────────────────────────────────────────────────────────────

/// OS 侧 mirror 路径变更种类（窄于 `conex-fs` 逃逸追踪 wire；仅 mirror 方向）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MirrorOsEventKind {
    /// 内容或元数据修改。
    Modified,
    /// 新建（含 rename-to）。
    Created,
    /// 删除（含 rename-from）。
    Removed,
    /// 无法精确归类、但路径相关的 hint（上层应 re-detect / poll）。
    RescanHint,
}

/// 单条 OS mirror 路径事件（notify 回调归一化后）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MirrorOsEvent {
    /// 事件路径（尽量绝对化；Windows 已剥 `\\?\`）。
    pub path: PathBuf,
    pub kind: MirrorOsEventKind,
}

// ─── 错误 ──────────────────────────────────────────────────────────────────

/// OS watcher 创建/注册失败（与 [`StoreError`] 分离：监视失败 ≠ 权威库错误）。
#[derive(Debug, Error)]
pub enum MirrorOsWatchError {
    #[error("mirror OS watcher: 路径无效或无父目录: {0}")]
    InvalidPath(String),
    #[error("mirror OS watcher: notify 创建失败: {0}")]
    NotifyCreate(String),
    #[error("mirror OS watcher: 注册监视失败 ({path}): {detail}")]
    Watch {
        path: String,
        detail: String,
    },
}

// ─── 事件源 trait（可注入） ────────────────────────────────────────────────

/// OS 事件源抽象：生产 [`MirrorOsWatcher`]；测试可注入 [`FakeMirrorOsEventSource`]。
///
/// **诚实**：实现本 trait **≠** EL-03 / **≠** 产品 UI；仅保证「可收事件」。
pub trait MirrorOsEventSource {
    /// 非阻塞取一条事件；通道空返回 `None`。
    fn try_recv_event(&mut self) -> Option<MirrorOsEvent>;

    /// 带超时等待一条事件；超时返回 `None`。
    fn recv_event_timeout(&mut self, timeout: Duration) -> Option<MirrorOsEvent>;
}

// ─── notify 封装 ───────────────────────────────────────────────────────────

/// mirror 路径 OS 监视器（`notify::RecommendedWatcher`）。
///
/// - 对每个 interest 文件：监视其 **父目录**（非递归），过滤到 interest 集合；
/// - 也可直接监视目录（interest 为空时放行该目录下全部路径事件）。
///
/// Drop 即停止监视（notify 句柄释放）。
///
/// # 诚实
/// - 本类型 = **OS 事件订阅入口**，**不是**「poll 满关 inotify」叙事替换。
/// - **≠** A-INV-02 UI；**≠** EL-03。
pub struct MirrorOsWatcher {
    /// 持有防 Drop 停监视。
    _watcher: RecommendedWatcher,
    rx: mpsc::Receiver<MirrorOsEvent>,
    /// 关注的文件路径（规范化比较键）；空 = 放行已 watch 目录下全部。
    interest_keys: HashSet<String>,
    /// 已注册监视的父目录（调试/测试可取）。
    watched_dirs: Vec<PathBuf>,
}

impl MirrorOsWatcher {
    /// 监视单个 mirror 文件路径（实际 watch 父目录并过滤到该文件）。
    pub fn watch_mirror_file(path: impl AsRef<Path>) -> Result<Self, MirrorOsWatchError> {
        Self::watch_mirror_files([path.as_ref().to_path_buf()])
    }

    /// 监视多条 mirror 文件路径（去重父目录注册；事件过滤到 interest）。
    pub fn watch_mirror_files<I, P>(paths: I) -> Result<Self, MirrorOsWatchError>
    where
        I: IntoIterator<Item = P>,
        P: AsRef<Path>,
    {
        let mut interest_keys = HashSet::new();
        let mut parents: HashSet<String> = HashSet::new();
        let mut parent_paths: Vec<PathBuf> = Vec::new();

        for p in paths {
            let p = p.as_ref();
            if p.as_os_str().is_empty() {
                return Err(MirrorOsWatchError::InvalidPath("空路径".into()));
            }
            let abs = normalize_abs_path(p);
            interest_keys.insert(path_compare_key(&abs));

            let parent = abs.parent().ok_or_else(|| {
                MirrorOsWatchError::InvalidPath(format!("无父目录: {}", abs.display()))
            })?;
            // 父目录须存在（export 后通常已有）；不存在则尝试 create_dir_all 不在本职责——报错
            if !parent.is_dir() {
                return Err(MirrorOsWatchError::InvalidPath(format!(
                    "父目录不存在: {}",
                    parent.display()
                )));
            }
            let parent_n = normalize_abs_path(parent);
            let key = path_compare_key(&parent_n);
            if parents.insert(key) {
                parent_paths.push(parent_n);
            }
        }

        if parent_paths.is_empty() {
            return Err(MirrorOsWatchError::InvalidPath(
                "未提供任何可监视路径".into(),
            ));
        }

        Self::start_inner(parent_paths, interest_keys)
    }

    /// 监视目录（非递归）；`interest` 非空时仅放行命中文件，空则放行目录下全部。
    pub fn watch_dir(
        dir: impl AsRef<Path>,
        interest_files: impl IntoIterator<Item = impl AsRef<Path>>,
    ) -> Result<Self, MirrorOsWatchError> {
        let dir = dir.as_ref();
        if !dir.is_dir() {
            return Err(MirrorOsWatchError::InvalidPath(format!(
                "目录不存在: {}",
                dir.display()
            )));
        }
        let dir_n = normalize_abs_path(dir);
        let mut interest_keys = HashSet::new();
        for p in interest_files {
            interest_keys.insert(path_compare_key(&normalize_abs_path(p.as_ref())));
        }
        Self::start_inner(vec![dir_n], interest_keys)
    }

    fn start_inner(
        watch_dirs: Vec<PathBuf>,
        interest_keys: HashSet<String>,
    ) -> Result<Self, MirrorOsWatchError> {
        let (tx, rx) = mpsc::channel::<MirrorOsEvent>();
        let interest_for_cb = interest_keys.clone();

        let mut watcher = RecommendedWatcher::new(
            move |res: notify::Result<notify::Event>| {
                let Ok(event) = res else {
                    return;
                };
                for (path, kind) in classify_notify_event(&event) {
                    let path = normalize_abs_path(&path);
                    if !interest_allows(&interest_for_cb, &path) {
                        continue;
                    }
                    let _ = tx.send(MirrorOsEvent { path, kind });
                }
            },
            notify::Config::default(),
        )
        .map_err(|e| MirrorOsWatchError::NotifyCreate(e.to_string()))?;

        for dir in &watch_dirs {
            watcher
                .watch(dir, RecursiveMode::NonRecursive)
                .map_err(|e| MirrorOsWatchError::Watch {
                    path: dir.display().to_string(),
                    detail: e.to_string(),
                })?;
        }

        Ok(Self {
            _watcher: watcher,
            rx,
            interest_keys,
            watched_dirs: watch_dirs,
        })
    }

    /// 已注册的监视目录。
    pub fn watched_dirs(&self) -> &[PathBuf] {
        &self.watched_dirs
    }

    /// 关注文件比较键集合大小（测试/诊断；空 interest = 目录全放行）。
    pub fn interest_len(&self) -> usize {
        self.interest_keys.len()
    }

    /// 非阻塞接收。
    pub fn try_recv(&self) -> Option<MirrorOsEvent> {
        self.rx.try_recv().ok()
    }

    /// 带超时接收。
    pub fn recv_timeout(&self, timeout: Duration) -> Option<MirrorOsEvent> {
        self.rx.recv_timeout(timeout).ok()
    }

    /// 排空当前通道中已排队事件（测试去抖 / 启动后清噪声）。
    pub fn drain(&self) -> Vec<MirrorOsEvent> {
        let mut out = Vec::new();
        while let Ok(ev) = self.rx.try_recv() {
            out.push(ev);
        }
        out
    }
}

impl MirrorOsEventSource for MirrorOsWatcher {
    fn try_recv_event(&mut self) -> Option<MirrorOsEvent> {
        self.try_recv()
    }

    fn recv_event_timeout(&mut self, timeout: Duration) -> Option<MirrorOsEvent> {
        self.recv_timeout(timeout)
    }
}

// ─── Fake（可证伪 / 单测不绑内核） ─────────────────────────────────────────

/// 测试注入用事件源（**不是** OS inotify；用于 trait 契约测）。
///
/// **诚实**：Fake 绿 **≠** OS watcher 生产满关；真 OS 路径见
/// [`os_watcher_emits_event_on_mirror_file_write`]。
#[derive(Debug, Default)]
pub struct FakeMirrorOsEventSource {
    queue: std::collections::VecDeque<MirrorOsEvent>,
}

impl FakeMirrorOsEventSource {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn push(&mut self, event: MirrorOsEvent) {
        self.queue.push_back(event);
    }

    pub fn push_modified(&mut self, path: impl Into<PathBuf>) {
        self.push(MirrorOsEvent {
            path: path.into(),
            kind: MirrorOsEventKind::Modified,
        });
    }
}

impl MirrorOsEventSource for FakeMirrorOsEventSource {
    fn try_recv_event(&mut self) -> Option<MirrorOsEvent> {
        self.queue.pop_front()
    }

    fn recv_event_timeout(&mut self, _timeout: Duration) -> Option<MirrorOsEvent> {
        self.queue.pop_front()
    }
}

// ─── 与 detect 的胶水（不 apply） ──────────────────────────────────────────

/// 若 OS 事件路径命中该 doc 当前 mirror path，则跑 [`WorkspaceStore::detect_mirror_drift`]。
///
/// - 命中 → `Some(report)`（含三路分类）
/// - 未命中 / 无 meta path → `Ok(None)`（事件与本 doc 无关）
///
/// **诚实**：
/// - **不** apply / **不** import；仅 detect。
/// - **≠** A-INV-02 产品 UI；**≠** EL-03。
/// - **≠**「有 poll 即 inotify」——本函数消费的是 **OS 事件 hint**，与 poll 并行。
pub fn detect_if_os_event_hits_mirror(
    store: &WorkspaceStore,
    doc_id: &str,
    authority_rev: u64,
    event: &MirrorOsEvent,
) -> Result<Option<MirrorDriftReport>, StoreError> {
    let report = store.detect_mirror_drift(doc_id, authority_rev)?;
    if report.path.as_os_str().is_empty() {
        return Ok(None);
    }
    if paths_equal_for_mirror(&report.path, &event.path) {
        Ok(Some(report))
    } else {
        Ok(None)
    }
}

/// OS 事件命中后：用 [`crate::MirrorWatchHandle::poll_mirror_once`] 刷新指纹基线并得完整 poll 结果。
///
/// 组合路径：`OS hint → poll/detect`；**仍 ≠** 产品 UI / EL-03。
pub fn poll_on_os_hint(
    handle: &mut crate::MirrorWatchHandle,
    store: &WorkspaceStore,
    authority_rev: u64,
    event: &MirrorOsEvent,
) -> Result<Option<MirrorWatchPollResult>, StoreError> {
    let report = store.detect_mirror_drift(handle.doc_id(), authority_rev)?;
    if report.path.as_os_str().is_empty() {
        return Ok(None);
    }
    if !paths_equal_for_mirror(&report.path, &event.path) {
        return Ok(None);
    }
    // 命中后走既有 poll（指纹 + 分类）；不绕过 X-05 / detect
    let r = handle.poll_mirror_once(store, authority_rev)?;
    Ok(Some(r))
}

// ─── notify 分类 / 路径工具 ────────────────────────────────────────────────

fn classify_notify_event(event: &notify::Event) -> Vec<(PathBuf, MirrorOsEventKind)> {
    let kind = match event.kind {
        EventKind::Create(_) => MirrorOsEventKind::Created,
        EventKind::Remove(RemoveKind::File)
        | EventKind::Remove(RemoveKind::Any)
        | EventKind::Remove(RemoveKind::Folder)
        | EventKind::Remove(RemoveKind::Other) => MirrorOsEventKind::Removed,
        EventKind::Modify(ModifyKind::Name(RenameMode::From)) => MirrorOsEventKind::Removed,
        EventKind::Modify(ModifyKind::Name(RenameMode::To)) => MirrorOsEventKind::Created,
        EventKind::Modify(ModifyKind::Data(_))
        | EventKind::Modify(ModifyKind::Metadata(_))
        | EventKind::Modify(ModifyKind::Any)
        | EventKind::Modify(ModifyKind::Other) => MirrorOsEventKind::Modified,
        EventKind::Modify(ModifyKind::Name(RenameMode::Both)) => {
            // from + to：分别标 Removed / Created
            if event.paths.len() >= 2 {
                return vec![
                    (event.paths[0].clone(), MirrorOsEventKind::Removed),
                    (event.paths[1].clone(), MirrorOsEventKind::Created),
                ];
            }
            MirrorOsEventKind::RescanHint
        }
        EventKind::Modify(ModifyKind::Name(RenameMode::Any))
        | EventKind::Modify(ModifyKind::Name(RenameMode::Other)) => MirrorOsEventKind::RescanHint,
        EventKind::Access(_) | EventKind::Any | EventKind::Other => {
            return Vec::new();
        }
    };
    event
        .paths
        .iter()
        .map(|p| (p.clone(), kind))
        .collect()
}

fn interest_allows(interest: &HashSet<String>, path: &Path) -> bool {
    if interest.is_empty() {
        return true;
    }
    interest.contains(&path_compare_key(path))
}

fn paths_equal_for_mirror(a: &Path, b: &Path) -> bool {
    path_compare_key(a) == path_compare_key(b)
}

/// 规范化绝对路径：canonicalize 失败则原样；Windows 剥 `\\?\`。
fn normalize_abs_path(p: &Path) -> PathBuf {
    let abs = if p.is_absolute() {
        p.to_path_buf()
    } else {
        std::env::current_dir()
            .map(|cwd| cwd.join(p))
            .unwrap_or_else(|_| p.to_path_buf())
    };
    let canon = abs.canonicalize().unwrap_or(abs);
    strip_verbatim(&canon)
}

fn strip_verbatim(p: &Path) -> PathBuf {
    let s = p.to_string_lossy();
    #[cfg(windows)]
    {
        if let Some(rest) = s.strip_prefix(r"\\?\UNC\") {
            return PathBuf::from(format!(r"\\{rest}"));
        }
        if let Some(rest) = s.strip_prefix(r"\\?\") {
            return PathBuf::from(rest.to_string());
        }
    }
    #[cfg(not(windows))]
    {
        let _ = &s;
    }
    p.to_path_buf()
}

/// 路径比较键：统一分隔符 + Windows 小写。
fn path_compare_key(p: &Path) -> String {
    let mut s = p.to_string_lossy().replace('\\', "/");
    #[cfg(windows)]
    {
        s = s.to_lowercase();
    }
    if s.len() > 1 {
        s = s.trim_end_matches('/').to_string();
    }
    s
}

#[cfg(test)]
#[path = "mirror_os_watch_tests.rs"]
mod tests;
