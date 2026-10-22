//! 工作区文件监视（T-ESC-01 数据面：脚本逃逸追踪的 watcher 服务）
//!
//! 逃逸追踪主方案（docs/feature-gap-analysis/REQ-逃逸追踪分析.md §3）：
//! run 期间用 notify 8 实时监视工作区文件变更，产出 [FileChangeEvent]
//! 事件流（经 mpsc 通道），供 session-loop 装配层的消费循环聚合判定
//! （T-ESC-02 判定面消费）。
//!
//! - `ChangeKind` / `FileChangeEvent` / `UndeclaredWrite`：wire 契约形状
//!   （serde 属性与 REQ-逃逸追踪分析 §3.2 逐字一致）；
//! - `WorkspaceWatcher`：notify 8 封装——递归监视 + 排除清单（相对目录
//!   前缀 + glob）+ 事件通道 + Rename 聚合（删除+新建配对为 Renamed）。
//!
//! 平台说明（§5.4 风险）：notify 8 在 Windows 用 ReadDirectoryChangesW，
//! rename 常表现为 Remove+Create 两事件（或 Modify(Name(From/To))），
//! 本模块以 [RENAME_WINDOW_MS] 时间窗做路径配对（同父目录约束），
//! 窗口外独立发射；配对不保证跨平台一致（Windows 实测见测试）。

use notify::event::{ModifyKind, RenameMode};
use notify::{EventKind, RecursiveMode, Watcher};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

/// Rename 聚合窗口（毫秒）：窗口内 Remove → Create 配对为 Renamed。
/// 默认 2000ms（独立删除后短期内重建同名文件会被聚合为 Renamed，
/// 语义上同样带破坏性，可接受；测试用 [WorkspaceWatcher::start_with_window]
/// 收紧窗口加速用例）。
pub const RENAME_WINDOW_MS: i64 = 2000;

/// 事件通道容量（1024：run 期间普通构建规模下不阻塞 notify 回调）
const CHANNEL_CAPACITY: usize = 1024;

/// 变更类型（wire kebab-case）
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ChangeKind {
    /// 内容修改（Modify）
    Modified,
    /// 新建（Create）
    Created,
    /// 删除（Remove）
    Removed,
    /// 改名（Rename：from → to，删除+新建聚合）
    Renamed,
}

/// 判定路径是否属于系统内部原子落盘的临时/备份文件或瞬态文件
#[inline]
pub fn is_internal_atomic_transient_path(path: &Path) -> bool {
    let Some(file_name) = path.file_name().and_then(|n| n.to_str()) else {
        return false;
    };
    let lower = file_name.to_lowercase();
    lower.starts_with(".conex-tmp-")
        || lower.starts_with(".conex-bak-")
        || lower.starts_with(".agent-tmp-")
        || lower.starts_with(".crish-tmp-")
        || lower.starts_with(".crish-tmp")
        || lower.contains(".conex-tmp-")
        || lower.contains(".conex-bak-")
        || lower.contains(".agent-tmp-")
        || lower.contains(".crish-tmp-")
}

/// 底层自然过滤器（watcher_filter）：供 OS watcher 过滤内部瞬态文件
#[inline]
pub fn watcher_filter(path: &Path) -> bool {
    is_internal_atomic_transient_path(path)
}

/// 单条工作区文件变更（watcher 产出，判定前）
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileChangeEvent {
    /// 规范化绝对路径（symlink 已解析、工作区内、Windows 大小写折叠）
    pub path: PathBuf,
    /// 变更类型
    pub kind: ChangeKind,
    /// 改名场景的源路径（kind == Renamed 时 Some）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub from: Option<PathBuf>,
    /// 事件发生时刻（纪元毫秒，对齐全仓 epoch ms 惯例）
    pub occurred_at_ms: i64,
}

/// 未声明写入归因报告（判定后、审计前）
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UndeclaredWrite {
    /// 会话标识
    pub session_id: String,
    /// run 标识（信封注入，事件体可留空由 emit 层填）
    pub run_id: String,
    /// 聚合后的变更清单（同 run 同路径去重、按时间排序）
    pub changes: Vec<FileChangeEvent>,
    /// 时间窗起点（第一个变更时刻）
    pub first_occurred_at_ms: i64,
    /// 时间窗终点（最后一个变更时刻，事件发射时刻）
    pub last_occurred_at_ms: i64,
    /// 变更文件数（聚合后）
    pub file_count: usize,
    /// 是否含删除/改名类（高风险标记，供 UI 着色）
    pub has_destructive: bool,
}

/// 待配对删除记录（Rename 聚合中间态：Remove 先到，等窗口内 Create）
#[derive(Debug, Clone)]
struct PendingRemove {
    /// 规范化绝对路径（待配对源路径）
    path: PathBuf,
    /// 预计算的归一化比较键（避免配对与排重时重复分配）
    norm_key: String,
    /// 删除事件时刻（纪元毫秒）
    occurred_at_ms: i64,
}

/// 待配对删除共享队列（notify 回调与 flush 线程共享；锁中毒按项目
/// 约定恢复式处理：记录错误、取回内值继续，不 panic）
type PendingRemoves = std::sync::Arc<std::sync::Mutex<Vec<PendingRemove>>>;

/// flush 线程轮询间隔（毫秒）：删除转正的实时性粒度
const FLUSH_POLL_MS: u64 = 100;

/// KFS-07：高频同路径同类事件防抖合并时间窗（毫秒）。
///
/// 密集写入或单次落盘触发多次 OS 通知（如 Data + Metadata + Any）时，
/// 窗口内对同路径同类型事件执行前沿发射 + 尾随排重，防止通道溢出与广播风暴。
pub const DEBOUNCE_WINDOW_MS: i64 = 50;

/// 防抖状态表最大容量上限（超出时惰性淘汰过期项，确保内存严格 $O(1)$ 有界）
const MAX_DEBOUNCE_ENTRIES: usize = 1024;

/// KFS-07：对一批文件变更事件执行同路径状态机合并排重（保序输出）。
///
/// 合并规则：
/// - `Created` + `Modified` -> 保持 `Created`（更新时间戳）；
/// - `Modified` + `Modified` -> 合并为单条最新 `Modified`；
/// - `Renamed` + `Modified` -> 保持 `Renamed`（更新时间戳）；
/// - 任意状态 + `Removed` -> 收敛为 `Removed`；
/// - `Removed` + `Created`（同路径重建） -> 收敛为 `Modified`。
pub fn coalesce_file_events(
    events: impl IntoIterator<Item = FileChangeEvent>,
) -> Vec<FileChangeEvent> {
    let iter = events.into_iter();
    let (lower, _) = iter.size_hint();
    let mut index_by_key: std::collections::HashMap<String, usize> =
        std::collections::HashMap::with_capacity(lower);
    let mut merged: Vec<Option<FileChangeEvent>> = Vec::with_capacity(lower);

    for ev in iter {
        if ev.kind == ChangeKind::Renamed {
            if let Some(ref from_path) = ev.from {
                let from_key = normalize_for_compare(from_path);
                if let Some(&prev_idx) = index_by_key.get(&from_key) {
                    // 若源路径此前在同一批次中已有未配对的 Removed，移除该中间态
                    if merged[prev_idx]
                        .as_ref()
                        .is_some_and(|prev| prev.kind == ChangeKind::Removed)
                    {
                        merged[prev_idx] = None;
                        index_by_key.remove(&from_key);
                    }
                }
            }
        }

        let key = normalize_for_compare(&ev.path);
        if let Some(&idx) = index_by_key.get(&key) {
            if let Some(existing) = merged[idx].as_mut() {
                existing.occurred_at_ms = existing.occurred_at_ms.max(ev.occurred_at_ms);
                existing.path = ev.path;
                match (existing.kind, ev.kind) {
                    (ChangeKind::Created, ChangeKind::Modified) => {
                        // 新建后紧跟修改：仍视为新建
                    }
                    (ChangeKind::Renamed, ChangeKind::Modified) => {
                        // 改名后紧跟修改：保留改名及源路径
                    }
                    (ChangeKind::Removed, ChangeKind::Created) => {
                        // 删除后同路径重建：收敛为内容修改
                        existing.kind = ChangeKind::Modified;
                        existing.from = None;
                    }
                    (_, ChangeKind::Renamed) => {
                        existing.kind = ChangeKind::Renamed;
                        existing.from = ev.from;
                    }
                    (_, next_kind) => {
                        existing.kind = next_kind;
                        if next_kind != ChangeKind::Renamed {
                            existing.from = None;
                        }
                    }
                }
                continue;
            }
        }

        let idx = merged.len();
        merged.push(Some(ev));
        index_by_key.insert(key, idx);
    }

    merged.into_iter().flatten().collect()
}

/// 工作区文件监视服务（notify 8 封装）
///
/// 结构字段与 REQ-逃逸追踪分析 §3.2 逐字一致：`excludes_glob` 为排除
/// glob 配置位（当前 start 恒为空，P3 装配面注入）；`tx` 是通道持有锚
/// （Sender 被持有则通道保持打开，消费方 recv 不会提前返回 None）。
pub struct WorkspaceWatcher {
    /// 监视根（规范化绝对路径）
    root: PathBuf,
    /// 排除根（相对工作区）
    exclude: Vec<PathBuf>,
    /// 排除 glob（如 "**/*.snap"；start 时为空，P3 装配面按需注入）
    // G11a 备注：P3 装配面注入预留（当前 start 恒为空）——接线后移除。
    #[allow(dead_code)]
    excludes_glob: Vec<String>,
    /// 事件通道发送端（持有锚：防通道随 Sender drop 提前关闭）
    // G11a 备注：通道持有锚（Sender 被持有则通道保持打开）——无读取消费者，
    // 结构语义注释见上。
    #[allow(dead_code)]
    tx: tokio::sync::mpsc::Sender<FileChangeEvent>,
    /// 待配对删除共享队列（stop 时 flush 剩余条目用；flush 线程经
    /// WeakSender 生命周期自动退出，无需显式停止信号）
    pending_removes: PendingRemoves,
    /// notify 句柄（持有防 Drop 停监视；Drop 即停止，兜底）
    _watcher: notify::RecommendedWatcher,
}

impl WorkspaceWatcher {
    /// 启动监视（run 开始调用）；返回事件接收端
    pub fn start(
        root: impl Into<PathBuf>,
        exclude: Vec<PathBuf>,
    ) -> anyhow::Result<(Self, tokio::sync::mpsc::Receiver<FileChangeEvent>)> {
        Self::start_with_window(root, exclude, RENAME_WINDOW_MS)
    }

    /// 启动监视并指定 Rename 聚合窗口（毫秒；测试与装配面可收紧）
    ///
    /// `exclude` 为相对工作区的目录列表（组件级前缀匹配，Windows
    /// 大小写折叠）；`rename_window_ms` 为 Remove → Create 配对的
    /// 时间窗，窗口越短误配对越少、独立删除的 Removed 发射越及时。
    pub fn start_with_window(
        root: impl Into<PathBuf>,
        exclude: Vec<PathBuf>,
        rename_window_ms: i64,
    ) -> anyhow::Result<(Self, tokio::sync::mpsc::Receiver<FileChangeEvent>)> {
        let root = root.into();
        let root = normalize_abs_path(&root);
        if !root.is_dir() {
            anyhow::bail!("watcher 根目录不存在：{}", root.display());
        }
        let (tx, rx) = tokio::sync::mpsc::channel(CHANNEL_CAPACITY);
        let pending_removes: PendingRemoves =
            std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        let mut state = WatcherState::new(
            tx.clone(),
            root.clone(),
            exclude.clone(),
            pending_removes.clone(),
            rename_window_ms,
        );
        let watcher = notify::RecommendedWatcher::new(
            move |res: notify::Result<notify::Event>| state.handle(res),
            notify::Config::default(),
        )
        .map_err(|e| anyhow::anyhow!("notify watcher 创建失败：{e}"))?;
        let mut watcher = watcher;
        watcher
            .watch(&root, RecursiveMode::Recursive)
            .map_err(|e| anyhow::anyhow!("notify 监视注册失败（{}）：{e}", root.display()))?;
        // flush 线程：周期检查待配对删除队列，超窗条目转正发射 Removed。
        // 生命周期经 WeakSender 管理：WorkspaceWatcher drop（唯一强引用
        // 消失）后 upgrade 失败自动退出，无需显式停止信号。
        spawn_flush_loop(tx.downgrade(), pending_removes.clone(), rename_window_ms);
        Ok((
            Self {
                root,
                exclude,
                excludes_glob: Vec::new(),
                tx,
                pending_removes,
                _watcher: watcher,
            },
            rx,
        ))
    }

    /// 停止监视（run 结束调用；Drop 兜底）
    ///
    /// 解除根监视并 flush 剩余待配对删除（run 收口：不再等待 Create，
    /// 窗口内未配对的 Remove 立即转正为 Removed）；此后不再有新事件
    /// 回调，通道中已排队的事件由消费方按 run 收口 flush 或随
    /// receiver drop 丢弃（停止后无新事件语义）；句柄随 Drop 销毁，
    /// 通知线程自然停止，flush 线程经 WeakSender 失效自动退出。
    pub fn stop(&mut self) {
        // 解除监视失败不阻断收口：句柄随 Drop 销毁，但必须留痕以便定位监视泄漏
        if let Err(err) = self._watcher.unwatch(&self.root) {
            tracing::warn!(
                error = %err,
                root = %self.root.display(),
                "注销监视根失败，句柄将随 Drop 销毁"
            );
        }
        let now = epoch_millis_now();
        let leftover: Vec<PendingRemove> = {
            let mut inner = lock_pending(&self.pending_removes);
            std::mem::take(&mut *inner)
        };
        for pr in leftover {
            // 收口路径：调用方已不再消费，通道关闭/已满即视为该事件诚实丢失
            if let Err(err) = self.tx.try_send(FileChangeEvent {
                path: pr.path,
                kind: ChangeKind::Removed,
                from: None,
                occurred_at_ms: now,
            }) {
                tracing::debug!(
                    error = %err,
                    "停止监视时 flush 待配对删除事件失败（通道已满或已关闭），该事件丢弃"
                );
            }
        }
    }

    /// 监视根（规范化绝对路径，调试/装配面取用）
    pub fn root(&self) -> &Path {
        &self.root
    }

    /// 排除根列表（相对工作区，与 start 入参一致）
    pub fn exclude(&self) -> &[PathBuf] {
        &self.exclude
    }
}

/// notify 回调状态机（move 进回调闭包；路径过滤 + Rename 聚合 + 防抖排重 + 发射）
struct WatcherState {
    tx: tokio::sync::mpsc::Sender<FileChangeEvent>,
    /// 规范化监视根（排除判定基准）
    root: PathBuf,
    /// KFS-12：构造期预归一化的排除目录列表（消除事件循环内重复字符串分配）
    exclude_norm: Vec<String>,
    /// 排除 glob（"**/*.snap" 形态，路径段级匹配）
    excludes_glob: Vec<String>,
    /// 待配对删除记录（Rename 聚合中间态；flush 线程共享）
    pending_removes: PendingRemoves,
    /// Rename 聚合窗口（毫秒）
    rename_window_ms: i64,
    /// KFS-07：同路径高频事件防抖表（归一化路径 -> (最近发射类型, 时间戳)）
    recent_emits: std::collections::HashMap<String, (ChangeKind, i64)>,
}

impl WatcherState {
    fn new(
        tx: tokio::sync::mpsc::Sender<FileChangeEvent>,
        root: PathBuf,
        exclude: Vec<PathBuf>,
        pending_removes: PendingRemoves,
        rename_window_ms: i64,
    ) -> Self {
        // KFS-12：排除清单在构造期一次性完成绝对化与归一化
        let exclude_norm: Vec<String> = exclude
            .iter()
            .map(|e| {
                let abs = normalize_abs_path(&root.join(e));
                normalize_for_compare(&abs)
            })
            .collect();
        Self {
            tx,
            root,
            exclude_norm,
            excludes_glob: Vec::new(),
            pending_removes,
            rename_window_ms,
            recent_emits: std::collections::HashMap::with_capacity(64),
        }
    }

    /// 处理单条 notify 结果（错误静默丢弃：监视失败不 panic，
    /// 交由 run 收口兜底；事件风暴时通道满则直接忽略发送失败，
    /// 诚实丢失并留待 run 末指纹复核兜底）
    fn handle(&mut self, res: notify::Result<notify::Event>) {
        let Ok(event) = res else {
            return;
        };
        let now = epoch_millis_now();
        match event.kind {
            EventKind::Create(_) => {
                for p in &event.paths {
                    self.emit_create(p, now);
                }
            }
            EventKind::Remove(_) | EventKind::Modify(ModifyKind::Name(RenameMode::From)) => {
                for p in &event.paths {
                    self.pend_remove(p, now);
                }
            }
            EventKind::Modify(ModifyKind::Name(RenameMode::To)) => {
                for p in &event.paths {
                    self.emit_create(p, now);
                }
            }
            EventKind::Modify(ModifyKind::Name(RenameMode::Both)) => {
                if let [from, to] = event.paths.as_slice() {
                    self.emit_renamed(from, to, now);
                }
            }
            EventKind::Modify(ModifyKind::Data(_))
            | EventKind::Modify(ModifyKind::Metadata(_))
            | EventKind::Modify(ModifyKind::Any) => {
                for p in &event.paths {
                    if self.is_excluded(p) {
                        continue;
                    }
                    let abs_path = self.resolve_event_path(p);
                    let norm_key = normalize_for_compare(&abs_path);
                    if !self.should_emit_debounced(norm_key, ChangeKind::Modified, now) {
                        continue;
                    }
                    self.emit(FileChangeEvent {
                        path: abs_path,
                        kind: ChangeKind::Modified,
                        from: None,
                        occurred_at_ms: now,
                    });
                }
            }
            // 访问/元数据类与无法分类事件：不产出（避免误报）
            EventKind::Access(_)
            | EventKind::Any
            | EventKind::Other
            | EventKind::Modify(ModifyKind::Name(RenameMode::Any))
            | EventKind::Modify(ModifyKind::Name(RenameMode::Other))
            | EventKind::Modify(ModifyKind::Other) => {}
        }
    }

    /// KFS-07：判定同路径事件是否通过防抖窗口（前沿立即放行，窗口内重复同类事件合并抑制）
    fn should_emit_debounced(&mut self, norm_key: String, kind: ChangeKind, now: i64) -> bool {
        if let Some(&(last_kind, last_ts)) = self.recent_emits.get(&norm_key) {
            if last_kind == kind && now.saturating_sub(last_ts) < DEBOUNCE_WINDOW_MS {
                return false;
            }
        }
        if self.recent_emits.len() >= MAX_DEBOUNCE_ENTRIES {
            self.recent_emits
                .retain(|_, (_, ts)| now.saturating_sub(*ts) < DEBOUNCE_WINDOW_MS);
            if self.recent_emits.len() >= MAX_DEBOUNCE_ENTRIES {
                self.recent_emits.clear();
            }
        }
        self.recent_emits.insert(norm_key, (kind, now));
        true
    }

    /// KFS-13：纯词法解析事件路径（基于已 canonicalize 的 root，避免回调热路径触发磁盘 I/O）
    #[inline]
    fn resolve_event_path(&self, path: &Path) -> PathBuf {
        let candidate = if path.is_absolute() {
            strip_verbatim(path)
        } else {
            strip_verbatim(&self.root.join(path))
        };
        lexical_clean_path(&candidate)
    }

    /// 删除事件入待配对队列（排除清单过滤先行；同路径去重；flush 线程负责转正）
    fn pend_remove(&mut self, path: &Path, now: i64) {
        if self.is_excluded(path) {
            return;
        }
        let abs_path = self.resolve_event_path(path);
        let norm_key = normalize_for_compare(&abs_path);
        // 删除发生时清除该路径的防抖记录，确保后续同名重建或修改不被误抑制
        self.recent_emits.remove(&norm_key);

        let mut inner = lock_pending(&self.pending_removes);
        if let Some(existing) = inner.iter_mut().find(|pr| pr.norm_key == norm_key) {
            existing.occurred_at_ms = now;
            existing.path = abs_path;
        } else {
            inner.push(PendingRemove {
                path: abs_path,
                norm_key,
                occurred_at_ms: now,
            });
        }
    }

    /// 新建事件：窗口内优先与待配对删除聚合为 Renamed，否则独立 Created
    fn emit_create(&mut self, path: &Path, now: i64) {
        if self.is_excluded(path) {
            return;
        }
        let path = self.resolve_event_path(path);
        // 配对约束：窗口内 + 同父目录（防跨目录独立删除+新建误聚合）
        let parent_key = path.parent().map(normalize_for_compare);
        let mut inner = lock_pending(&self.pending_removes);
        let hit = inner.iter().position(|pr| {
            let age = now - pr.occurred_at_ms;
            age >= 0
                && age <= self.rename_window_ms
                && pr.path.parent().map(normalize_for_compare) == parent_key
        });
        if let Some(idx) = hit {
            let from = inner.remove(idx);
            drop(inner);
            self.emit_renamed_resolved(from.path, path, now);
        } else {
            drop(inner);
            let norm_key = normalize_for_compare(&path);
            if !self.should_emit_debounced(norm_key, ChangeKind::Created, now) {
                return;
            }
            self.emit(FileChangeEvent {
                path,
                kind: ChangeKind::Created,
                from: None,
                occurred_at_ms: now,
            });
        }
    }

    /// 发射 Renamed（from → to；两路径同源时跳过，防自循环事件；瞬态文件排除）
    fn emit_renamed(&mut self, from: &Path, to: &Path, now: i64) {
        if self.is_excluded(from) || self.is_excluded(to) {
            return;
        }
        let from = self.resolve_event_path(from);
        let to = self.resolve_event_path(to);
        self.emit_renamed_resolved(from, to, now);
    }

    fn emit_renamed_resolved(&mut self, from: PathBuf, to: PathBuf, now: i64) {
        let from_key = normalize_for_compare(&from);
        let to_key = normalize_for_compare(&to);
        if from_key == to_key {
            return;
        }
        self.recent_emits.remove(&from_key);
        if !self.should_emit_debounced(to_key, ChangeKind::Renamed, now) {
            return;
        }
        self.emit(FileChangeEvent {
            path: to,
            kind: ChangeKind::Renamed,
            from: Some(from),
            occurred_at_ms: now,
        });
    }

    /// 发射单条事件（通道满/已关闭时丢弃并留痕，不阻塞回调线程）
    fn emit(&mut self, ev: FileChangeEvent) {
        // 事件流按「尽力投递」设计：回调线程不能阻塞，丢事件属已知语义，
        // 但必须可观测（debug 级，高频路径不刷屏）
        if let Err(err) = self.tx.try_send(ev) {
            tracing::debug!(
                error = %err,
                "watcher 事件投递失败（通道满或已关闭），事件丢弃"
            );
        }
    }

    /// 排除判定（KFS-12）：内部瞬态文件过滤、绝对路径命中预归一化排除根或排除 glob 即排除
    fn is_excluded(&self, path: &Path) -> bool {
        if watcher_filter(path) {
            return true;
        }
        if !self.exclude_norm.is_empty() {
            let np = normalize_for_compare(path);
            for ne in &self.exclude_norm {
                if np == *ne
                    || (np.starts_with(ne.as_str())
                        && np.as_bytes().get(ne.len()) == Some(&(MAIN_SEP as u8)))
                {
                    return true;
                }
            }
        }
        if self.excludes_glob.is_empty() {
            return false;
        }
        let rel = path.strip_prefix(&self.root).unwrap_or(path);
        let rel_norm = rel
            .to_string_lossy()
            .replace(['/', '\\'], &MAIN_SEP.to_string());
        self.excludes_glob.iter().any(|g| glob_match(g, &rel_norm))
    }
}

/// 待配对删除队列锁读取（锁中毒恢复：记录错误、取回内值继续，不 panic）
fn lock_pending(shared: &PendingRemoves) -> std::sync::MutexGuard<'_, Vec<PendingRemove>> {
    shared.lock().unwrap_or_else(|e| {
        tracing::error!("watcher 待配对删除队列锁中毒，按恢复模式继续：{e}");
        e.into_inner()
    })
}

/// flush 线程主体：周期检查待配对删除队列，窗口超时条目转正发射
/// Removed（独立删除不等待 Create，保证删除事件的实时产出）
///
/// 生命周期经 WeakSender 管理：`tx` 强引用只有 WorkspaceWatcher 持有，
/// 其 drop 后 `upgrade()` 失败即退出（≤一个轮询周期残留）；
/// `try_send` 失败（通道满/已关闭）静默丢弃（诚实丢失语义）。
fn spawn_flush_loop(
    weak_tx: tokio::sync::mpsc::WeakSender<FileChangeEvent>,
    pending_removes: PendingRemoves,
    rename_window_ms: i64,
) {
    std::thread::spawn(move || {
        loop {
            std::thread::sleep(std::time::Duration::from_millis(FLUSH_POLL_MS));
            let Some(tx) = weak_tx.upgrade() else {
                break;
            };
            let now = epoch_millis_now();
            let expired: Vec<PendingRemove> = {
                let mut inner = lock_pending(&pending_removes);
                let expired: Vec<PendingRemove> = inner
                    .iter()
                    .filter(|pr| now - pr.occurred_at_ms > rename_window_ms)
                    .cloned()
                    .collect();
                inner.retain(|pr| now - pr.occurred_at_ms <= rename_window_ms);
                expired
            };
            for pr in expired {
                // flush 线程按「尽力投递」设计：通道满/已关闭即丢弃，但需可观测
                if let Err(err) = tx.try_send(FileChangeEvent {
                    path: pr.path,
                    kind: ChangeKind::Removed,
                    from: None,
                    occurred_at_ms: now,
                }) {
                    tracing::debug!(
                        error = %err,
                        "flush 线程投递待配对删除事件失败（通道满或已关闭），事件丢弃"
                    );
                }
            }
        }
    });
}

/// 统一分隔符（排除前缀拼接用）
const MAIN_SEP: char = std::path::MAIN_SEPARATOR;

/// 规范化绝对路径（仅用于启动期 root 与配置初始化）：symlink 解析（canonicalize）+ 剥离 `\\?\` verbatim 前缀
fn normalize_abs_path(p: &Path) -> PathBuf {
    let canon = p.canonicalize().unwrap_or_else(|_| p.to_path_buf());
    strip_verbatim(&canon)
}

/// KFS-13：纯词法清理 `.` 与 `..` 组件，不发起任何磁盘系统调用
fn lexical_clean_path(p: &Path) -> PathBuf {
    let mut needs_clean = false;
    for comp in p.components() {
        if matches!(
            comp,
            std::path::Component::CurDir | std::path::Component::ParentDir
        ) {
            needs_clean = true;
            break;
        }
    }
    if !needs_clean {
        return p.to_path_buf();
    }
    let mut out = PathBuf::new();
    for comp in p.components() {
        match comp {
            std::path::Component::CurDir => {}
            std::path::Component::ParentDir => {
                // 纯词法清理：已位于根时无可弹出组件（pop 返回 false），按根保持不变；
                // 该结果不是错误，但记录以区分「路径回退到根之上」的异常输入
                if !out.pop() {
                    tracing::debug!(
                        path = %p.display(),
                        "词法清理遇到根之上的 `..`，已按根路径保持"
                    );
                }
            }
            other => out.push(other.as_os_str()),
        }
    }
    out
}

/// 剥离 `\\?\` / `\\?\UNC\` 前缀（防御性兜底：canonicalize 输出可能带）
fn strip_verbatim(p: &Path) -> PathBuf {
    #[cfg(windows)]
    {
        let s = p.to_string_lossy();
        if let Some(rest) = s.strip_prefix(r"\\?\UNC\") {
            return PathBuf::from(format!("\\{rest}"));
        }
        if let Some(rest) = s.strip_prefix(r"\\?\") {
            return PathBuf::from(rest.to_string());
        }
    }
    p.to_path_buf()
}

/// 归一化路径（用于排除/配对比较）：统一分隔符 + Windows 小写 +
/// 去尾部分隔符，与 write_paths 的 normalize_for_compare 同语义
/// （跨平台确定性一致）
fn normalize_for_compare(p: &Path) -> String {
    let mut s = p
        .to_string_lossy()
        .replace(['/', '\\'], &MAIN_SEP.to_string());
    #[cfg(windows)]
    {
        s = s.to_lowercase();
    }
    if s.len() > 1 {
        s = s.trim_end_matches(std::path::MAIN_SEPARATOR).to_string();
    }
    s
}

/// 跨平台简易 glob 匹配（排除清单用，路径段级）：
///
/// - `*`：段内任意字符序列（不含分隔符）；
/// - `?`：段内单个任意字符；
/// - `**`：跨层通配（支持 `**/` 前缀与裸 `**` 匹配整棵子树）；
/// - 跨平台双斜杠切分：基于 `split(['/', '\\'])` 切分路径与模式；
/// - Windows 平台执行大小写不敏感匹配，消除 Windows 下失效引发的事件风暴。
pub fn glob_match(pattern: &str, path: &str) -> bool {
    let pat_segs: Vec<&str> = pattern
        .split(['/', '\\'])
        .filter(|s| !s.is_empty())
        .collect();
    let path_segs: Vec<&str> = path.split(['/', '\\']).filter(|s| !s.is_empty()).collect();
    // `**` 出现在模式末尾（无尾段）视为整树匹配
    if pat_segs == ["**"] {
        return true;
    }
    glob_segs(&pat_segs, &path_segs)
}

/// glob 段序列匹配（`**` 展开 0..n 段，其余段逐个 glob 匹配）
fn glob_segs(pat: &[&str], path: &[&str]) -> bool {
    match (pat, path) {
        ([], []) => true,
        ([], [_, ..]) => false,
        (["**"], _) => true,
        (_, []) => false,
        (["**", rest @ ..], _) => {
            // `**` 吞 0..n 段后继续匹配剩余模式
            (0..=path.len()).any(|take| glob_segs(rest, &path[take..]))
        }
        ([p, rest @ ..], [s, tail @ ..]) => seg_match(p, s) && glob_segs(rest, tail),
    }
}

/// 单段 glob 匹配（KFS-12：ASCII 快速路径零堆分配 + 双指针迭代匹配避免指数回溯；
/// 多字节路径回退至字符级安全匹配，杜绝非 UTF-8 边界切片 panic）
fn seg_match(pat: &str, s: &str) -> bool {
    if pat.is_ascii() && s.is_ascii() {
        return seg_match_ascii(pat.as_bytes(), s.as_bytes());
    }
    #[cfg(windows)]
    {
        let pat_chars: Vec<char> = pat.chars().flat_map(|c| c.to_lowercase()).collect();
        let s_chars: Vec<char> = s.chars().flat_map(|c| c.to_lowercase()).collect();
        seg_match_chars(&pat_chars, &s_chars)
    }
    #[cfg(not(windows))]
    {
        let pat_chars: Vec<char> = pat.chars().collect();
        let s_chars: Vec<char> = s.chars().collect();
        seg_match_chars(&pat_chars, &s_chars)
    }
}

/// ASCII 字节级线性双指针通配匹配（零堆分配）
fn seg_match_ascii(pat: &[u8], s: &[u8]) -> bool {
    let mut pi = 0usize;
    let mut si = 0usize;
    let mut star_idx: Option<usize> = None;
    let mut match_idx = 0usize;

    while si < s.len() {
        if pi < pat.len() && (pat[pi] == b'?' || ascii_byte_eq(pat[pi], s[si])) {
            pi += 1;
            si += 1;
        } else if pi < pat.len() && pat[pi] == b'*' {
            star_idx = Some(pi);
            match_idx = si;
            pi += 1;
        } else if let Some(star) = star_idx {
            pi = star + 1;
            match_idx += 1;
            si = match_idx;
        } else {
            return false;
        }
    }

    while pi < pat.len() && pat[pi] == b'*' {
        pi += 1;
    }
    pi == pat.len()
}

#[inline]
fn ascii_byte_eq(a: u8, b: u8) -> bool {
    #[cfg(windows)]
    {
        a.eq_ignore_ascii_case(&b)
    }
    #[cfg(not(windows))]
    {
        a == b
    }
}

/// 字符级双指针迭代 glob 匹配核心（`*` 吞 0..n 个字符，消除递归回溯）
fn seg_match_chars(pat: &[char], s: &[char]) -> bool {
    let mut pi = 0usize;
    let mut si = 0usize;
    let mut star_idx: Option<usize> = None;
    let mut match_idx = 0usize;

    while si < s.len() {
        if pi < pat.len() && (pat[pi] == '?' || pat[pi] == s[si]) {
            pi += 1;
            si += 1;
        } else if pi < pat.len() && pat[pi] == '*' {
            star_idx = Some(pi);
            match_idx = si;
            pi += 1;
        } else if let Some(star) = star_idx {
            pi = star + 1;
            match_idx += 1;
            si = match_idx;
        } else {
            return false;
        }
    }

    while pi < pat.len() && pat[pi] == '*' {
        pi += 1;
    }
    pi == pat.len()
}

/// 当前纪元毫秒（对齐全仓 epoch ms 惯例；本 crate 叶子依赖不引
/// agent-tools 的 epoch_millis，本地等价实现）
fn epoch_millis_now() -> i64 {
    match SystemTime::now().duration_since(UNIX_EPOCH) {
        Ok(d) => d.as_millis() as i64,
        Err(_) => 0,
    }
}

#[cfg(test)]
mod tests {
    // G2 禁令豁免：测试临时目录清理（非产品删除路径，可恢复语义不适用）。
    #![allow(clippy::disallowed_methods)]

    use super::*;
    use conex_test_utils::TempWorkspace;
    use std::fs;
    use std::time::Duration;

    /// 短窗口 start（测试收紧聚合窗口，删除转正等待短）
    fn start_fast(
        ws: &TempWorkspace,
        exclude: Vec<PathBuf>,
    ) -> (
        WorkspaceWatcher,
        tokio::sync::mpsc::Receiver<FileChangeEvent>,
    ) {
        WorkspaceWatcher::start_with_window(ws.path(), exclude, 300).expect("watcher 启动失败")
    }

    /// 轮询收集接收端事件直到超时（notify 回调异步到达）
    fn drain(
        rx: &mut tokio::sync::mpsc::Receiver<FileChangeEvent>,
        timeout_ms: u64,
    ) -> Vec<FileChangeEvent> {
        let deadline = std::time::Instant::now() + Duration::from_millis(timeout_ms);
        let mut out = Vec::new();
        while std::time::Instant::now() < deadline {
            match rx.try_recv() {
                Ok(ev) => out.push(ev),
                Err(tokio::sync::mpsc::error::TryRecvError::Empty) => {
                    std::thread::sleep(Duration::from_millis(20));
                }
                Err(_) => break,
            }
        }
        out
    }

    /// 找某路径某类型的首条事件
    fn find<'a>(
        events: &'a [FileChangeEvent],
        kind: ChangeKind,
        rel: &str,
        ws: &TempWorkspace,
    ) -> Option<&'a FileChangeEvent> {
        events
            .iter()
            .find(|e| e.kind == kind && e.path == ws.path().join(rel))
    }

    #[test]
    fn watcher_emits_create_modify_remove() {
        let ws = TempWorkspace::new("watch_cmr");
        ws.write_file("a.txt", "v1");
        let (mut watcher, mut rx) = start_fast(&ws, vec![]);

        // 写（Create）
        ws.write_file("b.txt", "x");
        let events = drain(&mut rx, 800);
        let created = find(&events, ChangeKind::Created, "b.txt", &ws);
        assert!(created.is_some(), "新建必须产出 Created 事件：{events:?}");
        assert_eq!(created.unwrap().from, None, "Created 不带 from");
        assert!(created.unwrap().occurred_at_ms > 0, "必须带时间戳");

        // 改（Modify）
        ws.write_file("b.txt", "y");
        let events = drain(&mut rx, 800);
        assert!(
            find(&events, ChangeKind::Modified, "b.txt", &ws).is_some(),
            "内容修改必须产出 Modified 事件：{events:?}"
        );

        // 删（Remove；等短窗口转正）
        fs::remove_file(ws.path().join("b.txt")).unwrap();
        let events = drain(&mut rx, 1200);
        assert!(
            find(&events, ChangeKind::Removed, "b.txt", &ws).is_some(),
            "删除必须产出 Removed 事件：{events:?}"
        );

        watcher.stop();
    }

    #[test]
    fn watcher_exclude_dir_produces_no_events() {
        let ws = TempWorkspace::new("watch_excl");
        ws.write_file("src/main.txt", "x");
        let (mut watcher, mut rx) = start_fast(&ws, vec![PathBuf::from("vendor")]);

        // 排除目录内写文件：不产事件
        ws.write_file("vendor/lib.js", "x");
        let events = drain(&mut rx, 500);
        assert!(events.is_empty(), "排除目录必须不产事件：{events:?}");

        // 排除目录外照常产出
        ws.write_file("src/lib.js", "x");
        let events = drain(&mut rx, 800);
        assert!(
            find(&events, ChangeKind::Created, "src/lib.js", &ws).is_some(),
            "非排除路径必须照常产出：{events:?}"
        );

        watcher.stop();
    }

    #[test]
    fn watcher_rename_aggregates_to_renamed() {
        let ws = TempWorkspace::new("watch_rn");
        ws.write_file("a.txt", "x");
        let (mut watcher, mut rx) = start_fast(&ws, vec![]);

        fs::rename(ws.path().join("a.txt"), ws.path().join("b.txt")).unwrap();
        let events = drain(&mut rx, 1000);
        match events.iter().find(|e| e.kind == ChangeKind::Renamed) {
            Some(ev) => {
                assert_eq!(ev.path, ws.path().join("b.txt"), "to 必须为新路径");
                assert_eq!(
                    ev.from.as_deref(),
                    Some(ws.path().join("a.txt").as_path()),
                    "from 必须为源路径"
                );
            }
            None => {
                // Windows 实测偏差：若 rename 拆成独立 Remove+Create 且
                // Create 先到（无配对），如实记录行为而非静默通过
                panic!("rename 未聚合为 Renamed：{events:?}");
            }
        }

        watcher.stop();
    }

    #[test]
    fn watcher_independent_remove_then_create_not_merged() {
        let ws = TempWorkspace::new("watch_indep");
        ws.write_file("x.txt", "x");
        let (mut watcher, mut rx) = start_fast(&ws, vec![]);

        fs::remove_file(ws.path().join("x.txt")).unwrap();
        let events = drain(&mut rx, 1200);
        assert!(
            find(&events, ChangeKind::Removed, "x.txt", &ws).is_some(),
            "独立删除必须产出 Removed：{events:?}"
        );

        ws.write_file("y.txt", "y");
        let events = drain(&mut rx, 800);
        assert!(
            find(&events, ChangeKind::Created, "y.txt", &ws).is_some(),
            "独立新建必须产出 Created：{events:?}"
        );
        assert!(
            events.iter().all(|e| e.kind != ChangeKind::Renamed),
            "跨路径独立删除+新建不得聚合为 Renamed：{events:?}"
        );

        watcher.stop();
    }

    #[test]
    fn watcher_stop_produces_no_more_events() {
        let ws = TempWorkspace::new("watch_stop");
        ws.write_file("a.txt", "x");
        let (mut watcher, mut rx) = start_fast(&ws, vec![]);
        ws.write_file("b.txt", "x");
        let events = drain(&mut rx, 800);
        assert!(!events.is_empty(), "启动期必须有事件");

        watcher.stop();
        // 契约：stop 返回后不再接受新事件；unwatch 生效前 OS 已入队的在途
        // 事件属合法窗口，先排空再验证「停止后写入零新事件」。
        drain(&mut rx, 150);
        ws.write_file("c.txt", "x");
        let events = drain(&mut rx, 500);
        assert!(events.is_empty(), "停止后必须无事件：{events:?}");
    }

    #[cfg(windows)]
    #[test]
    fn watcher_windows_rename_and_write_semantics() {
        // Windows（ReadDirectoryChangesW）平台实测：子目录内 rename 与
        // 写入语义必须产事件（聚合形态允许 Renamed 或 Remove+Create）
        let ws = TempWorkspace::new("watch_win");
        ws.write_file("sub/a.txt", "x");
        let (mut watcher, mut rx) = start_fast(&ws, vec![]);

        // 子目录内写入（递归监视必须覆盖子目录）
        ws.write_file("sub/deep/b.txt", "x");
        let events = drain(&mut rx, 1000);
        assert!(
            find(&events, ChangeKind::Created, "sub/deep/b.txt", &ws).is_some(),
            "递归监视子目录写入必须产事件：{events:?}"
        );

        // 子目录内 rename（聚合形态如实记录）
        fs::rename(ws.path().join("sub/a.txt"), ws.path().join("sub/c.txt")).unwrap();
        let events = drain(&mut rx, 1500);
        let renamed = events.iter().any(|e| e.kind == ChangeKind::Renamed);
        let remove_create = find(&events, ChangeKind::Removed, "sub/a.txt", &ws).is_some()
            && find(&events, ChangeKind::Created, "sub/c.txt", &ws).is_some();
        assert!(
            renamed || remove_create,
            "Windows rename 必须产出 Renamed 或 Remove+Create：{events:?}"
        );

        watcher.stop();
    }

    #[test]
    fn glob_match_covers_star_question_doublestar() {
        assert!(glob_match("*.snap", "a.snap"));
        assert!(!glob_match("*.snap", "a.txt"));
        assert!(glob_match("**/*.snap", "a/b/c.snap"));
        assert!(glob_match("**/*.snap", "c.snap"), "`**/` 应匹配零层");
        assert!(glob_match("a?c.txt", "abc.txt"));
        assert!(!glob_match("a?c.txt", "ac.txt"));
        assert!(glob_match("**", "anything/deep"));
        assert!(glob_match("node_modules", "node_modules"));
        assert!(glob_match("**/node_modules/**", "a/node_modules/b/x"));
        assert!(!glob_match("node_modules/*", "node_modules/a/b"));

        // 跨平台 Windows 反斜杠与正斜杠切分
        assert!(glob_match("vendor/**", "vendor/lib/index.js"));
        assert!(glob_match("vendor/**", r"vendor\lib\index.js"));
        assert!(glob_match(r"vendor\**", "vendor/lib/index.js"));
        assert!(glob_match(r"vendor\**", r"vendor\lib\index.js"));
        assert!(glob_match("**/test/**", r"a\b\test\c\d.rs"));

        // Windows 大小写不敏感匹配
        #[cfg(windows)]
        {
            assert!(glob_match("vendor/**", "VENDOR/LIB/INDEX.JS"));
            assert!(glob_match("*.PNG", "photo.png"));
            assert!(glob_match("*.png", "PHOTO.PNG"));
            assert!(glob_match("src/**/*.rs", r"SRC\MOD\MAIN.RS"));
        }
    }

    #[test]
    fn serde_wire_shapes_match_design() {
        // ChangeKind wire kebab-case
        assert_eq!(
            serde_json::to_string(&ChangeKind::Renamed).unwrap(),
            "\"renamed\""
        );
        // FileChangeEvent camelCase + from 省略
        let ev = FileChangeEvent {
            path: PathBuf::from("C:/ws/a.txt"),
            kind: ChangeKind::Modified,
            from: None,
            occurred_at_ms: 1234,
        };
        let json = serde_json::to_value(&ev).unwrap();
        assert_eq!(json["path"], "C:/ws/a.txt");
        assert_eq!(json["kind"], "modified");
        assert_eq!(json["occurredAtMs"], 1234);
        assert!(json.get("from").is_none(), "None 的 from 必须省略");
        // from 在场
        let ev = FileChangeEvent {
            path: PathBuf::from("C:/ws/b.txt"),
            kind: ChangeKind::Renamed,
            from: Some(PathBuf::from("C:/ws/a.txt")),
            occurred_at_ms: 1235,
        };
        let json = serde_json::to_value(&ev).unwrap();
        assert_eq!(json["from"], "C:/ws/a.txt");
        // roundtrip 保真
        let back: FileChangeEvent = serde_json::from_value(json).unwrap();
        assert_eq!(back, ev);
        // UndeclaredWrite 结构（判定后、审计前）roundtrip
        let report = UndeclaredWrite {
            session_id: "s1".into(),
            run_id: "r1".into(),
            changes: vec![ev],
            first_occurred_at_ms: 1,
            last_occurred_at_ms: 1235,
            file_count: 1,
            has_destructive: true,
        };
        let json = serde_json::to_value(&report).unwrap();
        assert_eq!(json["sessionId"], "s1");
        assert_eq!(json["hasDestructive"], true);
        let back: UndeclaredWrite = serde_json::from_value(json).unwrap();
        assert_eq!(back, report);
    }

    #[test]
    fn watcher_filter_filters_transient_atomic_files() {
        assert!(watcher_filter(Path::new(".conex-tmp-doc-1234.tmp")));
        assert!(watcher_filter(Path::new(".conex-bak-doc-1234.bak")));
        assert!(watcher_filter(Path::new(
            "c:/workspace/.conex-tmp-main-1-2.tmp"
        )));
        assert!(watcher_filter(Path::new(
            "c:/workspace/.conex-bak-main-1-2.bak"
        )));
        assert!(watcher_filter(Path::new(
            "c:/workspace/file.agent-tmp-123-1"
        )));
        assert!(watcher_filter(Path::new("c:/workspace/.crish-tmp-456")));

        // 用户工程普通 .tmp / .bak / 源码等不得被过滤
        assert!(!watcher_filter(Path::new("c:/workspace/file.tmp")));
        assert!(!watcher_filter(Path::new("c:/workspace/file.bak")));
        assert!(!watcher_filter(Path::new("c:/workspace/doc.md")));
        assert!(!watcher_filter(Path::new("c:/workspace/src/lib.rs")));
        assert!(!watcher_filter(Path::new("c:/workspace/README.md")));
    }

    #[test]
    fn coalesce_file_events_merges_redundant_states_per_path() {
        let p_a = PathBuf::from("C:/ws/a.rs");
        let p_b = PathBuf::from("C:/ws/b.rs");
        let raw = vec![
            FileChangeEvent {
                path: p_a.clone(),
                kind: ChangeKind::Created,
                from: None,
                occurred_at_ms: 100,
            },
            FileChangeEvent {
                path: p_a.clone(),
                kind: ChangeKind::Modified,
                from: None,
                occurred_at_ms: 105,
            },
            FileChangeEvent {
                path: p_a.clone(),
                kind: ChangeKind::Modified,
                from: None,
                occurred_at_ms: 110,
            },
            FileChangeEvent {
                path: p_b.clone(),
                kind: ChangeKind::Modified,
                from: None,
                occurred_at_ms: 112,
            },
            FileChangeEvent {
                path: p_b.clone(),
                kind: ChangeKind::Modified,
                from: None,
                occurred_at_ms: 115,
            },
        ];

        let merged = coalesce_file_events(raw);
        assert_eq!(merged.len(), 2, "同路径高频冗余事件必须合并为单条");
        assert_eq!(merged[0].path, p_a);
        assert_eq!(merged[0].kind, ChangeKind::Created);
        assert_eq!(merged[0].occurred_at_ms, 110);
        assert_eq!(merged[1].path, p_b);
        assert_eq!(merged[1].kind, ChangeKind::Modified);
        assert_eq!(merged[1].occurred_at_ms, 115);
    }

    #[test]
    fn watcher_debounces_dense_write_burst_without_storm() {
        let ws = TempWorkspace::new("watch_burst");
        ws.write_file("burst.txt", "init");
        let (mut watcher, mut rx) = start_fast(&ws, vec![]);
        let _ = drain(&mut rx, 100);

        // 模拟单文件密集写入 30 次
        let target = ws.path().join("burst.txt");
        for i in 0..30 {
            fs::write(&target, format!("payload-{i}")).unwrap();
        }
        let events = drain(&mut rx, 600);
        let mod_count = events
            .iter()
            .filter(|e| e.kind == ChangeKind::Modified && e.path == target)
            .count();
        assert!(
            mod_count >= 1 && mod_count < 15,
            "密集写入应至少产出 1 条 Modified 且经防抖抑制风暴（实测 {mod_count} 条）：{events:?}"
        );

        watcher.stop();
    }
}
