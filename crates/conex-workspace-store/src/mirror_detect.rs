//! W2-E Strict · P6 detect：mtime/hash vs `mirror_meta` → 三路分类。
//!
//! # 诚实边界
//! - **≠ OS inotify/FSEvents 生产满关**——本 API 是可轮询的 detect 入口。
//! - **≠ A-INV-02 产品 UI**；**≠ EL-03**。
//! - 仅 detect **≠** 产品三路对话框满关。

use super::{content_hash, InFlightSuppressVerdict, StoreError, WorkspaceStore};
use rusqlite::{params, OptionalExtension};
use std::path::{Path, PathBuf};

// ─── 分类 / 报告 ──────────────────────────────────────────────────────────

/// detect 输出的漂移分类（仅 mirror / 权威库 / 双变 + 无漂移/缺元数据）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MirrorDriftClass {
    /// 文件 hash 与 meta 一致，且 `authority_rev == last_export_rev`。
    None,
    /// 仅 mirror 文件相对上次 export 指纹变了；权威仍在 export 水位。
    MirrorOnly,
    /// 仅权威 rev 前进；文件 hash 仍匹配上次 export。
    AuthorityOnly,
    /// 双变：文件变了 **且** 权威相对 export 前进。
    Both,
    /// 无 `mirror_meta` 行，或 path 空且从未成功 export。
    NoMeta,
    /// meta 有 path，但文件不存在（被删/移走）。
    MissingFile,
}

/// [`WorkspaceStore::detect_mirror_drift`] 完整报告。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MirrorDriftReport {
    pub doc_id: String,
    pub class: MirrorDriftClass,
    pub path: PathBuf,
    pub last_export_rev: u64,
    pub authority_rev: u64,
    pub pending_lag: i64,
    /// 上次 export 写入的内容 hash（空串 = 旧行未迁移指纹）。
    pub stored_hash: String,
    /// 当前文件 hash；文件不存在时为 `None`。
    pub file_hash: Option<String>,
    pub file_exists: bool,
    pub mirror_changed: bool,
    pub authority_changed: bool,
}

// ─── meta 行 ──────────────────────────────────────────────────────────────

#[derive(Debug, Clone)]
struct MirrorMetaRow {
    path: String,
    last_export_rev: i64,
    pending_lag: i64,
    content_hash: String,
    #[allow(dead_code)]
    file_mtime_ms: i64,
}

impl WorkspaceStore {
    /// 读取 `mirror_meta`（含 content_hash / file_mtime_ms；旧库列由 migrate 补齐）。
    fn load_mirror_meta_row(&self, doc_id: &str) -> Result<Option<MirrorMetaRow>, StoreError> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| StoreError::Lock(e.to_string()))?;
        let row = conn
            .query_row(
                r#"
                SELECT path, last_export_rev, pending_lag,
                       COALESCE(content_hash, ''), COALESCE(file_mtime_ms, 0)
                FROM mirror_meta WHERE doc_id = ?1
                "#,
                params![doc_id],
                |r| {
                    Ok(MirrorMetaRow {
                        path: r.get(0)?,
                        last_export_rev: r.get(1)?,
                        pending_lag: r.get(2)?,
                        content_hash: r.get(3)?,
                        file_mtime_ms: r.get(4)?,
                    })
                },
            )
            .optional()?;
        Ok(row)
    }

    /// **detect**：mtime/hash vs `mirror_meta`，输出三路分类（A-INV-02 / X-05 检测侧）。
    ///
    /// - `authority_rev`：当前权威 rev（通常 `DocSession::rev()` 或 `load_rev`）。
    /// - 可测注入：测试直接改盘文件 / 调 `note_authority_advanced`，**无需** OS watcher。
    /// - **≠** inotify 满关；本 API 即「可轮询的 detect 入口」。
    pub fn detect_mirror_drift(
        &self,
        doc_id: &str,
        authority_rev: u64,
    ) -> Result<MirrorDriftReport, StoreError> {
        let meta = self.load_mirror_meta_row(doc_id)?;
        let Some(meta) = meta else {
            return Ok(MirrorDriftReport {
                doc_id: doc_id.to_string(),
                class: MirrorDriftClass::NoMeta,
                path: PathBuf::new(),
                last_export_rev: 0,
                authority_rev,
                pending_lag: 0,
                stored_hash: String::new(),
                file_hash: None,
                file_exists: false,
                mirror_changed: false,
                authority_changed: authority_rev > 0,
            });
        };

        // 从未真正 export（骨架行 path 空）
        if meta.path.is_empty() {
            return Ok(MirrorDriftReport {
                doc_id: doc_id.to_string(),
                class: MirrorDriftClass::NoMeta,
                path: PathBuf::new(),
                last_export_rev: meta.last_export_rev as u64,
                authority_rev,
                pending_lag: meta.pending_lag,
                stored_hash: meta.content_hash,
                file_hash: None,
                file_exists: false,
                mirror_changed: false,
                authority_changed: authority_rev as i64 != meta.last_export_rev,
            });
        }

        let path = PathBuf::from(&meta.path);
        let file_exists = path.is_file();
        let (file_hash, mut mirror_changed) = if file_exists {
            let bytes = std::fs::read(&path)?;
            let hash = content_hash(&bytes);
            let changed = if meta.content_hash.is_empty() {
                // 旧行无指纹：无法证明「未变」→ 保守视为可能已变（有文件即标 changed，
                // 迫使上层 re-export 或显式 import；避免假绿 None）。
                true
            } else {
                hash != meta.content_hash
            };
            (Some(hash), changed)
        } else {
            (None, true) // 文件消失也算 mirror 侧异常
        };

        // 检查在途导出守卫状态机（INV-STORE-01：零假漂移与瞬态假删除压制）
        let verdict = self.export_guard.check_and_suppress(&path, file_hash.as_deref());
        let effective_file_exists = match verdict {
            InFlightSuppressVerdict::SuppressTransientDeletion => {
                // 瞬态重命名期间物理文件微秒级不存在，压制假删除
                mirror_changed = false;
                true
            }
            InFlightSuppressVerdict::SuppressMatched => {
                // 命中在途守卫且内容 Hash 匹配，压制自发事件
                mirror_changed = false;
                file_exists
            }
            InFlightSuppressVerdict::PassThrough => file_exists,
        };

        let last_export_rev = meta.last_export_rev as u64;
        // 权威前进：rev 相对 last_export_rev 不一致（pending_lag 与 note_authority_advanced 同源）
        let authority_changed = authority_rev != last_export_rev;

        let class = if !effective_file_exists {
            MirrorDriftClass::MissingFile
        } else {
            match (mirror_changed, authority_changed) {
                (false, false) => MirrorDriftClass::None,
                (true, false) => MirrorDriftClass::MirrorOnly,
                (false, true) => MirrorDriftClass::AuthorityOnly,
                (true, true) => MirrorDriftClass::Both,
            }
        };

        Ok(MirrorDriftReport {
            doc_id: doc_id.to_string(),
            class,
            path,
            last_export_rev,
            authority_rev,
            pending_lag: meta.pending_lag,
            stored_hash: meta.content_hash,
            file_hash,
            file_exists,
            mirror_changed,
            authority_changed,
        })
    }
}

/// 供 migrate / export 使用：文件 mtime 毫秒（失败则 0）。
pub(crate) fn file_mtime_ms(path: &Path) -> i64 {
    std::fs::metadata(path)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use conex_doc_collab::{BlockId, BlockKind, BlockNode, BlockProps, BlockTree};
    use std::collections::HashMap;
    use std::str::FromStr;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::time::{SystemTime, UNIX_EPOCH};

    static COUNTER: AtomicU64 = AtomicU64::new(0);

    fn temp_dir() -> PathBuf {
        let n = COUNTER.fetch_add(1, Ordering::SeqCst);
        let p = std::env::temp_dir().join(format!(
            "conex-mirror-detect-{}-{}-{}",
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

    /// detect 三路分类：MirrorOnly / AuthorityOnly / Both / None。
    #[test]
    fn detect_mirror_drift_classifies_three_ways() {
        let dir = temp_dir();
        let db = dir.join("workspace.db");
        let mirror_root = dir.join("mirrors");
        let store = WorkspaceStore::open(&db).unwrap();
        let tree = sample_tree("mirror hello");

        // 无 meta
        let r0 = store.detect_mirror_drift("doc-d", 0).unwrap();
        assert_eq!(r0.class, MirrorDriftClass::NoMeta);

        // export rev=1
        store
            .export_md_mirror("doc-d", &tree, 1, &mirror_root)
            .unwrap();
        let r_none = store.detect_mirror_drift("doc-d", 1).unwrap();
        assert_eq!(
            r_none.class,
            MirrorDriftClass::None,
            "export 后同 rev 应无漂移"
        );
        assert!(!r_none.mirror_changed);
        assert!(!r_none.authority_changed);

        // 仅 mirror 变：外部改文件
        let path = r_none.path.clone();
        let mut content = std::fs::read_to_string(&path).unwrap();
        content.push_str("\n\nexternal edit\n");
        std::fs::write(&path, content.as_bytes()).unwrap();
        let r_m = store.detect_mirror_drift("doc-d", 1).unwrap();
        assert_eq!(r_m.class, MirrorDriftClass::MirrorOnly);
        assert!(r_m.mirror_changed);
        assert!(!r_m.authority_changed);

        // 恢复文件到 export 指纹后再测 AuthorityOnly
        store
            .export_md_mirror("doc-d", &tree, 1, &mirror_root)
            .unwrap();
        store.note_authority_advanced("doc-d", 5).unwrap();
        let r_a = store.detect_mirror_drift("doc-d", 5).unwrap();
        assert_eq!(
            r_a.class,
            MirrorDriftClass::AuthorityOnly,
            "仅权威前进应 AuthorityOnly"
        );
        assert!(!r_a.mirror_changed);
        assert!(r_a.authority_changed);

        // 双变：再改文件
        let path2 = r_a.path.clone();
        std::fs::write(&path2, b"# hijacked\n\nboth changed\n").unwrap();
        let r_b = store.detect_mirror_drift("doc-d", 5).unwrap();
        assert_eq!(r_b.class, MirrorDriftClass::Both);
        assert!(r_b.mirror_changed);
        assert!(r_b.authority_changed);

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 负向：工具不得把 mirror 路径当权威读 API——本 store 不提供 read_mirror_as_authority。
    #[test]
    fn no_read_mirror_as_authority_api() {
        // 编译期/API 面纪律：公开导入提案 ≠ 权威读。
        // 若未来误加 `read_mirror_as_doc` 类 API，本测文档钉死意图。
        let dir = temp_dir();
        let db = dir.join("workspace.db");
        let store = WorkspaceStore::open(&db).unwrap();
        // detect/import 是唯一与 mirror 文件交互的读路径；export 是写。
        // watcher 轮询同样走 detect，不提供「读 mirror 当权威」。
        let r = store.detect_mirror_drift("nope", 0).unwrap();
        assert_eq!(r.class, MirrorDriftClass::NoMeta);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
