//! Unix 进程组原语（setpgid / killpg；自 process.rs 原样搬迁）。
//! 本模块由 process/mod.rs 的 `#[cfg(not(windows))] mod group_unix;` 门控；
//! 各项原有的 `#[cfg(not(windows))]` 属性逐字保留。

#[cfg(not(windows))]
// 豁免 unsafe_code：POSIX libc FFI（setpgid），参数为整数 PID 无指针
// 所有权转移（SAFETY 见函数内注释），经评审后允许。
#[allow(unsafe_code)]
pub(crate) fn set_child_process_group(pid: u32) -> Result<(), String> {
    // SAFETY: POSIX 标准 API
    unsafe {
        if libc::setpgid(pid as libc::pid_t, pid as libc::pid_t) != 0 {
            return Err(format!(
                "setpgid failed for PID {pid}: {}",
                std::io::Error::last_os_error()
            ));
        }
    }
    Ok(())
}

#[cfg(not(windows))]
// 豁免 unsafe_code：POSIX libc FFI（killpg），参数为整数 PID 无指针
// 所有权转移（SAFETY 见函数内注释），经评审后允许。
#[allow(unsafe_code)]
pub(crate) fn kill_process_group(pid: u32) -> Result<(), String> {
    // SAFETY: POSIX 标准 API
    unsafe {
        if libc::killpg(pid as libc::pid_t, libc::SIGTERM) != 0 {
            return Err(format!(
                "killpg failed for PID {pid}: {}",
                std::io::Error::last_os_error()
            ));
        }
    }
    Ok(())
}
