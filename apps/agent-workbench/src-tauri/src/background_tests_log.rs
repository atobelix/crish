//! SR-05 · 测试外置 · ≠ EL（日志域旁挂）：T-AB-09 日志生命周期 +
//! T-AB-10 stdin 注入与提示检测 + T-AB-20 send_input 命令面 +
//! task_summary 摘要模板契约。本文件自 fdb512d4^（拆分前
//! background.rs `mod tests`）原样重建，断言零改动；接线：
//! background.rs `#[cfg(test)] #[path = "background_tests_log.rs"] mod tests_log;`，
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
use std::process::Stdio;
use std::sync::atomic::Ordering;
use std::time::Duration;

/// T-AB-20 验收：send_input 命令面契约（build_send_input_response 直调，
/// 不依赖 Tauri runtime）——未知 → NotFound；运行中 stdin 接通 → 注入成功；
/// 终态 / 未接管道 → stdin_closed 分类错误；append_newline 默认追加换行。
#[tokio::test]
async fn workbench_send_input_contract() {
    let registry = test_registry();
    let cwd = std::env::current_dir().expect("cwd");

    // 未知 → NotFound（tool_err_to_core 保形映射）
    let err = build_send_input_response(&registry, "task-nope", "hi", true)
        .await
        .expect_err("send_input unknown");
    assert!(
        matches!(err, CoreError::NotFound(_)),
        "未知任务应映射为 CoreError::NotFound，实际 {err:?}"
    );

    // 运行中 + stdin 管道接通 → 注入成功（got=<输入> 端到端）
    let child = spawn_test_child_with_stdin(INTERACTIVE_PROMPT_COMMAND);
    let r1 = registry
        .adopt(adopt_request(
            child,
            "send-input-contract",
            &cwd,
            false,
            None,
        ))
        .await
        .expect("adopt");
    build_send_input_response(&registry, &r1.task_id, "y", true)
        .await
        .expect("send_input 注入成功");
    let status = wait_for_terminal(&registry, &r1.task_id, Duration::from_secs(30)).await;
    assert_eq!(status.status, TaskState::Completed);
    assert!(
        status.tail.contains("got=y"),
        "stdin 注入应到达进程（got=y）：{:?}",
        status.tail
    );

    // append_newline=false：不追加换行 → 进程仍在等待输入（Running）
    let child = spawn_test_child_with_stdin(INTERACTIVE_PROMPT_COMMAND);
    let r2 = registry
        .adopt(adopt_request(
            child,
            "send-input-no-newline",
            &cwd,
            false,
            None,
        ))
        .await
        .expect("adopt");
    build_send_input_response(&registry, &r2.task_id, "y", false)
        .await
        .expect("send_input no-newline");
    tokio::time::sleep(Duration::from_millis(300)).await;
    let status = registry.status(&r2.task_id).await.expect("status");
    assert_eq!(
        status.status,
        TaskState::Running,
        "不追加换行时进程应仍在等待输入（Running）"
    );
    let _ = registry.kill(&r2.task_id).await;
}

/// 验收：1000 行输出任务 `read_log(None, 100)` → 返回 901~1000 行且每行完整
/// （完整行边界；total_lines 与 line_count 一致）。
#[tokio::test]
async fn log_write_and_read_tail() {
    let registry = test_registry();
    let child = spawn_test_child(LOG_COMMAND);
    let r = registry
        .adopt(adopt_request(
            child,
            "log-tail",
            Path::new("."),
            false,
            None,
        ))
        .await
        .expect("adopt");
    let status = wait_for_terminal(&registry, &r.task_id, Duration::from_secs(60)).await;
    assert_eq!(status.status, TaskState::Completed);

    let slice = registry
        .read_log(&r.task_id, None, 100)
        .await
        .expect("read_log");
    assert_eq!(slice.task_id, r.task_id);
    assert_eq!(slice.total_lines, 1000, "total_lines 应为文件物理行数");
    assert_eq!(slice.start_line, 901);
    assert_eq!(slice.end_line, 1000);
    assert_eq!(slice.lines.len(), 100);
    assert!(!slice.truncated, "KB 级日志远小于单次读取预算");
    // 每行完整：内容与行号一一对应（去前缀后的原始输出）
    for (idx, line) in slice.lines.iter().enumerate() {
        assert_eq!(
            line,
            &format!("line {}", 901 + idx),
            "第 {} 行内容完整",
            901 + idx
        );
    }
}

/// 验收：`read_log(Some(500), 100)` 返回 500~599 行（500 早于首个 512 行
/// checkpoint → 走索引回退从头扫描路径）；`read_log(Some(600), 50)` 返回
/// 600~649 行（600 晚于首个 checkpoint → 走 checkpoint 二分定位路径）。
#[tokio::test]
async fn log_read_by_line_range() {
    let registry = test_registry();
    let child = spawn_test_child(LOG_COMMAND);
    let r = registry
        .adopt(adopt_request(
            child,
            "log-range",
            Path::new("."),
            false,
            None,
        ))
        .await
        .expect("adopt");
    let _ = wait_for_terminal(&registry, &r.task_id, Duration::from_secs(60)).await;

    let slice = registry
        .read_log(&r.task_id, Some(500), 100)
        .await
        .expect("read_log");
    assert_eq!(slice.start_line, 500);
    assert_eq!(slice.end_line, 599);
    assert_eq!(slice.lines.len(), 100);
    assert_eq!(slice.lines[0], "line 500");
    assert_eq!(slice.lines[99], "line 599");

    let slice = registry
        .read_log(&r.task_id, Some(600), 50)
        .await
        .expect("read_log");
    assert_eq!(slice.start_line, 600);
    assert_eq!(slice.end_line, 649);
    assert_eq!(slice.lines.len(), 50);
    assert_eq!(slice.lines[0], "line 600");
    assert_eq!(slice.lines[49], "line 649");
}

/// 验收：任务被杀后 `.log` 保留且内容完整（read_log 仍可用、行数与文件一致）。
/// 本测试用进程原语 `terminate_process_tree` 直接树杀（外部终止 → 管道 EOF
/// → writer 收尾到终态）；registry.kill 两阶段路径的日志保留语义由
/// T-AB-11 的 `kill_preserves_log` 覆盖。
#[tokio::test]
async fn log_preserved_after_kill() {
    let registry = test_registry();
    let child = spawn_test_child(LOG_KILL_COMMAND);
    let pid = child.id().expect("spawned pid");
    let r = registry
        .adopt(adopt_request(
            child,
            "log-kill",
            Path::new("."),
            false,
            None,
        ))
        .await
        .expect("adopt");
    // 等有输出后外部树杀（进程被杀 → 管道 EOF → writer 收尾到终态）
    let _ = wait_until_tail_non_empty(&registry, &r.task_id, Duration::from_secs(60)).await;
    let _ = crate::process::terminate_process_tree(pid);
    let status = wait_for_terminal(&registry, &r.task_id, Duration::from_secs(30)).await;
    assert!(
        BackgroundTaskRegistry::is_terminal(status.status),
        "树杀后应收敛到终态，实际 {:?}",
        status.status
    );

    // 日志文件仍存在，read_log 可读且行数与文件一致
    let log_path = PathBuf::from(status.log_path);
    assert!(log_path.exists(), "任务终止不得删除 .log");
    // 读取上限取 250 行（LOG_KILL_COMMAND 上限 200 行）：负载下「等首行 →
    // 树杀」间隔可能被放大，杀前累积可能超 100 行——上限低于总行数时
    // 尾部读取返回不全（start_line≠1），曾为负载型 flaky
    let slice = registry
        .read_log(&r.task_id, None, 250)
        .await
        .expect("read_log");
    assert!(slice.total_lines > 0, "被杀前已累积的输出应可读");
    assert_eq!(slice.start_line, 1, "行数少时尾部读取返回全量");
    assert_eq!(slice.lines.len() as u64, slice.total_lines);
    // 与文件物理行数一致（`[out]`/`[err]` 前缀不影响行数）
    let raw = std::fs::read(&log_path).expect("读取日志文件");
    let file_lines = raw.iter().filter(|&&b| b == b'\n').count() as u64;
    assert_eq!(slice.total_lines, file_lines, "内存计数与文件物理行数自洽");
}

/// 验收：终态 status 的 tail/line_count 与文件实际一致（flush 自洽），
/// meta.json 含终态字段（exitCode/finishedAtMs）与 checkpoint。
#[tokio::test]
async fn log_meta_terminal_consistent() {
    let registry = test_registry();
    let child = spawn_test_child(LOG_COMMAND);
    let r = registry
        .adopt(adopt_request(
            child,
            "log-meta",
            Path::new("."),
            false,
            None,
        ))
        .await
        .expect("adopt");
    let status = wait_for_terminal(&registry, &r.task_id, Duration::from_secs(60)).await;
    assert_eq!(status.status, TaskState::Completed);

    let log_path = PathBuf::from(status.log_path);
    let meta_path = log_path.with_extension("meta.json");
    // 文件行数与 status.line_count 一致（状态翻转发生在 writer 全部收尾之后）
    let raw = std::fs::read(&log_path).expect("读取日志文件");
    let file_lines: Vec<String> = String::from_utf8_lossy(&raw)
        .split('\n')
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string())
        .collect();
    assert_eq!(
        file_lines.len() as u64,
        status.line_count,
        "line_count 与文件一致"
    );
    // status.tail（内存预览，无前缀）= 文件末 20 行去前缀后（flush 自洽）
    let tail_stripped: Vec<String> = file_lines
        .iter()
        .rev()
        .take(20)
        .map(|s| strip_log_prefix(s))
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .collect();
    assert_eq!(tail_stripped.join("\n"), status.tail, "tail 与文件一致");

    // meta：终态字段 + 行数 + checkpoint 已落盘
    let meta = read_meta(&meta_path).expect("meta 存在且可解析");
    assert_eq!(meta.task_id, r.task_id);
    assert_eq!(meta.status, "completed");
    assert_eq!(meta.line_count, status.line_count);
    assert_eq!(meta.exit_code, status.exit_code);
    // finished_at 在 status 契约里没有（冻结形状），经 list(true) 快照核对
    let all = registry.list(true).await.expect("list");
    let info_finished = all
        .iter()
        .find(|i| i.task_id == r.task_id)
        .expect("终态条目存在")
        .finished_at_ms;
    assert_eq!(
        meta.finished_at_ms, info_finished,
        "meta 终态时间与内存快照一致"
    );
    assert_eq!(meta.last_output_at_ms, status.last_output_at_ms);
    assert!(!meta.rotated, "小日志不应触发轮转");
    assert!(
        meta.checkpoints.iter().any(|c| c.line == 512),
        "首个 512 行 checkpoint 应已落盘：{:?}",
        meta.checkpoints
    );
    assert!(meta.log_bytes > 0, "meta 记录日志字节数");

    // read_log 的 total_lines 与 status 一致
    let slice = registry
        .read_log(&r.task_id, None, 100)
        .await
        .expect("read_log");
    assert_eq!(slice.total_lines, status.line_count);
    assert_eq!(slice.lines.len(), 100);
    assert_eq!(slice.start_line, status.line_count - 99);
}

/// 验收：摘要模板形状（REQ-A05：`任务 <id> 已运行 <duration>，日志已累积
/// <line_count> 行，最近输出时间 <timestamp>`；R-AB3 唤醒注入消费）。
#[test]
fn task_summary_template() {
    let info = BackgroundTaskInfo {
        task_id: "task-42".to_string(),
        command: "cmd".to_string(),
        cwd: ".".to_string(),
        status: TaskState::Running,
        started_at_ms: 1_000_000,
        duration_ms: 1234,
        finished_at_ms: None,
        exit_code: None,
        log_path: "x.log".to_string(),
        line_count: 77,
        last_output_at_ms: 1_001_000,
        is_daemon: false,
        resource: None,
        prompt: None,
        owner_run_id: None,
        suspicious: false, // 14-T2a wire：默认非疑似
    };
    let s = task_summary(&info, info.duration_ms);
    assert_eq!(
        s,
        "任务 task-42 已运行 1234，日志已累积 77 行，最近输出时间 1001000"
    );
}

/// 验收：stdin 管道化 + 注入——交互程序（Read-Host / read）收到带换行的
/// 输入后继续执行直至完成，输出含收到内容。
#[tokio::test]
async fn send_input_reaches_process() {
    let registry = test_registry();
    let child = spawn_test_child_with_stdin(INTERACTIVE_PROMPT_COMMAND);
    let r = registry
        .adopt(adopt_request(
            child,
            "stdin-interactive",
            Path::new("."),
            false,
            None,
        ))
        .await
        .expect("adopt");

    // 不等待提示出现（Read-Host 在 stdin 重定向时不把提示写进 stdout 管道）；
    // 管道缓冲保证进程启动后仍能收到先行写入的输入
    registry
        .send_input(&r.task_id, "y", true)
        .await
        .expect("send_input 成功");

    let status = wait_for_terminal(&registry, &r.task_id, Duration::from_secs(30)).await;
    assert_eq!(status.status, TaskState::Completed, "收到输入后应正常完成");
    let slice = registry
        .read_log(&r.task_id, None, 10)
        .await
        .expect("read_log");
    let all = slice.lines.join("\n");
    assert!(all.contains("got=y"), "进程应收到输入并继续执行：{all}");
}

/// 验收：输出含行尾 `[Y/n]` 提示 → `status().prompt` 非空且为命中行，
/// meta.json 同步落盘 prompt。
#[tokio::test]
async fn prompt_detected_on_stdout() {
    let registry = test_registry();
    let child = spawn_test_child(PROMPT_OUTPUT_COMMAND);
    let r = registry
        .adopt(adopt_request(
            child,
            "prompt-detect",
            Path::new("."),
            false,
            None,
        ))
        .await
        .expect("adopt");

    let prompt = wait_for_prompt(&registry, &r.task_id, Duration::from_secs(60)).await;
    assert_eq!(prompt, "Continue? [Y/n]", "prompt 内容为命中行");

    // meta 同步落盘
    let status = registry.status(&r.task_id).await.expect("status");
    let meta_path = PathBuf::from(status.log_path).with_extension("meta.json");
    let meta = read_meta(&meta_path).expect("meta 存在且可解析");
    assert_eq!(
        meta.prompt.as_deref(),
        Some("Continue? [Y/n]"),
        "meta 含 prompt"
    );

    let _ = wait_for_terminal(&registry, &r.task_id, Duration::from_secs(30)).await;
}

/// 验收：进程退出后 send_input 返回 stdin_closed 风格错误，且后续调用持续
/// 返回（槽位清空，确定性不依赖 BrokenPipe 时序）。
#[tokio::test]
async fn send_input_after_stdin_closed() {
    let registry = test_registry();
    let child = spawn_test_child_with_stdin("exit 0");
    let r = registry
        .adopt(adopt_request(
            child,
            "stdin-closed",
            Path::new("."),
            false,
            None,
        ))
        .await
        .expect("adopt");
    let _ = wait_for_terminal(&registry, &r.task_id, Duration::from_secs(30)).await;

    let err = registry
        .send_input(&r.task_id, "x", true)
        .await
        .expect_err("stdin 已关闭");
    assert_eq!(err.code(), codes::TOOL_EXECUTION_FAILED);
    assert!(
        err.to_string().contains("stdin_closed"),
        "失败应分类为 stdin_closed：{err}"
    );
    // 后续调用同样返回 stdin_closed（槽位保持清空）
    let err2 = registry
        .send_input(&r.task_id, "x", true)
        .await
        .expect_err("仍关闭");
    assert!(err2.to_string().contains("stdin_closed"));
}

/// 验收：append_newline=false 时输入原样送达（不带换行）。
///
/// 探测程序读 1 字节后非阻塞探测 300ms：若实现错误地追加了换行，探测会
/// 立即读到第 2 字节（extra=1），断言失败。探测脚本写入临时 .ps1 后以
/// `-File` 方式 spawn（`-Command` 对花括号脚本有解析怪癖）。
#[cfg(windows)]
#[tokio::test]
async fn send_input_append_newline_false() {
    let registry = test_registry();
    // 探测脚本（纯 ASCII，std::fs::write 无编码问题）
    let script_path = std::env::temp_dir().join(format!(
        "crish-stdin-probe-{}-{}.ps1",
        std::process::id(),
        TEST_SEQ.fetch_add(1, Ordering::Relaxed)
    ));
    std::fs::write(&script_path, STDIN_PROBE_SCRIPT).expect("写探测脚本");

    let mut cmd = tokio::process::Command::new("powershell.exe");
    cmd.args(["-NoProfile", "-ExecutionPolicy", "Bypass", "-File"])
        .arg(&script_path)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(false);
    let child = cmd.spawn().expect("spawn probe");
    let r = registry
        .adopt(adopt_request(
            child,
            "stdin-no-newline",
            Path::new("."),
            false,
            None,
        ))
        .await
        .expect("adopt");

    // 管道缓冲保证进程启动后仍能收到先行写入的字节
    registry
        .send_input(&r.task_id, "y", false)
        .await
        .expect("send_input");

    // 轮询探测输出（30s 窗口：PowerShell 冷启动在并行负载下可能超 10s）
    let deadline = tokio::time::Instant::now() + Duration::from_secs(30);
    let tail = loop {
        let status = registry.status(&r.task_id).await.expect("status");
        if status.tail.contains("first=") {
            break status.tail;
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "探测程序未输出（stdin 未送达？）"
        );
        tokio::time::sleep(Duration::from_millis(50)).await;
    };
    assert!(
        tail.contains("first=121"),
        "应收到单个 y 字节（121）：{tail}"
    );
    assert!(
        tail.contains("extra=0"),
        "append_newline=false 不得追加换行：{tail}"
    );

    let _ = wait_for_terminal(&registry, &r.task_id, Duration::from_secs(30)).await;
    let _ = std::fs::remove_file(&script_path);
}
