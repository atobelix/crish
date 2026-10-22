use super::*;

/// 评审 F1 加固（32 评审 F1 高 flake 清单）：进程存活探测以「PID + 创建
/// 时间 + 退出码」三因子判定——taskkill 成功后进程对象可能因句柄未关而
/// 短暂存留（OpenProcess 仍可成功），退出码区分「仍在运行（STILL_ACTIVE）」
/// 与「已终止待回收」；创建时间排除 PID 复用误判（驱动自愈不断派生新进程）。
#[allow(unsafe_code)]
fn process_creation_time(pid: u32) -> Option<u64> {
    use windows_sys::Win32::Foundation::CloseHandle;
    use windows_sys::Win32::System::Threading::{
        GetProcessTimes, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION,
    };
    // SAFETY：OpenProcess/GetProcessTimes/CloseHandle 标准 API；句柄用完
    // 即关；取不到（进程已消失/权限拒绝）一律返回 None，错误路径不 panic
    unsafe {
        let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
        if handle.is_null() {
            return None;
        }
        let mut created = std::mem::zeroed::<windows_sys::Win32::Foundation::FILETIME>();
        let mut exit = std::mem::zeroed::<windows_sys::Win32::Foundation::FILETIME>();
        let mut kernel = std::mem::zeroed::<windows_sys::Win32::Foundation::FILETIME>();
        let mut user = std::mem::zeroed::<windows_sys::Win32::Foundation::FILETIME>();
        let ok = GetProcessTimes(handle, &mut created, &mut exit, &mut kernel, &mut user) != 0;
        CloseHandle(handle);
        if !ok {
            return None;
        }
        Some(((created.dwHighDateTime as u64) << 32) | created.dwLowDateTime as u64)
    }
}

/// 进程状态探测：None = 进程对象已消失；Some(StillRunning) = 正在运行；
/// Some(Terminated(code)) = 已终止但对象未回收（句柄存留）。
#[allow(unsafe_code)]
fn process_state(pid: u32) -> Option<Result<u32, ()>> {
    use windows_sys::Win32::Foundation::CloseHandle;
    use windows_sys::Win32::System::Threading::{
        GetExitCodeProcess, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION,
    };
    // SAFETY：标准 API；句柄用完即关；错误路径不 panic
    unsafe {
        let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
        if handle.is_null() {
            return None;
        }
        let mut code: u32 = 0;
        let ok = GetExitCodeProcess(handle, &mut code) != 0;
        CloseHandle(handle);
        if !ok {
            return None;
        }
        if code == 259 {
            Some(Err(())) // STILL_ACTIVE
        } else {
            Some(Ok(code))
        }
    }
}

/// 评审 F6 回归（31-评审-接线与集成）：Drop 时 inner 锁被其他线程持有
/// （try_lock 失败短窗）——旧实现静默跳过杀树导致浏览器进程泄漏；现实现
/// spawn 阻塞兜底线程收尸（锁释放后立即 kill_sync）。预占锁后 Drop 管理器，
/// 释放锁 → 兜底线程收尸 → 进程必须终结。
///
/// 评审 F1 加固：并行 harness 负载下（驱动崩溃自愈持续派生新进程，Windows
/// PID 分配器复用模式下新进程可能复用刚释放的 PID）纯 PID 存活探测会把
/// 复用进程误判为原进程仍存活（窗口放大反而提高误判率）——改用「创建
/// 时间 + 退出码」三因子判定：创建时间不一致 = PID 已复用（原进程已死）；
/// GetExitCodeProcess 区分 STILL_ACTIVE（仍在运行）与已终止待回收对象。
#[tokio::test]
async fn drop_kills_via_fallback_when_inner_locked() {
    let Some(h) = Harness::new() else { return };
    let cfg = h.config(&script_ok());
    let mgr = h.manager.clone();
    let _ = mgr.start(cfg).await.expect("启动");
    let pid = mgr
        .inner
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .last_pid
        .expect("启动后必有 pid");
    // 记录原进程创建时间（PID 复用判定基准）
    let creation = process_creation_time(pid).expect("启动后进程必存在");
    // 预占锁：模拟极端竞争窗口（其他线程持锁期间 Drop 发生）
    let held = Arc::clone(&mgr.inner);
    let guard = held.lock().unwrap_or_else(|p| p.into_inner());
    drop(mgr); // try_lock 失败 → spawn 兜底线程
    drop(guard); // 释放锁 → 兜底线程收尸
                 // 轮询等待进程终结（kill_sync 内部已带 2s 回收等待；轮询兜底调度竞态；
                 // 窗口 25s：并行 harness 负载下 taskkill 排队可致单点等待超时，32 评审
                 // F1/F2 窗口放大建议）。判定：仅当「创建时间一致且 STILL_ACTIVE」
                 // 才视为原进程仍在——排除 PID 复用与已终止对象存留两种误判。
    let deadline = std::time::Instant::now() + Duration::from_secs(25);
    while std::time::Instant::now() < deadline {
        let alive = process_creation_time(pid).is_some_and(|t| t == creation)
            && process_state(pid) == Some(Err(()));
        if !alive {
            // 收尾：显式停止（driver 可能已把被杀判定为崩溃并重启新进程，
            // stop(Force) 置意图让驱动收敛，防测试残留僵尸进程）
            let _ = h.manager.stop(StopReason::Force).await;
            return;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    panic!("Drop 兜底杀树未生效（PID {pid} 仍存活）");
}

/// 回归（F6 修复暴露的停止信号竞态）：崩溃自愈的 relaunch 窗口内调用
/// stop() 必须收敛——旧实现 watch 信号发往无接收者的旧通道即丢失（驱动
/// 处于退避/重启/启动轮询中，新 stop_rx 未挂接），驱动永不收敛、
/// stop() 永久挂死（drop_kills 测试实测 90s+）；现实现 PortReady 后
/// 复查 pending_stop，stop() 有界返回（本用例任意交错时序均收敛，
/// 未修复实现下 10s 超时即失败）。
#[tokio::test]
async fn stop_during_crash_relaunch_converges() {
    let Some(h) = Harness::new() else { return };
    let cfg = h.config(&script_crash());
    let mgr = h.manager.clone();
    let mut rx = mgr.subscribe();
    let _ = mgr.start(cfg).await.expect("启动");
    // 等首个 CrashRestarting 事件（崩溃已检测，驱动进入退避/重启窗口）
    let deadline = std::time::Instant::now() + Duration::from_secs(20);
    loop {
        let remaining = deadline.saturating_duration_since(std::time::Instant::now());
        let ev = tokio::time::timeout(remaining, rx.recv())
            .await
            .expect("等待崩溃事件超时")
            .expect("通道关闭");
        if matches!(ev, ProcessEvent::CrashRestarting { .. }) {
            break;
        }
    }
    // 略过退避（60ms），让 stop() 落在 launch_with_retries 的 relaunch 窗口
    tokio::time::sleep(Duration::from_millis(150)).await;
    // 修复语义：stop() 有界收敛（旧实现此窗口内停止信号丢失 → 永久挂死）
    let stop = tokio::time::timeout(Duration::from_secs(10), mgr.stop(StopReason::Force))
        .await
        .expect("stop() 必须在 relaunch 窗口内有界收敛（停止信号不得丢失）")
        .expect("停止失败");
    assert!(matches!(stop.state, BrowserState::Stopped));
    assert_eq!(mgr.status().state, BrowserState::Stopped);
}

/// 等待终态事件（Stopped + error 含 "panic"；M5 回归共用，事件等待替代
/// 裸 sleep——事件由 on_driver_panic 在全部收敛动作完成后广播，收到即
/// 一切就绪，无竞态）。
async fn wait_terminal_panic_event(rx: &mut broadcast::Receiver<ProcessEvent>) -> String {
    tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            let ev = rx.recv().await.expect("通道关闭");
            if let ProcessEvent::StateChanged {
                state: BrowserState::Stopped,
                error: Some(e),
                ..
            } = ev
            {
                return e;
            }
        }
    })
    .await
    .expect("等待终态事件超时（驱动 panic 未广播终态）")
}

/// M5 回归（评审 29 §M5）：驱动任务**启动路径** panic（PreReady 注入）。
/// 旧实现：panic 后状态卡死非 Stopped、driver 句柄残留、stop() 报告错误
/// 状态、后续 start() 幂等分支永久返回陈旧报告。新实现（catch_unwind
/// 外包）：状态可达终态 Stopped、终态事件已广播（error 带 panic 原因）、
/// stop() 有界收敛（10s 超时上限，旧实现此场景 stop() 挂死）、后续
/// start() 可重新启动（可恢复性）。
#[tokio::test]
async fn driver_panic_before_ready_converges_and_recovers() {
    let Some(h) = Harness::new() else { return };
    let cfg = h.config(&script_ok());
    let mgr = h.manager.clone();
    mgr.inject_driver_panic(DriverPanicPoint::PreReady);
    let mut rx = mgr.subscribe();
    // first_tx 随 panic unwind 丢弃 → 通道断开 → start() 返回内部错误
    let err = mgr
        .start(cfg.clone())
        .await
        .expect_err("驱动 panic 后 start() 必须返回错误");
    assert!(matches!(err, ProcessError::Internal(_)), "{err:?}");
    // 终态事件已广播（reason=panic）
    let terminal = wait_terminal_panic_event(&mut rx).await;
    assert!(
        terminal.contains("panic"),
        "终态事件必须带 panic 原因：{terminal}"
    );
    // 状态可达终态
    assert_eq!(mgr.status().state, BrowserState::Stopped);
    // stop() 有界收敛（驱动句柄已清，不得永久 await）
    let stop = tokio::time::timeout(Duration::from_secs(10), mgr.stop(StopReason::Force))
        .await
        .expect("stop() 必须在驱动 panic 后有界收敛（不得永久 await）")
        .expect("停止失败");
    assert!(matches!(stop.state, BrowserState::Stopped));
    // 可恢复性：panic 收敛后重新启动成功
    let report = mgr.start(cfg).await.expect("驱动 panic 后必须可重新启动");
    assert!(matches!(report.state, BrowserState::Running));
    mgr.stop(StopReason::Force).await.expect("停止");
}

/// M5 回归（评审 29 §M5）：驱动任务**运行期** panic（PostReady 注入）。
/// 此刻浏览器进程已派生（假浏览器常驻）、endpoint/last_pid/stop_tx 全部
/// 就绪：panic 后必须 ① 兜底杀树（驱动栈 killer 已随 unwind 丢失，按
/// last_pid 终结，防孤儿进程泄漏）② 端点/句柄清理 ③ 终态收敛 + 广播
/// ④ 可重新启动。进程终结判定复用 F1 三因子（创建时间 + STILL_ACTIVE），
/// 排除并行负载下 PID 复用误判；进程对象已回收（创建时间不可见）视为
/// 已终结。
#[tokio::test]
async fn driver_panic_after_ready_converges_and_kills() {
    let Some(h) = Harness::new() else { return };
    let cfg = h.config(&script_ok());
    let mgr = h.manager.clone();
    mgr.inject_driver_panic(DriverPanicPoint::PostReady);
    let mut rx = mgr.subscribe();
    // first_tx 先于注入点送达 → start() 正常返回 Running
    let report = mgr
        .start(cfg.clone())
        .await
        .expect("启动（注入点在首启报告送达之后）");
    assert!(matches!(report.state, BrowserState::Running));
    // 终态事件已广播（处理器先杀树→收敛→清残留→再广播，事件到达即就绪）
    let terminal = wait_terminal_panic_event(&mut rx).await;
    assert!(
        terminal.contains("panic"),
        "终态事件必须带 panic 原因：{terminal}"
    );
    // 注入点记录的进程 PID（panic 前落盘，事件到达后读取无竞态）
    let pid = mgr
        .inner
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .panic_probe_pid
        .expect("PostReady 注入必须记录进程 PID");
    // 兜底杀树生效：进程不得仍存活（F1 三因子；已回收视为已终结）
    let creation = process_creation_time(pid);
    let deadline = std::time::Instant::now() + Duration::from_secs(10);
    loop {
        let alive = creation.is_some_and(|t| process_creation_time(pid) == Some(t))
            && process_state(pid) == Some(Err(()));
        if !alive {
            break;
        }
        assert!(
            std::time::Instant::now() < deadline,
            "驱动 panic 兜底杀树未生效（PID {pid} 仍存活）"
        );
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    // 状态可达终态 + 会话残留清理
    assert_eq!(mgr.status().state, BrowserState::Stopped);
    assert!(
        mgr.endpoint().is_none(),
        "panic 后端点必须清空（私有通道不残留）"
    );
    // stop() 有界收敛（驱动句柄已清，不得永久 await）
    let stop = tokio::time::timeout(Duration::from_secs(10), mgr.stop(StopReason::Force))
        .await
        .expect("stop() 必须在驱动 panic 后有界收敛（不得永久 await）")
        .expect("停止失败");
    assert!(matches!(stop.state, BrowserState::Stopped));
    // 可恢复性：panic 收敛后重新启动成功
    let report2 = mgr.start(cfg).await.expect("驱动 panic 后必须可重新启动");
    assert!(matches!(report2.state, BrowserState::Running));
    mgr.stop(StopReason::Force).await.expect("停止");
}

/// 评审 H6 回归（29-评审-代码质量与安全）：并发 start() 只启动一个浏览器
/// 进程。假浏览器脚本每次被 spawn 向 profile 内追加一行计数（spawn 次数
/// 可证）；双启竞态（旧实现无临界区互斥）下两个 start() 各自建 profile、
/// 各自 spawn 驱动 → 计数 2 且 profile 目录不一致，本用例必失败。
#[tokio::test]
async fn concurrent_start_spawns_single_process() {
    let Some(h) = Harness::new() else { return };
    let script = "\
@echo off\r\n\
setlocal enabledelayedexpansion\r\n\
set PROFILE=\r\n\
set NEXT=0\r\n\
for %%a in (%*) do (\r\n\
\x20 set \"A=%%~a\"\r\n\
\x20 if \"!NEXT!\"==\"1\" (\r\n\
\x20\x20 if not \"!A!\"==\"--user-data-dir\" set \"PROFILE=!A!\"\r\n\
\x20\x20 set \"NEXT=0\"\r\n\
\x20 )\r\n\
\x20 if \"!A:~0,16!\"==\"--user-data-dir=\" set \"PROFILE=!A:~16!\"\r\n\
\x20 if \"!A!\"==\"--user-data-dir\" set \"NEXT=1\"\r\n\
)\r\n\
if not defined PROFILE exit /b 9\r\n\
> \"!PROFILE!\\DevToolsActivePort\" echo 38689\r\n\
>> \"!PROFILE!\\DevToolsActivePort\" echo /devtools/browser/fake-session-uuid\r\n\
>> \"!PROFILE!\\spawn-count.txt\" echo 1\r\n\
:loop\r\n\
ping -n 2 127.0.0.1 >nul\r\n\
goto loop\r\n";
    let cfg = h.config(script);
    let mgr = h.manager.clone();
    // 两个 start() 并发（tokio::join! 同帧启动，强制竞争临界区）
    let (a, b) = tokio::join!(mgr.start(cfg.clone()), mgr.start(cfg));
    let a = a.expect("并发启动 A 应成功");
    let b = b.expect("并发启动 B 应成功（幂等分支返回当前报告）");
    assert!(
        matches!(
            b.state,
            BrowserState::Running | BrowserState::Launching { .. }
        ),
        "幂等报告状态应为运行中/启动中：{:?}",
        b.state
    );
    assert_eq!(
        a.profile_dir, b.profile_dir,
        "并发 start 只允许建一个 profile（双启会各建各的目录）"
    );
    // 计数文件写入晚于 DevToolsActivePort（.bat 顺序写），wait_active_port
    // 在端口文件可见后即返回——并行负载下 .bat 可能被调度打断，计数文件
    // 尚不可读；A3 模式：轮询等待就绪，替代单点断言。
    let deadline = std::time::Instant::now() + Duration::from_secs(10);
    let count = loop {
        match std::fs::read_to_string(a.profile_dir.join("spawn-count.txt")) {
            Ok(s) => break s.lines().count(),
            Err(_) => {
                assert!(
                    std::time::Instant::now() < deadline,
                    "spawn-count.txt 未就绪（启动是否成功？）"
                );
                tokio::time::sleep(Duration::from_millis(25)).await;
            }
        }
    };
    assert_eq!(
        count, 1,
        "并发 start 只允许启动一个浏览器进程（计数 {count}）"
    );
    mgr.stop(StopReason::Force).await.expect("停止");
}
