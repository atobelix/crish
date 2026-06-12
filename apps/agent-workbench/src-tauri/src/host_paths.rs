use std::{
    env,
    path::{Path, PathBuf},
};

pub(crate) fn app_dir() -> Result<PathBuf, String> {
    let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    if let Some(parent) = manifest_dir.parent() {
        if parent.join("package.json").exists() {
            return Ok(parent.to_path_buf());
        }
    }

    env::current_dir()
        .map_err(|e| e.to_string())
        .and_then(|cwd| {
            find_agent_workbench_dir(&cwd).ok_or_else(|| {
                format!(
                    "could not locate apps/agent-workbench from current directory: {}",
                    cwd.display()
                )
            })
        })
}

pub(crate) fn workspace_root(app_dir: &Path) -> PathBuf {
    app_dir
        .parent()
        .and_then(Path::parent)
        .map(Path::to_path_buf)
        .unwrap_or_else(|| app_dir.to_path_buf())
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
