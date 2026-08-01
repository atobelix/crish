//! Tracing subscriber 初始化（PE-04 T04.1-1 扩展：双通道）。
//!
//! [`init_default`] 安装全局 `tracing_subscriber`：
//!
//! - `EnvFilter` 级别过滤（非法级别回退 info）；
//! - **Layer A**：compact 格式 → stderr（开发可读，保持既有行为）；
//! - **Layer B**（可选，[`crate::FileConfig`]）：日志文件（按日单文件
//!   简单轮转，见 `crate::file`；tracing-appender 滚动/JSON 由 T04.6
//!   承接，不引入新依赖）。
//!
//! 初始化幂等：`OnceLock` 保证首次成功安装后不再重建；文件层不可用时
//! **降级为仅 stderr 并返回 `false`**（日志不可用不阻断应用启动，
//! PE-04 T04.1-1/R3）。

use std::fs;
use std::sync::OnceLock;

use tracing_subscriber::fmt::writer::MakeWriterExt;
use tracing_subscriber::EnvFilter;

use crate::file::{DailyFileWriter, FileConfig};

/// 全局 subscriber 是否已成功安装。
///
/// `OnceLock` 保证并发下初始化闭包只执行一次；存的 `bool` 记录该次
/// 尝试是否成功（他人抢先安装全局 subscriber 时可能失败）。
static INIT: OnceLock<bool> = OnceLock::new();

/// 当前生效级别（PE-04 T04.5-1：core_get_status.logLevel 数据源）。
///
/// `init_default` 首次成功安装时记录（与非法值回退逻辑同源）；
/// 未初始化（其他 crate 抢占 / 从未调用）时读取回退 `"info"`。
static CURRENT_LEVEL: OnceLock<String> = OnceLock::new();

/// 初始化默认 tracing subscriber（PE-04 T04.1-1 签名）。
///
/// `level` 为 `"trace"`/`"debug"`/`"info"`/`"warn"`/`"error"`（大小写
/// 不敏感，经 [`tracing::Level::parse`] 校验，非法值回退 `info`）。
/// `file: Some(FileConfig)` 时启用文件层（双通道：文件 + stderr）；
/// `file: None` 时行为与旧版一致（仅 stderr compact）。
///
/// 返回 `true` 表示调用后 subscriber 生效（本调用安装成功，或先前已
/// 安装）；返回 `false` 仅当：请求了文件层但不可用（降级仅 stderr，
/// 内部已 `eprintln!` 一行原因），或首次安装被其他 crate 抢占。
///
/// 幂等：多次调用安全，不会重建、不会重复写文件。
pub fn init_default(level: &str, file: Option<FileConfig>) -> bool {
    *INIT.get_or_init(|| build_and_install(level, file))
}

fn build_and_install(level: &str, file: Option<FileConfig>) -> bool {
    // 解析并校验级别字符串；非法值回退 INFO。
    let level_parsed = level
        .parse::<tracing::Level>()
        .unwrap_or(tracing::Level::INFO);
    // EnvFilter 接受指令字符串（裸小写级别 = 全局最大级别），
    // 把校验后的级别转回指令形式。
    let directive = level_parsed.as_str().to_lowercase();
    // 记录生效级别（供 core_get_status.logLevel 读取——与过滤指令同源，
    // 避免「报告值」与「实际过滤值」漂移）。
    let _ = CURRENT_LEVEL.set(directive.clone());
    let filter = EnvFilter::try_new(directive).unwrap_or_else(|_| EnvFilter::new("info"));

    // 文件层：先建目录，失败则降级为仅 stderr（返回 false 记录降级）。
    let file_writer = match &file {
        Some(cfg) => match fs::create_dir_all(&cfg.dir) {
            Ok(()) => Some(DailyFileWriter::new(
                cfg.dir.clone(),
                cfg.file_name_prefix.clone(),
            )),
            Err(e) => {
                eprintln!("[telemetry] file layer unavailable: {}", e);
                None
            }
        },
        None => None,
    };
    if file.is_some() && file_writer.is_none() {
        let _ = install_stderr_only(filter);
        return false;
    }

    match file_writer {
        // 双通道：文件层 + stderr（compact 单格式；T04.6 拆分为
        // 「stderr compact + 文件 JSON」双格式）。
        // 注：stderr 以函数项 `std::io::stderr` 传入（MakeWriter 为
        // `Fn() -> W` 实现，不是 `Stderr` 值本身）。
        Some(writer) => tracing_subscriber::fmt()
            .with_env_filter(filter)
            .compact()
            .with_writer(writer.and(std::io::stderr))
            .try_init()
            .is_ok(),
        None => install_stderr_only(filter),
    }
}

/// 仅 stderr 的兜底安装（旧版行为）。
fn install_stderr_only(filter: EnvFilter) -> bool {
    tracing_subscriber::fmt()
        .with_env_filter(filter)
        .compact()
        .with_writer(std::io::stderr)
        .try_init()
        .is_ok()
}

/// 读取当前生效日志级别（PE-04 T04.5-1：core_get_status.logLevel 数据源）。
///
/// 返回小写级别字符串（trace/debug/info/warn/error）；`init_default` 尚未
/// 执行（或首次安装被其他 subscriber 抢占）时回退 `"info"`——与
/// [init_default] 的非法值回退语义一致，保证状态报告永远有值。
pub fn current_level() -> String {
    CURRENT_LEVEL
        .get()
        .cloned()
        .unwrap_or_else(|| "info".to_string())
}
