//! `mirror_os_watch` 路径规范化 / notify 事件分类 / interest 过滤。
//!
//! 由父模 [`crate::mirror_os_watch`] 经 `#[path]` 接入（**SD-36** 再抽）。
//! **诚实**：**≠ EL-03**；**≠ 占 SD-19**；**≠** inotify 产品满关；事件仍不 apply。

use super::MirrorOsEventKind;
use notify::event::{ModifyKind, RemoveKind, RenameMode};
use notify::EventKind;
use std::collections::HashSet;
use std::path::{Path, PathBuf};

/// 判定路径是否属于系统内部原子落盘的临时/备份文件
#[inline]
pub(super) fn is_internal_atomic_transient_path(path: &Path) -> bool {
    let Some(file_name) = path.file_name().and_then(|n| n.to_str()) else {
        return false;
    };
    let lower = file_name.to_lowercase();
    lower.starts_with(".conex-tmp-")
        || lower.starts_with(".conex-bak-")
        || lower.contains(".tmp.")
        || lower.contains(".bak.")
        || lower.ends_with(".tmp")
        || lower.ends_with(".bak")
        || lower.ends_with(".crish-tmp")
        || lower.contains(".agent-tmp-")
}

/// 将 notify 事件归一为 (路径, 种类)；Access/Any/Other 及内部瞬态文件丢弃。
pub(super) fn classify_notify_event(event: &notify::Event) -> Vec<(PathBuf, MirrorOsEventKind)> {
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
            // from + to：分别标 Removed / Created（过滤瞬态内部文件）
            if event.paths.len() >= 2 {
                let mut out = Vec::new();
                if !is_internal_atomic_transient_path(&event.paths[0]) {
                    out.push((event.paths[0].clone(), MirrorOsEventKind::Removed));
                }
                if !is_internal_atomic_transient_path(&event.paths[1]) {
                    out.push((event.paths[1].clone(), MirrorOsEventKind::Created));
                }
                return out;
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
        .filter(|p| !is_internal_atomic_transient_path(p))
        .map(|p| (p.clone(), kind))
        .collect()
}

pub(super) fn interest_allows(interest: &HashSet<String>, path: &Path) -> bool {
    if is_internal_atomic_transient_path(path) {
        return false;
    }
    if interest.is_empty() {
        return true;
    }
    interest.contains(&path_compare_key(path))
}

pub(super) fn paths_equal_for_mirror(a: &Path, b: &Path) -> bool {
    path_compare_key(a) == path_compare_key(b)
}

/// 规范化绝对路径：canonicalize 失败则原样；Windows 剥 `\\?\`。
pub(super) fn normalize_abs_path(p: &Path) -> PathBuf {
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
pub(super) fn path_compare_key(p: &Path) -> String {
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
