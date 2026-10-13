use std::{
    env,
    path::{Path, PathBuf},
};

pub(crate) fn app_dir() -> Result<PathBuf, String> {
    #[cfg(debug_assertions)]
    {
        let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
        if let Some(parent) = manifest_dir.parent() {
            if parent.join("package.json").exists() {
                let repo_root = parent.parent().unwrap_or(parent);
                if let Ok(exe_path) = env::current_exe() {
                    if exe_path.starts_with(repo_root) {
                        return Ok(parent.to_path_buf());
                    }
                } else {
                    return Ok(parent.to_path_buf());
                }
            }
        }

        if let Ok(cwd) = env::current_dir() {
            if let Some(dir) = find_agent_workbench_dir(&cwd) {
                return Ok(dir);
            }
        }
    }

    if let Ok(exe_path) = env::current_exe() {
        if let Some(exe_dir) = exe_path.parent() {
            return Ok(exe_dir.to_path_buf());
        }
    }

    env::current_dir().map_err(|e| e.to_string())
}

pub(crate) fn workspace_root(app_dir: &Path) -> PathBuf {
    #[cfg(debug_assertions)]
    {
        if let Some(ws) = app_dir.parent().and_then(Path::parent) {
            if ws.join("package.json").exists() {
                return ws.to_path_buf();
            }
        }
    }
    app_dir.to_path_buf()
}

fn find_agent_workbench_dir(start: &Path) -> Option<PathBuf> {
    let mut current = Some(start);
    while let Some(dir) = current {
        let candidate = dir.join("apps").join("agent-workbench");
        if candidate.join("package.json").exists() {
            return Some(candidate);
        }
        if dir.ends_with(Path::new("apps").join("agent-workbench"))
            && dir.join("package.json").exists()
        {
            return Some(dir.to_path_buf());
        }
        current = dir.parent();
    }
    None
}
