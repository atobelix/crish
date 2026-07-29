pub mod path_utils {
    use anyhow::{bail, Result};
    use std::path::{Component, Path, PathBuf};

    /// Safely canonicalize a path with depth limiting and traversal protection.
    /// Prevents path traversal attacks (../ sequences) and enforces max component depth.
    pub fn safe_canonicalize(path: impl AsRef<Path>, max_depth: usize) -> Result<PathBuf> {
        let path = path.as_ref();

        if path.as_os_str().is_empty() {
            bail!("path is empty");
        }

        // Reject null bytes
        let path_str = path.to_string_lossy();
        if path_str.contains('\0') {
            bail!("path contains null byte");
        }

        // Count depth and check for traversal
        let mut depth: usize = 0;
        for component in path.components() {
            match component {
                Component::ParentDir => {
                    bail!("path traversal detected: '..' component not allowed");
                }
                Component::Normal(_) => {
                    depth += 1;
                    if depth > max_depth {
                        bail!(
                            "path depth {} exceeds maximum allowed depth {}",
                            depth,
                            max_depth
                        );
                    }
                }
                _ => {}
            }
        }

        // Attempt canonicalization (resolves symlinks and . components)
        match path.canonicalize() {
            Ok(canonical) => Ok(canonical),
            Err(_) => {
                // If canonicalize fails (path doesn't exist yet), normalize manually
                let mut normalized = PathBuf::new();
                for component in path.components() {
                    match component {
                        Component::CurDir => {} // skip "."
                        Component::ParentDir => {
                            bail!("path traversal detected during normalization");
                        }
                        other => normalized.push(other),
                    }
                }
                Ok(normalized)
            }
        }
    }

    /// Compute SHA-256 hash of a file's contents.
    pub fn compute_file_hash(path: impl AsRef<Path>) -> Result<String> {
        use sha2::{Digest, Sha256};
        use std::fs;

        let content = fs::read(path.as_ref())
            .map_err(|e| anyhow::anyhow!("failed to read file for hashing: {e}"))?;
        let mut hasher = Sha256::new();
        hasher.update(&content);
        let result = hasher.finalize();
        Ok(hex::encode(result))
    }

    /// Ensure the parent directory of a path exists, creating it if necessary.
    pub fn ensure_parent_dir(path: impl AsRef<Path>) -> Result<()> {
        use std::fs;

        let path = path.as_ref();
        if let Some(parent) = path.parent() {
            if !parent.as_os_str().is_empty() && !parent.exists() {
                fs::create_dir_all(parent)
                    .map_err(|e| anyhow::anyhow!("failed to create parent directory: {e}"))?;
            }
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::path_utils::*;
    use std::io::Write;

    #[test]
    fn safe_canonicalize_normal_path() {
        let result = safe_canonicalize("src/main.rs", 10);
        assert!(result.is_ok());
    }

    #[test]
    fn safe_canonicalize_rejects_traversal() {
        let result = safe_canonicalize("../../../etc/passwd", 10);
        assert!(result.is_err());
        assert!(result.unwrap_err().to_string().contains("traversal"));
    }

    #[test]
    fn safe_canonicalize_rejects_empty() {
        let result = safe_canonicalize("", 10);
        assert!(result.is_err());
    }

    #[test]
    fn safe_canonicalize_enforces_depth() {
        let deep_path = "a/b/c/d/e/f/g/h/i/j/k";
        let result = safe_canonicalize(deep_path, 5);
        assert!(result.is_err());
        assert!(result.unwrap_err().to_string().contains("depth"));
    }

    #[test]
    fn safe_canonicalize_allows_within_depth() {
        let result = safe_canonicalize("a/b/c", 5);
        assert!(result.is_ok());
    }

    #[test]
    fn compute_file_hash_produces_hex() {
        let dir = std::env::temp_dir().join("conex_fs_test_hash");
        std::fs::create_dir_all(&dir).unwrap();
        let file_path = dir.join("test.txt");
        let mut f = std::fs::File::create(&file_path).unwrap();
        f.write_all(b"hello world").unwrap();
        drop(f);

        let hash = compute_file_hash(&file_path).unwrap();
        assert_eq!(hash.len(), 64); // SHA-256 = 32 bytes = 64 hex chars
        // Known SHA-256 of "hello world"
        assert_eq!(
            hash,
            "b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9"
        );

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn compute_file_hash_nonexistent_file() {
        let result = compute_file_hash("/nonexistent/file.txt");
        assert!(result.is_err());
    }

    #[test]
    fn ensure_parent_dir_creates_directory() {
        let dir = std::env::temp_dir().join("conex_fs_test_parent");
        let file_path = dir.join("sub/dir/file.txt");

        // Clean up first
        std::fs::remove_dir_all(&dir).ok();

        let result = ensure_parent_dir(&file_path);
        assert!(result.is_ok());
        assert!(file_path.parent().unwrap().exists());

        std::fs::remove_dir_all(&dir).ok();
    }
}
