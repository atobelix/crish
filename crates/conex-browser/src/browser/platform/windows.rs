//! Windows 平台实现（§8 差异表）：
//! Job Object 杀树（CREATE_SUSPENDED + AssignProcessToJobObject +
//! JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE）主方案；失败兜底 taskkill /T /F。
//!
//! 锁纪律（31-security-baseline B8）：unsafe 全部局部化于本模块并逐处注释
//! 安全不变量；错误路径一律返回 Result/String 而非 panic。

use super::ProcessTreeKiller;
use windows_sys::Win32::Foundation::{CloseHandle, HANDLE};
use windows_sys::Win32::System::JobObjects::{
    AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
    SetInformationJobObject, TerminateJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
    JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
};
use windows_sys::Win32::System::Threading::{OpenThread, ResumeThread, THREAD_SUSPEND_RESUME};
use windows_sys::Win32::System::Diagnostics::ToolHelp::{
    CreateToolhelp32Snapshot, Thread32First, Thread32Next, THREADENTRY32, TH32CS_SNAPTHREAD,
};

/// 杀树模式（attach 失败自动降级 taskkill）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum KillMode {
    Job,
    Taskkill,
}

/// Job Object 终结器。
pub struct JobTreeKiller {
    job: Option<HANDLE>,
    pid: Option<u32>,
    mode: KillMode,
}

// SAFETY：HANDLE（*mut c_void）不自动实现 Send；JobTreeKiller 仅在同线程内
// 创建/使用（attach/kill 均在同一驱动任务），跨线程传递仅发生在 Box<dyn ProcessTreeKiller>
// 的 Send 边界（测试构造后原位使用），句柄所有权不跨线程转移。
#[allow(unsafe_code)]
unsafe impl Send for JobTreeKiller {}

impl JobTreeKiller {
    pub fn new() -> Self {
        JobTreeKiller {
            job: None,
            pid: None,
            mode: KillMode::Taskkill,
        }
    }
}

impl Default for JobTreeKiller {
    fn default() -> Self {
        Self::new()
    }
}

impl ProcessTreeKiller for JobTreeKiller {
    fn attach(&mut self, child: &mut tokio::process::Child) -> Result<(), String> {
        self.pid = child.id();
        // 1. 创建 Job（KILL_ON_JOB_CLOSE：句柄关闭即终结整棵树）
        let job = match create_job() {
            Ok(j) => j,
            Err(e) => {
                tracing::warn!("创建 Job Object 失败，杀树降级 taskkill：{e}");
                return Err(e);
            }
        };
        // 2. 挂接（进程此时仍处于 CREATE_SUSPENDED 冻结态，子树未派生）
        if let Err(e) = assign_to_job(job, child) {
            tracing::warn!(
                "AssignProcessToJobObject 失败（可能已处于受限 Job 内），杀树降级 taskkill：{e}"
            );
            close_handle(job);
            return Err(e);
        }
        self.job = Some(job);
        // 3. 恢复主线程（挂接完成前的冻结窗口保证整棵子树被 Job 捕获）
        if let Err(e) = resume_main_thread(child) {
            // 恢复失败 → 进程卡死：先杀掉再报错
            let _ = self.kill_tree();
            return Err(format!("恢复主线程失败：{e}"));
        }
        self.mode = KillMode::Job;
        Ok(())
    }

    fn kill_tree(&mut self) -> Result<(), String> {
        match self.mode {
            KillMode::Job => {
                if let Some(job) = self.job {
                    // TerminateJobObject：终结 Job 内全部进程（含未退出子树）
                    let ok = terminate_job(job);
                    close_handle(job);
                    self.job = None;
                    if ok {
                        return Ok(());
                    }
                    tracing::warn!("TerminateJobObject 失败，降级 taskkill");
                }
                self.taskkill_fallback()
            }
            KillMode::Taskkill => self.taskkill_fallback(),
        }
    }

    fn kill_sync(&self, pid: u32) {
        if taskkill(pid).is_ok() {
            // 回收窗口：taskkill 返回仅表示终结请求已发出，进程对象（PID 可见性）
            // 尚有内核回收窗口（句柄未全部关闭时 OpenProcess 仍可能成功）。
            // 等待回收（上限 2s 防 Drop 路径阻塞）降低下游 is_pid_alive 误判。
            wait_pid_gone(
                pid,
                std::time::Duration::from_millis(2000),
                std::time::Duration::from_millis(50),
            );
        }
    }
}

impl JobTreeKiller {
    fn taskkill_fallback(&self) -> Result<(), String> {
        match self.pid {
            Some(pid) => taskkill(pid),
            None => Err("未知 PID，无法杀树".to_string()),
        }
    }
}

/// 创建 Job（安全默认：无安全描述符，继承调用者令牌语义）。
#[allow(unsafe_code)]
fn create_job() -> Result<HANDLE, String> {
    // SAFETY：CreateJobObjectW 标准 API；name 传 NULL → 匿名 Job；
    // lpjobattributes 传 NULL → 默认安全描述符
    let job = unsafe {
        CreateJobObjectW(
            std::ptr::null::<windows_sys::Win32::Security::SECURITY_ATTRIBUTES>(),
            std::ptr::null::<u16>(),
        )
    };
    if job.is_null() {
        return Err("CreateJobObjectW 返回 NULL".to_string());
    }
    // SAFETY：零初始化内核结构后按字段赋值（KILL_ON_JOB_CLOSE 位）
    let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = unsafe { std::mem::zeroed() };
    info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
    // SAFETY：SetInformationJobObject 写内核对象信息；size 与结构一致
    let ok = unsafe {
        SetInformationJobObject(
            job,
            JobObjectExtendedLimitInformation,
            &info as *const _ as *const core::ffi::c_void,
            std::mem::size_of_val(&info) as u32,
        )
    };
    if ok == 0 {
        close_handle(job);
        return Err("SetInformationJobObject 失败".to_string());
    }
    Ok(job)
}

/// 将子进程挂接进 Job。
#[allow(unsafe_code)]
fn assign_to_job(job: HANDLE, child: &tokio::process::Child) -> Result<(), String> {
    // SAFETY：AssignProcessToJobObject(job, processHandle)；句柄来自
    // tokio Child::raw_handle（Windows 专属，Option 形态）；取不到句柄视为挂接失败
    let Some(handle) = child.raw_handle() else {
        return Err("无法获取子进程句柄".to_string());
    };
    let ok = unsafe { AssignProcessToJobObject(job, handle) };
    if ok == 0 {
        return Err("AssignProcessToJobObject 返回 0".to_string());
    }
    Ok(())
}

/// 恢复主线程（CREATE_SUSPENDED 冻结 → ResumeThread）。
/// 线程快照枚举与进程创建存在偶发竞态（高负载下快照暂不可见主线程），
/// 有限重试 3 次（20ms 间隔）仍失败才报错，降低 attach 偶发降级。
///
/// M8 调用约束（评审 29 §M8）：本函数为**同步 Win32 调用面**（CreateToolhelp32Snapshot
/// 快照枚举 + 20ms×3 恢复等待）。当前 `attach` 为跨平台同步 trait 契约
/// （platform/mod.rs `ProcessTreeKiller::attach`），Windows 侧**无法在同步契约内**
/// 把等待 async 化——生产 runtime 为 current_thread（engine.rs:909），该形态下
/// `tokio::task::block_in_place`/`Handle::block_on` 均不可用（前者 panic，后者
/// 在 runtime 上下文内禁止），同步函数内也无法 await `spawn_blocking`。
///
/// **调用约束**：不得在 async 上下文（tokio worker 上）直接透传本函数阻塞面；
/// `attach` 的调用点若处于 async 上下文（如 `BrowserManager::launch_once`），
/// 阻塞面应由调用方以 `tokio::task::spawn_blocking` 包裹整个 attach 收敛。
/// 当前因 `tokio::process::Child` 生命周期贯穿 launch_once（attach 后仍需
/// id/stderr/wait）无法在调用点包裹，**列后续项：`ProcessTreeKiller` 接口
/// async 化后，本函数改由 `spawn_blocking(move || resume_main_thread_raw(pid,
/// raw_handle)).await` 承接**。改动本函数前须先阅读平台/模块契约。
fn resume_main_thread(child: &tokio::process::Child) -> Result<(), String> {
    let mut last_err = String::new();
    for _ in 0..3 {
        match try_resume_main_thread(child) {
            Ok(()) => return Ok(()),
            Err(e) => last_err = e,
        }
        std::thread::sleep(std::time::Duration::from_millis(20));
    }
    Err(last_err)
}

#[allow(unsafe_code)]
fn try_resume_main_thread(child: &tokio::process::Child) -> Result<(), String> {
    // SAFETY：进程线程快照枚举（TH32CS_SNAPTHREAD）；标准 API
    let snapshot = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPTHREAD, 0) };
    if snapshot.is_null() {
        return Err("CreateToolhelp32Snapshot 失败".to_string());
    }
    let pid = child.id().unwrap_or(0);
    let mut entry: THREADENTRY32 = unsafe { std::mem::zeroed() };
    entry.dwSize = std::mem::size_of::<THREADENTRY32>() as u32;
    // SAFETY：Thread32First 初始化枚举
    let mut found = unsafe { Thread32First(snapshot, &mut entry) } != 0;
    let mut thread: HANDLE = std::ptr::null_mut();
    while found {
        if entry.th32OwnerProcessID == pid {
            // SAFETY：OpenThread 按主线程 ID 打开（THREAD_SUSPEND_RESUME）
            thread = unsafe { OpenThread(THREAD_SUSPEND_RESUME, 0, entry.th32ThreadID) };
            break;
        }
        // SAFETY：Thread32Next 推进枚举
        found = unsafe { Thread32Next(snapshot, &mut entry) } != 0;
    }
    // SAFETY：CloseHandle 释放快照句柄
    unsafe { CloseHandle(snapshot) };
    if thread.is_null() {
        return Err(format!("未找到 PID {pid} 的主线程"));
    }
    // SAFETY：ResumeThread 恢复挂起线程；返回 -1 = 失败（u32::MAX）
    let prev = unsafe { ResumeThread(thread) };
    // SAFETY：CloseHandle 释放线程句柄
    unsafe { CloseHandle(thread) };
    if prev == u32::MAX {
        return Err("ResumeThread 失败".to_string());
    }
    Ok(())
}

/// TerminateJobObject（整树终结）。
#[allow(unsafe_code)]
fn terminate_job(job: HANDLE) -> bool {
    // SAFETY：TerminateJobObject(job, exitCode=1)；终结 Job 内全部进程
    unsafe { TerminateJobObject(job, 1) != 0 }
}

#[allow(unsafe_code)]
fn close_handle(handle: HANDLE) {
    // SAFETY：CloseHandle 释放内核句柄（句柄来源均为本模块创建/打开）
    unsafe {
        CloseHandle(handle);
    }
}

/// taskkill 兜底（/T 子树 /F 强制）。
/// 豁免 clippy 子进程禁令：进程树终止属「内部进程管理原语」豁免面
/// （clippy.toml 注释：固定系统工具调用，参数仅 PID 数字拼接，同步等待型）。
#[allow(clippy::disallowed_methods)]
fn taskkill(pid: u32) -> Result<(), String> {
    let out = std::process::Command::new("taskkill")
        .args(["/PID", &pid.to_string(), "/T", "/F"])
        .output()
        .map_err(|e| format!("taskkill 启动失败：{e}"))?;
    if out.status.success() {
        Ok(())
    } else {
        Err(format!(
            "taskkill 失败：{}",
            String::from_utf8_lossy(&out.stderr).trim()
        ))
    }
}

/// 同步等待 PID 进程对象回收（best-effort：超时静默返回）。
/// 终结请求成功后，进程对象需待内核完成删除（含最后句柄关闭）；
/// 此窗口内 `is_pid_alive` 短暂为真属正常，调用方应以轮询而非单点断言判定。
fn wait_pid_gone(
    pid: u32,
    window: std::time::Duration,
    interval: std::time::Duration,
) {
    let deadline = std::time::Instant::now() + window;
    while std::time::Instant::now() < deadline {
        if !crate::browser::profile::is_pid_alive(pid) {
            return;
        }
        std::thread::sleep(interval);
    }
}

// Windows 平台语义测试（32 评审 P1-1）：fake_browser .bat harness 与 Job
// Object / taskkill 杀树依赖 Windows 语义——除模块级 `#[cfg(windows)]`
// 编译门控（platform/mod.rs）外，测试面显式追加 `#[cfg(windows)]` 自包含
// 门控（ubuntu CI 不编译不运行；防止模块级门控被误删后 .bat 脚本在 unix
// spawn 下必失败）。
#[cfg(windows)]
#[cfg(test)]
mod tests {
    use crate::browser::platform::{new_killer, spawn_command};
    use std::path::PathBuf;

    /// 构造 .bat 假浏览器脚本（常驻循环）。
    fn fake_browser_script(dir: &std::path::Path, name: &str) -> PathBuf {
        let p = dir.join(name);
        let content = "@echo off\r\n:loop\r\nping -n 2 127.0.0.1 >nul\r\ngoto loop\r\n";
        std::fs::write(&p, content).expect("写入脚本");
        p
    }

    /// Job 杀树：spawn 假进程（CREATE_SUSPENDED）→ attach → kill_tree → 进程消失。
    /// Windows Job Object 语义依赖（本文件仅 windows 编译）：
    /// TerminateJobObject 终结整棵树后，进程对象仍有内核回收窗口，
    /// is_pid_alive 短暂为真属正常 → 以轮询等待取代单点断言。
    /// 豁免 clippy 子进程禁令：测试拉起假浏览器脚本，进程生命周期由测试自身
    /// 托管（attach/杀树/收尸全在用例内闭环），非脱离会话存活的未注册进程。
    #[allow(clippy::disallowed_methods)]
    #[tokio::test]
    async fn job_kill_tree_terminates() {
        let dir = tempfile::tempdir().expect("临时目录");
        let script = fake_browser_script(dir.path(), "fake_browser.bat");
        let mut cmd = spawn_command(&script);
        cmd.stdout(std::process::Stdio::null());
        cmd.stderr(std::process::Stdio::null());
        let mut child = cmd.spawn().expect("spawn");
        let pid = child.id().expect("pid");
        let mut killer = new_killer();
        if killer.attach(&mut child).is_ok() {
            // 挂接成功：Job 杀树（TerminateJobObject 整树终结）
            killer.kill_tree().expect("杀树");
        } else {
            // 挂接失败（CI 受限 Job 环境）：降级路径 = kill_sync taskkill /T /F
            killer.kill_sync(pid);
        }
        // 回收等待 + 补杀：kill 后进程对象偶发短暂存活（回收竞态），等待窗口内
        // 允许 is_pid_alive 为真（每 100ms 重试）；单轮 5s 未消失 → 补杀（至多 3 轮）。
        for attempt in 0..3 {
            if wait_pid_reaped(pid, 5_000).await.0 {
                break;
            }
            tracing::warn!("杀树后 PID {pid} 仍存活（第 {attempt} 次补杀）");
            if let Err(e) = killer.kill_tree() {
                killer.kill_sync(pid);
                tracing::warn!("补杀失败：{e}，已再走 kill_sync");
            }
            tokio::time::sleep(std::time::Duration::from_millis(200)).await;
        }
        // 等待收尸（防僵尸）：窗口放宽至 30s（高负载下退出传播/句柄回收延迟）
        let _ = tokio::time::timeout(std::time::Duration::from_secs(30), child.wait())
            .await
            .expect("等待退出超时（30s）")
            .expect("wait 失败");
        // 最终断言：长等待窗口（环境可注入）内进程对象必须消失
        let window = kill_timeout_ms();
        let (reaped, elapsed) = wait_pid_reaped(pid, window).await;
        assert!(
            reaped,
            "进程树应被终结（PID {pid}，等待窗口 {window}ms，仍存活 {elapsed:?}）"
        );
    }

    /// 等待窗口（ms）：环境注入 `CONEX_BROWSER_TEST_KILL_TIMEOUT_MS`，CI/高负载
    /// 下可调大（默认 30s），避免单机正常但 CI 偶发。
    fn kill_timeout_ms() -> u64 {
        std::env::var("CONEX_BROWSER_TEST_KILL_TIMEOUT_MS")
            .ok()
            .and_then(|v| v.parse().ok())
            .unwrap_or(30_000)
    }

    /// 异步轮询等待 PID 进程对象回收：等待窗口内 is_pid_alive 短暂为真属
    /// 回收竞态（允许重试），返回（是否已消失, 实际耗时）。
    async fn wait_pid_reaped(pid: u32, window_ms: u64) -> (bool, std::time::Duration) {
        let start = std::time::Instant::now();
        let deadline = std::time::Duration::from_millis(window_ms);
        loop {
            if !crate::browser::profile::is_pid_alive(pid) {
                return (true, start.elapsed());
            }
            if start.elapsed() >= deadline {
                return (false, start.elapsed());
            }
            tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        }
    }
}
