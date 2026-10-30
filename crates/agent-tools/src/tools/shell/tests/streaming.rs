use super::super::*;
use super::{ctx, tool};
use crate::context::ToolContext;
use crate::streaming::{ToolProgress, ToolStream, ToolStreamItem};
use conex_test_utils::TempWorkspace;
use futures_util::StreamExt;
use serde_json::json;

/// 平台无关大输出命令（写 N 个字符到 stdout，单行）
fn big_output_cmd(ch: char, count: usize) -> String {
    if cfg!(windows) {
        format!("'{}' * {count}", ch)
    } else {
        format!("printf '{ch}%.0s' {{1..{count}}}")
    }
}

/// 任务卡验收：窗口内完成的命令 stdout/stderr/exitCode 与改造前逐字节一致
#[tokio::test]
async fn shell_streaming_preserves_sync_semantics() {
    let ws = TempWorkspace::new("shell_stream_sync");
    let t = tool();
    let command = if cfg!(windows) {
        "Write-Output stream-out-abc; [Console]::Error.WriteLine('stream-err-xyz'); exit 7"
    } else {
        "echo stream-out-abc; echo stream-err-xyz >&2; exit 7"
    };
    let out = t
        .execute(&ctx(&ws), json!({ "command": command }))
        .await
        .unwrap();
    assert_eq!(out["timedOut"], false);
    assert_eq!(out["exitCode"], 7, "退出码与改造前一致");
    assert_eq!(
        out["stdout"].as_str().unwrap().trim_end(),
        "stream-out-abc",
        "stdout 与改造前逐字节一致"
    );
    // stderr 断言用包含而非逐字节：Windows PowerShell 5.1 首启会在
    // stderr 混入 CLIXML 进度记录（"正在准备首次使用模块"），改造前后
    // 行为一致（wait_with_output 同样收集），非流式化回归
    assert!(
        out["stderr"].as_str().unwrap().contains("stream-err-xyz"),
        "stderr 必须包含预期输出：{}",
        out["stderr"].as_str().unwrap()
    );
    assert!(out["text"].as_str().unwrap().contains("stream-out-abc"));
    assert!(out["text"].as_str().unwrap().contains("(exit 7)"));
}

/// 任务卡验收：stdout 写 1MB 的命令 30s 内完成且输出完整
/// （流式读取解决 wait_with_output 收口下 64KB 管道写满阻塞）
#[tokio::test]
async fn shell_streaming_no_pipe_deadlock() {
    let ws = TempWorkspace::new("shell_stream_deadlock");
    let t = tool();
    let command = big_output_cmd('x', 1_048_576);
    let out = t
        .execute(
            &ctx(&ws),
            json!({ "command": command, "timeoutMs": 30000, "maxOutputBytes": 1200000 }),
        )
        .await
        .unwrap();
    assert_eq!(
        out["timedOut"], false,
        "1MB 输出不得 30s 内超时（管道写满死锁）"
    );
    assert_eq!(out["truncated"], false);
    let stdout = out["stdout"].as_str().unwrap();
    assert_eq!(
        stdout.chars().filter(|c| *c == 'x').count(),
        1_048_576,
        "1MB 输出必须完整（流式读取持续消费）"
    );
    let duration = out["durationMs"].as_u64().unwrap();
    assert!(duration < 30_000, "30s 内完成，实际 {duration}ms");
}

// ===== S1：流式执行（TOOLS-01 §3.1.6，A3 交付）=====

/// 收集流式全部项直到 Terminal：返回 (Progress 序列, Terminal 结果)。
/// 断言流不变式：Terminal 恒为末项，其后不得再有项。
async fn collect_stream(
    stream: ToolStream,
) -> (Vec<ToolStreamItem>, Result<serde_json::Value, ToolError>) {
    let mut progress = Vec::new();
    let mut terminal = None;
    let mut stream = stream;
    while let Some(item) = stream.next().await {
        if item.is_terminal() {
            terminal = Some(item);
            break;
        }
        progress.push(item);
    }
    assert!(stream.next().await.is_none(), "Terminal 后不得再有项");
    match terminal {
        Some(ToolStreamItem::Terminal(r)) => (progress, r),
        _ => panic!("流必须产出恰好一个 Terminal"),
    }
}

/// 平台无关「分时多块输出」命令：每块输出后睡眠，保证管道内块不合并
/// （逐块到达断言的前提）
fn chunked_output_cmd() -> String {
    if cfg!(windows) {
        "1..3 | ForEach-Object { Write-Output \"chunk-$_\"; Start-Sleep -Milliseconds 200 }"
            .to_string()
    } else {
        "for i in 1 2 3; do echo chunk-$i; sleep 0.2; done".to_string()
    }
}

/// S1 验收（§3.1.8 流式输出逐块到达）：mock 进程分时输出多块——每块
/// 独立 ToolProgress::Text 到达（块间 200ms 间隔 + fill_buf 阻塞读，
/// 保证块不合并），全部 Progress 在 Terminal 前，Terminal stdout 为
/// 全量拼接
#[tokio::test]
async fn stream_yields_progress_chunks_then_terminal() {
    let ws = TempWorkspace::new("shell_stream_chunks");
    let t = tool();
    let ctx = ctx(&ws);
    let stream = t
        .execute_stream(&ctx, json!({ "command": chunked_output_cmd() }))
        .await;
    let (progress, terminal) = collect_stream(stream).await;
    let out = terminal.expect("流式执行不得失败");
    assert_eq!(out["timedOut"], false);
    assert_eq!(out["exitCode"], 0);
    assert_eq!(out["truncated"], false);
    // 至少 2 块：块间 200ms 间隔 + 逐帧阻塞读，正常 3 块；极端负载
    // 下相邻块可能合并，2 块断言保留容错余量（拼接内容仍须完整）
    assert!(
        progress.len() >= 2,
        "多块输出应逐块到达（独立 Progress），实际 {} 块",
        progress.len()
    );
    let joined: String = progress
        .iter()
        .filter_map(|p| match p {
            ToolStreamItem::Progress(ToolProgress::Text { text }) => Some(text.as_str()),
            _ => None,
        })
        .collect();
    for marker in ["chunk-1", "chunk-2", "chunk-3"] {
        assert!(joined.contains(marker), "进度拼接须含 {marker}：{joined:?}");
    }
    let stdout = out["stdout"].as_str().unwrap();
    assert_eq!(
        stdout.trim_end().lines().count(),
        3,
        "Terminal stdout 为全量拼接：{stdout:?}"
    );
}

/// S1 验收（§3.1.8 一致性回归）：同命令 execute / execute_stream 的
/// 聚合结果逐字节一致（stdout/stderr/text/exitCode/timedOut/truncated/
/// command/shell；durationMs 为执行时序差异，排除比较）
#[tokio::test]
async fn stream_terminal_matches_execute_bytewise() {
    let ws = TempWorkspace::new("shell_stream_parity");
    let t = tool();
    let ctx = ctx(&ws);
    let command = if cfg!(windows) {
        "Write-Output parity-out; [Console]::Error.WriteLine('parity-err'); exit 9"
    } else {
        "echo parity-out; echo parity-err >&2; exit 9"
    };
    let args = json!({ "command": command });
    let legacy = t.execute(&ctx, args.clone()).await.unwrap();
    let (_, terminal) = collect_stream(t.execute_stream(&ctx, args).await).await;
    let out = terminal.expect("流式执行不得失败");
    for key in [
        "command",
        "shell",
        "stdout",
        "stderr",
        "text",
        "exitCode",
        "timedOut",
        "truncated",
        "mode",
    ] {
        assert_eq!(out[key], legacy[key], "字段 {key} 须与 execute 一致");
    }
}

/// S1 验收（§3.1.6 累计预算）：maxOutputBytes 升级为累计流式字节预算——
/// 超限实时停止推送（已推字节 ≤ 预算），结果仍标记 truncated（头尾
/// 预览 + 截断标记，与 execute 一致）；管道持续排空（不超时不失败）
#[tokio::test]
async fn stream_budget_stops_progress_and_marks_truncation() {
    let ws = TempWorkspace::new("shell_stream_budget");
    let t = tool();
    let ctx = ToolContext {
        log_root: Some(ws.path().join("logs")),
        ..ctx(&ws)
    };
    let args = json!({ "command": big_output_cmd('q', 1_048_576), "timeoutMs": 30000, "maxOutputBytes": 2048 });
    let legacy = t.execute(&ctx, args.clone()).await.unwrap();
    assert_eq!(legacy["truncated"], true, "前置：execute 路径应判定截断");
    let (progress, terminal) = collect_stream(t.execute_stream(&ctx, args).await).await;
    let out = terminal.expect("流式执行不得失败");
    // 预算实时截断：已推字节 ≤ 预算（严格），超限后不再推送
    let pushed: usize = progress
        .iter()
        .map(|p| match p {
            ToolStreamItem::Progress(ToolProgress::Text { text }) => text.len(),
            _ => 0,
        })
        .sum();
    assert!(pushed <= 2048, "已推字节不得超过预算：{pushed}");
    // 截断标记 + 排空语义：结果截断、无超时、与 execute 逐字节一致
    assert_eq!(out["truncated"], true, "结果须标记 truncation");
    assert_eq!(
        out["timedOut"], false,
        "预算截断不得触发超时（管道持续排空）"
    );
    assert!(out["stdout"]
        .as_str()
        .unwrap()
        .contains("[output truncated"));
    for key in ["stdout", "stderr", "exitCode", "timedOut", "truncated"] {
        assert_eq!(out[key], legacy[key], "字段 {key} 须与 execute 一致");
    }
}

/// S1 验收（§3.1.8 abort）：执行前已 abort → 零 Progress，尽快收口为
/// Terminal（已聚合结果），流不悬挂
#[tokio::test]
async fn stream_abort_before_start_terminates_promptly() {
    let ws = TempWorkspace::new("shell_stream_abort_pre");
    let t = tool();
    let ctx = ctx(&ws);
    ctx.abort_token.abort();
    let stream = t
        .execute_stream(&ctx, json!({ "command": "echo never-seen" }))
        .await;
    let (progress, terminal) = collect_stream(stream).await;
    assert_eq!(progress.len(), 0, "启动前已 abort 不得产出 Progress");
    match terminal {
        Ok(out) => {
            assert_eq!(out["aborted"], true, "结果须标记 aborted");
            assert_eq!(out["timedOut"], false);
        }
        Err(e) => panic!("abort 正常收口不得为 Err：{e}"),
    }
}

/// S1 验收（§3.1.8 abort）：执行中 abort（子进程睡眠 3s，第 1 帧后 abort）
/// → 尽快杀进程收口为 Terminal，流不悬挂（耗时远小于 3s）
#[tokio::test]
async fn stream_abort_midflight_kills_and_terminates() {
    let ws = TempWorkspace::new("shell_stream_abort_mid");
    let t = tool();
    let ctx = ctx(&ws);
    let command = if cfg!(windows) {
        "Write-Output first; Start-Sleep -Seconds 3"
    } else {
        "echo first; sleep 3"
    };
    let mut stream = t.execute_stream(&ctx, json!({ "command": command })).await;
    let first = stream.next().await.expect("第一帧应到达");
    assert!(
        matches!(first, ToolStreamItem::Progress(_)),
        "第一帧应为 Progress"
    );
    ctx.abort_token.abort();
    let started = std::time::Instant::now();
    let next = stream.next().await;
    let elapsed = started.elapsed();
    assert!(
        elapsed.as_millis() < 2500,
        "中止后应杀进程尽快收口，实际 {elapsed:?}"
    );
    match next {
        Some(ToolStreamItem::Terminal(r)) => assert!(r.is_ok(), "收口 Terminal 为已聚合结果"),
        Some(_) => panic!("abort 后不得再推 Progress"),
        None => panic!("流必须收口为 Terminal（流不变式）"),
    }
}

/// S1 兼容面：非 sync 模式（auto-background）回落既有 execute——结果
/// 与 execute 逐字节一致（窗口内完成，无 taskId）
#[tokio::test]
async fn stream_non_sync_mode_falls_back_to_execute() {
    let ws = TempWorkspace::new("shell_stream_fallback");
    let t = tool();
    let ctx = ctx(&ws);
    let args = json!({
        "command": if cfg!(windows) { "Write-Output fallback-ok" } else { "echo fallback-ok" },
        "mode": "auto-background",
        "waitMsBeforeAsync": 60000,
    });
    let legacy = t.execute(&ctx, args.clone()).await.unwrap();
    assert_eq!(legacy["timedOut"], false);
    let (_, terminal) = collect_stream(t.execute_stream(&ctx, args).await).await;
    let out = terminal.expect("回落路径不得失败");
    for key in ["stdout", "exitCode", "timedOut", "mode", "text"] {
        assert_eq!(
            out[key], legacy[key],
            "回落路径字段 {key} 须与 execute 一致"
        );
    }
    assert!(out.get("taskId").is_none(), "窗口内完成不得产生 taskId");
}
