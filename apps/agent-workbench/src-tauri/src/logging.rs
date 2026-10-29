//! 启动日志与崩溃现场初始化。

use std::path::PathBuf;

/// 启动期日志初始化结果（路径供后续 setup / 迁移日志复用）。
pub(crate) struct LoggingInit {
    pub(crate) app_dir: PathBuf,
    pub(crate) log_dir: PathBuf,
    pub(crate) level: String,
}

/// 初始化 tracing、panic 崩溃现场与日志保留策略；返回真实落盘路径。
pub(crate) fn init() -> LoggingInit {
    let app_dir = crate::host_paths::app_dir().unwrap_or_default();
    let log_dir = app_dir.join("logs");
    let level = log_level_from_env();

    conex_telemetry::init_default(
        &level,
        Some(conex_telemetry::FileConfig {
            dir: log_dir.clone(),
            file_name_prefix: "workbench".to_string(),
        }),
    );
    // 崩溃文件（T04.1-3）：与日志同目录，panic 现场独立落盘。
    // T5-1b（崩溃台账）：崩溃文件写成功后，conex-telemetry 内部把
    // 「最后一次崩溃文件名 + 时刻」记入进程内共享标记（leaf crate 边界，
    // 不依赖 tauri，无需 manage State）——`core_get_status.lastCrash`
    // 经 `conex_telemetry::last_crash_marker()` 读出（core_query_commands.rs），
    // 前端心跳轮询一并读取，把「死文件」变成前端可读的崩溃台账。
    conex_telemetry::install_panic_hook_with_crash_dir(Some(log_dir.clone()));

    // RUN-06：日志保留策略生产接线（启动时执行一次）——crash 保留最近 N 个、
    // 按日轮转日志超龄删除、目录总量超限旧 → 新清理；清理数量与失败原因
    // 由 cleanup_logs 内部 tracing 记录（target=telemetry）。当日活跃日志
    // 文件不在清理面（按日龄/总量旧→新顺序），tracing 文件层句柄不受影响。
    let _ = conex_telemetry::cleanup_logs(&log_dir, &conex_telemetry::LogRetention::default());

    LoggingInit {
        app_dir,
        log_dir,
        level,
    }
}

/// 当前生效日志级别：`CRISH_LOG_LEVEL` 优先，dev debug / release info
/// （PE-04 T04.1-1：非法值由 conex-telemetry 内部回退 info）。
pub(crate) fn log_level_from_env() -> String {
    std::env::var("CRISH_LOG_LEVEL").unwrap_or_else(|_| {
        if cfg!(debug_assertions) {
            "debug".to_string()
        } else {
            "info".to_string()
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 日志级别策略：CRISH_LOG_LEVEL 优先；未设置时 dev=debug / release=info。
    #[test]
    fn log_level_prefers_env_with_profile_fallback() {
        let previous = std::env::var("CRISH_LOG_LEVEL").ok();
        std::env::remove_var("CRISH_LOG_LEVEL");
        let level = log_level_from_env();
        let expected = if cfg!(debug_assertions) {
            "debug"
        } else {
            "info"
        };
        assert_eq!(level, expected);

        std::env::set_var("CRISH_LOG_LEVEL", "warn");
        assert_eq!(log_level_from_env(), "warn");

        if let Some(value) = previous {
            std::env::set_var("CRISH_LOG_LEVEL", value);
        } else {
            std::env::remove_var("CRISH_LOG_LEVEL");
        }
    }
}
