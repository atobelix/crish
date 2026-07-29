use std::path::PathBuf;
use std::sync::atomic::{AtomicU32, Ordering};

static COUNTER: AtomicU32 = AtomicU32::new(0);

/// Initialize test environment (idempotent).
/// Sets up tracing subscriber for test output if not already initialized.
pub fn setup_test_env() {
    let _ = tracing_subscriber::fmt()
        .with_max_level(tracing::Level::WARN)
        .with_test_writer()
        .try_init();
}

/// RAII temporary workspace that auto-cleans on drop.
pub struct TempWorkspace {
    path: PathBuf,
}

impl TempWorkspace {
    /// Create a new temporary workspace directory.
    pub fn new(prefix: &str) -> Self {
        let id = COUNTER.fetch_add(1, Ordering::Relaxed);
        let path = std::env::temp_dir().join(format!("conex_test_{prefix}_{id}_{}", std::process::id()));
        std::fs::create_dir_all(&path).expect("failed to create temp workspace");
        Self { path }
    }

    /// Get the workspace root path.
    pub fn path(&self) -> &PathBuf {
        &self.path
    }

    /// Create a file within the workspace with given content.
    pub fn write_file(&self, relative_path: &str, content: &str) -> PathBuf {
        let full_path = self.path.join(relative_path);
        if let Some(parent) = full_path.parent() {
            std::fs::create_dir_all(parent).expect("failed to create parent dir");
        }
        std::fs::write(&full_path, content).expect("failed to write file");
        full_path
    }

    /// Read a file within the workspace.
    pub fn read_file(&self, relative_path: &str) -> String {
        let full_path = self.path.join(relative_path);
        std::fs::read_to_string(&full_path).expect("failed to read file")
    }
}

impl Drop for TempWorkspace {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.path);
    }
}

/// Assert that a value survives JSON serialization/deserialization roundtrip.
pub fn assert_json_roundtrip<T>(value: &T)
where
    T: serde::Serialize + serde::de::DeserializeOwned + PartialEq + std::fmt::Debug,
{
    let json = serde_json::to_string(value).expect("serialization failed");
    let back: T = serde_json::from_str(&json).expect("deserialization failed");
    assert_eq!(value, &back, "roundtrip mismatch");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn temp_workspace_creates_and_cleans() {
        let path;
        {
            let ws = TempWorkspace::new("lifecycle");
            path = ws.path().clone();
            assert!(path.exists());
        }
        // After drop, directory should be removed
        assert!(!path.exists());
    }

    #[test]
    fn temp_workspace_write_and_read() {
        let ws = TempWorkspace::new("rw");
        ws.write_file("sub/dir/file.txt", "hello world");
        let content = ws.read_file("sub/dir/file.txt");
        assert_eq!(content, "hello world");
    }

    #[test]
    fn json_roundtrip_helper() {
        #[derive(serde::Serialize, serde::Deserialize, PartialEq, Debug)]
        struct Sample {
            name: String,
            value: i32,
        }
        let sample = Sample {
            name: "test".into(),
            value: 42,
        };
        assert_json_roundtrip(&sample);
    }
}
