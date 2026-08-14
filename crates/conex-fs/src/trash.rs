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
//! 写前自动备份（I3-S10b 中间件钩子的存储面）：[TrashService::snapshot] 把
//! 目标文件**复制**进回收站域并登记（原路径保留，写工具随后覆盖写入），
//! 与 [TrashService::trash_file] 的「移入」语义互补——删除走移入、写类走
//! 复制快照。目标原不存在时登记 nil-content 条目（[EntryMode::Snapshot] +
//! `original_existed=false`），恢复语义 = 删除原路径（对齐 FileSnap
//! `Content == nil` 反向语义）。快照条目经 [TrashService::restore_force]
//! 覆盖写回恢复（原路径必然存在，`restore` 的「拒绝覆盖」守卫不适用）。
//!
//! 原子性：同一文件系统内 `rename` 优先（原子移动），跨卷（EXDEV 等）
//! 回退 copy + delete。本模块是产品唯一被允许的物理删除点（S11 G2
//! 禁令的豁免面：删除必须走删除接管接口），其余代码不得直调
//! `fs::remove_*`。

// G2 禁令豁免面（01 方案 S11 / 04 方案 G2，与 clippy.toml 文件头「豁免面」对应）：
// 本模块是产品唯一物理删除点（S3 删除接管实现本体）——purge / 原子移动回退 /
// 登记失败回滚 / 恢复后清理均为回收站实现内部语义，物理删除的「可恢复前提」
// 由本模块的移动 + 登记机制承担，不再经过其它删除接管接口。
#![allow(clippy::disallowed_methods)]

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

/// 条目模式（决定恢复语义）
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum EntryMode {
    /// 移入回收站（trash_file 产生）：恢复 = 移回原路径（拒绝覆盖）
    #[default]
    Trash,
    /// 复制快照（snapshot 产生，S10b 写前备份）：恢复 = 覆盖写回原路径
    Snapshot,
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
    /// 条目模式（旧登记无此字段时按 Trash 兼容）
    #[serde(default)]
    pub mode: EntryMode,
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
    /// 快照时原路径是否已存在（nil-content 条目为 false，S10b 写前备份；
    /// 旧登记无此字段按 true 兼容）
    #[serde(default = "default_true")]
    original_existed: bool,
}

/// serde 缺省值：原路径已存在（旧条目兼容）
fn default_true() -> bool {
    true
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
            bail!("目标位于回收站根目录内，拒绝入回收站：{}", path.display());
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
        let size = if is_dir {
            dir_size(path)?
        } else {
            metadata.len()
        };

        atomic_move(path, &payload_dst, is_dir)
            .with_context(|| format!("移入回收站失败：{}", path.display()))?;

        let entry = TrashEntry {
            id: id.clone(),
            original_path: original.clone(),
            trashed_at: now_millis(),
            kind: if is_dir {
                TrashKind::Dir
            } else {
                TrashKind::File
            },
            size,
            checksum,
            mode: EntryMode::Trash,
        };
        if let Err(e) = write_meta(&entry_dir, &entry, backup, snapshot, true) {
            // 登记失败：尽力把已移动内容移回原路径，避免孤儿条目（不吞原始错误）
            let moved_back = atomic_move(&payload_dst, path, is_dir).is_ok();
            if moved_back {
                let _ = force_remove_dir_all(&entry_dir);
            }
            return Err(e).with_context(|| format!("登记回收站条目失败：{}", path.display()));
        }
        Ok(entry)
    }

    /// 写前自动备份快照（S10b 中间件钩子存储面）
    pub fn snapshot(&self, path: &Path) -> Result<TrashEntry> {
        if path_is_within(&self.root, path) {
            bail!("目标位于回收站根目录内，拒绝快照：{}", path.display());
        }
        let original = abs_clean(path);
        let id = gen_entry_id();
        let entry_dir = self.root.join(&id);
        let payload_dst = entry_dir
            .join(PAYLOAD_DIR)
            .join(relative_path_of(&original));

        let metadata_res = fs::symlink_metadata(path);
        let metadata = match metadata_res {
            Ok(m) => m,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                crate::path_utils::ensure_parent_dir(&entry_dir.join(META_FILE))?;
                let entry = TrashEntry {
                    id: id.clone(),
                    original_path: original.clone(),
                    trashed_at: now_millis(),
                    kind: TrashKind::File,
                    size: 0,
                    checksum: None,
                    mode: EntryMode::Snapshot,
                };
                write_meta(&entry_dir, &entry, true, None, false)?;
                return Ok(entry);
            }
            Err(e) => {
                return Err(e).with_context(|| {
                    format!("快照目标元数据获取失败 (Fail-Closed)：{}", path.display())
                });
            }
        };

        if metadata.is_dir() {
            bail!("快照仅支持普通文件，拒绝目录：{}", path.display());
        }

        crate::path_utils::ensure_parent_dir(&payload_dst)?;
        fs::copy(path, &payload_dst)
            .with_context(|| format!("复制快照失败：{}", path.display()))?;

        let checksum = Some(crate::path_utils::compute_file_hash(path)?);
        let snapshot = SnapshotMeta {
            mtime: epoch_millis(metadata.modified().ok()),
            readonly: metadata.permissions().readonly(),
        };
        let entry = TrashEntry {
            id: id.clone(),
            original_path: original.clone(),
            trashed_at: now_millis(),
            kind: TrashKind::File,
            size: metadata.len(),
            checksum,
            mode: EntryMode::Snapshot,
        };
        if let Err(e) = write_meta(&entry_dir, &entry, true, Some(snapshot), true) {
            let _ = force_remove_dir_all(&entry_dir);
            return Err(e).with_context(|| format!("登记快照条目失败：{}", path.display()));
        }
        Ok(entry)
    }

    /// 恢复条目至原始路径（恢复语义与 entry.mode 绑定）
    pub fn restore(&self, entry_id: &str) -> Result<PathBuf> {
        let entry_dir = self.entry_dir(entry_id)?;
        if !entry_dir.is_dir() {
            bail!("回收站条目不存在：{entry_id}");
        }
        let meta = read_meta(&entry_dir)?;
        let entry = &meta.entry;
        if entry.mode == EntryMode::Snapshot {
            bail!(
                "条目为快照条目（写前备份，原路径仍存在），请用覆盖恢复接口（restore_force）：{entry_id}"
            );
        }
        // 原路径全链校验（read_meta 之后、payload 移动之前，fail-fast）：
        // 绝对路径 + 无 .. 穿越 + 不在 trash 根内（防 meta.json 被篡改后越界写入）
        validate_original_path(&entry.original_path, &self.root)?;

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
        let _ = force_remove_dir_all(&entry_dir);
        Ok(original.clone())
    }

    /// 覆盖式恢复（快照条目专用，S10b 写前备份）
    pub fn restore_force(&self, entry_id: &str) -> Result<PathBuf> {
        let entry_dir = self.entry_dir(entry_id)?;
        if !entry_dir.is_dir() {
            bail!("回收站条目不存在：{entry_id}");
        }
        let meta = read_meta(&entry_dir)?;
        let entry = &meta.entry;
        // 原路径全链校验（read_meta 之后、nil-content 删除分支之前，fail-fast）：
        // 绝对路径 + 无 .. 穿越 + 不在 trash 根内（防 meta.json 被篡改后越界删除）
        validate_original_path(&entry.original_path, &self.root)?;
        let original = &entry.original_path;
        if !meta.original_existed {
            // nil-content 条目：恢复 = 删除原路径（快照条目恒为文件）。
            // 双条件收紧：仅当 payload 目录确实不存在才允许删除——
            // payload 意外存在即拒绝（防登记损坏/篡改后误删任意文件）
            if entry_dir.join(PAYLOAD_DIR).exists() {
                bail!(
                    "条目内容意外存在（nil-content 条目不应有 payload），拒绝删除，请检查条目：{entry_id}"
                );
            }
            if original.exists() {
                force_remove_all(original, false)?;
            }
            let _ = force_remove_dir_all(&entry_dir);
            return Ok(original.clone());
        }
        let payload = entry_dir.join(PAYLOAD_DIR).join(relative_path_of(original));
        if !payload.exists() {
            bail!("条目内容缺失，无法恢复：{}", payload.display());
        }
        if let Some(expected) = &entry.checksum {
            let actual = crate::path_utils::compute_file_hash(&payload)?;
            if &actual != expected {
                bail!("条目内容校验失败（checksum 不匹配），可能已被篡改：{entry_id}");
            }
        }
        crate::path_utils::ensure_parent_dir(original)?;
        fs::copy(&payload, original)
            .with_context(|| format!("恢复写回失败：{}", original.display()))?;
        let _ = force_remove_dir_all(&entry_dir);
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
        force_remove_dir_all(&entry_dir).with_context(|| format!("清除条目失败：{entry_id}"))?;
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
    original_existed: bool,
) -> Result<()> {
    let meta = EntryMeta {
        entry: entry.clone(),
        backup,
        snapshot,
        original_existed,
    };
    let json = serde_json::to_string_pretty(&meta)?;
    let target = entry_dir.join(META_FILE);
    let tmp = entry_dir.join(format!("{META_FILE}.agent-tmp"));
    if let Err(e) = fs::write(&tmp, json) {
        // 写临时文件失败：清理残骸后透传错误
        let _ = force_remove_file(&tmp);
        return Err(e).with_context(|| format!("写登记临时文件失败：{}", tmp.display()));
    }
    // Windows 上 rename 不覆盖既有目标：先 remove 再 rename（同目录无跨卷
    // 风险；Unix 上 rename 本身原子覆盖，跳过 remove 以保持原子性）
    #[cfg(windows)]
    if target.exists() {
        force_remove_file(&target)?;
    }
    if let Err(e) = fs::rename(&tmp, &target) {
        // rename 失败：清理临时文件，不留残骸
        let _ = force_remove_file(&tmp);
        return Err(e).with_context(|| format!("原子替换登记文件失败：{}", target.display()));
    }
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

/// 恢复原路径三重校验（防 meta.json 被篡改/损坏后越界移动、复制或删除）
///
/// ① 必须是绝对路径（拒绝相对路径）；② 组件不含 `..`（拒绝穿越）；
/// ③ 不得位于 trash 根内（拒绝把回收站内容当恢复目标）。
/// 写入侧恒绝对路径（abs_clean 保证），相对/异常路径仅来自登记数据异常，
/// 拒绝文案提示重建条目。
fn validate_original_path(original: &Path, trash_root: &Path) -> Result<()> {
    if !original.is_absolute() {
        bail!(
            "原路径不是绝对路径，拒绝恢复（登记数据异常，请重建条目）：{}",
            original.display()
        );
    }
    if original.components().any(|c| c == Component::ParentDir) {
        bail!(
            "原路径含「..」穿越组件，拒绝恢复（登记数据异常，请重建条目）：{}",
            original.display()
        );
    }
    if path_is_within(trash_root, original) {
        bail!("原路径位于回收站根目录内，拒绝恢复：{}", original.display());
    }
    Ok(())
}

/// 原子移动：同卷 `rename` 优先；失败（跨卷 / 目标已存在等）回退 copy + delete。
/// 跨卷移动若源文件/目录删除失败，必须自动调用事务补偿清理删除 dst 已写入的 Payload，绝不残留幽灵孤儿数据！
fn atomic_move(src: &Path, dst: &Path, is_dir: bool) -> Result<()> {
    match fs::rename(src, dst) {
        Ok(()) => Ok(()),
        Err(_) => {
            if is_dir {
                copy_dir_all(src, dst)?;
            } else {
                fs::copy(src, dst)?;
            }
            if let Err(e) = force_remove_all(src, is_dir) {
                // 事务补偿回滚：源文件/目录删除失败时，必须自动删除 dst 已经写入的 Payload，绝不残留幽灵孤儿数据！
                let _ = force_remove_all(dst, is_dir);
                return Err(e).with_context(|| {
                    format!(
                        "跨卷移动删除源失败，已触发事务补偿清理删除目标：src={}, dst={}",
                        src.display(),
                        dst.display()
                    )
                });
            }
            Ok(())
        }
    }
}

/// 递归复制目录（跨卷回退与测试辅助共用）
fn copy_dir_all(src: &Path, dst: &Path) -> Result<()> {
    fs::create_dir_all(dst).with_context(|| format!("创建目录失败：{}", dst.display()))?;
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

/// 强制删除文件（遇到 Windows 只读属性 FILE_ATTRIBUTE_READONLY 时自动清除只读属性并重试）
pub fn force_remove_file(path: &Path) -> Result<()> {
    match fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(e) => {
            // 若删除失败，检查并尝试清除只读属性后重试
            if let Ok(meta) = fs::symlink_metadata(path) {
                let mut perms = meta.permissions();
                if perms.readonly() {
                    perms.set_readonly(false);
                    let _ = fs::set_permissions(path, perms);
                    return fs::remove_file(path).with_context(|| {
                        format!("清除只读属性后删除文件仍失败：{}", path.display())
                    });
                }
            }
            Err(e).with_context(|| format!("删除文件失败：{}", path.display()))
        }
    }
}

/// 递归清除目录树内所有条目（文件与子目录）的只读属性
fn clear_readonly_recursive(path: &Path) {
    if let Ok(meta) = fs::symlink_metadata(path) {
        let mut perms = meta.permissions();
        if perms.readonly() {
            perms.set_readonly(false);
            let _ = fs::set_permissions(path, perms);
        }
        if meta.is_dir() && !meta.is_symlink() {
            if let Ok(entries) = fs::read_dir(path) {
                for entry in entries.flatten() {
                    clear_readonly_recursive(&entry.path());
                }
            }
        }
    }
}

/// 强制删除目录（遇到 Windows 只读属性时递归清除只读属性并重试）
pub fn force_remove_dir_all(path: &Path) -> Result<()> {
    match fs::remove_dir_all(path) {
        Ok(()) => Ok(()),
        Err(e) => {
            clear_readonly_recursive(path);
            fs::remove_dir_all(path).with_context(|| {
                format!(
                    "清除只读属性后删除目录仍失败（原错误: {e}）：{}",
                    path.display()
                )
            })
        }
    }
}

/// 物理删除总入口（强制清除只读属性）
pub fn force_remove_all(path: &Path, is_dir: bool) -> Result<()> {
    if is_dir {
        force_remove_dir_all(path)
    } else {
        force_remove_file(path)
    }
}

/// 目录递归大小（字节）
///
/// 遍历统一使用不跟随符号链接的元数据入口（`DirEntry::file_type` +
/// `symlink_metadata`）：目录内 symlink/junction 按单条计（取链接自身
/// 大小），不跟随目标、不递归——防指向祖先的链接环导致无限递归栈溢出。
fn dir_size(path: &Path) -> Result<u64> {
    let mut total = 0u64;
    for entry in fs::read_dir(path)? {
        let entry = entry?;
        let ft = entry.file_type()?;
        if ft.is_symlink() {
            // 符号链接/目录联接（junction）：按单条计（取链接自身大小），
            // 不跟随目标、不递归（防指向祖先的环导致无限递归栈溢出）
            total += std::fs::symlink_metadata(entry.path())
                .map(|m| m.len())
                .unwrap_or(0);
            continue;
        }
        if ft.is_dir() {
            total += dir_size(&entry.path())?;
        } else {
            // 普通文件：symlink_metadata 与 metadata 等价，统一单一元数据入口
            total += std::fs::symlink_metadata(entry.path())
                .map(|m| m.len())
                .unwrap_or(0);
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
    crate::path_utils::strip_verbatim_prefix(&abs)
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
/// 用于「目标不得位于 trash 根内」守卫（非攻击边界，防递归为主）；
/// 归一化口径：统一分隔符 + Windows 大小写不敏感 + 去尾部分隔符，
/// 与 abs_clean 配合消除盘符大小写差异（对齐 agent-tools mod.rs
/// `normalize_for_compare`，消除注释声明与实现矛盾）。
fn path_is_within(root: &Path, candidate: &Path) -> bool {
    let root = abs_clean(root);
    let candidate = abs_clean(candidate);
    let r = normalize_for_compare(&root);
    let c = normalize_for_compare(&candidate);
    if c == r {
        return true;
    }
    let sep = std::path::MAIN_SEPARATOR.to_string();
    c.starts_with(&format!("{r}{sep}"))
}

/// 比较用归一化：统一分隔符 + Windows 小写 + 去尾部分隔符
/// （对齐 agent-tools mod.rs normalize_for_compare 口径）
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
        assert_eq!(
            std::fs::read_to_string(dir.join("inner.txt")).unwrap(),
            "inner"
        );
        assert_eq!(
            std::fs::read_to_string(dir.join("deep/x.txt")).unwrap(),
            "x"
        );
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
        let err = svc.trash_file(&src.0.join("ghost.txt"), false).unwrap_err();
        assert!(err.to_string().contains("不存在"));
    }

    // ── S10b 写前自动备份：snapshot / restore_force ──

    #[test]
    fn snapshot_copies_and_registers() {
        let src = TempDir::new("snap");
        let file = src.write("a.txt", "original");
        let svc = service();

        let entry = svc.snapshot(&file).unwrap();
        assert_eq!(entry.mode, EntryMode::Snapshot);
        assert_eq!(entry.kind, TrashKind::File);
        assert!(entry.checksum.is_some(), "快照必写校验和");
        // 原路径保留且内容未变（复制语义，非移入）
        assert_eq!(std::fs::read_to_string(&file).unwrap(), "original");

        let entries = svc.list();
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].id, entry.id);
        assert_eq!(entries[0].mode, EntryMode::Snapshot);
    }

    #[test]
    fn snapshot_restore_force_overwrites() {
        let src = TempDir::new("snap_rf");
        let file = src.write("doc.txt", "good version");
        let svc = service();

        let entry = svc.snapshot(&file).unwrap();
        // 模拟写工具覆盖写入「坏版本」
        std::fs::write(&file, "bad version").unwrap();

        let restored = svc.restore_force(&entry.id).unwrap();
        assert_eq!(restored, file);
        assert_eq!(std::fs::read_to_string(&file).unwrap(), "good version");
        assert!(svc.list().is_empty(), "覆盖恢复后登记应清除");
    }

    #[test]
    fn snapshot_nil_content_restore_force_deletes() {
        let src = TempDir::new("snap_nil");
        let file = src.0.join("fresh.txt");
        let svc = service();

        // 目标原不存在 → nil-content 条目
        let entry = svc.snapshot(&file).unwrap();
        assert_eq!(entry.mode, EntryMode::Snapshot);
        assert_eq!(entry.size, 0);
        assert!(entry.checksum.is_none());
        assert!(!file.exists());

        // 之后文件被创建（写工具写入），恢复 = 删除原路径
        std::fs::write(&file, "created later").unwrap();
        let restored = svc.restore_force(&entry.id).unwrap();
        assert_eq!(restored, file);
        assert!(!file.exists(), "nil-content 恢复 = 删除原路径");
        assert!(svc.list().is_empty());
    }

    #[test]
    fn snapshot_rejects_dir_and_inside_trash_root() {
        let src = TempDir::new("snap_guard");
        src.write("sub/x.txt", "x");
        let svc = service();

        // 目录拒绝（写工具不写目录）
        let err = svc.snapshot(&src.0.join("sub")).unwrap_err();
        assert!(err.to_string().contains("仅支持普通文件"));

        // 回收站根内目标拒绝（防递归/双份）
        let trash = TempDir::new("root");
        let svc2 = TrashService::new(trash.path());
        let inner = trash.write("already.txt", "x");
        let err = svc2.snapshot(&inner).unwrap_err();
        assert!(err.to_string().contains("回收站根目录"));
        assert!(inner.exists(), "守卫拒绝时不得移动文件");
    }

    #[test]
    fn snapshot_tampered_payload_rejected_on_force_restore() {
        let src = TempDir::new("snap_tamper");
        let file = src.write("a.txt", "original");
        let trash = TempDir::new("root");
        let svc = TrashService::new(trash.path());

        let entry = svc.snapshot(&file).unwrap();
        let payload = trash
            .0
            .join(&entry.id)
            .join(PAYLOAD_DIR)
            .join(relative_path_of(&entry.original_path));
        let mut f = fs::File::create(&payload).unwrap();
        f.write_all(b"tampered").unwrap();
        drop(f);

        let err = svc.restore_force(&entry.id).unwrap_err();
        assert!(err.to_string().contains("校验失败"));
        assert_eq!(std::fs::read_to_string(&file).unwrap(), "original");
        assert_eq!(svc.list().len(), 1, "恢复失败条目保留");
    }

    #[test]
    fn restore_rejects_snapshot_entry() {
        let src = TempDir::new("snap_mix");
        let file = src.write("a.txt", "x");
        let svc = service();

        let entry = svc.snapshot(&file).unwrap();
        let err = svc.restore(&entry.id).unwrap_err();
        assert!(err.to_string().contains("覆盖恢复"));

        // 移入条目（Trash 模式）不受影响
        let file2 = src.write("b.txt", "y");
        let moved = svc.trash_file(&file2, true).unwrap();
        assert_eq!(moved.mode, EntryMode::Trash);
        svc.restore(&moved.id).unwrap();
    }

    #[test]
    fn meta_registers_mode_and_original_existed() {
        let src = TempDir::new("snap_meta");
        let file = src.write("a.txt", "registered");
        let svc = service();

        let entry = svc.snapshot(&file).unwrap();
        let meta_path = svc.root().join(&entry.id).join(META_FILE);
        let meta = std::fs::read_to_string(meta_path).unwrap();
        assert!(meta.contains("\"mode\": \"snapshot\""));
        assert!(meta.contains("\"originalExisted\": true"));

        // 移入条目登记 mode=trash
        let file2 = src.write("b.txt", "moved");
        let moved = svc.trash_file(&file2, true).unwrap();
        let meta_path = svc.root().join(&moved.id).join(META_FILE);
        let meta = std::fs::read_to_string(meta_path).unwrap();
        assert!(meta.contains("\"mode\": \"trash\""));
        assert!(meta.contains("\"originalExisted\": true"));
    }

    #[test]
    fn dir_size_does_not_follow_junction_cycle() {
        #[cfg(windows)]
        {
            use std::process::Command;
            let d = TempDir::new("dirsz_junc");
            d.write("inner.txt", "payload");
            // cmd mklink /J 建目录联接普通用户可建（无需管理员权限）；
            // junction 指向祖先形成环，dir_size 不得递归展开
            let out = Command::new("cmd")
                .args(["/c", "mklink", "/J"])
                .arg(d.0.join("loop"))
                .arg(&d.0)
                .output();
            let ok = out.map(|o| o.status.success()).unwrap_or(false);
            if !ok {
                // CI 无 cmd 或目录权限受限时跳过（对齐 impact.rs:202 先例）
                return;
            }
            let size = dir_size(&d.0).unwrap();
            assert!(size >= 7, "真实文件大小计入");
            assert!(
                size <= 10_000_000,
                "junction 环内大小必须有限（不递归展开）"
            );
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::symlink;
            let d = TempDir::new("dirsz_sym");
            d.write("inner.txt", "payload");
            let _ = symlink(&d.0, d.0.join("loop"));
            let size = dir_size(&d.0).unwrap();
            assert!(size >= 7, "真实文件大小计入");
            assert!(size <= 10_000_000, "symlink 环内大小必须有限（不递归展开）");
        }
    }

    #[test]
    fn restore_rejects_traversal_original_path() {
        let src = TempDir::new("trav");
        let file = src.write("a.txt", "original");
        let victim = TempDir::new("victim");
        let victim_file = victim.write("victim.txt", "precious");
        let svc = service();

        // 移入条目：篡改 meta.json 原路径为相对穿越路径 → restore 拒绝
        let entry = svc.trash_file(&file, true).unwrap();
        let entry_dir = svc.root().join(&entry.id);
        let mut meta = read_meta(&entry_dir).unwrap();
        meta.entry.original_path = PathBuf::from("..").join("..").join("victim.txt");
        write_meta(
            &entry_dir,
            &meta.entry,
            meta.backup,
            meta.snapshot.clone(),
            meta.original_existed,
        )
        .unwrap();
        let err = svc.restore(&entry.id).unwrap_err();
        assert!(
            err.to_string().contains("绝对路径"),
            "相对原路径应被绝对性校验拒绝：{err}"
        );
        assert!(victim_file.exists(), "越界恢复必须被拒绝，victim 不被触碰");

        // 篡改为绝对路径但含 .. 穿越组件 → restore 拒绝
        let evil_abs = std::env::temp_dir()
            .join("..")
            .join("..")
            .join("victim.txt");
        meta.entry.original_path = evil_abs.clone();
        write_meta(
            &entry_dir,
            &meta.entry,
            meta.backup,
            meta.snapshot.clone(),
            meta.original_existed,
        )
        .unwrap();
        let err = svc.restore(&entry.id).unwrap_err();
        assert!(
            err.to_string().contains("穿越"),
            "含 .. 的原路径应被穿越校验拒绝：{err}"
        );
        assert!(victim_file.exists(), "越界恢复必须被拒绝，victim 不被触碰");

        // restore_force（快照条目）同样拒绝穿越原路径
        let file2 = src.write("b.txt", "b");
        let snap = svc.snapshot(&file2).unwrap();
        let snap_dir = svc.root().join(&snap.id);
        let mut m2 = read_meta(&snap_dir).unwrap();
        m2.entry.original_path = evil_abs;
        write_meta(
            &snap_dir,
            &m2.entry,
            m2.backup,
            m2.snapshot,
            m2.original_existed,
        )
        .unwrap();
        let err = svc.restore_force(&snap.id).unwrap_err();
        assert!(
            err.to_string().contains("穿越"),
            "restore_force 同样拒绝穿越原路径：{err}"
        );
        assert!(victim_file.exists(), "越界恢复必须被拒绝，victim 不被触碰");
    }

    #[test]
    fn restore_rejects_original_path_inside_trash_root() {
        let src = TempDir::new("inroot");
        let file = src.write("a.txt", "original");
        let svc = service();

        // restore 入口：原路径被篡改为 trash 根内 → 拒绝
        let entry = svc.trash_file(&file, true).unwrap();
        let entry_dir = svc.root().join(&entry.id);
        let mut meta = read_meta(&entry_dir).unwrap();
        meta.entry.original_path = svc.root().join("victim.txt");
        write_meta(
            &entry_dir,
            &meta.entry,
            meta.backup,
            meta.snapshot,
            meta.original_existed,
        )
        .unwrap();
        let err = svc.restore(&entry.id).unwrap_err();
        assert!(
            err.to_string().contains("回收站根"),
            "trash 根内原路径应被拒绝：{err}"
        );

        // restore_force 入口（快照条目）同样拒绝
        let file2 = src.write("b.txt", "b");
        let snap = svc.snapshot(&file2).unwrap();
        let snap_dir = svc.root().join(&snap.id);
        let mut m2 = read_meta(&snap_dir).unwrap();
        m2.entry.original_path = svc.root().join("victim.txt");
        write_meta(
            &snap_dir,
            &m2.entry,
            m2.backup,
            m2.snapshot,
            m2.original_existed,
        )
        .unwrap();
        let err = svc.restore_force(&snap.id).unwrap_err();
        assert!(
            err.to_string().contains("回收站根"),
            "restore_force 同样拒绝 trash 根内原路径：{err}"
        );
    }

    #[test]
    fn restore_force_nil_content_requires_absent_payload() {
        let src = TempDir::new("nil_payload");
        let file = src.0.join("fresh.txt");
        let svc = service();

        // 原不存在 → nil-content 条目（original_existed=false，无 payload）
        let entry = svc.snapshot(&file).unwrap();
        let entry_dir = svc.root().join(&entry.id);
        assert!(!entry_dir.join(PAYLOAD_DIR).exists());

        // 异常数据：nil-content 条目意外出现 payload 目录 → 恢复必须拒绝删除
        fs::create_dir_all(entry_dir.join(PAYLOAD_DIR).join("x")).unwrap();
        std::fs::write(&file, "created later").unwrap();

        let err = svc.restore_force(&entry.id).unwrap_err();
        assert!(
            err.to_string().contains("payload") || err.to_string().contains("意外存在"),
            "payload 意外存在必须拒绝删除：{err}"
        );
        assert!(file.exists(), "拒绝时不得删除原路径");
        assert_eq!(svc.list().len(), 1, "拒绝后条目保留");
    }

    #[test]
    fn path_is_within_case_and_separator_normalized() {
        #[cfg(windows)]
        {
            // ML6 口径：统一分隔符 + Windows 小写 + 去尾部分隔符
            // （对齐 agent-tools mod.rs normalize_for_compare）
            let root = Path::new(r"C:\trash");
            assert!(path_is_within(root, Path::new(r"C:\TRASH\a")));
            assert!(path_is_within(root, Path::new(r"c:\trash\a")));
            assert!(path_is_within(root, Path::new(r"C:/trash/a")));
            assert!(path_is_within(root, Path::new(r"C:\trash")));
            assert!(path_is_within(
                Path::new(r"C:\trash\"),
                Path::new(r"C:\TRASH\a")
            ));
            assert!(!path_is_within(root, Path::new(r"C:\trashx")));
            assert!(!path_is_within(root, Path::new(r"C:\other\a")));
        }
        #[cfg(not(windows))]
        {
            // 非 Windows：大小写敏感，仅验证包含关系与去尾分隔符
            let root = Path::new("/tmp/trash");
            assert!(path_is_within(root, Path::new("/tmp/trash/a")));
            assert!(path_is_within(root, Path::new("/tmp/trash")));
            assert!(path_is_within(
                Path::new("/tmp/trash/"),
                Path::new("/tmp/trash/a")
            ));
            assert!(!path_is_within(root, Path::new("/tmp/trashx")));
        }
    }

    #[test]
    fn write_meta_leaves_no_tmp_residue() {
        let src = TempDir::new("meta_tmp");
        let file = src.write("a.txt", "x");
        let svc = service();

        let entry = svc.trash_file(&file, true).unwrap();
        let entry_dir = svc.root().join(&entry.id);
        assert!(entry_dir.join(META_FILE).exists(), "登记文件已写入");
        assert!(
            !entry_dir.join("meta.json.agent-tmp").exists(),
            "原子写后不得残留临时文件"
        );

        // 覆盖登记路径（restore_force 前的快照写回）同样不留残留
        let file2 = src.write("b.txt", "y");
        let snap = svc.snapshot(&file2).unwrap();
        let snap_dir = svc.root().join(&snap.id);
        assert!(
            !snap_dir.join("meta.json.agent-tmp").exists(),
            "快照登记原子写后不得残留临时文件"
        );
    }

    #[test]
    fn force_remove_clears_readonly_and_succeeds() {
        let dir = TempDir::new("readonly_test");
        let file_path = dir.write("readonly_file.txt", "read only content");

        // 设置只读权限
        let mut perms = fs::metadata(&file_path).unwrap().permissions();
        perms.set_readonly(true);
        fs::set_permissions(&file_path, perms).unwrap();
        assert!(fs::metadata(&file_path).unwrap().permissions().readonly());

        // force_remove_file 必须成功清除只读属性并删除文件
        force_remove_file(&file_path).unwrap();
        assert!(!file_path.exists());

        // 测试目录内嵌套只读文件与只读子目录
        let sub_file = dir.write("sub/nested/file.txt", "nested content");
        let mut perms = fs::metadata(&sub_file).unwrap().permissions();
        perms.set_readonly(true);
        fs::set_permissions(&sub_file, perms).unwrap();

        let sub_dir = dir.0.join("sub");
        force_remove_dir_all(&sub_dir).unwrap();
        assert!(!sub_dir.exists());
    }

    #[test]
    fn atomic_move_same_dir_and_fallback() {
        let dir = TempDir::new("atomic_move_test");
        let src = dir.write("src.txt", "payload data");
        let dst = dir.0.join("dst.txt");

        atomic_move(&src, &dst, false).unwrap();
        assert!(!src.exists());
        assert!(dst.exists());
        assert_eq!(fs::read_to_string(&dst).unwrap(), "payload data");
    }
}
