//! Panic hook 安装。
//!
//! [`install_panic_hook`] / [`install_panic_hook_with_crash_dir`] 注册一个
//! `std::panic::set_hook`，panic 时依次：
//!
//! 1. 提取 panic 载荷、源码位置与当前线程名；
//! 2. 发射结构化 `tracing::error!` 记录（target `panic`，供已安装
//!    subscriber 捕获）；
//! 3. stderr 兜底一行（无 subscriber 的环境仍可见）；
//! 4. **崩溃文件**（PE-04 T04.1-3，仅指定了 `crash_dir` 时）：把现场
//!    （message/location/thread + 多行原文）写入
//!    `crash-YYYYMMDD-HHMMSS-<thread>.log`——独立于轮转日志，崩溃现场
//!    不丢；每次 panic 独立文件、按时间戳区分，天然防覆盖；**不轮转**；
//!    写失败静默忽略（日志可用性不能阻断 panic 处理）；
//! 5. 链式转发前一个 hook（Tauri 等宿主运行时保留自身 panic 行为）。
//!
//! 安装幂等：`OnceLock` 保证进程内只注册一次，重复调用为 no-op。
//!
//! ## 崩溃标记（T5-1b：进程内崩溃台账）
//!
//! 崩溃文件是「死文件」（logDir 仅暴露路径，无人读）。本模块在崩溃文件
//! 写入成功后，把「最后一次崩溃的文件名 + 时刻」记入进程内共享标记
//! （[CRASH_MARKER]），经 [last_crash_marker] 读出——壳层 `core_get_status`
//! 的 `lastCrash` 字段即此读出面，前端心跳轮询时一并读取，把死文件变成
//! 「前端可读的崩溃台账」。**crate 边界**：conex-telemetry 是 leaf crate
//! （lib.rs 头注记：不依赖 tauri / agent-workbench），标记仅用 std 原语，
//! 不引入任何上层依赖；由安装方（壳层 main.rs）与读方（core_query_commands）
//! 各自经本模块的公开访问器触达。

use std::io::Write;
use std::panic;
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};

use tracing::error;

use crate::file::timestamp_key;

/// 确保 hook 进程内只安装一次。
static INSTALLED: OnceLock<()> = OnceLock::new();

/// 最近一次崩溃标记（T5-1b：崩溃台账进程内真源）。
///
/// - 写入侧：panic hook 崩溃文件写成功后（[record_crash_marker]）；
/// - 读取侧：壳层 `core_get_status.lastCrash` 经 [last_crash_marker] 读出；
/// - 语义：仅记录「最后一次」，无历史队列（防膨胀；前端按标记变化感知
///   新增崩溃，不需要历史）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CrashMarker {
    /// 崩溃文件名（`crash-YYYYMMDD-HHMMSS-<thread>.log`，与落盘文件一致）
    pub file_name: String,
    /// 崩溃时刻（epoch ms）
    pub timestamp_ms: u64,
}

/// 共享崩溃标记（std Mutex：panic hook 同步路径写入 / 查询命令读，
/// 均为短临界区；std::sync::Mutex::new 是 const，可作静态项）。
static CRASH_MARKER: Mutex<Option<CrashMarker>> = Mutex::new(None);

/// 记录崩溃标记（panic hook 崩溃文件写成功后调用；锁中毒/写失败静默
/// ——崩溃处理路径不允许二次 panic）。
fn record_crash_marker(file_name: String) {
    let timestamp_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    let _ = CRASH_MARKER.lock().map(|mut slot| {
        *slot = Some(CrashMarker {
            file_name,
            timestamp_ms,
        });
    });
}

/// 读取最近崩溃标记（壳层 `core_get_status.lastCrash` 读出面；进程内
/// 尚无 panic 或未指定崩溃目录时 = None）。
pub fn last_crash_marker() -> Option<CrashMarker> {
    CRASH_MARKER.lock().map(|slot| slot.clone()).unwrap_or(None)
}

/// 清空崩溃标记（测试隔离用；生产路径不调用——崩溃台账是累积事实源）。
pub fn reset_crash_marker() {
    let _ = CRASH_MARKER.lock().map(|mut slot| {
        *slot = None;
    });
}

/// 安装 telemetry panic hook（不带崩溃文件）。
///
/// 等价于 `install_panic_hook_with_crash_dir(None)` 的薄包装。安全地
/// 多次调用；只有首次调用生效。
pub fn install_panic_hook() {
    install_panic_hook_with_crash_dir(None);
}

/// 安装 telemetry panic hook，并可指定崩溃文件目录（T04.1-3）。
///
/// `crash_dir: Some(dir)` 时，panic 现场追加落盘为
/// `crash-YYYYMMDD-HHMMSS-<thread>.log`（线程名非法字符替换为 `_`、
/// 限长 32，防 Windows 文件名非法）。目录不存在时自动创建；创建/写入
/// 失败静默忽略。
///
/// 幂等：只首次调用生效；先调用 [`install_panic_hook`] 再调用本函数
/// （或反之）时，以首次的 `crash_dir` 配置为准。
pub fn install_panic_hook_with_crash_dir(crash_dir: Option<PathBuf>) {
    INSTALLED.get_or_init(|| {
        // 覆盖前捕获既有 hook，便于链式转发。
        // Tauri 等宿主运行时可能依赖自己的 panic 处理。
        let previous = panic::take_hook();

        panic::set_hook(Box::new(move |info| {
            let payload = payload_to_string(info.payload());
            let location = info
                .location()
                .map(|l| format!("{}:{}:{}", l.file(), l.line(), l.column()))
                .unwrap_or_else(|| "<unknown location>".to_string());
            let thread = std::thread::current()
                .name()
                .map(str::to_string)
                .unwrap_or_else(|| "<unnamed>".to_string());

            // 结构化记录：供任何已安装的 subscriber 捕获。
            // 字段名用 `panic_` 前缀（`panic` 是 prelude 宏，`panic.field`
            // 会在 error! 宏解析时触发局部歧义错误）。
            error!(
                target: "panic",
                panic_message = %payload,
                panic_location = %location,
                panic_thread = %thread,
                "panic occurred"
            );

            // stderr 兜底：无 subscriber 时仍可见。
            eprintln!("thread '{}' panicked at {}:\n{}", thread, location, payload);

            // 崩溃文件（T04.1-3）：panic 现场独立落盘 + 崩溃标记（T5-1b：
            // 写成功后把文件名/时刻记入进程内台账，壳层 core_get_status
            // 经 last_crash_marker 读出——死文件变前端可读崩溃台账）。
            if let Some(dir) = &crash_dir {
                if let Some(file_name) = write_crash_file(dir, &payload, &location, &thread) {
                    record_crash_marker(file_name);
                }
            }

            // 最后转发前 hook（可能含 abort 行为）。
            previous(info);
        }));
    });
}

/// 把 panic 现场写入 `crash-YYYYMMDD-HHMMSS-<thread>.log`（UTC 时间戳）。
///
/// 成功时返回崩溃文件名（供 [record_crash_marker] 记入进程内台账）；
/// 写失败返回 None 且静默（含目录不可创建）——崩溃处理路径不允许
/// 二次 panic。
fn write_crash_file(
    dir: &std::path::Path,
    message: &str,
    location: &str,
    thread: &str,
) -> Option<String> {
    if std::fs::create_dir_all(dir).is_err() {
        return None;
    }
    let ts = timestamp_key();
    let safe_thread = sanitize_thread_name(thread);
    let path = dir.join(format!("crash-{}-{}.log", ts, safe_thread));
    let content = format!(
        "Crash report (conex-telemetry)\n\
         timestamp: {ts}\n\
         thread: {thread}\n\
         location: {location}\n\
         panic_message: {message}\n\
         ---\n\
         {message}\n"
    );
    if let Ok(mut f) = std::fs::File::create(&path) {
        if f.write_all(content.as_bytes()).is_ok() && f.flush().is_ok() {
            let file_name = path
                .file_name()
                .map(|n| n.to_string_lossy().into_owned())
                .unwrap_or_else(|| format!("crash-{}-{}.log", ts, safe_thread));
            return Some(file_name);
        }
    }
    None
}

/// 线程名 → 合法文件名片段：非字母数字/`-`/`_` 字符替换为 `_`，限长 32。
fn sanitize_thread_name(name: &str) -> String {
    let cleaned: String = name
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
                c
            } else {
                '_'
            }
        })
        .take(32)
        .collect();
    if cleaned.is_empty() {
        "unnamed".to_string()
    } else {
        cleaned
    }
}

/// 尽力把 panic 载荷提取为可读字符串。
///
/// `PanicInfo::payload()` 是 `&dyn Any`；`panic!` 字符串字面量产生
/// `&'static str`，`panic!(owned_string)` 产生 `String`，其余降级为固定
/// 占位符。
fn payload_to_string(payload: &dyn std::any::Any) -> String {
    if let Some(s) = payload.downcast_ref::<&'static str>() {
        return (*s).to_string();
    }
    if let Some(s) = payload.downcast_ref::<String>() {
        return s.clone();
    }
    "<non-string panic payload>".to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sanitize_thread_name_keeps_safe_chars() {
        assert_eq!(sanitize_thread_name("main"), "main");
        assert_eq!(sanitize_thread_name("worker-1"), "worker-1");
    }

    #[test]
    fn sanitize_thread_name_replaces_invalid_chars() {
        // Windows 文件名非法字符（<>:"/\|?*）与空格统一替换为 '_'
        assert_eq!(sanitize_thread_name("<unnamed>"), "_unnamed_");
        assert_eq!(sanitize_thread_name("a b/c"), "a_b_c");
    }

    #[test]
    fn sanitize_thread_name_truncates_and_falls_back() {
        let long = "x".repeat(64);
        assert_eq!(sanitize_thread_name(&long).len(), 32);
        assert_eq!(sanitize_thread_name(""), "unnamed");
    }

    #[test]
    fn payload_to_string_handles_common_payloads() {
        assert_eq!(payload_to_string(&"literal"), "literal");
        assert_eq!(payload_to_string(&"owned".to_string()), "owned");
        assert_eq!(payload_to_string(&42), "<non-string panic payload>");
    }

    /// T5-1b：崩溃标记写读闭环——record 后 last_crash_marker 可读、
    /// reset 后归 None（进程内崩溃台账的壳层读出面契约）。
    #[test]
    fn crash_marker_record_read_reset_roundtrip() {
        reset_crash_marker();
        assert_eq!(last_crash_marker(), None, "初始无崩溃标记");

        record_crash_marker("crash-20260816-120000-main.log".to_string());
        let marker = last_crash_marker().expect("记录后应可读出");
        assert_eq!(marker.file_name, "crash-20260816-120000-main.log");
        assert!(marker.timestamp_ms > 0, "崩溃时刻必须非零");

        // 再次记录覆盖（最后一次语义）
        record_crash_marker("crash-20260816-120500-worker.log".to_string());
        let marker = last_crash_marker().expect("覆盖后仍可读出");
        assert_eq!(marker.file_name, "crash-20260816-120500-worker.log");

        reset_crash_marker();
        assert_eq!(last_crash_marker(), None, "reset 后归 None（测试隔离）");
    }

    /// T5-1b：write_crash_file 成功返回崩溃文件名（与落盘文件名一致），
    /// 失败返回 None（目录不可创建等写失败静默，不二次 panic）。
    #[test]
    fn write_crash_file_returns_file_name_on_success() {
        let dir = std::env::temp_dir().join(format!(
            "conex_telemetry_crash_{}_{}",
            std::process::id(),
            timestamp_key()
        ));
        let file_name =
            write_crash_file(&dir, "boom", "a.rs:1:1", "main").expect("写崩溃文件应成功");
        assert!(file_name.starts_with("crash-"), "文件名前缀 crash-");
        assert!(file_name.ends_with(".log"), "文件名后缀 .log");
        assert!(dir.join(&file_name).exists(), "文件真实落盘");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// T5-1b：崩溃文件写失败（目录路径为文件而非目录）→ None 且不 panic。
    #[test]
    fn write_crash_file_failure_is_silent_none() {
        // 用「已存在文件」冒充目录：create_dir_all 失败 → 返回 None
        let dir = std::env::temp_dir().join(format!(
            "conex_telemetry_crash_file_{}_{}",
            std::process::id(),
            timestamp_key()
        ));
        std::fs::write(&dir, b"not a dir").expect("预置文件");
        let result = write_crash_file(&dir, "boom", "a.rs:1:1", "main");
        assert_eq!(result, None, "写失败必须静默返回 None");
        let _ = std::fs::remove_file(&dir);
    }
}
