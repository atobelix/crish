//! SR-05 · 测试外置 · ≠ EL（kill 域旁挂）：T-AB-11 两阶段终止 +
//! T-AB-12 终态保留/会话级存活/容量淘汰（任务结束与清理生命周期）。
//! 本文件自 fdb512d4^（拆分前 background.rs `mod tests`）原样重建，
//! 断言零改动；接线：background.rs
//! `#[cfg(test)] #[path = "background_tests_kill.rs"] mod tests_kill;`，
//! helper 经 `use super::tests::*;` 共享（background_tests.rs）。

// G2 禁令豁免：
// - 测试临时目录清理（非产品删除路径，可恢复语义不适用）；
// - 测试 mod 子进程拉起面：真实 spawn 探测（红线 Blocked 断言 +
//   tasklist / kill -0 存活探测辅助，T-AB-06/07 验收），非产品执行面；
//   测试 mod 内 allow + 理由（裁决 D8 背书）。
#![allow(clippy::disallowed_methods)]
use super::tests::*;
use super::*;
use std::path::Path;
use std::path::PathBuf;
use std::sync::atomic::Ordering;
use std::time::Duration;

/// 验收：Start-Sleep 类命令两阶段终止——优雅阶段生效则直接退出
/// （Killed{via_force:false}）；Windows 平台注记（任务书 5 认可，本机
/// 实测）：taskkill 无 /F 对控制台程序（powershell/cmd）必返回「只能强制
/// 终止」——优雅请求必然未生效 → 跳过 5s 等待直接升级（Killed{via_force:true}）。
/// 断言基准为「两阶段路径可执行」而非「优雅一定成功」。
#[tokio::test]
async fn kill_graceful_path() {
    let registry = test_registry();
    // ready-then-sleep：等就绪行被转发器消费 = 子进程已开始执行命令
    // （真实同步点；固定 sleep 在负载下可能不足，kill 与进程启动
    // 竞态 → flaky）
    let child = spawn_test_child(READY_THEN_SLEEP_COMMAND);
    let r = registry
        .adopt(adopt_request(
            child,
            "kill-graceful",
            Path::new("."),
            false,
            None,
        ))
        .await
        .expect("adopt");
    let deadline = tokio::time::Instant::now() + Duration::from_secs(8);
    loop {
        let status = registry.status(&r.task_id).await.expect("status");
        if status.line_count > 0 {
            break;
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "就绪行迟迟未被消费（子进程未就绪）"
        );
        tokio::time::sleep(Duration::from_millis(100)).await;
    }

    let started = tokio::time::Instant::now();
    let result = registry.kill(&r.task_id).await.expect("kill");
    let elapsed = started.elapsed();
    // 并行测试环境下 Windows taskkill /T（优雅）可能返回 Ok 但信号无效 →
    // 等满 5s 窗口后升级；预留任务系统负载余量，12s 上限仍远小于
    // 优雅+强制两个完整窗口之和（10s）之外的无界等待
    assert!(
        elapsed < Duration::from_secs(12),
        "两阶段终止不应无界阻塞：{elapsed:?}"
    );

    let via_force = match result {
        KillResult::Killed { task_id, via_force } => {
            assert_eq!(task_id, r.task_id);
            via_force
        }
        other => panic!("运行中任务 kill 应返回 Killed，实际 {other:?}"),
    };
    #[cfg(not(windows))]
    assert!(
        !via_force,
        "Unix 优雅路径应直接生效（SIGTERM → sleep 退出）"
    );
    #[cfg(windows)]
    assert!(
        via_force,
        "Windows 控制台进程优雅必然未生效 → 应升级强制（本机实测口径）"
    );

    // 状态机联动：status 翻转为 Killed；finished_at 落内存快照（list 面）
    let status = registry.status(&r.task_id).await.expect("status");
    assert_eq!(
        status.status,
        TaskState::Killed,
        "kill 后状态应翻转为 Killed"
    );
    let all = registry.list(true).await.expect("list");
    let info = all
        .iter()
        .find(|i| i.task_id == r.task_id)
        .expect("任务仍可查询（未归档）");
    assert!(
        info.finished_at_ms.is_some(),
        "kill 成功应固化 finished_at（归档计时起点）"
    );
    // 诊断留痕：优雅请求已发送（两阶段路径真实执行）
    assert!(
        status
            .termination_diagnostics
            .iter()
            .any(|d| d.contains("优雅终止请求已发送")),
        "diagnostics 应含优雅留痕：{:?}",
        status.termination_diagnostics
    );
}

/// 验收：忽略优雅信号的程序 → 两阶段升级 → Killed{via_force:true} 且
/// diagnostics 含升级留痕。
///
/// Windows：控制台循环程序优雅必然未生效 → 升级 /F /T → 确定性
/// Killed{via_force:true}。
/// Unix 平台限制（诚实边界）：process.rs 的强制原语与优雅同为 SIGTERM
/// （无 SIGKILL 升级项），忽略 TERM 的进程两阶段均无效 → 等待窗口耗尽 →
/// Failed（升级已尝试，diagnostics 留痕完整）。
#[cfg(windows)]
#[tokio::test]
async fn kill_force_escalation() {
    let registry = test_registry();
    let command = if cfg!(windows) {
        "while ($true) { Start-Sleep -Milliseconds 50 }"
    } else {
        "trap '' TERM; while true; do sleep 1; done"
    };
    let child = spawn_test_child(command);
    let r = registry
        .adopt(adopt_request(
            child,
            "kill-force",
            Path::new("."),
            false,
            None,
        ))
        .await
        .expect("adopt");
    tokio::time::sleep(Duration::from_millis(300)).await;

    let result = registry.kill(&r.task_id).await.expect("kill");
    #[cfg(windows)]
    match result {
        KillResult::Killed { task_id, via_force } => {
            assert_eq!(task_id, r.task_id);
            assert!(via_force, "忽略优雅的程序必须经升级强制路径");
        }
        other => panic!("Windows 升级路径应返回 Killed{{via_force:true}}，实际 {other:?}"),
    }
    #[cfg(not(windows))]
    assert!(
        matches!(result, KillResult::Failed { .. }),
        "Unix 无 SIGKILL 升级原语，忽略 TERM 进程应 Failed，实际 {result:?}"
    );

    // diagnostics 两阶段留痕：优雅发送 + 强制升级（原因）
    let status = registry.status(&r.task_id).await.expect("status");
    let diag = &status.termination_diagnostics;
    assert!(
        diag.iter().any(|d| d.contains("优雅终止请求已发送")),
        "diagnostics 应含优雅留痕：{diag:?}"
    );
    assert!(
        diag.iter().any(|d| d.contains("强制终止升级")),
        "diagnostics 应含升级留痕：{diag:?}"
    );
    #[cfg(windows)]
    assert_eq!(status.status, TaskState::Killed);
}

/// 验收：自然退出后的任务 kill → AlreadyExited 携带自然退出码（0 与 7
/// 两态），不强行升级。
#[tokio::test]
async fn kill_already_exited() {
    let registry = test_registry();
    let cwd = std::env::current_dir().expect("cwd");

    // exit 0
    let child = spawn_test_child("exit 0");
    let r1 = registry
        .adopt(adopt_request(child, "kill-exited-0", &cwd, false, None))
        .await
        .expect("adopt");
    let _ = wait_for_terminal(&registry, &r1.task_id, Duration::from_secs(30)).await;
    match registry.kill(&r1.task_id).await.expect("kill") {
        KillResult::AlreadyExited { task_id, exit_code } => {
            assert_eq!(task_id, r1.task_id);
            assert_eq!(exit_code, Some(0), "exit 0 任务的自然退出码应透传");
        }
        other => panic!("终态任务 kill 应返回 AlreadyExited，实际 {other:?}"),
    }

    // exit 7
    let child = spawn_test_child("exit 7");
    let r2 = registry
        .adopt(adopt_request(child, "kill-exited-7", &cwd, false, None))
        .await
        .expect("adopt");
    let _ = wait_for_terminal(&registry, &r2.task_id, Duration::from_secs(30)).await;
    match registry.kill(&r2.task_id).await.expect("kill") {
        KillResult::AlreadyExited { task_id, exit_code } => {
            assert_eq!(task_id, r2.task_id);
            assert_eq!(exit_code, Some(7), "exit 7 任务的自然退出码应透传");
        }
        other => panic!("终态任务 kill 应返回 AlreadyExited，实际 {other:?}"),
    }
}

/// 验收：kill 后 `.log` 保留且 read_log 仍可用（T-AB-09 保留语义在
/// kill 路径不回归）。
#[tokio::test]
async fn kill_preserves_log() {
    let registry = test_registry();
    let child = spawn_test_child(LOG_KILL_COMMAND);
    let r = registry
        .adopt(adopt_request(
            child,
            "kill-log",
            Path::new("."),
            false,
            None,
        ))
        .await
        .expect("adopt");
    // 等有输出后 kill（两阶段终止路径）
    let _ = wait_until_tail_non_empty(&registry, &r.task_id, Duration::from_secs(60)).await;
    let result = registry.kill(&r.task_id).await.expect("kill");
    assert!(
        matches!(result, KillResult::Killed { .. }),
        "运行中任务 kill 应返回 Killed，实际 {result:?}"
    );

    let status = registry.status(&r.task_id).await.expect("status");
    assert_eq!(status.status, TaskState::Killed);
    let log_path = PathBuf::from(status.log_path);
    assert!(log_path.exists(), "kill 后 .log 必须保留");
    let slice = registry
        .read_log(&r.task_id, None, 100)
        .await
        .expect("kill 后 read_log 仍可用");
    assert!(slice.total_lines > 0, "kill 前累积的输出应可读");
    assert!(!slice.lines.is_empty(), "日志内容完整可读");
}

/// 验收：任务归档后 kill → NotFound 风格错误，消息附「日志文件仍在」可恢复
/// 指引（.log 保留语义在 kill 路径与归档路径一致）。
///
/// 命令带一行输出：`.log` 文件在首行输出时创建（无输出的任务不落盘，
/// 归档指引断言的前提是日志文件真实存在）。
#[tokio::test]
async fn kill_after_archived_not_found() {
    let seq = TEST_SEQ.fetch_add(1, Ordering::Relaxed);
    let root = std::env::temp_dir().join(format!(
        "crish-bg-kill-archived-{}-{seq}",
        std::process::id()
    ));
    let registry = BackgroundTaskRegistry::with_log_root(root, Duration::from_secs(5));
    let command = if cfg!(windows) {
        "Write-Output 'archived-task'; exit 0"
    } else {
        "echo archived-task; exit 0"
    };
    let child = spawn_test_child(command);
    let r = registry
        .adopt(adopt_request(
            child,
            "kill-archived",
            Path::new("."),
            false,
            None,
        ))
        .await
        .expect("adopt");
    let _ = wait_for_terminal(&registry, &r.task_id, Duration::from_secs(30)).await;
    // 等 5s 保留期过 → 归档清扫（睡眠取 5.6s，负载下留 600ms 余量；
    // 窗口只须大于保留期，「等更久」方向安全）
    tokio::time::sleep(Duration::from_millis(5600)).await;
    let archived = registry.archive_expired();
    assert_eq!(archived, 1, "5s 保留到期应归档 1 条");

    let err = registry.kill(&r.task_id).await.expect_err("kill archived");
    assert_eq!(err.code(), codes::TOOL_NOT_FOUND);
    assert!(
        err.to_string().contains("日志文件仍在"),
        "归档后 NotFound 应附可恢复指引：{err}"
    );
}

/// 验收：注入 2s 保留时长 → 终态任务到期归档：list 过滤（内存条目清除）、
/// status NotFound 附归档指引、.log 保留、.meta.json 清理。
///
/// 命令带一行输出：`.log` 文件在首行输出时创建（归档指引与 .log 保留断言
/// 的前提是日志文件真实存在）。
#[tokio::test]
async fn retention_archives_finished() {
    let seq = TEST_SEQ.fetch_add(1, Ordering::Relaxed);
    let root =
        std::env::temp_dir().join(format!("crish-bg-retention-{}-{seq}", std::process::id()));
    let registry = BackgroundTaskRegistry::with_log_root(root, Duration::from_secs(5));
    let command = if cfg!(windows) {
        "Write-Output 'retained-task'; exit 0"
    } else {
        "echo retained-task; exit 0"
    };
    let child = spawn_test_child(command);
    let r = registry
        .adopt(adopt_request(
            child,
            "retention-task",
            Path::new("."),
            false,
            None,
        ))
        .await
        .expect("adopt");
    let status = wait_for_terminal(&registry, &r.task_id, Duration::from_secs(30)).await;
    let log_path = PathBuf::from(status.log_path);
    let meta_path = log_path.with_extension("meta.json");
    assert!(log_path.exists(), "终态任务日志存在（任务有输出）");

    // 保留期内（未过期）：任务仍可查询（list(true) 含 / status 可答）。
    // 保留期 5s：给「终态翻转 → 首次 list」之间的调度停顿留出余量
    // （list 带惰性归档清扫，停顿超保留期会误归档而误报）
    let all = registry.list(true).await.expect("list");
    assert!(
        all.iter().any(|i| i.task_id == r.task_id),
        "保留期内终态任务仍应可查询（终态保留语义）"
    );

    // 5s 保留期过后：归档清扫（睡眠 5.6s，留 600ms 余量）
    tokio::time::sleep(Duration::from_millis(5600)).await;
    let archived = registry.archive_expired();
    assert_eq!(archived, 1, "到期终态条目应被归档");

    // list 惰性过滤：内存条目已清
    let all = registry.list(true).await.expect("list");
    assert!(
        !all.iter().any(|i| i.task_id == r.task_id),
        "归档后 list 不得含该任务"
    );
    // status → NotFound 附归档指引
    let err = registry
        .status(&r.task_id)
        .await
        .expect_err("status archived");
    assert_eq!(err.code(), codes::TOOL_NOT_FOUND);
    assert!(
        err.to_string().contains("日志文件仍在"),
        "归档 NotFound 应附可恢复指引：{err}"
    );
    // read_log 同样 NotFound（附指引）
    let err2 = registry
        .read_log(&r.task_id, None, 10)
        .await
        .expect_err("read_log archived");
    assert_eq!(err2.code(), codes::TOOL_NOT_FOUND);
    // .log 保留、.meta.json 清理
    assert!(log_path.exists(), "归档只清内存与 meta，.log 必须保留");
    assert!(!meta_path.exists(), "归档应清理 .meta.json");
}

/// 验收（会话级存活契约锚定）：run 终态收口**不清理 registry**——终态与
/// 运行中任务在「模拟 run 终态」后均仍可查询。
///
/// 只读验证（run loop 收口现位于 `conex-run` run 域）：drive_run_loop
/// 收口无 registry 清理调用；registry 自身
/// 不存在「run 级清理」入口（唯一终止入口为单任务 kill）。本测试锚定
/// registry 侧行为：终态任务不因 run 结束被回收。
#[tokio::test]
async fn run_end_keeps_tasks() {
    let registry = test_registry();

    // 运行中任务（会话级存活：run 收口不回收）
    let child = spawn_test_child(LONG_COMMAND);
    let r1 = registry
        .adopt(adopt_request(
            child,
            "run-alive",
            Path::new("."),
            true,
            None,
        ))
        .await
        .expect("adopt");
    // 已完成任务
    let child = spawn_test_child("exit 0");
    let r2 = registry
        .adopt(adopt_request(
            child,
            "run-finished",
            Path::new("."),
            false,
            None,
        ))
        .await
        .expect("adopt");
    let _ = wait_for_terminal(&registry, &r2.task_id, Duration::from_secs(30)).await;

    // 模拟 run 终态收口：registry 无 run 级清理入口——「什么都不做」即契约
    let all = registry.list(true).await.expect("list");
    assert!(
        all.iter()
            .any(|i| i.task_id == r1.task_id && i.status == TaskState::Running),
        "运行中任务在 run 终态后必须仍可查询"
    );
    assert!(
        all.iter()
            .any(|i| i.task_id == r2.task_id && BackgroundTaskRegistry::is_terminal(i.status)),
        "终态任务在 run 终态后必须仍可查询（终态保留语义）"
    );
    let s1 = registry.status(&r1.task_id).await.expect("status r1");
    assert_eq!(s1.status, TaskState::Running);
    let s2 = registry.status(&r2.task_id).await.expect("status r2");
    assert!(BackgroundTaskRegistry::is_terminal(s2.status));

    // 清理
    let _ = registry.kill(&r1.task_id).await;
}

/// 验收（会话级存活契约锚定）：core_cancel_run 不级联杀任务（默认不联动，
/// 职责单一）。无法直接驱动 core_cancel_run（需 CoreRunState 全量装配，
/// 属 `conex-run` run 域，本测试不装配 CoreRunState），按任务书替代方案：
/// 「registry 清理函数不存在/不级联杀」的结构断言 + 进程存活最小断言。
///
/// 结构断言（只读验证，回报说明）：BackgroundTaskManager 唯一终止入口为
/// 单任务 `kill(task_id)`（crates/agent-tools/src/background.rs:51），无
/// run 级/批量级联终止方法；adopt 的 is_daemon 仅作审计与过滤标记，不参与
/// 终止决策。
#[tokio::test]
async fn cancel_run_keeps_tasks() {
    let registry = test_registry();
    let child = spawn_test_child(LONG_COMMAND);
    let pid = child.id().expect("spawned pid");
    let r = registry
        .adopt(adopt_request(
            child,
            "cancel-run-task",
            Path::new("."),
            true,
            None,
        ))
        .await
        .expect("adopt");
    // 进程存活最小断言：adopt 不终止进程；registry 无级联终止路径
    assert!(pid_is_alive(pid), "adopt 后任务进程必须存活");
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert!(pid_is_alive(pid), "无级联终止路径时任务进程持续存活");

    // 清理
    let _ = registry.kill(&r.task_id).await;
}

/// 验收：注册表条目上限（可注入，生产默认 200）——FIFO 淘汰最旧条目；
/// 淘汰时若仍在运行先终止（force 树杀）；被淘汰条目 .log 保留。
///
/// 两个场景：A) 运行中淘汰（硬兜底路径：先终止再移除）——用持续输出命令
/// 保证被淘汰条目已有 `.log` 文件（无输出的任务不落盘）；B) 终态淘汰
/// （仅内存+meta 清理）。
#[tokio::test]
async fn registry_capacity_evicts() {
    // 场景 A：cap=3，4 个长运行任务 → 最旧者被淘汰且其进程被终止
    let seq = TEST_SEQ.fetch_add(1, Ordering::Relaxed);
    let root_a = std::env::temp_dir().join(format!("crish-bg-cap-a-{}-{seq}", std::process::id()));
    let registry_a =
        BackgroundTaskRegistry::with_config(root_a.clone(), Duration::from_secs(30 * 60), 3);
    let mut ids = Vec::new();
    let mut pid_first = None;
    for i in 0..4 {
        let child = spawn_test_child(OUTPUT_COMMAND);
        let pid = child.id().expect("spawned pid");
        if i == 0 {
            pid_first = Some(pid);
        }
        let r = registry_a
            .adopt(adopt_request(
                child,
                &format!("cap-run-{i}"),
                Path::new("."),
                false,
                None,
            ))
            .await
            .expect("adopt");
        // 首条等待输出落盘（被淘汰条目的 .log 保留断言前提；等待期间
        // 条目数 1 ≤ 3，不会触发淘汰）。窗口 60s：PowerShell 冷启动在
        // 并行负载下可能数十秒（曾为负载型 flaky 现场）
        if i == 0 {
            let _ =
                wait_until_tail_non_empty(&registry_a, &r.task_id, Duration::from_secs(60)).await;
        }
        ids.push(r.task_id);
    }
    // 第 4 个 adopt 触发淘汰（4 条 > 3 上限）：最旧（cap-run-0）被淘汰
    let all = registry_a.list(true).await.expect("list");
    assert_eq!(all.len(), 3, "淘汰后应剩 3 条");
    assert!(
        !all.iter().any(|i| i.task_id == ids[0]),
        "最旧条目 cap-run-0 应被 FIFO 淘汰"
    );
    let pid0 = pid_first.expect("首条 pid");
    // taskkill 返回后进程可能尚在消亡中：轮询等待退出（3s 窗口）
    let kill_deadline = tokio::time::Instant::now() + Duration::from_secs(3);
    loop {
        if !pid_is_alive(pid0) {
            break;
        }
        assert!(
            tokio::time::Instant::now() < kill_deadline,
            "运行中淘汰应先终止进程（pid={pid0}）"
        );
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    // 被淘汰条目 .log 保留（OUTPUT_COMMAND 首行输出已落盘）
    let log0 = root_a.join(format!("{}.log", ids[0]));
    assert!(log0.exists(), "容量淘汰不得删除 .log");
    // 剩余条目仍可查询（未被误淘汰）：断言对象是「条目未被淘汰」而非
    // 运行状态——负载下后三条可能已自然完成（OUTPUT_COMMAND 约 4s），
    // 自然完成的条目同样不应被误淘汰，仍可 status 查询
    for id in &ids[1..] {
        let s = registry_a.status(id).await.expect("status");
        assert_eq!(s.task_id, *id, "{id} 不应被淘汰");
        assert!(
            BackgroundTaskRegistry::is_terminal(s.status) || s.status == TaskState::Running,
            "{id} 状态应合法（Running 或自然终态）：{:?}",
            s.status
        );
    }
    // 清理：kill 剩余 3 条（可能已自然完成 → AlreadyExited，无妨）
    for id in &ids[1..] {
        let _ = registry_a.kill(id).await;
    }

    // 场景 B：cap=3，逐条 adopt 快速完成任务（每条先等其终态）→ 第 4 条
    // adopt 时最旧终态条目被淘汰（is_running=false 分支：仅清内存与 meta）
    let seq = TEST_SEQ.fetch_add(1, Ordering::Relaxed);
    let root_b = std::env::temp_dir().join(format!("crish-bg-cap-b-{}-{seq}", std::process::id()));
    let registry_b =
        BackgroundTaskRegistry::with_config(root_b.clone(), Duration::from_secs(30 * 60), 3);
    let done_command = if cfg!(windows) {
        "Write-Output 'cap-done'; exit 0"
    } else {
        "echo cap-done; exit 0"
    };
    let mut ids_b = Vec::new();
    for i in 0..4 {
        let child = spawn_test_child(done_command);
        let r = registry_b
            .adopt(adopt_request(
                child,
                &format!("cap-done-{i}"),
                Path::new("."),
                false,
                None,
            ))
            .await
            .expect("adopt");
        // 等终态后再 adopt 下一条（保证淘汰对象为终态条目）
        let _ = wait_for_terminal(&registry_b, &r.task_id, Duration::from_secs(30)).await;
        ids_b.push(r.task_id);
    }
    let all = registry_b.list(true).await.expect("list");
    assert_eq!(all.len(), 3, "终态条目淘汰后应剩 3 条");
    assert!(
        !all.iter().any(|i| i.task_id == ids_b[0]),
        "最旧终态条目 cap-done-0 应被淘汰"
    );
    // 被淘汰条目：.log 保留、.meta.json 清理、status NotFound
    let log0 = root_b.join(format!("{}.log", ids_b[0]));
    let meta0 = root_b.join(format!("{}.meta.json", ids_b[0]));
    assert!(log0.exists(), "终态淘汰不得删除 .log");
    assert!(!meta0.exists(), "终态淘汰应清理 .meta.json");
    let err = registry_b
        .status(&ids_b[0])
        .await
        .expect_err("status evicted");
    assert_eq!(err.code(), codes::TOOL_NOT_FOUND);
    // 剩余终态条目仍可查询
    for id in &ids_b[1..] {
        let s = registry_b.status(id).await.expect("status");
        assert!(
            BackgroundTaskRegistry::is_terminal(s.status),
            "{id} 仍可查询"
        );
    }
}
