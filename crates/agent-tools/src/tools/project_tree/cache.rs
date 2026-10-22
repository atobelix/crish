//! project_tree 进程级缓存：树节点/缓存条目/缓存键与目录指纹失效

use super::build::build_tree;
use super::params::ProjectTreeParams;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, LazyLock, Mutex};
use std::time::SystemTime;

/// 树节点（构建期完成排序与子树大小计算，渲染期只读）
pub(super) struct TreeNode {
    pub(super) name: String,
    pub(super) is_dir: bool,
    /// 子树节点总数（含自身；折叠计数用）
    pub(super) size: usize,
    /// 直接子节点（目录优先 + 字母序）
    pub(super) children: Vec<TreeNode>,
}

/// 缓存条目 = 树结构 + 目录指纹表（dir mtime_ns, readdir 条目数）
pub(super) struct TreeEntry {
    /// 树根显示名（相对工作区；供根行与 JSON root 字段）
    pub(super) root_display: String,
    /// 树根是否为目录（path 指向文件时树退化为单行）
    pub(super) root_is_dir: bool,
    /// 根的直接子节点（排序完成）
    pub(super) children: Vec<TreeNode>,
    /// 树内目录数（不含根）
    pub(super) dirs: usize,
    /// 树内文件数（root 为文件时计 1）
    pub(super) files: usize,
    /// 目录指纹：可见目录 → (mtime_ns, readdir 条目数)
    pub(super) fingerprints: HashMap<PathBuf, (u64, usize)>,
}

/// 缓存键（excludeGlobs 排序后入键，避免顺序抖动）
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
struct CacheKey {
    root: PathBuf,
    depth: usize,
    include_files: bool,
    exclude_globs: Vec<String>,
}

/// 条目级缓存单元格（同键构建持本锁去重，不同键互不阻塞——P2-4）
type CacheCell = Arc<Mutex<Option<Arc<TreeEntry>>>>;

/// 进程级缓存（条目级锁：同键构建持 cell 锁去重，不同键并行）
pub(super) struct TreeCache {
    cells: Mutex<HashMap<CacheKey, CacheCell>>,
}

static TREE_CACHE: LazyLock<TreeCache> = LazyLock::new(|| TreeCache {
    cells: Mutex::new(HashMap::new()),
});

impl TreeCache {
    /// 取或构建：返回 (条目, 是否缓存命中)。
    ///
    /// 条目级锁语义（P2-4）：先经外层 cells 表取/建 `Arc<Mutex<Option<...>>>`
    /// 单元格（不同键不同 cell），再持 cell 锁做指纹校验与构建——同键
    /// 并发调用串行（后到者等待并复用），不同键完全并行。构建在 cell
    /// 锁内同步完成（目录遍历量级毫秒，无 await，无死锁风险）。
    pub(super) fn get_or_build(params: &ProjectTreeParams) -> (Arc<TreeEntry>, bool) {
        let key = CacheKey {
            root: params.root.clone(),
            depth: params.depth,
            include_files: params.include_files,
            exclude_globs: params.exclude_globs.clone(),
        };
        let cell = {
            let mut cells = TREE_CACHE
                .cells
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            cells
                .entry(key)
                .or_insert_with(|| Arc::new(Mutex::new(None)))
                .clone()
        };
        let mut slot = cell
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if let Some(entry) = slot.as_ref() {
            if fingerprints_valid(entry) {
                return (Arc::clone(entry), true);
            }
        }
        let entry = Arc::new(build_tree(params));
        *slot = Some(Arc::clone(&entry));
        (entry, false)
    }
}

/// 指纹校验：只 re-stat 指纹表内目录（元数据 + readdir 计数），零 IO 扫描。
///
/// 任一日录 mtime 或条目数变化 → 视为失效 → 整体重建（V1 取舍见模块头）。
fn fingerprints_valid(entry: &TreeEntry) -> bool {
    entry.fingerprints.iter().all(|(dir, (mtime, count))| {
        let m = dir_mtime_ns(dir);
        let c = std::fs::read_dir(dir).map(|rd| rd.count()).unwrap_or(0);
        m == *mtime && c == *count
    })
}

/// 目录 mtime 纪元纳秒（stat 失败回退 0——与记录期同口径，恒不匹配则重建）
pub(super) fn dir_mtime_ns(dir: &Path) -> u64 {
    std::fs::metadata(dir)
        .ok()
        .and_then(|m| m.modified().ok())
        .and_then(|t| t.duration_since(SystemTime::UNIX_EPOCH).ok())
        .map(|d| d.as_nanos() as u64)
        .unwrap_or(0)
}
