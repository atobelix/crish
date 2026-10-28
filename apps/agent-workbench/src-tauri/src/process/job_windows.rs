//! Windows 原生 Job Object 防孤儿双防线（W3-T2 原生 Windows Job Object 防孤儿双防线）。
//!
//! # 架构原则与双防线设计
//!
//! 1. **架构原则（彻底杜绝错误设计）**：
//!    坚决物理删除在宿主进程内部开线程监控宿主自己 PID 的错误实现。宿主一旦遭遇崩溃、断电、
//!    OOM 或操作系统 `taskkill /F`，宿主内所有线程在同一微秒被内核销毁，子进程 100% 逃逸。
//! 2. **第一防线（Windows 原生 Job Object 铁壁）**：
//!    通过 Windows 内核级作业对象（Job Object）的 `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` 限制标志，
//!    将子进程与作业对象强绑定。只要父进程持有的最后一个作业对象句柄随进程退出/崩溃而关闭，
//!    Windows 内核即自动递归强杀整棵子进程树，物理保证 0 孤儿逃逸。
//! 3. **第二防线（降权受限环境优雅降级）**：
//!    在 Windows 8 以前或某些不可嵌套沙箱、远程开发容器或 Docker 环境中，`AssignProcessToJobObject`
//!    可能返回 `ERROR_ACCESS_DENIED`。此时系统精确识别错误码并启动结构化警告与安全优雅降级，
//!    避免宿主应用崩溃，并退化为两阶段显式进程树终结兜底。

use std::os::windows::io::RawHandle;
use std::sync::OnceLock;
use windows_sys::Win32::Foundation::{CloseHandle, ERROR_ACCESS_DENIED, HANDLE};
use windows_sys::Win32::System::JobObjects::*;
use windows_sys::Win32::System::Threading::{
    OpenProcess, PROCESS_SET_QUOTA, PROCESS_TERMINATE,
};

/// 封装 Win32 HANDLE 的结构体，供 OnceLock 静态存储使用
#[cfg(windows)]
pub(super) struct JobHandle(pub(super) HANDLE);

#[cfg(windows)]
#[allow(unsafe_code)]
// SAFETY: JobHandle 仅包含原始整数句柄，无线程局部状态，生命周期由 OnceLock / 调用方负责保证
unsafe impl Send for JobHandle {}

#[cfg(windows)]
#[allow(unsafe_code)]
// SAFETY: JobHandle 在 OnceLock 中初始化后作为只读借用暴露，进程生命周期内安全共享
unsafe impl Sync for JobHandle {}

// ==================== 第一防线：Windows 原生 Job Object 铁壁实现 ====================

/// 为指定进程句柄配置原生 Windows Job Object 防孤儿铁壁（第一防线）。
///
/// 架构保证：
/// 1. 创建匿名 Job Object (`CreateJobObjectW`)；
/// 2. 配置 `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` (`SetInformationJobObject`)；
/// 3. 通过 `AssignProcessToJobObject` 将外部进程挂入 Job；
/// 4. 使得宿主退出时操作系统内核自动递归强杀整棵子进程树，零孤儿逃逸。
///
/// 第二防线（降权受限环境优雅降级）：
/// 当 `AssignProcessToJobObject` 返回 `ERROR_ACCESS_DENIED`（常见于已存在于受限沙箱或禁止嵌套的环境）时，
/// 记录警告日志并安全关闭创建的 Job 句柄，返回 `Ok(std::ptr::null_mut())`，绝不崩溃中断。
#[cfg(windows)]
#[allow(unsafe_code)]
pub fn configure_job_object_for_process(
    h_process: HANDLE,
) -> Result<HANDLE, std::io::Error> {
    use core::mem::size_of;
    use core::ptr;

    // SAFETY: Windows Job Object API 标准调用序列，各指针与结构体生命周期和大小匹配
    unsafe {
        // 步骤 1: 创建匿名的 Job Object
        let h_job = CreateJobObjectW(ptr::null_mut(), ptr::null());
        if h_job.is_null() {
            let err = std::io::Error::last_os_error();
            tracing::error!(
                target: "process::job",
                error = %err,
                "CreateJobObjectW 失败，无法创建 Job Object"
            );
            return Err(err);
        }

        // 步骤 2: 配置父进程关闭句柄时内核自动递归强杀 Job 内所有进程树
        let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = core::mem::zeroed();
        info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;

        let res = SetInformationJobObject(
            h_job,
            JobObjectExtendedLimitInformation,
            &info as *const _ as *const core::ffi::c_void,
            size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
        );
        if res == 0 {
            let err = std::io::Error::last_os_error();
            tracing::error!(
                target: "process::job",
                error = %err,
                "SetInformationJobObject 设置 JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE 失败"
            );
            let _ = CloseHandle(h_job);
            return Err(err);
        }

        // 步骤 3: 挂载目标进程至该 Job Object
        let assign_res = AssignProcessToJobObject(h_job, h_process);
        if assign_res == 0 {
            let err = std::io::Error::last_os_error();
            // 第二防线：受限沙箱或禁止嵌套环境优雅降级
            if err.raw_os_error() == Some(ERROR_ACCESS_DENIED as i32) {
                tracing::warn!(
                    target: "process::job",
                    error = %err,
                    "AssignProcessToJobObject 返回 ERROR_ACCESS_DENIED (当前处于嵌套沙箱或受限 Job Object 环境)；启动安全优雅降级"
                );
                let _ = CloseHandle(h_job);
                return Ok(ptr::null_mut());
            }

            tracing::error!(
                target: "process::job",
                error = %err,
                "AssignProcessToJobObject 失败"
            );
            let _ = CloseHandle(h_job);
            return Err(err);
        }

        Ok(h_job)
    }
}

/// 通过 PID 为目标外部进程配置专属 Job Object 防孤儿铁壁
#[cfg(windows)]
#[allow(unsafe_code)]
pub fn configure_job_object_for_pid(pid: u32) -> Result<HANDLE, std::io::Error> {
    // SAFETY: OpenProcess 申请 PROCESS_SET_QUOTA | PROCESS_TERMINATE 权限以加入作业对象
    unsafe {
        let handle = OpenProcess(PROCESS_SET_QUOTA | PROCESS_TERMINATE, 0, pid);
        if handle.is_null() {
            let err = std::io::Error::last_os_error();
            if err.raw_os_error() == Some(ERROR_ACCESS_DENIED as i32) {
                tracing::warn!(
                    target: "process::job",
                    pid,
                    error = %err,
                    "OpenProcess({pid}) 遇到 ERROR_ACCESS_DENIED；启动优雅降级"
                );
                return Ok(core::ptr::null_mut());
            }
            return Err(err);
        }

        let res = configure_job_object_for_process(handle);
        let _ = CloseHandle(handle);
        res
    }
}

/// RAII 包装：管理单进程或子进程树的专属 Job Object 生命周期。
///
/// 调用方持有该守卫，跨越子进程执行生命周期；当宿主进程崩溃时，操作系统内核强杀子进程树；
/// 当命令自然终结退出时，Drop 自动安全关闭句柄。
#[cfg(windows)]
pub struct ProcessJobGuard {
    job: HANDLE,
}

#[cfg(windows)]
#[allow(unsafe_code)]
// SAFETY: ProcessJobGuard 仅持有 Windows 内核 Job 句柄，无线程局部状态，可安全跨线程传递与持有
unsafe impl Send for ProcessJobGuard {}

#[cfg(windows)]
#[allow(unsafe_code)]
// SAFETY: ProcessJobGuard 句柄在生命周期内不被并发异变修改，仅在 Drop 时清理
unsafe impl Sync for ProcessJobGuard {}

#[cfg(windows)]
impl ProcessJobGuard {
    /// 为给定的原始进程句柄创建专属防孤儿守卫（受限环境降级返回 Ok(None)）
    #[allow(dead_code)]
    pub fn new_for_process(h_process: HANDLE) -> Result<Option<Self>, std::io::Error> {
        let job = configure_job_object_for_process(h_process)?;
        if job.is_null() {
            Ok(None)
        } else {
            Ok(Some(Self { job }))
        }
    }

    /// 通过 PID 为外部进程创建专属防孤儿守卫（受限环境降级返回 Ok(None)）
    pub fn new_for_pid(pid: u32) -> Result<Option<Self>, std::io::Error> {
        let job = configure_job_object_for_pid(pid)?;
        if job.is_null() {
            Ok(None)
        } else {
            Ok(Some(Self { job }))
        }
    }

    /// 获取底层 Job 句柄原始借用
    #[allow(dead_code)]
    pub fn raw_handle(&self) -> HANDLE {
        self.job
    }

    /// 主动解除 KILL_ON_JOB_CLOSE 限制并移交句柄（例如进程需转交后台独立存活）
    #[allow(dead_code)]
    #[allow(unsafe_code)]
    pub fn disarm(mut self) -> Result<(), std::io::Error> {
        use core::mem::size_of;

        if self.job.is_null() {
            return Ok(());
        }

        // SAFETY: 将 LimitFlags 置 0 解除自动强杀限制
        unsafe {
            let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = core::mem::zeroed();
            info.BasicLimitInformation.LimitFlags = 0;

            let ret = SetInformationJobObject(
                self.job,
                JobObjectExtendedLimitInformation,
                &info as *const _ as *const core::ffi::c_void,
                size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            );
            let _ = CloseHandle(self.job);
            self.job = core::ptr::null_mut();

            if ret == 0 {
                return Err(std::io::Error::last_os_error());
            }
            Ok(())
        }
    }
}

#[cfg(windows)]
impl Drop for ProcessJobGuard {
    #[allow(unsafe_code)]
    fn drop(&mut self) {
        if !self.job.is_null() {
            // SAFETY: 释放 Job 句柄；若进程仍在运行且宿主崩溃，内核在此处触发强杀限制
            unsafe {
                let _ = CloseHandle(self.job);
            }
            self.job = core::ptr::null_mut();
        }
    }
}

// ==================== 共享基础原语与全局 Job 实例 ====================

/// 创建带有 `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` 限制的匿名 Job Object。
///
/// 返回句柄所有权归调用方所有（需通过 CloseHandle 释放，或保存在全局生命周期中）。
#[cfg(windows)]
#[allow(unsafe_code)]
pub(crate) fn create_kill_on_close_job_object() -> Result<HANDLE, String> {
    use core::mem;
    use core::ptr;

    // SAFETY: JOBOBJECT_EXTENDED_LIMIT_INFORMATION 栈分配，失败时 CloseHandle
    unsafe {
        let job = CreateJobObjectW(ptr::null_mut(), ptr::null());
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

/// 将子进程句柄挂载到已存在的 Job Object 中。
///
/// 第二防线：若遇到 `ERROR_ACCESS_DENIED`（如嵌套沙箱不可嵌套），安全优雅降级为 `Ok(())` 并记录 warn 日志。
#[cfg(windows)]
#[allow(unsafe_code)]
pub(super) fn assign_process_to_job(
    job: HANDLE,
    child_handle: RawHandle,
) -> Result<(), String> {
    // SAFETY: hJob 与 processHandle 由调用方保证有效
    unsafe {
        if AssignProcessToJobObject(job, child_handle as HANDLE) == 0 {
            let err = std::io::Error::last_os_error();
            if err.raw_os_error() == Some(ERROR_ACCESS_DENIED as i32) {
                tracing::warn!(
                    target: "process::job",
                    error = %err,
                    "AssignProcessToJobObject 返回 ERROR_ACCESS_DENIED（嵌套沙箱环境）；已安全优雅降级"
                );
                return Ok(());
            }
            return Err(format!("AssignProcessToJobObject failed: {err}"));
        }
    }
    Ok(())
}

// ── Daemon job (后台长驻守护任务；应用全局独立，与 PTY Job 隔离) ─────────────

#[cfg(windows)]
pub(super) static DAEMON_JOB_OBJECT: OnceLock<JobHandle> = OnceLock::new();

/// 初始化后台长驻守护任务专属 Job Object
#[cfg(windows)]
#[allow(unsafe_code)]
pub(crate) fn init_daemon_job_object() -> Result<(), String> {
    let handle = create_kill_on_close_job_object()?;
    match DAEMON_JOB_OBJECT.set(JobHandle(handle)) {
        Ok(()) => Ok(()),
        Err(JobHandle(dup)) => {
            // SAFETY: 重复 init 时关闭多余句柄
            unsafe {
                let _ = CloseHandle(dup);
            }
            Ok(())
        }
    }
}

/// 将指定 PID 的后台进程挂载至 DAEMON_JOB_OBJECT
#[cfg(windows)]
#[allow(unsafe_code)]
pub(crate) fn assign_pid_to_daemon_job(pid: u32) -> Result<(), String> {
    let job = DAEMON_JOB_OBJECT.get().ok_or_else(|| {
        "daemon job object not initialized; call init_daemon_job_object() first".to_string()
    })?;

    // SAFETY: OpenProcess 句柄与本函数生命周期绑定，CloseHandle 兜底释放
    unsafe {
        let handle = OpenProcess(PROCESS_SET_QUOTA | PROCESS_TERMINATE, 0, pid);
        if handle.is_null() {
            let err = std::io::Error::last_os_error();
            if err.raw_os_error() == Some(ERROR_ACCESS_DENIED as i32) {
                tracing::warn!(
                    target: "process::job",
                    pid,
                    error = %err,
                    "OpenProcess({pid}) 遇到 ERROR_ACCESS_DENIED；已安全优雅降级"
                );
                return Ok(());
            }
            return Err(format!("OpenProcess({pid}) failed: {err}"));
        }
        let result = assign_process_to_job(job.0, handle);
        let _ = CloseHandle(handle);
        result
    }
}

/// daemon Job 句柄访问器（用于 Windows 资源采样 QueryInformationJobObject）
#[cfg(windows)]
pub(crate) fn daemon_job_handle() -> Option<HANDLE> {
    DAEMON_JOB_OBJECT.get().map(|h| h.0)
}

// ── PTY job (交互式终端会话；应用全局共享，与 Daemon Job 隔离) ─────────────

#[cfg(windows)]
pub(super) static PTY_JOB_OBJECT: OnceLock<JobHandle> = OnceLock::new();

/// 初始化交互式终端 PTY 专属 Job Object
#[cfg(windows)]
#[allow(unsafe_code)]
pub(crate) fn init_pty_job_object() -> Result<(), String> {
    let handle = create_kill_on_close_job_object()?;
    match PTY_JOB_OBJECT.set(JobHandle(handle)) {
        Ok(()) => Ok(()),
        Err(JobHandle(dup)) => {
            // SAFETY: 重复 init 时关闭多余句柄
            unsafe {
                let _ = CloseHandle(dup);
            }
            Ok(())
        }
    }
}

/// 将 PTY 子进程句柄挂载至 PTY_JOB_OBJECT
#[cfg(windows)]
pub(crate) fn assign_child_to_pty_job_object(child_handle: RawHandle) -> Result<(), String> {
    let job = PTY_JOB_OBJECT.get().ok_or_else(|| {
        "pty job object not initialized; call init_pty_job_object() first".to_string()
    })?;
    assign_process_to_job(job.0, child_handle)
}
