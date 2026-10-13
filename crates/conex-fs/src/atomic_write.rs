//! Windows 3 阶段原子写入（`atomic_write` / `AtomicWriteTx`）
//!
//! # 核心状态机与不变量 (KFS-01 ~ KFS-04)
//! 必须遵循以下原子落盘流，消除 Windows 平台 `rename` 覆盖失败与文件损坏：
//! 1. **Phase 1 (写入临时文件与刷盘)**：创建 `.conex-tmp-*.tmp` 临时文件，写入数据并按 `SyncPolicy` 刷盘 (KFS-03)；
//! 2. **Phase 2 (备份意图与属性预检)**：若目标文件存在，标记备份意图并预检属性（不提前移走原文件，避免物理空隙 KFS-01）；
//! 3. **Phase 3 (单步原子替换与异常回滚)**：
//!    - Windows: 采用 Win32 原生 `ReplaceFileW` 进行单步原子替换，原子生成备份并保持目标路径全程存在，继承原文件安全 ACL、创建时间与流 (KFS-01, KFS-02)；
//!    - POSIX: 采用原子硬链接备份与原生 `rename(2)` 原子替换；
//!    - 跨卷回退: 捕获 `ERROR_NOT_SAME_DEVICE` 与 `EXDEV`，提供事务补偿与跨卷拷贝回退机制 (KFS-04)；
//!    - 属性与持久化闭环: 还原只读属性并执行父目录项同步 (KFS-02, KFS-03)。
//!
//! G2 禁令豁免（clippy.toml disallowed-methods）：本模块 `remove_file` 仅用于清理内部瞬态 `.tmp`/`.bak` 文件，
//! 属于原子落盘状态机自管清理，不涉及业务数据删除。

use std::fs::{self, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

static TMP_COUNTER: AtomicU64 = AtomicU64::new(1);

/// 原子写入刷盘同步策略 (KFS-03)
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum SyncPolicy {
    /// 完整强刷盘：数据脏页 + 元数据日志 + 父目录同步（ACID 关键路径默认）
    #[default]
    Full,
    /// 仅刷数据：对应 sync_data，降低元数据提交阻塞
    DataOnly,
    /// 批处理/非致命写入：由操作系统页缓存择机刷盘
    None,
}

/// 原子写入事务状态机状态
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AtomicWriteState {
    /// 初始未开始
    Initial,
    /// 临时文件已写入并完成 sync
    TempWritten,
    /// 原文件已准备好备份与属性预检（若原文件存在）
    BackedUp,
    /// 临时文件已成功单步原子替换至目标路径（已提交）
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
    was_readonly: bool,
    sync_policy: SyncPolicy,
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
            was_readonly: false,
            sync_policy: SyncPolicy::Full,
            state: AtomicWriteState::Initial,
        })
    }

    /// 设置刷盘同步策略 (KFS-03)
    pub fn with_sync_policy(mut self, policy: SyncPolicy) -> Self {
        self.sync_policy = policy;
        self
    }

    /// 动态修改刷盘同步策略 (KFS-03)
    pub fn set_sync_policy(&mut self, policy: SyncPolicy) {
        self.sync_policy = policy;
    }

    /// 获取当前刷盘同步策略
    pub fn sync_policy(&self) -> SyncPolicy {
        self.sync_policy
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

    /// Phase 1: 写入临时文件并根据策略刷盘 (KFS-03)
    #[allow(clippy::disallowed_methods)]
    pub fn write_temp(&mut self, data: &[u8]) -> io::Result<()> {
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&self.tmp_path)?;

        if let Err(e) = file.write_all(data) {
            let _ = fs::remove_file(&self.tmp_path);
            return Err(e);
        }

        match self.sync_policy {
            SyncPolicy::Full => {
                if let Err(e) = file.sync_all() {
                    let _ = fs::remove_file(&self.tmp_path);
                    return Err(e);
                }
            }
            SyncPolicy::DataOnly => {
                if let Err(e) = file.sync_data() {
                    let _ = fs::remove_file(&self.tmp_path);
                    return Err(e);
                }
            }
            SyncPolicy::None => {}
        }

        drop(file);
        self.state = AtomicWriteState::TempWritten;
        Ok(())
    }

    /// Phase 2: 若目标文件存在，标记备份意图并预检属性（KFS-01, KFS-02）
    ///
    /// 注意：为消除目标文件在备份与提交之间物理消失的空隙（KFS-01），
    /// 此处绝不提前将原文件移走，原文件保持在原路径供并发读者无缝访问；
    /// 备份与目标文件替换统一在 `commit` 中由单步原子事务完成。
    #[allow(clippy::permissions_set_readonly_false)]
    pub fn backup_existing(&mut self) -> io::Result<()> {
        if self.target.exists() {
            // 若原文件具有只读属性，在 Windows 上记录并临时剥离以允许替换，提交后还原 (KFS-02)
            #[cfg(windows)]
            if let Ok(meta) = fs::metadata(&self.target) {
                let mut perms = meta.permissions();
                if perms.readonly() {
                    self.was_readonly = true;
                    perms.set_readonly(false);
                    let _ = fs::set_permissions(&self.target, perms);
                }
            }
            self.has_backup = true;
        }
        self.state = AtomicWriteState::BackedUp;
        Ok(())
    }

    /// Phase 3: 单步原子替换目标文件，并在出错时触发原子回滚 (KFS-01 ~ KFS-04)
    #[allow(clippy::disallowed_methods)]
    pub fn commit(mut self) -> io::Result<()> {
        if let Err(e) = self.replace_target() {
            // 单步替换失败：执行原子回滚
            self.rollback();
            return Err(e);
        }

        // 提交成功：尽力清理备份文件
        if self.has_backup && self.bak_path.exists() {
            let _ = fs::remove_file(&self.bak_path);
        }

        // KFS-02: 还原被修改的只读属性，确保系统/受保护文件属性不被意外篡改
        #[cfg(windows)]
        if self.was_readonly && self.target.exists() {
            if let Ok(meta) = fs::metadata(&self.target) {
                let mut perms = meta.permissions();
                perms.set_readonly(true);
                let _ = fs::set_permissions(&self.target, perms);
            }
        }

        // KFS-03: 目录项持久化闭环，防止意外断电导致父目录重命名元数据回滚
        if self.sync_policy == SyncPolicy::Full {
            sync_parent_dir(&self.target);
        }

        self.state = AtomicWriteState::Committed;
        Ok(())
    }

    /// 单步原子物理替换与跨卷异常补偿机制 (KFS-01, KFS-04)
    fn replace_target(&self) -> io::Result<()> {
        if !self.target.exists() {
            // 目标尚不存在：直接将临时文件重命名至目标路径
            return match fs::rename(&self.tmp_path, &self.target) {
                Ok(()) => Ok(()),
                Err(e) if is_cross_device_error(&e) => {
                    // KFS-04: 跨卷/挂载点移动回退
                    cross_volume_replace(&self.tmp_path, &self.target, None)
                }
                Err(e) => Err(e),
            };
        }

        // 目标已存在：进行单步无缝物理原子替换（KFS-01）
        #[cfg(windows)]
        {
            let backup_arg = if self.has_backup {
                Some(self.bak_path.as_path())
            } else {
                None
            };

            match win32::replace_file(&self.target, &self.tmp_path, backup_arg) {
                Ok(()) => Ok(()),
                Err(e) if is_cross_device_or_unsupported(&e) => {
                    // FAT/网络卷或跨设备回退：尝试标准重命名或跨卷拷贝
                    match fs::rename(&self.tmp_path, &self.target) {
                        Ok(()) => Ok(()),
                        Err(rename_err) => {
                            if is_cross_device_error(&rename_err) {
                                cross_volume_replace(&self.tmp_path, &self.target, backup_arg)
                            } else {
                                Err(rename_err)
                            }
                        }
                    }
                }
                Err(e) => Err(e),
            }
        }

        #[cfg(not(windows))]
        {
            let backup_arg = if self.has_backup {
                Some(self.bak_path.as_path())
            } else {
                None
            };

            if let Some(bak) = backup_arg {
                // POSIX: 使用 hardlink 或 copy 建立安全备份，不移走原文件
                let _ = fs::hard_link(&self.target, bak).or_else(|_| fs::copy(&self.target, bak).map(|_| ()));
            }

            match fs::rename(&self.tmp_path, &self.target) {
                Ok(()) => Ok(()),
                Err(e) if is_cross_device_error(&e) => {
                    // KFS-04: 跨卷回退
                    cross_volume_replace(&self.tmp_path, &self.target, backup_arg)
                }
                Err(e) => Err(e),
            }
        }
    }

    /// 异常原子回滚状态机
    #[allow(clippy::disallowed_methods)]
    pub fn rollback(&mut self) {
        // 清理未提交的临时文件
        if self.tmp_path.exists() {
            let _ = fs::remove_file(&self.tmp_path);
        }
        // 若存在原文件备份且目标丢失，将备份恢复为原目标文件
        if self.bak_path.exists() {
            if !self.target.exists() {
                let _ = fs::rename(&self.bak_path, &self.target);
            } else {
                let _ = fs::remove_file(&self.bak_path);
            }
        }
        // KFS-02: 回滚时同样恢复只读属性
        #[cfg(windows)]
        if self.was_readonly && self.target.exists() {
            if let Ok(meta) = fs::metadata(&self.target) {
                let mut perms = meta.permissions();
                perms.set_readonly(true);
                let _ = fs::set_permissions(&self.target, perms);
            }
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

/// KFS-04: 跨卷事务补偿拷贝与替换
#[allow(clippy::disallowed_methods)]
fn cross_volume_replace(tmp: &Path, target: &Path, backup: Option<&Path>) -> io::Result<()> {
    if let Some(bak) = backup {
        if target.exists() {
            let _ = fs::copy(target, bak);
        }
    }
    fs::copy(tmp, target)?;
    let _ = fs::remove_file(tmp);
    Ok(())
}

fn is_cross_device_error(err: &io::Error) -> bool {
    #[cfg(windows)]
    {
        // 17 = ERROR_NOT_SAME_DEVICE
        err.raw_os_error() == Some(17)
    }
    #[cfg(unix)]
    {
        // 18 = EXDEV
        err.raw_os_error() == Some(18) || err.kind() == io::ErrorKind::CrossesDevices
    }
    #[cfg(not(any(windows, unix)))]
    {
        let _ = err;
        false
    }
}

#[cfg(windows)]
fn is_cross_device_or_unsupported(err: &io::Error) -> bool {
    if is_cross_device_error(err) {
        return true;
    }
    // 1 = ERROR_INVALID_FUNCTION, 50 = ERROR_NOT_SUPPORTED, 120 = ERROR_CALL_NOT_IMPLEMENTED
    matches!(err.raw_os_error(), Some(1 | 50 | 120))
}

/// KFS-03: 父目录项同步
fn sync_parent_dir(path: &Path) {
    if let Some(parent) = path.parent() {
        if !parent.as_os_str().is_empty() {
            #[cfg(unix)]
            {
                if let Ok(dir) = fs::File::open(parent) {
                    let _ = dir.sync_all();
                }
            }
            #[cfg(windows)]
            {
                use std::os::windows::fs::OpenOptionsExt;
                const FILE_FLAG_BACKUP_SEMANTICS: u32 = 0x02000000;
                if let Ok(dir) = OpenOptions::new()
                    .read(true)
                    .custom_flags(FILE_FLAG_BACKUP_SEMANTICS)
                    .open(parent)
                {
                    let _ = dir.sync_all();
                }
            }
        }
    }
}

#[cfg(windows)]
#[allow(unsafe_code)]
mod win32 {
    use std::io;
    use std::os::windows::ffi::OsStrExt;
    use std::path::Path;

    #[link(name = "kernel32")]
    extern "system" {
        fn ReplaceFileW(
            lpReplacedFileName: *const u16,
            lpReplacementFileName: *const u16,
            lpBackupFileName: *const u16,
            dwReplaceFlags: u32,
            lpExclude: *mut std::ffi::c_void,
            lpReserved: *mut std::ffi::c_void,
        ) -> i32;
    }

    const REPLACEFILE_WRITE_THROUGH: u32 = 0x00000001;
    const REPLACEFILE_IGNORE_MERGE_ERRORS: u32 = 0x00000002;

    fn to_wide_null(path: &Path) -> Vec<u16> {
        path.as_os_str()
            .encode_wide()
            .chain(std::iter::once(0))
            .collect()
    }

    pub fn replace_file(
        target: &Path,
        replacement: &Path,
        backup: Option<&Path>,
    ) -> io::Result<()> {
        let target_w = to_wide_null(target);
        let replacement_w = to_wide_null(replacement);
        let backup_w = backup.map(to_wide_null);
        let backup_ptr = backup_w
            .as_ref()
            .map(|v| v.as_ptr())
            .unwrap_or(std::ptr::null());

        // SAFETY: ReplaceFileW is invoked with valid null-terminated UTF-16 wide strings
        // pointing to normalized file system paths.
        let ret = unsafe {
            ReplaceFileW(
                target_w.as_ptr(),
                replacement_w.as_ptr(),
                backup_ptr,
                REPLACEFILE_WRITE_THROUGH | REPLACEFILE_IGNORE_MERGE_ERRORS,
                std::ptr::null_mut(),
                std::ptr::null_mut(),
            )
        };

        if ret != 0 {
            Ok(())
        } else {
            Err(io::Error::last_os_error())
        }
    }
}

/// 执行跨平台单步无缝原子文件写入 (KFS-01 ~ KFS-04)
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

    #[test]
    fn atomic_write_preserves_readonly_attribute_kfs_02() {
        let dir = temp_test_dir("readonly_attr");
        let target = dir.join("readonly_file.txt");
        let orig = b"initial protected content";
        fs::write(&target, orig).unwrap();

        // 设置只读保护
        let mut perms = fs::metadata(&target).unwrap().permissions();
        perms.set_readonly(true);
        fs::set_permissions(&target, perms).unwrap();

        assert!(fs::metadata(&target).unwrap().permissions().readonly());

        // 执行原子写入覆写
        let updated = b"updated protected content via atomic write";
        atomic_write_file(&target, updated).expect("atomic write to readonly should succeed");

        assert_eq!(fs::read(&target).unwrap(), updated);
        // KFS-02 核心断言：只读属性必须被完好保留，不得被永久剥离
        #[cfg(windows)]
        assert!(
            fs::metadata(&target).unwrap().permissions().readonly(),
            "readonly permission must be preserved after atomic write"
        );

        // 清理前解除只读以便顺利清理目录
        let mut p = fs::metadata(&target).unwrap().permissions();
        p.set_readonly(false);
        let _ = fs::set_permissions(&target, p);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn atomic_write_target_exists_throughout_backup_phase_kfs_01() {
        let dir = temp_test_dir("no_gap");
        let target = dir.join("file.txt");
        let orig = b"original data that must not disappear";
        fs::write(&target, orig).unwrap();

        let mut tx = AtomicWriteTx::new(&target).unwrap();
        tx.write_temp(b"new content").unwrap();
        tx.backup_existing().unwrap();

        // KFS-01 核心断言：在 Phase 2 (backup_existing) 完成后，
        // 目标文件必须依然完好存在于原路径，绝对不能提前被移走导致物理空隙！
        assert!(target.exists(), "target must exist after backup_existing");
        assert_eq!(fs::read(&target).unwrap(), orig);

        // 提交后目标文件原子切换为新内容
        tx.commit().unwrap();
        assert!(target.exists(), "target must exist after commit");
        assert_eq!(fs::read(&target).unwrap(), b"new content");

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn atomic_write_sync_policy_variants_kfs_03() {
        let dir = temp_test_dir("sync_policy");

        // DataOnly 策略
        let target1 = dir.join("data_only.txt");
        let mut tx1 = AtomicWriteTx::new(&target1).unwrap().with_sync_policy(SyncPolicy::DataOnly);
        assert_eq!(tx1.sync_policy(), SyncPolicy::DataOnly);
        tx1.write_temp(b"data only sync").unwrap();
        tx1.backup_existing().unwrap();
        tx1.commit().unwrap();
        assert_eq!(fs::read(&target1).unwrap(), b"data only sync");

        // None 策略（批处理/非致命写入）
        let target2 = dir.join("no_sync.txt");
        let mut tx2 = AtomicWriteTx::new(&target2).unwrap().with_sync_policy(SyncPolicy::None);
        assert_eq!(tx2.sync_policy(), SyncPolicy::None);
        tx2.write_temp(b"no sync batch").unwrap();
        tx2.backup_existing().unwrap();
        tx2.commit().unwrap();
        assert_eq!(fs::read(&target2).unwrap(), b"no sync batch");

        let _ = fs::remove_dir_all(&dir);
    }
}
