//! 工作区 recent 列表持久化（tmp + rename 原子替换）。

use super::*;

/// 工作区配置目录（对齐 config/persistence.rs 的 config_dir 语义）：
/// `CRISH_WORKBENCH_CONFIG_DIR` → `%APPDATA%\Crish\AgentWorkbench` → temp 兜底。
pub(super) fn workspace_config_dir() -> PathBuf {
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
pub(super) fn load_recent_list(config_dir: &Path) -> Vec<PathBuf> {
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

/// 固定临时路径受 WorkspaceRegistry 内部互斥锁保护；只能在持锁事务中调用。
/// 先把 recent 内容写入不会被启动加载的临时文件，供跨资源授权事务提交。
pub(super) fn prepare_recent_list(
    config_dir: &Path,
    recent: &[PathBuf],
) -> Result<PathBuf, FileCommandError> {
    std::fs::create_dir_all(config_dir).map_err(|e| {
        FileCommandError::new(
            ERR_WORKSPACE_NOT_GRANTED,
            format!("cannot create workspace config directory: {e}"),
        )
    })?;
    let target = config_dir.join(RECENT_FILE_NAME);
    let tmp = target.with_extension("json.tmp");
    let list: Vec<String> = recent
        .iter()
        .map(|p| p.to_string_lossy().into_owned())
        .collect();
    let text = serde_json::to_string_pretty(&list).map_err(|e| {
        FileCommandError::new(
            ERR_WORKSPACE_NOT_GRANTED,
            format!("cannot serialize workspace history: {e}"),
        )
    })?;
    std::fs::write(&tmp, text).map_err(|e| {
        FileCommandError::new(
            ERR_WORKSPACE_NOT_GRANTED,
            format!("cannot write workspace history: {e}"),
        )
    })?;
    Ok(tmp)
}

/// 把已准备好的 recent 临时文件原子替换到正式路径。
pub(super) fn commit_recent_list(config_dir: &Path, tmp: &Path) -> Result<(), FileCommandError> {
    let target = config_dir.join(RECENT_FILE_NAME);
    std::fs::rename(tmp, &target).map_err(|e| {
        FileCommandError::new(
            ERR_WORKSPACE_NOT_GRANTED,
            format!("cannot commit workspace history: {e}"),
        )
    })
}

#[allow(clippy::disallowed_methods)] // 原子落盘失败后的 staging 临时文件清理（非会话历史）
pub(super) fn remove_recent_list_stage(tmp: &Path) -> Result<(), FileCommandError> {
    match std::fs::remove_file(tmp) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(FileCommandError::new(
            ERR_INTERNAL,
            format!("cannot remove staged workspace history: {error}"),
        )),
    }
}

/// recent 列表落盘：tmp + rename（原子替换，损坏不会留下半截文件）。
pub(super) fn persist_recent_list(
    config_dir: &Path,
    recent: &[PathBuf],
) -> Result<(), FileCommandError> {
    let tmp = prepare_recent_list(config_dir, recent)?;
    if let Err(commit_error) = commit_recent_list(config_dir, &tmp) {
        if let Err(cleanup_error) = remove_recent_list_stage(&tmp) {
            return Err(FileCommandError::new(
                ERR_INTERNAL,
                format!(
                    "workspace history commit failed: {}; temporary file cleanup failed: {}",
                    commit_error.message, cleanup_error.message
                ),
            ));
        }
        return Err(commit_error);
    }
    Ok(())
}
