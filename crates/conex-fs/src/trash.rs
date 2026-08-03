//! 回收站服务（I2-S3：删除接管统一接口）
//!
//! 删除的唯一引擎接口：目标文件/目录移入应用内 trash 目录（默认
//! `<data_dir>/trash/`，可经 `TrashService::new` 注入任意根），移入时
//! 保留原始相对路径结构（去根前缀）防同名冲突，每条目写入 `meta.json`
//! 登记（id / 原始路径 / 时间 / 类型 / 大小 / checksum），供 `list` 扫描
//! 与 `restore` 恢复。
//!
//! 回收站双模式：
//! - 模式 A（Windows 系统回收站）：可经 IFileOperation / SHFileOperation
//!   COM API 或 PowerShell `FileSystem.DeleteFile(Path, OnlyErrorDialogs,
//!   SendToRecycleBin)` 调用，但条目不可列出、不可按 id 恢复，且无桌面/
//!   容器/CI 环境不可用——仅作为可选模式，由上层（会话配置 `trash_mode`）
//!   运行时探测选择，本模块不直接依赖 COM；
//! - 模式 B（应用内 trash 目录，本模块实现）：跨平台一致、可列出可恢复，
//!   为默认实现；降级状态由调用方显式上报（工具输出与 UI 明示）。
//!
//! 原子性：同一文件系统内 `rename` 优先（原子移动），跨卷（EXDEV 等）
//! 回退 copy + delete。本模块是产品唯一被允许的物理删除点（S11 G2
//! 禁令的豁免面：删除必须走删除接管接口），其余代码不得直调
//! `fs::remove_*`。

use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Component, Path, PathBuf};

/// 条目类型
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TrashKind {
    /// 普通文件
    File,
    /// 目录（含子树）
    Dir,
}

/// 回收站条目（登记形状，camelCase 对齐工具输出与 meta.json）
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TrashEntry {
    /// 条目唯一 id（trash 根内条目子目录名，可排序）
    pub id: String,
    /// 原始绝对路径（恢复目标）
    pub original_path: PathBuf,
    /// 入回收站时间（纪元毫秒）
    pub trashed_at: i64,
    /// 条目类型
    pub kind: TrashKind,
    /// 总大小（文件为字节数，目录为递归求和）
    pub size: u64,
    /// 文件 SHA-256 校验和（backup=true 时写入，供恢复防篡改校验；
    /// 目录恒为 None）
    pub checksum: Option<String>,
}

/// 条目登记文件（meta.json）形状：TrashEntry + 快照元数据
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct EntryMeta {
    #[serde(flatten)]
    entry: TrashEntry,
    /// 是否写快照（backup=true）
    backup: bool,
    /// 原始元数据快照（backup=true 时写入）
    snapshot: Option<SnapshotMeta>,
}

/// 原始元数据快照（backup=true 时随 checksum 一并登记）
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SnapshotMeta {
    /// 原始修改时间（纪元毫秒）
    mtime: i64,
    /// 原始只读标记
    readonly: bool,
}

/// 回收站服务：管理 trash 根目录内的条目集合
#[derive(Debug, Clone)]
pub struct TrashService {
    root: PathBuf,
}

/// 条目内 payload 挂载目录名（相对结构保留在此）
const PAYLOAD_DIR: &str = "payload";
/// 条目登记文件名
const META_FILE: &str = "meta.json";

impl TrashService {
    /// 新建服务（root 为 trash 根目录，通常为 `<data_dir>/trash/`）
    pub fn new(root: impl Into<PathBuf>) -> Self {
        Self { root: root.into() }
    }

    /// trash 根目录
    pub fn root(&self) -> &Path {
        &self.root
    }

    /// 将目标移入回收站（统一删除接口）
    ///
    /// - 移入前校验目标存在且为普通文件/目录、不在 trash 根内（防递归）；
    /// - 保留原始相对路径结构（去根前缀）防同名冲突；
    /// - `backup=true` 时额外写快照：文件 checksum + 原始元数据 JSON；
    /// - 移动优先同卷 `rename`（原子），失败回退 copy + delete；
    /// - 成功后写 meta.json 登记；登记失败尽力把已移动内容移回原路径。
    pub fn trash_file(&self, path: &Path, backup: bool) -> Result<TrashEntry> {
        let metadata = fs::metadata(path)
            .with_context(|| format!("目标不存在或不可访问：{}", path.display()))?;
        let is_dir = metadata.is_dir();
        if !is_dir && !metadata.is_file() {
            bail!("目标既不是普通文件也不是目录：{}", path.display());
        }
        if path_is_within(&self.root, path) {
            bail!(
                "目标位于回收站根目录内，拒绝入回收站：{}",
                path.display()
            );
        }
        let original = abs_clean(path);
        let id = gen_entry_id();
        let entry_dir = self.root.join(&id);
        let payload_dst = entry_dir
            .join(PAYLOAD_DIR)
            .join(relative_path_of(&original));

        crate::path_utils::ensure_parent_dir(&payload_dst)
            .with_context(|| format!("创建回收站目录失败：{}", payload_dst.display()))?;

        let (checksum, snapshot) = if backup {
            let checksum = if is_dir {
                None
            } else {
                Some(crate::path_utils::compute_file_hash(path)?)
            };
            let snapshot = SnapshotMeta {
                mtime: epoch_millis(metadata.modified().ok()),
                readonly: metadata.permissions().readonly(),
            };
            (checksum, Some(snapshot))
        } else {
            (None, None)
        };
        let size = if is_dir { dir_size(path)? } else { metadata.len() };

        atomic_move(path, &payload_dst, is_dir)
            .with_context(|| format!("移入回收站失败：{}", path.display()))?;

        let entry = TrashEntry {
            id: id.clone(),
            original_path: original.clone(),
            trashed_at: now_millis(),
            kind: if is_dir { TrashKind::Dir } else { TrashKind::File },
            size,
            checksum,
        };
        if let Err(e) = write_meta(&entry_dir, &entry, backup, snapshot) {
            // 登记失败：尽力把已移动内容移回原路径，避免孤儿条目（不吞原始错误）
            let moved_back = atomic_move(&payload_dst, path, is_dir).is_ok();
            if moved_back {
                let _ = fs::remove_dir_all(&entry_dir);
            }
            return Err(e).with_context(|| format!("登记回收站条目失败：{}", path.display()));
        }
        Ok(entry)
    }

    /// 从回收站恢复到原路径（校验 checksum 防篡改）
    ///
    /// - 条目不存在 / 内容缺失 → 结构化错误；
    /// - backup=true 的条目先重算校验和比对，不匹配拒绝恢复（防篡改）；
    /// - 原路径已存在 → 拒绝覆盖（不静默覆盖用户文件）；
    /// - 恢复成功后移除条目目录（登记一并清除）。
    pub fn restore(&self, entry_id: &str) -> Result<PathBuf> {
        let entry_dir = self.entry_dir(entry_id)?;
        if !entry_dir.is_dir() {
            bail!("回收站条目不存在：{entry_id}");
        }
        let meta = read_meta(&entry_dir)?;
        let entry = &meta.entry;
        let is_dir = entry.kind == TrashKind::Dir;
        let payload = entry_dir
            .join(PAYLOAD_DIR)
            .join(relative_path_of(&entry.original_path));
        if !payload.exists() {
            bail!("条目内容缺失，无法恢复：{}", payload.display());
        }
        if let Some(expected) = &entry.checksum {
            let actual = crate::path_utils::compute_file_hash(&payload)?;
            if &actual != expected {
                bail!("条目内容校验失败（checksum 不匹配），可能已被篡改：{entry_id}");
            }
        }
        let original = &entry.original_path;
        if original.exists() {
            bail!("原路径已存在，拒绝覆盖：{}", original.display());
        }
        crate::path_utils::ensure_parent_dir(original)?;
        atomic_move(&payload, original, is_dir)?;
        // 恢复成功后清理条目目录（移除登记与空壳）；清理失败不阻塞恢复结果
        let _ = fs::remove_dir_all(&entry_dir);
        Ok(original.clone())
    }

    /// 扫描 trash 根目录，返回全部登记条目（按入回收站时间倒序）
    ///
    /// 缺失/损坏登记文件的目录被跳过（不 panic、不阻断其它条目）。
    pub fn list(&self) -> Vec<TrashEntry> {
        let mut entries = Vec::new();
        let rd = match fs::read_dir(&self.root) {
            Ok(rd) => rd,
            Err(_) => return entries,
        };
        for entry in rd.flatten() {
            let path = entry.path();
            let is_dir = entry.file_type().map(|t| t.is_dir()).unwrap_or(false);
            if !is_dir {
                continue;
            }
            if let Ok(meta) = read_meta(&path) {
                entries.push(meta.entry);
            }
        }
        entries.sort_by_key(|e| std::cmp::Reverse(e.trashed_at));
        entries
    }

    /// 彻底清除条目（显式用户调用，不自动触发）
    pub fn purge(&self, entry_id: &str) -> Result<()> {
        let entry_dir = self.entry_dir(entry_id)?;
        if !entry_dir.is_dir() {
            bail!("回收站条目不存在：{entry_id}");
        }
        fs::remove_dir_all(&entry_dir)
            .with_context(|| format!("清除条目失败：{entry_id}"))?;
        Ok(())
    }

    /// 条目目录：entry_id 必须为单段名称（防路径穿越）
    fn entry_dir(&self, entry_id: &str) -> Result<PathBuf> {
        if entry_id.is_empty()
            || entry_id == "."
            || entry_id == ".."
            || entry_id.contains('/')
            || entry_id.contains('\\')
        {
            bail!("非法条目 id：{entry_id:?}");
        }
        Ok(self.root.join(entry_id))
    }
}

/// 写登记文件（meta.json）
fn write_meta(
    entry_dir: &Path,
    entry: &TrashEntry,
    backup: bool,
    snapshot: Option<SnapshotMeta>,
) -> Result<()> {
    let meta = EntryMeta {
        entry: entry.clone(),
        backup,
        snapshot,
    };
    let json = serde_json::to_string_pretty(&meta)?;
    fs::write(entry_dir.join(META_FILE), json)?;
    Ok(())
}

/// 读登记文件（meta.json）
fn read_meta(entry_dir: &Path) -> Result<EntryMeta> {
    let path = entry_dir.join(META_FILE);
    let content = fs::read_to_string(&path)
        .with_context(|| format!("读取登记文件失败：{}", path.display()))?;
    let meta: EntryMeta = serde_json::from_str(&content)
        .with_context(|| format!("解析登记文件失败：{}", path.display()))?;
    Ok(meta)
}

/// 原子移动：同卷 `rename` 优先；失败（跨卷 / 目标已存在等）回退 copy + delete
fn atomic_move(src: &Path, dst: &Path, is_dir: bool) -> Result<()> {
    match fs::rename(src, dst) {
        Ok(()) => Ok(()),
        Err(_) => {
            if is_dir {
                copy_dir_all(src, dst)?;
            } else {
                fs::copy(src, dst)?;
            }
            remove_all(src, is_dir)?;
            Ok(())
        }
    }
}

/// 递归复制目录（跨卷回退与测试辅助共用）
fn copy_dir_all(src: &Path, dst: &Path) -> Result<()> {
    fs::create_dir_all(dst)
        .with_context(|| format!("创建目录失败：{}", dst.display()))?;
    for entry in fs::read_dir(src)? {
        let entry = entry?;
        let target = dst.join(entry.file_name());
        if entry.file_type()?.is_dir() {
            copy_dir_all(&entry.path(), &target)?;
        } else {
            fs::copy(entry.path(), &target)?;
        }
    }
    Ok(())
}

/// 物理删除（本模块为产品唯一物理删除点，其余代码不得直调 fs::remove_*）
fn remove_all(path: &Path, is_dir: bool) -> Result<()> {
    if is_dir {
        fs::remove_dir_all(path)
            .with_context(|| format!("删除目录失败：{}", path.display()))?;
    } else {
        fs::remove_file(path)
            .with_context(|| format!("删除文件失败：{}", path.display()))?;
    }
    Ok(())
}

/// 目录递归大小（字节）
fn dir_size(path: &Path) -> Result<u64> {
    let mut total = 0u64;
    for entry in fs::read_dir(path)? {
        let entry = entry?;
        if entry.file_type()?.is_dir() {
            total += dir_size(&entry.path())?;
        } else {
            total += entry.metadata().map(|m| m.len()).unwrap_or(0);
        }
    }
    Ok(total)
}

/// 绝对化并剥离 Windows verbatim 前缀（`\\?\` / `\\?\UNC\`）
fn abs_clean(path: &Path) -> PathBuf {
    let abs = if path.is_absolute() {
        path.to_path_buf()
    } else {
        std::env::current_dir()
            .map(|c| c.join(path))
            .unwrap_or_else(|_| path.to_path_buf())
    };
    strip_verbatim(&abs)
}

/// 剥离 Windows canonicalize 的 verbatim 前缀（其它平台原样返回）
fn strip_verbatim(path: &Path) -> PathBuf {
    #[cfg(windows)]
    {
        let s = path.to_string_lossy();
        if let Some(rest) = s.strip_prefix(r"\\?\UNC\") {
            return PathBuf::from(format!("\\{rest}"));
        }
        if let Some(rest) = s.strip_prefix(r"\\?\") {
            return PathBuf::from(rest.to_string());
        }
    }
    path.to_path_buf()
}

/// 去根前缀的相对路径（C:\a\b.txt → a/b.txt；/home/u/x → home/u/x）
///
/// 与 entry id 配合保证不同来源同名文件互不冲突。
fn relative_path_of(path: &Path) -> PathBuf {
    let mut rel = PathBuf::new();
    for comp in path.components() {
        match comp {
            Component::Prefix(_) | Component::RootDir => {}
            Component::Normal(_) => rel.push(comp.as_os_str()),
            _ => {}
        }
    }
    if rel.as_os_str().is_empty() {
        // 目标恰好为根目录自身（正常流程不会出现，防御性回退）
        if let Some(name) = path.file_name() {
            rel.push(name);
        } else {
            rel.push("root");
        }
    }
    rel
}

/// 路径包含性（candidate 在 root 内或与 root 相同）
///
/// 用于「目标不得位于 trash 根内」守卫；Windows 盘符大小写差异
/// 由 abs_clean 后的字符串前缀比较承担（守卫非攻击边界）。
fn path_is_within(root: &Path, candidate: &Path) -> bool {
    let root = abs_clean(root);
    let candidate = abs_clean(candidate);
    let r = root.to_string_lossy();
    let c = candidate.to_string_lossy();
    if c == r {
        return true;
    }
    let sep = std::path::MAIN_SEPARATOR.to_string();
    c.starts_with(&format!("{r}{sep}"))
}

/// 条目 id：时间戳（hex 纪元毫秒）+ 序号 + 进程号，进程内唯一且可排序
fn gen_entry_id() -> String {
    use std::sync::atomic::{AtomicU64, Ordering};
    static SEQ: AtomicU64 = AtomicU64::new(0);
    let millis = now_millis();
    let seq = SEQ.fetch_add(1, Ordering::Relaxed);
    format!("t{millis:x}-{seq:x}{:x}", std::process::id())
}

/// 当前纪元毫秒（时钟不可用时 0）
fn now_millis() -> i64 {
    epoch_millis(Some(std::time::SystemTime::now()))
}

/// 系统时间 → 纪元毫秒（对齐全仓 epoch ms 惯例；不可用时 0）
fn epoch_millis(t: Option<std::time::SystemTime>) -> i64 {
    t.and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use std::sync::atomic::{AtomicU64, Ordering};

    static TMP_SEQ: AtomicU64 = AtomicU64::new(0);

    /// 测试用临时目录（独立命名，drop 自动清理）
    struct TempDir(PathBuf);

    impl TempDir {
        fn new(prefix: &str) -> Self {
            let seq = TMP_SEQ.fetch_add(1, Ordering::Relaxed);
            let path = std::env::temp_dir().join(format!(
                "conex_fs_trash_{prefix}_{}_{seq}",
                std::process::id()
            ));
            std::fs::create_dir_all(&path).unwrap();
            Self(path)
        }

        fn path(&self) -> &Path {
            &self.0
        }

        fn write(&self, rel: &str, content: &str) -> PathBuf {
            let p = self.0.join(rel);
            if let Some(parent) = p.parent() {
                std::fs::create_dir_all(parent).unwrap();
            }
            std::fs::write(&p, content).unwrap();
            p
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    /// 快速建服务：独立回收站根
    fn service() -> TrashService {
        let trash = TempDir::new("root");
        TrashService::new(trash.path())
    }

    #[test]
    fn trash_list_restore_roundtrip() {
        let src = TempDir::new("rt");
        let file = src.write("a.txt", "hello trash");
        let svc = service();

        let entry = svc.trash_file(&file, true).unwrap();
        assert_eq!(entry.kind, TrashKind::File);
        assert_eq!(entry.original_path, file);
        assert!(entry.checksum.is_some());
        assert_eq!(entry.size, 11);
        assert!(!file.exists(), "删除后原路径应消失");

        let entries = svc.list();
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].id, entry.id);

        let restored = svc.restore(&entry.id).unwrap();
        assert_eq!(restored, file);
        assert_eq!(std::fs::read_to_string(&file).unwrap(), "hello trash");
        assert!(svc.list().is_empty(), "恢复后登记应清除");
    }

    #[test]
    fn trash_directory_recursive_restore() {
        let src = TempDir::new("dir");
        src.write("sub/inner.txt", "inner");
        src.write("sub/deep/x.txt", "x");
        let dir = src.0.join("sub");
        let svc = service();

        let entry = svc.trash_file(&dir, true).unwrap();
        assert_eq!(entry.kind, TrashKind::Dir);
        assert!(entry.checksum.is_none(), "目录不写单文件 checksum");
        assert!(!dir.exists());

        svc.restore(&entry.id).unwrap();
        assert_eq!(std::fs::read_to_string(dir.join("inner.txt")).unwrap(), "inner");
        assert_eq!(std::fs::read_to_string(dir.join("deep/x.txt")).unwrap(), "x");
    }

    #[test]
    fn tampered_payload_rejected_on_restore() {
        let src = TempDir::new("tamper");
        let file = src.write("a.txt", "original");
        let trash = TempDir::new("root");
        let svc = TrashService::new(trash.path());

        let entry = svc.trash_file(&file, true).unwrap();
        // 篡改 payload 内容
        let payload = trash
            .0
            .join(&entry.id)
            .join(PAYLOAD_DIR)
            .join(relative_path_of(&entry.original_path));
        let mut f = fs::File::create(&payload).unwrap();
        f.write_all(b"tampered").unwrap();
        drop(f);

        let err = svc.restore(&entry.id).unwrap_err();
        assert!(err.to_string().contains("校验失败"));
        // 篡改条目仍保留在回收站（恢复失败不清登记）
        assert_eq!(svc.list().len(), 1);
        assert!(!file.exists(), "恢复失败不得产生目标文件");
    }

    #[test]
    fn same_name_different_dirs_no_conflict() {
        let src = TempDir::new("conflict");
        let f1 = src.write("x/a.txt", "from x");
        let f2 = src.write("y/a.txt", "from y");
        let svc = service();

        let e1 = svc.trash_file(&f1, true).unwrap();
        let e2 = svc.trash_file(&f2, true).unwrap();
        assert_ne!(e1.id, e2.id, "同名文件必须分属不同条目");

        svc.restore(&e1.id).unwrap();
        svc.restore(&e2.id).unwrap();
        assert_eq!(std::fs::read_to_string(&f1).unwrap(), "from x");
        assert_eq!(std::fs::read_to_string(&f2).unwrap(), "from y");
    }

    #[test]
    fn purge_removes_entry() {
        let src = TempDir::new("purge");
        let file = src.write("a.txt", "doomed");
        let svc = service();

        let entry = svc.trash_file(&file, false).unwrap();
        svc.purge(&entry.id).unwrap();
        assert!(svc.list().is_empty());
        assert!(svc.restore(&entry.id).is_err(), "purge 后不可恢复");
    }

    #[test]
    fn trash_rejects_path_inside_trash_root() {
        let trash = TempDir::new("root");
        let svc = TrashService::new(trash.path());
        let inner = trash.write("already.txt", "x");

        let err = svc.trash_file(&inner, false).unwrap_err();
        assert!(err.to_string().contains("回收站根目录"));
        assert!(inner.exists(), "守卫拒绝时不得移动文件");
    }

    #[test]
    fn backup_false_omits_checksum_but_restores() {
        let src = TempDir::new("nobackup");
        let file = src.write("a.txt", "no backup");
        let svc = service();

        let entry = svc.trash_file(&file, false).unwrap();
        assert!(entry.checksum.is_none());
        // 登记文件不写快照字段
        let meta_path = svc.root().join(&entry.id).join(META_FILE);
        let meta = std::fs::read_to_string(meta_path).unwrap();
        assert!(meta.contains("\"backup\": false"));

        svc.restore(&entry.id).unwrap();
        assert_eq!(std::fs::read_to_string(&file).unwrap(), "no backup");
    }

    #[test]
    fn atomic_move_fallback_copy_delete() {
        // 目标已存在（Windows 上 rename 拒绝覆盖 → 走 copy + delete 回退；
        // Unix 上 rename 直接覆盖 → 结果等价），两种平台断言一致
        let src = TempDir::new("fallback");
        let from = src.write("from.txt", "payload");
        let dst = src.write("to.txt", "old");

        atomic_move(&from, &dst, false).unwrap();
        assert_eq!(std::fs::read_to_string(&dst).unwrap(), "payload");
        assert!(!from.exists(), "回退成功后源应被删除");
    }

    #[test]
    fn list_ignores_non_entry_items() {
        let trash = TempDir::new("root");
        let svc = TrashService::new(trash.path());
        // 根内杂项文件与缺登记的目录都被忽略
        trash.write("README.txt", "stray");
        let orphan_dir = trash.0.join("orphan");
        fs::create_dir_all(&orphan_dir).unwrap();

        let src = TempDir::new("list");
        let file = src.write("a.txt", "x");
        svc.trash_file(&file, true).unwrap();

        assert_eq!(svc.list().len(), 1);
    }

    #[test]
    fn restore_rejects_missing_and_invalid_ids() {
        let svc = service();
        assert!(svc.restore("nope").is_err());
        assert!(svc.restore("../../evil").is_err());
        assert!(svc.restore("a/b").is_err());
        assert!(svc.purge("../evil").is_err());
    }

    #[test]
    fn restore_rejects_existing_destination() {
        let src = TempDir::new("exist");
        let file = src.write("a.txt", "one");
        let svc = service();

        let entry = svc.trash_file(&file, true).unwrap();
        // 原路径被重新占用后拒绝覆盖恢复
        src.write("a.txt", "new file");

        let err = svc.restore(&entry.id).unwrap_err();
        assert!(err.to_string().contains("拒绝覆盖"));
        assert_eq!(std::fs::read_to_string(&file).unwrap(), "new file");
        assert_eq!(svc.list().len(), 1, "恢复失败条目保留");
    }

    #[test]
    fn meta_json_registers_camel_case_fields() {
        let src = TempDir::new("meta");
        let file = src.write("a.txt", "registered");
        let svc = service();

        let entry = svc.trash_file(&file, true).unwrap();
        let meta_path = svc.root().join(&entry.id).join(META_FILE);
        let meta = std::fs::read_to_string(meta_path).unwrap();
        // 登记字段 camelCase + 快照字段
        assert!(meta.contains("\"originalPath\""));
        assert!(meta.contains("\"trashedAt\""));
        assert!(meta.contains("\"checksum\""));
        assert!(meta.contains("\"backup\": true"));
        assert!(meta.contains("\"snapshot\""));
        assert!(meta.contains("\"readonly\""));
    }

    #[test]
    fn trash_file_missing_target_errors() {
        let src = TempDir::new("missing");
        let svc = service();
        let err = svc
            .trash_file(&src.0.join("ghost.txt"), false)
            .unwrap_err();
        assert!(err.to_string().contains("不存在"));
    }
}
