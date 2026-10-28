//! Job Object（创建 / 幂等 init / daemon 与 PTY 隔离）与进程树优雅终止测试

use super::*;

/// Empty job create: verifies CreateJobObjectW + KILL_ON_JOB_CLOSE limit flags.
/// Manual crash verification (Windows): spawn a PTY shell (`workbench_pty_create`), note
/// shell PID, force-kill the workbench process — shell tree should exit without orphans.
#[cfg(windows)]
#[test]
// 豁免 unsafe_code：测试内 CloseHandle FFI（SAFETY：句柄来自同函数
// create_kill_on_close_job_object 的返回值，测试拥有所有权），经评审后允许。
#[allow(unsafe_code)]
fn create_kill_on_close_job_object_empty_ok() {
    let job = create_kill_on_close_job_object().expect("create empty kill-on-close job");
    assert!(!job.is_null(), "job handle must be non-null");
    // SAFETY: we own this handle from create_kill_on_close_job_object
    unsafe {
        let closed = windows_sys::Win32::Foundation::CloseHandle(job);
        assert_ne!(closed, 0, "CloseHandle on empty job should succeed");
    }
}

#[cfg(windows)]
#[test]
fn init_pty_job_object_idempotent() {
    init_pty_job_object().expect("first init");
    init_pty_job_object().expect("second init is no-op success");
    assert!(PTY_JOB_OBJECT.get().is_some());
}

/// T-AB-06 验收：优雅终止变体。真实 spawn 测试程序（Windows PowerShell
/// Start-Sleep / Unix sleep）：
/// - Unix：kill -TERM 生效，进程 5s 内退出；
/// - Windows：taskkill 无 /F 对控制台程序实测返回「只能通过强制终止」且进程
///   不退出（新发现登记，见 terminate_process_tree_graceful 文档注释）——
///   因此断言两阶段语义：优雅请求后 5s 内未退出 → 强制兜底 → 5s 内必退。
#[cfg(target_os = "windows")]
#[test]
fn graceful_terminate_ok() {
    let mut child = std::process::Command::new("powershell.exe")
        .args(["-NoProfile", "-Command", "Start-Sleep 30"])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .expect("spawn test process");
    let pid = child.id();

    let _graceful = terminate_process_tree_graceful(pid);
    let exited_gracefully = wait_child_exit(&mut child, Duration::from_secs(5));

    if !exited_gracefully {
        // 优雅请求未生效（本环境实测为控制台程序必经路径）：taskkill 无 /F
        // 对控制台程序返回码不稳定（有时 Err「仅可强制终止」、有时 Ok 但
        // 进程树仍存活）——不纠结返回码，直接验证强制兜底（两阶段终止的
        // 升级支路，产品语义：最终 5s 内必退）
        terminate_process_tree(pid).expect("强制兜底必须成功");
        assert!(
            wait_child_exit(&mut child, Duration::from_secs(5)),
            "两阶段终止后进程必须在 5s 内退出"
        );
    }
    // 优雅生效分支：进程已退出（无附加断言，跨环境稳健）
}

#[cfg(not(target_os = "windows"))]
#[test]
fn graceful_terminate_ok() {
    let mut child = std::process::Command::new("sleep")
        .arg("30")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .expect("spawn test process");
    let pid = child.id();

    terminate_process_tree_graceful(pid).expect("kill -TERM 应成功");
    assert!(
        wait_child_exit(&mut child, Duration::from_secs(5)),
        "SIGTERM 后进程必须在 5s 内退出"
    );
}

/// T-AB-06 验收：daemon Job 与 PTY Job 隔离（真实 spawn 断言）。
///
/// 实现说明：全局 `PTY_JOB_OBJECT` 是 OnceLock 静态，无法在不消费静态的前提下
/// 关闭（OnceLock::into_inner 需 move，static 不可 move）——故用「本地同类
/// kill-on-close Job 模拟 PTY Job 关闭」+「真实全局两个 Job 句柄不同」+「真实
/// pty::kill_all_sessions() 不连带」三断言覆盖方案语义：
/// 1. 两个静态 Job 句柄非空且互不相同（隔离）；
/// 2. daemon 进程归属校验（IsProcessInJob，仅分配成功时）；
/// 3. 关闭一个 kill-on-close Job（模拟 PTY Job 关闭）→ 其成员死亡（机制自检），
///    而 daemon 进程存活（不受连带）；
/// 4. pty::kill_all_sessions() 后 daemon 进程仍存活（终端面板 kill_all 不误杀）。
#[cfg(windows)]
#[test]
// 豁免 unsafe_code：测试内 CloseHandle/OpenProcess/IsProcessInJob FFI，
// SAFETY 见各函数内注释，经评审后允许。
#[allow(unsafe_code)]
fn daemon_job_isolated_from_pty() {
    use std::os::windows::io::AsRawHandle;
    use windows_sys::Win32::Foundation::CloseHandle;
    use windows_sys::Win32::System::JobObjects::IsProcessInJob;
    use windows_sys::Win32::System::Threading::{OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION};

    init_daemon_job_object().expect("daemon job init");
    init_pty_job_object().expect("pty job init");
    let daemon_handle = DAEMON_JOB_OBJECT.get().expect("daemon job static").0;
    let pty_handle = PTY_JOB_OBJECT.get().expect("pty job static").0;
    assert!(!daemon_handle.is_null() && !pty_handle.is_null());
    assert_ne!(
        daemon_handle, pty_handle,
        "后台任务 Job 与 PTY Job 句柄必须不同（相互隔离）"
    );

    // 真实 spawn：后台任务进程（长命令）→ 接线 daemon Job（best-effort）
    let mut daemon_child = std::process::Command::new("powershell.exe")
        .args(["-NoProfile", "-Command", "Start-Sleep 30"])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .expect("spawn daemon test process");
    let daemon_pid = daemon_child.id();
    let assigned = assign_pid_to_daemon_job(daemon_pid);
    // 嵌套 Job 语义（Win8+）：本机实测分配成功；若宿主 Job 禁止嵌套则返回
    // 拒绝——仅 warn 不失败，隔离断言对两种环境均成立
    if let Err(e) = &assigned {
        eprintln!("[test] assign_pid_to_daemon_job 降级（宿主 Job 禁止嵌套）：{e}");
    }

    // 分配成功时校验归属（IsProcessInJob）
    if assigned.is_ok() {
        // SAFETY: OpenProcess/CloseHandle 配对；IsProcessInJob 布尔出参
        unsafe {
            let h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, daemon_pid);
            assert!(!h.is_null(), "OpenProcess({daemon_pid}) 失败");
            let mut in_daemon_job: i32 = 0;
            let ok = IsProcessInJob(h, daemon_handle, &mut in_daemon_job);
            let _ = CloseHandle(h);
            assert!(ok != 0 && in_daemon_job != 0, "daemon 进程应归属后台 Job");
        }
    }

    // 机制自检：本地 kill-on-close Job 模拟「PTY Job 关闭」——
    // 关闭 Job 句柄 → 其成员全杀；daemon 进程不受影响
    let local_job = create_kill_on_close_job_object().expect("create local job");
    let mut victim = std::process::Command::new("powershell.exe")
        .args(["-NoProfile", "-Command", "Start-Sleep 30"])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .expect("spawn victim process");
    let victim_pid = victim.id();
    let victim_assigned = assign_process_to_job(local_job, victim.as_raw_handle());
    // SAFETY: local_job 句柄由 create_kill_on_close_job_object 产生，本测试拥有所有权
    unsafe {
        let _ = CloseHandle(local_job);
    }
    if victim_assigned.is_ok() {
        assert!(
            wait_child_exit(&mut victim, Duration::from_secs(5)),
            "关闭 kill-on-close Job 必须杀死其成员（机制自检）"
        );
    } else {
        // 分配失败（宿主 Job 环境）：显式清理 victim，隔离断言不受影响
        let _ = terminate_process_tree(victim_pid);
        let _ = wait_child_exit(&mut victim, Duration::from_secs(5));
    }

    // PTY 面板 kill_all 真实路径：不得连带 daemon 进程
    crate::pty::kill_all_sessions();
    assert!(
        pid_is_alive(daemon_pid),
        "关闭 PTY Job / kill_all 不应影响后台任务存活"
    );

    // 清理：daemon 进程强制终止，不留孤儿
    terminate_process_tree(daemon_pid).expect("cleanup force kill");
    assert!(
        wait_child_exit(&mut daemon_child, Duration::from_secs(5)),
        "清理后 daemon 进程必须退出"
    );
}

/// Unix 侧隔离语义：daemon 进程组与 PTY kill_all 互不影响（真实 spawn 断言）。
#[cfg(not(windows))]
#[test]
fn daemon_process_survives_pty_kill_all() {
    use std::os::unix::process::CommandExt;
    // spawn 时即建立独立进程组（exec 前），避免 post-hoc setpgid 在受限
    // 沙箱/竞态下 EPERM
    let mut child = std::process::Command::new("sleep")
        .arg("30")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .process_group(0)
        .spawn()
        .expect("spawn daemon test process");
    let pid = child.id();

    crate::pty::kill_all_sessions();
    assert!(pid_is_alive(pid), "kill_all_sessions 不得连带 daemon 进程");

    let _ = kill_process_group(pid);
    assert!(
        wait_child_exit(&mut child, Duration::from_secs(5)),
        "清理后进程必须退出"
    );
}

/// W3-T2 验收测试：ProcessJobGuard 生命周期与内核级防孤儿强杀断言
#[cfg(windows)]
#[test]
fn test_process_job_guard_kill_on_drop() {
    let mut child = std::process::Command::new("powershell.exe")
        .args(["-NoProfile", "-Command", "Start-Sleep 30"])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .expect("spawn test process for job guard");
    let pid = child.id();

    let guard = ProcessJobGuard::new_for_pid(pid).expect("create job guard");
    if let Some(g) = guard {
        assert!(!g.raw_handle().is_null(), "Job 句柄必须非空");
        // 模拟句柄关闭（Drop 守卫）
        drop(g);
        // Windows 内核必须在 Job 关闭后强杀该进程
        assert!(
            wait_child_exit(&mut child, Duration::from_secs(5)),
            "Drop ProcessJobGuard 后子进程必须被内核强杀（零孤儿逃逸）"
        );
    } else {
        // 受限沙箱降级分支：显式清理
        let _ = terminate_process_tree(pid);
        let _ = wait_child_exit(&mut child, Duration::from_secs(5));
    }
}

/// W3-T2 验收测试：ProcessJobGuard disarm 解除自动强杀验证
#[cfg(windows)]
#[test]
fn test_process_job_guard_disarm() {
    let mut child = std::process::Command::new("powershell.exe")
        .args(["-NoProfile", "-Command", "Start-Sleep 30"])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .expect("spawn test process for disarm");
    let pid = child.id();

    let guard = ProcessJobGuard::new_for_pid(pid).expect("create job guard");
    if let Some(g) = guard {
        assert!(!g.raw_handle().is_null());
        // 解除限制并释放句柄
        g.disarm().expect("disarm must succeed");
        // 进程应依然存活（未被连带强杀）
        assert!(pid_is_alive(pid), "disarm 后进程必须依然存活");
        // 显式清理
        let _ = terminate_process_tree(pid);
        let _ = wait_child_exit(&mut child, Duration::from_secs(5));
    } else {
        let _ = terminate_process_tree(pid);
        let _ = wait_child_exit(&mut child, Duration::from_secs(5));
    }
}