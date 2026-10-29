//! 工作区注册表测试（激活 / 原生选择 / 复授权 / 守卫）。
// G2 禁令豁免：测试临时目录清理（非产品删除路径，可恢复语义不适用）。
#![allow(clippy::disallowed_methods)]

use super::*;
use std::fs;
use std::time::{SystemTime, UNIX_EPOCH};

mod activation;
mod dialog_selection;
mod guard;
mod recent_batch;

/// 临时目录（测试后自动清理）
struct TestDir {
    path: PathBuf,
}

impl TestDir {
    fn new() -> Self {
        let base = std::env::temp_dir();
        for attempt in 0..100 {
            let nanos = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .expect("system time before UNIX_EPOCH")
                .as_nanos();
            let path = base.join(format!(
                "conex-workspace-registry-{}-{nanos}-{attempt}",
                std::process::id()
            ));
            if fs::create_dir(&path).is_ok() {
                return Self { path };
            }
        }
        panic!("failed to create temporary test directory");
    }

    fn path(&self) -> &Path {
        &self.path
    }
}

impl Drop for TestDir {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.path);
    }
}

/// 构造注册表：默认根指向临时目录（绕过 host_paths 默认根），
/// 避免测试耦合真实仓库路径。
fn make_root_registry(root: &Path, config_dir: &Path) -> WorkspaceRegistry {
    let reg = WorkspaceRegistry::init_with_config_dir(config_dir).expect("init registry");
    let _ = reg;
    // 通过 register(RecentList) 需要 recent 预置；这里直接构造含默认根的注册表
    let inner = RegistryInner {
        roots: vec![WorkspaceRoot {
            path: root.to_path_buf(),
            source: RegisterSource::DefaultAppRoot,
        }],
        active: Some(0),
        recent: Vec::new(),
        config_dir: config_dir.to_path_buf(),
    };
    WorkspaceRegistry {
        inner: Mutex::new(inner),
    }
}
