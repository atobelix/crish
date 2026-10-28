//! SR-05 · 测试外置 · ≠ EL（background.rs 原 `mod tests` 整体搬移，零删除
//! 零合并；接线：background.rs `#[cfg(test)] #[path = "background_tests.rs"] mod tests;`）。
//! 本文件 = 公共 helper/常量 + 注册表与命令面契约测试；T-AB-09 日志/输入、
//! T-AB-11 kill、T-AB-15/16 资源健康、T-AB-17 事件测试分置
//! background_tests_log/kill/resource/events.rs（#[path] 旁挂，helper 经
//! `use super::tests::*;` 共享）。

// G2 禁令豁免：
// - 测试临时目录清理（非产品删除路径，可恢复语义不适用）；
// - 测试 mod 子进程拉起面：真实 spawn 探测（红线 Blocked 断言 +
//   tasklist / kill -0 存活探测辅助，T-AB-06/07 验收），非产品执行面；
//   测试 mod 内 allow + 理由（裁决 D8 背书）。
#![allow(clippy::disallowed_methods)]
pub(crate) use super::bg_commands::{
    build_list_response, build_output_response, build_send_input_response,
};
pub(crate) use super::bg_events::SamplerFn;
pub(crate) use super::bg_log::{read_meta, strip_log_prefix};
pub(crate) use super::bg_registry::MAX_BACKGROUND_TASKS;
pub(crate) use super::bg_task::task_summary;
use super::*;
pub(crate) use crate::resource::{
    cpu_percent_from_delta, sample_usage, EventSink, RawUsage, ResourceMonitorConfig, TaskNotifier,
};
pub(crate) use agent_tools::background::{
    BackgroundAdoptRequest, BackgroundTaskInfo, BackgroundTaskManager, BackgroundTaskStatus,
    KillResult, TaskState,
};
pub(crate) use conex_run::core_error::CoreError;
pub(crate) use conex_types::error::codes;
pub(crate) use conex_types::events::{AgentEvent, AgentEventEnvelope};
use std::collections::HashSet;
use std::path::Path;
use std::process::Stdio;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;
use tokio::process::Child;

pub(crate) const LONG_COMMAND: &str = if cfg!(windows) {
    "Start-Sleep -Seconds 20"
} else {
    "sleep 20"
};
/// 持续产出输出（~4s，每 100ms 一行；tail 增长断言用）
pub(crate) const OUTPUT_COMMAND: &str = if cfg!(windows) {
    "1..40 | ForEach-Object { Write-Output ('line ' + $_); Start-Sleep -Milliseconds 100 }"
} else {
    "i=0; while [ $i -lt 40 ]; do echo line $i; i=$((i+1)); sleep 0.1; done"
};
/// 快速 1000 行输出命令（T-AB-09 测试用；行内容 "line N"，N=1..1000）
pub(crate) const LOG_COMMAND: &str = if cfg!(windows) {
    "1..1000 | ForEach-Object { 'line ' + $_ }"
} else {
    "seq 1 1000 | sed 's/^/line /'"
};
/// 持续输出命令（~20s；log_preserved_after_kill 用，杀前累积若干行）
pub(crate) const LOG_KILL_COMMAND: &str = if cfg!(windows) {
    "1..200 | ForEach-Object { Write-Output ('k' + $_); Start-Sleep -Milliseconds 100 }"
} else {
    "i=0; while [ $i -lt 200 ]; do echo k$i; i=$((i+1)); sleep 0.1; done"
};
/// 行尾含 [Y/n] 提示的命令（prompt_detected_on_stdout 用）
pub(crate) const PROMPT_OUTPUT_COMMAND: &str = if cfg!(windows) {
    "Write-Output 'Continue? [Y/n]'"
} else {
    "echo 'Continue? [Y/n]'"
};
/// 先输出一行就绪标记再长睡（kill_graceful_path 同步点：转发器
/// 消费到该行即证明子进程已实际开始执行命令——替代固定 sleep，
/// 负载下 spawn 延迟不可控）
pub(crate) const READY_THEN_SLEEP_COMMAND: &str = if cfg!(windows) {
    "Write-Output ready; Start-Sleep -Seconds 20"
} else {
    "echo ready; sleep 20"
};
/// 交互命令：等待 stdin 一行输入后输出 "got=<输入>"（send_input 注入测试用）。
/// 注意：PowerShell Read-Host 在 stdin 重定向时**不会**把提示行写入 stdout
/// 管道（提示写往控制台宿主），故测试不等待提示出现，直接注入（管道缓冲保证
/// 进程启动后仍能收到先行写入的输入）。
pub(crate) const INTERACTIVE_PROMPT_COMMAND: &str = if cfg!(windows) {
    "$r = Read-Host 'Enter y'; Write-Output ('got=' + $r)"
} else {
    "read -p 'Enter y: ' r; echo got=$r"
};
/// Windows stdin 探测脚本（写入临时 .ps1 后以 `-File` 方式 spawn——`-Command`
/// 对花括号脚本有解析怪癖）：读 1 字节，再非阻塞探测（300ms）是否有多余
/// 字节，输出 first=<字节值> extra=0|1（append_newline=false 断言用）。
#[cfg(windows)]
pub(crate) const STDIN_PROBE_SCRIPT: &str = "$stdin = [Console]::OpenStandardInput(); $buf = New-Object byte[] 1; $n = $stdin.Read($buf, 0, 1); if ($n -gt 0) { $peek = New-Object byte[] 1; $task = $stdin.ReadAsync($peek, 0, 1); if ($task.Wait(300)) { Write-Output ('first=' + $buf[0] + ' extra=1') } else { Write-Output ('first=' + $buf[0] + ' extra=0') } } else { Write-Output 'first=eof' }";

/// 测试注册表序号：每个测试独占日志根目录（T-AB-09 落盘后避免并行测试
/// 共享 task-<seq> 路径互相污染）
pub(crate) static TEST_SEQ: AtomicU64 = AtomicU64::new(0);

/// 真实 spawn 测试子进程（kill_on_drop=false + 双管道，对齐 T-AB-02 契约；
/// stdin=null——同步路径语义，send_input 相关测试用 with_stdin 变体）。
pub(crate) fn spawn_test_child(command: &str) -> Child {
    let mut cmd = build_test_command(command);
    cmd.stdin(Stdio::null());
    cmd.spawn().expect("spawn test child")
}

/// 真实 spawn 测试子进程（stdin 走管道——后台托管路径契约：T-AB-10 1）
pub(crate) fn spawn_test_child_with_stdin(command: &str) -> Child {
    let mut cmd = build_test_command(command);
    cmd.stdin(Stdio::piped());
    cmd.spawn().expect("spawn test child with stdin")
}

/// 测试命令构造（PowerShell / bash 平台分支）
fn build_test_command(command: &str) -> tokio::process::Command {
    let mut cmd = if cfg!(windows) {
        let mut c = tokio::process::Command::new("powershell.exe");
        c.args(["-NoProfile", "-Command", command]);
        c
    } else {
        let mut c = tokio::process::Command::new("bash");
        c.args(["-c", command]);
        c
    };
    cmd.stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(false);
    cmd
}

pub(crate) fn test_registry() -> BackgroundTaskRegistry {
    let seq = TEST_SEQ.fetch_add(1, Ordering::Relaxed);
    let root = std::env::temp_dir().join(format!("crish-bg-test-{}-{seq}", std::process::id()));
    // 纯构造（不启动归档线程）：常规测试用 30 分钟保留 + 默认容量，无需
    // 归档循环；归档/容量专项测试显式用 with_log_root/with_config（Arc）
    BackgroundTaskRegistry::construct(root, Duration::from_secs(30 * 60), MAX_BACKGROUND_TASKS)
}

pub(crate) fn adopt_request(
    child: Child,
    command: &str,
    cwd: &Path,
    is_daemon: bool,
    owner_run_id: Option<String>,
) -> BackgroundAdoptRequest {
    BackgroundAdoptRequest {
        child,
        command: command.to_string(),
        cwd: cwd.to_path_buf(),
        is_daemon,
        resource_monitor: false,
        owner_run_id,
    }
}

/// 轮询至终态（窗口内未到则 panic）。
///
/// 窗口取值纪律（负载型 flaky 治理）：本测试二进制每个用例都可能真实
/// spawn PowerShell（启动 1-10s+，全量并行时系统负载放大数倍）——窗口
/// 一律取 30s 以上，宁可失败时多等，不可因负载误报；轮询本身无多余
/// 等待成本（终态早到早返回）。
pub(crate) async fn wait_for_terminal(
    registry: &BackgroundTaskRegistry,
    task_id: &str,
    window: Duration,
) -> BackgroundTaskStatus {
    let deadline = tokio::time::Instant::now() + window;
    loop {
        let status = registry.status(task_id).await.expect("status");
        if BackgroundTaskRegistry::is_terminal(status.status) {
            return status;
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "任务 {task_id} 未在窗口内进入终态：{status:?}"
        );
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

/// 轮询至 tail 非空（输出命令断言用）。
/// 窗口纪律同 wait_for_terminal：30s 起步（PowerShell 冷启动负载放大）。
pub(crate) async fn wait_until_tail_non_empty(
    registry: &BackgroundTaskRegistry,
    task_id: &str,
    window: Duration,
) -> BackgroundTaskStatus {
    let deadline = tokio::time::Instant::now() + window;
    loop {
        let status = registry.status(task_id).await.expect("status");
        if !status.tail.is_empty() {
            return status;
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "任务 {task_id} 迟迟无输出"
        );
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

/// 轮询至 prompt 就位（提示检测断言用；窗口内未到则 panic）。
/// 窗口纪律同 wait_for_terminal：30s 起步（PowerShell 冷启动负载放大）。
pub(crate) async fn wait_for_prompt(
    registry: &BackgroundTaskRegistry,
    task_id: &str,
    window: Duration,
) -> String {
    let deadline = tokio::time::Instant::now() + window;
    loop {
        let status = registry.status(task_id).await.expect("status");
        if let Some(p) = &status.prompt {
            return p.clone();
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "任务 {task_id} 未在窗口内检测到提示"
        );
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

#[cfg(windows)]
pub(crate) fn pid_is_alive(pid: u32) -> bool {
    let out = std::process::Command::new("tasklist")
        .args(["/FI", &format!("PID eq {pid}")])
        .output()
        .expect("tasklist must run");
    String::from_utf8_lossy(&out.stdout).contains(&pid.to_string())
}

#[cfg(not(windows))]
pub(crate) fn pid_is_alive(pid: u32) -> bool {
    std::process::Command::new("kill")
        .args(["-0", &pid.to_string()])
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

#[tokio::test]
async fn registry_adopt_and_list() {
    let registry = test_registry();
    let child = spawn_test_child(LONG_COMMAND);
    let pid = child.id().expect("spawned pid");

    let task_ref = registry
        .adopt(adopt_request(
            child,
            "long-run",
            Path::new("."),
            false,
            None,
        ))
        .await
        .expect("adopt");
    assert!(task_ref.task_id.starts_with("task-"));
    assert!(
        task_ref
            .log_path
            .to_string_lossy()
            .ends_with(&format!("{}.log", task_ref.task_id)),
        "log_path 应为 <log_root>/<task_id>.log"
    );
    assert!(pid_is_alive(pid), "adopt 后进程必须存活");

    let infos = registry.list(false).await.expect("list");
    assert_eq!(infos.len(), 1, "活跃列表应含刚 adopt 的任务");
    assert_eq!(infos[0].task_id, task_ref.task_id);
    assert_eq!(infos[0].status, TaskState::Running);

    let status = registry.status(&task_ref.task_id).await.expect("status");
    assert_eq!(status.status, TaskState::Running);
    assert!(status.tail.is_empty(), "长命令尚未产出输出");

    let _ = crate::process::terminate_process_tree(pid);
}

/// T-AB-07 验收（注册表侧语义）：同步完成的命令即使「迟到 adopt」，状态机
/// 也能正确收敛到 Completed（exit_code=0），不产生 Running 僵尸条目。
/// 「等待窗口内完成不调用 adopt、不产生条目」由 A1 层（T-AB-02）保证——
/// 注册表只在 adopt 被调用时登记。
#[tokio::test]
async fn registry_no_entry_on_sync_complete() {
    let registry = test_registry();
    let child = spawn_test_child("echo sync-done");
    // 等待自然退出后再 adopt（模拟窗口内已完成的命令）
    tokio::time::sleep(Duration::from_millis(700)).await;

    let task_ref = registry
        .adopt(adopt_request(child, "sync", Path::new("."), false, None))
        .await
        .expect("adopt");
    let status = wait_for_terminal(&registry, &task_ref.task_id, Duration::from_secs(30)).await;
    assert_eq!(status.status, TaskState::Completed);
    assert_eq!(status.exit_code, Some(0));
    // 同步命令不应停留在 Running
    let infos = registry.list(false).await.expect("list");
    assert!(
        infos.is_empty(),
        "同步完成的命令不应出现在活跃列表（终态过滤）"
    );
}

/// T-AB-07 验收：自然退出 → Completed（exit 0）／Failed（exit != 0）且
/// exitCode / duration 正确。
#[tokio::test]
async fn registry_state_machine() {
    let registry = test_registry();
    let cwd = std::env::current_dir().expect("cwd");

    // Completed 路径
    let child = spawn_test_child("exit 0");
    let r1 = registry
        .adopt(adopt_request(child, "ok-cmd", &cwd, false, None))
        .await
        .expect("adopt ok");
    let s1 = wait_for_terminal(&registry, &r1.task_id, Duration::from_secs(30)).await;
    assert_eq!(s1.status, TaskState::Completed);
    assert_eq!(s1.exit_code, Some(0));
    // 终态固化：list 快照含 finishedAtMs，且不早于 startedAtMs
    let all = registry.list(true).await.expect("list");
    let fin1 = all
        .iter()
        .find(|i| i.task_id == r1.task_id)
        .expect("完成条目存在");
    let finished1 = fin1.finished_at_ms.expect("终态应有 finishedAtMs");
    assert!(
        finished1 >= fin1.started_at_ms,
        "finishedAtMs 不应早于 startedAtMs"
    );

    // Failed 路径
    let child = spawn_test_child("exit 7");
    let r2 = registry
        .adopt(adopt_request(child, "fail-cmd", &cwd, false, None))
        .await
        .expect("adopt fail");
    let s2 = wait_for_terminal(&registry, &r2.task_id, Duration::from_secs(30)).await;
    assert_eq!(s2.status, TaskState::Failed);
    assert_eq!(s2.exit_code, Some(7));
    let all = registry.list(true).await.expect("list");
    let fin2 = all
        .iter()
        .find(|i| i.task_id == r2.task_id)
        .expect("失败条目存在");
    assert!(
        fin2.finished_at_ms.is_some(),
        "Failed 终态同样固化 finishedAtMs"
    );
    assert!(
        fin2.duration_ms > 0,
        "Failed 计时合理（exit 7 经 wait 收口）"
    );
}

/// T-AB-07 验收：任务 id 唯一且带 task- 前缀（命名空间独立于 pty id）。
#[tokio::test]
async fn task_ids_are_unique_and_prefixed() {
    let registry = test_registry();
    let mut seen = HashSet::new();
    for i in 0..3 {
        let child = spawn_test_child(LONG_COMMAND);
        let pid = child.id().expect("spawned pid");
        let task_ref = registry
            .adopt(adopt_request(
                child,
                &format!("cmd-{i}"),
                Path::new("."),
                false,
                None,
            ))
            .await
            .expect("adopt");
        assert!(
            task_ref.task_id.starts_with("task-"),
            "id 格式: {}",
            task_ref.task_id
        );
        assert!(
            seen.insert(task_ref.task_id.clone()),
            "重复 task id: {}",
            task_ref.task_id
        );
        let _ = crate::process::terminate_process_tree(pid);
    }
    assert_eq!(seen.len(), 3, "连续 adopt 不得产生重复 id");
}

/// 方法结构化错误契约（T-AB-09/10/11 实装后占位语义更新）：
/// - 未知 id → NotFound（read_log / send_input / kill 三方法一致）；
/// - read_log 已知 id → 实装（空输出任务返回空切片）；
/// - send_input 已知 id 但 spawn 未开 stdin 管道 → stdin_closed（分类错误）；
/// - kill 已知 id → 两阶段终止实装（Killed，T-AB-11）。
#[tokio::test]
async fn registry_methods_error_contract() {
    let registry = test_registry();
    let cwd = std::env::current_dir().expect("cwd");

    // 未知 id → NotFound（不静默返回空值）
    let err = registry
        .read_log("task-nope", None, 100)
        .await
        .expect_err("read_log");
    assert_eq!(err.code(), codes::TOOL_NOT_FOUND);
    let err = registry
        .send_input("task-nope", "hi", true)
        .await
        .expect_err("send_input");
    assert_eq!(err.code(), codes::TOOL_NOT_FOUND);
    let err = registry.kill("task-nope").await.expect_err("kill");
    assert_eq!(err.code(), codes::TOOL_NOT_FOUND);

    // 已知 id：read_log 已实装；send_input 未接管道 → stdin_closed；kill 实装
    let child = spawn_test_child(LONG_COMMAND);
    let r = registry
        .adopt(adopt_request(child, "placeholder", &cwd, false, None))
        .await
        .expect("adopt");

    let slice = registry
        .read_log(&r.task_id, None, 100)
        .await
        .expect("read_log 已实装");
    assert_eq!(slice.task_id, r.task_id);
    assert!(
        slice.lines.is_empty(),
        "尚未输出的任务日志为空切片（total={}）",
        slice.total_lines
    );

    let err = registry
        .send_input(&r.task_id, "hi", true)
        .await
        .expect_err("null stdin");
    assert_eq!(err.code(), codes::TOOL_EXECUTION_FAILED);
    assert!(
        err.to_string().contains("stdin_closed"),
        "send_input 失败应分类为 stdin_closed：{err}"
    );

    // kill 实装：两阶段终止 → Killed（进程终止，无需再外部树杀）
    let result = registry.kill(&r.task_id).await.expect("kill 已实装");
    assert!(
        matches!(result, KillResult::Killed { .. }),
        "运行中任务 kill 应返回 Killed，实际 {result:?}"
    );
    let status = registry.status(&r.task_id).await.expect("status");
    assert_eq!(
        status.status,
        TaskState::Killed,
        "kill 后状态机应翻转为 Killed"
    );
}

/// T-AB-08 验收：list 契约——`{ tasks: [...] }`，每条含 taskId/command/
/// startedAt/duration/status/logPath（命令直调，构造 registry 即构造 State）。
#[tokio::test]
async fn workbench_list_background_tasks_contract() {
    let registry = test_registry();
    let child = spawn_test_child(LONG_COMMAND);
    let pid = child.id().expect("spawned pid");
    registry
        .adopt(adopt_request(
            child,
            "list-contract",
            Path::new("."),
            false,
            None,
        ))
        .await
        .expect("adopt");

    let response = build_list_response(&registry)
        .await
        .expect("build_list_response");
    let json = serde_json::to_value(&response).expect("serialize");
    assert!(json.get("tasks").is_some(), "响应必须含 tasks 数组");
    let tasks = json["tasks"].as_array().expect("tasks 数组");
    assert_eq!(tasks.len(), 1, "应恰有 1 条任务");

    let task = &tasks[0];
    for key in [
        "taskId",
        "command",
        "startedAt",
        "duration",
        "status",
        "logPath",
    ] {
        assert!(task.get(key).is_some(), "列表条目缺字段 {key}: {task}");
    }
    assert_eq!(task["status"], "running", "运行中任务 status=running");
    assert_eq!(task["command"], "list-contract");
    assert!(
        task["startedAt"].as_u64().unwrap() > 0,
        "startedAt 为毫秒时间戳"
    );

    let _ = crate::process::terminate_process_tree(pid);
}

/// T-AB-08 验收：get_output 契约——运行中任务返回非空 tail 且随输出增长；
/// 未知 taskId → NotFound 风格错误（结构化，非 null 非静默）。
#[tokio::test]
async fn workbench_get_background_task_output_contract() {
    let registry = test_registry();
    // 用 20s 持续输出命令（而非 ~4s 的 OUTPUT_COMMAND）：增长断言要求两次
    // 读取都落在任务存活期——负载下任务可能早于第二次读取自然完成
    // （line_count 停止增长）而误报
    let child = spawn_test_child(LOG_KILL_COMMAND);
    let pid = child.id().expect("spawned pid");
    let r = registry
        .adopt(adopt_request(
            child,
            "output-contract",
            Path::new("."),
            false,
            None,
        ))
        .await
        .expect("adopt");

    let first = wait_until_tail_non_empty(&registry, &r.task_id, Duration::from_secs(60)).await;
    assert!(!first.tail.is_empty(), "运行中任务 tail 必须非空");
    let first_lines = first.line_count;
    assert!(first_lines > 0, "行计数应 > 0");

    // 输出随运行增长
    tokio::time::sleep(Duration::from_millis(700)).await;
    let second = registry.status(&r.task_id).await.expect("status");
    assert!(
        second.line_count > first_lines,
        "输出应随运行增长：{first_lines} -> {}",
        second.line_count
    );

    // output 字段（前端 parseBackgroundTaskOutput 直通取 output）
    let response = build_output_response(&registry, &r.task_id)
        .await
        .expect("build_output_response");
    assert_eq!(response.output, second.tail, "output 应等于最新 tail");
    let json = serde_json::to_value(&response).expect("serialize");
    assert_eq!(json["output"], second.tail, "wire 面 output 直通");
    assert_eq!(json["taskId"], r.task_id);

    // 未知 taskId → NotFound 风格错误
    let err = build_output_response(&registry, "task-999999")
        .await
        .expect_err("unknown id");
    assert!(
        matches!(err, CoreError::NotFound(_)),
        "未知 taskId 应返回 NotFound，实际 {err:?}"
    );

    let _ = crate::process::terminate_process_tree(pid);
}

/// T-AB-08 验收：cancel 契约——未知 → NotFound；运行中 → Killed（T-AB-11
/// 两阶段终止实装，不再 Unsupported）；终态 → AlreadyExited（真实可答，
/// KillResult 形状）。
#[tokio::test]
async fn workbench_cancel_background_task_contract() {
    let registry = test_registry();
    let cwd = std::env::current_dir().expect("cwd");

    // 未知 → NotFound
    let err = registry.kill("task-nope").await.expect_err("kill unknown");
    assert_eq!(err.code(), codes::TOOL_NOT_FOUND);

    // 运行中 → Killed（T-AB-11 两阶段终止）
    let child = spawn_test_child(LONG_COMMAND);
    let r1 = registry
        .adopt(adopt_request(child, "cancel-running", &cwd, false, None))
        .await
        .expect("adopt");
    let result = registry.kill(&r1.task_id).await.expect("kill running");
    assert!(
        matches!(result, KillResult::Killed { .. }),
        "运行中任务 kill 应返回 Killed，实际 {result:?}"
    );

    // 终态 → AlreadyExited（KillResult 形状）
    let child = spawn_test_child("exit 0");
    let r2 = registry
        .adopt(adopt_request(child, "cancel-finished", &cwd, false, None))
        .await
        .expect("adopt");
    let _ = wait_for_terminal(&registry, &r2.task_id, Duration::from_secs(30)).await;
    let result = registry.kill(&r2.task_id).await.expect("kill terminal");
    match result {
        KillResult::AlreadyExited { task_id, exit_code } => {
            assert_eq!(task_id, r2.task_id);
            assert_eq!(exit_code, Some(0));
        }
        other => panic!("终态任务 kill 应返回 AlreadyExited，实际 {other:?}"),
    }
}
