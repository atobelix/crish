//! W2-E · 轮询 watcher 子集（进程内 / 可轮询）。
//!
//! 设计：
//! - 上层（timer / 测试）持有 [`MirrorWatchHandle`] 或 [`MirrorWatcher`]；
//! - 每次 `poll_*`：读 path 的 mtime+hash 指纹 → 与上次对比 → 调 `detect_mirror_drift`；
//! - 指纹变化时 [`MirrorWatcher`] 触发 `on_mirror_change` 回调，携带完整 [`MirrorDriftReport`]。
//!
//! # 诚实边界（不可冒充）
//! - **本模块 poll 路径 ≠ OS inotify/FSEvents 生产满关**：poll 靠上层 timer / 测试直接调
//!   [`MirrorWatchHandle::poll_mirror_once`] 或 [`MirrorWatcher::poll_once`]。
//! - **OS 路径**见 [`crate::mirror_os_watch`]（notify 封装）；有 OS 入口 **仍 ≠**
//!   A-INV-02 产品 UI / 桌面订阅全链路 / **EL-03**。
//! - **≠ A-INV-02 产品 UI**：不弹三路对话框、不接线桌面；仅交付 **可测观察入口**。
//! - **≠ EL-03**（恢复/打开叙事属 G-HYD / W3 等，不在本模块）。
//! - **禁止**用 poll 叙事冒充「已交 inotify 满关」。

use super::mirror_detect::{MirrorDriftReport, file_mtime_ms};
use super::{StoreError, WorkspaceStore, content_hash};
use std::path::{Path, PathBuf};

/// mirror 文件指纹（mtime + content hash + 是否存在），供轮询去抖/变更检测。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MirrorFileFingerprint {
    pub path: PathBuf,
    /// 文件存在时为 SHA-256 hex；缺失时为 `None`。
    pub content_hash: Option<String>,
    pub mtime_ms: i64,
    pub exists: bool,
}

impl MirrorFileFingerprint {
    /// 从路径读当前指纹（path 空 → 视为不存在）。
    pub fn observe(path: &Path) -> Self {
        if path.as_os_str().is_empty() || !path.is_file() {
            return Self {
                path: path.to_path_buf(),
                content_hash: None,
                mtime_ms: 0,
                exists: false,
            };
        }
        let content_hash = std::fs::read(path).ok().map(|b| content_hash(&b));
        let mtime_ms = file_mtime_ms(path);
        Self {
            path: path.to_path_buf(),
            content_hash,
            mtime_ms,
            exists: true,
        }
    }
}

/// [`MirrorWatchHandle::poll_mirror_once`] 单次轮询结果（始终含 detect 分类）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MirrorWatchPollResult {
    pub doc_id: String,
    /// `detect_mirror_drift` 分类报告（可观测三路）。
    pub report: MirrorDriftReport,
    /// 相对上次 poll，文件指纹是否变化。
    pub fingerprint_changed: bool,
    /// 是否为本 handle 的首次观察（首次建立基线，通常不视为「变更事件」）。
    pub first_poll: bool,
    pub fingerprint: MirrorFileFingerprint,
}

impl MirrorWatchPollResult {
    /// 是否应作为「外部改盘变更事件」上抛（非首次 + 指纹变）。
    pub fn is_change_event(&self) -> bool {
        !self.first_poll && self.fingerprint_changed
    }
}

/// 进程内 / 可轮询的单 doc mirror 观察句柄。
///
/// # 用法
/// ```ignore
/// let mut h = MirrorWatchHandle::new("doc-1");
/// let r0 = h.poll_mirror_once(&store, authority_rev)?; // 建基线
/// // … 外部改 .md …
/// let r1 = h.poll_mirror_once(&store, authority_rev)?;
/// assert!(r1.is_change_event());
/// assert_eq!(r1.report.class, MirrorDriftClass::MirrorOnly);
/// ```
///
/// # 诚实边界
/// - **≠ OS inotify/FSEvents 生产满关**——须由上层 timer 驱动 poll。
/// - **≠ A-INV-02 产品 UI**；**≠ EL-03**。
#[derive(Debug, Clone)]
pub struct MirrorWatchHandle {
    doc_id: String,
    last_fingerprint: Option<MirrorFileFingerprint>,
}

impl MirrorWatchHandle {
    pub fn new(doc_id: impl Into<String>) -> Self {
        Self {
            doc_id: doc_id.into(),
            last_fingerprint: None,
        }
    }

    pub fn doc_id(&self) -> &str {
        &self.doc_id
    }

    /// 上次 poll 指纹（首次 poll 前为 `None`）。
    pub fn last_fingerprint(&self) -> Option<&MirrorFileFingerprint> {
        self.last_fingerprint.as_ref()
    }

    /// 重置基线（下次 poll 视为 `first_poll`）。
    pub fn reset_baseline(&mut self) {
        self.last_fingerprint = None;
    }

    /// **单次轮询入口**：读 mtime/hash → 与上次指纹对比 → `detect_mirror_drift`。
    ///
    /// 始终返回完整 [`MirrorWatchPollResult`]（含分类）；调用方用
    /// [`MirrorWatchPollResult::is_change_event`] 过滤变更。
    ///
    /// **≠** inotify；本方法即「可测的 mirror 变更观察入口」。
    pub fn poll_mirror_once(
        &mut self,
        store: &WorkspaceStore,
        authority_rev: u64,
    ) -> Result<MirrorWatchPollResult, StoreError> {
        let report = store.detect_mirror_drift(&self.doc_id, authority_rev)?;
        let fingerprint = MirrorFileFingerprint::observe(&report.path);
        let first_poll = self.last_fingerprint.is_none();
        let fingerprint_changed = match &self.last_fingerprint {
            None => true, // 首次：建立基线，标 changed 便于诊断，但 is_change_event=false
            Some(prev) => prev != &fingerprint,
        };
        self.last_fingerprint = Some(fingerprint.clone());
        Ok(MirrorWatchPollResult {
            doc_id: self.doc_id.clone(),
            report,
            fingerprint_changed,
            first_poll,
            fingerprint,
        })
    }

    /// 仅当 [`MirrorWatchPollResult::is_change_event`] 时返回 `Some`（跳过首次基线）。
    pub fn poll_if_changed(
        &mut self,
        store: &WorkspaceStore,
        authority_rev: u64,
    ) -> Result<Option<MirrorWatchPollResult>, StoreError> {
        let r = self.poll_mirror_once(store, authority_rev)?;
        if r.is_change_event() {
            Ok(Some(r))
        } else {
            Ok(None)
        }
    }
}

/// 无状态便捷函数：等价于 `store.detect_mirror_drift`（供 timer/上层命名对齐）。
///
/// 不维护指纹基线；需要变更检测请用 [`MirrorWatchHandle`]。
///
/// **≠ OS inotify**；**≠ A-INV-02 产品 UI**；**≠ EL-03**。
pub fn poll_mirror_once(
    store: &WorkspaceStore,
    doc_id: &str,
    authority_rev: u64,
) -> Result<MirrorDriftReport, StoreError> {
    store.detect_mirror_drift(doc_id, authority_rev)
}

/// 带 `on_mirror_change` 回调的轻量观察器（进程内；由上层驱动 [`Self::poll_once`]）。
///
/// # 诚实边界
/// - **≠ OS inotify/FSEvents 生产满关**
/// - **≠ A-INV-02 产品 UI**（回调载荷仅为 detect 报告，不弹 UI）
/// - **≠ EL-03**
pub struct MirrorWatcher {
    handle: MirrorWatchHandle,
    /// 指纹变更时调用（跳过首次基线 poll）。
    on_change: Option<Box<dyn FnMut(&MirrorWatchPollResult)>>,
}

impl MirrorWatcher {
    pub fn new(doc_id: impl Into<String>) -> Self {
        Self {
            handle: MirrorWatchHandle::new(doc_id),
            on_change: None,
        }
    }

    pub fn doc_id(&self) -> &str {
        self.handle.doc_id()
    }

    pub fn handle(&self) -> &MirrorWatchHandle {
        &self.handle
    }

    pub fn handle_mut(&mut self) -> &mut MirrorWatchHandle {
        &mut self.handle
    }

    /// 注册 mirror 变更回调（文件指纹相对上次 poll 变化时触发）。
    ///
    /// 覆盖先前回调。**进程内同步**调用；不跨线程投递。
    pub fn on_mirror_change<F>(&mut self, cb: F)
    where
        F: FnMut(&MirrorWatchPollResult) + 'static,
    {
        self.on_change = Some(Box::new(cb));
    }

    /// 清除回调。
    pub fn clear_on_mirror_change(&mut self) {
        self.on_change = None;
    }

    /// 轮询一次；若为变更事件则同步调用已注册的 `on_mirror_change`。
    pub fn poll_once(
        &mut self,
        store: &WorkspaceStore,
        authority_rev: u64,
    ) -> Result<MirrorWatchPollResult, StoreError> {
        let result = self.handle.poll_mirror_once(store, authority_rev)?;
        if result.is_change_event() {
            if let Some(cb) = self.on_change.as_mut() {
                cb(&result);
            }
        }
        Ok(result)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::mirror_detect::MirrorDriftClass;
    use conex_doc_collab::{BlockId, BlockKind, BlockNode, BlockProps, BlockTree};
    use std::collections::HashMap;
    use std::str::FromStr;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::time::{SystemTime, UNIX_EPOCH};

    static COUNTER: AtomicU64 = AtomicU64::new(0);

    fn temp_dir() -> PathBuf {
        let n = COUNTER.fetch_add(1, Ordering::SeqCst);
        let p = std::env::temp_dir().join(format!(
            "conex-mirror-poll-{}-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0),
            n
        ));
        let _ = std::fs::create_dir_all(&p);
        p
    }

    fn sample_tree(text: &str) -> BlockTree {
        let id = BlockId::from_str("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa").unwrap();
        let mut nodes = HashMap::new();
        nodes.insert(
            id,
            BlockNode {
                id,
                parent: None,
                order: "a0".into(),
                kind: BlockKind::Paragraph,
                props: BlockProps::default(),
                text_snapshot: Some(text.into()),
                children: vec![],
            },
        );
        BlockTree {
            root_children: vec![id],
            nodes,
        }
    }

    /// watcher 子集：改 mirror 文件 → `poll_mirror_once` 观察到 `MirrorOnly`。
    ///
    /// **≠ OS inotify**；**≠ A-INV-02 产品 UI**；**≠ EL-03**。
    #[test]
    fn poll_mirror_once_observes_mirror_only_after_external_edit() {
        let dir = temp_dir();
        let db = dir.join("workspace.db");
        let mirror_root = dir.join("mirrors");
        let store = WorkspaceStore::open(&db).unwrap();
        let tree = sample_tree("mirror hello");

        store
            .export_md_mirror("doc-w", &tree, 1, &mirror_root)
            .unwrap();

        let mut handle = MirrorWatchHandle::new("doc-w");
        // 首次 poll：建基线，非 change event
        let r0 = handle.poll_mirror_once(&store, 1).unwrap();
        assert!(r0.first_poll);
        assert!(!r0.is_change_event());
        assert_eq!(r0.report.class, MirrorDriftClass::None);

        // 无状态便捷入口也应对齐 detect
        let free = poll_mirror_once(&store, "doc-w", 1).unwrap();
        assert_eq!(free.class, MirrorDriftClass::None);

        // 外部改盘
        let path = r0.report.path.clone();
        let mut content = std::fs::read_to_string(&path).unwrap();
        content.push_str("\n\nexternal via poll\n");
        std::fs::write(&path, content.as_bytes()).unwrap();

        let r1 = handle.poll_mirror_once(&store, 1).unwrap();
        assert!(!r1.first_poll);
        assert!(r1.fingerprint_changed, "mtime/hash 应变");
        assert!(r1.is_change_event());
        assert_eq!(
            r1.report.class,
            MirrorDriftClass::MirrorOnly,
            "外部改 mirror 须 MirrorOnly，got {:?}",
            r1.report.class
        );
        assert!(r1.report.mirror_changed);
        assert!(!r1.report.authority_changed);

        // poll_if_changed：无再改时应 None
        let r2 = handle.poll_if_changed(&store, 1).unwrap();
        assert!(r2.is_none(), "指纹未变不应再报 change");

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// watcher 子集：`on_mirror_change` 回调在外部改盘后拿到 `MirrorOnly`。
    ///
    /// **≠ OS inotify**；**≠ A-INV-02 产品 UI**；**≠ EL-03**。
    #[test]
    fn on_mirror_change_callback_receives_mirror_only() {
        use std::sync::{Arc, Mutex};

        let dir = temp_dir();
        let db = dir.join("workspace.db");
        let mirror_root = dir.join("mirrors");
        let store = WorkspaceStore::open(&db).unwrap();
        let tree = sample_tree("mirror hello");

        store
            .export_md_mirror("doc-cb", &tree, 1, &mirror_root)
            .unwrap();

        let events: Arc<Mutex<Vec<MirrorDriftClass>>> = Arc::new(Mutex::new(Vec::new()));
        let events_cb = Arc::clone(&events);

        let mut watcher = MirrorWatcher::new("doc-cb");
        watcher.on_mirror_change(move |ev| {
            events_cb
                .lock()
                .unwrap()
                .push(ev.report.class);
        });

        // 建基线：不应触发回调
        let r0 = watcher.poll_once(&store, 1).unwrap();
        assert!(r0.first_poll);
        assert!(events.lock().unwrap().is_empty(), "首次基线不回调");

        // 外部改盘
        let path = r0.report.path.clone();
        let md = std::fs::read_to_string(&path)
            .unwrap()
            .replace("mirror hello", "callback sees me");
        std::fs::write(&path, md.as_bytes()).unwrap();

        let r1 = watcher.poll_once(&store, 1).unwrap();
        assert!(r1.is_change_event());
        assert_eq!(r1.report.class, MirrorDriftClass::MirrorOnly);

        let fired = events.lock().unwrap().clone();
        assert_eq!(
            fired,
            vec![MirrorDriftClass::MirrorOnly],
            "回调须收到 MirrorOnly，got {fired:?}"
        );

        // 再 poll 无变更：不重复回调
        let r2 = watcher.poll_once(&store, 1).unwrap();
        assert!(!r2.is_change_event());
        assert_eq!(events.lock().unwrap().len(), 1);

        let _ = std::fs::remove_dir_all(&dir);
    }
}
