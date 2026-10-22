//! Windows Job Object 孤儿进程保护（daemon Job / PTY Job；自 process.rs 原样搬迁）。
//! 本模块由 process/mod.rs 的 `#[cfg(windows)] mod job_windows;` 门控，仅 Windows 编译；
//! 各项原有的 `#[cfg(windows)]` 属性逐字保留。

use std::sync::OnceLock;

// ==================== Job Objects (Orphan Process Protection) ====================
//
// Shared primitive: `create_kill_on_close_job_object` — JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE.
// When the last handle to a job is closed (host exit or crash), Windows kills every process
// still assigned to that job (and their descendants that inherited membership).
//
// Two independent jobs (T-AB-06: daemon job series restored, G11a 遗留恢复):
//   - PTY Job（`PTY_JOB_OBJECT`）：交互式终端 shell，spawn 时在 pty/session.rs 接线
//     （共享 app 级）；终端面板 kill_all / dock unmount 语义不变；
//   - Daemon Job（`DAEMON_JOB_OBJECT`，本轮新增）：后台任务（后台任务注册表 adopt 时
//     经 `assign_pid_to_daemon_job` 接线）。与 PTY Job 相互隔离：
//     * 守护进程不得被终端面板 kill_all 连带误杀（Job 句柄独立 + kill_all 只清 PTY 注册表）；
//     * 应用退出/崩溃 → 宿主 Job 句柄关闭 → daemon Job 兜底全杀（孤儿保护语义不变）。
//
// 诚实边界（本机已实测，登记新发现）：开发环境宿主确实会包裹子进程（taskkill
// 无 /F 时可见「进程位于宿主作业中」的报错），但 Windows 8+ 支持嵌套 Job——
// 实测 AssignProcessToJobObject 到 daemon Job 成功。接线仍为 best-effort：
// 若宿主 Job 禁止嵌套（或进程已属其他不可嵌套 Job），分配返回拒绝——失败仅
// warn 降级（孤儿保护退化为显式 kill 路径兜底，见 background.rs adopt 注释），
// 不阻断任务注册。
//
// Explicit kill paths remain:
//   - PTY: `pty::kill_all_sessions()` on `RunEvent::Exit` (main.rs) and per-session kill
//   - Dock unmount must NOT kill PTYs (frontend contract) — Job only fires on handle close
//   - Daemon: 两阶段终止（R-AB2 T-AB-11）显式 kill；强制树杀见 terminate_process_tree
//
// Cross-ref: pty/mod.rs, pty/session.rs (Windows assign; Unix process-group best-effort).
//

/// Opaque job handle wrapper for OnceLock statics.
#[cfg(windows)]
pub(super) struct JobHandle(pub(super) windows_sys::Win32::Foundation::HANDLE);

#[cfg(windows)]
// 豁免 unsafe_code：Send 标记（SAFETY 见下）——JobHandle 仅含整数句柄，
// 经评审后允许。
#[allow(unsafe_code)]
// SAFETY: JobHandle 仅含整数句柄；Create/Assign/Close 由调用方串行化到 OnceLock
unsafe impl Send for JobHandle {}

#[cfg(windows)]
// 豁免 unsafe_code：Sync 标记（SAFETY 见下）——JobHandle 仅含整数句柄，
// 经评审后允许。
#[allow(unsafe_code)]
// SAFETY: JobHandle 仅含整数句柄；句柄一经 DAEMON_JOB_OBJECT/PTY_JOB_OBJECT
// OnceLock 初始化后只读（get() 只读借用），进程生命周期内不被并发关闭；
// Close 仅发生在重复 init 的失败路径且持有独占写
unsafe impl Sync for JobHandle {}

/// Create an anonymous job with `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`.
/// Caller owns the returned handle (CloseHandle when done, or store for process lifetime).
/// Used by daemon and PTY orphan protection — see module comment above.
#[cfg(windows)]
// 豁免 unsafe_code：Windows Job Objects FFI（CreateJobObjectW /
// SetInformationJobObject），每处 unsafe 均有 SAFETY 说明，经评审后允许。
#[allow(unsafe_code)]
pub(crate) fn create_kill_on_close_job_object(
) -> Result<windows_sys::Win32::Foundation::HANDLE, String> {
    use core::mem;
    use core::ptr;
    use windows_sys::Win32::Foundation::CloseHandle;
    use windows_sys::Win32::System::JobObjects::*;

    // SAFETY: JOBOBJECT_EXTENDED_LIMIT_INFORMATION 栈分配；失败时 CloseHandle
    unsafe {
        let job = CreateJobObjectW(ptr::null_mut(), ptr::null_mut());
        if job.is_null() {
            return Err("CreateJobObjectW failed: unable to create job object".to_string());
        }

        let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = mem::zeroed();
        info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;

        let ret = SetInformationJobObject(
            job,
            JobObjectExtendedLimitInformation,
            &info as *const _ as *const core::ffi::c_void,
            mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
        );
        if ret == 0 {
            let _ = CloseHandle(job);
            return Err("SetInformationJobObject failed: unable to set kill-on-close".to_string());
        }

        Ok(job)
    }
}

#[cfg(windows)]
// 豁免 unsafe_code：Windows Job Objects FFI（AssignProcessToJobObject），
// SAFETY 见函数内注释，经评审后允许。
#[allow(unsafe_code)]
pub(super) fn assign_process_to_job(
    job: windows_sys::Win32::Foundation::HANDLE,
    child_handle: std::os::windows::io::RawHandle,
) -> Result<(), String> {
    use windows_sys::Win32::System::JobObjects::AssignProcessToJobObject;

    // SAFETY: hJob 与 processHandle 由调用方保证有效
    unsafe {
        if AssignProcessToJobObject(job, child_handle as windows_sys::Win32::Foundation::HANDLE)
            == 0
        {
            return Err(
                "AssignProcessToJobObject failed: unable to assign child to job".to_string(),
            );
        }
    }
    Ok(())
}

// ── Daemon job (background tasks; app-wide, isolated from PTY job) ─────────────
// T-AB-06：后台任务独立 Job。与 PTY Job（:451 下段）句柄隔离——守护进程不得被
// 终端面板 kill_all 连带误杀；应用退出时宿主句柄关闭 → 兜底全杀（孤儿保护语义
// 不变）。接线点：BackgroundTaskRegistry::adopt（background.rs）。

#[cfg(windows)]
pub(super) static DAEMON_JOB_OBJECT: OnceLock<JobHandle> = OnceLock::new();

#[cfg(windows)]
// 豁免 unsafe_code：CloseHandle FFI（重复 init 时的句柄清理），
// SAFETY 见函数内注释，经评审后允许。
#[allow(unsafe_code)]
pub(crate) fn init_daemon_job_object() -> Result<(), String> {
    let handle = create_kill_on_close_job_object()?;
    match DAEMON_JOB_OBJECT.set(JobHandle(handle)) {
        Ok(()) => Ok(()),
        Err(JobHandle(dup)) => {
            // SAFETY: 重复 init 时关闭多余句柄（OnceLock 已持有一个）
            unsafe {
                windows_sys::Win32::Foundation::CloseHandle(dup);
            }
            Ok(())
        }
    }
}

#[cfg(windows)]
// 豁免 unsafe_code：OpenProcess/CloseHandle FFI（进程句柄生命周期仅限本函数），
// SAFETY 见函数内注释，经评审后允许。
#[allow(unsafe_code)]
pub(crate) fn assign_pid_to_daemon_job(pid: u32) -> Result<(), String> {
    use windows_sys::Win32::System::Threading::{
        OpenProcess, PROCESS_SET_QUOTA, PROCESS_TERMINATE,
    };

    let job = DAEMON_JOB_OBJECT.get().ok_or_else(|| {
        "daemon job object not initialized; call init_daemon_job_object() first".to_string()
    })?;
    // SAFETY: OpenProcess 句柄与本函数生命周期绑定，CloseHandle 兜底释放；
    // AssignProcessToJobObject 所需访问权（PROCESS_SET_QUOTA | PROCESS_TERMINATE）
    // 按 MSDN 契约给出。进程已在宿主 Job 内时返回拒绝，由调用方降级处理。
    unsafe {
        let handle = OpenProcess(PROCESS_SET_QUOTA | PROCESS_TERMINATE, 0, pid);
        if handle.is_null() {
            return Err(format!(
                "OpenProcess({pid}) failed: {}",
                std::io::Error::last_os_error()
            ));
        }
        let result = assign_process_to_job(job.0, handle);
        let _ = windows_sys::Win32::Foundation::CloseHandle(handle);
        result
    }
}

/// daemon Job 句柄访问器（T-AB-15 Windows 资源采样消费：`QueryInformationJobObject`
/// 需要 Job 句柄；句柄在 OnceLock 内生命周期与进程一致，仅借用不可转移）。
///
/// 接线说明（登记偏差）：daemon Job 句柄原先封装在模块私有 static 中，资源
/// 采样原语（resource.rs）无法获取——本 getter 为纯只读暴露（不改行为，
/// 不触碰 Job 生命周期），供 background.rs 资源段采样接线，报主 Agent 裁决。
#[cfg(windows)]
pub(crate) fn daemon_job_handle() -> Option<windows_sys::Win32::Foundation::HANDLE> {
    DAEMON_JOB_OBJECT.get().map(|h| h.0)
}

// ── PTY job (interactive shells; shared app-wide) ────────────────────────────
// One job for all PTY sessions: simplest correct tree lifecycle. Host crash closes
// the handle → OS kills every assigned shell and descendants. Per-session kill and
// kill_all still use portable-pty ChildKiller (independent of job membership).

#[cfg(windows)]
pub(super) static PTY_JOB_OBJECT: OnceLock<JobHandle> = OnceLock::new();

#[cfg(windows)]
// 豁免 unsafe_code：CloseHandle FFI（重复 init 时的句柄清理），
// SAFETY 见函数内注释，经评审后允许。
#[allow(unsafe_code)]
pub(crate) fn init_pty_job_object() -> Result<(), String> {
    let handle = create_kill_on_close_job_object()?;
    match PTY_JOB_OBJECT.set(JobHandle(handle)) {
        Ok(()) => Ok(()),
        Err(JobHandle(dup)) => {
            // SAFETY: 重复 init 时关闭多余句柄
            unsafe {
                windows_sys::Win32::Foundation::CloseHandle(dup);
            }
            Ok(())
        }
    }
}

#[cfg(windows)]
pub(crate) fn assign_child_to_pty_job_object(
    child_handle: std::os::windows::io::RawHandle,
) -> Result<(), String> {
    let job = PTY_JOB_OBJECT.get().ok_or_else(|| {
        "pty job object not initialized; call init_pty_job_object() first".to_string()
    })?;
    assign_process_to_job(job.0, child_handle)
}
