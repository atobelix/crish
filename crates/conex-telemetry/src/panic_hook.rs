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

use std::io::Write;
use std::panic;
use std::path::PathBuf;
use std::sync::OnceLock;

use tracing::error;

use crate::file::timestamp_key;

/// 确保 hook 进程内只安装一次。
static INSTALLED: OnceLock<()> = OnceLock::new();

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
            eprintln!(
                "thread '{}' panicked at {}:\n{}",
                thread, location, payload
            );

            // 崩溃文件（T04.1-3）：panic 现场独立落盘。
            if let Some(dir) = &crash_dir {
                write_crash_file(dir, &payload, &location, &thread);
            }

            // 最后转发前 hook（可能含 abort 行为）。
            previous(info);
        }));
    });
}

/// 把 panic 现场写入 `crash-YYYYMMDD-HHMMSS-<thread>.log`（UTC 时间戳）。
///
/// 写失败静默忽略（含目录不可创建）——崩溃处理路径不允许二次 panic。
fn write_crash_file(dir: &std::path::Path, message: &str, location: &str, thread: &str) {
    if std::fs::create_dir_all(dir).is_err() {
        return;
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
        let _ = f.write_all(content.as_bytes());
        let _ = f.flush();
    }
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
}
