//! Windows 3 阶段原子写入（`atomic_write` / `AtomicWriteTx`）
//!
//! # 核心状态机与不变量
//! 必须遵循以下 3 阶段原子落盘流，消除 Windows 平台 `rename` 覆盖失败与文件损坏：
//! 1. **Phase 1 (写入临时文件与刷盘)**：创建 `.conex-tmp-*.tmp` 临时文件，写入数据并执行 `sync_all()` 强刷盘；
//! 2. **Phase 2 (备份原文件)**：若目标文件已存在，安全重命名为 `.conex-bak-*.bak` 备份文件；
//! 3. **Phase 3 (重命名提交与异常回滚)**：将临时文件重命名为目标路径；
//!    - 若提交成功：尽力清除 `.bak` 备份文件；
//!    - 若提交失败：执行原子回滚，将 `.bak` 恢复至原路径，并清理 `.tmp` 临时文件。
//!
//! G2 禁令豁免（clippy.toml disallowed-methods）：本模块 `remove_file` 仅用于清理内部瞬态 `.tmp`/`.bak` 文件，
//! 属于原子落盘状态机自管清理，不涉及业务数据删除。

use std::fs::{self, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

static TMP_COUNTER: AtomicU64 = AtomicU64::new(1);

/// 原子写入事务状态机状态
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AtomicWriteState {
    /// 初始未开始
    Initial,
    /// 临时文件已写入并完成 sync_all
    TempWritten,
    /// 原文件已备份为 .bak（若原文件存在）
    BackedUp,
    /// 临时文件已成功重命名至目标路径（已提交）
    Committed,
    /// 发生异常，已执行原子回滚
    RolledBack,
}

/// 3 阶段原子写入事务上下文
#[derive(Debug)]
pub struct AtomicWriteTx {
    target: PathBuf,
    tmp_path: PathBuf,
    bak_path: PathBuf,
    has_backup: bool,
    state: AtomicWriteState,
}

impl AtomicWriteTx {
    /// 初始化原子写事务
    pub fn new(target: impl AsRef<Path>) -> io::Result<Self> {
        let target = target.as_ref().to_path_buf();
        let parent = target.parent().unwrap_or_else(|| Path::new("."));
        if !parent.as_os_str().is_empty() && !parent.exists() {
            fs::create_dir_all(parent)?;
        }

        let file_stem = target
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("file");
        let pid = std::process::id();
        let seq = TMP_COUNTER.fetch_add(1, Ordering::Relaxed);
        let nanos = match SystemTime::now().duration_since(UNIX_EPOCH) {
            Ok(d) => d.as_nanos(),
            Err(_) => 0,
        };

        let tmp_name = format!(".conex-tmp-{file_stem}-{pid}-{nanos}-{seq}.tmp");
        let bak_name = format!(".conex-bak-{file_stem}-{pid}-{nanos}-{seq}.bak");

        let tmp_path = parent.join(tmp_name);
        let bak_path = parent.join(bak_name);

        Ok(Self {
            target,
            tmp_path,
            bak_path,
            has_backup: false,
            state: AtomicWriteState::Initial,
        })
    }

    /// 获取目标路径
    pub fn target(&self) -> &Path {
        &self.target
    }

    /// 获取临时文件路径
    pub fn tmp_path(&self) -> &Path {
        &self.tmp_path
    }

    /// 获取备份文件路径
    pub fn bak_path(&self) -> &Path {
        &self.bak_path
    }

    /// 当前事务状态
    pub fn state(&self) -> AtomicWriteState {
        self.state
    }

    /// Phase 1: 写入临时文件并强刷盘 (sync_all)
    pub fn write_temp(&mut self, data: &[u8]) -> io::Result<()> {
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&self.tmp_path)?;

        if let Err(e) = file.write_all(data) {
            let _ = fs::remove_file(&self.tmp_path);
            return Err(e);
        }

        if let Err(e) = file.sync_all() {
            let _ = fs::remove_file(&self.tmp_path);
            return Err(e);
        }

        drop(file);
        self.state = AtomicWriteState::TempWritten;
        Ok(())
    }

    /// Phase 2: 若目标文件存在，安全重命名为备份文件 (.bak)
    pub fn backup_existing(&mut self) -> io::Result<()> {
        if self.target.exists() {
            // 若原文件具有只读属性，在 Windows 上临时剥离以允许重命名与写入
            #[cfg(windows)]
            if let Ok(meta) = fs::metadata(&self.target) {
                let mut perms = meta.permissions();
                if perms.readonly() {
                    perms.set_readonly(false);
                    let _ = fs::set_permissions(&self.target, perms);
                }
            }

            if let Err(e) = fs::rename(&self.target, &self.bak_path) {
                let _ = fs::remove_file(&self.tmp_path);
                return Err(e);
            }
            self.has_backup = true;
        }
        self.state = AtomicWriteState::BackedUp;
        Ok(())
    }

    /// Phase 3: 重命名临时文件至目标路径，并在出错时触发原子回滚
    pub fn commit(mut self) -> io::Result<()> {
        if let Err(e) = fs::rename(&self.tmp_path, &self.target) {
            // 重命名提交失败：执行原子回滚
            self.rollback();
            return Err(e);
        }

        // 提交成功：尽力清理备份文件
        if self.has_backup {
            let _ = fs::remove_file(&self.bak_path);
        }
        self.state = AtomicWriteState::Committed;
        Ok(())
    }

    /// 异常原子回滚状态机
    pub fn rollback(&mut self) {
        // 清理未提交的临时文件
        if self.tmp_path.exists() {
            let _ = fs::remove_file(&self.tmp_path);
        }
        // 若存在原文件备份，将备份恢复为原目标文件
        if self.has_backup && self.bak_path.exists() {
            let _ = fs::rename(&self.bak_path, &self.target);
        }
        self.state = AtomicWriteState::RolledBack;
    }
}

impl Drop for AtomicWriteTx {
    fn drop(&mut self) {
        // 若 Drop 时仍未处于 Committed 状态，自动确保临时资源回收与原状回滚
        if self.state != AtomicWriteState::Committed && self.state != AtomicWriteState::Initial {
            self.rollback();
        }
    }
}

/// 执行跨平台 3 阶段原子文件写入
///
/// 遵循「写入临时文件 `.tmp` $\to$ `sync_all` $\to$ 备份重命名 `.bak` $\to$ 重命名提交 $\to$ 异常原子回滚」
pub fn atomic_write_file(target: impl AsRef<Path>, data: &[u8]) -> io::Result<()> {
    let mut tx = AtomicWriteTx::new(target)?;
    tx.write_temp(data)?;
    tx.backup_existing()?;
    tx.commit()?;
    Ok(())
}

/// `atomic_write_file` 的简写别名
#[inline]
pub fn atomic_write(target: impl AsRef<Path>, data: &[u8]) -> io::Result<()> {
    atomic_write_file(target, data)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_test_dir(name: &str) -> PathBuf {
        let p = std::env::temp_dir().join(format!(
            "conex-atomic-write-test-{}-{}-{}",
            name,
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        ));
        let _ = fs::create_dir_all(&p);
        p
    }

    #[test]
    fn atomic_write_new_file_succeeds() {
        let dir = temp_test_dir("new_file");
        let target = dir.join("test.txt");
        let data = b"hello atomic write";

        atomic_write(&target, data).expect("atomic write new file should succeed");

        assert!(target.exists());
        let read = fs::read(&target).expect("read written file");
        assert_eq!(read, data);

        // 验证没有残留的 .tmp 或 .bak 文件
        for entry in fs::read_dir(&dir).unwrap().flatten() {
            let name = entry.file_name().to_string_lossy().to_string();
            assert!(
                !name.starts_with(".conex-tmp-"),
                "found leftover tmp: {name}"
            );
            assert!(
                !name.starts_with(".conex-bak-"),
                "found leftover bak: {name}"
            );
        }

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn atomic_write_overwrites_existing_file() {
        let dir = temp_test_dir("overwrite");
        let target = dir.join("test.txt");

        fs::write(&target, b"original content").unwrap();
        assert_eq!(fs::read(&target).unwrap(), b"original content");

        let new_data = b"new updated content via atomic write";
        atomic_write_file(&target, new_data).expect("atomic overwrite should succeed");

        assert_eq!(fs::read(&target).unwrap(), new_data);

        // 验证没有残留的 .tmp 或 .bak 文件
        for entry in fs::read_dir(&dir).unwrap().flatten() {
            let name = entry.file_name().to_string_lossy().to_string();
            assert!(
                !name.starts_with(".conex-tmp-"),
                "found leftover tmp: {name}"
            );
            assert!(
                !name.starts_with(".conex-bak-"),
                "found leftover bak: {name}"
            );
        }

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn atomic_write_auto_creates_parent_directories() {
        let dir = temp_test_dir("parents");
        let target = dir.join("sub").join("nested").join("deep.txt");
        let data = b"deep content";

        atomic_write_file(&target, data).expect("should create parent dirs");

        assert!(target.exists());
        assert_eq!(fs::read(&target).unwrap(), data);

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn atomic_write_tx_rollback_on_drop_preserves_original() {
        let dir = temp_test_dir("rollback_drop");
        let target = dir.join("preserve.txt");
        let orig = b"original data that must not be lost";
        fs::write(&target, orig).unwrap();

        {
            let mut tx = AtomicWriteTx::new(&target).unwrap();
            tx.write_temp(b"uncommitted temp data").unwrap();
            tx.backup_existing().unwrap();
            assert_eq!(tx.state(), AtomicWriteState::BackedUp);
            // 模拟在 commit 前发生 Panic 或 Drop
        }

        // Drop 触发 rollback 后，原始目标文件必须完好恢复
        assert!(target.exists());
        assert_eq!(fs::read(&target).unwrap(), orig);

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn atomic_write_concurrent_different_files() {
        let dir = temp_test_dir("concurrent");
        let handles: Vec<_> = (0..16)
            .map(|i| {
                let dir_clone = dir.clone();
                std::thread::spawn(move || {
                    let path = dir_clone.join(format!("thread_{i}.txt"));
                    let content = format!("thread {i} payload data").into_bytes();
                    atomic_write_file(&path, &content).unwrap();
                    let read = fs::read(&path).unwrap();
                    assert_eq!(read, content);
                })
            })
            .collect();

        for h in handles {
            h.join().unwrap();
        }

        let _ = fs::remove_dir_all(&dir);
    }
}
